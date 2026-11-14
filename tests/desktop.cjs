// Desktop shell test: launches the Electron app with a PDF on the command line (as "Open with" does),
// edits it, and saves in place. Run `npm run build:desktop` first. On Linux CI wrap with xvfb-run.
const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, 'out');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
};

(async () => {
  const file = path.join(OUT, 'desk.pdf');
  fs.copyFileSync(path.join(OUT, 'fixture.pdf'), file);
  const before = fs.statSync(file).size;
  const userData = fs.mkdtempSync(path.join(OUT, 'profile-'));
  const app = await _electron.launch({
    // Set TALA_EXE to a packaged binary (e.g. release/linux-unpacked/tala-pdf) to test the real build.
    executablePath: process.env.TALA_EXE || require(path.join(__dirname, '..', 'node_modules', 'electron')),
    args: ['--no-sandbox', `--user-data-dir=${userData}`, ...(process.env.TALA_EXE ? [] : [path.join(__dirname, '..')]), file],
  });
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    win.on('console', (m) => m.type() === 'error' && console.log('  [error]', m.text().slice(0, 300)));
    await win.waitForSelector('.page .textLayer span', { timeout: 30000 });
    check('opens the file passed by the system', (await win.evaluate(() => window.__app.doc.name)) === 'desk.pdf');
    check('document knows its path', (await win.evaluate(() => window.__app.doc.ref)) === file);
    await win.evaluate(() => {
      const d = window.__app.doc;
      d.change('annots', () => (d.pages[0].annots = [{ id: 'a', type: 'text', x: 60, y: 300, w: 200, h: 20, text: 'Saved from the desktop app', size: 14, family: 'sans', color: '#000000', angle: 0 }]));
    });
    await win.keyboard.press('Control+s');
    await win.waitForFunction(() => !window.__app.doc.dirty, null, { timeout: 15000 });
    const after = fs.statSync(file).size;
    check('saves back to the same file', after !== before, `${before} -> ${after} bytes`);
    const { PDFDocument } = await import('@cantoo/pdf-lib');
    check('saved file is a valid PDF', (await PDFDocument.load(fs.readFileSync(file))).getPageCount() === 3);
    // a path the user never picked must be refused
    const refused = await win.evaluate(async (p) => {
      try {
        await window.desktop.write(p, new Uint8Array([1]));
        return false;
      } catch {
        return true;
      }
    }, path.join(OUT, 'not-allowed.pdf'));
    check('refuses to write to a file the user did not choose', refused && !fs.existsSync(path.join(OUT, 'not-allowed.pdf')));
    // OCR engine (WebAssembly + worker) must load from inside the packaged app, with no network.
    const scan = path.join(OUT, 'scan.pdf');
    if (fs.existsSync(scan)) {
      await win.evaluate(async (p) => {
        const e = await window.desktop.read(p);
        document.dispatchEvent(new CustomEvent('test-open', { detail: e }));
      }, scan);
      await win.waitForFunction(() => window.__app.doc.name === 'scan.pdf' && document.querySelector('.page canvas'));
      await win.click('.toolbar button[title="More actions"]');
      await win.click('.menu button:has-text("Recognize text")');
      await win.click('dialog .btn.primary');
      await win.waitForFunction(() => window.__app.doc.pages[0].ocr, null, { timeout: 90000 });
      const words = await win.evaluate(() => window.__app.doc.pages[0].ocr.map((w) => w.text).join(' '));
      check('OCR works offline inside the desktop app', /Lease agreement/.test(words), words.slice(0, 60));
    }
    // Conversion in the desktop app uses Chromium's PDF printer, so the text is real text.
    for (const [file, re] of [['contract.docx', /Service agreement/], ['budget.xlsx', /Quarter total/], ['review.pptx', /Quarterly review/]]) {
      const n0 = await win.evaluate(() => window.__app.docs.length);
      await win.evaluate(
        ([name, bytes]) => document.dispatchEvent(new CustomEvent('test-open', { detail: { name, bytes: new Uint8Array(bytes), ref: null } })),
        [file, [...fs.readFileSync(path.join(OUT, file))]],
      );
      await win.waitForFunction((n) => window.__app.docs.length > n && document.querySelector('.page canvas'), n0, { timeout: 60000 });
      const r = await win.evaluate(async () => {
        const d = window.__app.doc;
        await new Promise((r) => setTimeout(r, 600));
        return { name: d.name, pages: d.pages.length, ocr: d.pages.some((p) => p.ocr), text: [...document.querySelectorAll('.textLayer')].map((t) => t.textContent).join(' ') };
      });
      check(`desktop converts ${file} with real text`, !r.ocr && re.test(r.text), `${r.name}: ${r.pages} pages`);
    }
    await win.screenshot({ path: path.join(OUT, '20-desktop.png') });
    await win.evaluate(() => window.desktop.setDirty(false));
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
