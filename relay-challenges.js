const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const RELAY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RELAY_RECORDS = 1_000;
const MAX_STATE_BYTES = 16 * 1024;
const STORE_UNAVAILABLE = "RELAY_CHALLENGE_STORE_UNAVAILABLE";
const DEFAULT_DIRECTORY =
  process.env.STATE_DIRECTORY ||
  (process.env.NODE_ENV === "production"
    ? "/var/lib/wordrush"
    : path.join(__dirname, "data"));
const DEFAULT_FILE = path.join(DEFAULT_DIRECTORY, "relay-challenges.json");

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validOpaqueId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,40}$/.test(value);
}

function validConfig(value) {
  return Boolean(
    isObject(value) &&
      typeof value.label === "string" && value.label.length > 0 && value.label.length <= 32 &&
      typeof value.rule === "string" && value.rule.length > 0 && value.rule.length <= 100 &&
      Number.isInteger(value.min) && value.min >= 3 && value.min <= 12 &&
      Number.isInteger(value.size) && value.size >= 4 && value.size <= 8 &&
      Number.isInteger(value.seconds) && value.seconds >= 15 && value.seconds <= 600 &&
      (value.target === null || (typeof value.target === "number" && Number.isFinite(value.target))) &&
      ["sudden", "chain", "adult", "party"].every((field) => typeof value[field] === "boolean"),
  );
}

function validDictionary(value) {
  return Boolean(
    isObject(value) &&
      typeof value.dictionaryId === "string" && value.dictionaryId.length > 0 && value.dictionaryId.length <= 100 &&
      typeof value.artifactSha256 === "string" && /^[a-f0-9]{64}$/i.test(value.artifactSha256),
  );
}

