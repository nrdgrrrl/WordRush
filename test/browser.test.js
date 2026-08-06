const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const WebSocket = require("ws");
process.env.RANDOM_RUSH_DELAY = "50";
process.env.WORDRUSH_LEADERBOARD_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-browser-")),
  "leaderboard.json",
);
process.env.WORDRUSH_ANALYTICS_CONSENT_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-browser-consent-")),
  "analytics-consent.json",
);
process.env.WORDRUSH_DAILY_CHALLENGES_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-browser-daily-")),
  "daily-challenges.json",
);
const {
  MODE_CONFIG,
  RANDOM_RUSH_MODES,
  RANDOM_RUSH_EXCLUDED_MODES,
  ADULT_WORDS,
} = require("../game-config");
const { server, rooms } = require("../server");

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM ||
  "/home/victoria/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
let baseUrl;
async function startClassic(page) {
  await openGamesPanel(page);
  await page.locator('button[data-mode="classic"]').click();
  await page.waitForSelector("#customDialog[open]");
  await page.locator("#customStart").click();
  await page.locator("#introStart").click();
  await page.waitForSelector("#gameScreen.active");
}
async function openFriendsPanel(page) {
  const panel = page.locator("#friendsPanel");
  if (!(await panel.evaluate((node) => node.open)))
    await page.locator("#friendsHeading").click();
}
async function openModeGroup(page, id) {
  const panel = page.locator("#" + id);
  if (!(await panel.evaluate((node) => node.open)))
    await panel.locator(":scope > summary").click();
}
async function openGamesPanel(page) {
  await openModeGroup(page, "games");
}
async function openDailyChallenges(page) {
  await openModeGroup(page, "dailyChallenges");
}
async function startIntro(page) {
  await page.waitForFunction(() =>
    document.querySelector("#roundIntroScreen.active") ||
    document.querySelector("#gameScreen.active"),
  );
  await page.evaluate(() => document.querySelector("#introStart")?.click());
  await page.waitForSelector("#gameScreen.active");
}
async function traceWord(page, path) {
  for (const index of path) {
    const box = await page.locator(".tile").nth(index).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    if (index === path[0]) await page.mouse.down();
  }
  await page.mouse.up();
  await page.evaluate(() => Promise.resolve());
}
async function startSoloMode(page, mode) {
  await openGamesPanel(page);
  await page.locator(`[data-mode="${mode}"]`).click();
  if (mode === "classic") {
    await page.waitForSelector("#customDialog[open]");
    await page.locator("#customStart").click();
  }
  await page.waitForSelector("#roundIntroScreen.active");
  await page.locator("#introStart").click();
  await page.waitForSelector("#gameScreen.active");
}
function wordRequestWaiter(pending, waiters, word) {
  if (pending.has(word)) return Promise.resolve();
  return new Promise((resolve) => waiters.set(word, resolve));
}
async function resolveWord(pending, word, valid) {
  const route = pending.get(word);
  assert.ok(route, "deferred word-check request for " + word);
  pending.delete(word);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ valid }),
  });
}
async function failWord(pending, word) {
  const route = pending.get(word);
  assert.ok(route, "deferred word-check request for " + word);
  pending.delete(word);
  await route.abort("failed");
}
async function installBoardFixtureHook(page) {
  await page.addInitScript(() => {
    let boardCore;
    Object.defineProperty(window, "WordrushBoardCore", {
      configurable: true,
      get: () => boardCore,
      set: (nextBoardCore) => {
        const originalGenerate = nextBoardCore.generateBoardCooperatively;
        boardCore = Object.freeze({
          ...nextBoardCore,
          generateBoardCooperatively: async (size, prepared, options) => {
            let fixture = null;
            try {
              fixture = JSON.parse(sessionStorage.getItem("wordrushBrowserBoardFixture") || "null");
            } catch {}
            if (
              fixture?.size === size &&
              Array.isArray(fixture.board) &&
              fixture.board.length === size * size &&
              fixture.board.every((letter) => /^[A-Z]$/.test(letter))
            )
              return { ok: true, board: [...fixture.board] };
            return originalGenerate(size, prepared, options);
          },
        });
      },
    });
  });
}
async function resetSoloBrowserPage(page, fixture) {
  await page.evaluate((nextFixture) => {
    sessionStorage.setItem("wordrushBrowserBoardFixture", JSON.stringify(nextFixture));
    localStorage.clear();
  }, fixture);
  await page.goto(baseUrl);
  await page.evaluate(() => {
    window.__soloEvents = [];
    for (const name of ["word-accepted", "word-rejected"])
      document.addEventListener("wordrush:" + name, ({ detail }) => {
        window.__soloEvents.push({
          type: name,
          word: detail.word || null,
          reason: detail.reason || null,
          preview: document.querySelector("#preview")?.textContent || "",
          toast: document.querySelector("#toast")?.textContent || "",
        });
      });
  });
}
function wsClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + server.address().port);
    ws.once("error", reject);
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "hello", guestId: name, name }));
      const handler = (raw) => {
        if (JSON.parse(raw).type !== "hello_ack") return;
        ws.off("message", handler);
        resolve(ws);
      };
      ws.on("message", handler);
    });
  });
}
function wsNext(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for " + type)), 2000);
    const handler = (raw) => {
      const data = JSON.parse(raw);
      if (data.type === type) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(data);
      }
    };
    ws.on("message", handler);
  });
}
test.before(
  () =>
    new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        baseUrl = "http://127.0.0.1:" + server.address().port;
        resolve();
      }),
    ),
);
test.after(() => new Promise((resolve) => server.close(resolve)));

test("public routes update the URL and browser Back stays inside the app", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl + "/stats");
  await page.waitForSelector("#statsScreen.active");
  assert.equal(new URL(page.url()).pathname, "/stats");
  assert.match(await page.title(), /Wordrush Stats/);
  await page.locator('#statsScreen [data-screen="homeScreen"]').click();
  await page.waitForSelector("#homeScreen.active");
  assert.equal(new URL(page.url()).pathname, "/");

  await openGamesPanel(page);
  await page.locator('button[data-mode="blitz"]').click();
  await page.waitForSelector("#roundIntroScreen.active");
  assert.equal(new URL(page.url()).pathname, "/games/blitz");
  await page.locator("#introStart").click();
  await page.waitForSelector("#gameScreen.active");
  await page.goBack();
  await page.waitForFunction(
    () => location.pathname === "/" && document.querySelector("#homeScreen.active"),
  );
  assert.equal(await page.locator("#gameScreen.active").count(), 0);

  await page.goto(baseUrl + "/games/blitz");
  await page.waitForSelector("#roundIntroScreen.active");
  await page.locator("#introStart").click();
  await page.waitForSelector("#gameScreen.active");
  await page.goBack();
  await page.waitForFunction(
    () => location.pathname === "/" && document.querySelector("#homeScreen.active"),
  );
  await page.goto(baseUrl + "/multiplayer");
  await page.waitForSelector("#multiplayerDialog[open]");
  assert.equal(new URL(page.url()).pathname, "/multiplayer");
  await browser.close();
});

