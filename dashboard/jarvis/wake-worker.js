/* Listens for "Hey Jarvis" with openWakeWord's three small models. Nothing here leaves the browser.
   Same steps as openWakeWord's own Python: audio, then mel frames, then embeddings, then a score. */
importScripts("oww/ort.wasm.min.js?v=1.20.1");
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL("oww/", self.location.href).href;

const CHUNK = 1280, OVERLAP = 480, MEL_WINDOW = 76, EMBEDDINGS = 16, MAX_BACKLOG = 12, SETTLE_FRAMES = 5;
let threshold = 0.5;  // the page sets it from his sensitivity setting
let mel, embed, wake, previous, melFrames, features, seen = 0, queue = [], busy = false, framesTimed = 0, msTotal = 0, peak = 0;

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
  queue.push(e.data);
  if (wake) drain();
};

(async () => {
  try {
    reset();
    const load = name => ort.InferenceSession.create(new URL("oww/" + name, self.location.href).href, { executionProviders: ["wasm"] });
    [mel, embed, wake] = await Promise.all([load("melspectrogram.onnx"), load("embedding_model.onnx"), load("hey_jarvis_v0.1.onnx")]);
    postMessage({ type: "ready" });
    drain();
  } catch (error) {
    postMessage({ type: "failed", error: String(error && error.message || error) });
  }
})();
