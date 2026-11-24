// SP_E2E=1 node --test test/ui/test-scene.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
const SELECT = '[data-testid="test-scene-stage"]';
const VERSION = '[data-testid="test-scene-version"]';
const START = '[data-testid="test-scene-start"]';
const STOP = '[data-testid="test-scene-stop"]';
const EDITOR = '[data-testid="test-scene-editor"]';
const COMBAT = '[data-testid="test-scene-combat"]';
const chess = 'chess_char_1_02_a';
const item = 'chess_item_1_01_e_a';
const enemy = 'enemy_1000_gopro_2';

async function dragEl(page, fromSel, toSel) {
  const from = await page.$eval(fromSel, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const to = await page.$eval(toSel, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

async function commitWheel(page, key = 'ArrowRight') {
  await page.waitForSelector('.fwheel', { visible: true });
  await page.keyboard.press(key);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.fwheel'));
}

test('public test scene enters from the lobby, mirrors real-game prep/combat, supports DIY operators and boss scenes',
  { skip: !ENABLED && 'set SP_E2E=1 (Chrome)', timeout: 90000 }, async () => {
    const server = await startRealServer();
    const puppeteer = (await import('puppeteer-core')).default;
    const client = new Client(puppeteer, server.base, 'test scene', { w: 1280, h: 850, lobbyVersion: null });
    try {
      await client.open();
      await client.enter('试验');
      const { page } = client;
      await page.evaluateOnNewDocument(() => {
        if (location.pathname === '/test-scene.html') globalThis.__SP_RENDER__ = 'fallback';
      });
      const entry = '[data-testid="test-scene-entry"]';
      await page.waitForSelector(entry, { visible: true });
      await Promise.all([page.waitForNavigation(), page.click(entry)]);
      await page.waitForSelector(`${EDITOR} .ff-tile[data-row="10"][data-col="4"]`);
      assert.equal(await page.$eval(VERSION, el => el.value), 'act3autochess@V3_1', 'defaults to lobby version 规程·序列Ⅰ');
      assert.equal(await page.$eval(SELECT, el => el.value), 'act3autochess_m01');
      assert.equal(await page.$eval(SELECT, el => el.options.length), 20, '10 normal + 10 boss maps in 规程');

      // Verify 规程·序列Ⅰ operator 云迹 is present in the catalogue.
      await page.click('.ts-kinds [data-kind="chess"]');
      const regSearch = await page.$('.ts-search');
      await regSearch.click({ count: 3 });
      await page.keyboard.type('云迹');
      await page.waitForSelector('.ts-pick[data-char="char_4165_ctrail"]');

      // Switch to 第二期下半 (act2autochess) via the version selector and verify full prep/combat workflow.
      await page.select(VERSION, 'act2autochess');
      await page.waitForFunction(() => document.querySelector('[data-testid="test-scene-stage"]')?.value === 'act1autochess_m01');
      await page.waitForSelector(`${EDITOR} .ff-tile[data-row="10"][data-col="4"]`);
      assert.equal(await page.$eval(SELECT, el => el.options.length), 16, '8 normal + 8 boss maps in 盟约');
      assert.equal(await page.$eval(START, el => el.disabled), true);

      // Sidebar and live scene must sit side-by-side without overlapping.
      const layout = await page.evaluate(() => {
        const side = document.querySelector('.ts-sidebar').getBoundingClientRect();
        const stage = document.querySelector('.ts-stage').getBoundingClientRect();
        return { sideRight: side.right, stageLeft: stage.left, stageW: stage.width, stageH: stage.height };
      });
      assert.ok(layout.sideRight <= layout.stageLeft + 1, `sidebar overlapped stage: ${JSON.stringify(layout)}`);
      assert.ok(layout.stageW > 600 && layout.stageH > 400);

      const pick = async (kind, id) => {
        await page.click(`.ts-kinds [data-kind="${kind}"]`);
        const search = await page.$('.ts-search');
        await search.click({ clickCount: 3 });
        await page.keyboard.type(id);
        await page.click(`.ts-pick[data-record="${id}"]`);
      };
      const tile = (row, col) => `.ff-tile[data-row="${row}"][data-col="${col}"]`;

      // First-entry enemy placement works immediately on ground tiles.
      await pick('enemy', enemy);
      await page.click(tile(9, 8));
      await page.waitForSelector(`.ff-piece--map-char[data-piece="${enemy}"][data-row="9"][data-col="8"]`);
      await page.click(tile(9, 9));
      await page.waitForSelector(`.ff-piece--map-char[data-piece="${enemy}"][data-row="9"][data-col="9"]`);
      await page.click('.ts-hint button');

      // Clicking a placed enemy opens DetailPanel + Underframe to remove it.
      await page.click(`.ff-piece--map-char[data-piece="${enemy}"][data-row="9"][data-col="9"]`);
      await page.waitForSelector('.dpanel--enemy');
      await page.waitForSelector('.uframe__btn--destroy');
      await page.click('.uframe__btn--destroy');
      await page.waitForFunction(() => !document.querySelector('.ff-piece--map-char[data-row="9"][data-col="9"]'));

      // Operator goes to bench (hand), equipment goes to equipment area (temp).
      await pick('chess', chess);
      await page.waitForSelector(`.ff-piece[data-area="hand"][data-piece="${chess}"]`);
      assert.equal(await page.$eval('[data-testid="test-scene-hand-count"]', el => el.textContent.trim()), '1 / 10');
      await pick('item', item);
      await page.waitForSelector(`.ff-piece[data-area="temp"][data-piece="${item}"]`);
      assert.equal(await page.$eval('[data-testid="test-scene-temp-count"]', el => el.textContent.trim()), '1 / 5');
      assert.equal(await page.$eval('[data-testid="test-scene-hand-count"]', el => el.textContent.trim()), '1 / 10');

      // Drag equipment onto bench operator -> equips!
      await dragEl(page, `.ff-piece[data-area="temp"][data-piece="${item}"]`, `.ff-piece[data-area="hand"][data-piece="${chess}"]`);
      await page.waitForFunction(() => !document.querySelector('.ff-piece[data-area="temp"]'));

      // Drag operator onto illegal tile -> refused; drag onto legal board tile -> FacingWheel opens & commits!
      await dragEl(page, `.ff-piece[data-area="hand"][data-piece="${chess}"]`, tile(9, 2));
      await page.waitForSelector('.ts-error');
      await dragEl(page, `.ff-piece[data-area="hand"][data-piece="${chess}"]`, tile(10, 4));
      await commitWheel(page, 'ArrowLeft');
      await page.waitForSelector(`.ff-piece[data-area="board"][data-piece="${chess}"][data-row="10"][data-col="4"].ff-dir--left`);

      // Drag second equipment onto deployed board operator -> equips!
      await pick('item', item);
      await page.waitForSelector(`.ff-piece[data-area="temp"][data-piece="${item}"]`);
      await dragEl(page, `.ff-piece[data-area="temp"][data-piece="${item}"]`, tile(10, 4));
      await page.waitForFunction(() => !document.querySelector('.ff-piece[data-area="temp"]'));

      // Clicking deployed operator opens DetailPanel (with 2 equipped items) + Underframe (retreat & destroy).
      await page.click(`.ff-piece[data-area="board"][data-piece="${chess}"][data-row="10"][data-col="4"]`);
      await page.waitForSelector('.dpanel--chess');
      await page.waitForSelector('.uframe__btn--retreat');
      await page.waitForSelector('.uframe__btn--destroy');
      assert.equal(await page.$$eval('[data-testid="unequip"]', els => els.length), 2);

      // Fill bench to 10/10 and verify bench-full refusal; fill equipment area to 5/5 and verify equip-full refusal.
      for (let i = 0; i < 10; i++) await pick('chess', chess);
      assert.equal(await page.$eval('[data-testid="test-scene-hand-count"]', el => el.textContent.trim()), '10 / 10');
      await pick('chess', chess);
      await page.waitForSelector('.ts-error');
      assert.match(await page.$eval('.ts-error', el => el.textContent), /整备区已满/);
      for (let i = 0; i < 5; i++) await pick('item', item);
      assert.equal(await page.$eval('[data-testid="test-scene-temp-count"]', el => el.textContent.trim()), '5 / 5');
      await pick('item', item);
      await page.waitForSelector('.ts-error');
      assert.match(await page.$eval('.ts-error', el => el.textContent), /装备区已满/);

      // Start combat, verify battle runs, stop -> deployed operator stays on board with its items intact!
      const running = () => page.waitForFunction(() => Number(document.querySelector('[data-testid="test-scene-time"]')?.dataset.time) >= 0.2);
      await page.click(START);
      await running();
      await page.waitForSelector(`${COMBAT} .ts-field[data-renderer="fallback"] .ff-unit.is-enemy`);
      assert.equal(await page.$(EDITOR), null);
      await page.click(STOP);
      await page.waitForSelector(EDITOR);
      await page.waitForSelector(`.ff-piece[data-area="board"][data-piece="${chess}"][data-row="10"][data-col="4"]`);
      assert.equal(await page.$$eval('.ff-piece[data-area="hand"]', els => els.length), 10);
      assert.equal(await page.$$eval('.ff-piece[data-area="temp"]', els => els.length), 5);

      // Switching map during combat clears everything cleanly.
      await page.click(START);
      await running();
      await page.select(SELECT, 'act1autochess_m02');
      await page.waitForSelector(EDITOR);
      assert.equal(await page.$eval(SELECT, el => el.value), 'act1autochess_m02');
      assert.equal(await page.$eval(START, el => el.disabled), true);
      assert.equal(await page.$$eval('.ff-piece, .ff-piece--map-char', els => els.length), 0);

      // Switch to Boss-exclusive scene (最终攻势), search & deploy 赤刃明霄陈 + a second Yan operator to activate 炎 bond,
      // double-click the active bond to edit layers, pick an official Boss (custom enemies disabled), run & stop battle.
      await page.select(SELECT, 'act1autochess_m01:boss');
      await page.waitForSelector(`${EDITOR} .ff-tile[data-row="10"][data-col="4"]`);
      await page.click('.ts-kinds [data-kind="chess"]');
      const diySearch = await page.$('.ts-search');
      await diySearch.click({ clickCount: 3 });
      await page.keyboard.type('赤刃明霄陈');
      await page.waitForSelector('.ts-pick[data-char="char_1050_chen3"]');
      await page.click('.ts-pick[data-char="char_1050_chen3"]');
      await page.waitForSelector('.ff-piece[data-area="hand"][data-char="char_1050_chen3"]');
      await dragEl(page, '.ff-piece[data-area="hand"][data-char="char_1050_chen3"]', tile(10, 4));
      await commitWheel(page, 'ArrowRight');
      await page.waitForSelector('.ff-piece[data-area="board"][data-char="char_1050_chen3"][data-row="10"][data-col="4"]');
      await page.click('.ff-piece[data-area="board"][data-char="char_1050_chen3"][data-row="10"][data-col="4"]');
      await page.waitForSelector('.dpanel--chess');
      assert.match(await page.$eval('.dhead__name', el => el.textContent), /赤刃明霄陈/);

      // Deploy two 精准 (preciShip) operators to activate the bond, then double-click the active bond to edit layers.
      await page.click('.dpanel__close');
      await pick('chess', 'chess_char_1_09_a');
      await page.waitForSelector('.ff-piece[data-area="hand"][data-piece="chess_char_1_09_a"]');
      await dragEl(page, '.ff-piece[data-area="hand"][data-piece="chess_char_1_09_a"]', tile(10, 3));
      await commitWheel(page, 'ArrowRight');
      await pick('chess', 'chess_char_1_17_a');
      await page.waitForSelector('.ff-piece[data-area="hand"][data-piece="chess_char_1_17_a"]');
      await dragEl(page, '.ff-piece[data-area="hand"][data-piece="chess_char_1_17_a"]', tile(11, 4));
      await commitWheel(page, 'ArrowRight');
      await page.waitForSelector('[data-testid="test-scene-bonds"] .bslot.is-active');
      const activeBondEl = await page.$('[data-testid="test-scene-bonds"] .bslot.is-active .bond');
      const activeBondId = await page.$eval('[data-testid="test-scene-bonds"] .bslot.is-active', el => el.dataset.bond);
      await activeBondEl.click({ count: 2 });
      await page.waitForSelector('[data-testid="test-scene-layer-modal"]');
      await page.click('[data-testid="test-scene-layer-input"]', { clickCount: 3 });
      await page.keyboard.type('123');
      await page.click('[data-testid="test-scene-layer-confirm"]');
      await page.waitForFunction(id => document.querySelector(`[data-testid="test-scene-bonds"] .bslot[data-bond="${id}"] .bond__count`)?.textContent?.trim() === '123', {}, activeBondId);

      // In Boss stage, the enemy tab shows official selectable Bosses (no custom enemy search/placement).
      await page.click('.ts-kinds [data-kind="enemy"]');
      await page.waitForSelector('[data-testid="test-scene-boss-panel"]');
      assert.equal(await page.$('.ts-search'), null, 'custom enemy search is hidden in Boss stage');
      await page.click('[data-boss="boss_1"]');
      await page.waitForSelector('[data-testid="test-scene-boss-summary"]');
      await page.click(START);
      await running();
      await page.waitForFunction(() => /领袖生命/.test(document.querySelector('[data-testid="test-scene-time"]')?.textContent || ''));
      await page.click(STOP);
      await page.waitForSelector('.ff-piece[data-area="board"][data-char="char_1050_chen3"][data-row="10"][data-col="4"]');
      assert.deepEqual(client.problems.filter(line => line.startsWith('pageerror:')), []);

      await Promise.all([page.waitForNavigation(), page.click('.ts-header a')]);
      await page.waitForSelector(entry);
      await Promise.all([page.waitForNavigation(), page.click(entry)]);
      await page.waitForSelector(EDITOR);
      assert.equal(await page.$eval(SELECT, el => el.value), 'act3autochess_m01');
    } finally {
      await client.close();
      await server.stop();
    }
  });

test('a test scene with missing data can retry in place and runs simplified rendering without art assets',
  { skip: !ENABLED && 'set SP_E2E=1 (Chrome)', timeout: 60000 }, async () => {
    const server = await startRealServer();
    const puppeteer = (await import('puppeteer-core')).default;
    const client = new Client(puppeteer, server.base, 'test scene retry');
    try {
      await client.open();
      const { page } = client;
      await page.evaluateOnNewDocument(() => {
        if (location.pathname === '/test-scene.html') globalThis.__SP_RENDER__ = 'fallback';
      });
      await page.setBypassServiceWorker(true);
      await page.setRequestInterception(true);
      let unavailable = true;
      page.on('request', r => {
        const pathname = new URL(r.url()).pathname;
        if (unavailable && pathname.endsWith('/stages.json')) return r.respond({ status: 404 });
        if (pathname === '/data/assets.json' || pathname === '/data/local-assets.json' || pathname.startsWith('/assets/')) {
          return r.respond({ status: 404 });
        }
        return r.continue();
      });
      await page.goto(`${server.base}/test-scene.html`);
      await page.waitForSelector('.ts-boot [role="alert"]');
      unavailable = false;
      await page.click('.ts-boot button');
      await page.waitForSelector(`${EDITOR} .ff-tile[data-row="9"][data-col="8"]`);
      assert.equal(await page.$eval(SELECT, el => el.value), 'act1autochess_m01');
      await page.waitForSelector('.ts-pick .ts-portrait svg');
      await page.click('.ts-kinds [data-kind="enemy"]');
      const search = await page.$('.ts-search');
      await search.click({ clickCount: 3 });
      await page.keyboard.type(enemy);
      await page.click(`.ts-pick[data-record="${enemy}"]`);
      await page.click('.ff-tile[data-row="9"][data-col="8"]');
      await page.click(START);
      await page.waitForSelector('.ts-field[data-renderer="fallback"] .ff-unit.is-enemy');
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="test-scene-time"]')?.dataset.time) >= 0.2);
      assert.deepEqual(client.problems.filter(line => line.startsWith('pageerror:')), []);
    } finally {
      await client.close();
      await server.stop();
    }
  });