test("mobile play board stays within its available space on short screens", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  for (const viewport of [
    { width: 375, height: 667 },
    { width: 320, height: 568 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.goto(baseUrl);
    await startClassic(page);
    assert.equal(await page.locator("#chainStatus").isHidden(), true);
    const gameCopy = await page.evaluate(() => {
      const rule = document.querySelector("#ruleText").getBoundingClientRect();
      const hint = document.querySelector("#gameHint").getBoundingClientRect();
      const ruleSize = getComputedStyle(document.querySelector("#ruleText")).fontSize;
      const hintSize = getComputedStyle(document.querySelector("#gameHint")).fontSize;
      const scoreSize = getComputedStyle(document.querySelector("#gameScore")).fontSize;
      return {
        ruleTop: rule.top,
        hintTop: hint.top,
        boardBottom: document.querySelector(".board").getBoundingClientRect().bottom,
        hintBottom: hint.bottom,
        ruleSize,
        hintSize,
        scoreSize,
        menuCount: document.querySelectorAll(".game-head > b").length,
      };
    });
    assert.ok(gameCopy.ruleTop < gameCopy.hintTop);
    assert.ok(gameCopy.hintTop >= gameCopy.boardBottom);
    assert.ok(gameCopy.hintBottom > gameCopy.hintTop);
    assert.ok(parseFloat(gameCopy.ruleSize) > parseFloat(gameCopy.hintSize));
    assert.ok(parseFloat(gameCopy.ruleSize) < parseFloat(gameCopy.scoreSize));
    assert.equal(gameCopy.menuCount, 0);
    const firstTile = await page.locator(".tile").first().boundingBox();
    await page.mouse.move(firstTile.x + firstTile.width / 2, firstTile.y + firstTile.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#preview").evaluate((node) => getComputedStyle(node).opacity), "0");
    await page.mouse.up();
    await page.evaluate(() => {
      const status = document.querySelector("#chainStatus");
      const guidance = document.querySelector("#chainGuidance");
      status.hidden = false;
      guidance.hidden = false;
      guidance.textContent = "Rejected: word must start with the required letter.";
    });
    const bounds = await page.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      return {
        board: box(".board"),
        grid: box("#grid"),
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    assert.ok(bounds.board.top >= 0);
    assert.ok(bounds.board.right <= bounds.viewport.width);
    assert.ok(bounds.board.bottom <= bounds.viewport.height);
    assert.ok(bounds.board.left >= 0);
    assert.ok(bounds.grid.bottom > bounds.grid.top);
    assert.ok(Math.abs(
      bounds.grid.right - bounds.grid.left - (bounds.grid.bottom - bounds.grid.top),
    ) < 1);
    assert.ok(bounds.grid.top >= bounds.board.top);
    assert.ok(bounds.grid.right <= bounds.board.right);
    assert.ok(bounds.grid.bottom <= bounds.board.bottom);
    assert.ok(bounds.grid.left >= bounds.board.left);
    const tileGaps = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll("#grid .tile")];
      const horizontal = tiles[1].getBoundingClientRect().left -
        tiles[0].getBoundingClientRect().right;
      const vertical = tiles[4].getBoundingClientRect().top -
        tiles[0].getBoundingClientRect().bottom;
      return { horizontal, vertical };
    });
    assert.ok(Math.abs(tileGaps.horizontal - tileGaps.vertical) < 1);
    await page.close();
  }
  await browser.close();
});

test("home friends panel starts collapsed and expands on touch", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(baseUrl);

    assert.equal(await page.locator("#friendsPanel").evaluate((panel) => panel.open), false);
    assert.equal((await page.locator("#friendsHeading").textContent()).trim(), "Play with friends");
    assert.equal(await page.locator("#sessionCard").isHidden(), true);
    assert.doesNotMatch(await page.locator("#friendsPanel").textContent(), /LIVE TOGETHER/);

    const homeFlowGaps = await page.evaluate(() => {
      const selectors = [
        ".home-stats",
        "#friendsPanel",
        "#randomPanel",
        "#dailyChallenges",
        "#games",
        "nav button",
        ".site-footer",
      ];
      const boxes = selectors.map((selector) =>
        document.querySelector(selector).getBoundingClientRect(),
      );
      return boxes.slice(1).map((box, index) => Math.round(box.top - boxes[index].bottom));
    });
    assert.deepEqual(homeFlowGaps, [10, 10, 10, 10, 10, 10]);

    await page.locator("#friendsHeading").click();
    assert.equal(await page.locator("#friendsPanel").evaluate((panel) => panel.open), true);
    assert.equal(await page.locator("#sessionCard").isVisible(), true);
    assert.equal(await page.locator("#scoreboardButton").isVisible(), true);
    await page.locator("#sessionCard").click();
    await page.waitForSelector("#multiplayerDialog[open]");
    await page.locator('#multiplayerDialog button[value="cancel"]').click();

    await page.locator("#friendsHeading").click();
    assert.equal(await page.locator("#friendsPanel").evaluate((panel) => panel.open), false);
  } finally {
    await browser.close();
  }
});

test("shared footer follows colorful navigation on Home, Stats, and Progress", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(baseUrl);
    await page.waitForSelector(".site-footer");

    assert.equal(await page.locator("nav button").count(), 3);
    assert.equal(await page.locator(".home-achievements").count(), 0);
    assert.match(
      await page.locator(".site-footer").textContent(),
      /Wordrush is a fast, free online word game/,
    );

    const navTiles = await page.locator("nav button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const label = button.querySelector("small");
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          iconSize: Number.parseFloat(getComputedStyle(button).fontSize),
          labelSize: Number.parseFloat(getComputedStyle(label).fontSize),
        };
      }),
    );
    assert.ok(navTiles.every((tile) => tile.height >= 80));
    assert.ok(navTiles.every((tile) => tile.iconSize >= 25));
    assert.ok(navTiles.every((tile) => tile.labelSize >= 11));
    assert.ok(navTiles.every((tile) => Math.abs(tile.width - navTiles[0].width) < 1));
    assert.ok(Math.abs(navTiles[1].left - navTiles[0].right - 10) < 1);
    assert.ok(Math.abs(navTiles[2].left - navTiles[1].right - 10) < 1);

    const footerFollowsNav = await page.evaluate(() => {
      const nav = document.querySelector("nav").getBoundingClientRect();
      const footer = document.querySelector(".site-footer").getBoundingClientRect();
      return footer.top >= nav.bottom;
    });
    assert.equal(footerFollowsNav, true);

    for (const screen of ["statsScreen", "achievementsScreen"]) {
      await page.locator(`nav button[data-screen="${screen}"]`).click();
      await page.waitForSelector(`#${screen}.active`);
      assert.equal(await page.locator(".site-footer").isVisible(), true);
    }
  } finally {
    await browser.close();
  }
});

test("Random Rush leads grouped daily challenges and games", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(baseUrl);
    assert.equal(
      await page.locator(".game-mode-stack > :first-child").getAttribute("id"),
      "randomPanel",
    );
    assert.equal(await page.locator("#randomPreview").textContent(), "Different game every round");
    assert.match(await page.locator("#randomPreviewSub").textContent(), /Random modes/);
    assert.equal(await page.locator("#dailyChallenges").evaluate((node) => node.open), false);
    assert.equal(await page.locator("#games").evaluate((node) => node.open), false);
    assert.equal(await page.locator("#dailyRush").isHidden(), true);
    assert.equal(await page.locator('[data-mode="classic"]').isHidden(), true);

    await page.locator("#dailyChallenges > summary").click();
    assert.equal(await page.locator("#dailyChallenges").evaluate((node) => node.open), true);
    assert.equal(await page.locator("#dailyRush").isVisible(), true);
    assert.equal(await page.locator('[data-mode="classic"]').isHidden(), true);
    await page.locator("#dailyChallenges > summary").click();
    assert.equal(await page.locator("#dailyChallenges").evaluate((node) => node.open), false);

    await page.locator("#games > summary").click();
    assert.equal(await page.locator("#games").evaluate((node) => node.open), true);
    assert.equal(await page.locator("#partyMode").isVisible(), true);
    assert.equal(await page.locator("#partyMode").evaluate((node) => node.closest("details")?.id), "games");
    assert.equal(await page.locator('[data-mode="classic"]').isVisible(), true);

    const modeCards = await page.locator(".game-mode-card").evaluateAll((cards) =>
      cards.map((card) => {
        const small = card.querySelector("small");
        const strong = card.querySelector("strong");
        return {
          id: card.id || card.dataset.mode || "",
          tagline: small?.textContent.trim(),
          title: strong?.textContent.trim(),
          taglineSize: Number.parseFloat(getComputedStyle(small).fontSize),
          titleSize: Number.parseFloat(getComputedStyle(strong).fontSize),
          iconSize: Number.parseFloat(getComputedStyle(card.querySelector(":scope > span")).fontSize),
          height: card.getBoundingClientRect().height,
        };
      }),
    );
    const classicCard = modeCards.find((card) => card.id === "classic");
    assert.deepEqual(
      { tagline: classicCard.tagline, title: classicCard.title },
      { tagline: "Two minutes of word joy", title: "Classic" },
    );
    assert.ok(modeCards.every((card) => card.taglineSize < card.titleSize));
    assert.ok(modeCards.every((card) => card.iconSize >= 30 && card.height >= 88));

    const navTiles = await page.locator("nav button").evaluateAll((buttons) =>
      buttons.map((button) => ({
        text: button.textContent.trim(),
        background: getComputedStyle(button).backgroundImage,
      })),
    );
    assert.deepEqual(navTiles.map(({ text }) => text), ["Home", "Stats", "Progress"]);
    assert.match(navTiles[0].background, /assets\/nav\/home\.webp/);
    assert.match(navTiles[1].background, /assets\/nav\/stats\.webp/);
    assert.match(navTiles[2].background, /assets\/nav\/progress\.webp/);
  } finally {
    await browser.close();
  }
});

