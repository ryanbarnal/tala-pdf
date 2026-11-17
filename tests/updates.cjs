// Update checks in the desktop app, against a local stand-in for the GitHub release feed.
// Run `npm run build:desktop` first. On Linux CI wrap with xvfb-run.
const { _electron } = require('playwright');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, 'out');
const ROOT = path.join(__dirname, '..');
const current = require('../package.json').version;
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
};

function feed(version) {
  const yml = `version: ${version}\nfiles:\n  - url: Tala-PDF-${version}.AppImage\n    sha512: AAAA\n    size: 100\npath: Tala-PDF-${version}.AppImage\nsha512: AAAA\nreleaseDate: '2026-11-17T00:00:00.000Z'\n`;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/latest-linux.yml')) {
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(yml);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}

async function launch(feedUrl) {
  const userData = fs.mkdtempSync(path.join(OUT, 'profile-'));
  const app = await _electron.launch({
    executablePath: require(path.join(ROOT, 'node_modules', 'electron')),
    args: ['--no-sandbox', `--user-data-dir=${userData}`, ROOT],
    env: { ...process.env, TALA_UPDATE_FEED: feedUrl },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('.home-action');
  return { app, win, done: async () => (await app.close(), fs.rmSync(userData, { recursive: true, force: true })) };
}
const helpCheck = async (win) => {
  await win.click('#help-btn');
  await win.click('.menu button:has-text("Check for updates")');
};

(async () => {
  // 1. A newer version exists.
  const newer = await feed('9.9.9');
  let s = await launch(newer.url);
  await s.win.waitForSelector('#update-bar', { timeout: 30000 });
  const text = await s.win.textContent('#update-bar');
  check('background check finds a newer version', /9\.9\.9/.test(text), text);
  check('without self-install (this build), it offers a download', /Download/.test(text));
  await s.win.screenshot({ path: path.join(OUT, '40-update.png') });
  await s.win.click('#update-bar button:has-text("Later")');
  check('Later hides the banner', (await s.win.locator('#update-bar').count()) === 0);
  await helpCheck(s.win);
  await s.win.waitForSelector('#update-bar', { timeout: 15000 });
  check('Help › Check for updates shows it again', /9\.9\.9/.test(await s.win.textContent('#update-bar')));
  // The Windows path: the update has downloaded, so the banner offers to restart.
  await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('update', { state: 'ready', version: '9.10.0', canInstall: true }));
  await s.win.waitForFunction(() => /9\.10\.0 is ready to install/.test(document.getElementById('update-bar')?.textContent || ''));
  check('downloaded update offers Restart now', /Restart now/.test(await s.win.textContent('#update-bar')));
  await s.win.screenshot({ path: path.join(OUT, '41-update-ready.png') });
  await s.done();
  newer.srv.close();

  // 2. Already up to date.
  const same = await feed(current);
  s = await launch(same.url);
  await s.win.waitForTimeout(1500);
  await helpCheck(s.win);
  await s.win.waitForFunction(() => /latest version/.test(document.getElementById('toasts')?.textContent || ''), null, { timeout: 15000 });
  check('up to date: says so', true, current);
  check('up to date: no banner', (await s.win.locator('#update-bar').count()) === 0);
  await s.done();
  same.srv.close();

  // 3. Update server unreachable.
  s = await launch('http://127.0.0.1:9/');
  await s.win.waitForTimeout(1500);
  await helpCheck(s.win);
  await s.win.waitForSelector('.toast.error', { timeout: 20000 });
  const err = await s.win.textContent('.toast.error');
  check('offline: explains what went wrong', /internet|GitHub|try again/i.test(err), err);
  await s.done();

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
