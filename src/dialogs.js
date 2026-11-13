import { h, icon, readAsDataUrl, loadImage } from './util.js';
import { getSignatures, setSignatures } from './store.js';

/**
 * Show a modal. buttons: [{label, value, primary, danger, validate()}].
 * Resolves with the chosen button's value (or its validate() result), undefined when dismissed.
 */
export function modal(title, body, buttons = [{ label: 'Close', value: true }], { wide = false } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog.modal' + (wide ? '.wide' : ''));
    let result;
    const close = (v) => {
      result = v;
      dlg.close();
    };
    const form = h(
      'form',
      {
        onSubmit: (e) => {
          e.preventDefault();
          const b = buttons.find((x) => x.primary) || buttons[buttons.length - 1];
          pick(b);
        },
      },
      h('header', h('h2', title), h('button.iconbtn', { type: 'button', 'aria-label': 'Close', onClick: () => close(undefined) }, icon('X'))),
      h('div.modal-body', body),
      h(
        'footer',
        buttons.map((b) =>
          h('button.btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''), { type: b.primary ? 'submit' : 'button', onClick: b.primary ? null : () => pick(b) }, b.label),
        ),
      ),
    );
    const pick = async (b) => {
      if (b.validate) {
        const v = await b.validate();
        if (v === undefined) return;
        return close(v);
      }
      close(b.value);
    };
    dlg.append(form);
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    dlg.addEventListener('pointerdown', (e) => {
      if (e.target === dlg) close(undefined);
    });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('[autofocus], input, textarea, select');
    first?.focus();
  });
}

export const confirmDlg = (title, text, okLabel = 'OK', danger = false) =>
  modal(title, h('p', text), [
    { label: 'Cancel', value: false },
    { label: okLabel, value: true, primary: !danger, danger },
  ]).then((v) => !!v);

export function askPassword(retry, name) {
  const inp = h('input#pw-open', { type: 'password', autocomplete: 'off', placeholder: 'Password' });
  return modal(
    'Password needed',
    h('div.stack', h('p', retry ? 'That password did not work. Try again.' : `"${name}" is protected. Enter its password to open it.`), inp),
    [
      { label: 'Cancel', value: null },
      { label: 'Open', primary: true, validate: () => inp.value || undefined },
    ],
  ).then((v) => v ?? null);
}

/** Resolves: string = save, null = delete the note, undefined = cancel. */
export function askNote(text, isNew) {
  const ta = h('textarea#note-text', { rows: 5, placeholder: 'Write a note…' });
  ta.value = text || '';
  return modal(isNew ? 'Add note' : 'Note', ta, [
    ...(isNew ? [] : [{ label: 'Delete note', value: null, danger: true }]),
    { label: 'Cancel', value: undefined },
    { label: 'Save', primary: true, validate: () => ta.value },
  ]);
}

/** Trim transparent margins so a signature's box hugs the ink. */
function trimCanvas(c) {
  const g = c.getContext('2d');
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width, x1 + pad);
  y1 = Math.min(height, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0;
  out.height = y1 - y0;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { data: out.toDataURL('image/png'), w: out.width, h: out.height };
}

