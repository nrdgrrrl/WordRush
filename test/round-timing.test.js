const test = require("node:test");
const assert = require("node:assert/strict");
const {
  authoritativeGameplaySeconds,
  elapsedGameplaySeconds,
  startGameplay,
} = require("../round-timing");

test("solo timing stays inactive through intro and starts the full configured duration at gameplay", () => {
  const intro = { startedAt: 0, endsAt: 0, accepting: false };
  assert.equal(elapsedGameplaySeconds(intro.startedAt, 4_000, 120), 0);

  Object.assign(intro, startGameplay(10_000, 120), { accepting: true });
  assert.deepEqual(intro, {
    startedAt: 10_000,
    endsAt: 130_000,
    accepting: true,
  });
  assert.equal(elapsedGameplaySeconds(intro.startedAt, 10_000, 120), 0);
  assert.equal(elapsedGameplaySeconds(intro.startedAt, 130_000, 120), 120);
});

test("skipping the intro uses the exact gameplay-start boundary", () => {
  const timing = startGameplay(25_500, 30);
  assert.deepEqual(timing, { startedAt: 25_500, endsAt: 55_500 });
  assert.equal(elapsedGameplaySeconds(timing.startedAt, 25_500, 30), 0);
  assert.equal(elapsedGameplaySeconds(timing.startedAt, 26_250, 30), 0.75);
});

test("manual and delayed timeout durations stay finite, nonnegative, and bounded", () => {
  assert.equal(elapsedGameplaySeconds(50_000, 49_000, 30), 0);
  assert.equal(elapsedGameplaySeconds(50_000, 99_999, 30), 30);
  assert.equal(elapsedGameplaySeconds(50_000, Number.POSITIVE_INFINITY, 30), 0);
  assert.equal(elapsedGameplaySeconds(50_000, 50_000 + 12_345, 30), 12.345);
});

test("authoritative multiplayer duration overrides local clocks and is bounded safely", () => {
  assert.equal(authoritativeGameplaySeconds(42, 120), 42);
  assert.equal(authoritativeGameplaySeconds(999, 120), 120);
  assert.equal(authoritativeGameplaySeconds(-1, 120), 0);
  assert.equal(authoritativeGameplaySeconds("not-a-duration", 120), 0);
  assert.equal(authoritativeGameplaySeconds(42), 42);
});
