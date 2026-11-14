/**
 * Subtitle parsing for Hallyu TV. Supports WebVTT and SubRip (SRT), which is what MovieBox captions and
 * OpenSubtitles deliver. Pure functions only: no network, no native code, so the rules are unit-tested.
 */

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export type SubtitleFormat = 'vtt' | 'srt';

const TIMING = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

/** Returns the format of a subtitle body, or null when it is neither WebVTT nor SRT with at least one cue. */
export function detectSubtitleFormat(raw: string): SubtitleFormat | null {
  const text = stripBom(raw).trimStart();
  if (text.startsWith('WEBVTT')) return 'vtt';
  return TIMING.test(text.split(/\r?\n/).find((l) => l.includes('-->')) ?? '') ? 'srt' : null;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function toMs(h: string | undefined, m: string, s: string, frac: string): number {
  const fraction = Number(frac.padEnd(3, '0'));
  return (Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s)) * 1000 + fraction;
}

/** Removes markup that a player would not show (<i>, <b>, <c.class>, voice tags, positioning). */
function cleanCueText(lines: string[]): string {
  return lines
    .map((l) => l.replace(/<\/?[^>]+>/g, '').replace(/\{\\an\d\}/g, '').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/**
 * Parses SRT or WebVTT into cues sorted by start time. Blocks without a valid timing line are ignored, and a
 * cue with an end before its start is dropped rather than shown at the wrong time.
 */
export function parseSubtitles(raw: string): SubtitleCue[] {
  const format = detectSubtitleFormat(raw);
  if (!format) return [];
  const lines = stripBom(raw).replace(/\r\n?/g, '\n').split('\n');
  const cues: SubtitleCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = TIMING.exec(lines[i]);
    if (!match) {
      i++;
      continue;
    }
    const startMs = toMs(match[1], match[2], match[3], match[4]);
    const endMs = toMs(match[5], match[6], match[7], match[8]);
    i++;
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].includes('-->')) {
      body.push(lines[i]);
      i++;
    }
    if (endMs > startMs) {
      const text = cleanCueText(body);
      if (text) cues.push({ startMs, endMs, text });
    }
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/**
 * The text to show at a playback position, or null. Binary search over the sorted cues, so it stays cheap on
 * every playback tick even for long films.
 */
export function cueTextAt(cues: SubtitleCue[], positionMs: number): string | null {
  if (cues.length === 0 || !Number.isFinite(positionMs)) return null;
  let lo = 0;
  let hi = cues.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].startMs <= positionMs) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Cues can overlap; scan back a few entries for one still active.
  for (let j = candidate; j >= 0 && j > candidate - 4; j--) {
    if (positionMs >= cues[j].startMs && positionMs < cues[j].endMs) return cues[j].text;
  }
  return null;
}
