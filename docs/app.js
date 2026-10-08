/* Textbook → Voice — browser edition
 *
 * Speaks Chinese with the voices already installed on the visitor's device,
 * through the Web Speech API. There is no server, no account and no API key:
 * the page is three static files, and the audio never leaves the machine.
 *
 * The trade-off that shapes everything below: browsers only ever offer the
 * voices the operating system has installed. Chrome additionally advertises a
 * set of *network* voices ("Google 粤語（香港）" and friends) which upload the
 * text to Google to synthesise it. Those are filtered out, so if the device has
 * no local Chinese voice the app refuses to read rather than silently becoming
 * a cloud service. */

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

const synth = window.speechSynthesis;
const Utterance = window.SpeechSynthesisUtterance;

/** SpeechSynthesisVoice objects, keyed by the id stored in localStorage. */
const voiceMap = new Map();

const els = {
  source: $("#source"),
  counter: $("#counter"),
  paste: $("#paste"),
  sample: $("#sample"),
  clear: $("#clear"),
  notice: $("#notice"),
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
  /** On-device Chinese voices, as thin {id, name, locale} records. */
  voices: [],
  /** Every on-device voice, Chinese or not, so refusals can be specific. */
  onDevice: [],
  lang: null,
  status: "idle", // idle | reading | paused
  text: "",
  units: [],
  spans: [],
  highlighted: [],
  /** Offset to begin speaking from (set by clicking a word). */
  startOffset: 0,
  /** Offset of the word currently being spoken, for resuming mid-reading. */
  lastLoc: 0,
  /** True when a setting changed while paused and has yet to be applied. */
  restartOnResume: false,
  /**
   * Bumped whenever playback is replaced or stopped. Every utterance callback
   * captures the token it was created under and returns early if it is stale —
   * without this, a cancelled utterance's `onend` would start the next chunk of
   * a reading the listener already stopped.
   */
  token: 0,
  /** {token, chunks, index} for the run in progress, or null. */
  run: null,
  /** True while a clipboard read is in flight. */
  pasting: false,
};

/* --------------------------------------------------------------- voices --- */

const LANG_LABELS = {
  "zh-HK": ["廣東話", "Cantonese"],
  "zh-CN": ["普通話", "Mandarin"],
  "zh-TW": ["國語", "Taiwan"],
};
const LANG_ORDER = ["zh-HK", "zh-CN", "zh-TW"];

/**
 * Collapse the many Chinese tags a platform may report ("yue-HK", "zh_HK",
 * "cmn-Hans-CN", …) onto the three the picker offers.
 */
function normalizeLocale(tag) {
  const t = String(tag || "").replace(/_/g, "-").toLowerCase();
  if (!t) return "";
  const parts = t.split("-");
  const base = parts[0];
  const rest = parts.slice(1);
  const region = rest.find((p) => /^[a-z]{2}$/.test(p) || /^\d{3}$/.test(p)) || "";
  const script = rest.find((p) => /^[a-z]{4}$/.test(p)) || "";

  if (base === "yue") return "zh-HK";
  if (base === "cmn") return region === "tw" || script === "hant" ? "zh-TW" : "zh-CN";
  if (base === "zh") {
    if (region === "hk" || region === "mo") return "zh-HK";
    if (region === "tw") return "zh-TW";
    if (script === "hant") return "zh-TW";
    if (script === "hans" || region === "cn" || region === "sg" || region === "my") {
      return "zh-CN";
    }
    return "zh-CN"; // a bare "zh" is far more often Mandarin than anything else
  }
  return "";
}

/**
 * A voice is usable only if it is produced on this device.
 *
 * Chrome reports `localService: false` for its network voices, and also names
 * them "Google …". Both checks are applied: the flag is authoritative where it
 * exists, and the name catches platforms that omit it.
 */
function isOnDevice(v) {
  if (v.localService === false) return false;
  if (/^Google\b/i.test(v.name || "")) return false;
  return true;
}

