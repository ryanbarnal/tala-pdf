// Checks for: owner-password PDFs, Save As/Export buttons, conversion from Office files,
// export to Office formats, and the thumbnail sidebar. Run `npm run build` first.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, 'out');
const PORT = 4189;
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
};

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  await new Promise((res) => server.stdout.on('data', (d) => String(d).includes('localhost') && res()));
  const browser = await chromium.launch();
  const errors = [];
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const { unzipSync, strFromU8 } = await import('fflate');
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      delete window.showOpenFilePicker;
      delete window.showSaveFilePicker;
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => (console.log('  [pageerror]', e.message), errors.push(e.message)));
    page.on('console', (m) => m.type() === 'error' && (console.log('  [error]', m.text().slice(0, 300)), errors.push(m.text())));
    await page.goto(`http://localhost:${PORT}/`);
    check('opening animation shows on start', await page.locator('#splash .sp-star').count() === 1);
    await page.waitForSelector('.home-action');
    await page.waitForSelector('#splash', { state: 'detached', timeout: 5000 });
    check('opening animation clears itself', true);
    check('home screen credits the author', /Created by Ryan Ocbina Barnal/.test(await page.textContent('.home-foot')));
    const mark = await page.locator('.brand-mark').boundingBox();
    check('title-bar logo is smaller', mark.width <= 22, mark.width + ' px');

    const open = async (file, via = 'open') => {
      const sel = via === 'convert' ? '.home-action:has-text("Convert to PDF")' : (await page.locator('#home').isVisible()) ? '.home-action:has-text("Open")' : '.toolbar button[title^="Open"]';
      if (via === 'convert' && !(await page.locator('#home').isVisible())) await page.click('.topbar button[aria-label="New tab"]');
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
      await fc.setFiles(file);
    };
    const download = async (trigger) => {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), trigger()]);
      const p = path.join(OUT, 'f-' + dl.suggestedFilename());
      await dl.saveAs(p);
      return p;
    };

    // 1. Owner-password PDF: opens, can be edited and saved.
    await open(path.join(OUT, 'locked.pdf'));
    await page.waitForSelector('.page .textLayer span');
    check('sidebar thumbnails show by default', await page.locator('.sidebar .thumb').count() === 2);
    const order = await page.evaluate(() => [...document.querySelectorAll('.toolbar .tgroup:first-child button')].map((b) => b.getAttribute('aria-label')));
    check('Save as and Export sit next to Save', order.indexOf('Save as… (Ctrl+Shift+S)') === order.indexOf('Save (Ctrl+S)') + 1 && order[order.indexOf('Save (Ctrl+S)') + 2]?.startsWith('Export'), order.join(' | '));
    await page.evaluate(() => {
      const d = window.__app.doc;
      d.change('annots', () => (d.pages[0].annots = [{ id: 'n', type: 'text', x: 60, y: 200, w: 220, h: 20, text: 'Edited despite the lock', size: 14, family: 'sans', color: '#d92d20', angle: 0 }]));
    });
    const lockedSaved = await download(() => page.keyboard.press('Control+s'));
    const ld = await PDFDocument.load(fs.readFileSync(lockedSaved));
    check('owner-password PDF saves (the reported error)', ld.getPageCount() === 2);
    const saveAs = await download(() => page.click('.toolbar button[aria-label="Save as… (Ctrl+Shift+S)"]'));
    check('Save as button saves a copy', fs.statSync(saveAs).size > 1000);

    // 2. Thumbnail drag to reorder and right-click menu.
    const t = page.locator('.sidebar .thumb');
    await t.nth(1).dragTo(t.nth(0), { targetPosition: { x: 40, y: 10 } });
    await page.waitForTimeout(300);
    const firstIdx = await page.evaluate(() => window.__app.doc.pages[0].idx);
    check('drag a thumbnail to reorder pages', firstIdx === 1);
    await t.nth(0).click({ button: 'right' });
    await page.click('.menu button:has-text("Rotate right")');
    check('thumbnail right-click menu rotates', await page.evaluate(() => window.__app.doc.pages[0].rot === 90));
    await page.screenshot({ path: path.join(OUT, '30-thumbs.png') });

    // 3. Convert Word, Excel, PowerPoint, text.
    for (const [file, expect, minPages] of [
      ['contract.docx', /Service agreement[\s\S]*Clause 1\.[\s\S]*Makati/, 2],
      ['budget.xlsx', /Category[\s\S]*18,?500[\s\S]*Quarter total/, 2],
      ['review.pptx', /Quarterly review[\s\S]*Revenue up 12 percent/, 2],
      ['notes.txt', /Meeting notes[\s\S]*office move/, 1],
    ]) {
      const before = await page.evaluate(() => window.__app.docs.length);
      await open(path.join(OUT, file), 'convert');
      await page.waitForFunction((n) => window.__app.docs.length > n && document.querySelector('.page canvas'), before, { timeout: 90000 });
      await page.waitForTimeout(700);
      const info = await page.evaluate(() => ({ n: window.__app.doc.pages.length, name: window.__app.doc.name, text: window.__app.doc.pages.map((p) => (p.ocr || []).map((w) => w.text).join(' ')).join(' ') }));
      check(`convert ${file}`, info.n >= minPages && expect.test(info.text), `${info.name}, ${info.n} pages, "${info.text.slice(0, 60)}…"`);
      await page.screenshot({ path: path.join(OUT, `31-convert-${file.split('.')[1]}.png`) });
    }
    // keep the converted Word document as the export source
    await page.click('.tab:has-text("contract.pdf")');
    await page.waitForTimeout(400);

    // unsupported legacy format gives a clear message
    await open(path.join(OUT, 'old.doc'), 'convert').catch(() => {});
    await page.waitForSelector('.toast.error');
    check('old .doc explains how to fix it', /Save As/.test(await page.textContent('.toast.error')));
    await page.click('.tab:has-text("contract.pdf")');
    await page.waitForTimeout(400);

    // 4. Export to every format from the converted contract.
    const exportAs = async (id, extra) => {
      await page.click('.toolbar button[aria-label^="Export"]');
      await page.check('#exp-' + id, { force: true });
      if (extra) await extra();
      return download(() => page.click('dialog .btn.primary'));
    };
    const docxPath = await exportAs('docx');
    const docXml = strFromU8(unzipSync(new Uint8Array(fs.readFileSync(docxPath)))['word/document.xml']);
    check('export Word (editable text)', /Service agreement/.test(docXml) && /Clause 1\./.test(docXml), path.basename(docxPath));
    const docxL = await exportAs('docx-layout');
    check('export Word (exact look)', Object.keys(unzipSync(new Uint8Array(fs.readFileSync(docxL)))).some((k) => k.startsWith('word/media/')));
    const xlsxPath = await exportAs('xlsx');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);
    const cells = [];
    wb.worksheets[0].eachRow((r) => r.eachCell((c) => cells.push(String(c.value))));
    check('export Excel', wb.worksheets.length >= 2 && cells.join(' ').includes('Service agreement'), `${wb.worksheets.length} sheets`);
    const pptxPath = await exportAs('pptx');
    const slides = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(pptxPath)))).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
    const pageCount = await page.evaluate(() => window.__app.doc.pages.length);
    check('export PowerPoint', slides.length === pageCount, `${slides.length} slides`);
    const jpgPath = await exportAs('jpg', async () => {
      await page.check('#exp-cur', { force: true });
    });
    check('export current page as JPEG', /-p1\.jpg$/.test(jpgPath) && fs.readFileSync(jpgPath)[0] === 0xff);
    const pdfPart = await exportAs('pdf', async () => {
      await page.check('#exp-rng', { force: true });
      await page.fill('#exp-range', '1');
    });
    check('export selected pages as PDF', (await PDFDocument.load(fs.readFileSync(pdfPart))).getPageCount() === 1);
    const txtPath = await exportAs('txt');
    check('export text', /Makati/.test(fs.readFileSync(txtPath, 'utf8')));
    await page.click('.toolbar button[aria-label^="Export"]');
    await page.screenshot({ path: path.join(OUT, '32-export-dialog.png') });
    await page.keyboard.press('Escape');

    // 5. Recent files grid has thumbnails.
    await page.click('.topbar button[aria-label="New tab"]');
    await page.waitForSelector('.recent-thumb img');
    check('recent files show page thumbnails', (await page.locator('.recent-thumb img').count()) >= 1);
    await page.screenshot({ path: path.join(OUT, '33-home.png') });

    // 6. Help: manual, shortcuts, About.
    await page.click('#help-btn');
    await page.click('.menu button:has-text("User manual")');
    await page.waitForFunction(() => window.__app.doc?.isManual && document.querySelector('.page canvas'), null, { timeout: 30000 });
    const manual = await page.evaluate(() => ({ name: window.__app.doc.name, pages: window.__app.doc.pages.length }));
    check('Help opens the manual in a tab', manual.pages >= 15, JSON.stringify(manual));
    await page.keyboard.press('F1');
    check('F1 reuses the open manual tab', (await page.evaluate(() => window.__app.docs.filter((d) => d.isManual).length)) === 1);
    await page.click('#help-btn');
    await page.click('.menu button:has-text("About Tala PDF")');
    const about = await page.textContent('dialog .about');
    check('About credits the author', /Created by Ryan Ocbina Barnal/.test(about) && /Version \d/.test(about), about.slice(0, 80));
    await page.screenshot({ path: path.join(OUT, '35-about.png') });
    await page.keyboard.press('Escape');
    await page.click('#help-btn');
    await page.click('.menu button:has-text("Keyboard shortcuts")');
    check('keyboard shortcuts list', (await page.locator('dialog table.keys tr').count()) >= 10);
    await page.keyboard.press('Escape');

    // 7. Phone filmstrip.
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await phone.addInitScript(() => delete window.showOpenFilePicker);
    const mp = await phone.newPage();
    mp.on('pageerror', (e) => errors.push('phone: ' + e.message));
    await mp.goto(`http://localhost:${PORT}/`);
    const [mfc] = await Promise.all([mp.waitForEvent('filechooser'), mp.click('.home-action:has-text("Open")')]);
    await mfc.setFiles(path.join(OUT, 'fixture.pdf'));
    await mp.waitForSelector('.page canvas');
    await mp.click('.toolbar button[aria-label="Show or hide the sidebar"]');
    await mp.waitForSelector('.sidebar.strip .thumb canvas');
    const strip = await mp.evaluate(() => {
      const r = document.querySelector('.sidebar.strip').getBoundingClientRect();
      return { bottom: Math.round(r.bottom), h: Math.round(r.height), overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    check('phone shows a bottom filmstrip of thumbnails', strip.bottom === 800 && strip.h < 260 && !strip.overflow, JSON.stringify(strip));
    await mp.waitForTimeout(400);
    await mp.screenshot({ path: path.join(OUT, '34-phone-strip.png') });

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
