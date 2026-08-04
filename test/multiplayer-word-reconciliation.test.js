const test = require("node:test");
const assert = require("node:assert/strict");
const {
  recordLocalAcceptedWord,
  reconcileAcceptedWords,
  wordStatsDelta,
} = require("../multiplayer-word-reconciliation");
const {
  describeSeat,
  summarizeSeats,
} = require("../multiplayer-player-presentation");

test("reconnecting seats remain retained while connected counts exclude them", () => {
  const seats = [
    { id: "host", connected: true },
    { id: "guest", connected: false },
    { id: "legacy" },
  ];
  assert.deepEqual(summarizeSeats(seats), {
    connectedCount: 2,
    retainedCount: 3,
    reconnectingCount: 1,
  });
  assert.deepEqual(describeSeat(seats[1]), {
    connected: false,
    status: "Reconnecting",
  });
});

test("final ranking reconciles only accepted words missed live", () => {
  const live = recordLocalAcceptedWord([], "round-1", "CAT");
  const reconciled = reconcileAcceptedWords(live.records, "round-1", [
    { word: "CAT" },
    { word: "DOG" },
  ]);
  assert.deepEqual(reconciled.missingWords, ["DOG"]);
  assert.deepEqual(reconciled.records, [{ roundId: "round-1", words: ["CAT", "DOG"] }]);
  assert.deepEqual(wordStatsDelta(reconciled.missingWords), {
    words: 1,
    correct: 1,
    totalWordLength: 3,
    longest: 3,
  });
});

test("complete live delivery and duplicate final delivery do not reconcile twice", () => {
  const first = recordLocalAcceptedWord([], "round-1", "CAT");
  const second = recordLocalAcceptedWord(first.records, "round-1", "DOG");
  const final = [{ word: "CAT" }, { word: "DOG" }];
  const reconciled = reconcileAcceptedWords(second.records, "round-1", final);
  const duplicate = reconcileAcceptedWords(reconciled.records, "round-1", final);
  assert.deepEqual(reconciled.missingWords, []);
  assert.deepEqual(duplicate.missingWords, []);
});
