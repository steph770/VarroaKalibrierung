// Varroa-Kalibrierung - Kandidatengenerator
// Findet dunkle, kompakte Flecken in Milbengröße auf der Windel und berechnet
// Merkmale für den Klassifikator. Läuft im Browser (Web Worker) und in Node.
// Alle Größen werden in Millimetern gerechnet; dafür braucht es den Maßstab (px/mm).

export const GEN_VERSION = 'G1';

// Reihenfolge der Merkmale - nicht ändern, ohne GEN_VERSION zu erhöhen.
export const FEATURES = [
  'area',    // Fläche in mm²
  'len',     // Länge der Hauptachse in mm
  'wid',     // Breite (Nebenachse) in mm
  'aspect',  // Länge / Breite
  'fill',    // Füllgrad gegenüber einer Ellipse (1 = glatt-oval)
  'dmean',   // mittlere relative Dunkelheit (0..1)
  'dmax',    // maximale relative Dunkelheit
  'dstd',    // Streuung der Dunkelheit im Fleck
  'rn',      // relativer Rotanteil (weißabgeglichen)
  'gn',      // relativer Grünanteil
  'bn',      // relativer Blauanteil
  'red',     // Rot minus Blau (weißabgeglichen)
  'ringd',   // Dunkelheit des Rings um den Fleck (negativ = heller Rand)
  'compact', // Randpixel / Wurzel(Fläche) - zackig = hoch
  'nbr',     // Anzahl weiterer Kandidaten im Umkreis von 3 mm
];

export const DEFAULT_PARAMS = {
  tLow: 0.12,      // Untergrenze für die Ausdehnung eines Flecks
  tHigh: 0.50,     // Mindest-Spitzendunkelheit eines Flecks (relativ zur Windel)
  minDmean: 0.40,  // Mindest-Durchschnittsdunkelheit
  minArea: 0.6,    // mm²
  maxArea: 6.0,    // mm²
  maxLen: 4.0,     // mm
  minWid: 0.6,     // mm
  bgBlockMm: 1.2,  // Blockgröße für die Hintergrundschätzung
  bgWin: 7,        // Fenster (in Blöcken) für das Hintergrund-Perzentil
  bgPct: 0.75,     // Perzentil: Hintergrund = eher helle Werte (Windel)
};

// --- Hilfsfunktionen -------------------------------------------------------

// Zeilenweise Bereiche [x0, x1] innerhalb eines Polygons (ROI)
export function roiSpans(w, h, poly) {
  const spans = new Array(h);
  if (!poly || poly.length < 3) {
    for (let y = 0; y < h; y++) spans[y] = [[0, w - 1]];
    return spans;
  }
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + (yc - y1) / (y2 - y1) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    const row = [];
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      if (b >= a) row.push([a, b]);
    }
    spans[y] = row;
  }
  return spans;
}

function percentile(arr, n, p) {
  const a = arr.slice(0, n).sort((x, y) => x - y);
  return a[Math.min(n - 1, Math.floor(p * (n - 1) + 0.5))];
}

// Hintergrund (Windelfarbe) als grobes Raster: Blockmittel, dann helles Perzentil
function backgroundGrid(rgba, w, h, block, win, pct) {
  const bw = Math.ceil(w / block), bh = Math.ceil(h / block);
  const sums = [new Float64Array(bw * bh), new Float64Array(bw * bh), new Float64Array(bw * bh)];
  const cnt = new Uint32Array(bw * bh);
  for (let y = 0; y < h; y++) {
    const by = (y / block) | 0, rowOff = y * w * 4;
    for (let x = 0; x < w; x++) {
      const b = by * bw + ((x / block) | 0), i = rowOff + x * 4;
      sums[0][b] += rgba[i]; sums[1][b] += rgba[i + 1]; sums[2][b] += rgba[i + 2]; cnt[b]++;
    }
  }
  const means = sums.map(s => { const m = new Float32Array(bw * bh); for (let i = 0; i < m.length; i++) m[i] = s[i] / Math.max(1, cnt[i]); return m; });
  const r = (win - 1) >> 1, buf = new Float32Array(win * win);
  const out = means.map(() => new Float32Array(bw * bh));
  for (let c = 0; c < 3; c++) {
    const src = means[c], dst = out[c];
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = by + dy; if (yy < 0 || yy >= bh) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = bx + dx; if (xx < 0 || xx >= bw) continue;
          buf[n++] = src[yy * bw + xx];
        }
      }
      dst[by * bw + bx] = percentile(buf, n, pct);
    }
  }
  return { bw, bh, block, r: out[0], g: out[1], b: out[2] };
}

