'use strict';

/**
 * agent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Taskosphere Agent — Main Entry Point (Enterprise Edition)
 *
 * Integrates all modules into a unified agent:
 *
 *   1. EXPRESS SERVER — Local HTTP API (backward compatible with v3)
 *   2. ACTIVITY TRACKER — Active window monitoring (existing)
 *   3. BROWSER TRACKER — Chrome/Edge/Firefox tracking (new)
 *   4. DSC WATCHER — Smart card detection (existing, enhanced)
 *   5. USB MONITOR — Device connect/disconnect events (new)
 *   6. IDLE DETECTOR — User idle time detection (new)
 *   7. PRODUCTIVITY ENGINE — Metrics computation (new)
 *   8. HEALTH MONITOR — Heartbeat and health tracking (new)
 *   9. NOTIFICATION RECEIVER — Backend → Desktop notifications (new)
 *  10. OFFLINE QUEUE — SQLite queue for offline mode (new)
 *  11. AUTO UPDATER — Version check and silent update (new)
 *  12. SYSTEM TRAY — Windows tray icon and menu (new)
 *  13. WINDOWS SERVICE — Auto-start with Windows (new)
 *
 * Design principles:
 *   - Silent background execution
 *   - No console window, no splash, no taskbar
 *   - Low CPU (<2%), Low RAM (<100MB)
 *   - Automatic recovery after crash/sleep/hibernate/reconnect
 *   - All modules independently recoverable
 */

const express         = require('express');
const cors            = require('cors');
const os              = require('os');
const path            = require('path');
const crypto          = require('crypto');

// ── Command-line flag handling (for NSIS installer) ──────────────────────────
const args = process.argv.slice(2);

// The packaged .exe has no `node` on PATH, so call service.js in-process.
if (args.includes('--install-service') || args.includes('--uninstall-service')) {
  const service = require('./service');
  try {
    if (args.includes('--install-service')) service.installService();
    else service.removeService();
    process.exit(0);
  } catch (err) {
    console.error('[agent] Service command failed:', err.message);
    process.exit(1);
  }
}

// No console window in normal use: keep a log file for support.
require('./modules/logger').install();

const { readCertFromPcSc } = require('./pcscReader');
const dscWatcher           = require('./dscWatcher');
const activityTracker      = require('./activityTracker');
const config               = require('./config');
const apiClient            = require('./apiClient');

// ── New modules ──────────────────────────────────────────────────────────────
const browserTracker       = require('./modules/browserTracker');
const usbMonitor           = require('./modules/usbMonitor');
const idleDetector         = require('./modules/idleDetector');
const productivityEngine   = require('./modules/productivityEngine');
const healthMonitor        = require('./modules/healthMonitor');
const notificationReceiver = require('./modules/notificationReceiver');
const offlineQueue         = require('./modules/offlineQueue');
const autoUpdater          = require('./modules/autoUpdater');
const systemInfo           = require('./modules/systemInfo');
const tray                 = require('./modules/tray');
const credentials          = require('./modules/credentials');
const pairing              = require('./modules/pairing');

// ── Constants ────────────────────────────────────────────────────────────────
const PORT         = config.AGENT_PORT;
const AGENT_VERSION = require('./package.json').version;
const AGENT_ID     = crypto
  .createHash('sha256')
  .update(os.hostname() + '|' + os.platform() + '|' + (os.cpus()[0]?.model || ''))
  .digest('hex')
  .slice(0, 16);

// ── Auth state (shared across modules) ───────────────────────────────────────
let authToken = null;
let authUserId = null;
// 'device' = this computer's own credential from pairing (survives restarts and
// new web logins); 'web' = a browser session pushed by the web app (legacy).
let authSource = null;
let monitoringStarted = false;

function getToken() { return authToken; }

// What the tray icon shows.
const connection = {
  state: 'starting',        // starting | connected | pairing | not_connected
  userName: null,
  pairUrl: null,
  notice: null,             // latest balloon { id, title, text }
};
let pairingRun = 0;         // increases to cancel an older pairing poll

function notify(title, text) {
  connection.notice = { id: String(Date.now()), title, text };
}

