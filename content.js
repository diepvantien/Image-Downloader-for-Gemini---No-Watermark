// content.js — Injected into gemini.google.com

const CONTAINER_SELECTOR = 'generated-image, .generated-image-container';
const MIN_EDGE = 128;
const PROCESSED_ATTR = 'gwrProcessed';

function isGoogleusercontentUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'googleusercontent.com' || hostname.endsWith('.googleusercontent.com');
  } catch { return false; }
}

function isMeaningfulSize(img) {
  const w = Math.max(img.naturalWidth || 0, img.clientWidth || 0);
  const h = Math.max(img.naturalHeight || 0, img.clientHeight || 0);
  return w >= MIN_EDGE || h >= MIN_EDGE;
}

function resolveImageUrl(img) {
  return img.currentSrc || img.src || '';
}

function isEligible(img) {
  if (!img || img.dataset[PROCESSED_ATTR]) return false;
  const inContainer = !!(img.closest && img.closest(CONTAINER_SELECTOR));
  if (!inContainer && !isMeaningfulSize(img)) return false;
  const url = resolveImageUrl(img);
  return url.length > 0 && isGoogleusercontentUrl(url);
}

function injectButtons(img) {
  if (img.dataset[PROCESSED_ATTR]) return;
  img.dataset[PROCESSED_ATTR] = '1';

  const container = (img.closest && img.closest(CONTAINER_SELECTOR)) || img.parentElement;
  if (!container) return;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  const wrap = document.createElement('div');
  wrap.className = 'gwr-btn-wrap';

  // Quick download button
  const dlBtn = document.createElement('button');
  dlBtn.className = 'gwr-btn gwr-btn-dl';
  dlBtn.title = 'Quick Download (PNG, no watermark)';
  dlBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Quick Download</span>`;

  // Edit button
  const editBtn = document.createElement('button');
  editBtn.className = 'gwr-btn gwr-btn-edit';
  editBtn.title = 'Open Image Editor';
  editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><span>Edit</span>`;

  function handleAction(btn, mode) {
    const url = resolveImageUrl(img);
    if (!url) { alert('[GWR] Failed to retrieve image URL'); return; }
    btn.disabled = true;
    btn.querySelector('span').textContent = '⏳ Loading...';
    chrome.runtime.sendMessage({ type: 'OPEN_EDITOR', imageUrl: url, mode }, (res) => {
      btn.disabled = false;
      btn.querySelector('span').textContent = btn === dlBtn ? 'Quick Download' : 'Edit';
      if (!res?.ok) {
        btn.querySelector('span').textContent = '✗ Error';
        setTimeout(() => { btn.querySelector('span').textContent = btn === dlBtn ? 'Quick Download' : 'Edit'; }, 2500);
        console.error('[GWR]', res?.error);
      }
    });
  }

  dlBtn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); handleAction(dlBtn, 'download'); });
  editBtn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); handleAction(editBtn, 'edit'); });

  wrap.appendChild(dlBtn);
  wrap.appendChild(editBtn);
  container.appendChild(wrap);
}

function scanImages() {
  CONTAINER_SELECTOR.split(',').forEach(sel => {
    document.querySelectorAll(sel.trim() + ' img').forEach(img => {
      if (isEligible(img)) injectButtons(img);
    });
  });
  document.querySelectorAll('img').forEach(img => {
    if (isEligible(img) && isMeaningfulSize(img)) injectButtons(img);
  });
}

let isEnabled = true;

chrome.storage.local.get({'extensionEnabled': true}, res => {
  isEnabled = res.extensionEnabled;
  if (isEnabled) scanImages();
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.extensionEnabled !== undefined) {
    isEnabled = changes.extensionEnabled.newValue;
    if (isEnabled) {
      scanImages();
    } else {
      document.querySelectorAll('.gwr-btn-wrap').forEach(el => el.remove());
      document.querySelectorAll('[' + PROCESSED_ATTR + ']').forEach(img => {
        delete img.dataset[PROCESSED_ATTR];
      });
    }
  }
});

new MutationObserver(() => {
  if (isEnabled) scanImages();
}).observe(document.body, { childList: true, subtree: true });
