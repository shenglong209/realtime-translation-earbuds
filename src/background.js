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
    // USER_MEDIA is required for getUserMedia in the offscreen document
    // (tab audio redemption + the real mic); AUDIO_PLAYBACK for playback.
    reasons: ['AUDIO_PLAYBACK', 'USER_MEDIA'],
    justification: 'Capture the meeting tab audio and the mic, mix translated meeting audio and play it to the user.',
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
    // chrome.tabCapture is unavailable in the offscreen document, so the
    // stream ID must be obtained here in the service worker (in response
    // to the popup's Start click) and redeemed by the offscreen document
    // with getUserMedia. The ID is single-use and expires within seconds.
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'error', message: `Could not capture this tab: ${e?.message || e}` });
      return;
    }
    if (!streamId) {
      chrome.runtime.sendMessage({ type: 'error', message: 'Could not capture this tab: no stream id.' });
      return;
    }
    await chrome.storage.local.set({ running: true });
    chrome.runtime.sendMessage({
      type: 'start',
      streamId,
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
