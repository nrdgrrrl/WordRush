const fs = require("node:fs");
const path = require("node:path");
const { canonicalJson, sha256 } = require("./dictionary-compiler");

const DEFAULT_DICTIONARY_ID = "wordrush-ca-standard-v1";
const ROOT = __dirname;
const REGISTRY = Object.freeze({
  [DEFAULT_DICTIONARY_ID]: Object.freeze({
    configPath: path.join(ROOT, "dictionaries/config/wordrush-ca-standard-v1.json"),
    artifactPath: path.join(ROOT, "dictionaries/artifacts/wordrush-ca-standard-v1.words.json"),
    manifestPath: path.join(ROOT, "dictionaries/artifacts/wordrush-ca-standard-v1.manifest.json"),
  }),
});
const cache = new Map();

function entryFor(dictionaryId) {
  const entry = REGISTRY[dictionaryId];
  if (!entry) throw new Error(`UNKNOWN_DICTIONARY_ID:${dictionaryId || ""}`);
  return entry;
}

function loadEntry(dictionaryId) {
  if (cache.has(dictionaryId)) return cache.get(dictionaryId);
  const entry = entryFor(dictionaryId);
  let config, manifest, artifactBytes, includeText, excludeText;
  try {
    config = JSON.parse(fs.readFileSync(entry.configPath, "utf8"));
    manifest = JSON.parse(fs.readFileSync(entry.manifestPath, "utf8"));
    artifactBytes = fs.readFileSync(entry.artifactPath);
    includeText = fs.readFileSync(path.join(ROOT, config.overrides.include), "utf8");
    excludeText = fs.readFileSync(path.join(ROOT, config.overrides.exclude), "utf8");
  } catch (error) {
    throw new Error(`DICTIONARY_ARTIFACT_INVALID:${dictionaryId}:${error.message}`);
  }
  const words = validateArtifact({
    dictionaryId,
    config,
    manifest,
    artifactBytes,
    includeText,
    excludeText,
  });
  const loaded = Object.freeze({
    id: dictionaryId,
    label: manifest.label,
    words: Object.freeze(words),
    metadata: Object.freeze({
      dictionaryId,
      label: manifest.label,
      sourceRelease: manifest.source.release,
      sourceSha256: manifest.source.sha256,
      configurationSha256: manifest.configurationSha256,
      artifactSha256: manifest.artifactSha256,
      wordCount: manifest.wordCount,
    }),
  });
  cache.set(dictionaryId, loaded);
  return loaded;
}

function validateArtifact({ dictionaryId, config, manifest, artifactBytes, includeText, excludeText }) {
  if (!manifest || typeof manifest !== "object")
    throw new Error(`DICTIONARY_ARTIFACT_INVALID:${dictionaryId}:manifest`);
  if (sha256(artifactBytes) !== manifest.artifactSha256)
    throw new Error(`DICTIONARY_ARTIFACT_INVALID:${dictionaryId}:checksum`);
  let words;
  try {
    words = JSON.parse(artifactBytes);
  } catch (error) {
    throw new Error(`DICTIONARY_ARTIFACT_INVALID:${dictionaryId}:${error.message}`);
  }
  if (
    config.id !== dictionaryId ||
    manifest.dictionaryId !== dictionaryId ||
    manifest.label !== config.label ||
    manifest.artifact !== `${dictionaryId}.words.json` ||
    manifest.source?.release !== config.source?.release ||
    manifest.source?.url !== config.source?.url ||
    manifest.source?.sha256 !== config.source?.sha256 ||
    manifest.configurationSha256 !== sha256(canonicalJson({
      config,
      overrides: { include: includeText, exclude: excludeText },
    })) ||
    !Array.isArray(words) ||
    manifest.wordCount !== words.length ||
    words.some((word, index) =>
      !/^[A-Z]{3,12}$/.test(word) ||
      (index > 0 && words[index - 1] >= word),
    )
  )
    throw new Error(`DICTIONARY_ARTIFACT_INVALID:${dictionaryId}:manifest`);
  return words;
}

function getDictionary(dictionaryId = DEFAULT_DICTIONARY_ID) {
  return loadEntry(dictionaryId);
}

function getDictionaryMetadata(dictionaryId = DEFAULT_DICTIONARY_ID) {
  return getDictionary(dictionaryId).metadata;
}

module.exports = {
  DEFAULT_DICTIONARY_ID,
  getDictionary,
  getDictionaryMetadata,
  validateArtifact,
};
