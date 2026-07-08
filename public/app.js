// ---------- state ----------
let token = localStorage.getItem("bb_token") || null;
let me = null;
let myLoc = null;          // {lat, lng}
let map, meMarker, pingMarkers = {};
let homeTimer, chatTimer, myPingTimer;
let openPingId = null;     // currently open in detail sheet
let openPingIsMine = false;
let latestPings = [];      // last nearby fetch

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

document.getElementById("gateUrl").textContent = location.host || "localhost:3000";

// ---------- api helper ----------
async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: "error" }));
  return res.json();
}

const ICON_DIR = "/assest/Icons/";
const TYPE_ICON_IMG = { chai: "chai-icons.webp", coffee: "coffe-icon.webp", smoke: "cigrate-icons.webp", drinks: "coke-icon.webp" };
const TYPE_EMOJI = { walk: "🚶", chill: "🎧" };
function icon(t) {
  if (TYPE_ICON_IMG[t]) return `<img src="${ICON_DIR}${TYPE_ICON_IMG[t]}" alt="" class="type-ico">`;
  return TYPE_EMOJI[t] || "🙂";
}
const TYPE_LABEL = { chai: "chai", coffee: "coffee", walk: "a walk", smoke: "a smoke", chill: "a chill sesh", drinks: "drinks" };
function typeIconHtml(t, cls, emojiSize) {
  if (TYPE_ICON_IMG[t]) return `<img class="${cls}" src="${ICON_DIR}${TYPE_ICON_IMG[t]}" alt="">`;
  return `<span class="${cls}" style="font-size:${emojiSize}px;line-height:1;display:inline-block;">${TYPE_EMOJI[t] || "🙂"}</span>`;
}

// ---------- screens ----------
function show(screen) {
  $$(".screen").forEach((s) => s.classList.remove("active"));
  $("#screen-" + screen).classList.add("active");
}

// ---------- LOGIN ----------
let pickedAvatar = "🙂";
let pickedGender = "";

$("#avatarPick").addEventListener("click", (e) => {
  if (!e.target.classList.contains("av")) return;
  $$("#avatarPick .av").forEach((a) => a.classList.remove("selected"));
  e.target.classList.add("selected");
  pickedAvatar = e.target.textContent;
});

$("#genderSeg").addEventListener("click", (e) => {
  if (e.target.tagName !== "BUTTON") return;
  $$("#genderSeg button").forEach((b) => b.classList.remove("selected"));
  e.target.classList.add("selected");
  pickedGender = e.target.dataset.g;
});

$("#loginBtn").addEventListener("click", async () => {
  const name = $("#nameInput").value.trim();
  if (!name) { $("#loginErr").textContent = "enter your name"; return; }
  $("#loginErr").textContent = "";
  try {
    const r = await api("/api/session", "POST", { name, avatar: pickedAvatar, gender: pickedGender });
    token = r.token; me = r.user;
    localStorage.setItem("bb_token", token);
    enterHome();
  } catch (e) { $("#loginErr").textContent = e.error || "something went wrong"; }
});

// ---------- HOME ----------
async function enterHome() {
  clearInterval(heroTimer);
  show("home");
  $("#meChip").innerHTML = `${avatarHtml(me.avatar, "avatar-badge")} ${me.name}`;
  initMap();
  locateMe();
  startHomePolling();
  initPush();
}

function initMap() {
  if (map) return;
  map = L.map("map", { zoomControl: false, attributionControl: false }).setView([20.59, 78.96], 4);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(map);
}

function locateMe() {
  if (!navigator.geolocation) { $("#locStatus").textContent = "location not supported"; return; }
  $("#locStatus").textContent = "locating...";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      $("#locStatus").textContent = "you are here";
      map.setView([myLoc.lat, myLoc.lng], 15);
      if (meMarker) map.removeLayer(meMarker);
      meMarker = L.circleMarker([myLoc.lat, myLoc.lng], { radius: 8, color: "#22c55e", fillColor: "#22c55e", fillOpacity: 1 }).addTo(map);
      refreshPings();
    },
    () => { $("#locStatus").textContent = "location blocked - allow it to see nearby"; },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function startHomePolling() {
  clearInterval(homeTimer);
  homeTimer = setInterval(refreshPings, 3500);
  clearInterval(myPingTimer);
  myPingTimer = setInterval(refreshMyPing, 4000);
  refreshMyPing();
}

