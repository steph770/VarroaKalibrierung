// Prüfen eines Windelfotos (ein „Run“):
// Die App hat beim Hochladen geschätzt. Beim Prüfen markiert man nur sichere Milben und sichere
// Nicht-Milben. Abgefragt werden alle Flecken über der Abfragegrenze (nach Konfidenz sortiert)
// plus eine Zufalls-Stichprobe darunter. Danach lernt das Modell neu.
import { h, put, toast, sheet, confirmDialog, loadImage, tileCanvas, ZoomView, svgEl, marker, fmtDateTime } from './ui.js';
import { state, refreshModels, refreshMembers, latestModel, modelAt, retrain } from './core.js';
import { predict, samplesForImage, countWithModel, CAUSES, MATCH_MM } from './model.js';
import { FEATURES, GEN_VERSION } from './detect.js';

const PAGE = 20, TILE_MM = 5, CONTEXT_MM = 14, AUDIT_N = 20, MAX_QUERY = 400, LOCK_MIN = 30;
const MIN_MITES_FOR_BAND = 30, BAND_RECALL = 0.95;

// Abfragegrenze: so tief, dass 95 % der bisher bestätigten Milben darüber lägen.
// Mit wenig Daten: alles abfragen (bis MAX_QUERY).
export async function queryBand(model) {
  if (!model) return { limit: 0, nMites: 0 };
  if (state.band && state.band.modelId === model.id) return state.band;
  const imgs = (await state.store.listImagesFull({ status: 'bestaetigt' })).filter(i => i.candidates && i.candidates.gen === GEN_VERSION);
  const ps = imgs.flatMap(samplesForImage).filter(s => s.y === 1).map(s => predict(model.model, s.f)).sort((a, b) => a - b);
  const limit = ps.length >= MIN_MITES_FOR_BAND ? ps[Math.floor(ps.length * (1 - BAND_RECALL))] : 0;
  state.band = { modelId: model.id, limit, nMites: ps.length };
  return state.band;
}

