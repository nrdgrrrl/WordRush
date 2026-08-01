const RANDOM_RUSH_DELAY = Number(process.env.RANDOM_RUSH_DELAY || 20000);
const CONSENT_TIMEOUT_MS = Number(process.env.WORDRUSH_CONSENT_TIMEOUT_MS || 60_000);
const CHALLENGE_TIMEOUT_MS = Number(process.env.WORDRUSH_CHALLENGE_TIMEOUT_MS || 30_000);
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  QRCode = require("qrcode"),
  { WebSocketServer } = require("ws");
const {
  MODE_CONFIG,
  getPreparedLexicon,
  generateBoardCooperatively,
  isDictionaryWord,
  validateSubmission,
} = require("./game-core");
const {
  DEFAULT_DICTIONARY_ID,
  getDictionary,
  getDictionaryMetadata,
} = require("./dictionary-registry");
const {
  configForPreset,
  validateCustomConfig,
  isSuddenDeath,
  requiresChain,
  chainWordMatches,
  advanceChainFields,
  hasScoreTarget,
  usesAdultLexicon,
  isPartyRound,
  shouldEndOnRejectedWord,
} = require("./game-config");
const {
  generateQualityRoundBoard,
} = require("./production-board-generator");
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
const preAdmissionChallenges = new Map();
const configuredOrigins = (process.env.WORDRUSH_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const configuredHosts = (process.env.WORDRUSH_ALLOWED_HOSTS || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const generationTestHooks = {
  limits: null,
  selectorLimits: null,
  lexicon: null,
  yieldScheduler: null,
  onContract: null,
  onResult: null,
  onCancellation: null,
};
const nodeGenerationScheduler = () =>
  new Promise((resolve) => setImmediate(resolve));

if (process.env.NODE_ENV === "production" && !LAN_MODE && !configuredOrigins.length)
  throw new Error("WORDRUSH_ALLOWED_ORIGINS is required in production");
getDictionary();

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
function staticCacheControl(requested) {
  if (
    requested === "/dictionary.json" ||
    requested.startsWith("/receiver/") ||
    requested === "/manifest.webmanifest" ||
    (path.dirname(requested) === "/" &&
      [".css", ".html", ".js"].includes(path.extname(requested)))
  )
    return "no-cache";
  if (requested === "/robots.txt" || requested === "/sitemap.xml")
    return "public, max-age=3600";
  return "public, max-age=3600, stale-while-revalidate=86400";
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
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self' https://www.gstatic.com; base-uri 'none'; frame-ancestors 'none'",
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
function isAdultRequest(mode, config) {
  if (mode === "dirty") return true;
  return usesAdultLexicon(config);
}
function isAdultRoom(room) {
  return usesAdultLexicon(roomConfig(room));
}
function isAdultLastResult(room) {
  return room.status === "finished" && room.lastResult && isAdultRoom(room);
}
function roomExposesAdultContent(room) {
  return Boolean(room.pendingConsent) || isAdultRoom(room) || isAdultLastResult(room);
}
function requestedConfig(mode, raw) {
  if (mode === "custom") {
    const result = validateCustomConfig(raw);
    if (!result.valid) return null;
    return result.config;
  }
  return configForPreset(mode);
}
const SOLO_REQUEST_FIELDS = new Set(["mode", "config", "dictionaryId", "adult"]);
const SERVER_GENERATION_POLICY_FIELDS = new Set([
  "seed",
  "requestedSeed",
  "candidateCount",
  "qualityProfile",
  "qualityProfileId",
  "thresholds",
  "selectorLimits",
  "generationLimits",
  "analysisLimits",
  "candidateSeeds",
  "rankingPolicy",
  "vocabulary",
  "words",
]);
const CUSTOM_CONFIG_FIELDS = new Set([
  "label",
  "min",
  "size",
  "seconds",
  "rule",
  "target",
  "sudden",
  "chain",
  "adult",
  "party",
]);
function validateSoloBoardRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { valid: false, code: "SOLO_REQUEST_INVALID" };
  if (Object.keys(body).some((field) => !SOLO_REQUEST_FIELDS.has(field)))
    return { valid: false, code: "SOLO_REQUEST_FIELD_NOT_ALLOWED" };
  if (typeof body.mode !== "string")
    return { valid: false, code: "UNKNOWN_MODE" };
  const mode = body.mode;
  let config;
  if (mode === "custom") {
    if (
      !body.config ||
      typeof body.config !== "object" ||
      Array.isArray(body.config) ||
      Object.keys(body.config).some((field) => !CUSTOM_CONFIG_FIELDS.has(field))
    )
      return { valid: false, code: "CUSTOM_CONFIG_INVALID" };
    const result = validateCustomConfig(body.config);
    if (!result.valid)
      return {
        valid: false,
        code: "CUSTOM_CONFIG_INVALID",
        detail: result.error,
      };
    config = result.config;
  } else {
    if (body.config !== undefined && body.config !== null)
      return { valid: false, code: "PRESET_CONFIG_NOT_ALLOWED" };
    config = configForPreset(mode);
    if (!config) return { valid: false, code: "UNKNOWN_MODE" };
  }
  if (body.adult !== undefined && typeof body.adult !== "boolean")
    return { valid: false, code: "ADULT_INTENT_INVALID" };
  const adult = usesAdultLexicon(config);
  if (adult && body.adult !== true)
    return { valid: false, code: "ADULT_INTENT_REQUIRED" };
  if (!adult && body.adult === true)
    return { valid: false, code: "ADULT_INTENT_INVALID" };
  const dictionaryId = body.dictionaryId === undefined
    ? DEFAULT_DICTIONARY_ID
    : body.dictionaryId;
  if (typeof dictionaryId !== "string")
    return { valid: false, code: "UNKNOWN_DICTIONARY_ID" };
  let dictionary;
  try {
    dictionary = getDictionary(dictionaryId);
  } catch (error) {
    return {
      valid: false,
      code: error.message.startsWith("UNKNOWN_DICTIONARY_ID")
        ? "UNKNOWN_DICTIONARY_ID"
        : "DICTIONARY_ARTIFACT_INVALID",
      status: error.message.startsWith("UNKNOWN_DICTIONARY_ID") ? 404 : 500,
    };
  }
  return { valid: true, mode, config, dictionary };
}
function roomConfig(room) {
  return (
    room.round?.config ||
    room.config ||
    MODE_CONFIG[room.mode] ||
    MODE_CONFIG.classic
  );
}
function roomDictionaryMetadata(room) {
  return getDictionaryMetadata(room.round?.dictionaryId || room.dictionaryId || DEFAULT_DICTIONARY_ID);
}
function recordedScore(player) {
  return (player.words || []).reduce(
    (total, item) => total + Math.max(0, Number(item.points) || 0),
    0,
  );
}
function createPendingConsent(room, mode, config, dictionaryId = room.dictionaryId || DEFAULT_DICTIONARY_ID) {
  if (!config) return;
  const adultConfig = { ...config, adult: true };
  const requestId = crypto.randomUUID();
  const expiresAt = Date.now() + CONSENT_TIMEOUT_MS;
  const connectedIds = [...room.players.values()]
    .filter((p) => p.ws?.readyState === 1)
    .map((p) => p.id);
  if (!connectedIds.length) return;
  room.pendingConsent = {
    requestId,
    mode,
    config: adultConfig,
    dictionaryId,
    requiredPlayerIds: connectedIds,
    acceptedPlayerIds: [],
    expiresAt,
    timer: setTimeout(() => {
      if (room.pendingConsent?.requestId === requestId)
        cancelPendingConsent(room, "timeout");
    }, CONSENT_TIMEOUT_MS),
  };
  room.pendingConsent.timer.unref?.();
  broadcast(room, {
    type: "adult_consent_request",
    requestId,
    mode,
    config: { adult: true, min: config.min, size: config.size, seconds: config.seconds },
    requiredPlayerIds: connectedIds,
    acceptedPlayerIds: [],
    expiresAt,
  });
}
function cancelPendingConsent(room, reason) {
  const pending = room.pendingConsent;
  if (!pending) return;
  if (
    pending.generating &&
    room.generation?.consentRequestId === pending.requestId
  )
    room.generation.cancelled = true;
  clearTimeout(pending.timer);
  room.pendingConsent = null;
  broadcast(room, {
    type: "adult_consent_cancelled",
    requestId: pending.requestId,
    reason,
  });
}
async function completeAdultConsent(room, requestId) {
  const pending = room.pendingConsent;
  if (
    !pending ||
    pending.requestId !== requestId ||
    room.status !== "lobby" ||
    room.round !== null
  )
    return false;
  if (pending.acceptedPlayerIds.length !== pending.requiredPlayerIds.length)
    return false;
  for (const id of pending.requiredPlayerIds) {
    if (!pending.acceptedPlayerIds.includes(id)) return false;
    if (room.pendingConsent !== pending || pending.generating) return false;
    const player = room.players.get(id);
    if (!player || player.ws?.readyState !== 1) return false;
  }
  const acceptedIds = [...pending.acceptedPlayerIds];
  const storedRequestId = pending.requestId;
  pending.generating = true;
  clearTimeout(pending.timer);
  const started = await startRound(
    room,
    pending.mode,
    pending.config,
    acceptedIds,
    storedRequestId,
    pending.dictionaryId,
  );
  if (!started && room.pendingConsent === pending)
    cancelPendingConsent(room, "generation_failed");
  return started;
}
function createPreAdmissionChallenge(room, client, ws, options = {}) {
  const challengeId = crypto.randomUUID();
  const challenge = {
    challengeId,
    roomCode: room.code,
    clientId: client.id,
    ws,
    targetRequestId: options.targetRequestId || (room.pendingConsent ? room.pendingConsent.requestId : null),
    roundId: options.roundId || (room.round ? room.round.id : null),
    resultRoundId: options.resultRoundId || null,
    expiresAt: Date.now() + CHALLENGE_TIMEOUT_MS,
  };
  preAdmissionChallenges.set(challengeId, challenge);
  const sourceConfig = room.pendingConsent ? room.pendingConsent.config : roomConfig(room);
  const safeMeta = {
    adult: true,
    min: sourceConfig.min,
    size: sourceConfig.size,
    seconds: sourceConfig.seconds,
  };
  const mode = room.pendingConsent?.mode || room.mode;
  const payload = {
    type: "adult_pre_admission_challenge",
    challengeId,
    roomCode: room.code,
    expiresAt: challenge.expiresAt,
    mode,
    config: safeMeta,
  };
  if (room.round) payload.roundId = room.round.id;
  if (room.lastResult && isAdultLastResult(room)) payload.resultRoundId = room.lastResult.roundId;
  if (room.pendingConsent) payload.targetRequestId = room.pendingConsent.requestId;
  send(ws, payload);
  return challenge;
}
function findPreAdmissionBySocket(ws) {
  for (const challenge of preAdmissionChallenges.values())
    if (challenge.ws === ws) return challenge;
  return null;
}
function cleanupPreAdmission(ws) {
  const challenge = findPreAdmissionBySocket(ws);
  if (challenge) preAdmissionChallenges.delete(challenge.challengeId);
}
function prunePreAdmissionChallenges(now = Date.now()) {
  for (const [id, challenge] of preAdmissionChallenges) {
    if (challenge.expiresAt <= now) {
      preAdmissionChallenges.delete(id);
      if (challenge.ws?.readyState === 1)
        send(challenge.ws, { type: "adult_pre_admission_timeout", challengeId: id });
    }
  }
}
function playerScore(room, player) {
  return room.mode === "coop"
    ? room.teamScore
    : room.mode === "longhaul" && Array.isArray(player.words)
      ? recordedScore(player)
      : Number(player.score) || 0;
}
function publicChainState(round) {
  if (!round?.config?.chain) return null;
  return {
    lastAcceptedWord: round.lastAcceptedWord,
    requiredLetter: round.requiredLetter,
    chainResetLetter: round.chainResetLetter,
  };
}
function state(room) {
  return {
    type: "room_state",
    code: room.code,
    creatorId: room.creatorId,
    randomRush: room.randomRush,
    dictionary: roomDictionaryMetadata(room),
    mode: room.mode,
    status: room.status,
    results: room.results,
    config: roomConfig(room),
    lastResult: room.status === "finished" ? room.lastResult : null,
    ...(room.status === "playing" && room.round?.config?.chain
      ? { chain: publicChainState(room.round) }
      : {}),
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
          dictionary: room.round.dictionary,
        }
      : null,
  };
}
function displayState(room) {
  return {
    code: room.code,
    mode: room.mode,
    dictionary: roomDictionaryMetadata(room),
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
          dictionary: room.round.dictionary,
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
  if (room.generation) room.generation.cancelled = true;
  room.generation = null;
  if (room.pendingConsent) cancelPendingConsent(room, "room_closed");
  for (const [id, challenge] of preAdmissionChallenges) {
    if (challenge.roomCode === room.code) {
      preAdmissionChallenges.delete(id);
      if (challenge.ws?.readyState === 1)
        send(challenge.ws, {
          type: "session_closed",
          code: room.code,
          reason,
        });
    }
  }
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
function generationFailure(room, generation, result) {
  if (room.generation !== generation) return false;
  room.generation = null;
  const failureCode = result?.error?.code || "GENERATION_FAILED";
  const creator = room.players.get(room.creatorId);
  const diagnostics = result?.diagnostics
    ? { ...result.diagnostics, dictionary: generation.dictionary }
    : null;
  if (failureCode !== "QUALITY_SELECTION_CANCELLED" && failureCode !== "CONSENT_INVALIDATED")
    console.warn("Wordrush quality board generation failed", JSON.stringify({
      failureCode,
      diagnostics,
    }));
  send(creator?.ws, {
    type: "error",
    code: "BOARD_GENERATION_FAILED",
    failureCode,
    diagnostics,
  });
  broadcast(room, state(room));
  return false;
}
function boardGenerationContract(config, dictionaryId = DEFAULT_DICTIONARY_ID) {
  const dictionary = getDictionary(dictionaryId);
  const validationMode = usesAdultLexicon(config) ? "dirty" : "classic";
  return {
    size: config.size,
    minimum: config.min,
    validationMode,
    dictionary,
    prepared:
      generationTestHooks.lexicon ||
      getPreparedLexicon(dictionary.id, validationMode),
  };
}
// Development/test entry point for the same server-owned quality path used by
// production callers. It is retained for focused selector diagnostics.
async function selectRoundBoardForDevelopment(contract, options = {}) {
  return generateProductionRoundBoard(contract, {
    ...options,
    requestedSeed: options.requestedSeed ?? options.seed,
  });
}
async function generateRoundBoard(contract, options = {}) {
  const seed = options.seed ?? crypto.randomInt(0x100000000);
  generationTestHooks.onContract?.({
    size: contract.size,
    minimum: contract.minimum,
    validationMode: contract.validationMode,
    dictionaryId: contract.dictionary.id,
    seed,
  });
  let result;
  try {
    result = await generateBoardCooperatively(
      contract.size,
      contract.prepared,
      {
        mode: contract.validationMode,
        min: contract.minimum,
        seed,
        limits: generationTestHooks.limits || undefined,
        yieldScheduler:
          generationTestHooks.yieldScheduler || nodeGenerationScheduler,
        isCancelled: options.isCancelled,
      },
    );
  } catch (error) {
    result = {
      ok: false,
      error: { code: error.code === "GENERATION_CANCELLED"
        ? "GENERATION_CANCELLED"
        : "GENERATION_EXCEPTION" },
      diagnostics: {
        seed,
        size: contract.size,
        mode: contract.validationMode,
        minimum: contract.minimum,
        lexiconFingerprint: contract.prepared.fingerprint,
        normalizedLexiconCount: contract.prepared.normalizedCount,
      },
    };
  }
  generationTestHooks.onResult?.(result);
  return { result, seed };
}
async function generateProductionRoundBoard(contract, options = {}) {
  const requestedSeed = options.requestedSeed ?? crypto.randomInt(0x100000000);
  generationTestHooks.onContract?.({
    size: contract.size,
    minimum: contract.minimum,
    validationMode: contract.validationMode,
    dictionaryId: contract.dictionary.id,
    requestedSeed,
  });
  const result = await generateQualityRoundBoard(contract, {
    requestedSeed,
    isCancelled: options.isCancelled,
    selectorLimits:
      options.selectorLimits || generationTestHooks.selectorLimits || undefined,
    analysisIndex: options.analysisIndex,
    yieldScheduler:
      options.yieldScheduler ||
      generationTestHooks.yieldScheduler ||
      nodeGenerationScheduler,
  });
  generationTestHooks.onResult?.(result);
  return result;
}
async function startRound(
  room,
  selected = room.mode,
  configArg = null,
  roundConsentedPlayerIds = null,
  consentRequestId = null,
  dictionaryId = room.dictionaryId || DEFAULT_DICTIONARY_ID,
) {
  if (room.generation) return false;
  let config = configArg;
  if (!config) {
    const preset = configForPreset(selected);
    if (!preset) return;
    config = preset;
  }
  if (usesAdultLexicon(config)) {
    const validConsent =
      Array.isArray(roundConsentedPlayerIds) &&
      roundConsentedPlayerIds.length > 0 &&
      roundConsentedPlayerIds.every(id => {
        const player = room.players.get(id);
        return player && player.ws?.readyState === 1;
      });
    if (!validConsent) return;
  }
  clearRoomTimer(room);
  const contract = boardGenerationContract(config, dictionaryId);
  const dictionary = contract.dictionary;
  const validationMode = contract.validationMode;
  const generation = {
    token: crypto.randomUUID(),
    consentRequestId,
    requestedSeed: crypto.randomInt(0x100000000),
    cancelled: false,
    dictionary: dictionary.metadata,
  };
  room.generation = generation;
  const result = await generateProductionRoundBoard(contract, {
    requestedSeed: generation.requestedSeed,
    isCancelled: () => generation.cancelled,
  });
  if (generation.cancelled) {
    room.generation = null;
    return false;
  }
  if (room.generation !== generation) return false;
  const consentedPlayerIds =
    consentRequestId && room.pendingConsent?.requestId === consentRequestId
      ? [...room.pendingConsent.acceptedPlayerIds]
      : roundConsentedPlayerIds
        ? [...roundConsentedPlayerIds]
        : [...room.players.keys()];
  if (
    usesAdultLexicon(config) &&
    (!consentedPlayerIds.length ||
      !consentedPlayerIds.every((id) => room.players.get(id)?.ws?.readyState === 1))
  )
    return generationFailure(room, generation, {
      ok: false,
      error: { code: "CONSENT_INVALIDATED" },
      diagnostics: result?.diagnostics,
    });
  if (!result.ok) return generationFailure(room, generation, result);
  room.generation = null;
  if (consentRequestId && room.pendingConsent?.requestId === consentRequestId) {
    clearTimeout(room.pendingConsent.timer);
    room.pendingConsent = null;
  }
  room.mode = selected;
  room.config = config;
  room.dictionaryId = dictionary.id;
  const introEndsAt = Date.now() + ROUND_INTRO_MS;
  const startedAt = introEndsAt;
  room.round = {
    id: crypto.randomUUID(),
    board: result.board,
    size: config.size,
    found: new Set(),
    ...(requiresChain(config)
      ? {
          lastAcceptedWord: "",
          requiredLetter: "",
          chainResetLetter: "",
          chainRemainingByInitial: { ...result.report.playableWordStarts },
        }
      : {}),
    startedAt,
    introEndsAt,
    endsAt: startedAt + config.seconds * 1000,
    timer: null,
    config,
    dictionaryId: dictionary.id,
    dictionary: dictionary.metadata,
    validationMode,
    quality: result.compactDiagnostics || null,
    adultConsentRequestId: consentRequestId,
    consentedPlayerIds,
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
  const roundId = room.round.id;
  room.round.timer = setTimeout(() => {
    if (
      rooms.get(room.code) !== room ||
      room.status !== "playing" ||
      room.round?.id !== roundId
    )
      return;
    finishRound(room, "timeout");
  }, ROUND_INTRO_MS + config.seconds * 1000);
  room.round.timer.unref?.();
  broadcast(room, { ...state(room), type: "round_started", config });
  return true;
}
function finishRound(room, reason = "complete", suddenDeath = null) {
  if (!room.round || room.status !== "playing") return;
  clearTimeout(room.round.timer);
  room.status = "finished";
  const recorded = reason !== "skipped";
  for (const player of room.players.values())
    player.score = playerScore(room, player);
  const rankedPlayers = [...room.players.values()]
    .sort((a, b) => b.score - a.score);
  const winningScore = rankedPlayers[0]?.score;
  if (recorded) {
    rankedPlayers.forEach((player) => {
      player.sessionPoints += player.score;
      if (room.mode === "coop" || player.score === winningScore)
        player.sessionWins += 1;
      else player.sessionLosses += 1;
    });
  }
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
    ...(recorded ? {} : { recorded: false }),
    suddenDeath,
    dictionary: room.round.dictionary,
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
  if (recorded) {
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
  }
  broadcast(room, { type: "round_finished", ...result });
  if (room.randomRush) {
    const finishedRoundId = result.roundId;
    room.rushTimer = setTimeout(() => {
      room.rushTimer = null;
      if (
        rooms.get(room.code) !== room ||
        !room.randomRush ||
        room.status !== "finished" ||
        room.lastResult?.roundId !== finishedRoundId ||
        room.round?.id !== finishedRoundId ||
        room.generation
      )
        return;
      void startRound(room, randomMode(room));
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
  cleanupPreAdmission(ws);
  const info = clients.get(ws);
  if (!info) return leaveDisplay(ws);
  clients.delete(ws);
  const room = rooms.get(info.roomCode);
  if (!room) return;
  const player = room.players.get(info.id);
  if (!player || player.ws !== ws) return;
  if (
    room.pendingConsent &&
    room.pendingConsent.requiredPlayerIds.includes(info.id)
  )
    cancelPendingConsent(room, "player_disconnected");
  clearTimeout(player.disconnectTimer);
  player.disconnectTimer = null;
  // Preserve the seat during the bounded reconnect grace period for both host
  // and guest, then remove stale guests or close an abandoned room.
  schedulePlayerExpiry(room, player, ws);
  broadcast(room, state(room));
}
async function handle(ws, message) {
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
    if (
      roomExposesAdultContent(room) &&
      !room.round?.consentedPlayerIds?.includes(client.id)
    )
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
    if ("customWords" in message) {
      return send(ws, { type: "error", code: "CUSTOM_WORDS_REJECTED" });
    }
    if (Object.keys(message).some((field) => SERVER_GENERATION_POLICY_FIELDS.has(field)))
      return send(ws, { type: "error", code: "ROUND_GENERATION_POLICY_NOT_ALLOWED" });
    const room = {
      code: code(),
      mode: "classic",
      dictionaryId: DEFAULT_DICTIONARY_ID,
      creatorId: null,
      randomRush: false,
      randomModeQueue: [],
      teamScore: 0,
      players: new Map(),
      displays: new Set(),
      status: "lobby",
      round: null,
      generation: null,
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
      if (
        roomExposesAdultContent(room) &&
        !room.round?.consentedPlayerIds?.includes(client.id) &&
        !room.lastResult?.consentedPlayerIds?.includes(client.id)
      )
        return send(ws, { type: "error", code: "RESUME_FAILED" });
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
    if (roomExposesAdultContent(room)) {
      const existingChallenge = findPreAdmissionBySocket(ws);
      if (existingChallenge) preAdmissionChallenges.delete(existingChallenge.challengeId);
      createPreAdmissionChallenge(room, client, ws);
      return;
    }
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
  if (type === "adult_consent_response") {
    const hasRequestId = typeof message.requestId === "string";
    const hasChallengeId = typeof message.challengeId === "string";
    if (hasRequestId && hasChallengeId)
      return send(ws, { type: "error", code: "CONSENT_AMBIGUOUS" });
    if (!hasRequestId && !hasChallengeId)
      return send(ws, { type: "error", code: "CONSENT_MISSING_TARGET" });
    if (message.accepted !== true && message.accepted !== false)
      return send(ws, { type: "error", code: "CONSENT_INVALID_VALUE" });
    if (hasChallengeId) {
      const challenge = preAdmissionChallenges.get(message.challengeId);
      if (!challenge || challenge.ws !== ws) return;
      const challengeClient = clients.get(ws);
      if (!challengeClient || challengeClient.id !== challenge.clientId) return;
      const targetRoom = rooms.get(challenge.roomCode);
      if (!targetRoom || targetRoom.status === "closed") {
        preAdmissionChallenges.delete(challenge.challengeId);
        return send(ws, { type: "adult_pre_admission_declined", challengeId: message.challengeId });
      }
      if (challenge.expiresAt <= Date.now()) {
        preAdmissionChallenges.delete(challenge.challengeId);
        return send(ws, { type: "adult_pre_admission_timeout", challengeId: message.challengeId });
      }
      if (!message.accepted) {
        preAdmissionChallenges.delete(challenge.challengeId);
        return send(ws, { type: "adult_pre_admission_declined", challengeId: message.challengeId });
      }
      preAdmissionChallenges.delete(challenge.challengeId);

      function admitPlayer() {
        if (challengeClient.roomCode) { send(ws, { type: "error", code: "ALREADY_IN_ROOM" }); return null; }
        if (targetRoom.players.size >= MAX_PLAYERS) { send(ws, { type: "error", code: "ROOM_FULL" }); return null; }
        challengeClient.roomCode = targetRoom.code;
        const player = {
          ...challengeClient,
          ws,
          reconnectToken: crypto.randomBytes(32).toString("base64url"),
          disconnectTimer: null,
          score: targetRoom.mode === "coop" ? targetRoom.teamScore : 0,
          words: [],
          found: new Set(),
          sessionWins: 0,
          sessionLosses: 0,
          sessionPoints: 0,
        };
        targetRoom.players.set(challengeClient.id, player);
        send(ws, {
          type: "adult_pre_admission_accepted",
          challengeId: challenge.challengeId,
          code: targetRoom.code,
          reconnectToken: player.reconnectToken,
        });
        send(ws, {
          type: "joined_room",
          code: targetRoom.code,
          reconnectToken: player.reconnectToken,
        });
        broadcast(targetRoom, state(targetRoom));
        return player;
      }

      const samePending = challenge.targetRequestId && targetRoom.pendingConsent?.requestId === challenge.targetRequestId;
      const sameActiveRound = challenge.targetRequestId && targetRoom.round?.adultConsentRequestId === challenge.targetRequestId;
      const sameActiveRoundById = !challenge.targetRequestId && challenge.roundId && targetRoom.round?.id === challenge.roundId;
      const sameFinishedResult = challenge.resultRoundId && targetRoom.lastResult?.roundId === challenge.resultRoundId;

      if (samePending) {
        const admitted = admitPlayer();
        if (!admitted) return;
        if (!targetRoom.pendingConsent.requiredPlayerIds.includes(challengeClient.id))
          targetRoom.pendingConsent.requiredPlayerIds.push(challengeClient.id);
        if (!targetRoom.pendingConsent.acceptedPlayerIds.includes(challengeClient.id))
          targetRoom.pendingConsent.acceptedPlayerIds.push(challengeClient.id);
        if (!targetRoom.pendingConsent.generating)
          await completeAdultConsent(targetRoom, challenge.targetRequestId);
        return;
      }
      if (sameActiveRound || sameActiveRoundById) {
        if (!isAdultRoom(targetRoom)) return admitNormalJoin();
        const admitted = admitPlayer();
        if (!admitted) return;
        targetRoom.round.consentedPlayerIds.push(challengeClient.id);
        return;
      }
      if (sameFinishedResult) {
        if (!isAdultLastResult(targetRoom)) return admitNormalJoin();
        const admitted = admitPlayer();
        if (!admitted) return;
        targetRoom.lastResult.consentedPlayerIds = targetRoom.lastResult.consentedPlayerIds || [];
        targetRoom.lastResult.consentedPlayerIds.push(challengeClient.id);
        return;
      }

      function admitNormalJoin() {
        if (challengeClient.roomCode) { send(ws, { type: "error", code: "ALREADY_IN_ROOM" }); return null; }
        if (targetRoom.players.size >= MAX_PLAYERS) { send(ws, { type: "error", code: "ROOM_FULL" }); return null; }
        challengeClient.roomCode = targetRoom.code;
        const player = {
          ...challengeClient,
          ws,
          reconnectToken: crypto.randomBytes(32).toString("base64url"),
          disconnectTimer: null,
          score: targetRoom.mode === "coop" ? targetRoom.teamScore : 0,
          words: [],
          found: new Set(),
          sessionWins: 0,
          sessionLosses: 0,
          sessionPoints: 0,
        };
        targetRoom.players.set(challengeClient.id, player);
        send(ws, {
          type: "joined_room",
          code: targetRoom.code,
          reconnectToken: player.reconnectToken,
        });
        broadcast(targetRoom, state(targetRoom));
        return player;
      }

      if (!targetRoom.pendingConsent && !isAdultRoom(targetRoom) && !isAdultLastResult(targetRoom)) {
        admitNormalJoin();
        return;
      }

      if (challenge.targetRequestId && challenge.targetRequestId !== targetRoom.pendingConsent?.requestId && challenge.targetRequestId !== targetRoom.round?.adultConsentRequestId) {
        createPreAdmissionChallenge(targetRoom, challengeClient, ws);
        return;
      }
      createPreAdmissionChallenge(targetRoom, challengeClient, ws);
      return;
    }
    const responseClient = clients.get(ws);
    if (!responseClient) return send(ws, { type: "error", code: "HELLO_REQUIRED" });
    const responseRoom = rooms.get(responseClient.roomCode);
    if (!responseRoom) return send(ws, { type: "error", code: "NOT_IN_ROOM" });
    const pending = responseRoom.pendingConsent;
    if (!pending || pending.requestId !== message.requestId)
      return send(ws, { type: "error", code: "CONSENT_MISMATCH" });
    if (!pending.requiredPlayerIds.includes(responseClient.id))
      return send(ws, { type: "error", code: "CONSENT_NOT_REQUIRED" });
    if (!message.accepted) {
      cancelPendingConsent(responseRoom, "player_declined");
      return;
    }
    if (!pending.acceptedPlayerIds.includes(responseClient.id))
      pending.acceptedPlayerIds.push(responseClient.id);
    broadcast(responseRoom, {
      type: "adult_consent_player_accepted",
      requestId: pending.requestId,
      playerId: responseClient.id,
      acceptedPlayerIds: pending.acceptedPlayerIds,
      requiredPlayerIds: pending.requiredPlayerIds,
    });
    await completeAdultConsent(responseRoom, pending.requestId);
    return;
  }
  if (type === "adult_consent_cancel") {
    const cancelClient = clients.get(ws);
    if (!cancelClient) return send(ws, { type: "error", code: "HELLO_REQUIRED" });
    const cancelRoom = rooms.get(cancelClient.roomCode);
    if (!cancelRoom) return send(ws, { type: "error", code: "NOT_IN_ROOM" });
    if (cancelClient.id !== cancelRoom.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
    if (cancelRoom.pendingConsent && cancelRoom.pendingConsent.requestId === message.requestId)
      cancelPendingConsent(cancelRoom, "host_cancelled");
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
    if (client.id === leavingRoom.creatorId)
      return send(ws, { type: "error", code: "CREATOR_MUST_END_SESSION" });
    if (
      leavingRoom.pendingConsent &&
      leavingRoom.pendingConsent.requiredPlayerIds.includes(client.id)
    )
      cancelPendingConsent(leavingRoom, "player_left");
    clearTimeout(leavingRoom.players.get(client.id)?.disconnectTimer);
    leavingRoom.players.delete(client.id);
    client.roomCode = null;
    send(ws, { type: "session_left" });
    broadcast(leavingRoom, state(leavingRoom));
    return;
  }
  if (type === "end_session") {
    if (client.id !== room.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
    closeRoom(room, "creator_ended");
    return;
  }
  if (type === "start_game") {
    if (client.id !== room.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
    if (room.generation)
      return send(ws, { type: "error", code: "BOARD_GENERATING" });
    if (room.status === "playing")
      return send(ws, { type: "error", code: "ROUND_PLAYING" });
    const requested = String(message.mode || "classic");
    const requestedDictionaryId = message.dictionaryId || room.dictionaryId || DEFAULT_DICTIONARY_ID;
    try {
      getDictionary(requestedDictionaryId);
    } catch (error) {
      return send(ws, {
        type: "error",
        code: error.message.startsWith("UNKNOWN_DICTIONARY_ID")
          ? "UNKNOWN_DICTIONARY_ID"
          : "DICTIONARY_ARTIFACT_INVALID",
        dictionaryId: requestedDictionaryId,
      });
    }
    if ("customWords" in message) {
      return send(ws, { type: "error", code: "CUSTOM_WORDS_REJECTED" });
    }
    if (Object.keys(message).some((field) => SERVER_GENERATION_POLICY_FIELDS.has(field)))
      return send(ws, { type: "error", code: "ROUND_GENERATION_POLICY_NOT_ALLOWED" });
    if (requested === "random") {
      if (room.pendingConsent)
        cancelPendingConsent(room, "configuration_changed");
      room.randomRush = true;
      room.randomModeQueue = [];
      return startRound(room, randomMode(room), null, null, null, requestedDictionaryId);
    }
    let config;
    if (requested === "custom") {
      const result = validateCustomConfig(message.config);
      if (!result.valid)
        return send(ws, { type: "error", code: "CUSTOM_CONFIG_INVALID", detail: result.error });
      config = result.config;
    } else {
      const preset = configForPreset(requested);
      if (!preset)
        return send(ws, { type: "error", code: "UNKNOWN_MODE" });
      config = preset;
    }
    if (usesAdultLexicon(config)) {
      if (room.pendingConsent)
        cancelPendingConsent(room, "configuration_changed");
      createPendingConsent(room, requested, config, requestedDictionaryId);
      return;
    }
    if (room.pendingConsent)
      cancelPendingConsent(room, "configuration_changed");
    room.randomRush = false;
    room.randomModeQueue = [];
    return startRound(room, requested, config, null, null, requestedDictionaryId);
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
    const roundId = room.round.id;
    room.round.timer = setTimeout(() => {
      if (
        rooms.get(room.code) !== room ||
        room.status !== "playing" ||
        room.round?.id !== roundId
      )
        return;
      finishRound(room, "timeout");
    }, roomConfig(room).seconds * 1000);
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
      word: message.word,
      path: message.path,
      board: room.round.board,
      size: room.round.size,
      mode: room.round.validationMode,
      dictionaryId: room.round.dictionaryId,
      minimum: roomConfig(room).min,
      found: requiresChain(roomConfig(room)) || room.mode === "coop"
        ? room.round.found
        : player.found,
    });
    const config = roomConfig(room);
    if (result.valid && requiresChain(config) &&
      !chainWordMatches(room.round.requiredLetter, result.word))
      result = { ...result, valid: false, reason: "chain", points: 0 };
    if (!result.valid) {
      console.warn("Wordrush rejected submission", JSON.stringify({
        wordLength: result.word.length,
        reason: result.reason,
        validationMode: room.round.validationMode,
        minimum: config.min,
      }));
      send(ws, {
        type: "word_rejected",
        playerId: client.id,
        word: result.word,
        reason: result.reason,
        minimum: config.min,
        ...(requiresChain(config)
          ? {
              requiredLetter: room.round.requiredLetter,
              chain: publicChainState(room.round),
            }
          : {}),
      });
      if (shouldEndOnRejectedWord(config, result.reason))
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
    if (requiresChain(config))
      advanceChainFields(room.round, result.word);
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
      ...(requiresChain(config) ? { chain: publicChainState(room.round) } : {}),
    });
    if (hasScoreTarget(roomConfig(room)) && player.score >= roomConfig(room).target)
      finishRound(room, "race");
    return;
  }
  if (type === "skip_round") {
    if (client.id !== room.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
    if (typeof message.roundId !== "string" || !message.roundId.trim())
      return send(ws, { type: "error", code: "ROUND_ID_REQUIRED" });
    if (room.status !== "playing" || !room.round)
      return send(ws, { type: "error", code: "ROUND_NOT_PLAYING" });
    if (message.roundId !== room.round.id)
      return send(ws, { type: "error", code: "ROUND_STALE" });
    finishRound(room, "skipped");
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
      "Cache-Control": staticCacheControl(pathname),
    });
    return res.end(JSON.stringify(getDictionary().words));
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
    "/trace-geometry.js",
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
    "Cache-Control": staticCacheControl(requested),
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
      Promise.resolve(handle(ws, JSON.parse(raw))).catch(() =>
        send(ws, { type: "error", code: "MESSAGE_HANDLER_FAILED" }),
      );
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
  prunePreAdmissionChallenges(now);
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
  startRound,
  boardGenerationContract,
  generateRoundBoard,
  generateProductionRoundBoard,
  selectRoundBoardForDevelopment,
  validateSoloBoardRequest,
  generationTestHooks,
  MAX_PLAYERS,
  displayTokens,
  displayCredentials,
  rateLimits,
  preAdmissionChallenges,
  clientIp,
  pruneExpiredRateLimits,
  heartbeatSocket,
  WS_HEARTBEAT_MISSES,
  isAdultRequest,
  isAdultRoom,
  isAdultLastResult,
  roomExposesAdultContent,
  createPendingConsent,
  cancelPendingConsent,
  completeAdultConsent,
  createPreAdmissionChallenge,
  cleanupPreAdmission,
  prunePreAdmissionChallenges,
  CONSENT_TIMEOUT_MS,
  CHALLENGE_TIMEOUT_MS,
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
function requestCancellation(req, res) {
  let cancelled = false;
  const cancel = () => {
    if (!res.writableEnded && !cancelled) {
      cancelled = true;
      generationTestHooks.onCancellation?.();
    }
  };
  req.once("aborted", cancel);
  res.once("close", cancel);
  req.socket?.once("close", cancel);
  return {
    isCancelled: () => cancelled || req.aborted === true || res.destroyed === true,
    cleanup: () => {
      req.off("aborted", cancel);
      res.off("close", cancel);
      req.socket?.off("close", cancel);
    },
  };
}
function readJson(req, isCancelled) {
  return new Promise((resolve) => {
    let body = "";
    let done = false;
    const abort = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      req.off("aborted", abort);
      req.off("error", abort);
      req.off("end", finish);
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve(null);
      }
    };
    if (isCancelled?.()) return resolve(null);
    req.once("aborted", abort);
    req.once("error", abort);
    req.on("data", (chunk) => {
      if (done) return;
      body += chunk;
      if (body.length > 10000) {
        done = true;
        cleanup();
        resolve(null);
      }
    });
    req.once("end", finish);
  });
}
async function leaderboardRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/solo-board" && req.method === "POST") {
    if (!rateLimit("solo-board:" + clientIp(req), 30))
      return deny(res, 429, "RATE_LIMITED");
    const cancellation = requestCancellation(req, res);
    try {
      const body = await readJson(req, cancellation.isCancelled);
      if (cancellation.isCancelled()) return true;
      const request = validateSoloBoardRequest(body);
      if (!request.valid)
        return deny(res, request.status || 400, request.code);
      const contract = boardGenerationContract(
        request.config,
        request.dictionary.id,
      );
      const result = await generateProductionRoundBoard(contract, {
        isCancelled: cancellation.isCancelled,
      });
      if (cancellation.isCancelled()) return true;
      const diagnostics = {
        ...result.diagnostics,
        dictionary: request.dictionary.metadata,
      };
      if (!result.ok) {
        if (result.error?.code !== "QUALITY_SELECTION_CANCELLED")
          console.warn("Wordrush solo quality board generation failed", JSON.stringify({
            failureCode: result.error?.code || "GENERATION_FAILED",
            diagnostics,
          }));
        res.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        return res.end(JSON.stringify({
          error: "BOARD_GENERATION_FAILED",
          failureCode: result.error?.code || "GENERATION_FAILED",
          diagnostics,
        }));
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify({
        board: result.board,
        mode: request.mode,
        config: request.config,
        validationMode: contract.validationMode,
        seed: result.requestedSeed,
        selectedCandidateSeed: result.selectedCandidateSeed,
        dictionary: request.dictionary.metadata,
        diagnostics,
        ...(request.config.chain
          ? { playableWordStarts: { ...result.report.playableWordStarts } }
          : {}),
      }));
    } finally {
      cancellation.cleanup();
    }
  }
  if (url.pathname === "/api/dictionary" && req.method === "GET") {
    const dictionaryId = url.searchParams.get("dictionaryId") || DEFAULT_DICTIONARY_ID;
    let dictionary;
    try {
      dictionary = getDictionary(dictionaryId);
    } catch (error) {
      const unknown = error.message.startsWith("UNKNOWN_DICTIONARY_ID");
      return deny(res, unknown ? 404 : 500, unknown ? "UNKNOWN_DICTIONARY_ID" : "DICTIONARY_ARTIFACT_INVALID");
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    });
    return res.end(JSON.stringify({ dictionary: dictionary.metadata, words: dictionary.words }));
  }
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
    const dictionaryId = url.searchParams.get("dictionaryId") || DEFAULT_DICTIONARY_ID;
    let valid;
    try {
      valid = isDictionaryWord(word, dictionaryId, mode);
    } catch (error) {
      const unknown = error.message.startsWith("UNKNOWN_DICTIONARY_ID");
      return deny(res, unknown ? 404 : 500, unknown ? "UNKNOWN_DICTIONARY_ID" : "DICTIONARY_ARTIFACT_INVALID");
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=86400",
    });
    return res.end(JSON.stringify({ valid }));
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
