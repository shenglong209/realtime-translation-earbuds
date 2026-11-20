// Popup UI: API key, language pair, duck level, start/stop.
//
// The key is stored in chrome.storage.local only. It is never sent
// anywhere except api.openai.com (to mint an ephemeral Realtime key).
// The language pair is sent to the offscreen engine on start and
// persisted so the popup reopens with the last choice; the duck slider
// also updates the live mixer while a session is running.
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setRunningUI(running) {
  $('start').disabled = running;
  $('stop').disabled = !running;
  if (running) statusEl.textContent = 'Translating… join the meeting from your browser.';
}

function pairParts() {
  const [from, to] = $('pair').value.split('-');
  return { from, to };
}

chrome.storage.local.get(['apiKey', 'pair', 'duckLevel', 'running'], (saved) => {
  if (saved.apiKey) $('key').value = saved.apiKey;
  if (saved.pair) $('pair').value = saved.pair;
  if (saved.duckLevel) {
    $('duck').value = saved.duckLevel * 100;
    $('duckVal').textContent = `${Math.round(saved.duckLevel * 100)}%`;
  }
  if (saved.running) setRunningUI(true);
});

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
  if (!apiKey.startsWith('sk-')) {
    statusEl.textContent = 'Paste a valid OpenAI API key first.';
    return;
  }
  const duckLevel = Number($('duck').value) / 100;
  const { from, to } = pairParts();
  await chrome.storage.local.set({ apiKey, pair: $('pair').value, duckLevel });
  chrome.runtime.sendMessage({ type: 'start', apiKey, duckLevel, from, to }, () => {
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
