const { neighbors, walkBoardPaths, normalizeWords } = require("./board-core");

const LENGTH_BUCKETS = Object.freeze([
  ["3-4", (length) => length >= 3 && length <= 4],
  ["5-6", (length) => length >= 5 && length <= 6],
  ["7-8", (length) => length >= 7 && length <= 8],
  ["9+", (length) => length >= 9],
]);

function boardCells(board) {
  if (Array.isArray(board)) return board.slice();
  if (typeof board === "string") return [...board];
  throw new TypeError("A board array or string is required");
}

function validateInputs(board, size, minimum) {
  const cells = boardCells(board);
  if (!Number.isInteger(size) || size < 1 || cells.length !== size * size)
    throw new RangeError("Board size must match the board cell count");
  if (!Number.isInteger(minimum) || minimum < 1)
    throw new RangeError("Minimum word length must be a positive integer");
  if (!cells.every((letter) => typeof letter === "string" && /^[A-Z]$/.test(letter)))
    throw new TypeError("Board cells must be uppercase A-Z letters");
  return cells;
}

function normalizedLexicon(lexicon) {
  if (!lexicon || typeof lexicon[Symbol.iterator] !== "function")
    throw new TypeError("An iterable lexicon is required");
  return normalizeWords([...lexicon]);
}

function createTrie(words) {
  const root = { children: new Map(), word: null };
  for (const word of words) {
    let node = root;
    for (const letter of word) {
      if (!node.children.has(letter))
        node.children.set(letter, { children: new Map(), word: null });
      node = node.children.get(letter);
    }
    node.word = word;
  }
  return root;
}

function sortNumbers(numbers) {
  return [...numbers].sort((a, b) => a - b);
}

function solveBoard({ board, size, minimum = 3, lexicon }) {
  const cells = validateInputs(board, size, minimum);
  const words = normalizedLexicon(lexicon);
  const root = createTrie(words);
  const wordTiles = new Map();

  walkBoardPaths(
    cells,
    size,
    root,
    (node, letter) => node.children.get(letter),
    (path, node) => {
      if (node.word && node.word.length >= minimum) {
        if (!wordTiles.has(node.word)) wordTiles.set(node.word, new Set());
        const tiles = wordTiles.get(node.word);
        for (const tile of path) tiles.add(tile);
      }
      return false;
    },
  );

  const playableWords = [...wordTiles.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const wordTileIndices = Object.fromEntries(
    playableWords.map((word) => [word, sortNumbers(wordTiles.get(word))]),
  );
  return Object.freeze({
    words: Object.freeze(playableWords),
    wordTileIndices: Object.freeze(wordTileIndices),
  });
}

function boundsForTiles(tileIndices, size) {
  if (!tileIndices.length) return null;
  let minRow = size, maxRow = -1, minColumn = size, maxColumn = -1;
  for (const index of tileIndices) {
    const row = Math.floor(index / size), column = index % size;
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
    minColumn = Math.min(minColumn, column);
    maxColumn = Math.max(maxColumn, column);
  }
  return { minRow, maxRow, minColumn, maxColumn };
}

function connectedUnusedRegions(unused, size) {
  const remaining = new Set(unused), regions = [];
  while (remaining.size) {
    const start = Math.min(...remaining);
    const region = [], queue = [start];
    remaining.delete(start);
    while (queue.length) {
      const index = queue.shift();
      region.push(index);
      for (const next of neighbors(index, size))
        if (remaining.delete(next)) queue.push(next);
    }
    regions.push(sortNumbers(region));
  }
  return regions;
}

function largestRegion(regions, size) {
  if (!regions.length) return { size: 0, tileIndices: [], bounds: null };
  const region = regions.reduce((largest, candidate) =>
    candidate.length > largest.length ? candidate : largest,
  );
  return {
    size: region.length,
    tileIndices: region,
    bounds: boundsForTiles(region, size),
  };
}

function coverageForWords(words, solution, size) {
  const tiles = new Set();
  for (const word of solution.words)
    if (words(word))
      for (const index of solution.wordTileIndices[word]) tiles.add(index);
  const tileIndices = sortNumbers(tiles);
  return {
    tileCount: tileIndices.length,
    tileIndices,
    bounds: boundsForTiles(tileIndices, size),
  };
}

function createQualityReport({ board, size, minimum = 3, lexicon, solution }) {
  const cells = validateInputs(board, size, minimum);
  const solved = solution || solveBoard({ board: cells, size, minimum, lexicon });
  const tileParticipation = Array(cells.length).fill(0);
  for (const word of solved.words)
    for (const index of solved.wordTileIndices[word]) tileParticipation[index]++;

  const lengthBuckets = Object.fromEntries(
    LENGTH_BUCKETS.map(([name, matches]) => [
      name,
      solved.words.filter((word) => matches(word.length)).length,
    ]),
  );
  const longestPlayableWord = solved.words.reduce((longest, word) => {
    if (!longest || word.length > longest.length) return word;
    return word < longest ? word : longest;
  }, null);
  const unusedTileIndices = tileParticipation
    .map((count, index) => (count ? null : index))
    .filter((index) => index !== null);
  const regions = connectedUnusedRegions(unusedTileIndices, size);

  return {
    totalPlayableWords: solved.words.length,
    lengthBuckets,
    longestPlayableWord,
    longestPlayableLength: longestPlayableWord?.length || 0,
    tileParticipation,
    unusedTileCount: unusedTileIndices.length,
    unusedTilePercentage: (unusedTileIndices.length * 100) / cells.length,
    largestConnectedUnusedRegion: largestRegion(regions, size),
    spatialCoverage: {
      all: coverageForWords(() => true, solved, size),
      medium: coverageForWords(
        (word) => word.length >= 5 && word.length <= 6,
        solved,
        size,
      ),
      long: coverageForWords((word) => word.length >= 7, solved, size),
    },
  };
}

module.exports = { solveBoard, createQualityReport };
