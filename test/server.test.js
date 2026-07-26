const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const WebSocket = require("ws");
const { COMMON_WORDS, ADULT_WORDS } = require("../game-config");
const { neighbors } = require("../game-core");
process.env.RANDOM_RUSH_DELAY = "50";
process.env.WORDRUSH_ROOM_RECONNECT_GRACE_MS = "100";
process.env.WORDRUSH_MAX_WS_PER_IP = "100";
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
  displayTokens,
  displayCredentials,
  rateLimits,
  clientIp,
  pruneExpiredRateLimits,
  heartbeatSocket,
  WS_HEARTBEAT_MISSES,
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
test.before(
  () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
);
test.after(
  () =>
    new Promise((resolve) => {
      for (const room of rooms.values())
        room.players.forEach((player) => player.ws.close());
      for (const room of rooms.values()) room.displays.forEach((ws) => ws.close());
      rooms.clear();
      displayTokens.clear();
      displayCredentials.clear();
      server.close(resolve);
    }),
);
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
  assert.equal((await roundState).state.status, "playing");

  const closed = next(display, "session_closed");
  message(host, "leave_session");
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
  message(resumedHost, "leave_session");
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

test("every built-in multiplayer mode accepts a generated board word", async () => {
  const ws = await client("generated-word-scorer");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room", { mode: "classic" });
  const created = await createdPromise;
  await lobbyPromise;
  for (const mode of [
    "classic",
    "minimum",
    "sudden",
    "race",
    "coop",
    "dirty",
    "blitz",
    "longhaul",
    "storm",
    "scoreattack",
    "chain",
  ]) {
    const startedPromise = next(ws, "round_started");
    message(ws, "start_game", { mode });
    const started = await startedPromise;
    rooms.get(created.code).round.startedAt = Date.now() - 1;
    const candidates = mode === "dirty"
      ? [...COMMON_WORDS, ...ADULT_WORDS]
      : COMMON_WORDS;
    const word = candidates.find(
      (candidate) =>
        candidate.length >= started.config.min &&
        wordPath(started.round.board, started.round.size, candidate),
    );
    assert.ok(word, `${mode} board has a submit-ready word`);
    const accepted = nextMatching(
      ws,
      "word_accepted",
      (event) => event.playerId === "generated-word-scorer" && event.word === word,
    );
    message(ws, "submit_word", {
      word,
      path: wordPath(started.round.board, started.round.size, word),
    });
    await accepted;
    const finished = next(ws, "round_finished");
    message(ws, "end_round");
    await finished;
  }
  ws.close();
});

test("propagates player identities through room state, score updates, and rankings", async () => {
  const host = await client("identity-host");
  const guest = await client("identity-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room", { name: "VelvetWhisker", avatar: "🦊" });
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  const statePromise = next(host, "room_state");
  message(guest, "join_room", {
    code: created.code,
    name: "CosmicPaw",
    avatar: "🐼",
  });
  await joinedPromise;
  const state = await statePromise;
  assert.deepEqual(
    state.players.map((player) => [player.name, player.avatar]),
    [
      ["VelvetWhisker", "🦊"],
      ["CosmicPaw", "🐼"],
    ],
  );
  const room = rooms.get(created.code);
  room.status = "finished";
  room.round = null;
  const ranking = [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    score: player.score,
  }));
  assert.equal(
    ranking.find((player) => player.name === "CosmicPaw").avatar,
    "🐼",
  );
  host.close();
  guest.close();
});

