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

export interface ConversationToolCall {
  id: string;
  name: string;
  arguments: string;
  status: string;
  durationMs?: number | null;
  output?: string | null;
  line: number;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system" | string;
  model?: string | null;
  timestamp?: string | null;
  text: string;
  reasoning?: string | null;
  toolCalls: string[];
  streaming: boolean;
  line: number;
}

export interface ConversationTurn {
  index: number;
  model?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  messages: number;
  streaming: boolean;
}

export interface ConversationSwitch {
  from: string;
  to: string;
  timestamp?: string | null;
}

export interface ConversationStats {
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  turns: number;
  promptTokens: number;
  completionTokens: number;
}

export interface Conversation {
  sessionId?: string | null;
  title?: string | null;
  systemPrompt?: string | null;
  models: string[];
  startedAt?: string | null;
  endedAt?: string | null;
  messages: ConversationMessage[];
  toolCalls: ConversationToolCall[];
  turns: ConversationTurn[];
  switches: ConversationSwitch[];
  stats: ConversationStats;
}

export interface StreamSnapshot {
  path: string;
  name: string;
  format: "jsonl" | "zstd";
  size: number;
  decodedSize: number;
  lines: number;
  events: StreamEvent[];
  conversation: Conversation;
}

export interface StreamLivePayload {
  path: string;
  events: StreamEvent[];
  conversation: Conversation;
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
