(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WordRushTraceGeometry = factory();
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  const EPSILON = 1e-9;

  function axisInterval(start, end, minimum, maximum) {
    if (
      ![start, end, minimum, maximum].every(Number.isFinite) ||
      minimum >= maximum
    )
      return null;
    if (start === end)
      return start > minimum && start < maximum ? [-Infinity, Infinity] : null;
    const first = (minimum - start) / (end - start);
    const second = (maximum - start) / (end - start);
    return first < second ? [first, second] : [second, first];
  }

  function tileEdges(tile) {
    if (!tile || !Number.isFinite(tile.left) || !Number.isFinite(tile.top))
      return null;
    const width = tile.width,
      height = tile.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      return null;
    return {
      left: tile.left,
      top: tile.top,
      right: tile.left + width,
      bottom: tile.top + height,
    };
  }

  function segmentIntersection(start, end, tile) {
    const edges = tileEdges(tile);
    if (!edges) return null;
    const x = axisInterval(start.x, end.x, edges.left, edges.right);
    const y = axisInterval(start.y, end.y, edges.top, edges.bottom);
    if (!x || !y) return null;
    const entry = Math.max(0, x[0], y[0]);
    const exit = Math.min(1, x[1], y[1]);
    return exit - entry > EPSILON ? { entry, exit } : null;
  }

  function crossedTileIndices(start, end, tiles) {
    if (
      !start ||
      !end ||
      !Number.isFinite(start.x) ||
      !Number.isFinite(start.y) ||
      !Number.isFinite(end.x) ||
      !Number.isFinite(end.y) ||
      !Array.isArray(tiles)
    )
      return [];
    return tiles
      .map((tile, order) => {
        const intersection = segmentIntersection(start, end, tile);
        return intersection ? { index: tile.index, order, ...intersection } : null;
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.entry - b.entry || a.exit - b.exit || a.order - b.order,
      )
      .map(({ index }) => index);
  }

  function applyTraceSegment(path, start, end, tiles, isAdjacent) {
    const nextPath = Array.isArray(path) ? path.slice() : [];
    if (!nextPath.length || typeof isAdjacent !== "function") return nextPath;
    const selected = new Set(nextPath);
    let tail = nextPath.at(-1);
    for (const index of crossedTileIndices(start, end, tiles)) {
      if (index === tail) continue;
      if (selected.has(index) || !isAdjacent(tail, index)) break;
      nextPath.push(index);
      selected.add(index);
      tail = index;
    }
    return nextPath;
  }

  return { applyTraceSegment, crossedTileIndices };
});
