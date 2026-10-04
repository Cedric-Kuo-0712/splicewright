import { outputVideoEncoder } from "./export-output-encoder.mjs";
import { trialProcesses, trialProcessGroups, stopTrialGroups, classifyTrialProcess } from "./export-resource-processes.mjs";
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
  if (!(config.guards?.rssMiB > 0 && config.guards.trialSeconds > 0 && config.guards.swapGrowthMiB >= 0 && (config.guards.samplingMs === undefined || config.guards.samplingMs >= 250))) throw new Error('Invalid guards');
  for (const file of config.fingerprints ?? []) if (hash(file.path) !== file.sha256) throw new Error(`Input changed: ${file.path}`);
  for (const entry of config.provenance?.generatedEntries ?? []) {
    const accepted = [entry.templateSha256, ...Object.values(entry.emittedSha256ByRenderer ?? {})];
    if (!existsSync(entry.path) || !accepted.includes(hash(entry.path))) throw new Error(`Generated renderer entry changed: ${entry.path}`);
  }
  if (config.provenance?.priorSuccessful10 && (!existsSync(config.provenance.priorSuccessful10.output) || !/^[a-f0-9]{64}$/.test(config.provenance.priorSuccessful10.fileSha256))) throw new Error('Pinned prior sequential-10 reference is missing or malformed');
  for (const c of config.cases) {
    if (!/^[a-z0-9-]+$/.test(c.id) || !(c.frames > 0 && c.fps > 0 && c.width > 0 && c.height > 0)) throw new Error('Invalid case');
    if (!existsSync(join(c.project, 'project.json'))) throw new Error(`Missing project: ${c.id}`);
    if (c.range && (!Array.isArray(c.range) || c.range.length !== 2 || !c.range.every(Number.isInteger) || c.range[0] < 0 || c.range[1] - c.range[0] !== c.frames)) throw new Error(`Invalid range: ${c.id}`);
  }
  for (const m of config.methods)
    if (!/^[a-z0-9-]+$/.test(m.id) || !existsSync(m.renderer ?? config.renderer) || (m.experimentalFilterBufferedFrames !== undefined && ![64, 128].includes(m.experimentalFilterBufferedFrames)) || (m.experimentalActiveWindow !== undefined && typeof m.experimentalActiveWindow !== 'boolean')) throw new Error(`Invalid method renderer or experimental setting: ${m.id}`);
  if (config.qualityPolicy) {
    for (const m of config.methods) {
      if (!m.options?.preset || !m.expectedEncoder) throw new Error(`Method ${m.id} must pin preset and expectedEncoder`);
      if (m.options.preset !== config.qualityPolicy.preset) throw new Error(`Method ${m.id} violates shared qualityPolicy.preset`);
    }
    if (config.methods.length < 2 || config.methods.some(method => JSON.stringify(method.options) !== JSON.stringify(config.methods[0].options)) ||
        config.methods.some(method => method.expectedEncoder !== config.qualityPolicy.expectedEncoder ||
          method.expectedCodec !== config.qualityPolicy.expectedCodec || method.expectedTag !== config.qualityPolicy.expectedTag))
      throw new Error('Comparison methods must pin identical render options and the quality-policy encoder/container');
    if (config.qualityOptions && JSON.stringify(config.methods[0].options) !== JSON.stringify(config.qualityOptions)) throw new Error('Render options differ from the declared quality policy');
  }
}
verify();
const rendererPath = methodId => config.methods.find(m => m.id === methodId)?.renderer ?? config.renderer;
if (args.includes('--check')) {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  if (config.methods.some(method => method.experimentalFilterBufferedFrames !== undefined) && !execFileSync('ffmpeg', ['-hide_banner', '-h', 'full'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('-filter_buffered_frames')) throw new Error('This FFmpeg build does not support -filter_buffered_frames');
  if (config.provenance?.priorSuccessful10 && hash(config.provenance.priorSuccessful10.output) !== config.provenance.priorSuccessful10.fileSha256) throw new Error('Pinned prior sequential-10 reference file changed');
  console.log(JSON.stringify({ status: 'PREFLIGHT_PASSED', cases: config.cases.length, methods: config.methods.length, guards: config.guards }));
} else if (args.includes('--trial')) {
  const index = args.indexOf('--trial');
  const c = config.cases.find(c => c.id === args[index + 1]);
  const m = config.methods.find(m => m.id === args[index + 2]);
  if (!c || !m) throw new Error('Unknown trial');
  if (m.experimentalFilterBufferedFrames === undefined) delete process.env.SPLICEWRIGHT_EXPERIMENTAL_FILTER_BUFFERED_FRAMES;
  else process.env.SPLICEWRIGHT_EXPERIMENTAL_FILTER_BUFFERED_FRAMES = String(m.experimentalFilterBufferedFrames);
  if (m.experimentalActiveWindow) process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = '1';
  else delete process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW;
  const { render } = await import(pathToFileURL(rendererPath(m.id)).href);
  const name = `${c.id}-${m.id}`, output = join(root, `${name}.mp4`), resultFile = join(root, `${name}.json`);
  if (existsSync(output) || existsSync(resultFile)) throw new Error('Refusing to overwrite trial');
  const record = { status: 'RUNNING', case: c.id, method: m.id, options: m.options, startedAt: new Date().toISOString(), output };
  const phaseFile = join(root, `${name}-phase.json`);
  const eventsFile = join(root, `${name}-events.jsonl`);
  const setPhase = (stage, batch = null) => {
    const event = JSON.stringify({ stage, batch, at: new Date().toISOString() });
    try { writeFileSync(phaseFile, event); appendFileSync(eventsFile, `${event}\n`); }
    catch { /* Optional stage telemetry cannot interrupt rendering. */ }
  };
  setPhase('render-startup');
  save(resultFile, record);
  let progressBucket = -1;
  try {
    const start = performance.now();
    setPhase('render');
    record.renderResult = await render(c.project, { ...m.options, ...(c.range ? { range: c.range } : {}), output,
      onEncoding: encoderArgs => {
        setPhase('native-ffmpeg-encode');
        appendFileSync(join(root, `${name}-encoding.jsonl`), JSON.stringify(encoderArgs) + '\n');
        record.encoder = outputVideoEncoder(encoderArgs);
        record.encoderArgsSha256 = createHash('sha256').update(JSON.stringify(encoderArgs)).digest('hex');
        if (m.expectedEncoder && record.encoder !== m.expectedEncoder) throw new Error(`Unexpected encoder: ${record.encoder}`);
      },
      onProgress: progress => { const bucket = Math.floor(progress * 50); if (bucket !== progressBucket) { progressBucket = bucket; appendFileSync(join(root, `${name}-progress.jsonl`), JSON.stringify({ elapsedMs: performance.now() - start, progress }) + '\n'); } },
    });
    if (m.experimentalActiveWindow && (!existsSync(eventsFile) || !readFileSync(eventsFile, 'utf8').includes('"stage":"active-window-reader-start"'))) throw new Error('The active-window experimental method did not use its requested reader path');
    record.renderMs = performance.now() - start;
    setPhase('post-render-validation');
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
    setPhase('post-render-full-decode');
    try { execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '2', '-i', output, '-threads', '2', '-f', 'null', '-'], { stdio: ['ignore', fd, fd], timeout: config.decodedHashChecks?.timeoutMs ?? 600000 }); } finally { closeSync(fd); }
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
    initialSwapMiB: swap(), trials: [], limitations: ['One run per case/method, no spread.', 'Case order alternates methods; cache and thermal state are uncontrolled.', 'RSS sums the trial process tree including detached Chromium and can double-count shared pages; one-second samples can miss brief peaks.', 'System swap growth is a safety trigger, not attributable memory usage.'],
  };
  const persist = () => save(resultFile, record);
  persist();
  try {
    for (let i = 0; i < config.cases.length && !record.stopReason; i++) {
      const c = config.cases[i];
      for (const m of i % 2 ? [...config.methods].reverse() : config.methods) {
        verify();
        const name = `${c.id}-${m.id}`, fd = openSync(join(root, `${name}.log`), 'wx');
        const scratch = join(root, `${name}-scratch`); mkdirSync(scratch);
        const projectScratch = join(c.project, '.splicewright'), initialProjectBytes = scratchBytes(projectScratch);
        const phaseFile = join(root, `${name}-phase.json`);
        const child = spawn(process.execPath, [import.meta.filename, '--config', resolve(configFile), '--trial', c.id, m.id], { cwd: config.repo, detached: true, env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch, SPLICEWRIGHT_EXPORT_MEMORY_PHASE_FILE: phaseFile, SPLICEWRIGHT_EXPORT_MEMORY_EVENTS_FILE: join(root, `${name}-events.jsonl`), ...(m.experimentalFilterBufferedFrames === undefined ? {} : { SPLICEWRIGHT_EXPERIMENTAL_FILTER_BUFFERED_FRAMES: String(m.experimentalFilterBufferedFrames) }) }, stdio: ['ignore', fd, fd] });
        const entry = { name, pid: child.pid, startedAt: new Date().toISOString(), experimentalFilterBufferedFrames: m.experimentalFilterBufferedFrames ?? null, peakRssMiB: 0, peakCpuPercent: 0, peakSwapGrowthMiB: 0, peakScratchDiskMiB: 0, samples: 0 };
        record.trials.push(entry); persist(); console.log(JSON.stringify({ event: 'START', name, pid: child.pid }));
        let force;
        const processGroups = new Set([child.pid]);
        const stopGroups = sig => {
          const errors = stopTrialGroups(processGroups, sig);
          if (errors.length) { (entry.cleanupErrors ??= []).push(...errors); persist(); }
        };
        const abort = reason => { if (entry.abortReason) return; entry.abortReason = reason; record.stopReason = reason; persist(); stopGroups('SIGTERM'); force = setTimeout(() => stopGroups('SIGKILL'), 3000); };
        const ceiling = setTimeout(() => abort('trial timeout'), config.guards.trialSeconds * 1000);
        const sample = setInterval(() => {
          try {
            const allRows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,%cpu=,uid=,command='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').filter(Boolean).map(line => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/); return match && { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), rss: Number(match[4]), cpu: Number(match[5]), uid: Number(match[6]), command: match[7] }; }).filter(Boolean);
            const rows = trialProcesses(allRows, child.pid, process.pid);
            for (const group of trialProcessGroups(allRows, child.pid, process.pid, process.getuid?.())) processGroups.add(group);
            const rss = rows.reduce((sum, row) => sum + row.rss, 0) / 1024, cpu = rows.reduce((sum, row) => sum + row.cpu, 0), growth = record.initialSwapMiB === null ? 0 : Math.max(0, swap() - record.initialSwapMiB);
            entry.peakRssMiB = Math.max(entry.peakRssMiB, rss); entry.peakCpuPercent = Math.max(entry.peakCpuPercent, cpu); entry.peakSwapGrowthMiB = Math.max(entry.peakSwapGrowthMiB, growth); entry.samples++;
            let phase = { stage: 'unknown', batch: null };
            try { phase = JSON.parse(readFileSync(join(root, `${name}-phase.json`), 'utf8')); } catch {}
            const byRole = {};
            for (const row of rows) {
              const role = classifyTrialProcess(row, child.pid, process.pid);
              byRole[role] = (byRole[role] ?? 0) + row.rss;
            }
            const phasePeaks = entry.peakRssMiBByPhase ??= {};
            const phasePeak = phasePeaks[phase.stage] ??= { aggregateRssMiB: 0, roleRssMiB: {} };
            // roleRssMiB keeps per-role maxima from different samples; this snapshot is one coherent sample.
            if (rss > phasePeak.aggregateRssMiB) phasePeak.roleRssMiBAtAggregatePeak = Object.fromEntries(Object.entries(byRole).map(([role, kib]) => [role, kib / 1024]));
            phasePeak.aggregateRssMiB = Math.max(phasePeak.aggregateRssMiB, rss);
            for (const [role, kib] of Object.entries(byRole)) phasePeak.roleRssMiB[role] = Math.max(phasePeak.roleRssMiB[role] ?? 0, kib / 1024);
            appendFileSync(join(root, `${name}-memory.jsonl`), JSON.stringify({ at: new Date().toISOString(), phase: phase.stage, batch: phase.batch, processes: rows.map(row => ({ pid: row.pid, ppid: row.ppid, pgid: row.pgid, uid: row.uid, role: classifyTrialProcess(row, child.pid, process.pid), rssKiB: row.rss, cpuPercent: row.cpu })), rssMiBByRole: Object.fromEntries(Object.entries(byRole).map(([role, kib]) => [role, kib / 1024])), aggregateRssMiB: rss, aggregateCpuPercent: cpu, unknownProcessCount: byRole.unknown ? rows.filter(row => classifyTrialProcess(row, child.pid, process.pid) === 'unknown').length : 0, note: 'RSS sums may double-count shared pages and omit processes shorter than the one-second sampling interval.' }) + '\n');
            entry.peakScratchDiskMiB = Math.max(entry.peakScratchDiskMiB, (scratchBytes(scratch) + Math.max(0, scratchBytes(projectScratch) - initialProjectBytes)) / 1048576);
            if (rss > config.guards.rssMiB) abort('process group RSS ceiling');
            if (growth > config.guards.swapGrowthMiB) abort('system swap growth ceiling');
            persist();
          } catch (error) { abort(`supervision failed: ${error.message}`); }
        }, config.guards.samplingMs ?? 1000);
        await new Promise(resolveExit => { child.once('error', error => { entry.error = error.message; entry.exitCode = 1; resolveExit(); }); child.once('exit', (code, sig) => { entry.exitCode = code; entry.signal = sig; resolveExit(); }); });
        clearInterval(sample); clearTimeout(ceiling); clearTimeout(force); closeSync(fd);
        stopGroups('SIGTERM'); stopGroups('SIGKILL');
        entry.completedAt = new Date().toISOString();
        const file = join(root, `${name}.json`); if (existsSync(file)) entry.result = JSON.parse(readFileSync(file));
        persist(); console.log(JSON.stringify({ event: 'END', name, status: entry.result?.status, exitCode: entry.exitCode, peakRssMiB: entry.peakRssMiB, abortReason: entry.abortReason }));
        if (entry.abortReason || entry.cleanupErrors?.length || entry.exitCode !== 0 || entry.result?.status !== 'DONE') {
          record.stopReason ??= entry.cleanupErrors?.length ? `trial cleanup incomplete: ${name}` : `trial failed: ${name}`;
          break;
        }
      }
    }
    verify();
    record.status = record.trials.some(t => t.abortReason) ? 'SAFETY_ABORTED' : record.stopReason ? 'FAILED' : 'DONE';
  } catch (error) { record.status = 'FAILED'; record.error = error.stack ?? String(error); }
  record.completedAt = new Date().toISOString(); persist();
  process.exitCode = record.status === 'DONE' ? 0 : 1;
}
