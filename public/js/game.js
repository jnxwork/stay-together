// ============================================================
// Beside - Multiplayer co-studying space
// Two rooms: Focus Zone (quiet) & Lounge (chat + music)
// ============================================================

// --- React UI Bridge ---
// React now manages all DOM UI. This shim prevents crashes when
// game.js references old DOM elements that no longer exist.
// Returns a Proxy-based "null element" that silently absorbs any
// property access, method call, or DOM manipulation.
(function() {
  const _origById = document.getElementById.bind(document);
  const _origQS  = document.querySelector.bind(document);
  const REAL_IDS = new Set([
    "game", "game-container", "joystick-zone", "joystick-canvas", "ui-root",
    // Welcome customizer — React provides these; return null when unmounted
    "welcome-preview-canvas", "welcome-tabs", "welcome-presets",
    "welcome-options", "welcome-variants", "welcome-dice",
    "welcome-mode-preset", "welcome-mode-custom",
    // React profile icon — return null when unmounted to avoid proxy canvas
    "profile-icon-react",
    // Settings panel — React manages these; return null so game.js skips old DOM listeners
    "settings-panel", "settings-icon", "settings-detail", "profile-trigger",
  ]);

  // A "null canvas context" that absorbs all 2d drawing calls
  function makeNullCtx() {
    return new Proxy({}, {
      get(t, p) {
        if (p === "canvas") return makeNullEl();
        if (typeof p === "symbol") return undefined;
        return function() { return makeNullCtx(); };
      },
      set() { return true; }
    });
  }

  // A "null element" that absorbs any DOM operation
  function makeNullEl() {
    const div = document.createElement("div");
    return new Proxy(div, {
      get(target, prop) {
        if (prop === "getContext") return () => makeNullCtx();
        if (prop === "querySelectorAll") return () => [];
        if (prop === "querySelector") return () => makeNullEl();
        if (prop === "children") return [];
        if (prop === "childNodes") return [];
        if (prop === "parentElement" || prop === "parentNode") return null;
        if (prop === "offsetWidth" || prop === "offsetHeight") return 0;
        if (prop === "getBoundingClientRect") return () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
        // Form element defaults
        if (prop === "value" || prop === "placeholder" || prop === "textContent" || prop === "innerHTML" || prop === "innerText") return target[prop] || "";
        if (prop === "selectedIndex") return -1;
        if (prop === "options") return [];
        if (prop === "checked") return false;
        if (prop === "files") return [];
        // Delegate to the real div for common props (style, classList, dataset, etc.)
        const val = target[prop];
        if (typeof val === "function") return val.bind(target);
        return val;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      }
    });
  }

  document.getElementById = function(id) {
    const el = _origById(id);
    if (el) return el;
    if (REAL_IDS.has(id)) return null;
    return makeNullEl();
  };
  document.querySelector = function(sel) {
    return _origQS(sel) || makeNullEl();
  };
})();

// --- React store bridge helper ---
function storeSet(name, action, ...args) {
  if (window.__stores?.[name]) window.__stores[name].getState()[action](...args);
}

const canvas = document.getElementById("game");
let ctx = canvas.getContext("2d");
const mainCtx = ctx;
// Session persistence: survive tab sleep / reconnect
function getSessionToken() {
  let token = localStorage.getItem("sessionToken");
  if (!token) { token = crypto.randomUUID(); localStorage.setItem("sessionToken", token); }
  return token;
}

// Auth state
let authToken = localStorage.getItem("authToken") || null;
let authEmail = localStorage.getItem("authEmail") || null;
let isRegistered = false;
let myUserId = null;

// Follow/favorite state
let followedUsersArr = JSON.parse(localStorage.getItem("followedUsers") || "[]");
let followedUsersSet = new Set(followedUsersArr);
function isFollowed(userId) { return followedUsersSet.has(userId); }
function toggleFollow(followKey) {
  if (followedUsersSet.has(followKey)) followedUsersSet.delete(followKey);
  else followedUsersSet.add(followKey);
  localStorage.setItem("followedUsers", JSON.stringify([...followedUsersSet]));
  // Sync _followed flag to React store
  const followed = isFollowed(followKey);
  for (const id in otherPlayers) {
    const p = otherPlayers[id];
    if ((p._userId && p._userId === followKey) || id === followKey) {
      storeSet("game", "updatePlayer", id, { _followed: followed });
      break;
    }
  }
}

// Show names filter
let showNamesFilter = (() => {
  try {
    const v = JSON.parse(localStorage.getItem("showNames"));
    if (v && typeof v === "object") return { self: !!v.self, followed: !!v.followed, others: !!v.others };
  } catch {}
  return { self: true, followed: true, others: true };
})();

function buildSocketAuth() {
  const auth = { sessionToken: getSessionToken() };
  if (authToken) auth.authToken = authToken;
  return auth;
}

let socket = io({ auth: buildSocketAuth() });

// Auth API helpers
async function apiRegister(email, password, profileData) {
  const body = { email, password, ...profileData };
  // Include current authToken so server can upgrade guest → registered
  if (authToken) body.authToken = authToken;
  const res = await fetch("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().then(data => ({ ok: res.ok, status: res.status, ...data }));
}

async function apiLogin(email, password) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return res.json().then(data => ({ ok: res.ok, status: res.status, ...data }));
}

async function apiLogout() {
  if (!authToken) return;
  fetch("/api/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: authToken }),
  }).catch(() => {});
}

function handleAuthSuccess(token, email, profile, focusRecords) {
  authToken = token;
  authEmail = email;
  isRegistered = true;
  localStorage.setItem("authToken", token);
  localStorage.setItem("authEmail", email);
  storeSet("auth", "login", token, email);
  // Apply profile from server if provided
  if (profile) {
    if (profile.name) {
      if (localPlayer) localPlayer.name = profile.name;
      localStorage.setItem("playerName", profile.name);
    }
    if (profile.character) {
      if (localPlayer) localPlayer.character = profile.character;
      selectedCharConfig = profile.character;
      localStorage.setItem("selectedCharacter", JSON.stringify(profile.character));
    }
    if (profile.tagline !== undefined) {
      if (localPlayer) localPlayer.tagline = profile.tagline;
      localStorage.setItem("playerTagline", profile.tagline);
    }
    if (profile.languages) {
      if (localPlayer) localPlayer.languages = profile.languages;
      localStorage.setItem("playerLanguages", JSON.stringify(profile.languages));
    }
    if (profile.createdAt) {
      localStorage.setItem("accountCreatedAt", String(profile.createdAt));
    }
  }
  // Merge focus records from server
  if (focusRecords && focusRecords.length > 0) {
    mergeFocusRecords(focusRecords);
  }
  // Reconnect socket with authToken
  socket.auth = buildSocketAuth();
  socket.disconnect().connect();
}

function mergeFocusRecords(serverRecords) {
  const local = JSON.parse(localStorage.getItem("focusHistory") || "[]");
  const existing = new Set(local.map(r => `${r.startTime}_${r.duration}`));
  let merged = [...local];
  for (const r of serverRecords) {
    if (!existing.has(`${r.startTime}_${r.duration}`)) {
      merged.push(r);
    }
  }
  merged.sort((a, b) => a.endTime - b.endTime);
  if (merged.length > 100) merged = merged.slice(-100);
  localStorage.setItem("focusHistory", JSON.stringify(merged));
}

function handleLogout() {
  apiLogout();
  authToken = null;
  authEmail = null;
  isRegistered = false;
  localStorage.removeItem("authToken");
  localStorage.removeItem("authEmail");
  storeSet("auth", "logout");
}

// --- Loading state ---
let gameReady = false;
const _loadingOverlay = document.getElementById("loading-overlay");
const _loadingRetryBtn = document.getElementById("loading-retry");
const _loadingTimeout = setTimeout(() => {
  if (!gameReady && _loadingRetryBtn) _loadingRetryBtn.style.display = "block";
}, 5000);
if (_loadingRetryBtn) _loadingRetryBtn.addEventListener("click", () => location.reload());

function dismissLoadingOverlay() {
  clearTimeout(_loadingTimeout);
  // React UI bridge: dismiss React loading overlay
  // Use retry in case module scripts haven't executed yet
  function tryDismissReact() {
    if (window.__stores?.ui) {
      window.__stores.ui.getState().setLoading(false);
    } else {
      setTimeout(tryDismissReact, 50);
    }
  }
  tryDismissReact();
  if (!_loadingOverlay) return;
  _loadingOverlay.classList.add("fade-out");
  setTimeout(() => _loadingOverlay.classList.add("hidden"), 500);
}

// ============================================================
// TOUCH / RESPONSIVE + CAMERA
// ============================================================
const isTouchDevice = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
// Lock to landscape on mobile if supported
if (isTouchDevice && screen.orientation && screen.orientation.lock) {
  screen.orientation.lock("landscape").catch(() => {});
}
const TILE = 32;

// Per-room dimensions (defaults, overwritten by server/Tiled data)
const ROOM_DIMS = {
  focus: { cols: 32, rows: 18 },
  rest:  { cols: 32, rows: 18 },
};
function _roomDims() { try { return ROOM_DIMS[currentRoom] || ROOM_DIMS.focus; } catch(e) { return ROOM_DIMS.focus; } }
function getCols() { return _roomDims().cols; }
function getRows() { return _roomDims().rows; }
function getGameW() { return _roomDims().cols * TILE; }
function getGameH() { return _roomDims().rows * TILE; }

// Camera state
let gameScale = 1;
let dpr = window.devicePixelRatio || 1;
let cameraX = 0;
let cameraY = 0;

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const nw = w * dpr;
  const nh = h * dpr;
  // Only resize if dimensions actually changed (setting canvas.width clears content → flicker)
  if (canvas.width !== nw || canvas.height !== nh) {
    canvas.width = nw;
    canvas.height = nh;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }
  gameScale = Math.max(w / getGameW(), h / getGameH());
  if (isTouchDevice) gameScale = Math.max(gameScale, MIN_SCALE_MOBILE);
}

// Mobile: minimum zoom so characters/tiles are clearly visible
const MIN_SCALE_MOBILE = 1.2;

function updateCamera() {
  if (!localPlayer) return;
  const gw = getGameW();
  const gh = getGameH();
  // Recalculate scale for current room dimensions
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  gameScale = Math.max(w / gw, h / gh);
  if (isTouchDevice) gameScale = Math.max(gameScale, MIN_SCALE_MOBILE);
  const viewW = w / gameScale;
  const viewH = h / gameScale;
  if (viewW >= gw) {
    cameraX = (gw - viewW) / 2; // center
  } else {
    const tx = localPlayer.x - viewW / 2;
    cameraX = Math.max(0, Math.min(gw - viewW, tx));
  }
  if (viewH >= gh) {
    cameraY = (gh - viewH) / 2; // center
  } else {
    const ty = localPlayer.y - viewH / 2;
    cameraY = Math.max(0, Math.min(gh - viewH, ty));
  }
}

window.addEventListener("resize", resizeCanvas);
window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 100));
resizeCanvas();

// Convert screen coords to game coords (accounts for camera + scale)
function screenToGame(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const sx = (clientX - rect.left) * (canvas.width / rect.width);
  const sy = (clientY - rect.top) * (canvas.height / rect.height);
  return {
    x: sx / (gameScale * dpr) + cameraX,
    y: sy / (gameScale * dpr) + cameraY,
  };
}

// Convert game coords to CSS viewport coords (inverse of screenToGame)
function gameToScreen(gameX, gameY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (gameX - cameraX) * gameScale + rect.left,
    y: (gameY - cameraY) * gameScale + rect.top,
  };
}

// ============================================================
// I18N
// ============================================================
const TRANSLATIONS = {
  en: {
    focusZone: "Focus Zone",
    lounge: "Lounge",
    portalToLounge: "\u2B07 Lounge",
    portalToFocus: "\u2B06 Focus Zone",
    startFocus: "Start Focus",
    endFocus: "End Focus",
    focusPopupTitle: "What are you focusing on?",
    catWorking: "\u{1F4BC} Work",
    catStudying: "\u{1F4D6} Study",
    catReading: "\u{1F4DA} Read",
    catWriting: "\u{270F}\u{FE0F} Write",
    catCreating: "\u{1F3A8} Create",
    catExercising: "\u{1F3CB}\u{FE0F} Exercise",
    taskPlaceholder: "Task name (optional)...",
    start: "Start",
    cancel: "Cancel",
    portalConfirmTitle: "End focus and go to Lounge?",
    portalConfirmYes: "Yes, take a break",
    portalConfirmNo: "Keep focusing",
    goingToRest: "Going to rest...",
    namePlaceholder: "Your name...",
    chatAll: "All",
    chatRoom: "Room",
    chatNearby: "Nearby",
    system: "System",
    nearbyHint: "Messages sent in [Nearby] can only be seen by players within 4 tiles of you, including your own. Others won't see anything. Vice versa.",
    chatPlaceholder: "Say something...",
    send: "Send",
    hide: "Hide",
    chat: "Chat",
    soundOff: "Sound: OFF",
    soundOn: "Sound: ON",
    hint: "WASD to move | E to interact | Walk to the stairs to switch rooms",
    hintMobile: "Use joystick to move | Walk to the stairs to switch rooms",
    welcomeControls: "Your info above is visible to others.\nYou can change it anytime in \u2699\uFE0F",
    welcomeControlsMobile: "Your info above is visible to others.\nYou can change it anytime in \u2699\uFE0F",
    presetTab: "Presets",
    customTab: "Custom",
    online: "Online",
    total: "Total",
    // Status labels
    studying: "Studying",
    working: "Working",
    reading: "Reading",
    coding: "Coding",
    resting: "Resting",
    chatting: "Chatting",
    listening: "Listening",
    watching: "Watching",
    napping: "Napping",
    snacking: "Snacking",
    browsing: "Browsing",
    wandering: "Wandering",
    daydreaming: "Daydreaming",
    grabCoffee: "Going to grab some coffee...",
    joinedLounge: "joined the Lounge",
    leftLounge: "left",
    welcomeTitle: "What would you like to be called?",
    welcomeHint: "You can change it anytime in \u2699\uFE0F",
    welcomeEnter: "OK",
    lang: "🌐 EN",
    historyTitle: "Focus History",
    historyToday: "Today",
    historySessions: "sessions",
    historyRecentSessions: "Recent Sessions",
    historyNoData: "No focus sessions yet",
    historyClose: "Close",
    historyMin: "min",
    historyH: "h",
    historyWeekdays: "M|T|W|T|F|S|S",
    historyCategories: "Categories",
    historyMonthSummary: "Focused {0} days, total {1}",
    reacted: "sent you",
    reactedTo: "You sent",
    reactedToSuffix: "",
    notOnline: "Not online",
    agoJustNow: "Online just now",
    agoMin: "Online {n}min ago",
    agoHr: "Online {n}hr ago",
    agoDay: "Online {n}d ago",
    chooseCharacter: "Choose your look",
    sit: "Sit",
    stand: "Stand",
    taglinePlaceholder: "A short bio...",
    displayedNameLabel: "Displayed Name",
    taglineLabel: "Bio (optional)",
    profileTab: "Profile",
    systemTab: "Settings",
    profileEntry: "Edit Profile",
    langLabel: "Language",
    iSpeakLabel: "I speak",
    profileLangLabel: "Language",
    uiLangLabel: "Interface Language",
    timezoneLabel: "Timezone",
    timeLateNight: "Late Night (0:00-5:00)",
    timeMorning: "Morning (5:00-8:00)",
    timeForenoon: "Forenoon (8:00-11:00)",
    timeNoon: "Noon (11:00-13:00)",
    timeAfternoon: "Afternoon (13:00-17:00)",
    timeDusk: "Dusk (17:00-19:00)",
    timeNight: "Night (19:00-24:00)",
    miniOpen: "Mini Window",
    miniClose: "Close Mini",
    miniUnsupported: "Mini not supported",
    miniTitle: "Live Status",
    miniOnlineTotal: "Online",
    miniOnlineFocus: "Focus",
    miniOnlineLounge: "Lounge",
    miniYou: "You",
    miniRoom: "Room",
    miniFocusState: "Focus",
    miniFocusing: "Focusing",
    miniNotFocusing: "Not focusing",
    miniTimer: "Timer",
    miniTask: "Task",
    miniCat: "Cat",
    miniDisconnected: "Disconnected",
    miniCatUnknown: "Unknown",
    miniShowLabel: "Show",
    miniShowState: "State",
    miniShowTimer: "Timer",
    miniShowMap: "Map",
    selectPlayer: "Who do you want to interact with?",
    clickToInteract: "Click to interact",
    screenshot: "Screenshot",
    recStart: "Record timelapse",
    recStop: "Stop recording",
    recEncoding: "Encoding {0}%...",
    recUnsupported: "Your browser doesn't support video recording.\nPlease try Chrome, Edge, or Firefox.",
    authLogin: "Login",
    authRegister: "Register",
    authLogout: "Logout",
    authEmail: "Email",
    authPassword: "Password",
    authSubmit: "Submit",
    authBack: "Back",
    authOr: "or",
    authGuest: "Enter as Guest",
    authLoggedInAs: "Logged in as",
    authErrRequired: "Email and password required.",
    authErrInvalidEmail: "Please enter a valid email address.",
    authErrShortPass: "Password must be at least 6 characters.",
    authErrNetwork: "Network error. Please try again.",
    chatRateLimit: "Just a moment",
    reactionRateLimit: "Your wave was sent!",
    recapTitle: "Last Week",
    recapOnline: "Time Online",
    recapReactions: "Waves Received",
    recapCatGifts: "Gifts from Cat",
    recapTopPartner: "Hung Out Most With",
    recapHours: "h",
    recapNoData: "No data yet this week",
    recapClose: "Close",
    recapSharedHours: "shared",
    shareCard: "Share Card",
    focusRecap: "FOCUS RECAP",
    shareCardNoData: "No focus data this week",
    bulletinTitle: "Bulletin Board",
    bulletinAnnouncements: "Announcements",
    bulletinNotes: "Notes",
    bulletinPlaceholder: "Leave a note...",
    bulletinPost: "Post",
    bulletinLoginRequired: "Login to post",
    bulletinLoginToPost: "Login to Post",
    bulletinCooldown: "Wait a moment",
    bulletinEmpty: "No notes yet",
    bulletinNoAnn: "No announcements",
    bulletinClose: "Close",
    follow: "Follow",
    unfollow: "Unfollow",
    followRequiresRegistration: "Only registered users can be followed",
  },
  zh: {
    focusZone: "\u4E13\u6CE8\u533A",
    lounge: "\u4F11\u95F2\u533A",
    portalToLounge: "\u2B07 \u4F11\u95F2\u533A",
    portalToFocus: "\u2B06 \u4E13\u6CE8\u533A",
    startFocus: "\u5F00\u59CB\u4E13\u6CE8",
    endFocus: "\u7ED3\u675F\u4E13\u6CE8",
    focusPopupTitle: "\u4F60\u8981\u4E13\u6CE8\u505A\u4EC0\u4E48\uFF1F",
    catWorking: "\u{1F4BC} \u5DE5\u4F5C",
    catStudying: "\u{1F4D6} \u5B66\u4E60",
    catReading: "\u{1F4DA} \u9605\u8BFB",
    catWriting: "\u{270F}\u{FE0F} \u5199\u4F5C",
    catCreating: "\u{1F3A8} \u521B\u4F5C",
    catExercising: "\u{1F3CB}\u{FE0F} \u953B\u70BC",
    taskPlaceholder: "\u4EFB\u52A1\u540D\u79F0\uFF08\u53EF\u9009\uFF09...",
    start: "\u5F00\u59CB",
    cancel: "\u53D6\u6D88",
    portalConfirmTitle: "\u7ED3\u675F\u4E13\u6CE8\u5E76\u53BB\u4F11\u95F2\u533A\uFF1F",
    portalConfirmYes: "\u53BB\u4F11\u606F\u4E00\u4E0B",
    portalConfirmNo: "\u7EE7\u7EED\u4E13\u6CE8",
    goingToRest: "\u53BB\u4F11\u606F\u4E00\u4E0B...",
    namePlaceholder: "\u4F60\u7684\u540D\u5B57...",
    chatAll: "\u5168\u90E8",
    chatRoom: "\u623F\u95F4",
    chatNearby: "\u9644\u8FD1",
    system: "\u7CFB\u7EDF",
    nearbyHint: "\u5728[\u9644\u8FD1]\u9891\u9053\u53D1\u8A00\u65F6\uFF0C\u53EA\u6709\u4F60\u5468\u56F4 4 \u683C\u5185\u7684\u73A9\u5BB6\uFF08\u542B\u81EA\u8EAB\u6240\u5728\u683C\uFF09\u80FD\u770B\u5230\u6D88\u606F\u5185\u5BB9\uFF0C\u5176\u4ED6\u4EBA\u4E0D\u4F1A\u770B\u5230\u4EFB\u4F55\u63D0\u793A\u3002\u53CD\u4E4B\u4EA6\u7136\u3002",
    chatPlaceholder: "\u8BF4\u70B9\u4EC0\u4E48...",
    send: "\u53D1\u9001",
    hide: "\u6536\u8D77",
    chat: "\u804A\u5929",
    soundOff: "\u58F0\u97F3: \u5173",
    soundOn: "\u58F0\u97F3: \u5F00",
    hint: "WASD \u79FB\u52A8 | E \u4EA4\u4E92 | \u8D70\u5230\u697C\u68AF\u5207\u6362\u623F\u95F4",
    hintMobile: "\u6447\u6746\u79FB\u52A8 | \u8D70\u5230\u697C\u68AF\u5207\u6362\u623F\u95F4",
    welcomeControls: "\u4EE5\u4E0A\u4FE1\u606F\u5BF9\u5176\u4ED6\u4EBA\u53EF\u89C1\u3002\n\u53EF\u4EE5\u968F\u65F6\u5728 \u2699\uFE0F \u4E2D\u4FEE\u6539",
    welcomeControlsMobile: "\u4EE5\u4E0A\u4FE1\u606F\u5BF9\u5176\u4ED6\u4EBA\u53EF\u89C1\u3002\n\u53EF\u4EE5\u968F\u65F6\u5728 \u2699\uFE0F \u4E2D\u4FEE\u6539",
    presetTab: "\u9884\u8BBE",
    customTab: "\u81EA\u5B9A\u4E49",
    online: "\u5728\u7EBF",
    total: "\u603B\u8BA1",
    studying: "\u5B66\u4E60\u4E2D",
    working: "\u5DE5\u4F5C\u4E2D",
    reading: "\u9605\u8BFB\u4E2D",
    coding: "\u7F16\u7A0B\u4E2D",
    resting: "\u4F11\u606F\u4E2D",
    chatting: "\u804A\u5929\u4E2D",
    listening: "\u542C\u6B4C\u4E2D",
    watching: "\u8FFD\u5267\u4E2D",
    napping: "\u5C0F\u61A9\u4E2D",
    snacking: "\u5403\u4E1C\u897F",
    browsing: "\u5237\u624B\u673A",
    wandering: "\u95F2\u901B\u4E2D",
    daydreaming: "\u53D1\u5446\u4E2D",
    grabCoffee: "\u53BB\u559D\u676F\u5496\u5561...",
    joinedLounge: "\u52A0\u5165\u4E86\u4F11\u95F2\u533A",
    leftLounge: "\u79BB\u5F00\u4E86",
    welcomeTitle: "\u4F60\u60F3\u88AB\u600E\u4E48\u79F0\u547C\uFF1F",
    welcomeHint: "\u53EF\u4EE5\u968F\u65F6\u5728\u53F3\u4E0A\u89D2 \u2699\uFE0F \u4E2D\u4FEE\u6539",
    welcomeEnter: "\u786E\u8BA4",
    lang: "🌐 简",
    historyTitle: "\u4E13\u6CE8\u8BB0\u5F55",
    historyToday: "\u4ECA\u5929",
    historySessions: "\u6B21",
    historyRecentSessions: "\u6700\u8FD1\u8BB0\u5F55",
    historyNoData: "\u8FD8\u6CA1\u6709\u4E13\u6CE8\u8BB0\u5F55",
    historyClose: "\u5173\u95ED",
    historyMin: "\u5206\u949F",
    historyH: "\u5C0F\u65F6",
    historyWeekdays: "\u4E00|\u4E8C|\u4E09|\u56DB|\u4E94|\u516D|\u65E5",
    historyCategories: "\u7C7B\u522B\u5206\u5E03",
    historyMonthSummary: "\u4E13\u6CE8\u4E86 {0} \u5929\uFF0C\u5171 {1}",
    reacted: "\u5BF9\u4F60\u53D1\u9001\u4E86",
    reactedTo: "\u4F60\u5BF9",
    reactedToSuffix: "\u53D1\u9001\u4E86",
    notOnline: "\u672A\u5728\u7EBF",
    agoJustNow: "\u521A\u521A\u5728\u7EBF",
    agoMin: "{n}\u5206\u949F\u524D\u5728\u7EBF",
    agoHr: "{n}\u5C0F\u65F6\u524D\u5728\u7EBF",
    agoDay: "{n}\u5929\u524D\u5728\u7EBF",
    chooseCharacter: "\u9009\u62E9\u89D2\u8272",
    sit: "\u5750\u4E0B",
    stand: "\u8D77\u6765",
    taglinePlaceholder: "\u4E00\u53E5\u8BDD\u4ECB\u7ECD\u81EA\u5DF1...",
    displayedNameLabel: "\u663E\u793A\u540D\u79F0",
    taglineLabel: "\u7B80\u4ECB\uFF08\u9009\u586B\uFF09",
    profileTab: "\u8D44\u6599",
    systemTab: "\u8BBE\u7F6E",
    profileEntry: "\u7F16\u8F91\u8D44\u6599",
    langLabel: "\u8BED\u8A00",
    iSpeakLabel: "\u6211\u8BF4",
    profileLangLabel: "\u8BED\u8A00",
    uiLangLabel: "\u754C\u9762\u8BED\u8A00",
    timezoneLabel: "\u65F6\u533A",
    timeLateNight: "\u51CC\u6668 (0:00-5:00)",
    timeMorning: "\u65E9\u6668 (5:00-8:00)",
    timeForenoon: "\u4E0A\u5348 (8:00-11:00)",
    timeNoon: "\u4E2D\u5348 (11:00-13:00)",
    timeAfternoon: "\u4E0B\u5348 (13:00-17:00)",
    timeDusk: "\u508D\u665A (17:00-19:00)",
    timeNight: "\u591C\u665A (19:00-24:00)",
    miniOpen: "Mini \u5C0F\u7A97",
    miniClose: "\u5173\u95ED\u5C0F\u7A97",
    miniUnsupported: "\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u5C0F\u7A97",
    miniTitle: "\u5B9E\u65F6\u72B6\u6001",
    miniOnlineTotal: "\u5728\u7EBF",
    miniOnlineFocus: "\u4E13\u6CE8\u533A",
    miniOnlineLounge: "\u4F11\u95F2\u533A",
    miniYou: "\u4F60",
    miniRoom: "\u623F\u95F4",
    miniFocusState: "\u4E13\u6CE8",
    miniFocusing: "\u4E13\u6CE8\u4E2D",
    miniNotFocusing: "\u672A\u4E13\u6CE8",
    miniTimer: "\u8BA1\u65F6",
    miniTask: "\u4EFB\u52A1",
    miniCat: "\u732B\u54AA",
    miniDisconnected: "\u5DF2\u65AD\u5F00",
    miniCatUnknown: "\u672A\u77E5",
    miniShowLabel: "\u663E\u793A",
    miniShowState: "\u72B6\u6001",
    miniShowTimer: "\u8BA1\u65F6",
    miniShowMap: "\u5730\u56FE",
    selectPlayer: "\u4F60\u60F3\u548C\u8C01\u4E92\u52A8\uFF1F",
    clickToInteract: "\u70B9\u51FB\u4E92\u52A8",
    screenshot: "\u622A\u56FE",
    recStart: "\u5F55\u5236\u7F29\u65F6",
    recStop: "\u505C\u6B62\u5F55\u5236",
    recEncoding: "\u7F16\u7801\u4E2D {0}%...",
    recUnsupported: "\u4F60\u7684\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u89C6\u9891\u5F55\u5236\uFF0C\u8BF7\u5C1D\u8BD5\u4F7F\u7528 Chrome\u3001Edge \u6216 Firefox\u3002",
    authLogin: "\u767B\u5F55",
    authRegister: "\u6CE8\u518C",
    authLogout: "\u9000\u51FA",
    authEmail: "\u90AE\u7BB1",
    authPassword: "\u5BC6\u7801",
    authSubmit: "\u63D0\u4EA4",
    authBack: "\u8FD4\u56DE",
    authOr: "\u6216",
    authGuest: "\u6E38\u5BA2\u8FDB\u5165",
    authLoggedInAs: "\u5DF2\u767B\u5F55",
    authErrRequired: "\u90AE\u7BB1\u548C\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A\u3002",
    authErrInvalidEmail: "\u8BF7\u8F93\u5165\u6709\u6548\u7684\u90AE\u7BB1\u5730\u5740\u3002",
    authErrShortPass: "\u5BC6\u7801\u81F3\u5C116\u4E2A\u5B57\u7B26\u3002",
    authErrNetwork: "\u7F51\u7EDC\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5\u3002",
    chatRateLimit: "\u7A0D\u7B49\u4E00\u4E0B~",
    reactionRateLimit: "\u4F60\u7684\u95EE\u5019\u5DF2\u9001\u8FBE~",
    recapTitle: "\u4E0A\u5468\u56DE\u987E",
    recapOnline: "在线时长",
    recapReactions: "收到的问候",
    recapCatGifts: "猫咪叼来的礼物",
    recapTopPartner: "最常陪伴的人",
    recapHours: "\u5C0F\u65F6",
    recapNoData: "\u672C\u5468\u6682\u65E0\u6570\u636E",
    recapClose: "\u5173\u95ED",
    recapSharedHours: "\u5171\u5904",
    shareCard: "\u5206\u4EAB\u5361\u7247",
    focusRecap: "\u4E13\u6CE8\u56DE\u987E",
    shareCardNoData: "\u672C\u5468\u6682\u65E0\u4E13\u6CE8\u6570\u636E",
    bulletinTitle: "\u7559\u8A00\u677F",
    bulletinAnnouncements: "\u516C\u544A",
    bulletinNotes: "\u7559\u8A00",
    bulletinPlaceholder: "\u7559\u4E2A\u8A00\u5427\u2026",
    bulletinPost: "\u53D1\u5E03",
    bulletinLoginRequired: "\u767B\u5F55\u540E\u53EF\u7559\u8A00",
    bulletinLoginToPost: "\u767B\u5F55\u53BB\u53D1\u5E03",
    bulletinCooldown: "\u7A0D\u7B49\u4E00\u4E0B",
    bulletinEmpty: "\u8FD8\u6CA1\u6709\u7559\u8A00",
    bulletinNoAnn: "\u6682\u65E0\u516C\u544A",
    bulletinClose: "\u5173\u95ED",
    follow: "\u5173\u6CE8",
    unfollow: "\u53D6\u6D88\u5173\u6CE8",
    followRequiresRegistration: "\u53EA\u80FD\u5173\u6CE8\u5DF2\u6CE8\u518C\u7528\u6237",
  },
};

let currentLang = localStorage.getItem("lang") ||
  (navigator.language.startsWith("zh") ? "zh" : "en");

function t(key) {
  return TRANSLATIONS[currentLang][key] || TRANSLATIONS.en[key] || key;
}

function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem("lang", lang);
  storeSet("settings", "setLang", lang);
  applyLanguage();
}

function toggleLanguage() {
  setLanguage(currentLang === "en" ? "zh" : "en");
}

// --- Font system ---
// Auto-detect: pixel font on PC/iPad, general font on phone
let usePixelFont = (() => {
  const stored = localStorage.getItem("fontPixel");
  if (stored !== null) return stored !== "false";
  const isMobile = /iPhone|Android.*Mobile/.test(navigator.userAgent);
  return !isMobile;
})();
const FONT_REGULAR = "'MiSans', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const FONT_PIXEL = "'FusionPixel', 'MiSans', sans-serif";

function currentFont() {
  return usePixelFont ? FONT_PIXEL : FONT_REGULAR;
}

function f(size, bold) {
  const family = (usePixelFont && size < 10) ? FONT_REGULAR : currentFont();
  return (bold ? "bold " : "") + size + "px " + family;
}

function applyFont() {
  document.body.style.fontFamily = currentFont();
  const btn = document.getElementById("font-toggle");
  if (btn) btn.textContent = usePixelFont ? "Aa Regular" : "Aa Pixel";
  if (typeof isMiniPiPOpen === "function" && isMiniPiPOpen()) {
    miniPiPWindow.document.body.style.fontFamily = currentFont();
  }
}

function toggleFont() {
  usePixelFont = !usePixelFont;
  localStorage.setItem("fontPixel", String(usePixelFont));
  storeSet("settings", "setFontPixel", usePixelFont);
  applyFont();
}

function applyLanguage() {
  // DOM text updates now handled by React components.
  // Keep miniPiP + room UI synced.
  if (typeof updateMiniPiPButton === "function") updateMiniPiPButton();
  if (typeof renderMiniPiPStatus === "function") renderMiniPiPStatus();
  if (typeof updateRoomUI === "function") updateRoomUI();
}

// --- Time period helper (use local system time, unless overridden) ---
const DEBUG_TIME_KEY = "debugTimeHour";
let debugTimeHour = (() => {
  try {
    const raw = localStorage.getItem(DEBUG_TIME_KEY);
    if (raw === null) return null;
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.min(23, Math.floor(num)));
  } catch {
    return null;
  }
})();

function setDebugTimeHour(hour) {
  if (hour === null || hour === undefined) {
    debugTimeHour = null;
    try { localStorage.removeItem(DEBUG_TIME_KEY); } catch {}
      return true;
  }
  const num = Number(hour);
  if (!Number.isFinite(num)) return false;
  const h = Math.max(0, Math.min(23, Math.floor(num)));
  debugTimeHour = h;
  try { localStorage.setItem(DEBUG_TIME_KEY, String(h)); } catch {}
  return true;
}

let _cachedHour = -1, _cachedHourAt = 0;
function getTimezoneHour() {
  if (debugTimeHour !== null && debugTimeHour !== undefined) return debugTimeHour;
  const now = Date.now();
  if (now - _cachedHourAt > 10000) { // refresh every 10s
    _cachedHour = new Date().getHours();
    _cachedHourAt = now;
  }
  return _cachedHour;
}

function getTimePeriod() {
  const h = getTimezoneHour();
  if (h < 5)  return { emoji: "\uD83C\uDF11", key: "timeNight" };
  if (h < 8)  return { emoji: "\uD83C\uDF05", key: "timeMorning" };
  if (h < 11) return { emoji: "\u2600\uFE0F",  key: "timeForenoon" };
  if (h < 13) return { emoji: "\uD83C\uDF24\uFE0F", key: "timeNoon" };
  if (h < 17) return { emoji: "\uD83C\uDF07", key: "timeAfternoon" };
  if (h < 19) return { emoji: "\uD83C\uDF06", key: "timeDusk" };
  return { emoji: "\uD83C\uDF11", key: "timeNight" };
}

// --- Name tag colors (shared with tokens.css: --name-self/--name-followed/--name-others) ---
const NAME_COLORS = { self: "#A0F0B0", followed: "#FF8FAB", others: "#ffffff" };

// --- Constants ---
const PLAYER_SIZE = 24;
const SPEED = 2;
const PORTAL_TILE = 8; // New tile type for portals

// --- Sprite images & tileset registry ---
const spriteImages = {};
function loadSpriteImage(name, src) {
  const img = new Image();
  img.onload = () => { img._loaded = true; };
  img.onerror = () => { console.error("[IMG] Failed to load:", name, src); };
  img.src = src;
  // Browser cache: img.complete can be true before onload fires
  if (img.complete) img._loaded = true;
  spriteImages[name] = img;
  return img;
}
loadSpriteImage("room_builder_office", "/assets/modern_office/1_Room_Builder_Office/Room_Builder_Office_32x32.png");
loadSpriteImage("modern_office", "/assets/modern_office/Modern_Office_32x32.png");
loadSpriteImage("mi_room_builder", "/assets/moderninteriors-win/1_Interiors/32x32/Room_Builder_32x32.png");
loadSpriteImage("mi_interiors", "/assets/moderninteriors-win/1_Interiors/32x32/Interiors_32x32.png");
loadSpriteImage("modernexteriors_win", "/assets/modernexteriors-win/Modern_Exteriors_32x32/Modern_Exteriors_Complete_Tileset_32x32.png");
const doorSlidingImg = loadSpriteImage("door_sliding", "/assets/moderninteriors-win/3_Animated_objects/32x32/spritesheets/animated_door_glass_sliding_32x32.png");
loadSpriteImage("animated_cat", "/assets/moderninteriors-win/3_Animated_objects/16x16/spritesheets/animated_cat.png");
loadSpriteImage("cat_orange3", "/assets/cats/orange_new.png");
loadSpriteImage("animated_coffee", "/assets/moderninteriors-win/3_Animated_objects/32x32/spritesheets/animated_coffee_32x32.png");
loadSpriteImage("studyRoomDoor", "/assets/moderninteriors-win/3_Animated_objects/32x32/spritesheets/animated_door_big_1_32x32.png");
loadSpriteImage("receptionist", "/assets/moderninteriors-win/3_Animated_objects/32x32/spritesheets/animated_receptionist_2_32x32.png");
loadSpriteImage("jp_door_sliding", "/assets/moderninteriors-win/3_Animated_objects/32x32/spritesheets/animated_japanese_sliding_door_32x32.png");
loadSpriteImage("campfire", "/assets/modernexteriors-win/Modern_Exteriors_32x32/Animated_32x32/Animated_sheets_32x32/Campfire_32x32.png");
loadSpriteImage("water_tileset", "/assets/modernexteriors-win/Modern_Exteriors_32x32/Animated_32x32/Animated_Terrains_32x32/Water_Tileset_32x32.png");
loadSpriteImage("animated_butterfly_3_32x32", "/assets/moderninteriors-win/3_Animated_objects/32x32/spritesheets/animated_butterfly_3_32x32.png");
loadSpriteImage("animated_frog_3_idle_32x32", "/assets/moderninteriors-win/3_Animated_objects/32x32/spritesheets/animated_frog_3_idle_32x32.png");
loadSpriteImage("Fishes_3_32x32", "/assets/modernexteriors-win/Modern_Exteriors_32x32/Animated_32x32/Animated_sheets_32x32/Fishes_3_32x32.png");
loadSpriteImage("tileset_game", "/maps/tileset_game.png");
loadSpriteImage("hand_cursor", "/assets/hand_cursor.png");
// Animated object tileset metadata (keyed by .tsj filename without extension)
const OBJECT_TILESETS = {
  banli:              { imgKey: "animated_cat",      tileW: 48, tileH: 16, columns: 12, frameCount: 12 },
  coffee:             { imgKey: "animated_coffee",   tileW: 32, tileH: 32, columns: 6,  frameCount: 12 },
  studyRoomDoor:      { imgKey: "studyRoomDoor",     tileW: 32, tileH: 96, columns: 5,  frameCount: 5,  isDoor: true, openFrames: 5,  openDist: 2 },
  door_glass_sliding: { imgKey: "door_sliding",      tileW: 64, tileH: 64, columns: 14, frameCount: 14, isDoor: true, openFrames: 7,  openDist: 2 },
  receptionist:       { imgKey: "receptionist",      tileW: 32, tileH: 64, columns: 7,  frameCount: 7 },
  jp_door_sliding:    { imgKey: "jp_door_sliding",   tileW: 64, tileH: 64, columns: 20, frameCount: 20, isDoor: true, openFrames: 10, openDist: 2 },
  Campfire_32x32:     { imgKey: "campfire",          tileW: 32, tileH: 64, columns: 6,  frameCount: 6 },
  Water_Tileset_32x32:{ imgKey: "water_tileset",     tileW: 96, tileH: 96, columns: 8,  frameCount: 8 },
  animated_butterfly_3_32x32: { imgKey: "animated_butterfly_3_32x32", tileW: 32, tileH: 32, columns: 4,  frameCount: 4 },
  animated_frog_3_idle_32x32: { imgKey: "animated_frog_3_idle_32x32", tileW: 32, tileH: 32, columns: 6,  frameCount: 6 },
  Fishes_3_32x32:             { imgKey: "Fishes_3_32x32",             tileW: 32, tileH: 32, columns: 14, frameCount: 14 },
};

// --- Character Generator sprite system ---
const CHAR_GEN_BASE = "/assets/moderninteriors-win/2_Characters/Character_Generator/";
const PREMADE_COUNT = 20;

// Asset catalog: style -> variant count
const CHAR_CATALOG = {
  bodies: 9,
  eyes: 7,
  outfits: {1:10,2:4,3:4,4:3,5:5,6:4,7:4,8:3,9:3,10:5,11:4,12:3,13:4,14:5,15:3,16:3,17:3,18:4,19:4,20:3,21:4,22:4,23:4,24:4,25:5,26:3,27:3,28:4,29:4,30:3,31:5,32:5,33:3},
  hairs: {1:7,2:7,3:7,4:7,5:7,6:7,7:7,8:7,9:7,10:7,11:7,12:7,13:7,14:7,15:7,16:7,17:7,18:7,19:7,20:7,21:7,22:7,23:7,24:7,25:7,26:7,27:6,28:6,29:6},
  accessories: [
    {id:1,name:"Ladybug",variants:4},{id:2,name:"Bee",variants:3},{id:3,name:"Backpack",variants:10},
    {id:4,name:"Snapback",variants:6},{id:5,name:"Dino_Snapback",variants:3},{id:6,name:"Policeman_Hat",variants:6},
    {id:7,name:"Bataclava",variants:3},{id:8,name:"Detective_Hat",variants:3},{id:9,name:"Zombie_Brain",variants:3},
    {id:10,name:"Bolt",variants:3},{id:11,name:"Beanie",variants:5},{id:12,name:"Mustache",variants:5},
    {id:13,name:"Beard",variants:5},{id:14,name:"Gloves",variants:4},{id:15,name:"Glasses",variants:6},
    {id:16,name:"Monocle",variants:3},{id:17,name:"Medical_Mask",variants:5},{id:18,name:"Chef",variants:3},
    {id:19,name:"Party_Cone",variants:4},
  ],
};

// Animation row definitions — each "row" is 64px tall (head 32px + body 32px)
// sy = ANIM_ROWS[anim] * 64
const ANIM_ROWS = { static: 0, idle: 1, walk: 2, sleep: 3, sit: 4, phone: 7, exercise: 11 };
const FRAMES_PER_DIR = 6;

// Load all 20 premade character sheets
for (let i = 1; i <= PREMADE_COUNT; i++) {
  const id = String(i).padStart(2, "0");
  loadSpriteImage(`premade_${id}`, `${CHAR_GEN_BASE}0_Premade_Characters/32x32/Premade_Character_32x32_${id}.png`);
}

// On-demand layer loading for custom characters
function loadCharLayer(type, fileId) {
  const key = `layer_${type}_${fileId}`;
  if (spriteImages[key]) return spriteImages[key];
  const paths = {
    body: `${CHAR_GEN_BASE}Bodies/32x32/Body_32x32_${fileId}.png`,
    eyes: `${CHAR_GEN_BASE}Eyes/32x32/Eyes_32x32_${fileId}.png`,
    outfit: `${CHAR_GEN_BASE}Outfits/32x32/Outfit_${fileId.split("_")[0]}_32x32_${fileId.split("_")[1]}.png`,
    hair: `${CHAR_GEN_BASE}Hairstyles/32x32/Hairstyle_${fileId.split("_")[0]}_32x32_${fileId.split("_")[1]}.png`,
    acc: (() => {
      // acc fileId format: "NN_Name_VV"
      const parts = fileId.split("_");
      const accId = parts[0];
      const variant = parts[parts.length - 1];
      const name = parts.slice(1, -1).join("_");
      return `${CHAR_GEN_BASE}Accessories/32x32/Accessory_${accId}_${name}_32x32_${variant}.png`;
    })(),
  };
  loadSpriteImage(key, paths[type]);
  return spriteImages[key];
}

// Composite cache for custom layered characters
const compositeCache = new Map();

function getCompositeKey(config) {
  if (config.preset) return `p${config.preset}`;
  return `b${config.body}_e${config.eyes}_o${config.outfit}_h${config.hair}_a${config.acc || "x"}`;
}

function ensureLayersLoaded(config) {
  if (config.preset) return;
  loadCharLayer("body", String(config.body).padStart(2, "0"));
  loadCharLayer("eyes", String(config.eyes).padStart(2, "0"));
  loadCharLayer("outfit", config.outfit);
  loadCharLayer("hair", config.hair);
  if (config.acc) loadCharLayer("acc", config.acc);
}

function buildComposite(config, cacheKey) {
  const W = 1792, H = 1312;
  const bodyKey = `layer_body_${String(config.body).padStart(2, "0")}`;
  const eyesKey = `layer_eyes_${String(config.eyes).padStart(2, "0")}`;
  const outfitKey = `layer_outfit_${config.outfit}`;
  const hairKey = `layer_hair_${config.hair}`;
  const layers = [
    spriteImages[bodyKey],
    spriteImages[eyesKey],
    spriteImages[outfitKey],
    spriteImages[hairKey],
  ];
  if (config.acc) layers.push(spriteImages[`layer_acc_${config.acc}`]);
  if (layers.some(l => !l || !l._loaded)) return null;
  const oc = document.createElement("canvas");
  oc.width = W; oc.height = H;
  const octx = oc.getContext("2d");
  for (const layer of layers) {
    octx.drawImage(layer, 0, 0, Math.min(layer.naturalWidth, W), H, 0, 0, W, H);
  }
  oc._loaded = true;
  compositeCache.set(cacheKey, oc);
  return oc;
}

function getCharacterSheet(config) {
  if (!config) config = { preset: 1 };
  if (config.preset) {
    const key = `premade_${String(config.preset).padStart(2, "0")}`;
    return spriteImages[key];
  }
  const cacheKey = getCompositeKey(config);
  if (compositeCache.has(cacheKey)) return compositeCache.get(cacheKey);
  ensureLayersLoaded(config);
  return buildComposite(config, cacheKey);
}

// --- Character picker (Character Generator) ---
// Migrate legacy playerCharacter string to charConfig
let selectedCharConfig = (() => {
  const saved = localStorage.getItem("charConfig");
  if (saved) { try { return JSON.parse(saved); } catch(e) {} }
  // Migrate legacy string
  const legacy = localStorage.getItem("playerCharacter");
  if (legacy) {
    localStorage.removeItem("playerCharacter");
    const config = { preset: 1 };
    localStorage.setItem("charConfig", JSON.stringify(config));
    return config;
  }
  return { preset: 1 };
})();
let savedTagline = localStorage.getItem("playerTagline") || "";
let savedProfession = localStorage.getItem("playerProfession") || "mystery";
let selectedLanguages = (() => {
  const saved = localStorage.getItem("playerLanguages");
  if (saved) { try { const arr = JSON.parse(saved); if (Array.isArray(arr) && arr.length) return arr; } catch(e) {} }
  return [currentLang === "zh" ? "zh-CN" : "en"];
})();

function drawCharPreview(canvas, config) {
  if (!config) config = { preset: 1 };
  canvas.width = 32;
  canvas.height = 64;
  const c = canvas.getContext("2d");
  c.imageSmoothingEnabled = false;
  const sheet = getCharacterSheet(config);
  if (sheet && sheet._loaded) {
    // Static down frame: row 0 (sy=0), col 3 (direction "down"), 32x64
    c.drawImage(sheet, 3 * 32, 0, 32, 64, 0, 0, 32, 64);
  } else {
    // Retry when sheet loads
    const tryDraw = () => {
      const s = getCharacterSheet(config);
      if (s && s._loaded) {
        c.clearRect(0, 0, 32, 64);
        c.drawImage(s, 3 * 32, 0, 32, 64, 0, 0, 32, 64);
      } else {
        setTimeout(tryDraw, 200);
      }
    };
    setTimeout(tryDraw, 200);
  }
}

function drawCharHeadPreview(canvas, config) {
  if (!config) config = { preset: 1 };
  canvas.width = 32;
  canvas.height = 32;
  const c = canvas.getContext("2d");
  c.imageSmoothingEnabled = false;
  const sheet = getCharacterSheet(config);
  if (sheet && sheet._loaded) {
    // Face/eyes span across the middle of the 64px frame, not just top 32px.
    c.drawImage(sheet, 3 * 32, 20, 32, 32, 0, 0, 32, 32);
  } else {
    const tryDraw = () => {
      const s = getCharacterSheet(config);
      if (s && s._loaded) {
        c.clearRect(0, 0, 32, 32);
        c.drawImage(s, 3 * 32, 20, 32, 32, 0, 0, 32, 32);
      } else {
        setTimeout(tryDraw, 200);
      }
    };
    setTimeout(tryDraw, 200);
  }
}

// Expose function for React to get current avatar canvas (32x64 full body)
window.__getCurrentAvatarCanvas = function() {
  const cvs = document.createElement("canvas");
  drawCharPreview(cvs, selectedCharConfig);
  return cvs;
};

// Expose function for React PlayerCard to draw a player's head avatar
window.__drawPlayerCardAvatar = function(canvasEl, playerId) {
  if (!canvasEl) return;
  const p = playerId === myId ? localPlayer : otherPlayers[playerId];
  const config = p?.character || (playerId === myId ? selectedCharConfig : null);
  if (!config) return;
  drawCharHeadPreview(canvasEl, config);
};

function updateSettingsCharBtn() {
  const btn = document.getElementById("settings-char-btn");
  if (btn) {
    let cvs = btn.querySelector("canvas");
    if (!cvs) {
      cvs = document.createElement("canvas");
      cvs.style.width = "24px";
      cvs.style.height = "28px";
      cvs.style.objectFit = "contain";
      btn.appendChild(cvs);
    }
    drawCharPreview(cvs, selectedCharConfig);
  }
  const profileBtn = document.getElementById("profile-icon");
  if (profileBtn) {
    let head = profileBtn.querySelector("canvas");
    if (!head) {
      head = document.createElement("canvas");
      profileBtn.appendChild(head);
    }
    drawCharHeadPreview(head, selectedCharConfig);
  }
  // Also update the React profile icon
  const profileBtnReact = document.getElementById("profile-icon-react");
  if (profileBtnReact) {
    let head2 = profileBtnReact.querySelector("canvas");
    if (!head2) {
      head2 = document.createElement("canvas");
      profileBtnReact.appendChild(head2);
    }
    drawCharHeadPreview(head2, selectedCharConfig);
  }
}

// === Character Customizer (shared logic for welcome + overlay) ===
let customizerConfig = null;
let customizerTab = "body";
let customizerCtx = null;
let customizerIsOverlay = false;   // true = settings overlay (defer save)
let customizerSavedConfig = null;  // snapshot to revert on Cancel

function applyCharConfig(config) {
  selectedCharConfig = config;
  localStorage.setItem("charConfig", JSON.stringify(config));
  if (localPlayer) {
    localPlayer.character = config;
    socket.emit("setCharacter", config);
  }
  updateSettingsCharBtn();
}

// In overlay mode, only update preview; in welcome mode, apply immediately
function onCustomizerChange() {
  if (!customizerIsOverlay) {
    applyCharConfig({ ...customizerConfig });
  }
}

function initCustomizerCtx(previewId, optionsId, variantsId, tabsContainer, presetsId) {
  customizerCtx = {
    preview: document.getElementById(previewId),
    options: document.getElementById(optionsId),
    variants: document.getElementById(variantsId),
    tabs: tabsContainer,
    presets: document.getElementById(presetsId),
  };
}

// Visible limits (rest reserved for unlock/exchange)
const VISIBLE_BODY = 7;
const VISIBLE_OUTFIT = 14;
const VISIBLE_HAIR = 14;
const VISIBLE_ACC = 6;

function generateRandomConfig() {
  const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const pad = n => String(n).padStart(2, "0");
  const bodyId = randInt(1, VISIBLE_BODY);
  const eyesId = randInt(1, CHAR_CATALOG.eyes);
  const outfitStyles = Object.keys(CHAR_CATALOG.outfits).map(Number).filter(s => s <= VISIBLE_OUTFIT);
  const oStyle = outfitStyles[randInt(0, outfitStyles.length - 1)];
  const oVar = randInt(1, CHAR_CATALOG.outfits[oStyle]);
  const hairStyles = Object.keys(CHAR_CATALOG.hairs).map(Number).filter(s => s <= VISIBLE_HAIR);
  const hStyle = hairStyles[randInt(0, hairStyles.length - 1)];
  const hVar = randInt(1, CHAR_CATALOG.hairs[hStyle]);
  // 30% chance of accessory
  let acc = null;
  if (Math.random() < 0.3) {
    const visibleAcc = CHAR_CATALOG.accessories.filter(a => a.id <= VISIBLE_ACC);
    const a = visibleAcc[randInt(0, visibleAcc.length - 1)];
    acc = pad(a.id) + "_" + a.name + "_" + pad(randInt(1, a.variants));
  }
  return { body: bodyId, eyes: eyesId, outfit: pad(oStyle) + "_" + pad(oVar), hair: pad(hStyle) + "_" + pad(hVar), acc };
}

function activateCustomizer(initialConfig, defaultTab) {
  const isPremade = initialConfig && initialConfig.preset;
  customizerConfig = (!initialConfig || isPremade)
    ? { body: 1, eyes: 1, outfit: "01_01", hair: "01_01", acc: null }
    : { ...initialConfig };
  customizerTab = defaultTab || "body";
  renderPresetsRow(customizerCtx && customizerCtx.presets);
  // If starting with a premade, show it in preview and hide custom section
  if (isPremade) {
    customizerConfig = { ...initialConfig };
    if (customizerCtx && customizerCtx.preview) {
      drawCharPreview(customizerCtx.preview, initialConfig);
    }
    setCustomSectionVisible(false);
  } else {
    renderCustomizerPreview();
    renderCustomizerTab(customizerTab);
    setCustomSectionVisible(true);
  }
  if (customizerCtx && customizerCtx.tabs) {
    customizerCtx.tabs.querySelectorAll(".ctab").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === customizerTab));
  }
}

// Open the overlay customizer (from settings)
function openCustomizer(initialConfig) {
  const overlay = document.getElementById("char-customizer");
  if (!overlay) return;
  customizerIsOverlay = true;
  customizerSavedConfig = JSON.parse(JSON.stringify(selectedCharConfig));
  initCustomizerCtx("customizer-preview-canvas", "customizer-options", "customizer-variants",
    overlay.querySelector(".customizer-tabs"), "overlay-presets");
  overlay.style.display = "flex";
  storeSet("ui", "setCustomizerOpen", true);
  activateCustomizer(initialConfig, "body");
}

function closeCustomizer(revert) {
  const overlay = document.getElementById("char-customizer");
  if (overlay) overlay.style.display = "none";
  storeSet("ui", "setCustomizerOpen", false);
  if (revert && customizerSavedConfig) {
    applyCharConfig(customizerSavedConfig);
  }
  customizerIsOverlay = false;
  customizerSavedConfig = null;
}

function renderCustomizerPreview() {
  if (!customizerCtx || !customizerCtx.preview || !customizerConfig) return;
  const cacheKey = getCompositeKey(customizerConfig);
  compositeCache.delete(cacheKey);
  drawCharPreview(customizerCtx.preview, customizerConfig);
}

// Show/hide the custom editing section (tabs + options + variants)
function setCustomSectionVisible(visible) {
  if (!customizerCtx) return;
  const display = visible ? "" : "none";
  if (customizerCtx.tabs) customizerCtx.tabs.style.display = visible ? "flex" : "none";
  if (customizerCtx.options) customizerCtx.options.style.display = visible ? "flex" : "none";
  if (customizerCtx.variants) customizerCtx.variants.style.display = visible ? "flex" : "none";
}

function renderPresetsRow(container) {
  if (!container) return;
  container.innerHTML = "";
  // Premade characters
  for (let i = 1; i <= PREMADE_COUNT; i++) {
    const config = { preset: i };
    const cell = document.createElement("div");
    cell.className = "cust-option cust-premade";
    const cvs = document.createElement("canvas");
    cvs.style.width = "32px";
    cvs.style.height = "48px";
    cvs.style.objectFit = "contain";
    cvs.style.imageRendering = "pixelated";
    cell.appendChild(cvs);
    drawCharPreview(cvs, config);
    cell.addEventListener("click", () => {
      customizerConfig = { ...config };
      if (!customizerIsOverlay) applyCharConfig(config);
      if (customizerCtx && customizerCtx.preview) {
        drawCharPreview(customizerCtx.preview, config);
      }
      container.querySelectorAll(".cust-premade").forEach(c => c.classList.remove("selected"));
      cell.classList.add("selected");
      // Hide custom section — premade is a complete character
      setCustomSectionVisible(false);
    });
    container.appendChild(cell);
  }
}

function renderCustomizerTab(tabName) {
  customizerTab = tabName;
  if (!customizerCtx) return;
  const optionsEl = customizerCtx.options;
  const variantsEl = customizerCtx.variants;
  if (!optionsEl || !variantsEl) return;
  optionsEl.innerHTML = "";
  variantsEl.innerHTML = "";

  // For custom tabs, ensure we have a custom config to edit
  if (!customizerConfig) {
    customizerConfig = { body: 1, eyes: 1, outfit: "01_01", hair: "01_01", acc: null };
  }

  if (tabName === "body") {
    for (let i = 1; i <= Math.min(VISIBLE_BODY, CHAR_CATALOG.bodies); i++) {
      const btn = document.createElement("div");
      btn.className = "cust-option" + (customizerConfig.body === i ? " selected" : "");
      const colors = ["#bf8b78","#ffcbb0","#ffb893","#bb845c","#cdb57a","#d4cabb","#f0ae80","#e6b8d7","#bab8d7"];
      btn.style.background = colors[i - 1] || "#ccc";
      btn.style.width = "40px"; btn.style.height = "40px"; btn.style.borderRadius = "50%";
      btn.addEventListener("click", () => {
        customizerConfig.body = i;
        onCustomizerChange();
        renderCustomizerTab(tabName);
        renderCustomizerPreview();
      });
      optionsEl.appendChild(btn);
    }
  } else if (tabName === "eyes") {
    for (let i = 1; i <= CHAR_CATALOG.eyes; i++) {
      const btn = document.createElement("div");
      btn.className = "cust-option" + (customizerConfig.eyes === i ? " selected" : "");
      btn.textContent = `${i}`;
      btn.addEventListener("click", () => {
        customizerConfig.eyes = i;
        onCustomizerChange();
        renderCustomizerTab(tabName);
        renderCustomizerPreview();
      });
      optionsEl.appendChild(btn);
    }
  } else if (tabName === "outfit") {
    const styles = Object.keys(CHAR_CATALOG.outfits).map(Number).filter(s => s <= VISIBLE_OUTFIT);
    const currentStyle = parseInt(customizerConfig.outfit.split("_")[0]);
    const currentVariant = parseInt(customizerConfig.outfit.split("_")[1]);
    styles.forEach(s => {
      const btn = document.createElement("div");
      btn.className = "cust-option" + (currentStyle === s ? " selected" : "");
      btn.textContent = s;
      btn.addEventListener("click", () => {
        customizerConfig.outfit = String(s).padStart(2, "0") + "_01";
        onCustomizerChange();
        renderCustomizerTab(tabName);
        renderCustomizerPreview();
      });
      optionsEl.appendChild(btn);
    });
    const varCount = CHAR_CATALOG.outfits[currentStyle] || 1;
    for (let v = 1; v <= varCount; v++) {
      const btn = document.createElement("div");
      btn.className = "cust-variant" + (currentVariant === v ? " selected" : "");
      btn.textContent = v;
      btn.addEventListener("click", () => {
        customizerConfig.outfit = String(currentStyle).padStart(2, "0") + "_" + String(v).padStart(2, "0");
        onCustomizerChange();
        renderCustomizerTab(tabName);
        renderCustomizerPreview();
      });
      variantsEl.appendChild(btn);
    }
  } else if (tabName === "hair") {
    const styles = Object.keys(CHAR_CATALOG.hairs).map(Number).filter(s => s <= VISIBLE_HAIR);
    const currentStyle = parseInt(customizerConfig.hair.split("_")[0]);
    const currentVariant = parseInt(customizerConfig.hair.split("_")[1]);
    styles.forEach(s => {
      const btn = document.createElement("div");
      btn.className = "cust-option" + (currentStyle === s ? " selected" : "");
      btn.textContent = s;
      btn.addEventListener("click", () => {
        customizerConfig.hair = String(s).padStart(2, "0") + "_01";
        onCustomizerChange();
        renderCustomizerTab(tabName);
        renderCustomizerPreview();
      });
      optionsEl.appendChild(btn);
    });
    const varCount = CHAR_CATALOG.hairs[currentStyle] || 1;
    for (let v = 1; v <= varCount; v++) {
      const btn = document.createElement("div");
      btn.className = "cust-variant" + (currentVariant === v ? " selected" : "");
      btn.textContent = v;
      btn.addEventListener("click", () => {
        customizerConfig.hair = String(currentStyle).padStart(2, "0") + "_" + String(v).padStart(2, "0");
        onCustomizerChange();
        renderCustomizerTab(tabName);
        renderCustomizerPreview();
      });
      variantsEl.appendChild(btn);
    }
  } else if (tabName === "acc") {
    const noneBtn = document.createElement("div");
    noneBtn.className = "cust-option" + (!customizerConfig.acc ? " selected" : "");
    noneBtn.textContent = "None";
    noneBtn.style.fontSize = "11px";
    noneBtn.addEventListener("click", () => {
      customizerConfig.acc = null;
      onCustomizerChange();
      renderCustomizerTab(tabName);
      renderCustomizerPreview();
    });
    optionsEl.appendChild(noneBtn);

    let currentAccId = null, currentAccVariant = null;
    if (customizerConfig.acc) {
      const parts = customizerConfig.acc.split("_");
      currentAccId = parseInt(parts[0]);
      currentAccVariant = parseInt(parts[parts.length - 1]);
    }
    CHAR_CATALOG.accessories.filter(a => a.id <= VISIBLE_ACC).forEach(acc => {
      const btn = document.createElement("div");
      btn.className = "cust-option" + (currentAccId === acc.id ? " selected" : "");
      btn.textContent = acc.id;
      btn.title = acc.name.replace(/_/g, " ");
      btn.addEventListener("click", () => {
        customizerConfig.acc = String(acc.id).padStart(2, "0") + "_" + acc.name + "_01";
        onCustomizerChange();
        renderCustomizerTab(tabName);
        renderCustomizerPreview();
      });
      optionsEl.appendChild(btn);
    });
    if (currentAccId) {
      const accInfo = CHAR_CATALOG.accessories.find(a => a.id === currentAccId);
      if (accInfo) {
        for (let v = 1; v <= accInfo.variants; v++) {
          const btn = document.createElement("div");
          btn.className = "cust-variant" + (currentAccVariant === v ? " selected" : "");
          btn.textContent = v;
          btn.addEventListener("click", () => {
            customizerConfig.acc = String(currentAccId).padStart(2, "0") + "_" + accInfo.name + "_" + String(v).padStart(2, "0");
            onCustomizerChange();
            renderCustomizerTab(tabName);
            renderCustomizerPreview();
          });
          variantsEl.appendChild(btn);
        }
      }
    }
  }
}

// Welcome customizer init — callable by React on mount
function _initWelcomeCustomizer() {
  const welcomeTabs = document.getElementById("welcome-tabs");
  // Only proceed if the REAL element exists (not a proxy shim)
  if (!welcomeTabs || !welcomeTabs.parentElement) return;
  initCustomizerCtx("welcome-preview-canvas", "welcome-options", "welcome-variants", welcomeTabs, "welcome-presets");
  welcomeTabs.querySelectorAll(".ctab").forEach(btn => {
    // Remove old listeners by cloning
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener("click", () => {
      if (customizerConfig && customizerConfig.preset) {
        customizerConfig = { body: 1, eyes: 1, outfit: "01_01", hair: "01_01", acc: null };
      }
      setCustomSectionVisible(true);
      if (customizerCtx && customizerCtx.presets) customizerCtx.presets.querySelectorAll(".cust-premade").forEach(c => c.classList.remove("selected"));
      welcomeTabs.querySelectorAll(".ctab").forEach(b => b.classList.remove("active"));
      fresh.classList.add("active");
      renderCustomizerTab(fresh.dataset.tab);
      renderCustomizerPreview();
    });
  });
  activateCustomizer(selectedCharConfig, "body");

  const modePreset = document.getElementById("welcome-mode-preset");
  const modeCustom = document.getElementById("welcome-mode-custom");
  const presetsEl = document.getElementById("welcome-presets");
  function setWelcomeMode(mode) {
    if (mode === "preset") {
      if (modePreset) modePreset.classList.add("active");
      if (modeCustom) modeCustom.classList.remove("active");
      if (presetsEl) presetsEl.style.display = "";
      setCustomSectionVisible(false);
    } else {
      if (modeCustom) modeCustom.classList.add("active");
      if (modePreset) modePreset.classList.remove("active");
      if (presetsEl) presetsEl.style.display = "none";
      if (customizerConfig && customizerConfig.preset) {
        customizerConfig = { body: 1, eyes: 1, outfit: "01_01", hair: "01_01", acc: null };
      }
      setCustomSectionVisible(true);
      renderCustomizerTab(customizerTab);
      renderCustomizerPreview();
      if (welcomeTabs) {
        welcomeTabs.querySelectorAll(".ctab").forEach(b =>
          b.classList.toggle("active", b.dataset.tab === customizerTab));
      }
    }
  }
  if (modePreset) modePreset.addEventListener("click", () => setWelcomeMode("preset"));
  if (modeCustom) modeCustom.addEventListener("click", () => setWelcomeMode("custom"));
  setWelcomeMode("preset");

  const diceBtn = document.getElementById("welcome-dice");
  if (diceBtn) {
    diceBtn.addEventListener("click", () => {
      const config = generateRandomConfig();
      customizerConfig = config;
      applyCharConfig(config);
      if (customizerCtx && customizerCtx.preview) {
        compositeCache.delete(getCompositeKey(config));
        drawCharPreview(customizerCtx.preview, config);
      }
      if (presetsEl) presetsEl.querySelectorAll(".cust-premade").forEach(c => c.classList.remove("selected"));
      setWelcomeMode("custom");
      // Re-render current tab to highlight the randomly selected options
      renderCustomizerTab(customizerTab);
    });
  }
}

// Hook up events (deferred to DOM ready)
setTimeout(() => {
  // Overlay customizer (for settings)
  document.querySelectorAll("#char-customizer .ctab").forEach(btn => {
    btn.addEventListener("click", () => {
      if (customizerConfig && customizerConfig.preset) {
        customizerConfig = { body: 1, eyes: 1, outfit: "01_01", hair: "01_01", acc: null };
      }
      setCustomSectionVisible(true);
      if (customizerCtx && customizerCtx.presets) customizerCtx.presets.querySelectorAll(".cust-premade").forEach(c => c.classList.remove("selected"));
      document.querySelectorAll("#char-customizer .ctab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderCustomizerTab(btn.dataset.tab);
      renderCustomizerPreview();
    });
  });
  document.getElementById("customizer-confirm")?.addEventListener("click", () => {
    if (customizerConfig) applyCharConfig({ ...customizerConfig });
    updateSettingsCharBtn();
    closeCustomizer(false);
  });
  document.getElementById("customizer-cancel")?.addEventListener("click", () => closeCustomizer(true));

  // Welcome customizer — extracted to a function so React can re-call it on mount
  _initWelcomeCustomizer();
  window.__initWelcomeCustomizer = _initWelcomeCustomizer;

  updateSettingsCharBtn();
}, 500);

// Settings character button -> open overlay customizer
document.getElementById("settings-char-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeSettingsPanel();
  openCustomizer(selectedCharConfig);
});

// Known tileset metadata (columns needed to compute source rect from GID)
const TILESET_INFO = {
  tileset_game:          { columns: 18, imgKey: "tileset_game" },
  room_builder_office:   { columns: 16, imgKey: "room_builder_office" },
  modern_office:         { columns: 16, imgKey: "modern_office" },
  mi_room_builder:       { columns: 76, imgKey: "mi_room_builder" },
  mi_interiors:          { columns: 16, imgKey: "mi_interiors" },
  ME:                    { columns: 176, imgKey: "modernexteriors_win" },
  "modernexteriors-win": { columns: 176, imgKey: "modernexteriors_win" },
};

// Populated from Tiled JSON tilesets array (per room)
const roomTilesetRegistry = { focus: [], rest: [] };
let tilesetRegistry = []; // active registry for current room

function drawTileByGID(gid, x, y) {
  if (gid === 0) return false;
  for (let i = tilesetRegistry.length - 1; i >= 0; i--) {
    const ts = tilesetRegistry[i];
    if (gid >= ts.firstgid) {
      if (!ts.img || !ts.img._loaded) return false;
      const localId = gid - ts.firstgid;
      const sx = (localId % ts.columns) * 32;
      const sy = Math.floor(localId / ts.columns) * 32;
      ctx.drawImage(ts.img, sx, sy, 32, 32, x, y, TILE, TILE);
      return true;
    }
  }
  return false;
}

// --- Current room ---
let currentRoom = "focus";

// ============================================================
// ANIMATED DOOR SYSTEM
// ============================================================
const DOOR_FRAME_W = 64;   // sprite frame width (2 tiles)
const DOOR_FRAME_H = 64;   // sprite frame height (2 tiles)
const DOOR_OPEN_FRAMES = 7; // frames 0-6 = opening sequence
const DOOR_FRAME_MS = 80;   // ms per animation frame
const DOOR_TRIGGER_DIST = 3 * TILE; // proximity trigger distance
const DOOR_TRIGGER_DIST_SQ = DOOR_TRIGGER_DIST * DOOR_TRIGGER_DIST;

// Door objects per room: { room: [{ x, y, tileX, tileY, state, frame, lastTime }, ...] }
const roomDoors = { focus: [], rest: [] };

function findDoorsInCollision(collision, cols, rows) {
  const doors = [];
  const visited = new Set();
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (collision[r][c] === 12 && !visited.has(r + "," + c)) {
        // Each door occupies 2×2 tiles - group from top-left
        for (let dr = 0; dr < 2; dr++)
          for (let dc = 0; dc < 2; dc++)
            visited.add((r + dr) + "," + (c + dc));
        doors.push({
          tileX: c, tileY: r,
          x: c * TILE, y: r * TILE,
          state: "closed", // closed | opening | open | closing
          frame: 0,
          lastTime: 0,
        });
        c++; // skip next col (already part of this door)
      }
    }
  }
  return doors;
}

function isAnyPlayerNearDoor(door) {
  const cx = door.x + DOOR_FRAME_W / 2;
  const cy = door.y + DOOR_FRAME_H / 2;
  // Check local player
  if (localPlayer) {
    const dx = localPlayer.x - cx, dy = localPlayer.y - cy;
    if (dx * dx + dy * dy < DOOR_TRIGGER_DIST_SQ) return true;
  }
  // Check remote players
  for (const id in players) {
    const p = players[id];
    if (p.room !== currentRoom) continue;
    const dx = p.x - cx, dy = p.y - cy;
    if (dx * dx + dy * dy < DOOR_TRIGGER_DIST_SQ) return true;
  }
  return false;
}

function updateDoors() {
  const doors = roomDoors[currentRoom];
  if (!doors || !doors.length) return;
  const now = Date.now();

  // All doors in the room share the same open/close state (linked doors)
  const anyNear = doors.some(d => isAnyPlayerNearDoor(d));

  for (const door of doors) {
    if (anyNear && (door.state === "closed" || door.state === "closing")) {
      if (door === doors[0]) playDoorSlidingSound();
      door.state = "opening";
      if (door.frame >= DOOR_OPEN_FRAMES - 1) door.frame = 0;
      door.lastTime = now;
    } else if (!anyNear && (door.state === "open" || door.state === "opening")) {
      if (door === doors[0]) playDoorSlidingSound();
      door.state = "closing";
      if (door.frame <= 0) door.frame = DOOR_OPEN_FRAMES - 1;
      door.lastTime = now;
    }

    if (door.state === "opening") {
      if (now - door.lastTime >= DOOR_FRAME_MS) {
        door.frame++;
        door.lastTime = now;
        if (door.frame >= DOOR_OPEN_FRAMES - 1) {
          door.frame = DOOR_OPEN_FRAMES - 1;
          door.state = "open";
        }
      }
    } else if (door.state === "closing") {
      if (now - door.lastTime >= DOOR_FRAME_MS) {
        door.frame--;
        door.lastTime = now;
        if (door.frame <= 0) {
          door.frame = 0;
          door.state = "closed";
        }
      }
    }
  }
}

function isDoorOpenAt(col, row) {
  const doors = roomDoors[currentRoom];
  if (!doors) return false;
  for (const d of doors) {
    if (col >= d.tileX && col < d.tileX + 2 && row >= d.tileY && row < d.tileY + 2) {
      return d.state === "open" || (d.state === "opening" && d.frame >= 3);
    }
  }
  return false;
}

function isDoorTile(col, row) {
  const doors = roomDoors[currentRoom];
  if (!doors) return false;
  for (const d of doors) {
    if (col >= d.tileX && col < d.tileX + 2 && row >= d.tileY && row < d.tileY + 2) return true;
  }
  return false;
}

// ============================================================
// ROOM MAPS
// ============================================================
// 0=floor, 1=wall, 2=desk, 3=bookshelf, 4=plant, 5=rug,
// 6=(unused), 7=chair, 8=portal, 9=sofa, 10=coffee_machine, 12=door, 15=yoga_mat

// --- Focus Room Colors ---
const FOCUS_COLORS = {
  floor: "#b8c4d0",
  floorDark: "#a8b6c4",
  wall: "#8a96a6",
  wallTop: "#98a4b4",
  wallDark: "#7a8898",
  desk: "#6a7a8a",
  deskTop: "#7a8a9a",
  chair: "#5a7a8a",
  bookshelf: "#5c6a78",
  bookColors: ["#c07060", "#4a8ab8", "#5a9a6a", "#d4a040", "#8a70a8"],
  plant: "#5a9a68",
  plantPot: "#8a9aa8",
  rug: "#8a9cb0",
  rugAlt: "#7e90a4",
  portal: "#e07080",
  portalGlow: "#f0909a",
};

// --- Rest Room Colors ---
const REST_COLORS = {
  floor: "#8b6f55",
  floorDark: "#7d6349",
  wall: "#c0a0b8",
  wallTop: "#d0b0c8",
  wallDark: "#b090a8",
  desk: "#a07848",
  deskTop: "#b88858",
  sofa: "#c07898",
  sofaTop: "#d088a8",
  bookshelf: "#8a6838",
  bookColors: ["#e07060", "#e0a040", "#60b070", "#e08040", "#d06090"],
  plant: "#5a9a68",
  plantPot: "#c09060",
  rug: "#a08070",
  rugAlt: "#947464",
  coffeeMachine: "#787878",
  coffeeTop: "#909090",
  portal: "#60a0d0",
  portalGlow: "#80b8e0",
};

// --- Time-of-Day Visual Config ---
let cachedTimeKey = "daytime";
const TIME_VISUALS = {
  morning: {
    windowGlass: "#d6ecff",
    windowGlow: "rgba(140,190,255,0.10)",
    overlayColor: "rgba(120,160,200,0.05)",
    vignetteAlpha: 0.08,
    outdoorShadeAlpha: 0.08,
    outdoorShadeColor: "rgba(50,90,140,1)",
    skyColors: ["#b8dcff", "#87b4e8"],
    starCount: 0,
  },
  daytime: {
    windowGlass: "#a8e0ff",
    windowGlow: "rgba(180,220,255,0.08)",
    overlayColor: null,
    vignetteAlpha: 0.1,
    outdoorShadeAlpha: 0.0,
    outdoorShadeColor: null,
    skyColors: ["#87ceeb", "#b0d8f0"],
    starCount: 0,
  },
  dusk: {
    windowGlass: "#f6c08a",
    windowGlow: "rgba(250,185,125,0.14)",
    overlayColor: "rgba(190,110,80,0.06)",
    vignetteAlpha: 0.18,
    outdoorShadeAlpha: 0.1,
    outdoorShadeColor: "rgba(75,85,105,1)",
    skyColors: ["#f5b07a", "#e38a6a", "#6a84b8"],
    starCount: 0,
  },
  night: {
    windowGlass: "#2b3f62",
    windowGlow: "rgba(80,120,180,0.05)",
    overlayColor: "rgba(12,20,48,0.12)",
    vignetteAlpha: 0.36,
    outdoorShadeAlpha: 0.6,
    outdoorShadeColor: "rgba(10,22,58,1)",
    skyColors: ["#15183a", "#202045"],
    starCount: 5,
  },
};

// Outdoor shading mask (from outdoor tile layer or collision tag OD=16)
const OUTDOOR_TILE = 16;
const outdoorMaskCache = { focus: undefined, rest: undefined };
const outdoorShadeCache = { focus: null, rest: null };
const _shadeTimeKey = { focus: null, rest: null }; // track timeKey to avoid rebuilding shade every frame

function buildOutdoorMask(room) {
  const rd = ROOM_DATA[room];
  if (!rd) return null;
  const dims = ROOM_DIMS[room] || ROOM_DIMS.focus;
  const cols = dims.cols, rows = dims.rows;
  const mask = document.createElement("canvas");
  mask.width = cols * TILE;
  mask.height = rows * TILE;
  const mctx = mask.getContext("2d");
  mctx.fillStyle = "rgba(0,0,0,1)";
  let any = false;
  const outdoor = rd.outdoorMask;
  if (outdoor) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (outdoor[r] && outdoor[r][c]) {
          mctx.fillRect(c * TILE, r * TILE, TILE, TILE);
          any = true;
        }
      }
    }
    return any ? mask : null;
  }
  if (!rd.collision) return null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (rd.collision[r] && rd.collision[r][c] === OUTDOOR_TILE) {
        mctx.fillRect(c * TILE, r * TILE, TILE, TILE);
        any = true;
      }
    }
  }
  return any ? mask : null;
}

function getOutdoorMask(room) {
  if (outdoorMaskCache[room] !== undefined) return outdoorMaskCache[room];
  const mask = buildOutdoorMask(room);
  outdoorMaskCache[room] = mask || null;
  return outdoorMaskCache[room];
}

// (ROOM_TILES removed - sprite coords now come from Tiled GIDs)

function buildFocusMap() {
  const COLS = 32, ROWS = 18; // fallback hardcoded defaults
  const map = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
        row.push(1);
      }
      // Bookshelves along top wall (4 groups)
      else if (r === 1 && c >= 2 && c <= 5) row.push(3);
      else if (r === 1 && c >= 10 && c <= 13) row.push(3);
      else if (r === 1 && c >= 18 && c <= 21) row.push(3);
      else if (r === 1 && c >= 26 && c <= 29) row.push(3);
      // Plants in corners and bottom
      else if (r === 1 && (c === 1 || c === 30)) row.push(4);
      else if (r === 14 && (c === 1 || c === 30)) row.push(4);
      else if (r === 16 && (c === 1 || c === 30)) row.push(4);
      // --- Top desk row (r=3,4) ---
      // 1-person desk (left): desk at c=3, chair at c=4
      else if ((r === 3 || r === 4) && c === 3) row.push(2);
      else if ((r === 3 || r === 4) && c === 4) row.push(7);
      // 2-person desk (mid-left): desk at c=8-9, chair at c=10
      else if ((r === 3 || r === 4) && (c === 8 || c === 9)) row.push(2);
      else if ((r === 3 || r === 4) && c === 10) row.push(7);
      // 4-person desk (center): desk at c=14-17 (r=3), chair at c=14-17 (r=4)
      else if (r === 3 && c >= 14 && c <= 17) row.push(2);
      else if (r === 4 && c >= 14 && c <= 17) row.push(7);
      // 2-person desk (mid-right): desk at c=21-22, chair at c=23
      else if ((r === 3 || r === 4) && (c === 21 || c === 22)) row.push(2);
      else if ((r === 3 || r === 4) && c === 23) row.push(7);
      // 1-person desk (right): desk at c=27, chair at c=28
      else if ((r === 3 || r === 4) && c === 27) row.push(2);
      else if ((r === 3 || r === 4) && c === 28) row.push(7);
      // --- Bottom desk row (r=11,12) ---
      // 1-person desk (left): desk at c=3, chair at c=4
      else if ((r === 11 || r === 12) && c === 3) row.push(2);
      else if ((r === 11 || r === 12) && c === 4) row.push(7);
      // 2-person desk (mid-left): desk at c=8-9, chair at c=10
      else if ((r === 11 || r === 12) && (c === 8 || c === 9)) row.push(2);
      else if ((r === 11 || r === 12) && c === 10) row.push(7);
      // 4-person desk (center): desk at c=14-17 (r=11), chair at c=14-17 (r=12)
      else if (r === 11 && c >= 14 && c <= 17) row.push(2);
      else if (r === 12 && c >= 14 && c <= 17) row.push(7);
      // 2-person desk (mid-right): desk at c=21-22, chair at c=23
      else if ((r === 11 || r === 12) && (c === 21 || c === 22)) row.push(2);
      else if ((r === 11 || r === 12) && c === 23) row.push(7);
      // 1-person desk (right): desk at c=27, chair at c=28
      else if ((r === 11 || r === 12) && c === 27) row.push(2);
      else if ((r === 11 || r === 12) && c === 28) row.push(7);
      // Center rug
      else if (r >= 7 && r <= 8 && c >= 11 && c <= 20) row.push(5);
      // Portal to rest zone (top center)
      else if (r <= 1 && c >= 15 && c <= 16) row.push(8);
      else row.push(0);
    }
    map.push(row);
  }
  return map;
}

function buildRestMap() {
  const COLS = 32, ROWS = 18; // fallback hardcoded defaults
  const map = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
        row.push(1);
      }
      // Coffee machine along top wall
      else if (r === 1 && c >= 2 && c <= 4) row.push(10);
      // Small bookshelf
      else if (r === 1 && c >= 27 && c <= 29) row.push(3);
      // Sofas - left lounge
      else if (r >= 4 && r <= 5 && c >= 2 && c <= 4) row.push(9);
      // Sofas - right lounge
      else if (r >= 4 && r <= 5 && c >= 27 && c <= 29) row.push(9);
      // Center rug (big lounge area)
      else if (r >= 6 && r <= 13 && c >= 8 && c <= 23) row.push(5);
      // Sofas around rug
      else if (r >= 7 && r <= 8 && c >= 4 && c <= 5) row.push(9);
      else if (r >= 11 && r <= 12 && c >= 4 && c <= 5) row.push(9);
      else if (r >= 7 && r <= 8 && c >= 26 && c <= 27) row.push(9);
      else if (r >= 11 && r <= 12 && c >= 26 && c <= 27) row.push(9);
      // Small tables on rug
      else if (r === 9 && c === 12) row.push(2);
      else if (r === 9 && c === 19) row.push(2);
      // Plants
      else if ((r === 1 && c === 1) || (r === 1 && c === COLS - 2)) row.push(4);
      else if ((r === ROWS - 2 && c === 1) || (r === ROWS - 2 && c === COLS - 2)) row.push(4);
      else if (r === 1 && c === 16) row.push(4);
      // Portal back to focus zone (bottom center)
      else if (r === ROWS - 2 && c >= 14 && c <= 17) row.push(8);
      else row.push(0);
    }
    map.push(row);
  }
  return map;
}

// Room data: collision (2D array of types), floorGIDs (flat array), objectLayers (array of flat arrays)
const ROOM_DATA = {
  focus: { collision: buildFocusMap(), floorGIDs: null, wallGIDs: null, rugGIDs: null, objectLayers: [], aboveLayers: [], mapObjects: [], mapObjectsAbove: [], mapObjectsBelow: [] },
  rest:  { collision: buildRestMap(),  floorGIDs: null, wallGIDs: null, rugGIDs: null, objectLayers: [], aboveLayers: [], mapObjects: [], mapObjectsAbove: [], mapObjectsBelow: [] },
};

// Parse 3-layer Tiled JSON into room data
function parseTiledMapLayers(data) {
  const result = {};
  // Find collision firstgid (tileset_game is always first)
  const gameFirstgid = data.tilesets[0].firstgid;

  // Flatten layers (handle group layers that nest tilelayers)
  function visitLayers(layers) {
    for (const layer of layers) {
      if (layer.type === "group" && layer.layers) {
        visitLayers(layer.layers);
        continue;
      }
      if (layer.name === "collision" && layer.data) {
        const map = [];
        for (let r = 0; r < layer.height; r++) {
          const row = [];
          for (let c = 0; c < layer.width; c++) {
            const gid = layer.data[r * layer.width + c];
            row.push(gid === 0 ? 0 : gid - gameFirstgid);
          }
          map.push(row);
        }
        result.collision = map;
        result.cols = layer.width;
        result.rows = layer.height;
      } else if ((layer.name === "outdoor" || layer.name === "outdoor_mask") && layer.data) {
        const mask = [];
        for (let r = 0; r < layer.height; r++) {
          const row = [];
          for (let c = 0; c < layer.width; c++) {
            const gid = layer.data[r * layer.width + c];
            row.push(gid !== 0);
          }
          mask.push(row);
        }
        result.outdoorMask = mask;
      } else if (layer.name === "floor" && layer.data) {
        result.floorGIDs = layer.data;
        result.floorCols = layer.width;
      } else if (layer.name === "wall" && layer.data) {
        result.wallGIDs = layer.data;
        result.wallCols = layer.width;
      } else if (layer.name === "rug" && layer.data) {
        result.rugGIDs = layer.data;
      } else if (layer.type === "tilelayer" && layer.data &&
                 layer.name !== "collision" && layer.name !== "floor" && layer.name !== "wall" && layer.name !== "rug") {
        // "above*" layers render on top of players; everything else ("below*", "objects*") renders below
        const n = layer.name.toLowerCase();
        if (n === "above" || n.startsWith("above")) {
          if (!result.aboveLayers) result.aboveLayers = [];
          result.aboveLayers.push(layer.data);
        } else {
          if (!result.objectLayers) result.objectLayers = [];
          result.objectLayers.push(layer.data);
        }
      } else if (layer.type === "objectgroup" && layer.objects) {
        const layerName = String(layer.name || "").toLowerCase();
        const isAbove = layerName.includes("above");
        for (const obj of layer.objects) {
          const objType = String(obj.type || obj.class || "").toLowerCase();
          if (!obj.gid && objType !== "bulletin_board") continue; // only tile objects (+ bulletin_board rects)
          const props = {};
          if (obj.properties) {
            for (const p of obj.properties) props[p.name] = p.value;
          }
          if (!result.mapObjects) result.mapObjects = [];
          if (!result.mapObjectsAbove) result.mapObjectsAbove = [];
          if (!result.mapObjectsBelow) result.mapObjectsBelow = [];
          const entry = {
            id: obj.id,
            x: obj.x,
            y: obj.gid ? obj.y - obj.height : obj.y, // tile objects: y at bottom; rectangles: y at top
            width: obj.width,
            height: obj.height,
            gid: obj.gid,
            type: obj.type || obj.class || "",
            name: props.name || obj.name || "",
            allowedPlayer: props.allowedPlayer || "",
            layer: layerName,
          };
          result.mapObjects.push(entry);
          if (isAbove) result.mapObjectsAbove.push(entry);
          else result.mapObjectsBelow.push(entry);
        }
      }
    }
  }
  visitLayers(data.layers);

  // Build tileset registry for this map
  if (data.tilesets) {
    result.tilesetRegistry = data.tilesets.map(ts => {
      const name = ts.source ? ts.source.replace(".tsj", "").replace(/.tsx$/, "").replace(/^:\//, "") : "";
      const info = TILESET_INFO[name] || {};
      const objInfo = OBJECT_TILESETS[name];
      return {
        firstgid: ts.firstgid,
        name,
        img: (objInfo ? spriteImages[objInfo.imgKey] : null) || (info.imgKey ? spriteImages[info.imgKey] : null),
        columns: (objInfo ? objInfo.columns : null) || info.columns || 1,
        tileW: objInfo ? objInfo.tileW : 32,
        tileH: objInfo ? objInfo.tileH : 32,
        frameCount: objInfo ? objInfo.frameCount : 0,
        isDoor: objInfo ? !!objInfo.isDoor : false,
        openFrames: objInfo ? (objInfo.openFrames || objInfo.frameCount) : 0,
        openDist: objInfo && objInfo.openDist ? objInfo.openDist * TILE : TILE * 3,
      };
    }).sort((a, b) => a.firstgid - b.firstgid);
  }

  return result;
}

(async function loadTiledMaps() {
  try {
    const [focusRes, restRes] = await Promise.all([
      fetch("/maps/focus.json"),
      fetch("/maps/rest.json"),
    ]);
    if (focusRes.ok && restRes.ok) {
      const focusParsed = parseTiledMapLayers(await focusRes.json());
      const restParsed  = parseTiledMapLayers(await restRes.json());
      if (focusParsed.collision) ROOM_DATA.focus.collision = focusParsed.collision;
      ROOM_DATA.focus.floorGIDs    = focusParsed.floorGIDs;
      ROOM_DATA.focus.floorCols    = focusParsed.floorCols || focusParsed.cols;
      ROOM_DATA.focus.wallGIDs     = focusParsed.wallGIDs;
      ROOM_DATA.focus.wallCols     = focusParsed.wallCols || focusParsed.cols;
      ROOM_DATA.focus.rugGIDs      = focusParsed.rugGIDs || null;
      ROOM_DATA.focus.objectLayers = focusParsed.objectLayers || [];
      ROOM_DATA.focus.aboveLayers  = focusParsed.aboveLayers || [];
      ROOM_DATA.focus.mapObjects   = focusParsed.mapObjects || [];
      ROOM_DATA.focus.mapObjectsAbove = focusParsed.mapObjectsAbove || [];
      ROOM_DATA.focus.mapObjectsBelow = focusParsed.mapObjectsBelow || [];
      ROOM_DATA.focus.outdoorMask  = focusParsed.outdoorMask || null;
      if (focusParsed.tilesetRegistry) roomTilesetRegistry.focus = focusParsed.tilesetRegistry;
      if (focusParsed.cols) ROOM_DIMS.focus = { cols: focusParsed.cols, rows: focusParsed.rows };
      if (restParsed.collision)  ROOM_DATA.rest.collision = restParsed.collision;
      ROOM_DATA.rest.floorGIDs    = restParsed.floorGIDs;
      ROOM_DATA.rest.floorCols    = restParsed.floorCols || restParsed.cols;
      ROOM_DATA.rest.wallGIDs     = restParsed.wallGIDs;
      ROOM_DATA.rest.wallCols     = restParsed.wallCols || restParsed.cols;
      ROOM_DATA.rest.rugGIDs      = restParsed.rugGIDs || null;
      ROOM_DATA.rest.objectLayers = restParsed.objectLayers || [];
      ROOM_DATA.rest.aboveLayers  = restParsed.aboveLayers || [];
      ROOM_DATA.rest.mapObjects   = restParsed.mapObjects || [];
      ROOM_DATA.rest.mapObjectsAbove = restParsed.mapObjectsAbove || [];
      ROOM_DATA.rest.mapObjectsBelow = restParsed.mapObjectsBelow || [];
      ROOM_DATA.rest.outdoorMask  = restParsed.outdoorMask || null;
      if (restParsed.tilesetRegistry) roomTilesetRegistry.rest = restParsed.tilesetRegistry;
      if (restParsed.cols) ROOM_DIMS.rest = { cols: restParsed.cols, rows: restParsed.rows };
      // Invalidate outdoor masks when maps reload
      outdoorMaskCache.focus = undefined;
      outdoorMaskCache.rest = undefined;
      // Set initial active registry
      tilesetRegistry = roomTilesetRegistry[currentRoom] || roomTilesetRegistry.focus;
      // Detect door tiles from collision layers
      if (focusParsed.collision) roomDoors.focus = findDoorsInCollision(focusParsed.collision, focusParsed.cols, focusParsed.rows);
      if (restParsed.collision) roomDoors.rest = findDoorsInCollision(restParsed.collision, restParsed.cols, restParsed.rows);
      console.log("[Maps] Loaded Tiled maps. Focus:", ROOM_DIMS.focus, "Rest:", ROOM_DIMS.rest, "Doors:", roomDoors);
      // Wait for ALL tileset images to finish loading AND decoding
      const allRegs = [...(roomTilesetRegistry.focus || []), ...(roomTilesetRegistry.rest || [])];
      const pending = allRegs.map(ts => ts.img).filter(img => img && !img.complete);
      if (pending.length > 0) {
        await Promise.all(pending.map(img => new Promise(resolve => {
          if (img.complete) { resolve(); return; }
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        })));
      }
      // Decode all images to ensure they're ready for canvas rendering
      // (browser cache can set complete=true before image data is decoded)
      const allImgs = allRegs.map(ts => ts.img).filter(img => img && img.complete);
      await Promise.all(allImgs.map(img =>
        typeof img.decode === "function" ? img.decode().catch(() => {}) : Promise.resolve()
      ));
      allRegs.forEach(ts => { if (ts.img) ts.img._loaded = true; });
      // Promote static tile objects (decorations on furniture) to above pass
      // so they render after the Y-sorted entity/object tile rows
      for (const room of ["focus", "rest"]) {
        const rd = ROOM_DATA[room];
        const reg = roomTilesetRegistry[room];
        if (!reg || !reg.length) continue;
        for (let i = rd.mapObjectsBelow.length - 1; i >= 0; i--) {
          const obj = rd.mapObjectsBelow[i];
          if (!obj.gid) continue;
          for (let j = reg.length - 1; j >= 0; j--) {
            if (obj.gid >= reg[j].firstgid) {
              if (!reg[j].frameCount && !obj.type) {
                rd.mapObjectsBelow.splice(i, 1);
                rd.mapObjectsAbove.push(obj);
              }
              break;
            }
          }
        }
      }
      gameReady = true;
      dismissLoadingOverlay();
    } else {
      // fetch ok failed — show game with fallback rendering
      gameReady = true;
      dismissLoadingOverlay();
    }
  } catch (e) {
    console.warn("[Maps] Using fallback builders:", e);
    gameReady = true;
    dismissLoadingOverlay();
  }
})();

function getCurrentMap() {
  return ROOM_DATA[currentRoom].collision;
}

// --- Tile walkability ---
function isWalkable(tileType, col, row) {
  if (tileType === 12) return isDoorOpenAt(col, row);
  return tileType === 0 || tileType === 5 || tileType === 6 || tileType === 7 || tileType === 8 || tileType === 9 || tileType === 13 || tileType === 14 || tileType === 15 || tileType === 16;
}

// BFS pathfinding on client collision map
function findClientPath(sx, sy, ex, ey) {
  const map = getCurrentMap();
  const cols = getCols(), rows = getRows();
  const sc = Math.max(0, Math.min(cols - 1, Math.floor(sx / TILE)));
  const sr = Math.max(0, Math.min(rows - 1, Math.floor(sy / TILE)));
  const ec = Math.max(0, Math.min(cols - 1, Math.floor(ex / TILE)));
  const er = Math.max(0, Math.min(rows - 1, Math.floor(ey / TILE)));
  if (sr === er && sc === ec) return [{ x: ex, y: ey }];
  if (!isWalkable(map[er][ec], ec, er)) return null;

  const key = (r, c) => r * cols + c;
  const visited = new Set();
  const parent = new Map();
  const queue = [[sr, sc]];
  visited.add(key(sr, sc));

  while (queue.length > 0) {
    const [r, c] = queue.shift();
    if (r === er && c === ec) {
      const path = [];
      let ck = key(er, ec);
      const sk = key(sr, sc);
      while (ck !== sk) {
        const cr = Math.floor(ck / cols);
        const cc = ck % cols;
        path.unshift({ x: cc * TILE + TILE / 2, y: cr * TILE + TILE / 2 });
        ck = parent.get(ck);
      }
      // Add exact destination as final waypoint
      path.push({ x: ex, y: ey });
      return path;
    }
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nk = key(nr, nc);
      if (visited.has(nk)) continue;
      if (!isWalkable(map[nr][nc], nc, nr)) continue;
      visited.add(nk);
      parent.set(nk, key(r, c));
      queue.push([nr, nc]);
    }
  }
  return null;
}

function canMoveTo(x, y) {
  const map = getCurrentMap();
  const half = PLAYER_SIZE / 2 - 2;
  const points = [
    { x: x - half, y: y - half },
    { x: x + half, y: y - half },
    { x: x - half, y: y + half },
    { x: x + half, y: y + half },
  ];
  for (const p of points) {
    const col = Math.floor(p.x / TILE);
    const row = Math.floor(p.y / TILE);
    if (row < 0 || row >= getRows() || col < 0 || col >= getCols()) return false;
    if (!isWalkable(map[row][col], col, row)) return false;
  }
  return true;
}

// --- Unified seat table: room → { "r,c": { dir, dy, [dx], [manual] } } ---
// Position-based (immune to GID changes when map is edited in Tiled).
// dx: horizontal offset (only for manual multi-tile chairs, otherwise auto-centered to 0)
// dy: vertical offset (controls sitting "height")
const SEATS = {
  focus: {
    // 顶部一排3把: up
    "2,26": { dir: "up", dy: -2 },
    "2,29": { dir: "up", dy: -2 },
    "2,35": { dir: "up", dy: -2 },
    "2,38": { dir: "up", dx: -16, dy: -2, manual: true },
    // 中部一排2把: down
    "9,26": { dir: "down", dy: -6 },
    "9,29": { dir: "down", dy: -6 },
    // 右侧纵列4把: right
    "11,36": { dir: "right", dy: -21 },
    "13,36": { dir: "right", dy: -21 },
    "15,36": { dir: "right", dy: -21 },
    "17,36": { dir: "right", dy: -21 },
    // 左下角4把: up
    "12,4":  { dir: "up", dy: -8 },
    "12,10": { dir: "up", dy: -8 },
    "18,4":  { dir: "up", dy: -8 },
    "18,10": { dir: "up", dy: -8 },
    // 中间区域6把 (col=26/29)
    "12,26": { dir: "up", dy: -8 },
    "12,29": { dir: "up", dy: -8 },
    "15,26": { dir: "down", dy: -6 },
    "15,29": { dir: "down", dy: -6 },
    "18,26": { dir: "up", dy: -8 },
    "18,29": { dir: "up", dy: -8 },
  },
  rest: {
    // 左上 zabuton 区
    "3,11": { dir: "right", dy: 8 },
    "3,14": { dir: "left", dy: 8 },
    "4,7":  { dir: "left", dy: -14 },
    "5,7":  { dir: "left", dy: -24 },
    // 左上 futon
    "4,2": { dir: "down" },
    "4,3": { dir: "down" },
    // 右上 sofa 区
    "4,35": { dir: "up", dy: -4 },
    "5,32": { dir: "up", dy: -4 },
    "5,33": { dir: "up", dy: -4 },
    "5,34": { dir: "up", dy: -4 },
    "5,35": { dir: "up", dy: -4 },
    // 上方中间 2格椅子
    "5,25": { dir: "up", dx: 16, dy: 4, manual: true },
    // 右侧中间2把 2格椅子
    "8,36": { dir: "down", dx: -14, dy: 0, manual: true },
    "8,38": { dir: "down", dx: -14, dy: 0, manual: true },
    // 中间 sofa 群
    "12,24": { dir: "down", dy: -8 },
    "12,25": { dir: "down", dy: -8 },
    "12,26": { dir: "down", dy: -8 },
    "12,30": { dir: "down", dy: -8 },
    "12,31": { dir: "down", dy: -8 },
    "12,32": { dir: "down", dy: -4 },
    "13,32": { dir: "down", dy: -16 },
    // 左下角 chair
    "15,2":  { dir: "right", dy: -2 },
    "15,6":  { dir: "left", dy: -2 },
    // 中下方4把 chair
    "15,11": { dir: "right", dy: -2 },
    "15,15": { dir: "left", dy: -2 },
    "17,11": { dir: "right", dy: -2 },
    "17,15": { dir: "left", dy: -2 },
    // 右侧纵列 2格 sofa
    "15,37": { dir: "left", dx: 16, dy: -16, manual: true },
    "16,37": { dir: "left", dx: 16, dy: -16, manual: true },
    "19,37": { dir: "left", dx: 16, dy: -16, manual: true },
    "20,37": { dir: "left", dx: 16, dy: -16, manual: true },
    // 左下角底部 chair
    "18,2": { dir: "up", dy: 0 },
    "18,3": { dir: "up", dy: 4 },
    "18,4": { dir: "up", dy: 4 },
    "20,2": { dir: "down", dy: 0 },
    "20,4": { dir: "down", dy: 0 },
    // 底部中间三把 chair（朝上）
    "20,25": { dir: "up", dy: -8 },
    "20,26": { dir: "up", dy: -8 },
    "20,27": { dir: "up", dy: -8 },
  },
};

// Default dy fallbacks by seat collision type and direction
const SEAT_DY_DEFAULTS = {
  7:  { up: -8,  down: 0,   left: -20, right: -20 }, // chair
  9:  { up: -4,  down: -4,  left: -16, right: -16 }, // sofa
  13: { up: 0,   down: 0,   left: -8,  right: -8  }, // zabuton
  14: { up: 0,   down: 0,   left: 0,   right: 0   }, // futon
  15: { up: 0,   down: 0,   left: 0,   right: 0   }, // yoga_mat
};

function getSeatOffset(room, r, c, direction, seatType) {
  const entry = SEATS[room] && SEATS[room][r + "," + c];
  if (entry) {
    return { dx: entry.manual ? (entry.dx || 0) : 0, dy: entry.dy || 0 };
  }
  const defaults = SEAT_DY_DEFAULTS[seatType] || SEAT_DY_DEFAULTS[7];
  return { dx: 0, dy: defaults[direction] || 0 };
}

// Get visual position adjusted for sit offset (label, fire, gifts use this)
function getPlayerVisualPos(player) {
  if (!player.isSitting) return { x: player.x, y: player.y };
  const room = player.room || currentRoom;
  const dir = player.direction || "down";
  const sType = player.seatType || lookupSeatType(room, player.x, player.y);
  const off = getSeatOffset(room, Math.floor(player.y / TILE), Math.floor(player.x / TILE), dir, sType);
  return { x: player.x + off.dx, y: player.y + off.dy };
}

// Look up seat collision type (7/9/13/14) from position
function lookupSeatType(room, x, y) {
  const rd = ROOM_DATA[room];
  if (!rd || !rd.collision) return 0;
  const r = Math.floor(y / TILE);
  const c = Math.floor(x / TILE);
  const t = rd.collision[r] && rd.collision[r][c];
  return (t === 7 || t === 9 || t === 13 || t === 14 || t === 15) ? t : 0;
}

// Infer chair/sofa facing direction from surrounding tiles.
// Chairs (type 7) face TOWARD adjacent desks — sit at the desk.
// Sofas (type 9) face AWAY from adjacent walls — sit looking into the room.
function inferSeatDirection(map, r, c, rows, cols) {
  const above = r > 0 ? map[r - 1][c] : -1;
  const below = r < rows - 1 ? map[r + 1][c] : -1;
  const left  = c > 0 ? map[r][c - 1] : -1;
  const right = c < cols - 1 ? map[r][c + 1] : -1;
  const t = map[r][c]; // 7=chair, 9=sofa, 13=zabuton
  const isBlk = (v) => v === 1 || v === 2 || v === 3 || v === 11;

  if (t === 7) {
    // Chair: face TOWARD blocking tile (desk/table)
    if (isBlk(above) && !isBlk(below)) return "up";
    if (isBlk(below) && !isBlk(above)) return "down";
    if (isBlk(left) && !isBlk(right)) return "left";
    if (isBlk(right) && !isBlk(left)) return "right";
  } else {
    // Sofa: face AWAY from wall/edge
    const wallAbove = isBlk(above) || above === -1;
    const wallBelow = isBlk(below) || below === -1;
    const wallLeft  = isBlk(left)  || left  === -1;
    const wallRight = isBlk(right) || right === -1;
    if (wallAbove && !wallBelow) return "down";
    if (wallBelow && !wallAbove) return "up";
    if (wallLeft && !wallRight)  return "right";
    if (wallRight && !wallLeft)  return "left";
  }
  return "down"; // default
}

// Check if player is near a sittable tile (type 7=chair, 9=sofa)
function getNearestSittable(x, y) {
  const map = getCurrentMap();
  const cols = getCols(), rows = getRows();
  const pc = Math.floor(x / TILE);
  const pr = Math.floor(y / TILE);
  // Check player's tile and adjacent tiles, return the closest seat
  let best = null, bestDist = Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = pr + dr, c = pc + dc;
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
      const t = map[r][c];
      if (t === 7 || t === 9 || t === 13 || t === 14 || t === 15) {
        const cx = c * TILE + TILE / 2;
        const cy = r * TILE + TILE / 2;
        const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        if (dist < TILE * 1.2 && dist < bestDist) {
          bestDist = dist;
          const entry = SEATS[currentRoom] && SEATS[currentRoom][r + "," + c];
          const dir = (entry && entry.dir) || inferSeatDirection(map, r, c, rows, cols);
          best = { col: c, row: r, x: cx, y: cy, direction: dir, seatType: t };
        }
      }
    }
  }
  return best;
}

// Stand up: clear sitting state and snap to tile center
function standUp() {
  if (!localPlayer) return;
  localSitting = false;
  localPlayer.isSitting = false;
  localPlayer.seatType = 0;
  localPlayer.x = Math.floor(localPlayer.x / TILE) * TILE + TILE / 2;
  localPlayer.y = Math.floor(localPlayer.y / TILE) * TILE + TILE / 2;
  emitPlayerSit(false);
  // playerSit already broadcasts position; update lastSent to avoid redundant playerMove
  lastSentX = localPlayer.x;
  lastSentY = localPlayer.y;
}

function emitPlayerSit(sitting) {
  if (!localPlayer) return;
  socket.emit("playerSit", { sitting, x: localPlayer.x, y: localPlayer.y, direction: localPlayer.direction });
  if (sitting) {
    const x = Math.round(localPlayer.x);
    const y = Math.round(localPlayer.y);
    console.log(`[SIT] local position: ${x},${y} (room: ${currentRoom})`);
  }
}

function isOnPortal(x, y) {
  const map = getCurrentMap();
  if (!map) return false;
  const col = Math.floor(x / TILE);
  const row = Math.floor(y / TILE);
  if (row < 0 || row >= map.length || col < 0 || !map[row] || col >= map[row].length) return false;
  return map[row][col] === 8;
}

// ============================================================
// DRAWING
// ============================================================

// --- Offscreen canvas cache for static tile layers ---
const _tileCache = { focus: null, rest: null, aboveFocus: null, aboveRest: null, groundFocus: null, groundRest: null, objFocus: null, objRest: null, objWalkFocus: null, objWalkRest: null, room: null };

function invalidateTileCache() {
  _tileCache.focus = null;
  _tileCache.rest = null;
  _tileCache.aboveFocus = null;
  _tileCache.aboveRest = null;
  _tileCache.groundFocus = null;
  _tileCache.groundRest = null;
  _tileCache.objFocus = null;
  _tileCache.objRest = null;
  _tileCache.objWalkFocus = null;
  _tileCache.objWalkRest = null;
}

function _buildLayerCache(room, layers, floorGIDs, wallGIDs, skipBlankCheck, extraGIDs, collisionFilter) {
  const reg = roomTilesetRegistry[room];
  if (!reg || !reg.length) return null;
  // Check all tileset images are loaded
  for (const ts of reg) { if (ts.img && !ts.img._loaded) return null; }
  const rd = ROOM_DATA[room];
  const dims = ROOM_DIMS[room] || ROOM_DIMS.focus;
  const cols = dims.cols, rows = dims.rows;
  const w = cols * TILE, h = rows * TILE;
  const offCanvas = document.createElement("canvas");
  offCanvas.width = w; offCanvas.height = h;
  const offCtx = offCanvas.getContext("2d");
  offCtx.imageSmoothingEnabled = false;
  // Temporarily swap ctx so drawTileByGID draws to offscreen
  const prevCtx = ctx;
  const prevReg = tilesetRegistry;
  ctx = offCtx;
  tilesetRegistry = reg;
  const collision = collisionFilter ? rd.collision : null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (collision && !collisionFilter(collision[r] ? collision[r][c] : 0)) continue;
      const x = c * TILE, y = r * TILE, idx = r * cols + c;
      if (floorGIDs && floorGIDs[idx]) drawTileByGID(floorGIDs[idx], x, y);
      if (extraGIDs && extraGIDs[idx]) drawTileByGID(extraGIDs[idx], x, y);
      if (wallGIDs && wallGIDs[idx]) drawTileByGID(wallGIDs[idx], x, y);
      if (layers) {
        for (const ld of layers) { if (ld[idx]) drawTileByGID(ld[idx], x, y); }
      }
    }
  }
  ctx = prevCtx;
  tilesetRegistry = prevReg;
  // Verify cache isn't blank (safety net for undecoded images)
  if (!skipBlankCheck) {
    try {
      const mid = Math.min(cols, rows) > 2 ? TILE * 2 + TILE / 2 : TILE / 2;
      const px = offCtx.getImageData(mid, mid, 1, 1).data;
      if (px[3] === 0) return null;
    } catch (e) {}
  }
  return offCanvas;
}

function getTileCache(room) {
  const key = room;
  if (_tileCache[key]) return _tileCache[key];
  const rd = ROOM_DATA[room];
  const cached = _buildLayerCache(room, rd.objectLayers, rd.floorGIDs, rd.wallGIDs);
  if (cached) _tileCache[key] = cached;
  return cached;
}

function getAboveCache(room) {
  const key = "above" + room.charAt(0).toUpperCase() + room.slice(1);
  if (_tileCache[key]) return _tileCache[key];
  const rd = ROOM_DATA[room];
  if (!rd.aboveLayers || !rd.aboveLayers.length) return null;
  const cached = _buildLayerCache(room, rd.aboveLayers, null, null, true);
  if (cached) _tileCache[key] = cached;
  return cached;
}

function getGroundCache(room) {
  const key = "ground" + room.charAt(0).toUpperCase() + room.slice(1);
  if (_tileCache[key]) return _tileCache[key];
  const rd = ROOM_DATA[room];
  // Ground = floor + rug (walls are Y-sorted with entities)
  const cached = _buildLayerCache(room, null, rd.floorGIDs, null, true, rd.rugGIDs);
  if (cached) _tileCache[key] = cached;
  return cached;
}

// Walkable tile positions: object tiles here are always below entities (chairs, sofas, etc.)
const WALKABLE_TILES = new Set([0, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16]);
const _isWalkable = ct => WALKABLE_TILES.has(ct);
const _isBlocking = ct => !WALKABLE_TILES.has(ct);

function getWalkableObjCache(room) {
  const key = "objWalk" + room.charAt(0).toUpperCase() + room.slice(1);
  if (_tileCache[key]) return _tileCache[key];
  const reg = roomTilesetRegistry[room];
  if (!reg || !reg.length) return null;
  for (const ts of reg) { if (ts.img && !ts.img._loaded) return null; }
  const rd = ROOM_DATA[room];
  if (!rd.objectLayers || !rd.objectLayers.length) return null;
  const cached = _buildLayerCache(room, rd.objectLayers, null, null, true, null, _isWalkable);
  if (cached) _tileCache[key] = cached;
  return cached;
}

function getObjectCache(room) {
  const key = "obj" + room.charAt(0).toUpperCase() + room.slice(1);
  if (_tileCache[key]) return _tileCache[key];
  const reg = roomTilesetRegistry[room];
  if (!reg || !reg.length) return null;
  for (const ts of reg) { if (ts.img && !ts.img._loaded) return null; }
  const rd = ROOM_DATA[room];
  // Blocking tiles: wall + object layers at non-walkable positions (Y-sorted)
  const cached = _buildLayerCache(room, rd.objectLayers, null, rd.wallGIDs, true, null, _isBlocking);
  if (cached) _tileCache[key] = cached;
  return cached;
}

function drawRoom() {
  const rd = ROOM_DATA[currentRoom];
  const collision = rd.collision;
  const colors = currentRoom === "focus" ? FOCUS_COLORS : REST_COLORS;
  // Switch to this room's tileset registry
  tilesetRegistry = roomTilesetRegistry[currentRoom] || [];
  const hasSprites = tilesetRegistry.length > 0;

  // Try ground-only cache first (object layers drawn separately for Y-sorting)
  const groundCached = hasSprites ? getGroundCache(currentRoom) : null;
  if (groundCached) {
    ctx.drawImage(groundCached, 0, 0);
  } else {
    // Per-tile fallback rendering (no cache yet or no sprites)
    const curCols = getCols();
    const curRows = getRows();
    for (let r = 0; r < curRows; r++) {
      for (let c = 0; c < curCols; c++) {
        const x = c * TILE;
        const y = r * TILE;
        const idx = r * curCols + c;
        const ct = collision[r][c];
        const onDoor = isDoorTile(c, r);

        let floorDrawn = false;
        if (!onDoor) {
          if (hasSprites && rd.floorGIDs) {
            floorDrawn = drawTileByGID(rd.floorGIDs[idx], x, y);
          }
          if (!floorDrawn && !hasSprites) {
            {
              ctx.fillStyle = colors.floor;
              ctx.fillRect(x, y, TILE, TILE);
              if (ct === 0 || ct === 7 || ct === 8) {
                const hash = (r * 31 + c * 17) % 8;
                if (hash < 3) {
                  ctx.fillStyle = colors.floorDark;
                  ctx.fillRect(x, y, TILE, TILE);
                }
                ctx.fillStyle = "rgba(0,0,0,0.07)";
                ctx.fillRect(x, y, TILE, 1);
                ctx.fillRect(x, y, 1, TILE);
              }
            }
          }
        }

        if (!onDoor && hasSprites && rd.wallGIDs) {
          drawTileByGID(rd.wallGIDs[idx], x, y);
        }

        let objDrawn = false;
        if (!onDoor && hasSprites && rd.objectLayers.length) {
          for (const layerData of rd.objectLayers) {
            if (layerData[idx]) {
              if (drawTileByGID(layerData[idx], x, y)) objDrawn = true;
            }
          }
        }

        if (hasSprites) {
          // if (ct === 11) drawWindowTint(x, y);
        } else {
          switch (ct) {
            case 1: {
              ctx.fillStyle = colors.wall;
              ctx.fillRect(x, y, TILE, TILE);
              ctx.fillStyle = colors.wallDark;
              ctx.fillRect(x, y + 15, TILE, 1);
              if ((r + c) % 2 === 0) {
                ctx.fillRect(x + 14, y, 1, 15);
              } else {
                ctx.fillRect(x + 14, y + 16, 1, 16);
              }
              ctx.fillStyle = colors.wallTop;
              ctx.fillRect(x, y, TILE, 2);
              ctx.fillStyle = "rgba(0,0,0,0.12)";
              ctx.fillRect(x, y + TILE - 2, TILE, 2);
              if (r === 0 && c > 1 && c < curCols - 2 && c % 4 === 0) {
                drawWindow(x, y);
              }
              break;
            }
            case 2: {
              ctx.fillStyle = colors.desk;
              ctx.fillRect(x + 2, y + 4, TILE - 4, TILE - 6);
              ctx.fillStyle = colors.deskTop;
              ctx.fillRect(x + 2, y + 4, TILE - 4, 6);
              ctx.fillStyle = "#333";
              ctx.fillRect(x + 8, y + 10, 16, 12);
              const screenFlicker = 0.85 + 0.15 * Math.sin(Date.now() / 2000 + c * 3.7);
              const base = currentRoom === "focus" ? [136, 204, 255] : [136, 221, 136];
              ctx.fillStyle = `rgb(${Math.floor(base[0]*screenFlicker)},${Math.floor(base[1]*screenFlicker)},${Math.floor(base[2]*screenFlicker)})`;
              ctx.fillRect(x + 9, y + 11, 14, 10);
              break;
            }
            case 3:
              ctx.fillStyle = colors.bookshelf;
              ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
              for (let s = 0; s < 3; s++) {
                const sy = y + 6 + s * 9;
                ctx.fillStyle = "#5a4020";
                ctx.fillRect(x + 3, sy + 7, TILE - 6, 2);
                for (let b = 0; b < 4; b++) {
                  ctx.fillStyle = colors.bookColors[(c + s + b) % colors.bookColors.length];
                  ctx.fillRect(x + 5 + b * 6, sy, 5, 7);
                }
              }
              break;
            case 4:
              ctx.fillStyle = colors.plantPot;
              ctx.fillRect(x + 10, y + 20, 12, 10);
              ctx.fillStyle = colors.plant;
              ctx.beginPath();
              ctx.arc(x + 16, y + 14, 10, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = "#4a8858";
              ctx.beginPath();
              ctx.arc(x + 12, y + 11, 6, 0, Math.PI * 2);
              ctx.fill();
              ctx.beginPath();
              ctx.arc(x + 20, y + 12, 5, 0, Math.PI * 2);
              ctx.fill();
              break;
            case 5:
              ctx.fillStyle = colors.rug;
              ctx.fillRect(x, y, TILE, TILE);
              ctx.fillStyle = colors.rugAlt || colors.rug;
              if ((r + c) % 2 === 0) {
                ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
              }
              break;
            case 7:
              ctx.fillStyle = colors.chair;
              ctx.fillRect(x + 6, y + 6, 20, 20);
              ctx.fillStyle = "#7ab87a";
              ctx.fillRect(x + 8, y + 8, 16, 16);
              break;
            case 8:
              drawPortal(x, y, colors);
              break;
            case 9:
              ctx.fillStyle = colors.sofa || "#7a3868";
              ctx.fillRect(x + 2, y + 4, TILE - 4, TILE - 6);
              ctx.fillStyle = colors.sofaTop || "#8a4878";
              ctx.fillRect(x + 4, y + 6, TILE - 8, TILE - 10);
              ctx.fillStyle = "#d8a0b8";
              ctx.fillRect(x + 8, y + 10, 16, 10);
              break;
            case 10: {
              ctx.fillStyle = colors.coffeeMachine || "#484848";
              ctx.fillRect(x + 4, y + 4, TILE - 8, TILE - 6);
              ctx.fillStyle = colors.coffeeTop || "#5a5a5a";
              ctx.fillRect(x + 4, y + 4, TILE - 8, 8);
              ctx.fillStyle = "#fff";
              ctx.fillRect(x + 12, y + 16, 8, 8);
              const st = Date.now() / 500;
              ctx.lineWidth = 1;
              ctx.strokeStyle = "rgba(255,255,255,0.4)";
              ctx.beginPath();
              ctx.moveTo(x + 15, y + 14);
              ctx.quadraticCurveTo(x + 13 + Math.sin(st) * 3, y + 8, x + 15 + Math.sin(st * 0.6) * 2, y + 2);
              ctx.stroke();
              ctx.strokeStyle = "rgba(255,255,255,0.2)";
              ctx.beginPath();
              ctx.moveTo(x + 17, y + 14);
              ctx.quadraticCurveTo(x + 19 + Math.sin(st + 2) * 2.5, y + 9, x + 17 + Math.sin(st * 0.8 + 1) * 1.5, y + 4);
              ctx.stroke();
              break;
            }
            case 12: {
              const doorOpen = isDoorOpenAt(c, r);
              ctx.fillStyle = doorOpen ? "rgba(180,220,240,0.3)" : "rgba(180,220,240,0.7)";
              ctx.fillRect(x + 2, y, TILE - 4, TILE);
              ctx.strokeStyle = "#8ab0c0";
              ctx.lineWidth = 1;
              ctx.strokeRect(x + 2, y, TILE - 4, TILE);
              break;
            }
          }
        }
      }
    }
  }

  // Dynamic overlays on top of cached tiles (window tint changes with time-of-day)
  if (groundCached && hasSprites) {
    const curCols = getCols();
    const curRows = getRows();
    const collision = rd.collision;
    for (let r = 0; r < curRows; r++) {
      for (let c = 0; c < curCols; c++) {
        // if (collision[r][c] === 11) drawWindowTint(c * TILE, r * TILE);
        if (collision[r][c] === 8) drawPortalLabel(c * TILE, r * TILE, colors);
      }
    }
  }

  // --- Draw animated doors on top of all tiles ---
  const doors = roomDoors[currentRoom];
  if (doors && doors.length && doorSlidingImg._loaded) {
    for (const d of doors) {
      ctx.drawImage(doorSlidingImg, d.frame * DOOR_FRAME_W, 0, DOOR_FRAME_W, DOOR_FRAME_H,
                    d.x, d.y, DOOR_FRAME_W, DOOR_FRAME_H);
    }
  }
}

// Draw "above*" layers on top of players
function drawAboveLayers() {
  const rd = ROOM_DATA[currentRoom];
  if (!rd.aboveLayers || !rd.aboveLayers.length) return;
  const hasSprites = tilesetRegistry.length > 0;
  if (!hasSprites) return;
  const cached = getAboveCache(currentRoom);
  if (cached) {
    ctx.drawImage(cached, 0, 0);
    return;
  }
  const curCols = getCols();
  const curRows = getRows();
  for (let r = 0; r < curRows; r++) {
    for (let c = 0; c < curCols; c++) {
      const idx = r * curCols + c;
      for (const layerData of rd.aboveLayers) {
        if (layerData[idx]) {
          drawTileByGID(layerData[idx], c * TILE, r * TILE);
        }
      }
    }
  }
}

// Window light spills on floor (called after drawRoom)
function drawWindowLightSpills() {
  const tv = TIME_VISUALS[cachedTimeKey];
  if (!tv.windowGlow) return;

  const map = getCurrentMap();
  for (let c = 4; c < getCols() - 2; c += 4) {
    if (map[0][c] !== 1 && map[0][c] !== 11) continue;
    const x = c * TILE;
    const spillW = TILE + 8;
    const spillH = TILE * 2.5;
    const spillX = x + TILE / 2 - spillW / 2;
    const spillY = TILE;

    const spillGrad = ctx.createLinearGradient(spillX, spillY, spillX, spillY + spillH);
    spillGrad.addColorStop(0, tv.windowGlow);
    spillGrad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = spillGrad;
    ctx.fillRect(spillX, spillY, spillW, spillH);
  }
}

// Dust motes floating in window light
const dustMotes = [];
const MAX_DUST = 15;

function updateAndDrawDustMotes() {
  if (cachedTimeKey === "night") return;

  if (dustMotes.length < MAX_DUST && Math.random() < 0.02) {
    const wp = WINDOW_POSITIONS[Math.floor(Math.random() * WINDOW_POSITIONS.length)];
    dustMotes.push({
      x: wp.x + (Math.random() - 0.5) * TILE * 1.5,
      y: TILE + Math.random() * TILE * 3,
      vx: (Math.random() - 0.5) * 0.08,
      vy: -0.05 - Math.random() * 0.05,
      life: 200 + Math.random() * 200,
      size: 1,
    });
  }

  for (let i = dustMotes.length - 1; i >= 0; i--) {
    const d = dustMotes[i];
    d.x += d.vx + Math.sin(Date.now() / 3000 + i) * 0.02;
    d.y += d.vy;
    d.life--;
    if (d.life <= 0) { dustMotes.splice(i, 1); continue; }
    const alpha = Math.min(d.life / 60, 1) * (cachedTimeKey === "morning" ? 0.4 : 0.2);
    ctx.fillStyle = `rgba(255,255,240,${alpha})`;
    ctx.fillRect(Math.round(d.x), Math.round(d.y), d.size, d.size);
  }
}

// Time-aware window tint overlay (applied on top of pixel-art window tiles)
function drawWindowTint(x, y) {
  const tv = TIME_VISUALS[cachedTimeKey];
  ctx.fillStyle = tv.windowGlass;
  ctx.globalAlpha = 0.25;
  ctx.fillRect(x, y, TILE, TILE);
  ctx.globalAlpha = 1;

  // Stars at night
  if (tv.starCount > 0) {
    ctx.fillStyle = "#fff";
    const seed = x * 7 + y * 13;
    for (let s = 0; s < tv.starCount; s++) {
      const sx = x + 4 + ((seed * (s + 1) * 31) % (TILE - 8));
      const sy = y + 4 + ((seed * (s + 1) * 17) % (TILE - 8));
      const twinkle = 0.4 + 0.6 * Math.sin(Date.now() / 1000 + s * 2.1);
      ctx.globalAlpha = twinkle;
      ctx.fillRect(sx, sy, 1, 1);
    }
    ctx.globalAlpha = 1;
  }
}

// Programmatic window (fallback when no sprites)
function drawWindow(x, y) {
  const tv = TIME_VISUALS[cachedTimeKey];
  ctx.fillStyle = "#8a7050";
  ctx.fillRect(x + 3, y + 5, TILE - 6, TILE - 8);
  const skyGrad = ctx.createLinearGradient(x + 5, y + 7, x + 5, y + 7 + TILE - 12);
  tv.skyColors.forEach((color, i) => {
    skyGrad.addColorStop(i / (tv.skyColors.length - 1), color);
  });
  ctx.fillStyle = skyGrad;
  ctx.fillRect(x + 5, y + 7, TILE - 10, TILE - 12);
  if (tv.starCount > 0) {
    ctx.fillStyle = "#fff";
    const seed = x * 7 + y * 13;
    for (let s = 0; s < tv.starCount; s++) {
      const sx = x + 6 + ((seed * (s + 1) * 31) % (TILE - 12));
      const sy = y + 8 + ((seed * (s + 1) * 17) % (TILE - 14));
      const twinkle = 0.4 + 0.6 * Math.sin(Date.now() / 1000 + s * 2.1);
      ctx.globalAlpha = twinkle;
      ctx.fillRect(sx, sy, 1, 1);
    }
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = tv.windowGlass;
  ctx.globalAlpha = 0.35;
  ctx.fillRect(x + 5, y + 7, TILE - 10, TILE - 12);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#8a7050";
  ctx.fillRect(x + TILE / 2 - 1, y + 7, 2, TILE - 12);
  ctx.fillRect(x + 5, y + TILE / 2 - 1, TILE - 10, 2);
  ctx.fillStyle = "#a08860";
  ctx.fillRect(x + 3, y + 5, TILE - 6, 1);
}

// Portal label only (no color overlay, for sprite mode)
let portalLabelDrawnThisFrame = false;
function drawPortalLabel(x, y, colors) {
  if (portalLabelDrawnThisFrame) return;
  if (currentRoom !== "focus") return;
  portalLabelDrawnThisFrame = true;

  const map = getCurrentMap();
  let minC = getCols(), maxC = 0, portalRow = 0;
  for (let r = 0; r < getRows(); r++) {
    for (let c = 0; c < getCols(); c++) {
      if (map[r][c] === 8) {
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        portalRow = r;
      }
    }
  }
  const px = minC * TILE;
  const py = portalRow * TILE;
  const pw = (maxC - minC + 1) * TILE;

  const label = currentRoom === "focus" ? t("portalToLounge") : t("portalToFocus");
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ps = gameToScreen(px + pw / 2, py - 10);
  ctx.font = f(16, true);
  ctx.letterSpacing = "0.32px";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const textWidth = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(ps.x - textWidth / 2 - 6, ps.y - 8, textWidth + 12, 16);
  ctx.fillStyle = "#fff";
  ctx.globalAlpha = 0.8;
  ctx.fillText(label, ps.x, ps.y);
  ctx.restore();
}

// Animated portal - drawn once across all portal tiles (fallback, no sprites)
let portalAnim = 0;
let portalDrawnThisFrame = false;

function drawPortal(x, y, colors) {
  // Only draw the full portal effect once per frame (on first portal tile)
  if (portalDrawnThisFrame) return;
  portalDrawnThisFrame = true;

  portalAnim += 0.015;
  const breathe = Math.sin(portalAnim) * 0.5 + 0.5;

  // Find all portal tiles to get full bounds
  const map = getCurrentMap();
  let minC = getCols(), maxC = 0, portalRow = 0;
  for (let r = 0; r < getRows(); r++) {
    for (let c = 0; c < getCols(); c++) {
      if (map[r][c] === 8) {
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        portalRow = r;
      }
    }
  }

  const px = minC * TILE;
  const py = portalRow * TILE;
  const pw = (maxC - minC + 1) * TILE;
  const ph = TILE;

  // Soft glow
  ctx.fillStyle = colors.portalGlow;
  ctx.globalAlpha = 0.08 + breathe * 0.06;
  ctx.fillRect(px - 6, py - 6, pw + 12, ph + 12);
  ctx.globalAlpha = 1;

  // Portal arch (subtle)
  ctx.fillStyle = colors.portal;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(px + 4, py + ph);
  ctx.lineTo(px + 4, py + 10);
  ctx.quadraticCurveTo(px + pw / 2, py - 8, px + pw - 4, py + 10);
  ctx.lineTo(px + pw - 4, py + ph);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  // Inner fill - gentle
  ctx.fillStyle = colors.portalGlow;
  ctx.globalAlpha = 0.2 + breathe * 0.15;
  ctx.beginPath();
  ctx.moveTo(px + 10, py + ph);
  ctx.lineTo(px + 10, py + 14);
  ctx.quadraticCurveTo(px + pw / 2, py - 2, px + pw - 10, py + 14);
  ctx.lineTo(px + pw - 10, py + ph);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  // Keep portal text only in Focus room.
  if (currentRoom === "focus") {
    const label = t("portalToLounge");
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ps = gameToScreen(px + pw / 2, py - 10);
    ctx.font = f(16, true);
    ctx.letterSpacing = "0.32px";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const textWidth = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(ps.x - textWidth / 2 - 6, ps.y - 8, textWidth + 12, 16);
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = 0.8;
    ctx.fillText(label, ps.x, ps.y);
    ctx.restore();
  }
}

// ============================================================
// PLAYER RENDERING
// ============================================================

const STATUS_EMOJI = {
  studying: "\u{1F4D6}",
  working: "\u{1F4BB}",
  reading: "\u{1F4DA}",
  resting: "\u{2615}",
  coding: "\u{1F4BB}",
  chatting: "\u{1F4AC}",
  listening: "\u{1F3B5}",
  watching: "\u{1F3AC}",
  napping: "\u{1F634}",
  snacking: "\u{1F36A}",
  browsing: "\u{1F4F1}",
  focusing: "\u{1F525}",
  daydreaming: "\u{1F4AD}",
  writing: "\u{270F}\u{FE0F}",
  creating: "\u{1F3A8}",
  exercising: "\u{1F3CB}\u{FE0F}",
};

const BODY_COLORS = [
  "#e94560", "#533483", "#0f3460", "#53d769",
  "#f5a623", "#e91e8c", "#1ecbe1", "#ff6b35",
];

function hashColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return BODY_COLORS[Math.abs(hash) % BODY_COLORS.length];
}

function hashCharacter(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return { preset: (Math.abs(hash) % PREMADE_COUNT) + 1 };
}

// Lighten a hex color for use on dark backgrounds
function lightenColor(hex, amount) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  const lr = Math.min(255, r + (255 - r) * amount);
  const lg = Math.min(255, g + (255 - g) * amount);
  const lb = Math.min(255, b + (255 - b) * amount);
  return `rgb(${Math.round(lr)},${Math.round(lg)},${Math.round(lb)})`;
}

// Sprite animation direction offsets (each direction = 6 frames in a 24-col sheet)
const SPRITE_DIR_OFFSET = { right: 0, up: 6, left: 12, down: 18 };
const SPRITE_IDLE_MS = 600; // ms per idle frame (~3.6s breathing cycle)
const SPRITE_RUN_MS  = 100; // ms per run frame

function getPlayerAnimState(player) {
  if (!player._animState) {
    player._animState = {
      prevX: player.x,
      prevY: player.y,
      moving: false,
      frame: 0,
      lastFrameTime: Date.now(),
    };
  }
  const st = player._animState;
  const now = Date.now();
  const dx = player.x - st.prevX;
  const dy = player.y - st.prevY;
  st.moving = !player.isSitting && (dx !== 0 || dy !== 0);
  st.prevX = player.x;
  st.prevY = player.y;

  const maxFrames = (player.isSitting && player.seatType === 15) ? 14 : 6;
  const interval = st.moving ? SPRITE_RUN_MS : SPRITE_IDLE_MS;
  if (now - st.lastFrameTime >= interval) {
    st.frame = (st.frame + 1) % maxFrames;
    st.lastFrameTime = now;
  }
  return st;
}

function drawPlayerBody(player, isLocal) {
  const { x, y } = player;

  // Shadow (skip when sitting)
  if (!player.isSitting) {
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(x, y + 16, 12, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Get character spritesheet (premade or composite)
  const config = player.character || hashCharacter(player.id);
  const sheet = getCharacterSheet(config);
  if (!sheet || !sheet._loaded) return;

  const animState = getPlayerAnimState(player);
  const dir = player.direction || "down";

  // Sit sprite layout differs from walk/idle: only right (cols 0-5) & left (cols 6-11).
  // For up/down we fall back to idle (back/front view at this scale looks fine).
  // Type 13 (zabuton) uses sit2 (cross-legged) animation.
  let row, sitCol;
  if (player.isSitting) {
    const st = player.seatType || lookupSeatType(player.room || currentRoom, x, y);
    if (st === 15) {
      // Yoga mat: exercise animation (row 11, 14 frames per direction: right/up/left/down)
      const EXERCISE_DIR_OFFSET = { right: 0, up: 14, left: 28, down: 42 };
      row = ANIM_ROWS.exercise;
      sitCol = (EXERCISE_DIR_OFFSET[dir] || 0) + animState.frame;
    } else if (st === 14) {
      // Futon: sleep animation (row 3, cols 0-5, single direction)
      row = ANIM_ROWS.sleep;
      sitCol = animState.frame;
    } else if (dir === "right" || dir === "left") {
      row = ANIM_ROWS.sit;
      sitCol = (dir === "right" ? 0 : 6) + animState.frame;
    } else {
      row = ANIM_ROWS.idle;
      sitCol = (SPRITE_DIR_OFFSET[dir] || 0) + animState.frame;
    }
  } else {
    row = animState.moving ? ANIM_ROWS.walk : ANIM_ROWS.idle;
    sitCol = (SPRITE_DIR_OFFSET[dir] || 0) + animState.frame;
  }

  // Each frame is 32x64 (head + body = 2 rows of 32px cells)
  const sx = sitCol * 32;
  const sy = row * 64;
  // Sitting sprites: use per-seat offset from position table
  let sitDx = 0, sitDy = 0;
  if (player.isSitting) {
    const room = player.room || currentRoom;
    const seatR = Math.floor(y / TILE);
    const seatC = Math.floor(x / TILE);
    const sType = player.seatType || lookupSeatType(room, x, y);
    const off = getSeatOffset(room, seatR, seatC, dir, sType);
    sitDx = off.dx;
    sitDy = off.dy;
  }
  // 朝上坐: 裁掉底部腿部，加黑线模拟椅子边缘
  const sitUpCrop = player.isSitting && (dir === "up") && player.seatType !== 14 && player.seatType !== 15 ? 5 : 0;
  const drawH = 64 - sitUpCrop;
  ctx.drawImage(sheet, sx, sy, 32, drawH, x - 16 + sitDx, y - 46 + sitDy, 32, drawH);
  if (sitUpCrop > 0) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - 16 + sitDx + 8, y - 46 + sitDy + drawH, 16, 2);
  }
}

// Convert game coords to screen coords (bypassing canvas transform)
function gameToScreen(gx, gy) {
  // Use the same quantized scale (gs) as the game transform to stay aligned with sprites
  const gs = Math.round(gameScale * dpr * TILE) / TILE;
  return {
    x: Math.round((gx - cameraX) * gs / dpr),
    y: Math.round((gy - cameraY) * gs / dpr),
  };
}

function drawPlayerLabel(player) {
  const { name, status } = player;
  const isLocal = player.id === myId;
  const followed = !isLocal && (player._userId ? isFollowed(player._userId) : isFollowed(player.id));
  if (isLocal && !showNamesFilter.self) return;
  if (followed && !showNamesFilter.followed) return;
  if (!isLocal && !followed && !showNamesFilter.others) return;

  const vp = getPlayerVisualPos(player);

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const nameText = name || "???";
  const px = 8, py = 4;

  // Name label
  ctx.font = f(16, true);
  ctx.letterSpacing = "0.32px";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const tm = ctx.measureText(nameText);
  const nameWidth = Math.ceil(tm.width);
  const s = gameToScreen(vp.x, vp.y);
  const lw = nameWidth + px * 2;
  const lh = 16 + py * 2;
  const lx = Math.round(s.x - lw / 2);
  const ly = Math.round(s.y - 52 * gameScale - py);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.roundRect(lx, ly, lw, lh, 4);
  ctx.fill();

  // Birthday month — diagonal corner glow
  const isBirthdayMonth = player.birthMonth && player.birthMonth === (new Date().getMonth() + 1);
  if (isBirthdayMonth) {
    const grad = ctx.createLinearGradient(lx, ly, lx + lw, ly + lh);
    grad.addColorStop(0, "#F472B6");
    grad.addColorStop(0.5, "#A78BFA");
    grad.addColorStop(1, "#38BDF8");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(lx - 0.5, ly - 0.5, lw + 1, lh + 1, 5);
    ctx.stroke();
  }

  // Vertically center text using actual glyph metrics (fixes CJK offset)
  const textY = ly + (lh + tm.actualBoundingBoxAscent - tm.actualBoundingBoxDescent) / 2;
  ctx.fillStyle = isLocal ? NAME_COLORS.self : (followed ? NAME_COLORS.followed : NAME_COLORS.others);
  ctx.fillText(nameText, s.x, textY);

  // Status emoji above name label (manually centered to avoid glyph offset)
  const emojiY = ly - 4;
  ctx.font = f(16, false);
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  if (player.isFocusing) {
    const emojiStr = STATUS_EMOJI[player.focusCategory] || STATUS_EMOJI[status] || "";
    const ew = ctx.measureText(emojiStr).width;
    ctx.fillText(emojiStr, s.x - ew / 2, emojiY);
  } else if (player.id === myId && (autoWalking || catDragPhase === "approach")) {
    ctx.fillStyle = "#fff";
    const walkStr = catDragPhase !== "none" ? "\u{1F431}..." : t("grabCoffee");
    const ew = ctx.measureText(walkStr).width;
    ctx.fillText(walkStr, s.x - ew / 2, emojiY);
  } else if (player.id === myId && emojiSuppressUntil && Date.now() < emojiSuppressUntil) {
    // suppressed
  } else {
    const emojiStr = STATUS_EMOJI[status] || "";
    const ew = ctx.measureText(emojiStr).width;
    ctx.fillText(emojiStr, s.x - ew / 2, emojiY);
  }
  ctx.restore();
}

function drawChatBubble(player) {
  const bubble = chatBubbles[player.id];
  if (!bubble) return;
  const elapsed = Date.now() - bubble.time;
  if (elapsed > BUBBLE_DURATION) {
    delete chatBubbles[player.id];
    return;
  }

  // Nearby-scoped bubbles only visible when local player is within range
  if (bubble.scope === "nearby" && localPlayer) {
    const dx = Math.abs(player.x - localPlayer.x);
    const dy = Math.abs(player.y - localPlayer.y);
    if (dx > 128 || dy > 128) return;
  }

  const alpha = elapsed > BUBBLE_DURATION - 1000 ? (BUBBLE_DURATION - elapsed) / 1000 : 1;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.font = f(14, false);
  ctx.letterSpacing = "0.32px";

  // Measure and truncate to max width
  const maxW = 160;
  const padX = 8, padY = 5;
  let displayText = bubble.text;
  if (ctx.measureText(displayText).width > maxW) {
    while (displayText.length > 1 && ctx.measureText(displayText + "...").width > maxW) {
      displayText = displayText.slice(0, -1);
    }
    displayText += "...";
  }
  const tw = ctx.measureText(displayText).width;
  const bw = tw + padX * 2;
  const bh = 14 + padY * 2;
  const arrowH = 5;

  const cvp = getPlayerVisualPos(player);
  const s = gameToScreen(cvp.x, cvp.y);
  const bx = Math.round(s.x - bw / 2);
  const by = Math.round(s.y - 72 * gameScale) - bh - arrowH;

  // Bubble background
  const r = 6;
  ctx.fillStyle = "rgba(13,13,13,0.72)";
  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.lineTo(bx + bw - r, by);
  ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
  ctx.lineTo(bx + bw, by + bh - r);
  ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
  // Arrow
  ctx.lineTo(bx + bw / 2 + arrowH, by + bh);
  ctx.lineTo(bx + bw / 2, by + bh + arrowH);
  ctx.lineTo(bx + bw / 2 - arrowH, by + bh);
  ctx.lineTo(bx + r, by + bh);
  ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
  ctx.lineTo(bx, by + r);
  ctx.quadraticCurveTo(bx, by, bx + r, by);
  ctx.closePath();
  ctx.fill();

  // Text (left-aligned)
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const textColor = bubble.scope === "nearby" ? "#88c498" : "#e4e0d8";
  ctx.fillStyle = textColor;
  ctx.fillText(displayText, bx + padX, by + bh / 2);
  ctx.restore();
}

// ============================================================
// TILED MAP OBJECTS (animated sprites from object layer)
// ============================================================

const OBJ_FRAME_MS = 200; // ms per animation frame
let petInteractTimer = 0; // cooldown to prevent spam
const CAMPFIRE_INTERACT_DIST = 80;
const campfireStates = { focus: {}, rest: {} }; // room -> { id: lit }
const campfireLightCache = { focus: null, rest: null };
const CAMPFIRE_FRAME_MS = 320; // slower campfire animation
const CAMPFIRE_LIGHT_BASE = 192; // px, multiple of 8
const CAMPFIRE_LIGHT_AMP = 8; // px, multiple of 4
const CAMPFIRE_LIGHT_PERIOD_MS = 6000; // ms, multiple of 8
const CAMPFIRE_LIGHT_ALPHA = 0.9;
const CAMPFIRE_LIGHT_TIME_ALPHA = {
  night: 1.0,
  dusk: 0.85,
  morning: 0.6,
  daytime: 0.4,
};

function findTilesetForGID(gid) {
  for (let i = tilesetRegistry.length - 1; i >= 0; i--) {
    if (gid >= tilesetRegistry[i].firstgid) return tilesetRegistry[i];
  }
  return null;
}

function isCampfireObj(obj, ts) {
  if (!obj || !ts || !ts.name) return false;
  const tsName = ts.name.toLowerCase();
  const objName = String(obj.name || "").toLowerCase();
  const objType = String(obj.type || "").toLowerCase();
  return tsName.includes("campfire") || objName.includes("campfire") || objType.includes("campfire");
}

function getObjDrawSize(obj, ts) {
  const w = obj && typeof obj.width === "number" && obj.width > 0 ? obj.width : ts.tileW;
  const h = obj && typeof obj.height === "number" && obj.height > 0 ? obj.height : ts.tileH;
  return { w, h };
}

function getNearestCampfire() {
  const objs = ROOM_DATA[currentRoom].mapObjects;
  if (!objs || !objs.length || !localPlayer) return null;
  let best = null;
  let bestDist = Infinity;
  for (const obj of objs) {
    const ts = findTilesetForGID(obj.gid);
    if (!isCampfireObj(obj, ts)) continue;
    const { w, h } = getObjDrawSize(obj, ts);
    const cx = obj.x + w / 2;
    const cy = obj.y + h / 2;
    const dist = Math.abs(localPlayer.x - cx) + Math.abs(localPlayer.y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = { id: obj.id, x: cx, y: cy, dist };
    }
  }
  return best;
}

// Bulletin board interaction
const BULLETIN_INTERACT_DIST = 80;
let bulletinPopupOpen = false;
let bulletinCooldownUntil = 0;

function isBulletinBoardObj(obj, ts) {
  if (!obj) return false;
  const objType = String(obj.type || obj.class || "").toLowerCase();
  const objName = String(obj.name || "").toLowerCase();
  return objType === "bulletin_board" || objName === "bulletin_board";
}

function getNearestBulletinBoard() {
  const objs = ROOM_DATA[currentRoom].mapObjects;
  if (!objs || !objs.length || !localPlayer) return null;
  let best = null;
  let bestDist = Infinity;
  for (const obj of objs) {
    if (!isBulletinBoardObj(obj)) continue;
    const ts = obj.gid ? findTilesetForGID(obj.gid) : null;
    const w = obj.width || (ts ? ts.tileW : 32);
    const h = obj.height || (ts ? ts.tileH : 32);
    const cx = obj.x + w / 2;
    const cy = obj.y;
    // Player must be below the board (it's on a wall — no interacting from behind)
    if (localPlayer.y < cy) continue;
    const dist = Math.abs(localPlayer.x - cx) + Math.abs(localPlayer.y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = { id: obj.id, x: cx, y: cy, dist };
    }
  }
  return best;
}

function openBulletinPopup() {
  bulletinPopupOpen = true;
  storeSet("ui", "setBulletinOpen", true);
  socket.emit("getBulletinNotes");
}

function closeBulletinPopup() {
  bulletinPopupOpen = false;
  storeSet("ui", "setBulletinOpen", false);
}

// timeAgo, renderBulletinNotes removed — React BulletinPopup handles rendering via storeSet

const DOOR_ANIM_SPEED = 0.04;     // door open/close speed per frame (0→1 in ~25 frames)

// Draw a single pet/animal map object (used by Y-sorted entity pass)
function drawSingleMapObject(obj) {
  const ts = findTilesetForGID(obj.gid);
  if (!ts || !ts.img || !ts.img._loaded || !ts.frameCount) return;
  const now = Date.now();
  let frame;
  if (!obj._napNext) obj._napNext = now + 3000 + Math.random() * 5000;
  if (!obj._napPlaying) obj._napPlaying = false;
  if (!obj._napPlaying) {
    if (now >= obj._napNext) { obj._napPlaying = true; obj._napStart = now; }
    frame = 0;
  } else {
    const elapsed = now - obj._napStart;
    frame = Math.floor(elapsed / 300);
    if (frame >= ts.frameCount) { frame = 0; obj._napPlaying = false; obj._napNext = now + 4000 + Math.random() * 4000; }
  }
  const sx = (frame % ts.columns) * ts.tileW;
  const sy = Math.floor(frame / ts.columns) * ts.tileH;
  const { w, h } = getObjDrawSize(obj, ts);
  ctx.drawImage(ts.img, sx, sy, ts.tileW, ts.tileH, obj.x, obj.y, w, h);
  // Name label (hide for banli)
  if (obj.name && obj.name.toLowerCase() !== "banli") {
    ctx.save();
    ctx.font = f(7, true);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    const labelX = obj.x + w / 2, labelY = obj.y - 4;
    const tw = ctx.measureText(obj.name).width;
    ctx.fillRect(labelX - tw / 2 - 2, labelY - 6, tw + 4, 8);
    ctx.fillStyle = "#fff";
    ctx.fillText(obj.name, labelX, labelY);
    ctx.restore();
  }
}

function drawMapObjects(objs = ROOM_DATA[currentRoom].mapObjects) {
  if (!objs || !objs.length) return;

  const now = Date.now();
  const butterflyState = getButterflyState();

  const px = localPlayer ? localPlayer.x : 0;
  const py = localPlayer ? localPlayer.y : 0;

  for (const obj of objs) {
    // Skip pet/animal objects — they are drawn in the Y-sorted entity pass
    if (obj.type === "pet" || obj.type === "animal") continue;
    const ts = findTilesetForGID(obj.gid);
    if (!ts || !ts.img || !ts.img._loaded) continue;
    const isButterfly = isButterflyObj(obj, ts);
    if (isButterfly && !butterflyState.visible) continue;
    if (isFrogObj(obj, ts) && !isFrogActiveTime()) continue;
    if (isFishObj(obj, ts) && !isFishActiveTime()) continue;
    const campfire = isCampfireObj(obj, ts);
    if (campfire) continue; // draw campfires in a dedicated pass above

    // Static tile object (not an animated OBJECT_TILESET) — draw directly from tileset
    if (!ts.frameCount) {
      const localId = obj.gid - ts.firstgid;
      const sx = (localId % ts.columns) * ts.tileW;
      const sy = Math.floor(localId / ts.columns) * ts.tileH;
      const { w, h } = getObjDrawSize(obj, ts);
      ctx.drawImage(ts.img, sx, sy, ts.tileW, ts.tileH, obj.x, obj.y, w, h);
      continue;
    }

    let frame;
    if (ts.isDoor) {
      // Doors: smooth open/close based on player proximity
      if (obj._doorProgress == null) obj._doorProgress = 0;
      const objCX = obj.x + ts.tileW / 2;
      const objCY = obj.y + ts.tileH / 2;
      const dist = Math.abs(px - objCX) + Math.abs(py - objCY);
      const target = dist < ts.openDist ? 1 : 0;
      if (obj._prevDoorTarget != null && obj._prevDoorTarget !== target) {
        if (ts.name === "door_glass_sliding" || ts.name === "jp_door_sliding") {
          playDoorSlidingSound();
        } else if (ts.name === "studyRoomDoor" && target === 1) {
          playDoorWoodenSound();
        }
      }
      obj._prevDoorTarget = target;
      if (obj._doorProgress < target) obj._doorProgress = Math.min(target, obj._doorProgress + DOOR_ANIM_SPEED);
      else if (obj._doorProgress > target) obj._doorProgress = Math.max(target, obj._doorProgress - DOOR_ANIM_SPEED);
      // Only use the opening frames (first half of spritesheet for round-trip animations)
      frame = Math.round(obj._doorProgress * (ts.openFrames - 1));
    } else if (obj.type === "pet" || obj.type === "animal") {
      // Napping pet: mostly still, occasional slow tail wag
      if (!obj._napNext) obj._napNext = now + 3000 + Math.random() * 5000;
      if (!obj._napPlaying) obj._napPlaying = false;
      if (!obj._napPlaying) {
        // Still — resting on frame 0
        if (now >= obj._napNext) {
          obj._napPlaying = true;
          obj._napStart = now;
        }
        frame = 0;
      } else {
        // One slow tail wag cycle (~300ms per frame)
        const elapsed = now - obj._napStart;
        frame = Math.floor(elapsed / 300);
        if (frame >= ts.frameCount) {
          // Cycle done, rest again for 4-8 seconds
          frame = 0;
          obj._napPlaying = false;
          obj._napNext = now + 4000 + Math.random() * 4000;
        }
      }
    } else {
      // Ambient objects: always loop (coffee steams etc.)
      if (isButterfly && butterflyState.moveToWater) {
        frame = getButterflyWaterFrame(obj, ts, now);
      } else if (isButterfly && butterflyState.static) {
        frame = 0;
      } else {
        frame = Math.floor(now / OBJ_FRAME_MS) % ts.frameCount;
      }
    }

    const sx = (frame % ts.columns) * ts.tileW;
    const sy = Math.floor(frame / ts.columns) * ts.tileH;
    const { w, h } = getObjDrawSize(obj, ts);
    let dx = obj.x;
    let dy = obj.y;
    if (isButterfly && butterflyState.moveToWater) {
      const waterPos = getButterflyWaterPos(currentRoom, w, h);
      if (waterPos) {
        dx = waterPos.x;
        dy = waterPos.y;
      }
    }
    ctx.drawImage(ts.img, sx, sy, ts.tileW, ts.tileH, dx, dy, w, h);

    // Draw name label for pets (hide for banli)
    if (obj.name && (obj.type === "pet" || obj.type === "animal") && obj.name.toLowerCase() !== "banli") {
      ctx.save();
      ctx.font = f(7, true);
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      const { w } = getObjDrawSize(obj, ts);
      const labelX = obj.x + w / 2;
      const labelY = obj.y - 4;
      const tw = ctx.measureText(obj.name).width;
      ctx.fillRect(labelX - tw / 2 - 2, labelY - 6, tw + 4, 8);
      ctx.fillStyle = "#fff";
      ctx.fillText(obj.name, labelX, labelY);
      ctx.restore();
    }
  }
}

function drawCampfireObjects() {
  const objs = ROOM_DATA[currentRoom].mapObjects;
  if (!objs || !objs.length) return;
  const now = Date.now();
  for (const obj of objs) {
    const ts = findTilesetForGID(obj.gid);
    if (!ts || !ts.img || !ts.img._loaded || !ts.frameCount) continue;
    if (!isCampfireObj(obj, ts)) continue;
    if (!(campfireStates[currentRoom] && campfireStates[currentRoom][obj.id])) continue;

    // Campfire: use frames 1-3, loop forward (1-2-3-1...)
    const frame = Math.floor(now / CAMPFIRE_FRAME_MS) % 3;
    const sx = (frame % ts.columns) * ts.tileW;
    const sy = Math.floor(frame / ts.columns) * ts.tileH;
    const { w, h } = getObjDrawSize(obj, ts);
    ctx.drawImage(ts.img, sx, sy, ts.tileW, ts.tileH, obj.x, obj.y, w, h);
  }
}

function drawCampfireLight() {
  const objs = ROOM_DATA[currentRoom].mapObjects;
  if (!objs || !objs.length) return;
  const states = campfireStates[currentRoom];
  if (!states) return;

  let anyLit = false;
  for (const obj of objs) {
    if (states[obj.id]) { anyLit = true; break; }
  }
  if (!anyLit) return;

  const dims = ROOM_DIMS[currentRoom];
  if (!dims) return;
  const w = dims.cols * TILE;
  const h = dims.rows * TILE;

  let lightCanvas = campfireLightCache[currentRoom];
  if (!lightCanvas || lightCanvas.width !== w || lightCanvas.height !== h) {
    lightCanvas = document.createElement("canvas");
    lightCanvas.width = w;
    lightCanvas.height = h;
    campfireLightCache[currentRoom] = lightCanvas;
  }

  const lctx = lightCanvas.getContext("2d");
  lctx.clearRect(0, 0, w, h);

  const timeAlpha = CAMPFIRE_LIGHT_TIME_ALPHA[cachedTimeKey] ?? 0.6;
  if (timeAlpha <= 0) return;

  const now = performance.now();
  for (const obj of objs) {
    if (!states[obj.id]) continue;
    const ts = findTilesetForGID(obj.gid);
    if (!ts) continue;
    const { w, h } = getObjDrawSize(obj, ts);
    const cx = obj.x + w / 2;
    const cy = obj.y + h / 2 + 8;
    const t = (now + obj.id * 128) / CAMPFIRE_LIGHT_PERIOD_MS;
    const radiusRaw = CAMPFIRE_LIGHT_BASE + CAMPFIRE_LIGHT_AMP * Math.sin(t);
    const radius = Math.max(32, Math.round(radiusRaw / 4) * 4); // keep multiples of 4

    const grad = lctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    // Campfire falloff: warm orange core → amber → ember red → transparent
    grad.addColorStop(0.0, "rgba(255,170,90,0.8)");
    grad.addColorStop(0.2, "rgba(240,130,60,0.55)");
    grad.addColorStop(0.5, "rgba(200,90,45,0.32)");
    grad.addColorStop(0.8, "rgba(140,60,30,0.16)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    lctx.fillStyle = grad;
    lctx.beginPath();
    lctx.arc(cx, cy, radius, 0, Math.PI * 2);
    lctx.fill();
  }

  const mask = getOutdoorMask(currentRoom);
  if (mask) {
    lctx.globalCompositeOperation = "destination-in";
    lctx.drawImage(mask, 0, 0);
    lctx.globalCompositeOperation = "source-over";
  }

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = CAMPFIRE_LIGHT_ALPHA * timeAlpha;
  ctx.drawImage(lightCanvas, 0, 0);
  ctx.restore();
}

// ============================================================
// CAT RENDERING
// ============================================================

let catData = { x: 0, y: 0, room: "focus", state: "idle" };
let catAnimFrame = 0;
let catMiuTimer = 0;
let catMiuX = 0;
let catMiuY = 0;
let catSleepPetTimer = 0;
let catLastRubHeartTime = 0;

// --- Cat Sprite Sheet Configuration (orange_3.png, 1024x544, 32x32 per frame) ---
// Layout: 32 cols × 17 rows (row 0 = header labels), only cols 0-23 contain sprites
// 6 animation blocks × 4 cols each = 24 cols of sprite data
// Directions: 2 rows per dir (main row + overflow row)
// Row order (top → bottom): down, down-left, left, up-left, up, up-right, right, down-right
// We only use 4 dirs; right reuses left row and flips to save memory
const CAT_SPRITE = {
  frameW: 32,
  frameH: 32,
  // Each animation block = exactly 4 columns
  anims: {
    sit:  { startCol: 0,  frames: 7, dualRow: true, dirFrames: { down: 6, up: 7, left: 6, right: 6 } },  // SITTING DOWN (cols 0-3 + overflow)
    look: { startCol: 4,  frames: 4 },  // LOOKING AROUND (cols 4-7)
    lay:  { startCol: 8,  frames: 8, dualRow: true },  // LAYING DOWN (cols 8-11, 2 rows: 0-3 main, 4-7 overflow)
    walk: { startCol: 12, frames: 4 },  // WALKING        (cols 12-15)
    run:  { startCol: 16, frames: 4 },  // RUNNING        (cols 16-19)
    run2: { startCol: 20, frames: 4 },  // RUNNING 2.0    (cols 20-23)
  },
  // Row index for each direction (main row; overflow = row+1)
  dirs: { down: 1, left: 5, up: 9, right: 5 },  // right reuses left row, flipped in draw code
};
const CAT_SPRITE_TOP_CROP = 1;

// Map cat behavior states → sprite animation names
const CAT_STATE_TO_ANIM = {
  sit:           "sit",
  sleep:         "lay",
  groom:         "look",
  stretch:       "sit",
  yawn:          "sit",
  wander:        "walk",
  curious:       "run2",
  idle:          "sit",
  gift_deliver:  "run2",
  zoomies:       "run2",
  leg_rub:       "walk",
  stare:         "look",
};

// Cat direction tracking (accumulated delta to avoid flickering on diagonal movement)
let catPrevX = 0;
let catPrevY = 0;
let catDirAccX = 0;        // accumulated X movement since last direction sample
let catDirAccY = 0;        // accumulated Y movement since last direction sample
let catDirLastTime = 0;    // last time direction was sampled
let catDirection = "down";
const CAT_DIR_SAMPLE_MS = 200; // sample direction every 200ms from accumulated delta
let catLastMoveTime = 0;
let catSpriteFrame = 0;
let catSpriteLastTime = 0;
const CAT_SPRITE_IDLE_MS = 250;  // ms per frame for idle/sitting animations
const CAT_SPRITE_MOVE_MS = 120;  // ms per frame for walking/running animations

// Sit transition state machine
// move→sit: play "sit" frames 0→3, then hold frame 3
// sit→move: play "sit" frames 3→0, then switch to walk/run
let catSitPhase = "none";      // "none" | "down" | "hold" | "up"
let catSitFrame = 0;           // current sit animation frame (0-3)
let catSitFrameTime = 0;       // last frame advance timestamp
let catPrevAnimName = "";       // previous resolved animation name
const CAT_SIT_FRAME_MS = 150;  // ms per frame for sit/stand transition

function drawCatBody() {
  // --- Cat-dragging override: approach + dragging phases ---
  const isDragMode = catDragPhase !== "none" && localPlayer;
  if (!isDragMode && catData.room !== currentRoom) return;

  if (isDragMode) {
    let cx, cy;
    if (catDragPhase === "approach") {
      // Cat walks from its position toward leading position (18px ahead of player)
      cx = catDragX;
      cy = catDragY;
      const adx = catDragTargetX - cx;
      const ady = catDragTargetY - cy;
      if (Math.abs(adx) >= Math.abs(ady)) {
        catDirection = adx > 0 ? "right" : "left";
      } else {
        catDirection = ady > 0 ? "down" : "up";
      }
    } else {
      // dragging: 18px ahead of player in their walking direction
      const dir = localPlayer.direction;
      const offsetX = dir === "left" ? -18 : dir === "right" ? 18 : 0;
      const offsetY = dir === "up" ? -18 : dir === "down" ? 18 : 0;
      cx = localPlayer.x + offsetX;
      cy = localPlayer.y + offsetY;
      catDirection = dir;
    }

    catAnimFrame += 0.02;
    const now = Date.now();
    if (now - catSpriteLastTime >= CAT_SPRITE_MOVE_MS) {
      catSpriteFrame++;
      catSpriteLastTime = now;
    }

    // Force walk animation
    const walkAnim = CAT_SPRITE.anims.walk;
    const totalFrames = walkAnim.frames;
    const drawFrameIdx = catSpriteFrame % totalFrames;

    // Shadow
    ctx.fillStyle = "rgba(0,0,0,0.1)";
    ctx.beginPath();
    ctx.ellipse(cx, cy + 2, 8, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Draw cat sprite
    const sheet = spriteImages["cat_orange3"];
    if (sheet && sheet._loaded) {
      const dirRow = CAT_SPRITE.dirs[catDirection] || CAT_SPRITE.dirs.down;
      const sx = (walkAnim.startCol + drawFrameIdx) * CAT_SPRITE.frameW;
      const sy = dirRow * CAT_SPRITE.frameH;
      const prevSmoothing = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      const drawX = cx - CAT_SPRITE.frameW / 2;
      const drawY = cy + 8 - CAT_SPRITE.frameH;
      const srcY = sy + CAT_SPRITE_TOP_CROP;
      const srcH = CAT_SPRITE.frameH - CAT_SPRITE_TOP_CROP;
      const dstY = drawY + CAT_SPRITE_TOP_CROP;
      const dstH = CAT_SPRITE.frameH - CAT_SPRITE_TOP_CROP;
      if (catDirection === "right") {
        ctx.save();
        ctx.translate(cx, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(sheet, sx, srcY, CAT_SPRITE.frameW, srcH, -CAT_SPRITE.frameW / 2, dstY, CAT_SPRITE.frameW, dstH);
        ctx.restore();
      } else {
        ctx.drawImage(sheet, sx, srcY, CAT_SPRITE.frameW, srcH, drawX, dstY, CAT_SPRITE.frameW, dstH);
      }
      ctx.imageSmoothingEnabled = prevSmoothing;
    }

    // Reset sit state machine so normal rendering resumes cleanly after drag
    catSitPhase = "none";
    catPrevAnimName = "";
    return;
  }

  const { x, y, state } = catData;
  catAnimFrame += 0.02; // Keep incrementing for UI effects (Zzz float, etc.)

  // --- Cat direction tracking (accumulated delta, sampled periodically) ---
  const movingState = state === "wander" || state === "curious" || state === "gift_deliver" || state === "zoomies" || state === "leg_rub";
  const dx = catData.x - catPrevX;
  const dy = catData.y - catPrevY;
  catDirAccX += dx;
  catDirAccY += dy;
  catPrevX = catData.x;
  catPrevY = catData.y;

  const now = Date.now();
  if (Math.abs(dx) + Math.abs(dy) > 0.2) catLastMoveTime = now;
  const movingRecently = now - catLastMoveTime < 300;
  const animStillMoving = now - catLastMoveTime < 600; // longer grace for animation switching
  const isMoving = movingState && movingRecently;

  if (isMoving && now - catDirLastTime >= CAT_DIR_SAMPLE_MS) {
    const adx = Math.abs(catDirAccX);
    const ady = Math.abs(catDirAccY);
    if (adx > 1 || ady > 1) {
      // Horizontal movement takes priority; only use up/down for pure vertical
      if (adx > 1) {
        catDirection = catDirAccX > 0 ? "right" : "left";
      } else {
        catDirection = catDirAccY > 0 ? "down" : "up";
      }
    }
    catDirAccX = 0;
    catDirAccY = 0;
    catDirLastTime = now;
  }

  // Server-sent face direction override (e.g. face down when greeting at entrance)
  if (!isMoving && catData.faceDir) {
    catDirection = catData.faceDir;
  }

  // --- Update sprite animation frame (for looping anims like walk/run) ---
  const frameInterval = isMoving ? CAT_SPRITE_MOVE_MS : CAT_SPRITE_IDLE_MS;
  if (now - catSpriteLastTime >= frameInterval) {
    catSpriteFrame++;
    catSpriteLastTime = now;
  }

  // --- Sit transition state machine ---
  let animName = CAT_STATE_TO_ANIM[state] || "sit";
  if (movingState && !animStillMoving) animName = "sit";
  const isSitAnim = animName === "sit";
  const isMovementAnim = animName === "walk" || animName === "run2";

  // Sit animation last frame depends on direction (up/down=6, left/right=5)
  const sitAnim = CAT_SPRITE.anims.sit;
  const sitLastFrame = (sitAnim.dirFrames && sitAnim.dirFrames[catDirection]
    ? sitAnim.dirFrames[catDirection] : sitAnim.frames) - 1;

  // First frame: initialize without playing transition
  if (catPrevAnimName === "") {
    catPrevAnimName = animName;
    if (isSitAnim) { catSitPhase = "hold"; catSitFrame = sitLastFrame; }
  }

  // Detect animation transitions (only when not already in a sit transition)
  if (animName !== catPrevAnimName && catSitPhase !== "down" && catSitPhase !== "up") {
    const wasMovement = catPrevAnimName === "walk" || catPrevAnimName === "run2";
    if (wasMovement && isSitAnim) {
      // Movement → Sit: play sit-down (frames 0→last)
      catSitPhase = "down";
      catSitFrame = 0;
      catSitFrameTime = now;
    } else if (catSitPhase === "hold" && isMovementAnim) {
      // Sit(hold) → Movement: play stand-up (frames last→0)
      catSitPhase = "up";
      catSitFrame = sitLastFrame;
      catSitFrameTime = now;
    } else {
      // Other transitions (sit↔lay, sit↔look, etc.): instant switch
      catSpriteFrame = 0;
      catSpriteLastTime = now;
      catPrevAnimName = animName;
      if (isSitAnim) {
        // Entering sit from non-movement: go directly to hold (fully seated)
        catSitPhase = "hold";
        catSitFrame = sitLastFrame;
      } else {
        catSitPhase = "none";
      }
    }
  }

  // Advance sit transition frames
  if (catSitPhase === "down") {
    if (now - catSitFrameTime >= CAT_SIT_FRAME_MS) {
      catSitFrame++;
      catSitFrameTime = now;
    }
    if (catSitFrame >= sitLastFrame) {
      catSitFrame = sitLastFrame;
      catSitPhase = "hold";
      catPrevAnimName = animName;
    }
  } else if (catSitPhase === "up") {
    if (now - catSitFrameTime >= CAT_SIT_FRAME_MS) {
      catSitFrame--;
      catSitFrameTime = now;
    }
    if (catSitFrame <= 0) {
      catSitFrame = 0;
      catSitPhase = "none";
      catPrevAnimName = animName;
    }
  }

  // Resolve which animation + frame to actually draw
  let drawAnimName, drawFrameIdx;
  if (catSitPhase === "down" || catSitPhase === "up") {
    drawAnimName = "sit";
    drawFrameIdx = catSitFrame;
  } else if (catSitPhase === "hold") {
    drawAnimName = "sit";
    drawFrameIdx = sitLastFrame;  // Stay on last frame (fully seated)
  } else {
    drawAnimName = animName;
    const anim = CAT_SPRITE.anims[drawAnimName];
    if (anim) {
      const totalFrames = (anim.dirFrames && anim.dirFrames[catDirection])
        ? anim.dirFrames[catDirection] : anim.frames;
      let rawFrame;

      // Lay/sleep: play once to last frame, then hold (no loop)
      if (drawAnimName === "lay") {
        rawFrame = Math.min(catSpriteFrame, totalFrames - 1);
      } else {
        rawFrame = catSpriteFrame % totalFrames;
      }

      drawFrameIdx = rawFrame;
    } else {
      drawFrameIdx = 0;
    }
    // Update prevAnimName for non-transition states
    catPrevAnimName = animName;
  }

  // Shadow
  ctx.fillStyle = "rgba(0,0,0,0.1)";
  ctx.beginPath();
  ctx.ellipse(x, y + 2, 8, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // --- Draw cat sprite from orange_3 sheet ---
  const sheet = spriteImages["cat_orange3"];
  if (sheet && sheet._loaded) {
    const drawAnim = CAT_SPRITE.anims[drawAnimName];
    if (drawAnim) {
      const dirRow = CAT_SPRITE.dirs[catDirection] || CAT_SPRITE.dirs.down;
      // For dualRow anims (lay): frames 0-3 on main row, frames 4-7 on overflow row (+1)
      let colIdx = drawFrameIdx;
      let rowIdx = dirRow;
      if (drawAnim.dualRow && drawFrameIdx >= 4) {
        colIdx = drawFrameIdx - 4;
        rowIdx = dirRow + 1;
      }
      const sx = (drawAnim.startCol + colIdx) * CAT_SPRITE.frameW;
      const sy = rowIdx * CAT_SPRITE.frameH;

      const prevSmoothing = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      const drawX = x - CAT_SPRITE.frameW / 2;
      const drawY = y + 8 - CAT_SPRITE.frameH;
      const srcY = sy + CAT_SPRITE_TOP_CROP;
      const srcH = CAT_SPRITE.frameH - CAT_SPRITE_TOP_CROP;
      const dstY = drawY + CAT_SPRITE_TOP_CROP;
      const dstH = CAT_SPRITE.frameH - CAT_SPRITE_TOP_CROP;
      if (catDirection === "right") {
        // Flip horizontally for right direction (reuse left-facing row)
        ctx.save();
        ctx.translate(x, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(
          sheet,
          sx, srcY, CAT_SPRITE.frameW, srcH,
          -CAT_SPRITE.frameW / 2, dstY,
          CAT_SPRITE.frameW, dstH
        );
        ctx.restore();
      } else {
        ctx.drawImage(
          sheet,
          sx, srcY, CAT_SPRITE.frameW, srcH,
          drawX, dstY,
          CAT_SPRITE.frameW, dstH
        );
      }
      ctx.imageSmoothingEnabled = prevSmoothing;
    }
  }

  // Zzz for sleeping state
  if (state === "sleep") {
    const zFloat = Math.sin(catAnimFrame) * 2;
    ctx.font = f(16, false);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.textAlign = "center";
    ctx.fillText("z", x + 12, y - 18 + zFloat);
    ctx.fillText("z", x + 16, y - 23 + zFloat * 0.7);
  }

  // Track sleeping pet timer for UI effects
  if (catSleepPetTimer > 0) {
    catSleepPetTimer--;
  }

  // Gift rendering - position adjusts based on facing direction
  if (catData.gift) {
    let gx, gy;
    if (isMoving) {
      // Gift at mouth level (run2 face front offset ≈ +6)
      if (catDirection === "right")     { gx = x + 10; gy = y - 10; }
      else if (catDirection === "left") { gx = x - 10; gy = y - 10; }
      else if (catDirection === "up")   { gx = x; gy = y - 16; }
      else                              { gx = x; gy = y - 6; }
    } else {
      // Gift placed at front paws (direction-aware)
      if (catDirection === "right")     { gx = x + 8; gy = y + 1; }
      else if (catDirection === "left") { gx = x - 8; gy = y + 1; }
      else if (catDirection === "down") { gx = x - 4; gy = y + 2; }
      else                              { gx = x; gy = y + 2; }
    }
    // Flip gift when cat faces left so it doesn't point into the face
    if (catDirection === "left") {
      ctx.save();
      ctx.translate(gx, 0);
      ctx.scale(-1, 1);
      drawGift(catData.gift, 0, gy);
      ctx.restore();
    } else {
      drawGift(catData.gift, gx, gy);
    }
  }

  // Leg rub: spawn small hearts periodically near the target player
  if (state === "leg_rub" && catData.rubTarget) {
    if (now - catLastRubHeartTime > 1200) {
      catLastRubHeartTime = now;
      const rubPlayer = catData.rubTarget === myId ? localPlayer : otherPlayers[catData.rubTarget];
      if (rubPlayer) {
        spawnOneHeart(rubPlayer.x, rubPlayer.y);
      }
    }
  }
}

/* === OLD PROCEDURAL CAT DRAWING (preserved for reference) ===
function drawCatBody_procedural() {
  if (catData.room !== currentRoom) return;

  const { x, y, state } = catData;
  catAnimFrame += 0.05;

  // Shadow
  ctx.fillStyle = "rgba(0,0,0,0.1)";
  ctx.beginPath();
  ctx.ellipse(x, y + 8, 8, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  if (state === "sleep") {
    // Sleeping cat: curled up ball
    // Body (round)
    ctx.fillStyle = "#f4a460";
    ctx.beginPath();
    ctx.ellipse(x, y, 10, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    // Darker stripes
    ctx.fillStyle = "#d48840";
    ctx.fillRect(x - 4, y - 3, 2, 6);
    ctx.fillRect(x + 1, y - 4, 2, 7);
    // Tail curled around (wags when petted)
    if (catSleepPetTimer > 0) {
      catSleepPetTimer--;
      const wag = Math.sin(catAnimFrame * 8) * 4;
      ctx.strokeStyle = "#f4a460";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x + 8, y + 4);
      ctx.quadraticCurveTo(x + 14, y + wag, x + 10, y - 4);
      ctx.stroke();
      ctx.lineCap = "butt";
    } else {
      ctx.strokeStyle = "#f4a460";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x + 5, y + 2, 6, -0.5, Math.PI * 0.8);
      ctx.stroke();
      ctx.strokeStyle = "#d48840";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x + 5, y + 2, 6, 0, Math.PI * 0.5);
      ctx.stroke();
    }
    // Zzz
    const zFloat = Math.sin(catAnimFrame) * 2;
    ctx.font = f(16, false);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.textAlign = "center";
    ctx.fillText("z", x + 10, y - 8 + zFloat);
    ctx.fillText("z", x + 14, y - 13 + zFloat * 0.7);
  } else if (state === "sit") {
    // Sitting cat
    const lookingUp = catData.onFurniture === "window";
    // Body
    ctx.fillStyle = "#f4a460";
    ctx.beginPath();
    ctx.ellipse(x, y + 2, 7, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head (tilted up if at window)
    ctx.beginPath();
    ctx.arc(x, lookingUp ? y - 10 : y - 8, 6, 0, Math.PI * 2);
    ctx.fill();
    // Ears
    const headY = lookingUp ? y - 10 : y - 8;
    ctx.beginPath();
    ctx.moveTo(x - 6, headY - 3);
    ctx.lineTo(x - 3, headY - 9);
    ctx.lineTo(x, headY - 3);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, headY - 3);
    ctx.lineTo(x + 3, headY - 9);
    ctx.lineTo(x + 6, headY - 3);
    ctx.fill();
    // Inner ears
    ctx.fillStyle = "#ffb6c1";
    ctx.beginPath();
    ctx.moveTo(x - 5, headY - 4);
    ctx.lineTo(x - 3, headY - 8);
    ctx.lineTo(x - 1, headY - 4);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 1, headY - 4);
    ctx.lineTo(x + 3, headY - 8);
    ctx.lineTo(x + 5, headY - 4);
    ctx.fill();
    // Eyes
    ctx.fillStyle = "#333";
    if (lookingUp) {
      // Eyes looking upward (higher on head)
      ctx.beginPath();
      ctx.arc(x - 2.5, headY - 2.5, 1.2, 0, Math.PI * 2);
      ctx.arc(x + 2.5, headY - 2.5, 1.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x - 2.5, headY - 1, 1.2, 0, Math.PI * 2);
      ctx.arc(x + 2.5, headY - 1, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // Nose
    ctx.fillStyle = "#ffb6c1";
    ctx.beginPath();
    ctx.moveTo(x, headY + 1);
    ctx.lineTo(x - 1.5, headY + 2.5);
    ctx.lineTo(x + 1.5, headY + 2.5);
    ctx.fill();
    // Tail
    ctx.strokeStyle = "#f4a460";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    const tailWag = Math.sin(catAnimFrame * 1.5) * 4;
    ctx.beginPath();
    ctx.moveTo(x + 6, y + 6);
    ctx.quadraticCurveTo(x + 14, y + tailWag, x + 12, y - 2);
    ctx.stroke();
    ctx.lineCap = "butt";
    // Stripes on body
    ctx.fillStyle = "#d48840";
    ctx.fillRect(x - 3, y - 2, 2, 5);
    ctx.fillRect(x + 1, y - 3, 2, 6);
  } else if (state === "groom") {
    // Grooming: sitting and licking paw
    // Body
    ctx.fillStyle = "#f4a460";
    ctx.beginPath();
    ctx.ellipse(x, y + 2, 7, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head tilted down
    ctx.beginPath();
    ctx.arc(x + 3, y - 6, 6, 0, Math.PI * 2);
    ctx.fill();
    // Ears
    ctx.beginPath();
    ctx.moveTo(x - 1, y - 9); ctx.lineTo(x + 1, y - 15); ctx.lineTo(x + 4, y - 9);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 4, y - 9); ctx.lineTo(x + 7, y - 15); ctx.lineTo(x + 9, y - 9);
    ctx.fill();
    // Inner ears
    ctx.fillStyle = "#ffb6c1";
    ctx.beginPath();
    ctx.moveTo(x, y - 10); ctx.lineTo(x + 1.5, y - 14); ctx.lineTo(x + 3.5, y - 10);
    ctx.fill();
    // Paw raised (licking animation)
    const lickY = Math.sin(catAnimFrame * 4) * 2;
    ctx.fillStyle = "#f4a460";
    ctx.beginPath();
    ctx.arc(x + 6, y - 2 + lickY, 3, 0, Math.PI * 2);
    ctx.fill();
    // Eyes half-closed
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 1, y - 7); ctx.lineTo(x + 3, y - 7);
    ctx.moveTo(x + 5, y - 7); ctx.lineTo(x + 7, y - 7);
    ctx.stroke();
    // Stripes
    ctx.fillStyle = "#d48840";
    ctx.fillRect(x - 3, y - 2, 2, 5);
    ctx.fillRect(x + 1, y - 3, 2, 6);
  } else if (state === "stretch") {
    // Stretching: front low, butt up
    const stretchAnim = Math.sin(catAnimFrame * 1.5) * 0.5 + 0.5;
    // Back body (butt up)
    ctx.fillStyle = "#f4a460";
    ctx.beginPath();
    ctx.ellipse(x - 4, y - 2 - stretchAnim * 4, 7, 5, -0.3, 0, Math.PI * 2);
    ctx.fill();
    // Front body (low)
    ctx.beginPath();
    ctx.ellipse(x + 6, y + 3, 6, 4, 0.2, 0, Math.PI * 2);
    ctx.fill();
    // Head (low)
    ctx.beginPath();
    ctx.arc(x + 12, y + 2, 5, 0, Math.PI * 2);
    ctx.fill();
    // Ears
    ctx.beginPath();
    ctx.moveTo(x + 9, y - 1); ctx.lineTo(x + 9, y - 6); ctx.lineTo(x + 12, y - 1);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 12, y - 1); ctx.lineTo(x + 15, y - 6); ctx.lineTo(x + 15, y - 1);
    ctx.fill();
    // Front paws stretched out
    ctx.strokeStyle = "#f4a460";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x + 10, y + 6); ctx.lineTo(x + 16, y + 8);
    ctx.moveTo(x + 8, y + 6); ctx.lineTo(x + 14, y + 8);
    ctx.stroke();
    // Eyes squeezed shut (happy stretch)
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x + 10, y + 1, 1.5, 0, Math.PI);
    ctx.arc(x + 14, y + 1, 1.5, 0, Math.PI);
    ctx.stroke();
    // Tail up
    ctx.strokeStyle = "#f4a460";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - 10, y - 4 - stretchAnim * 4);
    ctx.quadraticCurveTo(x - 14, y - 14, x - 8, y - 16);
    ctx.stroke();
    ctx.lineCap = "butt";
    // Stripes
    ctx.fillStyle = "#d48840";
    ctx.fillRect(x - 6, y - 5 - stretchAnim * 3, 2, 4);
    ctx.fillRect(x - 2, y - 4 - stretchAnim * 2, 2, 4);
  } else if (state === "yawn") {
    // Yawning cat - sitting with mouth open
    ctx.fillStyle = "#f4a460";
    ctx.beginPath();
    ctx.ellipse(x, y + 2, 7, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head
    ctx.beginPath();
    ctx.arc(x, y - 8, 6, 0, Math.PI * 2);
    ctx.fill();
    // Ears
    ctx.beginPath();
    ctx.moveTo(x - 6, y - 11); ctx.lineTo(x - 3, y - 17); ctx.lineTo(x, y - 11);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y - 11); ctx.lineTo(x + 3, y - 17); ctx.lineTo(x + 6, y - 11);
    ctx.fill();
    // Inner ears
    ctx.fillStyle = "#ffb6c1";
    ctx.beginPath();
    ctx.moveTo(x - 5, y - 12); ctx.lineTo(x - 3, y - 16); ctx.lineTo(x - 1, y - 12);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 1, y - 12); ctx.lineTo(x + 3, y - 16); ctx.lineTo(x + 5, y - 12);
    ctx.fill();
    // Eyes squeezed shut
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x - 2.5, y - 10, 1.5, 0, Math.PI);
    ctx.moveTo(x + 4, y - 10);
    ctx.arc(x + 2.5, y - 10, 1.5, 0, Math.PI);
    ctx.stroke();
    // Mouth wide open (yawn)
    const yawnOpen = Math.sin(catAnimFrame * 2) * 0.5 + 0.5;
    ctx.fillStyle = "#ff9999";
    ctx.beginPath();
    ctx.ellipse(x, y - 5, 3, 1.5 + yawnOpen * 2, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tongue
    ctx.fillStyle = "#ff6b6b";
    ctx.beginPath();
    ctx.ellipse(x, y - 4 + yawnOpen, 1.5, 1, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tail
    ctx.strokeStyle = "#f4a460";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x + 6, y + 6);
    ctx.quadraticCurveTo(x + 14, y, x + 12, y - 2);
    ctx.stroke();
    ctx.lineCap = "butt";
    // Stripes
    ctx.fillStyle = "#d48840";
    ctx.fillRect(x - 3, y - 2, 2, 5);
    ctx.fillRect(x + 1, y - 3, 2, 6);
  } else {
    // Walking / wander / curious cat
    const bobY = Math.sin(catAnimFrame * 3) * 1.5;
    const isMoving = state === "wander" || state === "curious";
    const legAnim = isMoving ? Math.sin(catAnimFrame * 6) * 3 : 0;
    // Body
    ctx.fillStyle = "#f4a460";
    ctx.beginPath();
    ctx.ellipse(x, y + bobY, 9, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    // Legs
    ctx.strokeStyle = "#f4a460";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x - 5, y + 5 + bobY);
    ctx.lineTo(x - 5 - legAnim * 0.3, y + 10);
    ctx.moveTo(x - 2, y + 5 + bobY);
    ctx.lineTo(x - 2 + legAnim * 0.3, y + 10);
    ctx.moveTo(x + 2, y + 5 + bobY);
    ctx.lineTo(x + 2 - legAnim * 0.3, y + 10);
    ctx.moveTo(x + 5, y + 5 + bobY);
    ctx.lineTo(x + 5 + legAnim * 0.3, y + 10);
    ctx.stroke();
    // Head
    ctx.fillStyle = "#f4a460";
    ctx.beginPath();
    ctx.arc(x + 8, y - 3 + bobY, 5.5, 0, Math.PI * 2);
    ctx.fill();
    // Ears
    ctx.beginPath();
    ctx.moveTo(x + 4, y - 6 + bobY);
    ctx.lineTo(x + 5, y - 12 + bobY);
    ctx.lineTo(x + 8, y - 6 + bobY);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 8, y - 6 + bobY);
    ctx.lineTo(x + 11, y - 12 + bobY);
    ctx.lineTo(x + 12, y - 6 + bobY);
    ctx.fill();
    // Inner ears
    ctx.fillStyle = "#ffb6c1";
    ctx.beginPath();
    ctx.moveTo(x + 5, y - 7 + bobY);
    ctx.lineTo(x + 5.5, y - 11 + bobY);
    ctx.lineTo(x + 7.5, y - 7 + bobY);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 8.5, y - 7 + bobY);
    ctx.lineTo(x + 10.5, y - 11 + bobY);
    ctx.lineTo(x + 11.5, y - 7 + bobY);
    ctx.fill();
    // Eyes
    ctx.fillStyle = "#333";
    ctx.beginPath();
    ctx.arc(x + 6, y - 4 + bobY, 1, 0, Math.PI * 2);
    ctx.arc(x + 10, y - 4 + bobY, 1, 0, Math.PI * 2);
    ctx.fill();
    // Nose
    ctx.fillStyle = "#ffb6c1";
    ctx.beginPath();
    ctx.moveTo(x + 8, y - 2 + bobY);
    ctx.lineTo(x + 7, y - 0.5 + bobY);
    ctx.lineTo(x + 9, y - 0.5 + bobY);
    ctx.fill();
    // Tail
    ctx.strokeStyle = "#f4a460";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    const tw = Math.sin(catAnimFrame * 2) * 5;
    ctx.beginPath();
    ctx.moveTo(x - 8, y + bobY);
    ctx.quadraticCurveTo(x - 14, y - 6 + tw + bobY, x - 11, y - 10 + bobY);
    ctx.stroke();
    ctx.lineCap = "butt";
    // Stripes
    ctx.fillStyle = "#d48840";
    ctx.fillRect(x - 4, y - 2 + bobY, 2, 4);
    ctx.fillRect(x + 0, y - 3 + bobY, 2, 5);
  }

  // Gift rendering (pixel layer)
  if (catData.gift) {
    const gx = (state === "wander" || state === "gift_deliver" || state === "curious")
      ? x + 12 : x + 8;
    const gy = (state === "wander" || state === "gift_deliver" || state === "curious")
      ? y - 1 : y + 10;
    drawGift(catData.gift, gx, gy);
  }
}
=== END OLD PROCEDURAL CAT DRAWING === */

// Cat UI elements (drawn at full resolution)
function drawCatUI() {
  if (catDragPhase !== "none") return;
  if (catData.room !== currentRoom) return;
  const { x, y, state } = catData;

  // Ear perk overlay
  if (catData.earPerk && (state === "sit" || state === "sleep")) {
    ctx.font = f(16, true);
    ctx.fillStyle = "#f5a623";
    ctx.textAlign = "center";
    ctx.fillText("!", x + 8, y - 22);
  }

  // Floating "Miu~" when petted (3s = 180 frames, last 30 frames fade out)
  if (catMiuTimer > 0) {
    catMiuTimer--;
    const miuAlpha = catMiuTimer < 30 ? catMiuTimer / 30 : 1;
    catMiuY -= 0.15;
    ctx.font = f(12, false);
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(255,255,255,${miuAlpha * 0.9})`;
    ctx.fillText(currentLang === "zh" ? "喵~" : "Meow~", catMiuX, catMiuY);
  }

  // Stare: floating "..." thought bubble
  if (state === "stare") {
    const dotFloat = Math.sin(catAnimFrame * 1.5) * 1.5;
    ctx.font = f(14, true);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("...", x, y - 24 + dotFloat);
  }
}

function drawGift(type, gx, gy) {
  if (type === "fish") {
    ctx.fillStyle = "#6bc5d9";
    ctx.beginPath();
    ctx.ellipse(gx, gy, 5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tail
    ctx.beginPath();
    ctx.moveTo(gx - 5, gy);
    ctx.lineTo(gx - 9, gy - 3);
    ctx.lineTo(gx - 9, gy + 3);
    ctx.closePath();
    ctx.fill();
    // Eye
    ctx.fillStyle = "#333";
    ctx.beginPath();
    ctx.arc(gx + 2, gy - 1, 0.8, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "leaf") {
    ctx.fillStyle = "#6ab04c";
    ctx.beginPath();
    ctx.ellipse(gx, gy, 5, 3, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#4a8830";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(gx - 4, gy);
    ctx.lineTo(gx + 4, gy);
    ctx.stroke();
  } else if (type === "yarn") {
    ctx.fillStyle = "#e94560";
    ctx.beginPath();
    ctx.arc(gx, gy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#c0392b";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(gx - 1, gy - 1, 2, 0, Math.PI * 1.5);
    ctx.stroke();
  }
}

// ============================================================
// REACTION EMOJI PARTICLES
// ============================================================

const reactionEmojis = [];

function spawnReactionEmoji(senderId, targetId, emoji) {
  // Get sender's current position
  let sx, sy;
  if (senderId === myId && localPlayer) {
    sx = localPlayer.x; sy = localPlayer.y;
  } else if (otherPlayers[senderId]) {
    sx = otherPlayers[senderId].x; sy = otherPlayers[senderId].y;
  } else {
    return; // sender not visible
  }
  reactionEmojis.push({
    x: sx,
    y: sy,
    senderId: senderId,
    targetId: targetId,
    emoji: emoji,
    phase: "rise",   // rise -> pause -> fly -> hover
    timer: 0,
  });
}

function updateAndDrawReactionEmojis() {
  for (let i = reactionEmojis.length - 1; i >= 0; i--) {
    const r = reactionEmojis[i];
    r.timer++;

    // Look up target's current position (they might move)
    let target = null;
    if (r.targetId === myId && localPlayer) {
      target = localPlayer;
    } else if (otherPlayers[r.targetId]) {
      target = otherPlayers[r.targetId];
    }

    // Track sender for pause phase
    let sender = null;
    if (r.senderId === myId && localPlayer) {
      sender = localPlayer;
    } else if (otherPlayers[r.senderId]) {
      sender = otherPlayers[r.senderId];
    }

    const HEAD_OFFSET = 88; // above name label + status emoji

    if (r.phase === "rise") {
      // Phase 1: Rise from sender body to above head (1s = 60 frames)
      r.y -= HEAD_OFFSET / 60;
      if (sender) r.x = sender.x; // follow sender if they move
      if (r.timer >= 60) {
        r.phase = "pause";
        r.timer = 0;
      }
    } else if (r.phase === "pause") {
      // Phase 2: Hover at sender's head for 1s (60 frames)
      if (sender) {
        r.x = sender.x;
        r.y = sender.y - HEAD_OFFSET + Math.sin(r.timer * 0.06) * 1.5;
      }
      if (r.timer >= 60) {
        r.phase = "fly";
        r.timer = 0;
      }
    } else if (r.phase === "fly") {
      // Phase 3: Fly toward target's head
      if (target) {
        const tx = target.x;
        const ty = target.y - HEAD_OFFSET;
        const dx = tx - r.x;
        const dy = ty - r.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 3) {
          const speed = Math.max(1.0, dist * 0.035);
          r.x += (dx / dist) * speed;
          r.y += (dy / dist) * speed;
        } else {
          r.phase = "hover";
          r.timer = 0;
        }
      } else {
        reactionEmojis.splice(i, 1);
        continue;
      }
      if (r.timer > 240) {
        r.phase = "hover";
        r.timer = 0;
      }
    } else if (r.phase === "hover") {
      // Phase 4: Stay above target's head for 8s (480 frames), fade out last 2s
      if (target) {
        r.x = target.x;
        r.y = target.y - HEAD_OFFSET + Math.sin(r.timer * 0.04) * 1.5;
      }
      if (r.timer >= 480) {
        reactionEmojis.splice(i, 1);
        continue;
      }
      r._fadeAlpha = r.timer >= 360 ? 1 - (r.timer - 360) / 120 : 1;
    }

    // Draw in screen space (like status emoji) to avoid scaling artifacts
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = r._fadeAlpha != null ? r._fadeAlpha : 1;
    ctx.font = f(16, false);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const sp = gameToScreen(r.x, r.y);
    ctx.fillText(r.emoji, sp.x, sp.y);
    ctx.restore();
  }
}

// ============================================================
// HEART PARTICLES (for petting)
// ============================================================

const hearts = [];

function spawnOneHeart(x, y) {
  hearts.push({
    x: x + (Math.random() - 0.5) * 6,
    y: y - 16,
    vx: (Math.random() - 0.5) * 0.5,
    vy: -0.8 - Math.random() * 0.5,
    life: 50,
    size: 8,
  });
}

function updateAndDrawHearts() {
  for (let i = hearts.length - 1; i >= 0; i--) {
    const h = hearts[i];
    h.x += h.vx;
    h.y += h.vy;
    h.vy += 0.02; // slight gravity
    h.life--;
    if (h.life <= 0) {
      hearts.splice(i, 1);
      continue;
    }
    const alpha = Math.min(1, h.life / 20);
    drawHeart(h.x, h.y, h.size, alpha);
  }
}

function drawHeart(hx, hy, size, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#e74c3c";
  ctx.beginPath();
  const s = size / 10;
  ctx.moveTo(hx, hy + 3 * s);
  ctx.bezierCurveTo(hx, hy, hx - 5 * s, hy, hx - 5 * s, hy + 3 * s);
  ctx.bezierCurveTo(hx - 5 * s, hy + 7 * s, hx, hy + 9 * s, hx, hy + 11 * s);
  ctx.bezierCurveTo(hx, hy + 9 * s, hx + 5 * s, hy + 7 * s, hx + 5 * s, hy + 3 * s);
  ctx.bezierCurveTo(hx + 5 * s, hy, hx, hy, hx, hy + 3 * s);
  ctx.fill();
  ctx.restore();
}

// ============================================================
// GIFT PILE (idle Lounge players get buried in gifts)
// ============================================================

const PILE_POSITIONS = [
  // Row 0 (bottom): 4 slots — around feet
  { dx: -10, dy: 8 }, { dx: -2, dy: 10 }, { dx: 6, dy: 9 }, { dx: 14, dy: 8 },
  // Row 1: 3 slots — on the body
  { dx: -7, dy: 2 }, { dx: 2, dy: 3 }, { dx: 11, dy: 1 },
  // Row 2: 2 slots — chest level
  { dx: -4, dy: -5 }, { dx: 6, dy: -4 },
  // Row 3 (top): 1 slot — on the head
  { dx: 1, dy: -12 },
];

const scatterGifts = [];

function drawGiftPile(player) {
  if (!player.giftPile || player.giftPile.length === 0) return;
  const gvp = getPlayerVisualPos(player);
  for (let i = 0; i < player.giftPile.length; i++) {
    const pos = PILE_POSITIONS[i];
    if (!pos) break;
    drawGift(player.giftPile[i], gvp.x + pos.dx, gvp.y + pos.dy);
  }
}

function spawnScatterGifts(x, y, gifts) {
  for (let i = 0; i < gifts.length; i++) {
    const pos = PILE_POSITIONS[i] || { dx: 0, dy: 0 };
    const angle = Math.atan2(pos.dy - 2, pos.dx) + (Math.random() - 0.5) * 0.8;
    const speed = 2 + Math.random() * 2.5;
    scatterGifts.push({
      x: x + pos.dx,
      y: y + pos.dy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      type: gifts[i],
      life: 350,   // ~5.8s at 60fps
      maxLife: 350,
      settled: false,
    });
  }
}

function updateAndDrawScatterGifts() {
  for (let i = scatterGifts.length - 1; i >= 0; i--) {
    const g = scatterGifts[i];
    if (!g.settled) {
      g.x += g.vx;
      g.y += g.vy;
      g.vy += 0.12; // gravity
      g.vx *= 0.95; // friction
      // Settle on ground after falling enough
      if (g.vy > 0 && g.life < g.maxLife - 15) {
        g.settled = true;
      }
    }
    g.life--;
    if (g.life <= 0) {
      scatterGifts.splice(i, 1);
      continue;
    }
    // Fade out in last 60 frames (~1s)
    const alpha = Math.min(1, g.life / 60);
    ctx.save();
    ctx.globalAlpha = alpha;
    drawGift(g.type, g.x, g.y);
    ctx.restore();
  }
}

// ============================================================
// FOCUS AURA (glow around focusing players)
// ============================================================
// Stages: 0-30min hidden, 30 white, 60 green, 90 blue, 120 purple, 150+ gold
// Loaded from /api/config (staging: 10s, prod: 30min)

let AURA_STAGE_MS = 1800000; // default prod value, overridden by /api/config

// Fetch env-aware config from server
fetch('/api/config').then(r => r.json()).then(cfg => {
  if (cfg.auraStageMs) AURA_STAGE_MS = cfg.auraStageMs;
  console.log(`[CONFIG] env=${cfg.env}, auraStageMs=${AURA_STAGE_MS}`);
}).catch(() => {});

const AURA_COLORS = [
  null,                  // stage 0: hidden
  [200, 220, 255],       // stage 1: cool white
  [40, 200, 90],         // stage 2: green
  [30, 110, 255],        // stage 3: blue
  [155, 60, 255],        // stage 4: purple
  [255, 180, 20],        // stage 5: gold
];

function drawFocusAura(player) {
  if (!player.isFocusing || !player.focusStartTime) return;
  const stage = Math.min(5, Math.floor((Date.now() - player.focusStartTime) / AURA_STAGE_MS));
  if (stage < 1) return;
  const color = AURA_COLORS[stage];
  if (!color) return;
  const [r, g, b] = color;
  const radius = 28 + stage * 5;
  const alpha = 0.30 + stage * 0.06;
  ctx.save();
  const grad = ctx.createRadialGradient(player.x, player.y - 14, 0, player.x, player.y - 14, radius);
  grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
  grad.addColorStop(0.5, `rgba(${r},${g},${b},${alpha * 0.5})`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(player.x, player.y - 14, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ============================================================
// PURR SOUND (Web Audio)
// ============================================================

function playPurr() {
  if (!soundEnabled) return;
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (!musicGain) {
      musicGain = audioCtx.createGain();
      musicGain.gain.value = cachedVolume * 0.3;
      musicGain.connect(audioCtx.destination);
    }
  }
  // Soft purring: low frequency rumble
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.value = 28; // Cat purr frequency ~25-30Hz
  lfo.frequency.value = 5;
  lfoGain.gain.value = 10;

  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.08, now + 0.1);
  gain.gain.linearRampToValueAtTime(0.06, now + 0.5);
  gain.gain.linearRampToValueAtTime(0, now + 1.2);

  osc.start(now);
  lfo.start(now);
  osc.stop(now + 1.3);
  lfo.stop(now + 1.3);
}

// ============================================================
// CAT CLICK HANDLER (pet the cat)
// ============================================================

// ============================================================
// PLAYER CARD & OVERLAP SELECTOR
// ============================================================

let playerCardTarget = null;
let playerCardOpenPos = null; // { x, y } game coords when card was opened
let playerCardRAF = null;
let playerCardLastScreen = null; // { x, y } last computed screen pos to skip redundant repositions
let reactionNotifications = [];
let reactionNotifIdCounter = 0;

// Delegated click handler for reaction notification names
document.addEventListener("click", (e) => {
  const el = e.target.closest(".reaction-name");
  if (!el) return;
  const pid = el.dataset.id;
  const uid = el.dataset.userid;
  const rect = el.getBoundingClientRect();
  const sx = rect.left + rect.width / 2, sy = rect.top;
  // Try exact socket-id match first
  let foundId = pid === myId ? myId : (otherPlayers[pid] ? pid : null);
  // If not found, player may have reconnected with a new socket — search by userId
  if (!foundId && uid) {
    const uidNum = parseInt(uid, 10);
    for (const id in otherPlayers) {
      if (otherPlayers[id]._userId === uidNum) { foundId = id; break; }
    }
  }
  if (foundId) {
    showPlayerCard(foundId, { x: sx, y: sy });
  } else {
    showOfflineTooltip(sx, sy, uid ? parseInt(uid, 10) : null);
  }
});

const LANG_DISPLAY = { en: "EN", "zh-CN": "\u7B80\u4E2D", "zh-TW": "\u7E41\u4E2D" };

function getTimePeriodForHour(h) {
  if (h < 5)  return { emoji: "\uD83C\uDF11", key: "timeLateNight" };
  if (h < 8)  return { emoji: "\uD83C\uDF05", key: "timeMorning" };
  if (h < 11) return { emoji: "\u2600\uFE0F",  key: "timeForenoon" };
  if (h < 13) return { emoji: "\uD83C\uDF24\uFE0F", key: "timeNoon" };
  if (h < 17) return { emoji: "\uD83C\uDF07", key: "timeAfternoon" };
  if (h < 19) return { emoji: "\uD83C\uDF06", key: "timeDusk" };
  return { emoji: "\uD83C\uDF11", key: "timeNight" };
}

function showOverlapSelector(players, screenX, screenY) {
  hidePlayerCard();
  storeSet("ui", "setOverlapSelectorTarget", { players: players.map(p => ({ id: p.id, name: (p.id === myId ? localPlayer?.name : otherPlayers[p.id]?.name) || "???" })), x: screenX, y: screenY });
}

function hideOverlapSelector() {
  storeSet("ui", "setOverlapSelectorTarget", null);
}

function showPlayerCard(targetId, screenPos) {
  hideOverlapSelector();
  const p = targetId === myId ? localPlayer : otherPlayers[targetId];
  if (!p) return;
  playerCardTarget = targetId;
  // Ensure self timezone is set
  if (targetId === myId && localPlayer.timezoneHour == null) {
    localPlayer.timezoneHour = new Date().getHours();
  }
  // Sync player data to React store so PlayerCard can read it
  storeSet("game", "updatePlayer", targetId, p);
  playerCardOpenPos = { x: p.x, y: p.y };
  // Use provided screen position (e.g. from chat click) or convert from game coords
  const screen = screenPos || gameToScreen(p.x, p.y - 40);
  storeSet("ui", "setPlayerCardTarget", { id: targetId, x: screen.x, y: screen.y });
}

function hidePlayerCard() {
  playerCardTarget = null;
  playerCardOpenPos = null;
  playerCardLastScreen = null;
  storeSet("ui", "setPlayerCardTarget", null);
  if (playerCardRAF) {
    cancelAnimationFrame(playerCardRAF);
    playerCardRAF = null;
  }
}

const REACTION_PAIR_COOLDOWN = 10000;
const reactionPairTimes = {};

const PROFESSION_COLORS_GAME = {
  tech: "#5EB8E0", creative: "#D4908C", business: "#D4A830",
  student: "#6DC06D", educator: "#4DC0B0", freelance: "#B0C8DC", mystery: "#A888D0",
};

function getProfessionColor(id) {
  const p = (id === myId) ? localPlayer : otherPlayers[id];
  const prof = p && p.profession ? p.profession : "mystery";
  return PROFESSION_COLORS_GAME[prof] || PROFESSION_COLORS_GAME.mystery;
}

function coloredName(name, id, userId) {
  return `<span class="reaction-name" data-id="${escapeHtml(id)}" data-userid="${userId || ""}" style="color:${getProfessionColor(id)};font-weight:bold;cursor:pointer">[${escapeHtml(name)}]</span>`;
}

function buildReactionText(data) {
  if (data.targetId === myId) {
    return `${coloredName(data.senderName, data.senderId, data.senderUserId)} ${t("reacted")} ${data.emoji}`;
  } else {
    if (currentLang === "zh") {
      return `${t("reactedTo")} ${coloredName(data.targetName, data.targetId, data.targetUserId)} ${t("reactedToSuffix")} ${data.emoji}`;
    }
    return `${t("reactedTo")} ${coloredName(data.targetName, data.targetId, data.targetUserId)} ${data.emoji}`;
  }
}

function showReactionNotification(data) {
  // Both rooms: show in notification panel (React chat handles its own display)
  addReactionToPanel(data);
}

function addReactionToPanel(data) {
  const id = ++reactionNotifIdCounter;
  const text = buildReactionText(data);
  reactionNotifications.push({ id, text, timestamp: data.timestamp });
  if (reactionNotifications.length > 10) reactionNotifications.shift();
  updateNotificationPanel();
}

function removeNotification(id) {
  reactionNotifications = reactionNotifications.filter(n => n.id !== id);
  updateNotificationPanel();
}

function updateNotificationPanel() {
  const panel = document.getElementById("reaction-notifications");
  const list = document.getElementById("reaction-list");
  list.innerHTML = "";
  if (reactionNotifications.length === 0) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "flex";
  [...reactionNotifications].reverse().forEach(n => {
    const d = new Date(n.timestamp);
    const timeStr = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const item = document.createElement("div");
    item.className = "reaction-item";
    item.innerHTML =
      `<span class="reaction-time">${timeStr}</span>` +
      `<span class="reaction-content">${n.text}</span>` +
      `<button class="reaction-close">&times;</button>`;
    item.querySelector(".reaction-close").addEventListener("click", () => removeNotification(n.id));
    list.appendChild(item);
  });
}



// Dismiss player card / overlap selector on outside click
document.addEventListener("click", (e) => {
  const card = document.getElementById("player-card");
  const sel = document.getElementById("player-overlap-selector");
  if (card && card.style.display !== "none" && card.style.display !== "" && !card.contains(e.target)) {
    hidePlayerCard();
  }
  if (sel && sel.style.display !== "none" && sel.style.display !== "" && !sel.contains(e.target)) {
    hideOverlapSelector();
  }
});

// --- Hover detection for player interaction hint ---
let hoveredPlayerId = null;
let mouseGameX = 0, mouseGameY = 0;
let interactHintShown = localStorage.getItem("interactHintShown") === "1";
let interactHintTimer = 0; // countdown frames for first-time hint

canvas.addEventListener("mousemove", (e) => {
  const { x, y } = screenToGame(e.clientX, e.clientY);
  mouseGameX = x;
  mouseGameY = y;
  let found = null;
  // Check other players + self
  const allP = { ...otherPlayers };
  if (localPlayer && myId) allP[myId] = localPlayer;
  for (const id in allP) {
    const p = allP[id];
    if (p.room !== currentRoom) continue;
    const dx = x - p.x;
    const dy = y - p.y;
    if (Math.abs(dx) < 25 && dy > -40 && dy < 15) {
      found = id;
      break;
    }
  }
  if (found !== hoveredPlayerId) {
    hoveredPlayerId = found;
    canvas.style.cursor = found ? "url('/icons/pointer.png') 8 0, pointer" : "";
  }
});
canvas.addEventListener("mouseleave", () => {
  hoveredPlayerId = null;
  canvas.style.cursor = "";
});

canvas.addEventListener("click", (e) => {
  const { x: clickX, y: clickY } = screenToGame(e.clientX, e.clientY);

  // If card or selector is open, close it (unless we clicked another player)
  const cardEl = document.getElementById("player-card");
  const selEl = document.getElementById("player-overlap-selector");
  const cardOpen = cardEl ? cardEl.style.display === "block" : !!playerCardTarget;
  const selectorOpen = selEl ? selEl.style.display === "flex" : false;

  // Check for player click — collect ALL matched players in hit area
  const matchedOthers = [];
  let selfHit = false;
  for (const id in otherPlayers) {
    const p = otherPlayers[id];
    if (p.room !== currentRoom) continue;
    const dx = clickX - p.x;
    const dy = clickY - p.y;
    if (Math.abs(dx) < 25 && dy > -40 && dy < 15) {
      const dist = Math.abs(dx) + Math.abs(dy);
      matchedOthers.push({ id, dist });
    }
  }
  // Check self hit
  if (localPlayer && myId) {
    const dx = clickX - localPlayer.x;
    const dy = clickY - localPlayer.y;
    if (Math.abs(dx) < 25 && dy > -40 && dy < 15) {
      selfHit = true;
    }
  }
  // Sort by distance so closest is first
  matchedOthers.sort((a, b) => a.dist - b.dist);

  // Prefer other players over self; only show self card when no others matched
  if (matchedOthers.length === 1) {
    e.stopPropagation();
    showPlayerCard(matchedOthers[0].id);
    return;
  } else if (matchedOthers.length > 1) {
    e.stopPropagation();
    showOverlapSelector(matchedOthers, e.clientX, e.clientY);
    return;
  } else if (selfHit) {
    e.stopPropagation();
    showPlayerCard(myId);
    return;
  }

  // Close card/selector if open and clicked elsewhere
  if (cardOpen || selectorOpen) {
    hidePlayerCard();
    hideOverlapSelector();
    return;
  }

  // Map object click (Tiled object layer - pets etc.)
  const mapObjs = ROOM_DATA[currentRoom].mapObjects;
  if (mapObjs && mapObjs.length && Date.now() > petInteractTimer) {
    for (const obj of mapObjs) {
      if (obj.type !== "pet" && obj.type !== "animal") continue;
      const ts = findTilesetForGID(obj.gid);
      if (!ts) continue;
      const cx = obj.x + ts.tileW / 2;
      const cy = obj.y + ts.tileH / 2;
      if (Math.abs(clickX - cx) < ts.tileW / 2 + 4 && Math.abs(clickY - cy) < ts.tileH / 2 + 4) {
        if (localPlayer && (!obj.allowedPlayer || localPlayer.name === obj.allowedPlayer)) {
          spawnOneHeart(cx, obj.y);
          playPurr();
        }
        petInteractTimer = Date.now() + 1000;
        return;
      }
    }
  }

  // Cat click — hit area covers the full sprite (32x32 anchored at bottom-center)
  if (catData.room !== currentRoom) return;
  const cdx = clickX - catData.x;
  const cdy = clickY - catData.y;
  if (Math.abs(cdx) < 18 && cdy > -28 && cdy < 10) {
    socket.emit("petCat");
  }
});

socket.on("catPetted", (data) => {
  if (data.ignoresPet) {
    // Zoomies/gift cat: too busy, ignores you completely
    return;
  }
  if (data.wasSleeping) {
    // Sleeping cat: just tail wag, no heart
    catSleepPetTimer = 40;
  } else {
    // Awake cat: one gentle heart + meow sound + floating text
    spawnOneHeart(data.x, data.y);
    playPurr();
    if (soundEnabled && Date.now() > catMeowCooldown) {
      catMeowAudio.currentTime = 0;
      catMeowAudio.volume = SOUND_MAX_VOL * (cachedVolume);
      catMeowAudio.play().catch(() => {});
      catMeowCooldown = Date.now() + 5000;
      catMiuTimer = 180;
      catMiuX = data.x;
      catMiuY = data.y - 24;
    }
  }
});

// ============================================================
// GAME STATE
// ============================================================

const otherPlayers = {};
let localPlayer = null;
let myId = null;
let portalCooldown = 0; // Prevent rapid room switching

const keys = { up: false, down: false, left: false, right: false };

// --- Focus timer state ---
let isFocusing = false;
let focusStartTime = null;
let focusCategory = null;
let focusTaskName = "";
let lastKeyPressTime = Date.now();
let hasCheckedIn = false;
let autoWalking = false;
let autoWalkPath = [];    // waypoint queue [{x,y}, ...]
let awStuckFrames = 0;
let catDragPhase = "none";  // "none" | "approach" | "dragging"
let catDragX = 0, catDragY = 0;  // cat position during approach phase
let catDragTargetX = 0, catDragTargetY = 0;  // approach target (leading position)
const IDLE_MS = 30000;          // post-focus auto-walk delay
const DAYDREAM_MS = 30 * 60 * 1000;   // 30min
const IDLE_LEAVE_MS = 30 * 60 * 1000; // 30min

// Find portal center from current room collision data
function findPortalInCurrentRoom() {
  const map = getCurrentMap();
  const rows = getRows(), cols = getCols();
  let sumX = 0, sumY = 0, count = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (map[r][c] === 8) {
        sumX += c * TILE + TILE / 2;
        sumY += r * TILE + TILE / 2;
        count++;
      }
    }
  }
  return count > 0 ? { x: sumX / count, y: sumY / count } : { x: 15 * TILE + 16, y: TILE / 2 };
}

function startAutoWalk() {
  if (localSitting) standUp();
  autoWalking = true;
  awStuckFrames = 0;
  const portal = findPortalInCurrentRoom();
  const path = findClientPath(localPlayer.x, localPlayer.y, portal.x, portal.y);
  autoWalkPath = path || [{ x: portal.x, y: portal.y }];
}

// Movement hint (PC first visit)
let moveHintTimer = null;
function showMoveHint() {
  const el = document.getElementById("move-hint");
  if (!el) return;
  el.style.display = "block";
  // Fade in after a short delay
  setTimeout(() => { el.style.opacity = "1"; }, 500);
  window.__hints?.showMoveHint?.();
}
function hideMoveHint() {
  const el = document.getElementById("move-hint");
  if (!el || el.style.display === "none") return;
  el.style.opacity = "0";
  setTimeout(() => { el.style.display = "none"; }, 500);
  if (moveHintTimer) { clearTimeout(moveHintTimer); moveHintTimer = null; }
  window.__hints?.hideMoveHint?.();
}

let focusPortalPending = false;
let postFocusTime = 0; // timestamp when focus ended, 0 = not in post-focus state
let emojiSuppressUntil = 0; // hide status emoji until this timestamp
let localSitting = false; // local player sitting state

// ============================================================
// INPUT
// ============================================================

document.addEventListener("keydown", (e) => {
  // Don't capture keys when typing in inputs (covers both old DOM IDs and React inputs)
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT" || e.target.isContentEditable) return;

  // Reset idle timer and cancel auto-walk / post-focus / daydreaming state
  lastKeyPressTime = Date.now();
  // Hide move hint only on actual movement keys
  const hintKeys = ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","w","W","a","A","s","S","d","D"];
  if (hintKeys.includes(e.key)) { hideMoveHint(); storeSet("game", "setPlayerHasMoved"); }
  if (autoWalking || catDragPhase !== "none") {
    autoWalking = false;
    autoWalkPath = [];
    catDragPhase = "none";
    postFocusTime = 0;
    document.getElementById("autowalk-hint").style.display = "none";
  }
  if (localPlayer && localPlayer.status === "daydreaming") {
    localPlayer.status = "wandering";
    socket.emit("setStatus", "wandering");
  }

  // Stand up on movement key if sitting
  if (localSitting && localPlayer) {
    const moveKeys = ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","w","W","a","A","s","S","d","D"];
    if (moveKeys.includes(e.key)) {
      standUp();
    }
  }

  // E to toggle sit/stand (like most PC games)
  if ((e.key === "e" || e.key === "E") && localPlayer) {
    // Already sitting → stand up first (highest priority)
    if (localSitting) {
      standUp();
      return;
    }
    // Bulletin board interaction
    const bb = getNearestBulletinBoard();
    if (bb && bb.dist <= BULLETIN_INTERACT_DIST) {
      openBulletinPopup();
      return;
    }
    const camp = getNearestCampfire();
    if (camp && camp.dist <= CAMPFIRE_INTERACT_DIST) {
      socket.emit("toggleCampfire", { id: camp.id, x: localPlayer.x, y: localPlayer.y });
      return;
    }
    {
      const seat = getNearestSittable(localPlayer.x, localPlayer.y);
      if (seat) {
        localPlayer.x = seat.x;
        localPlayer.y = seat.y;
        if (seat.seatType !== 15) localPlayer.direction = seat.direction;
        localPlayer.seatType = seat.seatType;
        localSitting = true;
        localPlayer.isSitting = true;
        emitPlayerSit(true);
        // Update lastSent to prevent game loop from emitting a redundant playerMove
        // (playerSit already broadcasts position via playerUpdated)
        lastSentX = localPlayer.x;
        lastSentY = localPlayer.y;
      }
    }
  }

  switch (e.key) {
    case "ArrowUp": case "w": case "W": keys.up = true; break;
    case "ArrowDown": case "s": case "S": keys.down = true; break;
    case "ArrowLeft": case "a": case "A": keys.left = true; break;
    case "ArrowRight": case "d": case "D": keys.right = true; break;
  }
});

document.addEventListener("keyup", (e) => {
  switch (e.key) {
    case "ArrowUp": case "w": case "W": keys.up = false; break;
    case "ArrowDown": case "s": case "S": keys.down = false; break;
    case "ArrowLeft": case "a": case "A": keys.left = false; break;
    case "ArrowRight": case "d": case "D": keys.right = false; break;
  }
});

document.addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key) &&
      e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && !e.target.isContentEditable) {
    e.preventDefault();
  }
});

// ============================================================
// UI CONTROLS
// ============================================================

let cachedVolume = 0.5;
const miniPiPToggle = document.getElementById("mini-pip-toggle");
const supportsDocumentPiP = !!(window.documentPictureInPicture && window.documentPictureInPicture.requestWindow);
let miniPiPWindow = null;
let miniOnlineCounts = { total: 0, focus: 0, lounge: 0 };
const MINI_MAP_AVATAR_SIZE = 24;
const MINI_MAP_FPS = 30;
const MINI_MAP_BASE_CACHE = new Map();
let miniMapAnimRunning = false;
let miniMapLastFrame = 0;
const MINI_PANEL_PADDING = 16;
const MINI_MAP_MIN_W = 320;
const MINI_MAP_MIN_H = 192;
const MINI_MAP_MAX_W = MINI_MAP_MIN_W * 2;
const MINI_MAP_W = MINI_MAP_MIN_W;
const MINI_MAP_H = MINI_MAP_MIN_H;
const MINI_MAP_WALKABLE = new Set([0, 5, 6, 7, 8, 9, 12, 13, 14, 15]);
const MINI_MAP_INTERACT = new Set([7, 8, 9, 12, 13, 14, 15]);
const MINI_PANEL_MIN_W = MINI_MAP_MIN_W + MINI_PANEL_PADDING * 2;
const MINI_PANEL_MAX_W = MINI_MAP_MAX_W + MINI_PANEL_PADDING * 2;
const MINI_PANEL_DEFAULT_W = MINI_PANEL_MIN_W;
const MINI_PANEL_DEFAULT_H = 380;
const MINI_PANEL_MAX_H = 720;
let miniFocusTaskDraft = "";
let miniPiPOptionLang = "";
const MINI_SHOW_PREF_KEY = "miniShowSections";
const MINI_SHOW_DEFAULT = { state: true, timer: true, map: true };
let miniShowSections = loadMiniShowSections();

function loadMiniShowSections() {
  try {
    const raw = localStorage.getItem(MINI_SHOW_PREF_KEY);
    if (!raw) return { ...MINI_SHOW_DEFAULT };
    const parsed = JSON.parse(raw);
    const state = !!parsed.state;
    const timer = !!parsed.timer;
    const map = !!parsed.map;
    if (!state && !timer && !map) return { ...MINI_SHOW_DEFAULT };
    return { state, timer, map };
  } catch (_) {
    return { ...MINI_SHOW_DEFAULT };
  }
}

function saveMiniShowSections() {
  try {
    localStorage.setItem(MINI_SHOW_PREF_KEY, JSON.stringify(miniShowSections));
  } catch (_) {}
}


// Used by miniPiP window to build online detail segments
function setOnlineDetailSegment(el, emoji, label, count) {
  if (!el) return;
  const ownerDoc = el.ownerDocument || document;
  let emojiEl = el.querySelector(".online-detail-emoji");
  let textEl = el.querySelector(".online-detail-text");
  let countEl = el.querySelector(".online-detail-count");
  if (!emojiEl || !textEl || !countEl) {
    el.textContent = "";
    emojiEl = ownerDoc.createElement("span");
    emojiEl.className = "online-detail-emoji";
    emojiEl.setAttribute("aria-hidden", "true");
    textEl = ownerDoc.createElement("span");
    textEl.className = "online-detail-text";
    countEl = ownerDoc.createElement("span");
    countEl.className = "online-detail-count";
    el.appendChild(emojiEl);
    el.appendChild(textEl);
    el.appendChild(countEl);
  }
  emojiEl.textContent = emoji;
  textEl.textContent = `${label}:`;
  countEl.textContent = String(count);
}

function isMiniPiPOpen() {
  return !!miniPiPWindow && !miniPiPWindow.closed;
}

function handleMiniFocusToggle() {
  if (currentRoom !== "focus") return;
  const miniDoc = isMiniPiPOpen() ? miniPiPWindow.document : null;
  const categoryEl = miniDoc ? miniDoc.getElementById("mini-focus-category") : null;
  const taskEl = miniDoc ? miniDoc.getElementById("mini-focus-task") : null;
  const category = (categoryEl && categoryEl.value) || selectedCategory || "working";
  const task = (taskEl ? taskEl.value : miniFocusTaskDraft).trim();
  if (isFocusing) {
    endFocus();
  } else {
    selectedCategory = category;
    miniFocusTaskDraft = task;
    startFocus(category, task);
  }
  if (taskEl) taskEl.dataset.dirty = "0";
  renderMiniPiPStatus();
}

function clampMiniPiPPanelSize() {
  if (!isMiniPiPOpen()) return;
  const w = miniPiPWindow.innerWidth || MINI_PANEL_DEFAULT_W;
  const h = miniPiPWindow.innerHeight || MINI_PANEL_DEFAULT_H;
  const cw = Math.max(MINI_PANEL_MIN_W, Math.min(MINI_PANEL_MAX_W, w));
  const ch = Math.max(100, Math.min(MINI_PANEL_MAX_H, h));
  if ((cw !== w || ch !== h) && typeof miniPiPWindow.resizeTo === "function") {
    try { miniPiPWindow.resizeTo(cw, ch); } catch (_) {}
  }
}

function miniEllipsize(ctx2d, text, maxWidth) {
  if (ctx2d.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx2d.measureText(out + "...").width > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + "...";
}

function miniStatusEmoji(player) {
  const key = player.isFocusing
    ? (player.focusCategory || player.status || "focusing")
    : (player.status || "wandering");
  return STATUS_EMOJI[key] || "";
}

function miniPlayersSnapshot() {
  const list = [];
  if (localPlayer) {
    list.push({
      ...localPlayer,
      id: myId || localPlayer.id || "self",
    });
  }
  for (const id in otherPlayers) {
    list.push(otherPlayers[id]);
  }
  return list;
}

function drawMiniAvatar(ctx2d, player, x, y, size) {
  const radius = size / 2;
  const left = Math.round(x - radius);
  const top = Math.round(y - radius) - 1;
  const pid = String(player.id || "unknown");
  const config = player.character || hashCharacter(pid);
  const sheet = getCharacterSheet(config);
  const isSelf = pid === String(myId || "");

  // Soft background to help the avatar stand out on the map.
  const bgR = radius + 2;
  const isFollowedPlayer = !isSelf && (player._userId ? isFollowed(player._userId) : isFollowed(player.id));
  ctx2d.save();
  ctx2d.fillStyle = isSelf ? "rgba(255,255,255,0.25)" : (isFollowedPlayer ? "rgba(255,143,171,0.25)" : "rgba(77,166,255,0.22)");
  ctx2d.beginPath();
  ctx2d.arc(x, y, bgR, 0, Math.PI * 2);
  ctx2d.fill();
  ctx2d.restore();

  ctx2d.save();
  ctx2d.beginPath();
  ctx2d.arc(x, y, radius, 0, Math.PI * 2);
  ctx2d.closePath();
  ctx2d.clip();

  if (sheet && sheet._loaded) {
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.drawImage(sheet, 3 * 32, 20, 32, 32, left, top, size, size);
  } else {
    ctx2d.fillStyle = lightenColor(hashColor(pid), 0.2);
    ctx2d.beginPath();
    ctx2d.arc(x, y, radius, 0, Math.PI * 2);
    ctx2d.fill();
  }
  ctx2d.restore();

  ctx2d.strokeStyle = isSelf ? NAME_COLORS.self : (isFollowedPlayer ? NAME_COLORS.followed : NAME_COLORS.others);
  ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  ctx2d.arc(x, y, radius + 0.5, 0, Math.PI * 2);
  ctx2d.stroke();
}

function drawMiniRoomMap(room, canvas, players) {
  if (!canvas) return;
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) return;

  const dims = ROOM_DIMS[room] || ROOM_DIMS.focus;
  const cols = Math.max(1, dims.cols || 32);
  const rows = Math.max(1, dims.rows || 18);
  const mapW = cols * TILE;
  const mapH = rows * TILE;
  const collision = (ROOM_DATA[room] && ROOM_DATA[room].collision) ? ROOM_DATA[room].collision : null;
  const mapRatio = cols / rows;
  const viewport = canvas.parentElement;
  const viewportW = Math.max(1, Math.round((viewport && viewport.clientWidth) || canvas.clientWidth || MINI_MAP_W));
  const minW = MINI_MAP_MIN_W;
  const maxW = MINI_MAP_MAX_W;
  let cssW = Math.max(minW, Math.min(maxW, viewportW));
  let cssH = Math.max(1, Math.round(cssW / mapRatio));
  if (canvas._cssW !== cssW || canvas._cssH !== cssH) {
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas._cssW = cssW;
    canvas._cssH = cssH;
  }
  const dpr = Math.max(1, Math.round(((miniPiPWindow && miniPiPWindow.devicePixelRatio) || window.devicePixelRatio || 1) * 100) / 100);
  const targetW = Math.max(1, Math.round(cssW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const tw = cssW / cols;
  const th = cssH / rows;

  const palette = room === "focus"
    ? {
        base: "#13233f",
        walk: "#1c335a",
        rug: "#20406f",
        desk: "#4f6f95",
        interact: "#6fcf97",
        wall: "#0c162b",
        obj: "#2a4672",
        portal: "#4d9fff",
      }
    : {
        base: "#2a1f44",
        walk: "#3a2a5d",
        rug: "#4a3773",
        desk: "#9c6f44",
        interact: "#7ed39f",
        wall: "#171229",
        obj: "#5b3d85",
        portal: "#e39b55",
      };

  const cacheKey = `${room}:${targetW}x${targetH}`;
  let baseCanvas = MINI_MAP_BASE_CACHE.get(cacheKey);
  if (!baseCanvas) {
    baseCanvas = document.createElement("canvas");
    baseCanvas.width = targetW;
    baseCanvas.height = targetH;
    const bctx = baseCanvas.getContext("2d");
    if (bctx) {
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.imageSmoothingEnabled = false;
      bctx.clearRect(0, 0, cssW, cssH);
      bctx.fillStyle = palette.base;
      bctx.fillRect(0, 0, cssW, cssH);

      if (collision && collision.length) {
        for (let r = 0; r < rows; r++) {
          const row = collision[r] || [];
          for (let c = 0; c < cols; c++) {
            const tile = row[c] == null ? 0 : row[c];
            let color = palette.walk;
            if (tile === 2) color = palette.desk;
            else if (tile === 8) color = palette.portal;
            else if (MINI_MAP_INTERACT.has(tile)) color = palette.interact;
            else if (tile === 5) color = palette.rug;
            else if (!MINI_MAP_WALKABLE.has(tile)) {
              color = (tile === 1 || tile === 11) ? palette.wall : palette.obj;
            }
            bctx.fillStyle = color;
            bctx.fillRect(
              Math.floor(c * tw),
              Math.floor(r * th),
              Math.ceil(tw) + 0.5,
              Math.ceil(th) + 0.5
            );
          }
        }
      }
    }
    MINI_MAP_BASE_CACHE.set(cacheKey, baseCanvas);
  }

  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.imageSmoothingEnabled = false;
  ctx2d.drawImage(baseCanvas, 0, 0);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

  const roomPlayers = players.filter((p) => (p.room || "focus") === room);
  ctx2d.save();
  ctx2d.beginPath();
  ctx2d.rect(2, 2, Math.max(0, cssW - 4), Math.max(0, cssH - 4));
  ctx2d.clip();
  ctx2d.font = f(14, false);
  ctx2d.textBaseline = "middle";
  ctx2d.textAlign = "left";

  for (const player of roomPlayers) {
    const px = Math.max(8, Math.min(cssW - 8, (player.x / mapW) * cssW));
    const py = Math.max(8, Math.min(cssH - 8, (player.y / mapH) * cssH));
    drawMiniAvatar(ctx2d, player, px, py, MINI_MAP_AVATAR_SIZE);

    const emoji = miniStatusEmoji(player);
    if (emoji) {
      const emojiY = py - (MINI_MAP_AVATAR_SIZE / 2) - 10;
      ctx2d.fillStyle = "#ffffff";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "middle";
      ctx2d.fillText(emoji, px, emojiY);
      ctx2d.textAlign = "left";
    }
  }
  ctx2d.restore();
}

function buildMiniPiPWindow(win) {
  const doc = win.document;
  doc.head.innerHTML = `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${t("online")}</title>
    <style>
      @font-face {
        font-family: 'FusionPixel';
        src: url('/fonts/fusion-pixel-12px-proportional-zh_hans.otf.woff2') format('woff2');
        unicode-range: U+4E00-9FFF, U+3400-4DBF, U+3000-303F, U+FF00-FFEF, U+2000-206F;
        font-display: swap;
      }
      @font-face {
        font-family: 'FusionPixel';
        src: url('/fonts/fusion-pixel-12px-proportional-latin.otf.woff2') format('woff2');
        unicode-range: U+0000-024F, U+1E00-1EFF, U+2100-214F, U+2200-22FF;
        font-display: swap;
      }
      :root {
        color-scheme: dark;
        --mini-pad: ${MINI_PANEL_PADDING}px;
        --mini-map-min: ${MINI_MAP_MIN_W}px;
        --mini-map-max: ${MINI_MAP_MAX_W}px;
      }
      * { box-sizing: border-box; }
      button, input, select, textarea { font-family: inherit; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(120% 120% at 90% 0%, rgba(126,200,227,0.15) 0%, rgba(25,26,37,0) 60%),
          radial-gradient(90% 90% at 0% 100%, rgba(232,180,248,0.16) 0%, rgba(25,26,37,0) 62%),
          #191a25;
        color: #eee;
        font-family: ${currentFont()};
        font-size: 14px;
      }
      #mini-card {
        padding: var(--mini-pad);
        display: flex;
        flex-direction: column;
        gap: 10px;
        align-items: center;
      }
      .mini-section {
        width: 100%;
        max-width: var(--mini-map-max);
        min-width: var(--mini-map-min);
      }
      #mini-filter-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        font-size: 13px;
        color: rgba(220,230,255,0.8);
      }
      #mini-filter-label {
        font-weight: 600;
        color: #dce6ff;
      }
      .mini-filter-option {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .mini-filter-option input[type="checkbox"] {
        width: 14px;
        height: 14px;
        accent-color: #7ec8e3;
      }
      #mini-head {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        min-height: 24px;
      }
      #mini-online-row {
        display: flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
        min-width: 0;
      }
      #mini-online-total {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: #eee;
        font-weight: bold;
      }
      #mini-online-status-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #mini-online-status-emoji {
        font-size: 15px;
        line-height: 1;
        width: 15px;
        height: 15px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #mini-online-count {
        font-size: 16px;
        color: #53d769;
        min-width: 12px;
        text-align: left;
        font-variant-numeric: tabular-nums;
      }
      .mini-online-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 14px;
        line-height: 1;
        white-space: nowrap;
      }
      .mini-online-item .online-detail-emoji {
        font-size: 15px;
        line-height: 1;
        width: 15px;
        height: 15px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
      }
      .mini-online-item .online-detail-text,
      .mini-online-item .online-detail-count {
        font-size: 14px;
        line-height: 1;
      }
      #mini-online-focus { color: #7ec8e3; }
      #mini-online-lounge { color: #e8b4f8; }
      .mini-online-sep {
        color: rgba(220,230,255,0.35);
        font-size: 13px;
        line-height: 1;
      }
      .mini-online-dot {
        color: rgba(220,230,255,0.45);
        font-size: 16px;
        line-height: 1;
      }
      #mini-focus-block {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #mini-focus-fields {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #mini-focus-category {
        appearance: none;
        border: 1px solid rgba(15,52,96,0.5);
        background: rgba(15, 27, 56, 0.45) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(220,230,255,0.5)'/%3E%3C/svg%3E") no-repeat right 10px center;
        color: rgba(220,230,255,0.75);
        border-radius: 4px;
        padding: 8px 28px 8px 12px;
        height: 32px;
        font-size: 14px;
        line-height: 1;
        min-width: 112px;
      }
      #mini-focus-task {
        border: 1px solid rgba(15,52,96,0.5);
        background: rgba(15, 27, 56, 0.45);
        color: rgba(220,230,255,0.75);
        border-radius: 4px;
        padding: 8px 12px;
        height: 32px;
        font-size: 14px;
        line-height: 1;
        min-width: 130px;
        flex: 1;
      }
      #mini-focus-task:focus,
      #mini-focus-category:focus {
        outline: none;
        border-color: rgba(126,200,227,0.5);
      }
      #mini-focus-action {
        appearance: none;
        border: 1px solid rgba(245,166,35,0.4);
        background: rgba(245,166,35,0.08);
        color: rgba(245,166,35,0.8);
        border-radius: 4px;
        padding: 8px 12px;
        height: 32px;
        width: 100%;
        font-size: 14px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        flex: 0 0 auto;
        font-variant-numeric: tabular-nums;
      }
      #mini-focus-action.active {
        background: rgba(245,166,35,0.15);
      }
      #mini-focus-action:disabled {
        border-color: rgba(68,91,130,0.3);
        color: rgba(143,152,184,0.6);
        background: rgba(68,91,130,0.1);
        cursor: not-allowed;
      }
      #mini-map-wrap {
        height: 200px;
        display: flex;
        align-items: flex-start;
        justify-content: flex-start;
        overflow: hidden;
      }
      .mini-map-viewport {
        width: 100%;
        min-height: 0;
        display: flex;
        align-items: flex-start;
        justify-content: flex-start;
        overflow: hidden;
      }
      .mini-map-canvas {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 6px;
        background: #10182c;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
        pointer-events: none;
      }
    </style>
  `;
  const stateChecked = miniShowSections.state ? "checked" : "";
  const timerChecked = miniShowSections.timer ? "checked" : "";
  const mapChecked = miniShowSections.map ? "checked" : "";
  doc.body.innerHTML = `
    <div id="mini-card">
      <div id="mini-filter-row" class="mini-section">
        <span id="mini-filter-label"></span>
        <label class="mini-filter-option">
          <input type="checkbox" id="mini-show-state" ${stateChecked} />
          <span id="mini-label-state"></span>
        </label>
        <label class="mini-filter-option">
          <input type="checkbox" id="mini-show-timer" ${timerChecked} />
          <span id="mini-label-timer"></span>
        </label>
        <label class="mini-filter-option">
          <input type="checkbox" id="mini-show-map" ${mapChecked} />
          <span id="mini-label-map"></span>
        </label>
      </div>
      <div id="mini-head" class="mini-section">
        <div id="mini-online-row">
          <span id="mini-online-total">
            <span id="mini-online-status-icon" aria-hidden="true">
              <span id="mini-online-status-emoji">🟢</span>
            </span>
            <span id="mini-online-count">0</span>
          </span>
          <span class="mini-online-sep">｜</span>
          <span id="mini-online-focus" class="mini-online-item"></span>
          <span class="mini-online-dot">·</span>
          <span id="mini-online-lounge" class="mini-online-item"></span>
        </div>
      </div>
      <div id="mini-focus-block" class="mini-section">
        <div id="mini-focus-fields">
          <select id="mini-focus-category">
            <option value="working"></option>
            <option value="studying"></option>
            <option value="reading"></option>
            <option value="writing"></option>
            <option value="creating"></option>
            <option value="exercising"></option>
          </select>
          <input id="mini-focus-task" type="text" maxlength="50" />
        </div>
        <button id="mini-focus-action" type="button"></button>
      </div>
      <div id="mini-map-wrap" class="mini-section">
        <div class="mini-map-viewport">
          <canvas class="mini-map-canvas" id="mini-map-current" width="${MINI_MAP_W}" height="${MINI_MAP_H}"></canvas>
        </div>
      </div>
    </div>
  `;

  const focusBtn = doc.getElementById("mini-focus-action");
  if (focusBtn) {
    focusBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleMiniFocusToggle();
    });
  }

  const categoryEl = doc.getElementById("mini-focus-category");
  if (categoryEl) {
    categoryEl.addEventListener("change", () => {
      selectedCategory = categoryEl.value || "working";
      renderMiniPiPStatus();
    });
  }

  const taskEl = doc.getElementById("mini-focus-task");
  if (taskEl) {
    taskEl.addEventListener("input", () => {
      miniFocusTaskDraft = taskEl.value;
      taskEl.dataset.dirty = "1";
    });
    taskEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleMiniFocusToggle();
      }
    });
  }

  const bindFilter = (key, id) => {
    const input = doc.getElementById(id);
    if (!input) return;
    input.addEventListener("change", () => {
      const next = { ...miniShowSections, [key]: input.checked };
      if (!next.state && !next.timer && !next.map) {
        input.checked = true;
        return;
      }
      miniShowSections = next;
      saveMiniShowSections();
      applyMiniSectionVisibility(doc);
      renderMiniPiPStatus();
      autoResizeMiniPiP();
    });
  };
  bindFilter("state", "mini-show-state");
  bindFilter("timer", "mini-show-timer");
  bindFilter("map", "mini-show-map");

  // Auto-hide filter row when mouse leaves, show on hover
  _miniFilterVisible = true;
  doc.body.addEventListener("mouseenter", resetMiniFilterTimer);
  doc.body.addEventListener("mousemove", resetMiniFilterTimer);
  doc.body.addEventListener("mouseleave", () => {
    clearTimeout(_miniFilterTimer);
    _miniFilterTimer = setTimeout(() => setMiniFilterVisible(false), 10000);
  });
  // Start initial hide timer
  _miniFilterTimer = setTimeout(() => setMiniFilterVisible(false), 10000);
}

function updateMiniPiPButton() {
  if (!miniPiPToggle) return;
  if (!supportsDocumentPiP) {
    miniPiPToggle.disabled = true;
    miniPiPToggle.textContent = t("miniUnsupported");
    miniPiPToggle.title = t("miniUnsupported");
    return;
  }
  miniPiPToggle.disabled = false;
  const text = isMiniPiPOpen() ? t("miniClose") : t("miniOpen");
  miniPiPToggle.textContent = text;
  miniPiPToggle.title = text;
}

function renderMiniPiPStatus() {
  if (!isMiniPiPOpen()) return;
  const doc = miniPiPWindow.document;
  const setText = (id, value) => {
    const el = doc.getElementById(id);
    if (el) el.textContent = value;
  };

  setText("mini-filter-label", t("miniShowLabel"));
  setText("mini-label-state", t("miniShowState"));
  setText("mini-label-timer", t("miniShowTimer"));
  setText("mini-label-map", t("miniShowMap"));
  const stateInput = doc.getElementById("mini-show-state");
  const timerInput = doc.getElementById("mini-show-timer");
  const mapInput = doc.getElementById("mini-show-map");
  if (stateInput) stateInput.checked = !!miniShowSections.state;
  if (timerInput) timerInput.checked = !!miniShowSections.timer;
  if (mapInput) mapInput.checked = !!miniShowSections.map;
  applyMiniSectionVisibility(doc);

  doc.title = `🟢 ${miniOnlineCounts.total} ${t("online")}`;
  setText("mini-online-count", String(miniOnlineCounts.total));
  setOnlineDetailSegment(doc.getElementById("mini-online-focus"), "📖", t("focusZone"), miniOnlineCounts.focus);
  setOnlineDetailSegment(doc.getElementById("mini-online-lounge"), "☕", t("lounge"), miniOnlineCounts.lounge);

  const focusAction = isFocusing ? t("endFocus") : t("startFocus");
  const timerText = (isFocusing && focusStartTime) ? formatFocusTime(Date.now() - focusStartTime) : "--:--";

  const categoryEl = doc.getElementById("mini-focus-category");
  const categoryDefs = [
    ["working", "catWorking"],
    ["studying", "catStudying"],
    ["reading", "catReading"],
    ["writing", "catWriting"],
    ["creating", "catCreating"],
    ["exercising", "catExercising"],
  ];
  if (categoryEl) {
    if (miniPiPOptionLang !== currentLang) {
      for (let i = 0; i < categoryDefs.length; i++) {
        const opt = categoryEl.options[i];
        if (opt) opt.textContent = t(categoryDefs[i][1]);
      }
      miniPiPOptionLang = currentLang;
    }
    if (doc.activeElement !== categoryEl) {
      const catVal = isFocusing ? (focusCategory || selectedCategory || "working") : (selectedCategory || "studying");
      if (categoryEl.value !== catVal) categoryEl.value = catVal;
    }
    categoryEl.disabled = false;
  }

  const taskEl = doc.getElementById("mini-focus-task");
  if (taskEl) {
    taskEl.placeholder = t("taskPlaceholder");
    if (isFocusing && doc.activeElement !== taskEl && taskEl.dataset.dirty !== "1") {
      taskEl.value = focusTaskName || "";
      taskEl.dataset.dirty = "0";
    } else if (!isFocusing && doc.activeElement !== taskEl && taskEl.dataset.dirty !== "1") {
      taskEl.value = miniFocusTaskDraft;
    }
    taskEl.disabled = false;
  }

  const focusBtn = doc.getElementById("mini-focus-action");
  if (focusBtn) {
    focusBtn.textContent = isFocusing ? timerText : focusAction;
    focusBtn.disabled = currentRoom !== "focus";
    focusBtn.classList.toggle("active", isFocusing);
  }

  const roomKey = currentRoom === "rest" ? "rest" : "focus";
  const roomDims = ROOM_DIMS[roomKey] || ROOM_DIMS.focus;
  const mapCanvas = doc.getElementById("mini-map-current");
  if (mapCanvas && roomDims && roomDims.cols && roomDims.rows) {
    mapCanvas.style.aspectRatio = `${roomDims.cols} / ${roomDims.rows}`;
  }
}

function startMiniMapLoop() {
  if (miniMapAnimRunning) return;
  miniMapAnimRunning = true;
  miniMapLastFrame = 0;
  requestAnimationFrame(miniMapLoop);
}

function miniMapLoop(now) {
  if (!isMiniPiPOpen()) {
    miniMapAnimRunning = false;
    return;
  }
  if (!miniShowSections.map) {
    requestAnimationFrame(miniMapLoop);
    return;
  }
  const minDelta = 1000 / MINI_MAP_FPS;
  if (!miniMapLastFrame || now - miniMapLastFrame >= minDelta) {
    miniMapLastFrame = now;
    const doc = miniPiPWindow.document;
    const roomKey = currentRoom === "rest" ? "rest" : "focus";
    const mapCanvas = doc.getElementById("mini-map-current");
    const players = miniPlayersSnapshot();
    drawMiniRoomMap(roomKey, mapCanvas, players);
  }
  requestAnimationFrame(miniMapLoop);
}

function closeMiniPiPWindow() {
  if (!isMiniPiPOpen()) {
    miniPiPWindow = null;
    updateMiniPiPButton();
    return;
  }
  miniPiPWindow.close();
  miniPiPWindow = null;
  updateMiniPiPButton();
}

function applyMiniSectionVisibility(doc) {
  const stateEl = doc.getElementById("mini-head");
  const timerEl = doc.getElementById("mini-focus-block");
  const mapEl = doc.getElementById("mini-map-wrap");
  const inLounge = currentRoom === "rest";
  if (stateEl) stateEl.style.display = miniShowSections.state ? "flex" : "none";
  if (timerEl) timerEl.style.display = (!inLounge && miniShowSections.timer) ? "flex" : "none";
  if (mapEl) mapEl.style.display = miniShowSections.map ? "flex" : "none";
  // Hide timer filter option in Lounge
  const timerFilterLabel = doc.getElementById("mini-show-timer");
  if (timerFilterLabel && timerFilterLabel.parentElement) {
    timerFilterLabel.parentElement.style.display = inLounge ? "none" : "";
  }
}

let _miniAutoResizing = false;
let _miniFilterTimer = 0;
let _miniFilterVisible = true;

function setMiniFilterVisible(show) {
  if (!isMiniPiPOpen()) return;
  const row = miniPiPWindow.document.getElementById('mini-filter-row');
  if (!row || _miniFilterVisible === show) return;
  _miniFilterVisible = show;
  row.style.display = show ? 'flex' : 'none';
  autoResizeMiniPiP();
}

function resetMiniFilterTimer() {
  clearTimeout(_miniFilterTimer);
  if (!_miniFilterVisible) setMiniFilterVisible(true);
  _miniFilterTimer = setTimeout(() => setMiniFilterVisible(false), 10000);
}

function autoResizeMiniPiP() {
  if (!isMiniPiPOpen() || typeof miniPiPWindow.resizeTo !== 'function') return;
  const card = miniPiPWindow.document.getElementById('mini-card');
  if (!card) return;
  const chrome = (miniPiPWindow.outerHeight - miniPiPWindow.innerHeight) || 0;
  const targetH = card.offsetHeight + chrome;
  if (targetH === miniPiPWindow.outerHeight) return;
  _miniAutoResizing = true;
  try { miniPiPWindow.resizeTo(miniPiPWindow.outerWidth, targetH); } catch (_) {}
  setTimeout(() => { _miniAutoResizing = false; }, 500);
}

async function openMiniPiPWindow() {
  if (!supportsDocumentPiP || isMiniPiPOpen()) return;
  try {
    miniPiPWindow = await window.documentPictureInPicture.requestWindow({
      width: MINI_PANEL_DEFAULT_W,
      height: MINI_PANEL_DEFAULT_H,
    });
    buildMiniPiPWindow(miniPiPWindow);
    clampMiniPiPPanelSize();
    miniPiPWindow.addEventListener("resize", () => {
      if (_miniAutoResizing) return;
      clampMiniPiPPanelSize();
      renderMiniPiPStatus();
    });
    miniPiPWindow.addEventListener("pagehide", () => {
      clearTimeout(_miniFilterTimer);
      miniPiPWindow = null;
      updateMiniPiPButton();
    }, { once: true });
    updateMiniPiPButton();
    renderMiniPiPStatus();
    startMiniMapLoop();
    autoResizeMiniPiP();
  } catch (err) {
    console.warn("[MiniPiP] Failed to open mini window:", err);
    miniPiPWindow = null;
    updateMiniPiPButton();
  }
}

if (miniPiPToggle) {
  miniPiPToggle.addEventListener("click", async () => {
    if (isMiniPiPOpen()) {
      closeMiniPiPWindow();
    } else {
      await openMiniPiPWindow();
    }
  });
  updateMiniPiPButton();
}

setInterval(() => {
  if (isMiniPiPOpen()) renderMiniPiPStatus();
}, 300);

function closeSettingsPanel() {
  storeSet("ui", "setSettingsOpen", false);
}

function showAuthForm(mode) {
  storeSet("ui", "setAuthOpen", true, mode);
}

function hideAuthForm() {
  storeSet("ui", "setAuthOpen", false);
}

const savedName = localStorage.getItem("playerName");
let editingFromSettings = false;

function openWelcomeEditorFromSettings() {
  editingFromSettings = true;
  storeSet("ui", "setWelcomeOpen", true);
}

function syncTagline(tagline) {
  savedTagline = tagline;
  localStorage.setItem("playerTagline", tagline);
  if (localPlayer) {
    localPlayer.tagline = tagline;
    socket.emit("setTagline", tagline);
  }
}

function syncLanguages() {
  localStorage.setItem("playerLanguages", JSON.stringify(selectedLanguages));
  if (localPlayer) {
    localPlayer.languages = [...selectedLanguages];
    socket.emit("setLanguages", selectedLanguages);
  }
}

function syncTimezoneHour() {
  const hour = new Date().getHours();
  if (localPlayer) {
    localPlayer.timezoneHour = hour;
    socket.emit("setTimezoneHour", hour);
  }
}

// Character counter functions removed — React components handle their own char counting

// Debug helpers (console)
window.setGameTime = (hour) => setDebugTimeHour(hour);
window.clearGameTime = () => setDebugTimeHour(null);
window.getGameTime = () => (debugTimeHour !== null && debugTimeHour !== undefined ? debugTimeHour : new Date().getHours());

if (savedName) {
  hasCheckedIn = true;
  // React bridge: close React welcome popup for returning users
  const _closeWelcome = () => {
    if (window.__stores?.ui) { window.__stores.ui.getState().setWelcomeOpen(false); }
    else { setTimeout(_closeWelcome, 50); }
  };
  setTimeout(_closeWelcome, 0);
  // Send saved data for returning users
  setTimeout(() => {
    if (localPlayer) {
      if (savedTagline) {
        localPlayer.tagline = savedTagline;
        socket.emit("setTagline", savedTagline);
      }
      if (selectedLanguages.length) {
        localPlayer.languages = [...selectedLanguages];
        socket.emit("setLanguages", selectedLanguages);
      }
      if (savedProfession) {
        localPlayer.profession = savedProfession;
        socket.emit("setProfession", savedProfession);
      }
      syncTimezoneHour();
    }
  }, 500);
}

// React bridge: handle welcome enter from React WelcomePopup
window.__onWelcomeEnter = function(data) {
  const name = (data.name || "").trim() || "Anonymous";
  const tagline = (data.tagline || "").trim();
  const langs = data.languages || ["en"];
  localStorage.setItem("playerName", name);
  localStorage.setItem("charConfig", JSON.stringify(selectedCharConfig));
  if (localPlayer) {
    localPlayer.name = name;
    localPlayer.character = selectedCharConfig;
    socket.emit("setName", name);
    socket.emit("setCharacter", selectedCharConfig);
  }
  savedTagline = tagline;
  localStorage.setItem("playerTagline", tagline);
  if (localPlayer) {
    localPlayer.tagline = tagline;
    socket.emit("setTagline", tagline);
  }
  selectedLanguages = langs;
  localStorage.setItem("playerLanguages", JSON.stringify(langs));
  if (localPlayer) {
    localPlayer.languages = [...langs];
    socket.emit("setLanguages", langs);
  }
  // Birth month
  const birthMonth = data.birthMonth != null ? data.birthMonth : null;
  localStorage.setItem("playerBirthMonth", birthMonth != null ? String(birthMonth) : "");
  if (localPlayer) {
    localPlayer.birthMonth = birthMonth;
    socket.emit("setBirthMonth", birthMonth);
  }
  // Profession
  const prof = data.profession || "mystery";
  savedProfession = prof;
  localStorage.setItem("playerProfession", prof);
  if (localPlayer) {
    localPlayer.profession = prof;
    socket.emit("setProfession", prof);
  }
  syncTimezoneHour();
  // Sync updated profile to React store immediately
  if (localPlayer && myId) storeSet("game", "updatePlayer", myId, localPlayer);
  storeSet("ui", "setWelcomeOpen", false);
  hasCheckedIn = true;
  lastKeyPressTime = Date.now();
  if (!isTouchDevice) showMoveHint();
};

// --- Chat ---
let sendScope = "room"; // input bar scope: "room" | "nearby"

const CHAT_COOLDOWN_MS = 1500;
const CHAT_BURST_WINDOW = 15000;
const CHAT_BURST_MAX = 5;
const CHAT_MUTE_MS = 10000;
const chatSendTimes = [];
let chatMutedUntil = 0;

function isChatRateLimited() {
  const now = Date.now();
  if (now < chatMutedUntil) return true;
  if (chatSendTimes.length && now - chatSendTimes[chatSendTimes.length - 1] < CHAT_COOLDOWN_MS) return true;
  const recent = chatSendTimes.filter(t => now - t < CHAT_BURST_WINDOW);
  if (recent.length >= CHAT_BURST_MAX) {
    chatMutedUntil = now + CHAT_MUTE_MS;
    return true;
  }
  return false;
}

// --- Chat bubbles above characters ---
const chatBubbles = {};
const BUBBLE_DURATION = 5000;

function addChatMessage(msg, isHistory) {
  // Chat bubble (skip for history)
  if (!isHistory && msg.type !== "system") {
    const msgScope = msg.scope || "room";
    if (msg.id) {
      chatBubbles[msg.id] = { text: msg.text.length > 30 ? msg.text.slice(0, 30) + "..." : msg.text, time: Date.now(), scope: msgScope };
    }
  }
  // DOM chat panel now handled by React ChatPanel
}

function escapeHtml(str) {
  const el = document.createElement("div");
  el.textContent = str;
  return el.innerHTML;
}

const FOCUS_STATUS_KEYS = ["working", "studying", "reading", "writing", "creating", "exercising", "coding"];
const REST_STATUS_KEYS = ["resting", "chatting", "listening", "watching", "napping", "snacking", "browsing"];

function updateRoomUI() {
  hidePlayerCard();
  hideOverlapSelector();
  storeSet("game", "setRoom", currentRoom);
  storeSet("chat", "setChatVisible", currentRoom === "rest");
  if (currentRoom === "rest") storeSet("chat", "setChatCollapsed", false);

  if (currentRoom === "focus") {
    if (localPlayer && !isFocusing) {
      localPlayer.status = "wandering";
      socket.emit("setStatus", "wandering");
    }
  } else {
    if (localPlayer) {
      localPlayer.status = "resting";
      socket.emit("setStatus", "resting");
      emojiSuppressUntil = 0;
    }
  }

  updateFocusUI();
}

// ============================================================
// FOCUS TIMER UI
// ============================================================

let selectedCategory = "working";

function showFocusPortalConfirm() {
  storeSet("ui", "setPortalConfirmOpen", true);
}

function getCategoryLabel(category) {
  const map = { working: "catWorking", studying: "catStudying", reading: "catReading", writing: "catWriting", creating: "catCreating", exercising: "catExercising" };
  return t(map[category] || category);
}

function startFocus(category, taskName) {
  isFocusing = true;
  focusStartTime = Date.now();
  focusCategory = category;
  focusTaskName = taskName || getCategoryLabel(category);
  miniFocusTaskDraft = taskName || miniFocusTaskDraft;
  lastKeyPressTime = Date.now();
  autoWalking = false;
  catDragPhase = "none";
  postFocusTime = 0;
  emojiSuppressUntil = 0;

  if (localPlayer) {
    localPlayer.isFocusing = true;
    localPlayer.focusStartTime = focusStartTime;
    localPlayer.focusCategory = category;
    localPlayer.status = category;
    socket.emit("setStatus", category);
  }

  socket.emit("startFocus", { category });
  localStorage.setItem("currentFocusTask", focusTaskName);
  storeSet("focus", "startFocus", category, taskName);
  updateFocusUI();
}

function endFocus() {
  if (!isFocusing) return;

  const elapsed = Date.now() - focusStartTime;
  saveFocusRecord(focusTaskName, focusCategory, elapsed, focusStartTime);

  isFocusing = false;
  focusStartTime = null;
  focusCategory = null;
  focusTaskName = "";
  autoWalking = false;
  catDragPhase = "none";
  lastKeyPressTime = Date.now();
  postFocusTime = Date.now(); // Start post-focus state
  emojiSuppressUntil = Date.now() + 30000; // Suppress emoji during post-focus

  if (localPlayer) {
    localPlayer.isFocusing = false;
    localPlayer.focusStartTime = null;
    localPlayer.focusCategory = null;
    localPlayer.status = "wandering";
    socket.emit("setStatus", "wandering");
  }

  socket.emit("endFocus");
  localStorage.removeItem("currentFocusTask");
  storeSet("focus", "endFocus");
  updateFocusUI();
}

function updateFocusUI() {
  renderMiniPiPStatus();
}

function formatFocusTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;
  }
  return `${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;
}

// ============================================================
// FOCUS HISTORY (localStorage)
// ============================================================

function saveFocusRecord(taskName, category, durationMs, startTimestamp) {
  if (durationMs < 5000) return;
  // Don't store auto-generated category label as taskName
  const cleanName = (taskName === getCategoryLabel(category)) ? "" : taskName;
  const record = {
    taskName: cleanName,
    category,
    duration: durationMs,
    startTime: startTimestamp,
    endTime: Date.now(),
  };
  const records = JSON.parse(localStorage.getItem("focusHistory") || "[]");
  records.push(record);
  if (records.length > 100) records.splice(0, records.length - 100);
  localStorage.setItem("focusHistory", JSON.stringify(records));
  // Sync to server (all users have DB rows)
  if (socket && socket.connected) {
    socket.emit("saveFocusRecord", record);
  }
}

// ============================================================
// FOCUS HISTORY UI
// ============================================================


// Escape handler for popups (React components handle their own Escape too)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && bulletinPopupOpen) {
    closeBulletinPopup();
  }
});

// ============================================================
// WEEKLY RECAP POPUP
// ============================================================

// openRecapPopup removed — React RecapPopup handles rendering via __onRecapOpen

function getHistoryRecords() {
  try {
    return JSON.parse(localStorage.getItem("focusHistory") || "[]");
  } catch (e) {
    return [];
  }
}

function getDayKey(timestamp) {
  const d = new Date(timestamp);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function getDayLabel(dateStr) {
  const parts = dateStr.split("-");
  return parts[1] + "/" + parts[2];
}

function formatHistoryDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return totalMin + " " + t("historyMin");
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h + t("historyH") + " " + m + t("historyMin");
}

function deleteHistoryRecord(startTime) {
  const records = getHistoryRecords();
  const idx = records.findIndex(r => r.startTime === startTime);
  if (idx !== -1) {
    records.splice(idx, 1);
    localStorage.setItem("focusHistory", JSON.stringify(records));
  }
}

// renderHistoryPanel, renderHeatmap, getCategoryIcon removed — React HistoryPopup handles rendering

// ============================================================
// AUDIO
// ============================================================

let audioCtx = null;
let musicGain = null;
let soundEnabled = false;

// Focus sounds (proximity-based, per category)
const focusSounds = {
  working: new Audio("/sounds/typing.mp3"),
  studying: new Audio("/sounds/writing.mp3"),
  creating: new Audio("/sounds/writing.mp3"),
  reading: new Audio("/sounds/page-flip.mp3"),
};
for (const key in focusSounds) {
  if (key !== "reading") focusSounds[key].loop = true;
  focusSounds[key].volume = 0;
}

const SOUND_MAX_DIST = 150;  // max distance to hear sound (game units)
const SOUND_MIN_DIST = 20;   // distance for full volume
const SOUND_MAX_VOL = 0.6;
let nextPageFlipTime = 0;

function updateFocusSounds() {
  if (!soundEnabled || !localPlayer) {
    for (const key in focusSounds) {
      focusSounds[key].volume = 0;
      if (!focusSounds[key].paused) focusSounds[key].pause();
    }
    return;
  }

  // Track closest distance per sound category
  const closest = { working: Infinity, studying: Infinity, creating: Infinity, reading: Infinity };

  for (const id in otherPlayers) {
    const p = otherPlayers[id];
    if (p.room !== currentRoom || !p.isFocusing) continue;
    const cat = p.focusCategory || "working";
    const dx = localPlayer.x - p.x;
    const dy = localPlayer.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (closest[cat] !== undefined && dist < closest[cat]) closest[cat] = dist;
  }

  // Local player's own focus sound
  if (isFocusing) {
    const cat = focusCategory || "working";
    if (closest[cat] !== undefined) closest[cat] = Math.min(closest[cat], 0);
  }

  // Update each sound channel
  for (const cat in focusSounds) {
    const audio = focusSounds[cat];
    const dist = closest[cat];

    if (dist > SOUND_MAX_DIST) {
      audio.volume = 0;
      if (!audio.paused) audio.pause();
    } else {
      const t = Math.max(0, Math.min(1, (SOUND_MAX_DIST - dist) / (SOUND_MAX_DIST - SOUND_MIN_DIST)));
      const vol = t * t * SOUND_MAX_VOL * (cachedVolume);

      if (cat === "reading") {
        // Play at random 20~40s intervals
        const now = Date.now();
        if (now >= nextPageFlipTime) {
          nextPageFlipTime = now + 20000 + Math.random() * 20000;
          audio.currentTime = 0;
          audio.volume = Math.min(1, Math.max(0, vol));
          audio.play().catch(() => {});
        }
      } else {
        audio.volume = Math.min(1, Math.max(0, vol));
        if (audio.paused) {
          audio.play().catch(() => {});
        }
      }
    }
  }
}

// Time-of-day ambient sounds (near window, proximity-based)
const ambientSounds = {
  morning: new Audio("/sounds/morning.mp3"),         // 6:00 - 11:00
  daytime: new Audio("/sounds/yuk1to-street-ambience-traffic-410714.mp3"), // 11:00 - 17:00
  night:   new Audio("/sounds/night.mp3"),            // 19:00 - 05:00
};
for (const key in ambientSounds) {
  ambientSounds[key].loop = true;
  ambientSounds[key].volume = 0;
}
let currentAmbientKey = null;

const AMBIENT_MAX_DIST = 120;
const AMBIENT_MIN_DIST = 20;
const AMBIENT_MAX_VOL = 0.4;
// Window positions: row 0, columns where c > 1 && c < 30 && c % 4 === 0
const WINDOW_POSITIONS = [];
for (let c = 4; c < 30; c += 4) {
  WINDOW_POSITIONS.push({ x: c * TILE + TILE / 2, y: TILE / 2 });
}

function getAmbientKey() {
  const hour = getTimezoneHour();
  if (hour < 5) return "night";
  if (hour < 8) return "morning";
  if (hour < 17) return "daytime";
  if (hour < 19) return "dusk";
  return "night"; // 19:00 - 24:00
}

function stopAllAmbient() {
  for (const key in ambientSounds) {
    ambientSounds[key].volume = 0;
    if (!ambientSounds[key].paused) ambientSounds[key].pause();
  }
  currentAmbientKey = null;
}

function updateAmbientSound() {
  if (!soundEnabled || !localPlayer) {
    stopAllAmbient();
    return;
  }

  const wantKey = getAmbientKey();

  // Stop old ambient if time period changed
  if (wantKey !== currentAmbientKey) {
    stopAllAmbient();
    currentAmbientKey = wantKey;
  }

  if (!wantKey) return;

  const audio = ambientSounds[wantKey] || ambientSounds["daytime"];

  // Find closest window
  let closestDist = Infinity;
  for (const wp of WINDOW_POSITIONS) {
    const dx = localPlayer.x - wp.x;
    const dy = localPlayer.y - wp.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < closestDist) closestDist = dist;
  }

  if (closestDist > AMBIENT_MAX_DIST) {
    audio.volume = 0;
    if (!audio.paused) audio.pause();
  } else {
    const t = Math.max(0, Math.min(1, (AMBIENT_MAX_DIST - closestDist) / (AMBIENT_MAX_DIST - AMBIENT_MIN_DIST)));
    const vol = t * t * AMBIENT_MAX_VOL * (cachedVolume);
    audio.volume = Math.min(1, Math.max(0, vol));
    if (audio.paused) {
      audio.play().catch(() => {});
    }
  }
}

// Door sound (played once on portal transit)
const doorAudio = new Audio("/sounds/door.MP3");
function playDoorSound() {
  if (!soundEnabled) return;
  doorAudio.currentTime = 0;
  doorAudio.volume = SOUND_MAX_VOL * (cachedVolume);
  doorAudio.play().catch(() => {});
}

// Sliding door sound (entrance & jp_door open/close)
const doorSlidingAudio = new Audio("/sounds/door_sliding.MP3");
let lastDoorSlideTime = 0;
function playDoorSlidingSound() {
  if (!soundEnabled) return;
  const now = Date.now();
  if (now - lastDoorSlideTime < 200) return;
  lastDoorSlideTime = now;
  doorSlidingAudio.currentTime = 0;
  doorSlidingAudio.volume = SOUND_MAX_VOL * (cachedVolume);
  doorSlidingAudio.play().catch(() => {});
}

// Wooden door sound (studyRoomDoor): play once on open
const doorWoodenAudio = new Audio("/sounds/door_wooden.mp3");
let lastDoorWoodenTime = 0;
function playDoorWoodenSound() {
  if (!soundEnabled) return;
  const now = Date.now();
  if (now - lastDoorWoodenTime < 200) return;
  lastDoorWoodenTime = now;
  doorWoodenAudio.currentTime = 0;
  doorWoodenAudio.volume = SOUND_MAX_VOL * (cachedVolume);
  doorWoodenAudio.play().catch(() => {});
}

// Cat meow (proximity-triggered)
const catMeowAudio = new Audio("/sounds/cat-meow.mp3");
const CAT_MEOW_DIST = 60;
let catWasNear = false;
let catMeowCooldown = 0;

function updateCatMeow() {
  if (!soundEnabled || !localPlayer || catData.room !== currentRoom) {
    catWasNear = false;
    return;
  }

  const dx = localPlayer.x - catData.x;
  const dy = localPlayer.y - catData.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const isNear = dist < CAT_MEOW_DIST;
  const now = Date.now();

  // Trigger on entering proximity (only when sit/wander/curious)
  const catState = catData.state;
  if (isNear && !catWasNear && now > catMeowCooldown && (catState === "sit" || catState === "wander" || catState === "curious")) {
    if (Math.random() < 0.2) {
      catMeowAudio.currentTime = 0;
      catMeowAudio.volume = SOUND_MAX_VOL * (cachedVolume);
      catMeowAudio.play().catch(() => {});
      catMeowCooldown = now + 10000;
      // Floating text
      catMiuTimer = 180;
      catMiuX = catData.x;
      catMiuY = catData.y - 24;
    }
  }
  catWasNear = isNear;
}

// Campfire sound (proximity-based, only when lit)
const campfireAudio = new Audio("/sounds/fire.mp3");
campfireAudio.loop = true;
campfireAudio.volume = 0;
const CAMPFIRE_SOUND_MAX_DIST = TILE * 8; // ~8 tiles
const CAMPFIRE_SOUND_MIN_DIST = TILE * 2;
const CAMPFIRE_SOUND_MAX_VOL = 0.5;

function updateCampfireSound() {
  if (!soundEnabled || !localPlayer) {
    campfireAudio.volume = 0;
    if (!campfireAudio.paused) campfireAudio.pause();
    return;
  }

  const objs = ROOM_DATA[currentRoom].mapObjects;
  const states = campfireStates[currentRoom];
  if (!objs || !objs.length || !states) {
    campfireAudio.volume = 0;
    if (!campfireAudio.paused) campfireAudio.pause();
    return;
  }

  let closestDist = Infinity;
  for (const obj of objs) {
    if (!states[obj.id]) continue; // only lit campfires
    const ts = findTilesetForGID(obj.gid);
    if (!isCampfireObj(obj, ts)) continue;
    const { w, h } = getObjDrawSize(obj, ts);
    const cx = obj.x + w / 2;
    const cy = obj.y + h / 2;
    const dx = localPlayer.x - cx;
    const dy = localPlayer.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < closestDist) closestDist = dist;
  }

  if (!Number.isFinite(closestDist) || closestDist > CAMPFIRE_SOUND_MAX_DIST) {
    campfireAudio.volume = 0;
    if (!campfireAudio.paused) campfireAudio.pause();
  } else {
    const t = Math.max(0, Math.min(1, (CAMPFIRE_SOUND_MAX_DIST - closestDist) / (CAMPFIRE_SOUND_MAX_DIST - CAMPFIRE_SOUND_MIN_DIST)));
    const vol = t * t * CAMPFIRE_SOUND_MAX_VOL * (cachedVolume);
    campfireAudio.volume = Math.min(1, Math.max(0, vol));
    if (campfireAudio.paused) {
      campfireAudio.play().catch(() => {});
    }
  }
}

// Frog sound (proximity-based)
const frogAudio = new Audio("/sounds/frog-croaking.mp3");
frogAudio.loop = true;
frogAudio.volume = 0;
const FROG_SOUND_MAX_DIST = TILE * 6; // ~6 tiles
const FROG_SOUND_MIN_DIST = TILE * 1.5;
const FROG_SOUND_MAX_VOL = 0.45;

function isFrogObj(obj, ts) {
  const tsName = ts && ts.name ? ts.name.toLowerCase() : "";
  const objType = String(obj.type || "").toLowerCase();
  const objName = String(obj.name || "").toLowerCase();
  return tsName.includes("frog") || objType.includes("frog") || objName.includes("frog");
}

function isButterflyObj(obj, ts) {
  const tsName = ts && ts.name ? ts.name.toLowerCase() : "";
  const objType = String(obj.type || "").toLowerCase();
  const objName = String(obj.name || "").toLowerCase();
  return tsName.includes("butterfly") || objType.includes("butterfly") || objName.includes("butterfly");
}

function isFishObj(obj, ts) {
  const tsName = ts && ts.name ? ts.name.toLowerCase() : "";
  const objType = String(obj.type || "").toLowerCase();
  const objName = String(obj.name || "").toLowerCase();
  return tsName.includes("fish") || objType.includes("fish") || objName.includes("fish");
}

function isWaterObj(obj, ts) {
  const tsName = ts && ts.name ? ts.name.toLowerCase() : "";
  const objType = String(obj.type || "").toLowerCase();
  const objName = String(obj.name || "").toLowerCase();
  return tsName.includes("water_tileset") || objType.includes("water") || objName.includes("water");
}

const BUTTERFLY_STATE_HIDDEN = { visible: false, static: false, moveToWater: false };
const BUTTERFLY_STATE_STATIC = { visible: true, static: true, moveToWater: false };
const BUTTERFLY_STATE_ACTIVE = { visible: true, static: false, moveToWater: false };
const BUTTERFLY_STATE_WATER = { visible: true, static: false, moveToWater: true };

function getButterflyState() {
  const hour = getTimezoneHour();
  if (hour >= 6 && hour < 8) return BUTTERFLY_STATE_STATIC;
  if (hour >= 8 && hour < 10) return BUTTERFLY_STATE_ACTIVE;
  if (hour >= 12 && hour < 14) return BUTTERFLY_STATE_WATER;
  if (hour >= 15 && hour < 17) return BUTTERFLY_STATE_ACTIVE;
  return BUTTERFLY_STATE_HIDDEN;
}

const BUTTERFLY_WATER_POS = { x: 1192, y: 452 };
const BUTTERFLY_WATER_STILL_MS = 3200;
const BUTTERFLY_WATER_FLAP_MS = 3200;
const BUTTERFLY_WATER_FRAME_MS = 700;

function getButterflyWaterFrame(obj, ts, now) {
  const cycle = BUTTERFLY_WATER_STILL_MS + BUTTERFLY_WATER_FLAP_MS;
  const offset = (obj.id || 0) * 97;
  const t = (now + offset) % cycle;
  if (t < BUTTERFLY_WATER_STILL_MS) return 0;
  const flapT = t - BUTTERFLY_WATER_STILL_MS;
  return Math.floor(flapT / BUTTERFLY_WATER_FRAME_MS) % ts.frameCount;
}

function getButterflyWaterPos(_roomKey, _bw, _bh) {
  return BUTTERFLY_WATER_POS;
}

function isFrogActiveTime() {
  const hour = getTimezoneHour();
  const isDusk = hour >= 17 && hour < 19;
  const isNight = hour >= 19 && hour < 24;
  const isLateNight = hour >= 0 && hour < 5;
  return isDusk || isNight || isLateNight;
}

function isFishActiveTime() {
  const hour = getTimezoneHour();
  return (hour >= 4 && hour < 8) || (hour >= 15 && hour < 19);
}

function updateFrogSound() {
  if (!soundEnabled || !localPlayer) {
    frogAudio.volume = 0;
    if (!frogAudio.paused) frogAudio.pause();
    return;
  }
  if (!isFrogActiveTime()) {
    frogAudio.volume = 0;
    if (!frogAudio.paused) frogAudio.pause();
    return;
  }

  const objs = ROOM_DATA[currentRoom].mapObjects;
  if (!objs || !objs.length) {
    frogAudio.volume = 0;
    if (!frogAudio.paused) frogAudio.pause();
    return;
  }

  let closestDist = Infinity;
  for (const obj of objs) {
    const ts = findTilesetForGID(obj.gid);
    if (!isFrogObj(obj, ts)) continue;
    const { w, h } = getObjDrawSize(obj, ts);
    const cx = obj.x + w / 2;
    const cy = obj.y + h / 2;
    const dx = localPlayer.x - cx;
    const dy = localPlayer.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < closestDist) closestDist = dist;
  }

  if (!Number.isFinite(closestDist) || closestDist > FROG_SOUND_MAX_DIST) {
    frogAudio.volume = 0;
    if (!frogAudio.paused) frogAudio.pause();
  } else {
    const t = Math.max(0, Math.min(1, (FROG_SOUND_MAX_DIST - closestDist) / (FROG_SOUND_MAX_DIST - FROG_SOUND_MIN_DIST)));
    const vol = t * t * FROG_SOUND_MAX_VOL * (cachedVolume);
    frogAudio.volume = Math.min(1, Math.max(0, vol));
    if (frogAudio.paused) {
      frogAudio.play().catch(() => {});
    }
  }
}

function startMusic() {}
function stopMusic() {}
function switchMusic() {}

// musicToggle listener removed — React SettingsPanel handles sound toggle via __onSoundToggle

// ============================================================
// SOCKET EVENTS
// ============================================================

socket.on("roomDimensions", (dims) => {
  if (dims.focus) ROOM_DIMS.focus = dims.focus;
  if (dims.rest) ROOM_DIMS.rest = dims.rest;
});

socket.on("connect", () => {
  renderMiniPiPStatus();
});

socket.on("disconnect", () => {
  renderMiniPiPStatus();
});

socket.on("currentPlayers", (players) => {
  myId = socket.id;
  // Clear stale entries from previous connection
  for (const id in otherPlayers) delete otherPlayers[id];
  storeSet("game", "setLocalPlayerId", myId);
  storeSet("game", "setPlayers", players);
  for (const id in players) {
    if (id === myId) {
      localPlayer = players[id];
      // Check if this user appears to be registered (authEmail in localStorage
      // is set by login flow and cleared by logout — reliable pre-sessionRestored signal)
      const likelyRegistered = !!localStorage.getItem("authEmail");
      if (likelyRegistered) {
        // Registered user: server has authoritative profile from DB
        // Update local state from server data
        selectedCharConfig = localPlayer.character;
        localStorage.setItem("selectedCharacter", JSON.stringify(selectedCharConfig));
        localStorage.setItem("playerName", localPlayer.name);
        localStorage.setItem("playerTagline", localPlayer.tagline || "");
        localStorage.setItem("playerLanguages", JSON.stringify(localPlayer.languages || []));
        localStorage.setItem("playerBirthMonth", localPlayer.birthMonth != null ? String(localPlayer.birthMonth) : "");
        localStorage.setItem("playerProfession", localPlayer.profession || "mystery");
        savedProfession = localPlayer.profession || "mystery";
      } else {
        // Guest: apply saved local profile to server
        const sn = localStorage.getItem("playerName");
        if (sn) {
          localPlayer.name = sn;
          socket.emit("setName", sn);
        }
        // Apply saved character on connect
        localPlayer.character = selectedCharConfig;
        socket.emit("setCharacter", selectedCharConfig);
        // Apply saved birth month
        const savedBM = localStorage.getItem("playerBirthMonth");
        if (savedBM) {
          const bm = parseInt(savedBM, 10);
          if (bm >= 1 && bm <= 12) {
            localPlayer.birthMonth = bm;
            socket.emit("setBirthMonth", bm);
          }
        }
        // Apply saved profession
        if (savedProfession) {
          localPlayer.profession = savedProfession;
          socket.emit("setProfession", savedProfession);
        }
      }
      // Always sync timezoneHour to server (it's not stored in DB)
      const currentHour = new Date().getHours();
      localPlayer.timezoneHour = currentHour;
      socket.emit("setTimezoneHour", currentHour);
      currentRoom = localPlayer.room;
      updateRoomUI();
      // Re-sync focus state if locally focusing (e.g. after server restart)
      if (isFocusing && focusStartTime) {
        socket.emit("startFocus", { category: focusCategory || "study" });
      }
    } else {
      otherPlayers[id] = players[id];
    }
  }
  updateOnlineCount();
});

socket.on("sessionRestored", (data) => {
  if (data.resumed) {
    console.log("[SESSION] Resumed existing session");

    // Restore position/room/state from server snapshot
    if (localPlayer) {
      localPlayer.room = data.room;
      localPlayer.x = data.x;
      localPlayer.y = data.y;
      localPlayer.isFocusing = data.isFocusing;
      localPlayer.focusStartTime = data.focusStartTime;
      localPlayer.focusCategory = data.focusCategory;
      localPlayer.giftPile = data.giftPile || [];
      localPlayer.isSitting = data.isSitting;
      localPlayer.status = data.status;
      localSitting = data.isSitting;
    }

    currentRoom = data.room;
    updateRoomUI();

    // Restore focus timer state
    if (data.isFocusing && data.focusStartTime) {
      isFocusing = true;
      focusStartTime = data.focusStartTime;
      focusCategory = data.focusCategory;
      const savedTask = localStorage.getItem("currentFocusTask");
      focusTaskName = savedTask || getCategoryLabel(data.focusCategory);
      updateFocusUI();
    }

    // Sync lastSent so game loop doesn't emit a spurious playerMove
    lastSentX = localPlayer.x;
    lastSentY = localPlayer.y;

    // Suppress welcome popup and entrance walk
    hasCheckedIn = true;
    document.getElementById("welcome-popup").classList.add("hidden");
    storeSet("ui", "setWelcomeOpen", false);
    autoWalking = false;
    catDragPhase = "none";
    autoWalkPath = [];
    lastKeyPressTime = Date.now();
  } else {
    // Store session token from server
    if (data.sessionToken) localStorage.setItem("sessionToken", data.sessionToken);
  }
  // Store guest authToken if newly created
  if (data.authToken) {
    authToken = data.authToken;
    localStorage.setItem("authToken", data.authToken);
  }
  // Store userId for all users
  if (data.userId) {
    myUserId = data.userId;
  }
  // Update auth state from server
  isRegistered = !!data.isRegistered;
  if (data.email) authEmail = data.email;
  if (data.focusRecords && data.focusRecords.length > 0) {
    mergeFocusRecords(data.focusRecords);
  }
  // Version check: show update banner if server restarted with new build
  if (data.buildId) {
    if (!window.__buildId) {
      window.__buildId = data.buildId;
    } else if (window.__buildId !== data.buildId) {
      storeSet("ui", "setUpdateAvailable", true);
    }
  }
});

// Visibility API: reset idle timers when tab becomes visible
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) lastKeyPressTime = Date.now();
});

// Tab close: end focus (save record) + remove player immediately
function handlePageClose(e) {
  if (isFocusing) {
    // Save focus record before leaving
    const elapsed = Date.now() - focusStartTime;
    saveFocusRecord(focusTaskName, focusCategory, elapsed, focusStartTime);
    localStorage.removeItem("currentFocusTask");
    if (e.type === "beforeunload") e.preventDefault(); // triggers native "Leave site?" dialog
  }
  if (isRecording || recProcessing) {
    if (e.type === "beforeunload") e.preventDefault(); // warn: recording in progress
  }
  socket.emit("intentionalClose");
  recFrames = [];
}
window.addEventListener("beforeunload", handlePageClose);
window.addEventListener("pagehide", handlePageClose);

socket.on("playerJoined", (player) => {
  otherPlayers[player.id] = player;
  storeSet("game", "updatePlayer", player.id, player);
  updateOnlineCount();
});

socket.on("playerLeft", (id) => {
  if (playerCardTarget === id) hidePlayerCard();
  delete otherPlayers[id];
  storeSet("game", "removePlayer", id);
  updateOnlineCount();
});

socket.on("playerMoved", (data) => {
  if (otherPlayers[data.id]) {
    otherPlayers[data.id].x = data.x;
    otherPlayers[data.id].y = data.y;
    otherPlayers[data.id].direction = data.direction;
  }
  renderMiniPiPStatus();
});

socket.on("playerUpdated", (player) => {
  if (player.id === myId) {
    localPlayer.name = player.name;
    localPlayer.status = player.status;
    // Don't overwrite local character — client is source of truth for own character
    localPlayer.isFocusing = player.isFocusing;
    localPlayer.focusStartTime = player.focusStartTime;
    localPlayer.focusCategory = player.focusCategory;
    localPlayer.isSitting = player.isSitting;
    localPlayer.tagline = player.tagline;
    localPlayer.languages = player.languages;
    localPlayer.timezoneHour = player.timezoneHour;
    localPlayer.birthMonth = player.birthMonth;
    localSitting = player.isSitting;
    updateFocusUI();
  } else if (otherPlayers[player.id]) {
    otherPlayers[player.id].name = player.name;
    otherPlayers[player.id].status = player.status;
    otherPlayers[player.id].character = player.character;
    otherPlayers[player.id].isFocusing = player.isFocusing;
    otherPlayers[player.id].focusStartTime = player.focusStartTime;
    otherPlayers[player.id].focusCategory = player.focusCategory;
    otherPlayers[player.id].isSitting = player.isSitting;
    if (player.direction) otherPlayers[player.id].direction = player.direction;
    otherPlayers[player.id].tagline = player.tagline;
    otherPlayers[player.id].languages = player.languages;
    otherPlayers[player.id].timezoneHour = player.timezoneHour;
    otherPlayers[player.id].birthMonth = player.birthMonth;
    storeSet("game", "updatePlayer", player.id, otherPlayers[player.id]);
  }
  updateOnlineCount();
});

socket.on("playerChangedRoom", (data) => {
  if (data.id === myId) {
    // End focus on room change
    if (isFocusing) {
      const elapsed = Date.now() - focusStartTime;
      saveFocusRecord(focusTaskName, focusCategory, elapsed, focusStartTime);
      isFocusing = false;
      focusStartTime = null;
      focusCategory = null;
      focusTaskName = "";
      localStorage.removeItem("currentFocusTask");
    }
    // Sync localPlayer focus fields
    localPlayer.isFocusing = false;
    localPlayer.focusStartTime = null;
    localPlayer.focusCategory = null;
    localPlayer.status = "resting";

    const wasAutoWalk = autoWalking;
    autoWalking = false;
    catDragPhase = "none";
    autoWalkPath = [];
    focusPortalPending = false;
    postFocusTime = 0; // Clear post-focus state on room change
    localSitting = false;
    localPlayer.isSitting = false;

    localPlayer.room = data.room;
    localPlayer.x = data.x;
    localPlayer.y = data.y;
    currentRoom = data.room;
    updateRoomUI();
    switchMusic();

    if (wasAutoWalk && data.room === "rest") {
      const msg = { type: "system", text: t("catSummonedYou"), time: Date.now() };
      addChatMessage(msg);
      storeSet("chat", "addMessage", msg);
    }
  } else if (otherPlayers[data.id]) {
    otherPlayers[data.id].room = data.room;
    otherPlayers[data.id].x = data.x;
    otherPlayers[data.id].y = data.y;
    // Server resets focus on room change
    otherPlayers[data.id].isFocusing = false;
    otherPlayers[data.id].focusStartTime = null;
    otherPlayers[data.id].focusCategory = null;
    otherPlayers[data.id].isSitting = false;
  }
  updateOnlineCount();
});

// Gift pile events
socket.on("giftPileUpdated", (data) => {
  const target = data.id === myId ? localPlayer : otherPlayers[data.id];
  if (target) {
    // Track new gifts received by local player
    const oldLen = (target.giftPile && target.giftPile.length) || 0;
    target.giftPile = data.giftPile;
    if (data.id === myId && data.giftPile.length > oldLen) {
      bumpLocalStat("catGiftsReceived", data.giftPile.length - oldLen);
    }
  }
});

socket.on("giftPileScatter", (data) => {
  spawnScatterGifts(data.x, data.y, data.gifts);
  const target = data.id === myId ? localPlayer : otherPlayers[data.id];
  if (target) target.giftPile = [];
});

socket.on("chatMessage", (msg) => {
  addChatMessage(msg);
  storeSet("chat", "addMessage", msg);
});

socket.on("chatHistory", (history) => {
  storeSet("chat", "clearMessages");
  for (const msg of history) {
    addChatMessage(msg, true);
    storeSet("chat", "addMessage", msg);
  }
});

socket.on("catUpdate", (data) => {
  // Store server target for lerp interpolation
  data._targetX = data.x;
  data._targetY = data.y;
  // Preserve current lerped position if same room
  if (catData.room === data.room && catData._targetX !== undefined) {
    data.x = catData.x;
    data.y = catData.y;
  }
  catData = data;
  renderMiniPiPStatus();
});

socket.on("campfireStates", (data) => {
  if (!data) return;
  for (const room in data) {
    if (!campfireStates[room]) campfireStates[room] = {};
    Object.assign(campfireStates[room], data[room]);
  }
});

socket.on("campfireUpdate", (data) => {
  if (!data || !data.room || data.id == null) return;
  if (!campfireStates[data.room]) campfireStates[data.room] = {};
  campfireStates[data.room][data.id] = !!data.lit;
});

socket.on("bulletinNotes", (data) => {
  if (!data) return;
  if (data.announcements) storeSet("bulletin", "setAnnouncements", data.announcements);
  if (data.notes) storeSet("bulletin", "setNotes", data.notes);
  if (data.myLikedIds) storeSet("bulletin", "setMyLikes", data.myLikedIds);
});

socket.on("bulletinNoteAdded", (note) => {
  if (!note || !bulletinPopupOpen) return;
  socket.emit("getBulletinNotes");
});

socket.on("bulletinNoteDeleted", () => {
  if (!bulletinPopupOpen) return;
  socket.emit("getBulletinNotes");
});

socket.on("bulletinNoteLikeUpdated", () => {
  if (!bulletinPopupOpen) return;
  socket.emit("getBulletinNotes");
});

socket.on("emojiReaction", (data) => {
  console.log("[REACT] Received emojiReaction:", data.senderName, "->", data.targetName, data.emoji,
    "room:", data.room, "myRoom:", currentRoom, "myId:", myId,
    "iAmSender:", data.senderId === myId, "iAmTarget:", data.targetId === myId);
  // Only show floating emoji if we're in the same room
  if (data.room === currentRoom) {
    spawnReactionEmoji(data.senderId, data.targetId, data.emoji);
  }
  // Show notification to both sender and target
  if (data.targetId === myId || data.senderId === myId) {
    showReactionNotification(data);
  }
  // Track reactions received locally
  if (data.targetId === myId) bumpLocalStat("reactionsReceived", 1);
});

function updateOnlineCount() {
  let focusCount = 0;
  let loungeCount = 0;
  if (currentRoom === "focus") focusCount++; else loungeCount++;
  for (const id in otherPlayers) {
    if (otherPlayers[id].room === "focus") focusCount++; else loungeCount++;
  }
  const total = focusCount + loungeCount;
  miniOnlineCounts = { total, focus: focusCount, lounge: loungeCount };
  storeSet("game", "setOnlineCount", { total, focus: focusCount, lounge: loungeCount });
  renderMiniPiPStatus();
}

// ============================================================
// REACT UI BRIDGE — window.__onXxx callbacks
// React components call these; game.js executes the logic.
// ============================================================

// Offline tooltip (vanilla DOM, shared by notification panel + React bridge)
let _offlineTooltipTimer = null;
let _offlineTooltipEl = null;
function showOfflineTooltip(sx, sy, userId) {
  clearTimeout(_offlineTooltipTimer);
  // Always ensure element is freshly in the DOM
  if (_offlineTooltipEl && _offlineTooltipEl.parentNode) {
    _offlineTooltipEl.parentNode.removeChild(_offlineTooltipEl);
  }
  const el = document.createElement("div");
  el.id = "offline-tooltip";
  el.style.display = "none";
  document.body.appendChild(el);
  _offlineTooltipEl = el;
  const show = (text) => {
    el.textContent = text;
    el.style.cssText = `position:fixed;display:block;left:${sx}px;top:${sy}px;transform:translate(-50%,-100%);margin-top:-6px;background:#1e2636;color:#a0a0a0;font-size:12px;padding:4px 8px;border-radius:4px;white-space:nowrap;pointer-events:none;z-index:9999;opacity:1;transition:opacity .15s`;
    _offlineTooltipTimer = setTimeout(() => { el.style.display = "none"; }, 3000);
  };
  if (userId) {
    el.style.display = "none";
    fetch(`/api/last-seen/${userId}`).then(r => r.json()).then(data => {
      if (data.online) {
        // Player is online — try to open their card (they may have reconnected)
        for (const id in otherPlayers) {
          if (otherPlayers[id]._userId === userId) {
            showPlayerCard(id, { x: sx, y: sy });
            return;
          }
        }
        // Online but not visible locally (different room) — skip
        return;
      }
      if (data.lastSeen) {
        const sec = Math.floor((Date.now() - data.lastSeen) / 1000);
        let ago;
        if (sec < 60) ago = t("agoJustNow");
        else if (sec < 3600) ago = t("agoMin").replace("{n}", Math.floor(sec / 60));
        else if (sec < 86400) ago = t("agoHr").replace("{n}", Math.floor(sec / 3600));
        else ago = t("agoDay").replace("{n}", Math.floor(sec / 86400));
        show(ago);
      } else {
        show(t("notOnline"));
      }
    }).catch(() => show(t("notOnline")));
  } else {
    show(t("notOnline"));
  }
}

// Show player card from UI (e.g. chat name click) at given screen position
// Returns false if player is offline (not found)
window.__showPlayerCard = function(id, screenX, screenY) {
  const p = id === myId ? localPlayer : otherPlayers[id];
  if (!p) return false;
  showPlayerCard(id, { x: screenX, y: screenY });
  return true;
};

// --- Chat ---
window.__onChatSend = function(text, scope) {
  if (!text || currentRoom !== "rest") return;
  if (isChatRateLimited()) return;
  chatSendTimes.push(Date.now());
  if (chatSendTimes.length > 20) chatSendTimes.splice(0, chatSendTimes.length - 20);
  socket.emit("chatMessage", { text, scope: scope || sendScope });
};

// --- Focus ---
window.__onFocusStart = function(category, taskName) {
  startFocus(category, taskName);
};
window.__onFocusEnd = function() {
  endFocus();
};

// --- Portal confirm ---
window.__onPortalConfirmYes = function() {
  storeSet("ui", "setPortalConfirmOpen", false);
  focusPortalPending = false;
  endFocus();
  const newRoom = currentRoom === "focus" ? "rest" : "focus";
  socket.emit("changeRoom", newRoom);
  portalCooldown = 60;
};
window.__onPortalConfirmNo = function() {
  storeSet("ui", "setPortalConfirmOpen", false);
  focusPortalPending = false;
  portalCooldown = 60;
  const map = getCurrentMap();
  if (map && localPlayer) {
    let sumY = 0, count = 0;
    for (let r = 0; r < map.length; r++) {
      for (let c = 0; c < (map[r] ? map[r].length : 0); c++) {
        if (map[r][c] === PORTAL_TILE) { sumY += r * TILE + TILE / 2; count++; }
      }
    }
    if (count > 0) {
      const portalY = sumY / count;
      const midY = map.length * TILE / 2;
      localPlayer.y = portalY + (portalY < midY ? 2 : -2) * TILE;
    }
  }
};

// --- Settings ---
window.__onSoundToggle = function(enabled) {
  // Sound toggle now handled by React SettingsPanel
};
window.__onVolumeChange = function(vol) {
  cachedVolume = vol / 100;
};
window.__onLogout = function() {
  handleLogout();
};
window.__onMiniPip = function() {
  openMiniPiPWindow();
};
window.__onLangChange = function(lang) {
  currentLang = lang;
  applyLanguage();
};
window.__onFontChange = function(usePixel) {
  usePixelFont = usePixel;
  localStorage.setItem("fontPixel", String(usePixel));
  applyFont();
};
window.__onShowNamesChange = function(v) {
  showNamesFilter = v;
};

// --- Status ---
window.__onStatusChange = function(status) {
  if (localPlayer) {
    localPlayer.status = status;
    socket.emit("setStatus", status);
  }
};

// --- Player card / reactions ---
window.__onReaction = function(targetId, emoji) {
  const p = otherPlayers[targetId];
  if (!p) return { offline: true, userId: null };
  const now = Date.now();
  const last = reactionPairTimes[targetId];
  if (last && now - last < REACTION_PAIR_COOLDOWN) {
    return { sent: false, remainingMs: REACTION_PAIR_COOLDOWN - (now - last) };
  }
  reactionPairTimes[targetId] = now;
  socket.emit("sendReaction", { targetId, emoji });
  return { sent: true, cooldownMs: REACTION_PAIR_COOLDOWN };
};
window.__getReactionCooldown = function(targetId) {
  const last = reactionPairTimes[targetId];
  if (!last) return 0;
  const remaining = REACTION_PAIR_COOLDOWN - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
};
window.__onFollowToggle = function(targetId) {
  const p = otherPlayers[targetId];
  const followKey = p?._userId || targetId;
  toggleFollow(followKey);
};

// --- Bulletin board ---
window.__onBulletinOpen = function() {
  socket.emit("getBulletinNotes");
};
window.__onBulletinPost = function(text, color) {
  socket.emit("addBulletinNote", { text, color });
};
window.__onBulletinLike = function(noteId) {
  socket.emit("likeBulletinNote", { noteId });
};
window.__onBulletinDelete = function(noteId) {
  socket.emit("deleteBulletinNote", { id: noteId });
};

// --- Auth ---
window.__onAuthSuccess = function(token, email, profile, focusRecords) {
  handleAuthSuccess(token, email, profile, focusRecords);
};

// --- Recording ---
window.__onRecToggle = function() {
  if (typeof recProcessing !== "undefined" && recProcessing) return;
  if (typeof supportsRecording !== "undefined" && !supportsRecording) return;
  if (typeof isRecording !== "undefined" && isRecording) {
    stopRecording().catch(err => console.error("[REC] Stop failed:", err));
  } else if (typeof startRecording === "function") {
    startRecording();
  }
};

// --- Local weekly stats tracking ---
function getMonday(d) {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = dt.getDay();
  const diff = day === 0 ? 6 : day - 1;
  dt.setDate(dt.getDate() - diff);
  return dt.toISOString().slice(0, 10);
}

function loadLocalStats() {
  try { return JSON.parse(localStorage.getItem("weeklyLocalStats") || "null"); } catch { return null; }
}

function saveLocalStats(stats) {
  localStorage.setItem("weeklyLocalStats", JSON.stringify(stats));
}

function getOrCreateCurrentStats() {
  const thisWeek = getMonday(new Date());
  let stats = loadLocalStats();
  if (!stats || stats.weekStart !== thisWeek) {
    // Archive current as lastWeek, start fresh
    if (stats && stats.weekStart !== thisWeek) {
      localStorage.setItem("weeklyLocalStatsLastWeek", JSON.stringify(stats));
    }
    stats = { weekStart: thisWeek, onlineSecs: 0, reactionsReceived: 0, catGiftsReceived: 0 };
    saveLocalStats(stats);
  }
  return stats;
}

function bumpLocalStat(key, amount) {
  const stats = getOrCreateCurrentStats();
  stats[key] = (stats[key] || 0) + amount;
  saveLocalStats(stats);
}

// Track online time every 60s
setInterval(() => { if (localPlayer) bumpLocalStat("onlineSecs", 60); }, 60000);

// --- Recap ---
function buildRecapDateRange(weekStartStr) {
  const ws = new Date(weekStartStr + "T00:00:00");
  const we = new Date(ws);
  we.setDate(we.getDate() + 6);
  const locale = currentLang === "zh" ? "zh-CN" : "en-US";
  const opts = { year: "numeric", month: "short", day: "numeric" };
  return `${ws.toLocaleDateString(locale, opts)} – ${we.toLocaleDateString(locale, opts)}`;
}

function buildRecapItems(oh, rr, cg) {
  return [
    { label: t("recapOnline"), value: `${oh} ${t("recapHours")}` },
    { label: t("recapReactions"), value: String(rr) },
    { label: t("recapCatGifts"), value: String(cg) },
  ];
}

window.__onRecapOpen = async function() {
  storeSet("ui", "setRecapOpen", true);

  if (!authToken) {
    // Guest: show last week's local stats
    getOrCreateCurrentStats(); // ensure archiving happened
    let last = null;
    try { last = JSON.parse(localStorage.getItem("weeklyLocalStatsLastWeek") || "null"); } catch {}
    if (last) {
      const oh = Math.round((last.onlineSecs || 0) / 3600 * 10) / 10;
      const dateRange = buildRecapDateRange(last.weekStart);
      const items = buildRecapItems(oh, last.reactionsReceived || 0, last.catGiftsReceived || 0);
      if (window.__setRecapData) window.__setRecapData({ dateRange, items });
    }
    return;
  }

  try {
    const res = await fetch("/api/weekly-recap", {
      headers: { "Authorization": "Bearer " + authToken },
    });
    if (!res.ok) return;
    const data = await res.json();
    let dateRange = "";
    if (data.weekStart) dateRange = buildRecapDateRange(data.weekStart);
    const oh = data.onlineHours || 0;
    const rr = data.reactionsReceived || 0;
    const cg = data.catGiftsReceived || 0;
    const items = buildRecapItems(oh, rr, cg);
    if (window.__setRecapData) window.__setRecapData({ dateRange, items });
  } catch (e) {
    console.warn("[Recap] Failed to fetch:", e);
  }
};

// --- Save blob file (download or Web Share) ---
function saveBlobFile(blob, filename, mime) {
  const shareFile = isTouchDevice && new File([blob], filename, { type: mime });
  if (shareFile && navigator.canShare?.({ files: [shareFile] })) {
    navigator.share({ files: [shareFile] }).catch(() => {});
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// --- Focus Recap Shareable Card ---
window.__generateFocusCard = function(data, returnCanvas = false) {
  // data: { dateRange, totalMs, sessions, categories, lang }, returnCanvas: if true, return canvas instead of downloading
  const W = 800, H = 400;
  const cvs = document.createElement("canvas");
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  // Colors from design tokens
  const BG = "#2e3a4a";
  const SURFACE = "#354050";
  const TEXT = "#e4e0d8";
  const MUTED = "#b0b8c4";
  const PRIMARY = "#88c0d6";
  const DIVIDER = "#404e60";
  const CAT_COLORS = {
    studying: "#88c0d6",
    working:  "#b0a0c8",
    reading:  "#88c498",
    writing:  "#e4c078",
    creating: "#e48888",
    exercising: "#c0a080",
  };

  const fontFamily = "'FusionPixel', sans-serif";
  const font = (size, bold) => (bold ? "bold " : "") + size + "px " + fontFamily;

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  // Subtle gradient at top
  const grad = ctx.createLinearGradient(0, 0, 0, 100);
  grad.addColorStop(0, "rgba(136,192,214,0.06)");
  grad.addColorStop(1, "rgba(136,192,214,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 100);

  // Header
  ctx.font = font(16, true);
  ctx.fillStyle = TEXT;
  ctx.textBaseline = "top";
  ctx.fillText("BESIDE \u00B7 " + t("focusRecap"), 32, 24);
  ctx.font = font(12, false);
  ctx.fillStyle = MUTED;
  ctx.fillText(data.dateRange, 32, 48);

  // Top divider
  ctx.fillStyle = DIVIDER;
  ctx.fillRect(32, 72, W - 64, 1);

  // Character sprite — 4x scale (128x256), draw in left area
  const sheet = getCharacterSheet(selectedCharConfig);
  if (sheet && sheet._loaded) {
    // Static down frame: row 0, col 3 (same as drawCharPreview)
    ctx.drawImage(sheet, 3 * 32, 0, 32, 64, 40, 90, 128, 256);
  }

  // Stats — right of character
  const statsX = 200;

  // Total time
  const totalMins = Math.floor(data.totalMs / 60000);
  const totalH = Math.floor(totalMins / 60);
  const totalM = totalMins % 60;
  let totalStr;
  if (data.lang === "zh") {
    totalStr = totalH > 0
      ? (totalM > 0 ? `${totalH}\u5C0F\u65F6 ${totalM}\u5206\u949F` : `${totalH}\u5C0F\u65F6`)
      : `${totalM}\u5206\u949F`;
  } else {
    totalStr = totalH > 0
      ? (totalM > 0 ? `${totalH}h ${totalM}m` : `${totalH}h`)
      : `${totalM}m`;
  }
  ctx.font = font(36, true);
  ctx.fillStyle = PRIMARY;
  ctx.fillText(totalStr, statsX, 92);

  ctx.font = font(14, false);
  ctx.fillStyle = MUTED;
  const totalLabel = data.lang === "zh" ? "TOTAL FOCUS" : "TOTAL FOCUS";
  ctx.fillText(totalLabel, statsX + ctx.measureText(totalStr).width + 12, 104);

  ctx.font = font(14, false);
  ctx.fillStyle = MUTED;
  const sessStr = data.lang === "zh"
    ? `${data.sessions} \u6B21`
    : `${data.sessions} sessions`;
  ctx.fillText(sessStr, statsX, 136);

  // Category bars
  const barX = statsX;
  const barMaxW = W - barX - 48;
  let barY = 176;
  const barH = 16;
  const barGap = 32;
  const cats = data.categories.slice(0, 5); // max 5 categories

  cats.forEach(({ cat, ms, pct }) => {
    // Bar
    const bw = Math.max(4, (pct / 100) * barMaxW * 0.7);
    ctx.fillStyle = CAT_COLORS[cat] || PRIMARY;
    ctx.fillRect(barX, barY, bw, barH);

    // Label
    ctx.font = font(12, false);
    ctx.fillStyle = TEXT;
    const catLabel = t(cat) || cat;
    ctx.fillText(catLabel, barX + bw + 8, barY + 2);

    // Time
    const catMins = Math.floor(ms / 60000);
    const cH = Math.floor(catMins / 60);
    const cM = catMins % 60;
    let catTime;
    if (data.lang === "zh") {
      catTime = cH > 0
        ? (cM > 0 ? `${cH}\u5C0F\u65F6 ${cM}\u5206\u949F` : `${cH}\u5C0F\u65F6`)
        : `${cM}\u5206\u949F`;
    } else {
      catTime = cH > 0
        ? (cM > 0 ? `${cH}h ${cM}m` : `${cH}h`)
        : `${cM}m`;
    }
    const catTimeX = W - 100;
    ctx.fillStyle = MUTED;
    ctx.fillText(catTime, catTimeX, barY + 2);

    // Percentage
    ctx.fillText(`${pct}%`, W - 44, barY + 2);

    barY += barGap;
  });

  // Bottom divider
  ctx.fillStyle = DIVIDER;
  ctx.fillRect(32, H - 48, W - 64, 1);

  // Footer
  ctx.font = font(12, false);
  ctx.fillStyle = MUTED;
  ctx.textAlign = "center";
  ctx.fillText("beside.app", W / 2, H - 32);
  ctx.textAlign = "left";

  // Return canvas if requested (for preview)
  if (returnCanvas) {
    return cvs;
  }

  // Export as PNG
  cvs.toBlob(function(blob) {
    if (!blob) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const filename = `beside-focus-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.png`;
    saveBlobFile(blob, filename, "image/png");
  }, "image/png");
};

// --- React ready callback ---
window.__onReactReady = function() {
  updateSettingsCharBtn();
  // Sync initial state to React stores
  if (typeof currentRoom !== "undefined" && currentRoom) {
    storeSet("game", "setRoom", currentRoom);
    storeSet("chat", "setChatVisible", currentRoom === "rest");
  }
  if (typeof isFocusing !== "undefined" && isFocusing) {
    storeSet("focus", "startFocus", focusCategory || "working", focusTaskName || "");
  }
  // Sync welcome popup state (returning users already checked in before React mounted)
  if (typeof hasCheckedIn !== "undefined" && hasCheckedIn) {
    storeSet("ui", "setWelcomeOpen", false);
  }
  // Sync auth state
  if (typeof isRegistered !== "undefined" && isRegistered && authEmail) {
    storeSet("auth", "login", authToken, authEmail);
  } else if (typeof myUserId !== "undefined" && myUserId) {
    storeSet("auth", "setSessionReady", isRegistered, myUserId);
  }
  // Sync settings
  if (typeof soundEnabled !== "undefined") storeSet("settings", "setSoundEnabled", soundEnabled);
  if (typeof cachedVolume !== "undefined") storeSet("settings", "setVolume", Math.round(cachedVolume * 100));
  if (typeof currentLang !== "undefined") storeSet("settings", "setLang", currentLang);
  if (typeof usePixelFont !== "undefined") storeSet("settings", "setFontPixel", usePixelFont);
  // Sync player data (may have arrived before stores were ready)
  if (myId) {
    storeSet("game", "setLocalPlayerId", myId);
    const allPlayers = {};
    if (localPlayer) allPlayers[myId] = localPlayer;
    for (const id in otherPlayers) {
      const p = otherPlayers[id];
      allPlayers[id] = { ...p, _followed: !!(p._userId && isFollowed(p._userId)) };
    }
    if (Object.keys(allPlayers).length > 0) storeSet("game", "setPlayers", allPlayers);
  }
};

// ============================================================
// GAME LOOP
// ============================================================

let lastSentX = 0;
let lastSentY = 0;
let lastMoveTime = 0; // timestamp of last player movement
let lastFrameTime = performance.now();

function update(dt) {
  if (!localPlayer) return;
  const dtScale = dt / 16.667; // normalize to 60fps

  // Portal cooldown
  if (portalCooldown > 0) portalCooldown--;

  let dx = 0;
  let dy = 0;
  if (!localSitting) {
    if (keys.up) dy -= SPEED;
    if (keys.down) dy += SPEED;
    if (keys.left) dx -= SPEED;
    if (keys.right) dx += SPEED;
  }

  if (dx !== 0 && dy !== 0) {
    dx *= 0.707;
    dy *= 0.707;
  }
  dx *= dtScale;
  dy *= dtScale;

  const newX = localPlayer.x + dx;
  const newY = localPlayer.y + dy;

  if (dx !== 0 && canMoveTo(newX, localPlayer.y)) {
    localPlayer.x = newX;
  }
  if (dy !== 0 && canMoveTo(localPlayer.x, newY)) {
    localPlayer.y = newY;
  }

  if (dy < 0) localPlayer.direction = "up";
  else if (dy > 0) localPlayer.direction = "down";
  if (dx < 0) localPlayer.direction = "left";
  else if (dx > 0) localPlayer.direction = "right";

  // Focus timer display: React FocusTimer reads focusStartTime and computes elapsed on its own

  // Proximity focus sounds
  updateFocusSounds();
  updateCatMeow();
  updateAmbientSound();
  updateCampfireSound();
  updateFrogSound();

  // Wandering idle: daydreaming after 5min
  // NOTE: idle auto-walk to Lounge disabled for now (cat drag feature shelved)
  if (hasCheckedIn && !isFocusing && currentRoom === "focus" && !autoWalking) {
    const idleTime = Date.now() - lastKeyPressTime;
    if (idleTime > DAYDREAM_MS && localPlayer.status !== "daydreaming") {
      localPlayer.status = "daydreaming";
      socket.emit("setStatus", "daydreaming");
    }
  }

  // Cat approach phase: cat walks toward leading position (18px ahead of player toward portal)
  if (catDragPhase === "approach" && localPlayer) {
    const cdx = catDragTargetX - catDragX;
    const cdy = catDragTargetY - catDragY;
    const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
    if (cdist < 8) {
      catDragPhase = "dragging";
      startAutoWalk();
    } else {
      const cspd = 2.0 * dtScale;
      catDragX += (cdx / cdist) * cspd;
      catDragY += (cdy / cdist) * cspd;
    }
  }

  // Auto-walk following BFS path waypoints
  if (autoWalking && autoWalkPath.length > 0) {
    const target = autoWalkPath[0];
    const awDx = target.x - localPlayer.x;
    const awDy = target.y - localPlayer.y;
    const awDist = Math.sqrt(awDx * awDx + awDy * awDy);
    if (awDist < 4) {
      autoWalkPath.shift();
    } else {
      const awSpeed = 1.5 * dtScale;
      const nx = localPlayer.x + (awDx / awDist) * awSpeed;
      const ny = localPlayer.y + (awDy / awDist) * awSpeed;
      if (canMoveTo(nx, ny)) {
        localPlayer.x = nx;
        localPlayer.y = ny;
        awStuckFrames = 0;
      } else if (canMoveTo(nx, localPlayer.y)) {
        localPlayer.x = nx;
        awStuckFrames = 0;
      } else if (canMoveTo(localPlayer.x, ny)) {
        localPlayer.y = ny;
        awStuckFrames = 0;
      } else {
        awStuckFrames++;
        if (awStuckFrames > 60) {
          // Recalculate path from current position
          const finalTarget = autoWalkPath[autoWalkPath.length - 1];
          const newPath = findClientPath(localPlayer.x, localPlayer.y, finalTarget.x, finalTarget.y);
          autoWalkPath = newPath || [];
          awStuckFrames = 0;
        }
      }

      if (Math.abs(awDy) >= Math.abs(awDx)) {
        localPlayer.direction = awDy < 0 ? "up" : "down";
      } else {
        localPlayer.direction = awDx < 0 ? "left" : "right";
      }
    }
    if (autoWalkPath.length === 0) {
      autoWalking = false;
      catDragPhase = "none";
    }
  }

  // Check portal
  if (portalCooldown <= 0 && isOnPortal(localPlayer.x, localPlayer.y)) {
    if (isFocusing && !focusPortalPending) {
      // Show confirmation instead of switching
      focusPortalPending = true;
      showFocusPortalConfirm();
      portalCooldown = 30;
    } else if (!isFocusing) {
      const newRoom = currentRoom === "focus" ? "rest" : "focus";
      socket.emit("changeRoom", newRoom);
      portalCooldown = 60;
    }
  }

  // Send position
  if (Math.abs(localPlayer.x - lastSentX) > 1 || Math.abs(localPlayer.y - lastSentY) > 1) {
    socket.emit("playerMove", {
      x: localPlayer.x,
      y: localPlayer.y,
      direction: localPlayer.direction,
    });
    lastSentX = localPlayer.x;
    lastSentY = localPlayer.y;
    lastMoveTime = Date.now();
  }

}

// Y-sorted rendering: interleave object-layer tile rows with entities (players, cat)
// so that entities appear behind tall furniture when walking above it
const _ysortEntities = []; // reuse array to avoid per-frame allocation
const _eKeyCache = { tx: -1, ty: -1, room: null, bbNear: null, campNear: null, seat: null };
function drawYSortedEntities() {
  const rd = ROOM_DATA[currentRoom];
  const dims = ROOM_DIMS[currentRoom] || ROOM_DIMS.focus;
  const rows = dims.rows, cols = dims.cols;
  const objCache = getObjectCache(currentRoom);

  // Collect all entities with their sort Y (feet/base position)
  const entities = _ysortEntities;
  entities.length = 0;
  if (catData.room === currentRoom || catDragPhase !== "none") {
    let catSortY;
    if (catDragPhase === "dragging" && localPlayer) {
      catSortY = localPlayer.y + (localPlayer.direction === "up" ? -18 : localPlayer.direction === "down" ? 18 : 0);
    } else if (catDragPhase === "approach") {
      catSortY = catDragY;
    } else {
      catSortY = catData.y;
    }
    entities.push({ type: 0, sortY: catSortY });
  }
  for (const id in otherPlayers) {
    const p = otherPlayers[id];
    if (p.room === currentRoom) {
      entities.push({ type: 1, p: p, local: false, sortY: p.y });
    }
  }
  if (localPlayer) {
    entities.push({ type: 1, p: localPlayer, local: true, sortY: localPlayer.y });
  }
  // Include pet/animal map objects in Y-sorted pass so they render above furniture
  const mapObjs = rd.mapObjectsBelow;
  if (mapObjs) {
    for (const obj of mapObjs) {
      if (obj.type === "pet" || obj.type === "animal") {
        entities.push({ type: 2, obj, sortY: obj.y + (obj.height || 16) });
      }
    }
  }
  entities.sort((a, b) => a.sortY - b.sortY);

  const drawEntity = (e) => {
    if (e.type === 0) { drawCatBody(); drawCatUI(); }
    else if (e.type === 2) { drawSingleMapObject(e.obj); }
    else { drawFocusAura(e.p); drawPlayerBody(e.p, e.local); drawGiftPile(e.p); }
  };

  if (objCache) {
    // Y-sorted: draw object tile rows interleaved with entities
    const w = cols * TILE;
    let ei = 0;
    for (let r = 0; r < rows; r++) {
      const rowBottom = (r + 1) * TILE;
      ctx.drawImage(objCache, 0, r * TILE, w, TILE, 0, r * TILE, w, TILE);
      while (ei < entities.length && entities[ei].sortY < rowBottom) drawEntity(entities[ei++]);
    }
    while (ei < entities.length) drawEntity(entities[ei++]);
  } else {
    // No object cache (fallback mode drew objects already), just draw entities sorted by Y
    for (const e of entities) drawEntity(e);
  }
}

function draw() {
  ctx = mainCtx;
  ctx.fillStyle = "#0f0d0b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Show nothing until assets are loaded (overlay covers the canvas)
  if (!gameReady) return;

  // Apply camera transform
  updateCamera();
  ctx.save();
  // Quantize render scale so TILE * gs is integer → pixel-perfect tile grid
  const gs = Math.round(gameScale * dpr * TILE) / TILE;
  ctx.setTransform(gs, 0, 0, gs, Math.round(-cameraX * gs), Math.round(-cameraY * gs));
  ctx.imageSmoothingEnabled = false;

  cachedTimeKey = getAmbientKey();
  portalDrawnThisFrame = false;
  portalLabelDrawnThisFrame = false;
  updateDoors();
  drawRoom();
  // Walkable object tiles (chairs, sofas) always below entities
  const walkCache = getWalkableObjCache(currentRoom);
  if (walkCache) ctx.drawImage(walkCache, 0, 0);
  // drawWindowLightSpills();  // disabled: window light spills
  // updateAndDrawDustMotes(); // disabled: dust motes
  drawMapObjects(ROOM_DATA[currentRoom].mapObjectsBelow);

  // Lerp cat position for smooth movement
  if (catData._targetX !== undefined) {
    catData.x += (catData._targetX - catData.x) * 0.25;
    catData.y += (catData._targetY - catData.y) * 0.25;
  }

  // Y-sorted pass: blocking tile rows interleaved with cat + players
  drawYSortedEntities();

  drawAboveLayers();
  drawMapObjects(ROOM_DATA[currentRoom].mapObjectsAbove);

  // Outdoor shading (per-tile, time-dependent)
  drawOutdoorShade();
  // Campfire light glow (above outdoor shade)
  drawCampfireLight();
  // Campfire animation should appear above static tiles and outdoor shade
  drawCampfireObjects();

  // Draw player labels + UI ABOVE all tile layers (with viewport culling)
  const _viewW = canvas.width / dpr / gameScale;
  const _viewH = canvas.height / dpr / gameScale;
  const _vpL = cameraX - 80, _vpR = cameraX + _viewW + 80;
  const _vpT = cameraY - 80, _vpB = cameraY + _viewH + 80;
  for (const id in otherPlayers) {
    const op = otherPlayers[id];
    if (op.room === currentRoom && op.x > _vpL && op.x < _vpR && op.y > _vpT && op.y < _vpB) {
      drawPlayerLabel(op);
      drawChatBubble(op);
    }
  }
  if (localPlayer) {
    drawPlayerLabel(localPlayer);
    drawChatBubble(localPlayer);
  }

  // First-time interaction hint trigger
  if (hoveredPlayerId && otherPlayers[hoveredPlayerId]) {
    if (!interactHintShown && interactHintTimer === 0) {
      interactHintTimer = 300; // ~5 seconds at 60fps
      interactHintShown = true;
      localStorage.setItem("interactHintShown", "1");
    }
  }
  // Draw first-time hint text (fades out)
  if (interactHintTimer > 0) {
    interactHintTimer--;
    const hintAlpha = interactHintTimer > 60 ? 1 : interactHintTimer / 60;
    if (hoveredPlayerId && otherPlayers[hoveredPlayerId]) {
      const hp = otherPlayers[hoveredPlayerId];
      ctx.save();
      ctx.globalAlpha = hintAlpha;
      ctx.font = f(14, true);
      ctx.textAlign = "center";
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 3;
      const hintText = t("clickToInteract");
      ctx.strokeText(hintText, hp.x, hp.y - 60);
      ctx.fillText(hintText, hp.x, hp.y - 60);
      ctx.restore();
    }
  }

  // Draw E-key interact prompt near bulletin board / campfire / sittable seat (hide after 5s idle)
  if (localPlayer && !localSitting && !isTouchDevice) {
    const idleMs = Date.now() - lastMoveTime;
    const eKeyVisible = idleMs < 5000;
    const eKeyFade = idleMs >= 4000 && idleMs < 5000 ? 1 - (idleMs - 4000) / 1000 : eKeyVisible ? 1 : 0;
    if (eKeyFade > 0) {
      // Cache proximity results — only recalculate when player tile changes
      const _ptx = Math.floor(localPlayer.x / TILE);
      const _pty = Math.floor(localPlayer.y / TILE);
      if (_eKeyCache.tx !== _ptx || _eKeyCache.ty !== _pty || _eKeyCache.room !== currentRoom) {
        _eKeyCache.tx = _ptx; _eKeyCache.ty = _pty; _eKeyCache.room = currentRoom;
        const _bb = getNearestBulletinBoard();
        _eKeyCache.bbNear = _bb && _bb.dist <= BULLETIN_INTERACT_DIST ? _bb : null;
        const _camp = _eKeyCache.bbNear ? null : getNearestCampfire();
        _eKeyCache.campNear = _camp && _camp.dist <= CAMPFIRE_INTERACT_DIST ? _camp : null;
        _eKeyCache.seat = (_eKeyCache.bbNear || _eKeyCache.campNear) ? null : getNearestSittable(localPlayer.x, localPlayer.y);
      }
      let ekx, eky;
      if (_eKeyCache.bbNear) {
        ekx = _eKeyCache.bbNear.x; eky = _eKeyCache.bbNear.y - 28;
      } else if (_eKeyCache.campNear) {
        ekx = _eKeyCache.campNear.x; eky = _eKeyCache.campNear.y - 28;
      } else if (_eKeyCache.seat) {
        const _seatEntry = SEATS[currentRoom] && SEATS[currentRoom][_eKeyCache.seat.row + "," + _eKeyCache.seat.col];
        ekx = _eKeyCache.seat.x + (_seatEntry && _seatEntry.manual ? (_seatEntry.dx || 0) : 0);
        eky = _eKeyCache.seat.y - 28;
      }
      if (ekx !== undefined) {
        ctx.save();
        ctx.globalAlpha = eKeyFade;
        const ks = 20;
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.beginPath();
        ctx.roundRect(ekx - ks / 2, eky - ks / 2, ks, ks, 4);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(ekx - ks / 2, eky - ks / 2, ks, ks, 4);
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = f(14, true);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("E", ekx, eky);
        ctx.restore();
      }
    }
  }

  updateAndDrawHearts();
  updateAndDrawScatterGifts();

  // Restore to screen space for vignette
  ctx.restore();
  drawVignette();

  // Draw reaction emojis AFTER vignette so they are not darkened
  updateAndDrawReactionEmojis();
}

function drawOutdoorShade() {
  const tv = TIME_VISUALS[cachedTimeKey];
  if (!tv || !tv.outdoorShadeAlpha || tv.outdoorShadeAlpha <= 0) return;
  const mask = getOutdoorMask(currentRoom);
  if (!mask) return;
  // Composite on an offscreen canvas so we don't clip the whole scene
  let shade = outdoorShadeCache[currentRoom];
  const needsRebuild = !shade || shade.width !== mask.width || shade.height !== mask.height
    || _shadeTimeKey[currentRoom] !== cachedTimeKey;
  if (needsRebuild) {
    if (!shade || shade.width !== mask.width || shade.height !== mask.height) {
      shade = document.createElement("canvas");
      shade.width = mask.width;
      shade.height = mask.height;
      outdoorShadeCache[currentRoom] = shade;
    }
    const sctx = shade.getContext("2d");
    sctx.clearRect(0, 0, shade.width, shade.height);
    sctx.fillStyle = tv.outdoorShadeColor || "rgba(0,0,0,1)";
    sctx.fillRect(0, 0, shade.width, shade.height);
    sctx.globalCompositeOperation = "destination-in";
    sctx.drawImage(mask, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    _shadeTimeKey[currentRoom] = cachedTimeKey;
  }

  ctx.save();
  ctx.globalAlpha = tv.outdoorShadeAlpha;
  ctx.drawImage(shade, 0, 0);
  ctx.restore();
}

function drawVignette() {
  const tv = TIME_VISUALS[cachedTimeKey];

  // Time-of-day color overlay
  if (tv.overlayColor) {
    ctx.fillStyle = tv.overlayColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Vignette with time-dependent darkness
  const grd = ctx.createRadialGradient(
    canvas.width / 2, canvas.height / 2, canvas.height * 0.35,
    canvas.width / 2, canvas.height / 2, canvas.height * 0.85
  );
  grd.addColorStop(0, "rgba(0,0,0,0)");
  grd.addColorStop(1, `rgba(0,0,0,${tv.vignetteAlpha})`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function gameLoop() {
  const now = performance.now();
  const dt = Math.min(now - lastFrameTime, 50); // cap at 50ms to avoid jumps
  lastFrameTime = now;
  update(dt);
  draw();
  if (isRecording) updateRecTitle();
  requestAnimationFrame(gameLoop);
}

// Language toggle
document.getElementById("lang-toggle").addEventListener("click", toggleLanguage);

// Font toggle
document.getElementById("font-toggle").addEventListener("click", toggleFont);
applyFont();

// ============================================================
// VIRTUAL JOYSTICK (touch devices only)
// ============================================================
if (isTouchDevice) {
  const joystickZone = document.getElementById("joystick-zone");
  const joystickCanvas = document.getElementById("joystick-canvas");
  const jCtx = joystickCanvas.getContext("2d");
  joystickZone.style.display = "block";

  const JOY_SIZE = 130;
  const JOY_RADIUS = 50;      // outer ring radius
  const THUMB_RADIUS = 22;    // thumb circle radius
  const DEADZONE = 0.15;      // 15% deadzone
  const JOY_CX = JOY_SIZE / 2;
  const JOY_CY = JOY_SIZE / 2;
  let joyActive = false;
  let joyThumbX = JOY_CX;
  let joyThumbY = JOY_CY;
  let joyTouchId = null;

  function drawJoystick() {
    jCtx.clearRect(0, 0, JOY_SIZE, JOY_SIZE);
    // Outer ring
    jCtx.beginPath();
    jCtx.arc(JOY_CX, JOY_CY, JOY_RADIUS, 0, Math.PI * 2);
    jCtx.fillStyle = "rgba(255,255,255,0.08)";
    jCtx.fill();
    jCtx.strokeStyle = "rgba(255,255,255,0.2)";
    jCtx.lineWidth = 2;
    jCtx.stroke();
    // Thumb
    jCtx.beginPath();
    jCtx.arc(joyThumbX, joyThumbY, THUMB_RADIUS, 0, Math.PI * 2);
    jCtx.fillStyle = joyActive ? "rgba(233,69,96,0.6)" : "rgba(255,255,255,0.2)";
    jCtx.fill();
    jCtx.strokeStyle = "rgba(255,255,255,0.35)";
    jCtx.lineWidth = 1.5;
    jCtx.stroke();
  }

  function updateJoystickInput(tx, ty) {
    const dx = tx - JOY_CX;
    const dy = ty - JOY_CY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = JOY_RADIUS;

    // Clamp to ring
    if (dist > maxDist) {
      joyThumbX = JOY_CX + (dx / dist) * maxDist;
      joyThumbY = JOY_CY + (dy / dist) * maxDist;
    } else {
      joyThumbX = tx;
      joyThumbY = ty;
    }

    const norm = Math.min(dist / maxDist, 1);
    if (norm < DEADZONE) {
      keys.up = keys.down = keys.left = keys.right = false;
      return;
    }

    const angle = Math.atan2(dy, dx);
    // Map to directional keys with overlapping zones for diagonals
    const t = Math.PI / 8;
    keys.right = angle > -(Math.PI / 4 + t) && angle < (Math.PI / 4 + t);
    keys.down  = angle > (Math.PI / 4 - t) && angle < (3 * Math.PI / 4 + t);
    keys.left  = angle > (3 * Math.PI / 4 - t) || angle < -(3 * Math.PI / 4 - t);
    keys.up    = angle > -(3 * Math.PI / 4 + t) && angle < -(Math.PI / 4 - t);
  }

  joystickZone.addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (joyTouchId !== null) return;
    const touch = e.changedTouches[0];
    joyTouchId = touch.identifier;
    joyActive = true;
    storeSet("game", "setPlayerHasMoved");
    const rect = joystickCanvas.getBoundingClientRect();
    const scaleX = JOY_SIZE / rect.width;
    const scaleY = JOY_SIZE / rect.height;
    const tx = (touch.clientX - rect.left) * scaleX;
    const ty = (touch.clientY - rect.top) * scaleY;
    updateJoystickInput(tx, ty);
    // Stand up if sitting
    if (localSitting) standUp();
    // Reset idle timer
    lastKeyPressTime = Date.now();
    if (autoWalking || catDragPhase !== "none") {
      autoWalking = false;
      autoWalkPath = [];
      catDragPhase = "none";
      postFocusTime = 0;
      document.getElementById("autowalk-hint").style.display = "none";
    }
    if (localPlayer && localPlayer.status === "daydreaming") {
      localPlayer.status = "wandering";
      socket.emit("setStatus", "wandering");
    }
  }, { passive: false });

  joystickZone.addEventListener("touchmove", (e) => {
    e.preventDefault();
    for (const touch of e.changedTouches) {
      if (touch.identifier === joyTouchId) {
        const rect = joystickCanvas.getBoundingClientRect();
        const scaleX = JOY_SIZE / rect.width;
        const scaleY = JOY_SIZE / rect.height;
        const tx = (touch.clientX - rect.left) * scaleX;
        const ty = (touch.clientY - rect.top) * scaleY;
        updateJoystickInput(tx, ty);
        lastKeyPressTime = Date.now();
      }
    }
  }, { passive: false });

  function releaseJoystick() {
    joyActive = false;
    joyTouchId = null;
    joyThumbX = JOY_CX;
    joyThumbY = JOY_CY;
    keys.up = keys.down = keys.left = keys.right = false;
  }

  joystickZone.addEventListener("touchend", (e) => {
    for (const touch of e.changedTouches) {
      if (touch.identifier === joyTouchId) {
        releaseJoystick();
      }
    }
  });

  joystickZone.addEventListener("touchcancel", () => releaseJoystick());

  // Draw joystick every frame
  function joystickLoop() {
    drawJoystick();
    requestAnimationFrame(joystickLoop);
  }
  joystickLoop();
}

// ============================================================
// SIT BUTTON (mobile + desktop)
// ============================================================
const sitBtn = document.getElementById("sit-btn");
if (sitBtn) {
  sitBtn.addEventListener("click", () => {
    if (!localPlayer || isFocusing) return;
    const bb = getNearestBulletinBoard();
    if (bb && bb.dist <= BULLETIN_INTERACT_DIST) {
      openBulletinPopup();
      return;
    }
    const camp = getNearestCampfire();
    if (camp && camp.dist <= CAMPFIRE_INTERACT_DIST) {
      socket.emit("toggleCampfire", { id: camp.id, x: localPlayer.x, y: localPlayer.y });
      return;
    }
    if (localSitting) {
      standUp();
    } else {
      const seat = getNearestSittable(localPlayer.x, localPlayer.y);
      if (seat) {
        localPlayer.x = seat.x;
        localPlayer.y = seat.y;
        if (seat.seatType !== 15) localPlayer.direction = seat.direction;
        localPlayer.seatType = seat.seatType;
        localSitting = true;
        localPlayer.isSitting = true;
        emitPlayerSit(true);
        lastSentX = localPlayer.x;
        lastSentY = localPlayer.y;
      }
    }
    updateSitButton();
  });
}

function updateSitButton() {
  if (!sitBtn || !localPlayer || !isTouchDevice) return;
  if (localSitting) {
    sitBtn.style.display = "none";
  } else if (getNearestBulletinBoard()?.dist <= BULLETIN_INTERACT_DIST) {
    sitBtn.style.display = "block";
    sitBtn.textContent = "INTERACT";
  } else if (getNearestCampfire()?.dist <= CAMPFIRE_INTERACT_DIST) {
    sitBtn.style.display = "block";
    sitBtn.textContent = "INTERACT";
  } else if (getNearestSittable(localPlayer.x, localPlayer.y)) {
    sitBtn.style.display = "block";
    sitBtn.textContent = "INTERACT";
  } else {
    sitBtn.style.display = "none";
  }
}

// Update sit button visibility periodically
setInterval(() => {
  if (localPlayer) updateSitButton();
}, 200);

// ============================================================
// TIMELAPSE RECORDING
// Approach: store frames as ImageBitmap during recording,
// then replay all frames at 30fps through MediaRecorder on stop.
// This produces smooth, high-quality timelapse video.
// ============================================================
const recBtn = document.getElementById("rec-btn");
const recIcon = document.getElementById("rec-icon");
const recTimer = document.getElementById("rec-timer");
let isRecording = false;
let recProcessing = false;
let recStartTime = 0;
let recFrames = [];       // JPEG Blob array (~100KB each, memory-safe for hours)
let recCaptureTimer = null;
let recSnapCanvas = null; // reusable snapshot canvas (1x logical resolution)
let recSnapCtx = null;
const REC_CAPTURE_MS = 2000;  // snapshot every 2 seconds
const REC_REPLAY_FPS = 30;    // encode at 30fps → 60× speed
const REC_BITRATE = 8_000_000; // 8 Mbps
const REC_JPEG_QUALITY = 0.92;
const REC_MAX_FRAMES = 5400;     // 3h @ 2s/frame; halved when exceeded
let recWidth = 0;
let recHeight = 0;

function getRecMimeType() {
  const types = [
    { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
    { mime: "video/mp4", ext: "mp4" },
    { mime: "video/webm;codecs=vp9", ext: "webm" },
    { mime: "video/webm;codecs=vp8", ext: "webm" },
    { mime: "video/webm", ext: "webm" },
  ];
  for (const t of types) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t.mime)) return t;
  }
  return null;
}

// Feature detection (let for console testing: supportsRecording = false)
let supportsRecording = typeof MediaRecorder !== 'undefined'
  && typeof HTMLCanvasElement.prototype.captureStream === 'function'
  && !!getRecMimeType();
// supportsRecording checked in click handler to show user-friendly message

function recEnsureSnapCanvas() {
  const w = recWidth || Math.round(canvas.width / dpr);
  const h = recHeight || Math.round(canvas.height / dpr);
  if (!recSnapCanvas || recSnapCanvas.width !== w || recSnapCanvas.height !== h) {
    recSnapCanvas = document.createElement("canvas");
    recSnapCanvas.width = w;
    recSnapCanvas.height = h;
    recSnapCtx = recSnapCanvas.getContext("2d", { alpha: false });
  }
}

function recCaptureFrame() {
  recEnsureSnapCanvas();
  recSnapCtx.clearRect(0, 0, recSnapCanvas.width, recSnapCanvas.height);
  recSnapCtx.drawImage(canvas, 0, 0, recSnapCanvas.width, recSnapCanvas.height);
  recSnapCanvas.toBlob(blob => {
    if (blob) {
      recFrames.push(blob);
      if (recFrames.length >= REC_MAX_FRAMES) {
        recFrames = recFrames.filter((_, i) => i % 2 === 0);
      }
    }
  }, "image/jpeg", REC_JPEG_QUALITY);
}

function startRecording() {
  if (!getRecMimeType()) { console.warn("[REC] No supported video MIME type"); return; }
  recFrames = [];
  recWidth = Math.round(canvas.width / dpr);
  recHeight = Math.round(canvas.height / dpr);
  recStartTime = performance.now();
  isRecording = true;
  storeSet("ui", "setIsRecording", true);
  recCaptureFrame();
  recCaptureTimer = setInterval(recCaptureFrame, REC_CAPTURE_MS);
  if (recBtn) recBtn.classList.add("recording");
  if (recIcon) { recIcon.style.maskImage = "url(/icons/square.svg)"; recIcon.style.webkitMaskImage = "url(/icons/square.svg)"; }
  if (recTimer) { recTimer.textContent = "00:00"; recTimer.classList.add("visible"); }
}

async function stopRecording() {
  isRecording = false;
  storeSet("ui", "setIsRecording", false);
  storeSet("ui", "setRecProcessing", true);
  if (recCaptureTimer) { clearInterval(recCaptureTimer); recCaptureTimer = null; }

  // Capture final frame as JPEG blob
  try {
    recEnsureSnapCanvas();
    recSnapCtx.clearRect(0, 0, recSnapCanvas.width, recSnapCanvas.height);
    recSnapCtx.drawImage(canvas, 0, 0, recSnapCanvas.width, recSnapCanvas.height);
    const blob = await new Promise(r => recSnapCanvas.toBlob(r, "image/jpeg", REC_JPEG_QUALITY));
    if (blob) recFrames.push(blob);
  } catch {}

  const frames = recFrames;
  recFrames = [];

  if (frames.length === 0) {
    if (recBtn) { recBtn.classList.remove("recording"); recBtn.title = t("recStart"); }
    if (recIcon) { recIcon.style.maskImage = "url(/icons/video.svg)"; recIcon.style.webkitMaskImage = "url(/icons/video.svg)"; }
    if (recTimer) recTimer.classList.remove("visible");
    storeSet("ui", "setRecProcessing", false);
    recWidth = 0; recHeight = 0;
    return;
  }

  recProcessing = true;
  if (recBtn) recBtn.title = t("recEncoding").replace("{0}", "0");

  const mimeInfo = getRecMimeType();
  if (!mimeInfo) { recProcessing = false; recWidth = 0; recHeight = 0; return; }

  try {
    // Offscreen canvas at locked recording resolution
    const offscreen = document.createElement("canvas");
    offscreen.width = recWidth;
    offscreen.height = recHeight;
    const offCtx = offscreen.getContext("2d", { alpha: false });

    // captureStream(0) = manual frame control via requestFrame()
    const stream = offscreen.captureStream(0);
    const vTrack = stream.getVideoTracks()[0];
    if (!vTrack) throw new Error("No video track from captureStream");

    const recorder = new MediaRecorder(stream, {
      mimeType: mimeInfo.mime,
      videoBitsPerSecond: REC_BITRATE,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };

    // Stream decode: one frame at a time with one-frame lookahead (≈2 bitmaps in memory)
    let currentBmp = await createImageBitmap(frames[0]);
    let nextPromise = frames.length > 1 ? createImageBitmap(frames[1]) : null;

    // Safety timeout: 5 min max for encoding
    const encodingTimeout = setTimeout(() => {
      console.warn("[REC] Encoding timeout — forcing stop");
      try { recorder.stop(); } catch {}
    }, 300000);

    await new Promise((resolve) => {
      recorder.onstop = () => {
        clearTimeout(encodingTimeout);
        const blob = new Blob(chunks, { type: mimeInfo.mime });
        if (blob.size === 0) { console.warn("[REC] Empty blob"); resolve(); return; }

        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const filename = `beside-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${mimeInfo.ext}`;
        saveBlobFile(blob, filename, mimeInfo.mime);
        resolve();
      };

      recorder.start();

      // Replay frames at 30fps with streaming decode + progress
      let idx = 0;
      async function replayFrame() {
        try {
          if (idx >= frames.length) {
            setTimeout(() => { try { recorder.stop(); } catch {} }, 100);
            return;
          }
          offCtx.fillStyle = "#2a2838";
          offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
          if (currentBmp) {
            offCtx.drawImage(currentBmp, 0, 0, offscreen.width, offscreen.height);
            currentBmp.close();
            currentBmp = null;
          }
          if (vTrack.requestFrame) vTrack.requestFrame();

          const pct = Math.round(((idx + 1) / frames.length) * 100);
          if (recBtn) recBtn.title = t("recEncoding").replace("{0}", pct);

          idx++;
          if (nextPromise) {
            currentBmp = await nextPromise;
            nextPromise = (idx + 1 < frames.length) ? createImageBitmap(frames[idx + 1]) : null;
          }
          setTimeout(replayFrame, Math.round(1000 / REC_REPLAY_FPS));
        } catch (err) {
          console.error("[REC] Replay error at frame", idx, err);
          try { recorder.stop(); } catch {}
        }
      }
      replayFrame();
    });
  } catch (err) {
    console.error("[REC] Encoding failed:", err);
  } finally {
    recProcessing = false;
    storeSet("ui", "setRecProcessing", false);
    recWidth = 0; recHeight = 0;
    if (recBtn) { recBtn.classList.remove("recording"); recBtn.title = t("recStart"); }
    if (recIcon) { recIcon.style.maskImage = "url(/icons/video.svg)"; recIcon.style.webkitMaskImage = "url(/icons/video.svg)"; }
    if (recTimer) recTimer.classList.remove("visible");
    recSnapCanvas = null;
    recSnapCtx = null;
  }
}

function updateRecTitle() {
  if (!isRecording) return;
  const elapsed = Math.floor((performance.now() - recStartTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const timeStr = `${mm}:${ss}`;
  if (recBtn) recBtn.title = `${t("recStop")} (${timeStr})`;
  if (recTimer) recTimer.textContent = timeStr;
  storeSet("ui", "setRecTimeStr", timeStr);
}

// Dynamic tab title
function updateDocTitle() {
  if (isRecording || recProcessing) {
    document.title = "\u23FA Recording \u00B7 Beside";
  } else if (isFocusing && focusStartTime) {
    document.title = "\uD83D\uDD25 " + formatFocusTime(Date.now() - focusStartTime) + " \u00B7 Beside";
  } else if (currentRoom === "focus") {
    document.title = "Beside \u00B7 Focus";
  } else {
    document.title = "Beside \u00B7 Lounge";
  }
}
setInterval(updateDocTitle, 1000);

if (recBtn) {
  recBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (recProcessing) return; // encoding in progress, ignore clicks
    if (!supportsRecording) { alert(t("recUnsupported")); return; }
    if (isRecording) {
      stopRecording().catch(err => console.error("[REC] Stop failed:", err));
    } else {
      startRecording();
    }
  });
}

// --- Screenshot ---
window.__onScreenshot = function() {
  canvas.toBlob(function(blob) {
    if (!blob) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const filename = `beside-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
    saveBlobFile(blob, filename, "image/png");
  }, "image/png");
};

// Start
applyLanguage();
updateRoomUI();
gameLoop();
