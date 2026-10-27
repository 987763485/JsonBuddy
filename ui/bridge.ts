import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxTree, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
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

const streamFocusStyle = document.createElement("style");
streamFocusStyle.textContent = `
  .stream-code .sl.focus {
    background: var(--accent-soft) !important;
    box-shadow: inset 2px 0 0 var(--accent);
  }
`;
document.head.appendChild(streamFocusStyle);

const chatStyle = document.createElement("style");
chatStyle.textContent = `
  .chat .reasoning.on .i { transform: rotate(90deg); }
  .chat .reasoning .i { transition: transform 120ms ease; }
  .chat .reasoning-body {
    margin-left: 0;
    color: var(--ink-2);
    border-left: 2px solid var(--line-strong);
    border-radius: 0 6px 6px 0;
    font-size: 10px;
  }
  .chat .reasoning-body[hidden] { display: none !important; }
`;
document.head.appendChild(chatStyle);

let editor: EditorView | null = null;
let editorHost: HTMLDivElement | null = null;
let editorDocumentText = "";
let syncing = false;
let chromeTimer: number | null = null;
let buddyTrackedDoc: BridgeDoc | null = null;
let buddyDocumentVersion = 0;
let buddySavedVersion = 0;
let buddyAutosaveTimer: number | null = null;
let buddyAutosaveFailedPath = "";
let buddyDocumentSaveChain: Promise<unknown> = Promise.resolve();
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

function documentHasSavePath(doc: BridgeDoc | null | undefined): boolean {
  const path = doc?.path ?? "";
  return !!path && path !== "Local file" && path !== "Not saved yet";
}

function documentIsDirty(): boolean {
  return buddyDocumentVersion !== buddySavedVersion;
}

function updateDocumentDirtyIndicator(doc = currentDoc()): void {
  const dot = document.querySelector<HTMLElement>(".tb-file .dirty");
  if (!dot) return;
  const unsaved = !documentHasSavePath(doc);
  dot.hidden = false;
  dot.style.visibility = unsaved || documentIsDirty() ? "" : "hidden";
}

function clearDocumentAutosaveTimer(): void {
  if (buddyAutosaveTimer !== null) {
    window.clearTimeout(buddyAutosaveTimer);
    buddyAutosaveTimer = null;
  }
}

function queueDocumentSave(path: string, text: string): Promise<JsonDocument> {
  const run = buddyDocumentSaveChain.then(() =>
    invoke<JsonDocument>("save_json_document", { path, text })
  );
  buddyDocumentSaveChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function scheduleDocumentAutosave(doc: BridgeDoc | null, delay = 900): void {
  clearDocumentAutosaveTimer();
  if (!documentHasSavePath(doc) || !documentIsDirty()) return;
  buddyAutosaveTimer = window.setTimeout(() => {
    buddyAutosaveTimer = null;
    void autosaveDocument(doc);
  }, delay);
}

function applySavedDocument(
  doc: BridgeDoc,
  saved: JsonDocument,
  savedVersion: number
): void {
  if (savedVersion > buddySavedVersion) buddySavedVersion = savedVersion;
  if (buddyDocumentVersion === savedVersion) {
    Object.assign(doc, asBridgeDoc(saved));
  }
  updateDocumentDirtyIndicator(doc);
  try {
    w.updateDocumentChrome?.(doc);
    w.renderFileMenuJsonRecents?.();
    w.renderToolFileMenu?.();
    renderCompareMenus();
  } catch {
    // The prototype may be switching pages while a save completes.
  }
  if (buddyDocumentVersion !== savedVersion) {
    scheduleDocumentAutosave(doc);
  }
}

async function autosaveDocument(doc: BridgeDoc | null): Promise<void> {
  if (
    !doc ||
    currentDoc() !== doc ||
    !documentHasSavePath(doc) ||
    !documentIsDirty()
  ) {
    return;
  }
  const text = doc.text ?? "";
  const path = doc.path;
  const version = buddyDocumentVersion;
  try {
    const saved = await queueDocumentSave(path, text);
    buddyAutosaveFailedPath = "";
    if (currentDoc() !== doc) return;
    applySavedDocument(doc, saved, version);
  } catch (error) {
    if (buddyAutosaveFailedPath !== path) {
      buddyAutosaveFailedPath = path;
      toast("Could not autosave document", String(error));
    }
  }
}

function flushPreviousDocument(doc: BridgeDoc | null): void {
  const previous = buddyTrackedDoc;
  if (
    !previous ||
    previous === doc ||
    !documentHasSavePath(previous) ||
    buddyDocumentVersion === buddySavedVersion
  ) {
    return;
  }
  const text = previous.text ?? "";
  void queueDocumentSave(previous.path, text).catch((error) => {
    toast("Could not autosave document", String(error));
  });
}

function installDocumentAutosave(): void {
  const flush = () => {
    const doc = currentDoc();
    if (doc && documentHasSavePath(doc) && documentIsDirty()) {
      void autosaveDocument(doc);
    }
  };
  window.addEventListener("blur", flush, { passive: true });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") flush();
    },
    { passive: true }
  );
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

const BUDDY_TOAST_ZH: Record<string, string> = {
  "Could not restart mock server": "无法重启 Mock 服务",
  "Could not save settings": "无法保存设置",
  "Could not open compare file": "无法打开对比文件",
  "Could not save audit settings": "无法保存审计设置",
  "Could not acknowledge audit event": "无法确认审计事件",
  "Could not save generated code": "无法保存生成的代码",
  "Nothing to export": "没有可导出内容",
  "No tabular data found.": "未找到表格数据。",
  "Could not export CSV": "无法导出 CSV",
  "Could not export Excel": "无法导出 Excel",
  "Could not export mock API": "无法导出 Mock API",
  "File is too large": "文件过大",
  "Maximum import size is 50 MB.": "最大导入大小为 50 MB。",
  "Could not import file": "无法导入文件",
  "Could not generate data": "无法生成数据",
  "The response has no usable shape.": "响应中没有可用的结构。",
  "Mock data generated": "已生成 Mock 数据",
  "Could not open stream": "无法打开流",
  "Could not follow stream": "无法跟随流",
  "Could not remove stream": "无法移除流",
  "Stream watcher error": "流监听错误",
  "Could not update mock response": "无法更新 Mock 响应",
  "Could not start mock server": "无法启动 Mock 服务",
  "Could not stop mock server": "无法停止 Mock 服务",
  "Could not save mock project": "无法保存 Mock 项目",
  "Could not delete mock project": "无法删除 Mock 项目",
  "Could not save imported schema": "无法保存导入的 Schema",
  "Could not open document": "无法打开文档",
  "New document created": "已创建新文档",
  "Could not create document": "无法创建文档",
  "Opened JSON file": "已打开 JSON 文件",
  "Open or create a file first.": "请先打开或创建文件。",
  "Document saved": "文档已保存",
  "Could not save document": "无法保存文档",
  "Could not autosave document": "无法自动保存文档",
  "Removed from recent files": "已从最近文件移除",
  "Could not remove recent file": "无法移除最近文件",
  "Could not load local data": "无法加载本地数据",
  "Could not load stream history": "无法加载流历史",
  "Could not open file": "无法打开文件",
  "Could not import CSV": "无法导入 CSV",
  "Could not format JSON": "无法格式化 JSON",
  "Could not sort JSON": "无法排序 JSON",
  "Could not locate value in the active document": "未在当前文档中找到该值",
  "Export copied": "导出内容已复制",
  "Revealed in source": "已在源码中显示",
  "Copied": "已复制"
};

function buddyToastText(text: string): string {
  return viewLanguageIsZh() ? BUDDY_TOAST_ZH[text] ?? text : text;
}

function toast(message: string, detail?: string): void {
  try {
    w.showToast(
      buddyToastText(message),
      detail == null ? undefined : buddyToastText(detail)
    );
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
          editorTheme,
          highlightCompartment.of(
            syntaxHighlighting(
              document.documentElement.dataset.theme === "dark"
                ? darkHighlight
                : lightHighlight
            )
          ),
          EditorView.updateListener.of((update) => {
            if (syncing) return;
            if (update.selectionSet || update.docChanged) {
              updateJsonEditorStatus(update.state, update.docChanged);
            }
            if (!update.docChanged) return;
            editorDocumentText = update.state.doc.toString();
            const active = currentDoc();
            if (!active) return;
            active.text = editorDocumentText;
            active.data = undefined;
            active.lineCount = update.state.doc.lines;
            active.sizeLabel = formatBytes(new Blob([active.text]).size);
            buddyDocumentVersion += 1;
            updateDocumentDirtyIndicator(active);
            scheduleDocumentAutosave(active);
            if (chromeTimer) window.clearTimeout(chromeTimer);
            chromeTimer = window.setTimeout(() => {
              try {
                w.updateDocumentChrome(active);
                w.renderFileMenuJsonRecents?.();
              } catch {
                // The prototype may be switching pages while a keystroke lands.
              }
            }, 130);
            scheduleTreeRender();
            scheduleTableRender();
            scheduleGraphRender();
            scheduleCodegenRender();
          })
        ]
      })
    });
    editorDocumentText = doc?.text ?? "";
  }
  return editor;
}

function syncEditor(force = false): void {
  const view = ensureEditor();
  if (!view) return;
  const doc = currentDoc();
  const next = doc?.text ?? "";
  const current = editorDocumentText;
  const documentChanged = doc !== buddyTrackedDoc;
  if (documentChanged) {
    flushPreviousDocument(doc);
    clearDocumentAutosaveTimer();
    buddyTrackedDoc = doc;
    buddyAutosaveFailedPath = "";
    buddySavedVersion = buddyDocumentVersion;
    updateDocumentDirtyIndicator(doc);
  }
  if (current !== next) {
    syncing = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next }
    });
    syncing = false;
    editorDocumentText = next;
    if (!documentChanged) {
      buddyDocumentVersion += 1;
      updateDocumentDirtyIndicator(doc);
      scheduleDocumentAutosave(doc);
    }
    updateJsonEditorStatus(view.state, true);
  } else if (force) {
    updateJsonEditorStatus(view.state, true);
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

function focusEditorLine(line: number): void {
  const view = ensureEditor();
  if (!view || !Number.isFinite(line)) return;
  const bounded = Math.max(1, Math.min(view.state.doc.lines, Math.round(line)));
  const target = view.state.doc.line(bounded);
  view.dispatch({
    selection: { anchor: target.from, head: target.to },
    scrollIntoView: true
  });
  view.focus();
}

type JsonPathSegment = { kind: "key"; key: string } | { kind: "index"; index: number };

function jsonValueNode(name: string): boolean {
  return ["Object", "Array", "String", "Number", "True", "False", "Null"].includes(
    name
  );
}

function jsonPathAtCursor(state: EditorState): JsonPathSegment[] {
  const pos = state.selection.main.head;
  let node = syntaxTree(state).resolveInner(pos, -1);
  const segments: JsonPathSegment[] = [];
  let guard = 0;
  while (node && guard < 64) {
    guard += 1;
    const parent = node.parent;
    if (!parent) break;
    if (parent.name === "Property") {
      const nameNode = parent.getChild("PropertyName");
      if (nameNode) {
        const raw = state.sliceDoc(nameNode.from, nameNode.to);
        try {
          const key = JSON.parse(raw);
          if (typeof key === "string") segments.unshift({ kind: "key", key });
        } catch {
          segments.unshift({ kind: "key", key: raw.replace(/^"|"$/g, "") });
        }
      }
    } else if (parent.name === "Array") {
      let index = 0;
      let child = parent.firstChild;
      while (child && child.to <= node.from) {
        if (jsonValueNode(child.name)) index += 1;
        child = child.nextSibling;
      }
      segments.unshift({ kind: "index", index });
    }
    node = parent;
  }
  return segments;
}

function jsonPathText(segments: JsonPathSegment[]): string {
  return segments.reduce((text, segment) => {
    if (segment.kind === "index") return `${text}[${segment.index}]`;
    return /^[A-Za-z_$][\w$]*$/.test(segment.key)
      ? `${text}.${segment.key}`
      : `${text}[${JSON.stringify(segment.key)}]`;
  }, "$");
}

function renderJsonStatusPath(segments: JsonPathSegment[], path: string): void {
  const host = document.querySelector<HTMLElement>(
    ".status-normal .status-path"
  );
  if (!host) return;
  let html = '<span class="punct">$</span>';
  for (const segment of segments) {
    if (segment.kind === "index") {
      html += `<span class="punct">[${segment.index}]</span>`;
    } else if (/^[A-Za-z_$][\w$]*$/.test(segment.key)) {
      html += `<span class="punct">.</span>${w.escHtml(segment.key)}`;
    } else {
      html += `<span class="punct">[</span><span class="punct">${w.escHtml(
        JSON.stringify(segment.key)
      )}</span><span class="punct">]</span>`;
    }
  }
  html +=
    '<svg class="i xs" viewBox="0 0 24 24" style="color:var(--ink-4);margin-left:6px"><use href="#i-copy"/></svg>';
  host.innerHTML = html;
  host.dataset.path = path;
  host.title = "Copy path";
  if (!host.dataset.buddyCopyBound) {
    host.dataset.buddyCopyBound = "1";
    host.addEventListener("click", () => {
      const value = host.dataset.path || "$";
      void w.copyText(value, w.t("File path copied"), value);
    });
  }
}

function updateJsonStatusLanguage(): void {
  if (!editor) return;
  updateJsonEditorStatus(editor.state, true);
}

let jsonStatusValidateTimer: number | null = null;

function scheduleJsonStatusValidation(state: EditorState): void {
  if (jsonStatusValidateTimer !== null) {
    window.clearTimeout(jsonStatusValidateTimer);
  }
  jsonStatusValidateTimer = window.setTimeout(() => {
    jsonStatusValidateTimer = null;
    const pill = document.querySelector<HTMLElement>(
      ".status-normal .status-pill"
    );
    if (!pill) return;
    const snapshot = state.doc.toString();
    let valid = true;
    try {
      JSON.parse(snapshot);
    } catch {
      valid = false;
    }
    pill.className = valid ? "status-pill" : "status-pill warn";
    pill.innerHTML = `<i></i>${valid ? w.t("Valid JSON") : w.t("Invalid JSON")}`;
  }, 300);
}

function updateStatusIndentation(state: EditorState): void {
  const items = document.querySelectorAll<HTMLElement>(
    ".status-normal .status-right .status-item"
  );
  const item = items[4];
  if (!item) return;
  let indented: string | null = null;
  const limit = Math.min(state.doc.lines, 5000);
  for (let lineNumber = 1; lineNumber <= limit; lineNumber += 1) {
    const line = state.doc.line(lineNumber).text;
    if (/^[ \t]+\S/.test(line)) {
      indented = line;
      break;
    }
  }
  const zh = viewLanguageIsZh();
  if (indented?.startsWith("\t")) {
    item.textContent = zh ? "制表符" : "Tabs";
    return;
  }
  const width = indented ? (/^ +/.exec(indented)?.[0].length ?? 2) : 2;
  item.textContent = zh ? `空格: ${width}` : `Spaces: ${width}`;
}

function updateStatusZoom(): void {
  const items = document.querySelectorAll<HTMLElement>(
    ".status-normal .status-right .status-item"
  );
  const item = items[5];
  if (!item) return;
  const label =
    document.getElementById("graphZoomLabel")?.textContent?.trim() || "100%";
  const textNode = [...item.childNodes].find(
    (node) => node.nodeType === Node.TEXT_NODE
  );
  if (textNode) textNode.nodeValue = label;
  else item.append(document.createTextNode(label));
}

function updateJsonEditorStatus(state: EditorState, validate: boolean): void {
  const cursor = document.getElementById("statusCursor");
  if (!cursor) return;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const column = head - line.from + 1;
  const zh = viewLanguageIsZh();
  cursor.textContent =
    zh
      ? `第 ${line.number} 行，第 ${column} 列`
      : `Ln ${line.number}, Col ${column}`;
  const segments = jsonPathAtCursor(state);
  renderJsonStatusPath(segments, jsonPathText(segments));
  if (validate) {
    updateStatusIndentation(state);
    scheduleJsonStatusValidation(state);
  }
}

function findDocumentLineForEntry(entry: any): number {
  const doc = currentDoc();
  const lines = (doc?.text ?? "").split(/\r?\n/);
  if (!lines.length) return 0;
  const key = entry?.key || "";
  const keyToken = key ? `"${key}"` : "";
  let hint = entry?.kind === "value" ? entry.label : "";
  if (entry?.kind === "key" && entry.path) {
    let data: unknown;
    try {
      data = JSON.parse(doc?.text ?? "");
    } catch {
      data = undefined;
    }
    const value = w.jsonValueAtPath?.(data, entry.path);
    if (value !== undefined) hint = w.compareValueLabel?.(value) ?? hint;
  }
  const hintUsable = hint && hint.length <= 60;
  let firstKey = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (keyToken && !line.includes(keyToken)) continue;
    if (keyToken && !firstKey) firstKey = index + 1;
    if (hintUsable && !line.includes(hint)) continue;
    return index + 1;
  }
  if (firstKey) return firstKey;
  if (hintUsable) {
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].includes(hint)) return index + 1;
    }
  }
  return 0;
}

function patchSearchReveal(): void {
  const originalJump = w.jumpToJsonSearchResult;
  const originalReveal = w.revealInspectorInSource;
  w.findJsonSearchLine = (entry: any) => findDocumentLineForEntry(entry);
  w.jumpToJsonSearchResult = (index: number) => {
    originalJump(index);
    try {
      const line = evalGlobal<number | null>("editorFocusLine");
      if (typeof line === "number") focusEditorLine(line);
    } catch {
      // Search state is owned by the prototype.
    }
  };
  w.revealInspectorInSource = () => {
    originalReveal();
    try {
      const line = evalGlobal<number | null>("editorFocusLine");
      if (typeof line === "number") focusEditorLine(line);
    } catch {
      // The source view may be closing.
    }
  };
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
    // The prototype renders every source line into #code, which is hidden in
    // the desktop build and can block the UI for seconds on large documents.
    // CodeMirror is the visible editor, so only keep the hidden host empty and
    // sync its document instead.
    const code = document.getElementById("code");
    if (code) code.replaceChildren();
    syncEditor(false);
    try {
      const line = evalGlobal<number | null>("editorFocusLine");
      if (typeof line === "number") focusEditorLine(line);
    } catch {
      // The prototype clears the focus line when closing search.
    }
    scheduleTreeRender();
    scheduleTableRender();
    scheduleGraphRender();
    scheduleCodegenRender();
  };
  w.applyTheme = (theme: string) => {
    originalApplyTheme(theme);
    updateEditorHighlight();
  };
}

let buddySavedSettings: AppSettings | null = null;

function applyBackendSettings(settings: AppSettings): void {
  buddySavedSettings = { ...settings };
  evalGlobal(`appSettings = ${JSON.stringify(settings)}`);
  try {
    w.applyTheme(settings.theme);
    w.applyLanguage(settings.language);
  } catch (error) {
    console.warn("could not apply settings", error);
  }
}

function patchToastLocalization(): void {
  if (typeof w.showToast !== "function") return;
  const originalShowToast = w.showToast;
  w.showToast = (message: unknown, detail?: unknown) => {
    const label = buddyToastText(String(message ?? ""));
    const sub =
      detail == null ? undefined : buddyToastText(String(detail));
    originalShowToast(label, sub);
  };
}

function patchClipboard(): void {
  const originalCopyText = w.copyText;
  w.copyText = async (text: unknown, message?: string, detail?: string) => {
    const value = String(text ?? "");
    try {
      await writeClipboard(value);
      w.showToast?.(message || "Copied", detail == null ? value : detail);
    } catch {
      originalCopyText?.(text, message, detail);
    }
  };
  w.copyInspectorPath = () => {
    const path = document.getElementById("inspPath")?.textContent?.trim() ?? "";
    if (!path) return;
    void w.copyText(path, w.t("File path copied"), path);
  };
}

