// 전체 검증 — 임시 폴더와 별도 포트로 서버를 띄우므로 실제 운영 데이터(data/)와 .env를 건드리지 않는다.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = '3199';
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-test-'));
const VIDEO = path.join(ROOT, 'public', 'videos', '_test.mp4');
const DOC = path.join(ROOT, 'public', 'docs', '_test.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(env, fn) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, LMS_NO_DOTENV: '1', LMS_ENV_FILE: path.join(tmp, 'test.env'), ...env },
  });
  try {
    for (let i = 0; ; i++) {
      try { await (await fetch(BASE)).text(); break; } catch { if (i > 50) throw new Error('LMS 서버가 시작되지 않았습니다.'); await sleep(200); }
    }
    return await fn();
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
}
const runScript = (file, ...args) => spawnSync(process.execPath, [path.join(__dirname, file), ...args], { stdio: 'inherit', env: { ...process.env, LMS_TEST_BASE: BASE, LMS_TEST_TMP: tmp } }).status;

(async () => {
  fs.mkdirSync(path.dirname(VIDEO), { recursive: true });
  fs.mkdirSync(path.dirname(DOC), { recursive: true });
  fs.writeFileSync(VIDEO, ''); fs.writeFileSync(DOC, '<!doctype html><p>test</p>');
  let failed = 0;
  try {
    const main = path.join(tmp, 'main');
    const seeded = { LMS_DATA_DIR: main, ADMIN_PASSWORD: 'admin1234!', SEED_DEMO: '1' };
    failed += await withServer({ ...seeded, SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: '0', SMTP_FROM: 'hr-test@example.com' }, () => runScript('scenarios.js')) ? 1 : 0;
    failed += await withServer({ ...seeded, LMS_FAKE_TODAY: `${new Date().getFullYear() + 1}-01-02` }, () => runScript('scenarios.js', '--year-end')) ? 1 : 0;
    failed += await withServer({ LMS_DATA_DIR: path.join(tmp, 'setup-empty') }, () => runScript('setup-flow.js', 'empty')) ? 1 : 0;
    failed += await withServer({ LMS_DATA_DIR: path.join(tmp, 'setup-sample') }, () => runScript('setup-flow.js', 'sample')) ? 1 : 0;
  } finally {
    fs.rmSync(VIDEO, { force: true }); fs.rmSync(DOC, { force: true });
    fs.rmSync(path.join(__dirname, 'phase1-ids.json'), { force: true });
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(failed ? `\n실패한 단계가 ${failed}개 있습니다.` : '\n전체 통과');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
