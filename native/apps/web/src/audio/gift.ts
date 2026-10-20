/** Original 720ms crystal arpeggio. Kept deterministic for offline rendering and tests. */
export function supporterGiftWave(sampleRate: number): Float32Array<ArrayBuffer> {
  const data = new Float32Array(Math.ceil(sampleRate * 0.72));
  const notes = [523.25, 659.25, 783.99, 1046.5];
  for (let n = 0; n < notes.length; n++) {
    const start = n * 0.095;
    for (let i = Math.ceil(start * sampleRate); i < data.length; i++) {
      const t = i / sampleRate - start;
      const envelope = Math.min(1, t / 0.006) * Math.exp(-t * 13);
      data[i] += 0.22 * envelope * (Math.sin(2 * Math.PI * notes[n] * t) + 0.18 * Math.sin(4 * Math.PI * notes[n] * t));
    }
  }
  return data;
}