// bilineare Interpolation im Hintergrundraster
function bgAt(bg, x, y) {
  const fx = Math.min(Math.max((x + 0.5) / bg.block - 0.5, 0), bg.bw - 1);
  const fy = Math.min(Math.max((y + 0.5) / bg.block - 0.5, 0), bg.bh - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, bg.bw - 1), y1 = Math.min(y0 + 1, bg.bh - 1);
  const ax = fx - x0, ay = fy - y0;
  const i00 = y0 * bg.bw + x0, i10 = y0 * bg.bw + x1, i01 = y1 * bg.bw + x0, i11 = y1 * bg.bw + x1;
  const lerp = (a) => (a[i00] * (1 - ax) + a[i10] * ax) * (1 - ay) + (a[i01] * (1 - ax) + a[i11] * ax) * ay;
  return [lerp(bg.r), lerp(bg.g), lerp(bg.b)];
}

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// --- Hauptfunktion -----------------------------------------------------------

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint8Array}} img RGBA
 * @param {number} ppm Pixel pro mm bei dieser Auflösung
 * @param {number[][]|null} roi Polygon [[x,y],...] in Pixeln dieser Auflösung
 * @param {object} params siehe DEFAULT_PARAMS
 * @param {(p:number)=>void} [onProgress]
 * @returns {{gen:string, candidates:{x:number,y:number,f:number[]}[]}}
 */
export function detectCandidates(img, ppm, roi, params = {}, onProgress = () => {}) {
  const P = { ...DEFAULT_PARAMS, ...params };
  const { width: w, height: h, data } = img;
  const block = Math.max(2, Math.round(P.bgBlockMm * ppm));
  const bg = backgroundGrid(data, w, h, block, P.bgWin, P.bgPct);
  onProgress(0.25);
  const spans = roiSpans(w, h, roi);

  // relative Dunkelheit (0..255) innerhalb der ROI
  const rel = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (const [a, b] of spans[y]) for (let x = a; x <= b; x++) {
      const i = (y * w + x) * 4;
      const [br, bgc, bb] = bgAt(bg, x, y);
      const L = lum(data[i], data[i + 1], data[i + 2]), Lb = Math.max(1, lum(br, bgc, bb));
      const d = 1 - L / Lb;
      rel[y * w + x] = d <= 0 ? 0 : d >= 1 ? 255 : Math.round(d * 255);
    }
    if ((y & 255) === 0) onProgress(0.25 + 0.35 * y / h);
  }

  // leicht glätten (3x3), damit JPEG-Rauschen keine Scheinmaxima erzeugt
  const sm = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!rel[i]) continue;
    sm[i] = (rel[i - w - 1] + rel[i - w] + rel[i - w + 1] + rel[i - 1] + rel[i] + rel[i + 1] + rel[i + w - 1] + rel[i + w] + rel[i + w + 1]) / 9;
  }
  onProgress(0.65);

  const tLow = Math.round(P.tLow * 255), tHigh = Math.round(P.tHigh * 255);
  // Startpunkte: lokale Maxima (5x5) mit Dunkelheit >= tHigh, absteigend sortiert
  const buckets = Array.from({ length: 256 }, () => []);
  for (let y = 2; y < h - 2; y++) {
    for (const [a, b] of spans[y]) for (let x = Math.max(2, a); x <= Math.min(w - 3, b); x++) {
      const i = y * w + x, v = sm[i];
      if (v < tHigh) continue;
      let isMax = true;
      for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (sm[i + dy * w + dx] > v) { isMax = false; break; }
      }
      if (isMax) buckets[v].push(i);
    }
  }
  const maxPix = Math.ceil(P.maxArea * ppm * ppm * 1.6);
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(maxPix * 8 + 64);
  const pix = new Int32Array(maxPix + 8);
  const cands = [];
  const ring = Math.max(2, Math.round(0.5 * ppm));
  let done = 0, totalSeeds = buckets.reduce((s, b) => s + b.length, 0);

  for (let v = 255; v >= tHigh; v--) {
    for (const s of buckets[v]) {
      done++;
      if (visited[s]) continue;
      // Fleck = zusammenhängende Pixel über der halben Spitzendunkelheit (mind. tLow)
      const thr = Math.max(tLow, Math.round(v * 0.5));
      let sp = 0, n = 0, overflow = false;
      stack[sp++] = s; visited[s] = 1;
      while (sp > 0) {
        const p = stack[--sp];
        if (n < maxPix) pix[n++] = p; else { overflow = true; break; }
        const px = p % w, py = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = py + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = px + dx; if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (!visited[q] && sm[q] >= thr) {
              visited[q] = 1;
              if (sp < stack.length) stack[sp++] = q; else overflow = true;
            }
          }
        }
      }
      if (overflow) continue;
      const area = n / (ppm * ppm);
      if (area < P.minArea || area > P.maxArea) continue;
      const c = blobFeatures(pix, n, w, h, data, sm, bg, ppm, ring);
      if (c.len > P.maxLen || c.wid < P.minWid || c.dmean < P.minDmean) continue;
      cands.push(c);
    }
    if ((v & 15) === 0) onProgress(0.65 + 0.3 * done / Math.max(1, totalSeeds));
  }

  // Nachbarn im Umkreis von 3 mm (Rastersuche)
  const cell = 3 * ppm, grid = new Map();
  cands.forEach((c, i) => {
    const k = `${Math.floor(c.x / cell)},${Math.floor(c.y / cell)}`;
    if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
  });
  for (const c of cands) {
    const gx = Math.floor(c.x / cell), gy = Math.floor(c.y / cell);
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const j of grid.get(`${gx + dx},${gy + dy}`) || []) {
        const o = cands[j]; if (o === c) continue;
        if (Math.hypot(o.x - c.x, o.y - c.y) <= cell) k++;
      }
    }
    c.nbr = k;
  }
  onProgress(1);
  return {
    gen: GEN_VERSION,
    candidates: cands.map(c => ({ x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, f: FEATURES.map(k => round3(c[k])) })),
  };
}

