const NAMED_PROFILES = Object.freeze({
  "4x4-min3": Object.freeze({
    profileId: "4x4-min3",
    size: 4,
    minimum: 3,
    validationMode: "classic",
    gates: Object.freeze({
      totalWords: ["TOTAL_WORDS_LOW", ">=", 173],
      mediumWords: ["MEDIUM_WORDS_LOW", ">=", 54],
      longWords: ["LONG_WORDS_LOW", ">=", 3],
      longestLength: ["LONGEST_WORD_SHORT", ">=", 7],
      allCoverage: ["ALL_COVERAGE_LOW", ">=", 16],
      mediumCoverage: ["MEDIUM_COVERAGE_LOW", ">=", 15],
      longCoverage: ["LONG_COVERAGE_LOW", ">=", 12],
      spatialReach: ["LONG_SPATIAL_REACH_LOW", ">=", 1],
    }),
  }),
  "5x5-min3": Object.freeze({
    profileId: "5x5-min3",
    size: 5,
    minimum: 3,
    validationMode: "classic",
    gates: Object.freeze({
      totalWords: ["TOTAL_WORDS_LOW", ">=", 226],
      mediumWords: ["MEDIUM_WORDS_LOW", ">=", 67],
      longWords: ["LONG_WORDS_LOW", ">=", 6],
      longestLength: ["LONGEST_WORD_SHORT", ">=", 8],
      allCoverage: ["ALL_COVERAGE_LOW", ">=", 24],
      mediumCoverage: ["MEDIUM_COVERAGE_LOW", ">=", 23],
      longCoverage: ["LONG_COVERAGE_LOW", ">=", 16],
      lowValueRegion: ["LOW_VALUE_REGION_LARGE", "<=", 1],
      spatialReach: ["LONG_SPATIAL_REACH_LOW", ">=", 1],
    }),
  }),
  "dirty-5x5-min3": Object.freeze({
    profileId: "dirty-5x5-min3",
    size: 5,
    minimum: 3,
    validationMode: "dirty",
    gates: Object.freeze({
      totalWords: ["TOTAL_WORDS_LOW", ">=", 181],
      mediumWords: ["MEDIUM_WORDS_LOW", ">=", 51],
      longWords: ["LONG_WORDS_LOW", ">=", 5],
      longestLength: ["LONGEST_WORD_SHORT", ">=", 8],
      allCoverage: ["ALL_COVERAGE_LOW", ">=", 25],
      mediumCoverage: ["MEDIUM_COVERAGE_LOW", ">=", 24],
      longCoverage: ["LONG_COVERAGE_LOW", ">=", 15],
    }),
  }),
  "6x6-min5": Object.freeze({
    profileId: "6x6-min5",
    size: 6,
    minimum: 5,
    validationMode: "classic",
    gates: Object.freeze({
      totalWords: ["TOTAL_WORDS_LOW", ">=", 110],
      mediumWords: ["MEDIUM_WORDS_LOW", ">=", 97],
      longWords: ["LONG_WORDS_LOW", ">=", 12],
      longestLength: ["LONGEST_WORD_SHORT", ">=", 8],
      allCoverage: ["ALL_COVERAGE_LOW", ">=", 33],
      mediumCoverage: ["MEDIUM_COVERAGE_LOW", ">=", 32],
      longCoverage: ["LONG_COVERAGE_LOW", ">=", 25],
      spatialReach: ["LONG_SPATIAL_REACH_LOW", ">=", 1],
    }),
  }),
  "6x6-min6": Object.freeze({
    profileId: "6x6-min6",
    size: 6,
    minimum: 6,
    validationMode: "classic",
    gates: Object.freeze({
      totalWords: ["TOTAL_WORDS_LOW", ">=", 40],
      mediumWords: ["MEDIUM_WORDS_LOW", ">=", 28],
      longWords: ["LONG_WORDS_LOW", ">=", 11],
      ninePlusWords: ["NINE_PLUS_WORD_REQUIRED", ">=", 1],
      longestLength: ["LONGEST_WORD_SHORT", ">=", 8],
      allCoverage: ["ALL_COVERAGE_LOW", ">=", 30],
      mediumCoverage: ["MEDIUM_COVERAGE_LOW", ">=", 29],
      longCoverage: ["LONG_COVERAGE_LOW", ">=", 23],
      unusedRegion: ["UNUSED_REGION_LARGE", "<=", 4],
      lowValueRegion: ["LOW_VALUE_REGION_LARGE", "<=", 4],
      spatialReach: ["LONG_SPATIAL_REACH_LOW", ">=", 1],
    }),
  }),
  "8x8-min3": Object.freeze({
    profileId: "8x8-min3",
    size: 8,
    minimum: 3,
    validationMode: "classic",
    gates: Object.freeze({
      totalWords: ["TOTAL_WORDS_LOW", ">=", 558],
      mediumWords: ["MEDIUM_WORDS_LOW", ">=", 164],
      longWords: ["LONG_WORDS_LOW", ">=", 19],
      ninePlusWords: ["NINE_PLUS_WORD_REQUIRED", ">=", 1],
      longestLength: ["LONGEST_WORD_SHORT", ">=", 9],
      allCoverage: ["ALL_COVERAGE_LOW", ">=", 62],
      mediumCoverage: ["MEDIUM_COVERAGE_LOW", ">=", 57],
      longCoverage: ["LONG_COVERAGE_LOW", ">=", 39],
      lowValueRegion: ["LOW_VALUE_REGION_LARGE", "<=", 4],
      spatialReach: ["LONG_SPATIAL_REACH_LOW", ">=", 1],
    }),
  }),
});

