const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_FILE = path.join(__dirname, "data", "leaderboard.json");

function weekKey(date = new Date()) {
  const day = date.getUTCDay() || 7;
  const monday = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - day + 1,
    ),
  );
  return monday.toISOString().slice(0, 10);
}

function clean(value, fallback, max = 20) {
  const cleaned = String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return Array.from(cleaned || fallback)
    .slice(0, max)
    .join("");
}
function bodyBoolean(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

class Leaderboard {
  constructor(file = process.env.WORDRUSH_LEADERBOARD_FILE || DEFAULT_FILE) {
    this.file = file;
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return parsed && parsed.players ? parsed : { players: {} };
    } catch {
      return { players: {} };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2));
    fs.renameSync(temporary, this.file);
  }

  recordScore(
    {
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
    },
    { save = true } = {},
  ) {
    const playerId = clean(id, "guest", 80);
    const player = (this.data.players[playerId] ||= {
      id: playerId,
      name: "Guest",
      avatar: "🐈",
      totalScore: 0,
      totalWords: 0,
      rounds: 0,
      correct: 0,
      incorrect: 0,
      longest: 0,
      totalWordLength: 0,
      totalGameSeconds: 0,
      multiplayerWins: 0,
      multiplayerLosses: 0,
      weekly: {},
    });
    player.multiplayerWins ||= 0;
    player.multiplayerLosses ||= 0;
    player.name = clean(name, player.name || "Guest");
    player.avatar = clean(avatar, player.avatar || "🐈", 2);
    const limits = {
      score: 1000000,
      words: 10000,
      correct: 10000,
      incorrect: 10000,
      longest: 100,
      totalWordLength: 100000,
      gameSeconds: 600,
    };
    const values = {
      score,
      words,
      correct,
      incorrect,
      longest,
      totalWordLength,
      gameSeconds,
    };
    for (const [key, value] of Object.entries(values))
      values[key] = Math.min(limits[key], Math.max(0, Number(value) || 0));
    player.totalScore += values.score;
    player.totalWords += values.words;
    player.rounds += 1;
    player.correct += values.correct;
    player.incorrect += values.incorrect;
    player.longest = Math.max(player.longest, values.longest);
    player.totalWordLength += values.totalWordLength;
    player.totalGameSeconds += values.gameSeconds;
    if (bodyBoolean(multiplayer)) {
      if (bodyBoolean(multiplayerWin)) player.multiplayerWins += 1;
      else player.multiplayerLosses += 1;
    }
    const scoreDate = new Date(at);
    const key = weekKey(
      Number.isNaN(scoreDate.valueOf()) ? new Date() : scoreDate,
    );
    player.weekly[key] = (player.weekly[key] || 0) + values.score;
    if (save) this.save();
    return this.publicPlayer(player, "total");
  }

  recordScores(entries) {
    const players = entries.map((entry) =>
      this.recordScore(entry, { save: false }),
    );
    this.save();
    return players;
  }

  publicPlayer(player, period = "total") {
    const ratio =
      player.multiplayerWins + player.multiplayerLosses
        ? player.multiplayerWins /
          (player.multiplayerWins + player.multiplayerLosses)
        : 0;
    const score =
      period === "weekly"
        ? player.weekly[weekKey()] || 0
        : period === "multiplayer-wins"
          ? player.multiplayerWins
          : period === "multiplayer-ratio"
            ? ratio
            : player.totalScore;
    return {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      score,
      totalScore: player.totalScore,
      totalWords: player.totalWords,
      rounds: player.rounds,
      correct: player.correct,
      incorrect: player.incorrect,
      longest: player.longest,
      totalWordLength: player.totalWordLength,
      totalGameSeconds: player.totalGameSeconds,
      multiplayerWins: player.multiplayerWins,
      multiplayerLosses: player.multiplayerLosses,
      multiplayerWinRatio: ratio,
    };
  }

  rankings(period = "weekly") {
    const selected = [
      "total",
      "multiplayer-wins",
      "multiplayer-ratio",
    ].includes(period)
      ? period
      : "weekly";
    return Object.values(this.data.players)
      .map((player) => this.publicPlayer(player, selected))
      .filter((player) => player.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 100);
  }

  profile(id) {
    const player = this.data.players[String(id)];
    return player ? this.publicPlayer(player, "total") : null;
  }
}

module.exports = { Leaderboard, weekKey };