/** Give every module the credential and start the ones that need it. */
function applyAuth(token, userId, source) {
  authToken  = token;
  authUserId = userId;
  authSource = source;

  activityTracker.setAuth(token, userId);
  notificationReceiver.setAuth(token, userId);
  autoUpdater.setAuth(token);

  if (!monitoringStarted) {
    monitoringStarted = true;
    try {
      healthMonitor.start(AGENT_ID, os.hostname(), AGENT_VERSION, getToken, () => authUserId, 30000);
    } catch (e) {
      console.warn('[agent] Health monitor could not start:', e.message);
    }
    try {
      notificationReceiver.start(60000);
    } catch (e) {
      console.warn('[agent] Notification receiver could not start:', e.message);
    }
    try {
      autoUpdater.start(3600000); // check every hour
    } catch (e) {
      console.warn('[agent] Auto updater could not start:', e.message);
    }
  }

  try {
    const sysInfo = systemInfo.getSystemInfo(AGENT_VERSION);
    apiClient.post('/api/desktop/system', { agent_id: AGENT_ID, ...sysInfo }, token).catch(() => {});
  } catch {}
  console.log(`[agent] Connected (${source}) — monitoring active`);
}

function clearAuth() {
  authToken = null;
  authUserId = null;
  authSource = null;
  try { activityTracker.setAuth(null, null); } catch {}
  try { notificationReceiver.setAuth(null, null); } catch {}
  try { autoUpdater.setAuth(null); } catch {}
}

/** Use the credential saved by an earlier pairing, if any. */
function connectFromSavedCredential() {
  const saved = credentials.load();
  if (!saved) return false;
  applyAuth(saved.token, saved.user_id, 'device');
  connection.state = 'connected';
  connection.userName = saved.user_name || null;
  return true;
}

/**
 * Connect this computer to a Taskosphere account (no login in the agent):
 * opens the browser on the confirmation page and waits for the user's click.
 */
async function startPairing({ openBrowser }) {
  if (connection.state === 'pairing' && connection.pairUrl) {
    if (openBrowser) pairing.openUrl(connection.pairUrl);
    return;
  }
  const run = ++pairingRun;
  connection.state = 'pairing';
  connection.pairUrl = null;
  let started;
  try {
    started = await pairing.begin({
      agentId: AGENT_ID, machineName: os.hostname(), version: AGENT_VERSION,
      osUser: (() => { try { return os.userInfo().username; } catch { return ''; } })(),
    });
  } catch (e) {
    console.warn('[pairing] Could not reach Taskosphere:', e.message);
    connection.state = 'not_connected';
    notify('Taskosphere Agent is not connected', 'Could not reach Taskosphere. Check the internet connection, then click here to try again.');
    return;
  }
  if (run !== pairingRun) return;
  connection.pairUrl = pairing.pairUrl(started.code);
  console.log('[pairing] Waiting for approval:', connection.pairUrl);
  if (openBrowser) {
    pairing.openUrl(connection.pairUrl);
    credentials.saveState({ last_auto_open_at: Date.now() });
  }
  notify('Connect Taskosphere Agent', 'Click Connect on the Taskosphere page in your browser. Click here if it did not open.');

  const result = await pairing.waitForApproval(started, { isCancelled: () => run !== pairingRun });
  if (run !== pairingRun) return;
  if (!result) {
    connection.state = 'not_connected';
    connection.pairUrl = null;
    notify('Taskosphere Agent is not connected', 'The connection link expired. Click here to connect this computer.');
    return;
  }
  credentials.save({ token: result.token, user_id: result.user_id, user_name: result.user_name,
                     device_id: result.device_id, agent_id: AGENT_ID });
  applyAuth(result.token, result.user_id, 'device');
  connection.state = 'connected';
  connection.userName = result.user_name || null;
  connection.pairUrl = null;
  notify('Taskosphere Agent connected', `Running in the background for ${result.user_name || 'your account'}. It starts with Windows from now on.`);
}

apiClient.setOnUnauthorized(() => onCredentialRejected());
healthMonitor.setOnUnauthorized(() => onCredentialRejected());

/** The backend no longer accepts this computer's credential (disconnected in Settings). */
function onCredentialRejected() {
  if (authSource !== 'device') return;
  console.warn('[agent] This computer was disconnected from Taskosphere; asking to connect again.');
  credentials.clear();
  clearAuth();
  connection.state = 'not_connected';
  connection.userName = null;
  notify('Taskosphere Agent was disconnected', 'This computer is no longer connected to Taskosphere. Click here to connect it again.');
}

// ── Sync orchestrator ────────────────────────────────────────────────────────

