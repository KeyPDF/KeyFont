'use strict';

// Main app UI layer. Backend conversion/parsing helpers live in src/main.js.
const isMainApp = !window.location.pathname.includes('/convert/');
const isDedicatedConverter = /\/converter\.html$/.test(window.location.pathname);

let state = {
  file: null,
  originalBuffer: null, // raw uploaded bytes
  buffer: null,
  inputContainer: 'sfnt', // 'sfnt' | 'woff' | 'woff2' | 'type1' | 'cff' | 'svg'
  outputFormat: null,  // 'ttf' | 'otf' | 'woff' | 'woff2' | 'cff' | 'pfa' | 'pfb' | 'svg'
  fontType: null,      // 'ttf' | 'otf-cff' | 'cff' | 'type1' | 'svg'
  ttf: null,
  cffFont: null,
  type1Font: null,
  svgFont: null,
  glyphs: [],          // [{id, name, unicode, chars, type}]
  selected: new Set(), // glyph IDs
  mode: 'keep',        // 'keep' | 'remove'
  searchQuery: '',
  lastClickedIdx: null,
  contextGlyphId: null,
  canRebuild: false,
  metadata: {},
  glyphsDisplayLimit: 500  // initial display limit for performance
};

// ═══════════════════════════════════════════════════════════════════
// DRAG & DROP / FILE LOADING
// ═══════════════════════════════════════════════════════════════════

// Check if user arrived from a conversion page
const targetFormat = localStorage.getItem('keyfont-target-format');
if (targetFormat) {
  state.outputFormat = targetFormat;
  localStorage.removeItem('keyfont-target-format'); // Clear after reading
}

// Only initialize main app UI if we're on the main page (not conversion pages)
if (isMainApp) {
// Check for main app elements (avoid const to prevent conflicts with conversion pages)
if (document.getElementById('drop-zone') && document.getElementById('file-input')) {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');
  const stripTextInput = document.getElementById('strip-text-input');
  const BATCH_FONT_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2', 'cff', 'pfa', 'pfb', 'svg']);
  const MAX_IN_MEMORY_ZIP_BYTES = Number(window.KEYFONT_LARGE_ZIP_THRESHOLD_BYTES) || 512 * 1024 * 1024;
  const MAX_BATCH_RESULT_ROWS = 500;
  const ZIP_STREAM_CHUNK_BYTES = 4 * 1024 * 1024;
  let batchSourceType = 'files';
  function handleFileSelection(file) {
    if (!file) return;
    if (isZipFile(file)) {
      batchFiles = [file];
      batchSourceType = 'zip';
      showBatchPanel();
      return;
    }
    if (isDedicatedConverter) {
      batchFiles = [file];
      batchSourceType = 'files';
      showBatchPanel();
      return;
    }
    loadFont(file);
  }

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const dropped = await collectDroppedFiles(e.dataTransfer);
    const files = dropped.files;
    if (files.length === 1 && !dropped.hasDirectory) {
      handleFileSelection(files[0]);
    } else if (files.length > 0) {
      batchFiles = files;
      batchSourceType = dropped.hasDirectory ? 'folder' : 'files';
      showBatchPanel();
    }
  });
  let batchFiles = [];

  document.addEventListener('click', hideGlyphContextMenu);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideGlyphContextMenu();
  });
  window.addEventListener('resize', hideGlyphContextMenu);
  window.addEventListener('scroll', hideGlyphContextMenu, true);

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    if (files.length === 0) return;

    if (files.length === 1) {
      handleFileSelection(files[0]);
    } else {
      // Multiple files - enter batch mode
      batchFiles = files;
      batchSourceType = 'files';
      showBatchPanel();
    }
    fileInput.value = '';
  });

  if (folderInput) {
    folderInput.addEventListener('change', () => {
      const files = Array.from(folderInput.files || []).filter(file => isBatchFontPath(file.name));
      if (files.length) {
        batchFiles = files;
        batchSourceType = 'folder';
        showBatchPanel();
      }
      folderInput.value = '';
    });
  }

async function collectDroppedFiles(dataTransfer) {
  const items = Array.from((dataTransfer && dataTransfer.items) || []);
  const entries = items.map(item => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return { files: Array.from(dataTransfer.files || []), hasDirectory: false };

  const files = [];
  let hasDirectory = false;

  async function readDirectory(entry) {
    hasDirectory = true;
    const reader = entry.createReader();
    while (true) {
      const entriesBatch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!entriesBatch.length) break;
      for (const child of entriesBatch) await readEntry(child);
    }
  }

  async function readEntry(entry) {
    if (entry.isDirectory) return readDirectory(entry);
    if (!entry.isFile) return;
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    if (isBatchFontPath(file.name) || isZipFile(file)) files.push(file);
  }

  for (const entry of entries) await readEntry(entry);
  return { files, hasDirectory };
}

function isZipFile(file) {
  return !!file && /\.zip$/i.test(file.name || '');
}

function getFileExt(name) {
  return (String(name || '').split('/').pop().split('.').pop() || '').toLowerCase();
}

function isBatchFontPath(path) {
  return BATCH_FONT_EXTS.has(getFileExt(path));
}

function isDirectSingleBatch() {
  return batchSourceType !== 'zip' && batchFiles.length === 1;
}

function updateBatchOutputLabels() {
  const directSingle = isDirectSingleBatch();
  const modeLabel = document.getElementById('batch-download-mode-label');
  const downloadBtn = document.getElementById('batch-download-btn');
  if (modeLabel) modeLabel.textContent = directSingle ? 'Download converted font' : 'Download ZIP';
  if (downloadBtn) downloadBtn.textContent = directSingle ? 'Download Font' : 'Download ZIP';
}

function showBatchPanel() {
  document.getElementById('drop-zone').setAttribute('hidden', '');
  document.getElementById('batch-panel').removeAttribute('hidden');
  document.getElementById('batch-count').textContent = batchSourceType === 'zip'
    ? `1 ZIP archive (${batchFiles[0].name})`
    : `${batchFiles.length} ${batchFiles.length === 1 ? 'file' : 'files'}${batchSourceType === 'folder' ? ' from folder' : ''}`;
  updateBatchOutputLabels();
  // Show "Save to folder" only if the browser supports it (Chrome/Edge)
  const folderOpt = document.getElementById('batch-folder-option');
  if (folderOpt) {
    if (batchSourceType !== 'zip' && window.showDirectoryPicker) folderOpt.removeAttribute('hidden');
    else folderOpt.setAttribute('hidden', '');
  }
  if (batchSourceType === 'zip') {
    const zipOutput = document.querySelector('input[name="batch-output"][value="zip"]');
    if (zipOutput) zipOutput.checked = true;
  }
  maybePrewarmBatchWorkers();
}

function cancelBatch() {
  batchFiles = [];
  batchSourceType = 'files';
  document.getElementById('batch-panel').setAttribute('hidden', '');
  document.getElementById('batch-progress').setAttribute('hidden', '');
  document.getElementById('batch-results').setAttribute('hidden', '');
  document.getElementById('batch-download-btn').setAttribute('hidden', '');
  document.getElementById('batch-done-btn').setAttribute('hidden', '');
  document.querySelector('.batch-buttons').style.display = 'flex';
  document.getElementById('drop-zone').removeAttribute('hidden');
}
window.cancelBatch = cancelBatch;

function resetBatchUI() {
  document.getElementById('batch-progress').setAttribute('hidden', '');
  document.getElementById('batch-results').setAttribute('hidden', '');
  document.getElementById('batch-download-btn').setAttribute('hidden', '');
  document.getElementById('batch-done-btn').setAttribute('hidden', '');
  document.getElementById('batch-progress-fill').style.width = '0%';
  document.querySelector('.batch-buttons').style.display = 'flex';
  updateBatchOutputLabels();
  maybePrewarmBatchWorkers();
}
window.resetBatchUI = resetBatchUI;

function batchConvertClick(e) {
  if (e) e.stopPropagation();
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.ttf,.otf,.woff,.woff2,.cff,.pfa,.pfb,.svg,.zip';
  input.onchange = () => {
    const files = Array.from(input.files);
    if (files.length > 0) {
      batchFiles = files;
      batchSourceType = files.length === 1 && isZipFile(files[0]) ? 'zip' : 'files';
      showBatchPanel();
    }
  };
  input.click();
}
window.batchConvertClick = batchConvertClick;

async function batchSaveFile(name, bytes, outputDir) {
  const fh = await outputDir.getFileHandle(name, { create: true });
  const wr = await fh.createWritable();
  await wr.write(bytes);
  await wr.close();
}

// Worker pool for batch conversion
let _batchWorkers = null;
let _batchWorkerUrl = null;
let _woff2WorkerWarmupPromise = null;
function getInlineBatchWorkerUrl() {
  if (_batchWorkerUrl) return _batchWorkerUrl;
  if (typeof window.__KEYFONT_BATCH_WORKER_SOURCE__ !== 'string' || !window.__KEYFONT_BATCH_WORKER_SOURCE__) {
    throw new Error('Inline batch worker source is unavailable');
  }
  _batchWorkerUrl = URL.createObjectURL(
    new Blob([window.__KEYFONT_BATCH_WORKER_SOURCE__], { type: 'text/javascript' })
  );
  return _batchWorkerUrl;
}
function getBatchWorkerPool(poolSize) {
  if (_batchWorkers && _batchWorkers.length === poolSize) return _batchWorkers;
  if (_batchWorkers) _batchWorkers.forEach(w => w.worker.terminate());
  _woff2WorkerWarmupPromise = null;
  const workerUrl = getInlineBatchWorkerUrl();
  _batchWorkers = [];
  for (let i = 0; i < poolSize; i++) {
    const worker = new Worker(workerUrl);
    const entry = { worker, busy: false, pending: null, ready: false, warm: false, waiters: [] };
    worker.onmessage = function(e) {
      handleBatchWorkerMessage(entry, e.data);
    };
    worker.onerror = function(err) {
      rejectWorkerWaiters(entry, new Error(err.message || 'Worker error'));
    };
    _batchWorkers.push(entry);
  }
  return _batchWorkers;
}

function resolveWorkerReady(entry) {
  const waiters = entry.waiters.splice(0);
  for (const waiter of waiters) {
    if (waiter.kind === 'ready') waiter.resolve();
    else entry.waiters.push(waiter);
  }
}

function rejectWorkerWaiters(entry, error) {
  const waiters = entry.waiters.splice(0);
  for (const waiter of waiters) waiter.reject(error);
  if (entry.currentJob) {
    entry.currentJob.reject(error);
    entry.currentJob = null;
  }
  entry.busy = false;
}

function handleBatchWorkerMessage(entry, data) {
  if (data.type === 'ready') {
    entry.ready = true;
    resolveWorkerReady(entry);
    if (entry.pending && !entry.busy) {
      const pj = entry.pending;
      dispatchToWorker(entry, pj);
    }
    return;
  }
  if (data.type === 'warmup-result') {
    entry.warming = false;
    entry.warm = !!data.success;
    const waiters = entry.waiters.splice(0);
    for (const waiter of waiters) {
      if (waiter.kind === 'warmup' && waiter.id === data.id) {
        data.success ? waiter.resolve() : waiter.reject(new Error(data.error || 'Worker warmup failed'));
      } else {
        entry.waiters.push(waiter);
      }
    }
    return;
  }
  if (data.type === 'result') {
    const job = entry.currentJob;
    entry.currentJob = null;
    entry.busy = false;
    if (job) {
      if (data.success) job.resolve({ bytes: data.bytes, filename: data.filename });
      else job.reject(new Error(data.error));
    }
    if (entry.pending) {
      const pj = entry.pending;
      dispatchToWorker(entry, pj);
    }
  }
}

function waitForWorkerReady(entry) {
  if (entry.ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    entry.waiters.push({ kind: 'ready', resolve, reject });
  });
}

function warmupWorker(entry, targetFormat) {
  if (targetFormat !== 'woff2' || entry.warm) return Promise.resolve();
  return waitForWorkerReady(entry).then(() => new Promise((resolve, reject) => {
    const id = Math.random();
    entry.waiters.push({ kind: 'warmup', id, resolve, reject });
    entry.worker.postMessage({ type: 'warmup', id, targetFormat });
  }));
}

function prewarmBatchWorkers(targetFormat) {
  if (targetFormat !== 'woff2') return Promise.resolve();
  if (_woff2WorkerWarmupPromise) return _woff2WorkerWarmupPromise;
  const poolSize = Math.min(navigator.hardwareConcurrency || 4, 4);
  const pool = getBatchWorkerPool(poolSize);
  _woff2WorkerWarmupPromise = Promise.all(pool.map(entry => warmupWorker(entry, targetFormat)))
    .catch(error => {
      _woff2WorkerWarmupPromise = null;
      throw error;
    });
  return _woff2WorkerWarmupPromise;
}

function maybePrewarmBatchWorkers() {
  const formatEl = document.getElementById('batch-format');
  if (!formatEl || formatEl.value !== 'woff2') return;
  prewarmBatchWorkers('woff2').catch(() => {
    // Start Conversion still has the normal fallback path.
  });
}

function convertInWorker(pool, buffer, filename, targetFormat, rawSfnt) {
  return new Promise((resolve, reject) => {
    const job = { buffer, filename, targetFormat, rawSfnt, resolve, reject };
    // Find an idle worker
    const idle = pool.find(w => !w.busy && w.ready);
    if (idle) {
      dispatchToWorker(idle, job);
    } else {
      // Queue - find worker with no pending job, or first worker
      const target = pool.find(w => !w.pending) || pool[0];
      if (target.pending) {
        // All workers busy with queued jobs - shouldn't happen with proper concurrency control
        reject(new Error('Worker pool exhausted'));
      } else {
        target.pending = job;
      }
    }
  });
}

