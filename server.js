'use strict';
// 법정필수교육 LMS 서버 — 외부 의존성 없이 Node.js 22.13+ 내장 모듈(node:sqlite)만 사용
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// .env 파일(있으면)에서 설정을 읽는다. 이미 지정된 환경변수가 우선한다. 메일 비밀번호 등은 여기에만 둔다.
const ENV_FILE = process.env.LMS_ENV_FILE || path.join(__dirname, '.env');
// LMS_NO_DOTENV=1: 검증 스크립트용 — 실제 메일 계정으로 테스트 메일이 나가지 않도록 .env를 읽지 않는다
if (process.env.LMS_NO_DOTENV !== '1' && fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined && value !== '') process.env[m[1]] = value;
  }
}

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.LMS_DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const VIDEO_DIR = path.join(PUBLIC_DIR, 'videos');
const SESSION_TTL_MS = 12 * 3600 * 1000;
const MAX_BODY = 6 * 1024 * 1024;
// 진도 인정 규칙: 재생 중 하트비트 사이의 실제 경과 시간 × 1.2(네트워크 지연 여유)까지만 진도로 인정.
// 고정 여유분을 두지 않는다 — 하트비트를 짧은 간격으로 반복해 여유분을 쌓는 조작을 막기 위함.
// 재생 재개 직후 첫 하트비트는 기준점만 잡고 진도는 0으로 인정한다.
const BEAT_GAP_MAX_SEC = 30;
const BEAT_RATE_SLACK = 1.2;
const COMPLETE_TOLERANCE_SEC = 2;
// 이수 판정에는 위치뿐 아니라 실제 재생 시간 누적도 영상 길이의 95% 이상이어야 한다
const COMPLETE_WATCH_RATIO = 0.95;
// 다른 차시의 재생 하트비트가 이 시간 안에 있으면 동시 재생으로 보고 거부
const CONCURRENT_WINDOW_MS = 15e3;

// 메일 발송(SMTP) — 비밀번호는 DB에 저장하지 않고 .env에만 둔다. 관리자 설정 화면에서 입력하면 .env에 저장된다.
const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  fromName: process.env.SMTP_FROM_NAME || 'HR팀 법정교육',
};
SMTP.secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === '1' : SMTP.port === 465;
const smtpConfigured = () => !!(SMTP.host && SMTP.from && (!SMTP.user || SMTP.pass));
const publicUrl = () => (getSettings().public_url || process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// Google 드라이브 영상: API 키가 있으면 파일을 직접 받아 우리 플레이어로 재생(빨리감기 차단 유지).
// 키가 없거나 파일이 ‘링크가 있는 모든 사용자’ 공유가 아니면 드라이브 미리보기 창으로 재생하고, 실제 시청 시간으로 진도를 인정한다.
const DRIVE_API_KEY = process.env.DRIVE_API_KEY || '';
const driveFileId = (url) => {
  const m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([A-Za-z0-9_-]{20,})/.exec(String(url));
  return m ? m[1] : null;
};
const driveStreamUrl = (id) => (DRIVE_API_KEY ? `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}` : null);

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'lms.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  emp_no TEXT, department TEXT, position TEXT, email TEXT, phone TEXT,
  role TEXT NOT NULL DEFAULT 'learner',
  pw_hash TEXT NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT, legal_basis TEXT, description TEXT, source_note TEXT,
  edu_year INTEGER NOT NULL,
  start_date TEXT NOT NULL, due_date TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- 차시: 영상(video) 또는 자료(document). 교체·삭제 시 행을 지우지 않고 removed_at으로 남긴다(이력 보존)
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'video',
  url TEXT NOT NULL,
  duration_sec INTEGER NOT NULL,
  replaces_id INTEGER,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE TABLE IF NOT EXISTS lesson_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  max_pos REAL NOT NULL DEFAULT 0,
  watch_sec REAL NOT NULL DEFAULT 0,
  skip_attempts INTEGER NOT NULL DEFAULT 0,
  last_beat_at INTEGER,
  started_at INTEGER, completed_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (user_id, lesson_id)
);
-- 과정 이수 결과. late=1 은 마감일 이후 12/31 이전 이수(지연 이수)
CREATE TABLE IF NOT EXISTS course_results (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  completed_at INTEGER NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  total_sec INTEGER NOT NULL,
  lesson_ids TEXT NOT NULL,
  PRIMARY KEY (user_id, course_id)
);
CREATE TABLE IF NOT EXISTS course_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  by_user INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  edu_year INTEGER NOT NULL,
  title TEXT NOT NULL,
  holder_name TEXT, holder_dept TEXT, holder_position TEXT,
  company_name TEXT, ceo_name TEXT,
  period_text TEXT, total_sec INTEGER,
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL, message TEXT,
  created_at INTEGER NOT NULL, read_at INTEGER
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  mode TEXT NOT NULL,
  course_ids TEXT,
  target_count INTEGER NOT NULL,
  mail_count INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  auto_key TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER,
  user_id INTEGER,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_cert_user ON certificates(user_id);
CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id, removed_at);
`);

// ---------- 공통 유틸 ----------
const q = (sql) => db.prepare(sql);
const now = () => Date.now();
const kstDate = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
// LMS_FAKE_TODAY: 기간 경계(12/31 이후 등) 검증용. 운영에서는 설정하지 않는다.
const todayKst = () => process.env.LMS_FAKE_TODAY || kstDate(now());
const daysBetween = (fromYmd, toYmd) => Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / 86400e3);
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const nul = (v, max) => { const s = str(v, max); return s === '' ? null : s; };
const fmtMin = (sec) => { const m = Math.round(sec / 60); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`; };

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
function tempPassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (s) => s[crypto.randomInt(s.length)];
  let pw = '';
  for (let i = 0; i < 6; i++) pw += pick(letters);
  pw += pick(digits) + pick(digits) + pick(digits) + '!';
  return pw;
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return '비밀번호는 영문과 숫자를 모두 포함해야 합니다.';
  return null;
}

