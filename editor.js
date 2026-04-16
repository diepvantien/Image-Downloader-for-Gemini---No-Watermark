'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const WATERMARK_RULES = Object.freeze({
  large: Object.freeze({ size: 96, marginRight: 64, marginBottom: 64 }),
  normal: Object.freeze({ size: 48, marginRight: 32, marginBottom: 32 })
});
const WATERMARK_CONFIG_BY_TIER = Object.freeze({
  '0.5k': WATERMARK_RULES.normal,
  '1k': WATERMARK_RULES.normal,
  '2k': WATERMARK_RULES.normal,
  '4k': WATERMARK_RULES.normal
});
const MAX_ALPHA = 0.99;
const ALPHA_NOISE_FLOOR = 3 / 255;
const ALPHA_EXPAND_FACTOR = 1.08; // Phóng đại nhẹ alpha để xóa sạch viền mờ (anti-aliasing)
const ALPHA_THRESHOLD = 0.002;
const LOGO_VALUE = 255;
const EPSILON = 1e-8;
const MULTI_PASS_MAX = 4;
const MULTI_PASS_RESIDUAL_THRESHOLD = 0.22;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const EDGE_CLEANUP_MIN_GRADIENT_IMPROVEMENT = 0.012;
const EDGE_CLEANUP_MAX_SPATIAL_DRIFT = 0.08;
const EDGE_CLEANUP_HALO_MIN_REDUCTION = 1.0;
const RESIDUAL_RECALIBRATION_THRESHOLD = 0.48;
const MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION = 0.16;
const MIN_RECALIBRATION_SCORE_DELTA = 0.06;
const HALO_MIN_ALPHA = 0.12;
const HALO_MAX_ALPHA = 0.35;
const HALO_OUTSIDE_ALPHA_MAX = 0.01;
const HALO_OUTER_MARGIN = 3;
const ALPHA_GAIN_CANDIDATES = Object.freeze([
  1.05, 1.12, 1.2, 1.28, 1.36, 1.45, 1.52, 1.6, 1.7, 1.85, 2.0
]);
const EDGE_CLEANUP_PRESETS = Object.freeze([
  { minAlpha: 0.03, maxAlpha: 0.45, radius: 2, strength: 0.7, outsideAlphaMax: 0.05 },
  { minAlpha: 0.06, maxAlpha: 0.58, radius: 3, strength: 0.75, outsideAlphaMax: 0.08 },
  { minAlpha: 0.02, maxAlpha: 0.36, radius: 4, strength: 1.2, outsideAlphaMax: 0.05 }
]);
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

function createCatalogEntries(resolutionTier, rows) {
  return rows.map(([width, height]) => ({ resolutionTier, width, height }));
}

const OFFICIAL_GEMINI_IMAGE_SIZES = Object.freeze([
  ...createCatalogEntries('0.5k', [
    [512, 512], [256, 1024], [192, 1536], [424, 632], [632, 424],
    [448, 600], [1024, 256], [600, 448], [464, 576], [576, 464],
    [1536, 192], [384, 688], [688, 384], [792, 168]
  ]),
  ...createCatalogEntries('1k', [
    [1024, 1024], [512, 2064], [352, 2928], [848, 1264], [1264, 848],
    [896, 1200], [2064, 512], [1200, 896], [928, 1152], [1152, 928],
    [2928, 352], [768, 1376], [1376, 768], [1408, 768], [1584, 672]
  ]),
  ...createCatalogEntries('2k', [
    [2048, 2048], [512, 2048], [384, 3072], [1696, 2528], [2528, 1696],
    [1792, 2400], [2048, 512], [2400, 1792], [1856, 2304], [2304, 1856],
    [3072, 384], [1536, 2752], [2752, 1536], [3168, 1344]
  ]),
  ...createCatalogEntries('4k', [
    [4096, 4096], [2048, 8192], [1536, 12288], [3392, 5056], [5056, 3392],
    [3584, 4800], [8192, 2048], [4800, 3584], [3712, 4608], [4608, 3712],
    [12288, 1536], [3072, 5504], [5504, 3072], [6336, 2688]
  ]),
  ...createCatalogEntries('1k', [
    [1024, 1024], [832, 1248], [1248, 832], [864, 1184], [1184, 864],
    [896, 1152], [1152, 896], [768, 1344], [1344, 768], [1536, 672]
  ])
]);

const OFFICIAL_GEMINI_IMAGE_SIZE_INDEX = new Map(
  OFFICIAL_GEMINI_IMAGE_SIZES.map((entry) => [
    `${entry.width}x${entry.height}`,
    WATERMARK_CONFIG_BY_TIER[entry.resolutionTier] || WATERMARK_RULES.normal
  ])
);

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  originalImageData: null,
  processedImageData: null,
  currentImageData: null,
  compareBeforeImageData: null,
  compareAfterImageData: null,
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
  upscaledPreviewBitmap: null,
  upscaledPreviewBlobSize: 0,
  useUpscaledPreviewBitmap: false,
  canvasDpr: 1,
  canvasDisplayWidth: 0,
  canvasDisplayHeight: 0,
};
let infoFileSizeRequestId = 0;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const mainCanvas = $('mainCanvas'), cropCanvas = $('cropCanvas');
const ctx = mainCanvas.getContext('2d'), cropCtx = cropCanvas.getContext('2d');
const canvasWrapper = $('canvasWrapper'), canvasContainer = $('canvasContainer');
const loadingOverlay = $('loadingOverlay');

function releaseUpscaledPreviewBitmap() {
  if (state.upscaledPreviewBitmap) {
    try {
      state.upscaledPreviewBitmap.close();
    } catch (_) {
      // Ignore close errors from already-released bitmap handles.
    }
  }
  state.upscaledPreviewBitmap = null;
  state.upscaledPreviewBlobSize = 0;
  state.useUpscaledPreviewBitmap = false;
}

function cloneImageData(source) {
  if (!source) return null;
  return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
}

function setupCanvasResolution(displayWidth, displayHeight) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  state.canvasDpr = dpr;
  state.canvasDisplayWidth = displayWidth;
  state.canvasDisplayHeight = displayHeight;

  mainCanvas.style.width = `${displayWidth}px`;
  mainCanvas.style.height = `${displayHeight}px`;
  cropCanvas.style.width = `${displayWidth}px`;
  cropCanvas.style.height = `${displayHeight}px`;

  mainCanvas.width = Math.max(1, Math.round(displayWidth * dpr));
  mainCanvas.height = Math.max(1, Math.round(displayHeight * dpr));
  cropCanvas.width = mainCanvas.width;
  cropCanvas.height = mainCanvas.height;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cropCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

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

function cloneRule(rule) {
  return { size: rule.size, marginRight: rule.marginRight, marginBottom: rule.marginBottom };
}

function normalizeDimension(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return rounded > 0 ? rounded : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildRuleKey(rule) {
  return `${rule.size}:${rule.marginRight}:${rule.marginBottom}`;
}

function meanAndVariance(values) {
  if (!values.length) return { mean: 0, variance: 0 };
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  const mean = sum / values.length;

  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - mean;
    sq += d * d;
  }
  return { mean, variance: sq / values.length };
}

