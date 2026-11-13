import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);

// S3：仅生产环境注册 Service Worker，缓存应用外壳与离线快照，
// 断网刷新/重开仍可加载。开发环境不注册，避免缓存干扰 HMR。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[sw] Service Worker 注册失败，离线缓存不可用:", error);
    });
  });
}
