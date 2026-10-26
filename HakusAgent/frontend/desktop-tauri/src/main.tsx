import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary, recordCrash } from "./components/ErrorBoundary";
import "./index.css";
import {
  backend as tauriBackend,
  platform as tauriPlatform,
  shortcuts as tauriShortcuts,
  store as tauriStore,
  tray as tauriTray,
  updater as tauriUpdater,
  voice as tauriVoice,
  window as tauriWindow,
} from "@/api/tauriBridge";
import { detectSystemLocale } from "@/lib/i18n";
import { PHONE_VIEWPORT_QUERY } from "@/lib/responsive";
import { invoke } from "@tauri-apps/api/core";
import {
  projectAndroidVoiceResult,
  projectAndroidVoiceStatus,
} from "@/lib/androidFeatureAdapter";

const isAndroidRuntime =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
const mobileCopy = (zh: string, en: string) => detectSystemLocale() === "zh-CN" ? zh : en;

// ── Window shell + phone composition classes (before first paint) ────
// is-rounded-window: the desktop Tauri window is transparent and #root
// paints CSS rounded corners (Windows 10/11, macOS, Linux). Android keeps
// an opaque native window, so it never gets the class.
// is-phone: mirrors the exact condition the app uses for its phone layout
// (responsive.isPhoneViewport). CSS keys phone overlay geometry on this
// class instead of media queries alone, because some Android WebViews
// report a legacy ~980px layout viewport that would silently opt the
// phone out of media-query-driven rules.
if (!isAndroidRuntime) {
  document.documentElement.classList.add("is-rounded-window");
}
if (typeof __TAURI_INTERNALS__ !== "undefined" && !isAndroidRuntime) {
  document.documentElement.classList.add("is-tauri-window");
}
const syncPhoneClass = () => {
  let matches = false;
  try {
    matches = typeof window.matchMedia === "function" && window.matchMedia(PHONE_VIEWPORT_QUERY).matches;
  } catch {
    matches = false;
  }
  document.documentElement.classList.toggle("is-phone", isAndroidRuntime || matches);
};
syncPhoneClass();
try {
  window
    .matchMedia(PHONE_VIEWPORT_QUERY)
    .addEventListener?.("change", syncPhoneClass);
} catch {
  // Older WebViews without MediaQueryList.addEventListener — the class
  // computed at boot stays; orientation changes are rare enough.
}

