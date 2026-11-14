import 'pdfjs-dist/web/pdf_viewer.css';
import '@fontsource/fraunces/latin-600.css';
import './style.css';
import { zipSync } from 'fflate';
import { h, icon, toast, fmtSize, fmtAgo, debounce, uid, canvasToBytes, readAsDataUrl, loadImage, baseName, clamp } from './util.js';
import { Doc, addSource, pagesFromSource, sources, pdfjsLib, pageView, rotatePage, FONT_CSS, TEXT_PAD, LINE_H } from './model.js';
import { Viewer, DRAW_TOOLS, MARKUP_TOOLS } from './viewer.js';
import { Organizer, lazyThumbs, clonePage } from './organize.js';
import { buildPdf, blankPdf, imagesToPdf, rasterizePdf } from './export.js';
import { modal, confirmDlg, askPassword, askNote, signatureDialog, progress } from './dialogs.js';
import * as fsx from './platform.js';
import * as store from './store.js';
import { ocrPage, hasText } from './ocr.js';
import { convertToPdf, CONVERTIBLE, UNSUPPORTED_HINT } from './convert.js';
import * as ex from './exporters.js';
import { APP_NAME, APP_CREDIT, APP_VERSION, MANUAL_URL } from './config.js';

const TOOLS = [
  ['select', 'MousePointer2', 'Select'],
  ['highlight', 'Highlighter', 'Highlight'],
  ['underline', 'Underline', 'Underline'],
  ['strike', 'Strikethrough', 'Strikethrough'],
  ['note', 'MessageSquareText', 'Note'],
  ['pen', 'Pen', 'Draw'],
  ['text', 'Type', 'Add text'],
  ['edittext', 'TextCursorInput', 'Edit text'],
  ['rect', 'Square', 'Rectangle'],
  ['ellipse', 'Circle', 'Ellipse'],
  ['line', 'Minus', 'Line'],
  ['arrow', 'MoveUpRight', 'Arrow'],
  ['whiteout', 'Eraser', 'Whiteout'],
  ['redact', 'EyeOff', 'Redact'],
];
const HINTS = {
  highlight: 'Select text to highlight it.',
  underline: 'Select text to underline it.',
  strike: 'Select text to strike it out.',
  note: 'Click where the note should go.',
  pen: 'Draw with a mouse, finger, or pen.',
  text: 'Click where the text should start.',
  edittext: 'Click a line of existing text to change it.',
  whiteout: 'Drag to cover content with white.',
  redact: 'Drag over content to remove. Redacted pages become images when you save, and the content is gone for good.',
  rect: 'Drag to draw.',
  ellipse: 'Drag to draw.',
  line: 'Drag to draw.',
  arrow: 'Drag to draw.',
};
const PALETTE = ['#000000', '#d92d20', '#1d6fe0', '#16803c', '#f59e0b', '#7c3aed', '#ffffff'];
const HL_PALETTE = ['#ffe14d', '#a8f0a0', '#9fd8ff', '#ffb3d1', '#ffc680'];

const app = {
  docs: [],
  doc: null,
  mode: 'home',
  viewer: null,
  organizer: null,
};
window.__app = app;
app.pdfjsLib = pdfjsLib;

/* ================= layout ================= */

const tabsEl = h('div.tabs', { role: 'tablist', 'aria-label': 'Open documents' });
const toolbar = h('div.toolbar', { role: 'toolbar', 'aria-label': 'Tools' });
const propsbar = h('div.propsbar');
const viewerEl = h('div#viewer', { tabIndex: -1 });
const organizeEl = h('div#organize', { hidden: true });
const homeEl = h('div#home');
const sidebar = h('aside.sidebar', { hidden: true, 'aria-label': 'Sidebar' });
const scrim = h('div.scrim', { hidden: true, onClick: () => toggleSidebar(false) });
const printRoot = h('div#print-root');

document.getElementById('app').append(
  h(
    'header.topbar',
    h('div.brand', h('img.brand-mark', { src: './mark.svg', alt: '', width: 22, height: 22 }), h('span.brand-name', APP_NAME)),
    tabsEl,
    h('button.iconbtn', { type: 'button', title: 'New tab', 'aria-label': 'New tab', onClick: () => setMode('home') }, icon('Plus')),
    h('span.grow'),
    h('button.iconbtn#help-btn', { type: 'button', title: 'Help (F1)', 'aria-label': 'Help', onClick: (e) => helpMenu(e.currentTarget) }, icon('CircleHelp')),
    h('button.iconbtn#theme-btn', { type: 'button', title: 'Switch light or dark theme', 'aria-label': 'Switch theme', onClick: toggleTheme }, icon('Moon')),
  ),
  toolbar,
  propsbar,
  h('main.work', scrim, sidebar, viewerEl, organizeEl, homeEl),
);
document.body.append(printRoot);

app.viewer = new Viewer(viewerEl, {
  onPage: (i) => {
    pageInput.value = i + 1;
    markCurrentThumb();
  },
  onScale: (s) => (zoomLabel.textContent = Math.round(s * 100) + '%'),
  onTool: () => {
    syncToolButtons();
    drawProps();
  },
  onSelect: () => drawProps(),
  askNote,
});
app.organizer = new Organizer(organizeEl, app);
app.setMode = setMode;

/* ================= toolbar ================= */

const tb = (ic, label, fn, extra = {}) => h('button.iconbtn', { type: 'button', title: label, 'aria-label': label, onClick: fn, ...extra }, icon(ic));
const sep = () => h('span.sep', { 'aria-hidden': 'true' });
const zoomLabel = h('button.zoom-label', { type: 'button', title: 'Fit to width', onClick: () => app.viewer.fitWidth(true) }, '100%');
const pageInput = h('input#page-num', {
  type: 'text',
  inputMode: 'numeric',
  'aria-label': 'Page number',
  onChange: () => {
    const n = clamp(parseInt(pageInput.value, 10) || 1, 1, app.doc.pages.length);
    pageInput.value = n;
    app.viewer.scrollToPage(n - 1);
  },
  onFocus: () => pageInput.select(),
});
const pageTotal = h('span.page-total', '/ 0');
const toolBtns = {};
const undoBtn = tb('Undo2', 'Undo (Ctrl+Z)', () => app.doc?.doUndo());
const redoBtn = tb('Redo2', 'Redo (Ctrl+Y)', () => app.doc?.doRedo());
const saveBtn = tb('Save', 'Save (Ctrl+S)', () => save(false));
const saveAsBtn = tb('SaveAll', 'Save as… (Ctrl+Shift+S)', () => save(true), { className: 'iconbtn wide-only' });
const exportBtn = tb('FileDown', 'Export to Word, Excel, PowerPoint, images or text', () => exportDialog(), { className: 'iconbtn wide-only' });
const orgBtn = h('button.btn.small', { type: 'button', title: 'Reorder, rotate, delete, merge and split pages', onClick: () => setMode(app.mode === 'organize' ? 'view' : 'organize') }, icon('LayoutGrid', 16), h('span', 'Pages'));

toolbar.append(
  h(
    'div.tgroup',
    tb('PanelLeft', 'Show or hide the sidebar', () => toggleSidebar()),
    tb('FolderOpen', 'Open (Ctrl+O)', () => openPicker()),
    saveBtn,
    saveAsBtn,
    exportBtn,
    tb('Search', 'Search (Ctrl+F)', () => openSearch()),
  ),
  sep(),
  h('div.tgroup', undoBtn, redoBtn),
  sep(),
  h(
    'div.tgroup',
    tb('ZoomOut', 'Zoom out', () => app.viewer.setScale(app.viewer.scale / 1.2)),
    zoomLabel,
    tb('ZoomIn', 'Zoom in', () => app.viewer.setScale(app.viewer.scale * 1.2)),
  ),
  sep(),
  h('div.tgroup.pager', pageInput, pageTotal),
  sep(),
  h(
    'div.tgroup.tools',
    TOOLS.map(([id, ic, label]) => (toolBtns[id] = tb(ic, label, () => app.viewer.setTool(app.viewer.tool === id ? 'select' : id), { 'aria-pressed': 'false', dataset: { tool: id } }))),
    tb('Image', 'Add image', () => addImage()),
    tb('Signature', 'Sign', () => addSignature()),
  ),
  sep(),
  h('div.tgroup', orgBtn, tb('Ellipsis', 'More actions', (e) => moreMenu(e.currentTarget))),
);

