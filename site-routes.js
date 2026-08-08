(function exposeWordrushRoutes(root, factory) {
  const catalog = typeof module === "object" && module.exports
    ? require("./game-catalog")
    : root.WordrushGameCatalog;
  const routes = factory(catalog);
  if (typeof module === "object" && module.exports) module.exports = routes;
  else root.WordrushRoutes = routes;
})(globalThis, (catalog) => {
  if (!catalog) throw new Error("WordrushGameCatalog must load before site-routes.js");
  const HOME = {
    kind: "page",
    key: "home",
    path: "/",
    screen: "homeScreen",
    title: "Wordrush — Fast Online Word Game",
    description:
      "Play Wordrush, a fast online word game with solo challenges, Random Rush, and multiplayer word battles.",
  };
  const PAGES = {
    home: HOME,
    stats: {
      kind: "page",
      key: "stats",
      path: "/stats",
      screen: "statsScreen",
      title: "Wordrush Stats — Track Your Word Game Scores",
      description:
        "See your Wordrush scores, rounds played, streaks, and personal bests.",
    },
    progress: {
      kind: "page",
      key: "progress",
      path: "/progress",
      screen: "achievementsScreen",
      title: "Wordrush Progress — Unlock Word Game Achievements",
      description:
        "Track achievements and milestones as you play Wordrush word games.",
    },
    multiplayer: {
      kind: "page",
      key: "multiplayer",
      path: "/multiplayer",
      screen: "homeScreen",
      open: "multiplayer",
      title: "Wordrush Multiplayer — Play Word Games Together",
      description:
        "Create or join a Wordrush multiplayer room and play fast word games with friends.",
    },
    gameModes: {
      kind: "page",
      key: "gameModes",
      path: "/game-modes",
      content: "game-modes",
      title: "WordRush Game Modes — Find Your Next Game",
      description:
        "Explore WordRush game modes, from solo word challenges to multiplayer games with friends.",
    },
    howToPlay: {
      kind: "page",
      key: "howToPlay",
      path: "/how-to-play",
      content: "how-to-play",
      title: "How to Play WordRush — Rules and Scoring",
      description:
        "Learn how to trace words, score points, and play solo or multiplayer in WordRush.",
    },
    about: {
      kind: "page",
      key: "about",
      path: "/about",
      content: "about",
      title: "About WordRush — Fast Online Word Game",
      description:
        "Learn about WordRush, a fast browser word game with solo challenges and multiplayer games for friends.",
    },
    faq: {
      kind: "page",
      key: "faq",
      path: "/faq",
      content: "faq",
      title: "WordRush FAQ — Playing, Multiplayer, Words and More",
      description:
        "Find answers about playing WordRush, valid words, scoring, multiplayer, accounts, stats, and game modes.",
    },
  };
  // This contains only existing route-launch and title-suffix behavior. Public
  // names, descriptions, paths, mechanics keys, kinds, and availability live in
  // games/*/manifest.json and are supplied by the canonical catalog above.
  const GAME_ROUTE_RUNTIME = Object.freeze({
    "random-rush": { key: "random", launcher: "random", titleSuffix: "A New Word Game Every Round" },
    "daily-rush": { key: "daily", launcher: "daily", titleSuffix: "Play Today’s Word Game" },
    "echo-race": { key: "echo", launcher: "echo", titleSuffix: "Replay Your Daily Wordrush Challenge", brand: false },
    "the-curse": { key: "curse", titleSuffix: "Wordrush Frozen-Tile Word Game", brand: false },
    "bounty-tiles": { key: "bounty", titleSuffix: "Hunt Bonus Letters" },
    "room-heist": { key: "heist", launcher: "multiplayer", titleSuffix: "Multiplayer Word Game" },
    "word-relay": { key: "relay", mode: "relay", launcher: "relay", titleSuffix: "Share a Wordrush Board With Friends" },
    "party-mode": { key: "party", launcher: "party", titleSuffix: "Build a Wordrush Game Together" },
    "custom-game": { key: "custom", launcher: "custom", titleSuffix: "Build Your Wordrush Round" },
    classic: { key: "classic", titleSuffix: "Two Minutes of Word Joy" },
    "sudden-death": { key: "sudden", titleSuffix: "One Mistake Ends the Round" },
    "sudden-death-series": { key: "suddenSeries", launcher: "multiplayer", titleSuffix: "Multiplayer Wordrush" },
    "dirty-mode": { key: "dirty", titleSuffix: "Wordrush After Dark" },
    "race-to-500": { key: "race", titleSuffix: "First to 500 Points" },
    "word-stretch": { key: "minimum", titleSuffix: "Big-Word Wordrush Challenge" },
    blitz: { key: "blitz", titleSuffix: "A Lightning-Fast Wordrush Game" },
    "long-haul": { key: "longhaul", titleSuffix: "Big Words Only" },
    "letter-storm": { key: "storm", titleSuffix: "Hunt an 8×8 Wordrush Board" },
    "score-attack": { key: "scoreattack", titleSuffix: "Race to 250 Points" },
    "word-chain": { key: "chain", titleSuffix: "Link Every Word" },
  });

  const routeEntries = catalog.all
    .filter((game) => game.route !== null)
    .map((game) => {
      const runtime = GAME_ROUTE_RUNTIME[game.key];
      if (!runtime) throw new Error(`Missing route runtime for catalog game ${game.key}`);
      return [runtime.key, Object.freeze({
        kind: "game",
        key: runtime.key,
        catalogKey: game.key,
        ...(game.mechanicsKey === null
          ? runtime.mode ? { mode: runtime.mode } : {}
          : { mode: game.mechanicsKey }),
        path: game.route,
        ...(runtime.launcher ? { launcher: runtime.launcher } : {}),
        title: `${game.name} — ${runtime.titleSuffix}${runtime.brand === false ? "" : " | Wordrush"}`,
        description: game.tagline,
      })];
    });
  if (routeEntries.length !== Object.keys(GAME_ROUTE_RUNTIME).length)
    throw new Error("Every routed catalog game must have exactly one route runtime");
  const GAMES = Object.freeze(Object.fromEntries(routeEntries));
  const gamesByCatalogKey = new Map(
    Object.values(GAMES).map((route) => [route.catalogKey, route]),
  );
  const all = Object.freeze([
    PAGES.home,
    PAGES.stats,
    PAGES.progress,
    PAGES.multiplayer,
    PAGES.gameModes,
    PAGES.howToPlay,
    PAGES.about,
    PAGES.faq,
    ...Object.values(GAMES),
  ]);
  const byPath = new Map(all.map((route) => [route.path, route]));
  const transientPaths = new Set(["/results", "/game", "/round-intro"]);

  function routeForPath(pathname) {
    return byPath.get(pathname) || null;
  }

  function routeForMode(mode, { randomRush = false, config = null } = {}) {
    if (randomRush) return gamesByCatalogKey.get("random-rush");
    if (config?.party) return gamesByCatalogKey.get("party-mode");
    if (mode === "custom") return gamesByCatalogKey.get("custom-game");
    if (mode === "daily") return gamesByCatalogKey.get("daily-rush");
    if (mode === "relay") return gamesByCatalogKey.get("word-relay");
    const game = catalog.byMechanicsKey(mode);
    return game?.route ? gamesByCatalogKey.get(game.key) : null;
  }

  function seoForPath(pathname) {
    return routeForPath(pathname) || HOME;
  }

  return Object.freeze({
    HOME,
    PAGES: Object.freeze(PAGES),
    GAMES: Object.freeze(GAMES),
    catalog,
    all,
    transientPaths,
    routeForPath,
    routeForMode,
    seoForPath,
  });
});