test("multiplayer results accumulate session wins, losses, and total points", async () => {
  const host = await client("session-record-host");
  const guest = await client("session-record-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room", { name: "Record Host" });
  const created = await createdPromise;
  await lobbyPromise;
  const joined = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code, name: "Record Guest" });
  await joined;

  const firstStarted = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  await firstStarted;
  rooms.get(created.code).players.get("session-record-host").score = 25;
  rooms.get(created.code).players.get("session-record-guest").score = 9;
  const firstFinished = next(host, "round_finished");
  message(host, "end_round");
  const first = await firstFinished;
  assert.deepEqual(first.ranking.map((player) => [player.id, player.session]), [
    ["session-record-host", { wins: 1, losses: 0, points: 25 }],
    ["session-record-guest", { wins: 0, losses: 1, points: 9 }],
  ]);

  const secondStarted = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  await secondStarted;
  rooms.get(created.code).players.get("session-record-host").score = 4;
  rooms.get(created.code).players.get("session-record-guest").score = 36;
  const secondFinished = next(host, "round_finished");
  message(host, "end_round");
  const second = await secondFinished;
  const records = Object.fromEntries(
    second.ranking.map((player) => [player.id, player.session]),
  );
  assert.deepEqual(records, {
    "session-record-host": { wins: 1, losses: 1, points: 29 },
    "session-record-guest": { wins: 1, losses: 1, points: 45 },
  });

  const tiedStarted = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  await tiedStarted;
  rooms.get(created.code).players.get("session-record-host").score = 16;
  rooms.get(created.code).players.get("session-record-guest").score = 16;
  const tiedFinished = next(host, "round_finished");
  message(host, "end_round");
  const tied = await tiedFinished;
  assert.deepEqual(
    Object.fromEntries(tied.ranking.map((player) => [player.id, player.session])),
    {
      "session-record-host": { wins: 2, losses: 1, points: 45 },
      "session-record-guest": { wins: 2, losses: 1, points: 61 },
    },
  );

  const closed = next(guest, "session_closed");
  message(host, "leave_session");
  await closed;
  host.close();
  guest.close();
});

test("creator can launch cooperative multiplayer sessions", async () => {
  const host = await client("coop-host");
  const guest = await client("coop-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room", { name: "TeamHost" });
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code, name: "TeamGuest" });
  await joinedPromise;
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "coop" });
  const started = await startedPromise;
  assert.equal(started.config.label, "CO-OP");
  assert.equal(rooms.get(created.code).mode, "coop");
  host.close();
  guest.close();
});

test("creator leaving closes the session for every connected player", async () => {
  const host = await client("leaving-host");
  const guest = await client("leaving-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room", { name: "LeavingHost" });
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code, name: "LeavingGuest" });
  await joinedPromise;
  const closedHost = next(host, "session_closed");
  const closedGuest = next(guest, "session_closed");
  message(host, "leave_session");
  await closedHost;
  await closedGuest;
  assert.equal(rooms.has(created.code), false);
  host.close();
  guest.close();
});

test("creator can resume after a transient disconnect before the grace period expires", async () => {
  const host = await client("disconnecting-host");
  const guest = await client("disconnecting-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room", { name: "DisconnectingHost" });
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", {
    code: created.code,
    name: "DisconnectingGuest",
  });
  await joinedPromise;
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rooms.has(created.code), true);

  const resumedHost = await client("disconnecting-host");
  const resumedPromise = next(resumedHost, "room_resumed");
  message(resumedHost, "resume_room", {
    code: created.code,
    reconnectToken: created.reconnectToken,
  });
  assert.equal((await resumedPromise).code, created.code);
  assert.equal(
    rooms.get(created.code).players.get("disconnecting-host").ws.readyState,
    WebSocket.OPEN,
  );

  const closedGuest = next(guest, "session_closed");
  resumedHost.close();
  await closedGuest;
  assert.equal(rooms.has(created.code), false);
  guest.close();
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

  guest.close();
  await new Promise((resolve) => setTimeout(resolve, 150));
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
  message(host, "leave_session");
  await closedGuest;
  host.close();
  resumedGuest.close();
});

test("connection identity cannot be reset with a second hello", async () => {
  const host = await client("single-hello-host");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const rejectedPromise = next(host, "error");
  message(host, "hello", { guestId: "replacement-id" });
  assert.equal((await rejectedPromise).code, "HELLO_ALREADY_RECEIVED");
  assert.equal(rooms.get(created.code).creatorId, "single-hello-host");
  message(host, "leave_session");
  host.close();
});

test("random multiplayer sessions automatically advance to another round", async () => {
  const ws = await client("random-host");
  const createdPromise = next(ws, "room_created");
  const lobbyPromise = next(ws, "room_state");
  message(ws, "create_room", { name: "RandomHost" });
  const created = await createdPromise;
  await lobbyPromise;
  const firstRoundPromise = next(ws, "round_started");
  message(ws, "start_game", { mode: "random" });
  const labels = [(await firstRoundPromise).config.label];
  for (let round = 1; round < 6; round++) {
    const nextRoundPromise = next(ws, "round_started");
    message(ws, "end_round");
    labels.push((await nextRoundPromise).config.label);
  }
  assert.equal(new Set(labels).size, 6);
  assert.equal(labels.includes("DIRTY MODE · 18+"), false);
  assert.equal(labels.includes("CO-OP"), false);
  ws.close();
  rooms.delete(created.code);
});

