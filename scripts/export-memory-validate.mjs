import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const resultFile = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/export-memory-validate.mjs <result.json>');
const result = JSON.parse(readFileSync(resultFile, 'utf8'));
if (result.status !== 'DONE' || !result.config?.validationBaseline) throw new Error('Requires a completed comparison with validationBaseline');
if (!Array.isArray(result.config.cases) || result.config.cases.length !== 1 || result.config.cases[0].audio !== true) throw new Error('Decoded equality validation requires exactly one audio-enabled case');
if (!Array.isArray(result.trials) || result.trials.length !== result.config.methods?.length) throw new Error('Decoded equality validation requires one completed trial per configured method');
const outputPath = join(dirname(resultFile), 'validation.json');
if (existsSync(outputPath)) throw new Error(`Refusing to overwrite validation evidence: ${outputPath}`);
const hash = (file, audio) => {
  const streams = audio ? ['-map', '0:a:0', '-c:a', 'pcm_f32le'] : ['-map', '0:v:0', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24'];
  const stdout = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '2', '-i', file, ...streams, '-threads', '2', '-f', 'hash', '-hash', 'sha256', '-'], {
    encoding: 'utf8', timeout: result.config.decodedHashChecks?.timeoutMs ?? 600000, maxBuffer: 1024 * 1024,
  });
  const value = /SHA256=([a-f0-9]{64})/i.exec(stdout)?.[1];
  if (!value) throw new Error(`FFmpeg returned no decoded hash for ${file}`);
  return value;
};
const rows = [];
let error;
try {
  for (const trial of result.trials) {
    if (trial.result?.status !== 'DONE') throw new Error(`Incomplete trial: ${trial.name}`);
    rows.push({ method: trial.result.method, videoSha256: hash(trial.result.output, false), audioSha256: hash(trial.result.output, true) });
  }
  const baseline = rows.find(row => row.method === result.config.validationBaseline);
  if (!baseline) throw new Error(`Missing validation baseline ${result.config.validationBaseline}`);
  for (const row of rows) {
    row.exactVideoEqual = row.videoSha256 === baseline.videoSha256;
    row.exactAudioEqual = row.audioSha256 === baseline.audioSha256;
    if (!row.exactVideoEqual || !row.exactAudioEqual) throw new Error(`Decoded RGB/PCM mismatch: ${row.method}`);
  }
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
  process.exitCode = 1;
}
const validation = { status: error ? 'FAILED' : 'DONE', error, createdAt: new Date().toISOString(), scope: 'Full decoded RGB and PCM SHA-256 equality; not a subjective quality rating.', rows };
writeFileSync(outputPath, `${JSON.stringify(validation, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: validation.status, methods: rows.length, error }));