const PROFILE_ALIASES = Object.freeze({
  "standard-5x5-min3": "5x5-min3",
  "dirty-5x5-min3": "dirty-5x5-min3",
});

// Supplementary UI-reachable calibration: 50 reproducible boards per entry,
// seed base phase5-custom-ui-v1, collected outside the repository. The gates
// use measured p10 breaks; word counts are explicit per combination rather
// than scaled by board area.
const SUPPLEMENTARY_GATES = Object.freeze({
  "4x4-min4": { W: 122, M: 48, L: 3, X: 7, A: 16, Mc: 16, Lc: 12, S: 1 },
  "4x4-min5": { W: 60, M: 52, L: 5, X: 7, A: 16, Mc: 16, Lc: 13, S: 2 },
  "4x4-min6": { W: 24, M: 14, L: 6, X: 8, A: 15, Mc: 15, Lc: 14, S: 2 },
  "5x5-min4": { W: 171, M: 80, L: 9, X: 8, A: 24, Mc: 23, Lc: 19, Lo: 1, S: 1 },
  "5x5-min5": { W: 84, M: 76, L: 9, X: 8, A: 23, Mc: 23, Lc: 18, Lo: 1, S: 2 },
  "5x5-min6": { W: 47, M: 31, L: 12, X: 8, A: 22, Mc: 22, Lc: 20, U: 0, Lo: 1, S: 2 },
  "6x6-min3": { W: 382, M: 115, L: 17, X: 8, A: 35, Mc: 33, Lc: 27, S: 1 },
  "6x6-min4": { W: 244, M: 104, L: 11, X: 8, A: 34, Mc: 33, Lc: 25, S: 2 },
  "8x8-min4": { W: 428, M: 189, L: 40, X: 9, A: 61, Mc: 57, Lc: 45, Lo: 1, S: 1 },
  "8x8-min5": { W: 195, M: 174, L: 21, X: 8, A: 58, Mc: 58, Lc: 42, Lo: 1 },
  "8x8-min6": { W: 90, M: 60, L: 33, L9: 1, X: 9, A: 55, Mc: 54, Lc: 44, U: 1, Lo: 1, S: 1 },
  "dirty-4x4-min3": { W: 72, M: 15, L: 0, X: 6, A: 16, Mc: 15, Lc: 0 },
  "dirty-4x4-min4": { W: 40, M: 15, L: 0, X: 6, A: 16, Mc: 15, Lc: 0 },
  "dirty-4x4-min5": { W: 15, M: 15, L: 0, X: 6, A: 15, Mc: 15, Lc: 0 },
  "dirty-4x4-min6": { W: 1, M: 1, L: 0, X: 6, A: 6, Mc: 6, Lc: 0 },
  "dirty-5x5-min4": { W: 156, M: 59, L: 6, X: 7, A: 24, Mc: 24, Lc: 18 },
  "dirty-5x5-min5": { W: 60, M: 58, L: 5, X: 7, A: 24, Mc: 24, Lc: 16 },
  "dirty-5x5-min6": { W: 24, M: 19, L: 5, X: 7, A: 22, Mc: 22, Lc: 16 },
  "dirty-6x6-min3": { W: 306, M: 79, L: 9, X: 8, A: 35, Mc: 33, Lc: 24 },
  "dirty-6x6-min4": { W: 238, M: 102, L: 13, X: 8, A: 35, Mc: 34, Lc: 26 },
  "dirty-6x6-min5": { W: 128, M: 105, L: 14, X: 8, A: 33, Mc: 33, Lc: 26 },
  "dirty-6x6-min6": { W: 55, M: 34, L: 17, X: 8, A: 32, Mc: 31, Lc: 27 },
  "dirty-8x8-min3": { W: 669, M: 198, L: 31, X: 9, A: 63, Mc: 59, Lc: 43 },
  "dirty-8x8-min4": { W: 407, M: 177, L: 26, X: 9, A: 62, Mc: 58, Lc: 45 },
  "dirty-8x8-min5": { W: 234, M: 204, L: 38, X: 9, A: 60, Mc: 59, Lc: 46 },
  "dirty-8x8-min6": { W: 91, M: 65, L: 27, X: 8, A: 55, Mc: 53, Lc: 44 },
});

