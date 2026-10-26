import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AppSettings,
  BootstrapData,
  JsonDocument,
  MockEndpoint,
  MockProject,
  MockRequestLog,
  MockServerStatus,
  RecentDocument,
  RecentStream,
  StreamErrorPayload,
  StreamEvent,
  StreamLivePayload,
  StreamSnapshot
} from "../src/types";

type AnyWindow = Window & Record<string, any>;

interface BridgeDoc extends JsonDocument {
  id: string;
  lineCount: number;
  sizeLabel: string;
  data?: unknown;
}

const w = window as AnyWindow;
const hasTauri = "__TAURI_INTERNALS__" in window;

if (!document.querySelector('link[rel="icon"]')) {
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.href = "data:,";
  document.head.appendChild(icon);
}

if (hasTauri) {
  // The prototype is a fixed 1440x900 card floating on a padded backdrop.
  // Inside the desktop window it must fill the webview edge to edge.
  const chromeStyle = document.createElement("style");
  chromeStyle.textContent = `
    html, body {
      width: 100% !important;
      height: 100% !important;
      min-height: 0 !important;
      padding: 0 !important;
      display: block !important;
      overflow: hidden !important;
      background: var(--bg) !important;
    }
    #app.app {
      width: 100% !important;
      height: 100% !important;
      border-radius: 0 !important;
      box-shadow: none !important;
    }
    html.buddy-macos .titlebar { padding-left: 78px !important; }
    html.buddy-macos .traffic { display: none !important; }
  `;
  document.head.appendChild(chromeStyle);
  if (/Mac/i.test(navigator.userAgent)) {
    document.documentElement.classList.add("buddy-macos");
  }
  const markDragRegion = () => {
    document
      .querySelectorAll<HTMLElement>(
        ".titlebar, .tb-left, .tb-center, .tb-right, .brand"
      )
      .forEach((element) =>
        element.setAttribute("data-tauri-drag-region", "")
      );
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", markDragRegion, { once: true });
  } else {
    markDragRegion();
  }
}

const lightHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "#A31515" },
  { tag: tags.string, color: "#0451A5" },
  { tag: tags.number, color: "#098658" },
  { tag: tags.bool, color: "#B3388C" },
  { tag: tags.null, color: "#C2185B" },
  { tag: [tags.punctuation, tags.brace, tags.squareBracket], color: "#6F6F76" },
  { tag: tags.invalid, color: "#B33B2E" }
]);

const darkHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "#9CDCFE" },
  { tag: tags.string, color: "#CE9178" },
  { tag: tags.number, color: "#B5CEA8" },
  { tag: tags.bool, color: "#C586C0" },
  { tag: tags.null, color: "#D7BA7D" },
  { tag: [tags.punctuation, tags.brace, tags.squareBracket], color: "#8A8A8A" },
  { tag: tags.invalid, color: "#FF9586" }
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--editor-bg)",
    color: "var(--code-plain)"
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    lineHeight: "20px",
    overflow: "auto"
  },
  ".cm-content": {
    padding: "10px 0 26px",
    caretColor: "var(--accent)"
  },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg)",
    border: "none",
    color: "var(--ink-4)",
    paddingRight: "0"
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "34px",
    padding: "0 11px 0 0",
    textAlign: "right"
  },
  ".cm-activeLine": {
    backgroundColor: "var(--active-line)"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--active-line)",
    color: "var(--ink-3)"
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--selection) !important"
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)"
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--search-match)"
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--search-match-active)"
  },
  ".cm-panels": {
    backgroundColor: "var(--card)",
    color: "var(--ink)",
    borderColor: "var(--line)"
  }
});

const editorStyle = document.createElement("style");
editorStyle.textContent = `
  .code-wrap { overflow: hidden !important; }
  #buddyEditorHost { height: 100%; min-height: 0; display: flex; flex-direction: column; }
  #buddyEditorHost .cm-editor { height: 100%; }
  #buddyEditorHost .cm-editor.cm-focused { outline: none; }
  #buddyEditorHost .cm-scroller { scrollbar-width: thin; }
  #code { display: none !important; }
`;
document.head.appendChild(editorStyle);

let editor: EditorView | null = null;
let editorHost: HTMLDivElement | null = null;
let syncing = false;
let chromeTimer: number | null = null;
const highlightCompartment = new Compartment();

function evalGlobal<T = any>(code: string): T {
  return window.eval(code) as T;
}

function currentDoc(): BridgeDoc | null {
  try {
    return evalGlobal<BridgeDoc | null>("currentDocument");
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function openedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function toast(message: string, detail?: string): void {
  try {
    w.showToast(message, detail);
  } catch {
    console.info(message, detail ?? "");
  }
}

function ensureEditor(): EditorView | null {
  const code = document.getElementById("code");
  const wrap = code?.parentElement;
  if (!wrap) return null;
  if (!editorHost) {
    editorHost = document.createElement("div");
    editorHost.id = "buddyEditorHost";
    wrap.appendChild(editorHost);
  }
  if (!editor) {
    const doc = currentDoc();
    editor = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: doc?.text ?? "",
        extensions: [
          basicSetup,
          json(),
          EditorView.lineWrapping,
          editorTheme,
          highlightCompartment.of(
            syntaxHighlighting(
              document.documentElement.dataset.theme === "dark"
                ? darkHighlight
                : lightHighlight
            )
          ),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || syncing) return;
            const active = currentDoc();
            if (!active) return;
            active.text = update.state.doc.toString();
            active.data = undefined;
            active.lineCount = update.state.doc.lines;
            active.sizeLabel = formatBytes(new Blob([active.text]).size);
            if (chromeTimer) window.clearTimeout(chromeTimer);
            chromeTimer = window.setTimeout(() => {
              try {
                w.updateDocumentChrome(active);
                w.renderFileMenuJsonRecents?.();
              } catch {
                // The prototype may be switching pages while a keystroke lands.
              }
            }, 130);
          })
        ]
      })
    });
  }
  return editor;
}

function syncEditor(force = false): void {
  const view = ensureEditor();
  if (!view) return;
  const doc = currentDoc();
  const next = doc?.text ?? "";
  const current = view.state.doc.toString();
  if (force || current !== next) {
    syncing = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: next }
    });
    syncing = false;
  }
}

function updateEditorHighlight(): void {
  if (!editor) return;
  const style =
    document.documentElement.dataset.theme === "dark"
      ? darkHighlight
      : lightHighlight;
  editor.dispatch({
    effects: highlightCompartment.reconfigure(syntaxHighlighting(style))
  });
}

