const imageStore = new Map();

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
    // Force true original dimensions and format (can cause CORS with /rd-gg-dl/ sometimes)
    // parsed.pathname = path + '=s0-d';
    // We stick with the basic image to prevent Chrome preventing redirects.
    parsed.pathname = path;
    return parsed.toString();
  } catch { 
    return url; 
  }
}
