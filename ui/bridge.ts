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

// One scrollbar treatment for the whole desktop app. Several prototype
// panels each defined their own width, border and background; the injected
// rules below override those local variants and also cover CodeMirror.
const scrollbarStyle = document.createElement("style");
scrollbarStyle.id = "buddy-global-scrollbars";
scrollbarStyle.textContent = `
  :root {
    --buddy-scrollbar-size: 9px;
    --buddy-scrollbar-thumb: var(--line-strong);
    --buddy-scrollbar-thumb-hover: var(--ink-4);
    --buddy-scrollbar-thumb-active: var(--ink-3);
  }
  *::-webkit-scrollbar {
    width: var(--buddy-scrollbar-size) !important;
    height: var(--buddy-scrollbar-size) !important;
    background: transparent !important;
  }
  *::-webkit-scrollbar-track {
    background: transparent !important;
    border: 0 !important;
  }
  *::-webkit-scrollbar-thumb {
    min-height: 28px;
    background-color: var(--buddy-scrollbar-thumb) !important;
    background-clip: padding-box !important;
    border: 2px solid transparent !important;
    border-radius: 999px !important;
  }
  *::-webkit-scrollbar-thumb:hover {
    background-color: var(--buddy-scrollbar-thumb-hover) !important;
  }
  *::-webkit-scrollbar-thumb:active {
    background-color: var(--buddy-scrollbar-thumb-active) !important;
  }
  *::-webkit-scrollbar-corner {
    background: transparent !important;
  }
  *::-webkit-scrollbar-button {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
`;
document.head.appendChild(scrollbarStyle);

// The monitor metadata row was redundant with the status bar. The file's
// last-modified time now lives in the bottom monitor status bar instead.
const monitorChromeStyle = document.createElement("style");
monitorChromeStyle.id = "buddy-monitor-chrome";
monitorChromeStyle.textContent = `
  .monitor-stats { display: none !important; }
  .monitor-toolbar > .tool-left { grid-column: 1; }
  .monitor-toolbar > .tool-right { grid-column: 3; }
  .monitor-toolbar > .monitor-mode {
    grid-column: 2;
    justify-self: center;
    margin-left: 0;
  }
  .side-detail-head {
    flex: 0 0 39px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    border-bottom: 1px solid var(--line);
    user-select: none;
  }
  .side-detail-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: -.01em;
    color: var(--ink);
  }
  .side-detail-head > .side-close {
    width: 22px;
    height: 22px;
    margin-left: auto;
    flex: 0 0 auto;
    color: var(--ink-4);
  }
  .side-detail-head > .side-close .i { color: var(--ink-4); }
  .side-detail-head > .side-close:hover { color: var(--ink-2); }
  .side-detail-head > .side-close:hover .i { color: var(--ink-2); }
  .live-panel.buddy-side-collapsed,
  .chat-side.buddy-side-collapsed {
    flex: 0 0 32px !important;
    width: 32px !important;
    min-width: 32px;
    overflow: hidden;
  }
  .live-panel.buddy-side-collapsed > .side-detail-head,
  .live-panel.buddy-side-collapsed > .side-tabs,
  .live-panel.buddy-side-collapsed > .side-pane,
  .chat-side.buddy-side-collapsed > .side-detail-head,
  .chat-side.buddy-side-collapsed > .side-tabs,
  .chat-side.buddy-side-collapsed > .side-pane { display: none !important; }
  .buddy-side-splitter-hidden { display: none !important; }
  .buddy-side-reopen {
    display: none;
    width: 100%;
    height: 100%;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    border: 0;
    background: transparent;
    color: var(--ink-3);
    cursor: pointer;
  }
  .live-panel.buddy-side-collapsed > .buddy-side-reopen,
  .chat-side.buddy-side-collapsed > .buddy-side-reopen { display: flex; }
  .buddy-side-reopen:hover { background: var(--hover); color: var(--ink-2); }
  .buddy-side-reopen .i { width: 14px; height: 14px; }
  .buddy-side-reopen-label {
    writing-mode: vertical-rl;
    font-family: var(--font-ui);
    font-size: 9px;
    letter-spacing: .08em;
  }
`;
document.head.appendChild(monitorChromeStyle);

function centerMonitorModeSwitch(): void {
  const toolbar = document.querySelector(".monitor-toolbar");
  const mode = toolbar?.querySelector(".monitor-mode");
  const right = toolbar?.querySelector(".tool-right");
  if (!toolbar || !mode || !right || mode.parentElement === toolbar) return;
  toolbar.insertBefore(mode, right);
}

centerMonitorModeSwitch();

let monitorSideCollapsed = false;

function monitorSidebars(): HTMLElement[] {
  return [".live-panel", ".chat-side"]
    .map((selector) => document.querySelector<HTMLElement>(selector))
    .filter((element): element is HTMLElement => !!element);
}

function updateMonitorSidebarChrome(): void {
  const zh = streamLanguageIsZh();
  const closeLabel = zh ? "关闭详情" : "Close details";
  const showLabel = zh ? "显示详情" : "Show details";
  const detailLabel = zh ? "详情" : "Details";
  for (const sidebar of monitorSidebars()) {
    sidebar.classList.toggle("buddy-side-collapsed", monitorSideCollapsed);
    const splitter = sidebar.previousElementSibling;
    if (splitter instanceof HTMLElement && splitter.classList.contains("cmp-splitter")) {
      splitter.classList.toggle("buddy-side-splitter-hidden", monitorSideCollapsed);
    }
    const title = sidebar.querySelector<HTMLElement>(".side-detail-title");
    if (title) title.textContent = detailLabel;
    const close = sidebar.querySelector<HTMLButtonElement>(".side-close");
    if (close) {
      close.title = closeLabel;
      close.setAttribute("aria-label", closeLabel);
    }
    const reopen = sidebar.querySelector<HTMLButtonElement>(".buddy-side-reopen");
    if (reopen) {
      reopen.title = showLabel;
      reopen.setAttribute("aria-label", showLabel);
      const label = reopen.querySelector<HTMLElement>(".buddy-side-reopen-label");
      if (label) label.textContent = detailLabel;
    }
  }
}

function installMonitorSidebarControls(): void {
  for (const sidebar of monitorSidebars()) {
    const tabs = sidebar.querySelector<HTMLElement>(".side-tabs");
    let head = sidebar.querySelector<HTMLElement>(".side-detail-head");
    if (!head) {
      head = document.createElement("div");
      head.className = "side-detail-head";
      head.innerHTML = '<span class="side-detail-title"></span><span class="spacer"></span>';
      if (tabs) sidebar.insertBefore(head, tabs);
      else sidebar.insertBefore(head, sidebar.firstChild);
    }
    tabs?.querySelector(".side-close")?.remove();
    if (!head.querySelector(".side-close")) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "pane-btn side-close";
      close.innerHTML = '<svg class="i sm" viewBox="0 0 24 24"><use href="#i-x"/></svg>';
      close.addEventListener("click", () => {
        monitorSideCollapsed = true;
        updateMonitorSidebarChrome();
      });
      head.appendChild(close);
    }
    if (!sidebar.querySelector(".buddy-side-reopen")) {
      const reopen = document.createElement("button");
      reopen.type = "button";
      reopen.className = "buddy-side-reopen";
      reopen.innerHTML =
        '<svg class="i" viewBox="0 0 24 24"><use href="#i-layout"/></svg><span class="buddy-side-reopen-label"></span>';
      reopen.addEventListener("click", () => {
        monitorSideCollapsed = false;
        updateMonitorSidebarChrome();
      });
      sidebar.appendChild(reopen);
    }
  }
  updateMonitorSidebarChrome();
}

installMonitorSidebarControls();