function patchDocumentFunctions(): void {
  const originalDocumentSize = w.documentSize;
  const originalDocumentLineCount = w.documentLineCount;
  const originalRenderCode = w.renderCode;
  const originalApplyTheme = w.applyTheme;

  w.documentSize = (doc: BridgeDoc | null) => {
    if (doc && doc.text == null && doc.sizeLabel) return doc.sizeLabel;
    return originalDocumentSize(doc);
  };
  w.documentLineCount = (doc: BridgeDoc | null) => {
    if (doc && doc.text == null && doc.lineCount != null) return doc.lineCount;
    return originalDocumentLineCount(doc);
  };
  w.renderCode = () => {
    originalRenderCode();
    syncEditor(true);
  };
  w.applyTheme = (theme: string) => {
    originalApplyTheme(theme);
    updateEditorHighlight();
  };
}

function applyBackendSettings(settings: AppSettings): void {
  evalGlobal(`appSettings = ${JSON.stringify(settings)}`);
  try {
    w.applyTheme(settings.theme);
    w.applyLanguage(settings.language);
  } catch (error) {
    console.warn("could not apply settings", error);
  }
}

function patchSettingsPersistence(): void {
  w.persistAppSettings = () => {
    const settings = evalGlobal<AppSettings>("appSettings");
    void invoke<AppSettings>("update_settings", { settings })
      .then((saved) => {
        evalGlobal(`appSettings = ${JSON.stringify(saved)}`);
      })
      .catch((error) => {
        toast("Could not save settings", String(error));
      });
  };
}

function recentDocumentEntry(entry: RecentDocument): Record<string, any> {
  return {
    id: entry.path,
    name: entry.name,
    path: entry.path,
    opened: openedLabel(entry.openedAt),
    document: {
      id: entry.path,
      name: entry.name,
      path: entry.path,
      text: null,
      data: undefined,
      sizeLabel: formatBytes(entry.size),
      lineCount: entry.lines
    }
  };
}

function seedRecents(recents: RecentDocument[]): void {
  const list = evalGlobal<any[]>("JSON_RECENTS");
  list.length = 0;
  for (const entry of recents) list.push(recentDocumentEntry(entry));
  try {
    w.renderJsonRecents();
    w.renderFileMenuJsonRecents?.();
    w.renderToolFileMenu?.();
    renderCompareMenus();
  } catch (error) {
    console.warn("could not seed recents", error);
  }
}

function asBridgeDoc(doc: JsonDocument): BridgeDoc {
  return {
    ...doc,
    id: doc.path,
    lineCount: doc.lines,
    sizeLabel: formatBytes(doc.size),
    data: undefined
  };
}

function installDocument(doc: JsonDocument): void {
  const full = asBridgeDoc(doc);
  try {
    w.addJsonRecent(full, full.path);
    w.setCurrentDocument(full);
    w.renderToolFileMenu?.();
    w.renderFileMenuJsonRecents?.();
    renderCompareMenus();
    syncEditor(true);
  } catch (error) {
    console.error("could not install document", error);
  }
}

function compareRecents(): any[] {
  return evalGlobal<any[]>("JSON_RECENTS");
}

function renderCompareMenus(): void {
  const entries = compareRecents();
  for (const side of ["a", "b"] as const) {
    const menu = document.getElementById(side === "a" ? "cmpFileMenuA" : "cmpFileMenuB");
    if (!menu) continue;
    const label = side === "a" ? "Open in A" : "Open in B";
    menu.innerHTML =
      `<div class="cmp-file-menu-label">${label}</div>` +
      entries
        .slice(0, 10)
        .map(
          (entry) =>
            `<button class="cmp-file-option" data-file="${String(entry.name).replaceAll('"', "&quot;")}">
              <svg class="i xs" viewBox="0 0 24 24"><use href="#i-file"/></svg>
              <span class="file-name">${w.escHtml(entry.name)}</span>
              <span class="cmp-ext">JSON</span><span class="cmp-check">✓</span>
            </button>`
        )
        .join("") +
      `<div class="cmp-file-menu-label" style="margin-top:4px">Local file</div>
       <button class="cmp-file-option" data-compare-pick="${side}">
         <svg class="i xs" viewBox="0 0 24 24"><use href="#i-upload"/></svg>
         <span class="file-name">Choose file…</span>
         <span class="cmp-ext">JSON</span>
       </button>`;
    menu.querySelectorAll<HTMLButtonElement>(".cmp-file-option[data-file]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void w.selectCompareFile(side, button.dataset.file ?? "");
      });
    });
    menu.querySelector<HTMLButtonElement>("[data-compare-pick]")?.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        void w.pickCompareFile(side);
      }
    );
  }
  try {
    w.syncCompareFileMenus();
  } catch {
    // Menus are repopulated before first use.
  }
}

async function loadCompareFile(side: "a" | "b", path: string, name: string): Promise<void> {
  const document = await invoke<JsonDocument>("open_json_document", { path });
  let text = document.text;
  try {
    text = `${JSON.stringify(JSON.parse(document.text), null, 2)}\n`;
  } catch {
    // Compare text mode still works with invalid JSON.
  }
  evalGlobal(
    `compareDocs[${JSON.stringify(side)}] = ${JSON.stringify({
      name,
      text
    })};
     compareFileNames[${JSON.stringify(side)}] = ${JSON.stringify(name)};`
  );
  w.updateCompareLabels();
  w.closeCompareFileMenus();
  w.renderDiff();
  w.renderFileMenuJsonRecents?.();
  toast("Opened compare file", `${side.toUpperCase()} · ${name}`);
}

function patchCompareFlow(): void {
  const originalSelect = w.selectCompareFile;
  const originalPick = w.pickCompareFile;
  const originalOpenCompare = w.openCompare;
  let loadedDefaults = false;

  w.selectCompareFile = async (side: "a" | "b", name: string) => {
    const entry = compareRecents().find((item) => item.name === name);
    if (!entry?.path || entry.path === "Local file") {
      originalSelect(side, name);
      return;
    }
    try {
      await loadCompareFile(side, entry.path, name);
    } catch (error) {
      toast("Could not open compare file", String(error));
    }
  };

  w.pickCompareFile = async (side: "a" | "b") => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "JSON", extensions: ["json"] }]
      });
      if (typeof selected !== "string") return;
      const name = selected.split(/[\\/]/).pop() ?? "compare.json";
      await loadCompareFile(side, selected, name);
    } catch (error) {
      toast("Could not open compare file", String(error));
    }
  };

  w.openCompare = () => {
    originalOpenCompare();
    renderCompareMenus();
    if (!loadedDefaults) {
      loadedDefaults = true;
      const entries = compareRecents().filter((entry) => entry.path && entry.path !== "Local file");
      if (entries.length >= 2) {
        void loadCompareFile("a", entries[0].path, entries[0].name).catch(() => undefined);
        void loadCompareFile("b", entries[1].path, entries[1].name).catch(() => undefined);
      }
    }
  };

  renderCompareMenus();
}


