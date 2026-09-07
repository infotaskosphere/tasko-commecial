// The backend already provides authenticated SSE real-time events for the
// Unified Inbox.  The commercial backend does not expose a Socket.IO server,
// so aliasing socket.io-client to this tiny adapter prevents repeated 403
// WebSocket attempts while keeping the existing inbox UI functional through
// SSE/polling.

export default function createSocketAdapter() {
  const handlers = new Map();

  const socket = {
    on(event, callback) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(callback);
      if (event === "connect") {
        queueMicrotask(() => {
          for (const cb of handlers.get("connect") || []) {
            try { cb(); } catch (_) {}
          }
        });
      }
      return socket;
    },
    emit() {
      return socket;
    },
    removeAllListeners() {
      handlers.clear();
      return socket;
    },
    disconnect() {
      for (const cb of handlers.get("disconnect") || []) {
        try { cb(); } catch (_) {}
      }
      handlers.clear();
      return socket;
    },
  };

  return socket;
}
