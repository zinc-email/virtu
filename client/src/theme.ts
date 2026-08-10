// Mantine theme for virtu. Colors are named by ROLE, never by hue, so
// components say what a color does (`primary`, `accent`) and this file decides
// the actual color — re-theming is a one-file change. Neutrals and surfaces
// come from Mantine's scheme-aware variables (`--mantine-color-body`,
// `-default`, `-text`, `-dimmed`, `-default-border`), so the same components
// render in light and dark. The dark scale is the legacy virtu near-blacks;
// light mode uses Mantine's defaults.
//
// Current mapping (legacy virtu tokens, www/src/styles/global.scss):
//   primary = teal  #12a0aa  (submit/actions, toggles, focus — the brand mark)
//   accent  = amber #fcbc17  (links, CTAs, highlights)

import { Anchor, type MantineColorsTuple, createTheme } from "@mantine/core";

const primary: MantineColorsTuple = [
  "#e2fbfc",
  "#c6f4f6",
  "#9ce9ed",
  "#6ddde3",
  "#46d0d9",
  "#20c2cd",
  "#12a0aa", // 6 = exact legacy teal
  "#0d818a",
  "#06616a",
  "#00434a",
];

const accent: MantineColorsTuple = [
  "#fff8e1",
  "#ffefb3",
  "#ffe382",
  "#ffd74f",
  "#fecb28",
  "#fcbc17", // 5 = exact legacy amber
  "#e0a50f",
  "#c28c0a",
  "#a37406",
  "#855d03",
];

// Dark-scheme surfaces: 7 = body bg (#19191c), 6 = lifted card (#232326),
// 9 ≈ vdkgray (#0f0f11). Light scheme uses Mantine's default gray/white.
const dark: MantineColorsTuple = [
  "#f9f9f5",
  "#d5d5d1",
  "#b1b1ae",
  "#8e8e8b",
  "#6b6b69",
  "#4a4a4c",
  "#232326",
  "#19191c",
  "#141417",
  "#0f0f11",
];

const FONT_SANS = "'Fira Sans', 'Open Sans', system-ui, sans-serif";
const FONT_MONO = "'DejaVu Sans Mono', ui-monospace, Menlo, 'Courier New', monospace";

export const theme = createTheme({
  colors: { primary, accent, dark },
  primaryColor: "primary",
  primaryShade: 6,
  // Pick readable text on filled elements automatically (white on teal, dark
  // on amber) so components don't hardcode a text color. Threshold tuned so
  // the mid-tone teal counts as "dark" → white text.
  autoContrast: true,
  luminanceThreshold: 0.45,
  fontFamily: FONT_SANS,
  fontFamilyMonospace: FONT_MONO,
  headings: {
    fontFamily: FONT_SANS,
    fontWeight: "700",
    // Legacy h1 (the wordmark): 2rem, normal weight, a touch of tracking.
    sizes: { h1: { fontSize: "2rem", fontWeight: "400", lineHeight: "1.1" } },
  },
  defaultRadius: "sm",
  components: {
    // Links are the accent color in both schemes.
    Anchor: Anchor.extend({ defaultProps: { c: "accent" } }),
  },
});