function syncToolButtons() {
  for (const [id, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(app.viewer.tool === id));
}

function popMenu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const menu = h(
    'div.menu',
    { role: 'menu' },
    items.map((it) =>
      it === '-'
        ? h('hr')
        : h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              disabled: it.disabled,
              onClick: () => {
                close();
                it.onClick();
              },
            },
            icon(it.icon, 16),
            h('span', it.label),
          ),
    ),
  );
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
  };
  const outside = (e) => !menu.contains(e.target) && close();
  const esc = (e) => e.key === 'Escape' && (close(), anchor.focus());
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.left = clamp(r.right - mw, 8, innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 8) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
    menu.querySelector('button:not(:disabled)')?.focus();
  });
}

function moreMenu(anchor) {
  const d = app.doc;
  popMenu(anchor, [
    ...(innerWidth <= 760 ? [{ icon: 'SaveAll', label: 'Save as…', onClick: () => save(true) }] : []),
    { icon: 'Printer', label: 'Print', onClick: printDoc },
    ...(fsx.canShare() ? [{ icon: 'Share2', label: 'Share', onClick: shareDoc }] : []),
    '-',
    { icon: 'ScanText', label: 'Recognize text (OCR)', onClick: ocrDialog },
    { icon: 'CalendarDays', label: "Add today's date", onClick: () => placeText(new Date().toLocaleDateString()) },
    { icon: 'Check', label: 'Add checkmark', onClick: () => placeText('✓', 18) },
    '-',
    { icon: 'Lock', label: d?.protect ? 'Password: on' : 'Protect with password', onClick: protectDialog },
    { icon: 'Minimize2', label: 'Reduce file size', onClick: compressDialog },
    { icon: 'FileDown', label: 'Export…', onClick: () => exportDialog() },
    '-',
    { icon: 'Contrast', label: viewerEl.classList.contains('invert') ? 'Normal page colours' : 'Dark pages for reading', onClick: toggleInvert },
    { icon: 'X', label: 'Close document', onClick: () => closeDoc(d) },
  ]);
}

/* ================= properties bar ================= */

function drawProps() {
  const v = app.viewer;
  const a = v.getSelected();
  const kind = a ? a.type : v.tool;
  propsbar.replaceChildren();
  if (app.mode !== 'view' || (!a && kind === 'select')) {
    propsbar.hidden = true;
    return;
  }
  propsbar.hidden = false;
  const set = (patch) => {
    if (a) v.updateSelected(patch);
    else {
      Object.assign(v.style, patch);
      drawProps();
    }
  };
  const isHl = kind === 'highlight';
  const colorKey = !a && isHl ? 'hl' : 'color';
  const cur = a ? a.color : isHl ? v.style.hl : v.style.color;
  const hasColor = ['highlight', 'underline', 'strike', 'pen', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'text', 'textedit', 'note'].includes(kind) && !a?.whiteout;
  const hasStroke = ['pen', 'ink', 'rect', 'ellipse', 'line', 'arrow'].includes(kind) && !a?.whiteout;
  const hasFont = ['text', 'textedit'].includes(kind);

  if (hasColor) {
    const pal = isHl ? HL_PALETTE : PALETTE;
    const custom = h('input.swatch-custom', { type: 'color', value: cur || '#000000', 'aria-label': 'Custom colour', id: 'prop-color', onChange: (e) => set({ [colorKey]: e.target.value }) });
    propsbar.append(
      h(
        'div.pgroup',
        { role: 'group', 'aria-label': 'Colour' },
        pal.map((c) => h('button.swatch' + (c === cur ? '.on' : ''), { type: 'button', 'aria-label': 'Colour ' + c, style: { background: c }, onClick: () => set({ [colorKey]: c }) })),
        custom,
      ),
    );
  }
  if (hasStroke) {
    const sw = a ? a.sw : v.style.sw;
    propsbar.append(
      h(
        'label.pgroup',
        h('span.muted', 'Width'),
        h('input', { type: 'range', id: 'prop-sw', min: 0.5, max: 12, step: 0.5, value: sw, onChange: (e) => set({ sw: +e.target.value }) }),
        h('span.num', sw + ' pt'),
      ),
    );
  }
  if (hasFont) {
    const s = a || v.style;
    propsbar.append(
      h(
        'div.pgroup',
        h(
          'select',
          { id: 'prop-family', 'aria-label': 'Font', onChange: (e) => set({ family: e.target.value }) },
          [
            ['sans', 'Sans-serif'],
            ['serif', 'Serif'],
            ['mono', 'Monospace'],
          ].map(([val, l]) => h('option', { value: val, selected: (s.family || 'sans') === val }, l)),
        ),
        h('input.size', { type: 'number', id: 'prop-size', 'aria-label': 'Font size', min: 4, max: 144, step: 0.5, value: Math.round(s.size * 10) / 10, onChange: (e) => set({ size: clamp(+e.target.value || 12, 4, 144) }) }),
        h('button.iconbtn', { type: 'button', title: 'Bold', 'aria-pressed': String(!!s.bold), onClick: () => set({ bold: !s.bold }) }, icon('Bold', 16)),
        h('button.iconbtn', { type: 'button', title: 'Italic', 'aria-pressed': String(!!s.italic), onClick: () => set({ italic: !s.italic }) }, icon('Italic', 16)),
      ),
    );
  }
  if (a) {
    if (a.type === 'textedit') propsbar.append(h('span.hint', 'Double-click to retype. Fonts are matched to the closest standard face.'));
    propsbar.append(h('span.grow'), h('button.btn.small.danger', { type: 'button', onClick: () => v.deleteSelected() }, icon('Trash2', 15), h('span', a.type === 'textedit' ? 'Restore original' : 'Delete')));
  } else if (HINTS[kind]) {
    propsbar.append(h('span.hint', HINTS[kind]), h('span.grow'), h('button.btn.small', { type: 'button', onClick: () => v.setTool('select') }, 'Done'));
  }
}

/* ================= tabs / modes ================= */

function drawTabs() {
  tabsEl.replaceChildren(
    ...app.docs.map((d) =>
      h(
        'div.tab' + (d === app.doc && app.mode !== 'home' ? '.on' : ''),
        { role: 'tab', 'aria-selected': String(d === app.doc && app.mode !== 'home'), tabIndex: 0, title: d.name, onClick: () => activate(d), onKeydown: (e) => e.key === 'Enter' && activate(d) },
        h('span.tab-name', d.name),
        d.dirty ? h('span.dot', { title: 'Unsaved changes' }) : null,
        h(
          'button.tab-close',
          {
            type: 'button',
            'aria-label': 'Close ' + d.name,
            onClick: (e) => {
              e.stopPropagation();
              closeDoc(d);
            },
          },
          icon('X', 14),
        ),
      ),
    ),
  );
  document.title = app.doc && app.mode !== 'home' ? `${app.doc.name} · ${APP_NAME}` : APP_NAME;
  fsx.setDirtyFlag(app.docs.some((d) => d.dirty));
}

function setMode(mode) {
  if (mode !== 'home' && !app.doc) mode = 'home';
  if (mode === 'view' && app.mode === 'home' && sidebar.hidden && !phone() && store.getPref('sidebar', true)) {
    sidebar.hidden = false;
    queueMicrotask(drawSidebar);
  }
  if (app.mode === 'view') app.viewer.saveViewState();
  app.mode = mode;
  homeEl.hidden = mode !== 'home';
  viewerEl.hidden = mode !== 'view';
  organizeEl.hidden = mode !== 'organize';
  toolbar.classList.toggle('disabled', mode === 'home');
  toolbar.classList.toggle('organizing', mode === 'organize');
  orgBtn.classList.toggle('on', mode === 'organize');
  if (mode === 'home') {
    toggleSidebar(false);
    drawHome();
  }
  if (mode === 'organize') {
    app.viewer.setTool('select');
    app.organizer.refresh();
  }
  if (mode === 'view' && app.viewer.fit) requestAnimationFrame(() => app.viewer.fitWidth());
  drawTabs();
  drawProps();
}

