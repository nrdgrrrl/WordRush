const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
process.env.RANDOM_RUSH_DELAY = "50";
process.env.WORDRUSH_LEADERBOARD_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-browser-")),
  "leaderboard.json",
);
const { server } = require("../server");

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM ||
  "/home/victoria/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
let baseUrl;
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

test("browser can start, play, persist stats, and toggle dark mode", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator("#quickPlay").click();
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
  assert.ok(Number(await page.locator("#gameScore").textContent()) > 0);
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
  await page.locator('[data-screen="homeScreen"]').first().click();
  assert.equal(
    await page
      .locator("#multiplayerButton")
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    "rgb(245, 243, 238)",
  );
  assert.equal(
    await page
      .locator("#multiplayerButton")
      .evaluate((node) => getComputedStyle(node).color),
    "rgb(29, 29, 27)",
  );
  await page.locator("#themeToggle").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(
    await page
      .locator("#multiplayerButton")
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    "rgb(17, 19, 17)",
  );
  assert.equal(
    await page
      .locator("#multiplayerButton")
      .evaluate((node) => getComputedStyle(node).color),
    "rgb(243, 241, 234)",
  );
  assert.deepEqual(errors, []);
  await browser.close();
});

test("random rush starts by touch and the board stays inside the phone viewport", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.goto(baseUrl);
    await page.locator("#randomPanel").click();
    assert.equal(
      await page
        .locator("#gameScreen")
        .evaluate((node) => node.classList.contains("active")),
      true,
    );
    const layout = await page.evaluate(() => {
      const grid = document.querySelector(".grid").getBoundingClientRect();
      return {
        scrollHeight: document.documentElement.scrollHeight,
        viewport: innerHeight,
        right: grid.right,
        bottom: grid.bottom,
        nav: getComputedStyle(document.querySelector("nav")).display,
      };
    });
    assert.equal(layout.scrollHeight, viewport.height);
    assert.ok(layout.right <= viewport.width);
    assert.ok(layout.bottom <= viewport.height);
    assert.equal(layout.nav, "none");
    await page.close();
  }
  await browser.close();
});

test("active games hide the title bar and preserve a no-scroll compact layout", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#quickPlay").click();
  const layout = await page.evaluate(() => {
    const style = (selector) =>
      getComputedStyle(document.querySelector(selector));
    return {
      header: style("header").display,
      screenHeight: document
        .querySelector("#gameScreen")
        .getBoundingClientRect().height,
      viewportHeight: innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      modeSize: parseFloat(style("#gameMode").fontSize),
      ruleSize: parseFloat(style("#ruleBanner").fontSize),
      previewSize: parseFloat(style("#preview").fontSize),
      scoreSize: parseFloat(style("#gameScore").fontSize),
    };
  });
  assert.equal(layout.header, "none");
  assert.equal(layout.screenHeight, layout.viewportHeight);
  assert.equal(layout.scrollHeight, layout.viewportHeight);
  assert.ok(layout.modeSize > 11);
  assert.ok(layout.ruleSize > 11);
  assert.ok(layout.previewSize > 13);
  assert.ok(layout.scoreSize < 28);
  await browser.close();
});

test("global scoreboard lists players and opens their stats", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  const id = "browser-score-" + Date.now();
  await page.evaluate(
    async ({ id }) =>
      fetch("/api/leaderboard/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name: "BoardCat",
          avatar: "🐯",
          score: 321,
          words: 9,
        }),
      }),
    { id },
  );
  await page.locator("#scoreboardButton").click();
  await page.waitForSelector("#scoreboardScreen.active");
  await page.waitForFunction(() =>
    document.querySelector("#scoreboardList").textContent.includes("BoardCat"),
  );
  assert.equal(
    await page
      .locator(".scoreboard-row")
      .first()
      .locator(".scoreboard-avatar")
      .textContent(),
    "🐯",
  );
  await page.locator(".scoreboard-row").first().click();
  await page.waitForFunction(
    () => document.querySelector("#leaderboardProfileDialog").open,
  );
  assert.equal(
    await page
      .locator("#leaderboardProfileDialog")
      .evaluate((dialog) => dialog.open),
    true,
  );
  assert.match(
    await page.locator("#leaderboardProfileName").textContent(),
    /BoardCat/,
  );
  assert.match(
    await page.locator("#leaderboardProfileBody").textContent(),
    /321/,
  );
  await page.locator("#leaderboardProfileClose").click();
  await page.locator('[data-period="total"]').click();
  assert.equal(
    await page
      .locator('.scoreboard-tabs [data-period="total"]')
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  await browser.close();
});