interface BridgeStreamFile {
  id: string;
  name: string;
  format: "jsonl" | "zstd";
  paused: boolean;
  mode: "source" | "chat";
  lines: number;
  lineLabel: string;
  compressed?: string;
  decoded?: string;
  decodedMB: number;
  ratio?: string;
  size: string;
  path: string;
  origin: string;
  opened: string;
  modified: string;
  counts: string[];
}

let buddyStreamSnapshot: StreamSnapshot | null = null;
let buddyStreamEvents: StreamEvent[] = [];
let buddyStreamFollowing: string | null = null;
let streamBridgeReady = false;

function streamLineLabel(value: number): string {
  return value.toLocaleString("en-US");
}

function streamRatio(size: number, decoded: number): string {
  if (!size) return "—";
  const ratio = decoded / size;
  return `${ratio.toFixed(1)}×`;
}

function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function streamFileFromRecent(entry: RecentStream): BridgeStreamFile {
  const size = formatBytes(entry.size);
  const decoded = formatBytes(entry.decodedSize);
  return {
    id: entry.path,
    name: entry.name,
    format: entry.format,
    paused: true,
    mode: "source",
    lines: entry.lines,
    lineLabel: streamLineLabel(entry.lines),
    compressed: entry.format === "zstd" ? size : undefined,
    decoded: entry.format === "zstd" ? decoded : undefined,
    decodedMB: entry.decodedSize / (1024 * 1024),
    ratio: entry.format === "zstd" ? streamRatio(entry.size, entry.decodedSize) : undefined,
    size,
    path: directoryOf(entry.path),
    origin: "local stream",
    opened: openedLabel(entry.openedAt),
    modified: new Date(entry.openedAt).toLocaleTimeString("en-GB", { hour12: false }),
    counts: ["—", "—", "—", "—", "—"]
  };
}

function streamFileFromSnapshot(
  snapshot: StreamSnapshot,
  keepOpened?: BridgeStreamFile
): BridgeStreamFile {
  const size = formatBytes(snapshot.size);
  const decoded = formatBytes(snapshot.decodedSize);
  const counts = streamLevelCounts(buddyStreamEvents);
  return {
    id: snapshot.path,
    name: snapshot.name,
    format: snapshot.format,
    paused: true,
    mode: "source",
    lines: snapshot.lines,
    lineLabel: streamLineLabel(snapshot.lines),
    compressed: snapshot.format === "zstd" ? size : undefined,
    decoded: snapshot.format === "zstd" ? decoded : undefined,
    decodedMB: snapshot.decodedSize / (1024 * 1024),
    ratio: snapshot.format === "zstd" ? streamRatio(snapshot.size, snapshot.decodedSize) : undefined,
    size,
    path: directoryOf(snapshot.path),
    origin: "local stream",
    opened: keepOpened?.opened ?? "Just now",
    modified: new Date().toLocaleTimeString("en-GB", { hour12: false }),
    counts: counts.labels
  };
}

function streamLevelCounts(events: StreamEvent[]): {
  labels: string[];
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {
    all: events.length,
    info: 0,
    debug: 0,
    warn: 0,
    error: 0
  };
  for (const event of events) {
    const level = (event.level ?? "info").toLowerCase();
    if (level in counts) counts[level] += 1;
    else counts.info += 1;
  }
  return {
    labels: [
      streamLineLabel(counts.all),
      streamLineLabel(counts.info),
      streamLineLabel(counts.debug),
      streamLineLabel(counts.warn),
      streamLineLabel(counts.error)
    ],
    counts
  };
}

function seedStreamRecents(streams: RecentStream[]): void {
  try {
    const files = evalGlobal<BridgeStreamFile[]>("MONITOR_FILES");
    files.length = 0;
    for (const entry of streams) files.push(streamFileFromRecent(entry));
    w.renderMonitorRecents?.();
    w.renderFileMenuStreamRecents?.();
  } catch (error) {
    console.warn("could not seed streams", error);
  }
}

function eventTime(event: StreamEvent): string {
  if (event.ts) {
    const numeric = Number(event.ts);
    const date =
      Number.isFinite(numeric) && String(event.ts).length >= 10
        ? new Date(numeric)
        : new Date(event.ts);
    if (!Number.isNaN(date.getTime())) {
      return `${date.toLocaleTimeString("en-GB", { hour12: false })}.${String(
        date.getMilliseconds()
      ).padStart(3, "0")}`;
    }
    return event.ts;
  }
  return `L${event.line}`;
}

