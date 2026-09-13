import api from "./api";

// The commercial SaaS session can expose a compatibility user id that differs
// from the legacy /users collection id. General Settings updates the current
// user's profile through PUT /users/:id, so transparently resolve the canonical
// id from the existing /users endpoint when the first update returns 404.
let installed = false;

const normalizeForCompare = (key, value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (key === "birthday") return String(value).slice(0, 10);
  return String(value);
};

const parseRequestData = (data) => {
  if (!data) return {};
  if (typeof data === "object") return data;
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
};

const profileUpdateWasPersisted = (user, payload) => {
  if (!user || !payload || typeof payload !== "object") return false;

  return Object.entries(payload).every(([key, value]) => {
    const expected = normalizeForCompare(key, value);
    const actual = normalizeForCompare(key, user[key]);
    return expected === actual;
  });
};

const findCurrentUser = async (config) => {
  const requestedId = String(config?.url || "").split("/").pop() || "";

  try {
    const direct = await api.get(`/users/${requestedId}`, {
      _silent: true,
      _profilePersistCheck: true,
    });
    if (direct?.data && typeof direct.data === "object") return direct.data;
  } catch {
    // Some deployments do not expose GET /users/:id. Fall back to the list.
  }

  const stored = localStorage.getItem("user") || sessionStorage.getItem("user");
  const currentUser = stored ? JSON.parse(stored) : null;
  const currentEmail = String(currentUser?.email || "").trim().toLowerCase();
  const currentName = String(currentUser?.full_name || "").trim().toLowerCase();

  const usersResponse = await api.get("/users", {
    _silent: true,
    _profilePersistCheck: true,
  });
  const raw = usersResponse?.data;
  const users = Array.isArray(raw) ? raw : raw?.data || [];

  return users.find((candidate) => {
    const candidateId = String(candidate?.id || "");
    const email = String(candidate?.email || "").trim().toLowerCase();
    const name = String(candidate?.full_name || "").trim().toLowerCase();
    return candidateId === requestedId ||
      (currentEmail && email === currentEmail) ||
      (!currentEmail && currentName && name === currentName);
  }) || null;
};

export function installProfileUpdateCompat() {
  if (installed) return;
  installed = true;

  api.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error?.config;
      const method = config?.method?.toLowerCase();
      const isProfilePut =
        method === "put" && /^\/users\/[^/?]+$/.test(config?.url || "");

      if (!config || !isProfilePut) {
        return Promise.reject(error);
      }

      // Existing compatibility path: resolve a canonical user id after a 404.
      if (!config._profileIdCompatRetry && error?.response?.status === 404) {
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

      // The current backend can commit the MongoDB update and then fail while
      // serializing the response model, producing HTTP 500 even though the
      // requested profile values are already persisted. Never hide an actual
      // failed write: verify the saved values with a fresh GET first, then
      // convert only that confirmed case into a successful Axios response.
      if (error?.response?.status === 500 && !config._profilePersistCheck) {
        try {
          const payload = parseRequestData(config.data);
          const currentUser = await findCurrentUser(config);

          if (profileUpdateWasPersisted(currentUser, payload)) {
            console.warn(
              "[Taskosphere] Profile PUT returned 500 after the update was confirmed persisted; treating the verified result as success."
            );

            return {
              ...error.response,
              status: 200,
              statusText: "OK",
              data: currentUser,
              config,
              request: error.request,
            };
          }
        } catch {
          // Preserve the original 500 when persistence cannot be verified.
        }
      }

      return Promise.reject(error);
    }
  );
}

installProfileUpdateCompat();
