/** Shipped creative SDR looks. Neither upstream source specifies input transfer or gamut. */
const PURPLE = "https://github.com/stripedpurple/color-grading-luts/tree/9757e8b5147693cab49c3fd674bf23dbe28d6c8e";
const FILM = "https://github.com/t3mujinpack/t3mujinpack/tree/0b421f3e25209ed78253d1724a29cc6255c5e7fe";
const native = (id: string, name: string, category: string, file: string, sourcePath: string, sourceGitBlobSha1: string) => ({
  id, name, category, file: `luts/native/${file}`, source: PURPLE, sourcePath, commit: "9757e8b5147693cab49c3fd674bf23dbe28d6c8e",
  sourceGitBlobSha1, license: "MIT", licenseFile: "luts/native/LICENSE",
  // Stated as found, not as a claim that the three names are one party.
  credit: { repositoryLicenseCopyright: "Nixua", fileHeaderCopyright: "Austin Barrett - Striped Purple (wording varies per file)" }, inputProfile: "unspecified" as const, format: "cube" as const,
});
const film = (id: string, name: string, category: string, file: string, sourcePath: string, sourceGitBlobSha1: string) => ({
  id, name, category, file: `luts/film/${file}.cube.gz`, source: FILM, sourcePath, commit: "0b421f3e25209ed78253d1724a29cc6255c5e7fe",
  sourceGitBlobSha1, license: "MIT", licenseFile: "luts/film/LICENSE.txt", credit: { author: "João Almeida / t3mujinpack" }, sourceImageProfile: "sRGB (embedded PNG profile)", inputProfile: "unspecified" as const, format: "hald-rgb8-to-cube-gzip65" as const,
});

export const LUT_PRESETS = [
  native("stripedpurple-1920s", "1920s", "Cinema Through the Ages", "Striped Purple - 1920s.cube", "Cinema Through The Ages/Striped Purple - 1920s.cube", "43e2c4cc46568c7577f40effd7495ffcfffb1a31"),
  native("stripedpurple-1960s", "1960s", "Cinema Through the Ages", "Striped Purple - 1960s.cube", "Cinema Through The Ages/Striped Purple - 1960s.cube", "e5b88e571b40aaa3855a16675fe4867f8ac1ed8d"),
  native("stripedpurple-1970s", "1970s", "Cinema Through the Ages", "Striped Purple - 1970s.cube", "Cinema Through The Ages/Striped Purple - 1970s.cube", "68831626fd3aad959ea57204dbfdc863cf779f0b"),
  native("stripedpurple-1980s", "1980s", "Cinema Through the Ages", "Striped Purple - 1980_s.cube", "Cinema Through The Ages/Striped Purple - 1980_s.cube", "aed192a54c04ef8864ee2fd9f3605bc3a482d4b3"),
  native("stripedpurple-amber-haze", "Amber Haze", "Avant Garde", "Striped Purple - Amber Haze.cube", "Avant Garde/Striped Purple - Amber Haze.cube", "5a6709722990bcd184dc408cf2a4402f35f28f34"),
  native("stripedpurple-turquoise", "Turquoise", "Avant Garde", "Striped Purple - Turquoise.cube", "Avant Garde/Striped Purple - Turquoise.cube", "53bcbd6b9d3e421967f3733c8221f7203febdd77"),
  native("stripedpurple-polaroid-mint-cream", "Polaroid Mint Cream", "Avant Garde", "Striped Purple - Polaroid Mint Cream.cube", "Avant Garde/Striped Purple - Polaroid Mint Cream.cube", "43c8e20f5aa059910ad9af5a0550c9822f1dfe64"),
  native("stripedpurple-blue-lagoon", "Blue Lagoon", "Drink It In", "Striped Purple - Blue Lagoon.cube", "Drink it in!/Striped Purple - Blue Lagoon.cube", "644cec6ddbb550785f3857752088f04bb53abb00"),
  native("stripedpurple-vanilla-bean", "Vanilla Bean", "Drink It In", "Striped Purple - Vanilla Bean.cube", "Drink it in!/Striped Purple - Vanilla Bean.cube", "97e75c858a19f3b8d11299ba478fa4a9ca04630d"),
  film("t3mujin-kodak-portra-400", "Kodak Portra 400", "Film inspired", "kodak-portra-400", "haldcluts/t3mujinpack - Color Negative - Kodak Portra 400.png", "0d97477027d62366e6dc980befca40042cfe1962"),
  film("t3mujin-kodak-gold-200", "Kodak Gold 200", "Film inspired", "kodak-gold-200", "haldcluts/t3mujinpack - Color Negative - Kodak Gold 200.png", "9c928ec6cce36247c5a960d8d8b5f9681a570d98"),
  film("t3mujin-fuji-velvia-50", "Fuji Velvia 50", "Film inspired", "fuji-velvia-50", "haldcluts/t3mujinpack - Color Slide - Fuji Velvia 50.png", "a443d6890edf45123a4288230d64c2be2921e4be"),
  film("t3mujin-fuji-provia-100f", "Fuji Provia 100F", "Film inspired", "fuji-provia-100f", "haldcluts/t3mujinpack - Color Slide - Fuji Provia 100F.png", "c66f73ed74c71db7e3a68882845d5a87e2b5d92d"),
  film("t3mujin-ilford-hp5-plus-400", "Ilford HP5 Plus 400", "Film inspired", "ilford-hp5-plus-400", "haldcluts/t3mujinpack - Black and White - Ilford HP5 Plus 400.png", "f66aa59a5bf805f0fc60200791e0bbbd68ac79c4"),
] as const;

export type LutPreset = (typeof LUT_PRESETS)[number];
