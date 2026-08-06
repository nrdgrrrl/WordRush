const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AccountStore,
  deltaStats,
  mergeStats,
  normalizeUsername,
} = require("../account-store");

function store() {
  return new AccountStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-account-")), "accounts.json"));
}

test("usernames are normalized, unique, and block profanity", () => {
  assert.deepEqual(normalizeUsername("  Cosmic   Tuxedo  "), {
    valid: true,
    value: "Cosmic Tuxedo",
    key: "cosmic tuxedo",
  });
  assert.equal(normalizeUsername("class").valid, true);
  assert.equal(normalizeUsername("shit").error, "USERNAME_BLOCKED");
  assert.equal(normalizeUsername("bad/name").error, "USERNAME_CHARACTERS");
});

test("provider accounts are created automatically and username ownership is case insensitive", () => {
  const accounts = store();
  const first = accounts.ensureProviderAccount("google", "google-1", {
    displayName: "Cosmic Tuxedo",
    avatar: "https://lh3.googleusercontent.com/avatar",
  });
  assert.equal(first.username, null);
  assert.equal(accounts.getByProvider("google", "google-1").id, first.id);
  accounts.setUsername(first.id, "CosmicTuxedo");
  const second = accounts.ensureProviderAccount("facebook", "facebook-2", {
    displayName: "Other Player",
  });
  assert.throws(() => accounts.setUsername(second.id, "cosmictuxedo"), /USERNAME_TAKEN/);
  assert.equal(accounts.get(first.id).avatar, "https://lh3.googleusercontent.com/avatar");
});

test("guest migration and profile events are durable and idempotent", () => {
  const accounts = store();
  const account = accounts.ensureProviderAccount("google", "google-3", { displayName: "Player" });
  const snapshot = { score: 15, words: 3, rounds: 1, correct: 3, days: ["2026-08-06"] };
  accounts.migrate(account.id, "guest-device", snapshot);
  accounts.migrate(account.id, "guest-device", snapshot);
  assert.equal(accounts.get(account.id).stats.score, 15);
  accounts.applyEvent(account.id, "event-1", { score: 8, words: 2, rounds: 1 });
  accounts.applyEvent(account.id, "event-1", { score: 8, words: 2, rounds: 1 });
  const reloaded = new AccountStore(accounts.file);
  assert.deepEqual(reloaded.get(account.id).stats.score, 23);
  assert.deepEqual(reloaded.get(account.id).stats.words, 5);
  assert.deepEqual(reloaded.get(account.id).stats.rounds, 2);
});

test("profile deltas preserve max values and additive counters", () => {
  const base = { score: 10, words: 2, longest: 4, maxGridWin: 4, days: ["2026-08-05"] };
  const current = { score: 18, words: 3, longest: 6, maxGridWin: 5, days: ["2026-08-05", "2026-08-06"] };
  assert.deepEqual(deltaStats(current, base), {
    score: 8,
    words: 1,
    longest: 6,
    maxGridWin: 5,
    days: ["2026-08-06"],
  });
  assert.equal(mergeStats(base, deltaStats(current, base)).score, 18);
});
