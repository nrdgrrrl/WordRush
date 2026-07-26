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
async function startClassic(page) {
  await page.locator('button[data-mode="classic"]').click();
  await page.waitForSelector("#customDialog[open]");
  await page.locator("#customStart").click();
  await page.locator("#introStart").click();
}
async function startIntro(page) {
  await page.waitForFunction(() =>
    document.querySelector("#roundIntroScreen.active") ||
    document.querySelector("#gameScreen.active"),
  );
  await page.evaluate(() => document.querySelector("#introStart")?.click());
  await page.waitForSelector("#gameScreen.active");
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

test("receiver preview is public and awaits Cast room context", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const response = await page.goto(baseUrl + "/receiver/");
  assert.equal(response.status(), 200);
  assert.match(await page.locator("h1").textContent(), /Cast a room/);
  assert.match(await page.locator("#connection").textContent(), /Receiver preview|Waiting/);
  await browser.close();
});

test("receiver preserves room state and reconnects itself after a dropped connection", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.route("**/cast_receiver_framework.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
  await page.addInitScript(() => {
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.closeCalls = 0;
        this.listeners = new Map();
        window.__receiverSocket = this;
        window.__receiverSockets = [...(window.__receiverSockets || []), this];
        queueMicrotask(() => { this.readyState = 1; this.emit("open"); });
      }
      addEventListener(type, handler) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), handler]);
      }
      emit(type, event = {}) {
        for (const handler of this.listeners.get(type) || []) handler(event);
      }
      send(message) { window.__receiverMessages = [...(window.__receiverMessages || []), message]; }
      close() { this.closeCalls += 1; this.readyState = 3; this.emit("close"); }
    }
    window.WebSocket = FakeWebSocket;
    window.wordrushDisplayReconnectDelayMs = 0;
    window.wordrushDisplayKeepaliveMs = 10;
    window.wordrushReceiverHandoffDelayMs = 60_000;
    window.cast = { framework: { CastReceiverContext: { getInstance: () => ({
      addCustomMessageListener: (_namespace, handler) => { window.__receiverHandler = handler; },
      addEventListener: (_type, handler) => { window.__receiverSenderConnected = handler; },
      getSenders: () => [{ id: "sender-1" }, { id: "sender-2" }],
      sendCustomMessage: (_namespace, senderId, message) => {
        window.__receiverCastMessages = [...(window.__receiverCastMessages || []), message];
        window.__receiverCastEnvelopes = [...(window.__receiverCastEnvelopes || []), { senderId, message }];
      },
      start: (options) => { window.__receiverOptions = options; },
    }) }, system: { EventType: { SENDER_CONNECTED: "sender-connected" } } } };
  });
  await page.goto(baseUrl + "/receiver/");
  assert.equal(
    await page.evaluate(() => window.__receiverOptions?.disableIdleTimeout),
    true,
  );
  assert.equal(await page.evaluate(() => window.__receiverOptions?.skipPlayersLoad), true);
  await page.evaluate(() => window.__receiverSenderConnected({ senderId: "sender-2" }));
  assert.deepEqual(await page.evaluate(() => window.__receiverCastEnvelopes.at(-1)), {
    senderId: "sender-2",
    message: { type: "display_reconnect_needed" },
  });
  await page.evaluate(() => window.__receiverHandler({ data: {
    type: "display_token", token: "test-token", roomCode: "ABCDE",
  } }));
  await page.waitForFunction(() => window.__receiverMessages?.length === 1);
  await page.evaluate(() => window.__receiverSocket.emit("message", { data: JSON.stringify({
    type: "display_state", reconnectToken: "reconnect-token", state: {
      status: "lobby", code: "ABCDE", players: [
        { name: "Host", avatar: "🐈", score: 0 },
        { name: "Guest", avatar: "🦊", score: 0 },
      ],
    },
  }) }));
  await page.waitForFunction(() => window.__receiverCastMessages?.some(
    (message) => message.type === "display_status" && message.status === "connected",
  ));
  await page.evaluate(() => window.__receiverHandler({ data: {
    type: "display_token", token: "duplicate-token", roomCode: "ABCDE",
  } }));
  assert.equal(await page.evaluate(() => window.__receiverSockets.length), 1);
  assert.equal(await page.evaluate(() => window.__receiverSocket.closeCalls), 0);
  await page.evaluate(() => window.__receiverHandler({
    senderId: "sender-1",
    data: { type: "display_probe", roomCode: "ABCDE" },
  }));
  assert.deepEqual(await page.evaluate(() => window.__receiverCastEnvelopes.at(-1)), {
    senderId: "sender-1",
    message: { type: "display_status", status: "connected" },
  });
  const qr = await page.locator(".join-qr").evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, bottom: bounds.bottom };
  });
  assert.equal(qr.width, 832);
  assert.equal(qr.height, 832);
  assert.ok(qr.bottom <= 1080);
  await page.evaluate(() => window.__receiverSocket.emit("message", { data: JSON.stringify({
    type: "display_state", state: {
      status: "playing", code: "ABCDE", config: { label: "CLASSIC" },
      players: Array.from({ length: 10 }, (_, index) => ({
        name: "Very long player name " + index, avatar: "🐈", score: 100 - index,
      })),
    },
  }) }));
  assert.equal(await page.locator(".score-card").count(), 10);
  assert.match(await page.locator("#eyebrow").textContent(), /LIVE SCOREBOARD/);
  await page.evaluate(() => window.__receiverSocket.emit("message", { data: JSON.stringify({
    type: "display_state", state: {
      status: "finished", code: "ABCDE",
      players: [
        { name: "Nova", avatar: "🦊", score: 74 },
        { name: "Pixel", avatar: "🐈", score: 34 },
      ],
      lastResult: {
        cooperative: false,
        ranking: [
          {
            name: "Nova", avatar: "🦊", score: 74,
            session: { wins: 3, losses: 1, points: 248 },
            words: [
              { word: "PLANETS", points: 49 },
              { word: "STARS", points: 25 },
            ],
          },
          {
            name: "Pixel", avatar: "🐈", score: 34,
            session: { wins: 1, losses: 3, points: 179 },
            words: [
              { word: "MOON", points: 16 },
              { word: "COMET", points: 18 },
            ],
          },
        ],
      },
    },
  }) }));
  assert.equal(await page.locator(".final-player-card").count(), 2);
  assert.equal(await page.locator(".tv-word").count(), 4);
  assert.equal(await page.locator(".tv-word.length-short").count(), 1);
  assert.equal(await page.locator(".tv-word.length-medium").count(), 2);
  assert.equal(await page.locator(".tv-word.length-long").count(), 1);
  assert.match(await page.locator(".longest-banner").textContent(), /PLANETS/);
  assert.match(await page.locator(".longest-banner").textContent(), /Nova/);
  assert.match(await page.locator(".longest-banner").textContent(), /49 pts/);
  assert.match(await page.locator(".tv-session-record").first().textContent(), /3W · 1L · 248 SESSION PTS/);
  assert.match(await page.locator(".tv-session-record").nth(1).textContent(), /1W · 3L · 179 SESSION PTS/);
  assert.equal(
    await page.locator(".results-party").evaluate((node) =>
      node.getBoundingClientRect().bottom <= innerHeight),
    true,
  );
  await page.waitForFunction(() => window.__receiverMessages?.some((raw) =>
    JSON.parse(raw).type === "display_keepalive"));
  await page.evaluate(() => window.__receiverSocket.close());
  await page.waitForFunction(() => window.__receiverCastMessages?.some(
    (message) => message.type === "display_status" && message.status === "reconnecting",
  ));
  await page.waitForFunction(() => window.__receiverSockets?.length === 2);
  await page.waitForFunction(() => window.__receiverMessages?.some((raw) =>
    JSON.parse(raw).type === "display_resume"));
  assert.deepEqual(
    await page.evaluate(() => window.__receiverMessages.map((raw) => JSON.parse(raw)).find(
      (message) => message.type === "display_resume",
    )),
    { type: "display_resume", token: "reconnect-token" },
  );
  assert.equal(await page.locator(".final-player-card").count(), 2);
  assert.match(await page.locator("#connection").textContent(), /Reconnecting/i);
  await page.reload();
  await page.waitForFunction(() => window.__receiverMessages?.some((raw) =>
    JSON.parse(raw).type === "display_resume"));
  assert.deepEqual(
    await page.evaluate(() => window.__receiverMessages.map((raw) => JSON.parse(raw)).find(
      (message) => message.type === "display_resume",
    )),
    { type: "display_resume", token: "reconnect-token" },
  );
  await browser.close();
});