function dispatchToWorker(entry, job) {
  entry.busy = true;
  entry.pending = null;
  entry.currentJob = job;
  const id = Math.random();
  // Transfer the buffer to avoid copying
  const bufCopy = job.buffer.slice(0);
  entry.worker.postMessage({
    type: 'convert',
    id: id,
    buffer: bufCopy,
    filename: job.filename,
    targetFormat: job.targetFormat,
    rawSfnt: job.rawSfnt
  }, [bufCopy]);
}

async function startBatchConversion() {
  const format = document.getElementById('batch-format').value;
  const progressBar = document.getElementById('batch-progress-fill');
  const progressText = document.getElementById('batch-progress-text');
  const resultsDiv = document.getElementById('batch-results');
  const downloadBtn = document.getElementById('batch-download-btn');
  const outputMode = (document.querySelector('input[name="batch-output"]:checked') || {}).value || 'zip';

  let outputDir = null;
  if (outputMode === 'folder') {
    try {
      outputDir = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      return;
    }
  }

  document.getElementById('batch-progress').removeAttribute('hidden');
  document.getElementById('batch-results').removeAttribute('hidden');
  downloadBtn.setAttribute('hidden', '');
  resultsDiv.innerHTML = '';
  document.querySelector('.batch-buttons').style.display = 'none';

  if (format === 'woff2') {
    await loadFontEditorWoff2();
    _woff2ExportSupport = true;
  }

  const usedNames = {};
  let successCount = 0;
  const needsCompress = format === 'woff2' || format === 'woff';
  const compressFunc = format === 'woff2' ? encodeSfntToWOFF2 : encodeSfntToWOFF;
  const maxWorkers = Math.min(navigator.hardwareConcurrency || 4, 4);

  // Try to use Web Workers for off-main-thread conversion
  let useWorkers = false;
  let pool = null;
  try {
    pool = getBatchWorkerPool(maxWorkers);
    useWorkers = true;
    // Wait for workers to be ready (with timeout)
    progressText.textContent = format === 'woff2' ? 'Preparing WOFF2 workers...' : 'Starting workers...';
    await Promise.race([
      format === 'woff2'
        ? prewarmBatchWorkers('woff2')
        : Promise.all(pool.map(waitForWorkerReady)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
  } catch (e) {
    // Workers failed to load - fall back to main thread
    useWorkers = false;
    pool = null;
  }

  // Helper: convert a single file (worker or main thread)
  async function convertOne(file, targetFormat, rawSfnt) {
    const buf = await file.arrayBuffer();
    if (useWorkers) {
      return convertInWorker(pool, buf, file.name, targetFormat, rawSfnt);
    } else {
      return convertSingleFile(file, targetFormat, rawSfnt);
    }
  }

  // Helper: deduplicate output filename
  function dedup(outName, origName) {
    if (usedNames[outName]) {
      const origExt = (origName.split('.').pop() || '').toLowerCase();
      const base = outName.replace(/\.[^.]+$/, '');
      const ext = outName.split('.').pop();
      outName = base + '_' + origExt + '.' + ext;
    }
    usedNames[outName] = true;
    return outName;
  }

  // Helper: add result to UI
  let resultRowCount = 0;
  let suppressedResultRows = 0;
  function addResult(ok, text) {
    if (resultRowCount >= MAX_BATCH_RESULT_ROWS) {
      suppressedResultRows++;
      return;
    }
    resultRowCount++;
    const item = document.createElement('div');
    item.className = 'batch-result-item ' + (ok ? 'success' : 'error');
    item.textContent = (ok ? '✓ ' : '✗ ') + text;
    resultsDiv.appendChild(item);
  }

  function flushResultRowSummary() {
    if (!suppressedResultRows) return;
    const item = document.createElement('div');
    item.className = 'batch-result-item';
    item.textContent = `Showing first ${MAX_BATCH_RESULT_ROWS} results. ${suppressedResultRows} more results were processed.`;
    resultsDiv.appendChild(item);
  }

  function readU16LE(bytes, off) {
    return bytes[off] | (bytes[off + 1] << 8);
  }

  function readU32LE(bytes, off) {
    return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
  }

  function writeU16LE(bytes, off, value) {
    bytes[off] = value & 255;
    bytes[off + 1] = (value >>> 8) & 255;
  }

  function writeU32LE(bytes, off, value) {
    bytes[off] = value & 255;
    bytes[off + 1] = (value >>> 8) & 255;
    bytes[off + 2] = (value >>> 16) & 255;
    bytes[off + 3] = (value >>> 24) & 255;
  }

  async function readFileSlice(file, start, length) {
    const blob = file.slice(start, start + length);
    return new Uint8Array(await blob.arrayBuffer());
  }

  function decodeZipName(bytes, flags) {
    const label = (flags & 0x0800) ? 'utf-8' : 'latin1';
    try {
      return new TextDecoder(label).decode(bytes);
    } catch (_) {
      return Array.from(bytes, b => String.fromCharCode(b)).join('');
    }
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function currentDosDateTime() {
    const d = new Date();
    const year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  async function readZipDirectory(file) {
    const tailLength = Math.min(file.size, 22 + 65535);
    const tailStart = file.size - tailLength;
    const tail = await readFileSlice(file, tailStart, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (readU32LE(tail, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('ZIP central directory was not found');
    const totalEntries = readU16LE(tail, eocd + 10);
    const cdSize = readU32LE(tail, eocd + 12);
    const cdOffset = readU32LE(tail, eocd + 16);
    if (totalEntries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      throw new Error('ZIP64 archives are not supported in streaming mode yet');
    }
    const cd = await readFileSlice(file, cdOffset, cdSize);
    const entries = [];
    let off = 0;
    for (let i = 0; i < totalEntries; i++) {
      if (readU32LE(cd, off) !== 0x02014b50) throw new Error('Invalid ZIP central directory entry');
      const flags = readU16LE(cd, off + 8);
      const method = readU16LE(cd, off + 10);
      const dosTime = readU16LE(cd, off + 12);
      const dosDate = readU16LE(cd, off + 14);
      const crc = readU32LE(cd, off + 16);
      const compressedSize = readU32LE(cd, off + 20);
      const uncompressedSize = readU32LE(cd, off + 24);
      const nameLen = readU16LE(cd, off + 28);
      const extraLen = readU16LE(cd, off + 30);
      const commentLen = readU16LE(cd, off + 32);
      const externalAttrs = readU32LE(cd, off + 38);
      const localOffset = readU32LE(cd, off + 42);
      const nameBytes = cd.slice(off + 46, off + 46 + nameLen);
      const name = decodeZipName(nameBytes, flags);
      entries.push({
        flags,
        method,
        dosTime,
        dosDate,
        crc,
        compressedSize,
        uncompressedSize,
        externalAttrs,
        localOffset,
        name,
        nameBytes,
        centralExtra: cd.slice(off + 46 + nameLen, off + 46 + nameLen + extraLen),
        centralComment: cd.slice(off + 46 + nameLen + extraLen, off + 46 + nameLen + extraLen + commentLen)
      });
      off += 46 + nameLen + extraLen + commentLen;
    }
    const byOffset = entries.slice().sort((a, b) => a.localOffset - b.localOffset);
    for (let i = 0; i < byOffset.length; i++) {
      const entry = byOffset[i];
      entry.rawEnd = i + 1 < byOffset.length ? byOffset[i + 1].localOffset : cdOffset;
    }
    return entries;
  }

  async function getZipEntryData(file, entry, ff) {
    const localHeader = await readFileSlice(file, entry.localOffset, 30);
    if (readU32LE(localHeader, 0) !== 0x04034b50) throw new Error(`Invalid ZIP local header for ${entry.name}`);
    const nameLen = readU16LE(localHeader, 26);
    const extraLen = readU16LE(localHeader, 28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const compressed = await readFileSlice(file, dataStart, entry.compressedSize);
    if (entry.method === 0) return compressed;
    if (entry.method === 8) return ff.inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize) });
    throw new Error(`Unsupported ZIP compression method ${entry.method}`);
  }

  async function copyFileRange(file, start, end, writable) {
    let pos = start;
    while (pos < end) {
      const len = Math.min(ZIP_STREAM_CHUNK_BYTES, end - pos);
      await writable.write(await readFileSlice(file, pos, len));
      pos += len;
    }
  }

  async function writeStoredZipEntry(writable, offset, name, bytes) {
    const nameBytes = new TextEncoder().encode(name);
    const { time, date } = currentDosDateTime();
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + nameBytes.length);
    writeU32LE(local, 0, 0x04034b50);
    writeU16LE(local, 4, 20);
    writeU16LE(local, 6, 0x0800);
    writeU16LE(local, 8, 0);
    writeU16LE(local, 10, time);
    writeU16LE(local, 12, date);
    writeU32LE(local, 14, crc);
    writeU32LE(local, 18, bytes.length);
    writeU32LE(local, 22, bytes.length);
    writeU16LE(local, 26, nameBytes.length);
    writeU16LE(local, 28, 0);
    local.set(nameBytes, 30);
    await writable.write(local);
    await writable.write(bytes);
    const central = new Uint8Array(46 + nameBytes.length);
    writeU32LE(central, 0, 0x02014b50);
    writeU16LE(central, 4, 20);
    writeU16LE(central, 6, 20);
    writeU16LE(central, 8, 0x0800);
    writeU16LE(central, 10, 0);
    writeU16LE(central, 12, time);
    writeU16LE(central, 14, date);
    writeU32LE(central, 16, crc);
    writeU32LE(central, 20, bytes.length);
    writeU32LE(central, 24, bytes.length);
    writeU16LE(central, 28, nameBytes.length);
    writeU16LE(central, 30, 0);
    writeU16LE(central, 32, 0);
    writeU16LE(central, 34, 0);
    writeU16LE(central, 36, 0);
    writeU32LE(central, 38, 0);
    writeU32LE(central, 42, offset);
    central.set(nameBytes, 46);
    return {
      central,
      nextOffset: offset + local.length + bytes.length
    };
  }

  function buildCopiedCentralEntry(entry, newOffset) {
    const nameBytes = entry.nameBytes;
    const extra = entry.centralExtra || new Uint8Array(0);
    const comment = entry.centralComment || new Uint8Array(0);
    const central = new Uint8Array(46 + nameBytes.length + extra.length + comment.length);
    writeU32LE(central, 0, 0x02014b50);
    writeU16LE(central, 4, 20);
    writeU16LE(central, 6, 20);
    writeU16LE(central, 8, entry.flags);
    writeU16LE(central, 10, entry.method);
    writeU16LE(central, 12, entry.dosTime);
    writeU16LE(central, 14, entry.dosDate);
    writeU32LE(central, 16, entry.crc);
    writeU32LE(central, 20, entry.compressedSize);
    writeU32LE(central, 24, entry.uncompressedSize);
    writeU16LE(central, 28, nameBytes.length);
    writeU16LE(central, 30, extra.length);
    writeU16LE(central, 32, comment.length);
    writeU16LE(central, 34, 0);
    writeU16LE(central, 36, 0);
    writeU32LE(central, 38, entry.externalAttrs);
    writeU32LE(central, 42, newOffset);
    central.set(nameBytes, 46);
    central.set(extra, 46 + nameBytes.length);
    central.set(comment, 46 + nameBytes.length + extra.length);
    return central;
  }

  async function finishZipStream(writable, centralEntries, centralOffset) {
    let centralSize = 0;
    for (const central of centralEntries) {
      await writable.write(central);
      centralSize += central.length;
    }
    const eocd = new Uint8Array(22);
    writeU32LE(eocd, 0, 0x06054b50);
    writeU16LE(eocd, 8, centralEntries.length);
    writeU16LE(eocd, 10, centralEntries.length);
    writeU32LE(eocd, 12, centralSize);
    writeU32LE(eocd, 16, centralOffset);
    writeU16LE(eocd, 20, 0);
    await writable.write(eocd);
  }

  async function createServiceWorkerZipWritable(filename) {
    if (!navigator.serviceWorker) {
      throw new Error('Firefox large ZIP streaming requires this page to be served with the service worker enabled.');
    }
    const registration = await navigator.serviceWorker.ready;
    const sw = navigator.serviceWorker.controller || registration.active;
    if (!sw) {
      throw new Error('Service worker is not controlling this page yet. Reload once, then try the large ZIP again.');
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const channel = new MessageChannel();
    let sawRegistered = false;
    let sawReady = false;
    const waitForPortMessage = (wantedType, timeoutMessage) => new Promise((resolve, reject) => {
      if (wantedType === 'registered' && sawRegistered) {
        resolve();
        return;
      }
      if (wantedType === 'ready' && sawReady) {
        resolve();
        return;
      }
      const previousHandler = channel.port1.onmessage;
      const timeout = setTimeout(() => reject(new Error(timeoutMessage)), 10000);
      channel.port1.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === 'registered') sawRegistered = true;
        if (msg.type === 'ready') sawReady = true;
        if (msg.type === wantedType) {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === 'cancel') {
          clearTimeout(timeout);
          reject(new Error('Download was cancelled'));
        } else if (previousHandler) {
          previousHandler(event);
        }
      };
    });

    sw.postMessage({
      type: 'keyfont-stream-init',
      id,
      filename
    }, [channel.port2]);
    await waitForPortMessage('registered', 'Download stream was not registered');

    const url = `/__keyfont_stream_download__/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`;
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.style.display = 'none';
    document.body.appendChild(frame);
    await waitForPortMessage('ready', 'Download stream did not start');

    return {
      async write(chunk) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        const copy = bytes.slice();
        channel.port1.postMessage({ type: 'chunk', chunk: copy }, [copy.buffer]);
      },
      async close() {
        channel.port1.postMessage({ type: 'close' });
        channel.port1.close();
        setTimeout(() => frame.remove(), 1000);
      },
      async abort(error) {
        channel.port1.postMessage({ type: 'abort', error: error && error.message ? error.message : String(error || '') });
        channel.port1.close();
        frame.remove();
      }
    };
  }

  async function createLargeZipWritable(filename) {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'ZIP archive',
          accept: { 'application/zip': ['.zip'] }
        }]
      });
      return handle.createWritable();
    }
    return createServiceWorkerZipWritable(filename);
  }

  async function processLargeZipStreaming(zipFile, format, needsCompress, compressFunc, convertOne, addResult, progressBar, progressText) {
    const baseZipName = zipFile.name.replace(/\.zip$/i, '');
    const writable = await createLargeZipWritable(baseZipName + '-custom-fonts.zip');
    let offset = 0;
    const centralEntries = [];
    const ff = await loadFflate();
    const entries = await readZipDirectory(zipFile);
    const usedArchivePaths = new Set();
    const fontEntries = entries.filter(entry => !entry.name.endsWith('/') && isBatchFontPath(entry.name));
    let successCount = 0;
    let processedFonts = 0;

    try {
      for (const entry of entries) {
        if (!entry.name.endsWith('/') && isBatchFontPath(entry.name)) {
          processedFonts++;
          progressText.textContent = `Converting ${processedFonts} of ${fontEntries.length}: ${entry.name}`;
          progressBar.style.width = fontEntries.length
            ? (((processedFonts - 1) / fontEntries.length) * 100).toFixed(0) + '%'
            : '0%';
          try {
            const sourceBytes = await getZipEntryData(zipFile, entry, ff);
            const entryFile = {
              name: entry.name,
              arrayBuffer: function() {
                return Promise.resolve(sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength));
              }
            };
            const converted = await convertOne(entryFile, format, needsCompress);
            let outBytes = converted.bytes;
            if (needsCompress) outBytes = new Uint8Array(await compressFunc(outBytes));
            const outPath = dedupArchivePath(converted.filename, usedArchivePaths);
            const written = await writeStoredZipEntry(writable, offset, outPath, outBytes);
            offset = written.nextOffset;
            centralEntries.push(written.central);
            successCount++;
            addResult(true, entry.name + ' → ' + outPath);
          } catch (error) {
            addResult(false, entry.name + ': ' + error.message);
          }
          progressBar.style.width = fontEntries.length
            ? ((processedFonts / fontEntries.length) * 100).toFixed(0) + '%'
            : '100%';
          if (processedFonts % 4 === 0) await new Promise(resolve => requestAnimationFrame(resolve));
        } else {
          const newOffset = offset;
          const rawEnd = entry.rawEnd == null ? entry.localOffset + 30 + entry.compressedSize : entry.rawEnd;
          await copyFileRange(zipFile, entry.localOffset, rawEnd, writable);
          offset += rawEnd - entry.localOffset;
          centralEntries.push(buildCopiedCentralEntry(entry, newOffset));
          usedArchivePaths.add(entry.name);
        }
      }

      if (!fontEntries.length) {
        progressText.textContent = 'No supported font files found in the ZIP.';
        addResult(false, zipFile.name + ': no .ttf .otf .woff .woff2 .cff .pfa .pfb .svg files found');
      }

      progressText.textContent = 'Writing ZIP directory...';
      await finishZipStream(writable, centralEntries, offset);
      await writable.close();
      progressBar.style.width = '100%';
      progressText.textContent = successCount > 0
        ? `Done! Streamed ZIP saved. Replaced ${successCount} of ${fontEntries.length} fonts.`
        : 'Streamed ZIP saved, but no fonts were converted.';
      return true;
    } catch (error) {
      try { await writable.abort(); } catch (_) {}
      throw error;
    }
  }

  function dedupArchivePath(path, usedPaths) {
    if (!usedPaths.has(path)) {
      usedPaths.add(path);
      return path;
    }
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
    const file = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = file.lastIndexOf('.');
    const base = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : '';
    let i = 2;
    let candidate;
    do {
      candidate = `${dir}${base}_${i}${ext}`;
      i++;
    } while (usedPaths.has(candidate));
    usedPaths.add(candidate);
    return candidate;
  }

  if (batchSourceType === 'zip') {
    const zipFile = batchFiles[0];
    if (zipFile.size > MAX_IN_MEMORY_ZIP_BYTES) {
      try {
        const saved = await processLargeZipStreaming(
          zipFile,
          format,
          needsCompress,
          compressFunc,
          convertOne,
          addResult,
          progressBar,
          progressText
        );
        flushResultRowSummary();
        if (!saved) document.getElementById('batch-done-btn').removeAttribute('hidden');
        else document.getElementById('batch-done-btn').removeAttribute('hidden');
      } catch (error) {
        addResult(false, zipFile.name + ': ' + error.message);
        flushResultRowSummary();
        progressText.textContent = 'Large ZIP streaming failed.';
        document.getElementById('batch-done-btn').removeAttribute('hidden');
      }
      return;
    }
    const ff = await loadFflate();
    let entries;
    try {
      progressText.textContent = 'Reading ZIP...';
      const zipBytes = new Uint8Array(await zipFile.arrayBuffer());
      entries = ff.unzipSync(zipBytes);
    } catch (error) {
      addResult(false, zipFile.name + ': ZIP could not be read');
      progressText.textContent = 'ZIP could not be read.';
      document.getElementById('batch-done-btn').removeAttribute('hidden');
      return;
    }

    const names = Object.keys(entries);
    const fontNames = names.filter(name => !name.endsWith('/') && isBatchFontPath(name));
    const outZipFiles = {};
    const usedArchivePaths = new Set();

    for (const name of names) {
      if (!isBatchFontPath(name)) {
        const outName = dedupArchivePath(name, usedArchivePaths);
        outZipFiles[outName] = [entries[name], { level: 0 }];
      }
    }

    if (!fontNames.length) {
      progressText.textContent = 'No supported font files found in the ZIP.';
      addResult(false, zipFile.name + ': no .ttf .otf .woff .woff2 .cff .pfa .pfb .svg files found');
      document.getElementById('batch-done-btn').removeAttribute('hidden');
      return;
    }

    for (let i = 0; i < fontNames.length; i++) {
      const name = fontNames[i];
      try {
        progressText.textContent = `Converting ${i + 1} of ${fontNames.length}: ${name}`;
        progressBar.style.width = ((i / fontNames.length) * 100).toFixed(0) + '%';
        const entryFile = {
          name,
          arrayBuffer: function() {
            const bytes = entries[name];
            return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          }
        };
        const converted = await convertOne(entryFile, format, needsCompress);
        let bytes = converted.bytes;
        if (needsCompress) bytes = new Uint8Array(await compressFunc(bytes));
        const outPath = dedupArchivePath(converted.filename, usedArchivePaths);
        outZipFiles[outPath] = [bytes, { level: (format === 'woff' || format === 'woff2') ? 0 : 1 }];
        successCount++;
        addResult(true, name + ' → ' + outPath);
      } catch (error) {
        addResult(false, name + ': ' + error.message);
      }
      progressBar.style.width = (((i + 1) / fontNames.length) * 100).toFixed(0) + '%';
      if (i % 4 === 3) await new Promise(resolve => requestAnimationFrame(resolve));
    }

    if (successCount > 0) {
      flushResultRowSummary();
      progressText.textContent = 'Writing ZIP...';
      await new Promise(resolve => requestAnimationFrame(resolve));
      const zipBytes = ff.zipSync(outZipFiles, { level: 1 });
      const zipBlob = new Blob([zipBytes], { type: 'application/zip' });
      const zipUrl = URL.createObjectURL(zipBlob);
      const baseZipName = zipFile.name.replace(/\.zip$/i, '');
      downloadBtn.onclick = function() {
        const a = document.createElement('a');
        a.href = zipUrl;
        a.download = baseZipName + '-custom-fonts.zip';
        a.click();
      };
      downloadBtn.removeAttribute('hidden');
      progressText.textContent = `Done! Replaced ${successCount} of ${fontNames.length} fonts. Non-font files were preserved.`;
    } else {
      flushResultRowSummary();
      progressText.textContent = 'All font conversions failed. No ZIP was created.';
    }
    document.getElementById('batch-done-btn').removeAttribute('hidden');
    return;
  }

  if (outputDir) {
    // ── FOLDER MODE: convert with concurrency limit, save immediately ──
    let completed = 0;
    const total = batchFiles.length;

    // Process files with concurrency limit
    let nextIdx = 0;
    const activeJobs = [];

    function startNext() {
      if (nextIdx >= total) return null;
      const idx = nextIdx++;
      const file = batchFiles[idx];
      const promise = (async () => {
        try {
          const converted = await convertOne(file, format, needsCompress);
          let bytes = converted.bytes;
          if (needsCompress) bytes = new Uint8Array(await compressFunc(bytes));
          const outName = dedup(converted.filename, file.name);
          await batchSaveFile(outName, bytes, outputDir);
          successCount++;
          addResult(true, file.name + ' → ' + outName);
        } catch (error) {
          addResult(false, file.name + ': ' + error.message);
        }
        completed++;
        const pct = (completed / total * 100).toFixed(0);
        progressBar.style.width = pct + '%';
        progressText.textContent = `Converting ${completed} of ${total}...`;
      })();
      return promise;
    }

    // Launch initial batch
    for (let i = 0; i < maxWorkers && i < total; i++) {
      activeJobs.push(startNext());
    }

    // As each completes, start the next
    while (completed < total) {
      await Promise.race(activeJobs.filter(Boolean));
      // Remove settled promises and add new ones
      for (let i = activeJobs.length - 1; i >= 0; i--) {
        const settled = await Promise.race([activeJobs[i].then(() => true), Promise.resolve(false)]);
        if (settled) {
          activeJobs[i] = startNext();
          if (!activeJobs[i]) activeJobs.splice(i, 1);
        }
      }
      // Yield for UI
      await new Promise(resolve => requestAnimationFrame(resolve));
    }

    progressBar.style.width = '100%';
    flushResultRowSummary();
    progressText.textContent = successCount > 0
      ? `Done! ${successCount} of ${total} fonts saved.`
      : 'All conversions failed.';
    document.getElementById('batch-done-btn').removeAttribute('hidden');
    return;
  }

  // ── ZIP MODE: convert with concurrency, then zip ──
  const zipFiles = {};
  let completed = 0;
  const total = batchFiles.length;
  const results = new Array(total);

  // Process all files with worker pool concurrency
  let nextIdx = 0;
  const activeJobs = new Set();

  function startNextZip() {
    if (nextIdx >= total) return null;
    const idx = nextIdx++;
    const file = batchFiles[idx];
    const promise = (async () => {
      try {
        const converted = await convertOne(file, format, needsCompress);
        let bytes = converted.bytes;
        if (needsCompress) bytes = new Uint8Array(await compressFunc(bytes));
        results[idx] = { file, bytes, filename: converted.filename };
      } catch (error) {
        results[idx] = { file, error };
      }
      completed++;
      const pct = (completed / total * 100).toFixed(0);
      progressBar.style.width = pct + '%';
      progressText.textContent = `Converting ${completed} of ${total}: ${file.name}`;
      activeJobs.delete(promise);
    })();
    activeJobs.add(promise);
    return promise;
  }

  // Launch initial batch
  for (let i = 0; i < maxWorkers && i < total; i++) startNextZip();

  // Process until done
  while (completed < total) {
    if (activeJobs.size > 0) {
      await Promise.race(activeJobs);
    }
    // Fill up to maxWorkers
    while (activeJobs.size < maxWorkers && nextIdx < total) startNextZip();
    // Yield for UI
    if (completed % 4 === 0) await new Promise(resolve => requestAnimationFrame(resolve));
  }

  // Collect results
  for (let i = 0; i < total; i++) {
    const r = results[i];
    if (!r) continue;
    if (r.error) {
      addResult(false, r.file.name + ': ' + r.error.message);
    } else {
      const outName = dedup(r.filename, r.file.name);
      zipFiles[outName] = r.bytes;
      successCount++;
      addResult(true, r.file.name + ' → ' + outName);
    }
  }

  if (successCount > 0) {
    flushResultRowSummary();
    if (isDirectSingleBatch()) {
      const outName = Object.keys(zipFiles)[0];
      const fontBlob = new Blob([zipFiles[outName]], { type: 'application/octet-stream' });
      const fontUrl = URL.createObjectURL(fontBlob);
      downloadBtn.textContent = `Download ${outName}`;
      downloadBtn.onclick = function() {
        const a = document.createElement('a');
        a.href = fontUrl;
        a.download = outName;
        a.click();
      };
      downloadBtn.removeAttribute('hidden');
      progressBar.style.width = '100%';
      progressText.textContent = `Done! ${batchFiles[0].name} converted to ${outName}.`;
      document.getElementById('batch-done-btn').removeAttribute('hidden');
      return;
    }
    progressText.textContent = `Zipping ${successCount} converted files...`;
    progressBar.style.width = '100%';
    await new Promise(resolve => requestAnimationFrame(resolve));
    const ff = await loadFflate();
    const zipLevel = (format === 'woff' || format === 'woff2') ? 0 : 1;
    const zipChunks = [];
    const zipper = new ff.Zip();
    zipper.ondata = function(err, data, final) {
      if (!err) zipChunks.push(data);
    };
    const names = Object.keys(zipFiles);
    for (let i = 0; i < names.length; i++) {
      const entry = zipLevel === 0
        ? new ff.ZipPassThrough(names[i])
        : new ff.ZipDeflate(names[i], { level: zipLevel });
      zipper.add(entry);
      entry.push(zipFiles[names[i]], true);
      if (i % 100 === 99) {
        const pct = ((i + 1) / names.length * 100).toFixed(0);
        progressText.textContent = `Zipping ${i + 1} of ${names.length} files... (${pct}%)`;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    }
    zipper.end();
    const zipBlob = new Blob(zipChunks, { type: 'application/zip' });
    const zipUrl = URL.createObjectURL(zipBlob);

    downloadBtn.onclick = function() {
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = 'converted-fonts.zip';
      a.click();
    };
    downloadBtn.removeAttribute('hidden');
    progressText.textContent = `Done! ${successCount} of ${batchFiles.length} fonts converted.`;
  } else {
    flushResultRowSummary();
    progressText.textContent = 'All conversions failed.';
  }
  document.getElementById('batch-done-btn').removeAttribute('hidden');
}
window.startBatchConversion = startBatchConversion;

