// Prüfen eines Windelfotos: Kacheln bewerten, übersehene Milben nachtragen, abschließen
import { h, put, toast, sheet, confirmDialog, loadImage, tileCanvas, ZoomView, svgEl, marker, fmtDateTime } from './ui.js';
import { state, refreshModels, refreshMembers, latestModel, retrain, memberName, SPLIT_LABEL } from './core.js';
import { predict, CAUSES, MATCH_MM } from './model.js';
import { FEATURES } from './detect.js';

const PAGE = 20, TILE_MM = 5, CONTEXT_MM = 14, STOP_RUN = 40, LOCK_MIN = 30;

export async function reviewView(el, id) {
  let rec = await state.store.getImage(id);
  const me = state.store.session(), admin = me.role === 'admin';
  await Promise.all([refreshModels(), refreshMembers()]);

  let mode;
  if (rec.status === 'neu') mode = 'erst';
  else if (rec.status === 'geprueft') mode = rec.reviewed_by !== me.id || admin ? 'zweit' : 'warten';
  else mode = admin ? 'aendern' : 'ansicht';
  if (mode === 'ansicht') { location.hash = `#/bild/${id}`; return; }
  if (mode === 'warten') {
    put(el, h('a', { href: `#/bild/${id}`, class: 'back' }, '‹ Bild'),
      h('div', { class: 'card hint' }, h('h2', {}, 'Wartet auf Zweitprüfung'),
        h('p', {}, 'Du hast dieses Bild bereits geprüft. Bestätigen muss es eine andere Person aus dem Team.')));
    return;
  }

  const ann = rec.annotations || {};
  const lock = ann.lock;
  if (lock && lock.by !== me.id && Date.now() - new Date(lock.at) < LOCK_MIN * 60e3) {
    if (!await confirmDialog(`${lock.kuerzel || 'Jemand'} prüft dieses Bild gerade (zuletzt ${fmtDateTime(lock.at)}). Trotzdem weitermachen? Eure Änderungen könnten sich überschreiben.`, 'Trotzdem prüfen')) { location.hash = `#/bild/${id}`; return; }
  }

  put(el, h('div', { class: 'loading' }, 'Foto wird geladen …'));
  const blob = await state.store.getBlob(rec.file_path);
  const { img, url } = await loadImage(blob);
  el.innerHTML = '';

  const ppm = +rec.px_per_mm, sc = (rec.candidates && rec.candidates.scale) || 1, rMatch = MATCH_MM * ppm;
  const lm = latestModel();
  const dmaxIdx = FEATURES.indexOf('dmax');
  const cands = ((rec.candidates && rec.candidates.list) || []).map((c, i) => ({
    i, x: c.x / sc, y: c.y / sc,
    p: lm && lm.model.gen === rec.candidates.gen ? predict(lm.model, c.f) : c.f[dmaxIdx],
  }));

  // Arbeitskopie der Punkte
  let points = JSON.parse(JSON.stringify(ann.points || []));
  // Kacheln: bereits bewertete Punkte in ihrer Reihenfolge, danach ungeprüfte Kandidaten nach Modell-Wahrscheinlichkeit
  const reviewedCi = new Set(points.filter(p => p.ci !== undefined).map(p => p.ci));
  const tilePoints = points.filter(p => p.o === 'c' || p.o === 'v');
  const near = (arr, x, y) => arr.some(p => Math.hypot(p.x - x, p.y - y) <= rMatch);
  const rest = cands.filter(c => !reviewedCi.has(c.i) && !near(tilePoints.filter(p => p.o === 'v'), c.x, c.y)).sort((a, b) => b.p - a.p);
  const tiles = [
    ...tilePoints.map(p => ({ x: p.x, y: p.y, point: p })),
    ...rest.map(c => ({ x: c.x, y: c.y, cand: c, point: null })),
  ];
  // Wo weitermachen: erste Seite mit ungeprüften oder vormarkierten Kacheln
  let reviewed = Math.min(ann.reviewed || 0, tiles.length);
  const firstOpen = tiles.findIndex(t => !t.point || t.point.p);
  let page = Math.floor(Math.max(0, firstOpen === -1 ? reviewed : Math.min(firstOpen, reviewed)) / PAGE);
  let updatedAt = rec.updated_at;
  let zv = null;

  const title = mode === 'erst' ? 'Prüfen' : mode === 'zweit' ? 'Zweitprüfung' : 'Prüfung ändern';
  const head = h('div', { class: 'review-head' });
  const body = h('div');
  put(el, h('div', { class: 'row between' }, h('a', { href: `#/bild/${id}`, class: 'back' }, '‹ Bild'), h('span', { class: `chip ${rec.split}` }, SPLIT_LABEL[rec.split])), head, body);
  put(head, h('h1', {}, `${title}: ${rec.file_name || 'Windelfoto'}`),
    mode === 'zweit' ? h('p', { class: 'muted small' }, `Erstprüfung von ${memberName(rec.reviewed_by)}. Kontrolliere die Markierungen und ändere, was nicht stimmt.`) : null);

  const mites = () => points.filter(p => p.l === 'm').length;

  async function save(final = null) {
    const annotations = {
      points, reviewed, at: new Date().toISOString(), by: me.id,
      model_for_order: lm ? lm.id : null,
      lock: final ? null : { by: me.id, kuerzel: me.kuerzel, at: new Date().toISOString() },
      history: [...(ann.history || []), ...(final ? [{ by: me.id, at: new Date().toISOString(), action: final.action }] : [])],
    };
    const patch = { annotations, n_mites: mites() };
    if (final) Object.assign(patch, final.patch);
    rec = await state.store.updateImage(id, patch, updatedAt);
    updatedAt = rec.updated_at;
  }

  // --- Schritt 1: Kacheln --------------------------------------------------------
  function renderTiles() {
    body.innerHTML = '';
    if (zv) { zv.destroy(); zv = null; }
    const from = page * PAGE, to = Math.min(tiles.length, from + PAGE);
    // Lauf ohne Milbe am Ende der bisher bewerteten Kacheln
    let run = 0; for (let k = reviewed - 1; k >= 0; k--) { if (tiles[k].point && tiles[k].point.l === 'm') break; run++; }
    const grid = h('div', { class: 'tiles' });
    const sizeCss = Math.floor(Math.min(140, (Math.min(window.innerWidth, 720) - 40) / 4 - 8));
    for (let k = from; k < to; k++) put(grid, tileEl(tiles[k], k, sizeCss));
    put(body, 
      h('div', { class: 'stepbar' }, h('b', {}, '1 Kacheln'), h('span', {}, '2 Nachtragen'), h('span', {}, '3 Abschluss')),
      h('p', { class: 'small' }, `Kacheln ${tiles.length ? from + 1 : 0}–${to} von ${tiles.length} · bisher `, h('b', {}, `${mites()} Milben`)),
      h('p', { class: 'muted small' }, 'Tippe alle Kacheln an, in deren Mitte (zwischen den weißen Strichen) eine Varroamilbe liegt. Gestrichelt grün = Vorschlag aus den Schrauben-Fotos: stimmt er, nichts tun; sonst antippen. Lang drücken oder ⓘ: größerer Ausschnitt, „unsicher“ und Verwechsler angeben. Alles nicht Markierte gilt als „keine Milbe“.'),
      run >= STOP_RUN && to < tiles.length ? h('div', { class: 'card hint small' }, `Seit ${run} Kacheln keine Milbe mehr. Die restlichen Kandidaten sind laut Modell noch unwahrscheinlicher - du kannst zum Nachtragen weitergehen.`) : null,
      grid,
      h('div', { class: 'row gap wrap sticky-actions' },
        page > 0 ? h('button', { class: 'btn ghost', onclick: () => { page--; renderTiles(); } }, '‹ Zurück') : null,
        to < tiles.length ? h('button', { class: 'btn primary grow', onclick: () => pageDone(from, to, true) }, 'Seite fertig ›') : null,
        h('button', { class: `btn ${to >= tiles.length ? 'primary' : ''} grow`, onclick: () => pageDone(from, to, false) }, 'Weiter zum Nachtragen ›')),
    );
    window.scrollTo(0, 0);
  }

  function tileEl(t, k, sizeCss) {
    const cnv = tileCanvas(img, t.x, t.y, TILE_MM * ppm, sizeCss);
    const badge = h('span', { class: 'badge' });
    const info = h('button', { class: 'tinfo', title: 'Details' }, 'ⓘ');
    const box = h('div', { class: 'tile' }, cnv, badge, info);
    const paint = () => {
      const p = t.point; box.className = 'tile';
      badge.textContent = '';
      if (!p) return;
      if (p.l === 'm') { box.classList.add('m'); badge.textContent = p.p ? 'Schraube?' : '✓'; if (p.p) box.classList.add('pre'); }
      else if (p.l === 'u') { box.classList.add('u'); badge.textContent = '?'; }
      else if (p.l === 'k' && p.c) { box.classList.add('k'); badge.textContent = CAUSES[p.c] || p.c; }
      else if (p.l === 'k') box.classList.add('k0');
    };
    const setLabel = (l, c) => {
      if (!t.point) {
        t.point = { x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10, l, o: 'c', ci: t.cand.i };
        points.push(t.point);
      } else { t.point.l = l; delete t.point.p; }
      if (c) t.point.c = c; else delete t.point.c;
      paint();
    };
    let pressTimer = null, long = false;
    box.addEventListener('pointerdown', (e) => { if (e.target === info) return; long = false; pressTimer = setTimeout(() => { long = true; openDetail(); }, 450); });
    box.addEventListener('pointerup', () => clearTimeout(pressTimer));
    box.addEventListener('pointerleave', () => clearTimeout(pressTimer));
    box.addEventListener('contextmenu', e => e.preventDefault());
    box.addEventListener('click', (e) => {
      if (e.target === info || long) return;
      const cur = t.point ? t.point.l : null;
      setLabel(cur === 'm' ? 'k' : 'm');
    });
    info.onclick = (e) => { e.stopPropagation(); openDetail(); };
    function openDetail() {
      const big = tileCanvas(img, t.x, t.y, CONTEXT_MM * ppm, Math.min(320, window.innerWidth - 48), false);
      const ctx = big.getContext('2d'); const W = big.width;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, W / 150);
      ctx.beginPath(); ctx.arc(W / 2, W / 2, W * (1.4 / CONTEXT_MM), 0, Math.PI * 2); ctx.stroke();
      const close = sheet(h('div', { class: 'detail' },
        big,
        h('div', { class: 'row gap' },
          h('button', { class: 'btn ok grow', onclick: () => { setLabel('m'); close(); } }, 'Milbe'),
          h('button', { class: 'btn grow', onclick: () => { setLabel('k'); close(); } }, 'Keine Milbe'),
          h('button', { class: 'btn warn grow', onclick: () => { setLabel('u'); close(); } }, 'Unsicher')),
        h('p', { class: 'muted small' }, 'Optional, nur wenn du dir sicher bist - was ist es stattdessen?'),
        h('div', { class: 'row gap wrap' }, Object.entries(CAUSES).map(([k, v]) =>
          h('button', { class: `btn small ${t.point && t.point.c === k ? 'primary' : 'ghost'}`, onclick: () => { setLabel('k', k); close(); } }, v)))));
    }
    paint();
    return box;
  }

  async function pageDone(from, to, next) {
    for (let k = from; k < to; k++) {
      const t = tiles[k];
      if (!t.point) { t.point = { x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10, l: 'k', o: 'c', ci: t.cand.i }; points.push(t.point); }
      delete t.point.p;
    }
    reviewed = Math.max(reviewed, to);
    // Punkte in Kachel-Reihenfolge halten (für Fortsetzen und Zweitprüfung)
    const tileSet = new Set(tiles.map(t => t.point).filter(Boolean));
    points = [...tiles.map(t => t.point).filter(Boolean), ...points.filter(p => !tileSet.has(p))];
    try { await save(); } catch (e) { toast(e.message, 'error', 7000); return; }
    if (next) { page++; renderTiles(); } else renderAdd();
  }

  // --- Schritt 2: Nachtragen -----------------------------------------------------
  function renderAdd() {
    body.innerHTML = '';
    let showCands = false;
    const viewer = h('div', { class: 'viewer tall' });
    const counter = h('b', {}, '');
    const upd = () => { counter.textContent = `${mites()} Milben`; };
    const toggle = h('input', { type: 'checkbox' });
    toggle.onchange = () => { showCands = toggle.checked; zv.redraw(); };
    put(body, 
      h('div', { class: 'stepbar' }, h('span', {}, '1 Kacheln'), h('b', {}, '2 Nachtragen'), h('span', {}, '3 Abschluss')),
      h('p', { class: 'small' }, 'Suche die Windel in Streifen ab und tippe übersehene Milben an (blau). Grün = bereits als Milbe markiert, gelb = unsicher. Tippen auf eine Markierung ändert sie. Bisher: ', counter),
      h('label', { class: 'check small' }, toggle, ' ungeprüfte Kandidaten als graue Punkte zeigen'),
      viewer,
      h('div', { class: 'row gap wrap sticky-actions' },
        h('button', { class: 'btn ghost', onclick: () => { page = Math.max(0, Math.floor((reviewed - 1) / PAGE)); renderTiles(); } }, '‹ Kacheln'),
        h('button', { class: 'btn primary grow', onclick: async () => { try { await save(); renderFinish(); } catch (e) { toast(e.message, 'error', 7000); } } }, 'Weiter zum Abschluss ›')));
    upd();
    const r = 1.2 * ppm;
    zv = new ZoomView(viewer, {
      src: url, width: rec.width, height: rec.height,
      renderOverlay: (svg, s) => {
        if (rec.roi) svg.append(svgEl('polygon', { points: rec.roi.map(p => p.join(',')).join(' '), class: 'roi' }));
        if (showCands) {
          const done = new Set(points.filter(p => p.ci !== undefined).map(p => p.ci));
          for (const c of cands) if (!done.has(c.i)) svg.append(svgEl('circle', { cx: c.x, cy: c.y, r: Math.max(2, 3 / s), class: 'cand' }));
        }
        for (const p of points) {
          if (p.l === 'k') continue;
          marker(svg, p.x, p.y, Math.max(r, 9 / s), p.l === 'u' ? 'unsure' : p.o === 'n' ? 'added' : p.p ? 'pre' : 'mite');
        }
      },
      onTap: (x, y) => {
        if (x < 0 || y < 0 || x > rec.width || y > rec.height) return;
        const hit = points.filter(p => p.l !== 'k').map(p => [Math.hypot(p.x - x, p.y - y), p]).filter(([d]) => d <= 1.6 * ppm).sort((a, b) => a[0] - b[0])[0];
        if (hit) { editPoint(hit[1]); return; }
        // ungeprüften Kandidaten in der Nähe übernehmen (genauere Position und Merkmale)
        const done = new Set(points.filter(p => p.ci !== undefined).map(p => p.ci));
        const c = cands.filter(c => !done.has(c.i)).map(c => [Math.hypot(c.x - x, c.y - y), c]).filter(([d]) => d <= 0.8 * ppm).sort((a, b) => a[0] - b[0])[0];
        points.push(c ? { x: Math.round(c[1].x * 10) / 10, y: Math.round(c[1].y * 10) / 10, l: 'm', o: 'n', ci: c[1].i } : { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, l: 'm', o: 'n' });
        upd(); zv.redraw();
      },
    });
    function editPoint(p) {
      const big = tileCanvas(img, p.x, p.y, CONTEXT_MM * ppm, Math.min(320, window.innerWidth - 48));
      const close = sheet(h('div', { class: 'detail' }, big,
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn ok grow', onclick: () => { p.l = 'm'; delete p.c; close(); upd(); zv.redraw(); } }, 'Milbe'),
          h('button', { class: 'btn warn grow', onclick: () => { p.l = 'u'; close(); upd(); zv.redraw(); } }, 'Unsicher'),
          p.o === 'n'
            ? h('button', { class: 'btn danger grow', onclick: () => { points = points.filter(q => q !== p); tiles.forEach(t => { if (t.point === p) t.point = null; }); close(); upd(); zv.redraw(); } }, 'Entfernen')
            : h('button', { class: 'btn grow', onclick: () => { p.l = 'k'; close(); upd(); zv.redraw(); } }, 'Keine Milbe'))));
    }
  }

  // --- Schritt 3: Abschluss --------------------------------------------------------
  function renderFinish() {
    body.innerHTML = ''; if (zv) { zv.destroy(); zv = null; }
    const nM = mites(), nAdd = points.filter(p => p.l === 'm' && p.o === 'n').length, nU = points.filter(p => p.l === 'u').length;
    const pendingIdx = tiles.findIndex(t => t.point && t.point.p);
    const nPending = points.filter(p => p.p).length;
    const days = rec.inserted_at && rec.removed_at ? (new Date(rec.removed_at) - new Date(rec.inserted_at)) / 864e5 : null;
    let label, patch, action;
    if (mode === 'erst' && admin) { label = 'Abschließen und bestätigen'; patch = { status: 'bestaetigt', reviewed_by: me.id, confirmed_by: me.id }; action = 'geprüft+bestätigt'; }
    else if (mode === 'erst') { label = 'Prüfung abschließen'; patch = { status: 'geprueft', reviewed_by: me.id }; action = 'geprüft'; }
    else if (mode === 'zweit') { label = 'Bestätigen'; patch = { status: 'bestaetigt', confirmed_by: me.id }; action = 'bestätigt'; }
    else { label = 'Änderungen speichern'; patch = {}; action = 'geändert'; }
    const btn = h('button', { class: 'btn primary big' }, label);
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await save({ patch, action });
        toast(patch.status === 'bestaetigt' ? 'Bestätigt' : 'Gespeichert', 'ok');
        if (rec.status === 'bestaetigt' && rec.split === 'train') {
          toast('Modell wird neu berechnet …', 'info');
          setTimeout(async () => {
            try { const m = await retrain(); toast(`Neues Modell v${m.id} aus ${m.n_images} Bildern`, 'ok', 5000); }
            catch (e) { toast('Neuberechnung übersprungen: ' + e.message, 'warn', 6000); }
          }, 50);
        }
        const next = (await state.store.listImages()).find(i => i.id !== id && (i.status === 'neu' || (i.status === 'geprueft' && i.reviewed_by !== me.id)));
        body.innerHTML = '';
        put(body, h('div', { class: 'card ok' }, h('h2', {}, 'Fertig'),
          h('p', {}, `${nM} Milben gespeichert.`),
          h('div', { class: 'row gap wrap' },
            next ? h('a', { class: 'btn primary', href: `#/pruefen/${next.id}` }, 'Nächstes Bild') : null,
            h('a', { class: 'btn', href: '#/statistik' }, 'Statistik'),
            h('a', { class: 'btn ghost', href: '#/' }, 'Übersicht'))));
      } catch (e) { toast(e.message, 'error', 8000); btn.disabled = false; }
    };
    put(body, 
      h('div', { class: 'stepbar' }, h('span', {}, '1 Kacheln'), h('span', {}, '2 Nachtragen'), h('b', {}, '3 Abschluss')),
      h('div', { class: 'card' },
        h('div', { class: 'kpis' },
          h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, nM), h('div', { class: 'kpi-l' }, 'Milben')),
          h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, nAdd), h('div', { class: 'kpi-l' }, 'davon nachgetragen')),
          h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, nU), h('div', { class: 'kpi-l' }, 'unsicher'))),
        h('p', { class: 'small muted' }, `${reviewed} von ${tiles.length} Kandidaten als Kacheln geprüft.${days ? ` Natürlicher Milbenfall: ${(nM / days).toFixed(1)} Milben pro Tag.` : ''}`),
        mode === 'erst' && !admin ? h('p', { class: 'small' }, 'Danach bestätigt eine zweite Person die Markierungen. Erst dann zählt das Bild für Statistik und Training.') : null),
      nPending ? h('div', { class: 'card hint' },
        h('p', {}, `Noch ${nPending} Vorschläge aus den Schrauben-Fotos sind nicht angesehen. Sie zählen bisher als Milbe.`),
        h('button', { class: 'btn', onclick: () => { page = Math.floor(Math.max(0, pendingIdx) / PAGE); renderTiles(); } }, 'Vorschläge ansehen')) : null,
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn ghost', onclick: renderAdd }, '‹ Nachtragen'), btn));
  }

  if (reviewed > 0 && page * PAGE >= tiles.length) renderAdd(); else renderTiles();
  return () => { if (zv) zv.destroy(); URL.revokeObjectURL(url); };
}
