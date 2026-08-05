const assert = require("node:assert/strict");
const test = require("node:test");
const rules = require("../heist-rules");

test("two-team assignments cover each known player once without changing inputs", () => {
  const players = Object.freeze(["host", "guest", "third", "fourth"]);
  const assignments = Object.freeze([
    Object.freeze({ id: "amber", playerIds: Object.freeze(["host", "third"]) }),
    Object.freeze({ id: "violet", playerIds: Object.freeze(["guest", "fourth"]) }),
  ]);
  const result = rules.validateTeamAssignments(players, assignments);
  assert.deepEqual(result, {
    valid: true,
    reason: null,
    teams: [
      { id: "amber", playerIds: ["host", "third"] },
      { id: "violet", playerIds: ["guest", "fourth"] },
    ],
    unassignedPlayerIds: [],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.teams[0]), true);
  assert.deepEqual(players, ["host", "guest", "third", "fourth"]);
  assert.deepEqual(assignments[0].playerIds, ["host", "third"]);
});

test("team assignments reject missing, duplicated, unknown, and empty memberships", () => {
  assert.equal(rules.validateTeamAssignments(["a", "b"], {
    red: ["a", "b"], blue: [],
  }).reason, "empty_team");
  const duplicate = rules.validateTeamAssignments(["a", "b", "c"], {
    red: ["a", "b"], blue: ["b", "c"],
  });
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.reason, "assignment");
  assert.deepEqual(duplicate.unassignedPlayerIds, []);
  assert.equal(rules.validateTeamAssignments(["a", "b"], [{ id: "red", playerIds: ["a"] }]).reason, "teams");
});

test("eligible claim words are bounded and default to six letters", () => {
  assert.deepEqual(rules.eligibleClaimWord(" planet "), {
    eligible: true,
    word: "PLANET",
    minimumLength: 6,
  });
  assert.deepEqual(rules.eligibleClaimWord("word", { minimumLength: 4 }), {
    eligible: true,
    word: "WORD",
    minimumLength: 4,
  });
  assert.equal(rules.eligibleClaimWord("short").eligible, false);
  assert.equal(rules.eligibleClaimWord("x".repeat(65)).eligible, false);
});

test("word claims award a team once and distinguish exact-word duplicates", () => {
  const state = Object.freeze({
    teams: Object.freeze([{ id: "amber" }, { id: "violet" }]),
    teamScores: Object.freeze({ amber: 10, violet: 4 }),
    claims: Object.freeze([]),
  });
  const first = rules.applyWordClaim(state, { teamId: "amber", word: "planet", points: 12 });
  assert.deepEqual(first, {
    changed: true,
    status: "claimed",
    word: "PLANET",
    teamId: "amber",
    pointsAwarded: 12,
    teamScores: { amber: 22, violet: 4 },
    claims: [{ word: "PLANET", teamId: "amber" }],
  });
  const same = rules.applyWordClaim({ ...state, ...first }, {
    teamId: "amber", word: "PLANET", points: 12,
  });
  assert.equal(same.status, "same_team_duplicate");
  assert.equal(same.changed, false);
  assert.equal(same.pointsAwarded, 0);
  const rival = rules.applyWordClaim({ ...state, ...first }, {
    teamId: "violet", word: "PLANET", points: 12,
  });
  assert.equal(rival.status, "cross_team_duplicate");
  assert.equal(rival.changed, false);
  assert.deepEqual(state.teamScores, { amber: 10, violet: 4 });
  assert.deepEqual(state.claims, []);
});
