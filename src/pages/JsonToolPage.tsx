import {
  ArrowLeft,
  Check,
  ChevronDown,
  Code2,
  Columns2,
  FileJson,
  FolderOpen,
  ListTree,
  Minimize2,
  Network,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Table2,
  Trash2,
  Wand2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { generateTypescript, rootNameForFile } from "../codegen";
import { JsonEditor, type JsonEditorHandle } from "../components/JsonEditor";
import { useAppStore } from "../store";
import { useResolvedTheme } from "../theme";
import { useT } from "../useT";
import type { JsonView } from "../types";
import {
  byteLength,
  formatBytes,
  formatDate,
  lineCount,
  minifiedJson,
  parseJson,
  prettyJson
} from "../utils";
import type { MessageKey } from "../i18n";

const viewDefs: { id: JsonView; label: MessageKey; icon: typeof Code2 }[] = [
  { id: "text", label: "json.view.text", icon: FileJson },
  { id: "split", label: "json.view.split", icon: Columns2 },
  { id: "graph", label: "json.view.graph", icon: Network },
  { id: "code", label: "json.view.code", icon: Code2 },
  { id: "table", label: "json.view.table", icon: Table2 },
  { id: "tree", label: "json.view.tree", icon: ListTree }
];

export function JsonToolPage() {
  const activeDoc = useAppStore((state) => state.activeDoc);
  if (!activeDoc) return <RecentFilesPage />;
  return <DocumentEditorPage />;
}

function RecentFilesPage() {
  const t = useT();
  const recents = useAppStore((state) => state.recents);
  const createDocument = useAppStore((state) => state.createDocument);
  const pickAndOpen = useAppStore((state) => state.pickAndOpen);
  const openPath = useAppStore((state) => state.openPath);
  const removeRecent = useAppStore((state) => state.removeRecent);
  const language = useAppStore((state) => state.settings.language);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return recents;
    return recents.filter((entry) =>
      `${entry.name} ${entry.path}`.toLowerCase().includes(needle)
    );
  }, [query, recents]);

  return (
    <section className="recents-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">JSON</span>
          <h1>{t("json.recentTitle")}</h1>
          <p>{t("json.recentHint")}</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => void pickAndOpen()}>
            <FolderOpen size={15} />
            {t("json.openFile")}
          </button>
          <button className="btn primary" type="button" onClick={() => void createDocument()}>
            <Plus size={15} />
            {t("json.newFile")}
          </button>
        </div>
      </div>

      <div className="recents-card">
        <div className="recents-toolbar">
          <label className="search-field">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("json.searchPlaceholder")}
              autoFocus
            />
          </label>
          <span className="count-label">
            {t("json.recentCount", { count: filtered.length })}
          </span>
        </div>

        {recents.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">
              <FileJson size={24} />
            </span>
            <h2>{t("json.emptyTitle")}</h2>
            <p>{t("json.emptyBody")}</p>
            <div className="empty-actions">
              <button className="btn primary" type="button" onClick={() => void createDocument()}>
                <Plus size={15} />
                {t("json.newFile")}
              </button>
              <button className="btn" type="button" onClick={() => void pickAndOpen()}>
                <FolderOpen size={15} />
                {t("json.openFile")}
              </button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state compact">
            <p>{t("json.noResults")}</p>
          </div>
        ) : (
          <div className="recent-list">
            {filtered.map((entry) => (
              <div className="recent-row" key={entry.path}>
                <button
                  className="recent-main"
                  type="button"
                  onClick={() => void openPath(entry.path)}
                  title={entry.path}
                >
                  <span className="file-tile">
                    <FileJson size={17} />
                  </span>
                  <span className="recent-name">
                    <strong>{entry.name}</strong>
                    <small>{entry.path}</small>
                  </span>
                  <span className="recent-meta">
                    <span>
                      {formatBytes(entry.size)} · {entry.lines} {t("json.lines")}
                    </span>
                    <small>{formatDate(entry.openedAt, language)}</small>
                  </span>
                </button>
                <button
                  className="icon-btn danger"
                  type="button"
                  title={t("json.deleteAction")}
                  aria-label={t("json.deleteAction")}
                  onClick={() => void removeRecent(entry.path)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function DocumentEditorPage() {
  const t = useT();
  const activeDoc = useAppStore((state) => state.activeDoc)!;
  const text = useAppStore((state) => state.text);
  const dirty = useAppStore((state) => state.dirty);
  const view = useAppStore((state) => state.view);
  const recents = useAppStore((state) => state.recents);
  const setText = useAppStore((state) => state.setText);
  const setView = useAppStore((state) => state.setView);
  const saveActive = useAppStore((state) => state.saveActive);
  const closeDocument = useAppStore((state) => state.closeDocument);
  const createDocument = useAppStore((state) => state.createDocument);
  const pickAndOpen = useAppStore((state) => state.pickAndOpen);
  const openPath = useAppStore((state) => state.openPath);
  const notify = useAppStore((state) => state.notify);
  const theme = useAppStore((state) => state.settings.theme);
  const dark = useResolvedTheme(theme) === "dark";
  const editorRef = useRef<JsonEditorHandle | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const parsed = useMemo(() => parseJson(text), [text]);
  const generated = useMemo(() => {
    if (!parsed.ok) return null;
    return generateTypescript(parsed.value, rootNameForFile(activeDoc.name), activeDoc.name);
  }, [activeDoc.name, parsed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActive();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActive]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const formatDocument = () => {
    if (!parsed.ok) {
      notify("error", t("json.validationFailed"), parsed.error);
      return;
    }
    setText(prettyJson(parsed.value));
    notify("success", t("json.formatted"), activeDoc.name);
  };

  const minifyDocument = () => {
    if (!parsed.ok) {
      notify("error", t("json.validationFailed"), parsed.error);
      return;
    }
    setText(minifiedJson(parsed.value));
    notify("success", t("json.minified"), activeDoc.name);
  };

  const validateDocument = () => {
    if (parsed.ok) {
      notify(
        "success",
        t("json.validated"),
        `${lineCount(text)} ${t("json.lines")} · ${formatBytes(byteLength(text))}`
      );
    } else {
      notify("error", t("json.validationFailed"), parsed.error);
    }
  };

  const viewContent = (() => {
    if (view === "text") {
      return (
        <JsonEditor
          ref={editorRef}
          value={text}
          dark={dark}
          onChange={setText}
        />
      );
    }
    if (view === "code") {
      return (
        <div className="code-preview">
          <div className="code-preview-head">
            <span>{t("json.codeTitle")}</span>
            <code>TypeScript</code>
          </div>
          <pre>
            {generated ??
              `// ${t("json.codeEmpty")}\n// ${parsed.ok ? "" : parsed.error}`}
          </pre>
        </div>
      );
    }
    return (
      <div className="view-placeholder">
        <span className="empty-icon">
          <ListTree size={24} />
        </span>
        <h2>{t(`json.view.${view}` as MessageKey)}</h2>
        <p>{t("json.viewSoon")}</p>
      </div>
    );
  })();

  return (
    <section className="editor-page">
      <div className="editor-toolbar">
        <button
          className="icon-btn"
          type="button"
          title={t("common.back")}
          aria-label={t("common.back")}
          onClick={() => void closeDocument()}
        >
          <ArrowLeft size={16} />
        </button>

        <div className="file-menu-wrap" ref={menuRef}>
          <button
            className="file-chip"
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
          >
            <span className="file-tile small">
              <FileJson size={14} />
            </span>
            <span className="file-chip-copy">
              <strong>{activeDoc.name}</strong>
              <small>{dirty ? t("json.dirty") : activeDoc.path}</small>
            </span>
            <ChevronDown size={14} />
          </button>
          {menuOpen ? (
            <div className="file-menu">
              <span className="file-menu-label">{t("json.recentTitle")}</span>
              {recents.slice(0, 8).map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={`file-menu-item${entry.path === activeDoc.path ? " on" : ""}`}
                  onClick={() => {
                    setMenuOpen(false);
                    if (entry.path !== activeDoc.path) void openPath(entry.path);
                  }}
                >
                  <FileJson size={14} />
                  <span>{entry.name}</span>
                  {entry.path === activeDoc.path ? <Check size={13} /> : null}
                </button>
              ))}
              <div className="file-menu-separator" />
              <button
                type="button"
                className="file-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  void createDocument();
                }}
              >
                <Plus size={14} />
                <span>{t("json.newFile")}</span>
              </button>
              <button
                type="button"
                className="file-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  void pickAndOpen();
                }}
              >
                <FolderOpen size={14} />
                <span>{t("json.openFile")}</span>
              </button>
            </div>
          ) : null}
        </div>

        <div className="toolbar-spacer" />

        <div className="toolbar-actions">
          <button
            className="btn compact"
            type="button"
            onClick={formatDocument}
            title={`${t("common.format")} (⇧⌥F)`}
          >
            <Wand2 size={14} />
            {t("common.format")}
          </button>
          <button
            className="btn compact"
            type="button"
            onClick={minifyDocument}
            title={`${t("common.minify")} (⇧⌥M)`}
          >
            <Minimize2 size={14} />
            {t("common.minify")}
          </button>
          <button
            className="btn compact"
            type="button"
            onClick={validateDocument}
            title={`${t("common.validate")} (⇧⌥V)`}
          >
            <ShieldCheck size={14} />
            {t("common.validate")}
          </button>
          <button
            className="btn compact"
            type="button"
            onClick={() => editorRef.current?.openSearch()}
            disabled={view !== "text"}
            title={`${t("common.search")} (⌘F)`}
          >
            <Search size={14} />
            {t("common.search")}
          </button>
          <button
            className="btn primary compact"
            type="button"
            onClick={() => void saveActive()}
            title={`${t("common.save")} (⌘S)`}
          >
            <Save size={14} />
            {t("common.save")}
          </button>
        </div>
      </div>

      <div className="view-tabs" role="tablist" aria-label="JSON views">
        {viewDefs.map((definition) => {
          const Icon = definition.icon;
          return (
            <button
              key={definition.id}
              type="button"
              role="tab"
              aria-selected={view === definition.id}
              className={view === definition.id ? "on" : ""}
              onClick={() => setView(definition.id)}
            >
              <Icon size={13} />
              {t(definition.label)}
            </button>
          );
        })}
      </div>

      <div className="editor-surface">{viewContent}</div>

      <div className="editor-status">
        <span className={`validity ${parsed.ok ? "valid" : "invalid"}`} title={parsed.ok ? "" : parsed.error}>
          <span className="status-dot" />
          {parsed.ok ? t("status.valid") : t("status.invalid")}
        </span>
        <span>{lineCount(text)} {t("json.lines")}</span>
        <span>{formatBytes(byteLength(text))}</span>
        <span>{t("status.utf8")}</span>
        <span className="status-spacer" />
        <span>{dirty ? t("json.dirty") : t("json.clean")}</span>
      </div>
    </section>
  );
}