async function convertSingleFile(file, targetFormat, rawSfnt) {
  // Save entire state, use parseFont + exportFont logic directly
  const savedState = Object.assign({}, state);
  try {
    const buf = await file.arrayBuffer();
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    state.file = file;
    state.originalBuffer = buf;
    state.buffer = buf;
    state.mode = 'keep';
    state.selected = new Set();

    // Use the exact same parseFont that single-file mode uses
    await parseFont(buf, ext);

    // Keep all glyphs (no subsetting for batch)
    const keepIds = new Set(state.glyphs.map(g => g.id));
    keepIds.add(state.glyphs[0]?.id ?? 0);

    const baseName = file.name.replace(/\.[^.]+$/, '');
    const family = state.metadata.family || baseName;
    const ps = state.metadata.postScript || baseName;
    let rebuilt, filename;
    const getCurrentSfntBytes = () => new Uint8Array(state.buffer).slice();

    // Same conversion logic as exportFont()
    if (targetFormat === 'ttf') {
      if (state.fontType === 'ttf') {
        rebuilt = getCurrentSfntBytes();
      } else {
        const { records, cmapPairs } = buildGlyphRecordsFromKeepIds(keepIds);
        rebuilt = buildTTFFromGlyphRecords(records, cmapPairs, family, ps);
      }
      filename = baseName + '.ttf';
    } else if (targetFormat === 'otf') {
      if (state.fontType === 'ttf') {
        rebuilt = rebuildTTF(state.buffer, keepIds);
      } else if (state.fontType === 'otf-cff') {
        rebuilt = getCurrentSfntBytes();
      } else {
        const { records, cmapPairs } = buildGlyphRecordsFromKeepIds(keepIds);
        rebuilt = buildOTFCFFFromGlyphRecords(records, cmapPairs, family, ps);
      }
      filename = baseName + '.otf';
    } else if (targetFormat === 'woff') {
      let sfnt;
      if (state.fontType === 'ttf' || state.fontType === 'otf-cff') {
        sfnt = getCurrentSfntBytes();
      } else {
        const { records, cmapPairs } = buildGlyphRecordsFromKeepIds(keepIds);
        sfnt = buildOTFCFFFromGlyphRecords(records, cmapPairs, family, ps);
      }
      rebuilt = rawSfnt ? sfnt : await encodeSfntToWOFF(sfnt);
      filename = baseName + '.woff';
    } else if (targetFormat === 'woff2') {
      let sfnt;
      if (state.fontType === 'ttf' || state.fontType === 'otf-cff') {
        sfnt = getCurrentSfntBytes();
      } else {
        const { records, cmapPairs } = buildGlyphRecordsFromKeepIds(keepIds);
        sfnt = buildOTFCFFFromGlyphRecords(records, cmapPairs, family, ps);
      }
      rebuilt = rawSfnt ? sfnt : await encodeSfntToWOFF2(sfnt);
      filename = baseName + '.woff2';
    } else if (targetFormat === 'cff') {
      if (state.fontType === 'cff') {
        rebuilt = rebuildRawCFF(state.buffer, keepIds);
      } else if (state.fontType === 'otf-cff') {
        const cffTable = state.ttf.tables['CFF '];
        const cffBytes = new Uint8Array(state.buffer, cffTable.offset, cffTable.length);
        rebuilt = rebuildCFFTable(cffBytes, keepIds);
      } else {
        const { records } = buildGlyphRecordsFromKeepIds(keepIds);
        rebuilt = buildCFFFromGlyphRecords(records, ps);
      }
      filename = baseName + '.cff';
    } else if (targetFormat === 'pfa' || targetFormat === 'pfb') {
      let pfaBytes;
      if (state.fontType === 'type1') {
        const keepNames = new Set(['.notdef']);
        for (const g of state.glyphs) {
          if (keepIds.has(g.id)) keepNames.add(g.name);
        }
        pfaBytes = rebuildType1Font(state.type1Font, keepNames);
      } else {
        const { records } = buildGlyphRecordsFromKeepIds(keepIds);
        pfaBytes = buildType1FromGlyphRecords(records, family, ps, state.metadata);
      }
      if (targetFormat === 'pfb') {
        rebuilt = convertPfaToPfb(pfaBytes);
        filename = baseName + '.pfb';
      } else {
        rebuilt = pfaBytes;
        filename = baseName + '.pfa';
      }
    } else if (targetFormat === 'svg') {
      const { records } = buildGlyphRecordsFromKeepIds(keepIds);
      if (!window.SVGFontUtils || typeof window.SVGFontUtils.buildSvgFontFromGlyphRecords !== 'function') {
        throw new Error('SVG support not loaded');
      }
      rebuilt = window.SVGFontUtils.buildSvgFontFromGlyphRecords(records, {
        family,
        postScriptName: ps,
        unitsPerEm: 1000,
        defaultAdvanceWidth: records.find(r => r.name === '.notdef')?.advanceWidth || 1000,
        metadata: state.metadata
      });
      filename = baseName + '.svg';
    } else {
      throw new Error('Unsupported target format: ' + targetFormat);
    }

    const bytes = rebuilt instanceof Uint8Array ? rebuilt : new Uint8Array(rebuilt);
    return { bytes, filename };
  } finally {
    // Restore full state
    Object.assign(state, savedState);
  }
}
// Expose for Web Worker access (strict mode makes block-scoped functions invisible at global scope)
window.convertSingleFile = convertSingleFile;

