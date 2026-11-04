import { URL } from 'url';

export function isUrlAllowed(urlStr, config = {}) {
  if (!urlStr) return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const allowedStr = config.webAllowedDomains || '';
    if (!allowedStr.trim()) {
      if (config.webStrictScopeEnabled) {
        return false; // Strict scope requires allowed domains to be set!
      }
      return true; // No restriction (all allowed)
    }

    const allowedDomains = allowedStr.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    const hostname = parsed.hostname.toLowerCase();

    return allowedDomains.some(domain => {
      return hostname === domain || hostname.endsWith('.' + domain);
    });
  } catch {
    return false;
  }
}