test("sudden death can return home from its results screen", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator('[data-mode="sudden"]').click();
  const tile = await page.locator(".tile").first().boundingBox();
  await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(450);
  assert.equal(
    await page
      .locator("#resultsScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  await page.locator('#resultsScreen [data-screen="homeScreen"]').click();
  assert.equal(
    await page
      .locator("#homeScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  await browser.close();
});

test("custom game controls start the selected configuration", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#customGame").click();
  await page.locator("#customType").selectOption("classic");
  await page.locator("#customRules").selectOption("classic");
  await page.locator("#customMin").fill("6");
  await page.locator("#customBoard").selectOption("8");
  await page.locator("#customTime").fill("45");
  await page.locator("#customStart").click();
  assert.equal(
    await page
      .locator("#gameScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  assert.equal(await page.locator(".tile").count(), 64);
  assert.equal(
    await page.locator("#gameHint").textContent(),
    "Minimum 6 letters",
  );
  assert.equal(
    await page.locator("#ruleBanner").textContent(),
    "Minimum 6 letters · 45 seconds",
  );
  await browser.close();
});

test("random rush rolls into a different game and can be stopped", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.evaluate(() => {
    window.wordrushRushDelay = 50;
  });
  await page.locator("#randomPanel").click();
  const firstMode = await page.locator("#gameMode").textContent();
  await page.locator("#endGame").click();
  await page.waitForTimeout(120);
  assert.equal(
    await page
      .locator("#gameScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  assert.notEqual(await page.locator("#gameMode").textContent(), firstMode);
  await page.locator("#stopRush").click();
  assert.equal(
    await page
      .locator("#homeScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  await browser.close();
});

test("the Random Rush preview panel starts the rush while reload only rerolls it", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  const before = await page.locator("#randomPreview").textContent();
  await page.locator("#reroll").click();
  assert.equal(
    await page
      .locator("#homeScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  const after = await page.locator("#randomPreview").textContent();
  assert.ok(after.length > 0);
  const preview = await page.locator("#randomPreview").textContent();
  await page.locator("#randomPanel").click();
  assert.equal(
    await page
      .locator("#gameScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  assert.match(
    await page.locator("#gameTitle").textContent(),
    new RegExp(preview.match(/(\d+)×\1/)?.[0] || "never"),
  );
  await browser.close();
});

test("multiplayer creates a five-letter session and launches co-op", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#multiplayerButton").click();
  await page.locator("#sessionCreate").click();
  await page.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  assert.equal(
    await page
      .locator("#sessionCode")
      .textContent()
      .then((code) => code.length),
    5,
  );
  assert.equal(await page.locator("#multiplayerBanner").isHidden(), false);
  await page.locator("#sessionType").selectOption("coop");
  await page.locator("#sessionStart").click();
  await page.waitForSelector("#gameScreen.active");
  assert.equal(await page.locator("#gameMode").textContent(), "CO-OP");
  assert.equal(await page.locator("#livePlayers .live-player").count(), 1);
  await page.locator('#gameScreen [data-screen="homeScreen"]').click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#exitMultiplayer").click();
  await page.waitForFunction(
    () => document.querySelector("#multiplayerBanner").hidden,
  );
  assert.equal(
    await page
      .locator("#homeScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  await browser.close();
});

test("multiplayer banner disappears when its connection is lost", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#multiplayerButton").click();
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
  assert.equal(await page.locator("#multiplayerBanner").isHidden(), false);
  await page.evaluate(() => window.wordrushSocket.close());
  await page.waitForFunction(
    () => document.querySelector("#multiplayerBanner").hidden,
  );
  assert.equal(
    await page
      .locator("#homeScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  await browser.close();
});

test("banner X exits a newly created session from the landing page", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#multiplayerButton").click();
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
  await page.locator('#multiplayerDialog button[value="cancel"]').click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#exitMultiplayer").click();
  await page.waitForFunction(
    () => document.querySelector("#multiplayerBanner").hidden,
  );
  assert.equal(
    await page
      .locator("#multiplayerBanner")
      .evaluate((node) => getComputedStyle(node).display),
    "none",
  );
  assert.equal(
    await page.locator("#multiplayerBannerText").textContent(),
    "No active session",
  );
  assert.equal(
    await page.locator("#roomTitle").textContent(),
    "No active session",
  );
  assert.equal(
    await page
      .locator("#homeScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  await browser.close();
});

test("browser profile uses a generated identity and saves a selected avatar", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const initial = await page.locator("#profileButton").textContent();
  assert.notEqual(initial, "JD");
  await page.locator("#profileButton").click();
  assert.equal(
    await page.locator("#profileDialog").evaluate((dialog) => dialog.open),
    true,
  );
  await page.locator("#profileName").fill("CosmicPaw");
  await page.locator('[data-avatar="🦊"]').click();
  await page.locator("#profileForm .dialog-save").click();
  assert.equal(await page.locator("#profileButton").textContent(), "🦊");
  assert.deepEqual(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("wordrush-profile")).name,
    ),
    "CosmicPaw",
  );
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("wordrush-profile")).avatar,
    ),
    "🦊",
  );
  await page.locator("#profileButton").click();
  await page.locator('[data-avatar="🐯"]').click();
  await page.locator("#profileForm .dialog-save").click();
  await page.reload();
  assert.equal(await page.locator("#profileButton").textContent(), "🐯");
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("wordrush-profile")).avatar,
    ),
    "🐯",
  );
  await browser.close();
});

test("browser exposes the expanded avatar set and unlocks achievement toasts", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  assert.equal(
    await page.evaluate(() => window.wordrushAchievementCatalog.length),
    204,
  );
  await page.locator("#profileButton").click();
  assert.equal(
    await page.locator("[data-avatar]").count(),
    await page.evaluate(() => window.wordrushAvatarOptions.length),
  );
  assert.equal(
    await page
      .locator("[data-avatar]")
      .evaluateAll(
        (buttons) =>
          new Set(buttons.map((button) => button.dataset.avatar)).size,
      ),
    await page.locator("[data-avatar]").count(),
  );
  await page.locator('#profileForm [value="cancel"]').click();
  await page.evaluate(() => {
    const profile = JSON.parse(localStorage.getItem("wordrush-profile"));
    profile.words = 1;
    profile.score = 0;
    profile.rounds = 0;
    profile.streak = 0;
    profile.unlocked = [];
    localStorage.setItem("wordrush-profile", JSON.stringify(profile));
    window.wordrushAchievementEvent();
  });
  assert.match(await page.locator("#toast").textContent(), /First blood/);
  assert.match(
    await page.locator("#achievementCount").textContent(),
    /[1-9] \/ 204/,
  );
  const lightToast = await page.locator("#toast").evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    color: getComputedStyle(node).color,
    background: getComputedStyle(node).backgroundColor,
  }));
  assert.ok(lightToast.width > 300);
  assert.notEqual(lightToast.color, lightToast.background);
  await page.locator("#themeToggle").click();
  const darkToast = await page.locator("#toast").evaluate((node) => ({
    color: getComputedStyle(node).color,
    background: getComputedStyle(node).backgroundColor,
  }));
  assert.notEqual(darkToast.color, darkToast.background);
  await page.locator("#quickPlay").click();
  await page.evaluate(() => {
    const profile = JSON.parse(localStorage.getItem("wordrush-profile"));
    profile.words = 1;
    profile.unlocked = [];
    localStorage.setItem("wordrush-profile", JSON.stringify(profile));
    window.wordrushAchievementEvent();
  });
  const inGameToast = await page.locator("#toast").evaluate((node) => {
    const toast = node.getBoundingClientRect();
    const board = document.querySelector(".board").getBoundingClientRect();
    return {
      top: toast.top,
      boardTop: board.top,
      clearOfBoard: toast.bottom <= board.top,
    };
  });
  assert.ok(Math.abs(inGameToast.top - 10) < 1);
  assert.equal(inGameToast.clearOfBoard, true);
  await page.waitForTimeout(3500);
  assert.equal(
    await page
      .locator("#toast")
      .evaluate((node) => getComputedStyle(node).opacity),
    "1",
  );
  await page.locator("#endGame").click();
  await page.waitForTimeout(350);
  assert.equal(
    await page
      .locator("#toast")
      .evaluate((node) => getComputedStyle(node).opacity),
    "0",
  );
  await browser.close();
});
test("tracing animates selected tiles and clears them with the trace line", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#quickPlay").click();
  const tile = await page.locator(".tile").first().boundingBox();
  const point = { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
  await page.mouse.move(point.x, point.y);
  const defaultTileStyle = await page
    .locator(".tile")
    .first()
    .evaluate((node) => ({
      color: getComputedStyle(node).color,
      background: getComputedStyle(node).backgroundColor,
    }));
  await page.mouse.down();
  assert.equal(await page.locator(".tile.selected").count(), 1);
  await page.waitForFunction(() =>
    Boolean(document.querySelector("#tracePath").getAttribute("d")),
  );
  assert.equal(
    await page
      .locator(".tile")
      .first()
      .evaluate((node) => getComputedStyle(node).color),
    defaultTileStyle.color,
  );
  assert.notEqual(
    await page
      .locator(".tile")
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    defaultTileStyle.background,
  );
  assert.notEqual(await page.locator("#tracePath").getAttribute("d"), null);
  await page.mouse.up();
  assert.equal(await page.locator(".tile.selected").count(), 1);
  assert.notEqual(await page.locator("#tracePath").getAttribute("d"), null);
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".tile.selected").count(), 0);
  assert.equal(await page.locator("#tracePath").getAttribute("d"), null);
  await browser.close();
});

