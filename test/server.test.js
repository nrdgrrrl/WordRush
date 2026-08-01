const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const WebSocket = require("ws");
const { COMMON_WORDS, ADULT_WORDS, configForPreset } = require("../game-config");
const { neighbors } = require("../game-core");
const { DEFAULT_DICTIONARY_ID } = require("../dictionary-registry");
const { Leaderboard } = require("../leaderboard");
process.env.RANDOM_RUSH_DELAY = "50";
process.env.WORDRUSH_ROOM_RECONNECT_GRACE_MS = "100";
process.env.WORDRUSH_MAX_WS_PER_IP = "1000";
process.env.WORDRUSH_MAX_WS_MESSAGES_PER_WINDOW = "200";
process.env.WORDRUSH_LEADERBOARD_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-server-")),
  "leaderboard.json",
);
process.env.WORDRUSH_ANALYTICS_CONSENT_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-consent-")),
  "analytics-consent.json",
);
const {
  server,
  rooms,
  startRound,
  generationTestHooks,
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
  prunePreAdmissionChallenges,
} = require("../server");
function message(ws, type, payload = {}) {
  ws.send(JSON.stringify({ type, ...payload }));
}
function next(ws, wanted) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for " + wanted)),
      1500,
    );
    const handler = (raw) => {
      const data = JSON.parse(raw);
      if (
        data.type === wanted ||
        (wanted === "error" && data.type === "error")
      ) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(data);
      }
    };
    ws.on("message", handler);
  });
}
function nextMatching(ws, wanted, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for matching " + wanted)),
      1500,
    );
    const handler = (raw) => {
      const data = JSON.parse(raw);
      if (data.type === wanted && predicate(data)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(data);
      }
    };
    ws.on("message", handler);
  });
}
function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + server.address().port);
    ws.once("error", reject);
    ws.once("open", () => {
      message(ws, "hello", { name, guestId: name });
      next(ws, "hello_ack").then(() => resolve(ws));
    });
  });
}
function postSoloBoard(body) {
  return fetch("http://127.0.0.1:" + server.address().port + "/api/solo-board", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function displayClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      "ws://127.0.0.1:" + server.address().port + "/display",
    );
    ws.once("error", reject);
    ws.once("open", () => resolve(ws));
  });
}
function wordPath(board, size, word) {
  function walk(index, offset, used, path) {
    if (offset === word.length) return path;
    for (const next of neighbors(index, size)) {
      if (used.has(next) || board[next] !== word[offset]) continue;
      const result = walk(next, offset + 1, new Set([...used, next]), [...path, next]);
      if (result) return result;
    }
    return null;
  }
  for (let index = 0; index < board.length; index++)
    if (board[index] === word[0]) {
      const result = walk(index, 1, new Set([index]), [index]);
      if (result) return result;
    }
  return null;
}
async function createRoomWithPlayers(names) {
  const host = await client(names[0]);
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room", { name: names[0] });
  const created = await createdPromise;
  await lobbyPromise;
  const guests = [];
  for (const name of names.slice(1)) {
    const guest = await client(name);
    const joinedPromise = next(guest, "joined_room");
    message(guest, "join_room", { code: created.code, name });
    await joinedPromise;
    guests.push(guest);
  }
  return { host, guests, code: created.code };
}
async function startClassicTestRound(host, code) {
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  await startedPromise;
  return rooms.get(code);
}
async function startRandomTestRound(host, code) {
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "random" });
  await startedPromise;
  return rooms.get(code);
}
async function startRoundImmediately(host) {
  const startedPromise = next(host, "round_start_now");
  message(host, "start_round_now");
  await startedPromise;
}
async function finishTestRound(host, players) {
  const finishedPromises = players.map((ws) => next(ws, "round_finished"));
  message(host, "end_round");
  return (await Promise.all(finishedPromises))[0];
}
async function closeTestRoom(host, players) {
  const active = players.filter((ws) => ws.readyState <= 1);
  const closedPromises = active.map((ws) => next(ws, "session_closed"));
  message(host, "end_session");
  await Promise.all(closedPromises);
  for (const ws of players) if (ws.readyState <= 1) ws.close();
}
test.before(
  () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
);
test.after(
  () =>
    new Promise((resolve) => {
      for (const room of rooms.values()) {
        clearTimeout(room.round?.timer);
        clearTimeout(room.rushTimer);
        room.players.forEach((player) => {
          clearTimeout(player.disconnectTimer);
          player.ws.terminate();
        });
        room.displays.forEach((ws) => ws.terminate());
        room.pendingConsent?.timer && clearTimeout(room.pendingConsent.timer);
      }
      rooms.clear();
      displayTokens.clear();
      displayCredentials.clear();
      server.closeAllConnections?.();
      server.close();
      resolve();
      setImmediate(() => process.exit(0));
    }),
);
test.afterEach(() => {
  generationTestHooks.limits = null;
  generationTestHooks.selectorLimits = null;
  generationTestHooks.lexicon = null;
  generationTestHooks.yieldScheduler = null;
  generationTestHooks.onContract = null;
  generationTestHooks.onResult = null;
  generationTestHooks.onCancellation = null;
});

test("revalidates mutable browser resources while retaining static asset caching", async () => {
  const origin = "http://127.0.0.1:" + server.address().port;
  const noCachePaths = [
    "/",
    "/index.html",
    "/game-config.js",
    "/board-core.js",
    "/styles.css",
    "/manifest.webmanifest",
    "/receiver/",
    "/receiver/index.html",
    "/receiver/receiver.js",
    "/receiver/receiver.css",
    "/dictionary.json",
  ];
  for (const requestPath of noCachePaths) {
    const response = await fetch(origin + requestPath);
    assert.equal(response.status, 200, requestPath);
    assert.equal(response.headers.get("cache-control"), "no-cache", requestPath);
  }

  for (const requestPath of ["/assets/cat-rush.png", "/robots.txt"]) {
    const response = await fetch(origin + requestPath);
    assert.equal(response.status, 200, requestPath);
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=3600" +
        (requestPath === "/assets/cat-rush.png"
          ? ", stale-while-revalidate=86400"
          : ""),
      requestPath,
    );
  }
});

test("a stale cached-client request still receives the current mutable script", async () => {
  const endpoint = "http://127.0.0.1:" + server.address().port + "/app.js";
  const first = await fetch(endpoint);
  const currentBody = await first.text();
  assert.equal(first.headers.get("cache-control"), "no-cache");

  const revalidated = await fetch(endpoint, {
    headers: {
      "Cache-Control": "max-age=3600",
      "If-None-Match": '"old-release"',
      "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT",
    },
  });
  assert.equal(revalidated.status, 200);
  assert.equal(revalidated.headers.get("cache-control"), "no-cache");
  assert.equal(await revalidated.text(), currentBody);
});

test("creates a session, starts a round, and admits ten players", async () => {
  const players = await Promise.all(
    Array.from({ length: 10 }, (_, i) => client("player-" + i)),
  );
  const createdPromise = next(players[0], "room_created");
  const lobbyPromise = next(players[0], "room_state");
  message(players[0], "create_room", { name: "player-0" });
  const created = await createdPromise;
  await lobbyPromise;
  const startedPromise = next(players[0], "round_started");
  message(players[0], "start_game", { mode: "race" });
  const started = await startedPromise;
  assert.equal(started.round.size, 4);
  for (let i = 1; i < players.length; i++)
    message(players[i], "join_room", {
      code: created.code,
      name: "player-" + i,
    });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(rooms.get(created.code).players.size, 10);
  assert.equal(created.code.length, 5);
  players.forEach((ws) => ws.close());
});

test("selected dictionary freezes into round, resume, and result state", async () => {
  const host = await client("dictionary-freeze-host");
  const createdPromise = next(host, "room_created");
  message(host, "create_room", { name: "dictionary-freeze-host" });
  const created = await createdPromise;
  const startedPromise = next(host, "round_started");
  message(host, "start_game", {
    mode: "classic",
    dictionaryId: DEFAULT_DICTIONARY_ID,
  });
  const started = await startedPromise;
  assert.equal(started.dictionary.dictionaryId, DEFAULT_DICTIONARY_ID);
  assert.equal(started.round.dictionary.dictionaryId, DEFAULT_DICTIONARY_ID);
  assert.equal(rooms.get(created.code).round.dictionaryId, DEFAULT_DICTIONARY_ID);

  const reconnectToken = created.reconnectToken;
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const resumed = await client("dictionary-freeze-host");
  const resumedStatePromise = next(resumed, "room_state");
  message(resumed, "resume_room", {
    code: created.code,
    reconnectToken,
  });
  const resumedState = await resumedStatePromise;
  assert.equal(resumedState.round.dictionary.dictionaryId, DEFAULT_DICTIONARY_ID);

  const finishedPromise = next(resumed, "round_finished");
  message(resumed, "end_round");
  const finished = await finishedPromise;
  assert.equal(finished.dictionary.dictionaryId, DEFAULT_DICTIONARY_ID);

  const resultToken = rooms.get(created.code).players.get("dictionary-freeze-host").reconnectToken;
  resumed.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const resultResume = await client("dictionary-freeze-host");
  const resultStatePromise = next(resultResume, "room_state");
  message(resultResume, "resume_room", {
    code: created.code,
    reconnectToken: resultToken,
  });
  const resultState = await resultStatePromise;
  assert.equal(resultState.lastResult.dictionary.dictionaryId, DEFAULT_DICTIONARY_ID);
  resultResume.close();
});

test("solo board endpoint generates validated preset and custom rounds", async () => {
  const presetResponse = await postSoloBoard({
    mode: "classic",
    dictionaryId: DEFAULT_DICTIONARY_ID,
  });
  assert.equal(presetResponse.status, 200);
  assert.equal(presetResponse.headers.get("cache-control"), "no-store");
  const preset = await presetResponse.json();
  assert.equal(preset.mode, "classic");
  assert.equal(preset.validationMode, "classic");
  assert.equal(preset.dictionary.dictionaryId, DEFAULT_DICTIONARY_ID);
  assert.equal(preset.board.length, preset.config.size ** 2);
  assert.equal(preset.seed, preset.diagnostics.requestedSeed);
  assert.equal(Number.isInteger(preset.selectedCandidateSeed), true);
  assert.deepEqual(preset.diagnostics.dictionary, preset.dictionary);

  const customResponse = await postSoloBoard({
    mode: "custom",
    dictionaryId: DEFAULT_DICTIONARY_ID,
    adult: true,
    config: {
      label: "AFTER DARK",
      min: 3,
      size: 4,
      seconds: 60,
      rule: "Adults only",
      adult: true,
    },
  });
  assert.equal(customResponse.status, 200);
  const custom = await customResponse.json();
  assert.equal(custom.mode, "custom");
  assert.equal(custom.validationMode, "dirty");
  assert.equal(custom.config.adult, true);
  assert.equal(custom.dictionary.dictionaryId, DEFAULT_DICTIONARY_ID);
  assert.equal(custom.board.length, 16);

  const unavailableResponse = await postSoloBoard({
    mode: "custom",
    dictionaryId: DEFAULT_DICTIONARY_ID,
    config: {
      label: "UNMEASURED",
      min: 7,
      size: 4,
      seconds: 60,
      rule: "Unmeasured profile",
    },
  });
  assert.equal(unavailableResponse.status, 503);
  const unavailable = await unavailableResponse.json();
  assert.equal(unavailable.error, "BOARD_GENERATION_FAILED");
  assert.equal(unavailable.failureCode, "QUALITY_PROFILE_UNAVAILABLE");
  assert.equal(unavailable.board, undefined);
});

