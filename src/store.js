import { get, set, del, keys } from 'idb-keyval';
import { sources } from './model.js';
import { isDesktop } from './platform.js';

/** Everything here stays in the browser's / app's own storage on this device. */
const safe = async (fn, fallback) => {
  try {
    return await fn();
  } catch (e) {
    console.warn('storage', e);
    return fallback;
  }
};

const MAX_RECENTS = 12;
const MAX_KEEP_BYTES = 60 * 1024 * 1024;

export const getRecents = () => safe(async () => (await get('recents')) || [], []);

export async function addRecent(doc, bytes) {
  await safe(async () => {
    let list = (await get('recents')) || [];
    const same = (r) => (typeof doc.ref === 'string' ? r.path === doc.ref : r.name === doc.name);
    for (const r of list.filter(same)) await del('recent:' + r.id);
    list = list.filter((r) => !same(r));
    const entry = { id: doc.id, name: doc.name, time: Date.now(), size: bytes.length, pages: doc.pages.length };
    // The desktop app reopens from the original path. In a browser there is no path, so keep a copy.
    if (isDesktop && typeof doc.ref === 'string') entry.path = doc.ref;
    else if (bytes.length <= MAX_KEEP_BYTES) await set('recent:' + entry.id, { bytes, handle: doc.ref?.getFile ? doc.ref : null });
    else entry.unavailable = true;
    list.unshift(entry);
    for (const r of list.splice(MAX_RECENTS)) await del('recent:' + r.id);
    await set('recents', list);
  });
}

export const getRecentData = (id) => safe(() => get('recent:' + id), null);

export async function removeRecent(id) {
  await safe(async () => {
    await del('recent:' + id);
    await set('recents', ((await get('recents')) || []).filter((r) => r.id !== id));
  });
}

/* ---- autosave: a full snapshot of unsaved work, restored after a crash or accidental close ---- */

export async function writeAutosave(doc) {
  await safe(async () => {
    const used = doc.usedSources();
    const forms = {};
    for (const s of used) {
      const all = s.pdf.annotationStorage.getAll();
      if (all) forms[s.id] = all;
    }
    await set('autosave:' + doc.id, {
      id: doc.id,
      name: doc.name,
      time: Date.now(),
      path: typeof doc.ref === 'string' ? doc.ref : null,
      protect: doc.protect,
      pages: doc.pages,
      forms,
      sources: used.map((s) => ({ id: s.id, name: s.name, bytes: s.bytes, password: s.password })),
    });
  });
}

export const clearAutosave = (id) => safe(() => del('autosave:' + id));

export async function listAutosaves() {
  return safe(async () => {
    const out = [];
    for (const k of await keys()) {
      if (typeof k === 'string' && k.startsWith('autosave:')) {
        const v = await get(k);
        if (v) out.push({ id: v.id, name: v.name, time: v.time, pages: v.pages.length });
      }
    }
    return out.sort((a, b) => b.time - a.time);
  }, []);
}

export const getAutosave = (id) => safe(() => get('autosave:' + id), null);

export const getSignatures = () => safe(async () => (await get('signatures')) || [], []);
export const setSignatures = (list) => safe(() => set('signatures', list));

export const getPref = (k, d) => {
  try {
    const v = localStorage.getItem('pref:' + k);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
export const setPref = (k, v) => {
  try {
    localStorage.setItem('pref:' + k, JSON.stringify(v));
  } catch {}
};

void sources;
