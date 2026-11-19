// Virtual mic — in-page only. MUST run in the MAIN world (see manifest:
// content_scripts entry with "world": "MAIN"), so it patches the page's
// OWN navigator.mediaDevices. A content script's isolated world cannot do
// this — that is the detail most implementations get wrong.
//
// Why in-page: a Chrome extension cannot install a system virtual audio
// device. That needs a driver, which a locked-down meeting laptop forbids.
// So the mic never exists in the OS. It exists only inside the meeting
// tab: the meeting app sees a fake device in its own mic dropdown, picks
// it, and its RTCPeerConnection receives the translated track as input.
//
// Boundary: web meetings only (Zoom web app.zoom.us, Teams web
// teams.live.com / teams.microsoft.com). Never the desktop app, never OS
// sound settings. Never select this mic as the extension's own input
// (feedback loop).
//
// How the audio gets here: the service worker receives PCM16 frames from
// the Realtime session and forwards them to this page via window messages
// (type: 'translation-audio', ArrayBuffer PCM16, 24 kHz mono). This script
// writes them into a MediaStreamTrackGenerator as AudioData. If the
// generator API is unavailable, it falls back to a MediaStreamDestination
// fed by AudioBufferSourceNodes.
(() => {
  const DEVICE_ID = 'translation-virtual-mic';
  const DEVICE_LABEL = 'Virtual Microphone';
  const SAMPLE_RATE = 24000; // OpenAI Realtime PCM16 output rate

  let generator = null;
  let writer = null;
  let virtualTrack = null;
  let fallbackCtx = null;
  let fallbackDest = null;
  let patched = false;

  const origEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  function fakeDeviceInfo() {
    // Plain object with the same fields apps read; MediaDeviceInfo itself
    // cannot be constructed.
    return { deviceId: DEVICE_ID, kind: 'audioinput', label: DEVICE_LABEL, groupId: 'translation' };
  }

  async function ensureGenerator() {
    if (virtualTrack) return virtualTrack;
    if ('MediaStreamTrackGenerator' in window) {
      generator = new MediaStreamTrackGenerator({ kind: 'audio' });
      virtualTrack = generator;
      writer = generator.writable.getWriter();
    } else {
      // Fallback: MediaStreamDestination track, fed from PCM chunks.
      fallbackCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      fallbackDest = fallbackCtx.createMediaStreamDestination();
      virtualTrack = fallbackDest.stream.getAudioTracks()[0];
    }
    return virtualTrack;
  }

  async function writePcm(pcm16) {
    if (!virtualTrack) return;
    if (writer) {
      const data = new AudioData({
        format: 's16',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: pcm16.length,
        numberOfChannels: 1,
        timestamp: 0,
        data: pcm16,
      });
      await writer.write(data);
      data.close();
    } else if (fallbackCtx) {
      const buf = fallbackCtx.createBuffer(1, pcm16.length, SAMPLE_RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm16.length; i++) ch[i] = pcm16[i] / 32768;
      const src = fallbackCtx.createBufferSource();
      src.buffer = buf;
      src.connect(fallbackDest);
      src.start();
    }
  }

  function patchDeviceApis() {
    if (patched) return;
    navigator.mediaDevices.enumerateDevices = async () => {
      const devices = await origEnumerateDevices();
      return [...devices, fakeDeviceInfo()];
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const audio = constraints && constraints.audio;
      const wanted =
        audio === true
          ? false // generic request: leave the real mic alone
          : audio && (audio.deviceId === DEVICE_ID || audio.deviceId?.exact === DEVICE_ID);
      if (wanted && virtualTrack) {
        return new MediaStream([virtualTrack]);
      }
      return origGetUserMedia(constraints);
    };
    patched = true;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== 'translation-audio') return;
    writePcm(new Int16Array(event.data.pcm));
  });

  window.__translationMic = {
    async start() {
      await ensureGenerator();
      patchDeviceApis();
      return { deviceId: DEVICE_ID, label: DEVICE_LABEL };
    },
    stop() {
      if (writer) writer.close().catch(() => {});
      if (fallbackCtx) fallbackCtx.close().catch(() => {});
      writer = null;
      generator = null;
      virtualTrack = null;
    },
    isActive() {
      return !!virtualTrack;
    },
  };
})();
