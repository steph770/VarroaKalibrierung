// Hochladen eines Windelfotos und Bearbeiten von Ecken, Maßstab und Angaben
import { h, put, toast, loadImage, ZoomView, svgEl, makeThumb, toLocalInput, fromLocalInput, fmtDateTime } from './ui.js';
import { state, refreshModels, latestModel, seedFor } from './core.js';
import { readExif } from './exif.js';
import { autoRoi, pxPerMmFromRoi } from './detect.js';
import { countWithModel } from './model.js';

const MAX_PPM = 9; // schärfer muss die Kandidatensuche nicht rechnen (spart Zeit auf dem Handy)

function remembered() {
  try { return JSON.parse(localStorage.getItem('vk-last') || '{}'); } catch { return {}; }
}
function remember(v) { try { localStorage.setItem('vk-last', JSON.stringify({ ...remembered(), ...v })); } catch { /* egal */ } }

// --- Neues Foto ----------------------------------------------------------------
export async function uploadView(el) {
  const cam = h('input', { type: 'file', accept: 'image/jpeg,image/*', capture: 'environment', style: { display: 'none' } });
  const pick = h('input', { type: 'file', accept: 'image/jpeg,image/*', style: { display: 'none' } });
  // ohne accept-Filter öffnet Android den normalen Dateimanager mit Ordnern statt der Fotoauswahl
  const files = h('input', { type: 'file', style: { display: 'none' } });
  const body = h('div');
  put(el, h('h1', {}, 'Windelfoto hochladen'), cam, pick, files,
    h('div', { class: 'card' },
      h('p', {}, 'So wird das Foto gut: ganze Windel im Bild, senkrecht von oben, gleichmäßiges Licht ohne harte Schatten, höchste Auflösung der Kamera, JPEG-Format.'),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn primary', onclick: () => cam.click() }, '📷 Foto aufnehmen'),
        h('button', { class: 'btn', onclick: () => pick.click() }, '🖼 Aus Galerie'),
        h('button', { class: 'btn', onclick: () => files.click() }, '📁 Aus Ordner'))),
    body);
  let cleanupFn = null;
  const onFile = async (file) => {
    if (!file) return;
    body.innerHTML = ''; if (cleanupFn) cleanupFn();
    try {
      const buf = await file.arrayBuffer();
      const exif = readExif(buf);
      const { img, url } = await loadImage(file);
      const W = img.naturalWidth, H = img.naturalHeight;
      const seed = seedFor(file.name, exif, W, H);
      const last = remembered();
      const init = {
        file_name: file.name, colony: '', site: last.site || '',
        inserted_at: null, removed_at: exif.taken ? exif.taken.toISOString() : null,
        windel_w_mm: seed ? seed.windel_w_mm : (last.windel_w_mm || ''), windel_l_mm: seed ? (seed.windel_l_mm || '') : (last.windel_l_mm || ''),
        width_dir: seed ? seed.width_dir : (last.width_dir || 'senkrecht'),
        roi: seed ? seed.roi : roiFromImage(img),
        taken_at: exif.taken ? exif.taken.toISOString() : null, device: exif.device || null,
      };
      cleanupFn = imageForm(body, {
        img, url, W, H, init, seed, isNew: true, submitLabel: 'Kandidaten suchen und speichern',
        onSubmit: async (vals, progress) => {
          const cands = await runDetection(img, vals.roi, vals.px_per_mm, progress);
          progress('Speichere Foto …');
          const thumb = await makeThumb(img);
          const premarks = seed && seed.premarks ? seed.premarks : [];
          const rec = await state.store.createImage({
            ...vals, width: W, height: H,
            candidates: cands, n_candidates: cands.list.length,
            annotations: premarks.length ? { points: [], suggestions: premarks } : null,
          }, file, thumb);
          remember({ site: vals.site, windel_w_mm: vals.windel_w_mm, windel_l_mm: vals.windel_l_mm, width_dir: vals.width_dir });
          await refreshModels();
          const lm = latestModel();
          const cnt = lm ? countWithModel(lm.model, { candidates: cands }) : null;
          body.innerHTML = '';
          put(body, h('div', { class: 'card ok' },
            h('h2', {}, 'Gespeichert'),
            h('p', {}, `Schätzung der App${lm ? ` (Modell v${lm.id})` : ''}: `, h('b', {}, cnt ?? '–'), ' Milben.'),
            h('p', { class: 'muted' }, `${cands.list.length} verdächtige Flecken gefunden${premarks.length ? ` · ${premarks.length} Vorschläge aus dem Schrauben-Foto übernommen` : ''}. Beim Prüfen siehst du, wo die App richtig lag.`),
            h('div', { class: 'row gap wrap' },
              h('a', { class: 'btn primary', href: `#/pruefen/${rec.id}` }, 'Jetzt prüfen'),
              h('button', { class: 'btn', onclick: () => { body.innerHTML = ''; pick.click(); } }, 'Weiteres Foto'))));
        },
      });
    } catch (e) { console.error(e); put(body, h('div', { class: 'card error' }, e.message)); }
  };
  cam.onchange = () => onFile(cam.files[0]);
  pick.onchange = () => onFile(pick.files[0]);
  files.onchange = () => {
    const f = files.files[0];
    if (f && !/\.(jpe?g)$/i.test(f.name) && !/jpeg/.test(f.type)) { toast('Bitte ein JPEG-Foto wählen (.jpg).', 'warn', 5000); return; }
    onFile(f);
  };
  return () => { if (cleanupFn) cleanupFn(); };
}

