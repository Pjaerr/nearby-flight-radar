// @ts-check
import { defineConfig } from 'astro/config';

// Fully static build. `astro build` emits plain HTML/CSS/JS into ./dist,
// deployable to any static host (GitHub Pages, Cloudflare Pages, Netlify, ...).
export default defineConfig({
  output: 'static',
  // Deployed to GitHub Pages as a project site:
  // https://pjaerr.github.io/nearby-flight-radar/
  site: 'https://pjaerr.github.io',
  base: '/nearby-flight-radar',
});
