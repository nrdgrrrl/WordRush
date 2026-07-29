const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");
const { createArtifact, normalizeExport, sha256 } = require("../dictionary-compiler");

const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "dictionaries/config/wordrush-ca-standard-v1.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

function download(url, destination) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location)
        return download(new URL(response.headers.location, url).href, destination).then(resolve, reject);
      if (response.statusCode !== 200)
        return reject(new Error(`ESDB_DOWNLOAD_FAILED:${response.statusCode}`));
      const output = fs.createWriteStream(destination);
      response.pipe(output);
      output.on("finish", () => output.close(resolve));
      output.on("error", reject);
    }).on("error", reject);
  });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-esdb-"));
  try {
    const archive = path.join(temporary, "esdb.tar.gz");
    await download(config.source.url, archive);
    const sourceBytes = fs.readFileSync(archive);
    const sourceSha256 = sha256(sourceBytes);
    if (sourceSha256 !== config.source.sha256)
      throw new Error(`ESDB_SOURCE_CHECKSUM_MISMATCH:${sourceSha256}`);
    const sourceRoot = path.join(temporary, "source");
    fs.mkdirSync(sourceRoot);
    run("tar", ["-xzf", archive, "-C", sourceRoot], root);
    const [sourceDirectory] = fs.readdirSync(sourceRoot);
    const esdbRoot = path.join(sourceRoot, sourceDirectory);
    run("make", [], esdbRoot);
    const rawExport = run("./scowl", [
      "--db", "scowl.db", "word-list", String(config.esdb.size),
      config.esdb.spellings.join(","), String(config.esdb.variantLevel),
      "--deaccent",
      `--wo-poses=${config.esdb.excludedPos.join(",")}`,
      "--categories=",
    ], esdbRoot);
    const includeText = fs.readFileSync(path.join(root, config.overrides.include), "utf8");
    const excludeText = fs.readFileSync(path.join(root, config.overrides.exclude), "utf8");
    const words = normalizeExport({ rawExport, config, includeText, excludeText });
    const artifact = createArtifact({ words, config, sourceSha256, includeText, excludeText });
    const outputRoot = path.join(root, "dictionaries/artifacts");
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, `${config.id}.words.json`), artifact.artifactBytes);
    fs.writeFileSync(path.join(outputRoot, `${config.id}.manifest.json`), artifact.manifestBytes);
    process.stdout.write(`Compiled ${words.length} words (${artifact.manifest.artifactSha256})\n`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { normalizeExport };