function activate(doc) {
  if (app.doc !== doc) {
    app.viewer.saveViewState();
    app.docUnsub?.();
    app.doc = doc;
    app.viewer.setDoc(doc);
    app.organizer.sel.clear();
    app.docUnsub = doc?.onChange((what) => onDocChange(doc, what));
    searchState.results = null;
    drawSidebar();
  }
  setMode(doc ? 'view' : 'home');
  syncDocUi();
}

function syncDocUi() {
  const d = app.doc;
  if (!d) return;
  pageTotal.textContent = '/ ' + d.pages.length;
  pageInput.value = (app.viewer.current || 0) + 1;
  undoBtn.disabled = !d.undo.length;
  redoBtn.disabled = !d.redo.length;
  saveBtn.classList.toggle('attn', d.dirty);
  zoomLabel.textContent = Math.round(app.viewer.scale * 100) + '%';
}

const autosave = debounce((doc) => {
  if (doc.dirty && app.docs.includes(doc)) store.writeAutosave(doc);
}, 2500);

function onDocChange(doc, what) {
  syncDocUi();
  drawTabs();
  if (what === 'pages') {
    drawThumbs();
    if (app.mode === 'organize') app.organizer.refresh();
    searchState.results = null;
  }
  autosave(doc);
}

function addDoc(doc, { dirty = false } = {}) {
  doc.dirty = dirty;
  app.docs.push(doc);
  activate(doc);
  if (dirty) autosave(doc);
  return doc;
}

async function closeDoc(doc) {
  if (!doc) return;
  if (doc.dirty) {
    const v = await modal('Unsaved changes', h('p', `Save the changes to "${doc.name}" before closing?`), [
      { label: 'Cancel', value: undefined },
      { label: 'Discard', value: 'discard', danger: true },
      { label: 'Save', value: 'save', primary: true },
    ]);
    if (!v) return;
    if (v === 'save') {
      if (app.doc !== doc) activate(doc);
      if (!(await save(false))) return;
    }
  }
  store.clearAutosave(doc.id);
  doc.dirty = false;
  const i = app.docs.indexOf(doc);
  app.docs.splice(i, 1);
  if (app.doc === doc) {
    app.doc = null;
    app.docUnsub?.();
    app.viewer.setDoc(null);
    activate(app.docs[Math.min(i, app.docs.length - 1)] || null);
  } else drawTabs();
  // Free sources no open document uses any more.
  const live = new Set(app.docs.flatMap((d) => [...d.undo, ...d.redo, d.pages].flat().map((p) => p.src)));
  for (const [id, s] of sources) {
    if (!live.has(id)) {
      s.pdf.destroy();
      sources.delete(id);
    }
  }
}

/* ================= opening and creating ================= */

async function openEntries(entries) {
  const imgs = [];
  for (const e of entries) {
    if (!e) continue;
    const ext = (e.name.split('.').pop() || '').toLowerCase();
    if (!/\.pdf$/i.test(e.name)) {
      if (CONVERTIBLE.test(e.name)) await openConverted(e);
      else if (/^(png|jpe?g|webp|gif|bmp)$/.test(ext)) imgs.push(e.file || new File([e.bytes], e.name, { type: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) }));
      else toast(UNSUPPORTED_HINT[ext] || `"${e.name}" is not a file this app can open.`, 'error');
      continue;
    }
    const dup = typeof e.ref === 'string' && app.docs.find((d) => d.ref === e.ref);
    if (dup) {
      activate(dup);
      continue;
    }
    try {
      const src = await addSource(e.bytes, e.name, askPassword);
      const doc = new Doc(e.name);
      doc.ref = e.ref || null;
      doc.pages = pagesFromSource(src);
      if (src.password) doc.protect = { password: src.password };
      addDoc(doc);
      remember(doc, e.bytes);
    } catch (err) {
      if (err.message !== 'cancelled') toast(err.message, 'error');
    }
  }
  if (imgs.length) {
    const doc = new Doc(imgs[0].name.replace(/\.[a-z0-9]+$/i, '') + '.pdf');
    doc.pages = await imagesToPages(imgs);
    addDoc(doc, { dirty: true });
  }
}

async function openPicker() {
  openEntries(await fsx.openFiles('any'));
}

async function convertPicker() {
  openEntries(await fsx.openFiles('office'));
}

/** Turn a Word, Excel, PowerPoint, text or HTML file into a new PDF document. */
async function openConverted(e) {
  const pr = progress('Converting ' + e.name);
  try {
    const res = await convertToPdf(e.name, e.bytes, (text, frac) => pr.set(text, frac));
    const name = e.name.replace(/\.[a-z0-9]+$/i, '') + '.pdf';
    const src = await addSource(res.bytes, name, askPassword);
    const doc = new Doc(name);
    doc.pages = pagesFromSource(src);
    if (res.words) doc.pages.forEach((p, i) => (p.ocr = res.words[i] || null));
    pr.close();
    addDoc(doc, { dirty: true });
    toast(`Converted to PDF. ${res.words ? 'Pages were drawn as images with searchable text. ' : ''}Save it to keep it.`);
  } catch (err) {
    pr.close();
    console.error(err);
    toast(`Could not convert "${e.name}": ${err.message}`, 'error');
  }
}

async function newBlank() {
  const src = await addSource(await blankPdf(), 'Blank page');
  const doc = new Doc('Untitled.pdf');
  doc.pages = pagesFromSource(src);
  addDoc(doc, { dirty: true });
}

async function imagesToPages(files) {
  if (!files.length) return [];
  const src = await addSource(await imagesToPdf(files), files.length === 1 ? files[0].name : 'Images');
  return pagesFromSource(src);
}

async function newFromImages(capture = false) {
  const picked = await fsx.openFiles('image', { capture });
  if (!picked.length) return;
  try {
    const doc = new Doc(baseName(picked[0].name.replace(/\.[a-z0-9]+$/i, '')) + '.pdf');
    doc.pages = await imagesToPages(picked.map((p) => p.file));
    addDoc(doc, { dirty: true });
  } catch (e) {
    toast('Those images could not be read.', 'error');
  }
}

app.pickPdfPages = async () => {
  const out = [];
  for (const e of await fsx.openFiles('pdf')) {
    try {
      out.push(...pagesFromSource(await addSource(e.bytes, e.name, askPassword)));
    } catch (err) {
      if (err.message !== 'cancelled') toast(err.message, 'error');
    }
  }
  return out;
};
app.pickImagePages = async () => {
  try {
    return await imagesToPages((await fsx.openFiles('image')).map((p) => p.file));
  } catch {
    toast('Those images could not be read.', 'error');
    return [];
  }
};

async function mergeNew() {
  const pages = await app.pickPdfPages();
  if (!pages.length) return;
  const doc = new Doc('Merged.pdf');
  doc.pages = pages;
  addDoc(doc, { dirty: true });
  setMode('organize');
}

app.newDocFromPages = (pages, name) => {
  const doc = new Doc(name);
  doc.pages = pages;
  doc.protect = app.doc?.protect || null;
  addDoc(doc, { dirty: true });
};

app.copyPagesToTab = async (pages) => {
  const others = app.docs.filter((d) => d !== app.doc);
  if (!others.length) return toast('Open another document first, or use "Extract to new tab".');
  const target = await modal(
    'Copy pages to',
    h('div.stack', h('p.muted', `${pages.length} page${pages.length > 1 ? 's' : ''} will be added to the end of the document you choose.`)),
    [{ label: 'Cancel', value: undefined }, ...others.map((d) => ({ label: d.name, value: d }))],
  );
  if (!target) return;
  target.change('pages', () => (target.pages = [...target.pages, ...pages]));
  autosave(target);
  drawTabs();
  toast(`Copied to ${target.name}`);
};

async function restoreAutosave(id) {
  const s = await store.getAutosave(id);
  if (!s) return;
  try {
    for (const src of s.sources) {
      if (!sources.has(src.id)) {
        const loaded = await addSource(src.bytes, src.name, askPassword, src.password, src.id);
        for (const [k, v] of Object.entries(s.forms?.[src.id] || {})) loaded.pdf.annotationStorage.setValue(k, v);
      }
    }
    const doc = new Doc(s.name);
    doc.id = s.id;
    doc.ref = s.path || null;
    doc.pages = s.pages;
    doc.protect = s.protect || null;
    addDoc(doc, { dirty: true });
  } catch (e) {
    toast('That recovery copy could not be opened.', 'error');
  }
}