function eventFields(event: StreamEvent): string[] {
  try {
    const value = JSON.parse(event.raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const skip = new Set([
      "ts",
      "timestamp",
      "time",
      "level",
      "severity",
      "event",
      "type",
      "name"
    ]);
    return Object.entries(value)
      .filter(([key]) => !skip.has(key))
      .slice(0, 3)
      .map(([key, item]) => {
        const text =
          typeof item === "string"
            ? item
            : item === null
              ? "null"
              : JSON.stringify(item);
        return `${w.escHtml(key)}=<b>${w.escHtml(String(text).slice(0, 70))}</b>`;
      });
  } catch {
    return [];
  }
}

function renderRealStreamSource(live: boolean): void {
  const host = document.getElementById("streamCode");
  if (!host) return;
  const visible = buddyStreamEvents.slice(-2000);
  if (!visible.length) {
    host.innerHTML =
      '<div class="stream-spacer" style="height:24px"></div><div class="stream-empty" style="padding:16px;color:var(--ink-3);font-size:10px">No events yet.</div>';
    return;
  }
  const startLine = visible[0].line;
  host.innerHTML = visible
    .map((event, index) => {
      const fresh = live && index >= visible.length - 3;
      return `<div class="sl${fresh ? " new" : ""}"><span class="ln">${event.line}</span><span class="cl">${w.highlightJsonLine(
        event.raw
      )}</span></div>`;
    })
    .join("");
  // Keep the source list bounded; the full file stays on disk.
  if (startLine > 1) {
    host.dataset.startLine = String(startLine);
  }
}

function renderRealStreamEvents(live: boolean): void {
  const list = document.querySelector(".event-list");
  if (!list) return;
  const visible = buddyStreamEvents.slice(-300).reverse();
  list.innerHTML = visible
    .map((event, index) => {
      const level = (event.level ?? "info").toLowerCase();
      const fields = eventFields(event);
      return `<button class="event-item${live && index < 3 ? " fresh" : ""}">
        <div class="ev-top"><span class="ev-time">${w.escHtml(eventTime(event))}</span><span class="ev-level ${level}">${w.escHtml(
          (event.level ?? "INFO").toUpperCase()
        )}</span><span class="ev-name">${w.escHtml(
          event.name ?? `L${event.line}`
        )}</span><span class="ev-ago">L${event.line}</span></div>
        ${fields.length ? `<div class="ev-fields"><span>${fields.join("</span><span>")}</span></div>` : ""}
      </button>`;
    })
    .join("");
  const { counts, labels } = streamLevelCounts(buddyStreamEvents);
  ["filterAll", "filterInfo", "filterDebug", "filterWarn", "filterError"].forEach(
    (id, index) => w.setText(id, labels[index])
  );
  const footer = document.getElementById("staticFootLeft");
  if (footer) footer.textContent = `${counts.all.toLocaleString("en-US")} events`;
}

function updateRealStreamChrome(file: BridgeStreamFile, live: boolean): void {
  const zstd = file.format === "zstd";
  const lines = file.lineLabel;
  w.setText("monStat1", `${lines} lines`);
  if (zstd) {
    w.setHtml("monStat2", live ? "<b>live</b> decoded" : `<b>${file.decoded}</b> decoded`);
    w.setHtml("monStat3", `<b>${file.ratio}</b> zstd`);
  } else {
    w.setHtml("monStat2", live ? "<b>live</b>" : `<b>${file.size}</b>`);
    w.setHtml("monStat3", "<b>JSONL</b> format");
  }
  w.setText("monStat4", live ? "just now" : `modified ${file.modified}`);
  w.setText("stat1Label", zstd ? "Compressed" : "File size");
  w.setText("stat1Value", zstd ? file.compressed : file.size);
  w.setText("stat2Label", zstd ? "Decoded" : "Lines");
  w.setText("stat2Value", zstd ? file.decoded : lines);
  w.setText("stat3Label", zstd ? "Ratio" : "Format");
  w.setText("stat3Value", zstd ? file.ratio : "JSONL");
  w.setText("stat4Label", live ? "Rate" : "Modified");
  w.setText("stat4Value", live ? "live" : file.modified);
  w.setText("srcMeta", zstd ? `${lines} lines · ${file.decoded} decoded` : `${lines} lines · ${file.size}`);
  w.setText("monitorLines", `${lines} lines`);
  w.setText("monitorSize", zstd ? `${file.decoded} decoded` : file.size);
  w.setText("bufferText", `${lines} / 10,000 lines`);
  const fill = document.getElementById("bufferFill");
  if (fill) fill.style.width = `${Math.min(100, (file.lines / 10000) * 100).toFixed(2)}%`;
  w.setText("edgeText", live ? "Following live edge" : "Paused · follow to resume");
  w.setText("monitorStatusText", live ? "Following" : "Paused");
  const pill = document.getElementById("monitorStatusPill");
  if (pill) pill.className = `status-pill ${live ? "live" : "neutral"}`;
  w.setText("lpFrame", live ? "New events appended" : `Last ${file.modified}`);
}

function patchStreamFlow(): void {
  const originalRenderStreamLines = w.renderStreamLines;
  const originalOpenMonitorRecents = w.openMonitorRecents;
  const originalOpenMonitorFile = w.openMonitorFile;
  const originalToggleMonitorPause = w.toggleMonitorPause;
  const originalDeleteMonitorFile = w.deleteMonitorFile;
  const originalOpenMonitorFileDialog = w.openMonitorFileDialog;

  w.renderStreamLines = (format: string, live: boolean, endLine?: number) => {
    if (!buddyStreamSnapshot) {
      originalRenderStreamLines(format, live, endLine);
      return;
    }
    renderRealStreamSource(live);
  };

  const openStreamPath = async (path: string) => {
    if (buddyStreamFollowing) {
      try {
        await invoke("stop_stream_follow", { path: buddyStreamFollowing });
      } catch {
        // The stream may already be closed.
      }
      buddyStreamFollowing = null;
    }
    const snapshot = await invoke<StreamSnapshot>("open_stream", { path });
    buddyStreamSnapshot = snapshot;
    buddyStreamEvents = snapshot.events;
    const files = evalGlobal<BridgeStreamFile[]>("MONITOR_FILES");
    const existingIndex = files.findIndex((file) => file.id === snapshot.path);
    const existing = existingIndex >= 0 ? files[existingIndex] : undefined;
    const entry = streamFileFromSnapshot(snapshot, existing);
    if (existingIndex >= 0) files.splice(existingIndex, 1);
    files.unshift(entry);
    evalGlobal(`activeMonitorFileId = ${JSON.stringify(entry.id)}`);
    originalOpenMonitorFile(entry.id);
    renderRealStreamSource(false);
    renderRealStreamEvents(false);
    updateRealStreamChrome(entry, false);
  };

  w.openMonitorFile = async (id: string) => {
    const file = evalGlobal<BridgeStreamFile[]>("MONITOR_FILES").find(
      (item) => item.id === id
    );
    if (!file) return;
    try {
      await openStreamPath(file.id);
    } catch (error) {
      toast("Could not open stream", String(error));
    }
  };

  w.openMonitorFileDialog = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "JSONL and zstd", extensions: ["jsonl", "zstd", "zst"] }
        ]
      });
      if (typeof selected !== "string") return;
      await openStreamPath(selected);
      toast("Opened stream", selected.split(/[\\/]/).pop() ?? selected);
    } catch (error) {
      toast("Could not open stream", String(error));
    }
  };

  w.toggleMonitorPause = async () => {
    const file = evalGlobal<BridgeStreamFile | null>(
      `getMonitorFile(${JSON.stringify(buddyStreamSnapshot?.path ?? "")})`
    );
    if (!buddyStreamSnapshot || !file) return;
    const shouldFollow = file.paused;
    if (shouldFollow) {
      try {
        await invoke("start_stream_follow", { path: buddyStreamSnapshot.path });
        buddyStreamFollowing = buddyStreamSnapshot.path;
      } catch (error) {
        toast("Could not follow stream", String(error));
        return;
      }
    } else {
      try {
        await invoke("stop_stream_follow", { path: buddyStreamSnapshot.path });
      } catch {
        // Ignore if the watcher has already stopped.
      }
      buddyStreamFollowing = null;
    }
    originalToggleMonitorPause();
    const live = !file.paused;
    renderRealStreamSource(live);
    renderRealStreamEvents(live);
    updateRealStreamChrome(file, live);
    if (live) {
      const code = document.getElementById("streamCode");
      if (code) requestAnimationFrame(() => { code.scrollTop = code.scrollHeight; });
    }
  };

  w.deleteMonitorFile = async (id: string) => {
    try {
      originalDeleteMonitorFile(id);
      const remaining = await invoke<RecentStream[]>("remove_recent_stream", {
        path: id
      });
      seedStreamRecents(remaining);
      if (buddyStreamSnapshot?.path === id) {
        buddyStreamSnapshot = null;
        buddyStreamEvents = [];
      }
    } catch (error) {
      toast("Could not remove stream", String(error));
    }
  };

  w.openMonitorRecents = () => {
    if (buddyStreamFollowing) {
      void invoke("stop_stream_follow", { path: buddyStreamFollowing }).catch(
        () => undefined
      );
      buddyStreamFollowing = null;
    }
    originalOpenMonitorRecents();
  };
}

