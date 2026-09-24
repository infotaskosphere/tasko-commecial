/**
 * dscTokenReader.js  — v2 (Fixed Chrome navigator.smartCard API shapes)
 * ─────────────────────────────────────────────────────────────────────────────
 * Four-tier strategy for reading X.509 certificates from DSC USB tokens:
 *
 * Tier 1 · navigator.smartCard  (Chrome 114+ on Windows via WinSCard/PC-SC)
 * Tier 2 · Local DSC Agent      (node index.js on localhost:7432 via PC-SC)
 * Tier 3 · WebUSB + CCID        (Linux/Mac — blocked on Windows by OS driver)
 * Tier 4 · .cer/.pem file upload (universal fallback — always works)
 *
 * KEY FIX: Chrome's navigator.smartCard uses a completely different API shape
 * than the W3C draft. This file implements the *actual* Chrome shape correctly
 * and adds verbose error logging so failures are visible in the DevTools console.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Shared DER / ASN.1 parser (used by all tiers)
// ─────────────────────────────────────────────────────────────────────────────

function readLength(der, pos) {
  const first = der[pos++];
  if (first < 0x80) return { len: first, pos };
  const nBytes = first & 0x7F;
  let len = 0;
  for (let i = 0; i < nBytes; i++) len = (len << 8) | der[pos++];
  return { len, pos };
}

function readTlv(der, pos) {
  const tag = der[pos++];
  const { len, pos: afterLen } = readLength(der, pos);
  return { tag, len, valueStart: afterLen, nextPos: afterLen + len };
}

function parseSequenceOf(der, start, end) {
  const items = [];
  let pos = start;
  while (pos < end) {
    const { tag, len, valueStart, nextPos } = readTlv(der, pos);
    items.push({ tag, len, valueStart, nextPos, value: der.slice(valueStart, nextPos) });
    pos = nextPos;
  }
  return items;
}

function decodeString(der, start, len, tag) {
  const bytes = der.slice(start, start + len);
  try {
    if (tag === 0x1E) {
      let s = '';
      for (let i = 0; i < bytes.length - 1; i += 2)
        s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return s;
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

function decodeOid(bytes) {
  let oid = '';
  const first = bytes[0];
  oid += Math.floor(first / 40) + '.' + (first % 40);
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = (value << 7) | (bytes[i] & 0x7F);
    if (!(bytes[i] & 0x80)) { oid += '.' + value; value = 0; }
  }
  return oid;
}

function parseTime(bytes, tag) {
  const s = new TextDecoder().decode(bytes);
  let year, month, day;
  if (tag === 0x17) {
    const y2 = parseInt(s.substring(0, 2));
    year  = y2 >= 50 ? 1900 + y2 : 2000 + y2;
    month = s.substring(2, 4);
    day   = s.substring(4, 6);
  } else {
    year  = s.substring(0, 4);
    month = s.substring(4, 6);
    day   = s.substring(6, 8);
  }
  return `${year}-${month}-${day}`;
}

const OID_MAP = {
  '2.5.4.3':              'CN',
  '2.5.4.10':             'O',
  '2.5.4.11':             'OU',
  '2.5.4.6':              'C',
  '1.2.840.113549.1.9.1': 'emailAddress',
  '2.5.4.41':             'name',
  '2.5.4.4':              'SN',
  '2.5.4.42':             'GN',
};

function parseName(der, start, len) {
  const result = {};
  const rdnSeq = parseSequenceOf(der, start, start + len);
  for (const rdn of rdnSeq) {
    if (rdn.tag !== 0x31) continue;
    const attrSeq = parseSequenceOf(der, rdn.valueStart, rdn.nextPos);
    for (const attr of attrSeq) {
      if (attr.tag !== 0x30) continue;
      const children = parseSequenceOf(der, attr.valueStart, attr.nextPos);
      if (children.length < 2) continue;
      const oidItem = children[0];
      const valItem = children[1];
      if (oidItem.tag !== 0x06) continue;
      const oid = decodeOid(der.slice(oidItem.valueStart, oidItem.nextPos));
      result[OID_MAP[oid] || oid] = decodeString(der, valItem.valueStart, valItem.len, valItem.tag);
    }
  }
  return result;
}

function parseDerCertificate(der) {
  try {
    let pos = 0;
    const outer = readTlv(der, pos);
    if (outer.tag !== 0x30) return null;
    const tbs = readTlv(der, outer.valueStart);
    if (tbs.tag !== 0x30) return null;

    let p = tbs.valueStart;
    if (der[p] === 0xA0) { const v = readTlv(der, p); p = v.nextPos; }

    const serial = readTlv(der, p); p = serial.nextPos;
    let serialHex = '';
    for (let i = serial.valueStart; i < serial.nextPos; i++)
      serialHex += der[i].toString(16).padStart(2, '0').toUpperCase();

    const sigAlg = readTlv(der, p); p = sigAlg.nextPos;
    const issuerTlv = readTlv(der, p); p = issuerTlv.nextPos;
    const issuer = parseName(der, issuerTlv.valueStart, issuerTlv.len);

    const validity = readTlv(der, p); p = validity.nextPos;
    let vp = validity.valueStart;
    const notBeforeTlv = readTlv(der, vp); vp = notBeforeTlv.nextPos;
    const notAfterTlv  = readTlv(der, vp);
    const notBefore = parseTime(der.slice(notBeforeTlv.valueStart, notBeforeTlv.nextPos), notBeforeTlv.tag);
    const notAfter  = parseTime(der.slice(notAfterTlv.valueStart,  notAfterTlv.nextPos),  notAfterTlv.tag);

    const subjectTlv = readTlv(der, p);
    const subject = parseName(der, subjectTlv.valueStart, subjectTlv.len);

    return {
      holder_name:   subject.CN || subject.name || subject.GN || null,
      organization:  subject.O  || null,
      email:         subject['emailAddress'] || null,
      serial_number: serialHex,
      issue_date:    notBefore,
      expiry_date:   notAfter,
      issuer:        issuer.CN || issuer.O || null,
      raw_subject:   JSON.stringify(subject),
      read_method:   'der-parse',
    };
  } catch (e) {
    console.warn('[dscTokenReader] DER parse error:', e);
    return null;
  }
}

function extractDerFromBlob(bytes) {
  for (let i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] === 0x30 && bytes[i + 1] === 0x82) {
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (i + 4 + len <= bytes.length) return bytes.slice(i, i + 4 + len);
    }
  }
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === 0x30 && bytes[i + 1] === 0x81) {
      const len = bytes[i + 2];
      if (i + 3 + len <= bytes.length) return bytes.slice(i, i + 3 + len);
    }
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Known APDU sequences for Indian DSC tokens
// ─────────────────────────────────────────────────────────────────────────────

const CERT_SELECT_SEQUENCES = [
  // ePass2003 / Feitian (most common Indian DSC)
  {
    name: 'ePass2003/Feitian EF=1005',
    apdus: [
      [0x00, 0xA4, 0x04, 0x00, 0x0C, 0xA0, 0x00, 0x00, 0x00, 0x03, 0x08, 0x00, 0x00, 0x10, 0x00, 0x01, 0x00],
      [0x00, 0xA4, 0x02, 0x0C, 0x02, 0x10, 0x05],
    ],
  },
  {
    name: 'ePass2003/Feitian EF=1001',
    apdus: [
      [0x00, 0xA4, 0x04, 0x00, 0x0C, 0xA0, 0x00, 0x00, 0x00, 0x03, 0x08, 0x00, 0x00, 0x10, 0x00, 0x01, 0x00],
      [0x00, 0xA4, 0x02, 0x0C, 0x02, 0x10, 0x01],
    ],
  },
  // Longmai mToken (VID 0x055C) / WatchData / ProxKey
  {
    name: 'Longmai/WatchData/ProxKey PKI',
    apdus: [
      [0x00, 0xA4, 0x04, 0x00, 0x08, 0xA0, 0x00, 0x00, 0x00, 0x63, 0x50, 0x4B, 0x43],
      [0x00, 0xA4, 0x02, 0x00, 0x02, 0x00, 0x01],
    ],
  },
  // Generic MF select
  {
    name: 'Generic MF EF=1005',
    apdus: [
      [0x00, 0xA4, 0x00, 0x00, 0x02, 0x3F, 0x00],
      [0x00, 0xA4, 0x02, 0x04, 0x02, 0x10, 0x05],
    ],
  },
  // eToken (Gemalto/SafeNet/Thales)
  {
    name: 'eToken/Gemalto/SafeNet',
    apdus: [
      [0x00, 0xA4, 0x04, 0x00, 0x09, 0xA0, 0x00, 0x00, 0x00, 0x18, 0x0A, 0x00, 0x00, 0x01],
      [0x00, 0xA4, 0x02, 0x0C, 0x02, 0x10, 0x05],
    ],
  },
  // Trustkey G310 / emSign
  {
    name: 'Trustkey/emSign',
    apdus: [
      [0x00, 0xA4, 0x04, 0x00, 0x07, 0xA0, 0x00, 0x00, 0x00, 0x63, 0x50, 0x4B],
      [0x00, 0xA4, 0x02, 0x00, 0x02, 0x00, 0x01],
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Tier 1: navigator.smartCard (Chrome PC/SC API — FIXED)
// ─────────────────────────────────────────────────────────────────────────────
//
// Chrome's ACTUAL navigator.smartCard API (Chrome 114–126+):
//
//   navigator.smartCard.establishContext()
//     → Promise<SmartCardContext>
//
//   context.listReaders()
//     → Promise<string[]>
//
//   context.connect(readerName, accessMode, preferredProtocols)
//     → Promise<SmartCardConnection>   ← DIRECT connection, NOT { connection }
//
//   connection.transmit(Uint8Array)
//     → Promise<ArrayBuffer>           ← Returns ArrayBuffer, NOT DataView
//
//   connection.disconnect(disposition)
//     → Promise<void>
//
// ── BUGS THAT CAUSED SILENT FAILURE (now fixed): ────────────────────────────
//   ✗ const { connection } = await context.connect(...)
//     FIXED: connection = await context.connect(...)   (returns directly)
//
//   ✗ const view = await connection.transmit(...)
//       new Uint8Array(view.buffer)
//     FIXED: const ab = await connection.transmit(...)
//              new Uint8Array(ab)                       (ab IS the ArrayBuffer)
//
//   ✗ Swallowing all errors silently — caller never saw what went wrong
//     FIXED: verbose [DSC-SC] console logging at every step
// ─────────────────────────────────────────────────────────────────────────────

export function isWebSmartCardSupported() {
  return (
    typeof navigator !== 'undefined' &&
    'smartCard' in navigator &&
    typeof navigator.smartCard.establishContext === 'function'
  );
}

function scLog(step, detail = '', data = null) {
  const msg = `[DSC-SC] ${step}${detail ? ': ' + detail : ''}`;
  if (data !== null) console.log(msg, data);
  else console.log(msg);
}

// transmit() → ArrayBuffer → wrap as Uint8Array
async function scTransmit(connection, apdu) {
  const ab = await connection.transmit(new Uint8Array(apdu));
  return new Uint8Array(ab);
}

async function scReadBinary(connection) {
  const chunks = [];
  let offset = 0;
  while (true) {
    const apdu = [0x00, 0xB0, (offset >> 8) & 0xFF, offset & 0xFF, 0xFF];
    const resp = await scTransmit(connection, apdu);
    if (!resp || resp.length < 2) break;
    const sw1 = resp[resp.length - 2];
    const sw2 = resp[resp.length - 1];
    const data = resp.slice(0, resp.length - 2);

    if (sw1 === 0x90) {
      chunks.push(...data);
      offset += data.length;
      if (data.length < 255) break;
    } else if (sw1 === 0x6C) {
      // Retry with exact Le from SW2
      const fix  = [0x00, 0xB0, (offset >> 8) & 0xFF, offset & 0xFF, sw2];
      const fixR = await scTransmit(connection, fix);
      if (fixR && fixR.length >= 2) chunks.push(...fixR.slice(0, fixR.length - 2));
      break;
    } else if (sw1 === 0x61) {
      // GET RESPONSE
      const gr  = [0x00, 0xC0, 0x00, 0x00, sw2 || 0xFF];
      const grR = await scTransmit(connection, gr);
      if (grR && grR.length >= 2) chunks.push(...grR.slice(0, grR.length - 2));
      break;
    } else {
      scLog('READ BINARY stopped', `SW=${sw1.toString(16)} ${sw2.toString(16)} at offset ${offset}`);
      break;
    }
  }
  return new Uint8Array(chunks);
}

export async function readCertFromWebSmartCard(pin) {
  if (!isWebSmartCardSupported()) {
    throw new Error('navigator.smartCard not available. Use Chrome 114+ on Windows.');
  }

  scLog('API available — establishing context');

  let context;
  try {
    context = await navigator.smartCard.establishContext();
    scLog('Context OK', typeof context);
  } catch (err) {
    throw new Error(`smartCard.establishContext() failed: ${err.message}`);
  }

  let readers = [];
  try {
    readers = await context.listReaders();
    scLog('Readers', readers.join(', ') || '(none)');
  } catch (err) {
    try { context.cancel?.(); } catch {}
    throw new Error(`No smart card reader found. Is your DSC token plugged in? (${err.message})`);
  }

  if (!readers || readers.length === 0) {
    try { context.cancel?.(); } catch {}
    throw new Error('No smart card readers detected. Plug in your DSC token and try again.');
  }

  for (const readerName of readers) {
    scLog('Connecting to reader', readerName);

    let connection = null;
    try {
      // ── FIX: connect() returns the connection DIRECTLY (not { connection }) ──
      connection = await context.connect(readerName, 'shared', { t0: true, t1: true });
      scLog('Connected', `typeof connection = ${typeof connection}, transmit = ${typeof connection?.transmit}`);
    } catch (err) {
      scLog(`connect() FAILED for "${readerName}"`, err.message);
      continue; // try next reader
    }

    try {
      for (const { name, apdus } of CERT_SELECT_SEQUENCES) {
        scLog('Trying sequence', name);
        let sequenceOk = true;

        for (const apdu of apdus) {
          let resp;
          try {
            resp = await scTransmit(connection, apdu);
          } catch (err) {
            scLog(`transmit() FAILED in "${name}"`, err.message);
            sequenceOk = false;
            break;
          }

          if (!resp || resp.length < 2) {
            scLog(`Empty response in "${name}"`);
            sequenceOk = false;
            break;
          }

          const sw1 = resp[resp.length - 2];
          const sw2 = resp[resp.length - 1];
          scLog(
            `APDU [${apdu.slice(0,4).map(b=>b.toString(16).padStart(2,'0')).join(' ')}…]`,
            `→ SW ${sw1.toString(16)} ${sw2.toString(16)}`
          );

          if (sw1 !== 0x90 && sw1 !== 0x61 && sw1 !== 0x62) {
            scLog(`SELECT failed in "${name}"`, `SW=${sw1.toString(16)} ${sw2.toString(16)}`);
            sequenceOk = false;
            break;
          }
        }

        if (!sequenceOk) continue;

        // ── PIN verification ───────────────────────────────────────────────
        if (pin && pin.trim()) {
          scLog('Verifying PIN');
          const pinBytes = new TextEncoder().encode(pin.trim());
          const verifyApdu = [0x00, 0x20, 0x00, 0x01, pinBytes.length, ...pinBytes];
          let verifyResp;
          try {
            verifyResp = await scTransmit(connection, verifyApdu);
          } catch (err) {
            throw new Error(`PIN transmit failed: ${err.message}`);
          }

          if (verifyResp && verifyResp.length >= 2) {
            const sw1 = verifyResp[verifyResp.length - 2];
            const sw2 = verifyResp[verifyResp.length - 1];
            scLog('PIN VERIFY SW', `${sw1.toString(16)} ${sw2.toString(16)}`);
            if (sw1 !== 0x90) {
              if (sw1 === 0x69 && sw2 === 0x82) throw new Error('Incorrect PIN — please check your token PIN.');
              if (sw1 === 0x69 && sw2 === 0x83) throw new Error('PIN blocked — token is locked. Use mToken Manager to unlock.');
              if (sw1 === 0x63) throw new Error(`Incorrect PIN — ${sw2 & 0x0F} attempt(s) remaining.`);
              throw new Error(`PIN verify failed (SW ${sw1.toString(16).toUpperCase()} ${sw2.toString(16).toUpperCase()})`);
            }
            scLog('PIN verified OK');
          }
        }

        // ── READ BINARY ────────────────────────────────────────────────────
        scLog('Reading binary data from EF…');
        let rawBytes;
        try {
          rawBytes = await scReadBinary(connection);
        } catch (err) {
          scLog(`READ BINARY failed in "${name}"`, err.message);
          continue;
        }

        scLog(`Read ${rawBytes.length} bytes`);
        if (!rawBytes || rawBytes.length < 64) {
          scLog(`Too few bytes in "${name}" — skipping`);
          continue;
        }

        const derBytes = extractDerFromBlob(rawBytes);
        const cert = parseDerCertificate(derBytes);

        if (cert && cert.holder_name) {
          scLog('SUCCESS', cert.holder_name, cert);
          cert.read_method = 'web-smartcard';
          return cert;
        }
        scLog(`No holder_name parsed in "${name}" — trying next sequence`);
      }
    } catch (err) {
      // Rethrow PIN / security errors — don't swallow
      if (err?.message?.includes('PIN') || err?.message?.includes('blocked') || err?.message?.includes('attempt')) {
        try { await connection.disconnect('leaveCard'); } catch {}
        try { context.cancel?.(); } catch {}
        throw err;
      }
      scLog(`Error on reader "${readerName}"`, err.message);
    } finally {
      if (connection) {
        try { await connection.disconnect('leaveCard'); } catch {}
      }
    }
  }

  try { context.cancel?.(); } catch {}
  scLog('No certificate found across all readers');
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Tier 2: Local DSC Agent (node index.js on localhost:7432)
// ─────────────────────────────────────────────────────────────────────────────

const DSC_AGENT_URL = (import.meta.env?.VITE_DSC_AGENT_URL || 'http://127.0.0.1:7432').replace(/\/+$/, '');

export async function checkLocalAgent() {
  try {
    const res = await fetch(`${DSC_AGENT_URL}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * getAgentDscStatus — poll the agent's /dsc-status endpoint.
 * Returns { plugged, cert, reader, pushed } or null if agent not running.
 * The agent auto-reads the cert (without PIN) when a token is inserted.
 */
