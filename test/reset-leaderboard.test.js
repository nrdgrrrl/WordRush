const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EMPTY_TRUSTED_DATA, Leaderboard } = require("../leaderboard");
const script = path.join(__dirname, "..", "scripts", "reset-leaderboard.js");
function run(file, args = ["--confirm-reset"]) {
  return spawnSync(process.execPath, [script, ...args], { env: { ...process.env, WORDRUSH_LEADERBOARD_FILE: file }, encoding: "utf8" });
}
test("reset leaderboard refuses missing confirmation without touching data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-reset-"));
  const file = path.join(dir, "leaderboard.json");
  fs.writeFileSync(file, "legacy");
  const result = run(file, []);
  assert.equal(result.status, 2);
  assert.equal(fs.readFileSync(file, "utf8"), "legacy");
});
test("reset leaderboard backs up populated data and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-reset-"));
  const file = path.join(dir, "leaderboard.json");
  fs.writeFileSync(file, JSON.stringify({ players: { old: {} } }));
  const first = run(file);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), EMPTY_TRUSTED_DATA);
  const backups = fs.readdirSync(dir).filter((name) => name.includes(".backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), JSON.stringify({ players: { old: {} } }));
  const second = run(file);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes(".backup-")).length, 1);
});
test("reset leaderboard handles missing files and rejects unsafe targets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-reset-"));
  const missing = path.join(dir, "leaderboard.json");
  assert.equal(run(missing).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(missing, "utf8")), EMPTY_TRUSTED_DATA);
  for (const unsafe of [dir, path.join(dir, "other.json"), path.parse(dir).root])
    assert.equal(run(unsafe).status, 2);
  const link = path.join(dir, "leaderboard.json");
  fs.unlinkSync(missing);
  fs.symlinkSync(missing, link);
  assert.equal(run(link).status, 2);
});
test("resetting a missing file uses the executing account and creates a usable trusted file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-reset-"));
  const file = path.join(dir, "leaderboard.json");
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.uid, typeof process.getuid === "function" ? process.getuid() : stat.uid);
  assert.equal(stat.gid, typeof process.getgid === "function" ? process.getgid() : stat.gid);
  fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
  assert.match(result.stdout, new RegExp(`UID: ${stat.uid}; GID: ${stat.gid}; mode: 0600; checksum: [a-f0-9]{64}; size: ${stat.size} bytes`));

  const board = new Leaderboard(file);
  board.recordScore({ id: "reset-player", score: 42, multiplayer: true, multiplayerWin: true });
  const reloaded = new Leaderboard(file);
  assert.equal(reloaded.profile("reset-player").totalScore, 42);
});
test("production reset documentation runs Node as wordrush", () => {
  const deployment = fs.readFileSync(path.join(__dirname, "..", "DEPLOYMENT.md"), "utf8");
  assert.match(deployment, /sudo -u wordrush env/);
  assert.match(deployment, /WORDRUSH_LEADERBOARD_FILE=\/var\/lib\/wordrush\/leaderboard\.json/);
  assert.match(deployment, /reset-leaderboard\.js/);
  assert.match(deployment, /--confirm-reset/);
  assert.doesNotMatch(deployment, /sudo env WORDRUSH_LEADERBOARD_FILE=\/var\/lib\/wordrush\/leaderboard\.json/);
});
