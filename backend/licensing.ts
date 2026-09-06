import crypto from "crypto";
import fs from "fs";
import path from "path";

type PackageDefinition = {
  id: string;
  code: string;
  name: string;
  description: string;
  modules: string[];
  max_users: number;
  max_installations: number;
  validity_days: number;
  price: number;
  active: boolean;
};

type Customer = {
  id: string;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  created_at: string;
};

type Activation = {
  installation_id: string;
  installation_name: string;
  activated_at: string;
  last_seen_at: string;
  status: "active" | "revoked";
};

type License = {
  id: string;
  license_key: string;
  customer_id: string;
  customer_name: string;
  package_id: string;
  package_code: string;
  package_name: string;
  modules: string[];
  status: "active" | "suspended" | "revoked";
  issued_at: string;
  expires_at: string | null;
  max_users: number;
  max_installations: number;
  activations: Activation[];
  last_validated_at: string | null;
  last_event_at?: string;
  created_by: string;
};

type Store = {
  packages: PackageDefinition[];
  customers: Customer[];
  licenses: License[];
};

export const DEFAULT_LICENSE_PACKAGES: PackageDefinition[] = [
  { id: "essential", code: "TSO-ESSENTIAL", name: "Taskosphere Essential", description: "Task Management + Invoicing", modules: ["TASKS", "INVOICING"], max_users: 10, max_installations: 1, validity_days: 365, price: 0, active: true },
  { id: "professional", code: "TSO-PRO", name: "Taskosphere Professional", description: "Task Management + Invoicing + HRMS", modules: ["TASKS", "INVOICING", "HRMS"], max_users: 25, max_installations: 2, validity_days: 365, price: 0, active: true },
  { id: "enterprise", code: "TSO-ENTERPRISE", name: "Taskosphere Enterprise", description: "Task Management + Invoicing + Accounting + HRMS", modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS"], max_users: 100, max_installations: 5, validity_days: 365, price: 0, active: true },
];

const STORE_PATH = process.env.LICENSE_STORE_PATH || path.join(process.cwd(), "backend", ".data", "licenses.json");
const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function emptyStore(): Store { return { packages: DEFAULT_LICENSE_PACKAGES, customers: [], licenses: [] }; }
function ensureStoreDir() { fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true }); }
function persistStore(store: Store) {
  ensureStoreDir();
  const tempPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tempPath, STORE_PATH);
}
function loadStore(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      packages: Array.isArray(parsed.packages) && parsed.packages.length ? parsed.packages : DEFAULT_LICENSE_PACKAGES,
      customers: Array.isArray(parsed.customers) ? parsed.customers : [],
      licenses: Array.isArray(parsed.licenses) ? parsed.licenses : [],
    };
  } catch {
    const store = emptyStore();
    persistStore(store);
    return store;
  }
}
function randomPart(length = 4) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (value) => LICENSE_ALPHABET[value % LICENSE_ALPHABET.length]).join("");
}
function generateUniqueKey(existing: License[]) {
  let key = "";
  do key = `TSO-${randomPart()}-${randomPart()}-${randomPart()}-${randomPart()}`;
  while (existing.some((license) => license.license_key === key));
  return key;
}
function addDays(date: Date, days: number) { return new Date(date.getTime() + days * 86400000).toISOString(); }
function publicLicense(license: License) { return { ...license }; }

export function listLicenseState() {
  const store = loadStore();
  return { packages: store.packages, customers: store.customers, licenses: store.licenses.map(publicLicense) };
}

export function createLicense(input: any) {
  const store = loadStore();
  const pkg = store.packages.find((item) => item.id === input.package_id && item.active);
  if (!pkg) throw new Error("Selected package does not exist or is inactive.");
  const companyName = String(input.company_name || "").trim();
  if (!companyName) throw new Error("Company name is required.");

  const customerId = String(input.customer_id || `cus-${Date.now()}-${randomPart(5)}`);
  const existingCustomer = store.customers.find((customer) => customer.id === customerId);
  const customer: Customer = existingCustomer || {
    id: customerId,
    company_name: companyName,
    contact_name: String(input.contact_name || "").trim(),
    email: String(input.email || "").trim(),
    phone: String(input.phone || "").trim(),
    created_at: new Date().toISOString(),
  };
  if (!existingCustomer) store.customers.unshift(customer);

  const issuedAt = new Date();
  const validityDays = Number(input.validity_days ?? pkg.validity_days);
  const license: License = {
    id: `lic-${Date.now()}-${randomPart(6)}`,
    license_key: generateUniqueKey(store.licenses),
    customer_id: customer.id,
    customer_name: customer.company_name,
    package_id: pkg.id,
    package_code: pkg.code,
    package_name: pkg.name,
    modules: [...pkg.modules],
    status: "active",
    issued_at: issuedAt.toISOString(),
    expires_at: validityDays === 0 ? null : addDays(issuedAt, validityDays),
    max_users: Math.max(1, Number(input.max_users || pkg.max_users)),
    max_installations: Math.max(1, Number(input.max_installations || pkg.max_installations)),
    activations: [],
    last_validated_at: null,
    created_by: "master-admin",
  };
  store.licenses.unshift(license);
  persistStore(store);
  return publicLicense(license);
}