if (stripTextInput) {
  stripTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stripFromText();
    }
  });
}

window.addEventListener('scroll', () => {
  const btn = document.getElementById('scroll-top');
  btn.classList.toggle('visible', window.scrollY > 400);
});

async function loadFont(file) {
  // Show loading overlay
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingSubtext = document.getElementById('loading-subtext');
  const startTime = Date.now();

  // Force reflow to ensure CSS transition works
  loadingOverlay.offsetHeight;
  loadingOverlay.classList.add('active');
  loadingSubtext.textContent = 'Reading file...';

  // Small delay to ensure overlay is visible
  await new Promise(resolve => setTimeout(resolve, 50));

  try {
    state.file = file;
    const buf = await file.arrayBuffer();
    state.originalBuffer = buf;
    state.buffer = buf;
    const ext = (file.name.split('.').pop() || '').toLowerCase();

    // Validate file extension
    const supportedExts = ['ttf', 'otf', 'woff', 'woff2', 'cff', 'pfa', 'pfb', 'svg'];
    if (!supportedExts.includes(ext)) {
      throw new Error('UNSUPPORTED_FORMAT');
    }

    loadingSubtext.textContent = 'Parsing font data...';
    await parseFont(buf, ext);

    loadingSubtext.textContent = 'Rendering UI...';
    renderUI();

    // Ensure minimum display time of 800ms so user can see it
    const elapsed = Date.now() - startTime;
    const minDisplayTime = 800;
    const remainingTime = Math.max(0, minDisplayTime - elapsed);

    setTimeout(() => {
      loadingOverlay.classList.remove('active');
    }, remainingTime);
  } catch(e) {
    loadingOverlay.classList.remove('active');
    if (e.message === 'UNSUPPORTED_FORMAT') {
      showError('Only .ttf .otf .woff .woff2 .cff .pfa .pfb .svg supported', true);
    } else {
      // Show generic error message with bug report details for all other errors
      showError();
    }
  }
}

const KNOWN_FONT_TYPES = new Set(['ttf', 'otf', 'woff', 'woff2', 'pfa', 'pfb', 'cff', 'svg']);