// --- Bestehendes Foto bearbeiten ------------------------------------------------------
export async function editView(el, id) {
  const rec = await state.store.getImage(id);
  const blob = await state.store.getBlob(rec.file_path);
  const { img, url } = await loadImage(blob);
  put(el, h('a', { href: `#/bild/${id}`, class: 'back' }, '‹ zurück'), h('h1', {}, 'Angaben ändern'));
  const body = h('div'); put(el, body);
  return imageForm(body, {
    img, url, W: rec.width, H: rec.height, init: rec, isNew: false, submitLabel: 'Speichern',
    onSubmit: async (vals, progress) => {
      const patch = { ...vals };
      const geomChanged = JSON.stringify(vals.roi) !== JSON.stringify(rec.roi) || Math.abs(vals.px_per_mm - rec.px_per_mm) > 1e-6;
      if (geomChanged) {
        const cands = await runDetection(img, vals.roi, vals.px_per_mm, progress);
        patch.candidates = cands; patch.n_candidates = cands.list.length;
      }
      progress('Speichere …');
      await state.store.updateImage(id, patch, rec.updated_at);
      toast(geomChanged ? 'Gespeichert und Kandidaten neu berechnet' : 'Gespeichert', 'ok');
      location.hash = `#/bild/${id}`;
    },
  });
}

function roiFromImage(img) {
  const s = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return autoRoi(d).map(([x, y]) => [Math.round(x / s), Math.round(y / s)]);
}

// Kandidatensuche im Web Worker
export async function runDetection(img, roi, ppm, progress) {
  const scale = Math.min(1, MAX_PPM / ppm);
  const w = Math.round(img.naturalWidth * scale), hh = Math.round(img.naturalHeight * scale);
  progress('Bild wird vorbereitet …');
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, hh);
  const data = ctx.getImageData(0, 0, w, hh);
  c.width = c.height = 1; // Speicher freigeben
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  try {
    const res = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.progress !== undefined) progress(`Suche Milben-Kandidaten … ${Math.round(e.data.progress * 100)} %`);
        else if (e.data.error) reject(new Error(e.data.error));
        else resolve(e.data.result);
      };
      worker.onerror = (e) => reject(new Error(e.message || 'Fehler in der Kandidatensuche'));
      worker.postMessage({ width: w, height: hh, buffer: data.data.buffer, ppm: ppm * scale, roi: roi.map(([x, y]) => [x * scale, y * scale]) }, [data.data.buffer]);
    });
    return { gen: res.gen, scale, list: res.candidates };
  } finally { worker.terminate(); }
}

