import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // In development, /api/ask goes to the local Ask server (server/ask-server.mjs).
  // The deployed site is static: the Ask tab then answers from retrieval alone.
  server: {
    proxy: {
      "/api/ask": { target: "http://127.0.0.1:3011", changeOrigin: true },
    },
  },
});
