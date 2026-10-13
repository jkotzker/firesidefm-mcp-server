/**
 * Invented MPEG-1 Layer III data: frame headers with zeroed payloads, enough for the header checks.
 * `xing` writes a variable-bitrate header into the first frame; `id3` prepends a tag of that many bytes.
 */
export function mp3(
  options: {
    kbps?: number;
    sampleRate?: number;
    mono?: boolean;
    frames?: number;
    id3?: number;
    xing?: { frames: number; bytes: number };
  } = {},
): Buffer {
  const { kbps = 64, sampleRate = 44_100, mono = true, frames = 20, id3 = 0, xing } = options;
  const bitrateIndex = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320].indexOf(kbps);
  const rateIndex = [44_100, 48_000, 32_000].indexOf(sampleRate);
  if (bitrateIndex < 1 || rateIndex < 0) throw new Error('mp3(): unsupported bitrate or sample rate');
  const length = Math.floor((144 * kbps * 1000) / sampleRate);
  const frame = Buffer.alloc(length);
  frame.set([0xff, 0xfb, (bitrateIndex << 4) | (rateIndex << 2), mono ? 0xc0 : 0x00]);

  const parts: Buffer[] = [];
  if (id3 > 0) {
    const syncsafe = [21, 14, 7, 0].map((shift) => (id3 >> shift) & 0x7f);
    parts.push(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, ...syncsafe]), Buffer.alloc(id3));
  }
  for (let i = 0; i < frames; i++) {
    const copy = Buffer.from(frame);
    if (i === 0 && xing) {
      const at = 4 + (mono ? 17 : 32);
      copy.write('Xing', at, 'latin1');
      copy.writeUInt32BE(3, at + 4);
      copy.writeUInt32BE(xing.frames, at + 8);
      copy.writeUInt32BE(xing.bytes, at + 12);
    }
    parts.push(copy);
  }
  return Buffer.concat(parts);
}
