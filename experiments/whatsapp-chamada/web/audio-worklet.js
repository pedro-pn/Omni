// Ponte PCM 16 kHz / s16le. O servidor e o codec usam quadros de 60 ms.
class OmniAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;
    this.capture = new Int16Array(960);
    this.captureIndex = 0;
    this.queue = new Float32Array(16000);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.available = 0;
    this.playing = false;
    this.gain = 0;
    // Dois quadros absorvem pequenas variações na chegada dos pacotes.
    this.prebuffer = 1920;
    this.fadeSamples = 80; // 5 ms a 16 kHz para evitar estalos nas bordas.
    this.port.onmessage = ({data}) => {
      if (data.type === 'mute') { this.muted = data.value; return; }
      if (data.type === 'reset') {
        this.available = this.readIndex = this.writeIndex = this.captureIndex = 0;
        this.playing = false; this.gain = 0;
        return;
      }
      if (data.type !== 'audio') return;
      const view = new DataView(data.buffer);
      for (let i = 0; i < view.byteLength / 2; i++) {
        if (this.available === this.queue.length) { this.readIndex = (this.readIndex + 1) % this.queue.length; this.available--; }
        this.queue[this.writeIndex] = view.getInt16(2 * i, true) / 32768;
        this.writeIndex = (this.writeIndex + 1) % this.queue.length;
        this.available++;
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!this.playing && this.available >= this.prebuffer) this.playing = true;
    for (let i = 0; i < output.length; i++) {
      const sample = this.muted ? 0 : Math.max(-1, Math.min(input?.[i] ?? 0, 32767 / 32768));
      this.capture[this.captureIndex++] = sample * 32768;
      if (this.captureIndex === 960) {
        const buffer = new ArrayBuffer(1920);
        const view = new DataView(buffer);
        for (let j = 0; j < 960; j++) view.setInt16(2*j, this.capture[j], true);
        this.port.postMessage(buffer, [buffer]); this.captureIndex = 0;
      }
      output[i] = 0;
      if (this.playing && this.available) {
        const target = Math.min(1, this.available / this.fadeSamples);
        this.gain = Math.min(target, this.gain + 1 / this.fadeSamples);
        output[i] = this.queue[this.readIndex] * this.gain;
        this.readIndex = (this.readIndex + 1) % this.queue.length; this.available--;
      }
      if (!this.available) { this.playing = false; this.gain = 0; }
    }
    return true;
  }
}
registerProcessor('omni-audio', OmniAudio);