test("browser can start, play, persist stats, and toggle dark mode", async () => {
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
  await page.locator('[data-screen="homeScreen"]').first().click();
  await page.locator("#themeToggle").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.deepEqual(errors, []);
  await browser.close();
});

test("solo play ignores a stale multiplayer socket and validates without downloading the dictionary", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const dictionaryRequests = [];
  const wordCheckRequests = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/dictionary.json") dictionaryRequests.push(request.url());
    if (pathname === "/api/word-check") wordCheckRequests.push(request.url());
  });
  await page.goto(baseUrl);
  await startClassic(page);
  const found = await page.evaluate(() => {
    const words = window.WordrushConfig.COMMON_WORDS;
    const letters = [...document.querySelectorAll(".tile")].map(
      (tile) => tile.textContent,
    );
    const size = Math.sqrt(letters.length);
    const near = (index) =>
      Array.from({ length: letters.length }, (_, next) => next).filter(
        (next) =>
          next !== index &&
          Math.abs(Math.floor(next / size) - Math.floor(index / size)) <= 1 &&
          Math.abs((next % size) - (index % size)) <= 1,
      );
    const find = (word) => {
      const walk = (trail) => {
        if (trail.length === word.length) return trail;
        for (const next of near(trail.at(-1))) {
          if (trail.includes(next) || letters[next] !== word[trail.length]) continue;
          const result = walk([...trail, next]);
          if (result) return result;
        }
        return null;
      };
      for (let index = 0; index < letters.length; index++) {
        if (letters[index] !== word[0]) continue;
        const trail = walk([index]);
        if (trail) return { word, trail };
      }
      return null;
    };
    for (const word of words) {
      const result = find(word);
      if (result) return result;
    }
    return null;
  });
  assert.ok(found, "generated board should contain a seeded common word");
  await page.evaluate(() => {
    window.wordrushSessionCode = "";
    window.wordrushSocket = {
      readyState: WebSocket.OPEN,
      send(message) {
        window.__staleSocketMessages = [
          ...(window.__staleSocketMessages || []),
          JSON.parse(message),
        ];
      },
    };
  });
  const traceWord = async () => {
    const boxes = await Promise.all(
      found.trail.map((index) => page.locator(".tile").nth(index).boundingBox()),
    );
    await page.mouse.move(
      boxes[0].x + boxes[0].width / 2,
      boxes[0].y + boxes[0].height / 2,
    );
    await page.mouse.down();
    for (const box of boxes.slice(1))
      await page.mouse.move(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
    await page.mouse.up();
  };
  await traceWord();
  await page.waitForFunction(() => Number(document.querySelector("#gameScore").textContent) > 0);
  await traceWord();
  await page.waitForTimeout(50);
  assert.deepEqual(
    await page.evaluate(() => window.__staleSocketMessages || []),
    [],
  );
  assert.equal(dictionaryRequests.length, 0);
  assert.equal(wordCheckRequests.length, 1, "duplicate word should use local state");
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
    await startIntro(page);
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

test("new modes show animated rules and Random Rush can continue immediately", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  for (const mode of ["blitz", "longhaul", "storm", "scoreattack", "chain"])
    assert.equal(await page.locator(`[data-mode="${mode}"]`).count(), 1);

  await page.locator('[data-mode="chain"]').click();
  assert.equal(await page.locator("#roundIntroScreen").isVisible(), true);
  assert.match(await page.locator("#introRule").textContent(), /last word/i);
  await page.locator("#introStart").click();
  await page.waitForSelector("#gameScreen.active");
  await page.locator("#gameBack").click();

  await page.locator("#randomPanel").click();
  await page.locator("#introStart").click();
  await page.locator("#endGame").click();
  await page.waitForSelector("#resultsScreen.active");
  assert.match(await page.locator("#again").textContent(), /Continue Random Rush/);
  await page.locator("#again").click();
  assert.equal(await page.locator("#roundIntroScreen").isVisible(), true);
  await browser.close();
});

