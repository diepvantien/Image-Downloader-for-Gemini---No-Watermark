'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const WATERMARK_RULES = {
  large:  { size: 96, marginRight: 64, marginBottom: 64 },
  normal: { size: 48, marginRight: 32, marginBottom: 32 }
};
const MAX_ALPHA = 0.98;
const ALPHA_CACHE = {};
const ALPHA_MAP_URLS = {
  48: 'https://cdn.jsdelivr.net/gh/GargantuaX/gemini-watermark-remover@main/src/assets/bg_48.png',
  96: 'https://cdn.jsdelivr.net/gh/GargantuaX/gemini-watermark-remover@main/src/assets/bg_96.png'
};
const ALPHA_MAP_FALLBACKS = {
  48: 'https://cdn.jsdelivr.net/gh/GargantuaX/gemini-watermark-remover@main/src/assets/bg_48.png',
  96: 'https://cdn.jsdelivr.net/gh/GargantuaX/gemini-watermark-remover@main/src/assets/bg_96.png'
};
const CROP_RATIOS = { '1:1': 1, '16:9': 16/9, '9:16': 9/16, '4:3': 4/3, '3:4': 3/4 };

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  originalImageData: null,
  processedImageData: null,
  currentImageData: null,
  imgWidth: 0, imgHeight: 0,
  watermarkRule: null,
  removeWatermark: true,
  format: 'png', quality: 0.9,
  zoom: 1,
  cropRect: null,
  cropMode: false,    // free draw active
  cropRatio: null,    // null = free, number = locked ratio
  isCropping: false,
  cropStart: null,
  compareMode: false,
  fileSizeBytes: 0,
};

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const mainCanvas = $('mainCanvas'), cropCanvas = $('cropCanvas');
const ctx = mainCanvas.getContext('2d'), cropCtx = cropCanvas.getContext('2d');
const canvasWrapper = $('canvasWrapper'), canvasContainer = $('canvasContainer');
const loadingOverlay = $('loadingOverlay');

// ── Alpha map ─────────────────────────────────────────────────────────────────
async function loadAlphaMap(size) {
  if (ALPHA_CACHE[size]) return ALPHA_CACHE[size];
  for (const map of [ALPHA_MAP_URLS, ALPHA_MAP_FALLBACKS]) {
    try {
      const r = await fetch(map[size]);
      if (!r.ok) continue;
      const bmp = await createImageBitmap(await r.blob());
      const off = new OffscreenCanvas(size, size);
      const oc = off.getContext('2d');
      oc.drawImage(bmp, 0, 0, size, size);
      const { data } = oc.getImageData(0, 0, size, size);
      const alphaMap = new Float32Array(size * size);
      for (let i = 0; i < alphaMap.length; i++)
        alphaMap[i] = Math.max(data[i*4], data[i*4+1], data[i*4+2]) / 255;
      ALPHA_CACHE[size] = alphaMap;
      return alphaMap;
    } catch (_) {}
  }
  throw new Error(`Cannot load alpha map ${size}×${size}`);
}

