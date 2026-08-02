(function exposeWordrushRoundOutcome(root, factory) {
  const suddenDeathOutcome =
    typeof module === "object" && module.exports
      ? require("./sudden-death-outcome")
      : root.WordrushSuddenDeathOutcome;
  const api = factory(suddenDeathOutcome);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushRoundOutcome = api;
})(globalThis, (suddenDeathOutcome) => {
  const OUTCOMES = Object.freeze(["win", "loss", "neutral"]);
  const SOLO_COMPLETION_REASONS = Object.freeze([
    "manual",
    "timeout",
    "target_reached",
    "fatal_rejection",
  ]);

  function hasTarget(config) {
    return Number.isFinite(config?.target) && config.target > 0;
  }

  function classifySoloOutcome(config, completionReason) {
    if (!SOLO_COMPLETION_REASONS.includes(completionReason)) return "neutral";
    if (
      config?.series === true ||
      (config?.sudden === true && hasTarget(config))
    )
      return "neutral";
    if (config?.sudden === true) {
      if (completionReason === "timeout") return "win";
      if (["manual", "fatal_rejection"].includes(completionReason))
        return "loss";
      return "neutral";
    }
    if (hasTarget(config)) {
      if (completionReason === "target_reached") return "win";
      if (["manual", "timeout"].includes(completionReason)) return "loss";
      return "neutral";
    }
    return "neutral";
  }

  function rankingParticipant(ranking, participantId) {
    if (!Array.isArray(ranking) || typeof participantId !== "string")
      return null;
    return ranking.find((player) => player?.id === participantId) || null;
  }

  function finiteScore(player) {
    const score = Number(player?.score);
    return Number.isFinite(score) ? score : null;
  }

  function classifyMultiplayerParticipant({
    participantId,
    ranking,
    cooperative = false,
    suddenDeath = null,
    series = null,
    seriesComplete = false,
    reason = null,
    recorded = true,
  } = {}) {
    if (!recorded) return "neutral";
    const participant = rankingParticipant(ranking, participantId);
    if (!participant) return "neutral";

    if (seriesComplete) {
      if (!series || !Array.isArray(series.winnerIds)) return "neutral";
      const status = participant.series?.status || participant.status;
      if (status !== "active") return "neutral";
      return series.winnerIds.includes(participantId) ? "win" : "loss";
    }

    if (cooperative) return "neutral";

    const hasSuddenDeathPayload =
      reason === "invalid_word" ||
      (suddenDeath !== null && suddenDeath !== undefined);
    if (hasSuddenDeathPayload) {
      const normalized = suddenDeathOutcome?.normalizeSuddenDeathOutcome?.(
        suddenDeath,
      );
      if (!normalized) return "neutral";
      if (suddenDeathOutcome.winnerIds(normalized).includes(participantId))
        return "win";
      return normalized.loser.id === participantId ? "loss" : "neutral";
    }

    const participantScore = finiteScore(participant);
    const scores = (Array.isArray(ranking) ? ranking : [])
      .map(finiteScore)
      .filter((score) => score !== null);
    if (participantScore === null || !scores.length) return "neutral";
    const highestScore = Math.max(...scores);
    return participantScore === highestScore ? "win" : "loss";
  }

  function outcomeAccounting(outcome, { multiplayer = false } = {}) {
    const safeOutcome = OUTCOMES.includes(outcome) ? outcome : "neutral";
    const won = safeOutcome === "win";
    const lost = safeOutcome === "loss";
    return Object.freeze({
      gamesWon: won ? 1 : 0,
      gamesLost: lost ? 1 : 0,
      multiplayerWins: multiplayer && won ? 1 : 0,
      multiplayerLosses: multiplayer && lost ? 1 : 0,
      updatesMaxGridWin: won,
    });
  }

  return Object.freeze({
    OUTCOMES,
    SOLO_COMPLETION_REASONS,
    classifyMultiplayerParticipant,
    classifySoloOutcome,
    outcomeAccounting,
  });
});
