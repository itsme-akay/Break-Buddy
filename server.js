import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import webpush from "web-push";
import multer from "multer";

try { process.loadEnvFile(); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ---------- miniOrange OTP (phone verification) ----------
const MO_CUSTOMER_KEY = process.env.MINIORANGE_CUSTOMER_KEY || "";
const MO_API_KEY = process.env.MINIORANGE_API_KEY || "";
const moEnabled = !!(MO_CUSTOMER_KEY && MO_API_KEY);
if (!moEnabled) console.warn("Phone verification disabled: MINIORANGE_CUSTOMER_KEY/MINIORANGE_API_KEY not set in .env");

function moHeaders() {
  const ts = Date.now().toString();
  const sig = crypto.createHash("sha512").update(MO_CUSTOMER_KEY + ts + MO_API_KEY).digest("hex");
  return { "Content-Type": "application/json", "Customer-Key": MO_CUSTOMER_KEY, "Timestamp": ts, "Authorization": sig };
}

async function moSendOtp(phoneE164) {
  const r = await fetch("https://login.xecurify.com/moas/api/auth/challenge", {
    method: "POST",
    headers: moHeaders(),
    body: JSON.stringify({ customerKey: MO_CUSTOMER_KEY, phone: phoneE164, authType: "SMS" }),
  });
  return r.json();
}

async function moValidateOtp(txId, code) {
  const r = await fetch("https://login.xecurify.com/moas/api/auth/validate", {
    method: "POST",
    headers: moHeaders(),
    body: JSON.stringify({ txId, token: code }),
  });
  return r.json();
}

// ---------- sqlite store ----------
const db = new Database(path.join(__dirname, "breakbuddy.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE,
  name TEXT,
  avatar TEXT,
  gender TEXT,
  phone TEXT,
  about TEXT,
  photo1 TEXT,
  photo2 TEXT,
  photo3 TEXT,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS pings (
  id TEXT PRIMARY KEY,
  hostId TEXT,
  type TEXT,
  spot TEXT,
  lat REAL,
  lng REAL,
  createdAt INTEGER,
  startAt INTEGER,
  expiresAt INTEGER
);
CREATE TABLE IF NOT EXISTS joins (
  id TEXT PRIMARY KEY,
  pingId TEXT,
  userId TEXT,
  status TEXT,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  pingId TEXT,
  userId TEXT,
  text TEXT,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY,
  userId TEXT,
  endpoint TEXT UNIQUE,
  p256dh TEXT,
  auth TEXT,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  blockerId TEXT,
  blockedId TEXT,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporterId TEXT,
  reportedId TEXT,
  reason TEXT,
  createdAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pings_host ON pings(hostId);
CREATE INDEX IF NOT EXISTS idx_pings_expires ON pings(expiresAt);
CREATE INDEX IF NOT EXISTS idx_joins_ping ON joins(pingId);
CREATE INDEX IF NOT EXISTS idx_joins_user ON joins(userId);
CREATE INDEX IF NOT EXISTS idx_messages_ping ON messages(pingId);
CREATE INDEX IF NOT EXISTS idx_pushsubs_user ON push_subs(userId);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blockerId);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blockedId);
`);
try { db.exec("ALTER TABLE users ADD COLUMN phone TEXT"); } catch {}
try { db.exec("ALTER TABLE pings ADD COLUMN startAt INTEGER"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN about TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN photo1 TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN photo2 TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN photo3 TEXT"); } catch {}

function id() {
  return crypto.randomBytes(8).toString("hex");
}
function now() {
  return Date.now();
}

// haversine distance in metres
function distance(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

const stmt = {
  insertUser: db.prepare(`INSERT INTO users (id, token, name, avatar, gender, phone, createdAt) VALUES (?,?,?,?,?,?,?)`),
  userByToken: db.prepare(`SELECT * FROM users WHERE token = ?`),
  userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  allUsers: db.prepare(`SELECT * FROM users ORDER BY createdAt DESC`),
  countUsers: db.prepare(`SELECT COUNT(*) c FROM users`),

  insertPing: db.prepare(`INSERT INTO pings (id, hostId, type, spot, lat, lng, createdAt, startAt, expiresAt) VALUES (?,?,?,?,?,?,?,?,?)`),
  expireHostPings: db.prepare(`UPDATE pings SET expiresAt = ? WHERE hostId = ? AND expiresAt > ?`),
  activePings: db.prepare(`SELECT * FROM pings WHERE expiresAt > ?`),
  pingById: db.prepare(`SELECT * FROM pings WHERE id = ?`),
  activeHostPing: db.prepare(`SELECT * FROM pings WHERE hostId = ? AND expiresAt > ? ORDER BY expiresAt DESC LIMIT 1`),
  countPings: db.prepare(`SELECT COUNT(*) c FROM pings`),

  insertJoin: db.prepare(`INSERT INTO joins (id, pingId, userId, status, createdAt) VALUES (?,?,?,?,?)`),
  joinByPingUser: db.prepare(`SELECT * FROM joins WHERE pingId = ? AND userId = ?`),
  joinsByPing: db.prepare(`SELECT * FROM joins WHERE pingId = ?`),
  joinById: db.prepare(`SELECT * FROM joins WHERE id = ?`),
  acceptJoin: db.prepare(`UPDATE joins SET status = 'accepted' WHERE id = ?`),
  acceptedJoinsByPing: db.prepare(`SELECT * FROM joins WHERE pingId = ? AND status = 'accepted'`),
  pendingJoinsByPing: db.prepare(`SELECT * FROM joins WHERE pingId = ? AND status = 'pending'`),
  acceptedJoinByPingUser: db.prepare(`SELECT * FROM joins WHERE pingId = ? AND userId = ? AND status = 'accepted'`),
  countJoins: db.prepare(`SELECT COUNT(*) c FROM joins`),
  countAcceptedJoins: db.prepare(`SELECT COUNT(*) c FROM joins WHERE status='accepted'`),

  insertMessage: db.prepare(`INSERT INTO messages (id, pingId, userId, text, createdAt) VALUES (?,?,?,?,?)`),
  messagesByPing: db.prepare(`SELECT * FROM messages WHERE pingId = ? ORDER BY createdAt ASC`),
  countMessages: db.prepare(`SELECT COUNT(*) c FROM messages`),

  insertPushSub: db.prepare(`INSERT OR REPLACE INTO push_subs (id, userId, endpoint, p256dh, auth, createdAt) VALUES (?,?,?,?,?,?)`),
  pushSubsByUser: db.prepare(`SELECT * FROM push_subs WHERE userId = ?`),
  deletePushSubByEndpoint: db.prepare(`DELETE FROM push_subs WHERE endpoint = ?`),
  countPushUsers: db.prepare(`SELECT COUNT(DISTINCT userId) c FROM push_subs`),

  insertBlock: db.prepare(`INSERT INTO blocks (id, blockerId, blockedId, createdAt) VALUES (?,?,?,?)`),
  isBlockedEitherWay: db.prepare(`SELECT 1 FROM blocks WHERE (blockerId=? AND blockedId=?) OR (blockerId=? AND blockedId=?) LIMIT 1`),
  countBlocks: db.prepare(`SELECT COUNT(*) c FROM blocks`),

  insertReport: db.prepare(`INSERT INTO reports (id, reporterId, reportedId, reason, createdAt) VALUES (?,?,?,?,?)`),
  countReports: db.prepare(`SELECT COUNT(*) c FROM reports`),

  updateAbout: db.prepare(`UPDATE users SET about = ? WHERE id = ?`),
  updatePhotos: db.prepare(`UPDATE users SET photo1 = ?, photo2 = ?, photo3 = ? WHERE id = ?`),
};

function isBlocked(userIdA, userIdB) {
  return !!stmt.isBlockedEitherWay.get(userIdA, userIdB, userIdB, userIdA);
}

function userPhotos(u) {
  return [u.photo1, u.photo2, u.photo3].filter(Boolean);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function publicUser(u) {
  if (!u) return null;
  const photos = userPhotos(u);
  return { id: u.id, name: u.name, avatar: u.avatar, gender: u.gender, photo: photos[0] || null };
}

function fullProfile(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, avatar: u.avatar, gender: u.gender, about: u.about || "", photos: userPhotos(u) };
}
function isActive(p) {
  return !!p && p.expiresAt > now();
}

// ---------- web push ----------
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const pushEnabled = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushEnabled) {
  webpush.setVapidDetails("mailto:hello@breakbuddies.in", VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn("Push notifications disabled: VAPID keys not set in .env");
}

function notifyUser(userId, payload) {
  if (!pushEnabled) return;
  for (const s of stmt.pushSubsByUser.all(userId)) {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    webpush.sendNotification(subscription, JSON.stringify(payload)).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) stmt.deletePushSubByEndpoint.run(s.endpoint);
    });
  }
}

// ---------- app ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => { res.set("Cache-Control", "no-cache"); next(); });
app.use(express.static(path.join(__dirname, "public")));

const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".jpg").toLowerCase().replace(/[^a-z0-9.]/g, "");
      cb(null, `${req.user.id}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) return cb(new Error("images only"));
    cb(null, true);
  },
});

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.body?.token;
  const user = token ? stmt.userByToken.get(token) : null;
  if (!user) return res.status(401).json({ error: "not logged in" });
  req.user = user;
  next();
}

