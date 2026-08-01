const { neighbors, normalizeWords } = require("./board-core");

const LENGTH_BUCKETS = Object.freeze([
  ["3-4", (length) => length >= 3 && length <= 4],
  ["5-6", (length) => length >= 5 && length <= 6],
  ["7-8", (length) => length >= 7 && length <= 8],
  ["9+", (length) => length >= 9],
]);
const DEFAULT_ANALYSIS_LIMITS = Object.freeze({
  maxOperations: 5_000_000,
  operationsPerYield: 2_048,
});
const YIELD_MARKER = Symbol("board-analysis-yield");
const preparedAnalysisState = new WeakMap();

function boardCells(board) {
  if (Array.isArray(board)) return board.slice();
  if (typeof board === "string") return [...board];
  throw new TypeError("A board array or string is required");
}

function validateInputs(board, size, minimum) {
  const cells = boardCells(board);
  if (!Number.isInteger(size) || size < 1 || cells.length !== size * size)
    throw new RangeError("Board size must match the board cell count");
  if (!Number.isInteger(minimum) || minimum < 3 || minimum > 12)
    throw new RangeError("Minimum word length must be an integer from 3 through 12");
  if (!cells.every((letter) => typeof letter === "string" && /^[A-Z]$/.test(letter)))
    throw new TypeError("Board cells must be uppercase A-Z letters");
  return cells;
}

function fingerprintWords(words) {
  let first = 2166136261, second = 2246822519;
  const update = (value, code) => Math.imul(value ^ code, 16777619) >>> 0;
  for (const word of words) {
    for (const character of word) {
      const code = character.charCodeAt(0);
      first = update(first, code);
      second = update(second, code + 17);
    }
    first = update(first, 10);
    second = update(second, 27);
  }
  return first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
}

function fingerprintBoard(cells, size) {
  return fingerprintWords([size + ":" + cells.join("")]);
}

function prepareAnalysisIndex(words, options = {}) {
  if (!words || typeof words[Symbol.iterator] !== "function")
    throw new TypeError("An iterable lexicon is required");
  const normalized = options.alreadyNormalizedAndSorted
    ? (Array.isArray(words) ? words : [...words])
    : normalizeWords([...words]);
  if (!normalized.every((word, index) =>
    /^[A-Z]{3,12}$/.test(word) && (index === 0 || normalized[index - 1] < word)
  ))
    throw new TypeError("Analysis lexicon must contain strictly sorted uppercase words");

  const rootRanges = Array.from({ length: 26 }, () => [0, 0]);
  let index = 0;
  for (let letter = 0; letter < 26; letter++) {
    while (index < normalized.length && normalized[index].charCodeAt(0) - 65 < letter)
      index++;
    const start = index;
    while (index < normalized.length && normalized[index].charCodeAt(0) - 65 === letter)
      index++;
    rootRanges[letter] = [start, index];
  }
  const facade = Object.freeze({
    fingerprint: fingerprintWords(normalized),
    normalizedCount: normalized.length,
    maxWordLength: normalized.reduce((maximum, word) => Math.max(maximum, word.length), 0),
  });
  preparedAnalysisState.set(facade, {
    words: normalized,
    rootRanges: Object.freeze(rootRanges.map((range) => Object.freeze(range))),
  });
  return facade;
}

function getAnalysisSource(index) {
  const source = preparedAnalysisState.get(index);
  if (!source) throw new TypeError("A prepared analysis index is required");
  return source;
}

function sortNumbers(numbers) {
  return [...numbers].sort((a, b) => a - b);
}

function normalizedLimits(limits = {}) {
  return {
    maxOperations: Number.isInteger(limits.maxOperations)
      ? limits.maxOperations
      : DEFAULT_ANALYSIS_LIMITS.maxOperations,
    operationsPerYield: Number.isInteger(limits.operationsPerYield)
      ? limits.operationsPerYield
      : DEFAULT_ANALYSIS_LIMITS.operationsPerYield,
  };
}

