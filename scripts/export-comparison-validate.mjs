import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const file = process.argv[2];
if (!file) throw new Error('Usage: node export-comparison-validate.mjs result.json');
const root = dirname(resolve(file)), record = JSON.parse(readFileSync(file));
if (record.status !== 'DONE') throw new Error('Comparison did not complete; retain failed evidence without ranking');
const target = join(root, 'validation.json');
if (existsSync(target)) throw new Error('Refusing to overwrite validation evidence');
const decode = (file, args) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '2', '-i', file, ...args], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
const pixelFrameBytes = 96 * 54 * 3;
function pixelDiagnostics(a, b, frames) {
  const meanError = (frame, bottom) => {
    let sum = 0, count = 0;
    const firstRow = bottom ? 40 : 0, lastRow = bottom ? 54 : 40;
    for (let i = frame * pixelFrameBytes + firstRow * 96 * 3; i < frame * pixelFrameBytes + lastRow * 96 * 3; i++) { sum += Math.abs(a[i] - b[i]); count++; }
    return sum / count;
  };
  return Array.from({ length: frames }, (_, frame) => ({ frame, pictureMeanAbsRgbError: meanError(frame, false), captionRegionMeanAbsRgbError: meanError(frame, true) }));
}
function audioDiagnostics(aBytes, bBytes) {
  const a = new Float32Array(aBytes.buffer, aBytes.byteOffset, aBytes.length / 4), b = new Float32Array(bBytes.buffer, bBytes.byteOffset, bBytes.length / 4);
  const start = 12000, end = Math.min(a.length, b.length) - 12000;
  if (end <= start) return { status: 'too-short' };
  // Search only a small local timing difference. This is relative to the
  // baseline, not proof that the baseline has correct source timestamps.
  const corr = lag => {
    let aa = 0, bb = 0, ab = 0;
    for (let i = start; i < end; i += 32) { const av = a[i], bv = b[i + lag]; aa += av * av; bb += bv * bv; ab += av * bv; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : null;
  };
  let best = 0, bestValue = corr(0);
  for (let lag = -4800; lag <= 4800; lag += 16) { const value = corr(lag); if (value !== null && (bestValue === null || value > bestValue)) { best = lag; bestValue = value; } }
  const coarse = best;
  for (let lag = coarse - 16; lag <= coarse + 16; lag++) { const value = corr(lag); if (value !== null && (bestValue === null || value > bestValue)) { best = lag; bestValue = value; } }
  return { baselineSamples: a.length, candidateSamples: b.length, zeroLagCorrelation: corr(0), bestLagSamples: best, bestLagMs: best / 48, alignedCorrelation: bestValue, status: bestValue === null ? 'silent' : 'measured' };
}
const validation = { startedAt: new Date().toISOString(), sourceResult: resolve(file), status: 'DIAGNOSTICS', cases: [], note: 'SSIM/RGB differences and local audio correlation are diagnostics, not proof of perceptual or temporal equivalence. No thresholds are relaxed to declare a winner.' };
writeFileSync(target, JSON.stringify(validation, null, 2) + '\n');
try {
  for (const c of record.config.cases) {
    const trials = record.trials.filter(t => t.result?.case === c.id);
    const baseline = trials.find(t => t.result.method === 'remotion')?.result, candidate = trials.find(t => t.result.method === 'layered')?.result;
    if (baseline?.status !== 'DONE' || candidate?.status !== 'DONE') throw new Error(`Missing completed pair: ${c.id}`);
    const row = { case: c.id, expected: c.expected, baseline: baseline.output, candidate: candidate.output };
    const log = join(root, `${c.id}-ssim.log`), fd = openSync(log, 'wx');
    try { execFileSync('ffmpeg', ['-nostdin', '-v', 'info', '-threads', '2', '-i', baseline.output, '-threads', '2', '-i', candidate.output, '-filter_complex_threads', '2', '-filter_complex', '[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim', '-an', '-threads', '2', '-f', 'null', '-'], { stdio: ['ignore', fd, fd], timeout: 30000 }); } finally { closeSync(fd); }
    row.ssimAll = Number(/SSIM Y:.*?All:([\d.]+)/.exec(readFileSync(log, 'utf8'))?.[1] ?? NaN);
    const pixels = file => decode(file, ['-vf', 'scale=96:54:flags=area', '-threads', '2', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    const a = pixels(baseline.output), b = pixels(candidate.output);
    if (a.length !== c.frames * pixelFrameBytes || b.length !== a.length) throw new Error('Decoded frame count mismatch');
    row.perFrame = pixelDiagnostics(a, b, c.frames);
    if (c.audio) { const pcm = file => decode(file, ['-map', '0:a:0', '-ac', '1', '-ar', '48000', '-threads', '2', '-f', 'f32le', '-']); row.audio = audioDiagnostics(pcm(baseline.output), pcm(candidate.output)); }
    validation.cases.push(row); writeFileSync(target, JSON.stringify(validation, null, 2) + '\n');
  }
  validation.status = 'DIAGNOSTICS_COMPLETE';
} catch (error) { validation.status = 'FAILED'; validation.error = error.stack ?? String(error); process.exitCode = 1; }
validation.completedAt = new Date().toISOString(); writeFileSync(target, JSON.stringify(validation, null, 2) + '\n');
console.log(JSON.stringify({ status: validation.status, cases: validation.cases.length, file: target }));