async function openRecent(r) {
  try {
    if (r.path) return openEntries([await fsx.readRef(r.path)]);
    const data = await store.getRecentData(r.id);
    if (!data) throw new Error('This file is no longer stored on this device. Open it again from its folder.');
    openEntries([{ name: r.name, bytes: data.bytes, ref: data.handle || null }]);
  } catch (e) {
    toast(e.message, 'error');
    await store.removeRecent(r.id);
    drawHome();
  }
}

/* ================= home ================= */

/** Add to recent files with a small picture of the first page. */
async function remember(doc, bytes) {
  let thumb = null;
  try {
    const pg = doc.pages[0];
    const { page, viewport } = await pageView(pg, 180 / pg.w);
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport }).promise;
    thumb = c.toDataURL('image/jpeg', 0.75);
  } catch {}
  await store.addRecent(doc, bytes, thumb);
  if (app.mode === 'home') drawHome();
}

async function drawHome() {
  const [recents, autos] = await Promise.all([store.getRecents(), store.listAutosaves()]);
  const openIds = new Set(app.docs.map((d) => d.id));
  const lost = autos.filter((a) => !openIds.has(a.id));
  const action = (ic, title, sub, fn) => h('button.home-action', { type: 'button', onClick: fn }, h('span.home-ic', icon(ic, 22)), h('span.home-t', title), h('span.home-s', sub));
  const coarse = matchMedia('(pointer: coarse)').matches;
  homeEl.replaceChildren(
    h(
      'div.home-inner',
      h('h1', 'Open a PDF to read, mark up, or edit'),
      h('p.muted.lead', fsx.isDesktop ? 'Files stay on this computer.' : 'Files stay on this device. Nothing is uploaded.'),
      h(
        'div.home-actions',
        action('FolderOpen', 'Open', 'PDFs, documents or images. Or drop files anywhere', openPicker),
        action('FilePlus2', 'Blank document', 'Start from an empty A4 page', newBlank),
        action('FileInput', 'Convert to PDF', 'Word, Excel, PowerPoint, text or web pages', convertPicker),
        action('Images', 'From images', 'Turn photos or scans into a PDF', () => newFromImages(false)),
        coarse ? action('Camera', 'Scan with camera', 'Photograph a page', () => newFromImages(true)) : null,
        action('Combine', 'Merge PDFs', 'Join several files into one', mergeNew),
      ),
      lost.length
        ? h(
            'section.home-list.recover',
            h('h2', 'Unsaved work'),
            h('p.muted', 'These documents were closed before their changes were saved.'),
            lost.map((a) =>
              h(
                'div.file-row',
                h('button.file-main', { type: 'button', onClick: () => restoreAutosave(a.id) }, icon('History', 18), h('span.file-name', a.name), h('span.file-meta', `${a.pages} pages · edited ${fmtAgo(a.time)}`)),
                h('button.iconbtn', { type: 'button', 'aria-label': 'Discard recovery copy of ' + a.name, title: 'Discard', onClick: async () => (await store.clearAutosave(a.id), drawHome()) }, icon('Trash2', 16)),
              ),
            ),
          )
        : null,
      recents.length
        ? h(
            'section.home-list',
            h('h2', 'Recent'),
            h(
              'div.recent-grid',
              recents.map((r) =>
                h(
                  'div.recent',
                  h(
                    'button.recent-open',
                    { type: 'button', title: r.name, onClick: () => openRecent(r) },
                    h('span.recent-thumb', r.thumb ? h('img', { src: r.thumb, alt: '', loading: 'lazy' }) : icon('FileText', 28)),
                    h('span.recent-name', r.name),
                    h('span.recent-meta', `${r.pages} page${r.pages === 1 ? '' : 's'} · ${fmtAgo(r.time)}`),
                  ),
                  h(
                    'button.iconbtn.recent-x',
                    { type: 'button', 'aria-label': 'Remove ' + r.name + ' from recent files', title: 'Remove from list', onClick: async () => (await store.removeRecent(r.id), drawHome()) },
                    icon('X', 15),
                  ),
                ),
              ),
            ),
          )
        : null,
      h(
        'footer.home-foot',
        h('span', `Tala PDF ${APP_VERSION}`),
        h('span', APP_CREDIT),
        h('button.linkbtn', { type: 'button', onClick: openManual }, 'User manual'),
        h('button.linkbtn', { type: 'button', onClick: shortcutsDialog }, 'Keyboard shortcuts'),
      ),
    ),
  );
}

/* ================= sidebar ================= */

let sideTab = store.getPref('sideTab', 'pages');
const sideBody = h('div.side-body');
const sideTabs = h('div.seg.side-tabs', { role: 'tablist' });
sidebar.append(sideTabs, sideBody);
const searchState = { q: '', results: null, busy: false };
let thumbIo = null;

const phone = () => innerWidth <= 760;
function toggleSidebar(on, remember = on === undefined) {
  const show = on ?? sidebar.hidden;
  sidebar.hidden = !show;
  if (remember && !phone()) store.setPref('sidebar', show);
  sidebar.classList.toggle('strip', phone() && sideTab === 'pages');
  scrim.hidden = !show || !phone() || sidebar.classList.contains('strip');
  if (show) drawSidebar();
  if (app.viewer.fit && app.mode === 'view') requestAnimationFrame(() => app.viewer.fitWidth());
}

function drawSidebar() {
  if (sidebar.hidden || !app.doc) return;
  sidebar.classList.toggle('strip', phone() && sideTab === 'pages');
  scrim.hidden = !phone() || sidebar.classList.contains('strip');
  sideTabs.replaceChildren(
    ...[
      ['pages', 'Pages'],
      ['outline', 'Outline'],
      ['search', 'Search'],
    ].map(([id, label]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(sideTab === id),
          onClick: () => {
            sideTab = id;
            store.setPref('sideTab', id);
            drawSidebar();
          },
        },
        label,
      ),
    ),
  );
  if (sideTab === 'pages') drawThumbs();
  else if (sideTab === 'outline') drawOutline();
  else drawSearch();
}

function drawThumbs() {
  if (sidebar.hidden || sideTab !== 'pages' || !app.doc) return;
  thumbIo?.disconnect();
  const doc = app.doc;
  const list = h('div.thumbs', { role: 'list' });
  sideBody.replaceChildren(list);
  thumbIo = lazyThumbs(sideBody, (id) => app.doc?.pages.find((p) => p.id === id), 120);
  let dragId = null;
  const clearMarks = () => list.querySelectorAll('.drop-before,.drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  doc.pages.forEach((pg, i) => {
    const slot = h('div.thumb-slot', { dataset: { id: pg.id }, style: { aspectRatio: `${pg.w} / ${pg.h}` } });
    const btn = h(
      'button.thumb',
      {
        type: 'button',
        role: 'listitem',
        draggable: true,
        title: `Page ${i + 1}. Drag to reorder, right-click for more.`,
        'aria-label': 'Go to page ' + (i + 1),
        dataset: { i, id: pg.id },
        onClick: () => {
          setMode('view');
          app.viewer.scrollToPage(i);
          if (innerWidth <= 760 && !sidebar.classList.contains('strip')) toggleSidebar(false);
        },
        onContextmenu: (e) => {
          e.preventDefault();
          thumbMenu(e.currentTarget, i);
        },
        onDragstart: (e) => {
          dragId = pg.id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', 'page');
          btn.classList.add('dragging');
        },
        onDragend: () => {
          dragId = null;
          btn.classList.remove('dragging');
          clearMarks();
        },
        onDragover: (e) => {
          if (!dragId) return;
          e.preventDefault();
          const r = btn.getBoundingClientRect();
          const horizontal = sidebar.classList.contains('strip');
          const after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
          clearMarks();
          btn.classList.add(after ? 'drop-after' : 'drop-before');
        },
        onDrop: (e) => {
          if (!dragId) return;
          e.preventDefault();
          e.stopPropagation();
          const after = btn.classList.contains('drop-after');
          clearMarks();
          if (dragId === pg.id) return;
          const moving = doc.pages.find((p) => p.id === dragId);
          doc.change('pages', () => {
            const rest = doc.pages.filter((p) => p.id !== dragId);
            rest.splice(rest.findIndex((p) => p.id === pg.id) + (after ? 1 : 0), 0, moving);
            doc.pages = rest;
          });
          app.viewer.scrollToPage(doc.pages.indexOf(moving));
        },
      },
      slot,
      h('span.thumb-num', i + 1),
    );
    list.append(btn);
    thumbIo.observe(slot);
  });
  markCurrentThumb(true);
}

