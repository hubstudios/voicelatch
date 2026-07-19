'use strict';

// Whisper emits bracketed/parenthesised non-speech annotations on noise:
// [BLANK_AUDIO], [MUSIC], (coughs), ♪ …  Strip them before anything else.
const ANNOTATION = /\[[^\]]{0,40}\]|\([^)]{0,40}\)|♪+/g;

// Classic whisper hallucinations on (near-)silent audio. Only applied when the
// recording was quiet — real speech legitimately contains these words.
const SILENCE_HALLUCINATIONS = [
  /^thank you\.?$/i,
  /^thanks?\.?$/i,
  /^you\.?$/i,
  /^thanks for watching[.!]?$/i,
  /^thank you for watching[.!]?$/i,
  /^bye[.!]?$/i,
  /^\.+$/,
  /^okay\.?$/i,
  /^so\.?$/i,
];

const FILLERS = /(?:^|\s)(?:um+|uh+|erm+|uhm+|hm+|mhm+)([,.!?;:]?)(?=\s|$)/gi;

// Spoken layout commands ("new line", "new paragraph", "bullet point").
// Boundary-guarded: only converted when preceded by start-of-text or
// punctuation, so prose like "a new line of products" is left alone.
const SPOKEN_COMMANDS = [
  { re: /(^|[.,;:!?…—-]\s*)new line[.,]?(?=\s|$)/gi, out: '$1\n' },
  { re: /(^|[.,;:!?…—-]\s*)new paragraph[.,]?(?=\s|$)/gi, out: '$1\n\n' },
  { re: /(^|[.,;:!?…—-]\s*)bullet point[.,]?[^\S\n]*/gi, out: '$1\n• ' },
];

function applySpokenCommands(text) {
  for (const cmd of SPOKEN_COMMANDS) text = text.replace(cmd.re, cmd.out);
  return text;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary, case-insensitive replacement. Keys that are not plain words
// (contain punctuation/spaces at the edges) fall back to plain substring
// replacement so rules like "v ox" → "VoiceLatch" still work.
function applyReplacements(text, rules) {
  if (!Array.isArray(rules)) return text;
  for (const rule of rules) {
    if (!rule || !rule.from || typeof rule.to !== 'string') continue;
    const from = String(rule.from).trim();
    if (!from) continue;
    const wordLike = /^[\p{L}\p{N}' -]+$/u.test(from);
    const pattern = wordLike
      ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(from)}(?![\\p{L}\\p{N}])`, 'giu')
      : new RegExp(escapeRegex(from), 'gi');
    text = text.replace(pattern, rule.to);
  }
  return text;
}

// Whitespace/punctuation tidy that PRESERVES newlines — spoken layout
// commands insert \n, and collapsing them back to spaces would undo them.
function tidy(text) {
  return text
    .replace(/[^\S\n]+/g, ' ')                  // collapse spaces/tabs, keep \n
    .replace(/ ?\n ?/g, '\n')                   // no stray spaces around breaks
    .replace(/\n{3,}/g, '\n\n')                 // max one blank line
    .replace(/ ([,.!?;:])/g, '$1')              // no space before punctuation
    .replace(/([,.!?;:])(?=[\p{L}\p{N}])/gu, '$1 ') // space after punctuation
    .replace(/,[ ]*,+/g, ',')                   // collapse comma runs (same line)
    .replace(/^[ ,.;:]+/, '')                   // no leading orphan punctuation
    .trim();
}

// First letter of the text, and of every new line/bullet, gets capitalized.
function capitalize(text) {
  return text.replace(/(^|\n)(• )?(\p{Ll})/gu,
    (_m, brk, bullet, ch) => brk + (bullet || '') + ch.toUpperCase());
}

/**
 * Clean a raw whisper transcript.
 * @param {string} raw
 * @param {object} opts {removeFillers, spokenCommands, replacements, rms, silenceRms}
 * @returns {string} cleaned text ('' means: treat as no speech)
 */
function process(raw, opts) {
  opts = opts || {};
  if (typeof raw !== 'string') return '';
  let text = raw.replace(ANNOTATION, ' ');
  // Whisper emits newlines BETWEEN segments — transcription artifacts, not
  // user intent. Flatten them here; the only newlines that survive tidy are
  // the ones spoken commands insert deliberately further down the pipeline.
  text = text.replace(/\s*\n+\s*/g, ' ');
  text = tidy(text);
  if (!text) return '';

  // Quiet recording producing a textbook hallucination → drop it.
  const quiet =
    typeof opts.rms === 'number' &&
    typeof opts.silenceRms === 'number' &&
    opts.rms < opts.silenceRms * 3;
  if (quiet && SILENCE_HALLUCINATIONS.some((re) => re.test(text))) return '';

  if (opts.removeFillers) {
    text = text.replace(FILLERS, (m, punct) => (punct ? punct : ' '));
    text = tidy(text);
  }
  if (opts.spokenCommands) {
    text = applySpokenCommands(text);
  }
  text = applyReplacements(text, opts.replacements);
  text = tidy(text);
  if (!text) return '';
  return capitalize(text);
}

function countWords(text) {
  if (!text) return 0;
  const m = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

module.exports = { process, countWords, applyReplacements, applySpokenCommands, tidy };
