import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { PlaceholderPage } from "./components/PlaceholderPage";
import { Rail } from "./components/Rail";
import { Titlebar } from "./components/Titlebar";
import { Toast } from "./components/Toast";
import { ComparePage } from "./pages/ComparePage";
import { JsonToolPage } from "./pages/JsonToolPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StreamsPage } from "./pages/StreamsPage";
import { useAppStore } from "./store";
import { useT } from "./useT";
import { useResolvedTheme } from "./theme";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export default function App() {
  const t = useT();
  const ready = useAppStore((state) => state.ready);
  const error = useAppStore((state) => state.error);
  const page = useAppStore((state) => state.page);
  const settings = useAppStore((state) => state.settings);
  const init = useAppStore((state) => state.init);
  const dark = useResolvedTheme(settings.theme) === "dark";

  useEffect(() => {
    const state = useAppStore.getState();
    if (!state.ready && !state.busy) void state.init();
  }, []);

  useEffect(() => {
    const resolved = dark ? "dark" : "light";
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.lang = settings.language;
    document.documentElement.lang = settings.language === "zh" ? "zh-CN" : "en";
  }, [dark, settings.language]);

  if (!ready) {
    return (
      <div className="splash">
        <span className="brand-mark large" aria-hidden="true">
          <i />
          <i />
        </span>
        <span className="splash-name">JSON Buddy</span>
        <span className="splash-detail">{t("app.loading")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="splash error">
        <span className="empty-icon">
          <AlertTriangle size={24} />
        </span>
        <span className="splash-name">{t("app.failed")}</span>
        <code className="splash-error">{error}</code>
        <button
          className="btn primary"
          type="button"
          onClick={() => void init()}
        >
          <RefreshCw size={14} />
          {t("app.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className={`app-shell${isMac ? " platform-mac" : ""}`}>
      <Titlebar dark={dark} />
      <div className="workspace">
        <Rail />
        <main className="workspace-main">
          {page === "json" ? <JsonToolPage /> : null}
          {page === "compare" ? <ComparePage /> : null}
          {page === "streams" ? <StreamsPage /> : null}
          {page === "mock" ? (
            <PlaceholderPage
              title="placeholder.mockTitle"
              body="placeholder.mockBody"
            />
          ) : null}
          {page === "settings" ? <SettingsPage /> : null}
        </main>
      </div>
      <Toast />
    </div>
  );
}
