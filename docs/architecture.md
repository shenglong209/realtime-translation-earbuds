# Architecture

## Pipeline

```
                     ┌─────────────────────────────────────────────┐
                     │ Chrome extension (per-user install, MV3)    │
                     │                                             │
Meeting tab audio ──▶│ chrome.tabCapture → MediaStream             │
                     │        │                                    │
                     │        ▼                                    │
                     │ OpenAI Realtime Translate (wss)            │
                     │   speech-to-speech, one call               │
                     │   STT + translation + TTS server-side       │
                     │        │                                    │
                     │        ▼                                    │
                     │ DuckingMixer (Web Audio)                    │
                     │   original GainNode ──▶ 20% when translating│
                     │   translation GainNode ──▶ 100%             │
                     │        │                                    │
                     │        ├────▶ earbuds (you hear both)       │
                     │        └────▶ virtual mic ──▶ meeting hears │
                     │                  translated audio as input  │
                     │                                             │
Transcript events ──▶│ SubtitleOverlay (Shadow DOM, outside React) │
                     └─────────────────────────────────────────────┘
```

All heavy compute runs **server-side** in the Realtime call. The extension
is a thin client: capture → WebSocket → playback. Mixing is two Web Audio
streams through GainNodes — near-zero CPU. That is the answer to "won't it
melt the CPU": nothing is inferred locally.

## The four hard parts (and how each is solved)

### 1. Tab audio capture

`chrome.tabCapture.capture({ audio: true, video: false })` on the meeting
tab. No admin rights: Chrome extensions install per-user. The meeting must
run in the **browser** — decline the desktop app, click "Join from your
browser". If the meeting has no browser join option, this route is dead for
that meeting (see `docs/architecture.md` fallback: phone as mixer).

### 2. Ducking (the mix)

`src/ducking.js` — `DuckingMixer`. Two `GainNode`s feed one destination.
A sidechain `AnalyserNode` on the translation stream measures RMS; when the
translation speaks, the original's gain ramps to **0.20** (150 ms attack)
and back to 1.0 when it stops (300 ms release). Measured on real speech:
RMS ratio **0.200** in the duck window, 1.000 before/after
(`docs/measurements.md`). You never hear two full voices at once.

Streaming, not batch: translation starts while the speaker is still talking,
first chunk target < 800 ms. A fast talker just trails a little further
behind, still one sequential stream. If a live test shows > 2 s latency,
the idea fails on its own terms — that is what the test measures.

### 3. Virtual mic (speak-back)

A Chrome extension **cannot** install a system virtual audio device — that
needs a driver, which is exactly what a locked-down meeting laptop forbids.
So the mic lives **in-page only** (`src/virtual-mic.js`):

1. The extension injects into the meeting tab in the **MAIN world**, so it
   patches the page's *own* `navigator.mediaDevices` (a content script's
   isolated world cannot do this).
2. Translated audio is turned into a synthetic `MediaStreamTrack` via
   `MediaStreamTrackGenerator` + `AudioData` (fed from a
   `MediaStreamTrackProcessor` on the translated stream).
3. `enumerateDevices` / `getUserMedia` are patched to report a fake device
   ("Virtual Microphone"). The user picks it in the meeting's **own mic
   dropdown**; the meeting's `RTCPeerConnection` then receives the
   translated track as the mic input.

**Boundary, stated plainly:** web meetings only (Zoom web `app.zoom.us`,
Teams web `teams.live.com` / `teams.microsoft.com`). Never the desktop app,
never OS sound settings. If a meeting runs in the desktop app, speak-back
doesn't work — listening still does. Never select the virtual mic as the
extension's own input (feedback loop).

This is the mechanism Sokuji ships; it is documented, not a sketch.

### 4. Bilingual subtitles (DOM)

`src/subtitles.js` — `SubtitleOverlay`. The naive approach (injecting divs
into the meeting's caption container) dies: React re-renders wipe them.
Instead:

- The subtitle host is appended to `document.body`, **outside the app's
  React root**, with a **Shadow DOM** attached. React only reconciles
  inside its own tree, so its re-renders never see, wipe, or fight the
  overlay. The shadow boundary also isolates CSS both ways.
- `position: fixed`, high `z-index`, `pointer-events: none` — it floats
  over the video grid without eating clicks.
- A `MutationObserver` on `document.body` re-mounts the host if the app
  ever blows it away on a route change.
- Updates touch **only our own text nodes**, on transcript events (a few
  times a second, never per frame).

Layout: two lines — original small on top, translation larger below.

## Latency budget

| Stage | Target |
|---|---|
| First translated chunk | < 800 ms (feels live) |
| Sustained lag behind speaker | ~1 s |
| > 2 s | unusable — people talk over the translation |

## Cost

OpenAI GPT-Realtime-Translate: **$0.034/min**. A 10-hour month is ~$20.40
of API cost; price the product above that or it loses money.

## Test plan (15 minutes, one real meeting)

0. "Add to Chrome" — blocked = extension route dead.
1. Join via "Join from your browser" — no such option = dead for that meeting.
2. Set VI–EN + API key in the popup.
3. Listen 1 min — translation with original underneath at 20%?
4. Speak 1 min — does "Virtual Microphone" appear in the web meeting's
   own mic dropdown?
5. Note latency to first chunk (target < 800 ms), code-switch survival,
   echo.

All pass = extension route proven. Step 0/1 fails = phone-as-mixer only.
Steps 0–3 pass but 4 fails = listening works, speak-back does not.
