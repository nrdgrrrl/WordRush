(function exposeWordrushCooperativeResults(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushCooperativeResults = api;
})(globalThis, () => {
  function finiteScore(value) {
    const score = Number(value);
    return Number.isFinite(score) ? score : 0;
  }

  function contribution(words) {
    return (Array.isArray(words) ? words : []).reduce(
      (total, item) => total + finiteScore(item?.points),
      0,
    );
  }

  function normalizeResultPresentation({ result, ranking } = {}) {
    const cooperative = result?.cooperative === true;
    const players = (Array.isArray(ranking) ? ranking : []).map((player) => ({
      ...player,
      contribution: contribution(player?.words),
    }));
    return {
      cooperative,
      teamScore: cooperative ? finiteScore(result?.teamScore) : null,
      players,
    };
  }

  return { contribution, normalizeResultPresentation };
});
