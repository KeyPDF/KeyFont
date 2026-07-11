'use strict';

// Shared font construction, subsetting, and export engine.
// UI state and interaction handlers remain in keyfont-ui.js.

function sanitizePostScriptName(name, fallback) {
  const src = String(name || '').trim();
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/[A-Za-z0-9_.-]/.test(ch)) out += ch;
  }
  if (!out) out = fallback || 'Glyph';
  if (!/[A-Za-z_.]/.test(out[0])) out = 'g' + out;
  return out;
}

function ttfContoursToQuadraticPath(contours) {
  const path = [];
  if (!Array.isArray(contours)) return path;

  for (const pts of contours) {
    if (!pts || !pts.length) continue;
    const n = pts.length;

    let si = 0;
    for (let i = 0; i < n; i++) {
      if (pts[i].on) { si = i; break; }
    }

    const p0 = pts[si];
    const start = p0.on
      ? { x: p0.x, y: p0.y }
      : {
          x: (p0.x + pts[(si - 1 + n) % n].x) / 2,
          y: (p0.y + pts[(si - 1 + n) % n].y) / 2
        };
    path.push({ cmd: 'M', x: start.x, y: start.y });

    const loopStart = p0.on ? 1 : 0;
    const loopEnd = p0.on ? n : n - 1;
    for (let i = loopStart; i <= loopEnd; i++) {
      const cur = pts[(si + i) % n];
      const prv = pts[(si + i - 1 + n) % n];

      if (cur.on) {
        if (prv.on) {
          path.push({ cmd: 'L', x: cur.x, y: cur.y });
        } else {
          path.push({ cmd: 'Q', x1: prv.x, y1: prv.y, x: cur.x, y: cur.y });
        }
      } else {
        const nxt = pts[(si + i + 1) % n];
        if (!nxt.on) {
          path.push({
            cmd: 'Q',
            x1: cur.x, y1: cur.y,
            x: (cur.x + nxt.x) / 2,
            y: (cur.y + nxt.y) / 2
          });
        }
      }
    }

    path.push({ cmd: 'Z' });
  }

  return path;
}

function pathToCubic(path) {
  const out = [];
  let cx = 0, cy = 0;
  for (const s of (path || [])) {
    if (s.cmd === 'M') {
      cx = s.x; cy = s.y;
      out.push({ cmd: 'M', x: cx, y: cy });
    } else if (s.cmd === 'L') {
      cx = s.x; cy = s.y;
      out.push({ cmd: 'L', x: cx, y: cy });
    } else if (s.cmd === 'Q') {
      const x0 = cx, y0 = cy;
      const x1 = s.x1, y1 = s.y1;
      const x2 = s.x, y2 = s.y;
      const c1x = x0 + (2 / 3) * (x1 - x0);
      const c1y = y0 + (2 / 3) * (y1 - y0);
      const c2x = x2 + (2 / 3) * (x1 - x2);
      const c2y = y2 + (2 / 3) * (y1 - y2);
      out.push({ cmd: 'C', x1: c1x, y1: c1y, x2: c2x, y2: c2y, x3: x2, y3: y2 });
      cx = x2; cy = y2;
    } else if (s.cmd === 'C') {
      out.push({ cmd: 'C', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, x3: s.x3, y3: s.y3 });
      cx = s.x3; cy = s.y3;
    } else if (s.cmd === 'Z') {
      out.push({ cmd: 'Z' });
    }
  }
  return out;
}

function scaleCubicPath(path, scale) {
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < 1e-9) return path.map(s => ({ ...s }));
  const out = [];
  for (const s of (path || [])) {
    if (s.cmd === 'M' || s.cmd === 'L') out.push({ cmd: s.cmd, x: s.x * scale, y: s.y * scale });
    else if (s.cmd === 'C') out.push({
      cmd: 'C',
      x1: s.x1 * scale, y1: s.y1 * scale,
      x2: s.x2 * scale, y2: s.y2 * scale,
      x3: s.x3 * scale, y3: s.y3 * scale
    });
    else if (s.cmd === 'Z') out.push({ cmd: 'Z' });
  }
  return out;
}

function computePathBounds(path) {
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  const update = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  };
  for (const s of (path || [])) {
    if (s.cmd === 'M' || s.cmd === 'L') update(s.x, s.y);
    else if (s.cmd === 'C') {
      update(s.x1, s.y1); update(s.x2, s.y2); update(s.x3, s.y3);
    }
  }
  if (!isFinite(xMin)) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  return { xMin, yMin, xMax, yMax };
}

function encodeType1CsNumber(n) {
  // Prefer Type1 short/int16 encodings for widest compatibility.
  n = clampInt16(n);
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) { const b = n - 108; return [Math.floor(b / 256) + 247, b % 256]; }
  if (n >= -1131 && n <= -108) { const m = -n - 108; return [Math.floor(m / 256) + 251, m % 256]; }
  if (n >= -32768 && n <= 32767) return [28, (n >> 8) & 0xFF, n & 0xFF];
  return [28, 0, 0];
}

function encodeType2CsNumber(n) {
  n = Math.round(n);
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) { const b = n - 108; return [Math.floor(b / 256) + 247, b % 256]; }
  if (n >= -1131 && n <= -108) { const m = -n - 108; return [Math.floor(m / 256) + 251, m % 256]; }
  if (n >= -32768 && n <= 32767) return [28, (n >> 8) & 0xFF, n & 0xFF];
  const fixed = n * 65536;
  return [255, (fixed >> 24) & 0xFF, (fixed >> 16) & 0xFF, (fixed >> 8) & 0xFF, fixed & 0xFF];
}

function buildType1CharStringFromCubicPath(path, advanceWidth) {
  const bytes = [];
  const pushNum = (n) => { bytes.push(...encodeType1CsNumber(n)); };
  const pushOp = (op) => { bytes.push(op & 0xFF); };

  pushNum(0); // sidebearing x
  pushNum(Math.round(advanceWidth || 0));
  pushOp(13); // hsbw

  // All coordinates rounded to integer independently, deltas computed
  // in integer space to prevent accumulated rounding drift.
  let ax = 0, ay = 0; // current integer position
  let spx = 0, spy = 0; // subpath start (integer)
  let started = false;
  const segments = path || [];
  const firstMove = segments.find(s => s.cmd === 'M');
  if (firstMove) {
    const ix = Math.round(firstMove.x), iy = Math.round(firstMove.y);
    const dx = ix - ax, dy = iy - ay;
    pushNum(dx); pushNum(dy);
    pushOp(21); // rmoveto
    ax = ix; ay = iy;
    spx = ax; spy = ay;
    started = true;
  }

  for (const s of segments) {
    if (s.cmd === 'M') {
      if (!started) continue;
      const ix = Math.round(s.x), iy = Math.round(s.y);
      const dx = ix - ax, dy = iy - ay;
      if (dx !== 0 || dy !== 0) {
        pushNum(dx); pushNum(dy); pushOp(21); // rmoveto
        ax = ix; ay = iy;
      }
      spx = ax; spy = ay;
    } else if (s.cmd === 'L') {
      const ix = Math.round(s.x), iy = Math.round(s.y);
      const dx = ix - ax, dy = iy - ay;
      if (dx !== 0 || dy !== 0) {
        pushNum(dx); pushNum(dy); pushOp(5); // rlineto
        ax = ix; ay = iy;
      }
    } else if (s.cmd === 'C') {
      const ix1 = Math.round(s.x1), iy1 = Math.round(s.y1);
      const ix2 = Math.round(s.x2), iy2 = Math.round(s.y2);
      const ix3 = Math.round(s.x3), iy3 = Math.round(s.y3);
      pushNum(ix1 - ax); pushNum(iy1 - ay);
      pushNum(ix2 - ix1); pushNum(iy2 - iy1);
      pushNum(ix3 - ix2); pushNum(iy3 - iy2);
      pushOp(8); // rrcurveto
      ax = ix3; ay = iy3;
    } else if (s.cmd === 'Z') {
      const cdx = spx - ax, cdy = spy - ay;
      if (cdx !== 0 || cdy !== 0) {
        pushNum(cdx); pushNum(cdy); pushOp(5); // rlineto
        ax = spx; ay = spy;
      }
      pushOp(9); // closepath
    }
  }

  pushOp(14); // endchar
  return new Uint8Array(bytes);
}

function buildType2CharStringFromCubicPath(path, advanceWidth) {
  const bytes = [];
  const pushNum = (n) => { bytes.push(...encodeType2CsNumber(n)); };
  const pushOp = (op) => { bytes.push(op & 0xFF); };
  const segments = path || [];
  let cx = 0, cy = 0;

  const firstMove = segments.find(s => s.cmd === 'M');
  if (firstMove) {
    pushNum(Math.round(advanceWidth || 0)); // width
    pushNum(Math.round(firstMove.x - cx));
    pushNum(Math.round(firstMove.y - cy));
    pushOp(21); // rmoveto
    cx = firstMove.x; cy = firstMove.y;
  } else {
    pushNum(Math.round(advanceWidth || 0)); // width
    pushNum(0);
    pushOp(22); // hmoveto
  }

  let skippedFirstMove = false;
  for (const s of segments) {
    if (s.cmd === 'M') {
      if (!skippedFirstMove) { skippedFirstMove = true; continue; }
      const dx = Math.round(s.x - cx), dy = Math.round(s.y - cy);
      if (dx !== 0 || dy !== 0) {
        pushNum(dx); pushNum(dy); pushOp(21); // rmoveto
      }
      cx = s.x; cy = s.y;
    } else if (s.cmd === 'L') {
      const dx = Math.round(s.x - cx), dy = Math.round(s.y - cy);
      if (dx !== 0 || dy !== 0) {
        pushNum(dx); pushNum(dy); pushOp(5); // rlineto
      }
      cx = s.x; cy = s.y;
    } else if (s.cmd === 'C') {
      const dx1 = Math.round(s.x1 - cx), dy1 = Math.round(s.y1 - cy);
      const dx2 = Math.round(s.x2 - s.x1), dy2 = Math.round(s.y2 - s.y1);
      const dx3 = Math.round(s.x3 - s.x2), dy3 = Math.round(s.y3 - s.y2);
      pushNum(dx1); pushNum(dy1);
      pushNum(dx2); pushNum(dy2);
      pushNum(dx3); pushNum(dy3);
      pushOp(8); // rrcurveto
      cx = s.x3; cy = s.y3;
    }
  }

  pushOp(14); // endchar
  return new Uint8Array(bytes);
}

function buildGlyphRecordsFromKeepIds(keepIds) {
  const sourceUnits = (state.ttf && state.ttf.unitsPerEm) ||
    (state.type1Font && state.type1Font.unitsPerEm) ||
    (state.cffFont && state.cffFont.unitsPerEm) ||
    (state.svgFont && state.svgFont.unitsPerEm) || 1000;
  const scale = 1000 / (sourceUnits || 1000);

  const selected = state.glyphs
    .filter(g => keepIds.has(g.id))
    .sort((a, b) => a.id - b.id);

  const usedNames = new Set();
  const ensureUnique = (name) => {
    let n = sanitizePostScriptName(name, 'glyph');
    if (n === '.notdef') n = 'notdef';
    if (!usedNames.has(n)) { usedNames.add(n); return n; }
    let i = 1;
    while (usedNames.has(`${n}_${i}`)) i++;
    const out = `${n}_${i}`;
    usedNames.add(out);
    return out;
  };

  const records = [];
  const cmapPairs = [];
  let hasNotdef = false;

  for (const g of selected) {
    let path = [];
    let adv = 0;
    if (state.fontType === 'ttf') {
      const t = state.ttf.loadGlyph(g.id);
      adv = t && Number.isFinite(t.advanceWidth) ? t.advanceWidth : 0;
      path = pathToCubic(ttfContoursToQuadraticPath((t && t.contours) || []));
    } else if (state.fontType === 'otf-cff' || state.fontType === 'cff') {
      const c = state.cffFont.loadGlyphByIndex(g.id);
      adv = c && c.metrics && Number.isFinite(c.metrics.advanceWidth) ? c.metrics.advanceWidth : 0;
      path = pathToCubic((c && c.path) || []);
    } else if (state.fontType === 'type1') {
      const t1 = state.type1Font.loadGlyphByName(g.name);
      adv = t1 && t1.metrics && Number.isFinite(t1.metrics.advanceWidth) ? t1.metrics.advanceWidth : 0;
      path = pathToCubic((t1 && t1.path) || []);
    } else if (state.fontType === 'svg') {
      const svgGlyph = state.svgFont && state.svgFont.glyphs ? state.svgFont.glyphs[g.id] : null;
      adv = svgGlyph && Number.isFinite(svgGlyph.advanceWidth) ? svgGlyph.advanceWidth : 0;
      path = svgGlyph && Array.isArray(svgGlyph.path)
        ? svgGlyph.path.map(seg => window.SVGFontUtils && window.SVGFontUtils.cloneSegment ? window.SVGFontUtils.cloneSegment(seg) : ({ ...seg }))
        : [];
    }

    const scaledPath = scaleCubicPath(path, scale);
    const scaledAdv = Math.round((adv || 0) * scale);

    const isNotdef = g.id === 0 || g.name === '.notdef' || records.length === 0;
    const glyphName = isNotdef ? '.notdef' : ensureUnique(g.name || `g${g.id}`);
    if (glyphName === '.notdef') hasNotdef = true;
    records.push({ name: glyphName, unicode: g.unicode, path: scaledPath, advanceWidth: scaledAdv });
  }

  if (!hasNotdef) {
    records.unshift({ name: '.notdef', unicode: null, path: [], advanceWidth: 500 });
  } else {
    const idx = records.findIndex(r => r.name === '.notdef');
    if (idx > 0) {
      const nd = records.splice(idx, 1)[0];
      records.unshift(nd);
    }
  }

  for (let gid = 1; gid < records.length; gid++) {
    const cp = records[gid].unicode;
    if (Number.isInteger(cp) && cp >= 1 && cp <= 0x10FFFF && (cp < 0xD800 || cp > 0xDFFF)) {
      cmapPairs.push({ cp, gid });
    }
  }

  return { records, cmapPairs };
}