// ── Tauri Bridge: wire window.electron to tauriBridge.invoke() ──────
// In Tauri desktop mode, legacy components reference window.electron.
// We bridge them to the Tauri invoke() API so everything works unchanged.
// Install the bridge before React mounts. Settings are loaded from the bridge
// during the first effect; a lazy dynamic import could race that effect and
// send the first read/write to the browser-only localStorage fallback.
if (typeof __TAURI_INTERNALS__ !== "undefined") {
  const isAndroid = isAndroidRuntime;

    const mobileWindow = {
      minimize: async () => false,
      toggleMaximize: async () => false,
      close: async () => false,
      isMaximized: async () => false,
    };
    const mobileUpdater = {
      getStatus: async () => ({ status: "not-available", info: null, progress: null, error: mobileCopy("Android APK 暂不支持桌面自动更新", "Desktop updates are not available in the Android APK"), autoDownload: false, autoInstallOnAppQuit: false, currentVersion: "0.3.0", isPackaged: true }),
      check: async () => ({ status: "not-available", info: null, progress: null, error: mobileCopy("Android APK 暂不支持桌面自动更新", "Desktop updates are not available in the Android APK"), autoDownload: false, autoInstallOnAppQuit: false, currentVersion: "0.3.0", isPackaged: true }),
      download: async () => ({ status: "not-available", info: null, progress: null, error: mobileCopy("Android APK 暂不支持桌面自动更新", "Desktop updates are not available in the Android APK"), autoDownload: false, autoInstallOnAppQuit: false, currentVersion: "0.3.0", isPackaged: true }),
      install: async () => ({ ok: false }),
      setAutoDownload: async () => ({ status: "not-available" }),
      setAutoInstallOnAppQuit: async () => ({ status: "not-available" }),
    };
    const androidCeliaUnavailable = mobileCopy(
      "Android 上的 Celia 扩展不可用",
      "The Celia extension is unavailable on Android",
    );
    const androidCeliaRuntimeUnavailable = mobileCopy(
      "Android Runtime 扩展服务不可用",
      "The Android Runtime extension service is unavailable",
    );
    const mobileVoice = {
      status: async () => {
        try {
          const value = await invoke("plugin:hakus-android-asr|status");
          return projectAndroidVoiceStatus(value, androidCeliaUnavailable);
        } catch {
          return projectAndroidVoiceStatus(undefined, androidCeliaRuntimeUnavailable);
        }
      },
      startCelia: async (options?: { threadId?: string }) => {
        try {
          void options;
          const value = await invoke("plugin:hakus-android-asr|start", { modelDir: "" });
          return projectAndroidVoiceResult(value, "start", androidCeliaUnavailable);
        } catch {
          return projectAndroidVoiceResult(undefined, "start", androidCeliaRuntimeUnavailable);
        }
      },
      stopCelia: async () => {
        try {
          const value = await invoke("plugin:hakus-android-asr|stop");
          return projectAndroidVoiceResult(value, "stop", androidCeliaUnavailable);
        } catch {
          return projectAndroidVoiceResult(undefined, "stop", androidCeliaRuntimeUnavailable);
        }
      },
    };

  (window as any).electron = {
      store: tauriStore,
      window: isAndroid ? mobileWindow : tauriWindow,
      backend: {
        ...tauriBackend,
        restart: async () => {
          try {
            const r = await tauriBackend.restart();
            return { ok: r.ok, port: r.port, error: null, logPath: null };
          } catch (e: any) {
            return { ok: false, port: null, error: e?.message || String(e), logPath: null };
          }
        },
      },
      tray: {
        ...(isAndroid
          ? {
              getConfig: async () => ({ enabled: false, minimizeToTray: false }),
              setEnabled: async () => ({ enabled: false, minimizeToTray: false }),
              setMinimizeToTray: async () => ({ enabled: false, minimizeToTray: false }),
            }
          : tauriTray),
        onNewChat: (_cb: () => void) => () => {},
      },
      shortcuts: isAndroid
        ? {
            getConfig: async () => ({ accelerator: "", default: "" }),
            setAccelerator: async () => ({ ok: false, error: mobileCopy("Android 不支持全局快捷键", "Global shortcuts are not available on Android") }),
            validate: async () => ({ valid: false }),
          }
        : tauriShortcuts,
      updater: {
        ...(isAndroid ? mobileUpdater : tauriUpdater),
        onStatusChange: (_cb: (s: any) => void) => () => {},
      },
      voice: isAndroid ? mobileVoice : tauriVoice,
      // Tauri doesn't ship @types/node; use a literal union matching
      // tauriBridge.platform.os() return values instead of NodeJS.Platform.
      platform: (isAndroid ? "android" : tauriPlatform.os()) as "aix" | "android" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32" | "unknown",
      versions: {
        electron: "tauri-v2",
        chrome: navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || "unknown",
        node: "tauri",
      },
    };

  console.log("[Tauri] window.electron bridge installed");
}

// ── Crash telemetry: uncaught errors leave a trace in localStorage so a
// white-screen is never a dead end. The AppErrorBoundary renders recoverable
// fallbacks for React render errors.
window.addEventListener("error", (event) => {
  recordCrash(`${event.message} (${event.filename?.split("/").pop() || "unknown"}:${event.lineno})`);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as Error | undefined;
  recordCrash(`unhandled rejection: ${reason?.message || String(event.reason)}`);
});

// ── Disable Chromium's native WebView context menu ───────────────────
// The application provides its own text-editing context menu.
if (typeof __TAURI_INTERNALS__ !== "undefined" && !isAndroidRuntime) {
  window.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
    },
    true,
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