function validateLimits(limits) {
  if (limits.maxOperations < 1 || limits.operationsPerYield < 1)
    return "ANALYSIS_INVALID_LIMITS";
  return null;
}

class AnalysisLimitError extends Error {
  constructor() {
    super("ANALYSIS_OPERATION_LIMIT");
    this.code = "ANALYSIS_OPERATION_LIMIT";
  }
}

function now() {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

function* recordOperation(context, counter) {
  if (context.operationCount >= context.limits.maxOperations)
    throw new AnalysisLimitError();
  context.operationCount++;
  context[counter]++;
  context.sliceOperations++;
  if (context.sliceOperations >= context.limits.operationsPerYield) {
    context.sliceOperations = 0;
    context.yieldCount++;
    yield YIELD_MARKER;
  }
}

function* lowerBound(context, words, start, end, depth, code) {
  let low = start, high = end;
  while (low < high) {
    yield* recordOperation(context, "rangeComparisonCount");
    const middle = (low + high) >>> 1;
    const character = words[middle].charCodeAt(depth) || 0;
    if (character < code) low = middle + 1;
    else high = middle;
  }
  return low;
}

function* rangeForLetter(context, words, start, end, depth, letter) {
  const code = letter.charCodeAt(0);
  const low = yield* lowerBound(context, words, start, end, depth, code);
  const high = yield* lowerBound(context, words, low, end, depth, code + 1);
  return low < high ? [low, high] : null;
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

function connectedRegions(unused, size) {
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

function familyForWord(word) {
  if (word.length >= 7) return "long";
  if (word.length >= 5) return "medium";
  return "all";
}

function emptyFamilyArrays(size) {
  return {
    all: Array(size).fill(0),
    medium: Array(size).fill(0),
    long: Array(size).fill(0),
  };
}

function familyCoverage(participation, size) {
  const tileIndices = sortNumbers(
    participation.map((count, index) => (count ? index : null))
      .filter((index) => index !== null),
  );
  return {
    tileCount: tileIndices.length,
    tilePercentage: (tileIndices.length * 100) / participation.length,
    tileIndices,
    bounds: boundsForTiles(tileIndices, size),
  };
}

function distributionForFamily(participation, size) {
  const rows = Array.from({ length: size }, (_, index) => ({
    index,
    coveredTileCount: 0,
    coveragePercentage: 0,
    participationTotal: 0,
  }));
  const columns = Array.from({ length: size }, (_, index) => ({
    index,
    coveredTileCount: 0,
    coveragePercentage: 0,
    participationTotal: 0,
  }));
  for (let tile = 0; tile < participation.length; tile++) {
    const row = Math.floor(tile / size), column = tile % size;
    const value = participation[tile];
    rows[row].participationTotal += value;
    columns[column].participationTotal += value;
    if (value) {
      rows[row].coveredTileCount++;
      columns[column].coveredTileCount++;
    }
  }
  for (const band of [...rows, ...columns])
    band.coveragePercentage = (band.coveredTileCount * 100) / size;
  return { rows, columns };
}

function concentrationForFamily(participation) {
  const totalParticipation = participation.reduce((sum, value) => sum + value, 0);
  const ordered = participation
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value || a.index - b.index);
  const topQuarterTileCount = Math.ceil(participation.length / 4);
  const topQuarterParticipation = ordered
    .slice(0, topQuarterTileCount)
    .reduce((sum, item) => sum + item.value, 0);
  let halfParticipationTileCount = 0, accumulated = 0;
  if (totalParticipation) {
    for (const item of ordered) {
      halfParticipationTileCount++;
      accumulated += item.value;
      if (accumulated * 2 >= totalParticipation) break;
    }
  }
  return {
    totalParticipation,
    topQuarterTileCount,
    topQuarterParticipationPercentage: totalParticipation
      ? (topQuarterParticipation * 100) / totalParticipation
      : 0,
    halfParticipationTileCount,
    halfParticipationTilePercentage:
      (halfParticipationTileCount * 100) / participation.length,
  };
}

function buildReportFromSolution({ board, size, minimum, solution }) {
  const tileParticipation = Array(board.length).fill(0);
  const tileParticipationByLength = emptyFamilyArrays(board.length);
  const playableWordStarts = Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [String.fromCharCode(65 + index), 0]),
  );
  const lengthBuckets = Object.fromEntries(
    LENGTH_BUCKETS.map(([name]) => [name, 0]),
  );
  let longestPlayableWord = null;
  for (const word of solution.words) {
    playableWordStarts[word[0]]++;
    const family = familyForWord(word);
    for (const index of solution.wordTileIndices[word]) {
      tileParticipation[index]++;
      tileParticipationByLength.all[index]++;
      if (family !== "all") tileParticipationByLength[family][index]++;
    }
    const bucket = LENGTH_BUCKETS.find(([, matches]) => matches(word.length));
    if (bucket) lengthBuckets[bucket[0]]++;
    if (!longestPlayableWord || word.length > longestPlayableWord.length ||
      (word.length === longestPlayableWord.length && word < longestPlayableWord))
      longestPlayableWord = word;
  }
  const unusedTileIndices = tileParticipation
    .map((count, index) => (count ? null : index))
    .filter((index) => index !== null);
  const lowValueTileIndices = tileParticipationByLength.medium.map((count, index) =>
    tileParticipationByLength.long[index] || count ? null : index,
  ).filter((index) => index !== null);
  const legacySpatialCoverage = {
    all: coverageForWords(() => true, solution, size),
    medium: coverageForWords(
      (word) => word.length >= 5 && word.length <= 6,
      solution,
      size,
    ),
    long: coverageForWords((word) => word.length >= 7, solution, size),
  };
  return {
    totalPlayableWords: solution.words.length,
    playableWordStarts,
    lengthBuckets,
    longestPlayableWord,
    longestPlayableLength: longestPlayableWord?.length || 0,
    tileParticipation,
    tileParticipationByLength,
    unusedTileCount: unusedTileIndices.length,
    unusedTilePercentage: (unusedTileIndices.length * 100) / board.length,
    largestConnectedUnusedRegion: largestRegion(
      connectedRegions(unusedTileIndices, size),
      size,
    ),
    largestLowValueConnectedRegion: largestRegion(
      connectedRegions(lowValueTileIndices, size),
      size,
    ),
    spatialCoverage: legacySpatialCoverage,
    coverage: {
      all: familyCoverage(tileParticipationByLength.all, size),
      medium: familyCoverage(tileParticipationByLength.medium, size),
      long: familyCoverage(tileParticipationByLength.long, size),
    },
    spatialDistribution: {
      all: distributionForFamily(tileParticipationByLength.all, size),
      medium: distributionForFamily(tileParticipationByLength.medium, size),
      long: distributionForFamily(tileParticipationByLength.long, size),
    },
    concentration: {
      medium: concentrationForFamily(tileParticipationByLength.medium),
      long: concentrationForFamily(tileParticipationByLength.long),
    },
    minimum,
  };
}

