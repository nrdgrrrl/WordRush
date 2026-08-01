(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WordRushTraceGeometry = factory();
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  const EPSILON = 1e-9;

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

  function movementCircle(tile) {
    const edges = tileEdges(tile);
    if (!edges) return null;
    return {
      x: (edges.left + edges.right) / 2,
      y: (edges.top + edges.bottom) / 2,
      radius: Math.min(tile.width, tile.height) * 0.34,
    };
  }

  function pointInMovementRegion(point, tile) {
    const circle = movementCircle(tile);
    if (
      !circle ||
      !point ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    )
      return false;
    return Math.hypot(point.x - circle.x, point.y - circle.y) <= circle.radius;
  }

  function segmentIntersection(start, end, tile) {
    const circle = movementCircle(tile);
    if (
      !circle ||
      !start ||
      !end ||
      ![start.x, start.y, end.x, end.y].every(Number.isFinite)
    )
      return null;
    const dx = end.x - start.x,
      dy = end.y - start.y,
      a = dx * dx + dy * dy;
    if (a <= 0) return null;
    const offsetX = start.x - circle.x,
      offsetY = start.y - circle.y,
      b = 2 * (offsetX * dx + offsetY * dy),
      c = offsetX * offsetX + offsetY * offsetY - circle.radius ** 2,
      discriminant = b * b - 4 * a * c;
    // A tangent has no interior interval and must not invent a tile.
    if (discriminant <= 0) return null;
    const root = Math.sqrt(discriminant),
      first = (-b - root) / (2 * a),
      second = (-b + root) / (2 * a),
      entry = Math.max(0, Math.min(first, second)),
      exit = Math.min(1, Math.max(first, second));
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

  return { applyTraceSegment, crossedTileIndices, pointInMovementRegion };
});
