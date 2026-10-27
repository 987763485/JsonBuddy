import {
  Activity,
  Braces,
  GitCompareArrows,
  Server,
  Settings
} from "lucide-react";
import type { MessageKey } from "../i18n";
import { useAppStore } from "../store";
import { useT } from "../useT";
import type { Page } from "../types";

const items: { page: Page; key: MessageKey; icon: typeof Braces }[] = [
  { page: "json", key: "nav.jsonTool", icon: Braces },
  { page: "compare", key: "nav.compare", icon: GitCompareArrows },
  { page: "streams", key: "nav.streams", icon: Activity },
  { page: "mock", key: "nav.mock", icon: Server },
  { page: "settings", key: "nav.settings", icon: Settings }
];

export function Rail() {
  const t = useT();
  const page = useAppStore((state) => state.page);
  const setPage = useAppStore((state) => state.setPage);

  return (
    <nav className="rail" aria-label="Application">
      {items.map((item) => {
        const Icon = item.icon;
        const active = page === item.page;
        return (
          <button
            key={item.page}
            type="button"
            className={`rail-btn${active ? " active" : ""}`}
            title={t(item.key)}
            aria-label={t(item.key)}
            aria-current={active ? "page" : undefined}
            onClick={() => setPage(item.page)}
          >
            <Icon size={19} strokeWidth={1.7} />
            <span>{t(item.key)}</span>
          </button>
        );
      })}
    </nav>
  );
}