async function refreshPings() {
  if (!token) return;
  const q = myLoc ? `?lat=${myLoc.lat}&lng=${myLoc.lng}&radius=5000` : "";
  let data;
  try { data = await api("/api/pings" + q); } catch { return; }
  latestPings = data.pings;
  renderPingMarkers(data.pings);
  updateNearbyHint(data.pings);
  if ($("#joinSheet").classList.contains("open")) renderPingCards(data.pings, $("#joinList"));
  detectNewPings(data.pings);
  tryShowNextNotif();
}

function updateNearbyHint(pings) {
  const others = pings.filter((p) => !p.isMine);
  const el = $("#nearbyHint");
  if (!myLoc) { el.textContent = "Allow location to see who is around you."; return; }
  if (!others.length) { el.innerHTML = `No one is on a break nearby yet.<br/>Tap <b>take a break</b> to be the first.`; return; }
  el.innerHTML = `${others.length} ${others.length === 1 ? "person is" : "people are"} on a break near you.<br/>Tap <b>join a break</b> to see them.`;
}

function renderPingMarkers(pings) {
  Object.values(pingMarkers).forEach((m) => map.removeLayer(m));
  pingMarkers = {};
  pings.forEach((p) => {
    const av = p.isMine ? (me && me.avatar) : (p.host && p.host.avatar);
    const inner = avatarHtml(av || "🙂", "");
    const html = `<div class="map-pin ${p.isMine ? "mine" : ""}">${inner}</div>`;
    const ic = L.divIcon({ html, className: "", iconSize: [44, 44], iconAnchor: [22, 51], popupAnchor: [0, -48] });
    const m = L.marker([p.lat, p.lng], { icon: ic }).addTo(map);
    m.bindPopup(`${icon(p.type)} ${p.isMine ? "your" : p.host.name + "'s"} ${p.type} break`);
    pingMarkers[p.id] = m;
  });
}

function distTxt(m) {
  if (m == null) return "";
  return m < 1000 ? m + "m away" : (m / 1000).toFixed(1) + "km away";
}
function minsLeft(exp) {
  const s = Math.max(0, Math.round((exp - Date.now()) / 60000));
  return s + " min left";
}

function renderPingCards(pings, el) {
  if (!pings.length) {
    el.innerHTML = `<div class="empty">No one is on a break nearby yet.<br/>Tap "take a break" to be the first.</div>`;
    return;
  }
  el.innerHTML = pings.map((p) => {
    let btn;
    if (p.isMine) btn = `<button class="mini-btn" data-open="${p.id}" data-mine="1">chat</button>`;
    else if (p.myJoinStatus === "accepted") btn = `<button class="mini-btn" data-open="${p.id}">chat</button>`;
    else if (p.myJoinStatus === "pending") btn = `<button class="mini-btn wait" disabled>requested</button>`;
    else btn = `<button class="mini-btn" data-join="${p.id}">join</button>`;
    const who = p.isMine ? `your <span class="name">${p.type}</span> break <span class="badge-mine">live</span>` : `<span class="name">${p.host.name}</span> · ${p.type}`;
    const sub = [distTxt(p.distance), minsLeft(p.expiresAt), p.spot ? "📍 " + p.spot : ""].filter(Boolean).join(" · ");
    return `<div class="ping-card">
      <div class="pic">${icon(p.type)}</div>
      <div class="info"><div class="t1">${who}</div><div class="t2">${sub}</div></div>
      ${btn}
    </div>`;
  }).join("");
}