function round3(v) { return Math.round(v * 1e3) / 1e3; }

function blobFeatures(pix, n, w, h, data, rel, bg, ppm, ring) {
  let sx = 0, sy = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  let sR = 0, sG = 0, sB = 0, sd = 0, sd2 = 0, dmax = 0;
  for (let k = 0; k < n; k++) {
    const p = pix[k], x = p % w, y = (p / w) | 0;
    sx += x; sy += y;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    const i = p * 4; sR += data[i]; sG += data[i + 1]; sB += data[i + 2];
    const d = rel[p] / 255; sd += d; sd2 += d * d; if (d > dmax) dmax = d;
  }
  const cx = sx / n, cy = sy / n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let k = 0; k < n; k++) {
    const p = pix[k], dx = (p % w) - cx, dy = ((p / w) | 0) - cy;
    cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  cxx /= n; cyy /= n; cxy /= n;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = Math.max(tr / 2 + disc, 0.25), l2 = Math.max(tr / 2 - disc, 0.25);
  const lenPx = 4 * Math.sqrt(l1), widPx = 4 * Math.sqrt(l2);

  // lokale Maske für Rand und Ring
  const m = ring, bx0 = Math.max(0, minX - m), by0 = Math.max(0, minY - m), bx1 = Math.min(w - 1, maxX + m), by1 = Math.min(h - 1, maxY + m);
  const bwid = bx1 - bx0 + 1, bhei = by1 - by0 + 1;
  const local = new Uint8Array(bwid * bhei);
  for (let k = 0; k < n; k++) { const p = pix[k]; local[(((p / w) | 0) - by0) * bwid + (p % w) - bx0] = 1; }
  let boundary = 0;
  for (let k = 0; k < n; k++) {
    const p = pix[k], lx = (p % w) - bx0, ly = ((p / w) | 0) - by0;
    if (lx === 0 || ly === 0 || lx === bwid - 1 || ly === bhei - 1 ||
      !local[ly * bwid + lx - 1] || !local[ly * bwid + lx + 1] || !local[(ly - 1) * bwid + lx] || !local[(ly + 1) * bwid + lx]) boundary++;
  }
  const [br, bgc, bb] = bgAt(bg, cx, cy);
  const Lb = Math.max(1, lum(br, bgc, bb));
  let ringSum = 0, ringN = 0;
  for (let ly = 0; ly < bhei; ly++) for (let lx = 0; lx < bwid; lx++) {
    if (local[ly * bwid + lx]) continue;
    const i = ((ly + by0) * w + lx + bx0) * 4;
    ringSum += 1 - lum(data[i], data[i + 1], data[i + 2]) / Lb; ringN++;
  }
  const r = (sR / n) / Math.max(1, br), g = (sG / n) / Math.max(1, bgc), b = (sB / n) / Math.max(1, bb);
  const s = Math.max(1e-6, r + g + b);
  const dmean = sd / n;
  return {
    x: cx, y: cy,
    area: n / (ppm * ppm),
    len: lenPx / ppm, wid: widPx / ppm, aspect: lenPx / Math.max(widPx, 0.5),
    fill: n / (Math.PI / 4 * lenPx * widPx),
    dmean, dmax, dstd: Math.sqrt(Math.max(0, sd2 / n - dmean * dmean)),
    rn: r / s, gn: g / s, bn: b / s, red: r - b,
    ringd: ringN ? ringSum / ringN : 0,
    compact: boundary / Math.sqrt(n),
    nbr: 0,
  };
}

