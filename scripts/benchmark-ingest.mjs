// Optional API/ingest experiment; no browser, STT, downloads, or production project writes.
// node scripts/benchmark-ingest.mjs <repo> <video> <second-video> <output-dir> <ingest|import>
import { createHash } from 'node:crypto';
import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cpus, platform, release } from 'node:os';

const [repoArg, inputArg, secondArg, outputArg, mode] = process.argv.slice(2);
if (!repoArg || !inputArg || !secondArg || !outputArg || !['ingest', 'import'].includes(mode)) {
  throw new Error('Expected repo, video, second-video, fresh output-dir, and ingest|import');
}
const [repo, input, second, output] = [repoArg, inputArg, secondArg, outputArg].map((path) => resolve(path));
if (existsSync(output)) throw new Error(`Refusing to reuse an experiment directory: ${output}`);
mkdirSync(output, { recursive: true });
process.env.SPLICEWRIGHT_HOME = join(output, 'home');
const requireAtRepo = createRequire(join(repo, 'package.json'));
const moduleAtRepo = (name) => import(pathToFileURL(requireAtRepo.resolve(name)).href);
const { init, run } = await moduleAtRepo('@splicewright/core/node');
const { ingest } = await moduleAtRepo('@splicewright/ingest');
const sha256 = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const metadata = (path) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
  'format=duration,size:stream=codec_type,width,height,r_frame_rate', '-of', 'json', path], { encoding: 'utf8' }));
const record = {
  mode, repo, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  recordedAt: new Date().toISOString(), host: { platform: platform(), release: release(), cores: cpus().length },
  node: process.version, runnerSha256: await sha256(new URL(import.meta.url)),
  ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  threadsOverride: process.env.SPLICEWRIGHT_FFMPEG_THREADS ?? null,
  inputs: await Promise.all([input, second].map(async (path) => ({ path, sha256: await sha256(path), ...metadata(path) }))),
  events: [],
};
const dir = join(output, 'project');
const created = init(dir, { title: 'Ingest resource experiment', fps: 30, width: 1920, height: 1080 });
if ('error' in created) throw new Error(created.error.message);
const start = performance.now();
let failure;
try {
  if (mode === 'ingest') {
    mkdirSync(join(dir, 'raw'), { recursive: true });
    cpSync(input, join(dir, 'raw', 'source.mp4'));
    const imported = run(dir, 'importAsset', { path: 'raw/source.mp4' });
    if ('error' in imported) throw new Error(imported.error.message);
    const id = Object.keys(imported.project.assets)[0];
    const phaseStart = performance.now();
    record.result = await ingest(dir, { assets: [id], only: ['sourceHealth', 'proxy', 'analysis', 'thumbs'],
      log: (message) => record.events.push({ ms: performance.now() - start, message }) });
    record.ingestMs = performance.now() - phaseStart;
    if (record.result.errors?.length) throw new Error(record.result.errors.join('; '));
    record.proxy = metadata(join(dir, '.splicewright', 'proxies', 'edit', `${id}.mp4`));
  } else {
    const { open } = await import(pathToFileURL(join(repo, 'apps/web/server.ts')).href);
    const server = await open(dir, { port: 0 });
    const streamAbort = new AbortController();
    const deadline = AbortSignal.timeout(45000);
    const waiters = [];
    const waitFor = (predicate) => {
      const found = record.events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolveEvent, rejectEvent) => {
        waiters.push({ predicate, resolveEvent });
        deadline.addEventListener('abort', () => rejectEvent(new Error('Experiment event deadline exceeded')), { once: true });
      });
    };
    try {
      const response = await fetch(new URL('/api/events', server.url), { signal: streamAbort.signal });
      const stream = (async () => {
        let buffer = '';
        for await (const chunk of response.body) {
          buffer += Buffer.from(chunk).toString();
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (!line.startsWith('data: ')) continue;
            const event = { ms: performance.now() - start, ...JSON.parse(line.slice(6)) };
            if (event.ingest && ['proxy', 'thumbs', 'waveform', null].includes(event.ingest.step)) {
              const state = await fetch(new URL('/api/project', server.url), { signal: deadline }).then((reply) => reply.json());
              if (state.proxies?.includes(event.ingest.id)) event.apiProxyReadyMs = performance.now() - start;
            }
            record.events.push(event);
            for (const waiter of waiters) if (waiter.predicate(event)) waiter.resolveEvent(event);
          }
        }
      })().catch((error) => { if (!streamAbort.signal.aborted) throw error; });
      const upload = async (path, name) => {
        const at = performance.now() - start;
        const reply = await fetch(new URL(`/api/import?name=${name}`, server.url), {
          method: 'POST', body: createReadStream(path), duplex: 'half', signal: deadline,
        });
        const result = await reply.json();
        if (!reply.ok) throw new Error(JSON.stringify(result));
        return { assetId: result.assetId, startedMs: at, responseMs: performance.now() - start - at };
      };
      record.imports = [await upload(input, 'first.mp4'), await upload(second, 'second.mp4')];
      for (const imported of record.imports) {
        const proxy = await waitFor((event) => event.ingest?.id === imported.assetId && event.apiProxyReadyMs !== undefined);
        const done = await waitFor((event) => event.ingest?.id === imported.assetId && event.ingest.step === null);
        imported.proxyReadyMs = proxy.apiProxyReadyMs - imported.startedMs;
        imported.backgroundDoneMs = done.ms - imported.startedMs;
        if (done.ingest.error) throw new Error(done.ingest.error);
      }
      streamAbort.abort(); await stream;
    } finally {
      streamAbort.abort(); await server.close();
    }
  }
} catch (error) {
  failure = error; record.error = String(error);
} finally {
  record.elapsedMs = performance.now() - start;
  writeFileSync(join(output, 'result.json'), JSON.stringify(record, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ mode, commit: record.commit, ingestMs: record.ingestMs, imports: record.imports, output }));