// join a break sheet
$("#navJoin").addEventListener("click", () => {
  $("#joinSheet").classList.add("open");
  renderPingCards(latestPings, $("#joinList"));
});
$("#closeJoin").addEventListener("click", () => $("#joinSheet").classList.remove("open"));

$("#joinList").addEventListener("click", async (e) => {
  const joinId = e.target.dataset.join;
  const openId = e.target.dataset.open;
  if (joinId) {
    const p = latestPings.find((x) => x.id === joinId);
    $("#joinSheet").classList.remove("open");
    if (p) queueNotif({ kind: "hang", ping: p });
  }
  if (openId) { $("#joinSheet").classList.remove("open"); openDetail(openId, e.target.dataset.mine === "1"); }
});

// ---------- live notifications: nearby break, or someone wants to join yours ----------
let seenPingIds = new Set();
let baselineSet = false;
let seenJoinIds = new Set();
let joinBaselineSet = false;
let notifQueue = [];
let notifShowing = false;
let currentNotif = null;

function anotherSheetOpen() {
  return ["createSheet", "joinSheet", "detailSheet"].some((id) => $("#" + id).classList.contains("open"));
}

function detectNewPings(pings) {
  if (!baselineSet) {
    pings.forEach((p) => seenPingIds.add(p.id));
    baselineSet = true;
    return;
  }
  pings.forEach((p) => {
    if (seenPingIds.has(p.id)) return;
    seenPingIds.add(p.id);
    if (!p.isMine && !p.myJoinStatus) queueNotif({ kind: "hang", ping: p });
  });
}

function queueNotif(item) {
  notifQueue.push(item);
  tryShowNextNotif();
}

function tryShowNextNotif() {
  if (notifShowing || !notifQueue.length || anotherSheetOpen()) return;
  notifShowing = true;
  currentNotif = notifQueue.shift();
  renderNotif(currentNotif);
  $("#notifSheet").classList.add("open");
}

function closeNotif() {
  $("#notifSheet").classList.remove("open");
  notifShowing = false;
  currentNotif = null;
  setTimeout(tryShowNextNotif, 280);
}

function renderNotif(item) {
  if (item.kind === "hang") {
    const p = item.ping;
    $("#notifAvatar").innerHTML = avatarHtml((p.host && p.host.avatar) || "🙂", "");
    $("#notifName").textContent = (p.host && p.host.name) || "Someone";
    $("#notifSuffix").textContent = "is nearby";
    $("#notifImgWrap").innerHTML = typeIconHtml(p.type, "hero-img", 84);
    $("#notifTagline").textContent = `down for ${TYPE_LABEL[p.type] || "a break"}?`;
    const bits = [distTxt(p.distance), p.spot ? "📍 " + p.spot : "", minsLeft(p.expiresAt)].filter(Boolean).join(" · ");
    $("#notifMeta").textContent = bits || "nearby · now";
    $("#notifPrimary").textContent = "Join the hang";
    $("#notifCounterWrap").style.display = "block";
    const others = Object.keys(TYPE_LABEL).filter((t) => t !== p.type).slice(0, 3);
    $("#notifCounters").innerHTML = others.map((t) => `<button class="chip" data-counter="${t}">${typeIconHtml(t, "chip-ico", 16)}${t}</button>`).join("");
    $("#notifSkip").textContent = "Not right now";
  } else {
    const { join: j, ping: p } = item;
    $("#notifAvatar").innerHTML = avatarHtml((j.user && j.user.avatar) || "🙂", "");
    $("#notifName").textContent = (j.user && j.user.name) || "Someone";
    $("#notifSuffix").textContent = "wants to join";
    $("#notifImgWrap").innerHTML = typeIconHtml(p.type, "hero-img", 84);
    $("#notifTagline").textContent = `join your ${TYPE_LABEL[p.type] || "break"}?`;
    $("#notifMeta").textContent = p.spot ? "📍 " + p.spot : "";
    $("#notifPrimary").textContent = "Accept";
    $("#notifCounterWrap").style.display = "none";
    $("#notifSkip").textContent = "Not now";
  }
}

