const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyTraceSegment,
  crossedTileIndices,
  pointInMovementRegion,
} = require("../trace-geometry");

function boardTiles(size, width = 40, gap = 5) {
  return Array.from({ length: size * size }, (_, index) => {
    const row = Math.floor(index / size),
      column = index % size;
    return {
      index,
      left: column * (width + gap),
      top: row * (width + gap),
      width,
      height: width,
    };
  });
}

function adjacent(size) {
  return (from, to) => {
    const fromRow = Math.floor(from / size),
      fromColumn = from % size,
      toRow = Math.floor(to / size),
      toColumn = to % size;
    return (
      Math.max(Math.abs(fromRow - toRow), Math.abs(fromColumn - toColumn)) === 1
    );
  };
}

function segment(path, start, end, tiles, size) {
  return applyTraceSegment(path, start, end, tiles, adjacent(size));
}

test("fast horizontal movement preserves every crossed tile in order", () => {
  const tiles = boardTiles(4);
  assert.deepEqual(
    segment([0], { x: 20, y: 20 }, { x: 155, y: 20 }, tiles, 4),
    [0, 1, 2, 3],
  );
});

test("fast vertical movement preserves every crossed tile in order", () => {
  const tiles = boardTiles(4);
  assert.deepEqual(
    segment([0], { x: 20, y: 20 }, { x: 20, y: 155 }, tiles, 4),
    [0, 4, 8, 12],
  );
});

test("fast diagonal movement preserves every crossed diagonal tile", () => {
  const tiles = boardTiles(4);
  assert.deepEqual(
    segment([0], { x: 20, y: 20 }, { x: 155, y: 155 }, tiles, 4),
    [0, 5, 10, 15],
  );
});

test("the final release segment preserves tiles crossed after the last move", () => {
  const tiles = boardTiles(4);
  const afterMove = segment([0], { x: 20, y: 20 }, { x: 65, y: 20 }, tiles, 4);
  assert.deepEqual(
    segment(afterMove, { x: 65, y: 20 }, { x: 155, y: 20 }, tiles, 4),
    [0, 1, 2, 3],
  );
});

test("a release at the last move coordinate does not duplicate a tile", () => {
  const tiles = boardTiles(3);
  assert.deepEqual(
    segment([0, 1], { x: 65, y: 20 }, { x: 65, y: 20 }, tiles, 3),
    [0, 1],
  );
});

test("slow movement produces the same path as one fast segment", () => {
  const tiles = boardTiles(4);
  const slow = segment(
    segment([0], { x: 20, y: 20 }, { x: 65, y: 20 }, tiles, 4),
    { x: 65, y: 20 },
    { x: 110, y: 20 },
    tiles,
    4,
  );
  assert.deepEqual(slow, segment([0], { x: 20, y: 20 }, { x: 110, y: 20 }, tiles, 4));
});

test("slow movement uses the existing conservative center-region decision", () => {
  const tile = boardTiles(1)[0];
  assert.equal(pointInMovementRegion({ x: 20, y: 20 }, tile), true);
  assert.equal(pointInMovementRegion({ x: 39, y: 39 }, tile), false);
});

test("movement through a gap does not select a nearby tile", () => {
  const tiles = boardTiles(2);
  assert.deepEqual(
    crossedTileIndices({ x: 20, y: 20 }, { x: 42, y: 20 }, tiles),
    [0],
  );
  assert.deepEqual(
    segment([0], { x: 20, y: 20 }, { x: 42, y: 20 }, tiles, 2),
    [0],
  );
});

test("a zero-width corner touch does not insert an unrelated tile", () => {
  const tiles = boardTiles(2);
  assert.deepEqual(
    crossedTileIndices({ x: 20, y: 20 }, { x: 45, y: 45 }, tiles),
    [0],
  );
});

test("a bounding-rectangle corner graze outside the movement region is ignored", () => {
  const tile = { index: 1, left: 45, top: 0, width: 40, height: 40 };
  assert.deepEqual(
    crossedTileIndices({ x: 40, y: 40 }, { x: 50, y: 30 }, [tile]),
    [],
  );
});

test("a tangent-only touch of the movement region is ignored", () => {
  const tile = { index: 1, left: 0, top: 0, width: 40, height: 40 };
  assert.deepEqual(
    crossedTileIndices({ x: 0, y: 33.6 }, { x: 40, y: 33.6 }, [tile]),
    [],
  );
});

test("a non-adjacent jump with no crossed legal tile is rejected", () => {
  const tiles = boardTiles(3);
  assert.deepEqual(
    segment([0], { x: 39, y: 39.9 }, { x: 90.1, y: 45.1 }, tiles, 3),
    [0],
  );
});

test("re-entering a selected tile cannot reuse it or bypass adjacency", () => {
  const tiles = [
    { index: 1, left: 0, top: 0, width: 40, height: 40 },
    { index: 0, left: 45, top: 0, width: 40, height: 40 },
    { index: 2, left: 90, top: 0, width: 40, height: 40 },
  ];
  assert.deepEqual(
    applyTraceSegment(
      [0, 1],
      { x: 20, y: 20 },
      { x: 110, y: 20 },
      tiles,
      (from, to) => Math.abs(from - to) === 1,
    ),
    [0, 1],
  );
});

test("a new trace starts with no prior segment state", () => {
  const tiles = boardTiles(3);
  const firstTrace = segment([0], { x: 20, y: 20 }, { x: 65, y: 20 }, tiles, 3);
  const newTrace = segment([], { x: 110, y: 20 }, { x: 110, y: 65 }, tiles, 3);
  assert.deepEqual(firstTrace, [0, 1]);
  assert.deepEqual(newTrace, []);
});
