const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 45000 });

app.use(express.json());

const distPath = path.join(__dirname, "dist");

// ============================================================
// ENVIRONMENT CONFIG (staging vs production)
// ============================================================
const APP_ENV = process.env.NODE_ENV || "staging";
const IS_PROD = APP_ENV === "production";
const BUILD_ID = Date.now().toString(36);

// ============================================================
// DATABASE
// ============================================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const db = new Database(path.join(DATA_DIR, "beside.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password   TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    name       TEXT NOT NULL DEFAULT 'Anonymous',
    character  TEXT NOT NULL DEFAULT '{"preset":1}',
    tagline    TEXT NOT NULL DEFAULT '',
    languages  TEXT NOT NULL DEFAULT '["en"]',
    points     INTEGER NOT NULL DEFAULT 0,
    cosmetics  TEXT NOT NULL DEFAULT '[]',
    birth_month INTEGER DEFAULT NULL,
    profession  TEXT NOT NULL DEFAULT 'mystery'
  );
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS focus_records (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_name  TEXT NOT NULL DEFAULT '',
    category   TEXT NOT NULL DEFAULT 'study',
    duration   INTEGER NOT NULL,
    start_time INTEGER NOT NULL,
    end_time   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS weekly_stats (
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week_start           TEXT NOT NULL,
    online_secs          INTEGER NOT NULL DEFAULT 0,
    reactions_received   INTEGER NOT NULL DEFAULT 0,
    cat_gifts_received   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, week_start)
  );
  CREATE TABLE IF NOT EXISTS weekly_copresence (
    user_a      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week_start  TEXT NOT NULL,
    shared_secs INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_a, user_b, week_start),
    CHECK (user_a < user_b)
  );
  CREATE TABLE IF NOT EXISTS bulletin_notes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    room            TEXT NOT NULL,
    author_name     TEXT NOT NULL,
    author_id       INTEGER,
    text            TEXT NOT NULL,
    color           TEXT,
    is_announcement INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER
  );
  CREATE TABLE IF NOT EXISTS bulletin_likes (
    note_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (note_id, user_id)
  );
