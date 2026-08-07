(function exposeWordrushProfileMigration(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushProfileMigration = api;
})(globalThis, () => {
  const OUTCOME_SEMANTICS_VERSION = 1;
  const PROFILE_OUTBOX_VERSION = 1;

  function withOutcomeSemanticsVersion(profile) {
    const source =
      profile && typeof profile === "object" && !Array.isArray(profile)
        ? profile
        : {};
    const parsed = Number(source.outcomeSemanticsVersion);
    const version = Number.isInteger(parsed) && parsed >= 1
      ? parsed
      : OUTCOME_SEMANTICS_VERSION;
    return { ...source, outcomeSemanticsVersion: version };
  }

  function validOutboxEvent(event) {
    return Boolean(
      event && typeof event === "object" && !Array.isArray(event) &&
      typeof event.accountId === "string" && event.accountId.length > 0 &&
      typeof event.eventId === "string" && event.eventId.length > 0 &&
      event.delta && typeof event.delta === "object" && !Array.isArray(event.delta) &&
      event.snapshot && typeof event.snapshot === "object" && !Array.isArray(event.snapshot),
    );
  }

  function readProfileOutbox(storage, key, accountId) {
    if (!storage || typeof storage.getItem !== "function" || !accountId) return [];
    try {
      const parsed = JSON.parse(storage.getItem(key) || "null");
      if (parsed?.version !== PROFILE_OUTBOX_VERSION || !Array.isArray(parsed.events)) return [];
      return parsed.events
        .filter((event) => validOutboxEvent(event) && event.accountId === accountId)
        .map((event) => ({
          accountId: event.accountId,
          eventId: event.eventId,
          delta: event.delta,
          snapshot: event.snapshot,
        }));
    } catch {
      return [];
    }
  }

  function writeProfileOutbox(storage, key, accountId, events) {
    if (!storage || typeof storage.setItem !== "function" || !accountId) return;
    let otherEvents = [];
    try {
      const parsed = JSON.parse(storage.getItem(key) || "null");
      if (parsed?.version === PROFILE_OUTBOX_VERSION && Array.isArray(parsed.events))
        otherEvents = parsed.events.filter(
          (event) => validOutboxEvent(event) && event.accountId !== accountId,
        );
    } catch {}
    const nextEvents = otherEvents.concat(
      (Array.isArray(events) ? events : []).filter(
        (event) => validOutboxEvent(event) && event.accountId === accountId,
      ),
    );
    if (nextEvents.length)
      storage.setItem(key, JSON.stringify({ version: PROFILE_OUTBOX_VERSION, events: nextEvents }));
    else if (typeof storage.removeItem === "function") storage.removeItem(key);
  }

  return Object.freeze({
    OUTCOME_SEMANTICS_VERSION,
    PROFILE_OUTBOX_VERSION,
    withOutcomeSemanticsVersion,
    readProfileOutbox,
    writeProfileOutbox,
  });
});
