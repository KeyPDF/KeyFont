// Web Worker environment shim
// Stubs out DOM APIs so main.js code can load without errors
var window = self;
var localStorage = { getItem: function() { return null; }, setItem: function() {}, removeItem: function() {} };
function _stubEl(tag) {
  return {
    style: {}, classList: { add: function(){}, remove: function(){}, toggle: function(){} },
    setAttribute: function(){}, removeAttribute: function(){},
    appendChild: function(){}, click: function(){},
    addEventListener: function(){},
    onload: null, onerror: null, onchange: null, onclick: null,
    src: '', type: '', href: '', download: '', className: '', textContent: '', innerHTML: '',
    value: '', checked: false, multiple: false, accept: '', files: [],
    tagName: (tag || 'DIV').toUpperCase(),
    parentNode: null, children: [], childNodes: [],
    getBoundingClientRect: function() { return { top:0, left:0, width:0, height:0 }; },
    querySelector: function() { return _stubEl(); },
    querySelectorAll: function() { return []; },
    remove: function() {}
  };
}
var document = {
  getElementById: function() { return _stubEl(); },
  querySelector: function() { return _stubEl(); },
  querySelectorAll: function() { return []; },
  createElement: function(tag) { return _stubEl(tag); },
  addEventListener: function() {},
  fonts: { add: function() {} },
  head: { appendChild: function(el) {
    // Handle dynamic script loading (fflate, brotli) via importScripts
    if (el.src) {
      try { importScripts(el.src); } catch(e) {}
      if (el.onload) el.onload();
    }
  }},
  body: null
};
window.location = { pathname: '/', href: '', search: '', hash: '' };
window.FontFace = function() { return { load: function() { return Promise.resolve(); } }; };
window.addEventListener = function() {};
var URL = self.URL || { createObjectURL: function(){return '';}, revokeObjectURL: function(){} };
var Image = function() {};
