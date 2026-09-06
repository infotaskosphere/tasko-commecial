const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "taskosphere_commercial";
const SESSION_TTL_DAYS = Number(process.env.SAAS_SESSION_TTL_DAYS || 30);
const BOOTSTRAP_EMAIL = String(process.env.SAAS_BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
const BOOTSTRAP_PASSWORD = String(process.env.SAAS_BOOTSTRAP_ADMIN_PASSWORD || "");
const BOOTSTRAP_COMPANY = String(process.env.SAAS_BOOTSTRAP_COMPANY_NAME || "Taskosphere Commercial").trim();
const BOOTSTRAP_PACKAGE = String(process.env.SAAS_BOOTSTRAP_PACKAGE_ID || "professional").trim();

let client = null;
let db = null;
let bootstrapPromise = null;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function makePasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const actual = Buffer.from(hashPassword(password, record.salt), "hex");
  const expected = Buffer.from(record.hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(user, company, subscription) {
  return {
    id: String(user._id),
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    permissions: user.permissions || {},
    company_id: String(user.company_id),
    company: company ? { id: String(company._id), name: company.name, slug: company.slug, status: company.status } : null,
    subscription: subscription ? {
      package_id: subscription.package_id,
      status: subscription.status,
      modules: subscription.modules,
      max_users: subscription.max_users,
      max_installations: subscription.max_installations,
      starts_at: subscription.starts_at,
      expires_at: subscription.expires_at
    } : null
  };
}

async function getDb() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  if (db) return db;
  if (!client) {
    client = new MongoClient(MONGODB_URI, { maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20) });
    await client.connect();
    db = client.db(MONGODB_DB_NAME);
  }
  return db;
}

function packageDefinition(packageId) {
  const packages = {
    essential: { max_users: 10, max_installations: 1, modules: ["TASKS", "INVOICING"] },
    professional: { max_users: 25, max_installations: 2, modules: ["TASKS", "INVOICING", "HRMS"] },
    enterprise: { max_users: 100, max_installations: 5, modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS"] }
  };
  return packages[packageId] || packages.professional;
}

async function ensureBootstrap() {
  if (!BOOTSTRAP_EMAIL || !BOOTSTRAP_PASSWORD) return;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const database = await getDb();
    const companies = database.collection("companies");
    const users = database.collection("users");
    const subscriptions = database.collection("subscriptions");

    const existing = await users.findOne({ email: BOOTSTRAP_EMAIL });

    // The bootstrap account is controlled by the bootstrap environment
    // variables. If the account already exists, synchronize its password so
    // changing SAAS_BOOTSTRAP_ADMIN_PASSWORD can recover the initial admin
    // without requiring a manual MongoDB password-hash edit.
    if (existing) {
      if (existing.role !== "admin" && existing.bootstrap_managed !== true) return;

      const passwordRecord = makePasswordRecord(BOOTSTRAP_PASSWORD);
      await users.updateOne(
        { _id: existing._id },
        {
          $set: {
            password_hash: passwordRecord.hash,
            password_salt: passwordRecord.salt,
            role: "admin",
            status: "active",
            bootstrap_managed: true,
            updated_at: new Date()
          }
        }
      );

      if (existing.company_id) {
        await companies.updateOne(
          { _id: existing.company_id },
          { $set: { status: "active", updated_at: new Date() } }
        );

        const subscription = await subscriptions.findOne({ company_id: existing.company_id });
        if (!subscription) {
          const now = new Date();
          const pkg = packageDefinition(BOOTSTRAP_PACKAGE);
          await subscriptions.insertOne({
            company_id: existing.company_id,
            package_id: BOOTSTRAP_PACKAGE,
            status: "active",
            max_users: pkg.max_users,
            max_installations: pkg.max_installations,
            modules: pkg.modules,
            starts_at: now,
            expires_at: new Date(now.getTime() + 365 * 86400000),
            created_at: now,
            updated_at: now
          });
        }
      }
      return;
    }

    const now = new Date();
    const slugBase = BOOTSTRAP_COMPANY.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "taskosphere-commercial";
    const company = { name: BOOTSTRAP_COMPANY, slug: slugBase, status: "active", created_at: now, updated_at: now };
    const companyResult = await companies.insertOne(company);
    const companyId = companyResult.insertedId;
    const passwordRecord = makePasswordRecord(BOOTSTRAP_PASSWORD);
    const user = {
      company_id: companyId,
      email: BOOTSTRAP_EMAIL,
      full_name: "Commercial Admin",
      password_hash: passwordRecord.hash,
      password_salt: passwordRecord.salt,
      role: "admin",
      permissions: {},
      status: "active",
      bootstrap_managed: true,
      created_at: now,
      updated_at: now
    };
    await users.insertOne(user);
    const pkg = packageDefinition(BOOTSTRAP_PACKAGE);
    await subscriptions.insertOne({
      company_id: companyId,
      package_id: BOOTSTRAP_PACKAGE,
      status: "active",
      max_users: pkg.max_users,
      max_installations: pkg.max_installations,
      modules: pkg.modules,
      starts_at: now,
      expires_at: new Date(now.getTime() + 365 * 86400000),
      created_at: now,
      updated_at: now
    });
  })().finally(() => {
    // Keep this as a concurrency guard, not a permanent cache. If the
    // bootstrap account is removed or needs recovery after a restart, the
    // next login can safely re-check and bootstrap it again.
    bootstrapPromise = null;
  });

  return bootstrapPromise;
}