function coverageFromSet(tiles, size, cellCount) {
  const tileIndices = sortNumbers(tiles);
  return {
    tileCount: tileIndices.length,
    tilePercentage: (tileIndices.length * 100) / cellCount,
    tileIndices,
    bounds: boundsForTiles(tileIndices, size),
  };
}

function* connectedRegionsCooperatively(unused, size, context) {
  const remaining = new Set(unused), regions = [];
  while (remaining.size) {
    const start = Math.min(...remaining);
    const region = [], queue = [start];
    remaining.delete(start);
    while (queue.length) {
      const index = queue.shift();
      yield* recordOperation(context, "aggregationCount");
      region.push(index);
      for (const next of neighbors(index, size))
        if (remaining.delete(next)) queue.push(next);
    }
    regions.push(sortNumbers(region));
  }
  return regions;
}

function* buildReportCooperatively(context, board, size, minimum, solution) {
  const tileParticipation = Array(board.length).fill(0);
  const tileParticipationByLength = emptyFamilyArrays(board.length);
  const playableWordStarts = Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [String.fromCharCode(65 + index), 0]),
  );
  const legacyTiles = {
    all: new Set(),
    medium: new Set(),
    long: new Set(),
  };
  const lengthBuckets = Object.fromEntries(
    LENGTH_BUCKETS.map(([name]) => [name, 0]),
  );
  let longestPlayableWord = null;
  for (const word of solution.words) {
    yield* recordOperation(context, "aggregationCount");
    playableWordStarts[word[0]]++;
    const family = familyForWord(word);
    const wordTiles = solution.wordTileIndices[word];
    for (const index of wordTiles) {
      yield* recordOperation(context, "aggregationCount");
      tileParticipation[index]++;
      tileParticipationByLength.all[index]++;
      legacyTiles.all.add(index);
      if (family !== "all") {
        tileParticipationByLength[family][index]++;
        legacyTiles[family].add(index);
      }
    }
    const bucket = LENGTH_BUCKETS.find(([, matches]) => matches(word.length));
    if (bucket) lengthBuckets[bucket[0]]++;
    if (!longestPlayableWord || word.length > longestPlayableWord.length ||
      (word.length === longestPlayableWord.length && word < longestPlayableWord))
      longestPlayableWord = word;
  }
  const unusedTileIndices = [], lowValueTileIndices = [];
  for (let index = 0; index < board.length; index++) {
    yield* recordOperation(context, "aggregationCount");
    if (!tileParticipation[index]) unusedTileIndices.push(index);
    if (!tileParticipationByLength.medium[index] &&
      !tileParticipationByLength.long[index])
      lowValueTileIndices.push(index);
  }
  const unusedRegions = yield* connectedRegionsCooperatively(
    unusedTileIndices,
    size,
    context,
  );
  const lowValueRegions = yield* connectedRegionsCooperatively(
    lowValueTileIndices,
    size,
    context,
  );
  return {
    totalPlayableWords: solution.words.length,
    playableWordStarts,
    lengthBuckets,
    longestPlayableWord,
    longestPlayableLength: longestPlayableWord?.length || 0,
    tileParticipation,
    tileParticipationByLength,
    unusedTileCount: unusedTileIndices.length,
    unusedTilePercentage: (unusedTileIndices.length * 100) / board.length,
    largestConnectedUnusedRegion: largestRegion(unusedRegions, size),
    largestLowValueConnectedRegion: largestRegion(lowValueRegions, size),
    spatialCoverage: {
      all: {
        tileCount: legacyTiles.all.size,
        tileIndices: sortNumbers(legacyTiles.all),
        bounds: boundsForTiles(sortNumbers(legacyTiles.all), size),
      },
      medium: {
        tileCount: legacyTiles.medium.size,
        tileIndices: sortNumbers(legacyTiles.medium),
        bounds: boundsForTiles(sortNumbers(legacyTiles.medium), size),
      },
      long: {
        tileCount: legacyTiles.long.size,
        tileIndices: sortNumbers(legacyTiles.long),
        bounds: boundsForTiles(sortNumbers(legacyTiles.long), size),
      },
    },
    coverage: {
      all: coverageFromSet(legacyTiles.all, size, board.length),
      medium: coverageFromSet(legacyTiles.medium, size, board.length),
      long: coverageFromSet(legacyTiles.long, size, board.length),
    },
    spatialDistribution: {
      all: distributionForFamily(tileParticipationByLength.all, size),
      medium: distributionForFamily(tileParticipationByLength.medium, size),
      long: distributionForFamily(tileParticipationByLength.long, size),
    },
    concentration: {
      medium: concentrationForFamily(tileParticipationByLength.medium),
      long: concentrationForFamily(tileParticipationByLength.long),
    },
    minimum,
  };
}

