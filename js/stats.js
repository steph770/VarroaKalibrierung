// Statistik: Wie gut lag die Schätzung bei jedem Run?
// Jeder Run wird mit dem Modell ausgewertet, das beim Hochladen aktuell war (erst testen, dann lernen).
import { h, put, pct, fmtDate } from './ui.js';
import { state, refreshModels, refreshMembers, memberName, modelAt } from './core.js';
import { evaluateImage, summarize, CAUSES } from './model.js';
import { GEN_VERSION } from './detect.js';

const WINDOW = 5;
const SERIES = [
  { key: 'recall', label: 'Trefferquote', css: 'var(--series-1)', better: 'höher ist besser' },
  { key: 'falseRate', label: 'Fehlalarmquote', css: 'var(--series-2)', better: 'niedriger ist besser' },
  { key: 'countErrPct', label: 'Zählfehler Ø', css: 'var(--series-3)', better: 'niedriger ist besser', isPct: true },
];
const fmt = (sr, v) => v === null || v === undefined ? '–' : sr.isPct ? `${Math.round(v)} %` : pct(v);

export async function statsView(el) {
  put(el, h('h1', {}, 'Statistik'), h('div', { class: 'loading' }, 'Rechne …'));
  const [models, images] = await Promise.all([refreshModels(), state.store.listImagesFull({ status: 'bestaetigt' }), refreshMembers()]);
  const allImgs = await state.store.listImages();
  el.lastChild.remove();
  const runs = images
    .filter(i => i.candidates && i.candidates.gen === GEN_VERSION && i.annotations)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map((img, k) => {
      const m = (img.annotations.est_model && models.find(x => x.id === img.annotations.est_model)) || modelAt(img.created_at);
      return { n: k + 1, img, m, r: m ? evaluateImage(m.model, img) : null };
    }).filter(x => x.r);

  if (!runs.length) {
    put(el, h('div', { class: 'card' }, h('p', {}, 'Noch keine geprüften Runs. Lade ein Foto hoch, prüfe es, und hier erscheint, wie gut die Schätzung war.')), dataBase(allImgs, images, models));
    return;
  }
  const last = runs.slice(-10), sLast = summarize(last.map(x => x.r)), sAll = summarize(runs.map(x => x.r));
  const audit = auditStats(images);

  put(el,
    h('p', { class: 'muted small' }, 'Jeder Run wird mit dem Modell bewertet, das beim Hochladen aktuell war. Das Modell kannte das Bild also noch nicht. Verglichen wird nur mit dem, was beim Prüfen als sicher markiert wurde.'),
    h('h2', {}, last.length < runs.length ? `Letzte ${last.length} Runs` : `Alle ${runs.length} Runs`),
    h('div', { class: 'kpis four' },
      kpi(pct(sLast.recall), 'Trefferquote', `${sLast.tp} von ${sLast.sureMites} sicheren Milben gefunden`),
      kpi(pct(sLast.falseRate), 'Fehlalarmquote', `${sLast.fp} von ${sLast.tp + sLast.fp} beurteilten Treffern falsch`),
      kpi(sLast.countErrPct === null ? '–' : `${Math.round(sLast.countErrPct)} %`, 'Zählfehler Ø', sLast.complete ? `${sLast.complete} vollständig gezählte Windeln` : 'erst mit vollständig gezählten Windeln'),
      kpi(sLast.unjudged, 'Treffer ohne Urteil', 'vom Modell gemeldet, beim Prüfen offen gelassen')),
    last.length < runs.length ? h('p', { class: 'muted small' }, `Zum Vergleich alle ${runs.length} Runs: Trefferquote ${pct(sAll.recall)}, Fehlalarmquote ${pct(sAll.falseRate)}, Zählfehler ${sAll.countErrPct === null ? '–' : Math.round(sAll.countErrPct) + ' %'}.`) : null,
    trendCard(runs),
    causesCard(sAll),
    h('div', { class: 'card' },
      h('h3', {}, 'Was die Abfrage nicht zeigt'),
      audit.judged
        ? h('p', {}, `In den Zufalls-Stichproben unterhalb der Abfragegrenze waren ${audit.mites} von ${audit.judged} beurteilten Kacheln Milben (${pct(audit.mites / audit.judged)}). Je näher an 0, desto weniger Milben entgehen der Abfrage.`)
        : h('p', { class: 'muted' }, 'Noch keine beurteilten Stichproben-Kacheln. Sie erscheinen am Ende jeder Kachel-Abfrage mit dem Etikett „Stichprobe“.')),
    perRunCard(runs),
    dataBase(allImgs, images, models),
    glossary(),
  );
}

const kpi = (v, l, sub) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, v), h('div', { class: 'kpi-l' }, l), sub ? h('div', { class: 'kpi-s' }, sub) : null);

function auditStats(images) {
  let judged = 0, mites = 0;
  for (const i of images) for (const p of (i.annotations && i.annotations.points) || []) {
    if (!p.a || p.p) continue;
    if (p.l === 'm') { judged++; mites++; } else if (p.l === 'k') judged++;
  }
  return { judged, mites };
}