async function applyWatermarkRemoval(src) {
  const { width: W, height: H } = src;
  const rule = (W > 1024 && H > 1024) ? WATERMARK_RULES.large : WATERMARK_RULES.normal;
  setStatus('loading', `Loading alpha map ${rule.size}px…`);
  const alphaMap = await loadAlphaMap(rule.size);
  setStatus('loading', 'Processing image...');
  const out = new ImageData(new Uint8ClampedArray(src.data), W, H);
  const ox = W - rule.size - rule.marginRight;
  const oy = H - rule.size - rule.marginBottom;
  if (ox < 0 || oy < 0) return { imageData: out, rule, detected: false };
  for (let row = 0; row < rule.size; row++) {
    for (let col = 0; col < rule.size; col++) {
      const a = Math.min(alphaMap[row * rule.size + col], MAX_ALPHA);
      if (a <= 0.005) continue;
      const idx = ((oy + row) * W + (ox + col)) * 4;
      for (let c = 0; c < 3; c++)
        out.data[idx+c] = Math.max(0, Math.min(255, Math.round((out.data[idx+c] - a*255) / (1-a))));
    }
  }
  return { imageData: out, rule, detected: true };
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderCanvas() {
  const data = state.currentImageData;
  if (!data) return;
  const { width: W, height: H } = data;
  mainCanvas.width  = Math.round(W * state.zoom);
  mainCanvas.height = Math.round(H * state.zoom);
  cropCanvas.width  = mainCanvas.width;
  cropCanvas.height = mainCanvas.height;
  const off = new OffscreenCanvas(W, H);
  off.getContext('2d').putImageData(data, 0, 0);
  ctx.imageSmoothingEnabled = state.zoom < 1;
  ctx.drawImage(off, 0, 0, mainCanvas.width, mainCanvas.height);
  renderCropOverlay();
  syncZoomUI();
}

function renderCropOverlay() {
  cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  if (!state.cropRect) return;
  const { x, y, w, h } = state.cropRect;
  const z = state.zoom;
  const [cx, cy, cw, ch] = [x*z, y*z, w*z, h*z];
  cropCtx.fillStyle = 'rgba(0,0,0,0.52)';
  cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropCtx.clearRect(cx, cy, cw, ch);
  cropCtx.strokeStyle = 'rgba(196,115,53,.9)';
  cropCtx.lineWidth = 1.5;
  cropCtx.strokeRect(cx+.5, cy+.5, cw-1, ch-1);
  cropCtx.strokeStyle = 'rgba(255,255,255,.18)';
  cropCtx.lineWidth = .5;
  for (let i = 1; i < 3; i++) {
    cropCtx.beginPath(); cropCtx.moveTo(cx+cw*i/3, cy); cropCtx.lineTo(cx+cw*i/3, cy+ch); cropCtx.stroke();
    cropCtx.beginPath(); cropCtx.moveTo(cx, cy+ch*i/3); cropCtx.lineTo(cx+cw, cy+ch*i/3); cropCtx.stroke();
  }
  const hs = 7;
  cropCtx.fillStyle = '#c47335';
  [[cx-1,cy-1],[cx+cw-hs+1,cy-1],[cx-1,cy+ch-hs+1],[cx+cw-hs+1,cy+ch-hs+1]]
    .forEach(([hx,hy]) => cropCtx.fillRect(hx, hy, hs, hs));
}

function renderCompare(mouseX) {
  if (!state.originalImageData || !state.processedImageData) return;
  const { width: W, height: H } = state.originalImageData;
  mainCanvas.width  = Math.round(W * state.zoom);
  mainCanvas.height = Math.round(H * state.zoom);
  const off = new OffscreenCanvas(W, H);
  const oc = off.getContext('2d');
  oc.putImageData(state.processedImageData, 0, 0);
  const pb = off.transferToImageBitmap();
  oc.putImageData(state.originalImageData, 0, 0);
  const ob = off.transferToImageBitmap();
  ctx.drawImage(pb, 0, 0, mainCanvas.width, mainCanvas.height);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, mouseX, mainCanvas.height); ctx.clip();
  ctx.drawImage(ob, 0, 0, mainCanvas.width, mainCanvas.height);
  ctx.restore();
  ctx.strokeStyle = '#c47335'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(mouseX, 0); ctx.lineTo(mouseX, mainCanvas.height); ctx.stroke();
  ctx.font = 'bold 11px -apple-system,sans-serif';
  ctx.fillStyle='rgba(0,0,0,.72)'; ctx.fillRect(8,8,72,20); ctx.fillRect(mouseX+8,8,80,20);
  ctx.fillStyle='#fff'; ctx.fillText('Original',12,22); ctx.fillText('Processed',mouseX+12,22);
}

// ── Zoom ──────────────────────────────────────────────────────────────────────
function setZoom(z) {
  state.zoom = Math.max(0.1, Math.min(4, z));
  renderCanvas();
}

function fitToWindow() {
  if (!state.imgWidth || !state.imgHeight) return;
  const availW = canvasWrapper.clientWidth - 56;
  const availH = canvasWrapper.clientHeight - 56;
  setZoom(Math.min(availW / state.imgWidth, availH / state.imgHeight, 1));
}

