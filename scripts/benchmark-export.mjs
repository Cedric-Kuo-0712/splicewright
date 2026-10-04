// Optional single-run comparison, not a quality-equivalence or statistical performance test.
// node scripts/benchmark-export.mjs <repo> <input-video> <fresh-output-dir>
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cpus, platform, release } from 'node:os';

const [repoArg, inputArg, outputArg] = process.argv.slice(2);
if (!repoArg || !inputArg || !outputArg) throw new Error('Expected repo, input-video, and fresh output directory');
const [repo, input, output] = [repoArg, inputArg, outputArg].map((path) => resolve(path));
if (existsSync(output)) throw new Error(`Refusing to reuse an experiment directory: ${output}`);
mkdirSync(output, { recursive: true });
process.env.SPLICEWRIGHT_HOME = join(output, 'home');
const requireAtRepo = createRequire(join(repo, 'package.json'));
const moduleAtRepo = (name) => import(pathToFileURL(requireAtRepo.resolve(name)).href);
const { init, run } = await moduleAtRepo('@splicewright/core/node');
const { ingest } = await moduleAtRepo('@splicewright/ingest');
const { render, still } = await moduleAtRepo('@splicewright/render/node');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const metadata = (path) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
  'format=duration,size:stream=codec_name,codec_type,codec_tag_string,width,height,r_frame_rate,pix_fmt,color_space,color_transfer,color_primaries', '-of', 'json', path], { encoding: 'utf8' }));
const record = {
  recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
  runnerSha256: hash(new URL(import.meta.url)), host: { platform: platform(), release: release(), cores: cpus().length },
  node: process.version, remotion: requireAtRepo('@remotion/renderer/package.json').version,
  ffprobe: execFileSync('ffprobe', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  input: { path: input, sha256: hash(input), ...metadata(input) },
  order: ['h264-cpu', 'h264-hardware', 'h265-hardware'], runs: [],
  note: 'Warm bundle/browser initialization; each timed render includes composition selection, frames, encoding and audio. One fixed-order observation per mode; no variance estimate or quality equivalence claim.',
};
const dir = join(output, 'project');
const check = (value) => { if ('error' in value) throw new Error(value.error.message); return value; };
let failure;
try {
  check(init(dir, { title: 'Encoder comparison', fps: 30, width: 1280, height: 720 }));
  mkdirSync(join(dir, 'raw'), { recursive: true });
  cpSync(input, join(dir, 'raw', 'motion.mp4'));
  const imported = check(run(dir, 'importAsset', { path: 'raw/motion.mp4' }));
  const assetId = Object.keys(imported.project.assets)[0];
  const probed = await ingest(dir, { assets: [assetId], only: [] });
  if (probed.errors?.length) throw new Error(probed.errors.join('; '));
  check(run(dir, 'insertItem', { assetId, at: 0, duration: 60 }));
  check(run(dir, 'insertItem', { component: 'Text', at: 0, duration: 60, props: { text: 'Hardware export · 264 / 265', style: { fontSize: 36 } } }));
  record.projectSha256 = hash(join(dir, 'project.json'));
  const warmStart = performance.now();
  await still(dir, 0, join(output, 'warmup.png'));
  record.warmupMs = performance.now() - warmStart;
  for (const preset of record.order) {
    const target = join(output, `${preset}.mp4`);
    const runRecord = { preset, output: target, encoding: [] };
    record.runs.push(runRecord);
    const start = performance.now();
    try {
      await render(dir, { output: target, preset, onEncoding: (args) => {
        const at = args.findIndex((arg) => arg === '-c:v' || arg === '-vcodec' || arg === '-codec:v');
        runRecord.encoding.push({ ms: performance.now() - start, encoder: at >= 0 ? args[at + 1] : null, args });
      } });
      runRecord.renderMs = performance.now() - start;
      runRecord.bytes = statSync(target).size;
      runRecord.metadata = metadata(target);
      const video = runRecord.metadata.streams.find((stream) => stream.codec_type === 'video');
      const audio = runRecord.metadata.streams.find((stream) => stream.codec_type === 'audio');
      if (video?.width !== 1280 || video.height !== 720 || video.r_frame_rate !== '30/1') throw new Error('Unexpected output dimensions or frame rate');
      if (record.input.streams.some((stream) => stream.codec_type === 'audio') && audio?.codec_name !== 'aac') throw new Error('Missing expected AAC audio');
      if (preset === 'h265-hardware' && video.codec_tag_string !== 'hvc1') throw new Error('Expected hvc1 HEVC sample entry');
      execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', target, '-f', 'null', '-'], { stdio: 'pipe' });
      runRecord.fullDecode = 'passed';
      const encoder = runRecord.encoding.find((entry) => entry.encoder && entry.encoder !== 'copy')?.encoder;
      const expected = preset === 'h264-cpu' ? 'libx264' : preset === 'h264-hardware'
        ? platform() === 'darwin' ? 'h264_videotoolbox' : 'h264_nvenc'
        : platform() === 'darwin' ? 'hevc_videotoolbox' : 'hevc_nvenc';
      if (encoder !== expected) throw new Error(`Expected ${expected}, observed ${encoder}`);
    } catch (error) { runRecord.error = String(error); throw error; }
  }
} catch (error) { failure = error; record.error = String(error); }
finally { writeFileSync(join(output, 'result.json'), JSON.stringify(record, null, 2) + '\n'); }
if (failure) throw failure;
console.log(JSON.stringify({ commit: record.commit, warmupMs: record.warmupMs, runs: record.runs.map(({ preset, renderMs, bytes, fullDecode }) => ({ preset, renderMs, bytes, fullDecode })), output }));
