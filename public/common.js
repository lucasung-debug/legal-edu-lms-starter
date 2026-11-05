// 공통 유틸 — 모든 화면에서 사용
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  // 로그인 화면 자체에서는 이동하지 않는다(로그인 여부 확인 요청이 401이면 무한 새로고침이 됨)
  if (res.status === 401 && location.pathname !== '/') { location.href = '/'; throw new Error(data.error || '로그인이 필요합니다.'); }
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function toast(msg, type = '') {
  let box = $('#toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 4500 : 2800);
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }) : '-');
const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '-');
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const fmtMin = (sec) => { const m = Math.round((sec || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60 ? `${m % 60}분` : ''}`.trim() : `${m}분`; };
const STATUS = {
  completed: ['ok', '이수 완료'], completed_late: ['ok', '지연 이수'], in_progress: ['info', '학습 중'], not_started: ['', '미시작'],
  overdue: ['bad', '마감 경과'], failed: ['bad', '미이수(확정)'], upcoming: ['', '시작 전'],
};
const statusBadge = (s) => `<span class="badge ${STATUS[s]?.[0] || ''}">${STATUS[s]?.[1] || esc(s)}</span>`;
function dday(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return '<span class="badge">상시</span>';
  if (daysLeft < 0) return `<span class="badge bad">마감 ${-daysLeft}일 지남</span>`;
  if (daysLeft === 0) return '<span class="badge bad">오늘 마감</span>';
  return `<span class="badge ${daysLeft <= 7 ? 'warn' : ''}">D-${daysLeft}</span>`;
}

// 모달: html 문자열을 받아 띄우고, 닫기 함수를 돌려준다
function openModal(html, { wide = false, dismissable = true } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  if (dismissable) bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close));
  document.body.appendChild(bg);
  const first = $('input, select, textarea', bg);
  if (first) first.focus();
  return { el: bg, close };
}

// 최초 로그인 시 비밀번호 변경 모달 (취소 불가)
function passwordChangeModal({ forced = false } = {}) {
  return new Promise((resolve) => {
    const m = openModal(`
      <div class="modal-head"><h2>${forced ? '비밀번호 변경 (최초 로그인)' : '비밀번호 변경'}</h2></div>
      <form class="modal-body" id="pwForm">
        ${forced ? '<div class="alert info">보안을 위해 HR팀에서 발급한 임시 비밀번호를 본인만 아는 비밀번호로 변경해 주세요.</div>' : ''}
        <label class="field">현재 비밀번호<input type="password" name="current_password" autocomplete="current-password" required></label>
        <label class="field">새 비밀번호<span class="hint">영문 + 숫자 포함 8자 이상</span><input type="password" name="new_password" autocomplete="new-password" required minlength="8"></label>
        <label class="field">새 비밀번호 확인<input type="password" name="confirm" autocomplete="new-password" required></label>
        <div class="row" style="justify-content:flex-end">
          ${forced ? '' : '<button type="button" class="btn" data-close>취소</button>'}
          <button class="btn primary">변경하기</button>
        </div>
      </form>`, { dismissable: !forced });
    const root = m.el;
    $('#pwForm', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      if (f.new_password !== f.confirm) return toast('새 비밀번호가 일치하지 않습니다.', 'error');
      try {
        await api('POST', '/api/me/password', { current_password: f.current_password, new_password: f.new_password });
        root.remove();
        toast('비밀번호가 변경되었습니다.');
        resolve(true);
      } catch (err) { toast(err.message, 'error'); }
    });
    if (!forced) $$('[data-close]', root).forEach((b) => b.addEventListener('click', () => resolve(false)));
  });
}

async function logout() {
  try { await api('POST', '/api/logout', {}); } catch {}
  location.href = '/';
}

// 로그인 확인 + 역할 확인. 비밀번호 변경이 필요하면 먼저 처리한다.
async function requireUser(role) {
  const me = await api('GET', '/api/me');
  if (role && me.user.role !== role) { location.href = me.user.role === 'admin' ? '/admin' : '/learn'; throw new Error('redirect'); }
  if (me.user.must_change_pw) { await passwordChangeModal({ forced: true }); me.user.must_change_pw = false; }
  return me;
}
