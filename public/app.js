/* Textbook → Voice — client
 * Streams speech events from the local native engine and highlights
 * each word in the reading pane as it is spoken. */

const $ = (sel) => document.querySelector(sel);

const STORE = {
  text: "ttv.text",
  lang: "ttv.lang",
  voice: "ttv.voice",
  rate: "ttv.rate",
};

const SAMPLE = `春天來了，公園裡的花都開了。小明和媽媽一起到公園散步。

They walked past the pond, where two ducks were swimming quietly.

「媽媽，你看！」小明指著天空說：「小鳥飛得好高啊！」

媽媽笑著回答：「是啊，春天來了，萬物都醒過來了。」`;

const els = {
  source: $("#source"),
  counter: $("#counter"),
  paste: $("#paste"),
  sample: $("#sample"),
  clear: $("#clear"),
  languages: $("#languages"),
  voice: $("#voice"),
  rescan: $("#rescan"),
  rate: $("#rate"),
  rateOut: $("#rateOut"),
  play: $("#play"),
  playLabel: $("#playLabel"),
  pause: $("#pause"),
  stop: $("#stop"),
  status: $("#status"),
  bar: $("#bar"),
  reader: $("#reader"),
  hint: $("#hint"),
};

const state = {
  voices: [],
  lang: null,
  status: "idle", // idle | reading | paused
  units: [],
  spans: [],
  highlighted: [],
  abort: null,
  /** Offset to begin speaking from (set by clicking a word). */
  startOffset: 0,
  /** Offset of the word currently being spoken, for resuming mid-reading. */
  lastLoc: 0,
  /** True when a setting changed while paused and has yet to be applied. */
  restartOnResume: false,
  /** True once the stream is finishing because we asked it to. */
  halting: false,
  /** True while a voice rescan is in flight. */
  refreshing: false,
};

/* --------------------------------------------------------------- voices --- */

const LANG_LABELS = {
  "zh-HK": ["廣東話", "Cantonese"],
  "yue-HK": ["廣東話", "Cantonese"],
  "zh-CN": ["普通話", "Mandarin"],
  "zh-SG": ["華語", "Singapore"],
  "zh-TW": ["國語", "Taiwan"],
};
const LANG_ORDER = ["zh-HK", "yue-HK", "zh-CN", "zh-SG", "zh-TW"];

function langLabel(locale) {
  if (LANG_LABELS[locale]) return LANG_LABELS[locale];
  if (locale.startsWith("zh") || locale.startsWith("yue") || locale.startsWith("cmn")) {
    return [locale, "Chinese"];
  }
  return [locale, "Other"];
}

function langRank(locale) {
  const i = LANG_ORDER.indexOf(locale);
  if (i >= 0) return i;
  if (locale.startsWith("zh") || locale.startsWith("yue")) return 50;
  return 100;
}

async function loadVoices() {
  await fetchVoices();
  const locales = availableLocales();

  // Preferred language: stored choice, else Cantonese, else the first available.
  const stored = localStorage.getItem(STORE.lang);
  state.lang =
    [stored, "zh-HK", "yue-HK", "zh-CN", "zh-TW"].find((l) => l && locales.includes(l)) ||
    locales[0];

  renderLanguages(locales);
  renderVoiceOptions();
}

/** Read the catalogue; `refresh` asks the server to re-scan the system. */
async function fetchVoices(refresh = false) {
  // Without a deadline a wedged server leaves the picker silently empty rather
  // than reporting anything, because this promise simply never settles. A
  // re-scan respawns the speech engine, so it is allowed longer.
  let res;
  try {
    res = await fetch(refresh ? "/api/voices?refresh=1" : "/api/voices", {
      signal: AbortSignal.timeout(refresh ? 20000 : 10000),
    });
  } catch {
    throw new Error("The speech engine did not answer. Check the terminal running the server.");
  }
  if (!res.ok) throw new Error("Could not read the system voice list.");
  const data = await res.json();
  state.voices = data.voices || [];
  if (!state.voices.length) throw new Error("No system voices were found.");
}