test("touch tracing accepts tile edges without selecting diagonal gaps", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await page.goto(baseUrl);
  await page.locator("#quickPlay").click();
  const tiles = page.locator(".tile");
  const first = await tiles.nth(0).boundingBox();
  const gapPoint = {
    x: first.x + first.width + 2,
    y: first.y + first.height + 2,
  };

  // A near-corner touch is still inside the first tile and must start tracing.
  await page.mouse.move(first.x + 2, first.y + 2);
  await page.mouse.down();
  assert.equal(await page.locator(".tile.selected").count(), 1);
  await page.mouse.up();

  // A point in the diagonal gap must not be coerced to either neighboring tile.
  await page.waitForTimeout(300);
  await page.mouse.move(gapPoint.x, gapPoint.y);
  await page.mouse.down();
  assert.equal(await page.locator(".tile.selected").count(), 0);
  await page.mouse.up();
  await browser.close();
});

test("diagonal tracing does not pick corner-crossed neighboring tiles", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#quickPlay").click();
  const from = await page.locator(".tile").nth(0).boundingBox();
  const to = await page.locator(".tile").nth(5).boundingBox();
  const center = (box) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  const start = center(from),
    finish = center(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step < 10; step++) {
    const progress = step / 10;
    await page.mouse.move(
      start.x + (finish.x - start.x) * progress,
      start.y + (finish.y - start.y) * progress,
    );
  }
  await page.mouse.move(finish.x, finish.y);
  assert.deepEqual(
    await page
      .locator(".tile.selected")
      .evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.i))),
    [0, 5],
  );
  await page.mouse.up();
  await browser.close();
});