test("active games hide the title bar and preserve a no-scroll compact layout", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await startClassic(page);
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
  assert.ok(layout.previewSize >= 24);
  assert.ok(layout.scoreSize >= 32);
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
  await startIntro(page);
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

test("graphical game builder includes a three-letter option and starts its configuration", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#customGame").click();
  assert.equal(await page.locator("#customDialog select").count(), 0);
  assert.equal(await page.locator("#customDialog input").count(), 0);
  const threeLetters = page.locator('[data-custom-min="3"]');
  assert.equal(await threeLetters.isVisible(), true);
  await threeLetters.click();
  assert.equal(await threeLetters.getAttribute("aria-pressed"), "true");
  await page.locator('[data-custom-min="6"]').click();
  await page.locator('[data-custom-size="8"]').click();
  await page.locator('[data-custom-time="30"]').click();
  await page.locator("#customStart").click();
  await startIntro(page);
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
    "Minimum 6 letters · 30 seconds",
  );
  await browser.close();
});

test("random rush rolls into a different game and can be stopped", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.evaluate(() => {
    // Keep the result celebration visible long enough for a browser paint and
    // an accessibility-visible assertion before the next rush begins.
    window.wordrushRushDelay = 250;
  });
  await page.locator("#randomPanel").click();
  await startIntro(page);
  const modes = [];
  for (let round = 0; round < 4; round++) {
    modes.push(await page.locator("#gameMode").textContent());
    if (round === 3) break;
    await page.locator("#endGame").click();
    await page.waitForSelector("#resultsScreen.active");
    await page.locator("#again").click();
    await startIntro(page);
  }
  assert.equal(new Set(modes).size, 4);
  await page.locator("#stopRush").click();
  assert.equal(
    await page
      .locator("#homeScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  await browser.close();
});

test("dirty custom boards always expose at least five adult words", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#customGame").click();
  await page.locator('[data-custom-type="dirty"]').click();
  await page.locator('[data-custom-size="4"]').click();
  await page.locator("#customStart").click();
  await startIntro(page);
  const playable = await page.evaluate((words) => {
    const board = [...document.querySelectorAll(".tile")].map((tile) => tile.textContent);
    const size = 4;
    const neighbors = (index) => {
      const row = Math.floor(index / size), column = index % size, result = [];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nextRow = row + dr, nextColumn = column + dc;
          if ((dr || dc) && nextRow >= 0 && nextColumn >= 0 && nextRow < size && nextColumn < size)
            result.push(nextRow * size + nextColumn);
        }
      return result;
    };
    const hasPath = (word) => {
      const walk = (index, offset, used) => {
        if (offset === word.length) return true;
        return neighbors(index).some((next) => {
          if (used.has(next) || board[next] !== word[offset]) return false;
          const following = new Set(used).add(next);
          return walk(next, offset + 1, following);
        });
      };
      return board.some((letter, index) =>
        letter === word[0] && walk(index, 1, new Set([index])),
      );
    };
    return words.filter(hasPath);
  }, ["ASS", "BITCH", "COCK", "DAMN", "DICK", "HELL", "PISS", "SHIT", "SLUT", "TIT"]);
  assert.ok(playable.length >= 5, `expected five dirty words, found ${playable.join(", ")}`);
  await browser.close();
});