function supplementaryGates(values) {
  const gates = {
    totalWords: ["TOTAL_WORDS_LOW", ">=", values.W],
    mediumWords: ["MEDIUM_WORDS_LOW", ">=", values.M],
    longWords: ["LONG_WORDS_LOW", ">=", values.L],
    longestLength: ["LONGEST_WORD_SHORT", ">=", Math.max(values.X, values.minimum || 0)],
    allCoverage: ["ALL_COVERAGE_LOW", ">=", values.A],
    mediumCoverage: ["MEDIUM_COVERAGE_LOW", ">=", values.Mc],
    longCoverage: ["LONG_COVERAGE_LOW", ">=", values.Lc],
  };
  if (values.L9 !== undefined) gates.ninePlusWords = ["NINE_PLUS_WORD_REQUIRED", ">=", values.L9];
  if (values.U !== undefined) gates.unusedRegion = ["UNUSED_REGION_LARGE", "<=", values.U];
  if (values.Lo !== undefined) gates.lowValueRegion = ["LOW_VALUE_REGION_LARGE", "<=", values.Lo];
  if (values.S !== undefined) gates.spatialReach = ["LONG_SPATIAL_REACH_LOW", ">=", values.S];
  return Object.freeze(Object.fromEntries(
    Object.entries(gates).map(([key, gate]) => [key, Object.freeze(gate)]),
  ));
}

for (const profile of Object.values(NAMED_PROFILES))
  for (const gate of Object.values(profile.gates)) Object.freeze(gate);

const FAILURE_CODES = Object.freeze([
  "TOTAL_WORDS_LOW",
  "MEDIUM_WORDS_LOW",
  "LONG_WORDS_LOW",
  "NINE_PLUS_WORD_REQUIRED",
  "LONGEST_WORD_SHORT",
  "ALL_COVERAGE_LOW",
  "MEDIUM_COVERAGE_LOW",
  "LONG_COVERAGE_LOW",
  "UNUSED_REGION_LARGE",
  "LOW_VALUE_REGION_LARGE",
  "LONG_SPATIAL_REACH_LOW",
]);

function ceilCoverage(reference, referenceArea, area) {
  return Math.ceil((reference * area) / referenceArea);
}

