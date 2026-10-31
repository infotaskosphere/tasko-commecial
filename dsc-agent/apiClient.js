'use strict';

const https = require('https');
const http  = require('http');
const config = require('./config');

// Called when the backend answers 401 (the computer was disconnected).
let onUnauthorized = null;
function setOnUnauthorized(fn) { onUnauthorized = fn; }

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    let baseUrl = config.BACKEND_URL;
    if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
    const url = new URL(path, baseUrl);
    const isHttps = url.protocol === 'https:';

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

module.exports = { post, setOnUnauthorized };
