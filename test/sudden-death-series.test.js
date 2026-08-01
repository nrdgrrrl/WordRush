const test = require("node:test");
const assert = require("node:assert/strict");
const {
  INTERSTITIAL_MS,
  MAX_ACCEPTED_WORDS,
  ROUND_REASONS,
  TOTAL_ROUNDS,
  activeParticipants,
  cancelSeries,
  createSuddenDeathSeries,
  finalizeSeries,
  recordAcceptedWord,
  recordRound,
  withdrawParticipant,
} = require("../sudden-death-series");

const players = [
  { id: "alpha", name: "Alpha", avatar: "🐈" },
  { id: "beta", name: "Beta", avatar: "🦊" },
  { id: "gamma", name: "Gamma", avatar: "🐼" },
];

function round(series, roundNumber, reason = "timeout", loserId = null) {
  if (series.phase === "interstitial") {
    series.phase = "playing";
    series.transitionId = null;
    series.nextRoundAt = null;
  }
  return recordRound(series, {
    roundNumber,
    roundId: "round-" + roundNumber,
    reason,
    loserId,
    rejectedWord: loserId ? "NOPE" : "",
    participantIds: players.map((player) => player.id),
    gameplaySeconds: 2,
    transitionId: roundNumber < TOTAL_ROUNDS ? "transition-" + roundNumber : null,
    nextRoundAt: roundNumber < TOTAL_ROUNDS ? Date.now() + INTERSTITIAL_MS : null,
  });
}

test("sudden_series preset is fixed to ten bounded micro-rounds", () => {
  const series = createSuddenDeathSeries(players, {
    id: "series-1",
    accountingId: "accounting-1",
  });
  assert.equal(series.totalRounds, 10);
  assert.equal(series.currentRoundNumber, 1);
  assert.equal(series.phase, "playing");
  assert.deepEqual(activeParticipants(series).map((player) => player.id), [
    "alpha",
    "beta",
    "gamma",
  ]);
  assert.deepEqual(ROUND_REASONS, [
    "invalid_word",
    "timeout",
    "host_skip",
    "complete",
  ]);
});

test("ten rounds record outcome-only history and allow a final co-winner tie", () => {
  const series = createSuddenDeathSeries(players, {
    id: "series-tie",
    accountingId: "accounting-tie",
  });
  for (let number = 1; number <= TOTAL_ROUNDS; number++) {
    const loser = number % 2 ? "alpha" : "beta";
    assert.equal(round(series, number, "invalid_word", loser), true);
    if (number < TOTAL_ROUNDS) series.currentRoundNumber += 1;
  }
  assert.equal(series.phase, "finished");
  assert.equal(series.history.length, TOTAL_ROUNDS);
  assert.equal(series.history[0].rejectedWord, "NOPE");
  assert.equal(series.history[0].strikeAwarded, true);
  assert.equal(series.history[9].strikes.alpha, 5);
  assert.equal(series.history[9].strikes.beta, 5);
  assert.equal(finalizeSeries(series), true);
  assert.deepEqual(series.winnerIds, ["gamma"]);
});

test("two-player equal lowest strikes produce co-winners", () => {
  const series = createSuddenDeathSeries(players.slice(0, 2), {
    id: "series-co-winners",
    accountingId: "accounting-co-winners",
  });
  for (let number = 1; number <= TOTAL_ROUNDS; number++) {
    assert.equal(round(series, number, number === 1 ? "invalid_word" : "host_skip", number === 1 ? "alpha" : null), true);
    if (number < TOTAL_ROUNDS) series.currentRoundNumber += 1;
  }
  finalizeSeries(series);
  assert.deepEqual(series.winnerIds, ["beta"]);
  assert.equal(series.participants.find((player) => player.id === "alpha").strikes, 1);
  assert.equal(series.participants.find((player) => player.id === "beta").strikes, 0);

  const tie = createSuddenDeathSeries(players.slice(0, 2), {
    id: "series-true-tie",
    accountingId: "accounting-true-tie",
  });
  for (let number = 1; number <= TOTAL_ROUNDS; number++) {
    assert.equal(round(tie, number, "host_skip"), true);
    if (number < TOTAL_ROUNDS) tie.currentRoundNumber += 1;
  }
  finalizeSeries(tie);
  assert.deepEqual(tie.winnerIds, ["alpha", "beta"]);
});

