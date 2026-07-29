const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  deriveSeed,
  nearestRank,
  parseArgs,
  runCorpus,
} = require("../scripts/generate-board-corpus");

function fixtureReport(size) {
  const cells = size * size;
  const family = {
    tileCount: cells,
    tilePercentage: 100,
    tileIndices: Array.from({ length: cells }, (_, index) => index),
    bounds: { minRow: 0, maxRow: size - 1, minColumn: 0, maxColumn: size - 1 },
  };
  const distribution = {
    rows: Array.from({ length: size }, (_, index) => ({
      index,
      coveredTileCount: size,
      coveragePercentage: 100,
      participationTotal: size,
    })),
    columns: Array.from({ length: size }, (_, index) => ({
      index,
      coveredTileCount: size,
      coveragePercentage: 100,
      participationTotal: size,
    })),
  };
  const concentration = {
    totalParticipation: cells,
    topQuarterTileCount: Math.ceil(cells / 4),
    topQuarterParticipationPercentage: 25,
    halfParticipationTileCount: Math.ceil(cells / 2),
    halfParticipationTilePercentage: 50,
  };
  return {
    totalPlayableWords: 10,
    longestPlayableLength: 8,
    coverage: { all: family, medium: family, long: family },
    largestConnectedUnusedRegion: { size: 0, tileIndices: [], bounds: null },
    largestLowValueConnectedRegion: { size: 0, tileIndices: [], bounds: null },
    concentration: { medium: concentration, long: concentration },
  };
}

function fixtureDependencies(failingScenarioId = null) {
  return {
    dictionary: { dictionaryId: "fixture", wordCount: 1 },
    async generate(scenario, seed) {
      if (scenario.id === failingScenarioId)
        return {
          ok: false,
          error: { code: "FIXTURE_GENERATION_FAILED" },
          diagnostics: { seed },
        };
      return {
        ok: true,
        board: Array(scenario.size * scenario.size).fill("A"),
        diagnostics: { seed, attemptCount: 1 },
      };
    },
    async analyze(scenario) {
      return {
        ok: true,
        report: fixtureReport(scenario.size),
        diagnostics: {
          boardFingerprint: "fixture-" + scenario.id,
          operationCount: 10,
          yieldCount: 2,
          elapsedMs: 1,
        },
      };
    },
  };
}

test("corpus arguments, seed derivation, and nearest-rank summaries are deterministic", () => {
  assert.throws(() => parseArgs([]), /--output is required/);
  assert.equal(
    deriveSeed("phase5-analysis-v1", "classic-4x4-min3", 0),
    deriveSeed("phase5-analysis-v1", "classic-4x4-min3", 0),
  );
  assert.notEqual(
    deriveSeed("phase5-analysis-v1", "classic-4x4-min3", 0),
    deriveSeed("phase5-analysis-v1", "classic-4x4-min3", 1),
  );
  assert.equal(nearestRank([5, 1, 3, 2, 4], 0), 1);
  assert.equal(nearestRank([5, 1, 3, 2, 4], 50), 3);
  assert.equal(nearestRank([5, 1, 3, 2, 4], 90), 5);
  assert.equal(nearestRank([], 50), null);
});

test("corpus writes versioned fixture output and records failures", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-corpus-"));
  const output = path.join(directory, "corpus.json");
  const options = {
    output,
    samples: 1,
    seed: "fixture-seed",
    dictionary: "fixture",
    overwrite: false,
  };
  const result = await runCorpus(options, fixtureDependencies("dirty-5x5-min3"));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.boards.length, 5);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].stage, "generation");
  assert.equal(result.summary.overall.successfulBoards, 5);
  assert.equal(result.summary.overall.metrics.totalPlayableWords.p50, 10);
  const written = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.deepEqual(written, result);
  assert.equal(written.boards[0].boardRows.length, 4);
  assert.equal("solution" in written.boards[0], false);
  assert.throws(
    () => parseArgs(["--output", output]),
    /output exists; pass --overwrite/,
  );
  assert.doesNotThrow(() => parseArgs(["--output", output, "--overwrite"]));
  fs.rmSync(directory, { recursive: true, force: true });
});