async function parseFont(buf, ext) {
  let bytes = new Uint8Array(buf);
  const extHint = detectContainerExtHint(ext, bytes);
  if (!KNOWN_FONT_TYPES.has(extHint)) {
    throw new Error('Not a supported font file');
  }
  state.ttf = null;
  state.cffFont = null;
  state.type1Font = null;
  state.svgFont = null;
  state.glyphs = [];
  state.selected = new Set();
  state.inputContainer = 'sfnt';
  state.outputFormat = null;
  state.buffer = buf;

  if (extHint === 'svg') {
    state.inputContainer = 'svg';
    state.fontType = 'svg';
    if (!window.SVGFontUtils || typeof window.SVGFontUtils.parseSvgFont !== 'function') {
      throw new Error('SVG support not loaded');
    }
    const svgFont = window.SVGFontUtils.parseSvgFont(bytes);
    state.svgFont = svgFont;
    state.glyphs = enumerateSVGGlyphs(svgFont);
    state.metadata = extractSVGMetadata(svgFont);
    state.canRebuild = true;
    state.outputFormat = 'svg';
  } else if (extHint === 'pfa' || extHint === 'pfb') {
    // Type 1
    state.inputContainer = 'type1';
    state.fontType = 'type1';
    const t1 = new window.Type1Font(bytes);
    t1.parse();
    state.type1Font = t1;
    state.glyphs = enumerateType1Glyphs(t1);
    state.metadata = extractType1Metadata(t1);
    state.canRebuild = true;
    state.outputFormat = (extHint === 'pfb') ? 'pfb' : 'pfa';
  } else if (extHint === 'cff') {
    // Raw CFF (or PS-wrapped CFF)
    state.inputContainer = 'cff';
    state.fontType = 'cff';
    // If PS-wrapped CFF, extract binary data after "StartData\n"
    if (bytes[0] === 0x25 && bytes[1] === 0x21) {
      const marker = 'StartData\n';
      const head = new TextDecoder('ascii', { fatal: false }).decode(bytes.subarray(0, Math.min(1024, bytes.length)));
      const idx = head.indexOf(marker);
      if (idx >= 0) {
        bytes = bytes.subarray(idx + marker.length);
        buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        state.buffer = buf;
      }
    }
    const cff = new window.CFFFont(bytes);
    cff.parse();
    state.cffFont = cff;
    state.glyphs = enumerateCFFGlyphs(cff, null);
    state.metadata = extractCFFMetadata(cff);
    state.canRebuild = true;
  } else {
    // TTF / OTF / WOFF / WOFF2 containers
    let sfntBytes = bytes;
    if (extHint === 'woff') {
      sfntBytes = await decodeWOFFToSfnt(buf);
      state.inputContainer = 'woff';
      state.buffer = sfntBytes.buffer.slice(sfntBytes.byteOffset, sfntBytes.byteOffset + sfntBytes.byteLength);
    } else if (extHint === 'woff2') {
      sfntBytes = await decodeWOFF2ToSfnt(buf);
      state.inputContainer = 'woff2';
      state.buffer = sfntBytes.buffer.slice(sfntBytes.byteOffset, sfntBytes.byteOffset + sfntBytes.byteLength);
    }

    const ttf = new window.TTF(state.buffer);
    ttf.parse();
    state.ttf = ttf;
    if (ttf.isCFF) {
      // OTF with CFF outlines
      state.fontType = 'otf-cff';
      const cffTable = ttf.tables['CFF '];
      ttf.parse();
      if (!cffTable) throw new Error("OTF has no 'CFF ' table");
      const cffBytes = new Uint8Array(state.buffer, cffTable.offset, cffTable.length);
      const cff = new window.CFFFont(cffBytes);
      cff.parse();
      state.cffFont = cff;
      state.glyphs = enumerateCFFGlyphs(cff, ttf);
      state.metadata = extractTTFMetadata(ttf);
      state.canRebuild = true;
    } else {
      // Pure TrueType
      state.fontType = 'ttf';
      state.glyphs = enumerateTTFGlyphs(ttf);
      state.metadata = extractTTFMetadata(ttf);
      state.canRebuild = true;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// GLYPH ENUMERATION
// ═══════════════════════════════════════════════════════════════════

function buildReverseCmapFromTTF(ttf) {
  // glyph ID → first unicode codepoint (prefer lower codepoints)
  const gidToUnicode = new Map();
  const entries = ttf.cmapEntries();
  // Sort by codepoint so BMP entries (lower values) take priority
  entries.sort((a, b) => a.cp - b.cp);
  for (const { cp, gid } of entries) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;
    if (gid > 0 && !gidToUnicode.has(gid)) {
      gidToUnicode.set(gid, cp);
    }
  }
  return gidToUnicode;
}

function findSpaceGlyphTTF(ttf, reverseCmap) {
  // If U+0020 is already in cmap, no need to find one
  for (const [, cp] of reverseCmap) { if (cp === 0x20) return -1; }
  const upm = ttf.unitsPerEm || 1000;
  const targetWidth = upm * 0.25;
  let bestGid = -1, bestScore = Infinity;
  // Check first few unmapped GIDs (space is typically GID 1-3)
  for (let gid = 1; gid <= Math.min(5, ttf.numGlyphs - 1); gid++) {
    if (reverseCmap.has(gid)) continue;
    const m = ttf.hmtx[gid];
    if (!m || m.advanceWidth <= 0) continue;
    const { length } = ttf.glyphRange(gid);
    // Space glyph is typically empty or has a degenerate single-point contour
    if (length > 40) continue;
    const score = Math.abs(m.advanceWidth - targetWidth);
    if (score < bestScore) { bestScore = score; bestGid = gid; }
  }
  return bestGid;
}

function enumerateTTFGlyphs(ttf) {
  const reverseCmap = buildReverseCmapFromTTF(ttf);
  // Ensure U+0020 (space) is mapped — some fonts omit it from cmap
  const spaceGid = findSpaceGlyphTTF(ttf, reverseCmap);
  if (spaceGid > 0) reverseCmap.set(spaceGid, 0x20);
  const glyphs = [];
  for (let id = 0; id < ttf.numGlyphs; id++) {
    const unicode = reverseCmap.get(id) ?? null;
    const chars = unicode != null ? String.fromCodePoint(unicode) : '';
    const name = getGlyphNameFromUnicode(unicode) || (id === 0 ? '.notdef' : `glyph${id}`);
    glyphs.push({ id, name, unicode, chars, glyphType: 'ttf' });
  }
  return glyphs;
}

function enumerateCFFGlyphs(cff, ttf) {
  // Build reverse cmap from TTF if available (for unicode info)
  const reverseCmap = ttf ? buildReverseCmapFromTTF(ttf) : null;
  const glyphs = [];
  const order = cff.glyphOrder || [];
  const count = cff.glyphCount || order.length;
  for (let id = 0; id < count; id++) {
    const name = order[id] || `glyph${id}`;
    let unicode = null;
    // Try glyph name → unicode via AGL
    if (window.glyphNameToUnicode) {
      const u = window.glyphNameToUnicode(name);
      if (u != null) unicode = u.codePointAt ? u.codePointAt(0) : u;
    }
    // Fallback: TTF reverse cmap
    if (unicode == null && reverseCmap) unicode = reverseCmap.get(id) ?? null;
    const chars = unicode != null ? String.fromCodePoint(unicode) : '';
    glyphs.push({ id, name, unicode, chars, glyphType: 'cff' });
  }
  return glyphs;
}

function enumerateType1Glyphs(t1) {
  const encoding = t1.encoding || [];
  const glyphs = [];
  const seenNames = new Set();
  let idx = 0;

  // Build name → unicode from encoding vector
  const nameToUnicode = new Map();
  for (let code = 0; code < 256; code++) {
    const name = encoding[code];
    if (!name || name === '.notdef') continue;
    if (!nameToUnicode.has(name)) {
      let unicode = null;
      if (window.glyphNameToUnicode) {
        const u = window.glyphNameToUnicode(name);
        if (u != null) unicode = typeof u === 'string' ? u.codePointAt(0) : u;
      }
      nameToUnicode.set(name, unicode);
    }
  }

  // .notdef always first (sequential id 0)
  glyphs.push({ id: idx++, name: '.notdef', unicode: null, chars: '', glyphType: 'type1' });
  seenNames.add('.notdef');

  // Encoded glyphs in encoding order
  for (let code = 0; code < 256; code++) {
    const name = encoding[code];
    if (!name || name === '.notdef') continue;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    const unicode = nameToUnicode.get(name) ?? null;
    const chars = unicode != null ? String.fromCodePoint(unicode) : '';
    glyphs.push({ id: idx++, name, unicode, chars, glyphType: 'type1' });
  }

  // Any remaining charstrings not covered by encoding
  if (t1.charStrings) {
    for (const [name] of t1.charStrings) {
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      let unicode = null;
      if (window.glyphNameToUnicode) {
        const u = window.glyphNameToUnicode(name);
        if (u != null) unicode = typeof u === 'string' ? u.codePointAt(0) : u;
      }
      const chars = unicode != null ? String.fromCodePoint(unicode) : '';
      glyphs.push({ id: idx++, name, unicode, chars, glyphType: 'type1' });
    }
  }

  return glyphs;
}

function enumerateSVGGlyphs(svgFont) {
  const source = (svgFont && Array.isArray(svgFont.glyphs)) ? svgFont.glyphs : [];
  return source.map((glyph, id) => ({
    id,
    name: glyph.name || (id === 0 ? '.notdef' : `glyph${id}`),
    unicode: Number.isInteger(glyph.unicode) ? glyph.unicode : null,
    chars: typeof glyph.chars === 'string' ? glyph.chars : (Number.isInteger(glyph.unicode) ? String.fromCodePoint(glyph.unicode) : ''),
    glyphType: 'svg'
  }));
}

function getGlyphNameFromUnicode(unicode) {
  if (unicode == null) return null;
  const ch = String.fromCodePoint(unicode);
  if (window.guessGlyphNameFromChar) return window.guessGlyphNameFromChar(ch);
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// METADATA EXTRACTION
// ═══════════════════════════════════════════════════════════════════

function extractTTFMetadata(ttf) {
  const meta = {
    family: ttf.getFontFamily() || 'Unknown',
    postScript: ttf.getPostScriptName() || '',
    version: '',
    copyright: '',
    license: '',
    licenseUrl: '',
    trademark: '',
    designer: '',
    manufacturer: ''
  };
  if (!ttf.tables['name']) return meta;
  const v = ttf.table('name');
  const buf = ttf.buf;
  const dv = ttf.dv;
  let off = v.byteOffset;
  const count = dv.getUint16(off + 2, false);
  const stringOff = dv.getUint16(off + 4, false);
  off += 6;
  const nameMap = {
    0: 'copyright', 5: 'version', 7: 'trademark',
    8: 'manufacturer', 9: 'designer', 13: 'license', 14: 'licenseUrl'
  };
  for (let i = 0; i < count; i++) {
    const platformID = dv.getUint16(off, false);
    const encodingID = dv.getUint16(off + 2, false);
    const nameID = dv.getUint16(off + 6, false);
    const length = dv.getUint16(off + 8, false);
    const strOffset = dv.getUint16(off + 10, false);
    off += 12;
    const field = nameMap[nameID];
    if (!field) continue;
    if (meta[field]) continue; // already have it
    const dataStart = v.byteOffset + stringOff + strOffset;
    const strData = new Uint8Array(buf, dataStart, length);
    let str = '';
    if (platformID === 3 || (platformID === 0 && encodingID >= 3)) {
      for (let j = 0; j + 1 < strData.length; j += 2)
        str += String.fromCharCode((strData[j] << 8) | strData[j + 1]);
    } else {
      for (let j = 0; j < strData.length; j++) str += String.fromCharCode(strData[j]);
    }
    if (str.trim()) meta[field] = str.trim();
  }
  return meta;
}

function extractCFFMetadata(cff) {
  return {
    family: (cff.glyphOrder && cff.glyphOrder[0]) ? 'CFF Font' : 'Unknown',
    postScript: '',
    version: '',
    copyright: '',
    license: '',
    licenseUrl: '',
    trademark: '',
    designer: '',
    manufacturer: ''
  };
}

function readPostScriptLiteralString(source, openParenIndex) {
  if (typeof source !== 'string' || source[openParenIndex] !== '(') return null;
  let out = '';
  let depth = 1;
  for (let i = openParenIndex + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      if (i + 1 >= source.length) break;
      const next = source[++i];
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === 'b') out += '\b';
      else if (next === 'f') out += '\f';
      else if (next === '\r' || next === '\n') {
        if (next === '\r' && source[i + 1] === '\n') i++;
      } else if (/[0-7]/.test(next)) {
        let oct = next;
        for (let j = 0; j < 2 && i + 1 < source.length && /[0-7]/.test(source[i + 1]); j++) {
          oct += source[++i];
        }
        out += String.fromCharCode(parseInt(oct, 8) & 0xFF);
      } else {
        out += next;
      }
      continue;
    }
    if (ch === '(') {
      depth++;
      out += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) return { value: out, end: i + 1 };
      out += ch;
      continue;
    }
    out += ch;
  }
  return null;
}

function readPostScriptNamedString(source, name) {
  if (typeof source !== 'string' || !name) return '';
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('/' + escapedName + '\\s*\\(', 'i').exec(source);
  if (!match) return '';
  const openParenIndex = match.index + match[0].lastIndexOf('(');
  const parsed = readPostScriptLiteralString(source, openParenIndex);
  return parsed ? parsed.value.trim() : '';
}

function extractType1Metadata(t1) {
  let license = '';
  let licenseUrl = '';
  let copyright = t1.notice || '';

  // Extract license from PostScript comments in the header
  if (t1.bytes) {
    try {
      // Get the cleartext header (before 'currentfile eexec')
      const enc = new TextEncoder();
      const markerBytes = enc.encode('currentfile eexec');
      const markerPos = findByteSubarray(t1.bytes, markerBytes);

      if (markerPos !== -1) {
        const headerBytes = t1.bytes.slice(0, markerPos);
        const headerText = new TextDecoder('latin1').decode(headerBytes);

        // Extract %% License: comment
        const licenseMatch = headerText.match(/%+\s*License:\s*(.+?)(?:\n|$)/i);
        if (licenseMatch) {
          license = licenseMatch[1].trim();
        }

        // Extract %% License URL: comment
        const licenseUrlMatch = headerText.match(/%+\s*License\s+URL:\s*(.+?)(?:\n|$)/i);
        if (licenseUrlMatch) {
          licenseUrl = licenseUrlMatch[1].trim();
        }

        // Extract %% Copyright: comment (prefer this over /Notice if present)
        const copyrightMatch = headerText.match(/%+\s*Copyright:\s*(.+?)(?:\n|$)/i);
        if (copyrightMatch) {
          copyright = copyrightMatch[1].trim();
        }

        // If no %% License: comment, try to extract from /Notice entry
        if (!license) {
          license = readPostScriptNamedString(headerText, 'Notice');
        }

        if (!copyright) {
          copyright = readPostScriptNamedString(headerText, 'Copyright') ||
            readPostScriptNamedString(headerText, 'Notice');
        }
      }
    } catch (e) {
      console.warn('[extractType1Metadata] Error parsing license:', e);
    }
  }

  return {
    family: t1.familyName || 'Type1 Font',
    postScript: t1.fontName || '',
    version: t1.version || '',
    copyright: copyright,
    license: license,
    licenseUrl: licenseUrl,
    trademark: '',
    designer: '',
    manufacturer: ''
  };
}

function extractSVGMetadata(svgFont) {
  const meta = Object.assign({
    family: 'SVG Font',
    postScript: '',
    version: '',
    copyright: '',
    license: '',
    licenseUrl: '',
    trademark: '',
    designer: '',
    manufacturer: ''
  }, (svgFont && svgFont.metadata) || {});
  if (!meta.family) meta.family = (svgFont && svgFont.family) || 'SVG Font';
  if (!meta.postScript) meta.postScript = (svgFont && svgFont.postScriptName) || meta.family || '';
  return meta;
}

function getOutputFormatLabel(fmt) {
  return {
    ttf: 'TTF (.ttf)',
    otf: 'OTF (.otf)',
    woff: 'WOFF (.woff)',
    woff2: 'WOFF2 (.woff2)',
    cff: 'CFF (.cff)',
    pfa: 'PFA (.pfa)',
    pfb: 'PFB (.pfb)',
    svg: 'SVG Font (.svg)'
  }[fmt] || (fmt || 'Unknown');
}

let _woff2ExportSupport = null;
function supportsWoff2Export() {
  if (_woff2ExportSupport != null) return _woff2ExportSupport;

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    _woff2ExportSupport = true;
    return _woff2ExportSupport;
  }

  if (typeof require !== 'undefined') {
    try {
      const mod = require('fonteditor-core');
      if (mod && mod.woff2 && typeof mod.woff2.init === 'function') {
        _woff2ExportSupport = true;
        return _woff2ExportSupport;
      }
    } catch (_) {
      try {
        const zlib = require('zlib');
        _woff2ExportSupport = !!(zlib && typeof zlib.brotliCompress === 'function');
      } catch (_) {
        _woff2ExportSupport = false;
      }
    }
  } else {
    _woff2ExportSupport = false;
  }

  return _woff2ExportSupport;
}

function getAvailableOutputFormats() {
  const allowWoff2 = supportsWoff2Export();
  switch (state.fontType) {
    case 'ttf':
      return ['ttf', 'otf', 'woff', ...(allowWoff2 ? ['woff2'] : []), 'cff', 'pfa', 'pfb', 'svg'];
    case 'otf-cff':
      return ['ttf', 'otf', 'woff', ...(allowWoff2 ? ['woff2'] : []), 'cff', 'pfa', 'pfb', 'svg'];
    case 'cff':
      return ['ttf', 'cff', 'otf', 'woff', ...(allowWoff2 ? ['woff2'] : []), 'pfa', 'pfb', 'svg'];
    case 'type1':
      return ['ttf', 'pfa', 'pfb', 'cff', 'otf', 'woff', ...(allowWoff2 ? ['woff2'] : []), 'svg'];
    case 'svg':
      return ['svg', 'ttf', 'otf', 'woff', ...(allowWoff2 ? ['woff2'] : []), 'cff', 'pfa', 'pfb'];
    default:
      return [];
  }
}