/** Locales worth offering: the Chinese ones, or everything if there are none. */
function availableLocales() {
  const locales = [...new Set(state.voices.map((v) => v.locale))].sort(
    (a, b) => langRank(a) - langRank(b) || a.localeCompare(b)
  );
  // This app reads Chinese textbooks, so offer the Chinese variants and keep
  // the other ~50 system languages out of the picker. If this Mac has no
  // Chinese voices at all, fall back to everything so the app stays usable.
  const chinese = locales.filter((locale) => /^(zh|yue|cmn)/.test(locale));
  return chinese.length ? chinese : locales;
}

function renderLanguages(locales) {
  els.languages.innerHTML = "";
  for (const locale of locales) {
    const [native, latin] = langLabel(locale);
    const b = document.createElement("button");
    b.type = "button";
    b.role = "radio";
    b.dataset.lang = locale;
    b.setAttribute("aria-checked", String(locale === state.lang));
    b.innerHTML = `<span class="native"></span><span class="latin"></span>`;
    b.querySelector(".native").textContent = native;
    b.querySelector(".latin").textContent = latin;
    b.addEventListener("click", () => selectLanguage(locale));
    els.languages.appendChild(b);
  }
}

/**
 * Re-scan the Mac for voices installed after this page was opened. The server
 * caches its catalogue, so this is the only way a new voice shows up without
 * restarting it.
 */
async function rescanVoices() {
  if (state.refreshing) return;
  state.refreshing = true;
  els.rescan.disabled = true;
  els.rescan.classList.add("busy");
  setHint("Looking for voices installed on this Mac…");

  const known = new Set(state.voices.map((v) => v.id));
  const previousLang = state.lang;

  try {
    await fetchVoices(true);
    const locales = availableLocales();
    // Keep the reader's language unless the rescan removed it.
    if (!locales.includes(state.lang)) state.lang = locales[0];
    renderLanguages(locales);
    renderVoiceOptions();

    const added = state.voices.filter((v) => !known.has(v.id));
    if (added.length) {
      const names = added.map((v) => voiceLabel(v)).join(", ");
      setHint(`Found ${added.length} new voice${added.length === 1 ? "" : "s"}: ${names}`);
    } else {
      setHint(
        "No new voices found. Install one in VoiceOver Utility → Speech → Voices, then scan again."
      );
    }
    if (previousLang && !locales.includes(previousLang)) {
      setHint(`${langLabel(previousLang)[0]} is no longer installed.`, true);
    }
  } catch (err) {
    setHint(err.message, true);
  } finally {
    state.refreshing = false;
    els.rescan.disabled = false;
    els.rescan.classList.remove("busy");
  }
}

function selectLanguage(locale) {
  state.lang = locale;
  localStorage.setItem(STORE.lang, locale);
  for (const b of els.languages.children) {
    b.setAttribute("aria-checked", String(b.dataset.lang === locale));
  }
  renderVoiceOptions();
  // An utterance in flight keeps the voice it started with, so picking another
  // language has to re-speak for the change to be heard.
  restartForSettingChange();
}

/**
 * macOS encodes voice quality in the identifier, e.g.
 *   com.apple.voice.premium.zh-CN.Tingting      the best, if downloaded
 *   com.apple.voice.enhanced.zh-CN.Tingting     downloaded extra quality
 *   com.apple.voice.compact.zh-CN.Tingting      the natural stock voice
 *   com.apple.voice.super-compact.…             smaller, rougher
 *   com.apple.eloquence.zh-CN.Eddy              retro novelty voices
 * Reading a textbook with "Eddy" is not what anyone wants, so the natural
 * voices must outrank the novelty ones.
 */
function qualityRank(voice) {
  if (voice.quality) {
    if (voice.quality === 'premium') return 0;
    if (voice.quality === 'enhanced') return 1;
    if (voice.quality === 'compact') return 2;
  }
  const id = voice.id || '';
  if (id.includes('.premium.')) return 0;
  if (id.includes('.enhanced.')) return 1;
  if (id.includes('.eloquence.')) return 9;
  if (id.includes('.super-compact.')) return 4;
  if (id.includes('.compact.')) return 2;
  return 3;
}