function jsonValue(value, depth = 0) {
  if (depth > 8 || value === null) return value === null;
  if (["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 200 && value.every((item) => jsonValue(item, depth + 1));
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 100 && entries.every(([key, item]) => key.length <= 100 && jsonValue(item, depth + 1));
}

function validState(value) {
  if (!jsonValue(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_STATE_BYTES;
  } catch {
    return false;
  }
}

function validRecord(value, id) {
  return Boolean(
    isObject(value) &&
      value.id === id && validOpaqueId(id) &&
      validConfig(value.config) &&
      Array.isArray(value.board) &&
      value.board.length === value.config.size * value.config.size &&
      value.board.every((letter) => typeof letter === "string" && /^[A-Z]$/.test(letter)) &&
      validDictionary(value.dictionary) &&
      validState(value.state) &&
      Number.isSafeInteger(value.revision) && value.revision >= 0 &&
      typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) &&
      typeof value.expiresAt === "string" && !Number.isNaN(Date.parse(value.expiresAt)) &&
      Date.parse(value.expiresAt) > Date.parse(value.createdAt),
  );
}

function emptyData() {
  return { schemaVersion: SCHEMA_VERSION, challenges: {} };
}

function validData(value) {
  return Boolean(
    isObject(value) &&
      value.schemaVersion === SCHEMA_VERSION &&
      isObject(value.challenges) &&
      Object.keys(value.challenges).length <= MAX_RELAY_RECORDS &&
      Object.entries(value.challenges).every(([id, record]) => validRecord(record, id)),
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function randomId() {
  return crypto.randomBytes(18).toString("base64url");
}

class RelayChallengeStore {
  constructor(file = process.env.WORDRUSH_RELAY_CHALLENGES_FILE || DEFAULT_FILE) {
    this.file = file;
    this.trusted = false;
    this.data = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!validData(data)) {
        this.trusted = false;
        return emptyData();
      }
      this.trusted = true;
      return data;
    } catch (error) {
      if (error.code === "ENOENT") {
        this.trusted = true;
        return emptyData();
      }
      this.trusted = false;
      return emptyData();
    }
  }

  ensureAvailable() {
    if (!this.trusted) throw new Error(STORE_UNAVAILABLE);
  }

  save() {
    this.ensureAvailable();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }

  prune(now = new Date()) {
    this.ensureAvailable();
    const nowMs = now.valueOf();
    const live = Object.entries(this.data.challenges)
      .filter(([, record]) => Date.parse(record.expiresAt) > nowMs)
      .sort(([, a], [, b]) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, MAX_RELAY_RECORDS);
    const challenges = Object.fromEntries(live);
    const changed = Object.keys(challenges).length !== Object.keys(this.data.challenges).length;
    this.data.challenges = challenges;
    return changed;
  }

  async create(input, now = new Date()) {
    this.ensureAvailable();
    if (!isObject(input) || !Number.isFinite(now.valueOf()))
      throw new Error("RELAY_CHALLENGE_INVALID");
    const allowed = new Set(["board", "config", "dictionary", "state", "ttlMs"]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw new Error("RELAY_CHALLENGE_INVALID");
    const ttlMs = input.ttlMs === undefined ? RELAY_TTL_MS : input.ttlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_RELAY_TTL_MS ||
      !validConfig(input.config) || !validDictionary(input.dictionary) || !validState(input.state) ||
      !Array.isArray(input.board) || input.board.length !== input.config.size * input.config.size ||
      !input.board.every((letter) => typeof letter === "string" && /^[A-Z]$/.test(letter)))
      throw new Error("RELAY_CHALLENGE_INVALID");
    let id = randomId();
    while (this.data.challenges[id]) id = randomId();
    const record = {
      id,
      board: clone(input.board),
      config: clone(input.config),
      dictionary: clone(input.dictionary),
      state: clone(input.state),
      revision: 0,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.valueOf() + ttlMs).toISOString(),
    };
    this.data.challenges[id] = record;
    this.prune(now);
    this.save();
    return clone(record);
  }

  get(id, now = new Date()) {
    this.ensureAvailable();
    if (!validOpaqueId(id) || !Number.isFinite(now.valueOf())) return null;
    const record = this.data.challenges[id];
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= now.valueOf()) {
      delete this.data.challenges[id];
      this.save();
      return null;
    }
    return clone(record);
  }

  async transition(id, revision, apply, now = new Date()) {
    this.ensureAvailable();
    if (!validOpaqueId(id) || !Number.isSafeInteger(revision) || revision < 0 ||
      typeof apply !== "function" || !Number.isFinite(now.valueOf()))
      throw new Error("RELAY_CHALLENGE_INVALID");
    const record = this.data.challenges[id];
    if (!record || Date.parse(record.expiresAt) <= now.valueOf()) {
      if (record) {
        delete this.data.challenges[id];
        this.save();
      }
      throw new Error("RELAY_CHALLENGE_NOT_FOUND");
    }
    if (record.revision !== revision) throw new Error("RELAY_CHALLENGE_STALE_REVISION");
    const snapshot = deepFreeze(clone(record));
    let nextState;
    try {
      nextState = apply(snapshot.state, snapshot);
    } catch (error) {
      throw error;
    }
    if (!validState(nextState)) throw new Error("RELAY_CHALLENGE_TRANSITION_INVALID");
    const updated = { ...record, state: clone(nextState), revision: record.revision + 1 };
    if (!validRecord(updated, id)) throw new Error("RELAY_CHALLENGE_TRANSITION_INVALID");
    this.data.challenges[id] = updated;
    this.prune(now);
    this.save();
    return clone(updated);
  }
}

module.exports = {
  DEFAULT_FILE,
  MAX_RELAY_RECORDS,
  MAX_RELAY_TTL_MS,
  MAX_STATE_BYTES,
  RELAY_TTL_MS,
  RelayChallengeStore,
  SCHEMA_VERSION,
  STORE_UNAVAILABLE,
  emptyData,
  validConfig,
  validData,
  validDictionary,
  validOpaqueId,
  validRecord,
  validState,
};
