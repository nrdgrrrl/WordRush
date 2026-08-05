const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DAILY_RECORDS = 90;
const MAX_SHARE_RECORDS = 5_000;
const DEFAULT_DIRECTORY =
  process.env.STATE_DIRECTORY ||
  (process.env.NODE_ENV === "production"
    ? "/var/lib/wordrush"
    : path.join(__dirname, "data"));
const DEFAULT_FILE = path.join(DEFAULT_DIRECTORY, "daily-challenges.json");

function utcDateKey(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return null;
  return date.toISOString().slice(0, 10);
}

function validDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return utcDateKey(date) === value;
}

function validConfig(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.label === "string" &&
      value.label.length > 0 &&
      value.label.length <= 32 &&
      typeof value.rule === "string" &&
      value.rule.length > 0 &&
      value.rule.length <= 100 &&
      Number.isInteger(value.min) &&
      value.min >= 3 &&
      value.min <= 12 &&
      Number.isInteger(value.size) &&
      value.size >= 4 &&
      value.size <= 8 &&
      Number.isInteger(value.seconds) &&
      value.seconds >= 15 &&
      value.seconds <= 600 &&
      (value.target === null ||
        (typeof value.target === "number" && Number.isFinite(value.target))) &&
      ["sudden", "chain", "adult", "party"].every(
        (field) => typeof value[field] === "boolean",
      ),
  );
}

function validDictionary(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.dictionaryId === "string" &&
      value.dictionaryId.length > 0 &&
      value.dictionaryId.length <= 100 &&
      typeof value.artifactSha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(value.artifactSha256),
  );
}

function validDailyRecord(value, id) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.id === id &&
      id === "daily-" + value.date &&
      validDateKey(value.date) &&
      value.mode === "daily" &&
      validConfig(value.config) &&
      Array.isArray(value.board) &&
      value.board.length === value.config.size * value.config.size &&
      value.board.every((letter) => typeof letter === "string" && /^[A-Z]$/.test(letter)) &&
      validDictionary(value.dictionary) &&
      value.quality &&
      typeof value.quality === "object" &&
      Number.isInteger(value.quality.requestedSeed) &&
      value.quality.requestedSeed >= 0 &&
      value.quality.requestedSeed <= 0xffffffff &&
      Number.isInteger(value.quality.selectedCandidateSeed) &&
      value.quality.selectedCandidateSeed >= 0 &&
      value.quality.selectedCandidateSeed <= 0xffffffff &&
      typeof value.createdAt === "string",
  );
}

function validShareRecord(value, ref) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.ref === ref &&
      typeof value.challengeId === "string" &&
      Number.isInteger(value.score) &&
      value.score >= 0 &&
      value.score <= 1_000_000 &&
      Number.isInteger(value.wordCount) &&
      value.wordCount >= 0 &&
      value.wordCount <= 10_000 &&
      Number.isInteger(value.longestLength) &&
      value.longestLength >= 0 &&
      value.longestLength <= 100 &&
      typeof value.expiresAt === "string" &&
      !Number.isNaN(Date.parse(value.expiresAt)),
  );
}

function emptyData() {
  return { schemaVersion: SCHEMA_VERSION, dailies: {}, shares: {} };
}

function validData(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.schemaVersion === SCHEMA_VERSION &&
      value.dailies &&
      typeof value.dailies === "object" &&
      !Array.isArray(value.dailies) &&
      value.shares &&
      typeof value.shares === "object" &&
      !Array.isArray(value.shares) &&
      Object.entries(value.dailies).every(([id, record]) => validDailyRecord(record, id)) &&
      Object.entries(value.shares).every(([ref, share]) => validShareRecord(share, ref)),
  );
}

function publicChallenge(record) {
  return {
    id: record.id,
    date: record.date,
    mode: record.mode,
    config: { ...record.config },
    board: [...record.board],
    dictionary: { ...record.dictionary },
  };
}

function randomReference() {
  return crypto.randomBytes(18).toString("base64url");
}