const splitterStyle = document.createElement("style");
splitterStyle.id = "buddy-splitter-styles";
splitterStyle.textContent = `
  .splitter,
  .cmp-splitter {
    position: relative;
    z-index: 2;
    touch-action: none;
  }
  .splitter::before,
  .cmp-splitter::before {
    content: "";
    position: absolute;
    inset: 0 -3px;
    cursor: col-resize;
  }
  body.buddy-splitting,
  body.buddy-splitting * {
    cursor: col-resize !important;
    user-select: none !important;
    -webkit-user-select: none !important;
  }
  body.buddy-splitting .editor {
    transition: none !important;
  }
  body.buddy-splitting .splitter::after,
  body.buddy-splitting .cmp-splitter::after {
    background: var(--accent) !important;
    height: 44px !important;
    width: 2px !important;
  }
  .splitter:focus-visible,
  .cmp-splitter:focus-visible {
    outline: none;
  }
  .splitter:focus-visible::after,
  .cmp-splitter:focus-visible::after {
    background: var(--accent);
    height: 44px;
    width: 2px;
  }
  .app[data-view="text"] .editor {
    flex: 1 1 auto !important;
  }
`;
document.head.appendChild(splitterStyle);

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
let codegenRevision = 0;
let buddySavedVersion = 0;
let buddyAutosaveTimer: number | null = null;
let buddyAutosaveFailedPath = "";
let buddyDocumentSaveChain: Promise<unknown> = Promise.resolve();
const highlightCompartment = new Compartment();
const languageCompartment = new Compartment();
const LARGE_DOCUMENT_LIMIT = 2_000_000;
let editorLargeMode = false;

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
  "Could not generate code": "无法生成代码",
  "Could not build tree view": "无法生成树视图",
  "Large files use text comparison": "大文件将使用文本对比",
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
          languageCompartment.of(
            (doc?.text?.length ?? 0) > LARGE_DOCUMENT_LIMIT ? [] : json()
          ),
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
            codegenRevision += 1;
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
            scheduleActiveViewRender();
          })
        ]
      })
    });
    editorLargeMode = (doc?.text?.length ?? 0) > LARGE_DOCUMENT_LIMIT;
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
  if (documentChanged || current !== next) codegenRevision += 1;
  if (documentChanged) {
    flushPreviousDocument(doc);
    clearDocumentAutosaveTimer();
    buddyTrackedDoc = doc;
    buddyAutosaveFailedPath = "";
    buddySavedVersion = buddyDocumentVersion;
    updateDocumentDirtyIndicator(doc);
  }
  if (current !== next) {
    const largeMode = next.length > LARGE_DOCUMENT_LIMIT;
    const languageChanged = largeMode !== editorLargeMode;
    syncing = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      ...(documentChanged ? { selection: { anchor: 0 } } : {}),
      ...(languageChanged
        ? { effects: languageCompartment.reconfigure(largeMode ? [] : json()) }
        : {})
    });
    syncing = false;
    editorLargeMode = largeMode;
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
    const line = state.doc.line(lineNumber);
    const sample = state.sliceDoc(line.from, Math.min(line.to, line.from + 256));
    if (/^[ \t]+\S/.test(sample)) {
      indented = sample;
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
  if (state.doc.length > 1_000_000) {
    renderJsonStatusPath([], "$");
    const host = document.querySelector<HTMLElement>(
      ".status-normal .status-path"
    );
    if (host) {
      host.title = zh
        ? "大文档仅显示根路径"
        : "Root path only for large documents";
    }
  } else {
    const segments = jsonPathAtCursor(state);
    renderJsonStatusPath(segments, jsonPathText(segments));
  }
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
    if (doc?.sizeLabel) return doc.sizeLabel;
    return originalDocumentSize(doc);
  };
  w.documentLineCount = (doc: BridgeDoc | null) => {
    if (doc && typeof doc.lineCount === "number") return doc.lineCount;
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
    scheduleActiveViewRender();
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

function prepareDocumentView(): void {
  try {
    w.setView("text");
    evalGlobal("app.dataset.toolPage = 'editor'");
    document.querySelector(".code-wrap")?.getBoundingClientRect();
    // CodeMirror must know the visible viewport before a large document is
    // inserted. Otherwise it briefly renders every line, and WebKit can block
    // for seconds on the first layout. requestMeasure + readMeasured forces
    // that measurement synchronously while the empty editor is cheap to lay out.
    const view = ensureEditor();
    if (view) {
      view.requestMeasure();
      (view as any).readMeasured?.();
    }
  } catch {
    // The workspace may still be mounting.
  }
}

function installDocument(doc: JsonDocument): void {
  const full = asBridgeDoc(doc);
  try {
    prepareDocumentView();
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
  if (text.length <= COMPARE_PRETTY_MAX_BYTES) {
    try {
      text = `${JSON.stringify(JSON.parse(document.text), null, 2)}\n`;
    } catch {
      // Compare text mode still works with invalid JSON.
    }
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

const COMPARE_PRETTY_MAX_BYTES = 400_000;
const COMPARE_MAX_LINES = 10_000;
const COMPARE_MAX_CHANGES = 2_000;
const COMPARE_HIGHLIGHT_MAX_CHARS = 8_000;
const COMPARE_PREVIEW_LINES = 2_000;

function patchCompareFlow(): void {
  const originalSelect = w.selectCompareFile;
  const originalPick = w.pickCompareFile;
  const originalOpenCompare = w.openCompare;

  const comparePlaceholder = (): string =>
    viewLanguageIsZh() ? "选择文件" : "Choose a file";

  const setCompareName = (id: string, name: string): void => {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = name || comparePlaceholder();
  };

  const compareClearLabel = (): string =>
    viewLanguageIsZh() ? "清除文件" : "Clear files";

  const bWrap = document
    .getElementById("cmpFileBtnB")
    ?.closest<HTMLElement>(".cmp-file-wrap");
  let compareClearButton: HTMLButtonElement | null = null;
  if (bWrap && !document.getElementById("cmpClearBtn")) {
    compareClearButton = document.createElement("button");
    compareClearButton.id = "cmpClearBtn";
    compareClearButton.type = "button";
    compareClearButton.className = "tbtn icon-only";
    compareClearButton.title = compareClearLabel();
    compareClearButton.setAttribute("aria-label", compareClearLabel());
    compareClearButton.innerHTML =
      '<svg class="i sm" viewBox="0 0 24 24"><use href="#i-x"/></svg>';
    bWrap.insertAdjacentElement("afterend", compareClearButton);
  } else {
    compareClearButton = document.getElementById(
      "cmpClearBtn"
    ) as HTMLButtonElement | null;
  }

  const updateCompareClearLabel = (): void => {
    if (!compareClearButton) return;
    compareClearButton.title = compareClearLabel();
    compareClearButton.setAttribute("aria-label", compareClearLabel());
  };

  const clearCompareFiles = (): void => {
    evalGlobal(
      `compareDocs = { a: { name: "", text: "" }, b: { name: "", text: "" } };
       compareFileNames.a = "";
       compareFileNames.b = "";
       compareKind = "structural";
       compareIgnoreKeyOrder = true;
       compareSyncScroll = true;
       compareFoldAll = false;
       compareWrap = false;
       compareChangeFilter = "all";
       selectedChange = null;
       compareScrollLock = false;`
    );
    try {
      w.closeCompareFileMenus();
      w.closeCompareSearch?.("a");
      w.closeCompareSearch?.("b");
      w.applyCompareSettingsUI?.();
      w.setCompareChangeFilter?.("all", null, false);
    } catch {
      // The compare view may not be mounted yet.
    }
    showCompareEmptyState(evalGlobal("compareDocs"));
    for (const id of ["codeA", "codeB", "changeList"]) {
      const host = document.getElementById(id);
      if (host) {
        host.scrollTop = 0;
        host.scrollLeft = 0;
      }
    }
    try {
      document.getElementById("cmpFileBtnA")?.focus();
    } catch {
      // Focus is best-effort.
    }
  };

  const showCompareEmptyState = (docs: {
    a: { name: string; text: string };
    b: { name: string; text: string };
  }): void => {
    evalGlobal(
      "compareChanges = []; compareLineCounts = { a: 0, b: 0 }; selectedChange = null; compareScrollLock = false;"
    );
    w.updateCompareLabels();
    setCompareName("cmpFileFnameA", docs.a.name);
    setCompareName("cmpFileFnameB", docs.b.name);
    setCompareName("cmpPaneNameA", docs.a.name);
    setCompareName("cmpPaneNameB", docs.b.name);
    const bothEmpty = !docs.a.name && !docs.b.name;
    const message = (side: "a" | "b"): string => {
      if (docs[side].name) {
        return viewLanguageIsZh()
          ? `已选择 ${docs[side].name}，请选择另一侧文件。`
          : `${docs[side].name} selected. Choose the other side to compare.`;
      }
      if (bothEmpty) {
        return side === "a"
          ? viewLanguageIsZh()
            ? "选择 A 侧 JSON 文件开始对比。"
            : "Choose a JSON file for side A to start comparing."
          : viewLanguageIsZh()
            ? "选择 B 侧 JSON 文件开始对比。"
            : "Choose a JSON file for side B to start comparing.";
      }
      return side === "a"
        ? viewLanguageIsZh()
          ? "请选择 A 侧文件。"
          : "Choose a file for side A."
        : viewLanguageIsZh()
          ? "请选择 B 侧文件。"
          : "Choose a file for side B.";
    };
    for (const side of ["a", "b"] as const) {
      const host = document.getElementById(side === "a" ? "codeA" : "codeB");
      if (!host) continue;
      const selected = docs[side];
      if (!selected.name) {
        host.innerHTML = `<div class="tree-empty" style="padding:36px 24px;text-align:center;line-height:1.7">${w.escHtml(
          message(side)
        )}</div>`;
        continue;
      }
      const lines = selected.text.split("\n");
      const visible = lines.slice(0, COMPARE_PREVIEW_LINES);
      const rows = visible.map((line, index) => ({
        n: index + 1,
        text: line,
        html: w.highlightJsonLine(line),
        cls: "",
        changes: []
      }));
      w.renderCompareCode(side === "a" ? "codeA" : "codeB", rows);
      if (lines.length > COMPARE_PREVIEW_LINES) {
        const note = document.createElement("div");
        note.className = "tree-empty";
        note.style.padding = "10px 18px";
        note.style.textAlign = "center";
        note.textContent = viewLanguageIsZh()
          ? `已显示前 ${COMPARE_PREVIEW_LINES.toLocaleString("en-US")} 行，共 ${lines.length.toLocaleString("en-US")} 行。选择另一侧文件开始对比。`
          : `Showing the first ${COMPARE_PREVIEW_LINES.toLocaleString("en-US")} of ${lines.length.toLocaleString("en-US")} lines. Choose the other side to compare.`;
        host.appendChild(note);
      }
    }
    const changeList = document.getElementById("changeList");
    if (changeList) {
      changeList.innerHTML = `<div class="changes-empty">${
        viewLanguageIsZh()
          ? "选择两侧文件后显示差异。"
          : "Choose both files to see their differences."
      }</div>`;
    }
    for (const id of [
      "changesCount",
      "changesAllCount",
      "changesModCount",
      "changesAddCount",
      "changesRemCount"
    ]) {
      w.setText?.(id, "0");
    }
    w.setText?.(
      "changesFootCount",
      viewLanguageIsZh() ? "等待选择文件" : "Waiting for files"
    );
    w.setText?.("cmpPath", "—");
    w.setText?.(
      "cmpToolbarDiffText",
      viewLanguageIsZh() ? "选择文件后对比" : "Select files to compare"
    );
    w.setText?.(
      "cmpStatusDiffText",
      viewLanguageIsZh() ? "选择文件后对比" : "Select files to compare"
    );
    w.setText?.(
      "cmpStatusFiles",
      `${(docs.a.name ? 1 : 0) + (docs.b.name ? 1 : 0)}/2 ${
        viewLanguageIsZh() ? "个文件" : "files"
      }`
    );
    w.setText?.("cmpStatusLines", `0 ${viewLanguageIsZh() ? "行" : "lines"}`);
    w.setText?.("cmpKind", viewLanguageIsZh() ? "选择文件" : "Select files");
    const current = document.getElementById("cmpStatusDiff");
    if (current) current.className = "status-pill";
  };

  if (compareClearButton) {
    compareClearButton.addEventListener("click", clearCompareFiles);
  }

  const originalApplyCompareLanguage = w.applyLanguage;
  if (typeof originalApplyCompareLanguage === "function") {
    w.applyLanguage = (language: string) => {
      originalApplyCompareLanguage(language);
      updateCompareClearLabel();
    };
  }

  // The compare workspace starts empty; files are only loaded when the user
  // explicitly chooses them from either side's menu.
  evalGlobal(
    `compareDocs = { a: { name: "", text: "" }, b: { name: "", text: "" } }; compareFileNames.a = ""; compareFileNames.b = "";`
  );
  showCompareEmptyState(evalGlobal("compareDocs"));

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
  };

  const originalHighlightJsonLine = w.highlightJsonLine;
  if (typeof originalHighlightJsonLine === "function") {
    w.highlightJsonLine = (line: string) => {
      if (line.length <= COMPARE_HIGHLIGHT_MAX_CHARS) {
        return originalHighlightJsonLine(line);
      }
      const visible = line.slice(0, COMPARE_HIGHLIGHT_MAX_CHARS);
      const note = viewLanguageIsZh()
        ? ` …（已省略 ${line.length.toLocaleString("en-US")} 个字符的长行）`
        : ` … (${line.length.toLocaleString("en-US")} character line truncated)`;
      return `${w.escHtml(visible)}<span style="color:var(--ink-3)">${w.escHtml(note)}</span>`;
    };
  }

  const originalRenderDiff = w.renderDiff;
  const compareDocsLarge = (): boolean => {
    const docs = evalGlobal<{ a: { text: string }; b: { text: string } }>(
      "compareDocs"
    );
    return (
      docs.a.text.length > COMPARE_PRETTY_MAX_BYTES ||
      docs.b.text.length > COMPARE_PRETTY_MAX_BYTES
    );
  };
  w.renderDiff = () => {
    const docs = evalGlobal<{ a: { name: string; text: string }; b: { name: string; text: string } }>(
      "compareDocs"
    );
    if (!docs.a.name || !docs.b.name) {
      showCompareEmptyState(docs);
      return;
    }
    const linesA = docs.a.text.split("\n").length;
    const linesB = docs.b.text.split("\n").length;
    if (linesA > COMPARE_MAX_LINES || linesB > COMPARE_MAX_LINES) {
      showCompareLimit(docs.a, docs.b, linesA, linesB);
      return;
    }
    if (compareDocsLarge()) {
      evalGlobal(`compareKind = "text"`);
      originalRenderDiff();
      const list = document.getElementById("changeList");
      if (list) {
        const note = document.createElement("div");
        note.className = "changes-empty";
        note.textContent = viewLanguageIsZh()
          ? "文件较大，已使用文本对比以避免界面卡顿。"
          : "Large files use text comparison to keep the interface responsive.";
        list.appendChild(note);
      }
      return;
    }
    originalRenderDiff();
  };

  const originalSetCompareType = w.setCompareType;
  if (typeof originalSetCompareType === "function") {
    w.setCompareType = (type: string, button?: HTMLElement | null) => {
      if (type === "structural" && compareDocsLarge()) {
        toast("Large files use text comparison");
        return;
      }
      originalSetCompareType(type, button);
    };
  }

  const originalRenderCompareChanges = w.renderCompareChanges;
  w.renderCompareChanges = () => {
    const allChanges = evalGlobal<any[]>("compareChanges");
    if (allChanges.length <= COMPARE_MAX_CHANGES) {
      originalRenderCompareChanges();
      return;
    }
    evalGlobal(
      `window.__buddyAllChanges = compareChanges; compareChanges = compareChanges.slice(0, ${COMPARE_MAX_CHANGES});`
    );
    try {
      originalRenderCompareChanges();
    } finally {
      evalGlobal("compareChanges = window.__buddyAllChanges; delete window.__buddyAllChanges;");
    }
    const counts = { all: allChanges.length, mod: 0, add: 0, rem: 0 };
    allChanges.forEach((change) => {
      counts[change.kind as "mod" | "add" | "rem"] += 1;
    });
    w.setText?.("changesCount", counts.all);
    w.setText?.("changesAllCount", counts.all);
    w.setText?.("changesModCount", counts.mod);
    w.setText?.("changesAddCount", counts.add);
    w.setText?.("changesRemCount", counts.rem);
    w.setText?.(
      "changesFootCount",
      viewLanguageIsZh()
        ? `${counts.all} 处更改 · 显示前 ${COMPARE_MAX_CHANGES.toLocaleString("en-US")} 处`
        : `${counts.all} changes · showing first ${COMPARE_MAX_CHANGES.toLocaleString("en-US")}`
    );
    const list = document.getElementById("changeList");
    if (list) {
      const note = document.createElement("div");
      note.className = "changes-empty";
      note.textContent = viewLanguageIsZh()
        ? `仅显示前 ${COMPARE_MAX_CHANGES.toLocaleString("en-US")} 处，共 ${counts.all.toLocaleString("en-US")} 处更改。`
        : `Showing the first ${COMPARE_MAX_CHANGES.toLocaleString("en-US")} of ${counts.all.toLocaleString("en-US")} changes.`;
      list.appendChild(note);
    }
  };

  renderCompareMenus();
}

function showCompareLimit(
  a: { name: string; text: string },
  b: { name: string; text: string },
  linesA: number,
  linesB: number
): void {
  evalGlobal(
    `compareChanges = []; selectedChange = null; compareLineCounts = { a: ${linesA}, b: ${linesB} };`
  );
  const message = viewLanguageIsZh()
    ? `文件过大，未生成逐行对比。\n${a.name} · ${linesA.toLocaleString("en-US")} 行\n${b.name} · ${linesB.toLocaleString("en-US")} 行`
    : `These files are too large for a line-by-line comparison.\n${a.name} · ${linesA.toLocaleString("en-US")} lines\n${b.name} · ${linesB.toLocaleString("en-US")} lines`;
  const html = `<div class="tree-empty" style="position:absolute;left:24px;top:48px;white-space:pre-line;line-height:1.7">${w.escHtml(
    message
  )}</div>`;
  for (const id of ["codeA", "codeB"]) {
    const host = document.getElementById(id);
    if (host) host.innerHTML = html;
  }
  const list = document.getElementById("changeList");
  if (list) {
    list.innerHTML = `<div class="changes-empty">${viewLanguageIsZh() ? "文件过大，已停止逐行对比。" : "Comparison paused for very large files."}</div>`;
  }
  for (const id of [
    "changesCount",
    "changesAllCount",
    "changesModCount",
    "changesAddCount",
    "changesRemCount"
  ]) {
    w.setText?.(id, "0");
  }
  w.setText?.("changesFootCount", viewLanguageIsZh() ? "已停止对比" : "Comparison paused");
  w.setText?.("cmpPath", "—");
  w.setText?.("cmpToolbarDiffText", viewLanguageIsZh() ? "文件过大" : "Files too large");
  w.setText?.("cmpStatusDiffText", viewLanguageIsZh() ? "文件过大" : "Files too large");
  w.setText?.("cmpStatusFiles", "2 files");
  w.setText?.(
    "cmpStatusLines",
    `${Math.max(linesA, linesB).toLocaleString("en-US")} lines`
  );
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

function updateMonitorModifiedStatus(modified?: string | null): void {
  const format = document.getElementById("monitorFormat");
  if (!format) return;
  let item = document.getElementById("monitorModifiedStatus");
  if (!item) {
    item = document.createElement("span");
    item.id = "monitorModifiedStatus";
    item.className = "status-item";
    format.insertAdjacentElement("afterend", item);
  }
  const value = String(modified ?? "").trim();
  item.hidden = !value;
  item.style.display = value ? "" : "none";
  if (!value) {
    item.textContent = "";
    return;
  }
  item.textContent = streamLanguageIsZh() ? `修改于 ${value}` : `modified ${value}`;
  item.title = item.textContent;
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
  updateMonitorModifiedStatus(file.modified);
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


/* ------------------------------------------------------------
   Conversation trajectory
   ------------------------------------------------------------ */

type TrajectoryEntryKind = "user" | "assistant" | "tool";

interface TrajectoryEntry {
  key: string;
  index: number;
  round: number;
  step: number;
  kind: TrajectoryEntryKind;
  line: number;
  timestamp?: string | null;
  text: string;
  reasoning?: string | null;
  model?: string | null;
  message?: ConversationMessage;
  call?: ConversationToolCall;
}

interface TrajectorySummary {
  kind: "summary";
  key: string;
  summaryKind: "turn" | "calls";
  group: string;
  round: number;
  step: number;
  line: number;
  count: number;
  toolCount: number;
  text: string;
}

type TrajectoryDisplayRow = TrajectoryEntry | TrajectorySummary;

interface TrajectoryTimelineSpan {
  entry: TrajectoryEntry;
  left: number;
  width: number;
}

interface TrajectoryTimelineModel {
  mode: "sequence" | "duration";
  spans: TrajectoryTimelineSpan[];
  minimumWindow: number;
}

const TRAJECTORY_ROW_HEIGHT = 46;
const TRAJECTORY_OVERSCAN = 8;
const TRAJECTORY_DURATION_STORAGE = "json_buddy.trajectory.actualDuration";
const TRAJECTORY_TIMELINE_SAMPLE = 1_200;
let trajectoryInstalled = false;
let trajectoryAllEntries: TrajectoryEntry[] = [];
let trajectoryVisibleEntries: TrajectoryEntry[] = [];
let trajectoryDisplayRows: TrajectoryDisplayRow[] = [];
let trajectoryTimelineModel: TrajectoryTimelineModel | null = null;
let trajectoryViewport: { start: number; end: number } | null = null;
let trajectoryActualDuration = (() => {
  try {
    return localStorage.getItem(TRAJECTORY_DURATION_STORAGE) === "1";
  } catch {
    return false;
  }
})();
const trajectoryCollapsedTurns = new Set<number>();
const trajectoryCollapsedAssistants = new Set<string>();
let trajectorySelectedKey: string | null = null;
let trajectoryInspectorHidden = false;
let trajectoryActiveTab = "overview";
let trajectoryFollow = true;
let trajectoryRange: { start: number; end: number } | null = null;
let trajectoryDraft: { startFraction: number; endFraction: number } | null = null;
let trajectoryDrag:
  | {
      pointerId: number;
      startX: number;
      startFraction: number;
      key: string | null;
      moved: boolean;
      track: HTMLElement;
    }
  | null = null;
let trajectoryRenderTimer: number | null = null;
let trajectoryTimelineFrame: number | null = null;
let trajectoryPaintFrame: number | null = null;
let trajectoryResetScroll = false;
let trajectoryStreamPath: string | null = null;

const trajectoryStyle = document.createElement("style");
trajectoryStyle.id = "buddy-trajectory-styles";
trajectoryStyle.textContent = `
  .buddy-trajectory { display: none; flex: 1; min-width: 0; background: var(--canvas-bg); }
  .app[data-view="monitor"][data-monitor-page="detail"][data-monitor-mode="trajectory"] .monitor-main,
  .app[data-view="monitor"][data-monitor-page="detail"][data-monitor-mode="trajectory"] .chat-main {
    display: none !important;
  }
  .app[data-view="monitor"][data-monitor-page="detail"][data-monitor-mode="trajectory"] .buddy-trajectory {
    display: flex;
  }
  .trajectory-main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 9px;
    overflow: hidden;
  }
  .trajectory-toolbar {
    flex: 0 0 37px;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 11px;
    background: var(--card);
    border: 1px solid var(--line-strong);
    border-radius: 9px;
    box-shadow: var(--shadow-node);
  }
  .trajectory-controls { display: flex; align-items: center; gap: 2px; }
  .trajectory-stat {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 9.5px;
    color: var(--ink-3);
    white-space: nowrap;
  }
  .trajectory-stat .i { width: 12px; height: 12px; color: var(--ink-4); }
  .trajectory-stat b {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 550;
    color: var(--ink-2);
  }
  .trajectory-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 23px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--ink-3);
    font-family: var(--font-ui);
    font-size: 9.5px;
    white-space: nowrap;
    cursor: pointer;
  }
  .trajectory-toggle:hover:not(:disabled) { background: var(--hover); color: var(--ink); }
  .trajectory-toggle[aria-pressed="true"] {
    border-color: var(--accent-ring);
    background: var(--accent-soft);
    color: var(--accent-2);
  }
  .trajectory-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
  .trajectory-toggle:disabled { opacity: .45; cursor: default; }
  .trajectory-toggle .i { width: 12px; height: 12px; color: var(--ink-4); }
  .trajectory-toggle[aria-pressed="true"] .i { color: var(--accent-2); }
  .trajectory-toggle b {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 550;
    color: var(--ink-2);
  }
  .trajectory-fold {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .trajectory-fold .plus { display: none; }
  .trajectory-toggle[aria-pressed="true"] .trajectory-fold .minus { display: none; }
  .trajectory-toggle[aria-pressed="true"] .trajectory-fold .plus { display: inline; }
  .trajectory-spacer { flex: 1; }
  .trajectory-step-count { color: var(--ink-3); }
  .trajectory-timeline {
    flex: 0 0 60px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    padding: 6px 11px;
    background: var(--card);
    border: 1px solid var(--line-strong);
    border-radius: 9px;
    box-shadow: var(--shadow-node);
    position: relative;
    user-select: none;
    touch-action: none;
    cursor: crosshair;
  }
  .trajectory-timeline:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .trajectory-timeline.trajectory-dragging { cursor: ew-resize; }
  .trajectory-timeline.trajectory-dragging .trajectory-span { pointer-events: none; }
  .trajectory-lane { display: grid; grid-template-columns: 34px 1fr; align-items: center; gap: 8px; }
  .trajectory-lane-label {
    font-size: 8.5px;
    color: var(--ink-3);
    text-align: right;
    white-space: nowrap;
  }
  .trajectory-track {
    position: relative;
    height: 9px;
    border-radius: 3px;
    background: var(--hover);
    overflow: hidden;
    cursor: crosshair;
  }
  .trajectory-span {
    position: absolute;
    top: 1px;
    z-index: 2;
    height: 7px;
    min-width: 3px;
    border-radius: 1px;
    background: var(--accent);
    cursor: pointer;
  }
  .trajectory-span.user { background: var(--code-string); }
  .trajectory-span.assistant { background: #8b6bd9; }
  .trajectory-span.tool { background: var(--accent); }
  .trajectory-span.error { background: var(--code-null); }
  [data-theme="dark"] .trajectory-span.assistant { background: #b49aef; }
  .trajectory-span:hover { filter: brightness(1.1); }
  .trajectory-span.outside { opacity: .2; }
  .trajectory-span.current {
    z-index: 2;
    box-shadow: 0 0 0 1px var(--card), 0 0 0 2px var(--accent);
  }
  .trajectory-span.search-dim { opacity: .16; }
  .trajectory-range {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 1;
    min-width: 1px;
    background: color-mix(in srgb, var(--accent) 13%, transparent);
    border-left: 1px solid var(--accent);
    border-right: 1px solid var(--accent);
    pointer-events: none;
  }
  .trajectory-range[hidden] { display: none; }
  .trajectory-range[data-dragging="true"] {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
  }
  .trajectory-range-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 23px;
    padding: 0 7px;
    border: 1px solid var(--accent-ring);
    border-radius: 5px;
    background: var(--accent-soft);
    color: var(--accent-2);
    font-family: var(--font-ui);
    font-size: 9px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .trajectory-range-badge:hover { border-color: var(--accent); }
  .trajectory-range-badge[hidden] { display: none !important; }
  .trajectory-range-badge .i { width: 10px; height: 10px; }
  .trajectory-tip {
    position: fixed;
    z-index: 2000;
    width: max-content;
    max-width: 340px;
    padding: 8px 10px;
    border: 1px solid var(--line-strong);
    border-radius: 7px;
    background: var(--card);
    box-shadow: 0 8px 28px rgba(0, 0, 0, .18);
    color: var(--ink-2);
    font-size: 9.5px;
    line-height: 1.55;
    pointer-events: none;
  }
  .trajectory-tip[hidden] { display: none !important; }
  .trajectory-tip-title { font-weight: 700; color: var(--ink); }
  .trajectory-tip-time { font-family: var(--font-mono); font-size: 9px; color: var(--ink-3); }
  .trajectory-tip-preview {
    margin-top: 3px;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-3);
  }
  .trajectory-scroll {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--card);
    border: 1px solid var(--line-strong);
    border-radius: 9px;
    box-shadow: var(--shadow-node);
  }
  .trajectory-canvas { position: relative; width: 100%; }
  .trajectory-row {
    position: absolute;
    left: 0;
    right: 0;
    width: 100%;
    height: 46px;
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    padding: 0 11px;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    color: var(--ink);
    font-family: var(--font-ui);
    text-align: left;
    cursor: pointer;
  }
  .trajectory-row:hover { background: var(--hover); }
  .trajectory-row.sel { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
  .trajectory-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .trajectory-role {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    justify-self: start;
    font-size: 8.5px;
    font-weight: 650;
    letter-spacing: .04em;
    color: var(--ink-3);
    white-space: nowrap;
  }
  .trajectory-role .i { width: 11px; height: 11px; }
  .trajectory-role.assistant { color: #7b5cc7; }
  .trajectory-role.tool { color: var(--accent-2); }
  [data-theme="dark"] .trajectory-role.assistant { color: #b49aef; }
  .trajectory-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .trajectory-title, .trajectory-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trajectory-title { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-2); }
  .trajectory-sub { font-family: var(--font-mono); font-size: 9px; color: var(--ink-4); }
  .trajectory-row.tool .trajectory-title { color: var(--accent-2); }
  .trajectory-row.tool.error .trajectory-title { color: var(--code-null); }
  .trajectory-row.summary { background: color-mix(in srgb, var(--hover) 58%, transparent); }
  .trajectory-row.summary:hover { background: var(--hover-strong); }
  .trajectory-row.summary .trajectory-role { color: var(--ink-4); }
  .trajectory-row.summary .trajectory-title { color: var(--ink-3); }
  .trajectory-row.summary .trajectory-title b { color: var(--ink-2); font-weight: 600; }
  .trajectory-row.summary .trajectory-tail { color: var(--ink-3); }
  .trajectory-tail {
    font-family: var(--font-mono);
    font-size: 8.5px;
    color: var(--ink-4);
    white-space: nowrap;
  }
  .trajectory-tail.err { color: var(--code-null); }
  .trajectory-tail.pending { color: var(--accent-2); }
  .trajectory-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    color: var(--ink-3);
    font-size: 10px;
    text-align: center;
    line-height: 1.7;
  }
  .trajectory-empty[hidden] { display: none !important; }
  .trajectory-inspector {
    flex: 0 0 380px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--card-2);
    border: 0;
    border-left: 1px solid var(--line);
    border-radius: 0;
    box-shadow: none;
    overflow: hidden;
  }
  .buddy-trajectory.inspector-hidden .trajectory-inspector,
  .buddy-trajectory.inspector-hidden .cmp-splitter { display: none; }
  .trajectory-inspector-head {
    flex: 0 0 39px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    border-bottom: 1px solid var(--line);
  }
  .trajectory-inspector-kind {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .trajectory-inspector-kind.user { color: var(--ink-3); }
  .trajectory-inspector-kind.assistant { color: #7b5cc7; }
  .trajectory-inspector-kind.tool { color: var(--accent-2); }
  [data-theme="dark"] .trajectory-inspector-kind.assistant { color: #b49aef; }
  .trajectory-inspector-meta { font-size: 9px; color: var(--ink-3); white-space: nowrap; }
  .trajectory-inspector-head .spacer { flex: 1; }
  .trajectory-inspector-close {
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    color: var(--ink-4);
  }
  .trajectory-inspector-close .i { color: var(--ink-4); }
  .trajectory-inspector-close:hover { color: var(--ink-2); }
  .trajectory-inspector-close:hover .i { color: var(--ink-2); }
  .trajectory-tabs {
    flex: 0 0 43px;
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 0 8px;
    background: var(--chrome);
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
  }
  .trajectory-tab {
    padding: 0 8px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--ink-3);
    font-family: var(--font-ui);
    font-size: 10.5px;
    white-space: nowrap;
    cursor: pointer;
  }
  .trajectory-tab:hover { color: var(--ink); }
  .trajectory-tab.on { color: var(--ink); border-bottom-color: var(--accent); }
  .trajectory-inspector-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin: 10px 11px 11px;
    padding: 10px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: var(--shadow-sm);
  }
  .trajectory-detail-section { margin-bottom: 11px; }
  .trajectory-detail-label {
    margin-bottom: 4px;
    font-size: 7.5px;
    font-weight: 650;
    letter-spacing: .07em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .trajectory-detail-value { font-size: 10.5px; line-height: 1.65; color: var(--ink-2); word-break: break-word; }
  .trajectory-detail-value code { font-family: var(--font-mono); font-size: 9.5px; color: var(--ink); }
  .trajectory-pre {
    margin: 0;
    max-width: 100%;
    overflow: auto;
    padding: 8px 9px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--card-2);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: 9.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .trajectory-markdown {
    max-width: 100%;
    padding: 8px 9px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--card-2);
    color: var(--ink-2);
    font-family: var(--font-ui);
    font-size: 10px;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }
  .trajectory-markdown p { margin: 0 0 6px; }
  .trajectory-markdown p:last-child { margin-bottom: 0; }
  .trajectory-markdown code {
    padding: 1px 3px;
    border-radius: 3px;
    background: var(--hover-strong);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: 9.5px;
  }
  .trajectory-status {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--hover-strong);
    color: var(--ink-2);
    font-size: 8.5px;
    font-weight: 650;
  }
  .trajectory-status.err { color: var(--code-null); background: var(--accent-soft); }
  .trajectory-status.pending { color: var(--accent-2); background: var(--accent-wash); }
  .trajectory-meta-line {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 10px;
    color: var(--ink-3);
    font-family: var(--font-mono);
    font-size: 9px;
  }
  .trajectory-splitter { flex: 0 0 5px; }
`;
document.head.appendChild(trajectoryStyle);

function trajectoryIsZh(): boolean {
  return document.getElementById("app")?.dataset.lang === "zh";
}

function trajectoryText(english: string, chinese: string): string {
  return trajectoryIsZh() ? chinese : english;
}

function trajectoryOneLine(value: unknown, limit = 220): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function trajectoryStatus(call: ConversationToolCall): {
  label: string;
  short: string;
  className: string;
} {
  if (call.status === "error") {
    return { label: trajectoryText("Failed", "失败"), short: trajectoryText("error", "错误"), className: "err" };
  }
  if (call.status === "pending") {
    return { label: trajectoryText("Running", "运行中"), short: trajectoryText("running", "运行中"), className: "pending" };
  }
  return {
    label: trajectoryText("Completed", "已完成"),
    short: call.durationMs != null ? `${call.durationMs} ms` : trajectoryText("done", "完成"),
    className: ""
  };
}

function trajectoryPretty(raw: string, limit = 120_000): string {
  const text = String(raw ?? "");
  if (!text.trim()) return "";
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Arguments may be plain text.
  }
  return pretty.length > limit ? `${pretty.slice(0, limit)}\n…` : pretty;
}

function trajectoryInferSchema(value: unknown, depth = 0): unknown {
  if (depth > 5) return {};
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length ? trajectoryInferSchema(value[0], depth + 1) : {}
    };
  }
  if (typeof value === "object") {
    const properties: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = trajectoryInferSchema(item, depth + 1);
    }
    return { type: "object", properties };
  }
  return { type: typeof value };
}

function buildTrajectoryEntries(): TrajectoryEntry[] {
  const conversation = buddyConversation;
  if (!conversation) return [];
  const calls = new Map(conversation.toolCalls.map((call) => [call.id, call]));
  const usedCalls = new Set<string>();
  const seenKeys = new Set<string>();
  const entries: TrajectoryEntry[] = [];
  let round = 0;

  const push = (entry: Omit<TrajectoryEntry, "index" | "step" | "round">) => {
    let key = entry.key;
    let suffix = 1;
    while (seenKeys.has(key)) {
      suffix += 1;
      key = `${entry.key}#${suffix}`;
    }
    seenKeys.add(key);
    const index = entries.length;
    entries.push({ ...entry, key, index, step: index + 1, round: Math.max(1, round) });
  };

  for (const message of conversation.messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const text = message.text.trim();
      if (!text) continue;
      round += 1;
      push({
        key: `u:${message.id}`,
        kind: "user",
        line: message.line,
        timestamp: message.timestamp,
        text,
        message
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    if (round === 0) round = 1;
    push({
      key: `a:${message.id}`,
      kind: "assistant",
      line: message.line,
      timestamp: message.timestamp,
      text: message.text,
      reasoning: message.reasoning,
      model: message.model,
      message
    });
    for (const id of message.toolCalls) {
      const call = calls.get(id);
      if (!call || usedCalls.has(call.id)) continue;
      usedCalls.add(call.id);
      push({
        key: `t:${call.id}`,
        kind: "tool",
        line: call.line,
        timestamp: call.timestamp,
        text: call.name,
        call
      });
    }
  }

  for (const call of conversation.toolCalls) {
    if (usedCalls.has(call.id)) continue;
    push({
      key: `t:${call.id}`,
      kind: "tool",
      line: call.line,
      timestamp: call.timestamp,
      text: call.name,
      call
    });
  }
  return entries;
}

function trajectoryRoundGroups(entries: TrajectoryEntry[]): Array<{ round: number; items: TrajectoryEntry[] }> {
  const groups: Array<{ round: number; items: TrajectoryEntry[] }> = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.round === entry.round) last.items.push(entry);
    else groups.push({ round: entry.round, items: [entry] });
  }
  return groups;
}

function trajectoryCollapsibleTurnIds(): number[] {
  return trajectoryRoundGroups(trajectoryAllEntries)
    .filter((group) => group.items.length > 1)
    .map((group) => group.round);
}

function trajectoryCollapsibleAssistantIds(): string[] {
  const toolIds = new Set(
    trajectoryAllEntries
      .filter((entry) => entry.kind === "tool" && entry.call?.id)
      .map((entry) => entry.call!.id)
  );
  return trajectoryAllEntries
    .filter(
      (entry) =>
        entry.kind === "assistant" &&
        (entry.message?.toolCalls ?? []).some((id) => toolIds.has(id))
    )
    .map((entry) => entry.key);
}

function trajectoryTurnSummary(items: TrajectoryEntry[]): { text: string; steps: number; tools: number } {
  const steps = items.filter((entry) => entry.kind === "assistant").length;
  const tools = items.filter((entry) => entry.kind === "tool").length;
  const stepLabel = trajectoryText(
    `${steps} ${steps === 1 ? "step" : "steps"}`,
    `${steps} 个步骤`
  );
  const toolLabel = trajectoryText(
    `${tools} ${tools === 1 ? "tool call" : "tool calls"}`,
    `${tools} 个工具调用`
  );
  return { text: `${stepLabel} · ${toolLabel}`, steps, tools };
}

function trajectoryCallsSummary(tools: TrajectoryEntry[]): string {
  const names = [...new Set(tools.map((entry) => entry.call?.name).filter(Boolean))];
  const label = trajectoryText(
    `${tools.length} ${tools.length === 1 ? "tool call" : "tool calls"}`,
    `${tools.length} 个工具调用`
  );
  return names.length ? `${label} · ${names.join(", ")}` : label;
}

function trajectoryBuildDisplayRows(entries: TrajectoryEntry[]): TrajectoryDisplayRow[] {
  const rows: TrajectoryDisplayRow[] = [];
  for (const group of trajectoryRoundGroups(entries)) {
    if (trajectoryCollapsedTurns.has(group.round) && group.items.length > 1) {
      const first = group.items[0];
      if (!first) continue;
      const hidden = group.items.slice(1);
      const summary = trajectoryTurnSummary(hidden);
      rows.push(first);
      rows.push({
        kind: "summary",
        key: `summary:turn:${group.round}`,
        summaryKind: "turn",
        group: String(group.round),
        round: group.round,
        step: first.step,
        line: hidden[hidden.length - 1]?.line ?? first.line,
        count: hidden.length,
        toolCount: summary.tools,
        text: summary.text
      });
      continue;
    }
    for (let index = 0; index < group.items.length; index += 1) {
      const entry = group.items[index];
      if (!entry) continue;
      rows.push(entry);
      if (entry.kind !== "assistant" || !trajectoryCollapsedAssistants.has(entry.key)) continue;
      const ids = new Set(entry.message?.toolCalls ?? []);
      const tools: TrajectoryEntry[] = [];
      let cursor = index + 1;
      while (cursor < group.items.length) {
        const candidate = group.items[cursor];
        if (!candidate || candidate.kind !== "tool") break;
        if (ids.size && candidate.call?.id && !ids.has(candidate.call.id)) break;
        tools.push(candidate);
        cursor += 1;
      }
      if (!tools.length) continue;
      rows.push({
        kind: "summary",
        key: `summary:calls:${entry.key}`,
        summaryKind: "calls",
        group: entry.key,
        round: entry.round,
        step: entry.step,
        line: tools[tools.length - 1]?.line ?? entry.line,
        count: tools.length,
        toolCount: tools.length,
        text: trajectoryCallsSummary(tools)
      });
      index = cursor - 1;
    }
  }
  return rows;
}

function trajectoryAllTurnsCollapsed(): boolean {
  const ids = trajectoryCollapsibleTurnIds();
  return ids.length > 0 && ids.every((id) => trajectoryCollapsedTurns.has(id));
}

function trajectoryAllCallsCollapsed(): boolean {
  const ids = trajectoryCollapsibleAssistantIds();
  return ids.length > 0 && ids.every((id) => trajectoryCollapsedAssistants.has(id));
}

function trajectoryUpdateToggleControls(): void {
  const duration = document.getElementById("trajectoryDurationToggle") as HTMLButtonElement | null;
  const turns = document.getElementById("trajectoryTurnsToggle") as HTMLButtonElement | null;
  const calls = document.getElementById("trajectoryCallsToggle") as HTMLButtonElement | null;
  if (duration) {
    duration.setAttribute("aria-pressed", trajectoryActualDuration ? "true" : "false");
    duration.title = trajectoryText(
      trajectoryActualDuration ? "Use equal-width operations" : "Use actual duration",
      trajectoryActualDuration ? "使用等宽操作" : "使用实际时长"
    );
    duration.setAttribute("aria-label", duration.title);
    duration.disabled = trajectoryAllEntries.length === 0;
  }
  if (turns) {
    const collapsible = trajectoryCollapsibleTurnIds();
    const collapsed = trajectoryAllTurnsCollapsed();
    turns.disabled = collapsible.length === 0;
    turns.setAttribute("aria-pressed", collapsed ? "true" : "false");
    turns.title = trajectoryText(
      collapsed ? "Expand all turns" : "Collapse all turns",
      collapsed ? "展开所有轮次" : "收起所有轮次"
    );
    turns.setAttribute("aria-label", turns.title);
  }
  if (calls) {
    const collapsible = trajectoryCollapsibleAssistantIds();
    const collapsed = trajectoryAllCallsCollapsed();
    calls.disabled = collapsible.length === 0;
    calls.setAttribute("aria-pressed", collapsed ? "true" : "false");
    calls.title = trajectoryText(
      collapsed ? "Expand all calls" : "Collapse all calls",
      collapsed ? "展开所有调用" : "收起所有调用"
    );
    calls.setAttribute("aria-label", calls.title);
  }
}

function trajectoryRefreshDisplayRows(): void {
  trajectoryDisplayRows = trajectoryBuildDisplayRows(trajectoryVisibleEntries);
  trajectoryUpdateToggleControls();
  trajectoryPaintRows();
}

function trajectoryToggleTurn(round: number): void {
  if (trajectoryCollapsedTurns.has(round)) trajectoryCollapsedTurns.delete(round);
  else trajectoryCollapsedTurns.add(round);
  trajectoryRefreshDisplayRows();
}

function trajectoryToggleAllTurns(): void {
  const ids = trajectoryCollapsibleTurnIds();
  if (!ids.length) return;
  if (trajectoryAllTurnsCollapsed()) {
    for (const id of ids) trajectoryCollapsedTurns.delete(id);
  } else {
    for (const id of ids) trajectoryCollapsedTurns.add(id);
  }
  trajectoryRefreshDisplayRows();
}

function trajectoryToggleAssistant(key: string): void {
  if (trajectoryCollapsedAssistants.has(key)) trajectoryCollapsedAssistants.delete(key);
  else trajectoryCollapsedAssistants.add(key);
  trajectoryRefreshDisplayRows();
}

function trajectoryToggleAllCalls(): void {
  const ids = trajectoryCollapsibleAssistantIds();
  if (!ids.length) return;
  if (trajectoryAllCallsCollapsed()) {
    for (const id of ids) trajectoryCollapsedAssistants.delete(id);
  } else {
    for (const id of ids) trajectoryCollapsedAssistants.add(id);
  }
  trajectoryRefreshDisplayRows();
}

function trajectoryRevealEntry(entry: TrajectoryEntry): void {
  let changed = false;
  if (trajectoryCollapsedTurns.delete(entry.round)) changed = true;
  if (entry.kind === "tool" && entry.call?.id) {
    const parent = trajectoryAllEntries.find(
      (candidate) =>
        candidate.kind === "assistant" &&
        (candidate.message?.toolCalls ?? []).includes(entry.call!.id)
    );
    if (parent && trajectoryCollapsedAssistants.delete(parent.key)) changed = true;
  }
  if (changed) trajectoryRefreshDisplayRows();
}

function trajectoryEntryMatches(entry: TrajectoryEntry, query: string): boolean {
  if (!query) return true;
  const fields = [
    entry.kind,
    entry.text,
    entry.reasoning,
    entry.model,
    entry.call?.name,
    entry.call?.arguments,
    entry.call?.output,
    entry.call?.status,
    entry.round,
    entry.step,
    entry.line
  ];
  return fields.some((value) => String(value ?? "").toLowerCase().includes(query));
}

function trajectoryRoleLabel(entry: TrajectoryEntry): string {
  if (entry.kind === "tool") return trajectoryText("Tool", "工具");
  if (entry.kind === "user") return trajectoryText("User", "用户");
  return trajectoryText("Assistant", "助手");
}

function trajectoryEntryTitle(entry: TrajectoryEntry): string {
  if (entry.kind === "tool") return entry.call?.name || "tool";
  const text = trajectoryOneLine(entry.text, 240);
  if (text) return text;
  if (entry.reasoning) return trajectoryOneLine(entry.reasoning, 240);
  return trajectoryText("Tool calls only", "仅工具调用");
}

function trajectoryEntrySub(entry: TrajectoryEntry): string {
  if (entry.kind === "tool" && entry.call) {
    const args = trajectoryOneLine(chatToolSummary(entry.call), 150);
    const output = trajectoryOneLine(entry.call.output, 110);
    return [args, output ? `→ ${output}` : ""].filter(Boolean).join("  ");
  }
  const pieces: string[] = [];
  if (entry.kind === "assistant") {
    if (entry.model) pieces.push(entry.model);
    const tools = entry.message?.toolCalls.length ?? 0;
    if (tools) pieces.push(`${tools} ${trajectoryText(tools === 1 ? "tool" : "tools", "个工具")}`);
    if (entry.reasoning) pieces.push(trajectoryText("thinking", "思考"));
  }
  const time = chatTime(entry.timestamp);
  if (time) pieces.push(time);
  return pieces.join(" · ");
}

function trajectoryEntryTail(entry: TrajectoryEntry): { text: string; className: string } {
  if (entry.kind === "tool" && entry.call) {
    const status = trajectoryStatus(entry.call);
    return { text: status.short, className: status.className };
  }
  return { text: chatTime(entry.timestamp), className: "" };
}

function trajectorySummaryRowHtml(row: TrajectorySummary, position: number): string {
  const turn = row.summaryKind === "turn";
  const role = turn ? trajectoryText("Turn", "轮次") : trajectoryText("Calls", "调用");
  const action = turn
    ? trajectoryText("Expand this turn", "展开此轮次")
    : trajectoryText("Expand these calls", "展开这些调用");
  const icon = turn ? "i-fold" : "i-wrench";
  return `<button type="button" class="trajectory-row summary ${row.summaryKind}" data-trajectory-summary="${row.summaryKind}" data-trajectory-summary-group="${w.escHtml(
    row.group
  )}" aria-label="${w.escHtml(action)}" title="${w.escHtml(action)}" style="top:${
    position * TRAJECTORY_ROW_HEIGHT
  }px">
    <span class="trajectory-role summary"><svg class="i" viewBox="0 0 24 24"><use href="#${icon}"/></svg>${w.escHtml(
      role
    )}</span>
    <span class="trajectory-copy">
      <span class="trajectory-title">… <b>${w.escHtml(row.text)}</b></span>
      <span class="trajectory-sub">#L${row.line}</span>
    </span>
    <span class="trajectory-tail">+</span>
  </button>`;
}

function trajectoryRowHtml(row: TrajectoryDisplayRow, position: number): string {
  if (row.kind === "summary") return trajectorySummaryRowHtml(row, position);
  const entry = row;
  const role = trajectoryRoleLabel(entry);
  const title = trajectoryEntryTitle(entry);
  const sub = trajectoryEntrySub(entry);
  const tail = trajectoryEntryTail(entry);
  const icon = entry.kind === "tool" ? "i-wrench" : entry.kind === "user" ? "i-message" : "i-sparkle";
  return `<button type="button" class="trajectory-row ${entry.kind}${
    entry.call?.status === "error" ? " error" : ""
  }${entry.key === trajectorySelectedKey ? " sel" : ""}" data-trajectory-key="${w.escHtml(
    entry.key
  )}" style="top:${position * TRAJECTORY_ROW_HEIGHT}px">
    <span class="trajectory-role ${entry.kind}"><svg class="i" viewBox="0 0 24 24"><use href="#${icon}"/></svg>${w.escHtml(
      role
    )}</span>
    <span class="trajectory-copy">
      <span class="trajectory-title">${w.escHtml(title)}</span>
      <span class="trajectory-sub">${w.escHtml(sub)}</span>
    </span>
    <span class="trajectory-tail${tail.className ? ` ${tail.className}` : ""}">${w.escHtml(
      tail.text
    )}</span>
  </button>`;
}

function trajectoryPaintRows(): void {
  const canvas = document.getElementById("trajectoryRows");
  const scroller = document.getElementById("trajectoryScroll");
  const empty = document.getElementById("trajectoryEmpty");
  if (!canvas || !scroller) return;
  const total = trajectoryDisplayRows.length;
  canvas.style.height = `${total * TRAJECTORY_ROW_HEIGHT}px`;
  if (empty) empty.hidden = total > 0;
  if (!total) {
    canvas.innerHTML = "";
    return;
  }
  const maxScrollTop = Math.max(0, total * TRAJECTORY_ROW_HEIGHT - scroller.clientHeight);
  const viewTop = Math.min(scroller.scrollTop, maxScrollTop);
  if (scroller.scrollTop > viewTop) scroller.scrollTop = viewTop;
  const start = Math.max(
    0,
    Math.floor(viewTop / TRAJECTORY_ROW_HEIGHT) - TRAJECTORY_OVERSCAN
  );
  const end = Math.min(
    total,
    Math.ceil(
      (viewTop + Math.max(scroller.clientHeight, TRAJECTORY_ROW_HEIGHT)) /
        TRAJECTORY_ROW_HEIGHT
    ) + TRAJECTORY_OVERSCAN
  );
  let html = "";
  for (let index = start; index < end; index += 1) {
    const row = trajectoryDisplayRows[index];
    if (row) html += trajectoryRowHtml(row, index);
  }
  canvas.innerHTML = html;
}

function scheduleTrajectoryPaint(): void {
  if (trajectoryPaintFrame != null) return;
  trajectoryPaintFrame = window.requestAnimationFrame(() => {
    trajectoryPaintFrame = null;
    trajectoryPaintRows();
  });
}

function trajectoryScrollToEntry(key: string): void {
  const scroller = document.getElementById("trajectoryScroll");
  if (!scroller) return;
  const index = trajectoryDisplayRows.findIndex(
    (row) => row.kind !== "summary" && row.key === key
  );
  if (index < 0) return;
  scroller.scrollTop = Math.max(
    0,
    index * TRAJECTORY_ROW_HEIGHT - Math.max(0, scroller.clientHeight / 3)
  );
  scheduleTrajectoryPaint();
}

function trajectorySelect(key: string, reveal = true): void {
  const entry = trajectoryAllEntries.find((item) => item.key === key);
  if (!entry) return;
  if (!trajectoryDisplayRows.some((row) => row.kind !== "summary" && row.key === key)) {
    trajectoryRevealEntry(entry);
  }
  trajectorySelectedKey = key;
  trajectoryInspectorHidden = false;
  trajectoryActiveTab = "overview";
  trajectoryFollow = false;
  if (reveal) trajectoryScrollToEntry(key);
  renderTrajectoryInspector();
  trajectoryPaintRows();
}

function trajectoryMetricDuration(): string {
  return buddyConversation
    ? chatDuration(buddyConversation.startedAt, buddyConversation.endedAt)
    : "—";
}

function trajectoryTimestampMs(entry: TrajectoryEntry): number | null {
  if (!entry.timestamp) return null;
  const value = Date.parse(entry.timestamp);
  return Number.isFinite(value) ? value : null;
}

function trajectorySequenceTimeline(entries: TrajectoryEntry[]): TrajectoryTimelineModel {
  const total = Math.max(1, entries.length);
  return {
    mode: "sequence",
    spans: entries.map((entry) => ({
      entry,
      left: entry.index / total,
      width: 1 / total
    })),
    minimumWindow: Math.min(1, 1 / total)
  };
}

function trajectoryBuildTimelineModel(entries: TrajectoryEntry[]): TrajectoryTimelineModel {
  if (!trajectoryActualDuration || entries.length < 2) return trajectorySequenceTimeline(entries);
  const timed: Array<{ entry: TrajectoryEntry; start: number; end: number }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const start = trajectoryTimestampMs(entry);
    if (start === null) continue;
    let end = start;
    if (entry.kind === "tool" && entry.call?.durationMs != null) {
      const duration = Number(entry.call.durationMs);
      if (Number.isFinite(duration)) end = start + Math.max(0, duration);
    } else if (entry.kind === "assistant") {
      const next = entries[index + 1];
      if (next?.kind === "tool" && next.round === entry.round) {
        const nextStart = trajectoryTimestampMs(next);
        if (nextStart !== null) end = Math.max(start, nextStart);
      }
    }
    timed.push({ entry, start, end });
  }
  if (timed.length < 2) return trajectorySequenceTimeline(entries);
  const sorted = [...timed].sort((left, right) => left.start - right.start || left.end - right.end);
  const offsets = new Map<(typeof timed)[number], number>();
  let removedIdle = 0;
  let coveredUntil: number | null = null;
  for (const span of sorted) {
    if (coveredUntil !== null && span.start > coveredUntil) removedIdle += span.start - coveredUntil;
    offsets.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }
  const projected = timed.map((span) => {
    const offset = offsets.get(span) ?? 0;
    return {
      entry: span.entry,
      start: span.start - offset,
      end: Math.max(span.start, span.end) - offset
    };
  });
  const domainStart = Math.min(...projected.map((span) => span.start));
  const domainEnd = Math.max(...projected.map((span) => span.end));
  const domain = domainEnd - domainStart;
  if (!(domain > 0)) return trajectorySequenceTimeline(entries);
  const byEntry = new Map(projected.map((span) => [span.entry.key, span]));
  let lastLeft = 0;
  const spans = entries.map((entry) => {
    const span = byEntry.get(entry.key);
    if (!span) return { entry, left: lastLeft, width: 0 };
    lastLeft = (span.start - domainStart) / domain;
    return {
      entry,
      left: lastLeft,
      width: Math.max(0, (span.end - span.start) / domain)
    };
  });
  return {
    mode: "duration",
    spans,
    minimumWindow: Math.min(1, 20 / domain)
  };
}