// send an OTP to a phone number (miniOrange)
app.post("/api/otp/send", async (req, res) => {
  if (!moEnabled) return res.status(500).json({ error: "phone verification not configured yet" });
  const digits = String(req.body?.phone || "").replace(/\D/g, "");
  if (digits.length < 10) return res.status(400).json({ error: "valid phone number required" });
  const e164 = digits.length === 10 ? "91" + digits : digits;
  try {
    const data = await moSendOtp(e164);
    if (data.status !== "SUCCESS") return res.status(400).json({ error: data.message || "could not send OTP" });
    res.json({ txId: data.txId });
  } catch {
    res.status(500).json({ error: "could not send OTP, try again" });
  }
});

// sign up / login — verifies the OTP server-side before creating the account
app.post("/api/session", async (req, res) => {
  const { name, avatar, gender, phone: rawPhone, txId, code } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
  if (!moEnabled) return res.status(500).json({ error: "phone verification not configured yet" });
  if (!txId || !code) return res.status(400).json({ error: "phone verification required" });
  let result;
  try { result = await moValidateOtp(txId, code); } catch { return res.status(500).json({ error: "verification failed, try again" }); }
  if (result.status !== "SUCCESS") return res.status(401).json({ error: "invalid or expired OTP" });
  const phone = String(rawPhone || "").replace(/\D/g, "").slice(0, 15);
  if (phone.length < 10) return res.status(400).json({ error: "valid phone number required" });
  const user = {
    id: id(),
    token: crypto.randomBytes(16).toString("hex"),
    name: name.trim().slice(0, 30),
    avatar: avatar || "🙂",
    gender: gender || "",
    phone,
    createdAt: now(),
  };
  stmt.insertUser.run(user.id, user.token, user.name, user.avatar, user.gender, user.phone, user.createdAt);
  res.json({ token: user.token, user: publicUser(user) });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: { ...fullProfile(req.user), phone: req.user.phone } });
});