function patchSettingsPersistence(): void {
  w.persistAppSettings = () => {
    const settings = evalGlobal<AppSettings>("appSettings");
    const previous = buddySavedSettings;
    void invoke<AppSettings>("update_settings", { settings })
      .then(async (saved) => {
        buddySavedSettings = { ...saved };
        evalGlobal(`appSettings = ${JSON.stringify(saved)}`);
        const mockChanged =
          !!previous &&
          (previous.mockPort !== saved.mockPort ||
            previous.mockHttps !== saved.mockHttps);
        if (!mockChanged || !mockServerRunning) return;
        try {
          await invoke("stop_mock_server");
          const status = await invoke<MockServerStatus>("start_mock_server");
          setMockServerStatus(status);
          if ((status.totalRequests ?? 0) === 0) mockRequestLogs = [];
          applyMockRunningState();
        } catch (error) {
          setMockServerStatus({
            running: false,
            port: buddySavedSettings?.mockPort ?? 4010,
            https: buddySavedSettings?.mockHttps ?? false,
            url: ""
          });
          applyMockRunningState();
          toast("Could not restart mock server", String(error));
        }
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
    syncEditor(false);
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
  toast(w.t("Opened JSON file"), `${side.toUpperCase()} · ${name}`);
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

interface StreamArchivePage {
  events: StreamEvent[];
  hasMore: boolean;
}

let buddyStreamSnapshot: StreamSnapshot | null = null;
let buddyStreamEvents: StreamEvent[] = [];
let buddyStreamArchiveCount = 0;
let buddyStreamArchiveLoading = false;
let buddyStreamArchiveExhausted = false;
let buddyStreamArchiveLoaded = false;
let buddyStreamFollowing: string | null = null;
let buddyStreamRateSamples: { at: number; count: number }[] = [];
let buddyStreamLastEventAt: number | null = null;
let buddyOpenStreamPath: ((path: string) => Promise<void>) | null = null;
let fileDropInstalled = false;
const STREAM_RATE_WINDOW_MS = 5000;

function resetStreamRate(): void {
  buddyStreamRateSamples = [];
  buddyStreamLastEventAt = null;
}

function recordStreamTraffic(count: number): void {
  if (count <= 0) return;
  const now = Date.now();
  buddyStreamLastEventAt = now;
  buddyStreamRateSamples.push({ at: now, count });
  pruneStreamTraffic(now);
}

function pruneStreamTraffic(now = Date.now()): void {
  const cutoff = now - STREAM_RATE_WINDOW_MS;
  buddyStreamRateSamples = buddyStreamRateSamples.filter(
    (sample) => sample.at >= cutoff
  );
}

function streamRateValue(): number {
  const now = Date.now();
  pruneStreamTraffic(now);
  const events = buddyStreamRateSamples.reduce(
    (total, sample) => total + sample.count,
    0
  );
  return events / (STREAM_RATE_WINDOW_MS / 1000);
}

function streamRateText(): string {
  const value = streamRateValue();
  return value >= 10
    ? String(Math.round(value))
    : value.toFixed(1).replace(/\.0$/, "");
}

function streamLastEventAge(): string {
  const zh = streamLanguageIsZh();
  if (!buddyStreamLastEventAt) return zh ? "刚刚" : "just now";
  const seconds = Math.max(0, (Date.now() - buddyStreamLastEventAt) / 1000);
  if (seconds < 1) return zh ? "刚刚" : "just now";
  if (seconds < 60) {
    return zh ? `${seconds.toFixed(1)} 秒前` : `${seconds.toFixed(1)}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
}
let buddyConversation: Conversation | null = null;
let buddyStreamPending = 0;
let buddyStreamFocusLine: number | null = null;
let buddyStreamScrollBound = false;
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
  const total = buddyStreamEvents.length;
  if (!total) {
    host.innerHTML =
      `<div class="stream-spacer" style="height:24px"></div><div class="stream-empty" style="padding:16px;color:var(--ink-3);font-size:10px">${streamLanguageIsZh() ? "暂无事件。" : "No events yet."}</div>`;
    return;
  }
  const rowHtml = (event: StreamEvent, index: number, freshBase: number) => {
    const fresh = live && index >= freshBase;
    const focused = event.line === buddyStreamFocusLine;
    return `<div class="sl${fresh ? " new" : ""}${focused ? " focus" : ""}"><span class="ln">${event.line}</span><span class="cl">${w.highlightJsonLine(
      event.raw
    )}</span></div>`;
  };
  if (host.classList.contains("wrap")) {
    // Wrapped rows have variable height, so render the full buffer without
    // a fixed-size virtual window.
    host.innerHTML = buddyStreamEvents
      .map((event, index) => rowHtml(event, index, total - 3))
      .join("");
    return;
  }
  const rowHeight = 23;
  const paddingTop = 8;
  const viewport = Math.max(120, host.clientHeight || 0);
  const visibleCount = Math.ceil(viewport / rowHeight) + 24;
  const scrollTop = host.scrollTop;
  let start = Math.max(
    0,
    Math.floor((scrollTop - paddingTop) / rowHeight) - 12
  );
  let end = Math.min(total, start + visibleCount);
  if (end - start < visibleCount) start = Math.max(0, end - visibleCount);
  const top = start * rowHeight;
  const bottom = Math.max(0, (total - end) * rowHeight);
  host.innerHTML =
    `<div class="buddy-stream-pad" style="height:${top}px;flex:0 0 auto"></div>` +
    buddyStreamEvents
      .slice(start, end)
      .map((event, index) => rowHtml(event, start + index, total - 3))
      .join("") +
    `<div class="buddy-stream-pad" style="height:${bottom}px;flex:0 0 auto"></div>`;
  host.dataset.windowStart = String(start);
  host.dataset.windowEnd = String(end);
}

async function loadOlderStreamEvents(): Promise<void> {
  if (
    buddyStreamArchiveLoading ||
    buddyStreamArchiveExhausted ||
    !buddyStreamSnapshot
  ) {
    return;
  }
  const first = buddyStreamEvents[0];
  if (!first || first.line <= 1) {
    buddyStreamArchiveExhausted = true;
    return;
  }
  const path = buddyStreamSnapshot.path;
  buddyStreamArchiveLoading = true;
  try {
    const page = await invoke<StreamArchivePage>("read_stream_archive", {
      path,
      beforeLine: first.line,
      limit: 500
    });
    if (
      !buddyStreamSnapshot ||
      buddyStreamSnapshot.path !== path ||
      buddyStreamEvents[0]?.line !== first.line
    ) {
      return;
    }
    if (!page.events.length) {
      buddyStreamArchiveExhausted = true;
      return;
    }
    const existing = new Set(buddyStreamEvents.map((event) => event.line));
    const older = page.events.filter(
      (event) => event.line < first.line && !existing.has(event.line)
    );
    if (!older.length) {
      buddyStreamArchiveExhausted = true;
      return;
    }
    const host = document.getElementById("streamCode");
    if (!host) return;
    const wrap = host.classList.contains("wrap");
    const previousScrollTop = host.scrollTop;
    const previousFirstLine = first.line;
    const maxLoaded = 30000;
    let prefix = older;
    let trimmed = 0;
    if (buddyStreamEvents.length + older.length > maxLoaded) {
      const allowed = Math.max(0, maxLoaded - buddyStreamEvents.length);
      trimmed = older.length - allowed;
      prefix = older.slice(trimmed);
      buddyStreamArchiveExhausted = true;
    } else {
      buddyStreamArchiveExhausted = !page.hasMore;
    }
    if (trimmed) buddyStreamArchiveExhausted = true;
    if (!prefix.length) return;
    buddyStreamEvents = [...prefix, ...buddyStreamEvents];
    buddyStreamArchiveCount += prefix.length;
    buddyStreamArchiveLoaded = true;
    if (buddyStreamSnapshot) buddyStreamSnapshot.events = buddyStreamEvents;
    const live = !getStreamPaused();
    renderRealStreamSource(live);
    if (wrap) {
      const row = Array.from(host.querySelectorAll<HTMLElement>(".sl")).find(
        (item) => Number(item.querySelector(".ln")?.textContent) === previousFirstLine
      );
      row?.scrollIntoView({ block: "start" });
    } else {
      host.scrollTop = previousScrollTop + prefix.length * 23;
    }
    updateStreamBufferMeter();
    renderRealStreamEvents(live);
  } catch (error) {
    buddyStreamArchiveExhausted = true;
    toast("Could not load stream history", String(error));
  } finally {
    buddyStreamArchiveLoading = false;
  }
}

function streamNearBottom(host: HTMLElement | null): boolean {
  if (!host) return true;
  return host.scrollHeight - host.scrollTop - host.clientHeight < 56;
}

function streamLanguageIsZh(): boolean {
  return document.getElementById("app")?.dataset.lang === "zh";
}

function streamPendingText(count: number): string {
  return streamLanguageIsZh()
    ? `${count.toLocaleString("en-US")} 条新事件 · 点击跟随`
    : `${count.toLocaleString("en-US")} new events · click to follow`;
}

function scrollStreamToBottom(): void {
  const host = document.getElementById("streamCode");
  if (!host) return;
  buddyStreamPending = 0;
  host.scrollTop = host.scrollHeight;
  renderRealStreamSource(!buddyStreamSnapshot ? false : !getStreamPaused());
  const edge = document.getElementById("edgeText");
  if (edge) edge.textContent = w.t("Following live edge");
}

function focusStreamEventLine(line: number): void {
  if (!buddyStreamSnapshot || !buddyStreamEvents.length) return;
  let index = buddyStreamEvents.findIndex((event) => event.line === line);
  if (index < 0) {
    index = buddyStreamEvents.findIndex((event) => event.line >= line);
    if (index < 0) index = buddyStreamEvents.length - 1;
  }
  const target = buddyStreamEvents[index];
  if (!target) return;
  buddyStreamFocusLine = target.line;
  w.setMonitorMode?.("source");
  const host = document.getElementById("streamCode");
  if (!host) return;
  const live = !getStreamPaused();
  window.setTimeout(() => {
    if (host.classList.contains("wrap")) {
      renderRealStreamSource(live);
      const row = Array.from(host.querySelectorAll<HTMLElement>(".sl")).find(
        (item) => Number(item.querySelector(".ln")?.textContent) === target.line
      );
      row?.scrollIntoView({ block: "center" });
    } else {
      host.scrollTop = Math.max(
        0,
        index * 23 + 8 - Math.floor(host.clientHeight / 2)
      );
      renderRealStreamSource(live);
    }
  }, 40);
}

function getStreamPaused(): boolean {
  try {
    return evalGlobal<boolean>("getMonitorFile(activeMonitorFileId)?.paused ?? true");
  } catch {
    return true;
  }
}

function bindStreamScroll(): void {
  if (buddyStreamScrollBound) return;
  const host = document.getElementById("streamCode");
  if (!host) return;
  buddyStreamScrollBound = true;
  host.addEventListener("scroll", () => {
    if (host.scrollTop < 180) void loadOlderStreamEvents();
    if (host.classList.contains("wrap")) return;
    requestAnimationFrame(() => {
      const live = !getStreamPaused();
      if (streamNearBottom(host) && buddyStreamPending > 0) {
        buddyStreamPending = 0;
        const edge = document.getElementById("edgeText");
        if (edge) edge.textContent = w.t(live ? "Following live edge" : "Paused · follow to resume");
      }
      renderRealStreamSource(live);
    });
  });
  const edge = document.querySelector(".live-edge");
  if (edge) {
    (edge as HTMLElement).style.cursor = "pointer";
    edge.addEventListener("click", () => {
      if (getStreamPaused()) {
        void w.toggleMonitorPause?.();
      } else {
        scrollStreamToBottom();
      }
    });
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

function updateStreamRateChrome(file: BridgeStreamFile, live: boolean): void {
  const zstd = file.format === "zstd";
  const lines = file.lineLabel;
  const rate = streamRateText();
  if (!live) {
    const zh = streamLanguageIsZh();
    w.setHtml(
      "monStat2",
      zstd
        ? `<b>${file.decoded}</b>${zh ? " 已解码" : " decoded"}`
        : `<b>${file.size}</b>`
    );
    w.setText("monStat4", zh ? `修改于 ${file.modified}` : `modified ${file.modified}`);
    w.setText("stat4Label", w.t("Modified"));
    w.setText("stat4Value", file.modified);
    w.setText(
      "lpFrame",
      zstd
        ? zh
          ? `已解码 · 最后 ${file.modified}`
          : `Decoded · last ${file.modified}`
        : zh
          ? `最后 ${file.modified}`
          : `Last ${file.modified}`
    );
    return;
  }
  const zh = streamLanguageIsZh();
  w.setHtml("monStat2", `<b>${w.escHtml(rate)}</b>/s`);
  w.setText("monStat4", streamLastEventAge());
  w.setText("stat4Label", w.t("Rate"));
  w.setText("stat4Value", zh ? `${rate} 行/秒` : `${rate} lines/s`);
  w.setText(
    "lpFrame",
    zstd
      ? zh
        ? `帧 · 追加于 ${streamLastEventAge()}`
        : `Frame · appended ${streamLastEventAge()}`
      : zh
        ? `追加于 ${streamLastEventAge()}`
        : `Appended ${streamLastEventAge()}`
  );
  w.setText("monStat1", `${lines} lines`);
}

function updateStreamBufferMeter(): void {
  const buffered = Math.max(
    0,
    Math.min(10000, buddyStreamEvents.length - buddyStreamArchiveCount)
  );
  w.setText(
    "bufferText",
    `${buffered.toLocaleString("en-US")} / 10,000 lines`
  );
  const fill = document.getElementById("bufferFill");
  if (fill) {
    fill.style.width = `${Math.min(100, (buffered / 10000) * 100).toFixed(2)}%`;
  }
}

function updateStreamBufferLabel(): void {
  const bufferLabel = document.querySelector<HTMLElement>(
    ".status-monitor .status-right .status-item.live-only"
  );
  if (!bufferLabel) return;
  bufferLabel.textContent = viewLanguageIsZh()
    ? "缓冲 10,000"
    : "Buffer 10,000";
}

function updateRealStreamChrome(file: BridgeStreamFile, live: boolean): void {
  const zstd = file.format === "zstd";
  const lines = file.lineLabel;
  w.setText("monStat1", `${lines} lines`);
  if (zstd) {
    w.setHtml("monStat3", `<b>${file.ratio}</b> zstd`);
  } else {
    w.setHtml("monStat3", "<b>JSONL</b> format");
  }
  w.setText("stat1Label", zstd ? "Compressed" : "File size");
  w.setText("stat1Value", zstd ? file.compressed : file.size);
  w.setText("stat2Label", zstd ? "Decoded" : "Lines");
  w.setText("stat2Value", zstd ? file.decoded : lines);
  w.setText("stat3Label", zstd ? "Ratio" : "Format");
  w.setText("stat3Value", zstd ? file.ratio : "JSONL");
  updateStreamRateChrome(file, live);
  w.setText("srcMeta", zstd ? `${lines} lines · ${file.decoded} decoded` : `${lines} lines · ${file.size}`);
  w.setText("monitorPath", file.name);
  w.setText(
    "monitorFormat",
    zstd
      ? live
        ? "zstd · incremental"
        : "zstd · snapshot"
      : "JSONL · UTF-8"
  );
  w.setText("monitorLines", `${lines} lines`);
  w.setText("monitorSize", zstd ? `${file.decoded} decoded` : file.size);
  updateStreamBufferMeter();
  updateStreamBufferLabel();
  w.setText("edgeText", w.t(live ? "Following live edge" : "Paused · follow to resume"));
  w.setText("monitorStatusText", live ? "Following" : "Paused");
  const pill = document.getElementById("monitorStatusPill");
  if (pill) pill.className = `status-pill ${live ? "live" : "neutral"}`;
}

function chatLanguageIsZh(): boolean {
  return document.getElementById("app")?.dataset.lang === "zh";
}

function chatUiText(english: string, chinese: string): string {
  return chatLanguageIsZh() ? chinese : english;
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
  if (call.status === "error") return chatUiText("error", "错误");
  if (call.status === "pending") return chatUiText("running", "运行中");
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
      <span>${w.escHtml(w.t("Model switched"))}</span>
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
        <div class="msg-meta"><b>${w.escHtml(w.t("You"))}</b><span>${w.escHtml(time)}</span></div>
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
        message.streaming ? `<span class="live-only">${w.escHtml(w.t("· streaming"))}</span>` : ""
      }</div>
      <div class="parts">
        ${
          message.reasoning
            ? `<button class="reasoning" onclick="this.classList.toggle('on'); const body=this.nextElementSibling; if(body) body.hidden=!body.hidden;"><svg class="i" viewBox="0 0 24 24"><use href="#i-chev-right"/></svg>${w.escHtml(chatUiText("Thought", "思考"))}</button>
               <div class="bubble reasoning-body" hidden>${chatMarkdown(message.reasoning)}</div>`
            : ""
        }
        ${message.text ? `<div class="bubble">${chatMarkdown(message.text)}</div>` : ""}
        ${tools}
        <div class="msg-foot"><span>#L${message.line}</span>${
          message.toolCalls.length
            ? `<span>·</span><span>${w.escHtml(
                chatLanguageIsZh()
                  ? `${message.toolCalls.length} 个工具`
                  : `${message.toolCalls.length} tool${
                      message.toolCalls.length === 1 ? "" : "s"
                    }`
              )}</span>`
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
      <span>${w.escHtml(w.t("System prompt"))}</span>
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
let buddyAppAuditEntries: AuditEntry[] = [];
let buddyAuditConfig: AuditConfig | null = null;
let buddyAuditAck = new Set<string>();
let buddyAuditActive = false;
let buddyAuditSeverity = "all";
let auditRenderTimer: number | null = null;
let auditBridgeReady = false;

function allAuditEntries(): AuditEntry[] {
  return [...buddyAppAuditEntries, ...buddyAuditEntries];
}

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

const AUDIT_LABELS_ZH: Record<string, string> = {
  traversal: "目录穿越",
  read: "文件读取",
  upload: "文件上传",
  delete: "文件删除",
  shell: "Shell 执行",
  network: "网络出站"
};

const AUDIT_RULES_ZH: Record<string, string> = {
  "Rule: destructive file operation. The sandbox denied it.":
    "规则：破坏性文件操作。沙箱已拒绝。",
  "Rule: destructive file operation outside the allowlist.":
    "规则：白名单外的破坏性文件操作。",
  "Rule: path escapes the workspace root. The request is blocked by policy.":
    "规则：路径超出工作区根目录。请求已被策略阻止。",
  "Rule: outbound upload was denied.": "规则：外部上传已被拒绝。",
  "Rule: outbound upload to a non-local destination.":
    "规则：向非本地目标的外部上传。",
  "Rule: outbound request was denied.": "规则：外部请求已被拒绝。",
  "Rule: outbound request to a non-local host.":
    "规则：向非本地主机的外部请求。",
  "Rule: shell command failed or was denied.":
    "规则：Shell 命令失败或已被拒绝。",
  "Rule: shell command observed and allowed by the sandbox.":
    "规则：沙箱观察到并允许的 Shell 命令。",
  "Rule: file read was denied.": "规则：文件读取已被拒绝。",
  "Rule: file read inside the workspace.": "规则：工作区内的文件读取。",
  "Rule: mock route path escapes its project mount.":
    "规则：Mock 路由路径超出项目挂载范围。",
  "Rule: mock project removed from local storage.":
    "规则：已从本地存储删除 Mock 项目。",
  "Rule: non-local request blocked by the local network policy.":
    "规则：本地网络策略已阻止非本地请求。"
};

function auditLanguageIsZh(): boolean {
  return document.getElementById("app")?.dataset.lang === "zh";
}

function auditUiText(english: string, chinese: string): string {
  return auditLanguageIsZh() ? chinese : english;
}

function auditItemLabel(entry: AuditEntry): string {
  return auditLanguageIsZh()
    ? AUDIT_LABELS_ZH[entry.category] ?? entry.label
    : entry.label;
}

function auditItemRule(entry: AuditEntry): string {
  return auditLanguageIsZh()
    ? AUDIT_RULES_ZH[entry.rule] ?? entry.rule
    : entry.rule;
}

function auditItemHtml(entry: AuditEntry, selected: boolean): string {
  const acknowledged =
    buddyAuditAck.has(entry.id) || buddyAuditAck.has(entry.category);
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
      data-label="${w.escHtml(auditItemLabel(entry).toLowerCase())}"
      onclick="selectAudit(this)">
    <div class="ai-top">
      <span class="ai-type"><svg class="i" viewBox="0 0 24 24"><use href="#${auditIcon(
        entry.category
      )}"/></svg><span>${w.escHtml(auditItemLabel(entry))}</span></span>
      <span class="ai-decision ${blocked ? "blocked" : "allowed"}">${
        blocked
          ? auditUiText("Blocked", "已阻止")
          : auditUiText("Allowed", "已允许")
      }</span>
    </div>
    <div class="ai-target">${w.escHtml(entry.target || "—")}</div>
    <div class="ai-meta">
      <span>${w.escHtml(entry.tool)}</span>
      <span>${w.escHtml(auditTime(entry.timestamp))}</span>
      <span>${w.escHtml(entry.sessionId ?? "session")}</span>
    </div>
    <div class="ai-detail">
      <div class="ai-rule">${w.escHtml(auditItemRule(entry))}</div>
      <div class="ai-actions">
        <button class="ai-action" onclick="event.stopPropagation(); selectAudit(this.closest('.audit-item')); openAuditSource()">${w.escHtml(
          auditUiText("View raw event", "查看原始事件")
        )}</button>
        ${
          acknowledged
            ? `<button class="ai-action ack acked" disabled>${w.escHtml(
                auditUiText("Acknowledged", "已确认")
              )}</button>`
            : `<button class="ai-action ack" data-ack-id="${w.escHtml(
                entry.id
              )}">${w.escHtml(auditUiText("Acknowledge", "确认"))}</button>`
        }
        <button class="ai-action" onclick="event.stopPropagation(); copyAuditTarget(this)">${w.escHtml(
          auditUiText("Copy target", "复制目标")
        )}</button>
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
  host.innerHTML = allAuditEntries()
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

function startAuditEventBridge(): void {
  if (auditBridgeReady || !hasTauri) return;
  if (typeof (window as any).__TAURI_INTERNALS__?.transformCallback !== "function") {
    return;
  }
  auditBridgeReady = true;
  void listen<AuditEntry>("audit-entry", (event) => {
    buddyAppAuditEntries = [
      event.payload,
      ...buddyAppAuditEntries.filter((entry) => entry.id !== event.payload.id)
    ].slice(0, 500);
    if (buddyAuditActive) scheduleAuditRender();
  }).catch((error) => {
    console.warn("could not listen for audit events", error);
  });
}

function patchAuditFlow(): void {
  const originalApplyMonitorFilter = w.applyMonitorFilter;
  const originalOpenAuditSource = w.openAuditSource;
  const originalCopyAuditTarget = w.copyAuditTarget;

  w.openAuditSource = () => {
    const selected = document.querySelector<HTMLElement>(
      "#auditList .audit-item.sel"
    );
    const entry = allAuditEntries().find(
      (candidate) => candidate.id === selected?.dataset.auditId
    );
    if (
      !entry ||
      entry.line <= 0 ||
      entry.path !== buddyStreamSnapshot?.path
    ) {
      if (entry) {
        toast(
          viewLanguageIsZh()
            ? "该审计项没有流内源码位置"
            : "This audit entry has no stream source line",
          entry.target
        );
      }
      return;
    }
    originalOpenAuditSource();
    focusStreamEventLine(entry.line);
  };

  w.copyAuditTarget = (button: HTMLElement) => {
    const item = button.closest<HTMLElement>(".audit-item");
    const target = item?.querySelector(".ai-target")?.textContent?.trim() ?? "";
    if (!target) return;
    w.copyText?.(target, w.t("Copied"), target);
  };
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

  w.buddyAcknowledgeAudit = async (id: string, _button: HTMLElement) => {
    const entry = allAuditEntries().find((candidate) => candidate.id === id);
    const key = entry?.category || id;
    try {
      const config = await invoke<AuditConfig>("acknowledge_audit", {
        id: key
      });
      buddyAuditConfig = config;
      buddyAuditAck = new Set(config.acknowledged);
      document
        .querySelectorAll<HTMLElement>("#auditList .audit-item")
        .forEach((item) => {
          if (item.dataset.type !== entry?.category) return;
          item.classList.add("acked");
          const action = item.querySelector<HTMLButtonElement>(".ai-action.ack");
          if (action) {
            action.textContent = auditUiText("Acknowledged", "已确认");
            action.disabled = true;
          }
        });
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

/* ------------------------------------------------------------
   Tree view
   ------------------------------------------------------------ */

interface TreeNodeInfo {
  type: string;
  preview: string;
  path: string;
}

const treeNodeIndex = new Map<string, TreeNodeInfo>();
const treeExpanded = new Set<string>();
let treeSelectedPath = "$";
let treeQuery = "";
let treeInstalled = false;
let treeRenderTimer: number | null = null;

const treeStyle = document.createElement("style");
treeStyle.textContent = `
  .buddy-tree-view {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: none;
    flex-direction: column;
    gap: 9px;
    padding: 12px 14px 9px;
    overflow: hidden;
  }
  .app[data-view="tree"] .buddy-tree-view { display: flex; }
  .app[data-view="tree"] .graph-scene,
  .app[data-view="tree"] .canvas-toolbar,
  .app[data-view="tree"] .canvas-right-tools,
  .app[data-view="tree"] .minimap,
  .app[data-view="tree"] .table-view,
  .app[data-view="tree"] .code-view { display: none; }
  .buddy-tree-view .table-scroll { padding-bottom: 0; }
  .buddy-tree-view .table-sheet { min-width: 520px; }
  .tree-body { padding: 4px 0 5px; }
  .tree-row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 25px;
    padding-right: 14px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--code-plain);
    white-space: nowrap;
    user-select: none;
  }
  .tree-row:hover { background: var(--hover); }
  .tree-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tree-row.sel { background: var(--accent-soft); }
  .tree-row.sel .tree-key { color: var(--accent-2); }
  [data-theme="dark"] .tree-row.sel .tree-key { color: var(--accent); }
  .tree-toggle {
    width: 17px;
    height: 17px;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    border-radius: 4px;
    color: var(--ink-4);
  }
  .tree-toggle:hover { background: var(--hover-strong); color: var(--ink-2); }
  .tree-toggle .i { transition: transform .12s ease; }
  .tree-toggle.open .i { transform: rotate(90deg); }
  .tree-toggle.placeholder { visibility: hidden; }
  .tree-key { color: var(--code-key); }
  .tree-key.index { color: var(--ink-3); min-width: 22px; text-align: right; }
  .tree-colon { color: var(--code-punct); }
  .tree-value.str { color: var(--code-string); }
  .tree-value.num { color: var(--code-number); }
  .tree-value.bool { color: var(--code-bool); }
  .tree-value.null { color: var(--code-null); }
  .tree-type {
    font-family: var(--font-ui);
    font-size: 8px;
    font-weight: 650;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--ink-3);
    background: var(--hover-strong);
    border-radius: 3px;
    padding: 1px 4px;
  }
  .tree-count { font-family: var(--font-ui); font-size: 8.5px; color: var(--ink-3); }
  .tree-path {
    margin-left: auto;
    max-width: 42%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ink-4);
    font-size: 9px;
  }
  .tree-empty { padding: 18px 12px; font-size: 10px; color: var(--ink-3); text-align: center; }
  .tree-muted { color: var(--ink-3); }
`;
document.head.appendChild(treeStyle);

function viewLanguageIsZh(): boolean {
  return document.getElementById("app")?.dataset.lang === "zh";
}

function treeTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function treePreview(value: unknown, limit = 120): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    const text = value.length > limit ? `${value.slice(0, limit)}…` : value;
    return JSON.stringify(text);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).length} keys}`;
  }
  return String(value);
}

function treePathFor(parent: string, key: string | number, index: boolean): string {
  if (index) return `${parent}[${key}]`;
  const text = String(key);
  return /^[A-Za-z_$][\w$]*$/.test(text)
    ? `${parent}.${text}`
    : `${parent}[${JSON.stringify(text)}]`;
}

function treeStats(value: unknown): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const walk = (item: unknown, level: number) => {
    if (nodes > 200_000) return;
    nodes += 1;
    depth = Math.max(depth, level);
    if (Array.isArray(item)) {
      for (const child of item) walk(child, level + 1);
    } else if (item && typeof item === "object") {
      for (const child of Object.values(item as Record<string, unknown>)) {
        walk(child, level + 1);
      }
    }
  };
  walk(value, 0);
  return { nodes, depth };
}

function treeSubtreeMatches(
  key: string,
  value: unknown,
  path: string,
  query: string
): boolean {
  if (!query) return true;
  if (
    key.toLowerCase().includes(query) ||
    path.toLowerCase().includes(query) ||
    treePreview(value).toLowerCase().includes(query)
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((child, index) =>
      treeSubtreeMatches(String(index), child, treePathFor(path, index, true), query)
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([name, child]) =>
      treeSubtreeMatches(name, child, treePathFor(path, name, false), query)
    );
  }
  return false;
}

function treeScalarHtml(value: unknown): string {
  const type = treeTypeOf(value);
  const text = w.escHtml(treePreview(value));
  return `<span class="tree-value ${type}">${text}</span>`;
}

interface TreeRenderBudget {
  remaining: number;
  truncated: boolean;
}

function renderTreeRows(
  key: string,
  value: unknown,
  path: string,
  depth: number,
  index: boolean,
  query: string,
  budget: TreeRenderBudget
): string {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return "";
  }
  if (!treeSubtreeMatches(key, value, path, query)) return "";
  budget.remaining -= 1;
  const type = treeTypeOf(value);
  const expandable =
    (type === "object" && Object.keys(value as Record<string, unknown>).length > 0) ||
    (type === "array" && (value as unknown[]).length > 0);
  const expanded = expandable && (query ? true : treeExpanded.has(path));
  treeNodeIndex.set(path, {
    type,
    preview: treePreview(value),
    path
  });
  const pad = 8 + depth * 16;
  const toggle = expandable
    ? `<button class="tree-toggle${expanded ? " open" : ""}" data-tree-toggle="${w.escHtml(
        path
      )}" title="${viewLanguageIsZh() ? (expanded ? "折叠" : "展开") : expanded ? "Collapse" : "Expand"}">
        <svg class="i xs" viewBox="0 0 24 24"><use href="#i-chev-right"/></svg>
      </button>`
    : '<span class="tree-toggle placeholder"></span>';
  const keyHtml = index
    ? `<span class="tree-key index">${w.escHtml(key)}</span>`
    : `<span class="tree-key">${w.escHtml(key)}</span>`;
  let valueHtml = "";
  if (type === "object") {
    valueHtml = `<span class="tree-count">{${Object.keys(value as Record<string, unknown>).length} keys}</span>`;
  } else if (type === "array") {
    valueHtml = `<span class="tree-count">[${(value as unknown[]).length} items]</span>`;
  } else {
    valueHtml = treeScalarHtml(value);
  }
  let html = `<div class="tree-row${path === treeSelectedPath ? " sel" : ""}" data-path="${w.escHtml(
    path
  )}" tabindex="0" onclick="buddyTreeSelect(this)" style="padding-left:${pad}px">
    ${toggle}${keyHtml}<span class="tree-colon">:</span>${valueHtml}
    <span class="tree-type">${type}</span>
    <span class="tree-path">${w.escHtml(path)}</span>
  </div>`;
  if (expanded) {
    if (type === "array") {
      (value as unknown[]).forEach((child, childIndex) => {
        html += renderTreeRows(
          String(childIndex),
          child,
          treePathFor(path, childIndex, true),
          depth + 1,
          true,
          query,
          budget
        );
      });
    } else if (type === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([name, child]) => {
        html += renderTreeRows(
          name,
          child,
          treePathFor(path, name, false),
          depth + 1,
          false,
          query,
          budget
        );
      });
    }
  }
  return html;
}

function updateTreeInspector(): void {
  const info = treeNodeIndex.get(treeSelectedPath);
  const pathEl = document.getElementById("buddyTreePath");
  const typeEl = document.getElementById("buddyTreeType");
  const valueEl = document.getElementById("buddyTreeValue");
  if (pathEl) pathEl.textContent = treeSelectedPath;
  if (typeEl) typeEl.textContent = info?.type ?? "unknown";
  if (valueEl) valueEl.textContent = info?.preview ?? "—";
}

function renderTreeView(): void {
  const host = document.getElementById("buddyTreeBody");
  if (!host) return;
  const focusedPath = (document.activeElement as HTMLElement | null)
    ?.closest?.(".tree-row")
    ?.getAttribute("data-path");
  const count = document.getElementById("buddyTreeCount");
  const doc = currentDoc();
  const source = doc?.text ?? "";
  if (!source.trim()) {
    host.innerHTML =
      `<div class="tree-empty">${viewLanguageIsZh() ? "打开 JSON 文档以查看树。" : "Open a JSON document to inspect its tree."}</div>`;
    if (count) count.textContent = viewLanguageIsZh() ? "无文档" : "No document";
    treeNodeIndex.clear();
    updateTreeInspector();
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    host.innerHTML =
      `<div class="tree-empty">${viewLanguageIsZh() ? "文档不是有效 JSON。修复语法后查看树。" : "The document is not valid JSON. Fix the syntax to inspect the tree."}</div>`;
    if (count) count.textContent = viewLanguageIsZh() ? "JSON 无效" : "Invalid JSON";
    treeNodeIndex.clear();
    updateTreeInspector();
    return;
  }
  const stats = treeStats(value);
  if (!treeExpanded.has("$") && treeExpanded.size === 0) treeExpanded.add("$");
  treeNodeIndex.clear();
  const budget: TreeRenderBudget = { remaining: 4000, truncated: false };
  const html = renderTreeRows("$", value, "$", 0, false, treeQuery, budget);
  host.innerHTML = `<div class="tree-body">${
    html || `<div class="tree-empty">${viewLanguageIsZh() ? "没有节点匹配此筛选。" : "No nodes match this filter."}</div>`
  }</div>${
    budget.truncated
      ? `<div class="tree-empty">${viewLanguageIsZh() ? "显示前 4,000 个节点。" : "Showing the first 4,000 nodes."}</div>`
      : ""
  }`;
  host
    .querySelectorAll<HTMLElement>("[data-tree-toggle]")
    .forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const path = button.dataset.treeToggle;
        if (path) w.buddyTreeToggle(path);
      });
    });
  const treeRows = Array.from(host.querySelectorAll<HTMLElement>(".tree-row"));
  treeRows.forEach((row, index) => {
    row.addEventListener("keydown", (event) => {
      const path = row.dataset.path;
      if (!path) return;
      const toggle = row.querySelector<HTMLElement>(
        ".tree-toggle:not(.placeholder)"
      );
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const target = treeRows[Math.max(0, Math.min(treeRows.length - 1, index + offset))];
        if (target) {
          w.buddyTreeSelect(target);
          target.focus();
        }
      } else if (event.key === "ArrowRight" && toggle) {
        event.preventDefault();
        if (!toggle.classList.contains("open")) w.buddyTreeToggle(path);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (toggle?.classList.contains("open")) {
          w.buddyTreeToggle(path);
        } else {
          const parent = path.replace(/\.[^.\[\]]+$|\[\d+\]$/, "");
          const parentRow = treeRows.find((item) => item.dataset.path === parent);
          if (parentRow) {
            w.buddyTreeSelect(parentRow);
            parentRow.focus();
          }
        }
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        w.buddyTreeSelect(row);
      }
    });
  });
  if (!treeNodeIndex.has(treeSelectedPath)) {
    treeSelectedPath = "$";
    host.querySelector<HTMLElement>('.tree-row[data-path="$"]')?.classList.add("sel");
  }
  if (focusedPath) {
    const focusedRow = Array.from(
      host.querySelectorAll<HTMLElement>(".tree-row")
    ).find((row) => row.dataset.path === focusedPath);
    focusedRow?.focus({ preventScroll: true });
  }
  if (count) {
    count.textContent = budget.truncated
      ? viewLanguageIsZh()
        ? `4,000 / ${stats.nodes.toLocaleString("en-US")} 个节点`
        : `4,000 of ${stats.nodes.toLocaleString("en-US")} nodes`
      : viewLanguageIsZh()
        ? `${stats.nodes.toLocaleString("en-US")} 个节点 · ${stats.depth} 层`
        : `${stats.nodes.toLocaleString("en-US")} nodes · ${stats.depth} levels`;
  }
  updateTreeInspector();
}

function scheduleTreeRender(delay = 160): void {
  if (!treeInstalled) return;
  if (treeRenderTimer !== null) window.clearTimeout(treeRenderTimer);
  treeRenderTimer = window.setTimeout(() => {
    treeRenderTimer = null;
    let view = "";
    try {
      view = evalGlobal<string>("app.dataset.view");
    } catch {
      view = "";
    }
    if (view === "tree") renderTreeView();
  }, delay);
}

function treeAllExpandablePaths(): string[] {
  const doc = currentDoc();
  if (!doc?.text) return [];
  let value: unknown;
  try {
    value = JSON.parse(doc.text);
  } catch {
    return [];
  }
  const paths: string[] = [];
  const walk = (item: unknown, path: string) => {
    if (paths.length > 4000) return;
    if (Array.isArray(item) && item.length) {
      paths.push(path);
      item.forEach((child, index) => walk(child, treePathFor(path, index, true)));
    } else if (item && typeof item === "object" && Object.keys(item).length) {
      paths.push(path);
      Object.entries(item as Record<string, unknown>).forEach(([key, child]) => {
        walk(child, treePathFor(path, key, false));
      });
    }
  };
  walk(value, "$");
  return paths;
}

function updateTreeLanguage(): void {
  let lang = "en";
  try {
    lang = evalGlobal<string>("app.dataset.lang") ?? "en";
  } catch {
    lang = "en";
  }
  const zh = lang === "zh";
  const label = document.getElementById("buddyTreeViewLabel");
  if (label) label.textContent = zh ? "树" : "Tree";
  const heading = document.getElementById("buddyTreeLabel");
  if (heading) heading.textContent = zh ? "树" : "TREE";
  const filter = document.getElementById("buddyTreeFilter") as HTMLInputElement | null;
  if (filter) filter.placeholder = zh ? "筛选节点…" : "Filter nodes…";
  const expand = document.getElementById("buddyTreeExpandLabel");
  if (expand) expand.textContent = zh ? "展开" : "Expand";
  const collapse = document.getElementById("buddyTreeCollapseLabel");
  if (collapse) collapse.textContent = zh ? "折叠" : "Collapse";
  const hint = document.getElementById("buddyTreeHint");
  if (hint) {
    hint.textContent = zh
      ? "点击节点查看路径 · 点击箭头展开 · 路径可复制"
      : "Click a node to inspect · use arrows to expand · copy its path";
  }
}

function installTreeView(): void {
  if (treeInstalled) return;
  treeInstalled = true;
  const seg = document.querySelector(".editor-toolbar .seg[role='tablist']");
  if (seg && !seg.querySelector("[data-view-btn='tree']")) {
    const button = document.createElement("button");
    button.dataset.viewBtn = "tree";
    button.innerHTML =
      '<svg class="i sm" viewBox="0 0 24 24"><use href="#i-tree"/></svg><span id="buddyTreeViewLabel">Tree</span>';
    button.addEventListener("click", () => w.setView("tree"));
    const tableButton = seg.querySelector("[data-view-btn='table']");
    if (tableButton) tableButton.insertAdjacentElement("afterend", button);
    else seg.appendChild(button);
  }
  const canvas = document.querySelector(".canvas");
  const table = canvas?.querySelector(".table-view");
  if (canvas && !document.getElementById("buddyTreeView")) {
    const view = document.createElement("div");
    view.className = "buddy-tree-view";
    view.id = "buddyTreeView";
    view.setAttribute("aria-label", "Tree view");
    view.innerHTML = `<div class="table-toolbar">
      <span class="tt-label" id="buddyTreeLabel">TREE</span>
      <span class="tt-count" id="buddyTreeCount">0 nodes</span>
      <span class="spacer"></span>
      <button class="cv-pill" onclick="buddyTreeExpandAll()" title="Expand all">
        <svg class="i xs" viewBox="0 0 24 24"><use href="#i-plus"/></svg><span id="buddyTreeExpandLabel">Expand</span>
      </button>
      <button class="cv-pill" onclick="buddyTreeCollapseAll()" title="Collapse all">
        <svg class="i xs" viewBox="0 0 24 24"><use href="#i-minus"/></svg><span id="buddyTreeCollapseLabel">Collapse</span>
      </button>
      <label class="table-filter">
        <svg class="i xs" viewBox="0 0 24 24"><use href="#i-search"/></svg>
        <input id="buddyTreeFilter" type="text" placeholder="Filter nodes…" aria-label="Filter nodes" oninput="buddyTreeFilter(this.value)" />
      </label>
    </div>
    <div class="table-scroll">
      <div class="table-sheet" id="buddyTreeBody"></div>
      <div class="table-inspector">
        <span class="insp-path" id="buddyTreePath">$</span>
        <span class="insp-type" id="buddyTreeType">object</span>
        <span class="insp-val" id="buddyTreeValue">—</span>
        <span class="spacer"></span>
        <button class="insp-btn" onclick="buddyTreeCopyPath()"><svg class="i xs" viewBox="0 0 24 24"><use href="#i-copy"/></svg>Copy path</button>
        <button class="insp-btn" onclick="buddyTreeReveal()"><svg class="i xs" viewBox="0 0 24 24"><use href="#i-code"/></svg>Reveal in source</button>
      </div>
      <div class="table-hint" id="buddyTreeHint">Click a node to inspect · use arrows to expand · copy its path</div>
    </div>`;
    if (table) table.insertAdjacentElement("afterend", view);
    else canvas.appendChild(view);
  }

  const originalSetView = w.setView;
  w.setView = (view: string) => {
    originalSetView(view);
    if (view === "tree") {
      updateTreeLanguage();
      renderTreeView();
    }
  };
  const originalApplyLanguage = w.applyLanguage;
  w.applyLanguage = (language: string) => {
    originalApplyLanguage(language);
    updateTreeLanguage();
    updateJsonStatusLanguage();
    if (buddyAuditActive) renderAudit();
    if (buddyConversation) renderConversation(!getStreamPaused());
    try {
      const file = evalGlobal<BridgeStreamFile | null>(
        "typeof getMonitorFile === 'function' ? getMonitorFile(activeMonitorFileId) : null"
      );
      if (file) {
        updateRealStreamChrome(file, !file.paused);
        const edge = document.getElementById("edgeText");
        if (edge) {
          if (file.paused) edge.textContent = w.t("Paused · follow to resume");
          else if (buddyStreamPending > 0) edge.textContent = streamPendingText(buddyStreamPending);
          else edge.textContent = w.t("Following live edge");
        }
      }
    } catch {
      // The monitor view may not be mounted.
    }
    updateStreamBufferLabel();
    let view = "";
    try {
      view = evalGlobal<string>("app.dataset.view") ?? "";
    } catch {
      view = "";
    }
    if (view === "tree") renderTreeView();
    else if (view === "table") renderTableData();
    else if (view === "graph") renderGraphData();
    else if (view === "code") {
      try {
        renderGeneratedCode(evalGlobal<string>("currentLang"));
      } catch {
        // The code panel may not be mounted.
      }
    }
  };
  w.buddyTreeToggle = (path: string) => {
    if (treeExpanded.has(path)) treeExpanded.delete(path);
    else treeExpanded.add(path);
    renderTreeView();
  };
  w.buddyTreeSelect = (row: HTMLElement) => {
    const path = row.dataset.path;
    if (!path) return;
    treeSelectedPath = path;
    document
      .querySelectorAll("#buddyTreeBody .tree-row.sel")
      .forEach((element) => element.classList.remove("sel"));
    row.classList.add("sel");
    updateTreeInspector();
    if (document.activeElement !== row) row.focus({ preventScroll: true });
  };
  w.buddyTreeFilter = (value: string) => {
    treeQuery = String(value ?? "").trim().toLowerCase();
    renderTreeView();
  };
  w.buddyTreeExpandAll = () => {
    for (const path of treeAllExpandablePaths()) treeExpanded.add(path);
    renderTreeView();
  };
  w.buddyTreeCollapseAll = () => {
    treeExpanded.clear();
    treeExpanded.add("$");
    renderTreeView();
  };
  w.buddyTreeCopyPath = () => {
    w.copyText(treeSelectedPath, w.t("File path copied"), treeSelectedPath);
  };
  w.buddyTreeReveal = () => {
    w.setView("text");
    const match = treeSelectedPath.match(/([A-Za-z_$][\w$]*)\]?$/);
    if (match && editor) {
      const needle = `"${match[1]}"`;
      const text = editor.state.doc.toString();
      const index = text.indexOf(needle);
      if (index >= 0) {
        editor.dispatch({
          selection: { anchor: index, head: index + needle.length },
          scrollIntoView: true
        });
        editor.focus();
      }
    }
    toast(w.t("Revealed in source"), treeSelectedPath);
  };
  updateTreeLanguage();
  renderTreeView();
}

/* ------------------------------------------------------------
   Data-driven table view
   ------------------------------------------------------------ */

const tableMeta = { sections: 0, rows: 0, visibleRows: 0, visibleSections: 0 };
const TABLE_VIRTUAL_THRESHOLD = 200;
const TABLE_ROW_HEIGHT = 34;
const TABLE_VIRTUAL_OVERSCAN = 8;
let tableInstalled = false;
let tableRenderTimer: number | null = null;
let tableFilterQuery = "";
let tableParsedSource: string | null = null;
let tableParsedValue: unknown;
let virtualIdCounter = 0;
let pendingVirtualTables: PendingVirtualTable[] = [];
let virtualTableSections: VirtualTableSection[] = [];
let virtualTableFrame: number | null = null;
let virtualScrollBound = false;

interface PendingVirtualTable {
  id: string;
  rowCount: number;
  colspan: number;
  renderRow: (position: number) => string;
}

interface VirtualTableSection {
  head: HTMLElement;
  table: HTMLTableElement;
  tbody: HTMLTableSectionElement;
  rowCount: number;
  colspan: number;
  renderRow: (position: number) => string;
  start: number;
  end: number;
}

interface TableSectionResult {
  html: string;
  totalRows: number;
  visibleRows: number;
  virtual?: PendingVirtualTable;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tableTypeClass(value: unknown): string {
  if (value === null) return "v-null";
  if (Array.isArray(value)) return "";
  switch (typeof value) {
    case "string":
      return "v-str";
    case "number":
      return "v-num num";
    case "boolean":
      return "v-bool";
    case "object":
      return "";
    default:
      return "v-muted";
  }
}

function tableCellHtml(value: unknown, path: string): string {
  if (value === undefined) {
    return '<td class="v-muted">—</td>';
  }
  const type = treeTypeOf(value);
  const className = tableTypeClass(value);
  let content = "";
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) {
      content = value
        .slice(0, 8)
        .map((item) => `<span class="tag">${w.escHtml(treePreview(item, 30))}</span>`)
        .join("");
      if (value.length > 8) {
        content += `<span class="v-muted">+${value.length - 8}</span>`;
      }
    } else {
      content = `<span class="v-muted">[${value.length} items]</span>`;
    }
  } else if (isPlainObject(value)) {
    content = `<span class="v-muted">{${Object.keys(value).length} keys}</span>`;
  } else if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    content = w.escHtml(text.length > 140 ? `${text.slice(0, 140)}…` : text);
  } else if (value === null) {
    content = '<span class="v-muted">null</span>';
  } else {
    content = w.escHtml(String(value));
  }
  const dataValue = w
    .escHtml(JSON.stringify(value) ?? String(value))
    .replaceAll('"', "&quot;");
  return `<td class="${className} cell" data-path="${w.escHtml(path)}" data-type="${type}" data-val="${dataValue}" onclick="selectCell(this)">${content}</td>`;
}

function tableSearchText(value: unknown): string {
  try {
    return (JSON.stringify(value) ?? String(value)).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function tableRowMatches(text: string): boolean {
  const query = tableFilterQuery.trim().toLowerCase();
  return !query || text.toLowerCase().includes(query);
}

function arrayRowHtml(
  item: unknown,
  index: number,
  path: string,
  objectMode: boolean,
  columns: string[]
): string {
  const indexPath = `${path}[${index}]`;
  let body = `<td class="idx">${index}</td>`;
  if (objectMode) {
    for (const column of columns) {
      body += tableCellHtml(
        isPlainObject(item) ? item[column] : undefined,
        treePathFor(indexPath, column, false)
      );
    }
  } else {
    body += tableCellHtml(item, indexPath);
    body += `<td class="v-muted">${w.escHtml(treeTypeOf(item))}</td>`;
  }
  return `<tr>${body}</tr>`;
}

function renderArraySection(
  key: string,
  list: unknown[],
  path: string
): TableSectionResult {
  const objects = list.filter(isPlainObject);
  const objectMode = objects.length > 0;
  const columns: string[] = [];
  if (objectMode) {
    for (const item of objects.slice(0, 120)) {
      for (const name of Object.keys(item)) {
        if (!columns.includes(name)) columns.push(name);
        if (columns.length >= 24) break;
      }
      if (columns.length >= 24) break;
    }
  }
  const matchingIndexes: number[] = [];
  list.forEach((item, index) => {
    if (tableRowMatches(tableSearchText(item))) matchingIndexes.push(index);
  });
  const visibleRows = matchingIndexes.length;
  if (tableFilterQuery.trim() && !visibleRows) {
    return { html: "", totalRows: list.length, visibleRows: 0 };
  }
  const colCount = objectMode ? columns.length : 2;
  const dataWidth = colCount ? (94 / colCount).toFixed(2) : "94";
  let cols = `<col style="width:6%" />`;
  for (let index = 0; index < colCount; index += 1) {
    cols += `<col style="width:${dataWidth}%" />`;
  }
  const numericSample = objects.slice(0, 120);
  let head = "";
  if (objectMode) {
    head = "<th>#</th>";
    for (const column of columns) {
      const numeric =
        numericSample.length > 0 &&
        numericSample.every((item) => {
          const value = item[column];
          return value === undefined || typeof value === "number";
        });
      head += `<th class="${numeric ? "num" : ""}">${w.escHtml(column)}</th>`;
    }
  } else {
    head = "<th>#</th><th>value</th><th>type</th>";
  }
  const colspan = objectMode ? colCount + 1 : 3;
  let body = "";
  let virtual: PendingVirtualTable | undefined;
  if (!visibleRows) {
    body = `<tr><td class="v-muted" colspan="${colspan}">${
      viewLanguageIsZh() ? "无行" : "No rows"
    }</td></tr>`;
  } else if (visibleRows <= TABLE_VIRTUAL_THRESHOLD) {
    for (const index of matchingIndexes) {
      body += arrayRowHtml(list[index], index, path, objectMode, columns);
    }
  } else {
    virtual = {
      id: `virtual-${(virtualIdCounter += 1)}`,
      rowCount: visibleRows,
      colspan,
      renderRow: (position) => {
        const index = matchingIndexes[position];
        return arrayRowHtml(list[index], index, path, objectMode, columns);
      }
    };
    pendingVirtualTables.push(virtual);
  }
  const notes: string[] = [];
  if (objectMode && columns.length >= 24) {
    notes.push(viewLanguageIsZh() ? "前 24 列" : "first 24 columns");
  }
  const extra = notes.length ? ` · ${notes.join(" · ")}` : "";
  const count =
    tableFilterQuery.trim() && visibleRows !== list.length
      ? `${visibleRows} / ${list.length} items`
      : `${list.length} items`;
  return {
    totalRows: list.length,
    visibleRows,
    html: `<div class="section-head">
      <svg class="i xs" viewBox="0 0 24 24" style="color:var(--ink-3)"><use href="#i-chev-down"/></svg>
      <span class="sec-key">${w.escHtml(key)}</span>
      <span class="sec-type">array</span>
      <span class="sec-count">${count}${extra}</span>
      <span class="sec-path">${w.escHtml(path)}</span>
    </div>
    <table class="dt"${
      virtual ? ` data-virtual-id="${virtual.id}"` : ""
    }><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  };
}