function thumbMenu(anchor, i) {
  const doc = app.doc;
  const pg = doc.pages[i];
  const replace = (fn) => doc.change('pages', () => (doc.pages = fn([...doc.pages])));
  popMenu(anchor, [
    { icon: 'RotateCcw', label: 'Rotate left', onClick: () => replace((ps) => ((ps[i] = rotatePage(pg, -1)), ps)) },
    { icon: 'RotateCw', label: 'Rotate right', onClick: () => replace((ps) => ((ps[i] = rotatePage(pg, 1)), ps)) },
    { icon: 'Copy', label: 'Duplicate', onClick: () => replace((ps) => (ps.splice(i + 1, 0, clonePage(pg)), ps)) },
    {
      icon: 'FilePlus2',
      label: 'Insert blank page after',
      onClick: async () => {
        const blank = pagesFromSource(await addSource(await blankPdf(pg.w, pg.h), 'Blank page'));
        replace((ps) => (ps.splice(i + 1, 0, ...blank), ps));
      },
    },
    { icon: 'FileOutput', label: 'Extract to new tab', onClick: () => app.newDocFromPages([clonePage(pg)], baseName(doc.name) + ` (page ${i + 1}).pdf`) },
    '-',
    {
      icon: 'Trash2',
      label: 'Delete page',
      disabled: doc.pages.length < 2,
      onClick: () => replace((ps) => (ps.splice(i, 1), ps)),
    },
  ]);
}

function markCurrentThumb(scroll) {
  if (sidebar.hidden || sideTab !== 'pages') return;
  const cur = app.viewer.current || 0;
  for (const t of sideBody.querySelectorAll('.thumb')) {
    const on = +t.dataset.i === cur;
    t.classList.toggle('on', on);
    if (on && (scroll || true)) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

async function drawOutline() {
  const pdf = app.doc.primarySource()?.pdf;
  let outline = null;
  try {
    outline = await pdf.getOutline();
  } catch {}
  if (sideTab !== 'outline') return;
  if (!outline?.length) return sideBody.replaceChildren(h('p.empty', 'This document has no outline.'));
  const tree = (items, depth) =>
    h(
      'ul.outline',
      items.map((it) =>
        h(
          'li',
          h(
            'button',
            {
              type: 'button',
              style: { paddingLeft: 10 + depth * 14 + 'px' },
              onClick: () => {
                setMode('view');
                app.viewer.goToDest(it.dest);
                if (innerWidth <= 760) toggleSidebar(false);
              },
            },
            it.title,
          ),
          it.items?.length ? tree(it.items, depth + 1) : null,
        ),
      ),
    );
  sideBody.replaceChildren(tree(outline, 0));
}

async function pageText(pg) {
  const src = sources.get(pg.src);
  src.texts ||= [];
  if (src.texts[pg.idx] == null) {
    const { page } = await pageView(pg, 1);
    const tc = await page.getTextContent();
    src.texts[pg.idx] = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
  }
  return src.texts[pg.idx] + (pg.ocr ? '\n' + pg.ocr.map((w) => w.text).join(' ') : '');
}

function openSearch() {
  if (!app.doc) return;
  setMode('view');
  sideTab = 'search';
  toggleSidebar(true);
  drawSidebar();
  document.getElementById('search-input')?.focus();
}

function drawSearch() {
  const input = h('input#search-input', { type: 'search', placeholder: 'Find in document', value: searchState.q, autocomplete: 'off' });
  const out = h('div.search-results');
  const run = debounce(async () => {
    const q = input.value.trim();
    searchState.q = q;
    app.viewer.setSearch(q);
    if (q.length < 2) return out.replaceChildren(h('p.empty', q ? 'Type at least 2 characters.' : 'Results appear here.'));
    const doc = app.doc;
    const token = (searchState.token = uid());
    out.replaceChildren(h('p.empty', 'Searching…'));
    const rows = [];
    let total = 0;
    const lq = q.toLowerCase();
    for (let i = 0; i < doc.pages.length; i++) {
      const text = (await pageText(doc.pages[i])).replace(/\s+/g, ' ');
      if (searchState.token !== token) return;
      const low = text.toLowerCase();
      let at = low.indexOf(lq);
      let n = 0;
      while (at >= 0 && n < 5) {
        const s = Math.max(0, at - 30);
        rows.push(
          h(
            'button.result',
            {
              type: 'button',
              onClick: () => {
                app.viewer.scrollToPage(i);
                if (innerWidth <= 760) toggleSidebar(false);
              },
            },
            h('span.result-page', 'Page ' + (i + 1)),
            h('span.result-text', (s ? '…' : '') + text.slice(s, at), h('mark', text.slice(at, at + q.length)), text.slice(at + q.length, at + q.length + 50) + '…'),
          ),
        );
        n++;
        total++;
        at = low.indexOf(lq, at + lq.length);
      }
    }
    out.replaceChildren(h('p.empty', total ? `${total} match${total > 1 ? 'es' : ''}` : 'No matches. Scanned pages need "Recognize text (OCR)" from the More menu first.'), ...rows);
  }, 250);
  input.addEventListener('input', run);
  sideBody.replaceChildren(h('div.search-box', input), out);
  if (searchState.q) run();
}

/* ================= save / print / share / export ================= */

async function build(doc = app.doc, title = 'Preparing document') {
  const big = doc.pages.length > 25 || doc.pages.some((p) => p.annots.some((a) => a.type === 'redact'));
  const pr = big ? progress(title) : null;
  try {
    const opts = { onProgress: (i, n) => pr?.set(`Page ${Math.min(i + 1, n)} of ${n}`, i / n) };
    const bytes = await buildPdf(doc, opts);
    const redacted = doc.pages.filter((p) => p.annots.some((a) => a.type === 'redact')).length;
    if (opts.flattened > 0 && opts.flattened !== redacted) {
      toast(`${opts.flattened} page${opts.flattened > 1 ? 's were' : ' was'} saved as ${opts.flattened > 1 ? 'images' : 'an image'} with searchable text, because the original file uses PDF features this app cannot rewrite.`);
    }
    return bytes;
  } finally {
    pr?.close();
  }
}

async function save(saveAs) {
  const doc = app.doc;
  if (!doc) return false;
  app.viewer.commitEdit();
  try {
    const redacting = doc.pages.filter((p) => p.annots.some((a) => a.type === 'redact')).length;
    if (redacting) {
      const ok = await confirmDlg('Apply redactions?', `${redacting} page${redacting > 1 ? 's' : ''} will be flattened to an image with the marked areas removed. Text on those pages will no longer be selectable. Saving over the original file cannot be undone.`, 'Redact and save', true);
      if (!ok) return false;
    }
    const bytes = await build(doc);
    const res = await fsx.saveBytes(doc.name, bytes, doc.ref, saveAs || !doc.ref);
    if (!res) return false;
    doc.ref = res.ref;
    doc.name = res.name;
    doc.dirty = false;
    await store.clearAutosave(doc.id);
    remember(doc, bytes);
    drawTabs();
    syncDocUi();
    toast(res.how === 'downloaded' ? 'Saved to your downloads' : 'Saved');
    return true;
  } catch (e) {
    console.error(e);
    toast('Could not save: ' + e.message, 'error');
    return false;
  }
}

async function shareDoc() {
  try {
    const bytes = await build();
    await fsx.shareFile(app.doc.name, bytes);
  } catch (e) {
    toast('Sharing is not available here: ' + e.message, 'error');
  }
}

async function renderExported(bytes, dpi, type, quality, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), password: app.doc.protect?.password }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i, pdf.numPages);
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: g, viewport: vp }).promise;
    out.push({ bytes: await canvasToBytes(c, type, quality), w: vp.width / (dpi / 72), h: vp.height / (dpi / 72) });
    c.width = 0;
  }
  await pdf.destroy();
  return out;
}

