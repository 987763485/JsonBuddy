import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronDown,
  FileJson,
  GitCompareArrows
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import type { MessageKey } from "../i18n";
import {
  lineDiff,
  prettyForCompare,
  structuralChanges,
  textChanges,
  type ChangeKind,
  type StructuralChange
} from "../diff";
import { useAppStore } from "../store";
import { useT } from "../useT";
import type { RecentDocument } from "../types";
import { formatBytes, parseJson } from "../utils";

interface CompareDoc {
  name: string;
  path: string;
  text: string;
}

type CompareFilter = "all" | ChangeKind;

function sideLabelKey(side: "a" | "b"): MessageKey {
  return side === "a" ? "compare.sideA" : "compare.sideB";
}

export function ComparePage() {
  const t = useT();
  const activeDoc = useAppStore((state) => state.activeDoc);
  const recents = useAppStore((state) => state.recents);
  const refreshRecents = useAppStore((state) => state.refreshRecents);
  const notify = useAppStore((state) => state.notify);

  const [sideA, setSideA] = useState<CompareDoc | null>(() =>
    activeDoc ? { name: activeDoc.name, path: activeDoc.path, text: activeDoc.text } : null
  );
  const [sideB, setSideB] = useState<CompareDoc | null>(null);
  const [mode, setMode] = useState<"structural" | "text">("structural");
  const [ignoreKeyOrder, setIgnoreKeyOrder] = useState(true);
  const [syncScroll, setSyncScroll] = useState(true);
  const [menu, setMenu] = useState<"a" | "b" | null>(null);
  const [filter, setFilter] = useState<CompareFilter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const paneARef = useRef<HTMLDivElement | null>(null);
  const paneBRef = useRef<HTMLDivElement | null>(null);
  const syncingRef = useRef(false);

  const parsedA = useMemo(() => (sideA ? parseJson(sideA.text) : null), [sideA]);
  const parsedB = useMemo(() => (sideB ? parseJson(sideB.text) : null), [sideB]);
  const structuralReady = Boolean(parsedA?.ok && parsedB?.ok);

  const displayA = useMemo(() => {
    if (!sideA) return "";
    if (mode === "structural" && parsedA?.ok) {
      return prettyForCompare(parsedA.value, ignoreKeyOrder);
    }
    return sideA.text;
  }, [ignoreKeyOrder, mode, parsedA, sideA]);

  const displayB = useMemo(() => {
    if (!sideB) return "";
    if (mode === "structural" && parsedB?.ok) {
      return prettyForCompare(parsedB.value, ignoreKeyOrder);
    }
    return sideB.text;
  }, [ignoreKeyOrder, mode, parsedB, sideB]);

  const rows = useMemo(
    () => (sideA && sideB ? lineDiff(displayA, displayB) : []),
    [displayA, displayB, sideA, sideB]
  );

  const changes = useMemo<StructuralChange[]>(() => {
    if (!sideA || !sideB) return [];
    if (mode === "structural" && structuralReady && parsedA?.ok && parsedB?.ok) {
      return structuralChanges(parsedA.value, parsedB.value, ignoreKeyOrder);
    }
    return textChanges(rows);
  }, [ignoreKeyOrder, mode, parsedA, parsedB, rows, sideA, sideB, structuralReady]);

  const counts = useMemo(() => {
    const result: Record<CompareFilter, number> = {
      all: changes.length,
      modified: 0,
      added: 0,
      removed: 0
    };
    for (const change of changes) result[change.kind] += 1;
    return result;
  }, [changes]);

  const visibleChanges = useMemo(
    () => (filter === "all" ? changes : changes.filter((change) => change.kind === filter)),
    [changes, filter]
  );

  useEffect(() => {
    if (!visibleChanges.length) {
      setSelected(null);
      return;
    }
    if (!selected || !visibleChanges.some((change) => change.id === selected)) {
      setSelected(visibleChanges[0].id);
    }
  }, [selected, visibleChanges]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".compare-file-wrap")) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const setLoadedDoc = (side: "a" | "b", doc: CompareDoc) => {
    if (side === "a") setSideA(doc);
    else setSideB(doc);
    setMenu(null);
  };

  const openFromRecent = async (side: "a" | "b", entry: RecentDocument) => {
    try {
      const document = await api.openDocument(entry.path);
      setLoadedDoc(side, { name: document.name, path: document.path, text: document.text });
      await refreshRecents();
    } catch (error) {
      notify("error", t("compare.loadFailed"), errorMessage(error));
    }
  };

  const pickFile = async (side: "a" | "b") => {
    setMenu(null);
    try {
      const path = await api.pickJsonFile();
      if (!path) return;
      const document = await api.openDocument(path);
      setLoadedDoc(side, { name: document.name, path: document.path, text: document.text });
      await refreshRecents();
    } catch (error) {
      notify("error", t("compare.loadFailed"), errorMessage(error));
    }
  };

  const swap = () => {
    setSideA(sideB);
    setSideB(sideA);
  };

  const syncFrom = (source: "a" | "b") => {
    if (!syncScroll || syncingRef.current) return;
    const from = source === "a" ? paneARef.current : paneBRef.current;
    const to = source === "a" ? paneBRef.current : paneARef.current;
    if (!from || !to) return;
    syncingRef.current = true;
    to.scrollTop = from.scrollTop;
    requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  };

  const runCompare = () => {
    notify(
      "success",
      t("compare.updated"),
      changes.length
        ? t("compare.changeCount", { count: changes.length })
        : t("compare.noDiff")
    );
  };

  const renderSideMenu = (side: "a" | "b", doc: CompareDoc | null) => {
    if (menu !== side) return null;
    return (
      <div className="file-menu compare-file-menu">
        <span className="file-menu-label">{t("json.recentTitle")}</span>
        {doc ? (
          <button
            type="button"
            className="file-menu-item on"
            onClick={() => setMenu(null)}
          >
            <FileJson size={14} />
            <span>{doc.name}</span>
          </button>
        ) : null}
        {recents
          .filter((entry) => entry.path !== doc?.path)
          .slice(0, 8)
          .map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="file-menu-item"
              onClick={() => void openFromRecent(side, entry)}
            >
              <FileJson size={14} />
              <span>{entry.name}</span>
            </button>
          ))}
        {activeDoc && activeDoc.path !== doc?.path ? (
          <button
            type="button"
            className="file-menu-item"
            onClick={() =>
              setLoadedDoc(side, {
                name: activeDoc.name,
                path: activeDoc.path,
                text: activeDoc.text
              })
            }
          >
            <GitCompareArrows size={14} />
            <span>{t("compare.currentDocument")}</span>
          </button>
        ) : null}
        <div className="file-menu-separator" />
        <button type="button" className="file-menu-item" onClick={() => void pickFile(side)}>
          <ChevronDown size={14} />
          <span>{t("compare.chooseFile")}</span>
        </button>
      </div>
    );
  };

  const renderFileChip = (side: "a" | "b", doc: CompareDoc | null) => (
    <div className="compare-file-wrap">
      <button
        className="compare-file-chip"
        type="button"
        onClick={() => setMenu(menu === side ? null : side)}
        aria-expanded={menu === side}
      >
        <span className={`ab-badge ${side}`}>{side.toUpperCase()}</span>
        <span className="compare-file-copy">
          <strong>{doc?.name ?? t(sideLabelKey(side))}</strong>
          <small>{doc?.path ?? t("compare.chooseFile")}</small>
        </span>
        <ChevronDown size={14} />
      </button>
      {renderSideMenu(side, doc)}
    </div>
  );

  const renderPane = (side: "a" | "b", doc: CompareDoc | null, parsed: ReturnType<typeof parseJson> | null) => {
    const sideRows = rows;
    return (
      <section className={`compare-pane ${side}`}>
        <header className="compare-pane-head">
          <span className={`ab-badge ${side}`}>{side.toUpperCase()}</span>
          <div className="compare-pane-title">
            <strong>{doc?.name ?? t(sideLabelKey(side))}</strong>
            <small>{doc?.path ?? t("compare.chooseFile")}</small>
          </div>
          {parsed && !parsed.ok ? (
            <span className="invalid-chip" title={parsed.error}>
              <AlertTriangle size={12} />
              {t("compare.invalidSide")}
            </span>
          ) : null}
          <span className="compare-lines">
            {t("compare.lines", {
              count: sideRows.filter((row) => (side === "a" ? row.aNo : row.bNo) != null).length
            })}
          </span>
        </header>
        <div
          className="compare-pane-scroll"
          ref={side === "a" ? paneARef : paneBRef}
          onScroll={() => syncFrom(side)}
        >
          {!doc ? (
            <div className="compare-pane-empty">
              <FileJson size={20} />
              <span>{t("compare.chooseFile")}</span>
              <button className="btn compact" type="button" onClick={() => void pickFile(side)}>
                {t("compare.chooseFile")}
              </button>
            </div>
          ) : (
            sideRows.map((row, index) => {
              const no = side === "a" ? row.aNo : row.bNo;
              const text = side === "a" ? row.aText : row.bText;
              const change =
                side === "a"
                  ? row.kind === "remove" || row.kind === "replace"
                  : row.kind === "add" || row.kind === "replace";
              return (
                <div
                  className={`diff-line${change ? ` ${side}-change` : ""}${row.kind === "equal" ? "" : " changed"}`}
                  key={`${side}-${index}`}
                >
                  <span className="diff-no">{no ?? ""}</span>
                  <span className="diff-text">{text ?? ""}</span>
                </div>
              );
            })
          )}
        </div>
      </section>
    );
  };

  const hasBoth = Boolean(sideA && sideB);
  const filterLabels: Record<CompareFilter, string> = {
    all: t("compare.all"),
    modified: t("compare.modified"),
    added: t("compare.added"),
    removed: t("compare.removed")
  };

  return (
    <section className="compare-page">
      <div className="compare-heading">
        <div>
          <span className="eyebrow">JSON COMPARE</span>
          <h1>{t("compare.title")}</h1>
          <p>{t("compare.subtitle")}</p>
        </div>
        <span className={`diff-pill${changes.length ? " warn" : ""}`}>
          <GitCompareArrows size={13} />
          {changes.length
            ? t("compare.changeCount", { count: changes.length })
            : t("compare.noDiff")}
        </span>
      </div>

      <div className="compare-toolbar">
        {renderFileChip("a", sideA)}
        <button
          className="icon-btn compare-swap"
          type="button"
          title={t("compare.swap")}
          aria-label={t("compare.swap")}
          onClick={swap}
          disabled={!sideA && !sideB}
        >
          <ArrowLeftRight size={15} />
        </button>
        {renderFileChip("b", sideB)}
        <div className="toolbar-spacer" />
        <div className="segmented compare-mode">
          {(["structural", "text"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={mode === value ? "on" : ""}
              onClick={() => setMode(value)}
            >
              {t(value === "structural" ? "compare.structural" : "compare.text")}
            </button>
          ))}
        </div>
        <button
          className={`keyorder${mode === "text" ? " disabled" : ""}`}
          type="button"
          aria-pressed={ignoreKeyOrder}
          onClick={() => {
            if (mode === "structural") setIgnoreKeyOrder((value) => !value);
          }}
        >
          <span className={`switch${ignoreKeyOrder ? " on" : ""}`} />
          {t("compare.ignoreKeyOrder")}
        </button>
        <button className="btn primary compact" type="button" onClick={runCompare} disabled={!hasBoth}>
          <GitCompareArrows size={14} />
          {t("compare.compare")}
        </button>
      </div>

      {!hasBoth ? (
        <div className="compare-empty">
          <span className="empty-icon">
            <GitCompareArrows size={24} />
          </span>
          <h2>{t("compare.emptyTitle")}</h2>
          <p>{t("compare.emptyBody")}</p>
          <div className="empty-actions">
            <button className="btn" type="button" onClick={() => void pickFile("a")}>
              {t("compare.sideA")}
            </button>
            <button className="btn" type="button" onClick={() => void pickFile("b")}>
              {t("compare.sideB")}
            </button>
          </div>
        </div>
      ) : (
        <div className="compare-workspace">
          <div className="compare-panes">
            {renderPane("a", sideA, parsedA)}
            {renderPane("b", sideB, parsedB)}
          </div>
          <aside className="changes-panel">
            <header>
              <strong>{t("compare.changes")}</strong>
              <span>{changes.length}</span>
            </header>
            <div className="change-filters">
              {(Object.keys(filterLabels) as CompareFilter[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={filter === key ? "on" : ""}
                  onClick={() => setFilter(key)}
                >
                  {filterLabels[key]}
                  <span>{counts[key]}</span>
                </button>
              ))}
            </div>
            <div className="change-list">
              {visibleChanges.length ? (
                visibleChanges.map((change) => (
                  <button
                    key={change.id}
                    type="button"
                    className={`change-item${selected === change.id ? " on" : ""} ${change.kind}`}
                    onClick={() => setSelected(change.id)}
                  >
                    <div className="change-top">
                      <span className="change-kind">{filterLabels[change.kind]}</span>
                      <span className="change-path">{change.path}</span>
                    </div>
                    {change.oldValue !== undefined || change.newValue !== undefined ? (
                      <div className="change-values">
                        {change.oldValue !== undefined ? (
                          <code className="old">{change.oldValue}</code>
                        ) : null}
                        {change.newValue !== undefined ? (
                          <code className="new">{change.newValue}</code>
                        ) : null}
                      </div>
                    ) : null}
                  </button>
                ))
              ) : (
                <div className="change-empty">
                  <strong>{t("compare.noChanges")}</strong>
                  <span>{t("compare.noChangesHint")}</span>
                </div>
              )}
            </div>
            <footer>
              <span>{t("compare.changeCount", { count: changes.length })}</span>
              <span>UTF-8</span>
            </footer>
          </aside>
        </div>
      )}

      <div className="compare-status">
        <span>{hasBoth ? `${sideA?.name} ↔ ${sideB?.name}` : t("compare.emptyTitle")}</span>
        <span>
          {formatBytes((sideA?.text.length ?? 0) + (sideB?.text.length ?? 0))} ·{" "}
          {t("compare.changeCount", { count: changes.length })}
        </span>
        <span className="status-spacer" />
        <button
          type="button"
          className="status-toggle"
          onClick={() => setSyncScroll((value) => !value)}
        >
          <span className={`switch${syncScroll ? " on" : ""}`} />
          {t("compare.syncScroll")}
        </button>
      </div>
    </section>
  );
}