function objectRowHtml(
  name: string,
  item: unknown,
  path: string
): string {
  return `<tr>
      <td class="v-key">${w.escHtml(name)}</td>
      ${tableCellHtml(item, treePathFor(path, name, false))}
      <td class="v-muted">${w.escHtml(treeTypeOf(item))}</td>
    </tr>`;
}

function renderObjectSection(
  key: string,
  value: Record<string, unknown>,
  path: string,
  title = key
): TableSectionResult {
  const allEntries = Object.entries(value);
  const entries = allEntries.filter(([name, item]) =>
    tableRowMatches(`${name} ${tableSearchText(item)}`)
  );
  const visibleRows = entries.length;
  if (tableFilterQuery.trim() && !visibleRows) {
    return { html: "", totalRows: allEntries.length, visibleRows: 0 };
  }
  let body = "";
  let virtual: PendingVirtualTable | undefined;
  if (!visibleRows) {
    body = `<tr><td class="v-muted" colspan="3">${
      viewLanguageIsZh() ? "空对象" : "Empty object"
    }</td></tr>`;
  } else if (visibleRows <= TABLE_VIRTUAL_THRESHOLD) {
    for (const [name, item] of entries) {
      body += objectRowHtml(name, item, path);
    }
  } else {
    virtual = {
      id: `virtual-${(virtualIdCounter += 1)}`,
      rowCount: visibleRows,
      colspan: 3,
      renderRow: (position) => {
        const [name, item] = entries[position];
        return objectRowHtml(name, item, path);
      }
    };
    pendingVirtualTables.push(virtual);
  }
  const count =
    tableFilterQuery.trim() && visibleRows !== allEntries.length
      ? `${visibleRows} / ${allEntries.length} keys`
      : `${allEntries.length} keys`;
  return {
    totalRows: allEntries.length,
    visibleRows,
    html: `<div class="section-head">
      <svg class="i xs" viewBox="0 0 24 24" style="color:var(--ink-3)"><use href="#i-chev-down"/></svg>
      <span class="sec-key">${w.escHtml(title)}</span>
      <span class="sec-type">object</span>
      <span class="sec-count">${count}</span>
      <span class="sec-path">${w.escHtml(path)}</span>
    </div>
    <table class="dt"${
      virtual ? ` data-virtual-id="${virtual.id}"` : ""
    }>
      <colgroup><col style="width:24%" /><col style="width:56%" /><col style="width:20%" /></colgroup>
      <thead><tr><th>key</th><th>value</th><th>type</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`
  };
}