async function printDoc() {
  const pr = progress('Preparing to print');
  try {
    const bytes = await buildPdf(app.doc);
    const pages = await renderExported(bytes, 150, 'image/jpeg', 0.92, (i, n) => pr.set(`Page ${i} of ${n}`, i / n));
    const urls = pages.map((p) => URL.createObjectURL(new Blob([p.bytes], { type: 'image/jpeg' })));
    const style = h('style', `@page { size: ${pages[0].w}pt ${pages[0].h}pt; margin: 0 }`);
    const imgs = urls.map((u) => h('img', { src: u, alt: '' }));
    printRoot.replaceChildren(style, ...imgs);
    await Promise.all(imgs.map((im) => im.decode().catch(() => {})));
    pr.close();
    const cleanup = () => {
      printRoot.replaceChildren();
      urls.forEach((u) => URL.revokeObjectURL(u));
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  } catch (e) {
    pr.close();
    toast('Could not print: ' + e.message, 'error');
  }
}

/** Parse "1-3, 5, 8-" into zero-based page indices. */
function parseRange(text, count) {
  const out = new Set();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/);
    if (m) {
      const a = m[1] ? +m[1] : 1;
      const b = m[2] ? +m[2] : count;
      for (let i = Math.max(1, a); i <= Math.min(count, b); i++) out.add(i - 1);
    } else if (/^\d+$/.test(part) && +part >= 1 && +part <= count) out.add(+part - 1);
    else return null;
  }
  return [...out].sort((x, y) => x - y);
}

const EXPORTS = [
  ['docx', 'FileText', 'Word', 'Editable text, headings and paragraphs (.docx)'],
  ['docx-layout', 'FileText', 'Word, exact look', 'Each page as a picture, identical to the PDF (.docx)'],
  ['xlsx', 'FileSpreadsheet', 'Excel', 'Text placed in rows and columns, one sheet per page (.xlsx)'],
  ['pptx', 'Presentation', 'PowerPoint', 'One slide per page (.pptx)'],
  ['png', 'FileImage', 'PNG images', 'Sharp pictures of each page'],
  ['jpg', 'FileImage', 'JPEG images', 'Smaller pictures of each page'],
  ['txt', 'FileType', 'Plain text', 'Just the words (.txt)'],
  ['pdf', 'FileDown', 'PDF copy', 'A separate PDF, for example of selected pages'],
];

async function exportDialog() {
  const doc = app.doc;
  if (!doc) return;
  app.viewer.commitEdit();
  let fmt = store.getPref('exportFmt', 'docx');
  const cur = (app.viewer.current || 0) + 1;
  const grid = h(
    'div.export-grid',
    { role: 'radiogroup', 'aria-label': 'Format' },
    EXPORTS.map(([id, ic, title, sub]) =>
      h(
        'label.export-opt',
        h('input', { type: 'radio', name: 'export-fmt', value: id, id: 'exp-' + id, checked: id === fmt, onChange: () => ((fmt = id), sync()) }),
        h('span.export-ic', icon(ic, 20)),
        h('span.export-t', title),
        h('span.export-s', sub),
      ),
    ),
  );
  const range = h('input#exp-range', { type: 'text', placeholder: 'e.g. 1-3, 5', autocomplete: 'off', disabled: true });
  const pagesSel = h(
    'div.stack.tight',
    h('label.radio', h('input', { type: 'radio', name: 'exp-pages', value: 'all', id: 'exp-all', checked: true, onChange: () => (range.disabled = true) }), h('span', `All ${doc.pages.length} pages`)),
    h('label.radio', h('input', { type: 'radio', name: 'exp-pages', value: 'cur', id: 'exp-cur', onChange: () => (range.disabled = true) }), h('span', `Current page (${cur})`)),
    h('label.radio', h('input', { type: 'radio', name: 'exp-pages', value: 'range', id: 'exp-rng', onChange: () => ((range.disabled = false), range.focus()) }), h('span', 'Pages'), range),
  );
  const dpi = h(
    'select#exp-dpi',
    { 'aria-label': 'Image resolution' },
    [
      [96, 'Screen (96 dpi)'],
      [150, 'Standard (150 dpi)'],
      [300, 'Print (300 dpi)'],
    ].map(([v, l]) => h('option', { value: v, selected: v === 150 }, l)),
  );
  const dpiRow = h('label.row.left', h('span.muted', 'Resolution'), dpi);
  const err = h('p.error', { hidden: true });
  const sync = () => (dpiRow.hidden = !['png', 'jpg'].includes(fmt));
  sync();
  const choice = await modal(
    'Export',
    h('div.stack', grid, h('div.export-cols', h('div.stack.tight', h('strong', 'Pages'), pagesSel), dpiRow), err),
    [
      { label: 'Cancel', value: undefined },
      {
        label: 'Export',
        primary: true,
        validate: () => {
          const which = document.querySelector('input[name="exp-pages"]:checked').value;
          const idx = which === 'all' ? doc.pages.map((_, i) => i) : which === 'cur' ? [cur - 1] : parseRange(range.value, doc.pages.length);
          if (!idx?.length) {
            err.textContent = 'Enter pages like 1-3, 5.';
            err.hidden = false;
            return undefined;
          }
          return { idx, dpi: +dpi.value };
        },
      },
    ],
    { wide: true },
  );
  if (!choice) return;
  store.setPref('exportFmt', fmt);
  const base = baseName(doc.name) + (choice.idx.length < doc.pages.length ? (choice.idx.length === 1 ? `-p${choice.idx[0] + 1}` : '-pages') : '');
  const pr = progress('Exporting');
  try {
    const part = new Doc(doc.name);
    part.pages = choice.idx.map((i) => doc.pages[i]);
    // Other formats read the PDF back, so build it unencrypted; only a PDF copy keeps the password.
    part.protect = fmt === 'pdf' ? doc.protect : null;
    pr.set('Preparing pages', null);
    const pdf = await buildPdf(part);
    const step = (i, n) => pr.set(`Page ${i + 1} of ${n}`, i / n);
    let out;
    if (fmt === 'pdf') out = { name: base + (choice.idx.length < doc.pages.length ? '' : '-copy') + '.pdf', bytes: pdf, mime: ex.MIME.pdf };
    else if (fmt === 'docx' || fmt === 'docx-layout') out = { name: base + '.docx', bytes: await ex.toDocx(pdf, { mode: fmt === 'docx' ? 'text' : 'layout', onProgress: step }), mime: ex.MIME.docx };
    else if (fmt === 'xlsx') out = { name: base + '.xlsx', bytes: await ex.toXlsx(pdf, { onProgress: step }), mime: ex.MIME.xlsx };
    else if (fmt === 'pptx') out = { name: base + '.pptx', bytes: await ex.toPptx(pdf, { onProgress: step }), mime: ex.MIME.pptx };
    else if (fmt === 'png' || fmt === 'jpg') out = await ex.toImages(pdf, base, { format: fmt, dpi: choice.dpi, onProgress: step });
    else if (fmt === 'txt') {
      const bytes = await ex.toText(pdf);
      if (bytes.length < 3) throw new Error('No text found. Run "Recognize text (OCR)" first for scanned pages.');
      out = { name: base + '.txt', bytes, mime: ex.MIME.txt };
    }
    pr.close();
    const res = await fsx.saveBytes(out.name, out.bytes, null, true, out.mime);
    if (res) toast(res.how === 'downloaded' ? `Exported ${res.name} to your downloads` : `Exported ${res.name}`);
  } catch (e) {
    pr.close();
    console.error(e);
    toast('Could not export: ' + e.message, 'error');
  }
}

