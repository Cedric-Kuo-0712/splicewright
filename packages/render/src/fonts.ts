// Loads the built-in fonts (core FONTS) in preview and render. Fontsource splits each face by unicode-range,
// so only the slices a frame's text uses are fetched; Remotion waits for CSS fonts before a frame is taken.
// Static packages load only the weights listed in FONTS; variable ones carry the whole range.
import "@fontsource-variable/inter";
import "@fontsource-variable/montserrat";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/poppins/800.css";
import "@fontsource-variable/roboto";
import "@fontsource-variable/dm-sans";
import "@fontsource/lato/400.css";
import "@fontsource/lato/700.css";
import "@fontsource/lato/900.css";
import "@fontsource-variable/tiktok-sans";
import "@fontsource/bebas-neue";
import "@fontsource/anton";
import "@fontsource-variable/oswald";
import "@fontsource-variable/playfair-display";
import "@fontsource-variable/lora";
import "@fontsource-variable/caveat";
import "@fontsource-variable/noto-sans-tc";
import "@fontsource-variable/noto-serif-tc";
