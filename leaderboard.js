const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 2;
const TRUST_MODEL = "authoritative-multiplayer-only";
const EMPTY_TRUSTED_DATA = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  trustModel: TRUST_MODEL,
  players: {},
});
const DEFAULT_DIRECTORY =
  process.env.STATE_DIRECTORY ||
  (process.env.NODE_ENV === "production"
    ? "/var/lib/wordrush"
    : path.join(__dirname, "data"));
const DEFAULT_FILE = path.join(DEFAULT_DIRECTORY, "leaderboard.json");

function weekKey(date = new Date()) {
  const day = date.getUTCDay() || 7;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1));
  return monday.toISOString().slice(0, 10);
}

function clean(value, fallback, max = 20) {
  const cleaned = String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return Array.from(cleaned || fallback).slice(0, max).join("");
}
function bodyBoolean(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}
const MULTIPLAYER_OUTCOMES = Object.freeze(["win", "loss", "neutral"]);
function multiplayerOutcomeFromEntry(entry) {
  const value = entry && typeof entry === "object" ? entry : {};
  if (Object.prototype.hasOwnProperty.call(value, "multiplayerOutcome")) {
    if (!MULTIPLAYER_OUTCOMES.includes(value.multiplayerOutcome))
      throw new Error("MULTIPLAYER_OUTCOME_INVALID");
    if (
      value.multiplayerOutcome !== "neutral" &&
      !bodyBoolean(value.multiplayer)
    )
      throw new Error("MULTIPLAYER_OUTCOME_REQUIRES_MULTIPLAYER");
    return value.multiplayerOutcome;
  }
  if (!bodyBoolean(value.multiplayer)) return "neutral";
  return bodyBoolean(value.multiplayerWin) ? "win" : "loss";
}
function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function validPlayer(player, id) {
  if (!player || typeof player !== "object" || player.id !== id) return false;
  const strings = ["name", "avatar"];
  if (strings.some((key) => typeof player[key] !== "string")) return false;
  const numbers = ["totalScore", "totalWords", "rounds", "correct", "incorrect", "longest", "totalWordLength", "totalGameSeconds", "multiplayerWins", "multiplayerLosses"];
  if (numbers.some((key) => !nonNegativeNumber(player[key]))) return false;
  if (!player.weekly || typeof player.weekly !== "object" || Array.isArray(player.weekly)) return false;
  return Object.entries(player.weekly).every(([key, value]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && nonNegativeNumber(value));
}
function validTrustedData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.schemaVersion !== SCHEMA_VERSION || value.trustModel !== TRUST_MODEL) return false;
  if (!value.players || typeof value.players !== "object" || Array.isArray(value.players)) return false;
  return Object.entries(value.players).every(([id, player]) => validPlayer(player, id));
}

