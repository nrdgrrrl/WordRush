#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEFAULT_FILE, EMPTY_TRUSTED_DATA, validTrustedData } = require("../leaderboard");

const target = process.env.WORDRUSH_LEADERBOARD_FILE || DEFAULT_FILE;
const repo = path.resolve(__dirname, "..");
const resolved = path.resolve(target);

function fail(message) {
  console.error(`Reset refused: ${message}`);
  process.exitCode = 2;
}
function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function report(file) {
  const finalStat = fs.statSync(file);
  try {
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    fail(`resulting file is not readable and writable by the executing account: ${error.message}`);
    return;
  }
  console.log(`Final file: ${file}`);
  console.log(`UID: ${finalStat.uid}; GID: ${finalStat.gid}; mode: ${(finalStat.mode & 0o7777).toString(8).padStart(4, "0")}; checksum: ${checksum(file)}; size: ${finalStat.size} bytes`);
}
function isEmptyTrusted(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return validTrustedData(data) && Object.keys(data.players).length === 0;
  } catch {
    return false;
  }
}
function symlinkedParent(file) {
  const root = path.parse(file).root;
  const relativeParent = path.relative(root, path.dirname(file));
  let current = root;
  for (const component of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return current;
  }
  return null;
}

if (!process.argv.includes("--confirm-reset")) fail("pass --confirm-reset to authorize destructive reset");
else if (!target || resolved === path.parse(resolved).root) fail("empty or root paths are not allowed");
else if (resolved === repo || resolved.startsWith(repo + path.sep)) fail("repository paths are not allowed");
else if (path.basename(resolved) !== "leaderboard.json") fail("unexpected target; filename must be leaderboard.json");
else {
  let stat = null;
  try {
    const parent = symlinkedParent(resolved);
    if (parent) { fail(`symlinked parent paths are not allowed: ${parent}`); process.exit(2); }
    stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) { fail("symlink targets are not allowed"); process.exit(2); }
    if (stat.isDirectory()) { fail("directory targets are not allowed"); process.exit(2); }
  } catch (error) {
    if (error.code !== "ENOENT") { fail(`cannot inspect target: ${error.message}`); process.exit(2); }
  }
  if (stat && isEmptyTrusted(resolved)) {
    console.log(`Leaderboard already empty and trusted: ${resolved}`);
    report(resolved);
  } else {
    let backup = null;
    if (stat) {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      backup = `${resolved}.backup-${stamp}`;
      fs.copyFileSync(resolved, backup, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(backup, stat.mode & 0o7777); } catch {}
      try { if (typeof stat.uid === "number" && typeof stat.gid === "number") fs.chownSync(backup, stat.uid, stat.gid); } catch {}
    }
    const temporary = `${resolved}.reset-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(EMPTY_TRUSTED_DATA, null, 2) + "\n", { mode: stat ? stat.mode & 0o7777 : 0o600 });
    if (stat) {
      try { fs.chmodSync(temporary, stat.mode & 0o7777); } catch {}
      try { if (typeof stat.uid === "number" && typeof stat.gid === "number") fs.chownSync(temporary, stat.uid, stat.gid); } catch {}
    }
    fs.renameSync(temporary, resolved);
    console.log(`Reset installed: ${resolved}`);
    if (backup) console.log(`Backup: ${backup}`);
    report(resolved);
  }
}