function buildNameTableMinimal(familyName, postScriptName) {
  const fam = familyName || 'SubsetFont';
  const ps = sanitizePostScriptName(postScriptName || fam, 'SubsetFontPS');
  const style = 'Regular';
  const full = `${fam} ${style}`.trim();

  const names = [
    { nameID: 1, text: fam },
    { nameID: 2, text: style },
    { nameID: 4, text: full },
    { nameID: 6, text: ps }
  ];
  // Preserve license metadata if available. According to the OpenType spec,
  // nameID 13 stores the license description and nameID 14 stores the
  // license URL. When subset fonts are generated these fields would
  // otherwise be dropped, so we explicitly include them from the
  // current state if present.
  try {
    if (typeof state !== 'undefined' && state.metadata) {
      const lic = state.metadata.license;
      const licUrl = state.metadata.licenseUrl;
      if (lic && lic.trim()) names.push({ nameID: 13, text: lic.trim() });
      if (licUrl && licUrl.trim()) names.push({ nameID: 14, text: licUrl.trim() });
    }
  } catch (_) {
    /* no state available */
  }

  const toUtf16BE = (str) => {
    const out = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out[i * 2] = (c >> 8) & 0xFF;
      out[i * 2 + 1] = c & 0xFF;
    }
    return out;
  };

  const records = names.map(n => ({ ...n, bytes: toUtf16BE(n.text) }));
  const count = records.length;
  const headerSize = 6;
  const recSize = 12;
  const stringOffset = headerSize + count * recSize;
  const stringsLen = records.reduce((s, r) => s + r.bytes.length, 0);
  const out = new Uint8Array(stringOffset + stringsLen);
  const dv = new DataView(out.buffer);

  dv.setUint16(0, 0, false); // format
  dv.setUint16(2, count, false);
  dv.setUint16(4, stringOffset, false);

  let recOff = 6;
  let strOff = 0;
  for (const r of records) {
    dv.setUint16(recOff + 0, 3, false);        // Windows
    dv.setUint16(recOff + 2, 1, false);        // Unicode BMP
    dv.setUint16(recOff + 4, 0x0409, false);   // en-US
    dv.setUint16(recOff + 6, r.nameID, false);
    dv.setUint16(recOff + 8, r.bytes.length, false);
    dv.setUint16(recOff + 10, strOff, false);
    out.set(r.bytes, stringOffset + strOff);
    strOff += r.bytes.length;
    recOff += 12;
  }

  return out;
}

function buildHeadTableForCFF(xMin, yMin, xMax, yMax, unitsPerEm) {
  const out = new Uint8Array(54);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000, false); // version
  dv.setUint32(4, 0x00010000, false); // fontRevision
  dv.setUint32(8, 0, false);          // checkSumAdjustment
  dv.setUint32(12, 0x5F0F3CF5, false);// magicNumber
  dv.setUint16(16, 0, false);         // flags
  dv.setUint16(18, unitsPerEm, false);
  dv.setUint32(20, 0, false); dv.setUint32(24, 0, false); // created
  dv.setUint32(28, 0, false); dv.setUint32(32, 0, false); // modified
  dv.setInt16(36, Math.round(xMin), false);
  dv.setInt16(38, Math.round(yMin), false);
  dv.setInt16(40, Math.round(xMax), false);
  dv.setInt16(42, Math.round(yMax), false);
  dv.setUint16(44, 0, false);         // macStyle
  dv.setUint16(46, 8, false);         // lowestRecPPEM
  dv.setInt16(48, 2, false);          // fontDirectionHint
  dv.setInt16(50, 0, false);          // indexToLocFormat
  dv.setInt16(52, 0, false);          // glyphDataFormat
  return out;
}

function buildHheaTableForCFF(metrics, yMin, yMax) {
  const out = new Uint8Array(36);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000, false); // version
  dv.setInt16(4, Math.round(yMax), false); // ascender
  dv.setInt16(6, Math.round(yMin), false); // descender
  dv.setInt16(8, 0, false); // lineGap

  let advMax = 0;
  let minLSB = 0;
  let minRSB = 0;
  let xMaxExtent = 0;
  if (metrics.length) {
    advMax = Math.max(...metrics.map(m => m.advanceWidth));
    minLSB = Math.min(...metrics.map(m => m.lsb));
    minRSB = Math.min(...metrics.map(m => m.rsb));
    xMaxExtent = Math.max(...metrics.map(m => m.xMaxExtent));
  }
  dv.setUint16(10, advMax >>> 0, false);
  dv.setInt16(12, minLSB, false);
  dv.setInt16(14, minRSB, false);
  dv.setInt16(16, xMaxExtent, false);
  dv.setInt16(18, 1, false); // caretSlopeRise
  dv.setInt16(20, 0, false); // caretSlopeRun
  dv.setInt16(22, 0, false); // caretOffset
  dv.setInt16(24, 0, false);
  dv.setInt16(26, 0, false);
  dv.setInt16(28, 0, false);
  dv.setInt16(30, 0, false);
  dv.setInt16(32, 0, false); // metricDataFormat
  dv.setUint16(34, metrics.length, false); // numberOfHMetrics
  return out;
}

function buildMaxpTableForCFF(numGlyphs) {
  const out = new Uint8Array(6);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00005000, false); // version 0.5 for CFF
  dv.setUint16(4, numGlyphs, false);
  return out;
}

function buildPostTableV3() {
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00030000, false); // format 3.0
  return out;
}

function buildHmtxFromMetrics(metrics) {
  const out = new Uint8Array(metrics.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < metrics.length; i++) {
    dv.setUint16(i * 4, metrics[i].advanceWidth >>> 0, false);
    dv.setInt16(i * 4 + 2, metrics[i].lsb, false);
  }
  return out;
}

function buildCmapTableFromPairs(cmapPairs) {
  const byCp = new Map();
  for (const p of cmapPairs || []) {
    if (!byCp.has(p.cp)) byCp.set(p.cp, p.gid);
  }
  const pairsAll = [];
  const pairsBMP = [];
  for (const [cp, gid] of byCp.entries()) {
    if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10FFFF) continue;
    if (!Number.isInteger(gid) || gid <= 0) continue;
    const pair = { cp, gid };
    pairsAll.push(pair);
    if (cp <= 0xFFFF && cp !== 0xFFFF) pairsBMP.push(pair);
  }
  const format4 = buildCmap4Subtable(pairsBMP);
  const format12 = buildCmap12Subtable(pairsAll);
  return buildCmapWithSubtables(format4, format12);
}

function buildCFFFromGlyphRecords(records, postScriptName) {
  const fontName = sanitizePostScriptName(postScriptName || 'SubsetFontPS', 'SubsetFontPS');
  const enc = new TextEncoder();

  const standardStrings = (globalThis.__CFF_TABLES && globalThis.__CFF_TABLES.STANDARD_STRINGS) || [];
  const sidByName = new Map();
  for (let i = 0; i < standardStrings.length; i++) {
    if (!sidByName.has(standardStrings[i])) sidByName.set(standardStrings[i], i);
  }
  const customStrings = [];
  const customSidByName = new Map();
  const sidFor = (name) => {
    const n = String(name || '.notdef');
    if (sidByName.has(n)) return sidByName.get(n);
    if (customSidByName.has(n)) return customSidByName.get(n);
    const sid = standardStrings.length + customStrings.length;
    customSidByName.set(n, sid);
    customStrings.push(n);
    return sid;
  };

  const usedGlyphNames = new Set(['.notdef']);
  const glyphNames = records.map((r, i) => {
    if (i === 0) return '.notdef';
    const base = sanitizePostScriptName(r.name || `g${i}`, `g${i}`);
    if (!usedGlyphNames.has(base)) {
      usedGlyphNames.add(base);
      return base;
    }
    let k = 1;
    while (usedGlyphNames.has(`${base}_${k}`)) k++;
    const uniq = `${base}_${k}`;
    usedGlyphNames.add(uniq);
    return uniq;
  });
  const charsetSids = glyphNames.slice(1).map(sidFor);
  const charset = cffBuildCharset0(charsetSids);

  const charStrings = records.map(r => buildType2CharStringFromCubicPath(r.path, r.advanceWidth));
  const charStringsIndex = cffBuildIndex(charStrings);
  const stringIndex = cffBuildIndex(customStrings.map(s => enc.encode(s)));
  const globalSubrs = new Uint8Array([0, 0]);
  const privateDict = new Uint8Array([139, 20, 139, 21]); // defaultWidthX=0, nominalWidthX=0

  const header = new Uint8Array([1, 0, 4, 4]);
  const nameIndex = cffBuildIndex([enc.encode(fontName)]);

  const buildTopDict = (charsetOff, charStringsOff, privateOff) => {
    const parts = [];
    parts.push(...cffEncode5(charsetOff), 15);     // charset
    parts.push(...cffEncodeNumber(0), 16);         // StandardEncoding
    parts.push(...cffEncode5(charStringsOff), 17); // CharStrings
    parts.push(...cffEncode5(privateDict.length), ...cffEncode5(privateOff), 18); // Private
    return new Uint8Array(parts);
  };

  // Two-pass because Top DICT offset fields point to absolute CFF offsets.
  let topDictIndex = cffBuildIndex([buildTopDict(0, 0, 0)]);
  let base = header.length + nameIndex.length + topDictIndex.length + stringIndex.length + globalSubrs.length;
  const charsetOff = base;
  const charStringsOff = charsetOff + charset.length;
  const privateOff = charStringsOff + charStringsIndex.length;
  topDictIndex = cffBuildIndex([buildTopDict(charsetOff, charStringsOff, privateOff)]);

  base = header.length + nameIndex.length + topDictIndex.length + stringIndex.length + globalSubrs.length;
  const charsetOff2 = base;
  const charStringsOff2 = charsetOff2 + charset.length;
  const privateOff2 = charStringsOff2 + charStringsIndex.length;
  if (charsetOff2 !== charsetOff || charStringsOff2 !== charStringsOff || privateOff2 !== privateOff) {
    topDictIndex = cffBuildIndex([buildTopDict(charsetOff2, charStringsOff2, privateOff2)]);
  }

  const total = header.length + nameIndex.length + topDictIndex.length + stringIndex.length +
    globalSubrs.length + charset.length + charStringsIndex.length + privateDict.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(header, off); off += header.length;
  out.set(nameIndex, off); off += nameIndex.length;
  out.set(topDictIndex, off); off += topDictIndex.length;
  out.set(stringIndex, off); off += stringIndex.length;
  out.set(globalSubrs, off); off += globalSubrs.length;
  out.set(charset, off); off += charset.length;
  out.set(charStringsIndex, off); off += charStringsIndex.length;
  out.set(privateDict, off);
  return out;
}

function buildOTFCFFFromGlyphRecords(records, cmapPairs, familyName, postScriptName) {
  const metrics = [];
  let gxMin = Infinity, gyMin = Infinity, gxMax = -Infinity, gyMax = -Infinity;
  for (const r of records) {
    const b = computePathBounds(r.path);
    const xMin = Math.floor(b.xMin), yMin = Math.floor(b.yMin);
    const xMax = Math.ceil(b.xMax), yMax = Math.ceil(b.yMax);
    if (xMin < gxMin) gxMin = xMin;
    if (yMin < gyMin) gyMin = yMin;
    if (xMax > gxMax) gxMax = xMax;
    if (yMax > gyMax) gyMax = yMax;
    const adv = Math.max(0, Math.round(r.advanceWidth || 0));
    const lsb = Number.isFinite(xMin) ? xMin : 0;
    const rsb = adv - lsb - (Number.isFinite(xMax) && Number.isFinite(xMin) ? (xMax - xMin) : 0);
    metrics.push({ advanceWidth: adv, lsb, rsb, xMaxExtent: lsb + (Number.isFinite(xMax) ? xMax - xMin : 0) });
  }
  if (!isFinite(gxMin)) { gxMin = 0; gyMin = 0; gxMax = 0; gyMax = 0; }

  const cff = buildCFFFromGlyphRecords(records, postScriptName);
  const tables = {
    'CFF ': cff,
    head: buildHeadTableForCFF(gxMin, gyMin, gxMax, gyMax, 1000),
    hhea: buildHheaTableForCFF(metrics, gyMin, gyMax),
    maxp: buildMaxpTableForCFF(records.length),
    'OS/2': buildOS2TableForTTF(metrics, cmapPairs, gyMin, gyMax),
    hmtx: buildHmtxFromMetrics(metrics),
    cmap: buildCmapTableFromPairs(cmapPairs),
    name: buildNameTableMinimal(familyName, postScriptName),
    post: buildPostTableV3()
  };
  return assembleFontFile(tables, true);
}

