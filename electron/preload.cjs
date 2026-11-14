const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  open: (multiple, exts) => ipcRenderer.invoke('open-dialog', multiple, exts),
  htmlToPdf: (html) => ipcRenderer.invoke('html-to-pdf', html),
  read: (path) => ipcRenderer.invoke('read', path),
  write: (path, bytes) => ipcRenderer.invoke('write', path, bytes),
  saveAs: (name, bytes) => ipcRenderer.invoke('save-as', name, bytes),
  setDirty: (dirty) => ipcRenderer.send('set-dirty', dirty),
  pathFor: (file) => {
    try {
      const p = webUtils.getPathForFile(file);
      if (p) ipcRenderer.send('allow-path', p);
      return p || null;
    } catch {
      return null;
    }
  },
  onOpen: (cb) => ipcRenderer.on('open-file', (_e, entry) => cb(entry)),
  ready: () => ipcRenderer.send('ready'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, what) => cb(what)),
});