app.splitDoc = async () => {
  const doc = app.doc;
  const n = h('input#split-n', { type: 'number', min: 1, max: doc.pages.length, value: 1 });
  const every = await modal('Split into files', h('div.stack', h('label', { for: 'split-n' }, 'Pages per file'), n, h('p.muted', `The ${doc.pages.length} pages are saved as separate PDFs inside one zip file.`)), [
    { label: 'Cancel', value: undefined },
    { label: 'Split', primary: true, validate: () => clamp(parseInt(n.value, 10) || 1, 1, doc.pages.length) },
  ]);
  if (!every) return;
  const pr = progress('Splitting');
  try {
    const files = {};
    const base = baseName(doc.name);
    const total = Math.ceil(doc.pages.length / every);
    for (let i = 0; i < total; i++) {
      pr.set(`File ${i + 1} of ${total}`, i / total);
      const part = new Doc(doc.name);
      part.pages = doc.pages.slice(i * every, (i + 1) * every);
      part.protect = doc.protect;
      files[`${base}-${String(i + 1).padStart(3, '0')}.pdf`] = [await buildPdf(part), { level: 0 }];
    }
    pr.close();
    await fsx.saveBytes(base + '-split.zip', zipSync(files), null, true, 'application/zip');
  } catch (e) {
    pr.close();
    toast('Could not split: ' + e.message, 'error');
  }
};

/* ================= protect / compress / OCR ================= */

async function protectDialog() {
  const doc = app.doc;
  const p1 = h('input#pw-new', { type: 'password', autocomplete: 'new-password', placeholder: 'New password' });
  const p2 = h('input#pw-new2', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat password' });
  const err = h('p.error', { hidden: true });
  const v = await modal(
    'Password protection',
    h(
      'div.stack',
      h('p', doc.protect ? 'This document asks for a password when opened. Set a new one, or remove it.' : 'Anyone opening the saved file will need this password. There is no way to recover it if you forget it.'),
      p1,
      p2,
      err,
    ),
    [
      { label: 'Cancel', value: undefined },
      ...(doc.protect ? [{ label: 'Remove password', value: 'remove', danger: true }] : []),
      {
        label: 'Set password',
        primary: true,
        validate: () => {
          const msg = !p1.value ? 'Enter a password.' : p1.value !== p2.value ? 'The two passwords do not match.' : '';
          err.textContent = msg;
          err.hidden = !msg;
          return msg ? undefined : p1.value;
        },
      },
    ],
  );
  if (v === undefined) return;
  doc.protect = v === 'remove' ? null : { password: v };
  doc.touch();
  toast(v === 'remove' ? 'Password will be removed when you save' : 'Password will be applied when you save');
}

async function compressDialog() {
  const doc = app.doc;
  const opts = [
    ['std', 'Standard', 'Repacks the file. Nothing changes visually and text stays selectable. Modest savings.'],
    ['150', 'Strong', 'Turns every page into a 150 dpi image. Best for scans and photos. Text can no longer be selected.'],
    ['96', 'Strongest', 'Turns every page into a 96 dpi image. Smallest file, visibly softer.'],
  ];
  const body = h(
    'div.stack',
    opts.map(([val, t, d], i) => h('label.radio', h('input', { type: 'radio', name: 'cmp', value: val, checked: i === 0, id: 'cmp-' + val }), h('span', h('strong', t), h('span.muted', d)))),
  );
  const level = await modal('Reduce file size', body, [
    { label: 'Cancel', value: undefined },
    { label: 'Compress', primary: true, validate: () => body.querySelector('input:checked').value },
  ]);
  if (!level) return;
  const pr = progress('Compressing');
  let before;
  let out;
  try {
    out = await buildPdf(doc, { onProgress: (i, n) => pr.set('Preparing', (i / n) * 0.3) });
    before = sources.get(doc.pages[0].src).bytes.length;
    before = doc.usedSources().reduce((n, s) => n + s.bytes.length, 0);
    if (level !== 'std') {
      const temp = { protect: doc.protect };
      out = await rasterizePdf(await stripPassword(doc, out), +level, level === '96' ? 0.6 : 0.72, pdfjsLib, (i, n) => pr.set(`Page ${i + 1} of ${n}`, 0.3 + (i / n) * 0.7));
      void temp;
    }
    pr.close();
  } catch (e) {
    pr.close();
    return toast('Could not compress: ' + e.message, 'error');
  }
  const pct = Math.round((1 - out.length / before) * 100);
  const ok = await modal(
    'Compressed',
    h('div.stack', h('p.sizes', h('span', fmtSize(before)), icon('ArrowRight', 18), h('strong', fmtSize(out.length))), h('p.muted', pct > 0 ? `${pct}% smaller. Your open document is not changed; this saves a separate copy.` : 'This file is already compact, so this setting does not make it smaller.')),
    [
      { label: 'Close', value: false },
      { label: 'Save compressed copy', value: true, primary: true },
    ],
  );
  if (ok) await fsx.saveBytes(baseName(doc.name) + '-small.pdf', out, null, true);
}

/** Rasterising reads the built file back, so build it without encryption when a password is set. */
async function stripPassword(doc, built) {
  if (!doc.protect) return built;
  const clone = new Doc(doc.name);
  clone.pages = doc.pages;
  return buildPdf(clone);
}

async function ocrDialog() {
  const doc = app.doc;
  const cur = app.viewer.current || 0;
  const body = h(
    'div.stack',
    h('p', 'Reads the text in scanned pages and photos so you can search, select, and highlight it. Recognition runs on this device and works best on clear English print.'),
    h('label.radio', h('input', { type: 'radio', name: 'ocr', value: 'cur', checked: true, id: 'ocr-cur' }), h('span', h('strong', `This page (${cur + 1})`))),
    h('label.radio', h('input', { type: 'radio', name: 'ocr', value: 'all', id: 'ocr-all' }), h('span', h('strong', 'All pages without text'), h('span.muted', `Checks all ${doc.pages.length} pages and skips those that already have text.`))),
  );
  const scope = await modal('Recognize text (OCR)', body, [
    { label: 'Cancel', value: undefined },
    { label: 'Start', primary: true, validate: () => body.querySelector('input:checked').value },
  ]);
  if (!scope) return;
  const pr = progress('Recognizing text');
  let cancelled = false;
  try {
    const targets = [];
    for (const pg of scope === 'cur' ? [doc.pages[cur]] : doc.pages) {
      if (pg.ocr) continue;
      if (scope === 'all' && (await hasText(pg))) continue;
      targets.push(pg);
    }
    if (!targets.length) {
      pr.close();
      return toast(scope === 'cur' ? 'This page was already recognized.' : 'Every page already has text.');
    }
    const results = new Map();
    let words = 0;
    for (let i = 0; i < targets.length; i++) {
      pr.set(`Page ${i + 1} of ${targets.length}`, i / targets.length);
      const res = await ocrPage(targets[i], (m) => {
        if (m.status === 'recognizing text') pr.set(`Page ${i + 1} of ${targets.length}`, (i + m.progress) / targets.length);
        else if (i === 0) pr.set('Loading the recognition engine…', null);
      });
      results.set(targets[i].id, res);
      words += res.length;
    }
    if (cancelled) return;
    doc.change('annots', () => {
      doc.pages = doc.pages.map((p) => (results.has(p.id) ? { ...p, ocr: results.get(p.id) } : p));
    });
    app.viewer.syncPages();
    pr.close();
    toast(words ? `Recognized ${words} words on ${targets.length} page${targets.length > 1 ? 's' : ''}` : 'No text was found.');
  } catch (e) {
    console.error(e);
    pr.close();
    toast('Text recognition failed: ' + (e.message || e), 'error');
  }
}

/* ================= insert image / signature / text ================= */

async function placeImageFile(file) {
  const img = await loadImage(await readAsDataUrl(file));
  // Re-encode large or exotic images so the PDF only ever embeds PNG or JPEG.
  const png = file.type === 'image/png';
  const k = Math.min(1, 2000 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  const g = c.getContext('2d');
  if (!png) {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
  }
  g.drawImage(img, 0, 0, c.width, c.height);
  app.viewer.placeImage(c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9), c.width, c.height, 260);
}

async function addImage() {
  const [f] = await fsx.openFiles('image', { multiple: false });
  if (!f) return;
  try {
    await placeImageFile(f.file);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function addSignature() {
  const sig = await signatureDialog();
  if (sig) app.viewer.placeImage(sig.data, sig.w, sig.h, 170);
}

function placeText(text, size = 12) {
  const v = app.viewer;
  const pg = app.doc.pages[v.current || 0];
  const g = document.createElement('canvas').getContext('2d');
  g.font = `${size}px ${FONT_CSS.sans}`;
  const w = g.measureText(text).width + TEXT_PAD * 2 + 4;
  const el = v.els.get(pg.id);
  const hostR = viewerEl.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const y = clamp((hostR.top + hostR.height / 2 - r.top) / v.scale, 10, pg.h - 30);
  v.addAnnot(pg, { type: 'text', x: (pg.w - w) / 2, y, w, h: size * LINE_H + TEXT_PAD * 2, text, size, family: 'sans', bold: false, italic: false, color: '#000000', angle: 0 });
  toast('Drag it into place');
}

/* ================= help ================= */

function helpMenu(anchor) {
  popMenu(anchor, [
    { icon: 'BookOpen', label: 'User manual', onClick: openManual },
    { icon: 'Keyboard', label: 'Keyboard shortcuts', onClick: shortcutsDialog },
    '-',
    { icon: 'Info', label: 'About Tala PDF', onClick: aboutDialog },
  ]);
}

/** Open the manual as a document in its own tab, so it can be read, searched and saved like any PDF. */
async function openManual() {
  const open = app.docs.find((d) => d.isManual);
  if (open) return activate(open);
  try {
    const res = await fetch(MANUAL_URL);
    if (!res.ok) throw new Error('The manual is missing from this installation.');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const src = await addSource(bytes, 'Tala PDF Manual.pdf', askPassword);
    const doc = new Doc('Tala PDF Manual.pdf');
    doc.pages = pagesFromSource(src);
    doc.isManual = true;
    addDoc(doc);
  } catch (e) {
    toast('Could not open the manual: ' + e.message, 'error');
  }
}

const SHORTCUTS = [
  ['Open a file', 'Ctrl+O'],
  ['Save', 'Ctrl+S'],
  ['Save as', 'Ctrl+Shift+S'],
  ['Export', 'Ctrl+Shift+E'],
  ['Print', 'Ctrl+P'],
  ['Find in document', 'Ctrl+F'],
  ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'],
  ['Zoom in / out', 'Ctrl+= / Ctrl+-'],
  ['Fit page width', 'Ctrl+0'],
  ['Delete the selected item', 'Delete'],
  ['Back to the Select tool', 'Esc'],
  ['Select all pages (Pages view)', 'Ctrl+A'],
  ['Open the manual', 'F1'],
];

function shortcutsDialog() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  modal(
    'Keyboard shortcuts',
    h(
      'div.stack',
      h(
        'table.keys',
        h('tbody', SHORTCUTS.map(([what, keys]) => h('tr', h('td', what), h('td', keys.split(' / ').map((k, i) => [i ? ' / ' : '', h('kbd', mac ? k.replace(/Ctrl/g, '⌘') : k)]))))),
      ),
      mac ? h('p.muted', '⌘ is the Command key.') : null,
    ),
  );
}

function aboutDialog() {
  modal(
    'About Tala PDF',
    h(
      'div.about',
      h('img', { src: './icon.svg', alt: '', width: 72, height: 72 }),
      h('div.stack.tight', h('strong.about-name', 'Tala PDF'), h('span.muted', 'Version ' + APP_VERSION), h('span', APP_CREDIT)),
      h('p', 'Read, mark up, sign and edit PDFs. Your files stay on this device and are never uploaded.'),
      h('p.muted', 'Tala is the Filipino word for star. Built with pdf.js, pdf-lib, Tesseract.js, mammoth, ExcelJS, docx and PptxGenJS. Licensed under the GNU GPL v3.'),
    ),
    [
      { label: 'User manual', value: 'manual' },
      { label: 'Close', value: true, primary: true },
    ],
  ).then((v) => v === 'manual' && openManual());
}

/* ================= theme ================= */

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.getElementById('theme-btn').replaceChildren(icon(dark ? 'Sun' : 'Moon'));
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const t = dark ? 'light' : 'dark';
  store.setPref('theme', t);
  applyTheme(t);
}
function toggleInvert() {
  const on = viewerEl.classList.toggle('invert');
  store.setPref('invert', on);
}
applyTheme(store.getPref('theme', null));
viewerEl.classList.toggle('invert', store.getPref('invert', false));

/* ================= global input ================= */

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
  if (document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (e.key === 'F1') return e.preventDefault(), openManual();
  if (mod && k === 'o') return e.preventDefault(), openPicker();
  if (!app.doc || app.mode === 'home') return;
  if (mod && k === 's') return e.preventDefault(), save(e.shiftKey);
  if (mod && k === 'p') return e.preventDefault(), printDoc();
  if (mod && e.shiftKey && k === 'e') return e.preventDefault(), exportDialog();
  if (mod && k === 'f') return e.preventDefault(), openSearch();
  if (typing) return;
  if (mod && k === 'z') return e.preventDefault(), e.shiftKey ? app.doc.doRedo() : app.doc.doUndo();
  if (mod && k === 'y') return e.preventDefault(), app.doc.doRedo();
  if (mod && (k === '=' || k === '+')) return e.preventDefault(), app.viewer.setScale(app.viewer.scale * 1.2);
  if (mod && k === '-') return e.preventDefault(), app.viewer.setScale(app.viewer.scale / 1.2);
  if (mod && k === '0') return e.preventDefault(), app.viewer.fitWidth(true);
  if (app.mode === 'organize') {
    if (mod && k === 'a') return e.preventDefault(), app.organizer.selectAll();
    if ((k === 'delete' || k === 'backspace') && app.organizer.sel.size) return e.preventDefault(), app.organizer.remove();
    return;
  }
  if ((k === 'delete' || k === 'backspace') && app.viewer.deleteSelected()) return e.preventDefault();
  if (k === 'escape') {
    if (app.viewer.sel) app.viewer.select(null);
    else app.viewer.setTool('select');
  }
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) document.body.classList.remove('dropping');
});
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const files = [...e.dataTransfer.files];
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  const others = files.filter((f) => !pdfs.includes(f) && !imgs.includes(f));
  if (others.length) openEntries(await Promise.all(others.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), ref: null }))));
  if (pdfs.length) {
    const entries = await Promise.all(pdfs.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), ref: fsx.isDesktop ? window.desktop.pathFor?.(f) || null : null })));
    if (app.mode === 'organize') {
      const pages = [];
      for (const en of entries) pages.push(...pagesFromSource(await addSource(en.bytes, en.name, askPassword)));
      app.organizer.insert(pages);
    } else openEntries(entries);
  } else if (imgs.length) {
    if (app.mode === 'view') placeImageFile(imgs[0]);
    else if (app.mode === 'organize') app.organizer.insert(await imagesToPages(imgs));
    else {
      const doc = new Doc(imgs[0].name.replace(/\.[a-z0-9]+$/i, '') + '.pdf');
      doc.pages = await imagesToPages(imgs);
      addDoc(doc, { dirty: true });
    }
  }
});

