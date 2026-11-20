// Gemini Live Translate session — free-tier alternative to OpenAI Realtime.
//
// Same interface as RealtimeSession (src/realtime.js) so the offscreen engine
// can swap providers without changing the audio plumbing:
//   new GeminiLiveSession({ apiKey, model, from, to, onAudio, onTranscript, onError })
//   await session.connect()
//   session.sendAudioPcm16(base64Pcm16)
//   session.close()
//
// Protocol (Gemini Live API, v1beta, WebSocket — verified against
// https://ai.google.dev/gemini-api/docs/live-guide and
// https://ai.google.dev/api/live on 2026-11-20):
//   WSS /ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
//   Auth: API key in the URL (?key=...), the documented browser flow — the
//   @google/genai SDK does the same. (An ephemeral-token endpoint exists,
//   POST /v1beta/auth_tokens; not used in v1.)
//   First message: {"setup": {...}} — wait for setupComplete before audio.
//   Audio in: {"realtimeInput": {"audio": {"mimeType": "audio/pcm;rate=16000",
//   "data": base64}}} — input is downsampled to 16 kHz inside this module.
//   Audio out: serverContent.modelTurn.parts[].inlineData.data (24 kHz PCM16).
//   Transcripts: serverContent.inputTranscription / outputTranscription (.text).
//   Model: gemini-3.8-live (stable default). thinkingLevel and
//   enable_affective_dialog are NOT supported on this model — omitted.
//   Session limits: audio-only ~15 min without compression, connection ~10 min.
//   Mitigation: contextWindowCompression slidingWindow + sessionResumption;
//   one auto-reconnect with the saved handle on unexpected close.
//   If setup ever rejects the compression/resumption fields, remove them —
//   the live test will tell.
import { base64ToPcm16, pcm16ToBase64 } from './realtime.js';

const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const OUTPUT_SAMPLE_RATE = 24000;
const INPUT_TARGET_RATE = 16000;
const CONNECT_TIMEOUT_MS = 15000;
// WebSocket.OPEN is 1. Referenced by number on purpose: unit tests run under
// Node 20 (CI), which has no global WebSocket — only the browser runtime does.
const WS_OPEN = 1;

// Pure: build the first (setup) message. Exported for unit tests.
export function buildSetupMessage({ model, from, to, voice, resumeHandle }) {
  const setup = {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
    systemInstruction: {
      parts: [{
        text:
          `Translate everything you hear from ${from} to ${to}. ` +
          'Speak only the translation. Do not explain, do not add commentary.',
      }],
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  };
  return { setup };
}

// Pure: resample PCM16 from inputRate down to 16 kHz (linear interpolation).
// Exact decimation when the ratio is an integer (48 kHz -> every 3rd sample).
export function resamplePcm16To16k(pcm, inputRate) {
  if (inputRate === INPUT_TARGET_RATE) return pcm;
  const ratio = inputRate / INPUT_TARGET_RATE;
  const outLen = Math.floor(pcm.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, pcm.length - 1);
    const frac = pos - lo;
    out[i] = Math.round(pcm[lo] * (1 - frac) + pcm[hi] * frac);
  }
  return out;
}

export class GeminiLiveSession {
  constructor({
    apiKey,
    model = 'gemini-3.8-live',
    from = 'en',
    to = 'vi',
    voice = 'Kore',
    inputSampleRate = 48000,
    onAudio, // (pcm16: Int16Array, sampleRate) => void
    onTranscript, // ({ original, translation }) => void
    onError,
  }) {
    this.apiKey = apiKey;
    this.model = model;
    this.from = from;
    this.to = to;
    this.voice = voice;
    this.inputSampleRate = inputSampleRate;
    this.onAudio = onAudio;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.ws = null;
    this._original = '';
    this._translation = '';
    this._setupComplete = false;
    this._pendingAudio = []; // base64 16 kHz chunks sent before setupComplete
    this._connectResolve = null;
    this._connectReject = null;
    this._connectTimer = null;
    this._closed = false;
    this._resumeHandle = null;
    this._retried = false;
  }

  _sendSetup() {
    this.ws.send(JSON.stringify(buildSetupMessage({
      model: this.model,
      from: this.from,
      to: this.to,
      voice: this.voice,
      resumeHandle: this._resumeHandle,
    })));
  }

