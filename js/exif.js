// Minimaler EXIF-Leser für JPEG: Aufnahmezeit, Hersteller, Modell, Ausrichtung

export function readExif(buf) {
  const v = new DataView(buf);
  const out = {};
  if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return out;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off); const len = v.getUint16(off + 2);
    if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
      parseTiff(v, off + 10, out);
      break;
    }
    if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
    off += 2 + len;
  }
  return out;
}

function parseTiff(v, start, out) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = o => v.getUint16(start + o, le), u32 = o => v.getUint32(start + o, le);
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = v.getUint8(start + o + i); if (!c) break; s += String.fromCharCode(c); } return s.trim(); };
  const readIfd = (o, cb) => {
    if (!o || start + o + 2 > v.byteLength) return;
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12; const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      const valOff = (type === 2 && cnt > 4) || (type !== 2 && type !== 3 && cnt > 1) ? u32(e + 8) : e + 8;
      cb(tag, type, cnt, valOff, e);
    }
  };
  let exifPtr = 0;
  readIfd(u32(4), (tag, type, cnt, vo, e) => {
    if (tag === 0x010F) out.make = str(vo, cnt);
    else if (tag === 0x0110) out.model = str(vo, cnt);
    else if (tag === 0x0112) out.orientation = u16(e + 8);
    else if (tag === 0x8769) exifPtr = u32(e + 8);
  });
  readIfd(exifPtr, (tag, type, cnt, vo) => {
    if (tag === 0x9003) out.dateTimeOriginal = str(vo, cnt);
  });
  if (out.dateTimeOriginal) {
    const m = out.dateTimeOriginal.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m) out.taken = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  out.device = [out.make, out.model].filter(Boolean).join(' ').replace(/^Apple (iPhone)/, '$1') || null;
}
