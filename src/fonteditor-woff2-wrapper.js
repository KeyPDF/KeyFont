// This file is custom project glue code only.
// The WOFF2 encode/decode implementation is provided by `fonteditor-core`
// and its bundled WASM codec. We keep the integration layer here small so
// ownership is clear: app wiring is ours, codec internals are third-party.

// Import only the WOFF2 entry points. Importing `fonteditor-core` at its
// package root pulls in its entire font editor (CFF, SVG, table writers, etc.).
import woff2Module from '../node_modules/fonteditor-core/woff2/index.js';
import ttfToWoff2 from 'fonteditor-core/lib/ttf/ttftowoff2';
import woff2ToTtf from 'fonteditor-core/lib/ttf/woff2tottf';
import wasmBytes from '../node_modules/fonteditor-core/woff2/woff2.wasm';

function toExactArrayBuffer(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function toExactUint8Array(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : new Uint8Array(bytes);
}

function toUint8Array(output) {
  return output instanceof Uint8Array ? output : new Uint8Array(output);
}

let wasmBlobUrl = null;
function getWasmUrl() {
  if (!wasmBlobUrl && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
    wasmBlobUrl = URL.createObjectURL(
      new Blob([toExactUint8Array(wasmBytes)], { type: 'application/wasm' })
    );
  }
  return wasmBlobUrl || '';
}

const api = {
  async init() {
    if (!woff2Module.isInited()) {
      await woff2Module.init(getWasmUrl());
    }
    return true;
  },

  async encode(input) {
    await this.init();
    return toUint8Array(ttfToWoff2(toExactArrayBuffer(input)));
  },

  async decode(input) {
    await this.init();
    return toUint8Array(woff2ToTtf(toExactArrayBuffer(input)));
  }
};

if (typeof window !== 'undefined') {
  window.KeyfontFontEditorWoff2 = api;
}

export default api;
