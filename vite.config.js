import { defineConfig } from "vite";

const repository = process.env.GITHUB_REPOSITORY?.split("/").pop();

export default defineConfig({
  base: repository ? `/${repository}/` : "/",
  // A per-build id appended (?v=) to the engine artifacts (dhewm3.js/.wasm/.data),
  // which have fixed names and are otherwise cached forever by iOS Safari — so an
  // engine rebuild never reached the device. The app JS is auto-hashed by Vite, but
  // these are copied verbatim from public/, so they need explicit cache-busting.
  define: {
    __ENGINE_VER__: JSON.stringify(String(Date.now()))
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  }
});