test("Party Mode keeps selected rules for the next solo round", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#partyMode").click();
  assert.equal(await page.locator("#partyDialog select").count(), 0);
  assert.equal(await page.locator("#partyDialog input").count(), 0);
  assert.equal(await page.locator(".party-grid-preview").count(), 3);
  assert.equal(await page.locator(".party-marquee span").count(), 5);
  await page.locator('[data-party-size="5"]').click();
  await page.locator('[data-party-min="4"]').click();
  await page.locator('[data-party-time="90"]').click();
  assert.equal(await page.locator('[data-party-size="5"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator('[data-party-min="4"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator('[data-party-time="90"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#partySummary").textContent(), "4+ letters · 5×5 · 01:30");
  await page.locator("#partyStart").click();
  await startIntro(page);
  assert.equal(await page.locator(".tile").count(), 25);
  assert.equal(await page.locator("#gameHint").textContent(), "Minimum 4 letters");
  await page.locator("#endGame").click();
  assert.match(await page.locator("#again").textContent(), /Continue party mode/);
  assert.equal(await page.locator("#exitParty").isHidden(), false);
  await page.locator("#again").click();
  assert.equal(await page.locator('[data-party-size="5"]').evaluate((node) => node.classList.contains("active")), true);
  assert.equal(await page.locator('[data-party-min="4"]').evaluate((node) => node.classList.contains("active")), true);
  assert.equal(await page.locator('[data-party-time="90"]').evaluate((node) => node.classList.contains("active")), true);
  await browser.close();
});

test("a pointer-traced Party Mode multiplayer word is accepted", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#sessionManage").click();
  await page.locator("#sessionCreate").click();
  await page.waitForFunction(() => /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent));
  await page.locator('#multiplayerDialog button[value="cancel"]').click();
  await page.locator("#partyMode").click();
  await page.locator('[data-party-size="4"]').click();
  await page.locator('[data-party-min="3"]').click();
  await page.locator('[data-party-time="60"]').click();
  await page.locator("#partyForm button[value=start]").click();
  await startIntro(page);
  const trail = await page.evaluate(async () => {
    const words = new Set(await (await fetch("/dictionary.json")).json());
    const letters = [...document.querySelectorAll(".tile")].map((tile) => tile.textContent);
    const size = Math.sqrt(letters.length);
    const near = (index) => Array.from({ length: letters.length }, (_, next) => next).filter((next) => next !== index && Math.abs(Math.floor(next / size) - Math.floor(index / size)) <= 1 && Math.abs(next % size - index % size) <= 1);
    const walk = (index, word, used, path) => {
      if (word.length >= 3 && words.has(word)) return path;
      if (word.length >= 8) return null;
      for (const next of near(index)) if (!used.has(next)) {
        const found = walk(next, word + letters[next], new Set([...used, next]), [...path, next]);
        if (found) return found;
      }
      return null;
    };
    for (let index = 0; index < letters.length; index++) {
      const found = walk(index, letters[index], new Set([index]), [index]);
      if (found) return found;
    }
    return null;
  });
  assert.ok(trail);
  const boxes = await Promise.all(trail.map((index) => page.locator(".tile").nth(index).boundingBox()));
  await page.mouse.move(boxes[0].x + boxes[0].width / 2, boxes[0].y + boxes[0].height / 2);
  await page.mouse.down();
  for (const box of boxes.slice(1)) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.up();
  await page.waitForFunction(() => Number(document.querySelector("#gameScore").textContent) > 0);
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
  await startIntro(page);
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
  await page.locator("#sessionManage").click();
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
  assert.equal(await page.locator("#lobbyPlayers .live-player").count(), 1);
  assert.match(await page.locator("#lobbyStatus").textContent(), /host/i);
  await page.locator("#sessionType").selectOption("coop");
  await page.locator("#sessionStart").click();
  await startIntro(page);
  assert.equal(await page.locator("#gameMode").textContent(), "CO-OP");
  assert.equal(await page.locator("#livePlayers .live-player").count(), 0);
  await page.locator("#gameBack").click();
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

test("a joining guest cannot fall through to solo play and the host can reopen the QR", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const host = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await Promise.all([host.goto(baseUrl), guest.goto(baseUrl)]);
  await host.locator("#sessionManage").click();
  await host.locator("#sessionCreate").click();
  await host.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const code = await host.locator("#sessionCode").textContent();

  await guest.locator("#sessionManage").click();
  await guest.evaluate((roomCode) => {
    window.prompt = () => roomCode;
    document.querySelector("#sessionJoin").click();
    document.querySelector("#multiplayerDialog").close();
    document.querySelector('[data-mode="classic"]').click();
  }, code);
  assert.equal(await guest.locator("#gameScreen").evaluate((node) => node.classList.contains("active")), false);
  await host.waitForFunction(() =>
    document.querySelector("#sessionPlayersText").textContent.includes("2 player"),
  );

  await guest.locator('#multiplayerDialog button[value="cancel"]').click();
  await guest.locator('[data-mode="classic"]').click();
  assert.equal(await guest.locator("#gameScreen").evaluate((node) => node.classList.contains("active")), false);
  assert.equal(await host.locator("#gameScreen").evaluate((node) => node.classList.contains("active")), false);

  await host.locator('#multiplayerDialog button[value="cancel"]').click();
  await host.locator("#multiplayerShare").click();
  assert.equal(await host.locator("#multiplayerDialog").evaluate((node) => node.open), true);
  await host.waitForFunction(() => document.querySelector("#sessionQr").naturalWidth > 0);
  assert.match(await host.locator("#sessionQr").getAttribute("src"), new RegExp("join=" + code));
  await browser.close();
});

test("main screen join QR remains available after a multiplayer round starts", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const host = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await host.goto(baseUrl);
  await host.locator("#sessionManage").click();
  await host.locator("#sessionCreate").click();
  await host.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const code = await host.locator("#sessionCode").textContent();
  await host.locator("#sessionType").selectOption("classic");
  await host.locator("#sessionStart").click();
  await startIntro(host);
  await host.locator("#gameBack").click();

  assert.equal(await host.locator("#multiplayerBanner").isVisible(), true);
  assert.match(await host.locator("#multiplayerShare").textContent(), /Join QR/);
  await host.locator("#multiplayerShare").click();
  await host.waitForFunction(() => document.querySelector("#sessionQr").naturalWidth > 0);
  assert.match(await host.locator("#sessionQr").getAttribute("src"), new RegExp("join=" + code));
  assert.match(await host.locator("#lobbyStatus").textContent(), /new players.*scan/i);
  await host.locator('#multiplayerDialog button[value="cancel"]').click();
  assert.equal(await host.locator("#resumeMultiplayer").isVisible(), true);
  await host.locator("#resumeMultiplayer").click();
  assert.equal(await host.locator("#gameScreen").isVisible(), true);

  const returningPlayer = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await returningPlayer.goto(baseUrl + "/?join=" + code);
  await returningPlayer.waitForSelector("#gameScreen.active");
  assert.equal(await returningPlayer.locator("#gameMode").textContent(), "CLASSIC");
  await browser.close();
});

test("leaving a solo round disposes its timer instead of finishing in the background", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await startClassic(page);
  await page.locator("#gameBack").click();
  await page.evaluate(() => window.end());
  assert.equal(await page.locator("#homeScreen").isVisible(), true);
  assert.equal(await page.locator("#resultsScreen").isVisible(), false);
  await browser.close();
});

