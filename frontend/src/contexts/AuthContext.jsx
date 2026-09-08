import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import api from "../lib/api";
import { autoAuthenticateAgent, resetAgentAuth } from "../lib/agentAutoAuth";

const AuthContext = createContext(null);
export const useAuth = () => { const context = useContext(AuthContext); if (!context) throw new Error("useAuth must be used within an AuthProvider"); return context; };
const isKeepSignedIn = () => localStorage.getItem('taskosphere_keep_signed_in') === 'true';
const PLATFORM_OWNER_EMAIL = "info.taskosphere@gmail.com";

const COMMERCIAL_MODULE_FLAGS = new Set(["can_access_taskosphere", "can_access_finix", "can_access_compliance", "can_access_records", "can_access_proposals", "can_access_people_matrix"]);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const normalizePermissions = (permissions) => permissions && typeof permissions === "object" && !Array.isArray(permissions) ? permissions : {};
  const normalizeTenantContext = (userData) => {
    if (!userData || typeof userData !== "object") return userData;
    return { ...userData, permissions: normalizePermissions(userData.permissions), company_id: userData.company_id ? String(userData.company_id) : null, company: userData.company || null, subscription: userData.subscription || null };
  };
  const getStoredAuth = () => ({ token: localStorage.getItem("token") || sessionStorage.getItem("token"), storedUser: localStorage.getItem("user") || sessionStorage.getItem("user") });
  const persistAuth = (token, userData, rememberMe = false, sessionToken = null) => { const storage = rememberMe ? localStorage : sessionStorage; const normalizedUser = normalizeTenantContext(userData); storage.setItem("token", token); storage.setItem("user", JSON.stringify(normalizedUser)); if (sessionToken) storage.setItem("session_token", sessionToken); api.defaults.headers.common["Authorization"] = `Bearer ${token}`; };
  const clearStorage = () => { ["token", "user", "session_token", "taskosphere_last_active", "taskosphere_tab_closed", "taskosphere_keep_signed_in"].forEach((key) => localStorage.removeItem(key)); ["token", "user", "session_token"].forEach((key) => sessionStorage.removeItem(key)); delete api.defaults.headers.common["Authorization"]; };
  const INACTIVITY_LIMIT_MS = 6 * 60 * 60 * 1000;
  const LAST_ACTIVE_KEY = 'taskosphere_last_active';

  useEffect(() => { const handleBeforeUnload = () => { if (!isKeepSignedIn() && localStorage.getItem('token')) localStorage.setItem('taskosphere_tab_closed', Date.now().toString()); }; window.addEventListener('beforeunload', handleBeforeUnload); return () => window.removeEventListener('beforeunload', handleBeforeUnload); }, []);
  useEffect(() => { if (!user || isKeepSignedIn()) return; const updateActivity = () => localStorage.setItem(LAST_ACTIVE_KEY, Date.now().toString()); const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart']; events.forEach(e => window.addEventListener(e, updateActivity, { passive: true })); updateActivity(); const interval = setInterval(() => { const lastActive = parseInt(localStorage.getItem(LAST_ACTIVE_KEY) || '0', 10); if (Date.now() - lastActive > INACTIVITY_LIMIT_MS) logout(); }, 60 * 1000); return () => { events.forEach(e => window.removeEventListener(e, updateActivity)); clearInterval(interval); }; }, [user]);

  // A licensed customer admin is an operational tenant admin, not the
  // Commercial Control Plane owner. Block both the console and Website Studio
  // at the navigation boundary while preserving all customer admin functions.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const isPlatformOwner = String(user?.email || "").trim().toLowerCase() === PLATFORM_OWNER_EMAIL;
    const isLicensedCustomer = !!user?.company_id && !isPlatformOwner;
    document.body.classList.toggle("licensed-customer-session", isLicensedCustomer);
    const isCommercialPath = () => window.location.pathname === "/master-console" || window.location.pathname.startsWith("/master-console/");
    const redirectIfBlocked = () => { if (!isLicensedCustomer || !isCommercialPath()) return; window.history.replaceState({}, "", "/dashboard"); window.dispatchEvent(new PopStateEvent("popstate")); };
    const handleClick = (event) => { if (!isLicensedCustomer) return; const target = event.target?.closest?.("a[href]"); const href = target?.getAttribute("href") || ""; if (!href.startsWith("/master-console")) return; event.preventDefault(); event.stopPropagation(); window.history.replaceState({}, "", "/dashboard"); window.dispatchEvent(new PopStateEvent("popstate")); };
    redirectIfBlocked(); document.addEventListener("click", handleClick, true); window.addEventListener("popstate", redirectIfBlocked);
    return () => { document.body.classList.remove("licensed-customer-session"); document.removeEventListener("click", handleClick, true); window.removeEventListener("popstate", redirectIfBlocked); };
  }, [user]);

  useEffect(() => {
    const restoreSession = async () => {
      const { token, storedUser } = getStoredAuth();
      if (!token || !storedUser) { setLoading(false); return; }
      const navType = window.performance?.getEntriesByType?.('navigation')?.[0]?.type ?? (window.performance?.navigation?.type === 1 ? 'reload' : 'navigate');
      const isReload = navType === 'reload'; const tabClosedAt = localStorage.getItem('taskosphere_tab_closed');
      if (tabClosedAt && localStorage.getItem('token')) { localStorage.removeItem('taskosphere_tab_closed'); if (!isKeepSignedIn() && !isReload) { clearStorage(); setLoading(false); return; } }
      try { const parsedUser = normalizeTenantContext(JSON.parse(storedUser)); api.defaults.headers.common["Authorization"] = `Bearer ${token}`; const meRes = await api.get("/auth/me"); const freshUser = normalizeTenantContext(meRes.data); const storage = localStorage.getItem("token") ? localStorage : sessionStorage; storage.setItem("user", JSON.stringify(freshUser)); setUser(freshUser); autoAuthenticateAgent(token, freshUser.id).catch(() => {}); }
      catch (error) { if (error.message === "Network Error") setUser(normalizeTenantContext(JSON.parse(storedUser))); else if (error.response && [401, 403].includes(error.response.status)) { clearStorage(); setUser(null); } else console.error("Session restore error:", error); }
      finally { setLoading(false); }
    };
    restoreSession();
  }, []);

  const login = (responseData, rememberMe = false) => { const token = responseData?.access_token || responseData?.token; const userData = responseData?.user || responseData?.data?.user; const sessionToken = responseData?.session_token || responseData?.data?.session_token || null; if (!token || !userData) { console.error("Invalid login response:", responseData); return false; } const normalizedUser = normalizeTenantContext(userData); persistAuth(token, normalizedUser, rememberMe, sessionToken); setUser(normalizedUser); window.__STOP_ACTIVITY__ = false; autoAuthenticateAgent(token, normalizedUser.id).catch(() => {}); return true; };
  const logout = async () => { const sessionToken = localStorage.getItem("session_token") || sessionStorage.getItem("session_token"); window.__STOP_ACTIVITY__ = true; resetAgentAuth(); clearStorage(); setUser(null); try { if (sessionToken) await api.post("/auth/logout", { session_token: sessionToken }, { _silent: true, _skipReadyGate: true }); } catch (error) { console.warn("Session revoke on logout failed (non-fatal).", error); } };
  const refreshUser = useCallback(async () => { try { const response = await api.get("/auth/me"); const updatedUser = normalizeTenantContext(response.data); const storage = localStorage.getItem("token") ? localStorage : sessionStorage; storage.setItem("user", JSON.stringify(updatedUser)); setUser(updatedUser); } catch (error) { console.error("Failed to refresh user:", error); } }, []);
  const isCommercialAdmin = (candidate = user) => String(candidate?.role || "").toLowerCase() === "admin" && !!candidate?.company_id;
  const hasPermission = (permission) => { if (!user) return false; if (isCommercialAdmin()) { if (COMMERCIAL_MODULE_FLAGS.has(permission)) return user.permissions?.[permission] === true; return typeof user.permissions?.[permission] === "boolean" ? user.permissions[permission] : true; } if (user.role?.toLowerCase() === "admin") return true; return typeof (user.permissions || {})[permission] === "boolean" ? user.permissions[permission] : false; };
  const hasAnyPermission = (...permissionList) => permissionList.some((permission) => hasPermission(permission));
  const canAccessUser = (permissionKey, targetUserId) => { if (!user) return false; if (user.role?.toLowerCase() === "admin") return true; const allowedIds = (user.permissions || {})[permissionKey]; return Array.isArray(allowedIds) && allowedIds.includes(targetUserId); };
  const isOwner = (ownerId) => !!user && ownerId === user.id;
  return <AuthContext.Provider value={{ user, loading, company: user?.company || null, companyId: user?.company_id || null, subscription: user?.subscription || null, login, logout, refreshUser, hasPermission, hasAnyPermission, canAccessUser, isOwner }}>{children}</AuthContext.Provider>;
};
