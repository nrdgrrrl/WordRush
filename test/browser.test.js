const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
process.env.RANDOM_RUSH_DELAY = '50';
const { server } = require('../server');

const executablePath = process.env.PLAYWRIGHT_CHROMIUM || '/home/victoria/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
let baseUrl;
test.before(() => new Promise(resolve => server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; resolve(); })));
test.after(() => new Promise(resolve => server.close(resolve)));

test('browser can start, play, persist stats, and toggle dark mode', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('#quickPlay').click();
  assert.equal(await page.locator('#gameScreen').evaluate(node => node.classList.contains('active')), true);
  assert.equal(await page.locator('.tile').count(), 16);

  const path = await page.evaluate(async () => {
    const dictionary = new Set(await (await fetch('/dictionary.json')).json());
    const prefixes = new Set();
    for (const word of dictionary) for (let i = 1; i < word.length; i++) prefixes.add(word.slice(0, i));
    const letters = [...document.querySelectorAll('.tile')].map(tile => tile.textContent);
    const size = Math.sqrt(letters.length);
    const near = index => { const row = Math.floor(index / size), col = index % size, result = []; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const r = row + dr, c = col + dc; if ((dr || dc) && r >= 0 && c >= 0 && r < size && c < size) result.push(r * size + c); } return result; };
    function walk(index, word, used, trail) {
      if (word.length >= 3 && dictionary.has(word)) return { word, trail };
      if (word.length >= 8 || !prefixes.has(word)) return null;
      for (const next of near(index)) if (!used.has(next)) { used.add(next); const found = walk(next, word + letters[next], used, trail.concat(next)); if (found) return found; used.delete(next); }
      return null;
    }
    for (let index = 0; index < letters.length; index++) { const found = walk(index, letters[index], new Set([index]), [index]); if (found) return found; }
    return null;
  });
  assert.ok(path);
  for (const index of path.trail) { const box = await page.locator('.tile').nth(index).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); if (index === path.trail[0]) await page.mouse.down(); }
  await page.mouse.up();
  assert.ok(Number(await page.locator('#gameScore').textContent()) > 0);
  await page.locator('#endGame').click();
  await page.locator('[data-screen="homeScreen"]').last().click();
  assert.ok(Number(await page.locator('#homeWords').textContent()) > 0);
  await page.locator('#navStats').click();
  assert.equal(await page.locator('#statsGrid .stat-card').count(), 12);
  assert.match(await page.locator('[data-stat="averageWordLength"] strong').textContent(), /^\d+\.\d$/);
  await page.locator('[data-screen="homeScreen"]').first().click();
  assert.equal(await page.locator('#multiplayerButton').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(245, 243, 238)');
  assert.equal(await page.locator('#multiplayerButton').evaluate(node => getComputedStyle(node).color), 'rgb(29, 29, 27)');
  await page.locator('#themeToggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('#multiplayerButton').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(17, 19, 17)');
  assert.equal(await page.locator('#multiplayerButton').evaluate(node => getComputedStyle(node).color), 'rgb(243, 241, 234)');
  assert.deepEqual(errors, []);
  await browser.close();
});

test('random rush starts by touch and the board stays inside the phone viewport', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(baseUrl);
    await page.locator('#randomPanel').click();
    assert.equal(await page.locator('#gameScreen').evaluate(node => node.classList.contains('active')), true);
    const layout = await page.evaluate(() => {
      const grid = document.querySelector('.grid').getBoundingClientRect();
      return { scrollHeight: document.documentElement.scrollHeight, viewport: innerHeight, right: grid.right, bottom: grid.bottom, nav: getComputedStyle(document.querySelector('nav')).display };
    });
    assert.equal(layout.scrollHeight, viewport.height);
    assert.ok(layout.right <= viewport.width);
    assert.ok(layout.bottom <= viewport.height);
    assert.equal(layout.nav, 'none');
    await page.close();
  }
  await browser.close();
});

