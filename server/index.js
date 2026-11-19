const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Firebase Admin init
// On Cloud Run, this automatically uses the service account attached to the
// service (Application Default Credentials) — no key file needed as long as
// that service account has the Firestore + Firebase Messaging + Storage roles.
//
// FIREBASE_STORAGE_BUCKET is required for reload attachment uploads (Section
// 3 below). Find your bucket name in Firebase Console > Storage — it looks
// like "your-project-id.appspot.com" or "your-project-id.firebasestorage.app".
// ---------------------------------------------------------------------------
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined,
});
const db = admin.firestore();
const messaging = admin.messaging();

function getBucket() {
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error("FIREBASE_STORAGE_BUCKET env var is not set — see README for setup");
  }
  return admin.storage().bucket();
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.set("trust proxy", true); // Cloud Run sits behind a proxy — needed for correct https:// URLs
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // Billplz callbacks are form-urlencoded
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Secrets
// - API_KEY / APP_SECRET: can now be changed live from the admin panel
//   (Settings tab) without redeploying — they're stored in Firestore and
//   only fall back to these env vars if no Firestore value exists yet.
// - ADMIN_KEY: a one-time "bootstrap" secret used ONLY to create the very
//   first admin login account. After that, normal username/password login
//   takes over and ADMIN_KEY is no longer used for anything.
// - JWT_SECRET: signs admin login sessions. Set a real random value on
//   deploy — anyone with this could forge admin sessions.
// ---------------------------------------------------------------------------
const ADMIN_BOOTSTRAP_KEY = process.env.ADMIN_KEY || "change-me-admin-key";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-jwt-secret";
const CRON_SECRET = process.env.CRON_SECRET || "change-me-cron-secret";
const JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (for jobs never even dispatched/orphaned)
const DEFAULT_DEVICE_TIMEOUT_SECONDS = 60; // per-device USSD-in-flight timeout, overridable per telco

// =============================================================================
// TELCOS — fully admin-manageable (Settings → Telcos), not hardcoded.
// Cached briefly to avoid a Firestore read on every single request. Existing
// deployments are auto-seeded with the original 4 on first read, so nothing
// breaks — from then on, add/remove telcos entirely from the admin panel,
// no code change or redeploy needed.
// =============================================================================

let telcosCache = { list: null, fetchedAt: 0 };
const TELCOS_CACHE_MS = 30 * 1000;

async function getValidTelcos() {
  const now = Date.now();
  if (telcosCache.list && now - telcosCache.fetchedAt < TELCOS_CACHE_MS) {
    return telcosCache.list;
  }

  const snapshot = await db.collection("telcos").get();
  if (snapshot.empty) {
    const defaults = ["UMOBILE", "MAXIS", "DIGI", "CELCOM"];
    await Promise.all(defaults.map((code) =>
      db.collection("telcos").doc(code).set({
        code,
        name: code,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    ));
    telcosCache = { list: defaults, fetchedAt: now };
    return defaults;
  }

  const list = snapshot.docs.map((doc) => doc.id).sort();
  telcosCache = { list, fetchedAt: now };
  return list;
}

function invalidateTelcosCache() {
  telcosCache.fetchedAt = 0;
}

async function isValidTelco(telco) {
  const list = await getValidTelcos();
  return list.includes(String(telco || "").toUpperCase());
}

// =============================================================================
// PER-DEVICE QUEUE
// Each physical phone can only process one USSD at a time. `devices/{telco}`
// tracks `currentJobId` + `currentJobStartedAt` while a job is in flight.
// New jobs always start as "queued"; this function is called whenever a
// device might have become free (after a callback, a timeout, or a new job
// being created) to pick up the next queued job for that telco, if any.
// =============================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Firestore-backed (not in-memory) so it works correctly even though Cloud
// Run can scale to multiple instances — an in-memory counter would miss
// attempts routed to a different instance.
async function checkRateLimit(bucket, key, maxAttempts, windowMs) {
  const ref = db.collection("rate_limits").doc(`${bucket}:${key}`);
  const now = Date.now();

  return db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    const data = doc.exists ? doc.data() : { count: 0, windowStart: now };

    const windowExpired = now - data.windowStart > windowMs;
    const count = windowExpired ? 1 : data.count + 1;
    const windowStart = windowExpired ? now : data.windowStart;

    t.set(ref, { count, windowStart });

    if (count > maxAttempts) {
      const retryAfterMs = windowStart + windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
    }
    return { allowed: true };
  });
}

async function resetRateLimit(bucket, key) {
  await db.collection("rate_limits").doc(`${bucket}:${key}`).delete().catch(() => {});
}

// Records an admin action for accountability. Fire-and-forget-ish but
// awaited so ordering in the audit trail is reliable.
async function logAudit(actor, action, details) {
  await db.collection("audit_log").add({
    actor,
    action,
    details: details || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Fires once per crossing below the company's threshold (not on every
// subsequent call while already low) — checked right before a job is
// allowed to proceed, using the balance as it stood before this job's
// deduction. Sends a webhook if the company configured one, and always
// logs it either way so it's visible in the admin panel.
async function checkLowBalanceAlert(userId, balanceBeforeThisJob, userData) {
  const threshold = userData.lowBalanceThreshold || 20;
  if (balanceBeforeThisJob > threshold) return; // not low yet
  if (userData.lowBalanceAlerted) return; // already alerted, don't spam

  await db.collection("company_users").doc(userId).update({ lowBalanceAlerted: true });

  const label = userData.companyName || userData.username;
  await appendServerLog(`LOW BALANCE ALERT: ${label} balance is ${balanceBeforeThisJob} (threshold: ${threshold})`, null);

  if (userData.lowBalanceWebhookUrl) {
    fetch(userData.lowBalanceWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "low_balance", company: label, balance: balanceBeforeThisJob, threshold }),
    }).catch((err) => console.error("Low balance webhook failed:", err.message));
  }
}