function validateSolutionMetadata(solution, cells, size, minimum) {
  const mismatches = [];
  if (solution?.boardKey !== cells.join("")) mismatches.push("board");
  if (solution?.size !== size) mismatches.push("size");
  if (solution?.minimum !== minimum) mismatches.push("minimum");
  if (mismatches.length)
    throw new Error(
      "Solution metadata does not match report inputs: " + mismatches.join(", "),
    );
  return solution;
}

function createQualityReport({ board, size, minimum = 3, lexicon, analysisIndex, solution }) {
  const cells = validateInputs(board, size, minimum);
  const solved = solution
    ? validateSolutionMetadata(solution, cells, size, minimum)
    : solveBoard({ board: cells, size, minimum, lexicon, analysisIndex });
  return buildReportFromSolution({ board: cells, size, minimum, solution: solved });
}

function diagnosticsFor({ cells, size, minimum, index, limits, dictionary, context, startedAt, failureCode }) {
  const metadata = dictionary?.metadata || dictionary;
  return {
    boardFingerprint: fingerprintBoard(cells, size),
    size,
    minimum,
    ...(metadata ? { dictionary: metadata, dictionaryId: metadata.dictionaryId } : {}),
    analysisIndexFingerprint: index?.fingerprint,
    normalizedLexiconCount: index?.normalizedCount,
    limits: { ...limits },
    operationCount: context?.operationCount || 0,
    transitionCount: context?.transitionCount || 0,
    rangeComparisonCount: context?.rangeComparisonCount || 0,
    aggregationCount: context?.aggregationCount || 0,
    yieldCount: context?.yieldCount || 0,
    elapsedMs: Math.max(0, now() - startedAt),
    failureCode: failureCode || null,
  };
}