// upload 1-3 profile photos (replaces existing)
app.post("/api/profile/photos", auth, (req, res) => {
  upload.array("photos", 3)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "upload failed" });
    if (!req.files || !req.files.length) return res.status(400).json({ error: "at least one photo required" });
    const urls = req.files.slice(0, 3).map((f) => `/uploads/${f.filename}`);
    while (urls.length < 3) urls.push(null);
    stmt.updatePhotos.run(urls[0], urls[1], urls[2], req.user.id);
    res.json({ photos: urls.filter(Boolean) });
  });
});

// update "about" text
app.post("/api/profile/about", auth, (req, res) => {
  const about = String(req.body?.about || "").slice(0, 300);
  stmt.updateAbout.run(about, req.user.id);
  res.json({ about });
});

// view another user's public profile
app.get("/api/users/:id", auth, (req, res) => {
  const u = stmt.userById.get(req.params.id);
  if (!u) return res.status(404).json({ error: "not found" });
  res.json({ user: fullProfile(u) });
});

// push notifications: public key + subscribe/unsubscribe
app.get("/api/push/key", (req, res) => {
  res.json({ key: VAPID_PUBLIC, enabled: pushEnabled });
});

app.post("/api/push/subscribe", auth, (req, res) => {
  const sub = req.body?.subscription;
  if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: "invalid subscription" });
  stmt.insertPushSub.run(id(), req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, now());
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", auth, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) stmt.deletePushSubByEndpoint.run(endpoint);
  res.json({ ok: true });
});

