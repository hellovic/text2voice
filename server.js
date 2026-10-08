/**
 * Textbook-to-Voice — local web server.
 *
 * Serves the front end and bridges it to the on-device macOS speech engine
 * (bin/speak). Nothing here touches the network: speech is produced by the
 * built-in system voices on this Mac.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HELPER_SRC = path.join(__dirname, 'native', 'speak.m');
const HELPER_BIN = path.join(__dirname, 'bin', 'speak');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

/* ------------------------------------------------------------------ *
 * Build the native helper
 * ------------------------------------------------------------------ */

function needsBuild() {
  if (!fs.existsSync(HELPER_BIN)) return true;
  const bin = fs.statSync(HELPER_BIN);
  const src = fs.statSync(HELPER_SRC);
  return src.mtimeMs > bin.mtimeMs;
}

function buildHelper({ force = false } = {}) {
  if (!force && !needsBuild()) return;
  console.log('[build] compiling native/speak.m -> bin/speak');
  fs.mkdirSync(path.dirname(HELPER_BIN), { recursive: true });
  const result = spawnSync(
    'clang',
    [
      '-fobjc-arc',
      '-O2',
      '-Wno-deprecated-declarations',
      '-o',
      HELPER_BIN,
      HELPER_SRC,
      '-framework',
      'AVFoundation',
      '-framework',
      'AppKit',
      '-framework',
      'Foundation',
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(
      'Failed to compile the speech helper. Install the Xcode Command Line Tools (xcode-select --install) and try again.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Speech engine (one long-lived child process, NDJSON on stdio)
 * ------------------------------------------------------------------ */

class SpeechEngine {
  constructor() {
    this.child = null;
    this.buffer = '';
    /** The speech session currently streaming to a client: { id, sink }. */
    this.session = null;
    /** Pending `list` request. */
    this.pendingList = null;
    /** Cached catalogue; dropped by listVoices(true) so it can be re-read. */
    this.voices = null;
    this.nextId = 1;
    /** Incremented per spawn; lets replaced processes recognise stale handlers. */
    this.generation = 0;
  }

  start() {
    if (this.child && !this.child.killed) return;
    // Bumped on every spawn so listeners belonging to a replaced process can
    // tell that they are stale and stay quiet.
    const generation = ++this.generation;
    const child = spawn(HELPER_BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (generation === this.generation) this.onData(chunk);
    });
    child.on('exit', (code, signal) => {
      if (generation !== this.generation) return; // deliberately replaced
      const hadSession = Boolean(this.session);
      this.child = null;
      this.buffer = '';
      if (this.session) {
        this.session.sink.write({ event: 'error', message: `Speech engine exited (${signal || code})` });
        this.session.sink.close();
        this.session = null;
      }
      if (this.pendingList) {
        this.pendingList.reject(new Error('Speech engine exited'));
        this.pendingList = null;
      }
      if (!hadSession) console.error(`[speak] engine exited (${signal || code})`);
    });
    child.on('error', (err) => {
      if (generation !== this.generation) return;
      console.error('[speak] failed to launch engine:', err.message);
    });
  }

  send(command) {
    if (!this.child) this.start();
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(command) + '\n');
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // ignore anything that is not protocol
      }
      this.dispatch(event);
    }
  }

  dispatch(event) {
    if (event.event === 'ready') return;

    if (event.event === 'voices') {
      this.pendingList?.resolve(event.voices ?? []);
      this.pendingList = null;
      return;
    }

    const session = this.session;
    if (!session) return;

    // Starting a new utterance implicitly stops the previous one; that stale
    // `stopped` carries the *old* id and must not end the new stream.
    if (event.id !== session.id) return;

    session.sink.write(event);
    if (event.event === 'end' || event.event === 'stopped' || event.event === 'error') {
      this.session = null;
      session.sink.close();
    }
  }

  /** Close the active stream, telling the client playback has ended. */
  endSession() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.sink.write({ event: 'stopped', id: session.id });
    session.sink.close();
  }

  /**
   * Replace the helper process.
   *
   * macOS caches the installed-voice catalogue *inside each process*, so a
   * helper started before a voice was installed goes on reporting the old list
   * forever — re-asking the same child can never reveal the new voice. The
   * process has to be replaced for `availableVoices` to be re-read.
   */
  restartChild() {
    const previous = this.child;
    this.child = null;
    this.buffer = '';
    this.endSession();
    if (previous) {
      console.log(`[voices] re-scanning: replacing engine pid ${previous.pid}`);
      previous.kill(); // its listeners see a stale generation
    }
    this.start();
  }

  listVoices(force = false) {
    // Enumerating voices is slow (several hundred ms), so a successful read is
    // cached. `force` drops the cache so a voice the reader has just installed
    // in VoiceOver Utility becomes reachable without restarting the server.
    if (force) {
      this.voices = null;
      if (this.pendingList) {
        this.pendingList.reject(new Error('Voice scan restarted'));
        this.pendingList = null;
      }
      this.restartChild();
    }
    if (this.voices) return Promise.resolve(this.voices);
    if (this.pendingList) return this.pendingList.promise;
    this.start();
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Cache on the derived promise, so a caller that arrives while the list is
    // still in flight observes the same cached write.
    const settled = promise.then((voices) => {
      this.voices = voices;
      return voices;
    });
    this.pendingList = { resolve, reject, promise: settled };
    this.send({ cmd: 'list' });
    return settled;
  }

  /** Begin a speech session; `sink` receives every event for this utterance. */
  speak({ text, voiceId, locale, rate, offset }, sink) {
    this.start();
    // Only one reader at a time: abandon any previous stream.
    if (this.session) {
      const previous = this.session;
      this.session = null;
      previous.sink.close();
    }
    const id = String(this.nextId++);
    this.session = { id, sink };
    this.send({ cmd: 'speak', id, text, voiceId, locale, rate });
    return id;
  }

  control(action) {
    if (!this.child) return false;
    if (action === 'stop' && !this.session) return false;
    this.send({ cmd: action });
    return true;
  }

  /** Stop the engine only if `sessionId` is still the active one. */
  abandon(sessionId) {
    if (this.session?.id !== sessionId) return;
    this.control('stop');
  }

  shutdown() {
    if (!this.child) return;
    try {
      this.send({ cmd: 'quit' });
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    this.child.kill();
    this.child = null;
  }
}

