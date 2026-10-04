import { expect, it } from 'vitest';
import { outputVideoEncoder } from './export-output-encoder.mjs';

it('distinguishes PNG input decoding from the required VideoToolbox export encoder', () => {
  expect(outputVideoEncoder(['-i', 'source.mp4', '-f', 'image2pipe', '-vcodec', 'png', '-i', 'pipe:0', '-c:v', 'hevc_videotoolbox', 'out.mp4'])).toBe('hevc_videotoolbox');
});

it.each(['-c:v', '-codec:v', '-vcodec', '-c:v:0'])('uses the final output-scoped override for %s', flag => {
  expect(outputVideoEncoder(['-i', 'source.mp4', '-c:v', 'libx264', flag, 'h264_videotoolbox', 'out.mp4'])).toBe('h264_videotoolbox');
});

it('never accepts an input decoder as evidence of the output encoder', () => {
  expect(outputVideoEncoder(['-vcodec', 'png', '-i', 'pipe:0', 'out.mp4'])).toBeUndefined();
});
