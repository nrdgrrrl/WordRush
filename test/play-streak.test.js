const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_PLAY_DATES,
  calculateCurrentStreak,
  localDateKey,
  normalizePlayDates,
} = require("../play-streak");

function localDate(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0);
}

const TODAY = localDate(2026, 8, 1);

test("localDateKey uses local numeric calendar fields", () => {
  assert.equal(localDateKey(localDate(2026, 8, 1)), "2026-08-01");
});

test("current streak anchors on today or yesterday", () => {
  assert.equal(calculateCurrentStreak(["2026-08-01"], TODAY), 1);
  assert.equal(calculateCurrentStreak(["2026-07-31"], TODAY), 1);
  assert.equal(
    calculateCurrentStreak(
      ["2026-08-01", "2026-07-31", "2026-07-30"],
      TODAY,
    ),
    3,
  );
  assert.equal(
    calculateCurrentStreak(
      ["2026-07-31", "2026-07-30", "2026-07-29"],
      TODAY,
    ),
    3,
  );
  assert.equal(calculateCurrentStreak(["2026-07-20", "2026-07-19"], TODAY), 0);
  assert.equal(calculateCurrentStreak(["2026-08-01", "2026-07-30"], TODAY), 1);
  assert.equal(calculateCurrentStreak(["2026-07-31", "2026-07-29"], TODAY), 1);
  assert.equal(calculateCurrentStreak([], TODAY), 0);
});

test("streak arithmetic crosses month, year, and leap-day boundaries", () => {
  assert.equal(
    calculateCurrentStreak(["2026-02-01", "2026-01-31"], localDate(2026, 2, 1)),
    2,
  );
  assert.equal(
    calculateCurrentStreak(["2026-01-01", "2025-12-31"], localDate(2026, 1, 1)),
    2,
  );
  assert.equal(
    calculateCurrentStreak(["2024-02-29", "2024-02-28"], localDate(2024, 2, 29)),
    2,
  );
  assert.equal(
    calculateCurrentStreak(["2024-03-01", "2024-02-29"], localDate(2024, 3, 1)),
    2,
  );
  assert.equal(
    calculateCurrentStreak(["2023-03-01", "2023-02-28"], localDate(2023, 3, 1)),
    2,
  );
});

test("normalization validates, deduplicates, sorts, bounds, and does not mutate", () => {
  const input = [
    "2026-08-01",
    "2026-07-31",
    "2026-08-01",
    "2026-13-01",
    "2026-00-01",
    "2026-02-00",
    "2026-02-31",
    "2025-02-29",
    "2026-8-01",
    20260801,
    null,
  ];
  const original = [...input];
  assert.deepEqual(normalizePlayDates(input), ["2026-07-31", "2026-08-01"]);
  assert.deepEqual(input, original);
  assert.deepEqual(normalizePlayDates("2026-08-01"), []);

  const manyDates = [];
  const start = localDate(2020, 1, 1);
  for (let index = 0; index < MAX_PLAY_DATES + 100; index++) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    manyDates.push(localDateKey(date));
  }
  const normalized = normalizePlayDates(manyDates);
  assert.equal(normalized.length, MAX_PLAY_DATES);
  assert.equal(normalized[0], manyDates[100]);
  assert.equal(normalized.at(-1), manyDates.at(-1));
});

test("future dates do not anchor or inflate the current streak", () => {
  assert.equal(
    calculateCurrentStreak(["2026-08-02", "2026-07-20"], TODAY),
    0,
  );
  assert.equal(
    calculateCurrentStreak(["2026-08-02", "2026-08-01"], TODAY),
    1,
  );
  assert.equal(
    calculateCurrentStreak(["2026-08-02", "2026-07-31"], TODAY),
    1,
  );
});
