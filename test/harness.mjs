// Automated test loop — the exact loop the Devin Bot runs.
//
//   npm test                 (ducking + virtual mic + subtitles; no key needed)
//   OPENAI_API_KEY=sk-... npm test   (+ live latency check against Realtime)
//
// Writes test/report.json and exits 1 on any failure, so CI gates on it.
// No secrets in the repo: the API key comes from the environment (or a
// GitHub secret in CI) and is only used to mint an ephemeral Realtime key.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = {};
const failures = [];

function record(name, ok, detail = {}) {
  results[name] = { ok, ...detail };
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(detail));
  if (!ok) failures.push(name);
}

// Fixtures: real speech clips (EN + VI, same sentence), PCM16 16 kHz mono,
// base64-encoded so they can live in the repo as text.
function loadFixture(name) {
  const b64 = fs.readFileSync(path.join(root, 'test/fixtures', name), 'utf8').trim();
  return Buffer.from(b64, 'base64');
}
const EN_PCM = loadFixture('en-sample.b64');
const VI_PCM = loadFixture('vi-sample.b64');

function pcm16ToFloat32(buf) {
  const out = new Float32Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

// Our src files are ES modules; in the test page they are injected as
// classic scripts, so strip the `export` keyword and expose the class.
// Files with no export (virtual-mic.js sets window.__translationMic
// itself) are returned unchanged.
function asClassicScript(relPath, globalName) {
  let src = fs.readFileSync(path.join(root, relPath), 'utf8');
  if (src.includes(`export class ${globalName}`)) {
    src = src.replace(`export class ${globalName}`, `class ${globalName}`);
    src += `\nwindow.${globalName} = ${globalName};`;
  }
  return src;
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    `--load-extension=${root}`,
    `--disable-extensions-except=${root}`,
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    // This VM runs as root; Chrome refuses to start without it.
    '--no-sandbox',
    '--disable-setuid-sandbox',
  ],
});

