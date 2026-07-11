'use strict';

// Show error toast
function showError(message = 'Oops, something went wrong', autoDismiss = false) {
  const toast = document.getElementById('error-toast');
  if (!toast) return; // Skip if error toast doesn't exist

  const messageEl = document.getElementById('error-toast-message');

  if (messageEl) {
    messageEl.textContent = message;
  } else {
    toast.textContent = message;
  }

  toast.classList.add('show');

  // Auto-dismiss only for specific errors (like unsupported format)
  if (autoDismiss) {
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
}

// Shared helpers required by the Type 1 conversion code.
window.bytesToLatin1 = function(bytes) {
  if (!(bytes instanceof Uint8Array)) return '';
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
};
function findEmbeddedType1Start(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return -1;
  const sampleLen = Math.min(bytes.length, 8192);
  const head = new TextDecoder('latin1', { fatal: false }).decode(bytes.subarray(0, sampleLen));
  const markers = [
    '%!PS-AdobeFont-',
    '%!FontType1-',
    '%!PS-Adobe-3.0 Resource-Font'
  ];
  let best = -1;
  for (const marker of markers) {
    const idx = head.indexOf(marker);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}
function extractType1FromAppleDouble(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 26) return null;
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, false) !== 0x00051607) return null;
    const entryCount = dv.getUint16(24, false);
    if (26 + entryCount * 12 > bytes.length) return null;

    let resourceFork = null;
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = 26 + i * 12;
      const entryId = dv.getUint32(entryOffset, false);
      const offset = dv.getUint32(entryOffset + 4, false);
      const length = dv.getUint32(entryOffset + 8, false);
      if (entryId === 2 && offset + length <= bytes.length) {
        resourceFork = bytes.subarray(offset, offset + length);
        break;
      }
    }
    if (!resourceFork || resourceFork.length < 16) return null;

    const rv = new DataView(resourceFork.buffer, resourceFork.byteOffset, resourceFork.byteLength);
    const dataOffset = rv.getUint32(0, false);
    const mapOffset = rv.getUint32(4, false);
    if (dataOffset >= resourceFork.length || mapOffset >= resourceFork.length) return null;

    const typeListOffset = mapOffset + rv.getUint16(mapOffset + 24, false);
    if (typeListOffset + 2 > resourceFork.length) return null;
    const typeCount = rv.getUint16(typeListOffset, false) + 1;
    const postResources = [];

    for (let i = 0; i < typeCount; i++) {
      const typeEntryOffset = typeListOffset + 2 + i * 8;
      if (typeEntryOffset + 8 > resourceFork.length) return null;
      const type = bytesToLatin1(resourceFork.subarray(typeEntryOffset, typeEntryOffset + 4));
      if (type !== 'POST') continue;
      const resourceCount = rv.getUint16(typeEntryOffset + 4, false) + 1;
      const refListOffset = typeListOffset + rv.getUint16(typeEntryOffset + 6, false);
      for (let j = 0; j < resourceCount; j++) {
        const refOffset = refListOffset + j * 12;
        if (refOffset + 12 > resourceFork.length) return null;
        const id = rv.getInt16(refOffset, false);
        const attrsAndDataOffset = rv.getUint32(refOffset + 4, false);
        const dataRelOffset = attrsAndDataOffset & 0x00FFFFFF;
        const dataPos = dataOffset + dataRelOffset;
        if (dataPos + 4 > resourceFork.length) return null;
        const dataLength = rv.getUint32(dataPos, false);
        const payloadStart = dataPos + 4;
        const payloadEnd = payloadStart + dataLength;
        if (payloadEnd > resourceFork.length || dataLength < 2) return null;
        postResources.push({
          id,
          data: resourceFork.subarray(payloadStart, payloadEnd)
        });
      }
    }

    if (!postResources.length) return null;
    postResources.sort((a, b) => a.id - b.id);

    const chunks = [];
    for (const { data } of postResources) {
      const kind = (data[0] << 8) | data[1];
      if (kind === 0x0500) continue;
      chunks.push(data.subarray(2));
    }
    if (!chunks.length) return null;

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
      merged.set(chunk, pos);
      pos += chunk.length;
    }

    const embeddedStart = findEmbeddedType1Start(merged);
    if (embeddedStart > 0) return merged.slice(embeddedStart);
    return embeddedStart === 0 ? merged : null;
  } catch (_) {
    return null;
  }
}
window.normalizeType1Bytes = function(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 6) return bytes;
  if (bytes[0] !== 0x80 || bytes[1] < 1 || bytes[1] > 3) {
    const appleDoubleType1 = extractType1FromAppleDouble(bytes);
    if (appleDoubleType1) return appleDoubleType1;
    const embeddedStart = findEmbeddedType1Start(bytes);
    return embeddedStart > 0 ? bytes.slice(embeddedStart) : bytes;
  }
  let offset = 0;
  const chunks = [];
  let foundEnd = false;
  let parsedAny = false;
  while (offset + 6 <= bytes.length && bytes[offset] === 0x80) {
    parsedAny = true;
    const type = bytes[offset + 1];
    const length = (bytes[offset+2] | (bytes[offset+3]<<8) | (bytes[offset+4]<<16) | (bytes[offset+5]<<24)) >>> 0;
    offset += 6;
    if (!length || offset + length > bytes.length) return bytes;
    chunks.push(bytes.slice(offset, offset + length));
    offset += length;
    if (type === 3) { foundEnd = true; break; }
  }
  const trailing = bytes.length - offset;
  const hasTruncatedType3 = trailing === 2 && bytes[offset] === 0x80 && bytes[offset + 1] === 0x03;
  const acceptWithoutType3 = parsedAny && (offset === bytes.length || hasTruncatedType3);
  if (!chunks.length || (!foundEnd && !acceptWithoutType3)) return bytes;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { merged.set(c, pos); pos += c.length; }
  return merged;
};

