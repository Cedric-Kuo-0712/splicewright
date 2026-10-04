import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readSync, writeFileSync, appendFileSync, openSync, closeSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cpus, totalmem, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';

// A single paired screening run, with OS-level supervision. Run through the
// project's notification wrapper; the agent must not poll this process.
const args = process.argv.slice(2);
const configFile = args[args.indexOf('--config') + 1];
if (!args.includes('--config') || !configFile) throw new Error('Usage: --config comparison.json [--check]');
const config = JSON.parse(readFileSync(resolve(configFile), 'utf8'));
const root = dirname(resolve(configFile));
const hash = file => {
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(file, 'r');
  try { let bytes; while ((bytes = readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, bytes)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
};
function scratchBytes(dir) {
  if (!existsSync(dir)) return 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  return entries.reduce((sum, entry) => {
    const path = join(dir, entry.name);
    try { return sum + (entry.isSymbolicLink() ? 0 : entry.isDirectory() ? scratchBytes(path) : entry.isFile() ? statSync(path).size : 0); }
    catch (error) { if (error.code === 'ENOENT') return sum; throw error; }
  }, 0);
}
const save = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
function verify() {
  if (!config.cases?.length || !config.methods?.length || !config.renderer) throw new Error('Missing cases/methods/renderer');
  if ((config.exactAudioRequired || config.exactVideoMethods?.length) && !config.decodedHashChecks) throw new Error('Exact output checks require decodedHashChecks');
  if (!(config.guards?.rssMiB > 0 && config.guards.trialSeconds > 0 && config.guards.swapGrowthMiB >= 0)) throw new Error('Invalid guards');
  for (const file of config.fingerprints ?? []) if (hash(file.path) !== file.sha256) throw new Error(`Input changed: ${file.path}`);
  for (const c of config.cases) {
    if (!/^[a-z0-9-]+$/.test(c.id) || !(c.frames > 0 && c.fps > 0 && c.width > 0 && c.height > 0)) throw new Error('Invalid case');
    if (!existsSync(join(c.project, 'project.json'))) throw new Error(`Missing project: ${c.id}`);
    if (c.range && (!Array.isArray(c.range) || c.range.length !== 2 || !c.range.every(Number.isInteger) || c.range[0] < 0 || c.range[1] - c.range[0] !== c.frames)) throw new Error(`Invalid range: ${c.id}`);
  }
  for (const m of config.methods)
    if (!/^[a-z0-9-]+$/.test(m.id) || !existsSync(m.renderer ?? config.renderer)) throw new Error(`Invalid method renderer: ${m.id}`);
  if (config.qualityPolicy) {
    for (const m of config.methods) {
      if (!m.options?.preset || !m.expectedEncoder) throw new Error(`Method ${m.id} must pin preset and expectedEncoder`);
      if (m.options.preset !== config.qualityPolicy.preset) throw new Error(`Method ${m.id} violates shared qualityPolicy.preset`);
    }
    if (config.methods.length !== 2 || JSON.stringify(config.methods[0].options) !== JSON.stringify(config.methods[1].options) ||
        config.methods.some(method => method.expectedEncoder !== config.qualityPolicy.expectedEncoder ||
          method.expectedCodec !== config.qualityPolicy.expectedCodec || method.expectedTag !== config.qualityPolicy.expectedTag))
      throw new Error('Comparison methods must pin identical render options and the quality-policy encoder/container');
  }
}
verify();
const rendererPath = methodId => config.methods.find(m => m.id === methodId)?.renderer ?? config.renderer;
if (args.includes('--check')) {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  console.log(JSON.stringify({ status: 'PREFLIGHT_PASSED', cases: config.cases.length, methods: config.methods.length, guards: config.guards }));
} else if (args.includes('--trial')) {
  const index = args.indexOf('--trial');
  const c = config.cases.find(c => c.id === args[index + 1]);
  const m = config.methods.find(m => m.id === args[index + 2]);
  if (!c || !m) throw new Error('Unknown trial');
  const { render } = await import(pathToFileURL(rendererPath(m.id)).href);
  const name = `${c.id}-${m.id}`, output = join(root, `${name}.mp4`), resultFile = join(root, `${name}.json`);
  if (existsSync(output) || existsSync(resultFile)) throw new Error('Refusing to overwrite trial');
  const record = { status: 'RUNNING', case: c.id, method: m.id, options: m.options, startedAt: new Date().toISOString(), output };
  save(resultFile, record);
  let progressBucket = -1;
  try {
    const start = performance.now();
    record.renderResult = await render(c.project, { ...m.options, ...(c.range ? { range: c.range } : {}), output,
      onEncoding: encoderArgs => {
        appendFileSync(join(root, `${name}-encoding.jsonl`), JSON.stringify(encoderArgs) + '\n');
        const index = encoderArgs.findIndex(arg => arg === '-c:v' || arg === '-vcodec' || arg === '-codec:v');
        if (index >= 0) record.encoder = encoderArgs[index + 1];
        record.encoderArgsSha256 = createHash('sha256').update(JSON.stringify(encoderArgs)).digest('hex');
        if (m.expectedEncoder && record.encoder !== m.expectedEncoder) throw new Error(`Unexpected encoder: ${record.encoder}`);
      },
      onProgress: progress => { const bucket = Math.floor(progress * 50); if (bucket !== progressBucket) { progressBucket = bucket; appendFileSync(join(root, `${name}-progress.jsonl`), JSON.stringify({ elapsedMs: performance.now() - start, progress }) + '\n'); } },
    });
    record.renderMs = performance.now() - start;
    record.stages = [{ name: 'render', elapsedMs: record.renderMs }];
    record.bytes = statSync(output).size;
    const metadataStart = performance.now();
    record.metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,codec_tag_string,width,height,nb_frames,r_frame_rate,sample_rate,channels,color_space,color_range', '-of', 'json', output], { encoding: 'utf8', timeout: 10000 }));
    record.stages.push({ name: 'probe', elapsedMs: performance.now() - metadataStart });
    const video = record.metadata.streams.find(s => s.codec_type === 'video');
    if (!video || Number(video.nb_frames) !== c.frames || video.width !== c.width || video.height !== c.height || Number(video.r_frame_rate.split('/')[0]) / Number(video.r_frame_rate.split('/')[1]) !== c.fps) throw new Error('Output dimensions/frame count/fps mismatch');
    if (m.expectedCodec && video.codec_name !== m.expectedCodec) throw new Error(`Unexpected output codec: ${video.codec_name}`);
    if (m.expectedTag && video.codec_tag_string !== m.expectedTag) throw new Error(`Unexpected codec tag: ${video.codec_tag_string}`);
    if (c.audio && !record.metadata.streams.some(s => s.codec_type === 'audio')) throw new Error('Missing audio');
    if (m.options.pipeline && record.renderResult.pipelineUsed !== m.options.pipeline) throw new Error('Unexpected render route');
    const fd = openSync(join(root, `${name}-decode.log`), 'wx');
    const decodeStart = performance.now();
    try { execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '2', '-i', output, '-threads', '2', '-f', 'null', '-'], { stdio: ['ignore', fd, fd], timeout: 30000 }); } finally { closeSync(fd); }
    record.stages.push({ name: 'full-decode', elapsedMs: performance.now() - decodeStart });
    record.fullDecode = true;
    record.status = 'DONE';
  } catch (error) { record.status = 'FAILED'; record.error = error.stack ?? String(error); process.exitCode = 1; }
  record.completedAt = new Date().toISOString(); save(resultFile, record);
} else {
  const resultFile = join(root, 'result.json');
  if (existsSync(resultFile)) throw new Error('Refusing to overwrite a started comparison');
  const swap = () => platform() === 'darwin' ? Number(/used = ([\d.]+)M/.exec(execFileSync('sysctl', ['vm.swapusage'], { encoding: 'utf8', timeout: 2000 }))?.[1] ?? 0) : null;
  const record = { status: 'RUNNING', startedAt: new Date().toISOString(), config,
    provenance: { node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release(), runnerSha256: hash(import.meta.filename), ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0] },
    initialSwapMiB: swap(), trials: [], limitations: ['One run per case/method, no spread.', 'Case order alternates methods; cache and thermal state are uncontrolled.', 'RSS sums process-group pages and can double-count shared pages.', 'System swap growth is a safety trigger, not attributable memory usage.'],
  };
  const persist = () => save(resultFile, record);
  const signal = (pid, sig) => { try { process.kill(-pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  persist();
  try {
    for (let i = 0; i < config.cases.length && !record.stopReason; i++) {
      const c = config.cases[i];
      for (const m of i % 2 ? [...config.methods].reverse() : config.methods) {
        verify();
        const name = `${c.id}-${m.id}`, fd = openSync(join(root, `${name}.log`), 'wx');
        const scratch = join(root, `${name}-scratch`); mkdirSync(scratch);
        const projectScratch = join(c.project, '.splicewright'), initialProjectBytes = scratchBytes(projectScratch);
        const child = spawn(process.execPath, [import.meta.filename, '--config', resolve(configFile), '--trial', c.id, m.id], { cwd: config.repo, detached: true, env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch }, stdio: ['ignore', fd, fd] });
        const entry = { name, pid: child.pid, startedAt: new Date().toISOString(), peakRssMiB: 0, peakCpuPercent: 0, peakSwapGrowthMiB: 0, peakScratchDiskMiB: 0, samples: 0 };
        record.trials.push(entry); persist(); console.log(JSON.stringify({ event: 'START', name, pid: child.pid }));
        let force;
        const abort = reason => { if (entry.abortReason) return; entry.abortReason = reason; record.stopReason = reason; persist(); signal(child.pid, 'SIGTERM'); force = setTimeout(() => signal(child.pid, 'SIGKILL'), 3000); };
        const ceiling = setTimeout(() => abort('trial timeout'), config.guards.trialSeconds * 1000);
        const sample = setInterval(() => {
          try {
            const rows = execFileSync('ps', ['-axo', 'pid=,pgid=,rss=,%cpu='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number)).filter(row => row[1] === child.pid || row[0] === process.pid);
            const rss = rows.reduce((sum, row) => sum + row[2], 0) / 1024, cpu = rows.reduce((sum, row) => sum + row[3], 0), growth = record.initialSwapMiB === null ? 0 : Math.max(0, swap() - record.initialSwapMiB);
            entry.peakRssMiB = Math.max(entry.peakRssMiB, rss); entry.peakCpuPercent = Math.max(entry.peakCpuPercent, cpu); entry.peakSwapGrowthMiB = Math.max(entry.peakSwapGrowthMiB, growth); entry.samples++;
            entry.peakScratchDiskMiB = Math.max(entry.peakScratchDiskMiB, (scratchBytes(scratch) + Math.max(0, scratchBytes(projectScratch) - initialProjectBytes)) / 1048576);
            if (rss > config.guards.rssMiB) abort('process group RSS ceiling');
            if (growth > config.guards.swapGrowthMiB) abort('system swap growth ceiling');
            persist();
          } catch (error) { abort(`supervision failed: ${error.message}`); }
        }, 1000);
        await new Promise(resolveExit => { child.once('error', error => { entry.error = error.message; entry.exitCode = 1; resolveExit(); }); child.once('exit', (code, sig) => { entry.exitCode = code; entry.signal = sig; resolveExit(); }); });
        clearInterval(sample); clearTimeout(ceiling); clearTimeout(force); closeSync(fd);
        signal(child.pid, 'SIGTERM'); signal(child.pid, 'SIGKILL');
        entry.completedAt = new Date().toISOString();
        const file = join(root, `${name}.json`); if (existsSync(file)) entry.result = JSON.parse(readFileSync(file));
        persist(); console.log(JSON.stringify({ event: 'END', name, status: entry.result?.status, exitCode: entry.exitCode, peakRssMiB: entry.peakRssMiB, abortReason: entry.abortReason }));
        if (entry.abortReason || entry.exitCode !== 0 || entry.result?.status !== 'DONE') { record.stopReason ??= `trial failed: ${name}`; break; }
      }
    }
    verify();
    record.status = record.trials.some(t => t.abortReason) ? 'SAFETY_ABORTED' : record.stopReason ? 'FAILED' : 'DONE';
  } catch (error) { record.status = 'FAILED'; record.error = error.stack ?? String(error); }
  record.completedAt = new Date().toISOString(); persist();
  process.exitCode = record.status === 'DONE' ? 0 : 1;
}
