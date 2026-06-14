// Load saved server URL
chrome.storage.sync.get(['serverUrl'], (data) => {
  document.getElementById('serverUrl').value = data.serverUrl || 'http://127.0.0.1:8010';
});

// Save
document.getElementById('saveBtn').addEventListener('click', () => {
  const serverUrl = document.getElementById('serverUrl').value.trim().replace(/\/+$/, '');
  if (!serverUrl) { showToast('Server URL is required', 'error'); return; }
  chrome.storage.sync.set({ serverUrl }, () => showToast('Settings saved!', 'success'));
});

// Test connection
document.getElementById('testBtn').addEventListener('click', async () => {
  document.getElementById('saveBtn').click();
  const serverUrl = document.getElementById('serverUrl').value.trim().replace(/\/+$/, '');
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  try {
    const res = await fetch(`${serverUrl}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status === 'ok') {
      dot.className = 'dot ok';
      const azureOk = data.azure_openai_configured || data.azure_configured;
      const emailOk = data.email_configured;
      const version = data.version ? ` v${data.version}` : '';
      const parts = [];
      if (azureOk) parts.push('Azure OK');
      if (emailOk) parts.push('Email OK');
      if (!azureOk) parts.push('Azure not configured');
      text.textContent = `Connected${version} — ${parts.join(' · ')}`;
      showToast(azureOk ? `Connected${version}` : 'Server ok but check .env', azureOk ? 'success' : 'error');
    }
  } catch (e) {
    dot.className = 'dot err';
    text.textContent = 'Cannot reach server — is it running?';
    showToast('Cannot reach server', 'error');
  }
});

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  setTimeout(() => { t.className = 'toast'; }, 3000);
}

// ── Email Notification Preferences ───────────────────────────────────────────

const emailEnabled  = document.getElementById('emailEnabled');
const eventsSection = document.getElementById('emailEventsSection');
const saveNotifBtn  = document.getElementById('saveNotifBtn');
const notifStatus   = document.getElementById('notifStatus');

// Show/hide event checkboxes based on master toggle
emailEnabled.addEventListener('change', () => {
  eventsSection.style.display = emailEnabled.checked ? 'block' : 'none';
});

// Load saved prefs from backend on open
(async () => {
  const { serverUrl, authToken } = await chrome.storage.sync.get(['serverUrl', 'authToken']);
  if (!serverUrl || !authToken) return;
  try {
    const res = await fetch(`${serverUrl}/notifications/prefs`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (!res.ok) return;
    const { prefs } = await res.json();
    if (!prefs) return;

    emailEnabled.checked = !!prefs.email_enabled;
    eventsSection.style.display = prefs.email_enabled ? 'block' : 'none';

    const enabledEvents = prefs.events || [];
    document.querySelectorAll('.event-check').forEach(cb => {
      cb.checked = enabledEvents.includes(cb.dataset.event);
    });
  } catch (_) { /* backend may not be running */ }
})();

// ── Self-service data deletion (GDPR) ────────────────────────────────────────

const deleteConfirm = document.getElementById('deleteConfirm');
const deleteDataBtn = document.getElementById('deleteDataBtn');

// Arm the button only when the user types the exact confirmation word.
deleteConfirm.addEventListener('input', () => {
  deleteDataBtn.disabled = deleteConfirm.value.trim() !== 'DELETE';
});

deleteDataBtn.addEventListener('click', async () => {
  if (deleteConfirm.value.trim() !== 'DELETE') return;
  if (!confirm('This permanently deletes your account and all your data. This cannot be undone. Continue?')) return;

  const { serverUrl, authToken } = await chrome.storage.sync.get(['serverUrl', 'authToken']);
  if (!serverUrl || !authToken) {
    showToast('Please sign in first.', 'error');
    return;
  }

  deleteDataBtn.disabled = true;
  deleteDataBtn.textContent = 'Deleting…';
  try {
    const res = await fetch(`${serverUrl}/api/users/me`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Account is gone — wipe all local auth/session state and sign out.
    await chrome.storage.sync.remove(['authToken', 'notifEmail', 'notifEvents']);
    await chrome.storage.local.clear();

    showToast('Your account and all data were deleted.', 'success');
    deleteDataBtn.textContent = 'Deleted';
    deleteConfirm.value = '';
    setTimeout(() => { window.close(); }, 2500);
  } catch (e) {
    showToast('Could not delete — check your server connection and that you are signed in.', 'error');
    deleteDataBtn.textContent = 'Delete my account and all data';
    deleteDataBtn.disabled = false;
  }
});

// Save prefs to backend
saveNotifBtn.addEventListener('click', async () => {
  const { serverUrl, authToken } = await chrome.storage.sync.get(['serverUrl', 'authToken']);
  if (!serverUrl || !authToken) {
    showToast('Please save your server URL and sign in first.', 'error');
    return;
  }

  const events = [...document.querySelectorAll('.event-check')]
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.event);

  try {
    const res = await fetch(`${serverUrl}/notifications/prefs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ email_enabled: emailEnabled.checked, events }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Also save to chrome.storage.sync so background.js can read it instantly
    await chrome.storage.sync.set({
      notifEmail: emailEnabled.checked,
      notifEvents: events,
    });

    notifStatus.style.display = 'inline';
    setTimeout(() => { notifStatus.style.display = 'none'; }, 3000);
    showToast('Notification settings saved!', 'success');
  } catch (e) {
    showToast('Could not save — check server connection.', 'error');
  }
});