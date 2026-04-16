
function resolveImageUrl(imgElement) {
  let url = imgElement.src || '';
  if (url.startsWith('blob:')) return url;
  if (!url.includes('googleusercontent.com')) return url;

  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/');
  
  if (pathParts.length > 2 && pathParts[pathParts.length - 1].includes('=')) {
    pathParts.pop();
    urlObj.pathname = pathParts.join('/');
  }
  return urlObj.toString() + '=s0';
}

function createButton(svgIcon, title) {
    const btn = document.createElement('button');
    btn.style.cssText = `
      position: relative;
      background: rgba(255, 255, 255, 0.2);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.6);
      color: white;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      transition: all 0.2s ease;
      padding: 0;
      margin: 0;
    `;
    
    const iconWrapper = document.createElement('div');
    iconWrapper.innerHTML = svgIcon;
    iconWrapper.style.display = 'flex';
    
    const tooltip = document.createElement('div');
    tooltip.innerText = title;
    tooltip.style.cssText = `
      position: absolute;
      bottom: 48px;
      left: 50%;
      transform: translateX(-50%) translateY(8px);
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: all 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    `;

    btn.appendChild(iconWrapper);
    btn.appendChild(tooltip);

    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(255, 255, 255, 0.4)';
      btn.style.transform = 'scale(1.1)';
      tooltip.style.opacity = '1';
      tooltip.style.transform = 'translateX(-50%) translateY(0)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(255, 255, 255, 0.2)';
      btn.style.transform = 'scale(1)';
      tooltip.style.opacity = '0';
      tooltip.style.transform = 'translateX(-50%) translateY(8px)';
    });

    return btn;
}

function installButtonsInContainer(img) {
    if (!img.src || img.src.startsWith('data:')) return;
    if (img.width < 100 && img.height < 100) return;
    const isGoogleImage = img.src.includes('googleusercontent.com') || img.src.startsWith('blob:');
    if (!isGoogleImage) return;

    let container = img.parentElement;
    if (container.style.position !== 'relative' && container.style.position !== 'absolute') {
      container.style.position = 'relative';
    }

    if (container.querySelector('.gw-action-container')) return;

    const actionContainer = document.createElement('div');
    actionContainer.className = 'gw-action-container';
    
    actionContainer.style.position = 'absolute';
    actionContainer.style.bottom = '15px';
    actionContainer.style.left = '50%';
    actionContainer.style.transform = 'translateX(-50%)';
    actionContainer.style.display = 'flex';
    actionContainer.style.gap = '15px';
    actionContainer.style.zIndex = '9999';

    const downloadIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    const originalBtn = createButton(downloadIcon, 'Download');
    
    const penIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
    const removeBtn = createButton(penIcon, 'Edit');

    originalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const realUrl = resolveImageUrl(img);
      chrome.runtime.sendMessage({ type: 'OPEN_EDITOR', imageUrl: realUrl, mode: 'download' });
    });

    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const resolvedUrl = resolveImageUrl(img);
      chrome.runtime.sendMessage({ type: 'OPEN_EDITOR', imageUrl: resolvedUrl, mode: 'editor' });
    });

    actionContainer.appendChild(originalBtn);
    actionContainer.appendChild(removeBtn);
    container.appendChild(actionContainer);
}

function installDownloadButtons() {
  document.querySelectorAll('img').forEach((img) => installButtonsInContainer(img));
}

function observeShadowDom(element) {
  if (element.shadowRoot) {
    installDownloadButtonsInText(element.shadowRoot);
    const shadowObserver = new MutationObserver(() => installDownloadButtonsInText(element.shadowRoot));
    shadowObserver.observe(element.shadowRoot, { childList: true, subtree: true });
  }

  Array.from(element.children).forEach(child => observeShadowDom(child));
}

function installDownloadButtonsInText(root) {
  const images = root.querySelectorAll('img');
  images.forEach(img => installButtonsInContainer(img));
}

function processAllShadowDoms() {
  document.querySelectorAll('*').forEach(el => observeShadowDom(el));
}

const mainObserver = new MutationObserver(() => {
  installDownloadButtons();
  processAllShadowDoms();
});

mainObserver.observe(document.body, { childList: true, subtree: true });
installDownloadButtons();
processAllShadowDoms();
