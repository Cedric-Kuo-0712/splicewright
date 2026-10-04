import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootRepo = resolve(repo, '../..');
const sourceFixture = resolve(rootRepo, '.codex-jobs/export-batch-memory-4g-20261004T123148Z/fixtures/real-five-minute');
const priorConfig = resolve(rootRepo, '.codex-jobs/export-batch-memory-4g-20261004T123148Z/comparison.json');
const BASELINE = '57981f611edc7066b8b851d0dae8162654f1d26f';

export function makeSequentialProject(source, count) {
  if (![10, 100, 200].includes(count)) throw new Error('clip count must be 10, 100, or 200');
  const project = structuredClone(source);
  const sourceItems = source.tracks.find(track => track.kind === 'video')?.items;
  if (!sourceItems?.length) throw new Error('fixture requires source video clips');
  const totalFrames = project.meta.fps * 300;
  const clipFrames = totalFrames / count;
  if (!Number.isInteger(clipFrames)) throw new Error('clip count must divide the 5-minute frame count');
  const clips = Array.from({ length: count }, (_, index) => {
    const sourceItem = sourceItems[index % sourceItems.length];
    return { id: `clip_${index + 1}`, start: index * clipFrames, duration: clipFrames, assetId: sourceItem.assetId, sourceIn: sourceItem.sourceIn, volume: sourceItem.volume ?? 1 };
  });
  project.meta.title = `export-memory-sequential-${count}`;
  project.tracks = project.tracks.filter(track => track.kind === 'video').slice(0, 1).map(track => ({ ...track, id: 'video_1', items: clips }));
  project.ids = { ...project.ids, clip: count, caption: 0 };
  return project;
}

