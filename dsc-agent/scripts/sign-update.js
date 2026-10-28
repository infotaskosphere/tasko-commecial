#!/usr/bin/env node
/**
 * Release signing for the Taskosphere agent auto-updater.
 *
 *   node scripts/sign-update.js --keygen
 *       Creates update-signing-private.pem / update-signing-public.pem.
 *       Put the PUBLIC key in config.js (UPDATE_PUBLIC_KEY). Keep the private
 *       key offline / in your release secret store. Never commit it.
 *
 *   node scripts/sign-update.js <installer.exe> [private-key.pem]
 *       Prints the base64 Ed25519 signature to store as the release's
 *       `signature` field (desktop_updates collection / Master Console).
 */
const crypto = require('crypto');
const fs = require('fs');

const [arg, keyPath = 'update-signing-private.pem'] = process.argv.slice(2);

if (arg === '--keygen') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync('update-signing-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync('update-signing-public.pem', publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('Wrote update-signing-private.pem (keep secret) and update-signing-public.pem');
  process.exit(0);
}

if (!arg) {
  console.error('Usage: sign-update.js --keygen | sign-update.js <installer.exe> [private-key.pem]');
  process.exit(1);
}

const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
const signature = crypto.sign(null, fs.readFileSync(arg), key).toString('base64');
console.log(signature);