test("solo board endpoint rejects unsupported input and unknown dictionaries", async () => {
  const invalidRequests = [
    { body: { mode: "not-a-mode" }, error: "UNKNOWN_MODE" },
    {
      body: {
        mode: "custom",
        config: { label: "Bad", min: 2, size: 4, seconds: 60, rule: "Bad" },
      },
      error: "CUSTOM_CONFIG_INVALID",
    },
    {
      body: { mode: "classic", seed: 1234 },
      error: "SOLO_REQUEST_FIELD_NOT_ALLOWED",
    },
    {
      body: { mode: "classic", customWords: ["CAT"] },
      error: "SOLO_REQUEST_FIELD_NOT_ALLOWED",
    },
    {
      body: { mode: "dirty" },
      error: "ADULT_INTENT_REQUIRED",
    },
  ];
  for (const entry of invalidRequests) {
    const response = await postSoloBoard(entry.body);
    assert.equal(response.status, 400, entry.error);
    assert.deepEqual(await response.json(), { error: entry.error });
  }
  const unknown = await postSoloBoard({
    mode: "classic",
    dictionaryId: "unregistered-dictionary",
  });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "UNKNOWN_DICTIONARY_ID" });
});

test("solo and multiplayer rounds use the same server generator contract", async () => {
  const contracts = [];
  const results = [];
  generationTestHooks.onContract = (contract) => contracts.push(contract);
  generationTestHooks.onResult = (result) => results.push(result);
  const soloResponse = await postSoloBoard({
    mode: "classic",
    dictionaryId: DEFAULT_DICTIONARY_ID,
  });
  assert.equal(soloResponse.status, 200);

  const host = await client("shared-generator-host");
  const createdPromise = next(host, "room_created");
  message(host, "create_room");
  const created = await createdPromise;
  const startedPromise = next(host, "round_started");
  message(host, "start_game", {
    mode: "classic",
    dictionaryId: DEFAULT_DICTIONARY_ID,
  });
  const started = await startedPromise;

  assert.equal(contracts.length, 2);
  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.diagnostics.selectorVersion), true);
  assert.deepEqual(
    contracts.map(({ requestedSeed, ...contract }) => contract),
    [
      {
        size: 4,
        minimum: 3,
        validationMode: "classic",
        dictionaryId: DEFAULT_DICTIONARY_ID,
      },
      {
        size: 4,
        minimum: 3,
        validationMode: "classic",
        dictionaryId: DEFAULT_DICTIONARY_ID,
      },
    ],
  );
  const room = rooms.get(created.code);
  const quality = room.round.quality;
  assert.equal(Number.isInteger(quality.requestedSeed), true);
  assert.equal(Number.isInteger(quality.selectedCandidateSeed), true);
  assert.equal(quality.selectorVersion, results[1].diagnostics.selectorVersion);
  assert.equal(quality.profileId, results[1].diagnostics.profileId);
  assert.equal(quality.candidateCount, 4);
  assert.equal(Array.isArray(quality.candidateSeeds), true);
  assert.equal(quality.candidateSeeds.length, quality.candidateCount);
  assert.equal(Number.isInteger(quality.selectedCandidateIndex), true);
  assert.equal(typeof quality.selectedFingerprint, "string");
  assert.equal(Array.isArray(quality.selectedRanking), true);
  assert.equal(Array.isArray(quality.candidates), true);
  for (const field of [
    "generationAttempts",
    "placementOperations",
    "generationBacktracks",
    "analysisOperations",
    "cooperativeYields",
    "elapsedMs",
    "size",
    "minimum",
  ]) assert.equal(typeof quality[field], "number");
  assert.equal(quality.validationMode, "classic");
  assert.deepEqual(Object.keys(quality.dictionary).sort(), ["artifactSha256", "dictionaryId"]);
  assert.equal(quality.candidates.some((candidate) => "report" in candidate), false);
  assert.equal(started.round.quality, undefined);
  host.close();
});

test("multiplayer rejects browser-owned seed and selector policy controls", async () => {
  const ws = await client("policy-controls-host");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const errorPromise = next(ws, "error");
  message(ws, "start_game", {
    mode: "classic",
    requestedSeed: 123,
    candidateCount: 6,
    selectorLimits: { totalYields: 1 },
  });
  const error = await errorPromise;
  assert.equal(error.code, "ROUND_GENERATION_POLICY_NOT_ALLOWED");
  assert.equal(rooms.get(created.code).round, null);
  assert.equal(rooms.get(created.code).generation, null);
  ws.close();
});

test("solo board generation failure is explicit and never returns a board", async () => {
  generationTestHooks.selectorLimits = {
    totalGenerationAttempts: 1,
    totalPlacementOperations: 1,
    totalGenerationBacktracks: 1,
    totalAnalysisOperations: 1,
    totalYields: 1,
    operationsPerYield: 1,
  };
  const response = await postSoloBoard({
    mode: "classic",
    dictionaryId: DEFAULT_DICTIONARY_ID,
  });
  assert.equal(response.status, 503);
  const failure = await response.json();
  assert.equal(failure.error, "BOARD_GENERATION_FAILED");
  assert.equal(failure.failureCode, "QUALITY_SELECTION_GLOBAL_LIMIT");
  assert.equal(failure.board, undefined);
  assert.equal(failure.diagnostics.dictionary.dictionaryId, DEFAULT_DICTIONARY_ID);
  assert.equal(Number.isInteger(failure.diagnostics.requestedSeed), true);
});

test("abandoned solo requests cancel generation without completing a response", async () => {
  generationTestHooks.selectorLimits = { operationsPerYield: 1 };
  let releaseGeneration;
  let generationYielded;
  const yielded = new Promise((resolve) => {
    generationYielded = resolve;
  });
  const result = new Promise((resolve) => {
    generationTestHooks.onResult = resolve;
  });
  const requestCancelled = new Promise((resolve) => {
    generationTestHooks.onCancellation = resolve;
  });
  generationTestHooks.yieldScheduler = () => {
    generationYielded();
    return new Promise((resolve) => {
      releaseGeneration = resolve;
    });
  };
  let responseCompleted = false;
  const request = http.request({
    host: "127.0.0.1",
    port: server.address().port,
    path: "/api/solo-board",
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const requestClosed = new Promise((resolve) => request.once("close", resolve));
  request.on("response", (response) => {
    response.on("data", () => {});
    response.on("end", () => { responseCompleted = true; });
  });
  request.on("error", () => {});
  request.end(JSON.stringify({
    mode: "classic",
    dictionaryId: DEFAULT_DICTIONARY_ID,
  }));
  await yielded;
  request.destroy();
  await Promise.all([requestClosed, requestCancelled]);
  releaseGeneration();
  const cancelled = await result;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, "QUALITY_SELECTION_CANCELLED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responseCompleted, false);
});

test("cooperative board generation lets another room process a queued action", async () => {
  generationTestHooks.selectorLimits = { operationsPerYield: 2_048 };
  const firstHost = await client("yield-first");
  const secondHost = await client("yield-second");
  const firstCreated = next(firstHost, "room_created");
  const firstLobby = next(firstHost, "room_state");
  message(firstHost, "create_room");
  await firstCreated;
  await firstLobby;
  const secondCreated = next(secondHost, "room_created");
  const secondLobby = next(secondHost, "room_state");
  message(secondHost, "create_room");
  await secondCreated;
  await secondLobby;
  const order = [];
  const firstStarted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("first room did not start")), 1500);
    firstHost.on("message", (raw) => {
      const data = JSON.parse(raw);
      if (data.type !== "round_started") return;
      clearTimeout(timer);
      order.push("first");
      resolve(data);
    });
  });
  const secondUpdated = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("second room was blocked")), 1500);
    secondHost.on("message", (raw) => {
      const data = JSON.parse(raw);
      if (
        data.type !== "room_state" ||
        !data.players.some((player) => player.name === "queued-update")
      ) return;
      clearTimeout(timer);
      order.push("second");
      resolve(data);
    });
  });
  message(firstHost, "start_game", { mode: "classic" });
  message(secondHost, "update_identity", { name: "queued-update", avatar: "🐸" });
  await Promise.all([firstStarted, secondUpdated]);
  assert.deepEqual(order.slice(0, 2), ["second", "first"]);
  firstHost.close();
  secondHost.close();
});

test("board generation failure is recoverable and overlapping starts are rejected", async () => {
  const ws = await client("generation-recovery");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = rooms.get(created.code);
  generationTestHooks.selectorLimits = {
    totalGenerationAttempts: 1,
    totalPlacementOperations: 1,
    totalGenerationBacktracks: 1,
    totalAnalysisOperations: 1,
    totalYields: 1,
    operationsPerYield: 1,
  };
  const failedPromise = next(ws, "error");
  message(ws, "start_game", { mode: "classic" });
  const failed = await failedPromise;
  assert.equal(failed.code, "BOARD_GENERATION_FAILED");
  assert.equal(failed.failureCode, "QUALITY_SELECTION_GLOBAL_LIMIT");
  assert.equal(room.status, "lobby");
  assert.equal(room.round, null);
  assert.equal(room.generation, null);

  generationTestHooks.selectorLimits = { operationsPerYield: 2_048 };
  const startedPromise = next(ws, "round_started");
  const busyPromise = next(ws, "error");
  message(ws, "start_game", { mode: "classic" });
  message(ws, "start_game", { mode: "classic" });
  const busy = await busyPromise;
  assert.equal(busy.code, "BOARD_GENERATING");
  await startedPromise;
  assert.equal(room.status, "playing");
  ws.close();
});

test("rejects the eleventh player", async () => {
  const players = await Promise.all(
    Array.from({ length: 11 }, (_, i) => client("overflow-" + i)),
  );
  const createdPromise = next(players[0], "room_created");
  const lobbyPromise = next(players[0], "room_state");
  message(players[0], "create_room", { mode: "classic" });
  const created = await createdPromise;
  await lobbyPromise;
  const startedPromise = next(players[0], "round_started");
  message(players[0], "start_game", { mode: "classic" });
  await startedPromise;
  for (let i = 1; i < 10; i++)
    message(players[i], "join_room", { code: created.code });
  await next(players[0], "room_state");
  message(players[10], "join_room", { code: created.code });
  assert.equal((await next(players[10], "error")).code, "ROOM_FULL");
  players.forEach((ws) => ws.close());
});

test("display tokens grant a room-scoped connection that can resume independently", async () => {
  const host = await client("display-host");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room", { name: "Display Host" });
  const created = await createdPromise;
  await lobbyPromise;

  const tokenPromise = next(host, "display_token");
  message(host, "create_display_token");
  const token = await tokenPromise;
  assert.equal(typeof token.token, "string");
  assert.ok(token.expiresAt > Date.now());

  let display = await displayClient();
  const displayState = next(display, "display_state");
  message(display, "display_hello", { token: token.token });
  const initial = await displayState;
  assert.equal(initial.event, "display_connected");
  assert.equal(initial.state.code, created.code);
  assert.equal(initial.state.players.length, 1);
  assert.equal(typeof initial.reconnectToken, "string");
  assert.equal("creatorId" in initial.state, false);
  assert.equal("id" in initial.state.players[0], false);
  assert.equal(rooms.get(created.code).players.size, 1);
  assert.equal(rooms.get(created.code).displays.size, 1);

  const keepalive = next(display, "display_keepalive_ack");
  message(display, "display_keepalive");
  await keepalive;

  const reconnectToken = initial.reconnectToken;
  const originalDisplay = display;
  const displaced = new Promise((resolve) =>
    originalDisplay.once("close", (code, reason) => resolve({ code, reason: String(reason) })),
  );
  display = await displayClient();
  const supersedingState = next(display, "display_state");
  message(display, "display_resume", { token: reconnectToken });
  assert.equal((await supersedingState).event, "display_reconnected");
  assert.deepEqual(await displaced, {
    code: 4000,
    reason: "display resumed elsewhere",
  });
  assert.equal(rooms.get(created.code).displays.size, 1);

  display.close();
  await new Promise((resolve) => display.once("close", resolve));
  display = await displayClient();
  const reconnectedState = next(display, "display_state");
  message(display, "display_resume", { token: reconnectToken });
  const reconnected = await reconnectedState;
  assert.equal(reconnected.event, "display_reconnected");
  assert.equal(reconnected.state.code, created.code);
  assert.equal(rooms.get(created.code).displays.size, 1);

  const denied = next(display, "error");
  message(display, "start_game", { mode: "classic" });
  assert.equal((await denied).code, "DISPLAY_READ_ONLY");
  assert.equal(rooms.get(created.code).status, "lobby");

  const roundState = nextMatching(
    display,
    "display_state",
    (update) => update.event === "round_started",
  );
  message(host, "start_game", { mode: "classic" });
  const startedDisplay = await roundState;
  assert.equal(startedDisplay.state.status, "playing");
  assert.equal(startedDisplay.state.round.quality, undefined);

  const closed = next(display, "session_closed");
  message(host, "end_session");
  assert.equal((await closed).code, created.code);
  host.close();
  display.close();
});