export function makeConcurrentTrackProject(source, count = 3) {
  if (!Number.isInteger(count) || count < 2 || count > 4) throw new Error('concurrent video tracks must be between 2 and 4');
  const video = source.tracks.find(track => track.kind === 'video');
  if (!video?.items?.length) throw new Error('fixture requires source video clips');
  const project = structuredClone(source);
  const tracks = Array.from({ length: count }, (_, trackIndex) => ({
    id: `video_${trackIndex + 1}`, name: `V${trackIndex + 1}`, kind: 'video', magnetic: false,
    items: video.items.map((item, index) => ({ ...structuredClone(item), id: `v${trackIndex + 1}_clip_${index + 1}`, volume: trackIndex === 0 ? item.volume : 0.15 })),
  }));
  project.meta.title = `export-memory-concurrent-${count}-track-remotion`;
  project.tracks = tracks;
  project.ids = { ...project.ids, clip: count * video.items.length, caption: 0 };
  return project;
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}
function writeFixture(sourceProject, sourceDir, targetDir, project) {
  mkdirSync(join(targetDir, '.splicewright'), { recursive: true });
  mkdirSync(join(targetDir, 'raw'), { recursive: true });
  writeFileSync(join(targetDir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  for (const leaf of ['entry.tsx', 'assets.json']) copyFileSync(join(sourceDir, '.splicewright', leaf), join(targetDir, '.splicewright', leaf));
  for (const asset of Object.values(project.assets)) {
    const from = resolve(sourceDir, asset.path), to = resolve(targetDir, asset.path);
    mkdirSync(dirname(to), { recursive: true });
    if (!existsSync(to)) symlinkSync(from, to);
  }
  return { id: project.meta.title.replace(/^export-memory-/, ''), project: targetDir, width: project.meta.width, height: project.meta.height, fps: project.meta.fps, frames: project.meta.fps * 300, audio: false, range: [0, project.meta.fps * 300] };
}

export function prepareBenchmark(outDir) {
  const base = resolve(outDir);
  if (existsSync(base)) throw new Error(`Refusing to overwrite benchmark directory: ${base}`);
  const sourceProject = JSON.parse(readFileSync(join(sourceFixture, 'project.json'), 'utf8'));
  const prior = JSON.parse(readFileSync(priorConfig, 'utf8'));
  const currentHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const baselineRenderer = resolve(rootRepo, 'packages/render/src/node.ts');
  const candidateRenderer = resolve(repo, 'packages/render/src/node.ts');
  const common = {
    schemaVersion: 1, repo: rootRepo, renderer: candidateRenderer, seed: 20261004,
    guards: { rssMiB: 4096, swapGrowthMiB: 256, trialSeconds: 900, samplingMs: 1000 },
    decodedHashChecks: { timeoutMs: 600000 },
    provenance: { baseline: BASELINE, candidate: currentHead, fixtureProjectSha256: sha256(join(sourceFixture, 'project.json')), sourceAssets: prior.provenance.fixture.sources.map(item => ({ path: item.path, sha256: item.sha256 })) },
  };
  const options = { pipeline: 'layered', preset: 'h265-hardware', resources: { concurrency: 2, filterThreads: 2, encoderThreads: 4, graphicsScheduling: 'grouped' } };
  const method = (id, renderer, extra = {}) => ({ id, renderer, source: { commit: id === 'main-baseline' ? BASELINE : currentHead, renderer }, expectedEncoder: 'hevc_videotoolbox', expectedCodec: 'hevc', expectedTag: 'hvc1', options: structuredClone(options), ...extra });
  const baselineOptions = structuredClone(options);
  const writeConfig = (name, cases, methods, fixtureProjects = []) => {
    const runDir = join(base, name.replace(/\.json$/, ''));
    mkdirSync(runDir, { recursive: true });
    const codeFiles = [baselineRenderer, resolve(dirname(baselineRenderer), 'layered-render.ts'), candidateRenderer, resolve(dirname(candidateRenderer), 'layered-render.ts'), resolve(repo, 'scripts/export-comparison-runner.mjs'), join(sourceFixture, '.splicewright/entry.tsx'), ...prior.fingerprints.filter(item => item.path.includes('/.worktrees/export-bounded-batches/packages/render/src/')).map(item => item.path)];
    const sourceInputs = prior.fingerprints.filter(item => item.path === join(sourceFixture, 'project.json') || item.path === join(sourceFixture, '.splicewright/assets.json') || item.path.startsWith('/path/to/test-project/raw/'));
    const fingerprints = [...new Set(codeFiles)].map(path => ({ path, sha256: sha256(path) }));
    fingerprints.push(...sourceInputs, ...fixtureProjects.map(path => ({ path, sha256: sha256(path) })));
    const config = { ...common, fingerprints, cases, methods, ...(methods.some(method => method.id === 'main-baseline') ? { validationBaseline: 'main-baseline' } : {}) };
    writeFileSync(join(runDir, 'comparison.json'), `${JSON.stringify(config, null, 2)}\n`);
    return join(runDir, 'comparison.json');
  };
  mkdirSync(base, { recursive: true });
  const sourceCase = { ...prior.cases[0], range: [0, 9000] };
  const realConfig = writeConfig('real-five-minute', [sourceCase], [
    method('main-baseline', baselineRenderer, { options: baselineOptions }),
    method('candidate-current', candidateRenderer),
    method('candidate-cap64', candidateRenderer, { experimentalFilterBufferedFrames: 64 }),
    method('candidate-cap128', candidateRenderer, { experimentalFilterBufferedFrames: 128 }),
  ], [join(sourceFixture, 'project.json')]);
  const countCases = [10, 100, 200].map(count => {
    const fixturePath = join(base, 'fixtures', `sequential-${count}`);
    const testCase = writeFixture(sourceProject, sourceFixture, fixturePath, makeSequentialProject(sourceProject, count));
    return { ...testCase, id: `sequential-${count}` };
  });
  const clipCountConfig = writeConfig('clip-count', countCases, [method('candidate-current', candidateRenderer)], countCases.map(testCase => join(testCase.project, 'project.json')));
  const remotionDir = join(base, 'fixtures', 'concurrent-remotion-3-track');
  const remotionCase = writeFixture(sourceProject, sourceFixture, remotionDir, makeConcurrentTrackProject(sourceProject, 3));
  const concurrentFingerprints = [candidateRenderer, resolve(dirname(candidateRenderer), 'layered-render.ts'), join(sourceFixture, '.splicewright/entry.tsx'), join(remotionDir, 'project.json'), ...prior.fingerprints.filter(item => item.path.includes('/.worktrees/export-bounded-batches/packages/render/src/') || item.path.startsWith('/path/to/test-project/raw/')).map(item => item.path)].map(path => ({ path, sha256: sha256(path) }));
  const concurrentDir = join(base, 'concurrent-remotion');
  mkdirSync(concurrentDir, { recursive: true });
  const concurrentConfig = join(concurrentDir, 'comparison.json');
  writeFileSync(concurrentConfig, `${JSON.stringify({ ...common, renderer: candidateRenderer, fingerprints: concurrentFingerprints, cases: [{ ...remotionCase, id: 'concurrent-remotion-3-track' }], methods: [{ id: 'remotion-default', renderer: candidateRenderer, source: { commit: currentHead, renderer: candidateRenderer }, expectedEncoder: 'hevc_videotoolbox', expectedCodec: 'hevc', expectedTag: 'hvc1', options: { preset: 'h265-hardware' } }] }, null, 2)}\n`);
  return { directory: base, head: currentHead, baseline: BASELINE, launches: [realConfig, clipCountConfig, concurrentConfig].map(config => `nice -n 10 node scripts/export-comparison-runner.mjs --config ${config}`), preparedOnly: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--prepare');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node scripts/export-memory-benchmark.mjs --prepare <new-output-directory>');
  console.log(JSON.stringify(prepareBenchmark(process.argv[index + 1]), null, 2));
}
