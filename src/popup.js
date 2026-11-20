// Popup UI: provider, per-provider API keys, language pair, duck level, start/stop.
//
// The provider (OpenAI / Gemini) and each provider's key are stored in
// chrome.storage.local only, one slot per provider so switching providers
// never loses a key. Keys are never sent anywhere except their own
// provider's API (OpenAI: api.openai.com to mint an ephemeral Realtime
// key; Gemini: generativelanguage.googleapis.com).
// The language pair is sent to the offscreen engine on start and
// persisted so the popup reopens with the last choice; the duck slider
// also updates the live mixer while a session is running.
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

const PROVIDERS = {
  openai: {
    label: 'OpenAI API key (stored locally only)',
    placeholder: 'sk-...',
    hint: 'Get a key at platform.openai.com.',
    keyField: 'apiKey',
    validate: (key) => (key.startsWith('sk-') ? null : 'Paste a valid OpenAI API key first.'),
  },
  gemini: {
    label: 'Gemini API key (stored locally only)',
    placeholder: 'AIza...',
    hint: 'Free key at Google AI Studio (aistudio.google.com).',
    keyField: 'geminiApiKey',
    validate: (key) => {
      if (!key) return 'Paste your Gemini API key first.';
      if (key.startsWith('sk-')) return 'That looks like an OpenAI key — paste your Gemini (AI Studio) key instead.';
      return null;
    },
  },
};
let provider = 'openai';
const keys = { openai: '', gemini: '' };

function setRunningUI(running) {
  $('start').disabled = running;
  $('stop').disabled = !running;
  if (running) statusEl.textContent = 'Translating… join the meeting from your browser.';
}

function pairParts() {
  const [from, to] = $('pair').value.split('-');
  return { from, to };
}

// Show the active provider's label, placeholder, hint and stored key.
function applyProvider() {
  const p = PROVIDERS[provider];
  $('provider').value = provider;
  $('keyLabel').textContent = p.label;
  $('key').placeholder = p.placeholder;
  $('key').value = keys[provider];
  $('keyHint').textContent = p.hint;
}

// Persist the key currently in the field under the active provider's slot.
function saveCurrentKey() {
  keys[provider] = $('key').value.trim();
  chrome.storage.local.set({ [PROVIDERS[provider].keyField]: keys[provider] });
}

chrome.storage.local.get(['provider', 'apiKey', 'geminiApiKey', 'pair', 'duckLevel', 'running'], (saved) => {
  if (saved.provider && PROVIDERS[saved.provider]) provider = saved.provider;
  if (saved.apiKey) keys.openai = saved.apiKey;
  if (saved.geminiApiKey) keys.gemini = saved.geminiApiKey;
  applyProvider();
  if (saved.pair) $('pair').value = saved.pair;
  if (saved.duckLevel) {
    $('duck').value = saved.duckLevel * 100;
    $('duckVal').textContent = `${Math.round(saved.duckLevel * 100)}%`;
  }
  if (saved.running) setRunningUI(true);
});

$('provider').addEventListener('change', () => {
  saveCurrentKey();
  provider = $('provider').value;
  applyProvider();
  chrome.storage.local.set({ provider });
});

$('key').addEventListener('change', saveCurrentKey);

$('pair').addEventListener('change', () => {
  chrome.storage.local.set({ pair: $('pair').value });
});

$('duck').addEventListener('input', () => {
  const duckLevel = Number($('duck').value) / 100;
  $('duckVal').textContent = `${$('duck').value}%`;
  chrome.storage.local.set({ duckLevel });
  // Live update: if a session is running, retune the mixer without restart.
  if (!$('stop').disabled) {
    chrome.runtime.sendMessage({ type: 'duck', duckLevel }, () => {
      if (chrome.runtime.lastError) { /* background asleep; applied on next start */ }
    });
  }
});

$('start').addEventListener('click', async () => {
  const apiKey = $('key').value.trim();
  const err = PROVIDERS[provider].validate(apiKey);
  if (err) {
    statusEl.textContent = err;
    return;
  }
  const duckLevel = Number($('duck').value) / 100;
  const { from, to } = pairParts();
  keys[provider] = apiKey;
  await chrome.storage.local.set({
    provider,
    apiKey: keys.openai,
    geminiApiKey: keys.gemini,
    pair: $('pair').value,
    duckLevel,
  });
  chrome.runtime.sendMessage({ type: 'start', provider, apiKey, duckLevel, from, to }, () => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = `Error: ${chrome.runtime.lastError.message}`;
      return;
    }
    setRunningUI(true);
  });
});

$('stop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop' }, () => {
    if (chrome.runtime.lastError) { /* background asleep; nothing running */ }
  });
  setRunningUI(false);
  statusEl.textContent = 'Stopped.';
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'error') {
    statusEl.textContent = `Error: ${msg.message}`;
    setRunningUI(false);
  }
});