function voiceLabel(voice) {
  const rank = qualityRank(voice);
  const suffix = rank === 0 ? "premium" : rank === 1 ? "enhanced" : null;
  if (!suffix) return voice.name;
  // macOS already names these e.g. "Wing (Premium)"; do not say it twice.
  if (voice.name.toLowerCase().includes(suffix)) return voice.name;
  return `${voice.name} · ${suffix}`;
}

function voicesForLang() {
  return state.voices
    .filter((v) => v.locale === state.lang)
    .sort(
      (a, b) => qualityRank(a) - qualityRank(b) || a.name.localeCompare(b.name)
    );
}

function renderVoiceOptions() {
  const list = voicesForLang();
  const stored = localStorage.getItem(STORE.voice);
  els.voice.innerHTML = "";
  for (const v of list) {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = voiceLabel(v);
    els.voice.appendChild(o);
  }
  if (!list.length) {
    const o = document.createElement("option");
    o.textContent = "No speaker available for this language";
    o.value = "";
    els.voice.appendChild(o);
  }
  const pick = list.find((v) => v.id === stored) || list[0];
  if (pick) els.voice.value = pick.id;
  els.voice.disabled = !list.length;
  persistVoice();
}

function persistVoice() {
  if (els.voice.value) localStorage.setItem(STORE.voice, els.voice.value);
}

/* ----------------------------------------------------------- tokenizing --- */

const CJK =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const WORDISH = /[A-Za-z0-9\u00C0-\u024F'’\-_]/;

/** Split text into addressable units: one CJK char, or a run of Latin/digits. */
function tokenize(text) {
  const units = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const ch = text[i];
    if (ch === "\n") {
      i++;
      units.push({ start, end: i, br: true });
    } else if (CJK.test(ch)) {
      i++;
      units.push({ start, end: i });
    } else if (WORDISH.test(ch)) {
      while (i < text.length && WORDISH.test(text[i])) i++;
      units.push({ start, end: i });
    } else {
      // Whitespace and punctuation clump together; they never get highlighted.
      while (
        i < text.length &&
        text[i] !== "\n" &&
        !CJK.test(text[i]) &&
        !WORDISH.test(text[i])
      ) {
        i++;
      }
      units.push({ start, end: i });
    }
  }
  return units;
}

function render(text) {
  clearHighlight();
  state.text = text;
  state.units = tokenize(text);
  state.spans = new Array(state.units.length).fill(null);
  els.reader.innerHTML = "";

  if (!text.trim()) {
    els.reader.innerHTML =
      '<p class="placeholder">Paste some text, then press <strong>Read aloud</strong>.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  state.units.forEach((u, idx) => {
    if (u.br) {
      frag.appendChild(document.createElement("br"));
      return;
    }
    const span = document.createElement("span");
    span.className = "u";
    span.textContent = text.slice(u.start, u.end);
    span.addEventListener("click", () => playFrom(u.start));
    frag.appendChild(span);
    state.spans[idx] = span;
  });
  els.reader.appendChild(frag);
}

