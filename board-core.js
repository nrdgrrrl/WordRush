(function exposeBoardCore(root, factory) {
  const value = factory(typeof module === "object" && module.exports ? require("./game-config") : root.WordrushConfig);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.WordrushBoardCore = value;
})(globalThis, ({ ADULT_WORDS, LETTER_BAG }) => {
  const normalizeWords = (words) => [...new Set((words || []).map((word) => String(word).trim().toUpperCase()).filter((word) => /^[A-Z]{3,}$/.test(word)))];
  function neighbors(index, size) {
    const row = Math.floor(index / size), column = index % size, result = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const nextRow = row + dr, nextColumn = column + dc;
      if ((dr || dc) && nextRow >= 0 && nextColumn >= 0 && nextRow < size && nextColumn < size) result.push(nextRow * size + nextColumn);
    }
    return result;
  }
  function findPlacement(word, size, cells) {
    for (const start of [...Array(size * size).keys()].sort(() => Math.random() - 0.5)) {
      if (cells[start] && cells[start] !== word[0]) continue;
      const path = [start], used = new Set(path);
      function walk() {
        if (path.length === word.length) return true;
        for (const next of neighbors(path.at(-1), size).filter((index) => !used.has(index) && (!cells[index] || cells[index] === word[path.length])).sort(() => Math.random() - 0.5)) {
          path.push(next); used.add(next);
          if (walk()) return true;
          path.pop(); used.delete(next);
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
        for (const next of neighbors(index, size)) if (!used.has(next) && board[next] === word[depth]) {
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
    const words = normalizeWords(lexicon).filter((word) => word.length <= Math.min(12, size * size));
    const dirtyWords = ADULT_WORDS.filter((word) => words.includes(word));
    const dirty = dirtyWords.length === ADULT_WORDS.length;
    const preferred = new Set(normalizeWords(options.preferredWords || []).concat(dirty ? dirtyWords : []));
    for (let attempt = 0; attempt < 200; attempt++) {
      const cells = Array(size * size).fill("");
      const targets = dirty ? [...dirtyWords].sort(() => Math.random() - 0.5).slice(0, 7) : [];
      targets.push(...[3, 4, 5, 6].map((length, bucket) => {
        const matches = (word) => bucket === 3 ? word.length >= length : word.length === length;
        const preferredCandidates = words.filter((word) => preferred.has(word) && matches(word));
        const candidates = preferredCandidates.length ? preferredCandidates : words.filter(matches);
        return candidates[Math.floor(Math.random() * candidates.length)];
      }).filter(Boolean));
      targets.sort((a, b) => b.length - a.length).forEach((word) => {
        const path = findPlacement(word, size, cells);
        path?.forEach((index, offset) => { cells[index] = word[offset]; });
      });
      const board = cells.map((letter) => letter || LETTER_BAG[Math.floor(Math.random() * LETTER_BAG.length)]);
      const coverage = [3, 4, 5, 6].filter((length, bucket) => targets.some((word) => (bucket === 3 ? word.length >= length : word.length === length) && hasPath(board, size, word)));
      const dirtyCoverage = dirtyWords.filter((word) => hasPath(board, size, word)).length;
      if (coverage.length >= Math.min(4, words.length ? 4 : 0) && (!dirty || dirtyCoverage >= Math.min(5, dirtyWords.length))) return board;
    }
    if (dirty && size >= 4) {
      const seed = "NOLKCDCSITHIBITD", board = Array.from({ length: size * size }, () => LETTER_BAG[Math.floor(Math.random() * LETTER_BAG.length)]);
      const offsetRow = Math.floor(Math.random() * (size - 3)), offsetColumn = Math.floor(Math.random() * (size - 3));
      for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) board[(row + offsetRow) * size + column + offsetColumn] = seed[row * 4 + column];
      return board;
    }
    return Array.from({ length: size * size }, () => LETTER_BAG[Math.floor(Math.random() * LETTER_BAG.length)]);
  }
  return Object.freeze({ normalizeWords, neighbors, hasPath, generateBoard });
});