function startStreamEventBridge(): void {
  if (streamBridgeReady) return;
  if (typeof (window as any).__TAURI_INTERNALS__?.transformCallback !== "function") {
    return;
  }
  streamBridgeReady = true;
  void listen<StreamLivePayload>("stream-live", (event) => {
    const payload = event.payload;
    if (!buddyStreamSnapshot || payload.path !== buddyStreamSnapshot.path) return;
    if (payload.reset) {
      buddyStreamEvents = payload.events;
      toast("Stream reloaded", payload.path.split(/[\\/]/).pop() ?? payload.path);
    } else {
      buddyStreamEvents = [...buddyStreamEvents, ...payload.events];
      const cutoff = buddyStreamEvents.length - 10000;
      if (cutoff > 0) buddyStreamEvents = buddyStreamEvents.slice(cutoff);
    }
    buddyStreamSnapshot = {
      ...buddyStreamSnapshot,
      lines: payload.totalLines,
      decodedSize: payload.decodedSize,
      events: buddyStreamEvents
    };
    const files = evalGlobal<BridgeStreamFile[]>("MONITOR_FILES");
    const file = files.find((item) => item.id === buddyStreamSnapshot?.path);
    if (!file) return;
    file.lines = payload.totalLines;
    file.lineLabel = streamLineLabel(payload.totalLines);
    file.decodedMB = payload.decodedSize / (1024 * 1024);
    file.decoded = formatBytes(payload.decodedSize);
    file.ratio = streamRatio(buddyStreamSnapshot?.size ?? 0, payload.decodedSize);
    file.counts = streamLevelCounts(buddyStreamEvents).labels;
    const code = document.getElementById("streamCode");
    const nearBottom = code
      ? code.scrollHeight - code.scrollTop - code.clientHeight < 50
      : true;
    renderRealStreamSource(!file.paused);
    renderRealStreamEvents(!file.paused);
    updateRealStreamChrome(file, !file.paused);
    if (nearBottom && code) {
      requestAnimationFrame(() => { code.scrollTop = code.scrollHeight; });
    }
  });
  void listen<StreamErrorPayload>("stream-error", (event) => {
    toast("Stream watcher error", event.payload.message);
  });
}

/* ------------------------------------------------------------
   Mock server workspace
   ------------------------------------------------------------ */

interface BridgeMockEndpoint {
  id: string;
  method: string;
  cls: string;
  path: string;
  status: number;
  statusText: string;
  name: string;
  delayMs: number;
  enabled: boolean;
  response: string;
  generated?: string;
  generatedInfo?: { n: number; seed: number };
  importedFrom?: string;
}

interface BridgeMockProject {
  id: string;
  name: string;
  description: string;
  slug: string;
  running: boolean;
  updated: string;
  updatedAt?: string;
  schemaCount: number;
  endpoints: BridgeMockEndpoint[];
}

let mockKnownIds = new Set<string>();
let mockServerRunning = false;
let mockRequestLogs: MockRequestLog[] = [];
let mockSaveTimer: number | null = null;
let mockSaveChain: Promise<void> = Promise.resolve();
let mockEditor: EditorView | null = null;
let mockEditorHost: HTMLDivElement | null = null;
let syncingMockEditor = false;
let mockBridgeReady = false;
let mockSeeded = false;

const mockEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--editor-bg)",
    color: "var(--code-plain)",
    fontSize: "11px"
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    lineHeight: "21px",
    overflow: "auto"
  },
  ".cm-content": {
    padding: "9px 0 16px",
    caretColor: "var(--accent)"
  },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg)",
    border: "none",
    color: "var(--ink-4)",
    paddingRight: "0"
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "38px",
    padding: "0 10px 0 0",
    textAlign: "right",
    fontSize: "9.5px"
  },
  ".cm-activeLine": {
    backgroundColor: "transparent"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--ink-4)"
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--selection) !important"
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)"
  }
});

const mockEditorStyle = document.createElement("style");
mockEditorStyle.textContent = `
  #buddyMockEditorHost { display: none; flex: 1; min-height: 0; overflow: hidden; background: var(--editor-bg); }
  #buddyMockEditorHost.on { display: flex; flex-direction: column; }
  #buddyMockEditorHost .cm-editor { height: 100%; }
  #buddyMockEditorHost .cm-editor.cm-focused { outline: none; }
  #buddyMockEditorHost .cm-scroller { scrollbar-width: thin; }
  #mockCode.buddy-editing { display: none !important; }
`;
document.head.appendChild(mockEditorStyle);

function mockActiveTab(): string {
  try {
    return evalGlobal<string>("activeMockTab") ?? "response";
  } catch {
    return "response";
  }
}

function mockTabIsEditable(tab = mockActiveTab()): boolean {
  return tab === "response" || tab === "examples";
}

function mockCurrentProject(): BridgeMockProject | null {
  try {
    return evalGlobal<BridgeMockProject | null>("getMockProject()");
  } catch {
    return null;
  }
}

function mockStatusText(status: number): string {
  const labels: Record<number, string> = {
    200: "OK",
    201: "Created",
    202: "Accepted",
    204: "No Content",
    301: "Moved Permanently",
    304: "Not Modified",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable"
  };
  return labels[status] ?? "";
}

function mockMethodClass(method: string): string {
  return method === "DELETE" ? "del" : method.toLowerCase();
}

function mockRelativeUpdated(value?: string): string {
  if (!value) return "just now";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function mockResponseText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function mockEndpointToBridge(endpoint: MockEndpoint): BridgeMockEndpoint {
  return {
    id: endpoint.id,
    method: endpoint.method,
    cls: mockMethodClass(endpoint.method),
    path: endpoint.path,
    status: endpoint.status,
    statusText: mockStatusText(endpoint.status),
    name: endpoint.name,
    delayMs: endpoint.delayMs ?? 0,
    enabled: endpoint.enabled !== false,
    response: mockResponseText(endpoint.response)
  };
}

function mockProjectToBridge(
  project: MockProject,
  running: boolean
): BridgeMockProject {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    slug: project.slug,
    running,
    updated: mockRelativeUpdated(project.updatedAt),
    updatedAt: project.updatedAt,
    schemaCount: project.schemaCount ?? 1,
    endpoints: project.endpoints.map(mockEndpointToBridge)
  };
}

