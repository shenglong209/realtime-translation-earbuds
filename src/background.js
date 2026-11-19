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
    chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, apiKey: msg.apiKey, duckLevel: msg.duckLevel });
  }
  if (msg.type === 'stop') {
    chrome.runtime.sendMessage({ type: 'stop' });
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
