import { HelpCircle, Moon, Sun } from "lucide-react";
import { useAppStore } from "../store";
import type { MessageKey } from "../i18n";
import { useT } from "../useT";
import type { Page } from "../types";

const pageKeys: Record<Page, MessageKey> = {
  json: "nav.jsonTool",
  compare: "nav.compare",
  streams: "nav.streams",
  mock: "nav.mock",
  settings: "nav.settings"
};

interface TitlebarProps {
  dark: boolean;
}

export function Titlebar({ dark }: TitlebarProps) {
  const t = useT();
  const page = useAppStore((state) => state.page);
  const setPage = useAppStore((state) => state.setPage);
  const setTheme = useAppStore((state) => state.setTheme);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
        </span>
        <span className="brand-name" data-tauri-drag-region>
          {t("app.name")}
        </span>
        <span className="titlebar-divider" />
        <span className="module-name">{t(pageKeys[page])}</span>
      </div>
      <div className="titlebar-actions">
        <button
          className="icon-btn"
          type="button"
          title={t("titlebar.theme")}
          aria-label={t("titlebar.theme")}
          onClick={() => void setTheme(dark ? "light" : "dark")}
        >
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <button
          className="icon-btn"
          type="button"
          title={t("titlebar.help")}
          aria-label={t("titlebar.help")}
          onClick={() => setPage("settings")}
        >
          <HelpCircle size={15} />
        </button>
      </div>
    </header>
  );
}
