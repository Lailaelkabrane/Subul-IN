// Main popup script - handles all UI interactions and feature calls

let profile = null;
let _currentPage = 'home';
let _pageStack = ['home']; // navigation history for proper back navigation
let _isEnriching = false;  // true while background enrichment is running — suppresses status overwrite
let _consentReady = false;

// Increment this when the privacy policy or terms change so users must re-accept
const CURRENT_PRIVACY_VERSION = '3.2.0';
const CONSENT_KEY = 'subulConsent';

function initConsentOverlay(onAccepted) {
  const overlay = document.getElementById('subul-consent-overlay');
  if (!overlay) {
    if (typeof onAccepted === 'function') onAccepted();
    return;
  }

  const card = document.getElementById('consentCard');
  const requiredPanel = document.getElementById('consentRequiredPanel');
  const acceptBtn = document.getElementById('consentAcceptBtn');
  const declineBtn = document.getElementById('consentDeclineBtn');
  const retryBtn = document.getElementById('consentRetryBtn');
  const policyCheck = document.getElementById('consentPolicyCheck');
  const processingCheck = document.getElementById('consentProcessingCheck');

  const showMain = () => {
    if (card) card.style.display = 'flex';
    if (requiredPanel) requiredPanel.style.display = 'none';
  };

  const showRequired = () => {
    if (card) card.style.display = 'none';
    if (requiredPanel) requiredPanel.style.display = 'flex';
  };

  const updateAcceptState = () => {
    if (!acceptBtn) return;
    acceptBtn.disabled = !(policyCheck?.checked && processingCheck?.checked);
  };

  const finish = () => {
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    if (_consentReady) return;
    _consentReady = true;
    if (typeof onAccepted === 'function') onAccepted();
  };

  // Consent is only valid if it matches the current policy version
  const isConsentCurrent = (rec) =>
    !!rec && rec.privacyAccepted === true && rec.termsAccepted === true &&
    rec.privacyVersion === CURRENT_PRIVACY_VERSION;

  chrome.storage.local.get([CONSENT_KEY], (res) => {
    if (isConsentCurrent(res[CONSENT_KEY])) {
      finish();
      return;
    }
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    showMain();
    updateAcceptState();
  });

  policyCheck?.addEventListener('change', updateAcceptState);
  processingCheck?.addEventListener('change', updateAcceptState);
  acceptBtn?.addEventListener('click', async () => {
    const now = Date.now();
    await chrome.storage.local.set({
      [CONSENT_KEY]: {
        privacyAccepted: true,
        privacyAcceptedAt: now,
        privacyVersion: CURRENT_PRIVACY_VERSION,
        termsAccepted: true,
        termsAcceptedAt: now,
      },
      // Keep the legacy consent flag in sync
      subulConsentAccepted: true,
    });
    finish();
  });
  declineBtn?.addEventListener('click', showRequired);
  retryBtn?.addEventListener('click', () => {
    showMain();
    updateAcceptState();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // Record that the user opened the popup to reset the inactivity reminder
  chrome.runtime.sendMessage({ action: 'markUserActive' }).catch(() => {});

  initConsentOverlay(() => {
    initAuth(() => {
      initDarkMode();
      initI18n();
      initNavigation();
      initCustomSelects();
      initTabs();
      initProfileCard();
      initPostTab();
      initProfileTab();
      initSettings();
      initChat();
      initNetworkingTab();
      initGapTab();
      initSubulPage();
      startOnboardingTour();
      checkConnection();
      scrapeProfile();
    });
  });
});


// Page navigation

// Track pending animation cleanup so we can cancel it on fast navigation
const _pendingCleanup = new Map(); // pageId -> cleanup fn

function navigateTo(pageId, _isBack = false) {
  if (pageId === _currentPage) return;
  const current = document.getElementById('page-' + _currentPage);
  const target  = document.getElementById('page-' + pageId);
  if (!current || !target) return;

  const currentId = _currentPage;

  // Cancel any pending cleanup on the target page to prevent animation glitches
  if (_pendingCleanup.has(pageId)) {
    const fn = _pendingCleanup.get(pageId);
    target.removeEventListener('transitionend', fn);
    _pendingCleanup.delete(pageId);
    target.classList.remove('exit-left'); // ensure clean state
  }

  // Decide whether to slide left (forward) or right (back)
  const previousPage = _pageStack.length > 1 ? _pageStack[_pageStack.length - 2] : null;
  const goingBack = _isBack || pageId === previousPage;

  if (goingBack) {
    // Slide the current page to the right when going back
    current.classList.remove('active');
    // Bring the target page back from the left
    target.classList.remove('exit-left');
    target.classList.add('active');
    // Update the stack when going back directly without using goBack()
    if (!_isBack && _pageStack.length > 1 && _pageStack[_pageStack.length - 1] === currentId) {
      _pageStack.pop();
    }
    if (pageId === 'home') _refreshHomeHero();
  } else {
    // Slide the current page out to the left when going forward
    current.classList.remove('active');
    current.classList.add('exit-left');

    // Clean up exit-left class after the transition finishes
    const cleanup = () => {
      current.classList.remove('exit-left');
      _pendingCleanup.delete(currentId);
    };
    // Use transitionend and a fallback timeout in case the event does not fire
    const timeoutId = setTimeout(cleanup, 350);
    const transitionCleanup = () => {
      clearTimeout(timeoutId);
      cleanup();
      current.removeEventListener('transitionend', transitionCleanup);
    };
    current.addEventListener('transitionend', transitionCleanup, { once: true });
    _pendingCleanup.set(currentId, transitionCleanup);

    // Slide the target page in using requestAnimationFrame to avoid a flash
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        target.classList.add('active');
      });
    });

    if (pageId === 'gap' && typeof onGapTabOpen === 'function') onGapTabOpen();
    if (pageId === 'networking' && typeof onNetworkingTabOpen === 'function') onNetworkingTabOpen();
    // Track forward navigation in the stack
    if (_pageStack[_pageStack.length - 1] !== pageId) _pageStack.push(pageId);
  }

  _currentPage = pageId;

  const body = target.querySelector('.page-body, .chat-page-body');
  if (body) body.scrollTop = 0;
}

function goBack() {
  // Remove the current page from the stack
  if (_pageStack.length > 1) _pageStack.pop();
  const prev = _pageStack[_pageStack.length - 1] || 'home';
  navigateTo(prev, true);
  if (prev === 'home') _refreshHomeHero();
}

async function _refreshHomeHero() {
  const { myProfile: saved } = await chrome.storage.local.get('myProfile');
  if (saved && (saved.name || saved.headline)) {
    profile = saved;
    updateHomeProfile(saved);
    // Reset the profile card to data view when going back home
    showState('data');
  }
}

function initNavigation() {
  // Handle feature card clicks on the home page
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const target = el.dataset.nav;
      // Back buttons use goBack() for proper history tracking
      if (el.classList.contains('btn-back')) {
        goBack();
      } else {
        navigateTo(target);
      }
    });
  });

  // Sub-tab navigation on the Profile page (supports arrow key navigation)
  const subTabs = [...document.querySelectorAll('.sub-tab')];
  subTabs.forEach((tab, i) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('tabindex', tab.classList.contains('active') ? '0' : '-1');
    const activate = () => {
      subTabs.forEach(t => { t.classList.remove('active'); t.setAttribute('tabindex', '-1'); });
      document.querySelectorAll('.sub-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('tabindex', '0');
      tab.focus();
      const target = document.getElementById('subtab-' + tab.dataset.subtab);
      if (target) target.classList.add('active');
    };
    tab.addEventListener('click', activate);
    tab.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = e.key === 'ArrowRight' ? (i + 1) % subTabs.length : (i - 1 + subTabs.length) % subTabs.length;
        subTabs[next].click();
      }
    });
  });

  // Navigate to the edit page when the home edit button is clicked
  const homeEditBtn = document.getElementById('homeEditBtn');
  if (homeEditBtn) {
    homeEditBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await openEditMode();
      } catch (err) {
        console.warn('[LinkedIn AI] openEditMode failed from home button:', err);
      }
      navigateTo('edit');
    });
  }

  // Handle profile photo upload
  const avatarChangeBtn = document.getElementById('homeAvatarChangeBtn');
  const avatarFileInput = document.getElementById('homeAvatarFileInput');
  if (avatarChangeBtn && avatarFileInput) {
    avatarChangeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      avatarFileInput.click();
    });
    avatarFileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // Read the file and save it as a data URL
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result;
        if (profile) {
          profile.profilePhotoUrl = dataUrl;
        } else {
          profile = { profilePhotoUrl: dataUrl };
        }
        await chrome.storage.local.set({ myProfile: profile });
        updateHomeProfile(profile);
        // Update the profile card avatar if it is currently showing
        const pcAvatar = document.getElementById('pcAvatar');
        if (pcAvatar) {
          pcAvatar.textContent = '';
          pcAvatar.style.backgroundImage = `url('${dataUrl}')`;

          pcAvatar.style.backgroundSize = 'cover';
          pcAvatar.style.backgroundPosition = 'center';
        }
        toast('Photo updated!', 'success');
      };
      reader.readAsDataURL(file);
      // Clear the input so the same file can be selected again
      avatarFileInput.value = '';
    });
  }

  // Navigate to edit page from the settings screen
  const settingsEditBtn = document.getElementById('settingsEditProfile');
  if (settingsEditBtn) {
    settingsEditBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await openEditMode();
      } catch (err) {
        console.warn('[LinkedIn AI] openEditMode failed from settings button:', err);
      }
      navigateTo('edit');
    });
  }
}

// Custom dropdown builder to match the popup design
function initCustomSelects() {
  const selects = Array.from(document.querySelectorAll('.form-group select, #netSeniority'));
  if (!selects.length) return;

  const syncOpenState = () => {
    const anyOpen = !!document.querySelector('.custom-select.open');
    document.body.classList.toggle('custom-select-open', anyOpen);
  };

  const closeAll = () => {
    document.querySelectorAll('.custom-select.open').forEach(el => el.classList.remove('open'));
    syncOpenState();
  };

  for (const select of selects) {
    if (select.dataset.customized === '1') continue;
    select.dataset.customized = '1';
    select.classList.add('native-select-hidden');

    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'custom-select-label';
    triggerLabel.textContent = select.options[select.selectedIndex]?.text || 'Select';
    trigger.appendChild(triggerLabel);

    const menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    menu.setAttribute('role', 'listbox');

    const options = Array.from(select.options);
    for (const opt of options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'custom-select-option';
      item.setAttribute('role', 'option');
      item.dataset.value = opt.value;
      item.textContent = opt.text;
      if (opt.value === select.value) item.classList.add('selected');

      item.addEventListener('click', () => {
        const oldValue = select.value;
        select.value = opt.value;
        triggerLabel.textContent = opt.text;
        menu.querySelectorAll('.custom-select-option').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        wrapper.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        if (oldValue !== select.value) {
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      menu.appendChild(item);
    }

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isOpen = wrapper.classList.contains('open');
      closeAll();
      wrapper.classList.toggle('open', !isOpen);
      trigger.setAttribute('aria-expanded', String(!isOpen));
      syncOpenState();
    });

    // Keep the custom dropdown in sync when the value changes programmatically
    select.addEventListener('change', () => {
      const selectedText = select.options[select.selectedIndex]?.text || 'Select';
      triggerLabel.textContent = selectedText;
      menu.querySelectorAll('.custom-select-option').forEach(el => {
        el.classList.toggle('selected', el.dataset.value === select.value);
      });
    });

    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);
    select.insertAdjacentElement('afterend', wrapper);
  }

  document.addEventListener('click', closeAll);
  // Close dropdowns when the user scrolls so they don't float out of position
  document.querySelectorAll('.page-body').forEach(pb => {
    pb.addEventListener('scroll', closeAll, { passive: true });
  });
}

// Check if a URL can be used as an image src
function _isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^(https?:\/\/|data:image\/)/.test(url.trim());
}

// Calculate how complete the user's profile is (0 to 100)
function computeCompletenessScore(p) {
  if (!p) return { score: 0, breakdown: [] };
  const aboutLen    = (p.about || '').length;
  const skillCount  = Array.isArray(p.skills)         ? p.skills.length         : 0;
  const expCount    = Array.isArray(p.experience)      ? p.experience.length      : 0;
  const eduCount    = Array.isArray(p.education)       ? p.education.length       : 0;
  const certCount   = Array.isArray(p.certifications)  ? p.certifications.length  : 0;
  const items = [
    {
      label: 'Name', points: 5,
      earned: !!(p.name && p.name.trim()),
      hint: null,
    },
    {
      label: 'Headline', points: 10,
      earned: !!(p.headline || p.currentRole),
      hint: null,
    },
    {
      label: aboutLen >= 200 ? 'About (200+ chars)' : `About (${aboutLen}/200 chars)`,
      points: 15,
      earned: aboutLen >= 200,
      hint: null,
    },
    {
      label: expCount > 0 ? `Experience (${expCount})` : 'Experience',
      points: 20,
      earned: expCount > 0,
      hint: null,
    },
    {
      label: skillCount >= 10 ? `Skills (${skillCount})` : `Skills (${skillCount}/10)`,
      points: 20,
      earned: skillCount >= 10,
      hint: null,
    },
    {
      label: eduCount > 0 ? `Education (${eduCount})` : 'Education',
      points: 10,
      earned: eduCount > 0,
      hint: null,
    },
    {
      label: certCount > 0 ? `Certifications (${certCount})` : 'Certifications',
      points: 5,
      earned: certCount > 0,
      hint: null,
    },
    {
      label: 'Profile photo', points: 15,
      earned: _isValidImageUrl(p.profilePhotoUrl),
      hint: null,
    },
  ];
  const score = items.reduce((sum, i) => sum + (i.earned ? i.points : 0), 0);
  return { score, breakdown: items };
}

function _renderCompletenessScore(p) {
  const wrap = document.getElementById('homeCompleteness');
  const ringFill = document.getElementById('homeRingFill');
  const scoreEl = document.getElementById('homeCompletenessScore');
  const bdEl = document.getElementById('homeCompletenessBreakdown');
  if (!wrap || !ringFill || !scoreEl || !bdEl) return;

  const { score, breakdown } = computeCompletenessScore(p);
  const circumference = 100; // using stroke-dasharray out of 100
  const dash = score; // score IS percentage 0-100

  wrap.style.display = 'flex';
  scoreEl.textContent = score + '%';
  ringFill.setAttribute('stroke-dasharray', `${dash} ${circumference - dash}`);

  // Set the ring color based on the score
  if (score >= 80) ringFill.style.stroke = '#22c55e';
  else if (score >= 50) ringFill.style.stroke = 'var(--ac, #0077b5)';
  else ringFill.style.stroke = '#f59e0b';

  // Build the score breakdown panel
  bdEl.innerHTML = breakdown.map(i => {
    const icon = i.earned ? '✓' : '○';
    const cls  = i.earned ? 'cb-check' : 'cb-miss';
    const pts  = i.earned ? i.points : 0;
    const hint = (!i.earned && i.hint)
      ? `<span class="cb-hint">${i.hint}</span>`
      : '';
    return `<div class="cb-row"><span><span class="${cls}">${icon}</span>${i.label}${hint}</span><span>${pts}/${i.points}</span></div>`;
  }).join('');

  // Show or hide the breakdown when clicked
  if (!wrap._completenessListenerAdded) {
    wrap._completenessListenerAdded = true;
    wrap.addEventListener('click', () => {
      bdEl.style.display = bdEl.style.display === 'none' ? 'block' : 'none';
    });
  }
}

// Update the home page profile section with the latest scraped data
function updateHomeProfile(p) {
  if (!p) return;
  const nameEl = document.getElementById('homeName');
  const headlineEl = document.getElementById('homeHeadline');
  const avatarEl = document.getElementById('homeAvatar');
  if (nameEl) nameEl.textContent = p.name || 'Your Profile';
  if (headlineEl) headlineEl.textContent = p.headline || p.currentRole || '—';
  if (avatarEl) {
    const _noPhotoSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" style="width:100%;height:100%;border-radius:50%;display:block;"><rect width="72" height="72" fill="#c0c0c0" rx="36"/><circle cx="36" cy="28" r="13" fill="#fff"/><ellipse cx="36" cy="62" rx="22" ry="16" fill="#fff"/></svg>`;
    if (_isValidImageUrl(p.profilePhotoUrl)) {
      avatarEl.innerHTML = `<img src="${p.profilePhotoUrl}" alt="${p.name || ''}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;" />`;
      const _img = avatarEl.querySelector('img');
      if (_img) _img.onerror = () => { avatarEl.innerHTML = _noPhotoSVG; };
    } else {
      // Show a placeholder avatar when no photo is available
      avatarEl.innerHTML = _noPhotoSVG;
    }
  }
  // Update the completeness ring
  _renderCompletenessScore(p);
  // Update the extraction status text
  updateExtractionStatus(p);
  // Update the settings profile card with the latest data
  syncSettingsProfileInfo(p);
}

function syncSettingsProfileInfo(p) {
  const nameEl = document.getElementById('settingsProfileName');
  const headlineEl = document.getElementById('settingsProfileHeadline');
  const metaEl = document.getElementById('settingsProfileMeta');
  if (!nameEl || !headlineEl || !metaEl) return;

  if (!p || (!p.name && !p.headline && !p.currentRole)) {
    nameEl.textContent = 'No profile saved yet';
    headlineEl.textContent = 'Scrape your LinkedIn profile or add it manually from Edit Profile.';
    metaEl.textContent = 'No local profile data found';
    return;
  }

  nameEl.textContent = p.name || 'LinkedIn profile';
  headlineEl.textContent = p.headline || p.currentRole || 'No headline available';

  const skillsCount = Array.isArray(p.skills) ? p.skills.length : 0;
  const expCount = Array.isArray(p.experience) ? p.experience.length : 0;
  const sourceLabel = p._source === 'manual' ? 'Manual' : 'Scraped';
  metaEl.textContent = `${sourceLabel} profile, ${skillsCount} skills, ${expCount} experiences`;
}

function updateExtractionStatus(p) {
  if (_isEnriching) return; // don't overwrite "Extracting..." during background enrichment
  const statusEl = document.getElementById('homeExtractStatus');
  const dotEl = document.getElementById('homeExtractDot');
  const textEl = document.getElementById('homeExtractText');
  if (!statusEl) return;
  if (!p || (!p.name && !p.headline)) { statusEl.style.display = 'none'; return; }
  statusEl.style.display = 'flex';
  statusEl.className = 'home-extract-status';
  dotEl.className = 'home-extract-dot';
  if (p._source === 'manual') {
    textEl.textContent = 'Manual entry';
    statusEl.title = 'Profile data entered manually';
  } else if (p.scrapedAt) {
    const ago = _timeAgo(p.scrapedAt);
    textEl.textContent = ago ? `Extracted ${ago}` : 'Extracted';
    const ms = Date.now() - new Date(p.scrapedAt).getTime();
    if (ms > 86400000) {
      dotEl.classList.add('stale');
      statusEl.title = 'Profile data is over 24h old — consider re-extracting';
    } else {
      statusEl.title = `Last extracted: ${new Date(p.scrapedAt).toLocaleString()}`;
    }
  } else {
    textEl.textContent = window._t('statusProfileLoaded');
    statusEl.title = '';
  }
}

function _showNoProfileGuidance(msg) {
  showState('edit');
  const src = document.getElementById('pcSource');
  if (src) {
    if (msg) {
      src.innerHTML = `<span style="color:var(--er)">${msg}</span>`;
    } else {
      src.innerHTML =
        '<strong>Profile not extracted yet.</strong><br>' +
        'Open <a href="https://www.linkedin.com/in/me" target="_blank" style="color:var(--ac)">your LinkedIn profile</a> ' +
        'in this tab, then click the <strong>↺ re-extract</strong> button. Or fill in your details manually below.';
    }
  }
  const nameEl = document.getElementById('homeName');
  const headlineEl = document.getElementById('homeHeadline');
  const avatarEl = document.getElementById('homeAvatar');
  if (nameEl) nameEl.textContent = 'No Profile Yet';
  if (headlineEl) {
    headlineEl.innerHTML =
      '<a href="https://www.linkedin.com/in/me" target="_blank" style="color:var(--ac);text-decoration:underline;">' +
      'Open your LinkedIn profile →</a>';
  }
  if (avatarEl) avatarEl.textContent = '?';
  const statusEl = document.getElementById('homeExtractStatus');
  if (statusEl) statusEl.style.display = 'none';
}

function showExtractingStatus() {
  const statusEl = document.getElementById('homeExtractStatus');
  const dotEl = document.getElementById('homeExtractDot');
  const textEl = document.getElementById('homeExtractText');
  if (!statusEl) return;
  statusEl.style.display = 'flex';
  statusEl.className = 'home-extract-status extracting-active';
  dotEl.className = 'home-extract-dot extracting';
  textEl.textContent = window._t('statusExtracting');
}

// Show a short success flash then return to normal status
function showExtractionDone(p) {
  const statusEl = document.getElementById('homeExtractStatus');
  const dotEl = document.getElementById('homeExtractDot');
  const textEl = document.getElementById('homeExtractText');
  if (!statusEl) return;
  statusEl.style.display = 'flex';
  statusEl.className = 'home-extract-status just-done';
  dotEl.className = 'home-extract-dot';
  dotEl.style.background = '#22c55e';
  textEl.textContent = window._t('statusExtractionDone');
  setTimeout(() => {
    dotEl.style.background = '';
    updateExtractionStatus(p);
  }, 2200);
}




// Profile scraper - injected into the LinkedIn tab via executeScript

async function inlineScrapeFunction() {
  const _scrapeStart = Date.now();
  try {
    const url = location.href || '';
    const onProfile = /linkedin\.com\/in\//.test(url);

    // Utility functions
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    // Try to get name and headline from LinkedIn's JSON-LD schema first
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


    // Wait for the page to finish loading before reading the DOM
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

    // Try each selector in order and return the first match
    const rq = (el, chain) => { for (const s of chain) { const r = el.querySelector(s); if (r) return r; } return null; };
    const rqa = (el, chain) => { for (const s of chain) { const r = el.querySelectorAll(s); if (r.length) return [...r]; } return []; };

    // Track sections with detail pages to visit for more data
    const _sectionsNeedingDetailPage = new Set();
    const _modalSkillCandidates = [];

    if (onProfile) {
      const maxH = () => document.body.scrollHeight;
      const sectionKeywords = /experience|expérience|experiencia|erfahrung|esperienza|experiência|خبرة|education|formation|educación|ausbildung|istruzione|educação|formação|تعليم|skills|compétences|habilidades|kenntnisse|competenze|competências|مهارات|certif|licen|volunteer|bénévolat|voluntariado|ehrenamt|volontariato|voluntariado|تطوع|project|projet|proyecto|projekt|progetto|projeto|مشاريع|language|langue|idioma|sprach|lingua|لغات|honor|award|publication|recommendation|organisation|course|curso|kurs|corso/i;

      // Check if this is the newer SDUI layout
      const isSDUI = document.querySelectorAll('div[componentkey]').length > 5;

      // Scroll down to trigger lazy loading (fewer passes needed in SDUI)
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

      // Scroll to each section to trigger loading (skipped in SDUI)
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

      // Click "See more" buttons to expand text (not needed in SDUI)
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

      // Click "Show all" buttons or collect /details/ links for enrichment
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

      // Open the skills modal if present (not used in SDUI)
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

      // Click "Load more" buttons (skipped in SDUI)
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

      // Final re-scroll after expanding sections (non-SDUI only)
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
      // Normalize whitespace and number separators
      let t = raw.toString().trim().toLowerCase().replace(/[\s\u00A0\u202F]+/g, '');
      const hasSuffix = /[km]/.test(t);
      // Treat dot/comma followed by 3 digits as a thousands separator
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
    // LinkedIn placeholder texts that should not be saved as real profile data
    const _LINKEDIN_PLACEHOLDERS = [
      // Placeholder text for empty about and headline sections
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
      /write a summary to highlight/i,
      /highlight your personality or work experience/i,
      /highlight your personality/i,
      // Volunteer and non-profit CTA text that appears in empty profiles
      /tell non-?profits you are interested/i,
      /getting involved with your time and skills/i,
      // Placeholder text for empty experience sections
      /^job title$/i,
      /^company name$/i,
      /^position title$/i,
      /^your job title$/i,
      /^organization$/i,
      // Placeholder text for empty skills section
      /^soft skills$/i,
      /^technical skills$/i,
      /^add skills?$/i,
      /^add a skill$/i,
      /^industry knowledge$/i,
      // Generic LinkedIn CTAs and empty-state strings
      /^add (your|a|an) /i,
      /^share (your|a|an) /i,
      /^start (a|your) /i,
      /^let (people|others|recruiters)/i,
      /people with (your|a) (role|skills?|background)/i,
      /open to (work|opportunities)/i,
      /providing services/i,
      /hiring on linkedin/i,
      // Text shown in recruiter or hiring mode that is not profile data
      /share that you.re hiring/i,
      /attract qualified candidates/i,
      /share.*hiring.*attract/i,
      // Open-to-work banners that can appear in the about section
      /providing services/i,
      /open to work/i,
      /open for business/i,
      // CTA text shown when the about section is empty
      /get discovered by/i,
      /let recruiters know/i,
      /show up in recruiter searches/i,
      /sign in to see who/i,
    ];
    const isPlaceholder = (raw) => _LINKEDIN_PLACEHOLDERS.some(rx => rx.test((raw || '').trim()));

    const isUiNoise = (raw) => {
      const t = normalize(raw).toLowerCase();
      if (!t) return true;
      // Generic empty profile CTAs
      if (isPlaceholder(raw)) return true;
      // LinkedIn section headers that are not profile data
      if (/^(experience|expérience|experiencia|erfahrung|esperienza|experiência|خبرة|education|formation|educación|ausbildung|istruzione|educação|formação|تعليم|skills|compétences|habilidades|aptitudes|kenntnisse|competenze|competências|مهارات|about|à propos|acerca de|über|informazioni|sobre|نبذة|show all|see all|show more|see more|… more|more|view all|followers?|connections?|contact info|message|open to|add section|edit|modifier|activity|activité|actividad|aktivitäten|attività|atividade|نشاط|licenses?|certifications?|licences?|certificaciones?|zertifizierungen?|certificazioni?|languages?|langues?|idiomas?|sprachen?|lingue?|لغات|volunteer|bénévolat|volontariat|voluntariado|ehrenamt|volontariato|تطوع|projects?|projets?|proyectos?|projekte?|progetti?|projetos?|مشاريع|publications?|publicaciones?|publikationen?|pubblicazioni?|publicações?|منشورات|honors?|awards?|distinctions?|premios?|auszeichnungen?|premi?|prêmios?|جوائز|organisations?|organizaciones?|organisationen?|organizzazioni?|organizações?|منظمات|courses?|cours|cursos?|kurse?|corsi|دورات|recommendations?|recommandations?|recomendaciones?|empfehlungen?|raccomandazioni?|recomendações?|توصيات|causes you care about|supported)$/.test(t)) return true;
      // Connection and follower count strings
      if (/^\d[\d,.\s+]*\s*(followers?|connections?|abonnés?|contacts?|seguidores?|conexiones?|kontakte?|follower|collegamenti|seguidor(es)?|متابع|اتصال)$/i.test(t)) return true;
      // Navigation labels that appear in profile page DOM but are not profile data
      if (/^(home|my network|jobs|messaging|notifications?|me|work|gaming|news|people|groups|events|learning|services|products|careers|premium|try premium)$/.test(t)) return true;
      // Skill and certification category labels
      if (/^(industry knowledge|tools & technologies|interpersonal skills|other skills|other|see credential|show credential|view credential|issued|expires?|credential id|no expiration)$/.test(t)) return true;
      // Short numbers that are UI noise, not profile data
      if (/^\d{1,3}$/.test(t)) return true;
      // Single characters that should be ignored
      if (/^\w$/.test(t)) return true;
      // Activity feed metadata like like counts and connection degree labels
      if (/^live$/i.test(t)) return true;
      if (/^\d+\s*(comments?|likes?|reactions?|shares?|reposts?|views?)/i.test(t)) return true;
      // Engagement count strings like "and 47 others reacted"
      if (/and \d+ others? (reacted|liked|commented|reposted)/i.test(t)) return true;
      // Translation prompt text from feed posts
      if (/^show translation$/i.test(t)) return true;
      // Repost count labels
      if (/^\d+ repost(s)?$/i.test(t)) return true;
      // Job placement badge text
      if (/linkedin helped me get this job/i.test(t)) return true;
      // "Show all N" link text that can leak into entries
      if (/^show all \d+/i.test(t)) return true;
      // Name and connection degree separator patterns
      if (/ • (you|1st|2nd|3rd|\d+(st|nd|rd|th)?)$/i.test(t)) return true;
      return false;
    };

    // Collect aria-hidden spans from an item, preferring leaf nodes to avoid duplicates
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
      // Use leaf spans when possible to avoid duplicated text
      const leafSpans = allSpans.filter(s => s.children.length === 0);
      return leafSpans.length > 0 ? leafSpans : allSpans;
    };

    // Extract name - use JSON-LD first as it is more reliable
    let name = (_jsonLd && _jsonLd.name) ? String(_jsonLd.name).trim() : '';
    // Ignore h2 elements that are section headers, not the name
    const skipH = /^\d+\s*notification|profile\s+language|public\s+profile|ad\s+option|people\s+you\s+may|you\s+might\s+like|sign\s+in/i;
    let nameEl = null;

    // Fall back to DOM extraction if JSON-LD did not have the name
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

    // Extract profile photo
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

    // Extract headline
    // Seed from JSON-LD (jobTitle or description field).
    let headline = '';
    if (_jsonLd) {
      if (_jsonLd.jobTitle) headline = String(_jsonLd.jobTitle).trim();
      else if (_jsonLd.description && _jsonLd.description.length < 300) headline = String(_jsonLd.description).trim();
    }

    // Helper to check if a string looks like a location
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

    // Try TreeWalker from the name element first
    if (nameEl) {
      const tryWalk = (container) => {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
        let passedName = false;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (nameEl.contains(node)) { passedName = true; continue; }
          if (!passedName) continue;
          const t = node.textContent.trim();
          if (!t || t.length < 3) continue;
          if (t === name) continue;
          // Skip nav/button text, but allow anchor-wrapped text (SDUI often wraps
          // headline/info text in clickable <a> cards).
          if (node.parentElement?.closest('button, nav')) continue;
          // Skip degree badges ("· 2nd"), UI actions, and noise
          if (_isDegreeBadge(t)) continue;
          if (/^(\d+|connection|follow|contact|open to|add section|message|enhance|modifier|pending|more|show|see all|click|pronoun|she\/|he\/|they\/|try\s|verify\s|premium|MAD)/i.test(t)) continue;
          // Skip employer/school combos ("BDS BATIMENT · Université Paris Dauphine") - not the headline
          if (_isEmployerSchoolLine(t)) continue;
          if (t.length <= 250 && !_isLikelyLocation(t)) {
            return t;
          }
        }
        return '';
      };

      // Try progressively wider containers until a headline-like text is found.
      let container = nameEl;
      for (let i = 0; i < 8 && container.parentElement; i++) {
        container = container.parentElement;
        const found = tryWalk(container);
        if (found) { headline = found; break; }
      }
    }

    // Fall back to class-based selectors
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
            !text.toLowerCase().startsWith('verify ') &&
            !_isLikelyLocation(text) &&
            text !== name) {
          headline = text; break;
        }
      }
    }

    // Last resort: try classic selectors
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

    // Extract location
    let location_ = '';

    // Try known location selectors in the profile header
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

    // Look for paragraphs with location-like text
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

    // Walk the DOM near the name to find location text
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

    // Find a section by name (e.g. Experience, Skills, Education)
    // Guard: returns true when `el` is the Activity / Posts feed section.
    const isActivityFeedSection = (el) => {
      if (!el) return false;
      // 1. data-view-name / aria-label attributes
      const dvn = (el.getAttribute('data-view-name') || '').toLowerCase();
      if (/feed|activity|posts/.test(dvn)) return true;
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      if (/activity|posts/.test(ariaLabel)) return true;
      // 2. Any /details/ link? Then it's a real profile section, not feed
      if (el.querySelector('a[href*="/details/"]')) return false;
      // 3. Does it contain pvs-entity items? Real profile section, not feed
      if (el.querySelector('[class*="pvs-entity"], li[class*="artdeco"], li[data-view-name]')) return false;
      // 4. Engagement noise density — even 1 hit in a section that has no profile items
      const sample = el.textContent.substring(0, 3000);
      const noiseHits = (sample.match(/\b(reacted|repost(ed|s)?|commented|liked|comment(s)?|reaction(s)?|and \d+ others?)\b/gi) || []).length;
      if (noiseHits >= 1) return true;
      // 5. Feed post fingerprints: carousel position, reaction counts
      if (/\b\d+\/\d+\b/.test(sample)) return true;
      return false;
    };

    // Guard: returns true when `el` is a sidebar/recommendation module
    // ("People also viewed", "Pages for you", "You might like", ads, etc.)
    // These often contain headings like "Higher Education" or "Skills" that
    // would otherwise false-match the profile's real Education/Skills sections.
    const isSidebarRecommendationSection = (el) => {
      if (!el) return false;
      const dvn = (el.getAttribute('data-view-name') || '').toLowerCase();
      if (/insight|recommend|browse-map|people-also-viewed|ads?|cross-sell|suggested/.test(dvn)) return true;
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      if (/people also viewed|people you may know|pages for you|you might like|ads?\b|promoted|browse|similar/.test(ariaLabel)) return true;
      // Heading-text based detection
      const heading = el.querySelector(':scope > div h2, :scope > div h3, :scope > header h2, h2, h3');
      if (heading) {
        const ht = heading.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
        if (/people also viewed|people you may know|pages for you|you might like|similar pages|more profiles for you|explore premium|browse|ads you may be interested in/.test(ht)) return true;
      }
      // "Follow" buttons + "connections follow this page" pattern is unique to Pages-for-you widgets
      if (/\bfollow\b.*\bthis page\b|other connections follow this page/i.test(el.textContent.substring(0, 500))) return true;
      return false;
    };

    // Given a heading element, return the narrowest ancestor that plausibly
    // wraps just THIS section's content (heading + its entries), not a larger
    // container that also wraps sibling sections (Activity feed, Education, etc.).
    // Walk up from the heading until we find an ancestor whose ONLY heading
    // (h1-h4) is this one — i.e. it doesn't also contain other section headings.
    const narrowToHeadingScope = (heading, fallbackSec) => {
      let el = heading.parentElement;
      let best = fallbackSec;
      for (let depth = 0; depth < 6 && el && el !== document.body; depth++, el = el.parentElement) {
        const headings = el.querySelectorAll('h1, h2, h3, h4');
        if (headings.length === 1 && headings[0] === heading) {
          best = el; // keep widening while still single-heading
        } else if (headings.length > 1) {
          break; // this ancestor wraps multiple sections — stop, use last good `best`
        }
      }
      // Sanity: if narrowing accidentally produced a node that itself looks
      // like the activity feed or a sidebar module, fall back to the original section.
      if (isActivityFeedSection(best) || isSidebarRecommendationSection(best)) return fallbackSec;
      return best;
    };

    // Match by heading text inside each section
    function findSection(keywords, excludeNodes = []) {
      const kwLow = keywords.map(k => k.toLowerCase().trim());
      const isExcluded = (node) => excludeNodes.some(ex => ex && (ex === node || ex.contains(node) || node.contains(ex)));

      for (const sec of document.querySelectorAll('section')) {
        if (isActivityFeedSection(sec) || isSidebarRecommendationSection(sec) || isExcluded(sec)) continue;
        for (const heading of sec.querySelectorAll(':scope > div h2, :scope > div h3, :scope > header h2')) {
          const ht = heading.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
          if (kwLow.some(k => ht === k || ht === k + 's')) return narrowToHeadingScope(heading, sec);
        }
      }

      // Looser heading match, still excluding sidebar elements
      for (const sec of document.querySelectorAll('section')) {
        if (isActivityFeedSection(sec) || isSidebarRecommendationSection(sec) || isExcluded(sec)) continue;
        for (const heading of sec.querySelectorAll(':scope > div h2, :scope > div h3, :scope > header h2')) {
          const ht = heading.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
          if (kwLow.some(k => ht.startsWith(k) || ht.includes(k))) return narrowToHeadingScope(heading, sec);
        }
      }

      // Match by aria-label, data-view-name, or id attributes
      for (const kw of kwLow) {
        const safeKw = CSS.escape ? kw : kw.replace(/[^\w\s-]/g, '');
        const hits = [
          ...document.querySelectorAll(`section[aria-label*="${safeKw}" i]`),
          ...document.querySelectorAll(`section[id*="${safeKw}" i]`),
          ...document.querySelectorAll(`[data-view-name*="${safeKw}" i]`),
        ];
        const byId = document.getElementById(safeKw);
        if (byId) hits.push(byId);
        for (const hit of hits) {
          if (isActivityFeedSection(hit) || isSidebarRecommendationSection(hit) || isExcluded(hit)) continue;
          const sec = hit.closest('section');
          if (sec) {
            if (isActivityFeedSection(sec) || isSidebarRecommendationSection(sec) || isExcluded(sec)) continue;
            return sec;
          }
          return hit;
        }
      }

      // Match by the first heading in the section
      // (avoids matching unrelated sections whose body text happens to mention the keyword)
      for (const sec of document.querySelectorAll('section')) {
        if (isActivityFeedSection(sec) || isSidebarRecommendationSection(sec) || isExcluded(sec)) continue;
        const firstHeading = sec.querySelector('h1, h2, h3, h4');
        if (!firstHeading) continue;
        const ht = firstHeading.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
        if (kwLow.some(k => ht === k || ht.startsWith(k) || ht.includes(k))) return narrowToHeadingScope(firstHeading, sec);
      }

      // Match by section text content as a last resort
      for (const sec of document.querySelectorAll('section')) {
        if (isActivityFeedSection(sec) || isSidebarRecommendationSection(sec) || isExcluded(sec)) continue;
        const first120 = sec.textContent.trim().substring(0, 120).toLowerCase();
        if (kwLow.some(k => first120.includes(k))) return sec;
      }

      // Look inside artdeco card containers
      const containers = [...document.querySelectorAll('section'), ...document.querySelectorAll('[class*="artdeco-card"]')];
      for (const container of containers) {
        if (isActivityFeedSection(container) || isSidebarRecommendationSection(container) || isExcluded(container)) continue;
        for (const el of container.querySelectorAll('h2, h3, span[aria-hidden="true"]')) {
          if (el.closest('li')) continue;
          const et = el.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
          if (kwLow.some(k => et === k || et.includes(k))) return container;
        }
      }

      // Walk the DOM tree as a final fallback
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
          const hasPvsEntity = el.querySelector('[class*="pvs-entity"]');
          const hasProfileLi = el.querySelector('li[class*="artdeco"], li[class*="pvs"], li[data-view-name]');
          if (!hasPvsEntity && !hasProfileLi) continue;
          if (isActivityFeedSection(el) || isSidebarRecommendationSection(el) || isExcluded(el)) continue;
          return el;
        }
      }
      return null;
    }

    // Extract about section
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

      // 1b. SDUI expandable-text-box (2025+ LinkedIn about section)
      if (!about) {
        const expandEl = aboutSec.querySelector('[data-testid="expandable-text-box"]');
        if (expandEl) {
          const cl = expandEl.cloneNode(true);
          cl.querySelectorAll('button, .visually-hidden').forEach(b => b.remove());
          const t = normalize(cl.textContent);
          if (t.length > 20 && !isAboutPlaceholder(t)) about = t;
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
          // Skip company name patterns (e.g. "Smartovate | سمارتوفيت")
          if (/\|/.test(t) && t.split(/\s+/).length < 10) continue;
          // Skip "Company · Role" metadata patterns
          if (/^[^.!?\n]{5,60}\s[·•]\s[^.!?\n]{3,60}$/.test(t.trim()) && t.length < 100) continue;
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

    // Remove noise that leaked into the about field
    if (about) {
      const _aboutIsNoise = (s) => {
        // Too short to be a real about section
        if (s.length < 15) return true;
        // Company name pattern: "Company | ترجمة" or "Company · subtitle" with no sentence
        const hasSentence = /[.!?]/.test(s) || s.split(/\s+/).length > 12;
        if (!hasSentence) {
          // Contains pipe separator typical of company names
          if (/\|/.test(s) && s.length < 120) return true;
          // Looks like "Company · Role" (experience metadata)
          if (/^[^.!?\n]{5,60}\s[·•]\s[^.!?\n]{3,60}$/.test(s.trim())) return true;
          // Matches "City, Region, Country" geo patterns
          const hasGeoWords = /\b(maroc|morocco|france|algerie|algeria|tunisie|tunisia|souss|agadir|casablanca|rabat|dubai|area|region|gouvernorat|wilaya|province)\b/i.test(s);
          const hasCommasOnly = /^[^.!?]{3,80},[^.!?]{3,80}$/.test(s.trim());
          if ((hasCommasOnly || hasGeoWords) && s.length < 150) return true;
        }
        return false;
      };
      if (_aboutIsNoise(about)) {
        console.warn('[LinkedIn AI] About discarded — looks like noise:', about);
        about = '';
      }
    }

    // Extract experience entries
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
      // Use data-field attributes first, fall back to date pattern matching
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

      // SDUI-specific experience parser (2025+ LinkedIn layout)
      // Uses stable div[componentkey^="entity-collection-item"] entries + edit form links.
      // Grouped detection: entry has a <ul> child → multiple roles at same company.
      // Single detection: entry has direct a[href*="/edit/forms/position/"] → one role.
      const sduiEntries = [...expSec.querySelectorAll('div[componentkey^="entity-collection-item"]')];
      if (sduiEntries.length > 0) {
        for (const entry of sduiEntries) {
          try {
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
                // Grouped role edit-link p[] order:
                //   p[0] = role title
                //   p[1] = "Aug 2025 - Oct 2025 · 3 mos"
                //   p[2] = "City, Region · On-site"  (optional)
                // On 3rd-party profiles there are no edit links — fall back to p[] inside the li
                const psSource = editLink || li;
                const ps = [...psSource.querySelectorAll('p')]
                  .map(p => (p.textContent || '').trim())
                  .filter(t => t.length > 0 && !isUiNoise(t));
                if (ps.length === 0) continue;

                // Classify each p[] by content to handle both own-profile (edit links)
                // and 3rd-party profiles (no edit links, more p[] present).
                const _isRoleDateStr  = t => /\b(20\d\d|19\d\d|Present|présent|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(t) && t.length < 80;
                const _isRoleDuration = t => /^\d+\s*(yr|mo|an|mois|año|mes|Jahr|Monat)/i.test(t);
                const _isRoleEmpType  = t => /^(Internship|Full-time|Part-time|Contract|Freelance|Self-employed|Apprenticeship|Seasonal|Temporary|Volunteering|CDD|CDI|Stage|Alternance|Remote|On-site|Hybrid)$/i.test(t);
                const _isRoleLocation = t => (t.includes(',') && t.length < 100) || (t.includes('·') && /\b(remote|on-site|hybrid)\b/i.test(t));

                let title = '', dates = '', duration = '', location = '', roleEmpType = companyEmpType;
                for (const t of ps) {
                  if (_isRoleDateStr(t) && !dates) {
                    const dp = t.split('·');
                    dates    = dp[0].trim();
                    duration = dp[1]?.trim() || '';
                    continue;
                  }
                  if (_isRoleDuration(t) && !duration) { duration = t; continue; }
                  if (_isRoleEmpType(t) && !roleEmpType) { roleEmpType = t; continue; }
                  if (_isRoleLocation(t) && !location) {
                    const locParts = t.split('·').map(s => s.trim());
                    location = locParts[0];
                    if (locParts[1] && _isRoleEmpType(locParts[1]) && !roleEmpType) roleEmpType = locParts[1];
                    if (/^(Remote|On-site|Hybrid)$/i.test(locParts[0])) { location = ''; roleEmpType = roleEmpType || locParts[0]; }
                    continue;
                  }
                  // First unclassified short string = title (skip if it duplicates the company name)
                  if (!title && t.length < 120 && t.toLowerCase() !== company.toLowerCase()) {
                    title = t;
                    continue;
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
              // On 3rd-party profiles, no edit link exists — fall back to p[] inside the entry
              const psSource = editLink || entry;
              const ps = [...psSource.querySelectorAll('p')]
                .map(p => (p.textContent || '').trim())
                .filter(t => t.length > 0 && !isUiNoise(t));

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

      // Fall back to list items for older LinkedIn layouts
      // LinkedIn structure: section > ul > li.group (company) > div > ul > li.leaf (role 1, role 2)
      // Single-role companies: section > ul > li.leaf (role with company inline)
      // Skip if SDUI already found entries
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

          const looksLikeFeedPost = (
            !entry.title && !entry.company
          ) || (
            entry.description && entry.description.length > 120 &&
            /\b(reacted|reposted|commented|followers?|connections?|hashtag|#\w+)\b/i.test(entry.description)
          );
          if ((entry.title || entry.company) && !isUiNoise(entry.title) && !isUiNoise(entry.company) && !looksLikeFeedPost) {
            const key = (entry.title + entry.company).toLowerCase();
            if (!experience.some(r => (r.title + r.company).toLowerCase() === key)) {
              experience.push(entry);
            }
          }
          if (experience.length >= 15) break;
        }
      }

      // Fall back to hashed class matching
      if (experience.length === 0) {
        if (expSec && isActivityFeedSection(expSec)) {
          console.warn('[ProfileScrape] expSec looks like Activity feed — skipping Strategy 2 fallback');
        } else {
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
            // Skip if it looks like an Activity feed post narrative
            if (/\b(reacted|reposted|#\w{3,}|followers?|connections?)/i.test(text)) { /* skip feed text */ }
            else current.description = current.description
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
        } // end else (not activity feed)
      }
    }
    } catch (e) { console.warn('[LinkedIn AI] Experience section error:', e); }

    // Extract education entries
    const education = [];
    let eduSec = null;
    try {
    eduSec = findSection(['Education', 'Formation', 'education', 'formation', 'Educación', 'Ausbildung', 'Istruzione', 'Educação', 'Formação', 'تعليم'], [expSec, aboutSec]);

    // Sanity guard: if the matched "education" section actually looks like the
    // experience listing (e.g. "X yrs Y mos" duration patterns dominate, with no
    // degree/field-of-study vocabulary), discard it — likely a mis-match from a
    // Fall back to body text matching like the experience parser
    if (eduSec && eduSec === expSec) eduSec = null;
    if (eduSec) {
      const eduText = (eduSec.textContent || '').toLowerCase();
      const looksLikeExperience = /\b\d+\s*(yrs?|years?)\s*\d*\s*(mos?|months?)?\b/.test(eduText)
        && !/(bachelor|master|degree|diplôme|licence|university|université|college|école|institute|institut|m\.sc|b\.sc|phd|baccalauréat|formation)/i.test(eduText);
      if (looksLikeExperience) eduSec = null;
    }

    if (eduSec) {
      // SDUI-specific education parser
      // Use edit links when on own profile
      const sduiEduLinks = [...eduSec.querySelectorAll('a[href*="/details/education/edit/forms/"]')];
      for (const link of sduiEduLinks) {
        try {
          const ps = [...link.querySelectorAll('p')]
            .map(p => (p.textContent || '').trim())
            .filter(t => t.length > 1 && !isUiNoise(t));
          const school = ps.find(t => !/\d{4}/.test(t)) || '';
          const datesRaw = ps.find(t => /\d{4}/.test(t)) || '';
          const nonSchoolNonDate = ps.filter(t => t !== school && !/\d{4}/.test(t));
          const degreeRaw = nonSchoolNonDate[0] || '';
          const commaIdx = degreeRaw.indexOf(',');
          const degree = commaIdx > 0 ? degreeRaw.slice(0, commaIdx).trim() : degreeRaw;
          const fieldOfStudy = commaIdx > 0 ? degreeRaw.slice(commaIdx + 1).trim() : (nonSchoolNonDate[1] || '');
          if (school && !isUiNoise(school) && !/^\d{4}/.test(school)) {
            const key = (school + '|' + degree).toLowerCase();
            if (!education.some(e => (e.school + '|' + e.degree).toLowerCase() === key)) {
              education.push({ school, degree, fieldOfStudy, dates: datesRaw, description: '' });
            }
          }
        } catch(e) { /* skip */ }
        if (education.length >= 8) break;
      }

      // Use componentkey entries when viewing someone else's profile
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

      // Scan p-tags in list items as a fallback for third-party profiles
      // where componentkey selectors yield nothing but section exists)
      if (education.length === 0) {
        const eduItems = [...eduSec.querySelectorAll('li, [data-view-name*="profile-component-entity"], .pvs-entity')];
        for (const item of eduItems) {
          try {
            const ps = [...item.querySelectorAll('p, span[aria-hidden="true"]')]
              .filter(el => el.children.length === 0 && !el.closest('button'))
              .map(el => (el.textContent || '').trim())
              .filter((t, i, arr) => t.length > 1 && !isUiNoise(t) && arr.indexOf(t) === i);
            const school = ps.find(t => !isUiNoise(t) && !/^\d{4}/.test(t) && t.length > 2);
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
        if (eduItems.length > 0 && education.length > 0) console.log(`[ProfileScrape] education (0c): ${education.length} entries`);
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

      // Fall back to hashed class matching
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

    // Clean up education entries where school field contains a course title instead
    // (Udemy, Coursera etc. list course names as separate entries)
    const _isCourseTitleNotSchool = (s) => {
      if (!s) return false;
      // Long strings are course titles, not school names
      if (s.length > 60) return true;
      // Contains colons, exclamation marks, or multiple commas — course title pattern
      if (/[:!]/.test(s) || (s.match(/,/g) || []).length > 2) return true;
      // Looks like a certificate name
      if (/\b(complete|training|bootcamp|course|masterclass|certificate|certification)\b/i.test(s)) return true;
      return false;
    };
    // Filter and deduplicate
    const _eduSeen = new Set();
    for (let i = education.length - 1; i >= 0; i--) {
      const e = education[i];
      if (_isCourseTitleNotSchool(e.school)) { education.splice(i, 1); continue; }
      const key = (e.school || '').toLowerCase().slice(0, 40);
      if (_eduSeen.has(key)) { education.splice(i, 1); continue; }
      _eduSeen.add(key);
      // Also clean degree if it's a course title (replace with empty)
      if (_isCourseTitleNotSchool(e.degree)) e.degree = '';
    }
    const skills = [];
    let skillsSec = null;
    try {
    skillsSec = findSection(['Skills', 'Compétences', 'skills', 'compétences', 'مهارات', 'Habilidades', 'Aptitudes', 'Kenntnisse', 'Competenze', 'Competências'], [expSec, eduSec, aboutSec]);
    const _skillSeen = new Set();

    const _isSkillNoise = (t) => {
      if (!t || t.length < 2 || t.length > 80) return true;
      if (isUiNoise(t)) return true;
      if (/\d{4}|endors|recommand|see more|voir plus|show all|voir tout/i.test(t)) return true;
      if (/and \+\d+ skills?/i.test(t)) return true;
      // Activity feed reaction strings: "HASSAN JAHA and 92 others reacted"
      if (/\band \d+ others? (reacted|liked|commented|reposted)/i.test(t)) return true;
      // Standalone engagement counts leaking from feed
      if (/\b\d+\s*(reactions?|comments?|reposts?|likes?|shares?)\b/i.test(t)) return true;
      // Carousel position indicators: "1/5", "1/12"
      if (/^\d+\/\d+$/.test(t.trim())) return true;
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

      // SDUI-specific skills parser
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

      // Get the first aria-hidden span in each list item - that is the skill name
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

      // Fall back to all aria-hidden leaf spans
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
    langSec = findSection(['Languages', 'Langues', 'languages', 'langues', 'اللغات', 'Idiomas', 'Sprachen', 'Lingue', 'Idiomas'], [expSec, eduSec, skillsSec, aboutSec]);
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
    certSec = findSection(['Licenses', 'Certifications', 'Licences', 'certifications', 'licenses & certifications', 'licences et certifications', 'Licencias', 'Certificaciones', 'Zertifizierungen', 'Lizenzen', 'Certificazioni', 'Licenças', 'Certificações', 'التراخيص والشهادات'], [expSec, eduSec, skillsSec, langSec, aboutSec]);
    if (certSec) {
      const isCertNoise = (t) => {
        if (isUiNoise(t)) return true;
        if (/^view\s+analytics$/i.test(t)) return true;
        if (/\band\s+\d+\s+others?$/i.test(t)) return true;
        if (/^\d+\s+others?$/i.test(t)) return true;
        if (/^(see|show|view)\s+credential$/i.test(t)) return true;
        if (/licen|certif/i.test(t) && t.length < 50) return true;  // section headers
        return false;
      };

      // Strategy 0: SDUI edit links (own profile — most accurate)
      console.log('[CertInline] edit links:', certSec.querySelectorAll('a[href*="/details/certifications/edit/forms/"], a[href*="/details/licenses/edit/forms/"]').length);
      // Log first li texts to see what the fallback is reading
      const _dbgLi = certSec.querySelector('li, .pvs-entity, [data-view-name*="profile-component-entity"]');
      if (_dbgLi) {
        const _dbgSpans = [..._dbgLi.querySelectorAll('span[aria-hidden="true"]')].slice(0,6).map(s=>s.textContent.trim());
        console.log('[CertInline] first li spans:', JSON.stringify(_dbgSpans));
        const _dbgPs = [..._dbgLi.querySelectorAll('p')].slice(0,6).map(p=>p.textContent.trim());
        console.log('[CertInline] first li p tags:', JSON.stringify(_dbgPs));
      }
      const sduiCertLinks = [...certSec.querySelectorAll(
        'a[href*="/details/certifications/edit/forms/"], a[href*="/details/licenses/edit/forms/"]')];
      for (const link of sduiCertLinks) {
        try {
          const rawPs = [...link.querySelectorAll('p')].map(p => normalize(p.textContent));
          const ps = rawPs.filter(t => t.length > 1 && !isCertNoise(t));
          console.log('[CertInline] rawPs:', JSON.stringify(rawPs), '→ filtered:', JSON.stringify(ps));
          const certName = ps.find(t => !/^\d{4}/.test(t) && !/\bIssued\b/i.test(t)) || '';
          const issuer   = ps.find((t, i) => i > 0 && t !== certName && !/^\d{4}/.test(t) && !/\bIssued\b/i.test(t)) || '';
          const dateStr  = ps.find(t => /\d{4}/.test(t) || /\bIssued\b/i.test(t)) || '';
          console.log('[CertInline] → certName:', certName, 'issuer:', issuer, 'date:', dateStr);
          if (certName && !isCertNoise(certName)) {
            if (!certifications.some(c => c.name.toLowerCase() === certName.toLowerCase()))
              certifications.push({ name: certName, issuer, date: dateStr });
          }
        } catch(e) { console.warn('[CertInline] edit link error:', e); }
        if (certifications.length >= 20) break;
      }

      // Strategy 1: Generic li fallback
      if (certifications.length === 0) {
        const allItems = Array.from(certSec.querySelectorAll('li, .pvs-entity, [data-view-name*="profile-component-entity"], .artdeco-list__item'))
          .filter(item => !item.parentElement?.closest('li'));
        for (const item of allItems) {
          const spans = getScopedSpans(item);
          const seenT = new Set();
          const texts = spans
            .map(s => normalize(s.textContent))
            .filter(t => t.length > 1 && t.length < 200)
            .filter(t => { const k = t.toLowerCase(); if (seenT.has(k)) return false; seenT.add(k); return true; })
            .filter(t => !isCertNoise(t));
          if (texts.length > 0) {
            const certName = texts[0] || '';
            const issuer = texts.find((t, i) => i > 0 && t.length > 1 && !/^\d{4}/.test(t) && !/^issued|^expires/i.test(t)) || '';
            const dateStr = texts.find(t => /\b(issued?|expires?|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t) || /\d{4}/.test(t)) || '';
            if (certName && !isCertNoise(certName)) certifications.push({ name: certName, issuer, date: dateStr });
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
      if (/^\d{4}\s*[-–]\s*(present|\d{4})/i.test(title) && (!comp || /^add experience$/i.test(comp))) return true;
      if (title.length > 80 && /\b(repost|reaction|comment|follower|connection|gender|AI gap|matters because)\b/i.test(title)) return true;
      if (/^[A-Z][^.!?]{3,50}[·•]\s*(On-site|Remote|Hybrid)$/i.test(title)) return true;
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


// ── Detail Page Content Scraper ──────────────────────────────────────────────
// Injected via executeScript AFTER the popup has already navigated the tab
// to the detail page using chrome.tabs.update. This function does NOT navigate —
// it only scrolls and scrapes the already-loaded page.
// Zero-wait detail page scraper — reads the DOM immediately after navigation.
// LinkedIn SDUI detail pages are fully server-rendered; no polling or scroll waits needed.
// For legacy pages we do a fast synchronous scroll to trigger IntersectionObserver, then read.
function scrapeDetailPageContent(SECTION) {
  const normalize = s => (s || '').trim().replace(/\s+/g, ' ');

  const isUiNoise = raw => {
    const t = normalize(raw).toLowerCase();
    if (!t || t.length < 2) return true;
    if (/^(experience|expérience|experiencia|education|formation|skills|compétences|habilidades|about|show all|see all|show more|see more|more|view all|followers?|connections?|contact info|message|activity|licenses?|certifications?|languages?|langues?|volunteer|projects?|recommendations?|endorsed by|people also viewed|no expiration|credential id)$/.test(t)) return true;
    if (/^\d{1,3}$/.test(t)) return true;
    return false;
  };

  try {
    // Guard: must be on a detail page
    if (!window.location.href.includes('/details/')) {
      const isAuth = /login|authwall|checkpoint|signup/i.test(window.location.href) || !!document.querySelector('#username,#password,.authwall');
      return { section: SECTION, items: [], count: 0, error: isAuth ? 'login_redirect' : 'unexpected_redirect' };
    }
    if (document.querySelector('.authwall-join-form,#join-form,.join-form')) {
      return { section: SECTION, items: [], count: 0, error: 'authwall_on_detail_page' };
    }

    // Fast synchronous scroll — no awaits, just triggers IntersectionObserver for lazy items
    const step = Math.max(600, Math.floor(window.innerHeight * 0.85));
    for (let y = 0; y <= document.body.scrollHeight; y += step) window.scrollTo(0, y);
    window.scrollTo(0, document.body.scrollHeight);
    window.scrollTo(0, 0);

    // Detect SDUI layout
    const isSDUI = document.querySelectorAll('div[componentkey]').length > 5;

    // Find best root container
    const containerSelectors = ['main','[role="main"]','.scaffold-layout__main','.core-rail','.pvs-list__container','.scaffold-finite-scroll','#main','[id*="main-content"]','.pvs-list','[class*="scaffold"]','[class*="artdeco-card"]'];
    let root = null;
    for (const sel of containerSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (el.querySelectorAll('li').length > 0 || el.querySelectorAll('span[aria-hidden="true"]').length > 3) { root = el; break; }
    }
    if (!root) root = document.body;

    const items = [];

    const getSpanText = span => {
      if (!span) return '';
      const leaf = span.querySelector('span:not(:has(span))') || span;
      return normalize(leaf.textContent);
    };

    const getLeafItems = (container, sel) => {
      const all = container.querySelectorAll(sel);
      const leafs = [];
      for (const item of all) {
        if (item.closest('nav,header,footer,aside,[role="navigation"],.artdeco-pagination')) continue;
        const hasChild = item.querySelector(':scope > ul > li, :scope > div > ul > li');
        if (hasChild && item.tagName === 'LI') {
          for (const nl of item.querySelectorAll(':scope > div > ul > li, :scope > div > div > ul > li')) leafs.push(nl);
        } else {
          leafs.push(item);
        }
      }
      return leafs.length > 0 ? leafs : Array.from(all).filter(i => !i.closest('nav,header,footer,aside'));
    };

    const getItemTexts = (item, maxLen = 500) => {
      const allSpans = Array.from(item.querySelectorAll('span[aria-hidden="true"]')).filter(s => {
        if (s.closest('button')) return false;
        let el = s.parentElement;
        while (el && el !== item) {
          if (el.matches && el.matches('li,.pvs-entity,[data-view-name*="profile-component-entity"],.artdeco-list__item')) return false;
          el = el.parentElement;
        }
        return true;
      });
      const leafSpans = allSpans.filter(s => s.children.length === 0);
      const useSpans = leafSpans.length > 0 ? leafSpans : allSpans;
      const seen = new Set();
      return useSpans.map(s => normalize(s.textContent))
        .filter(t => t.length > 0 && t.length < maxLen)
        .filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .filter(t => !isUiNoise(t));
    };

    const itemSelectors = 'li,.pvs-entity,[data-view-name*="profile-component-entity"],.artdeco-list__item';

    if (SECTION === 'skills') {
      const seen = new Set();
      const looksLikeOrgName = t => /\b(université|university|universidad|universität|università|universidade|school|école|institut|institute|college|académie|academy|faculté|faculty|polytechnique|polydisciplinaire)\b/i.test(t)
        || /^\d+\s*(endorsement|recommandation)s?$/i.test(t);
      // SDUI: componentkey-based skill entries
      const sduiSkills = [...root.querySelectorAll('div[componentkey^="com.linkedin.sdui.profile.skill("]')];
      if (sduiSkills.length > 0) {
        for (const entry of sduiSkills) {
          // Each skill entry div may contain multiple <p> tags: the skill name
          // itself, plus the endorsement count or the school/company that
          // associated the skill (e.g. "Université Ibn Zohr - Faculté ...").
          // Pick the first <p> that doesn't look like an org name / endorsement count.
          const ps = [...entry.querySelectorAll('p')].map(p => normalize(p.textContent)).filter(Boolean);
          const t = ps.find(p => !looksLikeOrgName(p)) || '';
          if (!t || t.length < 2 || t.length > 80 || isUiNoise(t) || /\d{4}|endorsed|see more|show all/i.test(t)) continue;
          if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); items.push(t); }
          if (items.length >= 50) break;
        }
      }
      // Fallback: bold spans
      for (const item of items.length > 0 ? [] : root.querySelectorAll(itemSelectors)) {
        if (item.closest('nav,header,footer,aside,[role="navigation"]')) continue;
        const nameSpan = item.querySelector('.t-bold span[aria-hidden="true"],[class*="t-bold"] span[aria-hidden="true"],span[aria-hidden="true"]:not(button span)');
        if (!nameSpan) continue;
        const t = getSpanText(nameSpan);
        if (!t || t.length < 2 || t.length > 80 || isUiNoise(t)) continue;
        if (/\d{4}|endorsed|see more|show all|no expiration|credential|and \+\d+ skills?/i.test(t)) continue;
        if (/^\d+$/.test(t) || /^(industry knowledge|tools|interpersonal|other skills)/i.test(t)) continue;
        if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); items.push(t); }
        if (items.length >= 50) break;
      }
      // Last resort: all visible spans
      if (items.length === 0) {
        // On the /details/skills/ page, each skill is followed by either an
        // endorsement count ("1 endorsement") or the school/company name that
        // associated that skill (e.g. "Université Ibn Zohr - Faculté ..."). Only
        // the skill name itself should be kept — filter out institution/company lines.
        for (const span of root.querySelectorAll('span[aria-hidden="true"]')) {
          if (span.closest('nav,header,footer,aside,button,[role="navigation"]')) continue;
          const t = getSpanText(span);
          if (!t || t.length < 2 || t.length > 60 || isUiNoise(t)) continue;
          if (/\d{4}|endorsed|see more|show all|no expiration|and \+\d+ skills?/i.test(t)) continue;
          if (/^\d+$/.test(t) || /^(industry knowledge|tools|interpersonal|other skills)/i.test(t)) continue;
          if (looksLikeOrgName(t)) continue;
          if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); items.push(t); }
          if (items.length >= 50) break;
        }
      }
    } else if (SECTION === 'experience') {
      // ── Strategy 0: SDUI componentkey entries (2025+ LinkedIn, other people's profiles) ─
      // On detail pages for other people, LinkedIn renders componentkey divs, not edit links.
      const sduiExpEntries = [...root.querySelectorAll('div[componentkey*="experience"], div[componentkey*="Experience"]')];
      if (sduiExpEntries.length > 0) {
        console.log('[ExpDetail] SDUI componentkey entries:', sduiExpEntries.length);
        for (const entry of sduiExpEntries) {
          const ps = [...entry.querySelectorAll('p, span[aria-hidden="true"]')]
            .map(el => normalize(el.textContent))
            .filter(t => t.length > 1 && t.length < 300 && !isUiNoise(t));
          if (ps.length === 0) continue;
          const item = { title: '', company: '', dates: '', duration: '', location: '', employmentType: '', description: '' };
          for (const t of ps) {
            if (/^\d+\s*(yr|mo|an|mois)/i.test(t)) { item.duration = t; continue; }
            if (/\d{4}\s*[-–—]/.test(t) || (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|présent|present|actuel)\b/i.test(t) && t.length < 60)) { if (!item.dates) { item.dates = t; continue; } }
            if (/^(Remote|On-site|Hybrid|Internship|Full-time|Part-time|Contract|Freelance|Self-employed|Apprenticeship|Seasonal|Temporary)$/i.test(t)) { item.employmentType = t; continue; }
            if (!item.title) { item.title = t; continue; }
            if (!item.company) { item.company = t.replace(/\s*·.*$/, '').trim(); continue; }
            if (!item.location && t.length < 80 && (t.includes(',') || /\b(remote|on-site|hybrid|area|region|city)\b/i.test(t))) { item.location = t; continue; }
            if (t.length > 60 && !item.description) { item.description = t; continue; }
          }
          if (item.title || item.company) {
            const key = (item.title + item.company).toLowerCase();
            if (!items.some(e => (e.title + e.company).toLowerCase() === key)) items.push(item);
          }
          if (items.length >= 15) break;
        }
        console.log('[ExpDetail] SDUI items found:', items.length);
      }
      // ── Strategy 1: Generic li/pvs-entity fallback ───────────────────────────
      if (items.length === 0) {
      for (const item of getLeafItems(root, itemSelectors)) {
        const texts = getItemTexts(item, 1000);
        if (texts.length === 0) continue;
        const entry = { title: '', company: '', dates: '', duration: '', location: '', employmentType: '', description: '' };
        const boldSpan = item.querySelector('.t-bold span[aria-hidden="true"],[class*="t-bold"] span[aria-hidden="true"], span[aria-hidden="true"]');
        if (boldSpan) entry.title = normalize(boldSpan.textContent);
        for (const t of texts) {
          if (entry.title && t === entry.title) continue;
          if (/and \+\d+ skills?/i.test(t)) continue;
          if (/^\d+\s*(yr|mo|an|mois)/i.test(t)) { entry.duration = t; continue; }
          if (/\d{4}\s*[-–—]/.test(t) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|présent|present|actuel)\b/i.test(t) && t.length < 60) { if (!entry.dates) { entry.dates = t; continue; } }
          if (/^(Remote|On-site|Hybrid|Internship|Full-time|Part-time|Contract|Freelance|Self-employed|Apprenticeship|Seasonal|Temporary)$/i.test(t)) { entry.employmentType = t; continue; }
          if (t.length > 60 && entry.title && !entry.description) { entry.description = t; continue; }
          if (!entry.title) { entry.title = t; continue; }
          if (!entry.company) { entry.company = t.replace(/\s*·.*$/, '').trim(); continue; }
          if (!entry.location && t.length < 80 && !entry.description && (t.includes(',') || /\b(remote|on-site|hybrid|area|region|city)\b/i.test(t))) { entry.location = t; continue; }
        }
        if (!entry.company) {
          const parentLi = item.parentElement?.closest('li');
          if (parentLi) {
            const ps = parentLi.querySelector(':scope > div span[aria-hidden="true"]');
            if (ps && ps.children.length === 0) { const pt = normalize(ps.textContent); if (pt && pt.length > 1 && pt.length < 80 && !isUiNoise(pt)) entry.company = pt; }
          }
        }
        if (entry.title || entry.company) {
          const key = (entry.title + entry.company).toLowerCase();
          if (!items.some(e => (e.title + e.company).toLowerCase() === key)) items.push(entry);
        }
        if (items.length >= 15) break;
      }
      } // end strategy 1 fallback
    } else if (SECTION === 'education') {
      // ── Strategy 0: SDUI edit links (own profile, 2025+ layout) ─────────────
      const eduEditLinks = [...root.querySelectorAll('a[href*="/details/education/edit/forms/"]')];
      for (const link of eduEditLinks) {
        try {
          const ps = [...link.querySelectorAll('p')]
            .map(p => normalize(p.textContent))
            .filter(t => t.length > 1 && !isUiNoise(t));
          const school = ps.find(t => !/\d{4}/.test(t)) || '';
          const datesRaw = ps.find(t => /\d{4}/.test(t)) || '';
          const nonSchoolNonDate = ps.filter(t => t !== school && !/\d{4}/.test(t));
          const degreeRaw = nonSchoolNonDate[0] || '';
          const commaIdx = degreeRaw.indexOf(',');
          const degree = commaIdx > 0 ? degreeRaw.slice(0, commaIdx).trim() : degreeRaw;
          const fieldOfStudy = commaIdx > 0 ? degreeRaw.slice(commaIdx + 1).trim() : (nonSchoolNonDate[1] || '');
          if (school && !isUiNoise(school)) {
            const key = (school + '|' + degree).toLowerCase();
            if (!items.some(e => (e.school + '|' + e.degree).toLowerCase() === key)) {
              items.push({ school, degree, fieldOfStudy, dates: datesRaw });
            }
          }
        } catch(e) { /* skip */ }
        if (items.length >= 8) break;
      }
      // ── Strategy 0b: if exactly one edit link was found but the education
      // section visibly contains multiple school entries, try to also pick up
      // the remaining entries via componentkey/li without discarding what we have.
      if (items.length === 1 && eduEditLinks.length <= 1) {
        const sectionLis = [...root.querySelectorAll('li[data-view-name*="education"], li[data-view-name*="profile-component-entity"]')];
        if (sectionLis.length > 1) {
          for (const li of sectionLis) {
            const ps = [...li.querySelectorAll('p')]
              .map(p => normalize(p.textContent))
              .filter(t => t.length > 1 && !isUiNoise(t) && !/^skills?:/i.test(t));
            const school = ps.find(t => !/\d{4}/.test(t)) || '';
            if (!school || isUiNoise(school)) continue;
            const datesRaw = ps.find(t => /\d{4}/.test(t)) || '';
            const nonSchoolNonDate = ps.filter(t => t !== school && !/\d{4}/.test(t));
            const degreeRaw = nonSchoolNonDate[0] || '';
            const commaIdx = degreeRaw.indexOf(',');
            const degree = commaIdx > 0 ? degreeRaw.slice(0, commaIdx).trim() : degreeRaw;
            const fieldOfStudy = commaIdx > 0 ? degreeRaw.slice(commaIdx + 1).trim() : (nonSchoolNonDate[1] || '');
            const key = (school + '|' + degree).toLowerCase();
            if (!items.some(e => (e.school + '|' + e.degree).toLowerCase() === key)) {
              items.push({ school, degree, fieldOfStudy, dates: datesRaw });
            }
            if (items.length >= 8) break;
          }
        }
      }
      // ── Strategy 1: SDUI componentkey entries (works for other people's profiles) ───
      if (items.length === 0) {
        // Try broader selectors — LinkedIn uses both 'education' and 'Education' in componentkey.
        // IMPORTANT: a componentkey div may be a CONTAINER wrapping multiple entry divs
        // (e.g. the whole education list), which would merge all schools into one item.
        // Prefer <li> entries (one per school) when present; otherwise use only LEAF
        // componentkey divs (those that don't themselves contain nested componentkey
        // education divs).
        let sduiEdu = [...root.querySelectorAll('li[data-view-name*="education"], li[data-view-name*="profile-component-entity"]')];
        if (sduiEdu.length === 0) {
          const allCk = [...root.querySelectorAll('div[componentkey*="education"], div[componentkey*="Education"]')];
          sduiEdu = allCk.filter(d => !d.querySelector('div[componentkey*="education"], div[componentkey*="Education"]'));
          if (sduiEdu.length === 0) sduiEdu = allCk; // last resort
        }
        for (const entry of sduiEdu) {
          const ps = [...entry.querySelectorAll('p')]
            .map(p => normalize(p.textContent))
            .filter(t => t.length > 1 && !isUiNoise(t) && !/^skills?:/i.test(t));
          const school = ps.find(t => !/\d{4}/.test(t)) || '';
          const datesRaw = ps.find(t => /\d{4}/.test(t)) || '';
          const nonSchoolNonDate = ps.filter(t => t !== school && !/\d{4}/.test(t));
          const degreeRaw = nonSchoolNonDate[0] || '';
          const commaIdx = degreeRaw.indexOf(',');
          const degree = commaIdx > 0 ? degreeRaw.slice(0, commaIdx).trim() : degreeRaw;
          const fieldOfStudy = commaIdx > 0 ? degreeRaw.slice(commaIdx + 1).trim() : (nonSchoolNonDate[1] || '');
          if (school && !isUiNoise(school)) {
            const key = (school + '|' + degree).toLowerCase();
            if (!items.some(e => (e.school + '|' + e.degree).toLowerCase() === key))
              items.push({ school, degree, fieldOfStudy, dates: datesRaw });
          }
          if (items.length >= 8) break;
        }
      }
      // ── Strategy 2: Generic li fallback ──────────────────────────────────────
      if (items.length === 0) {
        for (const item of getLeafItems(root, itemSelectors)) {
          const texts = getItemTexts(item, 300);
          if (texts.length === 0) continue;
          const dateTexts = texts.filter(t => /\d{4}/.test(t) && t.length < 40);
          const nonDate = texts.filter(t => !/^\d{4}[\s–\-]/.test(t) && !/^\d{4}$/.test(t) && (!/\d{4}/.test(t) || t.length >= 40));
          const school = nonDate[0] || '';
          const degreeRaw = nonDate[1] || '';
          const commaIdx = degreeRaw.indexOf(',');
          const degree = commaIdx > 0 ? degreeRaw.slice(0, commaIdx).trim() : degreeRaw;
          const fieldOfStudy = commaIdx > 0 ? degreeRaw.slice(commaIdx + 1).trim() : (nonDate[2] || '');
          if (school && !isUiNoise(school) && !/^\d{4}/.test(school)) {
            const key = (school + '|' + degree).toLowerCase();
            if (!items.some(e => (e.school + '|' + e.degree).toLowerCase() === key))
              items.push({ school, degree, fieldOfStudy, dates: dateTexts[0] || '' });
          }
          if (items.length >= 8) break;
        }
      }
    } else if (SECTION === 'certifications') {
      const isCertNoise = t => {
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
      // Top-level DOM snapshot for debugging
      console.log('[CertDebug] href:', window.location.href);
      console.log('[CertDebug] edit links found:', root.querySelectorAll('a[href*="/details/certifications/edit/forms/"], a[href*="/details/licenses/edit/forms/"]').length);
      console.log('[CertDebug] componentkey cert divs:', root.querySelectorAll('div[componentkey*="cert"], div[componentkey*="Cert"], div[componentkey*="licen"], div[componentkey*="Licen"]').length);
      console.log('[CertDebug] all li count:', root.querySelectorAll('li').length);
      // Log first 3 bold spans to see what text is on the page
      const boldTexts = [...root.querySelectorAll('.t-bold span[aria-hidden="true"], [class*="t-bold"] span[aria-hidden="true"]')].slice(0, 6).map(s => s.textContent.trim());
      console.log('[CertDebug] bold spans:', JSON.stringify(boldTexts));
      // Log all aria-hidden spans (first 10)
      const allSpanTexts = [...root.querySelectorAll('span[aria-hidden="true"]')].slice(0, 10).map(s => s.textContent.trim()).filter(t => t.length > 1);
      console.log('[CertDebug] first spans:', JSON.stringify(allSpanTexts));

      // ── Strategy 0: SDUI edit links (own profile) ────────────────────────────
      // Section header keywords to skip (p[0] on detail page is often the section title)
      // Match "Licenses & certifications", "Licences et certifications", etc.
      const isSectionHeader = t => /licen|certif/i.test(t) && t.length < 50;
      const certEditLinks = [...root.querySelectorAll(
        'a[href*="/details/certifications/edit/forms/"], a[href*="/details/licenses/edit/forms/"]')];
      for (const link of certEditLinks) {
        try {
          const rawPs = [...link.querySelectorAll('p')].map(p => normalize(p.textContent));
          console.log('[CertDebug] raw p texts:', JSON.stringify(rawPs));
          const ps = rawPs.filter(t => t.length > 1 && !isCertNoise(t) && !isSectionHeader(t));
          console.log('[CertDebug] filtered ps:', JSON.stringify(ps));
          // ps[0] = cert name, ps[1] = issuer, ps[2] = "Issued MMM YYYY"
          const certName = ps.find(t => !/^\d{4}/.test(t) && !/\bIssued\b/i.test(t)) || '';
          const issuer   = ps.find((t, i) => i > 0 && t !== certName && !/^\d{4}/.test(t) && !/\bIssued\b/i.test(t)) || '';
          const dateStr  = ps.find(t => /\d{4}/.test(t) || /\bIssued\b/i.test(t)) || '';
          if (certName && !isCertNoise(certName) && !isSectionHeader(certName)) {
            const key = certName.toLowerCase();
            if (!items.some(e => e.name.toLowerCase() === key)) {
              console.log('[CertDebug] Strategy0 push:', JSON.stringify({certName, issuer, dateStr}));
              items.push({ name: certName, issuer, date: dateStr });
            }
          }
        } catch(e) { /* skip */ }
        if (items.length >= 30) break;
      }
      // ── Strategy 1: SDUI componentkey entries (cert detail page layout) ────────
      if (items.length === 0) {
        // Debug: log all componentkeys on page to help diagnose selector mismatches
        const allKeys = [...document.querySelectorAll('div[componentkey]')].map(d => d.getAttribute('componentkey')).filter(k => /cert|licen/i.test(k));
        if (allKeys.length > 0) console.log('[LinkedIn AI] Cert componentkeys found:', allKeys.slice(0, 5));
        const sduiCerts = [...root.querySelectorAll(
          'div[componentkey*="cert"], div[componentkey*="Cert"], div[componentkey*="licen"], div[componentkey*="Licen"]')];
        for (const entry of sduiCerts) {
          const ps = [...entry.querySelectorAll('p')]
            .map(p => normalize(p.textContent))
            .filter(t => t.length > 1 && !isCertNoise(t));
          const certName = ps.find(t => !/^\d{4}/.test(t) && !/\bIssued\b/i.test(t)) || '';
          const issuer   = ps.find((t, i) => i > 0 && t !== certName && !/^\d{4}/.test(t) && !/\bIssued\b/i.test(t)) || '';
          const dateStr  = ps.find(t => /\d{4}/.test(t) || /\bIssued\b/i.test(t)) || '';
          if (certName && !isCertNoise(certName)) {
            const key = certName.toLowerCase();
            if (!items.some(e => e.name.toLowerCase() === key)) {
              console.log('[CertDebug] Strategy1 push:', JSON.stringify({certName, issuer, dateStr}));
              items.push({ name: certName, issuer, date: dateStr });
            }
          }
          if (items.length >= 30) break;
        }
      }
      // ── Strategy 2: Bold-span heuristic (cert detail page, any layout) ────────
      if (items.length === 0) {
        // On the cert detail page, each cert card has a bold title span, then issuer + date spans
        const seen = new Set();
        for (const item of getLeafItems(root, itemSelectors)) {
          const texts = getItemTexts(item, 300).filter(t => !isCertNoise(t) && !isSectionHeader(t) && !/^(licenses?|licences?|certifications?)(\s*(&|and|et)\s*(licenses?|licences?|certifications?))?$/i.test(t));
          if (texts.length === 0) continue;
          const certName = texts[0];
          const issuer = texts.find((t, i) => i > 0 && !/^\d{4}/.test(t) && !/^issued|^expires|^no expiration/i.test(t) && !/^credential/i.test(t) && t.length > 1) || '';
          const dateStr = texts.find(t => /\b(issued?|expires?|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t) || /\d{4}/.test(t)) || '';
          if (certName && !isCertNoise(certName) && !isSectionHeader(certName)) {
            const key = certName.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              console.log('[CertDebug] Strategy2 push:', JSON.stringify({certName, issuer, dateStr}));
              items.push({ name: certName, issuer, date: dateStr });
            }
          }
          if (items.length >= 30) break;
        }
      }
      // ── Strategy 3: All bold spans on page (last resort for cert detail page) ─
      if (items.length === 0) {
        const seen = new Set();
        const boldSpans = [...root.querySelectorAll('.t-bold span[aria-hidden="true"], [class*="t-bold"] span[aria-hidden="true"]')];
        for (const span of boldSpans) {
          if (span.closest('nav,header,footer,button')) continue;
          const certName = normalize(span.textContent);
          if (!certName || certName.length < 3 || certName.length > 150 || isCertNoise(certName) || isSectionHeader(certName)) continue;
          if (/^(licenses?|licences?|certifications?)(\s*(&|and|et)\s*(licenses?|licences?|certifications?))?$/i.test(certName)) continue;
          if (/^\d{4}/.test(certName) || /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(certName)) continue;
          if (seen.has(certName.toLowerCase())) continue;
          seen.add(certName.toLowerCase());
          // Look for issuer and date in sibling/nearby spans
          const card = span.closest('li, .pvs-entity, [data-view-name*="profile-component-entity"], [componentkey]') || span.parentElement;
          const siblingTexts = [...card.querySelectorAll('span[aria-hidden="true"]')]
            .map(s => normalize(s.textContent))
            .filter(t => t !== certName && t.length > 1 && !isCertNoise(t));
          const issuer  = siblingTexts.find(t => !/^\d{4}/.test(t) && !/\bIssued\b/i.test(t) && t !== certName) || '';
          const dateStr = siblingTexts.find(t => /\d{4}/.test(t) || /\bIssued\b/i.test(t)) || '';
          console.log('[CertDebug] Strategy3 push:', JSON.stringify({certName, issuer, dateStr}));
          items.push({ name: certName, issuer, date: dateStr });
          if (items.length >= 30) break;
        }
      }
    }

    return { section: SECTION, items, count: items.length };
  } catch (err) {
    return { section: SECTION, items: [], error: String(err) };
  }
}

// Navigate a tab to a URL and wait for full load (runs in popup context)
function navigateTabAndWait(tabId, url, timeoutMs = 20000) {
  return new Promise(async (resolve, reject) => {
    // Verify tab still exists before navigating
    try { await chrome.tabs.get(tabId); } catch { return reject(new Error('tab closed')); }
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); reject(new Error('nav timeout')); }, timeoutMs);
    function fn(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(fn);
        clearTimeout(timer);
        // Smart DOM-ready poll: check for actual text content instead of fixed 3500ms wait.
        // Polls every 200ms, exits as soon as content is detected, caps at 2500ms.
        let pollCount = 0;
        const MAX_POLLS = 12; // 12 × 200ms = 2400ms max
        const poll = () => {
          chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const main = document.querySelector('main, [role="main"]') || document.body;
              const spans = main.querySelectorAll('span[aria-hidden="true"]');
              let textCount = 0;
              for (const s of spans) { if ((s.textContent || '').trim().length > 3) textCount++; }
              return textCount;
            },
          }).then(res => {
            const textCount = res?.[0]?.result ?? 0;
            pollCount++;
            if (textCount > 5 || pollCount >= MAX_POLLS) {
              resolve();
            } else {
              setTimeout(poll, 200);
            }
          }).catch(() => {
            // Script injection failed (authwall, etc.) — resolve after short pause
            setTimeout(resolve, 400);
          });
        };
        // Brief initial pause for SPA router to kick off, then start polling
        setTimeout(poll, 300);
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.update(tabId, { url }).catch(err => {
      chrome.tabs.onUpdated.removeListener(fn);
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Helper: enrich scraped profile with detail page data
// Navigation is controlled from here (popup context) using chrome.tabs.update,
// NOT from inside the injected script. This prevents script-context destruction.
async function enrichWithDetailPages(tabId, profileData, options = {}) {
  const isLikelyUiNoise = (raw) => {
    const t = (raw || '').toString().trim().toLowerCase();
    if (!t) return true;
    if (/^(show all|see all|show more|see more|more|followers?|connections?|contact info|activity|recommendations?|endorsed by)$/i.test(t)) return true;
    if (/^\d{1,3}$/.test(t)) return true;
    return false;
  };

  const countValidItems = (section, arr) => {
    const list = Array.isArray(arr) ? arr : [];
    if (list.length === 0) return 0;

    if (section === 'skills') {
      return list.filter(s => {
        if (typeof s !== 'string') return false;
        const t = s.trim();
        if (t.length < 2 || t.length > 80) return false;
        if (isLikelyUiNoise(t)) return false;
        if (/\d{4}|show all|see all|endors/i.test(t)) return false;
        return true;
      }).length;
    }

    if (section === 'experience') {
      return list.filter(e => {
        if (!e || typeof e !== 'object') return false;
        const title = (e.title || '').trim();
        const company = (e.company || '').trim();
        if (!title && !company) return false;
        if (isLikelyUiNoise(title) || isLikelyUiNoise(company)) return false;
        // Reject feed-post garbage: no company+dates with long title, or noise signals
        if (!company && !e.dates && title.length > 60) return false;
        if (/reacted|reposted|commented|and \d+ others|lnkd\.in|https?:\/\//i.test(
          title + ' ' + company + ' ' + (e.description || ''))) return false;
        return true;
      }).length;
    }

    if (section === 'education') {
      return list.filter(e => {
        if (!e || typeof e !== 'object') return false;
        const school = (e.school || '').trim();
        if (!school) return false;
        if (isLikelyUiNoise(school)) return false;
        if (/^\d{4}/.test(school)) return false;
        return true;
      }).length;
    }

    if (section === 'certifications') {
      return list.filter(e => {
        if (!e || typeof e !== 'object') return false;
        const name = (e.name || '').trim();
        if (!name) return false;
        if (isLikelyUiNoise(name)) return false;
        return true;
      }).length;
    }

    return list.length;
  };

  // Build the list of sections to fetch from detail pages
  const sections = new Set();

  const hasExplicitSections = Array.isArray(options.sections) && options.sections.length > 0;
  if (hasExplicitSections) {
    for (const s of options.sections) sections.add(s);
  } else {
    // Sections explicitly marked by inline scraper (had "Show all" <a> links)
    const markedSections = profileData._debug?._sectionsNeedingDetailPage || [];
    for (const s of markedSections) sections.add(s);
  }

  if (sections.size === 0) return profileData;

  // Get profile slug for URL construction
  const slug = profileData._url?.match(/\/in\/([^/?#]+)/)?.[1] || profileData.url_slug;
  if (!slug) {
    console.warn('[LinkedIn AI] Cannot enrich: no profile slug found');
    return profileData;
  }

  // Verify tab still exists before starting
  let tabInfo;
  try { tabInfo = await chrome.tabs.get(tabId); } catch {
    console.warn('[LinkedIn AI] Cannot enrich: tab no longer exists');
    return profileData;
  }
  const originalUrl = tabInfo.url;

  // Helper: update extracting status label in popup
  const setStatus = (msg) => {
    try { const el = document.getElementById('homeExtractText'); if (el) el.textContent = msg; } catch (_) {}
  };
  const sectionLabels = { skills: 'Skills', experience: 'Experience', education: 'Education', certifications: 'Certifications', languages: 'Languages', volunteer: 'Volunteer', projects: 'Projects' };
  const _total = sections.size;
  let _done = 0;

  for (const section of sections) {
    // Re-check tab exists before each navigation (user may close it mid-enrichment)
    try { await chrome.tabs.get(tabId); } catch {
      console.warn('[LinkedIn AI] Tab closed during enrichment, stopping');
      break;
    }

    _done++;
    setStatus(`${window._t('statusExtracting')} ${sectionLabels[section] || section}… (${_done}/${_total})`);

    const detailUrl = `https://www.linkedin.com/in/${slug}/details/${section}/`;
    let result = null;
    let lastReason = '';

    try {
      // Navigate ONCE to the detail page
      await navigateTabAndWait(tabId, detailUrl);

      // First scrape attempt
      let res = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrapeDetailPageContent,
        args: [section],
      });
      result = res?.[0]?.result;

      // If empty, wait briefly and re-scrape IN PLACE (no re-navigation)
      if (!result?.items?.length) {
        const dbg = result?._debug;
        lastReason = result?.error || (dbg
          ? `no items (li=${dbg.liCount || 0}, spans=${dbg.spanCount || 0}, ready=${!!dbg.contentReady})`
          : 'no items');
        await new Promise(r => setTimeout(r, 600));
        res = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrapeDetailPageContent,
          args: [section],
        });
        result = res?.[0]?.result;
        if (!result?.items?.length) {
          lastReason = result?.error || lastReason;
        }
      }
    } catch (e) {
      lastReason = e?.message || String(e);
    }

    if (!result?.items?.length) {
      // Keep logs concise; failures here are expected on many profiles/layouts.
      console.log(`[LinkedIn AI] Detail ${section} skipped: ${lastReason || 'no items'}`);
    }

    // Replace inline data if detail page results are better quality
    if (result?.items?.length > 0) {
      const inlineItems = profileData[section] || [];
      let inlineCount = inlineItems.length;
      let inlineValid = countValidItems(section, inlineItems);
      const detailValid = countValidItems(section, result.items);
      const detailRatio = result.items.length > 0 ? (detailValid / result.items.length) : 0;
      const minRatio = section === 'skills' ? 0.45 : 0.6;
      console.log(`[LinkedIn AI] Detail ${section}: ${result.items.length} items (inline had ${inlineCount})`);

      // Detect if inline data is garbage, and if so whether it's a few bad
      // entries mixed with good ones (filter them out) or the whole set is bad
      // (replace wholesale with detail page data).
      const isBadExpItem = (e) =>
        (!e.company && !e.dates && (e.title || '').length > 60) ||
        /reacted|reposted|commented|and \d+ others/i.test(
          (e.title || '') + ' ' + (e.description || '') + ' ' + (e.company || '')
        ) ||
        /https?:\/\/|lnkd\.in/i.test((e.title || '') + ' ' + (e.company || ''));

      const isBadEduItem = (e) => !e.school || (!e.degree && !e.fieldOfStudy);

      let inlineIsGarbage = false;
      if (section === 'certifications') {
        inlineIsGarbage = inlineItems.some(c =>
          /^view\s+analytics$/i.test(c.issuer || '') ||
          /and\s+\d+\s+others?$/i.test(c.name || '') ||
          /^view\s+analytics$/i.test(c.name || '')
        );
      } else if (section === 'experience') {
        const badCount = inlineItems.filter(isBadExpItem).length;
        // If only a minority of items are bad, just strip them from inline
        // instead of throwing away the whole (likely larger/better) inline set.
        if (badCount > 0 && badCount < inlineItems.length) {
          profileData[section] = inlineItems.filter(e => !isBadExpItem(e));
          // Recompute inline counts after cleanup
          inlineValid = countValidItems(section, profileData[section]);
          inlineCount = profileData[section].length;
        } else if (badCount > 0 && badCount === inlineItems.length) {
          inlineIsGarbage = true;
        }
      } else if (section === 'education') {
        const badCount = inlineItems.filter(isBadEduItem).length;
        if (badCount > 0 && badCount < inlineItems.length) {
          profileData[section] = inlineItems.filter(e => !isBadEduItem(e));
          inlineValid = countValidItems(section, profileData[section]);
          inlineCount = profileData[section].length;
        } else if (badCount > 0 && badCount === inlineItems.length) {
          inlineIsGarbage = true;
        }
      }

      // Quality gate: replace inline if detail data is valid.
      // If inline is confirmed garbage (feed posts, no company/dates), ALWAYS take detail.
      // Otherwise: take detail if it has at least as many valid items as inline.
      console.log(`[GapEnrich] ${section}: detail=${result.items.length} detailValid=${detailValid} detailRatio=${detailRatio.toFixed(2)} | inline=${inlineCount} inlineValid=${inlineValid} | isGarbage=${inlineIsGarbage}`);
      const passesGate = inlineIsGarbage
        ? (detailValid > 0)
        : (detailValid >= inlineValid && detailRatio >= minRatio);

      if (passesGate) {
        if (inlineIsGarbage) console.log(`[LinkedIn AI] Replacing garbage inline ${section} with detail data`);
        profileData[section] = result.items;
        if (section === 'skills' && profileData._scrapeQuality) {
          profileData._scrapeQuality.skillsFromDetailPage = true;
          profileData._scrapeQuality.skillsCount = result.items.length;
        }
      } else {
        console.log(`[LinkedIn AI] Keeping inline ${section} due to quality gate (detail valid ${detailValid}/${result.items.length}, inline valid ${inlineValid}/${inlineCount})`);
      }
    }
  }

  // Navigate back to the original profile page so user lands where they started.
  // Gap analysis sets skipReturnNav=true — the user stays in the popup either way,
  // and skipping this saves 2-4s per gap analysis.
  if (!options.skipReturnNav) {
    setStatus('Finishing…');
    try {
      await navigateTabAndWait(tabId, originalUrl);
    } catch (_) { /* best-effort */ }
  }

  setStatus('✓ Extraction complete!');
  return profileData;
}

// ══════════════════════════════════════
//  SCRAPE PROFILE — 3-layer fallback
// ══════════════════════════════════════

// Validate scrape result — returns array of issue strings (empty = valid)
function validateScrape(data) {
  const issues = [];
  if (!data || data._error) return ['scrape_error'];
  if (!data.name) issues.push('no_name');
  if (data._debug?.expSecFound && data.experience?.length === 0) issues.push('exp_empty');
  if (data._debug?.eduSecFound && data.education?.length === 0) issues.push('edu_empty');
  if (data._debug?.skillsSecFound && data.skills?.length === 0) issues.push('skills_empty');
  const needsDetail = data._debug?._sectionsNeedingDetailPage || [];
  if (needsDetail.includes('skills') && (data.skills?.length || 0) <= 3) issues.push('skills_truncated');
  if (needsDetail.includes('experience') && (data.experience?.length || 0) <= 2) issues.push('exp_truncated');
  if (data._debug?.aboutSecFound && (data.about || '').length < 20) issues.push('about_truncated');
  return issues;
}

// Merge two scrape results — take the richer data for each field, deduplicating arrays
function mergeScrapeResults(primary, retry) {
  if (!retry || retry._error) return primary;

  // Deduplicate array by generating a signature for each item
  const dedup = (arr) => {
    if (!arr || arr.length === 0) return arr;
    const seen = new Set();
    return arr.filter(item => {
      // For objects (experience/education entries), use title+company or school as key
      const sig = typeof item === 'string' ? item.toLowerCase().trim()
        : [item.title, item.company, item.school, item.degree, item.name].filter(Boolean).join('|').toLowerCase().trim();
      if (!sig || seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  };

  // Take the richer (longer, deduplicated) array for each section
  const mergeArray = (field) => {
    const pArr = dedup(primary[field] || []);
    const rArr = dedup(retry[field] || []);
    primary[field] = rArr.length > pArr.length ? rArr : pArr;
  };
  mergeArray('experience');
  mergeArray('education');
  mergeArray('skills');
  mergeArray('certifications');
  mergeArray('languages');
  mergeArray('volunteer');
  mergeArray('projects');
  mergeArray('honors');
  mergeArray('publications');
  mergeArray('organizations');
  mergeArray('courses');
  mergeArray('recommendations');

  if ((retry.about || '').length > (primary.about || '').length) primary.about = retry.about;
  if (!primary.name && retry.name) primary.name = retry.name;
  if (!primary.headline && retry.headline) primary.headline = retry.headline;
  if (!primary.location && retry.location) primary.location = retry.location;
  return primary;
}

// ══════════════════════════════════════
//  EXTRACTION WARNING MODAL
// ══════════════════════════════════════
function showExtractionWarning() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('extractWarningOverlay');
    if (!overlay) { resolve(true); return; }
    overlay.style.display = 'flex';
    const startBtn = document.getElementById('ewmStartBtn');
    const cancelBtn = document.getElementById('ewmCancelBtn');
    function cleanup() {
      overlay.style.display = 'none';
      startBtn.removeEventListener('click', onStart);
      cancelBtn.removeEventListener('click', onCancel);
    }
    function onStart() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    startBtn.addEventListener('click', onStart);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Called on popup open — only auto-scrapes the user's OWN profile,
// and only if we haven't saved it yet. Otherwise shows saved profile.
async function scrapeProfile() {
  const stored = await chrome.storage.local.get(['consentGiven', 'myProfile']);
  if (!stored?.consentGiven) { showState('consent'); return; }

  // If we already have a saved profile (from DB or previous scrape), just display it
  if (profile && (profile.name || profile.headline)) {
    showProfileCard(profile);
    return;
  }
  if (stored.myProfile && (stored.myProfile.name || stored.myProfile.headline)) {
    profile = stored.myProfile;
    showProfileCard(profile);
    return;
  }

  // No saved profile yet — check if we're on the user's own LinkedIn profile
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.url || !/linkedin\.com\/in\//.test(tab.url)) {
    // Not on a profile page; show helpful guidance
    _showNoProfileGuidance();
    return;
  }

  // 24-hour debounce: if the cached profile was scraped from this same URL slug
  // within the last 24 hours, skip the inline scrape and use the cached version.
  if (stored.myProfile && stored.myProfile.scrapedAt && stored.myProfile.url_slug) {
    const tabSlug = tab.url.match(/\/in\/([^/?#]+)/)?.[1];
    const cachedSlug = stored.myProfile.url_slug;
    const ageMs = Date.now() - new Date(stored.myProfile.scrapedAt).getTime();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    if (tabSlug && tabSlug === cachedSlug && ageMs < TWENTY_FOUR_HOURS) {
      profile = stored.myProfile;
      showProfileCard(profile);
      return;
    }
  }

  // We're on a LinkedIn profile page — extract to check if it's the user's own
  showState('loading');
  showExtractingStatus();
  let uiResolved = false;
  const resolveUI = (fn) => { if (!uiResolved) { uiResolved = true; fn(); } };
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inlineScrapeFunction });
    const inlineData = res?.[0]?.result;

    if (inlineData && inlineData._error) {
      // Scrape threw an error — show cached profile if available
      console.warn('[LinkedIn AI] Auto-scrape error:', inlineData.message);
      const { myProfile: cached } = await chrome.storage.local.get('myProfile');
      if (cached && (cached.name || cached.headline)) resolveUI(() => { profile = cached; showProfileCard(profile); });
      else resolveUI(() => { showState('edit'); document.getElementById('pcSource').textContent = 'Auto-extraction failed. Click the refresh icon to retry.'; });
    } else if (inlineData && inlineData._isOwn && (inlineData.name || inlineData.headline)) {
      // This IS the user's own profile — show inline data immediately (fast path)
      profile = inlineData;
      await chrome.storage.local.set({ myProfile: profile });
      resolveUI(() => { showProfileCard(profile); }); // "finished" shown after skills enrichment

      // Background skills enrichment — always run, non-blocking.
      // Skills are capped at 5 inline (LinkedIn only shows top-5 by default).
      // Navigate to /details/skills/ to get the full list, then update the card.
      ;(async () => {
        try {
          const inlineSkillsCount = inlineData.skills?.length || 0;
          const skillsSecFound = inlineData._debug?.skillsSecFound;
          // Always enrich skills if section was found and we have fewer than 20
          if (skillsSecFound || inlineSkillsCount < 20) {
            _isEnriching = true;
            await enrichWithDetailPages(tab.id, inlineData, { sections: ['skills'] });
            profile = inlineData;
            await chrome.storage.local.set({ myProfile: profile });
            // Refresh the visible profile card with complete skills
            _isEnriching = false;
            showProfileCard(profile);
            showExtractionDone(profile);
          }
        } catch (e) { _isEnriching = false; console.warn('[LinkedIn AI] Auto-scrape skills enrichment failed:', e); }
        // Save to backend AFTER enrichment so Cosmos DB gets the complete skills list
        chrome.runtime
          .sendMessage({ action: 'saveProfileSnapshot', data: { profile: inlineData } })
          .catch(() => {});
        chrome.runtime
          .sendMessage({ action: 'saveMyProfile', data: { profile: inlineData } })
          .catch(() => {});
        // Post scrape quality telemetry (best-effort, never blocks)
        if (inlineData._scrapeQuality) {
          chrome.runtime
            .sendMessage({ action: 'logScrapeQuality', data: inlineData._scrapeQuality })
            .catch(() => {});
        }
      })();
      return; // backend saves happen inside the async IIFE above
    } else if (inlineData && !inlineData._isOwn && (inlineData.name || inlineData.headline)) {
      // Not the user's own profile — don't save, show cached or guidance
      const { myProfile: cached } = await chrome.storage.local.get('myProfile');
      if (cached && (cached.name || cached.headline)) resolveUI(() => { profile = cached; showProfileCard(profile); });
      else resolveUI(() => { _showNoProfileGuidance('This is not your profile. Visit YOUR LinkedIn profile to auto-extract.'); });
    } else {
      // No data returned — try cached profile
      const { myProfile: cached } = await chrome.storage.local.get('myProfile');
      if (cached && (cached.name || cached.headline)) resolveUI(() => { profile = cached; showProfileCard(profile); });
      else resolveUI(() => { _showNoProfileGuidance(); });
    }
  } catch (err) {
    console.warn('[LinkedIn AI] Auto-scrape exception:', err);
    const { myProfile: cached } = await chrome.storage.local.get('myProfile');
    if (cached && (cached.name || cached.headline)) resolveUI(() => { profile = cached; showProfileCard(profile); });
    else resolveUI(() => { _showNoProfileGuidance(); });
  } finally {
    // Guarantee UI is never stuck on loading spinner
    if (!uiResolved) {
      console.warn('[LinkedIn AI] UI was not resolved — forcing edit state');
      _showNoProfileGuidance();
    }
  }
}

// Manual re-extract triggered by refresh icon — always extracts and saves as own profile
async function manualRescrape() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.url || !/linkedin\.com\/in\//.test(tab.url)) {
    toast('Go to your LinkedIn profile (linkedin.com/in/you) then click re-extract.', 'warn');
    return;
  }

  const confirmed = await showExtractionWarning();
  if (!confirmed) return;

  showState('loading');
  showExtractingStatus();
  let uiResolved = false;
  const resolveUI = (fn) => { if (!uiResolved) { uiResolved = true; fn(); } };
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inlineScrapeFunction });
    const inlineData = res?.[0]?.result;

    if (inlineData && inlineData._error) {
      console.warn('[LinkedIn AI] Scrape error:', inlineData.message);
      const errMsg = inlineData.message || 'Unknown error';
      if (/permission|access|denied/i.test(errMsg)) {
        toast('Permission denied. Go to chrome://extensions, disable then re-enable this extension.', 'error', 8000);
      } else if (/cannot access|chrome:\/\/|extension:\/\//i.test(errMsg)) {
        toast('Cannot access this page. Make sure you are on a LinkedIn profile tab.', 'error', 6000);
      } else {
        toast('Extraction error: ' + errMsg + '. Try refreshing the LinkedIn page (Ctrl+R).', 'error', 6000);
      }
      resolveUI(() => { if (profile) showProfileCard(profile); else showState('edit'); });
    } else if (inlineData && (inlineData.name || inlineData.headline || inlineData.experience?.length > 0)) {
      // Show inline results immediately — then enrich in background
      profile = inlineData;
      await chrome.storage.local.set({ myProfile: profile });
      resolveUI(() => { showProfileCard(profile); }); // "finished" shown only after full enrichment

      // Background enrichment: detail pages + retry if needed (non-blocking)
      try {
        const issues = validateScrape(inlineData);
        const criticalIssues = issues.filter(i =>
          i === 'no_name' ||
          i === 'exp_empty' ||
          i === 'edu_empty' ||
          i === 'skills_empty' ||
          i === 'skills_truncated' ||
          i === 'exp_truncated'
        );

        const inlineSkillsCount = inlineData.skills?.length || 0;
        const shouldEnrichSkillsOnly = !!inlineData._debug?.skillsSecFound && inlineSkillsCount < 20;

        if (criticalIssues.length > 0) {
          console.log('[LinkedIn AI] Critical validation issues:', criticalIssues, '— retrying + selective enrichment...');
          try {
            await new Promise(r => setTimeout(r, 1500));
            const retryRes = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inlineScrapeFunction });
            const retryData = retryRes?.[0]?.result;
            if (retryData && !retryData._error) mergeScrapeResults(inlineData, retryData);
          } catch (e) { console.warn('[LinkedIn AI] Retry failed:', e); }

          _isEnriching = true;
          await enrichWithDetailPages(tab.id, inlineData);
          // Update with enriched data
          profile = inlineData;
          await chrome.storage.local.set({ myProfile: profile });
          _isEnriching = false;
          showProfileCard(profile);
          showExtractionDone(profile);
        } else if (shouldEnrichSkillsOnly) {
          console.log('[LinkedIn AI] Skills look incomplete — running skills-only enrichment');
          _isEnriching = true;
          await enrichWithDetailPages(tab.id, inlineData, { sections: ['skills'] });
          profile = inlineData;
          await chrome.storage.local.set({ myProfile: profile });
          _isEnriching = false;
          showProfileCard(profile);
          showExtractionDone(profile);
        } else {
          console.log('[LinkedIn AI] Fast path kept: inline extraction accepted without detail-page enrichment');
        }
      } catch (e) { _isEnriching = false; console.warn('[LinkedIn AI] Detail enrichment failed:', e); }
      // Save enriched profile to backend (after detail page enrichment is done)
      chrome.runtime
        .sendMessage({ action: 'saveProfileSnapshot', data: { profile: inlineData } })
        .catch(() => {});
      chrome.runtime
        .sendMessage({ action: 'saveMyProfile', data: { profile: inlineData } })
        .catch(() => {});
    } else {
      const dbg = inlineData?._debug ? JSON.stringify(inlineData._debug) : 'no data returned';
      console.warn('[LinkedIn AI] Empty scrape result:', dbg);
      toast('Could not extract profile data. Make sure LinkedIn is fully loaded and you are logged in, then re-extract.', 'error', 6000);
      resolveUI(() => { if (profile) showProfileCard(profile); else showState('edit'); });
    }
  } catch (err) {
    console.error('[LinkedIn AI] Scrape exception:', err);
    const excMsg = err?.message || 'Unknown error';
    if (/No tab with id|tab.* not found/i.test(excMsg)) {
      toast('The LinkedIn tab was closed. Open your LinkedIn profile and try again.', 'error', 6000);
    } else if (/Cannot access|cannot be scripted/i.test(excMsg)) {
      toast('Cannot access this tab. Make sure you are on linkedin.com (not a new tab or settings page).', 'error', 6000);
    } else {
      toast('Extraction failed: ' + excMsg + '. Try reloading the page or restarting the extension.', 'error', 6000);
    }
    resolveUI(() => { if (profile) showProfileCard(profile); else showState('edit'); });
  } finally {
    // Guarantee UI is never stuck on loading spinner
    if (!uiResolved) {
      console.warn('[LinkedIn AI] manualRescrape UI was not resolved — forcing recovery');
      if (profile) showProfileCard(profile); else showState('edit');
    }
  }
}


// ══════════════════════════════════════
//  PROFILE DISPLAY + MANUAL EDIT
// ══════════════════════════════════════

async function loadCacheOrManual() {
  const data = await chrome.storage.local.get('myProfile');
  if (data.myProfile?.name || data.myProfile?.headline) {
    profile = data.myProfile;
    showProfileCard(profile);
  } else {
    showState('edit');
  }
}

function showState(state) {
  document.getElementById('pcLoading').style.display  = state === 'loading'  ? 'flex' : 'none';
  document.getElementById('pcConsent').style.display  = state === 'consent'  ? 'flex' : 'none';
  document.getElementById('pcData').style.display     = state === 'data'     ? 'flex' : 'none';
  document.getElementById('pcEdit').style.display     = state === 'edit'     ? 'flex' : 'none';
}

function _timeAgo(isoStr) {
  try {
    const ms = Date.now() - new Date(isoStr).getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
    return Math.round(ms / 86400000) + 'd ago';
  } catch { return ''; }
}

function showProfileCard(data) {
  showState('data');
  const avatarEl = document.getElementById('pcAvatar');
  if (_isValidImageUrl(data.profilePhotoUrl)) {
    avatarEl.textContent = '';
    avatarEl.style.backgroundImage = `url('${data.profilePhotoUrl.replace(/'/g, "\\'")}')`;
    avatarEl.style.backgroundSize = 'cover';
    avatarEl.style.backgroundPosition = 'center';
  } else {
    avatarEl.style.backgroundImage = '';
    avatarEl.textContent = data.name ? data.name[0].toUpperCase() : '?';
  }
  document.getElementById('pcName').textContent = data.name || 'Unknown';
  document.getElementById('pcHeadline').textContent = data.headline || '—';

  const about = data.about || '';
  const aboutEl = document.getElementById('pcAbout');
  if (aboutEl) {
    aboutEl.textContent = about ? (about.length > 100 ? about.substring(0, 100) + '…' : about) : '—';
    aboutEl.title = about;
    document.getElementById('pcAboutRow').style.display = about ? '' : 'none';
  }

  const exp = data.experience || [];
  const expEl = document.getElementById('pcExp');
  if (exp.length > 0) {
    expEl.innerHTML = exp.map(e => {
      const title = e.title || '';
      const company = e.company ? ` at ${e.company}` : '';
      const dates = e.dates ? ` <span style="color:var(--tx3);font-size:11px">(${e.dates})</span>` : '';
      return `<div style="margin-bottom:2px">${title}${company}${dates}</div>`;
    }).join('');
  } else if (data.currentRole) {
    expEl.textContent = data.currentRole + (data.company ? ' at ' + data.company : '');
  } else {
    expEl.textContent = '—';
  }

  document.getElementById('pcLocation').textContent = data.location || '—';
  document.getElementById('pcLocationRow').style.display = data.location ? '' : 'none';

  const edu = data.education || [];
  const eduEl = document.getElementById('pcEdu');
  if (edu.length > 0) {
    eduEl.innerHTML = edu.map(e => {
      const school = e.school || '';
      const degree = e.degree ? ` — ${e.degree}` : '';
      const field = e.fieldOfStudy ? `, ${e.fieldOfStudy}` : '';
      const dates = e.dates ? ` <span style="color:var(--tx3);font-size:11px">(${e.dates})</span>` : '';
      return `<div style="margin-bottom:2px">${school}${degree}${field}${dates}</div>`;
    }).join('');
  } else {
    eduEl.textContent = '—';
  }
  document.getElementById('pcEduRow').style.display = edu.length > 0 ? '' : 'none';

  const skills = data.skills || [];
  const skillsEl = document.getElementById('pcSkills');
  if (skills.length > 0) {
    skillsEl.innerHTML = skills.map(s => `<span style="display:inline-block;background:var(--bg2);border:1px solid var(--bd);border-radius:10px;padding:1px 8px;margin:2px 2px;font-size:11px">${s}</span>`).join('');
  } else {
    skillsEl.textContent = '—';
  }
  document.getElementById('pcSkillsRow').style.display = skills.length > 0 ? '' : 'none';

  const src = document.getElementById('pcSource');
  if (data._source === 'manual') {
    src.textContent = 'Manual entry';
  } else if (data._partial) {
    src.innerHTML = 'Partial — <a href="https://www.linkedin.com/in/me" target="_blank" style="color:var(--ac)">open your profile</a> for full extraction';
  } else {
    const ago = data.scrapedAt ? _timeAgo(data.scrapedAt) : '';
    src.textContent = ago ? `Extracted ${ago}` : 'Your profile';
  }

  // Sync the home page hero
  updateHomeProfile(data);

  // Debug info
  const debugEl = document.getElementById('pcDebug');
  if (debugEl) debugEl.textContent = JSON.stringify(data, null, 2);
}

function initProfileCard() {
  const toggle = document.getElementById('pcToggle');
  const secondary = document.getElementById('pcSecondary');
  let expanded = false;
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    secondary.style.display = expanded ? 'flex' : 'none';
    toggle.textContent = expanded ? 'Show less ▴' : 'Read more ▾';
  });

  document.getElementById('pcRescrapeBtn').addEventListener('click', manualRescrape);
  document.getElementById('pcEditBtn').addEventListener('click', openEditMode);
  document.getElementById('editSaveBtn').addEventListener('click', saveManualProfile);
  document.getElementById('editCancelBtn').addEventListener('click', () => {
    // Restore profile card state so home page isn't broken
    if (profile && (profile.name || profile.headline)) {
      showProfileCard(profile);
    }
    goBack();
  });

  document.getElementById('refreshBtn').addEventListener('click', manualRescrape);

  // Home page re-extract button
  const homeReextractBtn = document.getElementById('homeReextractBtn');
  if (homeReextractBtn) homeReextractBtn.addEventListener('click', manualRescrape);

  document.getElementById('consentAllowBtn').addEventListener('click', async () => {
    await chrome.storage.local.set({ consentGiven: true });
    const confirmed = await showExtractionWarning();
    if (confirmed) scrapeProfile();
  });

  document.getElementById('consentSkipBtn').addEventListener('click', () => showState('edit'));
}

async function openEditMode() {
  // Only change profile card state if we're on the profile page (not when opening from settings)
  if (_currentPage === 'profile') showState('edit');
  if (!profile || (!profile.name && !profile.headline && !profile.currentRole)) {
    const { myProfile: savedProfile } = await chrome.storage.local.get('myProfile');
    if (savedProfile) profile = savedProfile;
  }

  const p = profile || {};
  const skillsList = Array.isArray(p.skills)
    ? p.skills
    : (typeof p.skills === 'string' ? p.skills.split(',').map(s => s.trim()).filter(Boolean) : []);
  const expList = Array.isArray(p.experience) ? p.experience : [];

  const setFieldValue = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  };

  // Placeholder patterns that should be treated as empty in the edit form
  const _EDIT_PLACEHOLDERS = [
    /tell non-?profits you are interested/i,
    /getting involved with your time and skills/i,
    /tell the world about yourself/i,
    /write a summary about yourself/i,
    /use your summary to/i,
    /adding a summary helps/i,
    /your summary is your chance/i,
    /members who include a summary/i,
    /showcase your accomplishments/i,
    /get up to 2x as many/i,
  ];
  const _isEditPlaceholder = (s) => !!s && _EDIT_PLACEHOLDERS.some(rx => rx.test(s.trim()));
  const _scrubEditStr = (s) => (_isEditPlaceholder(s) ? '' : (s || ''));

  // Placeholder company names that should be cleared
  const _PLACEHOLDER_COMPANIES = /^(organization|organisations?|company|your company)$/i;
  const _scrubCompany = (s) => (_PLACEHOLDER_COMPANIES.test((s || '').trim()) ? '' : (s || ''));

  setFieldValue('editName', p.name || '');
  setFieldValue('editHeadline', p.headline || '');
  setFieldValue('editRole', p.currentRole || '');
  setFieldValue('editCompany', _scrubCompany(p.company || ''));
  setFieldValue('editLocation', p.location || '');
  setFieldValue('editAbout', _scrubEditStr(p.about || ''));
  setFieldValue('editSkills', skillsList.join(', '));
  const expLines = expList.map(e => {
    const title = e?.title || '';
    const company = _scrubCompany(e?.company || '');
    return `${title}${company ? ' at ' + company : ''}`.trim();
  }).filter(Boolean).join('\n');
  setFieldValue('editExperience', expLines);
}

function saveManualProfile() {
  const name     = document.getElementById('editName').value.trim();
  const headline = document.getElementById('editHeadline').value.trim();
  const role     = document.getElementById('editRole').value.trim();
  const company  = document.getElementById('editCompany').value.trim();
  const location = document.getElementById('editLocation').value.trim();
  const about    = document.getElementById('editAbout').value.trim();
  const skillsStr = document.getElementById('editSkills').value.trim();
  const expStr   = document.getElementById('editExperience').value.trim();

  if (!name && !headline) {
    shake(document.getElementById('editName'));
    shake(document.getElementById('editHeadline'));
    return;
  }

  const skills = skillsStr ? skillsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const experience = [];
  if (expStr) {
    for (const line of expStr.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      const m = l.match(/^(.+?)\s*(?:@|at|chez|\||[-–—])\s*(.+?)$/i);
      if (m) experience.push({ title: m[1].trim(), company: m[2].trim(), dates: '', description: '' });
      else experience.push({ title: l, company: '', dates: '', description: '' });
    }
  }

  let currentRole = role;
  let currentCompany = company;
  if (!currentRole && experience.length > 0) {
    currentRole = experience[0].title;
    currentCompany = currentCompany || experience[0].company;
  }

  // Merge edited fields onto the existing profile so fields not in the edit form
  // (education, profilePhotoUrl, bannerUrl, etc.) are preserved unchanged.
  profile = Object.assign({}, profile, {
    name,
    headline,
    about,
    location,
    currentRole,
    company: currentCompany,
    experience,
    skills,
    _source: 'manual',
    _isOwn: true,
  });
  chrome.storage.local.set({ cachedProfile: profile, myProfile: profile });
  showProfileCard(profile);

  // Show "Saved ✓" confirmation on button before navigating
  const saveBtn = document.getElementById('editSaveBtn');
  if (saveBtn) {
    const origText = saveBtn.textContent;
    saveBtn.textContent = 'Saved ✓';
    saveBtn.disabled = true;
    saveBtn.style.background = '#057642';
    setTimeout(() => {
      saveBtn.textContent = origText;
      saveBtn.disabled = false;
      saveBtn.style.background = '';
      navigateTo('home');
    }, 1200);
  } else {
    navigateTo('home');
  }

  // Save manual edits to Cosmos DB
  chrome.runtime.sendMessage({ action: 'saveMyProfile', data: { profile } }).catch(() => {});
}


// ══════════════════════════════════════
//  TABS
// ══════════════════════════════════════

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'gap') onGapTabOpen();
    });
  });
}


// ══════════════════════════════════════
//  CONNECTION CHECK
// ══════════════════════════════════════

async function checkConnection() {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  try {
    const r = await chrome.runtime.sendMessage({ action: 'testConnection' });
    dot.className = r.success ? 'status-dot ok' : 'status-dot err';
    if (r.success) {
      txt.textContent = 'Connected';
      txt.title = '';
    } else {
      txt.textContent = 'Server offline';
      txt.title = 'The AI backend is unreachable. AI features (post generation, profile scoring, gap analysis) will not work until the server is running. Contact your admin or try again later.';
    }
  } catch {
    dot.className = 'status-dot err';
    txt.textContent = 'Server offline';
    txt.title = 'The AI backend is unreachable. AI features will not work. Try again later.';
  }
}


// ══════════════════════════════════════
//  POST GENERATION
// ══════════════════════════════════════

let _myScrapedPosts = []; // posts extracted for style matching

function initPostTab() {
  document.getElementById('genPostBtn').addEventListener('click', genPost);
  document.getElementById('copyPostBtn').addEventListener('click', () => clipCopy('postOutText', 'copyPostBtn'));

  // Update char/word meta on content change
  const postOut = document.getElementById('postOutText');
  postOut.addEventListener('input', () => {
    const text = postOut.value || '';
    document.getElementById('postOutMeta').textContent =
      `${text.length} chars · ${text.split(/\s+/).filter(Boolean).length} words`;
  });

  // Character counter for topic
  _addCharCounter('postTopic', 500);
}

function _addCharCounter(inputId, max) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const counter = document.createElement('div');
  counter.className = 'char-counter';
  input.parentNode.insertBefore(counter, input.nextSibling);
  const update = () => {
    const len = input.value.length;
    counter.textContent = `${len}/${max}`;
    counter.classList.toggle('warn', len > max * 0.8 && len <= max);
    counter.classList.toggle('over', len > max);
  };
  input.addEventListener('input', update);
  update();
}

async function genPost() {
  const topic = document.getElementById('postTopic').value.trim();
  if (!topic) { shake(document.getElementById('postTopic')); toast('Enter a topic for your post first.', 'warn'); return; }

  // Soft warning — post generation works without a profile, but output quality is much better with one
  if (!profile || (!profile.headline && !profile.name)) {
    toast('No profile data found. Visit your LinkedIn profile page first for better results. Generating anyway…', 'warn', 5000);
  }

  const data = {
    headline: profile?.headline || '',
    about:    (profile?.about || '').slice(0, 200),
    experience: (profile?.experience || []).slice(0, 3),
    skills:   (profile?.skills || []).slice(0, 10),
    industry: profile?.industry || profile?.company || '',
    topic,
    type:     document.getElementById('postType').value,
    tone:     document.getElementById('postTone').value,
    length:   document.getElementById('postLength').value,
    language: document.getElementById('postLang').value,
    recent_posts: _myScrapedPosts.slice(0, 3),
  };

  loading(true, 'Generating post...');
  document.getElementById('genPostBtn').disabled = true;

  try {
    const r = await chrome.runtime.sendMessage({ action: 'generatePost', data });
    if (r.success) {
      const postOut = document.getElementById('postOutText');
      postOut.value = r.data;
      postOut.readOnly = true;
      postOut.classList.remove('editing');
      document.getElementById('postOutMeta').textContent = `${r.data.length} chars · ${r.data.split(/\s+/).filter(Boolean).length} words`;
      const box = document.getElementById('postOutBox');
      box.style.display = 'block';
      box.scrollIntoView({ behavior: 'smooth' });
    } else { statusError(r.error); }
  } catch (e) { statusError(e.message); }
  finally { loading(false); document.getElementById('genPostBtn').disabled = false; }
}

async function insertPost() {
  const text = document.getElementById('postOutText').value;
  if (!text) { toast('Generate a post first.', 'warn'); return; }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('linkedin.com')) {
      // Copy to clipboard instead and guide the user
      await navigator.clipboard.writeText(text).catch(() => {});
      toast('Not on LinkedIn — post copied to clipboard! Go to linkedin.com/feed and paste it.', 'info', 6000);
      return;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
    } catch { /* already injected */ }
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'insertPost', text });
      flash('insertPostBtn', ' Done!');
    } catch {
      await navigator.clipboard.writeText(text);
      flash('insertPostBtn', ' Copied!');
    }
  } catch { statusError('Copy & paste instead'); }
}


// ══════════════════════════════════════
//  PROFILE GENERATION
// ══════════════════════════════════════

function initProfileTab() {
  document.getElementById('genProfBtn').addEventListener('click', genProfile);
  document.getElementById('copyProfBtn').addEventListener('click', () => clipCopy('profOutText', 'copyProfBtn'));
  document.getElementById('analyzeBtn').addEventListener('click', analyzeProfile);
  document.getElementById('aiScoreBtn').addEventListener('click', runAiProfileScore);
  document.getElementById('aiScoreExportBtn').addEventListener('click', () => exportAiScoreCardAsImage('linkedin-ai-profile-score.png'));

  const allBox = document.getElementById('genAll');
  const boxes = ['genHeadline', 'genAbout', 'genExp', 'genSkills'];
  allBox.addEventListener('change', () => {
    boxes.forEach(id => document.getElementById(id).checked = allBox.checked);
    updateBioLengthVisibility();
  });
  boxes.forEach(id => document.getElementById(id).addEventListener('change', () => {
    allBox.checked = boxes.every(b => document.getElementById(b).checked);
    updateBioLengthVisibility();
  }));

  _addCharCounter('profInstr', 300);
  updateBioLengthVisibility();
}

function updateBioLengthVisibility() {
  const bioLengthRow = document.getElementById('bioLengthRow');
  if (!bioLengthRow) return;
  const aboutChecked = document.getElementById('genAbout').checked;
  bioLengthRow.style.display = aboutChecked ? '' : 'none';
}

async function genProfile() {
  const fields = [];
  if (document.getElementById('genHeadline').checked) fields.push('headline');
  if (document.getElementById('genAbout').checked)    fields.push('about');
  if (document.getElementById('genExp').checked)      fields.push('experience');
  if (document.getElementById('genSkills').checked)   fields.push('skills');
  if (fields.length === 0) { toast('Select at least one section to generate.', 'warn'); return; }

  // Require profile data for profile generation (unlike post, this needs profile content)
  if (!profile || (!profile.name && !profile.headline && !profile.about)) {
    const { myProfile: saved } = await chrome.storage.local.get('myProfile');
    if (saved && (saved.name || saved.headline)) {
      profile = saved;
    } else {
      toast('Your profile is not extracted yet. Go to your LinkedIn profile page first — the extension will auto-extract it.', 'warn', 6000);
      return;
    }
  }

  const p = profile || {};

  let experienceCtx = '';
  if (fields.includes('experience')) {
    experienceCtx = (p.experience || []).slice(0, 5).map((e, i) => {
      let line = `${i + 1}. ${e.title || 'Unknown Role'}`;
      if (e.company) line += ` at ${e.company}`;
      if (e.dates) line += ` (${e.dates})`;
      if (e.description) line += `\n   Description: ${e.description}`;
      return line;
    }).join('\n');
  }

  const bioLengthEl = document.getElementById('profBioLength');
  const data = {
    name:            p.name || '',
    currentRole:     p.currentRole || p.headline || '',
    currentHeadline: p.headline || '',
    company:         p.company || '',
    industry:        p.industry || '',
    currentAbout:    p.about || '',
    experience:      experienceCtx,
    education: (p.education || []).map(e => `${e.school}${e.degree ? ' — ' + e.degree : ''}`).join('\n'),
    skills:   (p.skills || []).join(', '),
    fields,
    bioLength:    bioLengthEl ? bioLengthEl.value : 'medium',
    language:     document.getElementById('profLang').value,
    tone:         document.getElementById('profTone').value,
    instructions: document.getElementById('profInstr').value.trim(),
  };

  loading(true, 'Generating profile content...');
  document.getElementById('genProfBtn').disabled = true;

  try {
    const r = await chrome.runtime.sendMessage({ action: 'generateProfile', data });
    if (r.success) showProfileOutput(r.data, fields), analyzeAfter(r.data, fields);
    else statusError(r.error);
  } catch (e) { statusError(e.message); }
  finally { loading(false); document.getElementById('genProfBtn').disabled = false; }
}

function showProfileOutput(text, fields) {
  const box = document.getElementById('profOutBox');
  const out = document.getElementById('profOutText');
  try {
    const clean = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    // Generate unique IDs for copy targets
    let _sectionIdx = 0;
    let html = '';
    for (const [key, val] of Object.entries(parsed)) {
      // Only render sections that were actually requested
      if (fields && fields.length > 0 && !fields.includes(key)) continue;
      const sectionId = `prof-sec-${++_sectionIdx}`;
      html += `<div class="prof-section" id="${sectionId}">
        <div class="prof-section-header">
          <span class="prof-section-title">${fmtKey(key)}</span>
          <button class="prof-copy-btn" data-target="${sectionId}" title="Copy to clipboard">Copy</button>
        </div>`;

      if (key === 'experience' && Array.isArray(val)) {
        // Structured experience cards
        let expHtml = '';
        for (const entry of val) {
          if (typeof entry === 'object' && entry !== null && (entry.title || entry.bullets)) {
            const bullets = Array.isArray(entry.bullets) ? entry.bullets : [];
            expHtml += `<div class="prof-exp-entry">`;
            expHtml += `<div class="prof-exp-header">${esc(entry.title || '')}`;
            if (entry.company) expHtml += ` <span class="prof-exp-company">at ${esc(entry.company)}</span>`;
            expHtml += `</div>`;
            if (bullets.length > 0) {
              expHtml += `<ul class="prof-exp-bullets">${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`;
            }
            expHtml += `</div>`;
          } else {
            expHtml += `<p>${esc(typeof entry === 'string' ? entry : JSON.stringify(entry))}</p>`;
          }
        }
        html += `<div class="prof-section-body">${expHtml}</div>`;

      } else if (key === 'skills' && typeof val === 'object' && val !== null && !Array.isArray(val)) {
        // Skills: existing tags + suggestions
        let skillHtml = '';
        if (Array.isArray(val.existing) && val.existing.length > 0) {
          skillHtml += `<div class="prof-skills-label">Your skills (formatted)</div>`;
          skillHtml += `<div class="prof-skill-tags">${val.existing.map(s => `<span class="prof-skill-tag">${esc(s)}</span>`).join('')}</div>`;
        }
        if (Array.isArray(val.suggestions) && val.suggestions.length > 0) {
          skillHtml += `<div class="prof-skills-label prof-skills-label-suggest">Suggested skills to add</div>`;
          skillHtml += `<div class="prof-skill-tags">${val.suggestions.map(s => `<span class="prof-skill-tag prof-skill-suggestion">${esc(s)}</span>`).join('')}</div>`;
        }
        html += `<div class="prof-section-body">${skillHtml}</div>`;

      } else if (Array.isArray(val)) {
        html += `<div class="prof-section-body">${val.map(v => esc(typeof v === 'string' ? v : JSON.stringify(v))).join('\n\n')}</div>`;
      } else {
        html += `<div class="prof-section-body">${esc(String(val))}</div>`;
      }

      html += `</div>`;
    }
    out.innerHTML = html;
    // Wire copy buttons
    out.querySelectorAll('.prof-copy-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sec = document.getElementById(btn.dataset.target);
        if (!sec) return;
        const bodyEl = sec.querySelector('.prof-section-body');
        const textToCopy = bodyEl ? bodyEl.innerText : sec.innerText;
        try {
          await navigator.clipboard.writeText(textToCopy.trim());
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          btn.classList.add('prof-copy-btn--done');
          setTimeout(() => { btn.textContent = orig; btn.classList.remove('prof-copy-btn--done'); }, 1500);
        } catch { toast('Copy failed', 'warn'); }
      });
    });
  } catch {
    out.textContent = text;
  }
  box.style.display = 'block';
  box.scrollIntoView({ behavior: 'smooth' });
}


// ══════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════

function initSettings() {
  chrome.storage.local.get('myProfile').then(({ myProfile: savedProfile }) => {
    if (savedProfile && !profile) profile = savedProfile;
    syncSettingsProfileInfo(savedProfile || profile || null);
  });

  // Edit profile button — handled in initNavigation

  initNotificationSettings();

  // Replay user guide — clears tourDone flag and restarts from step 0
  const replayBtn = document.getElementById('replayTourBtn');
  if (replayBtn) {
    replayBtn.addEventListener('click', async () => {
      await chrome.storage.local.remove('tourDone');
      goBack(); // navigate back to home so the tour overlays the right context
      setTimeout(() => _showTourStep(0), 300);
    });
  }
}


// ══════════════════════════════════════
//  SUBUL PAGE
// ══════════════════════════════════════

function initSubulPage() {
  const refreshBtn = document.getElementById('subulRefreshBtn');
  if (!refreshBtn) return;

  // Refresh button — bypasses the 23h throttle
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.style.opacity = '0.4';
    refreshBtn.disabled = true;
    _setSubulStatus(window._t('subulStatusSyncing'));
    chrome.runtime.sendMessage({ action: 'subulSync' }, () => {
      setTimeout(() => _loadSubulData(), 1500);
      refreshBtn.style.opacity = '';
      refreshBtn.disabled = false;
    });
  });

  // Load on page open (via navigation listener) — only when page becomes visible
  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('[data-nav="subul"]')) {
      setTimeout(_loadSubulData, 100);
    }
  });

  // Initial load
  _loadSubulData();
}

function _setSubulStatus(msg, color = '') {
  const el = document.getElementById('subulSyncStatus');
  if (el) { el.textContent = msg; el.style.color = color; }
}

async function _loadSubulData() {
  _setSubulStatus(window._t('subulStatusLoading'));

  chrome.runtime.sendMessage({ action: 'getSubulData' }, (r) => {
    if (chrome.runtime.lastError || !r?.success || !r?.data) {
      _setSubulStatus(window._t('subulStatusNotSynced'));
      document.getElementById('subulNoData').style.display = 'block';
      document.getElementById('subulCounts').style.display = 'none';
      return;
    }

    const data = r.data;
    const certs    = data.certifications || [];
    const labs     = data.labs           || [];
    const syncedAt = data.synced_at ? new Date(data.synced_at).toLocaleDateString() : '';

    if (!certs.length && !labs.length) {
      _setSubulStatus(window._t('subulStatusNoData'));
      document.getElementById('subulNoData').style.display = 'block';
      document.getElementById('subulCounts').style.display = 'none';
      _hideSubulSections();
      return;
    }

    // Update status bar
    _setSubulStatus(syncedAt ? `${window._t('subulStatusLastSynced')} ${syncedAt}` : window._t('subulStatusSynced'));
    document.getElementById('subulNoData').style.display = 'none';

    // Render lists
    _renderSubulList('subulCertsSection', 'subulCertsList', certs, 'certification');
    _renderSubulList('subulLabsSection',  'subulLabsList',  labs,  'lab');

    // Show earned counts only
    const earnedCerts = certs.filter(c => c.user_earned);
    const earnedLabs  = labs.filter(l => l.user_earned);
    document.getElementById('subulCounts').style.display = 'grid';
    document.getElementById('subulCertCount').textContent = earnedCerts.length;
    document.getElementById('subulLabCount').textContent  = earnedLabs.length;

    const cardDesc = document.getElementById('subulCardDesc');
    if (cardDesc) cardDesc.textContent = earnedCerts.length
      ? (earnedCerts.length === 1 ? window._t('subulCertsEarned_one') : window._t('subulCertsEarned_many').replace('{{n}}', earnedCerts.length))
      : window._t('subulTapToManage');
  });
}

function _renderSubulList(sectionId, listId, items, type) {
  const section = document.getElementById(sectionId);
  const list    = document.getElementById(listId);
  if (!section || !list) return;

  if (!items.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = '';

  items.slice(0, 30).forEach(item => {
    const name     = item.name || item.title || 'Unnamed';
    const isEarned = !!item.user_earned;
    const isCert   = type === 'certification';
    const isLab    = type === 'lab';
    const meta     = isCert
      ? [item.issuer, item.earned_at ? `${window._t('subulEarned')} ${item.earned_at.slice(0,10)}` : item.issued_at ? `${window._t('subulIssued')} ${item.issued_at.slice(0,10)}` : ''].filter(Boolean).join(' · ')
      : isLab && item.completed_at ? `${window._t('subulCompletedLabel')} ${item.completed_at.slice(0,10)}` : '';
    const score = isLab && item.score != null && item.score !== '' ? `${item.score}%` : '';

    const row = document.createElement('div');
    row.className = 'subul-item' + (isEarned ? ' subul-item-earned' : ' subul-item-pending');
    row.innerHTML = `
      <div class="subul-item-dot ${isEarned ? 'subul-dot-earned' : 'subul-dot-pending'}"></div>
      <div class="subul-item-body">
        <div class="subul-item-name" title="${_esc(name)}">${_esc(name)}</div>
        ${meta ? `<div class="subul-item-meta">${_esc(meta)}</div>` : ''}
      </div>
      ${score ? `<div class="subul-item-score">${_esc(score)}</div>` : ''}
      ${isCert && isEarned ? `<button class="subul-post-btn" data-cert="${_esc(name)}">${window._t('subulPostBtn')}</button>` : ''}
      <label class="subul-earned-toggle" title="${isEarned ? window._t('subulToggleNotEarned') : window._t('subulToggleEarned')}">
        <input type="checkbox" class="subul-earned-check" data-name="${_esc(name)}" data-type="${isCert ? 'certification' : 'lab'}" ${isEarned ? 'checked' : ''} />
        <span class="subul-earned-pill"></span>
      </label>
    `;
    list.appendChild(row);
  });

  // Wire up earned toggles — route through background.js to avoid CORS issues
  list.querySelectorAll('.subul-earned-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const itemName = cb.dataset.name || '';
      const itemType = cb.dataset.type;
      const earned   = cb.checked;

      // Optimistic UI: update dot colour immediately, no reload
      const row = cb.closest('.subul-item');
      if (row) {
        const dot = row.querySelector('.subul-item-dot');
        if (earned) {
          row.classList.remove('subul-item-pending');
          row.classList.add('subul-item-earned');
          if (dot) { dot.classList.remove('subul-dot-pending'); dot.classList.add('subul-dot-earned'); }
          // Show Post button if cert
          if (itemType === 'certification') {
            const name = row.querySelector('.subul-item-name')?.textContent || '';
            if (!row.querySelector('.subul-post-btn')) {
              const btn = document.createElement('button');
              btn.className = 'subul-post-btn';
              btn.dataset.cert = name;
              btn.textContent = window._t('subulPostBtn');
              row.querySelector('.subul-earned-toggle').before(btn);
              btn.addEventListener('click', (e) => {
                e.stopPropagation(); e.preventDefault();
                const topic = window._t('subulPostCertTopic').replace('{{name}}', name);
                navigateTo('post');
                setTimeout(() => {
                  const topicEl = document.getElementById('postTopic') || document.getElementById('topic');
                  if (topicEl) { topicEl.value = topic; topicEl.dispatchEvent(new Event('input', { bubbles: true })); }
                  const typeEl = document.querySelector('#postType, [data-field="type"] select, #type');
                  if (typeEl) typeEl.value = 'storytelling';
                  const postBody = document.querySelector('#page-post .page-body');
                  if (postBody) postBody.scrollTop = 0;
                }, 320);
              });
            }
          }
        } else {
          row.classList.remove('subul-item-earned');
          row.classList.add('subul-item-pending');
          if (dot) { dot.classList.remove('subul-dot-earned'); dot.classList.add('subul-dot-pending'); }
          row.querySelector('.subul-post-btn')?.remove();
        }
      }

      // Persist to backend via background.js (handles auth + CORS properly)
      chrome.runtime.sendMessage({
        action: 'markSubulEarned',
        data: { type: itemType, item_name: itemName, earned },
      }, (r) => {
        if (chrome.runtime.lastError || !r?.success) {
          cb.checked = !earned;
          if (earned) {
            row?.classList.remove('subul-item-earned');
            row?.classList.add('subul-item-pending');
            const dot = row?.querySelector('.subul-item-dot');
            if (dot) { dot.classList.remove('subul-dot-earned'); dot.classList.add('subul-dot-pending'); }
            row?.querySelector('.subul-post-btn')?.remove();
          } else {
            row?.classList.remove('subul-item-pending');
            row?.classList.add('subul-item-earned');
            const dot = row?.querySelector('.subul-item-dot');
            if (dot) { dot.classList.remove('subul-dot-pending'); dot.classList.add('subul-dot-earned'); }
          }
          toast('Could not save — try again', 'error', 3000);
          return;
        }
        _updateSubulCounts();
      });
    });
  });

  // Wire up Post buttons
  list.querySelectorAll('.subul-post-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      const certName = btn.dataset.cert;
      const topic = `I just earned my ${certName} certification on Subul!`;
      navigateTo('post');
      setTimeout(() => {
        const topicEl = document.getElementById('postTopic') || document.getElementById('topic');
        if (topicEl) { topicEl.value = topic; topicEl.dispatchEvent(new Event('input', { bubbles: true })); }
        const typeEl = document.querySelector('#postType, [data-field="type"] select, #type');
        if (typeEl) typeEl.value = 'storytelling';
        const postBody = document.querySelector('#page-post .page-body');
        if (postBody) postBody.scrollTop = 0;
      }, 320);
    });
  });
}

function _hideSubulSections() {
  ['subulCertsSection', 'subulLabsSection'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function _updateSubulCounts() {
  // Recount earned items from current DOM state without a full reload
  const earnedCerts = document.querySelectorAll('#subulCertsList .subul-earned-check:checked').length;
  const earnedLabs  = document.querySelectorAll('#subulLabsList .subul-earned-check:checked').length;
  const certEl = document.getElementById('subulCertCount');
  const labEl  = document.getElementById('subulLabCount');
  if (certEl) certEl.textContent = earnedCerts;
  if (labEl)  labEl.textContent  = earnedLabs;
  const cardDesc = document.getElementById('subulCardDesc');
  if (cardDesc) cardDesc.textContent = earnedCerts
    ? (earnedCerts === 1 ? window._t('subulCertsEarned_one') : window._t('subulCertsEarned_many').replace('{{n}}', earnedCerts))
    : window._t('subulTapToManage');
}

function _esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}


// ══════════════════════════════════════
//  NOTIFICATION SETTINGS (in Settings page)
// ══════════════════════════════════════

function initNotificationSettings() {
  const masterToggle  = document.getElementById('settingsNotifEnabled');
  const eventsPanel   = document.getElementById('settingsNotifEvents');
  const statusEl      = document.getElementById('settingsNotifStatus');
  if (!masterToggle) return;

  // ── Load saved prefs ──────────────────────────────────────────────────────
  chrome.storage.sync.get(['notifEmail', 'notifEvents'], ({ notifEmail, notifEvents }) => {
    // Default email to true on first use (notifEmail is undefined when never set)
    const enabled = notifEmail === undefined ? true : !!notifEmail;
    const events  = notifEvents || ['profile_extracted', 'ai_score', 'networking_analysis', 'gap_analysis'];

    // Persist the default so backend stays in sync
    if (notifEmail === undefined) {
      chrome.storage.sync.set({ notifEmail: true, notifEvents: events });
      // Also push to backend — without this, Cosmos never gets the initial prefs
      // and notifications don't fire until the user manually toggles the setting.
      chrome.runtime.sendMessage({
        action: 'updateNotifPrefs',
        data: { emailEnabled: true, pushEnabled: false, events },
      });
    }

    masterToggle.checked        = enabled;
    eventsPanel.style.display   = enabled ? 'block' : 'none';

    document.querySelectorAll('.sn-check').forEach(cb => {
      cb.checked = events.includes(cb.dataset.event);
    });
  });

  // ── Master toggle: show/hide event list ──────────────────────────────────
  masterToggle.addEventListener('change', () => {
    eventsPanel.style.display = masterToggle.checked ? 'block' : 'none';
    _saveNotifPrefs();
  });

  // ── Event toggles: save on any change ────────────────────────────────────
  document.querySelectorAll('.sn-check').forEach(cb => {
    cb.addEventListener('change', _saveNotifPrefs);
  });

  function _saveNotifPrefs() {
    const emailEnabled = masterToggle.checked;
    const events = [...document.querySelectorAll('.sn-check')]
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.event);

    // Save to chrome.storage.sync immediately (instant, no backend round-trip)
    chrome.storage.sync.set({ notifEmail: emailEnabled, notifEvents: events });

    // Persist to backend via background.js (respects auth token automatically)
    chrome.runtime.sendMessage({
      action: 'updateNotifPrefs',
      data: { emailEnabled, pushEnabled: false, events },
    }, () => {
      // Show brief "Saved" confirmation
      if (statusEl) {
        statusEl.textContent = window._t('settingsNotifSaved');
        statusEl.style.display = 'block';
        clearTimeout(statusEl._hideTimer);
        statusEl._hideTimer = setTimeout(() => {
          statusEl.style.display = 'none';
        }, 2000);
      }
    });
  }
}


// ══════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════

// ── Toast notification system ──
function toast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const icons = { info: '\u2139\uFE0F', success: '\u2705', error: '\u274C', warn: '\u26A0\uFE0F' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || ''}</span><span>${message}</span><button class="toast-close" aria-label="Dismiss">&times;</button>`;
  el.querySelector('.toast-close').addEventListener('click', () => _removeToast(el));
  container.appendChild(el);
  if (duration > 0) setTimeout(() => _removeToast(el), duration);
  // Keep max 3 toasts visible
  while (container.children.length > 3) _removeToast(container.firstChild);
  return el;
}
function _removeToast(el) {
  if (!el || !el.parentNode) return;
  el.classList.add('removing');
  el.addEventListener('animationend', () => el.remove());
}

// ── Confirm dialog ──
function confirmDialog(title, message, { okText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `<div class="confirm-box">
      <div class="confirm-title">${title}</div>
      <div class="confirm-msg">${message}</div>
      <div class="confirm-actions">
        <button type="button" class="confirm-cancel">${cancelText}</button>
        <button type="button" class="${danger ? 'confirm-danger' : 'confirm-ok'}">${okText}</button>
      </div></div>`;
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
    overlay.querySelector(danger ? '.confirm-danger' : '.confirm-ok').addEventListener('click', () => { overlay.remove(); resolve(true); });
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    document.body.appendChild(overlay);
  });
}

// ── Improved loading overlay with elapsed timer ──
let _loadingTimer = null;
let _loadingStart = 0;
let _loadingCancelFn = null;

function loading(show, msg, cancelFn) {
  const overlay = document.getElementById('loadingOverlay');
  const msgEl = document.getElementById('loadingMsg');
  const elapsedEl = document.getElementById('loadingElapsed');
  const cancelBtn = document.getElementById('loadingCancelBtn');

  overlay.style.display = show ? 'flex' : 'none';
  if (msg) msgEl.textContent = msg;

  if (show) {
    _loadingStart = Date.now();
    elapsedEl.textContent = '';
    clearInterval(_loadingTimer);
    _loadingTimer = setInterval(() => {
      const s = Math.round((Date.now() - _loadingStart) / 1000);
      elapsedEl.textContent = s >= 3 ? `${s}s elapsed` : '';
    }, 1000);
    if (cancelFn) {
      _loadingCancelFn = cancelFn;
      cancelBtn.style.display = '';
      cancelBtn.onclick = () => { loading(false); if (_loadingCancelFn) _loadingCancelFn(); };
    } else {
      cancelBtn.style.display = 'none';
    }
  } else {
    clearInterval(_loadingTimer);
    _loadingTimer = null;
    elapsedEl.textContent = '';
    cancelBtn.style.display = 'none';
    _loadingCancelFn = null;
  }
}

function statusError(msg) {
  toast(msg, 'error', 5000);
}

function clipCopy(elId, btnId) {
  const el = document.getElementById(elId);
  // textarea: use .value; div/span: use innerText fallback
  const text = el.value !== undefined ? el.value : (el.innerText || el.textContent);
  navigator.clipboard.writeText(text).then(() => flash(btnId, '\u2705 Copied!'));
}

function flash(id, msg) {
  const btn = id ? document.getElementById(id) : null;
  if (!btn) { toast(msg, 'success', 2000); return; }
  const prev = btn.innerHTML;
  btn.classList.add('ok');
  btn.textContent = msg;
  setTimeout(() => { btn.classList.remove('ok'); btn.innerHTML = prev; }, 2000);
}

function shake(el) {
  el.style.borderColor = 'var(--er)';
  el.animate([
    { transform: 'translateX(0)' }, { transform: 'translateX(-4px)' },
    { transform: 'translateX(4px)' }, { transform: 'translateX(0)' },
  ], { duration: 300 });
  setTimeout(() => el.style.borderColor = '', 1000);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtKey(k) { return k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()); }


// ══════════════════════════════════════
//  DARK MODE
// ══════════════════════════════════════

async function initDarkMode() {
  // Bind once globally so it survives view switches/auth state changes.
  if (!window.__darkModeBindingsInstalled) {
    window.__darkModeBindingsInstalled = true;

    document.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('#darkModeBtn');
      if (!btn) return;
      e.preventDefault();
      const isDark = !document.body.classList.contains('dark');
      setDarkMode(isDark);
    });

    document.addEventListener('change', (e) => {
      const toggle = e.target?.id === 'settingsDarkMode' ? e.target : null;
      if (!toggle) return;
      setDarkMode(!!toggle.checked);
    });
  }

  try {
    const { darkMode } = await chrome.storage.local.get('darkMode');
    setDarkMode(!!darkMode, false);
  } catch (err) {
    console.warn('[LinkedIn AI] Could not load darkMode preference:', err);
  }
}

function setDarkMode(isDark, persist = true) {
  document.body.classList.toggle('dark', !!isDark);
  const darkModeBtn = document.getElementById('darkModeBtn');
  if (darkModeBtn) darkModeBtn.setAttribute('aria-pressed', String(!!isDark));
  const settingsToggle = document.getElementById('settingsDarkMode');
  if (settingsToggle) settingsToggle.checked = !!isDark;
  if (persist) chrome.storage.local.set({ darkMode: !!isDark });
}


// ══════════════════════════════════════
//  LANGUAGE / i18n
// ══════════════════════════════════════

window._uiLang = 'en'; // runtime language, set by initI18n

async function initI18n() {
  if (!window.__i18nBindingsInstalled) {
    window.__i18nBindingsInstalled = true;

    // Header lang button (home page)
    document.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('#langBtn');
      if (!btn) return;
      const next = window._uiLang === 'en' ? 'fr' : 'en';
      setLang(next);
    });

    // Settings lang buttons
    document.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('.settings-lang-opt');
      if (!btn) return;
      const lang = btn.getAttribute('data-lang');
      if (lang) setLang(lang);
    });
  }

  try {
    const { uiLang } = await chrome.storage.local.get('uiLang');
    setLang(uiLang || 'en', false);
  } catch {
    setLang('en', false);
  }
}

function setLang(lang, persist = true) {
  if (!window.I18N || !window.I18N[lang]) return;
  window._uiLang = lang;

  // Update <html lang> attribute for accessibility and CSS :lang() selectors
  document.documentElement.lang = lang;

  // Update header toggle button label
  const headerBtn = document.getElementById('langBtn');
  if (headerBtn) headerBtn.textContent = lang.toUpperCase();

  // Update settings active state
  document.querySelectorAll('.settings-lang-opt').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
  });

  applyI18n(lang);
  if (persist) chrome.storage.local.set({ uiLang: lang });
}

function applyI18n(lang) {
  const T = window.I18N[lang] || window.I18N.en;
  const $ = (id) => document.getElementById(id);
  const setText = (id, key) => { const el = $(id); if (el && T[key] != null) el.textContent = T[key]; };
  const setPlaceholder = (id, key) => { const el = $(id); if (el && T[key] != null) el.placeholder = T[key]; };
  const setTitle = (id, key) => { const el = $(id); if (el && T[key] != null) { el.title = T[key]; el.setAttribute('aria-label', T[key]); } };
  const setOpt = (selectId, valKey, textKey) => {
    const el = $(selectId); if (!el) return;
    const opt = el.querySelector(`option[value="${valKey}"]`);
    if (opt && T[textKey] != null) opt.textContent = T[textKey];
  };

  // ── Header ───────────────────────────────────────────────────
  setTitle('darkModeBtn', 'darkModeTitle');
  setTitle('langBtn', 'langBtnTitle');

  // ── Auth ─────────────────────────────────────────────────────
  setText('authLogoutBtn', 'logout');

  // ── Home feature cards ────────────────────────────────────────
  document.querySelectorAll('.feature-card').forEach(card => {
    const nav = card.getAttribute('data-nav');
    const label = card.querySelector('.feature-label');
    const desc = card.querySelector('.feature-desc');
    const labelKey = { post: 'fcPostLabel', profile: 'fcProfileLabel', networking: 'fcNetworkLabel', gap: 'fcGapLabel' }[nav];
    const descKey  = { post: 'fcPostDesc',  profile: 'fcProfileDesc',  networking: 'fcNetworkDesc',  gap: 'fcGapDesc'  }[nav];
    if (label && labelKey && T[labelKey] != null) label.textContent = T[labelKey];
    if (desc  && descKey  && T[descKey]  != null) desc.textContent  = T[descKey];
  });

  // Chat CTA
  const chatCta = document.getElementById('homeChatCta');
  if (chatCta) {
    // Keep the SVG, only update the trailing text node
    const textNodes = [...chatCta.childNodes].filter(n => n.nodeType === 3);
    if (textNodes.length && T.chatCta != null) textNodes[textNodes.length - 1].textContent = ' ' + T.chatCta;
  }

  // ── Page titles ───────────────────────────────────────────────
  document.querySelectorAll('.page-title').forEach(el => {
    const page = el.closest('.page');
    if (!page) return;
    const key = 'pageTitle_' + page.id;
    if (T[key] != null) el.textContent = T[key];
  });

  // ── Post page ─────────────────────────────────────────────────
  setPlaceholder('postTopic', 'topicPlaceholder');
  setText('genPostBtn', 'generatePostBtn');
  if ($('postOutBox')) {
    const lbl = $('postOutBox')?.querySelector('.output-label');
    if (lbl && T.generatedPostLabel != null) lbl.textContent = T.generatedPostLabel;
  }
  // Only reset editPostBtn label if NOT currently in editing state (textarea is unlocked)
  const _editPostTextarea = $('postOutText');
  const _editPostBtn      = $('editPostBtn');
  if (_editPostBtn && _editPostTextarea && _editPostTextarea.readOnly !== false) {
    if (T.editPostBtn != null) _editPostBtn.textContent = T.editPostBtn;
  }
  setText('copyPostBtn', 'copyPostBtn');
  setText('insertPostBtn', 'insertPostBtn');

  // Post page form labels — some have for="", some don't; match by sibling control id
  document.querySelectorAll('#page-post .form-group').forEach(fg => {
    const lbl = fg.querySelector(':scope > label');
    if (!lbl) return;
    const forAttr = lbl.getAttribute('for') || '';
    const control = fg.querySelector('select, textarea, input');
    const controlId = forAttr || control?.id || '';
    const map = { postTopic: 'topicLabel', postType: 'typeLabel', postTone: 'toneLabel', postLength: 'lengthLabel', postLang: 'langLabel' };
    const key = map[controlId];
    if (!key || T[key] == null) return;
    // Preserve child elements (e.g. <span class="req">*</span>)
    const firstText = [...lbl.childNodes].find(n => n.nodeType === 3);
    if (firstText) firstText.textContent = T[key] + ' ';
    else lbl.prepend(document.createTextNode(T[key] + ' '));
  });

  // Post type options
  setOpt('postType', 'opinion',       'postType_opinion');
  setOpt('postType', 'storytelling',  'postType_storytelling');
  setOpt('postType', 'listicle',      'postType_listicle');
  setOpt('postType', 'how_to',        'postType_how_to');
  setOpt('postType', 'contrarian',    'postType_contrarian');
  setOpt('postType', 'lesson_learned','postType_lesson_learned');
  setOpt('postType', 'tips',          'postType_tips');
  setOpt('postTone', 'professional',  'postTone_professional');
  setOpt('postTone', 'conversational','postTone_conversational');
  setOpt('postTone', 'inspirational', 'postTone_inspirational');
  setOpt('postTone', 'provocative',   'postTone_provocative');
  setOpt('postLength', 'short',       'postLength_short');
  setOpt('postLength', 'medium',      'postLength_medium');
  setOpt('postLength', 'long',        'postLength_long');

  // ── Profile page ──────────────────────────────────────────────
  document.querySelectorAll('#page-profile .sub-tab').forEach(tab => {
    const sub = tab.getAttribute('data-subtab');
    const map = { score: 'profileTabScore', 'ai-deep': 'profileTabAiDeep', generate: 'profileTabGenerate' };
    if (map[sub] && T[map[sub]] != null) tab.textContent = T[map[sub]];
  });

  // Score sub-tab
  const scoreTitle = document.querySelector('#page-profile .score-card-title');
  if (scoreTitle && T.profileStrengthTitle) scoreTitle.textContent = T.profileStrengthTitle;
  const scoreHint = document.querySelector('#page-profile .score-card-hint');
  if (scoreHint && T.profileStrengthHint) scoreHint.textContent = T.profileStrengthHint;
  const scoreSubtitle = $('scoreCardSubtitle');
  if (scoreSubtitle && T.profileStrengthSubtitle) scoreSubtitle.textContent = T.profileStrengthSubtitle;
  const currentLbl = document.querySelector('#scoreBeforePanel .score-label');
  if (currentLbl && T.currentProfileLabel) currentLbl.textContent = T.currentProfileLabel;
  const afterLbl = document.querySelector('#scoreAfterPanel .score-label');
  if (afterLbl && T.afterAiLabel) afterLbl.textContent = T.afterAiLabel;

  const analyzeBtn = $('analyzeBtn');
  if (analyzeBtn && T.analyzeBtnText != null) {
    const svg = analyzeBtn.querySelector('svg')?.cloneNode(true);
    analyzeBtn.textContent = T.analyzeBtnText;
    if (svg) analyzeBtn.prepend(svg);
  }

  // AI Deep sub-tab
  const aiDeepTitle = document.querySelector('#aiDeepEmptyState .empty-state-title');
  if (aiDeepTitle && T.aiDeepTitle) aiDeepTitle.textContent = T.aiDeepTitle;
  const aiDeepDescEl = document.querySelector('#aiDeepEmptyState .empty-state-desc');
  if (aiDeepDescEl && T.aiDeepDescHtml) aiDeepDescEl.innerHTML = T.aiDeepDescHtml;
  const aiDeepBtn = $('aiScoreBtn');
  if (aiDeepBtn && T.aiDeepBtn != null) {
    const svg = aiDeepBtn.querySelector('svg')?.cloneNode(true);
    aiDeepBtn.textContent = T.aiDeepBtn;
    if (svg) aiDeepBtn.prepend(svg);
  }
  setText('aiScoreCacheTag', 'cachedResult');
  setText('aiScoreExportBtn', 'exportAsImage');

  // Generate sub-tab — labels without for="" attributes, matched by sibling control id
  document.querySelectorAll('#subtab-generate .form-group').forEach(fg => {
    const lbl = fg.querySelector(':scope > label');
    if (!lbl) return;
    const control = fg.querySelector('select, textarea, input[type="text"]');
    const controlId = control?.id || '';
    const labelMap = {
      profBioLength: 'genBioLengthFormLabel',
      profLang:      'genLangFormLabel',
      profTone:      'genToneFormLabel',
      profInstr:     'genExtraFormLabel',
    };
    const key = labelMap[controlId];
    if (key && T[key] != null) lbl.textContent = T[key];
    // "What to generate" label — no sibling control, matched by absence
    else if (!controlId && T.whatToGenerate != null) lbl.textContent = T.whatToGenerate;
  });
  [
    ['genHeadline', 'genHeadlineLabel', 'genHeadlineDesc'],
    ['genAbout',    'genAboutLabel',    'genAboutDesc'],
    ['genExp',      'genExpLabel',      'genExpDesc'],
    ['genSkills',   'genSkillsLabel',   'genSkillsDesc'],
    ['genAll',      'genAllLabel',      null],
  ].forEach(([id, lKey, dKey]) => {
    const cb = $(id); if (!cb) return;
    const item = cb.closest('.check-item'); if (!item) return;
    const span = item.querySelector('.check-text');
    const desc = item.querySelector('.check-desc');
    if (span && T[lKey] != null) span.textContent = T[lKey];
    if (desc && dKey && T[dKey] != null) desc.textContent = T[dKey];
  });
  setOpt('profBioLength', 'short',  'bioLength_short');
  setOpt('profBioLength', 'medium', 'bioLength_medium');
  setOpt('profBioLength', 'long',   'bioLength_long');
  setOpt('profTone', 'professional', 'profTone_professional');
  setOpt('profTone', 'confident',    'profTone_confident');
  setOpt('profTone', 'creative',     'profTone_creative');
  setPlaceholder('profInstr', 'extraInstructionsPlaceholder');
  setText('genProfBtn', 'generateProfileBtn');
  const profOutLabel = document.querySelector('#profOutBox .output-label');
  if (profOutLabel && T.generatedContentLabel) profOutLabel.textContent = T.generatedContentLabel;
  setText('copyProfBtn', 'copyProfBtn');

  // ── Networking page ───────────────────────────────────────────
  const netConsentTitle = document.querySelector('#netConsent .net-consent-title');
  if (netConsentTitle && T.netConsentTitle) netConsentTitle.textContent = T.netConsentTitle;
  const netConsentCheckLabel = document.querySelector('.net-consent-check');
  if (netConsentCheckLabel && T.netConsentCheck != null) {
    const cb = netConsentCheckLabel.querySelector('input');
    netConsentCheckLabel.textContent = ' ' + T.netConsentCheck;
    if (cb) netConsentCheckLabel.prepend(cb);
  }
  setText('netConsentAcceptBtn', 'netConsentAcceptBtn');
  // Net consent subtitle + body
  const netConsentSubtitle = document.querySelector('#netConsent .net-consent-subtitle');
  if (netConsentSubtitle && T.netConsentSubtitle) netConsentSubtitle.textContent = T.netConsentSubtitle;
  const netConsentPs = document.querySelectorAll('#netConsent .net-consent-body > p');
  if (netConsentPs[0] && T.netConsentBody1) netConsentPs[0].innerHTML = T.netConsentBody1;
  if (netConsentPs[1] && T.netConsentBodyIntro) netConsentPs[1].textContent = T.netConsentBodyIntro;
  const netConsentLis = document.querySelectorAll('#netConsent .net-consent-body > ul > li');
  [T.netConsentLi1, T.netConsentLi2, T.netConsentLi3].forEach((txt, i) => {
    if (netConsentLis[i] && txt) {
      // Preserve inner <a> links
      const a = netConsentLis[i].querySelector('a');
      netConsentLis[i].textContent = txt;
      if (a && txt.includes("User Agreement")) {
        netConsentLis[i].innerHTML = txt.replace("LinkedIn's User Agreement", `LinkedIn's <a href="https://www.linkedin.com/legal/user-agreement" target="_blank" rel="noopener noreferrer">User Agreement</a>`);
      }
    }
  });
  const netConsentNote = document.querySelector('#netConsent .net-consent-note');
  if (netConsentNote && T.netConsentNote) netConsentNote.textContent = T.netConsentNote;
  const netObTitle = document.querySelector('.net-ob-title');
  if (netObTitle && T.netObTitle) netObTitle.textContent = T.netObTitle;
  const netObHint = document.querySelector('.net-ob-hint');
  if (netObHint && T.netObHint) netObHint.textContent = T.netObHint;
  setPlaceholder('netIndustry', 'netIndustryPlaceholder');
  setPlaceholder('netJobTitle', 'netJobTitlePlaceholder');
  setText('netSaveGoalBtn', 'netSaveGoalBtn');
  const netScanBtn = $('netScanBtn');
  if (netScanBtn && T.netScanBtn != null) {
    const svg = netScanBtn.querySelector('svg')?.cloneNode(true);
    netScanBtn.textContent = T.netScanBtn;
    if (svg) netScanBtn.prepend(svg);
  }
  const netScanHint = document.querySelector('.net-scan-hint');
  if (netScanHint && T.netScanHint) netScanHint.textContent = T.netScanHint;
  setText('netChangeGoalBtn', 'netChangeGoalBtn');
  setText('netBulkCopy', 'netBulkCopy');
  setText('netBulkSkip', 'netBulkSkip');
  setText('netBulkClear', 'netBulkClear');

  // Networking goal labels
  document.querySelectorAll('.net-goal-opt').forEach(opt => {
    const radio = opt.querySelector('input[type="radio"]');
    const val = radio?.value;
    if (!val) return;
    const lbl = opt.querySelector('.net-goal-label');
    const desc = opt.querySelector('.net-goal-desc');
    if (lbl && T['netGoal_' + val] != null) lbl.textContent = T['netGoal_' + val];
    if (desc && T['netGoalDesc_' + val] != null) desc.textContent = T['netGoalDesc_' + val];
  });
  // Networking form labels (no for="" attribute — target by select id)
  [['netIndustry','netIndustryLabel'],['netJobTitle','netJobTitleLabel'],['netSeniority','netSeniorityLabel']].forEach(([selId, key]) => {
    const sel = $(selId); if (!sel) return;
    const fg = sel.closest('.form-group'); if (!fg) return;
    const lbl = fg.querySelector('label');
    if (lbl && T[key] != null) lbl.textContent = T[key];
  });
  setOpt('netSeniority', 'junior',    'netSeniority_junior');
  setOpt('netSeniority', 'mid',       'netSeniority_mid');
  setOpt('netSeniority', 'senior',    'netSeniority_senior');
  setOpt('netSeniority', 'executive', 'netSeniority_executive');

  // ── Gap Analysis page ─────────────────────────────────────────
  const gapConsentTitle = document.querySelector('#gapConsent .net-consent-title');
  if (gapConsentTitle && T.gapConsentTitle) gapConsentTitle.textContent = T.gapConsentTitle;
  const gapConsentCheckLabel = document.querySelector('#gapConsent .net-consent-check');
  if (gapConsentCheckLabel && T.gapConsentCheck != null) {
    const cb = gapConsentCheckLabel.querySelector('input');
    gapConsentCheckLabel.textContent = ' ' + T.gapConsentCheck;
    if (cb) gapConsentCheckLabel.prepend(cb);
  }
  setText('gapConsentAcceptBtn', 'gapConsentAcceptBtn');
  // Gap consent subtitle + body
  const gapConsentSubtitle = document.querySelector('#gapConsent .net-consent-subtitle');
  if (gapConsentSubtitle && T.gapConsentSubtitle) gapConsentSubtitle.textContent = T.gapConsentSubtitle;
  const gapConsentPs = document.querySelectorAll('#gapConsent .net-consent-body > p');
  if (gapConsentPs[0] && T.gapConsentBody1) gapConsentPs[0].innerHTML = T.gapConsentBody1;
  if (gapConsentPs[1] && T.gapConsentBodyIntro) gapConsentPs[1].textContent = T.gapConsentBodyIntro;
  const gapConsentLis = document.querySelectorAll('#gapConsent .net-consent-body > ul > li');
  [T.gapConsentLi1, T.gapConsentLi2, T.gapConsentLi3, T.gapConsentLi4].forEach((txt, i) => {
    if (gapConsentLis[i] && txt) {
      const a = gapConsentLis[i].querySelector('a');
      gapConsentLis[i].textContent = txt;
      if (a && txt.includes("User Agreement")) {
        gapConsentLis[i].innerHTML = txt.replace("LinkedIn's User Agreement", `LinkedIn's <a href="https://www.linkedin.com/legal/user-agreement" target="_blank" rel="noopener noreferrer">User Agreement</a>`);
      }
    }
  });
  const gapConsentNote = document.querySelector('#gapConsent .net-consent-note');
  if (gapConsentNote && T.gapConsentNote) gapConsentNote.textContent = T.gapConsentNote;
  const gapIdleTitle = document.querySelector('.gap-idle-title');
  if (gapIdleTitle && T.gapIdleTitle) gapIdleTitle.textContent = T.gapIdleTitle;
  // Mode tabs
  setText('gapModeProfile', 'gapModeProfile');
  setText('gapModeJob',     'gapModeJob');
  // Idle hints & buttons
  setText('gapIdleHint', 'gapIdleHint');
  setText('gapScrapeBtn', 'gapScrapeBtn');
  const gapJDHint = document.querySelector('#gapModeJDPanel .gap-idle-hint');
  if (gapJDHint && T.gapJDHint) gapJDHint.textContent = T.gapJDHint;
  setPlaceholder('gapJDInput', 'gapJDPlaceholder');
  setPlaceholder('gapJDRole',  'gapJDRolePlaceholder');
  setText('gapJDAnalyzeBtn', 'gapJDAnalyzeBtn');
  setText('gapJobHint', 'gapJobHint');
  const gapJobHint = document.querySelector('#gapModeJobPanel .gap-idle-hint');
  if (gapJobHint && T.gapJobHint) gapJobHint.textContent = T.gapJobHint;
  setText('gapJobScrapeBtn',  'gapJobScrapeBtn');
  setText('gapJobAnalyzeBtn', 'gapJobAnalyzeBtn');
  setText('gapAnalyzeBtn',    'gapAnalyzeBtn');
  setText('gapRescrapeBtn',   'gapRescrapeBtn');
  // Loading text (has a spinner span inside — update only text node)
  const gapLoading = $('gapLoading');
  if (gapLoading && T.gapLoadingText) {
    const textNode = [...gapLoading.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
    if (textNode) textNode.textContent = ' ' + T.gapLoadingText;
  }
  // Result section titles (static .gap-section-title elements)
  const gapSectionTitleMap = [
    ['gapPowerMetrics', 'gapSecPowerIndex'],
    ['gapH2H',          'gapSecH2H'],
    ['gapSkillHeatmap', 'gapSecSkillHeatmap'],
    ['gapRecruiter',    'gapSecRecruiter'],
    ['gapInterviewPrepSection', 'gapSecInterviewPrep'],
  ];
  gapSectionTitleMap.forEach(([parentId, key]) => {
    const el = $(`${parentId}`)?.querySelector('.gap-section-title');
    if (el && T[key]) el.textContent = T[key];
  });
  // Quick Wins and Connection Strategy are in .gap-section (no id), match by current content
  document.querySelectorAll('.gap-section-title').forEach(el => {
    const txt = el.textContent.trim();
    const map = {
      'Quick Wins': 'gapSecQuickWins', 'Gains rapides': 'gapSecQuickWins',
      'Connection Strategy': 'gapSecStrategy', 'Stratégie de connexion': 'gapSecStrategy',
    };
    if (map[txt] && T[map[txt]]) el.textContent = T[map[txt]];
  });
  // Power metric labels
  const pwrLabels = document.querySelectorAll('#gapPowerMetrics .gap-power-label');
  const pwrKeys = ['gapPwrCompleteness','gapPwrKeywords','gapPwrNarrative','gapPwrTrajectory','gapPwrNetwork'];
  pwrLabels.forEach((el, i) => { if (pwrKeys[i] && T[pwrKeys[i]]) el.textContent = T[pwrKeys[i]]; });
  // Power legend
  const legendYou = document.querySelector('#gapPowerMetrics .gap-legend-you');
  const legendThem = document.querySelector('#gapPowerMetrics .gap-legend-them');
  if (legendYou && T.gapPwrLegendYou) legendYou.textContent = T.gapPwrLegendYou;
  if (legendThem && T.gapPwrLegendThem) legendThem.textContent = T.gapPwrLegendThem;
  // H2H column titles
  const h2hUser = document.querySelector('#gapH2H .gap-h2h-wins .gap-h2h-col-title');
  const h2hThem = document.querySelector('#gapH2H .gap-h2h-losses .gap-h2h-col-title');
  if (h2hUser && T.gapH2HUserWins) h2hUser.textContent = T.gapH2HUserWins;
  if (h2hThem && T.gapH2HTargetWins) h2hThem.textContent = T.gapH2HTargetWins;
  // Compare grid section labels
  document.querySelectorAll('#gapCompareGrid .gap-compare-row').forEach(row => {
    const sec = row.getAttribute('data-section');
    const map = { headline:'gapCompHeadline', about:'gapCompAbout', experience:'gapCompExperience', education:'gapCompEducation', skills:'gapCompSkills', content:'gapCompContent' };
    const lbl = row.querySelector('.gap-compare-label');
    if (lbl && map[sec] && T[map[sec]]) lbl.textContent = T[map[sec]];
  });
  // Gap result action buttons
  setText('gapInterviewBtn',  'gapInterviewBtn');
  setText('gapExportBtn',     'gapExportBtn');
  setText('gapResetBtn',      'gapResetBtn');
  setText('gapCacheTag',      'gapCachedResult');
  // Job Fit section titles
  const jfTitleMap = [
    ['jfFitSection',      'jfSecFit'],
    ['jfCriticalGaps',    'jfSecCritical'],
    ['jfNiceGaps',        'jfSecNice'],
    ['jfRoleAnalysis',    'jfSecRole'],
    ['jfPrioritySection', 'jfSecPriority'],
    ['jfInterviewSection','jfSecInterview'],
    ['jfCoverSection',    'jfSecCover'],
    ['jfRedFlags',        'jfSecRedFlags'],
  ];
  jfTitleMap.forEach(([parentId, key]) => {
    const el = $(`${parentId}`)?.querySelector('.jf-section-title');
    if (el && T[key]) el.textContent = T[key];
  });
  // CV Tailoring toggle (has a <span> for +/- icon — preserve it)
  const jfCVToggle = $('jfCVToggle');
  if (jfCVToggle && T.jfSecCV) {
    const icon = jfCVToggle.querySelector('.jf-toggle-icon');
    jfCVToggle.textContent = T.jfSecCV + ' ';
    if (icon) jfCVToggle.appendChild(icon);
  }
  setText('jfPdfBtn',   'jfPdfBtn');
  setText('jfResetBtn', 'jfResetBtn');

  // ── Settings page ─────────────────────────────────────────────
  document.querySelectorAll('#page-settings .settings-section-label').forEach(el => {
    const text = el.textContent.trim().toLowerCase();
    if (text === 'display' || text === 'affichage') el.textContent = T.settingsDisplay ?? el.textContent;
    if (text === 'profile' || text === 'profil') el.textContent = T.settingsProfile ?? el.textContent;
    if (text === 'about' || text === 'à propos' || text === 'about') el.textContent = T.settingsAboutLabel ?? el.textContent;
    if (text === 'help' || text === 'aide') el.textContent = T.settingsHelp ?? el.textContent;
    if (text === 'legal' || text === 'mentions légales') el.textContent = T.settingsLegal ?? el.textContent;
  });
  // Notifications toggle label
  const notifSpan = document.querySelector('#page-settings .settings-toggle-row span:not(:first-child), #page-settings label[for="settingsNotifEnabled"] span');
  // Find the span wrapping "Enable email notifications"
  document.querySelectorAll('#page-settings .settings-toggle-row span').forEach(sp => {
    if (sp.textContent.includes('email notif') || sp.textContent.includes('notifications par')) {
      if (T.settingsNotifLabel) sp.textContent = T.settingsNotifLabel;
    }
  });
  // "Notify me when:" hint
  const snHint = document.querySelector('.sn-hint');
  if (snHint && T.settingsNotifWhen) snHint.textContent = T.settingsNotifWhen;
  // Notification event labels
  const snLabelMap = {
    'profile_extracted': 'settingsNotifEventProfileExtracted',
    'ai_score':          'settingsNotifEventAiScore',
    'networking_analysis': 'settingsNotifEventNetworking',
    'gap_analysis':      'settingsNotifEventGap',
  };
  document.querySelectorAll('.settings-notif-event').forEach(cb => {
    const key = snLabelMap[cb.dataset.event];
    if (!key || !T[key]) return;
    const lbl = cb.closest('.sn-item')?.querySelector('.sn-label');
    if (lbl) lbl.textContent = T[key];
  });
  // Saved text
  const notifStatus = $('settingsNotifStatus');
  if (notifStatus && T.settingsNotifSaved) {
    // Only update the text node (not the element itself) to preserve style
    const textNode = [...notifStatus.childNodes].find(n => n.nodeType === 3);
    if (textNode) textNode.textContent = T.settingsNotifSaved;
    else notifStatus.textContent = T.settingsNotifSaved;
  }
  // Replay tour & Privacy Policy
  setText('replayTourBtn', 'settingsReplayTour');
  const privacyLink = $('privacyPolicyLink');
  if (privacyLink && T.settingsPrivacyPolicy) privacyLink.textContent = T.settingsPrivacyPolicy;
  const dmLabel = document.querySelector('.settings-toggle-row span:first-child');
  if (dmLabel && T.settingsDarkModeLabel) dmLabel.textContent = T.settingsDarkModeLabel;
  setText('settingsLanguageLabel', 'settingsLanguage');
  setText('settingsEditProfile', 'settingsEditProfile');
  if ($('settingsProfileName')?.textContent?.trim() === 'No profile saved' || $('settingsProfileName')?.textContent?.trim() === 'Aucun profil enregistré') {
    setText('settingsProfileName', 'settingsNoProfile');
  }

  // ── Edit Profile page ─────────────────────────────────────────
  setPlaceholder('editName',      'editNamePlaceholder');
  setPlaceholder('editLocation',  'editLocationPlaceholder');
  setPlaceholder('editHeadline',  'editHeadlinePlaceholder');
  setPlaceholder('editRole',      'editRolePlaceholder');
  setPlaceholder('editCompany',   'editCompanyPlaceholder');
  setPlaceholder('editAbout',     'editAboutPlaceholder');
  setPlaceholder('editSkills',    'editSkillsPlaceholder');
  setPlaceholder('editExperience','editExpPlaceholder');
  setText('editSaveBtn',   'editSaveBtn');
  setText('editCancelBtn', 'editCancelBtn');
  // Edit page form labels
  [
    ['editName',       'editNameLabel'],
    ['editLocation',   'editLocationLabel'],
    ['editHeadline',   'editHeadlineLabel'],
    ['editRole',       'editRoleLabel'],
    ['editCompany',    'editCompanyLabel'],
    ['editAbout',      'editAboutLabel'],
    ['editSkills',     'editSkillsLabel'],
    ['editExperience', 'editExpLabel'],
  ].forEach(([inputId, key]) => {
    const lbl = document.querySelector(`label[for="${inputId}"]`);
    if (!lbl || T[key] == null) return;
    const firstText = [...lbl.childNodes].find(n => n.nodeType === 3);
    if (firstText) firstText.textContent = T[key] + ' ';
  });
  // Hint spans inside edit labels
  const skillsHint = document.querySelector('#page-edit label[for="editSkills"] .edit-hint-inline');
  if (skillsHint && T.editSkillsHint) skillsHint.textContent = T.editSkillsHint;
  const expHint = document.querySelector('#page-edit label[for="editExperience"] .edit-hint-inline');
  if (expHint && T.editExpHint) expHint.textContent = T.editExpHint;

  // ── Chat page ─────────────────────────────────────────────────
  const chatSubtitle = document.querySelector('.chat-subtitle-sm');
  if (chatSubtitle && T.chatSubtitle) chatSubtitle.textContent = T.chatSubtitle;
  setPlaceholder('chatInput', 'chatInputPlaceholder');
  const chatHint = document.querySelector('.chat-hint');
  if (chatHint && T.chatHint) chatHint.textContent = T.chatHint;
  setText('chatSendBtn', 'chatSendBtn');

  // ── Profile extraction consent (pcConsent) ───────────────────
  const pcConsentTitleEl = document.querySelector('#pcConsent .net-consent-title');
  if (pcConsentTitleEl && T.pcConsentTitle) pcConsentTitleEl.textContent = T.pcConsentTitle;
  const pcPs = document.querySelectorAll('#pcConsent .net-consent-body > p');
  if (pcPs[0] && T.pcConsentBody1) pcPs[0].innerHTML = T.pcConsentBody1;
  if (pcPs[1] && T.pcConsentBodyIntro) pcPs[1].textContent = T.pcConsentBodyIntro;
  const pcLis = document.querySelectorAll('#pcConsent .net-consent-body > ul > li');
  [T.pcConsentLi1, T.pcConsentLi2, T.pcConsentLi3, T.pcConsentLi4].forEach((txt, i) => {
    if (pcLis[i] && txt) {
      const a = pcLis[i].querySelector('a');
      pcLis[i].textContent = txt;
      if (a && txt.includes("User Agreement")) {
        pcLis[i].innerHTML = txt.replace("LinkedIn's User Agreement", `LinkedIn's <a href="https://www.linkedin.com/legal/user-agreement" target="_blank" rel="noopener noreferrer">User Agreement</a>`);
      }
    }
  });
  setText('consentAllowBtn', 'pcConsentAllowBtn');
  setText('consentSkipBtn',  'pcConsentSkipBtn');

  // ── EWM (extraction wizard modal) ────────────────────────────
  const ewmTitleEl = document.querySelector('.ewm-title');
  if (ewmTitleEl && T.ewmTitle) ewmTitleEl.textContent = T.ewmTitle;
  const ewmSteps = document.querySelectorAll('.ewm-steps li > span:last-child');
  if (ewmSteps[0] && T.ewmStep1) ewmSteps[0].innerHTML = T.ewmStep1.replace('scroll all the way to the bottom', '<strong>scroll all the way to the bottom</strong>').replace('faites défiler la page jusqu\'en bas', '<strong>faites défiler la page jusqu\'en bas</strong>');
  if (ewmSteps[1] && T.ewmStep2) ewmSteps[1].innerHTML = T.ewmStep2.replace('"Start Extraction"', '<strong>"Start Extraction"</strong>').replace('"Lancer l\'extraction"', '<strong>"Lancer l\'extraction"</strong>');
  if (ewmSteps[2] && T.ewmStep3) ewmSteps[2].innerHTML = T.ewmStep3.replace('Do NOT', '<strong>Do NOT</strong>').replace('NE changez PAS', '<strong>NE changez PAS</strong>');

  setText('ewmCancelBtn', 'ewmCancelBtn');
  setText('ewmStartBtn',  'ewmStartBtn');

  // ── Auth gate ─────────────────────────────────────────────────
  const authGateSub = document.querySelector('.auth-gate-sub');
  if (authGateSub && T.authGateSub) authGateSub.textContent = T.authGateSub;
  const tabSignIn = document.getElementById('tabSignIn');
  if (tabSignIn && T.authTabSignIn) tabSignIn.textContent = T.authTabSignIn;
  setPlaceholder('authEmail', 'authEmailPlaceholder');
  setPlaceholder('authPassword', 'authPasswordPlaceholder');
  const authSubmitBtn = document.getElementById('authSubmitBtn');
  if (authSubmitBtn && T.authSubmitBtn) authSubmitBtn.textContent = T.authSubmitBtn;
  const authSubulBtn = document.getElementById('authSubulBtn');
  if (authSubulBtn && T.authSubulBtnText) {
    const svg = authSubulBtn.querySelector('svg')?.cloneNode(true);
    authSubulBtn.textContent = ' ' + T.authSubulBtnText;
    if (svg) authSubulBtn.prepend(svg);
  }
  setPlaceholder('subulEmail', 'subulEmailPlaceholder');
  setPlaceholder('subulPassword', 'subulPasswordPlaceholder');
  const subulConnectBtn = document.getElementById('subulSubmitBtn');
  if (subulConnectBtn && T.subulConnectBtn) subulConnectBtn.textContent = T.subulConnectBtn;
  const subulBackBtnEl = document.getElementById('subulBackBtn');
  if (subulBackBtnEl && T.subulBackBtn) subulBackBtnEl.textContent = T.subulBackBtn;

  // ── Generic data-i18n sweep ──────────────────────────────────
  // Handles all elements with data-i18n (text) or data-i18n-html (innerHTML)
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (T[key] !== undefined) el.textContent = T[key];
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    if (T[key] !== undefined) el.innerHTML = T[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (T[key] !== undefined) el.placeholder = T[key];
  });

  // ── Gap consent list items (contain <strong> tags) ────────────
  const gapLis = document.querySelectorAll('#gapConsent .net-consent-body ul li');
  const gapLiKeys = ['gapConsentLi1','gapConsentLi2','gapConsentLi3','gapConsentLi4'];
  gapLis.forEach((li, i) => { if (gapLiKeys[i] && T[gapLiKeys[i]]) li.innerHTML = T[gapLiKeys[i]]; });

  // ── EWM steps (contain <strong> tags) ─────────────────────────
  const ewmLis = document.querySelectorAll('.ewm-steps li span:last-child');
  const ewmStepKeys = ['ewmStep1','ewmStep2','ewmStep3'];
  ewmLis.forEach((span, i) => { if (ewmStepKeys[i] && T[ewmStepKeys[i]]) span.innerHTML = T[ewmStepKeys[i]]; });

  // ── EWM privacy rows ─────────────────────────────────────────
  const ewmPrivRows = document.querySelectorAll('.ewm-privacy-row span');
  const ewmPrivKeys = ['ewmPrivacy1','ewmPrivacy2','ewmPrivacy3'];
  ewmPrivRows.forEach((span, i) => { if (ewmPrivKeys[i] && T[ewmPrivKeys[i]]) span.innerHTML = T[ewmPrivKeys[i]]; });

  // ── Subul page ────────────────────────────────────────────────
  const subulRefreshBtn = document.getElementById('subulRefreshBtn');
  if (subulRefreshBtn && T.subulSyncNow) subulRefreshBtn.title = T.subulSyncNow;
  const certLbl = document.querySelector('#subulCounts .subul-count-card:nth-child(1) .subul-count-lbl');
  if (certLbl && T.subulCountCerts) certLbl.textContent = T.subulCountCerts;
  const labLbl = document.querySelector('#subulCounts .subul-count-card:nth-child(2) .subul-count-lbl');
  if (labLbl && T.subulCountLabs) labLbl.textContent = T.subulCountLabs;
  const certsSecTitle = document.querySelector('#subulCertsSection .subul-section-title');
  if (certsSecTitle) {
    const hint = certsSecTitle.querySelector('span');
    const textNode = [...certsSecTitle.childNodes].find(n => n.nodeType === 3);
    if (T.subulSectionCerts && textNode) textNode.textContent = T.subulSectionCerts + ' ';
    if (T.subulSectionCertsHint && hint) hint.textContent = T.subulSectionCertsHint;
  }
  const labsSecTitle = document.querySelector('#subulLabsSection .subul-section-title');
  if (labsSecTitle) {
    const hint = labsSecTitle.querySelector('span');
    const textNode = [...labsSecTitle.childNodes].find(n => n.nodeType === 3);
    if (T.subulSectionLabs && textNode) textNode.textContent = T.subulSectionLabs + ' ';
    if (T.subulSectionLabsHint && hint) hint.textContent = T.subulSectionLabsHint;
  }
}

// ══════════════════════════════════════
//  CHAT ASSISTANT
// ══════════════════════════════════════

let chatOpen = false;
let chatMsgCounter = 0;
let _chatHistory = []; // conversation history for context: [{role: "user"|"assistant", content}]

const _CHAT_STORAGE_KEY = 'chatHistory';
const _CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function _saveChatHistory() {
  try {
    await chrome.storage.local.set({
      [_CHAT_STORAGE_KEY]: { entries: _chatHistory, savedAt: Date.now() }
    });
  } catch {}
}

async function _loadChatHistory() {
  try {
    const res = await chrome.storage.local.get(_CHAT_STORAGE_KEY);
    const data = res[_CHAT_STORAGE_KEY];
    if (data && data.entries && (Date.now() - data.savedAt) < _CHAT_TTL_MS) {
      return data.entries;
    }
  } catch {}
  return [];
}

// Clears in-memory history, persisted storage, and the rendered messages,
// then shows the welcome message + suggestions again — like starting a
// fresh conversation. Older messages are not sent as context after this.
async function _clearChatHistory() {
  _chatHistory = [];
  try {
    await chrome.storage.local.remove(_CHAT_STORAGE_KEY);
  } catch {}
  const msgs = document.getElementById('chatMessages');
  if (msgs) msgs.innerHTML = '';
  appendChatBubble('ai', "Hi! I'm your LinkedIn AI copilot. Ask me to write a post, improve your profile, or explain how any feature works. Not sure where to start? Tap a suggestion below.");
  _renderChatSuggestions();
}

const _CHAT_SUGGESTIONS = [
  'How do I use the extension?',
  'Write a post about my latest project',
  'Improve my LinkedIn headline',
  'How does Network Scan work?',
  'What should I improve first?',
];

function _renderChatSuggestions() {
  const msgs = document.getElementById('chatMessages');
  const wrap = document.createElement('div');
  wrap.id = 'chatSuggestions';
  wrap.className = 'chat-suggestions';
  _CHAT_SUGGESTIONS.forEach(label => {
    const btn = document.createElement('button');
    btn.className = 'chat-suggestion-chip';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      wrap.remove();
      document.getElementById('chatInput').value = label;
      sendChatMessage();
    });
    wrap.appendChild(btn);
  });
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
}

async function initChat() {
  // Guard: only attach listeners once even if called multiple times
  if (initChat._done) return;
  initChat._done = true;

  document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
  document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  // Auto-resize textarea
  document.getElementById('chatInput').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 80) + 'px';
  });

  // Guide panel toggle
  const guideBtn = document.getElementById('chatGuideBtn');
  const guidePanel = document.getElementById('chatGuidePanel');
  const guideClose = document.getElementById('chatGuideClose');
  if (guideBtn && guidePanel) {
    guideBtn.addEventListener('click', () => {
      // Use computed style so an initial empty `style.display` ('') is read as visible
      // only when the stylesheet actually renders it. HTML sets inline `display:none`,
      // so the very first click will correctly open it.
      const isHidden = getComputedStyle(guidePanel).display === 'none';
      guidePanel.style.display = isHidden ? 'block' : 'none';
      guideBtn.classList.toggle('active', isHidden);
    });
  }
  if (guideClose && guidePanel) {
    guideClose.addEventListener('click', () => {
      guidePanel.style.display = 'none';
      guideBtn?.classList.remove('active');
    });
  }

  // New Chat — clears local history/storage and resets the conversation
  const newChatBtn = document.getElementById('chatNewBtn');
  if (newChatBtn) {
    newChatBtn.addEventListener('click', async () => {
      if (_chatHistory.length === 0) return; // nothing to clear
      const ok = await confirmDialog(
        'Start New Chat',
        'This will clear the current conversation. This cannot be undone.',
        { okText: 'Start New Chat', danger: true }
      );
      if (!ok) return;
      await _clearChatHistory();
    });
  }
  // Clicking a guide example actually sends it — no more silent prefill
  guidePanel?.querySelectorAll('.chat-guide-item').forEach(item => {
    item.style.cursor = 'pointer';
    item.addEventListener('click', () => {
      const descEl = item.querySelector('.chat-guide-item-desc');
      const raw = (descEl?.textContent || '').trim();
      const text = raw.replace(/^[""'"`]+|[""'"`]+$/g, '').trim();
      if (!text) return;
      guidePanel.style.display = 'none';
      guideBtn?.classList.remove('active');
      const input = document.getElementById('chatInput');
      input.value = text;
      sendChatMessage();
    });
  });

  // Load persisted history
  const saved = await _loadChatHistory();
  if (saved.length > 0) {
    _chatHistory = saved;
    // Replay messages in DOM
    saved.forEach(entry => {
      appendChatBubble(entry.role === 'user' ? 'user' : 'ai', entry.content);
    });
  } else {
    appendChatBubble('ai', "Hi! I'm your LinkedIn AI copilot. Ask me to write a post, improve your profile, or explain how any feature works. Not sure where to start? Tap a suggestion below.");
    _renderChatSuggestions();
  }
}

function toggleChat() {
  navigateTo('chat');
}

function openChat() {
  chatOpen = true;
  navigateTo('chat');
  setTimeout(() => document.getElementById('chatInput').focus(), 200);
}

function closeChat() {
  chatOpen = false;
  navigateTo('home');
}

function appendChatBubble(role, text, isTyping = false, type = null) {
  const msgs = document.getElementById('chatMessages');
  const id = 'cb-' + (++chatMsgCounter);
  const div = document.createElement('div');
  div.id = id;

  if (isTyping) {
    div.className = 'chat-bubble chat-bubble-ai chat-typing';
    div.innerHTML = '<span></span><span></span><span></span>';
  } else if (type === 'post') {
    div.className = 'chat-bubble chat-bubble-post';
    div.textContent = text;
  } else {
    div.className = `chat-bubble chat-bubble-${role}`;
    div.textContent = text;
  }

  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;

  if (_currentPage !== 'chat' && role === 'ai') {
    // Chat has unread — no floating button in new design, but we could add a badge later
  }
  return id;
}

function removeChatBubble(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function formatProfileForChat(key, val) {
  const label = fmtKey(key);
  if (key === 'experience' && Array.isArray(val)) {
    const lines = val.map(e => {
      let s = `${e.title || ''}${e.company ? ' at ' + e.company : ''}`;
      if (Array.isArray(e.bullets) && e.bullets.length > 0) {
        s += '\n' + e.bullets.map(b => `• ${b}`).join('\n');
      }
      return s;
    }).join('\n\n');
    return `── ${label} ──\n${lines}`;
  }
  if (key === 'skills' && typeof val === 'object' && !Array.isArray(val)) {
    const parts = [`── ${label} ──`];
    if (val.existing?.length) parts.push(`Your skills:\n${val.existing.join(' · ')}`);
    if (val.suggestions?.length) parts.push(`Suggested to add:\n${val.suggestions.join(' · ')}`);
    return parts.join('\n');
  }
  if (typeof val === 'string') return `── ${label} ──\n${val}`;
  return null;
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  appendChatBubble('user', text);

  // Remove suggestion chips when user first types
  const suggestionsEl = document.getElementById('chatSuggestions');
  if (suggestionsEl) suggestionsEl.remove();

  // Track conversation history (cap at 20 entries = 10 exchanges)
  _chatHistory.push({ role: 'user', content: text });
  if (_chatHistory.length > 20) _chatHistory = _chatHistory.slice(-20);

  const sendBtn = document.getElementById('chatSendBtn');
  sendBtn.disabled = true;

  const typingId = appendChatBubble('ai', '', true);

  try {
    // Route the message (slim profile — only fields the router actually reads)
    const slimProfile = profile ? {
      name: profile.name || '',
      headline: profile.headline || '',
      currentRole: profile.currentRole || '',
      skills: Array.isArray(profile.skills) ? profile.skills.slice(0, 8) : [],
    } : {};

    // If a recent gap analysis exists, pass a compact summary so help replies can reference it.
    let gapSummary = null;
    try {
      const { _lastGapAnalysis } = await chrome.storage.local.get('_lastGapAnalysis');
      if (_lastGapAnalysis?.data && (Date.now() - (_lastGapAnalysis.ts || 0)) < 24*60*60*1000) {
        const d = _lastGapAnalysis.data;
        const secs = d.sections || {};
        const topGaps = Object.entries(secs)
          .map(([k, v]) => [k, (v.user_score ?? 0) - (v.target_score ?? 0)])
          .sort((a, b) => a[1] - b[1])
          .slice(0, 3)
          .map(([k]) => k);
        gapSummary = {
          overall_score: d.overall_gap_score,
          score_label: d.score_label,
          top_gaps: topGaps,
          target_name: _lastGapAnalysis.target?.name || '',
        };
      }
    } catch {}

    const routeRes = await chrome.runtime.sendMessage({
      action: 'routeChat',
      data: {
        message: text,
        profile: slimProfile,
        history: _chatHistory.slice(0, -1),
        ui_lang: window._uiLang || 'en',
        gap_summary: gapSummary,
      },
    });

    removeChatBubble(typingId);

    if (!routeRes.success) {
      appendChatBubble('ai', 'Error: ' + routeRes.error);
      return;
    }

    const route = routeRes.data;
    const replyText = route.reply || 'On it!';
    const isActionIntent = route.intent === 'post' || route.intent === 'profile' || route.intent === 'networking';

    // For help/conversation: the reply IS the full answer — show it and stop.
    if (route.intent === 'help' || route.intent === 'conversation') {
      appendChatBubble('ai', replyText);
      _chatHistory.push({ role: 'assistant', content: replyText });
      if (_chatHistory.length > 20) _chatHistory = _chatHistory.slice(-20);
      _saveChatHistory();
      return;
    }

    // For action intents (post/profile/networking): show only a short acknowledgment,
    // NOT the AI's potentially confused clarifying reply.
    // This stops the loop where the AI asks "Could you share more?" before generating.
    const actionAck = isActionIntent ? (replyText.split(' ').length <= 10 ? replyText : 'On it!') : replyText;
    appendChatBubble('ai', actionAck);
    // NOTE: do NOT store action acks in _chatHistory — they pollute context
    // and cause the AI to misinterpret the next message as a follow-up.
    // History is saved after the real result (post/profile) is generated below.

    if (route.intent === 'post') {
      // Guard: topic must be a non-empty string — 422 error occurs when topic is null
      const topic = (route.topic || '').trim() || text || (profile?.headline || 'my professional journey');
      const typingId2 = appendChatBubble('ai', '', true);
      const postData = Object.assign({}, route, {
        topic,
        about:      (profile?.about || '').slice(0, 200),
        experience: (profile?.experience || []).slice(0, 3),
        skills:     (profile?.skills || []).slice(0, 10),
        industry:   profile?.industry || profile?.company || '',
      });
      const postRes = await chrome.runtime.sendMessage({ action: 'generatePost', data: postData });
      removeChatBubble(typingId2);
      if (postRes.success) {
        appendChatBubble('ai', postRes.data, false, 'post');
        document.getElementById('postOutText').value = postRes.data;
        document.getElementById('postOutText').readOnly = true;
        document.getElementById('postOutMeta').textContent = `${postRes.data.length} chars · ${postRes.data.split(/\s+/).filter(Boolean).length} words`;
        document.getElementById('postOutBox').style.display = 'block';
        appendChatBubble('ai', 'Done! Also saved to the Post tab — copy and paste it into LinkedIn.');
        _chatHistory.push({ role: 'assistant', content: `Generated a LinkedIn post about: ${topic}` });
        if (_chatHistory.length > 20) _chatHistory = _chatHistory.slice(-20);
        _saveChatHistory();
      } else {
        appendChatBubble('ai', 'Error generating post: ' + postRes.error);
      }

    } else if (route.intent === 'networking') {
      const typingId2 = appendChatBubble('ai', '', true);
      const netRes = await chrome.runtime.sendMessage({
        action: 'networkingChat',
        data: {
          message: text,
          user_profile: window._lastNetGoal || null,
          recent_candidates: (window._lastNetCandidates || []).slice(0, 8),
          goal: window._lastNetGoal?.goal || 'job_search',
        },
      });
      removeChatBubble(typingId2);
      if (netRes?.success) {
        const netReply = netRes.data?.reply || netRes.data || '';
        appendChatBubble('ai', netReply);
        _chatHistory.push({ role: 'assistant', content: netReply });
        if (_chatHistory.length > 20) _chatHistory = _chatHistory.slice(-20);
        _saveChatHistory();
      } else {
        appendChatBubble('ai', 'Error: ' + (netRes?.error || 'Networking advisor unavailable'));
      }

    } else if (route.intent === 'profile') {
      // FIX: Guard against empty fields array — infer from the user's raw message
      // so "rewrite my headline" never accidentally generates about/experience too.
      if (!route.fields || route.fields.length === 0) {
        const msgLower = text.toLowerCase();
        const inferredFields = [];
        if (/headline|titre|titolo|überschrift/.test(msgLower)) inferredFields.push('headline');
        if (/about|summary|résumé|bio|à propos/.test(msgLower)) inferredFields.push('about');
        if (/experience|expérience|job|role|poste/.test(msgLower)) inferredFields.push('experience');
        if (/skill|compétence|habilidad|competenza/.test(msgLower)) inferredFields.push('skills');
        route.fields = inferredFields.length > 0 ? inferredFields : ['headline', 'about'];
      }
      // If user only asked for headline, make sure about isn't included
      const onlyHeadline = route.fields.length === 1 && route.fields[0] === 'headline';

      const typingId2 = appendChatBubble('ai', '', true);
      const profRes = await chrome.runtime.sendMessage({ action: 'generateProfile', data: route });
      removeChatBubble(typingId2);
      if (profRes.success) {
        // Render the result only in chat — don't silently update the Profile tab
        // (that caused a blank-looking state confusing users)
        try {
          const clean = profRes.data.replace(/```json\s*/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(clean);
          let rendered = false;
          for (const [key, val] of Object.entries(parsed)) {
            if (route.fields && route.fields.length > 0 && !route.fields.includes(key)) continue;
            const formatted = formatProfileForChat(key, val);
            if (formatted) { appendChatBubble('ai', formatted, false, 'post'); rendered = true; }
          }
          if (!rendered) appendChatBubble('ai', profRes.data, false, 'post');
        } catch {
          appendChatBubble('ai', profRes.data, false, 'post');
        }
        const profDoneMsg = onlyHeadline
          ? "Here's your new headline — copy it and paste it on LinkedIn!"
          : 'Done! Copy the sections above and paste them into your LinkedIn profile.';
        appendChatBubble('ai', profDoneMsg);
        _chatHistory.push({ role: 'assistant', content: `Rewrote profile sections: ${(route.fields || []).join(', ')}` });
        if (_chatHistory.length > 20) _chatHistory = _chatHistory.slice(-20);
        _saveChatHistory();
        // Also update Profile tab silently in background (no navigation)
        try { showProfileOutput(profRes.data, route.fields || []); } catch { /* noop */ }
      } else {
        appendChatBubble('ai', 'Error generating profile content: ' + profRes.error);
      }
    }

  } catch (e) {
    removeChatBubble(typingId);
    appendChatBubble('ai', 'Something went wrong: ' + e.message);
  } finally {
    sendBtn.disabled = false;
    document.getElementById('chatInput').focus();
  }
}


// ═══════════════════════════════════════════════════════
// PROFILE SCORE FEATURE — Rule-based, zero API cost
// ═══════════════════════════════════════════════════════

let beforeScore = null;

// ── SCORE ENGINE (pure JS, no API) ───────────────────
function calculateScore(p) {
  const sections = {};

  // ── HEADLINE ──
  const hl = (p.headline || '').trim();
  let hlScore = 0;
  let hlFeedback = '';
  let hlTip = '';
  if (!hl) {
    hlScore = 0; hlFeedback = 'Missing headline'; hlTip = 'Add a headline with your job title and specialty';
  } else if (hl.length < 20) {
    hlScore = 20; hlFeedback = 'Too short'; hlTip = 'Expand with keywords and value proposition';
  } else if (hl.length < 40) {
    hlScore = 45; hlFeedback = 'Basic headline'; hlTip = 'Add keywords like your tools, industry or impact';
  } else {
    hlScore = 60;
    // Bonus for keywords
    if (/engineer|developer|analyst|manager|designer|scientist|specialist|expert/i.test(hl)) hlScore += 10;
    if (/\||@|·|–/.test(hl)) hlScore += 10; // has structure
    if (hl.length > 80) hlScore += 10;       // detailed
    hlScore = Math.min(hlScore, 100);
    hlFeedback = hlScore >= 80 ? 'Strong headline' : 'Good but can be stronger';
    hlTip = hlScore >= 80 ? 'Add measurable impact or unique value' : 'Include your top 2-3 skills or tools';
  }
  sections.headline = { score: hlScore, feedback: hlFeedback, tip: hlTip };

  // ── ABOUT ──
  const ab = (p.about || '').trim();
  let abScore = 0;
  let abFeedback = '';
  let abTip = '';
  if (!ab) {
    abScore = 0; abFeedback = 'No About section'; abTip = 'Add a summary — profiles with About get 3x more views';
  } else if (ab.length < 100) {
    abScore = 20; abFeedback = 'Too brief'; abTip = 'Write at least 3 sentences about your expertise and goals';
  } else if (ab.length < 300) {
    abScore = 50; abFeedback = 'Decent summary'; abTip = 'Add your achievements and a call to action';
  } else {
    abScore = 70;
    if (ab.length > 500) abScore += 10;
    if (/contact|reach|email|connect|message/i.test(ab)) abScore += 10; // has CTA
    if (/\d+\s*(year|yr|%|million|thousand)/i.test(ab)) abScore += 10;  // has numbers
    abScore = Math.min(abScore, 100);
    abFeedback = abScore >= 80 ? 'Excellent summary' : 'Good summary';
    abTip = abScore >= 80 ? 'Great job!' : 'Add a contact CTA at the end';
  }
  sections.about = { score: abScore, feedback: abFeedback, tip: abTip };

  // ── EXPERIENCE ──
  const exp = p.experience || [];
  let exScore = 0;
  let exFeedback = '';
  let exTip = '';
  if (exp.length === 0) {
    exScore = 0; exFeedback = 'No experience added'; exTip = 'Add your work history';
  } else if (exp.length === 1) {
    exScore = 30; exFeedback = 'Only one position'; exTip = 'Add more positions to build credibility';
  } else {
    exScore = 40 + (exp.length * 8);
    const withDates = exp.filter(e => e.dates).length;
    const withDesc  = exp.filter(e => (e.description && e.description.length > 30) || (Array.isArray(e.bullets) && e.bullets.length > 0)).length;
    if (withDates > 0)  exScore += 10;
    if (withDesc > 0)   exScore += 15;
    exScore = Math.min(exScore, 100);
    exFeedback = exScore >= 70 ? 'Good experience section' : 'Experience needs more detail';
    exTip = withDesc === 0 ? 'Add descriptions with achievements to each role' : 'Quantify your impact with numbers';
  }
  sections.experience = { score: exScore, feedback: exFeedback, tip: exTip };

  // ── SKILLS ──
  const sk = p.skills || [];
  let skScore = 0;
  let skFeedback = '';
  let skTip = '';
  if (sk.length === 0) {
    skScore = 0; skFeedback = 'No skills listed'; skTip = 'Add at least 10 relevant skills';
  } else if (sk.length < 5) {
    skScore = 25; skFeedback = 'Too few skills'; skTip = 'Add more skills — aim for 10-15';
  } else if (sk.length < 10) {
    skScore = 55; skFeedback = 'Decent skills list'; skTip = 'Add a few more to reach 15';
  } else {
    skScore = 75 + Math.min((sk.length - 10) * 3, 25);
    skScore = Math.min(skScore, 100);
    skFeedback = 'Strong skills section';
    skTip = 'Make sure skills match your target job keywords';
  }
  sections.skills = { score: skScore, feedback: skFeedback, tip: skTip };

  // ── OVERALL ──
  const overall = Math.round(
    sections.headline.score   * 0.30 +
    sections.about.score      * 0.30 +
    sections.experience.score * 0.25 +
    sections.skills.score     * 0.15
  );

  // Top issue = lowest scoring section
  const lowestKey = Object.entries(sections).sort((a,b) => a[1].score - b[1].score)[0][0];
  const topIssue = sections[lowestKey].tip;

  return { overall, sections, top_issue: topIssue };
}

// ── ANALYZE CURRENT PROFILE ──
function analyzeProfile() {
  if (!profile || (!profile.name && !profile.headline)) {
    statusError('Load your profile first');
    return;
  }

  beforeScore = calculateScore(profile);
  renderScoreBefore(beforeScore);
  document.getElementById('scoreCard').style.display = 'flex';

  const btn = document.getElementById('analyzeBtn');
  btn.textContent = ' Re-analyze';
}

// ── ANALYZE AFTER GENERATION ──
function analyzeAfter(generatedText, fields = []) {
  // Auto-compute before score if user hasn't clicked Analyze yet
  if (!beforeScore) {
    if (!profile || (!profile.name && !profile.headline)) return;
    beforeScore = calculateScore(profile);
    renderScoreBefore(beforeScore);
    document.getElementById('scoreCard').style.display = 'flex';
  }

  // Start from before-score baseline, only override sections that were generated
  const enhanced = { ...profile };
  try {
    const clean = generatedText.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    if (fields.includes('headline') && parsed.headline) enhanced.headline = parsed.headline;
    if (fields.includes('about')    && parsed.about)    enhanced.about    = parsed.about;
    if (fields.includes('about')    && parsed.summary)  enhanced.about    = parsed.summary;
    if (fields.includes('experience') && parsed.experience && Array.isArray(parsed.experience)) enhanced.experience = parsed.experience;
    if (fields.includes('skills') && parsed.skills) {
      if (typeof parsed.skills === 'object' && !Array.isArray(parsed.skills)) {
        enhanced.skills = [...(parsed.skills.existing || []), ...(parsed.skills.suggestions || [])];
      } else if (Array.isArray(parsed.skills)) {
        enhanced.skills = parsed.skills;
      }
    }
  } catch {
    if (fields.includes('about') && generatedText.length > 50) enhanced.about = generatedText.substring(0, 600);
  }

  const after = calculateScore(enhanced);
  renderScoreAfter(after);
}

// ── RENDER BEFORE ──
function renderScoreBefore(data) {
  document.getElementById('scoreBeforeNum').textContent = data.overall;
  document.getElementById('scoreBeforeCircle').className = 'score-circle ' + scoreColorClass(data.overall);
  document.getElementById('scoreBeforeTier').textContent = scoreLabel(data.overall);
  document.getElementById('scoreBeforeBars').innerHTML = renderBars(data.sections);
  const issueEl = document.getElementById('scoreBeforeIssue');
  issueEl.textContent = data.top_issue;
  issueEl.style.display = 'block';
  document.getElementById('scoreArrow').style.display = 'none';
  document.getElementById('scoreAfterPanel').style.display = 'none';
}

// ── RENDER AFTER ──
function renderScoreAfter(data) {
  const before = beforeScore?.overall || 0;
  const diff   = data.overall - before;

  document.getElementById('scoreAfterNum').textContent = data.overall;
  document.getElementById('scoreAfterCircle').className = 'score-circle score-circle-after';
  document.getElementById('scoreAfterTier').textContent = scoreLabel(data.overall);
  document.getElementById('scoreAfterBars').innerHTML = renderBars(data.sections, true);
  document.getElementById('scoreImprovement').textContent = `+${diff} points`;
  document.getElementById('scoreAfterPotential').textContent =
    `Score improved from ${before} → ${data.overall}/100 after AI optimization`;

  document.getElementById('scoreArrow').style.display = 'flex';
  document.getElementById('scoreAfterPanel').style.display = 'block';
  document.getElementById('scoreAfterPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── HELPERS ──
function renderBars(sections, isAfter = false) {
  const colors = {
    headline:   isAfter ? '#22c55e' : '#f97316',
    about:      isAfter ? '#16a34a' : '#ef4444',
    experience: isAfter ? '#15803d' : '#f59e0b',
    skills:     isAfter ? '#3b82f6' : '#8b5cf6',
  };
  const icons = {
    headline:   `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    about:      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    experience: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`,
    skills:     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  };
  const valClass = s => s >= 70 ? 'good' : s >= 40 ? 'mid' : 'bad';
  return Object.entries(sections).map(([key, val]) => `
    <div class="score-bar-row">
      <div class="score-bar-header">
        <span class="score-bar-name">${icons[key] || ''} ${key}</span>
        <span class="score-bar-val ${valClass(val.score)}">${val.score}/100</span>
      </div>
      <div class="score-bar-track">
        <div class="score-bar-fill" style="width:${val.score}%;background:${colors[key]||'var(--ac)'}"></div>
      </div>
      <span class="score-bar-feedback"><strong>${val.feedback}</strong> — ${val.tip}</span>
    </div>
  `).join('');
}

function scoreColorClass(score) {
  if (score >= 70) return 'score-circle-after';
  if (score >= 45) return 'score-circle-mid';
  return '';
}

function scoreLabel(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Strong';
  if (score >= 50) return 'Average';
  if (score >= 30) return 'Weak';
  return 'Poor';
}


// ── AI DEEP PROFILE ANALYSIS (with 24h cache + offline fallback) ──
let _lastRenderedAiScoreData = null;
function _renderAiScoreData(d) {
  _lastRenderedAiScoreData = d;
  // Hide empty state when results are shown
  const emptyState = document.getElementById('aiDeepEmptyState');
  if (emptyState) emptyState.style.display = 'none';
  const card = document.getElementById('aiScoreCard');
  const gradeEl = document.getElementById('aiScoreGrade');
  const grade = (d.grade || 'C').replace('+', '');
  gradeEl.textContent = d.grade || 'C';
  gradeEl.className = `ai-score-grade grade-${grade.toLowerCase() === 'a' || d.grade === 'A+' ? 'a' : grade.toLowerCase()}`;
  document.getElementById('aiScoreType').textContent = d.profile_type || '';

  const score = d.overall_score || 0;
  document.getElementById('aiScoreNum').textContent = score;
  document.getElementById('aiScoreRing').setAttribute('stroke-dasharray', `${score}, 100`);
  document.getElementById('aiScoreSummary').textContent = d.summary || '';

  const secEl = document.getElementById('aiScoreSections');
  const sectionOrder = ['headline', 'about', 'experience', 'skills', 'education', 'network_readiness'];
  const sectionLabels = { headline: window._t('gapCompHeadline'), about: window._t('gapCompAbout'), experience: window._t('gapCompExperience'), skills: window._t('gapCompSkills'), education: window._t('gapCompEducation'), network_readiness: window._t('gapPwrNetwork') };
  const sectionColors = { headline: '#f97316', about: '#3b82f6', experience: '#22c55e', skills: '#8b5cf6', education: '#f59e0b', network_readiness: '#ec4899' };
  secEl.innerHTML = sectionOrder.map(key => {
    const s = d.sections?.[key];
    if (!s) return '';
    const sc = s.score || 0;
    const valClass = sc >= 70 ? 'good' : sc >= 40 ? 'mid' : 'bad';
    const verdictHtml = s.verdict ? `<div class="ai-sec-verdict">${esc(s.verdict)}</div>` : '';
    const suggHtml = s.suggestion ? `<div class="ai-sec-verdict" style="color:var(--ac)">${esc(s.suggestion)}</div>` : '';
    const missingHtml = (s.missing_skills || []).length
      ? `<div class="ai-sec-verdict">Add: ${s.missing_skills.map(sk => esc(sk)).join(', ')}</div>` : '';
    return `
      <div>
        <div class="ai-sec-row">
          <span class="ai-sec-name">${sectionLabels[key] || key}</span>
          <div class="ai-sec-bar"><div class="ai-sec-fill" style="width:${sc}%;background:${sectionColors[key] || 'var(--ac)'}"></div></div>
          <span class="ai-sec-val ${valClass}">${sc}</span>
        </div>
        ${verdictHtml}${suggHtml}${missingHtml}
      </div>`;
  }).join('');

  const actEl = document.getElementById('aiScoreActions');
  // Support both new improvement_impact (structured) and legacy top_3_actions (string array)
  const impacts = d.improvement_impact || [];
  if (impacts.length > 0) {
    actEl.innerHTML = impacts.map((item, i) => {
      const action = typeof item === 'string' ? item : (item.action || '');
      const pts = typeof item === 'object' ? (item.estimated_points || '') : '';
      return `<div class="ai-action-item"><span class="ai-action-num">${i + 1}.</span> ${esc(action)}${pts ? ` <span class="ai-action-pts">${esc(pts)}</span>` : ''}</div>`;
    }).join('');
    // Show total potential
    const totalPts = impacts.reduce((sum, item) => {
      const n = parseInt(String(item.estimated_points || '0').replace(/[^0-9]/g, ''), 10);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);
    if (totalPts > 0) {
      const potential = Math.min((d.overall_score || 0) + totalPts, 100);
      actEl.innerHTML += `<div class="ai-action-total">Potential: ${d.overall_score || 0} &rarr; ${potential}/100 if all actions completed</div>`;
    }
  } else {
    actEl.innerHTML = (d.top_3_actions || []).map((a, i) =>
      `<div class="ai-action-item"><span class="ai-action-num">${i + 1}.</span> ${esc(a)}</div>`
    ).join('');
  }

  const strEl = document.getElementById('aiScoreStrengths');
  strEl.innerHTML = (d.strengths || []).map(s =>
    `<span class="ai-strength-pill">${esc(s)}</span>`
  ).join('');

  card.style.display = '';

  const expBtn = document.getElementById('aiScoreExportBtn');
  if (expBtn) expBtn.style.display = '';
  // Show offline-fallback indicator only when API was unreachable
  const cacheTag = document.getElementById('aiScoreCacheTag');
  if (cacheTag) {
    cacheTag.style.display = d._fromCache ? '' : 'none';
    if (d._fromCache) cacheTag.textContent = 'Backend unreachable — showing last saved result';
  }
}




// ── Memory: Score Progression ─────────────────────────────────────────────────
function _renderProgress(d) {
  const existing = document.getElementById('progressPanel');
  if (existing) existing.remove();

  const p = d._progress;
  if (!p || p.previous_score === null || p.previous_score === undefined) return;

  const delta    = p.delta;
  const prev     = p.previous_score;
  const curr     = p.current_score;
  const date     = p.previous_date || '';

  const color  = delta > 0 ? '#22c55e' : delta < 0 ? '#ef4444' : '#6b7280';
  const icon   = delta > 0
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`
    : delta < 0
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
  const label  = delta > 0
    ? window._t('progressUp').replace('{{delta}}', delta)
    : delta < 0
    ? window._t('progressDown').replace('{{delta}}', delta)
    : window._t('progressStable');

  const prevText = date
    ? window._t('progressPrevious').replace('{{date}}', date).replace('{{prev}}', prev)
    : '';
  const todayText = window._t('progressToday').replace('{{curr}}', curr);

  const panel = document.createElement('div');
  panel.id = 'progressPanel';
  panel.style.cssText = 'margin-top:10px;padding:10px 12px;background:var(--bg2);border-radius:10px;border:1px solid var(--bd);display:flex;align-items:center;gap:10px';
  panel.innerHTML = `
    <span style="display:inline-flex;align-items:center">${icon}</span>
    <div style="flex:1">
      <div style="font-size:11px;font-weight:700;color:${color}">${esc(label)}</div>
      <div style="font-size:10px;color:var(--tx2);margin-top:2px">
        ${prevText ? esc(prevText) : ''} → ${esc(todayText)}
      </div>
    </div>
    <div style="font-size:20px;font-weight:800;color:${color}">${delta > 0 ? '+' : ''}${delta}</div>
  `;

  const card = document.getElementById('aiScoreCard');
  if (card) card.appendChild(panel);
}

// ── LangGraph Agent — renders diagnostic, priority actions, 30-day plan ──────
function _renderAgentExtras(d) {
  // Remove any previous agent panel
  const existing = document.getElementById('agentExtrasPanel');
  if (existing) existing.remove();

  const reco = d._agent_recommendations;
  const diag = d._agent_diagnostic;
  const path = d._workflow_path || [];
  if (!reco && !diag) return;

  // ── Workflow path badges ───────────────────────────────────
  const nodeColors = {
    extract_profile:          '#6b7280',
    compute_ai_score:         '#3b82f6',
    deep_diagnostic:          '#ef4444',
    run_gap_analysis:         '#f59e0b',
    generate_recommendations: '#22c55e',
  };
  const pathHtml = path.map(n =>
    `<span style="background:${nodeColors[n]||'#6b7280'};color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;white-space:nowrap">${n.replace(/_/g,' ')}</span>`
  ).join('<span style="color:var(--tx2);font-size:10px;margin:0 2px">→</span>');

  // ── Deep Diagnostic block (only when score < 35) ──────────
  const diagHtml = diag ? `
    <div style="margin-top:12px;padding:10px;background:rgba(239,68,68,0.08);border-left:3px solid #ef4444;border-radius:6px">
      <div style="font-size:11px;font-weight:700;color:#ef4444;margin-bottom:6px;display:flex;align-items:center;gap:5px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Deep Diagnostic — Profile needs foundational work</div>
      <div style="font-size:11px;color:var(--tx2);margin-bottom:6px;font-style:italic">${esc(diag.honest_assessment||'')}</div>
      ${(diag.root_causes||[]).map(c =>
        `<div style="font-size:11px;color:var(--tx2);margin-bottom:2px;display:flex;align-items:flex-start;gap:6px"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ef4444;margin-top:5px;flex-shrink:0"></span><span>${esc(c)}</span></div>`
      ).join('')}
      ${(diag.critical_missing||[]).length ? `
        <div style="margin-top:6px;font-size:11px;font-weight:600;color:var(--tx)">Critical missing:</div>
        ${(diag.critical_missing||[]).map(m =>
          `<div style="font-size:11px;color:var(--tx2)">• ${esc(m)}</div>`
        ).join('')}` : ''}
      ${(diag.first_3_actions||[]).length ? `
        <div style="margin-top:8px;font-size:11px;font-weight:600;color:var(--tx)">Start here:</div>
        ${(diag.first_3_actions||[]).map((a,i) =>
          `<div style="font-size:11px;color:var(--tx2);margin-bottom:2px">${i+1}. ${esc(a.action||a)} <span style="color:var(--ac)">(${esc(a.time||'')})</span></div>`
        ).join('')}` : ''}
    </div>` : '';

  // ── Priority Actions ───────────────────────────────────────
  const actions = (reco?.priority_actions||[]).slice(0,3);
  const actionsHtml = actions.length ? `
    <div style="margin-top:12px">
      <div style="font-size:11px;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:5px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--tx)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="var(--tx)"/></svg> Priority Actions</div>
      ${actions.map(a => `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 10px;background:var(--bg);border-radius:8px;margin-bottom:5px;gap:8px;border:1px solid var(--bd)">
          <div style="flex:1">
            <span style="font-size:10px;font-weight:700;color:var(--ac)">#${a.rank}</span>
            <span style="font-size:11px;margin-left:4px">${esc(a.action||'')}</span>
            ${a.why ? `<div style="font-size:10px;color:var(--tx2);margin-top:2px">${esc(a.why)}</div>` : ''}
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-size:10px;color:var(--tx2)">${esc(a.timeframe||'')}</div>
            ${a.expected_score_gain ? `<div style="font-size:10px;color:#22c55e;font-weight:600">${esc(a.expected_score_gain)}</div>` : ''}
          </div>
        </div>`
      ).join('')}
    </div>` : '';

  // ── 30-Day Plan ────────────────────────────────────────────
  const planHtml = reco?.['30_day_plan'] ? `
    <div style="margin-top:12px;padding:10px;background:var(--bg);border-radius:8px;border:1px solid var(--bd)">
      <div style="font-size:11px;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:5px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--tx)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> 30-Day Plan</div>
      <div style="font-size:11px;color:var(--tx2);white-space:pre-line;line-height:1.5">${esc(reco['30_day_plan'])}</div>
    </div>` : '';

  // ── Profile Strengths ──────────────────────────────────────
  const strengths = reco?.profile_strengths || [];
  const strengthsHtml = strengths.length ? `
    <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:4px">
      ${strengths.map(s =>
        `<span style="background:rgba(34,197,94,0.12);color:#22c55e;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600">${esc(s)}</span>`
      ).join('')}
    </div>` : '';

  // ── Motivational insight ───────────────────────────────────
  const motivHtml = reco?.motivational_insight ? `
    <div style="margin-top:10px;padding:8px;border-top:1px solid var(--bd);font-size:11px;color:var(--tx2);font-style:italic;text-align:center;display:flex;align-items:center;justify-content:center;gap:5px">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--tx2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.5.4.8 1 .8 1.7v.6h6.4v-.6c0-.7.3-1.3.8-1.7A7 7 0 0 0 12 2z"/></svg>
      <span>${esc(reco.motivational_insight)}</span>
    </div>` : '';

  // ── Assemble panel ─────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'agentExtrasPanel';
  panel.style.cssText = 'margin-top:14px;padding:12px;background:var(--bg2);border-radius:10px;border:1px solid var(--bd)';
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <span style="font-size:11px;font-weight:700;color:var(--tx);display:flex;align-items:center;gap:5px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--tx)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg> Agent Workflow</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">${pathHtml}</div>
    ${diagHtml}
    ${actionsHtml}
    ${strengthsHtml}
    ${planHtml}
    ${motivHtml}
  `;

  const card = document.getElementById('aiScoreCard');
  if (card) card.appendChild(panel);
}

async function runAiProfileScore() {
  // Fix 2: Always reload from local storage so Cosmos-synced (enriched) data is used,
  // not the stale inline scrape that may be in memory from earlier in the session.
  {
    const { myProfile: saved } = await chrome.storage.local.get('myProfile');
    if (saved && (saved.name || saved.headline)) profile = saved;
  }
  if (!profile || (!profile.name && !profile.headline)) {
    toast('Go to your LinkedIn profile first and extract it — then come back here.', 'warn', 4000);
    return;
  }

  const authData = await chrome.storage.sync.get(['authToken']);
  if (!authData.authToken) {
    statusError('Please log in to use AI analysis');
    return;
  }

  const btn = document.getElementById('aiScoreBtn');
  btn.disabled = true;
  btn.textContent = window._t('analyzing');

  try {
    const stored = await chrome.storage.local.get('networkingGoal');
    const goal = stored.networkingGoal?.goal || 'job_search';

    // Always call the API fresh on every click.
    // Only fall back to saved result if the backend is truly unreachable (network/fetch error).
    let d;
    try {
      const r = await chrome.runtime.sendMessage({
        action: 'profileAiScore',
        data: {
          profile: {
            ...profile,
            connectionsCount: profile.connectionsCount ?? null,
            followersCount:   profile.followersCount   ?? null,
          },
          goal,
          ui_lang: window._uiLang || 'en',
          force_refresh: true,
        },
      });
      if (!r?.success) {
        // r.error comes from the backend (502, 500, etc.) — show it directly, not offline cache
        throw new Error(r?.error || 'AI analysis failed');
      }
      d = r.data;
      // Save as offline fallback for when backend is truly down
      await chrome.storage.local.set({ _lastAiScore: { data: d, ts: Date.now(), profileName: profile.name } });
    } catch (apiErr) {
      const msg = apiErr.message || '';
      // Only show offline cache for fetch/network failures (backend not running)
      const isNetworkError = msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('net::');
      if (isNetworkError) {
        const fallback = await chrome.storage.local.get('_lastAiScore');
        if (fallback._lastAiScore?.data) {
          fallback._lastAiScore.data._fromCache = true;
          _renderAiScoreData(fallback._lastAiScore.data);
          const age = Math.round((Date.now() - fallback._lastAiScore.ts) / 3600000);
          statusError(`Backend offline — showing result from ${age}h ago`);
          return;
        }
      }
      throw apiErr;
    }

    d._fromCache = false;
    _renderAiScoreData(d);
    _renderProgress(d);          // ── Memory: score progression over time
    _renderAgentExtras(d);       // ── LangGraph agent panels (diagnostic + actions + plan)

  } catch (e) {
    const msg = e.message || 'Unknown error';
    // Show error in the score card area so the user clearly sees what went wrong
    const card = document.getElementById('aiScoreCard');
    if (card) {
      card.innerHTML = `<div style="padding:16px;text-align:center;color:var(--danger,#ef4444)">
        <div style="font-size:24px;margin-bottom:8px">&#9888;</div>
        <div style="font-weight:600">Analysis Failed</div>
        <div style="font-size:12px;margin-top:6px;color:var(--tx2);word-break:break-word">${msg.substring(0,200).replace(/</g,'&lt;')}</div>
        <button onclick="this.closest('#aiScoreCard').style.display='none'" style="margin-top:10px;padding:6px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--bg2);color:var(--tx);cursor:pointer;font-size:12px">Dismiss</button>
      </div>`;
      card.style.display = '';
    }
    statusError(msg.substring(0, 120));
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> AI Deep Analysis';
  }
}

// ── EXPORT: Generate a formatted text report and download as HTML or copy to clipboard ──
// ── EXPORT: AI Deep Analysis score card as a downloadable PNG ──
// Draws the score directly onto a <canvas> using the actual result data
// (not the gap-analysis exporter, which reads different DOM ids and was
// previously wired here by mistake, producing an empty/wrong export).
function exportAiScoreCardAsImage(filename) {
  const btn = document.getElementById('aiScoreExportBtn');
  const d = _lastRenderedAiScoreData;

  if (!d) {
    if (btn) {
      const prevText = btn.textContent;
      btn.textContent = 'No analysis to export yet';
      setTimeout(() => { btn.textContent = prevText; }, 2000);
    }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Building image...'; }

  try {
    const W = 640;
    const PAD = 32;
    const score = d.overall_score || 0;
    const grade = d.grade || 'N/A';
    const summary = d.summary || '';
    const sectionOrder = ['headline', 'about', 'experience', 'skills', 'education', 'network_readiness'];
    const sectionLabels = { headline: 'Headline', about: 'About', experience: 'Experience', skills: 'Skills', education: 'Education', network_readiness: 'Network Readiness' };
    const sectionColors = { headline: '#f97316', about: '#3b82f6', experience: '#22c55e', skills: '#8b5cf6', education: '#f59e0b', network_readiness: '#ec4899' };
    const sectionsToDraw = sectionOrder.filter(k => d.sections && d.sections[k]);
    const strengths = (d.strengths || []).slice(0, 4);

    // Wrap helper for long text
    function wrapText(ctx, text, maxWidth) {
      const words = String(text).split(' ');
      const lines = [];
      let line = '';
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width > maxWidth && line) {
          lines.push(line);
          line = w;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
      return lines;
    }

    // First pass on an offscreen canvas to measure summary height
    const measureCanvas = document.createElement('canvas');
    const mctx = measureCanvas.getContext('2d');
    mctx.font = '14px -apple-system, Segoe UI, Arial, sans-serif';
    const summaryLines = summary ? wrapText(mctx, summary, W - PAD * 2) : [];

    const headerH = 150;
    const summaryH = summaryLines.length ? (summaryLines.length * 20 + 24) : 0;
    const sectionRowH = 54;
    const sectionsH = sectionsToDraw.length * sectionRowH + 36;
    const strengthsH = strengths.length ? 56 : 0;
    const footerH = 40;
    const H = headerH + summaryH + sectionsH + strengthsH + footerH + PAD;

    const canvas = document.createElement('canvas');
    const scale = 2; // crisp on retina
    canvas.width = W * scale;
    canvas.height = H * scale;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    let y = PAD;

    // Header: grade badge + score ring (drawn as arc) + title
    const gradeColors = { 'A+': '#057642', 'A': '#057642', 'B': '#0a66c2', 'C': '#D4830A', 'D': '#cc1016', 'F': '#cc1016', 'N/A': '#888' };
    const gColor = gradeColors[grade] || '#888';

    // Grade badge
    ctx.fillStyle = gColor + '1a';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(PAD, y, 90, 90, 16) : ctx.rect(PAD, y, 90, 90);
    ctx.fill();
    ctx.fillStyle = gColor;
    ctx.font = '700 36px -apple-system, Segoe UI, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(grade, PAD + 45, y + 45);
    ctx.font = '600 11px -apple-system, Segoe UI, Arial, sans-serif';
    ctx.fillText('GRADE', PAD + 45, y + 70);

    // Score ring (simple arc)
    const ringCx = W - PAD - 45;
    const ringCy = y + 45;
    const ringR = 42;
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#e8e8ec';
    ctx.beginPath();
    ctx.arc(ringCx, ringCy, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = gColor;
    ctx.beginPath();
    ctx.arc(ringCx, ringCy, ringR, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.min(score, 100) / 100));
    ctx.stroke();
    ctx.fillStyle = '#1a1a2e';
    ctx.font = '700 26px -apple-system, Segoe UI, Arial, sans-serif';
    ctx.fillText(String(score), ringCx, ringCy - 4);
    ctx.font = '600 10px -apple-system, Segoe UI, Arial, sans-serif';
    ctx.fillStyle = '#888';
    ctx.fillText('/ 100', ringCx, ringCy + 16);

    // Title
    ctx.textAlign = 'left';
    ctx.fillStyle = '#1a1a2e';
    ctx.font = '700 18px -apple-system, Segoe UI, Arial, sans-serif';
    ctx.fillText('AI Profile Score', PAD + 110, y + 40);
    ctx.fillStyle = '#888';
    ctx.font = '500 12px -apple-system, Segoe UI, Arial, sans-serif';
    ctx.fillText(d.profile_type || 'Subul IN', PAD + 110, y + 62);

    y += headerH;

    // Summary
    if (summaryLines.length) {
      ctx.fillStyle = '#f8f8fa';
      ctx.fillRect(PAD - 4, y - 4, W - (PAD - 4) * 2, summaryH);
      ctx.strokeStyle = '#6941c6';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(PAD - 4, y - 4);
      ctx.lineTo(PAD - 4, y - 4 + summaryH);
      ctx.stroke();
      ctx.fillStyle = '#444';
      ctx.font = 'italic 14px -apple-system, Segoe UI, Arial, sans-serif';
      summaryLines.forEach((line, i) => ctx.fillText(line, PAD + 10, y + 16 + i * 20));
      y += summaryH;
    }

    // Section scores
    ctx.fillStyle = '#1a1a2e';
    ctx.font = '700 14px -apple-system, Segoe UI, Arial, sans-serif';
    ctx.fillText('Section Scores', PAD, y + 10);
    y += 30;

    sectionsToDraw.forEach(key => {
      const s = d.sections[key];
      const sc = s.score || 0;
      const color = sc >= 70 ? '#057642' : sc >= 40 ? '#D4830A' : '#cc1016';
      ctx.fillStyle = '#333';
      ctx.font = '600 13px -apple-system, Segoe UI, Arial, sans-serif';
      ctx.fillText(sectionLabels[key] || key, PAD, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = color;
      ctx.font = '700 13px -apple-system, Segoe UI, Arial, sans-serif';
      ctx.fillText(String(sc), W - PAD, y);
      ctx.textAlign = 'left';

      // bar
      const barY = y + 8;
      const barW = W - PAD * 2;
      ctx.fillStyle = '#eef0f3';
      ctx.fillRect(PAD, barY, barW, 6);
      ctx.fillStyle = sectionColors[key] || '#6941c6';
      ctx.fillRect(PAD, barY, barW * Math.min(sc, 100) / 100, 6);

      y += sectionRowH;
    });

    // Strengths
    if (strengths.length) {
      ctx.fillStyle = '#1a1a2e';
      ctx.font = '700 14px -apple-system, Segoe UI, Arial, sans-serif';
      ctx.fillText('Strengths', PAD, y + 10);
      y += 30;
      let px = PAD;
      ctx.font = '600 12px -apple-system, Segoe UI, Arial, sans-serif';
      strengths.forEach(s => {
        const text = String(s);
        const tw = ctx.measureText(text).width + 24;
        if (px + tw > W - PAD) { px = PAD; y += 30; }
        ctx.fillStyle = '#f0ebff';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(px, y, tw, 24, 12) : ctx.rect(px, y, tw, 24);
        ctx.fill();
        ctx.fillStyle = '#6941c6';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, px + 12, y + 13);
        ctx.textBaseline = 'alphabetic';
        px += tw + 8;
      });
      y += 36;
    }

    // Footer
    ctx.fillStyle = '#aaa';
    ctx.font = '500 11px -apple-system, Segoe UI, Arial, sans-serif';
    ctx.fillText(`Generated by Subul IN — ${new Date().toLocaleDateString()}`, PAD, y + 16);

    // Export to PNG and trigger download
    canvas.toBlob(blob => {
      if (!blob) throw new Error('Canvas produced no image data');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'linkedin-ai-profile-score.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);

      if (btn) btn.textContent = 'Image saved!';
      setTimeout(() => { if (btn) { btn.textContent = 'Export as Image'; btn.disabled = false; } }, 2000);
    }, 'image/png');

  } catch (e) {
    console.error('AI score image export error:', e);
    if (btn) { btn.textContent = 'Export failed'; btn.disabled = false; }
    setTimeout(() => { if (btn) btn.textContent = 'Export as Image'; }, 2000);
  }
}

// ── EXPORT: Job Fit Analysis as PDF (via export.html tab, like Gap Analysis) ──
// jfPdfBtn previously called window.print() directly on the popup, which is
// unreliable in a Chrome extension popup (tiny fixed viewport, and the
// print dialog stealing focus can close the popup before printing happens).
// This follows the same working pattern as the profile-vs-profile gap
// analysis export: build clean report HTML, stash it, open a real tab,
// print from there.
async function exportJobFitAsPdf() {
  const btn = document.getElementById('jfPdfBtn');
  const d = _lastJobFitData;
  const job = _lastJobFitJob || {};

  if (!d) {
    if (btn) {
      const prevText = btn.textContent;
      btn.textContent = 'No analysis to export yet';
      setTimeout(() => { btn.textContent = prevText; }, 2000);
    }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Building PDF...'; }

  try {
    const score = Math.max(0, Math.min(100, d.fit_score || 0));
    const jobName = [job.title, job.company].filter(Boolean).join(' @ ') || 'Job Opportunity';
    const scoreColor = score >= 70 ? '#22c55e' : score >= 45 ? '#0a66c2' : '#f59e0b';
    const date = new Date().toLocaleDateString();

    const fits = d.why_youre_a_fit || [];
    const critGaps = d.critical_gaps || [];
    const niceGaps = d.nice_to_have_gaps || [];
    const cv = d.cv_tailoring || {};
    const role = d.role_analysis || {};
    const priorities = d.priority_improvements || [];
    const interviewQs = d.interview_likely_questions || [];
    const coverPoints = d.cover_letter_talking_points || [];
    const redFlags = d.red_flags || [];
    const keywords = [...(cv.keywords_missing || []), ...(cv.skills_to_highlight || [])];

    const sevClass = sev => sev === 'Blocking' ? '#cc1016' : sev === 'High' ? '#D4830A' : '#888';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Job Fit Analysis — ${esc(jobName)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1a1a2e; background: #fff; line-height: 1.55; }
  h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #555; margin: 18px 0 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  .header { display: flex; align-items: center; justify-content: space-between; background: #f0f4ff; border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; }
  .job-name { font-size: 16px; font-weight: 800; }
  .score-box { display: flex; flex-direction: column; align-items: center; }
  .score { font-size: 38px; font-weight: 900; color: ${scoreColor}; line-height: 1; }
  .score-lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #666; margin-top: 2px; }
  .verdict-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 12px; background: #eef0f3; color: #333; margin-bottom: 10px; }
  .coaching { font-size: 12px; color: #444; margin-bottom: 12px; font-style: italic; }
  .fit-point, .nice-gap, .cover-point { font-size: 12px; padding: 3px 0; }
  .gap-card { border-radius: 8px; background: #f8fafc; padding: 10px 12px; margin-bottom: 8px; border-left: 4px solid #888; }
  .gap-req { font-weight: 700; font-size: 12px; }
  .gap-detail { font-size: 12px; color: #444; margin-top: 3px; }
  .gap-action { font-size: 11px; color: #0a66c2; margin-top: 4px; }
  .role-row { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
  .role-label { font-weight: 700; min-width: 130px; color: #555; }
  .priority-card { display: flex; gap: 10px; margin-bottom: 8px; }
  .priority-rank { font-weight: 800; color: #0a66c2; font-size: 14px; }
  .priority-action { font-size: 12px; font-weight: 600; }
  .priority-meta { font-size: 10px; color: #888; margin-top: 2px; }
  .kw-chip { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 10px; background: #dbeafe; color: #1e40af; margin: 2px; }
  .interview-q { font-size: 12px; padding: 4px 0; }
  .red-flag { font-size: 12px; color: #cc1016; padding: 3px 0; }
  .cv-label { font-weight: 700; font-size: 11px; color: #555; text-transform: uppercase; margin-top: 8px; display: block; }
  .cv-value { font-size: 12px; margin: 3px 0 8px; }
  .bullet-rewrite { background: #f8fafc; border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; }
  .bullet-before { font-size: 11px; color: #888; text-decoration: line-through; }
  .bullet-after { font-size: 12px; color: #057642; font-weight: 600; }
  .footer { margin-top: 20px; padding-top: 10px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 10px; color: #999; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="job-name">${esc(jobName)}</div>
    ${d.application_verdict ? `<div class="verdict-badge">${esc(d.application_verdict)}</div>` : ''}
  </div>
  <div class="score-box">
    <div class="score">${score}%</div>
    <div class="score-lbl">${esc(d.fit_label || 'Fit Score')}</div>
  </div>
</div>

${d.overall_coaching_note ? `<div class="coaching">${esc(d.overall_coaching_note)}</div>` : ''}

${fits.length ? `<h2>Why You're a Fit</h2>${fits.map(p => `<div class="fit-point">✓ ${esc(p)}</div>`).join('')}` : ''}

${critGaps.length ? `<h2>Critical Gaps</h2>${critGaps.map(g => `
<div class="gap-card" style="border-left-color:${sevClass(g.severity)}">
  <div class="gap-req">${esc(g.requirement || '')}</div>
  <div class="gap-detail">${esc(g.gap || '')}</div>
  ${g.how_to_address ? `<div class="gap-action">Fix: ${esc(g.how_to_address)}</div>` : ''}
</div>`).join('')}` : ''}

${niceGaps.length ? `<h2>Nice-to-Have Gaps</h2>${niceGaps.map(g => `<div class="nice-gap">○ ${esc(g)}</div>`).join('')}` : ''}

${(role.domain || role.seniority_fit) ? `<h2>Role Analysis</h2>
<div class="role-row"><span class="role-label">Domain</span><span>${esc(role.domain || '')}</span></div>
<div class="role-row"><span class="role-label">Seniority Required</span><span>${esc(role.seniority_required || '')}</span></div>
<div class="role-row"><span class="role-label">Your Seniority</span><span>${esc(role.seniority_candidate || '')}</span></div>
<div class="role-row"><span class="role-label">Seniority Fit</span><span>${esc(role.seniority_fit || '')}</span></div>` : ''}

${priorities.length ? `<h2>Priority Improvements</h2>${priorities.map(p => `
<div class="priority-card">
  <div class="priority-rank">${esc(String(p.rank || ''))}</div>
  <div>
    <div class="priority-action">${esc(p.action || '')}</div>
    <div class="priority-meta">${esc(p.timeframe || '')} ${p.impact ? '· ' + esc(p.impact) : ''}</div>
  </div>
</div>`).join('')}` : ''}

${(cv.headline || cv.about_opening || (cv.experience_rewrites||[]).length || keywords.length) ? `<h2>CV Tailoring</h2>
${cv.headline ? `<span class="cv-label">Headline</span><div class="cv-value">${esc(cv.headline)}</div>` : ''}
${cv.about_opening ? `<span class="cv-label">About Opening</span><div class="cv-value">${esc(cv.about_opening)}</div>` : ''}
${(cv.experience_rewrites || []).map(r => `
<div class="bullet-rewrite">
  <div style="font-weight:700;font-size:11px;">${esc(r.role || '')}</div>
  <div class="bullet-before">Before: ${esc(r.bullet_to_rewrite || '')}</div>
  <div class="bullet-after">After: ${esc(r.rewritten || '')}</div>
</div>`).join('')}
${keywords.length ? `<span class="cv-label">Keywords</span>${keywords.map(k => `<span class="kw-chip">${esc(k)}</span>`).join('')}` : ''}` : ''}

${interviewQs.length ? `<h2>Likely Interview Questions</h2>${interviewQs.map((q,i) => `<div class="interview-q">Q${i+1}: ${esc(q)}</div>`).join('')}` : ''}

${coverPoints.length ? `<h2>Cover Letter Talking Points</h2>${coverPoints.map(p => `<div class="cover-point">→ ${esc(p)}</div>`).join('')}` : ''}

${redFlags.length ? `<h2>Red Flags</h2>${redFlags.map(f => `<div class="red-flag">⚠ ${esc(f)}</div>`).join('')}` : ''}

<div class="footer">Generated by Subul IN — ${date}</div>

</body>
</html>`;

    await chrome.storage.local.set({ _gapExportHtml: html });
    const exportUrl = chrome.runtime.getURL('popup/export.html');
    chrome.tabs.create({ url: exportUrl });

    if (btn) btn.textContent = 'PDF ready!';
    setTimeout(() => { if (btn) { btn.textContent = 'Print / PDF'; btn.disabled = false; } }, 3000);

  } catch (e) {
    console.error('Job fit PDF export error:', e);
    if (btn) { btn.textContent = 'Export failed'; btn.disabled = false; }
    setTimeout(() => { if (btn) btn.textContent = 'Print / PDF'; }, 2000);
  }
}

async function exportElementAsImage(elementId, filename) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const btn = document.getElementById('gapExportBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Building PDF...'; }

  try {
    // ── Collect all text data from the rendered DOM ──
    const getT = id => (document.getElementById(id)?.textContent || '').trim();

    // Header names
    const youName  = document.getElementById('gapYouName')?.textContent?.trim()  || 'You';
    const themName = document.getElementById('gapThemName')?.textContent?.trim() || 'Them';
    const youRole  = document.getElementById('gapYouRole')?.textContent?.trim()  || '';
    const themRole = document.getElementById('gapThemRole')?.textContent?.trim() || '';
    const overall  = document.getElementById('gapOverallScore')?.textContent?.trim()  || '';
    const overallLabel = document.getElementById('gapOverallLabel')?.textContent?.trim() || 'Match Score';
    const insight  = getT('gapInsight');

    // Power Index rows
    const pwrRows = [];
    document.querySelectorAll('.gap-power-row').forEach(row => {
      const label = row.querySelector('.gap-power-label')?.textContent?.trim() || '';
      const youVal = row.querySelector('[id^="gapPwr"][id$="YouVal"]')?.textContent?.trim() || '–';
      const themVal = row.querySelector('[id^="gapPwr"][id$="ThemVal"]')?.textContent?.trim() || '–';
      const delta = row.querySelector('.gap-pwr-delta')?.textContent?.trim() || '';
      if (label) pwrRows.push({ label, youVal, themVal, delta });
    });

    // Compare sections (Headline, Skills, Experience etc.)
    const compareSections = [];
    document.querySelectorAll('.gap-compare-row').forEach(row => {
      const label   = row.querySelector('.gap-compare-label')?.textContent?.trim() || '';
      const youVal  = row.querySelector('.gap-bar-you-val')?.textContent?.trim() || '';
      const themVal = row.querySelector('.gap-bar-them-val')?.textContent?.trim() || '';
      const advice  = row.querySelector('.gap-compare-gap')?.textContent?.trim() || '';
      const rewrite = row.querySelector('.gap-rewrite-box')?.textContent?.trim() || '';
      const pills   = Array.from(row.querySelectorAll('.gap-pill')).map(p => p.textContent.trim());
      if (label) compareSections.push({ label, youVal, themVal, advice, rewrite, pills });
    });

    // H2H
    const h2hYou    = Array.from(document.querySelectorAll('#gapH2HUserWins .gap-h2h-item')).map(e => e.textContent.trim());
    const h2hThem   = Array.from(document.querySelectorAll('#gapH2HTargetWins .gap-h2h-item')).map(e => e.textContent.trim());
    const h2hTies   = Array.from(document.querySelectorAll('#gapH2HTies .gap-h2h-item')).map(e => e.textContent.trim());

    // Recruiter perspective
    const recruiter = getT('gapRecruiterText');

    // Roadmap
    const roadmapItems = Array.from(document.querySelectorAll('.gap-roadmap-item')).map(it => ({
      week: it.querySelector('.gap-roadmap-week')?.textContent?.trim() || '',
      title: it.querySelector('.gap-roadmap-title')?.textContent?.trim() || '',
      actions: Array.from(it.querySelectorAll('.gap-roadmap-action')).map(a => a.textContent.trim()),
    }));

    // Strategy / messaging
    const strategy = getT('gapStrategyMsg') || getT('gapStrategyContext') || getT('gapStrategyFollowup');

    const date = new Date().toLocaleDateString();
    const pur = '#7c3aed';
    const org = '#e8590c';

    // ── Build clean PDF HTML ──
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Gap Analysis – ${youName} vs ${themName}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1a1a2e; background: #fff; line-height: 1.55; }
  h1 { font-size: 20px; font-weight: 800; color: #1a1a2e; margin-bottom: 4px; }
  h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #555; margin: 18px 0 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  h3 { font-size: 12px; font-weight: 700; color: #1a1a2e; margin: 10px 0 4px; }
  .header { display: flex; align-items: center; justify-content: space-between; background: #f0f4ff; border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; }
  .profile { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 130px; }
  .avatar { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 18px; color: #fff; }
  .av-you { background: ${pur}; } .av-them { background: ${org}; }
  .pname { font-size: 13px; font-weight: 700; text-align: center; }
  .prole { font-size: 10px; color: #666; text-align: center; max-width: 130px; }
  .vs-box { display: flex; flex-direction: column; align-items: center; }
  .score { font-size: 38px; font-weight: 900; color: #0a66c2; line-height: 1; }
  .score-lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #666; margin-top: 2px; }
  .insight-box { background: #eff6ff; border-left: 4px solid #0a66c2; border-radius: 0 8px 8px 0; padding: 10px 14px; margin-bottom: 14px; font-size: 12px; color: #1e3a5f; font-weight: 600; line-height: 1.6; }
  /* Power Index */
  .pwr-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  .pwr-table th { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #999; text-align: left; padding: 0 4px 4px; }
  .pwr-table th.right { text-align: right; }
  .pwr-table td { padding: 5px 4px; border-bottom: 1px solid #f1f5f9; font-size: 12px; }
  .pwr-label { font-weight: 600; color: #333; min-width: 90px; }
  .bar-cell { width: 180px; }
  .bar-wrap { width: 100%; height: 12px; background: #e2e8f0; border-radius: 6px; position: relative; overflow: hidden; }
  .bar-you { position: absolute; top: 0; height: 6px; border-radius: 3px; background: linear-gradient(90deg, ${pur}, #3b5bdb); }
  .bar-them { position: absolute; top: 6px; height: 6px; border-radius: 3px; background: linear-gradient(90deg, ${org}, #f59e0b); }
  .pwr-scores { text-align: right; white-space: nowrap; font-size: 11px; min-width: 50px; }
  .val-you { color: ${pur}; font-weight: 700; }
  .val-them { color: ${org}; font-weight: 700; }
  .delta { font-size: 11px; font-weight: 700; min-width: 30px; text-align: right; }
  .delta-pos { color: #22c55e; } .delta-neg { color: #ef4444; } .delta-ev { color: #999; }
  .legend { display: flex; gap: 14px; margin-bottom: 10px; align-items: center; }
  .leg-dot { display: inline-block; width: 14px; height: 6px; border-radius: 3px; margin-right: 4px; vertical-align: middle; }
  .leg-you { background: linear-gradient(90deg, ${pur}, #3b5bdb); }
  .leg-them { background: linear-gradient(90deg, ${org}, #f59e0b); }
  .leg-lbl-you { color: ${pur}; font-weight: 700; font-size: 11px; }
  .leg-lbl-them { color: ${org}; font-weight: 700; font-size: 11px; }
  /* Compare sections */
  .compare-block { background: #f8fafc; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .compare-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .compare-label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #555; }
  .compare-vals { font-size: 11px; }
  .advice { font-size: 12px; color: #444; line-height: 1.6; margin-bottom: 5px; }
  .rewrite { font-size: 11px; background: #eff6ff; color: #1e3a5f; padding: 7px 10px; border-radius: 6px; margin-top: 5px; }
  .pills { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
  .pill { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: #dbeafe; color: #1e40af; }
  /* H2H */
  .h2h-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 6px; }
  .h2h-col { background: #f8fafc; border-radius: 8px; padding: 8px 10px; }
  .h2h-title { font-size: 10px; font-weight: 700; text-transform: uppercase; margin-bottom: 5px; }
  .h2h-you .h2h-title { color: ${pur}; }
  .h2h-them .h2h-title { color: ${org}; }
  .h2h-item { font-size: 11px; color: #444; padding: 2px 0; border-bottom: 1px solid #e2e8f0; line-height: 1.5; }
  .h2h-item:last-child { border: none; }
  .ties-box { background: #f8fafc; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
  /* Recruiter */
  .recruiter-box { font-style: italic; color: #555; background: #f8fafc; padding: 10px 14px; border-radius: 8px; margin-bottom: 8px; font-size: 12px; line-height: 1.6; }
  /* Roadmap */
  .roadmap-item { margin-bottom: 10px; padding-left: 12px; border-left: 3px solid #0a66c2; }
  .roadmap-week { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #0a66c2; }
  .roadmap-title { font-size: 12px; font-weight: 700; margin: 2px 0; }
  .roadmap-action { font-size: 11px; color: #555; padding: 1px 0 1px 10px; }
  .roadmap-action::before { content: "→ "; color: #0a66c2; font-weight: 700; }
  /* Footer */
  .footer { margin-top: 20px; padding-top: 10px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 10px; color: #999; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="profile">
    <div class="avatar av-you">${youName.charAt(0).toUpperCase()}</div>
    <div class="pname">${youName}</div>
    <div class="prole">${youRole}</div>
  </div>
  <div class="vs-box">
    <div class="score">${overall}</div>
    <div class="score-lbl">${overallLabel || 'Match Score'}</div>
  </div>
  <div class="profile">
    <div class="avatar av-them">${themName.charAt(0).toUpperCase()}</div>
    <div class="pname">${themName}</div>
    <div class="prole">${themRole}</div>
  </div>
</div>

${insight ? `<div class="insight-box">${insight}</div>` : ''}

<!-- Power Index -->
${pwrRows.length ? `
<h2>Power Index</h2>
<div class="legend">
  <span><span class="leg-dot leg-you"></span><span class="leg-lbl-you">You</span></span>
  <span><span class="leg-dot leg-them"></span><span class="leg-lbl-them">Them</span></span>
</div>
<table class="pwr-table">
  <thead><tr>
    <th>Dimension</th><th>Bars</th>
    <th class="right">You / Them</th>
    <th class="right">Gap</th>
  </tr></thead>
  <tbody>
  ${pwrRows.map(r => {
    const yv = parseInt(r.youVal) || 0;
    const tv = parseInt(r.themVal) || 0;
    const dc = r.delta.startsWith('+') ? 'delta-pos' : r.delta === '=' ? 'delta-ev' : r.delta.startsWith('-') ? 'delta-neg' : 'delta-ev';
    return `<tr>
      <td class="pwr-label">${r.label}</td>
      <td class="bar-cell"><div class="bar-wrap">
        <div class="bar-you" style="width:${yv}%"></div>
        <div class="bar-them" style="width:${tv}%"></div>
      </div></td>
      <td class="pwr-scores"><span class="val-you">${r.youVal}</span> / <span class="val-them">${r.themVal}</span></td>
      <td class="delta ${dc}">${r.delta}</td>
    </tr>`;
  }).join('')}
  </tbody>
</table>` : ''}

<!-- Profile Comparison -->
${compareSections.length ? `<h2>Profile Comparison</h2>
${compareSections.map(s => `
<div class="compare-block">
  <div class="compare-header">
    <span class="compare-label">${s.label}</span>
    <span class="compare-vals"><span class="val-you">${s.youVal}</span> / <span class="val-them">${s.themVal}</span></span>
  </div>
  ${s.advice ? `<div class="advice">${s.advice}</div>` : ''}
  ${s.rewrite ? `<div class="rewrite">${s.rewrite}</div>` : ''}
  ${s.pills.length ? `<div class="pills">${s.pills.map(p => `<span class="pill">${p}</span>`).join('')}</div>` : ''}
</div>`).join('')}` : ''}

<!-- Head to Head -->
${(h2hYou.length || h2hThem.length) ? `
<h2>Head to Head</h2>
<div class="h2h-grid">
  <div class="h2h-col h2h-you">
    <div class="h2h-title">Your Wins</div>
    ${h2hYou.map(t => `<div class="h2h-item">${t}</div>`).join('')}
  </div>
  <div class="h2h-col h2h-them">
    <div class="h2h-title">${themName}'s Wins</div>
    ${h2hThem.map(t => `<div class="h2h-item">${t}</div>`).join('')}
  </div>
</div>
${h2hTies.length ? `<div class="ties-box"><h3>Ties</h3>${h2hTies.map(t => `<div class="h2h-item">${t}</div>`).join('')}</div>` : ''}
` : ''}

<!-- Recruiter Perspective -->
${recruiter ? `<h2>Recruiter Perspective</h2><div class="recruiter-box">"${recruiter}"</div>` : ''}

<!-- Action Roadmap -->
${roadmapItems.length ? `<h2>Action Roadmap</h2>
${roadmapItems.map(r => `
<div class="roadmap-item">
  <div class="roadmap-week">${r.week}</div>
  <div class="roadmap-title">${r.title}</div>
  ${r.actions.map(a => `<div class="roadmap-action">${a}</div>`).join('')}
</div>`).join('')}` : ''}

${strategy ? `<h2>Strategy</h2><div class="advice">${strategy}</div>` : ''}

<div class="footer">Generated by Subul IN &mdash; ${date}</div>

</body>
</html>`;

    // Encode as base64 data URL so it works from extension popup
    // Store HTML in chrome.storage.session then open the export page
    await chrome.storage.local.set({ _gapExportHtml: html });
    const exportUrl = chrome.runtime.getURL('popup/export.html');
    chrome.tabs.create({ url: exportUrl });

    if (btn) btn.textContent = 'PDF ready!';
    setTimeout(() => { if (btn) { btn.textContent = 'Export as PDF'; btn.disabled = false; } }, 3000);

  } catch (e) {
    console.error('Export error:', e);
    if (btn) { btn.textContent = 'Export failed'; btn.disabled = false; }
    setTimeout(() => { if (btn) btn.textContent = 'Export as PDF'; }, 2000);
  }
}

// ══════════════════════════════════════
//  AUTH GATE
// ══════════════════════════════════════

function initAuth(onReady) {
  const gate      = document.getElementById('authGate');
  const userBar   = document.getElementById('userBar');
  const barEmail  = document.getElementById('userBarEmail');
  const authError = document.getElementById('authError');
  const submitBtn = document.getElementById('authSubmitBtn');
  const pagesContainer = document.getElementById('pagesContainer');

  let mode = 'login'; // fixed to login — Create Account is disabled
  let _onReadyCalled = false; // guard: only call onReady() once

  document.getElementById('tabSignIn').addEventListener('click', () => {
    mode = 'login';
    document.getElementById('tabSignIn').classList.add('active');
    submitBtn.textContent = 'Sign In';
    authError.style.display = 'none';
  });

  function showMain(email) {
    gate.style.display    = 'none';
    pagesContainer.style.display = 'block';
    userBar.style.display = 'flex';
    barEmail.textContent  = email || 'Anonymous';

    // Start the UI immediately — do NOT wait for the backend profile fetch.
    // scrapeProfile() already reads from chrome.storage.local (fast path).
    // The backend fetch updates the profile in the background if it has fresher data.
    if (!_onReadyCalled) { _onReadyCalled = true; onReady(); }

    // Non-blocking: load saved LinkedIn profile from Cosmos DB and update UI if richer
    chrome.runtime.sendMessage({ action: 'getMyProfile' }, async (r) => {
      if (!r || !r.success || !r.data) return;
      // Guard against old double-wrapped shape: { success, data: { success, data: {...} } }
      let profileData = r.data;
      if (profileData && profileData.success !== undefined && profileData.data) {
        profileData = profileData.data;
      }
      if (profileData && (profileData.name || profileData.headline)) {
        // Back-compat: old saves used 'source' key instead of '_source'
        if (!profileData._source && profileData.source) profileData._source = profileData.source;
        profile = profileData;
        // Write to local storage so future scrapeProfile() fast-path picks it up
        chrome.storage.local.set({ cachedProfile: profile, myProfile: profile });
        console.log('[Profile] Loaded from Cosmos DB:', profile.name);
        // Update home hero and profile card if already visible
        updateHomeProfile(profile);
        showProfileCard(profile);
      }
    });
  }

  function showGate() {
    gate.style.display    = 'block';
    pagesContainer.style.display = 'none';
    userBar.style.display = 'none';
  }

  function showError(msg) {
    authError.textContent   = msg;
    authError.style.display = 'block';
  }

  function sendAuth() {
    authError.style.display = 'none';
    const email    = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    if (!email || !password) { showError('Email and password required.'); return; }
    const action = mode === 'register' ? 'registerUser' : 'loginUser';
    const orig = submitBtn.textContent;
    submitBtn.disabled = true; submitBtn.textContent = '...';
    chrome.runtime.sendMessage({ action, data: { email, password } }, r => {
      const lastErr = chrome.runtime.lastError; // capture before it clears
      submitBtn.disabled = false; submitBtn.textContent = orig;
      if (r && r.success) {
        showMain(r.data?.email || email);
      } else {
        const err = (r && r.error) || lastErr?.message || 'No response from extension';
        if (!r || /fetch|connect|network|ECONNREFUSED|Failed to fetch|No response/i.test(err)) {
          showError('Cannot reach backend. Check your internet connection or server URL in Options.');
        } else {
          showError(err);
        }
      }
    });
  }

  submitBtn.addEventListener('click', sendAuth);
  ['authEmail', 'authPassword'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') sendAuth(); })
  );

  // ── Subul login ──
  const subulForm      = document.getElementById('subulForm');
  const subulError     = document.getElementById('subulError');
  const subulSubmitBtn = document.getElementById('subulSubmitBtn');
  const mainAuthEls    = [
    document.getElementById('authError'),
    document.querySelector('.auth-tabs'),
    document.getElementById('authEmail'),
    document.getElementById('authPassword'),
    submitBtn,
    document.querySelector('.auth-divider'),
    document.getElementById('authSubulBtn'),
  ];

  function showSubulForm() {
    // Just reveal the credential form — do NOT open a tab here. Opening a
    // tab as a side effect of showing the form meant every click on
    // "Continue with Subul" launched app.subul.uk even for users who only
    // wanted to type their email/password directly, leaving a confusing
    // tab open that nothing ever closed.
    mainAuthEls.forEach(el => { if (el) el.style.display = 'none'; });
    subulForm.style.display = 'block';
    subulError.textContent  = '';
  }

  // Separate, explicit action: open app.subul.uk and auto-detect login.
  // Only runs when the user clicks this specific link, not just for
  // viewing/using the manual credential form.
  function startSubulAutoLogin() {
    chrome.tabs.create({ url: 'https://app.subul.uk/', active: true }, (tab) => {
      const requestedAt = Date.now();
      chrome.storage.local.set({ subulAuthRequestedAt: requestedAt });
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'subulStartAuth', requestedAt }, () => {});
      }
    });
    const hint = document.getElementById('subulRedirectHint');
    if (hint) hint.innerHTML =
      '<p>Log in on the <strong>Subul</strong> tab that just opened.</p>' +
      '<p style="font-size:11px;margin-top:4px;color:var(--tx2)">That tab will close automatically once you\'re signed in, and you\'ll get a notification — just click the extension icon again to continue. ' +
      'Or enter your credentials below instead.</p>';
  }

  function hideSubulForm() {
    subulForm.style.display = 'none';
    mainAuthEls.forEach(el => { if (el) el.style.removeProperty('display'); });
  }

  document.getElementById('authSubulBtn').addEventListener('click', showSubulForm);
  document.getElementById('subulAutoLoginBtn').addEventListener('click', startSubulAutoLogin);
  document.getElementById('subulBackBtn').addEventListener('click', hideSubulForm);

  // Listen for auto-login from the Subul content script (token relay)
  // When the popup re-opens after Subul login, check if auth was set
  chrome.storage.sync.get(['authToken', 'authEmail'], ({ authToken, authEmail }) => {
    if (authToken && authEmail) {
      showMain(authEmail);
    }
  });

  function sendSubulAuth() {
    subulError.textContent = '';
    const email    = document.getElementById('subulEmail').value.trim();
    const password = document.getElementById('subulPassword').value;
    if (!email || !password) { subulError.textContent = 'Email and password required.'; return; }
    const orig = subulSubmitBtn.textContent;
    subulSubmitBtn.disabled = true; subulSubmitBtn.textContent = '...';
    chrome.runtime.sendMessage({ action: 'loginWithSubul', data: { email, password } }, r => {
      const lastErr = chrome.runtime.lastError;
      subulSubmitBtn.disabled = false; subulSubmitBtn.textContent = orig;
      if (r && r.success) {
        showMain(r.data?.email || email);
      } else {
        const err = (r && r.error) || lastErr?.message || 'No response from extension';
        if (!r || /fetch|connect|network|ECONNREFUSED|Failed to fetch|No response/i.test(err)) {
          subulError.textContent = 'Cannot reach backend. Check your internet connection.';
        } else {
          subulError.textContent = err;
        }
      }
    });
  }

  subulSubmitBtn.addEventListener('click', sendSubulAuth);
  ['subulEmail', 'subulPassword'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') sendSubulAuth(); })
  );

  document.getElementById('authLogoutBtn').addEventListener('click', async () => {
    const ok = await confirmDialog('Logout', 'Are you sure you want to log out?', { okText: 'Logout', danger: true });
    if (!ok) return;
    chrome.storage.sync.remove(['authToken', 'authEmail']);
    showGate();
  });

  chrome.runtime.onMessage.addListener((req) => {
    if (req.action === 'tokenExpired') showGate();
    if (req.action === 'subulLoginSuccess') showMain(req.email);
    if (req.action === 'triggerRescrape') {
      // User navigated to their own profile — silently re-scrape in background
      chrome.storage.local.get('myProfile', ({ myProfile }) => {
        if (myProfile && myProfile.url_slug === req.slug) {
          // Only rescrape if data is stale (>24h) or if triggered by navigation
          const ageMs = Date.now() - (myProfile.scrapedAt || 0);
          if (ageMs > 60 * 60 * 1000) { // 1 hour threshold for navigation-triggered rescrape
            scrapeProfile();
          }
        }
      });
    }
  });

  chrome.storage.sync.get(['authToken', 'authEmail']).then(data => {
    if (data.authToken) showMain(data.authEmail);
    else showGate();
  }).catch(() => showGate());
}


// ══════════════════════════════════════
//  NETWORKING TAB
// ══════════════════════════════════════

const GOAL_LABELS = {
  job_search: 'Job Search',
  clients:    'Find Clients',
  investors:  'Find Investors',
  learning:   'Learn & Grow',
};

function _initBulkBar() {
  const bulkBar   = document.getElementById('netBulkBar');
  const countEl   = document.getElementById('netBulkCount');
  const copyBtn   = document.getElementById('netBulkCopy');
  const skipBtn   = document.getElementById('netBulkSkip');
  const clearBtn  = document.getElementById('netBulkClear');
  const container = document.getElementById('netSuggestions');
  if (!bulkBar) return;

  function _getChecked() {
    return [...container.querySelectorAll('.net-card-check:checked')];
  }

  function _updateBar() {
    const checked = _getChecked();
    if (checked.length > 0) {
      bulkBar.classList.remove('hidden');
      countEl.textContent = `${checked.length} selected`;
    } else {
      bulkBar.classList.add('hidden');
    }
  }

  // Delegate checkbox change events on the suggestions container
  container.addEventListener('change', e => {
    if (e.target.classList.contains('net-card-check')) _updateBar();
  });

  copyBtn.addEventListener('click', () => {
    const messages = _getChecked().map(cb => {
      const idx   = cb.dataset.idx;
      const msgEl = document.querySelector(`#net-msg-${idx} .net-message-text`);
      return msgEl?.textContent || '';
    }).filter(Boolean);
    if (messages.length) {
      navigator.clipboard.writeText(messages.join('\n\n---\n\n'))
        .then(() => flash('netBulkCopy', `${messages.length} copied!`));
    }
  });

  skipBtn.addEventListener('click', () => {
    _getChecked().forEach(cb => {
      const card = cb.closest('.net-card');
      if (card) { card.style.opacity = '0.4'; card.style.pointerEvents = 'none'; }
      cb.checked = false;
    });
    _updateBar();
  });

  clearBtn.addEventListener('click', () => {
    _getChecked().forEach(cb => { cb.checked = false; });
    _updateBar();
  });
}

async function initNetworkingTab() {
  // Pre-fill onboarding fields from scraped profile when available
  document.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.tab === 'networking') {
      t.addEventListener('click', onNetworkingTabOpen);
    }
  });

  document.getElementById('netSaveGoalBtn').addEventListener('click', saveNetworkingGoal);
  document.getElementById('netChangeGoalBtn').addEventListener('click', showNetOnboarding);
  document.getElementById('netScanBtn').addEventListener('click', runNetworkingScan);

  // Bulk action bar
  _initBulkBar();

  // Consent gate
  const consentCheck = document.getElementById('netConsentCheck');
  const consentBtn   = document.getElementById('netConsentAcceptBtn');
  consentCheck.addEventListener('change', () => { consentBtn.disabled = !consentCheck.checked; });
  consentBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({ networkingConsentGiven: true });
    document.getElementById('netConsent').style.display = 'none';
    const stored2 = await chrome.storage.local.get('networkingGoal');
    if (stored2.networkingGoal) showNetMain(stored2.networkingGoal);
    else showNetOnboarding();
  });
}

async function onNetworkingTabOpen() {
  const stored = await chrome.storage.local.get(['networkingGoal', 'networkingConsentGiven']);
  if (!stored.networkingConsentGiven) {
    // Hide other panels, show consent
    document.getElementById('netConsent').style.display = '';
    document.getElementById('netOnboarding').style.display = 'none';
    document.getElementById('netMain').style.display = 'none';
    return;
  }
  if (stored.networkingGoal) {
    showNetMain(stored.networkingGoal);

    // Show page-context hint in status bar so user knows where to navigate
    const statusEl = document.getElementById('netStatus');
    if (statusEl) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
      const url = tab?.url || '';
      if (!url.includes('linkedin.com')) {
        statusEl.style.display = '';
        statusEl.innerHTML = '<strong>[!]</strong> Go to <a href="https://www.linkedin.com/mynetwork/" target="_blank" style="color:var(--ac)">linkedin.com/mynetwork/</a> or a people search, then click Scan.';
      } else if (/linkedin\.com\/in\//.test(url)) {
        statusEl.style.display = '';
        statusEl.innerHTML = '<strong>[!]</strong> You\'re on a profile page. For Scan to work, go to <a href="https://www.linkedin.com/mynetwork/" target="_blank" style="color:var(--ac)">People You May Know</a> or a search results page.';
      } else {
        statusEl.style.display = 'none';
      }
    }

    // Load previous scan results if <24h old and suggestions area is empty
    try {
      const { _lastNetScanResults: prev } = await chrome.storage.local.get('_lastNetScanResults');
      const suggestionsEl = document.getElementById('netSuggestions');
      if (prev && (Date.now() - prev.timestamp) < 24 * 60 * 60 * 1000 &&
          suggestionsEl && !suggestionsEl.hasChildNodes()) {
        renderSkeletonCards(prev.candidates, suggestionsEl);
        const goal = prev.goalData?.goal || 'job_search';
        const slugs = prev.candidates.map(c => c.url_slug).filter(Boolean);
        const { hits } = await _getCachedAnalyses(slugs, goal);
        prev.candidates.forEach((c, idx) => {
          const a = hits[c.url_slug];
          if (a) updateCardWithAnalysis(idx, a, c, prev.goalData);
        });
        const statusEl = document.getElementById('netStatus');
        if (statusEl) {
          statusEl.textContent = `Showing ${prev.candidates.length} previous results. Click "Scan" to refresh.`;
          statusEl.style.display = '';
        }
      }
    } catch { /* noop — no cached results */ }
  } else {
    _prefillOnboardingFromProfile();
    showNetOnboarding();
  }
}

function _inferSeniority(title) {
  if (!title) return '';
  const t = title.toLowerCase();
  // Executive level
  if (/\b(ceo|cto|coo|cfo|cio|cmo|cpo|founder|co-founder|co founder|president|pdg|directeur g[eé]n[eé]ral|managing partner|owner)\b/.test(t)) return 'executive';
  // Director level
  if (/\b(director|vp|vice president|svp|evp|avp|directeur|directrice|head of)\b/.test(t)) return 'director';
  // Manager level
  if (/\b(manager|chef de|responsable|team lead|supervisor|coordinator|coordinateur|gestionnaire)\b/.test(t)) return 'manager';
  // Senior level
  if (/\b(senior|sr\.?|principal|staff|lead|expert|sp[eé]cialiste|architecte|architect)\b/.test(t)) return 'senior';
  // Junior level
  if (/\b(junior|jr\.?|associate|graduate|entry.?level|d[eé]butant)\b/.test(t)) return 'junior';
  // Intern level
  if (/\b(intern|stagiaire|trainee|apprentice|apprenti|alternant|alternance)\b/.test(t)) return 'intern';
  return 'mid';
}

function _inferIndustry(title, company) {
  const t = (title + ' ' + company).toLowerCase();
  // Technology & IT
  if (/\b(software|engineer|developer|d[eé]veloppeur|data|ai\b|machine learning|ml\b|cloud|devops|cyber|s[eé]curit[eé]|backend|frontend|fullstack|full.?stack|product|architect|web|mobile|iot|blockchain|sre|qa\b|test|automation|infra|sysadmin|informatique|it\b|tech|digital|programmeur|code|api|saas|erp|crm)\b/.test(t)) return 'Technology';
  // Finance & Banking
  if (/\b(finance|financ|bank|banque|invest|fintech|audit|tax|fiscal|trading|actuar|comptab|accounting|treasury|risk|assurance|insurance)\b/.test(t)) return 'Finance';
  // Consulting
  if (/\b(consult|advisory|strategy|strat[eé]gi|mckinsey|deloitte|accenture|pwc|kpmg|ey\b|ernst|bain|bcg|capgemini|cabinet)\b/.test(t)) return 'Consulting';
  // Healthcare & Pharma
  if (/\b(health|sant[eé]|medical|m[eé]dec|pharma|biotech|clinical|clinique|hospital|h[oô]pital|dental|dentaire|infirm|nurs|therapeut|th[eé]rap)\b/.test(t)) return 'Healthcare';
  // Sales & Business Development
  if (/\b(sales|vente|business dev|account exec|commercial|revenue|bd\b)\b/.test(t)) return 'Sales';
  // Marketing & Communications
  if (/\b(market|brand|marque|content|seo|sem|growth|social media|communication|r[eé]dact|copywriter|media|publicit|advertising|pr\b|relations? publiques?)\b/.test(t)) return 'Marketing';
  // Human Resources
  if (/\b(recruiter|recruteur|talent|people ops|rh\b|hr\b|human res|ressources humaines|workforce|staffing|paie|payroll)\b/.test(t)) return 'Human Resources';
  // Design & Creative
  if (/\b(design|ux\b|ui\b|creative|cr[eé]at|graphic|graphi|motion|3d|animation|illustrat|artiste|artist|visual)\b/.test(t)) return 'Design';
  // Education & Training
  if (/\b(teacher|enseignant|professor|professeur|education|[eé]ducation|training|formation|coach|formateur|university|universit[eé]|school|[eé]cole|academic|acad[eé]m)\b/.test(t)) return 'Education';
  // Legal
  if (/\b(lawyer|avocat|attorney|legal|juridique|counsel|compliance|conformit[eé]|notaire|juriste)\b/.test(t)) return 'Legal';
  // Engineering & Manufacturing
  if (/\b(m[eé]cani|mechanical|electrical|[eé]lectri|civil|manufacturing|industri|production|qualit[eé]|quality|process|usine|factory|maintenance)\b/.test(t)) return 'Engineering';
  // Real Estate & Construction
  if (/\b(real estate|immobili|construction|b[aâ]timent|btp|architect|promoteur)\b/.test(t)) return 'Real Estate';
  // Media & Entertainment
  if (/\b(journalis|media|m[eé]dia|editor|[eé]diteur|r[eé]dacteur|tv\b|broadcast|cin[eé]ma|film|music|musique|entertainment)\b/.test(t)) return 'Media';
  // Logistics & Supply Chain
  if (/\b(logisti|supply chain|transport|shipping|warehouse|entrep[oô]t|chain|procurement|achat)\b/.test(t)) return 'Logistics';
  // Retail & E-commerce
  if (/\b(retail|e.?commerce|commerce|boutique|store|magasin|merchandis)\b/.test(t)) return 'Retail';
  // Research & Science
  if (/\b(research|recherche|scientist|scientifique|lab|laboratoire|phd|docto|chercheur)\b/.test(t)) return 'Research';
  return '';
}

// Detect the dominant language from a profile's text content.
// Returns an ISO-639-1 language name suitable for the AI prompt, or '' if uncertain.
function _detectLanguage(candidate) {
  const text = [
    candidate.about || '',
    candidate.title || candidate.currentRole || '',
    candidate.name || '',
  ].join(' ').toLowerCase();

  // Arabic script detection (unicode range)
  if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
  // French indicators (accents + common French words)
  if (/[éèêëàâùûîïôœç]/.test(text) || /\b(je|vous|nous|les|des|une|responsable|ingénieur|chef|développeur|entreprise)\b/.test(text)) return 'French';
  // Spanish
  if (/[áéíóúñ¿¡]/.test(text) || /\b(hola|trabajo|empresa|ingeniero|desarrollador|experiencia|gracias)\b/.test(text)) return 'Spanish';
  // German
  if (/[äöüß]/.test(text) || /\b(und|der|die|das|ich|sie|für|entwickler|unternehmen)\b/.test(text)) return 'German';
  // Italian
  if (/\b(sono|lavoro|azienda|ingegnere|sviluppatore|ciao|italiano)\b/.test(text)) return 'Italian';
  // Portuguese
  if (/\b(trabalho|empresa|engenheiro|desenvolvedor|obrigado|português)\b/.test(text)) return 'Portuguese';
  // Chinese/Japanese/Korean scripts
  if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(text)) return 'Chinese';
  return ''; // assume English / unknown
}

function _prefillOnboardingFromProfile() {
  if (!profile) return;
  const indEl = document.getElementById('netIndustry');
  const jtEl  = document.getElementById('netJobTitle');
  const senEl = document.getElementById('netSeniority');

  const role    = profile.currentRole || profile.headline || '';
  const company = profile.company || '';

  if (jtEl && !jtEl.value && role) jtEl.value = role;

  if (indEl && !indEl.value) {
    const inferred = _inferIndustry(role, company);
    if (inferred) indEl.value = inferred;
    else if (company) indEl.value = company; // last resort: company name
  }

  if (senEl && senEl.value === 'mid') {
    const inferred = _inferSeniority(role);
    if (inferred) senEl.value = inferred;
  }
}

function showNetOnboarding() {
  document.getElementById('netOnboarding').style.display = '';
  document.getElementById('netMain').style.display = 'none';
}

function showNetMain(goalData) {
  document.getElementById('netOnboarding').style.display = 'none';
  document.getElementById('netMain').style.display = '';
  const label = GOAL_LABELS[goalData.goal] || goalData.goal;
  document.getElementById('netGoalLabel').textContent = label;
}

async function saveNetworkingGoal() {
  const goal     = document.querySelector('input[name="netGoal"]:checked')?.value || 'job_search';
  const industry = document.getElementById('netIndustry').value.trim();
  const jobTitle = document.getElementById('netJobTitle').value.trim();
  const seniority = document.getElementById('netSeniority').value;

  const goalData = {
    goal,
    industry:  industry  || profile?.company  || '',
    job_title: jobTitle  || profile?.currentRole || '',
    seniority,
    skills:    profile?.skills || [],
    location:  profile?.location || '',
  };

  await chrome.storage.local.set({ networkingGoal: goalData });

  // Persist to backend (non-blocking)
  chrome.runtime.sendMessage({ action: 'networkingOnboarding', data: goalData }).catch(() => {});

  showNetMain(goalData);
}

// ── Analysis cache (TTL: 7 days, keyed by url_slug + goal) ───────────────────
const _CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function _getCachedAnalyses(slugs, goal) {
  const keys = slugs.map(s => `net_analysis_${goal}_${s}`);
  const stored = await chrome.storage.local.get(keys);
  const now = Date.now();
  const hits = {}, missSlugs = [];
  slugs.forEach(slug => {
    const entry = stored[`net_analysis_${goal}_${slug}`];
    if (entry && (now - entry.ts) < _CACHE_TTL_MS) {
      hits[slug] = entry.data;
    } else {
      missSlugs.push(slug);
    }
  });
  return { hits, missSlugs };
}

async function _cacheAnalyses(results, goal) {
  const items = {};
  for (const a of results) {
    if (a.slug) items[`net_analysis_${goal}_${a.slug}`] = { data: a, ts: Date.now() };
  }
  if (Object.keys(items).length) await chrome.storage.local.set(items);
}

async function runNetworkingScan() {
  const stored = await chrome.storage.local.get(['networkingGoal', 'myProfile']);
  if (!stored.networkingGoal) { showNetOnboarding(); return; }

  // Build rich user_profile by merging myProfile + networking goal
  const myP = stored.myProfile || {};
  const netGoal = stored.networkingGoal;
  const _userProfile = {
    goal:       netGoal.goal || 'job_search',
    industry:   netGoal.industry || '',
    job_title:  netGoal.job_title || myP.currentRole || myP.headline || '',
    seniority:  netGoal.seniority || '',
    skills:     netGoal.skills || myP.skills || [],
    // Full profile context from myProfile
    name:       myP.name || '',
    headline:   myP.headline || '',
    about:      myP.about || '',
    experience: (myP.experience || []).slice(0, 5),
    education:  (myP.education || []).slice(0, 3),
    location:   myP.location || '',
    company:    myP.company || myP.currentCompany || '',
  };

  const btn          = document.getElementById('netScanBtn');
  const statusEl     = document.getElementById('netStatus');
  const suggestionsEl = document.getElementById('netSuggestions');
  const statsBar     = document.getElementById('netStatsBar');

  const authData = await chrome.storage.sync.get(['authToken']);
  if (!authData.authToken) {
    statusEl.style.display = '';
    statusEl.textContent = 'Please log in to use Networking features. Click the Settings tab to sign in.';
    return;
  }

  btn.disabled = true;
  btn.textContent = window._t('analyzing');
  statusEl.style.display = '';
  statusEl.textContent = 'Reading page...';
  suggestionsEl.innerHTML = '';
  if (statsBar) statsBar.style.display = 'none';

  // Sync goal to backend
  await chrome.runtime.sendMessage({ action: 'networkingOnboarding', data: stored.networkingGoal }).catch(() => {});

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';

    // ── Context validation — guide the user to the correct page ──────────
    if (!url.includes('linkedin.com')) {
      statusEl.textContent = '';
      suggestionsEl.innerHTML = `
        <div class="net-context-guide">
          <div class="net-context-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>
          <strong>Wrong tab — LinkedIn not open</strong>
          <p>Open LinkedIn in a tab first, then come back here and click Scan.</p>
          <p style="margin-top:4px;font-size:11px;color:var(--tx3)">
            Best pages to scan:<br>
            • <strong>linkedin.com/mynetwork/</strong> — People You May Know<br>
            • <strong>linkedin.com/search/results/people/</strong> — Search results<br>
            • Any LinkedIn search filtered by role, industry, or company
          </p>
        </div>`;
      btn.disabled = false;
      btn.textContent = 'Scan';
      return;
    }

    const isValidScanPage = /linkedin\.com\/(mynetwork|search\/results\/people|search\/results\/all|connections|(company|school)\/[^/]+\/people)/.test(url);
    const isProfilePage   = /linkedin\.com\/in\//.test(url);

    if (isProfilePage) {
      statusEl.textContent = '';
      suggestionsEl.innerHTML = `
        <div class="net-context-guide">
          <div class="net-context-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
          <strong>You're on a profile page</strong>
          <p>Network Scan reads <em>lists</em> of people — not individual profiles.</p>
          <p style="margin-top:4px;font-size:11px;color:var(--tx3)">
            Go to one of these pages, then click Scan:<br>
            • <strong>linkedin.com/mynetwork/</strong> — People You May Know<br>
            • Use LinkedIn Search and filter by people
          </p>
        </div>`;
      btn.disabled = false;
      btn.textContent = 'Scan';
      return;
    }

    if (!isValidScanPage) {
      // Still on LinkedIn but not a people-list page — warn but allow
      statusEl.style.display = '';
      statusEl.textContent = 'Tip: For best results, go to linkedin.com/mynetwork/ or search results. Scanning anyway…';
    }

    // ── Stage 1: Surface scan ─────────────────────────────────────────────
    // On mynetwork/grow (and the org/school People tab, which uses the same
    // SDUI LazyColumn virtualization), cards are rendered in a virtualized
    // list — only rows near the current scroll position actually exist in
    // the DOM at any given moment; everything else is unmounted/recycled.
    // So we must scrape AT EACH scroll step while those rows are mounted,
    // and merge unique candidates as we go — scraping only once, after
    // scrolling back to the top, would unmount everything we just loaded.
    const isGrowPage = /mynetwork\/(grow|invite-connect)/i.test(tab.url || '') ||
      /linkedin\.com\/(company|school)\/[^/]+\/people/i.test(tab.url || '');

    let allCandidates = [];
    const seenSlugsAcrossSteps = new Set();
    const mergeStep = (stepResult) => {
      for (const c of (stepResult || [])) {
        if (c && c.url_slug && !seenSlugsAcrossSteps.has(c.url_slug)) {
          seenSlugsAcrossSteps.add(c.url_slug);
          allCandidates.push(c);
        }
      }
    };

    if (isGrowPage) {
      statusEl.style.display = '';
      statusEl.textContent = 'Scrolling page to load profile cards…';
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      // Scrape the initial (unscrolled) viewport first — this is where your
      // diagnosis found List 2 (8 profiles) sitting above the fold.
      const initialRes = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrapeNetworkingCandidatesInPage,
      });
      mergeStep(initialRes?.[0]?.result);

      // Scroll in steps — scrape after EACH step while those rows are still
      // mounted, then move to the next step. Never scrape after scrolling
      // back up, or the virtualized rows we just loaded will be gone.
      for (let i = 0; i < 6; i++) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (amount) => window.scrollBy(0, amount),
          args: [500],
        });
        await sleep(300);
        const stepRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrapeNetworkingCandidatesInPage,
        });
        mergeStep(stepRes?.[0]?.result);
      }

      // Cosmetic only — scroll back to top now that scraping is complete
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.scrollTo(0, 0),
      });
      await sleep(200);
    } else {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrapeNetworkingCandidatesInPage,
      });
      mergeStep(res?.[0]?.result);
    }

    if (!allCandidates.length) {
      suggestionsEl.innerHTML = `
        <div class="net-context-guide">
          <div class="net-context-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="8" y1="15" x2="16" y2="15"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></div>
          <strong>No people found on this page</strong>
          <p>The extension couldn't detect any profile cards here.</p>
          <p style="margin-top:4px;font-size:11px;color:var(--tx3)">
            Try these pages instead:<br>
            • <a href="https://www.linkedin.com/mynetwork/" target="_blank">People You May Know</a><br>
            • <a href="https://www.linkedin.com/search/results/people/" target="_blank">LinkedIn People Search</a>
          </p>
        </div>`;
      statusEl.textContent = '';
      return;
    }

    // Enrich candidates with industry/seniority (inferred in popup scope)
    for (const c of allCandidates) {
      if (!c.industry) c.industry = _inferIndustry(c.title || '', c.company || '') || '';
      if (!c.seniority) c.seniority = _inferSeniority(c.title || '') || '';
    }

    // Store for chat context
    window._lastNetCandidates = allCandidates;
    window._lastNetGoal = stored.networkingGoal;

    // ── Pre-filter: rule-based score first, then take top 10 ─────────────
    // Falls back to mutual-connection sort if scorer is unavailable
    _buildCoverageMap(allCandidates);
    // Weekly stats: count scans
    chrome.storage.local.get('weeklyStats').then(({ weeklyStats: ws = {} }) => {
      chrome.storage.local.set({ weeklyStats: { ...ws, scans: (ws.scans || 0) + 1 } });
    });
    statusEl.textContent = `${allCandidates.length} people found. Scoring candidates...`;
    let topCandidates;
    try {
      const scoreR = await chrome.runtime.sendMessage({
        action: 'networkingScore',
        data: { candidates: allCandidates, threshold: 0 },
      });
      if (scoreR?.success && scoreR.data?.length) {
        // scoreR.data is already sorted by _score.total DESC from backend
        topCandidates = scoreR.data.slice(0, 10);
      }
    } catch { /* fall through */ }

    if (!topCandidates) {
      // Fallback: mutual connections sort
      topCandidates = [...allCandidates]
        .sort((a, b) => b.mutual_connections_count - a.mutual_connections_count)
        .slice(0, 10);
    }

    if (statsBar) {
      statsBar.style.display = '';
      document.getElementById('netStatScanned').textContent   = `${allCandidates.length} scanned`;
      document.getElementById('netStatMatched').textContent   = `${topCandidates.length} selected`;
    }

    statusEl.textContent = `${allCandidates.length} people found. AI-analyzing top ${topCandidates.length}...`;
    window._netScanTime = Date.now();

    // ── Stage 2: Render skeleton cards ───────────────────────────────────
    renderSkeletonCards(topCandidates, suggestionsEl);

    // ── Stage 3A: Shallow AI analysis (cache-first, fast) ────────────────
    const goal = stored.networkingGoal.goal;
    const slugs = topCandidates.map(c => c.url_slug).filter(Boolean);
    const { hits: cachedA, missSlugs: missA } = await _getCachedAnalyses(slugs, goal);

    // Apply cached results immediately
    if (Object.keys(cachedA).length) {
      topCandidates.forEach((c, idx) => {
        const a = cachedA[c.url_slug];
        if (a) updateCardWithAnalysis(idx, a, c, stored.networkingGoal);
      });
      _sortNetCards(suggestionsEl);
    }

    // Fetch only uncached profiles from API
    const uncachedCandidates = topCandidates.filter(c => missA.includes(c.url_slug));
    if (uncachedCandidates.length) {
      const aR = await chrome.runtime.sendMessage({
        action: 'networkingAnalyze',
        data: { user_profile: _userProfile, target_profiles: uncachedCandidates, goal },
      }).catch(() => null);

      if (aR?.success) {
        await _cacheAnalyses(aR.data || [], goal);
        const aMap = Object.fromEntries((aR.data || []).map(a => [a.slug, a]));
        topCandidates.forEach((c, idx) => {
          const a = aMap[c.url_slug];
          if (a) updateCardWithAnalysis(idx, a, c, stored.networkingGoal);
        });
        _sortNetCards(suggestionsEl);
      }
    }

    const cachedCount = slugs.length - missA.length;
    statusEl.textContent = cachedCount > 0
      ? `${topCandidates.length} matches (${cachedCount} from cache).`
      : `${topCandidates.length} matches analyzed.`;

    // Persist scan results for resumable suggestions (expires after 24h)
    chrome.storage.local.set({
      _lastNetScanResults: {
        candidates: topCandidates,
        goalData: stored.networkingGoal,
        timestamp: Date.now(),
      }
    }).catch(() => {});

    if (statsBar) document.getElementById('netStatDeep').textContent = 'skipped (not needed)';
    statusEl.textContent = `${topCandidates.length} matches — analysis complete`;

    // ── Deep scan disabled ────────────────────────────────────────────────
    // The shallow pass (headline + about + mutual connections, no profile
    // visits) already produces accurate, well-grounded analysis. Opening
    // each candidate's full profile in a background tab added 30-60s of
    // wait time per scan without materially changing the AI's conclusions.
    // Kept here, commented out, in case richer signals are needed later.
    /*
    chrome.runtime.sendMessage({
      action: 'deepScanProfiles',
      data: { slugs: topCandidates.map(c => c.url_slug).filter(Boolean) },
    }).then(async deepR => {
      if (!deepR?.success) {
        statusEl.textContent = `${topCandidates.length} matches — analysis complete`;
        return;
      }
      const deepMap = Object.fromEntries((deepR.data || []).map(r => [r.slug, r.data]));
      const deepCount = Object.values(deepMap).filter(Boolean).length;
      if (statsBar) document.getElementById('netStatDeep').textContent = `${deepCount} deep scanned`;

      const enriched = topCandidates.map((c, idx) => {
        const deep = deepMap[c.url_slug] || {};
        const merged = { ...c };
        for (const [k, v] of Object.entries(deep)) {
          const isEmpty = v === null || v === undefined || v === '' ||
            (Array.isArray(v) && v.length === 0);
          if (!isEmpty) merged[k] = v;
        }
        if (!merged.title && merged.headline) merged.title = merged.headline;
        if (!merged.company && merged.experience?.[0]?.company) merged.company = merged.experience[0].company;
        const titleEl = document.getElementById(`net-title-${idx}`);
        if (titleEl && (merged.title || merged.company)) {
          titleEl.textContent = (merged.title || '') + (merged.company ? ' · ' + merged.company : '');
        }
        return merged;
      });

      const dR = await chrome.runtime.sendMessage({
        action: 'networkingAnalyze',
        data: { user_profile: _userProfile, target_profiles: enriched, goal: _userProfile.goal, force_refresh: true },
      }).catch(() => null);

      if (dR?.success) {
        await _cacheAnalyses(dR.data || [], goal);
        const dMap = Object.fromEntries((dR.data || []).map(a => [a.slug, a]));
        enriched.forEach((c, idx) => {
          const a = dMap[c.url_slug] || null;
          if (a) updateCardWithAnalysis(idx, a, c, stored.networkingGoal);
        });
        _sortNetCards(suggestionsEl);
      }
      statusEl.textContent = `${topCandidates.length} matches — deep AI analysis complete`;

    }).catch(() => {
      statusEl.textContent = `${topCandidates.length} matches — analysis complete`;
    });
    */

  } catch (e) {
    statusEl.textContent = 'Error: ' + (e.message || 'Unknown error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan This Page';
  }
}

// ── Network Coverage Map ─────────────────────────────────────────────────────
function _buildCoverageMap(candidates) {
  const mapEl   = document.getElementById('netCoverageMap');
  const toggleEl = document.getElementById('netMapToggle');
  if (!mapEl || !toggleEl) return;

  // Tally industries
  const industries = {};
  const seniorities = {};
  candidates.forEach(c => {
    const ind = c.industry || _inferIndustry(c.title || c.currentRole || '', c.company || c.currentCompany || '') || 'Other';
    industries[ind] = (industries[ind] || 0) + 1;
    const sen = c.seniority || _inferSeniority(c.title || c.currentRole || '') || 'Unknown';
    seniorities[sen] = (seniorities[sen] || 0) + 1;
  });

  const renderRows = (obj) => {
    const sorted = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = sorted[0]?.[1] || 1;
    return sorted.map(([name, count]) => {
      const pct = Math.round((count / max) * 100);
      return `<div class="net-cov-row">
        <span class="net-cov-name" title="${name}">${name}</span>
        <div class="net-cov-bar-wrap"><div class="net-cov-bar" style="width:${pct}%"></div></div>
        <span class="net-cov-count">${count}</span>
      </div>`;
    }).join('');
  };

  mapEl.innerHTML = `
    <h4>Network Coverage</h4>
    <div class="net-coverage-section">
      <div class="net-coverage-label">By Industry</div>
      ${renderRows(industries)}
    </div>
    <div class="net-coverage-section">
      <div class="net-coverage-label">By Seniority</div>
      ${renderRows(seniorities)}
    </div>`;

  toggleEl.classList.remove('hidden');

  let open = false;
  toggleEl.onclick = () => {
    open = !open;
    mapEl.classList.toggle('hidden', !open);
    toggleEl.textContent = open ? 'Map ▴' : 'Map ▾';
  };
}

function _netScoreRing(score, colorClass) {
  // SVG circular gauge. Circumference ≈ 100 (r=15.9, 2πr≈99.9)
  const pct   = Math.max(0, Math.min(100, score));
  const color = colorClass === 'score-high' ? '#15803d' : colorClass === 'score-mid' ? '#d97706' : '#9ca3af';
  const dash  = pct > 0 ? `${pct} 100` : '0 100';
  return `<svg class="net-score-ring" width="48" height="48" viewBox="0 0 36 36">
    <circle class="ring-track" cx="18" cy="18" r="15.9"/>
    <circle class="ring-fill" cx="18" cy="18" r="15.9"
      stroke="${color}" stroke-dasharray="${dash}" stroke-dashoffset="25" transform="rotate(-90 18 18)"/>
    <text class="ring-text" x="18" y="17" fill="${color}">${score > 0 ? score : '—'}</text>
    <text class="ring-label" x="18" y="24" fill="${color}">/100</text>
  </svg>`;
}

function _netInitials(name) {
  const parts = (name || '?').trim().split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

function renderSkeletonCards(candidates, container) {
  container.innerHTML = '';
  candidates.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'net-card';
    card.id = `net-card-${idx}`;
    card.dataset.idx = idx;
    const initials = _netInitials(c.name);
    card.innerHTML = `
      <div class="net-card-header">
        <input type="checkbox" class="net-card-check" id="net-check-${idx}" data-idx="${idx}" title="Select card" aria-label="Select ${esc(c.name || 'card')}">
        <div class="net-avatar net-avatar-low" id="net-avatar-${idx}">${esc(initials)}</div>
        <div class="net-card-info">
          <div class="net-card-name">${esc(c.name || 'Unknown')}</div>
          <div class="net-card-title" id="net-title-${idx}">${esc(((c.title || c.headline || '') + (c.company ? ' · ' + c.company : '')))}</div>
          <div class="net-card-meta">
            ${c.mutual_connections_count ? `<span class="net-card-mutual">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              ${c.mutual_connections_count}</span>` : ''}
            <span class="net-activity-badge" id="net-activity-${idx}"></span>
          </div>
        </div>
        <div id="net-ring-${idx}">${_netScoreRing(0, 'score-low')}</div>
      </div>
      <div class="net-scanning-label" id="net-summary-${idx}">
        <span class="net-spinner"></span> Analyzing with AI...
      </div>
      <div id="net-fit-${idx}"></div>
      <div class="net-strengths" id="net-strengths-${idx}"></div>
      <div class="net-starters" id="net-starters-${idx}"></div>
      <div class="net-signals" id="net-signals-${idx}"></div>
      <span class="net-approach-badge" id="net-approach-${idx}" style="display:none"></span>
      <div class="net-risks" id="net-risks-${idx}" style="display:none"></div>
      <div class="net-tone-row" id="net-tone-row-${idx}">
        <span class="net-tone-label">Tone:</span>
        <button class="net-tone-btn active" data-tone="" id="net-tone-default-${idx}">Default</button>
        <button class="net-tone-btn" data-tone="professional" id="net-tone-pro-${idx}">Professional</button>
        <button class="net-tone-btn" data-tone="casual" id="net-tone-cas-${idx}">Casual</button>
        <button class="net-tone-btn" data-tone="brief" id="net-tone-brief-${idx}">Brief</button>
      </div>
      <div class="net-message-box" id="net-msg-${idx}">
        <button class="net-gen-msg-btn" id="net-gen-msg-${idx}" title="Generate AI connection message">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          Generate Message
        </button>
      </div>
      <div class="net-card-actions">
        <button class="btn-sm btn-accent" id="net-open-${idx}" title="Open LinkedIn profile">Open Profile</button>
        <button class="btn-sm" id="net-copy-${idx}" disabled title="Copy generated message">Copy Message</button>
        <button class="btn-sm net-regen-btn" id="net-regen-${idx}" disabled title="Regenerate message">↻</button>
        <button class="btn-sm net-skip-btn" id="net-skip-${idx}">Skip</button>
      </div>
    `;
    container.appendChild(card);
    document.getElementById(`net-open-${idx}`).addEventListener('click', () => {
      const slug = c.url_slug || c.profileUrl || '';
      if (slug) {
        const url = slug.startsWith('http') ? slug : `https://www.linkedin.com/in/${slug}/`;
        chrome.tabs.create({ url });
      }
    });
    document.getElementById(`net-skip-${idx}`).addEventListener('click', () => {
      logNetworkingInteraction(c, 0, {}, 'skipped');
      card.style.opacity = '0.4';
      card.style.pointerEvents = 'none';
    });
  });
}

function updateCardWithAnalysis(idx, analysis, candidate, _goalData) {
  const score      = analysis.score || 0;
  const scoreClass = score >= 70 ? 'score-high' : score >= 45 ? 'score-mid' : 'score-low';
  const card       = document.getElementById(`net-card-${idx}`);
  const ringEl     = document.getElementById(`net-ring-${idx}`);
  const avatarEl   = document.getElementById(`net-avatar-${idx}`);
  const summaryEl  = document.getElementById(`net-summary-${idx}`);
  const fitEl      = document.getElementById(`net-fit-${idx}`);
  const strengthsEl = document.getElementById(`net-strengths-${idx}`);
  const startersEl = document.getElementById(`net-starters-${idx}`);
  const msgBox     = document.getElementById(`net-msg-${idx}`);

  if (!card) return;

  // Update headline/title element if deep scan brought richer data
  const titleEl = document.getElementById(`net-title-${idx}`);
  if (titleEl && (candidate.title || candidate.headline || candidate.company)) {
    titleEl.textContent = (candidate.title || candidate.headline || '') +
      (candidate.company ? ' · ' + candidate.company : '');
  }

  // Card border + avatar color
  card.className = `net-card ${scoreClass}`;
  card.dataset.score = score;
  if (avatarEl) {
    avatarEl.className = `net-avatar net-avatar-${scoreClass === 'score-high' ? 'high' : scoreClass === 'score-mid' ? 'mid' : 'low'}`;
  }

  // Score ring
  if (ringEl) ringEl.innerHTML = _netScoreRing(score, scoreClass);

  // Activity badge (updated on deep scan pass when candidate has last_post_days)
  const actEl = document.getElementById(`net-activity-${idx}`);
  if (actEl && candidate.last_post_days !== undefined && candidate.last_post_days !== null) {
    const d = candidate.last_post_days;
    let label, cls;
    if (d === 0)      { label = 'Active today'; cls = 'activity-hot'; }
    else if (d <= 3)  { label = `${d}d ago`; cls = 'activity-hot'; }
    else if (d <= 14) { label = `${d}d ago`; cls = 'activity-warm'; }
    else if (d <= 30) { label = `${d}d ago`; cls = 'activity-cool'; }
    else              { label = `${Math.floor(d/30)}mo ago`; cls = 'activity-cold'; }
    actEl.textContent = '● ' + label;
    actEl.className = `net-activity-badge ${cls}`;
    actEl.title = candidate.post_count_30d ? `${candidate.post_count_30d} posts in last 30 days` : 'Last activity';
  }

  // Match summary
  if (summaryEl) {
    summaryEl.className = 'net-match-summary';
    summaryEl.textContent = analysis.match_summary || '';
  }

  // Fit assessment
  if (fitEl && analysis.fit_assessment) {
    fitEl.className = 'net-fit-assess';
    fitEl.textContent = analysis.fit_assessment;
  }

  // Strength pills
  if (strengthsEl && analysis.strengths?.length) {
    strengthsEl.innerHTML = analysis.strengths.slice(0, 3)
      .map(s => `<span class="net-strength-pill">${esc(s)}</span>`).join('');
  }

  // Conversation starters
  if (startersEl && analysis.conversation_starters?.length) {
    startersEl.innerHTML = analysis.conversation_starters.slice(0, 2)
      .map(s => `<button class="net-starter-chip" title="${esc(s)}">${esc(s)}</button>`).join('');
    startersEl.querySelectorAll('.net-starter-chip').forEach(btn => {
      btn.addEventListener('click', () => navigator.clipboard.writeText(btn.title).then(() => flash(null, 'Copied!')));
    });
  }

  // Signal breakdown chips (new field)
  const signalEl = document.getElementById(`net-signals-${idx}`);
  const signals = analysis.signal_breakdown || {};
  if (signalEl && Object.keys(signals).length > 0) {
    const signalLabels = { skill_overlap: 'Skills', industry_match: 'Industry', seniority_fit: 'Seniority', company_relevance: 'Company', profile_quality: 'Profile', mutual_connections: 'Mutual' };
    signalEl.innerHTML = Object.entries(signals)
      .filter(([, v]) => v !== 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => {
        const cls = v > 0 ? 'net-signal-pos' : 'net-signal-neg';
        return `<span class="net-signal-chip ${cls}">${v > 0 ? '+' : ''}${v} ${signalLabels[k] || k}</span>`;
      }).join('');
  }

  // Approach strategy badge (new field)
  const approachEl = document.getElementById(`net-approach-${idx}`);
  const strategy = analysis.approach_strategy || '';
  if (approachEl && strategy) {
    const stratLabels = { direct_message: 'Direct Message', comment_first: 'Comment First', mutual_intro: 'Mutual Intro', engage_content: 'Engage Content' };
    approachEl.textContent = stratLabels[strategy] || strategy;
    approachEl.style.display = '';
  }

  // Risk factors (new field)
  const riskEl = document.getElementById(`net-risks-${idx}`);
  const risks = (analysis.risk_factors || []).filter(r => r !== 'analysis_failed');
  if (riskEl && risks.length > 0) {
    riskEl.innerHTML = risks.map(r => `<span class="net-risk-chip">${esc(r)}</span>`).join('');
    riskEl.style.display = '';
  }

  // Message + action buttons
  function _applyMessage(text) {
    const msgId = `ai-${Date.now()}-${idx}`;
    if (msgBox) msgBox.innerHTML = `<div class="net-message-text">${esc(text)}</div>`;

    const freshCopy = document.getElementById(`net-copy-${idx}`);
    if (freshCopy) {
      freshCopy.disabled = false;
      const nc = freshCopy.cloneNode(true);
      freshCopy.parentNode.replaceChild(nc, freshCopy);
      nc.addEventListener('click', () => navigator.clipboard.writeText(text).then(() => flash(`net-copy-${idx}`, 'Copied!')));
    }

    // "Connect" button removed — replaced by "Open Profile" (wired in renderSkeletonCards)

    // Regenerate button
    const regenBtn = document.getElementById(`net-regen-${idx}`);
    if (regenBtn) {
      regenBtn.disabled = false;
      const nr = regenBtn.cloneNode(true);
      regenBtn.parentNode.replaceChild(nr, regenBtn);
      nr.addEventListener('click', async () => {
        nr.disabled = true;
        nr.textContent = '...';
        if (msgBox) msgBox.innerHTML = `<div class="net-message-placeholder">Regenerating...</div>`;
        try {
          const r = await chrome.runtime.sendMessage({
            action: 'networkingMessage',
            data: {
              candidate: { ...candidate, about: candidate.about || '' },
              goal: window._lastNetGoal || {},
            },
          });
          const newMsg = r?.data?.message || r?.data || text;
          _applyMessage(newMsg);
          // Update cache with new message
          const goal = window._lastNetGoal?.goal || 'default';
          const cacheKey = `net_analysis_${goal}_${candidate.url_slug}`;
          const existing = await chrome.storage.local.get(cacheKey);
          if (existing[cacheKey]) {
            existing[cacheKey].data.message = newMsg;
            await chrome.storage.local.set({ [cacheKey]: existing[cacheKey] });
          }
        } catch {
          _applyMessage(text); // revert on error
        }
      });
    }
  }

  const msgText = analysis.message || '';
  const detectedLang = _detectLanguage(candidate);

  // Cache message from analysis but don't auto-display — user clicks "Generate Message" button
  if (!window._pendingMessages) window._pendingMessages = {};
  if (msgText) window._pendingMessages[idx] = msgText;

  // Wire the "Generate Message" button
  const genBtn = document.getElementById(`net-gen-msg-${idx}`);
  if (genBtn) {
    genBtn.addEventListener('click', async () => {
      genBtn.disabled = true;
      genBtn.textContent = window._t('generating');
      const cached = window._pendingMessages?.[idx];
      if (cached) {
        _applyMessage(cached);
        _wirePostGenUI();
        return;
      }
      // No cached message — call the message endpoint
      try {
        const r = await chrome.runtime.sendMessage({
          action: 'networkingMessage',
          data: {
            candidate: { ...candidate, about: candidate.about || '' },
            goal: window._lastNetGoal || {},
          },
        });
        const newMsg = r?.data?.message || r?.data || 'Could not generate message.';
        window._pendingMessages[idx] = newMsg;
        _applyMessage(newMsg);
        _wirePostGenUI();
      } catch {
        if (msgBox) msgBox.innerHTML = `<button class="net-gen-msg-btn" id="net-gen-msg-${idx}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Retry</button>`;
      }
    });
  }

  // Helper to wire tone/regen/lang UI after message is generated
  function _wirePostGenUI() {
    const currentMsg = window._pendingMessages?.[idx] || msgText;
    if (!currentMsg) return;

    // Show language badge in tone row if non-English
    const toneRow = document.getElementById(`net-tone-row-${idx}`);
    if (toneRow && detectedLang) {
      const existing = toneRow.querySelector('.net-lang-badge');
      if (!existing) {
        const badge = document.createElement('span');
        badge.className = 'net-lang-badge';
        badge.textContent = detectedLang;
        badge.title = `Profile language detected: ${detectedLang}. Messages will be adapted.`;
        toneRow.appendChild(badge);
      }
    }

    // Wire tone selector buttons
    if (toneRow) {
      toneRow.querySelectorAll('.net-tone-btn').forEach(btn => {
        const freshBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(freshBtn, btn);
        freshBtn.addEventListener('click', async () => {
          if (freshBtn.disabled) return;
          toneRow.querySelectorAll('.net-tone-btn').forEach(b => b.classList.remove('active'));
          freshBtn.classList.add('active');
          const tone = freshBtn.dataset.tone;
          if (!tone) { _applyMessage(msgText); return; } // Default = original
          if (msgBox) msgBox.innerHTML = `<div class="net-message-placeholder">Rewriting as ${tone}...</div>`;
          toneRow.querySelectorAll('.net-tone-btn').forEach(b => { b.disabled = true; });
          try {
            const baseGoal = window._lastNetGoal?.goal || 'networking';
            const langHint = detectedLang ? `, write in ${detectedLang}` : '';
            const goalWithTone = `${baseGoal} (${tone} tone${langHint})`;
            const r = await chrome.runtime.sendMessage({
              action: 'networkingAnalyze',
              data: {
                user_profile: window._lastNetGoal || {},
                target_profiles: [{ ...candidate }],
                goal: goalWithTone,
              },
            });
            const newMsg = r?.data?.[0]?.message || msgText;
            _applyMessage(newMsg);
          } catch {
            _applyMessage(msgText);
          } finally {
            toneRow.querySelectorAll('.net-tone-btn').forEach(b => { b.disabled = false; });
          }
        });
      });
    }
  }
}

function _sortNetCards(container) {
  // Re-order cards in DOM by their data-score attribute (highest first)
  const cards = [...container.querySelectorAll('.net-card[data-score]')];
  if (cards.length < 2) return;
  cards.sort((a, b) => (parseInt(b.dataset.score) || 0) - (parseInt(a.dataset.score) || 0));
  cards.forEach(card => container.appendChild(card));
}

function logNetworkingInteraction(candidate, score, breakdown, action, msgId) {
  const interactionStart = window._netScanTime || Date.now();
  chrome.runtime.sendMessage({
    action: 'networkingInteraction',
    data: {
      suggested_profile_id: candidate.url_slug || candidate.name || '',
      score_given:          score,
      score_breakdown:      breakdown,
      user_action:          action,
      msg_id:               msgId || null,
      reason_shown:         Object.entries(breakdown).sort((a,b) => b[1]-a[1])[0]?.[0] || '',
      time_to_decision_seconds: Math.round((Date.now() - interactionStart) / 1000),
    },
  }).catch(() => {});
}

// ── Candidate scraper injected into LinkedIn page ────────────────────────────
// This function runs inside the LinkedIn tab via executeScript.
function scrapeNetworkingCandidatesInPage() {
  const url = location.href;
  const isSearch  = /linkedin\.com\/search\/results\/people/i.test(url);
  const isNetwork = /linkedin\.com\/mynetwork/i.test(url);
  // Also match the "grow" page (/mynetwork/grow) and generic feed with people cards
  const isGrow    = /linkedin\.com\/mynetwork\/grow/i.test(url);
  // Company/School "People" tab — e.g. linkedin.com/school/universite-ibn-zohr/people/
  // These pages render the same role=list / role=listitem SDUI structure as mynetwork
  // and are full of real profile cards, so they must not be excluded here.
  const isOrgPeople = /linkedin\.com\/(company|school)\/[^/]+\/people/i.test(url);

  if (!isSearch && !isNetwork && !isGrow && !isOrgPeople) return [];

  const candidates = [];
  const seenSlugs = new Set();
  const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const LIMIT = 50;

  const extractMutual = (el) => {
    for (const span of el.querySelectorAll('span, div, p')) {
      const t = span.textContent.trim();
      if (/mutual|en commun/i.test(t)) {
        const m = t.match(/(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
    }
    return 0;
  };

  const extractSlug = (el) => {
    // Try all links with /in/
    for (const a of el.querySelectorAll('a[href*="/in/"]')) {
      const m = a.href.match(/\/in\/([^/?#]+)/);
      if (m && m[1] !== 'undefined') return m[1];
    }
    return '';
  };

  // Detect LinkedIn game/ad widget cards (Wend, Zip, etc.)
  // These appear in the mynetwork/grow feed but are NOT real people
  const isAdOrGameCard = (card) => {
    const text = card.textContent || '';
    // Game widgets have names like "Wend #10", "Zip #458" — hashtag + number pattern
    if (/\b\w+\s+#\d+\b/.test(text)) return true;
    // Sponsored / promoted content
    if (/\bsponsored\b|\bpromoted\b|\bpublicité\b/i.test(text)) return true;
    // componentkey patterns for known LinkedIn game/app widgets
    const ck = card.getAttribute('componentkey') || '';
    if (/game|app-promo|native-ad|sponsored/i.test(ck)) return true;
    // Cards that have "/in/" links pointing to pages (company pages have /company/ not /in/)
    // but game widgets use /in/ for their "app page" — detect by checking if ALL /in/ links
    // on the card point to the same slug that looks like a game name (short, no spaces, + digits)
    const links = [...card.querySelectorAll('a[href*="/in/"]')];
    if (links.length > 0) {
      const slugs = links.map(a => { const m = a.href.match(/\/in\/([^/?#]+)/); return m ? m[1] : ''; }).filter(Boolean);
      // If every slug ends in a number pattern like "-10" or "wend-game" it's likely an ad
      if (slugs.length > 0 && slugs.every(s => /\d{2,}$/.test(s) || /^(wend|zip|leet|chess|wordle|trivia)/i.test(s))) return true;
    }
    return false;
  };

  const addCandidate = (card, source) => {
    if (candidates.length >= LIMIT) return;
    // Skip LinkedIn game widgets and sponsored cards
    if (isAdOrGameCard(card)) return;
    const slug = extractSlug(card);
    if (!slug || seenSlugs.has(slug)) return;

    // Name: try many patterns — LinkedIn keeps changing class names
    let name = '';
    for (const sel of [
      '.entity-result__title-text a span[aria-hidden="true"]',
      '.entity-result__title-text span[aria-hidden="true"]',
      'a[href*="/in/"] span[aria-hidden="true"]',
      '.app-aware-link span[aria-hidden="true"]',
      '.mn-person-info__name',
      '.discover-person-card__name',
      '[data-anonymize="person-name"]',
      'span.t-bold > span[aria-hidden="true"]',
      'strong',
      // 2026 SDUI mynetwork: name is in a span[aria-hidden] directly inside the profile <a>
      'a[href*="/in/"] > span[aria-hidden="true"]',
      'a[href*="/in/"] span[aria-hidden="true"]',
    ]) {
      const el = card.querySelector(sel);
      if (el) {
        const t = normalize(el.textContent);
        // Name should be 2-80 chars, not a UI label
        if (t && t.length >= 2 && t.length < 80 && !/connect|follow|message|pending|withdraw/i.test(t)) {
          name = t; break;
        }
      }
    }

    // Title/headline
    let title = '';
    for (const sel of [
      '.entity-result__primary-subtitle',
      '.entity-result__summary',
      '[data-anonymize="person-blurb"]',
      '.mn-person-info__occupation',
      '.discover-person-card__occupation',
      '.t-14.t-normal.t-black--light',
      '.entity-result__summary--2-lines',
      'div.t-14.t-normal',
    ]) {
      const el = card.querySelector(sel);
      if (el) { title = normalize(el.textContent); if (title) break; }
    }

    // Company
    let company = '';
    for (const sel of ['.entity-result__secondary-subtitle', '.entity-result__badge-text']) {
      const el = card.querySelector(sel);
      if (el) { company = normalize(el.textContent); if (company) break; }
    }

    // If we still have no name, try the first non-empty aria-hidden span that's NOT a subtitle
    if (!name) {
      for (const span of card.querySelectorAll('span[aria-hidden="true"]')) {
        if (span.closest('button')) continue;
        const t = normalize(span.textContent);
        if (t && t.length >= 2 && t.length < 60 && t !== title && !/connect|follow|message|mutual/i.test(t)) {
          name = t; break;
        }
      }
    }

    // 2026 new layout fallback: name/headline are bare <p><span>text</span></p> nodes
    // with NO aria-hidden, NO semantic class — just plain unmarked spans inside the profile <a>.
    // The mutual-connections line lives in a sibling div OUTSIDE the <a>, so it won't bleed in.
    if (!name || !title) {
      const profileLink = card.querySelector('a[href*="/in/"]');
      if (profileLink) {
        const pSpanTexts = [...profileLink.querySelectorAll('p > span')]
          .map(el => normalize(el.textContent))
          .filter(t => t.length >= 2 && !/connect|follow|message|pending|withdraw/i.test(t));
        if (!name && pSpanTexts[0]) name = pSpanTexts[0];
        if (!title && pSpanTexts[1]) title = pSpanTexts[1];
      }
    }

    if (!name) return;
    seenSlugs.add(slug);

    candidates.push({
      url_slug: slug,
      name,
      title,
      company,
      industry: '',
      seniority: '',
      mutual_connections_count: extractMutual(card),
      open_to_connect: !!card.querySelector('[aria-label*="Connect"], button[aria-label*="connect" i], .invitation-card__action-btn'),
      source_page: source,
    });
  };

  if (isSearch) {
    // Search results — broad selector: any <li> that contains a /in/ link
    const cards = document.querySelectorAll([
      '.entity-result',
      'li.reusable-search__result-container',
      'li[data-chameleon-result-urn]',
      '.search-results-container li',
      // 2025/2026 fallback: any list item with a profile link
      'ul li:has(a[href*="/in/"])',
      'div[data-view-name="search-entity-result-universal-template"]',
    ].join(', '));
    for (const card of cards) addCandidate(card, 'search');
  }

  if (isNetwork || isGrow || isOrgPeople) {
    // People You May Know + Suggestions + Company/School People tab —
    // covers old and new LinkedIn layouts
    const cards = document.querySelectorAll([
      // Legacy PYMK
      '.mn-pymk-list__item',
      '[data-view-name="pymk-card"]',
      '.discover-person-card',
      '[data-view-name*="pymk"]',
      // 2024/2025 SDUI suggestion cards
      '[data-view-name="member-relationships-member-card"]',
      '[data-view-name*="suggestion"]',
      '[data-view-name*="grow"]',
      // Generic containers with profile link + name (broad net)
      '.artdeco-list__item:has(a[href*="/in/"])',
      'li:has(a[href*="/in/"]):has(button)',
      'li:has(a[href*="/in/"]):has(a[aria-label*="Connect" i])',
      'li:has(a[href*="/in/"]):has(a[aria-label*="Follow" i])',
      // 2025/2026: card wrapper divs
      'div[data-member-id]:has(a[href*="/in/"])',
      'div[data-urn]:has(a[href*="/in/"])',
      'section li:has(a[href*="/in/"])',
      'div[class*="card"]:has(a[href*="/in/"])',
      // 2026 SDUI mynetwork/org-people layout: role=listitem elements inside role=list
      // (not assumed to be <div> — School/Company People tab can use other tags)
      '[role="listitem"]:has(a[href*="/in/"])',
      '[role="list"] > *:has(a[href*="/in/"])',
      '[data-sdui-screen*="mynetwork"] div:has(a[href*="/in/"]):has(a[href*="/in/"] ~ div)',
    ].join(', '));
    for (const card of cards) addCandidate(card, isOrgPeople ? 'org_people' : 'mynetwork');
  }

  // Ultimate fallback: if no candidates found with specific selectors,
  // scan ALL elements with /in/ links (catches any LinkedIn layout)
  if (candidates.length === 0) {
    const profileLinks = document.querySelectorAll('a[href*="/in/"]');
    const processed = new Set();
    for (const link of profileLinks) {
      if (candidates.length >= LIMIT) break;
      const m = link.href.match(/\/in\/([^/?#]+)/);
      if (!m || seenSlugs.has(m[1])) continue;
      // Walk up to find the card container (stop at body)
      let container = link.parentElement;
      for (let i = 0; i < 8 && container && container !== document.body; i++) {
        // Good container: has some text AND has a button OR another action link (Connect/Follow/Message)
        // Also accept SDUI role=listitem divs which use plain <a> tags without aria-labels
        const hasAction = container.querySelector('button') ||
          container.querySelector('a[aria-label*="Connect" i], a[aria-label*="Follow" i], a[aria-label*="Message" i]');
        const isSduiListItem = container.getAttribute('role') === 'listitem';
        if ((hasAction || isSduiListItem) && container.textContent.length > 20) break;
        container = container.parentElement;
      }
      if (!container || container === document.body || processed.has(container)) continue;
      processed.add(container);
      addCandidate(container, isSearch ? 'search' : (isOrgPeople ? 'org_people' : 'mynetwork'));
    }
  }

  console.log(`[Subul IN] collectCandidates: found ${candidates.length} on ${url} (isSearch=${isSearch} isNetwork=${isNetwork} isGrow=${isGrow} isOrgPeople=${isOrgPeople})`);
  return candidates;
}


// ══════════════════════════════════════
//  PROFILE GAP TAB
// ══════════════════════════════════════

// ── Onboarding Tour ──────────────────────────────────────────────────────────
const _TOUR_STEPS = [
  {
    anchor: '#homeAvatar',
    body: '<strong>Welcome to Subul IN!</strong><br>This is your LinkedIn AI copilot. First, visit your own <strong>LinkedIn profile</strong> page — the extension will auto-extract your data so all features are personalized to you.',
  },
  {
    anchor: '[data-nav="post"]',
    body: '<strong>Post Generator</strong> — Enter a topic, choose tone and length, then click <em>Generate</em>. Your AI writes a ready-to-post LinkedIn post. Click <em>Edit</em> to adjust the text, then <em>Copy</em> — and paste it into LinkedIn yourself.',
  },
  {
    anchor: '[data-nav="profile"]',
    body: '<strong>Profile Tools</strong> — Generate an improved headline & about section, run an <em>AI Score</em> to see how strong your profile is, or analyze a specific section. All suggestions are based on your scraped data.',
  },
  {
    anchor: '[data-nav="networking"]',
    body: '<strong>Network Scan</strong> — Go to a LinkedIn People search, then open this tab. The extension scans visible profiles and scores each one as a connection candidate based on your networking goal.',
  },
  {
    anchor: '[data-nav="gap"]',
    body: '<strong>Gap Analysis</strong> — Visit any LinkedIn profile or paste a job description, then run a gap analysis. You\'ll get a side-by-side view of your skills vs. theirs, plus a connection strategy.',
  },
  {
    anchor: '#homeChatCta',
    body: '<strong>AI Chat</strong> — Your always-on career advisor. Ask anything: "How do I improve my profile?", "Write a follow-up message for this contact", or "What skills should I add for this role?"',
  },
  {
    anchor: '[data-nav="learning"], [data-nav="subul"], #subulTab',
    body: '<strong>Subul Certifications Post</strong> — Earned a certificate on <em>Subul</em>? Head to the <strong>Learning</strong> tab to see your synced Subul certifications. Click <em>"Create Post"</em> next to any certificate and your AI will write a ready-to-share LinkedIn post celebrating your achievement — just copy and paste it!',
  },
  {
    anchor: '[data-nav="settings"]',
    body: '<strong>Settings</strong> — Change language, enable email notifications for AI results, or manually edit your profile data. You can replay this guide anytime from Settings. <strong>You\'re all set!</strong>',
  },
];

async function startOnboardingTour() {
  const { tourDone } = await chrome.storage.local.get('tourDone');
  if (tourDone) return;
  _showTourStep(0);
}

function _showTourStep(idx) {
  const overlay    = document.getElementById('tourOverlay');
  const labelEl    = document.getElementById('tourStepLabel');
  const progressEl = document.getElementById('tourProgress');
  const bodyEl     = document.getElementById('tourBody');
  const nextBtn    = document.getElementById('tourNext');
  const skipBtn    = document.getElementById('tourSkip');
  if (!overlay) return;

  // Fade out previous highlights, then remove after transition completes
  const prevHighlighted = [...document.querySelectorAll('.tour-highlight')];
  prevHighlighted.forEach(el => {
    el.classList.add('tour-highlight-fading');
    setTimeout(() => {
      el.classList.remove('tour-highlight');
      el.classList.remove('tour-highlight-fading');
    }, 260);
  });

  if (idx >= _TOUR_STEPS.length) {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    chrome.storage.local.set({ tourDone: true });
    return;
  }

  const step = _TOUR_STEPS[idx];

  // Update step label
  labelEl.textContent = `Step ${idx + 1} of ${_TOUR_STEPS.length}`;

  // Update progress dots
  if (progressEl) {
    progressEl.innerHTML = '';
    for (let i = 0; i < _TOUR_STEPS.length; i++) {
      const dot = document.createElement('span');
      dot.className = 'tour-progress-dot' + (i === idx ? ' active' : '');
      progressEl.appendChild(dot);
    }
  }

  // Update body content
  bodyEl.innerHTML = step.body;
  bodyEl.scrollTop = 0; // reset scroll for new step

  // Update Next/Done label
  nextBtn.textContent = idx === _TOUR_STEPS.length - 1 ? 'Done' : 'Next';

  // Show overlay
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');

  // Highlight anchor element (visible above the overlay dim via z-index: 10001)
  if (step.anchor) {
    const anchor = document.querySelector(step.anchor);
    if (anchor) {
      anchor.classList.add('tour-highlight');
      anchor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Wire Next button — clone to remove stale listeners
  const freshNext = nextBtn.cloneNode(true);
  nextBtn.parentNode.replaceChild(freshNext, nextBtn);
  freshNext.textContent = idx === _TOUR_STEPS.length - 1 ? 'Done' : 'Next';
  freshNext.addEventListener('click', () => _showTourStep(idx + 1));

  // Wire Skip button
  const freshSkip = skipBtn.cloneNode(true);
  skipBtn.parentNode.replaceChild(freshSkip, skipBtn);
  freshSkip.addEventListener('click', () => {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    document.querySelectorAll('.tour-highlight').forEach(el => {
      el.classList.remove('tour-highlight');
      el.classList.remove('tour-highlight-fading');
    });
    chrome.storage.local.set({ tourDone: true });
  });

  // Clicking the dim backdrop (not the tooltip itself) also dismisses
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      document.querySelectorAll('.tour-highlight').forEach(el => {
        el.classList.remove('tour-highlight');
        el.classList.remove('tour-highlight-fading');
      });
      chrome.storage.local.set({ tourDone: true });
    }
  };
}

let _gapScrapedTarget = null; // holds target profile between step 1 and step 2
let _jobScraped = null;       // holds extracted job posting between scrape and analysis
let _gapResultMode = null;    // 'profile' | 'jd' | 'job' — tracks which mode produced the last visible result

function initGapTab() {
  // Gap consent gate
  const gapConsentCheck = document.getElementById('gapConsentCheck');
  const gapConsentAcceptBtn = document.getElementById('gapConsentAcceptBtn');
  if (gapConsentCheck && gapConsentAcceptBtn) {
    gapConsentCheck.addEventListener('change', () => {
      gapConsentAcceptBtn.disabled = !gapConsentCheck.checked;
    });
    gapConsentAcceptBtn.addEventListener('click', async () => {
      await chrome.storage.local.set({ gapConsentGiven: true });
      document.getElementById('gapConsent').style.display = 'none';
      document.getElementById('gapModeTabs').style.display = '';
      document.getElementById('gapIdle').classList.remove('gap-hidden');
    });
  }

  document.getElementById('gapScrapeBtn').addEventListener('click', async () => {
    const confirmed = await showExtractionWarning();
    if (confirmed) gapScrapeTarget();
  });
  document.getElementById('gapAnalyzeBtn').addEventListener('click', runGapAnalysis);

  // Mode tabs
  document.getElementById('gapModeProfile').addEventListener('click', () => _setGapMode('profile'));
  document.getElementById('gapModeJob').addEventListener('click', () => { _setGapMode('job'); _checkJobPageActive(); });
  document.getElementById('gapJDAnalyzeBtn').addEventListener('click', runGapAnalysisJD);
  document.getElementById('gapJobScrapeBtn').addEventListener('click', gapScrapeJob);
  document.getElementById('gapJobAnalyzeBtn').addEventListener('click', runJobFitAnalysis);
  document.getElementById('jfResetBtn').addEventListener('click', () => {
    _jobScraped = null;
    _gapResultMode = null;
    document.getElementById('gapJobResult').classList.add('gap-hidden');
    document.getElementById('gapJobPreview').style.display = 'none';
    document.getElementById('gapJobScrapeBtn').style.display = '';
    document.getElementById('gapJobAnalyzeBtn').style.display = 'none';
    document.getElementById('gapIdle').classList.remove('gap-hidden');
    _setGapMode('job');
  });
  document.getElementById('jfPdfBtn').addEventListener('click', () => exportJobFitAsPdf());
  document.getElementById('gapRescrapeBtn').addEventListener('click', async () => {
    const confirmed = await showExtractionWarning();
    if (!confirmed) return;
    _gapScrapedTarget = null;
    document.getElementById('gapScraped').classList.add('gap-hidden');
    document.getElementById('gapIdle').classList.remove('gap-hidden');
    gapScrapeTarget();
  });
  document.getElementById('gapResetBtn').addEventListener('click', async () => {
    const ok = await confirmDialog('Reset Analysis', 'Discard this gap analysis and start over?', { okText: 'Reset', danger: true });
    if (!ok) return;
    _gapScrapedTarget = null;
    _gapResultMode = null;
    document.getElementById('gapResult').classList.add('gap-hidden');
    document.getElementById('gapScraped').classList.add('gap-hidden');
    document.getElementById('gapIdle').classList.remove('gap-hidden');
  });
  document.getElementById('gapExportBtn').addEventListener('click', () => {
    exportElementAsImage('gapResult', 'linkedin-gap-analysis.png');
  });
}

function _displayScrapedTarget(tp) {
  const el = (id) => document.getElementById(id);
  const avatarEl = el('gapScrapedAvatar');
  if (_isValidImageUrl(tp.profilePhotoUrl)) {
    avatarEl.textContent = '';
    avatarEl.style.backgroundImage = `url('${tp.profilePhotoUrl.replace(/'/g, "\\'")}')`;
    avatarEl.style.backgroundSize = 'cover';
    avatarEl.style.backgroundPosition = 'center';
  } else {
    avatarEl.style.backgroundImage = '';
    avatarEl.textContent = tp.name ? tp.name[0].toUpperCase() : '?';
  }
  el('gapScrapedName').textContent = tp.name || 'Unknown';
  el('gapScrapedHeadline').textContent = tp.headline || tp.title || tp.currentRole || '—';
  el('gapScrapedLocation').textContent = tp.location || '';

  const about = tp.about || '';
  if (about) {
    el('gapScrapedAbout').textContent = about.length > 200 ? about.substring(0, 200) + '...' : about;
    el('gapScrapedAbout').style.display = '';
  } else {
    el('gapScrapedAbout').style.display = 'none';
  }

  const exp = tp.experience || [];
  if (exp.length > 0) {
    el('gapScrapedExp').innerHTML = exp.slice(0, 8).map(e => {
      const t = e.title || '';
      const c = e.company ? ` at ${e.company}` : '';
      const d = e.dates ? ` <span style="color:var(--tx3)">(${e.dates})</span>` : '';
      return `<div>${t}${c}${d}</div>`;
    }).join('');
    el('gapScrapedExpSection').style.display = '';
  } else {
    el('gapScrapedExpSection').style.display = 'none';
  }

  const edu = tp.education || [];
  if (edu.length > 0) {
    el('gapScrapedEdu').innerHTML = edu.map(e => {
      const s = e.school || '';
      const deg = e.degree ? ` — ${e.degree}` : '';
      return `<div>${s}${deg}</div>`;
    }).join('');
    el('gapScrapedEduSection').style.display = '';
  } else {
    el('gapScrapedEduSection').style.display = 'none';
  }

  const skills = tp.skills || [];
  if (skills.length > 0) {
    el('gapScrapedSkills').innerHTML = skills.slice(0, 20).map(s => `<span>${s}</span>`).join('');
    el('gapScrapedSkillsSection').style.display = '';
  } else {
    el('gapScrapedSkillsSection').style.display = 'none';
  }
}

async function gapScrapeTarget() {
  const stored = await chrome.storage.local.get(['myProfile', 'gapConsentGiven']);
  if (!stored.gapConsentGiven) {
    document.getElementById('gapIdle').classList.add('gap-hidden');
    document.getElementById('gapModeTabs').style.display = 'none';
    document.getElementById('gapConsent').style.display = '';
    return;
  }
  const myP = stored.myProfile;
  if (!myP || (!myP.name && !myP.headline)) {
    toast('Your profile is not saved yet. Visit YOUR LinkedIn profile page first — the extension will auto-extract it.', 'warn', 5000);
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('linkedin.com/in/')) {
    toast('Go to a LinkedIn profile (yours or someone else\'s) then click Extract.', 'warn');
    return;
  }

  // Show loading
  document.getElementById('gapIdle').classList.add('gap-hidden');
  document.getElementById('gapScraped').classList.add('gap-hidden');
  document.getElementById('gapResult').classList.add('gap-hidden');
  document.getElementById('gapLoading').classList.remove('gap-hidden');
  document.querySelector('#gapLoading').innerHTML = '<span class="net-spinner"></span> Extracting target profile...';

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: inlineScrapeFunction,
    });
    const targetProfile = res?.[0]?.result || {};

    if (targetProfile._error) {
      throw new Error('Extraction error: ' + (targetProfile.message || 'Unknown') + '. Refresh the page and try again.');
    }
    if (!targetProfile.name && !targetProfile.headline && !(targetProfile.experience?.length > 0)) {
      throw new Error('Could not extract profile data. Make sure you are logged in and the page is fully loaded.');
    }

    // Warn if own profile
    if (targetProfile.url_slug && myP._url && targetProfile.url_slug === myP._url?.match(/\/in\/([^/?#]+)/)?.[1]) {
      document.getElementById('gapLoading').classList.add('gap-hidden');
      document.getElementById('gapIdle').classList.remove('gap-hidden');
      document.querySelector('#gapIdle .gap-idle-hint').textContent = 'This is your own profile. Navigate to someone else\'s profile to compare.';
      return;
    }

    // ── Validate + retry-merge (same robustness as own-profile extraction) ──
    const gapIssues = validateScrape(targetProfile).filter(i =>
      ['exp_truncated', 'exp_empty', 'skills_truncated', 'skills_empty', 'no_name'].includes(i)
    );
    if (gapIssues.length) {
      console.log('[LinkedIn AI] Gap target validation issues:', gapIssues, '— retrying...');
      try {
        await new Promise(r => setTimeout(r, 1200));
        const retryRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: inlineScrapeFunction,
        });
        const retryData = retryRes?.[0]?.result;
        if (retryData && !retryData._error) mergeScrapeResults(targetProfile, retryData);
      } catch (e) { console.warn('[LinkedIn AI] Gap target retry failed:', e); }
    }

    // ── Enrichment: detail pages for all key sections ──────────────────────
    document.querySelector('#gapLoading').innerHTML = '<span class="net-spinner"></span> Extracting...';
    const needsDetail = targetProfile._debug?._sectionsNeedingDetailPage || [];
    const toEnrich = [];
    // Detect corrupt inline experience (feed posts parsed as jobs — no company/dates, long title).
    const expLooksCorrupt = (targetProfile.experience || []).some(e =>
      (!e.company && !e.dates && (e.title || '').length > 60) ||
      /\b(reacted|reposted|commented|#\w+|others? reacted)\b/i.test(e.title + ' ' + e.description)
    );
    // Only visit the experience detail page if inline extraction looks corrupt or empty.
    // The inline scraper now handles 3rd-party profiles correctly so avoid unnecessary navigation.
    if (expLooksCorrupt || (targetProfile.experience || []).length === 0) toEnrich.push('experience');
    // Only visit the education detail page if inline extraction found nothing.
    if ((targetProfile.education || []).length === 0) toEnrich.push('education');
    // Skills: always visit — the profile home page only shows top 3, detail page has all of them.
    toEnrich.push('skills');
    if (toEnrich.length) {
      try {
        // skipReturnNav:false — navigate back to the profile so the user
        // lands where they started (and sees the correct profile page).
        await enrichWithDetailPages(tab.id, targetProfile, { sections: toEnrich, skipReturnNav: false });
      } catch (enrichErr) {
        console.warn('[LinkedIn AI] Gap target enrichment failed, using inline data:', enrichErr);
      }
    }

    // ── Post-enrichment sanity pass ──────────────────────────────────────
    // If experience still contains feed-post garbage after enrichment, wipe it.
    // This is a last-resort guard: better to show empty experience than nonsense.
    const _isExpEntryGarbage = (e) =>
      (!e.company && !e.dates && (e.title || '').length > 60) ||
      /reacted|reposted|commented|and \d+ others|lnkd\.in|https?:\/\//i.test(
        (e.title || '') + ' ' + (e.company || '') + ' ' + (e.description || '')
      );
    if ((targetProfile.experience || []).some(_isExpEntryGarbage)) {
      console.warn('[GapScrape] Experience still contains garbage after enrichment — clearing');
      targetProfile.experience = (targetProfile.experience || []).filter(e => !_isExpEntryGarbage(e));
    }
    // If education entries look like experience (have title/company but no school), wipe them
    const _isEduEntryGarbage = (e) => !e.school && (e.title || e.company);
    if ((targetProfile.education || []).some(_isEduEntryGarbage)) {
      console.warn('[GapScrape] Education still contains garbage after enrichment — clearing');
      targetProfile.education = (targetProfile.education || []).filter(e => !_isEduEntryGarbage(e));
    }
    // Skills: strip any remaining engagement-noise strings
    if (targetProfile.skills?.length) {
      targetProfile.skills = targetProfile.skills.filter(s =>
        typeof s === 'string' &&
        s.length >= 2 && s.length <= 80 &&
        !/reacted|reposted|commented|and \d+ others|lnkd\.in|\d+\/\d+/i.test(s)
      );
    }
    console.log('[GapScrape] Final:', {
      exp: targetProfile.experience?.length,
      edu: targetProfile.education?.length,
      skills: targetProfile.skills?.length,
      certs: targetProfile.certifications?.length,
    });

    _gapScrapedTarget = targetProfile;
    _displayScrapedTarget(targetProfile);

    document.getElementById('gapLoading').classList.add('gap-hidden');
    document.getElementById('gapScraped').classList.remove('gap-hidden');
  } catch (e) {
    document.getElementById('gapLoading').classList.add('gap-hidden');
    document.getElementById('gapIdle').classList.remove('gap-hidden');
    document.querySelector('#gapIdle .gap-idle-hint').textContent = 'Error: ' + (e.message || '').substring(0, 120);
  }
}

async function onGapTabOpen() {
  // Check gap consent
  const { gapConsentGiven, myProfile: myP } = await chrome.storage.local.get(['gapConsentGiven', 'myProfile']);
  if (!gapConsentGiven) {
    document.getElementById('gapIdle').classList.add('gap-hidden');
    document.getElementById('gapModeTabs').style.display = 'none';
    document.getElementById('gapConsent').style.display = '';
    return;
  }
  document.getElementById('gapConsent').style.display = 'none';
  document.getElementById('gapModeTabs').style.display = '';
  document.getElementById('gapIdle').classList.remove('gap-hidden');

  const hint = document.getElementById('gapIdleHint');
  const nameEl = document.getElementById('gapMyProfileName');

  // Show a rich context-guide card inside the hint element
  function _gapCard(icon, title, bodyHtml) {
    hint.className = 'gap-idle-hint gap-idle-hint--card';
    hint.innerHTML = `<div class="net-context-guide">
      <div class="net-context-icon">${icon}</div>
      <strong>${title}</strong>
      <p>${bodyHtml}</p>
    </div>`;
  }
  // Show simple positive hint (correct context)
  function _gapHint(html) {
    hint.className = 'gap-idle-hint';
    hint.innerHTML = html;
  }

  if (!myP || (!myP.name && !myP.headline)) {
    _gapCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>', 'Extract your profile first',
      'Gap Analysis needs your LinkedIn profile as a baseline. ' +
      '<a href="https://www.linkedin.com/in/me" target="_blank" style="color:var(--ac)">Open your LinkedIn profile</a> ' +
      'in this tab — the extension will extract it automatically. Then navigate to someone else\'s profile and click <strong>Extract Target Profile</strong>.');
    if (nameEl) nameEl.textContent = '';
    return;
  }

  // Show who is the baseline
  if (nameEl) nameEl.textContent = `Comparing as: ${myP.name || myP.headline}`;

  // ── Auto-restore last gap analysis if result area is empty ──
  // Runs regardless of URL context — the result persists until user clicks "Analyze Another"
  const gapResult = document.getElementById('gapResult');
  async function _maybeRestoreLastGap() {
    if (!gapResult.classList.contains('gap-hidden')) return; // already showing a result
    const { _lastGapAnalysis: last } = await chrome.storage.local.get('_lastGapAnalysis');
    if (!last?.data || !last.target) return;
    const age = Math.round((Date.now() - last.ts) / 60000); // minutes
    const ageLabel = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.round(age/60)}h ago` : `${Math.round(age/1440)}d ago`;
    const profileToUse = last.user || myP;
    document.getElementById('gapIdle').classList.add('gap-hidden');
    _gapResultMode = 'profile';
    gapResult.classList.remove('gap-hidden');
    _renderGapResult(last.data, last.target, profileToUse);
    const gapCacheTag = document.getElementById('gapCacheTag');
    if (gapCacheTag) { gapCacheTag.textContent = `Last analysis · ${ageLabel}`; gapCacheTag.style.display = ''; }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';

  if (!url.includes('linkedin.com')) {
    _gapCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>', 'LinkedIn is not open',
      '<a href="https://www.linkedin.com" target="_blank" style="color:var(--ac)">Open LinkedIn</a> ' +
      'in this tab, navigate to any person\'s profile (<strong>linkedin.com/in/…</strong>), ' +
      'then click <strong>Extract Target Profile</strong>.');
    await _maybeRestoreLastGap();
    return;
  }

  if (url.match(/linkedin\.com\/in\//)) {
    const tabSlug = url.match(/\/in\/([^/?#]+)/)?.[1];
    const mySlug  = (myP?._url || myP?.url_slug || '').match(/\/in\/([^/?#]+)/)?.[1] || myP?.url_slug;
    if (mySlug && tabSlug === mySlug) {
      _gapCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>', "That's your own profile",
        'Gap Analysis compares <strong>you</strong> against <strong>someone else</strong>. ' +
        'Navigate to another person\'s LinkedIn profile, then click <strong>Extract Target Profile</strong>.');
    } else {
      _gapHint('Profile page detected — click <strong>Extract Target Profile</strong> to load their data and start the comparison.');
    }
    await _maybeRestoreLastGap();
    return;
  }

  if (/linkedin\.com\/jobs\/view\//.test(url)) {
    _gapCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>', "You're on a job posting",
      'Switch to the <strong>vs Job</strong> tab above to analyze your fit against this listing. ' +
      'For <strong>vs Profile</strong> mode, navigate to any person\'s LinkedIn profile.');
    await _maybeRestoreLastGap();
    return;
  }

  if (/linkedin\.com\/jobs\//.test(url)) {
    _gapCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>', "You're browsing Jobs",
      'Open a specific job listing to use <strong>vs Job</strong> mode. ' +
      'For <strong>vs Profile</strong> mode, navigate to any person\'s LinkedIn profile (<strong>linkedin.com/in/…</strong>).');
    await _maybeRestoreLastGap();
    return;
  }

  // On LinkedIn but not a profile or jobs page
  _gapHint('Navigate to any LinkedIn profile (<strong>linkedin.com/in/…</strong>), then click <strong>Extract Target Profile</strong>.');
  await _maybeRestoreLastGap();
}

let _lastGapRender = null; // { d, targetProfile, myP } — used by export/PDF

// ──────────────────────────────────────────────────────────────────────────��─
//  GAP ANALYSIS REPORT HTML GENERATOR
//  Builds a clean, self-contained HTML report from the analysis data.
//  printMode=true adds an auto-print script and print-friendly CSS.
// ────────────────────────────────────────────────────────────────────────────
function _buildGapReportHTML(d, target, me, printMode) {
  const sec   = d.sections || {};
  const pm    = d.power_metrics || {};
  const h2h   = d.head_to_head || {};
  const fp    = d.profile_fingerprint || {};
  const pct   = d.overall_gap_score || 0;
  const color = pct >= 70 ? '#22c55e' : pct >= 45 ? '#f59e0b' : '#ef4444';
  const e = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const toArr = v => Array.isArray(v) ? v : (v && typeof v === 'string' ? v.split(/\n|,/).map(s=>s.trim()).filter(Boolean) : []);

  const sectionBar = (label, s, tooltip) => {
    const u = s?.user_score || 0, t = s?.target_score || 0;
    const uW = Math.round(u / 2), tW = Math.round(t / 2); // max 50% each side
    return `<div class="sec-row">
      <div class="sec-label" title="${e(tooltip)}">${e(label)}</div>
      <div class="sec-bars">
        <div class="bar-you" style="width:${uW}%"></div>
        <div class="bar-mid"><span class="bar-you-val">${u}</span><span class="bar-sep">/</span><span class="bar-them-val">${t}</span></div>
        <div class="bar-them" style="width:${tW}%"></div>
      </div>
    </div>`;
  };

  const powerRow = (label, metric) => {
    const u = metric?.user || 0, t = metric?.target || 0;
    return `<div class="pw-row">
      <div class="pw-label">${e(label)}</div>
      <div class="pw-track"><div class="pw-bar pw-you" style="width:${u}%"></div><div class="pw-bar pw-them" style="width:${t}%"></div></div>
      <div class="pw-vals"><span class="pv-u">${u}</span><span class="pv-s">/</span><span class="pv-t">${t}</span></div>
    </div>`;
  };

  const pillList = (arr, cls='') => toArr(arr).map(s => `<span class="pill ${cls}">${e(typeof s==='string'?s:String(s))}</span>`).join('');
  const listItems = (arr) => toArr(arr).map(s => `<li>${e(typeof s==='string'?s:String(s))}</li>`).join('');
  const winItems = (arr) => toArr(arr).map(s => `<div class="win-item">${e(typeof s==='string'?s:String(s))}</div>`).join('');

  const quickWins = toArr(d.quick_wins).map(w => {
    if (typeof w === 'string') return `<div class="qw-item"><span class="qw-arrow">→</span>${e(w)}</div>`;
    const badge = w.impact ? `<span class="qw-badge qw-${w.impact}">${e(w.impact)}</span>` : '';
    const diff  = w.difficulty ? `<span class="qw-badge qw-diff-${w.difficulty}">${e(w.difficulty)}</span>` : '';
    const time  = w.time   ? `<span class="qw-time">${e(w.time)}</span>` : '';
    return `<div class="qw-item"><span class="qw-arrow">→</span><span class="qw-action">${e(w.action||'')}</span>${time}${badge}${diff}</div>`;
  }).join('');

  const roadmap = toArr(d['30_day_roadmap']).map(item => {
    if (typeof item === 'string') return `<div class="rm-item"><span class="rm-week">–</span><div class="rm-body">${e(item)}</div></div>`;
    const result = item.expected_result ? `<div class="rm-result">${e(item.expected_result)}</div>` : '';
    return `<div class="rm-item"><span class="rm-week">Wk ${e(String(item.week||''))}</span><div class="rm-body"><strong>${e(item.action||'')}</strong>${result}</div></div>`;
  }).join('');

  const contentIdeas = toArr(d.content_ideas).map(idea => {
    if (typeof idea === 'string') return `<div class="ci-item">${e(idea)}</div>`;
    const fmt = idea.format ? `<span class="ci-fmt">${e(idea.format)}</span>` : '';
    const hook = idea.hook ? `<div class="ci-hook">"${e(idea.hook)}"</div>` : '';
    return `<div class="ci-item">${fmt}<strong>${e(idea.topic||'')}</strong>${hook}</div>`;
  }).join('');

  const printScript = printMode ? `<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),800));<\/script>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LinkedIn Gap Analysis �� ${e(me.name||'You')} vs ${e(target.name||'Target')}</title>
${printMode ? `<style>@media print{.no-print{display:none!important}body{padding:0!important}}</style>` : ''}
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.6;background:#f8fafc;color:#1e293b;padding:24px 16px;max-width:760px;margin:0 auto}
h1,h2,h3{font-weight:700}
.report-header{background:linear-gradient(135deg,#0a66c2,#3b5bdb);color:#fff;border-radius:14px;padding:24px;margin-bottom:20px;text-align:center}
.report-title{font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.8;margin-bottom:4px}
.report-matchup{font-size:18px;font-weight:800;margin-bottom:4px}
.report-date{font-size:10px;opacity:.6}
/* VS header */
.vs-header{display:flex;align-items:stretch;gap:8px;margin-bottom:16px}
.vs-profile{flex:1;background:#fff;border-radius:12px;border:1px solid #e2e8f0;padding:14px;display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center}
.vs-photo{width:52px;height:52px;border-radius:50%;object-fit:cover}
.vs-initial{width:52px;height:52px;border-radius:50%;background:#0a66c2;color:#fff;font-size:22px;font-weight:800;display:flex;align-items:center;justify-content:center}
.vs-initial-them{background:#7c3aed}
.vs-name{font-size:13px;font-weight:700}
.vs-role{font-size:10px;color:#64748b;max-width:140px}
.vs-arch{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:1px 7px;border-radius:8px;background:#eff6ff;color:#0a66c2;margin-top:2px}
.vs-arch-them{background:#f3e8ff;color:#7c3aed}
.vs-fp{font-size:9px;font-style:italic;color:#94a3b8;margin-top:1px}
.vs-center{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 4px;min-width:72px}
.vs-score{font-size:42px;font-weight:900;line-height:1;color:${color}}
.vs-label{font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-top:2px}
.vs-vs{font-size:11px;font-weight:700;color:#94a3b8;margin-top:4px}
/* Match signature */
.match-signature{text-align:center;font-size:15px;font-weight:700;color:#1e293b;padding:6px 16px 14px;line-height:1.4}
/* Verdict (backstory — italic, smaller) */
.verdict{background:#fff;border-left:4px solid ${color};border-radius:0 10px 10px 0;padding:10px 16px;margin-bottom:12px;font-size:12px;line-height:1.7;color:#475569;font-style:italic}
/* Key insight (headline — bold, prominent) */
.insight{background:#eff6ff;border-left:4px solid #0a66c2;border-radius:0 10px 10px 0;padding:12px 16px;margin-bottom:12px;font-size:14px;color:#0a66c2;font-weight:700;line-height:1.6}
/* Section card */
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:10px}
.card-title{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;margin-bottom:10px;display:flex;align-items:center;gap:6px}
/* Power index */
.pw-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.pw-label{font-size:10px;font-weight:600;color:#64748b;min-width:90px;text-transform:uppercase;letter-spacing:.3px}
.pw-track{flex:1;height:14px;background:#f1f5f9;border-radius:7px;position:relative;overflow:hidden}
.pw-bar{position:absolute;height:7px;border-radius:4px;transition:width .8s}
.pw-you{top:0;background:linear-gradient(90deg,#7c3aed,#3b5bdb)}
.pw-them{top:7px;background:linear-gradient(90deg,#e8590c,#f59e0b)}
.pw-vals{min-width:44px;text-align:right;white-space:nowrap}
.pv-u{font-size:11px;font-weight:700;color:#7c3aed}
.pv-t{font-size:11px;font-weight:700;color:#e8590c}
.pv-s{font-size:9px;color:#94a3b8;margin:0 1px}
.pw-legend{display:flex;gap:16px;margin-top:6px;justify-content:center}
.pw-lbadge{display:flex;align-items:center;gap:4px;font-size:10px;font-weight:700}
.pw-ldot-you{width:10px;height:4px;border-radius:2px;background:linear-gradient(90deg,#7c3aed,#3b5bdb)}
.pw-ldot-them{width:10px;height:4px;border-radius:2px;background:linear-gradient(90deg,#e8590c,#f59e0b)}
.pw-lbadge-you{color:#7c3aed}
.pw-lbadge-them{color:#e8590c}
/* H2H */
.h2h-cols{display:flex;gap:10px}
.h2h-col{flex:1;padding:10px 12px;border-radius:10px}
.h2h-you{background:#eff6ff}
.h2h-them{background:#f3e8ff}
.h2h-col-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.h2h-you .h2h-col-title{color:#0a66c2}
.h2h-them .h2h-col-title{color:#7c3aed}
.win-item{font-size:11px;color:#334155;padding:3px 0;border-bottom:1px solid rgba(0,0,0,.05);line-height:1.5}
.win-item:last-child{border:none}
/* Section comparison bars */
.sec-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f1f5f9}
.sec-row:last-child{border:none}
.sec-label{font-size:11px;font-weight:600;color:#475569;min-width:90px;cursor:default}
.sec-bars{flex:1;display:flex;align-items:center;gap:0}
.bar-you{height:8px;background:#0a66c2;border-radius:4px 0 0 4px;min-width:2px;transition:width .8s}
.bar-them{height:8px;background:#7c3aed;border-radius:0 4px 4px 0;min-width:2px;transition:width .8s}
.bar-mid{display:flex;align-items:center;gap:1px;padding:0 5px;white-space:nowrap}
.bar-you-val{font-size:10px;font-weight:700;color:#0a66c2}
.bar-them-val{font-size:10px;font-weight:700;color:#7c3aed}
.bar-sep{font-size:9px;color:#94a3b8}
/* Section details */
.sec-detail{font-size:12px;color:#475569;padding:6px 0 0;line-height:1.7}
.sec-detail strong{color:#0a66c2}
.rewrite-box{font-size:12px;color:#0a66c2;background:#eff6ff;padding:8px 12px;border-radius:8px;margin-top:6px;border-left:3px solid #0a66c2}
.rewrite-label{font-weight:700;margin-right:4px}
/* Skill pills */
.pills{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.pill{font-size:11px;padding:2px 10px;border-radius:10px;background:#dbeafe;color:#1d4ed8;font-weight:500}
.pill-green{background:#dcfce7;color:#16a34a}
/* Quick wins */
.qw-item{display:flex;align-items:flex-start;gap:6px;padding:5px 0;font-size:12px;border-bottom:1px solid #f1f5f9;line-height:1.6}
.qw-item:last-child{border:none}
.qw-arrow{color:#0a66c2;font-weight:700;flex-shrink:0;margin-top:1px}
.qw-action{flex:1}
.qw-time{font-size:10px;color:#94a3b8;margin-left:6px;flex-shrink:0}
.qw-badge{font-size:9px;font-weight:700;text-transform:uppercase;padding:1px 6px;border-radius:8px;margin-left:4px;flex-shrink:0}
.qw-high{background:#dcfce7;color:#16a34a}
.qw-medium{background:#fef9c3;color:#854d0e}
.qw-low{background:#f1f5f9;color:#64748b}
/* Recruiter */
.recruiter-box{background:#fff7ed;border-left:4px solid #f59e0b;border-radius:0 10px 10px 0;padding:12px 16px;font-size:12px;color:#78350f;line-height:1.7}
/* Strategy / Connection Playbook */
.strategy-text{font-size:12px;color:#475569;line-height:1.7;white-space:pre-wrap}
.conn-field{margin-bottom:8px}
.conn-label{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;margin-bottom:2px}
.conn-text{font-size:12px;color:#1e293b;line-height:1.6}
.conn-copybox{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 10px;display:block;font-style:italic}
/* Quick win difficulty badge */
.qw-diff-easy{background:transparent;border:1px solid #16a34a;color:#16a34a}
.qw-diff-medium{background:transparent;border:1px solid #d97706;color:#d97706}
.qw-diff-hard{background:transparent;border:1px solid #dc2626;color:#dc2626}
/* 30-day roadmap */
.rm-item{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:12px}
.rm-item:last-child{border:none}
.rm-week{font-size:10px;font-weight:700;color:#0a66c2;min-width:42px;padding-top:2px;flex-shrink:0}
.rm-body{flex:1;color:#334155;line-height:1.6}
.rm-result{font-size:10px;color:#64748b;margin-top:2px;font-style:italic}
/* Content ideas */
.ci-item{padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:12px;line-height:1.6}
.ci-item:last-child{border:none}
.ci-fmt{font-size:9px;font-weight:700;text-transform:uppercase;padding:1px 7px;border-radius:8px;background:#f3e8ff;color:#7c3aed;margin-right:6px}
.ci-hook{font-size:11px;color:#0a66c2;margin-top:3px;font-style:italic}
/* Skills heatmap */
.sk-chip{display:inline-flex;align-items:center;font-size:11px;padding:3px 10px;border-radius:10px;margin:3px;font-weight:500}
.sk-chip-have{background:#dcfce7;color:#16a34a}
.sk-chip-missing{background:#fee2e2;color:#dc2626}
.sk-chip-advantage{background:#dbeafe;color:#1d4ed8}
/* Footer */
.footer{text-align:center;padding:16px 0 4px;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;margin-top:18px}
@media print{body{background:#fff;padding:12px}@page{margin:1cm}}
</style>
${printScript}
</head>
<body>
<div class="report-header">
  <div class="report-title">LinkedIn Gap Analysis Report</div>
  <div class="report-matchup">${fp.matchup_title ? e(fp.matchup_title) : `${e(me.name||'You')} vs ${e(target.name||'Target')}`}</div>
  <div class="report-date">${new Date().toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})}</div>
</div>

<!-- VS Header -->
<div class="vs-header">
  <div class="vs-profile">
    ${me.profilePhotoUrl||me.photo ? `<img class="vs-photo" src="${e(me.profilePhotoUrl||me.photo)}" alt="" onerror="this.style.display='none'">` : `<div class="vs-initial">${e((me.name||'Y').charAt(0))}</div>`}
    <div class="vs-name">${e(me.name||'You')}</div>
    <div class="vs-role">${e(me.headline||me.currentRole||'')}</div>
    ${d.profile_archetypes?.user ? `<div class="vs-arch">${e(d.profile_archetypes.user)}</div>` : ''}
    ${fp.user_code ? `<div class="vs-fp">${e(fp.user_code)}</div>` : ''}
  </div>
  <div class="vs-center">
    <div class="vs-score">${pct}</div>
    <div class="vs-label">${e(d.score_label||'')}</div>
    <div class="vs-vs">vs</div>
  </div>
  <div class="vs-profile">
    ${target.profilePhotoUrl||target.photo ? `<img class="vs-photo" src="${e(target.profilePhotoUrl||target.photo)}" alt="" onerror="this.style.display='none'">` : `<div class="vs-initial vs-initial-them">${e((target.name||'T').charAt(0))}</div>`}
    <div class="vs-name">${e(target.name||'Target')}</div>
    <div class="vs-role">${e(target.headline||target.title||target.currentRole||'')}</div>
    ${d.profile_archetypes?.target ? `<div class="vs-arch vs-arch-them">${e(d.profile_archetypes.target)}</div>` : ''}
    ${fp.target_code ? `<div class="vs-fp">${e(fp.target_code)}</div>` : ''}
  </div>
</div>

${d.match_signature ? `<div class="match-signature">${e(d.match_signature)}</div>` : ''}
${d.verdict ? `<div class="verdict">${e(d.verdict)}</div>` : ''}
${d.key_insight ? `<div class="insight">${e(d.key_insight)}</div>` : ''}

<!-- Power Index -->
${pm.profile_completeness ? `
<div class="card">
  <div class="card-title">Power Index</div>
  ${powerRow('Completeness', pm.profile_completeness)}
  ${powerRow('Keywords', pm.keyword_strength)}
  ${powerRow('Narrative', pm.narrative_quality)}
  ${powerRow('Trajectory', pm.career_trajectory)}
  ${powerRow('Network', pm.network_signal)}
  <div class="pw-legend">
    <div class="pw-lbadge pw-lbadge-you"><div class="pw-ldot-you"></div> You</div>
    <div class="pw-lbadge pw-lbadge-them"><div class="pw-ldot-them"></div> Them</div>
  </div>
</div>` : ''}

<!-- Head to Head -->
${h2h.user_wins?.length || h2h.target_wins?.length ? `
<div class="card">
  <div class="card-title">Head to Head</div>
  <div class="h2h-cols">
    <div class="h2h-col h2h-you"><div class="h2h-col-title">Your Wins</div>${winItems(h2h.user_wins)}</div>
    <div class="h2h-col h2h-them"><div class="h2h-col-title">Their Wins</div>${winItems(h2h.target_wins)}</div>
  </div>
</div>` : ''}

<!-- Section Comparisons -->
<div class="card">
  <div class="card-title">Section Breakdown <small style="font-size:9px;color:#94a3b8;text-transform:none;font-weight:500">${window._t('gapSectionBreakdownNote')}</small></div>
  ${sectionBar(window._t('gapCompHeadline'), sec.headline, window._t('gapSubHeadline'))}
  ${sec.headline?.gap ? `<div class="sec-detail">${e(sec.headline.gap)}${sec.headline.rewrite ? `<div class="rewrite-box"><span class="rewrite-label">Suggested:</span>${e(sec.headline.rewrite)}</div>` : ''}</div>` : ''}
  ${sectionBar(window._t('gapCompAbout'), sec.about, window._t('gapSubAbout'))}
  ${sec.about?.gap ? `<div class="sec-detail">${e(sec.about.gap)}${sec.about.rewrite_hint ? `<div class="rewrite-box"><span class="rewrite-label">Opening rewrite:</span>${e(sec.about.rewrite_hint)}</div>` : ''}</div>` : ''}
  ${sectionBar(window._t('gapCompExperience'), sec.experience, window._t('gapSubExperience'))}
  ${sec.experience?.gap ? `<div class="sec-detail">${e(sec.experience.gap)}</div>` : ''}
  ${sectionBar(window._t('gapCompEducation'), sec.education, window._t('gapSubEducation'))}
  ${sec.education?.gap ? `<div class="sec-detail">${e(sec.education.gap)}</div>` : ''}
  ${sectionBar(window._t('gapCompSkills'), sec.skills, window._t('gapSubSkills'))}
  ${sec.skills?.gap ? `<div class="sec-detail">${e(sec.skills.gap)}` +
    (toArr(sec.skills?.missing).length ? `<div class="pills">${pillList(sec.skills.missing)}</div>` : '') +
    (toArr(sec.skills?.advantage).length ? `<div class="pills">${pillList(sec.skills.advantage,'pill-green')}</div>` : '') +
  `</div>` : ''}
  ${sectionBar(window._t('gapCompContent'), sec.content, window._t('gapSubContent'))}
  ${sec.content?.advice ? `<div class="sec-detail">${e(sec.content.advice)}</div>` : ''}
</div>

<!-- Quick Wins -->
${quickWins ? `<div class="card"><div class="card-title">Quick Wins</div>${quickWins}</div>` : ''}

<!-- Recruiter's Take -->
${d.recruiter_perspective ? `<div class="recruiter-box" style="margin-bottom:10px"><div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#b45309;margin-bottom:6px">Recruiter's Take</div>${e(d.recruiter_perspective)}</div>` : ''}

<!-- Connection Playbook -->
${(() => {
  const cs = d.connection_strategy;
  if (!cs) return '';
  if (typeof cs === 'object' && (cs.context || cs.first_message || cs.followup)) {
    return `<div class="card"><div class="card-title">Connection Playbook</div>
      ${cs.context ? `<div class="conn-field"><div class="conn-label">Context</div><div class="conn-text">${e(cs.context)}</div></div>` : ''}
      ${cs.first_message ? `<div class="conn-field"><div class="conn-label">First message</div><div class="conn-text conn-copybox">${e(cs.first_message)}</div></div>` : ''}
      ${cs.followup ? `<div class="conn-field"><div class="conn-label">Follow-up</div><div class="conn-text conn-copybox">${e(cs.followup)}</div></div>` : ''}
    </div>`;
  }
  return `<div class="card"><div class="card-title">Connection Strategy</div><div class="strategy-text">${e(String(cs))}</div></div>`;
})()}

<!-- 30-Day Roadmap -->
${roadmap ? `<div class="card"><div class="card-title">30-Day Roadmap</div>${roadmap}</div>` : ''}

<div class="footer">Generated by LinkedIn AI Agent &mdash; ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
</body>
</html>`;
}

function _renderGapResult(d, targetProfile, myP) {
  _lastGapRender = { d, targetProfile, myP };
  // Support both new (sections object) and old (flat) response formats
  const sec = d.sections || {};
  const hasNewFormat = !!(sec.headline || sec.about || sec.experience || sec.skills || sec.content);
  if (!hasNewFormat) {
    sec.headline   = { user_score: 0, target_score: 0, gap: d.headline_gap || '', rewrite: d.headline_rewrite || '' };
    sec.about      = { user_score: 0, target_score: 0, gap: d.about_gap || '', rewrite_hint: d.about_rewrite_hint || '' };
    sec.experience = { user_score: 0, target_score: 0, gap: d.experience_gap || '' };
    sec.skills     = { user_score: 0, target_score: 0, missing: d.skills_missing || [], advantage: d.skills_advantage || [] };
    sec.content    = { user_score: 0, target_score: 0, advice: d.posting_advice || '' };
    sec.education  = { user_score: 0, target_score: 0, gap: '' };
  }
  if (!sec.education) sec.education = { user_score: 0, target_score: 0, gap: '' };

  // -- VS Header with photos --
  const pct = d.overall_gap_score || 0;
  const scoreClass = pct >= 70 ? 'gap-high' : pct >= 45 ? 'gap-mid' : 'gap-low'; // hoisted so ringFill can use it
  const overallEl = document.getElementById('gapOverallScore');
  if (overallEl) {
    overallEl.textContent = pct;
    overallEl.className = `gap-dash-overall ${scoreClass}`;
  }
  const overallLabelEl = document.getElementById('gapOverallLabel');
  if (overallLabelEl) overallLabelEl.textContent = d.score_label || '';

  // Animated ring
  const ringFill = document.getElementById('gapRingFill');
  if (ringFill) {
    const circumference = 2 * Math.PI * 34; // r=34
    ringFill.style.strokeDasharray = circumference;
    ringFill.style.strokeDashoffset = circumference;
    ringFill.className = `gap-ring-fill ${scoreClass}`;
    requestAnimationFrame(() => {
      ringFill.style.strokeDashoffset = circumference - (circumference * pct / 100);
    });
  }

  // Profile photos
  function setPhoto(containerId, photoUrl, name) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (photoUrl && /^(https?:\/\/|data:image\/)/.test(photoUrl.trim()) && !photoUrl.includes('ghost-person')) {
      container.innerHTML = `<img src="${esc(photoUrl)}" alt="${esc(name || '')}" onerror="this.style.display='none'" />`;
    } else {
      container.innerHTML = `<span class="gap-dash-initial">${esc((name || '?').charAt(0).toUpperCase())}</span>`;
    }
  }
  setPhoto('gapYouPhoto', myP.profilePhotoUrl || myP.photo || '', myP.name);
  setPhoto('gapThemPhoto', targetProfile.profilePhotoUrl || targetProfile.photo || '', targetProfile.name);

  const _s = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  _s('gapYouName',  myP.name || 'You');
  _s('gapYouRole',  myP.headline || myP.currentRole || '');
  _s('gapThemName', targetProfile.name || 'Target');
  _s('gapThemRole', targetProfile.title || targetProfile.headline || targetProfile.currentRole || '');

  // Archetypes
  const archetypes = d.profile_archetypes || {};
  const youArch = document.getElementById('gapYouArchetype');
  const themArch = document.getElementById('gapThemArchetype');
  if (youArch) { youArch.textContent = archetypes.user || ''; youArch.title = archetypes.user_archetype_detail || ''; youArch.style.display = archetypes.user ? '' : 'none'; }
  if (themArch) { themArch.textContent = archetypes.target || ''; themArch.title = archetypes.target_archetype_detail || ''; themArch.style.display = archetypes.target ? '' : 'none'; }

  // ── Opening block: matchup title + match signature ──
  const fp = d.profile_fingerprint || {};
  const openingBlock = document.getElementById('gapOpeningBlock');
  const matchupTitleEl = document.getElementById('gapMatchupTitle');
  const matchSigEl = document.getElementById('gapMatchSignature');
  const hasOpening = !!(fp.matchup_title || d.match_signature);
  if (openingBlock) openingBlock.style.display = hasOpening ? '' : 'none';
  if (matchupTitleEl) matchupTitleEl.textContent = fp.matchup_title || '';
  if (matchSigEl) matchSigEl.textContent = d.match_signature || '';

  const youFpEl = document.getElementById('gapYouFingerprint');
  const themFpEl = document.getElementById('gapThemFingerprint');
  if (youFpEl && fp.user_code) {
    youFpEl.textContent = fp.user_code;
    youFpEl.title = fp.user_fingerprint_why || '';
    youFpEl.style.display = '';
  } else if (youFpEl) { youFpEl.style.display = 'none'; }
  if (themFpEl && fp.target_code) {
    themFpEl.textContent = fp.target_code;
    themFpEl.title = fp.target_fingerprint_why || '';
    themFpEl.style.display = '';
  } else if (themFpEl) { themFpEl.style.display = 'none'; }

  // ── Verdict banner (backstory — italic, smaller) ──
  const verdictEl = document.getElementById('gapVerdict');
  if (verdictEl) { verdictEl.textContent = d.verdict || ''; verdictEl.style.display = d.verdict ? '' : 'none'; }

  // ── Key insight (headline — rendered BEFORE Power Index via DOM order) ──
  const insightEl = document.getElementById('gapInsight');
  if (insightEl) { insightEl.textContent = d.key_insight || ''; insightEl.style.display = d.key_insight ? '' : 'none'; }

  // ── Power metrics ──
  const pm = d.power_metrics;
  const pmEl = document.getElementById('gapPowerMetrics');
  if (pmEl && pm) {
    const setBar = (barId, valId, val) => {
      const bar = document.getElementById(barId);
      const lbl = document.getElementById(valId);
      const v = val || 0;
      if (bar) bar.style.width = v + '%';
      if (lbl) lbl.textContent = v;
    };
    const setDelta = (deltaId, youVal, themVal) => {
      const el = document.getElementById(deltaId);
      if (!el) return;
      const u = youVal || 0, t = themVal || 0;
      const diff = u - t;
      if (Math.abs(diff) < 3) { el.textContent = '='; el.className = 'gap-pwr-delta delta-even'; }
      else if (diff > 0) { el.textContent = '+' + diff; el.className = 'gap-pwr-delta delta-ahead'; }
      else { el.textContent = diff; el.className = 'gap-pwr-delta delta-behind'; }
    };
    setBar('gapPwrCompYou',  'gapPwrCompYouVal',  pm.profile_completeness?.user);
    setBar('gapPwrCompThem', 'gapPwrCompThemVal', pm.profile_completeness?.target);
    setDelta('gapPwrCompDelta', pm.profile_completeness?.user, pm.profile_completeness?.target);
    setBar('gapPwrKeyYou',   'gapPwrKeyYouVal',   pm.keyword_strength?.user);
    setBar('gapPwrKeyThem',  'gapPwrKeyThemVal',  pm.keyword_strength?.target);
    setDelta('gapPwrKeyDelta', pm.keyword_strength?.user, pm.keyword_strength?.target);
    setBar('gapPwrNarYou',   'gapPwrNarYouVal',   pm.narrative_quality?.user);
    setBar('gapPwrNarThem',  'gapPwrNarThemVal',  pm.narrative_quality?.target);
    setDelta('gapPwrNarDelta', pm.narrative_quality?.user, pm.narrative_quality?.target);
    setBar('gapPwrTrajYou',  'gapPwrTrajYouVal',  pm.career_trajectory?.user);
    setBar('gapPwrTrajThem', 'gapPwrTrajThemVal', pm.career_trajectory?.target);
    setDelta('gapPwrTrajDelta', pm.career_trajectory?.user, pm.career_trajectory?.target);
    setBar('gapPwrNetYou',   'gapPwrNetYouVal',   pm.network_signal?.user);
    setBar('gapPwrNetThem',  'gapPwrNetThemVal',  pm.network_signal?.target);
    setDelta('gapPwrNetDelta', pm.network_signal?.user, pm.network_signal?.target);
    pmEl.style.display = '';
  } else if (pmEl) { pmEl.style.display = 'none'; }

  // ── Head to Head ──
  const h2h = d.head_to_head;
  const h2hEl = document.getElementById('gapH2H');
  if (h2hEl && h2h) {
    const renderItems = (arr) => (arr || []).map(t => `<div class="gap-h2h-item">${esc(t)}</div>`).join('');
    const userWinsEl = document.getElementById('gapH2HUserWins');
    const targetWinsEl = document.getElementById('gapH2HTargetWins');
    if (userWinsEl) userWinsEl.innerHTML = renderItems(h2h.user_wins);
    if (targetWinsEl) targetWinsEl.innerHTML = renderItems(h2h.target_wins);
    const tiesEl = document.getElementById('gapH2HTies');
    if (tiesEl && h2h.tiebreakers?.length) {
      tiesEl.innerHTML = '<strong>Close calls:</strong> ' + h2h.tiebreakers.map(t => esc(t)).join(' | ');
      tiesEl.style.display = '';
    } else if (tiesEl) { tiesEl.style.display = 'none'; }
    h2hEl.style.display = (h2h.user_wins?.length || h2h.target_wins?.length) ? '' : 'none';
  } else if (h2hEl) { h2hEl.style.display = 'none'; }

  // ── Section comparison bars ──
  function fillBar(prefix, sectionData) {
    const uScore = sectionData?.user_score || 0;
    const tScore = sectionData?.target_score || 0;
    const el = (id) => document.getElementById(id);
    if (el(`gapBarYou${prefix}`)) el(`gapBarYou${prefix}`).textContent = uScore;
    if (el(`gapBarThem${prefix}`)) el(`gapBarThem${prefix}`).textContent = tScore;
    if (el(`gapBarYou${prefix}Fill`)) el(`gapBarYou${prefix}Fill`).style.width = uScore + '%';
    if (el(`gapBarThem${prefix}Fill`)) el(`gapBarThem${prefix}Fill`).style.width = tScore + '%';
  }
  fillBar('HL', sec.headline);
  fillBar('AB', sec.about);
  fillBar('EX', sec.experience);
  fillBar('ED', sec.education);
  fillBar('SK', sec.skills);
  fillBar('CT', sec.content);

  // Section details
  document.getElementById('gapHLGap').textContent = sec.headline?.gap || '';
  const hlInsight = document.getElementById('gapHLInsight');
  if (hlInsight) hlInsight.textContent = sec.headline?.insight || '';
  const hlRewrite = document.getElementById('gapHLRewrite');
  if (sec.headline?.rewrite) {
    hlRewrite.innerHTML = `<span class="gap-rewrite-hint">Suggested headline:</span> ${esc(sec.headline.rewrite)}`;
  } else { hlRewrite.innerHTML = ''; }

  document.getElementById('gapABGap').textContent = sec.about?.gap || '';
  const abInsight = document.getElementById('gapABInsight');
  if (abInsight) abInsight.textContent = sec.about?.insight || '';
  const abRewrite = document.getElementById('gapABRewrite');
  if (sec.about?.rewrite_hint) {
    abRewrite.innerHTML = `<span class="gap-rewrite-hint">Suggested rewrite:</span> ${esc(sec.about.rewrite_hint)}`;
  } else { abRewrite.innerHTML = ''; }

  document.getElementById('gapEXGap').textContent = sec.experience?.gap || '';
  const exInsight = document.getElementById('gapEXInsight');
  if (exInsight) exInsight.textContent = sec.experience?.insight || '';

  const gapEDGap = document.getElementById('gapEDGap');
  if (gapEDGap) gapEDGap.textContent = sec.education?.gap || '';
  const edInsight = document.getElementById('gapEDInsight');
  if (edInsight) edInsight.textContent = sec.education?.insight || '';

  // Skills
  const skGap = document.getElementById('gapSKGap');
  if (skGap) skGap.textContent = sec.skills?.gap || '';
  const skInsight = document.getElementById('gapSKInsight');
  if (skInsight) skInsight.textContent = sec.skills?.insight || '';
  const missingEl = document.getElementById('gapSkillsMissing');
  missingEl.innerHTML = (Array.isArray(sec.skills?.missing) ? sec.skills.missing : []).map(s => `<span class="gap-pill">${esc(typeof s === 'string' ? s : String(s))}</span>`).join('');
  const advEl = document.getElementById('gapSkillsAdv');
  advEl.innerHTML = (Array.isArray(sec.skills?.advantage) ? sec.skills.advantage : []).map(s => `<span class="gap-pill">${esc(s)}</span>`).join('');
  const skPos = document.getElementById('gapSKPositioning');
  if (skPos) skPos.textContent = sec.skills?.skill_positioning || '';

  // ── Skill Gap Heatmap ──
  const heatmapSec = document.getElementById('gapSkillHeatmap');
  const heatmapGrid = document.getElementById('gapSkillHeatmapGrid');
  const missing = (Array.isArray(sec.skills?.missing) ? sec.skills.missing : []).map(s => typeof s === 'string' ? s : String(s));
  const advantage = (Array.isArray(sec.skills?.advantage) ? sec.skills.advantage : []).map(s => typeof s === 'string' ? s : String(s));
  const userSkills = (Array.isArray(myP.skills) ? myP.skills : []).map(s => typeof s === 'string' ? s : (s.name || String(s)));
  if (heatmapSec && heatmapGrid && (missing.length > 0 || advantage.length > 0)) {
    heatmapSec.style.display = '';
    // Build a combined deduplicated skill set with status
    const allSkills = new Map();
    userSkills.slice(0, 20).forEach(s => allSkills.set(s.toLowerCase(), { label: s, status: 'have' }));
    missing.slice(0, 15).forEach(s => { if (!allSkills.has(s.toLowerCase())) allSkills.set(s.toLowerCase(), { label: s, status: 'missing' }); });
    advantage.slice(0, 10).forEach(s => allSkills.set(s.toLowerCase(), { label: s, status: 'advantage' }));
    const chips = [...allSkills.values()].map(({ label, status }) =>
      `<span class="sk-chip sk-chip-${status}" title="${status === 'have' ? 'You have this' : status === 'missing' ? 'Gap: missing skill' : 'Your advantage'}">${esc(label)}</span>`
    ).join('');
    const legend = `<div class="sk-legend">
      <span class="sk-chip sk-chip-have">You have</span>
      <span class="sk-chip sk-chip-missing">Missing</span>
      <span class="sk-chip sk-chip-advantage">Advantage</span>
    </div>`;
    heatmapGrid.innerHTML = legend + `<div class="sk-grid">${chips}</div>`;
  } else if (heatmapSec) {
    heatmapSec.style.display = 'none';
  }

  // (Content card and Quick Wins removed from UI)

  // -- Recruiter perspective --
  const recruiterEl = document.getElementById('gapRecruiter');
  const recruiterText = document.getElementById('gapRecruiterText');
  if (recruiterEl && d.recruiter_perspective) {
    if (recruiterText) recruiterText.textContent = d.recruiter_perspective;
    recruiterEl.style.display = '';
  } else if (recruiterEl) { recruiterEl.style.display = 'none'; }

  // ── Connection Strategy (structured 3-field block) ──
  const strategySection = document.getElementById('gapStrategySection');
  const cs = d.connection_strategy;
  if (strategySection) {
    if (cs && typeof cs === 'object' && (cs.context || cs.first_message || cs.followup)) {
      _s('gapStrategyContext', cs.context || '');
      _s('gapStrategyMsg', cs.first_message || '');
      _s('gapStrategyFollowup', cs.followup || '');
      strategySection.style.display = '';
    } else if (cs && typeof cs === 'string' && cs.trim()) {
      // Fallback: old prose format — just show in context field
      _s('gapStrategyContext', cs);
      _s('gapStrategyMsg', '');
      _s('gapStrategyFollowup', '');
      strategySection.style.display = '';
    } else {
      strategySection.style.display = 'none';
    }
  }
  // Wire copy buttons for connection playbook
  strategySection?.querySelectorAll('.gap-copy-btn').forEach(btn => {
    const freshBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(freshBtn, btn);
    freshBtn.addEventListener('click', () => {
      const targetId = freshBtn.dataset.target;
      const textEl = document.getElementById(targetId);
      const text = textEl?.textContent?.trim() || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        freshBtn.textContent = 'Copied!';
        freshBtn.classList.add('copied');
        setTimeout(() => { freshBtn.textContent = 'Copy'; freshBtn.classList.remove('copied'); }, 1800);
      }).catch(() => {});
    });
  });

  // ── Content Ideas (rich format) ──
  const contentEl = document.getElementById('gapContentIdeas');
  const ideas = Array.isArray(d.content_ideas) ? d.content_ideas : [];
  if (contentEl && ideas.length > 0) {
    contentEl.innerHTML = `<div class="gap-section-title">Content Ideas</div>` +
      ideas.map(idea => {
        if (typeof idea === 'string') return `<div class="gap-content-idea">${esc(idea)}</div>`;
        const fmt = idea.format ? `<span class="gap-content-idea-format">${esc(idea.format)}</span>` : '';
        const hook = idea.hook ? `<span class="gap-content-idea-hook">"${esc(idea.hook)}"</span>` : '';
        return `<div class="gap-content-idea">${fmt}${esc(idea.topic || '')}${hook}</div>`;
      }).join('');
    contentEl.style.display = '';
  } else if (contentEl) { contentEl.style.display = 'none'; }

  // ── 30-Day Roadmap (with expected results) ──
  const roadmapEl = document.getElementById('gapRoadmap');
  const roadmap = Array.isArray(d['30_day_roadmap']) ? d['30_day_roadmap'] : [];
  if (roadmapEl && roadmap.length > 0) {
    roadmapEl.innerHTML = `<div class="gap-section-title">30-Day Roadmap</div>` +
      roadmap.map(item => {
        const result = item.expected_result ? `<div class="gap-roadmap-result">${esc(item.expected_result)}</div>` : '';
        return `<div class="gap-roadmap-item">
          <span class="gap-roadmap-week">Week ${esc(String(item.week || ''))}</span>
          <div class="gap-roadmap-action">${esc(item.action || '')}${result}</div>
        </div>`;
      }).join('');
    roadmapEl.style.display = '';
  } else if (roadmapEl) { roadmapEl.style.display = 'none'; }

  // ── Expand/collapse rows ──
  document.querySelectorAll('.gap-compare-row').forEach(row => {
    row.onclick = () => row.classList.toggle('expanded');
  });
  const firstRow = document.querySelector('.gap-compare-row');
  if (firstRow) firstRow.classList.add('expanded');

  // ── Summary toggle ──
  const _GAP_DETAIL_SELECTORS = [
    '#gapPowerMetrics', '#gapH2H',
    '.gap-section:not(.gap-section-wins)', '#gapRecruiter',
    '#gapRoadmap', '#gapStrategySection',
  ];


}

function _setGapMode(mode) {
  // Swap active tab button
  ['Profile', 'JD', 'Job'].forEach(m => {
    const btn = document.getElementById(`gapMode${m}`);
    if (btn) btn.classList.toggle('active', mode === m.toLowerCase());
    const panel = document.getElementById(`gapMode${m}Panel`);
    if (panel) panel.style.display = mode === m.toLowerCase() ? '' : 'none';
  });

  const gapIdle      = document.getElementById('gapIdle');
  const gapResult    = document.getElementById('gapResult');
  const gapJobResult = document.getElementById('gapJobResult');
  const gapJobPreview= document.getElementById('gapJobPreview');
  const gapScraped   = document.getElementById('gapScraped');

  if (mode === 'job') {
    // Hide profile/JD output
    gapResult?.classList.add('gap-hidden');
    gapScraped?.classList.add('gap-hidden');

    if (_gapResultMode === 'job') {
      // Already have a job result — show it, hide idle
      gapJobResult?.classList.remove('gap-hidden');
      gapIdle?.classList.add('gap-hidden');
    } else {
      gapJobResult?.classList.add('gap-hidden');
      if (_jobScraped && gapJobPreview) {
        // Job scraped but not yet analyzed — show preview + analyze button
        gapJobPreview.style.display = '';
        document.getElementById('gapJobScrapeBtn').style.display = 'none';
        document.getElementById('gapJobAnalyzeBtn').style.display = '';
      } else {
        if (gapJobPreview) gapJobPreview.style.display = 'none';
        document.getElementById('gapJobScrapeBtn').style.display = '';
        document.getElementById('gapJobAnalyzeBtn').style.display = 'none';
      }
      gapIdle?.classList.remove('gap-hidden');
    }

  } else if (mode === 'profile') {
    // Hide job output
    gapJobResult?.classList.add('gap-hidden');
    if (gapJobPreview) gapJobPreview.style.display = 'none';

    if (_gapResultMode === 'profile') {
      // Show existing profile result
      gapResult?.classList.remove('gap-hidden');
      gapScraped?.classList.add('gap-hidden');
      gapIdle?.classList.add('gap-hidden');
    } else {
      gapResult?.classList.add('gap-hidden');
      if (_gapScrapedTarget) {
        // Target scraped but not yet analyzed
        gapScraped?.classList.remove('gap-hidden');
        gapIdle?.classList.add('gap-hidden');
      } else {
        gapScraped?.classList.add('gap-hidden');
        gapIdle?.classList.remove('gap-hidden');
      }
    }

  } else { // jd
    // Hide job output and profile-specific widgets
    gapJobResult?.classList.add('gap-hidden');
    if (gapJobPreview) gapJobPreview.style.display = 'none';
    gapScraped?.classList.add('gap-hidden');

    if (_gapResultMode === 'jd') {
      // Show existing JD result
      gapResult?.classList.remove('gap-hidden');
      gapIdle?.classList.add('gap-hidden');
    } else {
      gapResult?.classList.add('gap-hidden');
      gapIdle?.classList.remove('gap-hidden');
    }
  }
}

async function runGapAnalysisJD() {
  const jdText = (document.getElementById('gapJDInput').value || '').trim();
  if (!jdText) { toast('Please paste a job description first.', 'warn'); return; }

  const stored = await chrome.storage.local.get(['networkingGoal', 'myProfile']);
  const { authToken } = await chrome.storage.sync.get(['authToken']);
  if (!authToken) { toast('Please log in first.', 'warn'); return; }

  const myP = stored.myProfile;
  if (!myP || (!myP.name && !myP.headline)) {
    toast('Your profile is not saved yet.', 'warn'); return;
  }

  const roleInput = (document.getElementById('gapJDRole').value || '').trim();
  // Build synthetic target profile from JD text
  const targetProfile = {
    name: roleInput || 'Target Role',
    headline: roleInput || 'Job Description',
    about: jdText,
    skills: [],
    experience: [],
    education: [],
    _isJD: true,
  };

  document.getElementById('gapIdle').classList.add('gap-hidden');
  document.getElementById('gapResult').classList.add('gap-hidden');
  document.getElementById('gapLoading').classList.remove('gap-hidden');
  document.querySelector('#gapLoading').innerHTML = '<span class="net-spinner"></span> Analyzing against job description...';

  try {
    const netGoal = stored.networkingGoal || {};
    const inferredRole = myP.currentRole || myP.headline || netGoal.job_title || '';
    const user_profile = {
      goal: netGoal.goal || 'job_search',
      name: myP.name || '',
      headline: myP.headline || inferredRole,
      about: myP.about || '',
      job_title: netGoal.job_title || myP.currentRole || '',
      industry: netGoal.industry || _inferIndustry(inferredRole, myP.company || ''),
      seniority: netGoal.seniority || _inferSeniority(inferredRole),
      skills: myP.skills || [],
      experience: myP.experience || [],
      education: myP.education || [],
      certifications: myP.certifications || [],
    };

    const r = await chrome.runtime.sendMessage({
      action: 'profileGapAnalysis',
      data: { user_profile, target_profile: targetProfile, goal: user_profile.goal, ui_lang: window._uiLang || 'en' },
    });

    document.getElementById('gapLoading').classList.add('gap-hidden');
    if (!r.success) { toast('Analysis failed: ' + r.error, 'error'); document.getElementById('gapIdle').classList.remove('gap-hidden'); return; }

    const d = typeof r.data === 'string' ? JSON.parse(r.data.replace(/```json\s*/g, '').replace(/```/g, '').trim()) : r.data;
    _gapResultMode = 'jd';
    document.getElementById('gapResult').classList.remove('gap-hidden');
    _renderGapResult(d, targetProfile, myP);
  } catch (e) {
    document.getElementById('gapLoading').classList.add('gap-hidden');
    document.getElementById('gapIdle').classList.remove('gap-hidden');
    toast('Error: ' + e.message, 'error');
  }
}

function _isLinkedInJobUrl(url) {
  if (!url) return false;
  return /linkedin\.com\/jobs\/view\/\d+/.test(url) ||
         /linkedin\.com\/jobs\/(search|collections|recommended|my-jobs)[/?].*currentJobId=\d+/.test(url) ||
         /linkedin\.com\/jobs\/(search|collections|recommended|my-jobs)\/?.*[?&]currentJobId=\d+/.test(url);
}

function _extractJobId(url) {
  if (!url) return '';
  const viewMatch = url.match(/\/jobs\/view\/(\d+)/);
  if (viewMatch) return viewMatch[1];
  const paramMatch = url.match(/[?&]currentJobId=(\d+)/);
  if (paramMatch) return paramMatch[1];
  return '';
}

// Injected into the LinkedIn job page to extract job details.
// Works for /jobs/view/ID (full-page) and /jobs/search/?currentJobId=ID (split-pane).
//
// DIAGNOSTIC DATA (from live LinkedIn page, 2026-04):
//   - JSON-LD: 0 scripts — LinkedIn SDUI pages do NOT include application/ld+json
//   - [data-testid="expandable-text-box"]: 2 matches — first may be "How you fit" carousel,
//     NOT the description. Must use querySelectorAll + pick largest.
//   - [data-sdui-component*="aboutTheJob"]: 1 match, textLen ~4400 — the definitive container
//   - h1: not found on SDUI pages — use document.title instead
//   - No #job-details, no scaffold-layout__detail on SDUI layout
//
// Reading strategy: textContent (not innerText) — works even when element is off-screen.
// innerText requires element to be visible; textContent always works.
async function inlineJobScrapeFunction() {
  const _wait = ms => new Promise(r => setTimeout(r, ms));

  // Read text from element — textContent first (always works), then clean up whitespace
  function _read(el) {
    if (!el) return '';
    // Try innerText first (layout-aware, respects CSS visibility)
    // If the element is off-screen, innerText is empty — fall back to textContent
    const byInner = (el.innerText || '').trim();
    const byContent = (el.textContent || '').trim();
    const raw = byInner.length > byContent.length * 0.5 ? byInner : byContent;
    // Normalize whitespace: collapse 3+ newlines to 2, trim each line
    return raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Among all elements matching a selector, return the one with the most text
  function _best(selector, minLen) {
    const els = [...document.querySelectorAll(selector)];
    if (!els.length) return null;
    let best = null, bestLen = minLen || 0;
    for (const el of els) {
      const len = (el.textContent || '').trim().length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    return best;
  }

  console.log('[JobScrape v5] START url=' + location.href.slice(0, 100));

  const dbg = { layer: null, descSelector: null, descLen: 0, attempts: [] };

  const result = {
    _source: 'job_scrape',
    url: location.href,
    title: '', company: '', location: '',
    description: '', requirements: [], skills: [],
    seniority: '', employment_type: '', job_id: '',
  };

  // ── Job ID from URL ──
  result.job_id = (location.href.match(/[?&\/](?:currentJobId=|jobs\/view\/)(\d{7,})/) || ['', ''])[1];

  // ══════════════════════════════════════════════════════════════
  // LAYER 0 — JSON-LD (present on some LinkedIn pages, absent on SDUI pages)
  // ══════════════════════════════════════════════════════════════
  for (const scriptEl of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const d = JSON.parse(scriptEl.textContent);
      if (d['@type'] !== 'JobPosting') continue;
      if (d.title)                    result.title   = d.title;
      if (d.hiringOrganization?.name) result.company = d.hiringOrganization.name;
      if (d.identifier?.value)        result.job_id  = result.job_id || String(d.identifier.value);
      const loc = d.jobLocation;
      if (loc) {
        const addr = Array.isArray(loc) ? loc[0]?.address : loc?.address;
        if (addr) result.location = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
      }
      if (d.employmentType) {
        const et = Array.isArray(d.employmentType) ? d.employmentType[0] : d.employmentType;
        result.employment_type = String(et).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
      }
      if (d.description) {
        // JSON-LD description is HTML — strip tags
        const div = document.createElement('div');
        div.innerHTML = d.description;
        div.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
        div.querySelectorAll('p, li, h1, h2, h3').forEach(el => el.insertAdjacentText('afterend', '\n'));
        result.description = div.textContent.replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
        dbg.layer = 'json-ld';
      }
      break;
    } catch {}
  }
  dbg.attempts.push('json-ld:' + (result.description.length > 0 ? 'hit' : 'miss'));

  // ══════════════════════════════════════════════════════════════
  // LAYER 1 — SDUI aboutTheJob component (LinkedIn's current layout)
  //
  // KEY FACTS from diagnostic:
  //   - [data-sdui-component*="aboutTheJob"] exists with ~4400 chars  ✓
  //   - [data-testid="expandable-text-box"] has 2 matches — pick LARGEST
  //   - h1 does NOT exist — title comes from document.title
  //   - textContent works even when element is off-screen
  // ══════════════════════════════════════════════════════════════
  if (!result.description) {
    dbg.layer = 'dom-sdui';

    // Attempt 1: aboutTheJob SDUI component — the most specific match possible.
    // This is the definitive "About the job" section container.
    // Using textContent directly — no scroll needed, no visibility required.
    const aboutTheJobEl = _best('[data-sdui-component*="aboutTheJob"]', 80);
    if (aboutTheJobEl) {
      dbg.descSelector = 'sdui-aboutTheJob';
      result.description = _read(aboutTheJobEl).slice(0, 12000);
      dbg.attempts.push('sdui-aboutTheJob:hit len=' + result.description.length);
    } else {
      dbg.attempts.push('sdui-aboutTheJob:miss');
    }
  }

  if (!result.description) {
    // Attempt 2: expandable-text-box — pick the LARGEST one.
    // There are 2 on the page: "How you fit" and "About the job".
    // The job description is always the larger one.
    const tbEl = _best('[data-testid="expandable-text-box"]', 80);
    if (tbEl) {
      dbg.descSelector = 'expandable-text-box-largest';
      result.description = _read(tbEl).slice(0, 12000);
      dbg.attempts.push('expandable-text-box:hit len=' + result.description.length);
    } else {
      dbg.attempts.push('expandable-text-box:miss');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // LAYER 2 — scroll + poll (if description not yet in DOM)
  // Only runs when layers 0–1 found nothing, meaning the description
  // section hasn't rendered yet (genuine lazy load).
  // ══════════════════════════════════════════════════════════════
  if (!result.description) {
    dbg.layer = 'dom-scroll';

    // Find the right scrollable container.
    // On split-pane, the right panel scrolls independently — NOT window.
    let scrollEl = null;
    for (const s of ['#workspace', 'main', '.scaffold-layout__detail', '.jobs-search__job-details--wrapper']) {
      const el = document.querySelector(s);
      if (el) { scrollEl = el; break; }
    }

    // Scroll down progressively to trigger lazy rendering
    for (let i = 0; i < 8; i++) {
      if (scrollEl) scrollEl.scrollTop += 300;
      else          window.scrollBy(0, 300);
      await _wait(180);
    }
    await _wait(600);

    // Click "Show more" / "Voir plus" on the description section
    document.querySelectorAll('button, [role="button"]').forEach(btn => {
      const lbl = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
      if (/show more|see more|voir plus|afficher plus|expand/i.test(lbl)) {
        try { btn.click(); } catch {}
      }
    });
    await _wait(500);

    // Try again after scroll — still preferring largest match
    const afterScrollEl =
      _best('[data-sdui-component*="aboutTheJob"]', 80) ||
      _best('[data-testid="expandable-text-box"]', 80) ||
      _best('#job-details, [id*="job-details"]', 80);

    if (afterScrollEl) {
      dbg.descSelector = 'after-scroll';
      result.description = _read(afterScrollEl).slice(0, 12000);
      dbg.attempts.push('after-scroll:hit len=' + result.description.length);
    } else {
      dbg.attempts.push('after-scroll:miss');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // LAYER 3 — Largest text block fallback (nuclear)
  // ══════════════════════════════════════════════════════════════
  if (!result.description) {
    dbg.layer = 'largest-block';
    let best = null, bestLen = 400;
    document.querySelectorAll('div, section, article').forEach(el => {
      if (/^(SCRIPT|STYLE|NAV|HEADER|FOOTER)$/.test(el.tagName)) return;
      if (el.closest('aside, nav, [role="navigation"]')) return;
      const tc = (el.textContent || '').trim();
      if (tc.length > bestLen && tc.length < 40000 && el.children.length < 30) {
        best = el; bestLen = tc.length;
      }
    });
    if (best) {
      dbg.descSelector = 'largest-block';
      result.description = _read(best).slice(0, 12000);
      dbg.attempts.push('largest-block:hit len=' + result.description.length);
    } else {
      dbg.attempts.push('largest-block:miss');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // HEADER FIELDS — title, company, location
  //
  // IMPORTANT ORDER:
  //   1. document.title  — "Job Title | Company | LinkedIn" on /jobs/view/
  //                        Always correct. Must run FIRST.
  //   2. h1 fallback     — DANGEROUS on LinkedIn SDUI pages: "Top job picks for you"
  //                        carousel section heading is an h1 and passes naive filters.
  //                        Only use as last resort with strict job-title heuristics.
  // ══════════════════════════════════════════════════════════════

  // 1. document.title — most reliable source for /jobs/view/ pages
  if (!result.title) {
    // Strip notification badge "(N) " if present
    const docTitle = document.title.replace(/^\(\d+\)\s*/, '');
    if (docTitle) {
      const parts = docTitle.split('|').map(s => s.trim()).filter(s => s && s !== 'LinkedIn');
      // Reject generic search/listing titles
      if (parts[0] && !/^(search|find a job|jobs|top job|recommended|my jobs)/i.test(parts[0])) {
        result.title = parts[0];
      }
      if (!result.company && parts[1]) result.company = parts[1];
    }
  }

  // 2. h1 fallback — only for layouts that have a job-specific h1.
  //    Must NOT match LinkedIn section/navigation headings like "Top job picks for you",
  //    "People also viewed", "More jobs for you", etc.
  //    Require: contains at least one word from common job title vocabulary OR
  //    is scoped inside the job detail panel (workspace/main, not the broader page).
  if (!result.title) {
    const detailPanel = document.querySelector('#workspace, main');
    const h1Scope = detailPanel || document;
    for (const h of h1Scope.querySelectorAll('h1')) {
      const txt = (h.textContent || '').split('\n')[0].trim();
      if (!txt || txt.length < 3 || txt.length > 120) continue;
      // Reject known LinkedIn section headings
      if (/^(top job|more jobs|people also|recommended|similar|sign in|find a job|jobs you|linkedin)/i.test(txt)) continue;
      result.title = txt;
      break;
    }
  }

  // Company from /company/ link — stable, always present
  if (!result.company) {
    const compEl = document.querySelector('main a[href*="/company/"], #workspace a[href*="/company/"]');
    if (compEl) result.company = (compEl.textContent || '').split('\n')[0].trim();
  }

  // Location: find the city/country span, strip LinkedIn metadata noise.
  // LinkedIn renders: "Tunis, Tunis, Tunisia (On-site) · 5 months ago · 100 applied"
  // in a single span. We clip at the first · to get just the location part.
  if (!result.location) {
    const geoRx = /remote|hybrid|on.?site|Tunisia|France|Germany|UK|UAE|Algeria|Morocco|Saudi|Qatar|Canada|USA|Paris|London|Dubai|Tunis|Berlin|Amsterdam|Sfax|Sousse/i;
    for (const el of document.querySelectorAll('span, p')) {
      // Take only the first segment (before any · separator)
      const raw = (el.textContent || '').split('\n')[0].trim();
      const t = raw.split('·')[0].trim();   // strip " · 5 months ago · ..." tail
      if (t.length > 3 && t.length < 80 && geoRx.test(t) && /,/.test(t)) {
        // Also strip trailing work-mode badge "(On-site)", "(Remote)" if present
        result.location = t.replace(/\s*\((on.?site|remote|hybrid|présentiel)\)\s*$/i, '').trim();
        break;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // DERIVED FIELDS
  // ══════════════════════════════════════════════════════════════
  const _all = (result.title + ' ' + result.description).toLowerCase();

  if (!result.employment_type) {
    result.employment_type =
      /full[\s-]time/i.test(_all)                          ? 'Full-time'  :
      /part[\s-]time/i.test(_all)                          ? 'Part-time'  :
      /\bcontract\b|\bfreelance\b/i.test(_all)             ? 'Contract'   :
      /internship|stage pfe|stage\b|intern\b/i.test(_all)  ? 'Internship' : '';
  }

  result.seniority =
    /\bsenior\b|lead |principal\b|staff\b/i.test(result.title)  ? 'Senior'      :
    /\bjunior\b|entry.level|graduate\b/i.test(result.title)     ? 'Entry Level' :
    /\bmanager\b|director\b|head of|vp\b/i.test(result.title)   ? 'Manager'     :
    /\bintern\b|stage\b|pfe\b/i.test(result.title)              ? 'Internship'  :
    result.title ? 'Mid-level' : '';

  // Requirements: lines following a requirements/qualifications header
  const reqRx = /requirements?|qualifications?|what you.ll need|you (should|must) have|must.have|key skills|technical skills|compétences|prérequis|profil recherché|what we.re looking for/i;
  const allLines = result.description.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  const reqIdx   = allLines.findIndex(l => reqRx.test(l));
  result.requirements = (reqIdx !== -1 ? allLines.slice(reqIdx + 1, reqIdx + 35) : allLines)
    .filter(l => /^[•\-\*]/.test(l) || /^\d+[.)]/.test(l) || l.length > 15)
    .slice(0, 25)
    .map(l => l.replace(/^[•\-\*\d.)]+\s*/, '').trim())
    .filter(l => l.length > 5);

  // Skills: tech keyword extraction for gap analysis
  const skillRx = /\b(python|javascript|typescript|react|vue|angular|node\.?js|java|kotlin|swift|c\+\+|c#|go|rust|php|ruby|scala|sql|nosql|mongodb|postgresql|mysql|redis|elasticsearch|aws|azure|gcp|docker|kubernetes|git|linux|agile|scrum|jira|figma|tableau|power bi|excel|tensorflow|pytorch|scikit|pandas|numpy|spark|kafka|airflow|dbt|ci\/cd|jenkins|ansible|terraform|html|css|graphql|rest|microservices|nlp|llm|machine learning|deep learning|data science)\b/gi;
  result.skills = [...new Set((result.description.match(skillRx) || []).map(s => s.toLowerCase()))].slice(0, 25);

  dbg.descLen = result.description.length;
  result._debug = {
    ...dbg,
    title: result.title, company: result.company, location: result.location,
    requirementsCount: result.requirements.length, skillsCount: result.skills.length,
    url: location.href.slice(0, 120),
  };

  console.log('[JobScrape v5] DONE layer=' + dbg.layer + ' descLen=' + dbg.descLen +
    ' attempts=' + dbg.attempts.join(' | '));

  return result;
}

async function _checkJobPageActive() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const hintEl = document.getElementById('gapJobHint');
  const scrapeBtn = document.getElementById('gapJobScrapeBtn');
  if (!tab?.url) return;
  if (_isLinkedInJobUrl(tab.url)) {
    if (hintEl) hintEl.textContent = 'Job posting detected. Click below to extract and analyze your fit.';
    if (scrapeBtn) scrapeBtn.textContent = 'Extract Job Posting';
  } else if (/linkedin\.com\/jobs\//.test(tab.url)) {
    if (hintEl) hintEl.textContent = 'Click on a specific job in the list, then click Extract.';
  } else {
    if (hintEl) hintEl.textContent = 'Go to LinkedIn Jobs and open a specific posting, then click Extract.';
  }
}

async function gapScrapeJob() {
  const stored = await chrome.storage.local.get(['myProfile', 'gapConsentGiven']);
  if (!stored.gapConsentGiven) {
    document.getElementById('gapIdle').classList.add('gap-hidden');
    document.getElementById('gapModeTabs').style.display = 'none';
    document.getElementById('gapConsent').style.display = '';
    return;
  }
  const myP = stored.myProfile;
  if (!myP || (!myP.name && !myP.headline)) {
    toast('Your profile is not saved yet. Visit YOUR LinkedIn profile first.', 'warn', 5000);
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!_isLinkedInJobUrl(tab?.url)) {
    toast('Click on a specific job in LinkedIn Jobs first, then try again.', 'warn');
    return;
  }

  document.getElementById('gapIdle').classList.add('gap-hidden');
  document.getElementById('gapLoading').classList.remove('gap-hidden');
  document.querySelector('#gapLoading').innerHTML = '<span class="net-spinner"></span> Extracting job posting...';

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: inlineJobScrapeFunction,
    });
    const job = res?.[0]?.result || {};
    console.log('[JobScrape] result:', job._debug, 'title:', job.title, 'descLen:', job.description?.length);

    // Backfill job_id from tab URL if scraper couldn't get it from page URL
    if (!job.job_id) job.job_id = _extractJobId(tab.url);

    if (!job.title && !job.description) {
      console.warn('[JobScrape] nothing found. debug:', JSON.stringify(job._debug));
      const dbg = job._debug || {};
      throw new Error(
        'Could not extract job details. ' +
        `(docTitle="${dbg.docTitle}", testId=${dbg.descElTestId}, sdui=${dbg.descElSdui}, workspace=${dbg.workspaceEl}) ` +
        'Try clicking directly on the job title to open the full page, then retry.'
      );
    }

    _jobScraped = job;

    // Show preview
    document.getElementById('gapLoading').classList.add('gap-hidden');
    document.getElementById('gapIdle').classList.remove('gap-hidden');
    document.getElementById('gapJobPreview').style.display = '';
    document.getElementById('gapJobTitle').textContent = job.title || 'Unknown Title';
    document.getElementById('gapJobCompany').textContent = job.company || '';
    const metaParts = [job.location, job.employment_type, job.seniority].filter(Boolean);
    document.getElementById('gapJobMeta').textContent = metaParts.join(' · ');

    // Update hint to confirm job was extracted (not a profile)
    const jobHintEl = document.getElementById('gapJobHint');
    if (jobHintEl) jobHintEl.textContent = 'Job posting extracted. Review the details below, then click Analyze to see how well you fit.';

    // Show description snippet with expandable "Show full" toggle
    const descSnippetEl = document.getElementById('gapJobDescSnippet');
    if (descSnippetEl) {
      if (job.description && job.description.length > 50) {
        const charCount = job.description.length;
        const preview   = job.description.slice(0, 220).trimEnd();
        const isTrunc   = job.description.length > 220;
        let expanded    = false;

        // Text node (pre-wrap so newlines render)
        const textEl = document.createElement('div');
        textEl.id = 'gapDescText';
        textEl.style.cssText = 'white-space:pre-wrap;word-break:break-word;line-height:1.5;';
        textEl.textContent = isTrunc ? preview + '…' : preview;

        // Toggle link
        const toggleEl = document.createElement('span');
        toggleEl.id = 'gapDescToggle';
        toggleEl.style.cssText = 'color:#0a66c2;cursor:pointer;font-weight:600;display:block;margin-top:4px;';
        toggleEl.textContent = isTrunc ? 'Show more' : '';

        descSnippetEl.innerHTML = '';
        descSnippetEl.appendChild(textEl);
        if (isTrunc) descSnippetEl.appendChild(toggleEl);
        descSnippetEl.style.display = '';

        toggleEl.addEventListener('click', () => {
          expanded = !expanded;
          textEl.textContent = expanded ? job.description : preview + '…';
          toggleEl.textContent = expanded ? 'Show less' : 'Show more';
        });
      } else {
        descSnippetEl.textContent = 'No description captured — analysis may be inaccurate.';
        descSnippetEl.style.display = '';
      }
    }

    document.getElementById('gapJobScrapeBtn').style.display = 'none';
    document.getElementById('gapJobAnalyzeBtn').style.display = '';
    document.getElementById('gapJobAnalyzeBtn').textContent = 'Run Fit Analysis';
  } catch (e) {
    document.getElementById('gapLoading').classList.add('gap-hidden');
    document.getElementById('gapIdle').classList.remove('gap-hidden');
    toast('Extraction error: ' + e.message, 'error');
  }
}

async function runJobFitAnalysis() {
  if (!_jobScraped) { toast('Extract a job posting first.', 'warn'); return; }

  const stored = await chrome.storage.local.get(['myProfile']);
  const { authToken } = await chrome.storage.sync.get(['authToken']);
  if (!authToken) { toast('Please log in first.', 'warn'); return; }
  const myP = stored.myProfile;
  if (!myP || (!myP.name && !myP.headline)) { toast('Your profile is not saved yet.', 'warn'); return; }

  document.getElementById('gapIdle').classList.add('gap-hidden');
  document.getElementById('gapJobResult').classList.add('gap-hidden');
  document.getElementById('gapLoading').classList.remove('gap-hidden');
  document.querySelector('#gapLoading').innerHTML = '<span class="net-spinner"></span> Analyzing your fit for this role...';

  try {
    const r = await chrome.runtime.sendMessage({
      action: 'jobFitAnalysis',
      data: {
        user_profile: {
          name:           myP.name || '',
          headline:       myP.headline || myP.currentRole || '',
          about:          myP.about || '',
          experience:     myP.experience || [],
          education:      myP.education || [],
          skills:         myP.skills || [],
          certifications: myP.certifications || [],
        },
        job: _jobScraped,
        ui_lang: window._uiLang || 'en',
      },
    });

    document.getElementById('gapLoading').classList.add('gap-hidden');
    if (!r.success) {
      toast('Analysis failed: ' + r.error, 'error');
      document.getElementById('gapIdle').classList.remove('gap-hidden');
      return;
    }

    const d = r.data;
    _gapResultMode = 'job';
    document.getElementById('gapJobResult').classList.remove('gap-hidden');
    _renderJobFitResult(d, _jobScraped);
    _wireInterviewPrepBtn(myP);
  } catch (e) {
    document.getElementById('gapLoading').classList.add('gap-hidden');
    document.getElementById('gapIdle').classList.remove('gap-hidden');
    toast('Error: ' + e.message, 'error');
  }
}

let _lastJobFitData = null;
let _lastJobFitJob = null;
function _renderJobFitResult(d, job) {
  _lastJobFitData = d;
  _lastJobFitJob = job;
  const score = Math.max(0, Math.min(100, d.fit_score || 0));

  // Score ring — circumference = 2π × r(45) ≈ 282.74
  const ring = document.getElementById('jfRingFill');
  if (ring) {
    const circ = 2 * Math.PI * 45;
    const filled = (score / 100) * circ;
    ring.setAttribute('stroke-dasharray', `${filled.toFixed(2)} ${(circ - filled).toFixed(2)}`);
    ring.style.stroke = score >= 70 ? '#22c55e' : score >= 45 ? 'var(--ac, #0077b5)' : '#f59e0b';
  }
  document.getElementById('jfScore').textContent = score + '%';
  document.getElementById('jfFitLabel').textContent = d.fit_label || '';
  document.getElementById('jfJobName').textContent = [job.title, job.company].filter(Boolean).join(' @ ');

  // Application verdict badge
  const badge = document.getElementById('jfVerdictBadge');
  if (badge && d.application_verdict) {
    badge.textContent = d.application_verdict;
    const v = d.application_verdict.toLowerCase();
    badge.className = 'jf-verdict-badge ' + (v.includes('now') ? 'jf-badge-green' : v.includes('cover') ? 'jf-badge-blue' : v.includes('upskill') ? 'jf-badge-amber' : 'jf-badge-red');
  }

  // Specialty + coaching note
  const spec = document.getElementById('jfSpecialty');
  if (spec) {
    const icon = d.specialty_match ? '✓' : '○';
    spec.innerHTML = `<span class="jf-specialty-icon ${d.specialty_match ? 'match' : 'miss'}">${icon}</span> ${esc(d.specialty_verdict || '')}`;
  }
  const coaching = document.getElementById('jfCoaching');
  if (coaching) coaching.textContent = d.overall_coaching_note || '';

  // Why you're a fit
  const fitPoints = document.getElementById('jfFitPoints');
  if (fitPoints) {
    const fits = d.why_youre_a_fit || [];
    fitPoints.innerHTML = fits.length
      ? fits.map(p => `<div class="jf-fit-point"><span class="jf-point-icon">✓</span>${esc(p)}</div>`).join('')
      : `<div class="jf-empty">${window._t('jfNoFitSignals')}</div>`;
    document.getElementById('jfFitSection').style.display = fits.length ? '' : 'none';
  }

  // Critical gaps
  const gapsList = document.getElementById('jfGapsList');
  const critGaps = d.critical_gaps || [];
  if (gapsList) {
    gapsList.innerHTML = critGaps.map(g => {
      const sevClass = g.severity === 'Blocking' ? 'jf-gap-severity-blocking'
                     : g.severity === 'High'     ? 'jf-gap-severity-high'
                     : 'jf-gap-severity-medium';
      const statusBadge = g.status ? `<span class="jf-gap-status">${esc(g.status)}</span>` : '';
      return `
      <div class="jf-gap-card ${sevClass}">
        <div class="jf-gap-req">${esc(g.requirement || '')} ${statusBadge}</div>
        <div class="jf-gap-detail">${esc(g.gap || '')}</div>
        ${g.how_to_address ? `<div class="jf-gap-action"><span class="jf-action-label">${window._t('jfGapFix')}</span> ${esc(g.how_to_address)}</div>` : ''}
      </div>`;
    }).join('');
    document.getElementById('jfCriticalGaps').style.display = critGaps.length ? '' : 'none';
  }

  // Nice-to-have gaps
  const niceGaps = d.nice_to_have_gaps || [];
  const niceList = document.getElementById('jfNiceList');
  if (niceList && niceGaps.length) {
    niceList.innerHTML = niceGaps.map(g => `<div class="jf-nice-gap">○ ${esc(g)}</div>`).join('');
    document.getElementById('jfNiceGaps').style.display = '';
  }

  // CV Tailoring
  const cvTailoring = d.cv_tailoring || {};
  const cvToggle = document.getElementById('jfCVToggle');
  const cvBody = document.getElementById('jfCVBody');
  if (cvToggle) {
    cvToggle.onclick = () => {
      const open = cvBody.style.display !== 'none';
      cvBody.style.display = open ? 'none' : '';
      cvToggle.querySelector('.jf-toggle-icon').textContent = open ? '+' : '−';
    };
  }

  const cvHeadline = document.getElementById('jfCVHeadline');
  if (cvHeadline && cvTailoring.headline) {
    cvHeadline.innerHTML = `<span class="jf-cv-label">${window._t('jfCVHeadlineLabel')}</span><div class="jf-cv-value">${esc(cvTailoring.headline)}<button class="jf-copy-mini" data-copy="${esc(cvTailoring.headline)}">Copy</button></div>`;
  }

  const cvAbout = document.getElementById('jfCVAbout');
  if (cvAbout && cvTailoring.about_opening) {
    cvAbout.innerHTML = `<span class="jf-cv-label">${window._t('jfCVAboutLabel')}</span><div class="jf-cv-value">${esc(cvTailoring.about_opening)}<button class="jf-copy-mini" data-copy="${esc(cvTailoring.about_opening)}">Copy</button></div>`;
  }

  const cvBullets = document.getElementById('jfCVBullets');
  const rewrites = cvTailoring.experience_rewrites || [];
  if (cvBullets && rewrites.length) {
    cvBullets.innerHTML = `<div class="jf-cv-label">${window._t('jfCVBulletsLabel')}</div>` +
      rewrites.map(r => `
        <div class="jf-bullet-rewrite">
          <div class="jf-bullet-role">${esc(r.role || '')}</div>
          <div class="jf-bullet-before"><span class="jf-bullet-tag before">${window._t('jfBulletBefore')}</span>${esc(r.bullet_to_rewrite || '')}</div>
          <div class="jf-bullet-after"><span class="jf-bullet-tag after">${window._t('jfBulletAfter')}</span>${esc(r.rewritten || '')}<button class="jf-copy-mini" data-copy="${esc(r.rewritten || '')}">Copy</button></div>
          ${r.why ? `<div class="jf-bullet-why">${esc(r.why)}</div>` : ''}
        </div>`).join('');
  }

  const keywords = [...(cvTailoring.keywords_missing || []), ...(cvTailoring.skills_to_highlight || []).map(s => s)];
  const kwEl = document.getElementById('jfKeywords');
  if (kwEl && keywords.length) {
    kwEl.innerHTML = `<div class="jf-cv-label">${window._t('jfCVKeywordsLabel')}</div><div class="jf-kw-grid">${keywords.map(k => `<span class="jf-kw-chip ${k.startsWith('★') ? 'jf-kw-highlight' : ''}">${esc(k)}</span>`).join('')}</div>`;
  }

  const certs = cvTailoring.certifications_to_add || [];
  const certsEl = document.getElementById('jfCerts');
  if (certsEl && certs.length) {
    certsEl.style.display = '';
    certsEl.innerHTML = `<div class="jf-cv-label">${window._t('jfCVCertsLabel')}</div><div class="jf-kw-grid">${certs.map(c => `<span class="jf-kw-chip jf-kw-cert">${esc(c)}</span>`).join('')}</div>`;
  }

  // Role analysis (domain, seniority fit)
  const roleAnalysis = d.role_analysis || {};
  const roleEl = document.getElementById('jfRoleAnalysisBody');
  if (roleEl && Object.keys(roleAnalysis).length) {
    const seniorityFitClass = {
      'Exact match': 'jf-seniority-match',
      'One level below': 'jf-seniority-warn',
      'Two+ levels below': 'jf-seniority-danger',
      'Overqualified': 'jf-seniority-warn',
    }[roleAnalysis.seniority_fit] || '';
    roleEl.innerHTML = `
      <div class="jf-role-row"><span class="jf-role-label">${window._t('jfRoleDomain')}</span><span>${esc(roleAnalysis.domain || '')}</span></div>
      <div class="jf-role-row"><span class="jf-role-label">${window._t('jfRoleRequired')}</span><span>${esc(roleAnalysis.seniority_required || '')}</span></div>
      <div class="jf-role-row"><span class="jf-role-label">${window._t('jfRoleYours')}</span><span>${esc(roleAnalysis.seniority_candidate || '')}</span></div>
      <div class="jf-role-row"><span class="jf-role-label">${window._t('jfRoleSeniorityFit')}</span><span class="${seniorityFitClass}">${esc(roleAnalysis.seniority_fit || '')}</span></div>
      ${(roleAnalysis.must_haves||[]).length ? `<div class="jf-role-row"><span class="jf-role-label">${window._t('jfRoleMustHaves')}</span><span>${(roleAnalysis.must_haves||[]).map(m => `<span class="jf-must-chip">${esc(m)}</span>`).join(' ')}</span></div>` : ''}
    `;
    document.getElementById('jfRoleAnalysis').style.display = '';
  }

  // Priority improvements (ranked roadmap)
  const priorities = d.priority_improvements || [];
  const prioEl = document.getElementById('jfPriorityList');
  if (prioEl && priorities.length) {
    prioEl.innerHTML = priorities.map(p => `
      <div class="jf-priority-card">
        <div class="jf-priority-rank">${p.rank || ''}</div>
        <div class="jf-priority-body">
          <div class="jf-priority-action">${esc(p.action || '')}</div>
          <div class="jf-priority-meta">
            ${p.timeframe ? `<span class="jf-timeframe">${esc(p.timeframe)}</span>` : ''}
            ${p.impact ? `<span class="jf-impact">${esc(p.impact)}</span>` : ''}
          </div>
        </div>
      </div>`).join('');
    document.getElementById('jfPrioritySection').style.display = '';
  }

  // Interview likely questions (was in schema, never rendered — now fixed)
  const interviewQs = d.interview_likely_questions || [];
  const interviewEl = document.getElementById('jfInterviewList');
  if (interviewEl && interviewQs.length) {
    interviewEl.innerHTML = interviewQs.map((q, i) =>
      `<div class="jf-interview-q"><span class="jf-q-num">Q${i+1}</span>${esc(q)}</div>`
    ).join('');
    document.getElementById('jfInterviewSection').style.display = '';
  }

  // Cover letter points
  const coverPoints = document.getElementById('jfCoverPoints');
  const coverItems = d.cover_letter_talking_points || [];
  if (coverPoints) {
    coverPoints.innerHTML = coverItems.map(p => `<div class="jf-cover-point">→ ${esc(p)}</div>`).join('');
    document.getElementById('jfCoverSection').style.display = coverItems.length ? '' : 'none';
  }

  // Red flags
  const redFlags = d.red_flags || [];
  const redEl = document.getElementById('jfRedList');
  if (redEl && redFlags.length) {
    redEl.innerHTML = redFlags.map(f => `<div class="jf-red-flag"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-1px;margin-right:3px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${esc(f)}</div>`).join('');
    document.getElementById('jfRedFlags').style.display = '';
  }

  // Wire copy buttons
  document.getElementById('gapJobResult').querySelectorAll('.jf-copy-mini').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy || '');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      } catch { toast('Copy failed', 'warn'); }
    });
  });
}


// ─────────────────────────────────────────────────────────────────────────────
//  Interview Prep — wires the "Generate Full Interview Prep" button inside
//  the Job Fit result panel and renders the structured 10-question output.
// ─────────────────────────────────────────────────────────────────────────────
function _wireInterviewPrepBtn(myP) {
  const btn = document.getElementById('gapInterviewBtn');
  const resultEl = document.getElementById('gapInterviewPrepResult');
  if (!btn || !resultEl) return;

  btn.addEventListener('click', async () => {
    if (!_jobScraped) { toast('No job data available.', 'warn'); return; }
    const { authToken } = await chrome.storage.sync.get(['authToken']);
    if (!authToken) { toast('Please log in first.', 'warn'); return; }

    btn.disabled = true;
    btn.textContent = 'Preparing…';
    resultEl.classList.add('gap-hidden');

    try {
      const r = await chrome.runtime.sendMessage({
        action: 'interviewPrep',
        data: {
          user_profile: {
            name:           myP.name || '',
            headline:       myP.headline || myP.currentRole || '',
            about:          myP.about || '',
            experience:     myP.experience || [],
            education:      myP.education || [],
            skills:         myP.skills || [],
            certifications: myP.certifications || [],
          },
          job: _jobScraped,
          ui_lang: window._uiLang || 'en',
        },
      });

      if (!r.success) throw new Error(r.error || 'Unknown error');
      _renderInterviewPrep(r.data, resultEl);
      resultEl.classList.remove('gap-hidden');
      btn.textContent = window._t('ipRegenerateBtn');
    } catch (e) {
      toast('Interview prep failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

function _renderInterviewPrep(data, container) {
  const qs = data.questions || [];
  const tips = data.preparation_tips || [];
  const askQs = data.questions_to_ask_interviewer || [];

  let html = `<div class="ip-header">
    <div class="ip-meta">${esc(data.role_title || '')} · ${esc(data.company || '')} · <span class="ip-tier">${esc(data.difficulty_tier || '')}</span></div>
  </div>`;

  html += '<div class="ip-questions">';
  qs.forEach((q, i) => {
    const typeClass = q.type === 'Technical' ? 'ip-type-tech'
                    : q.type === 'Behavioural' ? 'ip-type-beh'
                    : q.type === 'Situational' ? 'ip-type-sit'
                    : 'ip-type-cult';
    const star = q.star_guide || {};
    html += `<div class="ip-q-card">
      <div class="ip-q-header">
        <span class="ip-q-num">Q${i + 1}</span>
        <span class="ip-q-type ${typeClass}">${esc(q.type || '')}</span>
        ${q.tailored_to_gap ? `<span class="ip-gap-tag">${window._t('ipProbes')} ${esc(q.tailored_to_gap)}</span>` : ''}
      </div>
      <div class="ip-q-text">${esc(q.question || '')}</div>
      <div class="ip-why-asked">${esc(q.why_asked || '')}</div>
      <div class="ip-star">
        <div class="ip-star-title">${window._t('ipStarGuide')}</div>
        <div class="ip-star-row"><span class="ip-star-label S">S</span><span>${esc(star.situation || '')}</span></div>
        <div class="ip-star-row"><span class="ip-star-label T">T</span><span>${esc(star.task || '')}</span></div>
        <div class="ip-star-row"><span class="ip-star-label A">A</span><span>${esc(star.action || '')}</span></div>
        <div class="ip-star-row"><span class="ip-star-label R">R</span><span>${esc(star.result || '')}</span></div>
      </div>
      ${q.strong_answer_signals?.length ? `<div class="ip-signals">${window._t('ipStrongSignals')} ${q.strong_answer_signals.map(s => `<span class="ip-signal">${esc(s)}</span>`).join('')}</div>` : ''}
      ${q.red_flags_to_avoid ? `<div class="ip-red-flag">${window._t('ipAvoid')} ${esc(q.red_flags_to_avoid)}</div>` : ''}
    </div>`;
  });
  html += '</div>';

  if (tips.length) {
    html += `<div class="ip-tips"><div class="ip-tips-title">${window._t('ipPrepTips')}</div>${tips.map(t => `<div class="ip-tip">• ${esc(t)}</div>`).join('')}</div>`;
  }
  if (askQs.length) {
    html += `<div class="ip-ask"><div class="ip-ask-title">${window._t('ipAskTitle')}</div>${askQs.map(q => `<div class="ip-ask-q">→ ${esc(q)}</div>`).join('')}</div>`;
  }

  container.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pre-compute Power Index anchor values from scraped profile data.
//  Three of five dimensions are derived from real numbers so the AI can't guess.
//  narrative_quality and career_trajectory stay AI-assessed (genuinely subjective).
// ─────────────────────────────────────────────────────────────────────────────
function _computeProfileSignals(p) {
  if (!p) return null;
  const expCount    = (p.experience || []).length;
  const skillCount  = (p.skills     || []).length;
  const aboutLen    = (p.about      || '').length;
  const headWords   = (p.headline   || '').split(/\s+/).filter(Boolean).length;
  const eduCount    = (p.education  || []).length;
  const certCount   = (p.certifications || []).length;
  const hasPhoto    = !!(p.profilePhotoUrl || p.photo);
  const connections = parseInt(p.connectionsCount || p.connections || 0) || 0;
  const followers   = parseInt(p.followersCount  || p.followers   || 0) || 0;
  const lastPost    = (p.last_post_days != null) ? parseInt(p.last_post_days) : 999;
  const posts30d    = parseInt(p.post_count_30d  || 0) || 0;

  // --- profile_completeness: how many sections are genuinely filled ---
  const completeness = Math.min(100, Math.round(
    (hasPhoto ? 10 : 0) +
    (headWords >= 7 ? 15 : headWords >= 4 ? 10 : headWords >= 1 ? 5 : 0) +
    (aboutLen  >= 500 ? 20 : aboutLen >= 200 ? 14 : aboutLen >= 50 ? 7 : 0) +
    (expCount  >= 5  ? 20 : expCount >= 3 ? 14 : expCount >= 1 ? 7 : 0) +
    (skillCount >= 20 ? 15 : skillCount >= 10 ? 10 : skillCount >= 4 ? 5 : 0) +
    (eduCount  >= 1 ? 10 : 0) +
    (certCount >= 3 ? 10 : certCount >= 1 ? 5 : 0)
  ));

  // --- keyword_strength: headline specificity + skill density + about richness ---
  const keywordStrength = Math.min(100, Math.round(
    Math.min(40, headWords * 4) +
    Math.min(35, skillCount * 2) +
    (aboutLen >= 500 ? 25 : aboutLen >= 200 ? 16 : aboutLen >= 50 ? 8 : 0)
  ));

  // --- network_signal: connections + followers + content activity ---
  const connScore     = Math.min(40, Math.round(Math.log10(Math.max(1, connections)) * 14));
  const followScore   = Math.min(20, Math.round(Math.log10(Math.max(1, followers))   * 7));
  const activityScore = lastPost <= 1 ? 40 : lastPost <= 7 ? 32 : lastPost <= 30 ? 20
                      : lastPost <= 90 ? 10 : posts30d >= 1 ? 5 : 0;
  const networkSignal = Math.min(100, connScore + followScore + activityScore);

  return { completeness, keyword_strength: keywordStrength, network_signal: networkSignal };
}

async function runGapAnalysis() {
  // Step 2: use the already-scraped target from step 1
  if (!_gapScrapedTarget) {
    toast('Please extract a target profile first.', 'warn');
    return;
  }

  const stored = await chrome.storage.local.get(['networkingGoal', 'myProfile']);
  const authData = await chrome.storage.sync.get(['authToken']);

  if (!authData.authToken) {
    toast('Please log in first.', 'warn');
    return;
  }

  const myP = stored.myProfile;
  if (!myP || (!myP.name && !myP.headline)) {
    toast('Your own profile is not saved yet.', 'warn');
    return;
  }

  const targetProfile = _gapScrapedTarget;

  // Hide scraped preview, show loading
  document.getElementById('gapScraped').classList.add('gap-hidden');
  document.getElementById('gapResult').classList.add('gap-hidden');
  document.getElementById('gapLoading').classList.remove('gap-hidden');
  document.querySelector('#gapLoading').innerHTML = '<span class="net-spinner"></span> Analyzing profile gap with AI...';

  try {
    const netGoal = stored.networkingGoal || {};
    const inferredRole = myP.currentRole || myP.headline || netGoal.job_title || '';
    const user_profile = {
      goal:             netGoal.goal || 'job_search',
      name:             myP.name || '',
      headline:         myP.headline || inferredRole,
      about:            myP.about || '',
      job_title:        netGoal.job_title || myP.currentRole || '',
      industry:         netGoal.industry || _inferIndustry(inferredRole, myP.company || ''),
      seniority:        netGoal.seniority || _inferSeniority(inferredRole),
      skills:           myP.skills || netGoal.skills || [],
      experience:       myP.experience || [],
      education:        myP.education || [],
      certifications:   myP.certifications || [],
      location:         myP.location || '',
      connectionsCount: myP.connectionsCount || null,
      followersCount:   myP.followersCount || null,
      last_post_days:   myP.last_post_days ?? null,
      post_count_30d:   myP.post_count_30d ?? 0,
    };

    // Pre-compute Power Index anchors from real scraped numbers
    const user_signals   = _computeProfileSignals(myP);
    const target_signals = _computeProfileSignals(targetProfile);

    const gapCacheKey = `gap_analysis_${targetProfile.url_slug || targetProfile.name?.replace(/\s/g, '_') || 'unknown'}`;
    let d;

    try {
      const r = await chrome.runtime.sendMessage({
        action: 'profileGapAnalysis',
        data: {
          user_profile,
          target_profile: targetProfile,
          goal: user_profile.goal,
          raw_signals: { user: user_signals, target: target_signals },
          ui_lang: window._uiLang || 'en',
        },
      });

      if (!r?.success) throw new Error(r?.error || 'Analysis failed');
      d = r.data;

      await chrome.storage.local.set({
        [gapCacheKey]: { data: d, target: targetProfile, ts: Date.now() },
        _lastGapAnalysis: { data: d, target: targetProfile, user: myP, ts: Date.now() },
      });
    } catch (apiErr) {
      const cached = await chrome.storage.local.get([gapCacheKey, '_lastGapAnalysis']);
      const entry = cached[gapCacheKey] || cached._lastGapAnalysis;
      if (entry?.data) {
        d = entry.data;
        d._fromCache = true;
        if (entry.target) Object.assign(targetProfile, entry.target);
      } else {
        throw apiErr;
      }
    }

    const gapCacheTag = document.getElementById('gapCacheTag');
    if (gapCacheTag) gapCacheTag.style.display = d._fromCache ? '' : 'none';

    _gapResultMode = 'profile';
    _renderGapResult(d, targetProfile, myP);

    document.getElementById('gapLoading').classList.add('gap-hidden');
    document.getElementById('gapResult').classList.remove('gap-hidden');
  } catch (e) {
    document.getElementById('gapLoading').classList.add('gap-hidden');
    const msg = e.message || '';
    // Show error inline in gap result area instead of just an alert
    const gapResult = document.getElementById('gapResult');
    if (gapResult) {
      gapResult.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger,#ef4444)">
        <div style="font-size:24px;margin-bottom:8px">&#9888;</div>
        <div style="font-weight:600">Gap Analysis Failed</div>
        <div style="font-size:11px;margin-top:4px;color:var(--tx2)">${msg.substring(0,150).replace(/</g,'&lt;')}</div>
        <div style="font-size:10px;margin-top:8px;color:var(--tx3)">${
          msg.includes('401') ? 'Session expired -- please log in again.' :
          msg.includes('503') || msg.includes('configured') ? 'Backend not configured. Check the server .env file.' :
          'Check that your backend is running and .env is configured'
        }</div>
        <button id="gapRetryBtn"
          style="margin-top:12px;padding:6px 16px;background:var(--ac,#0a66c2);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:11px">Try Again</button>
      </div>`;
      gapResult.classList.remove('gap-hidden');
      const retryBtn = document.getElementById('gapRetryBtn');
      if (retryBtn) retryBtn.addEventListener('click', () => {
        document.getElementById('gapResult').classList.add('gap-hidden');
        document.getElementById('gapScraped').classList.remove('gap-hidden');
      });
    } else {
      document.getElementById('gapScraped').classList.remove('gap-hidden');
      toast('Error: ' + msg.substring(0, 150), 'error', 6000);
    }
  }
}

// deepGapScrape removed — gap analysis now uses the full inlineScrapeFunction + enrichWithDetailPages
