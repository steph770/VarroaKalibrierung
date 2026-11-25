// Kleine UI-Hilfen: Elemente bauen, Meldungen, Dialoge, Zoom-Ansicht, Kacheln

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// wie Element.append, aber ohne „null“/„false“ im Text (für bedingte Elemente)
export function put(parent, ...kids) {
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function toast(msg, kind = 'info', ms = 3200) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

// Bottom-Sheet-Dialog; gibt eine Funktion zum Schließen zurück
export function sheet(content, { onClose } = {}) {
  const back = h('div', { class: 'sheet-back' });
  const box = h('div', { class: 'sheet', role: 'dialog' }, content);
  back.append(box);
  const close = () => { back.classList.remove('show'); setTimeout(() => back.remove(), 200); onClose && onClose(); };
  back.addEventListener('click', e => { if (e.target === back) close(); });
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('show'));
  return close;
}

export function confirmDialog(text, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    let done = false;
    const close = sheet(h('div', {},
      h('p', { class: 'sheet-text' }, text),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn ghost grow', onclick: () => { done = true; close(); res(false); } }, 'Abbrechen'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'} grow`, onclick: () => { done = true; close(); res(true); } }, okLabel),
      )), { onClose: () => { if (!done) res(false); } });
  });
}

export function loadImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Bild konnte nicht geladen werden (Format? HEIC wird nicht unterstützt - bitte JPEG verwenden).')); };
    img.src = url;
  });
}

export const fmtDate = d => d ? new Date(d).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
export const fmtDateTime = d => d ? new Date(d).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';
export const pct = v => (v === null || v === undefined || isNaN(v)) ? '–' : `${Math.round(v * 100)} %`;
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// datetime-local <-> ISO
export function toLocalInput(d) {
  if (!d) return '';
  const x = new Date(d); const p = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
}
export function fromLocalInput(s) { return s ? new Date(s).toISOString() : null; }

// --- Kachel: Ausschnitt um einen Punkt ----------------------------------------
export function tileCanvas(img, cx, cy, sizePx, outCss = 96, ticks = true) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = c.height = Math.round(outCss * dpr);
  c.style.width = c.style.height = outCss + 'px';
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, cx - sizePx / 2, cy - sizePx / 2, sizePx, sizePx, 0, 0, c.width, c.height);
  if (ticks) {
    const W = c.width, m = W * 0.5, t = W * 0.1;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = Math.max(2, W / 60);
    ctx.beginPath();
    ctx.moveTo(m, 0); ctx.lineTo(m, t); ctx.moveTo(m, W); ctx.lineTo(m, W - t);
    ctx.moveTo(0, m); ctx.lineTo(t, m); ctx.moveTo(W, m); ctx.lineTo(W - t, m);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = Math.max(1, W / 120); ctx.stroke();
  }
  return c;
}

// --- Zoom-Ansicht mit Overlay (Pan, Pinch, Mausrad, Tippen) ------------------
export class ZoomView {
  constructor(container, { src, width, height, onTap, renderOverlay, onHandleDrag }) {
    this.c = container; this.W = width; this.H = height;
    this.onTap = onTap; this.renderOverlay = renderOverlay; this.onHandleDrag = onHandleDrag;
    container.classList.add('zoomview');
    this.layer = h('div', { class: 'zv-layer' });
    this.img = h('img', { src, draggable: 'false', style: { width: width + 'px', height: height + 'px' } });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', `-${width} -${height} ${3 * width} ${3 * height}`);
    this.svg.setAttribute('width', 3 * width); this.svg.setAttribute('height', 3 * height);
    Object.assign(this.svg.style, { position: 'absolute', left: -width + 'px', top: -height + 'px', overflow: 'visible' });
    this.layer.append(this.img, this.svg);
    container.append(this.layer);
    this.s = 1; this.tx = 0; this.ty = 0;
    this.ptrs = new Map(); this.drag = null;
    container.addEventListener('pointerdown', e => this.down(e));
    container.addEventListener('pointermove', e => this.move(e));
    container.addEventListener('pointerup', e => this.up(e));
    container.addEventListener('pointercancel', e => this.up(e, true));
    container.addEventListener('wheel', e => { e.preventDefault(); this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    this.ro = new ResizeObserver(() => { if (!this.fitted) this.fit(); });
    this.ro.observe(container);
    this.fit();
  }
  fit() {
    const r = this.c.getBoundingClientRect(); if (!r.width || !r.height) return;
    this.s = Math.min(r.width / this.W, r.height / this.H) * 0.96;
    this.tx = (r.width - this.W * this.s) / 2; this.ty = (r.height - this.H * this.s) / 2;
    this.minS = this.s * 0.8; this.fitted = true; this.apply();
  }
  apply() {
    this.layer.style.transform = `translate(${this.tx}px,${this.ty}px) scale(${this.s})`;
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = null; this.redraw(); });
  }
  redraw() { if (this.renderOverlay) { this.svg.innerHTML = ''; this.renderOverlay(this.svg, this.s); } }
  toImage(cx, cy) { const r = this.c.getBoundingClientRect(); return [(cx - r.left - this.tx) / this.s, (cy - r.top - this.ty) / this.s]; }
  zoomAt(cx, cy, f) {
    const r = this.c.getBoundingClientRect(); const ns = Math.max(this.minS, Math.min(this.s * f, 12));
    const px = cx - r.left, py = cy - r.top;
    this.tx = px - (px - this.tx) * ns / this.s; this.ty = py - (py - this.ty) * ns / this.s; this.s = ns; this.apply();
  }
  centerOn(x, y, s) {
    const r = this.c.getBoundingClientRect(); this.s = s; this.tx = r.width / 2 - x * s; this.ty = r.height / 2 - y * s; this.apply();
  }
  down(e) {
    this.c.setPointerCapture(e.pointerId);
    const handle = e.target.closest && e.target.closest('[data-handle]');
    if (handle && this.onHandleDrag) { this.drag = { id: handle.getAttribute('data-handle'), pid: e.pointerId }; return; }
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: Date.now() });
    if (this.ptrs.size === 2) this.pinch = null;
  }
  move(e) {
    if (this.drag && this.drag.pid === e.pointerId) { const [x, y] = this.toImage(e.clientX, e.clientY); this.onHandleDrag(this.drag.id, x, y); this.redraw(); return; }
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    if (this.ptrs.size === 1) { this.tx += e.clientX - p.x; this.ty += e.clientY - p.y; this.apply(); }
    else if (this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (this.pinch) { this.tx += mx - this.pinch.x; this.ty += my - this.pinch.y; }
      this.pinch = { x: mx, y: my };
      if (before > 0) this.zoomAt(mx, my, after / before);
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
  }
  up(e, cancel) {
    if (this.drag && this.drag.pid === e.pointerId) { this.drag = null; return; }
    const p = this.ptrs.get(e.pointerId); this.ptrs.delete(e.pointerId);
    if (this.ptrs.size < 2) this.pinch = null;
    if (!p || cancel) return;
    const moved = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
    if (moved < 8 && Date.now() - p.t0 < 500 && this.ptrs.size === 0 && this.onTap) {
      const [x, y] = this.toImage(e.clientX, e.clientY);
      this.onTap(x, y, e);
    }
  }
  destroy() { this.ro.disconnect(); }
}

export function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Markierungskreis mit dunklem Rand, damit er auf heller und dunkler Windel sichtbar ist
export function marker(svg, x, y, r, cls) {
  svg.append(svgEl('circle', { cx: x, cy: y, r, class: 'mk-halo' }));
  svg.append(svgEl('circle', { cx: x, cy: y, r, class: `mk ${cls}` }));
}

export async function makeThumb(img, maxSide = 480) {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
}

export function download(name, text, type = 'application/json') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
