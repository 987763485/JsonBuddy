import { Check, Folder, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { useT } from "../useT";
import type { AppSettings, Theme } from "../types";

const themes: Theme[] = ["light", "dark", "system"];

function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function SettingsPage() {
  const t = useT();
  const settings = useAppStore((state) => state.settings);
  const dataRoot = useAppStore((state) => state.dataRoot);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const notify = useAppStore((state) => state.notify);
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(draft.theme);
    return () => {
      document.documentElement.dataset.theme = resolveTheme(settings.theme);
    };
  }, [draft.theme, settings.theme]);

  const save = async () => {
    if (!Number.isInteger(draft.mockPort) || draft.mockPort < 1024 || draft.mockPort > 65535) {
      notify("error", t("settings.invalidPort"));
      return;
    }
    setSaving(true);
    const saved = await updateSettings(draft);
    setSaving(false);
    if (saved) setDraft(useAppStore.getState().settings);
  };

  const checkUpdates = () => {
    if (checking) return;
    setChecking(true);
    window.setTimeout(() => {
      setChecking(false);
      notify("success", t("settings.latest"));
    }, 650);
  };

  return (
    <section className="settings-page">
      <div className="settings-head">
        <div>
          <span className="eyebrow">JSON Studio</span>
          <h1>{t("settings.title")}</h1>
          <p>{t("settings.subtitle")}</p>
        </div>
        <button
          className="btn primary"
          type="button"
          onClick={() => void save()}
          disabled={saving}
        >
          <Check size={15} />
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>

      <div className="settings-card">
        <section className="settings-section">
          <div className="settings-copy">
            <h2>{t("settings.language")}</h2>
            <p>{t("settings.languageHint")}</p>
          </div>
          <div className="segmented">
            {(["en", "zh"] as const).map((language) => (
              <button
                key={language}
                type="button"
                className={draft.language === language ? "on" : ""}
                onClick={() => setDraft({ ...draft, language })}
              >
                {language === "en" ? "English" : "简体中文"}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-copy">
            <h2>{t("settings.theme")}</h2>
            <p>{t("settings.languageHint")}</p>
          </div>
          <div className="segmented">
            {themes.map((theme) => (
              <button
                key={theme}
                type="button"
                className={draft.theme === theme ? "on" : ""}
                onClick={() => setDraft({ ...draft, theme })}
              >
                {t(`settings.theme.${theme}` as const)}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-copy">
            <h2>{t("settings.mock")}</h2>
            <p>{t("settings.portHint")}</p>
          </div>
          <div className="settings-inline">
            <label className="field">
              <span>{t("settings.port")}</span>
              <input
                type="number"
                min={1024}
                max={65535}
                value={draft.mockPort}
                onChange={(event) =>
                  setDraft({ ...draft, mockPort: Number(event.target.value) })
                }
              />
            </label>
            <button
              type="button"
              className={`switch-row${draft.mockHttps ? " on" : ""}`}
              role="switch"
              aria-checked={draft.mockHttps}
              onClick={() => setDraft({ ...draft, mockHttps: !draft.mockHttps })}
            >
              <span className="switch" />
              <span>
                <strong>{t("settings.https")}</strong>
                <small>{t("settings.httpsHint")}</small>
              </span>
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-copy">
            <h2>{t("settings.data")}</h2>
            <p>{t("settings.dataHint")}</p>
          </div>
          <code className="path-box">
            <Folder size={14} />
            {dataRoot || "~/.json_studio"}
          </code>
        </section>
      </div>

      <div className="about-card">
        <div className="about-title">
          <span className="brand-mark small" aria-hidden="true">
            <i />
            <i />
          </span>
          <div>
            <h2>{t("settings.about")}</h2>
            <p>JSON Studio 1.0.0 · 2026-10-26 · MIT · Tauri 2</p>
          </div>
        </div>
        <div className="about-actions">
          <span className="about-meta">{t("settings.runtime")}: Tauri 2</span>
          <button className="btn" type="button" onClick={checkUpdates} disabled={checking}>
            <RefreshCw size={14} className={checking ? "spin" : ""} />
            {checking ? t("settings.checking") : t("settings.checkUpdates")}
          </button>
        </div>
      </div>
    </section>
  );
}
