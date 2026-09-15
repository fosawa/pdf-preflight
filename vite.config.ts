import { defineConfig } from "vite";

export default defineConfig({
  // 相対パス出力。GitHub Pages のサブディレクトリ配信でもそのまま動く。
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
  },
  worker: {
    format: "es",
  },
  // mupdf は同梱済みの .wasm を import.meta.url 相対で読む。
  // Vite の依存事前バンドルを通すとこの解決が壊れるので除外する。
  optimizeDeps: {
    exclude: ["mupdf"],
  },
  assetsInclude: ["**/*.wasm"],
});
