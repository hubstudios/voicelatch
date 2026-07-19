// Collects mono Float32 PCM blocks and reports a level per block.
// Runs on the audio thread — keep it allocation-light.
class PcmCollector extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) {
      const copy = new Float32Array(ch.length);
      copy.set(ch);
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      this.port.postMessage(
        { samples: copy, rms: Math.sqrt(sum / ch.length) },
        [copy.buffer]
      );
    }
    return true;
  }
}
registerProcessor('pcm-collector', PcmCollector);
