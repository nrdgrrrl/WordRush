const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA_VERSION = 1;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 20;
const MAX_AVATAR_LENGTH = 500;
const MAX_EVENT_IDS = 500;
const DEFAULT_DIRECTORY =
  process.env.STATE_DIRECTORY ||
  (process.env.NODE_ENV === "production"
    ? "/var/lib/wordrush"
    : path.join(__dirname, "data"));
const DEFAULT_FILE = path.join(DEFAULT_DIRECTORY, "accounts.json");
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{2,19}$/;
const BLOCKED_USERNAME_WORDS = Object.freeze([
  "ass",
  "bastard",
  "bitch",
  "cock",
  "cunt",
  "dick",
  "fag",
  "fuck",
  "nazi",
  "piss",
  "porno",
  "rape",
  "shit",
  "slut",
  "whore",
]);
const EMOJI_AVATARS = Object.freeze([
  "🐈", "🦊", "🐼", "🐸", "🦄", "🐙", "🐯", "🦁", "🐨", "🐵",
  "🙈", "🐔", "🐧", "🐦", "🦉", "🐝", "🦋", "🐌", "🐞", "🐢",
  "🐍", "🦎", "🐳", "🐬", "🦈", "🐊", "🦀", "🐿️", "🦔", "🦥",
  "🦦", "🦙", "🦘", "🦚", "🐲",
]);

const EMPTY_STATS = Object.freeze({
  score: 0,
  words: 0,
  streak: 0,
  longest: 0,
  rounds: 0,
  correct: 0,
  incorrect: 0,
  totalWordLength: 0,
  totalGameSeconds: 0,
  gamesWon: 0,
  gamesLost: 0,
  multiplayerWins: 0,
  multiplayerLosses: 0,
  maxGridWin: 0,
  speedAchievement: false,
  days: [],
  completedMultiplayerRounds: [],
  multiplayerWordRounds: [],
});
const COUNTER_FIELDS = Object.freeze([
  "score", "words", "rounds", "correct", "incorrect", "totalWordLength",
  "totalGameSeconds", "gamesWon", "gamesLost", "multiplayerWins",
  "multiplayerLosses",
]);
const MAX_COUNTERS = Object.freeze({
  score: 100_000_000_000,
  words: 100_000_000,
  rounds: 10_000_000,
  correct: 100_000_000,
  incorrect: 100_000_000,
  totalWordLength: 1_000_000_000,
  totalGameSeconds: 1_000_000_000,
  gamesWon: 10_000_000,
  gamesLost: 10_000_000,
  multiplayerWins: 10_000_000,
  multiplayerLosses: 10_000_000,
});

function number(value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(maximum, parsed)
    : 0;
}

function cleanText(value, fallback, maximum = 80) {
  const cleaned = String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return Array.from(cleaned || fallback).slice(0, maximum).join("");
}

function usernameKey(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-CA");
}

function usernameBlocked(value) {
  const words = String(value || "")
    .toLocaleLowerCase("en-CA")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compact = words.join("");
  return BLOCKED_USERNAME_WORDS.some(
    (word) => words.includes(word) || (word.length >= 4 && compact.includes(word)),
  );
}

function normalizeUsername(value) {
  const username = String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH)
    return { valid: false, error: "USERNAME_LENGTH" };
  if (!USERNAME_PATTERN.test(username))
    return { valid: false, error: "USERNAME_CHARACTERS" };
  if (usernameBlocked(username))
    return { valid: false, error: "USERNAME_BLOCKED" };
  return { valid: true, value: username, key: usernameKey(username) };
}

