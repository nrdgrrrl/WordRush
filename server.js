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
  isSuddenDeathSeries,
  shouldEndOnRejectedWord,
  RANDOM_RUSH_MODES,
} = require("./game-config");
const {
  createSuddenDeathOutcome,
  normalizeSuddenDeathOutcome,
} = require("./sudden-death-outcome");
const suddenDeathSeries = require("./sudden-death-series");
const {
  classifyMultiplayerParticipant,
  outcomeAccounting,
} = require("./round-outcome");
const {
  generateQualityRoundBoard,
} = require("./production-board-generator");
const {
  DailyChallengeStore,
  utcDateKey,
} = require("./daily-challenges");
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
  randomMode: null,
  yieldScheduler: null,
  requestedSeed: null,
  onContract: null,
  onResult: null,
  onCancellation: null,
};
const SUDDEN_SERIES_MODE = "sudden_series";
const dailyChallenges = new DailyChallengeStore();
const pendingDailyChallenges = new Map();
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
  if (mode === "daily")
    return { valid: false, code: "DAILY_CHALLENGE_REQUIRED" };
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
  if (isSuddenDeathSeries(config))
    return { valid: false, code: "MULTIPLAYER_ONLY_MODE" };
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

async function getTodayDailyChallenge() {
  const date = utcDateKey();
  const key = "daily-" + date;
  if (pendingDailyChallenges.has(key)) return pendingDailyChallenges.get(key);
  const pending = dailyChallenges.getOrCreateDaily(date, async ({ id, date: recordDate }) => {
    const config = configForPreset("daily");
    const dictionary = getDictionary(DEFAULT_DICTIONARY_ID);
    const contract = boardGenerationContract(config, dictionary.id);
    const result = await generateProductionRoundBoard(contract);
    if (!result.ok) {
      const error = new Error("DAILY_BOARD_GENERATION_FAILED");
      error.code = result.error?.code || "GENERATION_FAILED";
      error.diagnostics = {
        ...result.diagnostics,
        dictionary: dictionary.metadata,
      };
      throw error;
    }
    return {
      id,
      date: recordDate,
      mode: "daily",
      config: { ...config },
      board: [...result.board],
      dictionary: {
        dictionaryId: dictionary.id,
        artifactSha256: dictionary.metadata.artifactSha256,
      },
      quality: {
        requestedSeed: result.requestedSeed,
        selectedCandidateSeed: result.selectedCandidateSeed,
      },
      createdAt: new Date().toISOString(),
    };
  });
  pendingDailyChallenges.set(key, pending);
  try {
    return await pending;
  } finally {
    pendingDailyChallenges.delete(key);
  }
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
const ROUND_PARTICIPANT_RESERVED = "ROUND_PARTICIPANT_RESERVED";
function isDetachedRoundParticipant(room, playerId) {
  return Boolean(
    room.status === "playing" &&
      room.round?.participants?.has(playerId) &&
      !room.players.has(playerId),
  );
}
function rejectDetachedRoundParticipant(room, client, ws) {
  if (!isDetachedRoundParticipant(room, client.id)) return false;
  send(ws, { type: "error", code: ROUND_PARTICIPANT_RESERVED });
  return true;
}
function createPlayer(room, client, ws) {
  return {
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
}
function admitPlayerToRoom(room, client, ws) {
  if (rejectDetachedRoundParticipant(room, client, ws)) return null;
  const player = createPlayer(room, client, ws);
  room.players.set(client.id, player);
  if (room.status === "playing" && room.round)
    room.round.participants.set(client.id, player);
  return player;
}
function createPendingConsent(
  room,
  mode,
  config,
  dictionaryId = room.dictionaryId || DEFAULT_DICTIONARY_ID,
  options = {},
) {
  if (!config) return null;
  const adultConfig = { ...config, adult: true };
  const requestId = crypto.randomUUID();
  const expiresAt = Date.now() + CONSENT_TIMEOUT_MS;
  const connectedIds = [...room.players.values()]
    .filter((p) => p.ws?.readyState === 1)
    .map((p) => p.id);
  if (!connectedIds.length) return null;
  room.pendingConsent = {
    requestId,
    mode,
    config: adultConfig,
    dictionaryId,
    randomRush: options.randomRush === true,
    randomRushIncludeDirty: options.randomRushIncludeDirty === true,
    randomRushEpoch: options.randomRushEpoch ?? room.randomRushEpoch,
    sourceRoundId: options.sourceRoundId || null,
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
  return room.pendingConsent;
}
function pendingConsentContextIsCurrent(room, pending) {
  if (!pending) return false;
  if (!pending.randomRush)
    return room.status === "lobby" && room.round === null;
  if (
    !room.randomRush ||
    room.randomRushEpoch !== pending.randomRushEpoch
  )
    return false;
  if (!pending.sourceRoundId)
    return room.status === "lobby" && room.round === null;
  return Boolean(
    room.status === "finished" &&
      room.round?.id === pending.sourceRoundId &&
      room.lastResult?.roundId === pending.sourceRoundId &&
      !room.nextRound
  );
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
  if (pending.randomRush) resetRandomRush(room);
  broadcast(room, {
    type: "adult_consent_cancelled",
    requestId: pending.requestId,
    reason,
  });
  if (pending.randomRush) broadcast(room, state(room));
}
async function completeAdultConsent(room, requestId) {
  const pending = room.pendingConsent;
  if (
    !pending ||
    pending.requestId !== requestId ||
    !pendingConsentContextIsCurrent(room, pending) ||
    pending.generating
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
function publicSeriesState(room) {
  return suddenDeathSeries.publicSeries(room.suddenDeathSeries);
}
function publicRoomPlayers(room) {
  const series = room.suddenDeathSeries;
  if (!series || !["playing", "interstitial"].includes(series.phase))
    return [...room.players.values()];
  const activeIds = new Set(activeSeriesParticipants(room).map((player) => player.id));
  return [...room.players.values()].filter((player) => activeIds.has(player.id));
}
function state(room) {
  const publicPlayers = publicRoomPlayers(room);
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
    series: publicSeriesState(room),
    lastResult: room.status === "finished" ? room.lastResult : null,
    ...(room.status === "playing" && room.round?.config?.chain
      ? { chain: publicChainState(room.round) }
      : {}),
    players: publicPlayers.map((p) => ({
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
          seriesId: room.round.seriesId || null,
          seriesRoundNumber: room.round.seriesRoundNumber || null,
          dictionary: room.round.dictionary,
        }
      : null,
  };
}
function displayState(room) {
  const publicPlayers = publicRoomPlayers(room);
  return {
    code: room.code,
    mode: room.mode,
    dictionary: roomDictionaryMetadata(room),
    status: room.status,
    results: room.results,
    config: roomConfig(room),
    series: publicSeriesState(room),
    lastResult: room.status === "finished" ? room.lastResult : null,
    players: publicPlayers.map((p) => ({
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
          seriesId: room.round.seriesId || null,
          seriesRoundNumber: room.round.seriesRoundNumber || null,
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
function clearQueuedNextRound(room) {
  clearTimeout(room.rushTimer);
  room.rushTimer = null;
  room.nextRound = null;
  if (room.lastResult?.nextRound) delete room.lastResult.nextRound;
}
function clearRoomTimer(room) {
  clearTimeout(room.round?.timer);
  clearQueuedNextRound(room);
}
function closeRoom(room, reason) {
  clearRoomTimer(room);
  if (room.generation) {
    room.generation.cancelled = true;
    releaseSeriesGenerationWait(room.generation);
  }
  room.generation = null;
  if (room.pendingConsent) cancelPendingConsent(room, "room_closed");
  resetRandomRush(room);
  room.suddenDeathSeries = null;
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
const ROUND_INTRO_MS = 4000;
function randomRushModes(room) {
  return room.randomRushIncludeDirty
    ? [...RANDOM_RUSH_MODES, "dirty"]
    : [...RANDOM_RUSH_MODES];
}
function shuffledModes(room, previous = room.mode) {
  const modes = randomRushModes(room).filter((mode) => mode !== previous);
  for (let index = modes.length - 1; index > 0; index--) {
    const swap = crypto.randomInt(index + 1);
    [modes[index], modes[swap]] = [modes[swap], modes[index]];
  }
  if (randomRushModes(room).includes(previous)) modes.push(previous);
  return modes;
}
function randomMode(room, previous = room.mode) {
  if (!room.randomModeQueue.length) {
    const forced = generationTestHooks.randomMode?.({
      pool: randomRushModes(room),
      previous,
      room,
    });
    room.randomModeQueue = forced && randomRushModes(room).includes(forced)
      ? [forced]
      : shuffledModes(room, previous);
  }
  return room.randomModeQueue.shift();
}
function resetRandomRush(room) {
  clearQueuedNextRound(room);
  room.randomRush = false;
  room.randomRushIncludeDirty = false;
  room.randomModeQueue = [];
  room.randomRushEpoch += 1;
}
function seriesParticipant(room, playerId) {
  return suddenDeathSeries.participant(room.suddenDeathSeries, playerId);
}
function activeSeriesParticipants(room) {
  return suddenDeathSeries.activeParticipants(room.suddenDeathSeries);
}
function connectedSeriesRoster(room) {
  return [...room.players.values()]
    .filter((player) => player.ws?.readyState === 1)
    .map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar || "🐈",
      session: {
        wins: player.sessionWins,
        losses: player.sessionLosses,
        points: player.sessionPoints,
      },
    }));
}
function removeExcludedSeriesSeats(room, roster) {
  const rosterIds = new Set(roster.map((player) => player.id));
  for (const [id, player] of room.players) {
    if (rosterIds.has(id) || player.ws?.readyState === 1) continue;
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    for (const client of clients.values()) {
      if (client.id === id && client.roomCode === room.code)
        client.roomCode = null;
    }
    room.players.delete(id);
  }
}
function releaseSeriesGenerationWait(generation) {
  generation?.transitionWaitResolve?.();
}
function seriesGenerationMatches(room, generation) {
  const series = room.suddenDeathSeries;
  if (!generation?.seriesId) return true;
  return Boolean(
    series &&
    series.id === generation.seriesId &&
    (series.currentRoundNumber === 1
      ? series.phase === "playing"
      : series.phase === "interstitial" &&
        series.transitionId === generation.seriesTransitionId),
  );
}
function waitForSeriesDeadline(room, generation) {
  const series = room.suddenDeathSeries;
  const delay = Math.max(0, Number(series?.nextRoundAt || 0) - Date.now());
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => {
    const release = () => {
      clearTimeout(generation.transitionWaitTimer);
      generation.transitionWaitTimer = null;
      generation.transitionWaitResolve = null;
      resolve();
    };
    generation.transitionWaitResolve = release;
    generation.transitionWaitTimer = setTimeout(release, delay);
    generation.transitionWaitTimer.unref?.();
  });
}
function resetPlayersForLobby(room) {
  for (const player of room.players.values()) {
    player.score = 0;
    player.words = [];
    player.found = new Set();
  }
}
function cancelSuddenDeathSeries(room, reason) {
  const series = room.suddenDeathSeries;
  if (!series) return false;
  suddenDeathSeries.cancelSeries(series, reason);
  if (room.generation?.seriesId === series.id) {
    room.generation.cancelled = true;
    releaseSeriesGenerationWait(room.generation);
  }
  clearTimeout(room.round?.timer);
  room.round = null;
  room.generation = null;
  room.suddenDeathSeries = null;
  room.status = "lobby";
  room.mode = "classic";
  room.config = MODE_CONFIG.classic;
  room.lastResult = null;
  room.results = { view: "static", speed: "medium" };
  room.teamScore = 0;
  resetPlayersForLobby(room);
  broadcast(room, {
    type: "series_cancelled",
    seriesId: series.id,
    reason: String(reason || "cancelled"),
  });
  broadcast(room, state(room));
  return true;
}
function withdrawSeriesParticipant(room, playerId, reason = "withdrawn") {
  const series = room.suddenDeathSeries;
  if (!series || series.phase === "finished") return false;
  if (!suddenDeathSeries.withdrawParticipant(series, playerId)) return false;
  const player = room.players.get(playerId);
  clearTimeout(player?.disconnectTimer);
  if (player) {
    const playerClient = clients.get(player.ws);
    if (playerClient) playerClient.roomCode = null;
  }
  room.players.delete(playerId);
  if (activeSeriesParticipants(room).length < suddenDeathSeries.MIN_PLAYERS)
    return cancelSuddenDeathSeries(room, "insufficient_players");
  broadcast(room, {
    type: "series_participant_withdrawn",
    seriesId: series.id,
    participantId: playerId,
    reason,
    series: publicSeriesState(room),
  });
  broadcast(room, state(room));
  return true;
}
function seriesRankedParticipants(series) {
  return suddenDeathSeries.rankParticipants(series.participants);
}
function seriesSessionSnapshot(room, participant) {
  const player = room.players.get(participant.id);
  const session = player
    ? {
        wins: player.sessionWins,
        losses: player.sessionLosses,
        points: player.sessionPoints,
      }
    : participant.session;
  return {
    wins: Math.max(0, Math.floor(Number(session?.wins) || 0)),
    losses: Math.max(0, Math.floor(Number(session?.losses) || 0)),
    points: Math.max(0, Number(session?.points) || 0),
  };
}
function recordSuddenDeathSeriesAccounting(room, series) {
  if (series.accountingRecorded) return false;
  series.accountingRecorded = true;
  const authoritativeRanking = series.participants.map((participant) => ({
    id: participant.id,
    score: participant.aggregateScore,
    series: { status: participant.status },
  }));
  const entries = [];
  for (const participant of series.participants) {
    if (participant.status !== "active") continue;
    const player = room.players.get(participant.id);
    if (!player) continue;
    const outcome = classifyMultiplayerParticipant({
      participantId: participant.id,
      ranking: authoritativeRanking,
      series: { winnerIds: series.winnerIds },
      seriesComplete: true,
      recorded: true,
    });
    const deltas = outcomeAccounting(outcome, { multiplayer: true });
    player.sessionPoints += participant.aggregateScore;
    player.sessionWins += deltas.multiplayerWins;
    player.sessionLosses += deltas.multiplayerLosses;
    const words = participant.acceptedWords || [];
    entries.push({
      id: participant.id,
      name: participant.name,
      avatar: participant.avatar,
      score: participant.aggregateScore,
      words: participant.acceptedWordCount,
      correct: participant.acceptedWordCount,
      incorrect: participant.strikes,
      longest: Math.max(0, ...words.map((item) => item.word.length)),
      totalWordLength: words.reduce((sum, item) => sum + item.word.length, 0),
      gameSeconds: participant.gameplaySeconds,
      multiplayer: true,
      multiplayerOutcome: outcome,
    });
  }
  if (entries.length) {
    recordLeaderboardScores(() => entries, room.round?.id || series.id);
  }
  return true;
}
function seriesResultRanking(room, series) {
  return seriesRankedParticipants(series).map((participant) => ({
    id: participant.id,
    name: participant.name,
    avatar: participant.avatar,
    score: participant.aggregateScore,
    words: participant.acceptedWords.map((word) => ({ ...word })),
    session: seriesSessionSnapshot(room, participant),
    series: {
      status: participant.status,
      strikes: participant.strikes,
      acceptedWordCount: participant.acceptedWordCount,
      gameplaySeconds: participant.gameplaySeconds,
    },
  }));
}
function completeSuddenDeathSeries(room, series, lastRound) {
  suddenDeathSeries.finalizeSeries(series);
  recordSuddenDeathSeriesAccounting(room, series);
  room.status = "finished";
  room.round = null;
  const active = activeSeriesParticipants(room);
  const result = {
    roundId: lastRound.roundId,
    seriesId: series.id,
    accountingId: series.accountingId,
    resultId: series.resultId,
    seriesComplete: true,
    gameSeconds: active.length
      ? Math.max(...active.map((player) => player.gameplaySeconds))
      : 0,
    cooperative: false,
    randomRush: false,
    teamScore: 0,
    stats: {
      wordsFound: series.participants.reduce(
        (total, player) => total + player.acceptedWordCount,
        0,
      ),
      rounds: series.totalRounds,
    },
    results: room.results,
    reason: "series_complete",
    suddenDeath: null,
    dictionary: roomDictionaryMetadata(room),
    series: publicSeriesState(room),
    ranking: seriesResultRanking(room, series),
  };
  room.lastResult = result;
  broadcast(room, { type: "round_finished", ...result });
  return result;
}
function settleSuddenDeathSeriesRound(
  room,
  reason = "complete",
  loserId = null,
  rejectedWord = "",
) {
  const series = room.suddenDeathSeries;
  const round = room.round;
  if (
    !series ||
    series.phase !== "playing" ||
    !round ||
    round.seriesId !== series.id
  )
    return false;
  const transitionId = crypto.randomUUID();
  const nextRoundAt = Date.now() + suddenDeathSeries.INTERSTITIAL_MS;
  const recorded = suddenDeathSeries.recordRound(series, {
    roundNumber: round.seriesRoundNumber,
    roundId: round.id,
    reason,
    loserId,
    rejectedWord,
    gameplaySeconds: Math.min(
      round.config.seconds,
      Math.max(0, (Date.now() - round.startedAt) / 1000),
    ),
    participantIds: round.seriesParticipantIds,
    transitionId,
    nextRoundAt,
  });
  if (!recorded) return false;
  clearTimeout(round.timer);
  const completedRound = series.history.at(-1);
  room.round = null;
  if (series.phase === "finished")
    return completeSuddenDeathSeries(room, series, completedRound);
  series.currentRoundNumber = round.seriesRoundNumber + 1;
  if (activeSeriesParticipants(room).length < suddenDeathSeries.MIN_PLAYERS)
    return cancelSuddenDeathSeries(room, "insufficient_players");
  broadcast(room, {
    type: "series_round_finished",
    seriesId: series.id,
    roundId: round.id,
    roundNumber: round.seriesRoundNumber,
    nextRoundNumber: series.currentRoundNumber,
    totalRounds: series.totalRounds,
    reason,
    loser: loserId
      ? (() => {
          const loser = seriesParticipant(room, loserId);
          return loser ? { id: loser.id, name: loser.name, avatar: loser.avatar } : null;
        })()
      : null,
    rejectedWord: completedRound.rejectedWord,
    nextRoundAt,
    series: publicSeriesState(room),
  });
  void startRound(
    room,
    SUDDEN_SERIES_MODE,
    configForPreset(SUDDEN_SERIES_MODE),
    null,
    null,
    room.dictionaryId,
  );
  return true;
}
function retireFinishedRoundForReplacement(room) {
  if (room.status !== "finished") return false;
  clearRoomTimer(room);
  if (room.pendingConsent) cancelPendingConsent(room, "configuration_changed");
  else resetRandomRush(room);
  room.round = null;
  room.lastResult = null;
  room.suddenDeathSeries = null;
  room.status = "lobby";
  room.mode = "classic";
  room.config = MODE_CONFIG.classic;
  room.results = { view: "static", speed: "medium" };
  room.teamScore = 0;
  for (const player of room.players.values()) {
    player.score = 0;
    player.words = [];
    player.found = new Set();
  }
  return true;
}
function generationFailure(room, generation, result) {
  if (room.generation !== generation) return false;
  room.generation = null;
  releaseSeriesGenerationWait(generation);
  if (
    room.randomRush &&
    !generation.consentRequestId &&
    generation.randomRushEpoch === room.randomRushEpoch
  )
    resetRandomRush(room);
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
  if (generation.seriesId && room.suddenDeathSeries?.id === generation.seriesId)
    return cancelSuddenDeathSeries(room, "generation_failed");
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
  const requestedSeed = options.requestedSeed ??
    generationTestHooks.requestedSeed ??
    crypto.randomInt(0x100000000);
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
  const series = room.suddenDeathSeries;
  const seriesRoundNumber = series?.currentRoundNumber || null;
  const seriesTransitionId = series?.transitionId || null;
  if (series && !seriesGenerationMatches(room, {
    seriesId: series.id,
    seriesTransitionId,
  }))
    return false;
  const pendingConsent = consentRequestId
    ? room.pendingConsent?.requestId === consentRequestId
      ? room.pendingConsent
      : null
    : null;
  if (consentRequestId && !pendingConsentContextIsCurrent(room, pendingConsent))
    return false;
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
    randomRushEpoch: room.randomRushEpoch,
    seriesId: series?.id || null,
    seriesTransitionId,
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
    if (room.generation === generation) room.generation = null;
    return false;
  }
  if (room.generation !== generation) return false;
  if (!seriesGenerationMatches(room, generation)) {
    generation.cancelled = true;
    return false;
  }
  if (
    consentRequestId &&
    (!pendingConsentContextIsCurrent(room, room.pendingConsent) ||
      room.pendingConsent?.requestId !== consentRequestId)
  )
    return generationFailure(room, generation, {
      ok: false,
      error: { code: "CONSENT_INVALIDATED" },
      diagnostics: result?.diagnostics,
    });
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
  if (generation.seriesId && generation.seriesTransitionId) {
    await waitForSeriesDeadline(room, generation);
    if (
      generation.cancelled ||
      room.generation !== generation ||
      !seriesGenerationMatches(room, generation)
    ) {
      room.generation = null;
      return false;
    }
  }
  room.generation = null;
  if (consentRequestId && room.pendingConsent?.requestId === consentRequestId) {
    clearTimeout(room.pendingConsent.timer);
    room.pendingConsent = null;
  }
  room.mode = selected;
  room.config = config;
  room.dictionaryId = dictionary.id;
  const introDuration = series ? seriesRoundNumber === 1 ? ROUND_INTRO_MS : 0 : ROUND_INTRO_MS;
  if (series && seriesTransitionId) {
    series.phase = "playing";
    series.transitionId = null;
    series.nextRoundAt = null;
  }
  const seriesRoundPlayers = series
    ? series.participants
      .filter((participant) => participant.status === "active")
      .map((participant) => [participant.id, room.players.get(participant.id)])
      .filter(([, player]) => player)
    : null;
  const introEndsAt = Date.now() + introDuration;
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
    participants: series ? new Map(seriesRoundPlayers) : new Map(room.players),
    seriesId: series?.id || null,
    seriesRoundNumber,
    seriesParticipantIds: series
      ? seriesRoundPlayers.map(([id]) => id)
      : [],
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
  }, introDuration + config.seconds * 1000);
  room.round.timer.unref?.();
  broadcast(room, { ...state(room), type: "round_started", config });
  return true;
}
function queuedNextRoundError(room, sourceRoundId, expectedRandomRushEpoch = null) {
  if (typeof sourceRoundId !== "string" || !sourceRoundId.trim())
    return "ROUND_ID_REQUIRED";
  if (
    !room ||
    rooms.get(room.code) !== room ||
    !room.randomRush ||
    room.status !== "finished" ||
    !room.round ||
    !room.lastResult ||
    !room.nextRound
  )
    return "NEXT_ROUND_UNAVAILABLE";
  if (
    sourceRoundId !== room.lastResult.roundId ||
    sourceRoundId !== room.round.id ||
    room.nextRound.sourceRoundId !== sourceRoundId ||
    room.lastResult.nextRound?.sourceRoundId !== sourceRoundId ||
    room.lastResult.nextRound?.mode !== room.nextRound.mode ||
    room.lastResult.nextRound?.automaticAt !== room.nextRound.automaticAt
  )
    return "ROUND_STALE";
  if (
    expectedRandomRushEpoch !== null &&
    expectedRandomRushEpoch !== room.randomRushEpoch
  )
    return "ROUND_STALE";
  if (room.generation) return "BOARD_GENERATING";
  return null;
}
async function startQueuedNextRound(
  room,
  sourceRoundId,
  expectedRandomRushEpoch = null,
) {
  if (queuedNextRoundError(room, sourceRoundId, expectedRandomRushEpoch))
    return false;
  const queued = room.nextRound;
  const randomRushEpoch = room.randomRushEpoch;
  clearQueuedNextRound(room);
  if (queued.mode === "dirty") {
    broadcast(room, state(room));
    const pending = createPendingConsent(
      room,
      queued.mode,
      configForPreset(queued.mode),
      room.dictionaryId,
      {
        randomRush: true,
        randomRushIncludeDirty: room.randomRushIncludeDirty,
        randomRushEpoch,
        sourceRoundId: queued.sourceRoundId,
      },
    );
    if (!pending) {
      resetRandomRush(room);
      broadcast(room, state(room));
    }
    return Boolean(pending);
  }
  const started = await startRound(room, queued.mode);
  if (!started && rooms.get(room.code) === room && room.status === "finished")
    broadcast(room, state(room));
  return started;
}
function scheduleQueuedNextRound(room, nextRound) {
  clearTimeout(room.rushTimer);
  const delay = Math.max(0, nextRound.automaticAt - Date.now());
  const randomRushEpoch = room.randomRushEpoch;
  room.rushTimer = setTimeout(() => {
    room.rushTimer = null;
    void startQueuedNextRound(room, nextRound.sourceRoundId, randomRushEpoch);
  }, delay);
  room.rushTimer.unref?.();
}
function finishRound(room, reason = "complete", suddenDeath = null) {
  if (!room.round || room.status !== "playing") return;
  if (room.suddenDeathSeries?.phase === "playing")
    return settleSuddenDeathSeriesRound(
      room,
      reason === "skipped" ? "host_skip" : reason,
      suddenDeath?.loser?.id || null,
      suddenDeath?.rejectedWord || "",
    );
  clearTimeout(room.round.timer);
  room.status = "finished";
  const recorded = reason !== "skipped";
  const suddenDeathOutcome = normalizeSuddenDeathOutcome(suddenDeath);
  for (const player of room.round.participants.values())
    player.score = playerScore(room, player);
  const participantOrder = new Map(
    [...room.round.participants.keys()].map((id, index) => [id, index]),
  );
  const rankedPlayers = [...room.round.participants.values()].sort(
    (a, b) =>
      b.score - a.score || participantOrder.get(a.id) - participantOrder.get(b.id),
  );
  const authoritativeRanking = rankedPlayers.map((player) => ({
    id: player.id,
    score: player.score,
  }));
  const outcomes = new Map(
    authoritativeRanking.map(({ id }) => [
      id,
      classifyMultiplayerParticipant({
        participantId: id,
        ranking: authoritativeRanking,
        cooperative: room.mode === "coop",
        suddenDeath: reason === "invalid_word" ? suddenDeathOutcome : null,
        reason,
        recorded,
      }),
    ]),
  );
  if (recorded) {
    rankedPlayers.forEach((player) => {
      player.sessionPoints += player.score;
      const deltas = outcomeAccounting(outcomes.get(player.id), {
        multiplayer: true,
      });
      player.sessionWins += deltas.multiplayerWins;
      player.sessionLosses += deltas.multiplayerLosses;
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
    suddenDeath: suddenDeathOutcome,
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
  if (room.randomRush) {
    const nextRound = {
      sourceRoundId: result.roundId,
      mode: randomMode(room),
      automaticAt: Date.now() + RANDOM_RUSH_DELAY,
    };
    room.nextRound = nextRound;
    result.nextRound = nextRound;
  } else {
    room.nextRound = null;
  }
  room.lastResult = result;
  if (recorded) {
    recordLeaderboardScores(
      () => result.ranking.map((rankedPlayer) => {
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
          multiplayerOutcome: outcomes.get(rankedPlayer.id) || "neutral",
        };
      }),
      result.roundId,
    );
  }
  broadcast(room, { type: "round_finished", ...result });
  if (result.nextRound) scheduleQueuedNextRound(room, result.nextRound);
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
  if (
    room.suddenDeathSeries &&
    ["playing", "interstitial"].includes(room.suddenDeathSeries.phase)
  ) {
    withdrawSeriesParticipant(room, player.id, "expired");
    return;
  }
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
    const frozenIdentity = room?.suddenDeathSeries
      ? seriesParticipant(room, client.id)
      : null;
    const player = room?.players.get(client.id);
    if (!room)
      return send(ws, { type: "error", code: "RESUME_FAILED" });
    if (frozenIdentity?.status === "withdrawn")
      return send(ws, { type: "error", code: "SERIES_PARTICIPANT_WITHDRAWN" });
    if (!player || player.reconnectToken !== message.reconnectToken)
      return send(ws, {
        type: "error",
        code: room.suddenDeathSeries &&
          ["playing", "interstitial"].includes(room.suddenDeathSeries.phase) &&
          !frozenIdentity
          ? "SERIES_ROSTER_FROZEN"
          : "RESUME_FAILED",
      });
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
    if (frozenIdentity) {
      client.name = frozenIdentity.name;
      client.avatar = frozenIdentity.avatar;
    }
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
      randomRushIncludeDirty: false,
      randomRushEpoch: 0,
      randomModeQueue: [],
      suddenDeathSeries: null,
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
      nextRound: null,
    };
    rooms.set(room.code, room);
    client.roomCode = room.code;
    room.creatorId = client.id;
    client.name = cleanText(message.name, client.name);
    client.avatar = cleanText(message.avatar, client.avatar || "🐈", 2);
    const player = admitPlayerToRoom(room, client, ws);
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
    const activeSeries = room.suddenDeathSeries &&
      ["playing", "interstitial"].includes(room.suddenDeathSeries.phase);
    const frozenIdentity = room.suddenDeathSeries
      ? seriesParticipant(room, client.id)
      : null;
    if (activeSeries && !frozenIdentity)
      return send(ws, { type: "error", code: "SERIES_ROSTER_FROZEN" });
    if (existingPlayer) {
      if (room.suddenDeathSeries && seriesParticipant(room, client.id)?.status === "withdrawn")
        return send(ws, { type: "error", code: "SERIES_PARTICIPANT_WITHDRAWN" });
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
      if (frozenIdentity) {
        client.name = frozenIdentity.name;
        client.avatar = frozenIdentity.avatar;
      }
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
    if (
      room.suddenDeathSeries &&
      ["playing", "interstitial"].includes(room.suddenDeathSeries.phase)
    ) {
      return send(ws, {
        type: "error",
        code: seriesParticipant(room, client.id)?.status === "withdrawn"
          ? "SERIES_PARTICIPANT_WITHDRAWN"
          : "SERIES_ROSTER_FROZEN",
      });
    }
    if (rejectDetachedRoundParticipant(room, client, ws)) return;
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
    const player = admitPlayerToRoom(room, client, ws);
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
        if (
          targetRoom.suddenDeathSeries &&
          ["playing", "interstitial"].includes(targetRoom.suddenDeathSeries.phase)
        ) {
          const frozenIdentity = seriesParticipant(targetRoom, challengeClient.id);
          send(ws, {
            type: "error",
            code: frozenIdentity?.status === "withdrawn"
              ? "SERIES_PARTICIPANT_WITHDRAWN"
              : "SERIES_ROSTER_FROZEN",
          });
          return null;
        }
        if (rejectDetachedRoundParticipant(targetRoom, challengeClient, ws)) return null;
        if (targetRoom.players.size >= MAX_PLAYERS) { send(ws, { type: "error", code: "ROOM_FULL" }); return null; }
        challengeClient.roomCode = targetRoom.code;
        const player = admitPlayerToRoom(targetRoom, challengeClient, ws);
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
        if (rejectDetachedRoundParticipant(targetRoom, challengeClient, ws)) return null;
        if (targetRoom.players.size >= MAX_PLAYERS) { send(ws, { type: "error", code: "ROOM_FULL" }); return null; }
        challengeClient.roomCode = targetRoom.code;
        const player = admitPlayerToRoom(targetRoom, challengeClient, ws);
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
      if (
        identityRoom.suddenDeathSeries &&
        ["playing", "interstitial"].includes(identityRoom.suddenDeathSeries.phase)
      )
        return broadcast(identityRoom, state(identityRoom));
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
      leavingRoom.suddenDeathSeries &&
      ["playing", "interstitial"].includes(leavingRoom.suddenDeathSeries.phase)
    ) {
      withdrawSeriesParticipant(leavingRoom, client.id, "left");
      client.roomCode = null;
      send(ws, { type: "session_left" });
      return;
    }
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
  if (type === "cancel_series") {
    if (client.id !== room.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
    const series = room.suddenDeathSeries;
    if (!series || !["playing", "interstitial"].includes(series.phase))
      return send(ws, { type: "error", code: "SERIES_NOT_ACTIVE" });
    if (typeof message.seriesId !== "string" || !message.seriesId)
      return send(ws, { type: "error", code: "SERIES_ID_REQUIRED" });
    if (message.seriesId !== series.id)
      return send(ws, { type: "error", code: "SERIES_STALE" });
    cancelSuddenDeathSeries(room, "host_cancelled");
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
    const hasRandomRushEligibility = Object.prototype.hasOwnProperty.call(
      message,
      "randomRushIncludeDirty",
    );
    if (
      hasRandomRushEligibility &&
      typeof message.randomRushIncludeDirty !== "boolean"
    )
      return send(ws, {
        type: "error",
        code: "RANDOM_RUSH_ELIGIBILITY_INVALID",
      });
    if (hasRandomRushEligibility && requested !== "random")
      return send(ws, {
        type: "error",
        code: "RANDOM_RUSH_ELIGIBILITY_NOT_ALLOWED",
      });
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
    if (requested === SUDDEN_SERIES_MODE) {
      const roster = connectedSeriesRoster(room);
      if (roster.length < suddenDeathSeries.MIN_PLAYERS)
        return send(ws, {
          type: "error",
          code: "SERIES_REQUIRES_MULTIPLAYER",
          minimumPlayers: suddenDeathSeries.MIN_PLAYERS,
        });
      if (room.status === "finished") {
        retireFinishedRoundForReplacement(room);
        broadcast(room, state(room));
      }
      removeExcludedSeriesSeats(room, roster);
      if (room.pendingConsent) cancelPendingConsent(room, "configuration_changed");
      clearQueuedNextRound(room);
      room.randomRush = false;
      room.randomRushIncludeDirty = false;
      room.randomRushEpoch += 1;
      room.randomModeQueue = [];
      const seriesId = crypto.randomUUID();
      room.suddenDeathSeries = suddenDeathSeries.createSuddenDeathSeries(roster, {
        id: seriesId,
        accountingId: seriesId,
      });
      const started = await startRound(
        room,
        SUDDEN_SERIES_MODE,
        configForPreset(SUDDEN_SERIES_MODE),
        null,
        null,
        requestedDictionaryId,
      );
      if (!started && room.suddenDeathSeries?.id === seriesId)
        cancelSuddenDeathSeries(room, "generation_failed");
      return started;
    }
    if (requested === "random") {
      const includeDirty = message.randomRushIncludeDirty === true;
      const previousMode = room.mode;
      if (room.status === "finished") {
        retireFinishedRoundForReplacement(room);
        broadcast(room, state(room));
      } else {
        if (
          room.pendingConsent?.randomRush &&
          room.pendingConsent.randomRushIncludeDirty === includeDirty
        )
          return send(ws, { type: "error", code: "CONSENT_PENDING" });
        if (room.pendingConsent)
          cancelPendingConsent(room, "configuration_changed");
        clearQueuedNextRound(room);
      }
      room.randomRush = true;
      room.randomRushIncludeDirty = includeDirty;
      room.randomRushEpoch += 1;
      room.randomModeQueue = [];
      const selected = randomMode(room, previousMode);
      if (selected === "dirty") {
        const pending = createPendingConsent(
          room,
          selected,
          configForPreset(selected),
          requestedDictionaryId,
          {
            randomRush: true,
            randomRushIncludeDirty: includeDirty,
            randomRushEpoch: room.randomRushEpoch,
          },
        );
        if (!pending) {
          resetRandomRush(room);
          broadcast(room, state(room));
        }
        return;
      }
      return startRound(room, selected, null, null, null, requestedDictionaryId);
    }
    if (room.status === "finished" && room.suddenDeathSeries) {
      retireFinishedRoundForReplacement(room);
      broadcast(room, state(room));
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
      clearQueuedNextRound(room);
      room.randomRush = false;
      room.randomRushIncludeDirty = false;
      room.randomRushEpoch += 1;
      room.randomModeQueue = [];
      createPendingConsent(room, requested, config, requestedDictionaryId);
      return;
    }
    if (room.pendingConsent)
      cancelPendingConsent(room, "configuration_changed");
    clearQueuedNextRound(room);
    room.randomRush = false;
    room.randomRushIncludeDirty = false;
    room.randomRushEpoch += 1;
    room.randomModeQueue = [];
    return startRound(room, requested, config, null, null, requestedDictionaryId);
  }
  if (type === "start_next_round") {
    if (client.id !== room.creatorId)
      return send(ws, { type: "error", code: "CREATOR_ONLY" });
    if (Object.prototype.hasOwnProperty.call(message, "mode"))
      return send(ws, { type: "error", code: "NEXT_ROUND_MODE_NOT_ALLOWED" });
    const failure = queuedNextRoundError(room, message.sourceRoundId);
    if (failure) return send(ws, { type: "error", code: failure });
    await startQueuedNextRound(room, message.sourceRoundId);
    return;
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
    if (room.status !== "playing" || !room.round) {
      if (
        room.suddenDeathSeries &&
        room.suddenDeathSeries.phase === "interstitial"
      )
        return send(ws, { type: "error", code: "ROUND_STALE" });
      return send(ws, { type: "error", code: "ROUND_NOT_PLAYING" });
    }
    if (
      room.suddenDeathSeries &&
      (room.round.seriesId !== room.suddenDeathSeries.id ||
        room.suddenDeathSeries.phase !== "playing" ||
        message.roundId !== room.round.id)
    )
      return send(ws, { type: "error", code: "ROUND_STALE" });
    const now = Date.now();
    if (now < room.round.startedAt)
      return send(ws, { type: "error", code: "ROUND_NOT_STARTED" });
    if (now >= room.round.endsAt) return finishRound(room, "timeout");
    const player = room.players.get(client.id);
    if (!player) return send(ws, { type: "error", code: "SERIES_PARTICIPANT_WITHDRAWN" });
    if (room.suddenDeathSeries && seriesParticipant(room, client.id)?.status !== "active")
      return send(ws, { type: "error", code: "SERIES_PARTICIPANT_WITHDRAWN" });
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
      if (shouldEndOnRejectedWord(config, result.reason)) {
        if (room.suddenDeathSeries)
          settleSuddenDeathSeriesRound(room, "invalid_word", player.id, result.word);
        else
          finishRound(room, "invalid_word", createSuddenDeathOutcome({
            loser: player,
            participants: [...room.round.participants.values()],
            word: result.word,
          }));
      }
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
    if (room.suddenDeathSeries)
      suddenDeathSeries.recordAcceptedWord(
        room.suddenDeathSeries,
        player.id,
        result.word,
        result.points,
      );
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
        connected: p.ws?.readyState === 1,
      })),
      ...(room.suddenDeathSeries
        ? { series: publicSeriesState(room) }
        : {}),
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
    if (
      room.suddenDeathSeries &&
      room.suddenDeathSeries.phase === "interstitial"
    )
      return send(ws, { type: "error", code: "ROUND_STALE" });
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
    "/sudden-death-outcome.js",
    "/sudden-death-series.js",
    "/round-outcome.js",
    "/profile-migration.js",
    "/play-streak.js",
    "/multiplayer-result-state.js",
    "/multiplayer-word-reconciliation.js",
    "/multiplayer-player-presentation.js",
    "/cooperative-results.js",
    "/round-timing.js",
    "/challenge-rules.js",
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
  getTodayDailyChallenge,
  dailyChallenges,
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
  randomRushModes,
  startQueuedNextRound,
  createPreAdmissionChallenge,
  cleanupPreAdmission,
  prunePreAdmissionChallenges,
  CONSENT_TIMEOUT_MS,
  CHALLENGE_TIMEOUT_MS,
  ROUND_PARTICIPANT_RESERVED,
  SUDDEN_SERIES_MODE,
  cancelSuddenDeathSeries,
  settleSuddenDeathSeriesRound,
  completeSuddenDeathSeries,
};

const { Leaderboard } = require("./leaderboard");
const leaderboard = new Leaderboard();
let leaderboardSaveFailure = null;
let leaderboardSaveRetryTimer = null;
let leaderboardSaveRetryAttempt = 0;
const LEADERBOARD_SAVE_RETRY_BASE_MS = 1_000;
const LEADERBOARD_SAVE_RETRY_MAX_MS = 30_000;
function boundedLeaderboardLogValue(value, fallback, max = 80) {
  const text = String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (text || fallback).slice(0, max);
}
function clearLeaderboardSaveRetry() {
  if (leaderboardSaveRetryTimer) clearTimeout(leaderboardSaveRetryTimer);
  leaderboardSaveRetryTimer = null;
  leaderboardSaveRetryAttempt = 0;
}
function markLeaderboardPersistenceRecovered(roundId) {
  if (!leaderboardSaveFailure) return;
  console.info(
    "Leaderboard persistence recovered: code=" +
      leaderboardSaveFailure.code +
      " roundId=" +
      boundedLeaderboardLogValue(roundId || leaderboardSaveFailure.roundId, "unknown"),
  );
  leaderboardSaveFailure = null;
  clearLeaderboardSaveRetry();
}
function scheduleLeaderboardSaveRetry() {
  if (leaderboardSaveRetryTimer) return;
  const delay = Math.min(
    LEADERBOARD_SAVE_RETRY_BASE_MS * 2 ** leaderboardSaveRetryAttempt,
    LEADERBOARD_SAVE_RETRY_MAX_MS,
  );
  leaderboardSaveRetryAttempt += 1;
  leaderboardSaveRetryTimer = setTimeout(() => {
    leaderboardSaveRetryTimer = null;
    try {
      leaderboard.save();
      markLeaderboardPersistenceRecovered();
    } catch (error) {
      recordLeaderboardPersistenceFailure(error, leaderboardSaveFailure?.roundId);
    }
  }, delay);
  leaderboardSaveRetryTimer.unref?.();
}
function recordLeaderboardPersistenceFailure(error, roundId) {
  const code = boundedLeaderboardLogValue(error?.code, "UNKNOWN", 32);
  if (!leaderboardSaveFailure || leaderboardSaveFailure.code !== code)
    console.warn(
      "Leaderboard persistence failed: code=" +
        code +
        " roundId=" +
        boundedLeaderboardLogValue(roundId, "unknown"),
    );
  leaderboardSaveFailure = {
    code,
    roundId: boundedLeaderboardLogValue(roundId, "unknown"),
  };
  scheduleLeaderboardSaveRetry();
}
function recordLeaderboardScores(entries, roundId) {
  try {
    leaderboard.recordScores(typeof entries === "function" ? entries() : entries);
    markLeaderboardPersistenceRecovered(roundId);
    return true;
  } catch (error) {
    recordLeaderboardPersistenceFailure(error, roundId);
    return false;
  }
}
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
  if (url.pathname === "/api/daily-challenge" && req.method === "GET") {
    if (!rateLimit("daily-challenge:" + clientIp(req), 30))
      return deny(res, 429, "RATE_LIMITED");
    try {
      const challenge = await getTodayDailyChallenge();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify({ challenge }));
    } catch (error) {
      console.warn("Wordrush daily challenge generation failed", JSON.stringify({
        failureCode: error.code || "GENERATION_FAILED",
        diagnostics: error.diagnostics || null,
      }));
      return deny(res, 503, "DAILY_CHALLENGE_UNAVAILABLE");
    }
  }
  if (url.pathname === "/api/daily-challenge/shares" && req.method === "POST") {
    if (!rateLimit("daily-challenge-share:" + clientIp(req), 20))
      return deny(res, 429, "RATE_LIMITED");
    const body = await readJson(req);
    let share;
    try {
      share = dailyChallenges.createShare(body);
    } catch {
      return deny(res, 400, "CHALLENGE_SHARE_INVALID");
    }
    res.writeHead(201, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify(share));
  }
  if (url.pathname.startsWith("/api/challenges/") && req.method === "GET") {
    if (!rateLimit("challenge-share:" + clientIp(req), 60))
      return deny(res, 429, "RATE_LIMITED");
    const ref = url.pathname.slice("/api/challenges/".length);
    const shared = dailyChallenges.getShare(ref);
    if (!shared) return deny(res, 404, "CHALLENGE_NOT_FOUND");
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify(shared));
  }
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
