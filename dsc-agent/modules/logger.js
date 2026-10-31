'use strict';

/**
 * logger.js — the agent runs without a window, so console output also goes to
 * %LOCALAPPDATA%\TaskosphereAgent\agent.log (kept under ~1 MB, one backup).
 */

const fs   = require('fs');
const util = require('util');
const credentials = require('./credentials');

const MAX_BYTES = 1024 * 1024;

function install() {
  let file;
  try { file = credentials.filePath('agent.log'); } catch { return null; }
  const write = (level, args) => {
    try {
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
      } catch {}
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${util.format(...args)}\n`);
    } catch {}
  };
  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => { write(level, args); original(...args); };
  }
  return file;
}

module.exports = { install };
