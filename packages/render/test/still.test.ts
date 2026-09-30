import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { still } from "../src/node.ts";

// Spec §10: still-frame snapshot of examples/basic (video + config-registered component + caption).
// UPDATE_SNAPSHOTS=1 rewrites the expected frame; look at it before committing.
const dir = join(import.meta.dirname, "../../../examples/basic");
const expected = join(dir, "expected-30.png");

/** Frame downscaled to 32x18 RGB, so font antialiasing doesn't flake the comparison. */
const pixels = (png: string) =>
  execFileSync("ffmpeg", ["-loglevel", "error", "-i", png, "-vf", "scale=32:18:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);

it("renders examples/basic frame 30 like the snapshot", { timeout: 300_000 }, async () => {
  const out = join(mkdtempSync(join(tmpdir(), "swr-still-")), "30.png");
  await still(dir, 30, out);
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(expected)) copyFileSync(out, expected);
  const [got, want] = [pixels(out), pixels(expected)];
  expect([...got.subarray(0, 3)]).toEqual([255, 0, 0]); // Box from splicewright.config.ts, top-left
  const diff = got.reduce((s, v, i) => s + Math.abs(v - want[i]), 0) / got.length;
  expect(diff).toBeLessThan(2);
});

// M8: masks on the video item, read back as pixels (320×180 frame). Overlay Box sits top-left, captions at the bottom.
it("masks clip the picture: ellipse cuts the corners, an inverted feathered rect cuts the middle", { timeout: 300_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "swr-mask-"));
  cpSync(dir, tmp, { recursive: true, filter: (s) => !/\/(out|\.splicewright)(\/|$)/.test(s) });
  const project = JSON.parse(readFileSync(join(tmp, "project.json"), "utf8"));
  const render = async (mask?: object, blend?: string) => {
    project.tracks.find((t: { kind: string }) => t.kind === "video").items[0].mask = mask;
    project.tracks.find((t: { kind: string }) => t.kind === "overlay").items[0].blend = blend;
    writeFileSync(join(tmp, "project.json"), JSON.stringify(project));
    const png = join(tmp, "f.png");
    await still(tmp, 30, png);
    return execFileSync("ffmpeg", ["-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  };
  const lum = (buf: Buffer, x: number, y: number) => buf[(y * 320 + x) * 3] + buf[(y * 320 + x) * 3 + 1] + buf[(y * 320 + x) * 3 + 2];
  const [corner, mid, edge] = [[300, 20], [160, 90], [80, 90]];
  const plain = await render();
  for (const [x, y] of [corner, mid, edge]) expect(lum(plain, x, y)).toBeGreaterThan(60); // the probes must land on picture

  const ellipse = await render({ shape: "ellipse", x: 0.2, y: 0.2, w: 0.6, h: 0.6 });
  expect(lum(ellipse, 300, 20)).toBe(0);
  expect(Math.abs(lum(ellipse, 160, 90) - lum(plain, 160, 90))).toBeLessThan(6);

  const ring = await render({ shape: "rect", x: 0.25, y: 0.25, w: 0.5, h: 0.5, feather: 20, invert: true });
  expect(Math.abs(lum(ring, 300, 20) - lum(plain, 300, 20))).toBeLessThan(6);
  expect(lum(ring, 160, 90)).toBeLessThan(6);
  const half = lum(ring, 80, 90) / lum(plain, 80, 90); // on the rect's left edge, halfway through the feather
  expect(half).toBeGreaterThan(0.25);
  expect(half).toBeLessThan(0.75);

  // blend on the red Box (top-left 80×80) reaches the video under it: plain it is pure red, difference shows the picture through
  expect([...plain.subarray((20 * 320 + 20) * 3, (20 * 320 + 20) * 3 + 3)]).toEqual([255, 0, 0]);
  const diff = await render(undefined, "difference");
  const at = (20 * 320 + 20) * 3;
  expect(Math.abs(diff[at] - 255) + diff[at + 1] + diff[at + 2]).toBeGreaterThan(30);
  expect(Math.abs(lum(diff, 300, 20) - lum(plain, 300, 20))).toBeLessThan(6); // outside the Box nothing moves
});

// M10: the frame at the cut of a 30-frame transition (t = 0.5) between two 2-colour images, per kind.
// Outgoing: red | yellow (left | right half); incoming: blue | cyan.
it("transitions mid-frame: each kind puts the two pictures where it says", { timeout: 300_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "swr-xfade-"));
  cpSync(dir, tmp, { recursive: true, filter: (s) => !/\/(out|\.splicewright)(\/|$)/.test(s) });
  for (const [name, left, right] of [["a", "red", "yellow"], ["b", "blue", "cyan"]])
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${left}:s=320x180`, "-vf", `drawbox=x=160:y=0:w=160:h=180:color=${right}:t=fill`, "-frames:v", "1", join(tmp, `${name}.png`)]);
  const project = JSON.parse(readFileSync(join(tmp, "project.json"), "utf8"));
  project.assets = { a_a: { id: "a_a", path: "a.png", kind: "image" }, a_b: { id: "a_b", path: "b.png", kind: "image" } };
  const items = [{ id: "i_1", start: 0, duration: 60, assetId: "a_a", sourceIn: 0 }, { id: "i_2", start: 60, duration: 60, assetId: "a_b", sourceIn: 0 }];
  project.tracks = [{ id: "t_1", name: "V1", kind: "video", items }];
  const render = async (kind: string) => {
    items[0] = { ...items[0], transition: { kind, duration: 30, direction: "left" } } as never;
    writeFileSync(join(tmp, "project.json"), JSON.stringify(project));
    const png = join(tmp, "f.png");
    await still(tmp, 60, png);
    const buf = execFileSync("ffmpeg", ["-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1 << 26 });
    return (x: number, y = 90) => [...buf.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
  };
  const near = (got: number[], want: number[]) => expect(got.map((v, i) => Math.abs(v - want[i])).every((d) => d <= 40), `${got} vs ${want}`).toBe(true);
  const [RED, YELLOW, BLUE, CYAN, PURPLE, GREEN] = [[255, 0, 0], [255, 255, 0], [0, 0, 255], [0, 255, 255], [128, 0, 128], [128, 255, 128]];
  const [L, R] = [40, 280]; // probes in the left and right quarters, clear of every edge

  const wipe = await render("wipe"); // revealed from the left: incoming stays put
  (near(wipe(L), BLUE), near(wipe(R), YELLOW));
  const slide = await render("slide"); // incoming shifted half a frame right-to-left: its right half sits on the left
  (near(slide(L), CYAN), near(slide(R), YELLOW));
  const push = await render("push"); // outgoing shoved out to the right: its left half sits on the right
  (near(push(L), CYAN), near(push(R), RED));
  const zoom = await render("zoom"); // incoming half faded in over the zoomed outgoing
  (near(zoom(L), PURPLE), near(zoom(R), GREEN));
  const dissolve = await render("dissolve");
  (near(dissolve(L), PURPLE), near(dissolve(R), GREEN));
  const dip = await render("dip");
  (near(dip(L), [0, 0, 0]), near(dip(R), [0, 0, 0]));
});