/** Signature picker: saved signatures, draw, type, or upload. Resolves {data, w, h} or undefined. */
export async function signatureDialog() {
  let saved = await getSignatures();
  let mode = 'draw';
  let color = '#111827';
  const W = 600;
  const H = 220;
  const pad = h('canvas.sigpad', { width: W, height: H });
  const g = pad.getContext('2d');
  let drawing = false;
  let hasInk = false;
  const pos = (e) => {
    const r = pad.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  let last = null;
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    drawing = true;
    last = pos(e);
    g.fillStyle = color;
    g.beginPath();
    g.arc(last[0], last[1], 1.6, 0, 7);
    g.fill();
    hasInk = true;
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    for (const c of e.getCoalescedEvents?.() || [e]) {
      const p = pos(c);
      g.strokeStyle = color;
      g.lineWidth = 3.2;
      g.lineCap = g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(last[0], last[1]);
      g.lineTo(p[0], p[1]);
      g.stroke();
      last = p;
    }
  });
  const stop = () => (drawing = false);
  pad.addEventListener('pointerup', stop);
  pad.addEventListener('pointercancel', stop);
  const clear = () => {
    g.clearRect(0, 0, W, H);
    hasInk = false;
  };

  const typed = h('input#sig-typed', { type: 'text', placeholder: 'Type your name', autocomplete: 'off' });
  const typedPreview = h('div.sig-typed-preview', 'Your name');
  typed.addEventListener('input', () => (typedPreview.textContent = typed.value || 'Your name'));
  let uploaded = null;
  const upPreview = h('div.sig-upload-preview', 'PNG or JPG. A signature on a white page works best.');
  const upInput = h('input#sig-file', {
    type: 'file',
    accept: 'image/*',
    onChange: async () => {
      const f = upInput.files[0];
      if (!f) return;
      const img = await loadImage(await readAsDataUrl(f));
      // Turn the paper white into transparency so only the ink is placed.
      const c = document.createElement('canvas');
      const k = Math.min(1, 1000 / img.width);
      c.width = img.width * k;
      c.height = img.height * k;
      const cg = c.getContext('2d');
      cg.drawImage(img, 0, 0, c.width, c.height);
      const id = cg.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < id.data.length; i += 4) {
        const lum = 0.3 * id.data[i] + 0.59 * id.data[i + 1] + 0.11 * id.data[i + 2];
        if (lum > 200) id.data[i + 3] = 0;
        else if (lum > 140) id.data[i + 3] = Math.round((255 * (200 - lum)) / 60);
      }
      cg.putImageData(id, 0, 0);
      uploaded = trimCanvas(c);
      upPreview.replaceChildren(uploaded ? h('img', { src: uploaded.data, alt: 'Uploaded signature' }) : 'No ink found in that image.');
    },
  });

  const panes = {
    draw: h('div.stack', pad, h('div.row', h('span.muted', 'Sign with a finger, pen, or mouse.'), h('button.btn.small', { type: 'button', onClick: clear }, 'Clear'))),
    type: h('div.stack', typed, typedPreview),
    upload: h('div.stack', upInput, upPreview),
  };
  const paneHost = h('div.sig-pane', panes.draw);
  const tabBtns = {};
  const tabs = h(
    'div.seg',
    { role: 'tablist' },
    ['draw', 'type', 'upload'].map(
      (m) =>
        (tabBtns[m] = h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': m === mode,
            onClick: () => {
              mode = m;
              for (const [k, b] of Object.entries(tabBtns)) b.setAttribute('aria-selected', k === m);
              paneHost.replaceChildren(panes[m]);
            },
          },
          m[0].toUpperCase() + m.slice(1),
        )),
    ),
  );
  const colors = h(
    'div.row',
    h('span.muted', 'Ink'),
    ['#111827', '#1d3fae', '#b42318'].map((c) =>
      h('button.swatch', {
        type: 'button',
        'aria-label': 'Ink colour ' + c,
        style: { background: c },
        onClick: (e) => {
          color = c;
          typedPreview.style.color = c;
          for (const s of e.target.parentNode.querySelectorAll('.swatch')) s.classList.toggle('on', s === e.target);
        },
      }),
    ),
  );
  colors.querySelector('.swatch').classList.add('on');
  const keep = h('input#sig-keep', { type: 'checkbox', checked: true });

  let dlgResolve;
  const savedHost = h('div.sig-saved');
  const drawSaved = () => {
    savedHost.replaceChildren(
      ...(saved.length ? [h('div.muted', 'Saved signatures')] : []),
      ...saved.map((s, i) =>
        h(
          'div.sig-item',
          h('button.sig-use', { type: 'button', onClick: () => dlgResolve(s) }, h('img', { src: s.data, alt: 'Saved signature ' + (i + 1) })),
          h(
            'button.iconbtn',
            {
              type: 'button',
              'aria-label': 'Remove saved signature',
              onClick: async () => {
                saved = saved.filter((x) => x !== s);
                await setSignatures(saved);
                drawSaved();
              },
            },
            icon('Trash2', 15),
          ),
        ),
      ),
    );
  };
  drawSaved();

  const make = () => {
    if (mode === 'draw') return hasInk ? trimCanvas(pad) : null;
    if (mode === 'upload') return uploaded;
    if (!typed.value.trim()) return null;
    const c = document.createElement('canvas');
    c.width = 900;
    c.height = 220;
    const cg = c.getContext('2d');
    cg.font = 'italic 110px "Snell Roundhand", "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';
    cg.fillStyle = color;
    cg.textBaseline = 'middle';
    cg.fillText(typed.value.trim(), 20, 110, 860);
    return trimCanvas(c);
  };

  const body = h('div.stack', savedHost, tabs, paneHost, colors, h('label.check', keep, 'Keep this signature on this device for next time'));
  const p = modal('Signature', body, [
    { label: 'Cancel', value: undefined },
    {
      label: 'Place signature',
      primary: true,
      validate: async () => {
        const sig = make();
        if (!sig) return undefined;
        if (keep.checked) await setSignatures([sig, ...saved].slice(0, 6));
        return sig;
      },
    },
  ]);
  // Picking a saved signature closes the dialog with that signature.
  return new Promise((resolve) => {
    dlgResolve = (s) => {
      resolve(s);
      document.querySelector('dialog.modal[open]')?.close();
    };
    p.then(resolve);
  });
}

/** Progress overlay for long jobs. Returns {set(text, frac), close()}. */
export function progress(title) {
  const bar = h('progress', { max: 1, value: 0 });
  const label = h('p.muted', 'Starting…');
  const dlg = h('dialog.modal.busy', h('div.modal-body.stack', h('h2', title), bar, label));
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  document.body.append(dlg);
  dlg.showModal();
  return {
    set(text, frac) {
      label.textContent = text;
      if (frac != null) bar.value = frac;
      else bar.removeAttribute('value');
    },
    close() {
      dlg.close();
      dlg.remove();
    },
  };
}