function getDefaultOutputFormatForState() {
  if (state.fontType === 'ttf') {
    // Prefer the same container as the input when possible
    if (state.inputContainer === 'woff2' && supportsWoff2Export()) return 'woff2';
    if (state.inputContainer === 'woff') return 'woff';
    return 'ttf';
  }
  if (state.fontType === 'otf-cff') {
    if (state.inputContainer === 'woff2' && supportsWoff2Export()) return 'woff2';
    if (state.inputContainer === 'woff') return 'woff';
    return 'otf';
  }
  if (state.fontType === 'cff') return 'cff';
  if (state.fontType === 'type1') return state.outputFormat === 'pfb' ? 'pfb' : 'pfa';
  if (state.fontType === 'svg') return 'svg';
  return null;
}

// The shared export engine is loaded after this UI module. Keep this narrow
// bridge explicit rather than relying on functions nested in the page setup
// block becoming global names.
window.KeyfontUI = window.KeyfontUI || {};
window.KeyfontUI.getAvailableOutputFormats = getAvailableOutputFormats;
window.KeyfontUI.getDefaultOutputFormatForState = getDefaultOutputFormatForState;

function refreshSaveAsUI() {
  const wrap = document.getElementById('saveas-wrap');
  const select = document.getElementById('save-as');
  const formats = getAvailableOutputFormats();

  if (!formats.length) {
    wrap.setAttribute('hidden', '');
    return;
  }

  const allowed = new Set(formats);
  const fallback = getDefaultOutputFormatForState();

  // Prefer state.outputFormat if it was pre-set (e.g., from conversion page)
  // Otherwise use fallback logic
  let selected;
  if (state.outputFormat && allowed.has(state.outputFormat)) {
    selected = state.outputFormat;
  } else if (allowed.has(fallback)) {
    selected = fallback;
  } else {
    selected = formats[0];
  }

  state.outputFormat = selected;

  select.innerHTML = '';
  for (const fmt of formats) {
    const option = document.createElement('option');
    option.value = fmt;
    option.textContent = getOutputFormatLabel(fmt);
    select.appendChild(option);
  }
  select.value = selected;
  wrap.removeAttribute('hidden');
}

// ═══════════════════════════════════════════════════════════════════
// UI RENDERING
// ═══════════════════════════════════════════════════════════════════
function renderUI() {
  const m = state.metadata;
  const glyphs = state.glyphs;

  // Update font info
  document.getElementById('fi-family').textContent = m.family || 'Unknown Font';

  // Build font type badge that includes container format
  let typeBadge = '';
  if (state.inputContainer === 'woff') {
    typeBadge = state.fontType === 'otf-cff'
      ? 'OpenType CFF in WOFF (.woff)'
      : 'TrueType in WOFF (.woff)';
  } else if (state.inputContainer === 'woff2') {
    typeBadge = state.fontType === 'otf-cff'
      ? 'OpenType CFF in WOFF2 (.woff2)'
      : 'TrueType in WOFF2 (.woff2)';
  } else {
    typeBadge = {
      ttf: 'TrueType (.ttf)',
      'otf-cff': 'OpenType CFF (.otf)',
      cff: 'CFF (.cff)',
      type1: 'Type 1 (.pfa/.pfb)',
      svg: 'SVG Font (.svg)'
    }[state.fontType] || state.fontType;
  }
  document.getElementById('fi-type-badge').textContent = typeBadge;
  document.getElementById('fi-count').textContent = glyphs.length;
  document.getElementById('fi-version').textContent = m.version || '—';
  document.getElementById('fi-ps-name').textContent = m.postScript || '—';
  document.getElementById('fi-copyright').textContent = (m.copyright || '').substring(0, 80) + (m.copyright && m.copyright.length > 80 ? '…' : '') || '—';

  const licenseBox = document.getElementById('license-box');
  if (m.license) {
    document.getElementById('fi-license').textContent = m.license;
    licenseBox.removeAttribute('hidden');
  } else {
    licenseBox.setAttribute('hidden', '');
  }

  document.getElementById('font-name-badge').textContent = m.family || state.file.name;

  // Show/hide sections
  document.getElementById('drop-zone').setAttribute('hidden', '');
  document.getElementById('font-info').removeAttribute('hidden');
  document.getElementById('controls').removeAttribute('hidden');
  document.getElementById('stats-bar').removeAttribute('hidden');
  document.getElementById('glyph-grid').removeAttribute('hidden');
  document.getElementById('font-preview-panel').removeAttribute('hidden');
  document.getElementById('export-panel').removeAttribute('hidden');
  document.getElementById('header-controls').removeAttribute('hidden');
  document.getElementById('header-controls').style.display = 'flex';

  document.getElementById('rebuild-note').textContent = '';
  const stripInput = document.getElementById('strip-text-input');
  if (stripInput) stripInput.value = '';
  refreshSaveAsUI();

  // Apply font to preview
  applyFontToPreview();

  // C0/C1 control-code mappings are commonly empty compatibility slots.
  // Keep them available, but do not include them in the initial subset.
  state.selected = new Set(glyphs
    .filter(g => !isControlCodeGlyph(g))
    .map(g => g.id));
  if (glyphs.some(g => g.id === 0)) state.selected.add(0);

  // Reset display limit for new font
  state.glyphsDisplayLimit = 500;

  setupIntersectionObserver();
  renderGrid();
  updateStats();
}

function resetFont() {
  state.file = null;
  state.originalBuffer = null;
  state.buffer = null;
  state.inputContainer = 'sfnt';
  state.ttf = null;
  state.cffFont = null;
  state.type1Font = null;
  state.svgFont = null;
  state.glyphs = [];
  state.selected = new Set();
  state.lastClickedIdx = null;
  state.contextGlyphId = null;
  hideGlyphContextMenu();

  document.getElementById('drop-zone').removeAttribute('hidden');
  document.getElementById('font-info').setAttribute('hidden', '');
  document.getElementById('controls').setAttribute('hidden', '');
  document.getElementById('stats-bar').setAttribute('hidden', '');
  document.getElementById('glyph-grid').setAttribute('hidden', '');
  document.getElementById('font-preview-panel').setAttribute('hidden', '');
  document.getElementById('export-panel').setAttribute('hidden', '');
  document.getElementById('header-controls').setAttribute('hidden', '');
  document.getElementById('load-more-container').setAttribute('hidden', '');
  document.getElementById('glyph-grid').innerHTML = '';
  const stripInput = document.getElementById('strip-text-input');
  if (stripInput) stripInput.value = '';
  document.getElementById('saveas-wrap').setAttribute('hidden', '');
  const saveAs = document.getElementById('save-as');
  if (saveAs) saveAs.innerHTML = '<option value="">Select format</option>';
}
window.resetFont = resetFont;

function applyFontToPreview() {
  if (!state.originalBuffer) return;

  let fontBuffer;
  let mimeType = 'font/ttf';

  // Type1 and SVG fonts need a browser-supported wrapper for preview.
  if (state.fontType === 'type1' || state.fontType === 'svg') {
    try {
      // Build OTF from vector glyph records for preview.
      const base = state.file?.name?.replace(/\.[^.]+$/, '') || 'Preview';
      const { records, cmapPairs } = buildGlyphRecordsFromKeepIds(
        new Set(state.glyphs.map(g => g.id))
      );
      fontBuffer = buildOTFCFFFromGlyphRecords(
        records,
        cmapPairs,
        state.metadata.family || base,
        state.metadata.postScript || base
      );
      mimeType = 'font/otf';
    } catch (e) {
      console.error(`Failed to convert ${state.fontType} to OTF for preview:`, e);
      return;
    }
  } else if (state.fontType === 'cff') {
    // Standalone CFF also needs conversion
    try {
      const base = state.file?.name?.replace(/\.[^.]+$/, '') || 'Preview';
      const { records, cmapPairs } = buildGlyphRecordsFromKeepIds(
        new Set(state.glyphs.map(g => g.id))
      );
      fontBuffer = buildOTFCFFFromGlyphRecords(
        records,
        cmapPairs,
        state.metadata.family || base,
        state.metadata.postScript || base
      );
      mimeType = 'font/otf';
    } catch (e) {
      console.error('Failed to convert CFF to OTF for preview:', e);
      return;
    }
  } else {
    // For WOFF/WOFF2, use the decoded SFNT data from state.buffer
    // (state.originalBuffer still contains the compressed data which browsers can't load via blob)
    if (state.inputContainer === 'woff' || state.inputContainer === 'woff2') {
      fontBuffer = state.buffer;
      // Set mime type based on font type, not container
      mimeType = state.fontType === 'otf-cff' ? 'font/otf' : 'font/ttf';
    } else {
      // TTF/OTF can be used directly
      fontBuffer = state.originalBuffer;
      mimeType = state.fontType === 'otf-cff' ? 'font/otf' : 'font/ttf';
    }
  }

  // Create a data URL from the font buffer
  const bytes = new Uint8Array(fontBuffer);
  const blob = new Blob([bytes], { type: mimeType });
  const fontUrl = URL.createObjectURL(blob);

  // Create a unique font-family name
  const fontFamily = 'PreviewFont_' + Date.now();

  // Create and inject a @font-face rule
  const styleId = 'font-preview-style';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = `
    @font-face {
      font-family: '${fontFamily}';
      src: url('${fontUrl}');
    }
  `;

  // Apply the font to the preview textarea
  const previewEl = document.getElementById('font-preview-text');
  if (previewEl) {
    previewEl.style.fontFamily = `'${fontFamily}', monospace`;
  }
}

// ─── GRID ───

let _observer = null;
function setupIntersectionObserver() {
  if (_observer) _observer.disconnect();
  _observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const card = e.target;
        if (card.dataset.rendered) continue;
        card.dataset.rendered = '1';
        renderCardGlyph(card);
        _observer.unobserve(card);
      }
    }
  }, { rootMargin: '300px' });

  for (const card of document.querySelectorAll('.glyph-card:not([data-rendered])')) {
    _observer.observe(card);
  }
}

function getFilteredGlyphs() {
  const q = state.searchQuery.trim().toLowerCase();
  const glyphs = q ? state.glyphs.filter(g => {
    if (g.name && g.name.toLowerCase().includes(q)) return true;
    if (g.chars && g.chars.toLowerCase().includes(q)) return true;
    if (g.unicode != null) {
      const hex = 'u+' + g.unicode.toString(16).padStart(4, '0');
      if (hex.includes(q)) return true;
      if (('u+' + g.unicode.toString(16)).includes(q)) return true;
    }
    if (String(g.id).includes(q)) return true;
    return false;
  }) : state.glyphs;

  // .notdef stays first. Normal glyphs follow, while empty-prone control
  // slots move to the end. This only affects display order, never GIDs.
  return glyphs.slice().sort((a, b) => {
    const rank = glyph => glyph.id === 0 ? 0 : isControlCodeGlyph(glyph) ? 2 : 1;
    return rank(a) - rank(b) || a.id - b.id;
  });
}

function isControlCodeGlyph(glyph) {
  const cp = glyph && glyph.unicode;
  return Number.isInteger(cp) && (cp <= 0x1F || (cp >= 0x7F && cp <= 0x9F));
}

function renderGrid() {
  const grid = document.getElementById('glyph-grid');
  grid.innerHTML = '';
  const filtered = getFilteredGlyphs();

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="loading-msg">No glyphs match your search.</div>';
    updateLoadMoreButton(0, 0);
    return;
  }

  const displayCount = Math.min(filtered.length, state.glyphsDisplayLimit);
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < displayCount; i++) {
    const g = filtered[i];
    const card = document.createElement('div');
    card.className = 'glyph-card' + (state.selected.has(g.id) ? ' selected' : '');
    card.dataset.gid = g.id;
    card.dataset.idx = i;
    card.dataset.glyphType = g.glyphType;

    card.innerHTML = `
      <div class="glyph-canvas-wrap pending">
        <canvas width="128" height="128"></canvas>
      </div>
      <div class="glyph-info">
        <div class="glyph-char">${escapeHtml(g.chars || ' ')}</div>
        <div class="glyph-name">${escapeHtml(g.name)}</div>
        <div class="glyph-id">${g.unicode != null ? 'U+' + g.unicode.toString(16).toUpperCase().padStart(4,'0') : '#' + g.id}</div>
      </div>
      <div class="glyph-check">✓</div>
    `;

    card.addEventListener('click', e => onCardClick(e, card, i));
    card.addEventListener('contextmenu', e => onGlyphContextMenu(e, card));
    fragment.appendChild(card);

    if (_observer) _observer.observe(card);
  }

  grid.appendChild(fragment);
  updateLoadMoreButton(displayCount, filtered.length);
}

function updateLoadMoreButton(displayed, total) {
  const container = document.getElementById('load-more-container');
  const btn = document.getElementById('load-more-btn');

  if (displayed < total) {
    container.removeAttribute('hidden');
    btn.textContent = 'Load More Glyphs';
  } else {
    container.setAttribute('hidden', '');
  }
}