function trajectoryTimelineView(): { start: number; end: number } {
  const view = trajectoryViewport;
  if (!view || !(view.end > view.start)) return { start: 0, end: 1 };
  return {
    start: Math.max(0, view.start),
    end: Math.min(1, view.end)
  };
}

function trajectoryViewFraction(fraction: number): number {
  const view = trajectoryTimelineView();
  const value = Math.max(0, Math.min(1, fraction));
  return view.start + value * (view.end - view.start);
}

function clampTrajectoryViewport(): void {
  if (!trajectoryViewport) return;
  const minimum = Math.max(0.0001, Math.min(1, trajectoryTimelineModel?.minimumWindow ?? 0.01));
  const size = Math.max(minimum, Math.min(1, trajectoryViewport.end - trajectoryViewport.start));
  if (size >= 0.999) {
    trajectoryViewport = null;
    return;
  }
  const start = Math.max(0, Math.min(1 - size, trajectoryViewport.start));
  trajectoryViewport = { start, end: start + size };
}

function trajectoryTimelineHtml(): string {
  const model = trajectoryTimelineModel;
  const view = trajectoryTimelineView();
  const viewSize = Math.max(0.000001, view.end - view.start);
  const spans = (model?.spans ?? [])
    .filter(
      (span) =>
        span.left + span.width >= view.start - 1e-9 &&
        span.left <= view.end + 1e-9
    )
    .map((span) => ({
      ...span,
      left: (span.left - view.start) / viewSize,
      width: span.width / viewSize
    }));
  const queryInput = document.getElementById("monitorFilter") as HTMLInputElement | null;
  const query = String(queryInput?.value ?? "").trim().toLowerCase();
  const spanHtml = (span: TrajectoryTimelineSpan) => {
    const entry = span.entry;
    const status = entry.call ? trajectoryStatus(entry.call) : null;
    const classes = [
      "trajectory-span",
      entry.kind,
      status?.className === "err" ? "error" : "",
      trajectoryRange &&
      (entry.index < trajectoryRange.start || entry.index > trajectoryRange.end)
        ? "outside"
        : "",
      entry.key === trajectorySelectedKey ? "current" : "",
      query && !trajectoryEntryMatches(entry, query) ? "search-dim" : ""
    ]
      .filter(Boolean)
      .join(" ");
    const label = `${trajectoryRoleLabel(entry)} · ${trajectoryText(
      `Round ${entry.round}`,
      `第 ${entry.round} 轮`
    )} · ${trajectoryText(`Step ${entry.step}`, `第 ${entry.step} 步`)}${
      entry.call ? ` · ${entry.call.name}` : ""
    }`;
    return `<span class="${classes}" data-trajectory-key="${w.escHtml(
      entry.key
    )}" data-trajectory-index="${entry.index}" role="presentation" aria-label="${w.escHtml(
      label
    )}" style="left:${span.left * 100}%;width:max(3px, calc(${span.width * 100}% - 2px))"></span>`;
  };
  const lane = (label: string, kind: TrajectoryEntryKind) => {
    const items = spans.filter((span) => span.entry.kind === kind);
    const stride =
      items.length > TRAJECTORY_TIMELINE_SAMPLE
        ? Math.ceil(items.length / TRAJECTORY_TIMELINE_SAMPLE)
        : 1;
    const sampled =
      stride > 1
        ? items.filter((_, index) => index % stride === 0 || index === items.length - 1)
        : items;
    return `<div class="trajectory-lane"><span class="trajectory-lane-label">${w.escHtml(
      label
    )}</span><div class="trajectory-track"><div class="trajectory-range" hidden></div>${sampled
      .map(spanHtml)
      .join("")}</div></div>`;
  };
  return (
    lane(trajectoryText("Input", "输入"), "user") +
    lane(trajectoryText("Model", "模型"), "assistant") +
    lane(trajectoryText("Tools", "工具"), "tool")
  );
}