function isAvatar(value) {
  if (typeof value !== "string" || !value || value.length > MAX_AVATAR_LENGTH)
    return false;
  if (EMOJI_AVATARS.includes(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && [
      "lh3.googleusercontent.com",
      "googleusercontent.com",
      "platform-lookaside.fbsbx.com",
      "facebook.com",
      "fbcdn.net",
    ].some((host) => url.hostname === host || url.hostname.endsWith("." + host));
  } catch {
    return false;
  }
}

function normalizeDays(days) {
  return [...new Set(Array.isArray(days)
    ? days.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    : [])].sort().slice(-400);
}

function normalizeRounds(rounds) {
  return [...new Set(Array.isArray(rounds)
    ? rounds.filter((value) => typeof value === "string" && value.length <= 160)
    : [])].slice(-100);
}

function normalizeWordRounds(rounds) {
  if (!Array.isArray(rounds)) return [];
  const seen = new Set();
  return rounds.filter((value) => {
    if (!value || typeof value !== "object") return false;
    const roundId = cleanText(value.roundId, "", 160);
    const words = Array.isArray(value.words)
      ? value.words.filter((word) => typeof word === "string").map((word) => word.slice(0, 30))
      : [];
    if (!roundId || seen.has(roundId)) return false;
    seen.add(roundId);
    return true;
  }).map((value) => ({
    roundId: cleanText(value.roundId, "", 160),
    words: [...new Set(value.words.filter((word) => typeof word === "string"))].slice(-200),
  })).slice(-100);
}

function normalizeStats(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const stats = { ...EMPTY_STATS };
  for (const key of COUNTER_FIELDS)
    stats[key] = number(source[key], MAX_COUNTERS[key]);
  for (const key of ["longest", "maxGridWin"])
    stats[key] = number(source[key], 100);
  stats.streak = number(source.streak, 400);
  stats.speedAchievement = source.speedAchievement === true;
  stats.days = normalizeDays(source.days);
  stats.completedMultiplayerRounds = normalizeRounds(source.completedMultiplayerRounds);
  stats.multiplayerWordRounds = normalizeWordRounds(source.multiplayerWordRounds);
  return stats;
}

function mergeStats(target, source) {
  const left = normalizeStats(target);
  const right = normalizeStats(source);
  const merged = { ...left };
  for (const key of COUNTER_FIELDS) {
    merged[key] = Math.min(MAX_COUNTERS[key], left[key] + right[key]);
  }
  merged.longest = Math.max(left.longest, right.longest);
  merged.maxGridWin = Math.max(left.maxGridWin, right.maxGridWin);
  merged.speedAchievement = left.speedAchievement || right.speedAchievement;
  merged.days = normalizeDays([...left.days, ...right.days]);
  merged.completedMultiplayerRounds = normalizeRounds([
    ...left.completedMultiplayerRounds,
    ...right.completedMultiplayerRounds,
  ]);
  const rounds = new Map(left.multiplayerWordRounds.map((round) => [round.roundId, round]));
  for (const round of right.multiplayerWordRounds) {
    const current = rounds.get(round.roundId);
    rounds.set(round.roundId, current
      ? { roundId: round.roundId, words: [...new Set([...current.words, ...round.words])].slice(-200) }
      : round);
  }
  merged.multiplayerWordRounds = [...rounds.values()].slice(-100);
  merged.streak = number(Math.max(left.streak, right.streak), 400);
  return merged;
}

function deltaStats(current, base) {
  const now = normalizeStats(current);
  const previous = normalizeStats(base);
  const delta = {};
  for (const key of COUNTER_FIELDS) {
    const change = now[key] - previous[key];
    if (change > 0) delta[key] = change;
  }
  if (now.longest > previous.longest) delta.longest = now.longest;
  if (now.maxGridWin > previous.maxGridWin) delta.maxGridWin = now.maxGridWin;
  if (now.speedAchievement && !previous.speedAchievement) delta.speedAchievement = true;
  const newDays = now.days.filter((day) => !previous.days.includes(day));
  if (newDays.length) delta.days = newDays;
  const newRounds = now.completedMultiplayerRounds.filter(
    (round) => !previous.completedMultiplayerRounds.includes(round),
  );
  if (newRounds.length) delta.completedMultiplayerRounds = newRounds;
  const previousWords = new Map(previous.multiplayerWordRounds.map((round) => [round.roundId, round]));
  const newWordRounds = now.multiplayerWordRounds.map((round) => ({
    roundId: round.roundId,
    words: round.words.filter((word) => !previousWords.get(round.roundId)?.words.includes(word)),
  })).filter((round) => round.words.length);
  if (newWordRounds.length) delta.multiplayerWordRounds = newWordRounds;
  return delta;
}

function publicStats(stats) {
  return normalizeStats(stats);
}

function emptyData() {
  return { schemaVersion: SCHEMA_VERSION, accounts: {}, providerIndex: {}, usernames: {} };
}

function validAccount(account, id) {
  return Boolean(
    account && typeof account === "object" && !Array.isArray(account) &&
    account.id === id && typeof account.createdAt === "string" &&
    typeof account.updatedAt === "string" && account.providers &&
    typeof account.providers === "object" && !Array.isArray(account.providers) &&
    Object.entries(account.providers).every(([provider, providerId]) =>
      ["google", "facebook"].includes(provider) && typeof providerId === "string" && providerId.length <= 255,
    ) && (account.username === null || typeof account.username === "string") &&
    (account.avatar === null || isAvatar(account.avatar)) &&
    typeof account.displayName === "string" && account.displayName.length <= 80 &&
    account.stats && typeof account.stats === "object" &&
    account.appliedEventIds && typeof account.appliedEventIds === "object" &&
    account.migratedGuestIds && typeof account.migratedGuestIds === "object",
  );
}

function validData(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    value.schemaVersion === SCHEMA_VERSION && value.accounts &&
    typeof value.accounts === "object" && !Array.isArray(value.accounts) &&
    value.providerIndex && typeof value.providerIndex === "object" &&
    !Array.isArray(value.providerIndex) && value.usernames &&
    typeof value.usernames === "object" && !Array.isArray(value.usernames) &&
    Object.entries(value.accounts).every(([id, account]) => validAccount(account, id)),
  );
}

