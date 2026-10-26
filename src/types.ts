export type Language = "en" | "zh";
export type Theme = "light" | "dark" | "system";
export type Page = "json" | "compare" | "streams" | "mock" | "settings";
export type JsonView = "text" | "code" | "table" | "graph" | "tree" | "split";
export type ToastKind = "success" | "error";

export interface AppSettings {
  language: Language;
  theme: Theme;
  mockPort: number;
  mockHttps: boolean;
}

export interface RecentDocument {
  path: string;
  name: string;
  size: number;
  lines: number;
  openedAt: string;
}

export interface JsonDocument {
  path: string;
  name: string;
  text: string;
  size: number;
  lines: number;
}

export interface BootstrapData {
  settings: AppSettings;
  dataRoot: string;
  recents: RecentDocument[];
}

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}