function buildType1FromGlyphRecords(records, familyName, postScriptName, metadata) {
  const psName = sanitizePostScriptName(postScriptName || familyName || 'SubsetFontPS', 'SubsetFontPS');
  const fam = String(familyName || 'SubsetFont');
  const enc = new TextEncoder();
  const meta = metadata || {};

  // Adobe Standard Encoding: slot → name, and unicode → standard name
  const _aseSlot = {
    32:'space',33:'exclam',34:'quotedbl',35:'numbersign',36:'dollar',37:'percent',
    38:'ampersand',39:'quoteright',40:'parenleft',41:'parenright',42:'asterisk',
    43:'plus',44:'comma',45:'hyphen',46:'period',47:'slash',
    48:'zero',49:'one',50:'two',51:'three',52:'four',53:'five',54:'six',55:'seven',
    56:'eight',57:'nine',58:'colon',59:'semicolon',60:'less',61:'equal',62:'greater',
    63:'question',64:'at',
    65:'A',66:'B',67:'C',68:'D',69:'E',70:'F',71:'G',72:'H',73:'I',74:'J',75:'K',
    76:'L',77:'M',78:'N',79:'O',80:'P',81:'Q',82:'R',83:'S',84:'T',85:'U',86:'V',
    87:'W',88:'X',89:'Y',90:'Z',
    91:'bracketleft',92:'backslash',93:'bracketright',94:'asciicircum',95:'underscore',
    96:'quoteleft',
    97:'a',98:'b',99:'c',100:'d',101:'e',102:'f',103:'g',104:'h',105:'i',106:'j',
    107:'k',108:'l',109:'m',110:'n',111:'o',112:'p',113:'q',114:'r',115:'s',116:'t',
    117:'u',118:'v',119:'w',120:'x',121:'y',122:'z',
    123:'braceleft',124:'bar',125:'braceright',126:'asciitilde',
    161:'exclamdown',162:'cent',163:'sterling',164:'fraction',165:'yen',166:'florin',
    167:'section',168:'currency',169:'quotesingle',170:'quotedblleft',
    171:'guillemotleft',172:'guilsinglleft',173:'guilsinglright',174:'fi',175:'fl',
    177:'endash',178:'dagger',179:'daggerdbl',180:'periodcentered',
    182:'paragraph',183:'bullet',184:'quotesinglbase',185:'quotedblbase',
    186:'quotedblright',187:'guillemotright',188:'ellipsis',189:'perthousand',
    191:'questiondown',
    193:'grave',194:'acute',195:'circumflex',196:'tilde',197:'macron',198:'breve',
    199:'dotaccent',200:'dieresis',202:'ring',203:'cedilla',
    205:'hungarumlaut',206:'ogonek',207:'caron',208:'emdash',
    225:'AE',227:'ordfeminine',232:'Lslash',233:'Oslash',234:'OE',235:'ordmasculine',
    241:'ae',245:'dotlessi',248:'lslash',249:'oslash',250:'oe',251:'germandbls'
  };
  // Unicode → ASE standard glyph name (for renaming charstrings)
  const _aseFromUnicode = {
    0x20:'space',0x21:'exclam',0x22:'quotedbl',0x23:'numbersign',0x24:'dollar',
    0x25:'percent',0x26:'ampersand',0x2019:'quoteright',0x28:'parenleft',
    0x29:'parenright',0x2A:'asterisk',0x2B:'plus',0x2C:'comma',0x2D:'hyphen',
    0x2E:'period',0x2F:'slash',0x30:'zero',0x31:'one',0x32:'two',0x33:'three',
    0x34:'four',0x35:'five',0x36:'six',0x37:'seven',0x38:'eight',0x39:'nine',
    0x3A:'colon',0x3B:'semicolon',0x3C:'less',0x3D:'equal',0x3E:'greater',
    0x3F:'question',0x40:'at',
    0x41:'A',0x42:'B',0x43:'C',0x44:'D',0x45:'E',0x46:'F',0x47:'G',0x48:'H',
    0x49:'I',0x4A:'J',0x4B:'K',0x4C:'L',0x4D:'M',0x4E:'N',0x4F:'O',0x50:'P',
    0x51:'Q',0x52:'R',0x53:'S',0x54:'T',0x55:'U',0x56:'V',0x57:'W',0x58:'X',
    0x59:'Y',0x5A:'Z',
    0x5B:'bracketleft',0x5C:'backslash',0x5D:'bracketright',0x5E:'asciicircum',
    0x5F:'underscore',0x2018:'quoteleft',
    0x61:'a',0x62:'b',0x63:'c',0x64:'d',0x65:'e',0x66:'f',0x67:'g',0x68:'h',
    0x69:'i',0x6A:'j',0x6B:'k',0x6C:'l',0x6D:'m',0x6E:'n',0x6F:'o',0x70:'p',
    0x71:'q',0x72:'r',0x73:'s',0x74:'t',0x75:'u',0x76:'v',0x77:'w',0x78:'x',
    0x79:'y',0x7A:'z',
    0x7B:'braceleft',0x7C:'bar',0x7D:'braceright',0x7E:'asciitilde',
    0xA1:'exclamdown',0xA2:'cent',0xA3:'sterling',0x2044:'fraction',0xA5:'yen',
    0x192:'florin',0xA7:'section',0xA4:'currency',0x27:'quotesingle',
    0x201C:'quotedblleft',0xAB:'guillemotleft',0x2039:'guilsinglleft',
    0x203A:'guilsinglright',0xFB01:'fi',0xFB02:'fl',
    0x2013:'endash',0x2020:'dagger',0x2021:'daggerdbl',0xB7:'periodcentered',
    0xB6:'paragraph',0x2022:'bullet',0x201A:'quotesinglbase',0x201E:'quotedblbase',
    0x201D:'quotedblright',0xBB:'guillemotright',0x2026:'ellipsis',0x2030:'perthousand',
    0xBF:'questiondown',
    0x60:'grave',0xB4:'acute',0x2C6:'circumflex',0x2DC:'tilde',0xAF:'macron',
    0x2D8:'breve',0x2D9:'dotaccent',0xA8:'dieresis',0x2DA:'ring',0xB8:'cedilla',
    0x2DD:'hungarumlaut',0x2DB:'ogonek',0x2C7:'caron',0x2014:'emdash',
    0xC6:'AE',0xAA:'ordfeminine',0x141:'Lslash',0xD8:'Oslash',0x152:'OE',
    0xBA:'ordmasculine',0xE6:'ae',0x131:'dotlessi',0x142:'lslash',0xF8:'oslash',
    0x153:'oe',0xDF:'germandbls'
  };
  // Reverse: name → slot
  const _aseNameToSlot = {};
  for (const [s, n] of Object.entries(_aseSlot)) _aseNameToSlot[n] = Number(s);

  // Build charstring map, renaming glyphs to ASE standard names where possible
  const csMap = new Map();
  const usedCSNames = new Set();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    let name;
    if (i === 0) {
      name = '.notdef';
    } else {
      // Prefer Adobe Standard name based on unicode
      const stdName = r.unicode != null ? _aseFromUnicode[r.unicode] : undefined;
      name = (stdName && !usedCSNames.has(stdName)) ? stdName : (r.name || `g${i}`);
    }
    if (usedCSNames.has(name)) name = r.name || `g${i}`;
    usedCSNames.add(name);
    csMap.set(name, buildType1CharStringFromCubicPath(r.path, r.advanceWidth));
  }
  if (!csMap.has('.notdef')) csMap.set('.notdef', new Uint8Array([139, 139, 13, 14]));

  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const r of records) {
    const b = computePathBounds(r.path);
    if (b.xMin < xMin) xMin = b.xMin;
    if (b.yMin < yMin) yMin = b.yMin;
    if (b.xMax > xMax) xMax = b.xMax;
    if (b.yMax > yMax) yMax = b.yMax;
  }
  if (!isFinite(xMin)) { xMin = 0; yMin = 0; xMax = 0; yMax = 0; }

  // Build encoding: place charstrings in their ASE slots
  const codeToName = new Array(256).fill('.notdef');
  const usedSlots = new Set();
  for (const csName of csMap.keys()) {
    if (csName === '.notdef') continue;
    const slot = _aseNameToSlot[csName];
    if (slot !== undefined && !usedSlots.has(slot)) {
      codeToName[slot] = csName;
      usedSlots.add(slot);
    }
  }
  // Non-ASE glyphs remain in CharStrings but are not encoded (keeps encoding standard)

  const keepNames = new Set(csMap.keys());
  const t1 = { lenIV: 4, subrs: new Map(), charStrings: csMap };
  const decrypted = buildType1EexecFromParsed(t1, keepNames);
  const eexec = eexecEncrypt(decrypted);
  const hex = bytesToHexLines(eexec, 64);

  let header = '';
  header += `%!PS-AdobeFont-1.0: ${psName} 1.0\n`;

  // Preserve license information as PostScript comments
  if (meta.license && meta.license.trim()) {
    const licenseLine = meta.license.trim().replace(/\r?\n/g, ' ');
    header += `%% License: ${licenseLine}\n`;
  }
  if (meta.licenseUrl && meta.licenseUrl.trim()) {
    header += `%% License URL: ${meta.licenseUrl.trim()}\n`;
  }
  if (meta.copyright && meta.copyright.trim()) {
    const copyrightLine = meta.copyright.trim().replace(/\r?\n/g, ' ');
    header += `%% Copyright: ${copyrightLine}\n`;
  }

  header += `11 dict begin\n`;
  header += `/FontName /${psName} def\n`;
  header += `/FontType 1 def\n`;
  header += `/PaintType 0 def\n`;
  header += `/StrokeWidth 0 def\n`;
  header += `/FontMatrix [0.001 0 0 0.001 0 0] readonly def\n`;
  header += `/FontBBox [${Math.floor(xMin)} ${Math.floor(yMin)} ${Math.ceil(xMax)} ${Math.ceil(yMax)}] readonly def\n`;
  // Check if any slot has a non-standard glyph name (not just missing)
  let hasNonStandard = false;
  for (let i = 0; i < 256; i++) {
    const cur = codeToName[i];
    if (cur === '.notdef') continue; // missing glyph = fine, leave standard slot as-is
    const std = _aseSlot[i] || '.notdef';
    if (cur !== std) { hasNonStandard = true; break; }
  }
  if (!hasNonStandard) {
    header += `/Encoding StandardEncoding def\n`;
  } else {
    header += `/Encoding StandardEncoding 256 array copy\n`;
    for (let code = 0; code < 256; code++) {
      const cur = codeToName[code];
      if (cur === '.notdef') continue; // don't override standard slots with .notdef
      const std = _aseSlot[code] || '.notdef';
      if (cur !== std) {
        const n = sanitizePostScriptName(cur, '.notdef');
        header += `dup ${code} /${n === 'notdef' ? '.notdef' : n} put\n`;
      }
    }
    header += `readonly def\n`;
  }
  header += `/FamilyName (${fam.replace(/[()]/g, '')}) def\n`;

  // Add Notice entry with license info if available
  if (meta.license && meta.license.trim()) {
    const notice = meta.license.trim().replace(/[()]/g, '').replace(/\r?\n/g, ' ').substring(0, 200);
    header += `/Notice (${notice}) def\n`;
  }

  header += `currentdict end\n`;
  header += `currentfile eexec\n`;

  const footer = '\n0000000000000000000000000000000000000000000000000000000000000000\ncleartomark\n';
  const headerBytes = enc.encode(header);
  const hexBytes = enc.encode(hex);
  const footerBytes = enc.encode(footer);
  const out = new Uint8Array(headerBytes.length + hexBytes.length + footerBytes.length);
  let off = 0;
  out.set(headerBytes, off); off += headerBytes.length;
  out.set(hexBytes, off); off += hexBytes.length;
  out.set(footerBytes, off);
  return out;
}

function clampInt16(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

function cubicPoint(x0, y0, x1, y1, x2, y2, x3, y3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return { x: a * x0 + b * x1 + c * x2 + d * x3, y: a * y0 + b * y1 + c * y2 + d * y3 };
}

function estimateCubicSegments(x0, y0, x1, y1, x2, y2, x3, y3) {
  const d = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  const poly = d(x0, y0, x1, y1) + d(x1, y1, x2, y2) + d(x2, y2, x3, y3);
  const chord = d(x0, y0, x3, y3);
  const curvature = Math.max(0, poly - chord);
  const seg = Math.ceil(poly / 90 + curvature / 60);
  return Math.max(2, Math.min(24, seg));
}

function cubicPathToTTFContours(path) {
  const contours = [];
  let current = null;
  let penX = 0, penY = 0;
  let startX = 0, startY = 0;

  const ensureContour = () => {
    if (!current) {
      current = [];
      current.push({ x: clampInt16(penX), y: clampInt16(penY), on: true });
      startX = penX;
      startY = penY;
    }
  };
  const pushPoint = (x, y) => {
    if (!current) current = [];
    const px = clampInt16(x), py = clampInt16(y);
    if (current.length) {
      const last = current[current.length - 1];
      if (last.x === px && last.y === py) return;
    }
    current.push({ x: px, y: py, on: true });
  };
  const finishContour = () => {
    if (!current || !current.length) { current = null; return; }
    if (current.length > 1) {
      const first = current[0];
      const last = current[current.length - 1];
      if (first.x === last.x && first.y === last.y) current.pop();
    }
    if (current.length === 1) {
      const p = current[0];
      current.push({ x: clampInt16(p.x + 1), y: p.y, on: true });
    }
    if (current.length >= 2) contours.push(current);
    current = null;
  };

  for (const s of (path || [])) {
    if (s.cmd === 'M') {
      finishContour();
      penX = s.x; penY = s.y;
      current = [];
      pushPoint(penX, penY);
      startX = penX; startY = penY;
    } else if (s.cmd === 'L') {
      ensureContour();
      penX = s.x; penY = s.y;
      pushPoint(penX, penY);
    } else if (s.cmd === 'C') {
      ensureContour();
      const x0 = penX, y0 = penY;
      const x1 = s.x1, y1 = s.y1, x2 = s.x2, y2 = s.y2, x3 = s.x3, y3 = s.y3;
      const segs = estimateCubicSegments(x0, y0, x1, y1, x2, y2, x3, y3);
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const p = cubicPoint(x0, y0, x1, y1, x2, y2, x3, y3, t);
        pushPoint(p.x, p.y);
      }
      penX = x3; penY = y3;
    } else if (s.cmd === 'Z') {
      if (current) {
        pushPoint(startX, startY);
        finishContour();
      }
      penX = startX; penY = startY;
    }
  }
  finishContour();
  return contours;
}