// Retries an FCM push up to 3 times with short exponential backoff before
// giving up — covers transient network blips without holding up the
// request for too long (max ~3.5s total across all attempts).
async function sendFcmWithRetry(token, data, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await messaging.send({ token, data, android: { priority: "high" } });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

async function tryDispatchNext(groupId, telcoKey, depth = 0) {
  if (depth > 20) return; // safety guard against pathological loops

  const deviceRef = db.collection("devices").doc(deviceDocId(groupId, telcoKey));
  const deviceDoc = await deviceRef.get();
  if (!deviceDoc.exists) return; // no device registered for this telco/group slot

  const deviceData = deviceDoc.data();
  const timeoutSeconds = deviceData.timeoutSeconds || DEFAULT_DEVICE_TIMEOUT_SECONDS;

  if (deviceData.currentJobId) {
    const startedAtMs = deviceData.currentJobStartedAt ? deviceData.currentJobStartedAt.toMillis() : 0;
    const elapsedSeconds = (Date.now() - startedAtMs) / 1000;

    if (elapsedSeconds < timeoutSeconds) {
      return; // still busy, and not stale yet — do nothing
    }

    // Stuck job exceeded this device's timeout — free it up.
    const staleJobRef = db.collection("jobs").doc(deviceData.currentJobId);
    const staleJobDoc = await staleJobRef.get();
    if (staleJobDoc.exists && staleJobDoc.data().status === "pending") {
      await staleJobRef.update({ status: "timeout", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    await deviceRef.update({
      currentJobId: admin.firestore.FieldValue.delete(),
      currentJobStartedAt: admin.firestore.FieldValue.delete(),
    });
  }

  // Device is free now — find the oldest queued job for this exact
  // telco+group slot (groupId may be null, which Firestore equality
  // matches correctly for the shared ungrouped pool).
  const queuedSnapshot = await db.collection("jobs")
    .where("telco", "==", telcoKey)
    .where("groupId", "==", groupId)
    .where("status", "==", "queued")
    .get();

  if (queuedSnapshot.empty) return;

  let oldestDoc = queuedSnapshot.docs[0];
  for (const doc of queuedSnapshot.docs) {
    const a = doc.data().createdAt ? doc.data().createdAt.toMillis() : 0;
    const b = oldestDoc.data().createdAt ? oldestDoc.data().createdAt.toMillis() : 0;
    if (a < b) oldestDoc = doc;
  }

  const nextJobId = oldestDoc.id;
  const nextJobData = oldestDoc.data();

  await db.collection("jobs").doc(nextJobId).update({
    status: "pending",
    installationId: deviceData.installationId || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await deviceRef.update({
    currentJobId: nextJobId,
    currentJobStartedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    await sendFcmWithRetry(deviceData.fcmToken, {
      job_id: nextJobId,
      phone: String(nextJobData.phone),
      amount: String(nextJobData.amount),
      ussd_template: nextJobData.ussdTemplate || "",
    });
  } catch (err) {
    // Couldn't even deliver the push — mark this one failed and try the next
    // queued job instead of leaving the device permanently stuck.
    await db.collection("jobs").doc(nextJobId).update({
      status: "failed",
      rawResponse: "FCM send failed: " + err.message,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await deviceRef.update({
      currentJobId: admin.firestore.FieldValue.delete(),
      currentJobStartedAt: admin.firestore.FieldValue.delete(),
    });
    await tryDispatchNext(groupId, telcoKey, depth + 1);
  }
}

// Called after a job reaches a terminal state (success/failed/timeout) to
// release the device (if this was its current job) and dispatch the next
// queued job, if any.
async function completeJobAndAdvanceQueue(groupId, telcoKey, jobId) {
  if (!telcoKey) return;
  const deviceRef = db.collection("devices").doc(deviceDocId(groupId, telcoKey));
  const deviceDoc = await deviceRef.get();
  if (deviceDoc.exists && deviceDoc.data().currentJobId === jobId) {
    await deviceRef.update({
      currentJobId: admin.firestore.FieldValue.delete(),
      currentJobStartedAt: admin.firestore.FieldValue.delete(),
    });
  }
  await tryDispatchNext(groupId, telcoKey);
}

// =============================================================================
// DOCUMENT NUMBERING — <prefix><yyMM><000>, sequence resets each month.
// Uses a Firestore transaction so concurrent reloads never collide.
// =============================================================================

async function generateDocumentNumber(prefix) {
  const now = new Date();
  const yyMM = String(now.getFullYear()).slice(-2) + String(now.getMonth() + 1).padStart(2, "0");
  const counterId = `${prefix}${yyMM}`;
  const counterRef = db.collection("counters").doc(counterId);

  return db.runTransaction(async (t) => {
    const counterDoc = await t.get(counterRef);
    const nextSeq = counterDoc.exists ? (counterDoc.data().seq || 0) + 1 : 1;
    t.set(counterRef, { seq: nextSeq }, { merge: true });
    return `${counterId}${String(nextSeq).padStart(3, "0")}`;
  });
}

// =============================================================================
// API KEY RESOLUTION for /api/topup
// A key can be either a company user's own named key (api_keys collection,
// tied to credit deduction) or the legacy global key set in Settings
// (no credit tracking — kept for backward compatibility / admin testing).
// =============================================================================

async function resolveApiKey(req, res, next) {
  const key = req.header("x-api-key");
  if (!key) return res.status(401).json({ error: "Missing x-api-key" });

  const companyKeyDoc = await db.collection("api_keys").doc(key).get();
  if (companyKeyDoc.exists && !companyKeyDoc.data().revoked) {
    req.companyUserId = companyKeyDoc.data().userId;
    return next();
  }

  const s = await getSettings();
  if (s.legacyKeyEnabled && key === s.apiKey) {
    req.companyUserId = null; // legacy key — no credit tracking
    return next();
  }

  return res.status(401).json({ error: "Invalid API key" });
}

function generateApiKeyValue() {
  return "ak_" + crypto.randomBytes(24).toString("hex");
}

// =============================================================================
// BILLPLZ INTEGRATION
// Lets a company reload their own credit via FPX / DuitNow Transfer instead
// of waiting for an admin-created reload. See:
// https://support.billplz.com/api
// =============================================================================

function billplzBaseUrl(s) {
  return s.billplzSandbox ? "https://www.billplz-sandbox.com/api" : "https://www.billplz.com/api";
}

// All Billplz API calls authenticate via HTTP Basic Auth using the secret
// key as the username (no password).
async function billplzApiRequest(s, method, path, params) {
  const url = `${billplzBaseUrl(s)}${path}`;
  const auth = Buffer.from(`${s.billplzSecretKey}:`).toString("base64");
  const options = {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
    },
  };

  if (params && (method === "POST" || method === "PUT")) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        value.forEach((v) => body.append(key, v));
      } else if (value !== undefined && value !== null) {
        body.append(key, value);
      }
    }
    options.headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = body;
  }

  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message?.join?.(", ") || data?.error || `Billplz API error (HTTP ${res.status})`;
    throw new Error(message);
  }
  return data;
}

// Builds the pipe-joined, case-insensitively-sorted source string Billplz's
// X Signature algorithm requires, then signs it with HMAC-SHA256.
// `flatParams` must already be a flat { key: value } map — see the two
// callers below for how callback vs redirect params get flattened first.
function computeBillplzSignature(flatParams, xSignatureKey) {
  const pieces = Object.entries(flatParams).map(([k, v]) => `${k}${v === null || v === undefined ? "" : v}`);
  pieces.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const sourceString = pieces.join("|");
  return crypto.createHmac("sha256", xSignatureKey).update(sourceString).digest("hex");
}

// Verifies a callback (server-to-server POST body). Body keys are already
// flat — e.g. { id, collection_id, paid, amount, ... }.
function verifyBillplzCallbackSignature(body, xSignatureKey) {
  const { x_signature, ...rest } = body;
  if (!x_signature) return false;
  const expected = computeBillplzSignature(rest, xSignatureKey);
  return expected === x_signature;
}

// Verifies a redirect (browser GET with nested billplz[...] query params).
// Express parses "billplz[id]=x" into req.query.billplz = { id: 'x', ... }
// — flatten that one level of nesting into "billplzid", "billplzpaid", etc.
// to match Billplz's documented source-string construction.
function verifyBillplzRedirectSignature(billplzQuery, xSignatureKey) {
  if (!billplzQuery || typeof billplzQuery !== "object") return false;
  const { x_signature, ...rest } = billplzQuery;
  if (!x_signature) return false;
  const flat = {};
  for (const [k, v] of Object.entries(rest)) {
    flat[`billplz${k}`] = v;
  }
  const expected = computeBillplzSignature(flat, xSignatureKey);
  return expected === x_signature;
}

// =============================================================================
// CREDIT LEDGER
// Deducts credit atomically and records a "usage" ledger entry. Called only
// when a company-key-triggered job succeeds.
//
// Known limitation: credit is only checked (not reserved) at request time.
// If a company fires many requests in parallel that individually pass the
// balance check but collectively exceed it, the balance can go negative once
// they all succeed. Acceptable for now given this is a dummy/no-payment-
// -gateway system — flag if you want proper reservation-based holds later.
// =============================================================================

async function deductCreditForJob(userId, jobId, jobData) {
  const userRef = db.collection("company_users").doc(userId);
  const chargeAmount = jobData.billedAmount || jobData.amount; // fall back for older jobs pre-markup

  const result = await db.runTransaction(async (t) => {
    const userDoc = await t.get(userRef);
    if (!userDoc.exists) return null;

    const userData = userDoc.data();
    const currentBalance = userData.creditBalance || 0;
    const newBalance = currentBalance - chargeAmount;

    t.update(userRef, { creditBalance: newBalance });

    const ledgerRef = db.collection("credit_ledger").doc();
    t.set(ledgerRef, {
      userId,
      type: "usage",
      amount: chargeAmount,
      balanceAfter: newBalance,
      jobId,
      phone: jobData.phone,
      telco: jobData.telco,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { newBalance, userData };
  });

  // Checked here (post-deduction, right as the balance actually changes)
  // rather than at request time — otherwise a single job that crosses the
  // threshold wouldn't trigger an alert until some later, possibly
  // nonexistent, future request.
  if (result) {
    await checkLowBalanceAlert(userId, result.newBalance, result.userData);
  }
}

// Looks up display names (companyName if set, else username) for a set of
// company_users IDs. Used to attribute USSD Log / Other Log entries to the
// company that triggered them.
async function getCompanyNamesMap(userIds) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const map = {};
  await Promise.all(
    uniqueIds.map(async (id) => {
      const doc = await db.collection("company_users").doc(id).get();
      if (doc.exists) {
        map[id] = doc.data().companyName || doc.data().username;
      }
    })
  );
  return map;
}

// Looks up the admin-entered "Account" label for a set of installation_ids
// (falls back to a shortened installation_id if no label was ever set).
// Used to attribute every log entry to the physical device that handled it.
async function getDeviceAccountsMap(installationIds) {
  const uniqueIds = [...new Set(installationIds.filter(Boolean))];
  const map = {};
  await Promise.all(
    uniqueIds.map(async (id) => {
      const doc = await db.collection("devices_registry").doc(id).get();
      map[id] = doc.exists && doc.data().account ? doc.data().account : `Device ${id.slice(0, 8)}`;
    })
  );
  return map;
}

// Writes a server-side (not app-side) entry into the same "logs" collection
// the Android app uses, so REST-API-triggered activity shows up in the
// admin panel's "Other Logs" section too.
async function appendServerLog(message, jobId) {
  await db.collection("logs").add({
    message,
    jobId: jobId || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Builds a full ledger statement for one company: entries within the date
// range (inclusive), plus Balance B/F (balance right before the range
// starts) and Balance C/F (balance at the end of the range). Used by both
// the company portal and the admin Credit Inquiry tab so the numbers always
// match exactly.
async function getLedgerStatement(userId, from, to) {
  const snapshot = await db.collection("credit_ledger").where("userId", "==", userId).get();

  const all = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      const ms = data.createdAt ? data.createdAt.toMillis() : 0;
      return {
        ledger_id: doc.id,
        type: data.type,
        amount: data.amount,
        balance_after: data.balanceAfter,
        created_at: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        document_number: data.documentNumber || null,
        document_date: data.documentDate || null,
        remarks: data.remarks || null,
        has_attachment: !!data.attachmentPath,
        phone: data.phone || null,
        telco: data.telco || null,
        job_id: data.jobId || null,
        _ms: ms,
      };
    })
    .sort((a, b) => a._ms - b._ms); // ascending for B/F, C/F calculation

  const fromMs = from ? new Date(from + "T00:00:00").getTime() : null;
  const toMs = to ? new Date(to + "T23:59:59").getTime() : null;

  const before = fromMs ? all.filter((e) => e._ms < fromMs) : [];
  const balanceBf = before.length ? before[before.length - 1].balance_after : 0;

  let inRange = all;
  if (fromMs) inRange = inRange.filter((e) => e._ms >= fromMs);
  if (toMs) inRange = inRange.filter((e) => e._ms <= toMs);

  const balanceCf = inRange.length ? inRange[inRange.length - 1].balance_after : balanceBf;

  const entries = inRange
    .slice()
    .sort((a, b) => b._ms - a._ms) // newest first for display
    .map(({ _ms, ...rest }) => rest);

  return { entries, balance_bf: balanceBf, balance_cf: balanceCf };
}

// ---------------------------------------------------------------------------
// Dynamic settings (API_KEY / APP_SECRET), cached briefly to avoid a
// Firestore read on every single request.
// ---------------------------------------------------------------------------
let settingsCache = {
  apiKey: null, appSecret: null, documentPrefix: null, adjustmentPrefix: null,
  legacyKeyEnabled: true, minTopupAmount: 1, maxTopupAmount: 1000,
  billplzSecretKey: null, billplzXSignatureKey: null, billplzCollectionId: null,
  billplzSandbox: true, billplzMinReload: 10, billplzMaxReload: 5000, billplzOnlinePrefix: "OL",
  latestAppVersion: null,
  fetchedAt: 0,
};
const SETTINGS_CACHE_MS = 30 * 1000;

async function getSettings() {
  const now = Date.now();
  if (settingsCache.apiKey && now - settingsCache.fetchedAt < SETTINGS_CACHE_MS) {
    return settingsCache;
  }
  const doc = await db.collection("settings").doc("config").get();
  const data = doc.exists ? doc.data() : {};
  settingsCache = {
    apiKey: data.apiKey || process.env.API_KEY || "change-me-api-key",
    appSecret: data.appSecret || process.env.APP_SECRET || "change-me-app-secret",
    documentPrefix: data.documentPrefix || "RC",
    adjustmentPrefix: data.adjustmentPrefix || "AJ",
    legacyKeyEnabled: data.legacyKeyEnabled !== false, // default true unless explicitly disabled
    minTopupAmount: typeof data.minTopupAmount === "number" ? data.minTopupAmount : 1,
    maxTopupAmount: typeof data.maxTopupAmount === "number" ? data.maxTopupAmount : 1000,
    billplzSecretKey: data.billplzSecretKey || null,
    billplzXSignatureKey: data.billplzXSignatureKey || null,
    billplzCollectionId: data.billplzCollectionId || null,
    billplzSandbox: data.billplzSandbox !== false, // default true (sandbox) until explicitly turned off
    billplzMinReload: typeof data.billplzMinReload === "number" ? data.billplzMinReload : 10,
    billplzMaxReload: typeof data.billplzMaxReload === "number" ? data.billplzMaxReload : 5000,
    billplzOnlinePrefix: data.billplzOnlinePrefix || "OL",
    latestAppVersion: data.latestAppVersion || null,
    fetchedAt: now,
  };
  return settingsCache;
}

async function requireApiKey(req, res, next) {
  const s = await getSettings();
  if (!s.legacyKeyEnabled) {
    return res.status(403).json({ error: "Legacy API key is disabled — use a company-specific API key instead" });
  }
  if (req.header("x-api-key") !== s.apiKey) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
}

async function requireAppSecret(req, res, next) {
  const s = await getSettings();
  if (req.header("x-app-secret") !== s.appSecret) {
    return res.status(401).json({ error: "Invalid app secret" });
  }
  next();
}

// ---------------------------------------------------------------------------
// Admin session auth (replaces the old fixed ADMIN_KEY for everything except
// bootstrap). The panel logs in once, gets a JWT, and sends it as
// "Authorization: Bearer <token>" on every admin request.
// ---------------------------------------------------------------------------
function requireAdminSession(req, res, next) {
  const authHeader = req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing session token" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== "admin") return res.status(401).json({ error: "Not an admin session" });
    req.adminUsername = decoded.username;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired session, please log in again" });
  }
}

// ---------------------------------------------------------------------------
// Company portal session auth — separate from admin sessions. A company
// user (representing one client company) logs in at /portal.html and gets
// a token scoped to "company" type, tied to their userId.
// ---------------------------------------------------------------------------
function requireCompanySession(req, res, next) {
  const authHeader = req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing session token" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== "company") return res.status(401).json({ error: "Not a company session" });
    req.companyUserId = decoded.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired session, please log in again" });
  }
}

// ---------------------------------------------------------------------------
// Cron auth — a fixed secret (never expires, unlike admin login sessions)
// for Cloud Scheduler or any other automated caller to trigger the timeout
// check without a human logging in. Rotate CRON_SECRET if it ever leaks.
// ---------------------------------------------------------------------------
function requireCronSecret(req, res, next) {
  const key = req.header("x-cron-secret");
  if (key !== CRON_SECRET) return res.status(401).json({ error: "Invalid cron secret" });
  next();
}

// Shared by both the admin panel's manual check and the scheduled cron hit.
// Iterates every device slot that actually exists (each telco/group
// combination), not just the 4 global telcos — since a telco can now have
// a different physical device per group.
async function runTimeoutCheck() {
  const snapshot = await db.collection("devices").get();
  await Promise.all(
    snapshot.docs.map((doc) => tryDispatchNext(doc.data().groupId || null, doc.data().telco))
  );
}

// =============================================================================
// 1. ADMIN LOGIN
// =============================================================================

// One-time bootstrap: creates the very first admin account. Only works if
// no admin users exist yet. Requires the ADMIN_KEY env var as proof — this
// key is never shipped in the Android app.
app.post("/api/admin/bootstrap", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  if (req.header("x-admin-key") !== ADMIN_BOOTSTRAP_KEY) {
    return res.status(401).json({ error: "Invalid bootstrap key" });
  }

  const existing = await db.collection("admin_users").limit(1).get();
  if (!existing.empty) {
    return res.status(403).json({ error: "An admin account already exists — log in and use User Maintenance instead" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await db.collection("admin_users").doc(username).set({
    username,
    passwordHash,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.json({ status: "created" });
});

app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  const rateCheck = await checkRateLimit("admin_login", username, 5, 15 * 60 * 1000);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: `Too many login attempts, try again in ${rateCheck.retryAfterSeconds}s` });
  }

  const doc = await db.collection("admin_users").doc(username).get();
  if (!doc.exists) return res.status(401).json({ error: "Invalid username or password" });

  const match = await bcrypt.compare(password, doc.data().passwordHash);
  if (!match) return res.status(401).json({ error: "Invalid username or password" });

  await resetRateLimit("admin_login", username);
  await logAudit(username, "login", "Admin logged in");

  const token = jwt.sign({ username, type: "admin" }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, username });
});

// =============================================================================
// 2. USER MAINTENANCE (session-protected)
// =============================================================================

app.get("/api/admin/users", requireAdminSession, async (req, res) => {
  const snapshot = await db.collection("admin_users").get();
  const users = snapshot.docs.map((doc) => ({
    username: doc.id,
    created_at: doc.data().createdAt ? doc.data().createdAt.toDate().toISOString() : null,
  }));
  res.json({ users });
});

app.post("/api/admin/users", requireAdminSession, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  const ref = db.collection("admin_users").doc(username);
  const existing = await ref.get();
  if (existing.exists) return res.status(409).json({ error: "Username already exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  await ref.set({
    username,
    passwordHash,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logAudit(req.adminUsername, "admin_user_created", username);
  res.json({ status: "created" });
});

app.put("/api/admin/users/:username/password", requireAdminSession, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "password is required" });

  const ref = db.collection("admin_users").doc(req.params.username);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: "User not found" });

  const passwordHash = await bcrypt.hash(password, 10);
  await ref.update({ passwordHash });
  await logAudit(req.adminUsername, "admin_password_changed", req.params.username);
  res.json({ status: "updated" });
});

app.delete("/api/admin/users/:username", requireAdminSession, async (req, res) => {
  const { username } = req.params;

  const snapshot = await db.collection("admin_users").get();
  if (snapshot.size <= 1) {
    return res.status(400).json({ error: "Cannot delete the last remaining admin account" });
  }
  if (username === req.adminUsername) {
    return res.status(400).json({ error: "Cannot delete the account you're currently logged in as" });
  }

  await db.collection("admin_users").doc(username).delete();
  await logAudit(req.adminUsername, "admin_user_deleted", username);
  res.json({ status: "deleted" });
});

// =============================================================================
// 4. SETTINGS (session-protected) — API_KEY / APP_SECRET, editable live
// =============================================================================

app.get("/api/admin/settings", requireAdminSession, async (req, res) => {
  const s = await getSettings();
  res.json({
    api_key: s.apiKey,
    app_secret: s.appSecret,
    document_prefix: s.documentPrefix,
    adjustment_prefix: s.adjustmentPrefix,
    legacy_key_enabled: s.legacyKeyEnabled,
    min_topup_amount: s.minTopupAmount,
    max_topup_amount: s.maxTopupAmount,
    // Billplz secret/X-signature keys are write-only — never sent back to
    // the browser once set. Only whether they're configured is exposed.
    billplz_secret_key_set: !!s.billplzSecretKey,
    billplz_x_signature_key_set: !!s.billplzXSignatureKey,
    billplz_collection_id: s.billplzCollectionId,
    billplz_sandbox: s.billplzSandbox,
    billplz_min_reload: s.billplzMinReload,
    billplz_max_reload: s.billplzMaxReload,
    billplz_online_prefix: s.billplzOnlinePrefix,
    latest_app_version: s.latestAppVersion,
  });
});

app.post("/api/admin/settings", requireAdminSession, async (req, res) => {
  const {
    api_key, app_secret, document_prefix, adjustment_prefix, legacy_key_enabled, min_topup_amount, max_topup_amount,
    billplz_secret_key, billplz_x_signature_key, billplz_collection_id, billplz_sandbox, billplz_min_reload, billplz_max_reload, billplz_online_prefix,
    latest_app_version,
  } = req.body;
  const update = {};
  if (api_key) update.apiKey = api_key;
  if (app_secret) update.appSecret = app_secret;
  if (document_prefix) update.documentPrefix = document_prefix.toUpperCase();
  if (adjustment_prefix) update.adjustmentPrefix = adjustment_prefix.toUpperCase();
  if (typeof legacy_key_enabled === "boolean") update.legacyKeyEnabled = legacy_key_enabled;
  if (typeof min_topup_amount === "number") update.minTopupAmount = min_topup_amount;
  if (typeof max_topup_amount === "number") update.maxTopupAmount = max_topup_amount;
  // Only overwrite Billplz secrets if a new value was actually provided —
  // this lets the admin update other Billplz fields (e.g. sandbox toggle)
  // without needing to re-paste the secret key every time.
  if (billplz_secret_key) update.billplzSecretKey = billplz_secret_key;
  if (billplz_x_signature_key) update.billplzXSignatureKey = billplz_x_signature_key;
  if (billplz_collection_id) update.billplzCollectionId = billplz_collection_id;
  if (typeof billplz_sandbox === "boolean") update.billplzSandbox = billplz_sandbox;
  if (typeof billplz_min_reload === "number") update.billplzMinReload = billplz_min_reload;
  if (typeof billplz_max_reload === "number") update.billplzMaxReload = billplz_max_reload;
  if (billplz_online_prefix) update.billplzOnlinePrefix = billplz_online_prefix.toUpperCase();
  if (latest_app_version) update.latestAppVersion = latest_app_version.trim();

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: "Provide at least one setting to update" });
  }

  await db.collection("settings").doc("config").set(update, { merge: true });
  settingsCache.fetchedAt = 0; // force refresh on next request
  // Redact secrets from the audit log entry itself.
  const auditSafeUpdate = { ...update };
  if (auditSafeUpdate.billplzSecretKey) auditSafeUpdate.billplzSecretKey = "[redacted]";
  if (auditSafeUpdate.billplzXSignatureKey) auditSafeUpdate.billplzXSignatureKey = "[redacted]";
  await logAudit(req.adminUsername, "settings_updated", JSON.stringify(auditSafeUpdate));
  res.json({ status: "updated" });
});

