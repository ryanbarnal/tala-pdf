/**
 * "A new version is ready" for both the desktop app (via electron-updater) and the web app
 * (via the service worker). Updates are fetched in the background; the app only asks when the new
 * version is ready, and never reloads or restarts without the person choosing to.
 */
import { h, icon, toast } from './util.js';
import { APP_VERSION } from './config.js';

const desk = window.desktop?.updates || null;
let bar = null;
let dismissed = null; // version the person chose "Later" for, this session
let manual = false;
let webUpdate = null; // service-worker activation, when a new web version is waiting
let beforeRestart = async () => {};

function hide() {
  bar?.remove();
  bar = null;
}

function show(state, asked = manual) {
  if (state.version && dismissed === state.version && !asked) return;
  hide();
  const later = () => {
    dismissed = state.version || 'web';
    hide();
  };
  let text;
  let actions;
  if (state.state === 'downloading') {
    if (!asked) return; // background downloads stay quiet
    text = `Downloading Tala PDF ${state.version}… ${state.percent || 0}%`;
    actions = [h('button.btn.small', { type: 'button', onClick: hide }, 'Hide')];
  } else if (state.state === 'ready') {
    text = state.web ? 'A new version of Tala PDF is ready.' : `Tala PDF ${state.version} is ready to install.`;
    actions = [
      h('button.btn.small', { type: 'button', onClick: later }, 'Later'),
      h('button.btn.small.primary', { type: 'button', onClick: () => restart(state) }, state.web ? 'Reload now' : 'Restart now'),
    ];
  } else if (state.state === 'available') {
    text = `Tala PDF ${state.version} is available.`;
    actions = [
      h('button.btn.small', { type: 'button', onClick: later }, 'Later'),
      h('button.btn.small.primary', { type: 'button', onClick: () => (desk.openDownloadPage(), hide()) }, 'Download'),
    ];
  } else return;
  bar = h('div#update-bar', { role: 'status', 'aria-live': 'polite' }, h('span.update-ic', icon('RefreshCw', 18)), h('span.update-text', text), h('span.update-actions', actions));
  document.body.append(bar);
}

async function restart(state) {
  await beforeRestart();
  if (state.web) {
    webUpdate?.(true);
    return;
  }
  const ok = await desk.install();
  if (!ok) toast('The update could not be installed. It will be installed the next time you quit Tala PDF.', 'error');
}

function onState(state) {
  if (manual && state.state === 'none') {
    manual = false;
    return toast(`You have the latest version (${APP_VERSION}).`);
  }
  if (manual && state.state === 'error') {
    manual = false;
    return toast(state.message || 'Could not check for updates.', 'error');
  }
  const asked = manual;
  if (state.state === 'ready' || state.state === 'available') manual = false;
  show(state, asked);
}

/** Ask for an update check now and report the result, including "up to date". */
export async function checkForUpdates() {
  if (desk) {
    manual = true;
    toast('Checking for updates…');
    const res = await desk.check();
    if (res?.state === 'unavailable') {
      manual = false;
      return toast(res.reason);
    }
    if (res) onState(res);
    return;
  }
  const reg = await navigator.serviceWorker?.getRegistration?.();
  if (!reg) return toast('Updates are applied automatically when you reload this page.');
  toast('Checking for updates…');
  try {
    await reg.update();
  } catch {
    return toast('Could not check for updates. Check your internet connection.', 'error');
  }
  setTimeout(() => {
    if (!reg.waiting && !bar) toast(`You have the latest version (${APP_VERSION}).`);
  }, 2500);
}

/** beforeRestartFn saves recovery copies of unsaved work before the app reloads or restarts. */
export function initUpdates(beforeRestartFn) {
  beforeRestart = beforeRestartFn;
  if (desk) {
    desk.onChange(onState);
    return;
  }
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      webUpdate = registerSW({
        immediate: true,
        onNeedRefresh: () => onState({ state: 'ready', web: true, version: 'web' }),
        onRegisteredSW: (_url, reg) => {
          // Look for a new version every hour while the app stays open.
          if (reg) setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
        },
      });
    })
    .catch(() => {});
}