function syncZoomUI() {
  const pct = Math.round(state.zoom * 100);
  $('zoomVal').textContent = pct + '%';
  $('zoomSlider').value = pct;
}

// ── Crop ──────────────────────────────────────────────────────────────────────
function activateCropMode(ratio) {
  state.cropRatio = ratio;
  state.cropMode = true;
  // If preset ratio, auto-center the crop rect
  if (ratio !== null) {
    autoCropRect(ratio);
    updateCropInfo();
    renderCropOverlay();
    $('applyCropBtn').disabled = !state.cropRect;
    $('resetCropBtn').disabled = !state.cropRect;
  }
  $('toolView').classList.remove('active');
  $('toolCrop').classList.add('active');
  canvasContainer.className = 'canvas-container mode-crop';
}

function autoCropRect(ratio) {
  const W = state.imgWidth, H = state.imgHeight;
  let cw, ch;
  if (W / H > ratio) { ch = H; cw = Math.round(ch * ratio); }
  else               { cw = W; ch = Math.round(cw / ratio); }
  state.cropRect = {
    x: Math.round((W - cw) / 2),
    y: Math.round((H - ch) / 2),
    w: cw, h: ch
  };
}

function deactivateCropMode() {
  state.cropMode = false;
  state.cropRatio = null;
  $('toolView').classList.add('active');
  $('toolCrop').classList.remove('active');
  canvasContainer.className = 'canvas-container mode-view';
  document.querySelectorAll('.crop-preset-btn,.crop-free-btn').forEach(b => b.classList.remove('active'));
}

function applyCrop() {
  if (!state.cropRect) return;
  const { x, y, w, h } = state.cropRect;
  const src = state.currentImageData;
  const cropped = new ImageData(w, h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const si = ((y+row)*src.width + (x+col)) * 4;
      const di = (row*w + col) * 4;
      cropped.data[di]   = src.data[si];
      cropped.data[di+1] = src.data[si+1];
      cropped.data[di+2] = src.data[si+2];
      cropped.data[di+3] = src.data[si+3];
    }
  }
  state.originalImageData  = cropped;
  state.processedImageData = cropped;
  state.currentImageData   = cropped;
  state.imgWidth = w; state.imgHeight = h;
  state.cropRect = null;
  state.watermarkRule = null;
  deactivateCropMode();
  renderCanvas();
  updateCropInfo();
  updateInfoPanel();
}

function updateCropInfo() {
  const el = $('cropInfo');
  if (!state.cropRect) {
    el.innerHTML = 'Select a ratio or click <strong>Free form</strong> then drag to extract or adjust.';
  } else {
    const { w, h } = state.cropRect;
    const ratioLabel = state.cropRatio ? Object.keys(CROP_RATIOS).find(k => Math.abs(CROP_RATIOS[k] - state.cropRatio) < 0.01) || '' : 'Free form';
    el.innerHTML = `Crop area: <strong>${w}×${h}px</strong> (${ratioLabel})`;
  }
  $('resetCropBtn').disabled = !state.cropRect;
  $('applyCropBtn').disabled = !state.cropRect;
}

// ── Info panel ────────────────────────────────────────────────────────────────
function updateInfoPanel() {
  $('infoSize').textContent = `${state.imgWidth} × ${state.imgHeight}`;
  if (state.watermarkRule) {
    $('infoWatermark').textContent = `${state.watermarkRule.size}×${state.watermarkRule.size}px`;
    $('infoAlpha').textContent = `${state.watermarkRule.size}×${state.watermarkRule.size}`;
  } else {
    $('infoWatermark').textContent = '—';
    $('infoAlpha').textContent = '—';
  }
  // Estimate file size from current ImageData (uncompressed RGBA → PNG ~25% ratio)
  if (state.currentImageData) {
    const raw = state.currentImageData.data.byteLength;
    const estimated = Math.round(raw * 0.22); // rough PNG estimate
    $('infoFileSize').textContent = formatBytes(estimated) + ' (est.)';
  }
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(2) + ' MB';
}

function setStatus(type, text) {
  const badge = $('statusBadge');
  badge.className = 'status-badge ' + type;
  $('statusText').textContent = text;
  const dot = badge.querySelector('.dot');
  dot.className = 'dot' + (type === 'loading' ? ' pulse' : '');
}

