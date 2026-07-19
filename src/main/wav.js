'use strict';

// Float32 PCM (-1..1) → 16-bit mono WAV buffer.
function encodeWav(float32, sampleRate) {
  const numSamples = float32.length;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);            // fmt chunk size
  buf.writeUInt16LE(1, 20);             // PCM
  buf.writeUInt16LE(1, 22);             // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);             // block align
  buf.writeUInt16LE(16, 34);            // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    let s = float32[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    buf.writeInt16LE(s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0, 44 + i * 2);
  }
  return buf;
}

function computeRms(float32) {
  if (!float32 || float32.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

module.exports = { encodeWav, computeRms };
