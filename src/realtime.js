// OpenAI Realtime Translate session.
//
// Speech-to-speech in one call: audio in → translated audio out. STT,
// translation and TTS all run server-side — the extension is a thin client.
//
// Auth: the API key (entered in the popup, stored in chrome.storage, never
// committed) mints an ephemeral client key via
// POST /v1/realtime/sessions. The WebSocket then connects with that
// ephemeral key passed as a subprotocol — the documented browser flow,
// since a browser WebSocket cannot set Authorization headers.
const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

export class RealtimeSession {
  constructor({
    apiKey,
    model = 'gpt-realtime',
    from = 'en',
    to = 'vi',
    voice = 'alloy',
    onAudio, // (pcm16: Int16Array, sampleRate) => void
    onTranscript, // ({ original, translation }) => void
    onError,
  }) {
    this.apiKey = apiKey;
    this.model = model;
    this.from = from;
    this.to = to;
    this.voice = voice;
    this.onAudio = onAudio;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.ws = null;
    this._original = '';
    this._translation = '';
  }

  async _mintEphemeralKey() {
    const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, voice: this.voice }),
    });
    if (!res.ok) throw new Error(`Realtime session mint failed: ${res.status}`);
    const data = await res.json();
    return data.client_secret.value;
  }

  async connect() {
    const ephemeralKey = await this._mintEphemeralKey();
    const url = `${REALTIME_URL}?model=${encodeURIComponent(this.model)}`;
    this.ws = new WebSocket(url, [
      'realtime',
      `openai-insecure-api-key.${ephemeralKey}`,
      'openai-beta.realtime-v1',
    ]);
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions:
            `Translate everything you hear from ${this.from} to ${this.to}. ` +
            'Speak only the translation. Do not explain, do not add commentary.',
          voice: this.voice,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'gpt-4o-transcribe' },
          turn_detection: { type: 'server_vad' },
        },
      }));
    };
    this.ws.onmessage = (event) => this._handle(JSON.parse(event.data));
    this.ws.onerror = (e) => this.onError?.(e);
    this.ws.onclose = () => this.onAudio?.(null, 0);
  }

  _handle(msg) {
    switch (msg.type) {
      case 'response.audio.delta':
        this.onAudio?.(base64ToPcm16(msg.delta), 24000);
        break;
      case 'response.audio_transcript.delta':
        this._translation += msg.delta || '';
        this.onTranscript?.({ original: this._original, translation: this._translation });
        break;
      case 'response.audio_transcript.done':
        this._translation = msg.transcript || this._translation;
        this.onTranscript?.({ original: this._original, translation: this._translation });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this._original = msg.transcript || '';
        this.onTranscript?.({ original: this._original, translation: this._translation });
        break;
      case 'response.done':
        this._original = '';
        this._translation = '';
        break;
      case 'error':
        this.onError?.(new Error(msg.error?.message || 'Realtime error'));
        break;
      default:
        break;
    }
  }

  sendAudioPcm16(base64) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
    }
  }

  close() {
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}

export function base64ToPcm16(base64) {
  const bin = atob(base64);
  const out = new Int16Array(bin.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
  }
  return out;
}

export function pcm16ToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
