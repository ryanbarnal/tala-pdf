/** File open/save across the desktop app (Electron), browsers with file handles, and everything else. */
const desk = window.desktop || null;
export const isDesktop = !!desk;
export const hasFsAccess = 'showOpenFilePicker' in window;

const TYPES = {
  pdf: { description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } },
  image: { description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] } },
};

function pickWithInput(kind, multiple, capture) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = kind === 'pdf' ? 'application/pdf,.pdf' : 'image/*';
    inp.multiple = multiple;
    if (capture) inp.capture = 'environment';
    inp.style.display = 'none';
    document.body.append(inp);
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      inp.remove();
      resolve(files);
    };
    inp.addEventListener('change', () => finish([...inp.files]));
    inp.addEventListener('cancel', () => finish([]));
    inp.click();
  });
}

/** Returns [{name, bytes, ref, file}] — ref is a path (desktop) or file handle (web), when available. */
export async function openFiles(kind = 'pdf', { multiple = true, capture = false } = {}) {
  if (desk && kind === 'pdf') return desk.open(multiple);
  if (hasFsAccess && !capture) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({ multiple, types: [TYPES[kind]] });
    } catch {
      return [];
    }
    return Promise.all(
      handles.map(async (hd) => {
        const file = await hd.getFile();
        return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), ref: kind === 'pdf' ? hd : null, file };
      }),
    );
  }
  const files = await pickWithInput(kind, multiple, capture);
  return Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), ref: null, file })));
}

export async function readRef(ref) {
  if (desk && typeof ref === 'string') return desk.read(ref);
  if (ref?.getFile) {
    if ((await ref.queryPermission?.({ mode: 'read' })) !== 'granted') {
      if ((await ref.requestPermission({ mode: 'read' })) !== 'granted') throw new Error('Permission to read the file was not given.');
    }
    const f = await ref.getFile();
    return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), ref };
  }
  throw new Error('File is no longer available.');
}

export function download(name, bytes, type = 'application/octet-stream') {
  const url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Save bytes. Returns {ref, name, how} or null when the user cancels.
 * how: 'written' (saved in place) | 'downloaded'
 */
export async function saveBytes(name, bytes, ref, saveAs, type = 'application/pdf') {
  const ext = name.slice(name.lastIndexOf('.'));
  if (desk) {
    if (ref && !saveAs && typeof ref === 'string') {
      await desk.write(ref, bytes);
      return { ref, name, how: 'written' };
    }
    const res = await desk.saveAs(name, bytes);
    return res ? { ref: ext === '.pdf' ? res.path : ref, name: res.name, how: 'written' } : null;
  }
  if (hasFsAccess) {
    try {
      let hd = !saveAs && ref?.createWritable ? ref : null;
      if (!hd) {
        hd = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: ext.slice(1).toUpperCase() + ' file', accept: { [type]: [ext] } }],
        });
      }
      const w = await hd.createWritable();
      await w.write(bytes);
      await w.close();
      return { ref: ext === '.pdf' ? hd : ref, name: hd.name, how: 'written' };
    } catch (e) {
      if (e.name === 'AbortError') return null;
      console.warn('file handle save failed, downloading instead', e);
    }
  }
  download(name, bytes, type);
  return { ref, name, how: 'downloaded' };
}

export function canShare() {
  if (!navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], 'a.pdf', { type: 'application/pdf' })] });
  } catch {
    return false;
  }
}

export async function shareFile(name, bytes) {
  const file = new File([bytes], name, { type: 'application/pdf' });
  try {
    await navigator.share({ files: [file], title: name });
    return true;
  } catch (e) {
    if (e.name === 'AbortError') return false;
    throw e;
  }
}

/** Files handed over by the OS: "Open with" on desktop, or the installed web app's file handler. */
export function onExternalOpen(cb) {
  if (desk) desk.onOpen(cb);
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      for (const hd of params.files || []) {
        const f = await hd.getFile();
        cb({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), ref: hd });
      }
    });
  }
}

export function setDirtyFlag(dirty) {
  desk?.setDirty?.(dirty);
}
export function onCloseRequest(cb) {
  desk?.onCloseRequest?.(cb);
}
export function confirmClose() {
  desk?.confirmClose?.();
}
