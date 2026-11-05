// HR 관리자 화면 — 해시(#dashboard 등)로 탭 전환
const page = $('#page');
const views = {};

function downloadCsv(filename, rows) {
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob(['﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}
const pctBadge = (p) => `<span class="badge ${p >= 100 ? 'ok' : p >= 50 ? 'info' : p > 0 ? 'warn' : 'bad'}">${p}%</span>`;
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// 발급된 임시 비밀번호는 이 화면에서 한 번만 보여준다
function credentialsModal(list, title = '계정 발급 완료') {
  const m = openModal(`
    <div class="modal-head"><h2>${esc(title)}</h2></div>
    <div class="modal-body">
      <div class="alert">임시 비밀번호는 지금만 확인할 수 있습니다. CSV로 저장하거나 복사해 교육생에게 안내하세요. 최초 로그인 시 비밀번호 변경이 강제됩니다.</div>
      <div class="table-wrap" style="max-height:340px"><table><thead><tr><th>이름</th><th>부서</th><th>아이디</th><th>임시 비밀번호</th></tr></thead><tbody>
        ${list.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.department || '')}</td><td class="num">${esc(u.login_id)}</td><td class="num"><b>${esc(u.temp_password)}</b></td></tr>`).join('')}
      </tbody></table></div>
    </div>
    <div class="modal-foot"><button class="btn" id="copyCred">복사</button><button class="btn" id="csvCred">CSV 저장</button><button class="btn primary" data-close>확인</button></div>`, { wide: true, dismissable: false });
  const rows = [['이름', '부서', '이메일', '아이디', '임시비밀번호', '접속주소'], ...list.map((u) => [u.name, u.department, u.email, u.login_id, u.temp_password, location.origin])];
  $('#copyCred', m.el).onclick = () => navigator.clipboard.writeText(rows.map((r) => r.join('\t')).join('\n')).then(() => toast('복사했습니다.'));
  $('#csvCred', m.el).onclick = () => downloadCsv(`교육생_계정_${today()}.csv`, rows);
}

function confirmModal(message, okLabel = '확인', danger = false) {
  return new Promise((resolve) => {
    const m = openModal(`<div class="modal-body"><p style="margin:0;white-space:pre-line">${esc(message)}</p></div>
      <div class="modal-foot"><button class="btn" data-close>취소</button><button class="btn ${danger ? 'danger' : 'primary'}" id="ok">${esc(okLabel)}</button></div>`);
    $('#ok', m.el).onclick = () => { m.close(); resolve(true); };
    $$('[data-close]', m.el).forEach((b) => b.addEventListener('click', () => resolve(false)));
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했습니다.'); }
  catch { // http 주소에서는 브라우저가 클립보드를 막을 수 있어 직접 복사하도록 보여 준다
    const m = openModal(`<div class="modal-body"><p style="margin:0">아래 내용을 선택해 복사하세요.</p><textarea rows="8" id="copyBox">${esc(text)}</textarea></div><div class="modal-foot"><button class="btn primary" data-close>닫기</button></div>`);
    $('#copyBox', m.el).select();
  }
}

// ===================== 시작하기 =====================
views.start = async () => {
  const s = await api('GET', '/api/admin/start');
  const url = s.public_url || s.lan_urls[0] || location.origin;
  const notice = `[법정필수교육 안내]\n아래 주소에서 올해 법정필수교육을 이수해 주세요.\n\n· 접속 주소: ${url}\n· 아이디: 회사 이메일의 @ 앞부분\n· 첫 비밀번호: 휴대폰 번호 뒤 4자리 (처음 로그인할 때 새 비밀번호로 바꿉니다)\n· 문의: ${s.manager_contact}`;
  const steps = [
    { done: s.company, title: '회사 정보 확인', desc: s.company ? `${s.company_name} · 대표이사 ${s.ceo_name} 명의로 수료증이 발급됩니다.` : '수료증에 들어갈 회사명과 대표이사 성명을 입력하세요.', href: '#settings', label: '설정 열기' },
    { done: s.courses > 0, title: '교육 과정 만들기', desc: s.courses ? `과정 ${s.courses}개가 준비됐습니다.` : '법정교육 템플릿을 고르고 영상 링크나 파일을 넣으면 됩니다.', href: '#courses', label: '과정 관리' },
    { done: s.learners > 0, title: '교육생 명부 올리기', desc: s.learners ? `교육생 ${s.learners}명이 등록됐습니다.` : '엑셀 양식에 이름·이메일·휴대폰을 채워 올리면 계정이 만들어집니다.', href: '#users', label: '명부 관리' },
    { done: s.smtp, title: '메일 연결 (선택)', desc: s.smtp ? `${s.smtp_from} 계정으로 독촉 메일을 보냅니다.` : '연결하면 마감 전 자동 독촉 메일을 보낼 수 있습니다. 없어도 교육은 진행됩니다.', href: '#settings', label: '메일 설정' },
  ];
  const doneCount = steps.filter((x) => x.done).length;
  page.innerHTML = `
    <div class="page-head"><h1>시작하기</h1><span class="muted">${doneCount}/${steps.length} 완료</span></div>
    ${s.sample_loaded ? `<div class="alert info">지금은 <b>샘플 데이터</b>로 둘러보는 중입니다. 교육생 화면을 보려면 로그아웃 후 아이디 <b>minjun.kim</b>, 비밀번호 <b>0101</b>로 로그인해 보세요. 자동 독촉은 꺼 두었습니다.
      <div style="margin-top:8px"><button class="btn sm" id="clearSample">샘플 지우고 실제 운영 시작</button></div></div>` : ''}
    <section class="card">
      ${steps.map((x, i) => `<div class="step ${x.done ? 'done' : ''}"><div class="no">${x.done ? '✓' : i + 1}</div><div><b>${esc(x.title)}</b><p class="small muted">${esc(x.desc)}</p></div><a class="btn sm ${x.done ? '' : 'primary'}" href="${x.href}">${esc(x.label)}</a></div>`).join('')}
    </section>
    <div class="grid2">
      <section class="card"><div class="card-head"><h3>직원에게 보낼 안내문</h3><div class="spacer"></div><button class="btn sm primary" id="copyNotice">복사</button></div>
        <div class="card-pad"><div class="notice">${esc(notice)}</div></div></section>
      <section class="card"><div class="card-head"><h3>접속 주소</h3></div><div class="card-pad small" style="display:grid;gap:10px">
        <div><b>이 PC</b><br>${esc(location.origin)}</div>
        ${s.lan_urls.length ? `<div><b>같은 네트워크의 다른 PC</b><br>${s.lan_urls.map(esc).join('<br>')}</div>` : ''}
        <div class="muted">다른 PC에서 안 열리면 Windows 방화벽에서 허용해야 합니다. 회사 밖에서도 접속하려면 상시 켜 둔 서버가 필요하니 IT 담당자와 상의하세요.</div>
        <div class="muted">이 PC가 꺼지거나 LMS 창을 닫으면 접속이 끊깁니다.</div>
      </div></section>
    </div>`;
  $('#copyNotice').onclick = () => copyText(notice);
  if ($('#clearSample')) $('#clearSample').onclick = () => clearSample();
};

async function clearSample() {
  if (!await confirmModal('샘플 교육생과 샘플 과정, 그 이수 기록을 모두 지울까요?\n자동 독촉도 다시 켜집니다.', '샘플 지우기', true)) return;
  try { const r = await api('POST', '/api/admin/sample/clear', {}); toast(`샘플 교육생 ${r.users}명, 과정 ${r.courses}개를 지웠습니다.`); route(); } catch (err) { toast(err.message, 'error'); }
}

// ===================== 대시보드 =====================
views.dashboard = async () => {
  const d = await api('GET', '/api/admin/dashboard');
  const k = d.kpi;
  const maxDaily = Math.max(1, ...d.daily.map((x) => x.n));
  const W = 560, H = 160, bw = W / d.daily.length;
  page.innerHTML = `
    <div class="page-head"><h1>${d.edu_year}년 법정필수교육 대시보드</h1><span class="muted">기준일 ${d.today}</span><div class="spacer"></div>
      <a class="btn" href="/api/admin/export/completion">이수현황 엑셀(CSV)</a><a class="btn primary" href="#reminders">미수료자 독촉</a></div>
    <div class="kpis">
      <div class="card kpi"><div class="label">전체 이수율</div><div class="value num" style="color:var(--primary)">${k.rate}%</div><div class="bar" style="margin-top:8px"><i style="width:${k.rate}%"></i></div></div>
      <div class="card kpi"><div class="label">교육 대상자</div><div class="value num">${k.learners}명</div><div class="sub">교육 과정 ${k.courses}개</div></div>
      <div class="card kpi"><div class="label">전 과정 수료</div><div class="value num" style="color:var(--success)">${k.all_done}명</div><div class="sub">수료율 ${k.learners ? Math.round((k.all_done / k.learners) * 100) : 0}%</div></div>
      <div class="card kpi"><div class="label">미수료자</div><div class="value num" style="color:var(--danger)">${k.incomplete}명</div><div class="sub">미시작 ${k.not_started}명</div></div>
      <div class="card kpi"><div class="label">마감 경과 미이수</div><div class="value num" style="color:${k.overdue ? 'var(--warning)' : 'inherit'}">${k.overdue}건</div><div class="sub">12/31까지 지연 이수 가능 · 독촉 대상</div></div>
      <div class="card kpi"><div class="label">지연 이수 / 미이수 확정</div><div class="value num">${k.late_done} / ${k.failed}건</div><div class="sub">마감 후 이수 / 12/31 경과</div></div>
      <div class="card kpi"><div class="label">발급 수료증</div><div class="value num">${k.certificates}건</div><div class="sub">과정별 + 전 과정</div></div>
    </div>
    <div class="grid2">
      <section class="card"><div class="card-head"><h3>과정별 이수 현황</h3><div class="spacer"></div>
        <div class="legend"><span><i style="background:var(--success)"></i>이수</span><span><i style="background:#8fb0ff"></i>학습 중</span><span><i style="background:#edf0f5"></i>미시작</span></div></div>
        <div class="card-pad" style="padding-top:8px">
        ${d.courses.map((c) => `<div class="hbar"><div><div class="name"><b>${esc(c.title)}</b></div><div class="small muted">${c.start_date.slice(5)}~${c.due_date.slice(5)} · ${fmtMin(c.total_sec)} ${c.phase === 'open' && c.rate < 100 ? dday(c.days_left) : c.phase === 'late' ? '<span class="badge warn">마감 경과</span>' : c.phase === 'before' ? '<span class="badge">시작 전</span>' : ''}</div></div>
          <div class="stack" title="이수 ${c.done} / 학습 중 ${c.in_progress} / 미시작 ${c.not_started}"><i style="width:${(c.done / Math.max(1, k.learners)) * 100}%;background:var(--success)"></i><i style="width:${(c.in_progress / Math.max(1, k.learners)) * 100}%;background:#8fb0ff"></i></div>
          <b class="num" style="text-align:right">${c.rate}%</b></div>`).join('') || '<div class="empty">등록된 과정이 없습니다.</div>'}
        </div></section>
      <section class="card"><div class="card-head"><h3>부서별 이수율</h3><span class="muted small">낮은 순</span></div><div class="card-pad" style="padding-top:8px">
        ${d.departments.map((x) => `<div class="hbar"><div><div class="name"><b>${esc(x.department)}</b></div><div class="small muted">${x.learners}명 · 전 과정 수료 ${x.all_done}명</div></div>
          <div class="bar ${x.rate >= 100 ? 'ok' : ''}" style="height:12px"><i style="width:${x.rate}%;${x.rate < 50 ? 'background:var(--warning)' : ''}"></i></div><b class="num" style="text-align:right">${x.rate}%</b></div>`).join('') || '<div class="empty">교육생이 없습니다.</div>'}
      </div></section>
      <section class="card"><div class="card-head"><h3>최근 14일 일별 이수 건수</h3></div><div class="card-pad">
        <svg viewBox="0 0 ${W} ${H + 24}" width="100%" role="img" aria-label="일별 이수 건수">
          ${d.daily.map((x, i) => { const h = (x.n / maxDaily) * (H - 18); return `<g><rect x="${i * bw + 6}" y="${H - h}" width="${bw - 12}" height="${Math.max(h, 1)}" rx="4" fill="${x.n ? '#2f5bea' : '#e3e7ef'}"><title>${x.date}: ${x.n}건</title></rect>
            ${x.n ? `<text x="${i * bw + bw / 2}" y="${H - h - 4}" text-anchor="middle" font-size="11" fill="#344054">${x.n}</text>` : ''}
            <text x="${i * bw + bw / 2}" y="${H + 16}" text-anchor="middle" font-size="10" fill="#98a2b3">${x.date.slice(5).replace('-', '/')}</text></g>`; }).join('')}
        </svg></div></section>
      <section class="card"><div class="card-head"><h3>이수율 낮은 교육생</h3><div class="spacer"></div><a class="btn sm" href="#completion">전체 보기</a></div>
        <div class="table-wrap"><table><thead><tr><th>이름</th><th>부서</th><th>이수</th><th>진행률</th></tr></thead><tbody>
        ${d.laggards.map((r) => `<tr><td>${esc(r.user.name)}</td><td>${esc(r.user.department || '')}</td><td class="num">${r.done}/${k.courses}</td><td>${pctBadge(r.pct)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">모든 교육생이 이수했습니다 🎉</td></tr>'}
        </tbody></table></div></section>
    </div>`;
};

// ===================== 교육생 명부 =====================
views.users = async () => {
  const { items, course_count } = await api('GET', '/api/admin/users');
  const depts = [...new Set(items.map((u) => u.department).filter(Boolean))].sort();
  page.innerHTML = `
    <div class="page-head"><h1>교육생 명부</h1><span class="muted">${items.filter((u) => u.role === 'learner').length}명</span><div class="spacer"></div>
      <button class="btn" id="exportUsers">명부 내보내기</button><button class="btn" id="importBtn">CSV 추가 등록</button><button class="btn primary" id="syncBtn">연도별 명부 교체</button><button class="btn" id="addBtn">+ 교육생 등록</button></div>
    <div class="alert info small">계정 규칙: <b>아이디 = 이메일 @ 앞부분</b>, <b>초기 비밀번호 = 휴대폰 번호 뒤 4자리</b>. 최초 로그인 시 본인이 새 비밀번호(영문+숫자 8자 이상)로 바꿉니다.</div>
    <div class="card">
      <div class="card-head filters">
        <input id="fq" placeholder="이름·아이디·사번·이메일 검색">
        <select id="fd"><option value="">전체 부서</option>${depts.map((d) => `<option>${esc(d)}</option>`).join('')}</select>
        <select id="fs"><option value="">전체 상태</option><option value="active">재직(활성)</option><option value="inactive">비활성</option><option value="admin">관리자</option></select>
      </div>
      <div class="table-wrap"><table><thead><tr><th>사번</th><th>아이디</th><th>이름</th><th>부서</th><th>직급</th><th>이메일</th><th>이수</th><th>최근 로그인</th><th>상태</th><th></th></tr></thead><tbody id="tbody"></tbody></table></div>
    </div>`;
  const draw = () => {
    const qv = $('#fq').value.trim().toLowerCase(), dv = $('#fd').value, sv = $('#fs').value;
    const list = items.filter((u) => (!qv || [u.name, u.login_id, u.emp_no, u.email].some((x) => String(x || '').toLowerCase().includes(qv)))
      && (!dv || u.department === dv)
      && (!sv || (sv === 'admin' ? u.role === 'admin' : sv === 'active' ? u.active && u.role === 'learner' : !u.active)));
    $('#tbody').innerHTML = list.map((u) => `<tr data-id="${u.id}">
      <td class="num">${esc(u.emp_no || '')}</td><td class="num">${esc(u.login_id)}</td><td><b>${esc(u.name)}</b></td><td>${esc(u.department || '')}</td><td>${esc(u.position || '')}</td>
      <td>${esc(u.email || '')}</td><td>${u.role === 'admin' ? '-' : `<span class="badge ${u.completed >= course_count && course_count ? 'ok' : ''}">${u.completed}/${course_count}</span>`}</td>
      <td class="small">${u.last_login_at ? fmtDateTime(u.last_login_at) : '<span class="muted">미접속</span>'}</td>
      <td>${u.role === 'admin' ? '<span class="badge info">관리자</span>' : u.active ? '<span class="badge ok">활성</span>' : '<span class="badge">비활성</span>'}${u.must_change_pw ? ' <span class="badge warn">임시PW</span>' : ''}</td>
      <td><div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-act="edit">수정</button><button class="btn sm" data-act="reset">PW 초기화</button><button class="btn sm danger" data-act="del">삭제</button></div></td></tr>`).join('')
      || '<tr><td colspan="10" class="empty">검색 결과가 없습니다.</td></tr>';
  };
  ['fq', 'fd', 'fs'].forEach((id) => $(`#${id}`).addEventListener('input', draw));
  draw();

  $('#tbody').onclick = async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const u = items.find((x) => x.id === Number(btn.closest('tr').dataset.id));
    if (btn.dataset.act === 'edit') userForm(u);
    if (btn.dataset.act === 'reset' && await confirmModal(`${u.name}(${u.login_id})의 비밀번호를 ${u.role === 'learner' ? '휴대폰 번호 뒤 4자리로' : '임시 비밀번호로'} 초기화할까요?`, '초기화')) {
      try { credentialsModal([{ ...u, ...(await api('POST', `/api/admin/users/${u.id}/reset-password`, {})) }], '비밀번호 초기화 완료'); views.users(); } catch (err) { toast(err.message, 'error'); }
    }
    if (btn.dataset.act === 'del' && await confirmModal(`${u.name}(${u.login_id}) 계정을 삭제할까요?\n이수 기록과 수료증도 함께 삭제됩니다. 퇴사자는 ‘비활성’ 처리를 권장합니다.`, '삭제', true)) {
      try { await api('DELETE', `/api/admin/users/${u.id}`); toast('삭제했습니다.'); views.users(); } catch (err) { toast(err.message, 'error'); }
    }
  };
  $('#addBtn').onclick = () => userForm(null);
  $('#importBtn').onclick = () => importModal('add');
  $('#syncBtn').onclick = () => importModal('sync');
  $('#exportUsers').onclick = () => downloadCsv(`교육생명부_${today()}.csv`, [['사번', '아이디', '이름', '부서', '직급', '이메일', '전화', '구분', '상태', `이수(/${course_count})`, '최근로그인'],
    ...items.map((u) => [u.emp_no, u.login_id, u.name, u.department, u.position, u.email, u.phone, u.role === 'admin' ? '관리자' : '교육생', u.active ? '활성' : '비활성', u.completed, u.last_login_at ? fmtDateTime(u.last_login_at) : ''])]);
};

function userForm(u) {
  const isNew = !u;
  u = u || { active: true };
  const m = openModal(`
    <div class="modal-head"><h2>${isNew ? '교육생 등록' : '교육생 정보 수정'}</h2></div>
    <form class="modal-body" id="uf"><div class="form-grid">
      <label class="field">이름 *<input name="name" required value="${esc(u.name || '')}"></label>
      <label class="field">사번<input name="emp_no" value="${esc(u.emp_no || '')}"></label>
      <label class="field">부서<input name="department" value="${esc(u.department || '')}" list="deptList"></label>
      <label class="field">직급<input name="position" value="${esc(u.position || '')}"></label>
      <label class="field">이메일 *<span class="hint">교육생 아이디 = @ 앞부분</span><input name="email" type="email" value="${esc(u.email || '')}"></label>
      <label class="field">휴대폰 *<span class="hint">교육생 초기 비밀번호 = 뒤 4자리</span><input name="phone" value="${esc(u.phone || '')}" placeholder="010-0000-0000"></label>
      ${isNew ? `<label class="field">계정 유형<select name="role"><option value="learner">교육생 (수강)</option><option value="admin">HR 관리자 (관리 전용·수강 불가)</option></select></label>
        <div class="adm hidden full form-grid" style="gap:12px">
          <label class="field">관리자 아이디 *<input name="login_id"></label>
          <label class="field">관리자 초기 비밀번호<span class="hint">비우면 임시 비밀번호 자동 발급</span><input name="password" autocomplete="new-password"></label>
          <div class="alert small full">HR 관리자 계정은 관리 화면 전용입니다. HR 담당자와 대표이사도 법정교육 대상이므로, 본인 수강용 <b>교육생 계정을 별도로</b> 등록하세요.</div>
        </div>`
        : `<label class="field">아이디<span class="hint">${u.role === 'learner' ? '이메일을 바꾸면 함께 바뀝니다' : ''}</span><input disabled value="${esc(u.login_id)}"></label>
        <label class="check full"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> 활성 (해제 시 로그인 불가·교육 대상 및 이수율 집계에서 제외)</label>`}
    </div></form>
    <div class="modal-foot"><button class="btn" data-close>취소</button><button class="btn primary" id="save">${isNew ? '등록' : '저장'}</button></div>`);
  if (isNew) $('[name=role]', m.el).onchange = (e) => $('.adm', m.el).classList.toggle('hidden', e.target.value !== 'admin');
  $('#save', m.el).onclick = async () => {
    const f = Object.fromEntries(new FormData($('#uf', m.el)));
    if (!isNew) f.active = !!$('[name=active]', m.el).checked;
    try {
      if (isNew) { const r = await api('POST', '/api/admin/users', f); m.close(); credentialsModal([r]); }
      else { await api('PUT', `/api/admin/users/${u.id}`, f); m.close(); toast('저장했습니다.'); }
      views.users();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// mode 'add': 명부에 사람만 추가 / 'sync': 새해 명부로 교체 (신규·갱신·재활성·명부에 없는 사람 비활성화)
function importModal(mode) {
  const sync = mode === 'sync';
  const m = openModal(`
    <div class="modal-head"><h2>${sync ? '연도별 명부 교체' : 'CSV 추가 등록'}</h2><div class="spacer"></div><button class="btn sm" id="tpl">양식 다운로드</button></div>
    <div class="modal-body">
      <div class="alert info">${sync
        ? '올해 교육 대상 <b>전체 명부</b>를 올리세요. 미리보기에서 신규·변경·재입사·비활성화 대상을 확인한 뒤 적용합니다. <b>명부에 없는 교육생은 비활성화</b>(로그인 불가, 이수율 집계 제외)되며, 지난 이수 기록과 수료증은 삭제되지 않습니다. 같은 사람은 이메일 앞부분(아이디)으로 찾습니다.'
        : '명부에 <b>사람을 추가</b>만 합니다. 기존 교육생은 바뀌지 않습니다.'}
        <br>필수 열: <b>이름, 이메일, 휴대폰</b> · 선택 열: 사번, 부서, 직급. 엑셀 CSV(한글 포함)나 표 복사·붙여넣기 모두 됩니다.</div>
      <input type="file" id="file" accept=".csv,.txt">
      <textarea id="csv" rows="8" placeholder="사번,이름,부서,직급,이메일,휴대폰&#10;20250101,홍길동,인사팀,대리,gildong.hong@example.com,010-1234-5678"></textarea>
      <div id="preview" class="small muted"></div>
      <div id="plan"></div>
    </div>
    <div class="modal-foot"><button class="btn" data-close>취소</button>${sync ? '<button class="btn" id="check">미리보기</button><button class="btn primary" id="go" disabled>교체 적용</button>' : '<button class="btn primary" id="go">등록</button>'}</div>`, { wide: true });
  const map = { 사번: 'emp_no', 이름: 'name', 성명: 'name', 부서: 'department', 소속: 'department', 직급: 'position', 직위: 'position', 이메일: 'email', 메일: 'email', 전화: 'phone', 연락처: 'phone', 휴대폰: 'phone', 휴대폰번호: 'phone' };
  const rowsOf = () => {
    const rows = parseCsv($('#csv', m.el).value.replace(/^﻿/, ''));
    if (rows.length < 2) return [];
    const keys = rows[0].map((h) => map[h.replace(/\s/g, '')] || map[h.toLowerCase()] || h);
    return rows.slice(1).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] || ''])));
  };
  const preview = () => { const r = rowsOf(); $('#preview', m.el).textContent = r.length ? `${r.length}명 인식됨 · 예: ${r.slice(0, 3).map((x) => x.name).join(', ')}` : ''; };
  $('#csv', m.el).addEventListener('input', () => { preview(); if (sync) { $('#go', m.el).disabled = true; $('#plan', m.el).innerHTML = ''; } });
  // 한글 엑셀의 기본 ‘CSV(쉼표로 분리)’는 CP949(EUC-KR)로 저장되므로, UTF-8로 깨지면 EUC-KR로 다시 읽는다
  $('#file', m.el).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const buf = await f.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('euc-kr').decode(buf);
    $('#csv', m.el).value = text; $('#csv', m.el).dispatchEvent(new Event('input'));
  };
  $('#tpl', m.el).onclick = () => downloadCsv('교육생_명부양식.csv', [['사번', '이름', '부서', '직급', '이메일', '휴대폰'], ['20250101', '홍길동', '인사팀', '대리', 'gildong.hong@example.com', '010-1234-5678']]);
  if (sync) {
    const list = (title, items, fmt, cls = '') => items.length ? `<details ${items.length <= 10 ? 'open' : ''}><summary><span class="badge ${cls}">${title} ${items.length}명</span></summary>
      <div class="small" style="margin-top:6px;max-height:180px;overflow:auto">${items.map(fmt).join('<br>')}</div></details>` : '';
    $('#check', m.el).onclick = async () => {
      const rows = rowsOf();
      if (!rows.length) return toast('명부 데이터가 없습니다.', 'error');
      try {
        const p = await api('POST', '/api/admin/users/sync', { rows, apply: false });
        const who = (x) => `${esc(x.name)} (${esc(x.login_id)}) ${esc(x.department || '')}`;
        $('#plan', m.el).innerHTML = `<div style="display:grid;gap:6px">
          ${list('신규 등록', p.add, who, 'info')}${list('정보 변경', p.update, (x) => `${who(x)} — ${x.changed.map(esc).join(', ')}`)}
          ${list('재입사(재활성)', p.reactivate, who, 'ok')}${list('비활성화 (명부에 없음)', p.deactivate, who, 'bad')}
          <div class="small muted">변경 없음 ${p.unchanged}명</div>
          ${p.errors.length ? `<div class="alert small">오류 ${p.errors.length}건 — 고친 뒤 다시 미리보기 하세요.<br>${p.errors.map((x) => `${x.row ? `${x.row}행 ` : ''}${esc(x.error)}`).join('<br>')}</div>` : ''}</div>`;
        $('#go', m.el).disabled = !!p.errors.length;
      } catch (err) { toast(err.message, 'error'); }
    };
  }
  $('#go', m.el).onclick = async () => {
    if (sync) {
      if (!await confirmModal('미리보기 내용대로 명부를 교체할까요?\n명부에 없는 교육생은 비활성화됩니다.', '교체 적용', true)) return;
      try {
        const r = await api('POST', '/api/admin/users/sync', { rows: rowsOf(), apply: true });
        m.close(); toast(`교체 완료 · 신규 ${r.add.length} · 변경 ${r.update.length} · 재활성 ${r.reactivate.length} · 비활성 ${r.deactivate.length}`);
        if (r.created.length) credentialsModal(r.created, `신규 ${r.created.length}명 계정 발급`);
        views.users();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const rows = rowsOf();
    if (!rows.length) return toast('등록할 데이터가 없습니다.', 'error');
    try {
      const r = await api('POST', '/api/admin/users/import', { rows });
      m.close();
      if (r.errors.length) toast(`${r.errors.length}건 실패: ${r.errors.slice(0, 3).map((x) => `${x.row}행 ${x.error}`).join(' / ')}`, 'error');
      if (r.created.length) credentialsModal(r.created, `${r.created.length}명 등록 완료`);
      views.users();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ===================== 교육 과정 =====================
views.courses = async () => {
  const { items, learners } = await api('GET', '/api/admin/courses');
  const PHASE = { before: ['', '시작 전'], open: ['ok', '교육 중'], late: ['warn', '마감 후(지연 이수 기간)'], closed: ['bad', '종료'] };
  page.innerHTML = `
    <div class="page-head"><h1>교육 과정 관리</h1><span class="muted">과정마다 교육기간·차시·총 교육시간을 관리하고, 차시 추가·교체·삭제는 변경 이력에 기록됩니다.</span><div class="spacer"></div><button class="btn primary" id="addCourse">+ 과정 등록</button></div>
    <div class="alert info">교육기간 규칙: <b>시작일 전</b> 수강 불가 · <b>시작일~마감일</b> 정상 이수 · <b>마감 후 ~ 12/31</b> 지연 이수 인정(독촉 계속) · <b>12/31 이후</b> 미이수 확정.
      영상은 유튜브 링크를 붙여넣거나 MP4 파일을 직접 올리면 됩니다.</div>
    ${items.map((c) => `<section class="card" data-id="${c.id}">
      <div class="card-head" style="flex-wrap:wrap">
        <h3>${esc(c.title)}</h3><span class="badge ${PHASE[c.phase][0]}">${PHASE[c.phase][1]}</span>
        ${c.active ? '' : '<span class="badge">운영 중지</span>'}${c.required ? '<span class="badge info">필수</span>' : '<span class="badge">선택</span>'}
        <div class="spacer"></div>
        <button class="btn sm" data-act="history">변경 이력</button><button class="btn sm" data-act="edit">과정 수정</button><button class="btn sm danger" data-act="del">삭제</button>
      </div>
      <div class="card-pad" style="display:grid;gap:12px">
        <div class="row small" style="gap:18px">
          <span><span class="muted">교육기간</span> <b>${esc(c.start_date)} ~ ${esc(c.due_date)}</b></span>
          <span><span class="muted">총 교육시간</span> <b>${fmtMin(c.total_sec)}</b> (${c.lessons.length}차시)</span>
          <span><span class="muted">이수</span> <b class="num">${c.completed}/${learners}명</b>${c.late ? ` (지연 ${c.late})` : ''}</span>
          <span><span class="muted">누적 실제 학습시간</span> <b>${fmtMin(c.total_watch_sec)}</b></span>
          <span class="muted">${esc(c.legal_basis || '')}</span>
        </div>
        ${c.source_note ? `<div class="small muted">${esc(c.source_note)}</div>` : ''}
        <div class="table-wrap"><table><thead><tr><th>차시</th><th>제목</th><th>유형</th><th>링크</th><th>인정 시간</th><th></th></tr></thead><tbody>
          ${c.lessons.map((l) => `<tr data-lesson="${l.id}"><td class="num">${l.sort_order}</td><td class="wrap" style="min-width:240px"><b>${esc(l.title)}</b></td>
            <td>${l.kind === 'video' ? '<span class="badge info">영상</span>' : '<span class="badge">자료</span>'}</td>
            <td class="small"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url.length > 40 ? '…' + l.url.slice(-38) : l.url)}</a></td>
            <td class="num">${l.kind === 'video' ? fmtDur(l.duration_sec) : fmtMin(l.duration_sec)}</td>
            <td><div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-act="lesson-edit">수정·교체</button><button class="btn sm danger" data-act="lesson-del">삭제</button></div></td></tr>`).join('')
            || '<tr><td colspan="6" class="empty">차시가 없습니다. 차시를 추가해야 교육생이 수강할 수 있습니다.</td></tr>'}
        </tbody></table></div>
        <div><button class="btn sm" data-act="lesson-add">+ 차시 추가</button></div>
      </div>
    </section>`).join('') || '<div class="card empty">아직 과정이 없습니다. 오른쪽 위 <b>+ 과정 등록</b>에서 법정교육 템플릿을 골라 시작하세요.</div>'}`;
  $('#addCourse').onclick = () => courseForm(null);
  page.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const c = items.find((x) => x.id === Number(btn.closest('section[data-id]')?.dataset.id));
    if (!c) return;
    const lesson = c.lessons.find((l) => l.id === Number(btn.closest('tr')?.dataset.lesson));
    const act = btn.dataset.act;
    if (act === 'edit') courseForm(c);
    if (act === 'history') changesModal(c);
    if (act === 'lesson-add') lessonForm(c, null);
    if (act === 'lesson-edit') lessonForm(c, lesson);
    if (act === 'lesson-del' && await confirmModal(`${lesson.sort_order}차시 「${lesson.title}」를 삭제할까요?\n이미 과정을 이수한 교육생의 이수는 유지되고, 삭제 내역은 변경 이력에 남습니다.`, '삭제', true)) {
      try { await api('DELETE', `/api/admin/lessons/${lesson.id}`); toast('차시를 삭제했습니다.'); views.courses(); } catch (err) { toast(err.message, 'error'); }
    }
    if (act === 'del' && await confirmModal(`「${c.title}」 과정을 삭제할까요?\n모든 교육생의 진도 기록이 삭제됩니다. 기간이 끝난 과정은 ‘운영 중지’를 권장합니다.`, '삭제', true)) {
      try { await api('DELETE', `/api/admin/courses/${c.id}`); toast('삭제했습니다.'); views.courses(); } catch (err) { toast(err.message, 'error'); }
    }
  };
};

async function changesModal(c) {
  const { items } = await api('GET', `/api/admin/courses/${c.id}/changes`);
  openModal(`<div class="modal-head"><h2>변경 이력 · ${esc(c.title)}</h2></div>
    <div class="modal-body"><div class="table-wrap" style="max-height:60vh"><table><thead><tr><th>일시</th><th>작업</th><th>담당</th><th>내용</th></tr></thead><tbody>
      ${items.map((h) => `<tr><td class="small">${fmtDateTime(h.at)}</td><td><span class="badge ${/교체|삭제/.test(h.action) ? 'warn' : 'info'}">${esc(h.action)}</span></td><td>${esc(h.by_name || '시스템')}</td><td class="wrap small">${esc(h.detail || '')}</td></tr>`).join('')
        || '<tr><td colspan="4" class="empty">이력이 없습니다.</td></tr>'}
    </tbody></table></div></div>
    <div class="modal-foot"><button class="btn" id="csvHist">CSV 저장</button><button class="btn primary" data-close>닫기</button></div>`, { wide: true });
  $('#csvHist').onclick = () => downloadCsv(`${c.title}_변경이력_${today()}.csv`, [['일시', '작업', '담당', '내용'], ...items.map((h) => [fmtDateTime(h.at), h.action, h.by_name || '시스템', h.detail])]);
}

async function lessonForm(c, l) {
  const isNew = !l;
  l = l || { kind: 'video', sort_order: c.lessons.length + 1 };
  const { items: videos } = await api('GET', '/api/admin/videos').catch(() => ({ items: [] }));
  const m = openModal(`
    <div class="modal-head"><h2>${isNew ? '차시 추가' : `${l.sort_order}차시 수정·교체`} · ${esc(c.title)}</h2></div>
    <form class="modal-body" id="lf"><div class="form-grid">
      ${isNew ? '' : '<div class="alert full small">링크를 바꾸면 <b>교체</b>로 처리됩니다. 이미 과정을 이수한 교육생은 그대로 이수 유지, 아직 이수하지 않은 교육생은 새 영상을 처음부터 시청해야 합니다.</div>'}
      <label class="field full">차시 제목 *<input name="title" required value="${esc(l.title || '')}"></label>
      <label class="field">유형<select name="kind"><option value="video" ${l.kind === 'video' ? 'selected' : ''}>영상</option><option value="document" ${l.kind === 'document' ? 'selected' : ''}>자료(강의안·사내 규정)</option></select></label>
      <label class="field">차시 순서<input name="sort_order" type="number" min="1" value="${l.sort_order}"></label>
      <label class="field full">링크 *<span class="hint">유튜브 주소를 붙여넣으세요. 파일이라면 아래에서 올리면 자동으로 채워집니다.</span>
        <input name="url" required list="videoList" value="${esc(l.url || '')}" placeholder="https://youtu.be/...">
        <datalist id="videoList">${videos.map((v) => `<option value="${esc(v.url)}">${esc(v.name)} (${Math.round(v.size / 1048576)}MB)</option>`).join('')}</datalist></label>
      <div class="field full" style="display:grid;gap:4px"><span>또는 파일 올리기</span><span class="hint">영상 MP4·WEBM, 자료 PDF. 로그인한 사람만 볼 수 있습니다. 파일을 올리면 이 PC에 저장됩니다.</span>
        <input type="file" id="upFile" accept=".mp4,.webm,.pdf"><div class="upload-bar hidden" id="upBar"><i></i></div></div>
      <label class="field vid">영상 길이(초) *<span class="hint">이수 판정 기준 — 링크를 넣으면 자동으로 잽니다</span>
        <div class="row" style="flex-wrap:nowrap"><input name="duration_sec" type="number" min="1" value="${l.kind === 'video' ? l.duration_sec || '' : ''}"><button type="button" class="btn" id="detect">자동 측정</button></div></label>
      <label class="field doc">인정 교육시간(분) *<span class="hint">총 교육시간에 합산</span><input name="doc_minutes" type="number" min="1" value="${l.kind === 'document' ? Math.round(l.duration_sec / 60) : 10}"></label>
    </div></form>
    <div class="modal-foot"><button class="btn" data-close>취소</button><button class="btn primary" id="save">${isNew ? '추가' : '저장'}</button></div>`, { wide: true });
  const form = $('#lf', m.el);
  const sync = () => { const v = form.kind.value === 'video'; $('.vid', m.el).classList.toggle('hidden', !v); $('.doc', m.el).classList.toggle('hidden', v); };
  form.kind.onchange = sync; sync();
  const measure = async () => {
    const url = form.url.value.trim(), btn = $('#detect', m.el);
    if (!url) return toast('링크를 먼저 입력하세요.', 'error');
    btn.disabled = true; btn.textContent = '측정 중…';
    try { const d = await detectDuration(url); form.duration_sec.value = Math.round(d); toast(`영상 길이 ${fmtDur(d)}`); }
    catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = '자동 측정'; }
  };
  $('#detect', m.el).onclick = measure;
  form.url.addEventListener('change', () => { if (form.kind.value === 'video' && form.url.value.trim()) measure(); });
  $('#upFile', m.el).onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const bar = $('#upBar', m.el), save = $('#save', m.el);
    bar.classList.remove('hidden'); bar.firstElementChild.style.width = 0; save.disabled = true;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/admin/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (p) => { if (p.lengthComputable) bar.firstElementChild.style.width = `${(p.loaded / p.total) * 100}%`; };
    const finish = (message) => { save.disabled = false; bar.classList.add('hidden'); e.target.value = ''; if (message) toast(message, 'error'); };
    xhr.onerror = () => finish('파일을 올리지 못했습니다. 네트워크를 확인하세요.');
    xhr.onload = async () => {
      let r = {}; try { r = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status !== 200) return finish(r.error || `파일을 올리지 못했습니다. (${xhr.status})`);
      finish();
      form.url.value = r.url;
      const isPdf = /\.pdf$/i.test(r.name);
      form.kind.value = isPdf ? 'document' : 'video'; sync();
      if (!form.title.value.trim()) form.title.value = r.name.replace(/\.[^.]+$/, '');
      toast('파일을 올렸습니다.');
      if (!isPdf) measure();
    };
    xhr.send(file);
  };
  $('#save', m.el).onclick = async () => {
    const f = Object.fromEntries(new FormData(form));
    const body = { title: f.title, kind: f.kind, url: f.url, sort_order: Number(f.sort_order), duration_sec: f.kind === 'video' ? Number(f.duration_sec) : Number(f.doc_minutes) * 60 };
    try {
      const r = await api(isNew ? 'POST' : 'PUT', isNew ? `/api/admin/courses/${c.id}/lessons` : `/api/admin/lessons/${l.id}`, body);
      m.close(); toast(isNew ? '차시를 추가했습니다.' : r.replaced ? '차시를 교체했습니다. 변경 이력에 기록되었습니다.' : '저장했습니다.'); views.courses();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// 영상 길이를 관리자 브라우저에서 측정한다 (교육생 브라우저가 보내는 값은 서버가 신뢰하지 않음)
async function detectDuration(url) {
  if (/drive\.google\.com\//.test(url)) {
    const d = await api('GET', `/api/admin/drive-stream?url=${encodeURIComponent(url)}`);
    if (!d.drive_id) throw new Error('드라이브 파일 링크 형식이 아닙니다. 파일의 ‘링크 복사’ 주소를 넣으세요.');
    if (!d.stream_url) throw new Error('드라이브 API 키가 없어 자동 측정할 수 없습니다. 영상 길이(초)를 직접 입력하세요.');
    try { return await detectDuration(d.stream_url); }
    catch { throw new Error('드라이브 파일을 읽지 못했습니다. 파일 공유가 ‘링크가 있는 모든 사용자’인지 확인하거나 길이를 직접 입력하세요.'); }
  }
  const yt = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/.exec(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('영상 길이를 읽지 못했습니다. 직접 입력하세요.')); }, 15000);
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-9999px;width:320px;height:180px';
    document.body.appendChild(box);
    const cleanup = () => { clearTimeout(timer); box.remove(); };
    const done = (d) => { cleanup(); d > 0 ? resolve(d) : reject(new Error('영상 길이를 읽지 못했습니다. 직접 입력하세요.')); };
    if (!yt) {
      const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true; v.src = url;
      v.onloadedmetadata = () => done(v.duration);
      v.onerror = () => { cleanup(); reject(new Error('영상을 불러올 수 없습니다. 링크를 확인하세요.')); };
      box.appendChild(v);
      return;
    }
    const make = () => {
      const el = document.createElement('div'); box.appendChild(el);
      const p = new YT.Player(el, { videoId: yt[1], playerVars: { mute: 1 }, events: {
        onReady: () => { const d = p.getDuration(); if (d) return done(d); p.mute(); p.playVideo(); },
        onStateChange: () => { const d = p.getDuration(); if (d) { p.stopVideo(); done(d); } },
        onError: () => { cleanup(); reject(new Error('YouTube 영상을 불러올 수 없습니다. (비공개·퍼가기 금지 여부 확인)')); },
      } });
    };
    if (window.YT && YT.Player) return make();
    window.onYouTubeIframeAPIReady = make;
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
  });
}

// 법정교육 템플릿: 과정 이름·법령을 채워 주고 공개 교육자료를 받을 곳을 알려 준다. 법령과 이용 조건은 담당자가 최종 확인한다.
const COURSE_PRESETS = {
  harassment: {
    title: '직장 내 성희롱 예방교육', category: '성희롱 예방', legal_basis: '남녀고용평등과 일·가정 양립 지원에 관한 법률 제13조',
    description: '사업주(대표이사)를 포함한 전 직원 대상, 연 1회 이상.\n문의: 고용평등상담지원관 ☎1551-9811, 고객상담센터 ☎1350',
    tip: '고용노동부가 자체 교육용 영상과 강의안을 공개합니다. <b>회사 자체의 처리 절차·조치 기준, 고충상담·구제 절차 교육을 차시로 꼭 추가</b>해야 적정 시행으로 인정받을 수 있습니다.',
    link: ['고용노동부 교육자료', 'https://www.moel.go.kr/policy/policydata/view.do?bbs_seq=20260301034'],
  },
  privacy: {
    title: '개인정보보호 교육', category: '개인정보', legal_basis: '개인정보 보호법 제28조', description: '개인정보취급자 대상 정기 교육',
    tip: '개인정보 배움터에서 온라인 교육 콘텐츠 공동활용을 신청할 수 있습니다. 받은 콘텐츠는 안내된 이용 조건(출처 표시 등)을 지켜 주세요.',
    link: ['개인정보 배움터', 'https://edu.privacy.go.kr/'],
  },
  disability: {
    title: '직장 내 장애인 인식개선 교육', category: '장애인 인식개선', legal_basis: '장애인고용촉진 및 직업재활법 제5조의2', description: '사업주 포함 전 직원 대상, 연 1회 이상, 1시간 이상.',
    tip: '한국장애인고용공단이 이러닝 콘텐츠를 제공합니다. 출처 표시와 사용 조건을 확인하고 위 <b>출처 표시</b> 칸에 적어 주세요.',
    link: ['한국장애인고용공단', 'https://www.kead.or.kr/'],
  },
};
function courseForm(c) {
  const isNew = !c;
  c = c || { edu_year: new Date().getFullYear(), required: 1, active: 1, sort_order: 0, start_date: today() };
  const m = openModal(`
    <div class="modal-head"><h2>${isNew ? '교육 과정 등록' : '교육 과정 수정'}</h2></div>
    <form class="modal-body" id="cf"><div class="form-grid">
      ${isNew ? `<label class="field full">법정교육 템플릿<span class="hint">고르면 과정명과 법령이 채워집니다. 법령·이용 조건은 담당자가 최종 확인해 주세요.</span>
        <select id="preset"><option value="">직접 입력</option><option value="harassment">직장 내 성희롱 예방교육</option><option value="privacy">개인정보보호 교육</option><option value="disability">직장 내 장애인 인식개선 교육</option></select></label>
      <div class="alert info small full hidden" id="presetTip"></div>` : ''}
      <label class="field full">과정명 *<input name="title" required value="${esc(c.title || '')}" placeholder="예: 직장 내 성희롱 예방교육"></label>
      <label class="field">분류<input name="category" value="${esc(c.category || '')}" placeholder="성희롱 예방 / 개인정보 …"></label>
      <label class="field">관련 법령<input name="legal_basis" value="${esc(c.legal_basis || '')}"></label>
      <label class="field full">출처 표시<span class="hint">외부 교육 콘텐츠 사용 시 (예: 공공누리 출처표시 조건)</span><input name="source_note" value="${esc(c.source_note || '')}"></label>
      <label class="field">교육 연도<input name="edu_year" type="number" value="${c.edu_year}"></label>
      <label class="field">시작일 *<span class="hint">이 날짜 전에는 수강 불가</span><input name="start_date" type="date" required value="${esc(c.start_date || '')}"></label>
      <label class="field">마감일 *<span class="hint">이후 12/31까지는 지연 이수</span><input name="due_date" type="date" required value="${esc(c.due_date || '')}"></label>
      <label class="field">표시 순서<input name="sort_order" type="number" value="${c.sort_order}"></label>
      <div class="field"><span>&nbsp;</span><div class="row"><label class="check"><input type="checkbox" name="required" ${c.required ? 'checked' : ''}> 필수 (전 과정 수료 조건)</label>
        <label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> 운영 중</label></div></div>
      <label class="field full">과정 설명<textarea name="description">${esc(c.description || '')}</textarea></label>
    </div></form>
    <div class="modal-foot"><button class="btn" data-close>취소</button><button class="btn primary" id="save">${isNew ? '등록' : '저장'}</button></div>`, { wide: true });
  if (isNew) $('#preset', m.el).onchange = (e) => {
    const p = COURSE_PRESETS[e.target.value], form = $('#cf', m.el), tip = $('#presetTip', m.el);
    tip.classList.toggle('hidden', !p);
    if (!p) return;
    form.title.value = p.title; form.category.value = p.category; form.legal_basis.value = p.legal_basis; form.description.value = p.description;
    if (!form.due_date.value) { const d = new Date(Date.now() + 9 * 3600e3 + 30 * 86400e3).toISOString().slice(0, 10), end = `${form.edu_year.value}-12-31`; form.due_date.value = d > end ? end : d; }
    tip.innerHTML = `${p.tip} <a href="${p.link[1]}" target="_blank" rel="noopener">${p.link[0]} 열기</a>`;
  };
  $('#save', m.el).onclick = async () => {
    const form = $('#cf', m.el);
    const f = Object.fromEntries(new FormData(form));
    f.required = form.required.checked; f.active = form.active.checked;
    try {
      const r = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/admin/courses' : `/api/admin/courses/${c.id}`, f);
      m.close(); toast(isNew ? '과정을 만들었습니다. 이제 영상을 넣어 주세요.' : '저장했습니다.'); await views.courses();
      if (isNew) lessonForm({ id: r.id, title: f.title, lessons: [] }, null);
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ===================== 수료율 관리 =====================
views.completion = async () => {
  const { courses, rows } = await api('GET', '/api/admin/completion');
  const depts = [...new Set(rows.map((r) => r.user.department).filter(Boolean))].sort();
  page.innerHTML = `
    <div class="page-head"><h1>수료율 관리</h1><div class="spacer"></div><a class="btn" href="/api/admin/export/completion">엑셀(CSV) 다운로드</a></div>
    <div class="card">
      <div class="card-head filters">
        <input id="fq" placeholder="이름·사번 검색">
        <select id="fd"><option value="">전체 부서</option>${depts.map((d) => `<option>${esc(d)}</option>`).join('')}</select>
        <select id="fs"><option value="">전체</option><option value="done">필수 전 과정 수료</option><option value="incomplete">미수료</option><option value="none">미시작</option><option value="overdue">마감 경과 미이수 있음</option><option value="late">지연 이수 있음</option></select>
        <select id="fc"><option value="">과정 필터 없음</option>${courses.map((c) => `<option value="${c.id}">${esc(c.title)} 미이수</option>`).join('')}</select>
        <div class="spacer"></div><span class="small muted" id="cnt"></span>
      </div>
      <div class="table-wrap" style="max-height:calc(100vh - 220px)"><table><thead><tr><th>이름</th><th>부서</th><th>직급</th>
        ${courses.map((c) => `<th title="${esc(c.title)}" style="max-width:120px;overflow:hidden;text-overflow:ellipsis">${esc(c.title.replace(/교육$/, ''))}</th>`).join('')}<th>종합</th></tr></thead>
        <tbody id="tbody"></tbody></table></div>
      <div class="card-pad small muted">셀을 누르면 시청 시간·건너뛰기 시도 기록을 확인하고 진도를 초기화할 수 있습니다.</div>
    </div>`;
  const draw = () => {
    const qv = $('#fq').value.trim(), dv = $('#fd').value, sv = $('#fs').value, cv = Number($('#fc').value);
    const list = rows.filter((r) => (!qv || r.user.name.includes(qv) || String(r.user.emp_no || '').includes(qv))
      && (!dv || r.user.department === dv)
      && (!sv || (sv === 'done' ? r.all_required_done : sv === 'incomplete' ? !r.all_required_done : sv === 'overdue' ? r.cells.some((c) => ['overdue', 'failed'].includes(c.status))
        : sv === 'late' ? r.cells.some((c) => c.late) : r.cells.every((c) => c.pct === 0)))
      && (!cv || !r.cells.find((c) => c.course_id === cv).completed_at));
    $('#cnt').textContent = `${list.length}명`;
    $('#tbody').innerHTML = list.map((r) => `<tr><td><b>${esc(r.user.name)}</b></td><td>${esc(r.user.department || '')}</td><td>${esc(r.user.position || '')}</td>
      ${r.cells.map((c) => `<td><span class="cell ${c.completed_at ? 'done' : ['overdue', 'failed'].includes(c.status) ? 'bad' : c.pct ? 'part' : 'none'}" style="cursor:pointer" data-u="${r.user.id}" data-c="${c.course_id}" title="${STATUS[c.status][1]}${c.completed_at ? ` ${fmtDateTime(c.completed_at)}` : ` · 진도 ${c.pct}%`}">${c.completed_at ? (c.late ? '✓지연' : '✓') : c.status === 'failed' ? '미이수' : `${c.pct}%`}</span>${c.skip_attempts ? ' <span title="건너뛰기 시도" class="small" style="color:var(--danger)">⚠</span>' : ''}</td>`).join('')}
      <td>${pctBadge(r.pct)}</td></tr>`).join('') || `<tr><td colspan="${courses.length + 4}" class="empty">해당하는 교육생이 없습니다.</td></tr>`;
  };
  ['fq', 'fd', 'fs', 'fc'].forEach((id) => $(`#${id}`).addEventListener('input', draw));
  draw();
  $('#tbody').onclick = async (e) => {
    const el = e.target.closest('.cell'); if (!el) return;
    const r = rows.find((x) => x.user.id === Number(el.dataset.u));
    const course = courses.find((x) => x.id === Number(el.dataset.c));
    const c = r.cells.find((x) => x.course_id === course.id);
    const m = openModal(`<div class="modal-head"><h2>${esc(r.user.name)} · ${esc(course.title)}</h2></div>
      <div class="modal-body"><table><tbody>
        <tr><th>상태</th><td>${statusBadge(c.status)}</td></tr>
        <tr><th>진도율</th><td>${c.pct}%</td></tr><tr><th>이수 일시</th><td>${fmtDateTime(c.completed_at)}</td></tr>
        <tr><th>차시별</th><td class="wrap small">${course.lessons.map((l, i) => `${i + 1}차시 ${c.lessons[i].completed_at ? '✓' : `${c.lessons[i].pct}%`}`).join(' · ')}</td></tr>
        <tr><th>실제 학습 시간</th><td>${fmtDur(c.watch_sec)} (총 교육시간 ${fmtMin(course.total_sec)})</td></tr>
        <tr><th>건너뛰기 시도</th><td>${c.skip_attempts ? `<span class="badge bad">${c.skip_attempts}회 (진도 미인정 처리)</span>` : '없음'}</td></tr>
      </tbody></table></div>
      <div class="modal-foot"><button class="btn danger" id="reset">진도 초기화</button><div class="spacer"></div><button class="btn primary" data-close>닫기</button></div>`);
    $('#reset', m.el).onclick = async () => {
      if (!await confirmModal('이 과정의 진도와 수료증을 초기화할까요? (재수강 필요)', '초기화', true)) return;
      try { await api('POST', '/api/admin/progress/reset', { user_id: r.user.id, course_id: course.id }); m.close(); toast('초기화했습니다.'); views.completion(); } catch (err) { toast(err.message, 'error'); }
    };
  };
};

// ===================== 알림·독촉 =====================
views.reminders = async () => {
  const [{ targets, history, settings, smtp }, { items: courses }, mail] = await Promise.all([api('GET', '/api/admin/reminders'), api('GET', '/api/admin/courses'), api('GET', '/api/admin/mail')]);
  const active = courses.filter((c) => c.active && ['open', 'late'].includes(c.phase));
  const MS = { sent: ['ok', '발송'], queued: ['info', '대기'], failed: ['bad', '실패'], skipped: ['', '미발송(SMTP 미설정)'] };
  page.innerHTML = `
    <div class="page-head"><h1>알림 및 미수료 독촉</h1><div class="spacer"></div>
      <span class="badge ${settings.auto_remind === '1' ? 'ok' : ''}">자동 독촉 ${settings.auto_remind === '1' ? `ON · 마감 D-${settings.remind_days.split(',').join(', D-')}${settings.overdue_weekly === '1' ? ' · 마감 후 12/31까지 매주' : ''}` : 'OFF'}</span>
      <button class="btn sm" id="runAuto">오늘 자동 독촉 지금 실행</button><a class="btn sm" href="#settings">설정</a></div>
    ${smtp.configured ? `<div class="alert info">메일 발송 서버: <b>${esc(smtp.host)}</b> · 보내는 주소 ${esc(smtp.from)} <button class="btn sm" id="testMail" style="margin-left:8px">테스트 메일</button></div>`
      : '<div class="alert">메일이 아직 연결되지 않아 교육생 화면의 <b>알림만</b> 발송되고 메일은 ‘미발송’으로 기록됩니다. <a href="#settings">설정에서 메일 연결하기</a></div>'}
    <div class="grid2">
      <section class="card"><div class="card-head"><h3>독촉 보내기 (사내 알림 + 메일)</h3></div><div class="card-pad" style="display:grid;gap:14px">
        <div class="field"><b class="small">대상 과정 — 수강 가능 기간(마감 후 12/31까지 포함)인 과정만 표시</b>
          <div class="chips" id="chips">${active.map((c) => `<label class="chip"><input type="checkbox" value="${c.id}" checked> ${esc(c.title)}${c.phase === 'late' ? ' <span class="badge warn">마감 경과</span>' : ''}</label>`).join('') || '<span class="muted small">독촉 가능한 과정이 없습니다.</span>'}</div></div>
        <label class="field">추가 메시지<textarea id="msg" rows="4">법정필수교육은 관련 법령에 따라 전 직원이 반드시 이수해야 합니다. 마감일 전까지 이수 부탁드립니다.</textarea></label>
        <label class="check"><input type="checkbox" id="withMail" checked> 이메일도 함께 발송</label>
        <div class="alert info" id="tcount"></div>
        <div class="row"><button class="btn primary" id="send">🔔 독촉 발송</button><button class="btn" id="mailCsv">대상자 CSV</button></div>
      </div></section>
      <section class="card"><div class="card-head"><h3>미수료자 목록</h3><span class="badge bad" id="tbadge"></span></div>
        <div class="table-wrap" style="max-height:420px"><table><thead><tr><th>이름</th><th>부서</th><th>이메일</th><th>미이수 과정</th></tr></thead><tbody id="tlist"></tbody></table></div></section>
    </div>
    <section class="card"><div class="card-head"><h3>발송 이력</h3></div><div class="table-wrap"><table><thead><tr><th>일시</th><th>구분</th><th>발송자</th><th>대상</th><th>메일</th><th>메시지</th></tr></thead><tbody>
      ${history.map((h) => `<tr><td class="small">${fmtDateTime(h.created_at)}</td><td>${h.mode === 'auto' ? '<span class="badge info">자동</span>' : '<span class="badge">수동</span>'}</td><td>${esc(h.created_by_name || '시스템')}</td><td class="num">${h.target_count}명</td>
        <td class="small num">${h.mail_count ? `${h.mail_sent}/${h.mail_count} 발송${h.mail_failed ? ` · <span style="color:var(--danger)">실패 ${h.mail_failed}</span>` : ''}` : '-'}</td><td class="wrap small">${esc(h.message || '')}</td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">발송 이력이 없습니다.</td></tr>'}
    </tbody></table></div></section>
    <section class="card"><div class="card-head"><h3>메일 발송 기록</h3><span class="muted small">최근 200건</span><div class="spacer"></div>${mail.items.some((m) => ['failed', 'skipped'].includes(m.status)) ? '<button class="btn sm" id="retry">실패·미발송 재시도</button>' : ''}</div>
      <div class="table-wrap" style="max-height:360px"><table><thead><tr><th>일시</th><th>받는 사람</th><th>제목</th><th>상태</th></tr></thead><tbody>
      ${mail.items.map((m) => `<tr><td class="small">${fmtDateTime(m.sent_at || m.created_at)}</td><td class="small">${esc(m.name || '')} &lt;${esc(m.to_addr)}&gt;</td><td class="small wrap">${esc(m.subject)}</td>
        <td><span class="badge ${MS[m.status][0]}" title="${esc(m.error || '')}">${MS[m.status][1]}</span></td></tr>`).join('') || '<tr><td colspan="4" class="empty">메일 기록이 없습니다.</td></tr>'}
      </tbody></table></div></section>`;
  $('#runAuto').onclick = async () => {
    try { const r = await api('POST', '/api/admin/reminders/run-auto', {}); toast(r.sent.length ? r.sent.map((x) => `${x.course} ${x.target_count}명`).join(', ') + ' 발송' : '오늘 자동 독촉 대상이 없거나 이미 발송했습니다.'); views.reminders(); }
    catch (err) { toast(err.message, 'error'); }
  };
  if ($('#testMail')) $('#testMail').onclick = async () => {
    const to = prompt('테스트 메일을 받을 주소'); if (!to) return;
    try { await api('POST', '/api/admin/mail/test', { to }); toast('테스트 메일을 보냈습니다.'); } catch (err) { toast(err.message, 'error'); }
  };
  if ($('#retry')) $('#retry').onclick = async () => {
    try { const r = await api('POST', '/api/admin/mail/retry', {}); toast(`${r.requeued}건 재시도`); setTimeout(views.reminders, 1500); } catch (err) { toast(err.message, 'error'); }
  };
  const selected = () => $$('#chips input:checked').map((x) => Number(x.value));
  const filtered = () => { const ids = selected(); return targets.filter((t) => t.courses.some((c) => ids.includes(c.id))); };
  const draw = () => {
    const list = filtered(); const ids = selected();
    $('#tcount').innerHTML = `발송 대상: <b>${list.length}명</b> (이메일 등록 ${list.filter((t) => t.user.email).length}명)`;
    $('#tbadge').textContent = `${list.length}명`;
    $('#tlist').innerHTML = list.map((t) => `<tr><td><b>${esc(t.user.name)}</b></td><td>${esc(t.user.department || '')}</td><td class="small">${esc(t.user.email || '-')}</td>
      <td class="wrap small">${t.courses.filter((c) => ids.includes(c.id)).map((c) => esc(c.title)).join(', ')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">미수료자가 없습니다 🎉</td></tr>';
  };
  $('#chips').addEventListener('change', draw); draw();
  $('#send').onclick = async () => {
    const ids = selected(); if (!ids.length) return toast('과정을 하나 이상 선택하세요.', 'error');
    if (!filtered().length) return toast('발송 대상이 없습니다.', 'error');
    const withMail = $('#withMail').checked;
    if (!await confirmModal(`미수료자 ${filtered().length}명에게 독촉${withMail ? ' 알림과 메일' : ' 알림'}을 발송할까요?`, '발송')) return;
    try {
      const r = await api('POST', '/api/admin/reminders', { course_ids: ids, message: $('#msg').value, with_mail: withMail });
      toast(`${r.target_count}명에게 알림 발송${withMail ? r.smtp ? ` · 메일 ${r.mail_count}통 발송 중` : ' · SMTP 미설정으로 메일 미발송' : ''}`);
      setTimeout(views.reminders, 1200);
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#mailCsv').onclick = () => downloadCsv(`미수료자_${today()}.csv`, [['이름', '부서', '이메일', '미이수 과정'], ...filtered().map((t) => [t.user.name, t.user.department, t.user.email, t.courses.map((c) => c.title).join(' / ')])]);
};

// ===================== 수료증 관리 =====================
views.certificates = async () => {
  const { items } = await api('GET', '/api/admin/certificates');
  page.innerHTML = `
    <div class="page-head"><h1>수료증 관리</h1><span class="muted">대표이사 명의로 이수 즉시 자동 발급됩니다.</span><div class="spacer"></div><button class="btn" id="exp">발급대장 CSV</button><a class="btn" href="#settings">대표이사·직인 설정</a></div>
    <div class="card">
      <div class="card-head filters">
        <input id="fq" placeholder="이름·증서번호 검색">
        <select id="fk"><option value="">전체 구분</option><option value="final">전 과정 수료증</option><option value="course">과정별 수료증</option></select>
        <select id="fs"><option value="valid">유효</option><option value="revoked">효력정지</option><option value="">전체</option></select>
        <div class="spacer"></div><span class="small muted" id="cnt"></span>
      </div>
      <div class="table-wrap"><table><thead><tr><th>증서번호</th><th>구분</th><th>성명</th><th>소속</th><th>과정</th><th>명의</th><th>발급일</th><th>상태</th><th></th></tr></thead><tbody id="tbody"></tbody></table></div>
    </div>`;
  const draw = () => {
    const qv = $('#fq').value.trim(), kv = $('#fk').value, sv = $('#fs').value;
    const list = items.filter((c) => (!qv || c.holder_name.includes(qv) || c.cert_no.includes(qv.toUpperCase())) && (!kv || c.kind === kv)
      && (!sv || (sv === 'valid' ? !c.revoked_at : !!c.revoked_at)));
    $('#cnt').textContent = `${list.length}건`;
    $('#tbody').innerHTML = list.map((c) => `<tr data-id="${c.id}"><td class="num">${esc(c.cert_no)}</td><td>${c.kind === 'final' ? '<span class="badge ok">전 과정</span>' : '<span class="badge">과정</span>'}</td>
      <td><b>${esc(c.holder_name)}</b></td><td>${esc(c.holder_dept || '')}</td><td class="wrap">${esc(c.title)}</td><td class="small">${esc(c.company_name)}<br>대표이사 ${esc(c.ceo_name)}</td>
      <td class="small">${fmtDate(c.issued_at)}</td><td>${c.revoked_at ? `<span class="badge bad" title="${fmtDateTime(c.revoked_at)}">효력정지</span>` : '<span class="badge ok">유효</span>'}</td>
      <td><div class="row" style="flex-wrap:nowrap"><a class="btn sm" target="_blank" href="/certificate?no=${esc(c.cert_no)}">보기·출력</a>
        ${c.revoked_at ? '<button class="btn sm" data-act="restore">복구</button>' : '<button class="btn sm" data-act="reissue">재발급</button><button class="btn sm danger" data-act="revoke">효력정지</button>'}</div></td></tr>`).join('')
      || '<tr><td colspan="9" class="empty">수료증이 없습니다.</td></tr>';
  };
  ['fq', 'fk', 'fs'].forEach((id) => $(`#${id}`).addEventListener('input', draw)); draw();
  $('#exp').onclick = () => downloadCsv(`수료증_발급대장_${today()}.csv`, [['증서번호', '구분', '성명', '사번', '소속', '직급', '과정', '회사', '대표이사', '발급일', '상태'],
    ...items.map((c) => [c.cert_no, c.kind === 'final' ? '전 과정' : '과정', c.holder_name, c.emp_no, c.holder_dept, c.holder_position, c.title, c.company_name, c.ceo_name, fmtDate(c.issued_at), c.revoked_at ? '효력정지' : '유효'])]);
  $('#tbody').onclick = async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const c = items.find((x) => x.id === Number(btn.closest('tr').dataset.id));
    const msg = { revoke: `${c.cert_no} 수료증의 효력을 정지할까요?`, restore: `${c.cert_no} 수료증을 복구할까요?`, reissue: `${c.cert_no}를 효력정지하고 현재 설정(회사명·대표이사)으로 새 번호를 발급할까요?\n(대표이사 변경, 성명·소속 변경 시 사용)` }[btn.dataset.act];
    if (!await confirmModal(msg, '확인', btn.dataset.act === 'revoke')) return;
    try { const r = await api('POST', `/api/admin/certificates/${c.id}/${btn.dataset.act}`, {}); toast(r.cert_no ? `새 증서번호 ${r.cert_no} 발급` : '처리했습니다.'); views.certificates(); } catch (err) { toast(err.message, 'error'); }
  };
};

// ===================== 설정 =====================
views.settings = async () => {
  const [s, mail] = await Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/admin/mail/config')]);
  page.innerHTML = `
    <div class="page-head"><h1>설정</h1></div>
    ${s.sample_loaded === '1' ? '<div class="alert info" style="max-width:860px">샘플 데이터가 들어 있습니다. 실제 운영 전에 지워 주세요. <button class="btn sm" id="clearSample" style="margin-left:8px">샘플 지우기</button></div>' : ''}
    <form class="card card-pad" id="sf" style="display:grid;gap:18px;max-width:860px">
      <h3>수료증 명의</h3>
      <div class="form-grid">
        <label class="field">회사명<input name="company_name" value="${esc(s.company_name)}"></label>
        <label class="field">대표이사 성명<input name="ceo_name" value="${esc(s.ceo_name)}"></label>
        <div class="field full"><span>대표이사 직인</span><span class="hint">PNG(배경 투명) 권장, 1MB 이하. 미등록 시 대표이사 이름으로 붉은 원형 인장을 자동 생성합니다.</span>
          <div class="row"><div class="seal-preview" id="sealPrev">${s.seal_image ? `<img src="${esc(s.seal_image)}" alt="직인">` : '<span class="small muted">자동 생성</span>'}</div>
            <input type="file" id="sealFile" accept="image/png,image/jpeg,image/svg+xml" style="width:auto"><button type="button" class="btn sm" id="sealClear">직인 삭제</button></div></div>
        <label class="field full">수료증 문구<textarea name="cert_statement">${esc(s.cert_statement)}</textarea></label>
      </div>
      <h3>교육 운영</h3>
      <div class="form-grid">
        <label class="field">운영 연도<span class="hint">대시보드·이수율·교육생 화면에 표시되는 연도</span><input name="edu_year" type="number" value="${esc(s.edu_year)}"></label>
        <label class="field">문의처 (알림에 표시)<input name="manager_contact" value="${esc(s.manager_contact)}"></label>
        <label class="field full">직원 접속 주소<span class="hint">독촉 메일의 ‘교육 바로가기’에 들어갑니다. 비워 두면 이 PC 주소(localhost)가 들어가 다른 사람은 열 수 없습니다.</span><input name="public_url" value="${esc(s.public_url)}" placeholder="예: http://192.168.0.10:3000"></label>
        <label class="check"><input type="checkbox" name="auto_remind" ${s.auto_remind === '1' ? 'checked' : ''}> 미이수자 자동 독촉 (사내 알림 + 메일)</label>
        <label class="field">마감 전 독촉 일정 (D-n일, 마감 당일은 항상 발송)<input name="remind_days" value="${esc(s.remind_days)}" placeholder="10,5,3,1"></label>
        <label class="check full"><input type="checkbox" name="overdue_weekly" ${s.overdue_weekly === '1' ? 'checked' : ''}> 마감 후에도 12/31까지 매주 독촉 (D+1, D+8, D+15 …)</label>
      </div>
      <div class="row"><button class="btn primary">저장</button></div>
    </form>
    <form class="card card-pad" id="mf" style="display:grid;gap:14px;max-width:860px">
      <div class="row"><h3>메일 연결</h3>${mail.configured ? '<span class="badge ok">연결됨</span>' : '<span class="badge">미연결</span>'}</div>
      <p class="small muted" style="margin:0">독촉 메일을 보낼 계정입니다. Gmail·구글 워크스페이스는 평소 비밀번호가 아니라 <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">앱 비밀번호</a>(16자리)를 넣어야 합니다. 2단계 인증이 켜져 있어야 만들 수 있습니다.</p>
      <div class="form-grid">
        <label class="field">메일 서버<input name="host" value="${esc(mail.host || 'smtp.gmail.com')}"></label>
        <label class="field">포트<span class="hint">Gmail은 465</span><input name="port" type="number" value="${esc(mail.host ? mail.port : 465)}"></label>
        <label class="field">메일 계정<input name="user" type="email" autocomplete="off" value="${esc(mail.user)}" placeholder="hr@회사.com"></label>
        <label class="field">메일 비밀번호<span class="hint">${mail.has_password ? '저장되어 있습니다. 바꿀 때만 입력하세요.' : '이 PC의 .env 파일에만 저장됩니다.'}</span><input name="pass" type="password" autocomplete="new-password"></label>
        <label class="field">보내는 주소<span class="hint">비워 두면 메일 계정과 같습니다</span><input name="from" value="${esc(mail.from)}"></label>
        <label class="field">보내는 이름<input name="from_name" value="${esc(mail.from_name)}"></label>
      </div>
      <div class="row"><button class="btn primary">메일 설정 저장</button><button type="button" class="btn" id="mailTest" ${mail.configured ? '' : 'disabled'}>테스트 메일 보내기</button></div>
    </form>`;
  if ($('#clearSample')) $('#clearSample').onclick = () => clearSample();
  $('#mf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/admin/mail/config', Object.fromEntries(new FormData(e.target))); toast('메일 설정을 저장했습니다. 테스트 메일로 확인해 보세요.'); views.settings(); } catch (err) { toast(err.message, 'error'); }
  };
  $('#mailTest').onclick = async (e) => {
    const to = prompt('테스트 메일을 받을 주소', $('#mf').user.value); if (!to) return;
    e.target.disabled = true;
    try { await api('POST', '/api/admin/mail/test', { to }); toast('테스트 메일을 보냈습니다. 받은편지함을 확인하세요.'); } catch (err) { toast(err.message, 'error'); }
    e.target.disabled = false;
  };
  let seal = s.seal_image;
  $('#sealFile').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 1024 * 1024) return toast('1MB 이하 이미지만 등록할 수 있습니다.', 'error');
    const rd = new FileReader();
    rd.onload = () => { seal = rd.result; $('#sealPrev').innerHTML = `<img src="${esc(seal)}" alt="직인">`; };
    rd.readAsDataURL(f);
  };
  $('#sealClear').onclick = () => { seal = ''; $('#sealPrev').innerHTML = '<span class="small muted">자동 생성</span>'; };
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.auto_remind = e.target.auto_remind.checked ? '1' : '0';
    f.overdue_weekly = e.target.overdue_weekly.checked ? '1' : '0';
    f.seal_image = seal;
    try { await api('PUT', '/api/admin/settings', f); toast('저장했습니다. 새로 발급되는 수료증부터 적용됩니다.'); } catch (err) { toast(err.message, 'error'); }
  };
};

// ===================== 라우팅 =====================
async function route() {
  const tab = (location.hash.slice(1) || 'dashboard');
  const view = views[tab] || views.dashboard;
  $$('aside a[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  page.innerHTML = '<div class="empty">불러오는 중…</div>';
  page.onclick = null;
  try { await view(); } catch (e) { page.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}
(async () => {
  const me = await requireUser('admin');
  $('#who').textContent = `${me.user.name} (${me.user.login_id})`;
  $('#pwBtn').onclick = () => passwordChangeModal();
  // 과정이나 명부가 아직 없으면 시작하기 화면부터 보여 준다
  if (!location.hash) { const st = await api('GET', '/api/admin/start'); if (!st.courses || !st.learners) location.hash = '#start'; }
  window.addEventListener('hashchange', route);
  route();
})().catch((e) => e.message !== 'redirect' && toast(e.message, 'error'));