$("#notifPrimary").addEventListener("click", async () => {
  if (!currentNotif) return;
  try {
    if (currentNotif.kind === "hang") await api(`/api/pings/${currentNotif.ping.id}/join`, "POST");
    else await api(`/api/joins/${currentNotif.join.id}/accept`, "POST");
  } catch (err) { alert(err.error || "action failed"); }
  closeNotif();
  refreshPings();
  refreshMyPing();
});

$("#notifCounters").addEventListener("click", async (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || !myLoc || !currentNotif || currentNotif.kind !== "hang") return;
  try { await api("/api/pings", "POST", { type: chip.dataset.counter, duration: 15, spot: "near you", lat: myLoc.lat, lng: myLoc.lng }); } catch {}
  closeNotif();
  refreshPings();
});

$("#notifSkip").addEventListener("click", () => closeNotif());

// ---------- MY PING (host: join requests) ----------
async function refreshMyPing() {
  if (!token) return;
  try {
    const { ping } = await api("/api/my-ping");
    if (openPingId && openPingIsMine && ping && ping.id === openPingId) renderJoinReqs(ping.joins);
    if (ping) {
      const pending = ping.joins.filter((j) => j.status === "pending");
      if (!joinBaselineSet) {
        pending.forEach((j) => seenJoinIds.add(j.id));
        joinBaselineSet = true;
      } else {
        pending.forEach((j) => {
          if (seenJoinIds.has(j.id)) return;
          seenJoinIds.add(j.id);
          queueNotif({ kind: "request", join: j, ping });
        });
      }
    }
  } catch {}
}

// ---------- CREATE BREAK ----------
let selType = "chai", selDur = 20;
$("#navBreak").addEventListener("click", () => {
  if (!myLoc) { alert("We need your location first. Allow location access."); locateMe(); return; }
  $("#createSheet").classList.add("open");
});

// home button: close any open sheet, back to map
$("#navHome").addEventListener("click", () => {
  ["createSheet", "joinSheet", "detailSheet", "notifSheet"].forEach((id) => $("#" + id).classList.remove("open"));
  notifShowing = false; currentNotif = null;
  openPingId = null; clearInterval(chatTimer);
  tryShowNextNotif();
});

// full page map toggle
$("#mapFull").addEventListener("click", () => {
  const w = document.querySelector(".map-wrap");
  const open = w.classList.toggle("map-open");
  $("#mapFull").textContent = open ? "✕" : "⤢";
  setTimeout(() => { if (map) map.invalidateSize(); }, 60);
});

// logout: tap your name/avatar top-right
$("#meChip").addEventListener("click", () => {
  if (!confirm("Log out of Break Buddy?")) return;
  localStorage.removeItem("bb_token"); token = null; me = null;
  clearInterval(homeTimer); clearInterval(myPingTimer); clearInterval(chatTimer);
  seenPingIds = new Set(); baselineSet = false;
  seenJoinIds = new Set(); joinBaselineSet = false;
  notifQueue = []; notifShowing = false; currentNotif = null;
  ["createSheet", "joinSheet", "detailSheet", "notifSheet"].forEach((id) => $("#" + id).classList.remove("open"));
  show("login"); startHeroCarousel();
});
$("#cancelCreate").addEventListener("click", () => $("#createSheet").classList.remove("open"));

$("#typeChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $$("#typeChips .chip").forEach((c) => c.classList.remove("selected"));
  chip.classList.add("selected"); selType = chip.dataset.t;
});
$("#durChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $$("#durChips .chip").forEach((c) => c.classList.remove("selected"));
  chip.classList.add("selected"); selDur = parseInt(chip.dataset.d, 10);
});

$("#spotInput").addEventListener("input", () => {
  $("#spotInput").classList.remove("field-invalid");
  $("#spotErr").textContent = "";
});

