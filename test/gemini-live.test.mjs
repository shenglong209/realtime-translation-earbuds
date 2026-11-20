// Unit tests for src/gemini-live.js — no network, no API key.
//
// Run: node test/gemini-live.test.mjs
// Wired into `npm test` (runs before the Puppeteer harness).
import { strict as assert } from 'node:assert';
import { GeminiLiveSession, buildSetupMessage, resamplePcm16To16k } from '../src/gemini-live.js';
import { pcm16ToBase64 } from '../src/realtime.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

function pcmBase64(samples) {
  return pcm16ToBase64(new Int16Array(samples));
}

// --- Setup message -------------------------------------------------------
check('setup: model, modalities, voice, transcriptions, no thinkingLevel', () => {
  const msg = buildSetupMessage({ model: 'gemini-3.8-live', from: 'en', to: 'vi', voice: 'Kore' });
  assert.equal(msg.setup.model, 'models/gemini-3.8-live');
  assert.deepEqual(msg.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(msg.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.ok(msg.setup.systemInstruction.parts[0].text.includes('en'));
  assert.ok(msg.setup.systemInstruction.parts[0].text.includes('vi'));
  assert.ok('inputAudioTranscription' in msg.setup);
  assert.ok('outputAudioTranscription' in msg.setup);
  assert.ok(!JSON.stringify(msg).includes('thinkingLevel'));
  assert.ok(!JSON.stringify(msg).includes('affective'));
});

check('setup: resume handle is passed through when present', () => {
  const msg = buildSetupMessage({ model: 'gemini-3.8-live', from: 'en', to: 'vi', voice: 'Kore', resumeHandle: 'h123' });
  assert.equal(msg.setup.sessionResumption.handle, 'h123');
  const fresh = buildSetupMessage({ model: 'gemini-3.8-live', from: 'en', to: 'vi', voice: 'Kore' });
  assert.deepEqual(fresh.setup.sessionResumption, {});
});

// --- Resampling ----------------------------------------------------------
check('resample: 48 kHz -> 16 kHz is exact decimation', () => {
  const pcm = new Int16Array(4800);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i % 1000) - 500;
  const out = resamplePcm16To16k(pcm, 48000);
  assert.equal(out.length, 1600);
  for (let i = 0; i < out.length; i++) assert.equal(out[i], pcm[i * 3]);
});

check('resample: 44.1 kHz -> 16 kHz produces the right length', () => {
  const pcm = new Int16Array(4410);
  const out = resamplePcm16To16k(pcm, 44100);
  assert.equal(out.length, 1600);
});

check('resample: 16 kHz input is returned unchanged', () => {
  const pcm = new Int16Array([1, -2, 3]);
  assert.equal(resamplePcm16To16k(pcm, 16000), pcm);
});

// --- Server message handling ---------------------------------------------
function makeSession(capture) {
  return new GeminiLiveSession({
    apiKey: 'test-key',
    from: 'en',
    to: 'vi',
    inputSampleRate: 48000,
    onAudio: (pcm, rate) => capture.audio.push({ pcm: Array.from(pcm), rate }),
    onTranscript: (t) => capture.transcripts.push(t),
    onError: (e) => capture.errors.push(String(e?.message || e)),
  });
}

check('handle: modelTurn audio parts reach onAudio at 24 kHz (all parts)', () => {
  const capture = { audio: [], transcripts: [], errors: [] };
  const s = makeSession(capture);
  s._handle({ serverContent: { modelTurn: { parts: [
    { inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmBase64([100, -100, 0]) } },
    { inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmBase64([7]) } },
  ] } } });
  assert.equal(capture.audio.length, 2);
  assert.deepEqual(capture.audio[0], { pcm: [100, -100, 0], rate: 24000 });
  assert.deepEqual(capture.audio[1], { pcm: [7], rate: 24000 });
});

check('handle: input/output transcriptions accumulate, turnComplete resets', () => {
  const capture = { audio: [], transcripts: [], errors: [] };
  const s = makeSession(capture);
  s._handle({ serverContent: { inputTranscription: { text: 'Hello' } } });
  assert.deepEqual(capture.transcripts.at(-1), { original: 'Hello', translation: '' });
  s._handle({ serverContent: { outputTranscription: { text: 'Xin chào' } } });
  assert.deepEqual(capture.transcripts.at(-1), { original: 'Hello', translation: 'Xin chào' });
  s._handle({ serverContent: { turnComplete: true } });
  s._handle({ serverContent: { inputTranscription: { text: 'Next' } } });
  assert.deepEqual(capture.transcripts.at(-1), { original: 'Next', translation: '' });
});

check('handle: interrupted resets the turn accumulators', () => {
  const capture = { audio: [], transcripts: [], errors: [] };
  const s = makeSession(capture);
  s._handle({ serverContent: { inputTranscription: { text: 'Hello' } } });
  s._handle({ serverContent: { outputTranscription: { text: 'Xin chào' } } });
  s._handle({ serverContent: { interrupted: true } });
  s._handle({ serverContent: { inputTranscription: { text: 'Again' } } });
  assert.deepEqual(capture.transcripts.at(-1), { original: 'Again', translation: '' });
});

check('handle: error message reaches onError', () => {
  const capture = { audio: [], transcripts: [], errors: [] };
  const s = makeSession(capture);
  s._handle({ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } });
  assert.equal(capture.errors.length, 1);
  assert.ok(capture.errors[0].includes('API key not valid'));
});

check('handle: sessionResumptionUpdate stores the handle', () => {
  const capture = { audio: [], transcripts: [], errors: [] };
  const s = makeSession(capture);
  s._handle({ sessionResumptionUpdate: { newHandle: 'resume-abc', resumable: true } });
  assert.equal(s._resumeHandle, 'resume-abc');
});

check('sendAudioPcm16: buffers before setupComplete, flushes 16 kHz after', () => {
  const capture = { audio: [], transcripts: [], errors: [] };
  const s = makeSession(capture);
  const sent = [];
  s.ws = { readyState: 1, send: (text) => sent.push(JSON.parse(text)) };
  // 48 kHz, 480 samples -> 160 samples after downsampling.
  const pcm = new Int16Array(480);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i;
  s.sendAudioPcm16(pcm16ToBase64(pcm));
  assert.equal(s._pendingAudio.length, 1);
  assert.equal(sent.length, 0);
  s._handle({ setupComplete: {} });
  assert.equal(s._pendingAudio.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  const flushed = decodePcm16(sent[0].realtimeInput.audio.data);
  assert.equal(flushed.length, 160);
  assert.equal(flushed[0], 0);
  assert.equal(flushed[1], 3);
});

function decodePcm16(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

console.log(`\n${passed} gemini-live unit checks passed.`);
