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
            const fixture = window.__wordrushBrowserBoardFixture;
            if (fixture?.size === size)
              return { ok: true, board: [...fixture.board] };
            return originalGenerate(size, prepared, options);
          },
        });
      },
    });
  });
}
async function setBoardFixture(page, fixture) {
  await page.evaluate((nextFixture) => {
    window.__wordrushBrowserBoardFixture = nextFixture;
  }, fixture);
}
async function resetSoloBrowserPage(page, fixture) {
  await page.addInitScript((nextFixture) => {
    window.__wordrushBrowserBoardFixture = nextFixture;
  }, fixture);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
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

test("random rush rolls into a different game and can be stopped", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.evaluate(() => {
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
    const resultHeading = await page.locator("#resultName").textContent();
    assert.match(resultHeading, /^Up next: /);
    const upcoming = resultHeading.replace(/^Up next:\s*/, "");
    await page.locator("#again").click();
    await page.waitForSelector("#roundIntroScreen.active");
    assert.equal(await page.locator("#introMode").textContent(), upcoming);
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
  await setBoardFixture(page, {
    size: 4,
    board: ["X", "X", "X", "X", "M", "A", "P", "X", "X", "X", "X", "X", "X", "X", "X", "X"],
  });
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
    const original = Date.now;
    Date.now = () => {
      if (new Error().stack?.includes("app.js:896")) {
        Date.now = original;
        throw new Error("intentional browser deadline-check failure");
      }
      return original();
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

test("room recovers after consent cancellation and starts classic", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator("#sessionManage").click();
  await page.locator("#sessionCreate").click();
  await page.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  await page.locator('#multiplayerDialog button[value="cancel"]').click();
  await page.evaluate(() => {
    window.__sentMessages = [];
    const original = window.wordrushSocket.send.bind(window.wordrushSocket);
    window.wordrushSocket.send = function (message) {
      window.__sentMessages.push(JSON.parse(message));
      return original(message);
    };
  });
  await page.evaluate(() => {
    window.wordrushStartSessionGame({ mode: "dirty" });
  });
  await page.waitForTimeout(50);
  const consentSent = await page.evaluate(() =>
    window.__sentMessages.some((msg) => msg.type === "start_game"),
  );
  assert.equal(consentSent, true);
  await page.locator("#sessionManage").click();
  await page.waitForFunction(() =>
    !document.querySelector("#sessionLobby").hidden,
  );
  await page.locator("#sessionType").selectOption("coop");
  await page.locator("#sessionStart").click();
  await startIntro(page);
  assert.equal(await page.locator("#gameMode").textContent(), "CO-OP");
  await browser.close();
});

test("late join during consent sees pre-admission panel", async () => {
  const host = await chromium.launch({ headless: true, executablePath });
  const guest = await chromium.launch({ headless: true, executablePath });
  const hostPage = await host.newPage({ viewport: { width: 390, height: 844 } });
  const guestPage = await guest.newPage({ viewport: { width: 390, height: 844 } });
  await Promise.all([hostPage.goto(baseUrl), guestPage.goto(baseUrl)]);
  await hostPage.locator("#sessionManage").click();
  await hostPage.locator("#sessionCreate").click();
  await hostPage.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const code = await hostPage.locator("#sessionCode").textContent();
  await hostPage.locator('#multiplayerDialog button[value="cancel"]').click();
  await hostPage.evaluate(() => {
    window.wordrushStartSessionGame({ mode: "dirty" });
  });
  await hostPage.waitForTimeout(50);
  assert.equal(
    await hostPage
      .locator("#gameScreen")
      .evaluate((node) => node.classList.contains("active")),
    false,
  );
  await guestPage.locator("#sessionManage").click();
  guestPage.once("dialog", (dialog) => dialog.accept(code));
  await guestPage.locator("#sessionJoin").click();
  const prePanelVisible = await guestPage.locator("#preAdmissionPanel").evaluate((node) => !node.hidden);
  assert.equal(prePanelVisible, true);
  const lobbyHidden = await guestPage.locator("#sessionLobby").evaluate((node) => node.hidden);
  assert.equal(lobbyHidden, true);
  await hostPage.locator("#sessionManage").click();
  await hostPage.waitForFunction(() =>
    !document.querySelector("#sessionLobby").hidden,
  );
  await hostPage.locator("#sessionType").selectOption("classic");
  await hostPage.locator("#sessionStart").click();
  await startIntro(hostPage);
  assert.equal(
    await hostPage
      .locator("#gameScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  await host.close();
  await guest.close();
});

test("solo dirty mode still works with confirmation dialog", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator('[data-mode="dirty"]').click();
  await startIntro(page);
  assert.equal(
    await page
      .locator("#gameScreen")
      .evaluate((node) => node.classList.contains("active")),
    true,
  );
  assert.equal(await page.locator(".tile").count(), 25);
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
  assert.equal(await page.locator("#staticResultsView").isHidden(), false);
  assert.equal(await page.locator("#animatedResultsView").isHidden(), true);
  assert.equal(await page.locator("#staticResultsButton").getAttribute("aria-pressed"), "true");
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
  assert.equal(await page.locator("#animatedResultsView").isHidden(), false);
  assert.equal(await page.locator("#staticResultsView").isHidden(), true);
  assert.equal(await page.locator("#animatedResultsButton").getAttribute("aria-pressed"), "true");
  await page.waitForSelector(".reveal-word.word-length-long");
  assert.equal(await page.locator(".reveal-word.word-length-medium").count(), 1);
  assert.equal(await page.locator(".reveal-session-record").count(), 2);
  await browser.close();
});
