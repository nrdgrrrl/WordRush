const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NAMED_PROFILES,
  FAILURE_CODES,
  getQualityProfile,
  evaluateBoardQuality,
  compareRanking,
} = require("../board-quality");

function report(overrides = {}) {
  return {
    totalPlayableWords: 240,
    lengthBuckets: { "3-4": 100, "5-6": 75, "7-8": 20, "9+": 2 },
    longestPlayableLength: 9,
    coverage: {
      all: { tileCount: 24 },
      medium: { tileCount: 23 },
      long: { tileCount: 16 },
    },
    largestConnectedUnusedRegion: { size: 0 },
    largestLowValueConnectedRegion: { size: 0 },
    spatialDistribution: {
      long: {
        rows: [1, 1, 2, 1, 1].map((coveredTileCount) => ({ coveredTileCount })),
        columns: [1, 1, 2, 1, 1].map((coveredTileCount) => ({ coveredTileCount })),
      },
    },
    concentration: {
      medium: { topQuarterParticipationPercentage: 30 },
      long: { topQuarterParticipationPercentage: 35 },
    },
    ...overrides,
  };
}

test("all six named profiles are immutable and selected exactly", () => {
  const expected = [
    [4, 3, "classic", "4x4-min3"],
    [5, 3, "classic", "5x5-min3"],
    [5, 3, "dirty", "dirty-5x5-min3"],
    [6, 5, "classic", "6x6-min5"],
    [6, 6, "classic", "6x6-min6"],
    [8, 3, "classic", "8x8-min3"],
  ];
  for (const [size, minimum, mode, id] of expected) {
    const profile = getQualityProfile(size, minimum, mode);
    assert.equal(profile.profileId, id);
    assert.equal(profile.measured, undefined);
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.gates), true);
    assert.equal(Object.isFrozen(NAMED_PROFILES[id]), true);
  }
});

test("custom profiles use a conservative same-size fallback", () => {
  const profile = getQualityProfile(5, 4, "classic");
  assert.equal(profile.profileId, "5x5-min4");
  assert.equal(profile.sourceProfileId, "5x5-min4");
  assert.equal(profile.measured, true);
  assert.equal(profile.sourceCalibration, "phase5-custom-ui-v1:50");
  assert.equal(profile.gates.totalWords[2], 171);
  assert.equal(profile.gates.allCoverage[2], 24);
  assert.equal(getQualityProfile(5, 3, "dirty").profileId, "dirty-5x5-min3");
  for (const [size, minimum] of [
    [4, 4], [4, 5], [4, 6], [5, 4], [5, 5], [5, 6],
    [6, 3], [6, 4], [8, 4], [8, 5], [8, 6],
  ]) assert.equal(getQualityProfile(size, minimum, "classic").measured, true);
  for (const size of [4, 5, 6, 8])
    for (const minimum of [3, 4, 5, 6])
      if (!(size === 5 && minimum === 3))
        assert.equal(getQualityProfile(size, minimum, "dirty").measured, true);
});

test("unsupported minimum-seven profiles omit impossible medium gates", () => {
  const cases = [
    { size: 4, mode: "classic", source: "4x4-min3", total: 121, long: 2, longest: 7, all: 16, longCoverage: 12 },
    { size: 7, mode: "classic", source: "4x4-min3", total: 121, long: 2, longest: 7, all: 49, longCoverage: 37 },
    { size: 4, mode: "dirty", source: "dirty-5x5-min3", total: 126, long: 3, longest: 8, all: 16, longCoverage: 10 },
    { size: 7, mode: "dirty", source: "dirty-5x5-min3", total: 126, long: 3, longest: 8, all: 49, longCoverage: 30 },
  ];
  for (const scenario of cases) {
    const profile = getQualityProfile(scenario.size, 7, scenario.mode);
    assert.equal(profile.sourceProfileId, scenario.source);
    assert.equal(profile.gates.mediumWords, undefined);
    assert.equal(profile.gates.mediumCoverage, undefined);
    assert.equal(profile.gates.longestLength[2] >= 7, true);
    assert.equal(profile.gates.longWords[2] >= 1, true);
    const boardReport = report({
      totalPlayableWords: scenario.total,
      lengthBuckets: { "3-4": 0, "5-6": 0, "7-8": scenario.long, "9+": 0 },
      longestPlayableLength: scenario.longest,
      coverage: { all: { tileCount: scenario.all }, long: { tileCount: scenario.longCoverage } },
      spatialDistribution: {
        long: {
          rows: Array(scenario.size).fill({ coveredTileCount: 1 }),
          columns: Array(scenario.size).fill({ coveredTileCount: 1 }),
        },
      },
    });
    assert.equal(evaluateBoardQuality(boardReport, profile, `${scenario.mode}-${scenario.size}`).passed, true);
  }
});

test("quality evaluation returns stable codes and omits redundant gates", () => {
  const profile = getQualityProfile(5, 3, "classic");
  const result = evaluateBoardQuality(report({
    totalPlayableWords: 10,
    largestConnectedUnusedRegion: { size: 25 },
    largestLowValueConnectedRegion: { size: 2 },
  }), profile, "board-a");
  assert.equal(result.passed, false);
  assert.deepEqual(result.failureReasons, [
    "TOTAL_WORDS_LOW",
    "LOW_VALUE_REGION_LARGE",
  ]);
  assert.equal(result.failureReasons.includes("UNUSED_REGION_LARGE"), false);
  assert.equal(result.failureReasons.includes("MEDIUM_CONCENTRATION_HIGH"), false);
  assert.deepEqual(FAILURE_CODES.includes("LONG_SPATIAL_REACH_LOW"), true);
});

test("concentration changes ranking but never hard-gate pass", () => {
  const profile = getQualityProfile(5, 3, "classic");
  const concentrated = evaluateBoardQuality(report({
    concentration: {
      medium: { topQuarterParticipationPercentage: 90 },
      long: { topQuarterParticipationPercentage: 90 },
    },
  }), profile, "board-a");
  const broad = evaluateBoardQuality(report({
    concentration: {
      medium: { topQuarterParticipationPercentage: 20 },
      long: { topQuarterParticipationPercentage: 20 },
    },
  }), profile, "board-b");
  assert.equal(concentrated.passed, true);
  assert.equal(broad.passed, true);
  assert.equal(compareRanking(broad, concentrated) > 0, true);
});

test("broad long depth outranks a one-character longest-word gain", () => {
  const profile = getQualityProfile(5, 3, "classic");
  const broad = evaluateBoardQuality(report({
    lengthBuckets: { "3-4": 100, "5-6": 80, "7-8": 30, "9+": 3 },
    longestPlayableLength: 9,
    coverage: { all: { tileCount: 25 }, medium: { tileCount: 24 }, long: { tileCount: 20 } },
  }), profile, "broad");
  const narrow = evaluateBoardQuality(report({
    lengthBuckets: { "3-4": 100, "5-6": 70, "7-8": 6, "9+": 1 },
    longestPlayableLength: 10,
    coverage: { all: { tileCount: 25 }, medium: { tileCount: 23 }, long: { tileCount: 16 } },
  }), profile, "narrow");
  assert.equal(compareRanking(broad, narrow) > 0, true);
});

test("fingerprint is the deterministic final tie-break", () => {
  const profile = getQualityProfile(5, 3, "classic");
  const left = evaluateBoardQuality(report(), profile, "0000");
  const right = evaluateBoardQuality(report(), profile, "ffff");
  assert.equal(compareRanking(left, right) > 0, true);
});
