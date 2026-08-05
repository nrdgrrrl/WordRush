const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DailyChallengeStore,
  utcDateKey,
  validDateKey,
} = require("../daily-challenges");

function fixtureRecord(date = "2026-08-05") {
  return {
    id: "daily-" + date,
    date,
    mode: "daily",
    config: {
      label: "DAILY RUSH",
      min: 3,
      size: 4,
      seconds: 60,
      rule: "One shared board · 60 seconds",
      target: null,
      sudden: false,
      chain: false,
      adult: false,
      party: false,
    },
    board: "ABCDEFGHIJKLMNOP".split(""),
    dictionary: {
      dictionaryId: "wordrush-ca-standard-v1",
      artifactSha256: "a".repeat(64),
    },
    quality: { requestedSeed: 1, selectedCandidateSeed: 2 },
    createdAt: "2026-08-05T00:00:00.000Z",
  };
}

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-daily-"));
  return new DailyChallengeStore(path.join(directory, "daily-challenges.json"));
}

test("Daily Challenge store freezes the first successful board and reloads it", async () => {
  const store = temporaryStore();
  let generated = 0;
  const first = await store.getOrCreateDaily("2026-08-05", async () => {
    generated++;
    return fixtureRecord();
  });
  const second = await store.getOrCreateDaily("2026-08-05", async () => {
    generated++;
    return { ...fixtureRecord(), board: "PONMLKJIHGFEDCBA".split("") };
  });
  assert.equal(generated, 1);
  assert.deepEqual(second, first);

  const reloaded = new DailyChallengeStore(store.file);
  const third = await reloaded.getOrCreateDaily("2026-08-05", async () => {
    generated++;
    return fixtureRecord();
  });
  assert.equal(generated, 1);
  assert.deepEqual(third, first);
});

test("Daily Challenge shares expose only a bounded score target and expire", async () => {
  const store = temporaryStore();
  await store.getOrCreateDaily("2026-08-05", async () => fixtureRecord());
  const now = new Date("2026-08-05T12:00:00.000Z");
  const share = store.createShare({
    challengeId: "daily-2026-08-05",
    score: 241,
    wordCount: 17,
    longestLength: 8,
  }, now);
  const shared = store.getShare(share.ref, now);
  assert.deepEqual(shared.target, { score: 241, wordCount: 17, longestLength: 8 });
  assert.equal(shared.challenge.id, "daily-2026-08-05");
  assert.equal(Object.hasOwn(shared.target, "name"), false);
  assert.equal(Object.hasOwn(shared.target, "words"), false);
  assert.equal(store.getShare(share.ref, new Date(share.expiresAt)), null);
});

test("Daily Challenge date keys use valid UTC calendar dates only", () => {
  assert.equal(utcDateKey(new Date("2026-08-05T23:59:59-07:00")), "2026-08-06");
  assert.equal(validDateKey("2026-02-29"), false);
  assert.equal(validDateKey("2028-02-29"), true);
  assert.equal(validDateKey("2026-8-05"), false);
});
