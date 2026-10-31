'use strict';

module.exports = {
  BACKEND_URL: process.env.TASKOSPHERE_BACKEND_URL || 'https://tasko-commercial-backend.onrender.com',
  // The Taskosphere web app: the agent opens <FRONTEND_URL>/agent/pair to be
  // connected to an account, and the tray's "Open Taskosphere" goes here.
  FRONTEND_URL: process.env.TASKOSPHERE_FRONTEND_URL || 'https://tasko-commecial-frontend.vercel.app',
  // Ed25519 public key (PEM) that every auto-update must be signed with.
  // Generate the pair once with: node scripts/sign-update.js --keygen
  // Paste the PUBLIC key here (or set TASKOSPHERE_UPDATE_PUBKEY). Keep the
  // private key offline. Empty = only Authenticode-signed installers update.
  UPDATE_PUBLIC_KEY: process.env.TASKOSPHERE_UPDATE_PUBKEY ||
    '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAMoNb9Wr7s6494PvMtVxstGM6N/sHUrC5lBSS03H9v3Q=\n-----END PUBLIC KEY-----\n',
  AGENT_PORT: 7432,
  ACTIVITY_COLLECT_INTERVAL: 5000,
  ACTIVITY_PUSH_INTERVAL: 60000,
};