function conservativeCustomGates(size, minimum, validationMode) {
  const area = size * size;
  const sameSize = Object.values(NAMED_PROFILES)
    .filter((profile) => profile.size === size && profile.validationMode === validationMode)
    .sort((a, b) => Math.abs(a.minimum - minimum) - Math.abs(b.minimum - minimum));
  const sameMinimum = Object.values(NAMED_PROFILES)
    .filter((profile) => profile.minimum === minimum && profile.validationMode === validationMode)
    .sort((a, b) => Math.abs(a.size - size) - Math.abs(b.size - size));
  const reference = sameSize[0] || sameMinimum[0] || NAMED_PROFILES["4x4-min3"];
  const referenceArea = reference.size * reference.size;
  const referenceGates = reference.gates;
  const gateValue = (key, fallback) => referenceGates[key]?.[2] ?? fallback;
  const gates = {
    totalWords: ["TOTAL_WORDS_LOW", ">=", Math.max(minimum, Math.floor(gateValue("totalWords", 1) * 0.7))],
    mediumWords: ["MEDIUM_WORDS_LOW", ">=", Math.max(0, Math.floor(gateValue("mediumWords", 0) * 0.7))],
    longWords: ["LONG_WORDS_LOW", ">=", Math.max(1, Math.floor(gateValue("longWords", 1) * 0.7))],
    longestLength: ["LONGEST_WORD_SHORT", ">=", Math.max(minimum, gateValue("longestLength", minimum))],
    allCoverage: ["ALL_COVERAGE_LOW", ">=", ceilCoverage(gateValue("allCoverage", 1), referenceArea, area)],
    mediumCoverage: ["MEDIUM_COVERAGE_LOW", ">=", ceilCoverage(gateValue("mediumCoverage", 1), referenceArea, area)],
    longCoverage: ["LONG_COVERAGE_LOW", ">=", ceilCoverage(gateValue("longCoverage", 1), referenceArea, area)],
  };
  if (minimum >= 6 && referenceGates.ninePlusWords)
    gates.ninePlusWords = ["NINE_PLUS_WORD_REQUIRED", ">=", 1];
  if (referenceGates.spatialReach)
    gates.spatialReach = ["LONG_SPATIAL_REACH_LOW", ">=", 1];
  if (referenceGates.lowValueRegion)
    gates.lowValueRegion = ["LOW_VALUE_REGION_LARGE", "<=", referenceGates.lowValueRegion[2]];
  if (referenceGates.unusedRegion)
    gates.unusedRegion = ["UNUSED_REGION_LARGE", "<=", referenceGates.unusedRegion[2]];
  return Object.freeze(Object.fromEntries(
    Object.entries(gates).map(([key, gate]) => [key, Object.freeze(gate)]),
  ));
}

function profileIdFor(size, minimum, validationMode = "classic") {
  const prefix = validationMode === "dirty" ? "dirty-" : "";
  return prefix + size + "x" + size + "-min" + minimum;
}

function getQualityProfile(size, minimum, validationMode = "classic") {
  if (!Number.isInteger(size) || !Number.isInteger(minimum)) return null;
  const id = profileIdFor(size, minimum, validationMode);
  const namedId = PROFILE_ALIASES[id] || id;
  if (NAMED_PROFILES[namedId]) return NAMED_PROFILES[namedId];
  const supplementary = SUPPLEMENTARY_GATES[id];
  if (supplementary) {
    const values = { ...supplementary, minimum };
    return Object.freeze({
      profileId: id,
      size,
      minimum,
      validationMode,
      measured: true,
      sourceProfileId: id,
      sourceCalibration: "phase5-custom-ui-v1:50",
      gates: supplementaryGates(values),
    });
  }
  const profile = {
    profileId: id,
    size,
    minimum,
    validationMode,
    measured: false,
    sourceProfileId: Object.values(NAMED_PROFILES)
      .find((candidate) => candidate.size === size && candidate.validationMode === validationMode)?.profileId ||
      Object.values(NAMED_PROFILES)
        .find((candidate) => candidate.minimum === minimum && candidate.validationMode === validationMode)?.profileId ||
      "4x4-min3",
    gates: conservativeCustomGates(size, minimum, validationMode),
  };
  return Object.freeze({ ...profile, gates: Object.freeze(profile.gates) });
}

