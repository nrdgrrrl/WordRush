const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MODE_CONFIG,
  RANDOM_RUSH_MODES,
  RANDOM_RUSH_EXCLUDED_MODES,
  ADULT_WORDS,
  generateBoard,
  getPreparedLexicon,
  createLexicon,
  isDictionaryWord,
  hasPath,
  validateSubmission,
} = require("../game-core");
const {
  configForPreset,
  validateCustomConfig,
  shouldEndOnRejectedWord,
} = require("../game-config");
const boardCore = require("../board-core");
test("Random Rush includes every eligible built-in game mode", () => {
  assert.deepEqual(RANDOM_RUSH_EXCLUDED_MODES, ["coop", "dirty"]);
  assert.deepEqual(
    RANDOM_RUSH_MODES,
    Object.keys(MODE_CONFIG).filter(
      (mode) => !RANDOM_RUSH_EXCLUDED_MODES.includes(mode),
    ),
  );
  assert.deepEqual(RANDOM_RUSH_MODES, [
    "classic",
    "minimum",
    "sudden",
    "race",
    "blitz",
    "longhaul",
    "storm",
    "scoreattack",
    "chain",
  ]);
});
test("dictionary membership uses the shared server lexicon", () => {
  assert.equal(isDictionaryWord("tea"), true);
  assert.equal(isDictionaryWord("CAR"), true);
  assert.equal(isDictionaryWord("WORDRUSHISNOTAWORD"), false);
  assert.equal(isDictionaryWord("SHIT"), false);
  assert.equal(isDictionaryWord("SHIT", "dirty"), true);
});
test("configured boards are bounded, deterministic, and pathable", () => {
  for (const [mode, config] of Object.entries(MODE_CONFIG)) {
    const generationMode = mode === "dirty" ? "dirty" : "classic";
    const prepared = getPreparedLexicon(generationMode);
    const first = generateBoard(config.size, prepared, {
      mode: generationMode,
      min: config.min,
      seed: 0x12345678,
    });
    const second = generateBoard(config.size, prepared, {
      mode: generationMode,
      min: config.min,
      seed: 0x12345678,
    });
    assert.equal(first.ok, true, `${mode} should generate`);
    assert.equal(second.ok, true, `${mode} should reproduce`);
    assert.deepEqual(first.board, second.board, mode);
    assert.deepEqual(
      { ...first.diagnostics, elapsedMs: 0 },
      { ...second.diagnostics, elapsedMs: 0 },
      mode,
    );
    assert.equal(first.board.length, config.size * config.size);
    assert.ok(first.board.every((letter) => /^[A-Z]$/.test(letter)));
    assert.ok(
      createLexicon(generationMode).some(
        (word) =>
          word.length >= config.min && hasPath(first.board, config.size, word),
      ),
    );
    assert.ok(first.diagnostics.attemptCount <= 32, mode);
    assert.ok(first.diagnostics.placementOperationCount <= 250000, mode);
    assert.ok(first.diagnostics.backtrackCount <= 125000, mode);
  }
});
test("prepared indexes and sparse lexicons fail explicitly", () => {
  const prepared = boardCore.prepareLexicon([
    " dog ",
    "DOG",
    "SHIT",
    "AB",
  ]);
  assert.equal(prepared.normalizedCount, 2);
  assert.equal(prepared.candidateCounts(4, "classic", 3).minimum, 1);
  assert.equal(prepared.candidateCounts(4, "classic", 3).adult, 1);
  const sparse = boardCore.prepareLexicon(["AB", "A1"]);
  const result = generateBoard(4, sparse, {
    mode: "classic",
    min: 3,
    seed: 1,
  });
  const repeat = generateBoard(4, sparse, {
    mode: "classic",
    min: 3,
    seed: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NO_MINIMUM_CANDIDATE");
  assert.equal(repeat.error.code, result.error.code);
  assert.deepEqual(
    { ...result.diagnostics, elapsedMs: 0 },
    { ...repeat.diagnostics, elapsedMs: 0 },
  );
  assert.equal(result.diagnostics.attemptCount, 0);
  assert.equal(result.diagnostics.placementOperationCount, 0);
});
test("cooperative generation preserves deterministic results and yields", async () => {
  const prepared = boardCore.prepareLexicon([
    "CAT", "DOG", "STAR", "STARE", "STONE", "STREAM", "PLANET",
    "PLANT", "HEART", "HOUSE", "TRACE", "BRAIN", "WORDS", "RUSH",
  ]);
  const synchronous = generateBoard(8, prepared, {
    mode: "classic",
    min: 3,
    seed: 99,
    limits: { operationsPerYield: 1 },
  });
  const cooperative = await boardCore.generateBoardCooperatively(8, prepared, {
    mode: "classic",
    min: 3,
    seed: 99,
    limits: { operationsPerYield: 1 },
    yieldScheduler: () => Promise.resolve(),
  });
  assert.deepEqual(
    { ...synchronous, diagnostics: { ...synchronous.diagnostics, elapsedMs: 0 } },
    { ...cooperative, diagnostics: { ...cooperative.diagnostics, elapsedMs: 0 } },
  );
  assert.ok(cooperative.diagnostics.yieldCount > 0);
});
test("submissions require contiguous non-repeating paths", () => {
  const board = [
    "S",
    "T",
    "A",
    "R",
    "E",
    "L",
    "I",
    "N",
    "O",
    "P",
    "C",
    "H",
    "D",
    "U",
    "M",
    "S",
  ];
  assert.equal(
    validateSubmission({
      board,
      size: 4,
      word: "STAR",
      path: [0, 1, 2, 3],
      mode: "classic",
      found: new Set(),
    }).valid,
    true,
  );
  assert.equal(
    validateSubmission({
      board,
      size: 4,
      word: "STAR",
      path: [0, 1, 2, 3],
      mode: "classic",
      found: new Set(["STAR"]),
    }).reason,
    "duplicate",
  );
  assert.equal(
    validateSubmission({
      board,
      size: 4,
      word: "STAR",
      path: [0, 1, 2, 7],
      mode: "classic",
      found: new Set(),
    }).valid,
    false,
  );
});
test("dirty words are opt-in and custom-only words are rejected", () => {
  const board = ["S", "H", "I", "A", "B", "T", "C", "D", "E"];
  assert.equal(
    validateSubmission({
      board,
      size: 3,
      word: "SHIT",
      path: [0, 1, 2, 5],
      mode: "classic",
      found: new Set(),
    }).valid,
    false,
  );
  assert.equal(
    validateSubmission({
      board,
      size: 3,
      word: "SHIT",
      path: [0, 1, 2, 5],
      mode: "dirty",
      found: new Set(),
    }).valid,
    true,
  );
  const customOnlyBoard = ["X", "X", "X", "A", "B", "C", "X", "X", "D"];
  assert.equal(
    validateSubmission({
      board: customOnlyBoard,
      size: 3,
      word: "ABCD",
      path: [3, 4, 5, 8],
      mode: "classic",
      found: new Set(),
    }).valid,
    false,
  );
});
test("dirty boards strongly favor playable adult words", () => {
  for (const size of [4, 5, 6, 7, 8]) {
    const result = generateBoard(size, getPreparedLexicon("dirty"), {
      mode: "dirty",
      min: 3,
      seed: size,
    });
    assert.equal(result.ok, true, `dirty ${size}x${size}`);
    const board = result.board;
    const playableAdultWords = ADULT_WORDS.filter(
      (word) => word.length <= size * size && hasPath(board, size, word),
    );
    assert.ok(
      playableAdultWords.length >= 5,
      `expected at least 5 dirty words on ${size}\u00d7${size}, found ${playableAdultWords.length}`,
    );
  }
});
test("canonical config matches expected shape and validates correctly", () => {
  for (const [mode, expected] of Object.entries({
    classic: { sudden: false, chain: false, adult: false, party: false, target: null },
    minimum: { sudden: false, chain: false, adult: false, party: false, target: null },
    sudden: { sudden: true, chain: false, adult: false, party: false, target: null },
    race: { sudden: false, chain: false, adult: false, party: false, target: 500 },
    dirty: { sudden: false, chain: false, adult: true, party: false, target: null },
    chain: { sudden: false, chain: true, adult: false, party: false, target: null },
    scoreattack: { sudden: false, chain: false, adult: false, party: false, target: 250 },
    coop: { sudden: false, chain: false, adult: false, party: false, target: null },
    blitz: { sudden: false, chain: false, adult: false, party: false, target: null },
    longhaul: { sudden: false, chain: false, adult: false, party: false, target: null },
    storm: { sudden: false, chain: false, adult: false, party: false, target: null },
  })) {
    const config = configForPreset(mode);
    assert.ok(config, `preset ${mode} should exist`);
    for (const [field, value] of Object.entries(expected))
      assert.equal(config[field], value, `${mode}.${field}`);
  }
  assert.equal(configForPreset("nonexistent"), null);
  const valid = validateCustomConfig({ label: "X", min: 5, size: 6, seconds: 60, rule: "Y", sudden: true });
  assert.equal(valid.valid, true);
  assert.equal(valid.config.sudden, true);
  assert.equal(valid.config.party, false);
  assert.equal(valid.config.adult, false);
  const party = validateCustomConfig({ label: "Party!", min: 3, size: 5, seconds: 120, rule: "Z", party: true });
  assert.equal(party.valid, true);
  assert.equal(party.config.party, true);
  const adult = validateCustomConfig({ label: "A", min: 3, size: 4, seconds: 60, rule: "B", adult: true });
  assert.equal(adult.valid, true);
  assert.equal(adult.config.adult, true);
  const target = validateCustomConfig({ label: "T", min: 3, size: 4, seconds: 60, rule: "R", target: 100 });
  assert.equal(target.valid, true);
  assert.equal(target.config.target, 100);
  const arrays = validateCustomConfig(["LABEL", 3, 4, 120, "rule", {}]);
  assert.equal(arrays.valid, false);
  const noLabel = validateCustomConfig({ min: 3, size: 4, seconds: 60, rule: "R" });
  assert.equal(noLabel.valid, false);
  const minLow = validateCustomConfig({ label: "L", min: 1, size: 4, seconds: 60, rule: "R" });
  assert.equal(minLow.valid, false);
  const sizeHigh = validateCustomConfig({ label: "L", min: 3, size: 9, seconds: 60, rule: "R" });
  assert.equal(sizeHigh.valid, false);
  const secondsLow = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 5, rule: "R" });
  assert.equal(secondsLow.valid, false);
  const targetLow = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 60, rule: "R", target: 0 });
  assert.equal(targetLow.valid, false);
  const chain = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 60, rule: "R", chain: true });
  assert.equal(chain.valid, false);
  const chainStr = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 60, rule: "R", chain: "true" });
  assert.equal(chainStr.valid, false);
  const chainNum = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 60, rule: "R", chain: 1 });
  assert.equal(chainNum.valid, false);
  const chainNull = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 60, rule: "R", chain: null });
  assert.equal(chainNull.valid, false);
  const contradict = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 60, rule: "R", sudden: true, target: 500 });
  assert.equal(contradict.valid, false);
  const strMin = validateCustomConfig({ label: "L", min: "3", size: 4, seconds: 60, rule: "R" });
  assert.equal(strMin.valid, false);
  const strSize = validateCustomConfig({ label: "L", min: 3, size: "4", seconds: 60, rule: "R" });
  assert.equal(strSize.valid, false);
  const strSeconds = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: "60", rule: "R" });
  assert.equal(strSeconds.valid, false);
  const strTarget = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 60, rule: "R", target: "500" });
  assert.equal(strTarget.valid, false);
  const badAdult = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 60, rule: "R", adult: "true" });
  assert.equal(badAdult.valid, false);
  const badSudden = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 60, rule: "R", sudden: 1 });
  assert.equal(badSudden.valid, false);
  const badParty = validateCustomConfig({ label: "L", min: 3, size: 4, seconds: 60, rule: "R", party: "true" });
  assert.equal(badParty.valid, false);
});
test("shouldEndOnRejectedWord matches expected semantics", () => {
  for (const { config, reason, expected } of [
    { config: { sudden: true }, reason: "minimum", expected: true },
    { config: { sudden: true }, reason: "dictionary", expected: true },
    { config: { sudden: true }, reason: "path", expected: true },
    { config: { sudden: true }, reason: "chain", expected: true },
    { config: { sudden: true }, reason: "duplicate", expected: false },
    { config: { sudden: false }, reason: "minimum", expected: false },
    { config: { sudden: false }, reason: "duplicate", expected: false },
  ])
    assert.equal(shouldEndOnRejectedWord(config, reason), expected);
});