async function syncAll() {
  if (!authToken || !authUserId) {
    console.log('[agent] No auth — skipping sync');
    return;
  }

  console.log('[agent] Running full sync...');

  // 1. Activity
  try {
    const actReport = activityTracker.getReport();
    const idleMetrics = idleDetector.getMetrics();
    await apiClient.post('/api/desktop/activity', {
      agent_id:     AGENT_ID,
      user_id:      authUserId,
      machine_name: os.hostname(),
      date:         new Date().toISOString().slice(0, 10),
      ...actReport,
      idleSeconds:  idleMetrics.idleSeconds,
      focusSeconds: idleMetrics.activeSeconds,
    }, authToken);
  } catch (e) {
    offlineQueue.enqueue('/api/desktop/activity', {
      agent_id: AGENT_ID, user_id: authUserId, machine_name: os.hostname(),
      ...activityTracker.getReport(),
    }, authToken, 5);
    console.error('[agent] Activity sync failed:', e.message);
  }

  // 2. Browser
  try {
    const browserReport = browserTracker.getReport();
    await apiClient.post('/api/desktop/browser', {
      agent_id:     AGENT_ID,
      user_id:      authUserId,
      machine_name: os.hostname(),
      ...browserReport,
    }, authToken);
  } catch (e) {
    offlineQueue.enqueue('/api/desktop/browser', {
      agent_id: AGENT_ID, user_id: authUserId,
      ...browserTracker.getReport(),
    }, authToken, 4);
  }

  // 3. DSC
  try {
    const dscStatus = dscWatcher.getStatus();
    await apiClient.post('/api/desktop/dsc', {
      agent_id:     AGENT_ID,
      user_id:      authUserId,
      machine_name: os.hostname(),
      plugged:      dscStatus.plugged,
      cert:         dscStatus.cert,
      reader:       dscStatus.reader,
      connected_at: dscStatus.insertedAt,
    }, authToken);
  } catch (e) {
    offlineQueue.enqueue('/api/desktop/dsc', {
      agent_id: AGENT_ID, user_id: authUserId,
      ...dscWatcher.getStatus(),
    }, authToken, 3);
  }

  // 4. USB
  try {
    const usbEvents = usbMonitor.getPendingEvents();
    if (usbEvents.length > 0) {
      await apiClient.post('/api/desktop/usb', {
        agent_id:     AGENT_ID,
        user_id:      authUserId,
        machine_name: os.hostname(),
        events:       usbEvents,
      }, authToken);
    }
  } catch (e) {
    console.error('[agent] USB sync failed:', e.message);
  }

  // 5. Productivity
  try {
    const actReport    = activityTracker.getReport();
    const browserReport = browserTracker.getReport();
    const prodMetrics  = productivityEngine.computeMetrics(actReport, browserReport);
    await apiClient.post('/api/desktop/productivity', {
      agent_id:     AGENT_ID,
      user_id:      authUserId,
      machine_name: os.hostname(),
      ...prodMetrics,
    }, authToken);
  } catch (e) {
    offlineQueue.enqueue('/api/desktop/productivity', {
      agent_id: AGENT_ID, user_id: authUserId,
      ...productivityEngine.computeMetrics(activityTracker.getReport(), browserTracker.getReport()),
    }, authToken, 2);
  }

  // 6. Process offline queue
  try {
    await processOfflineQueue();
  } catch (e) {
    console.error('[agent] Offline queue processing failed:', e.message);
  }

  console.log('[agent] Sync complete');
}

async function processOfflineQueue() {
  const items = offlineQueue.getReadyItems(10);
  for (const item of items) {
    try {
      await apiClient.post(item.endpoint, item.payload, item.token || authToken);
      offlineQueue.markSent(item.dedup_key);
      console.log(`[offline] Synced: ${item.endpoint}`);
    } catch (e) {
      offlineQueue.markFailed(item.dedup_key);
      console.error(`[offline] Retry failed: ${item.endpoint} (attempt ${item.retries + 1})`);
    }
  }
}

// ── Express Server (backward compatible) ─────────────────────────────────────

const app = express();

// Chrome asks before a public HTTPS website may call a program on the user's
// own computer (Private Network Access / Local Network Access): the preflight
// carries Access-Control-Request-Private-Network and the answer must allow it,
// or every request from the Taskosphere website is blocked. Runs before cors()
// because cors() answers the preflight itself. The origin is still checked by
// the allowlist below.
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});
app.use(express.json());