test('sudden death can return home from its results screen', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator('[data-mode="sudden"]').click();
  const tile = await page.locator('.tile').first().boundingBox();
  await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#resultsScreen').evaluate(node => node.classList.contains('active')), true);
  await page.locator('#resultsScreen [data-screen="homeScreen"]').click();
  assert.equal(await page.locator('#homeScreen').evaluate(node => node.classList.contains('active')), true);
  await browser.close();
});

test('custom game controls start the selected configuration', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator('#customGame').click();
  await page.locator('#customType').selectOption('classic');
  await page.locator('#customRules').selectOption('classic');
  await page.locator('#customMin').fill('6');
  await page.locator('#customBoard').selectOption('8');
  await page.locator('#customTime').fill('45');
  await page.locator('#customStart').click();
  assert.equal(await page.locator('#gameScreen').evaluate(node => node.classList.contains('active')), true);
  assert.equal(await page.locator('.tile').count(), 64);
  assert.equal(await page.locator('#gameHint').textContent(), 'Minimum 6 letters');
  assert.equal(await page.locator('#ruleBanner').textContent(), 'Minimum 6 letters · 45 seconds');
  await browser.close();
});

test('random rush rolls into a different game and can be stopped', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.evaluate(() => { window.wordrushRushDelay = 50; });
  await page.locator('#randomPanel').click();
  const firstMode = await page.locator('#gameMode').textContent();
  await page.locator('#endGame').click();
  await page.waitForTimeout(120);
  assert.equal(await page.locator('#gameScreen').evaluate(node => node.classList.contains('active')), true);
  assert.notEqual(await page.locator('#gameMode').textContent(), firstMode);
  await page.locator('#stopRush').click();
  assert.equal(await page.locator('#homeScreen').evaluate(node => node.classList.contains('active')), true);
  await browser.close();
});

test('the Random Rush preview panel starts the rush while reload only rerolls it', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  const before = await page.locator('#randomPreview').textContent();
  await page.locator('#reroll').click();
  assert.equal(await page.locator('#homeScreen').evaluate(node => node.classList.contains('active')), true);
  const after = await page.locator('#randomPreview').textContent();
  assert.ok(after.length > 0);
  await page.locator('#randomPanel').click();
  assert.equal(await page.locator('#gameScreen').evaluate(node => node.classList.contains('active')), true);
  await browser.close();
});

test('multiplayer creates a five-letter session and launches co-op', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator('#multiplayerButton').click();
  await page.locator('#sessionCreate').click();
  await page.waitForFunction(() => /^[A-Z]{5}$/.test(document.querySelector('#sessionCode').textContent));
  assert.equal(await page.locator('#sessionCode').textContent().then(code => code.length), 5);
  assert.equal(await page.locator('#multiplayerBanner').isHidden(), false);
  await page.locator('#sessionType').selectOption('coop');
  await page.locator('#sessionStart').click();
  await page.waitForSelector('#gameScreen.active');
  assert.equal(await page.locator('#gameMode').textContent(), 'CO-OP');
  assert.equal(await page.locator('#livePlayers .live-player').count(), 1);
  await page.locator('#gameScreen [data-screen="homeScreen"]').click();
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#exitMultiplayer').click();
  await page.waitForFunction(() => document.querySelector('#multiplayerBanner').hidden);
  assert.equal(await page.locator('#homeScreen').evaluate(node => node.classList.contains('active')), true);
  await browser.close();
});

test('multiplayer banner disappears when its connection is lost', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator('#multiplayerButton').click();
  assert.equal(await page.locator('#multiplayerBanner').evaluate(node => getComputedStyle(node).display), 'none');
  await page.locator('#sessionCreate').click();
  await page.waitForFunction(() => /^[A-Z]{5}$/.test(document.querySelector('#sessionCode').textContent));
  assert.equal(await page.locator('#multiplayerBanner').isHidden(), false);
  await page.evaluate(() => window.wordrushSocket.close());
  await page.waitForFunction(() => document.querySelector('#multiplayerBanner').hidden);
  assert.equal(await page.locator('#homeScreen').evaluate(node => node.classList.contains('active')), true);
  await browser.close();
});

