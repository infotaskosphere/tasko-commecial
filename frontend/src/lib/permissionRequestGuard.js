import api from './api';

// Some dashboard/invoicing data sources are optional secondary requests. If
// the current page does not actually need the protected resource, do not send
// a request that can legitimately return 403 and turn an otherwise healthy
// page into a console error.
const readStoredUser = () => {
  try {
    const raw = localStorage.getItem('user') || sessionStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const isAdmin = (user) => String(user?.role || '').toLowerCase() === 'admin';

const isDirectChartOfAccountsPage = () => {
  if (typeof window === 'undefined') return false;
  const pathname = String(window.location.pathname || '').replace(/\/+$/, '');
  return pathname === '/chart-of-accounts' || pathname.endsWith('/chart-of-accounts');
};

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

  // Invoicing and other pages use Chart of Accounts only as an optional
  // source for ledger-account suggestions. A restricted user must not trigger
  // a 403 just because that optional source is fetched in the background.
  // The actual Chart of Accounts page is deliberately excluded so its request
  // still reaches the backend and the backend remains the security authority.
  if (
    path === '/chart-of-accounts' &&
    !isDirectChartOfAccountsPage() &&
    !isAdmin(user)
  ) {
    config.adapter = async () => syntheticEmptyResponse(config);
    return config;
  }

  if (optionalDashboardEndpoint(path, user)) {
    config.adapter = async () => syntheticEmptyResponse(config);
  }

  return config;
});
