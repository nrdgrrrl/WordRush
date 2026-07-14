const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
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
  await page.locator('#themeToggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.deepEqual(errors, []);
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
  await page.locator('.dialog-save').click();
  assert.equal(await page.locator('#profileButton').textContent(), '🦊');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wordrush-profile')).name), 'CosmicPaw');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wordrush-profile')).avatar), '🦊');
  await browser.close();
});

test('browser exposes the expanded avatar set and unlocks achievement toasts', async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl);
  assert.equal(await page.evaluate(() => window.wordrushAchievementCatalog.length), 204);
  await page.locator('#profileButton').click();
  assert.equal(await page.locator('[data-avatar]').count(), 36);
  await page.locator('[value="cancel"]').click();
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
