import { defineConfig } from "vite";

export default defineConfig({
  root: "./",
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    strictPort: true,
    port: 5173,
    host: "127.0.0.1"
  }
});
