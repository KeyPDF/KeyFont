// Batch conversion Web Worker message handler
// Receives file data, converts, returns result bytes
self.onmessage = async function(e) {
  var msg = e.data;
  if (msg.type === 'warmup') {
    try {
      if (msg.targetFormat === 'woff2' && typeof self.loadFontEditorWoff2 === 'function') {
        await self.loadFontEditorWoff2();
      }
      self.postMessage({
        type: 'warmup-result',
        id: msg.id,
        success: true
      });
    } catch (err) {
      self.postMessage({
        type: 'warmup-result',
        id: msg.id,
        success: false,
        error: err.message || String(err)
      });
    }
    return;
  }
  if (msg.type === 'convert') {
    try {
      // Create a mock File-like object with arrayBuffer() method
      var mockFile = {
        name: msg.filename,
        arrayBuffer: function() { return Promise.resolve(msg.buffer); }
      };
      var result = self.convertSingleFile(mockFile, msg.targetFormat, msg.rawSfnt);
      // convertSingleFile may or may not be async depending on format
      if (result && typeof result.then === 'function') {
        result = await result;
      }
      var bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes);
      self.postMessage({
        type: 'result',
        id: msg.id,
        success: true,
        bytes: bytes,
        filename: result.filename
      }, [bytes.buffer]);
    } catch (err) {
      self.postMessage({
        type: 'result',
        id: msg.id,
        success: false,
        error: err.message || String(err)
      });
    }
  }
};
self.postMessage({ type: 'ready' });
