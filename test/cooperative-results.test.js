const test = require("node:test");
const assert = require("node:assert/strict");
const {
  contribution,
  normalizeResultPresentation,
} = require("../cooperative-results");

function presentation(result, ranking) {
  return normalizeResultPresentation({ result, ranking });
}

test("co-op result presentation keeps two player contributions separate from the shared score", () => {
  const result = presentation({ cooperative: true, teamScore: 34 }, [
    {
      id: "first",
      score: 34,
      words: [{ word: "PLANETS", points: 25 }],
    },
    {
      id: "second",
      score: 34,
      words: [{ word: "DOG", points: 9 }],
    },
  ]);

  assert.equal(result.cooperative, true);
  assert.equal(result.teamScore, 34);
  assert.deepEqual(
    result.players.map((player) => ({ id: player.id, contribution: player.contribution })),
    [
      { id: "first", contribution: 25 },
      { id: "second", contribution: 9 },
    ],
  );
});

test("co-op presentation gives a zero-word player a zero contribution", () => {
  const result = presentation({ cooperative: true, teamScore: 9 }, [
    { id: "finder", score: 9, words: [{ word: "CAT", points: 9 }] },
    { id: "helper", score: 9, words: [] },
  ]);

  assert.equal(result.teamScore, 9);
  assert.equal(result.players[1].contribution, 0);
});

test("a no-word co-op round retains its authoritative team score and zero contributions", () => {
  const result = presentation({ cooperative: true, teamScore: 0 }, [
    { id: "first", score: 0, words: [] },
    { id: "second", score: 0 },
  ]);

  assert.equal(result.teamScore, 0);
  assert.deepEqual(result.players.map((player) => player.contribution), [0, 0]);
});

test("phone static, phone reveal, and Cast consume the same co-op result normalization", () => {
  const result = presentation({ cooperative: true, teamScore: 13 }, [
    { id: "first", score: 13, words: [{ word: "FISH", points: 16 }, { word: "CAT", points: -3 }] },
    { id: "second", score: 13, words: [] },
  ]);
  const staticView = {
    teamScore: result.teamScore,
    contributions: result.players.map((player) => player.contribution),
  };
  const animatedView = {
    teamScore: result.teamScore,
    contributions: result.players.map((player) => contribution(player.words)),
  };
  const castView = {
    teamScore: result.teamScore,
    contributions: result.players.map((player) => player.contribution),
  };

  assert.deepEqual(animatedView, staticView);
  assert.deepEqual(castView, staticView);
});

test("competitive result normalization leaves the authoritative score contract unchanged", () => {
  const result = presentation({ cooperative: false, teamScore: 99 }, [
    { id: "winner", score: 17, words: [{ word: "FISH", points: 16 }] },
  ]);

  assert.equal(result.cooperative, false);
  assert.equal(result.teamScore, null);
  assert.equal(result.players[0].score, 17);
  assert.equal(result.players[0].contribution, 16);
});
