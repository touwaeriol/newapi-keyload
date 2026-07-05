import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef4ff",
          100: "#d9e6ff",
          200: "#bcd2ff",
          300: "#8eb4ff",
          400: "#598bff",
          500: "#3363f7",
          600: "#1f45ec",
          700: "#1934d4",
          800: "#1a2fab",
          900: "#1b2e87",
        },
      },
    },
  },
  plugins: [],
};

export default config;