function mockParseResponse(endpoint: BridgeMockEndpoint): unknown {
  const raw = endpoint.generated ?? endpoint.response ?? "";
  if (typeof raw !== "string") return raw;
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function mockProjectToBackend(project: BridgeMockProject): MockProject {
  return {
    version: 1,
    id: project.id,
    name: project.name || "Untitled Mock API",
    description: project.description || "",
    slug: project.slug || "",
    updatedAt: project.updatedAt ?? new Date().toISOString(),
    schemaCount: project.schemaCount ?? 1,
    endpoints: project.endpoints.map((endpoint) => ({
      id: endpoint.id || mockUuid(),
      method: endpoint.method,
      path: endpoint.path,
      name: endpoint.name || `${endpoint.method} ${endpoint.path}`,
      status: Number(endpoint.status) || 200,
      delayMs: Number(endpoint.delayMs) || 0,
      enabled: endpoint.enabled !== false,
      response: mockParseResponse(endpoint)
    }))
  };
}

function mockUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function mockAppIsMockView(): boolean {
  try {
    return evalGlobal<string>("app.dataset.view") === "mock";
  } catch {
    return false;
  }
}

function mockPage(): string {
  try {
    return evalGlobal<string>("app.dataset.mockPage") ?? "projects";
  } catch {
    return "projects";
  }
}

function renderMockLogs(): void {
  const host = document.getElementById("mockLogRows");
  if (!host) return;
  const project = mockCurrentProject();
  const logs = project
    ? mockRequestLogs.filter((entry) => entry.projectId === project.id).slice(0, 12)
    : [];
  host.innerHTML = logs.length
    ? logs
        .map(
          (entry) =>
            `<div class="mock-log-row"><span class="method ${mockMethodClass(
              entry.method
            )}">${w.escHtml(entry.method)}</span><span class="ml-path">${w.escHtml(
              entry.path
            )}</span><span class="ml-status">${entry.status}</span><span class="ml-dur">${
              entry.durationMs
            }ms</span></div>`
        )
        .join("")
    : `<div style="padding:12px;font-size:8.5px;color:var(--ink-3)">${w.t(
        "mock.noRequests"
      )}</div>`;
  const count = host.parentElement?.querySelector(
    ".mock-logs-head > span:last-child"
  );
  if (count) count.textContent = String(mockRequestLogs.length);
}

function applyMockRunningState(): void {
  const projects = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS");
  for (const project of projects) project.running = mockServerRunning;
  if (!mockAppIsMockView()) return;
  if (mockPage() === "projects") {
    w.renderMockProjects?.();
  } else {
    w.updateMockProjectUI?.();
    renderMockLogs();
  }
}

function seedMockProjects(
  projects: MockProject[],
  status: MockServerStatus,
  logs: MockRequestLog[]
): void {
  mockServerRunning = status.running;
  mockKnownIds = new Set(projects.map((project) => project.id));
  mockRequestLogs = logs;
  const list = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS");
  list.length = 0;
  for (const project of projects) list.push(mockProjectToBridge(project, status.running));
  const previous = evalGlobal<string | null>("activeMockProjectId");
  const active = projects.some((project) => project.id === previous)
    ? previous
    : projects[0]?.id ?? null;
  evalGlobal(
    `activeMockProjectId = ${JSON.stringify(active)}; activeMockEndpointIndex = 0;`
  );
  mockSeeded = true;
  if (mockAppIsMockView() && mockPage() === "detail" && active) {
    w.updateMockProjectUI?.();
    renderMockLogs();
  }
}

async function startMockServerToggle(): Promise<void> {
  let status: MockServerStatus;
  try {
    status = mockServerRunning
      ? await invoke<MockServerStatus>("stop_mock_server")
      : await invoke<MockServerStatus>("start_mock_server");
  } catch (error) {
    toast("Could not start mock server", String(error));
    return;
  }
  mockServerRunning = status.running;
  applyMockRunningState();
  toast(
    status.running ? w.t("mock.statusRunning") : w.t("mock.statusStopped"),
    status.url
  );
}

async function persistMockProject(project: BridgeMockProject): Promise<void> {
  if (!mockKnownIds.has(project.id)) {
    const created = await invoke<MockProject>("create_mock_project", {
      name: project.name || "Untitled Mock API",
      description: project.description || "",
      slug: project.slug || ""
    });
    const previousId = project.id;
    mockKnownIds.add(created.id);
    project.id = created.id;
    project.name = created.name;
    project.slug = created.slug;
    project.description = created.description;
    try {
      if (evalGlobal<string | null>("activeMockProjectId") === previousId) {
        evalGlobal(`activeMockProjectId = ${JSON.stringify(created.id)}`);
      }
    } catch {
      // The prototype may be closing while a save completes.
    }
  }
  const saved = await invoke<MockProject>("save_mock_project", {
    project: mockProjectToBackend(project)
  });
  mockKnownIds.add(saved.id);
  project.id = saved.id;
  project.name = saved.name;
  project.slug = saved.slug;
  project.description = saved.description;
  project.updatedAt = saved.updatedAt;
  project.updated = mockRelativeUpdated(saved.updatedAt);
  project.schemaCount = saved.schemaCount ?? project.schemaCount;
}

function flushMockSave(project?: BridgeMockProject): Promise<void> {
  if (mockSaveTimer !== null) {
    window.clearTimeout(mockSaveTimer);
    mockSaveTimer = null;
  }
  let target: BridgeMockProject | null = project ?? null;
  if (!target) {
    try {
      target = evalGlobal<BridgeMockProject | null>("getMockProject()");
    } catch {
      target = null;
    }
  }
  if (!target) return mockSaveChain;
  const snapshot = target;
  mockSaveChain = mockSaveChain
    .then(() => persistMockProject(snapshot))
    .then(() => {
      try {
        w.setMockAutosaveState?.("saved");
        if (mockTabIsEditable()) {
          w.setText?.("mockFooterNote", w.mockFooterSaveLabel?.() ?? "");
        }
      } catch {
        // The editor may already be closed.
      }
    })
    .catch((error) => {
      toast("Could not save mock project", String(error));
    });
  return mockSaveChain;
}

function scheduleMockSave(delay = 550): void {
  try {
    w.setMockAutosaveState?.("saving");
  } catch {
    // Footer may not be mounted yet.
  }
  if (mockSaveTimer !== null) window.clearTimeout(mockSaveTimer);
  mockSaveTimer = window.setTimeout(() => {
    mockSaveTimer = null;
    void flushMockSave();
  }, delay);
}

function ensureMockEditor(): EditorView | null {
  const code = document.getElementById("mockCode");
  if (!code) return null;
  if (!mockEditorHost) {
    mockEditorHost = document.createElement("div");
    mockEditorHost.id = "buddyMockEditorHost";
    code.after(mockEditorHost);
  }
  if (!mockEditor) {
    mockEditor = new EditorView({
      parent: mockEditorHost,
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          json(),
          mockEditorTheme,
          highlightCompartment.of(
            syntaxHighlighting(
              document.documentElement.dataset.theme === "dark"
                ? darkHighlight
                : lightHighlight
            )
          ),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || syncingMockEditor) return;
            if (!mockTabIsEditable()) return;
            const endpoint = evalGlobal<BridgeMockEndpoint | null>(
              "getMockEndpoints()[activeMockEndpointIndex]"
            );
            if (!endpoint) return;
            const text = update.state.doc.toString();
            endpoint.response = text;
            endpoint.generated = undefined;
            endpoint.generatedInfo = undefined;
            evalGlobal(`mockCurrentCode = ${JSON.stringify(text)}`);
            w.setText("mockLineCount", update.state.doc.lines);
            w.setText(
              "mockSize",
              `${(new Blob([text]).size / 1024).toFixed(1)} KB`
            );
            scheduleMockSave();
          })
        ]
      })
    });
  }
  return mockEditor;
}

