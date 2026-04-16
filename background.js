const imageStore = new Map();

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Read blob failed'));
    reader.readAsDataURL(blob);
  });
}

function normalizeCandidateUrls(urls) {
  const out = [];
  if (!Array.isArray(urls)) return out;

  for (const rawUrl of urls) {
    if (typeof rawUrl !== 'string') continue;
    const normalized = rawUrl.trim().replace(/^http:\/\//i, 'https://');
    if (!/^https:\/\//i.test(normalized)) continue;
    if (!out.includes(normalized)) out.push(normalized);
  }

  return out;
}

async function fetchImageUrlWithRetries(url, attempts = 3) {
  let lastError = null;
  const maxAttempts = Math.max(1, attempts);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const separator = url.includes('?') ? '&' : '?';
      const cacheBustedUrl = `${url}${separator}cb=${Date.now()}_${attempt}`;
      const res = await fetch(cacheBustedUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const blob = await res.blob();
      if (!blob || blob.size <= 0) throw new Error('Empty image response');

      const contentType = String(blob.type || res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.startsWith('image/')) throw new Error('Response is not an image');

      const dataUrl = await blobToDataUrl(blob);
      return { dataUrl, size: blob.size, contentType };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Fetch failed');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_EDITOR') {
    captureImageOriginal(message.imageUrl)
      .then(key => {
        if (message.mode === 'download') {
          const url = chrome.runtime.getURL('editor.html') + '?key=' + key + '&autoDownload=1';
          chrome.tabs.create({ url, active: false });
        } else {
          const url = chrome.runtime.getURL('editor.html') + '?key=' + key;
          chrome.tabs.create({ url, active: true });
        }
        sendResponse({ ok: true });
      })
      .catch(err => {
        console.error('[GWR]', err.message);
        sendResponse({ error: err.message });
      });
    return true;
  }

  if (message.type === 'STORE_LOCAL_IMAGE') {
    const storeKey = 'img_' + Date.now();
    imageStore.set(storeKey, message.dataUrl);
    setTimeout(() => imageStore.delete(storeKey), 10 * 60 * 1000);
    sendResponse({ key: storeKey });
    return false;
  }

  if (message.type === 'GET_IMAGE_DATA') {
    const data = imageStore.get(message.key);
    imageStore.delete(message.key);
    sendResponse(data ? { dataUrl: data } : { error: 'Data not found' });
    return false;
  }

  if (message.type === 'STORE_LOCAL_IMAGE_FROM_URL') {
    fetch(message.url)
      .then(res => {
        if (!res.ok) throw new Error('Fetch failed');
        return res.blob();
      })
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const storeKey = 'img_' + Date.now();
          imageStore.set(storeKey, reader.result);
          setTimeout(() => imageStore.delete(storeKey), 10 * 60 * 1000);
          sendResponse({ key: storeKey });
        };
        reader.onerror = () => sendResponse({ error: 'Read blob failed' });
        reader.readAsDataURL(blob);
      })
      .catch(err => {
        sendResponse({ error: err.message });
      });
    return true; // Keep message channel open
  }

  if (message.type === 'FETCH_UPSCALED_IMAGE_FROM_URLS') {
    const urls = normalizeCandidateUrls(message.urls);
    const retriesPerUrl = Number.isFinite(Number(message.retriesPerUrl))
      ? Math.max(1, Number(message.retriesPerUrl))
      : 3;

    (async () => {
      if (!urls.length) {
        sendResponse({ error: 'No candidate URLs provided' });
        return;
      }

      let lastError = null;
      for (const url of urls) {
        try {
          const fetched = await fetchImageUrlWithRetries(url, retriesPerUrl);
          const storeKey = 'img_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
          imageStore.set(storeKey, fetched.dataUrl);
          setTimeout(() => imageStore.delete(storeKey), 10 * 60 * 1000);
          sendResponse({ key: storeKey, url, size: fetched.size, contentType: fetched.contentType });
          return;
        } catch (err) {
          lastError = err;
        }
      }

      sendResponse({ error: lastError?.message || 'Could not fetch upscaled image from any URL' });
    })();

    return true;
  }
});

async function captureImageOriginal(imageUrl) {
  const fullUrl = normalizeUrl(imageUrl);
  try {
    const res = await fetch(fullUrl);
    if (!res.ok) throw new Error('Failed to fetch image from Google servers');
    const blob = await res.blob();
    const reader = new FileReader();

    return new Promise((resolve, reject) => {
      reader.onloadend = () => {
        const storeKey = 'img_' + Date.now();
        imageStore.set(storeKey, reader.result);
        setTimeout(() => imageStore.delete(storeKey), 10 * 60 * 1000);
        resolve(storeKey);
      };
      reader.onerror = () => reject(new Error('Failed to read image blob'));
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    throw new Error('Image fetch error: ' + err.message);
  }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    // Strip existing sizing parameters
    if (path.includes('=')) {
      path = path.split('=')[0]; 
    }
    // Request the original size without the '-d' flag to avoid CORS redirects
    parsed.pathname = path + '=s0';
    return parsed.toString();
  } catch { 
    return url; 
  }
}
