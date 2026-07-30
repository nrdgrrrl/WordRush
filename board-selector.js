const crypto = require("node:crypto");
const { DEFAULT_LIMITS, generateBoardCooperatively } = require("./board-core");
const { getPreparedAnalysisIndex } = require("./game-core");
const {
  analyzeBoardCooperatively,
} = require("./board-analysis");
const { evaluateBoardQuality, getQualityProfile, compareRanking } = require("./board-quality");

const DEFAULT_SELECTOR_LIMITS = Object.freeze({
  maxCandidates: 4,
  totalGenerationAttempts: 128,
  totalPlacementOperations: 1_000_000,
  totalGenerationBacktracks: 500_000,
  perCandidateAnalysisOperations: 350_000,
  totalAnalysisOperations: 1_250_000,
  totalYields: 1_024,
  operationsPerYield: 2_048,
});
const QUALITY_SEED_VERSION = "wordrush-quality-candidate-v1";

class SelectorBudgetError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function normalizeLimits(limits = {}) {
  const result = { ...DEFAULT_SELECTOR_LIMITS };
  for (const key of Object.keys(result))
    if (Number.isInteger(limits[key]) && limits[key] > 0) result[key] = limits[key];
  return result;
}

function candidateSeed(requestedSeed, profileId, candidateIndex) {
  if (!Number.isInteger(requestedSeed) || requestedSeed < 0 || requestedSeed > 0xffffffff)
    throw new TypeError("requestedSeed must be a uint32");
  if (candidateIndex === 0) return requestedSeed;
  const seedBytes = Buffer.allocUnsafe(4);
  seedBytes.writeUInt32BE(requestedSeed >>> 0);
  return crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from(QUALITY_SEED_VERSION + "\0", "utf8"),
    seedBytes,
    Buffer.from("\0" + profileId + "\0" + candidateIndex, "utf8"),
  ])).digest().readUInt32BE(0);
}

function remainingLimits(total, used, normal) {
  return Math.max(0, Math.min(normal, total - used));
}

function aggregateDiagnostics(candidates) {
  const totals = {
    generationAttempts: 0,
    placementOperations: 0,
    generationBacktracks: 0,
    analysisOperations: 0,
    cooperativeYields: 0,
  };
  for (const candidate of candidates) {
    const generation = candidate.generationDiagnostics || {};
    const analysis = candidate.analysisDiagnostics || {};
    totals.generationAttempts += generation.attemptCount || 0;
    totals.placementOperations += generation.placementOperationCount || 0;
    totals.generationBacktracks += generation.backtrackCount || 0;
    totals.analysisOperations += analysis.operationCount || 0;
    totals.cooperativeYields += (generation.yieldCount || 0) + (analysis.yieldCount || 0);
  }
  return totals;
}

function compactCandidate(candidate) {
  return {
    index: candidate.index,
    seed: candidate.seed,
    ok: candidate.ok,
    fingerprint: candidate.fingerprint || null,
    passed: candidate.evaluation?.passed || false,
    failureReasons: candidate.evaluation?.failureReasons || candidate.failureReasons || [],
    errorCode: candidate.errorCode || null,
    ranking: candidate.evaluation?.ranking?.tuple || null,
    generation: candidate.generationDiagnostics ? {
      attemptCount: candidate.generationDiagnostics.attemptCount || 0,
      placementOperationCount: candidate.generationDiagnostics.placementOperationCount || 0,
      backtrackCount: candidate.generationDiagnostics.backtrackCount || 0,
      yieldCount: candidate.generationDiagnostics.yieldCount || 0,
    } : null,
    analysis: candidate.analysisDiagnostics ? {
      operationCount: candidate.analysisDiagnostics.operationCount || 0,
      yieldCount: candidate.analysisDiagnostics.yieldCount || 0,
      elapsedMs: candidate.analysisDiagnostics.elapsedMs || 0,
    } : null,
  };
}

