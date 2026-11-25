// Statistikseite: Wird die Zählung besser? Alle Modellversionen werden auf denselben
// bestätigten Bildern gemessen, damit die Zahlen vergleichbar bleiben.
import { h, put, pct, fmtDate } from './ui.js';
import { state, refreshModels, refreshMembers, memberName, SPLIT_LABEL } from './core.js';
import { evaluateImage, summarize, CAUSES } from './model.js';
import { GEN_VERSION } from './detect.js';

const GROUP = { test: ['Testbilder', 'Testbildern'], train: ['Trainingsbilder', 'Trainingsbildern'] };

const SERIES = [
  { key: 'recall', label: 'Trefferquote', css: 'var(--series-1)', better: 'höher ist besser' },
  { key: 'falseRate', label: 'Fehlalarmquote', css: 'var(--series-2)', better: 'niedriger ist besser' },
  { key: 'countErrPct', label: 'Zählfehler Ø', css: 'var(--series-3)', better: 'niedriger ist besser', isPct: true },
];

export async function statsView(el) {
  put(el, h('h1', {}, 'Statistik'), h('div', { class: 'loading' }, 'Rechne …'));
  const [models, images] = await Promise.all([refreshModels(), state.store.listImagesFull({ status: 'bestaetigt' }), refreshMembers()]);
  const allImgs = await state.store.listImages();
  el.lastChild.remove();
  const usable = images.filter(i => i.candidates && i.candidates.gen === GEN_VERSION && i.annotations);
  const versions = models.filter(m => m.gen === GEN_VERSION);
  let group = 'test';

  const content = h('div');
  const seg = h('div', { class: 'seg' });
  const mkSeg = () => {
    seg.innerHTML = '';
    for (const g of ['test', 'train']) {
      const n = usable.filter(i => i.split === g).length;
      seg.append(h('button', { class: g === group ? 'on' : '', onclick: () => { group = g; mkSeg(); render(); } }, `${GROUP[g][0]} (${n})`));
    }
  };
  mkSeg();
  put(el, seg, content);

  function render() {
    content.innerHTML = '';
    const imgs = usable.filter(i => i.split === group);
    if (group === 'train') put(content, h('p', { class: 'card hint small' }, 'Achtung: Die Modelle haben diese Bilder zum Lernen verwendet. Die Werte sind deshalb zu optimistisch. Aussagekräftig sind die Testbilder.'));
    if (!imgs.length) {
      put(content, h('div', { class: 'card' }, h('p', {}, group === 'test'
        ? 'Noch keine bestätigten Testbilder. Sobald Testbilder geprüft und bestätigt sind, erscheint hier, wie gut jede Modellversion zählt.'
        : 'Noch keine bestätigten Trainingsbilder.')));
      put(content, dataBase());
      return;
    }
    if (!versions.length) { put(content, h('p', {}, 'Noch kein Modell vorhanden.')); return; }
    // Jede Version auf denselben Bildern auswerten
    const rows = versions.map(v => {
      const per = imgs.map(i => ({ img: i, r: evaluateImage(v.model, i) }));
      return { v, per, s: summarize(per.map(p => p.r)) };
    });
    const last = rows[rows.length - 1];
    const s = last.s;
    const candRecalls = last.per.map(p => p.r.candRecall).filter(x => x !== null);
    const candRecall = candRecalls.length ? last.per.reduce((a, p) => a + (p.r.candRecall ?? 0) * p.r.truth, 0) / Math.max(1, s.truth) : null;

    put(content, 
      h('h2', {}, `Aktuelles Modell v${last.v.id}`),
      h('p', { class: 'muted small' }, `gemessen an ${imgs.length} bestätigten ${imgs.length === 1 ? GROUP[group][0].replace(/bilder$/, 'bild') : GROUP[group][1]} mit ${s.truth} geprüften Milben`),
      h('div', { class: 'kpis four' },
        kpi(pct(s.recall), 'Trefferquote', `${s.tp} von ${s.truth} Milben gefunden`),
        kpi(pct(s.falseRate), 'Fehlalarmquote', `${s.fp} von ${s.pred} App-Treffern falsch`),
        kpi(s.countErrPct === null ? '–' : `${Math.round(s.countErrPct)} %`, 'Zählfehler Ø', s.countErrAbs === null ? '' : `im Schnitt ${s.countErrAbs.toFixed(1)} Milben daneben`),
        kpi(s.fn, 'übersehen', `${pct(s.missRate)} der Milben`)),
      causesCard(s),
      trendCard(rows),
      perImageCard(last),
      h('div', { class: 'card' },
        h('h3', {}, 'Grenze der Kandidatensuche'),
        h('p', {}, `Die Kandidatensuche findet ${pct(candRecall)} der geprüften Milben überhaupt. Mehr kann kein Modell dieser Version erkennen; was hier fehlt, braucht eine bessere Bildaufnahme oder eine neue Suchmethode.`)),
      dataBase(),
      glossary(),
    );
  }

  function dataBase() {
    const conf = images.length;
    const byMember = {};
    for (const i of allImgs) {
      if (i.reviewed_by) (byMember[i.reviewed_by] ||= { r: 0, c: 0 }).r++;
      if (i.confirmed_by && i.confirmed_by !== i.reviewed_by) (byMember[i.confirmed_by] ||= { r: 0, c: 0 }).c++;
    }
    const mites = images.reduce((a, i) => a + (i.n_mites || 0), 0);
    return h('div', { class: 'card' },
      h('h3', {}, 'Datenbasis'),
      h('p', {}, `${allImgs.length} Fotos insgesamt, davon ${conf} bestätigt (${images.filter(i => i.split === 'test').length} Test, ${images.filter(i => i.split === 'train').length} Training) mit zusammen ${mites} geprüften Milben. ${versions.length} Modellversionen.`),
      Object.keys(byMember).length ? h('table', { class: 'data' },
        h('tr', {}, h('th', {}, 'Wer'), h('th', {}, 'geprüft'), h('th', {}, 'zweitgeprüft')),
        Object.entries(byMember).map(([id, v]) => h('tr', {}, h('td', {}, memberName(id)), h('td', {}, v.r), h('td', {}, v.c)))) : null);
  }

  render();
}

