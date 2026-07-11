'use strict';

// Legacy-compatible MiniConverter facade and preview helpers.
// It delegates font construction to keyfont-engine.js.

function _buildTTFFromType1(type1Font, fontName) {
  const clamp16 = v => { v = Math.round(v || 0); return Math.max(-32768, Math.min(32767, v)); };

  // -- Enumerate glyphs --
  const encoding = type1Font.encoding || [];
  const glyphList = [];
  const seen = new Set();
  let gIdx = 0;
  const nameToUni = name => {
    if (!name || !window.glyphNameToUnicode) return null;
    const u = window.glyphNameToUnicode(name);
    return u != null ? (typeof u === 'string' ? u.codePointAt(0) : u) : null;
  };
  glyphList.push({ id: gIdx++, name: '.notdef', unicode: null });
  seen.add('.notdef');
  for (let code = 0; code < 256; code++) {
    const name = encoding[code];
    if (!name || name === '.notdef' || seen.has(name)) continue;
    seen.add(name);
    glyphList.push({ id: gIdx++, name, unicode: nameToUni(name) });
  }
  if (type1Font.charStrings) {
    for (const [name] of type1Font.charStrings) {
      if (seen.has(name)) continue;
      seen.add(name);
      glyphList.push({ id: gIdx++, name, unicode: nameToUni(name) });
    }
  }

  // -- Build records with scaled paths --
  const upm = type1Font.unitsPerEm || 1000;
  const scale = 1000 / (upm || 1000);
  const records = [];
  const cmapPairs = [];
  for (const g of glyphList) {
    const t1 = type1Font.loadGlyphByName(g.name);
    let adv = t1 && t1.metrics && Number.isFinite(t1.metrics.advanceWidth) ? t1.metrics.advanceWidth : 0;
    const rawPath = (t1 && t1.path) || [];
    const path = rawPath.map(s => {
      if (s.cmd === 'M' || s.cmd === 'L') return { cmd: s.cmd, x: s.x * scale, y: s.y * scale };
      if (s.cmd === 'C') return { cmd: 'C', x1: s.x1*scale, y1: s.y1*scale, x2: s.x2*scale, y2: s.y2*scale, x3: s.x3*scale, y3: s.y3*scale };
      return { cmd: s.cmd };
    });
    records.push({ name: g.name, unicode: g.unicode, path, advanceWidth: Math.round(adv * scale) });
  }
  for (let gid = 1; gid < records.length; gid++) {
    const cp = records[gid].unicode;
    if (Number.isInteger(cp) && cp >= 1 && cp <= 0x10FFFF && (cp < 0xD800 || cp > 0xDFFF))
      cmapPairs.push({ cp, gid });
  }

  // -- Cubic path → TTF on-curve contours --
  function cubicToContours(path) {
    const contours = [];
    let cur = null, penX = 0, penY = 0, startX = 0, startY = 0;
    const push = (x, y) => {
      const px = clamp16(x), py = clamp16(y);
      if (!cur) cur = [];
      if (cur.length && cur[cur.length-1].x === px && cur[cur.length-1].y === py) return;
      cur.push({ x: px, y: py, on: true });
    };
    const finish = () => {
      if (!cur || !cur.length) { cur = null; return; }
      if (cur.length > 1 && cur[0].x === cur[cur.length-1].x && cur[0].y === cur[cur.length-1].y) cur.pop();
      if (cur.length === 1) cur.push({ x: clamp16(cur[0].x + 1), y: cur[0].y, on: true });
      if (cur.length >= 2) contours.push(cur);
      cur = null;
    };
    for (const s of (path || [])) {
      if (s.cmd === 'M') {
        finish(); penX = s.x; penY = s.y; cur = []; push(penX, penY); startX = penX; startY = penY;
      } else if (s.cmd === 'L') {
        if (!cur) { cur = []; push(penX, penY); }
        penX = s.x; penY = s.y; push(penX, penY);
      } else if (s.cmd === 'C') {
        if (!cur) { cur = []; push(penX, penY); }
        const x0 = penX, y0 = penY, x1 = s.x1, y1 = s.y1, x2 = s.x2, y2 = s.y2, x3 = s.x3, y3 = s.y3;
        const dist = (ax,ay,bx,by) => Math.hypot(bx-ax, by-ay);
        const poly = dist(x0,y0,x1,y1) + dist(x1,y1,x2,y2) + dist(x2,y2,x3,y3);
        const segs = Math.max(2, Math.min(24, Math.ceil(poly / 90 + Math.max(0, poly - dist(x0,y0,x3,y3)) / 60)));
        for (let i = 1; i <= segs; i++) {
          const t = i / segs, mt = 1 - t;
          const a = mt*mt*mt, b = 3*mt*mt*t, c = 3*mt*t*t, d = t*t*t;
          push(a*x0 + b*x1 + c*x2 + d*x3, a*y0 + b*y1 + c*y2 + d*y3);
        }
        penX = x3; penY = y3;
      } else if (s.cmd === 'Z') {
        if (cur) { push(startX, startY); finish(); }
        penX = startX; penY = startY;
      }
    }
    finish();
    return contours;
  }

  // -- Build simple TTF glyph binary --
  function buildGlyph(contours) {
    const norm = [];
    for (const c of (contours || [])) {
      const pts = (Array.isArray(c) ? c : []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      if (pts.length >= 2) norm.push(pts);
    }
    if (!norm.length) return { data: new Uint8Array(0), pointCount: 0, contourCount: 0, xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    const points = [], endPts = [];
    for (const c of norm) {
      for (const p of c) {
        const x = clamp16(p.x), y = clamp16(p.y);
        points.push({ x, y });
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      }
      endPts.push(points.length - 1);
    }
    const flags = [], xData = [], yData = [];
    let prevX = 0, prevY = 0;
    const pushI16 = (arr, v) => { v = clamp16(v); arr.push((v >> 8) & 0xFF, v & 0xFF); };
    for (const p of points) {
      let f = 0x01;
      const dx = p.x - prevX, dy = p.y - prevY;
      if (dx === 0) f |= 0x10;
      else if (dx > 0 && dx <= 255) { f |= 0x02 | 0x10; xData.push(dx & 0xFF); }
      else if (dx < 0 && dx >= -255) { f |= 0x02; xData.push((-dx) & 0xFF); }
      else pushI16(xData, dx);
      if (dy === 0) f |= 0x20;
      else if (dy > 0 && dy <= 255) { f |= 0x04 | 0x20; yData.push(dy & 0xFF); }
      else if (dy < 0 && dy >= -255) { f |= 0x04; yData.push((-dy) & 0xFF); }
      else pushI16(yData, dy);
      flags.push(f); prevX = p.x; prevY = p.y;
    }
    const sz = 10 + endPts.length * 2 + 2 + flags.length + xData.length + yData.length;
    const out = new Uint8Array(sz);
    const dv = new DataView(out.buffer);
    dv.setInt16(0, norm.length, false);
    dv.setInt16(2, xMin, false); dv.setInt16(4, yMin, false);
    dv.setInt16(6, xMax, false); dv.setInt16(8, yMax, false);
    let off = 10;
    for (const ep of endPts) { dv.setUint16(off, ep, false); off += 2; }
    dv.setUint16(off, 0, false); off += 2;
    out.set(flags, off); off += flags.length;
    out.set(xData, off); off += xData.length;
    out.set(yData, off);
    return { data: out, pointCount: points.length, contourCount: norm.length, xMin, yMin, xMax, yMax };
  }

  // -- Build required SFNT tables --
  function mkHead(xMin, yMin, xMax, yMax, locFmt) {
    const o = new Uint8Array(54), d = new DataView(o.buffer);
    d.setUint32(0, 0x00010000, false); d.setUint32(4, 0x00010000, false);
    d.setUint32(12, 0x5F0F3CF5, false); d.setUint16(18, 1000, false);
    d.setInt16(36, clamp16(xMin), false); d.setInt16(38, clamp16(yMin), false);
    d.setInt16(40, clamp16(xMax), false); d.setInt16(42, clamp16(yMax), false);
    d.setUint16(46, 8, false); d.setInt16(48, 2, false);
    d.setInt16(50, locFmt, false);
    return o;
  }
  function mkHhea(metrics, yMin, yMax) {
    const o = new Uint8Array(36), d = new DataView(o.buffer);
    d.setUint32(0, 0x00010000, false);
    d.setInt16(4, Math.round(yMax), false); d.setInt16(6, Math.round(yMin), false);
    if (metrics.length) {
      d.setUint16(10, Math.max(...metrics.map(m => m.advanceWidth)) >>> 0, false);
      d.setInt16(12, Math.min(...metrics.map(m => m.lsb)), false);
      d.setInt16(14, Math.min(...metrics.map(m => m.rsb)), false);
      d.setInt16(16, Math.max(...metrics.map(m => m.xMaxExtent)), false);
    }
    d.setInt16(18, 1, false); d.setUint16(34, metrics.length, false);
    return o;
  }
  function mkMaxp(n, maxPts, maxCtr) {
    const o = new Uint8Array(32), d = new DataView(o.buffer);
    d.setUint32(0, 0x00010000, false); d.setUint16(4, n, false);
    d.setUint16(6, maxPts, false); d.setUint16(8, maxCtr, false);
    d.setUint16(14, 2, false); d.setUint16(24, 48, false);
    return o;
  }
  function mkOS2(metrics, cmapP, yMin, yMax) {
    const o = new Uint8Array(78), d = new DataView(o.buffer);
    const avg = metrics.length ? Math.round(metrics.reduce((s, m) => s + (m.advanceWidth || 0), 0) / metrics.length) : 500;
    const bmp = (cmapP || []).map(p => p.cp).filter(cp => cp >= 0 && cp <= 0xFFFF).sort((a,b) => a-b);
    d.setInt16(2, clamp16(avg), false); d.setUint16(4, 400, false); d.setUint16(6, 5, false);
    d.setInt16(10, 650, false); d.setInt16(12, 699, false); d.setInt16(16, 140, false);
    d.setInt16(18, 650, false); d.setInt16(20, 699, false); d.setInt16(24, 479, false);
    d.setInt16(26, 50, false); d.setInt16(28, 250, false);
    d.setUint32(42, 1, false);
    o[58]=0x47; o[59]=0x50; o[60]=0x54; o[61]=0x35;
    d.setUint16(62, 0x0040, false);
    if (bmp.length) { d.setUint16(64, bmp[0], false); d.setUint16(66, bmp[bmp.length-1], false); }
    d.setInt16(68, clamp16(yMax), false); d.setInt16(70, clamp16(yMin), false);
    d.setUint16(74, Math.max(0, clamp16(yMax)) & 0xFFFF, false);
    d.setUint16(76, Math.max(0, clamp16(-yMin)) & 0xFFFF, false);
    return o;
  }
  function mkHmtx(metrics) {
    const o = new Uint8Array(metrics.length * 4), d = new DataView(o.buffer);
    for (let i = 0; i < metrics.length; i++) {
      d.setUint16(i*4, metrics[i].advanceWidth >>> 0, false);
      d.setInt16(i*4+2, metrics[i].lsb, false);
    }
    return o;
  }
  function mkPost() {
    const o = new Uint8Array(32), d = new DataView(o.buffer);
    d.setUint32(0, 0x00030000, false);
    return o;
  }
  function mkLoca(offsets, n, fmt) {
    const cnt = n + 1;
    if (fmt === 0) {
      const o = new Uint8Array(cnt * 2), d = new DataView(o.buffer);
      for (let i = 0; i < cnt; i++) d.setUint16(i*2, offsets[i]/2, false);
      return o;
    }
    const o = new Uint8Array(cnt * 4), d = new DataView(o.buffer);
    for (let i = 0; i < cnt; i++) d.setUint32(i*4, offsets[i], false);
    return o;
  }
  function mkName(fam, ps) {
    const sane = s => { let o = ''; for (const ch of String(s||'')) if (/[A-Za-z0-9_.-]/.test(ch)) o += ch; return o || 'Font'; };
    const f = fam || 'Font', p = sane(ps || f), full = f + ' Regular';
    const names = [{ id: 1, t: f }, { id: 2, t: 'Regular' }, { id: 4, t: full }, { id: 6, t: p }];
    const toU16 = str => { const o = new Uint8Array(str.length*2); for (let i = 0; i < str.length; i++) { o[i*2] = (str.charCodeAt(i)>>8)&0xFF; o[i*2+1] = str.charCodeAt(i)&0xFF; } return o; };
    const recs = names.map(n => ({ ...n, b: toU16(n.t) }));
    const hdr = 6 + recs.length * 12;
    const strLen = recs.reduce((s, r) => s + r.b.length, 0);
    const o = new Uint8Array(hdr + strLen), d = new DataView(o.buffer);
    d.setUint16(2, recs.length, false); d.setUint16(4, hdr, false);
    let rOff = 6, sOff = 0;
    for (const r of recs) {
      d.setUint16(rOff, 3, false); d.setUint16(rOff+2, 1, false); d.setUint16(rOff+4, 0x0409, false);
      d.setUint16(rOff+6, r.id, false); d.setUint16(rOff+8, r.b.length, false); d.setUint16(rOff+10, sOff, false);
      o.set(r.b, hdr + sOff); sOff += r.b.length; rOff += 12;
    }
    return o;
  }

  // -- cmap (format 4 + format 12) --
  function mkCmap(cmapP) {
    // Deduplicate by codepoint (keep first occurrence)
    const seen = new Set();
    const deduped = [];
    for (const p of (cmapP || [])) {
      if (!seen.has(p.cp)) { seen.add(p.cp); deduped.push(p); }
    }
    // Format 4 (BMP)
    const bmp = deduped.filter(p => p.cp <= 0xFFFF && p.cp !== 0xFFFF).sort((a,b) => a.cp - b.cp);
    let f4;
    if (!bmp.length) {
      f4 = new Uint8Array(24); const d = new DataView(f4.buffer);
      d.setUint16(0,4,false); d.setUint16(2,24,false); d.setUint16(6,2,false);
      d.setUint16(8,2,false); d.setUint16(14,0xFFFF,false); d.setUint16(18,0xFFFF,false);
      d.setInt16(20,1,false);
    } else {
      const segs = []; let i = 0;
      while (i < bmp.length) {
        const start = bmp[i].cp; let end = start; const gids = [bmp[i].gid]; let j = i + 1;
        while (j < bmp.length && bmp[j].cp === end + 1) { end = bmp[j].cp; gids.push(bmp[j].gid); j++; }
        segs.push({ start, end, gids }); i = j;
      }
      segs.push({ start: 0xFFFF, end: 0xFFFF, gids: [] });
      const sc = segs.length, mp2 = Math.floor(Math.log2(sc)), sr = (1 << mp2) * 2;
      const iroStart = 14 + sc*2 + 2 + sc*2 + sc*2;
      const gaStart = iroStart + sc*2;
      let totalG = 0; const gOff = [];
      for (const s of segs) { gOff.push(totalG); totalG += s.gids.length; }
      const sz = gaStart + totalG * 2;
      f4 = new Uint8Array(sz); const d = new DataView(f4.buffer);
      let o = 0;
      d.setUint16(o,4,false); o+=2; d.setUint16(o,sz,false); o+=2; d.setUint16(o,0,false); o+=2;
      d.setUint16(o,sc*2,false); o+=2; d.setUint16(o,sr,false); o+=2; d.setUint16(o,mp2,false); o+=2;
      d.setUint16(o,sc*2-sr,false); o+=2;
      for (const s of segs) { d.setUint16(o, s.end, false); o+=2; }
      d.setUint16(o, 0, false); o+=2;
      for (const s of segs) { d.setUint16(o, s.start, false); o+=2; }
      for (let k = 0; k < sc-1; k++) { d.setInt16(o, 0, false); o+=2; }
      d.setInt16(o, 1, false); o+=2;
      for (let k = 0; k < sc; k++) {
        if (!segs[k].gids.length) d.setUint16(o, 0, false);
        else d.setUint16(o, gaStart + gOff[k]*2 - o, false);
        o+=2;
      }
      for (const s of segs) for (const gid of s.gids) { d.setUint16(o, gid, false); o+=2; }
    }
    // Format 12 (full)
    const all = deduped.sort((a,b) => a.cp - b.cp);
    const groups = []; let i = 0;
    while (i < all.length) {
      const scp = all[i].cp, sgid = all[i].gid; let ecp = scp; i++;
      while (i < all.length && all[i].cp === ecp+1 && all[i].gid === sgid+(all[i].cp-scp)) { ecp = all[i].cp; i++; }
      groups.push({ scp, ecp, sgid });
    }
    const f12 = new Uint8Array(16 + groups.length * 12);
    const d12 = new DataView(f12.buffer);
    d12.setUint16(0, 12, false); d12.setUint32(4, f12.length, false); d12.setUint32(12, groups.length, false);
    let o12 = 16;
    for (const g of groups) { d12.setUint32(o12,g.scp>>>0,false); d12.setUint32(o12+4,g.ecp>>>0,false); d12.setUint32(o12+8,g.sgid>>>0,false); o12+=12; }
    // Combine
    const numSub = 4, hdr = 4 + numSub * 8, total = hdr + f4.length + f12.length;
    const cm = new Uint8Array(total), dc = new DataView(cm.buffer);
    dc.setUint16(2, numSub, false);
    // Encoding records must be sorted by (platformID, encodingID)
    dc.setUint16(4,0,false); dc.setUint16(6,3,false); dc.setUint32(8,hdr,false);              // (0,3) Unicode BMP → format 4
    dc.setUint16(12,0,false); dc.setUint16(14,4,false); dc.setUint32(16,hdr+f4.length,false);  // (0,4) Unicode full → format 12
    dc.setUint16(20,3,false); dc.setUint16(22,1,false); dc.setUint32(24,hdr,false);            // (3,1) Windows BMP → format 4
    dc.setUint16(28,3,false); dc.setUint16(30,10,false); dc.setUint32(32,hdr+f4.length,false); // (3,10) Windows UCS-4 → format 12
    cm.set(f4, hdr); cm.set(f12, hdr + f4.length);
    return cm;
  }

  // -- Assemble SFNT --
  function assemble(tables) {
    const tags = Object.keys(tables).sort(), n = tags.length;
    const mp = Math.floor(Math.log2(n)), sr = (1 << mp) * 16;
    let off = 12 + n * 16;
    const pos = {}, padded = {};
    for (const t of tags) { pos[t] = off; const p = new Uint8Array((tables[t].length+3)&~3); p.set(tables[t]); padded[t] = p; off += p.length; }
    const r = new Uint8Array(off), dv = new DataView(r.buffer);
    dv.setUint32(0, 0x00010000, false); dv.setUint16(4, n, false);
    dv.setUint16(6, sr, false); dv.setUint16(8, mp, false); dv.setUint16(10, n*16-sr, false);
    for (let i = 0; i < n; i++) {
      const t = tags[i], d = padded[t], eo = 12 + i*16;
      for (let j = 0; j < 4; j++) r[eo+j] = t.charCodeAt(j) || 0x20;
      // checksum
      let sum = 0; const n4 = Math.floor(d.length/4);
      for (let k = 0; k < n4; k++) sum = (sum + ((d[k*4]<<24)|(d[k*4+1]<<16)|(d[k*4+2]<<8)|d[k*4+3])>>>0)>>>0;
      const rem = d.length % 4; if (rem) { let v = 0; for (let k = 0; k < rem; k++) v |= d[d.length-rem+k]<<(24-k*8); sum = (sum+(v>>>0))>>>0; }
      dv.setUint32(eo+4, sum, false); dv.setUint32(eo+8, pos[t], false); dv.setUint32(eo+12, tables[t].length, false);
      r.set(d, pos[t]);
    }
    if (tables['head'] && pos['head'] != null) {
      const hp = pos['head']; dv.setUint32(hp+8, 0, false);
      let fs = 0; const fn4 = Math.floor(r.length/4);
      for (let i = 0; i < fn4; i++) fs = (fs + dv.getUint32(i*4, false)) >>> 0;
      const fr = r.length % 4; if (fr) { let v = 0; for (let i = 0; i < fr; i++) v |= r[fn4*4+i]<<(24-i*8); fs = (fs+(v>>>0))>>>0; }
      dv.setUint32(hp+8, (0xB1B0AFBA - fs) >>> 0, false);
    }
    return r;
  }

  // -- Main conversion pipeline --
  const glyphDatas = [], offsets = [0], metrics = [];
  let total = 0, gxMin = Infinity, gyMin = Infinity, gxMax = -Infinity, gyMax = -Infinity, maxPts = 0, maxCtrs = 0;
  for (const r of records) {
    const contours = cubicToContours(r.path);
    const g = buildGlyph(contours);
    glyphDatas.push(g);
    const padLen = (g.data.length + 3) & ~3;
    total += padLen; offsets.push(total);
    const adv = Math.max(0, Math.round(r.advanceWidth || 0));
    const lsb = g.data.length ? g.xMin : 0;
    const rsb = g.data.length ? (adv - lsb - (g.xMax - g.xMin)) : 0;
    const xMaxExt = g.data.length ? (lsb + (g.xMax - g.xMin)) : lsb;
    metrics.push({ advanceWidth: adv, lsb, rsb, xMaxExtent: xMaxExt });
    if (g.data.length) {
      if (g.xMin < gxMin) gxMin = g.xMin; if (g.yMin < gyMin) gyMin = g.yMin;
      if (g.xMax > gxMax) gxMax = g.xMax; if (g.yMax > gyMax) gyMax = g.yMax;
    }
    if (g.pointCount > maxPts) maxPts = g.pointCount;
    if (g.contourCount > maxCtrs) maxCtrs = g.contourCount;
  }
  if (!isFinite(gxMin)) { gxMin = 0; gyMin = 0; gxMax = 0; gyMax = 0; }
  const glyfData = new Uint8Array(total);
  let gOff = 0;
  for (const g of glyphDatas) { if (g.data.length) glyfData.set(g.data, gOff); gOff += (g.data.length + 3) & ~3; }
  const shortLoca = total <= 0x1FFFE;
  const locFmt = shortLoca ? 0 : 1;
  const tables = {
    head: mkHead(gxMin, gyMin, gxMax, gyMax, locFmt),
    hhea: mkHhea(metrics, gyMin, gyMax),
    maxp: mkMaxp(records.length, maxPts, maxCtrs),
    'OS/2': mkOS2(metrics, cmapPairs, gyMin, gyMax),
    hmtx: mkHmtx(metrics),
    cmap: mkCmap(cmapPairs),
    name: mkName(fontName, fontName),
    post: mkPost(),
    glyf: glyfData,
    loca: mkLoca(offsets, records.length, locFmt)
  };
  return assemble(tables);
}

// ═══════════════════════════════════════════════════════════════════
// CFF → OTF WRAPPER (for browser preview of bare CFF fonts)
// ═══════════════════════════════════════════════════════════════════

function _wrapCFFInOTF(cffBytes) {
  const clamp16 = v => Math.max(-32768, Math.min(32767, Math.round(v || 0)));

  // Parse CFF to get glyph metrics
  let numGlyphs = 1, fontName = 'Font', upm = 1000;
  let cff = null;
  try {
    cff = new window.CFFFont(cffBytes);
    cff.parse();
    numGlyphs = cff.glyphs ? cff.glyphs.length : 1;
    fontName = cff.name || 'Font';
    upm = cff.unitsPerEm || 1000;
  } catch(e) {}

  // Build metrics and cmap pairs from CFF
  const metrics = [], cmapPairs = [];
  let xMin = 0, yMin = 0, xMax = 0, yMax = 0;
  for (let gid = 0; gid < numGlyphs; gid++) {
    let adv = 0;
    if (cff) {
      try {
        const g = cff.loadGlyphByIndex(gid);
        if (g) {
          adv = (g.metrics && g.metrics.advanceWidth) || 0;
          if (g.bounds) {
            if (g.bounds.minX < xMin) xMin = g.bounds.minX;
            if (g.bounds.minY < yMin) yMin = g.bounds.minY;
            if (g.bounds.maxX > xMax) xMax = g.bounds.maxX;
            if (g.bounds.maxY > yMax) yMax = g.bounds.maxY;
          }
        }
      } catch(e) {}
      // Get unicode from charset name
      const name = cff.charset && cff.charset[gid];
      if (name && gid > 0 && window.glyphNameToUnicode) {
        const u = window.glyphNameToUnicode(name);
        const cp = u != null ? (typeof u === 'string' ? u.codePointAt(0) : u) : null;
        if (cp && cp >= 1 && cp <= 0x10FFFF && (cp < 0xD800 || cp > 0xDFFF))
          cmapPairs.push({ cp, gid });
      }
    }
    metrics.push({ advanceWidth: Math.max(0, Math.round(adv)), lsb: 0 });
  }

  // Build cmap (format 4 for BMP)
  const seen = new Set();
  const dedupedPairs = [];
  for (const p of cmapPairs) {
    if (!seen.has(p.cp)) { seen.add(p.cp); dedupedPairs.push(p); }
  }
  const bmp = dedupedPairs.filter(p => p.cp <= 0xFFFF).sort((a,b) => a.cp - b.cp);
  let f4;
  if (!bmp.length) {
    f4 = new Uint8Array(24); const d = new DataView(f4.buffer);
    d.setUint16(0,4,false); d.setUint16(2,24,false); d.setUint16(6,2,false);
    d.setUint16(8,2,false); d.setUint16(14,0xFFFF,false); d.setUint16(18,0xFFFF,false);
    d.setInt16(20,1,false);
  } else {
    const segs = []; let i = 0;
    while (i < bmp.length) {
      const start = bmp[i].cp; let end = start; const gids = [bmp[i].gid]; let j = i + 1;
      while (j < bmp.length && bmp[j].cp === end + 1) { end = bmp[j].cp; gids.push(bmp[j].gid); j++; }
      segs.push({ start, end, gids }); i = j;
    }
    segs.push({ start: 0xFFFF, end: 0xFFFF, gids: [] });
    const sc = segs.length, mp2 = Math.floor(Math.log2(sc)), sr = (1 << mp2) * 2;
    const iroStart = 14 + sc*2 + 2 + sc*2 + sc*2;
    const gaStart = iroStart + sc*2;
    let totalG = 0; const gOff = [];
    for (const s of segs) { gOff.push(totalG); totalG += s.gids.length; }
    const sz = gaStart + totalG * 2;
    f4 = new Uint8Array(sz); const d = new DataView(f4.buffer);
    let o = 0;
    d.setUint16(o,4,false); o+=2; d.setUint16(o,sz,false); o+=2; d.setUint16(o,0,false); o+=2;
    d.setUint16(o,sc*2,false); o+=2; d.setUint16(o,sr,false); o+=2; d.setUint16(o,mp2,false); o+=2;
    d.setUint16(o,sc*2-sr,false); o+=2;
    for (const s of segs) { d.setUint16(o, s.end, false); o+=2; }
    d.setUint16(o, 0, false); o+=2;
    for (const s of segs) { d.setUint16(o, s.start, false); o+=2; }
    for (let k = 0; k < sc-1; k++) { d.setInt16(o, 0, false); o+=2; }
    d.setInt16(o, 1, false); o+=2;
    for (let k = 0; k < sc; k++) {
      if (!segs[k].gids.length) d.setUint16(o, 0, false);
      else d.setUint16(o, gaStart + gOff[k]*2 - o, false);
      o+=2;
    }
    for (const s of segs) for (const gid of s.gids) { d.setUint16(o, gid, false); o+=2; }
  }
  // cmap with 2 encoding records (0,3) and (3,1) both pointing to format 4
  const cmapHdr = 4 + 2 * 8;
  const cmapTotal = cmapHdr + f4.length;
  const cmapBuf = new Uint8Array(cmapTotal), cmapDv = new DataView(cmapBuf.buffer);
  cmapDv.setUint16(2, 2, false); // 2 subtables
  cmapDv.setUint16(4, 0, false); cmapDv.setUint16(6, 3, false); cmapDv.setUint32(8, cmapHdr, false);
  cmapDv.setUint16(12, 3, false); cmapDv.setUint16(14, 1, false); cmapDv.setUint32(16, cmapHdr, false);
  cmapBuf.set(f4, cmapHdr);

  // head table (54 bytes)
  const head = new Uint8Array(54), hd = new DataView(head.buffer);
  hd.setUint32(0, 0x00010000, false); hd.setUint32(4, 0x00010000, false);
  hd.setUint32(12, 0x5F0F3CF5, false); hd.setUint16(18, upm, false);
  hd.setInt16(36, clamp16(xMin), false); hd.setInt16(38, clamp16(yMin), false);
  hd.setInt16(40, clamp16(xMax), false); hd.setInt16(42, clamp16(yMax), false);
  hd.setUint16(46, 8, false); hd.setInt16(48, 2, false);

  // hhea table (36 bytes)
  const hhea = new Uint8Array(36), hh = new DataView(hhea.buffer);
  hh.setUint32(0, 0x00010000, false);
  hh.setInt16(4, clamp16(yMax || 800), false); hh.setInt16(6, clamp16(yMin || -200), false);
  if (metrics.length) hh.setUint16(10, Math.max(...metrics.map(m => m.advanceWidth)) >>> 0, false);
  hh.setInt16(18, 1, false); hh.setUint16(34, numGlyphs, false);

  // maxp table (6 bytes, version 0.5 for CFF)
  const maxp = new Uint8Array(6), mx = new DataView(maxp.buffer);
  mx.setUint32(0, 0x00005000, false); mx.setUint16(4, numGlyphs, false);

  // OS/2 table (78 bytes)
  const os2 = new Uint8Array(78), o2 = new DataView(os2.buffer);
  const avg = metrics.length ? Math.round(metrics.reduce((s,m) => s + m.advanceWidth, 0) / metrics.length) : 500;
  o2.setInt16(2, clamp16(avg), false); o2.setUint16(4, 400, false); o2.setUint16(6, 5, false);
  o2.setUint16(62, 0x0040, false);
  if (bmp.length) { o2.setUint16(64, bmp[0].cp, false); o2.setUint16(66, bmp[bmp.length-1].cp, false); }
  o2.setInt16(68, clamp16(yMax || 800), false); o2.setInt16(70, clamp16(yMin || -200), false);
  o2.setUint16(74, Math.max(0, clamp16(yMax || 800)) & 0xFFFF, false);
  o2.setUint16(76, Math.max(0, clamp16(-(yMin || -200))) & 0xFFFF, false);

  // hmtx table
  const hmtx = new Uint8Array(numGlyphs * 4), hm = new DataView(hmtx.buffer);
  for (let i = 0; i < numGlyphs; i++) {
    hm.setUint16(i*4, (metrics[i] ? metrics[i].advanceWidth : 0) >>> 0, false);
  }

  // name table
  const psName = fontName.replace(/[^A-Za-z0-9_.-]/g, '') || 'Font';
  const nameStrs = [
    { id: 1, t: fontName }, { id: 2, t: 'Regular' },
    { id: 4, t: fontName + ' Regular' }, { id: 6, t: psName }
  ];
  const toU16 = str => { const o = new Uint8Array(str.length*2); for (let i = 0; i < str.length; i++) { o[i*2] = (str.charCodeAt(i)>>8)&0xFF; o[i*2+1] = str.charCodeAt(i)&0xFF; } return o; };
  const nameRecs = nameStrs.map(n => ({ ...n, b: toU16(n.t) }));
  const nameHdr = 6 + nameRecs.length * 12;
  const nameStrLen = nameRecs.reduce((s, r) => s + r.b.length, 0);
  const nameTbl = new Uint8Array(nameHdr + nameStrLen), nd = new DataView(nameTbl.buffer);
  nd.setUint16(2, nameRecs.length, false); nd.setUint16(4, nameHdr, false);
  let nrOff = 6, nsOff = 0;
  for (const r of nameRecs) {
    nd.setUint16(nrOff, 3, false); nd.setUint16(nrOff+2, 1, false); nd.setUint16(nrOff+4, 0x0409, false);
    nd.setUint16(nrOff+6, r.id, false); nd.setUint16(nrOff+8, r.b.length, false); nd.setUint16(nrOff+10, nsOff, false);
    nameTbl.set(r.b, nameHdr + nsOff); nsOff += r.b.length; nrOff += 12;
  }

  // post table (32 bytes, version 3)
  const post = new Uint8Array(32); new DataView(post.buffer).setUint32(0, 0x00030000, false);

  // Assemble OTF (OTTO signature)
  const tables = { 'CFF ': cffBytes, 'OS/2': os2, cmap: cmapBuf, head, hhea, hmtx, maxp, name: nameTbl, post };
  const tags = Object.keys(tables).sort(), n = tags.length;
  const mp = Math.floor(Math.log2(n)), searchRange = (1 << mp) * 16;
  let off = 12 + n * 16;
  const pos = {}, padded = {};
  for (const t of tags) { pos[t] = off; const p = new Uint8Array((tables[t].length+3)&~3); p.set(tables[t]); padded[t] = p; off += p.length; }
  const result = new Uint8Array(off), dv = new DataView(result.buffer);
  dv.setUint32(0, 0x4F54544F, false); // 'OTTO'
  dv.setUint16(4, n, false); dv.setUint16(6, searchRange, false);
  dv.setUint16(8, mp, false); dv.setUint16(10, n*16-searchRange, false);
  for (let i = 0; i < n; i++) {
    const t = tags[i], d = padded[t], eo = 12 + i*16;
    for (let j = 0; j < 4; j++) result[eo+j] = t.charCodeAt(j) || 0x20;
    let sum = 0; const n4 = Math.floor(d.length/4);
    for (let k = 0; k < n4; k++) sum = (sum + ((d[k*4]<<24)|(d[k*4+1]<<16)|(d[k*4+2]<<8)|d[k*4+3])>>>0)>>>0;
    const rem = d.length % 4; if (rem) { let v = 0; for (let k = 0; k < rem; k++) v |= d[d.length-rem+k]<<(24-k*8); sum = (sum+(v>>>0))>>>0; }
    dv.setUint32(eo+4, sum, false); dv.setUint32(eo+8, pos[t], false); dv.setUint32(eo+12, tables[t].length, false);
    result.set(d, pos[t]);
  }
  // Fix head checksum
  if (pos['head'] != null) {
    const hp = pos['head']; dv.setUint32(hp+8, 0, false);
    let fs = 0; const fn4 = Math.floor(result.length/4);
    for (let i = 0; i < fn4; i++) fs = (fs + dv.getUint32(i*4, false)) >>> 0;
    const fr = result.length % 4; if (fr) { let v = 0; for (let i = 0; i < fr; i++) v |= result[fn4*4+i]<<(24-i*8); fs = (fs+(v>>>0))>>>0; }
    dv.setUint32(hp+8, (0xB1B0AFBA - fs) >>> 0, false);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// ANY → PFA CONVERSION (accessible from MiniConverter on convert pages)
// ═══════════════════════════════════════════════════════════════════

function _buildPFAFromFont(sfntBytes, type1Font, cffFont, fontName) {
  const clamp16 = v => Math.max(-32768, Math.min(32767, Math.round(v || 0)));
  const sane = s => { let o = ''; for (const ch of String(s||'')) if (/[A-Za-z0-9_.-]/.test(ch)) o += ch; return o || 'Font'; };
  const nameToUni = name => {
    if (!name || !window.glyphNameToUnicode) return null;
    const u = window.glyphNameToUnicode(name);
    return u != null ? (typeof u === 'string' ? u.codePointAt(0) : u) : null;
  };

  // -- Build glyph records from whatever input we have --
  const records = [];
  if (type1Font) {
    // Type1 → PFA: extract paths from Type1
    const encoding = type1Font.encoding || [];
    const seen = new Set();
    let idx = 0;
    records.push({ name: '.notdef', unicode: null, path: [], advanceWidth: 0 });
    seen.add('.notdef');
    // Load .notdef
    const nd = type1Font.loadGlyphByName('.notdef');
    if (nd && nd.path) records[0].path = nd.path;
    if (nd && nd.metrics && Number.isFinite(nd.metrics.advanceWidth)) records[0].advanceWidth = nd.metrics.advanceWidth;
    for (let code = 0; code < 256; code++) {
      const name = encoding[code];
      if (!name || name === '.notdef' || seen.has(name)) continue;
      seen.add(name);
      const g = type1Font.loadGlyphByName(name);
      const adv = g && g.metrics && Number.isFinite(g.metrics.advanceWidth) ? g.metrics.advanceWidth : 0;
      records.push({ name, unicode: nameToUni(name), path: (g && g.path) || [], advanceWidth: adv });
    }
    if (type1Font.charStrings) {
      for (const [name] of type1Font.charStrings) {
        if (seen.has(name)) continue;
        seen.add(name);
        const g = type1Font.loadGlyphByName(name);
        const adv = g && g.metrics && Number.isFinite(g.metrics.advanceWidth) ? g.metrics.advanceWidth : 0;
        records.push({ name, unicode: nameToUni(name), path: (g && g.path) || [], advanceWidth: adv });
      }
    }
  } else if (sfntBytes) {
    // TTF/OTF → PFA: parse SFNT and extract glyphs
    const ttf = new window.TTF(sfntBytes);
    ttf.parse();
    const cffTable = ttf.tables['CFF '];
    let cff = cffFont;
    if (cffTable && !cff) {
      cff = new window.CFFFont(sfntBytes.slice(cffTable.offset, cffTable.offset + cffTable.length));
      cff.parse();
    }
    const numGlyphs = ttf.numGlyphs || (cff && cff.glyphs ? cff.glyphs.length : 0) || 0;
    // Build reverse cmap
    const gidToUni = new Map();
    if (ttf.cmap) {
      for (const [cp, gid] of Object.entries(ttf.cmap)) {
        const cpNum = Number(cp);
        if (!gidToUni.has(gid) && Number.isInteger(cpNum) && cpNum > 0) gidToUni.set(gid, cpNum);
      }
    }
    for (let gid = 0; gid < numGlyphs; gid++) {
      let path = [], adv = 0, name = gid === 0 ? '.notdef' : `glyph${gid}`;
      if (cff) {
        const g = cff.loadGlyphByIndex(gid);
        if (g) { path = g.path || []; adv = (g.metrics && g.metrics.advanceWidth) || 0; }
        if (cff.charset && cff.charset[gid]) name = cff.charset[gid];
      } else {
        const g = ttf.loadGlyph(gid);
        if (g) {
          adv = g.advanceWidth || 0;
          path = pathToCubic(ttfContoursToQuadraticPath(g.contours || []));
        }
      }
      // Try to find a proper glyph name from unicode
      const uni = gidToUni.get(gid) || null;
      if (uni && name.startsWith('glyph') && window.getGlyphNameFromUnicode) {
        const n = window.getGlyphNameFromUnicode(uni);
        if (n) name = n;
      }
      records.push({ name, unicode: uni, path, advanceWidth: adv });
    }
  } else if (cffFont) {
    // Bare CFF → PFA: extract glyphs directly from CFF font object
    const numGlyphs = cffFont.glyphs ? cffFont.glyphs.length : 0;
    for (let gid = 0; gid < numGlyphs; gid++) {
      let path = [], adv = 0, name = gid === 0 ? '.notdef' : `glyph${gid}`;
      const g = cffFont.loadGlyphByIndex(gid);
      if (g) { path = g.path || []; adv = (g.metrics && g.metrics.advanceWidth) || 0; }
      if (cffFont.charset && cffFont.charset[gid]) name = cffFont.charset[gid];
      // Try to find unicode from glyph name
      const uni = nameToUni(name);
      if (uni && name.startsWith('glyph') && window.getGlyphNameFromUnicode) {
        const n = window.getGlyphNameFromUnicode(uni);
        if (n) name = n;
      }
      records.push({ name, unicode: uni, path, advanceWidth: adv });
    }
  }

  if (!records.length) records.push({ name: '.notdef', unicode: null, path: [], advanceWidth: 500 });

  // Scale to 1000 UPM if needed
  const sourceUPM = (type1Font && type1Font.unitsPerEm) || (sfntBytes && (() => { try { const t = new window.TTF(sfntBytes); t.parse(); return t.unitsPerEm; } catch(e) { return 1000; } })()) || 1000;
  const scale = 1000 / (sourceUPM || 1000);
  if (Math.abs(scale - 1) > 0.001) {
    for (const r of records) {
      r.advanceWidth = Math.round(r.advanceWidth * scale);
      r.path = r.path.map(s => {
        if (s.cmd === 'M' || s.cmd === 'L') return { cmd: s.cmd, x: s.x * scale, y: s.y * scale };
        if (s.cmd === 'C') return { cmd: 'C', x1: s.x1*scale, y1: s.y1*scale, x2: s.x2*scale, y2: s.y2*scale, x3: s.x3*scale, y3: s.y3*scale };
        return { cmd: s.cmd };
      });
    }
  }

  // -- Encode Type1 charstring from cubic path --
  function encodeT1Num(n) {
    n = clamp16(n);
    if (n >= -107 && n <= 107) return [n + 139];
    if (n >= 108 && n <= 1131) { const b = n - 108; return [Math.floor(b / 256) + 247, b % 256]; }
    if (n >= -1131 && n <= -108) { const m = -n - 108; return [Math.floor(m / 256) + 251, m % 256]; }
    return [28, (n >> 8) & 0xFF, n & 0xFF];
  }
  function buildCS(path, advWidth) {
    const b = [];
    const pn = n => b.push(...encodeT1Num(n));
    pn(0); pn(Math.round(advWidth || 0)); b.push(13); // hsbw
    let ax = 0, ay = 0; // current integer position
    let spx = 0, spy = 0; // subpath start (integer)
    let started = false;
    const first = (path || []).find(s => s.cmd === 'M');
    if (first) {
      const ix = Math.round(first.x), iy = Math.round(first.y);
      const dx = ix - ax, dy = iy - ay;
      pn(dx); pn(dy); b.push(21);
      ax = ix; ay = iy; spx = ax; spy = ay; started = true;
    }
    for (const s of (path || [])) {
      if (s.cmd === 'M') {
        if (!started) continue;
        const ix = Math.round(s.x), iy = Math.round(s.y);
        const dx = ix - ax, dy = iy - ay;
        if (dx || dy) { pn(dx); pn(dy); b.push(21); ax = ix; ay = iy; }
        spx = ax; spy = ay;
      } else if (s.cmd === 'L') {
        const ix = Math.round(s.x), iy = Math.round(s.y);
        const dx = ix - ax, dy = iy - ay;
        if (dx || dy) { pn(dx); pn(dy); b.push(5); ax = ix; ay = iy; }
      } else if (s.cmd === 'C') {
        const ix1 = Math.round(s.x1), iy1 = Math.round(s.y1);
        const ix2 = Math.round(s.x2), iy2 = Math.round(s.y2);
        const ix3 = Math.round(s.x3), iy3 = Math.round(s.y3);
        pn(ix1-ax); pn(iy1-ay); pn(ix2-ix1); pn(iy2-iy1); pn(ix3-ix2); pn(iy3-iy2);
        b.push(8); ax = ix3; ay = iy3;
      } else if (s.cmd === 'Z') {
        const cdx = spx - ax, cdy = spy - ay;
        if (cdx !== 0 || cdy !== 0) { pn(cdx); pn(cdy); b.push(5); ax = spx; ay = spy; }
        b.push(9);
      }
    }
    b.push(14); // endchar
    return new Uint8Array(b);
  }

  // -- Encrypt charstring --
  function csEncrypt(plain, lenIV) {
    const all = new Uint8Array(lenIV + plain.length);
    all.set(plain, lenIV);
    let r = 4330;
    const out = new Uint8Array(all.length);
    for (let i = 0; i < all.length; i++) { const c = (all[i] ^ (r >> 8)) & 0xFF; out[i] = c; r = ((c + r) * 52845 + 22719) & 0xFFFF; }
    return out;
  }
  function eexecEnc(plain) {
    const all = new Uint8Array(4 + plain.length);
    all.set(plain, 4);
    let r = 55665;
    const out = new Uint8Array(all.length);
    for (let i = 0; i < all.length; i++) { const c = (all[i] ^ (r >> 8)) & 0xFF; out[i] = c; r = ((c + r) * 52845 + 22719) & 0xFFFF; }
    return out;
  }
  function toHex(bytes, cpl) {
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    const lines = []; for (let i = 0; i < hex.length; i += cpl) lines.push(hex.slice(i, i + cpl));
    return lines.join('\n');
  }

  // -- Build PFA --
  const psName = sane(fontName);
  const lenIV = 4;

  // Adobe Standard Encoding tables
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
  const _aseNameToSlot = {};
  for (const [s, n] of Object.entries(_aseSlot)) _aseNameToSlot[n] = Number(s);

  // Build charstring map, renaming glyphs to ASE standard names
  const csMap = new Map();
  const usedCSNames = new Set();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    let name;
    if (i === 0) {
      name = '.notdef';
    } else {
      const stdName = r.unicode != null ? _aseFromUnicode[r.unicode] : undefined;
      name = (stdName && !usedCSNames.has(stdName)) ? stdName : (r.name || `g${i}`);
    }
    if (usedCSNames.has(name)) name = r.name || `g${i}`;
    usedCSNames.add(name);
    csMap.set(name, buildCS(r.path, r.advanceWidth));
  }
  if (!csMap.has('.notdef')) csMap.set('.notdef', new Uint8Array([139, 139, 13, 14]));

  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const r of records) {
    for (const s of (r.path || [])) {
      const pts = s.cmd === 'C' ? [[s.x1,s.y1],[s.x2,s.y2],[s.x3,s.y3]] : (s.x !== undefined ? [[s.x,s.y]] : []);
      for (const [x,y] of pts) { if (Number.isFinite(x)&&Number.isFinite(y)) { if(x<xMin)xMin=x; if(x>xMax)xMax=x; if(y<yMin)yMin=y; if(y>yMax)yMax=y; } }
    }
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

  // Build eexec section
  const enc = new TextEncoder();
  const parts = [];
  parts.push(enc.encode(`/lenIV ${lenIV} def\n`));
  parts.push(enc.encode('/RD {string currentfile exch readstring pop} executeonly def\n'));
  parts.push(enc.encode('/ND {noaccess def} executeonly def\n'));
  parts.push(enc.encode('/NP {noaccess put} executeonly def\n'));
  parts.push(enc.encode('/Subrs 0 array\n'));
  parts.push(enc.encode(`/CharStrings ${csMap.size} dict dup begin\n`));
  for (const [name, cs] of csMap) {
    const encrypted = csEncrypt(cs, lenIV);
    parts.push(enc.encode(`/${name} ${encrypted.length} RD `));
    parts.push(encrypted);
    parts.push(enc.encode(' ND\n'));
  }
  parts.push(enc.encode('end\n'));
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const decrypted = new Uint8Array(totalLen);
  let dOff = 0;
  for (const p of parts) { decrypted.set(p, dOff); dOff += p.length; }
  const hex = toHex(eexecEnc(decrypted), 64);

  let header = `%!PS-AdobeFont-1.0: ${psName} 1.0\n`;
  header += `11 dict begin\n`;
  header += `/FontName /${psName} def\n`;
  header += `/FontType 1 def\n`;
  header += `/PaintType 0 def\n`;
  header += `/StrokeWidth 0 def\n`;
  header += `/FontMatrix [0.001 0 0 0.001 0 0] readonly def\n`;
  header += `/FontBBox [${Math.floor(xMin)} ${Math.floor(yMin)} ${Math.ceil(xMax)} ${Math.ceil(yMax)}] readonly def\n`;
  // Check if any slot has a non-standard glyph name
  let hasNonStandard = false;
  for (let i = 0; i < 256; i++) {
    const cur = codeToName[i];
    if (cur === '.notdef') continue;
    const std = _aseSlot[i] || '.notdef';
    if (cur !== std) { hasNonStandard = true; break; }
  }
  if (!hasNonStandard) {
    header += `/Encoding StandardEncoding def\n`;
  } else {
    header += `/Encoding StandardEncoding 256 array copy\n`;
    for (let code = 0; code < 256; code++) {
      const cur = codeToName[code];
      if (cur === '.notdef') continue;
      const std = _aseSlot[code] || '.notdef';
      if (cur !== std) {
        const n = sane(cur);
        header += `dup ${code} /${n === 'notdef' ? '.notdef' : n} put\n`;
      }
    }
    header += `readonly def\n`;
  }
  header += `/FamilyName (${(fontName||'Font').replace(/[()]/g, '')}) def\n`;
  header += `currentdict end\n`;
  header += `currentfile eexec\n`;
  const footer = '\n0000000000000000000000000000000000000000000000000000000000000000\ncleartomark\n';
  const hBytes = enc.encode(header), hexBytes = enc.encode(hex), fBytes = enc.encode(footer);
  const out = new Uint8Array(hBytes.length + hexBytes.length + fBytes.length);
  out.set(hBytes, 0); out.set(hexBytes, hBytes.length); out.set(fBytes, hBytes.length + hexBytes.length);
  return out;
}

function _buildType1AdapterFromSvgFont(svgFont) {
  const glyphs = Array.isArray(svgFont && svgFont.glyphs) ? svgFont.glyphs : [];
  const glyphMap = new Map();
  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i] || {};
    const fallbackName = i === 0 ? '.notdef' : `glyph${i}`;
    glyphMap.set(glyph.name || fallbackName, glyph);
  }
  if (!glyphMap.has('.notdef')) {
    glyphMap.set('.notdef', { name: '.notdef', path: [], advanceWidth: 0 });
  }

  return {
    encoding: [],
    charStrings: glyphMap,
    unitsPerEm: svgFont && svgFont.unitsPerEm ? svgFont.unitsPerEm : 1000,
    loadGlyphByName(name) {
      const glyph = glyphMap.get(name);
      if (!glyph) return null;
      const path = Array.isArray(glyph.path)
        ? glyph.path.map(seg => window.SVGFontUtils && window.SVGFontUtils.cloneSegment
          ? window.SVGFontUtils.cloneSegment(seg)
          : { ...seg })
        : [];
      return {
        path,
        metrics: {
          advanceWidth: Number(glyph.advanceWidth) || 0
        }
      };
    }
  };
}

function _extractSVGMetadataStandalone(svgFont) {
  const meta = Object.assign({
    family: 'SVG Font',
    postScript: '',
    version: '',
    copyright: '',
    license: '',
    licenseUrl: '',
    trademark: '',
    designer: '',
    manufacturer: ''
  }, (svgFont && svgFont.metadata) || {});
  if (!meta.family) meta.family = (svgFont && svgFont.family) || 'SVG Font';
  if (!meta.postScript) meta.postScript = (svgFont && svgFont.postScriptName) || meta.family || '';
  return meta;
}

function readPostScriptLiteralString(source, openParenIndex) {
  if (typeof source !== 'string' || source[openParenIndex] !== '(') return null;
  let out = '';
  let depth = 1;
  for (let i = openParenIndex + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      if (i + 1 >= source.length) break;
      const next = source[++i];
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === 'b') out += '\b';
      else if (next === 'f') out += '\f';
      else if (next === '\r' || next === '\n') {
        if (next === '\r' && source[i + 1] === '\n') i++;
      } else if (/[0-7]/.test(next)) {
        let oct = next;
        for (let j = 0; j < 2 && i + 1 < source.length && /[0-7]/.test(source[i + 1]); j++) {
          oct += source[++i];
        }
        out += String.fromCharCode(parseInt(oct, 8) & 0xFF);
      } else {
        out += next;
      }
      continue;
    }
    if (ch === '(') {
      depth++;
      out += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) return { value: out, end: i + 1 };
      out += ch;
      continue;
    }
    out += ch;
  }
  return null;
}

