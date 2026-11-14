// End-to-end smoke test: drives the built web app in headless Chromium.
// Run `npm run build` first, then `npm test`.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, 'out');
const PORT = 4188;
const URL_ = `http://localhost:${PORT}/`;
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
};

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  await new Promise((res) => server.stdout.on('data', (d) => String(d).includes('localhost') && res()));
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 }, acceptDownloads: true, serviceWorkers: 'block' });
    // Headless Chromium cannot drive the native file pickers, so use the <input type=file> path.
    await ctx.addInitScript(() => {
      delete window.showOpenFilePicker;
      delete window.showSaveFilePicker;
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => (console.log('  [pageerror]', e.message), errors.push('pageerror: ' + e.message)));
    page.on('console', (m) => ['error', 'warning'].includes(m.type()) && (console.log('  [' + m.type() + ']', m.text().slice(0, 300)), m.type() === 'error' && errors.push('console: ' + m.text())));
    await page.goto(URL_);
    await page.waitForSelector('.home-action');
    await page.screenshot({ path: path.join(OUT, '01-home.png') });

    const open = async (file) => {
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click((await page.locator('#home').isVisible()) ? '.home-action' : '.toolbar button[title^="Open"]')]);
      await fc.setFiles(file);
    };
    await open(path.join(OUT, 'fixture.pdf'));
    await page.waitForSelector('.page .textLayer span');
    check('opens a PDF and renders pages', (await page.locator('.page').count()) === 3);
    await page.screenshot({ path: path.join(OUT, '02-open.png') });

    // Page coordinates (PDF points on page 1) -> screen. Re-measured each time because the options
    // row appears and disappears as tools change.
    const at = async (x, y) => {
      const box = await page.locator('.page').first().boundingBox();
      const S = await page.evaluate(() => window.__app.viewer.scale);
      return [box.x + x * S, box.y + y * S];
    };
    const tool = (id) => page.click(`.toolbar [data-tool="${id}"]`);
    const drag = async (x1, y1, x2, y2) => {
      await page.mouse.move(...(await at(x1, y1)));
      await page.mouse.down();
      await page.mouse.move(...(await at((x1 + x2) / 2, (y1 + y2) / 2)), { steps: 4 });
      await page.mouse.move(...(await at(x2, y2)), { steps: 4 });
      await page.mouse.up();
    };
    const annots = () => page.evaluate(() => window.__app.doc.pages[0].annots.map((a) => a.type));

    // fill the form
    await page.fill('.annotationLayer input[type="text"]', 'Maria Santos');
    await page.check('.annotationLayer input[type="checkbox"]');

    // highlight by selecting text
    await tool('highlight');
    await drag(62, 118, 300, 118);
    await page.waitForTimeout(100);
    check('highlight from text selection', (await annots()).includes('highlight'));

    await tool('rect');
    await drag(350, 300, 500, 380);
    await tool('ellipse');
    await drag(350, 400, 500, 460);
    await tool('arrow');
    await drag(100, 420, 300, 470);
    await tool('pen');
    await drag(100, 500, 300, 540);
    await tool('whiteout');
    await drag(60, 155, 330, 172);
    {
      const got = await annots();
      check('shapes, ink and whiteout', ['rect', 'ellipse', 'arrow', 'ink'].every((t) => got.includes(t)) && got.filter((t) => t === 'rect').length === 2, got.join(','));
    }

    // add text
    await tool('text');
    await page.mouse.click(...(await at(80, 650)));
    await page.keyboard.type('Reviewed by finance');
    await page.keyboard.press('Escape');
    check('text box', await page.evaluate(() => window.__app.doc.pages[0].annots.some((a) => a.type === 'text' && a.text === 'Reviewed by finance')));

    // non-Latin text goes through the raster fallback (the text tool stays active after Escape)
    await page.mouse.click(...(await at(80, 700)));
    await page.keyboard.type('日本語 ✓ Привет');
    await page.keyboard.press('Escape');

    // edit an existing line
    await tool('edittext');
    await page.waitForSelector('.linebox');
    const lb = page.locator('.linebox').first();
    await lb.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Annual report, page 1');
    await page.keyboard.press('Enter');
    const te = await page.evaluate(() => window.__app.doc.pages[0].annots.find((a) => a.type === 'textedit'));
    check('edit existing text', te && te.text === 'Annual report, page 1', te && `${te.family} bold=${te.bold} size=${te.size.toFixed(1)} bg=${te.bg} fg=${te.color}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // note
    await tool('note');
    await page.mouse.click(...(await at(480, 120)));
    await page.fill('#note-text', 'Check this figure');
    await page.click('dialog .btn.primary');
    check('sticky note', (await annots()).includes('note'));

    // image + signature via the viewer API (pickers are native)
    await page.evaluate(() => window.__app.viewer.scrollToPage(0));
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 80;
      const g = c.getContext('2d');
      g.strokeStyle = '#1d3fae';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(10, 60);
      g.bezierCurveTo(60, -20, 90, 120, 190, 20);
      g.stroke();
      window.__app.viewer.placeImage(c.toDataURL('image/png'), 200, 80, 170);
    });
    check('place image', (await annots()).includes('image'));

    // undo / redo
    const n1 = (await annots()).length;
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    const n2 = (await annots()).length;
    await page.keyboard.press('Control+y');
    check('undo and redo', n2 === n1 - 1 && (await annots()).length === n1);
    await page.screenshot({ path: path.join(OUT, '03-annotated.png') });

    // organize: rotate page 2, duplicate page 3, reorder
    await page.click('.toolbar .btn:has-text("Pages")');
    await page.waitForSelector('.org-cell');
    await page.locator('.org-cell').nth(1).click();
    await page.click('.org-bar button[title="Rotate right"]');
    await page.locator('.org-cell').nth(1).click();
    await page.locator('.org-cell').nth(2).click();
    await page.click('.org-bar button[title="Duplicate"]');
    check('rotate and duplicate', await page.evaluate(() => window.__app.doc.pages.length === 4 && window.__app.doc.pages[1].rot === 90));
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '04-organize.png') });
    await page.click('.org-done');

    // annotate the rotated page too, to exercise the rotation transform on save
    await page.evaluate(() => window.__app.viewer.scrollToPage(1));
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const d = window.__app.doc;
      const p = d.pages[1];
      d.change('annots', () => {
        p.annots = [
          { id: 'r1', type: 'rect', x: 20, y: 20, w: 120, h: 60, color: '#16803c', sw: 3, fill: null },
          { id: 't1', type: 'text', x: 30, y: 30, w: 100, h: 20, text: 'Top left', size: 14, family: 'sans', color: '#16803c', angle: 0 },
        ];
      });
    });

    // save -> download
    const save = async () => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
      const p = path.join(OUT, 'saved-' + Date.now() + '.pdf');
      await dl.saveAs(p);
      return p;
    };
    const saved = await save();
    check('saves a file', fs.statSync(saved).size > 2000, fs.statSync(saved).size + ' bytes');

    // verify the saved file with pdf-lib
    const { PDFDocument } = await import('@cantoo/pdf-lib');
    const out = await PDFDocument.load(fs.readFileSync(saved));
    check('saved page count', out.getPageCount() === 4);
    check('saved rotation', out.getPage(1).getRotation().angle === 90);
    const form = out.getForm();
    check('form text saved', form.getTextField('customer.name').getText() === 'Maria Santos');
    check('form checkbox saved', form.getCheckBox('approved').isChecked());
    const annotsOut = out.getPage(0).node.Annots();
    check('note saved as a real PDF annotation', annotsOut && annotsOut.size() >= 3);

    // reopen the saved file and look at it
    await open(saved);
    await page.waitForFunction(() => window.__app.docs.length === 2 && document.querySelectorAll('.page .textLayer span').length > 3);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, '05-reopened.png') });
    const text = await page.evaluate(async () => {
      const d = window.__app.doc;
      const src = [...new Set(d.pages.map((p) => p.src))][0];
      const pdf = (await import('/assets/' + [...document.scripts].map((s) => s.src).find((s) => /index-/.test(s)).split('/').pop())).catch?.(() => null);
      return null;
    }).catch(() => null);
    void text;
    const txt = await page.evaluate(() => [...document.querySelectorAll('.page')][0].querySelector('.textLayer').textContent);
    check('edited text is in the saved file', txt.includes('Annual report, page 1') && txt.includes('Reviewed by finance'), txt.slice(0, 80));
    await page.evaluate(() => window.__app.viewer.scrollToPage(1));
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, '06-rotated-page.png') });

    // search
    await page.keyboard.press('Control+f');
    await page.fill('#search-input', 'invoice');
    await page.waitForSelector('.result');
    check('search finds matches', (await page.locator('.result').count()) === 4);
    await page.screenshot({ path: path.join(OUT, '07-search.png') });

    // redact + password
    await page.evaluate(() => window.__app.viewer.scrollToPage(0));
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const d = window.__app.doc;
      d.change('annots', () => (d.pages[0].annots = [{ id: 'x', type: 'redact', x: 55, y: 110, w: 300, h: 22 }]));
      d.protect = { password: 'secret' };
    });
    const [dl2] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await page.keyboard.press('Control+s');
        await page.click('dialog .btn.danger');
      })(),
    ]);
    const prot = path.join(OUT, 'protected.pdf');
    await dl2.saveAs(prot);
    let needsPw = false;
    try {
      await PDFDocument.load(fs.readFileSync(prot));
    } catch {
      needsPw = true;
    }
    check('password protection applied', needsPw);
    const dec = await PDFDocument.load(fs.readFileSync(prot), { password: 'secret' });
    check('protected file opens with the password', dec.getPageCount() === 4);
    {
      // Page 1 was redacted, so neither its original text nor the edits drawn on it may survive
      // anywhere in the file, including in objects no page points to.
      const { PDFRawStream, decodePDFRawStream } = await import('@cantoo/pdf-lib');
      const needles = ['page 1', Buffer.from('page 1').toString('hex').toUpperCase(), 'Reviewed', Buffer.from('Reviewed').toString('hex').toUpperCase()];
      let leak = '';
      let streams = 0;
      for (const [ref, obj] of dec.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFRawStream)) continue;
        streams++;
        let t = '';
        try {
          t = Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
        } catch {}
        const hit = needles.find((n) => t.includes(n));
        if (hit) leak = `${ref.tag}: ${hit}`;
      }
      check('no trace of the redacted page is left inside the file', !leak && streams > 3, leak || streams + ' streams scanned');
    }
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click((await page.locator('#home').isVisible()) ? '.home-action' : '.toolbar button[title^="Open"]')]);
    await fc.setFiles(prot);
    await page.fill('#pw-open', 'secret');
    await page.click('dialog .btn.primary');
    await page.waitForFunction(() => window.__app.docs.length === 3);
    await page.waitForSelector('.page canvas');
    await page.waitForTimeout(800);
    const rtxt = await page.evaluate(() => [...document.querySelectorAll('.page')][0].querySelector('.textLayer')?.textContent || '');
    check('redacted text is gone from the file', !rtxt.includes('quick brown fox'), JSON.stringify(rtxt.slice(0, 60)));
    await page.screenshot({ path: path.join(OUT, '08-redacted.png') });

    // ---- extras: OCR, autosave recovery, exports ----
    {
      const p2 = await ctx.newPage();
      await p2.setViewportSize({ width: 800, height: 1000 });
      await p2.setContent('<body style="margin:60px;font:28px Georgia,serif;background:#fff;color:#111"><p>Lease agreement for unit 14B</p><p>Monthly rent is 18,500 pesos payable on the fifth.</p><p>Signed in Quezon City.</p></body>');
      const shot = await p2.screenshot({ type: 'png' });
      await p2.close();
      const scan = await PDFDocument.create();
      const img = await scan.embedPng(shot);
      scan.addPage([600, 750]).drawImage(img, { x: 0, y: 0, width: 600, height: 750 });
      const scanPath = path.join(OUT, 'scan.pdf');
      fs.writeFileSync(scanPath, await scan.save());
      await open(scanPath);
      await page.waitForFunction(() => window.__app.doc.name === 'scan.pdf' && document.querySelector('.page canvas'));
      const menu = async (label) => {
        await page.click('.toolbar button[title="More actions"]');
        await page.click(`.menu button:has-text("${label}")`);
      };
      await menu('Recognize text');
      await page.click('dialog .btn.primary');
      await page.waitForFunction(() => window.__app.doc.pages[0].ocr, null, { timeout: 90000 });
      const words = await page.evaluate(() => window.__app.doc.pages[0].ocr.map((w) => w.text).join(' '));
      check('OCR reads a scanned page', /Lease agreement/.test(words) && /18,500/.test(words), words.slice(0, 90));
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, '11-ocr.png') });
      const [dlo] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
      const ocrSaved = path.join(OUT, 'scan-ocr.pdf');
      await dlo.saveAs(ocrSaved);
      // the saved scan now carries real, searchable text
      const found = await page.evaluate(async (bytes) => {
        const { pdfjsLib } = window.__app;
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
        const tc = await (await pdf.getPage(1)).getTextContent();
        return tc.items.map((i) => i.str).join('');
      }, [...fs.readFileSync(ocrSaved)]);
      check('OCR text is saved into the PDF', /Lease/.test(found) && /Quezon/.test(found), found.slice(0, 80));

      // exports
      const exportAs = async (id) => {
        await menu('Export…');
        await page.check('#exp-' + id, { force: true });
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('dialog .btn.primary')]);
        return dl.suggestedFilename();
      };
      const imgName = await exportAs('png');
      check('export page as image', imgName === 'scan.png', imgName);
      check('export text', (await exportAs('txt')) === 'scan.txt');

      // compress (strong) on the scan
      await menu('Reduce file size');
      await page.check('#cmp-96');
      await page.click('dialog .btn.primary');
      await page.waitForSelector('.sizes');
      const sizes = await page.textContent('.sizes');
      const [dlc] = await Promise.all([page.waitForEvent('download'), page.click('dialog .btn.primary')]);
      check('compressed copy', dlc.suggestedFilename() === 'scan-small.pdf', sizes);

      // split the 4-page document into single pages
      await page.click('.tab:has-text("fixture.pdf")');
      await page.click('.toolbar .btn:has-text("Pages")');
      await page.click('.org-bar button[title="Split into files"]');
      const [dls] = await Promise.all([page.waitForEvent('download'), page.click('dialog .btn.primary')]);
      const zipPath = path.join(OUT, 'split.zip');
      await dls.saveAs(zipPath);
      const { unzipSync } = await import('fflate');
      const parts = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(zipPath))));
      check('split into files', parts.length === 4, parts.join(', '));
      await page.click('.org-done');

      // print preparation (the dialog itself is native)
      await page.evaluate(() => (window.print = () => (window.__printed = document.querySelectorAll('#print-root img').length)));
      await menu('Print');
      await page.waitForFunction(() => window.__printed > 0, null, { timeout: 30000 });
      check('print renders every page', (await page.evaluate(() => window.__printed)) === 4);

      // autosave: make a change, wait for the snapshot, reload, recover
      await page.evaluate(() => {
        const d = window.__app.doc;
        d.change('annots', () => (d.pages[2].annots = [{ id: 'k', type: 'rect', x: 50, y: 50, w: 80, h: 40, color: '#1d6fe0', sw: 2, fill: null }]));
      });
      await page.waitForTimeout(3200);
      page.once('dialog', (d) => d.accept());
      await page.reload();
      await page.waitForSelector('.recover .file-main');
      const recN = await page.locator('.recover .file-row').count();
      await page.screenshot({ path: path.join(OUT, '12-home-recover.png') });
      await page.click('.recover .file-main:has-text("fixture.pdf")');
      await page.waitForSelector('.page canvas');
      const rec = await page.evaluate(() => ({ n: window.__app.doc.pages.length, a: window.__app.doc.pages[2].annots.length, rot: window.__app.doc.pages[1].rot, first: window.__app.doc.pages[0].annots.length }));
      check('unsaved work is recovered after a reload', rec.n === 4 && rec.a === 1 && rec.rot === 90 && rec.first > 5, JSON.stringify(rec) + ' entries=' + recN);
      const nameVal = await page.inputValue('.annotationLayer input[type="text"]');
      check('recovered form values', nameVal === 'Maria Santos', nameVal);
    }

    // phone layout
    const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    await phone.addInitScript(() => {
      delete window.showOpenFilePicker;
    });
    const mp = await phone.newPage();
    mp.on('pageerror', (e) => errors.push('phone pageerror: ' + e.message));
    await mp.goto(URL_);
    await mp.waitForSelector('.home-action');
    await mp.screenshot({ path: path.join(OUT, '09-phone-home.png') });
    const [mfc] = await Promise.all([mp.waitForEvent('filechooser'), mp.click('.home-action')]);
    await mfc.setFiles(saved);
    await mp.waitForSelector('.page .textLayer span');
    await mp.waitForTimeout(600);
    await mp.screenshot({ path: path.join(OUT, '10-phone-doc.png') });
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check('phone layout has no sideways page scroll', !overflow);

    check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