test("only the submitting player strikes and multi-player survivors remain active", () => {
  const series = createSuddenDeathSeries(players, {
    id: "series-strikes",
    accountingId: "accounting-strikes",
  });
  assert.equal(round(series, 1, "invalid_word", "alpha"), true);
  assert.equal(series.participants.find((player) => player.id === "alpha").strikes, 1);
  assert.equal(series.participants.find((player) => player.id === "beta").strikes, 0);
  assert.equal(series.participants.find((player) => player.id === "gamma").strikes, 0);
});

test("timeouts and host skips settle without strikes, while duplicate rejection is not a settlement", () => {
  const series = createSuddenDeathSeries(players.slice(0, 2), {
    id: "series-no-strikes",
    accountingId: "accounting-no-strikes",
  });
  assert.equal(recordRound(series, {
    roundNumber: 1,
    roundId: "duplicate",
    reason: "duplicate",
  }), false);
  assert.equal(round(series, 1, "timeout"), true);
  series.currentRoundNumber = 2;
  assert.equal(round(series, 2, "host_skip"), true);
  assert.deepEqual(series.history.map((entry) => entry.reason), ["timeout", "host_skip"]);
  assert.deepEqual(series.history.map((entry) => entry.strikeAwarded), [false, false]);
  assert.deepEqual(series.participants.map((player) => player.strikes), [0, 0]);
});

test("settlement identity is consumed once and stale round numbers do nothing", () => {
  const series = createSuddenDeathSeries(players.slice(0, 2), {
    id: "series-stale",
    accountingId: "accounting-stale",
  });
  assert.equal(recordRound(series, {
    roundNumber: 2,
    roundId: "future",
    reason: "timeout",
  }), false);
  assert.equal(round(series, 1, "timeout"), true);
  assert.equal(recordRound(series, {
    roundNumber: 1,
    roundId: "round-1",
    reason: "timeout",
  }), false);
  assert.equal(series.history.length, 1);
});

test("withdrawn participants remain in bounded history but cannot win", () => {
  const series = createSuddenDeathSeries(players, {
    id: "series-withdrawn",
    accountingId: "accounting-withdrawn",
  });
  assert.equal(withdrawParticipant(series, "gamma"), true);
  assert.equal(activeParticipants(series).length, 2);
  assert.equal(round(series, 1, "invalid_word", "alpha"), true);
  for (let number = 2; number <= TOTAL_ROUNDS; number++) {
    series.currentRoundNumber = number;
    assert.equal(round(series, number, "host_skip"), true);
  }
  finalizeSeries(series);
  assert.deepEqual(series.winnerIds, ["beta"]);
  assert.equal(series.participants.find((player) => player.id === "gamma").status, "withdrawn");
  assert.equal(series.history.length, TOTAL_ROUNDS);
});

test("accepted-word and gameplay aggregates stay bounded", () => {
  const series = createSuddenDeathSeries(players.slice(0, 2), {
    id: "series-aggregate",
    accountingId: "accounting-aggregate",
  });
  for (let index = 0; index < MAX_ACCEPTED_WORDS + 20; index++)
    recordAcceptedWord(series, "alpha", "word-" + index, 100_000);
  const alpha = series.participants[0];
  assert.equal(alpha.acceptedWordCount, MAX_ACCEPTED_WORDS);
  assert.equal(alpha.acceptedWords.length, MAX_ACCEPTED_WORDS);
  assert.equal(alpha.aggregateScore, 1_000_000);
  assert.equal(round(series, 1, "timeout"), true);
  assert.equal(alpha.gameplaySeconds, 2);
});

test("cancellation records a recovery reason without producing winners", () => {
  const series = createSuddenDeathSeries(players.slice(0, 2), {
    id: "series-cancel",
    accountingId: "accounting-cancel",
  });
  assert.equal(cancelSeries(series, "generation_failed"), true);
  assert.equal(series.cancelledReason, "generation_failed");
  assert.equal(series.winnerIds.length, 0);
});