const kpi = (v, l, sub) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, v), h('div', { class: 'kpi-l' }, l), sub ? h('div', { class: 'kpi-s' }, sub) : null);

function causesCard(s) {
  const entries = Object.entries(s.fpCauses).sort((a, b) => b[1] - a[1]);
  const box = h('div', { class: 'card' }, h('h3', {}, 'Fehlalarme nach Ursache'));
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

// Liniendiagramm: drei Kennzahlen in Prozent über die Modellversionen
function trendCard(rows) {
  const box = h('div', { class: 'card viz-root' }, h('h3', {}, 'Verlauf über die Modellversionen'));
  if (rows.length < 2) { put(box, h('p', { class: 'muted' }, 'Der Verlauf erscheint ab zwei Modellversionen.')); return box; }
  const W = Math.round(Math.min(640, Math.max(300, window.innerWidth - 62))), H = 240, L = 40, R = 108, T = 14, B = 30;
  const vals = rows.flatMap(r => SERIES.map(sr => (r.s[sr.key] ?? 0) * (sr.isPct ? 1 : 100)));
  const yMax = Math.max(100, Math.ceil(Math.max(...vals) / 50) * 50);
  const x = i => L + (rows.length === 1 ? 0 : i * (W - L - R) / (rows.length - 1));
  const y = v => T + (H - T - B) * (1 - v / yMax);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Verlauf von Trefferquote, Fehlalarmquote und Zählfehler über die Modellversionen');
  const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; svg.append(e); return e; };
  for (let g = 0; g <= yMax; g += yMax / 4) {
    add('line', { x1: L, x2: W - R, y1: y(g), y2: y(g), class: 'grid' });
    add('text', { x: L - 6, y: y(g) + 4, class: 'axis', 'text-anchor': 'end' }, `${g} %`);
  }
  const step = Math.max(1, Math.ceil(rows.length / 8));
  rows.forEach((r, i) => { if (i % step === 0 || i === rows.length - 1) add('text', { x: x(i), y: H - 12, class: 'axis', 'text-anchor': 'middle' }, `v${r.v.id}`); });
  const labelsY = [];
  for (const sr of SERIES) {
    const pts = rows.map((r, i) => [x(i), y((r.s[sr.key] ?? 0) * (sr.isPct ? 1 : 100))]);
    add('polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: sr.css, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    pts.forEach(p => add('circle', { cx: p[0], cy: p[1], r: 4, fill: sr.css, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    labelsY.push({ sr, y: pts[pts.length - 1][1] });
  }
  // Direkte Beschriftung am Linienende, ohne Überlappung
  labelsY.sort((a, b) => a.y - b.y);
  for (let k = 1; k < labelsY.length; k++) if (labelsY[k].y - labelsY[k - 1].y < 14) labelsY[k].y = labelsY[k - 1].y + 14;
  for (const l of labelsY) add('text', { x: W - R + 8, y: l.y + 4, class: 'dlabel' }, l.sr.label);
  // Hover: Fadenkreuz und Tooltip
  const cross = add('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
  const hit = add('rect', { x: L - 10, y: 0, width: W - L - R + 20, height: H, fill: 'transparent' });
  const wrap = h('div', { class: 'chart-wrap' });
  const tip = h('div', { class: 'tip', style: { display: 'none' } });
  const move = (ev) => {
    const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * W / r.width;
    let i = Math.round((px - L) / ((W - L - R) / Math.max(1, rows.length - 1))); i = Math.max(0, Math.min(rows.length - 1, i));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    const row = rows[i];
    tip.innerHTML = '';
    put(tip, h('b', {}, `Modell v${row.v.id} · ${fmtDate(row.v.created_at)}`),
      ...SERIES.map(sr => h('div', {}, h('span', { class: 'sw', style: { background: sr.css } }), `${sr.label}: `, h('b', {}, sr.isPct ? (row.s[sr.key] === null ? '–' : `${Math.round(row.s[sr.key])} %`) : pct(row.s[sr.key])))),
      h('div', { class: 'muted' }, `gelernt aus ${row.v.n_images ?? '?'} ${row.v.n_images === 1 ? 'Bild' : 'Bildern'}`));
    tip.style.display = 'block';
    const left = (x(i) / W) * r.width; tip.style.left = Math.min(r.width - 190, Math.max(0, left + 10)) + 'px';
  };
  hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
  put(wrap, svg, tip);
  put(box, 
    h('div', { class: 'legend' }, SERIES.map(sr => h('span', {}, h('span', { class: 'sw', style: { background: sr.css } }), `${sr.label} (${sr.better})`))),
    wrap,
    h('details', {}, h('summary', {}, 'Als Tabelle'),
      h('table', { class: 'data' },
        h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'Bilder gelernt'), ...SERIES.map(sr => h('th', {}, sr.label))),
        rows.map(r => h('tr', {}, h('td', {}, `v${r.v.id}`), h('td', {}, r.v.n_images ?? '–'),
          ...SERIES.map(sr => h('td', {}, sr.isPct ? (r.s[sr.key] === null ? '–' : `${Math.round(r.s[sr.key])} %`) : pct(r.s[sr.key]))))))));
  return box;
}

