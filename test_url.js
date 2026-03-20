function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    // Strip existing sizing parameters
    if (path.includes('=')) {
      path = path.split('=')[0]; 
    }
    // Force true original dimensions
    parsed.pathname = path + '=s0-d';
    return parsed.toString();
  } catch { 
    return url; 
  }
}
console.log(normalizeUrl("https://lh3.googleusercontent.com/pw/AP1GczM=w400-h300-no"));