/** Index of the first unit that ends after `offset`. */
function unitAt(offset) {
  const units = state.units;
  let lo = 0;
  let hi = units.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (units[mid].end > offset) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/* ---------------------------------------------------------- highlighting --- */

function clearHighlight() {
  for (const idx of state.highlighted) {
    const s = state.spans[idx];
    if (s) s.className = "u";
  }
  state.highlighted.length = 0;
}

/** Whitespace and punctuation the engine may attach to a spoken word. */
const TRIMMABLE = /[\s\u3000，。、！？；：「」『』（）〈〉《》【】…—－·,.;:!?"'()\[\]{}]/;

function highlight(loc, len) {
  // The engine often reports a range that drags trailing punctuation along
  // ("來了。"). Shrink it so only real words light up.
  const text = state.text || "";
  let start = loc;
  let stop = loc + len;
  while (start < stop && TRIMMABLE.test(text[start])) start++;
  while (stop > start && TRIMMABLE.test(text[stop - 1])) stop--;

  // A range that is nothing but punctuation carries no word: leave the current
  // highlight untouched so the last spoken word stays lit through the pause.
  if (stop <= start) return loc + len;

  clearHighlight();

  const hit = [];
  for (let i = unitAt(start); i < state.units.length && state.units[i].start < stop; i++) {
    const u = state.units[i];
    if (u.end > start && state.spans[i]) hit.push(i);
  }
  hit.forEach((idx, n) => {
    const s = state.spans[idx];
    let cls = "u speaking";
    if (n === 0) cls += " head";
    if (n === hit.length - 1) cls += " tail";
    s.className = cls;
  });
  state.highlighted = hit;
  if (hit.length) keepVisible(state.spans[hit[0]]);
  return loc + len;
}

/** Scroll the reader only when the active word has drifted out of view. */
function keepVisible(el) {
  const box = els.reader.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const pad = 64;
  if (r.top < box.top + pad || r.bottom > box.bottom - pad) {
    els.reader.scrollTop += r.top - box.top - box.height / 2 + r.height / 2;
  }
}

/* ------------------------------------------------------------- playback --- */

function setStatus(status) {
  state.status = status;
  els.status.dataset.state = status;
  els.status.textContent =
    status === "reading" ? "Reading…" : status === "paused" ? "Paused" : "Idle";

  const busy = status !== "idle";
  // Kept enabled while reading so it doubles as "start over from the top".
  els.play.disabled = false;
  els.playLabel.textContent = busy ? "Restart" : "Read aloud";
  els.pause.disabled = status === "idle";
  els.pause.innerHTML =
    status === "paused"
      ? '<span class="ico">▶</span> Resume'
      : '<span class="ico">⏸</span> Pause';
  els.stop.disabled = status === "idle";
}

function setHint(msg, isError = false) {
  els.hint.textContent = msg;
  els.hint.classList.toggle("error", isError);
}

function setProgress(value) {
  els.bar.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
}

function playFrom(offset) {
  if (state.status !== "idle") halt();
  state.startOffset = offset || 0;
  start();
}

/**
 * Apply a new speed to whatever is being read right now.
 *
 * AVSpeechSynthesizer reads the rate once, when the utterance is queued —
 * setting it on an utterance already being spoken is silently ignored (verified
 * against the live framework). The voice and locale are fixed the same way: an
 * utterance in flight keeps the voice it started with. So every change to how
 * the text sounds has to re-speak from the current word. Dragging the slider
 * fires a stream of input events, hence the debounce.
 */
let restartTimer = null;

function restartForSettingChange() {
  clearTimeout(restartTimer);
  if (state.status === "idle") return;
  restartTimer = setTimeout(() => {
    if (state.status === "idle") return;
    if (state.status === "paused") {
      // Nothing is being spoken to restart; re-speak on resume instead.
      state.restartOnResume = true;
      return;
    }
    playFrom(state.lastLoc);
  }, 260);
}

function start() {
  const text = els.source.value;
  if (!text.trim()) {
    setHint("Paste some text first.", true);
    els.source.focus();
    return;
  }
  if (!els.voice.value) {
    setHint("Pick a speaker for this language.", true);
    return;
  }

  render(text);
  setHint("Speaking with an on-device voice.");
  setProgress(0);
  setStatus("reading");
  state.lastLoc = state.startOffset;
  state.restartOnResume = false;

  const controller = new AbortController();
  state.abort = controller;
  state.halting = false;

  fetch("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      text,
      voiceId: els.voice.value,
      locale: state.lang,
      rate: Number(els.rate.value) / 100 / 2,
      offset: state.startOffset,
    }),
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        let msg = `Speech engine error (${res.status}).`;
        try {
          const j = await res.json();
          if (j.error) msg = j.error;
        } catch {
          /* keep the default message */
        }
        throw new Error(msg);
      }
      await readStream(res.body);
    })
    .catch((err) => {
      if (err.name === "AbortError") return;
      finish(err.message);
      setHint(err.message, true);
    });
}

async function readStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleEvent(JSON.parse(line));
    }
  }
  if (buf.trim()) handleEvent(JSON.parse(buf.trim()));
}

