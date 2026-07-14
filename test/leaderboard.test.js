const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Leaderboard, weekKey } = require("../leaderboard");

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
