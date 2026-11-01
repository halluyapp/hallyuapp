/**
 * TextEncoder / TextDecoder polyfill for Hermes (React Native / Expo).
 *
 * WHY THIS EXISTS
 * ---------------
 * Hermes (RN 0.74) ships neither of the WHATWG globals. Several bundled dependencies construct
 * them at MODULE-EVALUATION time, so merely importing them threw
 *   Property 'TextDecoder' doesn't exist       (Hermes' wording for an undeclared global)
 * while `app/_layout.tsx` was still evaluating. That killed the whole root-layout module, so its
 * `ErrorBoundary` import resolved to `undefined` and React then reported
 *   TypeError: Cannot read property 'ErrorBoundary' of undefined
 * — one crash, two messages, both release-only.
 *
 * The module-scope offenders on that chain were `fast-png` (`var latin1Decoder = new
 * TextDecoder('latin1')`) and `iobuffer` (`var encoder = new TextEncoder()`), reached via the now
 * deleted watermark compositor. Some bundled libraries use both too, lazily.
 *
 * CURRENT STATUS: the offenders are gone — the watermark chain was deleted and no backend client
 * ships with the app, so nothing in the app constructs these globals today. This stays as a
 * safety net: Hermes still has neither global, the cost is a no-op at runtime, and the failure mode
 * it prevents (one lazily-evaluating dependency collapsing the root layout) is invisible until a
 * release build boots on a device.
 *
 * This must be installed BEFORE any route module can evaluate: it is the first import of both
 * `index.js` (the bundle entry) and `app/_layout.tsx`. It is a strict no-op wherever the globals
 * already exist (web, Node, any future Hermes that provides them), so it never overrides a native
 * implementation.
 *
 * Scope: UTF-8 (the DOM default), windows-1252 (which the `latin1`/`ascii` labels map to), and
 * UTF-16 LE/BE — everything this app and its dependencies actually request. Invalid UTF-8 becomes
 * U+FFFD, or throws when `fatal: true`, matching the WHATWG algorithm. Encoders always emit UTF-8.
 */

interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

interface TextEncoderEncodeIntoResult {
  read: number;
  written: number;
}

type EncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

type EncodingGlobal = typeof globalThis & {
  TextEncoder?: unknown;
  TextDecoder?: unknown;
};

/** WHATWG label → canonical encoding name (https://encoding.spec.whatwg.org/#names-and-labels). */
function normalizeEncoding(label?: string): EncodingName {
  const l = (label ?? 'utf-8').trim().toLowerCase();
  if (l === 'utf-8' || l === 'utf8' || l === 'unicode-1-1-utf-8' || l === 'unicode11utf8' || l === 'unicode20utf8' || l === 'x-unicode20utf8') {
    return 'utf-8';
  }
  if (l === 'utf-16le' || l === 'utf-16' || l === 'ucs-2' || l === 'unicode' || l === 'iso-10646-ucs-2') {
    return 'utf-16le';
  }
  if (l === 'utf-16be') return 'utf-16be';
  if (l === 'latin1' || l === 'iso-8859-1' || l === 'iso8859-1' || l === 'iso88591' || l === 'l1' || l === 'ascii' || l === 'us-ascii' || l === 'windows-1252' || l === 'cp1252') {
    return 'windows-1252';
  }
  return 'utf-8';
}

/** The 0x80–0x9F range as windows-1252 maps it; unmapped bytes (0x81, 0x8D, …) stay as-is. */
const WINDOWS_1252_C1: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const REPLACEMENT = '\uFFFD';

/** Coerce any BufferSource into a byte view without copying beyond what is necessary. */
function toBytes(input?: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input === undefined || input === null) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

/** U+10000+ needs a surrogate pair; everything else is a single unit. */
function fromCodePoint(codePoint: number): string {
  if (codePoint <= 0xffff) return String.fromCharCode(codePoint);
  const v = codePoint - 0x10000;
  return String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
}

function decodeUtf8(bytes: Uint8Array, fatal: boolean): string {
  const out: string[] = [];
  const len = bytes.length;
  let i = 0;
  while (i < len) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out.push(String.fromCharCode(b0));
      continue;
    }
    let codePoint: number;
    let extra: number;
    let min: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      codePoint = b0 & 0x1f;
      extra = 1;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      codePoint = b0 & 0x0f;
      extra = 2;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      codePoint = b0 & 0x07;
      extra = 3;
      min = 0x10000;
    } else {
      if (fatal) throw new TypeError('The encoded data was not valid UTF-8.');
      out.push(REPLACEMENT);
      continue;
    }
    let ok = true;
    for (let j = 0; j < extra; j++) {
      const b = i < len ? bytes[i] : -1;
      if (b < 0x80 || b > 0xbf) {
        ok = false;
        break;
      }
      codePoint = (codePoint << 6) | (b & 0x3f);
      i++;
    }
    if (!ok || codePoint < min || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      if (fatal) throw new TypeError('The encoded data was not valid UTF-8.');
      out.push(REPLACEMENT);
      continue;
    }
    out.push(fromCodePoint(codePoint));
  }
  return out.join('');
}

