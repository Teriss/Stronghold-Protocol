// SP_E2E=1 node --test test/ui/test-scene.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
const SELECT = '[data-testid="test-scene-stage"]';
const START = '[data-testid="test-scene-start"]';
const STOP = '[data-testid="test-scene-stop"]';
const EDITOR = '[data-testid="test-scene-editor"]';
const COMBAT = '[data-testid="test-scene-combat"]';
const chess = 'chess_char_1_02_a';
const item = 'chess_item_1_01_e_a';
const enemy = 'enemy_1000_gopro_2';

test('public test scene enters from the lobby, edits in-scene, fights locally, stops, and resets on a map change',
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
      assert.equal(await page.$eval(SELECT, el => el.value), 'act1autochess_m01');
      assert.equal(await page.$eval(SELECT, el => el.options.length), 8);
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
      await pick('chess', chess);
      await page.waitForSelector(`.ff-piece[data-area="hand"][data-piece="${chess}"]`);
      await pick('item', item);
      await page.click(`.ff-piece[data-area="hand"][data-piece="${chess}"]`);
      await page.waitForSelector(`[data-equipped="${item}"]`);
      await page.click(tile(9, 2));
      await page.waitForSelector('.ts-error');
      await page.click(tile(10, 4));
      await page.waitForSelector(`.ff-piece[data-area="board"][data-piece="${chess}"][data-row="10"][data-col="4"]`);
      await pick('item', item);
      await page.click(`.ff-piece[data-area="board"][data-piece="${chess}"][data-row="10"][data-col="4"]`);
      assert.equal(await page.$$eval(`[data-equipped="${item}"]`, els => els.length), 2);
      await pick('enemy', enemy);
      await page.click(tile(9, 8));
      await page.waitForSelector(`.ff-piece--map-char[data-piece="${enemy}"][data-row="9"][data-col="8"]`);
      await page.click(tile(9, 9));
      await page.waitForSelector(`.ff-piece--map-char[data-piece="${enemy}"][data-row="9"][data-col="9"]`);
      await page.click('.ts-hint button');
      await page.click(`.ff-piece--map-char[data-piece="${enemy}"][data-row="9"][data-col="9"]`);
      await page.waitForSelector('[data-testid="test-scene-selection"] .ts-selection__actions button');
      await page.click('[data-testid="test-scene-selection"] .ts-selection__actions button');
      await page.waitForFunction(() => !document.querySelector('.ff-piece--map-char[data-row="9"][data-col="9"]'));

      for (let i = 0; i < 10; i++) await pick('chess', chess);
      assert.equal(await page.$eval('[data-testid="test-scene-hand-count"]', el => el.textContent.trim()), '10 / 10');
      await pick('item', item);
      await page.waitForSelector('.ts-error');
      assert.match(await page.$eval('.ts-error', el => el.textContent), /整备区已满/);
      assert.equal(await page.$eval('[data-testid="test-scene-hand-count"]', el => el.textContent.trim()), '10 / 10');

      const running = () => page.waitForFunction(() => Number(document.querySelector('[data-testid="test-scene-time"]')?.dataset.time) >= 0.2);
      await page.click(START);
      await running();
      await page.waitForSelector(`${COMBAT} .ts-field[data-renderer="fallback"] .ff-unit.is-enemy`);
      assert.equal(await page.$(EDITOR), null);
      await page.click(STOP);
      await page.waitForSelector(EDITOR);
      assert.equal(await page.$$eval('.ff-piece[data-area="board"], .ff-piece--map-char', els => els.length), 2);
      assert.equal(await page.$$eval('.ff-piece[data-area="hand"]', els => els.length), 10);
      await page.click(`.ff-piece[data-area="board"][data-piece="${chess}"][data-row="10"][data-col="4"]`);
      assert.equal(await page.$$eval(`[data-equipped="${item}"]`, els => els.length), 2);

      await page.click(START);
      await running();
      await page.select(SELECT, 'act1autochess_m02');
      await page.waitForSelector(EDITOR);
      assert.equal(await page.$eval(SELECT, el => el.value), 'act1autochess_m02');
      assert.equal(await page.$eval(START, el => el.disabled), true);
      assert.equal(await page.$$eval('.ff-piece, [data-equipped]', els => els.length), 0);
      assert.equal(await page.$(COMBAT), null);
      await pick('enemy', enemy);
      await page.click(tile(9, 3));
      await page.click(START);
      await page.waitForSelector('[data-testid="test-scene-result"]');
      assert.match(await page.$eval('[data-testid="test-scene-result"]', el => el.textContent), /已结束/);
      assert.equal(await page.$eval(STOP, el => el.textContent.trim()), '返回布置');
      await page.click(STOP);
      await page.waitForSelector(`.ff-piece--map-char[data-piece="${enemy}"][data-row="9"][data-col="3"]`);

      // Verify DIY operators (e.g. 赤刃明霄陈) can be searched, added, deployed and simulated in-scene.
      await page.click('.ts-kinds [data-kind="chess"]');
      const diySearch = await page.$('.ts-search');
      await diySearch.click({ clickCount: 3 });
      await page.keyboard.type('赤刃明霄陈');
      const chenBtn = '.ts-pick[data-char="char_1050_chen3"]';
      await page.waitForSelector(chenBtn);
      await page.click(chenBtn);
      await page.waitForSelector('.ff-piece[data-area="hand"][data-char="char_1050_chen3"]');
      await page.click(tile(10, 4));
      await page.waitForSelector('.ff-piece[data-area="board"][data-char="char_1050_chen3"][data-row="10"][data-col="4"]');
      await page.click(START);
      await running();
      await page.click(STOP);
      await page.waitForSelector('.ff-piece[data-area="board"][data-char="char_1050_chen3"][data-row="10"][data-col="4"]');
      assert.deepEqual(client.problems.filter(line => line.startsWith('pageerror:')), []);

      await Promise.all([page.waitForNavigation(), page.click('.ts-header a')]);
      await page.waitForSelector(entry);
      await Promise.all([page.waitForNavigation(), page.click(entry)]);
      await page.waitForSelector(EDITOR);
      assert.equal(await page.$eval(SELECT, el => el.value), 'act1autochess_m01');
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
        if (unavailable && pathname === '/data/stages.json') return r.respond({ status: 404 });
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
