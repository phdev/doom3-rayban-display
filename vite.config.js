import { defineConfig } from "vite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const repository = process.env.GITHUB_REPOSITORY?.split("/").pop();
const buildVer = String(Date.now());

export default defineConfig({
  base: repository ? `/${repository}/` : "/",
  // A per-build id appended (?v=) to the engine artifacts (dhewm3.js/.wasm/.data),
  // which have fixed names and are otherwise cached forever by iOS Safari — so an
  // engine rebuild never reached the device. The app JS is auto-hashed by Vite, but
  // these are copied verbatim from public/, so they need explicit cache-busting.
  define: {
    __ENGINE_VER__: JSON.stringify(buildVer)
  },
  plugins: [
    {
      // Stale-bundle self-detection (iter 31): emit the build id as a tiny
      // static file; the app fetches it with cache:"no-store" at boot and
      // auto-refreshes once if its baked-in __ENGINE_VER__ is older (iOS
      // Safari serves cached index.html way past the Pages 600s TTL).
      name: "emit-version-txt",
      apply: "build",
      closeBundle() {
        writeFileSync(join("dist", "version.txt"), buildVer);
      }
    }
  ],
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