// ---------- Billplz payment methods (restrict to FPX / DuitNow Transfer, etc.) ----------

// Returns Billplz's live list of payment method codes/names/status for the
// configured Collection — this sidesteps any guessing about exact code
// names (e.g. for DuitNow Transfer), since it reflects your real account.
app.get("/api/admin/billplz/payment-methods", requireAdminSession, async (req, res) => {
  const s = await getSettings();
  if (!s.billplzSecretKey || !s.billplzCollectionId) {
    return res.status(503).json({ error: "Billplz is not configured yet (secret key / collection ID missing)" });
  }
  try {
    const data = await billplzApiRequest(s, "GET", `/v3/collections/${s.billplzCollectionId}/payment_methods`, null);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch payment methods from Billplz", details: err.message });
  }
});

// Body: { codes: ["fpx", "mgate"] } — the exact set of codes to enable;
// every other method gets disabled (Billplz's API replaces the whole list).
app.post("/api/admin/billplz/payment-methods", requireAdminSession, async (req, res) => {
  const { codes } = req.body;
  if (!Array.isArray(codes)) return res.status(400).json({ error: "codes must be an array" });

  const s = await getSettings();
  if (!s.billplzSecretKey || !s.billplzCollectionId) {
    return res.status(503).json({ error: "Billplz is not configured yet (secret key / collection ID missing)" });
  }
  try {
    const data = await billplzApiRequest(s, "PUT", `/v3/collections/${s.billplzCollectionId}/payment_methods`, {
      "payment_methods[][code]": codes,
    });
    await logAudit(req.adminUsername, "billplz_payment_methods_updated", codes.join(", "));
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Failed to update payment methods on Billplz", details: err.message });
  }
});

// =============================================================================
// COMPANY USER MANAGEMENT (admin, session-protected)
// A company user represents one client company. Admin creates the account;
// the company then logs into /portal.html to manage their own API keys,
// view credit usage, and edit their profile. Only admin can perform reloads.
// =============================================================================

app.get("/api/admin/company-users", requireAdminSession, async (req, res) => {
  const snapshot = await db.collection("company_users").get();
  const users = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      user_id: doc.id,
      username: data.username,
      company_name: data.companyName || null,
      credit_balance: data.creditBalance || 0,
      margin_percent: data.marginPercent ?? data.markupPercent ?? 0,
      default_group_id: data.defaultGroupId || null,
      alternative_group_id: data.alternativeGroupId || null,
      is_trial: !!data.isTrial,
      product_margins: data.productMargins || {},
      created_at: data.createdAt ? data.createdAt.toDate().toISOString() : null,
    };
  });
  res.json({ users });
});

app.post("/api/admin/company-users", requireAdminSession, async (req, res) => {
  const { username, password, company_name } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  const existing = await db.collection("company_users")
    .where("username", "==", username)
    .limit(1)
    .get();
  if (!existing.empty) return res.status(409).json({ error: "Username already exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  const ref = await db.collection("company_users").add({
    username,
    passwordHash,
    companyName: company_name || null,
    registrationNumber: null,
    address: null,
    phone: null,
    email: null,
    contactPerson: null,
    creditBalance: 0,
    marginPercent: 0,
    lowBalanceThreshold: 20,
    lowBalanceWebhookUrl: null,
    lowBalanceAlerted: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logAudit(req.adminUsername, "company_created", `Created company: ${company_name || username}`);
  res.json({ status: "created", user_id: ref.id });
});

// Reload credit for a company. Multipart form: amount, remarks, document_date
// (optional, defaults to today), attachment (optional image/pdf file).
app.post(
  "/api/admin/company-users/:userId/reload",
  requireAdminSession,
  upload.single("attachment"),
  async (req, res) => {
    const { userId } = req.params;
    const { amount, remarks, document_date } = req.body;
    const amountNum = Number(amount);

    if (!amountNum || amountNum <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    const userRef = db.collection("company_users").doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "Company user not found" });

    // Store the bucket path only, not a permanent public URL — a fresh
    // short-lived signed URL is generated on demand when someone with
    // proper access (admin, or the owning company) actually views it.
    let attachmentPath = null;
    if (req.file) {
      try {
        const bucket = getBucket();
        attachmentPath = `reload-attachments/${userId}-${Date.now()}-${req.file.originalname}`;
        const file = bucket.file(attachmentPath);
        await file.save(req.file.buffer, { contentType: req.file.mimetype });
      } catch (err) {
        return res.status(500).json({ error: "Attachment upload failed", details: err.message });
      }
    }

    const s = await getSettings();
    const documentNumber = await generateDocumentNumber(s.documentPrefix);
    const documentDate = document_date || new Date().toISOString().slice(0, 10);

    const newBalance = await db.runTransaction(async (t) => {
      const freshUserDoc = await t.get(userRef);
      const currentBalance = freshUserDoc.data().creditBalance || 0;
      const updatedBalance = currentBalance + amountNum;

      // Reload crosses back above the threshold — allow future dips to
      // alert again instead of staying silenced forever.
      t.update(userRef, { creditBalance: updatedBalance, lowBalanceAlerted: false });

      const ledgerRef = db.collection("credit_ledger").doc();
      t.set(ledgerRef, {
        userId,
        type: "reload",
        amount: amountNum,
        balanceAfter: updatedBalance,
        documentNumber,
        documentDate,
        createdByAdmin: req.adminUsername,
        remarks: remarks || null,
        attachmentPath,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return updatedBalance;
    });

    await logAudit(req.adminUsername, "reload", `${documentNumber}: +${amountNum} for company ${userId}`);

    res.json({ status: "reloaded", document_number: documentNumber, new_balance: newBalance });
  }
);

// Generates a short-lived signed URL for viewing a reload attachment.
// Admin can view any; a company can only view its own.
async function getSignedAttachmentUrl(attachmentPath) {
  const bucket = getBucket();
  const [url] = await bucket.file(attachmentPath).getSignedUrl({
    action: "read",
    expires: Date.now() + 15 * 60 * 1000, // 15 minutes
  });
  return url;
}

app.get("/api/admin/reload-attachment/:ledgerId", requireAdminSession, async (req, res) => {
  const doc = await db.collection("credit_ledger").doc(req.params.ledgerId).get();
  if (!doc.exists || !doc.data().attachmentPath) return res.status(404).json({ error: "No attachment found" });
  try {
    const url = await getSignedAttachmentUrl(doc.data().attachmentPath);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate attachment link", details: err.message });
  }
});

app.get("/api/portal/reload-attachment/:ledgerId", requireCompanySession, async (req, res) => {
  const doc = await db.collection("credit_ledger").doc(req.params.ledgerId).get();
  if (!doc.exists || doc.data().userId !== req.companyUserId) {
    return res.status(404).json({ error: "No attachment found" });
  }
  if (!doc.data().attachmentPath) return res.status(404).json({ error: "No attachment found" });
  try {
    const url = await getSignedAttachmentUrl(doc.data().attachmentPath);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate attachment link", details: err.message });
  }
});

// All reload transactions across all companies, newest first.
app.get("/api/admin/reload-transactions", requireAdminSession, async (req, res) => {
  const snapshot = await db.collection("credit_ledger").where("type", "==", "reload").get();

  const userIds = snapshot.docs.map((doc) => doc.data().userId);
  const companyNames = await getCompanyNamesMap(userIds);

  const transactions = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        ledger_id: doc.id,
        document_number: data.documentNumber,
        company: companyNames[data.userId] || data.userId,
        document_date: data.documentDate,
        amount: data.amount,
        remarks: data.remarks || null,
        created_by_admin: data.createdByAdmin,
        has_attachment: !!data.attachmentPath,
        created_at: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        _ms: data.createdAt ? data.createdAt.toMillis() : 0,
      };
    })
    .sort((a, b) => b._ms - a._ms)
    .map(({ _ms, ...rest }) => rest);

  res.json({ transactions });
});

// CSV export of every reload transaction across all companies.
app.get("/api/admin/reload-transactions/export", requireAdminSession, async (req, res) => {
  const snapshot = await db.collection("credit_ledger").where("type", "==", "reload").get();
  const userIds = snapshot.docs.map((doc) => doc.data().userId);
  const companyNames = await getCompanyNamesMap(userIds);

  const rows = [["Document No.", "Company", "Date", "Amount", "Remarks", "Created By"]];
  snapshot.docs
    .map((doc) => ({ ...doc.data(), _ms: doc.data().createdAt ? doc.data().createdAt.toMillis() : 0 }))
    .sort((a, b) => b._ms - a._ms)
    .forEach((data) => {
      rows.push([
        data.documentNumber, companyNames[data.userId] || data.userId, data.documentDate,
        data.amount, data.remarks || "", data.createdByAdmin,
      ]);
    });

  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="reload-transactions.csv"`);
  res.send(csv);
});

// Adjustment: increases or decreases a company's credit WITHOUT an actual
// topup — e.g. correcting an error, a goodwill credit, or clawing back a
// mistaken reload. Same shape as a reload (document number, date, remarks,
// attachment, admin audit trail), but the amount can be positive or
// negative and uses its own document number series.
app.post(
  "/api/admin/company-users/:userId/adjustment",
  requireAdminSession,
  upload.single("attachment"),
  async (req, res) => {
    const { userId } = req.params;
    const { amount, remarks, document_date } = req.body;
    const amountNum = Number(amount);

    if (!amountNum || isNaN(amountNum)) {
      return res.status(400).json({ error: "amount must be a non-zero number (positive to increase, negative to decrease)" });
    }

    const userRef = db.collection("company_users").doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "Company user not found" });

    let attachmentPath = null;
    if (req.file) {
      try {
        const bucket = getBucket();
        attachmentPath = `adjustment-attachments/${userId}-${Date.now()}-${req.file.originalname}`;
        const file = bucket.file(attachmentPath);
        await file.save(req.file.buffer, { contentType: req.file.mimetype });
      } catch (err) {
        return res.status(500).json({ error: "Attachment upload failed", details: err.message });
      }
    }

    const s = await getSettings();
    const documentNumber = await generateDocumentNumber(s.adjustmentPrefix);
    const documentDate = document_date || new Date().toISOString().slice(0, 10);

    const newBalance = await db.runTransaction(async (t) => {
      const freshUserDoc = await t.get(userRef);
      const currentBalance = freshUserDoc.data().creditBalance || 0;
      const updatedBalance = currentBalance + amountNum; // amountNum carries its own sign

      const update = { creditBalance: updatedBalance };
      // A positive adjustment that brings the balance back up should also
      // re-arm the low-balance alert, same as a reload does.
      if (amountNum > 0) update.lowBalanceAlerted = false;
      t.update(userRef, update);

      const ledgerRef = db.collection("credit_ledger").doc();
      t.set(ledgerRef, {
        userId,
        type: "adjustment",
        amount: amountNum,
        balanceAfter: updatedBalance,
        documentNumber,
        documentDate,
        createdByAdmin: req.adminUsername,
        remarks: remarks || null,
        attachmentPath,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return updatedBalance;
    });

    await logAudit(
      req.adminUsername,
      "adjustment",
      `${documentNumber}: ${amountNum > 0 ? "+" : ""}${amountNum} for company ${userId}`
    );

    res.json({ status: "adjusted", document_number: documentNumber, new_balance: newBalance });
  }
);

app.get("/api/admin/adjustment-attachment/:ledgerId", requireAdminSession, async (req, res) => {
  const doc = await db.collection("credit_ledger").doc(req.params.ledgerId).get();
  if (!doc.exists || !doc.data().attachmentPath) return res.status(404).json({ error: "No attachment found" });
  try {
    const url = await getSignedAttachmentUrl(doc.data().attachmentPath);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate attachment link", details: err.message });
  }
});

app.get("/api/portal/adjustment-attachment/:ledgerId", requireCompanySession, async (req, res) => {
  const doc = await db.collection("credit_ledger").doc(req.params.ledgerId).get();
  if (!doc.exists || doc.data().userId !== req.companyUserId) {
    return res.status(404).json({ error: "No attachment found" });
  }
  if (!doc.data().attachmentPath) return res.status(404).json({ error: "No attachment found" });
  try {
    const url = await getSignedAttachmentUrl(doc.data().attachmentPath);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate attachment link", details: err.message });
  }
});

// All adjustment transactions across all companies, newest first.
app.get("/api/admin/adjustment-transactions", requireAdminSession, async (req, res) => {
  const snapshot = await db.collection("credit_ledger").where("type", "==", "adjustment").get();

  const userIds = snapshot.docs.map((doc) => doc.data().userId);
  const companyNames = await getCompanyNamesMap(userIds);

  const transactions = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        ledger_id: doc.id,
        document_number: data.documentNumber,
        company: companyNames[data.userId] || data.userId,
        document_date: data.documentDate,
        amount: data.amount,
        remarks: data.remarks || null,
        created_by_admin: data.createdByAdmin,
        has_attachment: !!data.attachmentPath,
        created_at: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        _ms: data.createdAt ? data.createdAt.toMillis() : 0,
      };
    })
    .sort((a, b) => b._ms - a._ms)
    .map(({ _ms, ...rest }) => rest);

  res.json({ transactions });
});

// CSV export of every adjustment transaction across all companies.
app.get("/api/admin/adjustment-transactions/export", requireAdminSession, async (req, res) => {
  const snapshot = await db.collection("credit_ledger").where("type", "==", "adjustment").get();
  const userIds = snapshot.docs.map((doc) => doc.data().userId);
  const companyNames = await getCompanyNamesMap(userIds);

  const rows = [["Document No.", "Company", "Date", "Amount", "Remarks", "Created By"]];
  snapshot.docs
    .map((doc) => ({ ...doc.data(), _ms: doc.data().createdAt ? doc.data().createdAt.toMillis() : 0 }))
    .sort((a, b) => b._ms - a._ms)
    .forEach((data) => {
      rows.push([
        data.documentNumber, companyNames[data.userId] || data.userId, data.documentDate,
        data.amount, data.remarks || "", data.createdByAdmin,
      ]);
    });

  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="adjustment-transactions.csv"`);
  res.send(csv);
});

