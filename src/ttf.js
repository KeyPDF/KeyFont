// TrueType Font (TTF) parser
// Parses binary TrueType fonts and extracts glyph outlines
// Implementation Notes:
// - Prioritizes standard Unicode cmap subtables
// - Handles Windows Symbol (3,0) with 0xF000-0xF0FF remapping for symbolic fonts
// - Extracts PostScript and family names from the OpenType name table
// - Supports both simple and composite font width calculations

(function() {

class TTF {
    constructor(buf) {
        this.tables = {};
        this.unitsPerEm = 1000;
        this.indexToLocFormat = 0;
        this.numGlyphs = 0;
        this.ascender = 0;
        this.descender = 0;
        this.numberOfHMetrics = 0;
        this.hmtx = [];
        this.cmap = (cp) => 0;
        this.cmapFormat0 = null;
        this.isCFF = false;
        this.loca = [];
        this.glyphCache = new Map();
        const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        this.buf = bytes.buffer;
        this.bufOffset = bytes.byteOffset;
        this.bufLength = bytes.byteLength;
        this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    table(tag) {
        const t = this.tables[tag];
        if (!t) return null;
        return new DataView(this.buf, t.offset, t.length);
    }
    getOpenTypeSvgDocument(glyphId) {
        const table = this.tables['SVG '];
        if (!table || !Number.isInteger(glyphId) || glyphId < 0 || table.length < 12)
            return null;
        const tableView = new DataView(this.buf, table.offset, table.length);
        const documentIndexOffset = tableView.getUint32(2, false);
        if (documentIndexOffset + 2 > table.length)
            return null;
        const indexOffset = table.offset + documentIndexOffset;
        const entryCount = this.dv.getUint16(indexOffset, false);
        let entryOffset = indexOffset + 2;
        for (let i = 0; i < entryCount; i++, entryOffset += 12) {
            if (entryOffset + 12 > table.offset + table.length)
                break;
            const startGlyphId = this.dv.getUint16(entryOffset, false);
            const endGlyphId = this.dv.getUint16(entryOffset + 2, false);
            if (glyphId < startGlyphId || glyphId > endGlyphId)
                continue;
            const documentOffset = this.dv.getUint32(entryOffset + 4, false);
            const documentLength = this.dv.getUint32(entryOffset + 8, false);
            const start = indexOffset + documentOffset;
            const end = start + documentLength;
            if (start < table.offset || end > table.offset + table.length)
                return null;
            return new Uint8Array(this.buf, start, documentLength).slice();
        }
        return null;
    }
    parse() {
        const dv = this.dv;
        let off = 0;
        const scalerType = this.u32(off);
        off += 4;
        const numTables = this.u16(off);
        off += 2;
        off += 6; // skip searchRange/entrySelector/rangeShift
        if (this.tagStr(scalerType) === 'OTTO')
            this.isCFF = true;
        for (let i = 0; i < numTables; i++) {
            const tag = this.u32(off);
            off += 4;
            const checksum = this.u32(off);
            off += 4;
            const toffset = this.u32(off);
            off += 4;
            const length = this.u32(off);
            off += 4;
            this.tables[this.tagStr(tag)] = { offset: toffset, length };
        }
        this.parseHead();
        this.parseMaxp();
        this.parseHhea();
        this.parseHmtx();
        if (this.tables['loca'] && this.tables['glyf'])
            this.parseLoca();
        if (this.tables['cmap'])
            this.parseCmap();
    }
    u16(o) { return this.dv.getUint16(o, false); }
    s16(o) { return this.dv.getInt16(o, false); }
    u32(o) { return this.dv.getUint32(o, false); }
    s32(o) { return this.dv.getInt32(o, false); }
    tagStr(u) { return String.fromCharCode((u >> 24) & 255, (u >> 16) & 255, (u >> 8) & 255, u & 255); }
    parseHead() {
        const v = this.table('head');
        this.unitsPerEm = this.u16(v.byteOffset + 18);
        this.indexToLocFormat = this.s16(v.byteOffset + 50);
        // Font-wide bounding box from the TrueType head table.
        this.xMin = this.s16(v.byteOffset + 36);
        this.yMin = this.s16(v.byteOffset + 38);
        this.xMax = this.s16(v.byteOffset + 40);
        this.yMax = this.s16(v.byteOffset + 42);
    }
    parseMaxp() {
        const v = this.table('maxp');
        this.numGlyphs = this.u16(v.byteOffset + 4);
    }
    parseHhea() {
        const v = this.table('hhea');
        this.ascender = this.s16(v.byteOffset + 4);
        this.descender = this.s16(v.byteOffset + 6);
        this.lineGap = this.s16(v.byteOffset + 8);
        this.numberOfHMetrics = this.u16(v.byteOffset + 34);
    }
    parseHmtx() {
        const v = this.table('hmtx');
        const n = this.numberOfHMetrics;
        this.hmtx = new Array(this.numGlyphs);
        let o = v.byteOffset;
        let lastAdv = 0;
        for (let i = 0; i < n; i++) {
            const adv = this.u16(o);
            o += 2;
            const lsb = this.s16(o);
            o += 2;
            this.hmtx[i] = { advanceWidth: adv, lsb };
            lastAdv = adv;
        }
        // Bounds check: ensure we don't read beyond the table
        const tableEnd = v.byteOffset + v.byteLength;
        for (let i = n; i < this.numGlyphs; i++) {
            // Check if there's enough space to read an s16 (2 bytes)
            if (o + 2 <= tableEnd) {
                const lsb = this.s16(o);
                o += 2;
                this.hmtx[i] = { advanceWidth: lastAdv, lsb };
            } else {
                // Use last lsb if we've run out of data
                const lastLsb = i > 0 ? this.hmtx[i - 1].lsb : 0;
                this.hmtx[i] = { advanceWidth: lastAdv, lsb: lastLsb };
            }
        }
    }
    parseLoca() {
        const v = this.table('loca');
        const count = this.numGlyphs + 1;
        this.loca = new Array(count);
        if (this.indexToLocFormat === 0) {
            for (let i = 0; i < count; i++)
                this.loca[i] = this.u16(v.byteOffset + i * 2) * 2;
        }
        else {
            for (let i = 0; i < count; i++)
                this.loca[i] = this.u32(v.byteOffset + i * 4);
        }
    }
    parseCmap() {
        const v = this.table('cmap');
        let off = v.byteOffset;
        const version = this.u16(off);
        off += 2;
        const numTables = this.u16(off);
        off += 2;
        const subs = [];
        for (let i = 0; i < numTables; i++) {
            const platformID = this.u16(off);
            const encodingID = this.u16(off + 2);
            const subOff = this.u32(off + 4);
            off += 8;
            const format = this.u16(v.byteOffset + subOff);
            subs.push({ platformID, encodingID, format, subOff });
        }

        // Store format 0 separately for fallback
        const format0 = subs.find(s => s.format === 0);
        if (format0) {
            this.cmapFormat0 = this._cmap0(v, format0.subOff);
        }

        // Prefer standard Unicode cmap subtables, then legacy symbol/Mac mappings:
        // 1. Windows Unicode BMP (3,1) - Microsoft Unicode encoding
        // 2. Windows UCS-4 (3,10) - for supplementary planes
        // 3. Unicode platform (0,*) - platform-independent Unicode
        // 4. Windows Symbol (3,0) - symbolic fonts with 0xF000-0xF0FF range
        // 5. Mac Roman (1,0) - legacy Macintosh encoding
        const formatPrefs = [12, 10, 4, 6, 0];
        const platformPrefs = [
            // Windows Unicode (prefer BMP, then UCS-4)
            { platformID: 3, enc: [1, 10], isSymbolic: false },
            // Unicode platform (all encodings)
            { platformID: 0, enc: [4, 3, 2, 1, 0], isSymbolic: false },
            // Windows Symbol (for symbolic/Pi/Dingbat fonts)
            { platformID: 3, enc: [0], isSymbolic: true },
            // Mac Roman fallback
            { platformID: 1, enc: [0], isSymbolic: false },
        ];

        const pick = () => {
            for (const pf of platformPrefs) {
                for (const f of formatPrefs) {
                    const t = subs.find(s =>
                        s.platformID === pf.platformID &&
                        pf.enc.includes(s.encodingID) &&
                        s.format === f
                    );
                    if (t) {
                        t.isSymbolic = pf.isSymbolic;
                        return t;
                    }
                }
            }
            // Last resort: any known format
            for (const f of formatPrefs) {
                const t = subs.find(s => s.format === f);
                if (t) return t;
            }
            return null;
        };

        const buildCmapForSubtable = (sub) => {
            switch (sub.format) {
                case 0:
                    return this._cmap0(v, sub.subOff);
                case 4:
                    return this._cmap4(v, sub.subOff);
                case 6:
                    return this._cmap6(v, sub.subOff);
                case 10:
                    return this._cmap10(v, sub.subOff);
                case 12:
                    return this._cmap12(v, sub.subOff);
                default:
                    return (cp) => 0;
            }
        };
        const wrapSymbolicRemap = (sub, baseCmap) => {
            if (sub.platformID === 3 && sub.encodingID === 0) {
                return (cp) => {
                    let gid = baseCmap(cp);
                    if (gid !== 0)
                        return gid;
                    if (cp < 256) {
                        gid = baseCmap(0xF000 + cp);
                        if (gid !== 0)
                            return gid;
                    }
                    return 0;
                };
            }
            return baseCmap;
        };
        const scoreSubtable = (sub) => {
            const cmapFn = wrapSymbolicRemap(sub, buildCmapForSubtable(sub));
            let mapped = 0;
            let outlined = 0;
            for (let cp = 32; cp <= 126; cp++) {
                const gid = cmapFn(cp);
                if (!Number.isFinite(gid) || gid <= 0 || gid >= this.numGlyphs)
                    continue;
                mapped++;
                const range = this.glyphRange(gid);
                if (range.length > 0)
                    outlined++;
            }
            return { mapped, outlined, score: outlined * 10 + mapped };
        };
        let chosen = pick() || subs[0];
        if (!chosen) {
            this.cmap = (cp) => 0;
            this.isSymbolicFont = false;
            return;
        }
        if (chosen.platformID === 1 && chosen.encodingID === 0) {
            const known = subs.filter(s => [0, 4, 6, 10, 12].includes(s.format));
            if (known.length > 1) {
                let best = chosen;
                let bestScore = scoreSubtable(chosen).score;
                for (const sub of known) {
                    const { score } = scoreSubtable(sub);
                    if (score > bestScore) {
                        best = sub;
                        bestScore = score;
                    }
                }
                chosen = best;
            }
        }

        // Track if this is a symbolic font for proper encoding handling
        this.isSymbolicFont = chosen.isSymbolic || false;
        this.cmapPlatform = chosen.platformID;
        this.cmapEncoding = chosen.encodingID;

        // Create the cmap function
        const baseCmap = buildCmapForSubtable(chosen);

        // Windows Symbol cmap subtables map byte codes into 0xF000-0xF0FF.
        this.cmap = wrapSymbolicRemap(chosen, baseCmap);

        // Store chosen subtable info for direct enumeration
        this._cmapChosen = chosen;
        this._cmapTableView = v;
    }
    _cmap0(v, off) {
        const arr = new Uint8Array(v.buffer, v.byteOffset + off + 6, 256);
        return code => (code < 256 ? arr[code] : 0);
    }
    _cmap6(v, off) {
        const firstCode = this.u16(v.byteOffset + off + 6);
        const entryCount = this.u16(v.byteOffset + off + 8);
        const res = new Uint16Array(entryCount);
        let p = v.byteOffset + off + 10;
        for (let i = 0; i < entryCount; i++)
            res[i] = this.u16(p + i * 2);
        return code => { const idx = code - firstCode; return (idx >= 0 && idx < entryCount) ? res[idx] : 0; };
    }
    _cmap10(v, off) {
        const startChar = this.u32(v.byteOffset + off + 12);
        const numChars = this.u32(v.byteOffset + off + 16);
        const res = new Uint16Array(numChars);
        let p = v.byteOffset + off + 20;
        for (let i = 0; i < numChars; i++)
            res[i] = this.u16(p + i * 2);
        return code => { const idx = code - startChar; return (idx >= 0 && idx < numChars) ? res[idx] : 0; };
    }
    _cmap12(v, off) {
        const nGroups = this.u32(v.byteOffset + off + 12);
        const groupsOff = v.byteOffset + off + 16;
        const groups = new Uint32Array(nGroups * 3);
        for (let i = 0; i < nGroups; i++) {
            groups[i * 3] = this.u32(groupsOff + i * 12);
            groups[i * 3 + 1] = this.u32(groupsOff + i * 12 + 4);
            groups[i * 3 + 2] = this.u32(groupsOff + i * 12 + 8);
        }
        return code => {
            for (let i = 0; i < nGroups; i++) {
                const s = groups[i * 3], e = groups[i * 3 + 1], g0 = groups[i * 3 + 2];
                if (code >= s && code <= e)
                    return g0 + (code - s);
            }
            return 0;
        };
    }
    _cmap4(v, off) {
        const segCount = this.u16(v.byteOffset + off + 6) / 2;
        const endCountOff = v.byteOffset + off + 14;
        const startCountOff = endCountOff + 2 + segCount * 2;
        const idDeltaOff = startCountOff + segCount * 2;
        const idRangeOffOff = idDeltaOff + segCount * 2;
        const dvLimit = this.bufLength;
        const endCount = i => this.u16(endCountOff + i * 2);
        const startCount = i => this.u16(startCountOff + i * 2);
        const idDelta = i => this.s16(idDeltaOff + i * 2);
        const idRangeOffset = i => this.u16(idRangeOffOff + i * 2);
        return code => {
            let i = 0;
            for (; i < segCount; i++)
                if (code <= endCount(i))
                    break;
            if (i === segCount || code < startCount(i))
                return 0;
            const ro = idRangeOffset(i);
            if (ro === 0)
                return (code + idDelta(i)) & 0xFFFF;
            const pos = idRangeOffOff + i * 2 + ro + 2 * (code - startCount(i));
            if (pos + 1 >= dvLimit) return 0;
            const gid = this.u16(pos);
            if (gid === 0)
                return 0;
            return (gid + idDelta(i)) & 0xFFFF;
        };
    }
    cmapEntries() {
        const pairs = [];
        const chosen = this._cmapChosen;
        const v = this._cmapTableView;
        if (!chosen || !v) {
            // Fallback: probe BMP only using cmap function
            for (let cp = 1; cp <= 0xFFFF; cp++) {
                if (cp >= 0xD800 && cp <= 0xDFFF) continue;
                const gid = this.cmap(cp);
                if (gid > 0) pairs.push({ cp, gid });
            }
            return pairs;
        }
        const isSymbolic = chosen.platformID === 3 && chosen.encodingID === 0;
        const off = chosen.subOff;
        switch (chosen.format) {
            case 0: {
                const arr = new Uint8Array(v.buffer, v.byteOffset + off + 6, 256);
                for (let cp = 0; cp < 256; cp++) {
                    if (arr[cp] > 0) pairs.push({ cp, gid: arr[cp] });
                }
                break;
            }
            case 4: {
                const segCount = this.u16(v.byteOffset + off + 6) / 2;
                const endCountOff = v.byteOffset + off + 14;
                const startCountOff = endCountOff + 2 + segCount * 2;
                const idDeltaOff = startCountOff + segCount * 2;
                const idRangeOffOff = idDeltaOff + segCount * 2;
                const dvLimit = this.bufLength;
                for (let i = 0; i < segCount; i++) {
                    const start = this.u16(startCountOff + i * 2);
                    const end = this.u16(endCountOff + i * 2);
                    if (start === 0xFFFF) continue;
                    const delta = this.s16(idDeltaOff + i * 2);
                    const ro = this.u16(idRangeOffOff + i * 2);
                    for (let cp = start; cp <= end; cp++) {
                        let gid;
                        if (ro === 0) {
                            gid = (cp + delta) & 0xFFFF;
                        } else {
                            const pos = idRangeOffOff + i * 2 + ro + 2 * (cp - start);
                            if (pos + 1 >= dvLimit) continue;
                            gid = this.u16(pos);
                            if (gid !== 0) gid = (gid + delta) & 0xFFFF;
                        }
                        if (gid > 0) pairs.push({ cp, gid });
                    }
                }
                break;
            }
            case 6: {
                const firstCode = this.u16(v.byteOffset + off + 6);
                const entryCount = this.u16(v.byteOffset + off + 8);
                let p = v.byteOffset + off + 10;
                for (let i = 0; i < entryCount; i++) {
                    const gid = this.u16(p + i * 2);
                    if (gid > 0) pairs.push({ cp: firstCode + i, gid });
                }
                break;
            }
            case 10: {
                const startChar = this.u32(v.byteOffset + off + 12);
                const numChars = this.u32(v.byteOffset + off + 16);
                let p = v.byteOffset + off + 20;
                for (let i = 0; i < numChars; i++) {
                    const gid = this.u16(p + i * 2);
                    if (gid > 0) pairs.push({ cp: startChar + i, gid });
                }
                break;
            }
            case 12: {
                const nGroups = this.u32(v.byteOffset + off + 12);
                const groupsOff = v.byteOffset + off + 16;
                for (let i = 0; i < nGroups; i++) {
                    const startCharCode = this.u32(groupsOff + i * 12);
                    const endCharCode = this.u32(groupsOff + i * 12 + 4);
                    const startGlyphID = this.u32(groupsOff + i * 12 + 8);
                    for (let cp = startCharCode; cp <= endCharCode; cp++) {
                        const gid = startGlyphID + (cp - startCharCode);
                        if (gid > 0) pairs.push({ cp, gid });
                    }
                }
                break;
            }
        }
        // For symbolic fonts (3,0): also emit low-byte aliases for 0xF0xx range
        if (isSymbolic) {
            const existing = new Set(pairs.map(p => p.cp));
            const toAdd = [];
            for (const p of pairs) {
                if (p.cp >= 0xF000 && p.cp <= 0xF0FF && !existing.has(p.cp - 0xF000)) {
                    toAdd.push({ cp: p.cp - 0xF000, gid: p.gid });
                }
            }
            pairs.push(...toAdd);
        }
        return pairs;
    }
    glyphRange(gid) {
        if (!this.tables['glyf'] || !this.loca)
            return { offset: 0, length: 0 };
        if (gid < 0 || gid >= this.numGlyphs)
            return { offset: 0, length: 0 };
        const gOff = this.tables['glyf'].offset;
        const start = this.loca[gid];
        const end = this.loca[gid + 1];
        const len = end - start;
        if (len <= 0) return { offset: 0, length: 0 };
        return { offset: gOff + start, length: len };
    }
    loadGlyph(gid, depth = 0) {
        var _a, _b, _d, _e, _f, _g, _h, _j;
        // Check cache first
        if (this.glyphCache.has(gid)) {
            return this.glyphCache.get(gid);
        }
        const { offset, length } = this.glyphRange(gid);
        if (!length) {
            const result = { contours: [], advanceWidth: (_b = (_a = this.hmtx[gid]) === null || _a === void 0 ? void 0 : _a.advanceWidth) !== null && _b !== void 0 ? _b : 0 };
            this.glyphCache.set(gid, result);
            return result;
        }
        const dv = new DataView(this.buf, offset, length);
        let o = 0;
        const nContours = dv.getInt16(o, false);
        o += 2;
        o += 8; // skip bbox
        if (nContours < 0) {
            // Composite glyphs: recursively load components with depth limit
            const ARG_WORDS = 0x0001, ARGS_XY = 0x0002, WE_HAVE_SCALE = 0x0008, MORE = 0x0020, WE_HAVE_XY_SCALE = 0x0040, WE_HAVE_2x2 = 0x0080;
            const comps = [];
            let flags;
            do {
                flags = dv.getUint16(o, false);
                o += 2;
                const compGID = dv.getUint16(o, false);
                o += 2;
                let arg1, arg2;
                if (flags & ARG_WORDS) {
                    arg1 = dv.getInt16(o, false);
                    arg2 = dv.getInt16(o + 2, false);
                    o += 4;
                }
                else {
                    arg1 = dv.getInt8(o);
                    arg2 = dv.getInt8(o + 1);
                    o += 2;
                }
                let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
                if (flags & ARGS_XY) {
                    e = arg1;
                    f = arg2;
                }
                if (flags & WE_HAVE_SCALE) {
                    a = d = dv.getInt16(o, false) / 16384;
                    o += 2;
                }
                else if (flags & WE_HAVE_XY_SCALE) {
                    a = dv.getInt16(o, false) / 16384;
                    d = dv.getInt16(o + 2, false) / 16384;
                    o += 4;
                }
                else if (flags & WE_HAVE_2x2) {
                    a = dv.getInt16(o, false) / 16384;
                    b = dv.getInt16(o + 2, false) / 16384;
                    c = dv.getInt16(o + 4, false) / 16384;
                    d = dv.getInt16(o + 6, false) / 16384;
                    o += 8;
                }
                comps.push({ gid: compGID, t: [a, b, c, d, e, f] });
            } while (flags & MORE);
            const out = [];
            const maxDepth = 32;
            if (depth > maxDepth) {
                console.warn(`[TTF] Recursion depth limit reached for glyph ${gid}`);
                const result = { contours: out, advanceWidth: (_e = (_d = this.hmtx[gid]) === null || _d === void 0 ? void 0 : _d.advanceWidth) !== null && _e !== void 0 ? _e : 0 };
                this.glyphCache.set(gid, result);
                return result;
            }
            for (const comp of comps) {
                const g = this.loadGlyph(comp.gid, depth + 1);
                const [a, b, c, d, e, f] = comp.t;
                for (const pts of g.contours) {
                    out.push(pts.map(p => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f, on: p.on })));
                }
            }
            const result = { contours: out, advanceWidth: (_g = (_f = this.hmtx[gid]) === null || _f === void 0 ? void 0 : _f.advanceWidth) !== null && _g !== void 0 ? _g : 0 };
            this.glyphCache.set(gid, result);
            return result;
        }
        // Simple glyph
        const endPts = [];
        for (let i = 0; i < nContours; i++) {
            endPts.push(dv.getUint16(o, false));
            o += 2;
        }
        const instrLen = dv.getUint16(o, false);
        o += 2 + instrLen;
        const nPoints = nContours > 0 ? endPts[nContours - 1] + 1 : 0;
        const flags = new Uint8Array(nPoints);
        for (let i = 0; i < nPoints;) {
            const f = dv.getUint8(o);
            o++;
            flags[i++] = f;
            if (f & 0x08) {
                const rep = dv.getUint8(o);
                o++;
                for (let k = 0; k < rep; k++)
                    flags[i++] = f;
            }
        }
        const X = new Int16Array(nPoints), Y = new Int16Array(nPoints);
        let x = 0, y = 0;
        for (let i = 0; i < nPoints; i++) {
            const f = flags[i];
            if (f & 0x02) {
                const dx = dv.getUint8(o);
                o++;
                x += (f & 0x10) ? dx : -dx;
            }
            else {
                if (!(f & 0x10)) {
                    const dx = dv.getInt16(o, false);
                    o += 2;
                    x += dx;
                }
            }
            X[i] = x;
        }
        for (let i = 0; i < nPoints; i++) {
            const f = flags[i];
            if (f & 0x04) {
                const dy = dv.getUint8(o);
                o++;
                y += (f & 0x20) ? dy : -dy;
            }
            else {
                if (!(f & 0x20)) {
                    const dy = dv.getInt16(o, false);
                    o += 2;
                    y += dy;
                }
            }
            Y[i] = y;
        }
        const contours = [];
        let start = 0;
        for (let c = 0; c < nContours; c++) {
            const end = endPts[c];
            const pts = [];
            for (let i = start; i <= end; i++)
                pts.push({ x: X[i], y: Y[i], on: !!(flags[i] & 1) });
            contours.push(pts);
            start = end + 1;
        }
        // Cache the result before returning
        const result = { contours, advanceWidth: (_j = (_h = this.hmtx[gid]) === null || _h === void 0 ? void 0 : _h.advanceWidth) !== null && _j !== void 0 ? _j : 0 };
        this.glyphCache.set(gid, result);
        return result;
    }

    /** Get the PostScript font name from the OpenType name table. */
    getPostScriptName() {
        if (!this.tables['name']) return null;
        const v = this.table('name');
        let off = v.byteOffset;
        const format = this.u16(off);
        const count = this.u16(off + 2);
        const stringOffset = this.u16(off + 4);
        off += 6;

        // Look for PostScript name (nameID = 6)
        // Prefer Windows platform (3,1) or Mac (1,0)
        let bestRecord = null;
        for (let i = 0; i < count; i++) {
            const platformID = this.u16(off);
            const encodingID = this.u16(off + 2);
            const languageID = this.u16(off + 4);
            const nameID = this.u16(off + 6);
            const length = this.u16(off + 8);
            const offset = this.u16(off + 10);
            off += 12;

            if (nameID === 6) { // PostScript name
                const priority = (platformID === 3 && encodingID === 1) ? 3 :
                                (platformID === 1 && encodingID === 0) ? 2 :
                                (platformID === 0) ? 1 : 0;
                if (!bestRecord || priority > bestRecord.priority) {
                    bestRecord = {
                        platformID, encodingID, length, offset,
                        dataOffset: v.byteOffset + stringOffset + offset,
                        priority
                    };
                }
            }
        }

        if (!bestRecord) return null;

        // Extract string data
        const strData = new Uint8Array(this.buf, bestRecord.dataOffset, bestRecord.length);
        let name = '';

        // Decode based on platform
        if (bestRecord.platformID === 3 || bestRecord.platformID === 0) {
            // UTF-16 BE encoding
            for (let i = 0; i < strData.length; i += 2) {
                if (i + 1 < strData.length) {
                    const charCode = (strData[i] << 8) | strData[i + 1];
                    name += String.fromCharCode(charCode);
                }
            }
        } else {
            // ASCII/Mac Roman encoding
            for (let i = 0; i < strData.length; i++) {
                name += String.fromCharCode(strData[i]);
            }
        }

        // PostScript names cannot contain spaces.
        return name.replace(/ /g, '_');
    }

    /**
     * Get font family name from 'name' table
     */
    getFontFamily() {
        if (!this.tables['name']) return null;
        const v = this.table('name');
        let off = v.byteOffset;
        const format = this.u16(off);
        const count = this.u16(off + 2);
        const stringOffset = this.u16(off + 4);
        off += 6;

        // Look for family name (nameID = 1)
        for (let i = 0; i < count; i++) {
            const platformID = this.u16(off);
            const encodingID = this.u16(off + 2);
            const languageID = this.u16(off + 4);
            const nameID = this.u16(off + 6);
            const length = this.u16(off + 8);
            const offset = this.u16(off + 10);
            off += 12;

            if (nameID === 1 && platformID === 3 && encodingID === 1) {
                const strData = new Uint8Array(this.buf, v.byteOffset + stringOffset + offset, length);
                let name = '';
                for (let i = 0; i < strData.length; i += 2) {
                    if (i + 1 < strData.length) {
                        const charCode = (strData[i] << 8) | strData[i + 1];
                        name += String.fromCharCode(charCode);
                    }
                }
                return name;
            }
        }
        return null;
    }

}

  // Expose to window
  if (typeof window !== 'undefined') {
    window.TTF = TTF;
  }
})();
