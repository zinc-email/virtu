import { defineConfig } from "@pandacss/dev";

// The virtu design system, distilled from the legacy site's SCSS into a
// type-safe token set. Colors are exposed as SEMANTIC roles (bg/surface/
// text/primary/accent/…) so components never name a hue; light/dark is a
// token concern, not a component concern. The `_light` overrides key off the
// data-color-scheme attribute that src/colorScheme.ts stamps on <html>.
//
// The legacy palette was five hues + sass lighten() steps; the raw scales
// below reproduce the exact steps in use (navy #2e4a77 = hsl(217,44%,32%),
// teal #12a0aa, amber #fcbc17, ink #19191c/#0f0f11, paper #f9f9f5).
//
// Sizing philosophy (also legacy): the root font-size is 18px (24px on wide
// monitors) and EVERYTHING else is rem/em, so the whole app scales
// proportionally across screen sizes. Never use px in components.

export default defineConfig({
  preflight: true,
  include: ["./src/**/*.{ts,tsx}"],
  exclude: [],
  // We style exclusively through css()/cx classes — no styled() JSX factory —
  // so JSX prop extraction stays off (it would extract junk utilities from
  // Mantine's Stack/Group props otherwise).
  outdir: "styled-system",

  conditions: {
    extend: {
      // Base tokens are the legacy DARK look (the app defaults to dark).
      light: "[data-color-scheme=light] &",
    },
  },

  globalCss: {
    html: {
      // Legacy responsive scheme: bump the root and every rem scales with it.
      fontSize: "18px",
      "@media (min-width: 1200px)": { fontSize: "24px" },
    },
    "::selection": {
      backgroundColor: "{colors.amber.500}",
      color: "{colors.ink.800}",
    },
  },

  theme: {
    extend: {
      tokens: {
        colors: {
          navy: {
            // hsl(217,44%,L): the legacy lighten($c1, …) steps.
            100: { value: "hsl(217, 44%, 94%)" }, // lighten 61 — control text
            200: { value: "hsl(217, 44%, 82%)" }, // lighten 50 — nav links
            300: { value: "hsl(217, 44%, 65%)" }, // lighten 33 — labels, notes
            400: { value: "hsl(217, 44%, 43%)" }, // lighten 11 — dim detail text
            500: { value: "hsl(217, 44%, 32%)" }, // #2e4a77 — borders
          },
          teal: {
            400: { value: "hsl(184, 81%, 47%)" }, // lighten 10 — hover
            500: { value: "hsl(184, 81%, 36%)" }, // #12a0aa
            600: { value: "hsl(184, 81%, 28%)" }, // light-mode primary
          },
          amber: {
            400: { value: "hsl(43, 97%, 69%)" }, // lighten 15 — hover
            500: { value: "hsl(43, 97%, 54%)" }, // #fcbc17
            600: { value: "hsl(43, 90%, 40%)" }, // light-mode accent
          },
          ink: {
            800: { value: "#19191c" },
            900: { value: "#0f0f11" },
          },
          paper: {
            50: { value: "#f9f9f5" },
            // Light-mode page ground: the same warm paper, a step deeper so the
            // page reads as cream rather than a bare white screen.
            100: { value: "hsl(50, 22%, 91%)" },
          },
        },
        fonts: {
          sans: { value: "'Fira Sans', 'Open Sans', 'Lucida Grande', Verdana, sans-serif" },
          mono: {
            value: "'DejaVu Sans Mono', 'Bitstream Vera Sans Mono', Monaco, Courier, monospace",
          },
        },
        easings: {
          // The legacy switch spring: overshoots, then settles. Rewarding.
          spring: { value: "cubic-bezier(0.12, 1.12, 0.57, 0.98)" },
          settle: { value: "cubic-bezier(0.2, 1.3, 0.7, 1)" },
        },
      },

      semanticTokens: {
        colors: {
          // Surfaces
          bg: { value: { base: "{colors.ink.800}", _light: "{colors.paper.100}" } },
          bgDeep: { value: { base: "{colors.ink.900}", _light: "hsl(50, 12%, 87%)" } },
          surface: {
            // The navy row tint behind entity lists and key/value tables.
            value: { base: "rgba(46, 74, 119, 0.08)", _light: "rgba(46, 74, 119, 0.07)" },
          },
          surfaceHover: {
            value: { base: "rgba(46, 74, 119, 0.25)", _light: "rgba(46, 74, 119, 0.14)" },
          },

          // Lines
          border: { value: { base: "{colors.navy.500}", _light: "hsl(217, 35%, 72%)" } },
          // The ghost of a border: a select's top and sides.
          borderFaint: { value: { base: "rgba(46, 74, 119, 0.4)", _light: "hsl(217, 30%, 85%)" } },
          borderBright: { value: { base: "{colors.navy.400}", _light: "{colors.navy.500}" } },
          hairline: {
            // The faint hover underline (legacy $c8: 50% paper).
            value: { base: "rgba(249, 249, 245, 0.5)", _light: "rgba(25, 25, 28, 0.35)" },
          },

          // Text
          text: { value: { base: "rgba(249, 249, 245, 0.75)", _light: "hsl(240, 6%, 15%)" } },
          heading: { value: { base: "{colors.paper.50}", _light: "{colors.ink.900}" } },
          textDim: { value: { base: "{colors.navy.400}", _light: "hsl(217, 25%, 48%)" } },
          label: { value: { base: "{colors.navy.300}", _light: "hsl(217, 30%, 42%)" } },

          // Controls (buttons, inputs)
          control: { value: { base: "{colors.navy.100}", _light: "{colors.navy.500}" } },
          controlFocus: { value: { base: "#ffffff", _light: "{colors.ink.900}" } },
          controlHoverBg: { value: { base: "{colors.navy.500}", _light: "hsl(217, 44%, 86%)" } },
          focusRing: { value: { base: "{colors.navy.200}", _light: "{colors.navy.500}" } },

          // Nav
          navLink: { value: { base: "{colors.navy.200}", _light: "hsl(217, 30%, 40%)" } },
          navLinkActive: { value: { base: "{colors.navy.100}", _light: "{colors.ink.900}" } },

          // Brand roles
          primary: { value: { base: "{colors.teal.500}", _light: "{colors.teal.600}" } },
          primaryHover: { value: { base: "{colors.teal.400}", _light: "{colors.teal.500}" } },
          onPrimary: { value: { base: "{colors.paper.50}", _light: "{colors.paper.50}" } },
          primaryGlow: {
            value: { base: "rgba(18, 160, 170, 0.4)", _light: "rgba(18, 160, 170, 0.35)" },
          },
          accent: { value: { base: "{colors.amber.500}", _light: "{colors.amber.600}" } },
          accentHover: { value: { base: "{colors.amber.400}", _light: "{colors.amber.500}" } },
          onAccent: { value: { base: "{colors.ink.800}", _light: "{colors.paper.50}" } },
        },
      },
    },
  },
});