function metricsFromReport(report) {
  const mediumWords = report.lengthBuckets?.["5-6"] || 0;
  const longWords = (report.lengthBuckets?.["7-8"] || 0) + (report.lengthBuckets?.["9+"] || 0);
  const rowCoverage = report.spatialDistribution?.long?.rows || [];
  const columnCoverage = report.spatialDistribution?.long?.columns || [];
  const longSpatialReach = rowCoverage.length && columnCoverage.length
    ? Math.min(
      ...rowCoverage.map((entry) => entry.coveredTileCount),
      ...columnCoverage.map((entry) => entry.coveredTileCount),
    )
    : 0;
  const ppm = (family) => Math.round(
    (report.concentration?.[family]?.topQuarterParticipationPercentage || 0) * 10000,
  );
  return Object.freeze({
    totalWords: report.totalPlayableWords || 0,
    mediumWords,
    longWords,
    ninePlusWords: report.lengthBuckets?.["9+"] || 0,
    longestLength: report.longestPlayableLength || 0,
    allCoverage: report.coverage?.all?.tileCount || 0,
    mediumCoverage: report.coverage?.medium?.tileCount || 0,
    longCoverage: report.coverage?.long?.tileCount || 0,
    unusedRegion: report.largestConnectedUnusedRegion?.size || 0,
    lowValueRegion: report.largestLowValueConnectedRegion?.size || 0,
    longSpatialReach,
    spatialReach: longSpatialReach,
    mediumConcentrationPpm: ppm("medium"),
    longConcentrationPpm: ppm("long"),
  });
}

function gatePasses(value, operator, threshold) {
  return operator === ">=" ? value >= threshold : value <= threshold;
}

function rankingTuple(metrics, profile, fingerprint = "") {
  // Descending: profile-relevant long depth (L9 then L when required, else
  // L then L9), long coverage, spatial reach, medium coverage and depth,
  // longest length, all coverage, dead areas, concentration, total words;
  // ascending fingerprint is the deterministic final tie-break.
  const longDepth = profile.gates.ninePlusWords
    ? [metrics.ninePlusWords, metrics.longWords]
    : [metrics.longWords, metrics.ninePlusWords];
  return Object.freeze([
    ...longDepth,
    metrics.longCoverage,
    metrics.longSpatialReach,
    metrics.mediumCoverage,
    metrics.mediumWords,
    metrics.longestLength,
    metrics.allCoverage,
    -metrics.unusedRegion,
    -metrics.lowValueRegion,
    -metrics.longConcentrationPpm,
    -metrics.mediumConcentrationPpm,
    metrics.totalWords,
    fingerprint,
  ]);
}

function compareRanking(left, right) {
  const a = left?.ranking?.tuple || left?.ranking || [];
  const b = right?.ranking?.tuple || right?.ranking || [];
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (index === length - 1) {
      const leftValue = String(a[index] ?? "");
      const rightValue = String(b[index] ?? "");
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      continue;
    }
    const leftValue = Number(a[index] ?? 0), rightValue = Number(b[index] ?? 0);
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function evaluateBoardQuality(report, profile, fingerprint = "") {
  if (!report || !profile?.gates)
    throw new TypeError("A quality report and profile are required");
  const metrics = metricsFromReport(report);
  const failureReasons = [];
  for (const [metric, [code, operator, threshold]] of Object.entries(profile.gates))
    if (!gatePasses(metrics[metric], operator, threshold)) failureReasons.push(code);
  return Object.freeze({
    profileId: profile.profileId,
    passed: failureReasons.length === 0,
    failureReasons: Object.freeze(failureReasons),
    ranking: Object.freeze({
      tuple: rankingTuple(metrics, profile, fingerprint),
      directions: Object.freeze([
        "desc", "desc", "desc", "desc", "desc", "desc", "desc", "desc",
        "desc", "desc", "desc", "desc", "desc", "asc",
      ]),
    }),
    metrics,
  });
}

module.exports = {
  FAILURE_CODES,
  NAMED_PROFILES,
  getQualityProfile,
  metricsFromReport,
  evaluateBoardQuality,
  compareRanking,
};
