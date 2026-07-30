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

function longOnlyReport({ size, wordCount, ninePlusWords = 0, longestLength, coverage, spatialReach = 1 }) {
  return report({
    totalPlayableWords: wordCount,
    lengthBuckets: {
      "3-4": 0,
      "5-6": 0,
      "7-8": wordCount - ninePlusWords,
      "9+": ninePlusWords,
    },
    longestPlayableLength: longestLength,
    coverage: {
      all: { tileCount: coverage },
      medium: { tileCount: 0 },
      long: { tileCount: coverage },
    },
    spatialDistribution: {
      long: {
        rows: Array(size).fill({ coveredTileCount: spatialReach }),
        columns: Array(size).fill({ coveredTileCount: spatialReach }),
      },
    },
  });
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

test("unsupported long-only fallbacks use consistent metric families", () => {
  const cases = [
    { size: 4, mode: "classic", source: "4x4-min6", words: 4, longest: 8, coverage: 14, spatialReach: 2 },
    { size: 7, mode: "classic", source: "4x4-min3", words: 2, longest: 7, coverage: 37, spatialReach: 1 },
    { size: 4, mode: "dirty", source: "dirty-4x4-min6", words: 1, longest: 7, coverage: 7, spatialReach: 1 },
    { size: 7, mode: "dirty", source: "dirty-5x5-min3", words: 3, longest: 8, coverage: 30, spatialReach: 1 },
  ];
  for (const scenario of cases) {
    const profile = getQualityProfile(scenario.size, 7, scenario.mode);
    assert.equal(profile.sourceProfileId, scenario.source);
    assert.equal(profile.gates.totalWords, undefined);
    assert.equal(profile.gates.mediumWords, undefined);
    assert.equal(profile.gates.allCoverage, undefined);
    assert.equal(profile.gates.mediumCoverage, undefined);
    assert.equal(profile.gates.ninePlusWords, undefined);
    assert.equal(profile.gates.longWords[2] >= 1, true);
    assert.equal(profile.gates.longestLength[2] >= 7, true);
    const boardReport = longOnlyReport({
      size: scenario.size,
      wordCount: scenario.words,
      longestLength: scenario.longest,
      coverage: scenario.coverage,
      spatialReach: scenario.spatialReach,
    });
    assert.equal(evaluateBoardQuality(boardReport, profile, `${scenario.mode}-${scenario.size}`).passed, true);
  }
  const insufficient = getQualityProfile(4, 7, "classic");
  const failed = evaluateBoardQuality(longOnlyReport({
    size: 4,
    wordCount: 3,
    longestLength: 8,
    coverage: 14,
    spatialReach: 2,
  }), insufficient, "insufficient-long-depth");
  assert.deepEqual(failed.failureReasons, ["LONG_WORDS_LOW"]);
});

test("minimum-nine fallback uses one consistent nine-plus depth gate", () => {
  const profile = getQualityProfile(4, 9, "classic");
  assert.equal(profile.sourceProfileId, "4x4-min6");
  assert.equal(profile.gates.totalWords, undefined);
  assert.equal(profile.gates.longWords, undefined);
  assert.equal(profile.gates.mediumWords, undefined);
  assert.equal(profile.gates.allCoverage, undefined);
  assert.equal(profile.gates.mediumCoverage, undefined);
  assert.deepEqual(profile.gates.ninePlusWords, ["NINE_PLUS_WORD_REQUIRED", ">=", 1]);
  assert.equal(profile.gates.longestLength[2] >= 9, true);
  assert.equal(evaluateBoardQuality(longOnlyReport({
    size: 4,
    wordCount: 2,
    ninePlusWords: 2,
    longestLength: 9,
    coverage: 14,
    spatialReach: 2,
  }), profile, "minimum-nine-healthy").passed, true);
});

test("unsupported fallback selects measured same-minimum supplementary evidence", () => {
  const profile = getQualityProfile(7, 4, "classic");
  assert.equal(profile.sourceProfileId, "8x8-min4");
  assert.equal(profile.measured, false);
  assert.equal(profile.gates.totalWords[2], 299);
  assert.equal(profile.gates.longCoverage[2], 35);
  const measured = getQualityProfile(8, 4, "classic");
  assert.equal(measured.measured, true);
  assert.equal(measured.gates.totalWords[2], 428);
  assert.equal(measured.gates.longCoverage[2], 45);
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
