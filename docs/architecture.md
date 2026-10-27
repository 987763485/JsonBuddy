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
│   ├── network.rs    loopback mock requests   │
│   ├── menu.rs       native application menu  │
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
| `src-tauri/src/network.rs` | 原生端点测试请求：仅回环地址、无代理/重定向、接受应用自签名证书 |
| `src-tauri/src/menu.rs` | 原生 macOS 菜单构建与语言重建 |
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
- `list_mock_projects`
- `create_mock_project`
- `save_mock_project`
- `delete_mock_project`
- `set_mock_project_running`
- `set_mock_runtime_response`
- `start_mock_server`
- `stop_mock_server`
- `mock_server_status`
- `mock_request_logs`
- `audit_config`
- `update_audit_categories`
- `acknowledge_audit`
- `save_text_file`
- `parse_yaml_document`
- `test_local_request` — 由 Rust 发送本地 Mock 测试请求

## 数据与安全边界

- 数据根目录固定为 `~/.json_buddy/`；macOS/Linux 目录 `0700`，配置文件 `0600`，Windows 依赖用户目录 ACL。
- 首次启动会尝试把旧 `~/.json_studio/` 迁移到 `~/.json_buddy/`；新目录已存在或迁移失败时保留旧目录，不影响启动。
- 新建 JSON 默认写入 `~/.json_buddy/documents/`；用户打开的外部文件在原路径保存。
- 最近文件只记录元数据，删除最近项不会删除磁盘文件。
- 编辑器单文件读取上限 50 MB；超过时返回明确错误。
- 不发起非本地网络请求；Mock 服务只绑定 `127.0.0.1`。端点测试命令在 Rust 侧校验 URL，只允许 `localhost`、`127.0.0.1`、`::1`，`localhost` 会规范化为 `127.0.0.1`，并禁用代理与重定向后再发送。
- Rust 侧负责路径、网络、Mock 与审计策略；UI 只调用命令，不绕过安全边界。

## 模块边界

1. **原型 UI + 桌面壳**：锁定原型 HTML/CSS、Tauri 窗口、构建同步、Toast、webview 铺满窗口与原生交通灯适配（已完成）
2. **设置桥接**：语言、主题、Mock 端口、HTTPS、数据目录、i18n（已完成）
3. **JSON 工作区桥接**：最近文件、打开/新建/保存、CodeMirror 编辑、格式化/压缩/校验（已完成）
4. **JSON 对比桥接**：两侧最近文件与本地文件读取、差异渲染（已完成）
5. **JSON 流桥接**：Rust `notify` + 增量 zstd 快照/跟随、暂停、删除、实时事件渲染、固定行高虚拟列表、真实事件速率与保留缓冲计数（已完成）；`conversation.rs` 将 CodeBuddy / DeepSeek harness 事件归一化为只读对话、模型切换与工具调用，思考内容可展开（已完成）
6. **JSON Mock**：Rust 项目库、共享 localhost 服务、项目独立挂载/卸载、无状态路由、HTTP/HTTPS、真实请求日志、运行时长与总请求数、原型项目/端点/响应编辑、JSON Schema / OpenAPI 导入、生成/导出（已完成）；生成数据通过独立的运行期响应供服务使用，不写入项目文件，编辑生成响应时转为固定响应；端点测试请求改走 Rust 原生 HTTP 客户端，HTTPS 自签名证书与 webview CORS 不再影响测试
7. **审计**：Rust 单一策略模块、工具调用分类、500 条上限、设置持久化、按类别复用确认、原始事件定位、动态本地化与真实审计面板（已完成）
8. **树 / 表格 / 图形视图**：树视图、表格视图与图形视图均已接入真实 JSON（展开/筛选/检查器、分节表格/列选择/长数据虚拟窗口、节点/边与布局切换）
9. **代码生成**：从当前 JSON 推断类型模型，输出 12 个目标（11 种语言 + JSON Schema），支持可选/可空字段与单文件 `$defs`（已完成）
10. **导入导出**：CSV/JSON/JSONL 导入写入 `~/.json_buddy/documents`；CSV、Excel、Mock 导出与生成代码保存走原生对话框（已完成）；窗口级拖放打开 JSON、JSONL 与 `.jsonl.zstd`
11. **桌面集成**：原生菜单提供新建、打开、保存、设置与标准编辑命令，并随语言重建；状态栏缩进宽度与图形缩放来自真实状态（已完成）

## 测试策略

- 前端：`npm run check`、`npm run build`
- Rust：`cargo test`
- Tauri 集成：`npm run tauri:build -- --debug`
- 功能模块完成后追加对应单元测试和端到端验证；不修改锁定 UI 文件。
- 示例 JSONL 文件位于 `example/`，用于流模块测试，不进入 Git。
- Mock 导入覆盖 JSON Schema、OpenAPI JSON/YAML、Swagger 2.0、示例响应提取、跳过报告、1,000 定义上限、远程 `$ref` 拒绝、导入来源持久化与追加/替换；YAML 解析由 Rust `serde_yaml` 完成。Mock JSON Schema 导出使用单文件 `$defs`，OpenAPI 导出内联响应 Schema 与示例。
- Mock 生成数据不进入项目文件；`set_mock_runtime_response` 仅更新内存，服务优先返回运行期响应，项目保存时保留运行期响应但序列化时跳过。
- 复制使用 Tauri 剪贴板插件与本地化 Toast；Inter 与 JetBrains Mono 由构建产物提供，无远程字体请求。
- JSON 状态栏根据编辑器选择更新行号、列号、JSON 路径与有效性；路径可点击复制；缩进宽度从当前文本检测，缩放比例跟随图形视图。
- 表格视图对超过 200 行/键的区块使用固定行高窗口和上下占位行，筛选后重新计算匹配行；渲染时保留滚动位置。
- 原生测试请求通过 `network::send_local_request` 发送；Rust 校验 scheme、host 与凭据，拒绝远程地址后禁用代理和重定向，仅访问回环地址。
- 运行中的 Mock 服务在共享端口或 HTTPS 设置变化时会停止并按新配置重启；启动失败会回落到停止状态并提示。
- 多个 Mock 项目可同时运行在同一个服务端口下，各自挂载到 `/<slug>`；停止最后一个运行项目或删除运行中的项目会停止服务。项目 ID 在写入/删除项目文件前校验，拒绝路径分隔符等非法字符。

## Git 约定

- `main`：可发布基线；只接收完成验证的主要合并。
- `dev`：功能开发分支；每个大模块完成后提交。
- 提交信息只描述新增、修改或修复，不包含版本号或迭代信息。
