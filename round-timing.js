(function exposeWordrushRoundTiming(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushRoundTiming = api;
})(globalThis, () => {
  function nonNegativeSeconds(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  function startGameplay(startedAt, configuredSeconds) {
    const start = Number(startedAt);
    if (!Number.isFinite(start) || start <= 0)
      return { startedAt: 0, endsAt: 0 };
    return {
      startedAt: start,
      endsAt: start + nonNegativeSeconds(configuredSeconds) * 1000,
    };
  }

  function elapsedGameplaySeconds(startedAt, now, configuredSeconds) {
    const start = Number(startedAt);
    const current = Number(now);
    if (start <= 0 || !Number.isFinite(start) || !Number.isFinite(current))
      return 0;
    return Math.min(
      nonNegativeSeconds(configuredSeconds),
      Math.max(0, (current - start) / 1000),
    );
  }

  function authoritativeGameplaySeconds(value, maximumSeconds = null) {
    const duration = nonNegativeSeconds(value);
    if (maximumSeconds === null || maximumSeconds === undefined)
      return duration;
    const maximum = Number(maximumSeconds);
    return Number.isFinite(maximum) && maximum >= 0
      ? Math.min(duration, maximum)
      : duration;
  }

  return Object.freeze({
    authoritativeGameplaySeconds,
    elapsedGameplaySeconds,
    nonNegativeSeconds,
    startGameplay,
  });
});
