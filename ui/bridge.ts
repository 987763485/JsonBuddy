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
  AuditConfig,
  AuditEntry,
  BootstrapData,
  Conversation,
  ConversationMessage,
  ConversationToolCall,
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
  // The prototype shrinks itself with CSS zoom to fit a browser stage.
  // In the desktop window it must render at 1:1 and fill the webview.
  const appRoot = document.getElementById("app");
  const originalFitStage = w.fitStage;
  if (typeof originalFitStage === "function") {
    window.removeEventListener("resize", originalFitStage);
  }
  if (appRoot) appRoot.style.zoom = "";
  w.fitStage = () => {
    if (appRoot) appRoot.style.zoom = "";
  };

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
      zoom: 1 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
    }
    /* WebKit sizes a single auto grid row to its content and pins it to
       the top; center that row inside the fixed-height chrome bars. */
    .titlebar, .toolbar { align-content: center !important; }
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

/* ------------------------------------------------------------
   Custom select controls
   Native <select> popups cannot follow the prototype styling, so
   every select is mirrored by a styled trigger and popover while
   the hidden select keeps prototype value/onchange semantics.
   ------------------------------------------------------------ */

interface CustomSelectBinding {
  trigger: HTMLButtonElement;
  label: HTMLSpanElement;
  observer: MutationObserver;
}

interface OpenSelectState {
  select: HTMLSelectElement;
  trigger: HTMLButtonElement;
  menu: HTMLDivElement;
  active: number;
  cleanup: () => void;
}

const customSelectBindings = new WeakMap<HTMLSelectElement, CustomSelectBinding>();
let openSelectState: OpenSelectState | null = null;
let selectValuePatched = false;

const customSelectStyle = document.createElement("style");
customSelectStyle.textContent = `
  select.buddy-native-select { display: none !important; }
  .buddy-select-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    text-align: left;
    cursor: pointer;
    user-select: none;
  }
  .buddy-select-trigger > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .buddy-select-trigger > .i {
    flex: 0 0 auto;
    color: var(--ink-3);
  }
  .buddy-select-menu {
    position: fixed;
    z-index: 10000;
    max-height: 264px;
    overflow: auto;
    padding: 5px;
    background: var(--card);
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    box-shadow: var(--shadow-pop);
  }
  .buddy-select-menu::-webkit-scrollbar { width: 8px; }
  .buddy-select-menu::-webkit-scrollbar-thumb {
    background: var(--line-strong);
    border-radius: 8px;
    border: 2px solid var(--card);
  }
  .buddy-select-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 28px;
    padding: 0 8px;
    border-radius: 5px;
    text-align: left;
    font-size: 10.5px;
    color: var(--ink-2);
    white-space: nowrap;
  }
  .buddy-select-option:hover,
  .buddy-select-option.active { background: var(--hover); color: var(--ink); }
  .buddy-select-option.on {
    background: var(--accent-soft);
    color: var(--accent-2);
    font-weight: 600;
  }
  [data-theme="dark"] .buddy-select-option.on { color: var(--accent); }
  .buddy-select-option:disabled { opacity: .45; cursor: default; }
  .buddy-select-check {
    margin-left: auto;
    color: var(--accent);
    visibility: hidden;
  }
  .buddy-select-option.on .buddy-select-check { visibility: visible; }
  .buddy-select-empty {
    padding: 7px 8px;
    font-size: 10px;
    color: var(--ink-3);
  }
`;
document.head.appendChild(customSelectStyle);

function customSelectLabel(select: HTMLSelectElement): string {
  const option = select.selectedOptions?.[0];
  return (option?.label || option?.textContent || "").trim();
}

function syncCustomSelect(select: HTMLSelectElement): void {
  const binding = customSelectBindings.get(select);
  if (!binding) return;
  const label = customSelectLabel(select);
  binding.label.textContent = label || "—";
  binding.trigger.title = label;
}

function closeCustomSelectMenu(restoreFocus = false): void {
  if (!openSelectState) return;
  const state = openSelectState;
  openSelectState = null;
  state.cleanup();
  state.menu.remove();
  state.trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) state.trigger.focus();
}

