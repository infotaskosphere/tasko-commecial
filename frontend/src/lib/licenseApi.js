const STORAGE_KEY = "taskosphere_master_console_state_v1";

export const DEFAULT_PACKAGES = [
  {
    id: "essential",
    code: "TSO-ESSENTIAL",
    name: "Taskosphere Essential",
    description: "Task Management + Invoicing",
    modules: ["TASKS", "INVOICING"],
    max_users: 10,
    max_installations: 1,
    validity_days: 365,
    price: 0,
    active: true,
  },
  {
    id: "professional",
    code: "TSO-PRO",
    name: "Taskosphere Professional",
    description: "Task Management + Invoicing + HRMS",
    modules: ["TASKS", "INVOICING", "HRMS"],
    max_users: 25,
    max_installations: 2,
    validity_days: 365,
    price: 0,
    active: true,
  },
  {
    id: "enterprise",
    code: "TSO-ENTERPRISE",
    name: "Taskosphere Enterprise",
    description: "Task Management + Invoicing + Accounting + HRMS",
    modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS"],
    max_users: 100,
    max_installations: 5,
    validity_days: 365,
    price: 0,
    active: true,
  },
];

const emptyState = () => ({ packages: DEFAULT_PACKAGES, licenses: [], customers: [] });

const readState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return {
      packages: Array.isArray(parsed.packages) && parsed.packages.length ? parsed.packages : DEFAULT_PACKAGES,
      licenses: Array.isArray(parsed.licenses) ? parsed.licenses : [],
      customers: Array.isArray(parsed.customers) ? parsed.customers : [],
    };
  } catch {
    return emptyState();
  }
};

const writeState = (state) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new CustomEvent("taskosphere-license-state-changed"));
  return state;
};

const randomPart = (length = 4) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
};

export const generateLicenseKey = () =>
  `TSO-${randomPart()}-${randomPart()}-${randomPart()}-${randomPart()}`;

const addDays = (date, days) => new Date(date.getTime() + days * 86400000).toISOString();

export const getLicenseState = () => readState();

export const createLicense = (input) => {
  const state = readState();
  const pkg = state.packages.find((item) => item.id === input.package_id);
  if (!pkg) throw new Error("Selected package does not exist.");

  const customerId = input.customer_id || `cus-${Date.now()}`;
  const customer = {
    id: customerId,
    company_name: input.company_name.trim(),
    contact_name: input.contact_name?.trim() || "",
    email: input.email?.trim() || "",
    phone: input.phone?.trim() || "",
    created_at: new Date().toISOString(),
  };

  const existingCustomer = state.customers.find((item) => item.id === customerId);
  if (!existingCustomer) state.customers.unshift(customer);

  const issuedAt = new Date();
  const expiresAt = input.validity_days === 0 ? null : addDays(issuedAt, Number(input.validity_days || pkg.validity_days));
  const license = {
    id: `lic-${Date.now()}-${randomPart(6)}`,
    license_key: generateLicenseKey(),
    customer_id: customerId,
    customer_name: customer.company_name,
    package_id: pkg.id,
    package_code: pkg.code,
    package_name: pkg.name,
    modules: [...pkg.modules],
    status: "active",
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt,
    max_users: Number(input.max_users || pkg.max_users),
    max_installations: Number(input.max_installations || pkg.max_installations),
    activations: [],
    last_validated_at: null,
    created_by: "master-admin",
  };

  state.licenses.unshift(license);
  writeState(state);
  return license;
};

export const updateLicenseStatus = (id, status) => {
  const state = readState();
  const license = state.licenses.find((item) => item.id === id);
  if (!license) throw new Error("License not found.");
  license.status = status;
  license.last_event_at = new Date().toISOString();
  writeState(state);
  return license;
};

export const upgradeLicense = (id, packageId) => {
  const state = readState();
  const license = state.licenses.find((item) => item.id === id);
  const pkg = state.packages.find((item) => item.id === packageId);
  if (!license || !pkg) throw new Error("License or package not found.");
  license.package_id = pkg.id;
  license.package_code = pkg.code;
  license.package_name = pkg.name;
  license.modules = [...pkg.modules];
  license.max_users = pkg.max_users;
  license.max_installations = pkg.max_installations;
  license.last_event_at = new Date().toISOString();
  writeState(state);
  return license;
};

export const savePackage = (pkg) => {
  const state = readState();
  const normalized = { ...pkg, modules: [...pkg.modules] };
  const index = state.packages.findIndex((item) => item.id === normalized.id);
  if (index >= 0) state.packages[index] = normalized;
  else state.packages.push(normalized);
  writeState(state);
  return normalized;
};

export const validateLicenseLocally = (licenseKey) => {
  const state = readState();
  const license = state.licenses.find((item) => item.license_key === licenseKey.trim().toUpperCase());
  if (!license) return { valid: false, reason: "License not found" };
  if (license.status !== "active") return { valid: false, reason: `License is ${license.status}` };
  if (license.expires_at && new Date(license.expires_at) < new Date()) return { valid: false, reason: "License expired" };
  return { valid: true, license };
};

export const subscribeLicenseState = (callback) => {
  const handler = () => callback(readState());
  window.addEventListener("taskosphere-license-state-changed", handler);
  return () => window.removeEventListener("taskosphere-license-state-changed", handler);
};
