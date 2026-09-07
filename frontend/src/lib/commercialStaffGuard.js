import api from './api';

// Existing Users UI still posts to /auth/register. Keep that feature intact,
// but route new staff/manager creation for licensed company admins through the
// commercial onboarding workflow so the company name is verified server-side.
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