function renderCustomSelectMenu(state: OpenSelectState): void {
  const { select, menu, active } = state;
  menu.innerHTML = "";
  const options = [...select.options];
  if (!options.length) {
    const empty = document.createElement("div");
    empty.className = "buddy-select-empty";
    empty.textContent = "No options";
    menu.appendChild(empty);
    return;
  }
  options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "buddy-select-option";
    button.setAttribute("role", "option");
    button.disabled = option.disabled;
    if (option.selected) button.classList.add("on");
    if (index === active) button.classList.add("active");
    button.setAttribute("aria-selected", String(option.selected));
    const text = document.createElement("span");
    text.textContent = option.label || option.textContent || "";
    button.appendChild(text);
    const check = document.createElement("span");
    check.className = "buddy-select-check";
    check.textContent = "✓";
    button.appendChild(check);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (option.disabled) return;
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      syncCustomSelect(select);
      closeCustomSelectMenu(true);
    });
    menu.appendChild(button);
  });
  const activeOption = menu.querySelectorAll<HTMLButtonElement>(
    ".buddy-select-option"
  )[active];
  activeOption?.scrollIntoView({ block: "nearest" });
}

function openCustomSelectMenu(
  select: HTMLSelectElement,
  trigger: HTMLButtonElement
): void {
  if (openSelectState?.select === select) {
    closeCustomSelectMenu();
    return;
  }
  closeCustomSelectMenu();
  const options = [...select.options];
  const initial = Math.max(0, select.selectedIndex);
  const menu = document.createElement("div");
  menu.className = "buddy-select-menu";
  menu.setAttribute("role", "listbox");
  document.body.appendChild(menu);
  const state: OpenSelectState = {
    select,
    trigger,
    menu,
    active: initial,
    cleanup: () => undefined
  };
  renderCustomSelectMenu(state);
  const rect = trigger.getBoundingClientRect();
  menu.style.minWidth = `${rect.width}px`;
  const menuWidth = menu.offsetWidth;
  menu.style.left = `${Math.max(
    8,
    Math.min(rect.left, window.innerWidth - menuWidth - 8)
  )}px`;
  const menuHeight = menu.offsetHeight;
  const below = rect.bottom + 4;
  menu.style.top =
    below + menuHeight > window.innerHeight - 8 && rect.top - menuHeight - 4 > 8
      ? `${rect.top - menuHeight - 4}px`
      : `${below}px`;
  trigger.setAttribute("aria-expanded", "true");
  openSelectState = state;

  const outside = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!menu.contains(target) && !trigger.contains(target)) closeCustomSelectMenu();
  };
  const reposition = () => closeCustomSelectMenu();
  const keydown = (event: KeyboardEvent) => {
    if (openSelectState !== state) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeCustomSelectMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeCustomSelectMenu();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      let next = state.active;
      for (let step = 0; step < options.length; step += 1) {
        next = (next + direction + options.length) % options.length;
        if (!options[next]?.disabled) break;
      }
      state.active = next;
      renderCustomSelectMenu(state);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[state.active];
      if (option && !option.disabled) {
        select.value = option.value;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncCustomSelect(select);
      }
      closeCustomSelectMenu(true);
    }
  };
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  select.addEventListener("keydown", keydown);
  trigger.addEventListener("keydown", keydown);
  state.cleanup = () => {
    document.removeEventListener("mousedown", outside, true);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
    select.removeEventListener("keydown", keydown);
    trigger.removeEventListener("keydown", keydown);
  };
}

function installCustomSelect(select: HTMLSelectElement): void {
  if (customSelectBindings.has(select)) return;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = `${select.className} buddy-select-trigger`.trim();
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  trigger.appendChild(label);
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("class", "i xs");
  chevron.setAttribute("viewBox", "0 0 24 24");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-chev-down");
  chevron.appendChild(use);
  trigger.appendChild(chevron);
  select.classList.add("buddy-native-select");
  select.insertAdjacentElement("afterend", trigger);

  const observer = new MutationObserver(() => syncCustomSelect(select));
  observer.observe(select, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true
  });
  customSelectBindings.set(select, { trigger, label, observer });
  syncCustomSelect(select);

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    openCustomSelectMenu(select, trigger);
  });
  trigger.addEventListener("keydown", (event) => {
    if (openSelectState?.select === select) return;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCustomSelectMenu(select, trigger);
    }
    if (event.key === "Escape") closeCustomSelectMenu();
  });
}