// --- Formular mit Ecken-Editor ---------------------------------------------------------
function imageForm(el, { img, url, W, H, init, seed, isNew, submitLabel, onSubmit }) {
  let roi = (init.roi || [[0, 0], [W, 0], [W, H], [0, H]]).map(p => [...p]);
  const inp = (attrs) => h('input', attrs);
  const f = {
    colony: inp({ type: 'text', value: init.colony || '', placeholder: 'z. B. 7' }),
    site: inp({ type: 'text', value: init.site || '', placeholder: 'z. B. Garten' }),
    ins: inp({ type: 'datetime-local', value: toLocalInput(init.inserted_at) }),
    rem: inp({ type: 'datetime-local', value: toLocalInput(init.removed_at) }),
    ww: inp({ type: 'number', step: '1', min: '50', value: init.windel_w_mm || '', placeholder: 'z. B. 445' }),
    wl: inp({ type: 'number', step: '1', min: '50', value: init.windel_l_mm || '', placeholder: 'optional' }),
    note: inp({ type: 'text', value: init.note || '', placeholder: 'optional' }),
  };
  const dir = h('select', {}, h('option', { value: 'senkrecht' }, 'von oben nach unten'), h('option', { value: 'waagrecht' }, 'von links nach rechts'));
  dir.value = init.width_dir || 'senkrecht';
  const scaleInfo = h('div', { class: 'scaleinfo' });
  const days = h('span', { class: 'muted' });
  const ppmNow = () => pxPerMmFromRoi(roi, +f.ww.value, +f.wl.value, dir.value);
  const updateInfo = () => {
    const p = ppmNow();
    scaleInfo.textContent = p ? `Maßstab: ${p.toFixed(2)} Pixel pro mm (eine Milbe ≈ ${(1.6 * p).toFixed(0)} Pixel breit)` : 'Maßstab: bitte die Windelbreite eintragen';
    scaleInfo.className = 'scaleinfo ' + (p && p >= 3 ? 'ok' : 'warn');
    const d = f.ins.value && f.rem.value ? (new Date(f.rem.value) - new Date(f.ins.value)) / 864e5 : null;
    days.textContent = d ? `= ${d.toFixed(1)} Tage eingelegt` : '';
  };
  Object.values(f).forEach(x => x.addEventListener('input', updateInfo)); dir.onchange = () => { updateInfo(); zv.redraw(); };

  const viewer = h('div', { class: 'viewer roi-editor' });
  const status = h('div', { class: 'progress muted' });
  const btn = h('button', { class: 'btn primary big' }, submitLabel);
  put(el, 
    h('div', { class: 'card' },
      h('p', { class: 'muted small' }, `Aufnahme: ${fmtDateTime(init.taken_at)}${init.device ? ` · ${init.device}` : ''}`),
      seed ? h('p', { class: 'hint small' }, `Startdaten für dieses Foto gefunden: Ecken und Maßstab${seed.premarks && seed.premarks.length ? ` sowie ${seed.premarks.length} Vormarkierungen aus dem Schrauben-Foto` : ''} werden übernommen.`) : null,
      h('div', { class: 'grid2' }, h('label', {}, 'Volk', f.colony), h('label', {}, 'Standort', f.site)),
      h('div', { class: 'grid2' }, h('label', {}, 'Windel eingelegt', f.ins), h('label', {}, 'Windel entnommen', f.rem)),
      days),
    h('div', { class: 'card' },
      h('h2', {}, 'Windel-Ecken und Maßstab'),
      h('p', { class: 'muted small' }, 'Ziehe die vier Punkte auf die Ecken der Windel (zoomen mit zwei Fingern). Gezählt wird nur innerhalb der Fläche. Ist die Windel seitlich abgeschnitten, setz die Punkte dort an den Bildrand. Die Kanten in Breitenrichtung (gestrichelt) müssen ganz im Bild sein.'),
      viewer,
      h('div', { class: 'grid2' }, h('label', {}, 'Windelbreite in Rähmchenrichtung (mm)', f.ww), h('label', {}, 'Windellänge (mm, falls ganz im Bild)', f.wl)),
      h('label', {}, 'Die Breite (Rähmchenrichtung) verläuft im Foto', dir),
      scaleInfo,
      h('label', {}, 'Notiz', f.note)),
    btn, status);
  updateInfo();

  const zv = new ZoomView(viewer, {
    src: url, width: W, height: H,
    renderOverlay: (svg, s) => {
      svg.append(svgEl('polygon', { points: roi.map(p => p.join(',')).join(' '), class: 'roi edit' }));
      const pairs = dir.value === 'waagrecht' ? [[0, 1], [3, 2]] : [[0, 3], [1, 2]];
      for (const [a, b] of pairs) svg.append(svgEl('line', { x1: roi[a][0], y1: roi[a][1], x2: roi[b][0], y2: roi[b][1], class: 'roi-width' }));
      roi.forEach((p, i) => svg.append(svgEl('circle', { cx: p[0], cy: p[1], r: 16 / s, class: 'handle', 'data-handle': i })));
    },
    onHandleDrag: (id, x, y) => { roi[+id] = [Math.round(x), Math.round(y)]; updateInfo(); },
  });

  btn.onclick = async () => {
    const ppm = ppmNow();
    if (!ppm || ppm < 2 || ppm > 60) { toast('Der Maßstab fehlt oder ist unplausibel. Bitte Windelmaß und Ecken prüfen.', 'warn', 5000); return; }
    btn.disabled = true;
    const progress = (t) => { status.textContent = t; };
    try {
      await onSubmit({
        file_name: init.file_name, taken_at: init.taken_at, device: init.device,
        colony: f.colony.value.trim() || null, site: f.site.value.trim() || null,
        inserted_at: fromLocalInput(f.ins.value), removed_at: fromLocalInput(f.rem.value),
        windel_w_mm: f.ww.value ? +f.ww.value : null, windel_l_mm: f.wl.value ? +f.wl.value : null, width_dir: dir.value,
        roi, px_per_mm: Math.round(ppm * 1e4) / 1e4,
        scale_source: f.wl.value ? 'Windelbreite und -länge' : 'Windelbreite',
        note: f.note.value.trim() || null,
      }, progress);
    } catch (e) { console.error(e); toast(e.message, 'error', 7000); status.textContent = ''; btn.disabled = false; }
  };
  return () => { zv.destroy(); URL.revokeObjectURL(url); };
}