const engine = new SpeechEngine();

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  // Refuse to serve anything outside public/.
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/** Query flags arrive as strings; treat "?refresh=0" as false, not as present. */
function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

async function handleVoices(res, refresh = false) {
  try {
    const voices = await engine.listVoices(refresh);
    sendJson(res, 200, { voices, refreshed: refresh });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleSpeak(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: `Bad request: ${err.message}` });
    return;
  }

  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text.trim()) {
    sendJson(res, 400, { error: 'No text to read' });
    return;
  }

  const requested = Number(payload.offset ?? payload.startOffset) || 0;
  const offset = Math.max(0, Math.min(Math.floor(requested), text.length));
  const rate = Math.max(0, Math.min(1, Number(payload.rate) || 0.5));

  console.log(
    `[speak] ${text.length} chars${offset ? ` from ${offset}` : ''} · ` +
      `voice=${payload.voiceId || '(default)'} · locale=${payload.locale || '(auto)'} · rate=${rate}`
  );

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  let sessionId = null;

  const sink = {
    write(event) {
      if (closed) return;
      if (event.event === 'start') {
        // Tell the client where this reading began so it can seed its progress.
        event.offset = offset;
      } else if (event.event === 'word') {
        // Word offsets are relative to the slice the engine was given.
        event.loc += offset;
      }
      res.write(JSON.stringify(event) + '\n');
    },
    close() {
      if (closed) return;
      closed = true;
      res.end();
    },
  };

  // The browser navigating away or aborting the fetch must silence the speaker.
  req.on('close', () => {
    if (closed) return;
    closed = true;
    if (sessionId) engine.abandon(sessionId);
  });

  req.on('error', () => {
    if (closed) return;
    closed = true;
    if (sessionId) engine.abandon(sessionId);
  });

  try {
    sessionId = engine.speak(
      {
        // Speak only from the requested word onward; offsets are rebased above.
        text: offset > 0 ? text.slice(offset) : text,
        voiceId: payload.voiceId,
        locale: payload.locale,
        rate,
      },
      sink,
    );
  } catch (err) {
    sink.write({ event: 'error', message: err.message });
    sink.close();
  }
}

function handleControl(req, res) {
  readBody(req)
    .then((raw) => {
      const { action } = JSON.parse(raw || '{}');
      if (!['pause', 'resume', 'stop'].includes(action)) {
        sendJson(res, 400, { error: 'Unknown action' });
        return;
      }
      const ok = engine.control(action);
      sendJson(res, 200, { ok });
    })
    .catch((err) => sendJson(res, 400, { error: err.message }));
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const { pathname } = parsed;
  const method = req.method || 'GET';

  if (pathname === '/api/voices' && method === 'GET') {
    // ?refresh=1 re-enumerates, so a voice installed while we are running shows
    // up in the picker without restarting the server.
    return handleVoices(res, isTruthy(parsed.query.refresh));
  }  if (pathname === '/api/speak' && method === 'POST') return handleSpeak(req, res);
  if (pathname === '/api/control' && method === 'POST') return handleControl(req, res);
  if (pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, pathname);

  sendJson(res, 405, { error: 'Method not allowed' });
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

try {
  buildHelper();
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  Textbook-to-Voice is running:  http://${HOST}:${PORT}\n`);
  console.log('  Reading aloud with the built-in macOS voices — nothing leaves this machine.\n');
  // Warm the engine up so the first click is instant.
  engine.start();
  // Voice enumeration is slow; do it now rather than on the first page load.
  engine
    .listVoices()
    .then((voices) => {
      const zh = voices.filter((v) => /^(zh|yue|cmn)/.test(v.locale)).length;
      console.log(`  ${voices.length} system voices available (${zh} Chinese).\n`);
    })
    .catch((err) => console.error(`  Could not enumerate voices: ${err.message}\n`));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Start with a different port, e.g.:\n`);
    console.error(`    PORT=4400 npm start\n`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    engine.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
