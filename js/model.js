// Varroa-Kalibrierung - Klassifikator und Auswertung
// Logistische Regression auf den Merkmalen der Kandidaten. Klein genug, um bei jedem
// neu bestätigten Bild im Browser neu trainiert zu werden.

import { FEATURES, GEN_VERSION } from './detect.js';

export const MATCH_MM = 0.9;          // Abstand, bis zu dem ein Treffer als dieselbe Milbe gilt
const SQUARED = ['area', 'len', 'wid', 'dmean', 'dmax', 'gn', 'bn'];
const SQ_IDX = SQUARED.map(k => FEATURES.indexOf(k));

export const CAUSES = {
  pollen: 'Pollen',
  wachs: 'Wachs',
  propolis: 'Propolis',
  bienenteil: 'Bienenteil',
  sonstiges: 'Sonstiges',
};

// --- Merkmale ------------------------------------------------------------------

function expand(f, mean, std) {
  const z = f.map((v, i) => (v - mean[i]) / (std[i] || 1));
  return z.concat(SQ_IDX.map(i => z[i] * z[i]));
}

export function predict(model, f) {
  const x = expand(f, model.mean, model.std);
  let s = model.bias;
  for (let i = 0; i < x.length; i++) s += model.w[i] * x[i];
  return 1 / (1 + Math.exp(-s));
}

// --- Training --------------------------------------------------------------------

/**
 * @param {{f:number[], y:0|1}[]} samples
 * @returns {object} Modell {gen, features, mean, std, w, bias, threshold, nPos, nNeg}
 */
export function train(samples, opts = {}) {
  const { epochs = 400, lr = 0.05, l2 = 0.01 } = opts;
  const n = samples.length, d0 = FEATURES.length;
  const nPos = samples.filter(s => s.y === 1).length, nNeg = n - nPos;
  if (nPos < 3 || nNeg < 3) throw new Error('Zu wenige Beispiele zum Trainieren (mind. 3 Milben und 3 Nicht-Milben).');
  const mean = new Array(d0).fill(0), std = new Array(d0).fill(0);
  for (const s of samples) s.f.forEach((v, i) => { mean[i] += v / n; });
  for (const s of samples) s.f.forEach((v, i) => { std[i] += (v - mean[i]) ** 2 / n; });
  for (let i = 0; i < d0; i++) std[i] = Math.sqrt(std[i]) || 1;
  const X = samples.map(s => expand(s.f, mean, std));
  const Y = samples.map(s => s.y);
  // Klassen ausgleichen: Milben sind selten
  const wPos = Math.min(50, nNeg / Math.max(1, nPos)), wNeg = 1;
  const d = X[0].length;
  const w = new Array(d).fill(0); let b = 0;
  const m = new Array(d + 1).fill(0), v = new Array(d + 1).fill(0);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const sumW = nPos * wPos + nNeg * wNeg;
  for (let ep = 1; ep <= epochs; ep++) {
    const g = new Array(d + 1).fill(0);
    for (let k = 0; k < n; k++) {
      let s = b; const x = X[k];
      for (let i = 0; i < d; i++) s += w[i] * x[i];
      const p = 1 / (1 + Math.exp(-s));
      const err = (p - Y[k]) * (Y[k] ? wPos : wNeg) / sumW;
      for (let i = 0; i < d; i++) g[i] += err * x[i];
      g[d] += err;
    }
    for (let i = 0; i < d; i++) g[i] += l2 * w[i];
    for (let i = 0; i <= d; i++) {
      m[i] = b1 * m[i] + (1 - b1) * g[i]; v[i] = b2 * v[i] + (1 - b2) * g[i] * g[i];
      const mh = m[i] / (1 - b1 ** ep), vh = v[i] / (1 - b2 ** ep);
      const step = lr * mh / (Math.sqrt(vh) + eps);
      if (i < d) w[i] -= step; else b -= step;
    }
  }
  const model = { gen: GEN_VERSION, features: FEATURES, mean, std, w, bias: b, threshold: 0.5, nPos, nNeg };
  // Schwelle so wählen, dass die Gesamtzahl der Milben im Training stimmt
  // (wichtig für den Behandlungszeitpunkt), bei gleicher Zahl die höchste Trefferquote.
  const scored = samples.map(s => ({ p: predict(model, s.f), y: s.y })).sort((a, b) => b.p - a.p);
  let bestT = 0.5, bestErr = Infinity, tp = 0;
  for (let k = 0; k < scored.length; k++) {
    if (scored[k].y) tp++;
    const predCount = k + 1, err = Math.abs(predCount - nPos) - tp * 1e-6;
    if (err < bestErr) { bestErr = err; bestT = k + 1 < scored.length ? (scored[k].p + scored[k + 1].p) / 2 : scored[k].p; }
  }
  model.threshold = Math.round(bestT * 1e5) / 1e5;
  model.w = w.map(x => Math.round(x * 1e5) / 1e5); model.bias = Math.round(b * 1e5) / 1e5;
  model.mean = mean.map(x => Math.round(x * 1e5) / 1e5); model.std = std.map(x => Math.round(x * 1e5) / 1e5);
  return model;
}

