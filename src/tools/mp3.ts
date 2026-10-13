import type { FileHandle } from 'node:fs/promises';

// Reads what Fireside's MP3 suggestions are about (channels, bitrate, sample rate) from an MP3's own
// headers: the first MPEG audio frame, and the Xing, Info or VBRI header a variable-bitrate encoder
// writes into it. No decoding, and no dependency.

export interface AudioInfo {
  channels: 'mono' | 'stereo' | 'joint stereo' | 'dual channel';
  /** Average for a variable-bitrate file. */
  bitrate_kbps: number;
  variable_bitrate: boolean;
  sample_rate_hz: number;
  duration_seconds: number;
}

/** What the Fireside dashboard suggests for MP3 uploads. The API documentation does not list them. */
export const SUGGESTED = { channels: 'mono', minKbps: 64, maxKbps: 96, sampleRateHz: 44_100 } as const;

const SCAN_BYTES = 64 * 1024;
const CHANNELS = ['stereo', 'joint stereo', 'dual channel', 'mono'] as const;
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] };

interface Frame {
  mpeg1: boolean;
  kbps: number;
  sampleRate: number;
  channelMode: number;
  length: number;
}

/** A Layer III frame header at `at`, or undefined when the bytes there are not one. */
function frameAt(buf: Uint8Array, at: number): Frame | undefined {
  if (at + 4 > buf.length || buf[at] !== 0xff || (buf[at + 1]! & 0xe0) !== 0xe0) return undefined;
  const version = (buf[at + 1]! >> 3) & 3; // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5, 1 reserved
  const layer = (buf[at + 1]! >> 1) & 3; // 1 is Layer III
  const bitrateIndex = buf[at + 2]! >> 4;
  const rateIndex = (buf[at + 2]! >> 2) & 3;
  const sampleRate = SAMPLE_RATES[version]?.[rateIndex];
  if (layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRate === undefined) return undefined;
  const mpeg1 = version === 3;
  const kbps = (mpeg1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex]!;
  const padding = (buf[at + 2]! >> 1) & 1;
  const length = Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / sampleRate) + padding;
  return { mpeg1, kbps, sampleRate, channelMode: buf[at + 3]! >> 6, length };
}

async function read(handle: FileHandle, position: number, length: number): Promise<Uint8Array> {
  const buf = new Uint8Array(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

function uint32(buf: Uint8Array, at: number): number | undefined {
  if (at + 4 > buf.length) return undefined;
  return ((buf[at]! << 24) | (buf[at + 1]! << 16) | (buf[at + 2]! << 8) | buf[at + 3]!) >>> 0;
}

function tagAt(buf: Uint8Array, at: number, tag: string): boolean {
  return at + tag.length <= buf.length && [...tag].every((c, i) => buf[at + i] === c.charCodeAt(0));
}

/** The file's audio properties, or undefined when it holds no MPEG Layer III audio. */
export async function readMp3(handle: FileHandle, size: number): Promise<AudioInfo | undefined> {
  // An ID3v2 tag comes first and can be large (embedded artwork); its size is stored syncsafe.
  const head = await read(handle, 0, 10);
  let start = 0;
  if (tagAt(head, 0, 'ID3') && head.length === 10) {
    start = 10 + ((head[6]! << 21) | (head[7]! << 14) | (head[8]! << 7) | head[9]!) + (head[5]! & 0x10 ? 10 : 0);
  }
  const buf = await read(handle, start, SCAN_BYTES);

  for (let at = 0; at + 4 <= buf.length; at++) {
    const frame = frameAt(buf, at);
    if (!frame) continue;
    // A real stream has another frame right after this one; a lone match is usually chance.
    const next = at + frame.length;
    if (next + 4 <= buf.length && !frameAt(buf, next)) continue;

    const mono = frame.channelMode === 3;
    // An encoder's Info frame can carry a different channel mode from the audio after it (LAME writes stereo
    // ahead of joint stereo), so the label comes from the next frame when there is one.
    const channelMode = frameAt(buf, next)?.channelMode ?? frame.channelMode;
    const samplesPerFrame = frame.mpeg1 ? 1152 : 576;
    const tail = await read(handle, Math.max(0, size - 128), 128);
    const audioBytes = size - (start + at) - (tagAt(tail, 0, 'TAG') ? 128 : 0);

    // Xing or Info sits after the side information; VBRI at a fixed offset.
    const xing = at + 4 + (frame.mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17);
    let frames: number | undefined;
    let bytes: number | undefined;
    let variable = false;
    if (tagAt(buf, xing, 'Xing') || tagAt(buf, xing, 'Info')) {
      variable = tagAt(buf, xing, 'Xing');
      const flags = uint32(buf, xing + 4) ?? 0;
      let field = xing + 8;
      if (flags & 1) {
        frames = uint32(buf, field);
        field += 4;
      }
      if (flags & 2) bytes = uint32(buf, field);
    } else if (tagAt(buf, at + 36, 'VBRI')) {
      variable = true;
      bytes = uint32(buf, at + 36 + 10);
      frames = uint32(buf, at + 36 + 14);
    }

    const duration = frames
      ? (frames * samplesPerFrame) / frame.sampleRate
      : (Math.max(audioBytes, 0) * 8) / (frame.kbps * 1000);
    const kbps = frames && duration > 0 ? ((bytes ?? audioBytes) * 8) / duration / 1000 : frame.kbps;
    return {
      channels: CHANNELS[channelMode]!,
      bitrate_kbps: Math.round(kbps),
      variable_bitrate: variable,
      sample_rate_hz: frame.sampleRate,
      duration_seconds: Math.round(duration),
    };
  }
  return undefined;
}

/** How the audio differs from Fireside's suggestions, in words; empty when it matches. */
export function differences(audio: AudioInfo): string[] {
  const out: string[] = [];
  if (audio.channels !== SUGGESTED.channels) out.push(`${audio.channels}, not mono`);
  if (audio.bitrate_kbps < SUGGESTED.minKbps || audio.bitrate_kbps > SUGGESTED.maxKbps) {
    out.push(`${audio.bitrate_kbps} kb/s${audio.variable_bitrate ? ' on average' : ''}, not 64–96 kb/s`);
  }
  if (audio.sample_rate_hz !== SUGGESTED.sampleRateHz) {
    out.push(`a ${audio.sample_rate_hz / 1000} kHz sample rate, not 44.1 kHz`);
  }
  return out;
}
