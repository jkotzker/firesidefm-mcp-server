import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { differences, readMp3 } from '../src/tools/mp3.js';
import { mp3 } from './helpers/mp3.js';

const dir = mkdtempSync(join(tmpdir(), 'fireside-mp3-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let count = 0;
async function inspect(bytes: Buffer) {
  const path = join(dir, `${count++}.mp3`);
  writeFileSync(path, bytes);
  const handle = await open(path);
  try {
    return await readMp3(handle, bytes.length);
  } finally {
    await handle.close();
  }
}

describe('readMp3', () => {
  it('reads a constant-bitrate file in the suggested settings', async () => {
    const audio = await inspect(mp3({ frames: 1000 }));
    // 1000 frames of 208 bytes at 64 kb/s: 208,000 × 8 / 64,000 = 26 s.
    expect(audio).toEqual({
      channels: 'mono',
      bitrate_kbps: 64,
      variable_bitrate: false,
      sample_rate_hz: 44_100,
      duration_seconds: 26,
    });
    expect(differences(audio!)).toEqual([]);
  });

  it('skips an ID3 tag', async () => {
    expect(await inspect(mp3({ id3: 5000 }))).toMatchObject({ channels: 'mono', bitrate_kbps: 64 });
  });

  it('averages a variable bitrate from the Xing header', async () => {
    // 1000 frames × 1152 samples / 44,100 Hz = 26.12 s; 261,224 bytes × 8 / 26.12 s = 80.0 kb/s.
    const audio = await inspect(mp3({ kbps: 128, xing: { frames: 1000, bytes: 261_224 } }));
    expect(audio).toMatchObject({ bitrate_kbps: 80, variable_bitrate: true, duration_seconds: 26 });
  });

  it('describes each way a file differs from the suggestions', async () => {
    const audio = await inspect(mp3({ kbps: 128, sampleRate: 48_000, mono: false }));
    expect(differences(audio!)).toEqual(['stereo, not mono', '128 kb/s, not 64–96 kb/s', 'a 48 kHz sample rate, not 44.1 kHz']);
  });

  it('takes the channel mode from the audio, not from the encoder header frame', async () => {
    const bytes = mp3({ mono: false, xing: { frames: 20, bytes: 4160 } });
    // As LAME writes it: the Info frame says stereo, the audio frames joint stereo.
    for (let at = 208; at < bytes.length; at += 208) bytes[at + 3] = 0x40;
    expect(await inspect(bytes)).toMatchObject({ channels: 'joint stereo' });
  });

  it('finds no MP3 audio in a WAV file', async () => {
    const wav = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.alloc(4000)]);
    expect(await inspect(wav)).toBeUndefined();
  });

  it('finds no MP3 audio in MPEG Layer II frames', async () => {
    const layer2 = mp3();
    for (let at = 0; at < layer2.length; at += 208) layer2[at + 1] = 0xfd;
    expect(await inspect(layer2)).toBeUndefined();
  });

  it('ignores a lone byte pattern that looks like a frame header', async () => {
    const noise = Buffer.alloc(4000, 0x20);
    noise.set([0xff, 0xfb, 0x50, 0xc0], 100);
    expect(await inspect(noise)).toBeUndefined();
  });
});
