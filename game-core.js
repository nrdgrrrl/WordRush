const fs = require("node:fs");
const {
  MODE_CONFIG,
  COMMON_WORDS,
  ADULT_WORDS,
  LETTER_BAG,
} = require("./game-config");
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
function normalizeWords(words) {
  return [
    ...new Set(
      (words || [])
        .map((word) => String(word).trim().toUpperCase())
        .filter((word) => /^[A-Z]{3,}$/.test(word)),
    ),
  ];
}
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
function neighbors(index, size) {
  const row = Math.floor(index / size),
    col = index % size,
    result = [];
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr,
        c = col + dc;
      if ((dr || dc) && r >= 0 && c >= 0 && r < size && c < size)
        result.push(r * size + c);
    }
  return result;
}
function findPlacement(word, size, cells) {
  for (const start of [...Array(size * size).keys()].sort(
    () => Math.random() - 0.5,
  )) {
    if (cells[start] && cells[start] !== word[0]) continue;
    const path = [start],
      used = new Set(path);
    function walk() {
      if (path.length === word.length) return true;
      for (const next of neighbors(path.at(-1), size)
        .filter(
          (index) =>
            !used.has(index) &&
            (!cells[index] || cells[index] === word[path.length]),
        )
        .sort(() => Math.random() - 0.5)) {
        path.push(next);
        used.add(next);
        if (walk()) return true;
        path.pop();
        used.delete(next);
      }
      return false;
    }
    if (walk()) return path;
  }
  return null;
}
function hasPath(board, size, word) {
  for (let start = 0; start < board.length; start++) {
    if (board[start] !== word[0]) continue;
    const used = new Set([start]);
    function walk(index, depth) {
      if (depth === word.length) return true;
      for (const next of neighbors(index, size))
        if (!used.has(next) && board[next] === word[depth]) {
          used.add(next);
          if (walk(next, depth + 1)) return true;
          used.delete(next);
        }
      return false;
    }
    if (walk(start, 1)) return true;
  }
  return false;
}
function generateBoard(size, lexicon, options = {}) {
  const words = normalizeWords(lexicon).filter(
    (word) => word.length <= Math.min(12, size * size),
  );
  const dirtyWords = ADULT_WORDS.filter((word) => words.includes(word));
  const dirtyLexicon = dirtyWords.length === ADULT_WORDS.length;
  const preferred = new Set(
    normalizeWords(options.preferredWords || []).concat(
      dirtyLexicon ? dirtyWords : [],
    ),
  );
  for (let attempt = 0; attempt < 40; attempt++) {
    const cells = Array(size * size).fill("");
    const targets = dirtyLexicon
      ? [...dirtyWords].sort(() => Math.random() - 0.5).slice(0, 7)
      : [];
    targets.push(
      ...[3, 4, 5, 6]
        .map((length, bucket) => {
          const matches = (word) =>
            bucket === 3 ? word.length >= length : word.length === length;
          const preferredCandidates = words.filter(
            (word) => preferred.has(word) && matches(word),
          );
          const candidates = preferredCandidates.length
            ? preferredCandidates
            : words.filter(matches);
          return candidates[Math.floor(Math.random() * candidates.length)];
        })
        .filter(Boolean),
    );
    targets
      .sort((a, b) => b.length - a.length)
      .forEach((word) => {
        const path = findPlacement(word, size, cells);
        if (path)
          path.forEach((index, offset) => {
            cells[index] = word[offset];
          });
      });
    const board = cells.map(
      (char) =>
        char || LETTER_BAG[Math.floor(Math.random() * LETTER_BAG.length)],
    );
    const coverage = [3, 4, 5, 6].filter((length, bucket) =>
      targets.some(
        (word) =>
          (bucket === 3 ? word.length >= length : word.length === length) &&
          hasPath(board, size, word),
      ),
    );
    const dirtyCoverage = dirtyWords.filter((word) =>
      hasPath(board, size, word),
    ).length;
    if (
      coverage.length >= Math.min(4, words.length ? 4 : 0) &&
      (!dirtyLexicon || dirtyCoverage >= Math.min(5, dirtyWords.length))
    )
      return board;
  }
  return Array.from(
    { length: size * size },
    () => LETTER_BAG[Math.floor(Math.random() * LETTER_BAG.length)],
  );
}
function createLexicon(mode, customWords = []) {
  const base = mode === "dirty" ? BASE_DIRTY_WORDS : BASE_WORDS;
  return customWords.length ? normalizeWords([...base, ...customWords]) : base;
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
  customWords,
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
    lexicon = customWords?.length
      ? new Set(createLexicon(mode, customWords))
      : mode === "dirty"
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
