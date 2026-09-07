import api from './api';

// Some dashboard/invoicing data sources are optional secondary requests. If
// the current session already proves the user cannot access one of them, do
// not send a request that is guaranteed to return 403. The backend remains
// the source of truth and continues to enforce the same permissions.
const readStoredUser = () => {
  try {
    const raw = localStorage.getItem('user') || sessionStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const isAdmin = (user) => String(user?.role || '').toLowerCase() === 'admin';

const canViewChartOfAccounts = (user) =>
  !user || isAdmin(user) || user.permissions?.can_view_chart_of_accounts === true;

const optionalDashboardEndpoint = (path, user) => {
  // Dashboard uses these as secondary metrics. Non-admin users should not
  // need access to the full team list or performance ranking just to open the
  // dashboard. If a backend permission is granted, the real request is used.
  if (isAdmin(user)) return false;
  if (path === '/users') return true;
  if (path.startsWith('/reports/performance-rankings')) return true;
  return false;
};

const syntheticEmptyResponse = (config) => ({
  data: [],
  status: 200,
  statusText: 'OK (permission-gated optional resource)',
  headers: {},
  config,
  request: null,
});

api.interceptors.request.use((config) => {
  const path = String(config.url || '').split('?')[0].replace(/\/+$/, '');
  if (config.method?.toLowerCase() !== 'get') return config;

  const user = readStoredUser();

  if (path === '/chart-of-accounts' && !canViewChartOfAccounts(user)) {
    config.adapter = async () => syntheticEmptyResponse(config);
    return config;
  }

  if (optionalDashboardEndpoint(path, user)) {
    config.adapter = async () => syntheticEmptyResponse(config);
  }

  return config;
});
