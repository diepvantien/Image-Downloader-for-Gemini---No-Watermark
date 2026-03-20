document.addEventListener('DOMContentLoaded', () => {
  const toggleExt = document.getElementById('toggleExt');
  const fileInput = document.getElementById('fileInput');
  const uploadLabel = document.getElementById('uploadLabel');
  const errorText = document.getElementById('errorText');

  // Load toggle state
  chrome.storage.local.get({'extensionEnabled': true}, res => {
    if(toggleExt) toggleExt.checked = res.extensionEnabled;
  });

  // Save toggle state
  if(toggleExt) {
    toggleExt.addEventListener('change', () => {
      chrome.storage.local.set({'extensionEnabled': toggleExt.checked});
    });
  }

  // File selection & Auto-process
  if(fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (!file.type.match(/image\/(png|jpeg|webp)/)) {
        errorText.textContent = 'Invalid file type. Use PNG, JPEG, or WebP.';
        errorText.style.display = 'block';
        return;
      }
      errorText.style.display = 'none';

      // Show loading state
      const originalHtml = uploadLabel.innerHTML;
      uploadLabel.innerHTML = '<div class="up-text" style="padding:10px 0">⏳ Processing...</div>';
      uploadLabel.style.pointerEvents = 'none';

      const reader = new FileReader();
      reader.onload = (event) => {
        chrome.runtime.sendMessage({ 
          type: 'STORE_LOCAL_IMAGE', 
          dataUrl: event.target.result 
        }, (res) => {
          if (!res || !res.key) {
            errorText.textContent = 'Error storing image. Try again.';
            errorText.style.display = 'block';
            uploadLabel.innerHTML = originalHtml;
            uploadLabel.style.pointerEvents = 'auto';
            return;
          }

          // Open editor tab automatically
          let url = chrome.runtime.getURL('editor.html') + '?key=' + res.key;
          chrome.tabs.create({ url, active: true });
          
          // Close popup
          setTimeout(() => window.close(), 150);
        });
      };
      reader.readAsDataURL(file);
    });
  }
});