test('banner X exits a newly created session from the landing page', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator('#multiplayerButton').click();
  assert.equal(await page.locator('#multiplayerBanner').evaluate(node => getComputedStyle(node).display), 'none');
  await page.locator('#sessionCreate').click();
  await page.waitForFunction(() => /^[A-Z]{5}$/.test(document.querySelector('#sessionCode').textContent));
  await page.locator('#multiplayerDialog button[value="cancel"]').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#exitMultiplayer').click();
  await page.waitForFunction(() => document.querySelector('#multiplayerBanner').hidden);
  assert.equal(await page.locator('#multiplayerBanner').evaluate(node => getComputedStyle(node).display), 'none');
  assert.equal(await page.locator('#multiplayerBannerText').textContent(), 'No active session');
  assert.equal(await page.locator('#roomTitle').textContent(), 'No active session');
  assert.equal(await page.locator('#homeScreen').evaluate(node => node.classList.contains('active')), true);
  await browser.close();
});

test('browser profile uses a generated identity and saves a selected avatar', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const initial = await page.locator('#profileButton').textContent();
  assert.notEqual(initial, 'JD');
  await page.locator('#profileButton').click();
  assert.equal(await page.locator('#profileDialog').evaluate(dialog => dialog.open), true);
  await page.locator('#profileName').fill('CosmicPaw');
  await page.locator('[data-avatar="🦊"]').click();
  await page.locator('#profileForm .dialog-save').click();
  assert.equal(await page.locator('#profileButton').textContent(), '🦊');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wordrush-profile')).name), 'CosmicPaw');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wordrush-profile')).avatar), '🦊');
  await page.locator('#profileButton').click();
  await page.locator('[data-avatar="🐯"]').click();
  await page.locator('#profileForm .dialog-save').click();
  await page.reload();
  assert.equal(await page.locator('#profileButton').textContent(), '🐯');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wordrush-profile')).avatar), '🐯');
  await browser.close();
});

test('browser exposes the expanded avatar set and unlocks achievement toasts', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  assert.equal(await page.evaluate(() => window.wordrushAchievementCatalog.length), 204);
  await page.locator('#profileButton').click();
  assert.equal(await page.locator('[data-avatar]').count(), 36);
  await page.locator('#profileForm [value="cancel"]').click();
  await page.evaluate(() => {
    const profile = JSON.parse(localStorage.getItem('wordrush-profile'));
    profile.words = 1;
    profile.score = 0;
    profile.rounds = 0;
    profile.streak = 0;
    profile.unlocked = [];
    localStorage.setItem('wordrush-profile', JSON.stringify(profile));
    window.wordrushAchievementEvent();
  });
  assert.match(await page.locator('#toast').textContent(), /First blood/);
  assert.match(await page.locator('#achievementCount').textContent(), /[1-9] \/ 204/);
  await browser.close();
});
test('tracing animates selected tiles and clears them with the trace line', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  await page.locator('#quickPlay').click();
  const tile = await page.locator('.tile').first().boundingBox();
  const point = { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
  await page.mouse.move(point.x, point.y);
  const defaultTileStyle = await page.locator('.tile').first().evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
  await page.mouse.down();
  assert.equal(await page.locator('.tile.selected').count(), 1);
  await page.waitForFunction(() => Boolean(document.querySelector('#tracePath').getAttribute('d')));
  assert.equal(await page.locator('.tile').first().evaluate(node => getComputedStyle(node).color), defaultTileStyle.color);
  assert.notEqual(await page.locator('.tile').first().evaluate(node => getComputedStyle(node).backgroundColor), defaultTileStyle.background);
  assert.notEqual(await page.locator('#tracePath').getAttribute('d'), null);
  await page.mouse.up();
  assert.equal(await page.locator('.tile.selected').count(), 1);
  assert.notEqual(await page.locator('#tracePath').getAttribute('d'), null);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.tile.selected').count(), 0);
  assert.equal(await page.locator('#tracePath').getAttribute('d'), null);
  await browser.close();
});