document.addEventListener('paste', (e) => {
  if (app.mode !== 'view' || e.target.closest?.('input, textarea, [contenteditable]')) return;
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) {
    e.preventDefault();
    placeImageFile(f);
  }
});

if (!fsx.isDesktop) {
  window.addEventListener('beforeunload', (e) => {
    if (app.docs.some((d) => d.dirty)) e.preventDefault();
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) for (const d of app.docs) if (d.dirty) store.writeAutosave(d);
});

fsx.onExternalOpen((entry) => openEntries([entry]));
document.addEventListener('test-open', (e) => openEntries([e.detail]));
void MARKUP_TOOLS;
void DRAW_TOOLS;
void clonePage;

setMode('home');
window.desktop?.onMenu?.((what) => ({ manual: openManual, shortcuts: shortcutsDialog, about: aboutDialog })[what]?.());
window.desktop?.ready?.();

/* Let the opening animation finish (about 1.6 s), then fade it away. Skip the wait when motion is reduced. */
{
  const splash = document.getElementById('splash');
  if (splash) {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shown = performance.now();
    const wait = Math.max(0, (reduced ? 300 : 1700) - shown);
    setTimeout(() => {
      splash.classList.add('done');
      setTimeout(() => splash.remove(), 400);
    }, wait);
  }
}
