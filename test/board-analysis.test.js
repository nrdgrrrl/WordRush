const test = require("node:test");
const assert = require("node:assert/strict");
const { hasPath } = require("../board-core");
const { solveBoard, createQualityReport } = require("../board-analysis");

test("solveBoard enumerates unique playable words with shared board rules", () => {
  const board = [
    "A", "B", "C",
    "D", "E", "F",
    "G", "H", "I",
  ];
  const lexicon = new Set([
    "ABE", "ABE", "ABCF", "ABED", "ABEF", "ABEI", "ADG", "AEI", "CFI",
    "ABA", "ABCD", "AB", "A1", "ZZZ",
  ]);
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
