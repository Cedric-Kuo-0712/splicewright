import { expect, it } from "vitest";
import { parseCube } from "../src/lut.ts";

const cube2 = (head = "DOMAIN_MIN 0.1 0.2 0.3\nDOMAIN_MAX 0.9 0.8 0.7") => `LUT_3D_SIZE 2\n${head}\n${Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join("\n")}`;

it("parses a 3D LUT and honors its explicit domain", () => {
  const lut = parseCube(cube2());
  expect(lut.type).toBe("3D");
  expect(lut.domain.min).toEqual([0.1, 0.2, 0.3]);
  expect(lut.data).toHaveLength(8);
});

it("rejects 1D, oversized, incomplete, and non-finite LUTs", () => {
  expect(() => parseCube("LUT_1D_SIZE 2\n0 0 0\n1 1 1")).toThrow("only 3D");
  expect(() => parseCube("LUT_3D_SIZE 66")).toThrow("2..65");
  expect(() => parseCube("LUT_3D_SIZE 2\n0 0 0")).toThrow("exactly size³");
  expect(() => parseCube(cube2().replace("0 0 0", "NaN 0 0"))).toThrow("unrecognized");
});

it("keeps a '#' inside a quoted TITLE and still strips trailing comments", () => {
  const lut = parseCube(cube2('TITLE "Film #1"\nDOMAIN_MIN 0 0 0 # lower bound'));
  expect(lut.title).toBe("Film #1");
  expect(lut.domain.min).toEqual([0, 0, 0]);
  // a comment may follow the title itself, and may contain quotes
  expect(parseCube(cube2('TITLE "Film #1" # my comment')).title).toBe("Film #1");
  expect(parseCube(cube2('TITLE "Film"   # say "hi"')).title).toBe("Film");
  expect(() => parseCube(cube2('TITLE "Film" junk'))).toThrow("unrecognized");
});

it("reads LUT_3D_INPUT_RANGE as the domain of every channel, and not alongside DOMAIN_*", () => {
  const lut = parseCube(cube2("LUT_3D_INPUT_RANGE 0.1 0.9"));
  expect(lut.domain.min).toEqual([0.1, 0.1, 0.1]);
  expect(lut.domain.max).toEqual([0.9, 0.9, 0.9]);
  expect(() => parseCube(cube2("LUT_3D_INPUT_RANGE 0 1\nDOMAIN_MIN 0 0 0"))).toThrow("duplicate");
});

it("rejects malformed domain ordering", () => {
  expect(() => parseCube(cube2("DOMAIN_MIN 0.9 0.2 0.3\nDOMAIN_MAX 0.1 0.8 0.7"))).toThrow("DOMAIN_MIN must be below");
});
