import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// En desarrollo la API corre en :3210; en producción la sirve el mismo servidor.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3210" } },
});