test("Daily Rush freezes one shared board without adding a results panel", async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await openDailyChallenges(page);
  await page.locator("#dailyRush").click();
  await page.waitForSelector("#roundIntroScreen.active");
  await page.locator("#introStart").click();
  await page.waitForSelector("#gameScreen.active");
  assert.equal(await page.locator(".tile").count(), 16);
  assert.equal(await page.locator("#chainStatus").isHidden(), true);
  const board = await page.locator(".tile").allTextContents();
  assert.match(await page.locator("#gameTitle").textContent(), /^Daily Rush · \d{4}-\d{2}-\d{2}$/);

  await page.locator("#endGame").click();
  await page.waitForSelector("#resultsScreen.active");
  assert.equal(await page.locator("#dailyChallengeResult").isHidden(), true);
  assert.equal(await page.locator("#again").textContent(), "Try today again →");
});

test("browser can start, play, persist stats, and use the tile-banner profile button", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await startClassic(page);
  assert.equal(
    await page
      .locator("#gameScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  assert.equal(await page.locator(".tile").count(), 16);

  const path = await page.evaluate(async () => {
    const dictionary = new Set(await (await fetch("/dictionary.json")).json());
    const prefixes = new Set();
    for (const word of dictionary)
      for (let i = 1; i < word.length; i++) prefixes.add(word.slice(0, i));
    const letters = [...document.querySelectorAll(".tile")].map(
      (tile) => tile.textContent,
    );
    const size = Math.sqrt(letters.length);
    const near = (index) => {
      const row = Math.floor(index / size),
        col = index % size,
        result = [];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr,
            c = col + dc;
          if ((dr || dc) && r >= 0 && c >= 0 && r < size && c < size)
            result.push(r * size + c);
        }
      return result;
    };
    function walk(index, word, used, trail) {
      if (word.length >= 3 && dictionary.has(word)) return { word, trail };
      if (word.length >= 8 || !prefixes.has(word)) return null;
      for (const next of near(index))
        if (!used.has(next)) {
          used.add(next);
          const found = walk(
            next,
            word + letters[next],
            used,
            trail.concat(next),
          );
          if (found) return found;
          used.delete(next);
        }
      return null;
    }
    for (let index = 0; index < letters.length; index++) {
      const found = walk(index, letters[index], new Set([index]), [index]);
      if (found) return found;
    }
    return null;
  });
  assert.ok(path);
  for (const index of path.trail) {
    const box = await page.locator(".tile").nth(index).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    if (index === path.trail[0]) await page.mouse.down();
  }
  await page.mouse.up();
  await page.waitForFunction(
    () => Number(document.querySelector("#gameScore").textContent) > 0,
  );
  assert.equal(await page.locator(".tile.word-correct").count(), path.trail.length);
  assert.equal(
    await page
      .locator(".tile.word-correct")
      .first()
      .evaluate((node) => getComputedStyle(node).animationName),
    "word-correct",
  );
  await page.locator("#endGame").click();
  await page.locator('[data-screen="homeScreen"]').last().click();
  assert.ok(Number(await page.locator("#homeWords").textContent()) > 0);
  await page.locator("#navStats").click();
  assert.equal(await page.locator("#statsGrid .stat-card").count(), 14);
  assert.equal(
    await page.locator('[data-stat="multiplayerWins"] strong').textContent(),
    "0",
  );
  assert.match(
    await page.locator('[data-stat="multiplayerWinRate"] strong').textContent(),
    /^0\.0%$/,
  );
  assert.match(
    await page.locator('[data-stat="averageWordLength"] strong').textContent(),
    /^\d+\.\d$/,
  );
  await page.locator('nav [data-screen="homeScreen"]').click();
  assert.equal(await page.locator("main > header").count(), 0);
  assert.equal(await page.locator("#themeToggle").count(), 0);
  assert.equal(await page.locator("#homeScreen .hero-art #profileButton").count(), 1);
  const heroAvatarOverlapsTile = await page.evaluate(() => {
    const avatar = document.querySelector("#profileButton")?.getBoundingClientRect();
    return [...document.querySelectorAll(".hero-art span, .hero-art b")].some((tile) => {
      const box = tile.getBoundingClientRect();
      return avatar && box.left < avatar.right && box.right > avatar.left &&
        box.top < avatar.bottom && box.bottom > avatar.top;
    });
  });
  assert.equal(heroAvatarOverlapsTile, false);
  const heroAvatarAlignment = await page.evaluate(() => {
    const avatar = document.querySelector("#profileButton").getBoundingClientRect();
    const tiles = [...document.querySelectorAll(".hero-art > span, .hero-art > b")];
    const tileCenters = tiles.map((tile) => {
      const box = tile.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    const tileCenter = tileCenters.reduce((sum, center) => sum + center, 0) / tileCenters.length;
    return {
      avatarHeight: avatar.height,
      centerDistance: Math.abs(avatar.top + avatar.height / 2 - tileCenter),
    };
  });
  assert.ok(heroAvatarAlignment.avatarHeight >= 34);
  assert.ok(heroAvatarAlignment.centerDistance < 14);
  assert.deepEqual(errors, []);
  await browser.close();
});

test("global scoreboard displays an authoritative multiplayer result and all periods", async () => {
  const host = await wsClient("browser-leaderboard-winner");
  const guest = await wsClient("browser-leaderboard-loser");
  const createdPromise = wsNext(host, "room_created");
  host.send(JSON.stringify({ type: "create_room" }));
  const created = await createdPromise;
  const joinedPromise = wsNext(guest, "joined_room");
  guest.send(JSON.stringify({ type: "join_room", code: created.code, name: "Browser Loser" }));
  await joinedPromise;
  const startedPromise = wsNext(host, "round_started");
  host.send(JSON.stringify({ type: "start_game", mode: "classic" }));
  await startedPromise;
  rooms.get(created.code).round.board = ["C", "A", "T", ...Array(13).fill("X")];
  host.send(JSON.stringify({ type: "start_round_now" }));
  const acceptedPromise = wsNext(host, "word_accepted");
  host.send(JSON.stringify({ type: "submit_word", word: "CAT", path: [0, 1, 2] }));
  await acceptedPromise;
  const finishedPromise = wsNext(host, "round_finished");
  host.send(JSON.stringify({ type: "end_round" }));
  await finishedPromise;
  host.close();
  guest.close();

  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await openFriendsPanel(page);
  await page.locator("#scoreboardButton").click();
  await page.waitForSelector("#scoreboardScreen.active");
  await page.waitForFunction(() => !document.querySelector("#scoreboardList").textContent.includes("Loading"));
  assert.equal(await page.locator(".scoreboard-row").count(), 1);
  assert.match(await page.locator(".scoreboard-row").first().textContent(), /browser-leaderboard-winner|9/);
  await page.locator(".scoreboard-row").first().click();
  await page.waitForSelector("#leaderboardProfileDialog[open]");
  assert.match(await page.locator("#leaderboardProfileBody").textContent(), /total score/);
  assert.match(await page.locator("#leaderboardProfileBody").textContent(), /1.*rounds/);
  await page.locator("#leaderboardProfileClose").click();
  for (const period of ["total", "multiplayer-wins", "multiplayer-ratio"]) {
    await page.locator(`[data-period="${period}"]`).click();
    await page.waitForFunction(() => !document.querySelector("#scoreboardList").textContent.includes("Loading"));
    assert.equal(await page.locator(".scoreboard-row").count(), 1, period);
  }
  await browser.close();
});

test("random rush owns results continuation and stops on navigation", async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.clock.install();
  await page.goto(baseUrl);
  await page.evaluate(() => {
    window.wordrushRushDelay = 5000;
    window.__rushEvents = [];
    for (const name of ["random-rush", "round-intro", "round-started", "screen-change"])
      document.addEventListener("wordrush:" + name, ({ detail }) =>
        window.__rushEvents.push({ name, ...detail }),
      );
  });
  const rushEvents = () => page.evaluate(() => window.__rushEvents);
  const countRushAction = async (action) =>
    (await rushEvents()).filter(
      (event) => event.name === "random-rush" && event.action === action,
    ).length;
  const countEvents = async (name) =>
    (await rushEvents()).filter((event) => event.name === name).length;
  const waitPastRushDelay = () => page.clock.fastForward(5100);

  await openGamesPanel(page);
  await page.locator('button[data-mode="minimum"]').click();
  await page.waitForSelector("#roundIntroScreen.active");
  const startsBeforeLeave = await countEvents("round-started");
  await page.locator('nav [data-screen="achievementsScreen"]').click();
  await page.waitForSelector("#achievementsScreen.active");
  await page.clock.fastForward(4100);
  assert.equal(await page.locator("#achievementsScreen.active").count(), 1);
  assert.equal(await page.locator("#gameScreen.active").count(), 0);
  assert.equal(await countEvents("round-started"), startsBeforeLeave);

  await page.locator('nav [data-screen="homeScreen"]').click();
  await page.waitForSelector("#homeScreen.active");
  await openGamesPanel(page);
  const introsBeforeReplacement = await countEvents("round-intro");
  await page.locator('button[data-mode="minimum"]').click();
  await page.waitForFunction(
    (count) =>
      window.__rushEvents.filter((event) => event.name === "round-intro").length ===
      count,
    introsBeforeReplacement + 1,
  );
  await page.clock.fastForward(1000);
  await openGamesPanel(page);
  await page.evaluate(() =>
    document.querySelector('button[data-mode="race"]').click(),
  );
  await page.waitForFunction(
    (count) =>
      window.__rushEvents.filter((event) => event.name === "round-intro").length ===
      count,
    introsBeforeReplacement + 2,
  );
  const startsBeforeAutomatic = await countEvents("round-started");
  await page.clock.fastForward(3100);
  assert.equal(await page.locator("#roundIntroScreen.active").count(), 1);
  assert.equal(await countEvents("round-started"), startsBeforeAutomatic);
  await page.clock.fastForward(1000);
  await page.waitForSelector("#gameScreen.active");
  assert.equal(await countEvents("round-started"), startsBeforeAutomatic + 1);
  await page.clock.fastForward(4100);
  assert.equal(await countEvents("round-started"), startsBeforeAutomatic + 1);

  await page.locator("#gameBack").click();
  await page.waitForSelector("#homeScreen.active");
  await openGamesPanel(page);
  await page.locator('button[data-mode="minimum"]').click();
  await page.waitForSelector("#roundIntroScreen.active");
  const startsBeforeStartNow = await countEvents("round-started");
  await page.locator("#introStart").click();
  await page.evaluate(() => document.querySelector("#introStart").click());
  await page.waitForSelector("#gameScreen.active");
  assert.equal(await countEvents("round-started"), startsBeforeStartNow + 1);
  await page.clock.fastForward(4100);
  assert.equal(await countEvents("round-started"), startsBeforeStartNow + 1);
  await page.locator("#gameBack").click();
  await page.waitForSelector("#homeScreen.active");

  await page.locator("#randomPanel").click();
  await startIntro(page);
  const gameActions = await page.evaluate(() => {
    const foot = document.querySelector("#gameScreen .game-foot");
    const buttons = [...foot.querySelectorAll("button:not([hidden])")];
    const boxes = buttons.map((button) => button.getBoundingClientRect());
    return {
      labels: buttons.map((button) => button.textContent.trim()),
      widths: boxes.map((box) => box.width),
      heights: boxes.map((box) => box.height),
      seriesHidden: document.querySelector("#cancelSeries").hidden,
      columns: getComputedStyle(foot).gridTemplateColumns,
    };
  });
  assert.deepEqual(gameActions.labels, ["End Rush", "End Round"]);
  assert.ok(gameActions.seriesHidden);
  assert.ok(gameActions.widths.every((width) => width >= 0));
  assert.ok(Math.max(...gameActions.widths) - Math.min(...gameActions.widths) < 1);
  assert.ok(gameActions.heights.every((height) => height >= 44));
  assert.match(gameActions.columns, /\S+\s+\S+/);
  await page.locator("#gameBack").click();
  await page.waitForSelector("#homeScreen.active");
  const backAutoAdvances = await countRushAction("auto_advance");
  await waitPastRushDelay();
  assert.equal(await countRushAction("auto_advance"), backAutoAdvances);
  assert.equal(await page.locator("#roundIntroScreen.active").count(), 0);
  assert.equal(await page.locator("#gameScreen.active").count(), 0);

  await page.locator("#randomPanel").click();
  await startIntro(page);
  await page.locator("#endGame").click();
  await page.waitForSelector("#resultsScreen.active");
  assert.equal(await page.locator("#suddenDeathCallout").isHidden(), true);
  assert.equal(await page.locator("#rushNextRound").isHidden(), false);
  assert.match(await page.locator("#rushNextRoundTitle").textContent(), /\S/);
  assert.match(
    await page.locator("#rushNextRoundCountdown").textContent(),
    /^Starts in 5s · tap to start now$/,
  );
  const nextRoundStyle = await page.locator("#rushNextRound").evaluate((node) => {
    const style = getComputedStyle(node);
    return { flexDirection: style.flexDirection, textAlign: style.textAlign };
  });
  assert.deepEqual(nextRoundStyle, { flexDirection: "column", textAlign: "center" });
  const homeAutoAdvances = await countRushAction("auto_advance");
  await page.locator('#resultsScreen [data-screen="homeScreen"]').click();
  await page.waitForSelector("#homeScreen.active");
  await waitPastRushDelay();
  assert.equal(
    await page
      .locator("#homeScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  assert.equal(await page.locator("#roundIntroScreen.active").count(), 0);
  assert.equal(await page.locator("#gameScreen.active").count(), 0);
  assert.equal(await countRushAction("auto_advance"), homeAutoAdvances);
  assert.equal(await page.locator("#stopRushResults").isHidden(), true);

  await page.locator("#randomPanel").click();
  await startIntro(page);
  await page.locator("#endGame").click();
  await page.waitForSelector("#resultsScreen.active");
  const statsAutoAdvances = await countRushAction("auto_advance");
  await page.locator("#navStats").click();
  await page.waitForSelector("#statsScreen.active");
  await waitPastRushDelay();
  assert.equal(await countRushAction("auto_advance"), statsAutoAdvances);
  assert.equal(await page.locator("#roundIntroScreen.active").count(), 0);
  assert.equal(await page.locator("#gameScreen.active").count(), 0);
  await page.locator('#statsScreen [data-screen="homeScreen"]').click();
  await page.waitForSelector("#homeScreen.active");

  await page.locator("#randomPanel").click();
  await startIntro(page);
  await page.locator("#endGame").click();
  await page.waitForSelector("#resultsScreen.active");
  const autoUpcoming = await page.locator("#rushNextRoundTitle").textContent();
  const autoAdvancesBeforeStay = await countRushAction("auto_advance");
  await page.clock.fastForward(5100);
  await page.waitForSelector("#gameScreen.active", { timeout: 2000 });
  assert.equal(await countRushAction("auto_advance"), autoAdvancesBeforeStay + 1);
  assert.equal(await page.locator("#gameMode").textContent(), autoUpcoming);
  assert.equal(await page.locator("#roundIntroScreen.active").count(), 0);

  await page.locator("#endGame").click();
  await page.waitForSelector("#resultsScreen.active");
  const continueUpcoming = await page.locator("#rushNextRoundTitle").textContent();
  const continueActionsBefore = await countRushAction("continue");
  const autoAdvancesBeforeContinueWait = await countRushAction("auto_advance");
  await page.locator("#rushNextRound").click();
  await page.waitForSelector("#gameScreen.active");
  assert.equal(await countRushAction("continue"), continueActionsBefore + 1);
  assert.equal(await page.locator("#gameMode").textContent(), continueUpcoming);
  assert.equal(await page.locator("#roundIntroScreen.active").count(), 0);
  await waitPastRushDelay();
  assert.equal(await countRushAction("auto_advance"), autoAdvancesBeforeContinueWait);

  await page.locator("#endGame").click();
  await page.waitForSelector("#resultsScreen.active");
  const stopAutoAdvances = await countRushAction("auto_advance");
  await page.locator("#stopRushResults").click();
  await page.waitForSelector("#homeScreen.active");
  await waitPastRushDelay();
  assert.equal(await countRushAction("auto_advance"), stopAutoAdvances);
  assert.equal(await page.locator("#roundIntroScreen.active").count(), 0);
  assert.equal(await page.locator("#gameScreen.active").count(), 0);

  await openGamesPanel(page);
  await page.locator('button[data-mode="minimum"]').click();
  await page.waitForSelector("#roundIntroScreen.active");
  await page.locator("#introStart").click();
  await page.waitForSelector("#gameScreen.active");
  assert.equal(await page.locator("#stopRush").isHidden(), true);
});

test("solo submission commits stay ordered across deferred dictionary responses", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pending = new Map();
  const waiters = new Map();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.route("**/api/dictionary**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        dictionary: { dictionaryId: "wordrush-ca-standard-v1", version: "browser-test" },
        words: ["BAD", "CAT", "DOG", "FOX", "MAP", "NOD", "OWL", "PIG", "RAT", "SUN"],
      }),
    }),
  );
  await page.route("**/api/word-check**", (route) => {
    const word = new URL(route.request().url()).searchParams.get("word");
    pending.set(word, route);
    waiters.get(word)?.();
    waiters.delete(word);
  });
  await installBoardFixtureHook(page);
  await page.goto(baseUrl);

  const generalFixture = {
    size: 4,
    board: ["C", "A", "T", "X", "D", "O", "G", "X", "X", "X", "X", "X", "X", "X", "X", "X"],
  };
  await resetSoloBrowserPage(page, generalFixture);
  await startSoloMode(page, "classic");
  const generalRequests = [
    wordRequestWaiter(pending, waiters, "CAT"),
    wordRequestWaiter(pending, waiters, "DOG"),
  ];
  await traceWord(page, [0, 1, 2]);
  await traceWord(page, [4, 5, 6]);
  await Promise.all(generalRequests);
  assert.deepEqual([...pending.keys()].sort(), ["CAT", "DOG"]);
  await resolveWord(pending, "DOG", false);
  assert.equal(await page.locator("#gameScore").textContent(), "0");
  await failWord(pending, "CAT");
  await page.waitForFunction(() => window.__soloEvents.length === 2);
  assert.deepEqual(
    await page.evaluate(() => window.__soloEvents.map((event) => event.type)),
    ["word-accepted", "word-rejected"],
  );
  assert.equal(await page.locator("#gameScore").textContent(), "9");
  assert.match(await page.locator("#toast").textContent(), /Wrong word/);

  const chainFixture = {
    size: 5,
    board: ["S", "U", "N", "X", "X", "N", "O", "D", ...Array(17).fill("X")],
  };
  pending.clear();
  await resetSoloBrowserPage(page, chainFixture);
  await startSoloMode(page, "chain");
  const chainRequests = [
    wordRequestWaiter(pending, waiters, "SUN"),
    wordRequestWaiter(pending, waiters, "NOD"),
  ];
  await traceWord(page, [0, 1, 2]);
  await traceWord(page, [5, 6, 7]);
  await Promise.all(chainRequests);
  await resolveWord(pending, "NOD", true);
  assert.equal(await page.locator("#gameScore").textContent(), "0");
  await resolveWord(pending, "SUN", true);
  await page.waitForFunction(() => window.__soloEvents.length === 2);
  assert.deepEqual(
    await page.evaluate(() => window.__soloEvents.map((event) => event.word)),
    ["SUN", "NOD"],
  );
  assert.equal(await page.locator("#gameScore").textContent(), "18");

  const suddenFixture = {
    size: 5,
    board: ["B", "A", "D", "X", "X", "R", "A", "T", ...Array(17).fill("X")],
  };
  pending.clear();
  await resetSoloBrowserPage(page, suddenFixture);
  await startSoloMode(page, "sudden");
  await page.evaluate(() => {
    const explosion = document.querySelector("#suddenDeathExplosion");
    window.__suddenDeathExplosionActivations = 0;
    window.__suddenDeathExplosionObserver = new MutationObserver(() => {
      if (explosion.classList.contains("is-active"))
        window.__suddenDeathExplosionActivations++;
    });
    window.__suddenDeathExplosionObserver.observe(explosion, {
      attributes: true,
      attributeFilter: ["class"],
    });
  });
  const suddenRequests = [
    wordRequestWaiter(pending, waiters, "BAD"),
    wordRequestWaiter(pending, waiters, "RAT"),
  ];
  await traceWord(page, [0, 1, 2]);
  await traceWord(page, [5, 6, 7]);
  await Promise.all(suddenRequests);
  await resolveWord(pending, "RAT", true);
  assert.equal(await page.locator("#gameScore").textContent(), "0");
  await resolveWord(pending, "BAD", false);
  await page.waitForFunction(() => window.__soloEvents.length === 1);
  assert.equal(await page.locator("#gameScore").textContent(), "0");
  assert.equal(
    await page.evaluate(() => window.__soloEvents.some((event) => event.type === "word-accepted")),
    false,
  );
  await page.waitForSelector("#resultsScreen.active");
  assert.match(await page.locator("#suddenDeathCalloutDetail").textContent(), /BAD/);
  assert.equal(await page.locator("#suddenDeathCallout").isHidden(), false);
  assert.equal(
    await page.evaluate(() => window.__suddenDeathExplosionActivations),
    1,
  );
  await page.evaluate(() => window.__suddenDeathExplosionObserver.disconnect());

  const replacementFixture = {
    size: 4,
    board: ["F", "O", "X", "X", "M", "A", "P", "X", "X", "X", "X", "X", "X", "X", "X", "X"],
  };
  pending.clear();
  await resetSoloBrowserPage(page, replacementFixture);
  await startSoloMode(page, "classic");
  const oldRequest = wordRequestWaiter(pending, waiters, "FOX");
  await traceWord(page, [0, 1, 2]);
  await oldRequest;
  assert.ok(pending.has("FOX"));
  await page.locator("#gameBack").click();
  await page.waitForSelector("#homeScreen.active");
  await startSoloMode(page, "classic");
  const replacementRequest = wordRequestWaiter(pending, waiters, "MAP");
  await traceWord(page, [4, 5, 6]);
  await replacementRequest;
  await resolveWord(pending, "MAP", true);
  await page.waitForFunction(() => window.__soloEvents.length === 1);
  assert.equal(await page.locator("#gameScore").textContent(), "9");
  await resolveWord(pending, "FOX", false);
  await page.waitForFunction(() => document.querySelector("#gameScore").textContent === "9");
  assert.deepEqual(
    await page.evaluate(() => window.__soloEvents.map((event) => event.word)),
    ["MAP"],
  );

  const errorFixture = {
    size: 4,
    board: ["O", "W", "L", "X", "P", "I", "G", ...Array(9).fill("X")],
  };
  pending.clear();
  await resetSoloBrowserPage(page, errorFixture);
  await startSoloMode(page, "classic");
  const errorRequests = [
    wordRequestWaiter(pending, waiters, "OWL"),
    wordRequestWaiter(pending, waiters, "PIG"),
  ];
  await traceWord(page, [0, 1, 2]);
  await traceWord(page, [4, 5, 6]);
  await Promise.all(errorRequests);
  await page.evaluate(() => {
    const original = Set.prototype.has;
    Set.prototype.has = function (value) {
      if (value === "OWL") {
        Set.prototype.has = original;
        throw new Error("intentional browser duplicate-check failure");
      }
      return original.call(this, value);
    };
  });
  await resolveWord(pending, "OWL", true);
  await resolveWord(pending, "PIG", true);
  await page.waitForFunction(() => window.__soloEvents.length === 1);
  assert.equal(await page.locator("#gameScore").textContent(), "9");
  assert.equal(
    await page.evaluate(() => window.__soloEvents[0].word),
    "PIG",
  );
  const errorProfile = await page.evaluate(() => JSON.parse(localStorage.getItem("wordrush-profile")));
  assert.equal(errorProfile.words, 1);
  assert.equal(errorProfile.correct, 1);
  assert.equal(errorProfile.incorrect, 0);
  assert.equal(
    consoleErrors.filter((message) => message.includes("solo submission commit failed")).length,
    1,
  );
  await browser.close();
});

