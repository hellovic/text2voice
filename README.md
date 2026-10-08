# Textbook → Voice

Paste Chinese textbook text, press one button, and hear it read aloud in
**Cantonese**, **Mandarin** or **Taiwanese Mandarin** — with each word
highlighted in the page as it is spoken.

Two versions live in this repository, and they share the same interface:

| | **Static site** (`docs/`) | **macOS app** (repository root) |
|---|---|---|
| Where it runs | Any modern browser, hosted on GitHub Pages | Your own Mac, on `127.0.0.1` |
| Speech comes from | The voices built into the **visitor's** device | macOS `AVSpeechSynthesizer` |
| Highlighting | Web Speech API `onboundary` events | Native per-character callbacks (finer) |
| Needs installing anything? | No — just open the page | Node 20+ and Xcode command line tools |
| Best for | Sharing with students, phone, any computer | The best Cantonese quality on a Mac |

---

## Use it in a browser (no install)

Open the published site, paste your text, choose 廣東話 / 普通話 / 國語, pick a
speaker, and press **Read aloud**.

Nothing is uploaded. The page uses `speechSynthesis` with **on-device voices
only** — if it would have to fall back to a cloud voice (Chrome's "Google
粤語（香港）", for example), it refuses and says so instead, because textbook
text should not leave the reader's device.

### Voice availability

The voices offered are whatever the visitor's own device has installed, so
quality varies:

| Device | Cantonese | Mandarin | Notes |
|---|---|---|---|
| macOS | Fung, Sinji, Wing (Premium) | Tingting, Yue (Premium) + more | Best coverage. Install more in **VoiceOver Utility → Speech → Voices** |
| Windows | varies by edition | Huihui, Yaoyao + more | Add languages in **Settings → Time & language → Speech** |
| iPhone / iPad | Siri + installed voices | same | Works in Safari, but Safari fires boundary events inconsistently |
| Android | depends on the OEM image | usually present | Many devices ship no Cantonese voice |
| Linux | usually none | occasionally | Depends on the speech-dispatcher setup |
| Firefox | — | — | Ships no speech synthesis support at all |

If no on-device voice reads Chinese, the page says so plainly rather than
silently sending your text to a server. The ↻ button re-scans after you install
a voice, with no reload needed.

---

## The macOS app (better Cantonese)

On a Mac this version sounds noticeably better and highlights more precisely,
because it drives `AVSpeechSynthesizer` directly through a small Objective-C
helper instead of the browser.

```sh
npm start          # http://127.0.0.1:4321
```

The server binds `127.0.0.1` only — it is not reachable from your network — and
serves everything from `public/`. On first run it compiles `native/speak.m`
into `bin/speak` with `clang`; nothing to build by hand. Requires Node 20+ and
the Xcode command line tools.

Install extra voices in **VoiceOver Utility → Speech → Voices → +** (on macOS 15
and later this moved out of Accessibility → Spoken Content), then press ↻ in the
app — the voice list refreshes without a restart.

Press **⌘R** after pulling changes, since the browser may hold an older copy of
the client.

---

## Publishing your own copy

This repository is already laid out for GitHub Pages:

1. Push it to GitHub.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   then choose the branch and the **`/docs`** folder.
3. Your site appears at `https://<user>.github.io/<repo>/`.

`docs/` uses only relative links, so it works both as a project site
(`/repo/`) and as a user site. `docs/.nojekyll` stops Jekyll from processing the
folder.

To preview the static site locally before pushing:

```sh
npm run docs       # http://127.0.0.1:4322
```

---

## How the highlighting works

`tokenize()` splits the text into one unit per Chinese character and one per
Latin/number run, and each unit becomes a `<span>`. Punctuation is trimmed from
the range the speech engine reports, so a trailing `。` never blanks the pane.
Clicking any word restarts the reading from that word.

Two behaviours worth knowing:

- **Chinese highlights one character at a time.** Neither macOS nor the Web
  Speech API exposes Chinese word-boundary data, so there is no way to know
  where a "word" ends. English text highlights whole words.
- **Speed changes take effect immediately.** `AVSpeechSynthesizer` reads the
  rate once, when an utterance is queued, and ignores later changes — so the
  client re-speaks from the current word (debounced) instead of pretending to
  adjust the rate in place. Change the speed while paused and it applies on
  Resume.

---

## Layout

```
docs/            the static site published to GitHub Pages
public/          the macOS app's browser client
native/speak.m   Objective-C speech helper (compiled to bin/speak)
server.js        local-only HTTP server + speech engine
```

## Licence

MIT — see [LICENSE](LICENSE).
