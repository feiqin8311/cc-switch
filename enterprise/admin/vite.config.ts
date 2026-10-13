import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The enterprise server has no CORS on purpose: in development the browser
// talks to the Vite origin and `/api` is proxied to the server.
const apiProxy = {
  "/api": { target: "http://127.0.0.1:28473", changeOrigin: false },
};

export default defineConfig({
  // Served by the enterprise server at "/" with an index.html fallback for
  // client-side routes, so assets must use absolute URLs.
  base: "/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5174, strictPort: true, proxy: apiProxy },
  preview: { host: "127.0.0.1", port: 5174, strictPort: true, proxy: apiProxy },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
