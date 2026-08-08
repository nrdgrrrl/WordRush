const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const catalog = require("../game-catalog");
const routes = require("../site-routes");
const { MODE_CONFIG } = require("../game-config");

const root = path.join(__dirname, "..");
const gamesRoot = path.join(root, "games");
const expectedInventory = [
  ["random-rush", "Random Rush", "challenge", null, "/games/random-rush", { solo: true, multiplayer: true, shareable: false }],
  ["daily-rush", "Daily Rush", "challenge", "daily", "/games/daily-rush", { solo: true, multiplayer: false, shareable: true }],
  ["echo-race", "Echo Race", "challenge", "daily", "/games/echo-race", { solo: true, multiplayer: false, shareable: false }],
  ["the-curse", "The Curse", "preset", "curse", "/games/the-curse", { solo: true, multiplayer: true, shareable: false }],
  ["bounty-tiles", "Bounty Tiles", "preset", "bounty", "/games/bounty-tiles", { solo: true, multiplayer: true, shareable: false }],
  ["room-heist", "Room Heist", "multiplayer", "heist", "/games/room-heist", { solo: false, multiplayer: true, shareable: false }],
  ["word-relay", "Word Relay", "challenge", null, "/games/word-relay", { solo: true, multiplayer: false, shareable: true }],
  ["party-mode", "Party Mode", "builder", null, "/games/party-mode", { solo: true, multiplayer: true, shareable: false }],
  ["classic", "Classic", "preset", "classic", "/games/classic", { solo: true, multiplayer: true, shareable: false }],
  ["sudden-death", "Sudden Death", "preset", "sudden", "/games/sudden-death", { solo: true, multiplayer: true, shareable: false }],
  ["sudden-death-series", "Sudden Death Series", "multiplayer", "sudden_series", "/games/sudden-death-series", { solo: false, multiplayer: true, shareable: false }],
  ["co-op", "Co-op", "multiplayer", "coop", null, { solo: false, multiplayer: true, shareable: false }],
  ["dirty-mode", "Dirty Mode", "preset", "dirty", "/games/dirty", { solo: true, multiplayer: true, shareable: false }],
  ["race-to-500", "Race to 500", "preset", "race", "/games/race", { solo: true, multiplayer: true, shareable: false }],
  ["word-stretch", "Word Stretch", "preset", "minimum", "/games/minimum-word", { solo: true, multiplayer: true, shareable: false }],
  ["blitz", "Blitz", "preset", "blitz", "/games/blitz", { solo: true, multiplayer: true, shareable: false }],
  ["long-haul", "Long Haul", "preset", "longhaul", "/games/long-haul", { solo: true, multiplayer: true, shareable: false }],
  ["letter-storm", "Letter Storm", "preset", "storm", "/games/letter-storm", { solo: true, multiplayer: true, shareable: false }],
  ["score-attack", "Score Attack", "preset", "scoreattack", "/games/score-attack", { solo: true, multiplayer: true, shareable: false }],
  ["word-chain", "Word Chain", "preset", "chain", "/games/word-chain", { solo: true, multiplayer: true, shareable: false }],
  ["custom-game", "Custom Game", "builder", null, "/games/custom", { solo: true, multiplayer: true, shareable: false }],
];
const expectedRouteTitles = Object.freeze({
  "random-rush": "Random Rush — A New Word Game Every Round | Wordrush",
  "daily-rush": "Daily Rush — Play Today’s Word Game | Wordrush",
  "echo-race": "Echo Race — Replay Your Daily Wordrush Challenge",
  "the-curse": "The Curse — Wordrush Frozen-Tile Word Game",
  "bounty-tiles": "Bounty Tiles — Hunt Bonus Letters | Wordrush",
  "room-heist": "Room Heist — Multiplayer Word Game | Wordrush",
  "word-relay": "Word Relay — Share a Wordrush Board With Friends",
  "party-mode": "Party Mode — Build a Wordrush Game Together",
  "custom-game": "Custom Game — Build Your Wordrush Round",
  classic: "Classic — Two Minutes of Word Joy | Wordrush",
  "sudden-death": "Sudden Death — One Mistake Ends the Round | Wordrush",
  "sudden-death-series": "Sudden Death Series — Multiplayer Wordrush",
  "dirty-mode": "Dirty Mode — Wordrush After Dark",
  "race-to-500": "Race to 500 — First to 500 Points | Wordrush",
  "word-stretch": "Word Stretch — Big-Word Wordrush Challenge",
  blitz: "Blitz — A Lightning-Fast Wordrush Game",
  "long-haul": "Long Haul — Big Words Only | Wordrush",
  "letter-storm": "Letter Storm — Hunt an 8×8 Wordrush Board",
  "score-attack": "Score Attack — Race to 250 Points | Wordrush",
  "word-chain": "Word Chain — Link Every Word | Wordrush",
});