test("refreshing finished multiplayer results does not count the round twice", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  const finish = () => page.evaluate(() => {
    const id = window.wordrushGuestId;
    window.wordrushOnlineFinish(
      [{ id, name: "Player", avatar: "🐈", score: 25, words: [] }],
      { roundId: "stable-round-id", gameSeconds: 30 },
    );
  });
  await finish();
  await page.reload();
  await finish();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("wordrush-profile")),
  );
  assert.equal(stored.rounds, 1);
  assert.equal(stored.score, 25);
  assert.deepEqual(stored.completedMultiplayerRounds, ["stable-round-id"]);
  await browser.close();
});

test("live multiplayer scores are equally prominent and color opponents differently", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const host = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await host.goto(baseUrl);
  await host.locator("#sessionManage").click();
  await host.locator("#sessionCreate").click();
  await host.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const code = await host.locator("#sessionCode").textContent();
  await guest.goto(baseUrl + "/?join=" + code);
  await host.waitForFunction(() =>
    document.querySelectorAll("#lobbyPlayers .live-player").length === 2,
  );
  await host.locator("#sessionType").selectOption("classic");
  await host.locator("#sessionStart").click();
  await Promise.all([
    startIntro(host),
    startIntro(guest),
  ]);
  const scores = await host.evaluate(() => {
    const own = getComputedStyle(document.querySelector("#gameScore"));
    const opponent = getComputedStyle(
      document.querySelector("#livePlayers .is-opponent b"),
    );
    const preview = getComputedStyle(document.querySelector("#preview"));
    return {
      ownSize: parseFloat(own.fontSize),
      opponentSize: parseFloat(opponent.fontSize),
      ownColor: own.color,
      opponentColor: opponent.color,
      previewSize: parseFloat(preview.fontSize),
    };
  });
  assert.equal(scores.opponentSize, scores.ownSize);
  assert.notEqual(scores.opponentColor, scores.ownColor);
  assert.ok(scores.previewSize >= 24);
  await browser.close();
});

