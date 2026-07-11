"use strict";

(function() {
  function bytesToString(bytes) {
    if (typeof bytes === 'string') return bytes;
    if (bytes instanceof Uint8Array) {
      try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch (_) {
        return new TextDecoder().decode(bytes);
      }
    }
    return '';
  }

  function escapeXml(value) {
    const input = String(value == null ? '' : value);
    let out = '';
    for (const ch of input) {
      const cp = ch.codePointAt(0);
      if (ch === '&') out += '&amp;';
      else if (ch === '<') out += '&lt;';
      else if (ch === '>') out += '&gt;';
      else if (ch === '"') out += '&quot;';
      else if (ch === "'") out += '&apos;';
      else if (!isValidXmlChar(cp)) {
        continue;
      } else {
        out += ch;
      }
    }
    return out;
  }

  function isValidXmlChar(cp) {
    return cp === 0x09 || cp === 0x0A || cp === 0x0D ||
      (cp >= 0x20 && cp <= 0xD7FF) ||
      (cp >= 0xE000 && cp <= 0xFFFD) ||
      (cp >= 0x10000 && cp <= 0x10FFFF);
  }

  function sanitizeSvgFontXml(xml) {
    if (typeof xml !== 'string' || !xml) return '';
    let out = '';
    for (const ch of xml) {
      const cp = ch.codePointAt(0);
      if (isValidXmlChar(cp)) {
        out += ch;
      }
    }
    return out;
  }

  function formatNum(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    const rounded = Math.round(n * 1000) / 1000;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  }

  function cloneSegment(seg) {
    const out = { cmd: seg.cmd };
    for (const key of Object.keys(seg)) {
      if (key !== 'cmd') out[key] = seg[key];
    }
    return out;
  }

  function tokenizePathData(d) {
    const re = /([AaCcHhLlMmQqSsTtVvZz])|([-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g;
    const tokens = [];
    let m;
    while ((m = re.exec(d || ''))) {
      tokens.push(m[1] || m[2]);
    }
    return tokens;
  }

  function quadToCubic(x0, y0, x1, y1, x2, y2) {
    return {
      x1: x0 + (2 / 3) * (x1 - x0),
      y1: y0 + (2 / 3) * (y1 - y0),
      x2: x2 + (2 / 3) * (x1 - x2),
      y2: y2 + (2 / 3) * (y1 - y2),
      x3: x2,
      y3: y2
    };
  }

  function svgPathToCubicPath(d) {
    const tokens = tokenizePathData(d);
    const out = [];
    let i = 0;
    let cmd = '';
    let cx = 0, cy = 0;
    let sx = 0, sy = 0;
    let lastQx = null, lastQy = null;
    let lastCx2 = null, lastCy2 = null;

    const hasNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);
    const nextNum = () => Number(tokens[i++]);

    while (i < tokens.length) {
      if (/^[A-Za-z]$/.test(tokens[i])) {
        cmd = tokens[i++];
      } else if (!cmd) {
        throw new Error('Invalid SVG path data');
      }
      const rel = cmd === cmd.toLowerCase();

      if (cmd === 'M' || cmd === 'm') {
        let first = true;
        while (hasNum()) {
          let x = nextNum();
          let y = nextNum();
          if (rel) { x += cx; y += cy; }
          out.push({ cmd: first ? 'M' : 'L', x, y });
          cx = x; cy = y;
          if (first) { sx = x; sy = y; first = false; }
        }
      } else if (cmd === 'L' || cmd === 'l') {
        while (hasNum()) {
          let x = nextNum();
          let y = nextNum();
          if (rel) { x += cx; y += cy; }
          out.push({ cmd: 'L', x, y });
          cx = x; cy = y;
        }
      } else if (cmd === 'H' || cmd === 'h') {
        while (hasNum()) {
          let x = nextNum();
          if (rel) x += cx;
          out.push({ cmd: 'L', x, y: cy });
          cx = x;
        }
      } else if (cmd === 'V' || cmd === 'v') {
        while (hasNum()) {
          let y = nextNum();
          if (rel) y += cy;
          out.push({ cmd: 'L', x: cx, y });
          cy = y;
        }
      } else if (cmd === 'C' || cmd === 'c') {
        while (hasNum()) {
          let x1 = nextNum(), y1 = nextNum();
          let x2 = nextNum(), y2 = nextNum();
          let x3 = nextNum(), y3 = nextNum();
          if (rel) {
            x1 += cx; y1 += cy;
            x2 += cx; y2 += cy;
            x3 += cx; y3 += cy;
          }
          out.push({ cmd: 'C', x1, y1, x2, y2, x3, y3 });
          cx = x3; cy = y3;
          lastCx2 = x2; lastCy2 = y2;
          lastQx = lastQy = null;
        }
      } else if (cmd === 'S' || cmd === 's') {
        while (hasNum()) {
          let x2 = nextNum(), y2 = nextNum();
          let x3 = nextNum(), y3 = nextNum();
          const x1 = lastCx2 != null ? cx + (cx - lastCx2) : cx;
          const y1 = lastCy2 != null ? cy + (cy - lastCy2) : cy;
          if (rel) {
            x2 += cx; y2 += cy;
            x3 += cx; y3 += cy;
          }
          out.push({ cmd: 'C', x1, y1, x2, y2, x3, y3 });
          cx = x3; cy = y3;
          lastCx2 = x2; lastCy2 = y2;
          lastQx = lastQy = null;
        }
      } else if (cmd === 'Q' || cmd === 'q') {
        while (hasNum()) {
          let qx = nextNum(), qy = nextNum();
          let x = nextNum(), y = nextNum();
          if (rel) {
            qx += cx; qy += cy;
            x += cx; y += cy;
          }
          const cubic = quadToCubic(cx, cy, qx, qy, x, y);
          out.push({ cmd: 'C', x1: cubic.x1, y1: cubic.y1, x2: cubic.x2, y2: cubic.y2, x3: cubic.x3, y3: cubic.y3 });
          cx = x; cy = y;
          lastQx = qx; lastQy = qy;
          lastCx2 = cubic.x2; lastCy2 = cubic.y2;
        }
      } else if (cmd === 'T' || cmd === 't') {
        while (hasNum()) {
          let x = nextNum(), y = nextNum();
          if (rel) { x += cx; y += cy; }
          const qx = lastQx != null ? cx + (cx - lastQx) : cx;
          const qy = lastQy != null ? cy + (cy - lastQy) : cy;
          const cubic = quadToCubic(cx, cy, qx, qy, x, y);
          out.push({ cmd: 'C', x1: cubic.x1, y1: cubic.y1, x2: cubic.x2, y2: cubic.y2, x3: cubic.x3, y3: cubic.y3 });
          cx = x; cy = y;
          lastQx = qx; lastQy = qy;
          lastCx2 = cubic.x2; lastCy2 = cubic.y2;
        }
      } else if (cmd === 'A' || cmd === 'a') {
        while (hasNum()) {
          i += 5;
          let x = nextNum(), y = nextNum();
          if (rel) { x += cx; y += cy; }
          out.push({ cmd: 'L', x, y });
          cx = x; cy = y;
          lastQx = lastQy = lastCx2 = lastCy2 = null;
        }
      } else if (cmd === 'Z' || cmd === 'z') {
        out.push({ cmd: 'Z' });
        cx = sx; cy = sy;
        lastQx = lastQy = lastCx2 = lastCy2 = null;
      } else {
        throw new Error(`Unsupported SVG path command: ${cmd}`);
      }

      if (cmd !== 'Q' && cmd !== 'q' && cmd !== 'T' && cmd !== 't') {
        lastQx = lastQy = null;
      }
      if (!(/[CSQTAcsqta]/.test(cmd))) {
        lastCx2 = lastCy2 = null;
      }
    }

    return out;
  }

  function cubicPathToSvgPath(path) {
    const parts = [];
    for (const seg of path || []) {
      if (!seg || !seg.cmd) continue;
      if (seg.cmd === 'M') parts.push(`M${formatNum(seg.x)} ${formatNum(seg.y)}`);
      else if (seg.cmd === 'L') parts.push(`L${formatNum(seg.x)} ${formatNum(seg.y)}`);
      else if (seg.cmd === 'C') {
        parts.push(`C${formatNum(seg.x1)} ${formatNum(seg.y1)} ${formatNum(seg.x2)} ${formatNum(seg.y2)} ${formatNum(seg.x3)} ${formatNum(seg.y3)}`);
      } else if (seg.cmd === 'Z') {
        parts.push('Z');
      }
    }
    return parts.join(' ');
  }

  function computePathBounds(path) {
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    const note = (x, y) => {
      const nx = Number(x), ny = Number(y);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
      if (nx < xMin) xMin = nx;
      if (ny < yMin) yMin = ny;
      if (nx > xMax) xMax = nx;
      if (ny > yMax) yMax = ny;
    };
    for (const seg of path || []) {
      if (seg.cmd === 'M' || seg.cmd === 'L') note(seg.x, seg.y);
      else if (seg.cmd === 'C') {
        note(seg.x1, seg.y1);
        note(seg.x2, seg.y2);
        note(seg.x3, seg.y3);
      }
    }
    if (!Number.isFinite(xMin)) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    return { xMin, yMin, xMax, yMax };
  }

  function parseUnicodeValue(value) {
    if (typeof value !== 'string' || !value.length) return '';
    return Array.from(value)[0] || '';
  }

  function readSvgMetadata(doc, family, psName) {
    const base = {
      family,
      postScript: psName,
      version: '',
      copyright: '',
      license: '',
      licenseUrl: '',
      trademark: '',
      designer: '',
      manufacturer: ''
    };
    const metaEl = doc.querySelector('metadata');
    if (!metaEl) return base;
    const fields = ['family', 'postScript', 'version', 'copyright', 'license', 'licenseUrl', 'trademark', 'designer', 'manufacturer'];
    for (const field of fields) {
      const attr = metaEl.getAttribute(`data-keyfont-${field.toLowerCase()}`);
      if (typeof attr === 'string' && attr) {
        base[field] = attr;
      }
      const child = metaEl.querySelector(`keyfont-${field.toLowerCase()}`);
      if (child && child.textContent) {
        base[field] = child.textContent;
      }
    }
    return base;
  }

  function buildSvgMetadataXml(metadata) {
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    const fields = ['family', 'postScript', 'version', 'copyright', 'license', 'licenseUrl', 'trademark', 'designer', 'manufacturer'];
    const attrs = [];
    const children = [];
    for (const field of fields) {
      const value = typeof meta[field] === 'string' ? meta[field].trim() : '';
      if (!value) continue;
      attrs.push(`data-keyfont-${field.toLowerCase()}="${escapeXml(value)}"`);
      children.push(`<keyfont-${field.toLowerCase()}>${escapeXml(value)}</keyfont-${field.toLowerCase()}>`);
    }
    if (!attrs.length && !children.length) return '';
    return `  <metadata ${attrs.join(' ')}>${children.length ? `\n    ${children.join('\n    ')}\n  ` : ''}</metadata>\n`;
  }

  function parseSvgFont(input) {
    const xml = sanitizeSvgFontXml(bytesToString(input));
    if (!xml || !/<svg[\s>]|<font[\s>]/i.test(xml)) {
      throw new Error('Invalid SVG font');
    }
    if (typeof DOMParser === 'undefined') {
      throw new Error('SVG font parsing requires DOMParser');
    }

    const doc = new DOMParser().parseFromString(xml, 'image/svg+xml');
    const parserError = doc.querySelector('parsererror');
    if (parserError) {
      throw new Error('Invalid SVG font XML');
    }

    const fontEl = doc.querySelector('font');
    if (!fontEl) {
      throw new Error('SVG font missing <font>');
    }

    const fontFace = fontEl.querySelector('font-face');
    const defaultAdv = Number(fontEl.getAttribute('horiz-adv-x')) || 1000;
    const unitsPerEm = Math.max(1, Number(fontFace && fontFace.getAttribute('units-per-em')) || 1000);
    const ascent = Number(fontFace && fontFace.getAttribute('ascent'));
    const descent = Number(fontFace && fontFace.getAttribute('descent'));
    const family = (fontFace && fontFace.getAttribute('font-family')) || fontEl.getAttribute('id') || 'SVG Font';
    const psName = (fontFace && (fontFace.getAttribute('font-family') || fontFace.getAttribute('font-family'))) || family;
    const bboxAttr = fontFace && fontFace.getAttribute('bbox');
    const bbox = bboxAttr
      ? bboxAttr.trim().split(/[\s,]+/).slice(0, 4).map(v => Number(v))
      : null;

    const glyphs = [];
    const missingGlyph = fontEl.querySelector('missing-glyph');
    if (missingGlyph) {
      glyphs.push({
        id: 0,
        name: '.notdef',
        unicode: null,
        chars: '',
        glyphType: 'svg',
        path: svgPathToCubicPath(missingGlyph.getAttribute('d') || ''),
        advanceWidth: Number(missingGlyph.getAttribute('horiz-adv-x')) || defaultAdv
      });
    } else {
      glyphs.push({
        id: 0,
        name: '.notdef',
        unicode: null,
        chars: '',
        glyphType: 'svg',
        path: [],
        advanceWidth: defaultAdv
      });
    }

    const glyphEls = Array.from(fontEl.querySelectorAll('glyph'));
    for (const glyphEl of glyphEls) {
      const unicodeValue = parseUnicodeValue(glyphEl.getAttribute('unicode') || '');
      const glyphName = glyphEl.getAttribute('glyph-name') || (unicodeValue ? `uni${unicodeValue.codePointAt(0).toString(16).toUpperCase()}` : '');
      const d = glyphEl.getAttribute('d') || '';
      const path = svgPathToCubicPath(d);
      const advanceWidth = Number(glyphEl.getAttribute('horiz-adv-x')) || defaultAdv;
      glyphs.push({
        id: glyphs.length,
        name: glyphName || `glyph${glyphs.length}`,
        unicode: unicodeValue ? unicodeValue.codePointAt(0) : null,
        chars: unicodeValue,
        glyphType: 'svg',
        path,
        advanceWidth
      });
    }

    const metadata = readSvgMetadata(doc, family, psName);

    return {
      family,
      postScriptName: psName,
      unitsPerEm,
      ascent: Number.isFinite(ascent) ? ascent : unitsPerEm * 0.8,
      descent: Number.isFinite(descent) ? descent : -unitsPerEm * 0.2,
      bbox: Array.isArray(bbox) && bbox.length === 4 ? bbox : null,
      defaultAdvanceWidth: defaultAdv,
      glyphs,
      metadata
    };
  }

  function buildSvgFontFromGlyphRecords(records, options = {}) {
    const unitsPerEm = Math.max(1, Number(options.unitsPerEm) || 1000);
    const family = String(options.family || 'SubsetFont');
    const psName = String(options.postScriptName || family || 'SubsetFont');
    const defaultAdvance = Math.max(0, Number(options.defaultAdvanceWidth) || 1000);
    const glyphs = Array.isArray(records) ? records : [];
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;

    const glyphXml = [];
    let missingGlyphXml = '<missing-glyph horiz-adv-x="' + formatNum(defaultAdvance) + '" />';
    for (let i = 0; i < glyphs.length; i++) {
      const glyph = glyphs[i] || {};
      const path = Array.isArray(glyph.path) ? glyph.path : [];
      const d = cubicPathToSvgPath(path);
      const bounds = computePathBounds(path);
      xMin = Math.min(xMin, bounds.xMin);
      yMin = Math.min(yMin, bounds.yMin);
      xMax = Math.max(xMax, bounds.xMax);
      yMax = Math.max(yMax, bounds.yMax);
      const adv = Math.max(0, Number(glyph.advanceWidth) || defaultAdvance);
      if (i === 0 || glyph.name === '.notdef') {
        missingGlyphXml = `<missing-glyph horiz-adv-x="${formatNum(adv)}"${d ? ` d="${escapeXml(d)}"` : ''} />`;
        continue;
      }
      const unicodeChar = glyph.unicode != null && isValidXmlChar(glyph.unicode) ? String.fromCodePoint(glyph.unicode) : '';
      glyphXml.push(
        `<glyph glyph-name="${escapeXml(glyph.name || `glyph${i}`)}"` +
        `${unicodeChar ? ` unicode="${escapeXml(unicodeChar)}"` : ''}` +
        ` horiz-adv-x="${formatNum(adv)}"` +
        `${d ? ` d="${escapeXml(d)}"` : ''} />`
      );
    }

    if (!Number.isFinite(xMin)) {
      xMin = 0; yMin = 0; xMax = unitsPerEm; yMax = unitsPerEm;
    }
    const ascent = Number.isFinite(options.ascent) ? Number(options.ascent) : Math.max(yMax, unitsPerEm * 0.8);
    const descent = Number.isFinite(options.descent) ? Number(options.descent) : Math.min(yMin, -unitsPerEm * 0.2);
    const metadataXml = buildSvgMetadataXml(Object.assign({}, options.metadata || {}, {
      family: (options.metadata && options.metadata.family) || family,
      postScript: (options.metadata && options.metadata.postScript) || psName
    }));

    const xml =
      `<?xml version="1.0" standalone="no"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg">\n` +
      metadataXml +
      `  <defs>\n` +
      `    <font id="${escapeXml(psName)}" horiz-adv-x="${formatNum(defaultAdvance)}">\n` +
      `      <font-face font-family="${escapeXml(family)}" units-per-em="${formatNum(unitsPerEm)}" ascent="${formatNum(ascent)}" descent="${formatNum(descent)}" bbox="${formatNum(xMin)} ${formatNum(yMin)} ${formatNum(xMax)} ${formatNum(yMax)}" />\n` +
      `      ${missingGlyphXml}\n` +
      `      ${glyphXml.join('\n      ')}\n` +
      `    </font>\n` +
      `  </defs>\n` +
      `</svg>\n`;

    return new TextEncoder().encode(xml);
  }

  if (typeof window !== 'undefined') {
    window.SVGFontUtils = {
      parseSvgFont,
      buildSvgFontFromGlyphRecords,
      svgPathToCubicPath,
      cubicPathToSvgPath,
      computePathBounds,
      cloneSegment
    };
  }
})();
