import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AppSettings,
  BootstrapData,
  JsonDocument,
  RecentDocument,
  RecentStream,
  StreamSnapshot
} from "./types";

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export const api = {
  bootstrap(): Promise<BootstrapData> {
    return invoke<BootstrapData>("bootstrap");
  },

  updateSettings(settings: AppSettings): Promise<AppSettings> {
    return invoke<AppSettings>("update_settings", { settings });
  },

  listRecentDocuments(): Promise<RecentDocument[]> {
    return invoke<RecentDocument[]>("list_recent_documents");
  },

  createDocument(name?: string): Promise<JsonDocument> {
    return invoke<JsonDocument>("create_json_document", { name: name ?? null });
  },

  openDocument(path: string): Promise<JsonDocument> {
    return invoke<JsonDocument>("open_json_document", { path });
  },

  saveDocument(path: string, text: string): Promise<JsonDocument> {
    return invoke<JsonDocument>("save_json_document", { path, text });
  },

  removeRecentDocument(path: string): Promise<RecentDocument[]> {
    return invoke<RecentDocument[]>("remove_recent_json_document", { path });
  },

  async pickJsonFile(): Promise<string | null> {
    const result = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    return typeof result === "string" ? result : null;
  },

  async pickStreamFile(): Promise<string | null> {
    const result = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "JSON Lines and zstd", extensions: ["jsonl", "zstd", "zst"] }
      ]
    });
    return typeof result === "string" ? result : null;
  },

  listRecentStreams(): Promise<RecentStream[]> {
    return invoke<RecentStream[]>("list_recent_streams");
  },

  openStream(path: string): Promise<StreamSnapshot> {
    return invoke<StreamSnapshot>("open_stream", { path });
  },

  startStreamFollow(path: string): Promise<void> {
    return invoke("start_stream_follow", { path });
  },

  stopStreamFollow(path: string): Promise<void> {
    return invoke("stop_stream_follow", { path });
  },

  removeRecentStream(path: string): Promise<RecentStream[]> {
    return invoke<RecentStream[]>("remove_recent_stream", { path });
  }
};
