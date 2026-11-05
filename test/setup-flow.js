// 처음 받은 사람의 흐름 검증: 설정 마법사 → 파일 올리기 → 메일 연결 → 샘플 지우기. test/run.js가 빈 데이터로 서버를 띄운 뒤 실행한다.
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.LMS_TEST_BASE;
const ENV_FILE = path.join(process.env.LMS_TEST_TMP, 'test.env');
const UPLOADED = path.join(__dirname, '..', 'public', 'videos', '_upload-test.mp4');
const mode = process.argv[2];
let pass = 0, fail = 0;
function check(id, title, expected, actual, ok) {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}\n      기대: ${expected}\n      실제: ${actual}`);
}
let cookie = '';
async function call(method, url, body, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
}
const SETUP = { company_name: '테스트컴퍼니', ceo_name: '홍길동', manager_contact: '인사팀', password: 'Setup1234' };

async function empty() {
  const st = await call('GET', '/api/setup');
  const me = await call('GET', '/api/me');
  check('W-01', '처음 실행', '설정 필요, 관리자 없음, 기본 비밀번호로 로그인 불가', `needed ${st.j.needed} / me ${me.status}`, st.j.needed === true && me.status === 401);
  const defaultLogin = await call('POST', '/api/login', { login_id: 'admin', password: 'admin1234!' });
  check('W-02', '기본 관리자 비밀번호', '존재하지 않음(401)', String(defaultLogin.status), defaultLogin.status === 401);
  const remote = await call('POST', '/api/setup', SETUP, { 'X-Forwarded-For': '203.0.113.5' });
  check('W-03', '터널·다른 PC에서 설정 시도', '거부(403)', String(remote.status), remote.status === 403);
  const weak = await call('POST', '/api/setup', { ...SETUP, password: '1234' });
  check('W-04', '약한 관리자 비밀번호', '거부(400)', String(weak.status), weak.status === 400);
  const noName = await call('POST', '/api/setup', { ...SETUP, company_name: '' });
  check('W-05', '회사명 없이 설정', '거부(400)', String(noName.status), noName.status === 400);
  const ok = await call('POST', '/api/setup', SETUP);
  const again = await call('POST', '/api/setup', { ...SETUP, password: 'Other1234' });
  check('W-06', '설정 완료 후 다시 설정 시도', '처음 200 + 관리자 로그인, 두 번째 409', `${ok.status} ${ok.j.user?.role} / ${again.status}`, ok.status === 200 && ok.j.user?.role === 'admin' && !ok.j.user?.must_change_pw && again.status === 409);
  const start = (await call('GET', '/api/admin/start')).j;
  check('W-07', '빈 상태로 시작', '과정 0, 교육생 0, 회사명 저장', `과정 ${start.courses} / 교육생 ${start.learners} / ${start.company_name}`, start.courses === 0 && start.learners === 0 && start.company_name === SETUP.company_name);

  // 파일 올리기
  const up = (name, headers = {}, body = Buffer.from('fake-video-bytes')) => fetch(`${BASE}/api/admin/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie, ...headers }, body });
  const noAuth = await up('_upload-test.mp4', { cookie: '' });
  const badExt = await up('_upload-test.exe');
  check('W-08', '로그인 없이 업로드 / 허용되지 않는 형식', '401 / 400', `${noAuth.status} / ${badExt.status}`, noAuth.status === 401 && badExt.status === 400);
  const good = await up('../../_upload-test.mp4');
  const goodJ = await good.json();
  const anon = await fetch(`${BASE}${goodJ.url}`);
  const authed = await fetch(`${BASE}${goodJ.url}`, { headers: { cookie, Range: 'bytes=0-3' } });
  const dup = await up('_upload-test.mp4');
  check('W-09', '영상 올리기', '경로 조작 무시, 비로그인 401, 로그인 206, 같은 이름 409', `${goodJ.url} / ${anon.status} / ${authed.status} / ${dup.status}`,
    good.status === 200 && goodJ.url === '/videos/_upload-test.mp4' && fs.existsSync(UPLOADED) && anon.status === 401 && authed.status === 206 && dup.status === 409);
  await anon.body?.cancel(); await authed.body?.cancel();
  fs.rmSync(UPLOADED, { force: true });

  // 메일 연결
  const bad = await call('PUT', '/api/admin/mail/config', { host: '', user: 'hr@example.com', pass: 'x' });
  const saved = await call('PUT', '/api/admin/mail/config', { host: 'smtp.example.com', port: 465, user: 'hr@example.com', pass: 'abcd efgh ijkl mnop', from_name: '인사팀' });
  const cfg = (await call('GET', '/api/admin/mail/config')).j;
  const env = fs.readFileSync(ENV_FILE, 'utf8');
  check('W-10', '화면에서 메일 연결', '서버 주소 없으면 400, 저장 시 공백 제거해 .env에 기록, 화면에 비밀번호 미노출', `${bad.status} / ${saved.status} / 응답에 비밀번호 ${JSON.stringify(cfg).includes('abcd') ? '있음' : '없음'}`,
    bad.status === 400 && saved.status === 200 && env.includes('SMTP_PASS=abcdefghijklmnop') && !JSON.stringify(cfg).includes('abcd') && cfg.has_password === true && cfg.configured === true);
  const kept = await call('PUT', '/api/admin/mail/config', { host: 'smtp.example.com', port: 465, user: 'hr@example.com', from_name: '인사팀' });
  check('W-11', '비밀번호를 비우고 다시 저장', '기존 비밀번호 유지', String(kept.status), kept.status === 200 && fs.readFileSync(ENV_FILE, 'utf8').includes('SMTP_PASS=abcdefghijklmnop'));
  const noUrl = await call('PUT', '/api/admin/settings', { public_url: 'lms.example.com' });
  const url = await call('PUT', '/api/admin/settings', { public_url: 'http://192.168.0.10:3000' });
  check('W-12', '직원 접속 주소 설정', '형식 오류 400, 정상 200', `${noUrl.status} / ${url.status}`, noUrl.status === 400 && url.status === 200);
}

