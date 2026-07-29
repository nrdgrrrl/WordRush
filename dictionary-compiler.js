const crypto = require("node:crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return Buffer.from(JSON.stringify(value) + "\n", "utf8");
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
  const word = deaccent(value).trim().toUpperCase();
  const minimum = config.wordRules.minimumLength;
  const maximum = config.wordRules.maximumLength;
  return /^[A-Z]+$/.test(word) && word.length >= minimum && word.length <= maximum
    ? word
    : null;
}

function normalizeExport({ rawExport, config, includeText = "", excludeText = "" }) {
  if (!config?.wordRules || !Number.isInteger(config.wordRules.minimumLength))
    throw new TypeError("A valid dictionary configuration is required");
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
  const artifactBytes = canonicalJson(words);
  const configurationBytes = canonicalJson({
    config,
    overrides: { include: includeText, exclude: excludeText },
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

module.exports = { canonicalJson, createArtifact, normalizeExport, sha256 };
