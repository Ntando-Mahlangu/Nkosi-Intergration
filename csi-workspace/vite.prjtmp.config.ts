import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ root: "/home/user/Nkosi-Intergration/csi-workspace/client", plugins: [react()], server: { port: 5223, strictPort: true, proxy: { "/api": "http://localhost:4123", "/auth": "http://localhost:4123" } } });
