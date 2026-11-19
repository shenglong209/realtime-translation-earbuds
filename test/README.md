# Test loop

The automated loop the Devin Bot runs — no babysitting.

```bash
npm install
npx puppeteer browsers install chrome
npm test                                   # ducking + virtual mic + subtitles
OPENAI_API_KEY=sk-... npm test             # + live first-chunk latency
```

## What it checks

| Test | What it proves |
| --- | --- |
| `ducking-ratio-0.20` | While the VI translation speaks, the EN original ducks to 0.20 (RMS ratio, same method as `docs/measurements.md`). |
| `virtual-mic` | After `start()`, `enumerateDevices` lists "Virtual Microphone" and `getUserMedia` with its deviceId returns a live audio track. Runs in the page's MAIN world. |
| `subtitles-shadow-dom` | The Shadow DOM overlay survives mock React re-renders (the caption container is wiped every second) and sits outside the app root. |
| `latency-first-chunk-ms` | T0 = first audio frame appended to the Realtime input buffer, T1 = first `response.audio.delta`. Asserted < 800 ms. Skipped without `OPENAI_API_KEY`. |

Results go to `test/report.json`; the process exits 1 on any failure, so CI gates on it.

## Fixtures

`test/fixtures/*.b64` are the real speech clips from the ducking demo (same EN→VI sentence), PCM16 16 kHz mono, base64-encoded so they can live in the repo as text.
