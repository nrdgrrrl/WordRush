const RANDOM_RUSH_DELAY = Number(process.env.RANDOM_RUSH_DELAY || 20000);
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  QRCode = require("qrcode"),
  { WebSocketServer } = require("ws");
const {
  MODE_CONFIG,
  COMMON_WORDS,
  createLexicon,
  generateBoard,
  isDictionaryWord,
  validateSubmission,
  normalizeWords,
} = require("./game-core");
const PORT = Number(process.env.PORT || 8000),
  HOST = process.env.HOST || "127.0.0.1",
  MAX_PLAYERS = 10,
  rooms = new Map(),
  clients = new Map(),
  displays = new Map();
const IS_LOOPBACK = ["127.0.0.1", "::1", "localhost"].includes(HOST);
const LAN_MODE = process.env.WORDRUSH_LAN_MODE === "1";
const PASSWORD_HASH = process.env.WORDRUSH_BETA_PASSWORD_HASH || "";
const AUTH_REQUIRED = Boolean(PASSWORD_HASH) && !LAN_MODE;
const SESSION_TTL_MS = Number(process.env.WORDRUSH_SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const SESSION_FILE = process.env.WORDRUSH_SESSION_FILE || "";
const DISPLAY_TOKEN_TTL_MS = Number(
  process.env.WORDRUSH_DISPLAY_TOKEN_TTL_MS || 5 * 60 * 1000,
);
const MAX_HTTP_BODY = 10_000;
const MAX_WS_CONNECTIONS_PER_IP = Number(process.env.WORDRUSH_MAX_WS_PER_IP || 60);
const MAX_WS_MESSAGES_PER_WINDOW = Number(
  process.env.WORDRUSH_MAX_WS_MESSAGES_PER_WINDOW || 60,
);
const RATE_WINDOW_MS = 60_000;
const sessions = new Map();
const displayTokens = new Map();
const rateLimits = new Map();
const configuredOrigins = (process.env.WORDRUSH_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const configuredHosts = (process.env.WORDRUSH_ALLOWED_HOSTS || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

function persistSessions() {
  if (!SESSION_FILE) return;
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
    const now = Date.now();
    const entries = [...sessions.entries()]
      .filter(([, session]) => session.expiresAt > now)
      .map(([token, session]) => [token, { expiresAt: session.expiresAt }]);
    const temporary = SESSION_FILE + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(temporary, SESSION_FILE);
  } catch (error) {
    console.error("Could not persist beta sessions", error.message);
  }
}
function loadSessions() {
  if (!SESSION_FILE) return;
  try {
    const entries = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    const now = Date.now();
    for (const [token, session] of Array.isArray(entries) ? entries : [])
      if (/^[A-Za-z0-9_-]{32,}$/.test(token) && Number(session?.expiresAt) > now)
        sessions.set(token, { expiresAt: Number(session.expiresAt) });
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load beta sessions", error.message);
  }
}
loadSessions();

if (!IS_LOOPBACK && !LAN_MODE && !PASSWORD_HASH)
  throw new Error(
    "WORDRUSH_BETA_PASSWORD_HASH is required when binding Wordrush beyond loopback",
  );
if (process.env.NODE_ENV === "production" && !LAN_MODE && !PASSWORD_HASH)
  throw new Error("WORDRUSH_BETA_PASSWORD_HASH is required in production");
if (process.env.NODE_ENV === "production" && !LAN_MODE && !configuredOrigins.length)
  throw new Error("WORDRUSH_ALLOWED_ORIGINS is required in production");
if (
  process.env.NODE_ENV === "production" &&
  !LAN_MODE &&
  !["/usr/share/dict/american-english", "/usr/share/dict/words"].some(fs.existsSync)
)
  throw new Error(
    "A system word list is required in production (install wamerican)",
  );

function clientIp(req) {
  // Apache is trusted only when Node is bound to loopback. Configure it to pass
  // X-Forwarded-For; the first value is the original client.
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .split(",")[0]
    .trim();
}
function rateLimit(key, limit, window = RATE_WINDOW_MS) {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.expiresAt <= now) {
    rateLimits.set(key, { count: 1, expiresAt: now + window });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}
function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split(/=(.*)/s, 2))
      .filter(([name]) => name)
      .map(([name, value]) => [name, decodeURIComponent(value || "")]),
  );
}
function sessionFor(req) {
  const token = parseCookies(req).wordrush_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) { sessions.delete(token); persistSessions(); }
    return null;
  }
  return session;
}
function setSessionCookie(res, token, expiresAt) {
  const secure = process.env.WORDRUSH_SESSION_COOKIE_SECURE !== "0" &&
    (process.env.NODE_ENV === "production" || process.env.WORDRUSH_SESSION_COOKIE_SECURE === "1");
  res.setHeader(
    "Set-Cookie",
    `wordrush_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}${secure ? "; Secure" : ""}`,
  );
}
function passwordMatches(password) {
  // Format: scrypt$N$r$p$base64-salt$base64-derived-key
  const parts = PASSWORD_HASH.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  try {
    const [_, N, r, p, salt, expected] = parts;
    const derived = crypto.scryptSync(String(password), Buffer.from(salt, "base64"), Buffer.from(expected, "base64").length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    const expectedBuffer = Buffer.from(expected, "base64");
    return derived.length === expectedBuffer.length && crypto.timingSafeEqual(derived, expectedBuffer);
  } catch {
    return false;
  }
}
function allowedHost(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!host) return false;
  if (configuredHosts.length) return configuredHosts.includes(host);
  return IS_LOOPBACK || LAN_MODE || host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}`;
}
function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return IS_LOOPBACK || LAN_MODE;
  if (configuredOrigins.length) return configuredOrigins.includes(origin);
  return IS_LOOPBACK || LAN_MODE;
}
function deny(res, status, code) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: code }));
}
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' https://www.gstatic.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
function safeReturnPath(value) {
  const candidate = String(value || "");
  return candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/";
}
function loginPage(res, returnPath = "/") {
  const loginAction = "/auth/login" +
    (returnPath === "/" ? "" : "?return=" + encodeURIComponent(returnPath));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Wordrush beta</title>
  <style>
    body{font:16px system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#15131c;color:#fff}
    main{width:min(26rem,90vw)}
    label{display:block;margin:.7rem 0}
    input,button{box-sizing:border-box;width:100%;padding:.8rem;margin:.4rem 0;font:inherit}
    input[readonly]{color:#bbb;background:#27232f;border:1px solid #51485f}
    button{cursor:pointer}
  </style>
</head>
<body>
  <main>
    <h1>Wordrush private beta</h1>
    <p>Enter your beta password to play.</p>
    <form method="post" action="${loginAction}" autocomplete="on">
      <label for="username">Account</label>
        <input id="username" name="username" type="text" value="Wordrush beta" autocomplete="username" readonly>
      <label for="current-password">Password</label>
        <input id="current-password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`);
}
function readForm(req) {
  return new Promise((resolve) => {
    let body = "";
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_HTTP_BODY) {
        done = true;
        resolve(null);
      }
    });
    req.on("end", () => {
      if (done) return;
      resolve(new URLSearchParams(body));
    });
    req.on("error", () => resolve(null));
  });
}
async function authorizeRequest(req, res) {
  securityHeaders(res);
  if (!allowedHost(req)) {
    deny(res, 421, "HOST_NOT_ALLOWED");
    return false;
  }
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const requestUrl = new URL(req.url || "/", "http://localhost");
  if (pathname === "/qr.svg" && req.method === "GET") {
    const join = String(requestUrl.searchParams.get("join") || "").trim().toUpperCase();
    if (!/^[A-Z]{5}$/.test(join)) return deny(res, 400, "INVALID_ROOM_CODE");
    const origin = (req.headers["x-forwarded-proto"] || "https") + "://" + req.headers.host;
    const payload = `${origin}/?join=${join}`;
    const svg = await QRCode.toString(payload, {
      type: "svg", width: 512, margin: 1,
      color: { dark: "#14111d", light: "#fff9f0" },
    });
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=300" });
    res.end(svg);
    return false;
  }
  if (pathname === "/receiver" || pathname.startsWith("/receiver/")) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self' https://www.gstatic.com; base-uri 'none'; frame-ancestors 'none'",
    );
    return true;
  }
  if (!AUTH_REQUIRED) return true;
  if (pathname === "/auth/login" && req.method === "GET") {
    loginPage(res, safeReturnPath(requestUrl.searchParams.get("return")));
    return false;
  }
  if (pathname === "/auth/login" && req.method === "POST") {
    if (!allowedOrigin(req) || !rateLimit(`login:${clientIp(req)}`, 8)) {
      deny(res, 429, "LOGIN_RATE_LIMITED");
      return false;
    }
    const form = await readForm(req);
    if (!form || !passwordMatches(form.get("password") || "")) {
      deny(res, 401, "INVALID_LOGIN");
      return false;
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(token, { expiresAt });
    persistSessions();
    setSessionCookie(res, token, expiresAt);
    res.writeHead(303, {
      Location: safeReturnPath(requestUrl.searchParams.get("return")),
      "Cache-Control": "no-store",
    });
    res.end();
    return false;
  }
  if (pathname === "/auth/logout" && req.method === "POST") {
    if (!allowedOrigin(req)) {
      deny(res, 403, "ORIGIN_NOT_ALLOWED");
      return false;
    }
    const token = parseCookies(req).wordrush_session;
    if (token) sessions.delete(token);
    persistSessions();
    res.setHeader("Set-Cookie", "wordrush_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return false;
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !allowedOrigin(req)) {
    deny(res, 403, "ORIGIN_NOT_ALLOWED");
    return false;
  }
  if (!sessionFor(req)) {
    if (pathname.startsWith("/api/")) deny(res, 401, "AUTH_REQUIRED");
    else {
      const returnPath = req.url && req.url !== "/" ? `?return=${encodeURIComponent(req.url)}` : "";
      res.writeHead(303, { Location: "/auth/login" + returnPath, "Cache-Control": "no-store" });
      res.end();
    }
    return false;
  }
  return true;
}
function code() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let value;
  do
    value = Array.from(
      { length: 5 },
      () => alphabet[crypto.randomInt(alphabet.length)],
    ).join("");
  while (rooms.has(value));
  return value;
}
function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}
function cleanText(value, fallback, max = 20) {
  const cleaned = String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return Array.from(cleaned || fallback)
    .slice(0, max)
    .join("");
}
function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}
function requestedConfig(mode, raw) {
  if (mode !== "custom") return MODE_CONFIG[mode] || MODE_CONFIG.classic;
  return {
    label: cleanText(raw?.label, "CUSTOM", 32),
    min: boundedNumber(raw?.min, 3, 3, 12),
    size: boundedNumber(raw?.size, 4, 4, 8),
    seconds: boundedNumber(raw?.seconds, 120, 15, 600),
    rule: cleanText(raw?.rule, "Custom multiplayer round", 100),
    target: raw?.target ? boundedNumber(raw.target, 500, 1, 100000) : null,
    adult: Boolean(raw?.adult),
    sudden: Boolean(raw?.sudden),
  };
}
function roomConfig(room) {
  return (
    room.round?.config ||
    room.config ||
    MODE_CONFIG[room.mode] ||
    MODE_CONFIG.classic
  );
}
function state(room) {
  return {
    type: "room_state",
    code: room.code,
    creatorId: room.creatorId,
    randomRush: room.randomRush,
    mode: room.mode,
    status: room.status,
    results: room.results,
    config: roomConfig(room),
    lastResult: room.status === "finished" ? room.lastResult : null,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar || "🐈",
      score: p.score,
    })),
    round: room.round
      ? {
          board: room.round.board,
          size: room.round.size,
          endsAt: room.round.endsAt,
        }
      : null,
  };
}
function displayState(room) {
  return {
    code: room.code,
    mode: room.mode,
    status: room.status,
    results: room.results,
    config: roomConfig(room),
    lastResult: room.status === "finished" ? room.lastResult : null,
    players: [...room.players.values()].map((p) => ({
      name: p.name,
      avatar: p.avatar || "🐈",
      score: p.score,
    })),
    round: room.round
      ? {
          board: room.round.board,
          size: room.round.size,
          endsAt: room.round.endsAt,
        }
      : null,
  };
}
function displayUpdate(room, event) {
  return { type: "display_state", event, state: displayState(room) };
}
function broadcast(room, message) {
  for (const player of room.players.values()) send(player.ws, message);
  for (const ws of room.displays) send(ws, displayUpdate(room, message.type));
}
function clearRoomTimer(room) {
  clearTimeout(room.round?.timer);
  clearTimeout(room.rushTimer);
}
function closeRoom(room, reason) {
  clearRoomTimer(room);
  rooms.delete(room.code);
  for (const member of room.players.values()) {
    const memberClient = clients.get(member.ws);
    if (memberClient) memberClient.roomCode = null;
    send(member.ws, { type: "session_closed", code: room.code, reason });
  }
  for (const ws of room.displays) {
    displays.delete(ws);
    send(ws, { type: "session_closed", code: room.code, reason });
    ws.close(1000, "room closed");
  }
  room.displays.clear();
  room.players.clear();
  room.round = null;
  room.status = "closed";
}
const RANDOM_MODES = ["classic", "minimum", "sudden", "race", "coop", "dirty"];
function shuffledModes(previous) {
  const modes = RANDOM_MODES.filter((mode) => mode !== previous);
  for (let index = modes.length - 1; index > 0; index--) {
    const swap = crypto.randomInt(index + 1);
    [modes[index], modes[swap]] = [modes[swap], modes[index]];
  }
  if (RANDOM_MODES.includes(previous)) modes.push(previous);
  return modes;
}
function randomMode(room) {
  if (!room.randomModeQueue.length)
    room.randomModeQueue = shuffledModes(room.mode);
  return room.randomModeQueue.shift();
}
function startRound(room, selected = room.mode, rawConfig = null) {
  clearRoomTimer(room);
  room.mode =
    selected === "custom" || MODE_CONFIG[selected] ? selected : "classic";
  const config = requestedConfig(room.mode, rawConfig),
    validationMode = config.adult ? "dirty" : room.mode,
    board = generateBoard(
      config.size,
      createLexicon(validationMode, [...room.customWords]),
      // Keep multiplayer boards discoverable from the shared browser vocabulary
      // even when a server happens to have a larger system dictionary installed.
      { preferredWords: COMMON_WORDS },
    );
  room.config = config;
  room.round = {
    board: board,
    size: config.size,
    found: new Set(),
    endsAt: Date.now() + config.seconds * 1000,
    timer: null,
    config,
    validationMode,
  };
  room.status = "playing";
  room.teamScore = 0;
  room.results = { view: "static", speed: "medium" };
  room.lastResult = null;
  for (const player of room.players.values()) {
    player.score = 0;
    player.words = [];
    player.found = new Set();
  }
  room.round.timer = setTimeout(
    () => finishRound(room, "timeout"),
    config.seconds * 1000,
  );
  room.round.timer.unref?.();
  broadcast(room, { ...state(room), type: "round_started", config });
}
function finishRound(room, reason = "complete") {
  if (!room.round || room.status !== "playing") return;
  clearTimeout(room.round.timer);
  room.status = "finished";
  const result = {
    cooperative: room.mode === "coop",
    teamScore: room.teamScore,
    stats: { wordsFound: room.round.found.size },
    results: room.results,
    reason,
    ranking: [...room.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar || "🐈",
        score: p.score,
        words: p.words || [],
      })),
  };
  room.lastResult = result;
  const gameSeconds = Math.min(
    roomConfig(room).seconds,
    Math.max(
      0,
      (Date.now() - (room.round.endsAt - roomConfig(room).seconds * 1000)) /
        1000,
    ),
  );
  try {
    leaderboard.recordScores(
      result.ranking.map((rankedPlayer, index) => {
        const words = rankedPlayer.words || [];
        return {
          id: rankedPlayer.id,
          name: rankedPlayer.name,
          avatar: rankedPlayer.avatar,
          score: rankedPlayer.score,
          words: words.length,
          correct: words.length,
          longest: Math.max(0, ...words.map((item) => item.word.length)),
          totalWordLength: words.reduce(
            (sum, item) => sum + item.word.length,
            0,
          ),
          gameSeconds,
          multiplayer: true,
          multiplayerWin: result.cooperative || index === 0,
        };
      }),
    );
  } catch {
    // A leaderboard write must never prevent the round result broadcast.
  }
  broadcast(room, { type: "round_finished", ...result });
  if (room.randomRush) {
    room.rushTimer = setTimeout(() => {
      if (room.randomRush && room.status === "finished")
        startRound(room, randomMode(room));
    }, RANDOM_RUSH_DELAY);
    room.rushTimer.unref?.();
  }
}
function issueDisplayToken(room, client) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + DISPLAY_TOKEN_TTL_MS;
  displayTokens.set(token, {
    roomCode: room.code,
    issuedBy: client.id,
    expiresAt,
  });
  return { token, expiresAt };
}
function consumeDisplayToken(value) {
  const token = typeof value === "string" ? value : "";
  const record = displayTokens.get(token);
  if (!record) return null;
  // Tokens are single-use even if they have expired or their room disappeared.
  displayTokens.delete(token);
  if (record.expiresAt <= Date.now()) return null;
  const room = rooms.get(record.roomCode);
  if (!room || room.status === "closed") return null;
  return room;
}
function leaveDisplay(ws) {
  const display = displays.get(ws);
  if (!display) return;
  displays.delete(ws);
  const room = rooms.get(display.roomCode);
  room?.displays.delete(ws);
}
function leave(ws) {
  const info = clients.get(ws);
  if (!info) return leaveDisplay(ws);
  clients.delete(ws);
  const room = rooms.get(info.roomCode);
  if (!room) return;
  if (info.id === room.creatorId) {
    return closeRoom(room, "creator_disconnected");
  }
  room.players.delete(info.id);
  if (!room.players.size) return rooms.delete(room.code);
  broadcast(room, state(room));
}
function handle(ws, message) {
  const type = message?.type;
  if (ws.connectionRole === "display") {
    if (type !== "display_hello")
      return send(ws, { type: "error", code: "DISPLAY_READ_ONLY" });
    if (displays.has(ws))
      return send(ws, { type: "error", code: "DISPLAY_ALREADY_AUTHENTICATED" });
    const room = consumeDisplayToken(message.token);
    if (!room) return send(ws, { type: "error", code: "INVALID_DISPLAY_TOKEN" });
    displays.set(ws, { roomCode: room.code });
    room.displays.add(ws);
    return send(ws, displayUpdate(room, "display_connected"));
  }
  if (type === "hello") {
    const id = String(message.guestId || crypto.randomUUID());
    clients.set(ws, {
      id,
      name: cleanText(message.name, "Guest"),
      avatar: cleanText(message.avatar, "🐈", 2),
      roomCode: null,
    });
    return send(ws, { type: "hello_ack", id });
  }
  const client = clients.get(ws);
  if (!client) return send(ws, { type: "error", code: "HELLO_REQUIRED" });
  if (type === "create_room") {
    if (client.roomCode && rooms.has(client.roomCode))
      return send(ws, { type: "error", code: "ALREADY_IN_ROOM" });
    const room = {
      code: code(),
      mode: "classic",
      creatorId: null,
      randomRush: false,
      randomModeQueue: [],
      teamScore: 0,
      customWords: new Set(normalizeWords(message.customWords)),
      players: new Map(),
      displays: new Set(),
      status: "lobby",
      round: null,
      config: MODE_CONFIG.classic,
      results: { view: "static", speed: "medium" },
      lastResult: null,
      rushTimer: null,
    };
    rooms.set(room.code, room);
    client.roomCode = room.code;
    room.creatorId = client.id;
    client.name = cleanText(message.name, client.name);
    client.avatar = cleanText(message.avatar, client.avatar || "🐈", 2);
    room.players.set(client.id, {
      ...client,
      ws,
      score: room.mode === "coop" ? room.teamScore : 0,
      words: [],
      found: new Set(),
    });
    send(ws, { type: "room_created", code: room.code });
    broadcast(room, state(room));
    return;
  }
  if (type === "join_room") {
    if (client.roomCode && rooms.has(client.roomCode))
      return send(ws, { type: "error", code: "ALREADY_IN_ROOM" });
    const room = rooms.get(String(message.code || "").toUpperCase());
    if (!room) return send(ws, { type: "error", code: "ROOM_NOT_FOUND" });
    if (room.players.size >= MAX_PLAYERS)
      return send(ws, { type: "error", code: "ROOM_FULL" });
    if (room.players.has(client.id))
      return send(ws, { type: "error", code: "ALREADY_JOINED" });
    client.roomCode = room.code;
    client.name = cleanText(message.name, client.name);
    client.avatar = cleanText(message.avatar, client.avatar || "🐈", 2);
    room.players.set(client.id, {
      ...client,
      ws,
      score: room.mode === "coop" ? room.teamScore : 0,
      words: [],
      found: new Set(),
    });
    send(ws, { type: "joined_room", code: room.code });
    broadcast(room, state(room));
    return;
  }
  const room = rooms.get(client.roomCode);
  if (!room) return send(ws, { type: "error", code: "NOT_IN_ROOM" });
  if (type === "create_display_token") {
    const displayToken = issueDisplayToken(room, client);
    return send(ws, { type: "display_token", ...displayToken });
  }
  if (type === "update_identity") {
    client.name = cleanText(message.name, client.name);
    client.avatar = cleanText(message.avatar, client.avatar || "🐈", 2);
    const identityRoom = rooms.get(client.roomCode);
    if (identityRoom && identityRoom.players.has(client.id)) {
      const player = identityRoom.players.get(client.id);
      player.name = client.name;
      player.avatar = client.avatar;
      broadcast(identityRoom, state(identityRoom));
    }
    return;
  }
  if (type === "leave_session") {
    const leavingRoom = rooms.get(client.roomCode);
    if (!leavingRoom) return send(ws, { type: "error", code: "NOT_IN_ROOM" });
    if (client.id === leavingRoom.creatorId) {
      closeRoom(leavingRoom, "creator_left");
    } else {
      leavingRoom.players.delete(client.id);
      client.roomCode = null;
      send(ws, { type: "session_left" });
      broadcast(leavingRoom, state(leavingRoom));
    }
    return;
  }
  if (type === "start_game") {
    if (client.id !== room.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
    if (room.status === "playing")
      return send(ws, { type: "error", code: "ROUND_PLAYING" });
    const requested = String(message.mode || "classic");
    if (requested === "random") {
      room.randomRush = true;
      room.randomModeQueue = [];
      return startRound(room, randomMode(room));
    }
    room.randomRush = false;
    room.randomModeQueue = [];
    return startRound(
      room,
      requested === "custom" || MODE_CONFIG[requested] ? requested : "classic",
      message.config,
    );
  }
  if (type === "set_results_settings") {
    if (room.status !== "finished")
      return send(ws, { type: "error", code: "RESULTS_NOT_READY" });
    const view = message.view === "reveal" ? "reveal" : "static";
    const speed = ["slow", "medium", "fast"].includes(message.speed)
      ? message.speed
      : room.results.speed;
    room.results = { view, speed };
    if (room.lastResult) room.lastResult.results = room.results;
    return broadcast(room, { type: "results_settings", results: room.results });
  }
  if (type === "submit_word") {
    if (room.status !== "playing" || !room.round)
      return send(ws, { type: "error", code: "ROUND_NOT_PLAYING" });
    if (Date.now() >= room.round.endsAt) return finishRound(room, "timeout");
    const player = room.players.get(client.id);
    const result = validateSubmission({
      ...message,
      board: room.round.board,
      size: room.round.size,
      mode: room.round.validationMode,
      minimum: roomConfig(room).min,
      found: room.mode === "coop" ? room.round.found : player.found,
      customWords: [...room.customWords],
    });
    if (!result.valid) {
      console.warn("Wordrush rejected submission", JSON.stringify({
        word: result.word,
        reason: result.reason,
        validationMode: room.round.validationMode,
        minimum: roomConfig(room).min,
      }));
      send(ws, {
        type: "word_rejected",
        playerId: client.id,
        word: result.word,
        reason: result.reason,
        minimum: roomConfig(room).min,
      });
      if (
        (room.mode === "sudden" || roomConfig(room).sudden) &&
        result.reason !== "duplicate"
      )
        finishRound(room, "invalid_word");
      return;
    }
    room.round.found.add(result.word);
    player.found.add(result.word);
    if (room.mode === "coop") {
      room.teamScore += result.points;
      for (const teammate of room.players.values())
        teammate.score = room.teamScore;
    } else player.score += result.points;
    player.words = player.words || [];
    player.words.push({ word: result.word, points: result.points });
    broadcast(room, {
      type: "word_accepted",
      playerId: client.id,
      word: result.word,
      points: result.points,
      scores: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar || "🐈",
        score: p.score,
      })),
    });
    if (
      (room.mode === "race" && player.score >= 500) ||
      (roomConfig(room).target && player.score >= roomConfig(room).target)
    )
      finishRound(room, "race");
    return;
  }
  if (type === "end_round") {
    if (client.id !== room.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
    finishRound(room, "manual");
  }
}
const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(req.url || "/", "http://localhost").pathname,
    );
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Bad request");
  }
  if (pathname === "/dictionary.json") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    });
    return res.end(JSON.stringify(createLexicon("classic")));
  }
  let requested = pathname;
  if (requested === "/") requested = "/index.html";
  if (requested === "/receiver" || requested === "/receiver/")
    requested = "/receiver/index.html";
  const root = path.resolve(__dirname);
  const file = path.resolve(root, "." + requested);
  if (
    !file.startsWith(root + path.sep) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const ext = path.extname(file),
    types = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
  res.writeHead(200, {
    "Content-Type":
      (types[ext] || "application/octet-stream") +
      (types[ext]?.startsWith("text/") ? "; charset=utf-8" : ""),
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 });
wss.on("connection", (ws, req) => {
  ws.connectionRole =
    new URL(req.url || "/", "http://localhost").pathname === "/display"
      ? "display"
      : "player";
  ws.isAlive = true;
  ws.messageWindow = { startedAt: Date.now(), count: 0 };
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - ws.messageWindow.startedAt >= RATE_WINDOW_MS)
      ws.messageWindow = { startedAt: now, count: 0 };
    ws.messageWindow.count += 1;
    if (ws.messageWindow.count > MAX_WS_MESSAGES_PER_WINDOW)
      return ws.close(1008, "message rate limit exceeded");
    try {
      handle(ws, JSON.parse(raw));
    } catch {
      send(ws, { type: "error", code: "BAD_MESSAGE" });
    }
  });
  ws.on("close", () => leave(ws));
});
server.on("upgrade", (req, socket, head) => {
  if (!allowedHost(req) || !allowedOrigin(req)) return socket.destroy();
  const ip = clientIp(req);
  if (!rateLimit(`ws:${ip}`, MAX_WS_CONNECTIONS_PER_IP)) return socket.destroy();
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (AUTH_REQUIRED && pathname !== "/display" && !sessionFor(req))
    return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const [token, display] of displayTokens)
    if (display.expiresAt <= now) displayTokens.delete(token);
  let expiredSession = false;
  for (const [token, session] of sessions)
    if (session.expiresAt <= now) { sessions.delete(token); expiredSession = true; }
  if (expiredSession) persistSessions();
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 15000);
heartbeat.unref?.();
if (require.main === module)
  server.listen(PORT, HOST, () =>
    console.log("Wordrush listening on http://" + HOST + ":" + PORT),
  );
