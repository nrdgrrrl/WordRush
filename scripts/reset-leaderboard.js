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
function openTrustedParent(file) {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  if (!noFollow || !directory || process.platform !== "linux")
    throw new Error("secure no-follow directory access is required on Linux");
  const root = path.parse(file).root;
  const components = path.relative(root, path.dirname(file))
    .split(path.sep)
    .filter(Boolean);
  let descriptor = fs.openSync(root, fs.constants.O_RDONLY | directory | noFollow);
  try {
    for (const component of components) {
      const next = fs.openSync(
        `/proc/self/fd/${descriptor}/${component}`,
        fs.constants.O_RDONLY | directory | noFollow,
      );
      fs.closeSync(descriptor);
      descriptor = next;
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

if (!process.argv.includes("--confirm-reset")) fail("pass --confirm-reset to authorize destructive reset");
else if (!target || resolved === path.parse(resolved).root) fail("empty or root paths are not allowed");
else if (resolved === repo || resolved.startsWith(repo + path.sep)) fail("repository paths are not allowed");
else if (path.basename(resolved) !== "leaderboard.json") fail("unexpected target; filename must be leaderboard.json");
else {
  let parentDescriptor = null;
  let stat = null;
  try {
    parentDescriptor = openTrustedParent(resolved);
    const pinnedTarget = `/proc/self/fd/${parentDescriptor}/${path.basename(resolved)}`;
    stat = fs.lstatSync(pinnedTarget);
    if (stat.isSymbolicLink()) { fail("symlink targets are not allowed"); process.exit(2); }
    if (stat.isDirectory()) { fail("directory targets are not allowed"); process.exit(2); }
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (error.code === "ELOOP" || error.code === "ENOTDIR")
        fail("symlinked parent paths are not allowed; non-directory parents are also refused");
      else fail(`cannot inspect target: ${error.message}`);
      process.exit(2);
    }
  }
  const pinnedTarget = parentDescriptor
    ? `/proc/self/fd/${parentDescriptor}/${path.basename(resolved)}`
    : null;
  if (!parentDescriptor || !pinnedTarget) fail("parent directory must already exist");
  else if (stat && isEmptyTrusted(pinnedTarget)) {
    console.log(`Leaderboard already empty and trusted: ${resolved}`);
    report(pinnedTarget);
  } else {
    let backup = null;
    if (stat) {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      backup = `${pinnedTarget}.backup-${stamp}`;
      fs.copyFileSync(pinnedTarget, backup, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(backup, stat.mode & 0o7777); } catch {}
      try { if (typeof stat.uid === "number" && typeof stat.gid === "number") fs.chownSync(backup, stat.uid, stat.gid); } catch {}
    }
    const temporary = `${pinnedTarget}.reset-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(EMPTY_TRUSTED_DATA, null, 2) + "\n", { mode: stat ? stat.mode & 0o7777 : 0o600 });
    if (stat) {
      try { fs.chmodSync(temporary, stat.mode & 0o7777); } catch {}
      try { if (typeof stat.uid === "number" && typeof stat.gid === "number") fs.chownSync(temporary, stat.uid, stat.gid); } catch {}
    }
    fs.renameSync(temporary, pinnedTarget);
    console.log(`Reset installed: ${resolved}`);
    if (backup) console.log(`Backup: ${backup.replace(`/proc/self/fd/${parentDescriptor}/`, "")}`);
    report(pinnedTarget);
  }
  if (parentDescriptor !== null) fs.closeSync(parentDescriptor);
}