test("WebSocket heartbeat tolerates two missed responses before terminating", () => {
  const fakeSocket = {
    missedHeartbeats: 0,
    pings: 0,
    terminations: 0,
    ping() { this.pings += 1; },
    terminate() { this.terminations += 1; },
  };
  for (let count = 0; count < WS_HEARTBEAT_MISSES; count += 1)
    assert.equal(heartbeatSocket(fakeSocket), true);
  assert.equal(fakeSocket.pings, WS_HEARTBEAT_MISSES);
  assert.equal(fakeSocket.terminations, 0);
  assert.equal(heartbeatSocket(fakeSocket), false);
  assert.equal(fakeSocket.terminations, 1);
  fakeSocket.missedHeartbeats = 0;
  assert.equal(heartbeatSocket(fakeSocket), true);
});

test("an active cast keeps its room alive while the host phone sleeps", async () => {
  const host = await client("sleeping-cast-host");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room", { name: "Sleeping Host" });
  const created = await createdPromise;
  await lobbyPromise;

  const tokenPromise = next(host, "display_token");
  message(host, "create_display_token");
  const token = await tokenPromise;
  const display = await displayClient();
  const displayState = next(display, "display_state");
  message(display, "display_hello", { token: token.token });
  await displayState;

  host.close();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(rooms.has(created.code), true);
  assert.equal(rooms.get(created.code).displays.size, 1);

  const resumedHost = await client("sleeping-cast-host");
  const resumed = next(resumedHost, "room_resumed");
  message(resumedHost, "resume_room", {
    code: created.code,
    reconnectToken: created.reconnectToken,
  });
  await resumed;
  const closed = next(resumedHost, "session_closed");
  message(resumedHost, "end_session");
  await closed;
  resumedHost.close();
  display.close();
});

test("display tokens reject invalid, expired, replayed, and cross-room access", async () => {
  const host = await client("token-host");
  const otherHost = await client("other-token-host");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const otherCreatedPromise = next(otherHost, "room_created");
  const otherLobbyPromise = next(otherHost, "room_state");
  message(otherHost, "create_room");
  const otherCreated = await otherCreatedPromise;
  await otherLobbyPromise;

  const invalid = await displayClient();
  const invalidError = next(invalid, "error");
  message(invalid, "display_hello", { token: "not-a-token" });
  assert.equal((await invalidError).code, "INVALID_DISPLAY_TOKEN");
  invalid.close();

  const expiredTokenPromise = next(host, "display_token");
  message(host, "create_display_token");
  const expiredToken = await expiredTokenPromise;
  displayTokens.get(expiredToken.token).expiresAt = Date.now() - 1;
  const expired = await displayClient();
  const expiredError = next(expired, "error");
  message(expired, "display_hello", { token: expiredToken.token });
  assert.equal((await expiredError).code, "INVALID_DISPLAY_TOKEN");
  expired.close();

  const firstTokenPromise = next(host, "display_token");
  message(host, "create_display_token");
  const firstToken = await firstTokenPromise;
  const secondTokenPromise = next(otherHost, "display_token");
  message(otherHost, "create_display_token");
  const secondToken = await secondTokenPromise;
  const display = await displayClient();
  const initial = next(display, "display_state");
  message(display, "display_hello", { token: firstToken.token });
  assert.equal((await initial).state.code, created.code);

  const reused = await displayClient();
  const reusedError = next(reused, "error");
  message(reused, "display_hello", { token: firstToken.token });
  assert.equal((await reusedError).code, "INVALID_DISPLAY_TOKEN");
  reused.close();

  const crossRoom = next(display, "error");
  message(display, "display_hello", { token: secondToken.token });
  assert.equal((await crossRoom).code, "DISPLAY_ALREADY_AUTHENTICATED");
  assert.equal(displaysForRoom(created.code), 1);
  assert.equal(displaysForRoom(otherCreated.code), 0);
  host.close();
  otherHost.close();
  display.close();
});