test("competitive players can score the same word independently", async () => {
  const host = await client("shared-word-host");
  const guest = await client("shared-word-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room", { customWords: ["CAT"] });
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "classic" });
  await startedPromise;
  const room = rooms.get(created.code);
  room.round.startedAt = Date.now() - 1;
  room.round.board = [
    "C",
    "A",
    "T",
    "X",
    "X",
    "X",
    "X",
    "X",
    "X",
    "X",
    "X",
    "X",
    "X",
    "X",
    "X",
    "X",
  ];
  const hostAccepted = next(host, "word_accepted");
  message(host, "submit_word", { word: "CAT", path: [0, 1, 2] });
  await hostAccepted;
  const guestAccepted = nextMatching(
    guest,
    "word_accepted",
    (event) => event.playerId === "shared-word-guest",
  );
  message(guest, "submit_word", { word: "CAT", path: [0, 1, 2] });
  const accepted = await guestAccepted;
  assert.deepEqual(
    accepted.scores.map((player) => player.score),
    [9, 9],
  );
  const finishedPromise = next(host, "round_finished");
  message(host, "end_round");
  const finished = await finishedPromise;
  assert.deepEqual(
    finished.ranking.map((player) => player.words),
    [[{ word: "CAT", points: 9 }], [{ word: "CAT", points: 9 }]],
  );
  host.close();
  guest.close();
});

test("long haul leaves players with no words at zero", async () => {
  const host = await client("longhaul-host");
  const guest = await client("longhaul-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room", { customWords: ["PLANET"] });
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;
  const startedPromise = next(host, "round_started");
  message(host, "start_game", { mode: "longhaul" });
  const started = await startedPromise;
  const room = rooms.get(created.code);
  room.round.startedAt = Date.now() - 1;
  room.round.board = [
    "P", "L", "A", "N", "E", "T",
    ...Array(30).fill("X"),
  ];
  const accepted = next(host, "word_accepted");
  message(host, "submit_word", { word: "PLANET", path: [0, 1, 2, 3, 4, 5] });
  const scoreUpdate = await accepted;
  const guestScore = scoreUpdate.scores.find((player) => player.id === "longhaul-guest");
  assert.equal(guestScore.score, 0);
  const finishedPromise = next(host, "round_finished");
  message(host, "end_round");
  const finished = await finishedPromise;
  const guestResult = finished.ranking.find((player) => player.id === "longhaul-guest");
  assert.equal(guestResult.score, 0);
  assert.deepEqual(guestResult.words, []);
  assert.equal(started.config.min, 6);
  await Promise.all([
    new Promise((resolve) => {
      host.once("close", resolve);
      host.close();
    }),
    new Promise((resolve) => {
      guest.once("close", resolve);
      guest.close();
    }),
  ]);
});

test("creator can start a sanitized custom round for every player", async () => {
  const host = await client("custom-host");
  const guest = await client("custom-guest");
  const createdPromise = next(host, "room_created");
  const lobbyPromise = next(host, "room_state");
  message(host, "create_room");
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, "joined_room");
  message(guest, "join_room", { code: created.code });
  await joinedPromise;
  const hostStarted = next(host, "round_started");
  const guestStarted = next(guest, "round_started");
  message(host, "start_game", {
    mode: "custom",
    config: {
      label: "CUSTOM TEST",
      min: 6,
      size: 8,
      seconds: 45,
      rule: "Minimum 6 letters · 45 seconds",
    },
  });
  const [hostRound, guestRound] = await Promise.all([
    hostStarted,
    guestStarted,
  ]);
  assert.equal(hostRound.round.board.length, 64);
  assert.equal(hostRound.config.min, 6);
  assert.deepEqual(guestRound.round.board, hostRound.round.board);
  host.close();
  guest.close();
});