async function sample() {
  const ok = await call('POST', '/api/setup', { ...SETUP, sample: true });
  const start = (await call('GET', '/api/admin/start')).j;
  const settings = (await call('GET', '/api/admin/settings')).j;
  check('W-13', '샘플로 시작', '샘플 교육생 11명, 실제 교육생·과정 0으로 집계, 자동 독촉 꺼짐', `${ok.status} / 샘플 ${start.sample_learners} / 실제 ${start.learners} / 과정 ${start.courses} / 독촉 ${settings.auto_remind}`,
    ok.status === 200 && start.sample_loaded && start.sample_learners === 11 && start.learners === 0 && start.courses === 0 && settings.auto_remind === '0');
  const courses = (await call('GET', '/api/admin/courses')).j.items;
  check('W-14', '샘플 과정', '유튜브 영상 차시 1개', `${courses.length}개 / ${courses[0]?.lessons[0]?.url}`, courses.length === 1 && /youtu/.test(courses[0].lessons[0].url));
  const real = await call('POST', '/api/admin/users', { name: '실제직원', email: 'real.person@company.test', phone: '010-1234-5678', department: '인사팀' });
  const cleared = await call('POST', '/api/admin/sample/clear', {});
  const after = (await call('GET', '/api/admin/start')).j;
  const afterCourses = (await call('GET', '/api/admin/courses')).j.items;
  const afterSettings = (await call('GET', '/api/admin/settings')).j;
  check('W-15', '샘플 지우기', '샘플 11명·과정 1개 삭제, 실제 직원 유지, 자동 독촉 켜짐', `${real.status} / 삭제 ${cleared.j.users}명·${cleared.j.courses}개 / 남은 실제 ${after.learners}명 / 과정 ${afterCourses.length} / 독촉 ${afterSettings.auto_remind}`,
    cleared.j.users === 11 && cleared.j.courses === 1 && after.learners === 1 && after.sample_learners === 0 && !after.sample_loaded && afterCourses.length === 0 && afterSettings.auto_remind === '1');
}

(mode === 'sample' ? sample() : empty()).then(() => {
  console.log(`\n결과: ${pass}/${pass + fail} 통과 (${mode})`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