function decodeSingleByte(bytes: Uint8Array, mapC1: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const mapped = mapC1 && b >= 0x80 && b <= 0x9f ? WINDOWS_1252_C1[b] : undefined;
    out.push(String.fromCharCode(mapped ?? b));
  }
  return out.join('');
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const out: string[] = [];
  const len = bytes.length - (bytes.length % 2);
  for (let i = 0; i < len; i += 2) {
    const unit = littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
    out.push(String.fromCharCode(unit));
  }
  if (len !== bytes.length) out.push(REPLACEMENT);
  return out.join('');
}

class PolyTextDecoder {
  readonly encoding: EncodingName;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  constructor(label?: string, options?: TextDecoderOptions) {
    this.encoding = normalizeEncoding(label);
    this.fatal = options?.fatal === true;
    this.ignoreBOM = options?.ignoreBOM === true;
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    let bytes = toBytes(input);
    if (!this.ignoreBOM) {
      if (this.encoding === 'utf-8' && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        bytes = bytes.subarray(3);
      } else if (this.encoding === 'utf-16le' && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        bytes = bytes.subarray(2);
      } else if (this.encoding === 'utf-16be' && bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        bytes = bytes.subarray(2);
      }
    }
    switch (this.encoding) {
      case 'utf-16le':
        return decodeUtf16(bytes, true);
      case 'utf-16be':
        return decodeUtf16(bytes, false);
      case 'windows-1252':
        return decodeSingleByte(bytes, true);
      default:
        return decodeUtf8(bytes, this.fatal);
    }
  }
}

class PolyTextEncoder {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    const str = String(input);
    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
      let cp = str.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          cp = ((cp - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
          i++;
        } else {
          cp = 0xfffd; // lone high surrogate
        }
      } else if (cp >= 0xdc00 && cp <= 0xdfff) {
        cp = 0xfffd; // lone low surrogate
      }
      if (cp < 0x80) {
        bytes.push(cp);
      } else if (cp < 0x800) {
        bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
    }
    return Uint8Array.from(bytes);
  }

  /** Writes as many complete code points as fit into `destination`, per the WHATWG contract. */
  encodeInto(source: string, destination: Uint8Array): TextEncoderEncodeIntoResult {
    const str = String(source);
    let read = 0;
    let written = 0;
    for (let i = 0; i < str.length; i++) {
      let cp = str.charCodeAt(i);
      let consumed = 1;
      if (cp >= 0xd800 && cp <= 0xdbff) {
        const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          cp = ((cp - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
          consumed = 2;
        } else {
          cp = 0xfffd;
        }
      } else if (cp >= 0xdc00 && cp <= 0xdfff) {
        cp = 0xfffd;
      }
      let encoded: number[];
      if (cp < 0x80) encoded = [cp];
      else if (cp < 0x800) encoded = [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
      else if (cp < 0x10000) encoded = [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
      else encoded = [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
      if (written + encoded.length > destination.length) break;
      for (let k = 0; k < encoded.length; k++) destination[written + k] = encoded[k];
      written += encoded.length;
      read += consumed;
      i += consumed - 1;
    }
    return { read, written };
  }
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const len = clean.length;
  if (len === 0) return new Uint8Array(0);
  const placeHolders = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const byteLen = ((len * 3) >> 2) - placeHolders;
  const bytes = new Uint8Array(byteLen);
  let cur = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64_LOOKUP[clean.charCodeAt(i)];
    const b = B64_LOOKUP[clean.charCodeAt(i + 1)];
    const c = B64_LOOKUP[clean.charCodeAt(i + 2)];
    const d = B64_LOOKUP[clean.charCodeAt(i + 3)];
    bytes[cur++] = (a << 2) | (b >> 4);
    if (cur < byteLen) bytes[cur++] = ((b & 15) << 4) | (c >> 2);
    if (cur < byteLen) bytes[cur++] = ((c & 3) << 6) | (d & 63);
  }
  return bytes;
}

export function polyAtob(b64: string): string {
  const bytes = decodeBase64(b64);
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}

export function polyBtoa(bin: string): string {
  const len = bin.length;
  let res = '';
  let i = 0;
  while (i < len) {
    const b1 = bin.charCodeAt(i++);
    const b2 = i < len ? bin.charCodeAt(i++) : NaN;
    const b3 = i < len ? bin.charCodeAt(i++) : NaN;
    res += B64_CHARS.charAt(b1 >> 2);
    res += B64_CHARS.charAt(((b1 & 3) << 4) | (Number.isNaN(b2) ? 0 : b2 >> 4));
    res += Number.isNaN(b2) ? '=' : B64_CHARS.charAt(((b2 & 15) << 2) | (Number.isNaN(b3) ? 0 : b3 >> 6));
    res += Number.isNaN(b3) ? '=' : B64_CHARS.charAt(b3 & 63);
  }
  return res;
}

const target = globalThis as EncodingGlobal & { atob?: unknown; btoa?: unknown };
if (typeof target.TextEncoder === 'undefined') target.TextEncoder = PolyTextEncoder;
if (typeof target.TextDecoder === 'undefined') target.TextDecoder = PolyTextDecoder;
if (typeof target.atob === 'undefined') target.atob = polyAtob;
if (typeof target.btoa === 'undefined') target.btoa = polyBtoa;