function loadMoreGlyphs() {
  state.glyphsDisplayLimit += 500;
  renderGrid();
  updateStats();
  // Re-trigger intersection observer for new cards
  for (const card of document.querySelectorAll('.glyph-card:not([data-rendered])')) {
    if (_observer) _observer.observe(card);
  }
}

function showAllGlyphs() {
  state.glyphsDisplayLimit = Infinity;
  renderGrid();
  updateStats();
  // Re-trigger intersection observer for new cards
  for (const card of document.querySelectorAll('.glyph-card:not([data-rendered])')) {
    if (_observer) _observer.observe(card);
  }
}

function renderCardGlyph(card) {
  const gid = parseInt(card.dataset.gid);
  const glyphType = card.dataset.glyphType;
  const wrap = card.querySelector('.glyph-canvas-wrap');
  const canvas = card.querySelector('canvas');
  const glyphObj = state.glyphs.find(x => x.id === gid) || null;

  wrap.classList.remove('pending');

  let rendered = false;
  const previewMetrics = getGlyphPreviewMetrics();
  try {
    const openTypeSvg = state.ttf && typeof state.ttf.getOpenTypeSvgDocument === 'function'
      ? state.ttf.getOpenTypeSvgDocument(gid)
      : null;
    if (openTypeSvg) {
      let svgMarkup = new TextDecoder().decode(openTypeSvg);
      // OpenType-SVG glyph documents often omit width, height, and viewBox
      // because the font renderer supplies the glyph coordinate system. An
      // <img> preview does not, so provide this glyph's coordinate system.
      if (!/\bviewBox\s*=/i.test(svgMarkup)) {
        const unitsPerEm = Number.isFinite(state.ttf.unitsPerEm) ? state.ttf.unitsPerEm : 1000;
        const advanceWidth = state.ttf.hmtx && state.ttf.hmtx[gid] && state.ttf.hmtx[gid].advanceWidth;
        let xMin = 0;
        let yMin = -unitsPerEm;
        let width = Number.isFinite(advanceWidth) && advanceWidth > 0 ? advanceWidth : unitsPerEm;
        let height = unitsPerEm;
        // Animated OpenType SVG fonts commonly embed a bitmap/GIF and state
        // its actual box explicitly. Use that box instead of the text advance.
        const imageMatch = svgMarkup.match(/<image\b[^>]*>/i);
        if (imageMatch) {
          const widthMatch = imageMatch[0].match(/\bwidth=["']([\d.]+)["']/i);
          const heightMatch = imageMatch[0].match(/\bheight=["']([\d.]+)["']/i);
          width = Math.max(1, Number(widthMatch && widthMatch[1]) || width);
          height = Math.max(1, Number(heightMatch && heightMatch[1]) || height);
          const translateMatch = imageMatch[0].match(/translate\(\s*[-\d.]+[\s,]+([-\d.]+)\s*\)/i);
          yMin = translateMatch ? Number(translateMatch[1]) || -height : -height;
        }
        svgMarkup = svgMarkup.replace(/<svg\b([^>]*)>/i,
          `<svg$1 viewBox="${xMin} ${yMin} ${width} ${height}" preserveAspectRatio="xMidYMid meet">`);
      }
      const image = document.createElement('img');
      image.className = 'glyph-svg-preview';
      image.alt = glyphObj && glyphObj.chars ? glyphObj.chars : 'SVG glyph';
      image.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain';
      image.src = URL.createObjectURL(new Blob([svgMarkup], { type: 'image/svg+xml' }));
      canvas.hidden = true;
      wrap.appendChild(image);
      rendered = true;
    } else if (glyphType === 'ttf') {
      const g = state.ttf.loadGlyph(gid);
      if (g && g.contours && g.contours.length > 0) {
        renderTTFContours(canvas, g.contours, previewMetrics);
        rendered = true;
      }
    } else if (glyphType === 'cff') {
      const g = state.cffFont.loadGlyphByIndex(gid);
      if (g && g.path && g.path.length > 0) {
        renderPathGlyph(canvas, g.path, previewMetrics);
        rendered = true;
      }
    } else if (glyphType === 'type1') {
      if (glyphObj) {
        const g = state.type1Font.loadGlyphByName(glyphObj.name);
        if (g && g.path && g.path.length > 0) {
          renderPathGlyph(canvas, g.path, previewMetrics);
          rendered = true;
        }
      }
    } else if (glyphType === 'svg') {
      const g = state.svgFont && Array.isArray(state.svgFont.glyphs) ? state.svgFont.glyphs[gid] : null;
      if (g && Array.isArray(g.path) && g.path.length > 0) {
        renderPathGlyph(canvas, g.path, previewMetrics);
        rendered = true;
      }
    }
  } catch(e) {
    // silently ignore render errors
  }

  if (!rendered) {
    renderMissingGlyphPlaceholder(canvas);
    wrap.classList.add('empty-glyph');
    wrap.style.background = '';
  } else {
    wrap.classList.remove('empty-glyph');
  }
}

// ─── GLYPH RENDERERS ───

function getGlyphPreviewMetrics() {
  const fallbackUpm = 1000;
  if (state.fontType === 'ttf' && state.ttf) {
    const upm = state.ttf.unitsPerEm || fallbackUpm;
    const yMax = Number.isFinite(state.ttf.ascender) && state.ttf.ascender !== 0 ? state.ttf.ascender : ((state.ttf.yMax || upm * 0.8));
    const yMin = Number.isFinite(state.ttf.descender) && state.ttf.descender !== 0 ? state.ttf.descender : ((state.ttf.yMin || -upm * 0.2));
    const xMin = Number.isFinite(state.ttf.xMin) ? state.ttf.xMin : 0;
    const xMax = Number.isFinite(state.ttf.xMax) ? state.ttf.xMax : upm;
    return { upm, xMin, xMax, yMin, yMax };
  }
  if ((state.fontType === 'otf-cff' || state.fontType === 'cff') && state.ttf) {
    const upm = state.ttf.unitsPerEm || fallbackUpm;
    const yMax = Number.isFinite(state.ttf.ascender) && state.ttf.ascender !== 0 ? state.ttf.ascender : ((state.ttf.yMax || upm * 0.8));
    const yMin = Number.isFinite(state.ttf.descender) && state.ttf.descender !== 0 ? state.ttf.descender : ((state.ttf.yMin || -upm * 0.2));
    const xMin = Number.isFinite(state.ttf.xMin) ? state.ttf.xMin : 0;
    const xMax = Number.isFinite(state.ttf.xMax) ? state.ttf.xMax : upm;
    return { upm, xMin, xMax, yMin, yMax };
  }
  if (state.fontType === 'type1' && state.type1Font) {
    const upm = state.type1Font.unitsPerEm || fallbackUpm;
    const bbox = Array.isArray(state.type1Font.fontBBox) && state.type1Font.fontBBox.length >= 4
      ? state.type1Font.fontBBox
      : [-50, -200, upm, upm * 0.8];
    return { upm, xMin: Number(bbox[0]) || 0, yMin: Number(bbox[1]) || -upm * 0.2, xMax: Number(bbox[2]) || upm, yMax: Number(bbox[3]) || upm * 0.8 };
  }
  if (state.fontType === 'svg' && state.svgFont) {
    const upm = state.svgFont.unitsPerEm || fallbackUpm;
    const bbox = Array.isArray(state.svgFont.bbox) && state.svgFont.bbox.length >= 4
      ? state.svgFont.bbox
      : [0, state.svgFont.descent || -upm * 0.2, upm, state.svgFont.ascent || upm * 0.8];
    return {
      upm,
      xMin: Number(bbox[0]) || 0,
      yMin: Number.isFinite(state.svgFont.descent) ? state.svgFont.descent : (Number(bbox[1]) || -upm * 0.2),
      xMax: Number(bbox[2]) || upm,
      yMax: Number.isFinite(state.svgFont.ascent) ? state.svgFont.ascent : (Number(bbox[3]) || upm * 0.8)
    };
  }
  const upm = (state.cffFont && state.cffFont.unitsPerEm) || fallbackUpm;
  return { upm, xMin: 0, xMax: upm, yMin: -upm * 0.2, yMax: upm * 0.8 };
}

function getContourBounds(contours) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const pts of contours || []) {
    for (const p of pts || []) {
      if (p.x < xmin) xmin = p.x;
      if (p.x > xmax) xmax = p.x;
      if (p.y < ymin) ymin = p.y;
      if (p.y > ymax) ymax = p.y;
    }
  }
  if (!isFinite(xmin)) return null;
  return { xmin, ymin, xmax, ymax };
}

function getPathBounds(path) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  function upd(x, y) {
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  for (const s of path || []) {
    if (s.cmd === 'M' || s.cmd === 'L') upd(s.x, s.y);
    else if (s.cmd === 'C') { upd(s.x1,s.y1); upd(s.x2,s.y2); upd(s.x3,s.y3); }
  }
  if (!isFinite(xmin)) return null;
  return { xmin, ymin, xmax, ymax };
}

function computeGlyphPreviewTransform(canvas, glyphBounds, metrics) {
  if (!glyphBounds) return null;
  const w = canvas.width, h = canvas.height;
  const pad = Math.max(10, Math.min(w, h) * 0.12);
  const metricXMin = Number.isFinite(metrics && metrics.xMin) ? metrics.xMin : 0;
  const metricXMax = Number.isFinite(metrics && metrics.xMax) ? metrics.xMax : ((metrics && metrics.upm) || 1000);
  const metricYMin = Number.isFinite(metrics && metrics.yMin) ? metrics.yMin : -200;
  const metricYMax = Number.isFinite(metrics && metrics.yMax) ? metrics.yMax : 800;
  const fitYMin = Math.min(metricYMin, glyphBounds.ymin);
  const fitYMax = Math.max(metricYMax, glyphBounds.ymax);
  const fitHeight = Math.max(1, fitYMax - fitYMin);
  const glyphWidth = Math.max(1, glyphBounds.xmax - glyphBounds.xmin);
  let scale = (h - pad * 2) / fitHeight;
  if (glyphWidth * scale > (w - pad * 2)) {
    scale = (w - pad * 2) / glyphWidth;
  }
  const usedHeight = fitHeight * scale;
  const verticalPad = (h - usedHeight) / 2;
  const ox = (w - glyphWidth * scale) / 2 - glyphBounds.xmin * scale;
  const oy = verticalPad + fitYMax * scale;
  return {
    tx: x => ox + x * scale,
    ty: y => oy - y * scale
  };
}

function renderTTFContours(canvas, contours, metrics = null) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Enable high-quality anti-aliasing
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const bounds = getContourBounds(contours);
  const transform = computeGlyphPreviewTransform(canvas, bounds, metrics);
  if (!transform) return;
  const tx = transform.tx;
  const ty = transform.ty;

  ctx.fillStyle = '#000';
  ctx.beginPath();

  for (const pts of contours) {
    if (!pts.length) continue;
    const n = pts.length;

    // Find first on-curve point
    let si = 0;
    for (let i = 0; i < n; i++) { if (pts[i].on) { si = i; break; } }

    const p0 = pts[si];
    if (p0.on) {
      ctx.moveTo(tx(p0.x), ty(p0.y));
    } else {
      const prev = pts[(si - 1 + n) % n];
      ctx.moveTo(tx((p0.x + prev.x) / 2), ty((p0.y + prev.y) / 2));
    }

    // When all points are off-curve, iterate from 0..n-1 so every point is
    // used as a control point exactly once and the path ends at the start.
    // When the start point (p0) is on-curve, iterate from 1..n as before.
    const loopStart = p0.on ? 1 : 0;
    const loopEnd = p0.on ? n : n - 1;
    for (let i = loopStart; i <= loopEnd; i++) {
      const cur = pts[(si + i) % n];
      const prv = pts[(si + i - 1 + n) % n];
      if (cur.on) {
        if (prv.on) {
          ctx.lineTo(tx(cur.x), ty(cur.y));
        } else {
          ctx.quadraticCurveTo(tx(prv.x), ty(prv.y), tx(cur.x), ty(cur.y));
        }
      } else {
        const nxt = pts[(si + i + 1) % n];
        if (!nxt.on) {
          const mx = (cur.x + nxt.x) / 2;
          const my = (cur.y + nxt.y) / 2;
          ctx.quadraticCurveTo(tx(cur.x), ty(cur.y), tx(mx), ty(my));
        }
        // else: handled next iteration
      }
    }
    ctx.closePath();
  }

  // TrueType uses nonzero winding rule
  ctx.fill('nonzero');
}

function renderPathGlyph(canvas, path, metrics = null) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!path || !path.length) return;

  // Enable high-quality anti-aliasing
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const bounds = getPathBounds(path);
  const transform = computeGlyphPreviewTransform(canvas, bounds, metrics);
  if (!transform) return;
  const tx = transform.tx;
  const ty = transform.ty;

  ctx.fillStyle = '#000';
  ctx.beginPath();
  for (const s of path) {
    if (s.cmd === 'M') ctx.moveTo(tx(s.x), ty(s.y));
    else if (s.cmd === 'L') ctx.lineTo(tx(s.x), ty(s.y));
    else if (s.cmd === 'C') ctx.bezierCurveTo(tx(s.x1), ty(s.y1), tx(s.x2), ty(s.y2), tx(s.x3), ty(s.y3));
    else if (s.cmd === 'Z') ctx.closePath();
  }
  // Use nonzero winding rule for consistency
  ctx.fill('nonzero');
}

function renderFallbackTextGlyph(canvas, ch) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!ch) return;
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `56px serif`;
  ctx.fillText(ch, w / 2, h / 2 + 2);
}

