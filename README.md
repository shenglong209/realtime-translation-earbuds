# Realtime Translation for Wireless Earbuds

**English → Vietnamese, in real time, in Zoom / Teams web meetings — into any Bluetooth earbuds. No software install. No special hardware.**

Zoom and Teams voice translation doesn't support Vietnamese at all. This Chrome extension captures the meeting tab's audio, translates it with OpenAI Realtime, and mixes the translation with the original voice so you hear both — the original ducked to 20% underneath.

> Status: **shipping in the open.** The audio pipeline is built and measured. The extension wiring (tab capture → Realtime session → virtual mic → subtitles) is implemented here; the first live-meeting test is the next milestone.

## What is proven (measured, not claimed)

| Piece | Proof |
|---|---|
| **Audio ducking** | Original ducks to **exactly 20%** under the translation. Verified: RMS ratio **0.200** in the duck window, 1.000 before/after, with 150 ms attack / 300 ms release ramps. Demo video: `docs/measurements.md` |
| **Virtual mic** | An extension cannot install a system audio device — so the mic lives **in-page only**: MAIN-world injection patches `enumerateDevices` / `getUserMedia` so Zoom/Teams web sees a fake mic in its own dropdown. Same mechanism Sokuji ships. Web meetings only, never the desktop app. |
| **Bilingual subtitles** | Subtitles live in a **Shadow DOM host outside the app's React root** (`document.body`, `pointer-events: none`), so Zoom/Teams re-renders never wipe them. MutationObserver re-mounts on route changes. |
| **Tab capture** | `chrome.tabCapture` — no admin rights needed, per-user extension install. |

## How it works

```
Meeting tab audio ──▶ chrome.tabCapture ──▶ OpenAI Realtime Translate
                                                   │
Original (EN) ──▶ GainNode (ducks to 20%) ──▶ mix ──▶ your earbuds
Translation (VI) ──▶ GainNode (100%) ───────▶ mix ──▶ your earbuds
Translation (VI) ──▶ virtual mic (in-page) ──▶ meeting hears you back
Transcript ──▶ Shadow DOM subtitles (EN small + VI large)
```

- **Latency budget:** first translated chunk < 800 ms feels live; > 2 s and people talk over the translation. Measured in the live test, not assumed.
- **Cost:** OpenAI GPT-Realtime-Translate, $0.034/min. A few minutes of testing costs cents.
- **The hard constraint:** the meeting laptop has **no software-install permission**. Everything here runs as a per-user Chrome extension. No drivers, no VB-CABLE, no desktop app.

## Repo map

```
manifest.json            MV3 manifest (Zoom/Teams web hosts, MAIN + ISOLATED worlds)
src/
  background.js          Service worker: wires capture → realtime → mix → mic → subtitles
  tab-capture.js         chrome.tabCapture → MediaStream
  ducking.js             DuckingMixer: two GainNodes + sidechain AnalyserNode
  realtime.js            OpenAI Realtime session (bring your own API key)
  virtual-mic.js         MAIN-world injection: synthetic mic via MediaStreamTrackGenerator
  subtitles.js           Shadow DOM bilingual subtitle overlay
  popup.js               Popup UI logic
popup.html               Start/stop, language pair, API key, duck level
docs/
  architecture.md        Pipeline, latency budget, cost, limits, test plan
  measurements.md        The measured ducking numbers
  live-test-checklist.md Step-by-step live proof in a real meeting
.github/workflows/
  test.yml               CI: npm ci → install Chrome → npm test
```

## Quickstart

1. Load the extension unpacked in Chrome (`chrome://extensions` → Developer mode → Load unpacked → this folder).
2. Open the popup, paste an OpenAI API key (stored locally via `chrome.storage`, never committed).
3. Join a Zoom/Teams meeting **from the browser** ("Join from your browser", not the desktop app).
4. Press Start. Pick **"Virtual Microphone"** in the meeting's own mic dropdown to speak back in Vietnamese.

## Limits (honest)

- **Speak-back works in web meetings only.** The virtual mic is in-page; the desktop app and OS sound settings never see it.
- **No speaker separation (yet).** The pipeline translates whoever is speaking; it doesn't label speakers.
- **Vietnamese-first.** EN→VI is the tested pair; the Realtime model supports 13 output languages.

## License

MIT.
