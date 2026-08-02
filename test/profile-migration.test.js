const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OUTCOME_SEMANTICS_VERSION,
  withOutcomeSemanticsVersion,
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
