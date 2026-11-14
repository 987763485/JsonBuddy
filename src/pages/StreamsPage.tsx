import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  FileJson,
  FolderOpen,
  MessageSquare,
  Pause,
  Play,
  Search,
  Trash2,
  WrapText
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { api, errorMessage } from "../api";
import { useAppStore } from "../store";
import { useT } from "../useT";
import type {
  RecentStream,
  StreamErrorPayload,
  StreamEvent,
  StreamLivePayload,
  StreamSnapshot
} from "../types";
import { formatBytes, formatDate } from "../utils";

const ROW_HEIGHT = 20;
const MAX_EVENTS = 10_000;
const MAX_EVENT_BYTES = 50 * 1024 * 1024;
const EVENT_PANEL_LIMIT = 300;
const LEVELS = ["all", "INFO", "DEBUG", "WARN", "ERROR"] as const;
type LevelFilter = (typeof LEVELS)[number];

function trimEvents(events: StreamEvent[]): StreamEvent[] {
  let next = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
  let total = next.reduce((sum, event) => sum + event.raw.length, 0);
  let start = 0;
  while (total > MAX_EVENT_BYTES && start < next.length - 1) {
    total -= next[start].raw.length;
    start += 1;
  }
  if (start > 0) next = next.slice(start);
  return next;
}

