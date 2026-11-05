// 운영 시나리오 검증 — 실행 결과로 판정한다. 실행 방법: npm test (test/run.js가 임시 폴더로 서버를 띄운다)
// 1단계: node test/scenarios.js            (서버: 빈 DB, SMTP_HOST=127.0.0.1 SMTP_PORT=2525)
// 2단계: node test/scenarios.js --year-end (서버: 같은 DB, LMS_FAKE_TODAY=다음 해 1월 2일)
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.LMS_TEST_BASE || 'http://localhost:3199';
const PHASE2 = process.argv.includes('--year-end');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ymd = (d) => new Date(Date.now() + 9 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, j };
  };
}
function check(id, title, expected, actual, pass) {
  results.push({ id, title, expected, actual, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id} ${title}\n      기대: ${expected}\n      실제: ${actual}`);
}
// 시드 명부: 키(사번 또는 ceo) → [아이디(이메일 앞부분), 초기 비밀번호(휴대폰 뒤 4자리)]
const SEED = {
  ceo: ['ceo', '0001'], 20210101: ['minjun.kim', '0101'], 20210102: ['seoyeon.lee', '0102'], 20220201: ['doyun.park', '0201'],
  20220202: ['jiwoo.choi', '0202'], 20220203: ['hajun.jung', '0203'], 20230301: ['seoyun.kang', '0301'], 20230302: ['eunwoo.cho', '0302'],
  20230401: ['jiho.yoon', '0401'], 20240501: ['sua.jang', '0501'], 20240502: ['siwoo.lim', '0502'],
};
const seedLogin = (key, newPw) => login(SEED[key][0], newPw && !PHASE2 ? SEED[key][1] : 'Learner123', newPw && !PHASE2 ? newPw : undefined);
async function login(id, pw, newPw) {
  const c = client();
  const r = await c('POST', '/api/login', { login_id: id, password: pw });
  if (r.status !== 200) throw new Error(`login ${id}: ${r.status} ${JSON.stringify(r.j)}`);
  if (newPw) await c('POST', '/api/me/password', { current_password: pw, new_password: newPw });
  return c;
}
// 정상 시청: 실제 시간 흐름에 맞춰 1초 간격으로 위치를 보낸다
async function watch(c, lessonId, dur) {
  let s = (await c('POST', '/api/my/progress', { lesson_id: lessonId, position: 0, playing: true })).j;
  for (let pos = 1; pos <= dur + 1 && !s.completed_at; pos++) {
    await sleep(1000);
    s = (await c('POST', '/api/my/progress', { lesson_id: lessonId, position: Math.min(pos, dur), playing: pos <= dur })).j;
  }
  return s;
}
// 테스트용 가짜 메일 서버: LMS가 보낸 메일을 받아 기록한다
function fakeSmtp(port) {
  const inbox = [];
  const srv = net.createServer((sock) => {
    let data = false, buf = '', msg = { rcpt: [] };
    sock.write('220 fake-smtp ready\r\n');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (data) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        msg.raw = buf.slice(0, end); buf = buf.slice(end + 5); data = false;
        const subj = /^Subject: =\?UTF-8\?B\?([^?]+)\?=/m.exec(msg.raw);
        msg.subject = subj ? Buffer.from(subj[1], 'base64').toString('utf8') : '';
        const body = msg.raw.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, '');
        msg.body = Buffer.from(body, 'base64').toString('utf8');
        inbox.push(msg); msg = { rcpt: [] };
        sock.write('250 queued\r\n');
      }
      let i;
      while (!data && (i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 OK\r\n');
        else if (/^MAIL FROM/i.test(line)) { msg.from = line; sock.write('250 OK\r\n'); }
        else if (/^RCPT TO:<(.+)>/i.test(line)) { msg.rcpt.push(/<(.+)>/.exec(line)[1]); sock.write('250 OK\r\n'); }
        else if (/^DATA/i.test(line)) { data = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise((r) => srv.listen(port, () => r({ srv, inbox })));
}

async function phase1() {
  const smtp = await fakeSmtp(2525);
  const admin = await login('admin', 'admin1234!', 'Admin5678!');
  // 실제 교육 과정(수십 분 영상)은 테스트 동안 운영 중지하고, 4초짜리 테스트 과정으로 검증
  for (const c of (await admin('GET', '/api/admin/courses')).j.items) await admin('PUT', `/api/admin/courses/${c.id}`, { ...c, active: false });
  const mk = async (title, start, due, lessons, extra = {}) => {
    const id = (await admin('POST', '/api/admin/courses', { title, start_date: start, due_date: due, ...extra })).j.id;
    for (const [i, l] of lessons.entries()) await admin('POST', `/api/admin/courses/${id}/lessons`, { title: l.title || `${i + 1}차시`, kind: l.kind || 'video', url: l.url || `/videos/test-${id}-${i}.mp4`, duration_sec: l.dur || 4 });
    const c = (await admin('GET', '/api/admin/courses')).j.items.find((x) => x.id === id);
    return { ...c, L: c.lessons.map((l) => l.id) };
  };
  const A = await mk('테스트A 2차시', ymd(0), ymd(10), [{}, {}]);                             // 마감 D-10
  const B = await mk('테스트B 영상+자료', ymd(0), ymd(30), [{}, { kind: 'document', url: '/docs/_test.html', dur: 600 }]);
  const Late = await mk('테스트C 마감 지남', ymd(-10), ymd(-1), [{}]);                       // 지연 이수 기간
  const Soon = await mk('테스트D 시작 전', ymd(1), ymd(20), [{}]);                           // 시작 전
  const Opt = await mk('테스트E 선택', ymd(0), ymd(30), [{}], { required: false });

  const L = {};
  for (const id of ['ceo', '20210101', '20210102', '20220201', '20220202', '20220203', '20230301', '20230302', '20230401']) L[id] = await seedLogin(id, 'Learner123');

  // ---------- 진도 인정 ----------
  {
    const c = L['20210101'];
    await c('POST', '/api/my/progress', { lesson_id: A.L[0], position: 0, playing: true });
    await sleep(1000);
    const s = (await c('POST', '/api/my/progress', { lesson_id: A.L[0], position: 4, playing: true })).j;
    check('P-01', '재생 1초 후 끝으로 건너뛰기', '경과 시간만큼만 인정, 미완료', `인정 ${s.max_pos.toFixed(1)}초 / 완료 ${!!s.completed_at}`, s.max_pos < 2 && !s.completed_at);
    await c('POST', '/api/my/progress', { lesson_id: A.L[0], position: s.max_pos, playing: false });
  }
  {
    const c = L['20210102'];
    let s;
    for (let i = 0; i < 10; i++) {
      await c('POST', '/api/my/progress', { lesson_id: A.L[0], position: i * 0.4, playing: true });
      s = (await c('POST', '/api/my/progress', { lesson_id: A.L[0], position: i * 0.4 + 0.4, playing: false })).j;
    }
    check('P-02', '재생/정지 신호를 지연 없이 10회 반복', '≈0초 인정', `인정 ${s.max_pos.toFixed(1)}초`, s.max_pos < 1);
  }
  {
    const c = L['20220202'];
    await c('POST', '/api/my/progress', { lesson_id: A.L[0], position: 0, playing: true });
    const b = await c('POST', '/api/my/progress', { lesson_id: B.L[0], position: 0, playing: true });
    check('P-03', '두 창에서 서로 다른 차시 동시 재생', '두 번째 재생 거부(409)', `${b.status}`, b.status === 409);
    await c('POST', '/api/my/progress', { lesson_id: A.L[0], position: 0, playing: false });
  }
  {
    const r = await admin('POST', `/api/admin/courses/${A.id}/lessons`, { title: 'x', kind: 'video', url: '/videos/x.mp4', duration_sec: 0 });
    check('P-04', '영상 길이 없이 차시 등록', '저장 거부(400)', `${r.status} ${r.j.error || ''}`, r.status === 400);
  }

  // ---------- 다차시 / 자료 차시 ----------
  const W = L['20230301'];
  let s1 = await watch(W, A.L[0], 4);
  let my = (await W('GET', '/api/my/courses')).j.courses.find((x) => x.id === A.id);
  check('L-01', '2차시 과정에서 1차시만 완료', '1차시 완료, 과정은 미이수', `1차시 ${!!s1.completed_at} / 과정 ${my.status} ${my.pct}%`, s1.completed_at && !my.completed_at && my.pct === 50);
  check('L-02', '1차시 완료 후 다음 차시 안내', `next_id = 2차시(${A.L[1]})`, `${s1.next_id}`, s1.next_id === A.L[1]);
  await watch(W, A.L[1], 4);
  my = (await W('GET', '/api/my/courses')).j.courses.find((x) => x.id === A.id);
  check('L-03', '2개 차시 모두 완료', '과정 이수 + 과정 수료증, 총 교육시간 = 차시 합(8초)', `${my.status} / 증서 ${my.cert_no} / 총 ${my.total_sec}초`, my.status === 'completed' && my.cert_no && my.total_sec === 8);
  await watch(W, B.L[0], 4);
  const ack = (await W('POST', `/api/my/lessons/${B.L[1]}/ack`, {})).j;
  check('L-04', '영상 + 자료 차시 과정: 자료 ‘확인 완료’', '과정 이수, 총 교육시간 = 4초 + 10분', `과정 이수 ${!!ack.course.completed_at}`, !!ack.course.completed_at);

  // 차시 교체: 이수자(강서윤)는 유지, 진행 중(최지우·이서연)은 새 영상 필요
  const midUser = L['20220201'];
  await watch(midUser, A.L[0], 4);
  const rep = (await admin('PUT', `/api/admin/lessons/${A.L[1]}`, { title: '2차시(개정)', url: '/videos/test-new.mp4', duration_sec: 4 })).j;
  const A2 = (await admin('GET', '/api/admin/courses')).j.items.find((x) => x.id === A.id);
  my = (await W('GET', '/api/my/courses')).j.courses.find((x) => x.id === A.id);
  const mid = (await midUser('GET', '/api/my/courses')).j.courses.find((x) => x.id === A.id);
  check('L-05', '이수 후 2차시 영상 교체', '기존 이수자는 이수 유지, 진행 중인 사람은 새 2차시를 봐야 함',
    `교체=${rep.replaced} / 강서윤 ${my.status} / 박도윤 ${mid.status} (2차시 ${mid.lessons[1].completed_at ? '완료' : '미완료'})`,
    rep.replaced && my.status === 'completed' && mid.status !== 'completed' && !mid.lessons[1].completed_at);
  const old = await midUser('GET', `/api/my/lessons/${A.L[1]}`);
  check('L-06', '교체 전 차시 주소로 직접 접근', '404 (교체된 차시)', `${old.status}`, old.status === 404);
  // 차시 추가 → 삭제
  const added = (await admin('POST', `/api/admin/courses/${A.id}/lessons`, { title: '3차시(추가)', kind: 'video', url: '/videos/test-add.mp4', duration_sec: 4 })).j.id;
  await watch(midUser, A2.lessons[1].id, 4);
  const beforeDel = (await midUser('GET', '/api/my/courses')).j.courses.find((x) => x.id === A.id);
  await admin('DELETE', `/api/admin/lessons/${added}`);
  const afterDel = (await midUser('GET', '/api/my/courses')).j.courses.find((x) => x.id === A.id);
  check('L-07', '차시 추가 후 삭제: 남은 차시를 다 본 사람', '추가 시 미이수 → 삭제 후 자동 이수 처리', `추가 후 ${beforeDel.status} → 삭제 후 ${afterDel.status}`, beforeDel.status !== 'completed' && afterDel.status === 'completed');
  const hist = (await admin('GET', `/api/admin/courses/${A.id}/changes`)).j.items.map((h) => h.action);
  check('L-08', '과정별 변경 이력', '등록·차시 추가·교체·삭제가 모두 기록', hist.join(', '), ['과정 등록', '차시 추가', '차시 교체', '차시 삭제'].every((a) => hist.includes(a)));

  // ---------- 교육 기간 ----------
  const soon = await L['20230302']('POST', '/api/my/progress', { lesson_id: Soon.L[0], position: 0, playing: true });
  const soonState = (await L['20230302']('GET', '/api/my/courses')).j.courses.find((x) => x.id === Soon.id);
  check('T-01', '시작일 전 수강 시도', '거부(403), 상태 ‘시작 전’', `${soon.status} ${soon.j.error || ''} / ${soonState.status}`, soon.status === 403 && soonState.status === 'upcoming');
  const lateBefore = (await L['20230302']('GET', '/api/my/courses')).j.courses.find((x) => x.id === Late.id);
  const lt = await watch(L['20230302'], Late.L[0], 4);
  const lateAfter = (await L['20230302']('GET', '/api/my/courses')).j.courses.find((x) => x.id === Late.id);
  check('T-02', '마감 다음 날 수강', '수강 가능, ‘지연 이수’로 인정 + 수료증', `이수 전 ${lateBefore.status} → ${lateAfter.status}, 증서 ${lateAfter.cert_no}`, lateBefore.status === 'overdue' && lateAfter.status === 'completed_late' && lateAfter.cert_no && lt.completed_at);
  const ctab = (await admin('GET', '/api/admin/courses')).j.items.find((x) => x.id === Late.id);
  check('T-03', '과정별 교육기간·총 교육시간·이수 집계', `기간 ${Late.start_date}~${Late.due_date}, 총 4초, 지연 이수 1`, `${ctab.start_date}~${ctab.due_date}, 총 ${ctab.total_sec}초, 이수 ${ctab.completed}(지연 ${ctab.late})`, ctab.total_sec === 4 && ctab.late === 1);
  const badDate = await admin('POST', '/api/admin/courses', { title: 'x', start_date: ymd(5), due_date: ymd(1) });
  check('T-04', '마감일이 시작일보다 빠른 과정 등록', '거부(400)', `${badDate.status}`, badDate.status === 400);

  // ---------- 수료 판정 ----------
  let dash = (await admin('GET', '/api/admin/dashboard')).j;
  const finals = (await admin('GET', '/api/admin/certificates')).j.items.filter((x) => x.kind === 'final' && !x.revoked_at).length;
  check('C-01', '대시보드 ‘전 과정 수료’ = 종합 수료증 보유자', '같은 수 (선택 과정 제외)', `대시보드 ${dash.kpi.all_done} / 종합 수료증 ${finals}`, dash.kpi.all_done === finals);
  check('C-02', '대시보드 마감 경과·지연 이수 집계', '마감 경과(테스트C 미이수자) > 0, 지연 이수 1', `마감 경과 ${dash.kpi.overdue} / 지연 이수 ${dash.kpi.late_done}`, dash.kpi.overdue > 0 && dash.kpi.late_done === 1);

  // ---------- 권한 / 계정 ----------
  const adminLearn = await admin('GET', '/api/my/courses');
  check('H-01', 'HR 관리자 계정으로 수강 시도', '403 — 관리 전용 계정', `${adminLearn.status} ${adminLearn.j.error || ''}`, adminLearn.status === 403);
  const hrLearner = await L['20210102']('GET', '/api/my/courses');
  const hrAdmin = await L['20210102']('GET', '/api/admin/users');
  check('H-02', 'HR 담당자(이서연)의 교육생 계정', '수강 가능, HR 관리 기능은 불가', `수강 ${hrLearner.status} / 관리 ${hrAdmin.status}`, hrLearner.status === 200 && hrAdmin.status === 403);
  const tgt = (await admin('GET', '/api/admin/reminders')).j.targets.map((t) => t.user.login_id);
  check('H-03', '대표이사·HR 담당자도 교육 대상', '미이수 대상 목록에 ceo, seoyeon.lee 포함', `ceo ${tgt.includes('ceo')} / HR ${tgt.includes('seoyeon.lee')}`, tgt.includes('ceo') && tgt.includes('seoyeon.lee'));

  // ---------- 독촉 메일 ----------
  const r1 = (await admin('POST', '/api/admin/reminders', { course_ids: [A.id], message: '수동 독촉 테스트' })).j;
  await sleep(1500);
  const manualMails = smtp.inbox.filter((m) => m.body.includes('수동 독촉 테스트'));
  const doneEmail = 'seoyun.kang@example.com';
  check('M-01', '수동 독촉 → 실제 메일 발송', `미이수자 ${r1.target_count}명에게 메일, 이수자 제외`, `수신 ${manualMails.length}통 / 이수자 수신 ${manualMails.some((m) => m.rcpt.includes(doneEmail))}`,
    r1.target_count > 0 && manualMails.length === r1.mail_count && !manualMails.some((m) => m.rcpt.includes(doneEmail)));
  const log = (await admin('GET', '/api/admin/mail')).j.items;
  check('M-02', '메일 발송 기록', '모두 ‘발송’ 상태', `sent ${log.filter((m) => m.status === 'sent').length} / 기타 ${log.filter((m) => m.status !== 'sent').length}`, log.length && log.every((m) => m.status === 'sent'));
  const before = smtp.inbox.length;
  const auto1 = (await admin('POST', '/api/admin/reminders/run-auto', {})).j.sent;
  await sleep(1500);
  const autoMails = smtp.inbox.slice(before);
  const d10 = autoMails.filter((m) => m.body.includes('마감까지 10일'));
  const overdueMail = autoMails.filter((m) => m.subject.includes('[독촉]') && m.body.includes('마감일') && m.body.includes('지났습니다'));
  check('M-03', '자동 독촉: 마감 D-10 과정(테스트A)', 'D-10 안내 메일 발송', `${d10.length}통`, d10.length > 0);
  check('M-04', '자동 독촉: 마감 다음 날(D+1) 과정(테스트C)', '[독촉] 메일 + 12/31 미이수 확정 안내', `${overdueMail.length}통${overdueMail[0] ? ' · ' + overdueMail[0].subject : ''}`, overdueMail.length > 0 && overdueMail[0].body.includes('12-31'));
  const auto2 = (await admin('POST', '/api/admin/reminders/run-auto', {})).j.sent;
  check('M-05', '같은 날 자동 독촉 재실행', '중복 발송 없음', `1회차 ${auto1.length}건 / 2회차 ${auto2.length}건`, auto1.length > 0 && auto2.length === 0);
  const startSoon = autoMails.filter((m) => m.body.includes('테스트D'));
  check('M-06', '시작 전 과정은 독촉하지 않음', '테스트D 언급 0통', `${startSoon.length}통`, startSoon.length === 0);

  // ---------- 계정 규칙 / 연도별 명부 교체 ----------
  {
    const r = (await admin('POST', '/api/admin/users', { name: '신입사원', email: 'new.hire@example.com', phone: '010-1111-7788', department: 'QA팀' })).j;
    const c = client();
    const lg = await c('POST', '/api/login', { login_id: 'new.hire', password: '7788' });
    const blocked = await c('GET', '/api/my/courses');
    const weak = await c('POST', '/api/me/password', { current_password: '7788', new_password: '1234' });
    const ok = await c('POST', '/api/me/password', { current_password: '7788', new_password: 'MyPass2026' });
    check('U-01', '신규 교육생: 아이디=이메일 앞부분, 초기 비밀번호=휴대폰 뒤 4자리', '로그인 성공 → 변경 전 수강 차단 → 약한 비밀번호 거부 → 변경 성공',
      `아이디 ${r.login_id} / 로그인 ${lg.status} / 차단 ${blocked.status} / 약한PW ${weak.status} / 변경 ${ok.status}`, r.login_id === 'new.hire' && lg.status === 200 && blocked.status === 403 && weak.status === 400 && ok.status === 200);
    const noPhone = await admin('POST', '/api/admin/users', { name: '전화없음', email: 'nophone@example.com' });
    check('U-02', '휴대폰 번호 없이 교육생 등록', '거부(400) — 초기 비밀번호를 만들 수 없음', `${noPhone.status} ${noPhone.j.error || ''}`, noPhone.status === 400);
  }
  {
    const all = (await admin('GET', '/api/admin/users')).j.items.filter((u) => u.role === 'learner' && u.active);
    const certsBefore = (await admin('GET', '/api/admin/certificates')).j.items.length;
    // 새해 명부: 임시우·신입사원 제외(퇴사), 장수아 부서 이동, 신규 1명, 오류 행 없음
    const rows = all.filter((u) => !['siwoo.lim', 'new.hire'].includes(u.login_id))
      .map((u) => ({ name: u.name, emp_no: u.emp_no, department: u.login_id === 'sua.jang' ? '전략팀' : u.department, position: u.position, email: u.email, phone: u.phone }));
    rows.push({ name: '한새해', email: 'saehae.han@example.com', phone: '010-2027-0101', department: '개발팀' });
    const bad = await admin('POST', '/api/admin/users/sync', { rows: [...rows, { name: '이메일없음', phone: '010-0000-0000' }], apply: false });
    const badApply = await admin('POST', '/api/admin/users/sync', { rows: [...rows, { name: '이메일없음', phone: '010-0000-0000' }], apply: true });
    check('U-03', '오류 행이 섞인 명부로 교체 시도', '미리보기에 오류 표시, 적용 거부', `오류 ${bad.j.errors.length}건 / 적용 ${badApply.status}`, bad.j.errors.length === 1 && badApply.status === 400);
    const plan = (await admin('POST', '/api/admin/users/sync', { rows, apply: false })).j;
    check('U-04', '새해 명부 미리보기', '신규 1 · 변경 1(장수아 부서) · 비활성 2(임시우·신입사원)',
      `신규 ${plan.add.map((x) => x.login_id)} · 변경 ${plan.update.map((x) => x.login_id)} · 비활성 ${plan.deactivate.map((x) => x.login_id)}`,
      plan.add.length === 1 && plan.update.length === 1 && plan.update[0].login_id === 'sua.jang' && plan.deactivate.length === 2);
    await admin('POST', '/api/admin/users/sync', { rows, apply: true });
    const gone = await client()('POST', '/api/login', { login_id: 'siwoo.lim', password: '0502' });
    const fresh = await client()('POST', '/api/login', { login_id: 'saehae.han', password: '0101' });
    const after = (await admin('GET', '/api/admin/users')).j.items;
    const certsAfter = (await admin('GET', '/api/admin/certificates')).j.items.length;
    check('U-05', '명부 교체 적용', '퇴사자 로그인 불가 · 신규자 로그인 가능 · 부서 변경 반영 · 지난 수료증 보존',
      `퇴사자 ${gone.status} / 신규 ${fresh.status} / 장수아 ${after.find((u) => u.login_id === 'sua.jang').department} / 수료증 ${certsBefore}→${certsAfter}`,
      gone.status === 401 && fresh.status === 200 && after.find((u) => u.login_id === 'sua.jang').department === '전략팀' && certsAfter === certsBefore);
    const back = (await admin('POST', '/api/admin/users/sync', { rows: [...rows, { name: '임시우', email: 'siwoo.lim@example.com', phone: '010-5555-0502', department: '영업팀' }], apply: true })).j;
    check('U-06', '퇴사 처리했던 사람이 다음 명부에 다시 포함', '재활성(새 계정 아님)', `재활성 ${back.reactivate.map((x) => x.login_id)} / 신규 ${back.add.length}`, back.reactivate.length === 1 && back.add.length === 0);
  }

  {
    // 링크를 공유해도 영상·사내 문서는 로그인해야 열린다 (Windows 경로 변형 포함)
    const V = '_test.mp4';
    const paths = [`/videos/${V}`, `/VIDEOS/${V}`, `//videos/${V}`, `/%2Fvideos/${V}`, `/videos./${V}`, `/videos/${V}.`, `/videos/${V}%20`, `/videos/${V}::$DATA`, '/docs/_test.html', '/DOCS/_test.html'];
    const codes = [];
    for (const p of paths) { const r = await fetch(BASE + p, { headers: { Range: 'bytes=0-0' } }); codes.push(r.status); await r.body?.cancel(); }
    check('S-01', '로그인 없이 영상·사내 문서 주소 접근', '경로를 변형해도 내용을 받을 수 없음', codes.join(' '), codes.every((c) => [401, 403, 404].includes(c)));
    const doc = await admin('GET', '/docs/_test.html');
    check('S-02', '로그인 후 사내 문서 접근', '200', String(doc.status), doc.status === 200);
    const lr = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login_id: 'admin', password: 'Admin5678!' }) });
    const bad = await fetch(`${BASE}/videos/${V}`, { headers: { Range: 'bytes=999999999999-', cookie: lr.headers.get('set-cookie').split(';')[0] } });
    await bad.body?.cancel();
    const alive = await fetch(`${BASE}/`); await alive.body?.cancel();
    check('S-03', '영상 범위를 벗어난 요청', '416, 서버는 계속 동작', `${bad.status} / 이후 접속 ${alive.status}`, bad.status === 416 && alive.status === 200);
  }

  smtp.srv.close();
  fs.writeFileSync(path.join(__dirname, 'phase1-ids.json'), JSON.stringify({ A: A.id, Late: Late.id, LateLesson: Late.L[0] }));
}