test("multiplayer Dirty Mode starts directly without consent", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await openFriendsPanel(page);
  await page.locator("#sessionCard").click();
  await page.locator("#sessionCreate").click();
  await page.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const qrLayout = await page.evaluate(() => {
    const qr = document.querySelector("#sessionQr").getBoundingClientRect();
    const invite = document.querySelector("#sessionInvite").getBoundingClientRect();
    return { qrWidth: qr.width, inviteWidth: invite.width };
  });
  assert.ok(qrLayout.qrWidth >= qrLayout.inviteWidth - 8);
  assert.equal(await page.locator("#multiplayerDialog .cast-control").count(), 0);
  assert.equal(
    await page.locator("#castButton").evaluate((node) => node.closest(".dialog-head-actions") !== null),
    true,
  );
  assert.equal(await page.locator("#sessionShare").isVisible(), true);
  assert.equal(await page.locator("#sessionHostControls").isVisible(), true);
  assert.equal(await page.locator("#sessionLeave").textContent(), "End session");
  await page.locator('#multiplayerDialog button[value="cancel"]').click();
  await page.evaluate(() => {
    window.__sentMessages = [];
    const original = window.wordrushSocket.send.bind(window.wordrushSocket);
    window.wordrushSocket.send = function (message) {
      window.__sentMessages.push(JSON.parse(message));
      return original(message);
    };
  });
  const startedPromise = page.waitForSelector("#roundIntroScreen.active");
  await page.evaluate(() => {
    window.wordrushStartSessionGame({ mode: "dirty" });
  });
  await startedPromise;
  const dirtyMessages = await page.evaluate(() => ({
    starts: window.__sentMessages.filter((msg) => msg.type === "start_game"),
    consentVisible: !document.querySelector("#consentPanel").hidden,
    actionsVisible: !document.querySelector("#consentActions").hidden,
  }));
  assert.equal(dirtyMessages.starts.length, 1);
  assert.equal(dirtyMessages.starts[0].mode, "dirty");
  assert.equal(dirtyMessages.consentVisible, false);
  assert.equal(dirtyMessages.actionsVisible, false);
  await startIntro(page);
  assert.equal(await page.locator("#gameMode").textContent(), "DIRTY MODE · 18+");
  await browser.close();
});

