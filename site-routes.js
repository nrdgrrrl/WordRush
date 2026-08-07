(function exposeWordrushRoutes(root, factory) {
  const routes = factory();
  if (typeof module === "object" && module.exports) module.exports = routes;
  else root.WordrushRoutes = routes;
})(globalThis, () => {
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
      screen: "gameModesScreen",
      contentPage: "game-modes",
      title: "WordRush Game Modes — Find Your Next Game",
      description:
        "Explore WordRush game modes, from solo word challenges to multiplayer games with friends.",
    },
    howToPlay: {
      kind: "page",
      key: "howToPlay",
      path: "/how-to-play",
      screen: "howToPlayScreen",
      contentPage: "how-to-play",
      title: "How to Play WordRush — Rules and Scoring",
      description:
        "Learn how to trace words, score points, and play solo or multiplayer in WordRush.",
    },
  };
  const GAMES = {
    random: {
      kind: "game",
      key: "random",
      path: "/games/random-rush",
      launcher: "random",
      title: "Random Rush — A New Word Game Every Round | Wordrush",
      description:
        "Play Random Rush on Wordrush and get a fresh word game, grid, and rule every round.",
    },
    daily: {
      kind: "game",
      key: "daily",
      mode: "daily",
      path: "/games/daily-rush",
      launcher: "daily",
      title: "Daily Rush — Play Today’s Word Game | Wordrush",
      description:
        "Play the daily Wordrush word game on one shared board and challenge your friends.",
    },
    echo: {
      kind: "game",
      key: "echo",
      mode: "daily",
      path: "/games/echo-race",
      launcher: "echo",
      title: "Echo Race — Replay Your Daily Wordrush Challenge",
      description:
        "Race your previous Daily Rush score in Echo Race, a timed Wordrush word game.",
    },
    curse: {
      kind: "game",
      key: "curse",
      mode: "curse",
      path: "/games/the-curse",
      title: "The Curse — Wordrush Frozen-Tile Word Game",
      description:
        "Play The Curse, a Wordrush word game where every word closes a path on the board.",
    },
    bounty: {
      kind: "game",
      key: "bounty",
      mode: "bounty",
      path: "/games/bounty-tiles",
      title: "Bounty Tiles — Hunt Bonus Letters | Wordrush",
      description:
        "Hunt charged letters and claim bonus paths in the Bounty Tiles word game.",
    },
    heist: {
      kind: "game",
      key: "heist",
      mode: "heist",
      path: "/games/room-heist",
      launcher: "multiplayer",
      title: "Room Heist — Multiplayer Word Game | Wordrush",
      description:
        "Team up, steal long-word claims, and win the Room Heist multiplayer word game.",
    },
    relay: {
      kind: "game",
      key: "relay",
      mode: "relay",
      path: "/games/word-relay",
      launcher: "relay",
      title: "Word Relay — Share a Wordrush Board With Friends",
      description:
        "Pass one frozen Wordrush board from player to player in Word Relay.",
    },
    party: {
      kind: "game",
      key: "party",
      path: "/games/party-mode",
      launcher: "party",
      title: "Party Mode — Build a Wordrush Game Together",
      description:
        "Choose the grid, word length, and clock for a custom Wordrush party game.",
    },
    custom: {
      kind: "game",
      key: "custom",
      path: "/games/custom",
      launcher: "custom",
      title: "Custom Word Game — Build Your Wordrush Round",
      description:
        "Build a custom Wordrush word game with your own grid size, timer, and rules.",
    },
    classic: {
      kind: "game",
      key: "classic",
      mode: "classic",
      path: "/games/classic",
      title: "Classic — Two Minutes of Word Joy | Wordrush",
      description:
        "Play Classic, the original two-minute Wordrush word game on a 4×4 grid.",
    },
    sudden: {
      kind: "game",
      key: "sudden",
      mode: "sudden",
      path: "/games/sudden-death",
      title: "Sudden Death — One Mistake Ends the Round | Wordrush",
      description:
        "Play Sudden Death in Wordrush, where one invalid word ends the round.",
    },
    suddenSeries: {
      kind: "game",
      key: "suddenSeries",
      mode: "sudden_series",
      path: "/games/sudden-death-series",
      launcher: "multiplayer",
      title: "Sudden Death Series — Multiplayer Wordrush",
      description:
        "Play a fast Sudden Death Series of multiplayer Wordrush micro-rounds.",
    },
    dirty: {
      kind: "game",
      key: "dirty",
      mode: "dirty",
      path: "/games/dirty",
      title: "Dirty Mode — Wordrush After Dark",
      description:
        "Play Dirty Mode, Wordrush’s 18+ adult-dictionary word game.",
    },
    race: {
      kind: "game",
      key: "race",
      mode: "race",
      path: "/games/race",
      title: "Race to 500 — First to 500 Points | Wordrush",
      description:
        "Play Race to 500 and be the first to reach 500 points in Wordrush.",
    },
    minimum: {
      kind: "game",
      key: "minimum",
      mode: "minimum",
      path: "/games/minimum-word",
      title: "Word Stretch — Big-Word Wordrush Challenge",
      description:
        "Find five-letter words and longer on a bigger board in Wordrush Word Stretch.",
    },
    blitz: {
      kind: "game",
      key: "blitz",
      mode: "blitz",
      path: "/games/blitz",
      title: "Blitz — A Lightning-Fast Wordrush Game",
      description:
        "Find as many words as possible in 60 seconds with Wordrush Blitz.",
    },
    longhaul: {
      kind: "game",
      key: "longhaul",
      mode: "longhaul",
      path: "/games/long-haul",
      title: "Long Haul — Big Words Only | Wordrush",
      description:
        "Take on the Wordrush Long Haul challenge and find words six letters or longer.",
    },
    storm: {
      kind: "game",
      key: "storm",
      mode: "storm",
      path: "/games/letter-storm",
      title: "Letter Storm — Hunt an 8×8 Wordrush Board",
      description:
        "Search every corner of an 8×8 grid in the Wordrush Letter Storm game.",
    },
    scoreattack: {
      kind: "game",
      key: "scoreattack",
      mode: "scoreattack",
      path: "/games/score-attack",
      title: "Score Attack — Race to 250 Points | Wordrush",
      description:
        "Race to 250 points in Wordrush Score Attack.",
    },
    chain: {
      kind: "game",
      key: "chain",
      mode: "chain",
      path: "/games/word-chain",
      title: "Word Chain — Link Every Word | Wordrush",
      description:
        "Play Word Chain, a Wordrush game where each word starts with the last letter.",
    },
  };
  const all = Object.freeze([
    PAGES.home,
    PAGES.stats,
    PAGES.progress,
    PAGES.multiplayer,
    PAGES.gameModes,
    PAGES.howToPlay,
    ...Object.values(GAMES),
  ]);
  const byPath = new Map(all.map((route) => [route.path, route]));
  const byMode = new Map(
    Object.values(GAMES)
      .filter((route) => route.mode)
      .map((route) => [route.mode, route]),
  );
  const transientPaths = new Set(["/results", "/game", "/round-intro"]);

  function routeForPath(pathname) {
    return byPath.get(pathname) || null;
  }

  function routeForMode(mode, { randomRush = false, config = null } = {}) {
    if (randomRush) return GAMES.random;
    if (config?.party) return GAMES.party;
    if (mode === "custom") return GAMES.custom;
    return byMode.get(mode) || null;
  }

  function seoForPath(pathname) {
    return routeForPath(pathname) || HOME;
  }

  const contentPages = new Map(
    Object.values(PAGES)
      .filter((route) => route.contentPage)
      .map((route) => [route.path, route.contentPage]),
  );

  return Object.freeze({
    HOME,
    PAGES: Object.freeze(PAGES),
    GAMES: Object.freeze(GAMES),
    all,
    transientPaths,
    routeForPath,
    routeForMode,
    seoForPath,
    contentPages,
  });
});