// Helper to get correct dist path (works from main app and convert/ subdirectory)
function getDistPath(filename) {
  if (typeof window !== 'undefined' && window.__KEYFONT_SOURCE_MODE__) {
    return `src/${filename}`;
  }
  // Check if we're in a subdirectory by looking at current page path
  const isInSubdir = window.location.pathname.includes('/convert/');
  return isInSubdir ? `../dist/${filename}` : `dist/${filename}`;
}

let fontEditorWoff2Module = null;
let fontEditorWoff2InitPromise = null;

// WOFF2 is the one conversion path where we intentionally prefer a
// third-party codec over custom encode/decode logic. The app flow here is
// custom, but the actual binary WOFF2 codec comes from fonteditor-core.
async function loadFontEditorWoff2() {
  if (fontEditorWoff2Module) return fontEditorWoff2Module;

  if (typeof require !== 'undefined') {
    try {
      const mod = require('fonteditor-core');
      await mod.woff2.init();
      fontEditorWoff2Module = {
        encode(input) {
          const out = mod.ttftowoff2(input);
          return out instanceof Uint8Array ? out : new Uint8Array(out);
        },
        decode(input) {
          const out = mod.woff2tottf(input);
          return out instanceof Uint8Array ? out : new Uint8Array(out);
        }
      };
      return fontEditorWoff2Module;
    } catch (e) {
      // Fall back to browser bundle loading below.
    }
  }

  if (typeof window === 'undefined') {
    throw new Error('WOFF2 codec loader requires window or require()');
  }

  if (!window.KeyfontFontEditorWoff2) {
    throw new Error('Inline fonteditor WOFF2 codec is unavailable');
  }

  if (!fontEditorWoff2InitPromise) {
    fontEditorWoff2InitPromise = window.KeyfontFontEditorWoff2.init();
  }
  await fontEditorWoff2InitPromise;
  fontEditorWoff2Module = window.KeyfontFontEditorWoff2;
  return fontEditorWoff2Module;
}

// Dynamically load fflate only if needed
let fflateModule = null;
async function loadFflate() {
  if (fflateModule) return fflateModule;
  if (typeof fflate !== 'undefined') {
    fflateModule = fflate;
    return fflateModule;
  }
  // Try dynamic import
  try {
    const script = document.createElement('script');
    script.src = getDistPath('fflate.js');
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    fflateModule = fflate;
    return fflateModule;
  } catch (e) {
    throw new Error('Failed to load fflate.js for WOFF support');
  }
}

// Decompress deflate/zlib data using native browser API or fflate fallback
async function woff_decompressZlib(compressedBytes) {
  // Priority 1: Native DecompressionStream (modern browsers)
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(compressedBytes);
      writer.close();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of chunks) {
        result.set(c, pos);
        pos += c.length;
      }
      return result;
    } catch (e) {
      // DecompressionStream failed, try fflate
    }
  }

  // Priority 2: fflate fallback (for old browsers or if native API fails)
  const ff = await loadFflate();
  try {
    return ff.unzlibSync(compressedBytes);
  } catch (_) {
    return ff.inflateSync(compressedBytes);
  }
}

