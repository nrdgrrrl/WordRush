const {
  DEFAULT_SELECTOR_LIMITS,
  selectRoundBoard,
} = require("./board-selector");
const { getPreparedAnalysisIndex } = require("./game-core");
const { NAMED_PROFILES, getQualityProfile } = require("./board-quality");

const PRODUCTION_SELECTOR_VERSION = "wordrush-production-quality-v1";
const DEFAULT_PRODUCTION_CANDIDATE_COUNT = 4;
const LONG_HAUL_PROFILE_ID = "6x6-min6";

// Target-hardware comparison accepted best-of-6 for Long Haul: it removed the
// deterministic no-pass tail while staying within profile-local limits.
const PRODUCTION_CANDIDATE_COUNTS = Object.freeze({
  [LONG_HAUL_PROFILE_ID]: 6,
});

// There is intentionally no repeat cache or recent-fingerprint exclusion.
// Some Dirty 4x4 profiles are deterministic templates, so excluding their
// fingerprint could remove the only valid candidate rather than improve play.

function isMeasuredProductionProfile(profile) {
  return Boolean(
    profile &&
    (Object.hasOwn(NAMED_PROFILES, profile.profileId) || profile.measured === true),
  );
}

function scaleSelectorLimits(candidateCount) {
  const scale = Math.max(1, candidateCount / DEFAULT_PRODUCTION_CANDIDATE_COUNT);
  return Object.freeze({
    ...DEFAULT_SELECTOR_LIMITS,
    maxCandidates: candidateCount,
    totalGenerationAttempts: Math.ceil(DEFAULT_SELECTOR_LIMITS.totalGenerationAttempts * scale),
    totalPlacementOperations: Math.ceil(DEFAULT_SELECTOR_LIMITS.totalPlacementOperations * scale),
    totalGenerationBacktracks: Math.ceil(DEFAULT_SELECTOR_LIMITS.totalGenerationBacktracks * scale),
    totalAnalysisOperations: Math.ceil(DEFAULT_SELECTOR_LIMITS.totalAnalysisOperations * scale),
    totalYields: Math.ceil(DEFAULT_SELECTOR_LIMITS.totalYields * scale),
  });
}

function baseDiagnostics(contract, profile, requestedSeed, candidateCount) {
  return {
    selectorVersion: PRODUCTION_SELECTOR_VERSION,
    profileId: profile?.profileId || null,
    requestedSeed,
    candidateSeeds: [],
    selectedCandidateIndex: null,
    selectedCandidateSeed: null,
    selectedFingerprint: null,
    selectedRanking: null,
    candidateCount,
    size: contract?.size,
    minimum: contract?.minimum,
    validationMode: contract?.validationMode,
    dictionary: contract?.dictionary?.metadata || null,
    candidates: [],
  };
}

function failureResult(diagnostics, code, reasons = []) {
  return {
    ok: false,
    error: {
      code,
      ...(reasons.length ? { reasons } : {}),
    },
    diagnostics,
  };
}

function normalizeDiagnostics(contract, profile, candidateCount, result) {
  const selectorDiagnostics = result?.diagnostics || {};
  return {
    ...selectorDiagnostics,
    selectorVersion: PRODUCTION_SELECTOR_VERSION,
    profileId: profile?.profileId || selectorDiagnostics.profileId || null,
    requestedSeed: result?.requestedSeed ?? selectorDiagnostics.requestedSeed,
    candidateSeeds: selectorDiagnostics.candidateSeeds || [],
    selectedCandidateIndex: selectorDiagnostics.selectedCandidateIndex ?? null,
    selectedCandidateSeed: result?.selectedCandidateSeed ?? null,
    selectedFingerprint: selectorDiagnostics.selectedFingerprint ?? null,
    selectedRanking: selectorDiagnostics.selectedRanking ?? null,
    candidateCount,
    size: contract.size,
    minimum: contract.minimum,
    validationMode: contract.validationMode,
    dictionary: contract.dictionary?.metadata || null,
  };
}