function publicAccount(account, providers = []) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    avatar: account.avatar || "🐈",
    stats: publicStats(account.stats),
    needsUsername: !account.username,
    provider: Object.keys(account.providers)[0] || null,
    providers,
  };
}

class AccountStore {
  constructor(file = process.env.WORDRUSH_ACCOUNT_FILE || DEFAULT_FILE) {
    this.file = file;
    this.trusted = !fs.existsSync(file);
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (validData(parsed)) {
        this.trusted = true;
        return parsed;
      }
      this.trusted = false;
    } catch (error) {
      if (error.code === "ENOENT") {
        this.trusted = true;
        return emptyData();
      }
      this.trusted = false;
    }
    return emptyData();
  }

  save(data = this.data) {
    if (!this.trusted) throw new Error("ACCOUNT_STORE_REQUIRES_EXPLICIT_RESET");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  candidate() {
    return JSON.parse(JSON.stringify(this.data));
  }

  commit(data) {
    this.save(data);
    this.data = data;
  }

  get(id) {
    return this.data.accounts[String(id)] || null;
  }

  getByProvider(provider, providerId) {
    const id = this.data.providerIndex[provider + ":" + providerId];
    return id ? this.get(id) : null;
  }

  ensureProviderAccount(provider, providerId, { displayName, avatar } = {}) {
    if (!["google", "facebook"].includes(provider)) throw new Error("AUTH_PROVIDER_INVALID");
    const normalizedProviderId = cleanText(providerId, "", 255);
    if (!normalizedProviderId) throw new Error("AUTH_PROVIDER_ID_INVALID");
    const existing = this.getByProvider(provider, normalizedProviderId);
    if (existing) {
      const nextDisplayName = cleanText(displayName, existing.displayName || "Player", 80);
      if (nextDisplayName !== existing.displayName || (isAvatar(avatar) && avatar !== existing.avatar)) {
        const data = this.candidate();
        const account = data.accounts[existing.id];
        account.displayName = nextDisplayName;
        if (isAvatar(avatar)) account.avatar = avatar;
        account.updatedAt = new Date().toISOString();
        this.commit(data);
        return account;
      }
      return existing;
    }
    const id = "acct_" + crypto.randomUUID();
    const now = new Date().toISOString();
    const account = {
      id,
      providers: { [provider]: normalizedProviderId },
      username: null,
      displayName: cleanText(displayName, "Player", 80),
      avatar: isAvatar(avatar) ? avatar : "🐈",
      stats: normalizeStats(),
      appliedEventIds: {},
      migratedGuestIds: {},
      createdAt: now,
      updatedAt: now,
    };
    const data = this.candidate();
    data.accounts[id] = account;
    data.providerIndex[provider + ":" + normalizedProviderId] = id;
    this.commit(data);
    return account;
  }

  setUsername(accountId, value) {
    const account = this.get(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    const result = normalizeUsername(value);
    if (!result.valid) {
      const error = new Error(result.error);
      error.code = result.error;
      throw error;
    }
    const owner = this.data.usernames[result.key];
    if (owner && owner !== account.id) {
      const error = new Error("USERNAME_TAKEN");
      error.code = "USERNAME_TAKEN";
      throw error;
    }
    const data = this.candidate();
    const nextAccount = data.accounts[account.id];
    if (nextAccount.username) delete data.usernames[usernameKey(nextAccount.username)];
    nextAccount.username = result.value;
    data.usernames[result.key] = nextAccount.id;
    nextAccount.updatedAt = new Date().toISOString();
    this.commit(data);
    return nextAccount;
  }

  updateAvatar(accountId, value) {
    const account = this.get(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    if (!isAvatar(value)) throw new Error("AVATAR_INVALID");
    const data = this.candidate();
    const nextAccount = data.accounts[account.id];
    nextAccount.avatar = value;
    nextAccount.updatedAt = new Date().toISOString();
    this.commit(data);
    return nextAccount;
  }

  migrate(accountId, guestId, profile) {
    const account = this.get(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    const guest = cleanText(guestId, "", 100);
    if (!guest) throw new Error("GUEST_ID_REQUIRED");
    if (!account.migratedGuestIds[guest]) {
      const data = this.candidate();
      const nextAccount = data.accounts[account.id];
      nextAccount.stats = mergeStats(nextAccount.stats, profile);
      nextAccount.migratedGuestIds[guest] = new Date().toISOString();
      nextAccount.updatedAt = new Date().toISOString();
      this.commit(data);
      return nextAccount;
    }
    return account;
  }

  applyEvent(accountId, eventId, delta) {
    const account = this.get(accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    const id = cleanText(eventId, "", 160);
    if (!id) throw new Error("PROFILE_EVENT_ID_REQUIRED");
    if (account.appliedEventIds[id]) return account;
    const data = this.candidate();
    const nextAccount = data.accounts[account.id];
    nextAccount.stats = mergeStats(nextAccount.stats, delta);
    nextAccount.appliedEventIds[id] = new Date().toISOString();
    const ids = Object.keys(nextAccount.appliedEventIds);
    if (ids.length > MAX_EVENT_IDS) {
      for (const oldId of ids.slice(0, ids.length - MAX_EVENT_IDS))
        delete nextAccount.appliedEventIds[oldId];
    }
    nextAccount.updatedAt = new Date().toISOString();
    this.commit(data);
    return nextAccount;
  }

  public(accountId, providers = []) {
    return publicAccount(this.get(accountId), providers);
  }
}

module.exports = {
  AccountStore,
  BLOCKED_USERNAME_WORDS,
  DEFAULT_FILE,
  EMPTY_STATS,
  EMOJI_AVATARS,
  MAX_AVATAR_LENGTH,
  SCHEMA_VERSION,
  deltaStats,
  isAvatar,
  mergeStats,
  normalizeStats,
  normalizeUsername,
  publicAccount,
  usernameBlocked,
  usernameKey,
  validData,
};