// Compress data using native browser API or fflate fallback
async function woff_compressZlib(rawBytes) {
  // Priority 1: Native CompressionStream (modern browsers)
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('deflate');
      const writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();
      writer.write(rawBytes);
      writer.close();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of chunks) {
        result.set(c, pos);
        pos += c.length;
      }
      return result;
    } catch (e) {
      // CompressionStream failed, try fflate
    }
  }

  // Priority 2: fflate fallback
  const ff = await loadFflate();
  return ff.zlibSync(rawBytes);
}

async function decodeWOFFToSfnt(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 44) throw new Error('Invalid WOFF: file too small');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = dv.getUint32(0, false);
  if (signature !== 0x774F4646) throw new Error('Invalid WOFF signature');

  const flavor = dv.getUint32(4, false);
  const numTables = dv.getUint16(12, false);
  if (numTables <= 0) throw new Error('Invalid WOFF: no tables');

  const entries = [];
  let dirOff = 44;
  for (let i = 0; i < numTables; i++) {
    const tag = String.fromCharCode(bytes[dirOff], bytes[dirOff + 1], bytes[dirOff + 2], bytes[dirOff + 3]);
    const offset = dv.getUint32(dirOff + 4, false);
    const compLength = dv.getUint32(dirOff + 8, false);
    const origLength = dv.getUint32(dirOff + 12, false);
    const origChecksum = dv.getUint32(dirOff + 16, false);
    if (offset + compLength > bytes.length) throw new Error(`Invalid WOFF table bounds for ${tag}`);
    let tableData = bytes.slice(offset, offset + compLength);
    if (compLength < origLength) {
      tableData = await woff_decompressZlib(tableData);
    }
    if (tableData.length !== origLength) throw new Error(`WOFF inflate mismatch for ${tag}`);
    entries.push({ tag, data: tableData, checksum: origChecksum });
    dirOff += 20;
  }

  const maxPow2 = Math.floor(Math.log2(numTables));
  const searchRange = (1 << maxPow2) * 16;
  const entrySelector = maxPow2;
  const rangeShift = numTables * 16 - searchRange;

  let dataOff = 12 + numTables * 16;
  const positions = [];
  for (const e of entries) {
    positions.push(dataOff);
    dataOff += (e.data.length + 3) & ~3;
  }

  const out = new Uint8Array(dataOff);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, flavor, false);
  odv.setUint16(4, numTables, false);
  odv.setUint16(6, searchRange, false);
  odv.setUint16(8, entrySelector, false);
  odv.setUint16(10, rangeShift, false);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const entryOff = 12 + i * 16;
    for (let j = 0; j < 4; j++) out[entryOff + j] = e.tag.charCodeAt(j) || 0x20;
    odv.setUint32(entryOff + 4, e.checksum >>> 0, false);
    odv.setUint32(entryOff + 8, positions[i], false);
    odv.setUint32(entryOff + 12, e.data.length, false);
    out.set(e.data, positions[i]);
  }
  return out;
}

async function encodeSfntToWOFF(sfntBytes) {
  const bytes = sfntBytes instanceof Uint8Array ? sfntBytes : new Uint8Array(sfntBytes);
  if (bytes.length < 12) throw new Error('Invalid SFNT data');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flavor = dv.getUint32(0, false);
  const numTables = dv.getUint16(4, false);
  if (numTables <= 0) throw new Error('Invalid SFNT: no tables');

  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    const checksum = dv.getUint32(off + 4, false);
    const offset = dv.getUint32(off + 8, false);
    const length = dv.getUint32(off + 12, false);
    if (offset + length > bytes.length) throw new Error(`Invalid SFNT table bounds for ${tag}`);
    const raw = bytes.slice(offset, offset + length);
    let comp = await woff_compressZlib(raw);
    if (!comp || comp.length >= raw.length) comp = raw;
    entries.push({ tag, checksum, rawLength: raw.length, compData: comp, compLength: comp.length });
  }

  entries.sort((a, b) => a.tag.localeCompare(b.tag));

  const headerSize = 44;
  const dirSize = numTables * 20;
  let dataOff = headerSize + dirSize;
  const offsets = [];
  for (const e of entries) {
    offsets.push(dataOff);
    dataOff += (e.compLength + 3) & ~3;
  }

  const out = new Uint8Array(dataOff);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, 0x774F4646, false); // 'wOFF'
  odv.setUint32(4, flavor, false);
  odv.setUint32(8, out.length, false);
  odv.setUint16(12, numTables, false);
  odv.setUint16(14, 0, false);
  odv.setUint32(16, bytes.length, false); // totalSfntSize
  odv.setUint16(20, 1, false); // majorVersion
  odv.setUint16(22, 0, false); // minorVersion
  // metadata/private fields remain zero

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const off = 44 + i * 20;
    for (let j = 0; j < 4; j++) out[off + j] = e.tag.charCodeAt(j) || 0x20;
    odv.setUint32(off + 4, offsets[i], false);
    odv.setUint32(off + 8, e.compLength, false);
    odv.setUint32(off + 12, e.rawLength, false);
    odv.setUint32(off + 16, e.checksum >>> 0, false);
    out.set(e.compData, offsets[i]);
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════
// WOFF2 CODEC ADAPTER
// ═══════════════════════════════════════════════════════════════════

