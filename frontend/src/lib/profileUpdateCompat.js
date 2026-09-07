import api from "./api";

// The commercial SaaS session can expose a compatibility user id that differs
// from the legacy /users collection id. General Settings updates the current
// user's profile through PUT /users/:id, so transparently resolve the canonical
// id from the existing /users endpoint when the first update returns 404.
let installed = false;

export function installProfileUpdateCompat() {
  if (installed) return;
  installed = true;

  api.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error?.config;
      if (
        !config ||
        config._profileIdCompatRetry ||
        error?.response?.status !== 404 ||
        config.method?.toLowerCase() !== "put" ||
        !/^\/users\/[^/?]+$/.test(config.url || "")
      ) {
        return Promise.reject(error);
      }

      try {
        const stored =
          localStorage.getItem("user") || sessionStorage.getItem("user");
        const currentUser = stored ? JSON.parse(stored) : null;
        const currentEmail = String(currentUser?.email || "").trim().toLowerCase();
        const currentName = String(currentUser?.full_name || "").trim().toLowerCase();

        if (!currentEmail && !currentName) return Promise.reject(error);

        const usersResponse = await api.get("/users", {
          _silent: true,
          _profileIdLookup: true,
        });
        const raw = usersResponse?.data;
        const users = Array.isArray(raw) ? raw : raw?.data || [];

        const canonical = users.find((candidate) => {
          const email = String(candidate?.email || "").trim().toLowerCase();
          const name = String(candidate?.full_name || "").trim().toLowerCase();
          return (currentEmail && email === currentEmail) ||
            (!currentEmail && currentName && name === currentName);
        });

        if (!canonical?.id || String(canonical.id) === String(config.url.split("/").pop())) {
          return Promise.reject(error);
        }

        return api.request({
          ...config,
          url: `/users/${canonical.id}`,
          _profileIdCompatRetry: true,
          _skipReadyGate: true,
        });
      } catch {
        return Promise.reject(error);
      }
    }
  );
}

installProfileUpdateCompat();
