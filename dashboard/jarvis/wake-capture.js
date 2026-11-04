/* Audio thread: passes microphone audio on in 80 ms blocks at 16 kHz. */
class WakeCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1280);
    this.filled = 0;
    this.step = sampleRate / 16000;
    this.position = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (; this.position < channel.length; this.position += this.step) {
      this.block[this.filled++] = channel[Math.floor(this.position)];
      if (this.filled === 1280) {
        const out = this.block;
        this.block = new Float32Array(1280);
        this.filled = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    this.position -= channel.length;
    return true;
  }
}
registerProcessor("wake-capture", WakeCapture);
