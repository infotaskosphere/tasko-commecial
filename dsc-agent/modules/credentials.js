'use strict';

/**
 * credentials.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Where the agent keeps its device credential (from pairing) and small bits of
 * state, so it keeps working after restarts without anyone signing in.
 *
 * Windows: %LOCALAPPDATA%\TaskosphereAgent (inside the user's own profile,
 * readable only by that user). Elsewhere: ~/.taskosphere-agent.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

function dataDir() {
  const dir = process.env.TASKOSPHERE_AGENT_DATA_DIR || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TaskosphereAgent')
    : path.join(os.homedir(), '.taskosphere-agent'));
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function filePath(name) { return path.join(dataDir(), name); }

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(filePath(name), 'utf8')); } catch { return null; }
}

function writeJson(name, value) {
  const target = filePath(name);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** The saved device credential, or null. */
function load() {
  const c = readJson('credential.json');
  return c && typeof c.token === 'string' && c.token.startsWith('tsa_') && c.user_id ? c : null;
}

function save(credential) {
  writeJson('credential.json', { ...credential, saved_at: new Date().toISOString() });
}

function clear() {
  try { fs.unlinkSync(filePath('credential.json')); } catch {}
}

function loadState() { return readJson('state.json') || {}; }

function saveState(patch) {
  try { writeJson('state.json', { ...loadState(), ...patch }); } catch {}
}

module.exports = { dataDir, filePath, load, save, clear, loadState, saveState };