module.exports = { server, rooms, handle, MAX_PLAYERS, displayTokens };

const { Leaderboard } = require("./leaderboard");
const leaderboard = new Leaderboard();
function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      body += chunk;
      if (body.length > 10000) {
        done = true;
        resolve(null);
      }
    });
    req.on("end", () => {
      if (done) return;
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}
async function leaderboardRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/word-check" && req.method === "GET") {
    const word = String(url.searchParams.get("word") || "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3,36}$/.test(word)) {
      res.writeHead(400, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify({ error: "INVALID_WORD" }));
    }
    const mode = url.searchParams.get("adult") === "1" ? "dirty" : "classic";
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=86400",
    });
    return res.end(JSON.stringify({ valid: isDictionaryWord(word, mode) }));
  }
  if (url.pathname === "/api/cast-config" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(
      JSON.stringify({ applicationId: process.env.WORDRUSH_CAST_APPLICATION_ID || null }),
    );
  }
  if (url.pathname === "/api/leaderboard" && req.method === "GET") {
    const period = [
      "weekly",
      "total",
      "multiplayer-wins",
      "multiplayer-ratio",
    ].includes(url.searchParams.get("period"))
      ? url.searchParams.get("period")
      : "weekly";
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    return res.end(
      JSON.stringify({ period, players: leaderboard.rankings(period) }),
    );
  }
  if (url.pathname.startsWith("/api/leaderboard/") && req.method === "GET") {
    const player = leaderboard.profile(
      decodeURIComponent(url.pathname.slice("/api/leaderboard/".length)),
    );
    if (!player) {
      res.writeHead(404);
      return res.end(JSON.stringify({ error: "PLAYER_NOT_FOUND" }));
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify(player));
  }
  if (url.pathname === "/api/leaderboard/score" && req.method === "POST") {
    const body = await readJson(req);
    if (!body || !body.id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "INVALID_SCORE" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(leaderboard.recordScore(body)));
  }
  return false;
}
const originalRequestHandler = server.listeners("request")[0];
server.removeListener("request", originalRequestHandler);
server.on("request", async (req, res) => {
  try {
    if (res.writableEnded) return;
    if (!(await authorizeRequest(req, res))) return;
    const handled = await leaderboardRequest(req, res);
    if (!handled && !res.writableEnded) originalRequestHandler(req, res);
  } catch {
    if (!res.writableEnded) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "INTERNAL_ERROR" }));
    }
  }
});
