import fs from "fs";
import path from "path";
import { moduleForApiPath } from "./licensing";

export type EnforcementStatus = {
  valid: boolean;
  reason?: string;
  license?: any;
  checked_at: string;
};

type ActivationState = {
  license_key: string;
  installation_id: string;
  installation_name: string;
  activated_at: string;
  last_checked_at: string;
  status: EnforcementStatus;
};

const enabled = String(process.env.LICENSE_ENFORCEMENT || "false").toLowerCase() === "true";
const licensingApiUrl = String(process.env.LICENSE_API_URL || "http://localhost:3100/api").replace(/\/$/, "");
const statePath = process.env.LICENSE_ACTIVATION_PATH || path.join(process.cwd(), "backend", ".data", "activation.json");
const offlineGraceMinutes = Math.max(0, Number(process.env.LICENSE_OFFLINE_GRACE_MINUTES || 120));
const checkIntervalMs = Math.max(15000, Number(process.env.LICENSE_CHECK_INTERVAL_SECONDS || 60) * 1000);

let cachedState: ActivationState | null = null;
let inFlightCheck: Promise<EnforcementStatus> | null = null;

function ensureStateDir() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
}

function readState(): ActivationState | null {
  if (cachedState) return cachedState;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed?.license_key && parsed?.installation_id) {
      cachedState = parsed as ActivationState;
      return cachedState;
    }
  } catch {
    // Activation has not yet been persisted on this installation.
  }
  return null;
}

function writeState(state: ActivationState) {
  ensureStateDir();
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, statePath);
  cachedState = state;
}

async function postJson(endpoint: string, body: Record<string, unknown>) {
  const response = await fetch(`${licensingApiUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  let payload: any = null;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.reason || `Licensing server returned ${response.status}`);
  }
  return payload;
}

export async function activateInstallation(licenseKey: string, installationId: string, installationName: string) {
  const result = await postJson("/licensing/activate", {
    license_key: licenseKey,
    installation_id: installationId,
    installation_name: installationName,
  });

  const now = new Date().toISOString();
  writeState({
    license_key: licenseKey.trim().toUpperCase(),
    installation_id: installationId,
    installation_name: installationName,
    activated_at: now,
    last_checked_at: now,
    status: { valid: true, license: result.license, checked_at: now },
  });
  return result;
}

export function getActivationStatus(): EnforcementStatus {
  if (!enabled) {
    return {
      valid: true,
      reason: "License enforcement is disabled for this environment.",
      license: { modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS"] },
      checked_at: new Date().toISOString(),
    };
  }

  const state = readState();
  if (!state) {
    return { valid: false, reason: "Taskosphere installation is not activated.", checked_at: new Date().toISOString() };
  }
  return state.status;
}

async function refreshStatus(): Promise<EnforcementStatus> {
  const state = readState();
  if (!enabled) return getActivationStatus();
  if (!state) return getActivationStatus();

  try {
    const result = await postJson("/licensing/heartbeat", {
      license_key: state.license_key,
      installation_id: state.installation_id,
    });
    const checkedAt = new Date().toISOString();
    const status: EnforcementStatus = { valid: Boolean(result.valid), reason: result.reason, license: result.license, checked_at: checkedAt };
    writeState({ ...state, last_checked_at: checkedAt, status });
    return status;
  } catch (error: any) {
    const lastChecked = new Date(state.status?.checked_at || state.last_checked_at || 0).getTime();
    const withinGrace = offlineGraceMinutes > 0 && Date.now() - lastChecked <= offlineGraceMinutes * 60000;
    if (withinGrace && state.status?.valid) {
      return { ...state.status, reason: "Licensing server temporarily unavailable; offline grace period active." };
    }
    return { valid: false, reason: error?.message || "Unable to verify license with licensing server.", checked_at: new Date().toISOString() };
  }
}

export async function getFreshStatus(force = false): Promise<EnforcementStatus> {
  if (!enabled) return getActivationStatus();
  const state = readState();
  if (!force && state?.status && Date.now() - new Date(state.status.checked_at).getTime() < checkIntervalMs) {
    return state.status;
  }
  if (!inFlightCheck) {
    inFlightCheck = refreshStatus().finally(() => { inFlightCheck = null; });
  }
  return inFlightCheck;
}

export async function enforceLicenseForPath(pathname: string) {
  if (!enabled) return { allowed: true, status: getActivationStatus() };
  const module = moduleForApiPath(pathname);
  if (!module) return { allowed: true, status: await getFreshStatus(false) };

  const status = await getFreshStatus(false);
  if (!status.valid) return { allowed: false, module, status };

  const modules = Array.isArray(status.license?.modules) ? status.license.modules : [];
  if (!modules.includes(module)) {
    return { allowed: false, module, status: { ...status, reason: `Your license does not include the ${module} module.` } };
  }
  return { allowed: true, module, status };
}

export function getLicenseConfiguration() {
  return {
    enabled,
    licensing_api_url: licensingApiUrl,
    offline_grace_minutes: offlineGraceMinutes,
    check_interval_seconds: Math.round(checkIntervalMs / 1000),
  };
}
