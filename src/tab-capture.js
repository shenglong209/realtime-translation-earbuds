// Tab audio capture (MV3).
//
// chrome.tabCapture cannot be called from the offscreen document — in MV3
// it is only available in the background service worker, so calling
// chrome.tabCapture.capture() there throws:
//   TypeError: Cannot read properties of undefined (reading 'capture')
// The worker obtains a short-lived stream ID with
// chrome.tabCapture.getMediaStreamId() and the offscreen document redeems
// it here with getUserMedia. The ID is single-use and expires within
// seconds, so it must be redeemed immediately after the worker sends it.
// Since Chrome 116 an ID obtained in a service worker can be used in an
// offscreen document of the same extension.
export async function captureTabAudio(streamId) {
  if (!streamId) throw new Error('No tab stream id');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });
  return stream;
}
