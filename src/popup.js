// Popup UI: API key, language pair, duck level, start/stop.
// The key is stored in chrome.storage.local only. It is never sent
// anywhere except api.openai.com (to mint an ephemeral Realtime key).
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

chrome.storage.local.get(['apiKey', 'duckLevel'], (saved) => {
  if (saved.apiKey) $('key').value = saved.apiKey;
  if (saved.duckLevel) {
    $('duck').value = saved.duckLevel * 100;
    $('duckVal').textContent = `${Math.round(saved.duckLevel * 100)}%`;
  }
});

$('duck').addEventListener('input', () => {
  $('duckVal').textContent = `${$('duck').value}%`;
});

$('start').addEventListener('click', async () => {
  const apiKey = $('key').value.trim();
  if (!apiKey.startsWith('sk-')) {
    statusEl.textContent = 'Paste a valid OpenAI API key first.';
    return;
  }
  const duckLevel = Number($('duck').value) / 100;
  await chrome.storage.local.set({ apiKey, duckLevel });
  chrome.runtime.sendMessage({ type: 'start', apiKey, duckLevel });
  $('start').disabled = true;
  $('stop').disabled = false;
  statusEl.textContent = 'Translating… join the meeting from your browser.';
});

$('stop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop' });
  $('start').disabled = false;
  $('stop').disabled = true;
  statusEl.textContent = 'Stopped.';
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'error') statusEl.textContent = `Error: ${msg.message}`;
});
