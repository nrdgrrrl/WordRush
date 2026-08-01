const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
// Leave enough time for all three browsers to observe the results screen before
// the intentionally automatic Random Rush transition begins.
process.env.RANDOM_RUSH_DELAY = "1500";
process.env.WORDRUSH_LEADERBOARD_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "wordrush-soak-")),
  "leaderboard.json",
);
const { server, rooms } = require("../server");

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM ||
  "/home/victoria/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
let baseUrl;
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
test.after(
  () =>
    new Promise((resolve) => {
      for (const room of rooms.values())
        room.players.forEach((player) => player.ws.close());
      rooms.clear();
      server.close(resolve);
    }),
);

async function traceWord(page, skip = 0) {
  const trail = await page.evaluate(async (skip) => {
    const words = new Set(await (await fetch("/dictionary.json")).json()),
      letters = [...document.querySelectorAll(".tile")].map(
        (tile) => tile.textContent,
      ),
      size = Math.sqrt(letters.length),
      minimum = Number(
        document.querySelector("#gameHint").textContent.match(/\d+/)?.[0] || 3,
      );
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
    const foundWords = [];
    function walk(index, word, used, path) {
      if (word.length >= minimum && words.has(word)) {
        foundWords.push(path);
        return foundWords.length > skip ? path : null;
      }
      if (word.length >= 8) return null;
      for (const next of near(index))
        if (!used.has(next)) {
          used.add(next);
          const found = walk(
            next,
            word + letters[next],
            used,
            path.concat(next),
          );
          if (found) return found;
          used.delete(next);
        }
      return null;
    }
    for (let i = 0; i < letters.length; i++) {
      const found = walk(i, letters[i], new Set([i]), [i]);
      if (found && foundWords.length > skip) return found;
    }
    return foundWords[skip] || null;
  }, skip);
  if (!trail) return;
  for (const [position, index] of trail.entries()) {
    const box = await page.locator(".tile").nth(index).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    if (position === 0) await page.mouse.down();
  }
  await page.mouse.up();
}

test(
  "three Playwright clients complete every multiplayer mode except custom",
  { timeout: 90000 },
  async () => {
    const browser = await chromium.launch({ headless: true, executablePath });
    const pages = await Promise.all(
      ["Host", "GuestOne", "GuestTwo"].map(async (name, index) => {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        await page.goto(baseUrl);
        await page.locator("#profileButton").click();
        await page.locator("#profileName").fill(name);
        await page
          .locator("[data-avatar]")
          .nth(index + 1)
          .click();
        await page.locator("#profileForm .dialog-save").click();
        return page;
      }),
    );
    const host = pages[0];
    await host.locator("#sessionManage").click();
    await host.locator("#sessionCreate").click();
    await host.waitForFunction(() =>
      /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
    );
    const code = await host.locator("#sessionCode").textContent();
    for (const guest of pages.slice(1)) {
      await guest.locator("#sessionManage").click();
      guest.once("dialog", (dialog) => dialog.accept(code));
      await guest.locator("#sessionJoin").click();
      await guest.waitForFunction(
        () => !document.querySelector("#sessionLobby").hidden,
      );
    }
    await host.waitForFunction(() =>
      document
        .querySelector("#sessionPlayersText")
        .textContent.includes("3 player"),
    );
    let firstRound = true;
    for (const mode of [
      "classic",
      "minimum",
      "sudden",
      "race",
      "coop",
      "random",
    ]) {
      if (mode === "minimum")
        await host.locator('#homeScreen [data-mode="minimum"]').click();
      else {
        if (!firstRound) await host.locator("#sessionManage").click();
        await host.locator("#sessionType").selectOption(mode);
        await host.locator("#sessionStart").click();
        if (mode === "random") {
          assert.equal(
            await host.locator("#randomRushChoiceDialog").evaluate(
              (dialog) => dialog.open,
            ),
            true,
          );
          await host.locator("#randomRushKeepClean").click();
        }
      }
      firstRound = false;
      await Promise.all(
        pages.map((page) => startIntro(page)),
      );
      if (mode === "classic") {
        assert.equal(await host.locator("#endGame").isHidden(), false);
        assert.equal(await pages[1].locator("#endGame").isHidden(), true);
      }
      await Promise.all(pages.map((page, index) => traceWord(page, index)));
      await host.locator("#endGame").click();
      await Promise.all(
        pages.map((page) => page.waitForSelector("#resultsScreen.active")),
      );
      if (mode === "classic") {
        for (const page of pages) {
          assert.ok(
            Number(await page.locator("#finalScore").textContent()) > 0,
          );
          assert.ok(
            Number(await page.locator("#resultWordCount").textContent()) > 0,
          );
        }
        await pages[0].locator("#animatedResultsButton").click();
        await Promise.all(
          pages.map((page) =>
            page.waitForFunction(
              () => !document.querySelector("#animatedResultsView").hidden,
            ),
          ),
        );
        await host.locator('[data-speed="fast"]').click();
        await Promise.all(
          pages.map((page) =>
            page.waitForFunction(() =>
              document
                .querySelector('[data-speed="fast"]')
                .classList.contains("active"),
            ),
          ),
        );
        await Promise.all(
          pages.map((page) =>
            page.waitForFunction(
              () =>
                document.querySelectorAll(".reveal-word").length > 0 &&
                Number(
                  document
                    .querySelector("#revealTotal")
                    .textContent.replaceAll(",", ""),
                ) > 0,
            ),
          ),
        );
      }
      if (mode === "random") break;
      else
        await Promise.all(
          pages.map(async (page) => {
            await page
              .locator('#resultsScreen [data-screen="homeScreen"]')
              .click();
            await page.waitForSelector("#homeScreen.active");
          }),
        );
    }
    await Promise.all(pages.map((page) => page.close()));
    await browser.close();
  },
);

test("refreshing the creator resumes the room for connected guests", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const host = await browser.newPage();
  const guest = await browser.newPage();
  await Promise.all([host.goto(baseUrl), guest.goto(baseUrl)]);
  await host.locator("#sessionManage").click();
  await host.locator("#sessionCreate").click();
  await host.waitForFunction(() =>
    /^[A-Z]{5}$/.test(document.querySelector("#sessionCode").textContent),
  );
  const code = await host.locator("#sessionCode").textContent();
  await guest.locator("#sessionManage").click();
  guest.once("dialog", (dialog) => dialog.accept(code));
  await guest.locator("#sessionJoin").click();
  await guest.waitForFunction(() =>
    document
      .querySelector("#sessionPlayersText")
      .textContent.includes("2 player"),
  );
  await host.reload();
  await host.waitForFunction(
    () =>
      window.wordrushSessionCode &&
      document.querySelector("#sessionPlayersText").textContent.includes("2 player"),
  );
  assert.equal(await host.locator("#sessionCode").textContent(), code);
  assert.equal(await guest.locator("#multiplayerBanner").isHidden(), false);
  assert.equal(rooms.has(code), true);
  await browser.close();
});