export function updateLicenseStatus(id: string, status: License["status"]) {
  const store = loadStore();
  const license = store.licenses.find((item) => item.id === id);
  if (!license) throw new Error("License not found.");
  license.status = status;
  license.last_event_at = new Date().toISOString();
  persistStore(store);
  return publicLicense(license);
}

export function upgradeLicense(id: string, packageId: string) {
  const store = loadStore();
  const license = store.licenses.find((item) => item.id === id);
  const pkg = store.packages.find((item) => item.id === packageId && item.active);
  if (!license || !pkg) throw new Error("License or package not found.");
  license.package_id = pkg.id;
  license.package_code = pkg.code;
  license.package_name = pkg.name;
  license.modules = [...pkg.modules];
  license.max_users = pkg.max_users;
  license.max_installations = pkg.max_installations;
  license.last_event_at = new Date().toISOString();
  persistStore(store);
  return publicLicense(license);
}

export function savePackage(input: PackageDefinition) {
  const store = loadStore();
  const normalized = { ...input, modules: [...input.modules] };
  const index = store.packages.findIndex((item) => item.id === normalized.id);
  if (index >= 0) store.packages[index] = normalized;
  else store.packages.push(normalized);
  persistStore(store);
  return normalized;
}

function findLicense(licenseKey: string) {
  const normalized = String(licenseKey || "").trim().toUpperCase();
  if (!normalized) return null;
  const store = loadStore();
  return { store, license: store.licenses.find((item) => item.license_key === normalized) || null };
}
function expiryReason(license: License) {
  if (license.status !== "active") return `License is ${license.status}`;
  if (license.expires_at && new Date(license.expires_at).getTime() < Date.now()) return "License expired";
  return null;
}
export function validateLicense(licenseKey: string) {
  const result = findLicense(licenseKey);
  if (!result?.license) return { valid: false, reason: "License not found" };
  const reason = expiryReason(result.license);
  if (reason) return { valid: false, reason, license: publicLicense(result.license) };
  return { valid: true, license: publicLicense(result.license) };
}

export function activateLicense(licenseKey: string, installationId: string, installationName = "Taskosphere Installation") {
  const result = findLicense(licenseKey);
  if (!result?.license) throw new Error("License not found.");
  const { store, license } = result;
  const reason = expiryReason(license);
  if (reason) throw new Error(reason);
  if (!installationId) throw new Error("Installation ID is required.");

  const now = new Date().toISOString();
  const existing = license.activations.find((item) => item.installation_id === installationId);
  if (existing) {
    existing.last_seen_at = now;
    existing.status = "active";
  } else {
    const activeInstallations = license.activations.filter((item) => item.status === "active").length;
    if (activeInstallations >= license.max_installations) throw new Error(`Installation limit reached (${license.max_installations}).`);
    license.activations.push({ installation_id: installationId, installation_name: String(installationName || "Taskosphere Installation"), activated_at: now, last_seen_at: now, status: "active" });
  }
  license.last_validated_at = now;
  persistStore(store);
  return { valid: true, license: publicLicense(license), activation: license.activations.find((item) => item.installation_id === installationId) };
}

export function heartbeatLicense(licenseKey: string, installationId: string) {
  const result = findLicense(licenseKey);
  if (!result?.license) return { valid: false, reason: "License not found" };
  const { store, license } = result;
  const reason = expiryReason(license);
  if (reason) return { valid: false, reason };
  const activation = license.activations.find((item) => item.installation_id === installationId && item.status === "active");
  if (!activation) return { valid: false, reason: "Installation is not activated" };
  activation.last_seen_at = new Date().toISOString();
  license.last_validated_at = activation.last_seen_at;
  persistStore(store);
  return { valid: true, license: publicLicense(license), activation };
}

export function revokeInstallation(licenseId: string, installationId: string) {
  const store = loadStore();
  const license = store.licenses.find((item) => item.id === licenseId);
  if (!license) throw new Error("License not found.");
  const activation = license.activations.find((item) => item.installation_id === installationId);
  if (!activation) throw new Error("Installation not found.");
  activation.status = "revoked";
  activation.last_seen_at = new Date().toISOString();
  persistStore(store);
  return publicLicense(license);
}

export function moduleForApiPath(pathname: string) {
  const value = pathname.replace(/^\/api/, "").replace(/^\//, "");
  if (/^(tasks|todos|attendance|reminders|action-center|visits|ai-reader|dashboard)/.test(value)) return "TASKS";
  if (/^(invoicing|invoices)/.test(value)) return "INVOICING";
  if (/^(purchase|purchase-invoices|bank-accounts|bank-transactions|chart-of-accounts|journal-entries|accounting-reports|zero-touch-entry|gst-portal-sync|accounting-integrity|day-book|cash-bank-book|cash-flow|outstanding-report|bank-reconciliation|depreciation|tds-tcs|financial-ratios|comparative-report|yearly-report|opening-balances|accounting-audit-trail|bulk-import)/.test(value)) return "ACCOUNTING";
  if (/^(leave|payroll|hr|recruitment|people-matrix|staff-activity|users)/.test(value)) return "HRMS";
  return null;
}
