import api from './api';

// Existing Users UI still posts to /auth/register. Only licensed company
// admins are routed through the commercial onboarding endpoint. Internal
// platform owners continue using the existing user-creation process.
const PLATFORM_OWNER_EMAILS = new Set(['info.taskosphere@gmail.com']);

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
  const email = String(user?.email || '').trim().toLowerCase();
  if (PLATFORM_OWNER_EMAILS.has(email)) return config;
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
