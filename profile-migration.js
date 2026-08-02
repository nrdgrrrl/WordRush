(function exposeWordrushProfileMigration(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushProfileMigration = api;
})(globalThis, () => {
  const OUTCOME_SEMANTICS_VERSION = 1;

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

  return Object.freeze({
    OUTCOME_SEMANTICS_VERSION,
    withOutcomeSemanticsVersion,
  });
});
