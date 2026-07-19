'use strict';

// Windows TTS → 16 kHz mono WAV. Ground-truth speech for automated tests.
const { spawnSync } = require('child_process');

function synthWav(text, outPath, rate) {
  const ps = `
Add-Type -AssemblyName System.Speech;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);
$s.SetOutputToWaveFile('${outPath.replace(/'/g, "''")}', $fmt);
$s.Rate = ${rate | 0};
$s.Speak('${text.replace(/'/g, "''")}');
$s.Dispose();`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`TTS failed: ${(r.stderr || '').slice(0, 300)}`);
  return outPath;
}

// Speak through the speakers (async) — used by the chained E2E loopback attempt.
function speakAloud(text, rate) {
  const ps = `
Add-Type -AssemblyName System.Speech;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$s.Rate = ${rate | 0};
$s.Volume = 100;
$s.Speak('${text.replace(/'/g, "''")}');
$s.Dispose();`;
  return require('child_process').spawn('powershell', ['-NoProfile', '-Command', ps], {
    stdio: 'ignore', windowsHide: true,
  });
}

module.exports = { synthWav, speakAloud };