function compactRoundDiagnostics(diagnostics, result) {
  const work = diagnostics?.aggregateWork || {};
  return {
    selectorVersion: diagnostics?.selectorVersion || PRODUCTION_SELECTOR_VERSION,
    profileId: diagnostics?.profileId || null,
    requestedSeed: result?.requestedSeed ?? diagnostics?.requestedSeed ?? null,
    candidateSeeds: [...(diagnostics?.candidateSeeds || [])],
    candidateCount: diagnostics?.candidateCount || 0,
    selectedCandidateIndex: diagnostics?.selectedCandidateIndex ?? null,
    selectedCandidateSeed: result?.selectedCandidateSeed ?? diagnostics?.selectedCandidateSeed ?? null,
    selectedFingerprint: diagnostics?.selectedFingerprint || null,
    selectedRanking: diagnostics?.selectedRanking || null,
    candidates: (diagnostics?.candidates || []).map((candidate) => ({
      index: candidate.index,
      seed: candidate.seed,
      ok: Boolean(candidate.ok),
      passed: Boolean(candidate.passed),
      fingerprint: candidate.fingerprint || null,
      failureReasons: [...(candidate.failureReasons || [])],
      errorCode: candidate.errorCode || null,
      ranking: candidate.ranking || null,
      generation: candidate.generation ? { ...candidate.generation } : null,
      analysis: candidate.analysis ? { ...candidate.analysis } : null,
    })),
    generationAttempts: work.generationAttempts || 0,
    placementOperations: work.placementOperations || 0,
    generationBacktracks: work.generationBacktracks || 0,
    analysisOperations: work.analysisOperations || 0,
    cooperativeYields: work.cooperativeYields || 0,
    elapsedMs: diagnostics?.elapsedMs || 0,
    dictionary: diagnostics?.dictionary
      ? {
          dictionaryId: diagnostics.dictionary.dictionaryId,
          artifactSha256: diagnostics.dictionary.artifactSha256,
        }
      : null,
    validationMode: diagnostics?.validationMode || null,
    size: diagnostics?.size || null,
    minimum: diagnostics?.minimum || null,
  };
}

async function generateQualityRoundBoard(contract, options = {}) {
  const profile = contract && getQualityProfile(
    contract.size,
    contract.minimum,
    contract.validationMode,
  );
  const requestedSeed = options.requestedSeed;
  const candidateCount = profile
    ? Object.hasOwn(PRODUCTION_CANDIDATE_COUNTS, profile.profileId)
      ? PRODUCTION_CANDIDATE_COUNTS[profile.profileId]
      : DEFAULT_PRODUCTION_CANDIDATE_COUNT
    : DEFAULT_PRODUCTION_CANDIDATE_COUNT;
  const diagnostics = baseDiagnostics(contract, profile, requestedSeed, candidateCount);

  if (!contract || !contract.prepared || !contract.dictionary)
    return failureResult(diagnostics, "QUALITY_SELECTION_EXCEPTION");
  if (!profile || !isMeasuredProductionProfile(profile))
    return failureResult(diagnostics, "QUALITY_PROFILE_UNAVAILABLE");
  if (!candidateCount)
    return failureResult(diagnostics, "QUALITY_PROFILE_UNAVAILABLE");
  if (!Number.isInteger(requestedSeed) || requestedSeed < 0 || requestedSeed > 0xffffffff)
    return failureResult(diagnostics, "QUALITY_SELECTION_EXCEPTION");
  if (options.isCancelled?.())
    return failureResult(diagnostics, "QUALITY_SELECTION_CANCELLED");

  const selectorLimits = {
    ...scaleSelectorLimits(candidateCount),
    ...(options.selectorLimits || {}),
    maxCandidates: candidateCount,
  };
  try {
    const result = await selectRoundBoard(contract, {
      requestedSeed,
      candidateCount,
      limits: selectorLimits,
      analysisIndex:
        options.analysisIndex ||
        getPreparedAnalysisIndex(contract.dictionary.id, contract.validationMode),
      isCancelled: options.isCancelled,
      yieldScheduler: options.yieldScheduler,
    });
    const normalized = normalizeDiagnostics(contract, profile, candidateCount, result);
    if (!result?.ok) {
      return failureResult(
        normalized,
        result?.error?.code || "QUALITY_SELECTION_EXCEPTION",
        result?.error?.reasons || [],
      );
    }
    if (options.isCancelled?.())
      return failureResult(normalized, "QUALITY_SELECTION_CANCELLED");
    return {
      ok: true,
      board: result.board,
      report: result.report,
      requestedSeed,
      selectedCandidateSeed: result.selectedCandidateSeed,
      diagnostics: normalized,
      compactDiagnostics: compactRoundDiagnostics(normalized, result),
    };
  } catch {
    return failureResult(
      { ...diagnostics, elapsedMs: 0 },
      options.isCancelled?.()
        ? "QUALITY_SELECTION_CANCELLED"
        : "QUALITY_SELECTION_EXCEPTION",
    );
  }
}

module.exports = {
  DEFAULT_PRODUCTION_CANDIDATE_COUNT,
  LONG_HAUL_PROFILE_ID,
  PRODUCTION_CANDIDATE_COUNTS,
  PRODUCTION_SELECTOR_VERSION,
  isMeasuredProductionProfile,
  scaleSelectorLimits,
  compactRoundDiagnostics,
  generateQualityRoundBoard,
};
