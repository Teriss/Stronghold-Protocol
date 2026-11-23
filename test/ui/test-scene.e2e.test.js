// SP_E2E=1 node --test test/ui/test-scene.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
const SELECT = '[data-testid="test-scene-stage"]';
const START = '[data-testid="test-scene-start"]';
const STOP = '[data-testid="test-scene-stop"]';
const EDITOR = '[data-testid="test-scene-editor"]';
const chess = 'chess_char_1_02_a';
const item = 'chess_item_1_01_e_a';
const enemy = 'enemy_1000_gopro_2';

test('public test scene enters from the lobby, fights locally, stops, and resets on a map change',
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
      await page.waitForSelector(EDITOR);
      assert.equal(await page.$eval(SELECT, el => el.value), 'act1autochess_m01');
      assert.equal(await page.$eval(SELECT, el => el.options.length), 8);
      assert.equal(await page.$eval(START, el => el.disabled), true);

      const pick = async (kind, id) => {
        await page.click(`.ts-kinds [data-kind="${kind}"]`);
        const search = await page.$('.ts-search');
        await search.click({ clickCount: 3 });
        await page.keyboard.type(id);
        await page.click(`.ts-pick[data-record="${id}"]`);
      };
      const tile = (row, col) => `.ts-cell[data-row="${row}"][data-col="${col}"]`;
      await pick('chess', chess);
      await pick('item', item);
      await page.click(`.ts-slot[data-piece="${chess}"]`);
      await page.waitForSelector(`[data-equipped="${item}"]`);
      await page.click(tile(9, 2));
      await page.waitForSelector('.ts-error');
      await page.click(tile(10, 4));
      await page.waitForSelector(`${tile(10, 4)}[data-piece="${chess}"]`);
      await pick('item', item);
      await page.click(tile(10, 4));
      assert.equal(await page.$$eval(`[data-equipped="${item}"]`, els => els.length), 2);
      await pick('enemy', enemy);
      await page.click(tile(9, 8));
      await page.waitForSelector(`${tile(9, 8)}[data-piece="${enemy}"]`);
      await page.click(tile(9, 9));
      await page.waitForSelector(`${tile(9, 9)}[data-piece="${enemy}"]`);
      await page.click('.ts-hint button');
      await page.click(tile(9, 9));
      await page.waitForSelector('[data-testid="test-scene-selection"] button');
      await page.click('[data-testid="test-scene-selection"] .ts-selection__actions button');
      assert.equal(await page.$(`${tile(9, 9)}[data-piece]`), null);

      for (let i = 0; i < 10; i++) await pick('chess', chess);
      assert.equal(await page.$eval('[data-testid="test-scene-hand-count"]', el => el.textContent.trim()), '10 / 10');
      await pick('item', item);
      await page.waitForSelector('.ts-error');
      assert.match(await page.$eval('.ts-error', el => el.textContent), /整备区已满/);
      assert.equal(await page.$eval('[data-testid="test-scene-hand-count"]', el => el.textContent.trim()), '10 / 10');

      const running = () => page.waitForFunction(() => Number(document.querySelector('[data-testid="test-scene-time"]')?.dataset.time) >= 0.2);
      await page.click(START);
      await running();
      await page.waitForSelector('.ts-combat__field[data-renderer="fallback"] .ff-unit.is-enemy');
      assert.equal(await page.$(EDITOR), null);
      await page.click(STOP);
      await page.waitForSelector(EDITOR);
      assert.equal(await page.$$eval('.ts-cell[data-piece]', els => els.length), 2);
      assert.equal(await page.$$eval('.ts-slot[data-piece]', els => els.length), 10);
      await page.click(tile(10, 4));
      assert.equal(await page.$$eval(`[data-equipped="${item}"]`, els => els.length), 2);

      await page.click(START);
      await running();
      await page.select(SELECT, 'act1autochess_m02');
      await page.waitForSelector(EDITOR);
      assert.equal(await page.$eval(SELECT, el => el.value), 'act1autochess_m02');
      assert.equal(await page.$eval(START, el => el.disabled), true);
      assert.equal(await page.$$eval('.ts-cell[data-piece], .ts-slot[data-piece], [data-equipped]', els => els.length), 0);
      assert.equal(await page.$('.ts-combat'), null);
      await pick('enemy', enemy);
      await page.click(tile(9, 3));
      await page.click(START);
      await page.waitForSelector('[data-testid="test-scene-result"]');
      assert.match(await page.$eval('[data-testid="test-scene-result"]', el => el.textContent), /已结束/);
      assert.equal(await page.$eval(STOP, el => el.textContent.trim()), '返回布置');
      await page.click(STOP);
      await page.waitForSelector('.ts-cell[data-side="enemy"]');
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
      await page.waitForSelector(EDITOR);
      assert.equal(await page.$eval(SELECT, el => el.value), 'act1autochess_m01');
      await page.waitForSelector('.ts-pick .ts-portrait svg');
      await page.click('.ts-kinds [data-kind="enemy"]');
      const search = await page.$('.ts-search');
      await search.click({ clickCount: 3 });
      await page.keyboard.type(enemy);
      await page.click(`.ts-pick[data-record="${enemy}"]`);
      await page.click('.ts-cell[data-row="9"][data-col="8"]');
      await page.click(START);
      await page.waitForSelector('.ts-combat__field[data-renderer="fallback"] .ff-unit.is-enemy');
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="test-scene-time"]')?.dataset.time) >= 0.2);
      assert.deepEqual(client.problems.filter(line => line.startsWith('pageerror:')), []);
    } finally {
      await client.close();
      await server.stop();
    }
  });