function buildSimpleTTFGlyph(contours) {
  const normContours = [];
  for (const c of (contours || [])) {
    if (!Array.isArray(c)) continue;
    const pts = c.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length >= 2) normContours.push(pts);
  }
  if (!normContours.length) {
    return {
      data: new Uint8Array(0),
      pointCount: 0,
      contourCount: 0,
      xMin: 0, yMin: 0, xMax: 0, yMax: 0
    };
  }

  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  const points = [];
  const endPts = [];
  for (const c of normContours) {
    for (const p of c) {
      const x = clampInt16(p.x);
      const y = clampInt16(p.y);
      points.push({ x, y, on: true });
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    endPts.push(points.length - 1);
  }

  const flags = [];
  const xData = [];
  const yData = [];
  let prevX = 0, prevY = 0;

  const pushI16 = (arr, v) => {
    const n = clampInt16(v);
    arr.push((n >> 8) & 0xFF, n & 0xFF);
  };

  for (const p of points) {
    let f = 0x01; // on-curve
    const dx = p.x - prevX;
    const dy = p.y - prevY;

    if (dx === 0) {
      f |= 0x10;
    } else if (dx > 0 && dx <= 255) {
      f |= 0x02 | 0x10;
      xData.push(dx & 0xFF);
    } else if (dx < 0 && dx >= -255) {
      f |= 0x02;
      xData.push((-dx) & 0xFF);
    } else {
      pushI16(xData, dx);
    }

    if (dy === 0) {
      f |= 0x20;
    } else if (dy > 0 && dy <= 255) {
      f |= 0x04 | 0x20;
      yData.push(dy & 0xFF);
    } else if (dy < 0 && dy >= -255) {
      f |= 0x04;
      yData.push((-dy) & 0xFF);
    } else {
      pushI16(yData, dy);
    }

    flags.push(f);
    prevX = p.x;
    prevY = p.y;
  }

  const size = 10 + endPts.length * 2 + 2 + flags.length + xData.length + yData.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setInt16(0, normContours.length, false);
  dv.setInt16(2, xMin, false);
  dv.setInt16(4, yMin, false);
  dv.setInt16(6, xMax, false);
  dv.setInt16(8, yMax, false);

  let off = 10;
  for (let i = 0; i < endPts.length; i++) {
    dv.setUint16(off, endPts[i], false);
    off += 2;
  }
  dv.setUint16(off, 0, false); // instructionLength
  off += 2;
  out.set(flags, off); off += flags.length;
  out.set(xData, off); off += xData.length;
  out.set(yData, off);

  return {
    data: out,
    pointCount: points.length,
    contourCount: normContours.length,
    xMin, yMin, xMax, yMax
  };
}

function buildHeadTableForTTF(xMin, yMin, xMax, yMax, unitsPerEm, indexToLocFormat) {
  const out = new Uint8Array(54);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000, false); // version
  dv.setUint32(4, 0x00010000, false); // fontRevision
  dv.setUint32(8, 0, false);          // checkSumAdjustment
  dv.setUint32(12, 0x5F0F3CF5, false);// magicNumber
  dv.setUint16(16, 0, false);         // flags
  dv.setUint16(18, unitsPerEm, false);
  dv.setUint32(20, 0, false); dv.setUint32(24, 0, false); // created
  dv.setUint32(28, 0, false); dv.setUint32(32, 0, false); // modified
  dv.setInt16(36, clampInt16(xMin), false);
  dv.setInt16(38, clampInt16(yMin), false);
  dv.setInt16(40, clampInt16(xMax), false);
  dv.setInt16(42, clampInt16(yMax), false);
  dv.setUint16(44, 0, false);         // macStyle
  dv.setUint16(46, 8, false);         // lowestRecPPEM
  dv.setInt16(48, 2, false);          // fontDirectionHint
  dv.setInt16(50, indexToLocFormat, false);
  dv.setInt16(52, 0, false);          // glyphDataFormat
  return out;
}

function buildMaxpTableForTTF(numGlyphs, maxPoints, maxContours) {
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000, false); // version 1.0
  dv.setUint16(4, numGlyphs, false);
  dv.setUint16(6, maxPoints, false);
  dv.setUint16(8, maxContours, false);
  dv.setUint16(10, 0, false); // maxCompositePoints
  dv.setUint16(12, 0, false); // maxCompositeContours
  dv.setUint16(14, 2, false); // maxZones
  dv.setUint16(16, 0, false); // maxTwilightPoints
  dv.setUint16(18, 0, false); // maxStorage
  dv.setUint16(20, 0, false); // maxFunctionDefs
  dv.setUint16(22, 0, false); // maxInstructionDefs
  dv.setUint16(24, 48, false); // maxStackElements
  dv.setUint16(26, 0, false); // maxSizeOfInstructions
  dv.setUint16(28, 0, false); // maxComponentElements
  dv.setUint16(30, 0, false); // maxComponentDepth
  return out;
}

function buildOS2TableForTTF(metrics, cmapPairs, yMin, yMax) {
  const out = new Uint8Array(78); // OS/2 version 0
  const dv = new DataView(out.buffer);
  const avgAdv = metrics.length
    ? Math.round(metrics.reduce((s, m) => s + (m.advanceWidth || 0), 0) / metrics.length)
    : 500;
  let firstChar = 0, lastChar = 0;
  const bmp = (cmapPairs || [])
    .map(p => p.cp)
    .filter(cp => Number.isInteger(cp) && cp >= 0 && cp <= 0xFFFF)
    .sort((a, b) => a - b);
  if (bmp.length) {
    firstChar = bmp[0];
    lastChar = bmp[bmp.length - 1];
  }

  dv.setUint16(0, 0, false); // version
  dv.setInt16(2, clampInt16(avgAdv), false); // xAvgCharWidth
  dv.setUint16(4, 400, false); // usWeightClass
  dv.setUint16(6, 5, false);   // usWidthClass
  dv.setUint16(8, 0, false);   // fsType
  dv.setInt16(10, 650, false); // ySubscriptXSize
  dv.setInt16(12, 699, false); // ySubscriptYSize
  dv.setInt16(14, 0, false);   // ySubscriptXOffset
  dv.setInt16(16, 140, false); // ySubscriptYOffset
  dv.setInt16(18, 650, false); // ySuperscriptXSize
  dv.setInt16(20, 699, false); // ySuperscriptYSize
  dv.setInt16(22, 0, false);   // ySuperscriptXOffset
  dv.setInt16(24, 479, false); // ySuperscriptYOffset
  dv.setInt16(26, 50, false);  // yStrikeoutSize
  dv.setInt16(28, 250, false); // yStrikeoutPosition
  dv.setInt16(30, 0, false);   // sFamilyClass
  // panose (10 bytes) defaults to 0
  dv.setUint32(42, 1, false);  // ulUnicodeRange1 (basic Latin)
  dv.setUint32(46, 0, false);
  dv.setUint32(50, 0, false);
  dv.setUint32(54, 0, false);
  out[58] = 0x47; out[59] = 0x50; out[60] = 0x54; out[61] = 0x35; // 'GPT5'
  dv.setUint16(62, 0x0040, false); // fsSelection REGULAR
  dv.setUint16(64, firstChar & 0xFFFF, false);
  dv.setUint16(66, lastChar & 0xFFFF, false);
  dv.setInt16(68, clampInt16(yMax), false); // sTypoAscender
  dv.setInt16(70, clampInt16(yMin), false); // sTypoDescender
  dv.setInt16(72, 0, false);                // sTypoLineGap
  dv.setUint16(74, Math.max(0, clampInt16(yMax)) & 0xFFFF, false); // usWinAscent
  dv.setUint16(76, Math.max(0, clampInt16(-yMin)) & 0xFFFF, false); // usWinDescent
  return out;
}

function buildTTFFromGlyphRecords(records, cmapPairs, familyName, postScriptName) {
  const glyphDatas = [];
  const offsets = [0];
  const metrics = [];
  let total = 0;
  let gxMin = Infinity, gyMin = Infinity, gxMax = -Infinity, gyMax = -Infinity;
  let maxPoints = 0, maxContours = 0;

  for (const r of records) {
    const contours = cubicPathToTTFContours(r.path);
    const g = buildSimpleTTFGlyph(contours);
    glyphDatas.push(g);

    const paddedLen = (g.data.length + 3) & ~3;
    total += paddedLen;
    offsets.push(total);

    const adv = Math.max(0, Math.round(r.advanceWidth || 0));
    const lsb = g.data.length ? g.xMin : 0;
    const rsb = g.data.length ? (adv - lsb - (g.xMax - g.xMin)) : 0;
    const xMaxExtent = g.data.length ? (lsb + (g.xMax - g.xMin)) : lsb;
    metrics.push({ advanceWidth: adv, lsb, rsb, xMaxExtent });

    if (g.data.length) {
      if (g.xMin < gxMin) gxMin = g.xMin;
      if (g.yMin < gyMin) gyMin = g.yMin;
      if (g.xMax > gxMax) gxMax = g.xMax;
      if (g.yMax > gyMax) gyMax = g.yMax;
    }
    if (g.pointCount > maxPoints) maxPoints = g.pointCount;
    if (g.contourCount > maxContours) maxContours = g.contourCount;
  }
  if (!isFinite(gxMin)) { gxMin = 0; gyMin = 0; gxMax = 0; gyMax = 0; }

  const glyfData = new Uint8Array(total);
  let off = 0;
  for (const g of glyphDatas) {
    if (g.data.length) glyfData.set(g.data, off);
    off += (g.data.length + 3) & ~3;
  }

  const useShortLoca = total <= 0x1FFFE;
  const indexToLocFormat = useShortLoca ? 0 : 1;
  const locaData = buildLocaTable(offsets, records.length, indexToLocFormat);

  const tables = {
    head: buildHeadTableForTTF(gxMin, gyMin, gxMax, gyMax, 1000, indexToLocFormat),
    hhea: buildHheaTableForCFF(metrics, gyMin, gyMax),
    maxp: buildMaxpTableForTTF(records.length, maxPoints, maxContours),
    'OS/2': buildOS2TableForTTF(metrics, cmapPairs, gyMin, gyMax),
    hmtx: buildHmtxFromMetrics(metrics),
    cmap: buildCmapTableFromPairs(cmapPairs),
    name: buildNameTableMinimal(familyName, postScriptName),
    post: buildPostTableV3(),
    glyf: glyfData,
    loca: locaData
  };

  return assembleFontFile(tables, false);
}

// ═══════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════

