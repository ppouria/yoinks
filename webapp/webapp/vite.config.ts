import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// `vite dev` proxies the API to the running server so the app is developed
// against real downloads, never a mock.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.YOINKS_API ?? "http://127.0.0.1:3017",
        changeOrigin: true,
      },
      "/healthz": {
        target: process.env.YOINKS_API ?? "http://127.0.0.1:3017",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../../dist/web/public",
    emptyOutDir: true,
  },
})
