// Subul Auth Detection — Content Script
// Runs on app.subul.uk to detect when the user successfully logs in.

(function () {
  'use strict';

  const CHECK_INTERVAL = 1500;
  const MAX_CHECKS = 120;
  const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
  let checks = 0;
  let lastToken = null;
  let sent = false;
  let authRequestedAt = 0;
  let checkTimer = null;

  function authRequestActive(ts = authRequestedAt) {
    return !!ts && (Date.now() - ts) < AUTH_REQUEST_TTL_MS;
  }

  function startAuthChecks(ts) {
    authRequestedAt = ts || Date.now();
    checks = 0;
    lastToken = null;
    sent = false;
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    checkForLogin();
  }

  function getSubulToken() {
    // ── 1. Broad JWT scan across localStorage ──
    for (const key of Object.keys(localStorage)) {
      const val = localStorage.getItem(key);
      if (val && val.length > 40 && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val.trim())) {
        return { key, token: val.trim(), src: 'localStorage' };
      }
      // Value might be JSON with a token field inside
      if (val && val.startsWith('{')) {
        try {
          const obj = JSON.parse(val);
          for (const field of ['token', 'accessToken', 'access_token', 'jwt', 'idToken', 'id_token']) {
            if (obj[field] && typeof obj[field] === 'string' && /^eyJ/.test(obj[field])) {
              return { key: `${key}.${field}`, token: obj[field], src: 'localStorage-nested' };
            }
          }
        } catch {}
      }
    }

    // ── 2. Same for sessionStorage ──
    for (const key of Object.keys(sessionStorage)) {
      const val = sessionStorage.getItem(key);
      if (val && val.length > 40 && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val.trim())) {
        return { key, token: val.trim(), src: 'sessionStorage' };
      }
      if (val && val.startsWith('{')) {
        try {
          const obj = JSON.parse(val);
          for (const field of ['token', 'accessToken', 'access_token', 'jwt', 'idToken', 'id_token']) {
            if (obj[field] && typeof obj[field] === 'string' && /^eyJ/.test(obj[field])) {
              return { key: `${key}.${field}`, token: obj[field], src: 'sessionStorage-nested' };
            }
          }
        } catch {}
      }
    }

    // ── 3. Cookie scan for JWT ──
    for (const part of document.cookie.split(';')) {
      const [k, v] = part.trim().split('=');
      if (v && v.length > 40 && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) {
        return { key: k, token: v, src: 'cookie' };
      }
    }

    return null;
  }

  function getUserInfo() {
    for (const store of [localStorage, sessionStorage]) {
      for (const key of Object.keys(store)) {
        try {
          const val = JSON.parse(store.getItem(key));
          if (val && (val.email || val.fullName || val.name)) {
            return { email: val.email || '', name: val.fullName || val.name || '' };
          }
        } catch {}
      }
    }
    return null;
  }

  function relayToken(tokenData) {
    if (sent) return;
    const userInfo = getUserInfo();
    try {
      chrome.runtime.sendMessage({
        action: 'subulTokenDetected',
        data: {
          subul_token: tokenData.token,
          email: userInfo?.email || '',
          name: userInfo?.name || '',
        },
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[SubulIN] sendMessage error:', chrome.runtime.lastError.message);
          return;
        }
        if (response?.success) {
          sent = true;
          showLoginBanner('✅ Connected to Subul IN! You can close this tab and return to the extension.');
        } else {
          showLoginBanner('⚠️ Subul IN: Auth failed — ' + (response?.error || 'unknown error'));
        }
      });
    } catch (e) {
      console.warn('[SubulIN] Exception sending message:', e);
    }
  }

  function checkForLogin() {
    if (sent) {
      checkTimer = null;
      return;
    }
    if (!authRequestActive()) {
      checkTimer = null;
      return;
    }
    checks++;
    if (checks > MAX_CHECKS) {
      checkTimer = null;
      return;
    }

    const tokenData = getSubulToken();
    if (tokenData && tokenData.token !== lastToken) {
      lastToken = tokenData.token;
      relayToken(tokenData);
    }

    checkTimer = setTimeout(checkForLogin, CHECK_INTERVAL);
  }

  function showLoginBanner(message) {
    // Remove existing banner if any
    document.getElementById('subul-in-banner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'subul-in-banner';
    banner.textContent = message;
    Object.assign(banner.style, {
      position: 'fixed', top: '0', left: '0', right: '0', zIndex: '99999',
      padding: '14px 20px', background: sent ? '#057642' : '#b91c1c', color: '#fff',
      fontSize: '14px', fontWeight: '600', textAlign: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    });
    document.body?.appendChild(banner);
    if (sent) setTimeout(() => banner.remove(), 8000);
  }

  chrome.runtime.onMessage.addListener((req) => {
    if (req?.action === 'subulStartAuth') {
      const ts = Date.now();
      chrome.storage.local.set({ subulAuthRequestedAt: ts });
      startAuthChecks(ts);
    }
  });

  chrome.storage.local.get(['subulAuthRequestedAt'], ({ subulAuthRequestedAt }) => {
    if (authRequestActive(subulAuthRequestedAt)) {
      startAuthChecks(subulAuthRequestedAt);
    }
  });
})();