function makeFailure({ cells, size, minimum, index, limits, dictionary, context, startedAt, code }) {
  return {
    ok: false,
    error: { code },
    diagnostics: diagnosticsFor({
      cells,
      size,
      minimum,
      index,
      limits,
      dictionary,
      context,
      startedAt,
      failureCode: code,
    }),
  };
}

function* materializeSolution(context, words, wordTiles, cells, size, minimum) {
  const wordIndices = [...wordTiles.keys()].sort((a, b) => a - b);
  const playableWords = [], wordTileIndices = {};
  for (const wordIndex of wordIndices) {
    yield* recordOperation(context, "aggregationCount");
    const word = words[wordIndex];
    const tiles = sortNumbers(wordTiles.get(wordIndex));
    for (const unused of tiles) yield* recordOperation(context, "aggregationCount");
    playableWords.push(word);
    wordTileIndices[word] = tiles;
  }
  return Object.freeze({
    boardKey: cells.join(""),
    size,
    minimum,
    words: Object.freeze(playableWords),
    wordTileIndices: Object.freeze(wordTileIndices),
  });
}

function* analysisIterator(options, execution) {
  const startedAt = now();
  let cells, size, minimum, index, limits, dictionary;
  try {
    cells = validateInputs(options.board, options.size, options.minimum ?? 3);
    size = options.size;
    minimum = options.minimum ?? 3;
    limits = normalizedLimits(options.limits);
    dictionary = options.dictionary;
    index = options.analysisIndex || prepareAnalysisIndex(options.lexicon || []);
  } catch (error) {
    return {
      ok: false,
      error: { code: "ANALYSIS_INVALID_INPUT", message: error.message },
      diagnostics: {
        size: options.size,
        minimum: options.minimum ?? 3,
        elapsedMs: 0,
        failureCode: "ANALYSIS_INVALID_INPUT",
      },
    };
  }
  const context = {
    limits,
    operationCount: 0,
    transitionCount: 0,
    rangeComparisonCount: 0,
    aggregationCount: 0,
    sliceOperations: 0,
    yieldCount: 0,
  };
  execution.context = context;
  execution.meta = { cells, size, minimum, index, limits, dictionary, startedAt };
  const invalidLimit = validateLimits(limits);
  const finishFailure = (code) => makeFailure({
    cells,
    size,
    minimum,
    index,
    limits,
    dictionary,
    context,
    startedAt,
    code,
  });
  if (invalidLimit) return finishFailure(invalidLimit);
  if (options.isCancelled?.()) return finishFailure("ANALYSIS_CANCELLED");

  const source = getAnalysisSource(index);
  const wordTiles = new Map();
  const walk = function* (tile, start, end, depth, used, path) {
    const terminalIndex = source.words[start]?.length === depth ? start : -1;
    if (terminalIndex >= 0 && depth >= minimum) {
      let tiles = wordTiles.get(terminalIndex);
      if (!tiles) {
        tiles = new Set();
        wordTiles.set(terminalIndex, tiles);
      }
      for (const pathTile of path) {
        yield* recordOperation(context, "aggregationCount");
        tiles.add(pathTile);
      }
    }
    for (const next of neighbors(tile, size)) {
      if (used.has(next)) continue;
      yield* recordOperation(context, "transitionCount");
      const range = yield* rangeForLetter(
        context,
        source.words,
        start,
        end,
        depth,
        cells[next],
      );
      if (!range) continue;
      used.add(next);
      path.push(next);
      yield* walk(next, range[0], range[1], depth + 1, used, path);
      path.pop();
      used.delete(next);
    }
  };

  try {
    for (let startTile = 0; startTile < cells.length; startTile++) {
      yield* recordOperation(context, "transitionCount");
      const rootRange = source.rootRanges[cells[startTile].charCodeAt(0) - 65];
      if (!rootRange || rootRange[0] === rootRange[1]) continue;
      yield* walk(
        startTile,
        rootRange[0],
        rootRange[1],
        1,
        new Set([startTile]),
        [startTile],
      );
    }
    const solution = yield* materializeSolution(
      context,
      source.words,
      wordTiles,
      cells,
      size,
      minimum,
    );
    const report = yield* buildReportCooperatively(
      context,
      cells,
      size,
      minimum,
      solution,
    );
    return {
      ok: true,
      report,
      ...(options.includeSolution === false ? {} : { solution }),
      diagnostics: diagnosticsFor({
        cells,
        size,
        minimum,
        index,
        limits,
        dictionary,
        context,
        startedAt,
      }),
    };
  } catch (error) {
    if (error instanceof AnalysisLimitError) return finishFailure(error.code);
    throw error;
  }
}

