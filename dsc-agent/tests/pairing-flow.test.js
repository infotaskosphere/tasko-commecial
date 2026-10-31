'use strict';

// End-to-end: the real agent against a mock Taskosphere backend.
//   node --test tests/
const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawn } = require('child_process');

const AGENT = path.join(__dirname, '..', 'agent.js');

function mockBackend() {
  const calls = [];
  const state = { approveAfter: 2, claims: 0, rejectDevice: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      calls.push({ method: req.method, url: req.url, auth, body });
      const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/api/desktop/pair/start') return json(200, { code: 'ABCD2345', claim_token: 'c'.repeat(43), expires_in: 60 });
      if (req.url === '/api/desktop/pair/claim') {
        state.claims += 1;
        if (state.claims < state.approveAfter) return json(200, { status: 'pending' });
        return json(200, { status: 'approved', token: 'tsa_device-token', user_id: 'u1', user_name: 'Manthan Desai', device_id: 'd1' });
      }
      if (auth === 'Bearer tsa_device-token' && state.rejectDevice) return json(401, { detail: 'Could not validate credentials' });
      return json(200, { ok: true });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, state, port: server.address().port })));
}

function startAgent(env) {
  const child = spawn(process.execPath, [AGENT], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, output: () => out };
}

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timed out');
}

async function stop(agent) {
  agent.child.kill('SIGTERM');
  await new Promise((r) => agent.child.once('exit', r));
}

test('pairs once, keeps working after a restart, and asks again when disconnected', { timeout: 90000 }, async () => {
  const backend = await mockBackend();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsa-'));
  const env = {
    TASKOSPHERE_BACKEND_URL: `http://127.0.0.1:${backend.port}`,
    TASKOSPHERE_FRONTEND_URL: 'https://app.test',
    TASKOSPHERE_AGENT_DATA_DIR: dataDir,
    TASKOSPHERE_AGENT_NO_BROWSER: '1',
    TASKOSPHERE_AGENT_TRAY_KEY: 'k'.repeat(48),
  };
  const trayState = () => fetch('http://127.0.0.1:7432/tray/state?format=lines', { headers: { 'X-Tray-Key': 'k'.repeat(48) } })
    .then((r) => r.text()).then((t) => Object.fromEntries(t.split('\n').map((l) => l.split('\t'))));
  const credFile = path.join(dataDir, 'credential.json');

  // 1. First start: no credential → pairing, browser page, approval, saved.
  let agent = startAgent(env);
  try {
    await waitFor(() => fs.existsSync(credFile));
    const saved = JSON.parse(fs.readFileSync(credFile, 'utf8'));
    assert.equal(saved.token, 'tsa_device-token');
    assert.equal(saved.user_id, 'u1');
    assert.match(agent.output(), /Would open: https:\/\/app\.test\/agent\/pair\?code=ABCD2345/);
    // Reports go out with the device credential.
    await waitFor(() => backend.calls.some((c) => c.url === '/api/desktop/system' && c.auth === 'Bearer tsa_device-token'));
    // The web app pushing a browser session does not replace the device credential.
    const pushed = await fetch('http://127.0.0.1:7432/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'browser-jwt', user_id: 'u1' }),
    }).then((r) => r.json());
    assert.match(pushed.message, /own credential/);
    // Tray routes need the per-run key; with it the icon shows who is connected.
    assert.equal((await fetch('http://127.0.0.1:7432/tray/state')).status, 403);
    const shown = await trayState();
    assert.equal(shown.connected, 'true');
    assert.equal(shown.status_text, 'Connected as Manthan Desai');
    assert.equal(shown.notice_title, 'Taskosphere Agent connected');
    // A log file is written (the agent has no window).
    assert.ok(fs.readFileSync(path.join(dataDir, 'agent.log'), 'utf8').includes('Connected (device)'));
  } finally {
    await stop(agent);
  }

  // 2. Restart: uses the saved credential, no new pairing.
  const pairStarts = backend.calls.filter((c) => c.url === '/api/desktop/pair/start').length;
  const systemBefore = backend.calls.filter((c) => c.url === '/api/desktop/system').length;
  agent = startAgent(env);
  try {
    await waitFor(() => backend.calls.filter((c) => c.url === '/api/desktop/system').length > systemBefore);
    assert.equal(backend.calls.filter((c) => c.url === '/api/desktop/pair/start').length, pairStarts);

    // 3. Disconnected from Settings: the backend rejects the credential → it is
    //    cleared and the agent asks to connect again.
    backend.state.rejectDevice = true;
    backend.state.claims = -1000; // keep the new pairing pending
    await fetch('http://127.0.0.1:7432/sync', { method: 'POST' });
    await waitFor(() => !fs.existsSync(credFile));
    assert.match(agent.output(), /disconnected from Taskosphere/);
    const after = await trayState();
    assert.equal(after.connected, 'false');
    assert.equal(after.notice_title, 'Taskosphere Agent was disconnected');
    // "Connect to Taskosphere" in the tray starts pairing again and opens the browser.
    await fetch('http://127.0.0.1:7432/tray/command', { method: 'POST', headers: { 'X-Tray-Key': 'k'.repeat(48), 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'connect' }) });
    await waitFor(() => (agent.output().match(/Would open: https:\/\/app\.test\/agent\/pair/g) || []).length >= 1);
    assert.equal((await trayState()).connected, 'false');
  } finally {
    await stop(agent);
    backend.server.close();
  }
});