async function phase2() {
  const ids = JSON.parse(fs.readFileSync(path.join(__dirname, 'phase1-ids.json'), 'utf8'));
  const admin = await login('admin', 'Admin5678!');
  const serverToday = (await admin('GET', '/api/admin/dashboard')).j.today;
  if (!serverToday.endsWith('-01-02')) throw new Error(`서버 날짜가 ${serverToday} 입니다 — LMS_FAKE_TODAY가 적용된 서버가 아닙니다.`);
  const u = await seedLogin('20230401');
  const s = await u('POST', '/api/my/progress', { lesson_id: ids.LateLesson, position: 0, playing: true });
  const mine = (await u('GET', '/api/my/courses')).j.courses.find((x) => x.id === ids.Late);
  check('Y-01', '12/31 이후 미이수자가 수강 시도', '거부(403), 상태 ‘미이수(확정)’', `${s.status} ${s.j.error || ''} / ${mine.status}`, s.status === 403 && mine.status === 'failed');
  const done = (await seedLogin('20230302'))('GET', '/api/my/courses');
  const doneState = (await done).j.courses.find((x) => x.id === ids.Late);
  check('Y-02', '12/31 이전 지연 이수자', '지연 이수 유지', doneState.status, doneState.status === 'completed_late');
  const tg = (await admin('GET', '/api/admin/reminders')).j.targets;
  check('Y-03', '12/31 이후 독촉 대상', '종료된 과정은 독촉 대상 아님 (0명)', `${tg.length}명`, tg.length === 0);
  const dash = (await admin('GET', '/api/admin/dashboard')).j;
  check('Y-04', '대시보드 미이수 확정 집계', '미이수(확정) > 0, 마감 경과 0', `확정 ${dash.kpi.failed} / 마감 경과 ${dash.kpi.overdue}`, dash.kpi.failed > 0 && dash.kpi.overdue === 0);
}

(async () => {
  if (PHASE2) await phase2(); else await phase1();
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n결과: ${pass}/${results.length} 통과`);
  const file = path.join(__dirname, PHASE2 ? 'result-year-end.json' : 'result-main.json');
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
