// Background service worker — thin orchestrator.
//
// Audio lives in the offscreen document (MV3 service workers cannot host
// an AudioContext reliably). This worker only:
//   - creates / destroys the offscreen document,
//   - relays start/stop from the popup,
//   - relays translation PCM to the page (content script → MAIN world),
//   - relays transcripts to the subtitle overlay.
const OFFSCREEN_URL = 'offscreen.html';
const MEETING_HOSTS = ['https://app.zoom.us/*', 'https://teams.live.com/*', 'https://teams.microsoft.com/*'];

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Mix translated meeting audio and play it to the user.',
  });
}

chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type === 'start') {
    await ensureOffscreen();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      chrome.runtime.sendMessage({ type: 'error', message: 'No active tab to capture.' });
      return;
    }
    await chrome.storage.local.set({ running: true });
    chrome.runtime.sendMessage({
      type: 'start',
      tabId: tab.id,
      provider: msg.provider || 'openai',
      apiKey: msg.apiKey,
      duckLevel: msg.duckLevel,
      from: msg.from || 'en',
      to: msg.to || 'vi',
    });
  }
  if (msg.type === 'stop') {
    await chrome.storage.local.set({ running: false });
    chrome.runtime.sendMessage({ type: 'stop' });
  }
  // Live duck retune from the popup slider; the mixer clamps nothing —
  // the popup only offers 10–40% and the default stays 0.20.
  if (msg.type === 'duck') {
    chrome.runtime.sendMessage({ type: 'duck', duckLevel: msg.duckLevel });
  }
  // An engine error ends the session: clear the running flag so the
  // popup reopens in the stopped state.
  if (msg.type === 'error') {
    await chrome.storage.local.set({ running: false });
  }
  // Relayed from the offscreen document to the meeting tab's content scripts.
  if (msg.type === 'translation-audio' || msg.type === 'subtitle') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  // Make sure the MAIN-world virtual mic + the subtitle overlay are
  // injected into meeting tabs (manifest content_scripts cover page load;
  // this covers tabs already open at install time).
  chrome.tabs.query({ url: MEETING_HOSTS }, (tabs) => {
    for (const tab of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/virtual-mic.js'],
        world: 'MAIN',
      }).catch(() => {});
    }
  });
});