try {
  const page = await browser.newPage();
  await page.goto(`file://${root}/test/mock-zoom.html`);
  await page.waitForFunction(() => window.__mockZoomReady);

  await page.addScriptTag({ content: asClassicScript('src/ducking.js', 'DuckingMixer') });

  // --- Test 1: ducking. Feed the EN clip (original) and the VI clip
  // (translation); while the translation speaks the original must duck
  // to 0.20. Same RMS method as docs/measurements.md. ---
  {
    // Measure RMS averaged over many snapshots: speech is bursty, so one
    // 42 ms AnalyserNode snapshot can land in a word gap and read ~0
    // even at full gain. The single-snapshot version of this test was
    // flaky for exactly that reason (ratio 0.003 on a working mixer —
    // the gain itself was verified at 0.200); averaging over ~1 s of
    // speech is the fix, not a weaker assertion.
    const ratio = await page.evaluate(async (en, vi) => {
      const ctx = new AudioContext();
      const enBuf = ctx.createBuffer(1, en.length, 16000);
      enBuf.getChannelData(0).set(en);
      const viBuf = ctx.createBuffer(1, vi.length, 16000);
      viBuf.getChannelData(0).set(vi);
      const mixer = new window.DuckingMixer(ctx, { duckLevel: 0.2 });
      const enStream = ctx.createMediaStreamDestination();
      const viStream = ctx.createMediaStreamDestination();
      const enSrc = ctx.createBufferSource();
      enSrc.buffer = enBuf;
      enSrc.connect(enStream);
      const viSrc = ctx.createBufferSource();
      viSrc.buffer = viBuf;
      viSrc.connect(viStream);
      mixer.connectOriginal(enStream.stream);
      mixer.connectTranslation(viStream.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      mixer.originalGain.connect(analyser);
      mixer.start();
      const measureRms = async (durationMs) => {
        const samples = [];
        const end = Date.now() + durationMs;
        while (Date.now() < end) {
          const b = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(b);
          samples.push(...b);
          await new Promise((r) => setTimeout(r, 50));
        }
        return Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length);
      };
      enSrc.start();
      const before = await measureRms(500);
      viSrc.start();
      await new Promise((r) => setTimeout(r, 300)); // let the duck engage
      const ducked = await measureRms(1200);
      mixer.destroy();
      await ctx.close();
      return ducked / before;
    // Puppeteer serializes evaluate() args as JSON, which drops a
    // TypedArray's .length (it arrives as {"0":..,"1":..}), so pass
    // plain arrays — createBuffer(1, undefined, …) would throw 0 frames.
    }, Array.from(pcm16ToFloat32(EN_PCM)), Array.from(pcm16ToFloat32(VI_PCM)));
    record('ducking-ratio-0.20', Math.abs(ratio - 0.2) < 0.05, { ratio: +ratio.toFixed(3) });
  }

  // --- Test 2: virtual mic (MAIN world). After start(), the fake device
  // must appear in enumerateDevices and getUserMedia must return it. ---
  await page.addScriptTag({ content: asClassicScript('src/virtual-mic.js', '__translationMic') });
  {
    const mic = await page.evaluate(async () => {
      await window.__translationMic.start();
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fake = devices.find((d) => d.deviceId === 'translation-virtual-mic');
      if (!fake) return { found: false };
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: 'translation-virtual-mic' } },
      });
      const track = stream.getAudioTracks()[0];
      return { found: true, label: fake.label, kind: track?.kind, live: track?.readyState === 'live' };
    });
    record('virtual-mic', mic.found && mic.kind === 'audio' && mic.live, mic);
  }

  // --- Test 3: subtitles survive React re-renders (Shadow DOM host on
  // document.body, outside the mock React root). ---
  await page.addScriptTag({ content: asClassicScript('src/subtitles.js', 'SubtitleOverlay') });
  {
    const subs = await page.evaluate(async () => {
      const overlay = new window.SubtitleOverlay();
      overlay.update('Hello everyone', 'Xin chào mọi người');
      await new Promise((r) => setTimeout(r, 2500)); // two re-renders
      const host = document.getElementById('rt-subtitle-host');
      const text = host?.shadowRoot?.textContent || '';
      const outsideRoot = host && !document.getElementById('react-root').contains(host);
      return { present: !!host, outsideRoot: !!outsideRoot, hasText: text.includes('Xin chào mọi người') };
    });
    record('subtitles-shadow-dom', subs.present && subs.outsideRoot && subs.hasText, subs);
  }

  // --- Test 4: live latency (only with a key). T0 = first audio frame
  // appended to the Realtime input buffer; T1 = first audio delta.
  // Assert < 800 ms. Skipped (not failed) without OPENAI_API_KEY. ---
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    record('latency-first-chunk-ms', true, { skipped: 'no OPENAI_API_KEY' });
  } else {
    const latencyMs = await measureLatency(apiKey);
    record('latency-first-chunk-ms', latencyMs < 800, { latencyMs });
  }
} finally {
  await browser.close();
}

async function measureLatency(apiKey) {
  const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-realtime', voice: 'alloy' }),
  });
  if (!res.ok) throw new Error(`session mint failed: ${res.status}`);
  const { client_secret } = await res.json();
  const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', [
    'realtime',
    `openai-insecure-api-key.${client_secret.value}`,
    'openai-beta.realtime-v1',
  ]);
  const t0 = { at: 0 };
  const latency = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('no audio delta in 15 s')), 15000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions: 'Translate everything you hear from en to vi. Speak only the translation.',
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: { type: 'server_vad' },
        },
      }));
      t0.at = performance.now();
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: EN_PCM.toString('base64'),
      }));
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'response.audio.delta') {
        clearTimeout(timeout);
        resolve(Math.round(performance.now() - t0.at));
      }
      if (msg.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(msg.error?.message || 'realtime error'));
      }
    };
    ws.onerror = (e) => { clearTimeout(timeout); reject(new Error(String(e?.message || e))); };
  });
  ws.close();
  return latency;
}

const report = { startedAt: new Date().toISOString(), tests: results, failures };
fs.writeFileSync(path.join(root, 'test/report.json'), JSON.stringify(report, null, 2));
console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — report written to test/report.json`);
process.exit(failures.length ? 1 : 0);
