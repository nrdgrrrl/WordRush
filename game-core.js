const fs = require("node:fs");
const {
  MODE_CONFIG,
  RANDOM_RUSH_MODES,
  RANDOM_RUSH_EXCLUDED_MODES,
  COMMON_WORDS,
  ADULT_WORDS,
} = require("./game-config");
const boardCore = require("./board-core");
const SYSTEM_WORDS = (() => {
  for (const file of [
    "/usr/share/dict/american-english",
    "/usr/share/dict/words",
  ]) {
    try {
      return fs.readFileSync(file, "utf8").split(/\r?\n/);
    } catch {}
  }
  return [];
})();
const ADULT_SET = new Set(ADULT_WORDS);
const normalizeWords = boardCore.normalizeWords;
const BASE_WORDS = normalizeWords([
  ...COMMON_WORDS,
  ...SYSTEM_WORDS.filter(
    (word) => !ADULT_SET.has(String(word).trim().toUpperCase()),
  ),
]);
const BASE_DIRTY_WORDS = normalizeWords([...BASE_WORDS, ...ADULT_WORDS]);
const BASE_WORD_SETS = {
  classic: new Set(BASE_WORDS),
  dirty: new Set(BASE_DIRTY_WORDS),
};
const { neighbors, hasPath, generateBoard } = boardCore;
function createLexicon(mode) {
  return mode === "dirty" ? BASE_DIRTY_WORDS : BASE_WORDS;
}
function isDictionaryWord(word, mode = "classic") {
  const cleanWord = String(word || "").trim().toUpperCase();
  return (mode === "dirty" ? BASE_WORD_SETS.dirty : BASE_WORD_SETS.classic).has(
    cleanWord,
  );
}
function validateSubmission({
  board,
  size,
  word,
  path,
  mode,
  minimum,
  found,
}) {
  const config = MODE_CONFIG[mode] || MODE_CONFIG.classic,
    cleanWord = String(word || "").toUpperCase(),
    indexes = Array.isArray(path) ? path.map(Number) : [],
    validPath =
      indexes.length === cleanWord.length &&
      indexes.every(
        (index, position) =>
          Number.isInteger(index) &&
          index >= 0 &&
          index < board.length &&
          board[index] === cleanWord[position] &&
          (position === 0 ||
            neighbors(indexes[position - 1], size).includes(index)) &&
          indexes.indexOf(index) === position,
      ),
    lexicon = mode === "dirty"
      ? BASE_WORD_SETS.dirty
      : BASE_WORD_SETS.classic,
    valid =
      cleanWord.length >= (Number.isFinite(minimum) ? minimum : config.min) &&
      lexicon.has(cleanWord) &&
      validPath &&
      !found.has(cleanWord);
  return {
    valid,
    word: cleanWord,
    points: valid ? cleanWord.length * cleanWord.length : 0,
    reason:
      cleanWord.length < (Number.isFinite(minimum) ? minimum : config.min)
        ? "minimum"
        : !validPath
          ? "path"
          : found.has(cleanWord)
            ? "duplicate"
            : !lexicon.has(cleanWord)
              ? "dictionary"
              : "unknown",
  };
}
module.exports = {
  MODE_CONFIG,
  RANDOM_RUSH_MODES,
  RANDOM_RUSH_EXCLUDED_MODES,
  COMMON_WORDS,
  ADULT_WORDS,
  normalizeWords,
  neighbors,
  hasPath,
  generateBoard,
  createLexicon,
  isDictionaryWord,
  validateSubmission,
};