  connect() {
    return new Promise((resolve, reject) => {
      this._closed = false;
      this._connectResolve = resolve;
      this._connectReject = reject;
      this._connectTimer = setTimeout(() => {
        if (this._connectReject) {
          this._connectReject(new Error('Gemini Live connect timed out (no setupComplete)'));
          this._connectResolve = null;
          this._connectReject = null;
        }
      }, CONNECT_TIMEOUT_MS);
      this._openSocket();
    });
  }

  _openSocket() {
    const url = `${LIVE_URL}?key=${encodeURIComponent(this.apiKey)}`;
    this.ws = new WebSocket(url);
    this._setupComplete = false;
    this.ws.onopen = () => this._sendSetup();
    this.ws.onmessage = (event) => this._handle(JSON.parse(event.data));
    this.ws.onerror = (e) => {
      if (this._connectReject) {
        clearTimeout(this._connectTimer);
        this._connectReject(new Error('Gemini Live WebSocket error'));
        this._connectResolve = null;
        this._connectReject = null;
      }
      this.onError?.(e instanceof Error ? e : new Error('Gemini Live WebSocket error'));
    };
    this.ws.onclose = () => {
      // A close before setupComplete fails the pending connect().
      if (this._connectReject) {
        clearTimeout(this._connectTimer);
        this._connectReject(new Error('Gemini Live closed before setupComplete'));
        this._connectResolve = null;
        this._connectReject = null;
        return;
      }
      if (this._closed) {
        this.onAudio?.(null, 0);
        return;
      }
      // Unexpected drop mid-session: one auto-reconnect with the saved
      // resumption handle (covers the ~10 min connection / ~15 min session
      // limits). After that, report the end like the OpenAI session does.
      if (!this._retried && this._resumeHandle) {
        this._retried = true;
        setTimeout(() => { if (!this._closed) this._openSocket(); }, 1000);
        return;
      }
      this.onAudio?.(null, 0);
    };
  }

  _handle(msg) {
    if (msg.setupComplete) {
      this._setupComplete = true;
      this._retried = false;
      const queued = this._pendingAudio;
      this._pendingAudio = [];
      for (const audio of queued) this._sendAudioChunk(audio);
      if (this._connectResolve) {
        clearTimeout(this._connectTimer);
        this._connectResolve();
        this._connectResolve = null;
        this._connectReject = null;
      }
      return;
    }
    if (msg.sessionResumptionUpdate?.newHandle) {
      this._resumeHandle = msg.sessionResumptionUpdate.newHandle;
      return;
    }
    if (msg.error) {
      const err = new Error(msg.error.message || 'Gemini Live error');
      if (this._connectReject) {
        clearTimeout(this._connectTimer);
        this._connectReject(err);
        this._connectResolve = null;
        this._connectReject = null;
      }
      this.onError?.(err);
      return;
    }
    const content = msg.serverContent;
    if (!content) return;
    // One event can carry several parts — process all of them.
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.onAudio?.(base64ToPcm16(part.inlineData.data), OUTPUT_SAMPLE_RATE);
      }
    }
    if (content.inputTranscription?.text) {
      this._original = content.inputTranscription.text;
      this.onTranscript?.({ original: this._original, translation: this._translation });
    }
    if (content.interimInputTranscription?.text) {
      this._original = content.interimInputTranscription.text;
      this.onTranscript?.({ original: this._original, translation: this._translation });
    }
    if (content.outputTranscription?.text) {
      this._translation = content.outputTranscription.text;
      this.onTranscript?.({ original: this._original, translation: this._translation });
    }
    if (content.interrupted) {
      this._original = '';
      this._translation = '';
    }
    if (content.turnComplete) {
      this._original = '';
      this._translation = '';
    }
  }

  _sendAudioChunk(base64) {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify({
        realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: base64 } },
      }));
    }
  }

  sendAudioPcm16(base64) {
    const pcm16 = resamplePcm16To16k(base64ToPcm16(base64), this.inputSampleRate);
    const chunk = pcm16ToBase64(pcm16);
    if (!this._setupComplete) {
      this._pendingAudio.push(chunk);
      return;
    }
    this._sendAudioChunk(chunk);
  }

  close() {
    this._closed = true;
    clearTimeout(this._connectTimer);
    this._connectResolve = null;
    this._connectReject = null;
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}