// Credit statement for any one company, chosen by admin — same B/F, C/F
// logic as the company's own portal view.
app.get("/api/admin/credit-inquiry", requireAdminSession, async (req, res) => {
  const { user_id, from, to } = req.query;
  if (!user_id) return res.status(400).json({ error: "user_id is required" });

  const userDoc = await db.collection("company_users").doc(user_id).get();
  if (!userDoc.exists) return res.status(404).json({ error: "Company not found" });

  const statement = await getLedgerStatement(user_id, from, to);

  res.json({
    company: userDoc.data().companyName || userDoc.data().username,
    current_balance: userDoc.data().creditBalance || 0,
    entries: statement.entries,
    balance_bf: statement.balance_bf,
    balance_cf: statement.balance_cf,
  });
});

// CSV export of a company's credit inquiry statement.
app.get("/api/admin/credit-inquiry/export", requireAdminSession, async (req, res) => {
  const { user_id, from, to } = req.query;
  if (!user_id) return res.status(400).json({ error: "user_id is required" });

  const statement = await getLedgerStatement(user_id, from, to);
  const rows = [["Date", "Type", "Amount", "Balance After", "Document No.", "Remarks", "Phone", "Telco"]];
  for (const e of statement.entries) {
    rows.push([
      e.created_at || "", e.type, e.amount, e.balance_after,
      e.document_number || "", e.remarks || "", e.phone || "", e.telco || "",
    ]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="credit-statement-${user_id}.csv"`);
  res.send(csv);
});

// Sets a per-company margin — the amount actually billed to the company is
// topup_amount * (1 - margin% / 100), while the phone still dials the raw
// topup_amount unchanged. The margin is what the company keeps as their cut.
app.post("/api/admin/company-users/:userId/margin", requireAdminSession, async (req, res) => {
  const { margin_percent } = req.body;
  const percent = Number(margin_percent);
  if (isNaN(percent) || percent < 0 || percent > 100) {
    return res.status(400).json({ error: "margin_percent must be between 0 and 100" });
  }
  const userRef = db.collection("company_users").doc(req.params.userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return res.status(404).json({ error: "Company not found" });

  // Write to the new field name; also clear the legacy markupPercent so
  // there's no ambiguity about which one is authoritative going forward.
  await userRef.update({ marginPercent: percent, markupPercent: admin.firestore.FieldValue.delete() });
  await logAudit(req.adminUsername, "margin_updated", `${req.params.userId}: ${percent}%`);
  res.json({ status: "updated", margin_percent: percent });
});

// Sets (or clears) a margin override for one specific (Telco + Service
// Type) "product" for a company — falls back to that company's default
// margin (above) whenever no override exists for the combination actually
// being used. Pass margin_percent: null to clear an override.
app.post("/api/admin/company-users/:userId/product-margin", requireAdminSession, async (req, res) => {
  const { telco, service_type_id, margin_percent } = req.body;
  if (!telco || !service_type_id) {
    return res.status(400).json({ error: "telco and service_type_id are required" });
  }
  const userRef = db.collection("company_users").doc(req.params.userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return res.status(404).json({ error: "Company not found" });

  const key = productMarginKey(telco.toUpperCase(), service_type_id);
  const currentProductMargins = userDoc.data().productMargins || {};

  if (margin_percent === null || margin_percent === "" || margin_percent === undefined) {
    delete currentProductMargins[key];
    await userRef.update({ productMargins: currentProductMargins });
    await logAudit(req.adminUsername, "product_margin_cleared", `${req.params.userId}: ${key}`);
    return res.json({ status: "cleared" });
  }

  const percent = Number(margin_percent);
  if (isNaN(percent) || percent < 0 || percent > 100) {
    return res.status(400).json({ error: "margin_percent must be between 0 and 100" });
  }

  currentProductMargins[key] = percent;
  await userRef.update({ productMargins: currentProductMargins });
  await logAudit(req.adminUsername, "product_margin_updated", `${req.params.userId}: ${key} = ${percent}%`);
  res.json({ status: "updated", key, margin_percent: percent });
});

// Assigns a company's default and/or alternative device group. Leaving
// both unset (null) keeps the company on the shared ungrouped pool, exactly
// as it worked before groups existed.
app.post("/api/admin/company-users/:userId/groups", requireAdminSession, async (req, res) => {
  const { default_group_id, alternative_group_id } = req.body;
  const userRef = db.collection("company_users").doc(req.params.userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return res.status(404).json({ error: "Company not found" });

  for (const groupId of [default_group_id, alternative_group_id]) {
    if (groupId) {
      const groupDoc = await db.collection("device_groups").doc(groupId).get();
      if (!groupDoc.exists) return res.status(400).json({ error: `Unknown group_id: ${groupId}` });
    }
  }

  await userRef.update({
    defaultGroupId: default_group_id || null,
    alternativeGroupId: alternative_group_id || null,
  });
  await logAudit(
    req.adminUsername,
    "company_groups_updated",
    `${req.params.userId}: default=${default_group_id || "none"}, alternative=${alternative_group_id || "none"}`
  );
  res.json({ status: "updated" });
});

// Marks (or unmarks) a company as a Trial account. Trial companies can
// only top up a device's own Registered Phone Number — see performTopup's
// enforcement of this — so testing is safe (real dial, real result) and
// can never accidentally reach a real customer's number.
app.post("/api/admin/company-users/:userId/trial", requireAdminSession, async (req, res) => {
  const { is_trial } = req.body;
  const userRef = db.collection("company_users").doc(req.params.userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return res.status(404).json({ error: "Company not found" });

  await userRef.update({ isTrial: !!is_trial });
  await logAudit(req.adminUsername, "company_trial_flag_updated", `${req.params.userId}: ${!!is_trial}`);
  res.json({ status: "updated", is_trial: !!is_trial });
});

// Success-rate stats per telco over the last N days (default 7).
app.get("/api/admin/stats", requireAdminSession, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Single range filter on createdAt only — no composite index needed.
  const snapshot = await db.collection("jobs").where("createdAt", ">=", since).get();

  const byTelco = {};
  for (const telco of await getValidTelcos()) {
    byTelco[telco] = { success: 0, failed: 0, timeout: 0, rejected: 0, other: 0, total: 0 };
  }

  const byCompany = {}; // keyed by userId; "legacy" bucket for jobs with no company

  snapshot.docs.forEach((doc) => {
    const data = doc.data();
    const bucket = byTelco[data.telco] || (byTelco[data.telco] = { success: 0, failed: 0, timeout: 0, rejected: 0, other: 0, total: 0 });
    bucket.total++;

    const companyKey = data.userId || "legacy";
    const companyBucket = byCompany[companyKey] || (byCompany[companyKey] = { success: 0, failed: 0, timeout: 0, rejected: 0, other: 0, total: 0 });
    companyBucket.total++;

    if (["success", "failed", "timeout", "rejected"].includes(data.status)) {
      bucket[data.status]++;
      companyBucket[data.status]++;
    } else {
      bucket.other++;
      companyBucket.other++;
    }
  });

  const stats = Object.entries(byTelco).map(([telco, counts]) => ({
    telco,
    ...counts,
    success_rate: counts.total ? Math.round((counts.success / counts.total) * 1000) / 10 : null,
  }));

  const companyIds = Object.keys(byCompany).filter((id) => id !== "legacy");
  const companyNames = await getCompanyNamesMap(companyIds);

  const companyStats = Object.entries(byCompany).map(([userId, counts]) => ({
    company: userId === "legacy" ? "Legacy key (no company)" : (companyNames[userId] || userId),
    ...counts,
    success_rate: counts.total ? Math.round((counts.success / counts.total) * 1000) / 10 : null,
  })).sort((a, b) => b.total - a.total);

  res.json({ days, stats, company_stats: companyStats });
});

// Admin action audit trail.
app.get("/api/admin/audit-log", requireAdminSession, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  let query = db.collection("audit_log").orderBy("createdAt", "desc");
  query = applyDateRangeFilter(query, req);
  const snapshot = await query.limit(limit).get();
  const entries = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      actor: data.actor,
      action: data.action,
      details: data.details,
      created_at: data.createdAt ? data.createdAt.toDate().toISOString() : null,
    };
  });
  res.json({ entries, has_more: entries.length === limit });
});

// =============================================================================
// SERVICE TYPES & TELCO CONFIGURATION (session-protected)
// Fully admin-defined service types (Reload, Bill Payment, etc), and per-
// telco USSD templates for each one they support. See the helper functions
// (ensureDefaultServiceType, resolveUssdTemplate, etc.) defined earlier.
// =============================================================================

app.get("/api/admin/service-types", requireAdminSession, async (req, res) => {
  await ensureDefaultServiceType();
  const snapshot = await db.collection("service_types").get();
  const types = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        extra_fields: data.extraFields || [],
        is_default: !!data.isDefault,
        _ms: data.createdAt ? data.createdAt.toMillis() : 0,
      };
    })
    .sort((a, b) => a._ms - b._ms)
    .map(({ _ms, ...rest }) => rest);
  res.json({ service_types: types });
});

app.post("/api/admin/service-types", requireAdminSession, async (req, res) => {
  const { name, extra_fields } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });

  const extraFields = Array.isArray(extra_fields) ? extra_fields.map((f) => slugify(f)).filter(Boolean) : [];
  let id = slugify(name);
  let ref = db.collection("service_types").doc(id);
  if ((await ref.get()).exists) {
    id = `${id}_${Date.now()}`;
    ref = db.collection("service_types").doc(id);
  }

  await ref.set({
    name: name.trim(),
    extraFields,
    isDefault: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await logAudit(req.adminUsername, "service_type_created", `${id}: ${name.trim()}`);
  res.json({ status: "created", id });
});

app.put("/api/admin/service-types/:id", requireAdminSession, async (req, res) => {
  const { name, extra_fields } = req.body;
  const ref = db.collection("service_types").doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: "Service type not found" });

  const update = {};
  if (name && name.trim()) update.name = name.trim();
  if (Array.isArray(extra_fields)) update.extraFields = extra_fields.map((f) => slugify(f)).filter(Boolean);
  if (Object.keys(update).length === 0) return res.status(400).json({ error: "Nothing to update" });

  await ref.update(update);
  await logAudit(req.adminUsername, "service_type_updated", req.params.id);
  res.json({ status: "updated" });
});

app.delete("/api/admin/service-types/:id", requireAdminSession, async (req, res) => {
  const ref = db.collection("service_types").doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: "Service type not found" });
  if (doc.data().isDefault) {
    return res.status(400).json({ error: "Cannot delete the default service type (Reload) — every telco needs at least one" });
  }

  // Guard against deleting a service type that's still enabled somewhere.
  const configsSnapshot = await db.collection("telco_configs").get();
  const inUseBy = configsSnapshot.docs
    .filter((d) => d.data().services && d.data().services[req.params.id]?.enabled)
    .map((d) => d.id);
  if (inUseBy.length) {
    return res.status(400).json({ error: `Still enabled for: ${inUseBy.join(", ")} — disable it there first` });
  }

  await ref.delete();
  await logAudit(req.adminUsername, "service_type_deleted", req.params.id);
  res.json({ status: "deleted" });
});

app.get("/api/admin/telco-configs", requireAdminSession, async (req, res) => {
  await ensureTelcoConfigsSeeded();
  const configs = {};
  const telcos = await getValidTelcos();
  await Promise.all(telcos.map(async (telco) => {
    const doc = await db.collection("telco_configs").doc(telco).get();
    configs[telco] = doc.exists ? doc.data().services || {} : {};
  }));
  res.json({ configs, telcos });
});

app.post("/api/admin/telco-configs/:telco", requireAdminSession, async (req, res) => {
  const telcoKey = req.params.telco.toUpperCase();
  if (!(await isValidTelco(telcoKey))) {
    return res.status(400).json({ error: `telco must be one of: ${(await getValidTelcos()).join(", ")}` });
  }
  const { services } = req.body;
  if (!services || typeof services !== "object") return res.status(400).json({ error: "services object is required" });

  await db.collection("telco_configs").doc(telcoKey).set({
    services,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await logAudit(req.adminUsername, "telco_config_updated", telcoKey);
  res.json({ status: "updated" });
});

// =============================================================================
// TELCOS (session-protected) — fully admin-manageable, add/remove any time.
// =============================================================================

app.get("/api/admin/telcos", requireAdminSession, async (req, res) => {
  const list = await getValidTelcos();
  const snapshot = await db.collection("telcos").get();
  const names = {};
  snapshot.docs.forEach((doc) => { names[doc.id] = doc.data().name || doc.id; });
  res.json({ telcos: list.map((code) => ({ code, name: names[code] || code })) });
});

app.post("/api/admin/telcos", requireAdminSession, async (req, res) => {
  const { code, name } = req.body;
  if (!code || !code.trim()) return res.status(400).json({ error: "code is required" });

  const telcoCode = code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const ref = db.collection("telcos").doc(telcoCode);
  if ((await ref.get()).exists) {
    return res.status(409).json({ error: `Telco ${telcoCode} already exists` });
  }

  await ref.set({
    code: telcoCode,
    name: (name && name.trim()) || telcoCode,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  invalidateTelcosCache();
  await logAudit(req.adminUsername, "telco_created", telcoCode);
  res.json({ status: "created", code: telcoCode });
});

app.delete("/api/admin/telcos/:code", requireAdminSession, async (req, res) => {
  const telcoCode = req.params.code.toUpperCase();

  // Guard against deleting a telco that still has an approved device, so a
  // device doesn't end up silently orphaned from a telco that no longer
  // "exists" as far as validation is concerned.
  const devicesSnapshot = await db.collection("devices_registry")
    .where("approvedTelco", "==", telcoCode)
    .where("status", "==", "approved")
    .get();
  if (!devicesSnapshot.empty) {
    return res.status(400).json({ error: `${devicesSnapshot.size} approved device(s) still use this telco — revoke them first` });
  }

  await db.collection("telcos").doc(telcoCode).delete();
  invalidateTelcosCache();
  await logAudit(req.adminUsername, "telco_deleted", telcoCode);
  res.json({ status: "deleted" });
});

// =============================================================================
// DEVICE GROUPS (session-protected)
// A named pool of devices. Each device belongs to at most one group (or
// none, staying in the shared ungrouped pool). Each company can be assigned
// a default and/or alternative group for routing (see resolveRoutingDevice).
// =============================================================================

app.get("/api/admin/device-groups", requireAdminSession, async (req, res) => {
  const snapshot = await db.collection("device_groups").get();
  const groups = snapshot.docs
    .map((doc) => ({
      group_id: doc.id,
      name: doc.data().name,
      created_at: doc.data().createdAt ? doc.data().createdAt.toDate().toISOString() : null,
      _ms: doc.data().createdAt ? doc.data().createdAt.toMillis() : 0,
    }))
    .sort((a, b) => a._ms - b._ms)
    .map(({ _ms, ...rest }) => rest);
  res.json({ groups });
});

app.post("/api/admin/device-groups", requireAdminSession, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });

  const ref = await db.collection("device_groups").add({
    name: name.trim(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await logAudit(req.adminUsername, "device_group_created", `${ref.id}: ${name.trim()}`);
  res.json({ status: "created", group_id: ref.id, name: name.trim() });
});

app.delete("/api/admin/device-groups/:groupId", requireAdminSession, async (req, res) => {
  const { groupId } = req.params;

  // Guard against deleting a group that's still actively in use — force an
  // explicit reassignment first rather than silently orphaning devices or
  // companies pointing at a group that no longer exists.
  const devicesInGroup = await db.collection("devices_registry").where("approvedGroupId", "==", groupId).get();
  if (!devicesInGroup.empty) {
    return res.status(400).json({ error: `${devicesInGroup.size} device(s) still assigned to this group — reassign or revoke them first` });
  }
  const companiesUsingDefault = await db.collection("company_users").where("defaultGroupId", "==", groupId).get();
  const companiesUsingAlt = await db.collection("company_users").where("alternativeGroupId", "==", groupId).get();
  if (!companiesUsingDefault.empty || !companiesUsingAlt.empty) {
    return res.status(400).json({ error: "One or more companies still reference this group — reassign them first" });
  }

  await db.collection("device_groups").doc(groupId).delete();
  await logAudit(req.adminUsername, "device_group_deleted", groupId);
  res.json({ status: "deleted" });
});

// =============================================================================
// =============================================================================
// 3. DEVICE APPROVAL (session-protected)
// =============================================================================

// Devices without a group live at devices/{telco} (unchanged from before —
// fully backward compatible with every already-approved device). Devices
// assigned to a group live at devices/{groupId}__{telco} instead, so the
// same telco can have a different physical device per group.
function deviceDocId(groupId, telco) {
  return groupId ? `${groupId}__${telco}` : telco;
}

// Lets the app show a dropdown of currently-supported telcos instead of a
// hardcoded list baked into the app — add/remove one in Settings → Telcos
// and every device sees it on next Settings screen load, no app update needed.
app.get("/api/telcos", requireAppSecret, async (req, res) => {
  res.json({ telcos: await getValidTelcos() });
});

app.post("/api/register-device", requireAppSecret, async (req, res) => {
  const { installation_id, token, telco, app_version } = req.body;
  if (!installation_id) return res.status(400).json({ error: "installation_id is required" });
  if (!token) return res.status(400).json({ error: "token is required" });
  if (!(await isValidTelco(telco))) {
    return res.status(400).json({ error: `telco must be one of: ${(await getValidTelcos()).join(", ")}` });
  }

  const telcoKey = telco.toUpperCase();
  const registryRef = db.collection("devices_registry").doc(installation_id);
  const registryDoc = await registryRef.get();

  const alreadyApprovedForThisTelco =
    registryDoc.exists &&
    registryDoc.data().status === "approved" &&
    registryDoc.data().approvedTelco === telcoKey;

  if (alreadyApprovedForThisTelco) {
    const groupId = registryDoc.data().approvedGroupId || null;
    await registryRef.update({
      fcmToken: token,
      requestedTelco: telcoKey,
      appVersion: app_version || "unknown",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection("devices").doc(deviceDocId(groupId, telcoKey)).set({
      fcmToken: token,
      telco: telcoKey,
      groupId,
      installationId: installation_id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return res.json({ status: "registered", telco: telcoKey });
  }

  await registryRef.set(
    {
      installationId: installation_id,
      requestedTelco: telcoKey,
      fcmToken: token,
      appVersion: app_version || "unknown",
      status: "pending",
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  res.json({ status: "pending_approval", telco: telcoKey });
});

app.get("/api/admin/pending-devices", requireAdminSession, async (req, res) => {
  try {
    const snapshot = await db.collection("devices_registry").where("status", "==", "pending").get();

    const pending = snapshot.docs
      .map((doc) => {
        const data = doc.data();
        return {
          installation_id: doc.id,
          requested_telco: data.requestedTelco,
          requested_at: data.requestedAt ? data.requestedAt.toDate().toISOString() : null,
          _sortMs: data.requestedAt ? data.requestedAt.toMillis() : 0,
        };
      })
      .sort((a, b) => b._sortMs - a._sortMs)
      .map(({ _sortMs, ...rest }) => rest);

    res.json({ pending });
  } catch (err) {
    console.error("pending-devices error:", err);
    res.status(500).json({ error: "Failed to load pending devices", details: err.message });
  }
});

app.get("/api/admin/devices", requireAdminSession, async (req, res) => {
  try {
    const snapshot = await db.collection("devices_registry").get();
    const groupsSnapshot = await db.collection("device_groups").get();
    const groupNames = {};
    groupsSnapshot.docs.forEach((doc) => { groupNames[doc.id] = doc.data().name; });
    const s = await getSettings();

    const devices = await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data();
      const sortSource = data.updatedAt || data.approvedAt || data.requestedAt;
      const groupId = data.approvedGroupId || null;

      let currentJobId = null;
      let queueCount = 0;
      let timeoutSeconds = DEFAULT_DEVICE_TIMEOUT_SECONDS;
      let lastCallbackAt = null;
      let lastSuccessAt = null;

      if (data.status === "approved" && data.approvedTelco) {
        const deviceDoc = await db.collection("devices").doc(deviceDocId(groupId, data.approvedTelco)).get();
        if (deviceDoc.exists) {
          const deviceData = deviceDoc.data();
          currentJobId = deviceData.currentJobId || null;
          timeoutSeconds = deviceData.timeoutSeconds || DEFAULT_DEVICE_TIMEOUT_SECONDS;
          lastCallbackAt = deviceData.lastCallbackAt ? deviceData.lastCallbackAt.toDate().toISOString() : null;
          lastSuccessAt = deviceData.lastSuccessAt ? deviceData.lastSuccessAt.toDate().toISOString() : null;
        }
        const queueSnapshot = await db.collection("jobs")
          .where("telco", "==", data.approvedTelco)
          .where("groupId", "==", groupId)
          .where("status", "==", "queued")
          .get();
        queueCount = queueSnapshot.size;
      }

      const appVersion = data.appVersion || null;
      // "Outdated" if we have a configured latest version and this device
      // either never reported one (very old build) or reports something
      // different from it. No configured latest version = can't judge yet.
      const isOutdated = !!s.latestAppVersion && appVersion !== s.latestAppVersion;

      return {
        installation_id: doc.id,
        status: data.status,
        requested_telco: data.requestedTelco,
        approved_telco: data.approvedTelco || null,
        group_id: groupId,
        group_name: groupId ? (groupNames[groupId] || groupId) : "No Group",
        account: data.account || null,
        registered_phone_number: data.registeredPhoneNumber || null,
        custom_fields: data.customFields || {},
        app_version: appVersion,
        is_outdated: isOutdated,
        requested_at: data.requestedAt ? data.requestedAt.toDate().toISOString() : null,
        approved_at: data.approvedAt ? data.approvedAt.toDate().toISOString() : null,
        current_job_id: currentJobId,
        queue_count: queueCount,
        timeout_seconds: timeoutSeconds,
        last_callback_at: lastCallbackAt,
        last_success_at: lastSuccessAt,
        _sortMs: sortSource ? sortSource.toMillis() : 0,
      };
    }));

    devices.sort((a, b) => b._sortMs - a._sortMs);
    const cleaned = devices.map(({ _sortMs, ...rest }) => rest);

    res.json({ devices: cleaned, latest_app_version: s.latestAppVersion });
  } catch (err) {
    console.error("admin/devices error:", err);
    res.status(500).json({ error: "Failed to load devices", details: err.message });
  }
});

// Sets the free-text "Account" label, the SIM's own registered phone
// number, and any custom fields a specific telco's template needs (e.g.
// a per-device code Digi issues) — all admin-entered. Custom fields get
// merged into that device's USSD template automatically at job time.
app.post("/api/admin/devices-registry/:installationId/info", requireAdminSession, async (req, res) => {
  const { account, registered_phone_number, custom_fields } = req.body;
  const ref = db.collection("devices_registry").doc(req.params.installationId);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: "Unknown installation_id" });

  const update = {
    account: account || null,
    registeredPhoneNumber: registered_phone_number || null,
  };
  if (custom_fields && typeof custom_fields === "object") {
    update.customFields = custom_fields;
  }

  await ref.update(update);
  res.json({ status: "updated" });
});

app.post("/api/admin/devices/:telco/timeout", requireAdminSession, async (req, res) => {
  const telcoKey = req.params.telco.toUpperCase();
  const { timeout_seconds, group_id } = req.body;
  const seconds = parseInt(timeout_seconds);
  const groupId = group_id || null;

  if (!(await isValidTelco(telcoKey))) {
    return res.status(400).json({ error: `telco must be one of: ${(await getValidTelcos()).join(", ")}` });
  }
  if (!seconds || seconds < 5 || seconds > 600) {
    return res.status(400).json({ error: "timeout_seconds must be between 5 and 600" });
  }

  const deviceRef = db.collection("devices").doc(deviceDocId(groupId, telcoKey));
  const deviceDoc = await deviceRef.get();
  if (!deviceDoc.exists) return res.status(404).json({ error: `No approved device for telco ${telcoKey} in that group` });

  await deviceRef.update({ timeoutSeconds: seconds });
  res.json({ status: "updated", telco: telcoKey, timeout_seconds: seconds });
});

// Runs the same staleness check tryDispatchNext already does, but for every
// device slot at once — since nothing else runs this automatically in the
// background, the admin panel calls this whenever the Devices tab is
// viewed so stuck jobs get noticed and cleared promptly.
app.post("/api/admin/check-timeouts", requireAdminSession, async (req, res) => {
  await runTimeoutCheck();
  res.json({ status: "checked" });
});

// Same check, but authenticated with a fixed secret instead of an admin
// login session — meant for Cloud Scheduler (or any cron-like caller) to
// hit on a timer, giving genuinely hands-off timeout enforcement without
// anyone needing to open the admin panel.
app.post("/api/internal/check-timeouts", requireCronSecret, async (req, res) => {
  await runTimeoutCheck();
  res.json({ status: "checked" });
});

// Manual override: immediately frees a device's current job regardless of
// whether its timeout has actually elapsed yet, and advances the queue.
// Use this when you know a job is stuck and don't want to wait.
app.post("/api/admin/devices/:telco/force-release", requireAdminSession, async (req, res) => {
  const telcoKey = req.params.telco.toUpperCase();
  const groupId = req.body.group_id || null;
  if (!(await isValidTelco(telcoKey))) {
    return res.status(400).json({ error: `telco must be one of: ${(await getValidTelcos()).join(", ")}` });
  }

  const deviceRef = db.collection("devices").doc(deviceDocId(groupId, telcoKey));
  const deviceDoc = await deviceRef.get();
  if (!deviceDoc.exists) return res.status(404).json({ error: `No approved device for telco ${telcoKey} in that group` });

  const currentJobId = deviceDoc.data().currentJobId;
  if (currentJobId) {
    const jobRef = db.collection("jobs").doc(currentJobId);
    const jobDoc = await jobRef.get();
    if (jobDoc.exists && jobDoc.data().status === "pending") {
      await jobRef.update({
        status: "timeout",
        rawResponse: "Manually released by admin before timeout elapsed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await appendServerLog(`Device for ${telcoKey} manually released by admin`, currentJobId);
    }
    await deviceRef.update({
      currentJobId: admin.firestore.FieldValue.delete(),
      currentJobStartedAt: admin.firestore.FieldValue.delete(),
    });
  }

  await tryDispatchNext(groupId, telcoKey);
  res.json({ status: "released", telco: telcoKey });
});

app.post("/api/admin/approve-device", requireAdminSession, async (req, res) => {
  const { installation_id, telco, group_id } = req.body;
  if (!installation_id) return res.status(400).json({ error: "installation_id is required" });

  const registryRef = db.collection("devices_registry").doc(installation_id);
  const registryDoc = await registryRef.get();
  if (!registryDoc.exists) return res.status(404).json({ error: "Unknown installation_id" });

  const telcoKey = (telco || registryDoc.data().requestedTelco || "").toUpperCase();
  if (!(await isValidTelco(telcoKey))) {
    return res.status(400).json({ error: `telco must be one of: ${(await getValidTelcos()).join(", ")}` });
  }

  // group_id is optional — leave unset (or explicitly "") for the shared
  // ungrouped pool, exactly how every device worked before groups existed.
  const groupId = group_id || null;
  if (groupId) {
    const groupDoc = await db.collection("device_groups").doc(groupId).get();
    if (!groupDoc.exists) return res.status(400).json({ error: "Unknown group_id" });
  }

  const fcmToken = registryDoc.data().fcmToken;

  await registryRef.update({
    status: "approved",
    approvedTelco: telcoKey,
    approvedGroupId: groupId,
    approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection("devices").doc(deviceDocId(groupId, telcoKey)).set({
    fcmToken,
    telco: telcoKey,
    groupId,
    installationId: installation_id,
    timeoutSeconds: DEFAULT_DEVICE_TIMEOUT_SECONDS,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await logAudit(req.adminUsername, "device_approved", `${installation_id} approved for ${telcoKey}${groupId ? ` (group: ${groupId})` : ""}`);
  res.json({ status: "approved", telco: telcoKey, group_id: groupId });
});

app.post("/api/admin/reject-device", requireAdminSession, async (req, res) => {
  const { installation_id } = req.body;
  if (!installation_id) return res.status(400).json({ error: "installation_id is required" });

  const registryRef = db.collection("devices_registry").doc(installation_id);
  const registryDoc = await registryRef.get();
  if (!registryDoc.exists) return res.status(404).json({ error: "Unknown installation_id" });

  await registryRef.update({
    status: "rejected",
    rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logAudit(req.adminUsername, "device_rejected", installation_id);
  res.json({ status: "rejected" });
});

// Revokes a SPECIFIC device by installation_id — not by (telco, group),
// which was the root cause of a real bug: if a newer device had since been
// approved into the same telco/group slot as an older, superseded one,
// clicking Revoke on the OLD device's row would delete the NEW device's
// live routing entry and incorrectly mark the new device as "revoked" too
// (since both rows resolved to the same underlying devices/{docId}). Now,
// the live slot is only touched if it still actually belongs to this exact
// device — otherwise only this device's own registry status is updated.
app.post("/api/admin/revoke-device", requireAdminSession, async (req, res) => {
  const { installation_id } = req.body;
  if (!installation_id) return res.status(400).json({ error: "installation_id is required" });

  const registryRef = db.collection("devices_registry").doc(installation_id);
  const registryDoc = await registryRef.get();
  if (!registryDoc.exists) return res.status(404).json({ error: "Unknown installation_id" });

  const registryData = registryDoc.data();
  const telcoKey = registryData.approvedTelco || null;
  const groupId = registryData.approvedGroupId || null;

  if (telcoKey) {
    const docId = deviceDocId(groupId, telcoKey);
    const deviceDoc = await db.collection("devices").doc(docId).get();
    if (deviceDoc.exists && deviceDoc.data().installationId === installation_id) {
      await db.collection("devices").doc(docId).delete();
    }
    // If the live slot belongs to a different (newer) device, leave it
    // completely untouched — this device being revoked no longer occupies it.
  }

  await registryRef.update({
    status: "revoked",
    revokedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logAudit(req.adminUsername, "device_revoked", `${installation_id} (${telcoKey || "unknown telco"}${groupId ? `, group: ${groupId}` : ""})`);
  res.json({ status: "revoked" });
});

// =============================================================================
// COMPANY PORTAL — login, profile, API keys, credit ledger
// Company accounts are created by admin only (see COMPANY USER MANAGEMENT
// above). This section is what the company itself uses after logging in.
// =============================================================================

app.post("/api/portal/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  const rateCheck = await checkRateLimit("portal_login", username, 5, 15 * 60 * 1000);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: `Too many login attempts, try again in ${rateCheck.retryAfterSeconds}s` });
  }

  const snapshot = await db.collection("company_users").where("username", "==", username).limit(1).get();
  if (snapshot.empty) return res.status(401).json({ error: "Invalid username or password" });

  const userDoc = snapshot.docs[0];
  const match = await bcrypt.compare(password, userDoc.data().passwordHash);
  if (!match) return res.status(401).json({ error: "Invalid username or password" });

  await resetRateLimit("portal_login", username);

  const token = jwt.sign({ userId: userDoc.id, type: "company" }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, username: userDoc.data().username, company_name: userDoc.data().companyName });
});

// ---------- Company profile ----------

app.get("/api/portal/profile", requireCompanySession, async (req, res) => {
  const doc = await db.collection("company_users").doc(req.companyUserId).get();
  if (!doc.exists) return res.status(404).json({ error: "Account not found" });
  const data = doc.data();
  res.json({
    username: data.username,
    company_name: data.companyName || "",
    registration_number: data.registrationNumber || "",
    address: data.address || "",
    phone: data.phone || "",
    email: data.email || "",
    contact_person: data.contactPerson || "",
    credit_balance: data.creditBalance || 0,
    margin_percent: data.marginPercent ?? data.markupPercent ?? 0,
    low_balance_threshold: data.lowBalanceThreshold || 20,
    low_balance_webhook_url: data.lowBalanceWebhookUrl || "",
  });
});

app.post("/api/portal/profile", requireCompanySession, async (req, res) => {
  const { company_name, registration_number, address, phone, email, contact_person, low_balance_threshold, low_balance_webhook_url } = req.body;
  const update = {
    companyName: company_name || null,
    registrationNumber: registration_number || null,
    address: address || null,
    phone: phone || null,
    email: email || null,
    contactPerson: contact_person || null,
  };
  if (typeof low_balance_threshold === "number") update.lowBalanceThreshold = low_balance_threshold;
  if (typeof low_balance_webhook_url === "string") update.lowBalanceWebhookUrl = low_balance_webhook_url || null;

  await db.collection("company_users").doc(req.companyUserId).update(update);
  res.json({ status: "updated" });
});

app.put("/api/portal/password", requireCompanySession, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "password is required" });
  const passwordHash = await bcrypt.hash(password, 10);
  await db.collection("company_users").doc(req.companyUserId).update({ passwordHash });
  res.json({ status: "updated" });
});

// ---------- API keys ----------

app.get("/api/portal/api-keys", requireCompanySession, async (req, res) => {
  const snapshot = await db.collection("api_keys").where("userId", "==", req.companyUserId).get();
  const keys = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        key_masked: data.key.slice(0, 6) + "..." + data.key.slice(-4),
        name: data.name,
        revoked: !!data.revoked,
        created_at: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        _sortMs: data.createdAt ? data.createdAt.toMillis() : 0,
        _id: doc.id,
      };
    })
    .sort((a, b) => b._sortMs - a._sortMs)
    .map(({ _sortMs, _id, ...rest }) => ({ ...rest, id: _id }));

  res.json({ keys });
});

app.post("/api/portal/api-keys", requireCompanySession, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const keyValue = generateApiKeyValue();
  await db.collection("api_keys").doc(keyValue).set({
    key: keyValue,
    userId: req.companyUserId,
    name,
    revoked: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Full key value is only ever returned here, at creation time.
  res.json({ status: "created", api_key: keyValue, name });
});

app.delete("/api/portal/api-keys/:keyId", requireCompanySession, async (req, res) => {
  const keyRef = db.collection("api_keys").doc(req.params.keyId);
  const keyDoc = await keyRef.get();
  if (!keyDoc.exists || keyDoc.data().userId !== req.companyUserId) {
    return res.status(404).json({ error: "API key not found" });
  }
  await keyRef.update({ revoked: true });
  res.json({ status: "revoked" });
});

// ---------- Credit ledger (with date filtering) ----------

app.get("/api/portal/ledger", requireCompanySession, async (req, res) => {
  const { from, to } = req.query;
  const statement = await getLedgerStatement(req.companyUserId, from, to);

  const userDoc = await db.collection("company_users").doc(req.companyUserId).get();
  const currentBalance = userDoc.exists ? userDoc.data().creditBalance || 0 : 0;

  res.json({
    entries: statement.entries,
    balance_bf: statement.balance_bf,
    balance_cf: statement.balance_cf,
    current_balance: currentBalance,
  });
});

app.get("/api/portal/ledger/export", requireCompanySession, async (req, res) => {
  const { from, to } = req.query;
  const statement = await getLedgerStatement(req.companyUserId, from, to);

  const rows = [["Date", "Type", "Amount", "Balance After", "Document No.", "Remarks", "Phone", "Telco"]];
  for (const e of statement.entries) {
    rows.push([
      e.created_at || "", e.type, e.amount, e.balance_after,
      e.document_number || "", e.remarks || "", e.phone || "", e.telco || "",
    ]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="my-credit-statement.csv"`);
  res.send(csv);
});

// ---------- Online reload via Billplz (FPX / DuitNow Transfer) ----------

app.post("/api/portal/billplz/create-bill", requireCompanySession, async (req, res) => {
  const { amount } = req.body;
  const amountNum = Number(amount);
  const s = await getSettings();

  if (!s.billplzSecretKey || !s.billplzCollectionId || !s.billplzXSignatureKey) {
    return res.status(503).json({ error: "Online reload is not configured yet — contact the administrator" });
  }
  if (!amountNum || amountNum < s.billplzMinReload || amountNum > s.billplzMaxReload) {
    return res.status(400).json({ error: `Amount must be between ${s.billplzMinReload} and ${s.billplzMaxReload}` });
  }

  const userDoc = await db.collection("company_users").doc(req.companyUserId).get();
  if (!userDoc.exists) return res.status(404).json({ error: "Account not found" });
  const userData = userDoc.data();
  const companyLabel = userData.companyName || userData.username;

  // Billplz requires an email OR mobile — fall back to a placeholder if the
  // company hasn't filled in their profile email yet.
  const email = userData.email || `${userData.username}@reload.placeholder`;

  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

  let bill;
  try {
    bill = await billplzApiRequest(s, "POST", "/v3/bills", {
      collection_id: s.billplzCollectionId,
      email,
      name: companyLabel,
      amount: Math.round(amountNum * 100), // Billplz wants cents
      description: `Credit reload - ${companyLabel}`,
      callback_url: `${baseUrl}/api/billplz/callback`,
      redirect_url: `${baseUrl}/portal.html`,
      reference_1_label: "CompanyUserId",
      reference_1: req.companyUserId,
      reference_2_label: "Type",
      reference_2: "reload",
    });
  } catch (err) {
    return res.status(502).json({ error: "Failed to create payment", details: err.message });
  }

  // Tracks this specific bill so the webhook can find it and so a retried/
  // duplicate webhook delivery can't credit the same payment twice.
  await db.collection("billplz_bills").doc(bill.id).set({
    userId: req.companyUserId,
    amount: amountNum,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.json({ url: bill.url, bill_id: bill.id });
});

// Called by the portal page after Billplz redirects the browser back with
// ?billplz[id]=...&billplz[paid]=...&billplz[x_signature]=... in the URL.
// This is ONLY for immediate UI feedback — crediting the account always
// happens via the server-to-server callback below, never this redirect,
// since redirects aren't guaranteed to fire (Billplz's own documentation:
// "do not guarantee execution due to network issues, browser closures").
app.get("/api/portal/billplz/verify-redirect", requireCompanySession, async (req, res) => {
  const s = await getSettings();
  if (!s.billplzXSignatureKey) return res.status(503).json({ error: "Not configured" });

  const valid = verifyBillplzRedirectSignature(req.query.billplz, s.billplzXSignatureKey);
  if (!valid) return res.status(400).json({ error: "Signature verification failed", valid: false });

  res.json({
    valid: true,
    paid: req.query.billplz.paid === "true",
    bill_id: req.query.billplz.id,
  });
});

// =============================================================================
// TOP-UP JOBS (external-facing, unchanged auth)
// =============================================================================

// Core top-up logic, shared by the public /api/topup endpoint and the
// admin panel's Test Top-up tool — so admin-initiated tests behave exactly
// like a real call from that company (same credit check, same billing, same
// logs), without ever needing to know or use that company's actual API key.
// Returns { httpStatus, body } instead of touching res directly.
// Resolves which device (by groupId) should handle this company's request
// for this telco. Returns { groupId, deviceData } or null if no matching
// device exists.
//   - No company (legacy key) → always the shared ungrouped pool.
//   - Company with no groups assigned → also the shared ungrouped pool
//     (zero disruption for companies that haven't adopted groups yet).
//   - Company with a group assigned → default group first, then
//     alternative — and ONLY those, no silent fallback to the shared pool,
//     since group assignment is a deliberate isolation choice.
async function resolveRoutingDevice(companyUserId, telcoKey) {
  let defaultGroupId = null;
  let alternativeGroupId = null;

  if (companyUserId) {
    const userDoc = await db.collection("company_users").doc(companyUserId).get();
    if (userDoc.exists) {
      defaultGroupId = userDoc.data().defaultGroupId || null;
      alternativeGroupId = userDoc.data().alternativeGroupId || null;
    }
  }

  const candidateGroups = (defaultGroupId || alternativeGroupId)
    ? [defaultGroupId, alternativeGroupId].filter(Boolean)
    : [null]; // no groups assigned at all → shared ungrouped pool

  for (const groupId of candidateGroups) {
    const deviceDoc = await db.collection("devices").doc(deviceDocId(groupId, telcoKey)).get();
    if (deviceDoc.exists && deviceDoc.data().fcmToken) {
      return { groupId, deviceData: deviceDoc.data() };
    }
  }
  return null;
}

// =============================================================================
// SERVICE TYPES & TELCO CONFIG
// A telco can support multiple service types (Reload, Bill Payment, etc —
// fully admin-defined). Each supported service type has its own USSD
// template, editable live in the admin panel. Templates use {PHONE},
// {AMOUNT}, and any admin-defined extra field placeholders — all resolved
// server-side. {PIN} is deliberately left untouched: it never leaves the
// device, so the app fills that in locally right before dialing.
// =============================================================================

// Applies an optional date-range filter (from/to, both "YYYY-MM-DD") to a
// Firestore query already ordered by createdAt desc. "to" is treated as
// inclusive of that whole day. If a "before" cursor is also present (used
// for Load More pagination within an already-selected range), it takes
// priority as the upper bound so paging doesn't escape the active range.
function applyDateRangeFilter(query, req) {
  if (req.query.from) {
    query = query.where("createdAt", ">=", new Date(req.query.from));
  }
  if (req.query.before) {
    query = query.where("createdAt", "<", new Date(req.query.before));
  } else if (req.query.to) {
    const endExclusive = new Date(new Date(req.query.to).getTime() + 24 * 60 * 60 * 1000);
    query = query.where("createdAt", "<", endExclusive);
  }
  return query;
}

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Ensures a "Reload" service type always exists, so /api/topup (which never
// specifies a service_type) always has something to default to. Runs
// lazily — safe to call on every request, cheap after the first time.
async function ensureDefaultServiceType() {
  const existing = await db.collection("service_types").where("isDefault", "==", true).limit(1).get();
  if (!existing.empty) return existing.docs[0].id;

  const ref = db.collection("service_types").doc("reload");
  await ref.set({
    name: "Reload",
    extraFields: [],
    isDefault: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return "reload";
}

// Ensures every valid telco has a config doc with at least the default
// Reload service type enabled, pre-filled with the syntax every telco has
// used up to now — so switching over to server-side templates doesn't
// break anything that already worked.
async function ensureTelcoConfigsSeeded() {
  const defaultServiceTypeId = await ensureDefaultServiceType();
  const telcos = await getValidTelcos();
  await Promise.all(telcos.map(async (telco) => {
    const ref = db.collection("telco_configs").doc(telco);
    const doc = await ref.get();
    if (doc.exists && doc.data().services && doc.data().services[defaultServiceTypeId]) return;
    await ref.set({
      services: {
        [defaultServiceTypeId]: { enabled: true, template: "*303*{PIN}*1*{AMOUNT}*{PHONE}#" },
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }));
}

// Fills in every placeholder except {PIN} — that one stays literal for the
// device to substitute locally.
function resolveUssdTemplate(template, fields) {
  let result = template;
  for (const [key, value] of Object.entries(fields)) {
    result = result.split(`{${key.toUpperCase()}}`).join(String(value));
  }
  return result;
}

// Reads whatever extra placeholders a SPECIFIC telco's template actually
// uses — e.g. Digi's Reload might need {UNIQUE_CODE} while UMobile's
// Reload doesn't, even though both are "Reload". This means required
// fields are a property of one telco's template, not the service type in
// general — no upfront field declaration needed, just write the
// placeholder into that telco's template and it's automatically required.
function productMarginKey(telco, serviceTypeId) {
  return `${telco}__${serviceTypeId}`;
}

// Margin can be set per (Telco + Service Type) "product" for a company —
// e.g. 5% on UMobile Reload but 3% on Digi Bill Payment — falling back to
// that company's single default margin when no specific override exists.
function resolveMarginPercent(userData, telcoKey, serviceTypeId) {
  const productMargins = userData.productMargins || {};
  const key = productMarginKey(telcoKey, serviceTypeId);
  if (productMargins[key] !== undefined && productMargins[key] !== null) {
    return productMargins[key];
  }
  return userData.marginPercent ?? userData.markupPercent ?? 0;
}

function extractExtraPlaceholders(template) {
  const matches = [...template.matchAll(/\{([A-Z0-9_]+)\}/gi)];
  const reserved = new Set(["PIN", "AMOUNT", "PHONE"]);
  const seen = new Set();
  const extras = [];
  for (const m of matches) {
    const name = m[1].toUpperCase();
    if (reserved.has(name) || seen.has(name)) continue;
    seen.add(name);
    extras.push(name.toLowerCase());
  }
  return extras;
}

async function performTopup({ companyUserId, phone, amount, telco, webhookUrl, idempotencyKey, serviceTypeId, extraFields, channel = "rest_api" }) {
  const channelLabel = channel === "dealer_app" ? "Dealer app" : "REST API";
  if (!phone || !amount) {
    return { httpStatus: 400, body: { error: "phone and amount are required" } };
  }
  if (!(await isValidTelco(telco))) {
    return { httpStatus: 400, body: { error: `telco is required and must be one of: ${(await getValidTelcos()).join(", ")}` } };
  }

  const telcoKey = telco.toUpperCase();
  const amountNum = Number(amount);

  // Default to "Reload" for callers who don't specify a service type
  // (this is exactly what /api/topup does, for full backward compatibility).
  await ensureTelcoConfigsSeeded();
  const resolvedServiceTypeId = serviceTypeId || (await ensureDefaultServiceType());

  const serviceTypeDoc = await db.collection("service_types").doc(resolvedServiceTypeId).get();
  if (!serviceTypeDoc.exists) {
    return { httpStatus: 400, body: { error: `Unknown service_type: ${resolvedServiceTypeId}` } };
  }

  const telcoConfigDoc = await db.collection("telco_configs").doc(telcoKey).get();
  const serviceConfig = telcoConfigDoc.exists ? telcoConfigDoc.data().services?.[resolvedServiceTypeId] : null;
  if (!serviceConfig || !serviceConfig.enabled) {
    return { httpStatus: 400, body: { error: `${telcoKey} does not support service type "${serviceTypeDoc.data().name}"` } };
  }

  if (idempotencyKey) {
    const existing = await db.collection("jobs").where("idempotencyKey", "==", idempotencyKey).get();
    const ownMatch = existing.docs.find((doc) => doc.data().userId === (companyUserId || null));
    if (ownMatch) {
      return {
        httpStatus: 200,
        body: { job_id: ownMatch.id, status: ownMatch.data().status, telco: ownMatch.data().telco, idempotent_replay: true },
      };
    }
  }

  const routing = await resolveRoutingDevice(companyUserId, telcoKey);
  if (!routing) {
    return { httpStatus: 503, body: { error: `No device registered for telco ${telcoKey} in your assigned device group(s)` } };
  }
  const resolvedGroupId = routing.groupId;

  // Fetched early (rather than only later, for margin/credit) since a
  // Trial company's request needs to be validated against the device
  // BEFORE anything else proceeds — see below.
  let userDoc = null;
  if (companyUserId) {
    userDoc = await db.collection("company_users").doc(companyUserId).get();
    if (!userDoc.exists) return { httpStatus: 403, body: { error: "Company account not found" } };
  }

  // Fields the specific device handling this job already knows (e.g. a
  // telco-issued code that's fixed per device, set once in the admin panel
  // and never sent by the API caller). These are filled in automatically —
  // only genuinely per-transaction fields (like a bill account number)
  // still need to come from the caller's extra_fields.
  let deviceCustomFields = {};
  let deviceRegisteredPhone = null;
  if (routing.deviceData.installationId) {
    const registryDoc = await db.collection("devices_registry").doc(routing.deviceData.installationId).get();
    if (registryDoc.exists) {
      deviceCustomFields = registryDoc.data().customFields || {};
      deviceRegisteredPhone = registryDoc.data().registeredPhoneNumber || null;
    }
  }

  // Trial companies get one special shortcut: topping up the assigned
  // device's OWN registered phone number is simulated immediately (no FCM
  // push, no real dial) — credit still deducts normally, so the billing
  // flow is genuinely tested without touching the telco network. Any other
  // number falls through to the exact same real flow as any other company
  // — Trial is not a restriction, just a free repeatable self-test path.
  if (userDoc && userDoc.data().isTrial && deviceRegisteredPhone && phone === deviceRegisteredPhone) {
    const s2 = await getSettings();
    if (amountNum < s2.minTopupAmount || amountNum > s2.maxTopupAmount) {
      return { httpStatus: 400, body: { error: `Amount must be between ${s2.minTopupAmount} and ${s2.maxTopupAmount}` } };
    }

    const marginPercent = resolveMarginPercent(userDoc.data(), telcoKey, resolvedServiceTypeId);
    const billedAmount = Math.round(amountNum * (1 - marginPercent / 100) * 100) / 100;
    const balance = userDoc.data().creditBalance || 0;

    if (balance < billedAmount) {
      const names = await getCompanyNamesMap([companyUserId]);
      const companyLabel = names[companyUserId] || companyUserId;
      const rejectedJobRef = await db.collection("jobs").add({
        phone, amount: amountNum, billedAmount, telco: telcoKey,
        groupId: resolvedGroupId, serviceTypeId: resolvedServiceTypeId,
        channel, status: "rejected",
        rawResponse: `Insufficient credit balance (balance: ${balance}, required: ${billedAmount})`,
        webhookUrl: null, userId: companyUserId, idempotencyKey: idempotencyKey || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await appendServerLog(
        `Trial self-test REJECTED for ${companyLabel} — insufficient credit (balance: ${balance}, required: ${billedAmount})`,
        rejectedJobRef.id
      );
      return { httpStatus: 402, body: { error: "Insufficient credit balance", balance, required: billedAmount } };
    }

    const simulatedJobData = {
      phone, amount: amountNum, billedAmount, telco: telcoKey,
      groupId: resolvedGroupId, serviceTypeId: resolvedServiceTypeId,
      channel, status: "success",
      rawResponse: "Simulated success (Trial self-test — no real dial performed)",
      webhookUrl: webhookUrl || null, userId: companyUserId, idempotencyKey: idempotencyKey || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const jobRef = await db.collection("jobs").add(simulatedJobData);
    await deductCreditForJob(companyUserId, jobRef.id, simulatedJobData);

    const names = await getCompanyNamesMap([companyUserId]);
    await appendServerLog(
      `Trial self-test simulated success for ${names[companyUserId] || companyUserId}: ${phone} (${telcoKey}), amount ${amountNum}`,
      jobRef.id
    );

    return { httpStatus: 200, body: { job_id: jobRef.id, status: "success", telco: telcoKey } };
  }

  // Only non-empty caller-supplied values count — an empty string from a
  // form field shouldn't override a real device-stored value.
  const nonEmptyProvided = Object.fromEntries(
    Object.entries(extraFields || {}).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );
  const mergedFields = { ...deviceCustomFields, ...nonEmptyProvided };

  const requiredExtraFields = extractExtraPlaceholders(serviceConfig.template);
  const missingFields = requiredExtraFields.filter((f) => !mergedFields[f]);
  if (missingFields.length) {
    return { httpStatus: 400, body: { error: `${telcoKey}'s "${serviceTypeDoc.data().name}" template requires: ${missingFields.join(", ")}` } };
  }

  const ussdTemplate = resolveUssdTemplate(serviceConfig.template, {
    phone, amount: amountNum, ...mergedFields,
  });

  const s = await getSettings();
  if (amountNum < s.minTopupAmount || amountNum > s.maxTopupAmount) {
    return { httpStatus: 400, body: { error: `Amount must be between ${s.minTopupAmount} and ${s.maxTopupAmount}` } };
  }

  let billedAmount = amountNum;
  if (companyUserId) {
    // "Margin" is what the company keeps as their commission — it REDUCES
    // the amount actually charged, relative to the topup amount sent to the
    // phone. E.g. topup 10 with a 5% margin bills the company only 9.5.
    // Can be set per (Telco + Service Type) "product" — see resolveMarginPercent.
    const marginPercent = resolveMarginPercent(userDoc.data(), telcoKey, resolvedServiceTypeId);
    billedAmount = Math.round(amountNum * (1 - marginPercent / 100) * 100) / 100;

    const balance = userDoc.data().creditBalance || 0;
    if (balance < billedAmount) {
      const names = await getCompanyNamesMap([companyUserId]);
      const companyLabel = names[companyUserId] || companyUserId;

      const rejectedJobRef = await db.collection("jobs").add({
        phone,
        amount: amountNum,
        billedAmount,
        telco: telcoKey,
        groupId: resolvedGroupId,
        serviceTypeId: resolvedServiceTypeId,
        ussdTemplate,
        channel,
        status: "rejected",
        rawResponse: `Insufficient credit balance (balance: ${balance}, required: ${billedAmount})`,
        webhookUrl: null,
        userId: companyUserId,
        idempotencyKey: idempotencyKey || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await appendServerLog(
        `${channelLabel} top-up REJECTED for ${companyLabel} — insufficient credit (balance: ${balance}, required: ${billedAmount}) for ${phone} (${telcoKey})`,
        rejectedJobRef.id
      );

      return { httpStatus: 402, body: { error: "Insufficient credit balance", balance, required: billedAmount } };
    }
  }

  const jobRef = await db.collection("jobs").add({
    phone,
    amount: amountNum,
    billedAmount,
    telco: telcoKey,
    groupId: resolvedGroupId,
    serviceTypeId: resolvedServiceTypeId,
    ussdTemplate,
    channel,
    status: "queued",
    webhookUrl: webhookUrl || null,
    rawResponse: null,
    userId: companyUserId || null,
    idempotencyKey: idempotencyKey || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await tryDispatchNext(resolvedGroupId, telcoKey);

  const finalDoc = await jobRef.get();

  let companyLabel = "legacy key (no company)";
  if (companyUserId) {
    const names = await getCompanyNamesMap([companyUserId]);
    companyLabel = names[companyUserId] || companyUserId;
  }
  await appendServerLog(
    `${channelLabel} top-up created by ${companyLabel} for ${phone} (${telcoKey}${resolvedGroupId ? `, group: ${resolvedGroupId}` : ""}), amount ${amountNum}`,
    jobRef.id
  );

  return { httpStatus: 200, body: { job_id: jobRef.id, status: finalDoc.data().status, telco: telcoKey } };
}

app.post("/api/topup", resolveApiKey, async (req, res) => {
  const { phone, amount, telco, webhook_url, idempotency_key } = req.body;
  const result = await performTopup({
    companyUserId: req.companyUserId,
    phone, amount, telco,
    webhookUrl: webhook_url,
    idempotencyKey: idempotency_key,
  });
  res.status(result.httpStatus).json(result.body);
});

// Generalized endpoint for any service type a telco supports (Reload, Bill
// Payment, or anything added later via the admin panel) — /api/topup is
// just this endpoint's default-service-type special case, kept separately
// for backward compatibility. Any field beyond phone/amount that a service
// type requires goes in extra_fields.
app.post("/api/service-request", resolveApiKey, async (req, res) => {
  const { phone, amount, telco, service_type, webhook_url, idempotency_key, extra_fields } = req.body;
  if (!service_type) return res.status(400).json({ error: "service_type is required" });

  const result = await performTopup({
    companyUserId: req.companyUserId,
    phone, amount, telco,
    webhookUrl: webhook_url,
    idempotencyKey: idempotency_key,
    serviceTypeId: service_type,
    extraFields: extra_fields || {},
  });
  res.status(result.httpStatus).json(result.body);
});

// Admin panel's "Test Top-up" tool. Behaves exactly like a real call from
// the chosen company (real credit check, real billing, same logs) — or,
// if user_id is omitted, exactly like the legacy global key (no billing).
// Never needs or exposes any company's actual API key.
app.post("/api/admin/test-topup", requireAdminSession, async (req, res) => {
  const { user_id, phone, amount, telco, service_type, extra_fields } = req.body;
  const result = await performTopup({
    companyUserId: user_id || null, phone, amount, telco,
    serviceTypeId: service_type || null,
    extraFields: extra_fields || {},
  });

  const label = user_id ? `company ${user_id}` : "general testing (no company)";
  await logAudit(req.adminUsername, "test_topup", `${label}: ${phone} / ${amount} / ${telco} / ${service_type || "reload"} -> ${result.httpStatus}`);

  res.status(result.httpStatus).json(result.body);
});

// Manual on-device sends (no external caller, no job_id) get logged here so
// they show up in the same USSD Log view as REST-API-triggered jobs.
app.post("/api/ussd-log", requireAppSecret, async (req, res) => {
  const { phone, amount, telco, status, raw_response, installation_id } = req.body;
  if (!phone || !amount || !status) {
    return res.status(400).json({ error: "phone, amount, and status are required" });
  }

  await db.collection("jobs").add({
    phone,
    amount,
    telco: (await isValidTelco(telco)) ? telco.toUpperCase() : null,
    channel: "manual",
    status,
    rawResponse: raw_response || null,
    webhookUrl: null,
    installationId: installation_id || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.json({ status: "logged" });
});

app.post("/api/fcm/callback", requireAppSecret, async (req, res) => {
  const { job_id, status, raw_response } = req.body;
  if (!job_id || !status) {
    return res.status(400).json({ error: "job_id and status are required" });
  }

  const jobRef = db.collection("jobs").doc(job_id);
  const jobDoc = await jobRef.get();
  if (!jobDoc.exists) return res.status(404).json({ error: "Job not found" });
  const jobData = jobDoc.data();

  // Idempotency guard: the app retries this call up to 4 times if it
  // doesn't get a clean response — including the case where the server
  // actually processed it fine but the 200 OK got lost on the way back
  // (a dropped connection right after a successful USSD dial is common).
  // Without this check, a retried "success" would deduct credit a second
  // time for a single real-world top-up. Once a job is marked "success",
  // it's final — any further callback for it is treated as a harmless
  // duplicate, not reprocessed.
  if (jobData.status === "success") {
    return res.json({ status: "already_processed" });
  }

  await jobRef.update({
    status,
    rawResponse: raw_response || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Device-offline visibility: any callback at all proves the phone is
  // alive and reachable; a success additionally proves USSD is working.
  if (jobData.telco) {
    const deviceUpdate = { lastCallbackAt: admin.firestore.FieldValue.serverTimestamp() };
    if (status === "success") deviceUpdate.lastSuccessAt = admin.firestore.FieldValue.serverTimestamp();
    await db.collection("devices").doc(jobData.telco).update(deviceUpdate).catch(() => {});
  }

  // Deduct credit ONLY on success, and only for jobs triggered by a company
  // API key (userId set). Manual sends and legacy-key calls aren't billed.
  if (status === "success" && jobData.userId) {
    await deductCreditForJob(jobData.userId, job_id, jobData);
  }

  const webhookUrl = jobData.webhookUrl;
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id, status, raw_response: raw_response || null }),
    }).catch((err) => console.error("Webhook delivery failed:", err.message));
  }

  // This job is done — free the device (if it was the one holding it) and
  // dispatch whatever's next in that telco/group's queue.
  await completeJobAndAdvanceQueue(jobData.groupId || null, jobData.telco, job_id);

  res.json({ status: "updated" });
});

app.get("/api/topup/:jobId", resolveApiKey, async (req, res) => {
  const jobRef = db.collection("jobs").doc(req.params.jobId);
  const jobDoc = await jobRef.get();
  if (!jobDoc.exists) return res.status(404).json({ error: "Job not found" });

  const data = jobDoc.data();

  // Company keys can only see their own jobs. Legacy global key can see all
  // (used for admin/dev testing).
  if (req.companyUserId && data.userId !== req.companyUserId) {
    return res.status(403).json({ error: "This job does not belong to your account" });
  }

  if (data.status === "pending") {
    const createdAtMs = data.createdAt ? data.createdAt.toMillis() : Date.now();
    if (Date.now() - createdAtMs > JOB_TIMEOUT_MS) {
      await jobRef.update({ status: "timeout", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      data.status = "timeout";
      await completeJobAndAdvanceQueue(data.groupId || null, data.telco, req.params.jobId);
    }
  }

  res.json({
    job_id: jobDoc.id,
    phone: data.phone,
    amount: data.amount,
    telco: data.telco,
    channel: data.channel || "rest_api",
    status: data.status,
    raw_response: data.rawResponse,
  });
});

// =============================================================================
// SUB-DEALER APP (com.ereload.dealer)
// The sub-dealer Android app logs in with the same username/password as the
// company portal (POST /api/portal/login) and uses the company session JWT.
// Reloads go through the exact same performTopup path as /api/topup — same
// margin, credit pre-check, deduction-on-success-only and group routing —
// only tagged channel "dealer_app" so they can be told apart in logs.
// =============================================================================

async function getServiceTypeNamesMap(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const names = {};
  await Promise.all(unique.map(async (id) => {
    const doc = await db.collection("service_types").doc(id).get();
    if (doc.exists) names[id] = doc.data().name;
  }));
  return names;
}

function dealerJobJson(id, data, serviceTypeNames = {}) {
  return {
    job_id: id,
    phone: data.phone,
    amount: data.amount,
    billed_amount: data.billedAmount ?? null,
    telco: data.telco || null,
    service_type: data.serviceTypeId ? (serviceTypeNames[data.serviceTypeId] || data.serviceTypeId) : "Reload",
    channel: data.channel || "rest_api",
    status: data.status,
    raw_response: data.rawResponse || null,
    created_at: data.createdAt ? data.createdAt.toDate().toISOString() : null,
    updated_at: data.updatedAt ? data.updatedAt.toDate().toISOString() : null,
  };
}

// Everything the app's Reload screen needs in one call: balance, the telcos
// that currently have Reload enabled, this company's margin per telco (so the
// confirm screen can show the amount that will be deducted), and the
// configured min/max top-up amount.
app.get("/api/portal/reload-options", requireCompanySession, async (req, res) => {
  const userDoc = await db.collection("company_users").doc(req.companyUserId).get();
  if (!userDoc.exists) return res.status(404).json({ error: "Account not found" });
  const userData = userDoc.data();

  await ensureTelcoConfigsSeeded();
  const reloadServiceTypeId = await ensureDefaultServiceType();
  const settings = await getSettings();

  const telcos = [];
  for (const code of await getValidTelcos()) {
    const cfg = await db.collection("telco_configs").doc(code).get();
    const service = cfg.exists ? cfg.data().services?.[reloadServiceTypeId] : null;
    if (!service || !service.enabled) continue;
    telcos.push({ code, margin_percent: resolveMarginPercent(userData, code, reloadServiceTypeId) });
  }

  res.json({
    company_name: userData.companyName || userData.username,
    credit_balance: userData.creditBalance || 0,
    min_amount: settings.minTopupAmount,
    max_amount: settings.maxTopupAmount,
    telcos,
  });
});

app.post("/api/portal/topup", requireCompanySession, async (req, res) => {
  const { phone, amount, telco, idempotency_key } = req.body || {};
  const cleanPhone = String(phone || "").replace(/[\s-]/g, "");
  if (cleanPhone && !/^\+?\d{8,15}$/.test(cleanPhone)) {
    return res.status(400).json({ error: "Phone number must be 8 to 15 digits" });
  }
  const result = await performTopup({
    companyUserId: req.companyUserId,
    phone: cleanPhone, amount, telco,
    idempotencyKey: idempotency_key,
    channel: "dealer_app",
  });
  res.status(result.httpStatus).json(result.body);
});

// All of this company's jobs (any channel), newest first — includes queued,
// pending, failed, timeout and rejected ones, which the credit ledger
// doesn't show. Same in-memory filtering approach as getLedgerStatement
// (single-field query, no composite index needed).
app.get("/api/portal/jobs", requireCompanySession, async (req, res) => {
  const { from, to, status } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const snapshot = await db.collection("jobs").where("userId", "==", req.companyUserId).get();

  const fromMs = from ? new Date(from + "T00:00:00").getTime() : null;
  const toMs = to ? new Date(to + "T23:59:59").getTime() : null;

  let docs = snapshot.docs.map((doc) => ({ doc, ms: doc.data().createdAt ? doc.data().createdAt.toMillis() : 0 }));
  if (fromMs) docs = docs.filter((d) => d.ms >= fromMs);
  if (toMs) docs = docs.filter((d) => d.ms <= toMs);
  if (status) docs = docs.filter((d) => d.doc.data().status === status);
  docs.sort((a, b) => b.ms - a.ms);
  const page = docs.slice(0, limit);

  const serviceTypeNames = await getServiceTypeNamesMap(page.map((d) => d.doc.data().serviceTypeId));
  res.json({
    jobs: page.map((d) => dealerJobJson(d.doc.id, d.doc.data(), serviceTypeNames)),
    has_more: docs.length > limit,
  });
});

app.get("/api/portal/jobs/:jobId", requireCompanySession, async (req, res) => {
  const jobRef = db.collection("jobs").doc(req.params.jobId);
  const jobDoc = await jobRef.get();
  if (!jobDoc.exists || jobDoc.data().userId !== req.companyUserId) {
    return res.status(404).json({ error: "Reload not found" });
  }
  const data = jobDoc.data();

  // Same stale-pending check as GET /api/topup/:jobId, so the app's status
  // screen doesn't wait for the next cron tick.
  if (data.status === "pending") {
    const createdAtMs = data.createdAt ? data.createdAt.toMillis() : Date.now();
    if (Date.now() - createdAtMs > JOB_TIMEOUT_MS) {
      await jobRef.update({ status: "timeout", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      data.status = "timeout";
      await completeJobAndAdvanceQueue(data.groupId || null, data.telco, req.params.jobId);
    }
  }

  const serviceTypeNames = await getServiceTypeNamesMap([data.serviceTypeId]);
  res.json(dealerJobJson(jobDoc.id, data, serviceTypeNames));
});

// =============================================================================
// 5. LOGS — two sections
//    Section 1 "USSD Log": /api/admin/ussd-logs (from `jobs` collection)
//    Section 2 "Other logs": /api/admin/other-logs (from `logs` collection)
// =============================================================================

app.get("/api/admin/ussd-logs", requireAdminSession, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  // "before" cursor lets the panel page backwards through history. Safe
  // without a composite index since the range filter and orderBy are both
  // on createdAt (same field).
  let query = db.collection("jobs").orderBy("createdAt", "desc");
  query = applyDateRangeFilter(query, req);
  const snapshot = await query.limit(limit).get();

  const userIds = snapshot.docs.map((doc) => doc.data().userId);
  const companyNames = await getCompanyNamesMap(userIds);
  const installationIds = snapshot.docs.map((doc) => doc.data().installationId);
  const deviceAccounts = await getDeviceAccountsMap(installationIds);
  const serviceTypeIds = [...new Set(snapshot.docs.map((doc) => doc.data().serviceTypeId).filter(Boolean))];
  const serviceTypeNames = {};
  await Promise.all(serviceTypeIds.map(async (id) => {
    const doc = await db.collection("service_types").doc(id).get();
    if (doc.exists) serviceTypeNames[id] = doc.data().name;
  }));

  const logs = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      job_id: doc.id,
      channel: data.channel || "rest_api",
      company: data.userId ? (companyNames[data.userId] || data.userId) : null,
      device_account: data.installationId ? (deviceAccounts[data.installationId] || null) : null,
      service_type: data.serviceTypeId ? (serviceTypeNames[data.serviceTypeId] || data.serviceTypeId) : "Reload",
      phone: data.phone,
      amount: data.amount,
      telco: data.telco || null,
      status: data.status,
      raw_response: data.rawResponse || null,
      created_at: data.createdAt ? data.createdAt.toDate().toISOString() : null,
    };
  });

  res.json({ logs, has_more: logs.length === limit });
});

app.get("/api/admin/other-logs", requireAdminSession, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  let query = db.collection("logs").orderBy("createdAt", "desc");
  query = applyDateRangeFilter(query, req);
  const snapshot = await query.limit(limit).get();

  // Resolve company + device attribution via each entry's jobId -> job data.
  const jobIds = [...new Set(snapshot.docs.map((doc) => doc.data().jobId).filter(Boolean))];
  const jobUserIdMap = {};
  const jobInstallationIdMap = {};
  await Promise.all(
    jobIds.map(async (jobId) => {
      const jobDoc = await db.collection("jobs").doc(jobId).get();
      if (jobDoc.exists) {
        if (jobDoc.data().userId) jobUserIdMap[jobId] = jobDoc.data().userId;
        if (jobDoc.data().installationId) jobInstallationIdMap[jobId] = jobDoc.data().installationId;
      }
    })
  );
  const companyNames = await getCompanyNamesMap(Object.values(jobUserIdMap));
  const deviceAccounts = await getDeviceAccountsMap(Object.values(jobInstallationIdMap));

  const logs = snapshot.docs.map((doc) => {
    const data = doc.data();
    const userId = data.jobId ? jobUserIdMap[data.jobId] : null;
    const installationId = data.jobId ? jobInstallationIdMap[data.jobId] : null;
    return {
      message: data.message,
      job_id: data.jobId || null,
      company: userId ? (companyNames[userId] || userId) : null,
      device_account: installationId ? (deviceAccounts[installationId] || null) : null,
      created_at: data.createdAt ? data.createdAt.toDate().toISOString() : null,
    };
  });

  res.json({ logs, has_more: logs.length === limit });
});

// Kept for external/dev use via curl (e.g. quick checks without opening the panel).
app.post("/api/logs", requireAppSecret, async (req, res) => {
  const { message, job_id } = req.body;
  if (!message) return res.status(400).json({ error: "message is required" });

  await db.collection("logs").add({
    message,
    jobId: job_id || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.json({ status: "logged" });
});

app.get("/api/logs", requireApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    let snapshot;
    if (req.query.job_id) {
      snapshot = await db.collection("logs").where("jobId", "==", req.query.job_id).get();
    } else {
      snapshot = await db.collection("logs").orderBy("createdAt", "desc").limit(limit).get();
    }

    let logs = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        message: data.message,
        job_id: data.jobId,
        created_at: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        _sortMs: data.createdAt ? data.createdAt.toMillis() : 0,
      };
    });

    logs.sort((a, b) => b._sortMs - a._sortMs);
    logs = logs.slice(0, limit).map(({ _sortMs, ...rest }) => rest);

    res.json({ logs });
  } catch (err) {
    console.error("logs error:", err);
    res.status(500).json({ error: "Failed to load logs", details: err.message });
  }
});

// =============================================================================
// BILLPLZ CALLBACK (public — Billplz calls this server-to-server, verified
// via X Signature instead of any header-based auth)
// =============================================================================

app.post("/api/billplz/callback", async (req, res) => {
  const s = await getSettings();
  if (!s.billplzXSignatureKey) {
    console.error("Billplz callback received but no X Signature key configured");
    return res.status(200).send("ok"); // ack anyway so Billplz stops retrying
  }

  const valid = verifyBillplzCallbackSignature(req.body, s.billplzXSignatureKey);
  if (!valid) {
    // A failing signature means either someone is spoofing this endpoint, or
    // the X Signature key is misconfigured — either way, don't credit
    // anything. Logged loudly so it's visible in Other Logs.
    await appendServerLog(`Billplz callback SIGNATURE VERIFICATION FAILED for bill ${req.body.id || "unknown"}`, null);
    return res.status(200).send("ok"); // ack so Billplz doesn't hammer retries
  }

  const billId = req.body.id;
  const paid = req.body.paid === "true" || req.body.paid === true;
  const state = req.body.state;

  const pendingRef = db.collection("billplz_bills").doc(billId);
  const pendingDoc = await pendingRef.get();

  if (!pendingDoc.exists) {
    await appendServerLog(`Billplz callback for unknown bill ${billId} — ignored`, null);
    return res.status(200).send("ok");
  }

  const pendingData = pendingDoc.data();
  if (pendingData.status !== "pending") {
    // Already processed (e.g. a retried callback delivery) — idempotent no-op.
    return res.status(200).send("ok");
  }

  if (!paid || state !== "paid") {
    await pendingRef.update({ status: "failed", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await appendServerLog(`Billplz payment not completed for bill ${billId} (state: ${state})`, null);
    return res.status(200).send("ok");
  }

  const userRef = db.collection("company_users").doc(pendingData.userId);
  const documentNumber = await generateDocumentNumber(s.billplzOnlinePrefix);
  const documentDate = new Date().toISOString().slice(0, 10);

  const newBalance = await db.runTransaction(async (t) => {
    const userDoc = await t.get(userRef);
    if (!userDoc.exists) return null;
    const currentBalance = userDoc.data().creditBalance || 0;
    const updatedBalance = currentBalance + pendingData.amount;

    t.update(userRef, { creditBalance: updatedBalance, lowBalanceAlerted: false });
    t.update(pendingRef, { status: "completed", updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    const ledgerRef = db.collection("credit_ledger").doc();
    t.set(ledgerRef, {
      userId: pendingData.userId,
      type: "reload",
      amount: pendingData.amount,
      balanceAfter: updatedBalance,
      documentNumber,
      documentDate,
      createdByAdmin: "SYSTEM (Billplz online reload)",
      remarks: `Billplz Bill ${billId}${req.body.transaction_id ? `, txn ${req.body.transaction_id}` : ""}`,
      attachmentPath: null,
      billplzBillId: billId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return updatedBalance;
  });

  if (newBalance !== null) {
    const names = await getCompanyNamesMap([pendingData.userId]);
    await logAudit("SYSTEM (Billplz)", "online_reload", `${documentNumber}: +${pendingData.amount} for ${names[pendingData.userId] || pendingData.userId}`);
    await appendServerLog(`Billplz online reload completed: ${documentNumber}, +${pendingData.amount} for bill ${billId}`, null);
  }

  res.status(200).send("ok");
});

app.get("/", (req, res) => res.send("USSD Top Up server is running."));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