/** Every voice produced on this device, with `locale` empty for non-Chinese. */
function readLocalVoices() {
  const out = [];
  voiceMap.clear();
  for (const v of synth.getVoices() || []) {
    if (!isOnDevice(v)) continue;
    const id = v.voiceURI || `${v.name}|${v.lang}`;
    voiceMap.set(id, v);
    out.push({ id, name: v.name, locale: normalizeLocale(v.lang) });
  }
  return out;
}

function langLabel(locale) {
  return LANG_LABELS[locale] || [locale, "Chinese"];
}

function langRank(locale) {
  const i = LANG_ORDER.indexOf(locale);
  return i >= 0 ? i : 50;
}

/** Locales that actually have a local voice behind them. */
function availableLocales() {
  return [...new Set(state.voices.map((v) => v.locale))].sort(
    (a, b) => langRank(a) - langRank(b) || a.localeCompare(b)
  );
}

/**
 * The novelty voices Apple ships with macOS ("Eddy", "Flo", "Grandma", …) are
 * fun for a sentence and useless for a textbook, so they sort last.
 */
const NOVELTY = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;

function qualityRank(voice) {
  const n = voice.name || "";
  if (NOVELTY.test(n)) return 9;
  if (/\(premium\)/i.test(n)) return 0;
  if (/\(enhanced\)/i.test(n)) return 1;
  return 3;
}

