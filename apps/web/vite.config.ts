import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const env = loadEnv(mode, projectRoot, "");
  const target = env.VITE_API_PROXY_TARGET || "http://127.0.0.1:3001";

  return {
    plugins: [react()],
    envDir: projectRoot,
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target,
          changeOrigin: false,
        },
      },
    },
  };
});
