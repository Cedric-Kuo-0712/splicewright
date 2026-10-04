#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint } from "@splicewright/core/node";
import { validate } from "@splicewright/core";

export const DEFAULT_SEED = 20261004;
export const DEFAULT_MEDIA_ROOT = "/path/to/test-project/raw";
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv"]);
const CAPTION_TEMPLATES = [
  "開場 · Ready", "沿著海岸 / Coastline", "慢一點 · Take it slow", "轉個彎 / Next turn",
  "風景正在切換 · Changing views", "記住這一刻 / Stay here", "繼續前進 · Keep going",
  "光線剛好 / Golden light", "抵達之前 · Almost there", "今天的路 / Today's route",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hashFile = (file) => new Promise((resolveHash, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolveHash(hash.digest("hex")));
});
const pathWithin = (parent, candidate) => {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
const rational = (value) => {
  const [n, d] = String(value ?? "0/0").split("/").map(Number);
  return d && Number.isFinite(n / d) ? n / d : 0;
};

function seededShuffle(values, seed) {
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function makeCaptions(seed = DEFAULT_SEED, caseOffset = 0) {
  return seededShuffle(CAPTION_TEMPLATES, seed + caseOffset).slice(0, 7).map((text, index) => ({
    id: `caption_${index + 1}`,
    start: 6 + index * 25,
    duration: 18,
    mode: "free",
    text,
  }));
}

export function createFixtureProject({ caseId, variant, seed = DEFAULT_SEED, media }) {
  if (!media || !Number.isFinite(media.duration) || media.duration < 7.4 || !Number.isFinite(media.fps) || media.fps <= 0)
    throw new Error(`${caseId}: source metadata must include positive fps and at least 7.4 seconds of media`);
  const sourceFrame = (seconds) => Math.round(seconds * media.fps);
  const sourceSecond = (frame) => Number((frame / media.fps).toFixed(9));
  const firstSourceIn = sourceSecond(sourceFrame(0.5));
  const secondTarget = Math.min(15, media.duration - 3.4);
  const secondSourceIn = sourceSecond(sourceFrame(Math.max(4, secondTarget)));
  const captions = makeCaptions(seed, caseId === "diagnostic" ? 0 : 101);
  const isDiagnostic = caseId === "diagnostic";
  const isOverlayTransition = variant === "overlay-transition";
  const transitionKind = caseId === "diagnostic" ? "dissolve" : "dip";
  const source = {
    id: `${caseId}_source`,
    path: media.path,
    kind: "video",
  };
  const clips = [
    { id: "clip_1", start: 0, duration: 90, assetId: source.id, sourceIn: firstSourceIn, volume: 1, fadeIn: 6 },
    { id: "clip_2", start: 90, duration: 90, assetId: source.id, sourceIn: secondSourceIn, volume: 1, fadeOut: 6 },
  ];
  // Transition metadata belongs to the outgoing clip, which ends at the 90-frame cut.
  if (isOverlayTransition) clips[0].transition = { kind: transitionKind, duration: 18 };
  return {
    schemaVersion: 1,
    revision: 0,
    meta: {
      title: `export-${caseId}-${variant}`,
      fps: 30,
      width: isDiagnostic ? 1280 : 1920,
      height: isDiagnostic ? 720 : 1080,
      background: "#000000",
    },
    assets: { [source.id]: source },
    tracks: [
      { id: "video_1", name: "V1", kind: "video", magnetic: true, items: clips },
      { id: "captions_1", name: "Captions", kind: "caption", items: captions },
    ],
    ids: { clip: 2, caption: 7 },
  };
}

function probe(file) {
  let data;
  try {
    data = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-show_entries",
      "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels",
      "-of", "json", file,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    throw new Error(`ffprobe failed for ${basename(file)}: ${error.stderr?.toString().trim() || error.message}`);
  }
  const video = data.streams?.find((stream) => stream.codec_type === "video" && stream.width && stream.height);
  const audio = data.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  const fps = rational(video?.avg_frame_rate) || rational(video?.r_frame_rate);
  return {
    duration: Number(data.format?.duration), width: video?.width, height: video?.height, fps, audio,
    frameRate: video?.avg_frame_rate && rational(video.avg_frame_rate) ? video.avg_frame_rate : video?.r_frame_rate,
    audioSampleRate: Number(data.streams?.find((stream) => stream.codec_type === "audio")?.sample_rate) || undefined,
  };
}

async function selectRealSource(mediaRoot) {
  const names = (await readdir(mediaRoot)).filter((name) => VIDEO_EXTENSIONS.has(extname(name).toLowerCase())).sort();
  const preferred = "VID20260627195107.mp4";
  const ordered = [preferred, ...names.filter((name) => name !== preferred)];
  for (const name of ordered) {
    if (!names.includes(name)) continue;
    const file = resolve(mediaRoot, name);
    const info = probe(file);
    if (info.duration >= 7.4 && info.width >= 1280 && info.height >= 720 && info.audio && info.fps > 0) {
      return { name, file, ...info };
    }
  }
  throw new Error(`no video with audio, >=1280x720, and >=7.4 seconds found in ${mediaRoot}`);
}

async function ensureSafeOutput(projectDir, outDir) {
  const source = await realpath(projectDir);
  const output = resolve(outDir);
  if (pathWithin(source, output) || pathWithin(output, source))
    throw new Error(`--out must be separate from the supplied project: ${output}`);
  try {
    const existing = await readdir(output);
    const allowed = new Set(["shared"]);
    if (existing.some((name) => !allowed.has(name))) throw new Error(`--out must be empty (found ${existing[0]}): ${output}`);
    if (existing.includes("shared")) {
      const shared = await readdir(resolve(output, "shared"));
      if (shared.some((name) => name !== "diagnostic.mp4")) throw new Error(`unexpected content under ${resolve(output, "shared")}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { source, output };
}

export async function generateDiagnosticMedia(outDir) {
  const output = resolve(outDir);
  const targetDir = resolve(output, "shared");
  const target = resolve(targetDir, "diagnostic.mp4");
  try { await lstat(target); throw new Error(`refusing to overwrite ${target}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(targetDir, { recursive: true });
  // Extra source handles let the six-second timeline carry a centred dissolve.
  const audio = "aevalsrc=0.02*sin(2*PI*300*t)+0.8*sin(2*PI*1200*t)*gt(0.04-mod(t\\,1)\\,0):s=48000:d=7.5";
  try {
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6",
      "-f", "lavfi", "-i", audio, "-t", "7.5", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", target,
    ], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    throw new Error(`diagnostic media generation failed: ${error.stderr?.toString().trim() || error.message}`);
  }
  return target;
}

function semanticCounts(project) {
  const video = project.tracks.find((track) => track.kind === "video");
  const captions = project.tracks.find((track) => track.kind === "caption");
  return {
    videoItems: video.items.length,
    captions: captions.items.length,
    transitions: video.items.filter((item) => item.transition).length,
    fades: video.items.filter((item) => item.fadeIn || item.fadeOut).length,
  };
}

export async function buildExportComparisonFixtures({ projectDir, outDir, mediaRoot, seed = DEFAULT_SEED }) {
  if (!Number.isInteger(seed) || seed <= 0) throw new Error("--seed must be a positive integer");
  const { source, output } = await ensureSafeOutput(projectDir, outDir);
  const sourceProject = JSON.parse(await readFile(resolve(source, "project.json"), "utf8"));
  if (!sourceProject || typeof sourceProject !== "object" || !sourceProject.meta) throw new Error("--project must contain a valid project.json");
  const root = await realpath(mediaRoot ?? resolve(source, "raw"));
  if (pathWithin(root, output) || pathWithin(output, root)) throw new Error("--out must be separate from --media-root");
  const real = await selectRealSource(root);
  const diagnostic = resolve(output, "shared/diagnostic.mp4");
  try { await stat(diagnostic); }
  catch { throw new Error(`missing ${diagnostic}; run this command first with --generate-media`); }
  const diag = probe(diagnostic);
  if (diag.duration < 7.4 || !diag.audio || diag.width !== 1280 || diag.height !== 720 || Math.abs(diag.fps - 30) > 0.001)
    throw new Error(`diagnostic source metadata does not match the pinned >=7.4s 1280x720 30fps A/V contract`);
  const rawLinkTarget = root;
  const manifest = {
    schemaVersion: 1,
    seed,
    generatedAt: new Date().toISOString(),
    sourceProject: source,
    mediaRoot: root,
    settings: { timelineFps: 30, frames: 180, durationSeconds: 6, audioVolume: 1, captionCount: 7 },
    sources: {},
    fixtures: [],
  };
  const sources = [
    { id: "diagnostic", file: diagnostic, path: "../shared/diagnostic.mp4", info: diag },
    { id: "real", file: real.file, path: `raw/${real.name}`, info: real },
  ];
  for (const item of sources) {
    const fileStat = await stat(item.file);
    manifest.sources[item.id] = {
      path: item.file,
      bytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sha256: await hashFile(item.file),
      ...item.info,
      sourceFrameRate: item.info.frameRate,
      nativeAudioSampleRate: item.info.audioSampleRate,
    };
  }
  for (const sourceInfo of sources) {
    for (const variant of ["hardcut", "overlay-transition"]) {
      const projectDirPath = resolve(output, `${sourceInfo.id}-${variant}`);
      await mkdir(resolve(projectDirPath, ".splicewright"), { recursive: true });
      await symlink(rawLinkTarget, resolve(projectDirPath, "raw"), "dir");
      const assetPath = sourceInfo.path;
      const media = { ...sourceInfo.info, path: assetPath };
      const project = createFixtureProject({ caseId: sourceInfo.id, variant, seed, media });
      const asset = Object.values(project.assets)[0];
      const mediaOnDisk = resolve(projectDirPath, asset.path);
      const sourceFingerprint = fingerprint(mediaOnDisk);
      if (!sourceFingerprint) throw new Error(`${sourceInfo.id}: source path does not resolve from fixture project: ${asset.path}`);
      const cache = { [asset.id]: {
        path: asset.path,
        fingerprint: sourceFingerprint,
        kind: "video",
        duration: sourceInfo.info.duration,
        width: sourceInfo.info.width,
        height: sourceInfo.info.height,
        fps: sourceInfo.info.fps,
        audio: sourceInfo.info.audio,
      } };
      const projectBytes = `${JSON.stringify(project, null, 2)}\n`;
      await writeFile(resolve(projectDirPath, "project.json"), projectBytes, "utf8");
      await writeJson(resolve(projectDirPath, ".splicewright/assets.json"), cache);
      const errors = validate(project, undefined, { assetDurations: { [asset.id]: sourceInfo.info.duration } });
      if (errors.length) throw new Error(`${sourceInfo.id}/${variant} failed core validation: ${errors.join("; ")}`);
      const video = project.tracks.find((track) => track.kind === "video");
      const entry = {
        projectDir: projectDirPath,
        projectSha256: sha256(projectBytes),
        width: project.meta.width,
        height: project.meta.height,
        fps: project.meta.fps,
        frames: 180,
        durationSeconds: 6,
        audio: { present: sourceInfo.info.audio, volume: 1, sourceSampleRate: sourceInfo.info.audioSampleRate },
        source: {
          path: asset.path,
          sourceFps: sourceInfo.info.fps,
          sourceFrameRate: sourceInfo.info.frameRate,
          sourceFrames: video.items.map((clip) => ({
            itemId: clip.id,
            timelineStartFrame: clip.start,
            durationFrames: clip.duration,
            sourceInSeconds: clip.sourceIn,
            sourceInFrame: Math.round(clip.sourceIn * sourceInfo.info.fps),
          })),
          sha256: manifest.sources[sourceInfo.id].sha256,
          bytes: manifest.sources[sourceInfo.id].bytes,
        },
        captions: project.tracks.find((track) => track.kind === "caption").items.map(({ start, duration, text }) => ({ start, duration, text })),
        transitions: video.items.flatMap((clip) => clip.transition ? [{ kind: clip.transition.kind, cutFrame: clip.start + clip.duration, durationFrames: clip.transition.duration }] : []),
        semanticCounts: semanticCounts(project),
        probeCachePath: resolve(projectDirPath, ".splicewright/assets.json"),
        sourceFingerprint,
      };
      manifest.fixtures.push({ caseId: sourceInfo.id, variant, ...entry });
    }
  }
  await writeJson(resolve(output, "fixture-manifest.json"), manifest);
  return manifest;
}

function parseArgs(args) {
  const options = { seed: DEFAULT_SEED };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--generate-media") options.generateMedia = true;
    else if (["--project", "--out", "--media-root", "--seed"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[{ "--project": "projectDir", "--out": "outDir", "--media-root": "mediaRoot", "--seed": "seed" }[arg]] = arg === "--seed" ? Number(value) : value;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log("Usage: node scripts/export-comparison-fixtures.mjs --project <source-project> --out <empty-output-dir> [--media-root <raw-dir>] [--seed 20261004] [--generate-media]");
    return;
  }
  if (!options.outDir) throw new Error("--out is required");
  if (options.generateMedia) {
    if (!options.projectDir) throw new Error("--project is required to protect the source project");
    const { output } = await ensureSafeOutput(options.projectDir, options.outDir);
    await generateDiagnosticMedia(output);
    console.log(`generated ${resolve(output, "shared/diagnostic.mp4")}`);
    return;
  }
  if (!options.projectDir) throw new Error("--project is required");
  const manifest = await buildExportComparisonFixtures(options);
  console.log(JSON.stringify({ output: resolve(options.outDir), seed: manifest.seed, fixtures: manifest.fixtures.map(({ caseId, variant, projectSha256, semanticCounts }) => ({ caseId, variant, projectSha256, semanticCounts })) }));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
