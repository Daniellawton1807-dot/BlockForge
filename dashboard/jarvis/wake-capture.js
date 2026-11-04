/* Audio thread: passes microphone audio on in 80 ms blocks at 16 kHz, whatever rate the device runs at. */
class WakeCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1280);
    this.filled = 0;
    this.step = sampleRate / 16000;
    this.position = 0;
    this.sum = 0;
    this.count = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i];
      this.count++;
      if (++this.position < this.step) continue;
      this.position -= this.step;
      this.block[this.filled++] = this.sum / this.count;  // averaged, since sounds too high for 16 kHz would otherwise fold into speech
      this.sum = this.count = 0;
      if (this.filled === 1280) {
        const out = this.block;
        this.block = new Float32Array(1280);
        this.filled = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("wake-capture", WakeCapture);