function trajectoryCurrentQuery(): string {
  const input = document.getElementById("monitorFilter") as HTMLInputElement | null;
  return String(input?.value ?? "").trim().toLowerCase();
}

function trajectoryFilterEntries(query = trajectoryCurrentQuery()): TrajectoryEntry[] {
  return trajectoryAllEntries.filter((entry) => {
    if (trajectoryRange && (entry.index < trajectoryRange.start || entry.index > trajectoryRange.end)) {
      return false;
    }
    return !query || trajectoryEntryMatches(entry, query);
  });
}

function trajectoryRangeEntries(): TrajectoryEntry[] {
  if (!trajectoryRange) return [];
  return trajectoryAllEntries.filter(
    (entry) => entry.index >= trajectoryRange!.start && entry.index <= trajectoryRange!.end
  );
}

function updateTrajectoryRangeChrome(): void {
  const badge = document.getElementById("trajectoryRangeBadge");
  const label = document.getElementById("trajectoryRangeText");
  if (!badge || !label) return;
  if (!trajectoryRange) {
    badge.hidden = true;
    return;
  }
  const count = trajectoryRangeEntries().length;
  badge.hidden = false;
  label.textContent = trajectoryText(`Range · ${count}`, `区间 · ${count}`);
  badge.title = trajectoryText("Clear range filter (Esc)", "清除区间过滤 (Esc)");
}

