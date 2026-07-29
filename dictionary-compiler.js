const crypto = require("node:crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return Buffer.from(JSON.stringify(value) + "\n", "utf8");
}

function canonicalizeOverrideText(text) {
  return String(text || "").replace(/\r\n?/g, "\n");
}

function deaccent(value) {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function overrideWords(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

function normalizeWord(value, config) {
  const source = config.wordRules.deaccent ? deaccent(value) : String(value);
  const word = source.trim().toUpperCase();
  const minimum = config.wordRules.minimumLength;
  const maximum = config.wordRules.maximumLength;
  return /^[A-Z]+$/.test(word) && word.length >= minimum && word.length <= maximum
    ? word
    : null;
}

function validateConfig(config) {
  if (!config || typeof config !== "object")
    throw new TypeError("A dictionary configuration is required");
  if (typeof config.id !== "string" || !config.id)
    throw new TypeError("Dictionary id is required");
  if (typeof config.label !== "string" || !config.label)
    throw new TypeError("Dictionary label is required");
  if (!config.source || typeof config.source.name !== "string" || !config.source.name ||
      typeof config.source.release !== "string" || !config.source.release ||
      typeof config.source.url !== "string" || !config.source.url ||
      !/^[a-f0-9]{64}$/.test(config.source.sha256 || ""))
    throw new TypeError("Dictionary source configuration is invalid");
  if (!config.esdb || !Number.isInteger(config.esdb.size) || config.esdb.size <= 0 ||
      !Array.isArray(config.esdb.spellings) || !config.esdb.spellings.length ||
      config.esdb.spellings.some((spelling) => typeof spelling !== "string" || !spelling) ||
      !Number.isInteger(config.esdb.variantLevel) || config.esdb.variantLevel < 0 ||
      !Array.isArray(config.esdb.excludedPos) ||
      config.esdb.excludedPos.some((part) => typeof part !== "string" || !part) ||
      typeof config.esdb.excludedCategories !== "boolean")
    throw new TypeError("ESDB export configuration is invalid");
  const rules = config.wordRules;
  if (!rules || rules.alphabet !== "A-Z" ||
      !Number.isInteger(rules.minimumLength) || rules.minimumLength < 1 ||
      !Number.isInteger(rules.maximumLength) || rules.maximumLength < rules.minimumLength ||
      typeof rules.deaccent !== "boolean")
    throw new TypeError("Dictionary word rules are invalid");
  if (!config.overrides || typeof config.overrides.include !== "string" ||
      !config.overrides.include || typeof config.overrides.exclude !== "string" ||
      !config.overrides.exclude)
    throw new TypeError("Dictionary override configuration is invalid");
  return config;
}

function normalizeExport({ rawExport, config, includeText = "", excludeText = "" }) {
  validateConfig(config);
  const words = new Set();
  for (const value of String(rawExport || "").split(/\r?\n/)) {
    const word = normalizeWord(value, config);
    if (word) words.add(word);
  }
  for (const value of overrideWords(includeText)) {
    const word = normalizeWord(value, config);
    if (word) words.add(word);
  }
  for (const value of overrideWords(excludeText)) {
    const word = normalizeWord(value, config);
    if (word) words.delete(word);
  }
  return [...words].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function createArtifact({ words, config, sourceSha256, includeText = "", excludeText = "" }) {
  validateConfig(config);
  const artifactBytes = canonicalJson(words);
  const configurationBytes = canonicalJson({
    config,
    overrides: {
      include: canonicalizeOverrideText(includeText),
      exclude: canonicalizeOverrideText(excludeText),
    },
  });
  const manifest = {
    dictionaryId: config.id,
    label: config.label,
    source: {
      name: config.source.name,
      release: config.source.release,
      url: config.source.url,
      sha256: sourceSha256,
    },
    configurationSha256: sha256(configurationBytes),
    artifactSha256: sha256(artifactBytes),
    wordCount: words.length,
    artifact: `${config.id}.words.json`,
    licence: "dictionaries/ATTRIBUTION.md",
    rules: config.wordRules,
  };
  return { artifactBytes, configurationBytes, manifest, manifestBytes: canonicalJson(manifest) };
}

module.exports = {
  canonicalJson,
  canonicalizeOverrideText,
  createArtifact,
  normalizeExport,
  sha256,
  validateConfig,
};
