import { create } from "zustand";
import { api, errorMessage } from "./api";
import { translate } from "./i18n";
import type {
  AppSettings,
  JsonDocument,
  JsonView,
  Page,
  RecentDocument,
  RecentStream,
  ToastKind,
  ToastMessage
} from "./types";

let toastTimer: ReturnType<typeof setTimeout> | null = null;

interface AppStore {
  ready: boolean;
  busy: boolean;
  error: string | null;
  settings: AppSettings;
  dataRoot: string;
  recents: RecentDocument[];
  streamRecents: RecentStream[];
  page: Page;
  activeDoc: JsonDocument | null;
  text: string;
  dirty: boolean;
  view: JsonView;
  toast: ToastMessage | null;
  init: () => Promise<void>;
  setPage: (page: Page) => void;
  setView: (view: JsonView) => void;
  setText: (text: string) => void;
  closeDocument: () => Promise<void>;
  notify: (kind: ToastKind, message: string, detail?: string) => void;
  dismissToast: () => void;
  refreshRecents: () => Promise<void>;
  refreshStreamRecents: () => Promise<void>;
  createDocument: () => Promise<void>;
  pickAndOpen: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  saveActive: () => Promise<void>;
  removeRecent: (path: string) => Promise<void>;
  removeStreamRecent: (path: string) => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<boolean>;
  setTheme: (theme: AppSettings["theme"]) => Promise<void>;
}

function currentLanguage(settings: AppSettings): AppSettings["language"] {
  return settings.language;
}

async function guardDiscard(
  dirty: boolean,
  settings: AppSettings
): Promise<boolean> {
  if (!dirty) return true;
  return window.confirm(translate(currentLanguage(settings), "json.discardConfirm"));
}

export const useAppStore = create<AppStore>((set, get) => ({
  ready: false,
  busy: false,
  error: null,
  settings: {
    language: "en",
    theme: "light",
    mockPort: 4010,
    mockHttps: false
  },
  dataRoot: "",
  recents: [],
  streamRecents: [],
  page: "json",
  activeDoc: null,
  text: "",
  dirty: false,
  view: "text",
  toast: null,

  init: async () => {
    set({ busy: true, error: null });
    try {
      const data = await api.bootstrap();
      set({
        ready: true,
        busy: false,
        settings: data.settings,
        dataRoot: data.dataRoot,
        recents: data.recents,
        streamRecents: data.streams ?? []
      });
    } catch (error) {
      set({ ready: true, busy: false, error: errorMessage(error) });
    }
  },

  setPage: (page) => set({ page }),
  setView: (view) => set({ view }),
  setText: (text) => set({ text, dirty: true }),

  closeDocument: async () => {
    const state = get();
    if (!(await guardDiscard(state.dirty, state.settings))) return;
    set({ activeDoc: null, text: "", dirty: false, view: "text" });
  },

  notify: (kind, message, detail) => {
    if (toastTimer) clearTimeout(toastTimer);
    const toast: ToastMessage = { id: Date.now(), kind, message, detail };
    set({ toast });
    toastTimer = setTimeout(() => {
      if (get().toast?.id === toast.id) set({ toast: null });
    }, 2800);
  },

  dismissToast: () => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: null });
  },

  refreshRecents: async () => {
    const recents = await api.listRecentDocuments();
    set({ recents });
  },

  refreshStreamRecents: async () => {
    const streams = await api.listRecentStreams();
    set({ streamRecents: streams });
  },

  createDocument: async () => {
    const state = get();
    if (!(await guardDiscard(state.dirty, state.settings))) return;
    try {
      const document = await api.createDocument();
      await get().refreshRecents();
      set({
        activeDoc: document,
        text: document.text,
        dirty: false,
        page: "json",
        view: "text"
      });
      state.notify(
        "success",
        translate(state.settings.language, "json.created"),
        document.name
      );
    } catch (error) {
      state.notify(
        "error",
        translate(state.settings.language, "json.createFailed"),
        errorMessage(error)
      );
    }
  },

  pickAndOpen: async () => {
    const state = get();
    if (!(await guardDiscard(state.dirty, state.settings))) return;
    try {
      const path = await api.pickJsonFile();
      if (!path) return;
      const document = await api.openDocument(path);
      await get().refreshRecents();
      set({
        activeDoc: document,
        text: document.text,
        dirty: false,
        page: "json",
        view: "text"
      });
      state.notify(
        "success",
        translate(state.settings.language, "json.openedToast"),
        document.name
      );
    } catch (error) {
      state.notify(
        "error",
        translate(state.settings.language, "json.openFailed"),
        errorMessage(error)
      );
    }
  },

  openPath: async (path) => {
    const state = get();
    if (!(await guardDiscard(state.dirty, state.settings))) return;
    try {
      const document = await api.openDocument(path);
      await get().refreshRecents();
      set({
        activeDoc: document,
        text: document.text,
        dirty: false,
        page: "json",
        view: "text"
      });
      state.notify(
        "success",
        translate(state.settings.language, "json.openedToast"),
        document.name
      );
    } catch (error) {
      state.notify(
        "error",
        translate(state.settings.language, "json.openFailed"),
        errorMessage(error)
      );
    }
  },

  saveActive: async () => {
    const state = get();
    if (!state.activeDoc) return;
    try {
      const document = await api.saveDocument(state.activeDoc.path, state.text);
      await get().refreshRecents();
      set({ activeDoc: document, dirty: false });
      state.notify(
        "success",
        translate(state.settings.language, "json.saved"),
        document.name
      );
    } catch (error) {
      state.notify(
        "error",
        translate(state.settings.language, "json.saveFailed"),
        errorMessage(error)
      );
    }
  },

  removeRecent: async (path) => {
    const state = get();
    try {
      const recents = await api.removeRecentDocument(path);
      set({ recents });
      state.notify(
        "success",
        translate(state.settings.language, "json.removed")
      );
    } catch (error) {
      state.notify(
        "error",
        translate(state.settings.language, "toast.error"),
        errorMessage(error)
      );
    }
  },

  removeStreamRecent: async (path) => {
    const state = get();
    try {
      const streams = await api.removeRecentStream(path);
      set({ streamRecents: streams });
      state.notify(
        "success",
        translate(state.settings.language, "stream.removed")
      );
    } catch (error) {
      state.notify(
        "error",
        translate(state.settings.language, "toast.error"),
        errorMessage(error)
      );
    }
  },

  updateSettings: async (settings) => {
    const state = get();
    try {
      const saved = await api.updateSettings(settings);
      set({ settings: saved });
      state.notify(
        "success",
        translate(saved.language, "settings.saved")
      );
      return true;
    } catch (error) {
      state.notify(
        "error",
        translate(state.settings.language, "settings.saveFailed"),
        errorMessage(error)
      );
      return false;
    }
  },

  setTheme: async (theme) => {
    const state = get();
    if (state.settings.theme === theme) return;
    const next = { ...state.settings, theme };
    try {
      const saved = await api.updateSettings(next);
      set({ settings: saved });
    } catch (error) {
      state.notify(
        "error",
        translate(state.settings.language, "settings.saveFailed"),
        errorMessage(error)
      );
    }
  }
}));