function trajectoryTimelineSpanAt(fraction: number): TrajectoryTimelineSpan | null {
  const spans = trajectoryTimelineModel?.spans ?? [];
  if (!spans.length) return null;
  const value = Math.max(0, Math.min(1, fraction));
  let best = spans[0] ?? null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    const right = span.left + span.width;
    if (value >= span.left - 1e-9 && value <= right + 1e-9) return span;
    const distance = Math.min(Math.abs(value - span.left), Math.abs(value - right));
    if (distance < bestDistance) {
      best = span;
      bestDistance = distance;
    }
  }
  return best;
}

function trajectoryRangeIndexesAtFractions(
  startFraction: number,
  endFraction: number
): [number, number] | null {
  const spans = trajectoryTimelineModel?.spans ?? [];
  if (!spans.length) return null;
  const from = Math.max(0, Math.min(1, Math.min(startFraction, endFraction)));
  const to = Math.max(0, Math.min(1, Math.max(startFraction, endFraction)));
  const indexes = spans
    .filter((span) => span.left + span.width >= from - 1e-9 && span.left <= to + 1e-9)
    .map((span) => span.entry.index);
  if (!indexes.length) {
    const first = trajectoryTimelineSpanAt(from);
    const last = trajectoryTimelineSpanAt(to);
    if (first) indexes.push(first.entry.index);
    if (last) indexes.push(last.entry.index);
  }
  if (!indexes.length) return null;
  return [Math.min(...indexes), Math.max(...indexes)];
}

function updateTrajectoryTimelineFocus(): void {
  const total = Math.max(1, trajectoryAllEntries.length);
  const query = trajectoryCurrentQuery();
  const draft = trajectoryDraft;
  const draftRange = draft
    ? trajectoryRangeIndexesAtFractions(draft.startFraction, draft.endFraction)
    : null;
  document.querySelectorAll<HTMLElement>(".trajectory-span").forEach((span) => {
    const index = Number(span.dataset.trajectoryIndex);
    let outside = false;
    if (draftRange) {
      outside = index < draftRange[0] || index > draftRange[1];
    } else if (trajectoryRange) {
      outside = index < trajectoryRange.start || index > trajectoryRange.end;
    }
    span.classList.toggle("outside", outside);
    span.classList.toggle("current", span.dataset.trajectoryKey === trajectorySelectedKey);
    const entry = trajectoryAllEntries[index];
    span.classList.toggle(
      "search-dim",
      !!query && !!entry && !trajectoryEntryMatches(entry, query)
    );
  });
  const fullSelection = draft
    ? {
        start: Math.min(draft.startFraction, draft.endFraction),
        end: Math.max(draft.startFraction, draft.endFraction)
      }
    : trajectoryRange
      ? (() => {
          const spans = (trajectoryTimelineModel?.spans ?? []).filter(
            (span) =>
              span.entry.index >= trajectoryRange!.start &&
              span.entry.index <= trajectoryRange!.end
          );
          if (spans.length) {
            return {
              start: Math.min(...spans.map((span) => span.left)),
              end: Math.max(...spans.map((span) => span.left + span.width))
            };
          }
          return {
            start: trajectoryRange.start / total,
            end: (trajectoryRange.end + 1) / total
          };
        })()
      : null;
  const view = trajectoryTimelineView();
  const viewSize = Math.max(0.000001, view.end - view.start);
  const selection = fullSelection
    ? {
        start: (fullSelection.start - view.start) / viewSize,
        end: (fullSelection.end - view.start) / viewSize
      }
    : null;
  document.querySelectorAll<HTMLElement>(".trajectory-range").forEach((bar) => {
    if (!selection) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.style.left = `${selection.start * 100}%`;
    bar.style.width = `${Math.max(0.2, (selection.end - selection.start) * 100)}%`;
    bar.dataset.dragging = draft ? "true" : "false";
  });
}

function renderTrajectoryTimeline(): void {
  const timeline = document.getElementById("trajectoryTimeline");
  if (!timeline) return;
  timeline.dataset.timelineMode = trajectoryTimelineModel?.mode ?? "sequence";
  timeline.dataset.timelineZoom = trajectoryViewport ? "custom" : "full";
  timeline.innerHTML = trajectoryAllEntries.length
    ? trajectoryTimelineHtml()
    : `<div class="trajectory-empty" style="position:static;padding:0">${trajectoryText(
        "No trajectory events",
        "没有轨迹事件"
      )}</div>`;
  updateTrajectoryTimelineFocus();
}

function scheduleTrajectoryTimelineRender(): void {
  if (trajectoryTimelineFrame !== null) return;
  trajectoryTimelineFrame = window.requestAnimationFrame(() => {
    trajectoryTimelineFrame = null;
    renderTrajectoryTimeline();
  });
}

function trajectoryZoomTimeline(clientX: number, deltaY: number): boolean {
  const model = trajectoryTimelineModel;
  const track = document.querySelector<HTMLElement>("#trajectoryTimeline .trajectory-track");
  if (!model || !track || !trajectoryAllEntries.length) return false;
  const rect = track.getBoundingClientRect();
  if (!(rect.width > 0)) return false;
  const local = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const view = trajectoryTimelineView();
  const size = view.end - view.start;
  const minimum = Math.max(0.0001, Math.min(1, model.minimumWindow));
  const next = Math.max(minimum, Math.min(1, size * Math.exp(deltaY * 0.0015)));
  if (next >= 0.999) {
    trajectoryViewport = null;
    return true;
  }
  const anchor = view.start + local * size;
  const start = Math.max(0, Math.min(1 - next, anchor - local * next));
  trajectoryViewport = { start, end: start + next };
  return true;
}

function hideTrajectoryTip(): void {
  const tip = document.getElementById("trajectoryTip");
  if (tip) tip.hidden = true;
}

function trajectoryClock(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3
  });
}

function trajectoryTipHtml(entry: TrajectoryEntry): string {
  const role = trajectoryRoleLabel(entry);
  const title = `${role}${
    entry.call ? ` · ${entry.call.name}` : entry.model ? ` · ${entry.model}` : ""
  }`;
  const start = trajectoryClock(entry.timestamp);
  let time = start;
  if (entry.call?.durationMs != null && entry.timestamp) {
    const startMs = new Date(entry.timestamp).getTime();
    if (Number.isFinite(startMs)) {
      time = `${start} → ${trajectoryClock(new Date(startMs + entry.call.durationMs).toISOString())}`;
    }
  }
  const details = [
    trajectoryText(`Round ${entry.round}`, `第 ${entry.round} 轮`),
    trajectoryText(`Step ${entry.step}`, `第 ${entry.step} 步`),
    entry.call?.durationMs != null
      ? trajectoryText(`Total ${entry.call.durationMs} ms`, `总计 ${entry.call.durationMs} 毫秒`)
      : "",
    entry.call ? trajectoryStatus(entry.call).label : ""
  ]
    .filter(Boolean)
    .join(" · ");
  const preview =
    entry.kind === "tool" && entry.call
      ? [chatToolSummary(entry.call), trajectoryOneLine(entry.call.output, 120)]
          .filter(Boolean)
          .join(" · ")
      : trajectoryOneLine(entry.text || entry.reasoning, 160);
  return `<div class="trajectory-tip-title">${w.escHtml(title)}</div>
    ${time ? `<div class="trajectory-tip-time">${w.escHtml(time)}</div>` : ""}
    <div class="trajectory-tip-time">${w.escHtml(details)}</div>
    ${preview ? `<div class="trajectory-tip-preview">${w.escHtml(preview)}</div>` : ""}`;
}

function showTrajectoryTip(entry: TrajectoryEntry, clientX: number, clientY: number): void {
  const tip = document.getElementById("trajectoryTip");
  if (!tip || !trajectoryModeActive()) return;
  tip.innerHTML = trajectoryTipHtml(entry);
  tip.hidden = false;
  const width = Math.min(340, tip.offsetWidth || 300);
  const height = tip.offsetHeight || 80;
  tip.style.left = `${Math.max(8, Math.min(clientX + 14, window.innerWidth - width - 12))}px`;
  tip.style.top = `${Math.max(8, Math.min(clientY + 14, window.innerHeight - height - 12))}px`;
}

function clearTrajectoryRange(): void {
  if (!trajectoryRange) return;
  trajectoryRange = null;
  trajectoryDraft = null;
  trajectoryVisibleEntries = trajectoryFilterEntries();
  const target =
    trajectoryVisibleEntries.find((entry) => entry.key === trajectorySelectedKey) ??
    trajectoryVisibleEntries[0];
  trajectorySelectedKey = target?.key ?? null;
  if (target) trajectoryInspectorHidden = false;
  trajectoryDisplayRows = trajectoryBuildDisplayRows(trajectoryVisibleEntries);
  updateTrajectoryRangeChrome();
  updateTrajectoryTimelineFocus();
  trajectoryPaintRows();
  renderTrajectoryInspector();
}

function applyTrajectoryRange(start: number, end: number): void {
  const total = trajectoryAllEntries.length;
  if (!total) return;
  trajectoryRange = {
    start: Math.max(0, Math.min(total - 1, Math.min(start, end))),
    end: Math.max(0, Math.min(total - 1, Math.max(start, end)))
  };
  trajectoryDraft = null;
  trajectoryFollow = false;
  trajectoryVisibleEntries = trajectoryFilterEntries();
  const target =
    trajectoryVisibleEntries.find((entry) => entry.key === trajectorySelectedKey) ??
    trajectoryVisibleEntries[0];
  trajectorySelectedKey = target?.key ?? null;
  if (target) {
    trajectoryInspectorHidden = false;
    trajectoryActiveTab = "overview";
  }
  const scroll = document.getElementById("trajectoryScroll");
  if (scroll) scroll.scrollTop = 0;
  trajectoryDisplayRows = trajectoryBuildDisplayRows(trajectoryVisibleEntries);
  updateTrajectoryRangeChrome();
  updateTrajectoryTimelineFocus();
  trajectoryPaintRows();
  renderTrajectoryInspector();
  hideTrajectoryTip();
}

function trajectoryHintForClick(fraction: number): TrajectoryEntry | null {
  return trajectoryTimelineSpanAt(fraction)?.entry ?? null;
}

function trajectoryPre(text: string, limit = 120_000): string {
  if (!text) return `<div class="trajectory-detail-value">—</div>`;
  const bounded = text.length > limit ? `${text.slice(0, limit)}\n…` : text;
  return `<pre class="trajectory-pre">${w.escHtml(bounded)}</pre>`;
}

function trajectoryDetailSection(label: string, value: string): string {
  return `<div class="trajectory-detail-section"><div class="trajectory-detail-label">${w.escHtml(
    label
  )}</div>${value}</div>`;
}

function trajectoryToolTabs(): string[] {
  return ["overview", "params", "result", "schema", "timing"];
}

function trajectoryEntryTabs(entry: TrajectoryEntry): string[] {
  return entry.kind === "tool" ? trajectoryToolTabs() : ["overview", "timing"];
}

function trajectoryTabLabel(tab: string): string {
  switch (tab) {
    case "params":
      return trajectoryText("Parameters", "参数");
    case "result":
      return trajectoryText("Result", "结果");
    case "schema":
      return "Schema";
    case "timing":
      return trajectoryText("Timing", "计时");
    default:
      return trajectoryText("Overview", "概述");
  }
}

function trajectoryInspectorBodyHtml(entry: TrajectoryEntry): string {
  const round = trajectoryText(`Round ${entry.round}`, `第 ${entry.round} 轮`);
  const step = trajectoryText(`Step ${entry.step}`, `第 ${entry.step} 步`);
  const time = chatTime(entry.timestamp) || "—";
  const call = entry.call;
  const status = call ? trajectoryStatus(call) : null;
  const args = call ? trajectoryPretty(call.arguments) : "";
  const output = call ? trajectoryPretty(call.output ?? "") : "";
  const schemaValue = (() => {
    if (!call?.arguments.trim()) return "";
    try {
      return JSON.stringify(trajectoryInferSchema(JSON.parse(call.arguments)), null, 2);
    } catch {
      return "";
    }
  })();

  if (trajectoryActiveTab === "params") {
    return trajectoryDetailSection(
      trajectoryText("Arguments", "参数"),
      trajectoryPre(args)
    );
  }
  if (trajectoryActiveTab === "result") {
    return trajectoryDetailSection(
      trajectoryText("Tool result", "工具结果"),
      trajectoryPre(output)
    );
  }
  if (trajectoryActiveTab === "schema") {
    return (
      trajectoryDetailSection(
        "Schema",
        schemaValue
          ? trajectoryPre(schemaValue)
          : `<div class="trajectory-detail-value">${trajectoryText(
              "No argument schema was recorded.",
              "没有记录参数 Schema。"
            )}</div>`
      ) +
      (schemaValue
        ? `<div class="trajectory-detail-value">${trajectoryText(
            "Inferred from recorded arguments.",
            "根据记录的参数推断。"
          )}</div>`
        : "")
    );
  }
  if (trajectoryActiveTab === "timing") {
    return (
      trajectoryDetailSection(
        trajectoryText("Timing", "计时"),
        `<div class="trajectory-meta-line"><span>${trajectoryText("Started", "开始")} ${w.escHtml(
          time
        )}</span><span>${trajectoryText("Duration", "时长")} ${
          call?.durationMs != null ? `${call.durationMs} ms` : "—"
        }</span><span>#L${entry.line}</span></div>`
      ) +
      trajectoryDetailSection(
        trajectoryText("Location", "位置"),
        `<div class="trajectory-detail-value">${w.escHtml(round)} · ${w.escHtml(step)}</div>`
      )
    );
  }

  if (call) {
    return (
      trajectoryDetailSection(
        trajectoryText("Hierarchy", "层级"),
        `<div class="trajectory-detail-value">${w.escHtml(
          trajectoryText("Assistant message", "助手消息")
        )} · ${w.escHtml(round)} · ${w.escHtml(step)}</div>`
      ) +
      trajectoryDetailSection(
        trajectoryText("Status", "状态"),
        `<span class="trajectory-status ${status?.className ?? ""}">${w.escHtml(
          status?.label ?? "—"
        )}</span>`
      ) +
      trajectoryDetailSection(trajectoryText("Arguments", "参数"), trajectoryPre(args, 2400)) +
      trajectoryDetailSection(trajectoryText("Result", "结果"), trajectoryPre(output, 2400)) +
      trajectoryDetailSection(
        "Schema",
        schemaValue
          ? trajectoryPre(schemaValue, 1600)
          : `<div class="trajectory-detail-value">${trajectoryText(
              "No argument schema was recorded.",
              "没有记录参数 Schema。"
            )}</div>`
      ) +
      trajectoryDetailSection(
        trajectoryText("Timing", "计时"),
        `<div class="trajectory-meta-line"><span>${w.escHtml(
          time
        )}</span><span>${call.durationMs != null ? `${call.durationMs} ms` : "—"}</span><span>#L${
          entry.line
        }</span></div>`
      )
    );
  }

  if (entry.kind === "assistant") {
    return (
      trajectoryDetailSection(
        trajectoryText("Message", "消息"),
        `<div class="trajectory-detail-value">${w.escHtml(round)} · ${w.escHtml(
          step
        )}${entry.model ? ` · ${w.escHtml(entry.model)}` : ""}</div>`
      ) +
      (entry.reasoning
        ? trajectoryDetailSection(
            trajectoryText("Thinking", "思考"),
            `<div class="trajectory-markdown">${chatMarkdown(entry.reasoning)}</div>`
          )
        : "") +
      (entry.text
        ? trajectoryDetailSection(
            trajectoryText("Output", "输出"),
            `<div class="trajectory-markdown">${chatMarkdown(entry.text)}</div>`
          )
        : "") +
      trajectoryDetailSection(
        trajectoryText("Timing", "计时"),
        `<div class="trajectory-meta-line"><span>${w.escHtml(time)}</span><span>#L${
          entry.line
        }</span><span>${w.escHtml(
          trajectoryText(
            `${entry.message?.toolCalls.length ?? 0} tool calls`,
            `${entry.message?.toolCalls.length ?? 0} 个工具调用`
          )
        )}</span></div>`
      )
    );
  }

  return (
    trajectoryDetailSection(
      trajectoryText("User message", "用户消息"),
      `<div class="trajectory-detail-value">${w.escHtml(entry.text)}</div>`
    ) +
    trajectoryDetailSection(
      trajectoryText("Timing", "计时"),
      `<div class="trajectory-meta-line"><span>${w.escHtml(time)}</span><span>#L${
        entry.line
      }</span></div>`
    )
  );
}

