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

  function sameNextRound(first, second) {
    return Boolean(
      first &&
      second &&
      first.sourceRoundId === second.sourceRoundId &&
      first.mode === second.mode &&
      first.automaticAt === second.automaticAt,
    );
  }

  function classifyResultDelivery({
    localRoundId = null,
    resultRoundId = null,
    completed = false,
    authoritativeSnapshot = false,
    activeSoloRound = false,
  }) {
    if (authoritativeSnapshot) {
      if (!resultRoundId) return "stale";
      if (completed && localRoundId === resultRoundId) return "refresh";
      if (localRoundId && localRoundId !== resultRoundId) return "replace";
      return "accept";
    }
    if (resultRoundId && localRoundId && resultRoundId !== localRoundId)
      return "stale";
    if (completed && resultRoundId && localRoundId === resultRoundId)
      return "refresh";
    if (activeSoloRound) return "stale";
    return "accept";
  }

  function reconcileResultAction({ previousAction = null, ...options }) {
    const action = normalizeResultAction(options);
    if (!action.nextRound) return action;
    return {
      ...action,
      consumed:
        sameNextRound(previousAction?.nextRound, action.nextRound) &&
        previousAction?.consumed === true,
    };
  }

  return Object.freeze({
    normalizeNextRound,
    normalizeResultAction,
    reconcileResultAction,
    classifyResultDelivery,
  });
});