async function exportFont() {
  if (!state.glyphs.length) return;

  // Determine which glyph IDs to keep
  let keepIds;
  if (state.mode === 'keep') {
    keepIds = new Set(state.selected);
  } else {
    keepIds = new Set();
    for (const g of state.glyphs) {
      if (!state.selected.has(g.id)) keepIds.add(g.id);
    }
  }

  // Always keep glyph 0 / .notdef
  keepIds.add(state.glyphs[0]?.id ?? 0);

  try {
    let rebuilt, filename, mime;
    const base = state.file.name.replace(/\.[^.]+$/, '');
    const allowedFormats = window.KeyfontUI.getAvailableOutputFormats();
    const targetFormat = allowedFormats.includes(state.outputFormat)
      ? state.outputFormat
      : window.KeyfontUI.getDefaultOutputFormatForState();

    if (!targetFormat) {
      throw new Error('No export format available for this font');
    }

    if (targetFormat === 'ttf') {
      if (state.fontType === 'ttf') {
        rebuilt = rebuildTTF(state.buffer, keepIds);
      } else {
        const { records, cmapPairs } = buildGlyphRecordsFromKeepIds(keepIds);
        rebuilt = buildTTFFromGlyphRecords(
          records,
          cmapPairs,
          state.metadata.family || base,
          state.metadata.postScript || base
        );
      }
      filename = base + '.ttf'; mime = 'font/ttf';
    } else if (targetFormat === 'otf') {
      if (state.fontType === 'ttf') {
        // OpenType with TrueType outlines (sfnt flavor 0x00010000).
        rebuilt = rebuildTTF(state.buffer, keepIds);
      } else if (state.fontType === 'otf-cff') {
        rebuilt = rebuildOTF(state.buffer, state.ttf, keepIds);
      } else {
        const { records, cmapPairs } = buildGlyphRecordsFromKeepIds(keepIds);
        rebuilt = buildOTFCFFFromGlyphRecords(
          records,
          cmapPairs,
          state.metadata.family || base,
          state.metadata.postScript || base
        );
      }
      filename = base + '.otf'; mime = 'font/otf';
    } else if (targetFormat === 'woff') {
      if (state.fontType === 'ttf') {
        rebuilt = await encodeSfntToWOFF(rebuildTTF(state.buffer, keepIds));
      } else if (state.fontType === 'otf-cff') {
        rebuilt = await encodeSfntToWOFF(rebuildOTF(state.buffer, state.ttf, keepIds));
      } else {
        const { records, cmapPairs } = buildGlyphRecordsFromKeepIds(keepIds);
        const otf = buildOTFCFFFromGlyphRecords(
          records,
          cmapPairs,
          state.metadata.family || base,
          state.metadata.postScript || base
        );
        rebuilt = await encodeSfntToWOFF(otf);
      }
      filename = base + '.woff'; mime = 'font/woff';
    } else if (targetFormat === 'cff') {
      if (state.fontType === 'cff') {
        rebuilt = rebuildRawCFF(state.buffer, keepIds);
      } else if (state.fontType === 'otf-cff') {
        const cffTableInfo = state.ttf.tables['CFF '];
        const cffBytes = new Uint8Array(state.buffer, cffTableInfo.offset, cffTableInfo.length);
        rebuilt = rebuildCFFTable(cffBytes, keepIds);
      } else {
        const { records } = buildGlyphRecordsFromKeepIds(keepIds);
        rebuilt = buildCFFFromGlyphRecords(records, state.metadata.postScript || base);
      }
      filename = base + '.cff'; mime = 'application/octet-stream';
    } else if (targetFormat === 'pfa' || targetFormat === 'pfb') {
      let pfaBytes;
      if (state.fontType === 'type1') {
        const keepNames = new Set(['.notdef']);
        for (const g of state.glyphs) {
          if (keepIds.has(g.id)) keepNames.add(g.name);
        }
        pfaBytes = rebuildType1Font(state.type1Font, keepNames);
      } else {
        const { records } = buildGlyphRecordsFromKeepIds(keepIds);
        pfaBytes = buildType1FromGlyphRecords(
          records,
          state.metadata.family || base,
          state.metadata.postScript || base,
          state.metadata // Pass metadata for license preservation
        );
      }
      if (targetFormat === 'pfb') {
        rebuilt = convertPfaToPfb(pfaBytes);
        filename = base + '.pfb'; mime = 'application/octet-stream';
      } else {
        rebuilt = pfaBytes;
        filename = base + '.pfa'; mime = 'application/postscript';
      }
    } else if (targetFormat === 'woff2') {
      if (state.fontType === 'ttf') {
        rebuilt = await encodeSfntToWOFF2(rebuildTTF(state.buffer, keepIds));
      } else if (state.fontType === 'otf-cff') {
        rebuilt = await encodeSfntToWOFF2(rebuildOTF(state.buffer, state.ttf, keepIds));
      } else {
        const { records, cmapPairs } = buildGlyphRecordsFromKeepIds(keepIds);
        const otf = buildOTFCFFFromGlyphRecords(
          records,
          cmapPairs,
          state.metadata.family || base,
          state.metadata.postScript || base
        );
        rebuilt = await encodeSfntToWOFF2(otf);
      }
      filename = base + '.woff2'; mime = 'font/woff2';
    } else if (targetFormat === 'svg') {
      const { records } = buildGlyphRecordsFromKeepIds(keepIds);
      if (!window.SVGFontUtils || typeof window.SVGFontUtils.buildSvgFontFromGlyphRecords !== 'function') {
        throw new Error('SVG support not loaded');
      }
      rebuilt = window.SVGFontUtils.buildSvgFontFromGlyphRecords(records, {
        family: state.metadata.family || base,
        postScriptName: state.metadata.postScript || base,
        unitsPerEm: 1000,
        defaultAdvanceWidth: records.find(r => r.name === '.notdef')?.advanceWidth || 1000,
        metadata: state.metadata
      });
      filename = base + '.svg'; mime = 'image/svg+xml';
    } else {
      downloadBytes(new Uint8Array(state.buffer), state.file.name, 'application/octet-stream');
      return;
    }
    downloadBytes(rebuilt, filename, mime);
  } catch(e) {
    showError();
    console.error(e);
  }
}
window.exportFont = exportFont;

function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ═══════════════════════════════════════════════════════════════════
// CFF REBUILDER
// ═══════════════════════════════════════════════════════════════════

// ─── CFF INDEX read/write ───

function cffReadIndex(bytes, off) {
  const count = (bytes[off] << 8) | bytes[off+1]; off += 2;
  if (count === 0) {
    return { items: [], count: 0, offSize: 0, offsets: [1], dataStart: off, dataEnd: off, nextOff: off };
  }
  const offSize = bytes[off++];
  const offsets = [];
  for (let i = 0; i <= count; i++) {
    let o = 0;
    for (let j = 0; j < offSize; j++) o = (o << 8) | bytes[off++];
    offsets.push(o);
  }
  const dataStart = off;
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push(bytes.slice(dataStart + offsets[i] - 1, dataStart + offsets[i+1] - 1));
  }
  const dataEnd = dataStart + offsets[count] - 1;
  return { items, count, offSize, offsets, dataStart, dataEnd, nextOff: dataEnd };
}

function cffBuildIndex(items) {
  if (!items.length) return new Uint8Array([0, 0]);
  const totalData = items.reduce((s, x) => s + x.length, 0);
  const maxOff = totalData + 1;
  const offSize = maxOff <= 0xFF ? 1 : maxOff <= 0xFFFF ? 2 : maxOff <= 0xFFFFFF ? 3 : 4;
  const hdrSize = 2 + 1 + (items.length + 1) * offSize;
  const result = new Uint8Array(hdrSize + totalData);
  const dv = new DataView(result.buffer);
  dv.setUint16(0, items.length, false);
  result[2] = offSize;
  let offPos = 3, dataOff = 1;
  const writeOff = v => {
    for (let i = offSize - 1; i >= 0; i--) { result[offPos + i] = v & 0xFF; v >>= 8; }
    offPos += offSize;
  };
  writeOff(dataOff);
  for (const item of items) { dataOff += item.length; writeOff(dataOff); }
  let dataPos = hdrSize;
  for (const item of items) { result.set(item, dataPos); dataPos += item.length; }
  return result;
}

// ─── CFF DICT parsing ───

function cffReadDictEntries(bytes, start, end) {
  const entries = [];
  let i = start, entryStart = start;
  const stack = [];
  while (i < end) {
    const b = bytes[i];
    if (b === 29) {
      stack.push(((bytes[i+1] << 24) | (bytes[i+2] << 16) | (bytes[i+3] << 8) | bytes[i+4]) | 0);
      i += 5;
    } else if (b === 28) {
      let v = (bytes[i+1] << 8) | bytes[i+2];
      if (v >= 32768) v -= 65536;
      stack.push(v); i += 3;
    } else if (b === 30) {
      i++;
      while (i < end) { const n = bytes[i++]; if ((n & 0xF) === 0xF || (n >> 4) === 0xF) break; }
      stack.push(NaN);
    } else if (b >= 247 && b <= 250) {
      stack.push((b-247)*256 + bytes[i+1] + 108); i += 2;
    } else if (b >= 251 && b <= 254) {
      stack.push(-(b-251)*256 - bytes[i+1] - 108); i += 2;
    } else if (b >= 32) {
      stack.push(b - 139); i++;
    } else if (b === 12) {
      const op = (12 << 8) | bytes[i+1];
      entries.push({ ops: stack.slice(), operator: op, startByte: entryStart, endByte: i+2 });
      stack.length = 0; i += 2; entryStart = i;
    } else {
      entries.push({ ops: stack.slice(), operator: b, startByte: entryStart, endByte: i+1 });
      stack.length = 0; i++; entryStart = i;
    }
  }
  return entries;
}