function renderTrajectoryInspector(): void {
  const shell = document.getElementById("buddyTrajectory");
  const kind = document.getElementById("trajectoryInspectorKind");
  const meta = document.getElementById("trajectoryInspectorMeta");
  const tabs = document.getElementById("trajectoryTabs");
  const body = document.getElementById("trajectoryInspectorBody");
  if (!shell || !kind || !meta || !tabs || !body) return;
  const entry = trajectoryAllEntries.find((item) => item.key === trajectorySelectedKey);
  if (!entry || trajectoryInspectorHidden) {
    shell.classList.add("inspector-hidden");
    return;
  }
  shell.classList.remove("inspector-hidden");
  kind.className = `trajectory-inspector-kind ${entry.kind}`;
  kind.textContent = trajectoryRoleLabel(entry).toUpperCase();
  meta.textContent = `${trajectoryText(`Round ${entry.round}`, `第 ${entry.round} 轮`)} · ${trajectoryText(
    `Step ${entry.step}`,
    `第 ${entry.step} 步`
  )}`;
  const allowed = trajectoryEntryTabs(entry);
  if (!allowed.includes(trajectoryActiveTab)) trajectoryActiveTab = "overview";
  tabs.innerHTML = allowed
    .map(
      (tab) =>
        `<button type="button" class="trajectory-tab${
          tab === trajectoryActiveTab ? " on" : ""
        }" data-trajectory-tab="${tab}">${w.escHtml(trajectoryTabLabel(tab))}</button>`
    )
    .join("");
  body.innerHTML = trajectoryInspectorBodyHtml(entry);
}

function renderTrajectory(): void {
  if (
    !trajectoryInstalled ||
    !trajectoryModeActive()
  ) {
    return;
  }
  const scroll = document.getElementById("trajectoryScroll");
  const timeline = document.getElementById("trajectoryTimeline");
  const duration = document.getElementById("trajectoryDuration");
  const turns = document.getElementById("trajectoryTurns");
  const calls = document.getElementById("trajectoryCalls");
  const steps = document.getElementById("trajectoryStepCount");
  if (!scroll || !timeline) return;
  const path = buddyStreamSnapshot?.path ?? null;
  if (path !== trajectoryStreamPath) {
    trajectoryStreamPath = path;
    trajectorySelectedKey = null;
    trajectoryInspectorHidden = false;
    trajectoryActiveTab = "overview";
    trajectoryFollow = true;
    trajectoryRange = null;
    trajectoryDraft = null;
    trajectoryDrag = null;
    trajectoryViewport = null;
    trajectoryCollapsedTurns.clear();
    trajectoryCollapsedAssistants.clear();
  }
  hideTrajectoryTip();
  const previousScrollTop = scroll.scrollTop;
  trajectoryAllEntries = buildTrajectoryEntries();
  trajectoryTimelineModel = trajectoryBuildTimelineModel(trajectoryAllEntries);
  clampTrajectoryViewport();
  const query = trajectoryCurrentQuery();
  trajectoryVisibleEntries = trajectoryFilterEntries(query);
  trajectoryDisplayRows = trajectoryBuildDisplayRows(trajectoryVisibleEntries);
  if (
    !trajectorySelectedKey ||
    !trajectoryVisibleEntries.some((entry) => entry.key === trajectorySelectedKey)
  ) {
    if (!query && !trajectoryRange) {
      const candidates = trajectoryAllEntries.filter((entry) => entry.kind === "tool");
      const target = trajectoryFollow
        ? [...candidates].reverse().find(Boolean) ?? trajectoryAllEntries[trajectoryAllEntries.length - 1]
        : trajectoryAllEntries[0];
      trajectorySelectedKey = target?.key ?? null;
      if (trajectorySelectedKey) trajectoryInspectorHidden = false;
    } else {
      const target = trajectoryVisibleEntries[0];
      trajectorySelectedKey = target?.key ?? null;
      if (target) trajectoryInspectorHidden = false;
    }
  }
  if (duration) duration.textContent = trajectoryMetricDuration();
  const computedTurns = trajectoryAllEntries.reduce(
    (maximum, entry) => Math.max(maximum, entry.round),
    0
  );
  const computedCalls = trajectoryAllEntries.filter((entry) => entry.kind === "tool").length;
  if (turns) {
    turns.textContent = String(Math.max(buddyConversation?.stats.turns ?? 0, computedTurns));
  }
  if (calls) {
    calls.textContent = String(Math.max(buddyConversation?.stats.toolCalls ?? 0, computedCalls));
  }
  if (steps) {
    steps.textContent = trajectoryText(
      `${trajectoryAllEntries.length} steps`,
      `${trajectoryAllEntries.length} 步`
    );
  }
  renderTrajectoryTimeline();
  trajectoryUpdateToggleControls();
  updateTrajectoryRangeChrome();
  const empty = document.getElementById("trajectoryEmpty");
  if (empty) {
    empty.textContent = !trajectoryAllEntries.length
      ? buddyStreamSnapshot
        ? trajectoryText(
            "No user, assistant, or tool events in this stream.",
            "这个流中没有用户、助手或工具事件。"
          )
        : trajectoryText(
            "Open a JSONL file to inspect its trajectory.",
            "打开 JSONL 文件以查看轨迹。"
          )
      : query
        ? trajectoryText(
            "No trajectory events match the search.",
            "没有匹配搜索的轨迹事件。"
          )
        : trajectoryText(
            "No trajectory events in this range.",
            "这个区间内没有轨迹事件。"
          );
  }
  if (trajectoryResetScroll) {
    scroll.scrollTop = 0;
    trajectoryResetScroll = false;
    trajectoryFollow = false;
  } else {
    scroll.scrollTop = Math.min(
      previousScrollTop,
      Math.max(0, trajectoryVisibleEntries.length * TRAJECTORY_ROW_HEIGHT - scroll.clientHeight)
    );
  }
  if (query) trajectoryFollow = false;
  trajectoryPaintRows();
  renderTrajectoryInspector();
  updateTrajectoryLanguage();
  if (trajectoryFollow) {
    requestAnimationFrame(() => {
      if (!trajectoryFollow) return;
      scroll.scrollTop = Math.max(
        0,
        trajectoryVisibleEntries.length * TRAJECTORY_ROW_HEIGHT - scroll.clientHeight
      );
      trajectoryPaintRows();
    });
  }
}

function scheduleTrajectoryRender(delay = 80, resetScroll = false): void {
  if (!trajectoryInstalled) return;
  if (resetScroll) trajectoryResetScroll = true;
  if (trajectoryRenderTimer !== null) window.clearTimeout(trajectoryRenderTimer);
  trajectoryRenderTimer = window.setTimeout(() => {
    trajectoryRenderTimer = null;
    renderTrajectory();
  }, delay);
}

function trajectoryModeActive(): boolean {
  const app = document.getElementById("app");
  return (
    app?.dataset.view === "monitor" &&
    app.dataset.monitorPage === "detail" &&
    app.dataset.monitorMode === "trajectory"
  );
}

function renderTrajectoryIfActive(): void {
  if (!trajectoryModeActive()) return;
  scheduleTrajectoryRender(40);
}

function updateTrajectoryLanguage(): void {
  const tab = document.getElementById("buddyTrajectoryTabLabel");
  if (tab) tab.textContent = trajectoryText("Trajectory", "轨迹");
  const labels = [
    ["trajectoryDurationLabel", trajectoryText("Duration", "时长")],
    ["trajectoryTurnsLabel", trajectoryText("Turns", "轮次")],
    ["trajectoryCallsLabel", trajectoryText("Calls", "调用")]
  ] as const;
  for (const [id, label] of labels) {
    const element = document.getElementById(id);
    if (element) element.textContent = label;
  }
  const close = document.getElementById("trajectoryInspectorClose");
  if (close) close.title = trajectoryText("Close", "关闭");
  const filter = document.getElementById("monitorFilter") as HTMLInputElement | null;
  if (filter && trajectoryModeActive()) {
    filter.placeholder = trajectoryText("Search trajectory", "搜索轨迹");
  }
  trajectoryUpdateToggleControls();
}