test("only the creator can end a round but every player can sync result controls", async () => {
  const host = await client("control-host");
  const guest = await client("control-guest");
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
  const deniedPromise = next(guest, "error");
  message(guest, "end_round");
  assert.equal((await deniedPromise).code, "CREATOR_ONLY");
  assert.equal(rooms.get(created.code).status, "playing");
  const finishedPromise = next(guest, "round_finished");
  message(host, "end_round");
  await finishedPromise;
  const profileResponse = await fetch(
    "http://127.0.0.1:" +
      server.address().port +
      "/api/leaderboard/control-host",
  );
  assert.equal(profileResponse.status, 200);
  assert.equal((await profileResponse.json()).multiplayerWins, 1);
  const hostSettings = next(host, "results_settings");
  const guestSettings = next(guest, "results_settings");
  message(guest, "set_results_settings", { view: "reveal", speed: "fast" });
  assert.deepEqual((await hostSettings).results, {
    view: "reveal",
    speed: "fast",
  });
  await guestSettings;
  assert.deepEqual(rooms.get(created.code).lastResult.results, {
    view: "reveal",
    speed: "fast",
  });
  host.close();
  guest.close();
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
  message(host, "leave_session");
  await closedPromise;
  const replacementPromise = next(guest, "room_created");
  message(guest, "create_room");
  const replacement = await replacementPromise;
  assert.equal(replacement.code.length, 5);
  guest.close();
  host.close();
});

test("security bookkeeping expires and direct LAN clients cannot spoof proxy IPs", () => {
  rateLimits.set("expired-test", { count: 1, expiresAt: 10 });
  pruneExpiredRateLimits(11);
  assert.equal(rateLimits.has("expired-test"), false);
  const request = {
    headers: { "x-forwarded-for": "203.0.113.8" },
    socket: { remoteAddress: "192.0.2.4" },
  };
  assert.equal(clientIp(request, true), "203.0.113.8");
  assert.equal(clientIp(request, false), "192.0.2.4");
});

test("static file serving rejects encoded paths outside the project root", async () => {
  const response = await fetch(
    "http://127.0.0.1:" + server.address().port + "/..%2Fpackage.json",
  );
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
});

test("static serving exposes only browser assets and keeps runtime data private", async () => {
  const request = (pathname) => new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:" + server.address().port + pathname, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
  assert.equal(await request("/board-core.js"), 200);
  assert.equal(await request("/analytics.js"), 200);
  assert.equal(await request("/data/leaderboard.json"), 404);
  assert.equal(await request("/server.js"), 404);
  assert.equal(await request("/.env"), 404);
});

test("home publishes crawlable SEO metadata and crawler routes", async () => {
  const origin = "http://127.0.0.1:" + server.address().port;
  const home = await fetch(origin + "/");
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("cache-control"), "no-cache");
  const html = await home.text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Wordrush — Fast Multiplayer Word Game<\/title>/);
  assert.match(html, /<meta\s+name="description"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/rush\.nrdgrrrl\.com\/"/);
  assert.match(html, /property="og:image"/);
  const jsonLd = JSON.parse(
    html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
  );
  assert.deepEqual(jsonLd["@context"], "https://schema.org");
  assert.ok(jsonLd["@graph"].some((entry) => entry["@type"] === "WebSite"));
  assert.ok(jsonLd["@graph"].some((entry) => entry["@type"]?.includes("WebApplication")));

  const robots = await fetch(origin + "/robots.txt");
  assert.equal(robots.status, 200);
  assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(await robots.text(), /Sitemap: https:\/\/rush\.nrdgrrrl\.com\/sitemap\.xml/);

  const sitemap = await fetch(origin + "/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.equal(sitemap.headers.get("content-type"), "application/xml");
  assert.match(await sitemap.text(), /<loc>https:\/\/rush\.nrdgrrrl\.com\/<\/loc>/);

  const manifest = await fetch(origin + "/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("content-type"), "application/manifest+json");
  assert.equal((await manifest.json()).short_name, "Wordrush");

  const favicon = await fetch(origin + "/favicon.svg");
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/svg+xml");

  const receiver = await fetch(origin + "/receiver/");
  assert.equal(receiver.status, 200);
  assert.equal(receiver.headers.get("x-robots-tag"), "noindex, nofollow");
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