async function findSession(token) {
  if (!token) return null;
  const database = await getDb();
  const session = await database.collection("sessions").findOne({ token_hash: hashToken(token), expires_at: { $gt: new Date() } });
  if (!session) return null;
  const user = await database.collection("users").findOne({ _id: session.user_id, status: "active" });
  if (!user) return null;
  const company = await database.collection("companies").findOne({ _id: user.company_id, status: "active" });
  if (!company) return null;
  const subscription = await database.collection("subscriptions").findOne({ company_id: user.company_id });
  await database.collection("sessions").updateOne({ _id: session._id }, { $set: { last_seen_at: new Date() } });
  return { session, user, company, subscription };
}

async function login(email, password) {
  await ensureBootstrap();
  const database = await getDb();
  const user = await database.collection("users").findOne({ email: String(email || "").trim().toLowerCase(), status: "active" });
  if (!user || !verifyPassword(String(password || ""), user)) return null;
  const company = await database.collection("companies").findOne({ _id: user.company_id, status: "active" });
  const subscription = await database.collection("subscriptions").findOne({ company_id: user.company_id });
  if (!company || !subscription || !["trial", "active"].includes(subscription.status) || new Date(subscription.expires_at) <= new Date()) return null;

  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await database.collection("sessions").insertOne({
    user_id: user._id,
    company_id: user.company_id,
    token_hash: hashToken(token),
    expires_at: new Date(now.getTime() + SESSION_TTL_DAYS * 86400000),
    created_at: now,
    last_seen_at: now
  });
  return { access_token: token, user: publicUser(user, company, subscription) };
}

async function logout(token) {
  if (!token || !MONGODB_URI) return;
  const database = await getDb();
  await database.collection("sessions").deleteOne({ token_hash: hashToken(token) });
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function attach(app) {
  if (!app || app.__taskosphereSaasAuthAttached) return;
  app.__taskosphereSaasAuthAttached = true;

  app.use(async (req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    if (["/api/health", "/api/auth/login"].includes(req.path)) return next();

    try {
      const session = await findSession(bearerToken(req));
      if (!session) return sendJson(res, 401, { detail: "Authentication required" });
      req.saas = session;
      return next();
    } catch (error) {
      console.error("SaaS authentication error:", error);
      return sendJson(res, 503, { detail: "Commercial authentication service unavailable" });
    }
  });

  app.use(async (req, res, next) => {
    if (!req.path.startsWith("/api/auth/")) return next();
    try {
      if (req.path === "/api/auth/login" && req.method === "POST") {
        if (!MONGODB_URI) return sendJson(res, 503, { detail: "Commercial SaaS database is not configured" });
        const result = await login(req.body?.email, req.body?.password);
        if (!result) return sendJson(res, 401, { detail: "Invalid email or password" });
        return sendJson(res, 200, result);
      }
      if (req.path === "/api/auth/me" && req.method === "GET") {
        return sendJson(res, 200, publicUser(req.saas.user, req.saas.company, req.saas.subscription));
      }
      if (req.path === "/api/auth/logout" && req.method === "POST") {
        await logout(bearerToken(req));
        return sendJson(res, 200, { success: true });
      }
      if (req.path === "/api/auth/sync-permissions" && req.method === "POST") {
        return sendJson(res, 200, { permissions: req.saas.user.permissions || {} });
      }
      return next();
    } catch (error) {
      console.error("SaaS auth route error:", error);
      return sendJson(res, 500, { detail: "Authentication request failed" });
    }
  });
}

module.exports = { attach };