// Exact allowlist. A wildcard such as *.onrender.com lets ANY site hosted on
// that platform read DSC/activity data from this machine and replace the
// agent's auth token, so only the real Taskosphere frontends are accepted.
// Extra origins: TASKOSPHERE_AGENT_ALLOWED_ORIGINS=https://a.com,https://b.com
const AGENT_ALLOWED_ORIGINS = new Set([
  'https://taskosphere.com',
  'https://www.taskosphere.com',
  'https://tasko-commercial-frontend.vercel.app',
  'https://tasko-commecial-frontend.vercel.app',
  'https://final-taskosphere-frontend.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  ...String(process.env.TASKOSPHERE_AGENT_ALLOWED_ORIGINS || '')
    .split(',').map((o) => o.trim()).filter(Boolean),
]);

app.use(cors({
  origin: (origin, callback) => {
    // No Origin header = a local process (not a web page); browsers always
    // send Origin on cross-origin requests.
    if (!origin) return callback(null, true);
    if (AGENT_ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    callback(new Error('CORS: origin not allowed: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

// ── Existing endpoints (preserved) ───────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    agent:    'taskosphere-agent',
    version:  AGENT_VERSION,
    agent_id: AGENT_ID,
    features: [
      'dsc-watch', 'dsc-autofill', 'dsc-read',
      'activity-tracking', 'browser-tracking', 'usb-monitor',
      'idle-detection', 'productivity', 'notifications',
      'offline-queue', 'auto-update', 'system-tray',
    ],
    health: healthMonitor.getStatus(),
  });
});

app.get('/dsc-status', (req, res) => {
  res.json(dscWatcher.getStatus());
});

app.get('/dsc-autofill', (req, res) => {
  res.json(dscWatcher.getAutofillFields());
});

app.get('/read-dsc', async (req, res) => {
  const pin = (req.query.pin || '').trim();
  if (!pin) return res.status(400).json({ success: false, error: 'PIN is required' });
  try {
    const cert = await readCertFromPcSc(pin);
    res.json({ success: true, cert });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Web-app auth (optional, legacy) ──────────────────────────────────────────
// Older web-app builds push the browser session here. A computer connected by
// pairing keeps its own credential: a browser session is replaced at every
// login, which used to make the agent stop reporting without any sign.
function webAuth(req, res, message) {
  const { token, user_id } = req.body || {};
  if (!token || !user_id) return res.status(400).json({ success: false, error: 'token and user_id required' });
  if (authSource === 'device') {
    return res.json({ success: true, message: 'This computer is connected with its own credential', agent_id: AGENT_ID });
  }
  console.log(`[agent] Session received from the web app for user: ${user_id}`);
  applyAuth(token, user_id, 'web');
  connection.state = 'connected';
  res.json({ success: true, message, agent_id: AGENT_ID });
}

app.post('/api/auth', (req, res) => webAuth(req, res, 'Agent authenticated and monitoring'));
app.post('/activity/auth', (req, res) => webAuth(req, res, 'Auth set for all modules'));

// ── Disconnect (called by the web app on logout) ─────────────────────────────
// Only drops a browser session; a paired computer stays connected (disconnect
// it from Settings → Desktop Agent instead).
app.post('/api/logout', (req, res) => {
  if (authSource === 'web') {
    clearAuth();
    connection.state = credentials.load() ? connection.state : 'not_connected';
    console.log('[agent] Signed out by the web app');
  }
  res.json({ success: true });
});

app.get('/activity/report', (req, res) => {
  res.json({ success: true, report: activityTracker.getReport() });
});

app.post('/activity/push', async (req, res) => {
  try {
    await syncAll();
    res.json({ success: true, message: 'Full sync completed' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── New endpoints ────────────────────────────────────────────────────────────

app.get('/browser/report', (req, res) => {
  res.json({ success: true, report: browserTracker.getReport() });
});

app.get('/usb/events', (req, res) => {
  res.json({ success: true, events: usbMonitor.getAllEvents() });
});

app.get('/idle/status', (req, res) => {
  res.json({ success: true, ...idleDetector.getMetrics() });
});

app.get('/productivity', (req, res) => {
  const actReport    = activityTracker.getReport();
  const browserReport = browserTracker.getReport();
  const metrics      = productivityEngine.computeMetrics(actReport, browserReport);
  res.json({ success: true, metrics });
});

app.get('/productivity/weekly', (req, res) => {
  // Return weekly aggregate from stored daily data
  const actReport    = activityTracker.getReport();
  const browserReport = browserTracker.getReport();
  const daily        = [productivityEngine.computeMetrics(actReport, browserReport)];
  const weekly       = productivityEngine.computeWeekly(daily);
  res.json({ success: true, weekly });
});

app.get('/productivity/monthly', (req, res) => {
  const actReport    = activityTracker.getReport();
  const browserReport = browserTracker.getReport();
  const daily        = [productivityEngine.computeMetrics(actReport, browserReport)];
  const monthly      = productivityEngine.computeMonthly(daily);
  res.json({ success: true, monthly });
});

app.get('/productivity/export', (req, res) => {
  const format       = req.query.format || 'json';
  const actReport    = activityTracker.getReport();
  const browserReport = browserTracker.getReport();
  const metrics      = productivityEngine.computeMetrics(actReport, browserReport);
  const exported     = productivityEngine.exportReport(metrics, format);
  res.json({ success: true, format, data: exported });
});

app.get('/system/info', (req, res) => {
  res.json({ success: true, info: systemInfo.getSystemInfo(AGENT_VERSION) });
});

app.get('/notifications', (req, res) => {
  res.json({ success: true, message: 'Notifications are received via backend polling' });
});

app.post('/sync', async (req, res) => {
  try {
    await syncAll();
    res.json({ success: true, message: 'Sync completed', pending: offlineQueue.getQueueLength() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/offline/queue', (req, res) => {
  res.json({ success: true, pending: offlineQueue.getQueueLength() });
});

app.get('/update/check', async (req, res) => {
  try {
    const info = await autoUpdater.checkForUpdate();
    res.json({ success: true, ...info });
  } catch (err) {
    res.json({ success: true, update_available: false });
  }
});

// ── Startup ──────────────────────────────────────────────────────────────────

function startAllModules() {
  // 1. Offline queue
  offlineQueue.init();

  // 2. DSC watcher
  try {
    dscWatcher.startWatcher();
  } catch (e) {
    console.warn('[agent] DSC watcher could not start:', e.message);
  }

  // 3. Activity tracker
  try {
    activityTracker.start();
  } catch (e) {
    console.warn('[agent] Activity tracker could not start:', e.message);
  }

  // 4. Browser tracker
  try {
    browserTracker.start();
  } catch (e) {
    console.warn('[agent] Browser tracker could not start:', e.message);
  }

  // 5. USB monitor
  try {
    usbMonitor.start();
  } catch (e) {
    console.warn('[agent] USB monitor could not start:', e.message);
  }

  // 6. Idle detector
  try {
    idleDetector.start(60, 5000);
  } catch (e) {
    console.warn('[agent] Idle detector could not start:', e.message);
  }

  // 7. Health monitor (starts after auth is set)
  // Will be activated by /activity/auth endpoint

  // 8. Notification receiver (starts after auth is set)

  // 9. Auto updater (starts after auth is set)

  // 10. System tray
  try {
    tray.create({ app, port: PORT, getState: trayState, onCommand: trayCommand });
  } catch (e) {
    console.warn('[agent] System tray could not start:', e.message);
  }

  // Push system info
  try {
    const info = systemInfo.getSystemInfo(AGENT_VERSION);
    if (authToken) {
      apiClient.post('/api/desktop/system', {
        agent_id: AGENT_ID,
        ...info,
      }, authToken).catch(() => {});
    }
  } catch {}

  console.log('[agent] All modules started');

  // Connect: saved credential from an earlier pairing, otherwise pair now.
  // The browser opens by itself at most twice a day; after that the tray
  // balloon offers to connect instead of opening tabs at every Windows login.
  if (!connectFromSavedCredential()) {
    const last = Number(credentials.loadState().last_auto_open_at || 0);
    const openBrowser = Date.now() - last > 12 * 60 * 60 * 1000;
    startPairing({ openBrowser }).catch((e) => console.error('[pairing] Failed:', e.message));
  }
}

// ── Tray icon: what it shows and what its menu does ──────────────────────────
function trayState() {
  const name = connection.userName ? ` as ${connection.userName}` : '';
  const text = {
    connected:     `Connected${name}`,
    pairing:       'Waiting for you to click Connect in the browser',
    not_connected: 'Not connected — click Connect to Taskosphere',
    starting:      'Starting...',
  }[connection.state] || 'Running';
  return {
    connected:     connection.state === 'connected',
    status_text:   text,
    tooltip:       `Taskosphere Agent — ${connection.state === 'connected' ? 'connected' : connection.state === 'pairing' ? 'connecting' : 'not connected'}`,
    connect_label: connection.state === 'pairing' ? 'Open the connection page' : 'Connect to Taskosphere',
    notice:        connection.notice,
    version:       AGENT_VERSION,
  };
}

function isWindowsAdmin() {
  try { require('child_process').execSync('net session', { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; }
}

function restartAgent() {
  console.log('[tray] Restarting agent...');
  const { spawn } = require('child_process');
  const fs = require('fs');
  const vbs = path.join(path.dirname(process.execPath), 'start-agent.vbs');
  stopAllModules();
  server.close();
  // Wait for the port to be released, then start the new copy hidden.
  setTimeout(() => {
    if (process.platform === 'win32' && fs.existsSync(vbs)) {
      spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    process.exit(0);
  }, 1000);
}

function trayCommand(cmd) {
  switch (cmd) {
    case 'connect':
      startPairing({ openBrowser: true });
      break;
    case 'balloon':
      if (connection.state === 'connected') pairing.openUrl(config.FRONTEND_URL);
      else startPairing({ openBrowser: true });
      break;
    case 'open':
      if (connection.state === 'pairing' && connection.pairUrl) pairing.openUrl(connection.pairUrl);
      else pairing.openUrl(config.FRONTEND_URL);
      break;
    case 'sync':
      syncAll().catch((e) => console.error('[tray] Sync failed:', e.message));
      break;
    case 'restart':
      restartAgent();
      break;
    case 'exit':
      // The agent reports work activity for the company: only a Windows
      // administrator may stop it from the tray.
      if (process.platform === 'win32' && !isWindowsAdmin()) {
        notify('Taskosphere Agent keeps running', 'Only an administrator can exit the Taskosphere Agent.');
        break;
      }
      console.log('[tray] Exiting...');
      stopAllModules();
      process.exit(0);
      break;
    default:
      break;
  }
}

function stopAllModules() {
  activityTracker.stop();
  browserTracker.stop();
  usbMonitor.stop();
  idleDetector.stop();
  healthMonitor.stop();
  notificationReceiver.stop();
  autoUpdater.stop();
  tray.destroy();
}

// ── Start HTTP server and all modules ────────────────────────────────────────

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     Taskosphere Agent v' + AGENT_VERSION.padEnd(5) + ' — Enterprise Edition              ║');
  console.log('║     Listening on http://127.0.0.1:' + PORT + '                    ║');
  console.log('║                                                              ║');
  console.log('║  Modules:                                                    ║');
  console.log('║    ✓ DSC token auto-detection (all Indian CAs)               ║');
  console.log('║    ✓ Activity tracking → pushed to backend                   ║');
  console.log('║    ✓ Browser tracking (Chrome, Edge, Firefox)                ║');
  console.log('║    ✓ USB device monitoring                                   ║');
  console.log('║    ✓ Idle time detection                                     ║');
  console.log('║    ✓ Productivity engine                                     ║');
  console.log('║    ✓ Health monitor + heartbeat                              ║');
  console.log('║    ✓ Notification receiver                                   ║');
  console.log('║    ✓ Offline queue (auto-sync)                               ║');
  console.log('║    ✓ Auto-update system                                      ║');
  console.log('║    ✓ System tray                                             ║');
  console.log('║                                                              ║');
  console.log(`║  Agent ID: ${AGENT_ID}                              ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  startAllModules();
});

// A second copy (for example started at login while one is already running)
// cannot bind the port: leave quietly instead of crashing.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log(`[agent] Already running on port ${PORT}; exiting this copy.`);
    process.exit(0);
  }
  console.error('[agent] Server error:', err && err.message);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[agent] Shutting down...');
  stopAllModules();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopAllModules();
  process.exit(0);
});

// ── Crash recovery ───────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[agent] Uncaught exception:', err.message);
  offlineQueue.addLocalLog('error', 'Uncaught exception: ' + err.message);
  // Don't exit — try to recover
});

process.on('unhandledRejection', (reason) => {
  console.error('[agent] Unhandled rejection:', reason);
  offlineQueue.addLocalLog('error', 'Unhandled rejection: ' + reason);
});

module.exports = { app, AGENT_ID, AGENT_VERSION };
