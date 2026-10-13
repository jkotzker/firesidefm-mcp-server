import type { FileHandle } from 'node:fs/promises';

// Reads what Fireside's MP3 suggestions are about (channels, bitrate, sample rate) from an MP3's own
// headers: the first MPEG audio frames, and the Xing, Info or VBRI header a variable-bitrate encoder
// writes into the first one. No decoding, and no dependency.

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
// The longest Layer III frame: 320 kb/s at 32 kHz (MPEG-1) or 160 kb/s at 8 kHz (MPEG-2.5), plus padding.
const MAX_FRAME = 1441;
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
  const tail = await read(handle, Math.max(0, size - 128), 128);
  const end = size - (tagAt(tail, 0, 'TAG') ? 128 : 0);
  // Enough past the scanned range to see the header that follows any frame starting inside it.
  const buf = await read(handle, start, SCAN_BYTES + MAX_FRAME + 4);

  for (let at = 0; at < Math.min(SCAN_BYTES, buf.length - 3); at++) {
    const frame = frameAt(buf, at);
    if (!frame) continue;
    // A real stream has another frame right after this one, unless this frame is the last in the file.
    // A lone match is chance: compressed data of other formats contains frame-like bytes.
    const next = at + frame.length;
    const following = frameAt(buf, next);
    if (!following && start + next !== end) continue;

    const mono = frame.channelMode === 3;
    // An encoder's Info frame can carry a different channel mode from the audio after it (LAME writes stereo
    // ahead of joint stereo), so the label comes from the next frame when there is one.
    const channelMode = following?.channelMode ?? frame.channelMode;
    const samplesPerFrame = frame.mpeg1 ? 1152 : 576;
    const audioBytes = Math.max(end - (start + at), 0);

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

    let kbps = following?.kbps ?? frame.kbps;
    let duration: number;
    if (frames) {
      duration = (frames * samplesPerFrame) / frame.sampleRate;
      // Info marks a constant bitrate: the frames state it exactly, while bytes over duration would also
      // count the header frame and the encoder's padding, which is noticeable in a short file.
      if (variable && duration > 0) kbps = ((bytes ?? audioBytes) * 8) / duration / 1000;
    } else {
      // No encoder header: estimate from the frames in the scanned range, which vary in a VBR file.
      const sampled = sampleFrames(buf, at);
      if (new Set(sampled.map((f) => f.kbps)).size > 1) {
        variable = true;
        const sampledBytes = sampled.reduce((sum, f) => sum + f.length, 0);
        kbps = (sampledBytes * 8 * frame.sampleRate) / (sampled.length * samplesPerFrame) / 1000;
      }
      duration = (audioBytes * 8) / (kbps * 1000);
    }
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

/** The run of consecutive frames starting at `at` that lies wholly inside `buf`. */
function sampleFrames(buf: Uint8Array, at: number): Frame[] {
  const frames: Frame[] = [];
  for (let frame = frameAt(buf, at); frame && at + frame.length <= buf.length; frame = frameAt(buf, at)) {
    frames.push(frame);
    at += frame.length;
  }
  return frames;
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
