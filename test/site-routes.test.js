const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const routes = require("../site-routes");

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
