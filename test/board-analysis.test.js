const test = require("node:test");
const assert = require("node:assert/strict");
const { hasPath } = require("../board-core");
const {
  prepareAnalysisIndex,
  analyzeBoard,
  analyzeBoardCooperatively,
  solveBoard,
  createQualityReport,
} = require("../board-analysis");

test("solveBoard enumerates unique playable words with shared board rules", () => {
  const board = [
    "A", "B", "C",
    "D", "E", "F",
    "G", "H", "I",
  ];
  const lexicon = [
    "ABE", "ABE", "ABCF", "ABED", "ABEF", "ABEI", "ADG", "AEI", "CFI",
    "ABA", "ABCD", "AB", "A1", "ZZZ",
  ];
  const solution = solveBoard({ board, size: 3, minimum: 3, lexicon });

  assert.deepEqual(solution.words, [
    "ABCF", "ABE", "ABED", "ABEF", "ABEI", "ADG", "AEI", "CFI",
  ]);
  assert.deepEqual(solution.wordTileIndices, {
    ABCF: [0, 1, 2, 5],
    ABE: [0, 1, 4],
    ABED: [0, 1, 3, 4],
    ABEF: [0, 1, 4, 5],
    ABEI: [0, 1, 4, 8],
    ADG: [0, 3, 6],
    AEI: [0, 4, 8],
    CFI: [2, 5, 8],
  });
  for (const word of solution.words)
    assert.equal(hasPath(board, 3, word), true, word);
  assert.equal(hasPath(board, 3, "ABCD"), false);
  assert.equal(hasPath(board, 3, "ABA"), false);
});

test("tile participation counts each word once across multiple paths", () => {
  const solution = solveBoard({
    board: ["A", "A", "T", "T"],
    size: 2,
    minimum: 3,
    lexicon: ["ATA"],
  });
  const report = createQualityReport({
    board: ["A", "A", "T", "T"],
    size: 2,
    minimum: 3,
    solution,
  });

  assert.deepEqual(solution.words, ["ATA"]);
  assert.deepEqual(solution.wordTileIndices, { ATA: [0, 1, 2, 3] });
  assert.deepEqual(report.tileParticipation, [1, 1, 1, 1]);
});

test("createQualityReport calculates deterministic buckets and spatial metrics", () => {
  const board = [
    "A", "B", "C", "D",
    "E", "F", "G", "H",
    "I", "J", "K", "L",
    "M", "N", "O", "P",
  ];
  const lexicon = [
    "ABC", "ABCD", "ABCDH", "ABCDHL", "ABCDHLP", "ABCDHLPON",
    "AB", "ABCDI",
  ];
  const report = createQualityReport({ board, size: 4, minimum: 3, lexicon });

  assert.equal(report.totalPlayableWords, 6);
  assert.deepEqual(report.lengthBuckets, {
    "3-4": 2,
    "5-6": 2,
    "7-8": 1,
    "9+": 1,
  });
  assert.equal(report.longestPlayableWord, "ABCDHLPON");
  assert.equal(report.longestPlayableLength, 9);
  assert.deepEqual(report.tileParticipation, [
    6, 6, 6, 5,
    0, 0, 0, 4,
    0, 0, 0, 3,
    0, 1, 1, 2,
  ]);
  assert.equal(report.unusedTileCount, 7);
  assert.equal(report.unusedTilePercentage, 43.75);
  assert.deepEqual(report.largestConnectedUnusedRegion, {
    size: 7,
    tileIndices: [4, 5, 6, 8, 9, 10, 12],
    bounds: { minRow: 1, maxRow: 3, minColumn: 0, maxColumn: 2 },
  });
  assert.deepEqual(report.spatialCoverage, {
    all: {
      tileCount: 9,
      tileIndices: [0, 1, 2, 3, 7, 11, 13, 14, 15],
      bounds: { minRow: 0, maxRow: 3, minColumn: 0, maxColumn: 3 },
    },
    medium: {
      tileCount: 6,
      tileIndices: [0, 1, 2, 3, 7, 11],
      bounds: { minRow: 0, maxRow: 2, minColumn: 0, maxColumn: 3 },
    },
    long: {
      tileCount: 9,
      tileIndices: [0, 1, 2, 3, 7, 11, 13, 14, 15],
      bounds: { minRow: 0, maxRow: 3, minColumn: 0, maxColumn: 3 },
    },
  });
});

test("quality reports honor the explicit minimum without a production lexicon", () => {
  const report = createQualityReport({
    board: [
      "A", "B", "C", "D",
      "E", "F", "G", "H",
      "I", "J", "K", "L",
      "M", "N", "O", "P",
    ],
    size: 4,
    minimum: 5,
    lexicon: ["ABC", "ABCDH", "ABCDHL", "ABCDHLPON"],
  });
  assert.equal(report.totalPlayableWords, 3);
  assert.deepEqual(report.lengthBuckets, {
    "3-4": 0,
    "5-6": 2,
    "7-8": 0,
    "9+": 1,
  });
});

test("analysis rejects invalid minimum values", () => {
  for (const minimum of [1, 2, 13, 3.5])
    assert.throws(
      () => solveBoard({ board: ["A", "B", "C", "D"], size: 2, minimum, lexicon: ["ABC"] }),
      /Minimum word length must be an integer from 3 through 12/,
    );
});

