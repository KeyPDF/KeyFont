// Glyph name mapping tables and utilities
// This module provides glyph name → Unicode conversions with full Adobe Glyph List support

(function() {
  // Access AGL data from window (loaded by agl-data.js)
  const AGL_MAPPINGS = (typeof window !== 'undefined' && window.AGL_MAPPINGS) || {};
  const AGLFN_MAPPINGS = (typeof window !== 'undefined' && window.AGLFN_MAPPINGS) || {};
  const UNICODE_TO_GLYPH_NAME = (typeof window !== 'undefined' && window.UNICODE_TO_GLYPH_NAME) || {};

  const DIGIT_GLYPH_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const ASCII_GLYPH_NAME_MAP = {
    ' ': 'space',
    '!': 'exclam',
    '"': 'quotedbl',
    '#': 'numbersign',
    '$': 'dollar',
    '%': 'percent',
    '&': 'ampersand',
    '\'': 'quotesingle',
    '(': 'parenleft',
    ')': 'parenright',
    '*': 'asterisk',
    '+': 'plus',
    ',': 'comma',
    '-': 'hyphen',
    '.': 'period',
    '/': 'slash',
    ':': 'colon',
    ';': 'semicolon',
    '<': 'less',
    '=': 'equal',
    '>': 'greater',
    '?': 'question',
    '@': 'at',
    '[': 'bracketleft',
    '\\': 'backslash',
    ']': 'bracketright',
    '^': 'asciicircum',
    '_': 'underscore',
    '`': 'grave',
    '{': 'braceleft',
    '|': 'bar',
    '}': 'braceright',
    '~': 'asciitilde'
};

const EXTENDED_GLYPH_NAME_MAP = {
    '\u00a0': 'space',
    '\u00a1': 'exclamdown',
    '\u00a2': 'cent',
    '\u00a3': 'sterling',
    '\u00a5': 'yen',
    '\u00a7': 'section',
    '\u00a9': 'copyright',
    '\u00aa': 'ordfeminine',
    '\u00ab': 'guillemotleft',
    '\u00ae': 'registered',
    '\u00af': 'macron',
    '\u00b0': 'degree',
    '\u00b1': 'plusminus',
    '\u00b2': 'two.superior',
    '\u00b3': 'three.superior',
    '\u00b4': 'acute',
    '\u00b5': 'mu',
    '\u00b6': 'paragraph',
    '\u00b7': 'periodcentered',
    '\u00b8': 'cedilla',
    '\u00b9': 'one.superior',
    '\u00ba': 'ordmasculine',
    '\u00bb': 'guillemotright',
    '\u00bc': 'onequarter',
    '\u00bd': 'onehalf',
    '\u00be': 'threequarters',
    '\u00bf': 'questiondown',
    '\u00c0': 'Agrave',
    '\u00c1': 'Aacute',
    '\u00c2': 'Acircumflex',
    '\u00c3': 'Atilde',
    '\u00c4': 'Adieresis',
    '\u00c5': 'Aring',
    '\u00c6': 'AE',
    '\u00c7': 'Ccedilla',
    '\u00c8': 'Egrave',
    '\u00c9': 'Eacute',
    '\u00ca': 'Ecircumflex',
    '\u00cb': 'Edieresis',
    '\u00cc': 'Igrave',
    '\u00cd': 'Iacute',
    '\u00ce': 'Icircumflex',
    '\u00cf': 'Idieresis',
    '\u00d0': 'Eth',
    '\u00d1': 'Ntilde',
    '\u00d2': 'Ograve',
    '\u00d3': 'Oacute',
    '\u00d4': 'Ocircumflex',
    '\u00d5': 'Otilde',
    '\u00d6': 'Odieresis',
    '\u00d7': 'multiply',
    '\u00d8': 'Oslash',
    '\u00d9': 'Ugrave',
    '\u00da': 'Uacute',
    '\u00db': 'Ucircumflex',
    '\u00dc': 'Udieresis',
    '\u00dd': 'Yacute',
    '\u00de': 'Thorn',
    '\u00df': 'germandbls',
    '\u00e0': 'agrave',
    '\u00e1': 'aacute',
    '\u00e2': 'acircumflex',
    '\u00e3': 'atilde',
    '\u00e4': 'adieresis',
    '\u00e5': 'aring',
    '\u00e6': 'ae',
    '\u00e7': 'ccedilla',
    '\u00e8': 'egrave',
    '\u00e9': 'eacute',
    '\u00ea': 'ecircumflex',
    '\u00eb': 'edieresis',
    '\u00ec': 'igrave',
    '\u00ed': 'iacute',
    '\u00ee': 'icircumflex',
    '\u00ef': 'idieresis',
    '\u00f0': 'eth',
    '\u00f1': 'ntilde',
    '\u00f2': 'ograve',
    '\u00f3': 'oacute',
    '\u00f4': 'ocircumflex',
    '\u00f5': 'otilde',
    '\u00f6': 'odieresis',
    '\u00f7': 'divide',
    '\u00f8': 'oslash',
    '\u00f9': 'ugrave',
    '\u00fa': 'uacute',
    '\u00fb': 'ucircumflex',
    '\u00fc': 'udieresis',
    '\u00fd': 'yacute',
    '\u00fe': 'thorn',
    '\u00ff': 'ydieresis'
};

const LIGATURE_GLYPH_NAME_MAP = {
    '\uFB00': 'ff',
    '\uFB01': 'fi',
    '\uFB02': 'fl',
    '\uFB03': 'ffi',
    '\uFB04': 'ffl'
};

function guessGlyphNameFromChar(ch) {
    if (!ch)
        return '';
    // Prefer Adobe Glyph List data when available to avoid local duplicates.
    if (UNICODE_TO_GLYPH_NAME[ch])
        return UNICODE_TO_GLYPH_NAME[ch];
    if (LIGATURE_GLYPH_NAME_MAP[ch])
        return LIGATURE_GLYPH_NAME_MAP[ch];
    if (ASCII_GLYPH_NAME_MAP[ch])
        return ASCII_GLYPH_NAME_MAP[ch];
    const code = ch.codePointAt(0);
    if (code == null)
        return '';
    if (code >= 48 && code <= 57)
        return DIGIT_GLYPH_NAMES[code - 48];
    if (code >= 65 && code <= 90)
        return ch;
    if (code >= 97 && code <= 122)
        return ch;
    if (EXTENDED_GLYPH_NAME_MAP[ch])
        return EXTENDED_GLYPH_NAME_MAP[ch];
    return '';
}

const GLYPH_NAME_TO_CHAR = (() => {
    const map = Object.create(null);
    // Prefer AGL/AGLFN to avoid duplicating tables here.
    if (Object.keys(AGL_MAPPINGS).length) {
        for (const [name, ch] of Object.entries(AGL_MAPPINGS)) {
            map[name] = ch;
        }
    }
    if (Object.keys(AGLFN_MAPPINGS).length) {
        for (const [name, ch] of Object.entries(AGLFN_MAPPINGS)) {
            if (!map[name])
                map[name] = ch;
        }
    }
    // Fallback to built-in mappings when AGL is absent.
    if (Object.keys(map).length === 0) {
        for (const [ch, name] of Object.entries(ASCII_GLYPH_NAME_MAP)) {
            map[name] = ch;
        }
        for (const [ch, name] of Object.entries(EXTENDED_GLYPH_NAME_MAP)) {
            if (!map[name])
                map[name] = ch;
        }
        for (let i = 0; i < DIGIT_GLYPH_NAMES.length; i++) {
            map[DIGIT_GLYPH_NAMES[i]] = String.fromCharCode(48 + i);
        }
    }
    // Common aliases
    map['space'] = ' ';
    map['hyphen'] = '-';
    map['minus'] = '-';
    map['periodcentered'] = '·';
    map['bullet'] = '•';
    // Standard ligatures
    map['fi'] = '\uFB01';
    map['fl'] = '\uFB02';
    map['ff'] = '\uFB00';
    map['ffi'] = '\uFB03';
    map['ffl'] = '\uFB04';
    return map;
})();

const LIGATURE_TO_TEXT = {
    '\uFB00': 'ff',
    '\uFB01': 'fi',
    '\uFB02': 'fl',
    '\uFB03': 'ffi',
    '\uFB04': 'ffl'
};

function glyphNameToUnicode(name, cffCharset = null) {
    if (!name)
        return null;
    if (typeof name !== 'string')
        return null;
    if (GLYPH_NAME_TO_CHAR[name])
        return GLYPH_NAME_TO_CHAR[name];
    // Single-letter glyph names are common in legacy font encodings.
    if (name.length === 1)
        return name;
    // uniXXXX or uXXXX style names
    let m = name.match(/^uni([0-9A-Fa-f]{4,6})$/);
    if (m) {
        const cp = parseInt(m[1], 16);
        if (Number.isFinite(cp) && cp > 0)
            return String.fromCodePoint(cp);
    }
    m = name.match(/^u([0-9A-Fa-f]{4,6})$/);
    if (m) {
        const cp = parseInt(m[1], 16);
        if (Number.isFinite(cp) && cp > 0)
            return String.fromCodePoint(cp);
    }
    // Handle generic glyph IDs (G1, G2, etc.) by looking up in CFF charset
    m = name.match(/^G(\d+)$/);
    if (m && cffCharset && Array.isArray(cffCharset)) {
        const gid = parseInt(m[1], 10);
        if (Number.isFinite(gid) && gid >= 0 && gid < cffCharset.length) {
            const actualName = cffCharset[gid];
            if (actualName && actualName !== name) {
                // Recursively look up the actual glyph name
                return glyphNameToUnicode(actualName, null);
            }
        }
    }
    // Fallback: some fonts use glyph names that are actually the character.
    return null;
}

// Enhanced function with full Adobe Glyph List support
function glyphNameToUnicode_AGL(name, cffCharset = null) {
    if (!name)
        return null;
    if (typeof name !== 'string')
        return null;

    // 1. Try Adobe Glyph List first (4,281 mappings)
    if (AGL_MAPPINGS[name])
        return AGL_MAPPINGS[name];

    // 2. Try AGLFN (Adobe Glyph List For New Fonts)
    if (AGLFN_MAPPINGS[name])
        return AGLFN_MAPPINGS[name];

    // 3. Fallback to existing custom mappings
    return glyphNameToUnicode(name, cffCharset);
}

// Reverse lookup: Unicode → Glyph Name
function unicodeToGlyphName_AGL(unicode) {
    return UNICODE_TO_GLYPH_NAME[unicode] || null;
}

function buildStandardEncodingNames() {
    const names = new Array(256).fill('.notdef');
    for (let code = 0; code < 256; code++) {
        const glyph = guessGlyphNameFromChar(String.fromCharCode(code));
        if (glyph)
            names[code] = glyph;
    }
    return names;
}

const STANDARD_ENCODING_NAMES = buildStandardEncodingNames();

// MacRomanEncoding character map for positions that differ from Unicode
// Particularly important for ligatures like fi (222) and fl (223)
const MAC_ROMAN_ENCODING = (() => {
    const map = {};
    // Ligatures
    map[222] = '\uFB01'; // fi ligature
    map[223] = '\uFB02'; // fl ligature
    // Other special characters in MacRoman that differ from Unicode code points
    map[128] = '\u00C4'; // Ä
    map[129] = '\u00C5'; // Å
    map[130] = '\u00C7'; // Ç
    map[131] = '\u00C9'; // É
    map[132] = '\u00D1'; // Ñ
    map[133] = '\u00D6'; // Ö
    map[134] = '\u00DC'; // Ü
    map[135] = '\u00E1'; // á
    map[136] = '\u00E0'; // à
    map[137] = '\u00E2'; // â
    map[138] = '\u00E4'; // ä
    map[139] = '\u00E3'; // ã
    map[140] = '\u00E5'; // å
    map[141] = '\u00E7'; // ç
    map[142] = '\u00E9'; // é
    map[143] = '\u00E8'; // è
    map[144] = '\u00EA'; // ê
    map[145] = '\u00EB'; // ë
    map[146] = '\u00ED'; // í
    map[147] = '\u00EC'; // ì
    map[148] = '\u00EE'; // î
    map[149] = '\u00EF'; // ï
    map[150] = '\u00F1'; // ñ
    map[151] = '\u00F3'; // ó
    map[152] = '\u00F2'; // ò
    map[153] = '\u00F4'; // ô
    map[154] = '\u00F6'; // ö
    map[155] = '\u00F5'; // õ
    map[156] = '\u00FA'; // ú
    map[157] = '\u00F9'; // ù
    map[158] = '\u00FB'; // û
    map[159] = '\u00FC'; // ü
    map[160] = '\u2020'; // †
    map[161] = '\u00B0'; // °
    map[162] = '\u00A2'; // ¢
    map[163] = '\u00A3'; // £
    map[164] = '\u00A7'; // §
    map[165] = '\u2022'; // •
    map[166] = '\u00B6'; // ¶
    map[167] = '\u00DF'; // ß
    map[168] = '\u00AE'; // ®
    map[169] = '\u00A9'; // ©
    map[170] = '\u2122'; // ™
    map[171] = '\u00B4'; // ´
    map[172] = '\u00A8'; // ¨
    map[173] = '\u2260'; // ≠
    map[174] = '\u00C6'; // Æ
    map[175] = '\u00D8'; // Ø
    map[176] = '\u221E'; // ∞
    map[177] = '\u00B1'; // ±
    map[178] = '\u2264'; // ≤
    map[179] = '\u2265'; // ≥
    map[180] = '\u00A5'; // ¥
    map[181] = '\u00B5'; // µ
    map[182] = '\u2202'; // ∂
    map[183] = '\u2211'; // ∑
    map[184] = '\u220F'; // ∏
    map[185] = '\u03C0'; // π
    map[186] = '\u222B'; // ∫
    map[187] = '\u00AA'; // ª
    map[188] = '\u00BA'; // º
    map[189] = '\u03A9'; // Ω
    map[190] = '\u00E6'; // æ
    map[191] = '\u00F8'; // ø
    map[192] = '\u00BF'; // ¿
    map[193] = '\u00A1'; // ¡
    map[194] = '\u00AC'; // ¬
    map[195] = '\u221A'; // √
    map[196] = '\u0192'; // ƒ
    map[197] = '\u2248'; // ≈
    map[198] = '\u2206'; // ∆
    map[199] = '\u00AB'; // «
    map[200] = '\u00BB'; // »
    map[201] = '\u2026'; // …
    map[202] = '\u00A0'; // non-breaking space
    map[203] = '\u00C0'; // À
    map[204] = '\u00C3'; // Ã
    map[205] = '\u00D5'; // Õ
    map[206] = '\u0152'; // Œ
    map[207] = '\u0153'; // œ
    map[208] = '\u2013'; // –
    map[209] = '\u2014'; // —
    map[210] = '\u201C'; // "
    map[211] = '\u201D'; // "
    map[212] = '\u2018'; // '
    map[213] = '\u2019'; // '
    map[214] = '\u00F7'; // ÷
    map[215] = '\u25CA'; // ◊
    map[216] = '\u00FF'; // ÿ
    map[217] = '\u0178'; // Ÿ
    map[218] = '\u2044'; // ⁄
    map[219] = '\u20AC'; // €
    map[220] = '\u2039'; // ‹
    map[221] = '\u203A'; // ›
    map[224] = '\u2021'; // ‡
    map[225] = '\u00B7'; // ·
    map[226] = '\u201A'; // ‚
    map[227] = '\u201E'; // „
    map[228] = '\u2030'; // ‰
    map[229] = '\u00C2'; // Â
    map[230] = '\u00CA'; // Ê
    map[231] = '\u00C1'; // Á
    map[232] = '\u00CB'; // Ë
    map[233] = '\u00C8'; // È
    map[234] = '\u00CD'; // Í
    map[235] = '\u00CE'; // Î
    map[236] = '\u00CF'; // Ï
    map[237] = '\u00CC'; // Ì
    map[238] = '\u00D3'; // Ó
    map[239] = '\u00D4'; // Ô
    map[240] = '\uF8FF'; // Apple logo (private use)
    map[241] = '\u00D2'; // Ò
    map[242] = '\u00DA'; // Ú
    map[243] = '\u00DB'; // Û
    map[244] = '\u00D9'; // Ù
    map[245] = '\u0131'; // ı
    map[246] = '\u02C6'; // ˆ
    map[247] = '\u02DC'; // ˜
    map[248] = '\u00AF'; // ¯
    map[249] = '\u02D8'; // ˘
    map[250] = '\u02D9'; // ˙
    map[251] = '\u02DA'; // ˚
    map[252] = '\u00B8'; // ¸
    map[253] = '\u02DD'; // ˝
    map[254] = '\u02DB'; // ˛
    map[255] = '\u02C7'; // ˇ
    return map;
})();

  // Expose to window
  if (typeof window !== 'undefined') {
    window.DIGIT_GLYPH_NAMES = DIGIT_GLYPH_NAMES;
    window.ASCII_GLYPH_NAME_MAP = ASCII_GLYPH_NAME_MAP;
    window.EXTENDED_GLYPH_NAME_MAP = EXTENDED_GLYPH_NAME_MAP;
    window.LIGATURE_GLYPH_NAME_MAP = LIGATURE_GLYPH_NAME_MAP;
    window.GLYPH_NAME_TO_CHAR = GLYPH_NAME_TO_CHAR;
    window.LIGATURE_TO_TEXT = LIGATURE_TO_TEXT;
    window.STANDARD_ENCODING_NAMES = STANDARD_ENCODING_NAMES;
    window.MAC_ROMAN_ENCODING = MAC_ROMAN_ENCODING;
    window.guessGlyphNameFromChar = guessGlyphNameFromChar;
    window.glyphNameToUnicode = glyphNameToUnicode;
    window.buildStandardEncodingNames = buildStandardEncodingNames;
    window.glyphNameToUnicode_AGL = glyphNameToUnicode_AGL;
    window.unicodeToGlyphName_AGL = unicodeToGlyphName_AGL;
  }
})();
