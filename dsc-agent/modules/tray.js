'use strict';

/**
 * tray.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Windows notification-area (system tray) icon for the Taskosphere Agent.
 *
 * The agent is a packaged Node program (pkg), which cannot draw a tray icon by
 * itself, and older builds only did so inside Electron: the icon never
 * appeared, so after installing nothing seemed to happen. The icon is now
 * drawn by TaskosphereTray.exe (tray/TaskosphereTray.cs, installed next to the
 * agent, so Windows lists it as "Taskosphere Agent"). Without it (running from
 * source) a hidden PowerShell process draws the same icon with Windows' own
 * System.Windows.Forms.NotifyIcon. Either talks to the agent over 127.0.0.1
 * with a per-run secret key:
 *
 *   GET  /tray/state    → status text, tooltip, connected?, latest notice
 *   POST /tray/command  → { cmd: 'connect' | 'open' | 'sync' | 'restart' | 'exit' | 'balloon' }
 *
 * The PowerShell process exits by itself when the agent stops, and the agent
 * starts it again if it is closed unexpectedly.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const credentials = require('./credentials');

const TRAY_SCRIPT = String.raw`
param([int]$Port, [string]$Key, [int]$ParentPid, [string]$IconPath)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$base = "http://127.0.0.1:$Port"

function Invoke-Agent([string]$Method, [string]$Path, [string]$Body) {
  $wc = New-Object System.Net.WebClient
  $wc.Proxy = $null
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Headers.Add('X-Tray-Key', $Key)
  if ($Method -eq 'POST') {
    $wc.Headers.Add('Content-Type', 'application/json')
    return $wc.UploadString($base + $Path, 'POST', $Body)
  }
  return $wc.DownloadString($base + $Path)
}
function Send-Command([string]$Cmd) { try { [void](Invoke-Agent 'POST' '/tray/command' ('{"cmd":"' + $Cmd + '"}')) } catch {} }

$tray = New-Object System.Windows.Forms.NotifyIcon
try { $tray.Icon = New-Object System.Drawing.Icon($IconPath) } catch { $tray.Icon = [System.Drawing.SystemIcons]::Application }
$tray.Text = 'Taskosphere Agent'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$title = $menu.Items.Add('Taskosphere Agent'); $title.Enabled = $false; $title.Font = New-Object System.Drawing.Font($title.Font, [System.Drawing.FontStyle]::Bold)
$status = $menu.Items.Add('Starting...'); $status.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$connect = $menu.Items.Add('Connect to Taskosphere'); $connect.add_Click({ Send-Command 'connect' })
$open = $menu.Items.Add('Open Taskosphere'); $open.add_Click({ Send-Command 'open' })
$sync = $menu.Items.Add('Sync now'); $sync.add_Click({ Send-Command 'sync' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$restart = $menu.Items.Add('Restart agent'); $restart.add_Click({ Send-Command 'restart' })
$quit = $menu.Items.Add('Exit'); $quit.add_Click({ Send-Command 'exit' })
$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ Send-Command 'open' })
$tray.add_BalloonTipClicked({ Send-Command 'balloon' })
$tray.Visible = $true

$script:lastNotice = ''
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    $tray.Visible = $false; $tray.Dispose(); [System.Windows.Forms.Application]::Exit(); return
  }
  try {
    $s = (Invoke-Agent 'GET' '/tray/state' '') | ConvertFrom-Json
    $status.Text = [string]$s.status_text
    $tip = [string]$s.tooltip
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
    $tray.Text = $tip
    $connect.Visible = -not $s.connected
    $connect.Text = [string]$s.connect_label
    $sync.Enabled = [bool]$s.connected
    if ($s.notice -and ([string]$s.notice.id) -ne $script:lastNotice) {
      $script:lastNotice = [string]$s.notice.id
      $tray.ShowBalloonTip(10000, [string]$s.notice.title, [string]$s.notice.text, [System.Windows.Forms.ToolTipIcon]::Info)
    }
  } catch {}
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
`;

let child = null;
let stopping = false;
let restarts = [];
// Per-run secret shared with the tray process (tests may pin it).
const key = process.env.TASKOSPHERE_AGENT_TRAY_KEY || crypto.randomBytes(24).toString('hex');

/** Copy a bundled file out of the packaged exe so PowerShell can read it. */
function materialize(name, contents) {
  const target = credentials.filePath(name);
  try {
    const existing = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (!existing || !existing.equals(contents)) fs.writeFileSync(target, contents);
  } catch (e) {
    console.warn(`[tray] Could not write ${name}:`, e.message);
  }
  return target;
}