// ── Download / Copy ───────────────────────────────────────────────────────────
function buildOutputCanvas() {
  const src = state.currentImageData;
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').putImageData(src, 0, 0);
  return c;
}

function download() {
  const mime = { png:'image/png', jpeg:'image/jpeg', webp:'image/webp' }[state.format];
  const q = state.format === 'png' ? undefined : state.quality;
  buildOutputCanvas().toBlob(blob => {
    if (!blob) return alert('Cannot export image.');
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: `gemini-${Date.now()}.${state.format}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    // Update file size info with actual blob size
    $('infoFileSize').textContent = formatBytes(blob.size);
    if (new URLSearchParams(location.search).get('autoDownload') === '1') {
      setTimeout(() => window.close(), 200);
    }
  }, mime, q);
}

async function copyToClipboard() {
  try {
    const blob = await new Promise(r => buildOutputCanvas().toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    const btn = $('copyBtn'); const orig = btn.innerHTML;
    btn.innerHTML = '✓ Copied!';
    setTimeout(() => btn.innerHTML = orig, 2000);
  } catch (e) { alert('Copy error: ' + e.message); }
}

// ── Image loading ─────────────────────────────────────────────────────────────
async function getStoredImageData(key) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_IMAGE_DATA', key }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.dataUrl) return resolve(res.dataUrl);
      reject(new Error(res?.error || 'Image data not found'));
    });
  });
}

async function decodeImageData(dataUrl) {
  const r = await fetch(dataUrl);
  const blob = await r.blob();
  state.fileSizeBytes = blob.size;
  const bitmap = await createImageBitmap(blob);
  const { width: w, height: h } = bitmap;
  if (!w || !h) throw new Error('Image size is 0');
  const off = new OffscreenCanvas(w, h);
  off.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return off.getContext('2d').getImageData(0, 0, w, h);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const params = new URLSearchParams(location.search);
  const key = params.get('key');
  const autoDownload = params.get('autoDownload') === '1';

  if (!key) {
    setStatus('error', 'Missing image key');
    $('loadingText').textContent = 'Error: missing image key';
    return;
  }

  try {
    $('loadingText').textContent = 'Fetching image data...';
    const dataUrl = await getStoredImageData(key);

    $('loadingText').textContent = 'Decoding image...';
    const imageData = await decodeImageData(dataUrl);
    state.imgWidth = imageData.width; state.imgHeight = imageData.height;
    state.originalImageData = imageData;

    $('loadingText').textContent = 'Removing watermark...';
    $('loadingSubText').textContent = 'Reverse Alpha Blending';
    const result = await applyWatermarkRemoval(imageData);
    state.processedImageData = result.imageData;
    state.watermarkRule = result.detected ? result.rule : null;
    state.currentImageData = state.processedImageData;

    loadingOverlay.classList.add('hidden');
    fitToWindow();
    renderCanvas();
    updateInfoPanel();
    updateCropInfo();
    $('downloadBtn').disabled = false;
    $('copyBtn').disabled = false;

    setStatus('done', result.detected ? `Removed watermark ${result.rule.size}px` : 'Image loaded (no watermark)');

    // Auto download for quick-download mode
    if (autoDownload) {
      setTimeout(() => download(), 500);
    }
  } catch (err) {
    console.error('[GWR]', err);
    $('loadingText').textContent = 'Error processing image';
    $('loadingSubText').textContent = err.message;
    setStatus('error', 'Error: ' + err.message);
    loadingOverlay.style.background = 'rgba(13,13,18,.97)';
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Tool buttons
$('toolView').addEventListener('click', () => {
  deactivateCropMode();
  state.cropRect = null;
  state.compareMode = false;
  $('compareBtn').classList.remove('active');
  renderCanvas();
  updateCropInfo();
});

$('toolCrop').addEventListener('click', () => {
  activateCropMode(null); // free mode
  $('cropFreeActive');
  document.querySelectorAll('.crop-preset-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.crop-free-btn').classList.add('active');
});

$('compareBtn').addEventListener('click', () => {
  state.compareMode = !state.compareMode;
  $('compareBtn').classList.toggle('active', state.compareMode);
  deactivateCropMode();
  if (!state.compareMode) renderCanvas();
});

// Crop presets
document.querySelectorAll('.crop-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.crop-preset-btn,.crop-free-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const ratio = CROP_RATIOS[btn.dataset.ratio];
    activateCropMode(ratio);
  });
});
document.querySelector('.crop-free-btn').addEventListener('click', function() {
  document.querySelectorAll('.crop-preset-btn,.crop-free-btn').forEach(b => b.classList.remove('active'));
  this.classList.add('active');
  activateCropMode(null);
});

$('resetCropBtn').addEventListener('click', () => {
  state.cropRect = null;
  if (state.cropRatio !== null) autoCropRect(state.cropRatio);
  renderCropOverlay();
  updateCropInfo();
});

$('applyCropBtn').addEventListener('click', applyCrop);

// Zoom slider
$('zoomSlider').addEventListener('input', e => setZoom(e.target.value / 100));
$('zoomInBtn').addEventListener('click', () => setZoom(state.zoom * 1.2));
$('zoomOutBtn').addEventListener('click', () => setZoom(state.zoom / 1.2));
$('zoomVal').addEventListener('click', fitToWindow);
canvasWrapper.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
}, { passive: false });

// Format
document.querySelectorAll('.fmt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.format = btn.dataset.fmt;
    $('qualityRow').style.display = state.format !== 'png' ? 'block' : 'none';
  });
});
$('qualitySlider').addEventListener('input', e => {
  state.quality = e.target.value / 100;
  $('qualityDisplay').textContent = e.target.value + '%';
});

$('toggleWatermark').addEventListener('change', e => {
  state.removeWatermark = e.target.checked;
  state.currentImageData = state.removeWatermark ? state.processedImageData : state.originalImageData;
  renderCanvas();
});

$('downloadBtn').addEventListener('click', download);
$('copyBtn').addEventListener('click', copyToClipboard);

// ── Canvas mouse events ────────────────────────────────────────────────────────

function getCanvasPt(e) {
  const r = mainCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

let dragContext = null;
const HANDLE_SIZE = 10;

function hitTestCrop(pt) {
  if (!state.cropRect) return 'create';
  const { x, y, w, h } = state.cropRect;
  const z = state.zoom;
  const cx = x * z, cy = y * z, cw = w * z, ch = h * z;
  const px = pt.x, py = pt.y;

  const hits = (hx, hy) => Math.abs(px - hx) < HANDLE_SIZE && Math.abs(py - hy) < HANDLE_SIZE;
  
  if (hits(cx, cy)) return 'tl';
  if (hits(cx + cw, cy)) return 'tr';
  if (hits(cx, cy + ch)) return 'bl';
  if (hits(cx + cw, cy + ch)) return 'br';
  
  const margin = 5;
  if (px >= cx + margin && px <= cx + cw - margin && py >= cy + margin && py <= cy + ch - margin) return 'move';
  
  return 'create';
}

function updateCursor(e) {
  if (state.compareMode || !state.cropMode) {
    mainCanvas.style.cursor = '';
    return;
  }
  const pt = getCanvasPt(e);
  const region = hitTestCrop(pt);
  
  let cur = 'crosshair';
  if (region === 'move') cur = 'move';
  else if (region === 'tl' || region === 'br') cur = 'nwse-resize';
  else if (region === 'tr' || region === 'bl') cur = 'nesw-resize';
  mainCanvas.style.cursor = cur;
}

mainCanvas.addEventListener('mousemove', e => {
  if (state.compareMode) { renderCompare(getCanvasPt(e).x); return; }
  
  if (!dragContext) {
    updateCursor(e);
    return;
  }

  const pt = getCanvasPt(e);
  const cx = Math.max(0, Math.min(pt.x / state.zoom, state.imgWidth));
  const cy = Math.max(0, Math.min(pt.y / state.zoom, state.imgHeight));
  
  if (dragContext.region === 'create') {
    let x = Math.min(dragContext.start.x, cx);
    let y = Math.min(dragContext.start.y, cy);
    let w = Math.abs(cx - dragContext.start.x);
    let h = Math.abs(cy - dragContext.start.y);
    
    if (state.cropRatio) {
      if (w / h > state.cropRatio) h = w / state.cropRatio;
      else w = h * state.cropRatio;
      if (cx < dragContext.start.x) x = dragContext.start.x - w;
      if (cy < dragContext.start.y) y = dragContext.start.y - h;
    }
    
    x = Math.max(0, Math.min(Math.round(x), state.imgWidth - w));
    y = Math.max(0, Math.min(Math.round(y), state.imgHeight - h));
    state.cropRect = { x, y, w: Math.round(w), h: Math.round(h) };
  } else if (dragContext.region === 'move') {
    const dx = cx - dragContext.curr.x;
    const dy = cy - dragContext.curr.y;
    let newX = state.cropRect.x + dx;
    let newY = state.cropRect.y + dy;
    newX = Math.max(0, Math.min(newX, state.imgWidth - state.cropRect.w));
    newY = Math.max(0, Math.min(newY, state.imgHeight - state.cropRect.h));
    state.cropRect.x = Math.round(newX);
    state.cropRect.y = Math.round(newY);
    dragContext.curr = { x: cx, y: cy };
  } else {
    // resize
    let nx = state.cropRect.x;
    let ny = state.cropRect.y;
    let nw = state.cropRect.w;
    let nh = state.cropRect.h;
    
    if (dragContext.region === 'tl') {
      nw += (nx - cx); nh += (ny - cy);
      nx = cx; ny = cy;
    } else if (dragContext.region === 'tr') {
      nw = cx - nx;
      nh += (ny - cy);
      ny = cy;
    } else if (dragContext.region === 'bl') {
      nw += (nx - cx);
      nx = cx;
      nh = cy - ny;
    } else if (dragContext.region === 'br') {
      nw = cx - nx;
      nh = cy - ny;
    }
    
    if (state.cropRatio) {
      if (nw / nh > state.cropRatio) {
         nh = nw / state.cropRatio;
         if (dragContext.region === 'tl' || dragContext.region === 'tr') ny = dragContext.origRect.y + dragContext.origRect.h - nh;
      } else {
         nw = nh * state.cropRatio;
         if (dragContext.region === 'tl' || dragContext.region === 'bl') nx = dragContext.origRect.x + dragContext.origRect.w - nw;
      }
    }
    
    if (nw < 10) { nw = 10; if(dragContext.region === 'tl' || dragContext.region === 'bl') nx = dragContext.origRect.x + dragContext.origRect.w - nw; }
    if (nh < 10) { nh = 10; if(dragContext.region === 'tl' || dragContext.region === 'tr') ny = dragContext.origRect.y + dragContext.origRect.h - nh; }
    
    if (nx < 0) { nx = 0; nw = dragContext.origRect.x + dragContext.origRect.w; }
    if (ny < 0) { ny = 0; nh = dragContext.origRect.y + dragContext.origRect.h; }
    if (nx + nw > state.imgWidth) nw = state.imgWidth - nx;
    if (ny + nh > state.imgHeight) nh = state.imgHeight - ny;
    
    state.cropRect = { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) };
  }
  
  renderCropOverlay();
  updateCropInfo();
});

mainCanvas.addEventListener('mousedown', e => {
  if (state.compareMode || !state.cropMode) return;
  const pt = getCanvasPt(e);
  const region = hitTestCrop(pt);
  
  if (region === 'create') {
     state.cropRect = null; 
     renderCropOverlay();
     updateCropInfo();
  }
  
  dragContext = {
    region,
    start: { x: pt.x / state.zoom, y: pt.y / state.zoom },
    curr: { x: pt.x / state.zoom, y: pt.y / state.zoom },
    origRect: state.cropRect ? { ...state.cropRect } : null
  };
});

window.addEventListener('mouseup', () => {
  if (!dragContext) return;
  dragContext = null;
  if (state.cropRect && (state.cropRect.w < 10 || state.cropRect.h < 10)) {
    state.cropRect = null;
    renderCropOverlay();
    updateCropInfo();
  }
});

// Start
init();