`);

// Migrations — detect legacy schema and rebuild if needed
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes("email")) {
  db.exec("DROP TABLE IF EXISTS auth_tokens");
  db.exec("DROP TABLE IF EXISTS focus_records");
  db.exec("DROP TABLE IF EXISTS weekly_stats");
  db.exec("DROP TABLE IF EXISTS weekly_copresence");
  db.exec("DROP TABLE IF EXISTS users");
  db.exec(`
    CREATE TABLE users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password   TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      name       TEXT NOT NULL DEFAULT 'Anonymous',
      character  TEXT NOT NULL DEFAULT '{"preset":1}',
      tagline    TEXT NOT NULL DEFAULT '',
      languages  TEXT NOT NULL DEFAULT '["en"]',
      points     INTEGER NOT NULL DEFAULT 0,
      cosmetics  TEXT NOT NULL DEFAULT '[]',
      birth_month INTEGER DEFAULT NULL,
      profession  TEXT NOT NULL DEFAULT 'mystery',
      is_guest   INTEGER NOT NULL DEFAULT 0,
      last_seen  INTEGER,
      last_x     REAL,
      last_y     REAL,
      last_room  TEXT,
      last_status    TEXT,
      last_direction TEXT,
      last_sitting   INTEGER,
      last_focusing  INTEGER,
      last_focus_start INTEGER,
      last_focus_category TEXT
    );
    CREATE TABLE auth_tokens (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE focus_records (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_name  TEXT NOT NULL DEFAULT '',
      category   TEXT NOT NULL DEFAULT 'study',
      duration   INTEGER NOT NULL,
      start_time INTEGER NOT NULL,
      end_time   INTEGER NOT NULL
    );
    CREATE TABLE weekly_stats (
      user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      week_start           TEXT NOT NULL,
      online_secs          INTEGER NOT NULL DEFAULT 0,
      reactions_received   INTEGER NOT NULL DEFAULT 0,
      cat_gifts_received   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, week_start)
    );
    CREATE TABLE weekly_copresence (
      user_a      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      week_start  TEXT NOT NULL,
      shared_secs INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_a, user_b, week_start),
      CHECK (user_a < user_b)
    );
  `);
}
// Safely add columns to existing databases
try { db.exec("ALTER TABLE users ADD COLUMN birth_month INTEGER DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN profession TEXT NOT NULL DEFAULT 'mystery'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_seen INTEGER"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_x REAL"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_y REAL"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_room TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_status TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_direction TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_sitting INTEGER"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_focusing INTEGER"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_focus_start INTEGER"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_focus_category TEXT"); } catch {}
try { db.exec("ALTER TABLE bulletin_notes ADD COLUMN author_profession TEXT NOT NULL DEFAULT 'mystery'"); } catch {}

const VALID_PROFESSIONS = ["tech", "creative", "business", "student", "educator", "freelance", "mystery"];

// Prepared statements
const stmtInsertUser = db.prepare(
  "INSERT INTO users (email, password, name, character, tagline, languages, birth_month, profession) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);
const stmtGetUserByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
const stmtGetUserById = db.prepare("SELECT * FROM users WHERE id = ?");
const stmtInsertToken = db.prepare(
  "INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)"
);
const stmtGetToken = db.prepare(
  "SELECT * FROM auth_tokens WHERE token = ? AND expires_at > unixepoch()"
);
const stmtDeleteToken = db.prepare("DELETE FROM auth_tokens WHERE token = ?");
const stmtDeleteExpiredTokens = db.prepare("DELETE FROM auth_tokens WHERE expires_at <= unixepoch()");
const stmtUpdateProfile = db.prepare(
  "UPDATE users SET name = ?, character = ?, tagline = ?, languages = ?, birth_month = ?, profession = ? WHERE id = ?"
);
const stmtInsertFocusRecord = db.prepare(
  "INSERT INTO focus_records (user_id, task_name, category, duration, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)"
);
const stmtGetFocusRecords = db.prepare(
  "SELECT task_name, category, duration, start_time, end_time FROM focus_records WHERE user_id = ? ORDER BY end_time DESC LIMIT 100"
);

// Guest user management
const stmtInsertGuestUser = db.prepare(
  "INSERT INTO users (email, password, name, is_guest) VALUES (?, '!guest', 'Anonymous', 1)"
);
const stmtUpgradeGuest = db.prepare(
  "UPDATE users SET email=?, password=?, is_guest=0, name=?, character=?, tagline=?, languages=?, birth_month=?, profession=? WHERE id=? AND is_guest=1"
);
const stmtUpdateLastSeen = db.prepare("UPDATE users SET last_seen = unixepoch() WHERE id = ?");
const stmtSaveRuntimeState = db.prepare(
  `UPDATE users SET last_x=?, last_y=?, last_room=?, last_status=?, last_direction=?, last_sitting=?, last_focusing=?, last_focus_start=?, last_focus_category=?, last_seen=unixepoch() WHERE id=?`
);
const stmtCleanupGuests = db.prepare(
  "DELETE FROM users WHERE is_guest = 1 AND last_seen IS NOT NULL AND last_seen < unixepoch() - 30 * 86400"
);

// Bulletin board prepared statements
const stmtInsertNote = db.prepare(
  "INSERT INTO bulletin_notes (room, author_name, author_id, text, color, is_announcement, created_at, expires_at, author_profession) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const stmtGetAnnouncements = db.prepare(
  "SELECT id, room, author_name, text, color, is_announcement, created_at, expires_at FROM bulletin_notes WHERE is_announcement = 1 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC"
);
const stmtGetPlayerNotes = db.prepare(
  "SELECT id, room, author_name, author_id, text, color, is_announcement, created_at, author_profession FROM bulletin_notes WHERE is_announcement = 0 AND created_at > ? ORDER BY created_at DESC LIMIT 20"
);
const stmtDeleteNoteById = db.prepare(
  "DELETE FROM bulletin_notes WHERE id = ? AND author_id = ? AND is_announcement = 0"
);
const stmtCountPlayerNotes = db.prepare(
  "SELECT COUNT(*) AS cnt FROM bulletin_notes WHERE is_announcement = 0 AND created_at > ?"
);
const stmtDeleteOldestNote = db.prepare(
  "DELETE FROM bulletin_notes WHERE id = (SELECT id FROM bulletin_notes WHERE is_announcement = 0 ORDER BY created_at ASC LIMIT 1)"
);
const stmtCleanExpiredNotes = db.prepare(
  "DELETE FROM bulletin_notes WHERE (is_announcement = 0 AND created_at < ?) OR (is_announcement = 1 AND expires_at IS NOT NULL AND expires_at < ?)"
);

// Bulletin likes prepared statements
const stmtLikeInsert = db.prepare("INSERT OR IGNORE INTO bulletin_likes (note_id, user_id) VALUES (?, ?)");
const stmtLikeDelete = db.prepare("DELETE FROM bulletin_likes WHERE note_id = ? AND user_id = ?");
const stmtLikeCheck = db.prepare("SELECT 1 FROM bulletin_likes WHERE note_id = ? AND user_id = ?");
const stmtLikeCount = db.prepare("SELECT COUNT(*) AS cnt FROM bulletin_likes WHERE note_id = ?");
const stmtNoteAuthor = db.prepare("SELECT author_id FROM bulletin_notes WHERE id = ?");
const stmtUserLikes = db.prepare("SELECT note_id FROM bulletin_likes WHERE user_id = ?");
const stmtDeleteNoteLikes = db.prepare("DELETE FROM bulletin_likes WHERE note_id = ?");

// Weekly stats prepared statements
const stmtUpsertOnlineSecs = db.prepare(
  `INSERT INTO weekly_stats (user_id, week_start, online_secs)
   VALUES (?, ?, 60)
   ON CONFLICT(user_id, week_start) DO UPDATE SET online_secs = online_secs + 60`
);
const stmtIncrReactionsReceived = db.prepare(
  `INSERT INTO weekly_stats (user_id, week_start, reactions_received)
   VALUES (?, ?, 1)
   ON CONFLICT(user_id, week_start) DO UPDATE SET reactions_received = reactions_received + 1`
);
const stmtIncrCatGiftsReceived = db.prepare(
  `INSERT INTO weekly_stats (user_id, week_start, cat_gifts_received)
   VALUES (?, ?, 1)
   ON CONFLICT(user_id, week_start) DO UPDATE SET cat_gifts_received = cat_gifts_received + 1`
);
const stmtUpsertCopresence = db.prepare(
  `INSERT INTO weekly_copresence (user_a, user_b, week_start, shared_secs)
   VALUES (?, ?, ?, 60)
   ON CONFLICT(user_a, user_b, week_start) DO UPDATE SET shared_secs = shared_secs + 60`
);
const stmtGetWeeklyStats = db.prepare(
  "SELECT online_secs, reactions_received, cat_gifts_received FROM weekly_stats WHERE user_id = ? AND week_start = ?"
);
const stmtGetTopCopresence = db.prepare(
  `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS partner_id, shared_secs
   FROM weekly_copresence
   WHERE (user_a = ? OR user_b = ?) AND week_start = ?
   ORDER BY shared_secs DESC LIMIT 1`
);

const TOKEN_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

function createAuthToken(userId) {
  const token = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_MAX_AGE;
  stmtInsertToken.run(token, userId, expiresAt);
  return token;
}

// Map userId (DB) → socketId for registered users
const userSocketMap = {};

// ============================================================
// RATE LIMITING (in-memory per IP)
// ============================================================
const rateLimits = {};
function checkRate(ip, action, maxPerMin) {
  const key = `${ip}:${action}`;
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key] = rateLimits[key].filter(t => now - t < 60000);
  if (rateLimits[key].length >= maxPerMin) return false;
  rateLimits[key].push(now);
  return true;
}

// Periodic cleanup of stale rate limit entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateLimits)) {
    rateLimits[key] = rateLimits[key].filter(t => now - t < 60000);
    if (rateLimits[key].length === 0) delete rateLimits[key];
  }
}, 5 * 60 * 1000);

// Email validation
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Strip internal/sensitive fields before sending player data to clients
function sanitizePlayer(p) {
  return {
    id: p.id, x: p.x, y: p.y, name: p.name, status: p.status,
    direction: p.direction, room: p.room,
    isFocusing: p.isFocusing, focusStartTime: p.focusStartTime || null, focusCategory: p.focusCategory,
    giftPile: p.giftPile, isSitting: p.isSitting,
    character: p.character, tagline: p.tagline,
    languages: p.languages, timezoneHour: p.timezoneHour,
    _userId: p._userId || null,
    birthMonth: p.birthMonth ?? null,
    profession: p.profession || "mystery",
  };
}
function sanitizePlayers(all) {
  const out = {};
  for (const id of Object.keys(all)) out[id] = sanitizePlayer(all[id]);
  return out;
}

// ============================================================
// AUTH ENDPOINTS
// ============================================================
app.post("/api/register", async (req, res) => {
  const ip = req.ip;
  if (!checkRate(ip, "register", 3)) return res.status(429).json({ error: "Too many attempts. Try again later." });

  const { email, password, name, character, tagline, languages, birthMonth, profession } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  if (typeof email !== "string" || !EMAIL_RE.test(email))
    return res.status(400).json({ error: "Please enter a valid email address." });
  if (typeof password !== "string" || password.length < 6 || password.length > 128)
    return res.status(400).json({ error: "Password must be 6-128 characters." });

  // Check if email taken
  if (stmtGetUserByEmail.get(email))
    return res.status(409).json({ error: "Email already registered." });

  const hash = await bcrypt.hash(password, 10);
  const safeName = typeof name === "string" ? truncateToDisplayWidth(sanitizeText(name), 20) || "Anonymous" : "Anonymous";
  const safeChar = (character && typeof character === "object" && isValidCharConfig(character))
    ? JSON.stringify(character) : '{"preset":1}';
  const safeTagline = typeof tagline === "string" ? truncateToDisplayWidth(sanitizeText(tagline), 100) : "";
  const validLangs = ["en", "zh-CN", "zh-TW"];
  const safeLangs = Array.isArray(languages) ? JSON.stringify(languages.filter(l => validLangs.includes(l))) : '["en"]';

  const safeBirthMonth = (typeof birthMonth === "number" && Number.isInteger(birthMonth) && birthMonth >= 1 && birthMonth <= 12) ? birthMonth : null;
  const safeProfession = (typeof profession === "string" && VALID_PROFESSIONS.includes(profession)) ? profession : "mystery";

  try {
    // Check if request carries a guest authToken → upgrade existing guest user
    const guestAuthToken = req.body.authToken;
    if (guestAuthToken) {
      const tokenRow = stmtGetToken.get(guestAuthToken);
      if (tokenRow) {
        const existingUser = stmtGetUserById.get(tokenRow.user_id);
        if (existingUser && existingUser.is_guest) {
          // Upgrade guest → registered user
          stmtUpgradeGuest.run(email, hash, safeName, safeChar, safeTagline, safeLangs, safeBirthMonth, safeProfession, existingUser.id);
          const token = createAuthToken(existingUser.id);
          return res.json({ token, userId: existingUser.id, email });
        }
      }
    }

    // Fallback: create new user
    const result = stmtInsertUser.run(email, hash, safeName, safeChar, safeTagline, safeLangs, safeBirthMonth, safeProfession);
    const token = createAuthToken(result.lastInsertRowid);
    res.json({ token, userId: result.lastInsertRowid, email });
  } catch (err) {
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/login", async (req, res) => {
  const ip = req.ip;
  if (!checkRate(ip, "login", 5)) return res.status(429).json({ error: "Too many attempts. Try again later." });

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });

  const user = stmtGetUserByEmail.get(email);
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: "Invalid email or password." });

  const token = createAuthToken(user.id);
  const focusRecords = stmtGetFocusRecords.all(user.id).map(r => ({
    taskName: r.task_name, category: r.category, duration: r.duration,
    startTime: r.start_time, endTime: r.end_time,
  }));
  res.json({
    token,
    userId: user.id,
    email: user.email,
    profile: {
      name: user.name,
      character: safeJsonParse(user.character, { preset: 1 }),
      tagline: user.tagline,
      languages: safeJsonParse(user.languages, ["en"]),
      createdAt: user.created_at,
    },
    focusRecords,
  });
});

app.post("/api/logout", (req, res) => {
  const { token } = req.body || {};
  if (token) stmtDeleteToken.run(token);
  res.json({ ok: true });
});

app.get("/api/weekly-recap", (req, res) => {
  // Auth: Bearer token or ?token= query param
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    token = auth.slice(7);
  } else if (req.query.token) {
    token = req.query.token;
  }
  if (!token) return res.status(401).json({ error: "Authentication required." });

  const authRow = stmtGetToken.get(token);
  if (!authRow) return res.status(401).json({ error: "Invalid or expired token." });

  const userId = authRow.user_id;
  const weekStart = getLastWeekStart();

  const stats = stmtGetWeeklyStats.get(userId, weekStart);
  const copresence = stmtGetTopCopresence.get(userId, userId, userId, weekStart);

  let topPartner = null;
  if (copresence) {
    const partner = stmtGetUserById.get(copresence.partner_id);
    if (partner) {
      topPartner = {
        name: partner.name,
        sharedHours: Math.round((copresence.shared_secs / 3600) * 10) / 10,
      };
    }
  }

  res.json({
    weekStart,
    onlineHours: stats ? Math.round((stats.online_secs / 3600) * 10) / 10 : 0,
    reactionsReceived: stats ? stats.reactions_received : 0,
    catGiftsReceived: stats ? stats.cat_gifts_received : 0,
    topPartner,
  });
});

// Helper: sync player profile to DB
function syncProfileToDB(socketId) {
  const p = players[socketId];
  if (!p) return;
  stmtUpdateProfile.run(
    p.name,
    JSON.stringify(p.character),
    p.tagline,
    JSON.stringify(p.languages || []),
    p.birthMonth ?? null,
    p.profession || "mystery",
    p._userId
  );
}

const players = {};

// CJK-aware display width: CJK characters count as 2, others as 1
function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    w += (code >= 0x2E80 && code <= 0x9FFF) || (code >= 0xAC00 && code <= 0xD7AF) ||
         (code >= 0xF900 && code <= 0xFAFF) || (code >= 0xFE30 && code <= 0xFE4F) ||
         (code >= 0xFF00 && code <= 0xFFEF) || (code >= 0x20000 && code <= 0x2FA1F) ? 2 : 1;
  }
  return w;
}

function truncateToDisplayWidth(str, max) {
  let w = 0;
  let i = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    const cw = (code >= 0x2E80 && code <= 0x9FFF) || (code >= 0xAC00 && code <= 0xD7AF) ||
               (code >= 0xF900 && code <= 0xFAFF) || (code >= 0xFE30 && code <= 0xFE4F) ||
               (code >= 0xFF00 && code <= 0xFFEF) || (code >= 0x20000 && code <= 0x2FA1F) ? 2 : 1;
    if (w + cw > max) break;
    w += cw;
    i += ch.length;
  }
  return str.slice(0, i);
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); }
  catch { return fallback; }
}

// Strip HTML tags and dangerous Unicode control characters (RTL override, zero-width, etc.)
function sanitizeText(str) {
  return str
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "") // zero-width & bidi overrides
    .replace(/[<>]/g, ""); // strip angle brackets to prevent HTML injection
}

function getWeekStart(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getLastWeekStart() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return getWeekStart(d);
}

const CAMPFIRE_IDLE_MS = 60 * 1000;
const CAMPFIRE_TOGGLE_DIST = 80;
const outdoorLastSeen = { focus: 0, rest: 0 };
let lastOutdoorCheck = 0;

// Session persistence: survive tab sleep / reconnect
const sessions = {};          // sessionToken -> { playerId, disconnectTimer, playerSnapshot }
const socketToSession = {};   // socket.id -> sessionToken
const GRACE_PERIOD_MS = 4 * 60 * 60 * 1000; // 4h grace period — tabs can stay backgrounded for hours

function updateSessionSnapshot(socketId) {
  const token = socketToSession[socketId];
  if (token && sessions[token] && players[socketId]) {
    sessions[token].playerSnapshot = { ...players[socketId], giftPile: [...players[socketId].giftPile], languages: [...(players[socketId].languages || [])] };
  }
}

function savePlayerState(p) {
  if (!p || !p._userId) return;
  try {
    stmtSaveRuntimeState.run(p.x, p.y, p.room, p.status, p.direction, p.isSitting ? 1 : 0, p.isFocusing ? 1 : 0, p.focusStartTime || null, p.focusCategory || null, p._userId);
  } catch (e) {
    console.error("[STATE] save error:", e.message);
  }
}

const saveAllPlayerStates = db.transaction(() => {
  for (const p of Object.values(players)) {
    if (p._userId) {
      stmtSaveRuntimeState.run(p.x, p.y, p.room, p.status, p.direction, p.isSitting ? 1 : 0, p.isFocusing ? 1 : 0, p.focusStartTime || null, p.focusCategory || null, p._userId);
    }
  }
});
const chatHistory = [];
const MAX_CHAT_HISTORY = 50;
const TILE = 32;

// Defaults (overwritten after maps load by findPortalCenter)
const PORTAL_SPAWN = {
  focus: { x: 15 * TILE + TILE / 2, y: 2 * TILE + TILE / 2 },   // below top portal
  rest:  { x: 15 * TILE + TILE / 2, y: 14 * TILE + TILE / 2 },  // above bottom portal
};
const PORTAL_POS = {
  focus: { x: 15 * TILE + TILE / 2, y: 0 * TILE + TILE / 2 },   // top of Focus
  rest:  { x: 15 * TILE + TILE / 2, y: 16 * TILE + TILE / 2 },  // bottom of Lounge
};

// Furniture positions where cat can sit/sleep (in pixel coords)
const FURNITURE = {
  focus: [
    // 1-person desks
    { x: 3 * TILE, y: 3.5 * TILE, type: "desk" },
    { x: 27 * TILE, y: 3.5 * TILE, type: "desk" },
    { x: 3 * TILE, y: 11.5 * TILE, type: "desk" },
    { x: 27 * TILE, y: 11.5 * TILE, type: "desk" },
    // 2-person desks
    { x: 9 * TILE, y: 3.5 * TILE, type: "desk" },
    { x: 22 * TILE, y: 3.5 * TILE, type: "desk" },
    { x: 9 * TILE, y: 11.5 * TILE, type: "desk" },
    { x: 22 * TILE, y: 11.5 * TILE, type: "desk" },
    // 4-person desks
    { x: 15.5 * TILE, y: 3.5 * TILE, type: "desk" },
    { x: 15.5 * TILE, y: 11.5 * TILE, type: "desk" },
    // Rug
    { x: 15.5 * TILE, y: 7.5 * TILE, type: "rug" },
    // Bookshelves (cat sits in front)
    { x: 4 * TILE, y: 3 * TILE, type: "bookshelf" },
    { x: 12 * TILE, y: 3 * TILE, type: "bookshelf" },
    { x: 20 * TILE, y: 3 * TILE, type: "bookshelf" },
    { x: 28 * TILE, y: 3 * TILE, type: "bookshelf" },
    // Windows (cat sits in front)
    { x: 8 * TILE, y: 3 * TILE, type: "window" },
    { x: 16 * TILE, y: 3 * TILE, type: "window" },
    { x: 24 * TILE, y: 3 * TILE, type: "window" },
  ],
  rest: [
    // All targets in the main open area (rows 10+), rows 8-9 are dividing walls
    { x: 4.5 * TILE, y: 12 * TILE, type: "sofa" },
    { x: 8 * TILE, y: 12 * TILE, type: "sofa" },
    { x: 26.5 * TILE, y: 11.5 * TILE, type: "sofa" },
    { x: 30 * TILE, y: 12 * TILE, type: "sofa" },
    { x: 15.5 * TILE, y: 12 * TILE, type: "rug" },
    { x: 10 * TILE, y: 14 * TILE, type: "coffee" },
    { x: 20 * TILE, y: 11 * TILE, type: "window" },
    { x: 32 * TILE, y: 11 * TILE, type: "window" },
  ],
};

const GIFT_TYPES = ["fish", "leaf", "yarn"];

// Character config validation (Character Generator system)
function isValidCharConfig(config) {
  if (!config || typeof config !== "object") return false;
  if (config.preset) return Number.isInteger(config.preset) && config.preset >= 1 && config.preset <= 20;
  return Number.isInteger(config.body) && config.body >= 1 && config.body <= 9
      && Number.isInteger(config.eyes) && config.eyes >= 1 && config.eyes <= 7
      && typeof config.outfit === "string" && /^\d{2}_\d{2}$/.test(config.outfit)
      && typeof config.hair === "string" && /^\d{2}_\d{2}$/.test(config.hair)
      && (config.acc === null || config.acc === undefined || typeof config.acc === "string");
}

const REACTION_COOLDOWN = 30000;
const reactionCooldowns = {};
const VALID_REACTIONS = ["👋", "💪", "❤️", "👀"];

// Gift pile for idle Lounge players
const PILE_GIFT_INTERVAL = IS_PROD ? 15 * 60 * 1000 : 15000; // prod: 15min, staging: 15s
const MAX_GIFT_PILE = 10;

// Walkable tile types (must match client)
// 0=floor, 5=rug, 7=chair, 8=portal, 16=outdoor

function parseTiledMap(data) {
  const result = { map: null, cols: 0, rows: 0, outdoorMask: null, campfires: [], entrance: null };
  const tilesets = data.tilesets || [];
  const firstgid = tilesets[0] ? tilesets[0].firstgid : 1;
  let collisionLayer = null;
  let outdoorLayer = null;

  function tilesetForGid(gid) {
    for (let i = tilesets.length - 1; i >= 0; i--) {
      if (gid >= tilesets[i].firstgid) return tilesets[i];
    }
    return null;
  }

  function visitLayers(layers) {
    for (const l of layers) {
      if (l.type === "group" && l.layers) { visitLayers(l.layers); continue; }
      if (l.type === "tilelayer") {
        if (l.name === "collision") collisionLayer = l;
        if (l.name === "outdoor" || l.name === "outdoor_mask") outdoorLayer = l;
      } else if (l.type === "objectgroup" && l.objects) {
        for (const obj of l.objects) {
          // Named entrance marker (point or rectangle, no gid needed)
          const objName = String(obj.name || "").toLowerCase();
          if (objName === "entrance") {
            result.entrance = { x: Math.round(obj.x + (obj.width || 0) / 2), y: Math.round(obj.y + (obj.height || 0) / 2) };
          }
          if (!obj.gid) continue;
          const ts = tilesetForGid(obj.gid);
          const tsName = String((ts && (ts.source || ts.name)) || "").toLowerCase();
          const objLabel = String(obj.type || obj.class || obj.name || "").toLowerCase();
          if (tsName.includes("campfire") || objLabel.includes("campfire")) {
            const id = obj.id || `${Math.round(obj.x)}:${Math.round(obj.y)}`;
            result.campfires.push({
              id,
              x: obj.x,
              y: obj.y - obj.height,
              width: obj.width,
              height: obj.height,
            });
          }
        }
      }
    }
  }

  visitLayers(data.layers || []);
  if (!collisionLayer) {
    // Fallback to first tilelayer if collision missing
    const stack = [...(data.layers || [])];
    while (stack.length && !collisionLayer) {
      const l = stack.shift();
      if (l.type === "group" && l.layers) stack.push(...l.layers);
      else if (l.type === "tilelayer") collisionLayer = l;
    }
  }
  if (!collisionLayer) return result;

  const cols = collisionLayer.width;
  const rows = collisionLayer.height;
  const map = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const gid = collisionLayer.data[r * cols + c];
      row.push(gid === 0 ? 0 : gid - firstgid);
    }
    map.push(row);
  }
  result.map = map;
  result.cols = cols;
  result.rows = rows;

  if (outdoorLayer && outdoorLayer.data) {
    const mask = [];
    for (let r = 0; r < outdoorLayer.height; r++) {
      const row = [];
      for (let c = 0; c < outdoorLayer.width; c++) {
        const gid = outdoorLayer.data[r * outdoorLayer.width + c];
        row.push(gid !== 0);
      }
      mask.push(row);
    }
    result.outdoorMask = mask;
  }

  return result;
}

const MAPS_DIR = path.join(__dirname, "public", "maps");
const focusParsed = parseTiledMap(JSON.parse(fs.readFileSync(path.join(MAPS_DIR, "focus.json"), "utf-8")));
const restParsed  = parseTiledMap(JSON.parse(fs.readFileSync(path.join(MAPS_DIR, "rest.json"), "utf-8")));
const SERVER_MAPS = { focus: focusParsed.map, rest: restParsed.map };
const SERVER_OUTDOOR = { focus: focusParsed.outdoorMask, rest: restParsed.outdoorMask };
const CAMPFIRES = { focus: focusParsed.campfires || [], rest: restParsed.campfires || [] };
const ENTRANCE = { focus: focusParsed.entrance, rest: restParsed.entrance };
const campfireStates = { focus: {}, rest: {} };
for (const room of Object.keys(CAMPFIRES)) {
  for (const cf of CAMPFIRES[room]) {
    campfireStates[room][String(cf.id)] = false;
  }
}
const ROOM_DIMS = {
  focus: { cols: focusParsed.cols, rows: focusParsed.rows },
  rest:  { cols: restParsed.cols,  rows: restParsed.rows },
};

// Log collision map summary for debugging
for (const [room, map] of Object.entries(SERVER_MAPS)) {
  const dims = ROOM_DIMS[room];
  const counts = {};
  for (let r = 0; r < dims.rows; r++) {
    for (let c = 0; c < dims.cols; c++) {
      const t = map[r][c];
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  const walkable = Object.entries(counts).filter(([t]) => isWalkableTile(Number(t))).reduce((s, [, c]) => s + c, 0);
  console.log(`[COLLISION] ${room}: ${dims.cols}x${dims.rows}, tiles: ${JSON.stringify(counts)}, walkable: ${walkable}/${dims.cols * dims.rows}`);
}

// Auto-detect portal tile positions from collision data
function findPortalCenter(room) {
  const map = SERVER_MAPS[room];
  const dims = ROOM_DIMS[room];
  let sumX = 0, sumY = 0, count = 0;
  for (let r = 0; r < dims.rows; r++) {
    for (let c = 0; c < dims.cols; c++) {
      if (map[r][c] === 8) {
        sumX += c * TILE + TILE / 2;
        sumY += r * TILE + TILE / 2;
        count++;
      }
    }
  }
  return count > 0 ? { x: sumX / count, y: sumY / count } : null;
}
const focusPortal = findPortalCenter("focus");
const restPortal = findPortalCenter("rest");
if (focusPortal) {
  PORTAL_POS.focus = focusPortal;
  // Portal at top of Focus: spawn below it (inside room)
  const focusMidY = ROOM_DIMS.focus.rows * TILE / 2;
  PORTAL_SPAWN.focus = { x: focusPortal.x, y: focusPortal.y + (focusPortal.y < focusMidY ? 2 : -2) * TILE };
}
if (restPortal) {
  PORTAL_POS.rest = restPortal;
  // Portal at bottom of Lounge: spawn above it (inside room)
  const restMidY = ROOM_DIMS.rest.rows * TILE / 2;
  PORTAL_SPAWN.rest = { x: restPortal.x, y: restPortal.y + (restPortal.y < restMidY ? 2 : -2) * TILE };
}

function isWalkableTile(t) { return t === 0 || t === 5 || t === 6 || t === 7 || t === 8 || t === 9 || t === 12 || t === 13 || t === 14 || t === 15 || t === 16; }

// Cats can walk on everything except walls (1), windows (11), and ponds (17)
function isCatWalkableTile(t) { return t >= 0 && t !== 1 && t !== 11 && t !== 17; }

function isCatWalkable(x, y, room) {
  const map = SERVER_MAPS[room];
  const dims = ROOM_DIMS[room];
  const half = 8;
  const points = [
    { x: x, y: y },
    { x: x - half, y: y - half },
    { x: x + half, y: y - half },
    { x: x - half, y: y + half },
    { x: x + half, y: y + half },
  ];
  for (const p of points) {
    const col = Math.floor(p.x / TILE);
    const row = Math.floor(p.y / TILE);
    if (row < 0 || row >= dims.rows || col < 0 || col >= dims.cols) return false;
    if (!isCatWalkableTile(map[row][col])) return false;
  }
  return true;
}

function isOutdoorAt(x, y, room) {
  const dims = ROOM_DIMS[room];
  if (!dims) return false;
  const col = Math.floor(x / TILE);
  const row = Math.floor(y / TILE);
  if (row < 0 || row >= dims.rows || col < 0 || col >= dims.cols) return false;
  const mask = SERVER_OUTDOOR[room];
  if (mask && mask[row]) return !!mask[row][col];
  const map = SERVER_MAPS[room];
  if (map && map[row]) return map[row][col] === 16;
  return false;
}

function findCampfire(room, id) {
  const list = CAMPFIRES[room] || [];
  const sid = String(id);
  return list.find(cf => String(cf.id) === sid) || null;
}

function setCampfireState(room, id, lit) {
  const sid = String(id);
  if (!campfireStates[room] || campfireStates[room][sid] === lit) return;
  campfireStates[room][sid] = lit;
  io.to(room).emit("campfireUpdate", { room, id: sid, lit: !!lit });
}

function updateOutdoorPresence(now) {
  for (const room of ["focus", "rest"]) {
    let anyOutdoor = false;
    for (const p of Object.values(players)) {
      if (p.room !== room) continue;
      if (isOutdoorAt(p.x, p.y, room)) { anyOutdoor = true; break; }
    }
    if (anyOutdoor) outdoorLastSeen[room] = now;
    if (now - outdoorLastSeen[room] > CAMPFIRE_IDLE_MS) {
      const states = campfireStates[room] || {};
      for (const id of Object.keys(states)) {
        if (states[id]) setCampfireState(room, id, false);
      }
    }
  }
}

function getCatTileAt(x, y, room) {
  const map = SERVER_MAPS[room];
  const dims = ROOM_DIMS[room];
  const col = Math.floor(x / TILE);
  const row = Math.floor(y / TILE);
  if (row < 0 || row >= dims.rows || col < 0 || col >= dims.cols) return null;
  return map[row][col];
}

function findDownwardWalkable(x, y, room, maxSteps = 4) {
  const dims = ROOM_DIMS[room];
  const col = Math.floor(x / TILE);
  const startRow = Math.floor(y / TILE);
  if (col < 0 || col >= dims.cols) return null;
  for (let step = 1; step <= maxSteps; step++) {
    const row = startRow + step;
    if (row < 0 || row >= dims.rows) break;
    const cx = col * TILE + TILE / 2;
    const cy = row * TILE + TILE / 2;
    if (isCatWalkable(cx, cy, room)) return { x: cx, y: cy };
  }
  return null;
}

// BFS pathfinding on tile grid — 4-direction only (no diagonal corner clipping)
function findPath(sx, sy, ex, ey, room) {
  const map = SERVER_MAPS[room];
  const dims = ROOM_DIMS[room];
  const sc = Math.max(0, Math.min(dims.cols - 1, Math.floor(sx / TILE)));
  const sr = Math.max(0, Math.min(dims.rows - 1, Math.floor(sy / TILE)));
  const ec = Math.max(0, Math.min(dims.cols - 1, Math.floor(ex / TILE)));
  const er = Math.max(0, Math.min(dims.rows - 1, Math.floor(ey / TILE)));
  if (sr === er && sc === ec) return [{ x: ex, y: ey }];
  if (!isCatWalkableTile(map[er][ec])) return null;

  const key = (r, c) => r * dims.cols + c;
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
        const cr = Math.floor(ck / dims.cols);
        const cc = ck % dims.cols;
        path.unshift({ x: cc * TILE + TILE / 2, y: cr * TILE + TILE / 2 });
        ck = parent.get(ck);
      }
      // Append exact destination
      path.push({ x: ex, y: ey });
      return path;
    }
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= dims.rows || nc < 0 || nc >= dims.cols) continue;
      const nk = key(nr, nc);
      if (visited.has(nk)) continue;
      if (!isCatWalkableTile(map[nr][nc])) continue;
      visited.add(nk);
      parent.set(nk, key(r, c));
      queue.push([nr, nc]);
    }
  }
  return null;
}

// Set cat target with pathfinding
function setCatTarget(tx, ty, opts) {
  // Prevent cat from entering narrow upper corridors of rest room (rows 0-9 are walls/rooms)
  if (cat.room === "rest" && !cat.walkingToPortal) {
    ty = Math.max(ty, 10 * TILE + TILE / 2);
  }
  // Snap target to walkable if needed
  let fx = tx, fy = ty;
  if (opts && opts.preferDown) {
    const t = getCatTileAt(fx, fy, cat.room);
    if (t !== null && !isCatWalkableTile(t)) {
      const down = findDownwardWalkable(fx, fy, cat.room, 4);
      if (down) { fx = down.x; fy = down.y; }
    }
  }
  if (!isCatWalkable(fx, fy, cat.room)) {
    let found = false;
    for (let r = 8; r <= 128; r += 8) {
      for (const [dx, dy] of [[r,0],[-r,0],[0,r],[0,-r],[r,r],[-r,r],[r,-r],[-r,-r]]) {
        if (isCatWalkable(fx + dx, fy + dy, cat.room)) {
          fx = fx + dx; fy = fy + dy;
          found = true; break;
        }
      }
      if (found) break;
    }
    if (!found) {
      // Last resort: pick a random walkable position in the safe area
      const dims = ROOM_DIMS[cat.room];
      const minY = cat.room === "rest" ? 10 * TILE + TILE / 2 : TILE * 2;
      for (let attempt = 0; attempt < 20; attempt++) {
        const rx = 80 + Math.random() * (dims.cols * TILE - 160);
        const ry = minY + Math.random() * (dims.rows * TILE - 80 - minY);
        if (isCatWalkable(rx, ry, cat.room)) { fx = rx; fy = ry; found = true; break; }
      }
      if (!found) { cat.targetX = cat.x; cat.targetY = cat.y; cat._path = null; return; }
    }
  }
  cat.targetX = fx;
  cat.targetY = fy;
  cat._path = findPath(cat.x, cat.y, fx, fy, cat.room);
  cat._stuckCount = 0;
  cat._moveStartTick = cat._tick || 0;
  // If pathfinding failed completely, don't attempt movement
  if (!cat._path && Math.abs(fx - cat.x) + Math.abs(fy - cat.y) > TILE) {
    cat.targetX = cat.x; cat.targetY = cat.y;
  }
}

function isSpawnSafe(x, y, room) {
  const map = SERVER_MAPS[room];
  const dims = ROOM_DIMS[room];
  const half = 10;
  const points = [
    { x: x - half, y: y - half },
    { x: x + half, y: y - half },
    { x: x - half, y: y + half },
    { x: x + half, y: y + half },
  ];
  for (const p of points) {
    const col = Math.floor(p.x / TILE);
    const row = Math.floor(p.y / TILE);
    if (row < 0 || row >= dims.rows || col < 0 || col >= dims.cols) return false;
    if (!isWalkableTile(map[row][col])) return false;
  }
  return true;
}

function getInitialSpawn() {
  // Spawn at bottom entrance of Focus Zone
  const dims = ROOM_DIMS.focus;
  const cx = Math.floor(dims.cols / 2) * TILE;
  const cy = (dims.rows - 1) * TILE + TILE / 2;
  for (let i = 0; i < 50; i++) {
    const x = cx - 48 + Math.floor(Math.random() * 96);
    const y = cy - 16 + Math.floor(Math.random() * 32);
    if (isSpawnSafe(x, y, "focus")) return { x, y };
  }
  return { x: cx, y: cy };
}

function getPortalSpawn(room) {
  const base = PORTAL_SPAWN[room];
  for (let i = 0; i < 20; i++) {
    const x = base.x - 16 + Math.floor(Math.random() * 32);
    const y = base.y;
    if (isSpawnSafe(x, y, room)) return { x, y };
  }
  return { x: base.x, y: base.y };
}

// ============================================================
// CAT
// ============================================================
const cat = {
  x: 20 * TILE + TILE / 2,   // center of middle room open area
  y: 13 * TILE + TILE / 2,
  room: "focus",
  state: "sit",
  targetX: 20 * TILE + TILE / 2,
  targetY: 13 * TILE + TILE / 2,
  stateTimer: 100,
  portalDelay: 0,
  walkingToPortal: false,
  pendingRoom: null,
  visitTimer: 0,
  curioTarget: null,
  onFurniture: null,  // furniture type if sitting on one
  gift: null,         // current gift the cat is carrying
  giftTimer: 3600,    // countdown to pick up a gift
  giftTarget: null,   // player to deliver gift to
  earPerk: 0,         // ticks of ear-perked state (chat reaction)
};

// Validate initial cat spawn is walkable
if (!isCatWalkable(cat.x, cat.y, cat.room)) {
  const dims = ROOM_DIMS[cat.room];
  for (let r = 0; r < dims.rows; r++) {
    for (let c = 0; c < dims.cols; c++) {
      const px = c * TILE + TILE / 2;
      const py = r * TILE + TILE / 2;
      if (isCatWalkable(px, py, cat.room)) {
        cat.x = px; cat.y = py;
        cat.targetX = px; cat.targetY = py;
        break;
      }
    }
    if (isCatWalkable(cat.x, cat.y, cat.room)) break;
  }
}

function getPlayersInRoom(room) {
  return Object.values(players).filter((p) => p.room === room);
}

// Get user's approximate hour (server-side we use server time as proxy)
function getHour() {
  return new Date().getHours();
}

function isNightTime() {
  const h = getHour();
  return h >= 22 || h < 6;
}

function isMorning() {
  const h = getHour();
  return h >= 6 && h < 10;
}

function onPlayerEnterRoom(playerId, room) {
  if (cat.room !== room && !cat.pendingRoom) {
    const chance = (cat.state === "sleep" || cat.state === "sit") ? 0.6 : 0.3;
    if (Math.random() < chance) {
      cat.pendingRoom = room;
      cat.portalDelay = 60 + Math.floor(Math.random() * 40);
      cat.curioTarget = playerId;
    }
  } else if (cat.room === room && cat.state !== "wander" && cat.state !== "gift_deliver") {
    // Run partway toward the player and stop to watch (like a real cat)
    const p = players[playerId];
    if (p) {
      cat.state = "curious";
      cat.curioTarget = playerId;
      cat.onFurniture = null;
      // Stop at ~35% of the way, keeping a comfortable distance
      const stopX = cat.x + (p.x - cat.x) * 0.35;
      const stopY = cat.y + (p.y - cat.y) * 0.35;
      setCatTarget(stopX, stopY);
      cat.stateTimer = 120;
    }
  }
}

function onChatMessage() {
  // Cat reacts to chat with ear perk
  if (cat.room === "rest") {
    cat.earPerk = 40; // ~2 seconds
  }
}

function pickFurnitureTarget() {
  const spots = FURNITURE[cat.room] || [];
  if (spots.length === 0) return null;
  // Weight by proximity — avoid long trips to far furniture
  const weights = spots.map(s => {
    const dx = s.x - cat.x, dy = s.y - cat.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return 1 / (1 + dist / (4 * TILE));
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < spots.length; i++) {
    r -= weights[i];
    if (r <= 0) return spots[i];
  }
  return spots[spots.length - 1];
}

function updateCat() {
  // Safety net: if cat is in a non-walkable tile, snap to nearest walkable spot
  if (!isCatWalkable(cat.x, cat.y, cat.room)) {
    for (let r = 8; r <= 64; r += 8) {
      let found = false;
      for (const [dx, dy] of [[r,0],[-r,0],[0,r],[0,-r],[r,r],[-r,r],[r,-r],[-r,-r]]) {
        if (isCatWalkable(cat.x + dx, cat.y + dy, cat.room)) {
          cat.x += dx;
          cat.y += dy;
          found = true;
          break;
        }
      }
      if (found) break;
    }
  }

  // Ear perk countdown
  if (cat.earPerk > 0) cat.earPerk--;

  // Handle portal travel: delay → walk to portal → switch rooms
  if (cat.pendingRoom) {
    if (cat.portalDelay > 0) {
      // Phase 1: short pause before walking to portal
      cat.portalDelay--;
      if (cat.portalDelay <= 0) {
        cat.walkingToPortal = true;
        cat.state = "wander";
        cat.onFurniture = null;
        cat.gift = null;
      }
      return;
    }
    if (!cat.walkingToPortal) {
      cat.walkingToPortal = true;
      cat.state = "wander";
      cat.onFurniture = null;
      cat.gift = null;
      // Compute path to portal
      const portal = PORTAL_POS[cat.room];
      cat._portalPath = findPath(cat.x, cat.y, portal.x, portal.y, cat.room);
    }
    if (cat.walkingToPortal) {
      // Phase 2: follow path toward portal
      const portal = PORTAL_POS[cat.room];
      let goalX = portal.x, goalY = portal.y;
      if (cat._portalPath && cat._portalPath.length > 0) {
        goalX = cat._portalPath[0].x;
        goalY = cat._portalPath[0].y;
        const wdx = goalX - cat.x, wdy = goalY - cat.y;
        if (Math.sqrt(wdx * wdx + wdy * wdy) <= 5) {
          cat._portalPath.shift();
          if (cat._portalPath.length > 0) { goalX = cat._portalPath[0].x; goalY = cat._portalPath[0].y; }
          else { goalX = portal.x; goalY = portal.y; }
        }
      }
      const dx = portal.x - cat.x;
      const dy = portal.y - cat.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 8) {
        const cdx = goalX - cat.x, cdy = goalY - cat.y;
        const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
        if (cdist > 0.5) {
          const nx = cat.x + (cdx / cdist) * 1.0;
          const ny = cat.y + (cdy / cdist) * 1.0;
          if (isCatWalkable(nx, ny, cat.room)) { cat.x = nx; cat.y = ny; }
          else if (isCatWalkable(nx, cat.y, cat.room)) { cat.x = nx; }
          else if (isCatWalkable(cat.x, ny, cat.room)) { cat.y = ny; }
          else {
            // Try perpendicular nudge before recalculating
            let nudged = false;
            for (const n of [{x:1,y:0},{x:-1,y:0},{x:0,y:-1},{x:0,y:1}]) {
              const px = cat.x + n.x, py = cat.y + n.y;
              if (isCatWalkable(px, py, cat.room) &&
                  (Math.abs(goalX - px) < Math.abs(goalX - cat.x) ||
                   Math.abs(goalY - py) < Math.abs(goalY - cat.y))) {
                cat.x = px; cat.y = py; nudged = true; break;
              }
            }
            if (!nudged) {
              cat._portalPath = findPath(cat.x, cat.y, portal.x, portal.y, cat.room);
            }
          }
        }
      } else {
        // Phase 3: arrived at portal, switch rooms
        cat.room = cat.pendingRoom;
        // Find a safe cat-walkable spawn in the main area (avoid narrow corridors)
        const spawn = getPortalSpawn(cat.room);
        let sx = spawn.x, sy = spawn.y;
        const catMinY = cat.room === "rest" ? 10 * TILE + TILE / 2 : 0;
        if (!isCatWalkable(sx, sy, cat.room) || sy < catMinY) {
          const dims = ROOM_DIMS[cat.room];
          const cx = Math.floor(dims.cols / 2) * TILE + TILE / 2;
          const cy = Math.max(Math.floor(dims.rows / 2) * TILE + TILE / 2, catMinY);
          let found = false;
          for (let r = 0; r <= 128; r += 8) {
            for (const [dx, dy] of [[0,0],[r,0],[-r,0],[0,r],[0,-r],[r,r],[-r,r],[r,-r],[-r,-r]]) {
              const nx = cx + dx, ny = cy + dy;
              if (ny >= catMinY && isCatWalkable(nx, ny, cat.room)) {
                sx = nx; sy = ny;
                found = true; break;
              }
            }
            if (found) break;
          }
        }
        cat.x = sx;
        cat.y = sy;
        cat.pendingRoom = null;
        cat.walkingToPortal = false;
        cat.onFurniture = null;

        if (cat.curioTarget && players[cat.curioTarget] &&
            players[cat.curioTarget].room === cat.room) {
          // Run partway toward the player and stop to watch
          const cp = players[cat.curioTarget];
          cat.state = "curious";
          const stopX = cat.x + (cp.x - cat.x) * 0.35;
          const stopY = cat.y + (cp.y - cat.y) * 0.35;
          setCatTarget(stopX, stopY);
          cat.stateTimer = 120;
        } else {
          const dims = ROOM_DIMS[cat.room];
          const minY = cat.room === "rest" ? 10 * TILE : 80;
          const maxY = cat.room === "focus" ? Math.min((dims.rows - 4) * TILE, dims.rows * TILE - 160) : dims.rows * TILE - 80;
          cat.state = "wander";
          setCatTarget(80 + Math.random() * (dims.cols * TILE - 160), minY + Math.random() * (maxY - minY));
          cat.stateTimer = 100;
        }
      }
      return;
    }
  }

  // Gift pile delivery for idle Lounge players (priority over random gifts)
  const pileNow = Date.now();
  const restPlayers = getPlayersInRoom("rest");
  const idleCandidates = restPlayers.filter(p => {
    const expected = Math.floor((pileNow - p.lastMoveTime) / PILE_GIFT_INTERVAL);
    return expected > p.idlePileCount && p.idlePileCount < MAX_GIFT_PILE;
  });
  if (!cat.gift && cat.state !== "gift_deliver" && !cat.pendingRoom) {
    const idleTarget = idleCandidates[0];

    if (idleTarget) {
      if (cat.room === "rest") {
        cat.gift = GIFT_TYPES[Math.floor(Math.random() * GIFT_TYPES.length)];
        cat.giftTarget = idleTarget.id;
        cat.state = "gift_deliver";
        cat.onFurniture = null;
        cat._pileDelivery = true;
        cat._giftStart = Date.now();
        setCatTarget(idleTarget.x + (Math.random() > 0.5 ? 20 : -20), idleTarget.y + 10);
        cat.stateTimer = 200;
      } else if (!cat.pendingRoom) {
        // Cat is in focus room, encourage visit to Lounge
        cat.pendingRoom = "rest";
        cat.portalDelay = 20;
        cat.curioTarget = null;
      }
    }
  }

  // Gift logic: occasionally pick up a gift and deliver to a player
  if (!cat.gift && cat.state !== "gift_deliver") {
    cat.giftTimer--;
    if (cat.giftTimer <= 0) {
      cat.giftTimer = 3600 + Math.floor(Math.random() * 3600); // 3-6 min
      const nearby = getPlayersInRoom(cat.room);
      if (nearby.length > 0 && Math.random() < 0.4) {
        cat.gift = GIFT_TYPES[Math.floor(Math.random() * GIFT_TYPES.length)];
        cat.giftTarget = nearby[Math.floor(Math.random() * nearby.length)].id;
        cat.state = "gift_deliver";
        cat.onFurniture = null;
        cat._pileDelivery = false;
        cat._giftStart = Date.now();
        const p = players[cat.giftTarget];
        if (p) {
          setCatTarget(p.x + (Math.random() > 0.5 ? 25 : -25), p.y + 15);
          cat.stateTimer = 200;
        }
      }
    }
  }

  // Periodic room visits
  cat.visitTimer--;
  if (cat.visitTimer <= 0) {
    cat.visitTimer = 400 + Math.floor(Math.random() * 600);
    const otherRoom = cat.room === "focus" ? "rest" : "focus";
    const otherP = getPlayersInRoom(otherRoom);
    const thisP = getPlayersInRoom(cat.room);
    if (otherP.length > 0 && !cat.pendingRoom) {
      const chance = thisP.length === 0 ? 0.8 : 0.35;
      if (Math.random() < chance) {
        cat.pendingRoom = otherRoom;
        cat.portalDelay = 40 + Math.floor(Math.random() * 40);
        cat.curioTarget = null;
      }
    }
  }

  cat.stateTimer--;

  // Track total ticks for movement timeout
  if (!cat._tick) cat._tick = 0;
  cat._tick++;

  // Global anti-stuck: if cat hasn't moved >16px in 100 ticks during movement, teleport to room center
  const isMovementState = cat.state === "wander" || cat.state === "curious" || cat.state === "zoomies" || cat.state === "leg_rub" || cat.state === "gift_deliver";
  if (isMovementState) {
    // Hard timeout: if any movement state lasts >400 ticks (~20s), force sit
    if (cat._moveStartTick && cat._tick - cat._moveStartTick > 400) {
      cat.onFurniture = null;
      cat._path = null;
      cat.gift = null; cat.giftTarget = null; cat._giftChaseStart = null;
      cat.state = "sit";
      cat.stateTimer = 60 + Math.floor(Math.random() * 60);
      cat._antiStuckTick = 0;
      return;
    }
    if (!cat._antiStuckX) { cat._antiStuckX = cat.x; cat._antiStuckY = cat.y; cat._antiStuckTick = 0; }
    cat._antiStuckTick++;
    if (cat._antiStuckTick >= 100) {
      const moved = Math.abs(cat.x - cat._antiStuckX) + Math.abs(cat.y - cat._antiStuckY);
      if (moved < 16) {
        // Teleport to a safe central position instead of resting in place
        const dims = ROOM_DIMS[cat.room];
        const cx = Math.floor(dims.cols / 2) * TILE + TILE / 2;
        const cy = Math.floor(dims.rows / 2) * TILE + TILE / 2;
        for (let r = 0; r <= 64; r += 8) {
          let found = false;
          for (const [dx, dy] of [[0,0],[r,0],[-r,0],[0,r],[0,-r],[r,r],[-r,r],[r,-r],[-r,-r]]) {
            if (isCatWalkable(cx + dx, cy + dy, cat.room)) {
              cat.x = cx + dx; cat.y = cy + dy;
              cat.targetX = cat.x; cat.targetY = cat.y;
              found = true; break;
            }
          }
          if (found) break;
        }
        cat.onFurniture = null;
        cat._path = null;
        cat.gift = null; cat.giftTarget = null; cat._giftChaseStart = null;
        // Use sit state instead of enterRestState() to avoid immediately
        // picking the same furniture target and getting stuck again
        cat.state = "sit";
        cat.stateTimer = 80 + Math.floor(Math.random() * 80);
        cat._antiStuckTick = 0;
        cat._antiStuckX = cat.x;
        cat._antiStuckY = cat.y;
        return;
      }
      cat._antiStuckX = cat.x;
      cat._antiStuckY = cat.y;
      cat._antiStuckTick = 0;
    }
  } else {
    cat._antiStuckTick = 0;
  }

  // Movement states
  if (cat.state === "wander" || cat.state === "curious" || cat.state === "gift_deliver" || cat.state === "zoomies" || cat.state === "leg_rub") {
    // Leg rub: direct movement around target player (no BFS)
    if (cat.state === "leg_rub") {
      const rubP = cat.rubTarget ? players[cat.rubTarget] : null;
      if (!rubP || rubP.room !== cat.room) {
        // Target left, stop rubbing
        cat.state = "sit"; cat.stateTimer = 100;
        cat.rubTarget = null; cat._rubWaypoints = null;
        return;
      }
      // Check if target moved away
      const rdx = rubP.x - cat.x, rdy = rubP.y - cat.y;
      if (Math.sqrt(rdx * rdx + rdy * rdy) > 120) {
        cat.state = "sit"; cat.stateTimer = 100;
        cat.rubTarget = null; cat._rubWaypoints = null;
        return;
      }
      // Follow elliptical waypoints around the player
      if (!cat._rubWaypoints || cat._rubWaypoints.length === 0) {
        // Completed the circuit
        cat.state = "sit"; cat.stateTimer = 120;
        cat.rubTarget = null;
        return;
      }
      const wp = cat._rubWaypoints[0];
      // Update waypoint position relative to current player position
      const wx = rubP.x + wp.ox;
      const wy = rubP.y + wp.oy;
      const wdx = wx - cat.x, wdy = wy - cat.y;
      const wdist = Math.sqrt(wdx * wdx + wdy * wdy);
      if (wdist < 6) {
        cat._rubWaypoints.shift();
      } else {
        const spd = 2.0;
        const nx = cat.x + (wdx / wdist) * spd;
        const ny = cat.y + (wdy / wdist) * spd;
        if (isCatWalkable(nx, ny, cat.room)) { cat.x = nx; cat.y = ny; }
        else if (isCatWalkable(nx, cat.y, cat.room)) { cat.x = nx; }
        else if (isCatWalkable(cat.x, ny, cat.room)) { cat.y = ny; }
      }
      return;
    }

    // Zoomies: follow waypoints at high speed
    if (cat.state === "zoomies") {
      if (!cat._zoomiesWaypoints || cat._zoomiesWaypoints.length === 0) {
        cat.state = "sit"; cat.stateTimer = 100; // sit to catch breath
        cat._zoomiesWaypoints = null;
        return;
      }
      const wp = cat._zoomiesWaypoints[0];
      const zdx = wp.x - cat.x, zdy = wp.y - cat.y;
      const zdist = Math.sqrt(zdx * zdx + zdy * zdy);
      if (zdist < 8) {
        cat._zoomiesWaypoints.shift();
      } else {
        const spd = 6.0;
        const nx = cat.x + (zdx / zdist) * spd;
        const ny = cat.y + (zdy / zdist) * spd;
        if (isCatWalkable(nx, ny, cat.room)) { cat.x = nx; cat.y = ny; }
        else if (isCatWalkable(nx, cat.y, cat.room)) { cat.x = nx; }
        else if (isCatWalkable(cat.x, ny, cat.room)) { cat.y = ny; }
        else {
          // Stuck, skip this waypoint
          cat._zoomiesWaypoints.shift();
        }
      }
      // Safety timeout
      cat.stateTimer--;
      if (cat.stateTimer <= 0) {
        cat.state = "sit"; cat.stateTimer = 100;
        cat._zoomiesWaypoints = null;
      }
      return;
    }

    // Curious: if target left the room, stop
    if (cat.state === "curious" && cat.curioTarget) {
      const cp = players[cat.curioTarget];
      if (!cp || cp.room !== cat.room) {
        cat.state = "sit"; cat.stateTimer = 100;
        cat.curioTarget = null;
      }
    }

    // Gift delivery: follow target player, 10s timeout only after player moves
    if (cat.state === "gift_deliver" && cat.giftTarget) {
      const tp = players[cat.giftTarget];
      if (!tp || tp.room !== cat.room) {
        // Target left, give up
        cat.state = "sit"; cat.stateTimer = 80;
        cat.gift = null; cat.giftTarget = null; cat._pileDelivery = false; cat._giftChaseStart = null;
      } else {
        // Check if player moved since delivery started
        const newTx = tp.x + (cat.targetX > tp.x ? 20 : -20);
        const newTy = tp.y + 10;
        const playerMoved = Math.abs(newTx - cat.targetX) > 16 || Math.abs(newTy - cat.targetY) > 16;
        if (playerMoved) {
          // Start chase timer on first move, keep tracking
          if (!cat._giftChaseStart) cat._giftChaseStart = Date.now();
          setCatTarget(newTx, newTy);
        }
        // Only timeout if player has moved (chase mode)
        if (cat._giftChaseStart && Date.now() - cat._giftChaseStart > 10000) {
          cat.state = "sit"; cat.stateTimer = 80;
          cat.gift = null; cat.giftTarget = null; cat._pileDelivery = false;
          cat._giftChaseStart = null;
        }
      }
    }

    // Follow path waypoints (4-direction, axis-aligned)
    const speed = cat.state === "gift_deliver" ? 7.0 : (cat.state === "curious" ? 5.0 : 3.0);
    // Note: zoomies (6.0) and leg_rub (2.0) handle their own movement above

    // Advance through reached waypoints
    while (cat._path && cat._path.length > 0) {
      const wp = cat._path[0];
      const wd = Math.abs(wp.x - cat.x) + Math.abs(wp.y - cat.y);
      if (wd < 6) cat._path.shift();
      else break;
    }

    const fdx = cat.targetX - cat.x;
    const fdy = cat.targetY - cat.y;
    const finalDist = Math.sqrt(fdx * fdx + fdy * fdy);
    if (finalDist > 5) {
      // Pick next waypoint or final target
      let goalX = cat.targetX, goalY = cat.targetY;
      if (cat._path && cat._path.length > 0) {
        goalX = cat._path[0].x;
        goalY = cat._path[0].y;
      }
      const cdx = goalX - cat.x;
      const cdy = goalY - cat.y;
      const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
      if (cdist > 0.5) {
        const mx = (cdx / cdist) * speed;
        const my = (cdy / cdist) * speed;
        const nx = cat.x + mx;
        const ny = cat.y + my;
        if (isCatWalkable(nx, ny, cat.room)) {
          cat.x = nx; cat.y = ny;
          cat._stuckCount = 0;
        } else if (isCatWalkable(nx, cat.y, cat.room)) {
          cat.x = nx; cat._stuckCount = 0;
        } else if (isCatWalkable(cat.x, ny, cat.room)) {
          cat.y = ny; cat._stuckCount = 0;
        } else {
          // All 3 axis-aligned moves blocked — try perpendicular nudges
          // to slip past tile boundaries (e.g. bounding box clipping into adjacent wall)
          let nudged = false;
          const nudges = [
            { x: speed, y: 0 }, { x: -speed, y: 0 },
            { x: 0, y: -speed }, { x: 0, y: speed },
          ];
          for (const n of nudges) {
            const px = cat.x + n.x, py = cat.y + n.y;
            if (!isCatWalkable(px, py, cat.room)) continue;
            // Only nudge if it reduces distance to goal on at least one axis
            if (Math.abs(goalX - px) < Math.abs(goalX - cat.x) ||
                Math.abs(goalY - py) < Math.abs(goalY - cat.y)) {
              cat.x = px; cat.y = py;
              nudged = true;
              break;
            }
          }
          if (!nudged) {
            cat._stuckCount = (cat._stuckCount || 0) + 1;
            if (cat._stuckCount > 15) {
              // Skip current waypoint or give up
              if (cat._path && cat._path.length > 0) cat._path.shift();
              else {
                cat._stuckCount = 0;
                cat.onFurniture = null;
                enterRestState();
                return;
              }
              cat._stuckCount = 0;
            }
          } else {
            cat._stuckCount = 0;
          }
        }
      } else {
        // Waypoint too close but final target far — skip
        if (cat._path && cat._path.length > 0) cat._path.shift();
        else {
          cat.onFurniture = null;
          enterRestState();
          return;
        }
      }
    } else {
      if (cat.state === "gift_deliver") {
        if (cat._pileDelivery && players[cat.giftTarget]) {
          // Add gift to player's pile
          const target = players[cat.giftTarget];
          target.giftPile.push(cat.gift);
          target.idlePileCount++;
          io.to(target.room).emit("giftPileUpdated", { id: cat.giftTarget, giftPile: [...target.giftPile] });

          // Weekly stats: count cat gift received
          try { stmtIncrCatGiftsReceived.run(target._userId, getWeekStart()); }
          catch (e) { console.error("[WEEKLY] cat gift increment error:", e.message); }

          cat.state = "sit";
          cat.stateTimer = 150; // Sit and admire the pile
          cat._pileDelivery = false;
          cat.gift = null;
          cat.giftTarget = null;
          cat._giftChaseStart = null;
        } else {
          // Normal gift drop
          cat.state = "sit";
          cat.stateTimer = 100;
          cat._giftChaseStart = null;
          setTimeout(() => { cat.gift = null; cat.giftTarget = null; }, 5000);
        }
      } else if (cat.state === "curious") {
        cat.state = "sit";
        cat.stateTimer = 150 + Math.floor(Math.random() * 150);
        cat.curioTarget = null;
      } else {
        enterRestState();
      }
    }
  }
  else if (cat.stateTimer <= 0) {
    cat.onFurniture = null;
    cat.faceDir = null;
    const r = Math.random();
    const nearby = getPlayersInRoom(cat.room);
    const lively = Math.min(nearby.length * 0.06, 0.18);

    // Fatigue care: approach players focusing 120min+
    const now = Date.now();
    const fatigued = nearby.filter(p =>
      p.isFocusing && p.focusStartTime && (now - p.focusStartTime) > (IS_PROD ? 120 * 60 * 1000 : 40000) // prod: 120min, staging: 40s
    );
    if (fatigued.length > 0 && Math.random() < 0.4) {
      const target = fatigued[Math.floor(Math.random() * fatigued.length)];
      cat.state = "curious";
      cat.curioTarget = target.id;
      cat.onFurniture = null;
      setCatTarget(target.x + (Math.random() > 0.5 ? 30 : -30), target.y + (Math.random() > 0.5 ? 20 : -20));
      cat.stateTimer = 180;
    } else if (r < 0.03) {
      // Zoomies: 3% chance, random burst of energy
      const dims = ROOM_DIMS[cat.room];
      const minY = cat.room === "rest" ? 10 * TILE : 80;
      const maxY = cat.room === "focus" ? Math.min((dims.rows - 4) * TILE, dims.rows * TILE - 160) : dims.rows * TILE - 80;
      const waypointCount = 3 + Math.floor(Math.random() * 2); // 3-4 points
      const waypoints = [];
      for (let i = 0; i < waypointCount; i++) {
        waypoints.push({
          x: 80 + Math.random() * (dims.cols * TILE - 160),
          y: minY + Math.random() * (maxY - minY),
        });
      }
      cat.state = "zoomies";
      cat._zoomiesWaypoints = waypoints;
      cat.onFurniture = null;
      cat.stateTimer = 150; // max safety timeout
    } else if ((() => {
      // Leg rub: 10% chance if a player has been still for 5s+ within 80px
      const stillPlayers = nearby.filter(p => {
        const idle = now - p.lastMoveTime;
        if (idle < 5000) return false;
        const dx = p.x - cat.x, dy = p.y - cat.y;
        return Math.sqrt(dx * dx + dy * dy) < 80;
      });
      if (stillPlayers.length > 0 && Math.random() < 0.10) {
        const target = stillPlayers[Math.floor(Math.random() * stillPlayers.length)];
        cat.state = "leg_rub";
        cat.rubTarget = target.id;
        cat.onFurniture = null;
        // 4-point elliptical path around player (front-left, front-right, back-right, back-left)
        cat._rubWaypoints = [
          { ox: -20, oy: 12 },
          { ox: 20, oy: 12 },
          { ox: 20, oy: -12 },
          { ox: -20, oy: -12 },
        ];
        cat.stateTimer = 300; // safety timeout
        return true;
      }
      return false;
    })()) {
      // leg_rub was triggered above
    } else if ((() => {
      // Campfire warmth: 20% chance if a lit campfire exists in the room
      const roomCfs = CAMPFIRES[cat.room] || [];
      const litCf = roomCfs.find(cf => campfireStates[cat.room][String(cf.id)]);
      if (litCf && Math.random() < 0.20) {
        const cfx = litCf.x + (litCf.width || 0) / 2;
        const cfy = litCf.y + (litCf.height || 0) / 2;
        cat.state = "wander";
        cat.onFurniture = "campfire";
        setCatTarget(cfx, cfy + TILE); // sit in front of campfire
        cat.stateTimer = 150;
        return true;
      }
      return false;
    })()) {
      // campfire warmth was triggered above
    } else if (r < 0.2 + lively) {
      // Wander to random spot (within main area, exclude entrance and narrow upper corridors)
      const dims = ROOM_DIMS[cat.room];
      const minY = cat.room === "rest" ? 10 * TILE : 80;
      const maxY = cat.room === "focus" ? Math.min((dims.rows - 4) * TILE, dims.rows * TILE - 160) : dims.rows * TILE - 80;
      cat.state = "wander";
      setCatTarget(80 + Math.random() * (dims.cols * TILE - 160), minY + Math.random() * (maxY - minY));
      cat.stateTimer = 150 + Math.floor(Math.random() * 150);
    } else if (r < 0.35 + lively) {
      // Walk near a player
      if (nearby.length > 0) {
        const p = nearby[Math.floor(Math.random() * nearby.length)];
        cat.state = "wander";
        setCatTarget(p.x + (Math.random() - 0.5) * 80, p.y + (Math.random() - 0.5) * 60);
        cat.stateTimer = 120;
      } else {
        enterRestState();
      }
    } else if (r < 0.55 + lively * 0.5) {
      // Go sit on furniture / window
      const spot = pickFurnitureTarget();
      if (spot) {
        cat.state = "wander";
        const tx = spot.x + Math.random() * 16;
        const ty = spot.y + Math.random() * 8;
        setCatTarget(tx, ty, spot.type === "window" ? { preferDown: true } : undefined);
        cat.onFurniture = spot.type;
        cat.stateTimer = 150;
      } else {
        enterRestState();
      }
    } else {
      enterRestState();
    }
  }
}

function enterRestState() {
  // If cat is in the narrow upper corridors of rest room, wander back to the main area first
  if (cat.room === "rest" && cat.y < 10 * TILE) {
    const dims = ROOM_DIMS.rest;
    cat.state = "wander";
    setCatTarget(80 + Math.random() * (dims.cols * TILE - 160), 10 * TILE + Math.random() * (dims.rows * TILE - 80 - 10 * TILE));
    cat.stateTimer = 300;
    return;
  }
  // Campfire warmth bonus: extra +30% sleep chance
  const nearCampfire = cat.onFurniture === "campfire";
  cat.state = pickRestState(nearCampfire);
  if (cat.state === "stare") {
    cat.stateTimer = 200 + Math.floor(Math.random() * 200);     // 10-20s
  } else if (cat.state === "yawn") {
    cat.stateTimer = 60 + Math.floor(Math.random() * 60);       // 3-6s
  } else if (cat.state === "sleep") {
    cat.stateTimer = 400 + Math.floor(Math.random() * 600);     // 20-50s minimum nap
  } else {
    cat.stateTimer = 250 + Math.floor(Math.random() * 400);     // 12.5-32.5s for sit/groom/stretch
  }
}

function pickRestState(campfireBonus) {
  const night = isNightTime();
  const morning = isMorning();
  const r = Math.random();

  // 8% stare chance (all time periods)
  if (r < 0.08) return "stare";

  // Remap remaining 92% into time-specific probabilities
  const r2 = (r - 0.08) / 0.92;
  const sleepBonus = campfireBonus ? 0.30 : 0;

  if (night) {
    // Night: mostly sleep
    const sleepCutoff = Math.min(0.66 + sleepBonus, 0.90);
    if (r2 < 0.12) return "sit";
    if (r2 < 0.12 + sleepCutoff * 0.75) return "sleep";
    if (r2 < 0.86) return "groom";
    if (r2 < 0.94) return "yawn";
    return "stretch";
  } else if (morning) {
    // Morning: more stretching, yawning
    const sleepCutoff = 0.15 + sleepBonus;
    if (r2 < 0.15) return "sit";
    if (r2 < 0.15 + sleepCutoff) return "sleep";
    if (r2 < 0.50) return "stretch";
    if (r2 < 0.65) return "yawn";
    return "groom";
  } else {
    const sleepCutoff = 0.22 + sleepBonus;
    if (r2 < 0.30) return "sit";
    if (r2 < 0.30 + sleepCutoff) return "sleep";
    if (r2 < 0.68) return "groom";
    if (r2 < 0.80) return "yawn";
    return "stretch";
  }
}

// Cat update loop
setInterval(() => {
  updateCat();
  const now = Date.now();
  if (now - lastOutdoorCheck >= 1000) {
    lastOutdoorCheck = now;
    updateOutdoorPresence(now);
  }
  io.emit("catUpdate", {
    x: Math.round(cat.x),
    y: Math.round(cat.y),
    room: cat.room,
    state: cat.state,
    gift: cat.gift,
    earPerk: cat.earPerk > 0,
    onFurniture: cat.onFurniture,
    rubTarget: cat.state === "leg_rub" ? cat.rubTarget : undefined,
    faceDir: cat.faceDir || undefined,
  });
}, 50);

// ============================================================
// SOCKET HANDLING
// ============================================================

io.on("connection", (socket) => {
  const authToken = socket.handshake.auth && socket.handshake.auth.authToken;
  const sessionToken = socket.handshake.auth && socket.handshake.auth.sessionToken;
  let isResume = false;
  let player;
  let dbUser = null;

  // Priority 1: authToken → DB user (registered or guest)
  if (authToken) {
    const tokenRow = stmtGetToken.get(authToken);
    if (tokenRow) {
      dbUser = stmtGetUserById.get(tokenRow.user_id);
    }
  }

  // No valid DB user → auto-create guest
  let newGuestToken = null;
  if (!dbUser) {
    const guestEmail = `guest:${crypto.randomUUID()}`;
    const result = stmtInsertGuestUser.run(guestEmail);
    const guestId = result.lastInsertRowid;
    newGuestToken = createAuthToken(guestId);
    dbUser = stmtGetUserById.get(guestId);
  }

  if (sessionToken && sessions[sessionToken]) {
    // --- Resume existing session ---
    const session = sessions[sessionToken];
    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = null;
    }
    const oldId = session.playerId;

    // Restore player from snapshot under new socket.id
    player = { ...session.playerSnapshot, giftPile: [...(session.playerSnapshot.giftPile || [])], languages: [...(session.playerSnapshot.languages || [])] };
    player.id = socket.id;
    player.lastMoveTime = Date.now(); // reset so gift pile doesn't dump

    // Overlay profile from DB (may have changed on another device)
    player.name = dbUser.name;
    player.character = safeJsonParse(dbUser.character, { preset: 1 });
    player.tagline = dbUser.tagline;
    player.languages = safeJsonParse(dbUser.languages, ["en"]);
    player.profession = dbUser.profession || "mystery";
    player._userId = dbUser.id;
    player._email = dbUser.email;
    player._isRegistered = !dbUser.is_guest;
    userSocketMap[dbUser.id] = socket.id;

    // Clean up old socket references
    if (oldId && oldId !== socket.id) {
      delete players[oldId];
      delete socketToSession[oldId];
      socket.broadcast.emit("playerLeft", oldId);
      // Fix cat references to old socket.id
      if (cat.curioTarget === oldId) cat.curioTarget = socket.id;
      if (cat.giftTarget === oldId) cat.giftTarget = socket.id;
    }

    session.playerId = socket.id;
    socketToSession[socket.id] = sessionToken;
    players[socket.id] = player;
    isResume = true;
    console.log(`Player resumed: ${socket.id} (session ${sessionToken.slice(0, 8)}${dbUser ? ", user=" + dbUser.email : ""})`);
  } else {
    // --- New connection ---
    const token = sessionToken || crypto.randomUUID();

    // Try to restore position from DB (survives server restarts)
    let restoredFromDB = false;
    const RESTORE_MAX_AGE = 48 * 60 * 60; // 48h in seconds
    if (dbUser.last_room && dbUser.last_x != null && dbUser.last_y != null && dbUser.last_seen != null) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec - dbUser.last_seen < RESTORE_MAX_AGE) {
        const room = dbUser.last_room;
        const x = dbUser.last_x;
        const y = dbUser.last_y;
        if (room === "focus" || room === "rest") {
          let rx = x, ry = y;
          let sitting = !!dbUser.last_sitting;
          if (!isSpawnSafe(rx, ry, room)) {
            // Position no longer walkable (map changed) — use portal spawn in same room
            const fallback = getPortalSpawn(room);
            rx = fallback.x;
            ry = fallback.y;
            sitting = false;
          }
          restoredFromDB = true;
          player = {
            id: socket.id,
            x: rx, y: ry,
            name: "Anonymous",
            status: dbUser.last_status || "wandering",
            direction: dbUser.last_direction || "down",
            room,
            isFocusing: !!dbUser.last_focusing,
            focusStartTime: dbUser.last_focus_start || null,
            focusCategory: dbUser.last_focus_category || null,
            lastMoveTime: Date.now(),
            giftPile: [],
            idlePileCount: 0,
            isSitting: sitting,
            character: { preset: 1 },
            connectedAt: Date.now(),
            tagline: "",
            languages: [],
            timezoneHour: null,
            birthMonth: null,
            profession: "mystery",
          };
          isResume = true;
          console.log(`Player restored from DB: ${socket.id} (room=${room}, x=${Math.round(rx)}, y=${Math.round(ry)}, focusing=${!!dbUser.last_focusing}, user=${dbUser.email})`);
        }
      }
    }

    if (!restoredFromDB) {
      const spawn = getInitialSpawn();
      player = {
        id: socket.id,
        x: spawn.x,
        y: spawn.y,
        name: "Anonymous",
        status: "wandering",
        direction: "down",
        room: "focus",
        isFocusing: false,
        focusStartTime: null,
        focusCategory: null,
        lastMoveTime: Date.now(),
        giftPile: [],
        idlePileCount: 0,
        isSitting: false,
        character: { preset: 1 },
        connectedAt: Date.now(),
        tagline: "",
        languages: [],
        timezoneHour: null,
        birthMonth: null,
        profession: "mystery",
      };
    }

    // Load profile from DB (all users have a DB row — guest or registered)
    player.name = dbUser.name;
    player.character = safeJsonParse(dbUser.character, { preset: 1 });
    player.tagline = dbUser.tagline;
    player.languages = safeJsonParse(dbUser.languages, ["en"]);
    player.birthMonth = dbUser.birth_month ?? null;
    player.profession = dbUser.profession || "mystery";
    player._userId = dbUser.id;
    player._email = dbUser.email;
    player._isRegistered = !dbUser.is_guest;

    // Clean up ghost player if same userId already has an active connection
    const existingSocketId = userSocketMap[dbUser.id];
    if (existingSocketId && existingSocketId !== socket.id && players[existingSocketId]) {
      delete players[existingSocketId];
      io.emit("playerLeft", existingSocketId);
      const oldToken = socketToSession[existingSocketId];
      if (oldToken && sessions[oldToken]) {
        clearTimeout(sessions[oldToken].disconnectTimer);
        delete sessions[oldToken];
      }
      delete socketToSession[existingSocketId];
    }
    userSocketMap[dbUser.id] = socket.id;

    players[socket.id] = player;
    sessions[token] = { playerId: socket.id, disconnectTimer: null, playerSnapshot: { ...player, giftPile: [], languages: [...(player.languages || [])] } };
    socketToSession[socket.id] = token;
    console.log(`Player connected: ${socket.id} (session ${token.slice(0, 8)}${dbUser ? ", user=" + dbUser.email : ""})`);
  }

  // Join the correct room
  socket.join(player.room);

  // Send state to client
  socket.emit("currentPlayers", sanitizePlayers(players));
  socket.emit("roomDimensions", ROOM_DIMS);
  socket.emit("chatHistory", chatHistory);
  socket.emit("catUpdate", {
    x: Math.round(cat.x),
    y: Math.round(cat.y),
    room: cat.room,
    state: cat.state,
    gift: cat.gift,
    earPerk: cat.earPerk > 0,
    onFurniture: cat.onFurniture,
    rubTarget: cat.state === "leg_rub" ? cat.rubTarget : undefined,
    faceDir: cat.faceDir || undefined,
  });
  socket.emit("campfireStates", campfireStates);

  // Update last_seen for activity tracking
  stmtUpdateLastSeen.run(player._userId);

  // Tell client whether this is a resume
  socket.emit("sessionRestored", {
    buildId: BUILD_ID,
    sessionToken: socketToSession[socket.id],
    resumed: isResume,
    room: player.room,
    x: player.x,
    y: player.y,
    isFocusing: player.isFocusing,
    focusStartTime: player.focusStartTime,
    focusCategory: player.focusCategory,
    giftPile: player.giftPile,
    isSitting: player.isSitting,
    status: player.status,
    isRegistered: !dbUser.is_guest,
    email: player._email || null,
    userId: player._userId,
    authToken: newGuestToken || undefined,
    focusRecords: stmtGetFocusRecords.all(player._userId).map(r => ({
      taskName: r.task_name, category: r.category, duration: r.duration,
      startTime: r.start_time, endTime: r.end_time,
    })),
  });

  if (isResume) {
    socket.broadcast.emit("playerJoined", sanitizePlayer(players[socket.id]));
  } else {
    socket.broadcast.emit("playerJoined", sanitizePlayer(players[socket.id]));
    onPlayerEnterRoom(socket.id, player.room);
  }

  // Pet the cat
  socket.on("petCat", () => {
    if (!players[socket.id]) return;
    if (players[socket.id].room !== cat.room) return;
    // Check distance
    const dx = players[socket.id].x - cat.x;
    const dy = players[socket.id].y - cat.y;
    if (Math.sqrt(dx * dx + dy * dy) < 60) {
      const wasSleeping = cat.state === "sleep";
      // Zoomies cat is unstoppable, gift_deliver cat is on a mission
      const ignoresPet = cat.state === "zoomies" || cat.state === "gift_deliver";
      // Moving cat: 40% chance to stop and sit, 60% just heart & keep going
      const isMoving = cat.state === "wander" || cat.state === "curious" || cat.state === "leg_rub";
      const keepGoing = isMoving && Math.random() < 0.6;
      io.emit("catPetted", { x: Math.round(cat.x), y: Math.round(cat.y), wasSleeping, ignoresPet });
      // Sleeping cat stays asleep; zoomies/gift cat ignores; moving cat might keep going
      if (!wasSleeping && !ignoresPet && !keepGoing) {
        cat.state = "sit";
        cat.stateTimer = 200;
        cat.targetX = cat.x;
        cat.targetY = cat.y;
        cat._path = null;
        cat._zoomiesWaypoints = null;
        cat._rubWaypoints = null;
        cat.rubTarget = null;
        // Immediately broadcast so client sees the stop
        io.emit("catUpdate", {
          x: Math.round(cat.x), y: Math.round(cat.y),
          room: cat.room, state: cat.state,
          gift: cat.gift, earPerk: cat.earPerk > 0,
          onFurniture: cat.onFurniture,
        });
      }
    }
  });

  socket.on("sendReaction", (data) => {
    if (!players[socket.id]) return;
    if (!data || typeof data !== "object") return;
    const sender = players[socket.id];
    const target = players[data.targetId];
    if (!target) return;
    if (sender.room !== target.room) return;
    if (!VALID_REACTIONS.includes(data.emoji)) return;

    // Per sender-target pair cooldown
    const key = `${socket.id}->${data.targetId}`;
    const now = Date.now();
    if (reactionCooldowns[key] && now - reactionCooldowns[key] < REACTION_COOLDOWN) return;
    reactionCooldowns[key] = now;

    const payload = {
      senderId: socket.id,
      senderName: sender.name,
      senderUserId: sender._userId || null,
      targetId: data.targetId,
      targetName: target.name,
      targetUserId: target._userId || null,
      emoji: data.emoji,
      room: sender.room,
      x: target.x,
      y: target.y,
      timestamp: now,
    };
    io.emit("emojiReaction", payload);

    // Weekly stats: count reaction received
    try { stmtIncrReactionsReceived.run(target._userId, getWeekStart()); }
    catch (e) { console.error("[WEEKLY] reaction increment error:", e.message); }
  });

  socket.on("playerMove", (data) => {
    if (!players[socket.id]) return;
    if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    const validDirs = ["up", "down", "left", "right"];
    if (!validDirs.includes(data.direction)) return;
    const p = players[socket.id];
    const dims = ROOM_DIMS[p.room];
    if (dims && (data.x < 0 || data.y < 0 || data.x > dims.cols * TILE || data.y > dims.rows * TILE)) return;
    p.x = data.x;
    p.y = data.y;
    p.direction = data.direction;
    p.lastMoveTime = Date.now();
    if (p.isSitting) p.isSitting = false;

    // Scatter gift pile on movement
    if (p.giftPile.length > 0) {
      io.to(p.room).emit("giftPileScatter", { id: socket.id, gifts: [...p.giftPile], x: p.x, y: p.y });
      p.giftPile = [];
      p.idlePileCount = 0;
    }

    socket.broadcast.emit("playerMoved", {
      id: socket.id,
      x: data.x,
      y: data.y,
      direction: data.direction,
    });

    // Throttled session snapshot (every 5s)
    const now = Date.now();
    if (!p._lastSnapshotTime || now - p._lastSnapshotTime > 5000) {
      p._lastSnapshotTime = now;
      updateSessionSnapshot(socket.id);
    }
  });

  socket.on("changeRoom", (newRoom) => {
    if (!players[socket.id]) return;
    if (newRoom !== "focus" && newRoom !== "rest") return;
    const oldRoom = players[socket.id].room;
    if (oldRoom === newRoom) return;

    socket.leave(oldRoom);
    socket.join(newRoom);

    const spawn = getPortalSpawn(newRoom);
    players[socket.id].room = newRoom;
    players[socket.id].x = spawn.x;
    players[socket.id].y = spawn.y;

    // Clear gift pile on room change (scatter in old room)
    const pl = players[socket.id];
    if (pl.giftPile.length > 0) {
      io.to(oldRoom).emit("giftPileScatter", { id: socket.id, gifts: [...pl.giftPile], x: pl.x, y: pl.y });
      pl.giftPile = [];
    }
    pl.idlePileCount = 0;
    pl.lastMoveTime = Date.now();

    // End focus and sitting on room change
    players[socket.id].isSitting = false;
    if (players[socket.id].isFocusing) {
      players[socket.id].isFocusing = false;
      players[socket.id].focusStartTime = null;
      players[socket.id].focusCategory = null;
      players[socket.id].status = "resting";
    }

    io.emit("playerChangedRoom", {
      id: socket.id,
      room: newRoom,
      x: spawn.x,
      y: spawn.y,
    });


    const oldRoomPlayers = getPlayersInRoom(oldRoom);
    if (cat.room === oldRoom && oldRoomPlayers.length === 0 && !cat.pendingRoom) {
      cat.pendingRoom = newRoom;
      cat.portalDelay = 70;
      cat.curioTarget = null;
    }
    onPlayerEnterRoom(socket.id, newRoom);
    updateSessionSnapshot(socket.id);
  });

  // Chat rate limiting state per socket
  const chatTimes = [];
  let chatMutedUntil = 0;
  const CHAT_COOLDOWN = 1500;
  const CHAT_BURST_WINDOW = 15000;
  const CHAT_BURST_MAX = 5;
  const CHAT_MUTE_DURATION = 10000;

  socket.on("chatMessage", (data) => {
    if (!players[socket.id]) return;
    if (players[socket.id].room !== "rest") return;

    // Rate limiting
    const now = Date.now();
    if (now < chatMutedUntil) return;
    if (chatTimes.length && now - chatTimes[chatTimes.length - 1] < CHAT_COOLDOWN) return;
    const recent = chatTimes.filter(t => now - t < CHAT_BURST_WINDOW);
    if (recent.length >= CHAT_BURST_MAX) { chatMutedUntil = now + CHAT_MUTE_DURATION; return; }
    chatTimes.push(now);
    if (chatTimes.length > 20) chatTimes.splice(0, chatTimes.length - 20);

    // Support both old string format and new {text, scope} format
    let text, scope;
    if (typeof data === "string") {
      text = data;
      scope = "room";
    } else if (data && typeof data.text === "string") {
      text = data.text;
      scope = data.scope === "nearby" ? "nearby" : "room";
    } else {
      return;
    }
    if (text.trim().length === 0) return;

    const sender = players[socket.id];
    const msg = {
      id: socket.id,
      userId: sender._userId || null,
      name: sender.name,
      profession: sender.profession || "mystery",
      text: sanitizeText(text.trim()).slice(0, 200),
      time: Date.now(),
      scope,
    };
    chatHistory.push(msg);
    if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();

    if (scope === "nearby") {
      // Only send to players within 128px (4 tiles) in each direction
      for (const pid in players) {
        if (players[pid].room !== "rest") continue;
        const dx = Math.abs(players[pid].x - sender.x);
        const dy = Math.abs(players[pid].y - sender.y);
        if (dx <= 128 && dy <= 128) {
          io.to(pid).emit("chatMessage", msg);
        }
      }
    } else {
      io.to("rest").emit("chatMessage", msg);
    }

    // Cat reacts to chat
    onChatMessage();
  });

  socket.on("setName", (name) => {
    if (!players[socket.id]) return;
    if (typeof name !== "string") return;
    players[socket.id].name = truncateToDisplayWidth(sanitizeText(name), 20);
    io.emit("playerUpdated", sanitizePlayer(players[socket.id]));
    updateSessionSnapshot(socket.id);
    syncProfileToDB(socket.id);
  });

  socket.on("setCharacter", (config) => {
    if (!players[socket.id]) return;
    if (typeof config === "string") return;
    if (!isValidCharConfig(config)) return;
    players[socket.id].character = config;
    io.emit("playerUpdated", sanitizePlayer(players[socket.id]));
    updateSessionSnapshot(socket.id);
    syncProfileToDB(socket.id);
  });

  socket.on("setTagline", (tagline) => {
    if (!players[socket.id]) return;
    if (typeof tagline !== "string") return;
    players[socket.id].tagline = truncateToDisplayWidth(sanitizeText(tagline), 100);
    io.emit("playerUpdated", sanitizePlayer(players[socket.id]));
    updateSessionSnapshot(socket.id);
    syncProfileToDB(socket.id);
  });

  socket.on("setLanguages", (langs) => {
    if (!players[socket.id]) return;
    if (!Array.isArray(langs)) return;
    const valid = ["en", "zh-CN", "zh-TW", "ja", "ko"];
    const filtered = langs.filter(l => valid.includes(l));
    if (filtered.length === 0) return;
    players[socket.id].languages = filtered;
    io.emit("playerUpdated", sanitizePlayer(players[socket.id]));
    updateSessionSnapshot(socket.id);
    syncProfileToDB(socket.id);
  });

  socket.on("setBirthMonth", (month) => {
    if (!players[socket.id]) return;
    if (month !== null && (typeof month !== "number" || !Number.isInteger(month) || month < 1 || month > 12)) return;
    players[socket.id].birthMonth = month;
    io.emit("playerUpdated", sanitizePlayer(players[socket.id]));
    updateSessionSnapshot(socket.id);
    syncProfileToDB(socket.id);
  });

  socket.on("setProfession", (prof) => {
    if (!players[socket.id]) return;
    if (typeof prof !== "string" || !VALID_PROFESSIONS.includes(prof)) return;
    players[socket.id].profession = prof;
    io.emit("playerUpdated", sanitizePlayer(players[socket.id]));
    updateSessionSnapshot(socket.id);
    syncProfileToDB(socket.id);
  });

  socket.on("saveFocusRecord", (record) => {
    const p = players[socket.id];
    if (!p) return;
    if (!record || typeof record !== "object") return;
    const taskName = typeof record.taskName === "string" ? sanitizeText(record.taskName).slice(0, 100) : "";
    const category = typeof record.category === "string" ? record.category.slice(0, 20) : "study";
    const duration = typeof record.duration === "number" ? Math.floor(record.duration) : 0;
    const startTime = typeof record.startTime === "number" ? Math.floor(record.startTime) : 0;
    const endTime = typeof record.endTime === "number" ? Math.floor(record.endTime) : 0;
    if (duration < 5000 || startTime <= 0 || endTime <= 0 || endTime <= startTime) return;
    stmtInsertFocusRecord.run(p._userId, taskName, category, duration, startTime, endTime);
  });

  socket.on("setTimezoneHour", (hour) => {
    if (!players[socket.id]) return;
    if (typeof hour !== "number" || !Number.isFinite(hour) || hour < 0 || hour > 23) return;
    players[socket.id].timezoneHour = Math.floor(hour);
    io.emit("playerUpdated", sanitizePlayer(players[socket.id]));
    updateSessionSnapshot(socket.id);
  });

  socket.on("toggleCampfire", (data) => {
    if (!players[socket.id]) return;
    const room = players[socket.id].room;
    const px = data && typeof data.x === "number" ? data.x : players[socket.id].x;
    const py = data && typeof data.y === "number" ? data.y : players[socket.id].y;
    let cf = (data && data.id != null) ? findCampfire(room, data.id) : null;
    if (!cf) {
      // Fallback: pick nearest campfire in room (handles id mismatches)
      let best = null;
      let bestDist = Infinity;
      for (const c of (CAMPFIRES[room] || [])) {
        const cx = c.x + (c.width || 0) / 2;
        const cy = c.y + (c.height || 0) / 2;
        const dist = Math.abs(px - cx) + Math.abs(py - cy);
        if (dist < bestDist) { bestDist = dist; best = c; }
      }
      cf = best;
    }
    if (!cf) return;
    const cx = cf.x + (cf.width || 0) / 2;
    const cy = cf.y + (cf.height || 0) / 2;
    const dist = Math.abs(px - cx) + Math.abs(py - cy);
    if (dist > CAMPFIRE_TOGGLE_DIST) return;
    const sid = String(cf.id);
    const next = !campfireStates[room][sid];
    setCampfireState(room, sid, next);
    if (next) outdoorLastSeen[room] = Date.now();
  });

  socket.on("setStatus", (status) => {
    if (!players[socket.id]) return;
    if (typeof status !== "string") return;
    const validStatuses = ["studying","working","reading","coding","resting","chatting","listening","watching","napping","snacking","browsing","wandering","daydreaming","focusing"];
    if (!validStatuses.includes(status)) return;
    players[socket.id].status = status;
    io.emit("playerUpdated", sanitizePlayer(players[socket.id]));
    updateSessionSnapshot(socket.id);
  });

  socket.on("startFocus", (data) => {
    if (!players[socket.id]) return;
    if (players[socket.id].isFocusing) return;
    if (players[socket.id].room !== "focus") return;
    if (typeof data !== "object" || !data) return;

    const validCategories = ["working", "studying", "reading", "writing", "creating", "exercising"];
    const category = validCategories.includes(data.category) ? data.category : "working";

    players[socket.id].isFocusing = true;
    players[socket.id].focusStartTime = Date.now();
    players[socket.id].focusCategory = category;
    players[socket.id].status = "focusing";

    io.emit("playerUpdated", sanitizePlayer(players[socket.id]));
    updateSessionSnapshot(socket.id);
  });

  socket.on("endFocus", () => {
    if (!players[socket.id]) return;
    if (!players[socket.id].isFocusing) return;

    players[socket.id].isFocusing = false;
    players[socket.id].focusStartTime = null;
    players[socket.id].focusCategory = null;
    players[socket.id].status = "resting";

    io.emit("playerUpdated", sanitizePlayer(players[socket.id]));
    updateSessionSnapshot(socket.id);
  });

  socket.on("playerSit", (data) => {
    if (!players[socket.id]) return;
    if (typeof data !== "object" || data === null) return;
    const p = players[socket.id];
    p.isSitting = !!data.sitting;
    if (Number.isFinite(data.x)) p.x = data.x;
    if (Number.isFinite(data.y)) p.y = data.y;
    const validDirs = ["up", "down", "left", "right"];
    if (validDirs.includes(data.direction)) p.direction = data.direction;
    if (p.isSitting) {
      const name = p.name || "player";
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      console.log(`[SIT] ${name} (${socket.id}) room=${p.room} x=${x} y=${y}`);
    }
    io.emit("playerUpdated", sanitizePlayer(p));
    updateSessionSnapshot(socket.id);
  });

  // Bulletin board
  let bulletinCooldown = 0;
  const BULLETIN_COOLDOWN_MS = 30000;
  const BULLETIN_NOTE_COLORS = ["yellow", "pink", "blue", "green", "purple"];
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  socket.on("getBulletinNotes", () => {
    if (!players[socket.id]) return;
    const now = Date.now();
    const cutoff = now - SEVEN_DAYS_MS;
    const announcements = stmtGetAnnouncements.all(now);
    const notes = stmtGetPlayerNotes.all(cutoff);
    // Attach like counts
    for (const n of notes) {
      const row = stmtLikeCount.get(n.id);
      n.like_count = row ? row.cnt : 0;
    }
    // Mark ownership and get liked note IDs
    const p = players[socket.id];
    let myLikedIds = [];
    if (p) {
      for (const n of notes) {
        n._isMine = (n.author_id === p._userId);
      }
      myLikedIds = stmtUserLikes.all(p._userId).map(r => r.note_id);
    }
    socket.emit("bulletinNotes", { announcements, notes, myLikedIds });
  });

  socket.on("addBulletinNote", (data) => {
    const p = players[socket.id];
    if (!p) return;
    if (!data || typeof data !== "object") return;
    const now = Date.now();

    // Cooldown
    if (now < bulletinCooldown) return;

    // Validate text
    let text = typeof data.text === "string" ? sanitizeText(data.text.trim()) : "";
    if (!text || text.length === 0) return;
    text = truncateToDisplayWidth(text, 100);
    if (!text) return;

    const cutoff = now - SEVEN_DAYS_MS;
    // Enforce 20-note wall capacity
    const count = stmtCountPlayerNotes.get(cutoff);
    if (count && count.cnt >= 20) {
      stmtDeleteOldestNote.run();
    }

    const color = BULLETIN_NOTE_COLORS.includes(data.color) ? data.color : BULLETIN_NOTE_COLORS[Math.floor(Math.random() * BULLETIN_NOTE_COLORS.length)];
    const prof = p.profession || "mystery";
    const result = stmtInsertNote.run("global", p.name, p._userId, text, color, 0, now, null, prof);
    bulletinCooldown = now + BULLETIN_COOLDOWN_MS;

    const note = { id: result.lastInsertRowid, room: "global", author_name: p.name, author_id: p._userId, text, color, is_announcement: 0, created_at: now, author_profession: prof };
    io.emit("bulletinNoteAdded", note);
  });

  socket.on("deleteBulletinNote", (data) => {
    const p = players[socket.id];
    if (!p) return;
    if (!data || !Number.isInteger(data.id)) return;
    // Verify ownership first, then delete likes
    const del = stmtDeleteNoteById.run(data.id, p._userId);
    if (del.changes > 0) {
      stmtDeleteNoteLikes.run(data.id);
      io.emit("bulletinNoteDeleted", { id: data.id });
    }
  });

  let lastLikeTime = 0;
  socket.on("likeBulletinNote", (data) => {
    const now = Date.now();
    if (now - lastLikeTime < 1000) return; // 1s cooldown
    lastLikeTime = now;
    const p = players[socket.id];
    if (!p) return;
    if (!data || !Number.isInteger(data.noteId)) return;
    const noteId = data.noteId;
    // Check note exists and user is not the author
    const note = stmtNoteAuthor.get(noteId);
    if (!note) return;
    // Self-like allowed
    // Toggle
    const existing = stmtLikeCheck.get(noteId, p._userId);
    if (existing) {
      stmtLikeDelete.run(noteId, p._userId);
    } else {
      stmtLikeInsert.run(noteId, p._userId);
    }
    const countRow = stmtLikeCount.get(noteId);
    const likeCount = countRow ? countRow.cnt : 0;
    io.emit("bulletinNoteLikeUpdated", { noteId, likeCount });
  });

  // Tab close: client signals intentional close → skip grace period
  let intentionalClose = false;
  socket.on("intentionalClose", () => { intentionalClose = true; });

  socket.on("disconnect", () => {
    const token = socketToSession[socket.id];
    console.log(`Player disconnected: ${socket.id} (session ${token ? token.slice(0, 8) : "none"}, intentional=${intentionalClose})`);

    // Clean up reaction cooldowns
    for (const key of Object.keys(reactionCooldowns)) {
      if (key.startsWith(socket.id + "->") || key.endsWith("->" + socket.id)) {
        delete reactionCooldowns[key];
      }
    }

    // Clean up userSocketMap + persist state to DB
    const p = players[socket.id];
    if (p && p._userId) {
      if (userSocketMap[p._userId] === socket.id) delete userSocketMap[p._userId];
      savePlayerState(p);
    }

    // Never-completed-welcome players (still "Anonymous") get no grace period
    const isGhost = p && p.name === "Anonymous" && p.timezoneHour == null;

    if (intentionalClose || isGhost) {
      // Tab closed or ghost — immediate removal, no grace period
      delete players[socket.id];
      io.emit("playerLeft", socket.id);
      if (token) { delete sessions[token]; delete socketToSession[socket.id]; }
    } else if (token && sessions[token] && players[socket.id]) {
      // Tab switched / hibernated — snapshot and start grace period
      sessions[token].playerSnapshot = { ...players[socket.id], giftPile: [...players[socket.id].giftPile] };
      sessions[token].disconnectTimer = setTimeout(() => {
        // Grace period expired — truly remove
        console.log(`Session expired: ${token.slice(0, 8)}`);
        const sid = sessions[token].playerId;
        if (sid && players[sid]) {
          delete players[sid];
          io.emit("playerLeft", sid);
        }
        delete socketToSession[socket.id];
        delete sessions[token];
      }, GRACE_PERIOD_MS);
      // Do NOT emit playerLeft yet — other players see a frozen avatar
    } else {
      // No session — immediate cleanup
      delete players[socket.id];
      io.emit("playerLeft", socket.id);
      if (token) { delete sessions[token]; delete socketToSession[socket.id]; }
    }
  });
});

// Periodic session cleanup (safety net) + expired auth token cleanup
setInterval(() => {
  for (const [token, session] of Object.entries(sessions)) {
    if (!session.disconnectTimer && !players[session.playerId]) {
      delete sessions[token];
    }
  }
  // Clean expired auth tokens every hour (runs every 5min, but cheap no-op if nothing expired)
  stmtDeleteExpiredTokens.run();
}, 5 * 60 * 1000);

// Bulletin board: clean expired notes every hour + guest cleanup
setInterval(() => {
  const now = Date.now();
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  stmtCleanExpiredNotes.run(cutoff, now);
  // Remove guest users inactive for 30+ days (CASCADE deletes related data)
  stmtCleanupGuests.run();
}, 60 * 60 * 1000);

// Weekly stats: record online time and copresence every 60 seconds
const weeklyStatsCollect = db.transaction((weekStart, onlineUserIds, roomGroups) => {
  for (const uid of onlineUserIds) {
    stmtUpsertOnlineSecs.run(uid, weekStart);
  }
  for (const uids of Object.values(roomGroups)) {
    for (let i = 0; i < uids.length; i++) {
      for (let j = i + 1; j < uids.length; j++) {
        const a = Math.min(uids[i], uids[j]);
        const b = Math.max(uids[i], uids[j]);
        stmtUpsertCopresence.run(a, b, weekStart);
      }
    }
  }
});

setInterval(() => {
  const weekStart = getWeekStart();
  const seen = new Set();
  const onlineUserIds = [];
  const roomGroups = {};

  for (const p of Object.values(players)) {
    if (seen.has(p._userId)) continue;
    seen.add(p._userId);
    onlineUserIds.push(p._userId);
    if (!roomGroups[p.room]) roomGroups[p.room] = [];
    roomGroups[p.room].push(p._userId);
  }

  if (onlineUserIds.length > 0) {
    try { weeklyStatsCollect(weekStart, onlineUserIds, roomGroups); }
    catch (e) { console.error("[WEEKLY] stats collect error:", e.message); }
  }

  // Flush player runtime state to DB every 60s
  if (Object.keys(players).length > 0) {
    try { saveAllPlayerStates(); }
    catch (e) { console.error("[STATE] periodic save error:", e.message); }
  }
}, 60 * 1000);

const serverStartTime = Date.now();

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

app.get("/admin/stats", (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.key !== secret) return res.status(403).json({ error: "Forbidden" });
  const now = Date.now();
  const list = Object.values(players).map(p => ({
    name: p.name,
    room: p.room,
    status: p.status,
    isFocusing: p.isFocusing,
    focusCategory: p.focusCategory || null,
    focusDuration: p.focusStartTime ? formatDuration(now - p.focusStartTime) : null,
    giftPile: p.giftPile.length,
    online: formatDuration(now - p.connectedAt),
    idle: formatDuration(now - p.lastMoveTime),
  }));

  const focusCount = list.filter(p => p.room === "focus").length;
  const loungeCount = list.filter(p => p.room === "rest").length;

  res.json({
    uptime: formatDuration(now - serverStartTime),
    online: list.length,
    rooms: { focus: focusCount, lounge: loungeCount },
    cat: { room: cat.room === "rest" ? "lounge" : cat.room, state: cat.state,
           x: Math.round(cat.x), y: Math.round(cat.y),
           tx: Math.round(cat.targetX), ty: Math.round(cat.targetY),
           tile: `${Math.floor(cat.x/TILE)},${Math.floor(cat.y/TILE)}`,
           stuck: cat._stuckCount || 0, pathLen: cat._path ? cat._path.length : 0,
           antiStuck: cat._antiStuckTick || 0 },
    players: list,
  });
});

// Config endpoint for client-side env-aware parameters
app.get('/api/config', (req, res) => {
  res.json({
    env: APP_ENV,
    auraStageMs: IS_PROD ? 1800000 : 10000, // prod: 30min, staging: 10s
  });
});

app.get('/api/cat', (req, res) => {
  res.json({
    x: Math.round(cat.x), y: Math.round(cat.y),
    targetX: Math.round(cat.targetX), targetY: Math.round(cat.targetY),
    room: cat.room, state: cat.state, timer: cat.stateTimer,
    furniture: cat.onFurniture, gift: cat.gift,
    hasPath: !!cat._path, pathLen: cat._path ? cat._path.length : 0,
    stuck: cat._stuckCount || 0, antiStuck: cat._antiStuckTick || 0,
  });
});

app.get('/api/status', (req, res) => {
  const all = Object.values(players);
  res.json({
    online: all.length,
    focus: all.filter(p => p.room === 'focus').length,
    lounge: all.filter(p => p.room === 'rest').length,
    cat: { x: Math.round(cat.x), y: Math.round(cat.y), room: cat.room, state: cat.state },
  });
});

app.get('/api/last-seen/:userId', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!userId || !Number.isFinite(userId)) return res.status(400).json({ error: "invalid" });
  // Check if currently online
  if (userSocketMap[userId]) return res.json({ online: true });
  const row = stmtGetUserById.get(userId);
  if (!row || !row.last_seen) return res.json({ online: false, lastSeen: null });
  res.json({ online: false, lastSeen: row.last_seen * 1000 }); // convert to ms
});

// Vite middleware (dev) or static files (production)
const isDev = !fs.existsSync(distPath);

(async () => {
  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server } },
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.use(express.static(path.join(__dirname, 'public')));
    app.get('/{*splat}', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT} [${APP_ENV}] (${isDev ? 'dev' : 'built'})`);
  });
})();

// Graceful shutdown — flush all player states before exit
function gracefulShutdown(signal) {
  const count = Object.keys(players).length;
  if (count > 0) {
    try { saveAllPlayerStates(); }
    catch (e) { console.error("[SHUTDOWN] save error:", e.message); }
  }
  console.log(`[SHUTDOWN] Saved ${count} player states (${signal})`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Force exit after 5s if server.close hangs
  setTimeout(() => { db.close(); process.exit(1); }, 5000);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