function installTrajectoryView(): void {
  if (trajectoryInstalled) return;
  trajectoryInstalled = true;
  const seg = document.querySelector(".monitor-mode");
  if (seg && !seg.querySelector("[data-monitor-mode-btn='trajectory']")) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.monitorModeBtn = "trajectory";
    button.innerHTML =
      '<svg class="i" viewBox="0 0 24 24"><use href="#i-activity"/></svg><span id="buddyTrajectoryTabLabel">Trajectory</span>';
    button.addEventListener("click", () => w.setMonitorMode("trajectory"));
    seg.appendChild(button);
  }
  const content = document.querySelector(".workspace-content");
  const chat = content?.querySelector(".chat-main");
  if (content && !document.getElementById("buddyTrajectory")) {
    const shell = document.createElement("div");
    shell.id = "buddyTrajectory";
    shell.className = "buddy-trajectory";
    shell.setAttribute("aria-label", "Conversation trajectory");
    shell.innerHTML = `<section class="trajectory-main">
      <div class="trajectory-toolbar">
        <span class="trajectory-controls">
          <button type="button" class="trajectory-toggle" id="trajectoryDurationToggle" aria-pressed="false"><svg class="i" viewBox="0 0 24 24"><use href="#i-clock"/></svg><span id="trajectoryDurationLabel">Duration</span><b id="trajectoryDuration">—</b></button>
          <button type="button" class="trajectory-toggle" id="trajectoryTurnsToggle" aria-pressed="false"><svg class="i trajectory-fold" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path class="minus" d="M5.2 8h5.6"/><path class="plus" d="M8 5.2v5.6"/></svg><span id="trajectoryTurnsLabel">Turns</span><b id="trajectoryTurns">0</b></button>
          <button type="button" class="trajectory-toggle" id="trajectoryCallsToggle" aria-pressed="false"><svg class="i trajectory-fold" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path class="minus" d="M5.2 8h5.6"/><path class="plus" d="M8 5.2v5.6"/></svg><span id="trajectoryCallsLabel">Calls</span><b id="trajectoryCalls">0</b></button>
        </span>
        <span class="trajectory-spacer"></span>
        <button type="button" class="trajectory-range-badge" id="trajectoryRangeBadge" hidden><span id="trajectoryRangeText">0</span><svg class="i" viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
        <span class="trajectory-stat"><b id="trajectoryStepCount">0 steps</b></span>
      </div>
      <div class="trajectory-timeline" id="trajectoryTimeline" tabindex="0"></div>
      <div class="trajectory-scroll" id="trajectoryScroll">
        <div class="trajectory-canvas" id="trajectoryRows"></div>
        <div class="trajectory-empty" id="trajectoryEmpty">Open a JSONL file to inspect its trajectory.</div>
      </div>
    </section>
    <div class="cmp-splitter trajectory-splitter" id="trajectorySplitter" title="Drag to resize"></div>
    <aside class="trajectory-inspector" id="trajectoryInspector">
      <div class="trajectory-inspector-head">
        <span class="trajectory-inspector-kind" id="trajectoryInspectorKind">—</span>
        <span class="trajectory-inspector-meta" id="trajectoryInspectorMeta"></span>
        <span class="spacer"></span>
        <button class="pane-btn trajectory-inspector-close" id="trajectoryInspectorClose" type="button" title="Close"><svg class="i sm" viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
      </div>
      <div class="trajectory-tabs" id="trajectoryTabs"></div>
      <div class="trajectory-inspector-body" id="trajectoryInspectorBody"></div>
    </aside>
    <div class="trajectory-tip" id="trajectoryTip" hidden></div>`;
    if (chat) chat.insertAdjacentElement("afterend", shell);
    else content.appendChild(shell);
  }
  const rows = document.getElementById("trajectoryRows");
  if (rows) {
    rows.addEventListener("click", (event) => {
      const element = event.target instanceof Element ? event.target : null;
      const summary = element?.closest<HTMLElement>("[data-trajectory-summary]");
      if (summary) {
        const kind = summary.dataset.trajectorySummary;
        const group = summary.dataset.trajectorySummaryGroup ?? "";
        if (kind === "turn") trajectoryToggleTurn(Number(group));
        else if (kind === "calls" && group) trajectoryToggleAssistant(group);
        return;
      }
      const target = element?.closest<HTMLElement>("[data-trajectory-key]");
      const key = target?.dataset.trajectoryKey;
      if (key) trajectorySelect(key);
    });
  }
  const timeline = document.getElementById("trajectoryTimeline");
  if (timeline) {
    const fractionAt = (track: HTMLElement, clientX: number): number => {
      const rect = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    };
    const finishDrag = (event: PointerEvent, cancelled = false) => {
      const drag = trajectoryDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const startFraction = drag.startFraction;
      const key = drag.key;
      const track = drag.track;
      const wasMoved = drag.moved || Math.abs(event.clientX - drag.startX) >= 3;
      trajectoryDrag = null;
      trajectoryDraft = null;
      timeline.classList.remove("trajectory-dragging");
      try {
        if (timeline.hasPointerCapture(event.pointerId)) {
          timeline.releasePointerCapture(event.pointerId);
        }
      } catch {
        // The pointer may already be released.
      }
      if (cancelled) {
        updateTrajectoryTimelineFocus();
        hideTrajectoryTip();
        return;
      }
      const fraction = trajectoryViewFraction(fractionAt(track, event.clientX));
      if (!wasMoved) {
        if (key) {
          clearTrajectoryRange();
          trajectorySelect(key);
        } else {
          const target = trajectoryHintForClick(fraction);
          clearTrajectoryRange();
          if (target) trajectorySelect(target.key);
        }
        updateTrajectoryTimelineFocus();
        hideTrajectoryTip();
        return;
      }
      const range = trajectoryRangeIndexesAtFractions(startFraction, fraction);
      if (!range) {
        clearTrajectoryRange();
        updateTrajectoryTimelineFocus();
        return;
      }
      applyTrajectoryRange(range[0], range[1]);
      hideTrajectoryTip();
    };
    timeline.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !trajectoryAllEntries.length) return;
      const target = event.target instanceof Element ? event.target : null;
      const track = target?.closest<HTMLElement>(".trajectory-track");
      if (!track) return;
      event.preventDefault();
      const span = target?.closest<HTMLElement>(".trajectory-span");
      const fraction = trajectoryViewFraction(fractionAt(track, event.clientX));
      trajectoryFollow = false;
      trajectoryDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startFraction: fraction,
        key: span?.dataset.trajectoryKey ?? null,
        moved: false,
        track
      };
      trajectoryDraft = { startFraction: fraction, endFraction: fraction };
      timeline.classList.add("trajectory-dragging");
      try {
        timeline.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture may be unavailable in embedded webviews.
      }
      hideTrajectoryTip();
      updateTrajectoryTimelineFocus();
    });
    timeline.addEventListener("pointermove", (event) => {
      const drag = trajectoryDrag;
      if (drag) {
        if (event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        if (Math.abs(event.clientX - drag.startX) >= 3) drag.moved = true;
        const fraction = trajectoryViewFraction(fractionAt(drag.track, event.clientX));
        trajectoryDraft = {
          startFraction: drag.startFraction,
          endFraction: fraction
        };
        updateTrajectoryTimelineFocus();
        hideTrajectoryTip();
        return;
      }
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".trajectory-span") : null;
      const index = Number(target?.dataset.trajectoryIndex);
      const entry = Number.isFinite(index) ? trajectoryAllEntries[index] : undefined;
      if (entry) showTrajectoryTip(entry, event.clientX, event.clientY);
      else hideTrajectoryTip();
    });
    timeline.addEventListener("pointerup", (event) => finishDrag(event));
    timeline.addEventListener("pointercancel", (event) => finishDrag(event, true));
    timeline.addEventListener("pointerleave", () => {
      if (!trajectoryDrag) hideTrajectoryTip();
    });
    timeline.addEventListener("dblclick", (event) => {
      event.preventDefault();
      clearTrajectoryRange();
      hideTrajectoryTip();
    });
    timeline.addEventListener(
      "wheel",
      (event) => {
        if (!trajectoryAllEntries.length) return;
        event.preventDefault();
        if (trajectoryDrag) return;
        trajectoryZoomTimeline(event.clientX, event.deltaY);
        scheduleTrajectoryTimelineRender();
        hideTrajectoryTip();
      },
      { passive: false }
    );
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !trajectoryRange || !trajectoryModeActive()) return;
    event.preventDefault();
    clearTrajectoryRange();
    hideTrajectoryTip();
  });
  const rangeBadge = document.getElementById("trajectoryRangeBadge");
  if (rangeBadge) {
    rangeBadge.addEventListener("click", () => {
      clearTrajectoryRange();
      hideTrajectoryTip();
    });
  }
  const durationToggle = document.getElementById("trajectoryDurationToggle");
  if (durationToggle) {
    durationToggle.addEventListener("click", () => {
      trajectoryActualDuration = !trajectoryActualDuration;
      try {
        localStorage.setItem(TRAJECTORY_DURATION_STORAGE, trajectoryActualDuration ? "1" : "0");
      } catch {
        // The preference is optional when storage is unavailable.
      }
      trajectoryRange = null;
      trajectoryDraft = null;
      trajectoryDrag = null;
      trajectoryViewport = null;
      hideTrajectoryTip();
      renderTrajectory();
    });
  }
  const turnsToggle = document.getElementById("trajectoryTurnsToggle");
  if (turnsToggle) turnsToggle.addEventListener("click", trajectoryToggleAllTurns);
  const callsToggle = document.getElementById("trajectoryCallsToggle");
  if (callsToggle) callsToggle.addEventListener("click", trajectoryToggleAllCalls);
  const scroll = document.getElementById("trajectoryScroll");
  if (scroll) {
    scroll.addEventListener("scroll", () => {
      const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
      trajectoryFollow = distance < 40;
      scheduleTrajectoryPaint();
    });
  }
  const tabs = document.getElementById("trajectoryTabs");
  if (tabs) {
    tabs.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-trajectory-tab]") : null;
      const tab = target?.dataset.trajectoryTab;
      if (!tab) return;
      trajectoryActiveTab = tab;
      renderTrajectoryInspector();
    });
  }
  const close = document.getElementById("trajectoryInspectorClose");
  if (close) {
    close.addEventListener("click", () => {
      trajectoryInspectorHidden = true;
      renderTrajectoryInspector();
    });
  }
  const splitter = document.getElementById("trajectorySplitter");
  if (splitter) installSplitter(splitter);

  const originalSetMonitorMode = w.setMonitorMode;
  w.setMonitorMode = (mode: string) => {
    if (mode !== "trajectory") {
      hideTrajectoryTip();
      originalSetMonitorMode(mode);
      return;
    }
    const app = document.getElementById("app") as HTMLElement | null;
    if (!app) return;
    app.dataset.monitorMode = "trajectory";
    document.querySelectorAll<HTMLElement>("[data-monitor-mode-btn]").forEach((button) => {
      button.classList.toggle("on", button.dataset.monitorModeBtn === "trajectory");
    });
    const filter = document.getElementById("monitorFilter") as HTMLInputElement | null;
    if (filter) filter.placeholder = trajectoryText("Search trajectory", "搜索轨迹");
    trajectoryFollow = true;
    renderTrajectory();
  };

  const originalApplyLanguage = w.applyLanguage;
  w.applyLanguage = (language: string) => {
    originalApplyLanguage(language);
    updateTrajectoryLanguage();
    if (trajectoryModeActive()) renderTrajectory();
  };

  const originalApplyFilter = w.applyMonitorFilter;
  w.applyMonitorFilter = () => {
    originalApplyFilter();
    if (trajectoryModeActive()) scheduleTrajectoryRender(60, true);
  };

  updateTrajectoryLanguage();
  try {
    if (trajectoryModeActive()) renderTrajectory();
  } catch {
    // The monitor page may still be mounting.
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

interface RustTreeRow {
  key: string;
  path: string;
  depth: number;
  index: boolean;
  kind: string;
  preview: string;
  expandable: boolean;
  expanded: boolean;
  count: number | null;
}

interface RustTreeSnapshot {
  status: "ok" | "empty" | "invalid" | string;
  rows: RustTreeRow[];
  nodes: number;
  depth: number;
  truncated: boolean;
}

const treeNodeIndex = new Map<string, TreeNodeInfo>();
const treeExpanded = new Set<string>();
let treeSelectedPath = "$";
let treeQuery = "";
let treeInstalled = false;
let treeRenderTimer: number | null = null;
let treeRenderSeq = 0;
let treeCachedRevision = -1;
let treeFilterTimer: number | null = null;

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
  .tree-toggle .i {
    width: 12px;
    height: 12px;
    stroke-width: 2;
    transition: transform .12s ease;
  }
  .tree-toggle.open { color: var(--ink-3); }
  .tree-toggle.open .i { transform: rotate(90deg); }
  .tree-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
  .tree-toggle.placeholder { visibility: hidden; }
  .tree-row.sel .tree-toggle { color: var(--accent-2); }
  [data-theme="dark"] .tree-row.sel .tree-toggle { color: var(--accent); }
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

function treeRowHtml(row: RustTreeRow): string {
  const pad = 8 + row.depth * 16;
  const toggleLabel = viewLanguageIsZh()
    ? row.expanded
      ? "折叠"
      : "展开"
    : row.expanded
      ? "Collapse"
      : "Expand";
  const toggle = row.expandable
    ? `<button type="button" class="tree-toggle${row.expanded ? " open" : ""}" data-tree-toggle="${w.escHtml(
        row.path
      )}" tabindex="-1" aria-expanded="${row.expanded}" title="${toggleLabel}" aria-label="${toggleLabel}">
        <svg class="i xs" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>`
    : '<span class="tree-toggle placeholder"></span>';
  const keyHtml = row.index
    ? `<span class="tree-key index">${w.escHtml(row.key)}</span>`
    : `<span class="tree-key">${w.escHtml(row.key)}</span>`;
  let valueHtml = "";
  if (row.kind === "object") {
    valueHtml = `<span class="tree-count">{${row.count ?? 0} keys}</span>`;
  } else if (row.kind === "array") {
    valueHtml = `<span class="tree-count">[${row.count ?? 0} items]</span>`;
  } else {
    valueHtml = `<span class="tree-value ${w.escHtml(row.kind)}">${w.escHtml(
      row.preview
    )}</span>`;
  }
  return `<div class="tree-row${row.path === treeSelectedPath ? " sel" : ""}" data-path="${w.escHtml(
    row.path
  )}" tabindex="0" style="padding-left:${pad}px">
    ${toggle}${keyHtml}<span class="tree-colon">:</span>${valueHtml}
    <span class="tree-type">${w.escHtml(row.kind)}</span>
    <span class="tree-path">${w.escHtml(row.path)}</span>
  </div>`;
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

async function renderTreeView(): Promise<void> {
  const host = document.getElementById("buddyTreeBody");
  if (!host) return;
  const seq = ++treeRenderSeq;
  const focusedPath = (document.activeElement as HTMLElement | null)
    ?.closest?.(".tree-row")
    ?.getAttribute("data-path");
  const count = document.getElementById("buddyTreeCount");
  const doc = currentDoc();
  const source = doc?.text ?? "";
  if (treeExpanded.size === 0) treeExpanded.add("$");
  const revision = codegenRevision;
  const includeText = treeCachedRevision !== revision;
  let snapshot: RustTreeSnapshot;
  try {
    snapshot = await invoke<RustTreeSnapshot>("tree_snapshot", {
      text: includeText ? source : null,
      revision,
      expanded: Array.from(treeExpanded),
      query: treeQuery
    });
    treeCachedRevision = revision;
  } catch (error) {
    if (seq !== treeRenderSeq) return;
    treeNodeIndex.clear();
    treeSelectedPath = "$";
    host.innerHTML = `<div class="tree-empty">${
      viewLanguageIsZh() ? "无法生成树视图。" : "Could not build the tree view."
    }</div>`;
    if (count) count.textContent = viewLanguageIsZh() ? "树不可用" : "Tree unavailable";
    updateTreeInspector();
    toast("Could not build tree view", String(error));
    return;
  }
  if (seq !== treeRenderSeq) return;
  try {
    if (evalGlobal<string>("app.dataset.view") !== "tree") return;
  } catch {
    return;
  }
  if (snapshot.status === "empty") {
    treeNodeIndex.clear();
    treeSelectedPath = "$";
    host.innerHTML = `<div class="tree-empty">${
      viewLanguageIsZh() ? "打开 JSON 文档以查看树。" : "Open a JSON document to inspect its tree."
    }</div>`;
    if (count) count.textContent = viewLanguageIsZh() ? "无文档" : "No document";
    updateTreeInspector();
    return;
  }
  if (snapshot.status !== "ok") {
    treeNodeIndex.clear();
    treeSelectedPath = "$";
    host.innerHTML = `<div class="tree-empty">${
      viewLanguageIsZh()
        ? "文档不是有效 JSON。修复语法后查看树。"
        : "The document is not valid JSON. Fix the syntax to inspect the tree."
    }</div>`;
    if (count) count.textContent = viewLanguageIsZh() ? "JSON 无效" : "Invalid JSON";
    updateTreeInspector();
    return;
  }
  treeNodeIndex.clear();
  for (const row of snapshot.rows) {
    treeNodeIndex.set(row.path, {
      type: row.kind,
      preview: row.preview,
      path: row.path
    });
  }
  if (!treeNodeIndex.has(treeSelectedPath)) treeSelectedPath = "$";
  const html = snapshot.rows.map(treeRowHtml).join("");
  host.innerHTML = `<div class="tree-body">${
    html ||
    `<div class="tree-empty">${
      viewLanguageIsZh() ? "没有节点匹配此筛选。" : "No nodes match this filter."
    }</div>`
  }</div>${
    snapshot.truncated
      ? `<div class="tree-empty">${
          viewLanguageIsZh()
            ? `显示前 ${snapshot.rows.length.toLocaleString("en-US")} 个节点。`
            : `Showing the first ${snapshot.rows.length.toLocaleString("en-US")} nodes.`
        }</div>`
      : ""
  }`;
  if (host.dataset.treeBound !== "1") {
    host.dataset.treeBound = "1";
    host.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const toggle = target?.closest<HTMLElement>("[data-tree-toggle]");
      if (toggle) {
        event.stopPropagation();
        const path = toggle.dataset.treeToggle;
        if (path) w.buddyTreeToggle(path);
        return;
      }
      const row = target?.closest<HTMLElement>(".tree-row");
      if (row) w.buddyTreeSelect(row);
    });
    host.addEventListener("keydown", (event) => {
      const row =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(".tree-row")
          : null;
      const path = row?.dataset.path;
      if (!row || !path) return;
      const toggle = row.querySelector<HTMLElement>(".tree-toggle:not(.placeholder)");
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const rows = Array.from(host.querySelectorAll<HTMLElement>(".tree-row"));
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const target = rows[
          Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + offset))
        ];
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
          const parentRow = Array.from(
            host.querySelectorAll<HTMLElement>(".tree-row")
          ).find((item) => item.dataset.path === parent);
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
  }
  if (focusedPath) {
    const focusedRow = Array.from(
      host.querySelectorAll<HTMLElement>(".tree-row")
    ).find((row) => row.dataset.path === focusedPath);
    focusedRow?.focus({ preventScroll: true });
  }
  if (count) {
    count.textContent = snapshot.truncated
      ? viewLanguageIsZh()
        ? `${snapshot.rows.length.toLocaleString("en-US")} / ${snapshot.nodes.toLocaleString(
            "en-US"
          )} 个节点`
        : `${snapshot.rows.length.toLocaleString("en-US")} of ${snapshot.nodes.toLocaleString(
            "en-US"
          )} nodes`
      : viewLanguageIsZh()
        ? `${snapshot.nodes.toLocaleString("en-US")} 个节点 · ${snapshot.depth} 层`
        : `${snapshot.nodes.toLocaleString("en-US")} nodes · ${snapshot.depth} levels`;
  }
  updateTreeInspector();
}

function scheduleActiveViewRender(): void {
  let view = "";
  try {
    view = evalGlobal<string>("app.dataset.view") ?? "";
  } catch {
    return;
  }
  if (view === "tree") scheduleTreeRender();
  else if (view === "table") scheduleTableRender();
  else if (view === "graph" || view === "split") scheduleGraphRender();
  else if (view === "code") scheduleCodegenRender();
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
    if (view === "tree") void renderTreeView();
  }, delay);
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
      void renderTreeView();
    }
  };
  const originalApplyLanguage = w.applyLanguage;
  w.applyLanguage = (language: string) => {
    originalApplyLanguage(language);
    updateTreeLanguage();
    updateJsonStatusLanguage();
    updateMonitorSidebarChrome();
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
    if (view === "tree") void renderTreeView();
    else if (view === "table") renderTableData();
    else if (view === "graph" || view === "split") renderGraphData();
    else if (view === "code") {
      try {
        void renderGeneratedCode(evalGlobal<string>("currentLang"));
      } catch {
        // The code panel may not be mounted.
      }
    }
  };
  w.buddyTreeToggle = (path: string) => {
    if (treeExpanded.has(path)) treeExpanded.delete(path);
    else treeExpanded.add(path);
    void renderTreeView();
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
    if (treeFilterTimer !== null) window.clearTimeout(treeFilterTimer);
    treeFilterTimer = window.setTimeout(() => {
      treeFilterTimer = null;
      void renderTreeView();
    }, 80);
  };
  w.buddyTreeExpandAll = async () => {
    const source = currentDoc()?.text ?? "";
    const revision = codegenRevision;
    const includeText = treeCachedRevision !== revision;
    try {
      const paths = await invoke<string[]>("tree_expandable_paths", {
        text: includeText ? source : null,
        revision,
        limit: 4_000
      });
      treeCachedRevision = revision;
      for (const path of paths) treeExpanded.add(path);
      void renderTreeView();
    } catch (error) {
      toast("Could not build tree view", String(error));
    }
  };
  w.buddyTreeCollapseAll = () => {
    treeExpanded.clear();
    treeExpanded.add("$");
    void renderTreeView();
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
  try {
    if (evalGlobal<string>("app.dataset.view") === "tree") void renderTreeView();
  } catch {
    // The app may still be mounting.
  }
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
  bindVirtualTableScroll();
  try {
    if (evalGlobal<string>("app.dataset.view") === "table") renderTableData();
  } catch {
    // The app may still be mounting.
  }
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
  try {
    const view = evalGlobal<string>("app.dataset.view");
    if (view === "graph" || view === "split") renderGraphData();
  } catch {
    // The app may still be mounting.
  }
}

/* ------------------------------------------------------------
   JSON-driven code generation
   ------------------------------------------------------------ */

interface GeneratedCode {
  code: string;
  file: string;
  rootName: string;
  types: number;
  records: number;
  rootLabel: string;
}

let buddyGenerated: GeneratedCode | null = null;
let buddyGeneratedLang = "";
let buddyGeneratedKey = "";
let codegenInstalled = false;
let codegenTimer: number | null = null;
let codegenRequest = 0;
let codegenPending: { key: string; request: number } | null = null;

const CODEGEN_LINE_HEIGHT = 20;
const CODEGEN_OVERSCAN = 10;
const CODEGEN_VIRTUAL_THRESHOLD = 800;
let codegenLines: string[] = [];
let codegenMaxLineLength = 0;
let codegenWindowFrame: number | null = null;
let codegenScrollBound = false;
let codegenRenderedStart = -1;
let codegenRenderedEnd = -1;

function codegenRow(line: string, index: number): string {
  const html = line ? w.highlightLine(line) : "&nbsp;";
  return `<div class="cgl"><span class="ln">${index + 1}</span><span class="cl">${html}</span></div>`;
}

