const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Leaderboard, SCHEMA_VERSION, TRUST_MODEL, weekKey } = require("../leaderboard");

test("leaderboard defaults stay writable for LAN and use state storage in production", () => {
  const script = "process.stdout.write(require('./leaderboard').DEFAULT_FILE)";
  const baseEnv = { ...process.env };
  delete baseEnv.NODE_ENV;
  delete baseEnv.STATE_DIRECTORY;
  delete baseEnv.WORDRUSH_LEADERBOARD_FILE;

  const local = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: baseEnv,
    encoding: "utf8",
  });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(local.stdout, path.join(__dirname, "..", "data", "leaderboard.json"));

  const production = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...baseEnv,
      NODE_ENV: "production",
      STATE_DIRECTORY: "/var/lib/wordrush",
    },
    encoding: "utf8",
  });
  assert.equal(production.status, 0, production.stderr);
  assert.equal(production.stdout, "/var/lib/wordrush/leaderboard.json");
});

test("leaderboard persists scores and separates weekly and total rankings", () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-leaderboard-")),
    "scores.json",
  );
  const board = new Leaderboard(file);
  board.recordScore({
    id: "alpha",
    name: "Alpha",
    avatar: "🐱",
    score: 120,
    words: 4,
    at: new Date(),
  });
  board.recordScore({
    id: "alpha",
    name: "Alpha",
    avatar: "🐱",
    score: 80,
    words: 3,
    at: new Date(),
  });
  board.recordScore({
    id: "beta",
    name: "Beta",
    avatar: "🦊",
    score: 150,
    at: new Date(),
  });
  board.recordScore({
    id: "alpha",
    name: "Alpha",
    avatar: "🐱",
    score: 20,
    multiplayer: true,
    multiplayerWin: true,
    at: new Date(),
  });
  board.recordScore({
    id: "beta",
    name: "Beta",
    avatar: "🦊",
    score: 10,
    multiplayer: true,
    multiplayerWin: false,
    at: new Date(),
  });
  assert.deepEqual(
    board.rankings("weekly").map((player) => [player.name, player.score]),
    [
      ["Alpha", 220],
      ["Beta", 160],
    ],
  );
  assert.equal(board.profile("alpha").totalScore, 220);
  const reloaded = new Leaderboard(file);
  assert.equal(reloaded.profile("alpha").totalWords, 7);
  assert.deepEqual(
    reloaded
      .rankings("multiplayer-wins")
      .map((player) => [player.name, player.score]),
    [["Alpha", 1]],
  );
  assert.equal(reloaded.profile("beta").multiplayerWinRatio, 0);
  assert.equal(weekKey(new Date("2026-07-14T12:00:00Z")), "2026-07-13");
});

test("leaderboard sanitizes identity text and caps untrusted score payloads", () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-leaderboard-limits-")),
    "scores.json",
  );
  const board = new Leaderboard(file);
  const player = board.recordScore({
    id: "limits",
    name: "\u0000LongNameThatWillBeTrimmedPastTwentyCharacters",
    avatar: "🐿️extra",
    score: Number.POSITIVE_INFINITY,
    words: 999999,
    gameSeconds: 999999,
    at: "not-a-date",
  });
  assert.equal(player.name.length <= 20, true);
  assert.equal(player.name.includes("\u0000"), false);
  assert.equal(player.avatar, "🐿️");
  assert.equal(player.totalScore, 1000000);
  assert.equal(player.totalWords, 10000);
  assert.equal(player.totalGameSeconds, 600);
});

test("leaderboard requires the current trusted schema and quarantines invalid files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-leaderboard-schema-"));
  const cases = [
    ["missing", null],
    ["malformed", "not json"],
    ["legacy", JSON.stringify({ players: { old: { id: "old" } } })],
    ["incompatible", JSON.stringify({ schemaVersion: 1, trustModel: TRUST_MODEL, players: {} })],
    ["structural", JSON.stringify({ schemaVersion: SCHEMA_VERSION, trustModel: TRUST_MODEL, players: { bad: null } })],
  ];
  for (const [label, contents] of cases) {
    const file = path.join(directory, label + ".json");
    if (contents !== null) fs.writeFileSync(file, contents);
    const board = new Leaderboard(file);
    assert.deepEqual(board.rankings("weekly"), []);
    assert.equal(board.profile("old"), null);
    if (contents !== null) {
      assert.throws(() => board.recordScore({ id: "should-not-overwrite", score: 1 }), /EXPLICIT_RESET/);
      assert.equal(fs.readFileSync(file, "utf8"), contents);
    }
  }
});

test("current trusted schema persists across all ranking periods", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-leaderboard-current-")), "scores.json");
  const board = new Leaderboard(file);
  board.recordScores([
    { id: "winner", name: "Winner", score: 50, words: 2, correct: 2, totalWordLength: 8, multiplayer: true, multiplayerWin: true },
    { id: "loser", name: "Loser", score: 20, words: 1, correct: 1, totalWordLength: 4, multiplayer: true, multiplayerWin: false },
  ]);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual({ schemaVersion: persisted.schemaVersion, trustModel: persisted.trustModel }, { schemaVersion: 2, trustModel: TRUST_MODEL });
  for (const period of ["weekly", "total", "multiplayer-wins", "multiplayer-ratio"])
    assert.ok(board.rankings(period).length > 0, period);
  const reloaded = new Leaderboard(file);
  assert.equal(reloaded.profile("winner").totalWords, 2);
  assert.equal(reloaded.profile("nobody"), null);
});
