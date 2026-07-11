// Compact Font Format (CFF / Type 2) parser
// Handles CFF fonts and Type2 CharString interpretation

(function() {
    // Access glyph-names utilities from window
    const guessGlyphNameFromChar = (typeof window !== 'undefined' && window.guessGlyphNameFromChar) || function() { return null; };
    const glyphNameToUnicode = (typeof window !== 'undefined' && window.glyphNameToUnicode) || function() { return null; };
    // seac/endchar component codes are defined against Adobe StandardEncoding.
    // Keep explicit overrides for the non-ASCII accent slots used by composites.
    const SEAC_STANDARD_OVERRIDES = {
        193: 'grave',
        194: 'acute',
        195: 'circumflex',
        196: 'tilde',
        197: 'macron',
        198: 'breve',
        199: 'dotaccent',
        200: 'dieresis',
        202: 'ring',
        203: 'cedilla',
        205: 'hungarumlaut',
        206: 'ogonek',
        207: 'caron'
    };
  
    // CharString decoding utility
    // knownHintCount: if provided, total hint count pre-computed by preCountCFFHints
    // (needed when stem hints are set inside subroutines called via callsubr/callgsubr)
    function decodeCharStringProgram(bytes, knownHintCount) {
      if (!bytes || !bytes.length) return '';
      const stack = [];
      const lines = [];
      let hintCount = 0;
      let i = 0;

      function flushOperator(name) {
          const args = stack.splice(0, stack.length);
          const prefix = args.length ? args.join(' ') + ' ' : '';
          lines.push(prefix + name);
      }

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
                  if (v & 0x8000) v = v - 0x10000;
                  stack.push(v);
              }
              continue;
          }
          if (b === 255) {
              if (i + 3 <= bytes.length) {
                  const value = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
                  i += 4;
                  const signed = value & 0x80000000 ? value - 0x100000000 : value;
                  stack.push(signed / 65536);
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
              if (stack.length) hintCount += Math.floor(stack.length / 2);
              flushOperator(opName);
              // Use pre-counted hints when local tracking missed hints from subroutines
              const effectiveHints = (knownHintCount && knownHintCount > hintCount) ? knownHintCount : hintCount;
              const maskBytes = Math.ceil(effectiveHints / 8);
              i += maskBytes;
              continue;
          }
          flushOperator(opName);
      }
      if (stack.length) lines.push(stack.join(' '));
      return lines.join('\n');
  }
  
  function tokenizeCharStringProgram(text) {
      if (!text) return [];
      return text.split(/\s+/).map(t => t.trim()).filter(Boolean);
  }
  
  // Latin1 encoding utilities
  function bytesToLatin1(bytes) {
      let str = '';
      for (let i = 0; i < bytes.length; i++) {
          str += String.fromCharCode(bytes[i]);
      }
      return str;
  }
  
  // Compact Font Format (CFF) parsing utilities for Type 1C fonts
  let globalSubrTokens = {};
  let globalSubrBias = 0;
  function calcSubrBias(count) {
      if (count < 1240)
          return 107;
      if (count < 33900)
          return 1131;
      return 32768;
  }

  // Pre-count total hint stems in a charstring, recursively following subroutine calls.
  // This is needed because decodeCharStringProgram decodes each charstring independently
  // and can't track hints declared inside subroutines called via callsubr/callgsubr.
  function preCountCFFHints(bytes, localSubrObjects, localBias, globalSubrObjects, globalBias) {
      let hintCount = 0;
      function scan(data, stack, depth) {
          if (!data || depth > 10) return;
          let i = 0;
          while (i < data.length) {
              const b = data[i++];
              if (b >= 32 && b <= 246) { stack.push(b - 139); continue; }
              if (b >= 247 && b <= 250) { stack.push((b - 247) * 256 + (data[i++] || 0) + 108); continue; }
              if (b >= 251 && b <= 254) { stack.push(-(b - 251) * 256 - (data[i++] || 0) - 108); continue; }
              if (b === 28) { let v = ((data[i] || 0) << 8) | (data[i + 1] || 0); i += 2; if (v & 0x8000) v -= 0x10000; stack.push(v); continue; }
              if (b === 255) { i += 4; stack.push(0); continue; } // value doesn't matter for counting
              if (b === 12) { i++; stack.length = 0; continue; }
              // stem operators: hstem(1), vstem(3), hstemhm(18), vstemhm(23)
              if (b === 1 || b === 3 || b === 18 || b === 23) {
                  hintCount += Math.floor(stack.length / 2);
                  stack.length = 0;
                  continue;
              }
              // hintmask(19), cntrmask(20) - implicit vstem from remaining stack
              if (b === 19 || b === 20) {
                  if (stack.length) hintCount += Math.floor(stack.length / 2);
                  stack.length = 0;
                  i += Math.ceil(hintCount / 8);
                  continue;
              }
              // callsubr(10)
              if (b === 10) {
                  const subrNum = stack.pop();
                  if (localSubrObjects && subrNum !== undefined) {
                      const idx = Math.trunc(subrNum) + (localBias || 0);
                      if (idx >= 0 && idx < localSubrObjects.length) {
                          scan(localSubrObjects[idx], stack, depth + 1);
                      }
                  }
                  continue;
              }
              // callgsubr(29)
              if (b === 29) {
                  const subrNum = stack.pop();
                  if (globalSubrObjects && subrNum !== undefined) {
                      const idx = Math.trunc(subrNum) + (globalBias || 0);
                      if (idx >= 0 && idx < globalSubrObjects.length) {
                          scan(globalSubrObjects[idx], stack, depth + 1);
                      }
                  }
                  continue;
              }
              // return(11) - back to caller
              if (b === 11) return;
              // endchar(14) - done
              if (b === 14) return;
              // moveto/drawing operators - all hints declared by now
              if (b === 21 || b === 22 || b === 4 || b === 5 || b === 6 || b === 7 || b === 8 || b === 24 || b === 25 || b === 26 || b === 27 || b === 30 || b === 31) return;
              // other operators clear stack
              stack.length = 0;
          }
      }
      scan(bytes, [], 0);
      return hintCount;
  }
  function parseCFFNumber(b0, bytes, iRef) {
      let i = iRef[0];
      if (b0 >= 32 && b0 <= 246) {
          iRef[0] = i;
          return b0 - 139;
      }
      if (b0 >= 247 && b0 <= 250) {
          const b1 = bytes[i++];
          iRef[0] = i;
          return (b0 - 247) * 256 + b1 + 108;
      }
      if (b0 >= 251 && b0 <= 254) {
          const b1 = bytes[i++];
          iRef[0] = i;
          return -(b0 - 251) * 256 - b1 - 108;
      }
      if (b0 === 28) {
          const high = bytes[i++];
          const low = bytes[i++];
          iRef[0] = i;
          let value = (high << 8) | low;
          if (value & 0x8000)
              value = value - 0x10000;
          return value;
      }
      if (b0 === 29) {
          const b1 = bytes[i++];
          const b2 = bytes[i++];
          const b3 = bytes[i++];
          const b4 = bytes[i++];
          iRef[0] = i;
          let value = ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
          if (value & 0x80000000)
              value = value - 0x100000000;
          return value;
      }
      if (b0 === 30) {
          let s = '';
          while (true) {
              const b = bytes[i++];
              const nib1 = b >> 4;
              const nib2 = b & 0x0f;
              for (const nib of [nib1, nib2]) {
                  if (nib === 0xf) {
                      iRef[0] = i;
                      return parseFloat(s);
                  }
                  if (nib === 0xa)
                      s += '.';
                  else if (nib === 0xb)
                      s += 'E';
                  else if (nib === 0xc)
                      s += 'E-';
                  else if (nib === 0xd) {
                  }
                  else {
                      s += String.fromCharCode(48 + nib);
                  }
              }
          }
      }
      iRef[0] = i;
      return 0;
  }
  function parseCFFDict(bytes) {
      const dict = {};
      let i = 0;
      const stack = [];
      while (i < bytes.length) {
          const b = bytes[i++];
          if (b <= 21) {
              let op = b;
              if (b === 12) {
                  const esc = bytes[i++];
                  op = 1200 + esc;
              }
              dict[op] = stack.length === 1 ? stack[0] : stack.slice();
              stack.length = 0;
          }
          else {
              const ref = [i];
              const value = parseCFFNumber(b, bytes, ref);
              i = ref[0];
              stack.push(value);
          }
      }
      return dict;
  }
  function readCFFIndex(view, bytes, offsetRef) {
      let off = offsetRef.off;
      const count = (view.getUint8(off) << 8) | view.getUint8(off + 1);
      off += 2;
      if (count === 0) {
          offsetRef.off = off;
          return { objects: [] };
      }
      const offSize = view.getUint8(off);
      off += 1;
      const offsets = [];
      for (let i = 0; i <= count; i++) {
          let val = 0;
          for (let b = 0; b < offSize; b++) {
              val = (val << 8) | view.getUint8(off++);
          }
          offsets.push(val);
      }
      const start = off;
      const objects = [];
      for (let i = 0; i < count; i++) {
          const s = start + offsets[i] - 1;
          const e = start + offsets[i + 1] - 1;
          objects.push(bytes.slice(s, e));
      }
      off = start + offsets[count] - 1;
      offsetRef.off = off;
      return { objects };
  }
  // CFF parsing tables supplied by the KeyFont font engine.
  const CFF_TABLES = (typeof globalThis !== 'undefined' && globalThis.__CFF_TABLES) || (typeof window !== 'undefined' && window.__CFF_TABLES) || null;
  const CHARSTRING_TABLES = (typeof globalThis !== 'undefined' && globalThis.__CFF_CHARSTRING_TABLES) || (typeof window !== 'undefined' && window.__CFF_CHARSTRING_TABLES) || null;
  if (!CFF_TABLES || !CHARSTRING_TABLES) {
      throw new Error('CFF tables missing (expected dist/editor/core/table-map.js)');
  }
  const { STANDARD_STRINGS: CFF_STANDARD_STRINGS, ISO_ADOBE_CHARSET: CFF_ISO_ADOBE_CHARSET, EXPERT_CHARSET: CFF_EXPERT_CHARSET, EXPERT_SUBSET_CHARSET: CFF_EXPERT_SUBSET_CHARSET } = CFF_TABLES;
  const { CHARSTRING_OPERATOR_MAP, CHARSTRING_ESCAPE_MAP } = CHARSTRING_TABLES;