function normalizedCrossCorrelation(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;

  const statsA = meanAndVariance(a);
  const statsB = meanAndVariance(b);
  const den = Math.sqrt(statsA.variance * statsB.variance) * a.length;
  if (den < EPSILON) return 0;

  let num = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - statsA.mean) * (b[i] - statsB.mean);
  }
  return num / den;
}

function toRegionGrayscale(imageData, region) {
  const { width, height, data } = imageData;
  const size = region.size ?? Math.min(region.width, region.height);
  if (!size || size <= 0) return new Float32Array(0);
  if (region.x < 0 || region.y < 0 || region.x + size > width || region.y + size > height) {
    return new Float32Array(0);
  }

  const out = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const idx = ((region.y + row) * width + (region.x + col)) * 4;
      out[row * size + col] =
        (0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]) / 255;
    }
  }
  return out;
}

function computeRegionSpatialCorrelation({ imageData, alphaMap, region }) {
  const patch = toRegionGrayscale(imageData, region);
  if (patch.length === 0 || patch.length !== alphaMap.length) return 0;
  return normalizedCrossCorrelation(patch, alphaMap);
}

function sobelMagnitude(gray, width, height) {
  const grad = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1] +
        gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1];
      const gy =
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
        gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
      grad[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  return grad;
}

function computeRegionGradientCorrelation({ imageData, alphaMap, region }) {
  const patch = toRegionGrayscale(imageData, region);
  if (patch.length === 0 || patch.length !== alphaMap.length) return 0;
  const size = region.size ?? Math.min(region.width, region.height);
  if (!size || size <= 2) return 0;

  const patchGrad = sobelMagnitude(patch, size, size);
  const alphaGrad = sobelMagnitude(alphaMap, size, size);
  return normalizedCrossCorrelation(patchGrad, alphaGrad);
}

function calculateNearBlackRatio(imageData, position) {
  let nearBlack = 0;
  let total = 0;
  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;
      const r = imageData.data[idx];
      const g = imageData.data[idx + 1];
      const b = imageData.data[idx + 2];
      if (r <= 5 && g <= 5 && b <= 5) nearBlack++;
      total++;
    }
  }
  return total > 0 ? nearBlack / total : 0;
}

function scoreRegion(imageData, alphaMap, position) {
  return {
    spatialScore: computeRegionSpatialCorrelation({
      imageData,
      alphaMap,
      region: { x: position.x, y: position.y, size: position.width }
    }),
    gradientScore: computeRegionGradientCorrelation({
      imageData,
      alphaMap,
      region: { x: position.x, y: position.y, size: position.width }
    })
  };
}

function assessAlphaBandHalo({
  imageData,
  position,
  alphaMap,
  minAlpha = HALO_MIN_ALPHA,
  maxAlpha = HALO_MAX_ALPHA,
  outsideAlphaMax = HALO_OUTSIDE_ALPHA_MAX,
  outerMargin = HALO_OUTER_MARGIN
}) {
  let bandSum = 0;
  let bandCount = 0;
  let outerSum = 0;
  let outerCount = 0;

  for (let row = -outerMargin; row < position.height + outerMargin; row++) {
    for (let col = -outerMargin; col < position.width + outerMargin; col++) {
      const pixelX = position.x + col;
      const pixelY = position.y + row;
      if (pixelX < 0 || pixelY < 0 || pixelX >= imageData.width || pixelY >= imageData.height) continue;

      const pixelIndex = (pixelY * imageData.width + pixelX) * 4;
      const luminance =
        0.2126 * imageData.data[pixelIndex] +
        0.7152 * imageData.data[pixelIndex + 1] +
        0.0722 * imageData.data[pixelIndex + 2];
      const insideRegion = row >= 0 && col >= 0 && row < position.height && col < position.width;
      const alpha = insideRegion ? alphaMap[row * position.width + col] : 0;

      if (insideRegion && alpha >= minAlpha && alpha <= maxAlpha) {
        bandSum += luminance;
        bandCount++;
      } else if (!insideRegion || alpha <= outsideAlphaMax) {
        outerSum += luminance;
        outerCount++;
      }
    }
  }

  const bandMeanLum = bandCount > 0 ? bandSum / bandCount : 0;
  const outerMeanLum = outerCount > 0 ? outerSum / outerCount : 0;
  const deltaLum = bandMeanLum - outerMeanLum;

  return {
    bandCount,
    outerCount,
    bandMeanLum,
    outerMeanLum,
    deltaLum,
    positiveDeltaLum: Math.max(0, deltaLum)
  };
}

function interpolateAlphaMap(sourceAlpha, sourceSize, targetSize) {
  if (targetSize <= 0) return new Float32Array(0);
  if (sourceSize === targetSize) return new Float32Array(sourceAlpha);

  const out = new Float32Array(targetSize * targetSize);
  const scale = (sourceSize - 1) / Math.max(1, targetSize - 1);

  for (let y = 0; y < targetSize; y++) {
    const sy = y * scale;
    const y0 = Math.floor(sy);
    const y1 = Math.min(sourceSize - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < targetSize; x++) {
      const sx = x * scale;
      const x0 = Math.floor(sx);
      const x1 = Math.min(sourceSize - 1, x0 + 1);
      const fx = sx - x0;

      const p00 = sourceAlpha[y0 * sourceSize + x0];
      const p10 = sourceAlpha[y0 * sourceSize + x1];
      const p01 = sourceAlpha[y1 * sourceSize + x0];
      const p11 = sourceAlpha[y1 * sourceSize + x1];

      const top = p00 + (p10 - p00) * fx;
      const bottom = p01 + (p11 - p01) * fx;
      out[y * targetSize + x] = top + (bottom - top) * fy;
    }
  }

  return out;
}

function calculateWatermarkPosition(imageWidth, imageHeight, rule) {
  return {
    x: imageWidth - rule.marginRight - rule.size,
    y: imageHeight - rule.marginBottom - rule.size,
    width: rule.size,
    height: rule.size
  };
}

function isRegionInsideImage(imageData, region) {
  return region.x >= 0 &&
    region.y >= 0 &&
    region.x + region.width <= imageData.width &&
    region.y + region.height <= imageData.height;
}

function resolveOfficialGeminiWatermarkRule(width, height) {
  const normalizedWidth = normalizeDimension(width);
  const normalizedHeight = normalizeDimension(height);
  if (!normalizedWidth || !normalizedHeight) return null;
  const match = OFFICIAL_GEMINI_IMAGE_SIZE_INDEX.get(`${normalizedWidth}x${normalizedHeight}`);
  return match ? cloneRule(match) : null;
}

