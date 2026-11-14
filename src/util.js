import {
  createElement as lucideEl,
  FileText,
  Plus,
  Moon,
  Sun,
  Undo2,
  Redo2,
  Save,
  LayoutGrid,
  PanelLeft,
  FolderOpen,
  Search,
  ZoomOut,
  ZoomIn,
  MousePointer2,
  Highlighter,
  Underline,
  Strikethrough,
  MessageSquareText,
  Pen,
  Type,
  TextCursorInput,
  Square,
  Circle,
  Minus,
  MoveUpRight,
  Eraser,
  EyeOff,
  Image as ImageIcon,
  Signature,
  Ellipsis,
  SaveAll,
  Printer,
  Share2,
  ScanText,
  CalendarDays,
  Check,
  Lock,
  Minimize2,
  FileImage,
  FileType,
  Contrast,
  X,
  Bold,
  Italic,
  Trash2,
  FilePlus2,
  Images,
  Camera,
  Combine,
  History,
  ArrowRight,
  RotateCcw,
  RotateCw,
  ArrowLeft,
  Copy,
  FileOutput,
  ArrowRightLeft,
  Scissors,
  Files,
  ImagePlus,
  FileDown,
  FileSpreadsheet,
  Presentation,
  FileInput,
  GripVertical,
  CircleHelp,
  BookOpen,
  Keyboard,
  Info,
} from 'lucide';

const L = {
  FileText,
  Plus,
  Moon,
  Sun,
  Undo2,
  Redo2,
  Save,
  LayoutGrid,
  PanelLeft,
  FolderOpen,
  Search,
  ZoomOut,
  ZoomIn,
  MousePointer2,
  Highlighter,
  Underline,
  Strikethrough,
  MessageSquareText,
  Pen,
  Type,
  TextCursorInput,
  Square,
  Circle,
  Minus,
  MoveUpRight,
  Eraser,
  EyeOff,
  Image: ImageIcon,
  Signature,
  Ellipsis,
  SaveAll,
  Printer,
  Share2,
  ScanText,
  CalendarDays,
  Check,
  Lock,
  Minimize2,
  FileImage,
  FileType,
  Contrast,
  X,
  Bold,
  Italic,
  Trash2,
  FilePlus2,
  Images,
  Camera,
  Combine,
  History,
  ArrowRight,
  RotateCcw,
  RotateCw,
  ArrowLeft,
  Copy,
  FileOutput,
  ArrowRightLeft,
  Scissors,
  Files,
  ImagePlus,
  FileDown,
  FileSpreadsheet,
  Presentation,
  FileInput,
  GripVertical,
  CircleHelp,
  BookOpen,
  Keyboard,
  Info,
};

/** Tiny DOM builder: h('div.cls#id', {attrs/on*}, ...children) */
export function h(spec, props, ...kids) {
  const m = spec.match(/^([a-z0-9]+)?(.*)$/i);
  const el = document.createElement(m[1] || 'div');
  for (const part of m[2].match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props && (props instanceof Node || typeof props !== 'object' || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function icon(name, size = 18) {
  const def = L[name];
  if (!def) return h('span', '?');
  const el = lucideEl(def);
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function fmtAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString();
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function toast(msg, kind = '') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div#toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const el = h('div.toast' + (kind ? '.' + kind : ''), msg);
  host.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

export function canvasToBytes(canvas, type = 'image/png', q) {
  return new Promise((res) =>
    canvas.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), type, q),
  );
}

export function dataUrlToBytes(url) {
  const b = atob(url.split(',')[1]);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not read that image.'));
    img.src = src;
  });
}

export function readAsDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

export const baseName = (n) => n.replace(/\.pdf$/i, '');
