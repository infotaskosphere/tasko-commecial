'use strict';

/**
 * pairing.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Connects this computer to a Taskosphere account without a login in the agent:
 *
 *   1. POST /api/desktop/pair/start      → { code, claim_token }
 *   2. open <web app>/agent/pair?code=…  → the signed-in user clicks Connect
 *   3. POST /api/desktop/pair/claim       → { status: 'approved', token, … }
 *
 * The browser never calls the agent on 127.0.0.1, so there is no
 * "allow access to devices on your local network" prompt.
 */

const https  = require('https');
const http   = require('http');
const { spawn } = require('child_process');
const config = require('../config');

function requestJson(method, pathname, body) {
  return new Promise((resolve, reject) => {
    let base = config.BACKEND_URL;
    if (!base.startsWith('http')) base = 'https://' + base;
    const url = new URL(pathname, base);
    const isHttps = url.protocol === 'https:';
    const data = body ? JSON.stringify(body) : '';
    const req = (isHttps ? https : http).request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    // Free hosting can take ~a minute to wake up.
    req.setTimeout(60000, () => req.destroy(new Error('Request timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function begin({ agentId, machineName, version, osUser }) {
  const res = await requestJson('POST', '/api/desktop/pair/start', {
    agent_id: agentId, machine_name: machineName, agent_version: version, os_user: osUser || '',
  });
  if (res.status !== 200 || !res.data || !res.data.code) {
    throw new Error(`Taskosphere did not start pairing (HTTP ${res.status})`);
  }
  return res.data; // { code, claim_token, expires_in }
}

function pairUrl(code) {
  return `${config.FRONTEND_URL.replace(/\/+$/, '')}/agent/pair?code=${encodeURIComponent(code)}`;
}

/**
 * Poll until the user connects the computer in the browser.
 * Resolves { token, user_id, user_name, device_id } or null (expired/cancelled).
 */
async function waitForApproval(pairing, { intervalMs = 3000, isCancelled = () => false } = {}) {
  const deadline = Date.now() + (pairing.expires_in || 900) * 1000;
  while (Date.now() < deadline && !isCancelled()) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const res = await requestJson('POST', '/api/desktop/pair/claim', { code: pairing.code, claim_token: pairing.claim_token });
      if (res.status === 404) return null; // expired
      if (res.status === 200 && res.data && res.data.status === 'approved' && res.data.token) return res.data;
    } catch {
      // offline for a moment: keep trying until the code expires
    }
  }
  return null;
}

/** Open a web page in the user's default browser (no shell, so '&' in URLs is safe). */
function openUrl(url) {
  if (process.env.TASKOSPHERE_AGENT_NO_BROWSER === '1') {
    console.log('[pairing] Would open:', url);
    return;
  }
  try {
    const opts = { detached: true, stdio: 'ignore', windowsHide: true };
    if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], opts).unref();
    else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
    else spawn('xdg-open', [url], opts).unref();
  } catch (e) {
    console.warn('[pairing] Could not open the browser:', e.message);
  }
}

module.exports = { begin, pairUrl, waitForApproval, openUrl, requestJson };