test("Cast control stays disabled on an insecure origin", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#sessionManage").click();
  await page.locator("#sessionCreate").click();
  await page.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  assert.equal(await page.locator("#castControl").isHidden(), false);
  assert.equal(await page.locator("#castButton").isDisabled(), true);
  assert.match(
    await page.locator("#castStatus").textContent(),
    /secure Wordrush only/,
  );
  await browser.close();
});

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

test("a room deep link joins through the normal multiplayer flow", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const host = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await host.goto(baseUrl);
  await host.locator("#sessionManage").click();
  await host.locator("#sessionCreate").click();
  await host.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const code = await host.locator("#sessionCode").textContent();
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await guest.goto(baseUrl + "/?join=" + code);
  await guest.waitForFunction(
    (roomCode) => document.querySelector("#sessionCode").textContent === roomCode,
    code,
  );
  assert.equal(await guest.locator("#multiplayerDialog").evaluate((node) => node.open), true);
  assert.equal(await guest.locator("#sessionCode").textContent(), code);
  assert.equal(await guest.evaluate(() => location.search), "");
  await browser.close();
});

test("two-player lobby synchronizes roles and guest exit leaves the host room open", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const host = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await host.goto(baseUrl);
  await host.locator("#sessionManage").click();
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
  await host.locator("#sessionManage").click();
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

  await host.locator("#sessionType").selectOption("classic");
  await host.locator("#sessionStart").click();
  await Promise.all([
    startIntro(host),
    startIntro(guest),
  ]);
  await host.locator("#endGame").click();
  await Promise.all([
    host.waitForSelector("#resultsScreen.active"),
    guest.waitForSelector("#resultsScreen.active"),
  ]);

  await host.locator("#again").click();
  await Promise.all([
    startIntro(host),
    startIntro(guest),
  ]);
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
  await page.locator("#sessionManage").click();
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

test("banner X exits a newly created session from the landing page", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#sessionManage").click();
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

test("malformed saved profile values are normalized without breaking startup", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.evaluate(() => localStorage.setItem("wordrush-profile", JSON.stringify({
    name: 42,
    score: "broken",
    rounds: -10,
    days: null,
    completedMultiplayerRounds: {},
  })));
  await page.reload();
  assert.equal(await page.locator("#homeScore").textContent(), "0");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("wordrush-profile")));
  assert.deepEqual(stored.days, []);
  assert.equal(stored.rounds, 0);
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
  await startClassic(page);
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
      configuredTop: getComputedStyle(node).top,
      boardTop: board.top,
      clearOfBoard: toast.bottom <= board.top,
    };
  });
  assert.equal(inGameToast.configuredTop, "10px");
  assert.equal(inGameToast.clearOfBoard, true);
  await page.waitForTimeout(2500);
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
test("tracing animates selected tiles while keeping the saved trace line hidden", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await startClassic(page);
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
  assert.equal(
    await page
      .locator(".tile.selected")
      .evaluate((node) => getComputedStyle(node).animationName),
    "tile-selected",
  );
  assert.equal(
    await page
      .locator("#traceLayer")
      .evaluate((node) => getComputedStyle(node).visibility),
    "hidden",
  );
  await page.waitForFunction(() =>
    Boolean(document.querySelector("#tracePath").getAttribute("d")),
  );
  await page.waitForFunction(
    (background) =>
      getComputedStyle(document.querySelector(".tile.selected")).backgroundColor !==
      background,
    defaultTileStyle.background,
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
  assert.equal(await page.locator(".tile.word-incorrect").count(), 1);
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
  await startClassic(page);
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
  await startClassic(page);
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
  await startClassic(page);
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
        words: [{ word: "PLANETS", points: 49 }],
      },
      {
        id: "moon",
        name: "Moon",
        avatar: "🐈",
        score: 25,
        session: { wins: 1, losses: 2, points: 103 },
        words: [{ word: "STARS", points: 25 }],
      },
    ], { results: { view: "static", speed: "fast" } });
  });
  await page.waitForSelector("#resultsScreen.active");
  assert.equal(await page.locator(".result-player-card").count(), 2);
  assert.match(await page.locator("#resultLongestWord").textContent(), /PLANETS · 49 pts/);
  assert.match(await page.locator("#resultTopPlayer").textContent(), /Comet/);
  assert.match(await page.locator(".result-session-record").first().textContent(), /2W · 1L · 149 session pts/);
  assert.match(await page.locator(".result-session-record").nth(1).textContent(), /1W · 2L · 103 session pts/);
  const presentation = await page.evaluate(() => ({
    heroRadius: parseFloat(getComputedStyle(document.querySelector(".result-hero")).borderRadius),
    first: getComputedStyle(document.querySelector(".result-player-card.rank-1")).backgroundColor,
    second: getComputedStyle(document.querySelector(".result-player-card.rank-2")).backgroundColor,
  }));
  assert.ok(presentation.heroRadius >= 20);
  assert.notEqual(presentation.first, presentation.second);
  await page.locator("#animatedResultsButton").click();
  await page.waitForSelector(".reveal-word.word-length-long");
  assert.equal(await page.locator(".reveal-word.word-length-medium").count(), 1);
  assert.equal(await page.locator(".reveal-session-record").count(), 2);
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

