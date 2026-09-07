import api from './api';

// Existing Users UI still posts to /auth/register. Only licensed company
// admins are routed through the commercial onboarding endpoint. Internal
// admins continue using the existing user-creation process unchanged.
const readStoredUser = () => {
  try {
    const raw = localStorage.getItem('user') || sessionStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

api.interceptors.request.use((config) => {
  const path = String(config.url || '').split('?')[0].replace(/\/+$/, '');
  if (config.method?.toLowerCase() !== 'post' || path !== '/auth/register') return config;

  const user = readStoredUser();
  if (String(user?.role || '').toLowerCase() !== 'admin') return config;
  // A commercial administrator has a company/license context. Do not alter
  // the existing /auth/register workflow for system/internal administrators.
  if (!user?.company_id) return config;

  const payload = typeof config.data === 'string' ? (() => {
    try { return JSON.parse(config.data); } catch { return {}; }
  })() : (config.data || {});

  const role = String(payload.role || 'staff').toLowerCase();
  if (!['staff', 'manager'].includes(role)) return config;

  config.url = '/commercial-onboarding/create-staff';
  config.data = {
    full_name: payload.full_name,
    email: payload.email,
    password: payload.password,
    role,
    company_name: payload.company_name || user.company_name || '',
    company_id: payload.company_id || user.company_id || '',
    departments: payload.departments || [],
    phone: payload.phone || null,
  };
  return config;
});
