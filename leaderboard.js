const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, 'data', 'leaderboard.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekKey(date = new Date()) {
  const day = date.getUTCDay() || 7;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1));
  return monday.toISOString().slice(0, 10);
}

function clean(value, fallback, max = 20) {
  return String(value ?? fallback).trim().slice(0, max) || fallback;
}

class Leaderboard {
  constructor(file = process.env.WORDRUSH_LEADERBOARD_FILE || DEFAULT_FILE) {
    this.file = file;
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && parsed.players ? parsed : { players: {} };
    } catch {
      return { players: {} };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2));
    fs.renameSync(temporary, this.file);
  }

  recordScore({ id, name, avatar, score = 0, words = 0, correct = 0, incorrect = 0, longest = 0, totalWordLength = 0, gameSeconds = 0, at = new Date() }) {
    const playerId = clean(id, 'guest', 80);
    const player = this.data.players[playerId] ||= { id: playerId, name: 'Guest', avatar: '🐈', totalScore: 0, totalWords: 0, rounds: 0, correct: 0, incorrect: 0, longest: 0, totalWordLength: 0, totalGameSeconds: 0, weekly: {} };
    player.name = clean(name, player.name || 'Guest');
    player.avatar = clean(avatar, player.avatar || '🐈', 4);
    const values = { score, words, correct, incorrect, longest, totalWordLength, gameSeconds };
    for (const [key, value] of Object.entries(values)) values[key] = Math.max(0, Number(value) || 0);
    player.totalScore += values.score;
    player.totalWords += values.words;
    player.rounds += 1;
    player.correct += values.correct;
    player.incorrect += values.incorrect;
    player.longest = Math.max(player.longest, values.longest);
    player.totalWordLength += values.totalWordLength;
    player.totalGameSeconds += values.gameSeconds;
    const key = weekKey(new Date(at));
    player.weekly[key] = (player.weekly[key] || 0) + values.score;
    this.save();
    return this.publicPlayer(player, 'total');
  }

  publicPlayer(player, period = 'total') {
    const score = period === 'weekly' ? player.weekly[weekKey()] || 0 : player.totalScore;
    return { id: player.id, name: player.name, avatar: player.avatar, score, totalScore: player.totalScore, totalWords: player.totalWords, rounds: player.rounds, correct: player.correct, incorrect: player.incorrect, longest: player.longest, totalWordLength: player.totalWordLength, totalGameSeconds: player.totalGameSeconds };
  }

  rankings(period = 'weekly') {
    const selected = period === 'total' ? 'total' : 'weekly';
    return Object.values(this.data.players).map(player => this.publicPlayer(player, selected)).filter(player => player.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 100);
  }

  profile(id) {
    const player = this.data.players[String(id)];
    return player ? this.publicPlayer(player, 'total') : null;
  }
}

module.exports = { Leaderboard, weekKey, WEEK_MS };
