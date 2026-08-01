(function exposeSuddenDeathOutcome(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushSuddenDeathOutcome = api;
})(globalThis, () => {
  function identity(player) {
    if (!player || typeof player !== "object") return null;
    const id = String(player.id || "").trim();
    const name = String(player.name || "").trim();
    if (!id || !name) return null;
    return { id, name, avatar: String(player.avatar || "🐈") };
  }

  function uniqueIdentities(players) {
    const seen = new Set();
    return (Array.isArray(players) ? players : [])
      .map(identity)
      .filter((player) => {
        if (!player || seen.has(player.id)) return false;
        seen.add(player.id);
        return true;
      });
  }

  function createSuddenDeathOutcome({ loser, participants, word } = {}) {
    const loserIdentity = identity(loser);
    if (!loserIdentity) return null;
    const survivors = uniqueIdentities(participants).filter(
      (player) => player.id !== loserIdentity.id,
    );
    const outcome = survivors.length === 0
      ? "no_winner"
      : survivors.length === 1
        ? "sole_winner"
        : "survivors";
    return {
      outcome,
      loser: loserIdentity,
      rejectedWord: String(word || "").trim().toUpperCase(),
      winner: outcome === "sole_winner" ? survivors[0] : null,
      survivors: outcome === "survivors" ? survivors : [],
    };
  }

  function normalizeSuddenDeathOutcome(details) {
    if (!details || typeof details !== "object") return null;
    const loser = identity(details.loser || {
      id: details.playerId,
      name: details.playerName,
      avatar: details.playerAvatar,
    });
    const rejectedWord = String(details.rejectedWord || details.word || "")
      .trim()
      .toUpperCase();
    if (!loser || !rejectedWord) return null;
    const winner = identity(details.winner);
    const survivors = uniqueIdentities(details.survivors).filter(
      (player) => player.id !== loser.id,
    );
    const outcome = details.outcome || (
      winner ? "sole_winner" : survivors.length ? "survivors" : "no_winner"
    );
    if (
      !["sole_winner", "survivors", "no_winner"].includes(outcome) ||
      (outcome === "sole_winner" && !winner) ||
      (outcome !== "sole_winner" && winner) ||
      (outcome === "survivors" && survivors.length < 2) ||
      (outcome !== "survivors" && survivors.length)
    )
      return null;
    return {
      outcome,
      loser,
      rejectedWord,
      winner: outcome === "sole_winner" ? winner : null,
      survivors: outcome === "survivors" ? survivors : [],
    };
  }

  function winnerIds(details) {
    const outcome = normalizeSuddenDeathOutcome(details);
    if (!outcome) return [];
    return outcome.outcome === "sole_winner"
      ? [outcome.winner.id]
      : outcome.survivors.map((player) => player.id);
  }

  function identityLabel(player) {
    return `${player.avatar || "🐈"} ${player.name}`;
  }

  function formatSuddenDeathOutcome(details) {
    const outcome = normalizeSuddenDeathOutcome(details);
    if (!outcome) return "";
    const loser = identityLabel(outcome.loser);
    const word = `“${outcome.rejectedWord}”`;
    if (outcome.outcome === "sole_winner")
      return `${loser} lost on rejected word ${word}. ${identityLabel(outcome.winner)} is the winner.`;
    if (outcome.outcome === "survivors")
      return `${loser} lost on rejected word ${word}. Survivors/winners: ${outcome.survivors.map(identityLabel).join(", ")}.`;
    return `${loser} lost on rejected word ${word}. No winner — they were the only player.`;
  }

  return Object.freeze({
    createSuddenDeathOutcome,
    formatSuddenDeathOutcome,
    normalizeSuddenDeathOutcome,
    winnerIds,
  });
});
