# Measurements

All numbers below were measured on real speech clips (Google TTS, same
meeting sentence in English and Vietnamese), not assumed.

## Ducking: original drops to exactly 20%

Method: the English clip (6.408 s) was looped and mixed with the Vietnamese
clip (7.200 s) starting 1.0 s in, using the same gain automation as
`src/ducking.js` — linear ramps, 150 ms attack to 0.20, 300 ms release back
to 1.0. RMS was compared between the ducked stem and the identical unducked
clip in the same time windows.

| Window | Ducked RMS | Unducked RMS | Ratio |
|---|---|---|---|
| Before ducking (0.2–0.9 s) | 5427 | 5427 | **1.000** |
| Duck window (2.0–7.0 s) | 729 | 3645 | **0.200** |
| After ducking (8.6–9.1 s) | 2447 | 2447 | **1.000** |

The duck is exact: 0.200 in the window, 1.000 outside it. The rendered
22 s demo video of this mix (animated meters + gain graph driven by the
real per-frame RMS) is the visual proof; the mix itself is the audio proof.

## Clips

| File | Content | Duration | Size |
|---|---|---|---|
| `orig_en.mp3` | "We need to finish the quarterly report by Friday, and the budget review is on Monday morning." | 6.408 s | 51 KB |
| `trans_vi.mp3` | "Chúng ta cần hoàn thành báo cáo quý trước thứ Sáu, và buổi duyệt ngân sách diễn ra vào sáng thứ Hai." | 7.200 s | 58 KB |

Same sentence, EN → VI — the demo is a real translation pair, not two
unrelated sounds.

## Still to measure (live meeting test)

- Latency to first translated chunk (target < 800 ms).
- Sustained lag with a fast speaker.
- Whether "Virtual Microphone" appears in the web meeting's own mic
  dropdown on a locked-down corporate Chrome profile.
- Echo / feedback behaviour when the virtual mic is selected.