async function decodeWOFF2ToSfnt(buffer) {
  const codec = await loadFontEditorWoff2();
  return codec.decode(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
}

async function encodeSfntToWOFF2(sfntBytes) {
  const codec = await loadFontEditorWoff2();
  return codec.encode(sfntBytes instanceof Uint8Array ? sfntBytes : new Uint8Array(sfntBytes));
}

function detectContainerExtHint(ext, bytes) {
  const e = (ext || '').toLowerCase();
  if (e === 'svg') return 'svg';
  if (bytes && bytes.length >= 4) {
    const appleDoubleType1 = extractType1FromAppleDouble(bytes);
    if (appleDoubleType1) return 'pfa';
    const sig = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    const sampleLen = Math.min(8192, bytes.length);
    const head = new TextDecoder('latin1', { fatal: false }).decode(bytes.subarray(0, sampleLen));
    if (sig === 0x774F4646) return 'woff';   // wOFF
    if (sig === 0x774F4632) return 'woff2';  // wOF2
    if (sig === 0x00010000) return 'ttf';    // TrueType
    if (sig === 0x4F54544F) return 'otf';    // OTTO (OTF with CFF)
    // PFB: 0x80 marker + segment type 1-3
    if (bytes[0] === 0x80 && bytes[1] >= 1 && bytes[1] <= 3) return 'pfb';
    // CFF: major=1, minor=0, headerSize>=1, offsetSize 1-4
    if (bytes[0] === 1 && bytes[1] === 0 && bytes[2] >= 1 && bytes[3] >= 1 && bytes[3] <= 4) return 'cff';
    // PFA or PS-wrapped CFF: starts with %! (PostScript header)
    if (bytes[0] === 0x25 && bytes[1] === 0x21) {
      // Check for PS-wrapped CFF (Resource-FontSet with StartData)
      if (head.includes('StartData') || head.includes('Resource-FontSet')) return 'cff';
      return 'pfa';
    }
    const embeddedType1Start = findEmbeddedType1Start(bytes);
    if (embeddedType1Start > 0) {
      const embeddedHead = head.slice(embeddedType1Start);
      if (embeddedHead.includes('StartData') || embeddedHead.includes('Resource-FontSet')) return 'cff';
      return 'pfa';
    }
    if (/<svg[\s>]|<font[\s>]|<font-face[\s>]|<glyph[\s>]/i.test(head)) return 'svg';
  }
  return e;
}

// ═══════════════════════════════════════════════════════════════════
// STATE

// Shared backend export helpers used by MiniConverter and the main UI bundle.
function getGlyphNameFromUnicode(unicode) {
  if (unicode == null) return null;
  const ch = String.fromCodePoint(unicode);
  if (window.guessGlyphNameFromChar) return window.guessGlyphNameFromChar(ch);
  return null;
}

// Public container/codec API used by the UI, worker, and conversion facade.
if (typeof window !== 'undefined') {
  window.decodeWOFFToSfnt = decodeWOFFToSfnt;
  window.decodeWOFF2ToSfnt = decodeWOFF2ToSfnt;
  window.encodeSfntToWOFF = encodeSfntToWOFF;
  window.encodeSfntToWOFF2 = encodeSfntToWOFF2;
  window.loadFontEditorWoff2 = loadFontEditorWoff2;
  window.loadFflate = loadFflate;
  window.detectContainerExtHint = detectContainerExtHint;
  window.showError = showError;
}

// ═══════════════════════════════════════════════════════════════════
// METADATA EXTRACTION

window.supportsWoff2Export = window.supportsWoff2Export || function supportsWoff2Export() {
  return true;
};