// create a break ping
app.post("/api/pings", auth, (req, res) => {
  const { type, duration, spot, lat, lng, startAt } = req.body || {};
  if (typeof lat !== "number" || typeof lng !== "number")
    return res.status(400).json({ error: "location required" });
  if (!spot || !String(spot).trim())
    return res.status(400).json({ error: "meeting spot required" });
  const mins = Math.min(Math.max(parseInt(duration, 10) || 20, 5), 60);
  const start = Math.max(parseInt(startAt, 10) || now(), now());
  stmt.expireHostPings.run(now(), req.user.id, now());
  const ping = {
    id: id(),
    hostId: req.user.id,
    type: type || "chai",
    spot: String(spot).trim().slice(0, 60),
    lat,
    lng,
    createdAt: now(),
    startAt: start,
    expiresAt: start + mins * 60000,
  };
  stmt.insertPing.run(ping.id, ping.hostId, ping.type, ping.spot, ping.lat, ping.lng, ping.createdAt, ping.startAt, ping.expiresAt);
  res.json({ ping });
});

// nearby active pings
app.get("/api/pings", auth, (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = parseInt(req.query.radius, 10) || 3000;
  const hasLoc = !isNaN(lat) && !isNaN(lng);
  const out = stmt.activePings
    .all(now())
    .filter((p) => p.hostId === req.user.id || !isBlocked(req.user.id, p.hostId))
    .map((p) => {
      const host = stmt.userById.get(p.hostId);
      const accepted = stmt.acceptedJoinsByPing.all(p.id);
      const myJoin = stmt.joinByPingUser.get(p.id, req.user.id);
      const dist = hasLoc ? distance(lat, lng, p.lat, p.lng) : null;
      return {
        id: p.id,
        type: p.type,
        spot: p.spot,
        host: publicUser(host),
        isMine: p.hostId === req.user.id,
        joinedCount: accepted.length,
        myJoinStatus: myJoin ? myJoin.status : null,
        startAt: p.startAt,
        expiresAt: p.expiresAt,
        lat: p.lat,
        lng: p.lng,
        distance: dist,
      };
    })
    .filter((p) => (hasLoc ? p.distance <= radius || p.isMine : true))
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  res.json({ pings: out });
});

// my active ping with join requests
app.get("/api/my-ping", auth, (req, res) => {
  const ping = stmt.activeHostPing.get(req.user.id, now());
  if (!ping) return res.json({ ping: null });
  const joins = stmt.joinsByPing.all(ping.id).map((j) => ({
    id: j.id,
    status: j.status,
    user: publicUser(stmt.userById.get(j.userId)),
  }));
  res.json({ ping: { ...ping, joins } });
});

// join a ping
app.post("/api/pings/:id/join", auth, (req, res) => {
  const ping = stmt.pingById.get(req.params.id);
  if (!ping || !isActive(ping)) return res.status(404).json({ error: "break not found" });
  if (ping.hostId === req.user.id) return res.status(400).json({ error: "your own break" });
  if (isBlocked(req.user.id, ping.hostId)) return res.status(403).json({ error: "not available" });
  let join = stmt.joinByPingUser.get(ping.id, req.user.id);
  if (!join) {
    join = { id: id(), pingId: ping.id, userId: req.user.id, status: "pending", createdAt: now() };
    stmt.insertJoin.run(join.id, join.pingId, join.userId, join.status, join.createdAt);
    notifyUser(ping.hostId, {
      title: `${req.user.name} wants to join`,
      body: `Tap to accept their ${ping.type} break request`,
      url: `/?openChat=${ping.id}&mine=1`,
    });
  }
  res.json({ join });
});

// accept a join request (host only)
app.post("/api/joins/:id/accept", auth, (req, res) => {
  const join = stmt.joinById.get(req.params.id);
  if (!join) return res.status(404).json({ error: "not found" });
  const ping = stmt.pingById.get(join.pingId);
  if (!ping || ping.hostId !== req.user.id) return res.status(403).json({ error: "not your break" });
  stmt.acceptJoin.run(join.id);
  notifyUser(join.userId, {
    title: "You're in!",
    body: `${req.user.name} accepted your ${ping.type} break. Meet at ${ping.spot}.`,
    url: `/?openChat=${ping.id}&mine=0`,
  });
  res.json({ join: { ...join, status: "accepted" } });
});