function cffEncodeNumber(n) {
  n = Math.round(n);
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) { const b = n - 108; return [Math.floor(b/256) + 247, b % 256]; }
  if (n >= -1131 && n <= -108) { const m = -n - 108; return [Math.floor(m/256) + 251, m % 256]; }
  if (n >= -32768 && n <= 32767) return [28, (n >> 8) & 0xFF, n & 0xFF];
  return [29, (n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
}

function cffEncode5(n) {
  return [29, (n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
}

// ─── CFF Charset ───

function cffReadCharset(bytes, off, numGlyphs) {
  const sids = new Array(numGlyphs);
  sids[0] = 0; // .notdef
  const fmt = bytes[off++];
  if (fmt === 0) {
    for (let i = 1; i < numGlyphs; i++) { sids[i] = (bytes[off] << 8) | bytes[off+1]; off += 2; }
  } else if (fmt === 1) {
    let gid = 1;
    while (gid < numGlyphs) {
      const first = (bytes[off] << 8) | bytes[off+1]; off += 2;
      const nLeft = bytes[off++];
      for (let k = 0; k <= nLeft && gid < numGlyphs; k++, gid++) sids[gid] = first + k;
    }
  } else if (fmt === 2) {
    let gid = 1;
    while (gid < numGlyphs) {
      const first = (bytes[off] << 8) | bytes[off+1]; off += 2;
      const nLeft = (bytes[off] << 8) | bytes[off+1]; off += 2;
      for (let k = 0; k <= nLeft && gid < numGlyphs; k++, gid++) sids[gid] = first + k;
    }
  }
  return sids;
}

function cffBuildCharset0(sids) {
  // sids for glyphs 1..N-1 (glyph 0/.notdef is implicit)
  const data = new Uint8Array(1 + sids.length * 2);
  data[0] = 0;
  for (let i = 0; i < sids.length; i++) {
    data[1 + i*2] = (sids[i] >> 8) & 0xFF;
    data[2 + i*2] = sids[i] & 0xFF;
  }
  return data;
}

// ─── CFF table rebuild ───

function rebuildCFFTable(cffBytes, keepIds) {
  const src = (cffBytes instanceof Uint8Array) ? cffBytes : new Uint8Array(cffBytes);
  const out = src.slice();

  try {
    // CFF2 or unknown major: leave untouched for safety.
    if (out.length < 4 || out[0] !== 1) return out;

    const hdrSize = out[2];
    const nameIdx = cffReadIndex(out, hdrSize);
    const topDictIdx = cffReadIndex(out, nameIdx.nextOff);
    if (!topDictIdx.count) return out;

    const topStart = topDictIdx.dataStart + topDictIdx.offsets[0] - 1;
    const topEnd = topDictIdx.dataStart + topDictIdx.offsets[1] - 1;
    if (topStart < 0 || topEnd > out.length || topEnd <= topStart) return out;
    const topDictBytes = out.slice(topStart, topEnd);
    const topDictEntries = cffReadDictEntries(topDictBytes, 0, topDictBytes.length);

    let csOff = 0;
    for (const e of topDictEntries) {
      if (e.operator === 17) {
        csOff = e.ops[0] | 0;
        break;
      }
    }
    if (csOff <= 0 || csOff >= out.length) return out;

    const csIdx = cffReadIndex(out, csOff);
    const glyphCount = csIdx.count;
    if (!glyphCount) return out;

    // Preserve GID numbering: blank removed glyph charstrings in place.
    // This keeps GSUB/GPOS/kern/FDSelect offsets valid for all CFF variants.
    const keep = new Set([0]);
    for (const gid of keepIds) {
      if (Number.isInteger(gid) && gid >= 0 && gid < glyphCount) keep.add(gid);
    }

    for (let gid = 1; gid < glyphCount; gid++) {
      if (keep.has(gid)) continue;
      const start = csIdx.dataStart + csIdx.offsets[gid] - 1;
      const end = csIdx.dataStart + csIdx.offsets[gid + 1] - 1;
      const len = end - start;
      if (len <= 0 || start < 0 || end > out.length) continue;
      out[start] = 14; // endchar
      for (let i = 1; i < len; i++) out[start + i] = 139; // harmless padding
    }
  } catch (err) {
    console.warn('CFF safe subset fallback: returning original CFF data', err);
    return src.slice();
  }

  return out;
}

function rebuildOTF(buffer, ttf, keepIds) {
  const cffTableInfo = ttf.tables['CFF '];
  const cffBytes = new Uint8Array(buffer, cffTableInfo.offset, cffTableInfo.length);
  const numOrigGlyphs = state.cffFont.glyphCount;

  const keep = new Set([0]);
  for (const id of keepIds) {
    if (Number.isInteger(id) && id > 0 && id < numOrigGlyphs) keep.add(id);
  }

  const newCffBytes = rebuildCFFTable(cffBytes, keep);
  const cmapKeep = new Set();
  for (const gid of keep) {
    if (gid >= 0 && gid < ttf.numGlyphs) cmapKeep.add(gid);
  }
  const newCmap = buildCmapTable(ttf, cmapKeep);
  const headData = patchTable(ttf, buffer, 'head', d => { new DataView(d.buffer).setUint32(8, 0, false); return d; });

  const tables = {};
  for (const [tag, info] of Object.entries(ttf.tables)) {
    if (tag === 'glyf' || tag === 'loca') continue;
    tables[tag] = new Uint8Array(buffer, info.offset, info.length);
  }
  Object.assign(tables, {
    'CFF ': newCffBytes,
    cmap: newCmap,
    head: headData
  });

  return assembleFontFile(tables, true);
}

function rebuildRawCFF(buffer, keepIds) {
  const bytes = new Uint8Array(buffer);
  const numOrig = state.cffFont.glyphCount;
  const filtered = new Set([0]);
  for (const id of keepIds) {
    if (Number.isInteger(id) && id > 0 && id < numOrig) filtered.add(id);
  }
  return rebuildCFFTable(bytes, filtered);
}

// ═══════════════════════════════════════════════════════════════════
// TYPE1 REBUILDER
// ═══════════════════════════════════════════════════════════════════

function charStringEncrypt(plainBytes, lenIV) {
  const all = new Uint8Array(lenIV + plainBytes.length);
  all.set(plainBytes, lenIV); // seed bytes stay 0
  let r = 4330;
  const out = new Uint8Array(all.length);
  for (let i = 0; i < all.length; i++) {
    const c = (all[i] ^ (r >> 8)) & 0xFF;
    out[i] = c;
    r = ((c + r) * 52845 + 22719) & 0xFFFF;
  }
  return out;
}

function eexecEncrypt(plainBytes) {
  const all = new Uint8Array(4 + plainBytes.length);
  all.set(plainBytes, 4); // 4 zero seed bytes
  let r = 55665;
  const out = new Uint8Array(all.length);
  for (let i = 0; i < all.length; i++) {
    const c = (all[i] ^ (r >> 8)) & 0xFF;
    out[i] = c;
    r = ((c + r) * 52845 + 22719) & 0xFFFF;
  }
  return out;
}

function bytesToHexLines(bytes, charsPerLine) {
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  const lines = [];
  for (let i = 0; i < hex.length; i += charsPerLine) lines.push(hex.slice(i, i + charsPerLine));
  return lines.join('\n');
}

function findByteSubarray(haystack, needle, start) {
  start = start || 0;
  outer: for (let i = start; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i+j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function t1HexSectionToBytes(bytes) {
  let hex = '';
  for (const b of bytes) {
    if ((b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102))
      hex += String.fromCharCode(b);
  }
  if (hex.length & 1) hex = hex.slice(0, -1);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i/2] = parseInt(hex.slice(i, i+2), 16);
  return out;
}

function t1IsHexSection(bytes) {
  let count = 0;
  for (let i = 0; i < Math.min(bytes.length, 32); i++) {
    const c = bytes[i];
    if (c === 9 || c === 10 || c === 13 || c === 32) continue;
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) { count++; continue; }
    return false;
  }
  return count > 0;
}

function wrapPfbSegment(type, bytes) {
  const out = new Uint8Array(6 + bytes.length);
  out[0] = 0x80;
  out[1] = type & 0xFF;
  const len = bytes.length >>> 0;
  out[2] = len & 0xFF;
  out[3] = (len >>> 8) & 0xFF;
  out[4] = (len >>> 16) & 0xFF;
  out[5] = (len >>> 24) & 0xFF;
  out.set(bytes, 6);
  return out;
}

function convertPfaToPfb(pfaBytes) {
  const enc = new TextEncoder();
  const markerBytes = enc.encode('currentfile eexec');
  const markerPos = findByteSubarray(pfaBytes, markerBytes);
  if (markerPos === -1) throw new Error('No eexec marker in Type1 font');

  let eexecStart = markerPos + markerBytes.length;
  while (eexecStart < pfaBytes.length &&
         (pfaBytes[eexecStart] === 9 || pfaBytes[eexecStart] === 10 || pfaBytes[eexecStart] === 13 || pfaBytes[eexecStart] === 32))
    eexecStart++;

  const clearBytes = enc.encode('cleartomark');
  let clearPos = findByteSubarray(pfaBytes, clearBytes, eexecStart);
  if (clearPos === -1) clearPos = pfaBytes.length;

  const seg1 = pfaBytes.slice(0, eexecStart);
  const eexecSection = pfaBytes.slice(eexecStart, clearPos);
  const seg2 = t1IsHexSection(eexecSection) ? t1HexSectionToBytes(eexecSection) : eexecSection.slice();
  const seg3 = pfaBytes.slice(clearPos);

  const s1 = wrapPfbSegment(1, seg1);
  const s2 = wrapPfbSegment(2, seg2);
  const s3 = wrapPfbSegment(1, seg3);
  const end = new Uint8Array([0x80, 0x03]);

  const total = s1.length + s2.length + s3.length + end.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(s1, off); off += s1.length;
  out.set(s2, off); off += s2.length;
  out.set(s3, off); off += s3.length;
  out.set(end, off);
  return out;
}

function rebuildType1EexecContent(decryptedBytes, type1, keepNames) {
  // Work with Latin-1 string for pattern matching (positions = byte positions)
  const text = window.bytesToLatin1(decryptedBytes);

  const csHeaderStart = text.indexOf('/CharStrings');
  if (csHeaderStart === -1) throw new Error('No /CharStrings in eexec section');

  const beginPos = text.indexOf('begin', csHeaderStart);
  if (beginPos === -1) throw new Error('No begin after /CharStrings');

  let pos = beginPos + 5;
  while (pos < text.length && /[\r\n\t ]/.test(text[pos])) pos++;

  // Scan through charstring entries (explicit lengths) to skip binary data safely
  const csRegex = /(?:dup\s+)?\/([^\s]+)\s+(\d+)\s+(?:RD|-\||\|-|-)\s/g;
  csRegex.lastIndex = pos;
  let match;
  while ((match = csRegex.exec(text)) !== null) {
    const length = parseInt(match[2]);
    pos = match.index + match[0].length + length;
    const ndMatch = /^(?:ND\b|def\b|noaccess\s+def\b|-\||\|-|\|d)\s*[\r\n]?/.exec(text.slice(pos));
    if (ndMatch) pos += ndMatch[0].length;
    csRegex.lastIndex = pos;
  }

  // pos now points at 'end' closing the CharStrings dict
  const endMatch = /^end/.exec(text.slice(pos));
  const afterCharStrings = pos + (endMatch ? endMatch[0].length : 0);

  // Build replacement CharStrings section
  const lenIV = (type1.lenIV !== undefined && type1.lenIV >= 0) ? type1.lenIV : 4;
  const enc = new TextEncoder();
  const parts = [];

  parts.push(enc.encode(`/CharStrings ${keepNames.size} dict dup begin\n`));
  for (const name of keepNames) {
    const csBytes = type1.charStrings.get(name);
    if (!csBytes) continue;
    const encrypted = charStringEncrypt(csBytes, lenIV);
    parts.push(enc.encode(`/${name} ${encrypted.length} RD `));
    parts.push(encrypted);
    parts.push(enc.encode(' ND\n'));
  }
  parts.push(enc.encode('end'));

  const before = decryptedBytes.slice(0, csHeaderStart);
  const after  = decryptedBytes.slice(afterCharStrings);
  const totalLen = before.length + parts.reduce((s, p) => s + p.length, 0) + after.length;
  const result = new Uint8Array(totalLen);
  let off = 0;
  result.set(before, off); off += before.length;
  for (const p of parts) { result.set(p, off); off += p.length; }
  result.set(after, off);
  return result;
}

function buildType1EexecFromParsed(type1, keepNames) {
  const lenIV = (type1.lenIV !== undefined && Number.isFinite(type1.lenIV)) ? type1.lenIV : 4;
  const enc = new TextEncoder();
  const parts = [];

  const encodeCs = (raw) => {
    const body = (raw instanceof Uint8Array) ? raw : new Uint8Array(0);
    return lenIV >= 0 ? charStringEncrypt(body, lenIV) : body.slice();
  };

  const subrEntries = [];
  if (type1.subrs) {
    for (const [k, v] of type1.subrs) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 0 && v instanceof Uint8Array) {
        subrEntries.push([idx, v]);
      }
    }
    subrEntries.sort((a, b) => a[0] - b[0]);
  }

  const subrCount = subrEntries.length ? (subrEntries[subrEntries.length - 1][0] + 1) : 0;
  parts.push(enc.encode(`/lenIV ${lenIV} def\n`));
  parts.push(enc.encode('/RD {string currentfile exch readstring pop} executeonly def\n'));
  parts.push(enc.encode('/ND {noaccess def} executeonly def\n'));
  parts.push(enc.encode('/NP {noaccess put} executeonly def\n'));
  parts.push(enc.encode(`/Subrs ${subrCount} array\n`));
  for (const [idx, raw] of subrEntries) {
    const encrypted = encodeCs(raw);
    parts.push(enc.encode(`dup ${idx} ${encrypted.length} RD `));
    parts.push(encrypted);
    parts.push(enc.encode(' NP\n'));
  }

  parts.push(enc.encode(`/CharStrings ${keepNames.size} dict dup begin\n`));
  for (const name of keepNames) {
    const csBytes = type1.charStrings.get(name);
    if (!(csBytes instanceof Uint8Array)) continue;
    const encrypted = encodeCs(csBytes);
    parts.push(enc.encode(`/${name} ${encrypted.length} RD `));
    parts.push(encrypted);
    parts.push(enc.encode(' ND\n'));
  }
  parts.push(enc.encode('end\n'));

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) { result.set(p, off); off += p.length; }
  return result;
}

function neutralizeType1CharStringsInPlace(eexecBytes, type1, keepNames) {
  const out = eexecBytes.slice();
  const text = window.bytesToLatin1(out);
  const lenIV = (type1.lenIV !== undefined && Number.isFinite(type1.lenIV)) ? type1.lenIV : 4;
  const csRegex = /(?:dup\s+)?\/([^\s]+)\s+(\d+)\s+(?:RD|-\||\|-|-)\s/g;
  let match;
  let patchedCount = 0;

  const buildNeutralChunk = (targetLen) => {
    if (targetLen <= 0) return new Uint8Array(0);
    if (lenIV >= 0) {
      const bodyLen = Math.max(0, targetLen - lenIV);
      const body = new Uint8Array(bodyLen);
      if (bodyLen > 0) {
        body[0] = 14; // endchar
        for (let i = 1; i < bodyLen; i++) body[i] = 139;
      }
      const encrypted = charStringEncrypt(body, lenIV);
      if (encrypted.length === targetLen) return encrypted;
      if (encrypted.length > targetLen) return encrypted.slice(0, targetLen);
      const fixed = new Uint8Array(targetLen);
      fixed.set(encrypted);
      return fixed;
    }
    const plain = new Uint8Array(targetLen);
    plain[0] = 14;
    for (let i = 1; i < targetLen; i++) plain[i] = 139;
    return plain;
  };

  while ((match = csRegex.exec(text)) !== null) {
    const name = match[1];
    const length = parseInt(match[2], 10);
    if (!Number.isFinite(length) || length < 0) continue;
    const dataStart = match.index + match[0].length;
    const dataEnd = dataStart + length;
    if (dataEnd > out.length) break;

    if (keepNames.has(name)) {
      csRegex.lastIndex = dataEnd;
      continue;
    }

    const neutral = buildNeutralChunk(length);
    out.set(neutral, dataStart);
    patchedCount++;
    csRegex.lastIndex = dataEnd;
  }

  return patchedCount > 0 ? out : null;
}

