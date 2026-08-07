const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OUTCOME_SEMANTICS_VERSION,
  withOutcomeSemanticsVersion,
  readProfileOutbox,
  writeProfileOutbox,
} = require("../profile-migration");

test("unversioned profiles receive the prospective outcome semantics marker", () => {
  const profile = {
    name: "Player",
    gamesWon: 7,
    gamesLost: 4,
    multiplayerWins: 2,
    multiplayerLosses: 3,
    maxGridWin: 8,
    completedMultiplayerRounds: ["result-1"],
    achievements: { speed: true },
  };
  const migrated = withOutcomeSemanticsVersion(profile);
  assert.equal(migrated.outcomeSemanticsVersion, OUTCOME_SEMANTICS_VERSION);
  assert.equal(profile.outcomeSemanticsVersion, undefined);
  assert.equal(migrated.gamesWon, 7);
  assert.equal(migrated.gamesLost, 4);
  assert.equal(migrated.multiplayerWins, 2);
  assert.equal(migrated.multiplayerLosses, 3);
  assert.equal(migrated.maxGridWin, 8);
  assert.deepEqual(migrated.completedMultiplayerRounds, ["result-1"]);
  assert.deepEqual(migrated.achievements, { speed: true });
});

test("malformed markers are sanitized without reconstructing historical totals", () => {
  const malformed = withOutcomeSemanticsVersion({
    outcomeSemanticsVersion: "old",
    gamesWon: 11,
    gamesLost: 9,
    score: 123,
  });
  assert.equal(malformed.outcomeSemanticsVersion, OUTCOME_SEMANTICS_VERSION);
  assert.equal(malformed.gamesWon, 11);
  assert.equal(malformed.gamesLost, 9);
  assert.equal(malformed.score, 123);
  assert.equal(
    withOutcomeSemanticsVersion({ outcomeSemanticsVersion: 3 }).outcomeSemanticsVersion,
    3,
  );
});

test("profile outbox persists account-scoped events and removes only acknowledged account events", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const eventA = {
    accountId: "account-a",
    eventId: "event-a",
    delta: { score: 5 },
    snapshot: { score: 5 },
  };
  const eventB = {
    accountId: "account-b",
    eventId: "event-b",
    delta: { score: 7 },
    snapshot: { score: 7 },
  };
  writeProfileOutbox(storage, "outbox", "account-a", [eventA]);
  writeProfileOutbox(storage, "outbox", "account-b", [eventB]);
  assert.deepEqual(readProfileOutbox(storage, "outbox", "account-a"), [eventA]);
  assert.deepEqual(readProfileOutbox(storage, "outbox", "account-b"), [eventB]);
  writeProfileOutbox(storage, "outbox", "account-a", []);
  assert.deepEqual(readProfileOutbox(storage, "outbox", "account-a"), []);
  assert.deepEqual(readProfileOutbox(storage, "outbox", "account-b"), [eventB]);
});
