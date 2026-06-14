// ===============================================================
// BACKGROUND -- FastAPI backend calls
// ===============================================================

// Local ports to probe -- 8010 is default, 8000 is uvicorn default (common mistake), others are fallbacks
const _LOCAL_PORTS = [8010, 8000, 8013, 8014, 8015, 8016];
const _AZURE_URL   = 'https://subulin-api.azurewebsites.net';

// ── Parallel port probing ─────────────────────────────────────────────────────
// All ports are probed SIMULTANEOUSLY. First successful response wins.
// This cuts worst-case latency from 18 s (serial) down to ~1.2 s (parallel).
async function _probeOnePort(port) {
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1200) });
  if (!res.ok) throw new Error('not ok');
  const data = await res.json().catch(() => ({}));
  if (!data.version) throw new Error('no version');
  // Verify the critical ai-score endpoint exists (405/422 = registered, ok = fallback)
  const cap = await fetch(`${base}/profile/ai-score`, { method: 'GET', signal: AbortSignal.timeout(1200) });
  if (cap.status === 405 || cap.status === 422 || cap.ok) return base;
  throw new Error('endpoint missing');
}

async function _probeLocalBackend() {
  // Round 1: full check (health version + ai-score endpoint) — all ports in parallel
  try {
    return await Promise.any(_LOCAL_PORTS.map(p => _probeOnePort(p)));
  } catch { /* all failed full check */ }

  // Round 2: lenient fallback — any port with gap-analysis registered
  try {
    return await Promise.any(_LOCAL_PORTS.map(async port => {
      const base = `http://127.0.0.1:${port}`;
      const cap = await fetch(`${base}/profile/gap-analysis`, { method: 'GET', signal: AbortSignal.timeout(1200) });
      if (cap.status === 405 || cap.status === 422 || cap.ok) return base;
      throw new Error('not found');
    }));
  } catch { /* all ports unavailable */ }

  return null;
}

let _cachedBase     = null;
let _cacheTs        = 0;
const _CACHE_TTL    = 300000; // 5 min — backend URL doesn't change during a session

// In-memory auth token cache — avoids a chrome.storage.sync IPC read on every API call
let _cachedAuthToken = null;
function _setAuthToken(token) { _cachedAuthToken = token || null; }
function _clearAuthToken()    { _cachedAuthToken = null; }
async function _getAuthToken() {
  if (_cachedAuthToken !== null) return _cachedAuthToken;
  const { authToken } = await chrome.storage.sync.get(['authToken']);
  _cachedAuthToken = authToken || null;
  return _cachedAuthToken;
}

async function getApiBase() {
  if (_cachedBase && Date.now() - _cacheTs < _CACHE_TTL) return _cachedBase;

  const [data] = await Promise.all([chrome.storage.sync.get(['serverUrl'])]);
  let url = (data.serverUrl || '').replace(/\/+$/, '');
  url = url.replace(/^(https?:\/\/)localhost\b/, '$1127.0.0.1');

  // Probe and saved-URL lookup run in parallel when possible
  const found = await _probeLocalBackend();
  if (found) {
    if (found !== url) chrome.storage.sync.set({ serverUrl: found }); // fire-and-forget
    _cachedBase = found;
    _cacheTs    = Date.now();
    return found;
  }

  // No local backend — use saved URL if valid, otherwise Azure
  const result = url || _AZURE_URL;
  if (result === _AZURE_URL) chrome.storage.sync.set({ serverUrl: _AZURE_URL }); // fire-and-forget
  _cachedBase = result;
  _cacheTs    = Date.now();
  return result;
}

// Per-route timeouts in ms. Heavy LLM endpoints (gap analysis, interview prep,
// job fit) need ≥180s because Azure can take 60-120s under load. 55s was the
// cause of the "signal timed out" failure mid-generation.
const _AI_ROUTE_TIMEOUTS = {
  '/agent/full-analysis':    240000,  // LangGraph: 3-4 chained LLM calls (Level 1 + Level 2)
  '/profile/gap-analysis':   180000,
  '/api/interview-prep':     180000,
  '/api/job-fit-analysis':   150000,
  '/profile/ai-score':       120000,
  '/networking/analyze':     150000,
  '/generate-post':           90000,
  '/generate-profile':        60000,
  '/networking/message':      45000,
  '/networking/chat':         60000,
  '/conversation-coach':      45000,
  '/route-chat':              60000,
};

async function callBackend(route, payload = {}, method = 'POST') {
  // Resolve base URL and auth token in parallel — saves one serial round-trip
  const [base, authToken] = await Promise.all([getApiBase(), _getAuthToken()]);

  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const timeoutMs = _AI_ROUTE_TIMEOUTS[route] || 12000;
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: method !== 'GET' ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Token expired — clear everything and notify popup
  if (response.status === 401) {
    _clearAuthToken();
    await chrome.storage.sync.remove(['authToken', 'authEmail']);
    chrome.runtime.sendMessage({ action: 'tokenExpired' }).catch(() => {});
    throw new Error('Session expired. Please log in again.');
  }

  // 404 may mean a stale cached URL — re-probe once and retry
  if (response.status === 404) {
    _cachedBase = null; _cacheTs = 0;
    await chrome.storage.sync.remove('serverUrl');
    const freshBase = await _probeLocalBackend();
    if (freshBase && freshBase !== base) {
      chrome.storage.sync.set({ serverUrl: freshBase });
      const retryToken = await _getAuthToken();
      const retryHeaders = { 'Content-Type': 'application/json' };
      if (retryToken) retryHeaders['Authorization'] = `Bearer ${retryToken}`;
      const retry = await fetch(`${freshBase}${route}`, {
        method,
        headers: retryHeaders,
        body: method !== 'GET' ? JSON.stringify(payload) : undefined,
      });
      if (retry.status === 401) {
        _clearAuthToken();
        await chrome.storage.sync.remove(['authToken', 'authEmail']);
        chrome.runtime.sendMessage({ action: 'tokenExpired' }).catch(() => {});
        throw new Error('Session expired. Please log in again.');
      }
      if (retry.ok) return retry.json();
    }
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Server error ${response.status}: ${err.substring(0, 200)}`);
  }

  return response.json();
}

async function getBackend(route) {
  // Reuse callBackend for GET — avoids duplicating token + base logic
  return callBackend(route, {}, 'GET');
}

// ?? Message listener ??
chrome.runtime.onMessage.addListener((req, _sender, respond) => {
  const handlers = {
    generatePost,
    generateProfile,
    testConnection,
    routeChat,
    saveProfileSnapshot,
    loginUser,
    registerUser,
    loginWithSubul,
    networkingOnboarding,
    networkingGetProfile,
    networkingScore,
    networkingMessage,
    networkingInteraction,
    networkingMessageOutcome,
    networkingOutcome,
    scheduleOutcomeCheck,
    deepScanProfiles,
    networkingAnalyze,
    networkingChat,
    profileGapAnalysis,
    profileAiScore,
    updateNotifPrefs,
    sendNotification,
    conversationCoach,
    saveMyProfile,
    getMyProfile,
    subulTokenDetected,
    subulSync,
    getSubulData,
    markSubulEarned,
    logScrapeQuality,
    interviewPrep,
    jobFitAnalysis,
    markUserActive,
  };
  const fn = handlers[req.action];
  if (fn) {
    fn(req.data)
      .then(r => respond({ success: true, data: r }))
      .catch(e => respond({ success: false, error: e.message }));
    return true;
  }
});

async function generatePost(data) {
  const result = await callBackend('/generate-post', data);
  return result.data;
}

async function generateProfile(data) {
  const result = await callBackend('/generate-profile', data);
  return result.data;
}

async function routeChat(data) {
  const result = await callBackend('/route-chat', data);
  return result.data;
}

async function saveProfileSnapshot(data) {
  const result = await callBackend('/profile-snapshot', data);
  return result.data;
}

// ?? Save LinkedIn profile to user document in Cosmos DB ??
async function saveMyProfile(data) {
  const result = await callBackend('/user/profile', data, 'POST');
  return result.data;
}

// ?? Get saved LinkedIn profile from Cosmos DB ??
async function getMyProfile() {
  const base = await getApiBase();
  const { authToken } = await chrome.storage.sync.get(['authToken']);
  const resp = await fetch(`${base}/user/profile`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
    },
  });
  if (!resp.ok) return null;
  // Backend returns { success: true, data: {...} } -- unwrap so the message
  // handler doesn't double-wrap it into { success: true, data: { success: true, data: {...} } }
  const json = await resp.json();
  return json?.data ?? null;
}

async function testConnection() {
  const base = await getApiBase();
  const response = await fetch(`${base}/test-connection`);
  if (!response.ok) throw new Error(`Server error ${response.status}`);
  const result = await response.json();
  return result.data;
}

async function loginUser({ email, password }) {
  const base = await getApiBase();
  const res  = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Login failed (${res.status})`);
  }
  const { token, email: userEmail } = await res.json();
  _setAuthToken(token); // prime in-memory cache immediately
  await chrome.storage.sync.set({ authToken: token, authEmail: userEmail });
  // Refresh earned flags from Cosmos immediately, then trigger full sync
  _refreshSubulDataFromBackend().catch(() => {});
  _triggerSubulSync().catch(() => {});
  return { email: userEmail };
}

async function registerUser({ email, password }) {
  const base = await getApiBase();
  const res  = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Registration failed (${res.status})`);
  }
  const { token, email: userEmail } = await res.json();
  _setAuthToken(token);
  await chrome.storage.sync.set({ authToken: token, authEmail: userEmail });
  return { email: userEmail };
}

async function loginWithSubul({ email, password }) {
  const base = await getApiBase();
  const res  = await fetch(`${base}/auth/subul-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Subul login failed (${res.status})`);
  }
  const { token, email: userEmail } = await res.json();
  _setAuthToken(token);
  await chrome.storage.sync.set({ authToken: token, authEmail: userEmail });
  // Refresh earned flags from Cosmos immediately, then trigger full sync
  _refreshSubulDataFromBackend().catch(() => {});
  _triggerSubulSync().catch(() => {});
  return { email: userEmail };
}

async function subulTokenDetected({ subul_token, email, name }) {
  // Called by the Subul content script when it detects a successful login.
  // Relay the Subul access token to our backend for verification + JWT creation.
  const base = await getApiBase();
  let lastErr = null;
  let data = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${base}/auth/subul-token-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subul_token, email, name }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Subul token login failed (${res.status})`);
      }
      data = await res.json();
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  if (!data) {
    throw new Error(lastErr?.message || 'Subul token login failed');
  }

  _setAuthToken(data.token);
  await chrome.storage.sync.set({ authToken: data.token, authEmail: data.email });

  // Notify the popup (if open) so it switches to main view immediately
  chrome.runtime.sendMessage({ action: 'subulLoginSuccess', email: data.email }).catch(() => {});

  // Refresh earned flags from Cosmos immediately, then trigger full sync
  _refreshSubulDataFromBackend().catch(() => {});
  _triggerSubulSync().catch(() => {});

  return { email: data.email };
}

