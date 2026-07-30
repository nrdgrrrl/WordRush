const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { candidateSeed, selectRoundBoard } = require("../board-selector");

function contract() {
  return { size: 4, minimum: 3, validationMode: "classic", prepared: {} };
}
function report({ fingerprint = "board", quality = {} } = {}) {
  return {
    totalPlayableWords: quality.totalPlayableWords ?? 240,
    lengthBuckets: quality.lengthBuckets || { "3-4": 100, "5-6": 75, "7-8": 20, "9+": 2 },
    longestPlayableLength: quality.longestPlayableLength ?? 9,
    coverage: quality.coverage || { all: { tileCount: 16 }, medium: { tileCount: 15 }, long: { tileCount: 12 } },
    largestConnectedUnusedRegion: { size: quality.unusedRegion ?? 0 },
    largestLowValueConnectedRegion: { size: quality.lowValueRegion ?? 0 },
    spatialDistribution: { long: {
      rows: [1, 1, 1, 1].map((coveredTileCount) => ({ coveredTileCount })),
      columns: [1, 1, 1, 1].map((coveredTileCount) => ({ coveredTileCount })),
    } },
    concentration: {
      medium: { topQuarterParticipationPercentage: quality.mediumConcentration ?? 20 },
      long: { topQuarterParticipationPercentage: quality.longConcentration ?? 20 },
    },
    fingerprint,
  };
}
function dependencies(results, calls = []) {
  return {
    async generate(options) {
      calls.push({ stage: "generation", ...options });
      const result = results[options.seed] || {};
      return result.generation || { ok: true, board: ["A"], diagnostics: { attemptCount: 1 } };
    },
    async analyze(options) {
      calls.push({ stage: "analysis", ...options });
      const result = results[calls.filter((call) => call.stage === "generation").at(-1).seed] || {};
      return result.analysis || {
        ok: true,
        report: report({ fingerprint: result.fingerprint || "board" }),
        diagnostics: { boardFingerprint: result.fingerprint || "board", operationCount: 1, yieldCount: 0 },
      };
    },
  };
}

test("candidate zero is exact and derived seeds are stable and count-independent", () => {
  assert.equal(candidateSeed(0x12345678, "4x4-min3", 0), 0x12345678);
  const expected = crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from("wordrush-quality-candidate-v1\0"),
    Buffer.from([0x12, 0x34, 0x56, 0x78]),
    Buffer.from("\0" + "4x4-min3" + "\0" + "1"),
  ])).digest().readUInt32BE(0);
  assert.equal(candidateSeed(0x12345678, "4x4-min3", 1), expected);
  assert.equal(candidateSeed(0x12345678, "4x4-min3", 1), candidateSeed(0x12345678, "4x4-min3", 1));
});