$("#goLive").addEventListener("click", async () => {
  const spot = $("#spotInput").value.trim();
  if (!spot) {
    $("#spotInput").classList.add("field-invalid");
    $("#spotErr").textContent = "enter a meeting spot so people know where to go";
    $("#spotInput").focus();
    return;
  }
  try {
    await api("/api/pings", "POST", { type: selType, duration: selDur, spot, lat: myLoc.lat, lng: myLoc.lng });
    $("#createSheet").classList.remove("open");
    $("#spotInput").value = "";
    $("#spotErr").textContent = "";
    $("#spotInput").classList.remove("field-invalid");
    refreshPings();
  } catch (e) { alert(e.error || "could not create"); }
});

// ---------- DETAIL / CHAT ----------
async function openDetail(pingId, isMine) {
  openPingId = pingId; openPingIsMine = isMine;
  $("#detailSheet").classList.add("open");
  $("#joinReqs").innerHTML = "";
  $("#chatBox").innerHTML = "";
  if (isMine) {
    const { ping } = await api("/api/my-ping");
    if (ping) { setDetailHeader(`your ${ping.type} break`, ping.spot); renderJoinReqs(ping.joins); }
  }
  loadChat();
  clearInterval(chatTimer);
  chatTimer = setInterval(loadChat, 3000);
}

function setDetailHeader(title, spot) {
  $("#detailTitle").textContent = title;
  $("#detailSpot").innerHTML = spot ? `📍 meet at <b>${spot}</b>` : `📍 no spot set`;
}

function renderJoinReqs(joins) {
  const pending = joins.filter((j) => j.status === "pending");
  const accepted = joins.filter((j) => j.status === "accepted");
  $("#joinReqs").innerHTML =
    pending.map((j) => `<div class="jr"><div class="pic">${avatarHtml(j.user.avatar, "av-img")}</div><div class="nm">${j.user.name} wants to join</div><button class="mini-btn" data-accept="${j.id}">accept</button></div>`).join("") +
    accepted.map((j) => `<div class="jr"><div class="pic">${avatarHtml(j.user.avatar, "av-img")}</div><div class="nm">${j.user.name}</div><span class="accepted">joined</span></div>`).join("");
}

$("#joinReqs").addEventListener("click", async (e) => {
  const acc = e.target.dataset.accept;
  if (!acc) return;
  try { await api(`/api/joins/${acc}/accept`, "POST"); refreshMyPing(); } catch (err) { alert(err.error); }
});