function rebuildType1Font(type1, keepNames) {
  const origBytes = type1.bytes;

  const enc = new TextEncoder();
  const markerBytes = enc.encode('currentfile eexec');
  const markerPos = findByteSubarray(origBytes, markerBytes);
  if (markerPos === -1) throw new Error('No eexec marker in Type1 font');

  let eexecStart = markerPos + markerBytes.length;
  while (eexecStart < origBytes.length &&
         (origBytes[eexecStart] === 10 || origBytes[eexecStart] === 13 || origBytes[eexecStart] === 32))
    eexecStart++;

  const clearBytes = enc.encode('cleartomark');
  let clearPos = findByteSubarray(origBytes, clearBytes, eexecStart);
  if (clearPos === -1) clearPos = origBytes.length;

  const eexecSection = origBytes.slice(eexecStart, clearPos);
  const rawEexecBytes = t1IsHexSection(eexecSection) ? t1HexSectionToBytes(eexecSection) : eexecSection.slice();

  const hasCharStrings = (bytes) => {
    if (!bytes || !bytes.length) return false;
    const text = window.bytesToLatin1(bytes);
    return text.indexOf('/CharStrings') !== -1;
  };

  const decrypted = window.eexecDecryptBytes(rawEexecBytes);
  let workingEexec = null;
  if (hasCharStrings(decrypted)) {
    workingEexec = decrypted;
  } else if (hasCharStrings(rawEexecBytes)) {
    // Some Type1 fonts keep eexec body in plaintext; accept and normalize output.
    workingEexec = rawEexecBytes;
  }

  let newDecrypted;
  if (workingEexec) {
    try {
      newDecrypted = rebuildType1EexecContent(workingEexec, type1, keepNames);
    } catch (_) {
      newDecrypted = neutralizeType1CharStringsInPlace(workingEexec, type1, keepNames) || buildType1EexecFromParsed(type1, keepNames);
    }
  } else {
    const patchedDecrypted = neutralizeType1CharStringsInPlace(decrypted, type1, keepNames);
    newDecrypted = patchedDecrypted || buildType1EexecFromParsed(type1, keepNames);
  }
  const reEncrypted = eexecEncrypt(newDecrypted);
  const hexContent = bytesToHexLines(reEncrypted, 64);

  // Rewrite cleartext encoding entries so removed names map to /.notdef.
  const rewriteType1HeaderEncoding = (headerBytes) => {
    const src = window.bytesToLatin1(headerBytes);
    let changed = false;
    const patchName = (name) => (keepNames.has(name) ? name : '.notdef');

    const out = src
      .replace(/\bdup\s+(\d+)\s*\/([^\s]+)\s+put\b/g, (m, code, name) => {
        const next = patchName(name);
        if (next === name) return m;
        changed = true;
        return `dup ${code} /${next} put`;
      })
      .replace(/\bEncoding\s+(\d+)\s*\/([^\s]+)\s+put\b/g, (m, code, name) => {
        const next = patchName(name);
        if (next === name) return m;
        changed = true;
        return `Encoding ${code} /${next} put`;
      });

    return changed ? enc.encode(out) : headerBytes;
  };

  // Assemble: rewritten header + marker + new hex eexec + footer
  const headerClearBytes = origBytes.slice(0, markerPos);
  const markerPartBytes = origBytes.slice(markerPos, markerPos + markerBytes.length);
  const headerBytes = rewriteType1HeaderEncoding(headerClearBytes);
  const hexBytes    = enc.encode('\n' + hexContent + '\n');
  const footerBytes = enc.encode(
    '0000000000000000000000000000000000000000000000000000000000000000\ncleartomark\n');

  const result = new Uint8Array(headerBytes.length + markerPartBytes.length + hexBytes.length + footerBytes.length);
  let off = 0;
  result.set(headerBytes, off); off += headerBytes.length;
  result.set(markerPartBytes, off); off += markerPartBytes.length;
  result.set(hexBytes, off);    off += hexBytes.length;
  result.set(footerBytes, off);
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// TTF REBUILDER
// ═══════════════════════════════════════════════════════════════════

function rebuildTTF(buffer, keepIds) {
  const ttf = state.ttf;
  const boundedKeep = new Set();
  for (const gid of keepIds) {
    if (Number.isInteger(gid) && gid >= 0 && gid < ttf.numGlyphs) boundedKeep.add(gid);
  }

  // Expand keep set to include components required by retained composite glyphs.
  const expanded = expandForComposites(ttf, buffer, boundedKeep);
  expanded.add(0); // always keep .notdef

  // Build glyf while preserving original glyph IDs. Removed glyphs become empty.
  const { glyfData, glyfOffsets } = buildGlyfTablePreserveIds(ttf, buffer, expanded);

  // Determine loca format and build loca table.
  const totalGlyfSize = glyfOffsets[glyfOffsets.length - 1];
  const useShortLoca = totalGlyfSize <= 0x1FFFE; // leave headroom
  const indexToLocFormat = useShortLoca ? 0 : 1;
  const locaData = buildLocaTable(glyfOffsets, ttf.numGlyphs, indexToLocFormat);

  // Build cmap with original GIDs (no remap), including supplementary planes.
  const cmapData = buildCmapTable(ttf, expanded);

  // Patch head (indexToLocFormat, clear checkSumAdjustment).
  const headData = patchTable(ttf, buffer, 'head', (d) => {
    const dv = new DataView(d.buffer);
    dv.setInt16(50, indexToLocFormat, false);
    dv.setUint32(8, 0, false); // clear checkSumAdjustment
    return d;
  });

  // Collect all original tables, override modified ones.
  const tables = {};
  for (const [tag, info] of Object.entries(ttf.tables)) {
    tables[tag] = new Uint8Array(buffer, info.offset, info.length);
  }
  Object.assign(tables, {
    glyf: glyfData,
    loca: locaData,
    cmap: cmapData,
    head: headData
  });

  // Assemble font file.
  return assembleFontFile(tables, false);
}

function expandForComposites(ttf, buffer, keepIds) {
  const expanded = new Set(keepIds);
  const ARG_WORDS = 0x0001, MORE = 0x0020;
  const WE_HAVE_SCALE = 0x0008, WE_HAVE_XY_SCALE = 0x0040, WE_HAVE_2x2 = 0x0080;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let changed;
  do {
    changed = false;
    for (const gid of [...expanded]) {
      const { offset, length } = ttf.glyphRange(gid);
      if (!length) continue;
      const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
      if (dv.getInt16(0, false) >= 0) continue; // simple glyph
      let o = 10;
      let flags;
      do {
        flags = dv.getUint16(o, false); o += 2;
        const compGID = dv.getUint16(o, false); o += 2;
        if (!expanded.has(compGID)) { expanded.add(compGID); changed = true; }
        o += (flags & ARG_WORDS) ? 4 : 2;
        if (flags & WE_HAVE_SCALE) o += 2;
        else if (flags & WE_HAVE_XY_SCALE) o += 4;
        else if (flags & WE_HAVE_2x2) o += 8;
      } while (flags & MORE);
    }
  } while (changed);
  return expanded;
}

function buildGlyfTablePreserveIds(ttf, buffer, keepSet) {
  const parts = [];
  const glyfOffsets = [0];
  let totalSize = 0;

  for (let gid = 0; gid < ttf.numGlyphs; gid++) {
    if (!keepSet.has(gid)) {
      parts.push(null);
      glyfOffsets.push(totalSize);
      continue;
    }

    const { offset, length } = ttf.glyphRange(gid);
    if (!length) {
      parts.push(null);
      glyfOffsets.push(totalSize);
      continue;
    }

    const glyphBytes = new Uint8Array(buffer, offset, length);
    const padded = (glyphBytes.length + 3) & ~3;
    parts.push({ data: glyphBytes, size: padded });
    totalSize += padded;
    glyfOffsets.push(totalSize);
  }

  const glyfData = new Uint8Array(totalSize);
  let off = 0;
  for (const part of parts) {
    if (part) { glyfData.set(part.data, off); off += part.size; }
  }

  return { glyfData, glyfOffsets };
}

function buildLocaTable(offsets, numGlyphs, indexToLocFormat) {
  const count = numGlyphs + 1;
  if (indexToLocFormat === 0) {
    const data = new Uint8Array(count * 2);
    const dv = new DataView(data.buffer);
    for (let i = 0; i < count; i++) dv.setUint16(i * 2, offsets[i] / 2, false);
    return data;
  } else {
    const data = new Uint8Array(count * 4);
    const dv = new DataView(data.buffer);
    for (let i = 0; i < count; i++) dv.setUint32(i * 4, offsets[i], false);
    return data;
  }
}

function buildHmtxTable(ttf, sorted) {
  const data = new Uint8Array(sorted.length * 4);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < sorted.length; i++) {
    const m = ttf.hmtx[sorted[i]] || { advanceWidth: 0, lsb: 0 };
    dv.setUint16(i * 4, m.advanceWidth, false);
    dv.setInt16(i * 4 + 2, m.lsb, false);
  }
  return data;
}

// Keep cmap repair self-contained in the export engine. The UI has similar
// helpers for browsing glyphs, but export must not depend on UI-only scope.
function buildReverseCmapFromTTF(ttf) {
  const gidToUnicode = new Map();
  const entries = ttf.cmapEntries().slice().sort((a, b) => a.cp - b.cp);
  for (const { cp, gid } of entries) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;
    if (gid > 0 && !gidToUnicode.has(gid)) gidToUnicode.set(gid, cp);
  }
  return gidToUnicode;
}

function findSpaceGlyphTTF(ttf, reverseCmap) {
  for (const [, cp] of reverseCmap) {
    if (cp === 0x20) return -1;
  }
  const targetWidth = (ttf.unitsPerEm || 1000) * 0.25;
  let bestGid = -1;
  let bestScore = Infinity;
  for (let gid = 1; gid <= Math.min(5, ttf.numGlyphs - 1); gid++) {
    if (reverseCmap.has(gid)) continue;
    const metrics = ttf.hmtx[gid];
    if (!metrics || metrics.advanceWidth <= 0) continue;
    const range = ttf.glyphRange(gid);
    if (range.length > 40) continue;
    const score = Math.abs(metrics.advanceWidth - targetWidth);
    if (score < bestScore) {
      bestGid = gid;
      bestScore = score;
    }
  }
  return bestGid;
}

function buildCmapTable(ttf, keepSet) {
  const pairsAll = [];
  const pairsBMP = [];
  const entries = ttf.cmapEntries();
  let hasSpace = false;
  for (const { cp, gid } of entries) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue; // surrogate range
    if (cp === 0x20) hasSpace = true;
    if (gid > 0 && keepSet.has(gid)) {
      const pair = { cp, gid };
      pairsAll.push(pair);
      if (cp <= 0xFFFF && cp !== 0xFFFF) pairsBMP.push(pair);
    }
  }

  // Ensure U+0020 (space) is in the cmap — some fonts omit it
  if (!hasSpace) {
    const reverseCmap = buildReverseCmapFromTTF(ttf);
    const spaceGid = findSpaceGlyphTTF(ttf, reverseCmap);
    if (spaceGid > 0 && keepSet.has(spaceGid)) {
      const pair = { cp: 0x20, gid: spaceGid };
      pairsAll.push(pair);
      pairsBMP.push(pair);
    }
  }

  const format4 = buildCmap4Subtable(pairsBMP);
  const format12 = buildCmap12Subtable(pairsAll);
  return buildCmapWithSubtables(format4, format12);
}

function buildCmapWithSubtables(format4, format12) {
  const numTables = 4;
  const headerSize = 4 + numTables * 8;
  const totalSize = headerSize + format4.length + format12.length;
  const data = new Uint8Array(totalSize);
  const dv = new DataView(data.buffer);

  dv.setUint16(0, 0, false); // version
  dv.setUint16(2, numTables, false);

  // Keep encoding records sorted by platform/encoding ID. Some browser font
  // validators reject otherwise-valid cmap tables when this order is mixed.
  // Unicode platform BMP (format 4)
  dv.setUint16(4, 0, false);   // platformID
  dv.setUint16(6, 3, false);   // encodingID
  dv.setUint32(8, headerSize, false);

  // Unicode platform full repertoire (format 12)
  dv.setUint16(12, 0, false);  // platformID
  dv.setUint16(14, 4, false);  // encodingID
  dv.setUint32(16, headerSize + format4.length, false);

  // Windows BMP Unicode (format 4)
  dv.setUint16(20, 3, false);  // platformID
  dv.setUint16(22, 1, false);  // encodingID
  dv.setUint32(24, headerSize, false);

  // Windows UCS-4 (format 12)
  dv.setUint16(28, 3, false);  // platformID
  dv.setUint16(30, 10, false); // encodingID
  dv.setUint32(32, headerSize + format4.length, false);

  data.set(format4, headerSize);
  data.set(format12, headerSize + format4.length);
  return data;
}

function buildMinimalCmap4Subtable() {
  // Single terminator segment (maps 0xFFFF to glyph 0).
  const data = new Uint8Array(24);
  const dv = new DataView(data.buffer);
  dv.setUint16(0, 4, false);   // format
  dv.setUint16(2, 24, false);  // length
  dv.setUint16(4, 0, false);   // language
  dv.setUint16(6, 2, false);   // segCountX2
  dv.setUint16(8, 2, false);   // searchRange
  dv.setUint16(10, 0, false);  // entrySelector
  dv.setUint16(12, 0, false);  // rangeShift
  dv.setUint16(14, 0xFFFF, false); // endCount[0]
  dv.setUint16(16, 0, false);      // reservedPad
  dv.setUint16(18, 0xFFFF, false); // startCount[0]
  dv.setInt16(20, 1, false);       // idDelta[0]
  dv.setUint16(22, 0, false);      // idRangeOffset[0]
  return data;
}

function buildCmap4Subtable(pairs) {
  if (!pairs.length) return buildMinimalCmap4Subtable();

  pairs.sort((a, b) => a.cp - b.cp);

  // Group into segments of consecutive codepoints
  const segments = []; // {start, end, gids}
  let i = 0;
  while (i < pairs.length) {
    const start = pairs[i].cp;
    let end = start;
    const gids = [pairs[i].gid];
    let j = i + 1;
    while (j < pairs.length && pairs[j].cp === end + 1) {
      end = pairs[j].cp;
      gids.push(pairs[j].gid);
      j++;
    }
    segments.push({ start, end, gids });
    i = j;
  }
  // Terminator segment
  segments.push({ start: 0xFFFF, end: 0xFFFF, gids: [] });

  if (segments.length > 0x7FFF) return buildMinimalCmap4Subtable();

  const segCount = segments.length;
  const maxPow2 = segCount > 0 ? Math.floor(Math.log2(segCount)) : 0;
  const searchRange = (1 << maxPow2) * 2;
  const entrySelector = maxPow2;
  const rangeShift = segCount * 2 - searchRange;

  // Layout in subtable (offset from subtable start = 0):
  // header: 14 bytes (format+length+language+segCountX2+searchRange+entrySelector+rangeShift)
  // endCount[segCount]: segCount*2 bytes
  // reservedPad: 2 bytes
  // startCount[segCount]: segCount*2 bytes
  // idDelta[segCount]: segCount*2 bytes
  // idRangeOffset[segCount]: segCount*2 bytes
  // glyphIdArray[totalGlyphs]: totalGlyphs*2 bytes

  const idRangeOffsetStart = 14 + segCount * 2 + 2 + segCount * 2 + segCount * 2; // from subtable start
  const glyphIdArrayStart = idRangeOffsetStart + segCount * 2;

  // For each non-terminator segment, compute its offset into glyphIdArray
  const gidOffsets = []; // in entries (not bytes) from start of glyphIdArray
  let totalGlyphs = 0;
  for (const seg of segments) {
    gidOffsets.push(totalGlyphs);
    totalGlyphs += seg.gids.length;
  }

  const subtableSize = glyphIdArrayStart + totalGlyphs * 2;
  if (subtableSize > 0xFFFF) return buildMinimalCmap4Subtable();

  const data = new Uint8Array(subtableSize);
  const dv = new DataView(data.buffer);

  let off = 0;
  dv.setUint16(off, 4, false); off += 2; // format
  dv.setUint16(off, subtableSize, false); off += 2; // length
  dv.setUint16(off, 0, false); off += 2; // language
  dv.setUint16(off, segCount * 2, false); off += 2; // segCountX2
  dv.setUint16(off, searchRange, false); off += 2;
  dv.setUint16(off, entrySelector, false); off += 2;
  dv.setUint16(off, rangeShift, false); off += 2;

  // endCount array
  for (const seg of segments) { dv.setUint16(off, seg.end, false); off += 2; }
  dv.setUint16(off, 0, false); off += 2; // reservedPad

  // startCount array
  for (const seg of segments) { dv.setUint16(off, seg.start, false); off += 2; }

  // idDelta array (0 for real segments since we use glyph array; 1 for terminator)
  for (let k = 0; k < segCount - 1; k++) { dv.setInt16(off, 0, false); off += 2; }
  dv.setInt16(off, 1, false); off += 2; // terminator delta → glyph 0

  // idRangeOffset array
  // off is now at the start of idRangeOffset[0] in the data array
  for (let k = 0; k < segCount; k++) {
    const seg = segments[k];
    if (!seg.gids.length) {
      // Terminator: idRangeOffset = 0
      dv.setUint16(off, 0, false);
    } else {
      // iro[k] = address of glyphIdArray[gidOffsets[k]] relative to &iro[k]
      const myPos = off; // absolute position of iro[k] in data
      const glyphArrayPos = glyphIdArrayStart + gidOffsets[k] * 2;
      dv.setUint16(off, glyphArrayPos - myPos, false);
    }
    off += 2;
  }

  // glyphIdArray
  for (let k = 0; k < segCount; k++) {
    for (const gid of segments[k].gids) {
      dv.setUint16(off, gid, false);
      off += 2;
    }
  }

  return data;
}

