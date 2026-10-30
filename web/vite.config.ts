import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const target = process.env.MUX_DEV_TARGET ?? "http://localhost:7099";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { "/api": { target, changeOrigin: true }, "/v1": { target, changeOrigin: true }, "/health": target } },
  preview: { port: 4173, proxy: { "/api": { target, changeOrigin: true }, "/v1": { target, changeOrigin: true }, "/health": target } },
  build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
