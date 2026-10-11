// Throwaway prototype harness for the editor rebuild (work/rethink/brief.md). Not part of the app build.
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./prototypes/editor", import.meta.url)),
  plugins: [react()],
  server: { port: 5199, strictPort: true, fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] } },
});