test("late join to a Dirty round is admitted without consent", async () => {
  const host = await chromium.launch({ headless: true, executablePath });
  const guest = await chromium.launch({ headless: true, executablePath });
  const hostPage = await host.newPage({ viewport: { width: 390, height: 844 } });
  const guestPage = await guest.newPage({ viewport: { width: 390, height: 844 } });
  await Promise.all([hostPage.goto(baseUrl), guestPage.goto(baseUrl)]);
  await openFriendsPanel(hostPage);
  await hostPage.locator("#sessionCard").click();
  await hostPage.locator("#sessionCreate").click();
  await hostPage.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const code = await hostPage.locator("#sessionCode").textContent();
  await hostPage.locator('#multiplayerDialog button[value="cancel"]').click();
  await hostPage.evaluate(() => window.wordrushStartSessionGame({ mode: "dirty" }));
  await hostPage.waitForSelector("#roundIntroScreen.active");
  await openFriendsPanel(guestPage);
  await guestPage.locator("#sessionCard").click();
  guestPage.once("dialog", (dialog) => dialog.accept(code));
  await guestPage.locator("#sessionJoin").click();
  await guestPage.waitForFunction((expectedCode) => window.wordrushSessionCode === expectedCode, code);
  const preAdmissionState = await guestPage.evaluate(() => ({
    dialogOpen: document.querySelector("#multiplayerDialog").open,
    lobbyVisible: !document.querySelector("#sessionLobby").hidden,
    prePanelVisible: !document.querySelector("#preAdmissionPanel").hidden,
    actionsVisible: !document.querySelector("#consentActions").hidden,
    consentHidden: document.querySelector("#consentPanel").hidden,
    sessionCode: window.wordrushSessionCode || "",
    savedRoom: localStorage.getItem("wordrush-room"),
  }));
  assert.deepEqual(preAdmissionState, {
    dialogOpen: false,
    lobbyVisible: true,
    prePanelVisible: false,
    actionsVisible: false,
    consentHidden: true,
    sessionCode: code,
    savedRoom: code,
  });
  await host.close();
  await guest.close();
});