test("Word Party is forced for every player and celebrates sudden death", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.evaluate(() => {
    const guestId = window.wordrushGuestId;
    window.wordrushOnlineRound(
      { board: Array(16).fill("A"), size: 4, endsAt: Date.now() + 60000 },
      { label: "SUDDEN DEATH", min: 3, rule: "One invalid word ends the round", sudden: true },
      "sudden",
    );
    window.wordrushOnlineFinish(
      [
        { id: guestId, name: "Nova", avatar: "🦊", score: 49, words: [{ word: "PLANETS", points: 49 }] },
        { id: "moon", name: "Moon", avatar: "🐈", score: 25, words: [{ word: "STARS", points: 25 }] },
        { id: "sun", name: "Sun", avatar: "🐸", score: 16, words: [{ word: "MOON", points: 16 }] },
      ],
      {
        reason: "invalid_word",
        suddenDeath: { playerId: "moon", playerName: "Moon", playerAvatar: "🐈", word: "ZZZ" },
        results: { view: "static", speed: "fast" },
      },
    );
  });
  await page.waitForSelector("#resultsScreen.active");
  assert.equal(await page.locator("#animatedResultsView").isHidden(), false);
  assert.equal(await page.locator("#staticResultsView").isHidden(), true);
  assert.equal(await page.locator(".reveal-player").count(), 3);
  assert.equal(await page.locator(".result-hero-score-card").count(), 2);
  assert.equal(
    await page.locator(".result-hero-score-card.is-winner").textContent(),
    "WINNER🦊 Nova49",
  );
  assert.match(await page.locator(".result-hero-scores").textContent(), /🐈 Moon25/);
  assert.match(await page.locator("#resultLongestWord").textContent(), /PLANETS · 49 pts · 🦊 Nova/);
  assert.match(await page.locator("#suddenDeathCallout").textContent(), /Moon/);
  assert.match(await page.locator("#suddenDeathCallout").textContent(), /ZZZ/);
  assert.equal(await page.locator("#suddenDeathExplosion").isHidden(), false);
  const revealLayout = await page.locator("#revealPlayers").evaluate((node) => ({
    maxHeight: getComputedStyle(node).maxHeight,
    overflow: getComputedStyle(node).overflow,
    thirdBottom: node.children[2].getBoundingClientRect().bottom,
  }));
  assert.equal(revealLayout.maxHeight, "none");
  assert.equal(revealLayout.overflow, "visible");
  assert.ok(revealLayout.thirdBottom > 0);
  await browser.close();
});
