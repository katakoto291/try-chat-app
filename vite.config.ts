import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    // 開発中は /api へのリクエストを Hono サーバーに転送する
    proxy: { "/api": "http://localhost:3000" },
  },
});
