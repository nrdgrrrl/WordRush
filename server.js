const RANDOM_RUSH_DELAY = Number(process.env.RANDOM_RUSH_DELAY || 20000);
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { WebSocketServer } = require("ws");
const {
  MODE_CONFIG,
  createLexicon,
  generateBoard,
  validateSubmission,
  normalizeWords,
} = require("./game-core");
const PORT = Number(process.env.PORT || 8000),
  HOST = process.env.HOST || "0.0.0.0",
  MAX_PLAYERS = 10,
  rooms = new Map(),
  clients = new Map();
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
function roomConfig(room) {
  return MODE_CONFIG[room.mode] || MODE_CONFIG.classic;
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
function broadcast(room, message) {
  for (const player of room.players.values()) send(player.ws, message);
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
}
function randomMode(previous) {
  const modes = ["classic", "minimum", "sudden", "race", "coop", "dirty"];
  const choices = modes.filter((mode) => mode !== previous);
  return choices[crypto.randomInt(choices.length)];
}
function startRound(room, selected = room.mode) {
  clearRoomTimer(room);
  room.mode = MODE_CONFIG[selected] ? selected : "classic";
  const config = MODE_CONFIG[room.mode],
    board = generateBoard(
      config.size,
      createLexicon(room.mode, [...room.customWords]),
    );
  room.round = {
    board: board,
    size: config.size,
    found: new Set(),
    endsAt: Date.now() + config.seconds * 1000,
    timer: null,
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
        startRound(room, randomMode(room.mode));
    }, RANDOM_RUSH_DELAY);
    room.rushTimer.unref?.();
  }
}
function leave(ws) {
  const info = clients.get(ws);
  if (!info) return;
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
      teamScore: 0,
      customWords: new Set(normalizeWords(message.customWords)),
      players: new Map(),
      status: "lobby",
      round: null,
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
      return startRound(room, randomMode(room.mode));
    }
    room.randomRush = false;
    return startRound(room, MODE_CONFIG[requested] ? requested : "classic");
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
      mode: room.mode,
      found: room.mode === "coop" ? room.round.found : player.found,
      customWords: [...room.customWords],
    });
    if (!result.valid) {
      send(ws, {
        type: "word_rejected",
        playerId: client.id,
        word: result.word,
        reason: result.reason,
      });
      if (room.mode === "sudden" && result.reason !== "duplicate")
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
    if (room.mode === "race" && player.score >= 500) finishRound(room, "race");
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
      ".js": "text/javascript",
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
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    try {
      handle(ws, JSON.parse(raw));
    } catch {
      send(ws, { type: "error", code: "BAD_MESSAGE" });
    }
  });
  ws.on("close", () => leave(ws));
});
if (require.main === module)
  server.listen(PORT, HOST, () =>
    console.log("Wordrush listening on http://" + HOST + ":" + PORT),
  );
module.exports = { server, rooms, handle, MAX_PLAYERS };

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
    const handled = await leaderboardRequest(req, res);
    if (!handled && !res.writableEnded) originalRequestHandler(req, res);
  } catch {
    if (!res.writableEnded) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "INTERNAL_ERROR" }));
    }
  }
});