test("a canceled pointer cannot clear a newer trace", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await page.goto(baseUrl);
  await page.locator("#quickPlay").click();
  const first = await page.locator(".tile").nth(0).boundingBox();
  const second = await page.locator(".tile").nth(1).boundingBox();
  await page.evaluate(
    ({ first, second }) => {
      const grid = document.querySelector("#grid");
      const point = (box, id) =>
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: id,
          clientX: box.x + 2,
          clientY: box.y + 2,
        });
      grid.dispatchEvent(point(first, 1));
      grid.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 1,
          clientX: first.x + 2,
          clientY: first.y + 2,
        }),
      );
      grid.dispatchEvent(point(second, 2));
      grid.dispatchEvent(
        new PointerEvent("pointercancel", {
          bubbles: true,
          pointerId: 1,
          clientX: first.x + 2,
          clientY: first.y + 2,
        }),
      );
    },
    { first, second },
  );
  assert.equal(await page.locator(".tile.selected").count(), 1);
  await browser.close();
});

test("animated results safely render ten players without phone overflow", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl);
  await page.evaluate(() => {
    const guestId = window.wordrushGuestId;
    window.wordrushOnlineRound(
      {
        board: Array(16).fill("A"),
        size: 4,
        endsAt: Date.now() + 60000,
      },
      { label: "CLASSIC", min: 3, rule: "Multiplayer round" },
      "classic",
    );
    const ranking = Array.from({ length: 10 }, (_, index) => ({
      id: index === 0 ? guestId : "result-player-" + index,
      name:
        index === 1
          ? '<img id="result-xss" src=x onerror=alert(1)>'
          : "LongPlayerNameWithoutSpaces" + index,
      avatar: "🐈",
      score: 25,
      words: [
        { word: "CAT", points: 9 },
        { word: "STAR", points: 16 },
      ],
    }));
    window.wordrushOnlineFinish(ranking, {
      cooperative: false,
      stats: { wordsFound: 20 },
      results: { view: "reveal", speed: "fast" },
    });
  });
  await page.waitForSelector("#resultsScreen.active");
  await page.waitForTimeout(450);
  assert.equal(await page.locator(".reveal-player").count(), 10);
  assert.equal(await page.locator("#result-xss").count(), 0);
  assert.equal(await page.locator("#revealTotal").textContent(), "250");
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
    false,
  );
  assert.deepEqual(pageErrors, []);
  await browser.close();
});
