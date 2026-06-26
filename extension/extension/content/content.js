// Content script - handles inserting posts into LinkedIn and responding to ping messages.
// Profile scraping is done directly from popup.js via executeScript.

(function () {
  'use strict';

  const TAG = '[LIAI]';

  // Remove the old listener if the extension was reloaded
  if (window.__liaiV3Listener) {
    try { chrome.runtime.onMessage.removeListener(window.__liaiV3Listener); } catch { /* noop */ }
  }

  function messageHandler(req, _sender, respond) {
    // Check if the extension context is still valid
    try { chrome.runtime.getURL(''); } catch {
      return false;
    }

    if (req.action === 'insertPost') {
      insertPost(req.text);
      respond({ success: true });
      return false;
    }

    if (req.action === 'ping') {
      respond({ success: true, url: location.href });
      return false;
    }
  }

  chrome.runtime.onMessage.addListener(messageHandler);
  window.__liaiV3Listener = messageHandler;

  // Watch for navigation to the user's own profile and notify the background
  if (!window.__liaiRescrapeObserver) {
    let _lastHref = location.href;

    function _checkForOwnProfileNavigation() {
      if (location.href === _lastHref) return;
      _lastHref = location.href;

      const slugMatch = location.pathname.match(/^\/in\/([^/?#]+)/);
      if (!slugMatch) return;
      const slug = slugMatch[1];

      chrome.storage.local.get('myProfile', ({ myProfile }) => {
        if (!myProfile || !myProfile.url_slug) return;
        if (myProfile.url_slug === slug) {
          try {
            chrome.runtime.sendMessage({ action: 'ownProfileNavigated', slug });
          } catch { /* extension context may be stale */ }
        }
      });
    }

    // LinkedIn is a single-page app, so watch the title for URL changes
    const _titleObs = new MutationObserver(_checkForOwnProfileNavigation);
    _titleObs.observe(document.querySelector('title') || document.head, { subtree: true, childList: true, characterData: true });
    window.__liaiRescrapeObserver = _titleObs;

    // Also handle browser back/forward navigation
    window.addEventListener('popstate', _checkForOwnProfileNavigation);
  }

  // Insert generated text into the LinkedIn post editor
  function insertPost(text) {
    const editor = document.querySelector(
      '[contenteditable="true"][role="textbox"], ' +
      '.ql-editor[contenteditable="true"], ' +
      '[data-placeholder][contenteditable="true"]'
    );

    if (editor) {
      fillEditor(editor, text);
      return;
    }

    // If no editor is open, try clicking the "Start a post" button
    for (const btn of document.querySelectorAll('button')) {
      if (/start a post|commencer.*post/i.test(
        (btn.textContent || '') + (btn.getAttribute('aria-label') || '')
      )) {
        btn.click();
        setTimeout(() => {
          const ed = document.querySelector(
            '[contenteditable="true"][role="textbox"], .ql-editor[contenteditable="true"]'
          );
          if (ed) fillEditor(ed, text);
          else clipFallback(text);
        }, 1500);
        return;
      }
    }

    clipFallback(text);
  }

  function fillEditor(editor, text) {
    editor.innerHTML = '';
    for (const line of text.split('\n')) {
      const p = document.createElement('p');
      p.innerHTML = line.trim() ? document.createTextNode(line).textContent : '<br>';
      editor.appendChild(p);
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.focus();
    toast('Post inserted! ');
  }

  function clipFallback(text) {
    navigator.clipboard.writeText(text)
      .then(() => toast('Copied to clipboard!  Paste into LinkedIn.'))
      .catch(() => toast('Copy from the extension popup.', 'error'));
  }

  function toast(msg, type = 'success') {
    document.getElementById('liai-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'liai-toast';
    Object.assign(el.style, {
      position: 'fixed', bottom: '24px', right: '24px', zIndex: '99999',
      padding: '12px 20px', borderRadius: '8px',
      fontFamily: '-apple-system, sans-serif', fontSize: '13px', fontWeight: '600',
      background: type === 'error' ? '#fce8e6' : '#e6f4ed',
      color: type === 'error' ? '#cc1016' : '#057642',
      border: `1px solid ${type === 'error' ? '#cc1016' : '#057642'}`,
      transition: 'opacity 300ms', opacity: '0',
    });
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.style.opacity = '1');
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }

})();
