const {
  MODE_CONFIG,
  RANDOM_RUSH_MODES,
  RANDOM_RUSH_EXCLUDED_MODES,
  COMMON_WORDS,
  ADULT_WORDS,
} = require("./game-config");
const boardCore = require("./board-core");
const {
  DEFAULT_DICTIONARY_ID,
  getDictionary,
  getDictionaryMetadata,
} = require("./dictionary-registry");
const ADULT_SET = new Set(ADULT_WORDS);
const normalizeWords = boardCore.normalizeWords;
const PREPARED_LEXICONS = new Map();
const EFFECTIVE_WORDS = new Map();
const EFFECTIVE_WORD_SETS = new Map();
const {
  neighbors,
  hasPath,
  generateBoard,
  generateBoardCooperatively,
} = boardCore;
function dictionaryArgs(dictionaryIdOrMode, mode) {
  if (dictionaryIdOrMode === "classic" || dictionaryIdOrMode === "dirty")
    return { dictionaryId: DEFAULT_DICTIONARY_ID, mode: dictionaryIdOrMode };
  return {
    dictionaryId: dictionaryIdOrMode || DEFAULT_DICTIONARY_ID,
    mode: mode || "classic",
  };
}

function effectiveWords(dictionaryIdOrMode, mode) {
  const args = dictionaryArgs(dictionaryIdOrMode, mode);
  const key = `${args.dictionaryId}:${args.mode}`;
  if (EFFECTIVE_WORDS.has(key)) return EFFECTIVE_WORDS.get(key);
  const dictionary = getDictionary(args.dictionaryId);
  const standardWords = dictionary.words.filter((word) => !ADULT_SET.has(word));
  const words = Object.freeze(args.mode === "dirty"
    ? normalizeWords([...standardWords, ...ADULT_WORDS])
    : standardWords);
  EFFECTIVE_WORDS.set(key, words);
  return words;
}

function createLexicon(dictionaryIdOrMode = DEFAULT_DICTIONARY_ID, mode = "classic") {
  return effectiveWords(dictionaryIdOrMode, mode);
}

function getPreparedLexicon(dictionaryIdOrMode = DEFAULT_DICTIONARY_ID, mode = "classic") {
  const args = dictionaryArgs(dictionaryIdOrMode, mode);
  const key = `${args.dictionaryId}:${args.mode}`;
  if (PREPARED_LEXICONS.has(key)) return PREPARED_LEXICONS.get(key);
  const prepared = boardCore.prepareLexicon(effectiveWords(args.dictionaryId, args.mode), {
    adultWords: ADULT_WORDS,
    preferredWords: args.mode === "dirty"
      ? [...COMMON_WORDS, ...ADULT_WORDS]
      : COMMON_WORDS,
  });
  PREPARED_LEXICONS.set(key, prepared);
  return prepared;
}
function isDictionaryWord(word, dictionaryIdOrMode = DEFAULT_DICTIONARY_ID, mode = "classic") {
  const cleanWord = String(word || "").trim().toUpperCase();
  const args = dictionaryArgs(dictionaryIdOrMode, mode);
  const key = `${args.dictionaryId}:${args.mode}`;
  if (!EFFECTIVE_WORD_SETS.has(key))
    EFFECTIVE_WORD_SETS.set(key, new Set(effectiveWords(args.dictionaryId, args.mode)));
  return EFFECTIVE_WORD_SETS.get(key).has(cleanWord);
}
function validateSubmission({
  board,
  size,
  word,
  path,
  mode,
  dictionaryId = DEFAULT_DICTIONARY_ID,
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
    dictionaryWord = isDictionaryWord(cleanWord, dictionaryId, mode),
    valid =
      cleanWord.length >= (Number.isFinite(minimum) ? minimum : config.min) &&
      dictionaryWord &&
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
            : !dictionaryWord
              ? "dictionary"
              : "unknown",
  };
}
module.exports = {
  MODE_CONFIG,
  RANDOM_RUSH_MODES,
  RANDOM_RUSH_EXCLUDED_MODES,
  ADULT_WORDS,
  DEFAULT_DICTIONARY_ID,
  getDictionaryMetadata,
  normalizeWords,
  neighbors,
  hasPath,
  generateBoard,
  generateBoardCooperatively,
  createLexicon,
  getPreparedLexicon,
  isDictionaryWord,
  validateSubmission,
};
