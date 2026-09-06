import express from "express";
import { activateLicense, createLicense, heartbeatLicense, listLicenseState, revokeInstallation, savePackage, updateLicenseStatus, upgradeLicense, validateLicense } from "./backend/licensing";

const app = express();
const PORT = Number(process.env.LICENSE_PORT || 3100);
const MASTER_CONSOLE_TOKEN = process.env.MASTER_CONSOLE_TOKEN || "mock-admin-token";
const ENFORCEMENT_ENABLED = String(process.env.LICENSE_ENFORCEMENT || "false").toLowerCase() === "true";

app.use(express.json());
app.use((req, res, next) => {
  const allowedOrigin = process.env.LICENSE_ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Taskosphere-License, X-Taskosphere-Installation");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const bearer = (req: express.Request) => String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
const requireMasterAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (bearer(req) !== MASTER_CONSOLE_TOKEN) return res.status(401).json({ detail: "Master Console authentication required." });
  next();
};

app.get("/health", (_req, res) => res.json({ status: "ok", service: "taskosphere-licensing", enforcement_enabled: ENFORCEMENT_ENABLED }));

// Public customer-facing validation and activation endpoints.
app.post("/api/licensing/validate", (req, res) => {
  const result = validateLicense(req.body?.license_key);
  return res.status(result.valid ? 200 : 403).json(result);
});

app.post("/api/licensing/activate", (req, res) => {
  try {
    const result = activateLicense(req.body?.license_key, req.body?.installation_id, req.body?.installation_name);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ detail: error?.message || "Activation failed." });
  }
});

app.post("/api/licensing/heartbeat", (req, res) => {
  const result = heartbeatLicense(req.body?.license_key, req.body?.installation_id);
  return res.status(result.valid ? 200 : 403).json(result);
});

// Master Console management endpoints.
app.get("/api/licensing/state", requireMasterAdmin, (_req, res) => res.json(listLicenseState()));
app.post("/api/licensing/licenses", requireMasterAdmin, (req, res) => {
  try { return res.status(201).json(createLicense(req.body || {})); }
  catch (error: any) { return res.status(400).json({ detail: error?.message || "Unable to generate license." }); }
});
app.patch("/api/licensing/licenses/:id/status", requireMasterAdmin, (req, res) => {
  try { return res.json(updateLicenseStatus(req.params.id, req.body?.status)); }
  catch (error: any) { return res.status(400).json({ detail: error?.message || "Unable to update license." }); }
});
app.patch("/api/licensing/licenses/:id/package", requireMasterAdmin, (req, res) => {
  try { return res.json(upgradeLicense(req.params.id, req.body?.package_id)); }
  catch (error: any) { return res.status(400).json({ detail: error?.message || "Unable to upgrade license." }); }
});
app.put("/api/licensing/packages/:id", requireMasterAdmin, (req, res) => {
  try { return res.json(savePackage({ ...req.body, id: req.params.id })); }
  catch (error: any) { return res.status(400).json({ detail: error?.message || "Unable to save package." }); }
});
app.post("/api/licensing/licenses/:licenseId/installations/:installationId/revoke", requireMasterAdmin, (req, res) => {
  try { return res.json(revokeInstallation(req.params.licenseId, req.params.installationId)); }
  catch (error: any) { return res.status(400).json({ detail: error?.message || "Unable to revoke installation." }); }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Taskosphere Licensing] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[Taskosphere Licensing] Enforcement flag: ${ENFORCEMENT_ENABLED ? "enabled" : "disabled"}`);
});