function resetTableMeta(): void {
  tableMeta.sections = 0;
  tableMeta.rows = 0;
  tableMeta.visibleRows = 0;
  tableMeta.visibleSections = 0;
  virtualTableSections = [];
  pendingVirtualTables = [];
}

function hydrateVirtualTables(sheet: Element): void {
  virtualTableSections = [];
  for (const pending of pendingVirtualTables) {
    const table = sheet.querySelector<HTMLTableElement>(
      `table[data-virtual-id="${pending.id}"]`
    );
    const tbody = table?.tBodies[0];
    if (!table || !tbody) continue;
    const previous = table.previousElementSibling;
    virtualTableSections.push({
      head: previous instanceof HTMLElement ? previous : table,
      table,
      tbody,
      rowCount: pending.rowCount,
      colspan: pending.colspan,
      renderRow: pending.renderRow,
      start: -1,
      end: -1
    });
  }
}

function virtualSpacer(height: number, colspan: number): string {
  if (height <= 0) return "";
  return `<tr class="virtual-spacer" aria-hidden="true"><td colspan="${colspan}" style="height:${height}px;padding:0;border:0;line-height:0;font-size:0"></td></tr>`;
}

function updateVirtualTableWindows(force = false): void {
  if (!virtualTableSections.length) return;
  const scroll = document.querySelector<HTMLElement>(".table-view .table-scroll");
  if (!scroll || scroll.clientHeight <= 0) return;
  const scrollRect = scroll.getBoundingClientRect();
  const scrollTop = scroll.scrollTop;
  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + scroll.clientHeight;
  for (const model of virtualTableSections) {
    if (!model.table.isConnected) continue;
    const tableTop =
      model.table.getBoundingClientRect().top - scrollRect.top + scrollTop;
    const bodyTop = tableTop + (model.table.tHead?.offsetHeight ?? 29);
    let start =
      Math.floor((viewportTop - bodyTop) / TABLE_ROW_HEIGHT) -
      TABLE_VIRTUAL_OVERSCAN;
    let end =
      Math.ceil((viewportBottom - bodyTop) / TABLE_ROW_HEIGHT) +
      TABLE_VIRTUAL_OVERSCAN;
    start = Math.max(0, Math.min(model.rowCount, start));
    end = Math.max(start, Math.min(model.rowCount, end));
    if (!force && start === model.start && end === model.end) continue;
    model.start = start;
    model.end = end;
    const topHeight = start * TABLE_ROW_HEIGHT;
    const bottomHeight = (model.rowCount - end) * TABLE_ROW_HEIGHT;
    let html = virtualSpacer(topHeight, model.colspan);
    for (let position = start; position < end; position += 1) {
      html += model.renderRow(position);
    }
    html += virtualSpacer(bottomHeight, model.colspan);
    model.tbody.innerHTML = html;
  }
}

function scheduleVirtualTableUpdate(): void {
  if (virtualTableFrame !== null) return;
  virtualTableFrame = window.requestAnimationFrame(() => {
    virtualTableFrame = null;
    updateVirtualTableWindows();
  });
}

function bindVirtualTableScroll(): void {
  if (virtualScrollBound) return;
  const scroll = document.querySelector<HTMLElement>(".table-view .table-scroll");
  if (!scroll) return;
  virtualScrollBound = true;
  scroll.addEventListener("scroll", scheduleVirtualTableUpdate, { passive: true });
  window.addEventListener("resize", scheduleVirtualTableUpdate, { passive: true });
}

function updateTableCount(query: string): void {
  const countEl = document.getElementById("tableCount");
  if (!countEl) return;
  if (!query.trim()) {
    countEl.textContent = viewLanguageIsZh()
      ? `${tableMeta.sections} 个区块 · ${tableMeta.rows} 行`
      : `${tableMeta.sections} section${
          tableMeta.sections === 1 ? "" : "s"
        } · ${tableMeta.rows} row${tableMeta.rows === 1 ? "" : "s"}`;
    return;
  }
  countEl.textContent = viewLanguageIsZh()
    ? `${tableMeta.visibleRows} 行 · ${tableMeta.visibleSections} 个区块`
    : `${tableMeta.visibleRows} row${
        tableMeta.visibleRows === 1 ? "" : "s"
      } · ${tableMeta.visibleSections} section${
        tableMeta.visibleSections === 1 ? "" : "s"
      }`;
}

function renderTableData(): void {
  const sheet = document.querySelector(".table-view .table-sheet");
  if (!sheet) return;
  const filterEl = document.getElementById("tableRowFilter") as HTMLInputElement | null;
  if (filterEl) tableFilterQuery = filterEl.value;
  const doc = currentDoc();
  const source = doc?.text ?? "";
  const countEl = document.getElementById("tableCount");
  const inspector = `<div class="table-inspector">
    <span class="insp-path" id="inspPath">$</span>
    <span class="insp-type" id="inspType">object</span>
    <span class="insp-val" id="inspVal">—</span>
    <span class="spacer"></span>
    <button class="insp-btn" onclick="copyInspectorPath()"><svg class="i xs" viewBox="0 0 24 24"><use href="#i-copy"/></svg>${viewLanguageIsZh() ? "复制路径" : "Copy path"}</button>
    <button class="insp-btn" onclick="revealInspectorInSource()"><svg class="i xs" viewBox="0 0 24 24"><use href="#i-code"/></svg>${viewLanguageIsZh() ? "在源码中显示" : "Reveal in source"}</button>
  </div>`;
  resetTableMeta();
  if (!source.trim()) {
    sheet.innerHTML = `<div class="tree-empty">${viewLanguageIsZh() ? "打开 JSON 文档以查看表格。" : "Open a JSON document to inspect its tables."}</div>${inspector}`;
    if (countEl) countEl.textContent = viewLanguageIsZh() ? "无文档" : "No document";
    return;
  }
  let value: unknown;
  if (tableParsedSource === source) {
    value = tableParsedValue;
  } else {
    try {
      value = JSON.parse(source);
      tableParsedSource = source;
      tableParsedValue = value;
    } catch {
      tableParsedSource = null;
      sheet.innerHTML = `<div class="tree-empty">${viewLanguageIsZh() ? "文档不是有效 JSON。修复语法后查看表格。" : "The document is not valid JSON. Fix the syntax to inspect its tables."}</div>${inspector}`;
      if (countEl) countEl.textContent = viewLanguageIsZh() ? "JSON 无效" : "Invalid JSON";
      return;
    }
  }
  const scroll = document.querySelector<HTMLElement>(".table-view .table-scroll");
  const previousScrollTop = scroll?.scrollTop ?? 0;
  const parts: string[] = [];
  let sections = 0;
  let rows = 0;
  let visibleRows = 0;
  const push = (result: TableSectionResult) => {
    if (!result.html) return;
    parts.push(result.html);
    sections += 1;
    rows += result.totalRows;
    visibleRows += result.visibleRows;
  };
  if (Array.isArray(value)) {
    push(renderArraySection("$", value, "$"));
  } else if (isPlainObject(value)) {
    const scalars: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (sections >= 24) break;
      const childPath = treePathFor("$", key, false);
      if (Array.isArray(item)) {
        push(renderArraySection(key, item, childPath));
      } else if (isPlainObject(item) && Object.keys(item).length <= 120) {
        push(renderObjectSection(key, item, childPath));
      } else {
        scalars[key] = item;
      }
    }
    if (Object.keys(scalars).length || sections === 0) {
      push(renderObjectSection("$", scalars, "$", "root"));
    }
  } else {
    push(renderObjectSection("$", { value }, "$", "root"));
  }
  sheet.innerHTML = parts.join("") + inspector;
  try {
    w.closeTableColumns?.();
  } catch {
    // The column menu may not be open.
  }
  tableMeta.sections = sections;
  tableMeta.rows = rows;
  tableMeta.visibleRows = visibleRows;
  tableMeta.visibleSections = sections;
  hydrateVirtualTables(sheet);
  bindVirtualTableScroll();
  if (scroll) scroll.scrollTop = previousScrollTop;
  updateVirtualTableWindows(true);
  updateTableCount(tableFilterQuery);
}

function scheduleTableRender(delay = 160): void {
  if (!tableInstalled) return;
  if (tableRenderTimer !== null) window.clearTimeout(tableRenderTimer);
  tableRenderTimer = window.setTimeout(() => {
    tableRenderTimer = null;
    try {
      if (evalGlobal<string>("app.dataset.view") === "table") renderTableData();
    } catch {
      // The app may be closing.
    }
  }, delay);
}

let statusChromeInstalled = false;

function installStatusChrome(): void {
  if (statusChromeInstalled) return;
  statusChromeInstalled = true;
  const originalApplyGraphScale = w.applyGraphScale;
  if (typeof originalApplyGraphScale === "function") {
    w.applyGraphScale = (...args: unknown[]) => {
      originalApplyGraphScale(...args);
      updateStatusZoom();
    };
  }
  updateStatusZoom();
}

function installTableData(): void {
  if (tableInstalled) return;
  tableInstalled = true;
  const originalSetView = w.setView;
  w.setView = (view: string) => {
    originalSetView(view);
    if (view === "table") renderTableData();
  };
  w.filterTableRows = (query: string) => {
    tableFilterQuery = String(query ?? "");
    renderTableData();
  };
  renderTableData();
  bindVirtualTableScroll();
}

/* ------------------------------------------------------------
   Data-driven graph view
   ------------------------------------------------------------ */

interface GraphRowModel {
  key: string;
  value: unknown;
  childId?: string;
}

interface GraphNodeModel {
  id: string;
  key: string;
  value: unknown;
  type: string;
  rows: GraphRowModel[];
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
}

interface GraphEdgeModel {
  from: string;
  to: string;
  rowIndex: number;
}

interface GraphModel {
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
}

let buddyGraphModel: GraphModel | null = null;
let buddyGraphLayout: "horizontal" | "vertical" = "horizontal";
let graphInstalled = false;
let graphRenderTimer: number | null = null;

function graphNodeHeight(rows: number): number {
  return 31 + rows * 22;
}

function graphNodeHtml(node: GraphNodeModel, selected: boolean): string {
  const count = Array.isArray(node.value)
    ? (node.value as unknown[]).length
    : isPlainObject(node.value)
      ? Object.keys(node.value).length
      : 0;
  let rows = "";
  node.rows.forEach((row) => {
    const type = treeTypeOf(row.value);
    let valueHtml = "";
    if (row.childId) {
      valueHtml = `<span class="v type">${
        Array.isArray(row.value)
          ? `[${(row.value as unknown[]).length}]`
          : `{${isPlainObject(row.value) ? Object.keys(row.value).length : 0}}`
      }</span><i class="port"></i>`;
    } else if (Array.isArray(row.value)) {
      valueHtml = `<span class="v type">[${(row.value as unknown[]).length}]</span>`;
    } else if (isPlainObject(row.value)) {
      valueHtml = `<span class="v type">{${Object.keys(row.value).length}}</span>`;
    } else {
      const className =
        type === "string"
          ? "str"
          : type === "number"
            ? "num"
            : type === "boolean"
              ? "bool"
              : "nul";
      valueHtml = `<span class="v ${className}">${w.escHtml(
        treePreview(row.value, 40)
      )}</span>`;
    }
    rows += `<div class="node-row"><span class="k">${w.escHtml(
      row.key
    )}</span>${valueHtml}</div>`;
  });
  return `<div class="node${selected ? " sel" : ""}" data-graph-id="${
    node.id
  }" style="left:${node.x}px;top:${node.y}px;width:${node.width}px" onclick="selectNode(this)">
    <div class="node-head">
      <svg class="i xs chev" viewBox="0 0 24 24"><use href="#i-chev-down"/></svg>
      <span class="name">${w.escHtml(node.key)}</span>
      <span class="node-type">${node.type}</span>
      <span class="node-count">${count}</span>
    </div>
    ${rows}
  </div>`;
}

function buildGraphModel(root: unknown): GraphModel {
  const model: GraphModel = { nodes: [], edges: [] };
  const addNode = (
    key: string,
    value: unknown,
    parentId?: string,
    parentRow?: number
  ): GraphNodeModel | null => {
    if (model.nodes.length >= 12) return null;
    const node: GraphNodeModel = {
      id: `g${model.nodes.length}`,
      key,
      value,
      type: Array.isArray(value) ? "array" : isPlainObject(value) ? "object" : treeTypeOf(value),
      rows: [],
      x: 0,
      y: 0,
      width: parentId ? 180 : 188,
      height: 0,
      parentId
    };
    node.height = graphNodeHeight(0);
    model.nodes.push(node);
    if (parentId && parentRow !== undefined) {
      model.edges.push({ from: parentId, to: node.id, rowIndex: parentRow });
    }
    return node;
  };
  const addRows = (node: GraphNodeModel, entries: [string, unknown][], depth: number) => {
    const visible = entries.slice(0, 7);
    visible.forEach(([name, child]) => {
      const row: GraphRowModel = { key: name, value: child };
      if (
        depth < 2 &&
        (Array.isArray(child) || isPlainObject(child)) &&
        model.nodes.length < 12
      ) {
        const childNode = addNode(
          depth === 0 ? name : `${node.key}[${name}]`,
          child,
          node.id,
          node.rows.length
        );
        if (childNode) {
          row.childId = childNode.id;
          if (depth === 0 && Array.isArray(child)) {
            addRows(
              childNode,
              (child as unknown[]).slice(0, 7).map((item, index) => [String(index), item]),
              1
            );
          } else if (depth < 2) {
            const nestedEntries = Array.isArray(child)
              ? (child as unknown[]).slice(0, 7).map((item, index) => [String(index), item])
              : Object.entries(child).slice(0, 7);
            addRows(childNode, nestedEntries as [string, unknown][], depth + 1);
          }
        }
      }
      node.rows.push(row);
    });
    node.height = graphNodeHeight(node.rows.length);
  };
  const rootNode = addNode("root", root);
  if (rootNode) {
    const entries = Array.isArray(root)
      ? (root as unknown[]).slice(0, 7).map((item, index) => [String(index), item])
      : isPlainObject(root)
        ? Object.entries(root).slice(0, 7)
        : [["value", root]];
    addRows(rootNode, entries as [string, unknown][], 0);
  }
  return model;
}

function layoutBuddyGraph(model: GraphModel, vertical: boolean): void {
  const root = model.nodes.find((node) => !node.parentId);
  if (!root) return;
  const depthOne = model.nodes.filter((node) => node.parentId === root.id);
  const depthTwo = model.nodes.filter(
    (node) =>
      node.parentId &&
      node.parentId !== root.id &&
      depthOne.some((parent) => parent.id === node.parentId)
  );
  const gap = 26;
  if (!vertical) {
    root.x = 20;
    const stackHeight = depthOne.reduce(
      (sum, node, index) => sum + node.height + (index ? gap : 0),
      0
    );
    root.y = Math.max(30, 34 + (stackHeight - root.height) / 2);
    let y = 34;
    for (const node of depthOne) {
      node.x = 250;
      node.y = y;
      y += node.height + gap;
    }
    let childY = 34;
    for (const node of depthTwo) {
      node.x = 448;
      node.y = childY;
      childY += node.height + gap;
    }
  } else {
    root.x = 20;
    root.y = 20;
    let y = root.height + 70;
    for (const node of depthOne) {
      node.x = 20;
      node.y = y;
      y += node.height + gap;
    }
    let childY = y + 30;
    for (const node of depthTwo) {
      node.x = 250;
      node.y = childY;
      childY += node.height + gap;
    }
  }
}

function renderBuddyGraphEdges(): void {
  const scene = document.querySelector(".graph-scene");
  const svg = scene?.querySelector(".edges");
  if (!scene || !svg || !buddyGraphModel) return;
  const width = Math.max(
    627,
    ...buddyGraphModel.nodes.map((node) => node.x + node.width + 30)
  );
  const height = Math.max(
    360,
    ...buddyGraphModel.nodes.map((node) => node.y + node.height + 30)
  );
  (scene as HTMLElement).style.width = `${width}px`;
  (scene as HTMLElement).style.height = `${height}px`;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const byId = new Map(buddyGraphModel.nodes.map((node) => [node.id, node]));
  svg.innerHTML = buddyGraphModel.edges
    .map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return "";
      const startX = from.x + from.width;
      const startY = from.y + 29 + edge.rowIndex * 22 + 11;
      const endX = to.x;
      const endY = to.y + 18;
      const bend = Math.max(32, (endX - startX) / 2);
      return `<path d="M ${startX} ${startY} C ${startX + bend} ${startY}, ${
        endX - bend
      } ${endY}, ${endX} ${endY}" />`;
    })
    .join("");
}

function renderBuddyGraphMinimap(): void {
  const canvas = document.querySelector(".mm-canvas");
  if (!canvas || !buddyGraphModel) return;
  canvas.querySelectorAll(".mm-node").forEach((node) => node.remove());
  const scene = document.querySelector(".graph-scene") as HTMLElement | null;
  if (!scene) return;
  const width = parseFloat(scene.style.width) || 627;
  const height = parseFloat(scene.style.height) || 790;
  const scaleX = 128 / Math.max(1, width);
  const scaleY = 60 / Math.max(1, height);
  for (const node of buddyGraphModel.nodes) {
    const block = document.createElement("div");
    block.className = "mm-node";
    block.style.left = `${3 + node.x * scaleX}px`;
    block.style.top = `${3 + node.y * scaleY}px`;
    block.style.width = `${Math.max(4, node.width * scaleX)}px`;
    block.style.height = `${Math.max(3, node.height * scaleY)}px`;
    canvas.appendChild(block);
  }
}

function applyBuddyGraphLayout(): void {
  if (!buddyGraphModel) return;
  layoutBuddyGraph(buddyGraphModel, buddyGraphLayout === "vertical");
  const scene = document.querySelector(".graph-scene");
  if (!scene) return;
  scene.querySelectorAll<HTMLElement>(".node").forEach((element) => {
    const id = element.dataset.graphId;
    const node = buddyGraphModel?.nodes.find((item) => item.id === id);
    if (!node) return;
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
  });
  renderBuddyGraphEdges();
  renderBuddyGraphMinimap();
}

function renderGraphData(): void {
  const scene = document.querySelector(".graph-scene");
  if (!scene) return;
  const doc = currentDoc();
  const source = doc?.text ?? "";
  if (!source.trim()) {
    scene.innerHTML =
      `<div class="tree-empty" style="position:absolute;left:24px;top:56px">${viewLanguageIsZh() ? "打开 JSON 文档以查看图形。" : "Open a JSON document to inspect its graph."}</div>`;
    buddyGraphModel = null;
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    scene.innerHTML =
      `<div class="tree-empty" style="position:absolute;left:24px;top:56px">${viewLanguageIsZh() ? "文档不是有效 JSON。修复语法后查看图形。" : "The document is not valid JSON. Fix the syntax to inspect the graph."}</div>`;
    buddyGraphModel = null;
    return;
  }
  const model = buildGraphModel(value);
  buddyGraphModel = model;
  layoutBuddyGraph(model, buddyGraphLayout === "vertical");
  scene.innerHTML = `<svg class="edges" viewBox="0 0 627 790" preserveAspectRatio="xMinYMin meet" aria-hidden="true"></svg>${model.nodes
    .map((node, index) => graphNodeHtml(node, index === 0))
    .join("")}`;
  renderBuddyGraphEdges();
  renderBuddyGraphMinimap();
  try {
    w.applyGraphScale?.();
  } catch {
    // Scaling is owned by the prototype.
  }
}

function scheduleGraphRender(delay = 200): void {
  if (!graphInstalled) return;
  if (graphRenderTimer !== null) window.clearTimeout(graphRenderTimer);
  graphRenderTimer = window.setTimeout(() => {
    graphRenderTimer = null;
    try {
      const view = evalGlobal<string>("app.dataset.view");
      if (view === "graph" || view === "split") renderGraphData();
    } catch {
      // The app may be closing.
    }
  }, delay);
}

