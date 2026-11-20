# Live-test checklist — real Zoom / Teams web meeting

Run this after the automated loop (`npm test`) is green and the PR is
merged. It is the only proof that counts for the latency budget: the
harness can check ducking / mic / subtitles offline, but first-chunk
latency needs a real Realtime session against a real meeting.

## Setup

- [ ] `npm ci` then `npm test` green on this checkout (latency test skipped
      without a key is fine here — the live run below covers it).
- [ ] Load the extension unpacked in Chrome (`chrome://extensions` →
      Developer mode → Load unpacked → this folder). Zero console errors
      on load.
- [ ] Open the popup, paste an OpenAI API key (stored in
      `chrome.storage.local` only, never committed).
- [ ] Join a real Zoom / Teams meeting **from the browser**
      ("Join from your browser", not the desktop app).

## Live run

- [ ] In the popup: language pair English → Vietnamese, duck level 20%,
      press Start. Popup shows "Translating…" and the Stop button enables.
- [ ] Reopen the popup mid-session: it still shows the running state
      (Start disabled, Stop enabled) and the saved pair / duck level.
- [ ] When someone speaks English, Vietnamese audio arrives in your
      earbuds and the original ducks underneath (you hear both, the
      original quieter).
- [ ] Bilingual subtitles appear on the meeting page (EN small + VI large)
      and survive the meeting UI re-rendering.
- [ ] In the meeting's own mic dropdown, "Virtual Microphone" is listed;
      selecting it lets the meeting hear the Vietnamese translation back.
- [ ] Change the duck slider mid-session: the original level follows
      without restarting.
- [ ] Press Stop: translation stops, popup returns to the stopped state.

## Record the numbers

- [ ] Run the latency check and record first-chunk latency in
      `test/report.json`:
      ```bash
      OPENAI_API_KEY=sk-... npm test
      ```
- [ ] Pass criteria: **first translated chunk < 800 ms**. Over 2 s = fail —
      do not weaken the assertion in `test/harness.mjs` to make it pass.
- [ ] Ducking spot check stays at 0.20 (± 0.05) — see
      `docs/measurements.md` for the method.

## If anything fails

Note the exact step, the console error (popup / background / offscreen),
and the `test/report.json` contents in the Daily Issue before fixing.
Fix the code, not the test — unless the test itself is wrong, in which
case say so in the commit message.
