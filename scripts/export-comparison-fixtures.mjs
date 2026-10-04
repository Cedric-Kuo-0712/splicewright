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
  const sources = Array.isArray(media) ? media : [
    { ...media, id: `${caseId}_source`, sourceInSeconds: 0.5 },
    { ...media, id: `${caseId}_source`, sourceInSeconds: Math.min(15, media.duration - 3.4) },
  ];
  if (sources.length !== 2 || sources.some((source) => !source || !Number.isFinite(source.duration) || source.duration < 3.4 || !Number.isFinite(source.fps) || source.fps <= 0))
    throw new Error(`${caseId}: both source segments require positive fps and at least 3.4 seconds of media`);
  if (sources.some(({ path }) => typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes("..")))
    throw new Error(`${caseId}: fixture asset paths must remain under the project directory`);
  const snappedSourceIn = (source) => Number((Math.round(source.sourceInSeconds * source.fps) / source.fps).toFixed(9));
  const captions = makeCaptions(seed, caseId === "diagnostic" ? 0 : 101);
  const isDiagnostic = caseId === "diagnostic";
  const isOverlayTransition = variant === "overlay-transition";
  const isChunkStress = variant === "chunk-stress";
  const transitionKind = caseId === "diagnostic" ? "dissolve" : "dip";
  const assets = Object.fromEntries(sources.map((source, index) => [source.id ?? `${caseId}_source_${index + 1}`, {
    id: source.id ?? `${caseId}_source_${index + 1}`,
    path: source.path,
    kind: "video",
  }]));
  const clips = isChunkStress
    ? Array.from({ length: 6 }, (_, index) => {
      const source = sources[index % sources.length];
      return {
        id: `clip_${index + 1}`,
        start: index * 30,
        duration: 30,
        assetId: source.id,
        sourceIn: snappedSourceIn(source) + (index % 2) * 1.2,
        volume: 1,
        ...(index < 5 ? { transition: { kind: index % 2 ? "dip" : "dissolve", duration: 12 } } : {}),
      };
    })
    : [
    { id: "clip_1", start: 0, duration: 90, assetId: sources[0].id, sourceIn: snappedSourceIn(sources[0]), volume: 1, fadeIn: 6 },
    { id: "clip_2", start: 90, duration: 90, assetId: sources[1].id, sourceIn: snappedSourceIn(sources[1]), volume: 1, fadeOut: 6 },
  ];
  // Transition metadata belongs to the outgoing clip, which ends at the 90-frame cut.
  if (isOverlayTransition) clips[0].transition = { kind: transitionKind, duration: 18 };
  const stressOverlays = isChunkStress ? Array.from({ length: 10 }, (_, index) => ({
    id: `caption_overlay_${index + 1}`,
    start: Math.max(0, index * 17 - 4),
    duration: Math.min(38, 180 - Math.max(0, index * 17 - 4)),
    component: "CaptionLayer",
    props: {
      texts: [CAPTION_TEMPLATES[(index + seed) % CAPTION_TEMPLATES.length]],
      css: { backdropFilter: "none" },
    },
  })) : [];
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
    assets,
    tracks: [
      { id: "video_1", name: "V1", kind: "video", magnetic: true, items: clips },
      ...(isChunkStress
        ? Array.from({ length: 3 }, (_, index) => ({ id: `captions_${index + 1}`, name: `Captions ${index + 1}`, kind: "overlay", items: stressOverlays.filter((_, itemIndex) => itemIndex % 3 === index) }))
        : [{ id: "captions_1", name: "Captions", kind: "caption", items: captions }]),
    ],
    ids: { clip: isChunkStress ? 6 : 2, caption: isChunkStress ? 10 : 7 },
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

