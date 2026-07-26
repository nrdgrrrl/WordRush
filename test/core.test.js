const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MODE_CONFIG,
  RANDOM_RUSH_MODES,
  RANDOM_RUSH_EXCLUDED_MODES,
  ADULT_WORDS,
  generateBoard,
  createLexicon,
  isDictionaryWord,
  hasPath,
  validateSubmission,
} = require("../game-core");
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
test("configured boards are full and pathable", () => {
  for (const [mode, config] of Object.entries(MODE_CONFIG)) {
    const board = generateBoard(config.size, createLexicon(mode));
    assert.equal(board.length, config.size * config.size);
    assert.ok(board.every((letter) => /^[A-Z]$/.test(letter)));
    assert.ok(
      createLexicon(mode).some(
        (word) =>
          word.length >= config.min && hasPath(board, config.size, word),
      ),
    );
  }
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
      customWords: [],
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
      customWords: [],
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
      customWords: [],
    }).valid,
    false,
  );
});
test("dirty words are opt-in and custom words are accepted", () => {
  const board = ["S", "H", "I", "A", "B", "T", "C", "D", "E"];
  assert.equal(
    validateSubmission({
      board,
      size: 3,
      word: "SHIT",
      path: [0, 1, 2, 5],
      mode: "classic",
      found: new Set(),
      customWords: [],
    }).valid,
    false,
  );
  assert.equal(
    validateSubmission({
      board,
      size: 3,
      word: "SHIT",
      path: [0, 1, 2, 3],
      path: [0, 1, 2, 5],
      mode: "dirty",
      found: new Set(),
      customWords: [],
    }).valid,
    true,
  );
  const customBoard = ["X", "X", "X", "A", "B", "C", "X", "X", "D"];
  assert.equal(
    validateSubmission({
      board: customBoard,
      size: 3,
      word: "ABCD",
      path: [3, 4, 5, 8],
      mode: "classic",
      found: new Set(),
      customWords: ["ABCD"],
    }).valid,
    true,
  );
});
test("dirty boards strongly favor playable adult words", () => {
  for (const size of [4, 5, 6, 7, 8]) {
    const board = generateBoard(size, createLexicon("dirty"));
    const playableAdultWords = ADULT_WORDS.filter(
      (word) => word.length <= size * size && hasPath(board, size, word),
    );
    assert.ok(
      playableAdultWords.length >= 5,
      `expected at least 5 dirty words on ${size}×${size}, found ${playableAdultWords.length}`,
    );
  }
});
