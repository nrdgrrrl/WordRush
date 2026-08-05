(function exposeWordrushChallengeRules(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushChallengeRules = api;
})(globalThis, () => {
  const MAX_ECHO_CHECKPOINTS = 120;
  const MAX_ECHO_ELAPSED_MS = 10 * 60 * 1000;
  const MAX_ECHO_SCORE = 1_000_000;
  const MAX_BOUNTIES = 8;

  function frozenArray(values) {
    return Object.freeze([...values]);
  }

  function normalizeIndexes(indexes) {
    const values = indexes instanceof Set
      ? [...indexes]
      : Array.isArray(indexes)
        ? indexes
        : [];
    return frozenArray([...new Set(values.filter((index) =>
      Number.isSafeInteger(index) && index >= 0,
    ))].sort((left, right) => left - right));
  }

  function normalizeEchoCheckpoints(checkpoints) {
    const normalized = [];
    for (const checkpoint of Array.isArray(checkpoints) ? checkpoints : []) {
      const elapsedMs = checkpoint?.elapsedMs;
      const score = checkpoint?.score;
      if (
        !Number.isSafeInteger(elapsedMs) ||
        elapsedMs < 0 ||
        elapsedMs > MAX_ECHO_ELAPSED_MS ||
        !Number.isSafeInteger(score) ||
        score < 0 ||
        score > MAX_ECHO_SCORE
      )
        continue;
      const previous = normalized.at(-1);
      if (previous && (elapsedMs < previous.elapsedMs || score < previous.score))
        continue;
      const next = Object.freeze({ elapsedMs, score });
      if (previous?.elapsedMs === elapsedMs) normalized[normalized.length - 1] = next;
      else if (!previous || previous.score !== score) normalized.push(next);
    }
    if (normalized.length <= MAX_ECHO_CHECKPOINTS) return frozenArray(normalized);
    return frozenArray([
      normalized[0],
      ...normalized.slice(-(MAX_ECHO_CHECKPOINTS - 1)),
    ]);
  }

  function recordEchoCheckpoint(checkpoints, checkpoint) {
    return normalizeEchoCheckpoints([
      ...normalizeEchoCheckpoints(checkpoints),
      checkpoint,
    ]);
  }

  function blockedTraceResult(path, blockedIndexes) {
    const blocked = new Set(normalizeIndexes(blockedIndexes));
    for (const index of Array.isArray(path) ? path : []) {
      if (!Number.isSafeInteger(index) || index < 0)
        return Object.freeze({ valid: false, reason: "trace", index: null });
      if (blocked.has(index))
        return Object.freeze({ valid: false, reason: "frozen", index });
    }
    return Object.freeze({ valid: true, reason: null, index: null });
  }

  function hashSeed(seed) {
    const text = String(seed ?? "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function nextRandom(state) {
    let next = state >>> 0;
    next ^= next << 13;
    next ^= next >>> 17;
    next ^= next << 5;
    return next >>> 0;
  }

  function selectBountyIndexes(candidateIndexes, count, seed) {
    const candidates = [...normalizeIndexes(candidateIndexes)];
    const requested = Number.isSafeInteger(count)
      ? Math.max(0, Math.min(count, MAX_BOUNTIES, candidates.length))
      : 0;
    let random = hashSeed(seed);
    for (let index = candidates.length - 1; index > 0; index--) {
      random = nextRandom(random);
      const selected = random % (index + 1);
      [candidates[index], candidates[selected]] = [candidates[selected], candidates[index]];
    }
    return frozenArray(candidates.slice(0, requested).sort((left, right) => left - right));
  }

  function bountyClaimEffect(state, path) {
    const bountyIndexes = normalizeIndexes(state?.bountyIndexes);
    const claimedIndexes = normalizeIndexes(state?.claimedIndexes)
      .filter((index) => bountyIndexes.includes(index));
    const claimed = new Set(claimedIndexes);
    const bounty = new Set(bountyIndexes);
    const newlyClaimedIndexes = [];
    for (const index of Array.isArray(path) ? path : []) {
      if (!bounty.has(index) || claimed.has(index)) continue;
      claimed.add(index);
      newlyClaimedIndexes.push(index);
    }
    const nextClaimedIndexes = normalizeIndexes(claimed);
    return Object.freeze({
      changed: newlyClaimedIndexes.length > 0,
      newlyClaimedIndexes: frozenArray(newlyClaimedIndexes),
      claimedIndexes: nextClaimedIndexes,
      remainingIndexes: frozenArray(
        bountyIndexes.filter((index) => !nextClaimedIndexes.includes(index)),
      ),
    });
  }

  return Object.freeze({
    MAX_BOUNTIES,
    MAX_ECHO_CHECKPOINTS,
    MAX_ECHO_ELAPSED_MS,
    MAX_ECHO_SCORE,
    blockedTraceResult,
    bountyClaimEffect,
    normalizeEchoCheckpoints,
    normalizeIndexes,
    recordEchoCheckpoint,
    selectBountyIndexes,
  });
});