async function selectRealSources(mediaRoot) {
  const names = (await readdir(mediaRoot)).filter((name) => VIDEO_EXTENSIONS.has(extname(name).toLowerCase())).sort();
  const preferred = [
    ["dji_export_20260629_215630_1782741390317_editor.mp4", 12],
    ["dji_export_20260629_220010_1782741610439_editor.mp4", 40],
  ];
  const selected = [];
  for (const [name, sourceInSeconds] of preferred) {
    if (!names.includes(name)) continue;
    const file = resolve(mediaRoot, name);
    const info = probe(file);
    if (info.duration >= sourceInSeconds + 3.4 && info.width === 1920 && info.height === 1080 && info.audio && info.fps > 0)
      selected.push({ id: `real_source_${selected.length + 1}`, name, file, ...info, sourceInSeconds });
  }
  const ordered = names.filter((name) => !selected.some((source) => source.name === name));
  for (const name of ordered) {
    if (selected.length === 2) break;
    const file = resolve(mediaRoot, name);
    const info = probe(file);
    if (info.duration >= 7.4 && info.width === 1920 && info.height === 1080 && info.audio && info.fps > 0) {
      selected.push({ id: `real_source_${selected.length + 1}`, name, file, ...info, sourceInSeconds: selected.length === 0 ? 12 : 40 });
    }
  }
  if (selected.length !== 2) throw new Error(`could not find two 1080p sources with audio and enough duration in ${mediaRoot}`);
  return selected;
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
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=7.5",
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
  const captions = project.tracks.filter((track) => track.kind === "caption" || track.kind === "overlay")
    .flatMap((track) => track.items);
  return {
    videoItems: video.items.length,
    captions: captions.length,
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
  const realSources = await selectRealSources(root);
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
  const sourceFiles = [
    { id: "diagnostic_source", caseId: "diagnostic", file: diagnostic, path: "shared/diagnostic.mp4", info: diag },
    ...realSources.map((item) => ({ id: item.id, caseId: "real", name: item.name, file: item.file, info: item, path: `raw/${item.name}` })),
  ];
  for (const item of sourceFiles) {
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
  const cases = [
    {
      caseId: "diagnostic",
      media: [
        { ...diag, id: "diagnostic_source", path: "shared/diagnostic.mp4", sourceInSeconds: 0.5 },
        { ...diag, id: "diagnostic_source", path: "shared/diagnostic.mp4", sourceInSeconds: 4.1 },
      ],
    },
    { caseId: "real", media: realSources.map((item) => ({ ...item, path: `raw/${item.name}` })) },
  ];
  for (const fixtureCase of cases) {
    for (const variant of ["hardcut", "overlay-transition", "chunk-stress"]) {
      const projectDirPath = resolve(output, `${fixtureCase.caseId}-${variant}`);
      await mkdir(resolve(projectDirPath, ".splicewright"), { recursive: true });
      await symlink(rawLinkTarget, resolve(projectDirPath, "raw"), "dir");
      if (fixtureCase.caseId === "diagnostic")
        await symlink(resolve(output, "shared"), resolve(projectDirPath, "shared"), "dir");
      const project = createFixtureProject({ caseId: fixtureCase.caseId, variant, seed, media: fixtureCase.media });
      const mediaById = Object.fromEntries(fixtureCase.media.map((item) => [item.id, item]));
      const cache = {};
      const fingerprints = {};
      for (const asset of Object.values(project.assets)) {
        const sourceInfo = mediaById[asset.id];
        const mediaOnDisk = resolve(projectDirPath, asset.path);
        const sourceFingerprint = fingerprint(mediaOnDisk);
        if (!sourceFingerprint) throw new Error(`${fixtureCase.caseId}: source path does not resolve from fixture project: ${asset.path}`);
        fingerprints[asset.id] = sourceFingerprint;
        cache[asset.id] = {
          path: asset.path,
          fingerprint: sourceFingerprint,
          kind: "video",
          duration: sourceInfo.duration,
          width: sourceInfo.width,
          height: sourceInfo.height,
          fps: sourceInfo.fps,
          audio: sourceInfo.audio,
        };
      }
      const projectBytes = `${JSON.stringify(project, null, 2)}\n`;
      await writeFile(resolve(projectDirPath, "project.json"), projectBytes, "utf8");
      await writeJson(resolve(projectDirPath, ".splicewright/assets.json"), cache);
      const assetDurations = Object.fromEntries(Object.entries(mediaById).map(([id, sourceInfo]) => [id, sourceInfo.duration]));
      const errors = validate(project, undefined, { assetDurations });
      if (errors.length) throw new Error(`${fixtureCase.caseId}/${variant} failed core validation: ${errors.join("; ")}`);
      const video = project.tracks.find((track) => track.kind === "video");
      const entry = {
        projectDir: projectDirPath,
        projectSha256: sha256(projectBytes),
        width: project.meta.width,
        height: project.meta.height,
        fps: project.meta.fps,
        frames: 180,
        durationSeconds: 6,
        audio: { present: fixtureCase.media.every((item) => item.audio), volume: 1, sourceSampleRates: fixtureCase.media.map((item) => item.audioSampleRate) },
        sources: fixtureCase.media.map((sourceInfo) => ({
          assetId: sourceInfo.id,
          path: sourceInfo.path,
          sourceFps: sourceInfo.fps,
          sourceFrameRate: sourceInfo.frameRate,
          sourceFrames: video.items.filter((clip) => clip.assetId === sourceInfo.id).map((clip) => ({
            itemId: clip.id,
            timelineStartFrame: clip.start,
            durationFrames: clip.duration,
            sourceInSeconds: clip.sourceIn,
            sourceInFrame: Math.round(clip.sourceIn * sourceInfo.fps),
          })),
          sha256: manifest.sources[sourceInfo.id].sha256,
          bytes: manifest.sources[sourceInfo.id].bytes,
          fingerprint: fingerprints[sourceInfo.id],
        })),
        captions: project.tracks.flatMap((track) => track.kind === "caption"
          ? track.items.map(({ start, duration, text }) => ({ start, duration, text }))
          : track.kind === "overlay" ? track.items.map(({ start, duration, props }) => ({ start, duration, text: props.texts?.[0], css: props.css })) : []),
        transitions: video.items.flatMap((clip) => clip.transition ? [{ kind: clip.transition.kind, cutFrame: clip.start + clip.duration, durationFrames: clip.transition.duration }] : []),
        semanticCounts: semanticCounts(project),
        probeCachePath: resolve(projectDirPath, ".splicewright/assets.json"),
      };
      manifest.fixtures.push({ caseId: fixtureCase.caseId, variant, ...entry });
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