test("strongest passing candidate wins with deterministic ranking", async () => {
  const secondSeed = candidateSeed(11, "4x4-min3", 1);
  const result = await selectRoundBoard(contract(), {
    requestedSeed: 11,
    candidateCount: 2,
    dependencies: {
      async generate(options) {
        return { ok: true, board: [String(options.seed)], diagnostics: { attemptCount: 1 } };
      },
      async analyze(options) {
        const stronger = Number(options.board[0]) === secondSeed;
        return {
          ok: true,
          report: report({ fingerprint: stronger ? "a-board" : "z-board", quality: {
            lengthBuckets: stronger
              ? { "3-4": 100, "5-6": 75, "7-8": 20, "9+": 2 }
              : { "3-4": 100, "5-6": 75, "7-8": 3, "9+": 0 },
          } }),
          diagnostics: { boardFingerprint: stronger ? "a-board" : "z-board", operationCount: 1, yieldCount: 0 },
        };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.selectedCandidateSeed, secondSeed);
  assert.equal(result.diagnostics.selectedCandidateIndex, 1);
  assert.equal(result.diagnostics.candidatesAttempted, 2);
});

test("equal passing candidates use the ascending fingerprint tie-break", async () => {
  async function run(fingerprints) {
    let generated = 0;
    return selectRoundBoard(contract(), {
      requestedSeed: 11,
      candidateCount: 2,
      dependencies: {
        async generate() {
          generated++;
          return { ok: true, board: [String(generated)], diagnostics: { attemptCount: 1 } };
        },
        async analyze() {
          const fingerprint = fingerprints[generated - 1];
          return {
            ok: true,
            report: report({ fingerprint }),
            diagnostics: { boardFingerprint: fingerprint, operationCount: 1, yieldCount: 0 },
          };
        },
      },
    });
  }
  const first = await run(["ffff", "0000"]);
  const second = await run(["0000", "ffff"]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.diagnostics.selectedFingerprint, "0000");
  assert.equal(second.diagnostics.selectedFingerprint, "0000");
});

test("selector-wide yield budget is cumulative and stops later candidates", async () => {
  let generated = 0;
  let handoffAttempts = 0;
  let schedulerCalls = 0;
  const result = await selectRoundBoard(contract(), {
    requestedSeed: 11,
    candidateCount: 2,
    limits: { totalYields: 2 },
    yieldScheduler: async () => { schedulerCalls++; },
    dependencies: {
      async generate(options) {
        generated++;
        for (let index = 0; index < 3; index++) {
          handoffAttempts++;
          await options.yieldScheduler();
        }
        return { ok: true, board: ["A"], diagnostics: { attemptCount: 1, yieldCount: 3 } };
      },
      async analyze() {
        throw new Error("analysis must not begin after the third handoff is rejected");
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "QUALITY_SELECTION_GLOBAL_LIMIT");
  assert.equal(generated, 1);
  assert.equal(handoffAttempts, 3);
  assert.equal(schedulerCalls, 2);
  assert.equal(result.diagnostics.candidatesAttempted, 1);
  assert.equal(result.diagnostics.aggregateWork.cooperativeYields, 2);
  assert.equal(result.diagnostics.exhaustedBudgets.includes("YIELD_GLOBAL_LIMIT"), true);
  assert.equal(result.diagnostics.candidates[0].errorCode, "YIELD_GLOBAL_LIMIT");
});

test("no passing candidate, candidate-level failure, and global budgets are explicit", async () => {
  const result = await selectRoundBoard(contract(), {
    requestedSeed: 11,
    candidateCount: 2,
    limits: { totalGenerationAttempts: 3 },
    dependencies: {
      async generate(options) {
        return options.seed === 11
          ? { ok: false, error: { code: "PLACEMENT_LIMIT" }, diagnostics: { attemptCount: 1, placementOperationCount: 1 } }
          : { ok: true, board: ["A"], diagnostics: { attemptCount: 1, placementOperationCount: 1 } };
      },
      async analyze() {
        return { ok: false, error: { code: "ANALYSIS_OPERATION_LIMIT" }, diagnostics: { operationCount: 1, yieldCount: 0 } };
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NO_QUALITY_CANDIDATE");
  assert.equal(result.diagnostics.candidates[0].errorCode, "PLACEMENT_LIMIT");
  assert.equal(result.diagnostics.candidates.length, 2);

  const exhausted = await selectRoundBoard(contract(), {
    requestedSeed: 11,
    candidateCount: 2,
    limits: { totalGenerationAttempts: 1 },
    dependencies: {
      async generate() { return { ok: true, board: ["A"], diagnostics: { attemptCount: 1 } }; },
      async analyze() { return { ok: false, error: { code: "ANALYSIS_OPERATION_LIMIT" }, diagnostics: { operationCount: 0 } }; },
    },
  });
  assert.equal(exhausted.error.code, "QUALITY_SELECTION_GLOBAL_LIMIT");
  assert.deepEqual(exhausted.diagnostics.exhaustedBudgets, ["GENERATION_ATTEMPT_GLOBAL_LIMIT"]);
});

test("global analysis and placement budgets are bounded across candidates", async () => {
  let generated = 0;
  const result = await selectRoundBoard(contract(), {
    requestedSeed: 11,
    candidateCount: 4,
    limits: { totalPlacementOperations: 2, totalAnalysisOperations: 2 },
    dependencies: {
      async generate() {
        generated++;
        return { ok: true, board: ["A"], diagnostics: { attemptCount: 1, placementOperationCount: 1 } };
      },
      async analyze() {
        return { ok: true, report: report(), diagnostics: { boardFingerprint: "board", operationCount: 1, yieldCount: 0 } };
      },
    },
  });
  assert.equal(generated, 2);
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.aggregateWork.placementOperations, 2);
});

test("global backtrack budget stops later candidates without resetting", async () => {
  let generated = 0;
  const result = await selectRoundBoard(contract(), {
    requestedSeed: 11,
    candidateCount: 2,
    limits: { totalGenerationBacktracks: 1 },
    dependencies: {
      async generate() {
        generated++;
        return { ok: true, board: ["A"], diagnostics: { attemptCount: 1, backtrackCount: 1 } };
      },
      async analyze() {
        return { ok: true, report: report(), diagnostics: { boardFingerprint: "board", operationCount: 1, yieldCount: 0 } };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(generated, 1);
  assert.equal(result.diagnostics.aggregateWork.generationBacktracks, 1);
});

test("Dirty quality selection preserves the independent adult generation mode", async () => {
  const modes = [];
  const dirtyContract = { ...contract(), validationMode: "dirty" };
  const result = await selectRoundBoard(dirtyContract, {
    requestedSeed: 11,
    candidateCount: 1,
    dependencies: {
      async generate(options) {
        modes.push(options.mode);
        return { ok: true, board: ["A"], diagnostics: { attemptCount: 1 } };
      },
      async analyze() {
        return { ok: true, report: report(), diagnostics: { boardFingerprint: "dirty-board", operationCount: 1, yieldCount: 0 } };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(modes, ["dirty"]);
});

test("cancellation during generation and analysis never returns a board", async () => {
  let cancelled = false;
  const generation = await selectRoundBoard(contract(), {
    requestedSeed: 11,
    candidateCount: 1,
    isCancelled: () => cancelled,
    dependencies: {
      async generate() { cancelled = true; return { ok: false, error: { code: "GENERATION_CANCELLED" }, diagnostics: {} }; },
      async analyze() { throw new Error("should not analyze"); },
    },
  });
  assert.equal(generation.ok, false);
  assert.equal(generation.error.code, "QUALITY_SELECTION_CANCELLED");
  assert.equal("board" in generation, false);

  cancelled = false;
  const analysis = await selectRoundBoard(contract(), {
    requestedSeed: 11,
    candidateCount: 1,
    isCancelled: () => cancelled,
    dependencies: {
      async generate() { return { ok: true, board: ["A"], diagnostics: {} }; },
      async analyze() { cancelled = true; return { ok: false, error: { code: "ANALYSIS_CANCELLED" }, diagnostics: {} }; },
    },
  });
  assert.equal(analysis.ok, false);
  assert.equal(analysis.error.code, "QUALITY_SELECTION_CANCELLED");
});