async function selectRoundBoard(contract, options = {}) {
  if (!contract || !contract.prepared)
    throw new TypeError("A prepared generation contract is required");
  const profile = getQualityProfile(
    contract.size,
    contract.minimum,
    contract.validationMode,
  );
  const requestedSeed = options.requestedSeed;
  const limits = normalizeLimits(options.limits);
  const requestedCount = options.candidateCount === undefined ? 4 : options.candidateCount;
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > limits.maxCandidates)
    return {
      ok: false,
      error: { code: "QUALITY_CANDIDATE_COUNT_INVALID" },
      diagnostics: { profileId: profile?.profileId, requestedSeed, candidates: [] },
    };
  if (!profile)
    return {
      ok: false,
      error: { code: "QUALITY_PROFILE_UNAVAILABLE" },
      diagnostics: { requestedSeed, candidates: [] },
    };
  let requested;
  try {
    requested = candidateSeed(requestedSeed, profile.profileId, 0);
  } catch {
    return {
      ok: false,
      error: { code: "QUALITY_SEED_INVALID" },
      diagnostics: { profileId: profile.profileId, requestedSeed, candidates: [] },
    };
  }
  const candidates = [];
  let selectorYieldCount = 0;
  const dependencies = options.dependencies || {};
  const generate = dependencies.generate || ((candidateOptions) =>
    generateBoardCooperatively(contract.size, contract.prepared, candidateOptions));
  const analyze = dependencies.analyze || ((candidateOptions) =>
    analyzeBoardCooperatively({
      board: candidateOptions.board,
      size: contract.size,
      minimum: contract.minimum,
      analysisIndex: options.analysisIndex || contract.analysisIndex ||
        (contract.dictionary?.id
          ? getPreparedAnalysisIndex(contract.dictionary.id, contract.validationMode)
          : undefined),
      dictionary: contract.dictionary,
      limits: candidateOptions.limits,
      isCancelled: candidateOptions.isCancelled,
      yieldScheduler: candidateOptions.yieldScheduler,
      includeSolution: false,
    }));
  const scheduler = options.yieldScheduler || (() => new Promise((resolve) => setImmediate(resolve)));
  const startedAt = Date.now();
  const exhausted = new Set();
  const totalUsed = () => ({
    ...aggregateDiagnostics(candidates),
    cooperativeYields: selectorYieldCount,
  });
  const markExhausted = (totals) => {
    if (totals.generationAttempts >= limits.totalGenerationAttempts) exhausted.add("GENERATION_ATTEMPT_GLOBAL_LIMIT");
    if (totals.placementOperations >= limits.totalPlacementOperations) exhausted.add("PLACEMENT_GLOBAL_LIMIT");
    if (totals.generationBacktracks >= limits.totalGenerationBacktracks) exhausted.add("BACKTRACK_GLOBAL_LIMIT");
    if (totals.analysisOperations >= limits.totalAnalysisOperations) exhausted.add("ANALYSIS_GLOBAL_LIMIT");
    if (totals.cooperativeYields >= limits.totalYields) exhausted.add("YIELD_GLOBAL_LIMIT");
  };
  const cancelled = () => Boolean(options.isCancelled?.());
  const cancellationResult = () => ({
    ok: false,
    error: { code: "QUALITY_SELECTION_CANCELLED" },
    diagnostics: buildDiagnostics(),
  });
  const buildDiagnostics = () => {
    const totals = totalUsed();
    return {
      profileId: profile.profileId,
      requestedSeed,
      candidateSeeds: candidates.map((candidate) => candidate.seed),
      candidatesAttempted: candidates.length,
      selectedCandidateIndex: null,
      selectedFingerprint: null,
      selectedRanking: null,
      aggregateWork: totals,
      limits,
      elapsedMs: Date.now() - startedAt,
      candidates: candidates.map(compactCandidate),
      exhaustedBudgets: [...exhausted],
    };
  };
  for (let index = 0; index < requestedCount; index++) {
    if (cancelled()) return cancellationResult();
    const totalsBefore = totalUsed();
    markExhausted(totalsBefore);
    if (exhausted.size) break;
    const seed = index === 0 ? requested : candidateSeed(requestedSeed, profile.profileId, index);
    const candidate = { index, seed, ok: false };
    candidates.push(candidate);
    if (cancelled()) return cancellationResult();
    const generationLimits = {
      maxAttempts: remainingLimits(
        limits.totalGenerationAttempts,
        totalsBefore.generationAttempts,
        DEFAULT_LIMITS.maxAttempts,
      ),
      maxPlacementOperations: remainingLimits(
        limits.totalPlacementOperations,
        totalsBefore.placementOperations,
        DEFAULT_LIMITS.maxPlacementOperations,
      ),
      maxBacktracks: Math.min(
        DEFAULT_LIMITS.maxBacktracks,
        Math.max(0, limits.totalGenerationBacktracks - totalsBefore.generationBacktracks),
      ),
      operationsPerYield: limits.operationsPerYield,
    };
    if (generationLimits.maxAttempts < 1 || generationLimits.maxPlacementOperations < 1) {
      candidate.errorCode = "GENERATION_GLOBAL_LIMIT";
      exhausted.add(generationLimits.maxAttempts < 1
        ? "GENERATION_ATTEMPT_GLOBAL_LIMIT"
        : "PLACEMENT_GLOBAL_LIMIT");
      break;
    }
    const schedulerForCandidate = async () => {
      if (selectorYieldCount >= limits.totalYields) {
        exhausted.add("YIELD_GLOBAL_LIMIT");
        throw new SelectorBudgetError("YIELD_GLOBAL_LIMIT");
      }
      selectorYieldCount++;
      await scheduler();
    };
    try {
      const generated = await generate({
        mode: contract.validationMode,
        min: contract.minimum,
        seed,
        limits: generationLimits,
        yieldScheduler: schedulerForCandidate,
        isCancelled: cancelled,
      });
      candidate.generationDiagnostics = generated?.diagnostics;
      if (!generated?.ok) {
        candidate.errorCode = generated?.error?.code || "GENERATION_FAILED";
        markExhausted(totalUsed());
        continue;
      }
      candidate.board = generated.board;
      if (cancelled()) return cancellationResult();
      const totalsAfterGeneration = totalUsed();
      const analysisLimit = Math.min(
        limits.perCandidateAnalysisOperations,
        Math.max(0, limits.totalAnalysisOperations - totalsAfterGeneration.analysisOperations),
      );
      if (analysisLimit < 1) {
        candidate.errorCode = "ANALYSIS_GLOBAL_LIMIT";
        exhausted.add("ANALYSIS_GLOBAL_LIMIT");
        break;
      }
      const analyzed = await analyze({
        board: candidate.board,
        limits: { maxOperations: analysisLimit, operationsPerYield: limits.operationsPerYield },
        isCancelled: cancelled,
        yieldScheduler: schedulerForCandidate,
      });
      candidate.analysisDiagnostics = analyzed?.diagnostics;
      if (!analyzed?.ok) {
        candidate.errorCode = analyzed?.error?.code || "ANALYSIS_FAILED";
        markExhausted(totalUsed());
        continue;
      }
      if (cancelled()) return cancellationResult();
      candidate.report = analyzed.report;
      candidate.fingerprint = analyzed.diagnostics?.boardFingerprint || null;
      candidate.evaluation = evaluateBoardQuality(analyzed.report, profile, candidate.fingerprint || "");
      candidate.ok = true;
      if (candidate.evaluation.passed) candidate.passed = true;
      markExhausted(totalUsed());
    } catch (error) {
      candidate.errorCode = error.code || "QUALITY_SELECTION_EXCEPTION";
      if (error.code === "QUALITY_SELECTION_CANCELLED") return cancellationResult();
      if (error.code === "YIELD_GLOBAL_LIMIT") exhausted.add(error.code);
      markExhausted(totalUsed());
    }
  }
  const passing = candidates.filter((candidate) => candidate.passed);
  let selected = null;
  for (const candidate of passing)
    if (!selected || compareRanking(candidate.evaluation, selected.evaluation) > 0)
      selected = candidate;
  if (cancelled()) return cancellationResult();
  const diagnostics = buildDiagnostics();
  if (!selected) {
    diagnostics.selectedCandidateIndex = null;
    return {
      ok: false,
      error: {
        code: exhausted.size ? "QUALITY_SELECTION_GLOBAL_LIMIT" : "NO_QUALITY_CANDIDATE",
        reasons: candidates.flatMap((candidate) => candidate.evaluation?.failureReasons || [candidate.errorCode]).filter(Boolean),
      },
      diagnostics,
    };
  }
  if (cancelled()) return cancellationResult();
  diagnostics.selectedCandidateIndex = selected.index;
  diagnostics.selectedFingerprint = selected.fingerprint;
  diagnostics.selectedRanking = selected.evaluation.ranking.tuple;
  return {
    ok: true,
    board: selected.board,
    report: selected.report,
    requestedSeed,
    selectedCandidateSeed: selected.seed,
    diagnostics,
  };
}

module.exports = {
  DEFAULT_SELECTOR_LIMITS,
  QUALITY_SEED_VERSION,
  candidateSeed,
  selectRoundBoard,
};