function buildCmap12Subtable(pairs) {
  pairs.sort((a, b) => a.cp - b.cp);

  const groups = [];
  let i = 0;
  while (i < pairs.length) {
    const startCp = pairs[i].cp;
    const startGid = pairs[i].gid;
    let endCp = startCp;
    i++;
    while (i < pairs.length) {
      const next = pairs[i];
      const expectedCp = endCp + 1;
      const expectedGid = startGid + (next.cp - startCp);
      if (next.cp !== expectedCp || next.gid !== expectedGid) break;
      endCp = next.cp;
      i++;
    }
    groups.push({ startCp, endCp, startGid });
  }

  const data = new Uint8Array(16 + groups.length * 12);
  const dv = new DataView(data.buffer);
  dv.setUint16(0, 12, false); // format
  dv.setUint16(2, 0, false);  // reserved
  dv.setUint32(4, data.length, false);
  dv.setUint32(8, 0, false);  // language
  dv.setUint32(12, groups.length, false);
  let off = 16;
  for (const g of groups) {
    dv.setUint32(off, g.startCp >>> 0, false); off += 4;
    dv.setUint32(off, g.endCp >>> 0, false); off += 4;
    dv.setUint32(off, g.startGid >>> 0, false); off += 4;
  }
  return data;
}

function patchTable(ttf, buffer, tag, patchFn) {
  const info = ttf.tables[tag];
  if (!info) return new Uint8Array(0);
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const copy = bytes.slice(info.offset, info.offset + info.length);
  return patchFn(copy);
}

function buildMinimalPost(ttf, buffer) {
  // Format 3.0: no PostScript glyph name information
  const orig = ttf.tables['post'];
  const post = new Uint8Array(32);
  const dv = new DataView(post.buffer);
  dv.setUint32(0, 0x00030000, false); // format 3.0
  if (orig && orig.length >= 32) {
    // Copy italic angle, underline position/thickness, isFixedPitch from original
    const origData = new Uint8Array(buffer, orig.offset, Math.min(orig.length, 32));
    post.set(origData.subarray(4, 32), 4);
  }
  return post;
}

function calcChecksum(data) {
  // Use GPU-accelerated checksum for large data (>32KB)
  if (typeof gpuCalcChecksum === 'function' && data.length >= 32768) {
    return gpuCalcChecksum(data);
  }
  const n4 = Math.floor(data.length / 4);
  let sum = 0;
  for (let i = 0; i < n4; i++) {
    const v = ((data[i*4] << 24) | (data[i*4+1] << 16) | (data[i*4+2] << 8) | data[i*4+3]) >>> 0;
    sum = (sum + v) >>> 0;
  }
  const rem = data.length % 4;
  if (rem) {
    let v = 0;
    for (let i = 0; i < rem; i++) v |= data[data.length - rem + i] << (24 - i * 8);
    sum = (sum + (v >>> 0)) >>> 0;
  }
  return sum;
}

function assembleFontFile(tables, isCFF) {
  const tagList = Object.keys(tables).sort();
  const numTables = tagList.length;

  const maxPow2 = Math.floor(Math.log2(numTables));
  const searchRange = (1 << maxPow2) * 16;
  const entrySelector = maxPow2;
  const rangeShift = numTables * 16 - searchRange;

  // Calculate total size and positions
  let offset = 12 + numTables * 16; // OffsetTable + directory
  const positions = {};
  const paddedTables = {};

  for (const tag of tagList) {
    const orig = tables[tag];
    positions[tag] = offset;
    const padded = new Uint8Array((orig.length + 3) & ~3);
    padded.set(orig);
    paddedTables[tag] = padded;
    offset += padded.length;
  }

  const result = new Uint8Array(offset);
  const dv = new DataView(result.buffer);

  // OffsetTable
  const sfVersion = isCFF ? 0x4F54544F : 0x00010000;
  dv.setUint32(0, sfVersion, false);
  dv.setUint16(4, numTables, false);
  dv.setUint16(6, searchRange, false);
  dv.setUint16(8, entrySelector, false);
  dv.setUint16(10, rangeShift, false);

  // Table directory + data
  for (let i = 0; i < numTables; i++) {
    const tag = tagList[i];
    const data = paddedTables[tag];
    const pos = positions[tag];
    const entryOff = 12 + i * 16;

    // Tag (4 bytes, space-padded)
    for (let j = 0; j < 4; j++) result[entryOff + j] = tag.charCodeAt(j) || 0x20;

    // Checksum (of padded data, using original length for correctness)
    dv.setUint32(entryOff + 4, calcChecksum(data), false);
    dv.setUint32(entryOff + 8, pos, false);
    dv.setUint32(entryOff + 12, tables[tag].length, false); // original unpadded length

    result.set(data, pos);
  }

  // Set head.checkSumAdjustment
  if (tables['head'] && positions['head'] != null) {
    const headPos = positions['head'];
    dv.setUint32(headPos + 8, 0, false); // clear first
    // Sum entire file (GPU-accelerated for large fonts)
    const fileSum = calcChecksum(result);
    dv.setUint32(headPos + 8, (0xB1B0AFBA - fileSum) >>> 0, false);
  }

  return result;
}

function _buildGlyphRecordsFromFont(sfntBytes, type1Font, cffFont, svgFont) {
  const miniTtfContoursToQuadraticPath = (contours) => {
    const path = [];
    for (const pts of contours || []) {
      if (!pts || !pts.length) continue;
      const n = pts.length;
      const get = i => pts[(i + n) % n];
      let s = pts.findIndex(p => p.on);
      let start;
      if (s === -1) {
        const p0 = pts[0], p1 = pts[n - 1];
        start = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        s = 0;
      } else {
        start = pts[s];
      }
      path.push({ cmd: 'M', x: start.x, y: start.y });
      let i = s + 1;
      while (i < s + 1 + n) {
        const cur = get(i);
        if (cur.on) {
          path.push({ cmd: 'L', x: cur.x, y: cur.y });
          i++;
        } else {
          const nxt = get(i + 1);
          if (nxt.on) {
            path.push({ cmd: 'Q', x1: cur.x, y1: cur.y, x: nxt.x, y: nxt.y });
            i += 2;
          } else {
            path.push({ cmd: 'Q', x1: cur.x, y1: cur.y, x: (cur.x + nxt.x) / 2, y: (cur.y + nxt.y) / 2 });
            i += 1;
          }
        }
      }
      path.push({ cmd: 'Z' });
    }
    return path;
  };
  const miniPathToCubic = (path) => {
    const out = [];
    let cx = 0, cy = 0;
    for (const s of (path || [])) {
      if (s.cmd === 'M') {
        cx = s.x; cy = s.y;
        out.push({ cmd: 'M', x: cx, y: cy });
      } else if (s.cmd === 'L') {
        cx = s.x; cy = s.y;
        out.push({ cmd: 'L', x: cx, y: cy });
      } else if (s.cmd === 'Q') {
        const x0 = cx, y0 = cy;
        const x1 = s.x1, y1 = s.y1;
        const x2 = s.x, y2 = s.y;
        out.push({
          cmd: 'C',
          x1: x0 + (2 / 3) * (x1 - x0),
          y1: y0 + (2 / 3) * (y1 - y0),
          x2: x2 + (2 / 3) * (x1 - x2),
          y2: y2 + (2 / 3) * (y1 - y2),
          x3: x2,
          y3: y2
        });
        cx = x2; cy = y2;
      } else if (s.cmd === 'C') {
        out.push({ cmd: 'C', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, x3: s.x3, y3: s.y3 });
        cx = s.x3; cy = s.y3;
      } else if (s.cmd === 'Z') {
        out.push({ cmd: 'Z' });
      }
    }
    return out;
  };
  const nameToUni = name => {
    if (!name || !window.glyphNameToUnicode) return null;
    const u = window.glyphNameToUnicode(name);
    return u != null ? (typeof u === 'string' ? u.codePointAt(0) : u) : null;
  };

  let sourceUnits = 1000;
  const records = [];

  if (svgFont && Array.isArray(svgFont.glyphs)) {
    sourceUnits = svgFont.unitsPerEm || 1000;
    for (const glyph of svgFont.glyphs) {
      records.push({
        name: glyph.name || (records.length === 0 ? '.notdef' : `glyph${records.length}`),
        unicode: Number.isInteger(glyph.unicode) ? glyph.unicode : null,
        path: Array.isArray(glyph.path) ? glyph.path.map(seg => window.SVGFontUtils && window.SVGFontUtils.cloneSegment ? window.SVGFontUtils.cloneSegment(seg) : ({ ...seg })) : [],
        advanceWidth: Number(glyph.advanceWidth) || 0
      });
    }
  } else if (type1Font) {
    sourceUnits = type1Font.unitsPerEm || 1000;
    const encoding = type1Font.encoding || [];
    const seen = new Set();
    records.push({ name: '.notdef', unicode: null, path: [], advanceWidth: 0 });
    seen.add('.notdef');
    const nd = type1Font.loadGlyphByName('.notdef');
    if (nd && nd.path) records[0].path = pathToCubic(nd.path);
    if (nd && nd.metrics && Number.isFinite(nd.metrics.advanceWidth)) records[0].advanceWidth = nd.metrics.advanceWidth;
    for (let code = 0; code < 256; code++) {
      const name = encoding[code];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const g = type1Font.loadGlyphByName(name);
      records.push({
        name,
        unicode: nameToUni(name),
        path: pathToCubic((g && g.path) || []),
        advanceWidth: g && g.metrics && Number.isFinite(g.metrics.advanceWidth) ? g.metrics.advanceWidth : 0
      });
    }
    if (type1Font.charStrings) {
      for (const [name] of type1Font.charStrings) {
        if (seen.has(name)) continue;
        seen.add(name);
        const g = type1Font.loadGlyphByName(name);
        records.push({
          name,
          unicode: nameToUni(name),
          path: pathToCubic((g && g.path) || []),
          advanceWidth: g && g.metrics && Number.isFinite(g.metrics.advanceWidth) ? g.metrics.advanceWidth : 0
        });
      }
    }
  } else if (sfntBytes) {
    const ttf = new window.TTF(sfntBytes);
    ttf.parse();
    sourceUnits = ttf.unitsPerEm || 1000;
    let parsedCff = cffFont;
    if (ttf.isCFF) {
      const cffTable = ttf.tables['CFF '];
      if (cffTable && !parsedCff) {
        parsedCff = new window.CFFFont(sfntBytes.slice(cffTable.offset, cffTable.offset + cffTable.length));
        parsedCff.parse();
      }
    }
    const reverseCmap = typeof buildReverseCmapFromTTF === 'function' ? buildReverseCmapFromTTF(ttf) : new Map();
    const count = parsedCff ? (parsedCff.glyphCount || (parsedCff.glyphOrder || []).length) : (ttf.numGlyphs || 0);
    for (let gid = 0; gid < count; gid++) {
      if (parsedCff) {
        const g = parsedCff.loadGlyphByIndex(gid);
        const name = (parsedCff.glyphOrder && parsedCff.glyphOrder[gid]) || (g && g.name) || (gid === 0 ? '.notdef' : `glyph${gid}`);
        const unicode = nameToUni(name) ?? reverseCmap.get(gid) ?? null;
        records.push({
          name,
          unicode,
          path: miniPathToCubic((g && g.path) || []),
          advanceWidth: g && g.metrics && Number.isFinite(g.metrics.advanceWidth) ? g.metrics.advanceWidth : 0
        });
      } else {
        const g = ttf.loadGlyph(gid);
        const unicode = reverseCmap.get(gid) ?? null;
        records.push({
          name: getGlyphNameFromUnicode(unicode) || (gid === 0 ? '.notdef' : `glyph${gid}`),
          unicode,
          path: miniPathToCubic(miniTtfContoursToQuadraticPath((g && g.contours) || [])),
          advanceWidth: g && Number.isFinite(g.advanceWidth) ? g.advanceWidth : 0
        });
      }
    }
  }

  if (!records.length || records[0].name !== '.notdef') {
    records.unshift({ name: '.notdef', unicode: null, path: [], advanceWidth: 500 });
  }

  const scale = 1000 / Math.max(1, sourceUnits || 1000);
  for (const record of records) {
    record.path = scaleCubicPath(record.path, scale);
    record.advanceWidth = Math.round((record.advanceWidth || 0) * scale);
  }

  const cmapPairs = [];
  for (let gid = 1; gid < records.length; gid++) {
    const cp = records[gid].unicode;
    if (Number.isInteger(cp) && cp >= 1 && cp <= 0x10FFFF && (cp < 0xD800 || cp > 0xDFFF)) {
      cmapPairs.push({ cp, gid });
    }
  }

  return { records, cmapPairs };
}