// --- Abgleich von Kandidaten und geprüften Punkten ---------------------------------

// Nächster Punkt innerhalb des Radius (einfache Liste, Bilder haben wenige hundert Punkte)
function nearest(points, x, y, r) {
  let best = null, bd = r;
  for (const p of points) {
    const dd = Math.hypot(p.x - x, p.y - y);
    if (dd <= bd) { bd = dd; best = p; }
  }
  return best;
}

/**
 * Trainingsbeispiele eines bestätigten Bildes.
 * Kandidat nahe einer geprüften Milbe -> 1, nahe "unsicher" -> weggelassen, sonst 0
 * (nach der Prüfung gilt alles nicht als Milbe Markierte als keine Milbe).
 */
export function samplesForImage(image) {
  const cand = image.candidates; const ann = image.annotations;
  if (!cand || !ann || cand.gen !== GEN_VERSION) return [];
  const r = MATCH_MM * image.px_per_mm * (cand.scale || 1);
  const pts = (ann.points || []).map(p => ({ x: p.x * (cand.scale || 1), y: p.y * (cand.scale || 1), l: p.l }));
  const mites = pts.filter(p => p.l === 'm'), unsure = pts.filter(p => p.l === 'u');
  const out = [];
  for (const c of cand.list) {
    if (nearest(unsure, c.x, c.y, r)) continue;
    out.push({ f: c.f, y: nearest(mites, c.x, c.y, r) ? 1 : 0 });
  }
  return out;
}

/**
 * Auswertung eines Modells auf einem bestätigten Bild.
 * @returns {{tp:number, fp:number, fn:number, truth:number, pred:number, fpCauses:object, candRecall:number}}
 */
export function evaluateImage(model, image) {
  const cand = image.candidates, ann = image.annotations;
  const sc = cand.scale || 1;
  const r = MATCH_MM * image.px_per_mm * sc;
  const pts = (ann.points || []).map(p => ({ x: p.x * sc, y: p.y * sc, l: p.l, c: p.c }));
  const mites = pts.filter(p => p.l === 'm'), unsure = pts.filter(p => p.l === 'u'), nonm = pts.filter(p => p.l === 'k');
  const preds = cand.list.filter(c => predict(model, c.f) >= model.threshold);
  const used = new Set();
  let tp = 0, fp = 0, ignored = 0; const fpCauses = {};
  // Vorhersagen nach Abstand der Reihe nach zuordnen (jede Milbe höchstens einmal)
  const pairs = [];
  preds.forEach((c, i) => mites.forEach((m, j) => { const d = Math.hypot(c.x - m.x, c.y - m.y); if (d <= r) pairs.push([d, i, j]); }));
  pairs.sort((a, b) => a[0] - b[0]);
  const predMatched = new Set();
  for (const [, i, j] of pairs) { if (predMatched.has(i) || used.has(j)) continue; predMatched.add(i); used.add(j); tp++; }
  preds.forEach((c, i) => {
    if (predMatched.has(i)) return;
    if (nearest(unsure, c.x, c.y, r)) { ignored++; return; }
    fp++;
    const k = nearest(nonm, c.x, c.y, r);
    const cause = k && k.c ? k.c : 'ohne';
    fpCauses[cause] = (fpCauses[cause] || 0) + 1;
  });
  const fn = mites.length - tp;
  // Wie viele der geprüften Milben hat der Kandidatengenerator überhaupt gefunden?
  let candHit = 0;
  for (const m of mites) if (nearest(cand.list, m.x, m.y, r)) candHit++;
  return { tp, fp, fn, truth: mites.length, pred: tp + fp, fpCauses, candRecall: mites.length ? candHit / mites.length : null, ignored };
}

export function summarize(results) {
  const s = { images: results.length, tp: 0, fp: 0, fn: 0, truth: 0, pred: 0, fpCauses: {}, absErrPct: [], absErr: [] };
  for (const r of results) {
    s.tp += r.tp; s.fp += r.fp; s.fn += r.fn; s.truth += r.truth; s.pred += r.pred;
    for (const [k, v] of Object.entries(r.fpCauses)) s.fpCauses[k] = (s.fpCauses[k] || 0) + v;
    s.absErr.push(Math.abs(r.pred - r.truth));
    if (r.truth > 0) s.absErrPct.push(Math.abs(r.pred - r.truth) / r.truth * 100);
  }
  s.recall = s.truth ? s.tp / s.truth : null;            // Trefferquote
  s.falseRate = s.pred ? s.fp / s.pred : null;          // Fehlalarmquote
  s.missRate = s.truth ? s.fn / s.truth : null;         // übersehen
  s.countErrPct = s.absErrPct.length ? s.absErrPct.reduce((a, b) => a + b, 0) / s.absErrPct.length : null;
  s.countErrAbs = s.absErr.length ? s.absErr.reduce((a, b) => a + b, 0) / s.absErr.length : null;
  return s;
}

export function countWithModel(model, image) {
  if (!model || !image.candidates || image.candidates.gen !== model.gen) return null;
  let n = 0;
  for (const c of image.candidates.list) if (predict(model, c.f) >= model.threshold) n++;
  return n;
}