function patchSelectValue(): void {
  if (selectValuePatched) return;
  selectValuePatched = true;
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value"
  );
  if (!descriptor?.get || !descriptor.set) return;
  Object.defineProperty(HTMLSelectElement.prototype, "value", {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      return descriptor.get?.call(this);
    },
    set(value: string) {
      descriptor.set?.call(this, value);
      syncCustomSelect(this as HTMLSelectElement);
    }
  });
}

function installCustomSelects(): void {
  patchSelectValue();
  document
    .querySelectorAll<HTMLSelectElement>("select")
    .forEach((select) => installCustomSelect(select));
}

installCustomSelects();

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
let buddyConversation: Conversation | null = null;
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

function chatTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

function chatDateLabel(value?: string | null): string {
  if (!value) return "Conversation";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Conversation";
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  });
  if (sameDay) return `Today · ${time}`;
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
  return `${day} · ${time}`;
}

function chatDuration(start?: string | null, end?: string | null): string {
  if (!start) return "—";
  const from = new Date(start).getTime();
  const to = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return "—";
  const seconds = (to - from) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function chatMarkdown(text: string): string {
  const chunks = String(text ?? "").split("```");
  return chunks
    .map((chunk, index) => {
      if (index % 2 === 1) {
        const body = chunk.replace(/^[^\n]*\n/, "").replace(/\n$/, "");
        return `<div class="codeblock"><pre>${w.escHtml(body)}</pre></div>`;
      }
      const escaped = w.escHtml(chunk)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
      return escaped
        .split(/\n{2,}/)
        .map((part: string) => `<p>${part.replace(/\n/g, "<br>")}</p>`)
        .join("");
    })
    .join("");
}

function chatToolSummary(call: ConversationToolCall): string {
  try {
    const parsed = JSON.parse(call.arguments) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of [
        "path",
        "file",
        "filename",
        "command",
        "cmd",
        "query",
        "url",
        "pattern",
        "target",
        "name"
      ]) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim()) return value.slice(0, 90);
      }
    }
  } catch {
    // Arguments may be a plain string.
  }
  const flat = String(call.arguments ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 87)}…` : flat;
}

function chatToolLabel(call: ConversationToolCall): string {
  if (call.status === "error") return "error";
  if (call.status === "pending") return "running";
  return call.durationMs != null ? `${call.durationMs}ms · OK` : "OK";
}

function chatToolCard(call: ConversationToolCall): string {
  const failed = call.status === "error";
  const output = String(call.output ?? "").trim();
  const preview =
    output.length > 1600 ? `${output.slice(0, 1600)}\n…` : output;
  return `<div class="tool-card${failed ? " err" : ""}">
    <div class="tool-head">
      <svg class="i xs" viewBox="0 0 24 24"><use href="#i-wrench"/></svg>
      <span class="tool-name">${w.escHtml(call.name)}</span>
      <span class="tool-arg">${w.escHtml(chatToolSummary(call))}</span>
      <span class="tool-status">${w.escHtml(chatToolLabel(call))}</span>
      <svg class="i xs" viewBox="0 0 24 24" style="color:var(--ink-4)"><use href="#i-chev-right"/></svg>
    </div>
    ${preview ? `<div class="tool-body">${w.escHtml(preview).replace(/\n/g, "<br>")}</div>` : ""}
  </div>`;
}

function chatAvatar(model?: string | null): string {
  if (model && /r1/i.test(model)) {
    return '<div class="avatar assistant r1">R1</div>';
  }
  return '<div class="avatar assistant"><svg class="i" viewBox="0 0 24 24"><use href="#i-sparkle"/></svg></div>';
}

function chatModelSwitch(
  from: string,
  to: string,
  timestamp?: string | null
): string {
  return `<div class="model-switch">
    <span class="line"></span>
    <span class="pill">
      <svg class="i xs" viewBox="0 0 24 24"><use href="#i-swap"/></svg>
      <span>Model switched</span>
      <span class="from">${w.escHtml(from)}</span>
      <svg class="i xs" viewBox="0 0 24 24"><use href="#i-arrow-right"/></svg>
      <span class="to">${w.escHtml(to)}</span>
      <span class="time">${w.escHtml(chatTime(timestamp))}</span>
    </span>
    <span class="line"></span>
  </div>`;
}

function renderConversationMessage(
  message: ConversationMessage,
  calls: Map<string, ConversationToolCall>
): string {
  const time = chatTime(message.timestamp);
  if (message.role === "user") {
    return `<div class="msg user">
      <div class="avatar user">Y</div>
      <div class="msg-body">
        <div class="msg-meta"><b>You</b><span>${w.escHtml(time)}</span></div>
        <div class="bubble user">${chatMarkdown(message.text)}</div>
      </div>
    </div>`;
  }
  const model = message.model || "Assistant";
  const tools = message.toolCalls
    .map((id) => calls.get(id))
    .filter((call): call is ConversationToolCall => !!call)
    .map(chatToolCard)
    .join("");
  return `<div class="msg assistant">
    ${chatAvatar(message.model)}
    <div class="msg-body">
      <div class="msg-meta"><b>${w.escHtml(model)}</b><span>${w.escHtml(time)}</span>${
        message.streaming ? '<span class="live-only">· streaming</span>' : ""
      }</div>
      <div class="parts">
        ${
          message.reasoning
            ? `<button class="reasoning"><svg class="i" viewBox="0 0 24 24"><use href="#i-chev-right"/></svg>Thought</button>`
            : ""
        }
        ${message.text ? `<div class="bubble">${chatMarkdown(message.text)}</div>` : ""}
        ${tools}
        <div class="msg-foot"><span>#L${message.line}</span>${
          message.toolCalls.length
            ? `<span>·</span><span>${message.toolCalls.length} tool${
                message.toolCalls.length === 1 ? "" : "s"
              }</span>`
            : ""
        }</div>
      </div>
    </div>
  </div>`;
}

function renderConversation(live: boolean): void {
  const scroller = document.getElementById("chatScroll");
  const inner = scroller?.querySelector(".chat-inner");
  if (!scroller || !inner) return;
  const conversation = buddyConversation;
  const head = document.querySelector(".chat-head");
  const modelChip = head?.querySelector<HTMLElement>(".model-chip");
  const state = document.getElementById("chatStatePill");
  if (state) state.textContent = live ? "Following" : "Paused";
  document.getElementById("chatLiveDot")?.classList.toggle("pulse", live);
  if (modelChip) {
    const models = conversation?.models ?? [];
    modelChip.textContent = models.length
      ? `${models.length} model${models.length === 1 ? "" : "s"}`
      : "1 model";
  }
  w.setText("chatCount", `${conversation?.messages.length ?? 0} messages`);
  const composer = document.getElementById("chatComposerText");
  if (composer) {
    composer.textContent = `Read-only monitor · viewing ${
      buddyStreamSnapshot?.name ?? "session"
    }`;
  }
  if (!conversation || conversation.messages.length === 0) {
    inner.innerHTML =
      '<div class="chat-date">No conversation events</div>' +
      '<div class="bubble" style="color:var(--ink-3)">This stream has no user or assistant messages to display. Open the source view to inspect the raw lines.</div>';
    renderConversationSession(live);
    return;
  }
  const calls = new Map(
    conversation.toolCalls.map((call) => [call.id, call])
  );
  const switches = [...conversation.switches];
  let html = `<div class="chat-date">${w.escHtml(
    chatDateLabel(conversation.messages[0]?.timestamp)
  )}</div>`;
  if (conversation.systemPrompt) {
    const tokens = Math.max(
      1,
      Math.round(conversation.systemPrompt.length / 4)
    );
    html += `<button class="context-card">
      <svg class="i xs" viewBox="0 0 24 24"><use href="#i-chev-right"/></svg>
      <span>System prompt</span>
      <span class="ctx-meta">${tokens.toLocaleString("en-US")} tokens</span>
    </button>`;
  }
  for (const message of conversation.messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.model) {
      while (
        switches.length &&
        switches[0].to === message.model &&
        switches[0].from !== switches[0].to
      ) {
        const next = switches.shift();
        if (next) html += chatModelSwitch(next.from, next.to, next.timestamp);
      }
    }
    html += renderConversationMessage(message, calls);
  }
  for (const next of switches) {
    html += chatModelSwitch(next.from, next.to, next.timestamp);
  }
  const nearBottom =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  inner.innerHTML = html;
  renderConversationSession(live);
  try {
    w.applyMonitorFilter();
  } catch {
    // Filters are owned by the prototype page.
  }
  const chatScroller = scroller;
  if (live && nearBottom) {
    requestAnimationFrame(() => {
      chatScroller.scrollTop = chatScroller.scrollHeight;
    });
  }
}

function renderConversationSession(live: boolean): void {
  const pane = document.querySelector('.side-pane[data-side-pane="session"]');
  if (!pane) return;
  const conversation = buddyConversation;
  if (!conversation) {
    pane.innerHTML =
      '<div class="side-section"><div class="side-title">Session</div><div class="turn-sub">No session data.</div></div>';
    return;
  }
  const models = conversation.models.length
    ? conversation.models
    : ["Assistant"];
  const current = models[models.length - 1];
  const started = chatTime(conversation.startedAt);
  const ended = conversation.endedAt;
  const token = (value: number) => value.toLocaleString("en-US");
  const modelRow = (model: string, index: number) => {
    const isCurrent = index === models.length - 1;
    const avatar = /r1/i.test(model)
      ? '<span class="model-avatar r1">R1</span>'
      : '<span class="model-avatar"><svg class="i" viewBox="0 0 24 24"><use href="#i-sparkle"/></svg></span>';
    return `<div class="${isCurrent ? "model-current" : "model-prev"}">
      ${avatar}
      <div class="model-main">
        <div class="model-name">${w.escHtml(model)}</div>
        <div class="model-sub">${
          isCurrent ? `current${live ? " · live" : ""}` : "previous"
        }</div>
      </div>
      ${
        isCurrent
          ? '<span class="model-badge">CURRENT</span>'
          : `<span class="model-usage">${w.escHtml(
              chatTime(conversation.endedAt)
            )}</span>`
      }
    </div>`;
  };
  const turns = conversation.turns
    .slice(-8)
    .map(
      (turn) => `<div class="turn-item" ${turn !== conversation.turns[conversation.turns.length - 1] ? 'style="margin-top:4px"' : ""}>
        <span class="dot${turn.streaming ? " pulse" : ""}"></span>
        <div class="turn-main">
          <div class="turn-title">Turn ${turn.index}${turn.model ? ` · ${w.escHtml(turn.model)}` : ""}${turn.streaming ? " · streaming" : ""}</div>
          <div class="turn-sub">${w.escHtml(chatTime(turn.startedAt))} → ${w.escHtml(
            turn.endedAt ? chatTime(turn.endedAt) : "live"
          )} · ${turn.messages} messages</div>
        </div>
      </div>`
    )
    .join("");
  const tools = conversation.toolCalls
    .slice(-12)
    .map(
      (call) => `<div class="side-tool${call.status === "error" ? " err" : ""}">
        <svg class="i xs" viewBox="0 0 24 24"><use href="#i-wrench"/></svg>
        <span>${w.escHtml(call.name)}</span>
        <span class="st">${w.escHtml(chatToolLabel(call))}</span>
      </div>`
    )
    .join("");
  pane.innerHTML = `<div class="session-card">
    <div class="session-id-row">
      <span class="session-id-label">SESSION</span>
      <span class="session-id">${w.escHtml(conversation.sessionId ?? "unknown")}</span>
      ${live ? '<span class="live-dot pulse"></span>' : ""}
    </div>
    <div class="models-head"><span>Models</span><span class="model-count">${models.length}</span></div>
    ${models.map(modelRow).join("")}
    <div class="side-stats">
      <div><div class="side-label">Started</div><div class="side-value">${w.escHtml(started || "—")}</div></div>
      <div><div class="side-label">Duration</div><div class="side-value">${w.escHtml(
        chatDuration(conversation.startedAt, ended)
      )}</div></div>
      <div><div class="side-label">Turns</div><div class="side-value">${conversation.stats.turns}</div></div>
      <div><div class="side-label">Messages</div><div class="side-value">${conversation.stats.messages}</div></div>
      <div><div class="side-label">Prompt</div><div class="side-value">${token(
        conversation.stats.promptTokens
      )} tok</div></div>
      <div><div class="side-label">Completion</div><div class="side-value">${token(
        conversation.stats.completionTokens
      )} tok</div></div>
    </div>
  </div>
  ${
    turns
      ? `<div class="side-section"><div class="side-title">Turns</div>${turns}</div>`
      : ""
  }
  ${
    tools
      ? `<div class="side-section"><div class="side-title">Tool calls</div>${tools}</div>`
      : ""
  }`;
  w.setText("chatCount", `${conversation.messages.length} messages`);
  if (current) {
    const chip = document.querySelector<HTMLElement>(".chat-head .model-chip");
    if (chip) chip.title = `Models used in this session: ${models.join(", ")}`;
  }
}

let buddyAuditEntries: AuditEntry[] = [];
let buddyAuditConfig: AuditConfig | null = null;
let buddyAuditAck = new Set<string>();
let buddyAuditActive = false;
let buddyAuditSeverity = "all";
let auditRenderTimer: number | null = null;

function auditTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const base = date.toLocaleTimeString("en-GB", { hour12: false });
  return `${base}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function auditIcon(category: string): string {
  const icons: Record<string, string> = {
    traversal: "i-alert",
    read: "i-file",
    upload: "i-upload",
    delete: "i-trash",
    shell: "i-terminal",
    network: "i-globe"
  };
  return icons[category] ?? "i-shield";
}

