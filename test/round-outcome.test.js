const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyMultiplayerParticipant,
  classifySoloOutcome,
  outcomeAccounting,
} = require("../round-outcome");

const FREE_PLAY = { target: null, sudden: false };
const TARGET = { target: 100, sudden: false };
const SUDDEN = { target: null, sudden: true };

function classify(id, ranking, options = {}) {
  return classifyMultiplayerParticipant({
    participantId: id,
    ranking,
    ...options,
  });
}

test("free-play solo rounds are neutral at zero and positive scores", () => {
  assert.equal(classifySoloOutcome(FREE_PLAY, "manual"), "neutral");
  assert.equal(classifySoloOutcome(FREE_PLAY, "timeout"), "neutral");
  assert.equal(classifySoloOutcome({ ...FREE_PLAY, score: 42 }, "manual"), "neutral");
});

test("target solo rounds win only when the target is explicitly reached", () => {
  assert.equal(classifySoloOutcome(TARGET, "target_reached"), "win");
  assert.equal(classifySoloOutcome(TARGET, "timeout"), "loss");
  assert.equal(classifySoloOutcome(TARGET, "manual"), "loss");
  assert.equal(classifySoloOutcome(TARGET, "fatal_rejection"), "neutral");
  assert.equal(
    classifySoloOutcome({ target: 100, sudden: true }, "timeout"),
    "neutral",
  );
  assert.equal(
    classifySoloOutcome({ target: null, sudden: true, series: true }, "timeout"),
    "neutral",
  );
});

test("Sudden Death solo rounds win on timeout and lose on fatal or manual ending", () => {
  assert.equal(classifySoloOutcome(SUDDEN, "timeout"), "win");
  assert.equal(classifySoloOutcome(SUDDEN, "fatal_rejection"), "loss");
  assert.equal(classifySoloOutcome(SUDDEN, "manual"), "loss");
  assert.equal(classifySoloOutcome(SUDDEN, "target_reached"), "neutral");
  assert.equal(classifySoloOutcome(SUDDEN, "unknown"), "neutral");
});

test("ordinary competitive multiplayer uses authoritative highest-score ties", () => {
  const ranking = [
    { id: "winner", score: 12 },
    { id: "tied", score: 12 },
    { id: "loser", score: 3 },
  ];
  assert.equal(classify("winner", ranking), "win");
  assert.equal(classify("tied", ranking), "win");
  assert.equal(classify("loser", ranking), "loss");
  assert.equal(classify("missing", ranking), "neutral");
  assert.equal(
    classify("zero-a", [
      { id: "zero-a", score: 0 },
      { id: "zero-b", score: 0 },
    ]),
    "win",
  );
});

test("co-op multiplayer is neutral despite scores", () => {
  assert.equal(
    classify("co-op-player", [{ id: "co-op-player", score: 20 }], {
      cooperative: true,
    }),
    "neutral",
  );
});

test("valid Sudden Death rejection payload overrides score ranking", () => {
  const ranking = [
    { id: "loser", score: 50 },
    { id: "winner", score: 1 },
    { id: "survivor", score: 0 },
  ];
  const soleWinner = {
    outcome: "sole_winner",
    loser: { id: "loser", name: "Loser" },
    winner: { id: "winner", name: "Winner" },
    survivors: [],
    rejectedWord: "NOPE",
  };
  assert.equal(
    classify("winner", ranking, {
      suddenDeath: soleWinner,
      reason: "invalid_word",
    }),
    "win",
  );
  assert.equal(
    classify("loser", ranking, {
      suddenDeath: soleWinner,
      reason: "invalid_word",
    }),
    "loss",
  );
  assert.equal(
    classify("survivor", ranking, {
      suddenDeath: soleWinner,
      reason: "invalid_word",
    }),
    "neutral",
  );

  const survivors = {
    outcome: "survivors",
    loser: { id: "loser", name: "Loser" },
    winner: null,
    survivors: [
      { id: "winner", name: "Winner" },
      { id: "survivor", name: "Survivor" },
    ],
    rejectedWord: "NOPE",
  };
  assert.equal(
    classify("winner", ranking, { suddenDeath: survivors, reason: "invalid_word" }),
    "win",
  );
  assert.equal(
    classify("survivor", ranking, { suddenDeath: survivors, reason: "invalid_word" }),
    "win",
  );

  const noWinner = {
    outcome: "no_winner",
    loser: { id: "loser", name: "Loser" },
    winner: null,
    survivors: [],
    rejectedWord: "NOPE",
  };
  assert.equal(
    classify("loser", [{ id: "loser", score: 0 }], {
      suddenDeath: noWinner,
      reason: "invalid_word",
    }),
    "loss",
  );
  assert.equal(
    classify("loser", ranking, {
      suddenDeath: null,
      reason: "invalid_word",
    }),
    "neutral",
  );
});

test("Sudden Death timeout and manual endings use authoritative score ranking", () => {
  const ranking = [
    { id: "winner", score: 20 },
    { id: "loser", score: 10 },
  ];
  assert.equal(classify("winner", ranking, { reason: "timeout" }), "win");
  assert.equal(classify("loser", ranking, { reason: "timeout" }), "loss");
  assert.equal(classify("winner", ranking, { reason: "manual" }), "win");
  assert.equal(classify("loser", ranking, { reason: "manual" }), "loss");
});

test("completed Sudden Death series accounts active winners and losers only", () => {
  const ranking = [
    { id: "winner", score: 30, series: { status: "active" } },
    { id: "loser", score: 20, series: { status: "active" } },
    { id: "withdrawn", score: 40, series: { status: "withdrawn" } },
  ];
  const options = {
    series: { winnerIds: ["winner"] },
    seriesComplete: true,
  };
  assert.equal(classify("winner", ranking, options), "win");
  assert.equal(classify("loser", ranking, options), "loss");
  assert.equal(classify("withdrawn", ranking, options), "neutral");
  assert.equal(classify("absent", ranking, options), "neutral");
});

test("outcome deltas keep neutral counters and max-grid eligibility explicit", () => {
  assert.deepEqual(outcomeAccounting("win"), {
    gamesWon: 1,
    gamesLost: 0,
    multiplayerWins: 0,
    multiplayerLosses: 0,
    updatesMaxGridWin: true,
  });
  assert.deepEqual(outcomeAccounting("loss", { multiplayer: true }), {
    gamesWon: 0,
    gamesLost: 1,
    multiplayerWins: 0,
    multiplayerLosses: 1,
    updatesMaxGridWin: false,
  });
  assert.deepEqual(outcomeAccounting("neutral", { multiplayer: true }), {
    gamesWon: 0,
    gamesLost: 0,
    multiplayerWins: 0,
    multiplayerLosses: 0,
    updatesMaxGridWin: false,
  });
  assert.deepEqual(outcomeAccounting("invalid", { multiplayer: true }), {
    gamesWon: 0,
    gamesLost: 0,
    multiplayerWins: 0,
    multiplayerLosses: 0,
    updatesMaxGridWin: false,
  });
});
