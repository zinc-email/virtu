// virtu's look (PLAN Lane F): dark theme, #19191c bg, #f9f9f5 text,
// #fcbc17 CTA/links, single centered column max-width 58rem.

import { type MantineColorsTuple, createTheme } from "@mantine/core";

// CTA yellow around #fcbc17 (index 5 = the exact legacy token).
const brand: MantineColorsTuple = [
  "#fff8e1",
  "#ffefb3",
  "#ffe382",
  "#ffd74f",
  "#fecb28",
  "#fcbc17",
  "#e0a50f",
  "#c28c0a",
  "#a37406",
  "#855d03",
];

// Dark surface scale: index 0 = text (#f9f9f5), index 7 = body bg (#19191c).
const dark: MantineColorsTuple = [
  "#f9f9f5",
  "#d5d5d1",
  "#b1b1ae",
  "#8e8e8b",
  "#6b6b69",
  "#4a4a4c",
  "#2e2e31",
  "#19191c",
  "#121215",
  "#0c0c0e",
];

export const theme = createTheme({
  colors: { brand, dark },
  primaryColor: "brand",
  primaryShade: 5,
  fontFamily: "'Fira Sans', system-ui, sans-serif",
  headings: { fontFamily: "'Fira Sans', system-ui, sans-serif" },
});
