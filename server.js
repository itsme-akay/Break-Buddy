import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import webpush from "web-push";

try { process.loadEnvFile(); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

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
CREATE INDEX IF NOT EXISTS idx_pings_host ON pings(hostId);
CREATE INDEX IF NOT EXISTS idx_pings_expires ON pings(expiresAt);
CREATE INDEX IF NOT EXISTS idx_joins_ping ON joins(pingId);
CREATE INDEX IF NOT EXISTS idx_joins_user ON joins(userId);
CREATE INDEX IF NOT EXISTS idx_messages_ping ON messages(pingId);
CREATE INDEX IF NOT EXISTS idx_pushsubs_user ON push_subs(userId);
`);

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
  insertUser: db.prepare(`INSERT INTO users (id, token, name, avatar, gender, createdAt) VALUES (?,?,?,?,?,?)`),
  userByToken: db.prepare(`SELECT * FROM users WHERE token = ?`),
  userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  allUsers: db.prepare(`SELECT * FROM users ORDER BY createdAt DESC`),
  countUsers: db.prepare(`SELECT COUNT(*) c FROM users`),

  insertPing: db.prepare(`INSERT INTO pings (id, hostId, type, spot, lat, lng, createdAt, expiresAt) VALUES (?,?,?,?,?,?,?,?)`),
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
};

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, avatar: u.avatar, gender: u.gender };
}
function isActive(p) {
  return !!p && p.expiresAt > now();
}

// ---------- web push ----------
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const pushEnabled = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushEnabled) {
  webpush.setVapidDetails("mailto:hello@breakbuddy.app", VAPID_PUBLIC, VAPID_PRIVATE);
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
app.use(express.static(path.join(__dirname, "public")));

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.body?.token;
  const user = token ? stmt.userByToken.get(token) : null;
  if (!user) return res.status(401).json({ error: "not logged in" });
  req.user = user;
  next();
}

// sign up / login (lightweight)
app.post("/api/session", (req, res) => {
  const { name, avatar, gender } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
  const user = {
    id: id(),
    token: crypto.randomBytes(16).toString("hex"),
    name: name.trim().slice(0, 30),
    avatar: avatar || "🙂",
    gender: gender || "",
    createdAt: now(),
  };
  stmt.insertUser.run(user.id, user.token, user.name, user.avatar, user.gender, user.createdAt);
  res.json({ token: user.token, user: publicUser(user) });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
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
  const { type, duration, spot, lat, lng } = req.body || {};
  if (typeof lat !== "number" || typeof lng !== "number")
    return res.status(400).json({ error: "location required" });
  if (!spot || !String(spot).trim())
    return res.status(400).json({ error: "meeting spot required" });
  const mins = Math.min(Math.max(parseInt(duration, 10) || 20, 5), 60);
  stmt.expireHostPings.run(now(), req.user.id, now());
  const ping = {
    id: id(),
    hostId: req.user.id,
    type: type || "chai",
    spot: String(spot).trim().slice(0, 60),
    lat,
    lng,
    createdAt: now(),
    expiresAt: now() + mins * 60000,
  };
  stmt.insertPing.run(ping.id, ping.hostId, ping.type, ping.spot, ping.lat, ping.lng, ping.createdAt, ping.expiresAt);
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
  let join = stmt.joinByPingUser.get(ping.id, req.user.id);
  if (!join) {
    join = { id: id(), pingId: ping.id, userId: req.user.id, status: "pending", createdAt: now() };
    stmt.insertJoin.run(join.id, join.pingId, join.userId, join.status, join.createdAt);
    notifyUser(ping.hostId, {
      title: `${req.user.name} wants to join`,
      body: `Tap to accept their ${ping.type} break request`,
      url: "/",
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
    url: "/",
  });
  res.json({ join: { ...join, status: "accepted" } });
});

// chat: get messages (participants only)
function canChat(ping, userId) {
  if (!ping) return false;
  if (ping.hostId === userId) return true;
  return !!stmt.acceptedJoinByPingUser.get(ping.id, userId);
}

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
  for (const uid of recipients) notifyUser(uid, { title: req.user.name, body: text, url: "/" });

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
  res.set("WWW-Authenticate", 'Basic realm="Break Buddy Admin"');
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

  const activeRows = activePings
    .map((p) => {
      const host = stmt.userById.get(p.hostId);
      return `<tr><td>${host ? host.name : "?"}</td><td>${p.type}</td><td>${p.spot || ""}</td><td>${fmt(p.expiresAt)}</td></tr>`;
    })
    .join("");
  const recentUsers = stmt.allUsers.all().slice(0, 30);
  const userRows = recentUsers
    .map((u) => `<tr><td>${u.avatar || ""}</td><td>${u.name}</td><td>${fmt(u.createdAt)}</td></tr>`)
    .join("");

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Break Buddy — Admin</title>
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
<h1>Break Buddy — Admin</h1>
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
</div>
<h2>Active breaks right now</h2>
<table><tr><th>Host</th><th>Type</th><th>Spot</th><th>Expires</th></tr>${activeRows || '<tr><td colspan="4">None active</td></tr>'}</table>
<h2>Recent signups</h2>
<table><tr><th>Avatar</th><th>Name</th><th>Joined</th></tr>${userRows || '<tr><td colspan="3">No users yet</td></tr>'}</table>
<script>setTimeout(()=>location.reload(), 30000)</script>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Break Buddy portal running: http://localhost:${PORT}`);
});