function seededShuffle(arr, seedStr) {
  let s = 0; for (const ch of seedStr) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export async function reviewView(el, id) {
  let rec = await state.store.getImage(id);
  const me = state.store.session(), admin = me.role === 'admin';
  await Promise.all([refreshModels(), refreshMembers()]);
  const done = rec.status === 'bestaetigt';
  if (done && !(admin || rec.reviewed_by === me.id)) { location.hash = `#/bild/${id}`; return; }

  const ann = rec.annotations || {};
  const lock = ann.lock;
  if (!done && lock && lock.by !== me.id && Date.now() - new Date(lock.at) < LOCK_MIN * 60e3) {
    if (!await confirmDialog(`${lock.kuerzel || 'Jemand'} prüft dieses Bild gerade (zuletzt ${fmtDateTime(lock.at)}). Trotzdem weitermachen?`, 'Trotzdem prüfen')) { location.hash = `#/bild/${id}`; return; }
  }

  put(el, h('div', { class: 'loading' }, 'Foto wird geladen …'));
  const blob = await state.store.getBlob(rec.file_path);
  const { img, url } = await loadImage(blob);
  el.innerHTML = '';

  const ppm = +rec.px_per_mm, sc = (rec.candidates && rec.candidates.scale) || 1, rMatch = MATCH_MM * ppm;
  const estModel = ann.est_model ? state.models.find(m => m.id === ann.est_model) || modelAt(rec.created_at) : modelAt(rec.created_at);
  const ranker = latestModel();
  const band = await queryBand(ranker);
  const dmaxIdx = FEATURES.indexOf('dmax');
  const gen = rec.candidates && rec.candidates.gen;
  const cands = ((rec.candidates && rec.candidates.list) || []).map((c, i) => ({
    i, x: c.x / sc, y: c.y / sc,
    p: ranker && ranker.model.gen === gen ? predict(ranker.model, c.f) : c.f[dmaxIdx],
  }));
  const estCount = estModel ? countWithModel(estModel.model, rec) : null;

  // Punkte: nur Urteile (m = sicher Milbe, k = sicher keine). p = Vorschlag noch nicht angesehen.
  let points = JSON.parse(JSON.stringify(ann.points || []));
  const legacySugg = points.filter(p => p.p && p.o === 'v').map(p => [p.x, p.y]);
  points = points.filter(p => !(p.l === 'u'));
  const near = (arr, x, y, r = rMatch) => arr.find(p => Math.hypot(p.x - x, p.y - y) <= r);

  // Kachel-Reihenfolge: gespeichert (Fortsetzen) oder neu aufbauen
  let order = ann.order;
  if (!order) {
    const sugg = ann.suggestions || legacySugg;
    for (const [x, y] of sugg) if (!near(points, x, y)) points.push({ x, y, l: 'm', o: 'v', p: 1 });
    const suggPts = points.filter(p => p.o === 'v');
    const free = cands.filter(c => !near(suggPts, c.x, c.y));
    const query = free.filter(c => c.p >= band.limit).sort((a, b) => b.p - a.p).slice(0, MAX_QUERY);
    const qset = new Set(query.map(c => c.i));
    const audit = seededShuffle(free.filter(c => !qset.has(c.i)), id).slice(0, AUDIT_N);
    order = [
      ...suggPts.map(p => ({ v: [p.x, p.y] })),
      ...query.map(c => ({ ci: c.i })),
      ...audit.map(c => ({ ci: c.i, a: 1 })),
    ];
  }
  const tiles = order.map(o => {
    if (o.v) { const p = near(points.filter(q => q.o === 'v'), o.v[0], o.v[1], 1) || null; return { x: o.v[0], y: o.v[1], sugg: true, point: p }; }
    const c = cands[o.ci]; if (!c) return null;
    return { x: c.x, y: c.y, cand: c, audit: !!o.a, point: points.find(p => p.ci === c.i && p.o === 'c') || null };
  }).filter(Boolean);
  let page = Math.max(0, Math.min(Math.floor((ann.page || 0)), Math.floor((tiles.length - 1) / PAGE)));
  let updatedAt = rec.updated_at;
  let complete = !!ann.complete;
  let zv = null;

  const head = h('div'), body = h('div');
  put(el, h('div', { class: 'row between' }, h('a', { href: `#/bild/${id}`, class: 'back' }, '‹ Bild'),
    estModel ? h('span', { class: 'chip' }, `Schätzung v${estModel.id}: ${estCount ?? '–'} Milben`) : null), head, body);
  put(head, h('h1', {}, `${done ? 'Prüfung ändern' : 'Prüfen'}: ${rec.file_name || 'Windelfoto'}`));

  const nM = () => points.filter(p => p.l === 'm' && !p.p).length;
  const nK = () => points.filter(p => p.l === 'k').length;

  async function save(final = null) {
    const annotations = {
      points, order, page, complete, suggestions: ann.suggestions || legacySugg,
      est_model: estModel ? estModel.id : null, est_count: estCount, band: band.limit, ranker: ranker ? ranker.id : null,
      at: new Date().toISOString(), by: me.id,
      lock: final ? null : { by: me.id, kuerzel: me.kuerzel, at: new Date().toISOString() },
      history: [...(ann.history || []), ...(final ? [{ by: me.id, at: new Date().toISOString(), action: final.action }] : [])],
    };
    const patch = { annotations, n_mites: nM() };
    if (final) Object.assign(patch, final.patch);
    rec = await state.store.updateImage(id, patch, updatedAt);
    updatedAt = rec.updated_at;
  }

  // --- Schritt 1: Kacheln ----------------------------------------------------------
  function renderTiles() {
    body.innerHTML = ''; if (zv) { zv.destroy(); zv = null; }
    const from = page * PAGE, to = Math.min(tiles.length, from + PAGE);
    const grid = h('div', { class: 'tiles' });
    const sizeCss = Math.floor(Math.min(140, (Math.min(window.innerWidth, 720) - 40) / 4 - 8));
    for (let k = from; k < to; k++) grid.append(tileEl(tiles[k], sizeCss));
    const nAudit = tiles.filter(t => t.audit).length;
    put(body,
      h('div', { class: 'stepbar' }, h('b', {}, '1 Kacheln'), h('span', {}, '2 Nachtragen'), h('span', {}, '3 Abschluss')),
      h('p', { class: 'small' }, `Kacheln ${tiles.length ? from + 1 : 0}–${to} von ${tiles.length} · `, h('b', {}, `${nM()} Milben`), ` · ${nK()} keine`),
      h('p', { class: 'muted small' }, 'Markiere nur, was du sicher erkennst: einmal tippen = Milbe (grün), zweimal = keine Milbe (grau), dreimal = wieder offen. Unsicheres einfach offen lassen. Lang drücken oder ⓘ: größerer Ausschnitt und Verwechsler angeben. Die Prozentzahl ist die Konfidenz des Modells.'),
      from === 0 ? h('p', { class: 'muted small' }, band.limit > 0
        ? `Abgefragt wird alles ab ${Math.round(band.limit * 100)} % Konfidenz (darüber lagen 95 % der ${band.nMites} bisher bestätigten Milben) und ${nAudit} zufällige Kacheln darunter als Stichprobe.`
        : `Das Modell kennt noch zu wenige bestätigte Milben (${band.nMites} von ${MIN_MITES_FOR_BAND}), deshalb fragt es noch alles ab, sortiert nach Konfidenz. Du musst nicht alle Kacheln ansehen.`) : null,
      grid,
      h('div', { class: 'row gap wrap sticky-actions' },
        page > 0 ? h('button', { class: 'btn ghost', onclick: () => { pageDone(from, to); page--; renderTiles(); } }, '‹') : null,
        to < tiles.length ? h('button', { class: 'btn primary grow', onclick: async () => { pageDone(from, to); page++; await trySave(); renderTiles(); } }, 'Nächste Seite ›') : null,
        h('button', { class: `btn ${to >= tiles.length ? 'primary' : ''} grow`, onclick: async () => { pageDone(from, to); if (await trySave()) renderAdd(); } }, 'Weiter ›')),
    );
    window.scrollTo(0, 0);
  }

  async function trySave() { try { await save(); return true; } catch (e) { toast(e.message, 'error', 7000); return false; } }

  function pageDone(from, to) { for (let k = from; k < to; k++) if (tiles[k].point) delete tiles[k].point.p; }

  function setLabel(t, l, c) {
    if (!l) {
      if (t.point) { points = points.filter(p => p !== t.point); t.point = null; }
      return;
    }
    if (!t.point) {
      t.point = { x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10, l, o: t.sugg ? 'v' : 'c' };
      if (t.cand) { t.point.ci = t.cand.i; if (t.audit) t.point.a = 1; }
      points.push(t.point);
    } else { t.point.l = l; delete t.point.p; }
    if (c) t.point.c = c; else delete t.point.c;
  }

  function tileEl(t, sizeCss) {
    const cnv = tileCanvas(img, t.x, t.y, TILE_MM * ppm, sizeCss);
    const badge = h('span', { class: 'badge' });
    const conf = h('span', { class: 'conf' }, t.sugg ? 'Schraube' : t.audit ? 'Stichprobe' : `${Math.round(t.cand.p * 100)} %`);
    const info = h('button', { class: 'tinfo', title: 'Details' }, 'ⓘ');
    const box = h('div', { class: 'tile' }, cnv, badge, conf, info);
    const paint = () => {
      const p = t.point; box.className = 'tile'; badge.textContent = '';
      if (!p) return;
      if (p.l === 'm') { box.classList.add('m'); if (p.p) box.classList.add('pre'); badge.textContent = '✓'; }
      else if (p.l === 'k') { box.classList.add(p.c ? 'k' : 'k0'); badge.textContent = p.c ? (CAUSES[p.c] || p.c) : '✗'; }
    };
    let timer = null, long = false;
    box.addEventListener('pointerdown', (e) => { if (e.target === info) return; long = false; timer = setTimeout(() => { long = true; openDetail(); }, 450); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => box.addEventListener(ev, () => clearTimeout(timer)));
    box.addEventListener('contextmenu', e => e.preventDefault());
    box.addEventListener('click', (e) => {
      if (e.target === info || long) return;
      const cur = t.point ? t.point.l : null;
      setLabel(t, cur === null ? 'm' : cur === 'm' ? 'k' : null); paint();
    });
    info.onclick = (e) => { e.stopPropagation(); openDetail(); };
    function openDetail() {
      const big = tileCanvas(img, t.x, t.y, CONTEXT_MM * ppm, Math.min(320, window.innerWidth - 48), false);
      const ctx = big.getContext('2d'); const W = big.width;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, W / 150);
      ctx.beginPath(); ctx.arc(W / 2, W / 2, W * (1.4 / CONTEXT_MM), 0, Math.PI * 2); ctx.stroke();
      const close = sheet(h('div', { class: 'detail' }, big,
        t.cand ? h('p', { class: 'muted small center' }, `Konfidenz des Modells: ${Math.round(t.cand.p * 100)} %`) : null,
        h('div', { class: 'row gap' },
          h('button', { class: 'btn ok grow', onclick: () => { setLabel(t, 'm'); paint(); close(); } }, 'Sicher Milbe'),
          h('button', { class: 'btn grow', onclick: () => { setLabel(t, 'k'); paint(); close(); } }, 'Sicher keine'),
          h('button', { class: 'btn ghost grow', onclick: () => { setLabel(t, null); paint(); close(); } }, 'Offen lassen')),
        h('p', { class: 'muted small' }, 'Optional, nur wenn eindeutig - was ist es stattdessen?'),
        h('div', { class: 'row gap wrap' }, Object.entries(CAUSES).map(([k, v]) =>
          h('button', { class: `btn small ${t.point && t.point.c === k ? 'primary' : 'ghost'}`, onclick: () => { setLabel(t, 'k', k); paint(); close(); } }, v)))));
    }
    paint();
    return box;
  }

  // --- Schritt 2: Nachtragen (optional) --------------------------------------------
  function renderAdd() {
    body.innerHTML = '';
    let showCands = false;
    const viewer = h('div', { class: 'viewer tall' });
    const counter = h('b', {});
    const upd = () => { counter.textContent = `${nM()} Milben`; };
    const toggle = h('input', { type: 'checkbox' });
    toggle.onchange = () => { showCands = toggle.checked; zv.redraw(); };
    put(body,
      h('div', { class: 'stepbar' }, h('span', {}, '1 Kacheln'), h('b', {}, '2 Nachtragen'), h('span', {}, '3 Abschluss')),
      h('p', { class: 'small' }, 'Optional: Milben, die nicht abgefragt wurden, antippen (blau). Grün = als Milbe markiert. Tippen auf eine Markierung ändert sie. Bisher: ', counter),
      h('label', { class: 'check small' }, toggle, ' verdächtige Flecken als graue Punkte zeigen'),
      viewer,
      h('div', { class: 'row gap wrap sticky-actions' },
        h('button', { class: 'btn ghost', onclick: () => renderTiles() }, '‹ Kacheln'),
        h('button', { class: 'btn primary grow', onclick: async () => { if (await trySave()) renderFinish(); } }, 'Weiter zum Abschluss ›')));
    upd();
    const r = 1.2 * ppm;
    zv = new ZoomView(viewer, {
      src: url, width: rec.width, height: rec.height,
      renderOverlay: (svg, s) => {
        if (rec.roi) svg.append(svgEl('polygon', { points: rec.roi.map(p => p.join(',')).join(' '), class: 'roi' }));
        if (showCands) for (const c of cands) svg.append(svgEl('circle', { cx: c.x, cy: c.y, r: Math.max(2, 3 / s), class: 'cand' }));
        for (const p of points) if (p.l === 'm') marker(svg, p.x, p.y, Math.max(r, 9 / s), p.o === 'n' ? 'added' : p.p ? 'pre' : 'mite');
      },
      onTap: (x, y) => {
        if (x < 0 || y < 0 || x > rec.width || y > rec.height) return;
        const hit = points.filter(p => p.l === 'm').map(p => [Math.hypot(p.x - x, p.y - y), p]).filter(([d]) => d <= 1.6 * ppm).sort((a, b) => a[0] - b[0])[0];
        if (hit) { editPoint(hit[1]); return; }
        const c = cands.map(c => [Math.hypot(c.x - x, c.y - y), c]).filter(([d]) => d <= 0.8 * ppm).sort((a, b) => a[0] - b[0])[0];
        const ex = c ? points.find(p => p.ci === c[1].i) : null;
        if (ex) { ex.l = 'm'; delete ex.c; delete ex.p; }
        else points.push(c ? { x: Math.round(c[1].x * 10) / 10, y: Math.round(c[1].y * 10) / 10, l: 'm', o: 'n', ci: c[1].i } : { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, l: 'm', o: 'n' });
        upd(); zv.redraw();
      },
    });
    function editPoint(p) {
      const big = tileCanvas(img, p.x, p.y, CONTEXT_MM * ppm, Math.min(320, window.innerWidth - 48));
      const close = sheet(h('div', { class: 'detail' }, big,
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn ok grow', onclick: () => { p.l = 'm'; delete p.c; delete p.p; close(); upd(); zv.redraw(); } }, 'Sicher Milbe'),
          h('button', { class: 'btn grow', onclick: () => { p.l = 'k'; delete p.p; close(); upd(); zv.redraw(); } }, 'Sicher keine'),
          h('button', { class: 'btn ghost grow', onclick: () => { points = points.filter(q => q !== p); tiles.forEach(t => { if (t.point === p) t.point = null; }); close(); upd(); zv.redraw(); } }, 'Entfernen'))));
    }
  }

  // --- Schritt 3: Abschluss -----------------------------------------------------------
  function renderFinish() {
    body.innerHTML = ''; if (zv) { zv.destroy(); zv = null; }
    const pending = points.filter(p => p.p).length;
    const firstPending = tiles.findIndex(t => t.point && t.point.p);
    const cb = h('input', { type: 'checkbox', checked: complete });
    cb.onchange = () => { complete = cb.checked; };
    const btn = h('button', { class: 'btn primary big' }, done ? 'Änderungen speichern' : 'Prüfung abschließen');
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await save({ patch: done ? {} : { status: 'bestaetigt', reviewed_by: me.id, confirmed_by: me.id }, action: done ? 'geändert' : 'geprüft' });
        toast('Gespeichert', 'ok');
        state.band = null;
        setTimeout(async () => {
          try { const m = await retrain(); toast(`Neues Modell v${m.id}, gelernt aus ${m.n_images} ${m.n_images === 1 ? 'Bild' : 'Bildern'}`, 'ok', 5000); }
          catch (e) { toast('Noch kein neues Modell: ' + e.message, 'warn', 6000); }
        }, 50);
        const next = (await state.store.listImages()).filter(i => i.id !== id && i.status !== 'bestaetigt').sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
        body.innerHTML = '';
        put(body, h('div', { class: 'card ok' }, h('h2', {}, 'Fertig'),
          h('p', {}, `${nM()} sichere Milben und ${nK()} sichere Ausschlüsse gespeichert. Das Modell lernt jetzt daraus.`),
          h('div', { class: 'row gap wrap' },
            next ? h('a', { class: 'btn primary', href: `#/pruefen/${next.id}` }, 'Nächstes Bild') : null,
            h('a', { class: 'btn', href: '#/statistik' }, 'Statistik'),
            h('a', { class: 'btn ghost', href: '#/' }, 'Übersicht'))));
      } catch (e) { toast(e.message, 'error', 8000); btn.disabled = false; }
    };
    const days = rec.inserted_at && rec.removed_at ? (new Date(rec.removed_at) - new Date(rec.inserted_at)) / 864e5 : null;
    put(body,
      h('div', { class: 'stepbar' }, h('span', {}, '1 Kacheln'), h('span', {}, '2 Nachtragen'), h('b', {}, '3 Abschluss')),
      h('div', { class: 'card' },
        h('div', { class: 'kpis' },
          h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, nM()), h('div', { class: 'kpi-l' }, 'sichere Milben')),
          h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, nK()), h('div', { class: 'kpi-l' }, 'sichere Ausschlüsse')),
          h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, estCount ?? '–'), h('div', { class: 'kpi-l' }, `Schätzung${estModel ? ` v${estModel.id}` : ''}`))),
        h('label', { class: 'check' }, cb, ' Ich habe alle Milben auf der Windel markiert (vollständige Zählung)'),
        h('p', { class: 'muted small' }, `Nur vollständig gezählte Windeln fließen in den Zählfehler der Statistik ein.${complete && days ? ` Natürlicher Milbenfall: ${(nM() / days).toFixed(1)} pro Tag.` : ''}`)),
      pending ? h('div', { class: 'card hint' },
        h('p', {}, `${pending} Vorschläge aus dem Schrauben-Foto hast du noch nicht angesehen. Sie zählen bis dahin nicht.`),
        h('button', { class: 'btn', onclick: () => { page = Math.floor(Math.max(0, firstPending) / PAGE); renderTiles(); } }, 'Vorschläge ansehen')) : null,
      h('div', { class: 'row gap wrap' }, h('button', { class: 'btn ghost', onclick: renderAdd }, '‹ Nachtragen'), btn));
  }

  renderTiles();
  return () => { if (zv) zv.destroy(); URL.revokeObjectURL(url); };
}
