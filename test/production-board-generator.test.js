const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_DICTIONARY_ID, getDictionary } = require("../dictionary-registry");
const { getPreparedLexicon } = require("../game-core");
const {
  generateQualityRoundBoard,
  DEFAULT_PRODUCTION_CANDIDATE_COUNT,
  isMeasuredProductionProfile,
  PRODUCTION_SELECTOR_VERSION,
} = require("../production-board-generator");
const { getQualityProfile } = require("../board-quality");

function contract(size = 4, minimum = 3, validationMode = "classic") {
  const dictionary = getDictionary(DEFAULT_DICTIONARY_ID);
  return {
    size,
    minimum,
    validationMode,
    dictionary,
    prepared: getPreparedLexicon(dictionary.id, validationMode),
  };
}

test("production wrapper uses measured policy and preserves requested seed identity", async () => {
  const requestedSeed = 0x12345678;
  const first = await generateQualityRoundBoard(contract(), { requestedSeed });
  const second = await generateQualityRoundBoard(contract(), { requestedSeed });
  assert.equal(first.ok, true);
  assert.equal(first.diagnostics.selectorVersion, PRODUCTION_SELECTOR_VERSION);
  assert.equal(first.diagnostics.candidateCount, DEFAULT_PRODUCTION_CANDIDATE_COUNT);
  assert.equal(first.requestedSeed, requestedSeed);
  assert.equal(first.diagnostics.requestedSeed, requestedSeed);
  assert.equal(first.diagnostics.candidateSeeds[0], requestedSeed);
  assert.equal(Number.isInteger(first.selectedCandidateSeed), true);
  assert.equal(first.selectedCandidateSeed, first.diagnostics.selectedCandidateSeed);
  assert.deepEqual(first.board, second.board);
  assert.equal(first.selectedCandidateSeed, second.selectedCandidateSeed);
  assert.equal(first.diagnostics.selectedFingerprint, second.diagnostics.selectedFingerprint);
  assert.equal(first.diagnostics.dictionary.dictionaryId, DEFAULT_DICTIONARY_ID);
  assert.equal(typeof first.diagnostics.dictionary.artifactSha256, "string");
});

test("unmeasured validated profiles are unavailable without an old-generator fallback", async () => {
  const result = await generateQualityRoundBoard(contract(4, 7), { requestedSeed: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "QUALITY_PROFILE_UNAVAILABLE");
  assert.equal(result.board, undefined);
  assert.equal(result.diagnostics.profileId, "4x4-min7");
});

test("supplementary profiles are eligible and Long Haul uses accepted best-of-six", async () => {
  assert.equal(isMeasuredProductionProfile(getQualityProfile(4, 4, "classic")), true);
  const result = await generateQualityRoundBoard(contract(6, 6), { requestedSeed: 11 });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.profileId, "6x6-min6");
  assert.equal(result.diagnostics.candidateCount, 6);
  assert.equal(result.diagnostics.candidates.length, 6);
});

test("invalid seed, cancellation, and selector exceptions return no board", async () => {
  const invalidSeed = await generateQualityRoundBoard(contract(), { requestedSeed: -1 });
  assert.equal(invalidSeed.ok, false);
  assert.equal(invalidSeed.error.code, "QUALITY_SELECTION_EXCEPTION");
  assert.equal(invalidSeed.board, undefined);

  const cancelled = await generateQualityRoundBoard(contract(), {
    requestedSeed: 1,
    isCancelled: () => true,
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, "QUALITY_SELECTION_CANCELLED");
  assert.equal(cancelled.board, undefined);

  const malformedDictionary = {
    ...contract(),
    dictionary: { id: "missing-dictionary", metadata: {} },
  };
  const exception = await generateQualityRoundBoard(malformedDictionary, { requestedSeed: 1 });
  assert.equal(exception.ok, false);
  assert.equal(exception.error.code, "QUALITY_SELECTION_EXCEPTION");
  assert.equal(exception.board, undefined);
});