test("only the creator can skip the intro or mint a display token", async () => {
  const host = await client("permission-host");
  const guest = await client("permission-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;

  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  await startedPromise;

  const startDenied = next(guest, "error");
  message(guest, "start_round_now");
  assert.deepEqual(await startDenied, { type: "error", code: "CREATOR_ONLY" });

  const tokenDenied = next(guest, "error");
  message(guest, "create_display_token");
  assert.deepEqual(await tokenDenied, { type: "error", code: "CREATOR_ONLY" });

  host.close();
  guest.close();
});

function displaysForRoom(code) {
  return rooms.get(code)?.displays.size || 0;
}

test("authoritatively accepts a valid path and rejects an invalid word", async () => {
  const ws = await client("scorer");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room", { mode: "classic" });
  const created = await createdPromise;
  await lobbyPromise;
  const startedPromise = next(ws, "round_started");
  message(ws, "start_game", { mode: "classic" });
  const started = await startedPromise;
  rooms.get(created.code).round.startedAt = Date.now() - 1;
  const board = started.round.board;
  let found;
  for (let i = 0; i < board.length && !found; i++)
    for (let j = 0; j < board.length && !found; j++)
      if (i !== j && board[i] === "S" && board[j] === "T") found = [i, j];
  if (!found) {
    ws.close();
    return;
  }
  message(ws, "submit_word", { word: "ST", path: found });
  const result = await next(ws, "word_rejected");
  assert.equal(result.type, "word_rejected");
  assert.equal(created.code.length, 5);
  ws.close();
});

test("Word Chain commits one shared state while preserving player ownership", async () => {
  const host = await client("chain-host");
  const guest = await client("chain-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  const joined = await joinedPromise;

  const hostStarted = next(host, "round_started");
  const guestStarted = next(guest, "round_started");
  message(host, "start_game", { mode: "chain" });
  const started = await hostStarted;
  await guestStarted;
  assert.deepEqual(started.chain, {
    lastAcceptedWord: "",
    requiredLetter: "",
    chainResetLetter: "",
  });

  const room = rooms.get(created.code);
  room.round.board = [
    "C", "A", "T", "O", "N",
    "X", "X", "X", "X", "E",
    ...Array(15).fill("X"),
  ];
  room.round.chainRemainingByInitial = { C: 1, T: 1, E: 0 };
  room.round.startedAt = Date.now() - 1;
  room.round.introEndsAt = Date.now() - 1;
  room.round.endsAt = Date.now() + 60_000;

  const shortWord = next(host, "word_rejected");
  message(host, "submit_word", { word: "TO", path: [2, 3] });
  const shortResult = await shortWord;
  assert.equal(shortResult.reason, "minimum");
  assert.equal(shortResult.requiredLetter, "");
  assert.deepEqual(shortResult.chain, started.chain);

  const hostAccepted = next(host, "word_accepted");
  const guestAccepted = next(guest, "word_accepted");
  message(host, "submit_word", { word: "CAT", path: [0, 1, 2] });
  const accepted = await hostAccepted;
  const guestAcceptedMessage = await guestAccepted;
  assert.deepEqual(accepted.chain, {
    lastAcceptedWord: "CAT",
    requiredLetter: "T",
    chainResetLetter: "",
  });
  assert.deepEqual(guestAcceptedMessage.chain, accepted.chain);
  assert.equal(room.players.get("chain-host").score, 9);
  assert.deepEqual(room.players.get("chain-host").words, [{ word: "CAT", points: 9 }]);

  const wrongWord = next(guest, "word_rejected");
  message(guest, "submit_word", { word: "ONE", path: [3, 4, 9] });
  const wrongResult = await wrongWord;
  assert.equal(wrongResult.reason, "chain");
  assert.equal(wrongResult.requiredLetter, "T");
  assert.deepEqual(wrongResult.chain, accepted.chain);

  const duplicateWord = next(guest, "word_rejected");
  message(guest, "submit_word", { word: "CAT", path: [0, 1, 2] });
  assert.equal((await duplicateWord).reason, "duplicate");

  const resetHostAccepted = next(host, "word_accepted");
  const resetGuestAccepted = next(guest, "word_accepted");
  message(host, "submit_word", { word: "TONE", path: [2, 3, 4, 9] });
  const resetAccepted = await resetHostAccepted;
  await resetGuestAccepted;
  assert.deepEqual(resetAccepted.chain, {
    lastAcceptedWord: "TONE",
    requiredLetter: "",
    chainResetLetter: "E",
  });
  assert.equal(room.players.get("chain-host").score, 25);
  assert.deepEqual(room.players.get("chain-host").words, [
    { word: "CAT", points: 9 },
    { word: "TONE", points: 16 },
  ]);

  guest.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const resumedGuest = await client("chain-guest");
  const resumedPromise = next(resumedGuest, "room_resumed");
  const resumedStatePromise = next(resumedGuest, "room_state");
  message(resumedGuest, "resume_room", {
    code: created.code,
    reconnectToken: joined.reconnectToken,
  });
  await resumedPromise;
  const resumedState = await resumedStatePromise;
  assert.deepEqual(resumedState.chain, resetAccepted.chain);

  const finishedPromise = next(resumedGuest, "round_finished");
  message(host, "end_round");
  assert.equal((await finishedPromise).reason, "manual");
  resumedGuest.close();
  host.close();
});

test("rejects multiplayer submissions before the authoritative round start", async () => {
  const ws = await client("early-submitter");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room", { mode: "classic" });
  const created = await createdPromise;
  await lobbyPromise;
  const startedPromise = next(ws, "round_started");
  message(ws, "start_game", { mode: "classic" });
  await startedPromise;
  const room = rooms.get(created.code);
  room.round.startedAt = Date.now() + 1000;
  const errorPromise = next(ws, "error");
  message(ws, "submit_word", { word: "CAT", path: [0, 1, 2] });
  assert.equal((await errorPromise).code, "ROUND_NOT_STARTED");
  assert.equal(room.players.get("early-submitter").score, 0);
  ws.close();
});

test("does not score submissions at or after the authoritative deadline", async () => {
  const ws = await client("late-submitter");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room", { mode: "classic" });
  const created = await createdPromise;
  await lobbyPromise;
  const startedPromise = next(ws, "round_started");
  message(ws, "start_game", { mode: "classic" });
  await startedPromise;
  const room = rooms.get(created.code);
  room.round.startedAt = Date.now() - 1;
  room.round.endsAt = Date.now();
  const finishedPromise = next(ws, "round_finished");
  message(ws, "submit_word", { word: "CAT", path: [0, 1, 2] });
  assert.equal((await finishedPromise).reason, "timeout");
  assert.equal(room.players.get("late-submitter").score, 0);
  ws.close();
});

test("create_room with customWords is rejected before room creation", async () => {
  const ws = await client("custom-words-reject-room");
  const errorPromise = next(ws, "error");
  message(ws, "create_room", { customWords: ["ABCD"] });
  const error = await errorPromise;
  assert.equal(error.code, "CUSTOM_WORDS_REJECTED");
  ws.close();
});

test("create_room with empty customWords is rejected", async () => {
  const ws = await client("custom-words-empty");
  const errorPromise = next(ws, "error");
  message(ws, "create_room", { customWords: [] });
  const error = await errorPromise;
  assert.equal(error.code, "CUSTOM_WORDS_REJECTED");
  ws.close();
});

test("start_game with customWords is rejected before room mutation", async () => {
  const ws = await client("custom-words-reject-game");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = rooms.get(created.code);
  const snapshot = {
    mode: room.mode,
    randomRush: room.randomRush,
    randomModeQueue: [...room.randomModeQueue],
    round: room.round,
    status: room.status,
  };
  const errorPromise = next(ws, "error");
  message(ws, "start_game", { mode: "classic", customWords: ["ABCD"] });
  const error = await errorPromise;
  assert.equal(error.code, "CUSTOM_WORDS_REJECTED");
  assert.equal(room.mode, snapshot.mode);
  assert.equal(room.randomRush, snapshot.randomRush);
  assert.deepEqual([...room.randomModeQueue], snapshot.randomModeQueue);
  assert.equal(room.round, snapshot.round);
  assert.equal(room.status, snapshot.status);
  ws.close();
});

test("room is recoverable after customWords rejection in start_game", async () => {
  const ws = await client("custom-words-recoverable");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = rooms.get(created.code);
  const gameErrorPromise = next(ws, "error");
  message(ws, "start_game", { mode: "classic", customWords: ["ABCD"] });
  await gameErrorPromise;
  assert.equal(room.status, "lobby");
  const startedPromise = next(ws, "round_started");
  message(ws, "start_game", { mode: "classic" });
  await startedPromise;
  assert.equal(room.status, "playing");
  ws.close();
});

test("reconnect after customWords rejection sees unchanged authoritative room", async () => {
  const host = await client("custom-words-reconnect-host");
  const guest = await client("custom-words-reconnect-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = rooms.get(created.code);
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;
  const errorPromise = next(host, "error");
  message(host, "start_game", { mode: "classic", customWords: ["XYZZY"] });
  const error = await errorPromise;
  assert.equal(error.code, "CUSTOM_WORDS_REJECTED");
  assert.equal(room.status, "lobby");
  assert.equal(room.mode, "classic");
  assert.equal(room.round, null);
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reconnectedHost = await client("custom-words-reconnect-host");
  const resumedPromise = next(reconnectedHost, "room_resumed");
  const statePromise = next(reconnectedHost, "room_state");
  message(reconnectedHost, "resume_room", {
    code: created.code,
    reconnectToken: created.reconnectToken,
  });
  await resumedPromise;
  const resumedState = await statePromise;
  assert.equal(resumedState.status, "lobby");
  assert.equal(resumedState.mode, "classic");
  assert.equal(resumedState.round, null);
  assert.equal(resumedState.code, created.code);
  const startedPromise = next(reconnectedHost, "round_started");
  message(reconnectedHost, "start_game", { mode: "classic" });
  await startedPromise;
  assert.equal(room.status, "playing");
  reconnectedHost.close();
  guest.close();
});

test("host and guest both accept dirty consent and round starts", async () => {
  const host = await client("accept-host");
  const guest = await client("accept-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;
  const room = rooms.get(created.code);
  const consentPromise = next(host, "adult_consent_request");
  message(host, "start_game", { mode: "dirty" });
  const consent = await consentPromise;
  assert.equal(room.round, null);
  const hostAccepted = next(host, "adult_consent_player_accepted");
  message(host, "adult_consent_response", { requestId: consent.requestId, accepted: true });
  await hostAccepted;
  const guestAccepted = next(guest, "adult_consent_player_accepted");
  message(guest, "adult_consent_response", { requestId: consent.requestId, accepted: true });
  await guestAccepted;
  const started = await next(host, "round_started");
  assert.equal(started.mode, "dirty");
  assert.equal(started.round.board.length, 25);
  assert.deepEqual(rooms.get(created.code).round.consentedPlayerIds.sort(), ["accept-guest", "accept-host"].sort());
  host.close();
  guest.close();
});

test("disconnecting consented player cancels an in-flight adult generation", async () => {
  generationTestHooks.selectorLimits = { operationsPerYield: 1 };
  let generationYielded;
  const generationYieldedPromise = new Promise((resolve) => {
    generationYielded = resolve;
  });
  let releaseGeneration;
  const generationGate = new Promise((resolve) => {
    releaseGeneration = resolve;
  });
  generationTestHooks.yieldScheduler = () => {
    generationYielded();
    return generationGate;
  };
  const host = await client("generation-consent-host");
  const guest = await client("generation-consent-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;
  const consentPromise = next(host, "adult_consent_request");
  message(host, "start_game", { mode: "dirty" });
  const consent = await consentPromise;
  const hostAccepted = next(host, "adult_consent_player_accepted");
  message(host, "adult_consent_response", { requestId: consent.requestId, accepted: true });
  await hostAccepted;
  const guestAccepted = next(guest, "adult_consent_player_accepted");
  message(guest, "adult_consent_response", { requestId: consent.requestId, accepted: true });
  await guestAccepted;
  await generationYieldedPromise;
  const cancelled = next(host, "adult_consent_cancelled");
  guest.close();
  assert.equal((await cancelled).reason, "player_disconnected");
  const busyPromise = next(host, "error");
  message(host, "start_game", { mode: "dirty" });
  assert.equal((await busyPromise).code, "BOARD_GENERATING");
  releaseGeneration();
  for (let attempt = 0; attempt < 10 && roomGeneration(created.code); attempt++)
    await new Promise((resolve) => setImmediate(resolve));
  const room = rooms.get(created.code);
  assert.equal(room.status, "lobby");
  assert.equal(room.round, null);
  assert.equal(room.generation, null);
  host.close();
});

function roomGeneration(code) {
  return rooms.get(code)?.generation;
}

test("a consenting guest admitted during Dirty generation can reconnect", async () => {
  generationTestHooks.selectorLimits = { operationsPerYield: 2_048 };
  let generationYielded;
  const generationYieldedPromise = new Promise((resolve) => {
    generationYielded = resolve;
  });
  let releaseGeneration;
  const generationGate = new Promise((resolve) => {
    releaseGeneration = resolve;
  });
  generationTestHooks.yieldScheduler = () => {
    generationYielded();
    return generationGate;
  };
  const host = await client("admission-generation-host");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const consentPromise = next(host, "adult_consent_request");
  message(host, "start_game", { mode: "dirty" });
  const consent = await consentPromise;
  const hostAccepted = next(host, "adult_consent_player_accepted");
  message(host, "adult_consent_response", { requestId: consent.requestId, accepted: true });
  await hostAccepted;
  await generationYieldedPromise;

  const guest = await client("admission-generation-guest");
  const challengePromise = next(guest, "adult_pre_admission_challenge");
  message(guest, "join_room", { code: created.code });
  const challenge = await challengePromise;
  const preAcceptedPromise = next(guest, "adult_pre_admission_accepted");
  const joinedPromise = next(guest, "joined_room");
  message(guest, "adult_consent_response", {
    challengeId: challenge.challengeId,
    accepted: true,
  });
  const joined = await joinedPromise;
  await preAcceptedPromise;

  const startedPromise = next(host, "round_started");
  releaseGeneration();
  await startedPromise;
  const room = rooms.get(created.code);
  assert.ok(room.round.consentedPlayerIds.includes("admission-generation-guest"));

  const closed = new Promise((resolve) => guest.once("close", resolve));
  guest.close();
  await closed;
  const reconnected = await client("admission-generation-guest");
  const resumedPromise = next(reconnected, "room_resumed");
  message(reconnected, "resume_room", {
    code: created.code,
    reconnectToken: joined.reconnectToken,
  });
  assert.equal((await resumedPromise).code, created.code);
  reconnected.close();
  host.close();
});

test("guest declines dirty consent and room returns to lobby", async () => {
  const host = await client("decline-host");
  const guest = await client("decline-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;
  const consentPromise = next(host, "adult_consent_request");
  message(host, "start_game", { mode: "dirty" });
  const consent = await consentPromise;
  const declinedPromise = next(guest, "adult_consent_cancelled");
  message(guest, "adult_consent_response", { requestId: consent.requestId, accepted: false });
  assert.equal((await declinedPromise).reason, "player_declined");
  assert.equal(rooms.get(created.code).pendingConsent, null);
  assert.equal(rooms.get(created.code).status, "lobby");
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  await startedPromise;
  assert.equal(rooms.get(created.code).status, "playing");
  host.close();
  guest.close();
});

test("host cancels dirty consent and room recovers to classic", async () => {
  const ws = await client("cancel-host");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = rooms.get(created.code);
  const consentPromise = next(ws, "adult_consent_request");
  message(ws, "start_game", { mode: "dirty" });
  const consent = await consentPromise;
  const cancelledPromise = next(ws, "adult_consent_cancelled");
  message(ws, "adult_consent_cancel", { requestId: consent.requestId });
  assert.equal((await cancelledPromise).reason, "host_cancelled");
  assert.equal(room.pendingConsent, null);
  const startedPromise = next(ws, "round_started");
  message(ws, "start_game", { mode: "classic" });
  await startedPromise;
  assert.equal(room.status, "playing");
  const finishedPromise = next(ws, "round_finished");
  message(ws, "end_round");
  await finishedPromise;
  const consent2Promise = next(ws, "adult_consent_request");
  message(ws, "start_game", { mode: "dirty" });
  const consent2 = await consent2Promise;
  assert.ok(room.pendingConsent);
  const rrCancelledPromise = next(ws, "adult_consent_cancelled");
  const rrStartedPromise = next(ws, "round_started");
  message(ws, "start_game", { mode: "random" });
  const rrCancelled = await rrCancelledPromise;
  assert.equal(rrCancelled.reason, "configuration_changed");
  assert.equal(room.pendingConsent, null);
  const rrStarted = await rrStartedPromise;
  assert.notEqual(rrStarted.mode, "dirty");
  ws.close();
});

test("late join during pending consent receives pre-admission challenge", async () => {
  const host = await client("late-join-pre-host");
  const guest = await client("late-join-pre-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = rooms.get(created.code);
  const consentPromise = next(host, "adult_consent_request");
  message(host, "start_game", { mode: "dirty" });
  await consentPromise;
  assert.ok(room.pendingConsent);
  const challengePromise = next(guest, "adult_pre_admission_challenge");
  message(guest, "join_room", { code: created.code });
  const challenge = await challengePromise;
  assert.equal(challenge.roomCode, created.code);
  assert.equal(challenge.mode, "dirty");
  assert.equal(room.players.has("late-join-pre-guest"), false, "guest should not be admitted yet");
  const joinedPromise = next(guest, "joined_room");
  message(guest, "adult_consent_response", { challengeId: challenge.challengeId, accepted: true });
  const joined = await joinedPromise;
  assert.equal(joined.code, created.code);
  assert.equal(room.players.has("late-join-pre-guest"), true);
  host.close();
  guest.close();
});

test("pre-admission socket close removes challenge despite null roomCode", async () => {
  const host = await client("cleanup-pre-host");
  const guest = await client("cleanup-pre-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const consentPromise = next(host, "adult_consent_request");
  message(host, "start_game", { mode: "dirty" });
  await consentPromise;
  const challengePromise = next(guest, "adult_pre_admission_challenge");
  message(guest, "join_room", { code: created.code });
  const challenge = await challengePromise;
  assert.ok(preAdmissionChallenges.has(challenge.challengeId));
  const challengeObj = preAdmissionChallenges.get(challenge.challengeId);
  assert.equal(challengeObj.clientId, "cleanup-pre-guest");
  guest.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(preAdmissionChallenges.has(challenge.challengeId), false);
  host.close();
});

test("CUSTOM_WORDS_REJECTED fires before adult consent flow", async () => {
  const ws = await client("custom-first-reject");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = rooms.get(created.code);
  assert.ok(room, "room should exist");
  const before = { mode: room.mode, status: room.status, round: room.round };
  const errorPromise = next(ws, "error");
  message(ws, "start_game", { mode: "dirty", customWords: ["X"] });
  const error = await errorPromise;
  assert.equal(error.code, "CUSTOM_WORDS_REJECTED");
  assert.ok(!room.pendingConsent);
  assert.equal(room.mode, before.mode);
  assert.equal(room.status, before.status);
  assert.equal(room.round, before.round);
  ws.close();
});

test("skip_round is non-scoring, identity-bound, and restorable", async () => {
  const host = await client("skip-round-host");
  const guest = await client("skip-round-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;
  const room = rooms.get(created.code);

  const noActiveError = next(host, "error");
  message(host, "skip_round", { roundId: "not-active" });
  assert.equal((await noActiveError).code, "ROUND_NOT_PLAYING");

  const guestError = next(guest, "error");
  message(guest, "skip_round", { roundId: "not-active" });
  assert.equal((await guestError).code, "CREATOR_ONLY");

  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  await startedPromise;
  room.round.board = ["C", "A", "T", ...Array(13).fill("X")];

  const missingIdError = next(host, "error");
  message(host, "skip_round", { roundId: "" });
  assert.equal((await missingIdError).code, "ROUND_ID_REQUIRED");

  const staleIdError = next(host, "error");
  message(host, "skip_round", { roundId: "stale-round-id" });
  assert.equal((await staleIdError).code, "ROUND_STALE");

  const startNowPromise = next(host, "round_start_now");
  message(host, "start_round_now");
  await startNowPromise;
  const acceptedPromise = next(host, "word_accepted");
  message(host, "submit_word", { word: "CAT", path: [0, 1, 2] });
  await acceptedPromise;

  const sessionBefore = new Map(
    [...room.players.values()].map((player) => [player.id, {
      wins: player.sessionWins,
      losses: player.sessionLosses,
      points: player.sessionPoints,
    }]),
  );
  const leaderboardBefore = fs.existsSync(process.env.WORDRUSH_LEADERBOARD_FILE)
    ? fs.readFileSync(process.env.WORDRUSH_LEADERBOARD_FILE, "utf8")
    : null;
  const skippedRoundId = room.round.id;
  let resultCount = 0;
  const countResults = (raw) => {
    if (JSON.parse(raw).type === "round_finished") resultCount += 1;
  };
  host.on("message", countResults);
  const finishedPromise = next(host, "round_finished");
  const guestFinishedPromise = next(guest, "round_finished");
  message(host, "skip_round", { roundId: skippedRoundId });
  const finished = await finishedPromise;
  await guestFinishedPromise;

  assert.equal(finished.roundId, skippedRoundId);
  assert.equal(finished.reason, "skipped");
  assert.equal(finished.recorded, false);
  assert.equal(finished.ranking.find((player) => player.id === "skip-round-host").score, 9);
  assert.deepEqual(
    finished.ranking.find((player) => player.id === "skip-round-host").words,
    [{ word: "CAT", points: 9 }],
  );
  assert.equal(room.status, "finished");
  const { type: _resultType, ...storedResult } = finished;
  assert.deepEqual(room.lastResult, storedResult);
  for (const [id, before] of sessionBefore) {
    const player = room.players.get(id);
    assert.deepEqual({
      wins: player.sessionWins,
      losses: player.sessionLosses,
      points: player.sessionPoints,
    }, before);
  }
  const leaderboardAfter = fs.existsSync(process.env.WORDRUSH_LEADERBOARD_FILE)
    ? fs.readFileSync(process.env.WORDRUSH_LEADERBOARD_FILE, "utf8")
    : null;
  assert.equal(leaderboardAfter, leaderboardBefore);

  const duplicateError = next(host, "error");
  message(host, "skip_round", { roundId: skippedRoundId });
  assert.equal((await duplicateError).code, "ROUND_NOT_PLAYING");
  await new Promise((resolve) => setTimeout(resolve, 30));
  host.off("message", countResults);
  assert.equal(resultCount, 1);

  const reconnectToken = room.players.get("skip-round-host").reconnectToken;
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const resumedHost = await client("skip-round-host");
  const resumedPromise = next(resumedHost, "room_resumed");
  const statePromise = next(resumedHost, "room_state");
  message(resumedHost, "resume_room", {
    code: created.code,
    reconnectToken,
  });
  await resumedPromise;
  const restored = await statePromise;
  assert.equal(restored.status, "finished");
  assert.equal(restored.lastResult.roundId, skippedRoundId);
  assert.equal(restored.lastResult.reason, "skipped");
  assert.equal(restored.lastResult.recorded, false);

  const guestClosed = next(guest, "session_closed");
  const hostClosed = next(resumedHost, "session_closed");
  message(resumedHost, "end_session");
  await Promise.all([guestClosed, hostClosed]);
  host.close();
  resumedHost.close();
  guest.close();
});

test("stale round timers cannot finish a replacement round", async () => {
  const host = await client("stale-round-timer");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  await startedPromise;
  const room = rooms.get(created.code);
  const staleTimer = room.round.timer;
  room.round = { ...room.round, id: "replacement-round", timer: null };
  staleTimer._onTimeout();
  assert.equal(room.status, "playing");
  clearTimeout(staleTimer);
  const closed = next(host, "session_closed");
  message(host, "end_session");
  await closed;
  host.close();
});

test("Random Rush queues one authoritative transition through result, resume, and Cast state", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "queued-state-host",
    "queued-state-guest",
  ]);
  const guest = guests[0];
  const tokenPromise = next(host, "display_token");
  message(host, "create_display_token");
  const token = await tokenPromise;
  const display = await displayClient();
  const connected = next(display, "display_state");
  message(display, "display_hello", { token: token.token });
  await connected;

  const room = await startRandomTestRound(host, code);
  room.randomModeQueue = ["storm"];
  const finishedHost = next(host, "round_finished");
  const finishedGuest = next(guest, "round_finished");
  const finishedDisplay = nextMatching(
    display,
    "display_state",
    (update) => update.event === "round_finished",
  );
  message(host, "end_round");
  const finished = await finishedHost;
  await finishedGuest;
  const displayed = await finishedDisplay;
  const queued = finished.nextRound;
  assert.deepEqual(queued, {
    sourceRoundId: finished.roundId,
    mode: "storm",
    automaticAt: queued.automaticAt,
  });
  assert.deepEqual(room.nextRound, queued);
  assert.deepEqual(room.lastResult.nextRound, queued);
  assert.deepEqual(displayed.state.lastResult.nextRound, queued);

  clearTimeout(room.rushTimer);
  room.rushTimer = null;
  const guestToken = room.players.get("queued-state-guest").reconnectToken;
  guest.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const resumed = await client("queued-state-guest");
  const resumedPromise = next(resumed, "room_resumed");
  const statePromise = next(resumed, "room_state");
  message(resumed, "resume_room", { code, reconnectToken: guestToken });
  await resumedPromise;
  const restored = await statePromise;
  assert.deepEqual(restored.lastResult.nextRound, queued);

  await closeTestRoom(host, [host, resumed]);
  display.close();
});

test("Random Rush reports each deterministic queued mode at finish", async () => {
  for (const [index, mode] of ["classic", "race", "chain"].entries()) {
    const host = await client("queued-mode-" + index);
    const createdPromise = next(host, "room_created");
    const lobbyPromise = next(host, "room_state");
    message(host, "create_room");
    const created = await createdPromise;
    await lobbyPromise;
    const room = await startRandomTestRound(host, created.code);
    room.randomModeQueue = [mode];
    const finishedPromise = next(host, "round_finished");
    message(host, "end_round");
    const finished = await finishedPromise;
    assert.equal(finished.nextRound.mode, mode);
    assert.equal(room.nextRound.mode, mode);
    clearTimeout(room.rushTimer);
    room.rushTimer = null;
    const closed = next(host, "session_closed");
    message(host, "end_session");
    await closed;
    host.close();
  }
});

test("automatic Random Rush continuation consumes the stored mode exactly once", async () => {
  const host = await client("queued-auto-host");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = await startRandomTestRound(host, created.code);
  room.randomModeQueue = ["chain"];
  const finishedPromise = next(host, "round_finished");
  message(host, "end_round");
  const finished = await finishedPromise;
  room.randomModeQueue = ["sudden"];
  let startedCount = 0;
  const countStarted = (raw) => {
    if (JSON.parse(raw).type === "round_started") startedCount += 1;
  };
  host.on("message", countStarted);
  const started = await next(host, "round_started");
  host.off("message", countStarted);
  assert.equal(started.mode, finished.nextRound.mode);
  assert.equal(started.mode, "chain");
  assert.equal(startedCount, 1);
  assert.equal(room.nextRound, null);
  assert.equal(room.lastResult, null);
  const closed = next(host, "session_closed");
  message(host, "end_session");
  await closed;
  host.close();
});

test("queued generation failure leaves an ordinary finished-result recovery path", async () => {
  const host = await client("queued-generation-failure-host");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = await startRandomTestRound(host, created.code);
  room.randomModeQueue = ["storm"];
  const finishedPromise = next(host, "round_finished");
  message(host, "end_round");
  const finished = await finishedPromise;
  const queued = finished.nextRound;
  const staleTimer = room.rushTimer;
  const contracts = [];
  generationTestHooks.onContract = (contract) => contracts.push(contract);
  generationTestHooks.selectorLimits = {
    totalGenerationAttempts: 1,
    totalPlacementOperations: 1,
    totalGenerationBacktracks: 1,
    totalAnalysisOperations: 1,
    totalYields: 1,
    operationsPerYield: 1,
  };
  const failurePromise = next(host, "error");
  const statePromise = nextMatching(
    host,
    "room_state",
    (state) =>
      state.status === "finished" &&
      state.lastResult?.roundId === finished.roundId &&
      !state.lastResult?.nextRound,
  );
  message(host, "start_next_round", { sourceRoundId: finished.roundId });
  const [failure, state] = await Promise.all([failurePromise, statePromise]);
  assert.equal(failure.code, "BOARD_GENERATION_FAILED");
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].size, configForPreset(queued.mode).size);
  assert.equal(contracts[0].minimum, configForPreset(queued.mode).min);
  assert.equal(room.status, "finished");
  assert.equal(room.generation, null);
  assert.equal(room.nextRound, null);
  assert.equal(room.lastResult.nextRound, undefined);
  assert.equal(room.rushTimer, null);
  assert.equal(state.lastResult.roundId, finished.roundId);
  assert.equal(state.lastResult.nextRound, undefined);
  staleTimer?._onTimeout?.();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(room.status, "finished");
  assert.equal(room.round.id, finished.roundId);

  generationTestHooks.selectorLimits = { operationsPerYield: 2_048 };
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  const started = await startedPromise;
  assert.equal(started.mode, "classic");
  assert.equal(room.status, "playing");
  const closed = next(host, "session_closed");
  message(host, "end_session");
  await closed;
  host.close();
});

test("failed manual replacement clears an old queue and remains recoverable", async () => {
  const host = await client("failed-replacement-host");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = await startRandomTestRound(host, created.code);
  room.randomModeQueue = ["storm"];
  const finishedPromise = next(host, "round_finished");
  message(host, "end_round");
  const finished = await finishedPromise;
  const staleTimer = room.rushTimer;
  generationTestHooks.selectorLimits = {
    totalGenerationAttempts: 1,
    totalPlacementOperations: 1,
    totalGenerationBacktracks: 1,
    totalAnalysisOperations: 1,
    totalYields: 1,
    operationsPerYield: 1,
  };
  const failurePromise = next(host, "error");
  const statePromise = nextMatching(
    host,
    "room_state",
    (state) =>
      state.status === "finished" &&
      state.lastResult?.roundId === finished.roundId &&
      !state.lastResult?.nextRound,
  );
  message(host, "start_game", { mode: "classic" });
  const [failure, state] = await Promise.all([failurePromise, statePromise]);
  assert.equal(failure.code, "BOARD_GENERATION_FAILED");
  assert.equal(state.lastResult.nextRound, undefined);
  assert.equal(room.randomRush, false);
  assert.equal(room.nextRound, null);
  assert.equal(room.rushTimer, null);
  staleTimer?._onTimeout?.();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(room.status, "finished");
  assert.equal(room.round.id, finished.roundId);

  generationTestHooks.selectorLimits = { operationsPerYield: 2_048 };
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  const started = await startedPromise;
  assert.equal(started.mode, "classic");
  const closed = next(host, "session_closed");
  message(host, "end_session");
  await closed;
  host.close();
});

test("start_next_round is creator-only, source-bound, and exactly once", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "queued-command-host",
    "queued-command-guest",
  ]);
  const guest = guests[0];
  const room = await startRandomTestRound(host, code);
  room.randomModeQueue = ["race"];
  const finishedPromise = next(host, "round_finished");
  const guestFinishedPromise = next(guest, "round_finished");
  message(host, "end_round");
  const finished = await finishedPromise;
  await guestFinishedPromise;

  const missingId = next(host, "error");
  message(host, "start_next_round");
  assert.equal((await missingId).code, "ROUND_ID_REQUIRED");
  const stale = next(host, "error");
  message(host, "start_next_round", { sourceRoundId: "older-round" });
  assert.equal((await stale).code, "ROUND_STALE");
  const guestError = next(guest, "error");
  message(guest, "start_next_round", { sourceRoundId: finished.roundId });
  assert.equal((await guestError).code, "CREATOR_ONLY");

  let startedCount = 0;
  const countStarted = (raw) => {
    if (JSON.parse(raw).type === "round_started") startedCount += 1;
  };
  host.on("message", countStarted);
  const startedPromise = next(host, "round_started");
  const repeatedError = next(host, "error");
  message(host, "start_next_round", { sourceRoundId: finished.roundId });
  message(host, "start_next_round", { sourceRoundId: finished.roundId });
  const [started, error] = await Promise.all([startedPromise, repeatedError]);
  host.off("message", countStarted);
  assert.equal(started.mode, "race");
  assert.equal(error.code, "NEXT_ROUND_UNAVAILABLE");
  assert.equal(startedCount, 1);

  const afterStart = next(host, "error");
  message(host, "start_next_round", { sourceRoundId: finished.roundId });
  assert.equal((await afterStart).code, "NEXT_ROUND_UNAVAILABLE");
  await closeTestRoom(host, [host, guest]);
});

test("manual start_game replaces a queued Random Rush transition and stale callbacks cannot launch", async () => {
  const host = await client("queued-replacement-host");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = await startRandomTestRound(host, created.code);
  room.randomModeQueue = ["storm"];
  const finishedPromise = next(host, "round_finished");
  message(host, "end_round");
  const finished = await finishedPromise;
  const staleTimer = room.rushTimer;
  let startedCount = 0;
  const countStarted = (raw) => {
    if (JSON.parse(raw).type === "round_started") startedCount += 1;
  };
  host.on("message", countStarted);
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  const started = await startedPromise;
  staleTimer?._onTimeout?.();
  await new Promise((resolve) => setTimeout(resolve, 80));
  host.off("message", countStarted);
  assert.equal(started.mode, "classic");
  assert.equal(room.mode, "classic");
  assert.equal(room.randomRush, false);
  assert.equal(room.nextRound, null);
  assert.equal(room.rushTimer, null);
  assert.equal(startedCount, 1);
  assert.equal(finished.nextRound.mode, "storm");
  const closed = next(host, "session_closed");
  message(host, "end_session");
  await closed;
  host.close();
});

test("non-Random Rush results do not claim a queued next round", async () => {
  const host = await client("non-random-result-host");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = await startClassicTestRound(host, created.code);
  const finishedPromise = next(host, "round_finished");
  message(host, "end_round");
  const finished = await finishedPromise;
  assert.equal("nextRound" in finished, false);
  assert.equal("nextRound" in room.lastResult, false);
  assert.equal(room.nextRound, null);
  const closed = next(host, "session_closed");
  message(host, "end_session");
  await closed;
  host.close();
});

test("reconnect after automatic Random Rush transition sees playing state without obsolete result action", async () => {
  const host = await client("queued-reconnect-auto");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = await startRandomTestRound(host, created.code);
  room.randomModeQueue = ["blitz"];
  const reconnectToken = room.players.get("queued-reconnect-auto").reconnectToken;
  const finishedPromise = next(host, "round_finished");
  message(host, "end_round");
  await finishedPromise;
  const startedPromise = next(host, "round_started");
  await startedPromise;
  assert.equal(room.status, "playing");
  assert.equal(room.lastResult, null);
  assert.equal(room.nextRound, null);
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const resumed = await client("queued-reconnect-auto");
  const resumedPromise = next(resumed, "room_resumed");
  const statePromise = next(resumed, "room_state");
  message(resumed, "resume_room", { code: created.code, reconnectToken });
  await resumedPromise;
  const state = await statePromise;
  assert.equal(state.status, "playing");
  assert.equal(state.lastResult, null);
  assert.equal(state.round.id, room.round.id);
  const closed = next(resumed, "session_closed");
  message(resumed, "end_session");
  await closed;
  resumed.close();
});

test("skipping Random Rush continues at most once", async () => {
  const host = await client("skip-random-rush");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "random" });
  await startedPromise;
  const room = rooms.get(created.code);
  const skippedRoundId = room.round.id;
  room.randomModeQueue = ["scoreattack"];
  let continuationCount = 0;
  const countContinuations = (raw) => {
    const payload = JSON.parse(raw);
    if (payload.type === "round_started") continuationCount += 1;
  };
  host.on("message", countContinuations);
  const finishedPromise = next(host, "round_finished");
  message(host, "skip_round", { roundId: skippedRoundId });
  const finished = await finishedPromise;
  assert.equal(finished.reason, "skipped");
  assert.equal(finished.randomRush, true);
  const continued = await next(host, "round_started");
  assert.equal(finished.nextRound.mode, "scoreattack");
  assert.equal(continued.mode, "scoreattack");
  await new Promise((resolve) => setTimeout(resolve, 100));
  host.off("message", countContinuations);
  assert.equal(continuationCount, 1);
  assert.equal(room.status, "playing");
  assert.notEqual(room.round.id, skippedRoundId);
  const closed = next(host, "session_closed");
  message(host, "end_session");
  await closed;
  host.close();
});

