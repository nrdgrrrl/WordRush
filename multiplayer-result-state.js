(function exposeWordrushResultState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushMultiplayerResultState = api;
})(globalThis, () => {
  function normalizeNextRound(nextRound, sourceRoundId, configForPreset) {
    if (
      !nextRound ||
      typeof nextRound !== "object" ||
      typeof sourceRoundId !== "string" ||
      !sourceRoundId ||
      nextRound.sourceRoundId !== sourceRoundId ||
      typeof nextRound.mode !== "string" ||
      !configForPreset(nextRound.mode) ||
      !Number.isFinite(nextRound.automaticAt)
    )
      return null;
    return {
      sourceRoundId,
      mode: nextRound.mode,
      automaticAt: nextRound.automaticAt,
    };
  }

  function normalizeResultAction({
    sourceRoundId,
    currentRoundId = null,
    nextRound = null,
    isCreator = false,
    configForPreset,
  }) {
    const matchesCurrentRound =
      !currentRoundId || sourceRoundId === currentRoundId;
    const normalized = matchesCurrentRound
      ? normalizeNextRound(nextRound, sourceRoundId, configForPreset)
      : null;
    if (!normalized) {
      return {
        nextRound: null,
        heading: "",
        label: isCreator ? "Play again →" : "Waiting for host…",
        disabled: !isCreator,
      };
    }
    const label = configForPreset(normalized.mode).label;
    return {
      nextRound: normalized,
      heading: "Up next: " + label,
      label: isCreator
        ? "Start " + label + " now →"
        : "Waiting for host to start " + label,
      disabled: !isCreator,
    };
  }

  return Object.freeze({ normalizeNextRound, normalizeResultAction });
});
