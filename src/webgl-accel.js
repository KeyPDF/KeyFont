'use strict';

// WebGL2 GPU-accelerated computation for font batch processing
// Uses parallel uint32 reduction via fragment shader for checksum computation
// Falls back to CPU for small data or when WebGL2 is unavailable

var _gpu = { gl: null, prog: null, vao: null, ok: false, tried: false };

function initGPU() {
  if (_gpu.tried) return _gpu.ok;
  _gpu.tried = true;
  try {
    var c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    var gl = c.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) return false;

    // Vertex shader: fullscreen quad
    var vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, '#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0,1);}');
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return false;

    // Fragment shader: 8x8 block reduction of R32UI texture
    var fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs,
      '#version 300 es\nprecision highp usampler2D;\n' +
      'uniform usampler2D S;uniform ivec2 D;out uvec4 O;\n' +
      'void main(){ivec2 b=ivec2(gl_FragCoord.xy)*8;uint s=0u;\n' +
      'for(int y=0;y<8;y++)for(int x=0;x<8;x++){ivec2 c=b+ivec2(x,y);\n' +
      'if(c.x<D.x&&c.y<D.y)s+=texelFetch(S,c,0).r;}O=uvec4(s,0u,0u,0u);}'
    );
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return false;

    var pg = gl.createProgram();
    gl.attachShader(pg, vs);
    gl.attachShader(pg, fs);
    gl.linkProgram(pg);
    if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) return false;

    pg._S = gl.getUniformLocation(pg, 'S');
    pg._D = gl.getUniformLocation(pg, 'D');

    // Fullscreen quad VAO
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pg, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    _gpu.gl = gl;
    _gpu.prog = pg;
    _gpu.vao = vao;
    _gpu.ok = true;
    return true;
  } catch (e) {
    return false;
  }
}

function _mkTex(gl, w, h, data) {
  var t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, data);
  return t;
}

// GPU checksum: pack bytes into R32UI texture, multi-pass 8x8 reduction, read 1x1 result
// Matches OpenType calcChecksum (big-endian uint32 sum, mod 2^32)
function gpuCalcChecksum(data) {
  if (!_gpu.ok && !initGPU()) return _swChecksum(data);
  if (data.length < 32768) return _swChecksum(data);

  var gl = _gpu.gl;

  // Pack bytes into big-endian uint32 array
  var n4 = Math.ceil(data.length / 4);
  var w = Math.ceil(Math.sqrt(n4));
  var h = Math.ceil(n4 / w);
  var total = w * h;
  var u32 = new Uint32Array(total);
  var full = data.length >> 2;
  for (var i = 0; i < full; i++) {
    u32[i] = ((data[i * 4] << 24) | (data[i * 4 + 1] << 16) | (data[i * 4 + 2] << 8) | data[i * 4 + 3]) >>> 0;
  }
  if (data.length & 3) {
    var v = 0, off = full * 4;
    for (var j = 0; j < (data.length & 3); j++) v |= data[off + j] << (24 - j * 8);
    u32[full] = v >>> 0;
  }

  // Upload to R32UI texture
  var src = _mkTex(gl, w, h, u32);
  var sw = w, sh = h;
  var fb = gl.createFramebuffer();

  gl.useProgram(_gpu.prog);
  gl.bindVertexArray(_gpu.vao);
  gl.uniform1i(_gpu.prog._S, 0);
  gl.activeTexture(gl.TEXTURE0);

  // Multi-pass 8x8 reduction until 1x1
  while (sw > 1 || sh > 1) {
    var dw = Math.max(1, Math.ceil(sw / 8));
    var dh = Math.max(1, Math.ceil(sh / 8));
    var dst = _mkTex(gl, dw, dh, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
    gl.viewport(0, 0, dw, dh);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform2i(_gpu.prog._D, sw, sh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.deleteTexture(src);
    src = dst;
    sw = dw;
    sh = dh;
  }

  // Read 1x1 result
  var out = new Uint32Array(1);
  gl.readPixels(0, 0, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, out);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(src);
  gl.bindVertexArray(null);

  return out[0] >>> 0;
}

// CPU fallback checksum
function _swChecksum(data) {
  var n4 = data.length >> 2, sum = 0, i;
  for (i = 0; i < n4; i++) {
    sum = (sum + (((data[i * 4] << 24) | (data[i * 4 + 1] << 16) | (data[i * 4 + 2] << 8) | data[i * 4 + 3]) >>> 0)) >>> 0;
  }
  if (data.length & 3) {
    var v = 0, r = data.length & 3, off = n4 * 4;
    for (i = 0; i < r; i++) v |= data[off + i] << (24 - i * 8);
    sum = (sum + (v >>> 0)) >>> 0;
  }
  return sum;
}

window.initGPU = initGPU;
window.gpuCalcChecksum = gpuCalcChecksum;