test("solo Dirty Mode starts without a confirmation dialog", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  let dialogCount = 0;
  page.on("dialog", (dialog) => {
    dialogCount += 1;
    void dialog.accept();
  });
  await openGamesPanel(page);
  await page.locator('[data-mode="dirty"]').click();
  await startIntro(page);
  assert.equal(
    await page
      .locator("#gameScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  assert.equal(await page.locator(".tile").count(), 25);
  assert.equal(dialogCount, 0);
  await browser.close();
});

const castBodyCommon = `
  window.chrome = { cast: { AutoJoinPolicy: { ORIGIN_SCOPED: "origin" } } };
  window.__castSession = {
    sendMessage: async (_namespace, message) => {
      window.__castSent = [...(window.__castSent || []), message];
    },
    addMessageListener: (_namespace, listener) => { window.__castReceiverListener = listener; }
  };
  window.__castContext = {
    setOptions: () => {},
    addEventListener: (_type, listener) => { window.__castStateListener = listener; },
    getCurrentSession: () => window.__castSession,
    requestSession: async () => {}
  };
  window.cast = { framework: {
    CastContext: { getInstance: () => window.__castContext },
    CastContextEventType: { SESSION_STATE_CHANGED: "state" },
    SessionState: { SESSION_STARTED: "started", SESSION_RESUMED: "resumed", SESSION_ENDED: "ended" }
  } };
  queueMicrotask(() => window.__onGCastApiAvailable(true));
`;

test("Cast health status exposes an in-game re-cast action with fresh credentials", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("https://www.gstatic.com/cv/js/sender/v1/cast_sender.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: `
        window.chrome = { cast: { AutoJoinPolicy: { ORIGIN_SCOPED: "origin" } } };
        window.__castSession = {
          sendMessage: async (_namespace, message) => {
            window.__castSent = [...(window.__castSent || []), message];
          },
          addMessageListener: (_namespace, listener) => { window.__castReceiverListener = listener; }
        };
        window.__castContext = {
          setOptions: () => {},
          addEventListener: (_type, listener) => { window.__castStateListener = listener; },
          getCurrentSession: () => window.__castSession,
          requestSession: async () => {}
        };
        window.cast = { framework: {
          CastContext: { getInstance: () => window.__castContext },
          CastContextEventType: { SESSION_STATE_CHANGED: "state" },
          SessionState: { SESSION_STARTED: "started", SESSION_RESUMED: "resumed", SESSION_ENDED: "ended" }
        } };
        queueMicrotask(() => window.__onGCastApiAvailable(true));
      `,
    }),
  );
  await page.route("https://wordrush.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/cast-config")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ applicationId: "test-cast-app" }),
      });
    const upstream = await fetch(baseUrl + url.pathname + url.search);
    await route.fulfill({
      status: upstream.status,
      contentType: upstream.headers.get("content-type") || "text/plain",
      body: Buffer.from(await upstream.arrayBuffer()),
    });
  });
  await page.goto("https://wordrush.test/");
  await page.evaluate(() => {
    window.wordrushSessionCode = "ABCDE";
    window.wordrushRequestDisplayToken = async () => ({ token: "fresh-display-token" });
    window.wordrushCastHealthTimeoutMs = 1000;
    window.wordrushCastProbeTimeoutMs = 50;
    document.querySelector("#homeScreen").classList.remove("active");
    document.querySelector("#gameScreen").classList.add("active");
    window.dispatchEvent(new CustomEvent("wordrush:room-change"));
  });
  await page.waitForFunction(() => !document.querySelector("#gameCastButton").hidden);
  await page.locator("#gameCastButton").click();
  await page.waitForFunction(() => window.__castSent?.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__castSent[0]), {
    type: "display_token",
    token: "fresh-display-token",
    roomCode: "ABCDE",
  });

  await page.evaluate(() => window.__castReceiverListener("namespace", {
    type: "display_status",
    status: "connected",
  }));
  assert.match(await page.locator("#castStatus").textContent(), /TV is live/);
  assert.match(await page.locator("#gameCastButton").textContent(), /Refresh TV/);

  await page.evaluate(() => window.__castStateListener({ sessionState: "resumed" }));
  await page.waitForFunction(() => window.__castSent?.some(
    (message) => message.type === "display_probe"));
  assert.deepEqual(await page.evaluate(() => window.__castSent.find(
    (message) => message.type === "display_probe")), {
    type: "display_probe",
    roomCode: "ABCDE",
  });
  await page.evaluate(() => window.__castReceiverListener("namespace", {
    type: "display_status",
    status: "connected",
  }));
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.__castSent.filter(
    (message) => message.type === "display_token").length), 1);

  await page.evaluate(() => {
    window.wordrushSessionCode = "FGHIJ";
    window.dispatchEvent(new CustomEvent("wordrush:room-change"));
  });
  assert.match(await page.locator("#castStatus").textContent(), /Ready to cast this room/);
  assert.match(await page.locator("#gameCastButton").textContent(), /Cast to TV/);

  await page.evaluate(() => window.__castReceiverListener("namespace", {
    type: "display_status",
    status: "reconnecting",
  }));
  assert.match(await page.locator("#castStatus").textContent(), /dropped.*Re-cast/i);
  assert.match(await page.locator("#gameCastButton").textContent(), /Re-cast TV/);
  await page.locator("#gameCastButton").click();
  await page.waitForFunction(() => window.__castSent?.filter(
    (message) => message.type === "display_token").length === 2);
  await browser.close();
});

test("two-player lobby synchronizes roles and guest exit leaves the host room open", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const host = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await host.goto(baseUrl);
  await openFriendsPanel(host);
  await host.locator("#sessionCard").click();
  await host.locator("#sessionCreate").click();
  await host.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const code = await host.locator("#sessionCode").textContent();

  await guest.goto(baseUrl + "/?join=" + code);
  await Promise.all([
    host.waitForFunction(() =>
      document.querySelectorAll("#lobbyPlayers .live-player").length === 2,
    ),
    guest.waitForFunction(() =>
      document.querySelectorAll("#lobbyPlayers .live-player").length === 2,
    ),
  ]);

  assert.equal(await host.locator("#sessionHostControls").isVisible(), true);
  assert.equal(await guest.locator("#sessionHostControls").isHidden(), true);
  assert.equal(await guest.locator("#sessionStart").isVisible(), false);
  assert.match(
    await guest.locator("#lobbyStatus").textContent(),
    /waiting for the host/i,
  );
  assert.equal(await host.locator("#lobbyPlayers .lobby-player-role").count(), 1);
  assert.equal(await guest.locator("#lobbyPlayers .lobby-player-role").count(), 1);
  assert.equal(await guest.locator("#lobbyPlayers .lobby-player-you").count(), 1);

  await guest.locator("#sessionLeave").click();
  await Promise.all([
    guest.waitForFunction(
      () => document.querySelector("#multiplayerBanner").hidden,
    ),
    host.waitForFunction(() =>
      document.querySelectorAll("#lobbyPlayers .live-player").length === 1,
    ),
  ]);
  assert.equal(await host.locator("#multiplayerBanner").isHidden(), false);
  assert.equal(await host.locator("#sessionCode").textContent(), code);
  assert.equal(await host.locator("#sessionHostControls").isVisible(), true);
  assert.equal(
    await guest
      .locator("#homeScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );

  host.once("dialog", (dialog) => dialog.accept());
  await host.locator("#sessionLeave").click();
  await host.waitForFunction(
    () => document.querySelector("#multiplayerBanner").hidden,
  );
  await browser.close();
});

test("host ending a round and closing an active session synchronizes every player", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const host = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await host.goto(baseUrl);
  await guest.goto(baseUrl);
  await openFriendsPanel(host);
  await host.locator("#sessionCard").click();
  await host.locator("#sessionCreate").click();
  await host.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const code = await host.locator("#sessionCode").textContent();
  await guest.goto(baseUrl + "/?join=" + code);
  await Promise.all([
    host.waitForFunction(
      () => document.querySelectorAll("#lobbyPlayers .live-player").length === 2,
    ),
    guest.waitForFunction(
      () => document.querySelectorAll("#lobbyPlayers .live-player").length === 2,
    ),
  ]);
  const resetRoundActivationProbe = (page) =>
    page.evaluate(() => {
      window.__roundStartedEvents = 0;
      window.__roundTimerIntervals = 0;
      if (window.__roundActivationProbeInstalled) return;
      window.__roundActivationProbeInstalled = true;
      document.addEventListener("wordrush:round-started", () =>
        window.__roundStartedEvents++,
      );
      const setInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 250) window.__roundTimerIntervals++;
        return setInterval(callback, delay, ...args);
      };
    });
  const roundActivation = (page) =>
    page.evaluate(() => ({
      starts: window.__roundStartedEvents,
      intervals: window.__roundTimerIntervals,
    }));
  await Promise.all([
    resetRoundActivationProbe(host),
    resetRoundActivationProbe(guest),
  ]);

  await host.locator("#sessionType").selectOption("classic");
  await host.locator("#sessionStart").click();
  await Promise.all([
    startIntro(host),
    startIntro(guest),
  ]);
  assert.deepEqual(await roundActivation(host), { starts: 1, intervals: 1 });
  assert.deepEqual(await roundActivation(guest), { starts: 1, intervals: 1 });
  await host.locator("#endGame").click();
  await Promise.all([
    host.waitForSelector("#resultsScreen.active"),
    guest.waitForSelector("#resultsScreen.active"),
  ]);

  await Promise.all([
    resetRoundActivationProbe(host),
    resetRoundActivationProbe(guest),
  ]);
  await host.locator("#again").click();
  await Promise.all([
    host.waitForSelector("#roundIntroScreen.active"),
    guest.waitForSelector("#roundIntroScreen.active"),
  ]);
  await guest.evaluate(() => {
    window.__roundStartNowMessages = 0;
    const startNow = window.wordrushRoundStartNow;
    window.wordrushRoundStartNow = (...args) => {
      window.__roundStartNowMessages++;
      window.__lastRoundStartNowTiming = args[0];
      return startNow(...args);
    };
  });
  await guest.locator('nav [data-screen="homeScreen"]').click();
  await guest.waitForSelector("#homeScreen.active");
  await openFriendsPanel(guest);
  await guest.locator("#resumeMultiplayer").click();
  await guest.waitForSelector("#roundIntroScreen.active");
  assert.equal(await guest.locator("#gameScreen.active").count(), 0);
  assert.deepEqual(await roundActivation(guest), { starts: 0, intervals: 0 });
  await guest.locator('nav [data-screen="homeScreen"]').click();
  await guest.waitForSelector("#homeScreen.active");
  await host.locator("#introStart").click();
  await Promise.all([
    host.waitForSelector("#gameScreen.active"),
    guest.waitForFunction(() => window.__roundStartNowMessages === 1),
  ]);
  assert.equal(await guest.locator("#homeScreen.active").count(), 1);
  assert.equal(await guest.locator("#gameScreen.active").count(), 0);
  assert.deepEqual(await roundActivation(host), { starts: 1, intervals: 1 });
  assert.deepEqual(await roundActivation(guest), { starts: 1, intervals: 1 });
  await openFriendsPanel(guest);
  await guest.locator("#resumeMultiplayer").click();
  await guest.waitForSelector("#gameScreen.active");
  const resumedTimer = await guest.locator("#timer").textContent();
  await guest.waitForFunction(
    (before) => document.querySelector("#timer").textContent !== before,
    resumedTimer,
  );
  await guest.evaluate(() => {
    window.wordrushReturnToOnlineRound();
    window.wordrushRoundStartNow(window.__lastRoundStartNowTiming);
    window.wordrushRoundStartNow(window.__lastRoundStartNowTiming);
  });
  assert.deepEqual(await roundActivation(guest), { starts: 1, intervals: 1 });
  await host.locator("#gameBack").click();
  host.once("dialog", (dialog) => dialog.accept());
  await host.locator("#exitMultiplayer").click();
  await Promise.all([
    host.waitForFunction(() => document.querySelector("#homeScreen").classList.contains("active")),
    guest.waitForFunction(() => document.querySelector("#homeScreen").classList.contains("active")),
    host.waitForFunction(() => document.querySelector("#multiplayerBanner").hidden),
    guest.waitForFunction(() => document.querySelector("#multiplayerBanner").hidden),
  ]);
  await browser.close();
});

test("multiplayer session reconnects when its socket is lost", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await openFriendsPanel(page);
  await page.locator("#sessionCard").click();
  assert.equal(
    await page
      .locator("#multiplayerBanner")
      .evaluate((node) => getComputedStyle(node).display),
    "none",
  );
  await page.locator("#sessionCreate").click();
  await page.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const code = await page.locator("#sessionCode").textContent();
  assert.equal(await page.locator("#multiplayerBanner").isHidden(), false);
  await page.evaluate(() => {
    window.wordrushReconnectDelayMs = 0;
    const oldSocket = window.wordrushSocket;
    window.__oldWordrushSocket = oldSocket;
    oldSocket.close();
  });
  await page.waitForFunction(
    () =>
      window.wordrushSocket &&
      window.wordrushSocket !== window.__oldWordrushSocket &&
      window.wordrushSocket.readyState === WebSocket.OPEN &&
      window.wordrushSessionCode,
  );
  assert.equal(await page.locator("#multiplayerBanner").isHidden(), false);
  assert.equal(await page.locator("#sessionCode").textContent(), code);
  await browser.close();
});

test("score screen celebrates rankings, highlights, and word lengths graphically", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.evaluate(() => {
    const guestId = window.wordrushGuestId;
    window.wordrushOnlineRound(
      { board: Array(16).fill("A"), size: 4, endsAt: Date.now() + 60000 },
      { label: "CLASSIC", min: 3, rule: "Multiplayer round" },
      "classic",
    );
    window.wordrushOnlineFinish([
      {
        id: guestId,
        name: "Comet",
        avatar: "🦊",
        score: 49,
        session: { wins: 2, losses: 1, points: 149 },
        words: [
          { word: "PLANETS", points: 49 },
          { word: "STARS", points: 25 },
        ],
      },
      {
        id: "moon",
        name: "Moon",
        avatar: "🐈",
        score: 25,
        session: { wins: 1, losses: 2, points: 103 },
        words: [{ word: "MOONLIT", points: 49 }],
      },
      {
        id: "sun",
        name: "Sun",
        avatar: "🐸",
        score: 12,
        words: [{ word: "CAT", points: 9 }],
      },
    ], { results: { view: "static", speed: "fast" } });
  });
  await page.waitForSelector("#resultsScreen.active");
  assert.equal(await page.locator(".result-player-card").count(), 3);
  assert.equal(await page.locator("#resultHeroScores .result-score-row").count(), 3);
  assert.deepEqual(
    await page.locator("#resultHeroScores .result-score-identity b").allTextContents(),
    ["🦊 Comet", "🐈 Moon", "🐸 Sun"],
  );
  assert.equal(await page.locator("#resultHeroScores .result-score-row.is-winner").count(), 1);
  assert.equal(await page.locator("#resultAchievement").count(), 0);
  assert.equal(await page.locator("#staticResultsView").isHidden(), false);
  assert.equal(await page.locator(".results-switcher").count(), 0);
  assert.equal(await page.locator("#animatedResultsView").count(), 0);
  assert.equal(await page.locator("#seriesFinalPanel").isHidden(), true);
  const longest = await page.locator("#resultLongestWord").textContent();
  assert.match(longest, /PLANETS · 49 pts · 🦊 Comet/);
  assert.match(longest, /MOONLIT · 49 pts · 🐈 Moon/);
  assert.match(await page.locator("#resultLongestLabel").textContent(), /CO-WINNERS/);
  assert.match(await page.locator("#resultTopPlayer").textContent(), /Comet/);
  assert.match(await page.locator(".result-session-record").first().textContent(), /2W · 1L · 149 session pts/);
  assert.match(await page.locator(".result-session-record").nth(1).textContent(), /1W · 2L · 103 session pts/);
  const presentation = await page.evaluate(() => ({
    heroRadius: parseFloat(getComputedStyle(document.querySelector(".result-hero")).borderRadius),
    first: getComputedStyle(document.querySelector(".result-player-card.rank-1")).backgroundColor,
    second: getComputedStyle(document.querySelector(".result-player-card.rank-2")).backgroundColor,
    scoreboardColumns: getComputedStyle(document.querySelector(".result-score-row")).gridTemplateColumns,
    actionColumns: getComputedStyle(document.querySelector(".results-actions")).gridTemplateColumns,
    actionHeights: [...document.querySelectorAll(".results-actions .result-action-tile:not([hidden])")]
      .map((button) => button.getBoundingClientRect().height),
  }));
  assert.ok(presentation.heroRadius >= 20);
  assert.notEqual(presentation.first, presentation.second);
  assert.match(presentation.scoreboardColumns, /\S+\s+\S+\s+\S+/);
  assert.match(presentation.actionColumns, /\S+\s+\S+/);
  assert.ok(presentation.actionHeights.every((height) => height >= 56));
  assert.ok(Math.max(...presentation.actionHeights) - Math.min(...presentation.actionHeights) < 1);
  assert.equal(await page.locator(".result-confetti i").count(), 5);
  await browser.close();
});