test("quality reports reject solutions for different board, size, or minimum", () => {
  const board = [
    "A", "B", "C",
    "D", "E", "F",
    "G", "H", "I",
  ];
  const solution = solveBoard({
    board,
    size: 3,
    minimum: 3,
    lexicon: ["ABE", "AEI"],
  });

  assert.throws(
    () => createQualityReport({
      board: ["A", "B", "C", "D", "E", "F", "G", "H", "H"],
      size: 3,
      minimum: 3,
      solution,
    }),
    /board/,
  );
  assert.throws(
    () => createQualityReport({
      board,
      size: 3,
      minimum: 3,
      solution: { ...solution, size: 4 },
    }),
    /size/,
  );
  assert.throws(
    () => createQualityReport({
      board,
      size: 3,
      minimum: 4,
      solution: solveBoard({ board, size: 3, minimum: 3, lexicon: ["ABE", "AEI"] }),
    }),
    /minimum/,
  );
});

test("synchronous and cooperative analysis agree across yield intervals", async () => {
  const board = [
    "A", "B", "C", "D",
    "E", "F", "G", "H",
    "I", "J", "K", "L",
    "M", "N", "O", "P",
  ];
  const index = prepareAnalysisIndex([
    "ABC", "ABCD", "ABCDH", "ABCDHL", "ABCDHLP", "ABCDHLPON",
  ]);
  const synchronous = analyzeBoard({
    board,
    size: 4,
    minimum: 3,
    analysisIndex: index,
    includeSolution: true,
    limits: { operationsPerYield: 1 },
  });
  for (const operationsPerYield of [1, 7, 100000]) {
    const cooperative = await analyzeBoardCooperatively({
      board,
      size: 4,
      minimum: 3,
      analysisIndex: index,
      includeSolution: true,
      limits: { operationsPerYield },
      yieldScheduler: () => Promise.resolve(),
    });
    assert.equal(cooperative.ok, true);
    assert.deepEqual(cooperative.report, synchronous.report);
    assert.deepEqual(cooperative.solution, synchronous.solution);
    assert.equal(
      cooperative.diagnostics.operationCount,
      synchronous.diagnostics.operationCount,
    );
  }
});

test("analysis limits and cancellation never expose partial results", async () => {
  const index = prepareAnalysisIndex(["ABC", "ABCD", "ABCDH", "ABCDHL"]);
  const limited = analyzeBoard({
    board: [
      "A", "B", "C", "D",
      "E", "F", "G", "H",
      "I", "J", "K", "L",
      "M", "N", "O", "P",
    ],
    size: 4,
    minimum: 3,
    analysisIndex: index,
    includeSolution: true,
    limits: { maxOperations: 1, operationsPerYield: 1 },
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.error.code, "ANALYSIS_OPERATION_LIMIT");
  assert.equal("solution" in limited, false);
  assert.equal("report" in limited, false);

  let schedulerCalls = 0;
  const cancelled = await analyzeBoardCooperatively({
    board: ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
    size: 3,
    minimum: 3,
    analysisIndex: prepareAnalysisIndex(["ABC", "ABE", "AEI"]),
    includeSolution: true,
    limits: { operationsPerYield: 1 },
    isCancelled: () => schedulerCalls > 0,
    yieldScheduler: async () => {
      schedulerCalls++;
    },
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, "ANALYSIS_CANCELLED");
  assert.equal("solution" in cancelled, false);
  assert.equal("report" in cancelled, false);
  assert.ok(cancelled.diagnostics.yieldCount >= 1);
});

test("report-only analysis returns all approved metric families without a solution", () => {
  const result = analyzeBoard({
    board: ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
    size: 3,
    minimum: 3,
    analysisIndex: prepareAnalysisIndex(["ABC", "ABE", "AEI"]),
    includeSolution: false,
  });
  assert.equal(result.ok, true);
  assert.equal("solution" in result, false);
  assert.deepEqual(result.report.coverage.all.tileIndices, [0, 1, 2, 4, 8]);
  assert.equal(result.report.coverage.all.tilePercentage, 55.55555555555556);
  assert.equal(result.report.coverage.medium.tileCount, 0);
  assert.equal(result.report.coverage.long.tileCount, 0);
  assert.equal(result.report.largestLowValueConnectedRegion.size, 9);
  assert.equal(result.report.concentration.medium.totalParticipation, 0);
  assert.equal(result.report.concentration.long.topQuarterParticipationPercentage, 0);
  assert.equal(result.report.spatialDistribution.all.rows.length, 3);
  assert.equal(result.report.spatialDistribution.all.columns.length, 3);
});

test("family coverage, low-value regions, distribution, and concentration are deterministic", () => {
  const result = analyzeBoard({
    board: [
      "A", "B", "C", "D",
      "E", "F", "G", "H",
      "I", "J", "K", "L",
      "M", "N", "O", "P",
    ],
    size: 4,
    minimum: 3,
    analysisIndex: prepareAnalysisIndex([
      "ABCFK",
      "ABCDHLPON",
    ]),
    includeSolution: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.report.tileParticipationByLength.medium, [1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(result.report.tileParticipationByLength.long, [1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1]);
  assert.equal(result.report.coverage.medium.tilePercentage, 31.25);
  assert.equal(result.report.coverage.long.tileCount, 9);
  assert.deepEqual(result.report.largestLowValueConnectedRegion.tileIndices, [4, 6, 8, 9, 12]);
  assert.deepEqual(result.report.spatialDistribution.medium.rows.map((row) => row.coveredTileCount), [3, 1, 1, 0]);
  assert.deepEqual(result.report.spatialDistribution.long.columns.map((column) => column.coveredTileCount), [1, 2, 2, 4]);
  assert.equal(result.report.concentration.medium.totalParticipation, 5);
  assert.equal(result.report.concentration.medium.topQuarterTileCount, 4);
  assert.equal(result.report.concentration.medium.topQuarterParticipationPercentage, 80);
  assert.equal(result.report.concentration.medium.halfParticipationTileCount, 3);
  assert.equal(result.report.concentration.medium.halfParticipationTilePercentage, 18.75);
  assert.equal(result.report.concentration.long.totalParticipation, 9);
});
