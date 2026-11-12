/* Listens for "Hey Jarvis" with openWakeWord's three small models, and tells speech from noise with Silero VAD while a command is
   being recorded (Daniel, 2026-11-12: loudness alone took the TV for talking and cut him off mid-pause). Nothing here leaves the browser.
   Wake word: the same steps as openWakeWord's own Python: audio, then mel frames, then embeddings, then a score.
   VAD: Silero v5 on 512-sample windows with 64 samples of context, its state carried from window to window. */
importScripts("oww/ort.wasm.min.js?v=1.20.1");
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL("oww/", self.location.href).href;

const CHUNK = 1280, OVERLAP = 480, MEL_WINDOW = 76, EMBEDDINGS = 16, MAX_BACKLOG = 12, SETTLE_FRAMES = 5;
let threshold = 0.5;  // the page sets it from his sensitivity setting
let mel, embed, wake, previous, melFrames, features, seen = 0, queue = [], busy = false, framesTimed = 0, msTotal = 0, peak = 0;
let mode = { wake: true, vad: false };  // the page says which it needs: the wake word while waiting, speech detection while recording
let vad = null, vadState, vadContext, vadRest, vadChain = Promise.resolve();
const SR = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);

function vadReset() {
  vadState = new Float32Array(2 * 128);
  vadContext = new Float32Array(64);
  vadRest = new Float32Array(0);
}

/* The highest speech probability in this block (80 ms): Silero takes 32 ms windows, so leftovers wait for the next block. */
async function vadBlock(samples) {
  const all = new Float32Array(vadRest.length + samples.length);
  all.set(vadRest); all.set(samples, vadRest.length);
  let p = 0, i = 0;
  for (; i + 512 <= all.length; i += 512) {
    const x = new Float32Array(576);
    x.set(vadContext); x.set(all.subarray(i, i + 512), 64);
    vadContext = all.slice(i + 448, i + 512);
    const out = await vad.run({ input: new ort.Tensor("float32", x, [1, 576]), state: new ort.Tensor("float32", vadState, [2, 1, 128]), sr: SR });
    vadState = Float32Array.from(out.stateN.data);
    p = Math.max(p, out.output.data[0]);
  }
  vadRest = all.slice(i);
  return p;
}

function reset() {
  previous = new Float32Array(OVERLAP);
  melFrames = Array.from({ length: MEL_WINDOW }, () => new Float32Array(32).fill(1));
  features = [];
  seen = 0;
  queue = [];
}

async function score(samples) {
  const input = new Float32Array(CHUNK + OVERLAP);
  input.set(previous);
  for (let i = 0; i < CHUNK; i++) input[OVERLAP + i] = samples[i] * 32767;
  previous = input.slice(-OVERLAP);

  const melOut = Object.values(await mel.run({ [mel.inputNames[0]]: new ort.Tensor("float32", input, [1, input.length]) }))[0];
  const count = melOut.data.length / 32;
  for (let f = 0; f < count; f++) {
    const frame = new Float32Array(32);
    for (let b = 0; b < 32; b++) frame[b] = melOut.data[f * 32 + b] / 10 + 2;
    melFrames.push(frame);
  }
  melFrames = melFrames.slice(-MEL_WINDOW);

  const window = new Float32Array(MEL_WINDOW * 32);
  melFrames.forEach((frame, i) => window.set(frame, i * 32));
  const embedOut = Object.values(await embed.run({ [embed.inputNames[0]]: new ort.Tensor("float32", window, [1, MEL_WINDOW, 32, 1]) }))[0];
  features.push(Float32Array.from(embedOut.data));
  if (features.length > EMBEDDINGS) features.shift();
  if (features.length < EMBEDDINGS) return 0;

  const joined = new Float32Array(EMBEDDINGS * 96);
  features.forEach((f, i) => joined.set(f, i * 96));
  const out = Object.values(await wake.run({ [wake.inputNames[0]]: new ort.Tensor("float32", joined, [1, EMBEDDINGS, 96]) }))[0];
  return out.data[0];
}

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    if (queue.length > MAX_BACKLOG) queue.splice(0, queue.length - 1);  // a slow device stays current rather than falling behind
    const samples = queue.shift(), started = performance.now();
    const value = await score(samples);
    msTotal += performance.now() - started; framesTimed++;
    if (++seen > SETTLE_FRAMES) {
      if (value > peak) peak = value;
      if (value >= threshold) { postMessage({ type: "wake", score: value }); reset(); }
    }
    if (framesTimed === 50) {
      postMessage({ type: "stats", ms: msTotal / framesTimed, peak });
      framesTimed = 0; msTotal = 0; peak = 0;
    }
  }
  busy = false;
}

self.onmessage = async e => {
  if (e.data && e.data.type === "reset") return reset();
  if (e.data && e.data.type === "threshold") { threshold = Math.min(0.9, Math.max(0.2, Number(e.data.value) || 0.5)); return; }
  if (e.data && e.data.type === "mode") {
    if (e.data.vad && !mode.vad) vadReset();
    mode = { wake: Boolean(e.data.wake), vad: Boolean(e.data.vad) };
    return;
  }
  const samples = e.data;
  if (mode.vad && vad) {  // in order, one block at a time: each window carries the last one's state
    vadChain = vadChain.then(() => vadBlock(samples)).then(p => postMessage({ type: "vad", p })).catch(() => postMessage({ type: "vad", p: -1 }));
  }
  if (mode.wake) {
    queue.push(samples);
    if (wake) drain();
  }
};

(async () => {
  try {
    reset();
    const load = name => ort.InferenceSession.create(new URL("oww/" + name, self.location.href).href, { executionProviders: ["wasm"] });
    [mel, embed, wake] = await Promise.all([load("melspectrogram.onnx"), load("embedding_model.onnx"), load("hey_jarvis_v0.1.onnx")]);
    try {
      vad = await ort.InferenceSession.create(new URL("vad/silero_vad.onnx", self.location.href).href, { executionProviders: ["wasm"] });
      vadReset();
    } catch (error) { vad = null; }  // without it, the page goes by loudness as before
    postMessage({ type: "ready", vad: Boolean(vad) });
    drain();
  } catch (error) {
    postMessage({ type: "failed", error: String(error && error.message || error) });
  }
})();
