const assert = require("node:assert/strict");
const test = require("node:test");
const rules = require("../challenge-rules");

test("echo checkpoints are bounded, monotonic, and contain no word history", () => {
  const checkpoints = rules.normalizeEchoCheckpoints([
    { elapsedMs: 0, score: 0, word: "CAT" },
    { elapsedMs: 500, score: 9 },
    { elapsedMs: 500, score: 16 },
    { elapsedMs: 400, score: 25 },
    { elapsedMs: 1_000, score: 8 },
    { elapsedMs: 1_000, score: 25 },
    { elapsedMs: -1, score: 26 },
  ]);
  assert.deepEqual(checkpoints, [
    { elapsedMs: 0, score: 0 },
    { elapsedMs: 500, score: 16 },
    { elapsedMs: 1_000, score: 25 },
  ]);
  assert.equal(Object.isFrozen(checkpoints), true);
  assert.equal(Object.isFrozen(checkpoints[0]), true);

  const many = Array.from(
    { length: rules.MAX_ECHO_CHECKPOINTS + 10 },
    (_, index) => ({ elapsedMs: index, score: index }),
  );
  const bounded = rules.normalizeEchoCheckpoints(many);
  assert.equal(bounded.length, rules.MAX_ECHO_CHECKPOINTS);
  assert.deepEqual(bounded[0], { elapsedMs: 0, score: 0 });
  assert.deepEqual(bounded.at(-1), {
    elapsedMs: rules.MAX_ECHO_CHECKPOINTS + 9,
    score: rules.MAX_ECHO_CHECKPOINTS + 9,
  });
  assert.deepEqual(
    rules.recordEchoCheckpoint(checkpoints, { elapsedMs: 1_500, score: 34 }),
    [...checkpoints, { elapsedMs: 1_500, score: 34 }],
  );
});

test("blocked trace results reject frozen indexes without changing inputs", () => {
  const path = Object.freeze([0, 4, 8]);
  const frozen = Object.freeze([4, 12]);
  assert.deepEqual(rules.blockedTraceResult(path, frozen), {
    valid: false,
    reason: "frozen",
    index: 4,
  });
  assert.deepEqual(rules.blockedTraceResult([0, 8], frozen), {
    valid: true,
    reason: null,
    index: null,
  });
  assert.deepEqual(rules.blockedTraceResult([0, -1], frozen), {
    valid: false,
    reason: "trace",
    index: null,
  });
  assert.deepEqual(path, [0, 4, 8]);
  assert.deepEqual(frozen, [4, 12]);
});

test("bounty selection is deterministic and claim effects are immutable", () => {
  const candidates = [8, 0, 6, 4, 4, -1];
  const first = rules.selectBountyIndexes(candidates, 3, "daily-2026-08-05");
  const second = rules.selectBountyIndexes([...candidates].reverse(), 3, "daily-2026-08-05");
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.deepEqual(first, [...first].sort((left, right) => left - right));
  assert.equal(Object.isFrozen(first), true);

  const state = Object.freeze({
    bountyIndexes: Object.freeze([1, 4, 7]),
    claimedIndexes: Object.freeze([1]),
  });
  const effect = rules.bountyClaimEffect(state, [4, 7, 4, 9]);
  assert.deepEqual(effect, {
    changed: true,
    newlyClaimedIndexes: [4, 7],
    claimedIndexes: [1, 4, 7],
    remainingIndexes: [],
  });
  assert.equal(Object.isFrozen(effect), true);
  assert.equal(Object.isFrozen(effect.newlyClaimedIndexes), true);
  assert.deepEqual(state, {
    bountyIndexes: [1, 4, 7],
    claimedIndexes: [1],
  });
  assert.deepEqual(rules.bountyClaimEffect(state, [9]), {
    changed: false,
    newlyClaimedIndexes: [],
    claimedIndexes: [1],
    remainingIndexes: [4, 7],
  });
});

test("bounty word records reconcile zero, new, multiple, and claimed tiles", () => {
  const state = { bountyIndexes: [0, 1, 2], claimedIndexes: [] };
  const zero = rules.bountyClaimEffect(state, [9]);
  const one = rules.bountyClaimEffect(state, [0]);
  const multiple = rules.bountyClaimEffect(state, [0, 1, 1, 2]);
  const alreadyClaimed = rules.bountyClaimEffect(
    { ...state, claimedIndexes: [0] },
    [0, 9],
  );
  assert.deepEqual(rules.bountyWordRecord("cat", 9, zero.newlyClaimedIndexes), {
    word: "CAT",
    basePoints: 9,
    bonusPoints: 0,
    points: 9,
  });
  assert.equal(rules.bountyWordRecord("CAT", 9, one.newlyClaimedIndexes).points, 34);
  assert.deepEqual(rules.bountyWordRecord("CAT", 9, multiple.newlyClaimedIndexes), {
    word: "CAT",
    basePoints: 9,
    bonusPoints: 75,
    points: 84,
  });
  assert.equal(
    rules.bountyWordRecord("CAT", 9, alreadyClaimed.newlyClaimedIndexes).bonusPoints,
    0,
  );
});
