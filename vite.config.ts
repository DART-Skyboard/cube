import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Its own repo served at the domain root (cube.leatr.xyz), not a subpath
  // of radicaldeepscale.com/session-cube/ — base must be "/" or every
  // built asset URL 404s.
  base: "/",
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
