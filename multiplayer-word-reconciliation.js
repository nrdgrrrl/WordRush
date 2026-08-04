(function exposeWordrushMultiplayerWordReconciliation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushMultiplayerWordReconciliation = api;
})(globalThis, () => {
  const MAX_RECORDED_ROUNDS = 50;

  function normalizeWord(word) {
    return typeof word === "string" ? word.trim().toUpperCase() : "";
  }

  function normalizeWords(words) {
    const seen = new Set();
    return (Array.isArray(words) ? words : []).reduce((normalized, item) => {
      const word = normalizeWord(typeof item === "string" ? item : item?.word);
      if (!word || seen.has(word)) return normalized;
      seen.add(word);
      normalized.push(word);
      return normalized;
    }, []);
  }

  function normalizeRoundRecords(records) {
    const seen = new Set();
    return (Array.isArray(records) ? records : []).reduce((normalized, record) => {
      const roundId = typeof record?.roundId === "string" ? record.roundId : "";
      if (!roundId || seen.has(roundId)) return normalized;
      seen.add(roundId);
      normalized.push({ roundId, words: normalizeWords(record.words) });
      return normalized;
    }, []).slice(-MAX_RECORDED_ROUNDS);
  }

  function recordLocalAcceptedWord(records, roundId, word) {
    const normalized = normalizeRoundRecords(records);
    const acceptedWord = normalizeWord(word);
    if (typeof roundId !== "string" || !roundId || !acceptedWord)
      return { records: normalized, recorded: false, changed: normalized !== records };
    const current = normalized.find((record) => record.roundId === roundId);
    if (current?.words.includes(acceptedWord))
      return { records: normalized, recorded: false, changed: normalized !== records };
    const next = current
      ? normalized.map((record) => record === current
        ? { ...record, words: [...record.words, acceptedWord] }
        : record)
      : [...normalized, { roundId, words: [acceptedWord] }].slice(-MAX_RECORDED_ROUNDS);
    return { records: next, recorded: true, changed: true };
  }

  function reconcileAcceptedWords(records, roundId, finalWords) {
    const normalized = normalizeRoundRecords(records);
    const acceptedWords = normalizeWords(finalWords);
    if (typeof roundId !== "string" || !roundId)
      return { records: normalized, missingWords: [], changed: normalized !== records };
    const previous = normalized.find((record) => record.roundId === roundId);
    const known = new Set(previous?.words || []);
    const missingWords = acceptedWords.filter((word) => !known.has(word));
    const replacement = { roundId, words: acceptedWords };
    const next = previous
      ? normalized.map((record) => record === previous ? replacement : record)
      : [...normalized, replacement].slice(-MAX_RECORDED_ROUNDS);
    return {
      records: next,
      missingWords,
      changed: JSON.stringify(next) !== JSON.stringify(normalized),
    };
  }

  function wordStatsDelta(words) {
    const acceptedWords = normalizeWords(words);
    return {
      words: acceptedWords.length,
      correct: acceptedWords.length,
      totalWordLength: acceptedWords.reduce((total, word) => total + word.length, 0),
      longest: Math.max(0, ...acceptedWords.map((word) => word.length)),
    };
  }

  return Object.freeze({
    normalizeRoundRecords,
    recordLocalAcceptedWord,
    reconcileAcceptedWords,
    wordStatsDelta,
  });
});