function voicesForLang() {
  return state.voices
    .filter((v) => v.locale === state.lang)
    .sort((a, b) => qualityRank(a) - qualityRank(b) || a.name.localeCompare(b.name));
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

function renderVoiceOptions() {
  const list = voicesForLang();
  const stored = localStorage.getItem(STORE.voice);
  els.voice.innerHTML = "";
  for (const v of list) {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = v.name;
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
 * Rebuild the picker from whatever the browser reports right now. Returns the
 * locale list, or null when no on-device voice reads Chinese.
 */
function applyVoices() {
  // Two separate counts matter for the messages shown when we have to refuse:
  // how many voices live on the device at all, and how many of those are Chinese.
  state.onDevice = readLocalVoices();
  const chinese = state.onDevice.filter((v) => v.locale);
  if (!chinese.length) return null;
  state.voices = chinese;

  const locales = availableLocales();
  const stored = localStorage.getItem(STORE.lang);
  state.lang =
    [stored, "zh-HK", "zh-CN", "zh-TW"].find((l) => l && locales.includes(l)) || locales[0];

  hideNotice();
  renderLanguages(locales);
  renderVoiceOptions();
  return locales;
}

/* -------------------------------------------------- explaining a refusal --- */

/** Where to send someone to install a voice, per platform. */
function installHint() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) {
    return "On iOS: Settings → Accessibility → Spoken Content → Voices → Chinese.";
  }
  if (/Android/.test(ua)) {
    return "On Android: Settings → Accessibility → Text-to-speech, then install a Chinese voice.";
  }
  if (/Mac OS X|Macintosh/.test(ua)) {
    return "On macOS: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices, and add a Chinese voice.";
  }
  if (/Windows/.test(ua)) {
    return "On Windows: Settings → Time &amp; language → Speech → Manage voices, and add a Chinese voice.";
  }
  return "Install a Chinese voice in your operating system's speech settings.";
}

function showNotice(html) {
  els.notice.hidden = false;
  els.notice.innerHTML = html;
}

function hideNotice() {
  els.notice.hidden = true;
  els.notice.innerHTML = "";
}

function refuseNoVoices() {
  showNotice(
    `<strong>This browser is not offering any voices.</strong>
     <p>Textbook → Voice only uses voices that live on your device, so there is
     nothing to read with here. ${installHint()} Then press ↻.</p>
     <p class="notice-fine">Desktop Chrome, Edge and Safari work well. Firefox does
     not currently support speech synthesis.</p>`
  );
  els.play.disabled = true;
  els.pause.disabled = true;
  els.stop.disabled = true;
  setHint("No voice available.", true);
}

/** Every voice the browser offers is a network voice; refuse rather than upload. */
function refuseNetworkOnly() {
  showNotice(
    `<strong>This browser only offers online voices.</strong>
     <p>The voices available here send the text to a server to be spoken, which
     this app will not do — your textbook should not leave your device.
     ${installHint()}</p>
     <p class="notice-fine">A voice installed on the device will always be used
     in preference to an online one.</p>`
  );
  els.play.disabled = true;
  els.pause.disabled = true;
  els.stop.disabled = true;
  setHint("Only online voices are available — refusing to use them.", true);
}

function refuseNoChinese() {
  showNotice(
    `<strong>Your device has no Chinese voice installed.</strong>
     <p>It has ${state.onDevice.length} on-device voice${state.onDevice.length === 1 ? "" : "s"},
     but none of them read Chinese. ${installHint()} Then press ↻.</p>`
  );
  els.play.disabled = true;
  els.pause.disabled = true;
  els.stop.disabled = true;
  setHint("No Chinese voice available on this device.", true);
}

/* ----------------------------------------------------------- tokenizing --- */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
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
      while (i < text.length && text[i] !== "\n" && !CJK.test(text[i]) && !WORDISH.test(text[i])) {
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

/** Whitespace and punctuation a boundary may drag along with a spoken word. */
const TRIMMABLE = /[\s\u3000，。、！？；：「」『』（）〈〉《》【】…—－·,.;:!?"'()\[\]{}]/;

function highlight(loc, len) {
  const text = state.text || "";
  let start = Math.max(0, loc);
  let stop = Math.min(text.length, loc + len);
  while (start < stop && TRIMMABLE.test(text[start])) start++;
  while (stop > start && TRIMMABLE.test(text[stop - 1])) stop--;

  // A range that is nothing but punctuation carries no word: leave the current
  // highlight untouched so the last spoken word stays lit.
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

/* ------------------------------------------------------------ chunking --- */

/** Chrome silently drops utterances that run very long, so nothing exceeds this. */
const MAX_CHUNK = 180;

const SENTENCE_END = /[。！？；!?;\n\r…]/;
const SENTENCE_TAIL = /[」』”’）】》〉\s]/;

/**
 * Cut the text into utterances at sentence boundaries, keeping absolute
 * offsets so a boundary event's `charIndex` can be mapped back onto the full
 * text. Speaking sentence by sentence also keeps prosody natural and gives
 * pause/stop a clean place to take effect.
 */
function chunk(text) {
  const spans = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!SENTENCE_END.test(text[i])) continue;
    let j = i + 1;
    while (j < text.length && SENTENCE_TAIL.test(text[j])) j++;
    spans.push({ start, end: j });
    start = j;
    i = j - 1;
  }
  if (start < text.length) spans.push({ start, end: text.length });

  const out = [];
  for (const s of spans) {
    let from = s.start;
    while (s.end - from > MAX_CHUNK) {
      let cut = from + MAX_CHUNK;
      const space = text.lastIndexOf(" ", cut);
      if (space > from + MAX_CHUNK * 0.6) cut = space + 1;
      out.push({ start: from, end: cut });
      from = cut;
    }
    out.push({ start: from, end: s.end });
  }
  return out.filter((c) => text.slice(c.start, c.end).trim().length > 0);
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

/**
 * Reading the clipboard is the one thing the browser may refuse outright, or may
 * answer only once the user has cleared a permission bubble. `readText()` stays
 * pending for as long as that bubble is open, so a bare await would leave the
 * Paste button looking simply dead — every path here has to settle.
 */
const CLIPBOARD_WAIT_MS = 8000;

function readClipboard() {
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
    return Promise.reject(new Error("unsupported"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), CLIPBOARD_WAIT_MS);
    navigator.clipboard.readText().then(
      (text) => { clearTimeout(timer); resolve(text); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** "granted" | "denied" | "prompt", or null where the query is unsupported. */
async function clipboardPermission() {
  try {
    const status = await navigator.permissions.query({ name: "clipboard-read" });
    return status.state;
  } catch {
    return null;
  }
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
 * Changes to how the text sounds take effect immediately, by re-speaking from
 * the word being read. A `SpeechSynthesisUtterance`'s rate, voice and language
 * are all fixed once it has been handed to the synthesizer, so there is no way
 * to alter one mid-sentence. Dragging the slider fires a stream of input events,
 * hence the debounce.
 */
let restartTimer = null;

function restartForSettingChange() {
  clearTimeout(restartTimer);
  if (state.status === "idle") return;
  restartTimer = setTimeout(() => {
    if (state.status === "idle") return;
    if (state.status === "paused") {
      state.restartOnResume = true;
      return;
    }
    speakFrom(state.lastLoc);
  }, 260);
}

function start() {
  const text = els.source.value;
  if (!text.trim()) {
    setHint("Paste some text first.", true);
    els.source.focus();
    return;
  }
  if (!els.voice.value || !voiceMap.has(els.voice.value)) {
    setHint("Pick a speaker for this language.", true);
    return;
  }

  render(text);
  setHint("Speaking with an on-device voice.");
  setProgress(0);
  setStatus("reading");
  state.lastLoc = state.startOffset;
  state.restartOnResume = false;
  speakFrom(state.startOffset);
}

function speakFrom(offset) {
  const text = els.source.value;
  const chunks = chunk(text);
  let index = chunks.findIndex((c) => c.end > offset);
  if (index < 0) {
    finish();
    setHint("Finished. Press Read aloud to hear it again.");
    return;
  }

  state.token++;
  synth.cancel(); // drop anything still in flight from the previous run
  state.run = { token: state.token, chunks, index };
  setStatus("reading");
  speakChunk(index);
}

function speakChunk(index) {
  const run = state.run;
  if (!run || run.index !== index) return;
  const c = run.chunks[index];
  if (!c) {
    finish();
    setHint("Finished. Press Read aloud to hear it again.");
    return;
  }

  const text = state.text || "";
  const voice = voiceMap.get(els.voice.value);
  const u = new Utterance(text.slice(c.start, c.end));
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else {
    u.lang = state.lang;
  }
  u.rate = Number(els.rate.value) / 100; // slider 100 → 1.0×, the normal rate

  const current = () => state.run && state.run.token === run.token && state.run.index === index;

  // Not every voice reports word boundaries (and some report none for Chinese).
  // If none arrive shortly after the sentence starts, light up the whole
  // sentence so the reader can still see where they are.
  let sawBoundary = false;
  const fallback = setTimeout(() => {
    if (!sawBoundary && current()) highlight(c.start, c.end - c.start);
  }, 700);

  u.onboundary = (e) => {
    if (!current()) return;
    sawBoundary = true;
    clearTimeout(fallback);
    const loc = c.start + (e.charIndex || 0);
    state.lastLoc = loc;
    const end = highlight(loc, e.charLength || 1);
    setProgress(end / Math.max(1, text.length));
  };

  u.onend = () => {
    clearTimeout(fallback);
    if (!current()) return;
    run.index = index + 1;
    speakChunk(index + 1);
  };

  u.onerror = (e) => {
    clearTimeout(fallback);
    if (!current()) return;
    // Cancelling playback ourselves surfaces here too; that is not a failure.
    if (e.error === "interrupted" || e.error === "canceled") return;
    finish();
    setHint(`This voice could not read the text (${e.error || "unknown error"}).`, true);
  };

  run.index = index;
  synth.speak(u);
}

function finish() {
  state.run = null;
  clearHighlight();
  setStatus("idle");
}

function halt() {
  clearTimeout(restartTimer);
  state.token++;
  state.run = null;
  synth.cancel();
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

els.pause.addEventListener("click", () => {
  if (state.status === "paused") {
    // A setting chosen while paused cannot reach the utterance the synthesizer
    // is holding, so resuming re-speaks the current word instead.
    if (state.restartOnResume) playFrom(state.lastLoc);
    else {
      synth.resume();
      setStatus("reading");
    }
    return;
  }
  if (state.status === "reading") {
    synth.pause();
    setStatus("paused");
  }
});

els.stop.addEventListener("click", () => {
  halt();
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

els.rescan.addEventListener("click", () => {
  els.rescan.disabled = true;
  els.rescan.classList.add("busy");
  const before = new Set(state.voices.map((v) => v.id));
  const locales = applyVoices();
  if (!locales) {
    refuseNoVoices();
  } else {
    const added = state.voices.filter((v) => !before.has(v.id));
    setHint(
      added.length
        ? `Found ${added.length} new voice${added.length === 1 ? "" : "s"}: ${added
            .map((v) => v.name)
            .join(", ")}`
        : "No new voices found. Install one in your system's speech settings, then press ↻."
    );
  }
  els.rescan.disabled = false;
  els.rescan.classList.remove("busy");
});

els.rate.addEventListener("input", () => {
  els.rateOut.textContent = `${(Number(els.rate.value) / 100).toFixed(2).replace(/0$/, "")}×`;
  localStorage.setItem(STORE.rate, els.rate.value);
  restartForSettingChange();
});

els.paste.addEventListener("click", async () => {
  // A page only reaches the clipboard if the browser allows it: a secure context
  // (https or localhost) plus, in Chrome, a clipboard-read permission the user is
  // free to refuse. So Paste works when it can and says so when it cannot.
  if (state.pasting) return;
  state.pasting = true;
  els.paste.disabled = true;
  setHint("Reading your clipboard…");
  try {
    const text = await readClipboard();
    if (!text.trim()) {
      els.source.focus();
      setHint("Your clipboard has no text in it — copy the passage first.", true);
      return;
    }
    els.source.value = text;
    els.source.dispatchEvent(new Event("input"));
    render(text);
    setHint(`Pasted ${text.length.toLocaleString()} characters.`);
  } catch (err) {
    els.source.focus();
    const permission = await clipboardPermission();
    const why =
      err && err.message === "timeout"
        ? "Your browser is still waiting for permission to read the clipboard — answer its prompt, then click Paste again."
        : permission === "denied"
          ? "Clipboard access is blocked for this page — allow it from the address bar, then click Paste again."
          : "This browser will not hand the clipboard to the page.";
    setHint(`${why} You can always press ⌘V (Ctrl+V) in the box.`, true);
  } finally {
    state.pasting = false;
    els.paste.disabled = false;
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

function boot() {
  els.source.value = localStorage.getItem(STORE.text) || "";
  els.source.dispatchEvent(new Event("input", { bubbles: false }));

  const rate = localStorage.getItem(STORE.rate) || "100";
  els.rate.value = rate;
  els.rateOut.textContent = `${(Number(rate) / 100).toFixed(2).replace(/0$/, "")}×`;

  setStatus("idle");
  els.play.disabled = true; // until we know there is a voice to read with

  if (!synth || !Utterance) {
    showNotice(
      `<strong>This browser cannot speak.</strong>
       <p>It has no Web Speech API, so there is no way to read the text aloud here.
       Desktop Chrome, Edge and Safari support it; Firefox does not.</p>`
    );
    setHint("Speech is not supported in this browser.", true);
    document.documentElement.dataset.ready = "true";
    return;
  }

  // Chrome returns only its network voices on the first read; the device's own
  // voices arrive a moment later via `voiceschanged`, sometimes in several
  // waves. Poll until something usable shows up, then stop.
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    const locales = applyVoices();
    if (locales) {
      els.play.disabled = false;
      setHint("Tip: click any word in the reading pane to start from there.");
    } else if (!synth.getVoices().length) {
      refuseNoVoices();
    } else if (!state.onDevice.length) {
      // Voices are on offer, but every one of them is a network voice.
      refuseNetworkOnly();
    } else {
      refuseNoChinese();
    }
    if (els.source.value.trim()) render(els.source.value);
    document.documentElement.dataset.ready = "true";
  };

  let tries = 0;
  const attempt = () => {
    if (applyVoices()) return settle();
    if (++tries > 40) return settle(); // ~6s of polling is plenty
    setTimeout(attempt, 150);
  };

  if (synth.addEventListener) {
    synth.addEventListener("voiceschanged", () => {
      if (settled) applyVoices();
      else attempt();
    });
  }

  attempt();
}

boot();
