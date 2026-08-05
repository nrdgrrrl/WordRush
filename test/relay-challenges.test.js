const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MAX_STATE_BYTES,
  RelayChallengeStore,
} = require("../relay-challenges");

function fixtureInput(state = { turns: [] }) {
  return {
    board: "ABCDEFGHIJKLMNOP".split(""),
    config: {
      label: "WORD RELAY",
      min: 3,
      size: 4,
      seconds: 60,
      rule: "Pass the final letter onward",
      target: null,
      sudden: false,
      chain: true,
      adult: false,
      party: false,
    },
    dictionary: {
      dictionaryId: "wordrush-ca-standard-v1",
      artifactSha256: "a".repeat(64),
    },
    state,
  };
}

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-relay-"));
  return new RelayChallengeStore(path.join(directory, "relay-challenges.json"));
}

test("Relay challenge rejects a stale revision without applying its transition", async () => {
  const store = temporaryStore();
  const challenge = await store.create(fixtureInput());
  const first = await store.transition(challenge.id, 0, (state) => ({
    ...state,
    turns: [...state.turns, "CAT"],
  }));
  assert.equal(first.revision, 1);
  await assert.rejects(
    store.transition(challenge.id, 0, () => ({ turns: ["DOG"] })),
    /RELAY_CHALLENGE_STALE_REVISION/,
  );
  assert.deepEqual(store.get(challenge.id).state, { turns: ["CAT"] });
});

test("Relay transition cannot replace its frozen board, config, or dictionary identity", async () => {
  const store = temporaryStore();
  const challenge = await store.create(fixtureInput());
  const updated = await store.transition(challenge.id, 0, (state, record) => {
    assert.equal(Object.isFrozen(record.board), true);
    assert.equal(Object.isFrozen(record.config), true);
    assert.equal(Object.isFrozen(record.dictionary), true);
    return { ...state, nextLetter: record.board[15] };
  });
  assert.deepEqual(updated.board, challenge.board);
  assert.deepEqual(updated.config, challenge.config);
  assert.deepEqual(updated.dictionary, challenge.dictionary);
  assert.equal(updated.state.nextLetter, "P");
});

test("Relay challenge state survives an atomic persistence reload", async () => {
  const store = temporaryStore();
  const created = await store.create(fixtureInput({ turns: ["CAT"] }));
  await store.transition(created.id, 0, (state) => ({
    ...state,
    turns: [...state.turns, "TACO"],
  }));
  const reloaded = new RelayChallengeStore(store.file);
  const stored = reloaded.get(created.id);
  assert.equal(stored.revision, 1);
  assert.deepEqual(stored.state, { turns: ["CAT", "TACO"] });
});

test("Relay challenge bounds input state and expiry", async () => {
  const store = temporaryStore();
  await assert.rejects(
    store.create(fixtureInput({ text: "x".repeat(MAX_STATE_BYTES + 1) })),
    /RELAY_CHALLENGE_INVALID/,
  );
  await assert.rejects(
    store.create({ ...fixtureInput(), ttlMs: 7 * 24 * 60 * 60 * 1000 + 1 }),
    /RELAY_CHALLENGE_INVALID/,
  );
  const now = new Date("2026-08-05T12:00:00.000Z");
  const shortLived = await store.create({ ...fixtureInput(), ttlMs: 1_000 }, now);
  assert.equal(store.get(shortLived.id, new Date(now.valueOf() + 1_000)), null);
});
