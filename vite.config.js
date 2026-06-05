import { defineConfig } from "vite";

const repository = process.env.GITHUB_REPOSITORY?.split("/").pop();

export default defineConfig({
  base: repository ? `/${repository}/` : "/",
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
