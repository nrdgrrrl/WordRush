const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const routes = require("../site-routes");
const { MODE_CONFIG } = require("../game-config");

test("how-to-play is a distinct public route with its own SEO metadata", () => {
  const route = routes.routeForPath("/how-to-play");

  assert.ok(route);
  assert.equal(route.kind, "page");
  assert.equal(route.key, "howToPlay");
  assert.equal(route.screen, "howToPlayScreen");
  assert.equal(route.title, "How to Play WordRush — Rules and Scoring");
  assert.equal(
    route.description,
    "Learn how to trace words, score points, and play solo or multiplayer in WordRush.",
  );
  assert.notEqual(routes.seoForPath("/how-to-play"), routes.HOME);
  assert.equal(routes.seoForPath("/how-to-play").path, "/how-to-play");
});

test("sitemap includes the how-to-play route", () => {
  const sitemap = fs.readFileSync(path.join(__dirname, "..", "sitemap.xml"), "utf8");
  assert.match(sitemap, /<loc>https:\/\/wordrush\.party\/how-to-play<\/loc>/);
});

test("game-modes is a distinct public route with its own SEO metadata", () => {
  const route = routes.routeForPath("/game-modes");

  assert.ok(route);
  assert.equal(route.kind, "page");
  assert.equal(route.key, "gameModes");
  assert.equal(route.screen, "gameModesScreen");
  assert.equal(route.title, "WordRush Game Modes — Find Your Next Game");
  assert.equal(
    route.description,
    "Explore WordRush game modes, from solo word challenges to multiplayer games with friends.",
  );
  assert.notEqual(routes.seoForPath("/game-modes"), routes.HOME);
  assert.equal(routes.seoForPath("/game-modes").path, "/game-modes");
});

test("game-modes is in the sitemap and cross-linked with how-to-play", () => {
  const sitemap = fs.readFileSync(path.join(__dirname, "..", "sitemap.xml"), "utf8");
  const index = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const footer = fs.readFileSync(path.join(__dirname, "..", "site-footer.html"), "utf8");

  assert.match(sitemap, /<loc>https:\/\/wordrush\.party\/game-modes<\/loc>/);
  assert.match(index, /<h1>WordRush Game Modes<\/h1>/);
  assert.match(index, /href="\/how-to-play">How to Play<\/a>/);
  assert.match(index, /href="\/game-modes">WordRush Game Modes<\/a>/);
  assert.match(footer, /href="\/how-to-play">How to play<\/a>/);
  assert.match(footer, /href="\/game-modes">Game modes<\/a>/);
});

test("every direct Game Modes play link is a known game route", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const directPaths = [...index.matchAll(
    /class="mode-overview-play" href="([^"]+)"/g,
  )].map((match) => match[1]);

  assert.deepEqual(directPaths, [
    "/games/classic",
    "/games/blitz",
    "/games/race",
    "/games/minimum-word",
    "/games/long-haul",
    "/games/letter-storm",
    "/games/score-attack",
    "/games/random-rush",
    "/games/sudden-death",
    "/games/word-chain",
    "/games/the-curse",
    "/games/bounty-tiles",
    "/games/dirty",
    "/games/daily-rush",
    "/games/echo-race",
    "/games/word-relay",
    "/games/party-mode",
    "/games/custom",
    "/games/room-heist",
    "/games/sudden-death-series",
  ]);
  for (const directPath of directPaths) {
    const route = routes.routeForPath(directPath);
    assert.ok(route, directPath);
    assert.equal(route.kind, "game", directPath);
    assert.notEqual(routes.seoForPath(directPath), routes.HOME, directPath);
  }
  assert.doesNotMatch(index, /<h3>Co-op<\/h3>[\s\S]*?mode-overview-play/);
});

test("approved public names align without changing their route paths", () => {
  assert.equal(MODE_CONFIG.minimum.label, "WORD STRETCH");
  assert.equal(MODE_CONFIG.race.label, "RACE TO 500");
  assert.equal(routes.GAMES.minimum.path, "/games/minimum-word");
  assert.equal(routes.GAMES.race.path, "/games/race");
  assert.match(routes.GAMES.minimum.title, /Word Stretch/);
  assert.match(routes.GAMES.race.title, /Race to 500/);
});
