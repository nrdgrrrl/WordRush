const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeNextRound, normalizeResultAction } = require("../multiplayer-result-state");

const configs = {
  classic: { label: "CLASSIC" },
  race: { label: "RACE MODE" },
};
const configForPreset = (mode) => configs[mode] || null;

test("normalizes only a source-matching known authoritative next round", () => {
  const nextRound = {
    sourceRoundId: "round-1",
    mode: "race",
    automaticAt: 1234,
  };
  assert.deepEqual(
    normalizeNextRound(nextRound, "round-1", configForPreset),
    nextRound,
  );
  assert.equal(normalizeNextRound(nextRound, "round-2", configForPreset), null);
  assert.equal(
    normalizeNextRound({ ...nextRound, mode: "unknown" }, "round-1", configForPreset),
    null,
  );
  assert.equal(
    normalizeNextRound({ ...nextRound, automaticAt: "later" }, "round-1", configForPreset),
    null,
  );
});

test("normalizes distinct host and guest queued actions", () => {
  const nextRound = {
    sourceRoundId: "round-1",
    mode: "race",
    automaticAt: 1234,
  };
  assert.deepEqual(
    normalizeResultAction({
      sourceRoundId: "round-1",
      currentRoundId: "round-1",
      nextRound,
      isCreator: true,
      configForPreset,
    }),
    {
      nextRound,
      heading: "Up next: RACE MODE",
      label: "Start RACE MODE now →",
      disabled: false,
    },
  );
  assert.deepEqual(
    normalizeResultAction({
      sourceRoundId: "round-1",
      currentRoundId: "round-1",
      nextRound,
      isCreator: false,
      configForPreset,
    }),
    {
      nextRound,
      heading: "Up next: RACE MODE",
      label: "Waiting for host to start RACE MODE",
      disabled: true,
    },
  );
});

test("stale or invalid result state falls back without a next-mode claim", () => {
  const result = {
    sourceRoundId: "round-1",
    currentRoundId: "round-2",
    nextRound: { sourceRoundId: "round-1", mode: "race", automaticAt: 1234 },
  };
  assert.deepEqual(
    normalizeResultAction({ ...result, isCreator: true, configForPreset }),
    {
      nextRound: null,
      heading: "",
      label: "Play again →",
      disabled: false,
    },
  );
  assert.deepEqual(
    normalizeResultAction({
      sourceRoundId: "round-1",
      currentRoundId: "round-1",
      nextRound: { sourceRoundId: "round-1", mode: "unknown", automaticAt: 1234 },
      isCreator: false,
      configForPreset,
    }),
    {
      nextRound: null,
      heading: "",
      label: "Waiting for host…",
      disabled: true,
    },
  );
});
