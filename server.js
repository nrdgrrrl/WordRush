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
  CONSENT_COUNT_FILE =
    process.env.WORDRUSH_ANALYTICS_CONSENT_FILE ||
    path.join(process.env.STATE_DIRECTORY || "/var/lib/wordrush", "analytics-consent.json"),
  rooms = new Map(),
  clients = new Map(),
  displays = new Map();
const IS_LOOPBACK = ["127.0.0.1", "::1", "localhost"].includes(HOST);
const LAN_MODE = process.env.WORDRUSH_LAN_MODE === "1";
const DISPLAY_TOKEN_TTL_MS = Number(
  process.env.WORDRUSH_DISPLAY_TOKEN_TTL_MS || 5 * 60 * 1000,
);
const DISPLAY_RECONNECT_TTL_MS = Number(
  process.env.WORDRUSH_DISPLAY_RECONNECT_TTL_MS || 8 * 60 * 60 * 1000,
);
const ROOM_RECONNECT_GRACE_MS = Number(
  process.env.WORDRUSH_ROOM_RECONNECT_GRACE_MS || 15 * 60 * 1000,
);
const MAX_WS_CONNECTIONS_PER_IP = Number(process.env.WORDRUSH_MAX_WS_PER_IP || 60);
const MAX_WS_MESSAGES_PER_WINDOW = Number(
  process.env.WORDRUSH_MAX_WS_MESSAGES_PER_WINDOW || 60,
);
const WS_HEARTBEAT_INTERVAL_MS = Number(
  process.env.WORDRUSH_WS_HEARTBEAT_INTERVAL_MS || 30_000,
);
const WS_HEARTBEAT_MISSES = Number(
  process.env.WORDRUSH_WS_HEARTBEAT_MISSES || 2,
);
const RATE_WINDOW_MS = 60_000;
const displayTokens = new Map();
const displayCredentials = new Map();
const rateLimits = new Map();
const configuredOrigins = (process.env.WORDRUSH_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const configuredHosts = (process.env.WORDRUSH_ALLOWED_HOSTS || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

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

function clientIp(req, trustProxy = IS_LOOPBACK) {
  // Apache is trusted only when Node is bound to loopback. Configure it to pass
  // X-Forwarded-For; the first value is the original client.
  return String(
    (trustProxy ? req.headers["x-forwarded-for"] : "") ||
      req.socket.remoteAddress ||
      "",
  )
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
function pruneExpiredRateLimits(now = Date.now()) {
  for (const [key, record] of rateLimits)
    if (record.expiresAt <= now) rateLimits.delete(key);
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
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss: https://www.google-analytics.com https://region1.google-analytics.com; img-src 'self' data: https://www.google-analytics.com; style-src 'self' 'unsafe-inline'; script-src 'self' https://www.gstatic.com https://www.googletagmanager.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
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
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: https://www.gstatic.com; style-src 'self' 'unsafe-inline' https://www.gstatic.com; script-src 'self' https://www.gstatic.com 'unsafe-eval'; media-src 'self' https://www.gstatic.com; font-src 'self' https://www.gstatic.com; base-uri 'none'; frame-ancestors 'none'",
    );
    return true;
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !allowedOrigin(req)) {
    deny(res, 403, "ORIGIN_NOT_ALLOWED");
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
  if (ws?.readyState === 1) ws.send(JSON.stringify(message));
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
    chain: Boolean(raw?.chain),
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
function recordedScore(player) {
  return (player.words || []).reduce(
    (total, item) => total + Math.max(0, Number(item.points) || 0),
    0,
  );
}
function playerScore(room, player) {
  return room.mode === "coop"
    ? room.teamScore
    : room.mode === "longhaul" && Array.isArray(player.words)
      ? recordedScore(player)
      : Number(player.score) || 0;
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
      connected: p.ws?.readyState === 1,
      score: playerScore(room, p),
      session: {
        wins: p.sessionWins,
        losses: p.sessionLosses,
        points: p.sessionPoints,
      },
    })),
    round: room.round
      ? {
          id: room.round.id,
          board: room.round.board,
          size: room.round.size,
          startsAt: room.round.startedAt,
          introEndsAt: room.round.introEndsAt,
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
      score: playerScore(room, p),
      session: {
        wins: p.sessionWins,
        losses: p.sessionLosses,
        points: p.sessionPoints,
      },
    })),
    round: room.round
      ? {
          id: room.round.id,
          board: room.round.board,
          size: room.round.size,
          startsAt: room.round.startedAt,
          introEndsAt: room.round.introEndsAt,
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
    clearTimeout(member.disconnectTimer);
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
  for (const [token, credential] of displayCredentials)
    if (credential.roomCode === room.code) displayCredentials.delete(token);
  for (const [token, displayToken] of displayTokens)
    if (displayToken.roomCode === room.code) displayTokens.delete(token);
  room.players.clear();
  room.round = null;
  room.status = "closed";
}
const RANDOM_MODES = [
  "classic",
  "minimum",
  "sudden",
  "race",
  "blitz",
  "longhaul",
  "storm",
  "scoreattack",
  "chain",
];
const ROUND_INTRO_MS = 4000;
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
  const introEndsAt = Date.now() + ROUND_INTRO_MS;
  const startedAt = introEndsAt;
  room.round = {
    id: crypto.randomUUID(),
    board: board,
    size: config.size,
    found: new Set(),
    lastWord: "",
    startedAt,
    introEndsAt,
    endsAt: startedAt + config.seconds * 1000,
    timer: null,
    config,
    validationMode,
  };
  room.status = "playing";
  room.teamScore = 0;
  room.results = { view: "reveal", speed: "medium" };
  room.lastResult = null;
  for (const player of room.players.values()) {
    player.score = 0;
    player.words = [];
    player.found = new Set();
  }
  room.round.timer = setTimeout(
    () => finishRound(room, "timeout"),
    ROUND_INTRO_MS + config.seconds * 1000,
  );
  room.round.timer.unref?.();
  broadcast(room, { ...state(room), type: "round_started", config });
}
function finishRound(room, reason = "complete", suddenDeath = null) {
  if (!room.round || room.status !== "playing") return;
  clearTimeout(room.round.timer);
  room.status = "finished";
  for (const player of room.players.values())
    player.score = playerScore(room, player);
  const rankedPlayers = [...room.players.values()]
    .sort((a, b) => b.score - a.score);
  const winningScore = rankedPlayers[0]?.score;
  rankedPlayers.forEach((player) => {
    player.sessionPoints += player.score;
    if (room.mode === "coop" || player.score === winningScore)
      player.sessionWins += 1;
    else player.sessionLosses += 1;
  });
  const gameSeconds = Math.min(
    roomConfig(room).seconds,
    Math.max(0, (Date.now() - room.round.startedAt) / 1000),
  );
  const result = {
    roundId: room.round.id,
    gameSeconds,
    cooperative: room.mode === "coop",
    randomRush: room.randomRush,
    teamScore: room.teamScore,
    stats: { wordsFound: room.round.found.size },
    results: room.results,
    reason,
    suddenDeath,
    ranking: rankedPlayers.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar || "🐈",
        score: playerScore(room, p),
        words: p.words || [],
        session: {
          wins: p.sessionWins,
          losses: p.sessionLosses,
          points: p.sessionPoints,
        },
      })),
  };
  room.lastResult = result;
  try {
    leaderboard.recordScores(
      result.ranking.map((rankedPlayer) => {
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
          multiplayerWin:
            result.cooperative || rankedPlayer.score === winningScore,
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
  const reconnectToken = crypto.randomBytes(32).toString("base64url");
  displayCredentials.set(reconnectToken, {
    roomCode: room.code,
    expiresAt: Date.now() + DISPLAY_RECONNECT_TTL_MS,
    ws: null,
  });
  return { room, reconnectToken };
}
function resumeDisplay(value) {
  const token = typeof value === "string" ? value : "";
  const credential = displayCredentials.get(token);
  if (!credential || credential.expiresAt <= Date.now()) {
    if (credential) displayCredentials.delete(token);
    return null;
  }
  const room = rooms.get(credential.roomCode);
  if (!room || room.status === "closed") {
    displayCredentials.delete(token);
    return null;
  }
  credential.expiresAt = Date.now() + DISPLAY_RECONNECT_TTL_MS;
  // A TV can notice a broken network path before Node observes the old close.
  // Possession of the private credential authorizes atomically replacing it.
  return { room, reconnectToken: token, previousSocket: credential.ws };
}
function leaveDisplay(ws) {
  const display = displays.get(ws);
  if (!display) return;
  displays.delete(ws);
  const room = rooms.get(display.roomCode);
  room?.displays.delete(ws);
  const credential = displayCredentials.get(display.reconnectToken);
  if (credential?.ws === ws) credential.ws = null;
}
function roomHasDisplayAuthority(room) {
  if (room.displays.size) return true;
  const now = Date.now();
  for (const credential of displayCredentials.values())
    if (credential.roomCode === room.code && credential.expiresAt > now)
      return true;
  return false;
}
function schedulePlayerExpiry(room, player, ws) {
  clearTimeout(player.disconnectTimer);
  player.disconnectTimer = setTimeout(
    () => expireDisconnectedPlayer(room, player, ws),
    ROOM_RECONNECT_GRACE_MS,
  );
  player.disconnectTimer.unref?.();
}
function expireDisconnectedPlayer(room, player, ws) {
  if (rooms.get(room.code) !== room || player.ws !== ws) return;
  player.disconnectTimer = null;
  // A cast receiver is an active participant even when the host phone sleeps.
  // Keep the host's resumable seat and the room until the display connection
  // (including its bounded reconnect window) is gone.
  if (player.id === room.creatorId && roomHasDisplayAuthority(room))
    return schedulePlayerExpiry(room, player, ws);
  if (player.id === room.creatorId)
    return closeRoom(room, "creator_reconnect_timeout");
  room.players.delete(player.id);
  if (!room.players.size) {
    clearRoomTimer(room);
    return rooms.delete(room.code);
  }
  broadcast(room, state(room));
}
function leave(ws) {
  const info = clients.get(ws);
  if (!info) return leaveDisplay(ws);
  clients.delete(ws);
  const room = rooms.get(info.roomCode);
  if (!room) return;
  const player = room.players.get(info.id);
  if (!player || player.ws !== ws) return;
  clearTimeout(player.disconnectTimer);
  player.disconnectTimer = null;
  // Preserve the seat during the bounded reconnect grace period for both host
  // and guest, then remove stale guests or close an abandoned room.
  schedulePlayerExpiry(room, player, ws);
  broadcast(room, state(room));
}
function handle(ws, message) {
  const type = message?.type;
  if (ws.connectionRole === "display") {
    if (type === "display_keepalive" && displays.has(ws)) {
      const display = displays.get(ws);
      const credential = displayCredentials.get(display.reconnectToken);
      if (credential)
        credential.expiresAt = Date.now() + DISPLAY_RECONNECT_TTL_MS;
      return send(ws, { type: "display_keepalive_ack" });
    }
    if (type !== "display_hello" && type !== "display_resume")
      return send(ws, { type: "error", code: "DISPLAY_READ_ONLY" });
    if (displays.has(ws))
      return send(ws, { type: "error", code: "DISPLAY_ALREADY_AUTHENTICATED" });
    const authenticated = type === "display_resume"
      ? resumeDisplay(message.token)
      : consumeDisplayToken(message.token);
    if (!authenticated)
      return send(ws, {
        type: "error",
        code: type === "display_resume"
          ? "INVALID_DISPLAY_CREDENTIAL"
          : "INVALID_DISPLAY_TOKEN",
      });
    const { room, reconnectToken, previousSocket } = authenticated;
    const credential = displayCredentials.get(reconnectToken);
    if (previousSocket && previousSocket !== ws) {
      displays.delete(previousSocket);
      room.displays.delete(previousSocket);
    }
    credential.ws = ws;
    displays.set(ws, { roomCode: room.code, reconnectToken });
    room.displays.add(ws);
    send(ws, {
      ...displayUpdate(
        room,
        type === "display_resume" ? "display_reconnected" : "display_connected",
      ),
      reconnectToken,
    });
    if (previousSocket && previousSocket !== ws && previousSocket.readyState <= 1)
      previousSocket.close(4000, "display resumed elsewhere");
    return;
  }
  if (type === "hello") {
    if (clients.has(ws))
      return send(ws, { type: "error", code: "HELLO_ALREADY_RECEIVED" });
    const id = cleanText(message.guestId, crypto.randomUUID(), 80);
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
  if (type === "resume_room") {
    const room = rooms.get(String(message.code || "").toUpperCase());
    if (
      client.roomCode &&
      client.roomCode !== room?.code &&
      rooms.has(client.roomCode)
    )
      return send(ws, { type: "error", code: "ALREADY_IN_ROOM" });
    const player = room?.players.get(client.id);
    if (!room || !player || player.reconnectToken !== message.reconnectToken)
      return send(ws, { type: "error", code: "RESUME_FAILED" });
    const oldSocket = player.ws;
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    client.roomCode = room.code;
    client.name = cleanText(message.name, player.name);
    client.avatar = cleanText(message.avatar, player.avatar || "🐈", 2);
    player.name = client.name;
    player.avatar = client.avatar;
    player.ws = ws;
    if (oldSocket !== ws && oldSocket?.readyState <= 1)
      oldSocket.close(1000, "connection resumed elsewhere");
    send(ws, {
      type: "room_resumed",
      code: room.code,
      reconnectToken: player.reconnectToken,
    });
    return broadcast(room, state(room));
  }
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
    const player = {
      ...client,
      ws,
      reconnectToken: crypto.randomBytes(32).toString("base64url"),
      disconnectTimer: null,
      score: room.mode === "coop" ? room.teamScore : 0,
      words: [],
      found: new Set(),
      sessionWins: 0,
      sessionLosses: 0,
      sessionPoints: 0,
    };
    room.players.set(client.id, player);
    send(ws, {
      type: "room_created",
      code: room.code,
      reconnectToken: player.reconnectToken,
    });
    broadcast(room, state(room));
    return;
  }
  if (type === "join_room") {
    if (client.roomCode && rooms.has(client.roomCode))
      return send(ws, { type: "error", code: "ALREADY_IN_ROOM" });
    const room = rooms.get(String(message.code || "").toUpperCase());
    if (!room) return send(ws, { type: "error", code: "ROOM_NOT_FOUND" });
    const existingPlayer = room.players.get(client.id);
    if (existingPlayer) {
      if (existingPlayer.ws?.readyState === 1)
        return send(ws, { type: "error", code: "ALREADY_JOINED" });
      if (existingPlayer.reconnectToken !== message.reconnectToken)
        return send(ws, { type: "error", code: "RECONNECT_TOKEN_REQUIRED" });
      const oldSocket = existingPlayer.ws;
      clearTimeout(existingPlayer.disconnectTimer);
      existingPlayer.disconnectTimer = null;
      client.roomCode = room.code;
      client.name = cleanText(message.name, existingPlayer.name);
      client.avatar = cleanText(
        message.avatar,
        existingPlayer.avatar || "🐈",
        2,
      );
      existingPlayer.name = client.name;
      existingPlayer.avatar = client.avatar;
      existingPlayer.ws = ws;
      existingPlayer.reconnectToken = crypto.randomBytes(32).toString("base64url");
      if (oldSocket !== ws && oldSocket?.readyState <= 1)
        oldSocket.close(1000, "player rejoined from invite");
      send(ws, {
        type: "joined_room",
        code: room.code,
        reconnectToken: existingPlayer.reconnectToken,
      });
      return broadcast(room, state(room));
    }
    if (room.players.size >= MAX_PLAYERS)
      return send(ws, { type: "error", code: "ROOM_FULL" });
    client.roomCode = room.code;
    client.name = cleanText(message.name, client.name);
    client.avatar = cleanText(message.avatar, client.avatar || "🐈", 2);
    const player = {
      ...client,
      ws,
      reconnectToken: crypto.randomBytes(32).toString("base64url"),
      disconnectTimer: null,
      score: room.mode === "coop" ? room.teamScore : 0,
      words: [],
      found: new Set(),
      sessionWins: 0,
      sessionLosses: 0,
      sessionPoints: 0,
    };
    room.players.set(client.id, player);
    send(ws, {
      type: "joined_room",
      code: room.code,
      reconnectToken: player.reconnectToken,
    });
    broadcast(room, state(room));
    return;
  }
  const room = rooms.get(client.roomCode);
  if (!room) return send(ws, { type: "error", code: "NOT_IN_ROOM" });
  if (type === "create_display_token") {
    if (client.id !== room.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
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
      clearTimeout(leavingRoom.players.get(client.id)?.disconnectTimer);
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
  if (type === "start_round_now") {
    if (client.id !== room.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
    if (room.status !== "playing" || !room.round)
      return send(ws, { type: "error", code: "ROUND_NOT_PLAYING" });
    if (Date.now() >= room.round.introEndsAt)
      return send(ws, {
        type: "round_start_now",
        startsAt: room.round.startedAt,
        endsAt: room.round.endsAt,
      });
    const startedAt = Date.now();
    room.round.introEndsAt = startedAt;
    room.round.startedAt = startedAt;
    room.round.endsAt = startedAt + roomConfig(room).seconds * 1000;
    clearTimeout(room.round.timer);
    room.round.timer = setTimeout(
      () => finishRound(room, "timeout"),
      roomConfig(room).seconds * 1000,
    );
    room.round.timer.unref?.();
    return broadcast(room, {
      type: "round_start_now",
      startsAt: room.round.startedAt,
      endsAt: room.round.endsAt,
    });
  }
  if (type === "set_results_settings") {
    if (room.status !== "finished")
      return send(ws, { type: "error", code: "RESULTS_NOT_READY" });
    // Multiplayer result presentation is host-controlled; solo preferences
    // remain local and never reach this handler.
    if (client.id !== room.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
    const view = message.view === "static" ? "static" : "reveal";
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
    const now = Date.now();
    if (now < room.round.startedAt)
      return send(ws, { type: "error", code: "ROUND_NOT_STARTED" });
    if (now >= room.round.endsAt) return finishRound(room, "timeout");
    const player = room.players.get(client.id);
    let result = validateSubmission({
      ...message,
      board: room.round.board,
      size: room.round.size,
      mode: room.round.validationMode,
      minimum: roomConfig(room).min,
      found: room.mode === "coop" ? room.round.found : player.found,
      customWords: [...room.customWords],
    });
    const chainBreak =
      roomConfig(room).chain &&
      room.round.lastWord &&
      result.word[0] !== room.round.lastWord.at(-1);
    if (chainBreak && result.valid)
      result = { ...result, valid: false, reason: "chain", points: 0 };
    if (!result.valid) {
      console.warn("Wordrush rejected submission", JSON.stringify({
        wordLength: result.word.length,
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
        finishRound(room, "invalid_word", {
          playerId: client.id,
          playerName: player.name,
          playerAvatar: player.avatar || "🐈",
          word: result.word,
        });
      return;
    }
    // Validation is synchronous today, but keep the scoring boundary
    // authoritative if validation or future policy checks ever take time.
    // A word received before the deadline must not be awarded after it.
    if (Date.now() >= room.round.endsAt) return finishRound(room, "timeout");
    room.round.found.add(result.word);
    room.round.lastWord = result.word;
    player.found.add(result.word);
    if (room.mode === "coop") {
      room.teamScore += result.points;
      for (const teammate of room.players.values())
        teammate.score = room.teamScore;
    } else player.score += result.points;
    player.words = player.words || [];
    player.words.push({ word: result.word, points: result.points });
    player.score = playerScore(room, player);
    broadcast(room, {
      type: "word_accepted",
      playerId: client.id,
      word: result.word,
      points: result.points,
      scores: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar || "🐈",
        score: playerScore(room, p),
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
  const publicRootFiles = new Set([
    "/index.html",
    "/robots.txt",
    "/sitemap.xml",
    "/manifest.webmanifest",
    "/favicon.svg",
    "/styles.css",
    "/stats.css",
    "/custom.css",
    "/multiplayer.css",
    "/game-config.js",
    "/board-core.js",
    "/analytics.js",
    "/app.js",
    "/stats.js",
    "/achievements.js",
    "/multiplayer-client.js",
    "/cast-sender.js",
    "/leaderboard-client.js",
    "/random-rush.js",
    "/results.js",
  ]);
  if (
    !publicRootFiles.has(requested) &&
    !requested.startsWith("/assets/") &&
    !requested.startsWith("/receiver/")
  ) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
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
      ".txt": "text/plain",
      ".xml": "application/xml",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json",
    };
  res.writeHead(200, {
    "Content-Type":
      (types[ext] || "application/octet-stream") +
      (types[ext]?.startsWith("text/") ? "; charset=utf-8" : ""),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control":
      requested === "/index.html"
        ? "no-cache"
        : requested === "/robots.txt" || requested === "/sitemap.xml"
          ? "public, max-age=3600"
          : "public, max-age=3600, stale-while-revalidate=86400",
  });
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 });
wss.on("connection", (ws, req) => {
  ws.connectionRole =
    new URL(req.url || "/", "http://localhost").pathname === "/display"
      ? "display"
      : "player";
  ws.missedHeartbeats = 0;
  ws.connectedAt = Date.now();
  ws.messageWindow = { startedAt: Date.now(), count: 0 };
  ws.on("pong", () => {
    ws.missedHeartbeats = 0;
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
  ws.on("close", (code, reason) => {
    const client = clients.get(ws);
    const display = displays.get(ws);
    if (process.env.NODE_ENV === "production" || process.env.WORDRUSH_LOG_WS === "1")
      console.log(
        `Wordrush WebSocket closed role=${ws.connectionRole} room=${client?.roomCode || display?.roomCode || "none"} code=${code} durationMs=${Date.now() - ws.connectedAt} reason=${String(reason || "none").slice(0, 80)}`,
      );
    leave(ws);
  });
});
server.on("upgrade", (req, socket, head) => {
  if (!allowedHost(req) || !allowedOrigin(req)) return socket.destroy();
  const ip = clientIp(req);
  if (!rateLimit(`ws:${ip}`, MAX_WS_CONNECTIONS_PER_IP)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
function heartbeatSocket(ws) {
  // Cast devices can briefly pause their network stack while changing Wi-Fi
  // power state. Require multiple missed pongs instead of killing one stall.
  if (ws.missedHeartbeats >= WS_HEARTBEAT_MISSES) {
    ws.terminate();
    return false;
  }
  ws.missedHeartbeats += 1;
  ws.ping();
  return true;
}
const heartbeat = setInterval(() => {
  const now = Date.now();
  pruneExpiredRateLimits(now);
  for (const [token, display] of displayTokens)
    if (display.expiresAt <= now) displayTokens.delete(token);
  for (const [token, credential] of displayCredentials)
    if (credential.expiresAt <= now) {
      if (credential.ws?.readyState === 1)
        credential.expiresAt = now + DISPLAY_RECONNECT_TTL_MS;
      else displayCredentials.delete(token);
    }
  for (const ws of wss.clients) {
    heartbeatSocket(ws);
  }
}, WS_HEARTBEAT_INTERVAL_MS);
heartbeat.unref?.();
if (require.main === module)
  server.listen(PORT, HOST, () =>
    console.log("Wordrush listening on http://" + HOST + ":" + PORT),
  );
module.exports = {
  server,
  rooms,
  handle,
  MAX_PLAYERS,
  displayTokens,
  displayCredentials,
  rateLimits,
  clientIp,
  pruneExpiredRateLimits,
  heartbeatSocket,
  WS_HEARTBEAT_MISSES,
};

const { Leaderboard } = require("./leaderboard");
const leaderboard = new Leaderboard();
function recordAnalyticsConsentChoice(choice) {
  const cleanChoice = choice === "granted" ? "granted" : choice === "denied" ? "denied" : "";
  if (!cleanChoice) return null;
  let data = { granted: 0, denied: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(CONSENT_COUNT_FILE, "utf8"));
    data = {
      granted: Math.max(0, Number(parsed.granted) || 0),
      denied: Math.max(0, Number(parsed.denied) || 0),
    };
  } catch {}
  data[cleanChoice] += 1;
  data.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(CONSENT_COUNT_FILE), { recursive: true });
  const temporary = CONSENT_COUNT_FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, CONSENT_COUNT_FILE);
  return data;
}
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
  if (url.pathname === "/api/analytics-config" && req.method === "GET") {
    const rawId = String(process.env.WORDRUSH_GOOGLE_ANALYTICS_ID || "")
      .trim()
      .toUpperCase();
    const measurementId = /^G-[A-Z0-9]{5,20}$/.test(rawId) ? rawId : null;
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify({
      measurementId,
      requireConsent:
        process.env.WORDRUSH_ANALYTICS_REQUIRE_CONSENT !== "0",
    }));
  }
  if (url.pathname === "/api/analytics-consent" && req.method === "POST") {
    if (!rateLimit("analytics-consent:" + clientIp(req), 30)) {
      res.writeHead(429, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify({ error: "RATE_LIMITED" }));
    }
    const body = await readJson(req);
    const counts = body && recordAnalyticsConsentChoice(body.choice);
    if (!counts) {
      res.writeHead(400, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify({ error: "INVALID_CHOICE" }));
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify({ ok: true }));
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
    if (!rateLimit("leaderboard-score:" + clientIp(req), 30)) {
      res.writeHead(429, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify({ error: "RATE_LIMITED" }));
    }
    // Solo rounds run entirely in the browser, so their reported score and
    // identity cannot be verified here. Multiplayer results are recorded only
    // from authoritative room state in finishRound(). Never accept a public
    // payload that could spoof a player or inflate the global leaderboard.
    res.writeHead(410, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify({ error: "UNVERIFIED_SCORE" }));
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
