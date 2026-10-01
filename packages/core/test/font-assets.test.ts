import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fontAssetFamily, textCss } from "../src/index.ts";
import { init, load, run, undo } from "../src/persistence.ts";

it("accepts imported fonts in caption styles, guards used assets, and undoes style edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-font-core-"));
  init(dir, { title: "font ops", fps: 30, width: 320, height: 180 });
  expect(run(dir, "importAsset", { path: "raw/brand.otf" })).not.toHaveProperty("error");
  expect(run(dir, "setMeta", { theme: "brand", themes: { brand: { name: "brand", roles: { title: { font: "a_brand" } } } } })).not.toHaveProperty("error");
  expect(textCss(load(dir), "title", undefined, "brand").fontFamily).toContain(fontAssetFamily("a_brand"));
  expect(run(dir, "setTrack", { trackId: "t_3", patch: { textStyle: { font: "a_brand" } } })).not.toHaveProperty("error");
  expect(run(dir, "insertItem", { component: "Text", props: { text: "brand", textStyle: { font: "a_brand" } }, at: 0, duration: 30 })).not.toHaveProperty("error");
  expect(run(dir, "removeAsset", { assetId: "a_brand" })).toMatchObject({ error: { code: "invalid" } });
  expect(undo(dir)).not.toHaveProperty("error");
  expect(undo(dir)).not.toHaveProperty("error");
  expect(undo(dir)).not.toHaveProperty("error");
  expect(load(dir).meta.theme).toBeUndefined();
  expect(load(dir).tracks.find((t) => t.id === "t_3")).not.toHaveProperty("textStyle");
  expect(run(dir, "setTrack", { trackId: "t_3", patch: { textStyle: { font: "missing" } } })).toMatchObject({ error: { code: "invalid" } });
});
