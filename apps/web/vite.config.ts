import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const privateReviewHeaders={"Cache-Control":"no-store","Referrer-Policy":"no-referrer"};
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    headers: privateReviewHeaders,
    proxy: {
      "/v1": process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.API_PORT??3001}`,
      "/api/auth": process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.API_PORT??3001}`,
      "/health": process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.API_PORT??3001}`,
    },
  },
  preview: {
    port: 4173,
    headers: privateReviewHeaders,
    proxy: {
      "/v1": process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.API_PORT??3001}`,
      "/api/auth": process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.API_PORT??3001}`,
      "/health": process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.API_PORT??3001}`,
    },
  },
});