function renderCodegenWindow(force = false): void {
  const host = document.getElementById("cgCode");
  if (!host) return;
  const total = codegenLines.length;
  if (total <= CODEGEN_VIRTUAL_THRESHOLD) {
    if (
      !force &&
      codegenRenderedStart === 0 &&
      codegenRenderedEnd === total
    ) {
      return;
    }
    host.innerHTML = codegenLines
      .map((line, index) => codegenRow(line, index))
      .join("");
    codegenRenderedStart = 0;
    codegenRenderedEnd = total;
    return;
  }
  const viewport = host.clientHeight || 600;
  const visible = Math.ceil(viewport / CODEGEN_LINE_HEIGHT);
  const first = Math.floor(host.scrollTop / CODEGEN_LINE_HEIGHT);
  const start = Math.max(0, first - CODEGEN_OVERSCAN);
  const end = Math.min(total, first + visible + CODEGEN_OVERSCAN);
  if (!force && start === codegenRenderedStart && end === codegenRenderedEnd) {
    return;
  }
  const top = start * CODEGEN_LINE_HEIGHT;
  const bottom = (total - end) * CODEGEN_LINE_HEIGHT;
  const widthChars = Math.max(1, codegenMaxLineLength + 1);
  const html =
    `<div class="cg-virtual" style="min-width: calc(52px + ${widthChars}ch); font-family: var(--font-mono); font-size: 11.5px;">` +
    (top ? `<div class="cg-gap" style="height:${top}px"></div>` : "") +
    codegenLines
      .slice(start, end)
      .map((line, offset) => codegenRow(line, start + offset))
      .join("") +
    (bottom ? `<div class="cg-gap" style="height:${bottom}px"></div>` : "") +
    "</div>";
  const previousTop = host.scrollTop;
  const previousLeft = host.scrollLeft;
  host.innerHTML = html;
  if (host.scrollTop !== previousTop) host.scrollTop = previousTop;
  if (host.scrollLeft !== previousLeft) host.scrollLeft = previousLeft;
  codegenRenderedStart = start;
  codegenRenderedEnd = end;
}

function scheduleCodegenWindowRender(): void {
  if (codegenWindowFrame !== null) return;
  codegenWindowFrame = window.requestAnimationFrame(() => {
    codegenWindowFrame = null;
    renderCodegenWindow();
  });
}

function bindCodegenScrolling(): void {
  const host = document.getElementById("cgCode");
  if (!host || codegenScrollBound) return;
  codegenScrollBound = true;
  host.addEventListener("scroll", scheduleCodegenWindowRender, {
    passive: true
  });
  window.addEventListener("resize", scheduleCodegenWindowRender, {
    passive: true
  });
}

function codegenKeyFor(lang: string, doc: BridgeDoc | null): string {
  return `${lang}\u0000${doc?.path ?? ""}\u0000${doc?.name ?? ""}\u0000${
    doc?.text?.length ?? 0
  }\u0000${codegenRevision}`;
}

function paintGeneratedCode(def: any, generated: GeneratedCode, doc: BridgeDoc | null): void {
  const badge = document.getElementById("langBadge");
  if (badge) {
    badge.textContent = def.badge;
    badge.style.color = def.color;
    badge.style.background = `${def.color}1f`;
  }
  w.setText("langName", def.name);
  w.setText("cgFile", generated.file);
  w.setText("cgLang", def.name);
  w.setText("cgRoot", generated.rootLabel);
  const meta = document.querySelector(".codegen-meta");
  if (meta) {
    meta.textContent = doc
      ? `from ${doc.name} · ${generated.records} record${
          generated.records === 1 ? "" : "s"
        }`
      : viewLanguageIsZh()
        ? "无文档"
        : "No document";
  }
  const rootName = generated.rootName || "Model";
  w.setText(
    "cgSummary",
    viewLanguageIsZh()
      ? `${rootName} · ${generated.types} 个类型 · ${generated.records} 条记录`
      : `${rootName} · ${generated.types} type${
          generated.types === 1 ? "" : "s"
        } · ${generated.records} record${
          generated.records === 1 ? "" : "s"
        }`
  );
  const code = generated.code.replace(/^\n+|\n+$/g, "");
  const lines = code.split("\n");
  w.setText(
    "cgMeta",
    viewLanguageIsZh()
      ? `${lines.length} 行 · ${(code.length / 1024).toFixed(2)} KB`
      : `${lines.length} lines · ${(code.length / 1024).toFixed(2)} KB`
  );
  codegenLines = lines;
  codegenMaxLineLength = lines.reduce(
    (longest, line) => Math.max(longest, line.length),
    0
  );
  bindCodegenScrolling();
  renderCodegenWindow(true);
  document.querySelectorAll(".lang-item").forEach((item) => {
    item.classList.toggle("on", (item as HTMLElement).dataset.lang === def.id);
  });
}

async function renderGeneratedCode(langId: string): Promise<void> {
  try {
    if (evalGlobal<string>("app.dataset.view") !== "code") return;
  } catch {
    return;
  }
  const defs = evalGlobal<any[]>("LANG_DEFS");
  const def = defs.find((item) => item.id === langId) ?? defs[0];
  if (!def) return;
  evalGlobal(`currentLang = ${JSON.stringify(def.id)}`);
  const doc = currentDoc();
  const key = codegenKeyFor(def.id, doc);
  if (buddyGenerated && buddyGeneratedKey === key) {
    ++codegenRequest;
    paintGeneratedCode(def, buddyGenerated, doc);
    return;
  }
  if (codegenPending?.key === key) return;
  const request = ++codegenRequest;
  codegenPending = { key, request };
  try {
    const generated = await invoke<GeneratedCode>("generate_code", {
      text: doc?.text ?? "",
      language: def.id,
      fileName: doc?.name ?? "root",
      extension: def.ext
    });
    if (
      request !== codegenRequest ||
      codegenKeyFor(def.id, currentDoc()) !== key ||
      evalGlobal<string>("app.dataset.view") !== "code"
    ) {
      return;
    }
    buddyGenerated = generated;
    buddyGeneratedLang = def.id;
    buddyGeneratedKey = key;
    paintGeneratedCode(def, generated, doc);
  } catch (error) {
    if (
      request !== codegenRequest ||
      codegenKeyFor(def.id, currentDoc()) !== key ||
      evalGlobal<string>("app.dataset.view") !== "code"
    ) {
      return;
    }
    buddyGenerated = {
      code: "// Could not generate code from this document.",
      file: `model.${def.ext}`,
      rootName: "",
      types: 0,
      records: 0,
      rootLabel: "Code generation failed"
    };
    buddyGeneratedLang = def.id;
    buddyGeneratedKey = "";
    paintGeneratedCode(def, buddyGenerated, doc);
    toast("Could not generate code", String(error));
  } finally {
    if (codegenPending?.request === request) codegenPending = null;
  }
}

function scheduleCodegenRender(delay = 180): void {
  if (!codegenInstalled) return;
  if (codegenTimer !== null) window.clearTimeout(codegenTimer);
  codegenTimer = window.setTimeout(() => {
    codegenTimer = null;
    try {
      if (evalGlobal<string>("app.dataset.view") === "code") {
        void renderGeneratedCode(evalGlobal<string>("currentLang") || "typescript");
      }
    } catch {
      // The app may be closing.
    }
  }, delay);
}

function installCodegen(): void {
  if (codegenInstalled) return;
  codegenInstalled = true;
  evalGlobal(`(() => {
    if (!Array.isArray(LANG_DEFS)) return;
    const index = LANG_DEFS.findIndex((def) => def.id === "schema");
    if (index > 0) LANG_DEFS.unshift(LANG_DEFS.splice(index, 1)[0]);
    if (LANG_DEFS[0]) currentLang = LANG_DEFS[0].id;
    if (typeof renderLangMenu === "function") renderLangMenu();
  })()`);
  bindCodegenScrolling();
  w.renderCodegen = (id: string) => {
    void renderGeneratedCode(id);
  };
  w.copyGenerated = () => {
    if (!buddyGenerated || buddyGeneratedLang !== evalGlobal<string>("currentLang")) return;
    w.copyText(buddyGenerated.code, w.t("Copied"), buddyGenerated.file);
  };
  w.downloadGenerated = async () => {
    if (!buddyGenerated || buddyGeneratedLang !== evalGlobal<string>("currentLang")) return;
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
      void renderGeneratedCode(evalGlobal<string>("currentLang") || "typescript");
    }
  };
  try {
    if (evalGlobal<string>("app.dataset.view") === "code") {
      void renderGeneratedCode(evalGlobal<string>("currentLang") || "typescript");
    }
  } catch {
    // The code panel is not mounted yet.
  }
}


/* ------------------------------------------------------------
   Panel splitters
   ------------------------------------------------------------ */

type SplitterSide = "left" | "right";

interface SplitterState {
  splitter: HTMLElement;
  parent: HTMLElement;
  prev: HTMLElement;
  next: HTMLElement;
  sized: HTMLElement;
  side: SplitterSide;
  min: number;
  minOther: number;
  preferred: number | null;
  applied: number | null;
  dragging: boolean;
  frame: number | null;
  pendingX: number;
  observer: ResizeObserver | null;
}

let splittersInstalled = false;

function splitterIsFixed(element: HTMLElement): boolean {
  return (parseFloat(getComputedStyle(element).flexGrow) || 0) === 0;
}

function splitterSettings(
  parent: HTMLElement,
  prev: HTMLElement,
  next: HTMLElement
): { side: SplitterSide; min: number; minOther: number } {
  if (parent.classList.contains("workspace-content")) {
    return { side: "left", min: 300, minOther: 260 };
  }
  if (parent.classList.contains("compare-main")) {
    return { side: "left", min: 220, minOther: 220 };
  }
  if (
    parent.classList.contains("monitor-main") ||
    parent.classList.contains("chat-main")
  ) {
    return { side: "right", min: 280, minOther: 340 };
  }
  const prevFixed = splitterIsFixed(prev);
  const nextFixed = splitterIsFixed(next);
  if (prevFixed && !nextFixed) return { side: "left", min: 200, minOther: 200 };
  if (nextFixed && !prevFixed) return { side: "right", min: 200, minOther: 200 };
  return { side: "left", min: 200, minOther: 200 };
}

function splitterFixedSiblings(state: SplitterState): number {
  let width = 0;
  for (const child of Array.from(state.parent.children)) {
    if (
      !(child instanceof HTMLElement) ||
      child === state.prev ||
      child === state.next ||
      child === state.splitter
    ) {
      continue;
    }
    if (getComputedStyle(child).display === "none") continue;
    if (splitterIsFixed(child)) width += child.getBoundingClientRect().width;
  }
  return width;
}

function splitterMaxSize(state: SplitterState): number {
  const parentWidth = state.parent.clientWidth;
  if (!parentWidth) return state.min;
  const splitterWidth = state.splitter.getBoundingClientRect().width || 5;
  const available =
    parentWidth -
    splitterWidth -
    state.minOther -
    splitterFixedSiblings(state);
  return Math.max(state.min, Math.floor(available));
}

function splitterClamp(state: SplitterState, width: number): number {
  return Math.max(
    state.min,
    Math.min(splitterMaxSize(state), Math.round(width))
  );
}

function updateSplitterAria(
  state: SplitterState,
  width?: number,
  max?: number
): void {
  const actual =
    width ??
    (state.applied ??
      (state.sized.getBoundingClientRect().width || state.min));
  state.splitter.setAttribute("aria-valuemin", String(state.min));
  if (max != null) {
    state.splitter.setAttribute("aria-valuemax", String(max));
  }
  state.splitter.setAttribute("aria-valuenow", String(Math.round(actual)));
}

function applySplitterWidth(
  state: SplitterState,
  width: number,
  remember: boolean,
  max?: number
): void {
  const rounded = Math.round(width);
  state.applied = rounded;
  if (remember) state.preferred = rounded;
  state.sized.style.flex = `0 0 ${rounded}px`;
  updateSplitterAria(state, rounded, max);
}

function refreshSplitterSize(state: SplitterState): void {
  if (state.preferred == null) return;
  if (!state.parent.clientWidth) return;
  const width = splitterClamp(state, state.preferred);
  if (width !== state.applied) applySplitterWidth(state, width, false);
}

function installSplitter(splitter: HTMLElement): void {
  if (splitter.dataset.buddySplitter === "1") return;
  const parent = splitter.parentElement;
  const prev = splitter.previousElementSibling;
  const next = splitter.nextElementSibling;
  if (
    !parent ||
    !(prev instanceof HTMLElement) ||
    !(next instanceof HTMLElement)
  ) {
    return;
  }
  const settings = splitterSettings(parent, prev, next);
  const sized = settings.side === "left" ? prev : next;

  splitter.dataset.buddySplitter = "1";
  splitter.classList.add("buddy-splitter");
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-orientation", "vertical");
  splitter.setAttribute(
    "aria-label",
    splitter.getAttribute("title") || "Resize panels"
  );
  if (!splitter.hasAttribute("tabindex")) splitter.tabIndex = 0;

  const state: SplitterState = {
    splitter,
    parent,
    prev,
    next,
    sized,
    side: settings.side,
    min: settings.min,
    minOther: settings.minOther,
    preferred: null,
    applied: null,
    dragging: false,
    frame: null,
    pendingX: 0,
    observer: null
  };
  updateSplitterAria(state, undefined, splitterMaxSize(state));

  if (typeof ResizeObserver !== "undefined") {
    state.observer = new ResizeObserver(() => {
      if (state.dragging || !state.parent.clientWidth) return;
      refreshSplitterSize(state);
      const rendered = state.sized.getBoundingClientRect().width;
      updateSplitterAria(
        state,
        state.applied ?? (rendered > 0 ? rendered : undefined),
        splitterMaxSize(state)
      );
    });
    state.observer.observe(parent);
    state.observer.observe(sized);
  }

  let drag:
    | {
        pointerId: number;
        startX: number;
        startSize: number;
        max: number;
      }
    | null = null;

  const applyPointer = () => {
    if (!drag) return;
    const delta = state.pendingX - drag.startX;
    const raw =
      state.side === "left"
        ? drag.startSize + delta
        : drag.startSize - delta;
    const width = Math.max(state.min, Math.min(drag.max, Math.round(raw)));
    if (width !== state.applied) {
      applySplitterWidth(state, width, true, drag.max);
    }
  };

  const finishDrag = (event?: PointerEvent) => {
    if (!drag) return;
    const pointerId = drag.pointerId;
    if (state.frame != null) {
      window.cancelAnimationFrame(state.frame);
      state.frame = null;
      applyPointer();
    }
    drag = null;
    state.dragging = false;
    splitter.classList.remove("buddy-splitter-active");
    document.body.classList.remove("buddy-splitting");
    if (event) {
      try {
        if (splitter.hasPointerCapture(pointerId)) {
          splitter.releasePointerCapture(pointerId);
        }
      } catch {
        // The pointer may already have been released.
      }
    }
    updateSplitterAria(
      state,
      state.applied ?? undefined,
      splitterMaxSize(state)
    );
  };

  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if (!splitter.offsetParent) return;
    event.preventDefault();
    const current = sized.getBoundingClientRect().width;
    if (current <= 0) return;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startSize: current,
      max: splitterMaxSize(state)
    };
    state.dragging = true;
    state.pendingX = event.clientX;
    splitter.classList.add("buddy-splitter-active");
    document.body.classList.add("buddy-splitting");
    try {
      splitter.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events and some embedded webviews cannot capture.
    }
  });

  splitter.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if ((event.buttons & 1) === 0) {
      finishDrag(event);
      return;
    }
    event.preventDefault();
    state.pendingX = event.clientX;
    if (state.frame != null) return;
    state.frame = window.requestAnimationFrame(() => {
      state.frame = null;
      applyPointer();
    });
  });

  splitter.addEventListener("pointerup", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    finishDrag(event);
  });
  splitter.addEventListener("pointercancel", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    finishDrag(event);
  });
  splitter.addEventListener("lostpointercapture", () => finishDrag());
  window.addEventListener("blur", () => finishDrag());

  splitter.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (!splitter.offsetParent) return;
    event.preventDefault();
    const current =
      state.applied ?? sized.getBoundingClientRect().width ?? state.min;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const step = event.shiftKey ? 64 : 16;
    const delta = state.side === "left" ? direction * step : -direction * step;
    const max = splitterMaxSize(state);
    applySplitterWidth(
      state,
      Math.max(state.min, Math.min(max, current + delta)),
      true,
      max
    );
  });

  splitter.addEventListener("dblclick", (event) => {
    event.preventDefault();
    state.preferred = null;
    state.applied = null;
    sized.style.removeProperty("flex");
    window.setTimeout(
      () => updateSplitterAria(state, undefined, splitterMaxSize(state)),
      260
    );
  });
}

function installSplitters(): void {
  if (splittersInstalled) return;
  splittersInstalled = true;
  document
    .querySelectorAll<HTMLElement>(".splitter, .cmp-splitter")
    .forEach(installSplitter);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installSplitters, { once: true });
} else {
  installSplitters();
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
    renderTrajectoryIfActive();
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
    renderTrajectoryIfActive();
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
        renderTrajectoryIfActive();
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
    renderTrajectoryIfActive();
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
      prepareDocumentView();
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
    installTrajectoryView();
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