function installGraphData(): void {
  if (graphInstalled) return;
  graphInstalled = true;
  const originalSetView = w.setView;
  w.setView = (view: string) => {
    originalSetView(view);
    if (view === "graph" || view === "split") renderGraphData();
  };
  w.toggleGraphLayout = () => {
    buddyGraphLayout = buddyGraphLayout === "horizontal" ? "vertical" : "horizontal";
    w.setText?.(
      "graphLayoutLabel",
      buddyGraphLayout === "vertical" ? "Vertical" : "Horizontal"
    );
    applyBuddyGraphLayout();
  };
  const scene = document.querySelector(".graph-scene");
  if (scene) {
    scene.addEventListener("pointerdown", (event) => {
      const pointer = event as PointerEvent;
      if (pointer.button !== 0) return;
      const target = (pointer.target as HTMLElement | null)?.closest<HTMLElement>(".node");
      if (!target || !buddyGraphModel) return;
      let locked = false;
      try {
        locked = evalGlobal<boolean>("graphLocked");
      } catch {
        locked = false;
      }
      if (locked) return;
      const node = buddyGraphModel.nodes.find((item) => item.id === target.dataset.graphId);
      if (!node) return;
      const startX = pointer.clientX;
      const startY = pointer.clientY;
      const originX = node.x;
      const originY = node.y;
      const scale =
        (scene.getBoundingClientRect().width || 1) / (scene as HTMLElement).offsetWidth;
      const move = (moveEvent: PointerEvent) => {
        if (!buddyGraphModel) return;
        node.x = originX + (moveEvent.clientX - startX) / (scale || 1);
        node.y = originY + (moveEvent.clientY - startY) / (scale || 1);
        target.style.left = `${node.x}px`;
        target.style.top = `${node.y}px`;
        renderBuddyGraphEdges();
        renderBuddyGraphMinimap();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    });
  }
  renderGraphData();
}

/* ------------------------------------------------------------
   JSON-driven code generation
   ------------------------------------------------------------ */

type CgKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "unknown"
  | "null"
  | "array"
  | "object"
  | "union";

interface CgField {
  key: string;
  type: CgType;
  required: boolean;
}

interface CgObject {
  name: string;
  fields: CgField[];
}

interface CgType {
  kind: CgKind;
  item?: CgType;
  object?: CgObject;
  types?: CgType[];
  nullable?: boolean;
}

interface CgContext {
  objects: CgObject[];
  names: Set<string>;
}

interface GeneratedCode {
  code: string;
  file: string;
  rootName: string;
  types: number;
  records: number;
  rootLabel: string;
}

let buddyGenerated: GeneratedCode | null = null;
let codegenInstalled = false;
let codegenTimer: number | null = null;

function cgWords(value: string): string[] {
  return String(value)
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function cgPascal(value: string): string {
  const words = cgWords(value);
  return (
    words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("") ||
    "Nested"
  );
}

function cgCamel(value: string): string {
  const pascal = cgPascal(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function cgSnake(value: string): string {
  return cgWords(value)
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join("_");
}

function cgKebab(value: string): string {
  return cgWords(value)
    .map((word) => word.toLowerCase())
    .join("-");
}

function cgSingular(value: string): string {
  const lower = value.toLowerCase();
  const irregular: Record<string, string> = {
    movies: "movie",
    cookies: "cookie",
    zombies: "zombie",
    ties: "tie",
    pies: "pie",
    lies: "lie",
    series: "series",
    species: "species"
  };
  if (irregular[lower]) {
    const base = irregular[lower];
    return value.charAt(0).toUpperCase() + base.slice(1);
  }
  if (/ies$/i.test(value)) return `${value.slice(0, -3)}y`;
  if (/(ss|x|ch|sh)$/i.test(value)) return value;
  if (/s$/i.test(value)) return value.slice(0, -1);
  return value;
}

function cgUnique(ctx: CgContext, base: string): string {
  let candidate = base || "Nested";
  let index = 2;
  while (ctx.names.has(candidate)) {
    candidate = `${base}${index}`;
    index += 1;
  }
  ctx.names.add(candidate);
  return candidate;
}

function cgCloneType(type: CgType): CgType {
  return {
    kind: type.kind,
    nullable: type.nullable,
    item: type.item ? cgCloneType(type.item) : undefined,
    object: type.object
      ? {
          name: type.object.name,
          fields: type.object.fields.map((field) => ({
            key: field.key,
            required: field.required,
            type: cgCloneType(field.type)
          }))
        }
      : undefined,
    types: type.types?.map(cgCloneType)
  };
}

function cgMergeSchemas(target: CgObject, source: CgObject, ctx: CgContext): void {
  const sourceKeys = new Set(source.fields.map((field) => field.key));
  for (const field of target.fields) {
    if (!sourceKeys.has(field.key)) field.required = false;
  }
  const first = target.fields.length === 0;
  for (const field of source.fields) {
    const existing = target.fields.find((item) => item.key === field.key);
    if (existing) {
      existing.required = existing.required && field.required;
      existing.type = cgMerge(existing.type, field.type, ctx);
    } else {
      target.fields.push({
        key: field.key,
        required: first ? field.required : false,
        type: cgCloneType(field.type)
      });
    }
  }
}

function cgMergeUnion(left: CgType, right: CgType): CgType {
  const types = [...(left.types ?? []), ...(right.kind === "union" ? right.types ?? [] : [right])];
  const merged: CgType[] = [];
  for (const item of types) {
    const existing = merged.find(
      (candidate) =>
        candidate.kind === item.kind &&
        (candidate.kind !== "object" || candidate.object?.name === item.object?.name)
    );
    if (!existing) merged.push(cgCloneType(item));
    else {
      existing.nullable = existing.nullable || item.nullable;
      if (existing.kind === "array" && existing.item && item.item) {
        existing.item = cgMerge(existing.item, item.item, {
          objects: [],
          names: new Set()
        });
      }
    }
  }
  return { kind: "union", types: merged, nullable: left.nullable || right.nullable };
}

function cgMerge(left: CgType, right: CgType, ctx: CgContext): CgType {
  if (left.kind === "null") {
    const clone = cgCloneType(right);
    clone.nullable = true;
    return clone;
  }
  if (right.kind === "null") {
    const clone = cgCloneType(left);
    clone.nullable = true;
    return clone;
  }
  if (left.kind === "unknown") {
    const clone = cgCloneType(right);
    clone.nullable = clone.nullable || left.nullable;
    return clone;
  }
  if (right.kind === "unknown") {
    const clone = cgCloneType(left);
    clone.nullable = clone.nullable || right.nullable;
    return clone;
  }
  if (left.kind === "union") return cgMergeUnion(left, right);
  if (right.kind === "union") return cgMergeUnion(right, left);
  if (
    (left.kind === "number" || left.kind === "integer") &&
    (right.kind === "number" || right.kind === "integer")
  ) {
    if (left.kind === "integer" && right.kind === "integer") {
      return { kind: "integer", nullable: left.nullable || right.nullable };
    }
    return { kind: "number", nullable: left.nullable || right.nullable };
  }
  if (left.kind === right.kind) {
    if (left.kind === "object" && left.object && right.object) {
      cgMergeSchemas(left.object, right.object, ctx);
      left.nullable = left.nullable || right.nullable;
      return left;
    }
    if (left.kind === "array" && left.item && right.item) {
      left.item = cgMerge(left.item, right.item, ctx);
      left.nullable = left.nullable || right.nullable;
      return left;
    }
    left.nullable = left.nullable || right.nullable;
    return left;
  }
  return { kind: "union", types: [left, right] };
}

function cgInfer(value: unknown, hint: string, ctx: CgContext): CgType {
  if (value === null) return { kind: "unknown", nullable: true };
  if (Array.isArray(value)) {
    if (!value.length) return { kind: "array", item: { kind: "unknown" } };
    if (value.every(isPlainObject)) {
      const name = cgUnique(ctx, cgSingular(cgPascal(hint)));
      const object: CgObject = { name, fields: [] };
      ctx.objects.push(object);
      for (const item of value) {
        cgMergeSchemas(object, cgInferObjectSchema(item, ctx), ctx);
      }
      return { kind: "array", item: { kind: "object", object } };
    }
    let item = cgInfer(value[0], hint, ctx);
    for (const entry of value.slice(1)) {
      item = cgMerge(item, cgInfer(entry, hint, ctx), ctx);
    }
    return { kind: "array", item };
  }
  if (isPlainObject(value)) {
    const name = cgUnique(ctx, cgPascal(hint));
    const object: CgObject = { name, fields: [] };
    ctx.objects.push(object);
    cgMergeSchemas(object, cgInferObjectSchema(value, ctx), ctx);
    return { kind: "object", object };
  }
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "number") {
    return { kind: Number.isInteger(value) ? "integer" : "number" };
  }
  if (typeof value === "boolean") return { kind: "boolean" };
  return { kind: "unknown" };
}

function cgInferObjectSchema(
  value: Record<string, unknown>,
  ctx: CgContext
): CgObject {
  const object: CgObject = { name: "Nested", fields: [] };
  for (const [key, item] of Object.entries(value)) {
    object.fields.push({
      key,
      required: true,
      type: cgInfer(item, key, ctx)
    });
  }
  return object;
}

function cgOrderedObjects(ctx: CgContext): CgObject[] {
  const byName = new Map(ctx.objects.map((object) => [object.name, object]));
  const visited = new Set<string>();
  const output: CgObject[] = [];
  const collect = (type: CgType): string[] => {
    const names: string[] = [];
    if (type.kind === "object" && type.object) names.push(type.object.name);
    if (type.kind === "array" && type.item) names.push(...collect(type.item));
    if (type.kind === "union" && type.types) {
      for (const item of type.types) names.push(...collect(item));
    }
    return names;
  };
  const visit = (name: string) => {
    if (visited.has(name)) return;
    const object = byName.get(name);
    if (!object) return;
    visited.add(name);
    for (const field of object.fields) {
      for (const dependency of collect(field.type)) visit(dependency);
    }
    output.push(object);
  };
  for (const object of ctx.objects) visit(object.name);
  return output;
}

const CG_KEYWORDS = new Set([
  "class",
  "interface",
  "struct",
  "type",
  "public",
  "private",
  "default",
  "new",
  "return",
  "import",
  "package",
  "func",
  "var",
  "let",
  "const",
  "null",
  "true",
  "false",
  "in",
  "is",
  "as",
  "object",
  "string",
  "number"
]);

function cgIdentifier(value: string, style: "pascal" | "camel" | "snake"): string {
  let name =
    style === "pascal" ? cgPascal(value) : style === "camel" ? cgCamel(value) : cgSnake(value);
  if (!name) name = "field";
  if (/^[0-9]/.test(name)) name = `_${name}`;
  if (CG_KEYWORDS.has(name.toLowerCase())) name = `${name}_`;
  return name;
}

function cgTypeBase(type: CgType, lang: string, nullable = false): string {
  const primitive = (names: {
    string: string;
    integer: string;
    number: string;
    boolean: string;
    unknown: string;
    null: string;
  }) => {
    switch (type.kind) {
      case "string":
        return names.string;
      case "integer":
        return names.integer;
      case "number":
        return names.number;
      case "boolean":
        return names.boolean;
      case "unknown":
        return names.unknown;
      case "null":
        return names.null;
      default:
        return "";
    }
  };
  const prim = primitive(
    lang === "typescript" || lang === "javascript"
      ? { string: "string", integer: "number", number: "number", boolean: "boolean", unknown: "unknown", null: "null" }
      : lang === "go"
        ? { string: "string", integer: "int64", number: "float64", boolean: "bool", unknown: "interface{}", null: "interface{}" }
        : lang === "rust"
          ? { string: "String", integer: "i64", number: "f64", boolean: "bool", unknown: "serde_json::Value", null: "serde_json::Value" }
          : lang === "python"
            ? { string: "str", integer: "int", number: "float", boolean: "bool", unknown: "Any", null: "None" }
            : lang === "java"
              ? { string: "String", integer: "Long", number: "Double", boolean: "Boolean", unknown: "Object", null: "Object" }
              : lang === "csharp"
                ? { string: "string", integer: "long", number: "double", boolean: "bool", unknown: "object", null: "object" }
                : lang === "swift"
                  ? { string: "String", integer: "Int", number: "Double", boolean: "Bool", unknown: "JSONValue", null: "JSONValue" }
                  : lang === "kotlin"
                    ? { string: "String", integer: "Long", number: "Double", boolean: "Boolean", unknown: "Any", null: "Any" }
                    : lang === "php"
                      ? { string: "string", integer: "int", number: "float", boolean: "bool", unknown: "mixed", null: "mixed" }
                      : { string: "String", integer: "int", number: "double", boolean: "bool", unknown: "dynamic", null: "dynamic" }
  );
  if (prim) {
    if (!type.nullable && !nullable) return prim;
    switch (lang) {
      case "typescript":
      case "javascript":
        return `${prim} | null`;
      case "go":
        return prim === "interface{}" ? prim : `*${prim}`;
      case "rust":
        return `Option<${prim}>`;
      case "python":
        return `Optional[${prim}]`;
      case "java":
        return prim;
      case "csharp":
        return `${prim}?`;
      case "swift":
      case "kotlin":
      case "php":
        return prim === "mixed" ? prim : `?${prim}`;
      case "dart":
        return prim === "dynamic" ? prim : `${prim}?`;
      default:
        return prim;
    }
  }
  if (type.kind === "object") return type.object?.name ?? "Nested";
  if (type.kind === "array") {
    const inside = type.item ? cgTypeBase(type.item, lang, false) : "unknown";
    const wrapped =
      lang === "go"
        ? `[]${inside}`
        : lang === "rust"
          ? `Vec<${inside}>`
          : lang === "python"
            ? `List[${inside}]`
            : lang === "java" || lang === "csharp" || lang === "kotlin"
              ? `List<${inside}>`
              : lang === "swift"
                ? `[${inside}]`
                : lang === "php"
                  ? "array"
                  : lang === "dart"
                    ? `List<${inside}>`
                    : `${inside.includes(" | ") ? `(${inside})` : inside}[]`;
    if (!type.nullable && !nullable) return wrapped;
    switch (lang) {
      case "typescript":
      case "javascript":
        return `${wrapped} | null`;
      case "go":
        return `*${wrapped}`;
      case "rust":
        return `Option<${wrapped}>`;
      case "python":
        return `Optional[${wrapped}]`;
      case "csharp":
      case "swift":
      case "kotlin":
        return `${wrapped}?`;
      case "php":
        return `?${wrapped}`;
      case "dart":
        return `${wrapped}?`;
      default:
        return wrapped;
    }
  }
  if (type.kind === "union") {
    if (lang === "typescript" || lang === "javascript") {
      return (type.types ?? []).map((item) => cgTypeBase(item, lang)).join(" | ");
    }
    if (lang === "python") {
      return `Union[${(type.types ?? []).map((item) => cgTypeBase(item, lang)).join(", ")}]`;
    }
    if (lang === "rust") return "serde_json::Value";
    if (lang === "go") return "interface{}";
    if (lang === "swift") return "JSONValue";
    if (lang === "kotlin") return "Any";
    return "object";
  }
  return "unknown";
}

function cgTsType(type: CgType): string {
  return cgTypeBase(type, "typescript");
}

function cgJsDocType(type: CgType): string {
  const base = cgTypeBase(
    { ...type, nullable: false },
    "javascript"
  );
  return type.nullable ? `${base}|null` : base;
}

function cgObjectFields(
  object: CgObject,
  nameStyle: (key: string) => string
): { field: CgField; name: string }[] {
  const used = new Set<string>();
  return object.fields.map((field) => {
    let name = nameStyle(field.key);
    let index = 2;
    while (used.has(name)) {
      name = `${nameStyle(field.key)}${index}`;
      index += 1;
    }
    used.add(name);
    return { field, name };
  });
}

function generateTypeScript(
  objects: CgObject[],
  root: CgType,
  rootName: string,
  sourceName: string,
  javascript: boolean
): string {
  if (javascript) {
    const lines = [`// Generated from ${sourceName}`, ""];
    for (const object of objects) {
      lines.push("/**", ` * @typedef {Object} ${object.name}`);
      for (const field of object.fields) {
        const optional = field.required ? "" : "[";
        const close = field.required ? "" : "]";
        lines.push(
          ` * @property {${cgJsDocType(field.type)}} ${optional}${field.key}${close}`
        );
      }
      lines.push(" */", "");
    }
    if (root.kind !== "object" || root.object?.name !== rootName) {
      lines.push(`/** @typedef {${cgJsDocType(root)}} ${rootName} */`, "");
    }
    lines.push("export {};");
    return lines.join("\n");
  }
  const lines = [`// Generated from ${sourceName}`, ""];
  for (const object of objects) {
    lines.push(`export interface ${object.name} {`);
    for (const field of cgObjectFields(object, (key) =>
      /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
    )) {
      const optional = field.field.required ? "" : "?";
      lines.push(`  ${field.name}${optional}: ${cgTsType(field.field.type)};`);
    }
    lines.push("}", "");
  }
  if (root.kind !== "object" || root.object?.name !== rootName) {
    lines.push(`export type ${rootName} = ${cgTsType(root)};`);
  }
  return lines.join("\n").trimEnd();
}

function generateGo(objects: CgObject[], root: CgType, rootName: string, sourceName: string): string {
  const lines = [`// Generated from ${sourceName}`, "", "package models", ""];
  for (const object of objects) {
    lines.push(`type ${object.name} struct {`);
    for (const field of cgObjectFields(object, (key) => cgIdentifier(key, "pascal"))) {
      const base = cgTypeBase({ ...field.field.type, nullable: false }, "go");
      const nullable = field.field.type.nullable;
      const type = nullable && base !== "interface{}" ? `*${base}` : base;
      const tag = `json:"${field.field.key}${field.field.required ? "" : ",omitempty"}"`;
      lines.push(`\t${field.name} ${type} \`${tag}\``);
    }
    lines.push("}", "");
  }
  if (root.kind !== "object" || root.object?.name !== rootName) {
    lines.push(`type ${rootName} = ${cgTypeBase(root, "go")}`, "");
  }
  return lines.join("\n").trimEnd();
}

function generateRust(objects: CgObject[], root: CgType, rootName: string, sourceName: string): string {
  const lines = [
    `// Generated from ${sourceName}`,
    "",
    "use serde::{Deserialize, Serialize};",
    ""
  ];
  for (const object of objects) {
    lines.push("#[derive(Clone, Debug, Serialize, Deserialize)]");
    lines.push(`pub struct ${object.name} {`);
    for (const field of cgObjectFields(object, (key) => cgIdentifier(key, "snake"))) {
      const base = cgTypeBase({ ...field.field.type, nullable: false }, "rust");
      const optional = !field.field.required;
      const type =
        field.field.type.nullable || optional ? `Option<${base}>` : base;
      if (field.name !== field.field.key) {
        lines.push(`    #[serde(rename = "${field.field.key}")]`);
      }
      if (optional) {
        lines.push(`    #[serde(skip_serializing_if = "Option::is_none")]`);
      }
      lines.push(`    pub ${field.name}: ${type},`);
    }
    lines.push("}", "");
  }
  if (root.kind !== "object" || root.object?.name !== rootName) {
    lines.push(`pub type ${rootName} = ${cgTypeBase(root, "rust")};`, "");
  }
  return lines.join("\n").trimEnd();
}

function generatePython(objects: CgObject[], root: CgType, rootName: string, sourceName: string): string {
  const lines = [
    `# Generated from ${sourceName}`,
    "from dataclasses import dataclass",
    "from typing import Any, List, Optional, Union",
    ""
  ];
  for (const object of objects) {
    lines.push("@dataclass", `class ${object.name}:`);
    const fields = cgObjectFields(object, (key) => cgIdentifier(key, "snake"));
    const required = fields.filter(
      (field) => field.field.required && !field.field.type.nullable
    );
    const optional = fields.filter(
      (field) => !field.field.required || field.field.type.nullable
    );
    const rows = [...required, ...optional];
    if (!rows.length) lines.push("    pass");
    for (const field of rows) {
      const isOptional = !field.field.required || field.field.type.nullable;
      const base = cgTypeBase({ ...field.field.type, nullable: false }, "python");
      lines.push(
        `    ${field.name}: ${isOptional ? `Optional[${base}] = None` : base}`
      );
    }
    lines.push("");
  }
  if (root.kind !== "object" || root.object?.name !== rootName) {
    lines.push(`${rootName} = ${cgTypeBase(root, "python")}`, "");
  }
  return lines.join("\n").trimEnd();
}

function generateJava(objects: CgObject[], root: CgType, rootName: string, sourceName: string): string {
  const lines = [
    `// Generated from ${sourceName}`,
    "import java.util.ArrayList;",
    "import java.util.List;",
    "import java.util.Optional;",
    ""
  ];
  for (const object of objects) {
    lines.push(`class ${object.name} {`);
    for (const field of cgObjectFields(object, (key) => cgIdentifier(key, "camel"))) {
      const base = cgTypeBase({ ...field.field.type, nullable: false }, "java");
      if (field.field.required) {
        lines.push(`    public ${base} ${field.name};`);
      } else {
        lines.push(`    public Optional<${base}> ${field.name} = Optional.empty();`);
      }
    }
    lines.push("}", "");
  }
  if (root.kind !== "object" || root.object?.name !== rootName) {
    if (root.kind === "array" && root.item) {
      lines.push(`class ${rootName} extends ArrayList<${cgTypeBase(root.item, "java")}> {`, "}");
    } else {
      lines.push(`class ${rootName} {`);
      lines.push(`    public ${cgTypeBase(root, "java")} value;`);
      lines.push("}");
    }
  }
  return lines.join("\n").trimEnd();
}

function generateCSharp(objects: CgObject[], root: CgType, rootName: string, sourceName: string): string {
  const lines = [
    `// Generated from ${sourceName}`,
    "using System.Collections.Generic;",
    ""
  ];
  for (const object of objects) {
    lines.push(`public class ${object.name}`, "{");
    for (const field of cgObjectFields(object, (key) => cgIdentifier(key, "pascal"))) {
      const nullable = !field.field.required || field.field.type.nullable;
      const base = cgTypeBase({ ...field.field.type, nullable: false }, "csharp");
      lines.push(`    public ${base}${nullable ? "?" : ""} ${field.name} { get; set; }`);
    }
    lines.push("}", "");
  }
  if (root.kind !== "object" || root.object?.name !== rootName) {
    if (root.kind === "array" && root.item) {
      lines.push(
        `public class ${rootName} : List<${cgTypeBase(root.item, "csharp")}> { }`
      );
    } else {
      lines.push(`public class ${rootName}`, "{");
      lines.push(`    public ${cgTypeBase(root, "csharp")} Value { get; set; }`);
      lines.push("}");
    }
  }
  return lines.join("\n").trimEnd();
}

function generateSwift(objects: CgObject[], root: CgType, rootName: string, sourceName: string): string {
  const lines = [`// Generated from ${sourceName}`, "import Foundation", ""];
  let usesJSONValue = false;
  const swiftType = (type: CgType, optional: boolean) => {
    const base = cgTypeBase({ ...type, nullable: false }, "swift");
    if (base === "JSONValue") usesJSONValue = true;
    return type.nullable || optional ? `${base}?` : base;
  };
  for (const object of objects) {
    lines.push(`struct ${object.name}: Codable {`);
    const fields = cgObjectFields(object, (key) => cgIdentifier(key, "camel"));
    for (const field of fields) {
      lines.push(
        `    let ${field.name}: ${swiftType(
          field.field.type,
          !field.field.required
        )}`
      );
    }
    const needsCodingKeys = fields.some((field) => field.name !== field.field.key);
    if (needsCodingKeys) {
      lines.push("", "    enum CodingKeys: String, CodingKey {");
      for (const field of fields) {
        lines.push(
          `        case ${field.name} = "${field.field.key}"`
        );
      }
      lines.push("    }");
    }
    lines.push("}", "");
  }
  if (root.kind !== "object" || root.object?.name !== rootName) {
    lines.push(`typealias ${rootName} = ${cgTypeBase(root, "swift")}`, "");
  }
  if (usesJSONValue) {
    lines.push(
      "enum JSONValue: Codable {",
      "    case string(String), number(Double), bool(Bool), null, array([JSONValue]), object([String: JSONValue])",
      "    init(from decoder: Decoder) throws {",
      "        let container = try decoder.singleValueContainer()",
      "        if let value = try? container.decode(String.self) { self = .string(value) }",
      "        else if let value = try? container.decode(Double.self) { self = .number(value) }",
      "        else if let value = try? container.decode(Bool.self) { self = .bool(value) }",
      "        else if container.decodeNil() { self = .null }",
      "        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }",
      "        else { self = .object(try container.decode([String: JSONValue].self)) }",
      "    }",
      "    func encode(to encoder: Encoder) throws {",
      "        var container = encoder.singleValueContainer()",
      "        switch self {",
      "        case .string(let value): try container.encode(value)",
      "        case .number(let value): try container.encode(value)",
      "        case .bool(let value): try container.encode(value)",
      "        case .null: try container.encodeNil()",
      "        case .array(let value): try container.encode(value)",
      "        case .object(let value): try container.encode(value)",
      "        }",
      "    }",
      "}",
      ""
    );
  }
  return lines.join("\n").trimEnd();
}

function generateKotlin(objects: CgObject[], root: CgType, rootName: string, sourceName: string): string {
  const lines = [`// Generated from ${sourceName}`, ""];
  for (const object of objects) {
    const fields = cgObjectFields(object, (key) => cgIdentifier(key, "camel"));
    if (!fields.length) {
      lines.push(`class ${object.name}`, "");
      continue;
    }
    lines.push(`data class ${object.name}(`);
    fields.forEach((field, index) => {
      const nullable = !field.field.required || field.field.type.nullable;
      const base = cgTypeBase({ ...field.field.type, nullable: false }, "kotlin");
      const suffix = nullable ? "? = null" : "";
      lines.push(
        `    val ${field.name}: ${base}${suffix}${index === fields.length - 1 ? "" : ","}`
      );
    });
    lines.push(")", "");
  }
  if (root.kind !== "object" || root.object?.name !== rootName) {
    lines.push(`typealias ${rootName} = ${cgTypeBase(root, "kotlin")}`, "");
  }
  return lines.join("\n").trimEnd();
}

function generatePhp(objects: CgObject[], root: CgType, rootName: string, sourceName: string): string {
  const lines = [`<?php`, `// Generated from ${sourceName}`, ""];
  for (const object of objects) {
    lines.push(`class ${object.name}`, "{");
    for (const field of cgObjectFields(object, (key) => cgIdentifier(key, "camel"))) {
      const nullable = !field.field.required || field.field.type.nullable;
      const base = cgTypeBase({ ...field.field.type, nullable: false }, "php");
      const prefix = nullable && base !== "mixed" ? "?" : "";
      lines.push(
        `    public ${prefix}${base} $${field.name}${nullable ? " = null" : ""};`
      );
    }
    lines.push("}", "");
  }
  if (root.kind !== "object" || root.object?.name !== rootName) {
    if (root.kind === "array" && root.item) {
      lines.push(
        `/** @extends \\ArrayObject<int, ${cgTypeBase(root.item, "php")}> */`,
        `class ${rootName} extends \\ArrayObject {}`
      );
    } else {
      lines.push(`class ${rootName}`, "{");
      lines.push(`    public ${cgTypeBase(root, "php")} $value;`);
      lines.push("}");
    }
  }
  return lines.join("\n").trimEnd();
}

function generateDart(objects: CgObject[], root: CgType, rootName: string, sourceName: string): string {
  const lines = [`// Generated from ${sourceName}`, ""];
  for (const object of objects) {
    const fields = cgObjectFields(object, (key) => cgIdentifier(key, "camel"));
    lines.push(`class ${object.name} {`);
    for (const field of fields) {
      const nullable = !field.field.required || field.field.type.nullable;
      const base = cgTypeBase({ ...field.field.type, nullable: false }, "dart");
      lines.push(`  ${base}${nullable && base !== "dynamic" ? "?" : ""} ${field.name};`);
    }
    if (fields.length) {
      lines.push("", `  ${object.name}({`);
      for (const field of fields) {
        const required = field.field.required && !field.field.type.nullable;
        lines.push(`    ${required ? "required " : ""}this.${field.name},`);
      }
      lines.push("  });");
    }
    lines.push("}", "");
  }
  if (root.kind !== "object" || root.object?.name !== rootName) {
    lines.push(`typedef ${rootName} = ${cgTypeBase(root, "dart")};`, "");
  }
  return lines.join("\n").trimEnd();
}


function generateJsonSchema(
  objects: CgObject[],
  root: CgType,
  rootName: string,
  sourceName: string
): string {
  const nullablePrimitive = (name: string, nullable?: boolean) =>
    nullable ? { type: [name, "null"] } : { type: name };
  const schemaFor = (type: CgType): Record<string, unknown> => {
    const nullable = type.nullable === true;
    const wrapNullable = (value: Record<string, unknown>) =>
      nullable ? { anyOf: [value, { type: "null" }] } : value;
    switch (type.kind) {
      case "string":
        return nullablePrimitive("string", nullable);
      case "integer":
        return nullablePrimitive("integer", nullable);
      case "number":
        return nullablePrimitive("number", nullable);
      case "boolean":
        return nullablePrimitive("boolean", nullable);
      case "null":
        return { type: "null" };
      case "object":
        return wrapNullable({ $ref: `#/$defs/${type.object?.name ?? "Nested"}` });
      case "array":
        return wrapNullable({
          type: "array",
          items: type.item ? schemaFor(type.item) : {}
        });
      case "union":
        return wrapNullable({
          anyOf: (type.types ?? []).map(schemaFor)
        });
      default:
        return nullable ? { anyOf: [{}, { type: "null" }] } : {};
    }
  };
  const defs: Record<string, unknown> = {};
  for (const object of objects) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of object.fields) {
      properties[field.key] = schemaFor(field.type);
      if (field.required) required.push(field.key);
    }
    defs[object.name] = {
      type: "object",
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {})
    };
  }
  if (!defs[rootName]) {
    defs[rootName] = schemaFor(root);
  }
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: rootName,
    description: `Generated from ${sourceName}`,
    $ref: `#/$defs/${rootName}`,
    $defs: defs
  };
  return JSON.stringify(document, null, 2);
}