function syncMockEditor(text: string): void {
  const code = document.getElementById("mockCode");
  if (!code) return;
  const editable = mockTabIsEditable();
  code.classList.toggle("buddy-editing", editable);
  const host = document.getElementById("buddyMockEditorHost");
  if (!editable) {
    host?.classList.remove("on");
    return;
  }
  const view = ensureMockEditor();
  if (!view || !mockEditorHost) return;
  mockEditorHost.classList.add("on");
  const current = view.state.doc.toString();
  if (current !== text) {
    syncingMockEditor = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: text } });
    syncingMockEditor = false;
  }
}

function updateMockEditorHighlight(): void {
  if (!mockEditor) return;
  mockEditor.dispatch({
    effects: highlightCompartment.reconfigure(
      syntaxHighlighting(
        document.documentElement.dataset.theme === "dark"
          ? darkHighlight
          : lightHighlight
      )
    )
  });
}

function patchMockFlow(): void {
  const originalRenderMockCode = w.renderMockCode;
  const originalRenderMockEndpoint = w.renderMockEndpoint;
  const originalUpdateMockProjectUI = w.updateMockProjectUI;
  const originalCommitMockEndpointEdits = w.commitMockEndpointEdits;
  const originalToggleMockEnabled = w.toggleMockEnabled;
  const originalSelectMockMethod = w.selectMockMethod;
  const originalConfirmDeleteMockEndpoint = w.confirmDeleteMockEndpoint;
  const originalFormatMockCode = w.formatMockCode;
  const originalGenerateMockData = w.generateMockData;
  const originalSaveMockProject = w.saveMockProject;
  const originalConfirmDeleteMockProject = w.confirmDeleteMockProject;
  const originalImportSchema = w.importSchema;
  const originalCreateMockEndpoint = w.createMockEndpoint;
  const originalOpenMockProject = w.openMockProject;
  const originalOpenMockProjects = w.openMockProjects;

  w.renderMockCode = (text: string, mode: string = "json") => {
    originalRenderMockCode(text, mode);
    if (mode === "json") syncMockEditor(String(text ?? "").replace(/^\n+|\n+$/g, ""));
    else syncMockEditor("");
  };

  w.renderMockEndpoint = (index: number) => {
    originalRenderMockEndpoint(index);
    const endpoint = evalGlobal<BridgeMockEndpoint | null>(
      "getMockEndpoints()[activeMockEndpointIndex]"
    );
    const delay = document.querySelector(".mock-delay");
    if (delay && endpoint) delay.textContent = `${endpoint.delayMs || 0} ms`;
  };

  w.updateMockProjectUI = () => {
    originalUpdateMockProjectUI();
    renderMockLogs();
    const project = mockCurrentProject();
    if (project) w.setText("mockSchemaCount", project.schemaCount || 1);
  };

  w.openMockProject = (id: string) => {
    if (mockSeeded) void flushMockSave();
    originalOpenMockProject(id);
  };

  w.openMockProjects = () => {
    if (mockSeeded) void flushMockSave();
    originalOpenMockProjects();
  };

  w.toggleMockServer = () => {
    void startMockServerToggle();
  };

  w.toggleMockProjectServer = (id: string, event?: Event) => {
    if (event) event.stopPropagation();
    void startMockServerToggle();
  };

  w.commitMockEndpointEdits = () => {
    originalCommitMockEndpointEdits();
    scheduleMockSave();
  };

  w.toggleMockEnabled = (event?: Event) => {
    originalToggleMockEnabled(event);
    void flushMockSave();
  };

  w.selectMockMethod = (method: string) => {
    originalSelectMockMethod(method);
    void flushMockSave();
  };

  w.confirmDeleteMockEndpoint = () => {
    originalConfirmDeleteMockEndpoint();
    void flushMockSave();
  };

  w.formatMockCode = () => {
    originalFormatMockCode();
    void flushMockSave();
  };

  w.generateMockData = () => {
    originalGenerateMockData();
    void flushMockSave();
  };

  w.testMockEndpoint = async () => {
    const project = mockCurrentProject();
    const endpoint = evalGlobal<BridgeMockEndpoint | null>(
      "getMockEndpoints()[activeMockEndpointIndex]"
    );
    if (!project || !endpoint) return;
    if (!mockServerRunning) {
      toast("Mock server is stopped", "Start the project to send requests.");
      return;
    }
    if (endpoint.enabled === false) {
      toast("Endpoint is disabled", `${endpoint.method} ${endpoint.path}`);
      return;
    }
    try {
      const url =
        w.mockBaseUrl(project) + w.mockSamplePathFor(endpoint, project);
      const response = await fetch(url, {
        method: endpoint.method,
        headers: { Accept: "application/json" }
      });
      toast(
        "Request sent",
        `${endpoint.method} ${endpoint.path} · ${response.status} ${
          response.statusText || endpoint.statusText
        }`
      );
    } catch (error) {
      toast("Request failed", String(error));
    }
  };

  w.saveMockProject = async () => {
    const editing = evalGlobal<string | null>("editingMockProjectId");
    const before = new Set(
      evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS").map((project) => project.id)
    );
    originalSaveMockProject();
    const projects = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS");
    if (editing) {
      const project = projects.find((item) => item.id === editing);
      if (project) await persistMockProject(project);
    } else {
      for (const project of projects) {
        if (!before.has(project.id)) await persistMockProject(project);
      }
    }
    try {
      if (mockPage() === "projects") w.renderMockProjects?.();
      else w.updateMockProjectUI?.();
    } catch {
      // The mock page may have been closed while saving.
    }
  };

  w.confirmDeleteMockProject = async () => {
    const deleting = evalGlobal<string | null>("deletingMockProjectId");
    await flushMockSave();
    originalConfirmDeleteMockProject();
    if (deleting && mockKnownIds.has(deleting)) {
      try {
        await invoke("delete_mock_project", { id: deleting });
        mockKnownIds.delete(deleting);
      } catch (error) {
        toast("Could not delete mock project", String(error));
      }
    }
  };

  w.importSchema = async () => {
    const before = new Set(
      evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS").map((project) => project.id)
    );
    originalImportSchema();
    const projects = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS");
    try {
      for (const project of projects) {
        if (!before.has(project.id) || project.id === evalGlobal("activeMockProjectId")) {
          await persistMockProject(project);
        }
      }
      w.renderMockEndpoints?.(evalGlobal<number>("activeMockEndpointIndex") || 0);
      w.updateMockProjectUI?.();
    } catch (error) {
      toast("Could not save imported schema", String(error));
    }
  };

  w.createMockEndpoint = () => {
    const overlay = document.getElementById("overlayNewEndpoint");
    const project = mockCurrentProject();
    if (!overlay || !project) return;
    const method =
      overlay.querySelector<HTMLButtonElement>(".method-picker button.on")
        ?.textContent?.trim() || "GET";
    const inputs = overlay.querySelectorAll<HTMLInputElement>("input");
    let path = inputs[0]?.value.trim() || "/";
    if (!path.startsWith("/")) path = `/${path}`;
    const status = Number(inputs[1]?.value) || 200;
    const delayMs = Number.parseInt(inputs[2]?.value || "0", 10) || 0;
    const name = inputs[3]?.value.trim() || `${method} ${path}`;
    const endpoint: BridgeMockEndpoint = {
      id: mockUuid(),
      method,
      cls: mockMethodClass(method),
      path,
      status,
      statusText: mockStatusText(status),
      name,
      delayMs,
      enabled: true,
      response: "{\n  \n}"
    };
    originalCreateMockEndpoint();
    project.endpoints.push(endpoint);
    const index = project.endpoints.length - 1;
    evalGlobal(`activeMockEndpointIndex = ${index}`);
    w.renderMockEndpoints?.(index);
    w.updateMockProjectUI?.();
    void flushMockSave();
    toast(w.t("mock.addHint"), `${method} ${path}`);
  };

  // Keep CodeMirror colours in sync with the prototype theme switch.
  const originalApplyTheme = w.applyTheme;
  w.applyTheme = (theme: string) => {
    originalApplyTheme(theme);
    updateMockEditorHighlight();
  };
}