class DailyChallengeStore {
  constructor(file = process.env.WORDRUSH_DAILY_CHALLENGES_FILE || DEFAULT_FILE) {
    this.file = file;
    this.data = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return validData(data) ? data : emptyData();
    } catch (error) {
      if (error.code === "ENOENT") return emptyData();
      return emptyData();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2) + "\n", {
        mode: 0o600,
      });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }

  prune(now = new Date()) {
    const nowMs = now.valueOf();
    const dailyEntries = Object.entries(this.data.dailies).sort(
      ([, a], [, b]) => b.date.localeCompare(a.date),
    );
    this.data.dailies = Object.fromEntries(dailyEntries.slice(0, MAX_DAILY_RECORDS));
    const liveShares = Object.entries(this.data.shares)
      .filter(([, share]) => Date.parse(share.expiresAt) > nowMs)
      .sort(([, a], [, b]) => b.expiresAt.localeCompare(a.expiresAt))
      .slice(0, MAX_SHARE_RECORDS);
    this.data.shares = Object.fromEntries(liveShares);
  }

  async getOrCreateDaily(date, create) {
    if (!validDateKey(date) || typeof create !== "function")
      throw new Error("DAILY_CHALLENGE_INVALID");
    const id = "daily-" + date;
    const existing = this.data.dailies[id];
    if (existing) return publicChallenge(existing);
    const created = await create({ id, date });
    if (!validDailyRecord(created, id)) throw new Error("DAILY_CHALLENGE_INVALID");
    this.data.dailies[id] = created;
    this.prune();
    this.save();
    return publicChallenge(created);
  }

  createShare(input, now = new Date()) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("CHALLENGE_SHARE_INVALID");
    const allowed = new Set(["challengeId", "score", "wordCount", "longestLength"]);
    if (Object.keys(input).some((field) => !allowed.has(field)))
      throw new Error("CHALLENGE_SHARE_INVALID");
    const { challengeId, score, wordCount, longestLength } = input;
    if (
      typeof challengeId !== "string" ||
      !this.data.dailies[challengeId] ||
      !Number.isInteger(score) || score < 0 || score > 1_000_000 ||
      !Number.isInteger(wordCount) || wordCount < 0 || wordCount > 10_000 ||
      !Number.isInteger(longestLength) || longestLength < 0 || longestLength > 100
    )
      throw new Error("CHALLENGE_SHARE_INVALID");
    let ref = randomReference();
    while (this.data.shares[ref]) ref = randomReference();
    const record = {
      ref,
      challengeId,
      score,
      wordCount,
      longestLength,
      expiresAt: new Date(now.valueOf() + SHARE_TTL_MS).toISOString(),
    };
    this.data.shares[ref] = record;
    this.prune(now);
    this.save();
    return { ref, expiresAt: record.expiresAt };
  }

  getShare(ref, now = new Date()) {
    if (typeof ref !== "string" || !/^[A-Za-z0-9_-]{20,40}$/.test(ref)) return null;
    const share = this.data.shares[ref];
    if (!share) return null;
    if (Date.parse(share.expiresAt) <= now.valueOf()) {
      delete this.data.shares[ref];
      this.save();
      return null;
    }
    const challenge = this.data.dailies[share.challengeId];
    if (!challenge) return null;
    return {
      challenge: publicChallenge(challenge),
      target: {
        score: share.score,
        wordCount: share.wordCount,
        longestLength: share.longestLength,
      },
      expiresAt: share.expiresAt,
    };
  }
}

module.exports = {
  DEFAULT_FILE,
  DailyChallengeStore,
  MAX_DAILY_RECORDS,
  MAX_SHARE_RECORDS,
  SCHEMA_VERSION,
  SHARE_TTL_MS,
  emptyData,
  publicChallenge,
  utcDateKey,
  validConfig,
  validDailyRecord,
  validData,
  validDateKey,
  validDictionary,
  validShareRecord,
};
