import { execFile, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { load } from "@splicewright/core/node";

const execFileAsync = promisify(execFile);

function inside(root: string, file: string) {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}

/** Decode one requested source frame to a bounded JPEG without upscaling. */
export async function sourceFrame(dir: string, assetId: string, at: number, maxSize = 640) {
  if (!Number.isFinite(at) || at < 0) throw new Error("source time must be a non-negative finite number");
  if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 1280) throw new Error("maxSize must be an integer from 1 to 1280");
  const project = load(dir);
  const asset = project.assets[assetId];
  if (!asset) throw new Error(`asset ${assetId} not found`);
  if (asset.kind !== "video") throw new Error(`asset ${assetId} is ${asset.kind}; source_frame requires video`);

  const root = realpathSync(dir);
  const candidate = resolve(root, asset.path);
  const source = realpathSync(candidate);
  if (!inside(root, source) || !statSync(source).isFile()) throw new Error(`asset ${assetId} source is missing or outside the project`);
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", source]);
  const duration = Number(JSON.parse(stdout).format?.duration);
  if (!Number.isFinite(duration) || at >= duration) throw new Error(`source time ${at} is outside asset duration ${Number.isFinite(duration) ? duration : "unknown"}`);

  const args = ["-hide_banner", "-loglevel", "info", "-ss", String(at), "-copyts", "-i", source, "-frames:v", "1", "-vf", `showinfo,scale=w='min(${maxSize},iw)':h='min(${maxSize},ih)':force_original_aspect_ratio=decrease`, "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"];
  const { image, actualSeconds } = await new Promise<{ image: Buffer; actualSeconds: number }>((ok, fail) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { child.kill(); fail(new Error("decoded preview exceeded 8 MB")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", fail);
    child.once("close", (code) => {
      if (code !== 0) return fail(new Error(stderr.trim() || `ffmpeg exited with ${code}`));
      if (!bytes) return fail(new Error("no video frame at requested source time"));
      const actual = /pts_time:([0-9.]+)/.exec(stderr)?.[1];
      const actualSeconds = actual === undefined ? NaN : Number(actual);
      if (!Number.isFinite(actualSeconds)) return fail(new Error("ffmpeg did not report the decoded frame timestamp"));
      ok({ image: Buffer.concat(chunks), actualSeconds });
    });
  });
  return { image, seconds: actualSeconds };
}