// chat: get messages (participants only)
function canChat(ping, userId) {
  if (!ping) return false;
  if (isBlocked(userId, ping.hostId)) return false;
  if (ping.hostId === userId) return true;
  return !!stmt.acceptedJoinByPingUser.get(ping.id, userId);
}

// block a user (mutual: hides each other's breaks, blocks join/chat)
app.post("/api/block", auth, (req, res) => {
  const { userId } = req.body || {};
  if (!userId || userId === req.user.id) return res.status(400).json({ error: "invalid user" });
  if (!isBlocked(req.user.id, userId)) {
    stmt.insertBlock.run(id(), req.user.id, userId, now());
  }
  res.json({ ok: true });
});

// report a user
app.post("/api/report", auth, (req, res) => {
  const { userId, reason } = req.body || {};
  if (!userId) return res.status(400).json({ error: "invalid user" });
  stmt.insertReport.run(id(), req.user.id, userId, String(reason || "").slice(0, 300), now());
  res.json({ ok: true });
});

app.get("/api/pings/:id/messages", auth, (req, res) => {
  const ping = stmt.pingById.get(req.params.id);
  if (!canChat(ping, req.user.id)) return res.status(403).json({ error: "not a participant" });
  const msgs = stmt.messagesByPing.all(ping.id).map((m) => ({
    id: m.id,
    text: m.text,
    createdAt: m.createdAt,
    user: publicUser(stmt.userById.get(m.userId)),
    mine: m.userId === req.user.id,
  }));
  res.json({ spot: ping.spot, messages: msgs });
});

app.post("/api/pings/:id/messages", auth, (req, res) => {
  const ping = stmt.pingById.get(req.params.id);
  if (!canChat(ping, req.user.id)) return res.status(403).json({ error: "not a participant" });
  const text = (req.body?.text || "").trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: "empty" });
  const msg = { id: id(), pingId: ping.id, userId: req.user.id, text, createdAt: now() };
  stmt.insertMessage.run(msg.id, msg.pingId, msg.userId, msg.text, msg.createdAt);

  const recipients = new Set();
  if (ping.hostId !== req.user.id) recipients.add(ping.hostId);
  for (const j of stmt.acceptedJoinsByPing.all(ping.id)) {
    if (j.userId !== req.user.id) recipients.add(j.userId);
  }
  for (const uid of recipients) {
    const mine = uid === ping.hostId ? 1 : 0;
    notifyUser(uid, { title: req.user.name, body: text, url: `/?openChat=${ping.id}&mine=${mine}` });
  }

  res.json({ message: msg });
});

// my chats: active breaks i host or have been accepted into
app.get("/api/my-chats", auth, (req, res) => {
  const uid = req.user.id;
  const chats = [];
  for (const p of stmt.activePings.all(now())) {
    const isMine = p.hostId === uid;
    const accepted = !!stmt.acceptedJoinByPingUser.get(p.id, uid);
    if (!isMine && !accepted) continue;
    const host = stmt.userById.get(p.hostId);
    const acceptedCount = stmt.acceptedJoinsByPing.all(p.id).length;
    const pending = isMine ? stmt.pendingJoinsByPing.all(p.id).length : 0;
    chats.push({
      id: p.id,
      type: p.type,
      spot: p.spot,
      isMine,
      hostName: host ? host.name : "",
      hostAvatar: host ? host.avatar : "🙂",
      acceptedCount,
      pending,
      expiresAt: p.expiresAt,
    });
  }
  chats.sort((a, b) => b.expiresAt - a.expiresAt);
  res.json({ chats });
});

// ---------- basic admin dashboard ----------
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "breakbuddy123";

function requireAdminAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const [scheme, encoded] = hdr.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Break Buddies Admin"');
  res.status(401).send("Authentication required.");
}

