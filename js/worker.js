// Web Worker: Kandidatensuche läuft im Hintergrund, damit die Oberfläche flüssig bleibt
import { detectCandidates } from './detect.js';

self.onmessage = (e) => {
  const { width, height, buffer, ppm, roi, params } = e.data;
  try {
    const img = { width, height, data: new Uint8ClampedArray(buffer) };
    const res = detectCandidates(img, ppm, roi, params || {}, p => self.postMessage({ progress: p }));
    self.postMessage({ result: res });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
