// The web app notices a new deployment and offers to reload. Run `npm run build` first.
const { chromium } = require('playwright');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const DIST = path.join(__dirname, '..', 'dist');
const OUT = path.join(__dirname, 'out');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.woff2': 'font/woff2' };
let swSuffix = '';

(async () => {
  // A plain static server that reads files fresh on every request, like a real deployment.
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(DIST, p);
    if (!file.startsWith(DIST) || !fs.existsSync(file)) return res.writeHead(404).end();
    let body = fs.readFileSync(file);
    if (p === '/sw.js') body = Buffer.concat([body, Buffer.from(swSuffix)]);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(4193, '127.0.0.1', r));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.goto('http://127.0.0.1:4193/');
    await page.waitForSelector('.home-action');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForSelector('.home-action');
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
    check('web app installs for offline use', true);

    await page.click('#help-btn');
    await page.click('.menu button:has-text("Check for updates")');
    await page.waitForFunction(() => /latest version/.test(document.getElementById('toasts')?.textContent || ''), null, { timeout: 15000 });
    check('no new deployment: says it is up to date', true);

    swSuffix = '\n// new deployment\n';
    await page.click('#help-btn');
    await page.click('.menu button:has-text("Check for updates")');
    await page.waitForSelector('#update-bar', { timeout: 30000 });
    check('new deployment: offers to reload', /new version of Tala PDF is ready/.test(await page.textContent('#update-bar')));
    await page.screenshot({ path: path.join(OUT, '42-web-update.png') });
    await Promise.all([page.waitForEvent('load', { timeout: 30000 }), page.click('#update-bar button:has-text("Reload now")')]);
    await page.waitForSelector('.home-action');
    check('reloads into the new version', (await page.locator('#update-bar').count()) === 0);
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