function handleEvent(ev) {
  switch (ev.event) {
    case "start":
      setProgress(ev.offset / Math.max(1, els.source.value.length));
      break;
    case "word": {
      state.lastLoc = ev.loc;
      const end = highlight(ev.loc, ev.len);
      setProgress(end / Math.max(1, els.source.value.length));
      break;
    }
    case "paused":
      setStatus("paused");
      break;
    case "resumed":
      setStatus("reading");
      break;
    case "stopped":
      finish();
      break;
    case "end":
      finish();
      setHint("Finished. Press Read aloud to hear it again.");
      break;
    case "error":
      finish(ev.message);
      setHint(ev.message || "The speech engine reported an error.", true);
      break;
  }
}

function finish() {
  clearHighlight();
  state.abort = null;
  setStatus("idle");
}

function halt() {
  clearTimeout(restartTimer);
  state.halting = true;
  if (state.abort) {
    state.abort.abort();
    state.abort = null;
  }
  clearHighlight();
  setStatus("idle");
}

/* ------------------------------------------------------------- controls --- */

els.play.addEventListener("click", () => {
  playFrom(0);
  // Put a screen reader's cursor into the text that is about to be read, and
  // bring the pane into view when the layout puts it below the controls.
  if (state.status === "reading") els.reader.focus();
});

els.pause.addEventListener("click", async () => {
  // A setting changed while paused cannot be applied to the utterance sitting
  // in the paused synthesizer, so resuming re-speaks the current word instead.
  if (state.status === "paused" && state.restartOnResume) {
    playFrom(state.lastLoc);
    return;
  }
  const action = state.status === "paused" ? "resume" : "pause";
  try {
    await fetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  } catch {
    setHint("Lost contact with the speech engine.", true);
  }
});

els.stop.addEventListener("click", async () => {
  halt();
  try {
    await fetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
  } catch {
    /* the stream is already closed */
  }
  setHint("Stopped.");
  setProgress(0);
});

els.source.addEventListener("input", () => {
  const n = els.source.value.length;
  els.counter.textContent = `${n.toLocaleString()} character${n === 1 ? "" : "s"}`;
  localStorage.setItem(STORE.text, els.source.value);
  if (state.status !== "idle") halt();
  els.reader.innerHTML =
    '<p class="placeholder">Press <strong>Read aloud</strong> to render this text.</p>';
});

els.voice.addEventListener("change", () => {
  persistVoice();
  restartForSettingChange();
});
els.rescan.addEventListener("click", rescanVoices);

els.rate.addEventListener("input", () => {
  els.rateOut.textContent = `${(Number(els.rate.value) / 100).toFixed(2).replace(/0$/, "")}×`;
  localStorage.setItem(STORE.rate, els.rate.value);
  restartForSettingChange();
});

els.paste.addEventListener("click", async () => {
  // navigator.clipboard needs a secure context (https or localhost) and, in
  // Chrome, a clipboard-read permission the user is free to refuse — so every
  // way out of here has to leave the box usable.
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      setHint("Your clipboard has no text in it.");
      return;
    }
    els.source.value = text;
    els.source.dispatchEvent(new Event("input"));
    render(text);
    setHint(`Pasted ${text.length.toLocaleString()} characters.`);
  } catch {
    els.source.focus();
    setHint("This browser would not hand over the clipboard — press ⌘V or Ctrl+V in the box.", true);
  }
});

els.sample.addEventListener("click", () => {
  els.source.value = SAMPLE;
  els.source.dispatchEvent(new Event("input"));
  render(SAMPLE);
});

els.clear.addEventListener("click", () => {
  els.source.value = "";
  els.source.dispatchEvent(new Event("input"));
  els.source.focus();
  els.hint.textContent = "Tip: click any word in the reading pane to start from there.";
  els.hint.classList.remove("error");
  setProgress(0);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.status !== "idle") els.stop.click();
});

/* ------------------------------------------------------------------ boot --- */

(async function init() {
  els.source.value = localStorage.getItem(STORE.text) || "";
  els.source.dispatchEvent(new Event("input", { bubbles: false }));

  const rate = localStorage.getItem(STORE.rate) || "100";
  els.rate.value = rate;
  els.rateOut.textContent = `${(Number(rate) / 100).toFixed(2).replace(/0$/, "")}×`;

  setStatus("idle");
  try {
    await loadVoices();
  } catch (err) {
    setHint(err.message, true);
    return;
  }
  if (els.source.value.trim()) render(els.source.value);
  document.documentElement.dataset.ready = "true";
})();
