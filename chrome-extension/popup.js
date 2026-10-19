// Pi Annotate - Popup Script

const extId = chrome.runtime.id;
const installCmd = `./install.sh ${extId}`;

// Elements
const extIdInput = document.getElementById('ext-id');
const installCmdInput = document.getElementById('install-cmd');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const setupSection = document.getElementById('setup-section');
const readySection = document.getElementById('ready-section');
const troubleSection = document.getElementById('trouble-section');
const browserNameInput = document.getElementById('browser-name');

// Populate fields
extIdInput.value = extId;
installCmdInput.value = installCmd;

// Platform-aware displays
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
// The shortcut hint must report what Chrome ACTUALLY bound, not what the
// manifest suggested. Chrome silently declines a suggested_key it cannot
// assign — on Linux, Ctrl+Shift+P is already Chrome's own "print with system
// dialog" — leaving the command unbound while this popup cheerfully advertised
// it. That combination (dead shortcut, plus a Start button that could not
// render) made the picker unreachable by any route.
const shortcutEl = document.getElementById('shortcut-key');
if (shortcutEl) {
  const fallback = isMac ? '⌘ Shift P' : 'Ctrl+Shift+P';
  shortcutEl.textContent = fallback;
  if (chrome.commands && chrome.commands.getAll) {
    chrome.commands.getAll((commands) => {
      const picker = (commands || []).find((c) => c.name === 'toggle-picker');
      if (picker && picker.shortcut) {
        shortcutEl.textContent = picker.shortcut;
        shortcutEl.title = '';
      } else {
        shortcutEl.textContent = 'No shortcut assigned';
        shortcutEl.title = 'Assign one at chrome://extensions/shortcuts';
      }
    });
  }
}
const quitTipEl = document.getElementById('quit-tip');
if (quitTipEl) {
  // Mac has ⌘Q, Windows/Linux don't have a universal quit shortcut
  quitTipEl.textContent = isMac
    ? 'Fully quit the supported browser (⌘Q) and reopen'
    : 'Fully quit the supported browser (menu → Exit) and reopen';
}

// Copy functionality
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1500);
  }).catch(() => {
    // Fallback: select the input text
    const input = btn.previousElementSibling;
    if (input?.select) {
      input.select();
      btn.textContent = 'Select All';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }
  });
}

document.getElementById('copy-id').addEventListener('click', (e) => {
  copyToClipboard(extId, e.target);
});

document.getElementById('copy-cmd').addEventListener('click', (e) => {
  copyToClipboard(installCmd, e.target);
});

const profileLabelInput = document.getElementById('profile-label');

chrome.runtime.sendMessage({ type: 'GET_BROWSER_IDENTITY' }).then((identity) => {
  if (identity?.name) {
    browserNameInput.value = identity.name;
    browserNameInput.title = `Connection id: ${identity.id}`;
  }
  if (profileLabelInput) {
    profileLabelInput.value = identity?.label || '';
    if (identity?.id) profileLabelInput.title = `Announced as instance ${identity.id}`;
  }
});

// Profile label (Dalinar plan 971): announced to the device rendezvous
// registry so a workspace BROWSER_PROFILE can select this profile once the
// operator approves the claim. Empty clears it (unlabeled).
document.getElementById('save-profile-label')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const result = await chrome.runtime.sendMessage({
    type: 'SET_PROFILE_LABEL',
    label: profileLabelInput.value,
  });
  if (result?.error) {
    setTrouble(result.error);
    return;
  }
  profileLabelInput.value = result.label || '';
  const original = button.textContent;
  button.textContent = 'Saved!';
  button.classList.add('copied');
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('copied');
  }, 1500);
});

document.getElementById('save-browser-name')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const result = await chrome.runtime.sendMessage({
    type: 'SET_BROWSER_NAME',
    name: browserNameInput.value,
  });
  if (result?.error) {
    setTrouble(result.error);
    return;
  }
  browserNameInput.value = result.name;
  browserNameInput.title = `Connection id: ${result.id}`;
  const original = button.textContent;
  button.textContent = 'Saved!';
  button.classList.add('copied');
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('copied');
  }, 1500);
});

// Start annotation button — routes through background script which handles injection
document.getElementById('start-btn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: "TOGGLE_PICKER" });
  window.close();
});

// Retry button
document.getElementById('retry-btn')?.addEventListener('click', () => {
  checkConnection();
});

// Update UI based on connection state.
//
// Sections are shown/hidden by toggling the `hidden` CLASS, never by writing
// an inline style. #ready-section and #trouble-section ship with class="hidden"
// in the markup, and popup.html's rule is `.hidden { display: none !important }`
// — an inline `style.display = 'block'` loses to that !important, so the older
// inline-style version left BOTH sections permanently invisible: the "Start
// Annotation" button never rendered on a healthy connection, and the
// troubleshooting detail never rendered on a broken one.
function show(section, visible) {
  section.classList.toggle('hidden', !visible);
}

function setConnected() {
  statusDot.className = 'status-dot connected';
  statusText.textContent = 'Connected';
  show(setupSection, false);
  show(readySection, true);
  show(troubleSection, false);
}

function setNotInstalled(detail) {
  statusDot.className = 'status-dot';
  statusText.textContent = detail || 'Not installed';
  show(setupSection, true);
  show(readySection, false);
  show(troubleSection, false);
}

function setTrouble(error) {
  statusDot.className = 'status-dot trouble';
  statusText.textContent = 'Connection issue';
  show(setupSection, true);
  show(readySection, false);
  show(troubleSection, true);
  document.getElementById('trouble-detail').textContent = error || 'Unknown error';
}

function setChecking() {
  statusDot.className = 'status-dot checking';
  statusText.textContent = 'Checking...';
  // Reset sections to initial state (setup visible, others hidden)
  show(setupSection, true);
  show(readySection, false);
  show(troubleSection, false);
}

// Check connection through the background service worker.
// Opening a second native port from the popup would spawn a second host process.
async function checkConnection() {
  setChecking();

  try {
    const result = await chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' });
    const error = result?.error || '';

    if (result?.connected) {
      setConnected();
      return;
    }

    if (error.includes('not found')) {
      setNotInstalled('Native host not found');
      return;
    }

    if (error.includes('forbidden')) {
      setNotInstalled('Extension ID mismatch - reinstall native host');
      return;
    }

    setTrouble(error || 'Native host disconnected unexpectedly');
  } catch (err) {
    setTrouble(err instanceof Error ? err.message : String(err));
  }
}

// Check on load
checkConnection();
