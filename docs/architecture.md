# 工程架构

## 总览

JSON Buddy 使用 Tauri 2 作为桌面外壳。界面直接加载锁定的原型 HTML/CSS，`ui/bridge.ts` 负责注入 CodeMirror、替换 mock 数据并调用 Tauri 命令；Rust 侧负责本地文件、流处理、Mock 服务、审计和设置持久化。UI 原型已冻结，产品与交互规则以 [`design/README.md`](../design/README.md) 为准。

```text
┌──────────────────────────────────────────────┐
│ Tauri window                                 │
│  locked prototype UI (ui/index.html)         │
│   ├── design/prototype.html synced at build  │
│   ├── exact markup + CSS + mock interactions │
│   └── ui/bridge.ts ─────────────────┐        │
│        ├── settings / language / theme        │
│        ├── JSON recents + file dialogs        │
│        ├── CodeMirror in #code-wrap           │
│        └── invoke() ─────────────────┤        │
│                                      │        │
│  Rust backend (src-tauri/src/)       ▼        │
│   ├── data.rs       data root + secure I/O   │
│   ├── settings.rs   settings load/save       │
│   ├── documents.rs  document + recent store  │
│   ├── streams.rs    JSONL/zstd snapshots     │
│   ├── state.rs      shared application state │
│   └── lib.rs        Tauri commands + setup   │
└──────────────────────────────────────────────┘
             │
             ▼
      ~/.json_buddy/
```

React 源码位于 `src/`，保留为此前业务与视图实现的参考；Tauri 构建不加载它。`npm run dev:react` 可单独运行参考实现。

## 前端结构

| 路径 | 职责 |
| --- | --- |
| `design/prototype.html` | 锁定 UI 源文件，禁止修改 |
| `scripts/sync-ui.mjs` | 把原型复制为 `ui/index.html` 并注入 bridge |
| `ui/bridge.ts` | 原型与 Tauri 后端之间的桥接层 |
| `ui/index.html` | 构建时生成，不进入 Git |
| `src/` | React 参考实现，不参与 Tauri 构建 |
| `src/types.ts` | bridge 复用的数据契约 |

## Rust 结构

| 路径 | 职责 |
| --- | --- |
| `src-tauri/src/lib.rs` | Tauri 插件、setup、命令注册 |
| `src-tauri/src/data.rs` | `~/.json_buddy` 目录布局、原子级文件权限、JSON 读写 |
| `src-tauri/src/settings.rs` | 设置结构、校验、加载与保存 |
| `src-tauri/src/documents.rs` | 文档读取/保存/新建、最近 JSON/流存储、50 MB 限制 |
| `src-tauri/src/streams.rs` | JSONL/zstd 快照、原生文件监听、增量帧解码、实时事件 |
| `src-tauri/src/state.rs` | 设置、最近文件与流会话的共享互斥状态 |

当前命令：

- `bootstrap` — 设置、数据目录、最近文件
- `update_settings`
- `list_recent_documents`
- `create_json_document`
- `open_json_document`
- `save_json_document`
- `remove_recent_json_document`
- `list_recent_streams`
- `open_stream`
- `start_stream_follow`
- `stop_stream_follow`
- `remove_recent_stream`

## 数据与安全边界

- 数据根目录固定为 `~/.json_buddy/`；macOS/Linux 目录 `0700`，配置文件 `0600`，Windows 依赖用户目录 ACL。
- 首次启动会尝试把旧 `~/.json_studio/` 迁移到 `~/.json_buddy/`；新目录已存在或迁移失败时保留旧目录，不影响启动。
- 新建 JSON 默认写入 `~/.json_buddy/documents/`；用户打开的外部文件在原路径保存。
- 最近文件只记录元数据，删除最近项不会删除磁盘文件。
- 编辑器单文件读取上限 50 MB；超过时返回明确错误。
- 不发起非本地网络请求；Mock 服务后续只绑定 `127.0.0.1` / `::1`。
- Rust 侧负责路径、网络、Mock 与审计策略；UI 只调用命令，不绕过安全边界。

## 模块边界

1. **原型 UI + 桌面壳**：锁定原型 HTML/CSS、Tauri 窗口、构建同步、Toast、webview 铺满窗口与原生交通灯适配（已完成）
2. **设置桥接**：语言、主题、Mock 端口、HTTPS、数据目录、i18n（已完成）
3. **JSON 工作区桥接**：最近文件、打开/新建/保存、CodeMirror 编辑、格式化/压缩/校验（已完成）
4. **JSON 对比桥接**：两侧最近文件与本地文件读取、差异渲染（已完成）
5. **JSON 流桥接**：Rust `notify` + 增量 zstd 快照/跟随、暂停、删除、实时事件渲染（已完成）；`conversation.rs` 将 CodeBuddy / DeepSeek harness 事件归一化为只读对话、模型切换与工具调用（已完成）
6. **JSON Mock**：Rust 项目库、无状态路由、localhost 服务、HTTP/HTTPS、真实请求日志、原型项目/端点/响应编辑、生成/导入/导出（已完成）
7. **审计**：Rust 单一策略模块、工具调用分类、500 条上限、设置与确认本地持久化、真实审计面板（已完成）
8. **树 / 表格 / 图形视图**：树视图、表格视图与图形视图均已接入真实 JSON（展开/筛选/检查器、分节表格/列选择、节点/边与布局切换）
9. **代码生成**：从当前 JSON 推断类型模型，输出 12 个目标（11 种语言 + JSON Schema），支持可选/可空字段与单文件 `$defs`（已完成）
10. **导入导出**：CSV/JSON/JSONL 导入写入 `~/.json_buddy/documents`；CSV、Excel、Mock 导出与生成代码保存走原生对话框（已完成）

## 测试策略

- 前端：`npm run check`、`npm run build`
- Rust：`cargo test`
- Tauri 集成：`npm run tauri:build -- --debug`
- 功能模块完成后追加对应单元测试和端到端验证；不修改锁定 UI 文件。
- 示例 JSONL 文件位于 `example/`，用于流模块测试，不进入 Git。

## Git 约定

- `main`：可发布基线；只接收完成验证的主要合并。
- `dev`：功能开发分支；每个大模块完成后提交。
- 提交信息只描述新增、修改或修复，不包含版本号或迭代信息。
