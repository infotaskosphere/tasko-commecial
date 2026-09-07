import api from './api';

// Some pages (notably Invoicing) use Chart of Accounts only as an auxiliary
// data source. A manager/staff user who has not been granted COA access must
// not generate a noisy 403 just because that optional request was attempted.
// The backend remains the source of truth; this guard simply avoids sending
// a request when the current local session already proves the user cannot
// access the resource.
const readStoredUser = () => {
  try {
    const raw = localStorage.getItem('user') || sessionStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const canViewChartOfAccounts = () => {
  const user = readStoredUser();
  if (!user) return true; // Let the normal auth flow decide.
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  return user.permissions?.can_view_chart_of_accounts === true;
};

api.interceptors.request.use((config) => {
  const path = String(config.url || '').split('?')[0].replace(/\/+$/, '');
  if (
    config.method?.toLowerCase() === 'get' &&
    path === '/chart-of-accounts' &&
    !canViewChartOfAccounts()
  ) {
    // Axios cancellation would still surface as a rejected Promise. Instead,
    // return a lightweight synthetic empty response so Promise.allSettled()
    // callers can continue normally and the optional accounts list is simply
    // empty for users without that permission.
    config.adapter = async () => ({
      data: [],
      status: 200,
      statusText: 'OK (permission-gated optional resource)',
      headers: {},
      config,
      request: null,
    });
  }
  return config;
});
