(function exposeSuddenDeathSeries(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushSuddenDeathSeries = api;
})(globalThis, () => {
  const TOTAL_ROUNDS = 10;
  const MIN_PLAYERS = 2;
  const INTERSTITIAL_MS = 2_000;
  const MAX_SCORE = 1_000_000;
  const MAX_ACCEPTED_WORDS = 500;
  const ROUND_REASONS = Object.freeze([
    "invalid_word",
    "timeout",
    "host_skip",
    "complete",
  ]);

  function identity(player) {
    if (!player || typeof player !== "object") return null;
    const id = String(player.id || "").trim();
    const name = String(player.name || "").trim();
    if (!id || !name) return null;
    return { id, name, avatar: String(player.avatar || "🐈") };
  }

  function participant(series, playerId) {
    return series?.participants?.find((player) => player.id === playerId) || null;
  }

  function activeParticipants(series) {
    return (series?.participants || []).filter((player) => player.status === "active");
  }

  function participantDetails(player) {
    return player?.series && typeof player.series === "object"
      ? player.series
      : player || {};
  }

  function compareParticipants(a, b, options = {}) {
    const aDetails = participantDetails(a);
    const bDetails = participantDetails(b);
    const winnerIds = options.winnerIds instanceof Set
      ? options.winnerIds
      : new Set(options.winnerIds || []);
    const order = options.order instanceof Map ? options.order : null;
    const aActive = aDetails.status !== "withdrawn";
    const bActive = bDetails.status !== "withdrawn";
    const aWinner = aActive && winnerIds.has(a?.id);
    const bWinner = bActive && winnerIds.has(b?.id);
    return (
      Number(!aActive) - Number(!bActive) ||
      Number(!aWinner) - Number(!bWinner) ||
      (Number(aDetails.strikes) || 0) - (Number(bDetails.strikes) || 0) ||
      (Number(b?.score ?? bDetails.aggregateScore) || 0) -
        (Number(a?.score ?? aDetails.aggregateScore) || 0) ||
      (order ? (order.get(a?.id) ?? 0) - (order.get(b?.id) ?? 0) : 0)
    );
  }

  function rankParticipants(players, options = {}) {
    const values = Array.isArray(players) ? [...players] : [];
    const order = options.order instanceof Map
      ? options.order
      : new Map(values.map((player, index) => [player?.id, index]));
    return values.sort((a, b) => compareParticipants(a, b, { ...options, order }));
  }

  function createSuddenDeathSeries(players, { id, accountingId } = {}) {
    const identities = (Array.isArray(players) ? players : [])
      .map(identity)
      .filter((player, index, all) =>
        player && all.findIndex((candidate) => candidate?.id === player.id) === index,
      );
    return {
      id: String(id || "").trim(),
      phase: "playing",
      currentRoundNumber: 1,
      totalRounds: TOTAL_ROUNDS,
      participants: identities.map((player) => ({
        ...player,
        status: "active",
        strikes: 0,
        aggregateScore: 0,
        acceptedWords: [],
        acceptedWordCount: 0,
        gameplaySeconds: 0,
      })),
      history: [],
      transitionId: null,
      nextRoundAt: null,
      winnerIds: [],
      accountingId: String(accountingId || "").trim(),
      resultId: String(accountingId || "").trim(),
      accountingRecorded: false,
      cancelledReason: null,
    };
  }

  function recordAcceptedWord(series, playerId, word, points) {
    const player = participant(series, playerId);
    if (!player || player.status !== "active") return false;
    const normalizedWord = String(word || "").trim().toUpperCase();
    const normalizedPoints = Math.max(0, Number(points) || 0);
    if (!normalizedWord || player.acceptedWordCount >= MAX_ACCEPTED_WORDS)
      return false;
    player.acceptedWords.push({ word: normalizedWord, points: normalizedPoints });
    player.acceptedWordCount += 1;
    player.aggregateScore = Math.min(MAX_SCORE, player.aggregateScore + normalizedPoints);
    return true;
  }

  function addGameplaySeconds(series, playerIds, seconds) {
    const normalizedSeconds = Math.max(0, Number(seconds) || 0);
    for (const playerId of playerIds || []) {
      const player = participant(series, playerId);
      if (player?.status === "active")
        player.gameplaySeconds = Math.min(
          TOTAL_ROUNDS * 30,
          player.gameplaySeconds + normalizedSeconds,
        );
    }
  }

  function withdrawParticipant(series, playerId) {
    const player = participant(series, playerId);
    if (!player || player.status === "withdrawn") return false;
    player.status = "withdrawn";
    return true;
  }

  function recordRound(
    series,
    {
      roundNumber,
      roundId,
      reason,
      loserId = null,
      rejectedWord = "",
      gameplaySeconds = 0,
      participantIds = [],
      transitionId,
      nextRoundAt = null,
    } = {},
  ) {
    if (!series || series.phase !== "playing") return false;
    if (
      roundNumber !== series.currentRoundNumber ||
      !roundId ||
      series.history.some((round) => round.roundId === roundId) ||
      !ROUND_REASONS.includes(reason)
    )
      return false;
    const loser = loserId ? participant(series, loserId) : null;
    const strikeAwarded = reason === "invalid_word" && loser?.status === "active";
    if (strikeAwarded) loser.strikes += 1;
    addGameplaySeconds(series, participantIds, gameplaySeconds);
    series.history.push({
      roundNumber,
      roundId,
      reason,
      loserId: loser?.id || null,
      loserName: loser?.name || null,
      rejectedWord: strikeAwarded ? String(rejectedWord || "").trim().toUpperCase() : "",
      strikeAwarded,
      strikes: Object.fromEntries(
        series.participants.map((player) => [player.id, player.strikes]),
      ),
    });
    if (roundNumber >= series.totalRounds) {
      series.phase = "finished";
      series.transitionId = null;
      series.nextRoundAt = null;
      return true;
    }
    series.phase = "interstitial";
    series.transitionId = String(transitionId || "").trim() || null;
    series.nextRoundAt = nextRoundAt;
    return true;
  }

  function finalizeSeries(series) {
    if (!series || series.phase !== "finished") return false;
    const active = activeParticipants(series);
    const lowest = active.length
      ? Math.min(...active.map((player) => player.strikes))
      : null;
    series.winnerIds = lowest === null
      ? []
      : active.filter((player) => player.strikes === lowest).map((player) => player.id);
    return true;
  }

  function cancelSeries(series, reason) {
    if (!series || !["playing", "interstitial"].includes(series.phase)) return false;
    series.cancelledReason = String(reason || "cancelled");
    return true;
  }

  function publicSeries(series) {
    if (!series) return null;
    return {
      id: series.id,
      phase: series.phase,
      currentRoundNumber: series.currentRoundNumber,
      totalRounds: series.totalRounds,
      participants: series.participants.map((player) => ({
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        status: player.status,
        strikes: player.strikes,
        aggregateScore: player.aggregateScore,
        acceptedWords: player.acceptedWords.map((word) => ({ ...word })),
        acceptedWordCount: player.acceptedWordCount,
        gameplaySeconds: player.gameplaySeconds,
      })),
      history: series.history.map((round) => ({ ...round, strikes: { ...round.strikes } })),
      transitionId: series.transitionId,
      nextRoundAt: series.nextRoundAt,
      winnerIds: [...series.winnerIds],
      accountingId: series.accountingId,
      resultId: series.resultId,
      accountingRecorded: series.accountingRecorded,
      cancelledReason: series.cancelledReason,
    };
  }

  return Object.freeze({
    TOTAL_ROUNDS,
    MIN_PLAYERS,
    INTERSTITIAL_MS,
    MAX_SCORE,
    MAX_ACCEPTED_WORDS,
    ROUND_REASONS,
    activeParticipants,
    addGameplaySeconds,
    cancelSeries,
    compareParticipants,
    createSuddenDeathSeries,
    finalizeSeries,
    participant,
    publicSeries,
    rankParticipants,
    recordAcceptedWord,
    recordRound,
    withdrawParticipant,
  });
});