export async function getAgentDscStatus() {
  try {
    const res = await fetch(`${DSC_AGENT_URL}/dsc-status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function readCertFromLocalAgent(pin) {
  console.log('[DSC-Agent] Trying local agent at', DSC_AGENT_URL);
  const res = await fetch(
    `${DSC_AGENT_URL}/read-dsc?pin=${encodeURIComponent(pin)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Agent responded with HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Agent returned failure');
  console.log('[DSC-Agent] Success:', data.cert?.holder_name);
  if (data.cert) data.cert.read_method = 'local-agent';
  return data.cert || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Tier 3: WebUSB + CCID (Linux/Mac only — blocked on Windows)
// ─────────────────────────────────────────────────────────────────────────────

const PC_TO_RDR_ICCPOWERON = 0x62;
const PC_TO_RDR_XFRBLOCK   = 0x6F;
const RDR_TO_PC_DATABLOCK  = 0x80;

function buildXfrBlock(apdu, seq = 0) {
  const len = apdu.length;
  const msg = new Uint8Array(10 + len);
  msg[0] = PC_TO_RDR_XFRBLOCK;
  msg[1] = len & 0xFF; msg[2] = (len >> 8) & 0xFF;
  msg[3] = (len >> 16) & 0xFF; msg[4] = (len >> 24) & 0xFF;
  msg[5] = 0x00; msg[6] = seq & 0xFF; msg[7] = 0x00;
  msg[8] = 0x00; msg[9] = 0x00;
  msg.set(apdu, 10);
  return msg;
}

function buildPowerOn(seq = 0) {
  const msg = new Uint8Array(10);
  msg[0] = PC_TO_RDR_ICCPOWERON;
  msg[5] = 0x00; msg[6] = seq; msg[7] = 0x00;
  return msg;
}

function findCcidEndpoints(device) {
  for (const config of device.configurations) {
    for (const iface of config.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === 0x0B) {
          let epIn = null, epOut = null;
          for (const ep of alt.endpoints) {
            if (ep.type === 'bulk') {
              if (ep.direction === 'in')  epIn  = ep.endpointNumber;
              if (ep.direction === 'out') epOut = ep.endpointNumber;
            }
          }
          if (epIn !== null && epOut !== null)
            return { interfaceNumber: iface.interfaceNumber, epIn, epOut };
        }
      }
    }
  }
  for (const config of device.configurations) {
    for (const iface of config.interfaces) {
      for (const alt of iface.alternates) {
        let epIn = null, epOut = null;
        for (const ep of alt.endpoints) {
          if (ep.type === 'bulk') {
            if (ep.direction === 'in')  epIn  = ep.endpointNumber;
            if (ep.direction === 'out') epOut = ep.endpointNumber;
          }
        }
        if (epIn !== null && epOut !== null)
          return { interfaceNumber: iface.interfaceNumber, epIn, epOut };
      }
    }
  }
  return null;
}

async function usbSendApdu(device, epIn, epOut, apdu, seq) {
  const xfr = buildXfrBlock(apdu, seq);
  await device.transferOut(epOut, xfr);
  const result = await device.transferIn(epIn, 65556);
  const buf = new Uint8Array(result.data.buffer);
  if (buf[0] !== RDR_TO_PC_DATABLOCK || buf.length < 10) return null;
  const dataLen = buf[1] | (buf[2] << 8) | (buf[3] << 16) | (buf[4] << 24);
  return buf.slice(10, 10 + dataLen);
}

async function usbReadBinary(device, epIn, epOut, seqRef) {
  const chunks = [];
  let offset = 0;
  while (true) {
    const apdu = [0x00, 0xB0, (offset >> 8) & 0xFF, offset & 0xFF, 0xFF];
    const resp = await usbSendApdu(device, epIn, epOut, apdu, seqRef.val++);
    if (!resp || resp.length < 2) break;
    const sw1 = resp[resp.length - 2];
    const sw2 = resp[resp.length - 1];
    const data = resp.slice(0, resp.length - 2);
    if (sw1 === 0x90) {
      chunks.push(...data);
      offset += data.length;
      if (data.length < 255) break;
    } else if (sw1 === 0x6C) {
      const fix = [0x00, 0xB0, (offset >> 8) & 0xFF, offset & 0xFF, sw2];
      const fixR = await usbSendApdu(device, epIn, epOut, fix, seqRef.val++);
      if (fixR && fixR.length >= 2) chunks.push(...fixR.slice(0, fixR.length - 2));
      break;
    } else {
      break;
    }
  }
  return new Uint8Array(chunks);
}

export async function readCertFromUsbToken(device, pin) {
  const endpoints = findCcidEndpoints(device);
  if (!endpoints) throw new Error('No CCID interface found on this device.');
  const { interfaceNumber, epIn, epOut } = endpoints;

  await device.selectConfiguration(1);
  try { await device.releaseInterface(interfaceNumber); } catch {}
  await device.claimInterface(interfaceNumber);

  const seqRef = { val: 0 };
  try {
    const powerMsg = buildPowerOn(seqRef.val++);
    await device.transferOut(epOut, powerMsg);
    await device.transferIn(epIn, 65536);

    for (const { name, apdus } of CERT_SELECT_SEQUENCES) {
      try {
        let allOk = true;
        for (const apdu of apdus) {
          const resp = await usbSendApdu(device, epIn, epOut, apdu, seqRef.val++);
          if (!resp || resp.length < 2) { allOk = false; break; }
          const sw1 = resp[resp.length - 2];
          if (sw1 !== 0x90 && sw1 !== 0x61 && sw1 !== 0x62) { allOk = false; break; }
        }
        if (!allOk) continue;

        if (pin) {
          const pinBytes = new TextEncoder().encode(pin);
          const verifyApdu = [0x00, 0x20, 0x00, 0x01, pinBytes.length, ...pinBytes];
          await usbSendApdu(device, epIn, epOut, verifyApdu, seqRef.val++);
        }

        const rawBytes = await usbReadBinary(device, epIn, epOut, seqRef);
        if (!rawBytes || rawBytes.length < 64) continue;

        const derBytes = extractDerFromBlob(rawBytes);
        const cert = parseDerCertificate(derBytes);
        if (cert && cert.holder_name) {
          cert.read_method = 'webusb-ccid';
          console.log(`[DSC-USB] OK via "${name}":`, cert.holder_name);
          return cert;
        }
      } catch {
        continue;
      }
    }
    return null;
  } finally {
    try { await device.releaseInterface(interfaceNumber); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Tier 4: .cer / .pem file upload (always works)
// ─────────────────────────────────────────────────────────────────────────────

export async function parseCertificateFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  let der = new Uint8Array(arrayBuffer);
  const text = new TextDecoder('utf-8').decode(der.slice(0, 30));
  if (text.startsWith('-----BEGIN')) {
    const pem = new TextDecoder('utf-8').decode(der);
    const b64 = pem
      .replace(/-----BEGIN[\s\S]*?-----/, '')
      .replace(/-----END[\s\S]*?-----/, '')
      .replace(/\s+/g, '');
    const binary = atob(b64);
    der = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  }
  const clean = extractDerFromBlob(der);
  const cert = parseDerCertificate(clean);
  if (cert) cert.read_method = 'file-upload';
  return cert;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Diagnostic (call diagnoseDscReader() from DevTools or UI)
// ─────────────────────────────────────────────────────────────────────────────

export async function diagnoseDscReader() {
  const lines = [];
  const add = (line) => { lines.push(line); console.log('[DSC-DIAG]', line); };

  add('=== DSC Reader Diagnostic v2 ===');

  // navigator.smartCard
  const scPresent = 'smartCard' in navigator;
  add(`navigator.smartCard present: ${scPresent}`);
  if (scPresent) {
    add(`  .establishContext type: ${typeof navigator.smartCard.establishContext}`);
    try {
      const ctx = await navigator.smartCard.establishContext();
      add(`  establishContext() → OK`);
      add(`  ctx.listReaders type: ${typeof ctx.listReaders}`);
      add(`  ctx.connect type: ${typeof ctx.connect}`);
      try {
        const readers = await ctx.listReaders();
        add(`  listReaders() → [${readers.join(', ')}]`);
        for (const r of readers) {
          try {
            const conn = await ctx.connect(r, 'shared', { t0: true, t1: true });
            add(`  "${r}" → connect() OK`);
            add(`    conn.transmit type: ${typeof conn?.transmit}`);
            add(`    conn.disconnect type: ${typeof conn?.disconnect}`);
            try { await conn.disconnect('leaveCard'); } catch {}
          } catch (err) {
            add(`  "${r}" → connect() FAILED: ${err.message}`);
          }
        }
      } catch (err) {
        add(`  listReaders() FAILED: ${err.message}`);
      }
      try { ctx.cancel?.(); } catch {}
    } catch (err) {
      add(`  establishContext() FAILED: ${err.message}`);
    }
  }

  add('');
  const agentOk = await checkLocalAgent();
  add(`Local DSC agent (localhost:7432) reachable: ${agentOk}`);

  add('');
  add(`navigator.usb present: ${'usb' in navigator}`);
  if ('usb' in navigator) {
    try {
      const devices = await navigator.usb.getDevices();
      add(`  Already-permitted devices: ${devices.length}`);
      for (const d of devices)
        add(`    VID=0x${d.vendorId.toString(16).padStart(4,'0')} "${d.productName}" by "${d.manufacturerName}"`);
    } catch (err) {
      add(`  getDevices() FAILED: ${err.message}`);
    }
  }

  add('');
  add('=== End of Diagnostic ===');
  return lines.join('\n');
}