const DEFAULT_SETTINGS = {
  company_name: '',
  ceo_name: '',
  public_url: '',
  seal_image: '',
  edu_year: String(new Date().getFullYear()),
  cert_statement: '위 사람은 관계 법령에 따라 실시한 법정필수교육 과정을 성실히 이수하였으므로 이 증서를 수여합니다.',
  auto_remind: '1',
  remind_days: '10,5,3,1',
  overdue_weekly: '1',
  manager_contact: 'HR팀',
};
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of q('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  q('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
const eduYear = () => Number(getSettings().edu_year) || new Date().getFullYear();

// ---------- HTTP 헬퍼 ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}
function sendCsv(res, filename, rows) {
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  send(res, 200, csv, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, '요청이 너무 큽니다.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, '잘못된 JSON 형식입니다.')); }
    });
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionUser(req) {
  const token = parseCookies(req).lms_session;
  if (!token) return null;
  const row = q(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row || row.expires_at < now() || !row.active) return null;
  return { ...row, token };
}
const publicUser = (u) => u && ({
  id: u.id, login_id: u.login_id, name: u.name, emp_no: u.emp_no, department: u.department,
  position: u.position, email: u.email, phone: u.phone, role: u.role, must_change_pw: !!u.must_change_pw,
  active: !!u.active, last_login_at: u.last_login_at, created_at: u.created_at,
});

// ---------- 메일(SMTP) ----------
// 의존성 없는 최소 SMTP 클라이언트: 465(SSL) 또는 587(STARTTLS), AUTH LOGIN 지원
function smtpSend({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    let sock = SMTP.secure ? tls.connect({ host: SMTP.host, port: SMTP.port, servername: SMTP.host }) : net.connect({ host: SMTP.host, port: SMTP.port });
    let buf = ''; let waiter = null; let done = false;
    const timer = setTimeout(() => fail(new Error('SMTP 응답 시간 초과')), 30e3);
    const fail = (e) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); reject(e); };
    const onData = (d) => { buf += d.toString('utf8'); pump(); };
    const pump = () => {
      const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(buf);
      if (m && waiter) { const text = buf.slice(0, m.index + m[0].length); buf = buf.slice(m.index + m[0].length); const w = waiter; waiter = null; w({ code: Number(m[1]), text }); }
    };
    const read = () => new Promise((r) => { waiter = r; pump(); });
    const cmd = async (line, ok) => {
      if (line !== null) sock.write(line + '\r\n');
      const r = await read();
      if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code} ${r.text.trim().split('\r\n').pop()}`);
      return r;
    };
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const enc = (s) => `=?UTF-8?B?${b64(s)}?=`;
    sock.on('data', onData);
    sock.on('error', fail);
    (async () => {
      await cmd(null, [220]);
      const host = os.hostname() || 'localhost';
      let ehlo = await cmd(`EHLO ${host}`, [250]);
      if (!SMTP.secure && /STARTTLS/i.test(ehlo.text)) {
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: SMTP.host });
        sock.on('data', onData); sock.on('error', fail);
        await new Promise((r) => sock.once('secureConnect', r));
        ehlo = await cmd(`EHLO ${host}`, [250]);
      }
      if (SMTP.user) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(b64(SMTP.user), [334]);
        await cmd(b64(SMTP.pass), [235]);
      }
      await cmd(`MAIL FROM:<${SMTP.from}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      const body = b64(text).replace(/.{76}/g, '$&\r\n');
      const msg = [
        `From: ${enc(SMTP.fromName)} <${SMTP.from}>`, `To: <${to}>`, `Subject: ${enc(subject)}`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${SMTP.from.split('@')[1] || 'lms'}>`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body,
      ].join('\r\n');
      await cmd(`${msg}\r\n.`, [250]);
      sock.write('QUIT\r\n');
      done = true; clearTimeout(timer); sock.end(); resolve();
    })().catch(fail);
  });
}
// 메일은 요청 처리와 분리해 한 통씩 순서대로 보낸다. 결과는 mail_log에 남는다.
let mailBusy = false;
async function drainMail() {
  if (mailBusy) return;
  mailBusy = true;
  try {
    for (;;) {
      const m = q(`SELECT * FROM mail_log WHERE status = 'queued' ORDER BY id LIMIT 1`).get();
      if (!m) break;
      try { await smtpSend({ to: m.to_addr, subject: m.subject, text: m.body }); q(`UPDATE mail_log SET status = 'sent', sent_at = ? WHERE id = ?`).run(now(), m.id); }
      catch (e) { q(`UPDATE mail_log SET status = 'failed', error = ? WHERE id = ?`).run(String(e.message).slice(0, 300), m.id); }
    }
  } finally { mailBusy = false; }
}
function queueMail({ reminderId = null, userId = null, to, subject, body }) {
  const status = smtpConfigured() ? 'queued' : 'skipped';
  q(`INSERT INTO mail_log(reminder_id, user_id, to_addr, subject, body, status, error, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(reminderId, userId, to, subject, body, status, status === 'skipped' ? 'SMTP 미설정' : null, now());
  return status === 'queued';
}

// ---------- 도메인: 기간 / 차시 / 이수 ----------
function activeCourses(year = eduYear()) {
  return q('SELECT * FROM courses WHERE active = 1 AND edu_year = ? ORDER BY sort_order, id').all(year);
}
function activeLearners() {
  return q(`SELECT * FROM users WHERE role = 'learner' AND active = 1 ORDER BY department, name`).all();
}
const activeLessons = (courseId) => q('SELECT * FROM lessons WHERE course_id = ? AND removed_at IS NULL ORDER BY sort_order, id').all(courseId);
const courseTotalSec = (lessons) => lessons.reduce((a, l) => a + l.duration_sec, 0);
const yearEnd = (course) => `${course.edu_year}-12-31`;
// 교육 기간 단계: before(시작 전, 수강 불가) / open(정상) / late(마감 후 12/31까지, 지연 이수 인정) / closed(12/31 이후, 미이수 확정)
function coursePhase(course, today = todayKst()) {
  if (today < course.start_date) return 'before';
  if (today > yearEnd(course)) return 'closed';
  if (today > course.due_date) return 'late';
  return 'open';
}
const PHASE_BLOCK = {
  before: (c) => `교육 시작 전입니다. ${c.start_date}부터 수강할 수 있습니다.`,
  closed: (c) => `${c.edu_year}년 교육 기간이 종료되었습니다(12/31). 미이수로 처리되었습니다.`,
};

function nextCertNo(year) {
  const row = q(`SELECT cert_no FROM certificates WHERE edu_year = ? ORDER BY id DESC LIMIT 1`).get(year);
  const seq = row ? Number(row.cert_no.split('-').pop()) + 1 : 1;
  return `EDU-${year}-${String(seq).padStart(5, '0')}`;
}
function issueCertificate(user, kind, course, year) {
  const exists = kind === 'course'
    ? q(`SELECT id FROM certificates WHERE user_id = ? AND kind = 'course' AND course_id = ? AND revoked_at IS NULL`).get(user.id, course.id)
    : q(`SELECT id FROM certificates WHERE user_id = ? AND kind = 'final' AND edu_year = ? AND revoked_at IS NULL`).get(user.id, year);
  if (exists) return null;
  const s = getSettings();
  let title, period, total;
  if (kind === 'course') {
    const r = q('SELECT total_sec FROM course_results WHERE user_id = ? AND course_id = ?').get(user.id, course.id);
    title = course.title; period = `${course.start_date} ~ ${course.due_date}`; total = r ? r.total_sec : 0;
  } else {
    const rows = q(`SELECT c.start_date, c.due_date, r.total_sec FROM course_results r JOIN courses c ON c.id = r.course_id
                    WHERE r.user_id = ? AND c.edu_year = ? AND c.active = 1 AND c.required = 1`).all(user.id, year);
    title = `${year}년 법정필수교육 전 과정`;
    period = rows.length ? `${rows.map((x) => x.start_date).sort()[0]} ~ ${rows.map((x) => x.due_date).sort().pop()}` : '';
    total = rows.reduce((a, x) => a + x.total_sec, 0);
  }
  const certNo = nextCertNo(year);
  q(`INSERT INTO certificates(cert_no, user_id, course_id, kind, edu_year, title, holder_name, holder_dept, holder_position, company_name, ceo_name, period_text, total_sec, issued_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    certNo, user.id, course ? course.id : null, kind, year, title, user.name, user.department, user.position, s.company_name, s.ceo_name, period, total, now());
  q(`INSERT INTO notifications(user_id, kind, title, message, created_at) VALUES(?, 'success', ?, ?, ?)`).run(
    user.id, kind === 'final' ? '🎓 전 과정 수료를 축하합니다' : '수료증이 발급되었습니다',
    `${title} 수료증(${certNo})이 발급되었습니다. [내 수료증]에서 확인·출력할 수 있습니다.`, now());
  return certNo;
}
// "전 과정 수료"의 단일 기준: 해당 연도 운영 중인 필수 과정을 모두 이수(지연 이수 포함). 대시보드·교육생 화면·종합 수료증이 모두 이 함수를 따른다.
function allRequiredDone(userId, year) {
  const required = q(`SELECT COUNT(*) AS n FROM courses WHERE active = 1 AND required = 1 AND edu_year = ?`).get(year).n;
  if (!required) return false;
  const done = q(`SELECT COUNT(*) AS n FROM course_results r JOIN courses c ON c.id = r.course_id
                  WHERE r.user_id = ? AND c.active = 1 AND c.required = 1 AND c.edu_year = ?`).get(userId, year).n;
  return done >= required;
}
function checkFinalCertificate(user, year) {
  return allRequiredDone(user.id, year) ? issueCertificate(user, 'final', null, year) : null;
}
// 과정의 현재 차시를 모두 끝냈으면 과정 이수로 기록. 이수 당시의 차시 구성과 총 교육시간을 함께 남긴다.
function checkCourseCompletion(user, course) {
  if (q('SELECT 1 FROM course_results WHERE user_id = ? AND course_id = ?').get(user.id, course.id)) return false;
  const phase = coursePhase(course);
  if (phase === 'before' || phase === 'closed') return false;
  const lessons = activeLessons(course.id);
  if (!lessons.length) return false;
  const done = q(`SELECT lesson_id, completed_at FROM lesson_progress WHERE user_id = ? AND completed_at IS NOT NULL AND lesson_id IN (${lessons.map(() => '?').join(',')})`)
    .all(user.id, ...lessons.map((l) => l.id));
  if (done.length < lessons.length) return false;
  q(`INSERT INTO course_results(user_id, course_id, completed_at, late, total_sec, lesson_ids) VALUES(?, ?, ?, ?, ?, ?)`)
    .run(user.id, course.id, now(), phase === 'late' ? 1 : 0, courseTotalSec(lessons), JSON.stringify(lessons.map((l) => l.id)));
  issueCertificate(user, 'course', course, course.edu_year);
  checkFinalCertificate(user, course.edu_year);
  return true;
}
// 과정 구성 변경(차시 삭제, 필수 과정 중지 등) 후 이수 조건을 새로 만족하게 된 교육생을 다시 판정
function recheckCompletions() {
  const year = eduYear();
  tx(() => {
    const courses = activeCourses(year);
    for (const u of activeLearners()) {
      for (const c of courses) checkCourseCompletion(u, c);
      checkFinalCertificate(u, year);
    }
  });
}
function lessonContext(lessonId, user) {
  const l = q('SELECT * FROM lessons WHERE id = ? AND removed_at IS NULL').get(lessonId);
  if (!l) throw new HttpError(404, '차시를 찾을 수 없습니다. (교체·삭제되었을 수 있습니다)');
  const c = q('SELECT * FROM courses WHERE id = ? AND active = 1 AND edu_year = ?').get(l.course_id, eduYear());
  if (!c) throw new HttpError(404, '교육 과정을 찾을 수 없습니다.');
  const phase = coursePhase(c);
  const done = q('SELECT 1 FROM course_results WHERE user_id = ? AND course_id = ?').get(user.id, c.id);
  // 이수를 마친 과정은 기간과 관계없이 다시 보기 허용(진도 기록은 하지 않음)
  if (PHASE_BLOCK[phase] && !done) throw new HttpError(403, PHASE_BLOCK[phase](c));
  return { lesson: l, course: c, phase, courseDone: !!done };
}

// 하트비트 기반 진도 기록: 클라이언트가 보낸 재생 위치를 서버가 실제 경과시간으로 검증한다.
// 영상 길이는 관리자가 등록한 값만 사용한다(교육생 브라우저가 보내는 길이는 신뢰하지 않음).
function recordProgress(user, body) {
  const { lesson, course, courseDone } = lessonContext(Number(body.lesson_id), user);
  if (lesson.kind !== 'video') throw new HttpError(400, '영상 차시가 아닙니다.');
  const t = now();
  if (body.playing && !courseDone) {
    const other = q('SELECT lesson_id FROM lesson_progress WHERE user_id = ? AND lesson_id <> ? AND last_beat_at > ?').get(user.id, lesson.id, t - CONCURRENT_WINDOW_MS);
    if (other) throw new HttpError(409, '다른 교육 영상이 재생 중입니다. 한 번에 한 차시만 학습할 수 있습니다. (다른 창을 닫고 15초 후 다시 재생하세요)');
  }
  let p = q('SELECT * FROM lesson_progress WHERE user_id = ? AND lesson_id = ?').get(user.id, lesson.id);
  if (!p) {
    q('INSERT INTO lesson_progress(user_id, lesson_id, started_at, updated_at) VALUES(?, ?, ?, ?)').run(user.id, lesson.id, t, t);
    p = q('SELECT * FROM lesson_progress WHERE user_id = ? AND lesson_id = ?').get(user.id, lesson.id);
  }
  if (!p.completed_at) {
    const pos = Math.max(0, Math.min(Number(body.position) || 0, lesson.duration_sec));
    const elapsed = p.last_beat_at ? (t - p.last_beat_at) / 1000 : null;
    const continuous = elapsed !== null && elapsed <= BEAT_GAP_MAX_SEC;
    const allowed = continuous ? elapsed * BEAT_RATE_SLACK : 0;
    let maxPos = p.max_pos;
    let skip = 0;
    if (pos > maxPos) {
      const jump = pos - maxPos;
      if (jump > allowed + 3) skip = 1;
      maxPos += Math.min(jump, allowed);
    }
    const watched = continuous ? Math.min(elapsed, BEAT_GAP_MAX_SEC) : 0;
    const playing = !!body.playing;
    q(`UPDATE lesson_progress SET max_pos = ?, watch_sec = watch_sec + ?, skip_attempts = skip_attempts + ?, last_beat_at = ?, updated_at = ?
       WHERE user_id = ? AND lesson_id = ?`).run(maxPos, watched, skip, playing ? t : null, t, user.id, lesson.id);
    const watchSec = p.watch_sec + watched;
    if (maxPos >= lesson.duration_sec - COMPLETE_TOLERANCE_SEC && watchSec >= lesson.duration_sec * COMPLETE_WATCH_RATIO - 1) {
      q('UPDATE lesson_progress SET completed_at = ?, max_pos = ?, last_beat_at = NULL WHERE user_id = ? AND lesson_id = ?').run(t, lesson.duration_sec, user.id, lesson.id);
      checkCourseCompletion(user, course);
    }
  }
  return lessonState(user, lesson, course);
}
// 자료(강의안·사내 규정) 차시: 자료를 연 뒤 ‘확인 완료’로 이수. 인정 시간은 관리자가 정한 값.
function acknowledgeDocument(user, lessonId) {
  const { lesson, course } = lessonContext(lessonId, user);
  if (lesson.kind !== 'document') throw new HttpError(400, '자료 차시가 아닙니다.');
  const t = now();
  q(`INSERT INTO lesson_progress(user_id, lesson_id, max_pos, watch_sec, started_at, completed_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, lesson_id) DO UPDATE SET completed_at = COALESCE(completed_at, excluded.completed_at), max_pos = excluded.max_pos, updated_at = excluded.updated_at`)
    .run(user.id, lesson.id, lesson.duration_sec, lesson.duration_sec, t, t, t);
  checkCourseCompletion(user, course);
  return lessonState(user, lesson, course);
}
function lessonState(user, lesson, course) {
  const p = q('SELECT * FROM lesson_progress WHERE user_id = ? AND lesson_id = ?').get(user.id, lesson.id);
  const lessons = activeLessons(course.id);
  const idx = lessons.findIndex((x) => x.id === lesson.id);
  const result = q('SELECT completed_at, late FROM course_results WHERE user_id = ? AND course_id = ?').get(user.id, course.id);
  const cert = q(`SELECT cert_no FROM certificates WHERE user_id = ? AND course_id = ? AND kind = 'course' AND revoked_at IS NULL`).get(user.id, course.id);
  const driveId = driveFileId(lesson.url);
  return {
    id: lesson.id, title: lesson.title, kind: lesson.kind, url: lesson.url, duration_sec: lesson.duration_sec,
    drive_id: driveId, drive_stream: driveId ? driveStreamUrl(driveId) : null,
    index: idx + 1, count: lessons.length, next_id: lessons[idx + 1] ? lessons[idx + 1].id : null,
    max_pos: p ? p.max_pos : 0, completed_at: p ? p.completed_at : null,
    pct: p ? (p.completed_at ? 100 : Math.min(99, Math.floor((p.max_pos / lesson.duration_sec) * 100))) : 0,
    course: {
      id: course.id, title: course.title, category: course.category, legal_basis: course.legal_basis, description: course.description,
      source_note: course.source_note, start_date: course.start_date, due_date: course.due_date, phase: coursePhase(course),
      days_left: daysBetween(todayKst(), course.due_date), completed_at: result ? result.completed_at : null, late: result ? !!result.late : false,
      cert_no: cert ? cert.cert_no : null,
    },
  };
}
// 교육생 1명 × 과정 1개의 상태
function courseStatus(course, result, pct) {
  if (result) return result.late ? 'completed_late' : 'completed';
  const phase = coursePhase(course);
  if (phase === 'before') return 'upcoming';
  if (phase === 'closed') return 'failed';
  if (phase === 'late') return 'overdue';
  return pct > 0 ? 'in_progress' : 'not_started';
}
function progressIndex() {
  const lp = new Map(q('SELECT * FROM lesson_progress').all().map((p) => [`${p.user_id}:${p.lesson_id}`, p]));
  const results = new Map(q('SELECT * FROM course_results').all().map((r) => [`${r.user_id}:${r.course_id}`, r]));
  const lessonsBy = new Map();
  for (const l of q('SELECT * FROM lessons WHERE removed_at IS NULL ORDER BY sort_order, id').all()) {
    if (!lessonsBy.has(l.course_id)) lessonsBy.set(l.course_id, []);
    lessonsBy.get(l.course_id).push(l);
  }
  return { lp, results, lessonsBy };
}
function userCourseCell(idx, userId, course) {
  const lessons = idx.lessonsBy.get(course.id) || [];
  const total = courseTotalSec(lessons);
  let credited = 0, watch = 0, skips = 0;
  const lessonCells = lessons.map((l) => {
    const p = idx.lp.get(`${userId}:${l.id}`);
    const pos = p ? (p.completed_at ? l.duration_sec : Math.min(p.max_pos, l.duration_sec)) : 0;
    credited += pos; watch += p ? p.watch_sec : 0; skips += p ? p.skip_attempts : 0;
    return { lesson_id: l.id, completed_at: p ? p.completed_at : null, pct: l.duration_sec ? Math.floor((pos / l.duration_sec) * 100) : 0 };
  });
  const r = idx.results.get(`${userId}:${course.id}`);
  const pct = r ? 100 : total ? Math.min(99, Math.floor((credited / total) * 100)) : 0;
  return {
    course_id: course.id, pct, status: courseStatus(course, r, pct), completed_at: r ? r.completed_at : null, late: r ? !!r.late : false,
    watch_sec: Math.round(watch), skip_attempts: skips, lessons: lessonCells,
  };
}

function myCourses(user) {
  const idx = progressIndex();
  return activeCourses().map((c) => {
    const lessons = idx.lessonsBy.get(c.id) || [];
    const cell = userCourseCell(idx, user.id, c);
    const cert = q(`SELECT cert_no FROM certificates WHERE user_id = ? AND course_id = ? AND kind = 'course' AND revoked_at IS NULL`).get(user.id, c.id);
    return {
      id: c.id, title: c.title, category: c.category, legal_basis: c.legal_basis, description: c.description, source_note: c.source_note,
      start_date: c.start_date, due_date: c.due_date, required: !!c.required, phase: coursePhase(c), days_left: daysBetween(todayKst(), c.due_date),
      total_sec: courseTotalSec(lessons), ...cell, cert_no: cert ? cert.cert_no : null,
      lessons: lessons.map((l, i) => ({ id: l.id, title: l.title, kind: l.kind, duration_sec: l.duration_sec, ...cell.lessons[i] })),
    };
  });
}

function incompleteMap(courseIds) {
  // 독촉 대상: 수강 가능한 기간(정상·마감 후 12/31까지)인 과정의 미이수자
  const courses = activeCourses().filter((c) => (!courseIds || !courseIds.length || courseIds.includes(c.id)) && ['open', 'late'].includes(coursePhase(c)));
  const done = new Set(q(`SELECT user_id || ':' || course_id AS k FROM course_results`).all().map((r) => r.k));
  const map = new Map();
  for (const u of activeLearners()) {
    const missing = courses.filter((c) => !done.has(`${u.id}:${c.id}`));
    if (missing.length) map.set(u.id, { user: u, courses: missing });
  }
  return map;
}
function reminderText(user, courses, message, s) {
  const today = todayKst();
  const list = courses.map((c) => {
    const left = daysBetween(today, c.due_date);
    const when = left > 0 ? `마감 ${c.due_date} (D-${left})` : left === 0 ? `오늘 마감 (${c.due_date})` : `마감 ${-left}일 경과 · ${yearEnd(c)}까지 미이수 시 미이수 확정`;
    return `· ${c.title} — ${when}`;
  }).join('\n');
  return `${message ? message + '\n\n' : ''}${user.name}님, 아래 법정필수교육을 아직 이수하지 않으셨습니다.\n${list}\n\n▶ 교육 바로가기: ${publicUrl()}/\n문의: ${s.manager_contact}`;
}
function sendReminders({ courseIds, message, mode, createdBy, autoKey, withMail = true }) {
  const targets = incompleteMap(courseIds);
  if (!targets.size) return { target_count: 0, mail_count: 0, emails: [], smtp: smtpConfigured() };
  const s = getSettings();
  const out = tx(() => {
    const r = q(`INSERT ${autoKey ? 'OR IGNORE' : ''} INTO reminders(created_at, created_by, mode, course_ids, target_count, message, auto_key) VALUES(?, ?, ?, ?, ?, ?, ?)`)
      .run(now(), createdBy || null, mode, JSON.stringify(courseIds || []), targets.size, message || null, autoKey || null);
    if (!r.changes) return null;
    const reminderId = Number(r.lastInsertRowid);
    const ins = q(`INSERT INTO notifications(user_id, kind, title, message, created_at) VALUES(?, 'warning', ?, ?, ?)`);
    let mails = 0;
    for (const { user, courses } of targets.values()) {
      const overdue = courses.some((c) => coursePhase(c) === 'late');
      const title = `${overdue ? '[독촉] ' : ''}미이수 법정교육 ${courses.length}건 안내`;
      const body = reminderText(user, courses, message, s);
      ins.run(user.id, title, body, now());
      if (withMail && user.email) { queueMail({ reminderId, userId: user.id, to: user.email, subject: `[법정필수교육] ${title}`, body }); mails++; }
    }
    q('UPDATE reminders SET mail_count = ? WHERE id = ?').run(mails, reminderId);
    return { target_count: targets.size, mail_count: mails, emails: [...targets.values()].map((t) => t.user.email).filter(Boolean), smtp: smtpConfigured() };
  });
  drainMail();
  return out || { target_count: 0, mail_count: 0, emails: [], skipped: true, smtp: smtpConfigured() };
}
// 자동 독촉: 마감 D-n일(기본 10·5·3·1·당일) + 마감 후 12/31까지 매주(D+1, D+8, …). 같은 날 같은 과정은 한 번만 발송.
function runAutoReminders() {
  const s = getSettings();
  if (s.auto_remind !== '1') return [];
  const days = s.remind_days.split(',').map((d) => Number(d.trim())).filter((d) => Number.isFinite(d));
  const today = todayKst();
  const sent = [];
  for (const c of activeCourses()) {
    const phase = coursePhase(c);
    const left = daysBetween(today, c.due_date);
    let msg = null;
    if (phase === 'open' && (days.includes(left) || left === 0)) {
      msg = left === 0 ? `[자동 안내] 「${c.title}」 이수 마감일은 오늘입니다.` : `[자동 안내] 「${c.title}」 이수 마감까지 ${left}일 남았습니다.`;
    } else if (phase === 'late' && s.overdue_weekly === '1' && (-left) % 7 === 1) {
      msg = `[독촉] 「${c.title}」 이수 마감일(${c.due_date})이 ${-left}일 지났습니다. ${yearEnd(c)}까지 이수하지 않으면 미이수로 확정됩니다.`;
    }
    if (!msg) continue;
    const r = sendReminders({ courseIds: [c.id], message: msg, mode: 'auto', autoKey: `auto:${c.id}:${c.due_date}:${today}` });
    if (r.target_count) sent.push({ course: c.title, ...r });
  }
  return sent;
}

// ---------- 라우트 ----------
const routes = [];
const route = (method, pattern, auth, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), auth, handler });
const logChange = (courseId, userId, action, detail) =>
  q('INSERT INTO course_changes(course_id, at, by_user, action, detail) VALUES(?, ?, ?, ?, ?)').run(courseId, now(), userId || null, action, detail || null);

route('POST', '/api/login', null, async ({ req, body, res }) => {
  const loginId = str(body.login_id, 64);
  const u = q('SELECT * FROM users WHERE login_id = ?').get(loginId);
  const fail = () => { throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.'); };
  if (!u || !u.active) fail();
  if (u.locked_until && u.locked_until > now()) throw new HttpError(423, '로그인 5회 실패로 10분간 잠겼습니다. 잠시 후 다시 시도하거나 HR팀에 문의하세요.');
  if (!verifyPassword(String(body.password || ''), u.pw_hash)) {
    const n = u.failed_logins + 1;
    q('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(n >= 5 ? 0 : n, n >= 5 ? now() + 10 * 60e3 : null, u.id);
    fail();
  }
  startSession(req, res, u);
  return { user: publicUser(u) };
});
function startSession(req, res, u) {
  const token = crypto.randomBytes(32).toString('hex');
  q('DELETE FROM sessions WHERE expires_at < ?').run(now());
  q('INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, ?)').run(token, u.id, now() + SESSION_TTL_MS);
  q('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now(), u.id);
  // HTTPS 프록시(터널) 뒤에서는 쿠키가 암호화 연결로만 전송되게 한다
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `lms_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
}

// 최초 설정: 관리자 계정이 없을 때 한 번만, 서버가 돌아가는 PC에서만 열 수 있다 (다른 사람이 먼저 관리자가 되는 것을 막음)
const setupNeeded = () => !q(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
const isLocalRequest = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'];
route('GET', '/api/setup', null, ({ req }) => ({ needed: setupNeeded(), local: isLocalRequest(req), company_name: getSettings().company_name }));
route('POST', '/api/setup', null, ({ req, body, res }) => {
  if (!setupNeeded()) throw new HttpError(409, '이미 설정을 마쳤습니다. 로그인 화면에서 관리자 계정으로 로그인하세요.');
  if (!isLocalRequest(req)) throw new HttpError(403, '최초 설정은 서버가 실행 중인 PC에서만 할 수 있습니다.');
  const company = str(body.company_name, 100), ceo = str(body.ceo_name, 50);
  if (!company || !ceo) throw new HttpError(400, '회사명과 대표이사 성명을 입력하세요. 수료증에 들어갑니다.');
  const problem = passwordProblem(body.password);
  if (problem) throw new HttpError(400, problem);
  const r = q(`INSERT INTO users(login_id, name, department, position, role, pw_hash, must_change_pw, created_at) VALUES('admin', 'HR 관리자', 'HR팀', '관리자 계정', 'admin', ?, 0, ?)`).run(hashPassword(body.password), now());
  setSetting('company_name', company);
  setSetting('ceo_name', ceo);
  setSetting('manager_contact', str(body.manager_contact, 200) || 'HR팀');
  if (body.sample) { loadSample(); setSetting('auto_remind', '0'); } // 샘플 주소로 독촉 메일이 나가지 않게 한다
  const u = q('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
  startSession(req, res, u);
  return { user: publicUser(u) };
});
route('POST', '/api/logout', 'any', ({ user, res }) => {
  q('DELETE FROM sessions WHERE token = ?').run(user.token);
  res.setHeader('Set-Cookie', 'lms_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
});
route('GET', '/api/me', 'any', ({ user }) => ({ user: publicUser(user), company_name: getSettings().company_name }));
route('POST', '/api/me/password', 'any', ({ user, body }) => {
  if (!verifyPassword(String(body.current_password || ''), user.pw_hash)) throw new HttpError(400, '현재 비밀번호가 올바르지 않습니다.');
  const problem = passwordProblem(body.new_password);
  if (problem) throw new HttpError(400, problem);
  if (body.new_password === body.current_password) throw new HttpError(400, '기존과 다른 비밀번호를 입력하세요.');
  q('UPDATE users SET pw_hash = ?, must_change_pw = 0 WHERE id = ?').run(hashPassword(body.new_password), user.id);
  q('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(user.id, user.token);
  return { ok: true };
});

// 교육생 (HR 관리자 계정은 수강 불가 — HR 담당자도 별도 교육생 계정으로 수강)
route('GET', '/api/my/courses', 'learner', ({ user }) => {
  const finalCert = q(`SELECT cert_no FROM certificates WHERE user_id = ? AND kind = 'final' AND edu_year = ? AND revoked_at IS NULL`).get(user.id, eduYear());
  return { edu_year: eduYear(), today: todayKst(), courses: myCourses(user), final_cert_no: finalCert ? finalCert.cert_no : null };
});
route('GET', '/api/my/lessons/(\\d+)', 'learner', ({ user, params }) => {
  const { lesson, course } = lessonContext(Number(params[0]), user);
  return lessonState(user, lesson, course);
});
route('POST', '/api/my/progress', 'learner', ({ user, body }) => recordProgress(user, body));
route('POST', '/api/my/lessons/(\\d+)/ack', 'learner', ({ user, params }) => acknowledgeDocument(user, Number(params[0])));
route('GET', '/api/my/notifications', 'learner', ({ user }) => ({
  items: q('SELECT id, kind, title, message, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(user.id),
}));
route('POST', '/api/my/notifications/read', 'learner', ({ user }) => {
  q('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), user.id);
  return { ok: true };
});
route('GET', '/api/my/certificates', 'learner', ({ user }) => ({
  items: q(`SELECT cert_no, kind, title, edu_year, issued_at FROM certificates WHERE user_id = ? AND revoked_at IS NULL ORDER BY kind DESC, id DESC`).all(user.id),
}));
route('GET', '/api/certificates/([A-Z0-9-]+)', 'any', ({ user, params }) => {
  const c = q('SELECT * FROM certificates WHERE cert_no = ?').get(params[0]);
  if (!c || (user.role !== 'admin' && (c.user_id !== user.id || c.revoked_at))) throw new HttpError(404, '수료증을 찾을 수 없습니다.');
  const s = getSettings();
  const courses = q(`SELECT c.title, c.legal_basis, c.start_date, c.due_date, r.total_sec, r.completed_at, r.late FROM course_results r JOIN courses c ON c.id = r.course_id
       WHERE r.user_id = ? AND ${c.kind === 'final' ? 'c.edu_year = ? AND c.required = 1 AND c.active = 1' : 'c.id = ?'} ORDER BY c.sort_order, c.id`)
    .all(c.user_id, c.kind === 'final' ? c.edu_year : c.course_id);
  return { cert: c, courses, seal_image: s.seal_image, cert_statement: s.cert_statement };
});

// 관리자 — 교육생 명부
function userFields(body) {
  const f = {
    name: str(body.name, 50), emp_no: nul(body.emp_no, 30), department: nul(body.department, 60),
    position: nul(body.position, 40), email: nul(body.email, 120), phone: nul(body.phone, 30),
  };
  if (!f.name) throw new HttpError(400, '이름은 필수입니다.');
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw new HttpError(400, `이메일 형식이 올바르지 않습니다: ${f.email}`);
  return f;
}
// 교육생 계정 규칙: 아이디 = 이메일 @ 앞부분, 초기 비밀번호 = 휴대폰 번호 뒤 4자리(최초 로그인 시 본인이 변경)
function learnerLoginId(f) {
  if (!f.email) throw new HttpError(400, `${f.name}: 이메일이 필요합니다. (아이디 = 이메일 @ 앞부분)`);
  const id = f.email.split('@')[0];
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(id)) throw new HttpError(400, `${f.name}: 이메일 앞부분(${id})을 아이디로 쓸 수 없습니다. 영문·숫자·._- 만 가능합니다.`);
  return id;
}
function phonePassword(f) {
  const digits = String(f.phone || '').replace(/\D/g, '');
  if (digits.length < 4) throw new HttpError(400, `${f.name}: 휴대폰 번호가 필요합니다. (초기 비밀번호 = 휴대폰 뒤 4자리)`);
  return digits.slice(-4);
}
function createUser(body) {
  const f = userFields(body);
  const isAdmin = body.role === 'admin';
  const loginId = isAdmin ? str(body.login_id, 64) : learnerLoginId(f);
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(loginId)) throw new HttpError(400, `${f.name}: 아이디는 영문/숫자/._- 2자 이상입니다.`);
  if (q('SELECT id FROM users WHERE login_id = ?').get(loginId)) throw new HttpError(409, `이미 존재하는 아이디입니다: ${loginId}`);
  const pw = isAdmin ? str(body.password, 64) || tempPassword() : phonePassword(f);
  const r = q(`INSERT INTO users(login_id, name, emp_no, department, position, email, phone, role, pw_hash, must_change_pw, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
    loginId, f.name, f.emp_no, f.department, f.position, f.email, f.phone, isAdmin ? 'admin' : 'learner', hashPassword(pw), now());
  return { id: Number(r.lastInsertRowid), login_id: loginId, name: f.name, department: f.department, email: f.email, temp_password: pw };
}
// 연도별 명부 교체: 새 명부 기준으로 신규 등록 / 정보 갱신 / 재입사자 재활성 / 명부에 없는 교육생 비활성화.
// 비활성화는 삭제가 아니다 — 지난 이수 기록과 수료증은 그대로 남는다.
function syncRoster(rows, apply) {
  const plan = { add: [], update: [], reactivate: [], deactivate: [], unchanged: 0, errors: [] };
  const seen = new Set();
  const parsed = [];
  rows.forEach((row, i) => {
    try {
      const f = userFields(row);
      const loginId = learnerLoginId(f);
      phonePassword(f);
      if (seen.has(loginId.toLowerCase())) throw new HttpError(400, `명부 안에서 아이디가 중복됩니다: ${loginId}`);
      seen.add(loginId.toLowerCase());
      parsed.push({ f, loginId });
    } catch (e) { plan.errors.push({ row: i + 1, name: row.name || '', error: e.message }); }
  });
  const fields = ['name', 'emp_no', 'department', 'position', 'email', 'phone'];
  for (const { f, loginId } of parsed) {
    const u = q('SELECT * FROM users WHERE login_id = ?').get(loginId);
    if (!u) { plan.add.push({ login_id: loginId, name: f.name, department: f.department }); continue; }
    if (u.role === 'admin') { plan.errors.push({ name: f.name, error: `${loginId}는 HR 관리자 계정 아이디와 같습니다. 관리자 계정 아이디를 바꿔 주세요.` }); continue; }
    const changed = fields.filter((k) => String(u[k] ?? '') !== String(f[k] ?? ''));
    if (!u.active) plan.reactivate.push({ login_id: loginId, name: f.name, department: f.department });
    else if (changed.length) plan.update.push({ login_id: loginId, name: f.name, department: f.department, changed: changed.map((k) => `${k}: ${u[k] ?? '-'} → ${f[k] ?? '-'}`) });
    else plan.unchanged++;
  }
  for (const u of q(`SELECT * FROM users WHERE role = 'learner' AND active = 1`).all()) {
    if (!seen.has(u.login_id.toLowerCase())) plan.deactivate.push({ login_id: u.login_id, name: u.name, department: u.department });
  }
  if (!apply) return plan;
  if (plan.errors.length) throw new HttpError(400, `오류 ${plan.errors.length}건을 고친 뒤 다시 적용하세요.`);
  return tx(() => {
    const created = [];
    for (const { f, loginId } of parsed) {
      const u = q('SELECT * FROM users WHERE login_id = ?').get(loginId);
      if (!u) { created.push(createUser({ ...f, role: 'learner' })); continue; }
      q(`UPDATE users SET name = ?, emp_no = ?, department = ?, position = ?, email = ?, phone = ?, active = 1 WHERE id = ?`)
        .run(f.name, f.emp_no, f.department, f.position, f.email, f.phone, u.id);
    }
    for (const d of plan.deactivate) {
      const u = q('SELECT id FROM users WHERE login_id = ?').get(d.login_id);
      q('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    return { ...plan, created };
  });
}
route('GET', '/api/admin/users', 'admin', () => {
  const courses = activeCourses();
  const doneByUser = new Map(q(`SELECT r.user_id, COUNT(*) AS n FROM course_results r JOIN courses c ON c.id = r.course_id
    WHERE c.active = 1 AND c.edu_year = ? GROUP BY r.user_id`).all(eduYear()).map((r) => [r.user_id, r.n]));
  return {
    course_count: courses.length,
    items: q('SELECT * FROM users ORDER BY role, department, name').all().map((u) => ({ ...publicUser(u), completed: doneByUser.get(u.id) || 0 })),
  };
});
route('POST', '/api/admin/users', 'admin', ({ body }) => createUser(body));
route('POST', '/api/admin/users/import', 'admin', ({ body }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new HttpError(400, '등록할 행이 없습니다.');
  const created = []; const errors = [];
  rows.forEach((row, i) => {
    try { created.push(createUser({ ...row, role: 'learner' })); } catch (e) { errors.push({ row: i + 1, name: row.name || '', error: e.message }); }
  });
  return { created, errors };
});
route('POST', '/api/admin/users/sync', 'admin', ({ body }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new HttpError(400, '명부가 비어 있습니다.');
  return syncRoster(rows, !!body.apply);
});
route('PUT', '/api/admin/users/(\\d+)', 'admin', ({ body, params, user }) => {
  const id = Number(params[0]);
  const target = q('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
  const f = userFields(body);
  const active = body.active === undefined ? target.active : (body.active ? 1 : 0);
  if (id === user.id && !active) throw new HttpError(400, '본인 계정은 비활성화할 수 없습니다.');
  // 교육생은 이메일이 바뀌면 아이디도 이메일 앞부분으로 함께 바뀐다
  const loginId = target.role === 'learner' ? learnerLoginId(f) : target.login_id;
  if (loginId !== target.login_id && q('SELECT id FROM users WHERE login_id = ? AND id <> ?').get(loginId, id)) throw new HttpError(409, `이미 존재하는 아이디입니다: ${loginId}`);
  q(`UPDATE users SET login_id = ?, name = ?, emp_no = ?, department = ?, position = ?, email = ?, phone = ?, active = ? WHERE id = ?`)
    .run(loginId, f.name, f.emp_no, f.department, f.position, f.email, f.phone, active, id);
  if (!active) q('DELETE FROM sessions WHERE user_id = ?').run(id);
  return { ok: true };
});
route('DELETE', '/api/admin/users/(\\d+)', 'admin', ({ params, user }) => {
  const id = Number(params[0]);
  if (id === user.id) throw new HttpError(400, '본인 계정은 삭제할 수 없습니다.');
  q('DELETE FROM users WHERE id = ?').run(id);
  return { ok: true };
});
route('POST', '/api/admin/users/(\\d+)/reset-password', 'admin', ({ params }) => {
  const u = q('SELECT * FROM users WHERE id = ?').get(Number(params[0]));
  if (!u) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
  const pw = u.role === 'learner' ? phonePassword(u) : tempPassword();
  q('UPDATE users SET pw_hash = ?, must_change_pw = 1, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashPassword(pw), u.id);
  q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  return { login_id: u.login_id, name: u.name, temp_password: pw };
});

// 관리자 — 교육 과정 / 차시 / 변경 이력
function courseFields(body) {
  const f = {
    title: str(body.title, 120), category: nul(body.category, 60), legal_basis: nul(body.legal_basis, 200),
    description: nul(body.description, 3000), source_note: nul(body.source_note, 300),
    edu_year: Number(body.edu_year) || eduYear(), start_date: str(body.start_date, 10), due_date: str(body.due_date, 10),
    required: body.required === false || body.required === 0 ? 0 : 1, active: body.active === false || body.active === 0 ? 0 : 1,
    sort_order: Number(body.sort_order) || 0,
  };
  if (!f.title) throw new HttpError(400, '과정명은 필수입니다.');
  for (const d of [f.start_date, f.due_date]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, '시작일과 마감일을 모두 입력하세요 (YYYY-MM-DD).');
  if (f.due_date < f.start_date) throw new HttpError(400, '마감일은 시작일 이후여야 합니다.');
  if (f.due_date > `${f.edu_year}-12-31` || f.start_date < `${f.edu_year}-01-01`) throw new HttpError(400, `교육 기간은 ${f.edu_year}년 안이어야 합니다.`);
  return f;
}
function lessonFields(body) {
  const f = {
    title: str(body.title, 120), kind: body.kind === 'document' ? 'document' : 'video', url: str(body.url, 500),
    duration_sec: Math.round(Number(body.duration_sec) || 0), sort_order: Number(body.sort_order) || 0,
  };
  if (!f.title) throw new HttpError(400, '차시 제목은 필수입니다.');
  if (!/^(https?:\/\/|\/)/.test(f.url)) throw new HttpError(400, '링크는 http(s):// 또는 / 로 시작해야 합니다.');
  if (f.duration_sec <= 0) throw new HttpError(400, f.kind === 'video' ? '영상 길이(초)를 입력하세요. [자동 측정]으로 읽어올 수 있습니다.' : '자료 차시의 인정 교육시간(분)을 입력하세요.');
  return f;
}
const COURSE_DIFF_KEYS = { title: '과정명', start_date: '시작일', due_date: '마감일', required: '필수', active: '운영', legal_basis: '관련 법령', source_note: '출처' };
route('GET', '/api/admin/courses', 'admin', () => {
  const learners = activeLearners();
  const ids = new Set(learners.map((u) => u.id));
  const results = q('SELECT * FROM course_results').all().filter((r) => ids.has(r.user_id));
  const watchBy = new Map(q(`SELECT l.course_id, SUM(p.watch_sec) AS w FROM lesson_progress p JOIN lessons l ON l.id = p.lesson_id GROUP BY l.course_id`).all().map((r) => [r.course_id, r.w]));
  return {
    learners: learners.length,
    items: q('SELECT * FROM courses ORDER BY edu_year DESC, sort_order, id').all().map((c) => {
      const lessons = activeLessons(c.id);
      const rs = results.filter((r) => r.course_id === c.id);
      return { ...c, phase: coursePhase(c), lessons, total_sec: courseTotalSec(lessons), completed: rs.length, late: rs.filter((r) => r.late).length, total_watch_sec: Math.round(watchBy.get(c.id) || 0) };
    }),
  };
});
route('POST', '/api/admin/courses', 'admin', ({ body, user }) => {
  const f = courseFields(body);
  const r = q(`INSERT INTO courses(title, category, legal_basis, description, source_note, edu_year, start_date, due_date, required, active, sort_order, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    f.title, f.category, f.legal_basis, f.description, f.source_note, f.edu_year, f.start_date, f.due_date, f.required, f.active, f.sort_order, now());
  const id = Number(r.lastInsertRowid);
  logChange(id, user.id, '과정 등록', `${f.title} · ${f.start_date} ~ ${f.due_date}`);
  recheckCompletions();
  return { id };
});
route('PUT', '/api/admin/courses/(\\d+)', 'admin', ({ body, params, user }) => {
  const id = Number(params[0]);
  const before = q('SELECT * FROM courses WHERE id = ?').get(id);
  if (!before) throw new HttpError(404, '과정을 찾을 수 없습니다.');
  const f = courseFields(body);
  q(`UPDATE courses SET title = ?, category = ?, legal_basis = ?, description = ?, source_note = ?, edu_year = ?, start_date = ?, due_date = ?,
     required = ?, active = ?, sort_order = ? WHERE id = ?`).run(
    f.title, f.category, f.legal_basis, f.description, f.source_note, f.edu_year, f.start_date, f.due_date, f.required, f.active, f.sort_order, id);
  const diff = Object.entries(COURSE_DIFF_KEYS).filter(([k]) => String(before[k] ?? '') !== String(f[k] ?? '')).map(([k, label]) => `${label}: ${before[k] ?? '-'} → ${f[k] ?? '-'}`);
  if (diff.length) logChange(id, user.id, '과정 수정', diff.join(' / '));
  recheckCompletions();
  return { ok: true };
});
route('DELETE', '/api/admin/courses/(\\d+)', 'admin', ({ params, user }) => {
  const c = q('SELECT * FROM courses WHERE id = ?').get(Number(params[0]));
  if (!c) throw new HttpError(404, '과정을 찾을 수 없습니다.');
  logChange(c.id, user.id, '과정 삭제', c.title);
  q('DELETE FROM courses WHERE id = ?').run(c.id);
  recheckCompletions();
  return { ok: true };
});
route('POST', '/api/admin/courses/(\\d+)/lessons', 'admin', ({ body, params, user }) => {
  const c = q('SELECT * FROM courses WHERE id = ?').get(Number(params[0]));
  if (!c) throw new HttpError(404, '과정을 찾을 수 없습니다.');
  const f = lessonFields(body);
  const order = f.sort_order || (q('SELECT MAX(sort_order) AS m FROM lessons WHERE course_id = ? AND removed_at IS NULL').get(c.id).m || 0) + 1;
  const r = q(`INSERT INTO lessons(course_id, sort_order, title, kind, url, duration_sec, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run(c.id, order, f.title, f.kind, f.url, f.duration_sec, now());
  logChange(c.id, user.id, '차시 추가', `${order}차시 「${f.title}」 ${f.kind === 'video' ? '영상' : '자료'} ${fmtMin(f.duration_sec)} · ${f.url}`);
  return { id: Number(r.lastInsertRowid) };
});
// 차시 수정: 링크가 바뀌면 ‘교체’로 보고 새 차시로 만든다(기존 차시 시청 기록은 이력으로 남고, 미이수자는 새 영상을 봐야 함)
route('PUT', '/api/admin/lessons/(\\d+)', 'admin', ({ body, params, user }) => {
  const old = q('SELECT * FROM lessons WHERE id = ? AND removed_at IS NULL').get(Number(params[0]));
  if (!old) throw new HttpError(404, '차시를 찾을 수 없습니다.');
  const f = lessonFields({ ...body, kind: body.kind || old.kind });
  if (f.url !== old.url || f.kind !== old.kind) {
    return tx(() => {
      q('UPDATE lessons SET removed_at = ? WHERE id = ?').run(now(), old.id);
      const r = q(`INSERT INTO lessons(course_id, sort_order, title, kind, url, duration_sec, replaces_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(old.course_id, f.sort_order || old.sort_order, f.title, f.kind, f.url, f.duration_sec, old.id, now());
      logChange(old.course_id, user.id, '차시 교체', `「${old.title}」 ${old.url} (${fmtMin(old.duration_sec)}) → 「${f.title}」 ${f.url} (${fmtMin(f.duration_sec)})`);
      return { id: Number(r.lastInsertRowid), replaced: true };
    });
  }
  q('UPDATE lessons SET title = ?, duration_sec = ?, sort_order = ? WHERE id = ?').run(f.title, f.duration_sec, f.sort_order || old.sort_order, old.id);
  const diff = [];
  if (old.title !== f.title) diff.push(`제목: ${old.title} → ${f.title}`);
  if (old.duration_sec !== f.duration_sec) diff.push(`시간: ${fmtMin(old.duration_sec)} → ${fmtMin(f.duration_sec)}`);
  if (f.sort_order && old.sort_order !== f.sort_order) diff.push(`순서: ${old.sort_order} → ${f.sort_order}`);
  if (diff.length) logChange(old.course_id, user.id, '차시 수정', diff.join(' / '));
  return { id: old.id, replaced: false };
});
route('DELETE', '/api/admin/lessons/(\\d+)', 'admin', ({ params, user }) => {
  const l = q('SELECT * FROM lessons WHERE id = ? AND removed_at IS NULL').get(Number(params[0]));
  if (!l) throw new HttpError(404, '차시를 찾을 수 없습니다.');
  q('UPDATE lessons SET removed_at = ? WHERE id = ?').run(now(), l.id);
  logChange(l.course_id, user.id, '차시 삭제', `「${l.title}」 ${l.url}`);
  recheckCompletions();
  return { ok: true };
});
route('GET', '/api/admin/courses/(\\d+)/changes', 'admin', ({ params }) => ({
  items: q(`SELECT ch.*, u.name AS by_name FROM course_changes ch LEFT JOIN users u ON u.id = ch.by_user WHERE ch.course_id = ? ORDER BY ch.id DESC`).all(Number(params[0])),
}));
route('GET', '/api/admin/drive-stream', 'admin', ({ query }) => {
  const id = driveFileId(query.get('url'));
  return { drive_id: id, stream_url: id ? driveStreamUrl(id) : null };
});
route('GET', '/api/admin/videos', 'admin', () => {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  return { items: fs.readdirSync(VIDEO_DIR).filter((f) => /\.(mp4|webm)$/i.test(f)).map((f) => ({ name: f, url: `/videos/${f}`, size: fs.statSync(path.join(VIDEO_DIR, f)).size })) };
});
route('POST', '/api/admin/progress/reset', 'admin', ({ body }) => {
  const userId = Number(body.user_id), courseId = Number(body.course_id);
  const c = q('SELECT * FROM courses WHERE id = ?').get(courseId);
  if (!c) throw new HttpError(404, '과정을 찾을 수 없습니다.');
  tx(() => {
    q('DELETE FROM lesson_progress WHERE user_id = ? AND lesson_id IN (SELECT id FROM lessons WHERE course_id = ?)').run(userId, courseId);
    q('DELETE FROM course_results WHERE user_id = ? AND course_id = ?').run(userId, courseId);
    q(`UPDATE certificates SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND (course_id = ? OR (kind = 'final' AND edu_year = ?))`).run(now(), userId, courseId, c.edu_year);
  });
  return { ok: true };
});

// 관리자 — 대시보드 / 수료율
function completionMatrix() {
  const courses = activeCourses();
  const learners = activeLearners();
  const idx = progressIndex();
  const rows = learners.map((u) => {
    const cells = courses.map((c) => userCourseCell(idx, u.id, c));
    const done = cells.filter((x) => x.completed_at).length;
    const reqCells = cells.filter((_, i) => courses[i].required);
    const reqDone = reqCells.filter((x) => x.completed_at).length;
    return {
      user: publicUser(u), cells, done, pct: courses.length ? Math.round((done / courses.length) * 100) : 0,
      req_done: reqDone, req_total: reqCells.length, all_required_done: reqCells.length > 0 && reqDone === reqCells.length,
    };
  });
  return {
    today: todayKst(),
    courses: courses.map((c) => { const ls = idx.lessonsBy.get(c.id) || []; return { ...c, phase: coursePhase(c), total_sec: courseTotalSec(ls), lessons: ls }; }),
    rows,
  };
}
route('GET', '/api/admin/dashboard', 'admin', () => {
  const { courses, rows, today } = completionMatrix();
  const totalPairs = rows.length * courses.length;
  const donePairs = rows.reduce((a, r) => a + r.done, 0);
  const depts = new Map();
  for (const r of rows) {
    const d = r.user.department || '(미지정)';
    if (!depts.has(d)) depts.set(d, { department: d, learners: 0, done_pairs: 0, all_done: 0 });
    const x = depts.get(d); x.learners++; x.done_pairs += r.done; if (r.all_required_done) x.all_done++;
  }
  const daily = new Map();
  for (let i = 13; i >= 0; i--) daily.set(kstDate(now() - i * 86400e3), 0);
  const since = new Date(`${kstDate(now() - 13 * 86400e3)}T00:00:00+09:00`).getTime();
  for (const p of q('SELECT completed_at FROM course_results WHERE completed_at >= ?').all(since)) {
    const k = kstDate(p.completed_at); if (daily.has(k)) daily.set(k, daily.get(k) + 1);
  }
  const statusCount = (s) => rows.reduce((a, r) => a + r.cells.filter((c) => c.status === s).length, 0);
  return {
    edu_year: eduYear(), today,
    kpi: {
      learners: rows.length, courses: courses.length, rate: totalPairs ? Math.round((donePairs / totalPairs) * 1000) / 10 : 0,
      all_done: rows.filter((r) => r.all_required_done).length,
      not_started: rows.filter((r) => r.cells.every((c) => c.pct === 0)).length,
      incomplete: rows.filter((r) => !r.all_required_done).length,
      overdue: statusCount('overdue'), late_done: statusCount('completed_late'), failed: statusCount('failed'),
      skip_flags: rows.reduce((a, r) => a + r.cells.reduce((b, c) => b + c.skip_attempts, 0), 0),
      certificates: q('SELECT COUNT(*) AS n FROM certificates WHERE revoked_at IS NULL AND edu_year = ?').get(eduYear()).n,
    },
    courses: courses.map((c, i) => {
      const cells = rows.map((r) => r.cells[i]);
      const done = cells.filter((x) => x.completed_at).length;
      const inprog = cells.filter((x) => !x.completed_at && x.pct > 0).length;
      return {
        id: c.id, title: c.title, start_date: c.start_date, due_date: c.due_date, phase: c.phase, total_sec: c.total_sec, lesson_count: c.lessons.length,
        days_left: daysBetween(today, c.due_date), done, late_done: cells.filter((x) => x.late).length, in_progress: inprog,
        not_started: rows.length - done - inprog, rate: rows.length ? Math.round((done / rows.length) * 100) : 0,
      };
    }),
    departments: [...depts.values()].map((d) => ({ ...d, rate: d.learners && courses.length ? Math.round((d.done_pairs / (d.learners * courses.length)) * 100) : 0 })).sort((a, b) => a.rate - b.rate),
    daily: [...daily.entries()].map(([date, n]) => ({ date, n })),
    laggards: rows.filter((r) => !r.all_required_done).sort((a, b) => a.pct - b.pct).slice(0, 8).map((r) => ({ user: r.user, done: r.done, pct: r.pct })),
  };
});
route('GET', '/api/admin/completion', 'admin', () => completionMatrix());
const STATUS_LABEL = { completed: '이수', completed_late: '지연 이수', in_progress: '학습 중', not_started: '미시작', overdue: '마감 경과', failed: '미이수(확정)', upcoming: '시작 전' };
route('GET', '/api/admin/export/completion', 'admin', ({ res }) => {
  const { courses, rows } = completionMatrix();
  const fmt = (ms) => (ms ? new Date(ms + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) : '');
  const out = [['사번', '아이디', '이름', '부서', '직급', '이메일',
    ...courses.flatMap((c) => [`${c.title} 상태`, `${c.title} 진도(%)`, `${c.title} 이수일시`, `${c.title} 실제 학습시간(분)`]),
    '이수 과정 수', '필수 전 과정 수료']];
  for (const r of rows) {
    out.push([r.user.emp_no, r.user.login_id, r.user.name, r.user.department, r.user.position, r.user.email,
      ...r.cells.flatMap((c) => [STATUS_LABEL[c.status], c.pct, fmt(c.completed_at), Math.round(c.watch_sec / 60)]), `${r.done}/${courses.length}`, r.all_required_done ? 'Y' : 'N']);
  }
  out.push([]);
  out.push(['과정', '교육기간', '차시 수', '총 교육시간(분)']);
  for (const c of courses) out.push([c.title, `${c.start_date} ~ ${c.due_date}`, c.lessons.length, Math.round(c.total_sec / 60)]);
  sendCsv(res, `법정필수교육_이수현황_${todayKst()}.csv`, out);
  return undefined;
});

// 관리자 — 알림/독촉/메일
route('GET', '/api/admin/reminders', 'admin', () => {
  const targets = [...incompleteMap(null).values()].map((t) => ({ user: publicUser(t.user), courses: t.courses.map((c) => ({ id: c.id, title: c.title, phase: coursePhase(c) })) }));
  const s = getSettings();
  return {
    targets,
    history: q(`SELECT r.*, u.name AS created_by_name,
                  (SELECT COUNT(*) FROM mail_log m WHERE m.reminder_id = r.id AND m.status = 'sent') AS mail_sent,
                  (SELECT COUNT(*) FROM mail_log m WHERE m.reminder_id = r.id AND m.status = 'failed') AS mail_failed
                FROM reminders r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.id DESC LIMIT 50`).all(),
    settings: { auto_remind: s.auto_remind, remind_days: s.remind_days, overdue_weekly: s.overdue_weekly },
    smtp: { configured: smtpConfigured(), host: SMTP.host, from: SMTP.from },
  };
});
route('POST', '/api/admin/reminders', 'admin', ({ body, user }) => {
  const courseIds = Array.isArray(body.course_ids) ? body.course_ids.map(Number).filter(Boolean) : [];
  return sendReminders({ courseIds, message: str(body.message, 1000), mode: 'manual', createdBy: user.id, withMail: body.with_mail !== false });
});
route('POST', '/api/admin/reminders/run-auto', 'admin', () => ({ sent: runAutoReminders() }));
route('GET', '/api/admin/mail', 'admin', () => ({
  smtp: { configured: smtpConfigured(), host: SMTP.host, port: SMTP.port, from: SMTP.from },
  items: q(`SELECT m.id, m.to_addr, m.subject, m.status, m.error, m.created_at, m.sent_at, u.name FROM mail_log m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.id DESC LIMIT 200`).all(),
}));
route('POST', '/api/admin/mail/test', 'admin', async ({ body }) => {
  const to = str(body.to, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, '받는 주소를 확인하세요.');
  if (!smtpConfigured()) throw new HttpError(400, '메일 설정이 아직 없습니다. 설정 화면에서 메일 계정을 먼저 입력하세요.');
  try { await smtpSend({ to, subject: '[법정필수교육] 메일 발송 테스트', text: `법정필수교육 LMS의 메일 발송 테스트입니다.\n${publicUrl()}/` }); }
  catch (e) { throw new HttpError(502, `발송 실패: ${e.message}`); }
  return { ok: true };
});
route('POST', '/api/admin/mail/retry', 'admin', () => {
  const r = q(`UPDATE mail_log SET status = 'queued', error = NULL WHERE status IN ('failed', 'skipped')`).run();
  if (smtpConfigured()) drainMail(); else q(`UPDATE mail_log SET status = 'skipped', error = 'SMTP 미설정' WHERE status = 'queued'`).run();
  return { requeued: r.changes };
});

// 관리자 — 수료증
route('GET', '/api/admin/certificates', 'admin', () => ({
  items: q(`SELECT c.*, u.login_id, u.emp_no FROM certificates c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.id DESC`).all(),
}));
route('POST', '/api/admin/certificates/(\\d+)/(revoke|restore)', 'admin', ({ params }) => {
  const id = Number(params[0]);
  const c = q('SELECT * FROM certificates WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, '수료증을 찾을 수 없습니다.');
  if (params[1] === 'revoke') q('UPDATE certificates SET revoked_at = ? WHERE id = ?').run(now(), id);
  else {
    const dup = q(`SELECT id FROM certificates WHERE id <> ? AND user_id = ? AND kind = ? AND revoked_at IS NULL AND (course_id IS ? AND edu_year = ?)`)
      .get(id, c.user_id, c.kind, c.course_id, c.edu_year);
    if (dup) throw new HttpError(409, '동일 과정의 유효한 수료증이 이미 있습니다.');
    const stillDone = c.kind === 'final'
      ? allRequiredDone(c.user_id, c.edu_year)
      : !!q('SELECT 1 FROM course_results WHERE user_id = ? AND course_id = ?').get(c.user_id, c.course_id);
    if (!stillDone) throw new HttpError(409, '현재 이수 기록이 없어 복구할 수 없습니다. (진도가 초기화되었거나 필수 과정이 추가되었습니다)');
    q('UPDATE certificates SET revoked_at = NULL WHERE id = ?').run(id);
  }
  return { ok: true };
});
route('POST', '/api/admin/certificates/(\\d+)/reissue', 'admin', ({ params }) => {
  const c = q('SELECT * FROM certificates WHERE id = ?').get(Number(params[0]));
  if (!c) throw new HttpError(404, '수료증을 찾을 수 없습니다.');
  const u = q('SELECT * FROM users WHERE id = ?').get(c.user_id);
  const course = c.course_id ? q('SELECT * FROM courses WHERE id = ?').get(c.course_id) : null;
  if (c.kind === 'course' && !course) throw new HttpError(400, '삭제된 과정의 수료증은 재발급할 수 없습니다.');
  return tx(() => {
    q('UPDATE certificates SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), c.id);
    return { cert_no: issueCertificate(u, c.kind, course, c.edu_year) };
  });
});

// 관리자 — 시작하기 체크리스트
const SAMPLE_PREFIX = '[샘플]';
const lanUrls = () => Object.values(os.networkInterfaces()).flat().filter((n) => n.family === 'IPv4' && !n.internal).map((n) => `http://${n.address}:${PORT}`);
route('GET', '/api/admin/start', 'admin', () => {
  const s = getSettings();
  const learners = q(`SELECT email FROM users WHERE role = 'learner' AND active = 1`).all();
  const real = learners.filter((u) => !/@example\.com$/i.test(u.email || '')).length;
  return {
    company: !!(s.company_name && s.ceo_name), company_name: s.company_name, ceo_name: s.ceo_name,
    courses: q(`SELECT COUNT(DISTINCT c.id) AS n FROM courses c JOIN lessons l ON l.course_id = c.id AND l.removed_at IS NULL WHERE c.active = 1 AND c.title NOT LIKE ?`).get(`${SAMPLE_PREFIX}%`).n,
    learners: real, sample_learners: learners.length - real, sample_loaded: s.sample_loaded === '1',
    smtp: smtpConfigured(), smtp_from: SMTP.from, public_url: s.public_url, lan_urls: lanUrls(), manager_contact: s.manager_contact,
  };
});
route('POST', '/api/admin/sample/clear', 'admin', () => {
  const users = q(`DELETE FROM users WHERE role = 'learner' AND email LIKE '%@example.com'`).run().changes;
  const courses = q('DELETE FROM courses WHERE title LIKE ?').run(`${SAMPLE_PREFIX}%`).changes;
  setSetting('sample_loaded', '0');
  setSetting('auto_remind', '1');
  recheckCompletions();
  return { users: Number(users), courses: Number(courses) };
});

// 관리자 — 메일 설정: 입력값을 .env에 저장하고 바로 적용한다. 비밀번호는 화면으로 돌려주지 않는다.
function writeEnv(values) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${k}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}
route('GET', '/api/admin/mail/config', 'admin', () => ({ configured: smtpConfigured(), host: SMTP.host, port: SMTP.port, user: SMTP.user, from: SMTP.from, from_name: SMTP.fromName, has_password: !!SMTP.pass }));
route('PUT', '/api/admin/mail/config', 'admin', ({ body }) => {
  const clean = (v, max) => str(v, max).replace(/[\r\n]/g, '');
  const host = clean(body.host, 200), user = clean(body.user, 200), from = clean(body.from, 200) || user;
  const port = Number(body.port) || 587;
  const pass = String(body.pass || '').replace(/[\s]/g, '') || SMTP.pass;
  if (!host) throw new HttpError(400, '메일 서버 주소를 입력하세요.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) throw new HttpError(400, '보내는 메일 주소 형식이 올바르지 않습니다.');
  if (user && !pass) throw new HttpError(400, '메일 비밀번호를 입력하세요.');
  const fromName = clean(body.from_name, 100) || SMTP.fromName;
  writeEnv({ SMTP_HOST: host, SMTP_PORT: port, SMTP_USER: user, SMTP_PASS: pass, SMTP_FROM: from, SMTP_FROM_NAME: fromName });
  Object.assign(SMTP, { host, port, user, pass, from, fromName, secure: port === 465 });
  return { configured: smtpConfigured() };
});

// 관리자 — 영상·PDF 올리기: 용량이 커서 메모리에 담지 않고 바로 파일로 저장한다
const UPLOAD_DIRS = { '.mp4': 'videos', '.webm': 'videos', '.pdf': 'docs' };
function handleUpload(req, res, url) {
  const user = sessionUser(req);
  if (!user) return send(res, 401, { error: '로그인이 필요합니다.' });
  if (user.role !== 'admin' || user.must_change_pw) return send(res, 403, { error: '권한이 없습니다.' });
  if (!String(req.headers['content-type'] || '').includes('application/octet-stream')) return send(res, 415, { error: '파일만 올릴 수 있습니다.' });
  const name = path.basename(String(url.searchParams.get('name') || '')).replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^\.+/, '');
  const sub = UPLOAD_DIRS[path.extname(name).toLowerCase()];
  if (!sub) return send(res, 400, { error: 'MP4, WEBM, PDF 파일만 올릴 수 있습니다.' });
  const dir = path.join(PUBLIC_DIR, sub);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  if (fs.existsSync(target)) return send(res, 409, { error: '같은 이름의 파일이 이미 있습니다. 파일 이름을 바꿔서 올려 주세요.' });
  const tmp = `${target}.part`;
  const out = fs.createWriteStream(tmp);
  const discard = () => { out.destroy(); fs.rm(tmp, { force: true }, () => {}); };
  req.on('close', () => { if (!req.complete) discard(); });
  out.on('error', () => { discard(); if (!res.headersSent) send(res, 500, { error: '파일을 저장하지 못했습니다. 디스크 공간을 확인하세요.' }); });
  out.on('finish', () => fs.rename(tmp, target, (err) => (err ? send(res, 500, { error: '파일을 저장하지 못했습니다.' }) : send(res, 200, { url: `/${sub}/${name}`, name, size: out.bytesWritten }))));
  req.pipe(out);
}

// 관리자 — 설정
route('GET', '/api/admin/settings', 'admin', () => getSettings());
route('PUT', '/api/admin/settings', 'admin', ({ body }) => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (body[key] === undefined) continue;
    const v = String(body[key]);
    if (key === 'seal_image' && v && !/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(v)) throw new HttpError(400, '직인 이미지는 PNG/JPG/SVG 파일이어야 합니다.');
    if (key === 'remind_days' && !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(v)) throw new HttpError(400, '자동 독촉 일정은 10,5,3,1 처럼 숫자를 쉼표로 구분합니다.');
    if (key === 'public_url' && v && !/^https?:\/\/\S+$/.test(v)) throw new HttpError(400, '직원 접속 주소는 http:// 또는 https:// 로 시작해야 합니다.');
    setSetting(key, key === 'seal_image' ? v : v.slice(0, 1000));
  }
  if (body.edu_year !== undefined) recheckCompletions();
  return getSettings();
});

// ---------- 정적 파일 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt; charset=utf-8', '.pdf': 'application/pdf' };
const PAGES = { '/': 'index.html', '/setup': 'setup.html', '/learn': 'learner.html', '/player': 'player.html', '/admin': 'admin.html', '/certificate': 'certificate.html' };
// 교육 영상(제3자 제공·공개 링크 금지)과 사내 규정 문서는 로그인한 사용자에게만 내보낸다
const PROTECTED_DIRS = ['videos', 'docs'].map((d) => path.join(fs.realpathSync.native(PUBLIC_DIR), d, path.sep).toLowerCase());
function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || rel.includes(':')) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    // 대소문자·끝 점 등 Windows 경로 변형으로 우회하지 못하도록 실제 경로로 판단한다
    let real;
    try { real = fs.realpathSync.native(file).toLowerCase(); } catch { return send(res, 404, 'Not found'); }
    if (PROTECTED_DIRS.some((d) => real.startsWith(d)) && !sessionUser(req)) return send(res, 401, '로그인이 필요합니다.');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // 영상 파일은 Range 요청을 지원해야 브라우저에서 재생·이어보기가 된다
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range && type.startsWith('video/')) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end) return send(res, 416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${st.size}` });
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...(type.startsWith('video/') ? { 'Accept-Ranges': 'bytes' } : {}) });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, pathname);
    }
    if (req.method === 'POST' && pathname === '/api/admin/upload') return handleUpload(req, res, url);
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) throw new HttpError(404, 'API를 찾을 수 없습니다.');
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'JSON 요청만 허용됩니다.');
    let user = null;
    if (r.auth) {
      user = sessionUser(req);
      if (!user) throw new HttpError(401, '로그인이 필요합니다.');
      if (r.auth !== 'any' && user.role !== r.auth) {
        throw new HttpError(403, r.auth === 'learner' ? 'HR 관리자 계정은 교육을 수강할 수 없습니다. 본인 교육은 교육생 계정으로 로그인하세요.' : '권한이 없습니다.');
      }
      if (user.must_change_pw && !['/api/me', '/api/me/password', '/api/logout'].includes(pathname)) throw new HttpError(403, '최초 로그인 시 비밀번호를 변경해야 합니다.');
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const result = await r.handler({ req, res, body, user, params: r.re.exec(pathname).slice(1), query: url.searchParams });
    if (result !== undefined) send(res, 200, result);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : e.message });
  }
});

// ---------- 초기 데이터 ----------
// 처음 실행하면 아무 데이터도 넣지 않고, 관리자 계정은 설정 마법사(/setup)에서 만든다.
// ADMIN_PASSWORD 환경변수가 있으면 마법사 없이 관리자를 만든다 (서버에 설치하는 경우).
function seed() {
  if (q('SELECT COUNT(*) AS n FROM users').get().n) return;
  setSetting('edu_year', Number(todayKst().slice(0, 4)));
  if (process.env.ADMIN_PASSWORD) {
    q(`INSERT INTO users(login_id, name, department, position, role, pw_hash, must_change_pw, created_at) VALUES('admin', 'HR 관리자', 'HR팀', '관리자 계정', 'admin', ?, 1, ?)`)
      .run(hashPassword(process.env.ADMIN_PASSWORD), now());
  }
  if (process.env.SEED_DEMO === '1') loadSample();
}
// 둘러보기용 샘플: 가상의 교육생과 고용노동부 공개 영상 1개. 설정 화면에서 한 번에 지울 수 있다.
function loadSample() {
  const t = now(), today = todayKst(), year = Number(today.slice(0, 4));
  const due = kstDate(Date.parse(today) + 30 * 86400e3);
  const r = q(`INSERT INTO courses(title, category, legal_basis, description, source_note, edu_year, start_date, due_date, required, active, sort_order, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?)`).run(
    `${SAMPLE_PREFIX} 직장 내 성희롱 예방교육`, '성희롱 예방', '남녀고용평등과 일·가정 양립 지원에 관한 법률 제13조',
    '둘러보기용 샘플 과정입니다. 실제 운영 전에 샘플을 지우고 회사 과정을 등록하세요.',
    "출처: 고용노동부 「'26년 직장 내 성희롱 예방교육」 영상(YouTube)", year, today, due > `${year}-12-31` ? `${year}-12-31` : due, t);
  const courseId = Number(r.lastInsertRowid);
  q(`INSERT INTO lessons(course_id, sort_order, title, kind, url, duration_sec, created_at) VALUES(?, 1, ?, 'video', ?, ?, ?)`)
    .run(courseId, '직장 내 성희롱 예방교육 (법령·개념·대응 절차)', 'https://youtu.be/E63ktj9KSqo', 2253, t);
  logChange(courseId, null, '과정 등록', '둘러보기용 샘플');

  // 아이디 = 이메일 앞부분, 초기 비밀번호 = 휴대폰 뒤 4자리 (example.com 주소·가상 번호)
  const people = [
    [null, '김대표', '경영진', '대표이사', 'ceo', '010-5555-0001'],
    ['20210101', '김민준', '경영지원팀', '팀장', 'minjun.kim', '010-5555-0101'], ['20210102', '이서연', '인사팀', '매니저', 'seoyeon.lee', '010-5555-0102'],
    ['20220201', '박도윤', '개발팀', '책임', 'doyun.park', '010-5555-0201'], ['20220202', '최지우', '개발팀', '선임', 'jiwoo.choi', '010-5555-0202'],
    ['20220203', '정하준', '개발팀', '사원', 'hajun.jung', '010-5555-0203'], ['20230301', '강서윤', '마케팅팀', '과장', 'seoyun.kang', '010-5555-0301'],
    ['20230302', '조은우', '마케팅팀', '사원', 'eunwoo.cho', '010-5555-0302'], ['20230401', '윤지호', '영업팀', '차장', 'jiho.yoon', '010-5555-0401'],
    ['20240501', '장수아', '영업팀', '대리', 'sua.jang', '010-5555-0501'], ['20240502', '임시우', '영업팀', '사원', 'siwoo.lim', '010-5555-0502'],
  ];
  for (const [empNo, name, dept, pos, mail, phone] of people) createUser({ name, emp_no: empNo, department: dept, position: pos, email: `${mail}@example.com`, phone });
  setSetting('sample_loaded', '1');
}
seed();
runAutoReminders();
setInterval(() => { try { runAutoReminders(); } catch (e) { console.error(e); } }, 3600e3).unref();

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`\n${PORT}번 포트를 이미 쓰고 있습니다. LMS가 이미 켜져 있을 수 있으니 브라우저에서 http://localhost:${PORT} 을 열어 보세요.\n`);
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`\n법정필수교육 LMS 실행 중 → http://localhost:${PORT}`);
  if (setupNeeded()) console.log('  처음 실행입니다. 브라우저에서 위 주소를 열면 설정 화면이 나옵니다.');
  for (const u of lanUrls()) console.log(`  같은 네트워크의 다른 PC: ${u}`);
  console.log(`  메일 발송: ${smtpConfigured() ? `${SMTP.host}:${SMTP.port} (${SMTP.from})` : '미설정 — 관리자 화면 > 설정에서 입력하세요'}`);
  console.log('  이 창을 닫으면 LMS도 꺼집니다.\n');
});