function iconPath() {
  const beside = path.join(path.dirname(process.execPath), 'tray.ico'); // installed with the agent
  if (fs.existsSync(beside)) return beside;
  try {
    return materialize('tray.ico', fs.readFileSync(path.join(__dirname, '..', 'assets', 'tray.ico')));
  } catch {
    return '';
  }
}

function launch(port) {
  const native = path.join(path.dirname(process.execPath), 'TaskosphereTray.exe');
  if (fs.existsSync(native)) {
    child = spawn(native, ['--port', String(port), '--key', key, '--parent', String(process.pid), '--icon', iconPath()],
      { windowsHide: true, stdio: 'ignore' });
  } else {
    const script = materialize('tray.ps1', Buffer.from('\ufeff' + TRAY_SCRIPT.trimStart(), 'utf8'));
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    child = spawn(fs.existsSync(ps) ? ps : 'powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
      '-File', script, '-Port', String(port), '-Key', key, '-ParentPid', String(process.pid), '-IconPath', iconPath(),
    ], { windowsHide: true, stdio: 'ignore' });
  }
  child.on('exit', (code) => {
    child = null;
    if (stopping) return;
    // Closed unexpectedly (e.g. Explorer restarted): bring the icon back,
    // but give up after 5 attempts in 10 minutes.
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 10 * 60 * 1000);
    if (restarts.length >= 5) { console.warn('[tray] Tray icon keeps closing; not restarting it.'); return; }
    restarts.push(now);
    console.warn(`[tray] Tray icon process exited (${code}); restarting it.`);
    setTimeout(() => { if (!stopping) launch(port); }, 5000);
  });
  child.on('error', (e) => console.warn('[tray] Could not start the tray icon:', e.message));
  console.log('[tray] Tray icon started');
}

/**
 * Show the tray icon. `getState()` returns what the icon shows; `onCommand(cmd)`
 * runs menu actions. Registers the two /tray routes on the agent's express app.
 */
function create({ app, port, getState, onCommand }) {
  const authorised = (req) => {
    const given = String(req.headers['x-tray-key'] || '');
    return given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
  };
  app.get('/tray/state', (req, res) => {
    if (!authorised(req)) return res.status(403).json({ error: 'forbidden' });
    const state = getState();
    if (req.query.format !== 'lines') return res.json(state);
    // Plain "key<TAB>value" lines for TaskosphereTray.exe (no JSON parser there).
    const flat = { ...state, notice_id: state.notice && state.notice.id, notice_title: state.notice && state.notice.title,
                   notice_text: state.notice && state.notice.text };
    delete flat.notice;
    res.type('text/plain').send(Object.entries(flat)
      .map(([k, v]) => `${k}\t${String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ')}`).join('\n'));
  });
  app.post('/tray/command', (req, res) => {
    if (!authorised(req)) return res.status(403).json({ error: 'forbidden' });
    const cmd = String((req.body || {}).cmd || '');
    res.json({ ok: true });
    setImmediate(() => { try { onCommand(cmd); } catch (e) { console.error('[tray] Command failed:', e.message); } });
  });
  if (process.platform !== 'win32') {
    console.log('[tray] No tray icon outside Windows; agent runs in the background.');
    return;
  }
  launch(port);
}

function destroy() {
  stopping = true;
  if (child) { try { child.kill(); } catch {} child = null; }
}

module.exports = { create, destroy, TRAY_SCRIPT };