function auditItemHtml(entry: AuditEntry, selected: boolean): string {
  const acknowledged = buddyAuditAck.has(entry.id);
  const blocked = entry.blocked;
  const classes = [
    "audit-item",
    `sev-${entry.severity}`,
    selected ? "sel" : "",
    acknowledged ? "acked" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="${classes}" data-type="${w.escHtml(entry.category)}"
      data-severity="${w.escHtml(entry.severity)}"
      data-blocked="${blocked ? "1" : "0"}"
      data-audit-id="${w.escHtml(entry.id)}"
      data-label="${w.escHtml(entry.label.toLowerCase())}"
      onclick="selectAudit(this)">
    <div class="ai-top">
      <span class="ai-type"><svg class="i" viewBox="0 0 24 24"><use href="#${auditIcon(
        entry.category
      )}"/></svg><span>${w.escHtml(entry.label)}</span></span>
      <span class="ai-decision ${blocked ? "blocked" : "allowed"}">${
        blocked ? "Blocked" : "Allowed"
      }</span>
    </div>
    <div class="ai-target">${w.escHtml(entry.target || "—")}</div>
    <div class="ai-meta">
      <span>${w.escHtml(entry.tool)}</span>
      <span>${w.escHtml(auditTime(entry.timestamp))}</span>
      <span>${w.escHtml(entry.sessionId ?? "session")}</span>
    </div>
    <div class="ai-detail">
      <div class="ai-rule">${w.escHtml(entry.rule)}</div>
      <div class="ai-actions">
        <button class="ai-action" onclick="event.stopPropagation(); openAuditSource()">View raw event</button>
        ${
          acknowledged
            ? '<button class="ai-action ack acked" disabled>Acknowledged</button>'
            : `<button class="ai-action ack" data-ack-id="${w.escHtml(
                entry.id
              )}">Acknowledge</button>`
        }
        <button class="ai-action" onclick="event.stopPropagation(); copyAuditTarget(this)">Copy target</button>
      </div>
    </div>
  </div>`;
}

function applyAuditSeverity(): void {
  const query = (
    document.getElementById("monitorFilter") as HTMLInputElement | null
  )?.value.trim().toLowerCase();
  document
    .querySelectorAll<HTMLElement>("#auditList .audit-item")
    .forEach((item) => {
      const severity = item.dataset.severity ?? "";
      const matchesSeverity =
        buddyAuditSeverity === "all" || severity === buddyAuditSeverity;
      const matchesQuery =
        !query || item.textContent.toLowerCase().includes(query);
      item.hidden =
        item.classList.contains("audit-off") ||
        !matchesSeverity ||
        !matchesQuery;
    });
  document
    .querySelectorAll<HTMLElement>(".audit-filters .chip")
    .forEach((chip, index) => {
      const value = ["all", "critical", "warning", "info"][index];
      chip.classList.toggle("on", value === buddyAuditSeverity);
    });
}

function renderAudit(): void {
  if (!buddyAuditActive) return;
  const host = document.getElementById("auditList");
  if (!host) return;
  host.innerHTML = buddyAuditEntries
    .map((entry, index) => auditItemHtml(entry, index === 0))
    .join("");
  host.querySelectorAll<HTMLElement>("[data-ack-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = button.dataset.ackId;
      if (id) void w.buddyAcknowledgeAudit(id, button);
    });
  });
  const categories = buddyAuditConfig?.categories ?? {};
  const enabled = Object.entries(categories)
    .filter(([, value]) => value)
    .map(([key]) => key);
  try {
    evalGlobal(`auditEnabled = new Set(${JSON.stringify(enabled)})`);
    w.updateAuditUI?.();
  } catch {
    // The audit pane may not be mounted outside the monitor view.
  }
  applyAuditSeverity();
  try {
    w.applyMonitorFilter?.();
  } catch {
    // Filtering is optional.
  }
}

function scheduleAuditRender(): void {
  if (auditRenderTimer !== null) window.clearTimeout(auditRenderTimer);
  auditRenderTimer = window.setTimeout(() => {
    auditRenderTimer = null;
    renderAudit();
  }, 220);
}

function syncAuditSettingsChecks(): void {
  const categories = buddyAuditConfig?.categories ?? {};
  document.querySelectorAll<HTMLElement>(".as-option").forEach((option) => {
    const key = option.dataset.auditOption ?? "";
    const check = option.querySelector<HTMLElement>(".check");
    check?.classList.toggle("on", categories[key] === true);
  });
}

async function loadAuditConfig(): Promise<AuditConfig> {
  const config = await invoke<AuditConfig>("audit_config");
  buddyAuditConfig = config;
  buddyAuditAck = new Set(config.acknowledged);
  syncAuditSettingsChecks();
  return config;
}

function patchAuditFlow(): void {
  const originalApplyMonitorFilter = w.applyMonitorFilter;
  w.applyMonitorFilter = () => {
    originalApplyMonitorFilter();
    applyAuditSeverity();
  };
  const originalOpenAuditSettings = w.openAuditSettings;
  w.openAuditSettings = () => {
    originalOpenAuditSettings();
    syncAuditSettingsChecks();
  };

  w.saveAuditSettings = async () => {
    const categories: Record<string, boolean> = {};
    document.querySelectorAll<HTMLElement>(".as-option").forEach((option) => {
      const key = option.dataset.auditOption;
      if (!key) return;
      categories[key] =
        option.querySelector(".check")?.classList.contains("on") === true;
    });
    try {
      const config = await invoke<AuditConfig>("update_audit_categories", {
        categories
      });
      buddyAuditConfig = config;
      buddyAuditAck = new Set(config.acknowledged);
      w.closeAuditSettings?.();
      renderAudit();
    } catch (error) {
      toast("Could not save audit settings", String(error));
    }
  };

  w.buddyAcknowledgeAudit = async (id: string, button: HTMLElement) => {
    try {
      const config = await invoke<AuditConfig>("acknowledge_audit", { id });
      buddyAuditConfig = config;
      buddyAuditAck = new Set(config.acknowledged);
      button.closest(".audit-item")?.classList.add("acked");
      button.textContent = "Acknowledged";
      (button as HTMLButtonElement).disabled = true;
    } catch (error) {
      toast("Could not acknowledge audit event", String(error));
    }
  };

  document
    .querySelectorAll<HTMLElement>(".audit-filters .chip")
    .forEach((chip, index) => {
      chip.addEventListener("click", () => {
        buddyAuditSeverity = ["all", "critical", "warning", "info"][index] ?? "all";
        applyAuditSeverity();
      });
    });
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
    buddyConversation = snapshot.conversation;
    buddyAuditEntries = snapshot.audit ?? [];
    buddyAuditActive = true;
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
    renderConversation(false);
    renderAudit();
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
    renderConversation(live);
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
        buddyConversation = null;
        buddyAuditEntries = [];
        buddyAuditActive = false;
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
    buddyConversation = payload.conversation ?? buddyConversation;
    if (payload.audit) {
      buddyAuditEntries = payload.audit;
      buddyAuditActive = true;
      scheduleAuditRender();
    }
    const code = document.getElementById("streamCode");
    const nearBottom = code
      ? code.scrollHeight - code.scrollTop - code.clientHeight < 50
      : true;
    renderRealStreamSource(!file.paused);
    renderRealStreamEvents(!file.paused);
    updateRealStreamChrome(file, !file.paused);
    renderConversation(!file.paused);
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
    patchAuditFlow();
    applyBackendSettings(data.settings);
    seedRecents(data.recents);
    seedStreamRecents(data.streams ?? []);
    const [projects, serverStatus, requestLogs, auditConfig] = await Promise.all([
      invoke<MockProject[]>("list_mock_projects"),
      invoke<MockServerStatus>("mock_server_status"),
      invoke<MockRequestLog[]>("mock_request_logs"),
      invoke<AuditConfig>("audit_config")
    ]);
    seedMockProjects(projects, serverStatus, requestLogs);
    buddyAuditConfig = auditConfig;
    buddyAuditAck = new Set(auditConfig.acknowledged);
    syncAuditSettingsChecks();
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