function resolveOfficialGeminiSearchRules(
  width,
  height,
  {
    maxRelativeAspectRatioDelta = 0.02,
    maxScaleMismatchRatio = 0.12,
    minLogoSize = 24,
    maxLogoSize = 192,
    limit = 3
  } = {}
) {
  const normalizedWidth = normalizeDimension(width);
  const normalizedHeight = normalizeDimension(height);
  if (!normalizedWidth || !normalizedHeight) return [];

  const exactRule = resolveOfficialGeminiWatermarkRule(normalizedWidth, normalizedHeight);
  if (exactRule) return [exactRule];

  const targetAspectRatio = normalizedWidth / normalizedHeight;
  const candidates = OFFICIAL_GEMINI_IMAGE_SIZES
    .map((entry) => {
      const baseRule = WATERMARK_CONFIG_BY_TIER[entry.resolutionTier] || WATERMARK_RULES.normal;

      const scaleX = normalizedWidth / entry.width;
      const scaleY = normalizedHeight / entry.height;
      const scale = (scaleX + scaleY) / 2;
      const entryAspectRatio = entry.width / entry.height;
      const relativeAspectRatioDelta = Math.abs(targetAspectRatio - entryAspectRatio) / entryAspectRatio;
      const scaleMismatchRatio = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);

      if (relativeAspectRatioDelta > maxRelativeAspectRatioDelta) return null;
      if (scaleMismatchRatio > maxScaleMismatchRatio) return null;

      const rule = {
        size: baseRule.size,
        marginRight: baseRule.marginRight,
        marginBottom: baseRule.marginBottom
      };

      const x = normalizedWidth - rule.marginRight - rule.size;
      const y = normalizedHeight - rule.marginBottom - rule.size;
      if (x < 0 || y < 0) return null;

      return {
        rule,
        score:
          relativeAspectRatioDelta * 100 +
          scaleMismatchRatio * 20 +
          Math.abs(Math.log2(Math.max(scale, 1e-6)))
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);

  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = buildRuleKey(candidate.rule);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate.rule);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

function detectWatermarkRule(imageWidth, imageHeight) {
  const officialRule = resolveOfficialGeminiWatermarkRule(imageWidth, imageHeight);
  if (officialRule) return officialRule;

  return cloneRule(WATERMARK_RULES.normal);
}

function getAlphaMapForRule(rule, alpha48, alpha96) {
  if (!rule) return null;
  if (rule.size === 48) return alpha48;
  if (rule.size === 96) return alpha96;
  return alpha96 ? interpolateAlphaMap(alpha96, 96, rule.size) : null;
}

function findBestAnchorForRule({
  imageData,
  rule,
  alphaMap,
  searchRadius
}) {
  if (!imageData || !rule || !alphaMap) return null;

  const expectedRegion = calculateWatermarkPosition(imageData.width, imageData.height, rule);
  if (!isRegionInsideImage(imageData, expectedRegion)) return null;

  const radius = Number.isFinite(searchRadius)
    ? Math.max(0, Math.round(searchRadius))
    : Math.max(6, Math.round(rule.size * 0.33));
  const coarseStep = rule.size >= 80 ? 2 : 1;

  const evaluateRegion = (x, y) => {
    const region = { x, y, width: rule.size, height: rule.size };
    if (!isRegionInsideImage(imageData, region)) return null;

    const spatialScore = computeRegionSpatialCorrelation({
      imageData,
      alphaMap,
      region: { x: region.x, y: region.y, size: region.width }
    });
    const gradientScore = computeRegionGradientCorrelation({
      imageData,
      alphaMap,
      region: { x: region.x, y: region.y, size: region.width }
    });
    const score = Math.max(0, spatialScore) * 0.62 + Math.max(0, gradientScore) * 0.38;

    return { region, score, spatialScore, gradientScore };
  };

  let best = evaluateRegion(expectedRegion.x, expectedRegion.y);
  if (!best) return null;

  let bestDx = 0;
  let bestDy = 0;

  for (let dy = -radius; dy <= radius; dy += coarseStep) {
    for (let dx = -radius; dx <= radius; dx += coarseStep) {
      if (dx === 0 && dy === 0) continue;

      const candidate = evaluateRegion(expectedRegion.x + dx, expectedRegion.y + dy);
      if (!candidate) continue;

      const bestDistance = Math.abs(bestDx) + Math.abs(bestDy);
      const candidateDistance = Math.abs(dx) + Math.abs(dy);
      const improvedScore = candidate.score > best.score + EPSILON;
      const tieBreakCloser =
        Math.abs(candidate.score - best.score) <= EPSILON && candidateDistance < bestDistance;
      const tieBreakBySpatial =
        Math.abs(candidate.score - best.score) <= EPSILON &&
        Math.abs(candidate.spatialScore) > Math.abs(best.spatialScore) + EPSILON;

      if (improvedScore || tieBreakCloser || tieBreakBySpatial) {
        best = candidate;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  if (coarseStep > 1) {
    for (let dy = bestDy - (coarseStep - 1); dy <= bestDy + (coarseStep - 1); dy++) {
      for (let dx = bestDx - (coarseStep - 1); dx <= bestDx + (coarseStep - 1); dx++) {
        const candidate = evaluateRegion(expectedRegion.x + dx, expectedRegion.y + dy);
        if (!candidate) continue;

        const bestDistance = Math.abs(bestDx) + Math.abs(bestDy);
        const candidateDistance = Math.abs(dx) + Math.abs(dy);
        const improvedScore = candidate.score > best.score + EPSILON;
        const tieBreakCloser =
          Math.abs(candidate.score - best.score) <= EPSILON && candidateDistance < bestDistance;
        const tieBreakBySpatial =
          Math.abs(candidate.score - best.score) <= EPSILON &&
          Math.abs(candidate.spatialScore) > Math.abs(best.spatialScore) + EPSILON;

        if (improvedScore || tieBreakCloser || tieBreakBySpatial) {
          best = candidate;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }
  }

  return {
    rule,
    region: best.region,
    score: best.score,
    shiftX: bestDx,
    shiftY: bestDy
  };
}

function removeWatermarkInPlace(imageData, alphaMap, position, alphaGain = 1) {
  let touchedPixelCount = 0;
  const gain = Number.isFinite(alphaGain) && alphaGain > 0 ? alphaGain : 1;

  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const rawAlpha = alphaMap[row * position.width + col];
      const signalAlpha = Math.max(0, rawAlpha - ALPHA_NOISE_FLOOR) * ALPHA_EXPAND_FACTOR * gain;
      if (signalAlpha < ALPHA_THRESHOLD) continue;

      const alpha = Math.min(rawAlpha * gain, MAX_ALPHA);

      const oneMinusAlpha = 1.0 - alpha;
      const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;

      for (let c = 0; c < 3; c++) {
        const watermarked = imageData.data[idx + c];
        const original = (watermarked - alpha * LOGO_VALUE) / oneMinusAlpha;
        imageData.data[idx + c] = Math.max(0, Math.min(255, Math.round(original)));
      }
      touchedPixelCount++;
    }
  }

  return touchedPixelCount;
}

function removeRepeatedWatermarkLayers({
  imageData,
  alphaMap,
  position,
  maxPasses = 3,
  residualThreshold = MULTI_PASS_RESIDUAL_THRESHOLD,
  alphaGain = 1
}) {
  const safePasses = Math.max(1, maxPasses);
  let currentImageData = cloneImageData(imageData);
  const baseNearBlackRatio = calculateNearBlackRatio(currentImageData, position);
  const maxNearBlackRatio = Math.min(1, baseNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
  let appliedPassCount = 0;

  for (let passIndex = 0; passIndex < safePasses; passIndex++) {
    const before = scoreRegion(currentImageData, alphaMap, position);
    const candidate = cloneImageData(currentImageData);
    const touched = removeWatermarkInPlace(candidate, alphaMap, position, alphaGain);
    if (touched <= 0) break;

    const after = scoreRegion(candidate, alphaMap, position);
    const nearBlackRatio = calculateNearBlackRatio(candidate, position);

    if (nearBlackRatio > maxNearBlackRatio) break;

    const worsenedTooMuch =
      Math.abs(after.spatialScore) > Math.abs(before.spatialScore) + 0.08 &&
      after.gradientScore > before.gradientScore + 0.06;
    if (worsenedTooMuch) break;

    currentImageData = candidate;
    appliedPassCount++;

    if (Math.abs(after.spatialScore) <= residualThreshold && after.gradientScore <= 0.12) break;
  }

  return {
    imageData: currentImageData,
    passCount: appliedPassCount
  };
}

function shouldRecalibrateAlphaStrength({
  originalSpatialScore,
  processedSpatialScore
}) {
  const originalAbs = Math.abs(originalSpatialScore);
  const processedAbs = Math.abs(processedSpatialScore);
  const suppressionGain = originalAbs - processedAbs;

  return originalAbs >= RESIDUAL_RECALIBRATION_THRESHOLD &&
    processedAbs >= RESIDUAL_RECALIBRATION_THRESHOLD &&
    suppressionGain <= MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION;
}

function recalibrateAlphaStrength({
  sourceImageData,
  alphaMap,
  position,
  baselineSpatialScore,
  baselineGradientScore
}) {
  const baselineNearBlackRatio = calculateNearBlackRatio(sourceImageData, position);
  const maxAllowedNearBlackRatio = Math.min(1, baselineNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
  const baselineAbs = Math.abs(baselineSpatialScore);

  let bestAbs = baselineAbs;
  let bestImageData = null;
  let bestSpatialScore = baselineSpatialScore;
  let bestGradientScore = baselineGradientScore;
  let bestAlphaGain = 1;

  for (const alphaGain of ALPHA_GAIN_CANDIDATES) {
    const candidate = cloneImageData(sourceImageData);
    const touched = removeWatermarkInPlace(candidate, alphaMap, position, alphaGain);
    if (touched <= 0) continue;

    const nearBlackRatio = calculateNearBlackRatio(candidate, position);
    if (nearBlackRatio > maxAllowedNearBlackRatio) continue;

    const spatialScore = computeRegionSpatialCorrelation({
      imageData: candidate,
      alphaMap,
      region: { x: position.x, y: position.y, size: position.width }
    });
    const gradientScore = computeRegionGradientCorrelation({
      imageData: candidate,
      alphaMap,
      region: { x: position.x, y: position.y, size: position.width }
    });

    const candidateAbs = Math.abs(spatialScore);
    const worsenedGradient = gradientScore > baselineGradientScore + 0.06;
    if (worsenedGradient) continue;

    if (candidateAbs < bestAbs - EPSILON) {
      bestAbs = candidateAbs;
      bestImageData = candidate;
      bestSpatialScore = spatialScore;
      bestGradientScore = gradientScore;
      bestAlphaGain = alphaGain;
    }
  }

  if (!bestImageData || baselineAbs - bestAbs < MIN_RECALIBRATION_SCORE_DELTA) {
    return null;
  }

  return {
    imageData: bestImageData,
    spatialScore: bestSpatialScore,
    gradientScore: bestGradientScore,
    alphaGain: bestAlphaGain
  };
}

function blendResidualEdge({
  sourceImageData,
  alphaMap,
  position,
  minAlpha,
  maxAlpha,
  radius,
  strength,
  outsideAlphaMax
}) {
  const candidate = cloneImageData(sourceImageData);
  const { width: imageWidth, height: imageHeight, data } = sourceImageData;
  const regionSize = position.width;
  const maxAlphaSafe = Math.max(maxAlpha, 1e-6);

  for (let row = 0; row < regionSize; row++) {
    for (let col = 0; col < regionSize; col++) {
      const alpha = alphaMap[row * regionSize + col];
      if (alpha < minAlpha || alpha > maxAlpha) continue;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumWeight = 0;

      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx === 0 && dy === 0) continue;

          const localY = row + dy;
          const localX = col + dx;
          const pixelX = position.x + localX;
          const pixelY = position.y + localY;

          if (pixelX < 0 || pixelY < 0 || pixelX >= imageWidth || pixelY >= imageHeight) continue;

          let neighborAlpha = 0;
          if (localY >= 0 && localX >= 0 && localY < regionSize && localX < regionSize) {
            neighborAlpha = alphaMap[localY * regionSize + localX];
          }
          if (neighborAlpha > outsideAlphaMax) continue;

          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          const weight = 1 / distance;
          const pixelIndex = (pixelY * imageWidth + pixelX) * 4;
          sumR += data[pixelIndex] * weight;
          sumG += data[pixelIndex + 1] * weight;
          sumB += data[pixelIndex + 2] * weight;
          sumWeight += weight;
        }
      }

      if (sumWeight <= 0) continue;

      const blend = Math.max(0, Math.min(1, strength * alpha / maxAlphaSafe));
      const pixelIndex = ((position.y + row) * imageWidth + (position.x + col)) * 4;
      candidate.data[pixelIndex] = Math.round(data[pixelIndex] * (1 - blend) + (sumR / sumWeight) * blend);
      candidate.data[pixelIndex + 1] = Math.round(data[pixelIndex + 1] * (1 - blend) + (sumG / sumWeight) * blend);
      candidate.data[pixelIndex + 2] = Math.round(data[pixelIndex + 2] * (1 - blend) + (sumB / sumWeight) * blend);
    }
  }

  return candidate;
}

function refineResidualEdge({
  sourceImageData,
  alphaMap,
  position,
  baselineSpatialScore,
  baselineGradientScore
}) {
  const baselineHalo = assessAlphaBandHalo({
    imageData: sourceImageData,
    position,
    alphaMap
  });

  const baselineNearBlackRatio = calculateNearBlackRatio(sourceImageData, position);
  const maxAllowedNearBlackRatio = Math.min(1, baselineNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
  let best = null;

  for (const preset of EDGE_CLEANUP_PRESETS) {
    const candidate = blendResidualEdge({
      sourceImageData,
      alphaMap,
      position,
      ...preset
    });

    const nearBlackRatio = calculateNearBlackRatio(candidate, position);
    if (nearBlackRatio > maxAllowedNearBlackRatio) continue;

    const spatialScore = computeRegionSpatialCorrelation({
      imageData: candidate,
      alphaMap,
      region: { x: position.x, y: position.y, size: position.width }
    });
    const gradientScore = computeRegionGradientCorrelation({
      imageData: candidate,
      alphaMap,
      region: { x: position.x, y: position.y, size: position.width }
    });
    const halo = assessAlphaBandHalo({
      imageData: candidate,
      position,
      alphaMap
    });

    const improvedGradient =
      gradientScore <= baselineGradientScore - EDGE_CLEANUP_MIN_GRADIENT_IMPROVEMENT ||
      (baselineGradientScore <= 0.08 && gradientScore <= baselineGradientScore + 0.01);
    const keptSpatial = Math.abs(spatialScore) <= Math.abs(baselineSpatialScore) + EDGE_CLEANUP_MAX_SPATIAL_DRIFT;
    const baselinePositiveHalo = baselineHalo.positiveDeltaLum;
    const candidatePositiveHalo = halo.positiveDeltaLum;
    const improvedHalo = baselinePositiveHalo < 1 ||
      candidatePositiveHalo <= baselinePositiveHalo - EDGE_CLEANUP_HALO_MIN_REDUCTION ||
      candidatePositiveHalo <= baselinePositiveHalo * 0.75;

    if (!improvedGradient || !keptSpatial || !improvedHalo) continue;

    const cost = Math.abs(spatialScore) * 0.6 + Math.max(0, gradientScore) + candidatePositiveHalo * 0.02;
    if (!best || cost < best.cost) {
      best = {
        imageData: candidate,
        spatialScore,
        gradientScore,
        halo,
        cost
      };
    }
  }

  return best;
}

function resolveInitialStandardRule({
  imageData,
  defaultRule,
  alpha48,
  alpha96,
  minSwitchScore = 0.12,
  minScoreDelta = 0.04
}) {
  if (!imageData || !defaultRule || !alpha48 || !alpha96) {
    return {
      rule: defaultRule,
      region: imageData
        ? calculateWatermarkPosition(imageData.width, imageData.height, defaultRule)
        : { x: 0, y: 0, width: defaultRule?.size || 0, height: defaultRule?.size || 0 },
      score: Number.NEGATIVE_INFINITY,
      shiftX: 0,
      shiftY: 0
    };
  }

  const fallbackRule = cloneRule(WATERMARK_RULES.normal);
  const primaryRule = defaultRule.size === 96 ? cloneRule(WATERMARK_RULES.large) : fallbackRule;
  const candidateRules = [primaryRule];

  // Keep 48px as the strict default. Only evaluate fallback-to-48 when default is 96.
  if (defaultRule.size === 96) {
    candidateRules.push(fallbackRule);
  }

  for (const officialRule of resolveOfficialGeminiSearchRules(imageData.width, imageData.height, { limit: 2 })) {
    // Prevent accidental 96px escalation when current default is 48px.
    if (defaultRule.size !== 96 && officialRule.size === 96) continue;
    if (!candidateRules.some((candidate) => buildRuleKey(candidate) === buildRuleKey(officialRule))) {
      candidateRules.push(officialRule);
    }
  }

  let bestMatch = null;

  for (const candidateRule of candidateRules) {
    const alphaMap = getAlphaMapForRule(candidateRule, alpha48, alpha96);
    if (!alphaMap) continue;

    const candidateMatch = findBestAnchorForRule({
      imageData,
      rule: candidateRule,
      alphaMap,
      searchRadius: Math.max(6, Math.round(candidateRule.size * 0.33))
    });
    if (!candidateMatch) continue;

    const candidateScore = candidateMatch.score;

    if (!bestMatch) {
      bestMatch = candidateMatch;
      continue;
    }

    const bestIsLowConfidence = bestMatch.score < minSwitchScore;
    const betterByDelta = candidateScore > bestMatch.score + minScoreDelta;
    if ((bestIsLowConfidence && candidateScore > bestMatch.score) || betterByDelta) {
      bestMatch = candidateMatch;
    }
  }

  if (bestMatch) return bestMatch;

  return {
    rule: defaultRule,
    region: calculateWatermarkPosition(imageData.width, imageData.height, defaultRule),
    score: Number.NEGATIVE_INFINITY,
    shiftX: 0,
    shiftY: 0
  };
}

async function applyWatermarkRemoval(src) {
  const { width: W, height: H } = src;

  setStatus('loading', 'Loading alpha maps…');
  const alpha48 = await loadAlphaMap(48);
  const alpha96 = await loadAlphaMap(96);

  const defaultRule = detectWatermarkRule(W, H);
  const resolvedRule = resolveInitialStandardRule({
    imageData: src,
    defaultRule,
    alpha48,
    alpha96
  });

  const rule = resolvedRule.rule;

  const alphaMap = getAlphaMapForRule(rule, alpha48, alpha96);
  const region = resolvedRule.region;

  setStatus('loading', 'Processing image...');
  const out = new ImageData(new Uint8ClampedArray(src.data), W, H);

  if (!alphaMap || !isRegionInsideImage(src, region)) {
    return { imageData: out, rule, detected: false };
  }

  const baseline = scoreRegion(src, alphaMap, region);
  if (Math.abs(baseline.spatialScore) < 0.05 && baseline.gradientScore < 0.03) {
    return { imageData: out, rule, detected: false };
  }

  const firstTouchedPixelCount = removeWatermarkInPlace(out, alphaMap, region, 1);
  if (firstTouchedPixelCount <= 0) {
    return { imageData: out, rule, detected: false };
  }

  let finalImageData = out;
  let finalMetrics = scoreRegion(finalImageData, alphaMap, region);

  const shouldRunExtraPasses =
    Math.abs(finalMetrics.spatialScore) > MULTI_PASS_RESIDUAL_THRESHOLD ||
    finalMetrics.gradientScore > 0.12;

  if (shouldRunExtraPasses) {
    const extraPassResult = removeRepeatedWatermarkLayers({
      imageData: finalImageData,
      alphaMap,
      position: region,
      maxPasses: MULTI_PASS_MAX - 1,
      residualThreshold: MULTI_PASS_RESIDUAL_THRESHOLD,
      alphaGain: 1
    });
    if (extraPassResult.passCount > 0) {
      finalImageData = extraPassResult.imageData;
      finalMetrics = scoreRegion(finalImageData, alphaMap, region);
    }
  }

  const shouldRecalibrate = shouldRecalibrateAlphaStrength({
    originalSpatialScore: baseline.spatialScore,
    processedSpatialScore: finalMetrics.spatialScore
  });
  if (shouldRecalibrate) {
    const recalibrated = recalibrateAlphaStrength({
      sourceImageData: finalImageData,
      alphaMap,
      position: region,
      baselineSpatialScore: finalMetrics.spatialScore,
      baselineGradientScore: finalMetrics.gradientScore
    });
    if (recalibrated) {
      finalImageData = recalibrated.imageData;
      finalMetrics = {
        spatialScore: recalibrated.spatialScore,
        gradientScore: recalibrated.gradientScore
      };
    }
  }

  const shouldRefineEdges =
    finalMetrics.gradientScore > 0.08 ||
    Math.abs(finalMetrics.spatialScore) > 0.12;
  if (shouldRefineEdges) {
    const refined = refineResidualEdge({
      sourceImageData: finalImageData,
      alphaMap,
      position: region,
      baselineSpatialScore: finalMetrics.spatialScore,
      baselineGradientScore: finalMetrics.gradientScore
    });
    if (refined) {
      finalImageData = refined.imageData;
      finalMetrics = {
        spatialScore: refined.spatialScore,
        gradientScore: refined.gradientScore
      };
    }
  }

  const suppressionGain = Math.abs(baseline.spatialScore) - Math.abs(finalMetrics.spatialScore);
  const detected = firstTouchedPixelCount > 0 && (suppressionGain > 0 || finalMetrics.gradientScore < baseline.gradientScore);

  return { imageData: finalImageData, rule, detected };
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderCanvas() {
  const data = state.currentImageData;
  if (!data) return;
  const { width: W, height: H } = data;
  const displayWidth = Math.round(W * state.zoom);
  const displayHeight = Math.round(H * state.zoom);
  setupCanvasResolution(displayWidth, displayHeight);

  ctx.imageSmoothingEnabled = state.zoom < 1;
  if ('imageSmoothingQuality' in ctx) {
    ctx.imageSmoothingQuality = 'high';
  }

  const canUseBitmapPreview =
    state.useUpscaledPreviewBitmap &&
    !!state.upscaledPreviewBitmap &&
    state.currentImageData === state.originalImageData &&
    state.currentImageData === state.processedImageData;

  if (canUseBitmapPreview) {
    // Prefer crisp detail when showing directly upscaled preview.
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, displayWidth, displayHeight);
    ctx.drawImage(state.upscaledPreviewBitmap, 0, 0, displayWidth, displayHeight);
    renderCropOverlay();
    syncZoomUI();
    return;
  }

  const off = new OffscreenCanvas(W, H);
  off.getContext('2d').putImageData(data, 0, 0);
  ctx.drawImage(off, 0, 0, displayWidth, displayHeight);
  renderCropOverlay();
  syncZoomUI();
}

function renderCropOverlay() {
  const displayWidth = state.canvasDisplayWidth || Math.round((state.imgWidth || 0) * state.zoom);
  const displayHeight = state.canvasDisplayHeight || Math.round((state.imgHeight || 0) * state.zoom);
  cropCtx.clearRect(0, 0, displayWidth, displayHeight);
  if (!state.cropRect) return;
  const { x, y, w, h } = state.cropRect;
  const z = state.zoom;
  const [cx, cy, cw, ch] = [x*z, y*z, w*z, h*z];
  cropCtx.fillStyle = 'rgba(0,0,0,0.52)';
  cropCtx.fillRect(0, 0, displayWidth, displayHeight);
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
  const beforeData = state.compareBeforeImageData || state.originalImageData;
  const afterData = state.compareAfterImageData || state.processedImageData;
  if (!beforeData || !afterData) return;

  const viewW = afterData.width;
  const viewH = afterData.height;
  const displayWidth = Math.round(viewW * state.zoom);
  const displayHeight = Math.round(viewH * state.zoom);
  setupCanvasResolution(displayWidth, displayHeight);

  const afterOff = new OffscreenCanvas(afterData.width, afterData.height);
  const afterCtx = afterOff.getContext('2d');
  afterCtx.putImageData(afterData, 0, 0);
  const afterBitmap = afterOff.transferToImageBitmap();

  const beforeOff = new OffscreenCanvas(beforeData.width, beforeData.height);
  const beforeCtx = beforeOff.getContext('2d');
  beforeCtx.putImageData(beforeData, 0, 0);
  const beforeBitmap = beforeOff.transferToImageBitmap();

  ctx.imageSmoothingEnabled = state.zoom < 1 || beforeData.width !== viewW || beforeData.height !== viewH;
  if ('imageSmoothingQuality' in ctx) {
    ctx.imageSmoothingQuality = 'high';
  }

  const splitX = Math.max(0, Math.min(mouseX, displayWidth));
  ctx.drawImage(afterBitmap, 0, 0, displayWidth, displayHeight);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, splitX, displayHeight); ctx.clip();
  ctx.drawImage(beforeBitmap, 0, 0, displayWidth, displayHeight);
  ctx.restore();

  beforeBitmap.close();
  afterBitmap.close();

  ctx.strokeStyle = '#c47335'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(splitX, 0); ctx.lineTo(splitX, displayHeight); ctx.stroke();
  ctx.font = 'bold 11px -apple-system,sans-serif';
  ctx.fillStyle='rgba(0,0,0,.72)';
  ctx.fillRect(8, 8, 72, 20);
  ctx.fillRect(splitX + 8, 8, 68, 20);
  ctx.fillStyle='#fff';
  ctx.fillText('Before', 12, 22);
  ctx.fillText('After', splitX + 12, 22);
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
  releaseUpscaledPreviewBitmap();
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
  state.compareBeforeImageData = cropped;
  state.compareAfterImageData = cropped;
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
  updateInfoFileSize();
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(2) + ' MB';
}

function updateInfoFileSize() {
  const el = $('infoFileSize');
  if (!state.currentImageData) {
    el.textContent = '—';
    return;
  }

  const format = normalizeExportFormat(state.format);
  const mime = EXPORT_MIME_BY_FORMAT[format] || 'image/png';
  const q = format === 'png' ? undefined : state.quality;
  const requestId = ++infoFileSizeRequestId;

  buildOutputCanvas().toBlob(blob => {
    if (requestId !== infoFileSizeRequestId) return;

    if (blob && blob.size > 0) {
      el.textContent = formatBytes(blob.size);
      return;
    }

    if (Number.isFinite(state.fileSizeBytes) && state.fileSizeBytes > 0) {
      el.textContent = formatBytes(state.fileSizeBytes);
      return;
    }

    const raw = state.currentImageData.data.byteLength;
    const estimated = Math.round(raw * 0.22);
    el.textContent = formatBytes(estimated) + ' (est.)';
  }, mime, q);
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

const EXPORT_MIME_BY_FORMAT = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
});

function normalizeExportFormat(format) {
  if (typeof format !== 'string') return 'png';
  const normalized = format.toLowerCase();
  return EXPORT_MIME_BY_FORMAT[normalized] ? normalized : 'png';
}

function download() {
  const format = normalizeExportFormat(state.format);
  if (format !== state.format) state.format = format;
  const mime = EXPORT_MIME_BY_FORMAT[format];
  const q = format === 'png' ? undefined : state.quality;
  const ext = format === 'jpeg' ? 'jpg' : format;
  buildOutputCanvas().toBlob(blob => {
    if (!blob) return alert('Cannot export image.');
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: `gemini-${Date.now()}.${ext}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    state.fileSizeBytes = blob.size;
    updateInfoPanel();
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

async function fetchUpscaledImageViaBackground(urls, retriesPerUrl = 3) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'FETCH_UPSCALED_IMAGE_FROM_URLS', urls, retriesPerUrl },
      res => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (res?.key) return resolve(res);
        reject(new Error(res?.error || 'Background fetch failed'));
      }
    );
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
  releaseUpscaledPreviewBitmap();
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
    state.compareBeforeImageData = state.originalImageData;
    state.compareAfterImageData = state.processedImageData;

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
  if (!state.compareMode) {
    renderCanvas();
  } else {
    const splitX = Math.round((state.canvasDisplayWidth || Math.round((state.imgWidth || 0) * state.zoom)) / 2);
    renderCompare(splitX);
  }
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
document.querySelectorAll('.fmt-btn[data-fmt]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fmt-btn[data-fmt]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.format = normalizeExportFormat(btn.dataset.fmt);
    $('qualityRow').style.display = state.format !== 'png' ? 'block' : 'none';
    updateInfoPanel();
  });
});
$('qualitySlider').addEventListener('input', e => {
  state.quality = e.target.value / 100;
  $('qualityDisplay').textContent = e.target.value + '%';
  updateInfoPanel();
});

$('toggleWatermark').addEventListener('change', e => {
  state.removeWatermark = e.target.checked;
  state.currentImageData = state.removeWatermark ? state.processedImageData : state.originalImageData;
  renderCanvas();
});

$('downloadBtn').addEventListener('click', download);
$('copyBtn').addEventListener('click', copyToClipboard);

// ── Upscale ────────────────────────────────────────────────────────

let upscaleScale = '2';
let isUpscaling = false;

$('scale2xBtn').addEventListener('click', () => {
  $('scale2xBtn').classList.add('active');
  $('scale4xBtn').classList.remove('active');
  upscaleScale = '2';
});
$('scale4xBtn').addEventListener('click', () => {
  $('scale4xBtn').classList.add('active');
  $('scale2xBtn').classList.remove('active');
  upscaleScale = '4';
});

function isLikelyUpscaledImageUrl(url) {
  if (typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return /(\.(png|jpe?g|webp|bmp|gif))(\?|$)/i.test(url) || /\/upscaler\/results\/[^/]+$/i.test(url);
}

function extractUpscaleDownloadUrl(statusData, scale) {
  const urls = extractUpscaleDownloadUrls(statusData, scale);
  return urls.length ? urls[0] : null;
}

function extractUpscaleDownloadUrls(statusData, scale) {
  if (!statusData || typeof statusData !== 'object') return [];
  const data = statusData.data || {};
  const scaleInt = parseInt(scale, 10);
  const scaleTag = Number.isFinite(scaleInt) && scaleInt > 0 ? `_${scaleInt}x.` : null;

  const urls = [];
  const addUrl = (url) => {
    if (!isLikelyUpscaledImageUrl(url)) return;
    const secureUrl = String(url).trim().replace(/^http:\/\//i, 'https://');
    if (!secureUrl || urls.includes(secureUrl)) return;
    urls.push(secureUrl);
  };

  addUrl(data.downloadUrl);
  if (Array.isArray(data.downloadUrls)) {
    data.downloadUrls.forEach(addUrl);
  }

  const fallbackKeys = ['resultUrl', 'result_url', 'url', 'download', 'downloadURL'];
  fallbackKeys.forEach((key) => addUrl(data[key]));

  if (!scaleTag) return urls;

  const scaleMatched = [];
  const others = [];
  for (const url of urls) {
    if (url.toLowerCase().includes(scaleTag)) scaleMatched.push(url);
    else others.push(url);
  }
  return [...scaleMatched, ...others];
}

function guessUpscaleDownloadUrl(code, scale, statusData) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]+$/.test(code)) return null;
  const scaleInt = parseInt(scale, 10);
  if (!Number.isFinite(scaleInt) || scaleInt <= 0) return null;

  const mimeType = String(statusData?.data?.imagemimetype || 'jpg').toLowerCase();
  const ext = mimeType === 'jpeg' ? 'jpg' : mimeType;
  if (!/^[a-z0-9]+$/.test(ext)) return null;

  return `https://get1.imglarger.com/upscaler/results/${code}_${scaleInt}x.${ext}`;
}

function collectUpscaleDownloadCandidates(primaryUrl, code, scale, statusData) {
  const candidates = [];
  const addCandidate = (url) => {
    if (typeof url !== 'string') return;
    const secureUrl = url.trim().replace(/^http:\/\//i, 'https://');
    if (!secureUrl || candidates.includes(secureUrl)) return;
    candidates.push(secureUrl);
  };

  addCandidate(primaryUrl);
  for (const url of extractUpscaleDownloadUrls(statusData, scale)) {
    addCandidate(url);
  }
  addCandidate(guessUpscaleDownloadUrl(code, scale, statusData));

  const scaleInt = parseInt(scale, 10);
  if (typeof code === 'string' && /^[A-Za-z0-9_-]+$/.test(code) && Number.isFinite(scaleInt) && scaleInt > 0) {
    ['jpg', 'jpeg', 'png', 'webp'].forEach((ext) => {
      addCandidate(`https://get1.imglarger.com/upscaler/results/${code}_${scaleInt}x.${ext}`);
    });
  }

  return candidates;
}

async function fetchUpscaledImageBlob(candidates, sourceWidth, sourceHeight, expectedFileSize) {
  let bestUpscaledResult = null;
  let firstValidResult = null;
  const expectedSize = Number.isFinite(expectedFileSize) && expectedFileSize > 0
    ? expectedFileSize
    : null;

  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;

      const blob = await res.blob();
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      const blobType = String(blob.type || '').toLowerCase();

      if (blob.size <= 0) continue;
      if (!contentType.startsWith('image/') && !blobType.startsWith('image/')) continue;

      let bitmap;
      try {
        bitmap = await createImageBitmap(blob);
      } catch (_) {
        continue;
      }

      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();

      const candidate = {
        blob,
        url,
        width,
        height,
        area: width * height,
        sizeBytes: blob.size,
        expectedDelta: expectedSize ? Math.abs(blob.size - expectedSize) : null,
        expectedQualified: expectedSize ? blob.size >= expectedSize * 0.8 : false
      };

      if (!firstValidResult) firstValidResult = candidate;

      const appearsUpscaled = width > sourceWidth || height > sourceHeight;
      if (!appearsUpscaled) continue;

      if (!bestUpscaledResult) {
        bestUpscaledResult = candidate;
        continue;
      }

      if (expectedSize) {
        if (candidate.expectedQualified && !bestUpscaledResult.expectedQualified) {
          bestUpscaledResult = candidate;
          continue;
        }
        if (!candidate.expectedQualified && bestUpscaledResult.expectedQualified) {
          continue;
        }

        if (candidate.expectedQualified && bestUpscaledResult.expectedQualified) {
          if (candidate.expectedDelta < bestUpscaledResult.expectedDelta) {
            bestUpscaledResult = candidate;
            continue;
          }
          if (candidate.expectedDelta > bestUpscaledResult.expectedDelta) {
            continue;
          }
        }
      }

      const largerArea = candidate.area > bestUpscaledResult.area;
      const sameArea = candidate.area === bestUpscaledResult.area;
      const largerSize = candidate.sizeBytes > bestUpscaledResult.sizeBytes;
      if (largerArea || (sameArea && largerSize)) {
        bestUpscaledResult = candidate;
      }
    } catch (_) {
      // Try next candidate URL.
    }
  }

  return bestUpscaledResult || firstValidResult;
}

async function fetchUpscaledImageBlobFromBackground(candidates, sourceWidth, sourceHeight, expectedFileSize) {
  let fetched;
  try {
    fetched = await fetchUpscaledImageViaBackground(candidates, 3);
  } catch (_) {
    return null;
  }

  if (!fetched?.key) return null;

  let dataUrl;
  try {
    dataUrl = await getStoredImageData(fetched.key);
  } catch (_) {
    return null;
  }

  let blob;
  try {
    const res = await fetch(dataUrl);
    blob = await res.blob();
  } catch (_) {
    return null;
  }

  if (!blob || blob.size <= 0) return null;

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (_) {
    return null;
  }

  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();

  const appearsUpscaled = width > sourceWidth || height > sourceHeight;
  if (!appearsUpscaled) return null;

  const expectedSize = Number.isFinite(expectedFileSize) && expectedFileSize > 0
    ? expectedFileSize
    : null;
  if (expectedSize && blob.size < expectedSize * 0.75) return null;

  return {
    blob,
    url: fetched.url || candidates[0],
    width,
    height,
    area: width * height,
    sizeBytes: blob.size,
    fetchedByBackground: true
  };
}

async function doUpscale() {
  if (isUpscaling) return;
  isUpscaling = true;
  const beforeUpscaleImageData = cloneImageData(state.currentImageData);
  const btn = $('doUpscaleBtn');
  const info = $('upscaleInfo');
  const container = $('canvasContainer');
  const overlay = $('upscaleCenterOverlay');
  const overText = $('upscaleCenterText');
  const overSubtext = $('upscaleCenterSubtext');
  
  btn.disabled = true;
  btn.textContent = 'Uploading...';
  info.style.display = 'block';
  info.textContent = 'Preparing image...';
  container.classList.add('upscaling');
  
  if (overlay) {
    overlay.classList.add('show');
    overText.textContent = 'Preparing image...';
    overSubtext.textContent = 'Please wait';
  }

  try {
    const blob = await new Promise(r => buildOutputCanvas().toBlob(r, 'image/png'));
    const formData = new FormData();
    formData.append('myfile', blob, 'upscale.png');
    formData.append('scaleRadio', upscaleScale);

    info.textContent = 'Uploading to server...';
    if (overlay) overText.textContent = 'Uploading to server...';
    
    const uploadRes = await fetch('https://get1.imglarger.com/api/UpscalerNew/UploadNew', {
      method: 'POST',
      body: formData
    });
    const uploadData = await uploadRes.json();
    if (!uploadData?.data?.code) throw new Error(uploadData?.msg || 'Upload failed');

    const code = uploadData.data.code;
    info.textContent = 'Upscaling... (may take 1-4 minutes)';
    if (overlay) {
      overText.textContent = 'AI is upscaling your image...';
      overSubtext.textContent = 'Please wait, this may take 1-4 minutes';
    }

    let downloadUrl = null;
    let lastStatus = 'pending';
    let latestStatusData = null;
    const pollDelayMs = 2500;
    const maxPollAttempts = upscaleScale === '4' ? 180 : 120;

    for (let i = 0; i < maxPollAttempts; i++) {
      await new Promise(r => setTimeout(r, pollDelayMs));

      let statusRes;
      try {
        statusRes = await fetch('https://get1.imglarger.com/api/UpscalerNew/CheckStatusNew', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, scaleRadio: parseInt(upscaleScale, 10) })
        });
      } catch (_) {
        // Keep polling if a transient network error happens.
        continue;
      }

      const statusRaw = await statusRes.text();
      let statusData = null;
      try {
        statusData = statusRaw ? JSON.parse(statusRaw) : null;
      } catch (_) {
        statusData = null;
      }
      latestStatusData = statusData;

      const status = String(statusData?.data?.status || '').toLowerCase();
      if (status) lastStatus = status;

      const elapsedSec = Math.round(((i + 1) * pollDelayMs) / 1000);
      info.textContent = `Upscaling... ${elapsedSec}s elapsed`;
      if (overlay) {
        overSubtext.textContent = `Please wait, elapsed ${elapsedSec}s`;
      }

      const terminalSuccessStatus = status === 'success' || status === 'done' || status === 'completed' || status === 'finished';

      const candidateUrl = extractUpscaleDownloadUrl(statusData, upscaleScale);
      if (candidateUrl) {
        downloadUrl = candidateUrl;
        if (terminalSuccessStatus) break;
      }

      if (terminalSuccessStatus && !downloadUrl) {
        const guessedUrl = guessUpscaleDownloadUrl(code, upscaleScale, statusData);
        if (guessedUrl) {
          downloadUrl = guessedUrl;
          break;
        }
      }

      if (status === 'failed' || status === 'error' || status === 'cancelled') {
        throw new Error('Upscale process failed');
      }
    }

    if (!downloadUrl) throw new Error(`Timeout waiting for upscale (last status: ${lastStatus})`);

    info.textContent = 'Downloading upscaled image...';
    btn.textContent = 'Downloading...';
    if (overlay) {
      overText.textContent = 'Processing and rendering...';
      overSubtext.textContent = 'Almost done!';
    }
    
    // Load upscaled image directly into current editor to avoid background string limits
    const sourceWidth = state.imgWidth;
    const sourceHeight = state.imgHeight;
    const expectedUpscaleSizeRaw = Number(latestStatusData?.data?.filesize);
    const expectedUpscaleSize = Number.isFinite(expectedUpscaleSizeRaw) && expectedUpscaleSizeRaw > 0
      ? expectedUpscaleSizeRaw
      : null;
    const candidateUrls = collectUpscaleDownloadCandidates(downloadUrl, code, upscaleScale, latestStatusData);
    let fetchedImage = await fetchUpscaledImageBlob(candidateUrls, sourceWidth, sourceHeight, expectedUpscaleSize);

    const directLooksLowQuality =
      fetchedImage &&
      expectedUpscaleSize &&
      fetchedImage.sizeBytes < expectedUpscaleSize * 0.8;

    if (!fetchedImage || directLooksLowQuality) {
      const backgroundFetchedImage = await fetchUpscaledImageBlobFromBackground(
        candidateUrls,
        sourceWidth,
        sourceHeight,
        expectedUpscaleSize
      );
      if (backgroundFetchedImage) {
        fetchedImage = backgroundFetchedImage;
      }
    }

    if (!fetchedImage) throw new Error('Could not download upscaled image from server');

    if (fetchedImage.width <= sourceWidth && fetchedImage.height <= sourceHeight) {
      throw new Error(`Server returned non-upscaled image (${fetchedImage.width}x${fetchedImage.height})`);
    }

    const imgBlob = fetchedImage.blob;
    state.fileSizeBytes = imgBlob.size;
    
    let bitmap;
    try {
      bitmap = await createImageBitmap(imgBlob);
    } catch (_) {
      throw new Error('Upscaled response is not a valid image');
    }
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = bitmap.width;
    tempCanvas.height = bitmap.height;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

    releaseUpscaledPreviewBitmap();
    state.upscaledPreviewBitmap = bitmap;
    state.upscaledPreviewBlobSize = imgBlob.size;
    state.useUpscaledPreviewBitmap = true;

    state.originalImageData = imageData;
    state.processedImageData = imageData; 
    state.currentImageData = imageData;
    state.compareBeforeImageData = beforeUpscaleImageData || state.originalImageData;
    state.compareAfterImageData = state.currentImageData;
    state.imgWidth = imageData.width;
    state.imgHeight = imageData.height;
    state.watermarkRule = null;
    state.cropRect = null;
    state.zoom = 1;
    state.compareMode = false;
    $('compareBtn').classList.remove('active');
    
    canvasWrapper.scrollLeft = 0;
    canvasWrapper.scrollTop = 0;
    fitToWindow();
    updateInfoPanel();
    updateCropInfo();

    const exportFormat = normalizeExportFormat(state.format);
    const exportMime = EXPORT_MIME_BY_FORMAT[exportFormat];
    const exportQuality = exportFormat === 'png' ? undefined : state.quality;
    const exportBlob = await new Promise(resolve => buildOutputCanvas().toBlob(resolve, exportMime, exportQuality));
    const sizeText = exportBlob?.size
      ? formatBytes(exportBlob.size)
      : formatBytes(fetchedImage.sizeBytes || imgBlob.size);
    const fetchRoute = fetchedImage.fetchedByBackground ? 'background' : 'direct';
    info.textContent = `Upscale applied: ${sourceWidth}x${sourceHeight} -> ${imageData.width}x${imageData.height} (${sizeText}, ${fetchRoute})`;
    setStatus('done', 'Upscaled Image');

  } catch (err) {
    info.textContent = 'Error: ' + err.message;
    console.error('[Upscale Error]', err);
  } finally {
    isUpscaling = false;
    container.classList.remove('upscaling');
    if (overlay) overlay.classList.remove('show');
    btn.disabled = false;
    btn.textContent = 'Upscale Image';
  }
}

$('doUpscaleBtn').addEventListener('click', doUpscale);

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