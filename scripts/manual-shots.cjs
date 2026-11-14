// Takes the screenshots used in the user manual, from the real built app.
// Used by scripts/make-manual.cjs; run `npm run build` first.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'tests', 'out');
const PORT = 4191;

module.exports = async function shots(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const server = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'pipe' });
  await new Promise((res) => server.stdout.on('data', (d) => String(d).includes('localhost') && res()));
  const browser = await chromium.launch();
  const callouts = {};
  const W = 1280;
  const H = 800;
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5, serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      delete window.showOpenFilePicker;
      delete window.showSaveFilePicker;
    });
    const page = await ctx.newPage();
    const shot = async (name, opts = {}) => {
      await page.evaluate(() => document.getElementById('toasts')?.replaceChildren());
      return page.screenshot({ path: path.join(outDir, name + '.jpg'), type: 'jpeg', quality: 84, ...opts });
    };
    const rect = async (sel) => {
      const r = await page.locator(sel).first().boundingBox();
      if (!r) return null;
      // Use the part of the element that is on screen.
      const y0 = Math.max(0, r.y);
      const y1 = Math.min(H, r.y + r.height);
      return { x: (r.x + r.width / 2) / W, y: (y0 + y1) / 2 / H };
    };
    const ready = async () => {
      await page.evaluate(() => document.getElementById('splash')?.remove());
      await page.waitForTimeout(600);
    };
    const open = async (file) => {
      const sel = (await page.locator('#home').isVisible()) ? '.home-action:has-text("Open")' : '.toolbar button[title^="Open"]';
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
      await fc.setFiles(file);
    };
    const esc = () => page.keyboard.press('Escape');

    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.home-action');
    await ready();
    await shot('home-empty');

    // A converted Word file in a second tab makes the tab bar look like real use.
    await open(path.join(FIX, 'contract.docx'));
    await page.waitForFunction(() => window.__app.docs.length === 1 && document.querySelector('.page canvas'), null, { timeout: 90000 });
    await open(path.join(FIX, 'fixture.pdf'));
    await page.waitForFunction(() => window.__app.docs.length === 2 && document.querySelector('.page .textLayer span'));
    await page.evaluate(() => {
      const d = window.__app.doc;
      d.change('annots', () => {
        d.pages[0].annots = [
          { id: 'h1', type: 'highlight', rects: [{ x: 58, y: 112, w: 255, h: 16 }], color: '#ffe14d' },
          { id: 'n1', type: 'note', x: 470, y: 112, text: 'Confirm the delivery date', color: '#f5b301' },
          { id: 'r1', type: 'rect', x: 320, y: 236, w: 150, h: 42, color: '#d92d20', sw: 2, fill: null },
          { id: 't1', type: 'text', x: 60, y: 330, w: 260, h: 22, text: 'Approved by finance, 14 Nov', size: 14, family: 'sans', color: '#0e7c74', angle: 0 },
          { id: 'i1', type: 'ink', paths: [[[62, 380], [90, 366], [118, 384], [146, 362], [174, 380], [198, 368]]], color: '#1d6fe0', sw: 2.5 },
        ];
      });
      d.dirty = false;
      d.emit('meta');
    });
    await page.fill('.annotationLayer input[type="text"]', 'Maria Santos');
    await page.waitForTimeout(900);
    await shot('workspace');
    callouts.workspace = {
      tabs: await rect('.tab.on'),
      sidebar: await rect('.sidebar .side-tabs'),
      file: await rect('.toolbar button[aria-label="Save as… (Ctrl+Shift+S)"]'),
      tools: await rect('.toolbar [data-tool="pen"]'),
      pages: await rect('.toolbar .btn:has-text("Pages")'),
      more: await rect('.toolbar button[title="More actions"]'),
      help: await rect('#help-btn'),
      page: await rect('.page'),
    };

    await page.click('.toolbar [data-tool="highlight"]');
    await page.waitForTimeout(200);
    await shot('markup', { clip: { x: 0, y: 0, width: W, height: 330 } });
    await esc();

    await page.click('.toolbar [data-tool="edittext"]');
    await page.waitForSelector('.linebox');
    await page.waitForTimeout(200);
    await shot('edittext', { clip: { x: 0, y: 0, width: W, height: 420 } });
    await page.click('.toolbar [data-tool="select"]');

    await page.click('.toolbar button[title="Sign"]');
    await page.waitForSelector('canvas.sigpad');
    const pad = await page.locator('canvas.sigpad').boundingBox();
    await page.mouse.move(pad.x + 40, pad.y + 110);
    await page.mouse.down();
    const pts = [[80, 60], [110, 140], [150, 70], [190, 130], [240, 80], [280, 120], [330, 90], [390, 110], [460, 85]];
    for (const [x, y] of pts) await page.mouse.move(pad.x + (x * pad.width) / 600, pad.y + (y * pad.height) / 220, { steps: 6 });
    await page.mouse.up();
    await shot('signature');
    await esc();

    await page.click('.toolbar .btn:has-text("Pages")');
    await page.waitForSelector('.org-cell canvas');
    await page.locator('.org-cell').nth(1).click();
    await page.waitForTimeout(500);
    await shot('organize', { clip: { x: 0, y: 0, width: W, height: 470 } });
    await page.click('.org-done');

    await page.click('.toolbar button[aria-label^="Export"]');
    await page.waitForSelector('.export-grid');
    await shot('export');
    await esc();

    await page.click('.toolbar button[title="More actions"]');
    await page.waitForSelector('.menu');
    await shot('more-menu', { clip: { x: W - 520, y: 0, width: 520, height: 620 } });
    await esc();

    await page.keyboard.press('Control+f');
    await page.fill('#search-input', 'invoice');
    await page.waitForSelector('.result');
    await page.waitForTimeout(400);
    await shot('search', { clip: { x: 0, y: 0, width: 760, height: 560 } });

    await page.click('#help-btn');
    await page.waitForSelector('.menu');
    await shot('help-menu', { clip: { x: W - 420, y: 0, width: 420, height: 260 } });
    await esc();

    await page.click('.topbar button[aria-label="New tab"]');
    await page.waitForSelector('.recent-thumb img');
    await page.waitForTimeout(300);
    await shot('home');

    const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await phone.addInitScript(() => delete window.showOpenFilePicker);
    const mp = await phone.newPage();
    await mp.goto(`http://localhost:${PORT}/`);
    await mp.waitForSelector('.home-action');
    await mp.evaluate(() => document.getElementById('splash')?.remove());
    const [mfc] = await Promise.all([mp.waitForEvent('filechooser'), mp.click('.home-action:has-text("Open")')]);
    await mfc.setFiles(path.join(FIX, 'fixture.pdf'));
    await mp.waitForSelector('.page .textLayer span');
    await mp.click('.toolbar button[aria-label="Show or hide the sidebar"]');
    await mp.waitForSelector('.sidebar.strip .thumb canvas');
    await mp.waitForTimeout(500);
    await mp.screenshot({ path: path.join(outDir, 'phone.jpg'), type: 'jpeg', quality: 84 });
  } finally {
    await browser.close();
    server.kill();
  }
  fs.writeFileSync(path.join(outDir, 'callouts.json'), JSON.stringify(callouts, null, 2));
  return callouts;
};