function readPostScriptNamedString(source, name) {
  if (typeof source !== 'string' || !name) return '';
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('/' + escapedName + '\\s*\\(', 'i').exec(source);
  if (!match) return '';
  const openParenIndex = match.index + match[0].lastIndexOf('(');
  const parsed = readPostScriptLiteralString(source, openParenIndex);
  return parsed ? parsed.value.trim() : '';
}

function _buildGlyphRecordsFromFontStandalone(sfntBytes, type1Font, cffFont, svgFont) {
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
  const miniScaleCubicPath = (path, scale) => {
    if (!Number.isFinite(scale) || Math.abs(scale - 1) < 1e-9) return (path || []).map(s => ({ ...s }));
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
  };
  const nameToUni = name => {
    if (!name || !window.glyphNameToUnicode) return null;
    const u = window.glyphNameToUnicode(name);
    return u != null ? (typeof u === 'string' ? u.codePointAt(0) : u) : null;
  };
  const reverseCmapFromTTF = (ttf) => {
    const map = new Map();
    if (!ttf || !ttf.cmap) return map;
    for (const [cpText, gid] of Object.entries(ttf.cmap)) {
      const cp = Number(cpText);
      if (!map.has(gid) && Number.isInteger(cp) && cp > 0) map.set(gid, cp);
    }
    return map;
  };

  let sourceUnits = 1000;
  const records = [];

  if (svgFont && Array.isArray(svgFont.glyphs)) {
    sourceUnits = svgFont.unitsPerEm || 1000;
    for (const glyph of svgFont.glyphs) {
      records.push({
        name: glyph.name || (records.length === 0 ? '.notdef' : `glyph${records.length}`),
        unicode: Number.isInteger(glyph.unicode) ? glyph.unicode : null,
        path: Array.isArray(glyph.path)
          ? glyph.path.map(seg => window.SVGFontUtils && window.SVGFontUtils.cloneSegment ? window.SVGFontUtils.cloneSegment(seg) : ({ ...seg }))
          : [],
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
    if (nd && nd.path) records[0].path = miniPathToCubic(nd.path);
    if (nd && nd.metrics && Number.isFinite(nd.metrics.advanceWidth)) records[0].advanceWidth = nd.metrics.advanceWidth;
    for (let code = 0; code < 256; code++) {
      const name = encoding[code];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const g = type1Font.loadGlyphByName(name);
      records.push({
        name,
        unicode: nameToUni(name),
        path: miniPathToCubic((g && g.path) || []),
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
          path: miniPathToCubic((g && g.path) || []),
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
    const reverseCmap = reverseCmapFromTTF(ttf);
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
          name: gid === 0 ? '.notdef' : `glyph${gid}`,
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
    record.path = miniScaleCubicPath(record.path, scale);
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

class MiniConverter {
  constructor(targetFormat) {
    this.targetFormat = targetFormat;
    this.convertedBlob = null;
    this.originalFileName = '';
  }

  async convertFile(file) {
    this.originalFileName = file.name;
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    try {
      const result = await this.processFont(bytes);

      // Store converted blob
      this.convertedBlob = new Blob([result.converted], {
        type: 'application/octet-stream'
      });

      return {
        fontName: result.fontName,
        glyphCount: result.glyphCount,
        previewData: result.previewData,
        metadata: result.metadata || {},
        success: true
      };
    } catch (error) {
      if (error && error.message === 'FONT_IMPORT_FAILED') {
        throw new Error('Oops, something went wrong');
      }
      throw new Error(`Conversion failed: ${error.message}`);
    }
  }

  async processFont(bytes) {
    let sfntBytes = null;
    let ttf = null;
    let cffFont = null;
    let type1Font = null;
    let svgFont = null;
    let fontName = 'Unknown Font';
    let glyphCount = 0;
    let metadata = { license: '', copyright: '', version: '', designer: '', manufacturer: '' };

    // Detect and parse input format
    const signature = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    const extHint = detectContainerExtHint('', bytes);

    // WOFF
    if (signature === 0x774F4646) {
      sfntBytes = await decodeWOFFToSfnt(bytes);
      ttf = new window.TTF(sfntBytes);
      ttf.parse();
      const nameRec = ttf.tables['name'];
      fontName = nameRec ? 'Font' : 'Unknown';
      glyphCount = ttf.numGlyphs || 0;
    }
    // WOFF2
    else if (signature === 0x774F4632) {
      sfntBytes = await decodeWOFF2ToSfnt(bytes);
      ttf = new window.TTF(sfntBytes);
      ttf.parse();
      const nameRec = ttf.tables['name'];
      fontName = nameRec ? 'Font' : 'Unknown';
      glyphCount = ttf.numGlyphs || 0;
    }
    // TTF/OTF (SFNT)
    else if (signature === 0x00010000 || signature === 0x4F54544F || signature === 0x74727565) {
      sfntBytes = bytes;
      ttf = new window.TTF(bytes);

      const cffTable = ttf.tables['CFF '];
      ttf.parse();
      if (cffTable) {
        const cffData = bytes.slice(cffTable.offset, cffTable.offset + cffTable.length);
        cffFont = new window.CFFFont(cffData);
        fontName = cffFont.name || 'Unknown';
        glyphCount = cffFont.glyphs?.length || 0;
      } else {
        const nameRec = ttf.tables['name'];
        fontName = nameRec ? 'Font' : 'Unknown';
        glyphCount = ttf.numGlyphs || 0;
      }
    }
    // CFF
    else if (bytes[0] === 0x01 && bytes[1] === 0x00) {
      cffFont = new window.CFFFont(bytes);
      cffFont.parse();
      fontName = cffFont.name || 'Unknown';
      glyphCount = cffFont.glyphs?.length || 0;
      // Build TTF from CFF glyphs for preview (adapter delegates to CFF's own methods)
      sfntBytes = _buildTTFFromType1({
        encoding: [],
        charStrings: cffFont.charStrings || new Map(),
        unitsPerEm: cffFont.unitsPerEm || 1000,
        loadGlyphByName(name) { return cffFont.loadGlyphByName(name); }
      }, fontName);
    }
    // Type1 (PFA/PFB)
    else if ((bytes[0] === 0x80 && (bytes[1] === 0x01 || bytes[1] === 0x02)) || bytes[0] === 0x25 || extHint === 'pfa') {
      type1Font = new window.Type1Font(bytes);
      type1Font.parse();

      // Extract font name from PFA header (/FontName /Name def)
      try {
        const headerBytes = (type1Font && type1Font.bytes) ? type1Font.bytes : bytes;
        const headerText = new TextDecoder('latin1').decode(headerBytes.slice(0, Math.min(headerBytes.length, 4096)));
        const nameMatch = headerText.match(/\/FontName\s+\/(\S+)/);
        fontName = nameMatch ? nameMatch[1] : 'Unknown';
      } catch (e) { fontName = 'Unknown'; }
      glyphCount = type1Font.charStrings.size;

      sfntBytes = _buildTTFFromType1(type1Font, fontName);
    }
    // SVG font
    else {
      if (extHint === 'svg') {
        if (!window.SVGFontUtils || typeof window.SVGFontUtils.parseSvgFont !== 'function') {
          throw new Error('SVG support not loaded');
        }
        svgFont = window.SVGFontUtils.parseSvgFont(bytes);
        fontName = svgFont.family || svgFont.postScriptName || 'SVG Font';
        glyphCount = Array.isArray(svgFont.glyphs) ? svgFont.glyphs.length : 0;
        metadata = _extractSVGMetadataStandalone(svgFont);
        sfntBytes = _buildTTFFromType1(
          _buildType1AdapterFromSvgFont(svgFont),
          metadata.family || fontName
        );
      } else {
        throw new Error('Unsupported font format');
      }
    }

    // Convert to target format
    let converted, previewData;
    const needsSvgRecords = this.targetFormat === 'cff' || this.targetFormat === 'pfa' ||
      this.targetFormat === 'pfb' || this.targetFormat === 'svg';
    const svgRecordsData = needsSvgRecords
      ? _buildGlyphRecordsFromFontStandalone(sfntBytes, type1Font, cffFont, svgFont)
      : null;

    switch (this.targetFormat) {
      case 'ttf':
      case 'otf':
        if (!sfntBytes) throw new Error('Cannot convert to TTF/OTF from this format');
        converted = sfntBytes;
        previewData = sfntBytes;
        break;

      case 'woff':
        if (!sfntBytes) throw new Error('Cannot convert to WOFF from this format');
        converted = await encodeSfntToWOFF(sfntBytes);
        previewData = sfntBytes; // Preview uses decoded SFNT
        break;

      case 'woff2':
        if (!sfntBytes) throw new Error('Cannot convert to WOFF2 from this format');
        converted = await encodeSfntToWOFF2(sfntBytes);
        previewData = sfntBytes; // Preview uses decoded SFNT
        break;

      case 'cff':
        if (cffFont) {
          converted = bytes; // Already CFF
          previewData = this.wrapCFFInOTF(bytes);
        } else if (svgRecordsData) {
          converted = buildCFFFromGlyphRecords(svgRecordsData.records, fontName);
          previewData = this.wrapCFFInOTF(converted);
        } else {
          throw new Error('Cannot extract CFF from this font');
        }
        break;

      case 'pfa':
      case 'pfb': {
        const pfaBytes = svgRecordsData && !type1Font && !cffFont
          ? buildType1FromGlyphRecords(svgRecordsData.records, fontName, fontName, metadata)
          : _buildPFAFromFont(sfntBytes, type1Font, cffFont, fontName);
        converted = pfaBytes;
        previewData = sfntBytes || (type1Font ? _buildTTFFromType1(type1Font, fontName) : (cffFont ? this.wrapCFFInOTF(bytes) : null));
        break;
      }

      case 'svg':
        if (!window.SVGFontUtils || typeof window.SVGFontUtils.buildSvgFontFromGlyphRecords !== 'function') {
          throw new Error('SVG support not loaded');
        }
        if (!svgRecordsData) {
          throw new Error('Cannot convert to SVG from this format');
        }
        converted = window.SVGFontUtils.buildSvgFontFromGlyphRecords(svgRecordsData.records, {
          family: metadata.family || fontName,
          postScriptName: metadata.postScript || fontName,
          unitsPerEm: 1000,
          defaultAdvanceWidth: svgRecordsData.records.find(r => r.name === '.notdef')?.advanceWidth || 1000,
          metadata
        });
        previewData = sfntBytes;
        break;

      default:
        throw new Error(`Unknown target format: ${this.targetFormat}`);
    }

    // Extract metadata (license, copyright, version) from whichever font we parsed
    if (ttf && ttf.tables['name']) {
      const v = ttf.table('name'), buf = ttf.buf, dv = ttf.dv;
      let off = v.byteOffset;
      const count = dv.getUint16(off + 2, false), stringOff = dv.getUint16(off + 4, false);
      off += 6;
      const nameMap = { 0: 'copyright', 5: 'version', 7: 'trademark', 8: 'manufacturer', 9: 'designer', 13: 'license', 14: 'licenseUrl' };
      for (let i = 0; i < count; i++) {
        const platformID = dv.getUint16(off, false), encodingID = dv.getUint16(off + 2, false);
        const nameID = dv.getUint16(off + 6, false), length = dv.getUint16(off + 8, false);
        const strOffset = dv.getUint16(off + 10, false); off += 12;
        const field = nameMap[nameID];
        if (!field || metadata[field]) continue;
        const dataStart = v.byteOffset + stringOff + strOffset;
        const strData = new Uint8Array(buf, dataStart, length);
        let str = '';
        if (platformID === 3 || (platformID === 0 && encodingID >= 3))
          for (let j = 0; j + 1 < strData.length; j += 2) str += String.fromCharCode((strData[j] << 8) | strData[j + 1]);
        else
          for (let j = 0; j < strData.length; j++) str += String.fromCharCode(strData[j]);
        if (str.trim()) metadata[field] = str.trim();
      }
    } else if (type1Font && type1Font.bytes) {
      try {
        const hdr = new TextDecoder('latin1').decode(type1Font.bytes.slice(0, Math.min(type1Font.bytes.length, 8192)));
        const lm = hdr.match(/%+\s*License:\s*(.+?)(?:\n|$)/i);
        if (lm) metadata.license = lm[1].trim();
        const lum = hdr.match(/%+\s*License\s+URL:\s*(.+?)(?:\n|$)/i);
        if (lum) metadata.licenseUrl = lum[1].trim();
        const cm = hdr.match(/%+\s*Copyright:\s*(.+?)(?:\n|$)/i);
        if (cm) metadata.copyright = cm[1].trim();
        if (!metadata.license) metadata.license = readPostScriptNamedString(hdr, 'Notice');
        if (!metadata.copyright) {
          metadata.copyright = readPostScriptNamedString(hdr, 'Copyright') ||
            readPostScriptNamedString(hdr, 'Notice');
        }
      } catch(e) {}
    }

    return { fontName, glyphCount, converted, previewData, metadata };
  }

  // Wrap CFF in minimal OTF for preview
  wrapCFFInOTF(cffBytes) {
    return _wrapCFFInOTF(cffBytes);
  }

  download() {
    if (!this.convertedBlob) {
      throw new Error('No converted file available');
    }

    const url = URL.createObjectURL(this.convertedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.originalFileName.replace(/\.[^.]+$/, '') + '.' + this.targetFormat;
    a.click();
    URL.revokeObjectURL(url);
  }

  applyFontToPreview(previewData, previewElementId) {
    // Detect mime type from actual preview data bytes (previewData may differ from targetFormat,
    // e.g. PFA output uses TTF for preview since browsers can't render Type1 directly)
    let mimeType = 'application/octet-stream';
    if (previewData && previewData.length >= 4) {
      const sig = (previewData[0] << 24 | previewData[1] << 16 | previewData[2] << 8 | previewData[3]) >>> 0;
      if (sig === 0x00010000 || sig === 0x74727565) mimeType = 'font/ttf';
      else if (sig === 0x4F54544F) mimeType = 'font/otf';
      else if (sig === 0x774F4646) mimeType = 'font/woff';
      else if (sig === 0x774F4632) mimeType = 'font/woff2';
    }

    const blob = new Blob([previewData], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const fontFace = new FontFace('PreviewFont', `url(${url})`);

    fontFace.load().then(loaded => {
      document.fonts.add(loaded);
      const element = document.getElementById(previewElementId);
      if (element) {
        element.style.fontFamily = 'PreviewFont';
      }
    }).catch(err => {
      console.error('Font preview failed:', err);
    });
  }
}

// Expose MiniConverter for use in conversion pages
window.MiniConverter = MiniConverter;
window.supportsWoff2Export = window.supportsWoff2Export || function supportsWoff2Export() { return true; };