test("round results include every admitted player, including a zero-score player", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "all-result-host",
    "all-result-guest",
    "all-result-zero",
  ]);
  const room = await startClassicTestRound(host, code);
  room.round.board = ["C", "A", "T", ...Array(13).fill("X")];
  await startRoundImmediately(host);

  for (const ws of [host, guests[0]]) {
    const accepted = next(ws, "word_accepted");
    message(ws, "submit_word", { word: "CAT", path: [0, 1, 2] });
    await accepted;
  }
  const finished = await finishTestRound(host, [host, ...guests]);
  assert.deepEqual(
    finished.ranking.map((player) => player.id),
    ["all-result-host", "all-result-guest", "all-result-zero"],
  );
  assert.equal(finished.ranking[2].score, 0);
  assert.deepEqual(finished.ranking[2].words, []);
  await closeTestRoom(host, [host, ...guests]);
});

test("tied zero-score participants remain in deterministic admission order", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "zero-tie-host",
    "zero-tie-first",
    "zero-tie-second",
  ]);
  const room = await startClassicTestRound(host, code);
  const finished = await finishTestRound(host, [host, ...guests]);
  assert.deepEqual(
    finished.ranking.map((player) => ({ id: player.id, score: player.score })),
    [
      { id: "zero-tie-host", score: 0 },
      { id: "zero-tie-first", score: 0 },
      { id: "zero-tie-second", score: 0 },
    ],
  );
  assert.deepEqual(
    [...room.round.participants.keys()],
    ["zero-tie-host", "zero-tie-first", "zero-tie-second"],
  );
  await closeTestRoom(host, [host, ...guests]);
});

