// Offscreen document — the audio engine.
//
// MV3 service workers cannot reliably host an AudioContext, so all audio
// lives here: tab capture → provider session (OpenAI Realtime /
// Gemini Live) → DuckingMixer → earbuds,
// plus PCM forwarding to the page's virtual mic and transcripts to the
// subtitle overlay.
//
// Message protocol (from the service worker):
//   { type: 'start', streamId, provider, apiKey, duckLevel, from, to }
//   { type: 'stop' }
// streamId comes from chrome.tabCapture.getMediaStreamId() in the service
// worker (tabCapture is unavailable in the offscreen document).
// provider is 'openai' (default) or 'gemini'; the offscreen engine picks
// the session class by provider — both share the same interface, so the
// mixer, virtual mic and subtitle plumbing below stay provider-agnostic.
// Messages out (to the service worker, relayed to the page):
//   { type: 'translation-audio', pcm: ArrayBuffer }  → MAIN-world virtual mic
//   { type: 'subtitle', original, translation }      → subtitle overlay
import { captureTabAudio } from './tab-capture.js';
import { DuckingMixer } from './ducking.js';
import { RealtimeSession, pcm16ToBase64 } from './realtime.js';
import { GeminiLiveSession } from './gemini-live.js';

let ctx = null;
let mixer = null;
let session = null;
let tabStream = null;
let micStream = null;
let running = false;

// The translated audio plays through the mixer AND is forwarded to the
// virtual mic. Both sinks share one MediaStream built from an
// AudioContext destination.
let playCtx = null;
let playDest = null;

function pcmToAudioBuffer(pcm, sampleRate) {
  const buf = playCtx.createBuffer(1, pcm.length, sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  return buf;
}

async function start({ streamId, provider = 'openai', apiKey, duckLevel, from = 'en', to = 'vi' }) {
  if (running) return;
  running = true;
  try {
    ctx = new AudioContext();
    playCtx = ctx;
    playDest = ctx.createMediaStreamDestination();

    mixer = new DuckingMixer(ctx, { duckLevel });
    tabStream = await captureTabAudio(streamId);
    mixer.connectOriginal(tabStream);
    mixer.connectTranslation(playDest.stream);
    mixer.start();

    // The user's real mic goes to the session (what they say back).
    // Never the virtual mic itself — that would be a feedback loop.
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Provider swap: GeminiLiveSession shares RealtimeSession's interface,
    // so only the class changes — the audio plumbing stays the same.
    // inputSampleRate is the rate the tab-audio chunks are sent at (the
    // AudioContext's rate); Gemini downsamples it to 16 kHz internally,
    // OpenAI ignores the extra option.
    const SessionClass = provider === 'gemini' ? GeminiLiveSession : RealtimeSession;
    session = new SessionClass({
      apiKey,
      inputSampleRate: ctx.sampleRate,
      from,
      to,
      onAudio: (pcm, sampleRate) => {
        if (!pcm) return;
        // 1. Play through the mixer (ducking applies on the original).
        const src = ctx.createBufferSource();
        src.buffer = pcmToAudioBuffer(pcm, sampleRate);
        src.connect(playDest);
        src.start();
        // 2. Forward raw PCM to the page's virtual mic (MAIN world).
        chrome.runtime.sendMessage({
          type: 'translation-audio',
          pcm: pcm.buffer.slice(0),
        });
      },
      onTranscript: ({ original, translation }) => {
        chrome.runtime.sendMessage({ type: 'subtitle', original, translation });
      },
      onError: (e) => chrome.runtime.sendMessage({ type: 'error', message: String(e?.message || e) }),
    });
    await session.connect();

    // Stream the tab audio into the session: MediaStream → AudioWorklet would
    // be ideal; ScriptProcessor is deprecated but universally available, and
    // this is a prototype path. 16 kHz mono PCM16 chunks.
    const tabSource = ctx.createMediaStreamSource(tabStream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const resample = ctx.createGain();
    tabSource.connect(processor);
    processor.connect(resample); // keep the node alive; output discarded
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        pcm[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
      }
      session.sendAudioPcm16(pcm16ToBase64(pcm));
    };
  } catch (e) {
    // A failed start must not leave `running` stuck true: the popup would
    // show Stopped while Start stays a no-op until Stop is pressed.
    // stop() resets the flag and releases any half-built audio resources.
    stop();
    throw e;
  }
}

function stop() {
  running = false;
  try { session?.close(); } catch { /* ignore */ }
  try { mixer?.destroy(); } catch { /* ignore */ }
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  ctx?.close().catch(() => {});
  session = null;
  mixer = null;
  ctx = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'start') start(msg).catch((e) => chrome.runtime.sendMessage({ type: 'error', message: String(e?.message || e) }));
  if (msg.type === 'stop') stop();
  if (msg.type === 'duck' && mixer) mixer.setDuckLevel(msg.duckLevel);
});