function causesCard(s) {
  const entries = Object.entries(s.fpCauses).sort((a, b) => b[1] - a[1]);
  const box = h('div', { class: 'card' }, h('h3', {}, 'Fehlalarme nach Ursache (alle Runs)'));
  if (!entries.length) { put(box, h('p', { class: 'muted' }, 'Keine Fehlalarme.')); return box; }
  const max = Math.max(...entries.map(e => e[1]));
  const list = h('div', { class: 'bars' });
  for (const [k, n] of entries) {
    const label = k === 'ohne' ? 'ohne Angabe' : (CAUSES[k] || k);
    put(list, h('div', { class: 'bar-row', title: `${label}: ${n} Fehlalarme (${pct(n / s.fp)})` },
      h('span', { class: 'bar-label' }, label),
      h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: { width: `${(n / max) * 100}%` } })),
      h('span', { class: 'bar-val' }, `${n} · ${pct(n / s.fp)}`)));
  }
  put(box, list, h('p', { class: 'muted small' }, 'Ursachen erscheinen nur, wenn beim Prüfen ein Verwechsler angegeben wurde.'));
  return box;
}

// Verlauf: gleitender Durchschnitt über die letzten 5 Runs
function trendCard(runs) {
  const box = h('div', { class: 'card viz-root' }, h('h3', {}, 'Wird die Schätzung besser?'));
  if (runs.length < 2) { put(box, h('p', { class: 'muted' }, 'Der Verlauf erscheint ab zwei Runs.')); return box; }
  const rows = runs.map((x, i) => ({ x, s: summarize(runs.slice(Math.max(0, i - WINDOW + 1), i + 1).map(y => y.r)) }));
  const W = Math.round(Math.min(640, Math.max(300, window.innerWidth - 62))), H = 240, L = 40, R = 108, T = 14, B = 30;
  const val = (r, sr) => { const v = r.s[sr.key]; return v === null || v === undefined ? null : Math.min(200, v * (sr.isPct ? 1 : 100)); };
  const vals = rows.flatMap(r => SERIES.map(sr => val(r, sr))).filter(v => v !== null);
  const CAP = 200; // Ausreißer (z. B. 1000 % Zählfehler) oben abschneiden, sonst ist der Rest nicht lesbar
  const yMax = Math.max(...vals, 0) > 100 ? CAP : 100;
  const x = i => L + i * (W - L - R) / Math.max(1, rows.length - 1);
  const y = v => T + (H - T - B) * (1 - v / yMax);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Gleitender Durchschnitt von Trefferquote, Fehlalarmquote und Zählfehler über die Runs');
  const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; svg.append(e); return e; };
  for (let g = 0; g <= yMax; g += yMax / 4) {
    add('line', { x1: L, x2: W - R, y1: y(g), y2: y(g), class: 'grid' });
    add('text', { x: L - 6, y: y(g) + 4, class: 'axis', 'text-anchor': 'end' }, `${g} %`);
  }
  const step = Math.max(1, Math.ceil(rows.length / 8));
  rows.forEach((r, i) => { if (i % step === 0 || i === rows.length - 1) add('text', { x: x(i), y: H - 10, class: 'axis', 'text-anchor': 'middle' }, `Run ${r.x.n}`); });
  const labels = [];
  for (const sr of SERIES) {
    const pts = rows.map((r, i) => { const v = val(r, sr); return v === null ? null : [x(i), y(v)]; });
    let seg = [];
    const flush = () => { if (seg.length > 1) add('polyline', { points: seg.map(p => p.join(',')).join(' '), fill: 'none', stroke: sr.css, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }); seg = []; };
    pts.forEach(p => { if (p) seg.push(p); else flush(); }); flush();
    pts.forEach(p => { if (p) add('circle', { cx: p[0], cy: p[1], r: 4, fill: sr.css, stroke: 'var(--surface-1)', 'stroke-width': 2 }); });
    const lastPt = [...pts].reverse().find(Boolean);
    if (lastPt) labels.push({ sr, y: lastPt[1] });
  }
  labels.sort((a, b) => a.y - b.y);
  for (let k = 1; k < labels.length; k++) if (labels[k].y - labels[k - 1].y < 14) labels[k].y = labels[k - 1].y + 14;
  for (const l of labels) add('text', { x: W - R + 8, y: l.y + 4, class: 'dlabel' }, l.sr.label);
  const cross = add('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
  const hit = add('rect', { x: L - 10, y: 0, width: W - L - R + 20, height: H, fill: 'transparent' });
  const wrap = h('div', { class: 'chart-wrap' }), tip = h('div', { class: 'tip', style: { display: 'none' } });
  const move = (ev) => {
    const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * W / r.width;
    let i = Math.round((px - L) / ((W - L - R) / Math.max(1, rows.length - 1))); i = Math.max(0, Math.min(rows.length - 1, i));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    const row = rows[i]; tip.innerHTML = '';
    put(tip, h('b', {}, `Run ${row.x.n} · Modell v${row.x.m.id}`),
      ...SERIES.map(sr => h('div', {}, h('span', { class: 'sw', style: { background: sr.css } }), `${sr.label}: `, h('b', {}, fmt(sr, row.s[sr.key])))),
      h('div', { class: 'muted' }, `Durchschnitt der letzten ${Math.min(WINDOW, i + 1)} Runs`));
    tip.style.display = 'block';
    tip.style.left = Math.min(r.width - 190, Math.max(0, (x(i) / W) * r.width + 10)) + 'px';
  };
  hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
  put(wrap, svg, tip);
  put(box,
    h('div', { class: 'legend' }, SERIES.map(sr => h('span', {}, h('span', { class: 'sw', style: { background: sr.css } }), `${sr.label} (${sr.better})`))),
    h('p', { class: 'muted small' }, `Gleitender Durchschnitt über je ${WINDOW} Runs. Der Zählfehler erscheint nur bei vollständig gezählten Windeln; Werte über 200 % werden oben am Rand gezeigt.`),
    wrap);
  return box;
}