test("a deliberately departed participant remains in the completed round", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "leave-result-host",
    "leave-result-guest",
  ]);
  const guest = guests[0];
  const room = await startClassicTestRound(host, code);
  room.round.board = ["C", "A", "T", ...Array(13).fill("X")];
  await startRoundImmediately(host);
  const accepted = next(guest, "word_accepted");
  message(guest, "submit_word", { word: "CAT", path: [0, 1, 2] });
  await accepted;

  const left = next(guest, "session_left");
  message(guest, "leave_session");
  await left;
  assert.equal(room.players.has("leave-result-guest"), false);
  assert.equal(room.round.participants.has("leave-result-guest"), true);

  const detached = room.round.participants.get("leave-result-guest");
  const before = {
    name: detached.name,
    avatar: detached.avatar,
    score: detached.score,
    words: detached.words.map((item) => ({ ...item })),
    reconnectToken: detached.reconnectToken,
  };
  const beforeOrder = [...room.round.participants.keys()];
  for (const reconnectToken of [undefined, "wrong-reconnect-token"]) {
    const claimant = await client("leave-result-guest");
    const errorPromise = next(claimant, "error");
    message(claimant, "join_room", {
      code,
      name: "untrusted-claimant",
      avatar: "🦊",
      ...(reconnectToken ? { reconnectToken } : {}),
    });
    assert.deepEqual(await errorPromise, {
      type: "error",
      code: "ROUND_PARTICIPANT_RESERVED",
    });
    const resumeError = next(claimant, "error");
    message(claimant, "resume_room", {
      code,
      ...(reconnectToken ? { reconnectToken } : {}),
    });
    assert.deepEqual(await resumeError, {
      type: "error",
      code: "RESUME_FAILED",
    });
    claimant.close();
  }
  assert.equal(room.players.has("leave-result-guest"), false);
  assert.strictEqual(room.round.participants.get("leave-result-guest"), detached);
  assert.deepEqual(
    {
      name: detached.name,
      avatar: detached.avatar,
      score: detached.score,
      words: detached.words,
      reconnectToken: detached.reconnectToken,
    },
    before,
  );
  assert.deepEqual([...room.round.participants.keys()], beforeOrder);

  const finished = await finishTestRound(host, [host]);
  assert.deepEqual(
    finished.ranking.map((player) => player.id),
    ["leave-result-guest", "leave-result-host"],
  );
  const departed = finished.ranking.find(
    (player) => player.id === "leave-result-guest",
  );
  assert.equal(departed.name, before.name);
  assert.equal(departed.avatar, before.avatar);
  assert.equal(departed.score, before.score);
  assert.deepEqual(departed.words, before.words);
  await closeTestRoom(host, [host]);
  guest.close();
});

test("a guest whose reconnect grace expires remains in the round result", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "expiry-result-host",
    "expiry-result-guest",
  ]);
  const guest = guests[0];
  const room = await startClassicTestRound(host, code);
  const disconnected = nextMatching(
    host,
    "room_state",
    (state) =>
      state.players.find((player) => player.id === "expiry-result-guest")
        ?.connected === false,
  );
  guest.close();
  await disconnected;
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(room.players.has("expiry-result-guest"), false);
  assert.equal(room.round.participants.has("expiry-result-guest"), true);

  const finished = await finishTestRound(host, [host]);
  assert.deepEqual(
    finished.ranking.map((player) => player.id),
    ["expiry-result-host", "expiry-result-guest"],
  );
  await closeTestRoom(host, [host]);
});

test("a detached participant cannot resume after reconnect grace expires", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "expired-reconnect-host",
    "expired-reconnect-guest",
  ]);
  const guest = guests[0];
  const room = await startClassicTestRound(host, code);
  const reconnectToken = room.players.get("expired-reconnect-guest").reconnectToken;
  const disconnected = nextMatching(
    host,
    "room_state",
    (state) =>
      state.players.find((player) => player.id === "expired-reconnect-guest")
        ?.connected === false,
  );
  guest.close();
  await disconnected;
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(room.players.has("expired-reconnect-guest"), false);

  const claimant = await client("expired-reconnect-guest");
  const joinError = next(claimant, "error");
  message(claimant, "join_room", { code, reconnectToken });
  assert.equal((await joinError).code, "ROUND_PARTICIPANT_RESERVED");
  const resumeError = next(claimant, "error");
  message(claimant, "resume_room", { code, reconnectToken });
  assert.equal((await resumeError).code, "RESUME_FAILED");
  claimant.close();

  const finished = await finishTestRound(host, [host]);
  assert.equal(
    finished.ranking.filter((player) => player.id === "expired-reconnect-guest").length,
    1,
  );
  await closeTestRoom(host, [host]);
});