function gameFor(key) {
  const game = catalog.byKey(key);
  assert.ok(game, key);
  return game;
}

function cardName(source, attribute, value) {
  const match = source.match(new RegExp(`${attribute}="${value}"[\\s\\S]*?<strong>([^<]+)</strong>`));
  assert.ok(match, `${attribute}=${value}`);
  return match[1];
}

function fixture(key, overrides = {}) {
  return {
    key,
    name: "Game " + key[0].toUpperCase() + key.slice(1),
    tagline: "A focused discovery tagline.",
    route: "/games/" + key,
    mechanicsKey: null,
    kind: "challenge",
    availability: { solo: true, multiplayer: false, shareable: false },
    ...overrides,
  };
}

function withTemporaryCatalog(entries, action) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-game-catalog-"));
  try {
    for (const [folder, manifest] of entries) {
      const directory = path.join(temporaryRoot, folder);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    }
    return action(temporaryRoot);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test("canonical catalog represents the audited 21-game public inventory", () => {
  assert.equal(catalog.all.length, 21);
  assert.equal(Object.isFrozen(catalog.all), true);
  assert.equal(new Set(catalog.all.map((game) => game.key)).size, 21);
  assert.equal(new Set(catalog.all.map((game) => game.name)).size, 21);
  for (const [key, name, kind, mechanicsKey, route, availability] of expectedInventory) {
    assert.deepEqual(gameFor(key), { key, name, tagline: gameFor(key).tagline, route, mechanicsKey, kind, availability });
    assert.equal(Object.isFrozen(gameFor(key)), true);
    assert.equal(Object.isFrozen(gameFor(key).availability), true);
  }
});

test("manifests use the small identity schema without duplicating mechanics", () => {
  const expectedFields = ["availability", "key", "kind", "mechanicsKey", "name", "route", "tagline"];
  const mechanicsFields = new Set([
    "size", "seconds", "min", "minimum", "target", "sudden", "chain", "adult", "party", "rule",
  ]);
  const folders = fs.readdirSync(gamesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(folders, catalog.all.map((game) => game.key));
  for (const folder of folders) {
    const manifest = JSON.parse(fs.readFileSync(path.join(gamesRoot, folder, "manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest).sort(), expectedFields, folder);
    assert.equal(manifest.key, folder, folder);
    for (const field of mechanicsFields)
      assert.equal(Object.hasOwn(manifest, field), false, `${folder} duplicates ${field}`);
  }
});

test("catalog loader fails closed for malformed or duplicate manifests", () => {
  assert.throws(
    () => withTemporaryCatalog([["alpha", fixture("alpha", { name: "not a public name" })]], catalog.loadCatalog),
    /name must be a trimmed public display name/,
  );
  assert.throws(
    () => withTemporaryCatalog([["alpha", fixture("alpha", { route: "/not-a-game-route" })]], catalog.loadCatalog),
    /route must be a \/games\/<slug> path or null/,
  );
  assert.throws(
    () => withTemporaryCatalog([["alpha", fixture("alpha", { mechanicsKey: "missing_mode" })]], catalog.loadCatalog),
    /mechanicsKey must exist in MODE_CONFIG \(missing_mode\)/,
  );
  assert.throws(
    () => withTemporaryCatalog([
      ["alpha", fixture("alpha")],
      ["beta", fixture("alpha", { name: "Game Beta", route: "/games/beta" })],
    ], catalog.loadCatalog),
    /duplicate catalog key alpha/,
  );
  assert.throws(
    () => withTemporaryCatalog([
      ["alpha", fixture("alpha")],
      ["beta", fixture("beta", { route: "/games/alpha" })],
    ], catalog.loadCatalog),
    /duplicate public route \/games\/alpha/,
  );
  assert.throws(
    () => withTemporaryCatalog([
      ["alpha", fixture("alpha")],
      ["beta", fixture("beta", { name: "Game Alpha" })],
    ], catalog.loadCatalog),
    /duplicate public name Game Alpha/,
  );
  assert.throws(
    () => withTemporaryCatalog([["alpha", fixture("alpha", {
      availability: { solo: false, multiplayer: false, shareable: false },
    })]], catalog.loadCatalog),
    /must be available solo or multiplayer/,
  );
});

test("mechanics associations are real and wrapper or builder identities remain truthful", () => {
  for (const game of catalog.all.filter((entry) => entry.mechanicsKey !== null))
    assert.ok(MODE_CONFIG[game.mechanicsKey], `${game.key} maps to MODE_CONFIG`);
  for (const key of ["random-rush", "word-relay", "party-mode", "custom-game"])
    assert.equal(gameFor(key).mechanicsKey, null, key);
  assert.equal(catalog.byMechanicsKey("daily"), null, "Daily Rush and Echo Race share a config association");
  assert.equal(catalog.byMechanicsKey("minimum")?.name, "Word Stretch");
  assert.equal(catalog.byMechanicsKey("race")?.name, "Race to 500");
  assert.equal(gameFor("word-stretch").route, "/games/minimum-word");
  assert.equal(gameFor("race-to-500").route, "/games/race");
  assert.equal(gameFor("co-op").route, null);
});

test("site routes consume catalog identity and every catalog game route resolves", () => {
  assert.equal(routes.catalog, catalog);
  assert.deepEqual(
    Object.keys(expectedRouteTitles).sort(),
    catalog.all.filter((game) => game.route !== null).map((game) => game.key).sort(),
  );
  for (const game of catalog.all.filter((entry) => entry.route !== null)) {
    const route = routes.routeForPath(game.route);
    assert.ok(route, game.route);
    assert.equal(route.kind, "game", game.route);
    assert.equal(route.catalogKey, game.key, game.route);
    assert.equal(route.path, game.route, game.route);
    assert.equal(route.description, game.tagline, game.route);
    assert.equal(route.title, expectedRouteTitles[game.key], game.route);
  }
  assert.equal(routes.routeForPath("/games/minimum-word").catalogKey, "word-stretch");
  assert.equal(routes.routeForPath("/games/race").catalogKey, "race-to-500");
  assert.equal(routes.routeForMode("minimum")?.path, "/games/minimum-word");
  assert.equal(routes.routeForMode("race")?.path, "/games/race");
  assert.equal(routes.routeForMode("daily"), null);
  assert.equal(
    routes.routeForMode("daily", { catalogKey: "daily-rush" })?.path,
    "/games/daily-rush",
  );
  assert.equal(
    routes.routeForMode("daily", { catalogKey: "echo-race" })?.path,
    "/games/echo-race",
  );
  assert.equal(routes.routeForMode("daily", { catalogKey: "classic" }), null);
  assert.equal(routes.routeForMode("coop"), null);
});

test("Home cards and the multiplayer selector retain canonical player-facing names", () => {
  const home = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const homeCards = [
    ["random-rush", "id", "randomPanel"],
    ["daily-rush", "id", "dailyRush"],
    ["echo-race", "id", "echoRace"],
    ["the-curse", "data-mode", "curse"],
    ["bounty-tiles", "data-mode", "bounty"],
    ["room-heist", "data-mode", "heist"],
    ["word-relay", "id", "wordRelay"],
    ["party-mode", "id", "partyMode"],
    ["classic", "data-mode", "classic"],
    ["sudden-death", "data-mode", "sudden"],
    ["dirty-mode", "data-mode", "dirty"],
    ["race-to-500", "data-mode", "race"],
    ["word-stretch", "data-mode", "minimum"],
    ["blitz", "data-mode", "blitz"],
    ["long-haul", "data-mode", "longhaul"],
    ["letter-storm", "data-mode", "storm"],
    ["score-attack", "data-mode", "scoreattack"],
    ["word-chain", "data-mode", "chain"],
    ["custom-game", "id", "customGame"],
  ];
  assert.deepEqual(
    homeCards.map(([key]) => key).sort(),
    catalog.all
      .filter((game) => !["co-op", "sudden-death-series"].includes(game.key))
      .map((game) => game.key)
      .sort(),
  );
  for (const [key, attribute, value] of homeCards)
    assert.equal(cardName(home, attribute, value), gameFor(key).name, key);

  const select = home.match(/<select id="sessionType">([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select);
  const options = [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
    .map(([, value, name]) => [value, name]);
  assert.deepEqual(options, [
    ["classic", gameFor("classic").name],
    ["minimum", gameFor("word-stretch").name],
    ["sudden", gameFor("sudden-death").name],
    ["sudden_series", gameFor("sudden-death-series").name],
    ["heist", gameFor("room-heist").name],
    ["race", gameFor("race-to-500").name],
    ["coop", gameFor("co-op").name],
    ["dirty", gameFor("dirty-mode").name],
    ["random", gameFor("random-rush").name],
  ]);
});

test("Game Modes, How to Play, and the sitemap stay aligned with catalog discovery", () => {
  const gameModes = fs.readFileSync(path.join(root, "content-pages", "game-modes.html"), "utf8");
  const howToPlay = fs.readFileSync(path.join(root, "content-pages", "how-to-play.html"), "utf8");
  const sitemap = fs.readFileSync(path.join(root, "sitemap.xml"), "utf8");
  const modeNames = [...gameModes.matchAll(/<h3>([^<]+)<\/h3>/g)].map((match) => match[1]);
  assert.deepEqual(modeNames.sort(), catalog.all.map((game) => game.name).sort());

  const gameModeRoutes = [...gameModes.matchAll(/class="mode-overview-play" href="([^"]+)"/g)]
    .map((match) => match[1])
    .sort();
  const catalogRoutes = catalog.all.filter((game) => game.route !== null).map((game) => game.route).sort();
  assert.deepEqual(gameModeRoutes, catalogRoutes);
  assert.doesNotMatch(gameModes, /<h3>Co-op<\/h3>[\s\S]*?mode-overview-play/);

  for (const [, href, name] of howToPlay.matchAll(/href="(\/games\/[^\"]+)">([^<]+)<\/a>/g)) {
    const game = catalog.byRoute(href);
    assert.ok(game, href);
    assert.equal(name, game.name, href);
  }

  const sitemapRoutes = [...sitemap.matchAll(/<loc>https:\/\/wordrush\.party(\/games\/[^<]+)<\/loc>/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(sitemapRoutes, catalogRoutes);
  assert.equal(catalog.byRoute("/games/co-op"), null);
});

test("the browser catalog is a synchronous frozen projection of the validated manifests", () => {
  const context = { globalThis: {} };
  vm.runInNewContext(catalog.renderBrowserCatalogScript(), context);
  const browserCatalog = context.globalThis.WordrushGameCatalog;
  assert.equal(Object.isFrozen(browserCatalog), true);
  assert.equal(Object.isFrozen(browserCatalog.all), true);
  assert.deepEqual(JSON.parse(JSON.stringify(browserCatalog.all)), catalog.all);
  assert.equal(browserCatalog.byRoute("/games/minimum-word")?.name, "Word Stretch");
  assert.equal(browserCatalog.byMechanicsKey("race")?.name, "Race to 500");
});