// ?? Full rich profile scraper (same as popup.js inlineScrapeFunction) ????????
// Self-contained: runs inside the LinkedIn profile tab via executeScript.
async function richProfileScrapeFunction() {
  const _scrapeStart = Date.now();
  try {
    const url = location.href || '';
    const onProfile = /linkedin\.com\/in\//.test(url);

    // ── UTILITIES ──
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    // ── LAYER 0: JSON-LD structured data ─────────────────────────────────────
    // LinkedIn embeds a Person schema in <script type="application/ld+json">.
    // This is stable across React re-renders and class-hash changes — use it
    // as the primary source for name / headline / photo before any DOM parsing.
    function extractJsonLdData() {
      try {
        for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
          let d;
          try { d = JSON.parse(el.textContent); } catch { continue; }
          if (d && d['@type'] === 'Person') return d;
          // Sometimes it's an array
          if (Array.isArray(d)) {
            const person = d.find(x => x && x['@type'] === 'Person');
            if (person) return person;
          }
        }
      } catch { /* noop — never crash the scraper */ }
      return null;
    }
    const _jsonLd = extractJsonLdData();


    // Wait until DOM stops mutating (MutationObserver-based) — much more reliable than fixed delays
    // Watches childList (structural changes) AND src/data-* attributes for lazy-loaded images.
    function waitForDomStable(container = document.body, timeoutMs = 3000, settleMs = 300) {
      return new Promise(resolve => {
        let timer, resolved = false;
        const done = () => { if (!resolved) { resolved = true; obs.disconnect(); resolve(); } };
        const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, settleMs); });
        obs.observe(container, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src', 'data-delayed-url', 'data-ghost-url'],
        });
        timer = setTimeout(done, settleMs);
        setTimeout(done, timeoutMs); // hard cap
      });
    }

    // Resilient query: try multiple selectors in order, return first match
    const rq = (el, chain) => { for (const s of chain) { const r = el.querySelector(s); if (r) return r; } return null; };
    const rqa = (el, chain) => { for (const s of chain) { const r = el.querySelectorAll(s); if (r.length) return [...r]; } return []; };

    // Track sections that need detail page enrichment (have "Show all" <a> links)
    const _sectionsNeedingDetailPage = new Set();
    const _modalSkillCandidates = [];

    if (onProfile) {
      const maxH = () => document.body.scrollHeight;
      const sectionKeywords = /experience|expérience|experiencia|erfahrung|esperienza|experiência|خبرة|education|formation|educación|ausbildung|istruzione|educação|formação|تعليم|skills|compétences|habilidades|kenntnisse|competenze|competências|مهارات|certif|licen|volunteer|bénévolat|voluntariado|ehrenamt|volontariato|voluntariado|تطوع|project|projet|proyecto|projekt|progetto|projeto|مشاريع|language|langue|idioma|sprach|lingua|لغات|honor|award|publication|recommendation|organisation|course|curso|kurs|corso/i;

      // Detect SDUI layout (2025+ LinkedIn) — componentkey attributes present in DOM
      const isSDUI = document.querySelectorAll('div[componentkey]').length > 5;

      // ── SCROLL PASS 1: Progressive scroll until page height stabilizes ──
      // LinkedIn lazy-loads sections as they enter viewport via IntersectionObserver
      // SDUI: server-rendered, content mostly in DOM — limit iterations heavily
      let prevH = 0, stableCount = 0, scrollIter = 0;
      const maxScrollIter = isSDUI ? 5 : 14;
      while (stableCount < 2 && scrollIter < maxScrollIter) {
        for (let y = prevH; y < maxH(); y += (isSDUI ? 1200 : 600)) {
          window.scrollTo(0, y);
          await wait(isSDUI ? 30 : 60);
        }
        window.scrollTo(0, maxH());
        await wait(isSDUI ? 60 : 150);
        const h = maxH();
        if (h === prevH) stableCount++; else { stableCount = 0; prevH = h; }
        scrollIter++;
      }

      // ── SCROLL PASS 2: Section-targeted scroll ──
      // Scroll each section to center viewport — triggers section-level lazy loading
      // SDUI: skip — content is already server-rendered, no IntersectionObserver lazy loading
      if (!isSDUI) {
        for (const sec of document.querySelectorAll('section')) {
          const h = sec.querySelector('h2, h3');
          if (!h || !sectionKeywords.test(h.textContent)) continue;
          sec.scrollIntoView({ behavior: 'instant', block: 'center' });
          await waitForDomStable(sec, 800, 100);
          window.scrollBy(0, sec.offsetHeight || 400);
          await wait(60);
        }
      }

      // ── Click all inline "See more" / "Voir plus" buttons to expand collapsed text ──
      // SDUI: skip — descriptions are read directly from span[data-testid="expandable-text-box"]
      //       without needing button clicks (we clone + strip the button node in the parsers)
      const seeMoreRe = /\bsee more\b|\bvoir plus\b|\bvoir la totalit[eé]\b|\blire la suite\b|\bplus d['']infos?\b|\bmehr anzeigen\b|\bver más\b|\bvedi altro\b|\bver mais\b|\bمزيد\b|\bعرض المزيد\b|\bmostrar mais\b/i;
      const showAllRe = /show all|see all|voir (toutes?|tous)|alle anzeigen|ver todo|mostra tutti|ver tudo|mostrar todo|عرض الكل/i;
      if (!isSDUI) {
        for (const btn of document.querySelectorAll('button')) {
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const visibleSpan = btn.querySelector('span[aria-hidden="true"]');
          const visibleText = (visibleSpan?.textContent || '').replace(/^[…\.·\s]+/, '').trim().toLowerCase();
          const label = ariaLabel || visibleText || btn.textContent.trim().toLowerCase();
          if (seeMoreRe.test(label) && !showAllRe.test(label)) {
            try {
              btn.scrollIntoView({ behavior: 'instant', block: 'center' });
              await wait(40);
              btn.click();
              await waitForDomStable(btn.closest('section') || document.body, 1200, 150);
            } catch { /* noop */ }
          }
        }
      }

      // ── Click "Show all X ..." elements — BOTH <button> AND <a> ──
      // For <a> links pointing to /details/ pages: DON'T click (would navigate away)
      // but mark the section for later detail-page enrichment.
      // SDUI: only collect /details/ links for enrichment; skip button expansion (SDUI inline content is complete)
      let expandedSections = false;
      if (isSDUI) {
        // SDUI fast path: collect /details/ links — filter to known enrichment sections only
        const _KNOWN_DETAIL_SECTIONS = new Set(['skills', 'education', 'experience', 'certifications', 'languages', 'volunteer', 'projects', 'featured', 'honors', 'patents', 'publications', 'courses', 'organizations']);
        for (const a of document.querySelectorAll('a[href*="/details/"]')) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/details\/([^/?#]+)/);
          if (m && _KNOWN_DETAIL_SECTIONS.has(m[1])) _sectionsNeedingDetailPage.add(m[1]);
        }
      } else {
        for (const el of document.querySelectorAll('button, a')) {
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase().trim();
          const text = (el.textContent || '').toLowerCase().trim();
          const label = ariaLabel || text;
          const href = el.getAttribute('href') || '';

          const isShowAll = showAllRe.test(label) && (
            /skill|experience|education|certif|licen|volunteer|project|language|honor|award|publication|recommendation/i.test(label) ||
            /comp[eé]ten|exp[eé]rien|formation|b[eé]n[eé]vol|projet|langue/i.test(label) ||
            /^show all \d+/i.test(label) ||
            /^voir (toutes?|tous) les \d+/i.test(label) ||
            /^see all \d+/i.test(label)
          );
          if (!isShowAll) continue;

          if (el.tagName === 'A' && href.includes('/details/')) {
            const m = href.match(/\/details\/([^/?#]+)/);
            if (m) _sectionsNeedingDetailPage.add(m[1]);
          } else {
            try {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              await wait(80);
              el.click();
              expandedSections = true;
              await waitForDomStable(el.closest('section') || document.body, 1200, 200);
            } catch { /* noop */ }
          }
        }
      }

      // ── Handle modal-based skill/section expansion ──
      // SDUI: skills go to /details/skills/ (already captured above) — no modal used
      let skillsModalHandled = false;
      if (!isSDUI) for (const btn of document.querySelectorAll('button')) {
        const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
        if (/show all.*skill|voir.*comp[eé]ten|alle.*kennt|ver.*habil/i.test(label) &&
            !btn.closest('[role="dialog"]') &&
            !skillsModalHandled) {
          try {
            btn.scrollIntoView({ behavior: 'instant', block: 'center' });
            await wait(100);
            btn.click();
            await wait(500);
            // Check if a modal opened — skills inside will be picked up by extraction later
            const modal = document.querySelector('[role="dialog"], .artdeco-modal');
            if (modal) {
              // Scroll inside modal to load all items
              const scrollContainer = modal.querySelector('.artdeco-modal__content, [class*="modal__content"]') || modal;
              for (let i = 0; i < 4; i++) {
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
                await wait(200);
              }

              // Collect visible skill-like texts directly from the modal before closing.
              for (const span of modal.querySelectorAll('span[aria-hidden="true"]')) {
                if (span.closest('button')) continue;
                const t = (span.textContent || '').trim().replace(/\s+/g, ' ');
                if (!t || t.length < 2 || t.length > 80) continue;
                if (/^(show all|see all|show more|see more|endorsed by|skills?)$/i.test(t)) continue;
                if (/\d{4}|^\d+$/.test(t)) continue;
                if (/and \+\d+ skills?/i.test(t)) continue;
                _modalSkillCandidates.push(t);
              }

              // Close modal after content is loaded into DOM
              const closeBtn = modal.querySelector('button[aria-label*="Dismiss"], button[aria-label*="Close"], button[aria-label*="Fermer"]');
              if (closeBtn) { closeBtn.click(); await wait(300); }
              skillsModalHandled = true;
            }
          } catch { /* noop */ }
        }
      }

      // ── Click pagination / "Show more results" / "Load more" buttons ──
      // SDUI: skip — content is complete after initial render
      let paginationClicks = 0;
      if (!isSDUI) {
        for (const el of document.querySelectorAll('button, a')) {
          const label = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
          if (/show more results|show \d+ more|load more|charger plus|plus de résultats|más resultados|mehr ergebnisse|altri risultati|mais resultados/i.test(label) && !label.includes('show all') && paginationClicks < 2) {
            try {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              await wait(80);
              el.click();
              paginationClicks++;
              await waitForDomStable(el.closest('section') || document.body, 1500, 200);
            } catch { /* noop */ }
          }
        }
      }

      // ── SCROLL PASS 3: Post-expansion re-scroll (only if sections were expanded, non-SDUI only) ──
      if (!isSDUI && expandedSections) {
        for (let y = 0; y < maxH(); y += 1000) {
          window.scrollTo(0, y);
          await wait(50);
        }
        window.scrollTo(0, maxH());
        await waitForDomStable(document.body, 1000, 150);
      }

      window.scrollTo(0, 0);
      await wait(isSDUI ? 50 : 200);
    }

    const normalize = (s) => (s || '').trim().replace(/\s+/g, ' ');
    const parseCount = (raw) => {
      if (!raw) return null;
      // Normalize: strip all whitespace (including non-breaking spaces \u00A0, \u202F)
      // and handle European-style separators (1.234 or 1,234 or 4 000)
      let t = raw.toString().trim().toLowerCase().replace(/[\s\u00A0\u202F]+/g, '');
      const hasSuffix = /[km]/.test(t);
      // If there's a single dot or comma with exactly 3 digits after it and no suffix, it's a thousands sep
      // e.g., "1.234" → "1234", "1,234" → "1234", but "1.2k" stays as-is
      if (!hasSuffix) {
        t = t.replace(/[.,](\d{3})(?!\d)/g, '$1');
      }
      t = t.replace(/,/g, '.');
      const n = parseFloat(t.replace(/[^0-9.]/g, ''));
      if (Number.isNaN(n)) return null;
      if (t.includes('k')) return Math.round(n * 1000);
      if (t.includes('m')) return Math.round(n * 1000000);
      return Math.round(n);
    };
    // LinkedIn empty-profile placeholder texts and CTA strings that must never be saved as real data
    const _LINKEDIN_PLACEHOLDERS = [
      // About / headline placeholders
      /showcase your accomplishments/i,
      /showcase your services/i,
      /get up to 2x as many/i,
      /profile views and connections/i,
      /so your business can be easily discovered/i,
      /add a (summary|headline|photo|skill|position|education|certification)/i,
      /tell the world about yourself/i,
      /use your summary to/i,
      /adding a summary helps/i,
      /your summary is your chance/i,
      /members who include a summary/i,
      /write a summary about yourself/i,
      // About section — volunteer/non-profit CTA placeholders
      /tell non-?profits you are interested/i,
      /getting involved with your time and skills/i,
      // Experience / job title placeholders
      /^job title$/i,
      /^company name$/i,
      /^position title$/i,
      /^your job title$/i,
      /^organization$/i,
      // Skills placeholders
      /^soft skills$/i,
      /^technical skills$/i,
      /^add skills?$/i,
      /^add a skill$/i,
      /^industry knowledge$/i,
      // Generic LinkedIn CTA / empty state
      /^add (your|a|an) /i,
      /^share (your|a|an) /i,
      /^start (a|your) /i,
      /^let (people|others|recruiters)/i,
      /people with (your|a) (role|skills?|background)/i,
      /open to (work|opportunities)/i,
      /providing services/i,
      /hiring on linkedin/i,
      // Hiring / recruiter mode placeholders
      /share that you.re hiring/i,
      /attract qualified candidates/i,
      /share.*hiring.*attract/i,
      // Open-to-work / service banners that bleed into about
      /providing services/i,
      /open to work/i,
      /open for business/i,
      // Generic "no about yet" CTA variants
      /get discovered by/i,
      /let recruiters know/i,
      /show up in recruiter searches/i,
      /sign in to see who/i,
    ];
    const isPlaceholder = (raw) => _LINKEDIN_PLACEHOLDERS.some(rx => rx.test((raw || '').trim()));

    const isUiNoise = (raw) => {
      const t = normalize(raw).toLowerCase();
      if (!t) return true;
      // LinkedIn empty-profile placeholder / CTA texts
      if (isPlaceholder(raw)) return true;
      // Core LinkedIn section headers and UI labels
      if (/^(experience|expérience|experiencia|erfahrung|esperienza|experiência|خبرة|education|formation|educación|ausbildung|istruzione|educação|formação|تعليم|skills|compétences|habilidades|aptitudes|kenntnisse|competenze|competências|مهارات|about|à propos|acerca de|über|informazioni|sobre|نبذة|show all|see all|show more|see more|… more|more|view all|followers?|connections?|contact info|message|open to|add section|edit|modifier|activity|activité|actividad|aktivitäten|attività|atividade|نشاط|licenses?|certifications?|licences?|certificaciones?|zertifizierungen?|certificazioni?|languages?|langues?|idiomas?|sprachen?|lingue?|لغات|volunteer|bénévolat|volontariat|voluntariado|ehrenamt|volontariato|تطوع|projects?|projets?|proyectos?|projekte?|progetti?|projetos?|مشاريع|publications?|publicaciones?|publikationen?|pubblicazioni?|publicações?|منشورات|honors?|awards?|distinctions?|premios?|auszeichnungen?|premi?|prêmios?|جوائز|organisations?|organizaciones?|organisationen?|organizzazioni?|organizações?|منظمات|courses?|cours|cursos?|kurse?|corsi|دورات|recommendations?|recommandations?|recomendaciones?|empfehlungen?|raccomandazioni?|recomendações?|توصيات|causes you care about|supported)$/.test(t)) return true;
      // Follower/connection counts like "500 connections" (multilingual)
      if (/^\d[\d,.\s+]*\s*(followers?|connections?|abonnés?|contacts?|seguidores?|conexiones?|kontakte?|follower|collegamenti|seguidor(es)?|متابع|اتصال)$/i.test(t)) return true;
      // LinkedIn top navigation items (appear in aria-hidden spans on every page)
      if (/^(home|my network|jobs|messaging|notifications?|me|work|gaming|news|people|groups|events|learning|services|products|careers|premium|try premium)$/.test(t)) return true;
      // LinkedIn skill/cert category labels (not actual data)
      if (/^(industry knowledge|tools & technologies|interpersonal skills|other skills|other|see credential|show credential|view credential|issued|expires?|credential id|no expiration)$/.test(t)) return true;
      // Pure short numbers (notification counts "24", pagination "1", etc.)
      if (/^\d{1,3}$/.test(t)) return true;
      // Single character noise
      if (/^\w$/.test(t)) return true;
      // Activity feed metadata — post comment/like counts, live stream tags, connection-degree separators
      if (/^live$/i.test(t)) return true;
      if (/^\d+\s*(comments?|likes?|reactions?|shares?|reposts?|views?)/i.test(t)) return true;
      // LinkedIn name•degree separator pattern: "Jihed Ayari • You", "Name • 1st", "Name • 2nd"
      if (/ • (you|1st|2nd|3rd|\d+(st|nd|rd|th)?)$/i.test(t)) return true;
      return false;
    };

    // Helper: collect aria-hidden spans scoped strictly to `item` (excludes nested sub-items & buttons)
    // Helper: collect aria-hidden spans scoped to `item` (excludes nested sub-items & buttons)
    // Prefers leaf spans (no children) to avoid duplicate text, but falls back to parent spans
    const getScopedSpans = (item) => {
      const allSpans = Array.from(item.querySelectorAll('span[aria-hidden="true"]')).filter(s => {
        if (s.closest('button')) return false;
        // Walk up: reject only if we cross ANOTHER li/entity boundary before reaching our item
        let el = s.parentElement;
        while (el && el !== item) {
          if (el !== s.parentElement && el.matches && el.matches('li, .pvs-entity, [data-view-name*="profile-component-entity"], .artdeco-list__item')) return false;
          el = el.parentElement;
        }
        return true;
      });
      // Prefer leaf spans (no child elements) to avoid text duplication
      const leafSpans = allSpans.filter(s => s.children.length === 0);
      return leafSpans.length > 0 ? leafSpans : allSpans;
    };

    // ── NAME ─────────────────────────────────────────────────
    // Seed from JSON-LD first — it's guaranteed accurate and stable.
    let name = (_jsonLd && _jsonLd.name) ? String(_jsonLd.name).trim() : '';
    // Skip these h2 patterns that are NOT the profile name
    const skipH = /^\d+\s*notification|profile\s+language|public\s+profile|ad\s+option|people\s+you\s+may|you\s+might\s+like|sign\s+in/i;
    let nameEl = null;

    // DOM extraction (fills nameEl reference for photo/headline strategies below)
    outer:
    for (const tag of ['h1', 'h2']) {
      for (const el of document.querySelectorAll(tag)) {
        if (el.closest('nav, [role="navigation"]')) continue;
        const t = el.textContent.trim().replace(/\s+/g, ' ');
        if (t && t.length > 1 && t.length < 100 && !skipH.test(t)) {
          if (!name) name = t; // only overwrite if JSON-LD didn't give us a name
          nameEl = el; break outer;
        }
      }
    }

    // fallback: title tag
    if (!name) {
      const titleMatch = document.title.replace(/^\(\d+\+?\)\s*/, '').match(/^(.+?)\s*[|\-–]/);
      if (titleMatch) name = titleMatch[1].trim();
    }

    // ── PROFILE PHOTO ──────────────────────────────────────────
    // Priority order: JSON-LD (guaranteed accurate) → top-card DOM selectors
    // (scoped to top-card section to avoid matching company/school logos in experience)
    // → whole-page scan restricted to profile-displayphoto URLs only.
    //
    // Using `currentSrc || src || data-ghost-url` handles lazy-loaded images where
    // img.naturalWidth is 0 before the image renders (a common false-negative).
    let profilePhotoUrl = '';

    // Source 0: JSON-LD Person schema — most reliable, no DOM uncertainty
    if (_jsonLd && _jsonLd.image) {
      const jImg = typeof _jsonLd.image === 'string' ? _jsonLd.image
                 : (_jsonLd.image.url || _jsonLd.image.contentUrl || '');
      if (jImg && jImg.startsWith('https://') && !jImg.includes('ghost-person')) profilePhotoUrl = jImg;
    }

    // Helper: extract src with lazy-load fallback
    const _imgSrc = img => img ? (img.currentSrc || img.src || img.dataset.ghostUrl || img.dataset.delayedUrl || '') : '';
    // profile-framedphoto = profile photo with a LinkedIn frame applied (same person, different URL path)
    const _isDisplayPhoto = src => src.includes('profile-displayphoto') || src.includes('profile-framedphoto');
    const _validPhoto = src => src && src.startsWith('https://') && src.length > 40 &&
      !src.includes('ghost-person') && !src.includes('li-default-') &&
      !src.includes('/company/') && !src.includes('/school/') && !src.includes('static.licdn');

    if (!profilePhotoUrl) {
      // Source 0b: aria-label="Profile photo" — LinkedIn SDUI 2024/2025 marks the
      // profile photo container with this exact aria-label. Works for both
      // profile-displayphoto and profile-framedphoto URL patterns.
      const ariaPhotoEl = document.querySelector('[aria-label="Profile photo"] img');
      if (ariaPhotoEl) {
        const src = _imgSrc(ariaPhotoEl);
        if (_validPhoto(src)) profilePhotoUrl = src;
      }
    }

    if (!profilePhotoUrl) try {
      // Source 1: Walk UP from nameEl to find the smallest ancestor that contains
      // a profile photo image. Guarantees top-card scope without fragile class selectors.
      if (nameEl) {
        let cursor = nameEl.parentElement;
        let walkDepth = 0;
        while (cursor && cursor !== document.body && walkDepth < 18) {
          const displayPhotos = Array.from(cursor.querySelectorAll('img')).filter(img => {
            const src = _imgSrc(img);
            return _isDisplayPhoto(src) && _validPhoto(src);
          });
          if (displayPhotos.length > 0) {
            let best = null, bestW = -1;
            for (const img of displayPhotos) {
              const w = img.naturalWidth || 0;
              if (!best || w > bestW) { best = img; bestW = w; }
            }
            if (best) { profilePhotoUrl = _imgSrc(best); break; }
          }
          if (cursor.tagName === 'MAIN' || cursor.tagName === 'SECTION') break;
          cursor = cursor.parentElement;
          walkDepth++;
        }
      }

      // Source 2: Document-wide scan — excludes header/nav/aside, scores by alt-text match
      if (!profilePhotoUrl) {
        const nameLower = (name || '').toLowerCase().trim();
        const firstName = nameLower.split(/\s+/)[0] || '';
        let bestSrc = '', bestW = -1, bestAltScore = -1;
        for (const img of document.querySelectorAll('img')) {
          const src = _imgSrc(img);
          if (!_isDisplayPhoto(src) || !_validPhoto(src)) continue;
          if (img.closest('header, nav, aside, [role="navigation"], [role="banner"], [class*="also-viewed"], [class*="pymk"], [class*="feed-shared"]')) continue;
          const altLower = (img.alt || '').toLowerCase().trim();
          const altScore = (nameLower && altLower === nameLower) ? 3
            : (firstName && altLower && altLower.startsWith(firstName)) ? 2
            : (firstName && altLower && altLower.includes(firstName)) ? 1 : 0;
          const better = bestSrc === '' || altScore > bestAltScore || (altScore === bestAltScore && (img.naturalWidth || 0) > bestW);
          if (better) { bestSrc = src; bestW = img.naturalWidth || 0; bestAltScore = altScore; }
        }
        // Only accept if alt text partially matches the user's name (score >= 1)
        // to avoid picking up photos from suggested connections or other profiles on the page
        if (bestSrc && bestAltScore >= 1) profilePhotoUrl = bestSrc;
      }
    } catch { /* noop */ }

    // ── HEADLINE ─────────────────────────────────────────────
    // Seed from JSON-LD (jobTitle or description field).
    let headline = '';
    if (_jsonLd) {
      if (_jsonLd.jobTitle) headline = String(_jsonLd.jobTitle).trim();
      else if (_jsonLd.description && _jsonLd.description.length < 300) headline = String(_jsonLd.description).trim();
    }

    // Shared helper: detect location/geo strings (used by both Strategy 1 and 2)
    const _isLikelyLocation = s => (s.includes(',') && s.length < 90) ||
      /\b(area|region|metro|greater|metropolitan|governorate|gouvernorat|wilaya|province|prefecture|district|county|city|ville|capitale|région)\b/i.test(s);

    // Helper: detect "· 1st / · 2nd" connection-degree badges that precede the headline in SDUI DOM
    const _isDegreeBadge = s => /^[\u00B7·•]\s*(1st|2nd|3rd|\d+(?:st|nd|rd|th)?|connection|follower)/i.test(s) || s === '\u00B7' || s === '·';
    // Helper: detect "Company · School" lines — EXACTLY one · with no · inside either segment and no | pipe
    // "BDS BATIMENT · Université Paris Dauphine" → filtered  |  "Founder · AI · SaaS" → NOT filtered
    // Filter employer/school lines like "BDS BATIMENT · Université Paris Dauphine" but NOT "CEO · Founder"
    // Rule: both segments must be ≥20 chars (org names are long; short-role pairs are valid headlines)
    const _isEmployerSchoolLine = s => {
      const m = s.match(/^([^|·\u00B7]+)\s[\u00B7·]\s([^|·\u00B7]+)$/);
      if (!m) return false;
      const [, left, right] = m;
      return s.length < 90 && left.trim().length >= 20 && right.trim().length >= 20;
    };

    // Strategy 1: TreeWalker from name element (partner's approach - most robust)
    if (nameEl) {
      let container = nameEl;
      for (let i = 0; i < 8 && container.parentElement; i++) {
        container = container.parentElement;
        if (container.children.length >= 3) break;
      }
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      let passedName = false;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (nameEl.contains(node)) { passedName = true; continue; }
        if (!passedName) continue;
        const t = node.textContent.trim();
        if (!t || t.length < 3) continue;
        if (t === name) continue;
        if (node.parentElement?.closest('button, nav, a[href]')) continue;
        // Skip degree badges ("· 2nd"), UI actions, and noise
        if (_isDegreeBadge(t)) continue;
        if (/^(\d+|connection|follow|contact|open to|add section|message|enhance|modifier|pending|more|show|see all|click|pronoun|she\/|he\/|they\/|try\s|premium|MAD)/i.test(t)) continue;
        // Skip employer/school combos ("BDS BATIMENT · Université Paris Dauphine") - not the headline
        if (_isEmployerSchoolLine(t)) continue;
        if (t.length <= 250 && !_isLikelyLocation(t)) {
          headline = t; break;
        }
      }
    }

    // Strategy 2: text-body-medium class (stable) before hashed classes (may change)
    if (!headline) {
      const allP = rqa(document, ['.text-body-medium.break-words', '[class*="text-body-medium"]', 'p.f6996daa', 'p[class*="artdeco-entity"]']);
      for (const p of allP) {
        const text = p.textContent.trim();
        if (text.length > 5 && text.length < 220 &&
            !_isDegreeBadge(text) &&
            !_isEmployerSchoolLine(text) &&
            !text.includes('Premium') && !text.includes('MAD') &&
            !text.includes('followers') && !text.includes('connections') &&
            !text.toLowerCase().startsWith('try ') &&
            !_isLikelyLocation(text) &&
            text !== name) {
          headline = text; break;
        }
      }
    }

    // Strategy 3: classic selectors fallback
    if (!headline) {
      for (const sel of ['.text-body-medium.break-words', '[class*="text-body-medium"]']) {
        const el = document.querySelector(sel);
        if (el) {
          const t = el.textContent.trim();
          if (t && t.length > 4 && t !== name && !/^\d+\s*(connection|follower)/i.test(t)) {
            headline = t; break;
          }
        }
      }
    }

    // ── LOCATION ─────────────────────────────────────────────
    let location_ = '';

    // Strategy 1: direct LinkedIn location element selectors (profile header area)
    for (const sel of [
      '.text-body-small.inline.t-black--light.break-words',
      'span[class*="text-body-small"][class*="t-black--light"]',
      '.pv-text-details__left-panel .text-body-small',
      '[data-field="location_summary"]',
    ]) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = normalize(el.textContent);
      if (!t || t.length < 3 || t.length > 120) continue;
      if (/^\d+/.test(t) || isUiNoise(t) || t.includes('@') || t.includes('http')) continue;
      location_ = t.replace(/\s*·.*$/, '').trim();
      break;
    }

    // Strategy 2: hashed class p tags with location keywords
    if (!location_) {
      const allP = rqa(document, ['p.f6996daa', '.text-body-medium.break-words', '[class*="text-body-medium"]', 'p[class*="artdeco-entity"]']);
      for (const p of allP) {
        const text = p.textContent.trim();
        if (text.includes('Morocco') || text.includes('Maroc') ||
            text.includes('Tunisia') || text.includes('Tunisie') ||
            text.includes('Algeria') || text.includes('Algérie') ||
            text.includes('France') || text.includes('Area') ||
            text.includes('Metropolitan') || text.includes('Governorate') ||
            (text.includes(',') && text.length < 80 && !text.includes('@'))) {
          if (!location_ || text.length < location_.length) {
            const cleaned = text.replace(/\s*·.*$/, '').trim();
            if (!/^\d+[,\d]*\s*(followers?|connections?|abonnés?|contacts?)/i.test(cleaned)) {
              location_ = cleaned;
            }
          }
        }
      }
    }

    // Strategy 3: TreeWalker near the name element — catches hashed-class locations
    if (!location_ && nameEl) {
      let headerEl = nameEl;
      for (let i = 0; i < 8 && headerEl.parentElement; i++) headerEl = headerEl.parentElement;
      const locWalker = document.createTreeWalker(headerEl, NodeFilter.SHOW_TEXT, null);
      let passedHeadline = false;
      while (locWalker.nextNode()) {
        const node = locWalker.currentNode;
        if (!passedHeadline && headline && node.textContent.includes(headline.slice(0, 15))) {
          passedHeadline = true; continue;
        }
        if (!passedHeadline) continue;
        const t = normalize(node.textContent);
        if (!t || t.length < 3 || t.length > 120) continue;
        if (node.parentElement?.closest('button, nav, a[href]')) continue;
        if (/^\d+/.test(t) || isUiNoise(t)) continue;
        // Location tends to have commas, or known geo words
        if (t.includes(',') || /\b(area|region|metro|gouvern|wilaya|province|city|ville)\b/i.test(t)) {
          location_ = t; break;
        }
      }
    }

    // ── SECTION FINDER ───────────────────────────────────────
    function findSection(keywords) {
      const kwLow = keywords.map(k => k.toLowerCase().trim());

      // Strategy 1: heading text match — check h2/h3 INSIDE each <section>
      // This is the most reliable: LinkedIn wraps each profile section in a <section> tag
      // with an h2 heading. We check the heading text (not the full section textContent,
      // which could match noise like post text containing "experience").
      for (const sec of document.querySelectorAll('section')) {
        for (const heading of sec.querySelectorAll(':scope > div h2, :scope > div h3, :scope > header h2')) {
          const ht = heading.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
          if (kwLow.some(k => ht === k || ht.startsWith(k) || ht.includes(k))) return sec;
        }
      }

      // Strategy 2: aria-label / data-view-name / id attributes
      for (const kw of kwLow) {
        const safeKw = CSS.escape ? kw : kw.replace(/[^\w\s-]/g, '');
        const hit = document.querySelector(`section[aria-label*="${safeKw}" i]`) ||
                    document.querySelector(`section[id*="${safeKw}" i]`) ||
                    document.querySelector(`[data-view-name*="${safeKw}" i]`) ||
                    document.getElementById(safeKw);
        if (hit) {
          const sec = hit.closest('section');
          if (sec) return sec;
          return hit;
        }
      }

      // Strategy 3: first 120 chars of section textContent (catches hashed-class layouts
      // where heading text is not in h2/h3 but is the first visible text in the section)
      for (const sec of document.querySelectorAll('section')) {
        const first120 = sec.textContent.trim().substring(0, 120).toLowerCase();
        if (kwLow.some(k => first120.includes(k))) return sec;
      }

      // Strategy 4: any heading or aria-hidden span inside artdeco-card containers
      const containers = [...document.querySelectorAll('section'), ...document.querySelectorAll('[class*="artdeco-card"]')];
      for (const container of containers) {
        for (const el of container.querySelectorAll('h2, h3, span[aria-hidden="true"]')) {
          if (el.closest('li')) continue;
          const et = el.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
          // Partial match: keyword appears anywhere in the heading text
          if (kwLow.some(k => et === k || et.includes(k))) return container;
        }
      }

      // Strategy 5: TreeWalker fallback (hashed layout where nothing else works)
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      while (tw.nextNode()) {
        const node = tw.currentNode;
        const t = node.textContent.trim().toLowerCase();
        if (!kwLow.some(k => t === k || t === k + 's' || t.startsWith(k))) continue;
        const par = node.parentElement;
        if (!par || par.closest('nav, header, footer, li')) continue;
        let el = par.parentElement;
        for (let depth = 0; depth < 12 && el && el !== document.body; depth++, el = el.parentElement) {
          if (depth < 1) continue;
          if (el.querySelector('li') || el.querySelector('[class*="pvs-entity"]')) return el;
        }
      }
      return null;
    }

    // ── ABOUT ────────────────────────────────────────────────
    let about = '';
    let aboutSec = null;
    try {
    // LinkedIn placeholder texts shown when user has no about section — must be filtered out
    const isAboutPlaceholder = (text) => isPlaceholder(text) || [
      /members who include a summary/i,
      /profile views/i,
      /add a summary/i,
      /tell the world about yourself/i,
      /use your summary to/i,
      /adding a summary helps/i,
      /your summary is your chance/i,
      /showcase your/i,
      /get up to/i,
    ].some(rx => rx.test(text));

    aboutSec = findSection(['About', 'À propos', 'about', 'summary', 'à propos', 'infos', 'Acerca de', 'Info', 'Über', 'Informazioni', 'Sobre', 'نبذة عنّي', 'نبذة عني']);
    if (aboutSec) {
      // 1. visually-hidden spans — LinkedIn stores FULL text there.
      //    IMPORTANT: skip any span that's inside a <button> (those are "see more, about [name]" labels)
      for (const span of aboutSec.querySelectorAll('.visually-hidden')) {
        if (span.closest('button')) continue;  // ← key fix: ignore button's visually-hidden text
        const t = normalize(span.textContent);
        if (t.length > 20 && !/^(about|à propos|see more|voir plus)/i.test(t) && !isAboutPlaceholder(t)) {
          about = t; break;
        }
      }

      // 2. aria-hidden spans — visible text (truncated or fully expanded after "see more" click)
      if (!about) {
        const candidates = [
          ...aboutSec.querySelectorAll('div.inline-show-more-text > span[aria-hidden="true"]'),
          ...aboutSec.querySelectorAll('.pv-shared-text-with-see-more > div > span[aria-hidden="true"]'),
          ...aboutSec.querySelectorAll('[class*="break-words"] span[aria-hidden="true"]'),
          ...aboutSec.querySelectorAll('span[aria-hidden="true"]'),
        ];
        for (const node of candidates) {
          if (node.closest('li, button')) continue;
          const t = normalize(node.textContent);
          if (isUiNoise(t)) continue;
          if (t.length > about.length && t.length > 20 &&
              !/^(about|à propos|see more|voir plus|…)/i.test(t) && !isAboutPlaceholder(t)) {
            about = t;
          }
        }
      }

      // 3. innerText fallback — grab the longest non-noise line
      if (!about) {
        const lines = (aboutSec.innerText || '')
          .split('\n')
          .map(x => x.trim())
          .filter(Boolean)
          .filter(x => x.length > 10)
          .filter(x => !isUiNoise(x))
          .filter(x => !isAboutPlaceholder(x))
          .filter(x => !/^(about|à propos|see more|voir plus|edit|modifier)$/i.test(x));
        if (lines.length) {
          about = lines.sort((a, b) => b.length - a.length)[0];
        }
      }

      // 4. Clone + strip approach — remove heading/buttons then read full textContent
      if (!about) {
        try {
          const clone = aboutSec.cloneNode(true);
          clone.querySelectorAll('h2, h3, button').forEach(el => el.remove());
          const text = normalize(clone.textContent)
            .replace(/^(about|à propos)\s*/i, '')
            .trim();
          if (text.length > 20 && !isUiNoise(text)) about = text;
        } catch { /* noop */ }
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] About section error:', e); }

    // ── ABOUT SANITY CHECK: if `about` looks like a location string, discard it ──
    // This prevents location-like text (e.g. "Agadir, Souss-Massa, Maroc") from
    // being accidentally stored as the about section when the real about is empty.
    if (about) {
      const _aboutLooksLikeLocation = (s) => {
        if (s.length > 150) return false; // real about is never this short after 150 chars
        // Matches "City, Region, Country" patterns with no sentence structure
        const hasCommasOnly = /^[^.!?]{3,80},[^.!?]{3,80}$/.test(s.trim());
        const hasGeoWords   = /\b(maroc|morocco|france|algerie|algeria|tunisie|tunisia|souss|agadir|casablanca|rabat|dubai|area|region|gouvernorat|wilaya|province)\b/i.test(s);
        const hasSentence   = /[.!?]/.test(s) || s.split(' ').length > 10;
        return (hasCommasOnly || hasGeoWords) && !hasSentence;
      };
      if (_aboutLooksLikeLocation(about)) {
        console.warn('[LinkedIn AI] About discarded — looks like location:', about);
        about = '';
      }
    }

    // ── EXPERIENCE ───────────────────────────────────────────
    const experience = [];
    let expSec = null;
    try {
    expSec = findSection(['Experience', 'Expérience', 'experience', 'expérience', 'Experiencia', 'Erfahrung', 'Esperienza', 'Experiência', 'خبرة']);

    if (expSec) {
      // Helper: classify a text string by content pattern
      const classifyExpText = (t) => {
        if (/and \+\d+ skills?/i.test(t)) return 'skip';
        if (/^\d+\s*(yr|mo|an|mois|año|mes|Jahr|Monat|anno|mese|ano|mês|سنة|شهر)/i.test(t)) return 'duration';
        if (/\d{4}\s*[-–—]/.test(t) || (/\b(present|présent|actuel|actualidad|gegenwart|presente|atual|حالي|الآن)\b/i.test(t) && t.length < 60)) return 'dates';
        if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|ene|abr|ago|dic|ene|mär|mai|okt|dez|gen|mag|giu|lug|set|ott|dic|fev|ago|out|dez)\b/i.test(t) && /\d{4}/.test(t) && t.length < 60) return 'dates';
        // Standalone work-mode / employment-type tokens (exact match)
        if (/^(Remote|On-site|Hybrid|Internship|Full-time|Part-time|Contract|Freelance|Self-employed|Apprenticeship|Seasonal|Temporary|Volunteering|CDD|CDI|Stage|Alternance|Remoto|Presencial|Híbrido|Prácticas|Tiempo completo|Medio tiempo|Contrato|Autónomo|Fernarbeit|Vor Ort|Praktikum|Vollzeit|Teilzeit|Freiberuflich|Da remoto|In sede|Ibrido|Tirocinio|Tempo pieno|عن بعد|في الموقع|دوام كامل|دوام جزئي|تدريب|عقد)$/i.test(t)) return 'employmentType';
        // "City, Region · On-site" compound location string
        if (t.includes('·') && /\b(remote|on-site|hybrid|en présentiel|teletrabajo)\b/i.test(t)) return 'location';
        // Pure location: "City, Country" with geo keyword
        if (t.includes(',') && t.length < 100 && /\b(remote|on-site|hybrid|area|région|ville|city|country|morocco|maroc|tunisia|france|algeria|germany|usa|uk|canada|agadir|casablanca|rabat|dubai|riyadh|cairo|london|paris|berlin|madrid|rome|amsterdam)\b/i.test(t)) return 'location';
        // Only classify as description if it's genuinely long prose (not a location or title)
        if (t.length > 120) return 'description';
        // Medium-length: if it reads like a sentence (has verb-like words), treat as description
        if (t.length > 60 && /\b(developed|managed|led|built|created|designed|analyzed|implemented|delivered|supported|worked|collaborated|responsible|achieved|improved|increased|reduced|launched|maintained|provided|established)\b/i.test(t)) return 'description';
        return 'text'; // title or company
      };

      // Helper: parse experience entry — content-based classification only (no hashed CSS classes).
      // Strategy 1: data-field attributes (stable, LinkedIn uses these for semantic markup).
      // Strategy 2: date-regex classification for each span text (robust across deploys).
      const parseExpItemSemantic = (li, texts) => {
        const entry = { title: '', company: '', dates: '', duration: '', location: '', employmentType: '', description: '' };

        // Strategy 1: data-field semantic attributes (most stable across LinkedIn deploys)
        const titleEl = li.querySelector('[data-field="experience_item_title"] span[aria-hidden="true"], [aria-label*="title" i] span[aria-hidden="true"]');
        if (titleEl) {
          const t = normalize(titleEl.textContent);
          if (t && t.length > 1 && t.length < 200 && !isUiNoise(t)) entry.title = t;
        }
        const subtitleEl = li.querySelector('[data-field="experience_item_subtitle"] span[aria-hidden="true"]');
        if (subtitleEl) {
          const t = normalize(subtitleEl.textContent);
          if (t && !isUiNoise(t)) {
            // LinkedIn subtitle is often "Company · EmploymentType" — split them
            const subParts = t.split('·').map(p => p.trim());
            entry.company = subParts[0];
            if (subParts[1] && !entry.employmentType) {
              // Check if the second part is an employment type token
              if (/^(Internship|Full-time|Part-time|Contract|Freelance|Self-employed|Apprenticeship|Seasonal|Temporary|Stage|CDD|CDI|Alternance)$/i.test(subParts[1])) {
                entry.employmentType = subParts[1];
              }
            }
          }
        }

        // Get description from show-more container
        const descContainer = li.querySelector('.inline-show-more-text span[aria-hidden="true"], [class*="show-more"] span[aria-hidden="true"]');
        if (descContainer) {
          const dt = normalize(descContainer.textContent);
          if (dt.length > 30) entry.description = dt;
        }

        // Strategy 2: classify each text span purely by content pattern (no CSS class dependency)
        for (const t of texts) {
          if (isUiNoise(t)) continue;
          if (entry.title && t === entry.title) continue;
          if (entry.company && t === entry.company) continue;
          const cls = classifyExpText(t);
          if (cls === 'skip') continue;
          if (cls === 'duration' && !entry.duration) { entry.duration = t; continue; }
          if (cls === 'dates' && !entry.dates) { entry.dates = t; continue; }
          if (cls === 'employmentType' && !entry.employmentType) { entry.employmentType = t; continue; }
          if (cls === 'description' && !entry.description) { entry.description = t; continue; }
          if (cls === 'location' && !entry.location && entry.title) {
            // Strip trailing "· On-site / · Remote / · Hybrid" suffix from location strings
            let loc = t.replace(/\s*·\s*(Remote|On-site|Hybrid|en présentiel|teletrabajo)[^·]*$/i, '').trim();
            entry.location = loc;
            // If the suffix contained a work mode, extract it as employmentType
            const workModeMatch = t.match(/·\s*(Remote|On-site|Hybrid)/i);
            if (workModeMatch && !entry.employmentType) entry.employmentType = workModeMatch[1];
            continue;
          }
          if (cls === 'text') {
            if (!entry.title) { entry.title = t; continue; }
            if (!entry.company) { entry.company = t.replace(/\s*·.*$/, '').trim(); continue; }
            if (!entry.location && t.length < 80) { entry.location = t; continue; }
          }
        }

        return entry;
      };

      // Keep old positional parser as fallback
      const parseExpTexts = (texts) => {
        const entry = { title: '', company: '', dates: '', duration: '', location: '', employmentType: '', description: '' };
        for (const t of texts) {
          if (isUiNoise(t)) continue;
          const cls = classifyExpText(t);
          if (cls === 'skip') continue;
          if (cls === 'duration') { entry.duration = t; continue; }
          if (cls === 'dates' && !entry.dates) { entry.dates = t; continue; }
          if (cls === 'employmentType') { entry.employmentType = t; continue; }
          if (t.length > 40 && entry.title && entry.company && !entry.description) { entry.description = t; continue; }
          if (t.length > 40 && entry.description && entry.title && entry.company) { entry.description += ' ' + t; continue; }
          if (!entry.title) { entry.title = t; continue; }
          if (!entry.company) { entry.company = t.replace(/\s*·.*$/, '').trim(); continue; }
          if (!entry.location && t.length < 80 && !entry.description &&
              (t.includes(',') || /\b(remote|on-site|hybrid|area|région|ville|city|country)\b/i.test(t))) {
            entry.location = t; continue;
          }
        }
        return entry;
      };

      // Helper: get scoped spans for an experience item — excludes nested sub-items
      const getExpSpans = (li) => {
        const allSpans = Array.from(li.querySelectorAll('span[aria-hidden="true"], .t-bold span, .t-14 span, .t-normal span'))
          .filter(s => {
            if (s.closest('button')) return false;
            // Walk up: reject if we cross ANOTHER item boundary before reaching our item
            let el = s.parentElement;
            while (el && el !== li) {
              if (el !== s.parentElement && el.matches &&
                  el.matches('li, .pvs-entity, [data-view-name*="profile-component-entity"], .artdeco-list__item') &&
                  el !== li) return false;
              el = el.parentElement;
            }
            return true;
          });
        // Prefer leaf spans to avoid text duplication from parent+child
        const leafSpans = allSpans.filter(s => s.children.length === 0);
        return leafSpans.length > 0 ? leafSpans : allSpans;
      };

      // ── Strategy 0: SDUI-specific parser (2025+ LinkedIn layout) ─────────────
      // Uses stable div[componentkey^="entity-collection-item"] entries + edit form links.
      // Grouped detection: entry has a <ul> child → multiple roles at same company.
      // Single detection: entry has direct a[href*="/edit/forms/position/"] → one role.
      const sduiEntries = [...expSec.querySelectorAll('div[componentkey^="entity-collection-item"]')];
      if (sduiEntries.length > 0) {
        for (const entry of sduiEntries) {
          try {
            // Skip entries that are clearly activity/post content (no edit link and text looks like post)
            const entryText = (entry.textContent || '').trim();
            // Posts contain reactions/comments counts or "repost" patterns
            if (/\d+\s*(reactions?|comments?|reposts?|likes?)/i.test(entryText)) continue;
            // Skip entries that are "Highlights" mutual connection blocks
            if (/you both studied|you both worked|mutual connection/i.test(entryText)) continue;
            const roleList = entry.querySelector('ul');
            if (roleList) {
              // GROUPED: multiple roles at same company.
              // Company p[] are the ones NOT inside the ul.
              // Structure: companyPs[0] = company name, companyPs[1] = "EmploymentType · total duration"
              const companyPs = [...entry.querySelectorAll('p')].filter(p => !roleList.contains(p));
              const company = (companyPs[0]?.textContent || '').trim();
              // companyPs[1] may be "Full-time · 3 yrs" — empType is before the dot
              const typeAndDur = (companyPs[1]?.textContent || '').trim();
              const companyEmpType = typeAndDur.split('·')[0].trim();

              for (const li of roleList.querySelectorAll('li')) {
                const editLink = li.querySelector('a[href*="/edit/forms/position/"]');
                if (!editLink) continue;
                // Grouped role edit-link p[] order:
                //   p[0] = role title
                //   p[1] = "Aug 2025 - Oct 2025 · 3 mos"
                //   p[2] = "City, Region · On-site"  (optional)
                const ps = [...editLink.querySelectorAll('p')]
                  .map(p => (p.textContent || '').trim())
                  .filter(t => t.length > 0);

                const title    = ps[0] || '';
                const datesRaw = ps[1] || '';
                const dp       = datesRaw.split('·');
                const dates    = dp[0]?.trim() || '';
                const duration = dp[1]?.trim() || '';

                // p[2] may be location or standalone work-mode
                let location = '', roleEmpType = companyEmpType;
                if (ps[2]) {
                  const locParts = ps[2].split('·').map(s => s.trim());
                  location = locParts[0];
                  if (locParts[1] && /^(Remote|On-site|Hybrid|Internship|Full-time|Part-time|Contract|Freelance)$/i.test(locParts[1])) {
                    roleEmpType = locParts[1];
                  } else if (/^(Remote|On-site|Hybrid)$/i.test(locParts[0])) {
                    location = '';
                    roleEmpType = locParts[0];
                  }
                }

                let description = '';
                const _descSels = [
                  'span[data-testid="expandable-text-box"]',
                  '.inline-show-more-text span[aria-hidden="true"]',
                  '[class*="show-more-less-text"] span[aria-hidden="true"]',
                ];
                for (const sel of _descSels) {
                  const descEl = li.querySelector(sel);
                  if (descEl) {
                    const cl = descEl.cloneNode(true);
                    cl.querySelectorAll('button, .visually-hidden').forEach(b => b.remove());
                    const dt = cl.textContent.trim().replace(/\s+/g, ' ');
                    if (dt.length > 20) { description = dt; break; }
                  }
                }
                if (title || company) {
                  const key = (title + company).toLowerCase();
                  if (!experience.some(r => (r.title + r.company).toLowerCase() === key)) {
                    experience.push({ title, company, dates, duration, employmentType: roleEmpType, location, description });
                  }
                }
              }
            } else {
              // SINGLE ROLE parser.
              // LinkedIn's edit-link p[] are MOSTLY positional but the order can shift
              // when descriptions or extra metadata bleed in. Strategy:
              // 1. Scan ALL p[] and classify each by content.
              // 2. First unclassified short string (< 120 chars, no date pattern) = title.
              // 3. Second unclassified short string = company (split · for empType).
              // 4. Date pattern → dates/duration. Location pattern → location/workType.
              // 5. Description comes from data-testid span (outside edit link).
              const editLink = entry.querySelector('a[href*="/edit/forms/position/"]');
              if (!editLink) continue;
              const ps = [...editLink.querySelectorAll('p')]
                .map(p => (p.textContent || '').trim())
                .filter(t => t.length > 0);

              let title = '', company = '', empType = '', dates = '', duration = '', workType = '';

              const _isDateStr  = t => /\b(20\d\d|19\d\d|Present|présent|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(t) && t.length < 80;
              const _isDuration = t => /^\d+\s*(yr|mo|an|mois|año|mes|Jahr|Monat)/i.test(t);
              const _isEmpType  = t => /^(Internship|Full-time|Part-time|Contract|Freelance|Self-employed|Apprenticeship|Seasonal|Temporary|Volunteering|CDD|CDI|Stage|Alternance|Remote|On-site|Hybrid)$/i.test(t);
              const _isLocation = t => (t.includes(',') && t.length < 100) || (t.includes('·') && /\b(remote|on-site|hybrid)\b/i.test(t));
              const _isDesc     = t => t.length > 80 && /\b(developed|managed|led|built|created|designed|analyzed|implemented|delivered|supported|worked|responsible|achieved|improved|extracted|launched)\b/i.test(t);
              const _isTitleOrCompany = t => !_isDateStr(t) && !_isDuration(t) && !_isEmpType(t) && !_isLocation(t) && !_isDesc(t) && t.length < 120;

              for (const t of ps) {
                if (_isDesc(t)) continue; // descriptions live in data-testid span, skip if leaked here

                if (_isDateStr(t) && !dates) {
                  // "Aug 2025 - Oct 2025 · 3 mos"
                  const dp = t.split('·');
                  dates    = dp[0].trim();
                  duration = dp[1]?.trim() || '';
                  continue;
                }

                if (_isLocation(t) && !workType) {
                  // "Agadir, Souss-Massa, Morocco · On-site" or just "Remote"
                  const locParts = t.split('·').map(s => s.trim());
                  workType = locParts[0];
                  if (locParts[1] && _isEmpType(locParts[1]) && !empType) empType = locParts[1];
                  continue;
                }

                if (_isEmpType(t) && !empType) {
                  empType = t;
                  continue;
                }

                if (_isTitleOrCompany(t)) {
                  if (!title) {
                    title = t;
                  } else if (!company) {
                    // "Company · EmploymentType" compound
                    const parts = t.split('·').map(s => s.trim());
                    company = parts[0];
                    if (parts[1] && _isEmpType(parts[1]) && !empType) empType = parts[1];
                  }
                  continue;
                }
              }
              // Description: try multiple selectors LinkedIn uses across versions
              let description = '';
              const descSelectors = [
                'span[data-testid="expandable-text-box"]',
                '.inline-show-more-text span[aria-hidden="true"]',
                '[class*="show-more-less-text"] span[aria-hidden="true"]',
                'span[aria-hidden="true"].full-width',
              ];
              for (const sel of descSelectors) {
                const descEl = entry.querySelector(sel);
                if (descEl) {
                  const cl = descEl.cloneNode(true);
                  cl.querySelectorAll('button, .visually-hidden').forEach(b => b.remove());
                  const dt = cl.textContent.trim().replace(/\s+/g, ' ');
                  if (dt.length > 20) { description = dt; break; }
                }
              }
              // Last resort: find any long text span inside the entry that looks like a description
              if (!description) {
                const allSpans = [...entry.querySelectorAll('span[aria-hidden="true"]')]
                  .filter(s => s.children.length === 0 && !s.closest('a, button'));
                for (const s of allSpans) {
                  const t = (s.textContent || '').trim().replace(/\s+/g, ' ');
                  if (t.length > 60 && !_isDateStr(t) && !_isEmpType(t)) {
                    description = t; break;
                  }
                }
              }
              if (title || company) {
                const key = (title + company).toLowerCase();
                if (!experience.some(r => (r.title + r.company).toLowerCase() === key)) {
                  experience.push({ title, company, dates, duration, employmentType: empType, location: workType, description });
                }
              }
            }
          } catch(e) { /* skip malformed entry */ }
        }
        console.log(`[ProfileScrape SDUI] experience: ${experience.length} entries`, experience.map(e => `${e.title} @ ${e.company}`));
      }

      // Strategy 1: Find ALL list items (fallback for older LinkedIn layouts)
      // LinkedIn structure: section > ul > li.group (company) > div > ul > li.leaf (role 1, role 2)
      // Single-role companies: section > ul > li.leaf (role with company inline)
      // Skip if SDUI strategy already found entries
      const allExpItems = experience.length > 0 ? [] : [...expSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"], .artdeco-list__item')];
      const leafItems = [];
      const groupItems = [];

      for (const item of allExpItems) {
        if (item.closest('nav, header, footer, button')) continue;
        // Check for nested li at multiple depth levels (LinkedIn wraps in many divs)
        const hasChildLi = item.querySelector(':scope > ul > li, :scope > div > ul > li, :scope > div > div > ul > li, :scope > div > div > div > ul > li');
        if (hasChildLi && item.tagName === 'LI') {
          groupItems.push(item);
        } else {
          leafItems.push(item);
        }
      }

      // Use leaf items if available; if too few found (< 2), also try direct section children
      let items = leafItems.length > 1 ? leafItems : Array.from(allExpItems).filter(i => !i.closest('nav, header, footer'));

      // Fallback: if we only found 0-1 items via selectors, try the section's direct > ul > li
      if (items.length <= 1) {
        const directUl = expSec.querySelector(':scope > div > ul, :scope > ul, :scope > div > div > ul');
        if (directUl) {
          const directItems = directUl.querySelectorAll(':scope > li');
          if (directItems.length > items.length) {
            // Expand groups: for each direct li, check if it's a group and extract nested leaves
            const expanded = [];
            for (const di of directItems) {
              const nestedLis = di.querySelectorAll(':scope > div > ul > li, :scope > div > div > ul > li');
              if (nestedLis.length > 0) {
                for (const nl of nestedLis) expanded.push(nl);
              } else {
                expanded.push(di);
              }
            }
            items = expanded.length > 0 ? expanded : Array.from(directItems);
          }
        }
      }

      if (items.length > 0) {
        for (const li of items) {
          const spans = getExpSpans(li);
          const seenTexts = new Set();
          const texts = spans
            .map(s => (s.textContent || '').trim().replace(/\s+/g, ' '))
            .filter(t => t.length > 0 && t.length < 500)
            .filter(t => { const k = t.toLowerCase(); if (seenTexts.has(k)) return false; seenTexts.add(k); return true; });
          if (texts.length === 0) continue;

          // Always use the semantic parser (data-field + content classification — no CSS class dependency)
          const entry = parseExpItemSemantic(li, texts);

          // For nested roles under a company group, extract company name from parent
          if (!entry.company) {
            const parentLi = li.parentElement?.closest('li');
            if (parentLi) {
              // Get the FIRST text span of the parent (= company name)
              const parentSpans = Array.from(parentLi.querySelectorAll(':scope > div span[aria-hidden="true"]'))
                .filter(s => s.children.length === 0 && !s.closest('button, ul'));
              for (const ps of parentSpans) {
                const pt = normalize(ps.textContent);
                if (pt && pt.length > 1 && pt.length < 80 && !isUiNoise(pt) && !/\d{4}/.test(pt)) {
                  entry.company = pt;
                  break;
                }
              }
            }
          }

          if ((entry.title || entry.company) && !isUiNoise(entry.title) && !isUiNoise(entry.company)) {
            const key = (entry.title + entry.company).toLowerCase();
            if (!experience.some(r => (r.title + r.company).toLowerCase() === key)) {
              experience.push(entry);
            }
          }
          if (experience.length >= 15) break;
        }
      }

      // Strategy 2: hashed class / section text fallback
      if (experience.length === 0) {
        let texts = rqa(expSec, ['p.f6996daa', '.text-body-medium', '[class*="text-body-medium"]']).map(p => p.textContent.trim()).filter(t => t.length > 1);
        if (texts.length === 0) {
          texts = (expSec.innerText || '').split('\n').map(t => t.trim()).filter(Boolean);
        }
        let current = {};
        for (const text of texts) {
          if (isUiNoise(text)) continue;
          // Skip standalone skill-list lines like "Python, SQL and +3 skills"
          if (/and \+\d+ skills?/i.test(text)) continue;

          const isDate = /\b(20\d\d|19\d\d|Present|présent|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(text);
          const isWorkMode = /^(Remote|On-site|Hybrid)$/i.test(text);
          const isEmpType  = /^(Internship|Full-time|Part-time|Contract|Freelance|Self-employed|Apprenticeship|Seasonal|Temporary|Volunteering)$/i.test(text);

          if (isDate && current.title) {
            // Split "Aug 2025 - Oct 2025 · 3 mos" → dates + duration
            const dateParts = text.split('·');
            current.dates    = dateParts[0].trim();
            current.duration = dateParts[1]?.trim() || '';

            // If company still has employment type embedded ("Smart Maint · Internship"),
            // extract it now so it doesn't pollute the company field.
            if (current.company && current.company.includes('·')) {
              const compParts = current.company.split('·');
              current.company        = compParts[0].trim();
              current.employmentType = current.employmentType || compParts[1]?.trim() || '';
            }

            experience.push({
              title: current.title || '',
              company: current.company || '',
              dates: current.dates || '',
              duration: current.duration || '',
              employmentType: current.employmentType || '',
              location: current.location || '',
              description: current.description || '',
            });
            current = {};
            if (experience.length >= 15) break;

          } else if (isWorkMode) {
            // "Remote" / "On-site" / "Hybrid" after company is set → location
            if (current.title) current.location = current.location || text;

          } else if (isEmpType) {
            // "Internship" / "Full-time" etc. after company is set → employmentType
            if (current.title) current.employmentType = current.employmentType || text;

          } else if (text.length > 60 && current.title && current.company) {
            // Long text after title+company → description
            current.description = current.description
              ? current.description + ' ' + text
              : text;

          } else if (!current.title) {
            // Skip pure work-mode/emp-type tokens that appear before any title
            if (isWorkMode || isEmpType) continue;
            if (text.length > 100) continue;
            current.title = text;

          } else if (!current.company) {
            if (text.length < 100 && !/and \+\d+ skills?/i.test(text)) {
              // Keep full "Company · Internship" string; we'll split it on the date line
              current.company = text;
            }
          }
        }
        // Push any trailing entry that never got a date line
        if (current.title && current.company && !isUiNoise(current.title) && !isUiNoise(current.company)) {
          if (current.company.includes('·')) {
            const compParts = current.company.split('·');
            current.company        = compParts[0].trim();
            current.employmentType = current.employmentType || compParts[1]?.trim() || '';
          }
          experience.push({
            title: current.title || '',
            company: current.company || '',
            dates: current.dates || '',
            duration: current.duration || '',
            employmentType: current.employmentType || '',
            location: current.location || '',
            description: current.description || '',
          });
        }
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Experience section error:', e); }

    // ── EDUCATION ────────────────────────────────────────────
    const education = [];
    let eduSec = null;
    try {
    eduSec = findSection(['Education', 'Formation', 'education', 'formation', 'Educación', 'Ausbildung', 'Istruzione', 'Educação', 'Formação', 'تعليم']);

    if (eduSec) {
      // ── Strategy 0: SDUI-specific education parser (2025+ LinkedIn layout) ────
      // Strategy 0a: Edit links — only present on own profile (most accurate)
      const sduiEduLinks = [...eduSec.querySelectorAll('a[href*="/details/education/edit/forms/"]')];
      for (const link of sduiEduLinks) {
        try {
          const ps = [...link.querySelectorAll('p')];
          const allPTexts = ps.map(p => normalize(p.textContent)).filter(t => t.length > 1 && !isUiNoise(t));
          const school = allPTexts.find(t => !/^\d{4}/.test(t) && !/\d{4}/.test(t)) || (ps[0]?.textContent || '').trim();
          const datesP = ps.find(p => /\d{4}/.test(p.textContent));
          const dates = (datesP?.textContent || '').trim();
          // Degree line: the <p> that contains "degree" keyword or sits between school and dates
          // On LinkedIn SDUI: p[0]=school, p[1]="Master's degree, Field", p[2]=dates  OR  p[1]=dates
          const nonSchoolNonDate = allPTexts.filter(t => t !== school && !/\d{4}/.test(t) && !isUiNoise(t));
          // "Master's degree, Data analytics and artificial intelligence" → split on first comma
          const degreeRaw = nonSchoolNonDate[0] || '';
          const commaIdx = degreeRaw.indexOf(',');
          const degree = commaIdx > 0 ? degreeRaw.slice(0, commaIdx).trim() : degreeRaw;
          const fieldOfStudy = commaIdx > 0 ? degreeRaw.slice(commaIdx + 1).trim() : (nonSchoolNonDate[1] || '');
          if (school && !isUiNoise(school) && !/^\d{4}/.test(school)) {
            const key = (school + dates).toLowerCase();
            if (!education.some(e => (e.school + e.dates).toLowerCase() === key)) {
              education.push({ school, degree, fieldOfStudy, dates, description: '' });
            }
          }
        } catch(e) { /* skip */ }
        if (education.length >= 8) break;
      }

      // Strategy 0b: componentkey entries — works on other people's profiles (no edit links)
      if (education.length === 0) {
        const sduiEduEntries = [...eduSec.querySelectorAll('div[componentkey^="entity-collection-item"]')];
        for (const entry of sduiEduEntries) {
          try {
            const ps = [...entry.querySelectorAll('p')].map(p => (p.textContent || '').trim()).filter(Boolean);
            const school = ps.find(t => t && !isUiNoise(t) && !/^\d{4}/.test(t) && t.length > 2);
            if (!school) continue;
            const datesStr = ps.find(t => /\d{4}/.test(t)) || '';
            const degreeStr = ps.find(t => t !== school && t !== datesStr && !isUiNoise(t) && t.length > 2) || '';
            const key = (school + datesStr).toLowerCase();
            if (!education.some(e => (e.school + e.dates).toLowerCase() === key)) {
              education.push({ school, degree: degreeStr, fieldOfStudy: '', dates: datesStr, description: '' });
            }
          } catch(e) { /* skip */ }
          if (education.length >= 8) break;
        }
        if (sduiEduEntries.length > 0) console.log(`[ProfileScrape SDUI] education (0b): ${education.length} entries`);
      }

      if (sduiEduLinks.length > 0) console.log(`[ProfileScrape SDUI] education: ${education.length} entries`, education.map(e => `${e.school} (${e.dates})`));
      // Find leaf items (fallback for older layouts — skip if SDUI already found entries)
      const allEduItems = education.length > 0 ? [] : [...eduSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"], .artdeco-list__item')];
      const eduLeafItems = [];
      for (const item of allEduItems) {
        if (item.closest('nav, header, footer, button')) continue;
        const hasChildLi = item.querySelector(':scope > ul > li, :scope > div > ul > li, :scope > div > div > ul > li, :scope > div > div > div > ul > li');
        if (hasChildLi && item.tagName === 'LI') continue;
        eduLeafItems.push(item);
      }

      // Fallback: try direct section > ul > li if leaf detection found too few
      let items = eduLeafItems.length > 0 ? eduLeafItems : Array.from(allEduItems).filter(item => !item.closest('nav, header, footer'));
      if (items.length <= 1) {
        const directUl = eduSec.querySelector(':scope > div > ul, :scope > ul, :scope > div > div > ul');
        if (directUl) {
          const directItems = directUl.querySelectorAll(':scope > li');
          if (directItems.length > items.length) {
            const expanded = [];
            for (const di of directItems) {
              const nested = di.querySelectorAll(':scope > div > ul > li, :scope > div > div > ul > li');
              if (nested.length > 0) { for (const n of nested) expanded.push(n); }
              else expanded.push(di);
            }
            items = expanded.length > 0 ? expanded : Array.from(directItems);
          }
        }
      }

      if (items.length > 0) {
        for (const li of items) {
          const spans = getScopedSpans(li);
          // Also try .t-bold span and .t-14 span as additional sources
          const extraSpans = Array.from(li.querySelectorAll('.t-bold span, .t-14 span'))
            .filter(s => s.children.length === 0 && !s.closest('button'));
          const allSpans = [...spans];
          for (const es of extraSpans) {
            if (!allSpans.includes(es)) allSpans.push(es);
          }

          const seenTexts = new Set();
          const texts = allSpans
            .map(s => normalize(s.textContent))
            .filter(t => t.length > 0 && t.length < 250)
            .filter(t => {
              if (isUiNoise(t)) return false;
              const key = t.toLowerCase();
              if (seenTexts.has(key)) return false;
              seenTexts.add(key);
              return true;
            });

          if (texts.length > 0) {
            // Separate dates from non-dates
            const dateTexts = texts.filter(t => /\d{4}/.test(t) && t.length < 40);
            const nonDate = texts.filter(t => !/^\d{4}[\s–\-]/.test(t) && !/^\d{4}$/.test(t) && (!/\d{4}/.test(t) || t.length >= 40));
            const school = nonDate[0] || '';
            const degree = nonDate[1] || '';
            const fieldOfStudy = nonDate[2] || '';
            const dates = dateTexts[0] || '';
            const description = texts.find(t => t.length > 60 && t !== school && t !== degree && t !== fieldOfStudy && t !== dates) || '';

            // Skip noise: activity feed entries, pure date entries
            const isActivityEntry = school.includes(' • ') ||
              /^\d+\s*(comments?|likes?|reactions?)/i.test(degree) ||
              /^live$/i.test(degree) || /^live$/i.test(school);
            if (school && !isUiNoise(school) && !isActivityEntry &&
                !/^\d{4}[\s–\-]/.test(school) && !/^\d{4}$/.test(school)) {
              const key = school.toLowerCase();
              if (!education.some(e => e.school.toLowerCase() === key && e.degree.toLowerCase() === degree.toLowerCase())) {
                education.push({ school, degree, fieldOfStudy, dates, description });
              }
            }
          }
          if (education.length >= 8) break;
        }
      }

      // Strategy 2: hashed class / section text fallback
      if (education.length === 0) {
        let texts = rqa(eduSec, ['p.f6996daa', '.text-body-medium', '[class*="text-body-medium"]']).map(p => p.textContent.trim()).filter(t => t.length > 1);
        if (texts.length === 0) {
          texts = (eduSec.innerText || '').split('\n').map(t => t.trim()).filter(Boolean);
        }
        let current = {};
        for (const text of texts) {
          if (isUiNoise(text)) continue;
          if (/^\w+ \d{4}/.test(text) || /and \+\d+ skills?/i.test(text)) continue;
          if (!current.school) {
            if (/^\d{4}[\s–\-]/.test(text) || /^\d{4}$/.test(text)) continue;
            current.school = text;
          } else if (!current.degree) {
            current.degree = text;
            education.push({ ...current, fieldOfStudy: '', dates: '', description: '' });
            current = {};
            if (education.length >= 8) break;
          }
        }
        if (current.school && !isUiNoise(current.school) && !/^\d{4}/.test(current.school)) {
          education.push({ ...current, fieldOfStudy: '', dates: '', description: '' });
        }
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Education section error:', e); }

    // ── SKILLS ───────────────────────────────────────────────
    const skills = [];
    let skillsSec = null;
    try {
    skillsSec = findSection(['Skills', 'Compétences', 'skills', 'compétences', 'مهارات', 'Habilidades', 'Aptitudes', 'Kenntnisse', 'Competenze', 'Competências']);
    const _skillSeen = new Set();

    const _isSkillNoise = (t) => {
      if (!t || t.length < 2 || t.length > 80) return true;
      if (isUiNoise(t)) return true;
      if (/\d{4}|endors|recommand|see more|voir plus|show all|voir tout/i.test(t)) return true;
      if (/and \+\d+ skills?/i.test(t)) return true;
      // Filter experience-like entries (e.g. "Engineer at Google") but NOT short skill names containing "at"
      if ((t.includes(' at ') || t.includes(' @ ')) && t.length > 30) return true;
      // School names, degrees
      if (/^(Université|University|École|Bachelor|Master|Licence|MBA|Ph\.?D|Doctorat)/i.test(t)) return true;
      return false;
    };

    if (skillsSec) {
      // Seed with skills captured from the modal (if modal-based expansion was used).
      for (const t of _modalSkillCandidates) {
        const key = t.toLowerCase();
        if (_isSkillNoise(t) || _skillSeen.has(key)) continue;
        _skillSeen.add(key);
        skills.push(t);
      }

      // Helper: extract clean skill name from a span (handles nested spans)
      const getSkillText = (span) => {
        if (!span) return '';
        // If the span has children, get the deepest text or use textContent
        if (span.children.length > 0) {
          // Find the deepest leaf span
          const leaf = span.querySelector('span:not(:has(span))') || span;
          return (leaf.textContent || '').trim();
        }
        return (span.textContent || '').trim();
      };

      // ── Strategy 0: SDUI-specific skills parser (2025+ LinkedIn layout) ────
      const sduiSkillEntries = [...skillsSec.querySelectorAll('div[componentkey^="com.linkedin.sdui.profile.skill("]')];
      if (sduiSkillEntries.length > 0) {
        for (const entry of sduiSkillEntries) {
          const p = entry.querySelector('p');
          const t = (p?.textContent || '').trim();
          if (!t || t.length < 2 || t.length > 80 || _isSkillNoise(t)) continue;
          if (!_skillSeen.has(t.toLowerCase())) {
            _skillSeen.add(t.toLowerCase());
            skills.push(t);
          }
          if (skills.length >= 50) break;
        }
        console.log(`[ProfileScrape SDUI] skills inline: ${skills.length}`, skills.slice(0, 10));
      }

      // Strategy 1: Get the FIRST span[aria-hidden] in each li/entity — that's the skill name
      const skillItems = skills.length > 0 ? [] : skillsSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"], .artdeco-list__item');
      for (const item of skillItems) {
        if (item.closest('nav, header, footer, button')) continue;
        // First aria-hidden span that's not inside a button
        const nameSpan = item.querySelector('span[aria-hidden="true"]:not(button span)');
        if (!nameSpan) continue;
        const t = getSkillText(nameSpan);
        if (_isSkillNoise(t)) continue;
        if (!_skillSeen.has(t.toLowerCase())) {
          _skillSeen.add(t.toLowerCase());
          skills.push(t);
        }
        if (skills.length >= 50) break;
      }

      // Strategy 2: all aria-hidden leaf spans (catches skills in non-standard layouts)
      if (skills.length < 3) {
        for (const s of skillsSec.querySelectorAll('span[aria-hidden="true"]')) {
          if (s.closest('nav, header, button')) continue;
          const t = getSkillText(s);
          if (_isSkillNoise(t)) continue;
          if (!_skillSeen.has(t.toLowerCase())) {
            _skillSeen.add(t.toLowerCase());
            skills.push(t);
          }
          if (skills.length >= 50) break;
        }
      }

      // Strategy 3: hashed class / text fallback
      if (skills.length === 0) {
        const textLines = (skillsSec.innerText || '').split('\n').map(t => t.trim()).filter(Boolean);
        for (const text of textLines) {
          if (_isSkillNoise(text)) continue;
          if (!text.includes('·') && !text.includes('Morocco') && !text.includes('Tunisia') &&
              !_skillSeen.has(text.toLowerCase())) {
            _skillSeen.add(text.toLowerCase());
            skills.push(text);
            if (skills.length >= 50) break;
          }
        }
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Skills section error:', e); }

    // ── LANGUAGES ─────────────────────────────────────────────
    const languages = [];
    let langSec = null;
    try {
    langSec = findSection(['Languages', 'Langues', 'languages', 'langues', 'اللغات', 'Idiomas', 'Sprachen', 'Lingue', 'Idiomas']);
    if (langSec) {
      const allItems = Array.from(langSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"]'))
        .filter(item => !item.parentElement?.closest('li'));
      for (const item of allItems) {
        const spans = getScopedSpans(item);
        const seenT = new Set();
        const texts = spans
          .map(s => normalize(s.textContent))
          .filter(t => t.length > 1 && t.length < 100)
          .filter(t => { const k = t.toLowerCase(); if (seenT.has(k)) return false; seenT.add(k); return true; })
          .filter(t => !isUiNoise(t));
        if (texts.length > 0 && texts[0].length > 1 && texts[0].length < 50) {
          languages.push({ language: texts[0], proficiency: texts[1] || '' });
        }
        if (languages.length >= 10) break;
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Languages section error:', e); }

    // ── CERTIFICATIONS ────────────────────────────────────────
    const certifications = [];
    let certSec = null;
    try {
    certSec = findSection(['Licenses', 'Certifications', 'Licences', 'certifications', 'licenses & certifications', 'licences et certifications', 'Licencias', 'Certificaciones', 'Zertifizierungen', 'Lizenzen', 'Certificazioni', 'Licenças', 'Certificações', 'التراخيص والشهادات']);
    if (certSec) {
      // Guard against endorser rows ("Naaima BAKRIM and 32 others") and analytics buttons
      const isCertNoise = (t) => {
        if (isUiNoise(t)) return true;
        if (/^view\s+analytics$/i.test(t)) return true;
        if (/\band\s+\d+\s+others?$/i.test(t)) return true;
        if (/^\d+\s+others?$/i.test(t)) return true;
        if (/^(see|show|view)\s+credential$/i.test(t)) return true;
        if (/^licenses?\s*(&|and|et|y|und)?\s*certif/i.test(t)) return true;
        if (/^licences?\s*(&|and|et|y|und)?\s*certif/i.test(t)) return true;
        if (/^certifications?\s*(&|and|et|y|und)?\s*licen/i.test(t)) return true;
        return false;
      };

      // ── Strategy 0: SDUI edit links (own profile — most accurate) ────────────
      const isSectionHeader = t => /licen|certif/i.test(t) && t.length < 50;
      const sduiCertLinks = [...certSec.querySelectorAll(
        'a[href*="/details/certifications/edit/forms/"], a[href*="/details/licenses/edit/forms/"]'
      )];
      console.log('[CertDebug] Strategy 0 sduiCertLinks count:', sduiCertLinks.length);
      if (sduiCertLinks.length > 0) {
        sduiCertLinks.forEach((link, i) => {
          const ps = [...link.querySelectorAll('p')].map(p => normalize(p.textContent));
          console.log('[CertDebug] link', i, 'p texts:', JSON.stringify(ps));
        });
      }
      for (const link of sduiCertLinks) {
        try {
          const ps = [...link.querySelectorAll('p')]
            .map(p => normalize(p.textContent))
            .filter(t => t.length > 1 && !isCertNoise(t) && !isSectionHeader(t));
          // p[0] = cert name, p[1] = issuer, p[2] = "Issued MMM YYYY"
          const cleanPs = ps.filter(t => !/^(licenses?|licences?|certifications?)(\s*(&|and|et)\s*(licenses?|licences?|certifications?))?$/i.test(t));
          const certName = cleanPs.find(t => !/^\d{4}/.test(t) && !/\bIssued\b/i.test(t)) || '';
          const issuer   = cleanPs.find((t, i) => i > 0 && t !== certName && !/^\d{4}/.test(t) && !/\bIssued\b/i.test(t)) || '';
          const dateStr  = cleanPs.find(t => /\d{4}/.test(t) || /\bIssued\b/i.test(t)) || '';
          if (certName && !isCertNoise(certName) && !isSectionHeader(certName)) {
            if (!certifications.some(c => c.name.toLowerCase() === certName.toLowerCase()))
              certifications.push({ name: certName, issuer, date: dateStr });
          }
        } catch(e) { /* skip */ }
        if (certifications.length >= 20) break;
      }
      if (sduiCertLinks.length > 0) console.log(`[ProfileScrape SDUI] certifications: ${certifications.length} entries`);

      // ── Strategy 1: Generic item fallback (other profiles / older layout) ────
      if (certifications.length === 0) {
        console.log('[CertDebug] Strategy 0 found 0 certs, falling back to Strategy 1');
        const allItems = Array.from(certSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"], .artdeco-list__item'))
          .filter(item => !item.parentElement?.closest('li'));
        console.log('[CertDebug] Strategy 1 allItems count:', allItems.length);
        for (const item of allItems) {
          const spans = getScopedSpans(item);
          const seenT = new Set();
          const texts = spans
            .map(s => normalize(s.textContent))
            .filter(t => t.length > 1 && t.length < 200)
            .filter(t => { const k = t.toLowerCase(); if (seenT.has(k)) return false; seenT.add(k); return true; })
            .filter(t => !isCertNoise(t));
          console.log('[CertDebug] item texts before cleanTexts:', JSON.stringify(texts));
          const cleanTexts = texts.filter(t => !isSectionHeader(t) && !/^(licenses?|licences?|certifications?)(\s*(&|and|et)\s*(licenses?|licences?|certifications?))?$/i.test(t));
          if (cleanTexts.length > 0) {
            const certName = cleanTexts[0] || '';
            const issuer = cleanTexts.find((t, i) => i > 0 && t.length > 1 && !/^\d{4}/.test(t) && !/^issued|^expires/i.test(t)) || '';
            const dateStr = cleanTexts.find(t => /\b(issued?|expires?|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t) || /\d{4}/.test(t)) || '';
            if (certName && !isCertNoise(certName) && !isSectionHeader(certName)) certifications.push({ name: certName, issuer, date: dateStr });
          }
          if (certifications.length >= 20) break;
        }
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Certifications section error:', e); }

    // ── VOLUNTEER ─────────────────────────────────────────────
    const volunteer = [];
    let volSec = null;
    try {
    volSec = findSection(['Volunteer', 'Bénévolat', 'volunteer', 'volunteering', 'bénévolat', 'volontariat', 'voluntariado', 'Ehrenamt', 'Volontariato', 'Voluntariado', 'تطوع']);
    if (volSec) {
      const allItems = Array.from(volSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"]'))
        .filter(item => !item.parentElement?.closest('li'));
      for (const item of allItems) {
        const spans = getScopedSpans(item);
        const seenT = new Set();
        const texts = spans
          .map(s => normalize(s.textContent))
          .filter(t => t.length > 1 && t.length < 300)
          .filter(t => { const k = t.toLowerCase(); if (seenT.has(k)) return false; seenT.add(k); return true; })
          .filter(t => !isUiNoise(t));
        if (texts.length > 0) {
          const role = texts[0] || '';
          const org = texts.find((t, i) => i > 0 && !/\d{4}/.test(t) && !/^\d/.test(t) && t.length > 1) || '';
          const dates = texts.find(t => /\d{4}/.test(t)) || '';
          const description = texts.find(t => t.length > 50 && t !== role && t !== org && t !== dates) || '';
          if (role && !isUiNoise(role)) volunteer.push({ role, organization: org, dates, description });
        }
        if (volunteer.length >= 10) break;
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Volunteer section error:', e); }

    // ── PROJECTS ──────────────────────────────────────────────
    const projects = [];
    let projSec = null;
    try {
    projSec = findSection(['Projects', 'Projets', 'projects', 'projets', 'Proyectos', 'Projekte', 'Progetti', 'Projetos', 'مشاريع']);
    if (projSec) {
      const allItems = Array.from(projSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"]'))
        .filter(item => !item.parentElement?.closest('li'));
      for (const item of allItems) {
        const spans = getScopedSpans(item);
        const seenT = new Set();
        const texts = spans
          .map(s => normalize(s.textContent))
          .filter(t => t.length > 1 && t.length < 400)
          .filter(t => { const k = t.toLowerCase(); if (seenT.has(k)) return false; seenT.add(k); return true; })
          .filter(t => !isUiNoise(t));
        if (texts.length > 0) {
          const title = texts[0] || '';
          const dates = texts.find(t => /\d{4}/.test(t)) || '';
          const description = texts.find(t => t.length > 50 && t !== title && t !== dates) || '';
          if (title && !isUiNoise(title)) projects.push({ title, dates, description });
        }
        if (projects.length >= 15) break;
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Projects section error:', e); }

    // ── HONORS & AWARDS ─────────────────────────────────────
    const honors = [];
    let honorSec = null;
    try {
    honorSec = findSection(['Honors', 'Awards', 'honors', 'awards', 'Distinctions', 'distinctions', 'honors & awards', 'Premios', 'Reconocimientos', 'Auszeichnungen', 'Premi', 'Riconoscimenti', 'Prêmios', 'جوائز']);
    if (honorSec) {
      const allItems = Array.from(honorSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"]'))
        .filter(item => !item.parentElement?.closest('li'));
      for (const item of allItems) {
        const spans = getScopedSpans(item);
        const seenT = new Set();
        const texts = spans
          .map(s => normalize(s.textContent))
          .filter(t => t.length > 1 && t.length < 300)
          .filter(t => { const k = t.toLowerCase(); if (seenT.has(k)) return false; seenT.add(k); return true; })
          .filter(t => !isUiNoise(t));
        if (texts.length > 0) {
          const title = texts[0] || '';
          const issuer = texts.find((t, i) => i > 0 && !/\d{4}/.test(t) && t.length > 1) || '';
          const dates = texts.find(t => /\d{4}/.test(t)) || '';
          const description = texts.find(t => t.length > 50 && t !== title && t !== issuer && t !== dates) || '';
          if (title && !isUiNoise(title)) honors.push({ title, issuer, dates, description });
        }
        if (honors.length >= 15) break;
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Honors section error:', e); }

    // ── PUBLICATIONS ─────────────────────────────────────────
    const publications = [];
    let pubSec = null;
    try {
    pubSec = findSection(['Publications', 'publications', 'Publication', 'Publicaciones', 'Publikationen', 'Pubblicazioni', 'Publicações', 'منشورات']);
    if (pubSec) {
      const allItems = Array.from(pubSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"]'))
        .filter(item => !item.parentElement?.closest('li'));
      for (const item of allItems) {
        const spans = getScopedSpans(item);
        const seenT = new Set();
        const texts = spans
          .map(s => normalize(s.textContent))
          .filter(t => t.length > 1 && t.length < 400)
          .filter(t => { const k = t.toLowerCase(); if (seenT.has(k)) return false; seenT.add(k); return true; })
          .filter(t => !isUiNoise(t));
        if (texts.length > 0) {
          const title = texts[0] || '';
          const publisher = texts.find((t, i) => i > 0 && !/\d{4}/.test(t) && t.length > 1 && t.length < 80) || '';
          const dates = texts.find(t => /\d{4}/.test(t)) || '';
          const description = texts.find(t => t.length > 50 && t !== title && t !== publisher && t !== dates) || '';
          if (title && !isUiNoise(title)) publications.push({ title, publisher, dates, description });
        }
        if (publications.length >= 15) break;
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Publications section error:', e); }

    // ── ORGANIZATIONS ────────────────────────────────────────
    const organizations = [];
    let orgSec = null;
    try {
    orgSec = findSection(['Organizations', 'Organisations', 'organizations', 'organisations', 'Organizaciones', 'Organisationen', 'Organizzazioni', 'Organizações', 'منظمات']);
    if (orgSec) {
      const allItems = Array.from(orgSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"]'))
        .filter(item => !item.parentElement?.closest('li'));
      for (const item of allItems) {
        const spans = getScopedSpans(item);
        const seenT = new Set();
        const texts = spans
          .map(s => normalize(s.textContent))
          .filter(t => t.length > 1 && t.length < 300)
          .filter(t => { const k = t.toLowerCase(); if (seenT.has(k)) return false; seenT.add(k); return true; })
          .filter(t => !isUiNoise(t));
        if (texts.length > 0) {
          const name = texts[0] || '';
          const role = texts.find((t, i) => i > 0 && !/\d{4}/.test(t) && t.length > 1) || '';
          const dates = texts.find(t => /\d{4}/.test(t)) || '';
          if (name && !isUiNoise(name)) organizations.push({ name, role, dates });
        }
        if (organizations.length >= 15) break;
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Organizations section error:', e); }

    // ── COURSES ──────────────────────────────────────────────
    const courses = [];
    let courseSec = null;
    try {
    courseSec = findSection(['Courses', 'Cours', 'courses', 'cours', 'Cursos', 'Kurse', 'Corsi', 'Cursos', 'دورات']);
    if (courseSec) {
      const allItems = Array.from(courseSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"]'))
        .filter(item => !item.parentElement?.closest('li'));
      for (const item of allItems) {
        const spans = getScopedSpans(item);
        const seenT = new Set();
        const texts = spans
          .map(s => normalize(s.textContent))
          .filter(t => t.length > 1 && t.length < 200)
          .filter(t => { const k = t.toLowerCase(); if (seenT.has(k)) return false; seenT.add(k); return true; })
          .filter(t => !isUiNoise(t));
        if (texts.length > 0) {
          const name = texts[0] || '';
          const number = texts.find((t, i) => i > 0 && t.length < 30) || '';
          if (name && !isUiNoise(name)) courses.push({ name, number });
        }
        if (courses.length >= 30) break;
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Courses section error:', e); }

    // ── RECOMMENDATIONS ─────────────────────────────────────
    const recommendations = [];
    let recSec = null;
    try {
    recSec = findSection(['Recommendations', 'Recommandations', 'recommendations', 'recommandations', 'Recomendaciones', 'Empfehlungen', 'Raccomandazioni', 'Recomendações', 'توصيات']);
    if (recSec) {
      // Recommendations are structured differently — look for text blocks
      const allItems = Array.from(recSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"]'))
        .filter(item => !item.parentElement?.closest('li'));
      for (const item of allItems) {
        const spans = getScopedSpans(item);
        const seenT = new Set();
        const texts = spans
          .map(s => normalize(s.textContent))
          .filter(t => t.length > 1 && t.length < 1000)
          .filter(t => { const k = t.toLowerCase(); if (seenT.has(k)) return false; seenT.add(k); return true; })
          .filter(t => !isUiNoise(t));
        if (texts.length > 0) {
          const author = texts[0] || '';
          const relationship = texts.find((t, i) => i > 0 && t.length < 80 && !/\d{4}/.test(t)) || '';
          const text = texts.find(t => t.length > 50 && t !== author && t !== relationship) || '';
          if (author && !isUiNoise(author)) recommendations.push({ author, relationship, text });
        }
        if (recommendations.length >= 10) break;
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Recommendations section error:', e); }

    // ── IS OWN PROFILE ───────────────────────────────────────
    // Detect BEFORE detail page navigation (which changes the DOM)
    let isOwn = false;
    // Strategy 1: look for edit/add buttons (classic detection)
    for (const btn of document.querySelectorAll('button, a')) {
      const ariaL = (btn.getAttribute('aria-label') || '').toLowerCase();
      const txtL  = (btn.textContent || '').toLowerCase();
      const label = ariaL + ' ' + txtL;
      if (/edit.*intro|edit.*profile|modifier.*profil|add.*section|ajouter.*section|open to/i.test(label) ||
          /profile.*edit|edit.*about|edit.*experience|edit.*education|add profile section/i.test(ariaL)) {
        isOwn = true; break;
      }
    }
    // Strategy 2: pencil/edit icons (SVG icons that only appear on own profile)
    if (!isOwn) {
      const editIcons = document.querySelectorAll('button[aria-label*="edit" i], button[aria-label*="Edit" i], button[aria-label*="modifier" i]');
      if (editIcons.length >= 2) isOwn = true;
    }
    // Strategy 3: "Add profile section" or "Open to" banner — only on own profile
    if (!isOwn) {
      const addSec = document.querySelector('#ember-add-profile-section, .pv-profile-section__actions, [class*="profile-section-card"] button[aria-label]');
      if (addSec) isOwn = true;
    }
    // Strategy 4: URL contains own slug (if email-based slug matches, or LinkedIn sets a me-indicator)
    if (!isOwn) {
      const meLink = document.querySelector('a[href="/me/"], a[href*="/me?"]');
      if (meLink) isOwn = true;
    }

    const isLoggedIn = !document.querySelector('.login-form, #username, #password, .authwall');

    // ── DETAIL PAGE NAVIGATION — DISABLED ──
    // SPA navigation to /details/skills/ etc. destroys the injected script's
    // execution context when LinkedIn does a full page load instead of a
    // client-side route change.  chrome.scripting.executeScript then returns
    // {result: undefined}, losing ALL scraped data.
    // Instead we rely on the inline "Show all" expansion clicks above (Pass 3)
    // and the section-level scrolling (Pass 4) to surface as much data as
    // possible without leaving the current page.
    // (Detail page navigation removed — it destroyed the script context)

    // ── EXTRA METRICS (for DB snapshot) ─────────────────────
    const pageText = normalize(document.body?.innerText || '');

    // Pattern: digits with optional separators (spaces, commas, dots, nbsp) + optional k/m/+, then label
    // Handles: "4 000 + abonnés", "1.234 followers", "500+ connections", "2K seguidores"
    const numPat = '(\\d[\\d.,\\s\u00A0\u202F]*[kKmM+]*)';
    const followersMatch = pageText.match(new RegExp(numPat + '\\s*\\+?\\s*(followers?|abonnés?|seguidores?|follower|متابع(?:ين|ون)?)', 'i'));
    const connectionsMatch = pageText.match(new RegExp(numPat + '\\s*\\+?\\s*(connections?|relations|contacts?|conexiones?|kontakte?|collegamenti|conexões?|اتصال(?:ات)?)', 'i'));
    const postsCountMatch = pageText.match(/\b(\d[\d.,kKmM+]*)\s*(posts?|publications)\b/i);

    // Also try direct element selectors for connections/followers (more reliable)
    let followersCount = followersMatch ? parseCount(followersMatch[1]) : null;
    let connectionsCount = connectionsMatch ? parseCount(connectionsMatch[1]) : null;
    const postsCount = postsCountMatch ? parseCount(postsCountMatch[1]) : null;

    // Fallback: look for the connections/followers elements directly in the DOM
    if (!followersCount || !connectionsCount) {
      for (const a of document.querySelectorAll('a[href*="connections"], a[href*="followers"], span')) {
        const t = (a.textContent || '').trim();
        if (!followersCount && /\d/.test(t) && /followers?|abonnés?/i.test(t)) {
          const m = t.match(/(\d[\d.,kKmM+]*)/);
          if (m) followersCount = parseCount(m[1]);
        }
        if (!connectionsCount && /\d/.test(t) && /connections?|relations/i.test(t)) {
          const m = t.match(/(\d[\d.,kKmM+]*)/);
          if (m) connectionsCount = parseCount(m[1]);
        }
        if (followersCount && connectionsCount) break;
      }
    }

    // ── RECENT POSTS ─────────────────────────────────────────
    const recentPosts = [];
    try {

    // Inline activity post scraping — 3-pass, SDUI-resilient
    // Pass 1: semantic data-urn attributes (stable across class-name hashing)
    // Pass 2: class substring matches (less stable, strong signal)
    // Pass 3: structural fallback for activity page direct scrape
    const activitySec = findSection(['Activity', 'Activité', 'activity', 'activité', 'Actividad', 'Aktivitäten', 'Attività', 'Atividade', 'نشاط']);
    const searchRoot = activitySec || document;
    const _postNoise = t =>
      !t || t.length < 60 ||
      /^\d[\d,.\s]*(followers?|connections?|likes?|comments?|reactions?|shares?)$/i.test(t) ||
      /^(see all|show all|voir tout|activity|activité|load more)$/i.test(t);
    const _addPost = (card) => {
      if (recentPosts.length >= 8) return;
      const inner = card.querySelector('[class*="commentary"]') ||
                    card.querySelector('[class*="update-components-text"]') ||
                    card.querySelector('[data-test-id*="commentary"]') || card;
      const text = normalize((inner.innerText || inner.textContent || '').trim());
      if (_postNoise(text)) return;
      if (!recentPosts.some(p => p.text === text.slice(0, 500)))
        recentPosts.push({ text: text.slice(0, 500) });
    };

    // Pass 1 — SDUI semantic (data-urn, data-view-name)
    for (const sel of ['article[data-urn*="activity"]', '[data-urn*="activity:"][tabindex]',
                        '[data-view-name*="profile-component-entity"]', '[data-finite-scroll-hotspot]']) {
      searchRoot.querySelectorAll(sel).forEach(_addPost);
      if (recentPosts.length >= 8) break;
    }

    // Pass 2 — class substring (hashed but substring-stable)
    if (recentPosts.length < 8) {
      for (const sel of ['[class*="feed-shared-update"]', '[class*="update-components-text"]',
                          'div.feed-shared-update-v2', '.occludable-update',
                          '.pv-recent-activity-section__feed-item']) {
        searchRoot.querySelectorAll(sel).forEach(_addPost);
        if (recentPosts.length >= 8) break;
      }
    }

    // Pass 3 — structural fallback on activity page
    if (recentPosts.length < 3 && /\/recent-activity\/shares\//i.test(location.href)) {
      for (const el of document.querySelectorAll('[role="article"], div[data-urn], article')) {
        if (recentPosts.length >= 8) break;
        _addPost(el);
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Recent posts section error:', e); }

    // Detect current role: prefer the entry with "Present" in dates over first entry
    // ── Final placeholder scrub ────────────────────────────────
    // Strip any placeholder/CTA text that slipped through into final fields.
    const _scrubStr = (s) => (s && !isPlaceholder(s) ? s : '');

    // Filter experience entries: remove any where title OR company is a placeholder,
    // or where title is clearly a description sentence (scraper misclassified).
    // Also remove entries that are LinkedIn "Add experience" empty-state placeholders:
    //   company === "Add experience"  AND  title looks like a date/duration string
    //   e.g. { title: "2023 - Present · 2 yrs", company: "Add experience" }
    const _isLinkedInExpPlaceholder = (e) => {
      const comp = (e.company || '').trim();
      const title = (e.title || '').trim();
      if (/^add experience$/i.test(comp) && /\d{4}/.test(title)) return true;
      if (/^add experience$/i.test(title)) return true;
      // Title that is purely a date/duration line and has no real company
      if (/^\d{4}\s*[-–]\s*(present|\d{4})/i.test(title) && (!comp || /^add experience$/i.test(comp))) return true;
      // Title that looks like post/activity content (long sentence with social proof words)
      if (title.length > 80 && /\b(repost|reaction|comment|follower|connection|gender|AI gap|matters because)\b/i.test(title)) return true;
      // Title is a location string (e.g. "United States · On-site")
      if (/^[A-Z][^.!?]{3,50}[·•]\s*(On-site|Remote|Hybrid)$/i.test(title)) return true;
      // Company looks like a name + context (Highlights section leak)
      if (/you both studied|you both worked/i.test(comp)) return true;
      return false;
    };

    const _cleanExp = experience.slice(0, 15).filter(e => {
      if (!e.title && !e.company) return false;
      if (isPlaceholder(e.title) || isPlaceholder(e.company)) return false;
      if (_isLinkedInExpPlaceholder(e)) return false;
      // Title shouldn't be a long sentence — if > 80 chars it's misclassified description
      if (e.title && e.title.length > 80) return false;
      // Company shouldn't be a long sentence either
      if (e.company && e.company.length > 80) return false;
      return true;
    }).map(e => ({
      ...e,
      title:          _scrubStr(e.title),
      company:        _scrubStr(e.company),
      description:    _scrubStr(e.description),
      location:       _scrubStr(e.location),
      employmentType: _scrubStr(e.employmentType),
    }));

    // Filter skills: remove placeholder skill category labels
    const _cleanSkills = skills.slice(0, 50).filter(s => !isPlaceholder(s) && s.length > 1 && s.length < 80);

    const _cleanAbout = _scrubStr(about);
    const _cleanHeadline = _scrubStr(headline);

    const _currentExpClean = _cleanExp.find(e =>
      /present|actuel|en cours|hoy|current|aujourd/i.test(e.dates || '')
    ) || _cleanExp[0];

    return {
      name: name || '',
      headline: _cleanHeadline,
      location: location_ || '',
      about: _cleanAbout,
      profilePhotoUrl: profilePhotoUrl || '',
      currentRole: _scrubStr(_currentExpClean?.title || ''),
      company: _scrubStr(_currentExpClean?.company || ''),
      experience: _cleanExp,
      education: education.slice(0, 8),
      skills: _cleanSkills,
      certifications: certifications.slice(0, 30),
      languages: languages.slice(0, 15),
      volunteer: volunteer.slice(0, 15),
      projects: projects.slice(0, 15),
      honors: honors.slice(0, 15),
      publications: publications.slice(0, 15),
      organizations: organizations.slice(0, 15),
      courses: courses.slice(0, 30),
      recommendations: recommendations.slice(0, 10),
      followersCount,
      connectionsCount,
      postsCount,
      recentPosts,
      scrapedAt: new Date().toISOString(),
      url_slug: url.match(/\/in\/([^/?#]+)/)?.[1] || '',
      _source: onProfile ? 'profile_page' : 'meta_only',
      _isOwn: isOwn,
      _isLoggedIn: isLoggedIn,
      _partial: !onProfile || !isLoggedIn,
      _url: url,
      _jsonLdFound: !!_jsonLd,
      _debug: {
        name, headline, location: location_,
        aboutSecFound: !!aboutSec,
        expSecFound: !!expSec,
        eduSecFound: !!eduSec,
        skillsSecFound: !!skillsSec,
        certSecFound: !!certSec,
        langSecFound: !!langSec,
        volSecFound: !!volSec,
        projSecFound: !!projSec,
        honorSecFound: !!honorSec,
        pubSecFound: !!pubSec,
        orgSecFound: !!orgSec,
        courseSecFound: !!courseSec,
        recSecFound: !!recSec,
        aboutFound: !!about,
        expFound: experience.length,
        eduFound: education.length,
        skillsFound: skills.length,
        certificationsFound: certifications.length,
        languagesFound: languages.length,
        volunteerFound: volunteer.length,
        projectsFound: projects.length,
        honorsFound: honors.length,
        publicationsFound: publications.length,
        organizationsFound: organizations.length,
        coursesFound: courses.length,
        recommendationsFound: recommendations.length,
        followersCount,
        connectionsCount,
        postsCount,
        recentPostsFound: recentPosts.length,
        isLoggedIn, onProfile,
        _sectionsNeedingDetailPage: [..._sectionsNeedingDetailPage],
      },
      _scrapeQuality: {
        photoFound: !!profilePhotoUrl,
        jsonLdUsed: !!_jsonLd,
        aboutComplete: (about || '').length > 100,
        experienceCount: experience.length,
        educationCount: education.length,
        skillsCount: skills.length,
        certificationsCount: certifications.length,
        sectionsFound: [
          !!aboutSec && 'about', !!expSec && 'experience', !!eduSec && 'education',
          !!skillsSec && 'skills', !!certSec && 'certifications', !!langSec && 'languages',
          !!volSec && 'volunteer', !!projSec && 'projects',
        ].filter(Boolean),
        sectionsNeedingDetail: [..._sectionsNeedingDetailPage],
        durationMs: Date.now() - _scrapeStart,
      },
    };
  } catch (err) {
    return { _error: 'scrape_error', message: String(err) };
  }
}

// ?? Wait for a tab to finish loading ?????????????????????????????????????????
function waitForTabLoad(tabId, timeoutMs = 12000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 800); // extra wait for React hydration
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ?? Deep scan: open profiles in background tabs, batched to avoid bot detection ?
async function deepScanProfiles({ slugs }) {
  const BATCH_SIZE  = 3;   // max concurrent tabs
  const BATCH_DELAY = 2000; // ms between batches
  const all = slugs || [];
  const results = [];

  async function scanOne(slug) {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: `https://www.linkedin.com/in/${slug}`, active: false });
      await waitForTabLoad(tab.id, 14000);
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: richProfileScrapeFunction,
      });
      const data = res?.[0]?.result || null;
      if (data) data.url_slug = data.url_slug || slug;
      return { slug, data };
    } catch {
      return { slug, data: null };
    } finally {
      if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  for (let i = 0; i < all.length; i += BATCH_SIZE) {
    const batch = all.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(scanOne));
    results.push(...batchResults);
    // Pause between batches (skip delay after the last batch)
    if (i + BATCH_SIZE < all.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  return results;
}

// ?? AI analysis ???????????????????????????????????????????????????????????????
async function networkingAnalyze(data) {
  const result = await callBackend('/networking/analyze', data);
  return result.data;
}

async function networkingChat(data) {
  const result = await callBackend('/networking/chat', data);
  return result.data;
}

async function profileGapAnalysis(data) {
  const result = await callBackend('/profile/gap-analysis', data);
  return result.data;
}

async function profileAiScore(data) {
  // ── LangGraph Agent (Level 1 smart routing) ──────────────
  // Replaces the old single /profile/ai-score call.
  // The agent runs 3-4 nodes depending on the profile score:
  //   score < 35  → extract → score → deep_diagnostic → recommendations
  //   target given → extract → score → gap_analysis   → recommendations
  //   score ≥ 35  → extract → score →                   recommendations
  const result = await callBackend('/agent/full-analysis', {
    user_profile:   data.profile,
    target_profile: data.target_profile || null,
    goal:           data.goal    || 'job_search',
    ui_lang:        data.ui_lang || 'EN',
  });

  if (!result?.success) throw new Error(result?.detail || 'Agent workflow failed');

  const agent = result.data;

  // Map agent response → shape _renderAiScoreData() already expects,
  // then attach agent extras so the popup can render the new panels.
  return {
    ...agent.ai_score,
    _progress:              agent.progress           || null,
    _agent_recommendations: agent.recommendations,
    _agent_diagnostic:      agent.deep_diagnostic   || null,
    _workflow_path:         agent.workflow_path      || [],
    _gap_analysis:          agent.gap_analysis       || null,
  };
}

async function conversationCoach(data) {
  const result = await callBackend('/conversation-coach', data);
  return result.data;
}

async function jobFitAnalysis(data) {
  const result = await callBackend('/api/job-fit-analysis', data);
  return result.data;
}

async function interviewPrep(data) {
  const result = await callBackend('/api/interview-prep', data);
  return result.data;
}

// ?? Networking handlers ??

async function networkingOnboarding(data) {
  const result = await callBackend('/networking/onboarding', data);
  return result.data;
}

async function networkingGetProfile() {
  const result = await getBackend('/networking/profile');
  return result.data;
}

async function networkingScore(data) {
  // Cache profiles first (fire-and-forget)
  callBackend('/networking/cache-profiles', { profiles: data.candidates }).catch(() => {});
  // Score
  return await callBackend('/networking/score', data);
}

async function networkingMessage(data) {
  const result = await callBackend('/networking/message', data);
  return result.data;
}

async function networkingInteraction(data) {
  const result = await callBackend('/networking/interaction', data);
  return result.data;
}

async function networkingMessageOutcome(data) {
  await callBackend('/networking/message-outcome', data);
  return true;
}

async function networkingOutcome(data) {
  const result = await callBackend('/networking/outcome', data);
  return result.data;
}

async function scheduleOutcomeCheck({ msg_id, delay_hours = 48 }) {
  // Chrome alarms fire after delay_hours hours; name encodes msg_id
  const alarmName = `outcome_check_${msg_id}`;
  chrome.alarms.create(alarmName, { delayInMinutes: delay_hours * 60 });
  return true;
}

// ?? Alarm listener ??????????????????????????????????????????????????????????
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // 48h outcome checks
  if (alarm.name.startsWith('outcome_check_')) {
    const msgId = alarm.name.replace('outcome_check_', '');
    try {
      await callBackend('/networking/message-outcome', { msg_id: msgId, was_accepted: null });
    } catch { /* Non-fatal */ }
    return;
  }

  // Daily inactivity check — remind users who haven't opened the extension in 3+ days
  if (alarm.name === 'inactivity_check') {
    await _checkInactivityReminder();
  }
});

const _INACTIVITY_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

async function _checkInactivityReminder() {
  try {
    // Only remind if user is logged in
    const { authToken } = await chrome.storage.sync.get('authToken');
    if (!authToken) return;

    // Only remind if the user opted in (default: enabled)
    const { notifEvents, notifPush } = await chrome.storage.sync.get(['notifEvents', 'notifPush']);
    const events = notifEvents || ['profile_extracted', 'ai_score', 'networking_analysis', 'gap_analysis', 'inactivity_reminder'];
    if (!events.includes('inactivity_reminder')) return;

    const { lastActiveTs } = await chrome.storage.local.get('lastActiveTs');
    if (!lastActiveTs) return; // never tracked — don't nag on first install

    const inactiveDays = Math.floor((Date.now() - lastActiveTs) / (24 * 60 * 60 * 1000));
    if (inactiveDays < 3) return;

    // Only remind once — don't fire again until they open the popup (which resets lastActiveTs)
    const { inactivityReminderSent } = await chrome.storage.local.get('inactivityReminderSent');
    if (inactivityReminderSent) return;

    chrome.notifications.create('inactivity_reminder', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Your LinkedIn could use some love 👋',
      message: `You haven't used Subul IN in ${inactiveDays} day${inactiveDays !== 1 ? 's' : ''}. Your network and profile are waiting — open the extension to pick up where you left off.`,
      priority: 1,
    });

    await chrome.storage.local.set({ inactivityReminderSent: true });
  } catch { /* non-fatal */ }
}

// ?? Notification System ??????????????????????????????????????????????????????

// Send a browser push notification based on user preferences
async function sendNotification({ event, title, body, data }) {
  const prefs = await chrome.storage.sync.get(['notifPush', 'notifEvents']);
  const enabledEvents = prefs.notifEvents || ['gap_analysis', 'ai_score', 'networking_analysis', 'profile_extracted'];
  if (!enabledEvents.includes(event)) return { skipped: true };
  return { sent: true };
}

// Called by popup on every open — resets the inactivity timer
async function markUserActive() {
  await chrome.storage.local.set({
    lastActiveTs: Date.now(),
    inactivityReminderSent: false, // allow next reminder after 3 more inactive days
  });
  return { ok: true };
}

// Save notification preferences to chrome.storage.sync AND backend
async function updateNotifPrefs({ email, emailEnabled, pushEnabled, events }) {
  await chrome.storage.sync.set({
    notifEmail: emailEnabled,
    notifPush:  pushEnabled,
    notifEvents: events || [],
  });
  // Persist to backend so notification endpoints can check prefs server-side
  try {
    await callBackend('/notifications/prefs', { email_enabled: emailEnabled, events: events || [] });
  } catch (_) { /* best-effort */ }
  return { ok: true };
}

// On startup: re-probe stale local URL + set up inactivity reminder alarm
chrome.runtime.onStartup.addListener(async () => {
  const { serverUrl } = await chrome.storage.sync.get('serverUrl');
  if (serverUrl && serverUrl.startsWith('http://127.0.0.1:')) {
    try {
      const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error('not ok');
    } catch {
      await chrome.storage.sync.remove('serverUrl');
    }
  }
  _ensureInactivityAlarm();
});

// Also register on install (first run)
chrome.runtime.onInstalled.addListener(async (details) => {
  _ensureInactivityAlarm();

  // On fresh install, push default notification prefs to backend so Cosmos
  // is initialised without requiring the user to open the settings panel.
  // Without this, notifications never fire until the user manually toggles.
  if (details.reason === 'install') {
    const { notifEmail } = await chrome.storage.sync.get('notifEmail');
    if (notifEmail === undefined) {
      const defaultEvents = ['profile_extracted', 'ai_score', 'networking_analysis', 'gap_analysis'];
      await chrome.storage.sync.set({ notifEmail: true, notifEvents: defaultEvents });
      // Best-effort — backend may not be reachable yet, that's fine;
      // the popup settings panel will retry when the user first opens it.
      try {
        await updateNotifPrefs({ emailEnabled: true, pushEnabled: false, events: defaultEvents });
      } catch (_) {}
    }
  }
});

function _ensureInactivityAlarm() {
  chrome.alarms.get('inactivity_check', existing => {
    if (!existing) {
      // Fire once per day to check if the user has been inactive
      chrome.alarms.create('inactivity_check', { periodInMinutes: 24 * 60 });
    }
  });
}

// ?? Subul Learning Data Sync ????????????????????????????????????????????????

// ?? Subul page scraper ???????????????????????????????????????????????????????
// Self-contained function injected via executeScript into the Subul cert page.
// Only collects EARNED/COMPLETED certifications -- skips Available & In Progress.
function _subulCertScrapeFunction() {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const certifications = [], labs = [], learning_paths = [], badges = [];
  const seen = new Set();

  // Is this card marked as earned/completed (has an issued date or Completed label)?
  function isEarned(el) {
    const txt = norm(el.textContent);
    const hasCompletion = /issued|completed|obtenu|earned|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|avr|aout|fev|juil).{0,20}\d{4}|\d{4}/i.test(txt);
    const onlyAvailable = /available|disponible/i.test(txt) && !/issued|completed|earned/i.test(txt);
    const onlyProgress  = /in progress|en cours|currently preparing/i.test(txt) && !/issued|completed|earned/i.test(txt);
    return hasCompletion && !onlyAvailable && !onlyProgress;
  }

  // Find the "Earned" tab panel -- click earned tab first, then grab its panel
  function getEarnedRoot() {
    // Try to click the Earned/Completed tab button
    for (const btn of document.querySelectorAll('[role="tab"], button')) {
      if (/earned|completed|obtenu/i.test(norm(btn.textContent))) {
        btn.click();
        break;
      }
    }
    // Find active tabpanel or fall back to body
    for (const el of document.querySelectorAll('[role="tabpanel"][aria-hidden="false"], [role="tabpanel"].active, [role="tabpanel"]')) {
      if (el.textContent.includes('Issued') || /earned|completed/i.test(el.textContent)) return el;
    }
    return document.body;
  }

  const root = getEarnedRoot();

  const cardSelectors = ['article', '[class*="cert-card"]', '[class*="CertCard"]',
    '[class*="certificate"]', '[class*="achievement"]', '.card', '[class*="Card"]', 'li'];

  for (const sel of cardSelectors) {
    for (const el of root.querySelectorAll(sel)) {
      const txt = norm(el.textContent);
      if (txt.length < 8 || txt.length > 2000) continue;
      if (!isEarned(el)) continue;

      // Extract name from heading or first meaningful child
      let name = norm(el.querySelector('h1,h2,h3,h4,h5,strong,[class*="title"],[class*="Title"],[class*="name"],[class*="Name"]')?.textContent || '');
      if (!name || name.length < 3) {
        for (const c of el.querySelectorAll('span,p')) {
          const t = norm(c.textContent);
          if (t.length >= 5 && t.length < 120) { name = t; break; }
        }
      }
      if (!name || name.length < 3) continue;
      if (seen.has(name)) continue;
      if (/^(view|download|share|edit|delete|more|see all|show|close|cancel|submit|save|next|back|filter|sort|search|verify|details|earned|available|in progress|completed|download certificate)$/i.test(name)) continue;

      seen.add(name);

      const allTxt = [...el.querySelectorAll('span,p,div')]
        .map(e => norm(e.textContent)).filter(t => t && t !== name && t.length < 120);

      let issuer = '';
      for (const t of allTxt) {
        if (/amazon|aws|microsoft|google|ibm|oracle|cisco|meta|coursera|udemy|edx|linkedin|subul/i.test(t) && t.length < 80) { issuer = t; break; }
      }

      let issued_at = '';
      const dateRe = /\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|avr|aout|fev|juil)[a-z.]*\s+\d{4}|\d{4}[-/]\d{2}[-/]\d{2}/i;
      for (const t of allTxt) {
        if (dateRe.test(t) && t.length < 50) { issued_at = t; break; }
      }

      let credential_id = '';
      for (const t of allTxt) {
        const c = t.replace(/credential\s*id\s*[:\-]?\s*/i, '').trim();
        if (/^[A-Z0-9]{6,20}$/.test(c)) { credential_id = c; break; }
      }

      const url = location.href;
      if (/\/labs?|hands.on/i.test(url)) {
        labs.push({ name, issuer: issuer || 'Subul', completed_at: issued_at, skills: [] });
      } else if (/\/path|learning.path/i.test(url)) {
        learning_paths.push({ name, status: 'completed', progress: '100' });
      } else {
        certifications.push({ name, issuer: issuer || 'Subul', issued_at, credential_id });
      }
      if (certifications.length + labs.length >= 60) break;
    }
    if (certifications.length + labs.length >= 60) break;
  }

  // Badges
  for (const el of document.querySelectorAll('[class*="badge"],[class*="Badge"]')) {
    const n = norm(el.querySelector('img')?.alt || el.querySelector('[class*="name"],[class*="title"]')?.textContent || '');
    if (n && n.length > 3 && !seen.has('b:' + n)) { seen.add('b:' + n); badges.push({ name: n }); if (badges.length >= 20) break; }
  }

  return { certifications, labs, learning_paths, badges, scraped_url: location.href };
}

async function _scrapeSubulDashboard(authToken, now) {
  const SUBUL_CERT_URL = 'https://subul.uk/en/dashboard/learner/certifications';
  let tab;
  try {
    tab = await chrome.tabs.create({ url: SUBUL_CERT_URL, active: false });
    await waitForTabLoad(tab.id, 14000);
    // Brief pause for Next.js SPA hydration (reduced from 3500ms)
    await new Promise(r => setTimeout(r, 1200));

    // Click the Earned tab explicitly before scraping
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        for (const btn of document.querySelectorAll('[role="tab"], button')) {
          if (/earned|completed|obtenu/i.test((btn.textContent || '').trim())) {
            btn.click(); break;
          }
        }
      },
    });
    await new Promise(r => setTimeout(r, 600));

    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: _subulCertScrapeFunction,
    });

    const scraped = res?.[0]?.result;
    if (!scraped) return;

    const { certifications, labs, learning_paths, badges } = scraped;
    if (certifications.length + labs.length + learning_paths.length + badges.length === 0) return;

    // After scraping fresh items, restore earned toggles from Cosmos DB.
    // Cosmos is the only reliable source — local storage may be stale or cleared.
    // Rule: if Cosmos has user_earned=true for a title → mark it on. That's it.
    let cosmosEarnedCerts = new Set();
    let cosmosEarnedLabs  = new Set();
    try {
      const base = await getApiBase();
      const r2   = await fetch(`${base}/subul/data`, {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      if (r2.ok) {
        const j = await r2.json();
        for (const item of (j?.data?.certifications || [])) {
          if (item.user_earned) cosmosEarnedCerts.add((item.name || item.title || '').trim().toLowerCase());
        }
        for (const item of (j?.data?.labs || [])) {
          if (item.user_earned) cosmosEarnedLabs.add((item.name || item.title || '').trim().toLowerCase());
        }
      }
    } catch (_) { /* best-effort */ }

    // Apply Cosmos earned state to freshly scraped items
    const applyEarned = (items, earnedSet) => items.map(item => {
      const k = (item.name || item.title || '').trim().toLowerCase();
      return earnedSet.has(k) ? { ...item, user_earned: true } : item;
    });

    const mergedCerts = applyEarned(certifications, cosmosEarnedCerts);
    const mergedLabs  = applyEarned(labs,           cosmosEarnedLabs);

    const subulData = {
      certifications: mergedCerts,
      labs:           mergedLabs,
      learning_paths,
      badges,
      synced_at: new Date().toISOString(),
      source: 'browser_scrape',
    };

    // Step 1: Save locally with current (pre-merge) state for instant popup display
    await chrome.storage.local.set({
      subulLastSync: now,
      subulData,
      subulSyncResult: {
        certifications: certifications.length,
        labs: labs.length,
        learning_paths: learning_paths.length,
        badges: badges.length,
      },
    });

    // Step 2: Persist to backend — backend merges user_earned flags from Cosmos
    try {
      const base = await getApiBase();
      const saveRes = await fetch(`${base}/subul/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify(subulData),
      });

      // Step 3: Reload the merged data back from backend so local storage reflects
      //         the correct user_earned flags (backend merged Cosmos state into it)
      if (saveRes.ok) {
        const dataRes = await fetch(`${base}/subul/data`, {
          headers: { 'Authorization': `Bearer ${authToken}` },
        });
        if (dataRes.ok) {
          const dataJson = await dataRes.json();
          if (dataJson?.data) {
            await chrome.storage.local.set({ subulData: dataJson.data });
          }
        }
      }
    } catch (_) { /* best-effort */ }

  } catch (_) { /* scrape failed silently */ }
  finally {
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Refresh Subul earned state from Cosmos on login — always runs, no debounce.
// This is fast (no tab scraping) — just a GET to /subul/data.
async function _refreshSubulDataFromBackend() {
  try {
    const { authToken } = await chrome.storage.sync.get(['authToken']);
    if (!authToken) return;
    const base = await getApiBase();
    const res = await fetch(`${base}/subul/data`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (!res.ok) return;
    const json = await res.json();
    if (json?.data && (
      (json.data.certifications || []).length > 0 ||
      (json.data.labs || []).length > 0
    )) {
      await chrome.storage.local.set({ subulData: json.data });
    }
  } catch (_) { /* best-effort */ }
}


async function _triggerSubulSync() {
  const { authToken } = await chrome.storage.sync.get(['authToken']);
  if (!authToken) return;

  const { subulLastSync } = await chrome.storage.local.get(['subulLastSync']);
  const now = Date.now();
  if (subulLastSync && now - subulLastSync < 23 * 60 * 60 * 1000) return;

  // Stage 1: try the backend API (works if Subul token was saved at login)
  try {
    const base = await getApiBase();
    const res = await fetch(`${base}/subul/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        const synced = data.synced || {};
        const total  = (synced.certifications || 0) + (synced.labs || 0) + (synced.learning_paths || 0);
        if (total > 0) {
          // Fetch the full data back from Cosmos so local storage has the correct
          // earned state (user_earned flags are preserved in cosmos_db.save_subul_data)
          try {
            const dataRes = await fetch(`${base}/subul/data`, {
              headers: { 'Authorization': `Bearer ${authToken}` },
            });
            if (dataRes.ok) {
              const dataJson = await dataRes.json();
              if (dataJson?.data) {
                await chrome.storage.local.set({ subulData: dataJson.data });
              }
            }
          } catch (_) { /* best-effort */ }
          await chrome.storage.local.set({ subulLastSync: now, subulSyncResult: synced });
          return; // API worked -- done
        }
      }
    }
  } catch (_) { /* fall through to browser scrape */ }

  // Stage 2: API returned nothing -- scrape the dashboard page directly
  await _scrapeSubulDashboard(authToken, now);
}

async function subulSync() {
  // Called from popup when user clicks Refresh -- bypass 23h throttle
  await chrome.storage.local.remove(['subulLastSync']);
  await _triggerSubulSync();
  return { ok: true };
}

async function getSubulData() {
  // Return local storage first — it's always up to date because
  // _triggerSubulSync and _scrapeSubulDashboard both write merged data here.
  const { subulData } = await chrome.storage.local.get(['subulData']);
  if (subulData && (
    (subulData.certifications || []).length > 0 ||
    (subulData.labs || []).length > 0 ||
    (subulData.learning_paths || []).length > 0
  )) return subulData;

  // No local data yet — fall back to Cosmos (e.g. fresh install after previous session)
  try {
    const base = await getApiBase();
    const { authToken } = await chrome.storage.sync.get(['authToken']);
    if (!authToken) return null;
    const res = await fetch(`${base}/subul/data`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.data) {
      // Cache it locally so next open is instant
      await chrome.storage.local.set({ subulData: json.data });
    }
    return json?.data ?? null;
  } catch (_) { return null; }
}

async function markSubulEarned({ type, item_name, earned }) {
  // 1. Update local storage immediately so the popup reflects the change
  //    even if the backend call fails temporarily
  const { subulData } = await chrome.storage.local.get(['subulData']);
  if (subulData) {
    const key   = type === 'certification' ? 'certifications' : 'labs';
    const items = subulData[key] || [];
    let found = false;
    for (const item of items) {
      const name = item.name || item.title || '';
      if (name === item_name) {
        item.user_earned = earned;
        if (earned && !item.earned_at) item.earned_at = new Date().toISOString();
        found = true;
        break;
      }
    }
    if (found) {
      subulData[key] = items;
      await chrome.storage.local.set({ subulData });
    }
  }

  // 2. Persist to backend
  const base = await getApiBase();
  const { authToken } = await chrome.storage.sync.get(['authToken']);
  if (!authToken) throw new Error('Not authenticated');

  const res = await fetch(`${base}/subul/mark-earned`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({ type, item_name, earned }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Server error ${res.status}`);
  }

  return await res.json();
}

// ?? Scrape Quality Telemetry ?????????????????????????????????????????????????

// POSTs scrape quality metrics to the backend for production monitoring.

// Best-effort: never throws, never blocks the scrape flow.

async function logScrapeQuality(data) {

try {

const base = await getApiBase();

const { authToken } = await chrome.storage.sync.get(['authToken']);

await fetch(`${base}/scrape-quality`, {

      method: 'POST',

      headers: {

'Content-Type': 'application/json',

...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),

},

      body: JSON.stringify(data),

      signal: AbortSignal.timeout(5000),

});

} catch { /* best-effort -- never crash the scrape flow */ }

return null;

}