test("adult pre-admission cannot reclaim a detached round participant", async () => {
  const host = await client("adult-reserved-host");
  const guest = await client("adult-reserved-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;

  const consentPromise = next(host, "adult_consent_request");
  message(host, "start_game", { mode: "dirty" });
  const consent = await consentPromise;
  const hostAccepted = next(host, "adult_consent_player_accepted");
  message(host, "adult_consent_response", {
    requestId: consent.requestId,
    accepted: true,
  });
  await hostAccepted;
  const startedPromise = next(host, "round_started");
  const guestAccepted = next(guest, "adult_consent_player_accepted");
  message(guest, "adult_consent_response", {
    requestId: consent.requestId,
    accepted: true,
  });
  await guestAccepted;
  await startedPromise;
  const room = rooms.get(created.code);

  const left = next(guest, "session_left");
  message(guest, "leave_session");
  await left;
  assert.equal(room.players.has("adult-reserved-guest"), false);

  const claimant = await client("adult-reserved-guest");
  const errorPromise = next(claimant, "error");
  message(claimant, "join_room", { code: created.code });
  assert.equal((await errorPromise).code, "ROUND_PARTICIPANT_RESERVED");
  assert.equal(
    [...preAdmissionChallenges.values()].some(
      (challenge) => challenge.ws === claimant,
    ),
    false,
  );
  claimant.close();

  const finishedPromise = next(host, "round_finished");
  message(host, "end_round");
  await finishedPromise;
  const closed = next(host, "session_closed");
  message(host, "end_session");
  await closed;
  host.close();
  guest.close();
});

test("a player admitted during an active round is registered exactly once", async () => {
  const { host, code } = await createRoomWithPlayers(["late-admission-host"]);
  const room = await startClassicTestRound(host, code);
  const late = await client("late-admission-guest");
  const joined = next(late, "joined_room");
  message(late, "join_room", { code, name: "late-admission-guest" });
  await joined;
  assert.deepEqual([...room.round.participants.keys()], [
    "late-admission-host",
    "late-admission-guest",
  ]);
  const finished = await finishTestRound(host, [host, late]);
  assert.deepEqual(
    finished.ranking.map((player) => player.id),
    ["late-admission-host", "late-admission-guest"],
  );
  await closeTestRoom(host, [host, late]);
});

test("reconnecting an active participant preserves its record without duplication", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "reconnect-result-host",
    "reconnect-result-guest",
  ]);
  const guest = guests[0];
  const room = await startClassicTestRound(host, code);
  room.round.board = ["C", "A", "T", ...Array(13).fill("X")];
  await startRoundImmediately(host);
  const accepted = next(guest, "word_accepted");
  message(guest, "submit_word", { word: "CAT", path: [0, 1, 2] });
  await accepted;
  const reconnectToken = room.players.get("reconnect-result-guest").reconnectToken;
  const disconnected = nextMatching(
    host,
    "room_state",
    (state) =>
      state.players.find((player) => player.id === "reconnect-result-guest")
        ?.connected === false,
  );
  guest.close();
  await disconnected;

  const resumed = await client("reconnect-result-guest");
  const resumedPromise = next(resumed, "room_resumed");
  const statePromise = next(resumed, "room_state");
  message(resumed, "resume_room", { code, reconnectToken });
  await resumedPromise;
  await statePromise;
  assert.equal(room.round.participants.size, 2);
  assert.equal(room.players.get("reconnect-result-guest").score, 9);
  assert.deepEqual(room.players.get("reconnect-result-guest").words, [
    { word: "CAT", points: 9 },
  ]);

  const finished = await finishTestRound(host, [host, resumed]);
  assert.deepEqual(
    finished.ranking.map((player) => player.id),
    ["reconnect-result-guest", "reconnect-result-host"],
  );
  await closeTestRoom(host, [host, resumed]);
});

test("joining after completion does not alter the finished round result", async () => {
  const { host, code } = await createRoomWithPlayers(["finished-result-host"]);
  const room = await startClassicTestRound(host, code);
  const finished = await finishTestRound(host, [host]);
  const originalIds = finished.ranking.map((player) => player.id);
  const spectator = await client("after-result-spectator");
  const joined = next(spectator, "joined_room");
  const statePromise = next(spectator, "room_state");
  message(spectator, "join_room", { code, name: "after-result-spectator" });
  await joined;
  const state = await statePromise;
  assert.deepEqual(state.lastResult.ranking.map((player) => player.id), originalIds);
  assert.equal(room.round.participants.has("after-result-spectator"), false);
  assert.deepEqual(room.lastResult.ranking.map((player) => player.id), originalIds);
  await closeTestRoom(host, [host, spectator]);
});

test("live, resumed, and display finished results share participant IDs and order", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "propagation-result-host",
    "propagation-result-guest",
  ]);
  const guest = guests[0];
  const tokenPromise = next(host, "display_token");
  message(host, "create_display_token");
  const token = await tokenPromise;
  const display = await displayClient();
  const displayConnected = next(display, "display_state");
  message(display, "display_hello", { token: token.token });
  await displayConnected;
  const room = await startClassicTestRound(host, code);
  const finishedLive = next(host, "round_finished");
  const finishedGuest = next(guest, "round_finished");
  const finishedDisplay = nextMatching(
    display,
    "display_state",
    (message) => message.event === "round_finished",
  );
  message(host, "end_round");
  const finished = await finishedLive;
  await finishedGuest;
  const displayResult = await finishedDisplay;
  const expectedIds = finished.ranking.map((player) => player.id);
  assert.deepEqual(room.lastResult.ranking.map((player) => player.id), expectedIds);
  assert.deepEqual(
    displayResult.state.lastResult.ranking.map((player) => player.id),
    expectedIds,
  );

  const reconnectToken = room.players.get("propagation-result-host").reconnectToken;
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const resumed = await client("propagation-result-host");
  const resumedPromise = next(resumed, "room_resumed");
  const statePromise = next(resumed, "room_state");
  message(resumed, "resume_room", { code, reconnectToken });
  await resumedPromise;
  const state = await statePromise;
  assert.deepEqual(state.lastResult.ranking.map((player) => player.id), expectedIds);

  const closed = [next(resumed, "session_closed"), next(guest, "session_closed")];
  message(resumed, "end_session");
  await Promise.all(closed);
  resumed.close();
  guest.close();
  display.close();
});

test("a subsequent round receives a fresh participant set", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "fresh-round-host",
    "fresh-round-departed",
  ]);
  const departed = guests[0];
  const firstRound = await startClassicTestRound(host, code);
  const firstRoundId = firstRound.round.id;
  const left = next(departed, "session_left");
  message(departed, "leave_session");
  await left;
  const firstFinished = await finishTestRound(host, [host]);
  assert.deepEqual(firstFinished.ranking.map((player) => player.id), [
    "fresh-round-host",
    "fresh-round-departed",
  ]);

  const secondRound = await startClassicTestRound(host, code);
  assert.notEqual(secondRound.round.id, firstRoundId);
  assert.deepEqual([...secondRound.round.participants.keys()], ["fresh-round-host"]);
  const rejoined = await client("fresh-round-departed");
  const joined = next(rejoined, "joined_room");
  message(rejoined, "join_room", { code, name: "fresh-round-departed" });
  await joined;
  assert.deepEqual([...secondRound.round.participants.keys()], [
    "fresh-round-host",
    "fresh-round-departed",
  ]);
  const secondFinished = await finishTestRound(host, [host, rejoined]);
  assert.deepEqual(secondFinished.ranking.map((player) => player.id), [
    "fresh-round-host",
    "fresh-round-departed",
  ]);
  await closeTestRoom(host, [host, rejoined]);
  departed.close();
});

test("a skipped round keeps all participants and remains unrecorded", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "skipped-complete-host",
    "skipped-complete-first",
    "skipped-complete-second",
  ]);
  const room = await startClassicTestRound(host, code);
  const leaderboardBefore = fs.existsSync(process.env.WORDRUSH_LEADERBOARD_FILE)
    ? fs.readFileSync(process.env.WORDRUSH_LEADERBOARD_FILE, "utf8")
    : null;
  const finishedPromise = next(host, "round_finished");
  message(host, "skip_round", { roundId: room.round.id });
  const finished = await finishedPromise;
  assert.equal(finished.reason, "skipped");
  assert.equal(finished.recorded, false);
  assert.deepEqual(finished.ranking.map((player) => player.id), [
    "skipped-complete-host",
    "skipped-complete-first",
    "skipped-complete-second",
  ]);
  const leaderboardAfter = fs.existsSync(process.env.WORDRUSH_LEADERBOARD_FILE)
    ? fs.readFileSync(process.env.WORDRUSH_LEADERBOARD_FILE, "utf8")
    : null;
  assert.equal(leaderboardAfter, leaderboardBefore);
  await closeTestRoom(host, [host, ...guests]);
});

test("leaderboard recording receives one complete recordable participant ranking", async () => {
  const { host, guests, code } = await createRoomWithPlayers([
    "complete-leaderboard-host",
    "complete-leaderboard-scoring",
    "complete-leaderboard-zero",
  ]);
  const room = await startClassicTestRound(host, code);
  room.round.board = ["C", "A", "T", ...Array(13).fill("X")];
  await startRoundImmediately(host);
  const accepted = next(guests[0], "word_accepted");
  message(guests[0], "submit_word", { word: "CAT", path: [0, 1, 2] });
  await accepted;
  const finished = await finishTestRound(host, [host, ...guests]);
  const data = JSON.parse(fs.readFileSync(process.env.WORDRUSH_LEADERBOARD_FILE, "utf8"));
  const records = finished.ranking.map((player) => data.players[player.id]);
  assert.equal(records.length, 3);
  assert.ok(records.every(Boolean));
  assert.ok(records.every((record) => record.rounds === 1));
  assert.equal(data.players["complete-leaderboard-zero"].totalScore, 0);
  await closeTestRoom(host, [host, ...guests]);
});

test("authoritative multiplayer results populate trusted leaderboard persistence", async () => {
  const host = await client("leaderboard-winner");
  const guest = await client("leaderboard-loser");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code, name: "Leaderboard Loser" });
  await joinedPromise;
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  const started = await startedPromise;
  const room = rooms.get(created.code);
  room.round.board = ["C", "A", "T", ...Array(13).fill("X")];
  message(host, "start_round_now");
  const accepted = next(host, "word_accepted");
  message(host, "submit_word", { word: "CAT", path: [0, 1, 2] });
  await accepted;
  const finishedPromise = next(host, "round_finished");
  message(host, "end_round");
  const finished = await finishedPromise;
  const winnerResult = finished.ranking.find((player) => player.id === "leaderboard-winner");
  const loserResult = finished.ranking.find((player) => player.id === "leaderboard-loser");
  assert.equal(winnerResult.score, 9);
  assert.equal(loserResult.score, 0);
  const board = new Leaderboard(process.env.WORDRUSH_LEADERBOARD_FILE);
  assert.equal(board.profile("leaderboard-winner").totalScore, 9);
  assert.equal(board.profile("leaderboard-winner").multiplayerWins, 1);
  assert.equal(board.profile("leaderboard-loser").multiplayerLosses, 1);
  for (const period of ["weekly", "total", "multiplayer-wins", "multiplayer-ratio"])
    assert.ok(board.rankings(period).some((player) => player.id === "leaderboard-winner"), period);
  host.close();
  guest.close();
  assert.equal(started.config.label.length > 0, true);
});