function cgFileFor(lang: string, rootName: string, ext: string): string {
  if (lang === "schema") return `${cgKebab(rootName)}.schema.json`;
  if (["java", "csharp", "swift", "kotlin"].includes(lang)) {
    return `${rootName}.${ext}`;
  }
  const base = lang === "go" || lang === "rust" || lang === "python"
    ? cgSnake(rootName)
    : cgKebab(rootName);
  return `${base}.${ext}`;
}

function cgRootSummary(root: CgType, rootName: string): string {
  if (root.kind === "object" && root.object) {
    const parts = root.object.fields
      .slice(0, 3)
      .map((field) => `${field.key}: ${cgTsType(field.type).replace(/ \| null/g, "")}`);
    return [rootName, ...parts].join(" · ");
  }
  if (root.kind === "array" && root.item) {
    return `${rootName} · ${cgTsType(root.item)}[]`;
  }
  return `${rootName} · ${cgTsType(root)}`;
}

function buildGeneratedCode(lang: string, def: any, doc: BridgeDoc | null): GeneratedCode {
  const source = doc?.text ?? "";
  if (!source.trim()) {
    return {
      code: "// Open a JSON document to generate types.",
      file: `model.${def.ext}`,
      rootName: "",
      types: 0,
      records: 0,
      rootLabel: "No document"
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return {
      code: "// The document is not valid JSON. Fix the syntax to generate types.",
      file: `model.${def.ext}`,
      rootName: "",
      types: 0,
      records: 0,
      rootLabel: "Invalid JSON"
    };
  }
  const stem = (doc?.name ?? "root").replace(/\.[^.]+$/, "");
  const rootName = cgPascal(stem) || "Root";
  const ctx: CgContext = { objects: [], names: new Set() };
  const root = cgInfer(value, rootName, ctx);
  const objects = cgOrderedObjects(ctx);
  const sourceName = doc?.name ?? "JSON";
  const code =
    lang === "javascript"
      ? generateTypeScript(objects, root, rootName, sourceName, true)
      : lang === "typescript"
        ? generateTypeScript(objects, root, rootName, sourceName, false)
        : lang === "go"
          ? generateGo(objects, root, rootName, sourceName)
          : lang === "rust"
            ? generateRust(objects, root, rootName, sourceName)
            : lang === "python"
              ? generatePython(objects, root, rootName, sourceName)
              : lang === "java"
                ? generateJava(objects, root, rootName, sourceName)
                : lang === "csharp"
                  ? generateCSharp(objects, root, rootName, sourceName)
                  : lang === "swift"
                    ? generateSwift(objects, root, rootName, sourceName)
                    : lang === "kotlin"
                      ? generateKotlin(objects, root, rootName, sourceName)
                      : lang === "php"
                        ? generatePhp(objects, root, rootName, sourceName)
                        : lang === "schema"
                          ? generateJsonSchema(objects, root, rootName, sourceName)
                          : generateDart(objects, root, rootName, sourceName);
  const records = Array.isArray(value)
    ? value.length
    : isPlainObject(value)
      ? Math.max(
          1,
          ...Object.values(value).map((item) => (Array.isArray(item) ? item.length : 0))
        )
      : 1;
  return {
    code,
    file: cgFileFor(lang, rootName, def.ext),
    rootName,
    types: objects.length,
    records,
    rootLabel: cgRootSummary(root, rootName)
  };
}

function renderGeneratedCode(langId: string): void {
  const defs = evalGlobal<any[]>("LANG_DEFS");
  const def = defs.find((item) => item.id === langId) ?? defs[1];
  if (!def) return;
  evalGlobal(`currentLang = ${JSON.stringify(def.id)}`);
  buddyGenerated = buildGeneratedCode(def.id, def, currentDoc());
  const badge = document.getElementById("langBadge");
  if (badge) {
    badge.textContent = def.badge;
    badge.style.color = def.color;
    badge.style.background = `${def.color}1f`;
  }
  w.setText("langName", def.name);
  w.setText("cgFile", buddyGenerated.file);
  w.setText("cgLang", def.name);
  w.setText("cgRoot", buddyGenerated.rootLabel);
  const meta = document.querySelector(".codegen-meta");
  if (meta) {
    const doc = currentDoc();
    meta.textContent = doc
      ? `from ${doc.name} · ${buddyGenerated.records} record${
          buddyGenerated.records === 1 ? "" : "s"
        }`
      : viewLanguageIsZh()
        ? "无文档"
        : "No document";
  }
  const rootName = buddyGenerated.rootName || "Model";
  w.setText(
    "cgSummary",
    viewLanguageIsZh()
      ? `${rootName} · ${buddyGenerated.types} 个类型 · ${buddyGenerated.records} 条记录`
      : `${rootName} · ${buddyGenerated.types} type${
          buddyGenerated.types === 1 ? "" : "s"
        } · ${buddyGenerated.records} record${
          buddyGenerated.records === 1 ? "" : "s"
        }`
  );
  const code = buddyGenerated.code.replace(/^\n+|\n+$/g, "");
  const lines = code.split("\n");
  w.setText(
    "cgMeta",
    viewLanguageIsZh()
      ? `${lines.length} 行 · ${(code.length / 1024).toFixed(2)} KB`
      : `${lines.length} lines · ${(code.length / 1024).toFixed(2)} KB`
  );
  const host = document.getElementById("cgCode");
  if (host) {
    host.innerHTML = lines
      .map((line, index) => {
        const html = line ? w.highlightLine(line) : "&nbsp;";
        return `<div class="cgl"><span class="ln">${index + 1}</span><span class="cl">${html}</span></div>`;
      })
      .join("");
  }
  document.querySelectorAll(".lang-item").forEach((item) => {
    item.classList.toggle("on", (item as HTMLElement).dataset.lang === def.id);
  });
}

function scheduleCodegenRender(delay = 180): void {
  if (!codegenInstalled) return;
  if (codegenTimer !== null) window.clearTimeout(codegenTimer);
  codegenTimer = window.setTimeout(() => {
    codegenTimer = null;
    try {
      if (evalGlobal<string>("app.dataset.view") === "code") {
        renderGeneratedCode(evalGlobal<string>("currentLang") || "typescript");
      }
    } catch {
      // The app may be closing.
    }
  }, delay);
}

function installCodegen(): void {
  if (codegenInstalled) return;
  codegenInstalled = true;
  w.renderCodegen = (id: string) => renderGeneratedCode(id);
  w.copyGenerated = () => {
    if (!buddyGenerated) return;
    w.copyText(buddyGenerated.code, w.t("Copied"), buddyGenerated.file);
  };
  w.downloadGenerated = async () => {
    if (!buddyGenerated) return;
    const defs = evalGlobal<any[]>("LANG_DEFS");
    const def = defs.find(
      (item) => item.id === evalGlobal<string>("currentLang")
    );
    try {
      const path = await save({
        defaultPath: buddyGenerated.file,
        filters: def ? [{ name: def.name, extensions: [def.ext] }] : []
      });
      if (typeof path !== "string") return;
      await invoke("save_text_file", { path, text: buddyGenerated.code });
      toast(w.t("Export"), path);
    } catch (error) {
      toast("Could not save generated code", String(error));
    }
  };
  const originalSetView = w.setView;
  w.setView = (view: string) => {
    originalSetView(view);
    if (view === "code") {
      renderGeneratedCode(evalGlobal<string>("currentLang") || "typescript");
    }
  };
  renderGeneratedCode(evalGlobal<string>("currentLang") || "typescript");
}


/* ------------------------------------------------------------
   Import and export
   ------------------------------------------------------------ */

async function nativeSaveText(
  defaultPath: string,
  text: string,
  filters: { name: string; extensions: string[] }[]
): Promise<boolean> {
  const path = await save({ defaultPath, filters });
  if (typeof path !== "string") return false;
  await invoke("save_text_file", { path, text });
  toast(w.t("Export"), path);
  return true;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function patchImportExport(): void {
  w.exportCurrentCsv = async () => {
    w.closeEditorMore?.();
    const rows = w.currentExportRows?.() ?? [];
    if (!rows.length) {
      toast("Nothing to export", "No tabular data found.");
      return;
    }
    const headers: string[] = [
      ...new Set(
        (rows as Record<string, unknown>[]).flatMap((row) => Object.keys(row))
      )
    ];
    const lines = [
      headers.map(csvCell).join(","),
      ...rows.map((row: Record<string, unknown>) =>
        headers.map((header) => csvCell(row[header])).join(",")
      )
    ];
    const name = (currentDoc()?.name ?? "data").replace(/\.json$/i, "") + ".csv";
    try {
      await nativeSaveText(name, `${lines.join("\n")}\n`, [
        { name: "CSV", extensions: ["csv"] }
      ]);
    } catch (error) {
      toast("Could not export CSV", String(error));
    }
  };

  w.exportCurrentExcel = async () => {
    w.closeEditorMore?.();
    const rows = w.currentExportRows?.() ?? [];
    if (!rows.length) {
      toast("Nothing to export", "No tabular data found.");
      return;
    }
    const headers: string[] = [
      ...new Set(
        (rows as Record<string, unknown>[]).flatMap((row) => Object.keys(row))
      )
    ];
    const head = `<tr>${headers.map((header) => `<th>${w.escHtml(header)}</th>`).join("")}</tr>`;
    const body = rows
      .map(
        (row: Record<string, unknown>) =>
          `<tr>${headers
            .map((header) => `<td>${w.escHtml(row[header] == null ? "" : String(row[header]))}</td>`)
            .join("")}</tr>`
      )
      .join("");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><table>${head}${body}</table></body></html>`;
    const name = (currentDoc()?.name ?? "data").replace(/\.json$/i, "") + ".xls";
    try {
      await nativeSaveText(name, html, [
        { name: "Excel", extensions: ["xls"] }
      ]);
    } catch (error) {
      toast("Could not export Excel", String(error));
    }
  };

  w.downloadMockExport = async () => {
    const file = document.getElementById("mockExportFile")?.textContent ?? "export.json";
    const openapi =
      document.querySelector(".mock-format.on")?.getAttribute("data-mock-format") ===
      "openapi";
    let text = document.getElementById("mockExportCode")?.textContent ?? "";
    if (!text) return;
    try {
      const path = await save({
        defaultPath: file,
        filters: openapi
          ? [
              { name: "OpenAPI YAML", extensions: ["yaml", "yml"] },
              { name: "OpenAPI JSON", extensions: ["json"] }
            ]
          : [{ name: "JSON Schema", extensions: ["json"] }]
      });
      if (typeof path !== "string") return;
      if (openapi && /\.json$/i.test(path) && buddyMockOpenApiDoc) {
        const pretty =
          document.getElementById("mockExportPretty")?.classList.contains("on") ??
          true;
        text = JSON.stringify(buddyMockOpenApiDoc, null, pretty ? 2 : 0);
      }
      await invoke("save_text_file", { path, text });
      toast(w.t("Export"), path);
      w.closeMockExport?.();
    } catch (error) {
      toast("Could not export mock API", String(error));
    }
  };

  w.confirmImport = async () => {
    const state = evalGlobal<{ format: string; file: File | null }>("importState");
    const file = state?.file;
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast("File is too large", "Maximum import size is 50 MB.");
      return;
    }
    try {
      const text = await file.text();
      let data: unknown;
      let name = file.name;
      if (state.format === "csv") {
        data = w.csvToJson(text);
        if (!Array.isArray(data) || !data.length) {
          throw new Error("The file has no data rows.");
        }
        name = (file.name.replace(/\.csv$/i, "") || "imported") + ".json";
      } else if (state.format === "jsonl") {
        data = text
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        if (!Array.isArray(data) || !data.length) {
          throw new Error("The file has no JSON lines.");
        }
        name = (file.name.replace(/\.(jsonl|zstd|zst)$/i, "") || "imported") + ".json";
      } else {
        data = JSON.parse(text);
      }
      const pretty = `${JSON.stringify(data, null, 2)}\n`;
      const replace = document
        .getElementById("importReplaceCheck")
        ?.classList.contains("on");
      const created = await invoke<JsonDocument>("create_json_document", { name });
      const saved = await invoke<JsonDocument>("save_json_document", {
        path: created.path,
        text: pretty
      });
      w.closeImport?.();
      if (replace) {
        installDocument(saved);
      } else {
        seedRecents(await invoke<RecentDocument[]>("list_recent_documents"));
        w.renderJsonRecents?.();
        w.renderFileMenuJsonRecents?.();
      }
      toast(w.t("Imported file"), saved.name);
    } catch (error) {
      toast("Could not import file", String(error));
    }
  };
}


function patchMockGeneration(): void {
  const originalOpen = w.openMockGenerate;
  const originalUpdate = w.updateGenUI;
  const clampRecords = (value: number) =>
    Math.max(1, Math.min(1000, Math.round(value) || 100));
  const recordsValue = () => {
    const input = document.getElementById("genRecords") as HTMLInputElement | null;
    return clampRecords(Number(input?.value) || 100);
  };
  w.openMockGenerate = () => {
    const input = document.getElementById("genRecords") as HTMLInputElement | null;
    if (input && !input.dataset.buddyDefault) {
      input.value = "100";
      input.dataset.buddyDefault = "1";
    }
    originalOpen();
  };
  w.adjustGenRecords = (delta: number) => {
    const input = document.getElementById("genRecords") as HTMLInputElement | null;
    if (!input) return;
    input.value = String(clampRecords((Number(input.value) || 100) + delta));
    w.updateGenUI?.();
  };
  w.updateGenUI = () => {
    originalUpdate();
    const count = recordsValue();
    w.setText("genPreviewCount", `${count} items`);
    w.setText(
      "genAction",
      `Generate ${count} record${count === 1 ? "" : "s"}`
    );
  };
  w.generateMockData = () => {
    const seedInput = document.getElementById("genSeed") as HTMLInputElement | null;
    const count = recordsValue();
    const seed = Math.max(1, Number(seedInput?.value) || 42);
    const shape = w.mockGenShape?.();
    if (!shape?.ep) return;
    const arrayOnly =
      (document.getElementById("genTarget") as HTMLSelectElement | null)?.value ===
      "Array only";
    const payload = w.mockGeneratedPayload?.(
      shape,
      count,
      seed,
      w.mockGenOptions?.(),
      arrayOnly
    );
    if (payload === undefined) {
      toast("Could not generate data", "The response has no usable shape.");
      return;
    }
    shape.ep.generated = JSON.stringify(payload, null, 2);
    shape.ep.generatedInfo = {
      n: shape.rootArray || shape.arrayKey ? count : 1,
      seed,
      options: w.mockGenOptions?.(),
      arrayOnly
    };
    setMockRuntimeResponse(shape.ep, payload);
    evalGlobal("activeMockTab = 'response'");
    w.closeMockGenerate?.();
    w.renderMockEndpoint?.(evalGlobal<number>("activeMockEndpointIndex") || 0);
    toast(
      "Mock data generated",
      `${shape.ep.method} ${shape.ep.path} · ${count} record${count === 1 ? "" : "s"}`
    );
  };
  const input = document.getElementById("genRecords") as HTMLInputElement | null;
  if (input && !input.dataset.buddyDefault) {
    input.value = "100";
    input.dataset.buddyDefault = "1";
  }
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
    buddyStreamArchiveCount = 0;
    buddyStreamArchiveLoading = false;
    buddyStreamArchiveExhausted = false;
    buddyStreamArchiveLoaded = false;
    buddyStreamPending = 0;
    buddyStreamFocusLine = null;
    resetStreamRate();
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
    bindStreamScroll();
    requestAnimationFrame(() => {
      const host = document.getElementById("streamCode");
      if (!host) return;
      host.scrollTop = host.scrollHeight;
      renderRealStreamSource(false);
    });
  };

  buddyOpenStreamPath = openStreamPath;

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
      toast(
        w.t("Opened JSONL file"),
        selected.split(/[\\/]/).pop() ?? selected
      );
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
    resetStreamRate();
    const live = !file.paused;
    renderRealStreamSource(live);
    renderRealStreamEvents(live);
    updateRealStreamChrome(file, live);
    renderConversation(live);
    if (live) scrollStreamToBottom();
    if (live) {
      const code = document.getElementById("streamCode");
      if (code) requestAnimationFrame(() => { code.scrollTop = code.scrollHeight; });
    }
  };

  w.deleteMonitorFile = async (id: string) => {
    try {
      if (buddyStreamFollowing === id) {
        try {
          await invoke("stop_stream_follow", { path: id });
        } catch {
          // The watcher may already be closed.
        }
        buddyStreamFollowing = null;
      }
      originalDeleteMonitorFile(id);
      const remaining = await invoke<RecentStream[]>("remove_recent_stream", {
        path: id
      });
      seedStreamRecents(remaining);
      if (buddyStreamSnapshot?.path === id) {
        buddyStreamSnapshot = null;
        buddyStreamEvents = [];
        buddyStreamArchiveCount = 0;
        buddyStreamArchiveLoading = false;
        buddyStreamArchiveExhausted = false;
        buddyStreamArchiveLoaded = false;
        buddyConversation = null;
        buddyStreamPending = 0;
        buddyStreamFocusLine = null;
        resetStreamRate();
        buddyAuditEntries = [];
        buddyAuditActive = false;
      }
    } catch (error) {
      toast("Could not remove stream", String(error));
    }
  };

  const originalSetMonitorMode = w.setMonitorMode;
  w.setMonitorMode = (mode: string) => {
    originalSetMonitorMode(mode);
    if (mode === "source") {
      requestAnimationFrame(() => {
        const host = document.getElementById("streamCode");
        if (!host) return;
        if (!getStreamPaused()) host.scrollTop = host.scrollHeight;
        renderRealStreamSource(!getStreamPaused());
      });
    }
  };

  const originalWrap = w.toggleMonitorWrap;
  w.toggleMonitorWrap = () => {
    originalWrap?.();
    renderRealStreamSource(!getStreamPaused());
  };

  bindStreamScroll();

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
      buddyStreamArchiveCount = 0;
      buddyStreamArchiveLoading = false;
      buddyStreamArchiveExhausted = false;
      buddyStreamArchiveLoaded = false;
      buddyStreamPending = 0;
      buddyStreamFocusLine = null;
      resetStreamRate();
      toast(w.t("Stream reloaded"), payload.path.split(/[\\/]/).pop() ?? payload.path);
    } else {
      recordStreamTraffic(payload.events.length);
      buddyStreamEvents = [...buddyStreamEvents, ...payload.events];
      buddyStreamArchiveExhausted = false;
      const cutoff =
        buddyStreamEvents.length - (buddyStreamArchiveLoaded ? 30000 : 10000);
      if (cutoff > 0) {
        buddyStreamEvents = buddyStreamEvents.slice(cutoff);
        buddyStreamArchiveCount = Math.max(
          0,
          buddyStreamArchiveCount - Math.min(cutoff, buddyStreamArchiveCount)
        );
      }
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
    const nearBottom = streamNearBottom(code);
    renderRealStreamSource(!file.paused);
    renderRealStreamEvents(!file.paused);
    updateRealStreamChrome(file, !file.paused);
    renderConversation(!file.paused);
    if (nearBottom && code) {
      buddyStreamPending = 0;
      requestAnimationFrame(() => {
        code.scrollTop = code.scrollHeight;
        renderRealStreamSource(!file.paused);
      });
      const edge = document.getElementById("edgeText");
      if (edge && !file.paused) edge.textContent = w.t("Following live edge");
    } else if (code) {
      buddyStreamPending += payload.events.length;
      const edge = document.getElementById("edgeText");
      if (edge) {
        edge.textContent = file.paused
          ? w.t("Paused · follow to resume")
          : streamPendingText(buddyStreamPending);
      }
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
  generatedInfo?: MockEndpoint["generatedInfo"];
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
let mockRunningProjects = new Set<string>();
let mockRunningProjectsKnown = false;
let mockServerStartedAt: number | null = null;
let mockRequestCount = 0;
let mockRequestLogs: MockRequestLog[] = [];
let mockSaveTimer: number | null = null;
let mockSaveChain: Promise<void> = Promise.resolve();
let mockEditor: EditorView | null = null;
let mockEditorHost: HTMLDivElement | null = null;
let syncingMockEditor = false;
let mockBridgeReady = false;
let mockSeeded = false;
let mockRuntimeReady = new Set<string>();
let buddyMockOpenApiDoc: unknown = null;

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
    response: mockResponseText(endpoint.response),
    importedFrom: endpoint.importedFrom ?? undefined,
    generatedInfo: endpoint.generatedInfo ?? undefined
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
  // Generated data is a session-only runtime response; project files keep the
  // static response so reopening never stores stale generated records.
  const raw = endpoint.response ?? "";
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
    endpoints: project.endpoints.map((endpoint) => {
      if (!endpoint.id) endpoint.id = mockUuid();
      return {
        id: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        name: endpoint.name || `${endpoint.method} ${endpoint.path}`,
        status: Number(endpoint.status) || 200,
        delayMs: Number(endpoint.delayMs) || 0,
        enabled: endpoint.enabled !== false,
        response: mockParseResponse(endpoint),
        importedFrom: endpoint.importedFrom,
        generatedInfo: endpoint.generatedInfo
      };
    })
  };
}

function mockUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setMockRuntimeResponse(
  endpoint: BridgeMockEndpoint | null,
  response: unknown
): void {
  if (!endpoint) return;
  const project = mockCurrentProject();
  if (!project) return;
  void invoke("set_mock_runtime_response", {
    projectId: project.id,
    endpointId: endpoint.id,
    response
  })
    .then(() => {
      if (response == null) mockRuntimeReady.delete(endpoint.id);
      else mockRuntimeReady.add(endpoint.id);
    })
    .catch((error) => {
      mockRuntimeReady.delete(endpoint.id);
      toast("Could not update mock response", String(error));
    });
}

interface MockGeneratedShape {
  ep: BridgeMockEndpoint;
  value: unknown;
  rootArray: boolean;
  arrayKey: string | null;
  template: unknown;
}

function mockGeneratedShapeForEndpoint(
  endpoint: BridgeMockEndpoint
): MockGeneratedShape {
  let value: unknown = null;
  try {
    value = JSON.parse(endpoint.response || "null");
  } catch {
    value = null;
  }
  let rootArray = false;
  let arrayKey: string | null = null;
  let template: unknown = null;
  if (Array.isArray(value)) {
    rootArray = true;
    template = value[0];
  } else if (value && typeof value === "object") {
    const key = Object.keys(value).find((name) =>
      Array.isArray((value as Record<string, unknown>)[name])
    );
    if (key) {
      arrayKey = key;
      const candidate = (value as Record<string, unknown>)[key];
      template = Array.isArray(candidate) ? candidate[0] : null;
    } else {
      template = value;
    }
  }
  return { ep: endpoint, value, rootArray, arrayKey, template };
}

function mockGeneratedPayloadForEndpoint(
  endpoint: BridgeMockEndpoint
): unknown {
  const info = endpoint.generatedInfo;
  if (!info) return undefined;
  const count = Math.max(1, Math.min(1000, Number(info.n) || 1));
  const seed = Math.max(1, Math.floor(Number(info.seed) || 42));
  const options = {
    realistic: info.options?.realistic !== false,
    unique: info.options?.unique !== false,
    vary: info.options?.vary !== false,
    nulls: info.options?.nulls === true
  };
  const payload = w.mockGeneratedPayload?.(
    mockGeneratedShapeForEndpoint(endpoint),
    count,
    seed,
    options,
    info.arrayOnly === true
  );
  return payload == null ? undefined : payload;
}

async function regenerateProjectGenerated(
  project: BridgeMockProject
): Promise<void> {
  let changed = false;
  for (const endpoint of project.endpoints) {
    if (!endpoint.generatedInfo || mockRuntimeReady.has(endpoint.id)) continue;
    const payload = mockGeneratedPayloadForEndpoint(endpoint);
    if (payload === undefined) continue;
    endpoint.generated = JSON.stringify(payload, null, 2);
    try {
      await invoke("set_mock_runtime_response", {
        projectId: project.id,
        endpointId: endpoint.id,
        response: payload
      });
      mockRuntimeReady.add(endpoint.id);
      changed = true;
    } catch (error) {
      console.warn("could not regenerate mock data", error);
    }
  }
  if (changed) {
    try {
      if (
        evalGlobal<string | null>("activeMockProjectId") === project.id &&
        mockPage() === "detail"
      ) {
        w.renderMockEndpoint?.(
          evalGlobal<number>("activeMockEndpointIndex") || 0
        );
      }
    } catch {
      // The mock page may be closed.
    }
  }
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
  const projectLogs = project
    ? mockRequestLogs.filter((entry) => entry.projectId === project.id)
    : [];
  const logs = projectLogs.slice(0, 12);
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
  if (count) count.textContent = String(projectLogs.length);
  updateMockInspectorStats();
}

function setMockServerStatus(status: MockServerStatus): void {
  mockServerRunning = status.running;
  if (Array.isArray(status.runningProjects)) {
    mockRunningProjectsKnown = true;
    mockRunningProjects = new Set(status.runningProjects);
  } else {
    mockRunningProjectsKnown = false;
    mockRunningProjects = new Set();
  }
  const uptime = Math.max(0, Number(status.uptimeSeconds) || 0);
  mockServerStartedAt = status.running
    ? Date.now() - uptime * 1000
    : null;
  if (typeof status.totalRequests === "number") {
    mockRequestCount = Math.max(0, status.totalRequests);
  }
}

function mockClockText(seconds: number): string {
  const bounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(bounded / 3600);
  const minutes = Math.floor((bounded % 3600) / 60);
  const rest = bounded % 60;
  return [hours, minutes, rest]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function updateMockInspectorStats(): void {
  const requestCount = mockRequestCount;
  const statusRequest = document.querySelector<HTMLElement>(
    ".status-mock .status-right > .status-item:last-child"
  );
  const statusText = statusRequest?.firstChild;
  if (statusText && statusText.nodeType === Node.TEXT_NODE) {
    statusText.nodeValue = `${requestCount} `;
  }
  const rows = document.querySelectorAll<HTMLElement>(
    ".mock-inspector .mock-server-stats > div"
  );
  if (!rows.length) return;
  const current = mockCurrentProject();
  const projectRunning = current ? current.running : false;
  const uptime = mockServerRunning && projectRunning && mockServerStartedAt
    ? (Date.now() - mockServerStartedAt) / 1000
    : 0;
  const clock = rows[0]?.querySelector("b");
  if (clock) clock.textContent = mockClockText(uptime);
  const requests = rows[1]?.querySelector("b");
  if (requests) requests.textContent = String(requestCount);
}

function applyMockRunningState(): void {
  const projects = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS");
  for (const project of projects) {
    project.running =
      mockServerRunning &&
      (mockRunningProjectsKnown
        ? mockRunningProjects.has(project.id)
        : true);
  }
  if (!mockAppIsMockView()) return;
  if (mockPage() === "projects") {
    w.renderMockProjects?.();
  } else {
    w.updateMockProjectUI?.();
    renderMockLogs();
  }
  updateMockInspectorStats();
}

function seedMockProjects(
  projects: MockProject[],
  status: MockServerStatus,
  logs: MockRequestLog[]
): void {
  setMockServerStatus(status);
  mockKnownIds = new Set(projects.map((project) => project.id));
  mockRequestLogs = logs;
  if (typeof status.totalRequests !== "number") {
    mockRequestCount = logs.length;
  }
  const runningIds = new Set(
    Array.isArray(status.runningProjects)
      ? status.runningProjects
      : status.running
        ? projects.map((project) => project.id)
        : []
  );
  const list = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS");
  list.length = 0;
  for (const project of projects) {
    list.push(mockProjectToBridge(project, runningIds.has(project.id)));
  }
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

async function setMockProjectRunning(
  projectId: string,
  running: boolean
): Promise<void> {
  let status: MockServerStatus;
  try {
    if (running) {
      const project = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS").find(
        (item) => item.id === projectId
      );
      if (project) await regenerateProjectGenerated(project);
    }
    status = await invoke<MockServerStatus>("set_mock_project_running", {
      projectId,
      running
    });
  } catch (error) {
    toast(
      running ? "Could not start mock server" : "Could not stop mock server",
      String(error)
    );
    return;
  }
  setMockServerStatus(status);
  if (running && (status.totalRequests ?? 0) === 0) {
    mockRequestLogs = [];
  }
  applyMockRunningState();
  toast(
    running ? w.t("mock.statusRunning") : w.t("mock.statusStopped"),
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
            const hadGenerated = !!endpoint.generatedInfo;
            endpoint.response = text;
            endpoint.generated = undefined;
            endpoint.generatedInfo = undefined;
            if (hadGenerated) {
              mockRuntimeReady.delete(endpoint.id);
              setMockRuntimeResponse(endpoint, null);
            }
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


interface BuddyOpenApiOperation {
  method: string;
  path: string;
  name: string;
  status: number;
  statusText: string;
  response: string;
  mediaType: string;
  selected: boolean;
}

interface BuddyOpenApiSkip {
  endpoint: string;
  reason: string;
}

interface BuddyOpenApiImport {
  fileName: string;
  version: string;
  title: string;
  basePath: string;
  operations: BuddyOpenApiOperation[];
  skipped: BuddyOpenApiSkip[];
}

let buddyOpenApi: BuddyOpenApiImport | null = null;

const OPENAPI_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace"
] as const;

function buddyIsOpenApi(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Record<string, any>;
  return (
    typeof doc.openapi === "string" || typeof doc.swagger === "string"
  );
}

function buddyOpenApiVersion(doc: Record<string, any>): string {
  if (typeof doc.openapi === "string" && doc.openapi.trim()) {
    return `OpenAPI ${doc.openapi.trim()}`;
  }
  if (typeof doc.swagger === "string" && doc.swagger.trim()) {
    return `Swagger ${doc.swagger.trim()}`;
  }
  return "OpenAPI";
}

function buddyOpenApiBasePath(doc: Record<string, any>): string {
  const server = Array.isArray(doc.servers)
    ? doc.servers.find((entry: unknown) => entry && typeof entry === "object")
    : null;
  const raw =
    typeof server?.url === "string"
      ? server.url.trim()
      : typeof doc.basePath === "string"
        ? doc.basePath.trim()
        : "";
  if (!raw) return "/";
  if (raw.startsWith("/")) return raw.replace(/\/+$/, "") || "/";
  try {
    const url = new URL(raw, "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (pathname === "/") return "/";
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      url.hostname
    );
    if (!local) return pathname;
    // A JSON Buddy export points servers.url at the source project mount.
    // The imported project gets its own mount, so drop that slug instead of
    // nesting it under the new one.
    let known: string[] = [];
    try {
      known = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS").map(
        (project) => project.slug
      );
    } catch {
      known = [];
    }
    const title =
      doc.info && typeof doc.info.title === "string" ? doc.info.title : "";
    const titleSlug =
      typeof w.normalizeMockSlug === "function"
        ? w.normalizeMockSlug(title)
        : title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    const segment = pathname.split("/").filter(Boolean)[0] || "";
    if (known.includes(segment) || (titleSlug && segment === titleSlug)) {
      return "/";
    }
    return pathname;
  } catch {
    return "/";
  }
}

function buddyOpenApiExampleFromMedia(media: unknown): {
  found: boolean;
  value?: unknown;
} {
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    return { found: false };
  }
  const entry = media as Record<string, any>;
  if (Object.prototype.hasOwnProperty.call(entry, "example")) {
    return { found: true, value: entry.example };
  }
  if (
    entry.examples &&
    typeof entry.examples === "object" &&
    !Array.isArray(entry.examples)
  ) {
    for (const example of Object.values(entry.examples)) {
      if (!example || typeof example !== "object") {
        if (example !== undefined) return { found: true, value: example };
        continue;
      }
      if ("$ref" in (example as Record<string, any>)) continue;
      if (Object.prototype.hasOwnProperty.call(example, "value")) {
        return { found: true, value: (example as Record<string, any>).value };
      }
    }
  }
  const schema = entry.schema;
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const shape = schema as Record<string, any>;
    if (Object.prototype.hasOwnProperty.call(shape, "example")) {
      return { found: true, value: shape.example };
    }
    if (Array.isArray(shape.examples) && shape.examples.length) {
      return { found: true, value: shape.examples[0] };
    }
    if (Object.prototype.hasOwnProperty.call(shape, "default")) {
      return { found: true, value: shape.default };
    }
  }
  return { found: false };
}

function buddyOpenApiExampleFromSchema(schema: unknown): {
  found: boolean;
  value?: unknown;
} {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { found: false };
  }
  const shape = schema as Record<string, any>;
  if (Object.prototype.hasOwnProperty.call(shape, "example")) {
    return { found: true, value: shape.example };
  }
  if (Array.isArray(shape.examples) && shape.examples.length) {
    return { found: true, value: shape.examples[0] };
  }
  if (Object.prototype.hasOwnProperty.call(shape, "default")) {
    return { found: true, value: shape.default };
  }
  return { found: false };
}

function buddyOpenApiResponseText(value: unknown): string {
  let shaped = value;
  if (typeof shaped === "string" && /^\s*[\[{]/.test(shaped)) {
    try {
      shaped = JSON.parse(shaped);
    } catch {
      // Keep the original string when it only looks like JSON.
    }
  }
  const text = JSON.stringify(shaped, null, 2);
  return typeof text === "string" ? text : "null";
}

function buddyOpenApiStatusText(status: number): string {
  const labels: Record<number, string> = {
    200: "OK",
    201: "Created",
    202: "Accepted",
    203: "Non-Authoritative Information",
    204: "No Content",
    205: "Reset Content",
    206: "Partial Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    409: "Conflict",
    410: "Gone",
    415: "Unsupported Media Type",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout"
  };
  return labels[status] ?? "OK";
}

function buddyPickOpenApiResponse(
  responses: unknown
):
  | { status: number; mediaType: string; value: unknown }
  | { reason: string } {
  if (!responses || typeof responses !== "object" || Array.isArray(responses)) {
    return { reason: "no responses" };
  }
  const codes = Object.keys(responses as Record<string, unknown>)
    .map((key) => ({ key, code: Number(key) }))
    .filter(
      (entry) =>
        Number.isInteger(entry.code) && entry.code >= 200 && entry.code <= 299
    )
    .sort((left, right) => left.code - right.code);
  if (!codes.length) return { reason: "no 2xx response" };
  const chosen = codes.find((entry) => entry.code === 200) ?? codes[0];
  const response = (responses as Record<string, any>)[chosen.key];
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return { reason: "invalid response" };
  }
  if ("$ref" in response) return { reason: "response uses $ref" };

  if (
    response.content &&
    typeof response.content === "object" &&
    !Array.isArray(response.content)
  ) {
    const mediaTypes = Object.keys(response.content).filter(
      (key) =>
        response.content[key] &&
        typeof response.content[key] === "object" &&
        !Array.isArray(response.content[key])
    );
    if (mediaTypes.length) {
      const mediaType =
        mediaTypes.find((key) => key.toLowerCase() === "application/json") ??
        mediaTypes.find((key) => key.toLowerCase().includes("json"));
      if (!mediaType) return { reason: "no JSON example response" };
      const example = buddyOpenApiExampleFromMedia(response.content[mediaType]);
      if (!example.found || example.value === undefined) {
        return { reason: "no inline JSON example" };
      }
      return { status: chosen.code, mediaType, value: example.value };
    }
  }

  if (
    response.examples &&
    typeof response.examples === "object" &&
    !Array.isArray(response.examples)
  ) {
    const mediaTypes = Object.keys(response.examples).filter(
      (key) => response.examples[key] !== undefined
    );
    if (mediaTypes.length) {
      const mediaType =
        mediaTypes.find((key) => key.toLowerCase() === "application/json") ??
        mediaTypes.find((key) => key.toLowerCase().includes("json"));
      if (!mediaType) return { reason: "no JSON example response" };
      return {
        status: chosen.code,
        mediaType,
        value: response.examples[mediaType]
      };
    }
  }

  if (response.schema) {
    const example = buddyOpenApiExampleFromSchema(response.schema);
    if (!example.found || example.value === undefined) {
      return { reason: "no inline JSON example" };
    }
    return {
      status: chosen.code,
      mediaType: "application/json",
      value: example.value
    };
  }

  return { reason: "no inline JSON example" };
}

function buddyJoinOpenApiPath(base: string, route: string): string {
  let root = String(base || "/").trim();
  if (!root.startsWith("/")) root = `/${root}`;
  root = root.replace(/\/+$/, "");
  const tail = String(route || "").replace(/^\/+/, "");
  return `${root}/${tail}` || "/";
}

function buddyOpenApiProjectName(imported: BuddyOpenApiImport): string {
  let name = imported.title.trim();
  if (!name) {
    const base = imported.fileName
      .replace(/\.(schema\.)?(json|ya?ml)$/i, "")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .trim();
    name = base
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
  if (!name) name = "Imported";
  if (!/api$/i.test(name)) name += " API";
  return name;
}

function openApiUiText(english: string, chinese: string): string {
  return viewLanguageIsZh() ? chinese : english;
}

const OPENAPI_REASONS_ZH: Record<string, string> = {
  "path must start with /": "路径必须以 / 开头",
  "invalid path item": "无效的路径项",
  "path item uses $ref": "路径项使用了 $ref",
  "invalid operation": "无效的操作",
  "no responses": "没有响应定义",
  "no 2xx response": "没有 2xx 响应",
  "invalid response": "无效的响应",
  "response uses $ref": "响应使用了 $ref",
  "no JSON example response": "没有 JSON 示例响应",
  "no inline JSON example": "没有内联 JSON 示例"
};

function openApiReasonText(reason: string): string {
  return viewLanguageIsZh() ? OPENAPI_REASONS_ZH[reason] ?? reason : reason;
}

function buddyOpenApiReport(): void {
  const box = document.getElementById("schemaError");
  if (!box || !buddyOpenApi) return;
  const skipped = buddyOpenApi.skipped;
  if (!skipped.length) {
    box.textContent = "";
    box.hidden = true;
    return;
  }
  const prefix = buddyOpenApi.operations.length
    ? openApiUiText(
        `Skipped ${skipped.length} endpoint${skipped.length === 1 ? "" : "s"}: `,
        `已跳过 ${skipped.length} 个接口：`
      )
    : openApiUiText("No importable endpoints. ", "没有可导入的接口。");
  box.textContent =
    prefix +
    skipped
      .map(
        (entry) =>
          `${entry.endpoint} (${openApiReasonText(entry.reason)})`
      )
      .join(" · ");
  box.hidden = false;
}

function applyBuddyOpenApi(fileName: string, doc: Record<string, any>): void {
  const version = buddyOpenApiVersion(doc);
  const basePath = buddyOpenApiBasePath(doc);
  const operations: BuddyOpenApiOperation[] = [];
  const skipped: BuddyOpenApiSkip[] = [];
  const paths = doc.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    w.showSchemaError?.(
      openApiUiText(
        "The OpenAPI document has no paths.",
        "OpenAPI 文档没有 paths 定义。"
      )
    );
    return;
  }
  for (const [rawPath, pathItem] of Object.entries(
    paths as Record<string, unknown>
  )) {
    if (!rawPath.startsWith("/")) {
      skipped.push({ endpoint: rawPath, reason: "path must start with /" });
      continue;
    }
    if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) {
      skipped.push({ endpoint: rawPath, reason: "invalid path item" });
      continue;
    }
    if ("$ref" in pathItem) {
      skipped.push({ endpoint: rawPath, reason: "path item uses $ref" });
      continue;
    }
    for (const method of OPENAPI_METHODS) {
      if (!Object.prototype.hasOwnProperty.call(pathItem, method)) continue;
      const operation = (pathItem as Record<string, any>)[method];
      const label = `${method.toUpperCase()} ${rawPath}`;
      if (
        !operation ||
        typeof operation !== "object" ||
        Array.isArray(operation)
      ) {
        skipped.push({ endpoint: label, reason: "invalid operation" });
        continue;
      }
      const picked = buddyPickOpenApiResponse(operation.responses);
      if ("reason" in picked) {
        skipped.push({ endpoint: label, reason: picked.reason });
        continue;
      }
      const path = rawPath.replace(/\{([^}]+)\}/g, ":$1");
      const summary =
        typeof operation.summary === "string" && operation.summary.trim()
          ? operation.summary.trim()
          : typeof operation.operationId === "string" &&
              operation.operationId.trim()
            ? operation.operationId.trim()
            : label;
      operations.push({
        method: method.toUpperCase(),
        path,
        name: summary,
        status: picked.status,
        statusText: buddyOpenApiStatusText(picked.status),
        response: buddyOpenApiResponseText(picked.value),
        mediaType: picked.mediaType,
        selected: true
      });
    }
  }

  const title =
    doc.info && typeof doc.info.title === "string" ? doc.info.title : "";
  buddyOpenApi = {
    fileName,
    version,
    title,
    basePath,
    operations,
    skipped
  };
  const state = evalGlobal<Record<string, any> | null>("schemaImport");
  if (state) {
    state.fileName = fileName;
    state.root = doc;
    state.draft = version;
    state.defs = operations;
  }
  w.setText?.("schemaFileName", fileName);
  w.setText?.(
    "schemaFileMeta",
    openApiUiText(
      `${operations.length} operation${operations.length === 1 ? "" : "s"} · ${version}`,
      `${operations.length} 个操作 · ${version}`
    )
  );
  const fileBox = document.getElementById("schemaFile");
  if (fileBox) fileBox.hidden = false;
  const drop = document.getElementById("schemaDrop");
  if (drop) drop.hidden = true;
  const types = document.getElementById("schemaTypes");
  if (types) types.hidden = false;
  const target = document.getElementById("schemaTargetRow");
  if (target) target.hidden = false;
  const baseInput = document.getElementById(
    "schemaBasePath"
  ) as HTMLInputElement | null;
  if (baseInput) baseInput.value = basePath || "/";
  const errorBox = document.getElementById("schemaError");
  if (errorBox) errorBox.hidden = true;
  w.renderSchemaTypes?.();
  w.updateSchemaImportUI?.();
  buddyOpenApiReport();
}

function importBuddyOpenApi(): boolean {
  if (!buddyOpenApi) return false;
  const state = evalGlobal<Record<string, any> | null>("schemaImport");
  if (!state) return true;
  const selected = buddyOpenApi.operations.filter(
    (operation) => operation.selected
  );
  if (!selected.length) return true;
  const baseInput = document.getElementById(
    "schemaBasePath"
  ) as HTMLInputElement | null;
  const basePath = baseInput?.value || buddyOpenApi.basePath || "/";
  const endpoints: BridgeMockEndpoint[] = selected.map((operation) => ({
    id: mockUuid(),
    method: operation.method,
    cls: operation.method.toLowerCase(),
    path: buddyJoinOpenApiPath(basePath, operation.path),
    status: operation.status,
    statusText: operation.statusText,
    name: operation.name,
    delayMs: 0,
    enabled: true,
    response: operation.response,
    importedFrom: buddyOpenApi?.fileName
  }));
  const projects = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS");
  const uniqueSlug = (value: string): string => {
    const normalized =
      typeof w.normalizeMockSlug === "function"
        ? w.normalizeMockSlug(value)
        : String(value || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    const base = normalized || "imported-api";
    return typeof w.uniqueMockSlug === "function"
      ? w.uniqueMockSlug(base)
      : base;
  };
  const createProject = (
    name: string,
    description: string,
    slug: string
  ): string => {
    const id = mockUuid();
    projects.push({
      id,
      name: name || "Imported API",
      description:
        description || `Mock project imported from ${buddyOpenApi?.fileName}.`,
      slug: uniqueSlug(slug || name),
      running: false,
      updated: "just now",
      schemaCount: selected.length,
      endpoints
    });
    return id;
  };

  const pending = state.pendingProject;
  let projectId = "";
  let startIndex = 0;
  if (pending) {
    projectId = createProject(
      pending.name || "Imported API",
      pending.description || "",
      pending.slug || ""
    );
  } else {
    const target = document.getElementById(
      "schemaTargetProject"
    ) as HTMLSelectElement | null;
    const targetValue = target?.value || "__new__";
    if (targetValue === "__new__") {
      projectId = createProject(
        buddyOpenApiProjectName(buddyOpenApi),
        `Mock project imported from ${buddyOpenApi.fileName}.`,
        buddyOpenApi.title || "imported-api"
      );
    } else {
      const project = projects.find((entry) => entry.id === targetValue);
      if (!project) return true;
      const mode =
        (document.getElementById("schemaMode") as HTMLSelectElement | null)
          ?.value || "append";
      if (mode === "replace") {
        project.endpoints = endpoints;
        project.schemaCount = selected.length;
      } else {
        let firstTouched = -1;
        for (const incoming of endpoints) {
          const existing = project.endpoints.findIndex(
            (entry) =>
              entry.method.toUpperCase() === incoming.method.toUpperCase() &&
              entry.path === incoming.path
          );
          if (existing >= 0) {
            project.endpoints[existing] = incoming;
            if (firstTouched < 0) firstTouched = existing;
          } else {
            project.endpoints.push(incoming);
            if (firstTouched < 0) firstTouched = project.endpoints.length - 1;
          }
        }
        startIndex = Math.max(firstTouched, 0);
        project.schemaCount = Math.max(
          project.schemaCount || 0,
          selected.length
        );
      }
      project.updated = "just now";
      projectId = project.id;
    }
  }

  w.closeMockImportSchema?.();
  if (!projectId) return true;
  w.openMockProject?.(projectId);
  if (startIndex > 0) w.renderMockEndpoints?.(startIndex);
  const skipped = buddyOpenApi.skipped.length;
  toast(
    openApiUiText(
      `Imported ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`,
      `已导入 ${endpoints.length} 个接口`
    ),
    skipped
      ? openApiUiText(
          `${skipped} endpoint${skipped === 1 ? "" : "s"} skipped · ${buddyOpenApi.fileName}`,
          `${skipped} 个接口已跳过 · ${buddyOpenApi.fileName}`
        )
      : buddyOpenApi.fileName
  );
  buddyOpenApi = null;
  return true;
}

function hasRemoteSchemaReference(root: unknown): boolean {
  const dataKeys = new Set([
    "example",
    "examples",
    "default",
    "const",
    "enum"
  ]);
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  let visited = 0;
  while (stack.length && visited < 50000) {
    visited += 1;
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (seen.has(value as object)) continue;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    const schema = value as Record<string, unknown>;
    if (
      typeof schema.$ref === "string" &&
      !schema.$ref.trim().startsWith("#")
    ) {
      return true;
    }
    if (
      typeof schema.$id === "string" &&
      /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(schema.$id.trim())
    ) {
      return true;
    }
    for (const [key, child] of Object.entries(schema)) {
      if (dataKeys.has(key)) continue;
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return false;
}

function patchOpenApiImport(): void {
  const originalOpen = w.openMockImportSchema;
  const originalApply = w.applyParsedSchema;
  const originalClear = w.clearSchemaFile;
  const originalRenderTypes = w.renderSchemaTypes;
  const originalUpdateUI = w.updateSchemaImportUI;

  w.openMockImportSchema = (options?: unknown) => {
    buddyOpenApi = null;
    originalOpen(options);
    const input = document.getElementById(
      "schemaFileInput"
    ) as HTMLInputElement | null;
    if (input) {
      input.accept =
        ".json,.yaml,.yml,.schema.json,application/json,application/yaml,application/schema+json";
    }
  };

  w.readSchemaFile = async (file: File | null) => {
    if (!file) return;
    // Drop any previous selection so a failed parse cannot leave stale
    // operations importable behind an error message.
    w.clearSchemaFile?.();
    if (file.size > 10 * 1024 * 1024) {
      w.showSchemaError?.(
        openApiUiText(
          "This file is larger than 10 MB. Choose a smaller schema.",
          "文件超过 10 MB，请选择更小的 Schema。"
        )
      );
      return;
    }
    if (typeof file.text !== "function") {
      w.showSchemaError?.(
        openApiUiText(
          "This browser cannot read the selected file.",
          "当前环境无法读取所选文件。"
        )
      );
      return;
    }
    const name = file.name || "schema.json";
    const yaml = /\.ya?ml$/i.test(name);
    let text = "";
    try {
      text = await file.text();
    } catch (error) {
      w.showSchemaError?.(
        openApiUiText(
          `Could not read ${name}: ${String(error)}`,
          `无法读取 ${name}：${String(error)}`
        )
      );
      return;
    }
    let root: unknown;
    if (yaml) {
      try {
        root = await invoke<unknown>("parse_yaml_document", { text });
      } catch (error) {
        w.showSchemaError?.(
          openApiUiText(
            `Could not parse ${name}: ${String(error)}`,
            `无法解析 ${name}：${String(error)}`
          )
        );
        return;
      }
    } else {
      try {
        root = JSON.parse(text);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        w.showSchemaError?.(
          openApiUiText(
            `Could not parse ${name}: ${detail}`,
            `无法解析 ${name}：${detail}`
          )
        );
        return;
      }
    }
    if (!root || typeof root !== "object" || Array.isArray(root)) {
      w.showSchemaError?.(
        openApiUiText(
          "The file must contain a JSON Schema or OpenAPI object.",
          "文件必须包含 JSON Schema 或 OpenAPI 对象。"
        )
      );
      return;
    }
    if (buddyIsOpenApi(root)) {
      applyBuddyOpenApi(name, root);
      return;
    }
    if (yaml) {
      w.showSchemaError?.(
        openApiUiText(
          `${name} is YAML but is not an OpenAPI / Swagger document.`,
          `${name} 是 YAML，但不是 OpenAPI / Swagger 文档。`
        )
      );
      return;
    }
    const definitions =
      (root as Record<string, any>).$defs ??
      (root as Record<string, any>).definitions;
    if (
      definitions &&
      typeof definitions === "object" &&
      !Array.isArray(definitions) &&
      Object.keys(definitions).length > 1000
    ) {
      w.showSchemaError?.(
        openApiUiText(
          "This schema has more than 1,000 definitions. Split it into smaller files before importing.",
          "此 Schema 超过 1,000 个定义，请拆分为更小的文件后再导入。"
        )
      );
      return;
    }
    if (hasRemoteSchemaReference(root)) {
      w.showSchemaError?.(
        openApiUiText(
          "Remote $ref and $id are not supported. Use references inside this file.",
          "不支持远程 $ref 和 $id，请使用此文件内的引用。"
        )
      );
      return;
    }
    buddyOpenApi = null;
    w.applyParsedSchema?.(name, root);
  };

  w.applyParsedSchema = (fileName: string, root: unknown) => {
    buddyOpenApi = null;
    originalApply(fileName, root);
  };

  w.clearSchemaFile = (event?: Event) => {
    buddyOpenApi = null;
    originalClear(event);
  };

  w.renderSchemaTypes = () => {
    if (!buddyOpenApi) {
      originalRenderTypes();
      return;
    }
    const host = document.getElementById("schemaTypes");
    if (!host) return;
    const check =
      '<svg class="i" viewBox="0 0 24 24" style="width:8px;height:8px;stroke-width:3"><use href="#i-check"/></svg>';
    host.innerHTML = buddyOpenApi.operations
      .map(
        (operation, index) => `
      <button class="schema-type${operation.selected ? " on" : ""}" data-def="${index}" onclick="toggleSchemaType(this)">
        <span class="schema-check">${check}</span>
        <b>${w.escHtml(`${operation.method} ${operation.path}`)}</b>
        <small>${w.escHtml(
          `${operation.status} ${operation.statusText} · ${operation.mediaType}`
        )}</small>
      </button>`
      )
      .join("");
  };

  w.updateSchemaImportUI = () => {
    if (!buddyOpenApi) {
      originalUpdateUI();
      return;
    }
    const state = evalGlobal<Record<string, any> | null>("schemaImport");
    if (!state) return;
    const selected = buddyOpenApi.operations.filter(
      (operation) => operation.selected
    );
    const action = document.getElementById(
      "schemaImportAction"
    ) as HTMLButtonElement | null;
    if (action) {
      action.disabled = !state.fileName || selected.length === 0;
    }
    const skipped = buddyOpenApi.skipped.length;
    const summary = selected.length
      ? openApiUiText(
          `${selected.length} operation${selected.length === 1 ? "" : "s"} · ${
            skipped ? `${skipped} skipped` : "all importable"
          }`,
          `${selected.length} 个操作 · ${
            skipped ? `${skipped} 个跳过` : "全部可导入"
          }`
        )
      : buddyOpenApi.operations.length
        ? openApiUiText("Select at least one operation", "请选择至少一个操作")
        : openApiUiText("No importable endpoints", "没有可导入的接口");
    w.setText?.("schemaSummary", summary);
    const target = document.getElementById(
      "schemaTargetProject"
    ) as HTMLSelectElement | null;
    const targetValue = state.pendingProject ? "" : target?.value || "__new__";
    w.setText?.(
      "schemaImportActionLabel",
      w.t(
        state.pendingProject || targetValue === "__new__"
          ? "Create project"
          : "Import schema"
      )
    );
    const mode =
      (document.getElementById("schemaMode") as HTMLSelectElement | null)
        ?.value || "append";
    const baseInput = document.getElementById(
      "schemaBasePath"
    ) as HTMLInputElement | null;
    const basePath = baseInput?.value || buddyOpenApi.basePath || "/";
    let note = openApiUiText(
      `Endpoints keep their method, path and inline JSON examples. Base path: ${basePath}.`,
      `接口将保留方法、路径和内联 JSON 示例。基础路径：${basePath}。`
    );
    if (skipped) {
      note += openApiUiText(
        ` ${skipped} endpoint${skipped === 1 ? "" : "s"} skipped; see the report above.`,
        ` 已跳过 ${skipped} 个接口，详见上方报告。`
      );
    }
    if (state.pendingProject) {
      note += openApiUiText(
        ` Import will create “${state.pendingProject.name}”.`,
        ` 导入将创建“${state.pendingProject.name}”。`
      );
    } else if (targetValue === "__new__") {
      note += openApiUiText(
        " A new project will be created from this file.",
        " 将根据此文件创建新项目。"
      );
    } else if (mode === "replace") {
      note += openApiUiText(
        " Replace removes the current endpoints before importing.",
        " 替换模式会先移除当前接口。"
      );
    } else {
      note += openApiUiText(
        " Append keeps existing endpoints and updates matching routes.",
        " 追加模式会保留现有接口并更新相同路由。"
      );
    }
    w.setText?.("schemaNote", note);
  };
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
  const originalMockSchemaExportText = w.mockSchemaExportText;
  const originalMockOpenapiExportText = w.mockOpenapiExportText;
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
    const project = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS").find(
      (item) => item.id === id
    );
    if (project) void regenerateProjectGenerated(project);
  };

  w.openMockProjects = () => {
    if (mockSeeded) void flushMockSave();
    originalOpenMockProjects();
  };

  w.toggleMockServer = () => {
    const project = mockCurrentProject();
    if (!project) return;
    void setMockProjectRunning(project.id, !project.running);
  };

  w.toggleMockProjectServer = (id: string, event?: Event) => {
    if (event) event.stopPropagation();
    const project = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS").find(
      (item) => item.id === id
    );
    if (!project) return;
    void setMockProjectRunning(project.id, !project.running);
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
    const endpoint = evalGlobal<BridgeMockEndpoint | null>(
      "getMockEndpoints()[activeMockEndpointIndex]"
    );
    if (endpoint?.generatedInfo && endpoint.generated) {
      try {
        setMockRuntimeResponse(endpoint, JSON.parse(endpoint.generated));
      } catch {
        // The generated payload is always JSON; leave the runtime untouched.
      }
    }
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
    if (!project.running) {
      toast(
        w.t("Mock server is stopped"),
        w.t("Start the project to send requests.")
      );
      return;
    }
    if (endpoint.enabled === false) {
      toast(w.t("Endpoint is disabled"), `${endpoint.method} ${endpoint.path}`);
      return;
    }
    try {
      const url =
        w.mockBaseUrl(project) + w.mockSamplePathFor(endpoint, project);
      const result = await invoke<{
        status: number;
        statusText: string;
        durationMs: number;
      }>("test_local_request", { url, method: endpoint.method });
      toast(
        w.t("Request sent"),
        `${endpoint.method} ${endpoint.path} · ${result.status} ${
          result.statusText || endpoint.statusText
        } · ${result.durationMs} ms`
      );
    } catch (error) {
      toast(viewLanguageIsZh() ? "请求失败" : "Request failed", String(error));
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
        const status = await invoke<MockServerStatus>("mock_server_status");
        setMockServerStatus(status);
        applyMockRunningState();
      } catch (error) {
        toast("Could not delete mock project", String(error));
      }
    }
  };

  w.mockOpenapiExportText = (
    project: BridgeMockProject,
    endpoints: BridgeMockEndpoint[],
    includeExamples: boolean
  ) => {
    const paths: Record<string, Record<string, unknown>> = {};
    endpoints.forEach((endpoint) => {
      const path = endpoint.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      const method = endpoint.method.toLowerCase();
      const response: Record<string, unknown> = {
        description: endpoint.statusText || "OK"
      };
      if (endpoint.status !== 204) {
        const media: Record<string, unknown> = {
          schema: w.mockInferSchema?.(w.mockEndpointValue?.(endpoint)) ?? {}
        };
        if (includeExamples) {
          media.examples = {
            default: { value: w.mockEndpointValue?.(endpoint) }
          };
        }
        response.content = { "application/json": media };
      }
      if (!paths[path]) paths[path] = {};
      paths[path][method] = {
        summary: endpoint.name,
        responses: { [String(endpoint.status)]: response }
      };
    });
    buddyMockOpenApiDoc = {
      openapi: "3.1.0",
      info: { title: project.name, version: "1.0.0" },
      servers: [{ url: w.mockBaseUrl(project) }],
      paths
    };
    if (typeof originalMockOpenapiExportText === "function") {
      return originalMockOpenapiExportText(project, endpoints, includeExamples);
    }
    return JSON.stringify(buddyMockOpenApiDoc, null, 2);
  };

  w.mockSchemaExportText = (
    project: BridgeMockProject,
    endpoints: BridgeMockEndpoint[],
    includeExamples: boolean,
    pretty: boolean
  ) => {
    if (typeof originalMockSchemaExportText !== "function") {
      return originalMockSchemaExportText?.(
        project,
        endpoints,
        includeExamples,
        pretty
      );
    }
    const definitions: Record<string, unknown> = {};
    const properties: Record<string, unknown> = {};
    const used = new Set<string>();
    endpoints.forEach((endpoint) => {
      const value = w.mockEndpointValue?.(endpoint);
      const schema = w.mockInferSchema?.(value) ?? {};
      let base = String(endpoint.name || `${endpoint.method} ${endpoint.path}`)
        .replace(/[^A-Za-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
        .join("");
      if (!base) base = `${endpoint.method}Response`;
      if (!/^[A-Za-z_]/.test(base)) base = `Response${base}`;
      let name = base;
      let suffix = 2;
      while (used.has(name)) {
        name = `${base}${suffix}`;
        suffix += 1;
      }
      used.add(name);
      schema.title = endpoint.name || `${endpoint.method} ${endpoint.path}`;
      if (includeExamples) schema.examples = [value];
      definitions[name] = schema;
      properties[`${endpoint.method} ${endpoint.path}`] = {
        $ref: `#/$defs/${name}`
      };
    });
    return JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: project.name,
        type: "object",
        properties,
        $defs: definitions
      },
      null,
      pretty ? 2 : 0
    );
  };

  w.importSchema = async () => {
    const before = new Set(
      evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS").map((project) => project.id)
    );
    if (!importBuddyOpenApi()) originalImportSchema();
    const projects = evalGlobal<BridgeMockProject[]>("MOCK_PROJECTS");
    for (const project of projects) {
      for (const endpoint of project.endpoints) {
        if (!endpoint.id) endpoint.id = mockUuid();
      }
    }
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

let menuBridgeReady = false;

function startMenuBridge(): void {
  if (menuBridgeReady || !hasTauri) return;
  if (typeof (window as any).__TAURI_INTERNALS__?.transformCallback !== "function") {
    return;
  }
  menuBridgeReady = true;
  void listen<string>("buddy-menu", (event) => {
    switch (event.payload) {
      case "menu-new-json":
        void w.newEditorDocument?.();
        break;
      case "menu-open-json":
        void w.openJsonFileDialog?.();
        break;
      case "menu-open-stream":
        void w.openMonitorFileDialog?.();
        break;
      case "menu-save":
        void w.saveCurrentDocument?.();
        break;
      case "menu-settings":
        w.openSettings?.();
        break;
      default:
        break;
    }
  }).catch((error) => {
    console.warn("could not listen for application menu events", error);
  });
}

function startMockEventBridge(): void {
  if (mockBridgeReady) return;
  if (typeof (window as any).__TAURI_INTERNALS__?.transformCallback !== "function") {
    return;
  }
  mockBridgeReady = true;
  void listen<MockRequestLog>("mock-request", (event) => {
    mockRequestLogs = [event.payload, ...mockRequestLogs].slice(0, 200);
    mockRequestCount += 1;
    updateMockInspectorStats();
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
      syncEditor(false);
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

  w.buddyOpenDroppedPath = async (paths: string | string[]) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(
      (path) => typeof path === "string" && path.trim()
    );
    const supported = list.filter((path) =>
      /\.(json|jsonl|zst|zstd)$/i.test(path.trim())
    );
    if (!supported.length) {
      toast(
        viewLanguageIsZh() ? "不支持的文件类型" : "Unsupported file type",
        list[0]?.split(/[\\/]/).pop() ?? ""
      );
      return;
    }
    for (const path of supported) {
      try {
        if (/\.(jsonl|zst|zstd)$/i.test(path)) {
          if (!buddyOpenStreamPath) {
            throw new Error("stream monitor is unavailable");
          }
          await buddyOpenStreamPath(path);
          toast(
            w.t("Opened JSONL file"),
            path.split(/[\\/]/).pop() ?? path
          );
        } else {
          const document = await invoke<JsonDocument>("open_json_document", {
            path
          });
          installDocument(document);
          toast(w.t("Opened JSON file"), document.name);
        }
      } catch (error) {
        const isStream = /\.(jsonl|zst|zstd)$/i.test(path);
        toast(
          isStream
            ? viewLanguageIsZh()
              ? "无法打开流"
              : "Could not open stream"
            : viewLanguageIsZh()
              ? "无法打开文档"
              : "Could not open document",
          String(error)
        );
      }
    }
  };

  w.saveCurrentDocument = async () => {
    const doc = currentDoc();
    if (!doc) return;
    if (!documentHasSavePath(doc)) {
      toast("Could not save document", "Open or create a file first.");
      return;
    }
    clearDocumentAutosaveTimer();
    const text = doc.text ?? "";
    const version = buddyDocumentVersion;
    try {
      const saved = await queueDocumentSave(doc.path, text);
      if (currentDoc() === doc) {
        applySavedDocument(doc, saved, version);
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

function installGlobalFileDrop(): void {
  if (fileDropInstalled || !hasTauri) return;
  if (typeof (window as any).__TAURI_INTERNALS__?.transformCallback !== "function") {
    return;
  }
  fileDropInstalled = true;
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      void w.buddyOpenDroppedPath?.(event.payload.paths);
    })
    .catch((error) => {
      console.warn("could not listen for file drops", error);
    });
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
    patchToastLocalization();
    patchClipboard();
    patchJsonDocumentFlow();
    installDocumentAutosave();
    installGlobalFileDrop();
    startMenuBridge();
    patchCompareFlow();
    patchStreamFlow();
    startStreamEventBridge();
    patchOpenApiImport();
    patchMockFlow();
    startMockEventBridge();
    window.setInterval(updateMockInspectorStats, 1000);
    window.setInterval(() => {
      try {
        const file = evalGlobal<BridgeStreamFile | null>(
          "typeof getMonitorFile === 'function' ? getMonitorFile(activeMonitorFileId) : null"
        );
        if (!file || file.paused) return;
        if (evalGlobal<string>("app.dataset.view") !== "monitor") return;
        updateStreamRateChrome(file, true);
      } catch {
        // The monitor view may not be mounted.
      }
    }, 1000);
    patchAuditFlow();
    startAuditEventBridge();
    patchSearchReveal();
    installTreeView();
    installTableData();
    installStatusChrome();
    installGraphData();
    installCodegen();
    patchImportExport();
    patchMockGeneration();
    applyBackendSettings(data.settings);
    seedRecents(data.recents);
    seedStreamRecents(data.streams ?? []);
    const [projects, serverStatus, requestLogs, auditConfig, appAudit] =
      await Promise.all([
        invoke<MockProject[]>("list_mock_projects"),
        invoke<MockServerStatus>("mock_server_status"),
        invoke<MockRequestLog[]>("mock_request_logs"),
        invoke<AuditConfig>("audit_config"),
        invoke<AuditEntry[]>("list_app_audit").catch(() => [])
      ]);
    seedMockProjects(projects, serverStatus, requestLogs);
    buddyAuditConfig = auditConfig;
    buddyAppAuditEntries = Array.isArray(appAudit) ? appAudit : [];
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