async function loadChat() {
  if (!openPingId) return;
  let data;
  try { data = await api(`/api/pings/${openPingId}/messages`); }
  catch { $("#chatBox").innerHTML = `<div class="chat-note">Chat opens once your join is accepted.</div>`; $("#chatInputWrap").style.display = "none"; return; }
  $("#chatInputWrap").style.display = "flex";
  if (!openPingIsMine) setDetailHeader("break chat", data.spot);
  const box = $("#chatBox");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = data.messages.map((m) =>
    `<div class="bubble ${m.mine ? "mine" : "them"}">${m.mine ? "" : `<div class="who">${m.user.avatar} ${m.user.name}</div>`}${escapeHtml(m.text)}</div>`
  ).join("") || `<div class="chat-note">Say hi and pick where to meet.</div>`;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try { await api(`/api/pings/${openPingId}/messages`, "POST", { text }); loadChat(); } catch (e) { alert(e.error); }
}
$("#sendMsg").addEventListener("click", sendMessage);
$("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });

$("#closeDetail").addEventListener("click", () => {
  $("#detailSheet").classList.remove("open");
  openPingId = null; clearInterval(chatTimer);
});

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------- hero carousel (login) ----------
const FLU = "https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/";
const HERO = [
  { img: ICON_DIR + "chai-icons.webp", name: "Diya", act: "chai time", spot: "chai tapri" },
  { img: ICON_DIR + "coffe-icon.webp", name: "Aman", act: "coffee run", spot: "cafe near gate" },
  { img: ICON_DIR + "cigrate-icons.webp", name: "Rohit", act: "sutta break", spot: "back gate" },
  { img: ICON_DIR + "pizza-icons.webp", name: "Pro Gamers", act: "pizza time", spot: "food court" },
  { img: ICON_DIR + "beermug.webp", name: "Weekend Crew", act: "drinks time", spot: "the usual" },
];

// avatar emoji -> 3D image (local icons where available, Fluent CDN otherwise)
const AV3D = {
  "🙂": FLU + "Slightly%20smiling%20face/3D/slightly_smiling_face_3d.png",
  "🔥": FLU + "Fire/3D/fire_3d.png",
  "☕": ICON_DIR + "coffe-icon.webp",
  "🎧": FLU + "Headphone/3D/headphone_3d.png",
  "🥳": FLU + "Partying%20face/3D/partying_face_3d.png",
  "⚡": FLU + "High%20voltage/3D/high_voltage_3d.png",
};
function av3d(e) { return AV3D[e] || null; }
function avatarHtml(emoji, cls) {
  const url = av3d(emoji);
  return url ? `<img class="${cls}" src="${url}" alt="">` : `<span class="${cls}">${emoji}</span>`;
}
let heroIdx = 0, heroTimer;
function setHero(i) {
  const h = HERO[i];
  $("#heroImg").src = h.img;
  $("#heroName").textContent = h.name;
  $("#heroAct").textContent = h.act;
  $("#heroSpot").textContent = h.spot;
  const card = $("#heroCard");
  card.classList.remove("swap"); void card.offsetWidth; card.classList.add("swap");
}
function startHeroCarousel() {
  HERO.forEach((h) => { const im = new Image(); im.src = h.img; });
  heroIdx = 0; setHero(0);
  clearInterval(heroTimer);
  heroTimer = setInterval(() => { heroIdx = (heroIdx + 1) % HERO.length; setHero(heroIdx); }, 2800);
}
$("#heroJoin")?.addEventListener("click", () => {
  $("#nameInput").focus();
  $("#nameInput").scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------- add to home screen ----------
let deferredInstallPrompt = null;
const isStandaloneApp = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

if (!isStandaloneApp && !localStorage.getItem("bb_install_dismissed")) {
  if (isIOS) {
    $("#installText").textContent = 'Add Break Buddy to your Home Screen: tap Share, then "Add to Home Screen"';
    $("#installBtn").style.display = "none";
    $("#installBanner").classList.add("show");
  } else {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      $("#installBanner").classList.add("show");
    });
  }
}

$("#installBtn").addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("#installBanner").classList.remove("show");
});

$("#installDismiss").addEventListener("click", () => {
  $("#installBanner").classList.remove("show");
  localStorage.setItem("bb_install_dismissed", "1");
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// ---------- push notifications ----------
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function subscribeToPush() {
  const reg = await navigator.serviceWorker.ready;
  const { key, enabled } = await api("/api/push/key");
  if (!enabled) return false;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  }
  await api("/api/push/subscribe", "POST", { subscription: sub.toJSON() });
  return true;
}

async function initPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !token) return;
  if (Notification.permission === "granted") {
    subscribeToPush().catch(() => {});
    return;
  }
  if (Notification.permission === "denied") return;
  if (localStorage.getItem("bb_notify_dismissed")) return;
  $("#notifyBanner").classList.add("show");
}

$("#notifyBtn").addEventListener("click", async () => {
  const perm = await Notification.requestPermission();
  $("#notifyBanner").classList.remove("show");
  if (perm === "granted") subscribeToPush().catch(() => {});
});

$("#notifyDismiss").addEventListener("click", () => {
  $("#notifyBanner").classList.remove("show");
  localStorage.setItem("bb_notify_dismissed", "1");
});

// ---------- boot ----------
(async function boot() {
  if (token) {
    try { const r = await api("/api/me"); me = r.user; enterHome(); return; }
    catch { localStorage.removeItem("bb_token"); token = null; }
  }
  show("login");
  startHeroCarousel();
})();