// Automatische Schätzung der Windel-Ecken (helle, große Fläche) als Startwert.
// Liefert [oben-links, oben-rechts, unten-rechts, unten-links].
export function autoRoi(img) {
  const { width: w, height: h, data } = img;
  const step = Math.max(1, Math.round(Math.max(w, h) / 400));
  const sw = Math.ceil(w / step), sh = Math.ceil(h / step);
  const score = new Float32Array(sw * sh);
  const hist = new Uint32Array(256);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = ((y * step) * w + x * step) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx ? (mx - mn) / mx * 255 : 0;
    const v = Math.max(0, Math.min(255, mx - 0.8 * sat));
    score[y * sw + x] = v; hist[Math.round(v)]++;
  }
  // Otsu-Schwelle
  const total = sw * sh; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sumB += i * hist[i]; const mB = sumB / wB, mF = (sum - sumB) / wF; const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = i; }
  }
  // größte zusammenhängende helle Fläche
  const lab = new Int32Array(sw * sh); let bestLab = 0, bestN = 0, cur = 0;
  const st = [];
  for (let s = 0; s < sw * sh; s++) {
    if (lab[s] || score[s] <= thr) continue;
    cur++; let n = 0; st.push(s); lab[s] = cur;
    while (st.length) {
      const p = st.pop(); n++; const x = p % sw, y = (p / sw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
        const q = yy * sw + xx; if (!lab[q] && score[q] > thr) { lab[q] = cur; st.push(q); }
      }
    }
    if (n > bestN) { bestN = n; bestLab = cur; }
  }
  let tl = null, tr = null, br = null, bl = null;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    if (lab[y * sw + x] !== bestLab) continue;
    const X = x * step, Y = y * step;
    if (!tl || X + Y < tl[0] + tl[1]) tl = [X, Y];
    if (!br || X + Y > br[0] + br[1]) br = [X, Y];
    if (!tr || X - Y > tr[0] - tr[1]) tr = [X, Y];
    if (!bl || X - Y < bl[0] - bl[1]) bl = [X, Y];
  }
  if (!tl) return [[0, 0], [w, 0], [w, h], [0, h]];
  return [tl, tr, br, bl];
}

// Maßstab (Pixel pro mm) aus den Windel-Ecken [oben-links, oben-rechts, unten-rechts, unten-links]
// widthMm: Windelbreite in Rähmchenrichtung (Pflicht), lengthMm: Länge (optional, z. B. wenn abgeschnitten)
// widthDir: 'senkrecht' = die Breite verläuft im Foto von oben nach unten, 'waagrecht' = von links nach rechts
export function pxPerMmFromRoi(roi, widthMm, lengthMm, widthDir = 'senkrecht') {
  if (!roi || roi.length !== 4 || !(widthMm > 0)) return null;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const vertical = (d(roi[0], roi[3]) + d(roi[1], roi[2])) / 2;   // linke und rechte Kante
  const horizontal = (d(roi[0], roi[1]) + d(roi[3], roi[2])) / 2; // obere und untere Kante
  const [wPx, lPx] = widthDir === 'waagrecht' ? [horizontal, vertical] : [vertical, horizontal];
  const fromWidth = wPx / widthMm;
  return lengthMm > 0 ? (fromWidth + lPx / lengthMm) / 2 : fromWidth;
}
