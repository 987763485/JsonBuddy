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

export interface RecentStream {
  path: string;
  name: string;
  format: "jsonl" | "zstd";
  size: number;
  decodedSize: number;
  lines: number;
  openedAt: string;
}

export interface StreamEvent {
  line: number;
  raw: string;
  ts?: string | null;
  level?: string | null;
  name?: string | null;
}

export interface StreamSnapshot {
  path: string;
  name: string;
  format: "jsonl" | "zstd";
  size: number;
  decodedSize: number;
  lines: number;
  events: StreamEvent[];
}

export interface StreamLivePayload {
  path: string;
  events: StreamEvent[];
  totalLines: number;
  decodedSize: number;
  reset: boolean;
}

export interface StreamErrorPayload {
  path: string;
  message: string;
}

export interface MockEndpoint {
  id: string;
  method: string;
  path: string;
  name: string;
  status: number;
  delayMs: number;
  enabled: boolean;
  response: unknown;
}

export interface MockProject {
  version: number;
  id: string;
  name: string;
  description: string;
  slug: string;
  endpoints: MockEndpoint[];
  updatedAt: string;
  schemaCount: number;
}

export interface MockServerStatus {
  running: boolean;
  port: number;
  https: boolean;
  url: string;
}

export interface MockRequestLog {
  projectId: string;
  projectName: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  at: string;
}

export interface BootstrapData {
  settings: AppSettings;
  dataRoot: string;
  recents: RecentDocument[];
  streams: RecentStream[];
}

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}
