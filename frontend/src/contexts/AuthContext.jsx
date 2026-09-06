import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import api from "../lib/api";
import { autoAuthenticateAgent, resetAgentAuth } from "../lib/agentAutoAuth";

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
};

const isKeepSignedIn = () => localStorage.getItem('taskosphere_keep_signed_in') === 'true';

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const normalizePermissions = (permissions) => {
    if (permissions && typeof permissions === "object" && !Array.isArray(permissions)) return permissions;
    return {};
  };

  const normalizeTenantContext = (userData) => {
    if (!userData || typeof userData !== "object") return userData;
    return {
      ...userData,
      permissions: normalizePermissions(userData.permissions),
      company_id: userData.company_id ? String(userData.company_id) : null,
      company: userData.company || null,
      subscription: userData.subscription || null,
    };
  };

  const getStoredAuth = () => {
    const token = localStorage.getItem("token") || sessionStorage.getItem("token");
    const storedUser = localStorage.getItem("user") || sessionStorage.getItem("user");
    return { token, storedUser };
  };

  const persistAuth = (token, userData, rememberMe = false, sessionToken = null) => {
    const storage = rememberMe ? localStorage : sessionStorage;
    const normalizedUser = normalizeTenantContext(userData);
    storage.setItem("token", token);
    storage.setItem("user", JSON.stringify(normalizedUser));
    if (sessionToken) storage.setItem("session_token", sessionToken);
    api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  };

  const clearStorage = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    localStorage.removeItem("session_token");
    localStorage.removeItem("taskosphere_last_active");
    localStorage.removeItem("taskosphere_tab_closed");
    localStorage.removeItem("taskosphere_keep_signed_in");
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("user");
    sessionStorage.removeItem("session_token");
    delete api.defaults.headers.common["Authorization"];
  };

  const INACTIVITY_LIMIT_MS = 6 * 60 * 60 * 1000;
  const LAST_ACTIVE_KEY = 'taskosphere_last_active';

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!isKeepSignedIn() && localStorage.getItem('token')) localStorage.setItem('taskosphere_tab_closed', Date.now().toString());
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    if (!user || isKeepSignedIn()) return;
    const updateActivity = () => localStorage.setItem(LAST_ACTIVE_KEY, Date.now().toString());
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach(e => window.addEventListener(e, updateActivity, { passive: true }));
    updateActivity();
    const interval = setInterval(() => {
      const lastActive = parseInt(localStorage.getItem(LAST_ACTIVE_KEY) || '0', 10);
      if (Date.now() - lastActive > INACTIVITY_LIMIT_MS) logout();
    }, 60 * 1000);
    return () => {
      events.forEach(e => window.removeEventListener(e, updateActivity));
      clearInterval(interval);
    };
  }, [user]);

  useEffect(() => {
    const restoreSession = async () => {
      const { token, storedUser } = getStoredAuth();
      if (!token || !storedUser) {
        setLoading(false);
        return;
      }

      const navType = window.performance?.getEntriesByType?.('navigation')?.[0]?.type ?? (window.performance?.navigation?.type === 1 ? 'reload' : 'navigate');
      const isReload = navType === 'reload';
      const tabClosedAt = localStorage.getItem('taskosphere_tab_closed');
      if (tabClosedAt && localStorage.getItem('token')) {
        localStorage.removeItem('taskosphere_tab_closed');
        if (!isKeepSignedIn() && !isReload) {
          clearStorage();
          setLoading(false);
          return;
        }
      }

      try {
        const parsedUser = normalizeTenantContext(JSON.parse(storedUser));
        api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
        const meRes = await api.get("/auth/me");
        const freshUser = normalizeTenantContext(meRes.data);

        try {
          const syncRes = await api.post("/auth/sync-permissions", {}, { _silent: true });
          if (syncRes?.data?.permissions) freshUser.permissions = normalizePermissions(syncRes.data.permissions);
        } catch (_) {}

        const storage = localStorage.getItem("token") ? localStorage : sessionStorage;
        storage.setItem("user", JSON.stringify(freshUser));
        setUser(freshUser);
        autoAuthenticateAgent(token, freshUser.id).catch(() => {});
      } catch (error) {
        if (error.message === "Network Error") {
          console.warn("Backend unreachable, keeping stored session.");
          setUser(normalizeTenantContext(JSON.parse(storedUser)));
        } else if (error.response && error.response.status === 401) {
          console.warn("Token expired.");
          clearStorage();
          setUser(null);
        } else {
          console.error("Session restore error:", error);
        }
      } finally {
        setLoading(false);
      }
    };
    restoreSession();
  }, []);

  const login = (responseData, rememberMe = false) => {
    const token = responseData?.access_token || responseData?.token;
    const userData = responseData?.user || responseData?.data?.user;
    const sessionToken = responseData?.session_token || responseData?.data?.session_token || null;
    if (!token || !userData) {
      console.error("Invalid login response:", responseData);
      return false;
    }
    const normalizedUser = normalizeTenantContext(userData);
    persistAuth(token, normalizedUser, rememberMe, sessionToken);
    setUser(normalizedUser);
    autoAuthenticateAgent(token, normalizedUser.id).catch(() => {});
    return true;
  };

  const logout = async () => {
    const sessionToken = localStorage.getItem("session_token") || sessionStorage.getItem("session_token");
    try {
      window.__STOP_ACTIVITY__ = true;
      try {
        await api.post("/auth/logout", { session_token: sessionToken || undefined });
      } catch (revokeErr) {
        console.warn("Session revoke on logout failed (non-fatal).", revokeErr);
      }
      resetAgentAuth();
      clearStorage();
      setUser(null);
    } catch (e) {
      console.error("Logout error", e);
      resetAgentAuth();
      clearStorage();
      setUser(null);
    }
  };

  const refreshUser = useCallback(async () => {
    try {
      const response = await api.get("/auth/me");
      const updatedUser = normalizeTenantContext(response.data);
      const isLocal = !!localStorage.getItem("token");
      const storage = isLocal ? localStorage : sessionStorage;
      storage.setItem("user", JSON.stringify(updatedUser));
      setUser(updatedUser);
      console.log("User context synchronized with database.");
    } catch (error) {
      console.error("Failed to refresh user:", error);
    }
  }, []);

  const hasPermission = (permission) => {
    if (!user) return false;
    if (user.role?.toLowerCase() === "admin") return true;
    const perms = user.permissions || {};
    return typeof perms[permission] === "boolean" ? perms[permission] : false;
  };

  const hasAnyPermission = (...permissionList) => {
    if (!user) return false;
    if (user.role?.toLowerCase() === "admin") return true;
    return permissionList.some(p => user.permissions?.[p] === true);
  };

  const canAccessUser = (permissionKey, targetUserId) => {
    if (!user) return false;
    if (user.role?.toLowerCase() === "admin") return true;
    const allowedIds = (user.permissions || {})[permissionKey];
    return Array.isArray(allowedIds) && allowedIds.includes(targetUserId);
  };

  const isOwner = (ownerId) => {
    if (!user) return false;
    return ownerId === user.id;
  };

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      company: user?.company || null,
      companyId: user?.company_id || null,
      subscription: user?.subscription || null,
      login,
      logout,
      refreshUser,
      hasPermission,
      hasAnyPermission,
      canAccessUser,
      isOwner,
    }}>
      {children}
    </AuthContext.Provider>
  );
};
