const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  badgeForPlayer,
  createSuddenDeathOutcome,
  formatSuddenDeathOutcome,
  normalizeSuddenDeathOutcome,
  winnerIds,
} = require("../sudden-death-outcome");

const players = [
  { id: "loser", name: "Loser", avatar: "🐈" },
  { id: "alpha", name: "Alpha", avatar: "🦊" },
  { id: "beta", name: "Beta", avatar: "🐼" },
];

test("Sudden Death makes the other two-player participant the sole winner", () => {
  const outcome = createSuddenDeathOutcome({
    loser: players[0],
    participants: players.slice(0, 2),
    word: "xyZZy",
  });
  assert.deepEqual(outcome, {
    outcome: "sole_winner",
    loser: players[0],
    rejectedWord: "XYZZY",
    winner: players[1],
    survivors: [],
  });
  assert.deepEqual(winnerIds(outcome), ["alpha"]);
  assert.equal(badgeForPlayer(outcome, { ...players[0], score: 99 }), "ELIMINATED");
  assert.notEqual(badgeForPlayer(outcome, { ...players[0], score: 99 }), "WINNER");
  assert.equal(badgeForPlayer(outcome, { ...players[1], score: 1 }), "WINNER");
  assert.match(formatSuddenDeathOutcome(outcome), /Loser.*rejected word “XYZZY”/);
  assert.match(formatSuddenDeathOutcome(outcome), /Alpha.*winner/);
});

test("Sudden Death represents every three-player survivor without a sole winner", () => {
  const outcome = createSuddenDeathOutcome({
    loser: players[0],
    participants: players,
    word: "NOPE",
  });
  assert.equal(outcome.outcome, "survivors");
  assert.equal(outcome.winner, null);
  assert.deepEqual(outcome.survivors, players.slice(1));
  assert.deepEqual(winnerIds(outcome), ["alpha", "beta"]);
  assert.deepEqual(
    players.slice(1).map((player) => badgeForPlayer(outcome, { ...player, score: 0 })),
    ["SURVIVOR", "SURVIVOR"],
  );
  assert.equal(badgeForPlayer(outcome, { ...players[0], score: 100 }), "ELIMINATED");
  assert.match(formatSuddenDeathOutcome(outcome), /Survivors\/winners:.*Alpha.*Beta/);
  assert.doesNotMatch(formatSuddenDeathOutcome(outcome), /is the winner/);
});

test("single-player Sudden Death records a loser and no winner", () => {
  const outcome = createSuddenDeathOutcome({
    loser: players[0],
    participants: [players[0]],
    word: "NOPE",
  });
  assert.equal(outcome.outcome, "no_winner");
  assert.equal(outcome.winner, null);
  assert.deepEqual(outcome.survivors, []);
  assert.deepEqual(winnerIds(outcome), []);
  assert.equal(badgeForPlayer(outcome, { ...players[0], score: 100 }), "ELIMINATED");
  assert.match(formatSuddenDeathOutcome(outcome), /Loser.*rejected word “NOPE”/);
  assert.match(formatSuddenDeathOutcome(outcome), /No winner/);
  assert.deepEqual(normalizeSuddenDeathOutcome(outcome), outcome);
});

test("Sudden Death copy remains available when motion is reduced", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "custom.css"), "utf8");
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sudden-death-explosion\.is-active[\s\S]*?animation: none;[\s\S]*?opacity: 1;/,
  );
  assert.match(formatSuddenDeathOutcome({
    outcome: "sole_winner",
    loser: players[0],
    rejectedWord: "NOPE",
    winner: players[1],
    survivors: [],
  }), /Loser.*NOPE.*Alpha/);
});

test("Sudden Death ending remains opaque for its existing 4.5-second presentation", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "custom.css"), "utf8");
  assert.match(css, /\.sudden-death-explosion\.is-active \{ animation: sudden-death-screen 4\.5s ease-out both; \}/);
  assert.match(css, /@keyframes sudden-death-screen \{[\s\S]*?100% \{ opacity: 1; transform: scale\(1\) rotate\(0\); \}/);
  assert.match(css, /background: radial-gradient\(circle, rgb\(255 244 174\).*rgb\(91 45 127\) 100%\);/);
});
