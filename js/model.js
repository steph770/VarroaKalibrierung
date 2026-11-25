// Varroa-Kalibrierung - Klassifikator und Auswertung
// Logistische Regression auf den Merkmalen der Kandidaten. Klein genug, um bei jedem
// neu bestätigten Bild im Browser neu trainiert zu werden.

import { FEATURES, GEN_VERSION } from './detect.js';

export const MATCH_MM = 0.9;
export const WEAK_NEG = 0.15;          // Gewicht nicht beurteilter Flecken beim Lernen          // Abstand, bis zu dem ein Treffer als dieselbe Milbe gilt
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
  const nNegSure = samples.filter(s => s.y === 0 && !s.w).length;
  if (nPos < 3 || nNeg < 3) throw new Error('Zu wenige Beispiele zum Trainieren (mind. 3 Milben und 3 andere Flecken).');
  const mean = new Array(d0).fill(0), std = new Array(d0).fill(0);
  for (const s of samples) s.f.forEach((v, i) => { mean[i] += v / n; });
  for (const s of samples) s.f.forEach((v, i) => { std[i] += (v - mean[i]) ** 2 / n; });
  for (let i = 0; i < d0; i++) std[i] = Math.sqrt(std[i]) || 1;
  const X = samples.map(s => expand(s.f, mean, std));
  const Y = samples.map(s => s.y);
  const Wt = samples.map(s => s.w ?? 1);
  // Klassen ausgleichen: Milben sind selten
  const posW = Wt.reduce((a, w, k) => a + (Y[k] ? w : 0), 0), negW = Wt.reduce((a, w, k) => a + (Y[k] ? 0 : w), 0);
  const balance = Math.min(50, negW / Math.max(1e-9, posW));
  const sw = Wt.map((w, k) => w * (Y[k] ? balance : 1));
  const sumW = sw.reduce((a, b) => a + b, 0);
  const d = X[0].length;
  const w = new Array(d).fill(0); let b = 0;
  const m = new Array(d + 1).fill(0), v = new Array(d + 1).fill(0);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (let ep = 1; ep <= epochs; ep++) {
    const g = new Array(d + 1).fill(0);
    for (let k = 0; k < n; k++) {
      let s = b; const x = X[k];
      for (let i = 0; i < d; i++) s += w[i] * x[i];
      const p = 1 / (1 + Math.exp(-s));
      const err = (p - Y[k]) * sw[k] / sumW;
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
  const model = { gen: GEN_VERSION, features: FEATURES, mean, std, w, bias: b, threshold: 0.5, nPos, nNeg: nNegSure, nWeak: nNeg - nNegSure };
  // Schwelle: beste Balance aus gefundenen Milben und Fehlalarmen (F1, schwache Negative gewichtet)
  const scored = samples.map((s, k) => ({ p: predict(model, s.f), y: s.y, w: Wt[k] })).sort((a, b) => b.p - a.p);
  let tp = 0, fp = 0, best = -1, bestT = 0.5;
  for (let k = 0; k < scored.length; k++) {
    if (scored[k].y) tp += 1; else fp += scored[k].w;
    const f1 = 2 * tp / (2 * tp + fp + (nPos - tp));
    if (f1 > best) { best = f1; bestT = k + 1 < scored.length ? (scored[k].p + scored[k + 1].p) / 2 : scored[k].p; }
  }
  model.threshold = Math.round(bestT * 1e5) / 1e5;
  model.w = w.map(x => Math.round(x * 1e5) / 1e5); model.bias = Math.round(b * 1e5) / 1e5;
  model.mean = mean.map(x => Math.round(x * 1e5) / 1e5); model.std = std.map(x => Math.round(x * 1e5) / 1e5);
  return model;
}

// --- Abgleich von Kandidaten und geprüften Punkten ---------------------------------
// Geprüft werden nur sichere Fälle: l = 'm' (sicher Milbe) oder 'k' (sicher keine Milbe).
// Alles andere gilt als nicht beurteilt und fließt weder ins Training noch in die Quoten ein.

function nearest(points, x, y, r) {
  let best = null, bd = r;
  for (const p of points) {
    const dd = Math.hypot(p.x - x, p.y - y);
    if (dd <= bd) { bd = dd; best = p; }
  }
  return best;
}

function judged(image) {
  const sc = (image.candidates && image.candidates.scale) || 1;
  const pts = ((image.annotations && image.annotations.points) || [])
    .filter(p => (p.l === 'm' || p.l === 'k') && !p.p)
    .map(p => ({ x: p.x * sc, y: p.y * sc, l: p.l, c: p.c }));
  return { sc, mites: pts.filter(p => p.l === 'm'), nonm: pts.filter(p => p.l === 'k'), r: MATCH_MM * image.px_per_mm * sc };
}

/** Trainingsbeispiele: nur Kandidaten, die als sicher Milbe (1) oder sicher keine Milbe (0) markiert sind. */
export function samplesForImage(image) {
  const cand = image.candidates;
  if (!cand || !image.annotations || cand.gen !== GEN_VERSION) return [];
  const { mites, nonm, r } = judged(image);
  const out = [];
  for (const c of cand.list) {
    if (nearest(mites, c.x, c.y, r)) out.push({ f: c.f, y: 1 });
    else if (nearest(nonm, c.x, c.y, r)) out.push({ f: c.f, y: 0 });
    // Nicht beurteilte Flecken sind fast immer Gemüll: als schwache Negativ-Beispiele mitnehmen,
    // sonst lernt das Modell nur aus Milben und meldet bald alles als Milbe.
    else out.push({ f: c.f, y: 0, w: WEAK_NEG });
  }
  return out;
}

/**
 * Wie gut lag ein Modell bei einem geprüften Bild?
 * tp: sichere Milben, die das Modell gefunden hat; fn: sichere Milben, die es übersehen hat;
 * fp: Modell-Treffer, die sicher keine Milbe sind; unjudged: Modell-Treffer ohne Urteil.
 * Zählfehler nur, wenn das Bild als vollständig gezählt markiert ist.
 */
export function evaluateImage(model, image) {
  const cand = image.candidates;
  const { mites, nonm, r } = judged(image);
  const preds = cand.list.filter(c => predict(model, c.f) >= model.threshold);
  const pairs = [];
  preds.forEach((c, i) => mites.forEach((m, j) => { const d = Math.hypot(c.x - m.x, c.y - m.y); if (d <= r) pairs.push([d, i, j]); }));
  pairs.sort((a, b) => a[0] - b[0]);
  const pm = new Set(), mm = new Set();
  for (const [, i, j] of pairs) { if (pm.has(i) || mm.has(j)) continue; pm.add(i); mm.add(j); }
  let fp = 0, unjudged = 0; const fpCauses = {};
  preds.forEach((c, i) => {
    if (pm.has(i)) return;
    const k = nearest(nonm, c.x, c.y, r);
    if (k) { fp++; const cause = k.c || 'ohne'; fpCauses[cause] = (fpCauses[cause] || 0) + 1; }
    else unjudged++;
  });
  const tp = pm.size, fn = mites.length - tp;
  let candHit = 0;
  for (const m of mites) if (nearest(cand.list, m.x, m.y, r)) candHit++;
  const complete = !!(image.annotations && image.annotations.complete);
  return { tp, fp, fn, unjudged, pred: preds.length, sureMites: mites.length, sureNon: nonm.length, fpCauses, complete,
    truth: complete ? mites.length : null, candRecall: mites.length ? candHit / mites.length : null };
}

export function summarize(results) {
  const s = { images: results.length, tp: 0, fp: 0, fn: 0, unjudged: 0, pred: 0, sureMites: 0, sureNon: 0, fpCauses: {}, absErrPct: [], absErr: [], complete: 0 };
  for (const r of results) {
    for (const k of ['tp', 'fp', 'fn', 'unjudged', 'pred', 'sureMites', 'sureNon']) s[k] += r[k];
    for (const [k, v] of Object.entries(r.fpCauses)) s.fpCauses[k] = (s.fpCauses[k] || 0) + v;
    if (r.complete) {
      s.complete++;
      s.absErr.push(Math.abs(r.pred - r.truth));
      if (r.truth > 0) s.absErrPct.push(Math.abs(r.pred - r.truth) / r.truth * 100);
    }
  }
  s.recall = s.sureMites ? s.tp / s.sureMites : null;            // Trefferquote
  s.falseRate = (s.tp + s.fp) ? s.fp / (s.tp + s.fp) : null;     // Fehlalarmquote unter beurteilten Treffern
  s.missRate = s.sureMites ? s.fn / s.sureMites : null;
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
