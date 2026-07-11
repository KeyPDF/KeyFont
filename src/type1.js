// Type 1 Font parser
// Handles PostScript Type 1 fonts with eexec encryption

(function() {
// CharString operator maps (shared with CFF)
const CHARSTRING_OPERATOR_MAP = {
    1: 'hstem', 3: 'vstem', 4: 'vmoveto', 5: 'rlineto', 6: 'hlineto', 7: 'vlineto',
    8: 'rrcurveto', 10: 'callsubr', 11: 'return', 14: 'endchar', 18: 'hstemhm',
    19: 'hintmask', 20: 'cntrmask', 21: 'rmoveto', 22: 'hmoveto', 23: 'vstemhm',
    24: 'rcurveline', 25: 'rlinecurve', 26: 'vvcurveto', 27: 'hhcurveto',
    28: 'shortint', 29: 'callgsubr', 30: 'vhcurveto', 31: 'hvcurveto', 13: 'hsbw',
    9: 'closepath'
};

const CHARSTRING_ESCAPE_MAP = {
    0: 'dotsection', 1: 'vstem3', 2: 'hstem3', 6: 'seac', 7: 'sbw',
    12: 'div', 16: 'callothersubr', 17: 'pop', 33: 'setcurrentpoint',
    34: 'hflex', 35: 'flex', 36: 'hflex1', 37: 'flex1'
};

function isAsciiHexSection(text) {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 9 || code === 10 || code === 13 || code === 32)
            continue;
        if ((code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102))
            continue;
        return false;
    }
    return true;
}
function hexStringToBytes(text) {
    const clean = text.replace(/[^0-9A-Fa-f]/g, '');
    const evenLength = clean.length & ~1;
    const bytes = new Uint8Array(evenLength / 2);
    for (let i = 0; i < evenLength; i += 2) {
        bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16) & 0xFF;
    }
    return bytes;
}
function eexecDecryptBytes(data) {
    const c1 = 52845;
    const c2 = 22719;
    let r = 55665;
    const out = [];
    for (let i = 0; i < data.length; i++) {
        const cipher = data[i];
        const plain = cipher ^ (r >> 8);
        if (i >= 4)
            out.push(plain);
        r = ((cipher + r) * c1 + c2) & 0xFFFF;
    }
    return new Uint8Array(out);
}
function looksLikeDecryptedEexec(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length)
        return false;
    const sample = Math.min(bytes.length, 256);
    if (!sample)
        return false;
    let printable = 0;
    let preview = '';
    for (let i = 0; i < sample; i++) {
        const code = bytes[i];
        if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) {
            printable++;
            if (preview.length < 160)
                preview += String.fromCharCode(code);
        }
    }
    if (printable / sample < 0.8)
        return false;
    return /\/Private|\/Subrs|dup\s+\d+\s+/.test(preview);
}
function decryptEexecSection(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length)
        return new Uint8Array();
    if (looksLikeDecryptedEexec(bytes))
        return bytes;
    const direct = eexecDecryptBytes(bytes);
    if (looksLikeDecryptedEexec(direct))
        return direct;
    const maxSkip = Math.min(32, Math.max(0, bytes.length - 4));
    for (let skip = 1; skip <= maxSkip; skip++) {
        const candidate = bytes.slice(skip);
        if (looksLikeDecryptedEexec(candidate))
            return candidate;
        const decrypted = eexecDecryptBytes(candidate);
        if (looksLikeDecryptedEexec(decrypted))
            return decrypted;
    }
    return direct;
}
function decryptCharStringBytes(data) {
    const c1 = 52845;
    const c2 = 22719;
    let r = 4330;
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const cipher = data[i];
        out[i] = cipher ^ (r >> 8);
        r = ((cipher + r) * c1 + c2) & 0xFFFF;
    }
    return out;
}
function decodeCharStringProgram(bytes) {
    if (!bytes || !bytes.length)
        return '';
    const stack = [];
    const lines = [];
    let hintCount = 0;
    let i = 0;
    while (i < bytes.length) {
        const b = bytes[i++];
        if (b >= 32 && b <= 246) {
            stack.push(b - 139);
            continue;
        }
        if (b >= 247 && b <= 250) {
            const b2 = bytes[i++];
            stack.push((b - 247) * 256 + b2 + 108);
            continue;
        }
        if (b >= 251 && b <= 254) {
            const b2 = bytes[i++];
            stack.push(-(b - 251) * 256 - b2 - 108);
            continue;
        }
        if (b === 28) {
            if (i + 1 < bytes.length) {
                const high = bytes[i++];
                const low = bytes[i++];
                let v = (high << 8) | low;
                if (v & 0x8000)
                    v = v - 0x10000;
                stack.push(v);
            }
            continue;
        }
        if (b === 255) {
            if (i + 3 <= bytes.length) {
                const value = (((bytes[i] << 24) >>> 0) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
                i += 4;
                const signed = value >= 0x80000000 ? value - 0x100000000 : value;
                stack.push(signed);
            }
            continue;
        }
        if (b === 12) {
            const escape = bytes[i++];
            if (escape === 12) {
                if (stack.length >= 2) {
                    const denom = stack.pop();
                    const numer = stack.pop();
                    stack.push(numer / denom);
                }
                continue;
            }
            const opName = CHARSTRING_ESCAPE_MAP[escape] || ('esc' + escape);
            flushOperator(opName);
            continue;
        }
        const opName = CHARSTRING_OPERATOR_MAP[b] || ('op' + b);
        if (opName === 'hstem' || opName === 'vstem' || opName === 'hstemhm' || opName === 'vstemhm') {
            hintCount += Math.floor(stack.length / 2);
        }
        if (opName === 'hintmask' || opName === 'cntrmask') {
            if (stack.length)
                hintCount += Math.floor(stack.length / 2);
            flushOperator(opName);
            const maskBytes = Math.ceil(hintCount / 8);
            i += maskBytes;
            continue;
        }
        flushOperator(opName);
    }
    if (stack.length)
        lines.push(stack.join(' '));
    return lines.join('\n');
    function flushOperator(name) {
        const args = stack.splice(0, stack.length);
        const prefix = args.length ? args.join(' ') + ' ' : '';
        lines.push(prefix + name);
    }
}
function tokenizeCharStringProgram(text) {
    if (!text)
        return [];
    return text.split(/\s+/).map(t => t.trim()).filter(Boolean);
}
function interpretType1CharString(name, tokens, lookupSubr, unitsPerEm) {
    const stack = [];
    const segments = [];
    const missingSubrs = new Set();
    let cx = 0;
    let cy = 0;
    let sbx = 0;
    let width = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let inFlex = false;
    let flexDeltas = [];
    const ascent = Math.round(unitsPerEm * 0.72);
    const updateBounds = (x, y) => {
        if (Number.isFinite(x)) {
            if (x < minX)
                minX = x;
            if (x > maxX)
                maxX = x;
        }
        if (Number.isFinite(y)) {
            if (y < minY)
                minY = y;
            if (y > maxY)
                maxY = y;
        }
    };
    const moveTo = (x, y) => {
        cx = x;
        cy = y;
        segments.push({ cmd: 'M', x, y });
        updateBounds(x, y);
    };
    const lineTo = (x, y) => {
        cx = x;
        cy = y;
        segments.push({ cmd: 'L', x, y });
        updateBounds(x, y);
    };
    const curveTo = (x1, y1, x2, y2, x3, y3) => {
        segments.push({ cmd: 'C', x1, y1, x2, y2, x3, y3 });
        updateBounds(x1, y1);
        updateBounds(x2, y2);
        updateBounds(x3, y3);
        cx = x3;
        cy = y3;
    };
    const closePath = () => {
        segments.push({ cmd: 'Z' });
    };
    const curveToRel = (dx1, dy1, dx2, dy2, dx3, dy3) => {
        const x1 = cx + dx1;
        const y1 = cy + dy1;
        const x2 = x1 + dx2;
        const y2 = y1 + dy2;
        const x3 = x2 + dx3;
        const y3 = y2 + dy3;
        curveTo(x1, y1, x2, y2, x3, y3);
    };
    const popAll = () => {
        if (!stack.length)
            return [];
        const args = stack.slice();
        stack.length = 0;
        return args;
    };
    const consumeHCurve = (args) => {
        if (args.length < 4)
            return [];
        const dxa = args[0];
        const dxb = args[1];
        const dyb = args[2];
        const dyc = args[3];
        let remaining = args.slice(4);
        let dxc = 0;
        if (remaining.length === 1) {
            dxc = remaining[0];
            remaining = [];
        }
        curveToRel(dxa, 0, dxb, dyb, dxc, dyc);
        return remaining;
    };
    const consumeVCurve = (args) => {
        if (args.length < 4)
            return [];
        const dya = args[0];
        const dxb = args[1];
        const dyb = args[2];
        const dxc = args[3];
        let remaining = args.slice(4);
        let dyc = 0;
        if (remaining.length === 1) {
            dyc = remaining[0];
            remaining = [];
        }
        curveToRel(0, dya, dxb, dyb, dxc, dyc);
        return remaining;
    };
    const execute = (tokenList, depth = 0) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        if (depth > 64)
            return;
        let idx = 0;
        while (idx < tokenList.length) {
            const tok = tokenList[idx++];
            if (!tok)
                continue;
            const maybeNumber = parseFloat(tok);
            if (!Number.isNaN(maybeNumber)) {
                stack.push(maybeNumber);
                continue;
            }
            switch (tok) {
                case 'return':
                    return;
                case 'hsbw': {
                    width = (_a = stack.pop()) !== null && _a !== void 0 ? _a : 0;
                    sbx = (_b = stack.pop()) !== null && _b !== void 0 ? _b : 0;
                    cx = sbx;
                    cy = 0;
                    updateBounds(cx, cy);
                    stack.length = 0;
                    break;
                }
                case 'sbw': {
                    if (stack.length >= 4) {
                        // sbw operands (bottom-to-top): sbx sby wx wy
                        stack.pop(); // wy (vertical advance, discard)
                        width = (_c = stack.pop()) !== null && _c !== void 0 ? _c : 0; // wx
                        cy = (_d = stack.pop()) !== null && _d !== void 0 ? _d : 0; // sby
                        sbx = (_e = stack.pop()) !== null && _e !== void 0 ? _e : 0; // sbx
                    }
                    else if (stack.length >= 2) {
                        width = (_f = stack.pop()) !== null && _f !== void 0 ? _f : 0;
                        sbx = (_g = stack.pop()) !== null && _g !== void 0 ? _g : 0;
                        cy = 0;
                    }
                    cx = sbx;
                    updateBounds(cx, cy);
                    stack.length = 0;
                    break;
                }
                case 'hstem':
                case 'hstem3':
                case 'vstem':
                case 'vstem3':
                case 'dotsection':
                case 'seac':
                    stack.length = 0;
                    break;
                case 'vmoveto': {
                    // Optional width when first operator
                    let dy;
                    if (!width && stack.length === 2) {
                        width = stack.shift() || 0;
                        dy = stack.pop() || 0;
                    }
                    else {
                        dy = stack.pop() || 0;
                    }
                    if (inFlex)
                        flexDeltas.push({ dx: 0, dy });
                    else {
                        cy += dy;
                        moveTo(cx, cy);
                    }
                    stack.length = 0;
                    break;
                }
                case 'hmoveto': {
                    // Optional width when first operator
                    let dx;
                    if (!width && stack.length === 2) {
                        width = stack.shift() || 0;
                        dx = stack.pop() || 0;
                    }
                    else {
                        dx = stack.pop() || 0;
                    }
                    if (inFlex)
                        flexDeltas.push({ dx, dy: 0 });
                    else {
                        cx += dx;
                        moveTo(cx, cy);
                    }
                    stack.length = 0;
                    break;
                }
                case 'rmoveto': {
                    let args = popAll();
                    if (!args.length)
                        break;
                    // Optional width when first operator
                    if (!width && args.length === 3) {
                        width = args.shift() || 0;
                    }
                    if (inFlex) {
                        for (let i = 0; i + 1 < args.length; i += 2) {
                            flexDeltas.push({ dx: args[i], dy: args[i + 1] || 0 });
                        }
                    }
                    else {
                        cx += args[0];
                        cy += args[1] || 0;
                        moveTo(cx, cy);
                        for (let i = 2; i + 1 < args.length; i += 2) {
                            cx += args[i];
                            cy += args[i + 1] || 0;
                            lineTo(cx, cy);
                        }
                    }
                    break;
                }
                case 'hlineto': {
                    const args = popAll();
                    let horizontal = true;
                    for (const value of args) {
                        if (horizontal)
                            cx += value;
                        else
                            cy += value;
                        lineTo(cx, cy);
                        horizontal = !horizontal;
                    }
                    break;
                }
                case 'vlineto': {
                    const args = popAll();
                    let horizontal = false;
                    for (const value of args) {
                        if (horizontal)
                            cx += value;
                        else
                            cy += value;
                        lineTo(cx, cy);
                        horizontal = !horizontal;
                    }
                    break;
                }
                case 'rlineto': {
                    const args = popAll();
                    for (let i = 0; i + 1 < args.length; i += 2) {
                        cx += args[i];
                        cy += args[i + 1] || 0;
                        lineTo(cx, cy);
                    }
                    break;
                }
                case 'rrcurveto': {
                    const args = popAll();
                    for (let i = 0; i + 5 < args.length; i += 6) {
                        curveToRel(args[i], args[i + 1], args[i + 2], args[i + 3], args[i + 4], args[i + 5]);
                    }
                    break;
                }
                case 'vhcurveto': {
                    let remaining = popAll();
                    while (remaining.length) {
                        remaining = consumeVCurve(remaining);
                        if (!remaining.length)
                            break;
                        remaining = consumeHCurve(remaining);
                    }
                    break;
                }
                case 'hvcurveto': {
                    let remaining = popAll();
                    while (remaining.length) {
                        remaining = consumeHCurve(remaining);
                        if (!remaining.length)
                            break;
                        remaining = consumeVCurve(remaining);
                    }
                    break;
                }
                case 'flex':
                case 'flex1':
                case 'hflex':
                case 'hflex1':
                    // Handle flex operators similarly to Type 2 charstrings (two curves)
                    if (tok === 'hflex' || tok === 'hflex1') {
                        const args = popAll();
                        if (tok === 'hflex' && args.length >= 7) {
                            curveToRel(args[0], 0, args[1], args[2], args[3], 0);
                            curveToRel(args[4], 0, args[5], 0, args[6], 0);
                        }
                        else if (tok === 'hflex1' && args.length >= 9) {
                            curveToRel(args[0], args[1], args[2], args[3], args[4], 0);
                            curveToRel(args[5], 0, args[6], args[7], args[8], 0);
                        }
                    }
                    else if (tok === 'flex') {
                        const args = popAll();
                        if (args.length >= 12) {
                            curveToRel(args[0], args[1], args[2], args[3], args[4], args[5]);
                            curveToRel(args[6], args[7], args[8], args[9], args[10], args[11]);
                        }
                    }
                    else if (tok === 'flex1') {
                        const args = popAll();
                        if (args.length >= 11) {
                            const dx1 = args[0], dy1 = args[1], dx2 = args[2], dy2 = args[3], dx3 = args[4], dy3 = args[5];
                            const dx4 = args[6], dy4 = args[7], dx5 = args[8], dy5 = args[9];
                            const d6 = args[10];
                            const sumDx = dx1 + dx2 + dx3 + dx4 + dx5;
                            const sumDy = dy1 + dy2 + dy3 + dy4 + dy5;
                            const useX = Math.abs(sumDx) > Math.abs(sumDy);
                            const dx6 = useX ? d6 : -sumDx;
                            const dy6 = useX ? -sumDy : d6;
                            curveToRel(dx1, dy1, dx2, dy2, dx3, dy3);
                            curveToRel(dx4, dy4, dx5, dy5, dx6, dy6);
                        }
                    }
                    stack.length = 0;
                    break;
                case 'callsubr': {
                    const subrValue = stack.pop();
                    const subr = Math.trunc(subrValue !== null && subrValue !== void 0 ? subrValue : 0);
                    if (subr === 1) {
                        inFlex = true;
                        flexDeltas = [];
                        stack.length = 0;
                    }
                    else if (subr === 2 && inFlex) {
                        stack.length = 0;
                    }
                    else if (subr === 0 && inFlex) {
                        const absY = stack.pop();
                        const absX = stack.pop();
                        stack.pop();
                        if (flexDeltas.length === 7) {
                            const d1 = flexDeltas[0];
                            const d2 = flexDeltas[1];
                            const d3 = flexDeltas[2];
                            const d4 = flexDeltas[3];
                            const d5 = flexDeltas[4];
                            const d6 = flexDeltas[5];
                            const d7 = flexDeltas[6];
                            const dx1 = d1.dx + d2.dx;
                            const dy1 = d1.dy + d2.dy;
                            const dx2 = d3.dx;
                            const dy2 = d3.dy;
                            const dx3 = d4.dx;
                            const dy3 = d4.dy;
                            const dx4 = d5.dx;
                            const dy4 = d5.dy;
                            const dx5 = d6.dx;
                            const dy5 = d6.dy;
                            const dx6 = d7.dx;
                            const dy6 = d7.dy;
                            const ocx = cx;
                            const ocy = cy;
                            cx += dx1 + dx2 + dx3;
                            cy += dy1 + dy2 + dy3;
                            const c1x = ocx + dx1;
                            const c1y = ocy + dy1;
                            const c2x = c1x + dx2;
                            const c2y = c1y + dy2;
                            curveTo(c1x, c1y, c2x, c2y, cx, cy);
                            const ocx2 = cx;
                            const ocy2 = cy;
                            cx += dx4 + dx5 + dx6;
                            cy += dy4 + dy5 + dy6;
                            const c3x = ocx2 + dx4;
                            const c3y = ocy2 + dy4;
                            const c4x = c3x + dx5;
                            const c4y = c3y + dy5;
                            curveTo(c3x, c3y, c4x, c4y, cx, cy);
                            lineTo(absX, absY);
                            cx = absX;
                            cy = absY;
                            updateBounds(cx, cy);
                        }
                        inFlex = false;
                        flexDeltas = [];
                        stack.length = 0;
                    }
                    else {
                        const subrTokens = lookupSubr ? lookupSubr(subr) : null;
                        if (subrTokens) {
                            execute(subrTokens, depth + 1);
                        }
                        else {
                            missingSubrs.add(subr);
                            stack.length = 0;
                        }
                    }
                    break;
                }
                case 'callothersubr':
                    stack.length = 0;
                    break;
                case 'pop':
                    if (stack.length)
                        stack.pop();
                    break;
                case 'closepath':
                    closePath();
                    stack.length = 0;
                    break;
                case 'endchar':
                    return;
                default:
                    stack.length = 0;
                    break;
            }
        }
    };
    execute(tokens || []);
    if (minX === Infinity) {
        minX = sbx;
        maxX = sbx + width;
    }
    if (minY === Infinity) {
        minY = 0;
        maxY = ascent;
    }
    const leftBound = Math.min(minX, sbx);
    const rightBound = Math.max(maxX, sbx + width);
    const metrics = {
        unitsPerEm,
        leftSideBearing: sbx,
        advanceWidth: width || Math.max(0, rightBound - leftBound),
        leftBound,
        rightBound,
        bottomBound: minY,
        topBound: maxY,
        missingSubrs: [...missingSubrs].sort((a, b) => a - b)
    };
    return { path: segments.slice(), metrics, bounds: { minX, minY, maxX, maxY } };
}
class Type1Font {
    constructor(bytes) {
        const sourceBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array();
        this.bytes = normalizeType1Bytes(sourceBytes);
        this.fontMatrix = [0.001, 0, 0, 0.001, 0, 0];
        this.fontBBox = [-50, -200, 1000, 900];
        this.encoding = STANDARD_ENCODING_NAMES.slice();
        this.lenIV = 4;
        this.unitsPerEm = 1000;
        this.subrs = new Map();
        this.charStrings = new Map();
        this.subrTokenCache = new Map();
        this.glyphTokenCache = new Map();
        this.glyphCache = new Map();
        this.numGlyphs = 0;
        this.parsed = false;
    }
    parse() {
        if (this.parsed)
            return;
        const text = bytesToLatin1(this.bytes);
        const marker = 'currentfile eexec';
        const start = text.indexOf(marker);
        if (start === -1)
            throw new Error('Type1 font missing eexec section');
        const header = text.slice(0, start);
        this.parseFontMatrix(header);
        this.parseFontBBox(header);
        this.parseEncodingBlock(header);
        let dataStart = start + marker.length;
        while (dataStart < text.length) {
            const code = text.charCodeAt(dataStart);
            if (code === 9 || code === 10 || code === 13 || code === 32)
                dataStart++;
            else
                break;
        }
        const clearIdx = text.indexOf('cleartomark', dataStart);
        const end = clearIdx !== -1 ? clearIdx : text.length;
        const encrypted = this.extractEexecBytes(dataStart, end, text);
        const decrypted = decryptEexecSection(encrypted);
        this.parseDecrypted(decrypted);
        this.numGlyphs = this.charStrings.size;
        this.parsed = true;
    }
    parseFontMatrix(header) {
        const m = header.match(/\/FontMatrix\s*\[([^\]]+)\]/);
        if (m) {
            const parts = m[1].trim().split(/\s+/).map(Number).filter(n => Number.isFinite(n));
            if (parts.length >= 6)
                this.fontMatrix = parts.slice(0, 6);
        }
        const scale = this.fontMatrix[0];
        if (scale && Math.abs(scale) > 1e-6) {
            this.unitsPerEm = Math.round(Math.abs(1 / scale));
        }
        else {
            this.unitsPerEm = 1000;
        }
    }
    parseFontBBox(header) {
        const m = header.match(/\/FontBBox\s*\[([^\]]+)\]/);
        if (m) {
            const parts = m[1].trim().split(/\s+/).map(Number).filter(Number.isFinite);
            if (parts.length >= 4)
                this.fontBBox = parts.slice(0, 4);
        }
    }
    parseEncodingBlock(header) {
        let names = this.encoding.slice();
        if (/\/Encoding\s+StandardEncoding\b/i.test(header)) {
            names = STANDARD_ENCODING_NAMES.slice();
        }
        const pattern = /(Encoding|dup)\s+(\d+)\s*\/([^\s]+)\s+put/g;
        let match;
        while ((match = pattern.exec(header)) !== null) {
            const index = parseInt(match[2], 10);
            const glyph = match[3];
            if (!Number.isFinite(index) || index < 0 || index > 255)
                continue;
            names[index] = glyph;
        }
        this.encoding = names;
    }
    extractEexecBytes(start, end, text) {
        const slice = text.slice(start, end);
        if (isAsciiHexSection(slice))
            return hexStringToBytes(slice);
        const length = Math.max(0, end - start);
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            out[i] = this.bytes[start + i] & 0xFF;
        }
        return out;
    }
    parseDecrypted(bytes) {
        const text = bytesToLatin1(bytes);
        const lenIVMatch = text.match(/\/lenIV\s+(-?\d+)/);
        if (lenIVMatch) {
            const val = parseInt(lenIVMatch[1], 10);
            if (Number.isFinite(val))
                this.lenIV = val;
        }
        this.extractSubrs(bytes);
        this.extractCharStrings(bytes);
        if (!this.charStrings.has('.notdef')) {
            this.charStrings.set('.notdef', new Uint8Array());
        }
    }
    _isWhitespaceByte(byte) {
        return byte === 0x00 || byte === 0x09 || byte === 0x0A || byte === 0x0D || byte === 0x20;
    }
    _skipWhitespace(bytes, pos) {
        let i = pos;
        while (i < bytes.length && this._isWhitespaceByte(bytes[i]))
            i++;
        return i;
    }
    _readAsciiToken(bytes, pos) {
        let i = this._skipWhitespace(bytes, pos);
        if (i >= bytes.length)
            return null;
        const start = i;
        if (bytes[i] === 0x2F) {
            i++;
            while (i < bytes.length && !this._isWhitespaceByte(bytes[i]))
                i++;
            return { token: bytesToLatin1(bytes.slice(start, i)), next: i };
        }
        while (i < bytes.length && !this._isWhitespaceByte(bytes[i]))
            i++;
        return { token: bytesToLatin1(bytes.slice(start, i)), next: i };
    }
    _findAscii(bytes, needle, start = 0) {
        const n = new Uint8Array(needle.length);
        for (let i = 0; i < needle.length; i++)
            n[i] = needle.charCodeAt(i) & 0xFF;
        outer: for (let i = Math.max(0, start); i <= bytes.length - n.length; i++) {
            for (let j = 0; j < n.length; j++) {
                if (bytes[i + j] !== n[j])
                    continue outer;
            }
            return i;
        }
        return -1;
    }
    _decodeCharStringChunk(chunk) {
        const decrypted = this.lenIV >= 0 ? decryptCharStringBytes(chunk) : chunk;
        return this.lenIV > 0 ? decrypted.slice(Math.min(this.lenIV, decrypted.length)) : decrypted;
    }
    extractSubrs(bytes) {
        const subrsStart = this._findAscii(bytes, '/Subrs');
        if (subrsStart < 0)
            return;
        let pos = subrsStart + '/Subrs'.length;
        while (pos < bytes.length) {
            const tok = this._readAsciiToken(bytes, pos);
            if (!tok)
                break;
            pos = tok.next;
            if (tok.token === '/CharStrings' || tok.token === 'ND' || tok.token === 'def')
                break;
            if (tok.token !== 'dup')
                continue;
            const idxTok = this._readAsciiToken(bytes, pos);
            if (!idxTok)
                break;
            const lenTok = this._readAsciiToken(bytes, idxTok.next);
            if (!lenTok)
                break;
            const opTok = this._readAsciiToken(bytes, lenTok.next);
            if (!opTok)
                break;
            const index = parseInt(idxTok.token, 10);
            const length = parseInt(lenTok.token, 10);
            if (!Number.isFinite(index) || !Number.isFinite(length) || length < 0) {
                pos = opTok.next;
                continue;
            }
            if (opTok.token !== 'RD' && opTok.token !== '-' && opTok.token !== '-|') {
                pos = opTok.next;
                continue;
            }
            let dataStart = opTok.next;
            if (dataStart < bytes.length && this._isWhitespaceByte(bytes[dataStart]))
                dataStart++;
            const dataEnd = dataStart + length;
            if (dataEnd > bytes.length)
                break;
            const chunk = bytes.slice(dataStart, dataEnd);
            this.subrs.set(index, this._decodeCharStringChunk(chunk));
            pos = dataEnd;
        }
    }
    extractCharStrings(bytes) {
        const csStart = this._findAscii(bytes, '/CharStrings');
        if (csStart < 0)
            return;
        let pos = csStart + '/CharStrings'.length;
        while (pos < bytes.length) {
            const tok = this._readAsciiToken(bytes, pos);
            if (!tok)
                break;
            pos = tok.next;
            if (tok.token === 'end' || tok.token === 'readonly')
                break;
            let glyphToken = tok.token;
            if (glyphToken === 'dup') {
                const nameTok = this._readAsciiToken(bytes, pos);
                if (!nameTok)
                    break;
                glyphToken = nameTok.token;
                pos = nameTok.next;
            }
            if (!glyphToken || glyphToken[0] !== '/')
                continue;
            const lenTok = this._readAsciiToken(bytes, pos);
            if (!lenTok)
                break;
            const opTok = this._readAsciiToken(bytes, lenTok.next);
            if (!opTok)
                break;
            const length = parseInt(lenTok.token, 10);
            if (!Number.isFinite(length) || length < 0) {
                pos = opTok.next;
                continue;
            }
            if (opTok.token !== 'RD' && opTok.token !== '-' && opTok.token !== '-|') {
                pos = opTok.next;
                continue;
            }
            let dataStart = opTok.next;
            if (dataStart < bytes.length && this._isWhitespaceByte(bytes[dataStart]))
                dataStart++;
            const dataEnd = dataStart + length;
            if (dataEnd > bytes.length)
                break;
            const name = glyphToken.slice(1);
            const chunk = bytes.slice(dataStart, dataEnd);
            this.charStrings.set(name, this._decodeCharStringChunk(chunk));
            pos = dataEnd;
        }
    }
    getSubrTokens(index) {
        if (this.subrTokenCache.has(index))
            return this.subrTokenCache.get(index) || null;
        const bytes = this.subrs.get(index);
        if (!bytes || !bytes.length) {
            this.subrTokenCache.set(index, null);
            return null;
        }
        const program = decodeCharStringProgram(bytes);
        const tokens = tokenizeCharStringProgram(program);
        this.subrTokenCache.set(index, tokens);
        return tokens;
    }
    getGlyphTokens(name) {
        if (this.glyphTokenCache.has(name))
            return this.glyphTokenCache.get(name) || null;
        const bytes = this.charStrings.get(name);
        if (!bytes || !bytes.length) {
            this.glyphTokenCache.set(name, null);
            return null;
        }
        const program = decodeCharStringProgram(bytes);
        const tokens = tokenizeCharStringProgram(program);
        this.glyphTokenCache.set(name, tokens);
        return tokens;
    }
    loadGlyphByName(name) {
        const key = this.charStrings.has(name) ? name : '.notdef';
        const cached = this.glyphCache.get(key);
        if (cached)
            return cached;
        const tokens = this.getGlyphTokens(key);
        if (!tokens || !tokens.length) {
            const fallback = { path: [], metrics: { unitsPerEm: this.unitsPerEm, leftSideBearing: 0, advanceWidth: this.unitsPerEm * 0.5 } };
            this.glyphCache.set(key, fallback);
            return fallback;
        }
        const glyph = interpretType1CharString(key, tokens, idx => this.getSubrTokens(idx), this.unitsPerEm);
        this.glyphCache.set(key, glyph);
        return glyph;
    }

}

  // Expose to window
  if (typeof window !== 'undefined') {
    window.Type1Font = Type1Font;
    window.CHARSTRING_OPERATOR_MAP = CHARSTRING_OPERATOR_MAP;
    window.CHARSTRING_ESCAPE_MAP = CHARSTRING_ESCAPE_MAP;
    window.eexecDecryptBytes = eexecDecryptBytes;
    window.decryptCharStringBytes = decryptCharStringBytes;
    window.interpretType1CharString = interpretType1CharString;
  }
})();