function startMockEventBridge(): void {
  if (mockBridgeReady) return;
  if (typeof (window as any).__TAURI_INTERNALS__?.transformCallback !== "function") {
    return;
  }
  mockBridgeReady = true;
  void listen<MockRequestLog>("mock-request", (event) => {
    mockRequestLogs = [event.payload, ...mockRequestLogs].slice(0, 200);
    if (mockAppIsMockView() && mockPage() === "detail") renderMockLogs();
  });
}

function patchJsonDocumentFlow(): void {
  const originalOpenJsonToolFile = w.openJsonToolFile;

  w.openJsonToolFile = async (id: string) => {
    const list = evalGlobal<any[]>("JSON_RECENTS");
    const item = list.find((entry) => entry.id === id);
    if (!item) return;
    if (!item.path || item.path === "Local file" || item.path === "Not saved yet") {
      originalOpenJsonToolFile(id);
      syncEditor(true);
      return;
    }
    try {
      const document = await invoke<JsonDocument>("open_json_document", {
        path: item.path
      });
      installDocument(document);
    } catch (error) {
      toast("Could not open document", String(error));
    }
  };

  w.newEditorDocument = async () => {
    try {
      const document = await invoke<JsonDocument>("create_json_document", {
        name: null
      });
      installDocument(document);
      toast("New document created", document.name);
    } catch (error) {
      toast("Could not create document", String(error));
    }
  };

  w.openJsonFileDialog = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "JSON", extensions: ["json"] }]
      });
      if (typeof selected !== "string") return;
      const document = await invoke<JsonDocument>("open_json_document", {
        path: selected
      });
      installDocument(document);
      toast("Opened JSON file", document.name);
    } catch (error) {
      toast("Could not open document", String(error));
    }
  };

  w.saveCurrentDocument = async () => {
    const doc = currentDoc();
    if (!doc) return;
    if (!doc.path) {
      toast("Could not save document", "Open or create a file first.");
      return;
    }
    try {
      const saved = await invoke<JsonDocument>("save_json_document", {
        path: doc.path,
        text: doc.text ?? ""
      });
      Object.assign(doc, asBridgeDoc(saved));
      try {
        w.updateDocumentChrome(doc);
        w.renderFileMenuJsonRecents?.();
        w.renderToolFileMenu?.();
      } catch {
        // Ignore transient UI updates while a page closes.
      }
      toast("Document saved", saved.name);
    } catch (error) {
      toast("Could not save document", String(error));
    }
  };

  w.deleteJsonRecent = async (id: string) => {
    const list = evalGlobal<any[]>("JSON_RECENTS");
    const index = list.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const [removed] = list.splice(index, 1);
    try {
      if (removed.path && removed.path !== "Local file") {
        const remaining = await invoke<RecentDocument[]>(
          "remove_recent_json_document",
          { path: removed.path }
        );
        list.length = 0;
        for (const entry of remaining) list.push(recentDocumentEntry(entry));
      }
      w.renderJsonRecents();
      w.renderFileMenuJsonRecents?.();
      w.renderToolFileMenu?.();
      renderCompareMenus();
      toast("Removed from recent files", removed.name);
    } catch (error) {
      toast("Could not remove recent file", String(error));
      w.renderJsonRecents();
    }
  };
}

async function bootstrap(): Promise<void> {
  if (!hasTauri) {
    console.warn("JSON Buddy bridge requires the Tauri runtime");
    return;
  }
  try {
    const data = await invoke<BootstrapData>("bootstrap");
    patchDocumentFunctions();
    patchSettingsPersistence();
    patchJsonDocumentFlow();
    patchCompareFlow();
    patchStreamFlow();
    startStreamEventBridge();
    patchMockFlow();
    startMockEventBridge();
    applyBackendSettings(data.settings);
    seedRecents(data.recents);
    seedStreamRecents(data.streams ?? []);
    const [projects, serverStatus, requestLogs] = await Promise.all([
      invoke<MockProject[]>("list_mock_projects"),
      invoke<MockServerStatus>("mock_server_status"),
      invoke<MockRequestLog[]>("mock_request_logs")
    ]);
    seedMockProjects(projects, serverStatus, requestLogs);
    w.renderFileMenuStreamRecents?.();
    w.openJsonToolRecents();
    syncEditor(true);
  } catch (error) {
    console.error("JSON Buddy bootstrap failed", error);
    toast("Could not load local data", String(error));
  }
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  void bootstrap();
} else {
  window.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
}