function perImageCard(last) {
  return h('div', { class: 'card' },
    h('h3', {}, `Je Bild (Modell v${last.v.id})`),
    h('div', { class: 'scrollx' }, h('table', { class: 'data' },
      h('tr', {}, h('th', {}, 'Bild'), h('th', {}, 'geprüft'), h('th', {}, 'App'), h('th', {}, 'Abweichung'), h('th', {}, 'gefunden'), h('th', {}, 'Fehlalarme')),
      last.per.map(({ img, r }) => h('tr', {},
        h('td', {}, h('a', { href: `#/bild/${img.id}` }, img.file_name || fmtDate(img.taken_at))),
        h('td', {}, r.truth), h('td', {}, r.pred),
        h('td', {}, r.truth ? `${r.pred - r.truth > 0 ? '+' : ''}${Math.round((r.pred - r.truth) / r.truth * 100)} %` : `${r.pred - r.truth > 0 ? '+' : ''}${r.pred - r.truth}`),
        h('td', {}, `${r.tp}/${r.truth}`), h('td', {}, r.fp))))));
}

function glossary() {
  return h('details', { class: 'card' }, h('summary', {}, 'Was bedeuten die Kennzahlen?'),
    h('dl', { class: 'gloss' },
      h('dt', {}, 'Trefferquote'), h('dd', {}, 'Anteil der geprüften Milben, die die App selbst gefunden hat.'),
      h('dt', {}, 'Fehlalarmquote'), h('dd', {}, 'Anteil der App-Treffer, die beim Prüfen als „keine Milbe“ markiert wurden. Mit Verwechsler-Angabe landen sie unter „Fehlalarme nach Ursache“.'),
      h('dt', {}, 'Zählfehler Ø'), h('dd', {}, 'Wie weit die App-Zahl im Schnitt von der geprüften Zahl abweicht, in Prozent je Windel. Fehlalarme und übersehene Milben können sich teilweise aufheben; für den Behandlungszeitpunkt zählt vor allem diese Zahl.'),
      h('dt', {}, 'Übersehen'), h('dd', {}, 'Geprüfte Milben, die die App nicht gefunden hat.'),
      h('dt', {}, 'Testbilder / Trainingsbilder'), h('dd', {}, 'Etwa ein Viertel der Fotos wird beim Hochladen zufällig als Testbild zurückgehalten. Die App lernt nur aus Trainingsbildern; gemessen wird an Testbildern, die sie nie gesehen hat.'),
      h('dt', {}, 'Unsicher'), h('dd', {}, 'Als „unsicher“ markierte Stellen zählen weder als Treffer noch als Fehler.')));
}
