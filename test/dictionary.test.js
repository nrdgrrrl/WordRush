const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createArtifact,
  normalizeExport,
} = require("../dictionary-compiler");
const {
  DEFAULT_DICTIONARY_ID,
  getDictionary,
  getDictionaryMetadata,
  validateArtifact,
} = require("../dictionary-registry");

const fixtureConfig = {
  id: "fixture",
  label: "Fixture",
  source: { name: "esdb", release: "fixture", url: "fixture", sha256: "source" },
  wordRules: { alphabet: "A-Z", minimumLength: 3, maximumLength: 6, deaccent: true },
};

test("dictionary normalization applies final rules and reviewed overrides deterministically", () => {
  const input = "café\nCAT\nCAT\nco-op\nAB\nTOOLONG\nnaïve\n";
  const options = {
    rawExport: input,
    config: fixtureConfig,
    includeText: "résumé\nTOOLONGER\n",
    excludeText: "CAT\n",
  };
  assert.deepEqual(normalizeExport(options), ["CAFE", "NAIVE", "RESUME"]);
  const first = createArtifact({
    words: normalizeExport(options),
    config: fixtureConfig,
    sourceSha256: "source",
    includeText: options.includeText,
    excludeText: options.excludeText,
  });
  const second = createArtifact({
    words: normalizeExport(options),
    config: fixtureConfig,
    sourceSha256: "source",
    includeText: options.includeText,
    excludeText: options.excludeText,
  });
  assert.deepEqual(first.artifactBytes, second.artifactBytes);
  assert.deepEqual(first.manifestBytes, second.manifestBytes);
  assert.equal(first.manifest.wordCount, 3);
  assert.equal(first.manifest.artifactSha256, second.manifest.artifactSha256);
});

test("registry resolves the default artifact and rejects unknown or invalid artifacts", () => {
  const dictionary = getDictionary();
  const metadata = getDictionaryMetadata(DEFAULT_DICTIONARY_ID);
  assert.equal(metadata.dictionaryId, DEFAULT_DICTIONARY_ID);
  assert.equal(metadata.wordCount, dictionary.words.length);
  assert.ok(dictionary.words.includes("CAT"));
  assert.ok(dictionary.words.includes("COLOUR"));
  assert.ok(!dictionary.words.includes("SHIT"));
  assert.throws(
    () => getDictionary("not-registered"),
    /UNKNOWN_DICTIONARY_ID:not-registered/,
  );

  const root = path.join(__dirname, "..", "dictionaries");
  const config = JSON.parse(fs.readFileSync(path.join(root, "config/wordrush-ca-standard-v1.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "artifacts/wordrush-ca-standard-v1.manifest.json"), "utf8"));
  const artifactBytes = fs.readFileSync(path.join(root, "artifacts/wordrush-ca-standard-v1.words.json"));
  assert.throws(
    () => validateArtifact({
      dictionaryId: DEFAULT_DICTIONARY_ID,
      config,
      manifest,
      artifactBytes: Buffer.from(artifactBytes + " "),
      includeText: fs.readFileSync(path.join(root, "overrides/wordrush-ca-standard-v1.include.txt"), "utf8"),
      excludeText: fs.readFileSync(path.join(root, "overrides/wordrush-ca-standard-v1.exclude.txt"), "utf8"),
    }),
    /DICTIONARY_ARTIFACT_INVALID:wordrush-ca-standard-v1:checksum/,
  );
});
