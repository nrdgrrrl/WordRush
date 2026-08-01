const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeNextRound,
  normalizeResultAction,
  reconcileResultAction,
  classifyResultDelivery,
} = require("../multiplayer-result-state");

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

test("same transition refresh preserves a consumed host action", () => {
  const nextRound = {
    sourceRoundId: "round-1",
    mode: "race",
    automaticAt: 1234,
  };
  const previousAction = {
    ...normalizeResultAction({
      sourceRoundId: "round-1",
      currentRoundId: "round-1",
      nextRound,
      isCreator: true,
      configForPreset,
    }),
    consumed: true,
  };
  assert.deepEqual(
    reconcileResultAction({
      sourceRoundId: "round-1",
      currentRoundId: "round-1",
      nextRound,
      isCreator: true,
      configForPreset,
      previousAction,
    }),
    { ...previousAction },
  );
});

test("authoritative refresh without a queue restores truthful host and guest fallback", () => {
  const previousAction = {
    nextRound: {
      sourceRoundId: "round-1",
      mode: "race",
      automaticAt: 1234,
    },
    consumed: true,
  };
  for (const isCreator of [true, false]) {
    assert.deepEqual(
      reconcileResultAction({
        sourceRoundId: "round-1",
        currentRoundId: "round-1",
        nextRound: null,
        isCreator,
        configForPreset,
        previousAction,
      }),
      {
        nextRound: null,
        heading: "",
        label: isCreator ? "Play again →" : "Waiting for host…",
        disabled: !isCreator,
      },
    );
  }
});

test("changed, stale, and unknown transitions cannot inherit or retain consumption", () => {
  const previousAction = {
    nextRound: {
      sourceRoundId: "round-1",
      mode: "race",
      automaticAt: 1234,
    },
    consumed: true,
  };
  const changed = reconcileResultAction({
    sourceRoundId: "round-1",
    currentRoundId: "round-1",
    nextRound: { ...previousAction.nextRound, mode: "classic" },
    isCreator: true,
    configForPreset,
    previousAction,
  });
  assert.equal(changed.consumed, false);
  assert.equal(changed.heading, "Up next: CLASSIC");

  const stale = reconcileResultAction({
    sourceRoundId: "round-1",
    currentRoundId: "round-2",
    nextRound: previousAction.nextRound,
    isCreator: true,
    configForPreset,
    previousAction,
  });
  assert.equal(stale.nextRound, null);
  assert.equal(stale.heading, "");

  const unknown = reconcileResultAction({
    sourceRoundId: "round-1",
    currentRoundId: "round-1",
    nextRound: { ...previousAction.nextRound, mode: "unknown" },
    isCreator: true,
    configForPreset,
    previousAction,
  });
  assert.equal(unknown.nextRound, null);
  assert.equal(unknown.heading, "");
});

test("classifies live results and authoritative finished snapshots by delivery context", () => {
  assert.equal(
    classifyResultDelivery({
      localRoundId: "round-1",
      resultRoundId: "round-1",
      completed: true,
    }),
    "refresh",
  );
  assert.equal(
    classifyResultDelivery({
      localRoundId: "round-1",
      resultRoundId: "round-2",
      completed: true,
    }),
    "stale",
  );
  assert.equal(
    classifyResultDelivery({
      localRoundId: "round-1",
      resultRoundId: "round-2",
      completed: true,
      authoritativeSnapshot: true,
    }),
    "replace",
  );
  assert.equal(
    classifyResultDelivery({
      localRoundId: "round-2",
      resultRoundId: "round-2",
      completed: true,
      authoritativeSnapshot: true,
    }),
    "refresh",
  );
});

test("authoritative replacement starts with a fresh next action", () => {
  const previousAction = {
    nextRound: {
      sourceRoundId: "round-1",
      mode: "race",
      automaticAt: 1234,
    },
    consumed: true,
  };
  const replacement = reconcileResultAction({
    sourceRoundId: "round-2",
    currentRoundId: "round-2",
    nextRound: {
      sourceRoundId: "round-2",
      mode: "classic",
      automaticAt: 5678,
    },
    isCreator: true,
    configForPreset,
    previousAction,
  });
  assert.equal(replacement.consumed, false);
  assert.equal(replacement.heading, "Up next: CLASSIC");
});