function renderMissingGlyphPlaceholder(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#8b8fa3';
  ctx.lineWidth = 2;
  const pad = 14;
  ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);
}

function getGlyphRecordById(gid) {
  return state.glyphs.find(g => g.id === gid) || null;
}

function cloneGlyphPath(path) {
  return (path || []).map(seg =>
    window.SVGFontUtils && window.SVGFontUtils.cloneSegment
      ? window.SVGFontUtils.cloneSegment(seg)
      : { ...seg }
  );
}

function getGlyphExportData(gid) {
  const glyph = getGlyphRecordById(gid);
  if (!glyph) return null;
  const metrics = getGlyphPreviewMetrics();
  if (glyph.glyphType === 'ttf') {
    const g = state.ttf && state.ttf.loadGlyph ? state.ttf.loadGlyph(gid) : null;
    const contours = (g && g.contours) || [];
    return {
      glyph,
      glyphType: 'ttf',
      metrics,
      contours,
      path: pathToCubic(ttfContoursToQuadraticPath(contours))
    };
  }
  if (glyph.glyphType === 'cff') {
    const g = state.cffFont && state.cffFont.loadGlyphByIndex ? state.cffFont.loadGlyphByIndex(gid) : null;
    return {
      glyph,
      glyphType: 'cff',
      metrics,
      contours: null,
      path: pathToCubic((g && g.path) || [])
    };
  }
  if (glyph.glyphType === 'type1') {
    const g = state.type1Font && state.type1Font.loadGlyphByName ? state.type1Font.loadGlyphByName(glyph.name) : null;
    return {
      glyph,
      glyphType: 'type1',
      metrics,
      contours: null,
      path: pathToCubic((g && g.path) || [])
    };
  }
  if (glyph.glyphType === 'svg') {
    const g = state.svgFont && Array.isArray(state.svgFont.glyphs) ? state.svgFont.glyphs[gid] : null;
    return {
      glyph,
      glyphType: 'svg',
      metrics,
      contours: null,
      path: cloneGlyphPath((g && g.path) || [])
    };
  }
  return null;
}

function getGlyphContextLabel(glyph) {
  if (!glyph) return 'Glyph';
  const parts = [];
  if (glyph.chars) parts.push(glyph.chars);
  if (glyph.name) parts.push(glyph.name);
  if (glyph.unicode != null) parts.push('U+' + glyph.unicode.toString(16).toUpperCase().padStart(4, '0'));
  if (!parts.length) parts.push('#' + glyph.id);
  return parts.join(' · ');
}

function buildGlyphExportFilename(glyph, ext) {
  const fontBase = sanitizePostScriptName(state.metadata.postScript || state.metadata.family || 'Font', 'Font');
  const glyphPart = glyph && glyph.name
    ? sanitizePostScriptName(glyph.name, 'glyph' + (glyph ? glyph.id : ''))
    : (glyph && glyph.unicode != null ? 'U' + glyph.unicode.toString(16).toUpperCase().padStart(4, '0') : 'glyph' + (glyph ? glyph.id : '0'));
  return `${fontBase}_${glyphPart}.${ext}`;
}

function escapeSvgText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildStandaloneGlyphSvg(path, metrics, size = 1024) {
  const bounds = getPathBounds(path);
  if (!bounds) throw new Error('This glyph has no outline to export as SVG');
  const transform = computeGlyphPreviewTransform({ width: size, height: size }, bounds, metrics);
  if (!transform) throw new Error('This glyph has no outline to export as SVG');
  const mapped = [];
  for (const seg of path || []) {
    if (seg.cmd === 'M' || seg.cmd === 'L') {
      mapped.push({ cmd: seg.cmd, x: transform.tx(seg.x), y: transform.ty(seg.y) });
    } else if (seg.cmd === 'C') {
      mapped.push({
        cmd: 'C',
        x1: transform.tx(seg.x1), y1: transform.ty(seg.y1),
        x2: transform.tx(seg.x2), y2: transform.ty(seg.y2),
        x3: transform.tx(seg.x3), y3: transform.ty(seg.y3)
      });
    } else if (seg.cmd === 'Z') {
      mapped.push({ cmd: 'Z' });
    }
  }
  const d = window.SVGFontUtils && window.SVGFontUtils.cubicPathToSvgPath
    ? window.SVGFontUtils.cubicPathToSvgPath(mapped)
    : '';
  if (!d) throw new Error('This glyph has no outline to export as SVG');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">\n` +
    `  <path d="${escapeSvgText(d)}" fill="#000" fill-rule="nonzero"/>\n` +
    `</svg>\n`
  );
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function hideGlyphContextMenu() {
  state.contextGlyphId = null;
  const menu = document.getElementById('glyph-context-menu');
  if (menu) menu.setAttribute('hidden', '');
}

function onGlyphContextMenu(e, card) {
  e.preventDefault();
  e.stopPropagation();
  const gid = parseInt(card.dataset.gid);
  const glyph = getGlyphRecordById(gid);
  const menu = document.getElementById('glyph-context-menu');
  const title = document.getElementById('glyph-context-title');
  if (!menu || !glyph || !title) return;
  state.contextGlyphId = gid;
  title.textContent = getGlyphContextLabel(glyph);
  menu.removeAttribute('hidden');
  const rect = menu.getBoundingClientRect();
  const left = Math.min(e.clientX, window.innerWidth - rect.width - 12);
  const top = Math.min(e.clientY, window.innerHeight - rect.height - 12);
  menu.style.left = Math.max(12, left) + 'px';
  menu.style.top = Math.max(12, top) + 'px';
}

async function exportContextGlyphAs(format) {
  const gid = state.contextGlyphId;
  hideGlyphContextMenu();
  if (gid == null) return;
  const data = getGlyphExportData(gid);
  if (!data) return;
  const filename = buildGlyphExportFilename(data.glyph, format);

  try {
    if (format === 'png') {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      if (data.glyphType === 'ttf' && data.contours && data.contours.length) {
        renderTTFContours(canvas, data.contours, data.metrics);
      } else if (data.path && data.path.length) {
        renderPathGlyph(canvas, data.path, data.metrics);
      } else {
        renderMissingGlyphPlaceholder(canvas);
      }
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Failed to export glyph as PNG');
      downloadBlob(blob, filename);
      return;
    }

    if (format === 'svg') {
      const svgText = buildStandaloneGlyphSvg(data.path, data.metrics);
      downloadBytes(new TextEncoder().encode(svgText), filename, 'image/svg+xml');
    }
  } catch (e) {
    showError(e && e.message ? e.message : 'Failed to export glyph');
    console.error(e);
  }
}
window.exportContextGlyphAs = exportContextGlyphAs;

// ─── SELECTION ───

function onCardClick(e, card, visibleIdx) {
  const gid = parseInt(card.dataset.gid);

  if (e.shiftKey && state.lastClickedIdx != null) {
    // Range select
    const filtered = getFilteredGlyphs();
    const lo = Math.min(state.lastClickedIdx, visibleIdx);
    const hi = Math.max(state.lastClickedIdx, visibleIdx);
    const isSelecting = state.selected.has(gid) ? false : true;
    for (let i = lo; i <= hi; i++) {
      const id = filtered[i]?.id;
      if (id == null) continue;
      if (isSelecting) state.selected.add(id);
      else state.selected.delete(id);
    }
  } else {
    if (state.selected.has(gid)) state.selected.delete(gid);
    else state.selected.add(gid);
    state.lastClickedIdx = visibleIdx;
  }

  refreshCardStates();
  updateStats();
}

function refreshCardStates() {
  for (const card of document.querySelectorAll('.glyph-card')) {
    const gid = parseInt(card.dataset.gid);
    card.classList.toggle('selected', state.selected.has(gid));
  }
}

function selectAll() {
  const filtered = getFilteredGlyphs();
  for (const g of filtered) state.selected.add(g.id);
  refreshCardStates();
  updateStats();
}

function selectNone() {
  const filtered = getFilteredGlyphs();
  for (const g of filtered) state.selected.delete(g.id);
  refreshCardStates();
  updateStats();
}

function toggleGlyphPreviews(show) {
  if (show) {
    document.body.classList.remove('hide-previews');
  } else {
    document.body.classList.add('hide-previews');
  }
}
window.toggleGlyphPreviews = toggleGlyphPreviews;

function quickSelect(preset) {
  const ranges = {
    ascii: [[0x0020, 0x007E]],
    latin: [[0x0080, 0x024F]],
    upper: [[0x0041, 0x005A]],
    lower: [[0x0061, 0x007A]],
    digits: [[0x0030, 0x0039]]
  };
  const r = ranges[preset];
  if (!r) return;
  for (const g of state.glyphs) {
    if (g.unicode == null) continue;
    for (const [lo, hi] of r) {
      if (g.unicode >= lo && g.unicode <= hi) {
        state.selected.add(g.id);
        break;
      }
    }
  }
  refreshCardStates();
  updateStats();
}

function iterateCodePoints(text, cb) {
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    cb(cp);
    if (cp > 0xFFFF) i++; // skip low surrogate
  }
}

function resolveGlyphIdsFromText(text) {
  const ids = new Set([0]); // always keep .notdef
  if (!text) return ids;

  if (state.ttf) {
    iterateCodePoints(text, (cp) => {
      const gid = state.ttf.cmap(cp);
      if (gid > 0) ids.add(gid);
    });
    return ids;
  }

  const uniToIds = new Map();
  for (const g of state.glyphs) {
    if (g.unicode == null) continue;
    if (!uniToIds.has(g.unicode)) uniToIds.set(g.unicode, []);
    uniToIds.get(g.unicode).push(g.id);
  }

  iterateCodePoints(text, (cp) => {
    const list = uniToIds.get(cp);
    if (!list) return;
    for (const id of list) ids.add(id);
  });
  return ids;
}

function stripFromText() {
  const input = document.getElementById('strip-text-input');
  if (!input) return;

  const keepIds = resolveGlyphIdsFromText(input.value || '');
  state.mode = 'keep';
  document.getElementById('mode-keep').classList.toggle('active', true);
  document.getElementById('mode-remove').classList.toggle('active', false);

  state.selected = keepIds;
  state.lastClickedIdx = null;
  refreshCardStates();
  updateStats();
}

function setMode(m) {
  state.mode = m;
  document.getElementById('mode-keep').classList.toggle('active', m === 'keep');
  document.getElementById('mode-remove').classList.toggle('active', m === 'remove');
  updateStats();
}

function onOutputFormatChange(value) {
  const allowed = new Set(getAvailableOutputFormats());
  if (!allowed.has(value)) return;
  state.outputFormat = value;
  updateStats();
}
window.onOutputFormatChange = onOutputFormatChange;

function onSearch(q) {
  state.searchQuery = q;
  state.lastClickedIdx = null;
  state.glyphsDisplayLimit = 500; // Reset limit on new search
  renderGrid();
  updateStats();
  // Re-trigger intersection observer for new cards
  for (const card of document.querySelectorAll('.glyph-card:not([data-rendered])')) {
    if (_observer) _observer.observe(card);
  }
}
window.setMode = setMode;
window.selectAll = selectAll;
window.selectNone = selectNone;
window.loadMoreGlyphs = loadMoreGlyphs;
window.showAllGlyphs = showAllGlyphs;
window.onSearch = onSearch;
window.stripFromText = stripFromText;

function updateStats() {
  const total = state.glyphs.length;
  const selectedCount = state.selected.size;
  let keptCount, removedCount;
  if (state.mode === 'keep') {
    keptCount = selectedCount;
    removedCount = total - selectedCount;
  } else {
    keptCount = total - selectedCount;
    removedCount = selectedCount;
  }

  document.getElementById('stats-text').innerHTML =
    `<strong>${selectedCount}</strong> selected &nbsp;·&nbsp; ` +
    `keeping <strong>${keptCount}</strong> of ${total} glyphs &nbsp;·&nbsp; ` +
    `removing <strong>${removedCount}</strong>`;

  const pct = total > 0 ? (keptCount / total * 100) : 0;
  document.getElementById('progress-fill').style.width = pct.toFixed(1) + '%';

  // Estimate output size (rough: ~50 bytes per glyph for TTF, plus overhead ~15 KB)
  if (state.canRebuild) {
    const est = Math.round(15000 + keptCount * 80);
    document.getElementById('stats-size').textContent = '~' + formatBytes(est);
  } else {
    const origSize = state.buffer ? state.buffer.byteLength : 0;
    document.getElementById('stats-size').textContent = formatBytes(origSize) + ' (original)';
  }

  const exportSummary = document.getElementById('export-summary');
  const targetLabel = getOutputFormatLabel(state.outputFormat || getDefaultOutputFormatForState());
  if (state.canRebuild) {
    exportSummary.innerHTML =
      `Exporting <strong>${keptCount}</strong> glyphs as <strong>${targetLabel}</strong> (${state.mode === 'keep' ? 'checked kept' : 'checked removed'})`;
  } else {
    exportSummary.innerHTML =
      `<strong>${keptCount}</strong> glyphs selected for export`;
  }

  document.getElementById('export-btn').disabled = keptCount === 0;
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── KEYBOARD SHORTCUTS ───

document.addEventListener('keydown', e => {
  if (!state.glyphs.length) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault();
    selectAll();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
    e.preventDefault();
    selectNone();
  }
});


// Close conditional wrapper for main app initialization
} // End: if (dropZone && fileInput)
} // End: if (isMainApp)
