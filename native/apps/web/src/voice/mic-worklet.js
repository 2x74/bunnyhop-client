// Voice chat microphone tap (voice/capture.ts), an AudioWorklet loaded from the site's own origin (CSP script-src
// 'self'). It collects the microphone's first channel into 20 ms chunks at the context's rate and posts each one to the
// main thread, which resamples to 48 kHz and encodes. While `send` is off it posts only a level every 50 ms (the
// settings meter), so an idle microphone costs nothing past this loop.
class VoiceMicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = Math.round(sampleRate * 0.02);
    this.buf = new Float32Array(this.n);
    this.at = 0;
    this.send = false;
    this.peak = 0;
    this.sq = 0;
    this.count = 0;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.send === "boolean") {
        this.send = e.data.send;
        this.at = 0;
      }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.sq += v * v;
      this.count++;
      if (this.send) {
        this.buf[this.at++] = v;
        if (this.at === this.n) {
          this.port.postMessage({ pcm: this.buf, rate: sampleRate }, [this.buf.buffer]);
          this.buf = new Float32Array(this.n);
          this.at = 0;
        }
      }
    }
    if (this.count >= sampleRate * 0.05) {
      this.port.postMessage({ rms: Math.sqrt(this.sq / this.count) });
      this.sq = 0;
      this.count = 0;
    }
    return true;
  }
}
registerProcessor("voice-mic-tap", VoiceMicTap);