export function StreamsPage() {
  const t = useT();
  const streamRecents = useAppStore((state) => state.streamRecents);
  const refreshStreamRecents = useAppStore((state) => state.refreshStreamRecents);
  const removeStreamRecent = useAppStore((state) => state.removeStreamRecent);
  const notify = useAppStore((state) => state.notify);
  const language = useAppStore((state) => state.settings.language);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<StreamSnapshot | null>(null);

  useEffect(() => {
    void refreshStreamRecents().catch(() => undefined);
  }, [refreshStreamRecents]);

  const openPath = async (path: string) => {
    try {
      const snapshot = await api.openStream(path);
      await refreshStreamRecents();
      setSelected(snapshot);
    } catch (error) {
      notify("error", t("stream.openFailed"), errorMessage(error));
    }
  };

  const pickFile = async () => {
    try {
      const path = await api.pickStreamFile();
      if (!path) return;
      await openPath(path);
    } catch (error) {
      notify("error", t("stream.openFailed"), errorMessage(error));
    }
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return streamRecents;
    return streamRecents.filter((entry) =>
      `${entry.name} ${entry.path}`.toLowerCase().includes(needle)
    );
  }, [query, streamRecents]);

  if (selected) {
    return (
      <StreamDetail
        key={selected.path}
        snapshot={selected}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <section className="recents-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">JSON STREAM</span>
          <h1>{t("stream.recentTitle")}</h1>
          <p>{t("stream.recentHint")}</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => void pickFile()}>
            <FolderOpen size={15} />
            {t("stream.openFile")}
          </button>
        </div>
      </div>

      <div className="recents-card">
        <div className="recents-toolbar">
          <label className="search-field">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("stream.searchPlaceholder")}
            />
          </label>
          <span className="count-label">
            {t("stream.recentCount", { count: filtered.length })}
          </span>
        </div>

        {streamRecents.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">
              <Activity size={24} />
            </span>
            <h2>{t("stream.emptyTitle")}</h2>
            <p>{t("stream.emptyBody")}</p>
            <button className="btn primary" type="button" onClick={() => void pickFile()}>
              <FolderOpen size={15} />
              {t("stream.openFile")}
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state compact">
            <p>{t("stream.noResults")}</p>
          </div>
        ) : (
          <div className="recent-list">
            {filtered.map((entry) => (
              <StreamRow
                key={entry.path}
                entry={entry}
                language={language}
                onOpen={() => void openPath(entry.path)}
                onRemove={() => void removeStreamRecent(entry.path)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function StreamRow({
  entry,
  language,
  onOpen,
  onRemove
}: {
  entry: RecentStream;
  language: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="recent-row">
      <button className="recent-main" type="button" onClick={onOpen} title={entry.path}>
        <span className={`stream-file-tile ${entry.format}`}>
          <Activity size={17} />
        </span>
        <span className="recent-name">
          <strong>{entry.name}</strong>
          <small>{entry.path}</small>
        </span>
        <span className="recent-meta">
          <span>
            {entry.format.toUpperCase()} · {entry.lines} {t("stream.lines")}
          </span>
          <small>
            {entry.format === "zstd"
              ? `${formatBytes(entry.size)} → ${formatBytes(entry.decodedSize)}`
              : formatBytes(entry.size)}
            {" · "}
            {formatDate(entry.openedAt, language)}
          </small>
        </span>
      </button>
      <button
        className="icon-btn danger"
        type="button"
        title={t("stream.removeAction")}
        aria-label={t("stream.removeAction")}
        onClick={onRemove}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function StreamDetail({
  snapshot,
  onBack
}: {
  snapshot: StreamSnapshot;
  onBack: () => void;
}) {
  const t = useT();
  const notify = useAppStore((state) => state.notify);
  const [events, setEvents] = useState<StreamEvent[]>(snapshot.events);
  const [totalLines, setTotalLines] = useState(snapshot.lines);
  const [decodedSize, setDecodedSize] = useState(snapshot.decodedSize);
  const [following, setFollowing] = useState(false);
  const [mode, setMode] = useState<"source" | "chat">("source");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  const filteredEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events.filter((event) => {
      if (level !== "all" && (event.level ?? "").toUpperCase() !== level) return false;
      if (!needle) return true;
      return `${event.raw} ${event.level ?? ""} ${event.name ?? ""}`
        .toLowerCase()
        .includes(needle);
    });
  }, [events, level, query]);

  const scrollToBottom = () => {
    const host = sourceRef.current;
    if (!host) return;
    host.scrollTop = host.scrollHeight;
    atBottomRef.current = true;
    setNewCount(0);
    setScrollTop(host.scrollTop);
  };

  useEffect(() => {
    if (mode !== "source") return;
    const frame = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(frame);
    // Initial frame should land on the live tail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenLive: UnlistenFn | undefined;
    let unlistenError: UnlistenFn | undefined;

    void (async () => {
      const live = await listen<StreamLivePayload>("stream-live", (event) => {
        if (event.payload.path !== snapshot.path) return;
        const payload = event.payload;
        if (payload.reset) {
          setEvents(payload.events);
          setTotalLines(payload.totalLines);
          setDecodedSize(payload.decodedSize);
          setNewCount(0);
          notify("success", t("stream.resetNotice"), snapshot.name);
          if (atBottomRef.current) requestAnimationFrame(scrollToBottom);
          return;
        }
        if (!payload.events.length) {
          setTotalLines(payload.totalLines);
          setDecodedSize(payload.decodedSize);
          return;
        }
        setEvents((current) => trimEvents([...current, ...payload.events]));
        setTotalLines(payload.totalLines);
        setDecodedSize(payload.decodedSize);
        if (atBottomRef.current) {
          setNewCount(0);
          requestAnimationFrame(scrollToBottom);
        } else {
          setNewCount((count) => count + payload.events.length);
        }
      });
      if (disposed) {
        live();
      } else {
        unlistenLive = live;
      }

      const error = await listen<StreamErrorPayload>("stream-error", (event) => {
        if (event.payload.path !== snapshot.path) return;
        notify("error", t("stream.streamError"), event.payload.message);
      });
      if (disposed) error();
      else unlistenError = error;
    })();

    return () => {
      disposed = true;
      unlistenLive?.();
      unlistenError?.();
      void api.stopStreamFollow(snapshot.path).catch(() => undefined);
    };
    // The listener belongs to one opened stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.path]);

  const startFollowing = async () => {
    try {
      await api.startStreamFollow(snapshot.path);
      setFollowing(true);
      notify("success", t("stream.followingToast"), snapshot.name);
      requestAnimationFrame(scrollToBottom);
    } catch (error) {
      notify("error", t("stream.followFailed"), errorMessage(error));
    }
  };

  const pauseFollowing = async () => {
    try {
      await api.stopStreamFollow(snapshot.path);
      setFollowing(false);
      notify("success", t("stream.pausedToast"), snapshot.name);
    } catch (error) {
      notify("error", t("stream.followFailed"), errorMessage(error));
    }
  };

  const onScroll = () => {
    const host = sourceRef.current;
    if (!host) return;
    setScrollTop(host.scrollTop);
    setViewportHeight(host.clientHeight);
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 50;
    atBottomRef.current = atBottom;
    if (atBottom) setNewCount(0);
  };

  const eventPanel = filteredEvents.slice(-EVENT_PANEL_LIMIT).reverse();
  const rowHeight = 20;
  const overscan = 12;
  const visibleStart = wrap
    ? 0
    : Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleEnd = wrap
    ? filteredEvents.length
    : Math.min(
        filteredEvents.length,
        Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan
      );
  const visibleEvents = filteredEvents.slice(visibleStart, visibleEnd);

  return (
    <section className="stream-detail-page">
      <div className="stream-toolbar">
        <button
          className="icon-btn"
          type="button"
          title={t("stream.back")}
          aria-label={t("stream.back")}
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </button>
        <div className="stream-file-chip">
          <span className={`stream-file-tile ${snapshot.format}`}>
            <Activity size={15} />
          </span>
          <span>
            <strong>{snapshot.name}</strong>
            <small>{snapshot.path}</small>
          </span>
          <em>{snapshot.format.toUpperCase()}</em>
        </div>
        <div className="segmented">
          <button
            type="button"
            className={mode === "source" ? "on" : ""}
            onClick={() => setMode("source")}
          >
            {t("stream.source")}
          </button>
          <button
            type="button"
            className={mode === "chat" ? "on" : ""}
            onClick={() => setMode("chat")}
          >
            {t("stream.chat")}
          </button>
        </div>
        <div className="toolbar-spacer" />
        <button
          className={`btn compact${wrap ? " active-soft" : ""}`}
          type="button"
          onClick={() => setWrap((value) => !value)}
          title={t("stream.wrap")}
        >
          <WrapText size={14} />
          {t("stream.wrap")}
        </button>
        <button
          className="btn compact"
          type="button"
          onClick={scrollToBottom}
          title={t("stream.jumpLive")}
        >
          <ArrowDownToLine size={14} />
          {t("stream.jumpLive")}
        </button>
        <button
          className={`btn compact ${following ? "" : "primary"}`}
          type="button"
          onClick={() => void (following ? pauseFollowing() : startFollowing())}
        >
          {following ? <Pause size={14} /> : <Play size={14} />}
          {following ? t("stream.pause") : t("stream.follow")}
        </button>
      </div>

      <div className="stream-workspace">
        <div className="stream-source-pane">
          <div className="stream-source-head">
            <span className={`live-pill${following ? " on" : ""}`}>
              <span className="live-dot" />
              {following ? t("stream.following") : t("stream.paused")}
            </span>
            <span>
              {totalLines} {t("stream.lines")}
            </span>
            <span>
              {snapshot.format === "zstd"
                ? `${formatBytes(snapshot.size)} → ${formatBytes(decodedSize)}`
                : formatBytes(decodedSize)}
            </span>
            <span className="status-spacer" />
            {events.length > filteredEvents.length ? (
              <span>
                {filteredEvents.length}/{events.length}
              </span>
            ) : null}
          </div>

          {mode === "chat" ? (
            <div className="stream-chat-placeholder">
              <MessageSquare size={24} />
              <h2>{t("stream.chat")}</h2>
              <p>{t("stream.chatSoon")}</p>
            </div>
          ) : (
            <div
              className={`stream-source${wrap ? " wrap" : ""}`}
              ref={sourceRef}
              onScroll={onScroll}
            >
              {filteredEvents.length === 0 ? (
                <div className="stream-no-events">{t("stream.noEvents")}</div>
              ) : wrap ? (
                visibleEvents.map((event) => (
                  <SourceLine key={event.line} event={event} />
                ))
              ) : (
                <div
                  className="stream-virtual"
                  style={{ height: filteredEvents.length * rowHeight }}
                >
                  {visibleEvents.map((event, index) => (
                    <div
                      className="stream-virtual-row"
                      key={event.line}
                      style={{ top: (visibleStart + index) * rowHeight }}
                    >
                      <SourceLine event={event} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {newCount > 0 ? (
            <button className="new-events-pill" type="button" onClick={scrollToBottom}>
              <ArrowDownToLine size={13} />
              {t("stream.newEvents", { count: newCount })}
            </button>
          ) : null}
        </div>

        <aside className="stream-events-panel">
          <header>
            <strong>{t("stream.events")}</strong>
            <span>{filteredEvents.length}</span>
          </header>
          <div className="stream-level-filters">
            {LEVELS.map((value) => (
              <button
                key={value}
                type="button"
                className={level === value ? "on" : ""}
                onClick={() => setLevel(value)}
              >
                {value === "all" ? t("stream.allLevels") : value}
              </button>
            ))}
          </div>
          <label className="stream-filter-field">
            <Search size={13} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("stream.filterPlaceholder")}
            />
          </label>
          <div className="stream-event-list">
            {eventPanel.length ? (
              eventPanel.map((event) => (
                <div className="stream-event-row" key={event.line}>
                  <span className={`stream-level ${(event.level ?? "info").toLowerCase()}`}>
                    {event.level ?? t("stream.event")}
                  </span>
                  <div>
                    <strong>{event.name ?? `L${event.line}`}</strong>
                    <small>
                      {event.ts ? `${event.ts} · ` : ""}L{event.line}
                    </small>
                  </div>
                </div>
              ))
            ) : (
              <div className="stream-no-events">{t("stream.noEvents")}</div>
            )}
          </div>
          <footer>
            {t("stream.initialEvents", { count: Math.min(EVENT_PANEL_LIMIT, filteredEvents.length) })}
          </footer>
        </aside>
      </div>

      <div className="stream-status">
        <span className={`validity ${following ? "valid" : ""}`}>
          <span className="status-dot" />
          {following ? t("stream.following") : t("stream.paused")}
        </span>
        <span>{totalLines} {t("stream.lines")}</span>
        <span>{formatBytes(decodedSize)}</span>
        <span>UTF-8</span>
        <span className="status-spacer" />
        <span>{snapshot.name}</span>
      </div>
    </section>
  );
}

function SourceLine({ event }: { event: StreamEvent }) {
  return (
    <div className="stream-source-line">
      <span className="stream-line-no">{event.line}</span>
      <span className="stream-line-raw">{event.raw}</span>
    </div>
  );
}