function solveBoard(options) {
  validateInputs(options.board, options.size, options.minimum ?? 3);
  if (!options.analysisIndex &&
    (!options.lexicon || typeof options.lexicon[Symbol.iterator] !== "function"))
    throw new TypeError("An iterable lexicon is required");
  const result = analyzeBoard({ ...options, includeSolution: true });
  if (!result.ok) {
    const error = new Error(result.error.code);
    error.code = result.error.code;
    throw error;
  }
  return result.solution;
}

function analyzeBoard(options = {}) {
  const execution = {};
  const iterator = analysisIterator({
    ...options,
    includeSolution: options.includeSolution !== false,
  }, execution);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

async function analyzeBoardCooperatively(options = {}) {
  const scheduler = options.yieldScheduler ||
    (() => new Promise((resolve) => setImmediate(resolve)));
  const execution = {};
  const iterator = analysisIterator(options, execution);
  let step = iterator.next();
  while (!step.done) {
    if (step.value === YIELD_MARKER) {
      if (options.isCancelled?.()) {
        iterator.return?.();
        return makeFailure({
          ...execution.meta,
          context: execution.context,
          code: "ANALYSIS_CANCELLED",
        });
      }
      await scheduler();
      if (options.isCancelled?.()) {
        iterator.return?.();
        return makeFailure({
          ...execution.meta,
          context: execution.context,
          code: "ANALYSIS_CANCELLED",
        });
      }
    }
    step = iterator.next();
  }
  return step.value;
}

module.exports = {
  DEFAULT_ANALYSIS_LIMITS,
  prepareAnalysisIndex,
  analyzeBoard,
  analyzeBoardCooperatively,
  solveBoard,
  createQualityReport,
};