class Leaderboard {
  constructor(file = process.env.WORDRUSH_LEADERBOARD_FILE || DEFAULT_FILE) {
    this.file = file;
    this.trusted = !fs.existsSync(file);
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (validTrustedData(parsed)) {
        this.trusted = true;
        return parsed;
      }
      this.trusted = false;
    } catch (error) {
      if (error.code === "ENOENT") {
        this.trusted = true;
        return { ...EMPTY_TRUSTED_DATA, players: {} };
      }
      this.trusted = false;
    }
    return { ...EMPTY_TRUSTED_DATA, players: {} };
  }

  save() {
    if (!this.trusted) throw new Error("LEADERBOARD_REQUIRES_EXPLICIT_RESET");
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

  recordScore(entry = {}, { save = true } = {}) {
    if (!this.trusted) throw new Error("LEADERBOARD_REQUIRES_EXPLICIT_RESET");
    const multiplayerOutcome = multiplayerOutcomeFromEntry(entry);
    const {
      id,
      name,
      avatar,
      score = 0,
      words = 0,
      correct = 0,
      incorrect = 0,
      longest = 0,
      totalWordLength = 0,
      gameSeconds = 0,
      multiplayer = false,
      multiplayerWin = false,
      at = new Date(),
    } = entry;
    const playerId = clean(id, "guest", 80);
    const player = (this.data.players[playerId] ||= {
      id: playerId, name: "Guest", avatar: "🐈", totalScore: 0, totalWords: 0,
      rounds: 0, correct: 0, incorrect: 0, longest: 0, totalWordLength: 0,
      totalGameSeconds: 0, multiplayerWins: 0, multiplayerLosses: 0, weekly: {},
    });
    player.multiplayerWins ||= 0;
    player.multiplayerLosses ||= 0;
    player.name = clean(name, player.name || "Guest");
    player.avatar = clean(avatar, player.avatar || "🐈", 2);
    const limits = { score: 1000000, words: 10000, correct: 10000, incorrect: 10000, longest: 100, totalWordLength: 100000, gameSeconds: 600 };
    const values = { score, words, correct, incorrect, longest, totalWordLength, gameSeconds };
    for (const [key, value] of Object.entries(values)) values[key] = Math.min(limits[key], Math.max(0, Number(value) || 0));
    player.totalScore += values.score; player.totalWords += values.words; player.rounds += 1;
    player.correct += values.correct; player.incorrect += values.incorrect;
    player.longest = Math.max(player.longest, values.longest); player.totalWordLength += values.totalWordLength;
    player.totalGameSeconds += values.gameSeconds;
    if (multiplayerOutcome === "win") player.multiplayerWins++;
    else if (multiplayerOutcome === "loss") player.multiplayerLosses++;
    const scoreDate = new Date(at);
    const key = weekKey(Number.isNaN(scoreDate.valueOf()) ? new Date() : scoreDate);
    player.weekly[key] = (player.weekly[key] || 0) + values.score;
    if (save) this.save();
    return this.publicPlayer(player, "total");
  }

  recordScores(entries) {
    if (!this.trusted) throw new Error("LEADERBOARD_REQUIRES_EXPLICIT_RESET");
    if (!Array.isArray(entries)) throw new Error("LEADERBOARD_ENTRIES_INVALID");
    entries.forEach(multiplayerOutcomeFromEntry);
    const players = entries.map((entry) => this.recordScore(entry, { save: false }));
    this.save();
    return players;
  }

  publicPlayer(player, period = "total") {
    const games = player.multiplayerWins + player.multiplayerLosses;
    const ratio = games ? player.multiplayerWins / games : 0;
    const score = period === "weekly" ? player.weekly[weekKey()] || 0 : period === "multiplayer-wins" ? player.multiplayerWins : period === "multiplayer-ratio" ? ratio : player.totalScore;
    return { id: player.id, name: player.name, avatar: player.avatar, score, totalScore: player.totalScore, totalWords: player.totalWords, rounds: player.rounds, correct: player.correct, incorrect: player.incorrect, longest: player.longest, totalWordLength: player.totalWordLength, totalGameSeconds: player.totalGameSeconds, multiplayerWins: player.multiplayerWins, multiplayerLosses: player.multiplayerLosses, multiplayerWinRatio: ratio };
  }

  rankings(period = "weekly") {
    const selected = ["total", "multiplayer-wins", "multiplayer-ratio"].includes(period) ? period : "weekly";
    return Object.values(this.data.players).map((player) => this.publicPlayer(player, selected)).filter((player) => player.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 100);
  }

  profile(id) {
    const player = this.data.players[String(id)];
    return player ? this.publicPlayer(player, "total") : null;
  }
}

module.exports = {
  DEFAULT_FILE,
  EMPTY_TRUSTED_DATA,
  Leaderboard,
  MULTIPLAYER_OUTCOMES,
  SCHEMA_VERSION,
  TRUST_MODEL,
  multiplayerOutcomeFromEntry,
  validTrustedData,
  weekKey,
};
