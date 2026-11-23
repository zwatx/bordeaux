import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The renderer as a web page served by the robot (src/hosts/systemcore/server.py).
export default defineConfig({
  root: fileURLToPath(new URL("./src/hosts/systemcore", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist-systemcore", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