app.get("/admin", requireAdminAuth, (req, res) => {
  const fmt = (ts) => new Date(ts).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  const totalUsers = stmt.countUsers.get().c;
  const activePings = stmt.activePings.all(now());
  const totalPingsEver = stmt.countPings.get().c;
  const totalJoins = stmt.countJoins.get().c;
  const acceptedJoins = stmt.countAcceptedJoins.get().c;
  const totalMessages = stmt.countMessages.get().c;
  const pushUsers = stmt.countPushUsers.get().c;
  const totalBlocks = stmt.countBlocks.get().c;
  const totalReports = stmt.countReports.get().c;

  const activeRows = activePings
    .map((p) => {
      const host = stmt.userById.get(p.hostId);
      return `<tr><td>${host ? host.name : "?"}</td><td>${p.type}</td><td>${p.spot || ""}</td><td>${fmt(p.expiresAt)}</td></tr>`;
    })
    .join("");
  const recentUsers = stmt.allUsers.all().slice(0, 30);
  const userRows = recentUsers
    .map((u) => {
      const photoCount = userPhotos(u).length;
      return `<tr><td>${u.avatar || ""}</td><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.gender) || "-"}</td><td>${escapeHtml(u.phone)}</td><td>${photoCount}</td><td>${escapeHtml(u.about) || "-"}</td><td>${fmt(u.createdAt)}</td></tr>`;
    })
    .join("");
  const recentReports = db.prepare(`SELECT * FROM reports ORDER BY createdAt DESC LIMIT 30`).all();
  const reportRows = recentReports
    .map((r) => {
      const reporter = stmt.userById.get(r.reporterId);
      const reported = stmt.userById.get(r.reportedId);
      return `<tr><td>${reporter ? reporter.name : "?"}</td><td>${reported ? reported.name : "?"}</td><td>${r.reason || ""}</td><td>${fmt(r.createdAt)}</td></tr>`;
    })
    .join("");

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Break Buddies — Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0e27;color:#fff;padding:24px;margin:0;}
h1{font-size:20px;margin:0 0 4px;}
.sub{color:#8b93a7;font-size:13px;margin-bottom:28px;}
.stats{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:32px;}
.stat{background:#11162e;border:1px solid #232945;border-radius:14px;padding:16px 22px;min-width:140px;}
.stat .n{font-size:28px;font-weight:700;color:#22c55e;}
.stat .l{font-size:12px;color:#8b93a7;margin-top:4px;}
table{width:100%;border-collapse:collapse;margin-bottom:36px;font-size:13px;}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #232945;}
th{color:#8b93a7;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.03em;}
h2{font-size:15px;margin:0 0 12px;}
.tag{display:inline-block;font-size:11px;padding:3px 9px;border-radius:20px;background:${pushEnabled ? "#0f6e56" : "#712b13"};color:#fff;margin-bottom:28px;}
</style></head>
<body>
<h1>Break Buddies — Admin</h1>
<p class="sub">Auto-refreshes every 30s · last updated ${fmt(Date.now())} · storage: SQLite</p>
<span class="tag">push notifications: ${pushEnabled ? "enabled" : "disabled (set VAPID keys in .env)"}</span>
<div class="stats">
<div class="stat"><div class="n">${totalUsers}</div><div class="l">total signups</div></div>
<div class="stat"><div class="n">${activePings.length}</div><div class="l">active breaks now</div></div>
<div class="stat"><div class="n">${totalPingsEver}</div><div class="l">breaks created (all time)</div></div>
<div class="stat"><div class="n">${acceptedJoins}</div><div class="l">successful meetups</div></div>
<div class="stat"><div class="n">${totalJoins}</div><div class="l">total join requests</div></div>
<div class="stat"><div class="n">${totalMessages}</div><div class="l">chat messages sent</div></div>
<div class="stat"><div class="n">${pushUsers}</div><div class="l">users with notifications on</div></div>
<div class="stat"><div class="n">${totalReports}</div><div class="l">reports filed</div></div>
<div class="stat"><div class="n">${totalBlocks}</div><div class="l">users blocked</div></div>
</div>
<h2>Recent reports</h2>
<table><tr><th>Reporter</th><th>Reported</th><th>Reason</th><th>When</th></tr>${reportRows || '<tr><td colspan="4">No reports</td></tr>'}</table>
<h2>Active breaks right now</h2>
<table><tr><th>Host</th><th>Type</th><th>Spot</th><th>Expires</th></tr>${activeRows || '<tr><td colspan="4">None active</td></tr>'}</table>
<h2>Recent signups</h2>
<table><tr><th>Avatar</th><th>Name</th><th>Gender</th><th>Phone</th><th>Photos</th><th>About</th><th>Joined</th></tr>${userRows || '<tr><td colspan="7">No users yet</td></tr>'}</table>
<script>setTimeout(()=>location.reload(), 30000)</script>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Break Buddies portal running: http://localhost:${PORT}`);
});