function perRunCard(runs) {
  return h('div', { class: 'card' },
    h('h3', {}, 'Je Run'),
    h('div', { class: 'scrollx' }, h('table', { class: 'data' },
      h('tr', {}, ...['Run', 'Bild', 'Modell', 'Schätzung', 'sichere Milben', 'gefunden', 'Fehlalarme', 'ohne Urteil', 'Zählfehler'].map(t => h('th', {}, t))),
      [...runs].reverse().map(({ n, img, m, r }) => h('tr', {},
        h('td', {}, n),
        h('td', {}, h('a', { href: `#/bild/${img.id}` }, img.file_name || fmtDate(img.taken_at))),
        h('td', {}, `v${m.id}`), h('td', {}, r.pred), h('td', {}, r.sureMites),
        h('td', {}, `${r.tp}/${r.sureMites}`), h('td', {}, r.fp), h('td', {}, r.unjudged),
        h('td', {}, r.complete && r.truth ? `${r.pred - r.truth > 0 ? '+' : ''}${Math.round((r.pred - r.truth) / r.truth * 100)} %` : '–'))))));
}

function dataBase(allImgs, images, models) {
  const byMember = {};
  for (const i of images) if (i.reviewed_by) byMember[i.reviewed_by] = (byMember[i.reviewed_by] || 0) + 1;
  const mites = images.reduce((a, i) => a + (i.n_mites || 0), 0);
  return h('div', { class: 'card' },
    h('h3', {}, 'Datenbasis'),
    h('p', {}, `${allImgs.length} Fotos, davon ${images.length} geprüft mit zusammen ${mites} sicheren Milben. ${models.length} Modellversionen.`),
    Object.keys(byMember).length ? h('table', { class: 'data' },
      h('tr', {}, h('th', {}, 'Wer'), h('th', {}, 'geprüfte Runs')),
      Object.entries(byMember).map(([id, n]) => h('tr', {}, h('td', {}, memberName(id)), h('td', {}, n)))) : null);
}

function glossary() {
  return h('details', { class: 'card' }, h('summary', {}, 'Was bedeuten die Kennzahlen?'),
    h('dl', { class: 'gloss' },
      h('dt', {}, 'Run'), h('dd', {}, 'Ein hochgeladenes und geprüftes Foto. Die App schätzt mit dem Modell, das beim Hochladen aktuell war, danach lernt sie aus der Prüfung.'),
      h('dt', {}, 'Trefferquote'), h('dd', {}, 'Anteil der sicher markierten Milben, die das Modell selbst als Milbe gezählt hat.'),
      h('dt', {}, 'Fehlalarmquote'), h('dd', {}, 'Anteil der Modell-Treffer, die beim Prüfen als „sicher keine Milbe“ markiert wurden (von allen beurteilten Treffern).'),
      h('dt', {}, 'Treffer ohne Urteil'), h('dd', {}, 'Modell-Treffer, die beim Prüfen offen blieben. Sie fließen in keine Quote ein.'),
      h('dt', {}, 'Zählfehler Ø'), h('dd', {}, 'Abweichung der geschätzten Zahl von der geprüften Zahl je Windel, nur bei vollständig gezählten Windeln. Für den Behandlungszeitpunkt die wichtigste Zahl.'),
      h('dt', {}, 'Konfidenz und Abfragegrenze'), h('dd', {}, 'Das Modell gibt jedem Fleck eine Wahrscheinlichkeit, eine Milbe zu sein. Abgefragt wird alles oberhalb einer Grenze, unter der bisher höchstens 5 % der bestätigten Milben lagen. Je besser das Modell, desto weniger Fragen.'),
      h('dt', {}, 'Stichprobe'), h('dd', {}, 'Zufällige Kacheln unterhalb der Grenze. Sie zeigen, wie viele Milben der Abfrage entgehen.')));
}
