import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { still } from "../src/node.ts";
import { canvasVideoErrorHandler, lookEffects } from "../src/Composition.tsx";

const fixture = join(import.meta.dirname, "../../../examples/look-l0");

it("reports canvas decode failures to Player state and names the item for render failures", () => {
  let failure: Error | undefined;
  const error = new Error("unsupported codec");
  const action = canvasVideoErrorHandler("interview-shot", (next) => { failure = next; })(error);
  expect(action).toBe("fail");
  expect(failure).toBe(error);
  expect(error.message).toContain('item "interview-shot"');
});

it("forces an image canvas while sampling a key-only item with no grade", () => {
  const effects = lookEffects("key-only", undefined, { kind: "chroma", color: "#00ff00", similarity: 0.3, smoothness: 0.1 }, {}, true);
  expect(effects).toHaveLength(1);
});

it("keys synthetic green on the canvas path and reveals the blue track below", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-canvas-key-"));
  cpSync(fixture, dir, { recursive: true });
  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  delete project.tracks[1].items[0].key;
  writeFileSync(join(dir, "project.json"), JSON.stringify(project));

  const readPixels = async (name: string) => {
    const png = join(dir, name);
    await still(dir, 30, png);
    const rgb = execFileSync("ffmpeg", ["-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    return (x: number, y: number) => [...rgb.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
  };
  const beforeKey = await readPixels("before.png");
  expect(beforeKey(20, 20)[1]).toBeGreaterThan(100);
  expect(beforeKey(160, 90)[0]).toBeGreaterThan(220);

  project.tracks[1].items[0].key = { kind: "chroma", color: "#00ff00", similarity: 0.45, smoothness: 0.08 };
  writeFileSync(join(dir, "project.json"), JSON.stringify(project));
  const pixel = await readPixels("keyed.png");
  const [keyedGreen, survivingSubject] = [pixel(20, 20), pixel(160, 90)];
  expect(keyedGreen[2]).toBeGreaterThan(220);
  expect(keyedGreen[0]).toBeLessThan(40);
  expect(survivingSubject[0]).toBeGreaterThan(220);
  expect(survivingSubject[1]).toBeLessThan(40);

  // Remotion Img exposes the same effects chain; exercise the still path with the same synthetic pixels.
  mkdirSync(join(dir, "raw"), { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-i", join(dir, "green-red.mp4"), "-frames:v", "1", "-y", join(dir, "raw", "green-red.png")]);
  project.assets.a_green_red.path = "raw/green-red.png";
  project.assets.a_green_red.kind = "image";
  project.tracks[1].items[0].grade = { exposure: 0 };
  writeFileSync(join(dir, "project.json"), JSON.stringify(project));
  const stillPixels = await readPixels("still-keyed.png");
  expect(stillPixels(20, 20)[2]).toBeGreaterThan(220);
  expect(stillPixels(20, 20)[0]).toBeLessThan(40);
  expect(stillPixels(160, 90)[0]).toBeGreaterThan(220);
  expect(stillPixels(160, 90)[1]).toBeLessThan(40);
});

it("renders curves and a 3D LUT with trilinear sampling against ffmpeg", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-canvas-lut-"));
  cpSync(fixture, dir, { recursive: true });
  const projectPath = join(dir, "project.json"), project = JSON.parse(readFileSync(projectPath, "utf8"));
  delete project.tracks[1].items[0].key;
  mkdirSync(join(dir, "raw"), { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=1", "-frames:v", "1", "-y", join(dir, "raw", "testsrc2.png")]);
  project.assets.a_green_red.path = "raw/testsrc2.png";
  project.assets.a_green_red.kind = "image";
  const lutPath = join(dir, "raw", "swap.cube");
  writeFileSync(lutPath, `LUT_3D_SIZE 2\n${Array.from({ length: 8 }, (_, i) => `${(i >> 1) & 1} ${(i >> 2) & 1} ${i & 1}`).join("\n")}\n`);
  project.assets.a_swap = { id: "a_swap", path: "raw/swap.cube", kind: "lut" };
  writeFileSync(projectPath, JSON.stringify(project));
  const png = (name: string) => join(dir, name);
  const read = (path: string) => execFileSync("ffmpeg", ["-loglevel", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  await still(dir, 30, png("base.png"));
  project.tracks[1].items[0].grade = { curves: { all: [[0, 0], [1, 1]] } };
  writeFileSync(projectPath, JSON.stringify(project));
  await still(dir, 30, png("identity.png"));
  const a = read(png("base.png")), b = read(png("identity.png"));
  expect(b).toEqual(a);
  project.tracks[1].items[0].grade = { lut: { assetId: "a_swap", strength: 0 } };
  writeFileSync(projectPath, JSON.stringify(project));
  await still(dir, 30, png("zero-strength.png"));
  expect(read(png("zero-strength.png"))).toEqual(a);
  project.tracks[1].items[0].grade = { lut: { assetId: "a_swap", strength: 1 } };
  writeFileSync(projectPath, JSON.stringify(project));
  await still(dir, 30, png("ours.png"));
  execFileSync("ffmpeg", ["-loglevel", "error", "-i", png("base.png"), "-vf", `lut3d=file=${lutPath}:interp=trilinear`, "-frames:v", "1", png("oracle.png")]);
  const ours = read(png("ours.png")), oracle = read(png("oracle.png"));
  const mae = ours.reduce((sum, v, i) => sum + Math.abs(v - oracle[i]), 0) / ours.length / 255;
  const pix = (data: Buffer, x: number, y: number) => [...data.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
  expect(mae, JSON.stringify({ ours: [pix(ours, 20, 20), pix(ours, 160, 90)], oracle: [pix(oracle, 20, 20), pix(oracle, 160, 90)] })).toBeLessThanOrEqual(2 / 255);

  // A non-default asymmetric input domain maps each channel independently; FFmpeg ignores DOMAIN_*.
  const min = [0.2, 0.1, 0.3], max = [0.8, 0.9, 0.7];
  const domainPath = join(dir, "raw", "domain.cube");
  writeFileSync(domainPath, `LUT_3D_SIZE 2\nDOMAIN_MIN ${min.join(" ")}\nDOMAIN_MAX ${max.join(" ")}\n${Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join("\n")}\n`);
  project.assets.a_domain = { id: "a_domain", path: "raw/domain.cube", kind: "lut" };
  project.tracks[1].items[0].grade = { lut: { assetId: "a_domain", strength: 1 } };
  writeFileSync(projectPath, JSON.stringify(project));
  await still(dir, 30, png("domain.png"));
  const domain = read(png("domain.png")), source = read(png("base.png"));
  const counts = Array.from({ length: 3 }, () => [0, 0, 0]);
  let domainMae = 0;
  for (let i = 0; i < source.length; i++) {
    const channel = i % 3, input = source[i] / 255;
    const mapped = Math.min(1, Math.max(0, (input - min[channel]) / (max[channel] - min[channel]))) * 255;
    domainMae += Math.abs(domain[i] - mapped);
    counts[channel][input < min[channel] ? 0 : input > max[channel] ? 2 : 1]++;
  }
  expect(domainMae / source.length).toBeLessThanOrEqual(1);
  for (const channelCounts of counts) expect(channelCounts.every((n) => n > 0)).toBe(true);

  // Output levels precede per-channel and master curves; red's curve maps the output black point to 0.1.
  project.tracks[1].items[0].grade = {
    levels: { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0.2, outWhite: 0.8 },
    curves: { r: [[0, 0], [0.2, 0.1], [1, 1]], all: [[0, 0], [1, 1]] },
  };
  writeFileSync(projectPath, JSON.stringify(project));
  await still(dir, 30, png("levels-curves.png"));
  const ranged = read(png("levels-curves.png"));
  for (let i = 0; i < source.length; i++) if (source[i] === 0) {
    expect(Math.abs(ranged[i] - (i % 3 === 0 ? 26 : 51))).toBeLessThanOrEqual(2);
  }

  // Semi-transparent source RGB must be unpremultiplied before nonlinear curves/LUT and premultiplied again.
  const alphaPath = join(dir, "raw", "alpha.png");
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "nullsrc=s=320x180:d=1,format=rgba,geq=r=255:g=0:b=0:a=128", "-frames:v", "1", "-pix_fmt", "rgba", "-y", alphaPath]);
  const alphaSource = execFileSync("ffmpeg", ["-loglevel", "error", "-i", alphaPath, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  expect(alphaSource[3]).toBeGreaterThan(0);
  expect(alphaSource[3]).toBeLessThan(255);
  project.assets.a_green_red.path = "raw/alpha.png";
  delete project.tracks[1].items[0].grade;
  writeFileSync(projectPath, JSON.stringify(project));
  await still(dir, 30, png("alpha-base.png"));
  const identityPath = join(dir, "raw", "identity.cube");
  writeFileSync(identityPath, `LUT_3D_SIZE 2\n${Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join("\n")}\n`);
  project.assets.a_identity = { id: "a_identity", path: "raw/identity.cube", kind: "lut" };
  project.tracks[1].items[0].grade = { curves: { all: [[0, 0], [1, 1]] }, lut: { assetId: "a_identity", strength: 1 } };
  writeFileSync(projectPath, JSON.stringify(project));
  await still(dir, 30, png("alpha-look.png"));
  expect(read(png("alpha-look.png"))).toEqual(read(png("alpha-base.png")));
});

it("applies luma alpha to grayscale video so the lower track shows through, including inversion", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-canvas-luma-"));
  cpSync(fixture, dir, { recursive: true });
  const ramp = join(dir, "raw", "ramp.mp4"); mkdirSync(join(dir, "raw"), { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=black:size=320x180:rate=30:duration=2", "-vf", "geq=lum='255*X/W':cb=128:cr=128", "-pix_fmt", "yuv420p", "-y", ramp]);
  const projectPath = join(dir, "project.json"), project = JSON.parse(readFileSync(projectPath, "utf8"));
  project.assets.a_green_red.path = "raw/ramp.mp4";
  project.tracks[1].items[0].key = { kind: "luma", low: 0.25, high: 0.75 };
  writeFileSync(projectPath, JSON.stringify(project));
  const sample = async () => {
    const png = join(dir, "luma.png"); await still(dir, 30, png);
    const rgb = execFileSync("ffmpeg", ["-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    return (x: number) => [...rgb.subarray((90 * 320 + x) * 3, (90 * 320 + x) * 3 + 3)];
  };
  let pixel = await sample();
  expect(pixel(16)[2]).toBeGreaterThan(200); // below low: transparent blue backdrop
  expect(pixel(16)[0]).toBeLessThan(40);
  expect(pixel(300)[0]).toBeGreaterThan(170); // above high: opaque white/gray
  expect(pixel(300)[1]).toBeGreaterThan(170);
  expect(pixel(300)[2]).toBeGreaterThan(170);
  project.tracks[1].items[0].key.invert = true;
  writeFileSync(projectPath, JSON.stringify(project));
  pixel = await sample();
  expect(pixel(16)[0]).toBeLessThan(50); // inverted low luma stays opaque black
  expect(pixel(16)[2]).toBeLessThan(60);
  expect(pixel(300)[2]).toBeGreaterThan(200); // inverted high luma is transparent
});
