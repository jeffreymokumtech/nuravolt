import type { Config } from "tailwindcss";

const config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./views/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx,scss,css}",
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        // Brand blue scale — kept for primary CTA / link states
        blue: {
          50: "hsl(var(--blue-50))",
          100: "hsl(var(--blue-100))",
          200: "hsl(var(--blue-200))",
          300: "hsl(var(--blue-300))",
          400: "hsl(var(--blue-400))",
          500: "hsl(var(--blue-500))",
          600: "hsl(var(--blue-600))",
          700: "hsl(var(--blue-700))",
          800: "hsl(var(--blue-800))",
          900: "hsl(var(--blue-900))",
        },
        // Legacy product-line accents — referenced by dashboard charts
        amber: {
          50: "#FFFBEB",
          100: "#FEF3C7",
          200: "#FDE68A",
          500: "#F59E0B",
          600: "#D97706",
          700: "#B45309",
        },
        coral: {
          50: "#FFF1F2",
          100: "#FFE4E6",
          200: "#FECDD3",
          500: "#F43F5E",
          600: "#E11D48",
          700: "#BE123C",
        },
        // Marketing-surface tokens — instrument-grade.
        // `<alpha-value>` placeholder so opacity modifiers (`bg-paper/50`,
        // `bg-signal-positive/10`) generate valid CSS — defaults to 1 when
        // no modifier is given.
        paper: "hsl(var(--paper) / <alpha-value>)",
        "paper-2": "hsl(var(--paper-2) / <alpha-value>)",
        ink: "hsl(var(--ink) / <alpha-value>)",
        "ink-2": "hsl(var(--ink-2) / <alpha-value>)",
        "ink-3": "hsl(var(--ink-3) / <alpha-value>)",
        divider: "hsl(var(--divider) / <alpha-value>)",
        "data-bg": "hsl(var(--data-bg) / <alpha-value>)",
        "data-bg-2": "hsl(var(--data-bg-2) / <alpha-value>)",
        "data-fg": "hsl(var(--data-fg) / <alpha-value>)",
        "data-fg-2": "hsl(var(--data-fg-2) / <alpha-value>)",
        "data-rule": "hsl(var(--data-rule) / <alpha-value>)",
        "signal-positive": "hsl(var(--signal-positive) / <alpha-value>)",
        "signal-warning": "hsl(var(--signal-warning) / <alpha-value>)",
        "signal-critical": "hsl(var(--signal-critical) / <alpha-value>)",
        // Product-surface asset accents — one hue per asset class, used by
        // nav chrome, KPI accents, and plant cards so the asset type is
        // recognisable at a glance across every page.
        "asset-solar": "#2563eb",   // blue-600
        "asset-bess": "#7c3aed",    // violet-600
        "asset-wind": "#0891b2",    // cyan-600
        // shadcn semantic tokens
        primary: "hsl(var(--primary))",
        black1: "#010610",
        secondary: "hsl(var(--secondary))",
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        DEFAULT: "var(--radius)",
        sm: "var(--radius-sm)",
        md: "var(--radius)",
        lg: "var(--radius-lg)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        // `font-mono` across the dashboard now resolves to Geist Mono (was
        // JetBrains Mono) — see src/app/layout.tsx + ops-theme.scss.
        mono: [
          "var(--font-geist-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        meta: ["13px", { lineHeight: "1.4", letterSpacing: "0.01em" }],
        body: ["16px", { lineHeight: "1.55" }],
        h2: ["28px", { lineHeight: "1.25", letterSpacing: "-0.01em" }],
        h1: ["40px", { lineHeight: "1.15", letterSpacing: "-0.015em" }],
        display: ["56px", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
      },
      backgroundImage: {
        banner: "url('/assets/banner.svg')",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        scan: "scan 8s linear infinite",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("daisyui"),
  ],
  daisyui: {
    themes: [
      {
        nuravolt: {
          "primary": "#006FEE",      // blue-600
          "secondary": "#E6F1FF",     // blue-50
          "accent": "#3393FF",        // blue-400
          "base-100": "#ffffff",      // white backgrounds
          "base-200": "#f3f4f6",     // gray-100 secondary bg
          "base-300": "#e5e7eb",     // gray-200 borders
          "base-content": "#001730",  // blue-900 text
          "info": "#3393FF",
          "success": "#10B981",
          "warning": "#F59E0B",
          "error": "#EF4444",
        },
      },
    ],
    base: true,
    styled: true,
    utils: true,
  },
} satisfies Config;

export default config;
