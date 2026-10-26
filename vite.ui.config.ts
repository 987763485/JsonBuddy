import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/design/**"] }
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: ["es2021", "chrome105", "safari15"],
    sourcemap: false
  }
});
