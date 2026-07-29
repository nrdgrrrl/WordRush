(function exposeBoardCore(root, factory) {
  const value = factory(
    typeof module === "object" && module.exports
      ? require("./game-config")
      : root.WordrushConfig,
  );
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.WordrushBoardCore = value;
})(globalThis, ({ ADULT_WORDS, LETTER_BAG }) => {
  const DEFAULT_LIMITS = Object.freeze({
    maxAttempts: 32,
    maxPlacementOperations: 250000,
    maxBacktracks: 125000,
    operationsPerYield: 2048,
  });
  const YIELD_MARKER = Symbol("board-generation-yield");
  const preparedState = new WeakMap();
  const DIRTY_TEMPLATE = "NOLKCDCSITHIBITD";
  const DIRTY_TEMPLATE_WORDS = Object.freeze([
    "BITCH",
    "COCK",
    "DICK",
    "SHIT",
    "TIT",
    "SHTICK",
  ]);

  function normalizeWords(words) {
    return [...new Set(
      (words || [])
        .map((word) => String(word).trim().toUpperCase())
        .filter((word) => /^[A-Z]{3,}$/.test(word)),
    )].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  function hashWords(words, seed) {
    let hash = seed >>> 0;
    for (const word of words.join("\n")) {
      hash ^= word.charCodeAt(0);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function fingerprint(words) {
    return hashWords(words, 2166136261) + hashWords(words, 2246822519);
  }

  function neighbors(index, size) {
    const row = Math.floor(index / size), column = index % size, result = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const nextRow = row + dr, nextColumn = column + dc;
      if (
        (dr || dc) &&
        nextRow >= 0 &&
        nextColumn >= 0 &&
        nextRow < size &&
        nextColumn < size
      )
        result.push(nextRow * size + nextColumn);
    }
    return result;
  }

  function createSeededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomIndex(random, length) {
    return Math.floor(random() * length);
  }

  function shuffle(values, random) {
    for (let index = values.length - 1; index > 0; index--) {
      const swap = randomIndex(random, index + 1);
      [values[index], values[swap]] = [values[swap], values[index]];
    }
    return values;
  }

  function buildLengthBuckets(words) {
    const buckets = new Map();
    for (const word of words) {
      if (!buckets.has(word.length)) buckets.set(word.length, []);
      buckets.get(word.length).push(word);
    }
    for (const bucket of buckets.values()) Object.freeze(bucket);
    return buckets;
  }

  function collectLengths(buckets, minimum, maximum) {
    const result = [];
    for (let length = minimum; length <= maximum; length++)
      result.push(...(buckets.get(length) || []));
    return Object.freeze(result);
  }

  function prepareLexicon(words, options = {}) {
    const normalized = normalizeWords(words);
    const adultWords = new Set(normalizeWords(options.adultWords || ADULT_WORDS));
    const preferredWords = new Set(normalizeWords(options.preferredWords || []));
    const normal = normalized.filter((word) => !adultWords.has(word));
    const adult = normalized.filter((word) => adultWords.has(word));
    const source = {
      classic: {
        all: Object.freeze(normal),
        byLength: buildLengthBuckets(normal),
        preferredByLength: buildLengthBuckets(
          normal.filter((word) => preferredWords.has(word)),
        ),
      },
      dirty: {
        all: Object.freeze(normalized),
        allSet: new Set(normalized),
        byLength: buildLengthBuckets(normalized),
        preferredByLength: buildLengthBuckets(
          normalized.filter((word) => preferredWords.has(word)),
        ),
      },
      adult: {
        all: Object.freeze(adult),
        byLength: buildLengthBuckets(adult),
      },
      familyCache: new Map(),
      minimumCache: new Map(),
    };
    const facade = Object.freeze({
      fingerprint: fingerprint(normalized),
      normalizedCount: normalized.length,
      normalCount: normal.length,
      adultCount: adult.length,
      candidateCounts(size, mode = "classic", minimum = 3) {
        const families = [3, 4, 5, 6].map((length, bucket) => [
          bucket === 3 ? "6plus" : String(length),
          getFamilyCandidates(source, size, mode, bucket === 3 ? "6plus" : length).length,
        ]);
        return Object.fromEntries([
          ...families,
          ["minimum", getMinimumCandidates(source, size, mode, minimum).length],
          ["adult", getFamilyCandidates(source, size, "dirty", "adult").length],
        ]);
      },
    });
    preparedState.set(facade, source);
    return facade;
  }

  function getPreparedSource(prepared) {
    const source = preparedState.get(prepared);
    if (!source) throw new TypeError("A prepared lexicon is required");
    return source;
  }

  function getFamilyCandidates(source, size, mode, family) {
    const key = `${mode}:${size}:${family}`;
    if (source.familyCache.has(key)) return source.familyCache.get(key);
    const buckets = family === "adult"
      ? source.adult.byLength
      : source[mode].byLength;
    const maximum = Math.min(12, size * size);
    let candidates;
    if (family === "6plus") candidates = collectLengths(buckets, 6, maximum);
    else if (family === "adult") candidates = collectLengths(buckets, 3, maximum);
    else candidates = Object.freeze([...(buckets.get(family) || [])]);
    source.familyCache.set(key, candidates);
    return candidates;
  }

  function getPreferredFamilyCandidates(source, size, mode, family) {
    const buckets = source[mode].preferredByLength;
    const maximum = Math.min(12, size * size);
    if (family === "6plus") {
      for (let length = 6; length <= maximum; length++)
        if (buckets.has(length)) return buckets.get(length);
      return Object.freeze([]);
    }
    return Object.freeze([...(buckets.get(family) || [])]);
  }

  function getShortestCandidates(source, size, mode, family, limit = Infinity) {
    const buckets = family === "adult"
      ? source.adult.byLength
      : source[mode].byLength;
    const maximum = Math.min(12, size * size);
    const minimum = family === "6plus" ? 6 : family === "adult" ? 3 : family;
    const result = [];
    for (let length = minimum; length <= maximum; length++) {
      const bucket = buckets.get(length) || [];
      result.push(...bucket);
      if (result.length >= limit) break;
      if (family !== "adult" && result.length) break;
    }
    return Object.freeze(result.slice(0, limit));
  }

  function getShortestMinimumCandidates(source, size, mode, minimum) {
    return getShortestCandidates(source, size, mode, minimum, Infinity);
  }

  function getShortestPreferredMinimumCandidates(source, size, mode, minimum) {
    const buckets = source[mode].preferredByLength;
    const maximum = Math.min(12, size * size);
    for (let length = minimum; length <= maximum; length++)
      if (buckets.has(length)) return buckets.get(length);
    return Object.freeze([]);
  }

  function getMinimumCandidates(source, size, mode, minimum) {
    const key = `${mode}:${size}:${minimum}`;
    if (source.minimumCache.has(key)) return source.minimumCache.get(key);
    const candidates = collectLengths(
      source[mode].byLength,
      minimum,
      Math.min(12, size * size),
    );
    source.minimumCache.set(key, candidates);
    return candidates;
  }

  function walkBoardPaths(board, size, initialState, advance, visit) {
    function walk(index, state, used, path) {
      if (visit(path, state)) return true;
      for (const next of neighbors(index, size)) {
        if (used.has(next)) continue;
        const nextState = advance(state, board[next], next, path);
        if (nextState === undefined) continue;
        used.add(next);
        path.push(next);
        if (walk(next, nextState, used, path)) return true;
        path.pop();
        used.delete(next);
      }
      return false;
    }

    for (let start = 0; start < board.length; start++) {
      const state = advance(initialState, board[start], start, []);
      if (state === undefined) continue;
      if (walk(start, state, new Set([start]), [start])) return true;
    }
    return false;
  }

  function hasPath(board, size, word) {
    return walkBoardPaths(
      board,
      size,
      0,
      (depth, letter) => letter === word[depth] ? depth + 1 : undefined,
      (path, depth) => path.length === word.length && depth === word.length,
    );
  }

  class GenerationLimitError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  class GenerationCancelledError extends Error {
    constructor() {
      super("GENERATION_CANCELLED");
      this.code = "GENERATION_CANCELLED";
    }
  }

  function normalizedLimits(limits = {}) {
    return {
      maxAttempts: Number.isInteger(limits.maxAttempts)
        ? limits.maxAttempts
        : DEFAULT_LIMITS.maxAttempts,
      maxPlacementOperations: Number.isInteger(limits.maxPlacementOperations)
        ? limits.maxPlacementOperations
        : DEFAULT_LIMITS.maxPlacementOperations,
      maxBacktracks: Number.isInteger(limits.maxBacktracks)
        ? limits.maxBacktracks
        : DEFAULT_LIMITS.maxBacktracks,
      operationsPerYield: Number.isInteger(limits.operationsPerYield)
        ? limits.operationsPerYield
        : DEFAULT_LIMITS.operationsPerYield,
    };
  }

  function validateInput(size, prepared, options, limits) {
    if (!Number.isInteger(size) || size < 1 || size > 8)
      return "INVALID_SIZE";
    if (!preparedState.has(prepared)) return "LEXICON_NOT_PREPARED";
    if (!Number.isInteger(options.min) || options.min < 3 || options.min > 12)
      return "INVALID_MINIMUM";
    if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
      return "INVALID_SEED";
    if (![
      "classic",
      "dirty",
    ].includes(options.mode)) return "INVALID_MODE";
    if (
      limits.maxAttempts < 1 ||
      limits.maxPlacementOperations < 1 ||
      limits.maxBacktracks < 0 ||
      limits.operationsPerYield < 1
    ) return "INVALID_LIMITS";
    return null;
  }

  function* checkpoint(context) {
    if (context.placementOperationCount >= context.limits.maxPlacementOperations)
      throw new GenerationLimitError("PLACEMENT_LIMIT");
    context.placementOperationCount++;
    context.sliceOperations++;
    if (context.sliceOperations >= context.limits.operationsPerYield) {
      context.sliceOperations = 0;
      context.yieldCount++;
      yield YIELD_MARKER;
    }
  }

  function registerBacktrack(context) {
    if (context.backtrackCount >= context.limits.maxBacktracks)
      throw new GenerationLimitError("BACKTRACK_LIMIT");
    context.backtrackCount++;
  }

  function* findPlacement(word, size, cells, context) {
    const starts = shuffle([...Array(size * size).keys()], context.random);
    for (const start of starts) {
      yield* checkpoint(context);
      if (cells[start] && cells[start] !== word[0]) continue;
      const path = [start], used = new Set(path);
      function* walk() {
        if (path.length === word.length) return true;
        const nextCells = shuffle(
          neighbors(path[path.length - 1], size).filter(
            (index) =>
              !used.has(index) &&
              (!cells[index] || cells[index] === word[path.length]),
          ),
          context.random,
        );
        for (const next of nextCells) {
          yield* checkpoint(context);
          path.push(next);
          used.add(next);
          if (yield* walk()) return true;
          path.pop();
          used.delete(next);
          registerBacktrack(context);
        }
        return false;
      }
      if (yield* walk()) return path;
    }
    return null;
  }

  function addTarget(targets, seen, word) {
    if (!word || seen.has(word)) return;
    seen.add(word);
    if (!targets.has(word.length)) targets.set(word.length, []);
    targets.get(word.length).push(word);
  }

  function dirtyTemplateBoard(size, source, minimum, random) {
    if (size < 4 || minimum > 6) return null;
    if (!DIRTY_TEMPLATE_WORDS.every((word) => source.dirty.allSet.has(word))) return null;
    const board = Array.from(
      { length: size * size },
      () => LETTER_BAG[randomIndex(random, LETTER_BAG.length)],
    );
    for (let row = 0; row < 4; row++)
      for (let column = 0; column < 4; column++)
        board[row * size + column] = DIRTY_TEMPLATE[row * 4 + column];
    const playableAdultCount = getFamilyCandidates(source, size, "dirty", "adult")
      .filter((word) => hasPath(board, size, word)).length;
    const requiredAdultCount = Math.min(
      5,
      getFamilyCandidates(source, size, "dirty", "adult").length,
    );
    if (playableAdultCount < requiredAdultCount) return null;
    if (!getMinimumCandidates(source, size, "dirty", minimum)
      .some((word) => hasPath(board, size, word))) return null;
    for (const family of [3, 4, 5, "6plus"]) {
      const candidates = getFamilyCandidates(source, size, "dirty", family);
      if (candidates.length && !candidates.some((word) => hasPath(board, size, word)))
        return null;
    }
    return board;
  }

  function selectTarget(candidates, preferredCandidates, random) {
    const source = preferredCandidates.length ? preferredCandidates : candidates;
    return source[randomIndex(random, source.length)];
  }

  function buildTargets(source, size, mode, minimum, context) {
    const targets = new Map(), seen = new Set();
    const minimumCandidates = getMinimumCandidates(source, size, mode, minimum);
    if (!minimumCandidates.length) return { targets, seen, failureCode: "NO_MINIMUM_CANDIDATE" };
    if (mode === "dirty") {
      const adultCandidates = getFamilyCandidates(source, size, "dirty", "adult");
      const adultTargets = shuffle(
        [...adultCandidates],
        context.random,
      ).slice(0, Math.min(5, adultCandidates.length));
      adultTargets.forEach((word) => addTarget(targets, seen, word));
    }
    const hasMinimumTarget = [...seen].some((word) => word.length >= minimum);
    if (!hasMinimumTarget)
      addTarget(
        targets,
        seen,
        selectTarget(
          getShortestMinimumCandidates(source, size, mode, minimum),
          getShortestPreferredMinimumCandidates(source, size, mode, minimum),
          context.random,
        ),
      );
    for (const [family, bucket] of [[3, 3], [4, 4], [5, 5], ["6plus", "6plus"]]) {
      const covered = [...seen].some((word) =>
        bucket === "6plus" ? word.length >= 6 : word.length === bucket,
      );
      if (covered) continue;
      const candidates = getFamilyCandidates(source, size, mode, bucket);
      if (!candidates.length) continue;
      addTarget(
        targets,
        seen,
        selectTarget(
          getShortestCandidates(source, size, mode, bucket),
          getPreferredFamilyCandidates(source, size, mode, bucket),
          context.random,
        ),
      );
    }
    return { targets, seen, failureCode: null };
  }

  function* generateIterator(size, prepared, options = {}) {
    const limits = normalizedLimits(options.limits);
    const startedAt = typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
    const baseDiagnostics = {
      seed: options.seed,
      size,
      mode: options.mode,
      minimum: options.min,
      lexiconFingerprint: prepared?.fingerprint,
      normalizedLexiconCount: prepared?.normalizedCount,
      candidateCounts: {},
      limits: { ...limits },
      attemptCount: 0,
      placementOperationCount: 0,
      backtrackCount: 0,
      yieldCount: 0,
    };
    const finish = (result) => ({
      ...result,
      diagnostics: {
        ...baseDiagnostics,
        ...result.diagnostics,
        failureCode: result.ok ? null : result.error?.code || "GENERATION_FAILED",
        elapsedMs: Math.max(
          0,
          (typeof performance !== "undefined" && performance.now
            ? performance.now()
            : Date.now()) - startedAt,
        ),
      },
    });
    const inputError = validateInput(size, prepared, options, limits);
    if (inputError) return finish({ ok: false, error: { code: inputError } });
    const source = getPreparedSource(prepared);
    baseDiagnostics.candidateCounts = prepared.candidateCounts(size, options.mode, options.min);
    const minimumCandidates = getMinimumCandidates(source, size, options.mode, options.min);
    if (!minimumCandidates.length)
      return finish({ ok: false, error: { code: "NO_MINIMUM_CANDIDATE" } });
    const random = options.randomSource
      ? options.randomSource(options.seed)
      : createSeededRandom(options.seed);
    const context = {
      random,
      limits,
      placementOperationCount: 0,
      backtrackCount: 0,
      sliceOperations: 0,
      yieldCount: 0,
    };
    try {
      for (let attempt = 0; attempt < limits.maxAttempts; attempt++) {
        baseDiagnostics.attemptCount++;
        const selected = buildTargets(
          source,
          size,
          options.mode,
          options.min,
          context,
        );
        if (selected.failureCode)
          return finish({ ok: false, error: { code: selected.failureCode } });
        const cells = Array(size * size).fill("");
        let failed = false;
        const lengths = [...selected.targets.keys()].sort((a, b) => b - a);
        for (const length of lengths) {
          const words = shuffle([...selected.targets.get(length)], context.random);
          for (const word of words) {
            const path = yield* findPlacement(word, size, cells, context);
            if (!path) {
              failed = true;
              break;
            }
            path.forEach((index, offset) => { cells[index] = word[offset]; });
          }
          if (failed) break;
        }
        if (failed) continue;
        const board = cells.map(() => LETTER_BAG[randomIndex(context.random, LETTER_BAG.length)]);
        for (let index = 0; index < cells.length; index++)
          if (cells[index]) board[index] = cells[index];
        baseDiagnostics.placementOperationCount = context.placementOperationCount;
        baseDiagnostics.backtrackCount = context.backtrackCount;
        baseDiagnostics.yieldCount = context.yieldCount;
        return finish({ ok: true, board });
      }
    } catch (error) {
      if (!(error instanceof GenerationLimitError)) throw error;
      baseDiagnostics.placementOperationCount = context.placementOperationCount;
      baseDiagnostics.backtrackCount = context.backtrackCount;
      baseDiagnostics.yieldCount = context.yieldCount;
      return finish({ ok: false, error: { code: error.code } });
    }
    const templateBoard = options.mode === "dirty"
      ? dirtyTemplateBoard(size, source, options.min, context.random)
      : null;
    if (templateBoard) {
      baseDiagnostics.placementOperationCount = context.placementOperationCount;
      baseDiagnostics.backtrackCount = context.backtrackCount;
      baseDiagnostics.yieldCount = context.yieldCount;
      return finish({
        ok: true,
        board: templateBoard,
        diagnostics: { generationStrategy: "dirty-template" },
      });
    }
    baseDiagnostics.placementOperationCount = context.placementOperationCount;
    baseDiagnostics.backtrackCount = context.backtrackCount;
    baseDiagnostics.yieldCount = context.yieldCount;
    return finish({ ok: false, error: { code: "ATTEMPTS_EXHAUSTED" } });
  }

  function generateBoard(size, prepared, options = {}) {
    const iterator = generateIterator(size, prepared, options);
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
  }

  async function generateBoardCooperatively(size, prepared, options = {}) {
    const scheduler = options.yieldScheduler || (() => new Promise((resolve) => setTimeout(resolve, 0)));
    const iterator = generateIterator(size, prepared, options);
    let step = iterator.next();
    while (!step.done) {
      if (step.value === YIELD_MARKER) {
        if (options.isCancelled?.()) throw new GenerationCancelledError();
        await scheduler();
        if (options.isCancelled?.()) throw new GenerationCancelledError();
      }
      step = iterator.next();
    }
    return step.value;
  }

  return Object.freeze({
    DEFAULT_LIMITS,
    normalizeWords,
    prepareLexicon,
    createSeededRandom,
    neighbors,
    walkBoardPaths,
    hasPath,
    generateBoard,
    generateBoardCooperatively,
  });
});
