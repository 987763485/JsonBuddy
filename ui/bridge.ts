import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AppSettings,
  BootstrapData,
  JsonDocument,
  RecentDocument
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
    syncEditor(true);
  } catch (error) {
    console.error("could not install document", error);
  }
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
    applyBackendSettings(data.settings);
    seedRecents(data.recents);
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
