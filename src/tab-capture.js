// Tab audio capture.
//
// chrome.tabCapture captures the meeting tab's audio. No admin rights:
// Chrome extensions install per-user, and tabCapture works on any tab the
// user picks. The meeting must run in the browser — decline the desktop
// app, click "Join from your browser". If a meeting has no browser join
// option, this route is dead for that meeting.
export async function captureTabAudio(tabId) {
  const stream = await new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: true, video: false }, (captured) => {
      const err = chrome.runtime.lastError;
      if (err || !captured) {
        reject(new Error(err ? err.message : 'tabCapture returned no stream'));
      } else {
        resolve(captured);
      }
    });
  });
  return stream;
}

export async function captureActiveTabAudio() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return captureTabAudio(tab.id);
}