test("a disconnected guest needs its private token to reclaim a room seat", async () => {
  const host = await client("persistent-guest-host");
  const guest = await client("persistent-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  const joined = await joinedPromise;

  const disconnectedStatePromise = nextMatching(
    host,
    "room_state",
    (state) =>
      state.players.find((player) => player.id === "persistent-guest")
        ?.connected === false,
  );
  guest.close();
  const disconnectedState = await disconnectedStatePromise;
  assert.equal(
    disconnectedState.players.find((player) => player.id === "persistent-guest")
      .connected,
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(rooms.get(created.code).players.has("persistent-guest"), true);

  const resumedGuest = await client("persistent-guest");
  const rejectedPromise = next(resumedGuest, "error");
  message(resumedGuest, "join_room", { code: created.code });
  assert.equal((await rejectedPromise).code, "RECONNECT_TOKEN_REQUIRED");
  const rejoinedPromise = next(resumedGuest, "joined_room");
  message(resumedGuest, "join_room", {
    code: created.code,
    reconnectToken: joined.reconnectToken,
  });
  const rejoined = await rejoinedPromise;
  assert.equal(rejoined.code, created.code);
  assert.notEqual(rejoined.reconnectToken, joined.reconnectToken);
  assert.equal(rooms.get(created.code).players.size, 2);

  const closedGuest = next(resumedGuest, "session_closed");
  message(host, "end_session");
  await closedGuest;
  host.close();
  resumedGuest.close();
});

test("room cleanup releases guests so they can create a new session", async () => {
  const host = await client("cleanup-host");
  const guest = await client("cleanup-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;
  const closedPromise = next(guest, "session_closed");
  message(host, "end_session");
  await closedPromise;
  const replacementPromise = next(guest, "room_created");
  message(guest, "create_room");
  const replacement = await replacementPromise;
  assert.equal(replacement.code.length, 5);
  guest.close();
  host.close();
});

test("host leave_session is rejected before consent mutation", async () => {
  const host = await client("host-leave-rejected");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const consentPromise = next(host, "adult_consent_request");
  message(host, "start_game", { mode: "dirty" });
  await consentPromise;
  const room = rooms.get(created.code);
  const errorPromise = next(host, "error");
  message(host, "leave_session");
  assert.equal((await errorPromise).code, "CREATOR_MUST_END_SESSION");
  assert.ok(room.pendingConsent);
  assert.equal(rooms.has(created.code), true);
  const closed = next(host, "session_closed");
  message(host, "end_session");
  await closed;
  assert.equal(rooms.has(created.code), false);
  host.close();
});

test("end_session is creator-only and invalidates room reconnect", async () => {
  const host = await client("end-session-host");
  const guest = await client("end-session-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;

  const guestError = next(guest, "error");
  message(guest, "end_session");
  assert.equal((await guestError).code, "CREATOR_ONLY");
  assert.equal(rooms.has(created.code), true);

  const hostClosed = next(host, "session_closed");
  const guestClosed = next(guest, "session_closed");
  message(host, "end_session");
  await Promise.all([hostClosed, guestClosed]);
  assert.equal(rooms.has(created.code), false);

  const resumed = await client("end-session-host");
  const resumeError = next(resumed, "error");
  message(resumed, "resume_room", {
    code: created.code,
    reconnectToken: created.reconnectToken,
  });
  assert.equal((await resumeError).code, "RESUME_FAILED");
  host.close();
  guest.close();
  resumed.close();
});

test("end_session closes pre-admission challenges without timeout or admission", async () => {
  const host = await client("pre-close-host");
  const guest = await client("pre-close-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const consentPromise = next(host, "adult_consent_request");
  message(host, "start_game", { mode: "dirty" });
  await consentPromise;
  const challengePromise = next(guest, "adult_pre_admission_challenge");
  message(guest, "join_room", { code: created.code });
  const challenge = await challengePromise;
  assert.equal(preAdmissionChallenges.has(challenge.challengeId), true);

  const hostClosed = next(host, "session_closed");
  const challengeClosed = next(guest, "session_closed");
  message(host, "end_session");
  assert.deepEqual(await challengeClosed, {
    type: "session_closed",
    code: created.code,
    reason: "creator_ended",
  });
  await hostClosed;
  assert.equal(preAdmissionChallenges.has(challenge.challengeId), false);
  assert.equal(rooms.has(created.code), false);

  let lateAdmission = false;
  const observeLateAdmission = (raw) => {
    if (JSON.parse(raw).type === "joined_room") lateAdmission = true;
  };
  guest.on("message", observeLateAdmission);
  message(guest, "adult_consent_response", {
    challengeId: challenge.challengeId,
    accepted: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  guest.off("message", observeLateAdmission);
  assert.equal(lateAdmission, false);
  assert.equal(rooms.has(created.code), false);
  host.close();
  guest.close();
});

test("leave_session while consent pending removes player and clears request", async () => {
  const host = await client("leave-consent-host");
  const guest = await client("leave-consent-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;
  const consentPromise = next(host, "adult_consent_request");
  message(host, "start_game", { mode: "dirty" });
  await consentPromise;
  const room = rooms.get(created.code);
  assert.ok(room.pendingConsent);
  message(guest, "leave_session");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(room.pendingConsent, null, "consent should be cleared");
  assert.equal(room.players.has("leave-consent-guest"), false, "guest should be removed");
  host.close();
});

test("challenge accepted after pending consent completes matches active round", async () => {
  const host = await client("chal-complete-host");
  const guest = await client("chal-complete-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = rooms.get(created.code);
  createPendingConsent(room, "dirty", { label: "DIRTY MODE", min: 3, size: 5, seconds: 180, rule: "Adult", target: null, sudden: false, chain: false, adult: true, party: false });
  const requestId = room.pendingConsent.requestId;
  const challengePromise = next(guest, "adult_pre_admission_challenge");
  message(guest, "join_room", { code: created.code });
  const challenge = await challengePromise;
  assert.equal(challenge.targetRequestId, requestId);
  message(host, "adult_consent_response", { requestId, accepted: true });
  await next(host, "round_started");
  assert.equal(room.round.adultConsentRequestId, requestId);
  const preAcceptedPromise = next(guest, "adult_pre_admission_accepted");
  const joinedPromise = next(guest, "joined_room");
  message(guest, "adult_consent_response", { challengeId: challenge.challengeId, accepted: true });
  const preAccepted = await preAcceptedPromise;
  assert.equal(preAccepted.challengeId, challenge.challengeId);
  assert.equal(preAccepted.code, created.code);
  const joined = await joinedPromise;
  assert.equal(joined.code, created.code);
  assert.equal(room.players.has("chal-complete-guest"), true);
  assert.equal(room.round.consentedPlayerIds.includes("chal-complete-guest"), true);
  host.close();
  guest.close();
});

test("public leaderboard submissions are rejected without touching persistence", async () => {
  const endpoint =
    "http://127.0.0.1:" + server.address().port + "/api/leaderboard/score";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "spoofed-player",
      name: "Imposter",
      score: 1000000,
      multiplayer: true,
      multiplayerWin: true,
    }),
  });
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), { error: "UNVERIFIED_SCORE" });
});

test("analytics configuration is disabled by default and validates GA4 IDs", async () => {
  const endpoint =
    "http://127.0.0.1:" + server.address().port + "/api/analytics-config";
  const previousId = process.env.WORDRUSH_GOOGLE_ANALYTICS_ID;
  const previousConsent = process.env.WORDRUSH_ANALYTICS_REQUIRE_CONSENT;
  try {
    delete process.env.WORDRUSH_GOOGLE_ANALYTICS_ID;
    delete process.env.WORDRUSH_ANALYTICS_REQUIRE_CONSENT;
    assert.deepEqual(await (await fetch(endpoint)).json(), {
      measurementId: null,
      requireConsent: true,
    });

    process.env.WORDRUSH_GOOGLE_ANALYTICS_ID = "not-a-measurement-id";
    assert.equal((await (await fetch(endpoint)).json()).measurementId, null);

    process.env.WORDRUSH_GOOGLE_ANALYTICS_ID = "g-abc12345";
    process.env.WORDRUSH_ANALYTICS_REQUIRE_CONSENT = "0";
    assert.deepEqual(await (await fetch(endpoint)).json(), {
      measurementId: "G-ABC12345",
      requireConsent: false,
    });
  } finally {
    if (previousId === undefined) delete process.env.WORDRUSH_GOOGLE_ANALYTICS_ID;
    else process.env.WORDRUSH_GOOGLE_ANALYTICS_ID = previousId;
    if (previousConsent === undefined)
      delete process.env.WORDRUSH_ANALYTICS_REQUIRE_CONSENT;
    else process.env.WORDRUSH_ANALYTICS_REQUIRE_CONSENT = previousConsent;
  }
});

test("analytics consent endpoint records only aggregate accept and deny counts", async () => {
  const endpoint =
    "http://127.0.0.1:" + server.address().port + "/api/analytics-consent";
  for (const choice of ["denied", "granted", "denied"]) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  const invalid = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choice: "maybe" }),
  });
  assert.equal(invalid.status, 400);
  const counts = JSON.parse(
    fs.readFileSync(process.env.WORDRUSH_ANALYTICS_CONSENT_FILE, "utf8"),
  );
  assert.equal(counts.granted, 1);
  assert.equal(counts.denied, 2);
  assert.match(counts.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("custom sudden death lifecycle stores canonical config and ends on non-duplicate invalid word", async () => {
  const ws = await client("custom-sudden-lifecycle");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const room = rooms.get(created.code);
  const customConfig = { label: "Sudden Test", min: 3, size: 4, seconds: 120, rule: "Test", sudden: true };
  const startedPromise = next(ws, "round_started");
  message(ws, "start_game", { mode: "custom", config: customConfig });
  const started = await startedPromise;
  assert.equal(started.mode, "custom");
  assert.equal(started.config.sudden, true);
  assert.equal(started.config.min, 3);
  assert.equal(started.config.size, 4);
  assert.equal(started.config.seconds, 120);
  assert.equal(started.config.chain, false);
  assert.equal(started.config.adult, false);
  assert.equal(started.config.party, false);
  assert.equal(started.config.target, null);
  room.round.board = ["C", "A", "T", "S", "X", "X", "X", "X", "X", "X", "X", "X", "X", "X", "X", "X"];
  room.round.startedAt = Date.now() - 1;
  room.round.endsAt = Date.now() + 60000;
  const startNowPromise = next(ws, "round_start_now");
  message(ws, "start_round_now");
  await startNowPromise;
  const acceptedPromise = next(ws, "word_accepted");
  message(ws, "submit_word", { word: "CAT", path: [0, 1, 2] });
  await acceptedPromise;
  const duplicatePromise = next(ws, "word_rejected");
  message(ws, "submit_word", { word: "CAT", path: [0, 1, 2] });
  const duplicate = await duplicatePromise;
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(room.status, "playing");
  const finishedPromise = next(ws, "round_finished");
  message(ws, "submit_word", { word: "XYZZY", path: [4, 5, 6, 7, 8] });
  const finished = await finishedPromise;
  assert.equal(finished.reason, "invalid_word");
  assert.ok(finished.suddenDeath);
  assert.equal(finished.suddenDeath.playerId, "custom-sudden-lifecycle");
  assert.equal(finished.suddenDeath.word, "XYZZY");
  ws.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reconnected = await client("custom-sudden-lifecycle");
  const resumedPromise = next(reconnected, "room_resumed");
  const statePromise = next(reconnected, "room_state");
  message(reconnected, "resume_room", { code: created.code, reconnectToken: created.reconnectToken });
  await resumedPromise;
  const resumed = await statePromise;
  assert.equal(resumed.status, "finished");
  assert.equal(resumed.config.sudden, true);
  assert.equal(resumed.config.min, 3);
  assert.equal(resumed.config.size, 4);
  reconnected.close();
});
