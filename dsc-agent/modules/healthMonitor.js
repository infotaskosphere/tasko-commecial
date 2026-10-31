'use strict';

/**
 * healthMonitor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Monitors agent health and sends heartbeats to the backend.
 *
 * Features:
 *   - CPU and memory usage tracking
 *   - Heartbeat every 30 seconds
 *   - Automatic recovery detection
 *   - Internet connectivity check
 */

const os     = require('os');
const https  = require('https');
const http   = require('http');
const config = require('../config');

// ── State ────────────────────────────────────────────────────────────────────
let isRunning         = false;
let heartbeatTimer    = null;
let internetOk        = true;
let startTime         = Date.now();
let lastHeartbeat     = null;
let consecutiveFails  = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type of Object.values(cpu.times)) totalTick += type;
    totalIdle += cpu.times.idle;
  }
  return +((1 - totalIdle / totalTick) * 100).toFixed(1);
}

function getMemUsageMb() {
  const used = process.memoryUsage();
  return Math.round(used.rss / 1024 / 1024);
}

function checkInternet() {
  return new Promise((resolve) => {
    const req = https.get('https://www.google.com', { timeout: 5000 }, (res) => {
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

async function sendHeartbeat(agentId, machineName, agentVersion, token, userId) {
  internetOk = await checkInternet();
  if (!internetOk) {
    consecutiveFails++;
    console.log('[health] No internet — heartbeat skipped');
    return false;
  }

  const payload = {
    agent_id:           agentId,
    user_id:            userId || null,
    machine_name:       machineName,
    hostname:           os.hostname(),
    platform:           process.platform,
    agent_version:      agentVersion,
    os_version:         os.type() + ' ' + os.release(),
    cpu_usage:          getCpuUsage(),
    mem_usage_mb:       getMemUsageMb(),
    uptime_seconds:     Math.round((Date.now() - startTime) / 1000),
    internet_connected: true,
    last_activity_at:   new Date().toISOString(),
  };

  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    let baseUrl = config.BACKEND_URL;
    if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
    const url = new URL('/api/desktop/agent/heartbeat', baseUrl);
    const isHttps = url.protocol === 'https:';

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      if (res.statusCode === 401 && token && onUnauthorized) {
        try { onUnauthorized(); } catch {}
      }
      let buf = '';
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => {
        consecutiveFails = 0;
        lastHeartbeat = new Date().toISOString();
        resolve(true);
      });
    });

    req.on('error', (err) => {
      consecutiveFails++;
      console.error('[health] Heartbeat failed:', err.message);
      resolve(false);
    });

    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

// Called when the backend answers 401 (the computer was disconnected).
let onUnauthorized = null;
function setOnUnauthorized(fn) { onUnauthorized = fn; }

// ── Public API ───────────────────────────────────────────────────────────────

function start(agentId, machineName, agentVersion, getToken, getUserId, intervalMs = 30000) {
  if (isRunning) return;
  isRunning = true;
  startTime = Date.now();

  heartbeatTimer = setInterval(async () => {
    const token  = typeof getToken  === 'function' ? getToken()  : getToken;
    const userId = typeof getUserId === 'function' ? getUserId() : getUserId;
    await sendHeartbeat(agentId, machineName, agentVersion, token, userId);
  }, intervalMs);

  console.log('[health] Monitor started (heartbeat every', intervalMs / 1000, 's)');
}

function stop() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  isRunning = false;
}

function getStatus() {
  return {
    internetOk,
    consecutiveFails,
    lastHeartbeat,
    uptime_seconds: Math.round((Date.now() - startTime) / 1000),
    cpu_usage:      getCpuUsage(),
    mem_usage_mb:   getMemUsageMb(),
  };
}

module.exports = { start, stop, getStatus, checkInternet, sendHeartbeat, setOnUnauthorized };
