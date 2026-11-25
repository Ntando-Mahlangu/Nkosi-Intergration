import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const html = `<!doctype html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head><body><div id="root"></div><script type="module" src="/src/pages/knowledge/__devHarness.tsx"></script></body></html>`;
export default defineConfig({
  root: "/home/user/Nkosi-Intergration/csi-workspace/client",
  plugins: [react(), { name: "harness", configureServer(s) { s.middlewares.use(async (req, res, next) => { if (req.url && !req.url.startsWith("/api") && !req.url.startsWith("/auth") && !req.url.includes(".") && !req.url.startsWith("/@") && !req.url.startsWith("/src") && !req.url.startsWith("/node_modules")) { res.setHeader("content-type","text/html"); res.end(await s.transformIndexHtml(req.url, html)); return; } next(); }); } }],
  server: { port: 5191, strictPort: true, proxy: { "/api": "http://localhost:4391", "/auth": "http://localhost:4391" } },
});