function cffSIDToString(sid, stringIndex) {
      if (sid < CFF_STANDARD_STRINGS.length)
          return CFF_STANDARD_STRINGS[sid];
      const customIndex = sid - CFF_STANDARD_STRINGS.length;
      const obj = stringIndex[customIndex];
      if (!obj)
          return '';
      return bytesToLatin1(obj);
  }
  function parseCFFCharset(bytes, offset, glyphCount, stringIndex, isCIDFont = false) {
      var _a, _b;
      if (glyphCount <= 0)
          return { names: [], cids: null };
      const preset = offset === 0 ? CFF_ISO_ADOBE_CHARSET
          : offset === 1 ? CFF_EXPERT_CHARSET
              : offset === 2 ? CFF_EXPERT_SUBSET_CHARSET
                  : null;
      if (preset) {
          const names = preset.slice(0, glyphCount);
          while (names.length < glyphCount)
              names.push(`G${names.length}`);
          return { names, cids: null };
      }
      const names = ['.notdef'];
      const cids = [0];
      let pos = offset;
      const format = bytes[pos++];
      const readSID = () => {
          const sid = (bytes[pos] << 8) | bytes[pos + 1];
          pos += 2;
          return sid;
      };
      const pushEntry = (sid) => {
          if (isCIDFont) {
              cids.push(sid);
              names.push(`cid${sid}`);
          }
          else {
              names.push(cffSIDToString(sid, stringIndex) || `G${names.length}`);
          }
      };
      if (format === 0) {
          while (names.length < glyphCount && pos + 1 < bytes.length) {
              const sid = readSID();
              pushEntry(sid);
          }
      }
      else if (format === 1 || format === 2) {
          const nLeftSize = format === 1 ? 1 : 2;
          while (names.length < glyphCount && pos + 1 < bytes.length) {
              const sid = readSID();
              let nLeft = 0;
              if (nLeftSize === 1) {
                  nLeft = (_a = bytes[pos++]) !== null && _a !== void 0 ? _a : 0;
              }
              else {
                  nLeft = ((bytes[pos] << 8) | ((_b = bytes[pos + 1]) !== null && _b !== void 0 ? _b : 0)) >>> 0;
                  pos += 2;
              }
              for (let i = 0; i <= nLeft && names.length < glyphCount; i++) {
                  pushEntry(sid + i);
              }
          }
      }
      else {
          while (names.length < glyphCount)
              names.push(`G${names.length}`);
      }
      while (names.length < glyphCount)
          names.push(`G${names.length}`);
      return { names, cids: isCIDFont ? cids : null };
  }
  function parseCFFPrivateDict(bytes, view, privateOffset, privateSize) {
      const localSubrs = {};
      let localSubrRawObjects = null;
      let localSubrBias = 0;
      let defaultWidthX = 0;
      let nominalWidthX = 0;
      if (typeof privateOffset !== 'number' || typeof privateSize !== 'number' || privateSize <= 0) {
          return { localSubrs, localSubrRawObjects, localSubrBias, defaultWidthX, nominalWidthX };
      }
      const privBytes = bytes.slice(privateOffset, privateOffset + privateSize);
      const privDict = parseCFFDict(privBytes);
      const subrOffset = privDict[19];
      defaultWidthX = typeof privDict[20] === 'number' ? privDict[20] : 0;
      nominalWidthX = typeof privDict[21] === 'number' ? privDict[21] : 0;
      if (typeof subrOffset === 'number') {
          const subrPos = privateOffset + subrOffset;
          const subrOffRef = { off: subrPos };
          const subrIndex = readCFFIndex(view, bytes, subrOffRef);
          const lCount = subrIndex.objects.length;
          const lBias = calcSubrBias(lCount);
          localSubrRawObjects = subrIndex.objects;
          localSubrBias = lBias;
          for (let i = 0; i < lCount; i++) {
              const obj = subrIndex.objects[i];
              const commands = decodeCharStringProgram(obj);
              const toks = tokenizeCharStringProgram(commands, 'subr' + i);
              localSubrs[i] = toks;
          }
          localSubrs.__bias = lBias;
      }
      return { localSubrs, localSubrRawObjects, localSubrBias, defaultWidthX, nominalWidthX };
  }
  function parseCFFFDArray(bytes, view, fdArrayOffset) {
      if (typeof fdArrayOffset !== 'number' || fdArrayOffset <= 0) {
          return [];
      }
      const unitsPerEmFromFontMatrix = (fontMatrix) => {
          if (!Array.isArray(fontMatrix) || !fontMatrix.length)
              return null;
          const scale = Number(fontMatrix[0]);
          if (!Number.isFinite(scale) || scale === 0)
              return null;
          const upm = Math.round(1 / Math.abs(scale));
          return Number.isFinite(upm) && upm > 0 && upm < 65536 ? upm : null;
      };
      const fdOffRef = { off: fdArrayOffset };
      const fdIndex = readCFFIndex(view, bytes, fdOffRef);
      const entries = [];
      for (const obj of fdIndex.objects) {
          const fdDict = parseCFFDict(obj);
          const fdPrivInfo = fdDict[18];
          const privateSize = Array.isArray(fdPrivInfo) ? fdPrivInfo[0] : fdPrivInfo;
          const privateOffset = Array.isArray(fdPrivInfo) ? fdPrivInfo[1] : undefined;
          const unitsPerEm = unitsPerEmFromFontMatrix(fdDict[1207]);
          const priv = parseCFFPrivateDict(bytes, view, privateOffset, privateSize);
          entries.push({
              localSubrs: priv.localSubrs,
              localSubrRawObjects: priv.localSubrRawObjects,
              localSubrBias: priv.localSubrBias,
              defaultWidthX: priv.defaultWidthX,
              nominalWidthX: priv.nominalWidthX,
              unitsPerEm
          });
      }
      return entries;
  }
  function parseCFFFDSelect(bytes, view, fdSelectOffset, glyphCount) {
      if (typeof fdSelectOffset !== 'number' || fdSelectOffset <= 0 || glyphCount <= 0) {
          return null;
      }
      let pos = fdSelectOffset;
      if (pos >= bytes.length) {
          return null;
      }
      const format = bytes[pos++];
      const fdSelect = new Uint16Array(glyphCount);
      if (format === 0) {
          for (let i = 0; i < glyphCount; i++) {
              if (pos >= bytes.length)
                  break;
              fdSelect[i] = bytes[pos++];
          }
          return fdSelect;
      }
      if (format === 3) {
          if (pos + 2 > bytes.length)
              return null;
          const nRanges = view.getUint16(pos, false);
          pos += 2;
          const ranges = [];
          for (let i = 0; i < nRanges; i++) {
              if (pos + 3 > bytes.length)
                  break;
              const first = view.getUint16(pos, false);
              pos += 2;
              const fd = bytes[pos++];
              ranges.push({ first, fd });
          }
          if (pos + 2 > bytes.length)
              return null;
          const sentinel = view.getUint16(pos, false);
          for (let i = 0; i < ranges.length; i++) {
              const start = ranges[i].first;
              const end = (i + 1 < ranges.length) ? ranges[i + 1].first : sentinel;
              for (let g = start; g < end && g < glyphCount; g++) {
                  fdSelect[g] = ranges[i].fd;
              }
          }
          return fdSelect;
      }
      return null;
  }
  function parseCFFFont(byteArray, forceCID = false) {
      const bytes = byteArray;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      let offRef = { off: 0 };
      const major = view.getUint8(offRef.off++);
      const minor = view.getUint8(offRef.off++);
      const hdrSize = view.getUint8(offRef.off++);
      const offSize = view.getUint8(offRef.off++);
      if (major !== 1)
          throw new Error('Unsupported CFF major version: ' + major);
      offRef.off = hdrSize;
      const nameIndex = readCFFIndex(view, bytes, offRef);
      const topIndex = readCFFIndex(view, bytes, offRef);
      if (!topIndex.objects.length)
          throw new Error('No top dict in CFF');
      const topDictData = parseCFFDict(topIndex.objects[0]);
      const isCIDFont = forceCID || topDictData[1230] != null;
      const stringIndex = readCFFIndex(view, bytes, offRef);
      const charStringsOffset = topDictData[17];
      const charsetOffset = typeof topDictData[15] === 'number' ? topDictData[15] : 0;
      const privateInfo = topDictData[18];
      const privateSize = Array.isArray(privateInfo) ? privateInfo[0] : privateInfo;
      const privateOffset = Array.isArray(privateInfo) ? privateInfo[1] : undefined;
      if (typeof charStringsOffset !== 'number') {
          throw new Error('Missing CharStrings offset in CFF');
      }
      const gsubrIndex = readCFFIndex(view, bytes, offRef);
      const gsubrs = {};
      const gCount = gsubrIndex.objects.length;
      const gBias = calcSubrBias(gCount);
      for (let i = 0; i < gCount; i++) {
          const obj = gsubrIndex.objects[i];
          const commands = decodeCharStringProgram(obj);
          const toks = tokenizeCharStringProgram(commands, 'gsubr' + i);
          gsubrs[i] = toks;
      }
      const priv = parseCFFPrivateDict(bytes, view, privateOffset, privateSize);
      const localSubrs = priv.localSubrs;
      const localSubrRawObjects = priv.localSubrRawObjects;
      const localSubrBias = priv.localSubrBias;
      let defaultWidthX = priv.defaultWidthX;
      let nominalWidthX = priv.nominalWidthX;
      const csOffRef = { off: charStringsOffset };
      const csIndex = readCFFIndex(view, bytes, csOffRef);
      const fdArrayOffset = topDictData[1236];
      const fdSelectOffset = topDictData[1237];
      const fdArray = isCIDFont ? parseCFFFDArray(bytes, view, fdArrayOffset) : null;
      const fdSelect = isCIDFont ? parseCFFFDSelect(bytes, view, fdSelectOffset, csIndex.objects.length) : null;
      const unitsPerEmFromFontMatrix = (fontMatrix) => {
          if (!Array.isArray(fontMatrix) || !fontMatrix.length)
              return null;
          const scale = Number(fontMatrix[0]);
          if (!Number.isFinite(scale) || scale === 0)
              return null;
          const upm = Math.round(1 / Math.abs(scale));
          return Number.isFinite(upm) && upm > 0 && upm < 65536 ? upm : null;
      };
      let unitsPerEm = unitsPerEmFromFontMatrix(topDictData[1207]);
      if (!unitsPerEm && Array.isArray(fdArray)) {
          for (const fd of fdArray) {
              if (Number.isFinite(fd === null || fd === void 0 ? void 0 : fd.unitsPerEm) && fd.unitsPerEm > 0) {
                  unitsPerEm = fd.unitsPerEm;
                  break;
              }
          }
      }
      const glyphs = {};
      const charsetInfo = parseCFFCharset(bytes, charsetOffset, csIndex.objects.length, stringIndex.objects, isCIDFont);
      const glyphNames = charsetInfo.names;
      const glyphIndexMap = new Map();
      for (let i = 0; i < csIndex.objects.length; i++) {
          const obj = csIndex.objects[i];
          // For CID fonts, use per-FD local subrs for hint counting
          let lSubrRaw = localSubrRawObjects;
          let lSubrBias = localSubrBias;
          if (isCIDFont && fdSelect && fdArray) {
              const fdIdx = fdSelect[i] || 0;
              const fd = fdArray[fdIdx];
              if (fd) {
                  lSubrRaw = fd.localSubrRawObjects;
                  lSubrBias = fd.localSubrBias;
              }
          }
          const hintTotal = preCountCFFHints(obj, lSubrRaw, lSubrBias, gsubrIndex.objects, gBias);
          const commands = decodeCharStringProgram(obj, hintTotal);
          const name = glyphNames[i] || ('G' + i);
          glyphs[name] = commands;
          glyphIndexMap.set(name, i);
      }
      let cidToGidMap = null;
      if (isCIDFont && Array.isArray(charsetInfo.cids)) {
          cidToGidMap = new Map();
          for (let i = 0; i < charsetInfo.cids.length; i++) {
              const cid = charsetInfo.cids[i];
              if (Number.isFinite(cid))
                  cidToGidMap.set(cid, i);
          }
      }
      return { glyphs, glyphOrder: glyphNames, glyphIndexMap, localSubrs, globalSubrs: gsubrs, globalBias: gBias, defaultWidthX, nominalWidthX, cidToGidMap, isCIDFont, fdArray, fdSelect, unitsPerEm: unitsPerEm || 1000 };
  }
  function tokenizeCharStringProgram(text) {
      if (!text)
          return [];
      return text.split(/\s+/).map(t => t.trim()).filter(Boolean);
  }
  function parseCFFCharString(name, text, subrs, globalSubrs, globalBias, defaultWidthX = 0, nominalWidthX = 0, options = null) {
      const tokens = tokenizeCharStringProgram(text);
      let stack = [];
      let cx = 0;
      let cy = 0;
      let sbx = 0;
      let width = 0;
      let widthParsed = false;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let inFlex = false;
      let flexDeltas = [];
      const missingSubrs = new Set();
      const segments = [];
      const ascent = 717;
      const seacDepth = Number.isFinite(options === null || options === void 0 ? void 0 : options.seacDepth) ? options.seacDepth : 0;
      const resolveSeacComponent = typeof (options === null || options === void 0 ? void 0 : options.resolveSeacComponent) === 'function' ? options.resolveSeacComponent : null;
      function updateBounds(x, y) {
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
      }
      function moveTo(x, y) {
          cx = x;
          cy = y;
          segments.push({ cmd: 'M', x, y });
          updateBounds(x, y);
      }
      function lineTo(x, y) {
          cx = x;
          cy = y;
          segments.push({ cmd: 'L', x, y });
          updateBounds(x, y);
      }
      function curveTo(x1, y1, x2, y2, x3, y3) {
          segments.push({ cmd: 'C', x1, y1, x2, y2, x3, y3 });
          updateBounds(x1, y1);
          updateBounds(x2, y2);
          updateBounds(x3, y3);
          cx = x3;
          cy = y3;
      }
      function closePath() {
          segments.push({ cmd: 'Z' });
      }
      function appendPath(path, tx = 0, ty = 0) {
          if (!Array.isArray(path))
              return;
          for (const seg of path) {
              if (!seg || !seg.cmd)
                  continue;
              if (seg.cmd === 'M') {
                  const x = (seg.x || 0) + tx;
                  const y = (seg.y || 0) + ty;
                  moveTo(x, y);
                  continue;
              }
              if (seg.cmd === 'L') {
                  const x = (seg.x || 0) + tx;
                  const y = (seg.y || 0) + ty;
                  lineTo(x, y);
                  continue;
              }
              if (seg.cmd === 'C') {
                  const x1 = (seg.x1 || 0) + tx;
                  const y1 = (seg.y1 || 0) + ty;
                  const x2 = (seg.x2 || 0) + tx;
                  const y2 = (seg.y2 || 0) + ty;
                  const x3 = (seg.x3 || 0) + tx;
                  const y3 = (seg.y3 || 0) + ty;
                  curveTo(x1, y1, x2, y2, x3, y3);
                  continue;
              }
              if (seg.cmd === 'Z') {
                  closePath();
              }
          }
      }
      function curveToRel(dx1, dy1, dx2, dy2, dx3, dy3) {
          const x1 = cx + dx1;
          const y1 = cy + dy1;
          const x2 = x1 + dx2;
          const y2 = y1 + dy2;
          const x3 = x2 + dx3;
          const y3 = y2 + dy3;
          curveTo(x1, y1, x2, y2, x3, y3);
      }
      function popAll() {
          if (!stack.length)
              return [];
          const args = stack.slice();
          stack = [];
          return args;
      }
      function consumeHCurve(args) {
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
      }
      function consumeVCurve(args) {
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
      }
      function execute(tokenList, depth = 0) {
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
                      const w = stack.pop();
                      width = nominalWidthX + (w || 0);
                      widthParsed = true;
                      sbx = stack.pop();
                      cx = sbx;
                      cy = 0;
                      updateBounds(cx, cy);
                      stack = [];
                      break;
                  }
                  case 'sbw': {
                      if (stack.length >= 4) {
                          const w = stack.pop();
                          width = nominalWidthX + (w || 0);
                          widthParsed = true;
                          stack.pop();
                          sbx = stack.pop();
                          cy = stack.pop();
                      }
                      else if (stack.length >= 2) {
                          const w = stack.pop();
                          width = nominalWidthX + (w || 0);
                          widthParsed = true;
                          sbx = stack.pop();
                          cy = 0;
                      }
                      cx = sbx;
                      updateBounds(cx, cy);
                      stack = [];
                      break;
                  }
                  case 'hstem':
                  case 'hstem3':
                  case 'vstem':
                  case 'vstem3':
                  case 'dotsection':
                  case 'hstemhm':
                  case 'vstemhm':
                  case 'hintmask':
                  case 'cntrmask':
                      // Type 2 width may appear as first arg when odd number of args
                      if (!widthParsed && (stack.length % 2 === 1)) {
                          const w = stack.shift() || 0;
                          width = nominalWidthX + w;
                          widthParsed = true;
                      }
                      stack = [];
                      break;
                  case 'seac': {
                      if (resolveSeacComponent && seacDepth < 6 && stack.length >= 4) {
                          let args = stack.slice();
                          if (!widthParsed && args.length > 5) {
                              const w = args.shift() || 0;
                              width = nominalWidthX + w;
                              widthParsed = true;
                          }
                          if (args.length === 5) {
                              const asb = Number(args[0]) || 0;
                              const adx = Number(args[1]) || 0;
                              const ady = Number(args[2]) || 0;
                              const bchar = Number(args[3]) || 0;
                              const achar = Number(args[4]) || 0;
                              const baseGlyph = resolveSeacComponent(bchar, seacDepth + 1);
                              const accentGlyph = resolveSeacComponent(achar, seacDepth + 1);
                              if (baseGlyph && Array.isArray(baseGlyph.path)) {
                                  appendPath(baseGlyph.path, 0, 0);
                                  if (!widthParsed && baseGlyph.metrics && Number.isFinite(baseGlyph.metrics.advanceWidth)) {
                                      width = baseGlyph.metrics.advanceWidth;
                                      widthParsed = true;
                                  }
                              }
                              if (accentGlyph && Array.isArray(accentGlyph.path)) {
                                  appendPath(accentGlyph.path, adx - asb, ady);
                              }
                          }
                          else if (args.length === 4) {
                              const asb = 0;
                              const adx = Number(args[0]) || 0;
                              const ady = Number(args[1]) || 0;
                              const bchar = Number(args[2]) || 0;
                              const achar = Number(args[3]) || 0;
                              const baseGlyph = resolveSeacComponent(bchar, seacDepth + 1);
                              const accentGlyph = resolveSeacComponent(achar, seacDepth + 1);
                              if (baseGlyph && Array.isArray(baseGlyph.path)) {
                                  appendPath(baseGlyph.path, 0, 0);
                                  if (!widthParsed && baseGlyph.metrics && Number.isFinite(baseGlyph.metrics.advanceWidth)) {
                                      width = baseGlyph.metrics.advanceWidth;
                                      widthParsed = true;
                                  }
                              }
                              if (accentGlyph && Array.isArray(accentGlyph.path)) {
                                  appendPath(accentGlyph.path, adx - asb, ady);
                              }
                          }
                      }
                      stack = [];
                      return;
                  }
                  case 'vmoveto': {
                      // In Type 2 charstrings, the first operator may include width.
                      let dy;
                      if (!widthParsed && stack.length === 2) {
                          const w = stack.shift() || 0;
                          width = nominalWidthX + w;
                          widthParsed = true;
                          dy = stack.pop() || 0;
                      }
                      else {
                          dy = stack.pop() || 0;
                      }
                      if (inFlex) {
                          flexDeltas.push({ dx: 0, dy });
                      }
                      else {
                          cy += dy;
                          moveTo(cx, cy);
                      }
                      stack = [];
                      break;
                  }
                  case 'hmoveto': {
                      // In Type 2 charstrings, the first operator may include width.
                      let dx;
                      if (!widthParsed && stack.length === 2) {
                          const w = stack.shift() || 0;
                          width = nominalWidthX + w;
                          widthParsed = true;
                          dx = stack.pop() || 0;
                      }
                      else {
                          dx = stack.pop() || 0;
                      }
                      if (inFlex) {
                          flexDeltas.push({ dx, dy: 0 });
                      }
                      else {
                          cx += dx;
                          moveTo(cx, cy);
                      }
                      stack = [];
                      break;
                  }
                  case 'rmoveto': {
                      const args = popAll();
                      if (!args.length)
                          break;
                      // Type 2 width can be the first operand when count is odd.
                      if (!widthParsed && (args.length % 2 === 1)) {
                          const w = args.shift() || 0;
                          width = nominalWidthX + w;
                          widthParsed = true;
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
                          if (horizontal) {
                              cx += value;
                          }
                          else {
                              cy += value;
                          }
                          lineTo(cx, cy);
                          horizontal = !horizontal;
                      }
                      break;
                  }
                  case 'vlineto': {
                      const args = popAll();
                      let vertical = true;
                      for (const value of args) {
                          if (vertical) {
                              cy += value;
                          }
                          else {
                              cx += value;
                          }
                          lineTo(cx, cy);
                          vertical = !vertical;
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
                  case 'hflex': {
                      // Draw a horizontal flex with 7 operands.  Based on the
                      // specification: dx1 dy1 dx2 dy2 dx3 dx4 dx5 dx6 dx7 ??? Actually
                      // according to Adobe, hflex uses 7 arguments: (dx1, dx2, dy2,
                      // dx3, dx4, dx5, dx6).  ttf2c.html implementation uses two
                      // curveToRel calls with these values: args[0], 0, args[1], args[2],
                      // args[3], 0 and then args[4], 0, args[5], 0, args[6], 0.
                      const args = popAll();
                      if (args.length >= 7) {
                          curveToRel(args[0], 0, args[1], args[2], args[3], 0);
                          curveToRel(args[4], 0, args[5], 0, args[6], 0);
                      }
                      stack = [];
                      inFlex = false;
                      flexDeltas = [];
                      break;
                  }
                  case 'hflex1': {
                      // Draw a horizontal flex where the first curve has a vertical
                      // component.  Requires at least 9 arguments.  ttf2c.html draws
                      // curveToRel(args[0], args[1], args[2], args[3], args[4], 0) then
                      // curveToRel(args[5], 0, args[6], args[7], args[8], 0).
                      const args = popAll();
                      if (args.length >= 9) {
                          curveToRel(args[0], args[1], args[2], args[3], args[4], 0);
                          curveToRel(args[5], 0, args[6], args[7], args[8], 0);
                      }
                      stack = [];
                      inFlex = false;
                      flexDeltas = [];
                      break;
                  }
                  case 'flex': {
                      // Render the two-curve flex sequence (13 operands; ignore last depth)
                      const args = popAll();
                      if (args.length >= 12) {
                          curveToRel(args[0], args[1], args[2], args[3], args[4], args[5]);
                          curveToRel(args[6], args[7], args[8], args[9], args[10], args[11]);
                      }
                      stack = [];
                      inFlex = false;
                      flexDeltas = [];
                      break;
                  }
                  case 'flex1': {
                      // Render flex1 by distributing final delta to axis with smaller sum
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
                      stack = [];
                      inFlex = false;
                      flexDeltas = [];
                      break;
                  }
                  case 'endflex':
                      inFlex = false;
                      flexDeltas = [];
                      stack = [];
                      break;
                  case 'callsubr': {
                      const subrValue = stack.pop();
                      const subr = Math.trunc(subrValue);
                      const lBias = subrs && subrs.__bias || 0;
                      const idx = subr + lBias;
                      const subrTokens = subrs && subrs[idx];
                      if (subrTokens) {
                          execute(subrTokens, depth + 1);
                      }
                      else {
                          missingSubrs.add(idx);
                      }
                      break;
                  }
                  case 'callgsubr': {
                      const subrValue = stack.pop();
                      const subr = Math.trunc(subrValue);
                      const idx = subr + (globalBias || 0);
                      const gTokens = globalSubrs && globalSubrs[idx];
                      if (gTokens) {
                          execute(gTokens, depth + 1);
                      }
                      else {
                          missingSubrs.add(idx);
                      }
                      break;
                  }
                  case 'rcurveline': {
                      const args = popAll();
                      if (args.length >= 8) {
                          const curveCount = Math.floor((args.length - 2) / 6);
                          let k = 0;
                          for (let c = 0; c < curveCount; c++) {
                              if (k + 5 >= args.length)
                                  break;
                              curveToRel(args[k], args[k + 1], args[k + 2], args[k + 3], args[k + 4], args[k + 5]);
                              k += 6;
                          }
                          if (k + 1 < args.length) {
                              const dx = args[k];
                              const dy = args[k + 1] || 0;
                              cx += dx;
                              cy += dy;
                              lineTo(cx, cy);
                          }
                      }
                      break;
                  }
                  case 'rlinecurve': {
                      const args = popAll();
                      if (args.length >= 8) {
                          const curveArgs = args.slice(-6);
                          const lineArgs = args.slice(0, args.length - 6);
                          for (let j = 0; j + 1 < lineArgs.length; j += 2) {
                              cx += lineArgs[j];
                              cy += lineArgs[j + 1] || 0;
                              lineTo(cx, cy);
                          }
                          if (curveArgs.length === 6) {
                              curveToRel(curveArgs[0], curveArgs[1], curveArgs[2], curveArgs[3], curveArgs[4], curveArgs[5]);
                          }
                      }
                      break;
                  }
                  case 'vvcurveto': {
                      const args = popAll();
                      if (args.length >= 4) {
                          let k = 0;
                          let dx = 0;
                          if (args.length % 4 === 1) {
                              dx = args[k++];
                          }
                          while (k + 3 < args.length) {
                              const dya = args[k++];
                              const dxb = args[k++];
                              const dyb = args[k++];
                              const dyc = args[k++];
                              curveToRel(dx, dya, dxb, dyb, 0, dyc);
                              dx = 0;
                          }
                      }
                      break;
                  }
                  case 'hhcurveto': {
                      const args = popAll();
                      if (args.length >= 4) {
                          let k = 0;
                          let dy = 0;
                          if (args.length % 4 === 1) {
                              dy = args[k++];
                          }
                          while (k + 3 < args.length) {
                              const dxa = args[k++];
                              const dxb = args[k++];
                              const dyb = args[k++];
                              const dxc = args[k++];
                              curveToRel(dxa, dy, dxb, dyb, dxc, 0);
                              dy = 0;
                          }
                      }
                      break;
                  }
                  case 'callothersubr':
                      stack = [];
                      break;
                  case 'pop':
                      if (stack.length)
                          stack.pop();
                      break;
                  case 'closepath':
                      closePath();
                      stack = [];
                      break;
                  case 'endchar':
                      // Type2 seac emulation: endchar can carry the deprecated accent-composition
                      // args (typically adx, ady, bchar, achar), with optional leading width.
                      // Some sources may still provide a 5-arg Type1-style form.
                      if (resolveSeacComponent && seacDepth < 6 && stack.length >= 4) {
                          let args = stack.slice();
                          if (args.length === 4) {
                              const asb = 0;
                              const adx = Number(args[0]) || 0;
                              const ady = Number(args[1]) || 0;
                              const bchar = Number(args[2]) || 0;
                              const achar = Number(args[3]) || 0;
                              const baseGlyph = resolveSeacComponent(bchar, seacDepth + 1);
                              const accentGlyph = resolveSeacComponent(achar, seacDepth + 1);
                              if (baseGlyph && Array.isArray(baseGlyph.path)) {
                                  appendPath(baseGlyph.path, 0, 0);
                                  if (!widthParsed && baseGlyph.metrics && Number.isFinite(baseGlyph.metrics.advanceWidth)) {
                                      width = baseGlyph.metrics.advanceWidth;
                                      widthParsed = true;
                                  }
                              }
                              if (accentGlyph && Array.isArray(accentGlyph.path)) {
                                  appendPath(accentGlyph.path, adx - asb, ady);
                              }
                          }
                          else if (args.length === 5) {
                              // Type2 endchar composite with optional leading width.
                              // Operand order: [w] adx ady bchar achar.
                              if (!widthParsed) {
                                  const w = Number(args.shift()) || 0;
                                  width = nominalWidthX + w;
                                  widthParsed = true;
                              }
                              const asb = 0;
                              const adx = Number(args[0]) || 0;
                              const ady = Number(args[1]) || 0;
                              const bchar = Number(args[2]) || 0;
                              const achar = Number(args[3]) || 0;
                              const baseGlyph = resolveSeacComponent(bchar, seacDepth + 1);
                              const accentGlyph = resolveSeacComponent(achar, seacDepth + 1);
                              if (baseGlyph && Array.isArray(baseGlyph.path)) {
                                  appendPath(baseGlyph.path, 0, 0);
                                  if (!widthParsed && baseGlyph.metrics && Number.isFinite(baseGlyph.metrics.advanceWidth)) {
                                      width = baseGlyph.metrics.advanceWidth;
                                      widthParsed = true;
                                  }
                              }
                              if (accentGlyph && Array.isArray(accentGlyph.path)) {
                                  appendPath(accentGlyph.path, adx - asb, ady);
                              }
                          }
                      }
                      return;
                  default:
                      stack = [];
                      break;
              }
          }
      }
      execute(tokens);
      // If no width was parsed from the charstring, use defaultWidthX
      if (!widthParsed) {
          width = defaultWidthX;
      }
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
      const bounds = { minX, minY, maxX, maxY };
      const path = segments.map(seg => ({ ...seg }));
      const advanceWidth = Number.isFinite(width) && width > 0
          ? width
          : Math.max(0, rightBound - leftBound);
      const metrics = {
          unitsPerEm: 1000,
          leftSideBearing: sbx,
          advanceWidth,
          leftBound,
          rightBound,
          bottomBound: minY,
          topBound: maxY,
          missingSubrs: [...missingSubrs].sort((a, b) => a - b)
      };
      return {
          path,
          bounds,
          metrics,
          missingSubrs: [...missingSubrs].sort((a, b) => a - b)
      };
  }
  class CFFFont {
      constructor(bytes) {
          this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array();
          this.unitsPerEm = 1000;
          this.charStrings = new Map();
          this.glyphOrder = [];
          this.glyphCount = 0;
          this.localSubrs = {};
          this.globalSubrs = {};
          this.globalBias = 0;
          this.defaultWidthX = 0;
          this.nominalWidthX = 0;
          this.defaultGlyphName = '.notdef';
          this.parsed = false;
          this.cidToGidMap = null;
          this.isCIDFont = false;
          this.forceCID = false;
          this.fdArray = null;
          this.fdSelect = null;
          this.glyphIndexMap = null;
      }
      parse() {
          if (this.parsed)
              return;
          try {
              const parsed = parseCFFFont(this.bytes, !!this.forceCID);
              this.charStrings = new Map(Object.entries(parsed.glyphs));
              this.glyphOrder = parsed.glyphOrder || [];
              this.glyphIndexMap = parsed.glyphIndexMap || null;
              this.localSubrs = parsed.localSubrs || {};
              this.globalSubrs = parsed.globalSubrs || {};
              this.globalBias = parsed.globalBias || 0;
              this.defaultWidthX = parsed.defaultWidthX || 0;
              this.nominalWidthX = parsed.nominalWidthX || 0;
              this.unitsPerEm = Number.isFinite(parsed.unitsPerEm) && parsed.unitsPerEm > 0 ? parsed.unitsPerEm : 1000;
              this.cidToGidMap = parsed.cidToGidMap || null;
              this.isCIDFont = !!parsed.isCIDFont;
              this.fdArray = parsed.fdArray || null;
              this.fdSelect = parsed.fdSelect || null;
              globalSubrTokens = this.globalSubrs;
              globalSubrBias = this.globalBias;
              if (this.charStrings.has('.notdef'))
                  this.defaultGlyphName = '.notdef';
              else if (this.glyphOrder.length && this.charStrings.has(this.glyphOrder[0]))
                  this.defaultGlyphName = this.glyphOrder[0];
              else if (this.charStrings.size)
                  this.defaultGlyphName = this.charStrings.keys().next().value || '.notdef';
              this.glyphCount = this.glyphOrder.length || this.charStrings.size || 0;
              this.parsed = true;
          }
          catch (err) {
              throw new Error('Failed to parse CFF font: ' + err.message);
          }
      }
      _glyphParseContext(index) {
          const fallback = {
              localSubrs: this.localSubrs,
              defaultWidthX: this.defaultWidthX,
              nominalWidthX: this.nominalWidthX
          };
          if (!this.fdSelect || !this.fdArray || !Number.isFinite(index))
              return fallback;
          const fdIndex = this.fdSelect[index];
          if (!Number.isFinite(fdIndex))
              return fallback;
          const fd = this.fdArray[fdIndex];
          if (!fd)
              return fallback;
          return {
              localSubrs: fd.localSubrs || this.localSubrs,
              defaultWidthX: Number.isFinite(fd.defaultWidthX) ? fd.defaultWidthX : this.defaultWidthX,
              nominalWidthX: Number.isFinite(fd.nominalWidthX) ? fd.nominalWidthX : this.nominalWidthX
          };
      }
      _loadSeacComponentByStandardCode(code, depth = 0) {
          if (!this.parsed)
              this.parse();
          if (!Number.isFinite(code) || depth > 6)
              return null;
          const standardNames = (typeof window !== 'undefined' && Array.isArray(window.STANDARD_ENCODING_NAMES))
              ? window.STANDARD_ENCODING_NAMES
              : null;
          if (!standardNames || !standardNames.length)
              return null;
          const idx = code & 0xff;
          const mappedName = SEAC_STANDARD_OVERRIDES[idx] || standardNames[idx];
          if (!mappedName)
              return null;
          let key = mappedName;
          const tryFindCaseInsensitive = (name) => {
              if (this.charStrings.has(name))
                  return name;
              const nameLower = String(name).toLowerCase();
              for (const k of this.charStrings.keys()) {
                  if (k.toLowerCase() === nameLower) {
                      return k;
                  }
              }
              return null;
          };
          const tryFindByUnicode = (name) => {
              const uni = glyphNameToUnicode(name);
              if (!uni || !uni.length)
                  return null;
              for (const k of this.charStrings.keys()) {
                  const kUni = glyphNameToUnicode(k);
                  if (kUni && kUni === uni) {
                      return k;
                  }
              }
              return null;
          };
          if (!this.charStrings.has(key)) {
              const aliasMap = {
                  asciitilde: 'tilde',
                  quoteleft: 'grave',
                  quoteright: 'acute',
                  quotedblleft: 'dieresis',
                  quotedblright: 'dieresis'
              };
              const alias = aliasMap[String(key).toLowerCase()];
              if (alias) {
                  const aliasKey = tryFindCaseInsensitive(alias);
                  if (aliasKey)
                      key = aliasKey;
              }
          }
          if (!this.charStrings.has(key)) {
              const ci = tryFindCaseInsensitive(key);
              if (ci)
                  key = ci;
          }
          if (!this.charStrings.has(key)) {
              const byUni = tryFindByUnicode(key);
              if (byUni)
                  key = byUni;
          }
          if (!this.charStrings.has(key)) {
              const nameLower = key.toLowerCase();
              for (const k of this.charStrings.keys()) {
                  if (k.toLowerCase() === nameLower) {
                      key = k;
                      break;
                  }
              }
          }
          if (!this.charStrings.has(key))
              return null;
          const program = this.charStrings.get(key);
          if (!program)
              return null;
          let index = null;
          if (this.glyphIndexMap && this.glyphIndexMap.has(key)) {
              index = this.glyphIndexMap.get(key);
          }
          const ctx = this._glyphParseContext(index);
          return parseCFFCharString(key, program, ctx.localSubrs, this.globalSubrs, this.globalBias, ctx.defaultWidthX, ctx.nominalWidthX, {
              seacDepth: depth,
              resolveSeacComponent: (componentCode, nextDepth) => this._loadSeacComponentByStandardCode(componentCode, nextDepth)
          });
      }
      loadGlyphByName(name) {
          if (!this.parsed)
              this.parse();
          let key = name;
          if (!this.charStrings.has(key)) {
              // Try case-insensitive lookup for glyph names like "g1" vs "G1"
              const nameLower = name.toLowerCase();
              for (const k of this.charStrings.keys()) {
                  if (k.toLowerCase() === nameLower) {
                      key = k;
                      break;
                  }
              }
              // If still not found, use default
              if (!this.charStrings.has(key))
                  key = this.defaultGlyphName;
          }
          const program = this.charStrings.get(key);
          if (!program)
              return null;
          let index = null;
          if (this.glyphIndexMap && this.glyphIndexMap.has(key)) {
              index = this.glyphIndexMap.get(key);
          }
          const ctx = this._glyphParseContext(index);
          return parseCFFCharString(key, program, ctx.localSubrs, this.globalSubrs, this.globalBias, ctx.defaultWidthX, ctx.nominalWidthX, {
              seacDepth: 0,
              resolveSeacComponent: (componentCode, nextDepth) => this._loadSeacComponentByStandardCode(componentCode, nextDepth)
          });
      }
      loadGlyphByIndex(index) {
          if (!this.parsed)
              this.parse();
          if (!Number.isFinite(index) || index < 0)
              return this.loadGlyphByName(this.defaultGlyphName);
          const name = this.glyphOrder[index];
          if (name && this.charStrings.has(name))
              return this.loadGlyphByName(name);
          return this.loadGlyphByName(this.defaultGlyphName);
      }
  }

  function isCFFLike(bytes) {
      return bytes instanceof Uint8Array && bytes.length >= 2 && bytes[0] === 0x01 && bytes[1] === 0x00;
  }

  function extractCFFTableFromOpenTypeBytes(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length < 24)
          return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const numTables = view.getUint16(4, false);
      for (let i = 0; i < numTables; i++) {
          const off = 12 + i * 16;
          if (off + 16 > bytes.length)
              break;
          const tag = view.getUint32(off, false);
          const tagStr = String.fromCharCode((tag >> 24) & 255, (tag >> 16) & 255, (tag >> 8) & 255, tag & 255);
          if (tagStr === 'CFF ' || tagStr === 'CFF2') {
              const tableOffset = view.getUint32(off + 8, false);
              const tableLength = view.getUint32(off + 12, false);
              if (tableOffset + tableLength <= bytes.length) {
                  return bytes.slice(tableOffset, tableOffset + tableLength);
              }
          }
      }
      return null;
  }

  // Expose to window
  if (typeof window !== 'undefined') {
    window.CFFFont = CFFFont;
    window.parseCFFFont = parseCFFFont;
    window.parseCFFCharString = parseCFFCharString;
    window.CFF_STANDARD_STRINGS = CFF_STANDARD_STRINGS;
    window.decodeCharStringProgram = decodeCharStringProgram;
    window.tokenizeCharStringProgram = tokenizeCharStringProgram;
    window.isCFFLike = isCFFLike;
    window.extractCFFTableFromOpenTypeBytes = extractCFFTableFromOpenTypeBytes;
  }
})();
