# JSON Buddy

[English](README.md) · **简体中文**

一个本地优先的 JSON 工作台，集 JSON 工具、JSON Mock 与 JSON Lines 大模型对话监控于一体。

## 软件介绍

JSON Buddy 围绕三个核心模块构建：

- **JSON 工具**：编辑、格式化、校验、结构化对比，支持文本 / 分栏 / 图形 / 代码 / 表格 / 树六种视图，并可将 JSON 转为代码。
- **JSON Mock**：创建项目与接口，发布本地 HTTP/HTTPS Mock 服务，支持 JSON Schema / OpenAPI 导入、数据生成与请求日志。
- **JSON Lines 监控**：跟踪 Claude Code、Codex、WorkBuddy 等 Agent 的 JSONL / `.jsonl.zstd` 会话，阅读对话、查看轨迹与审计事件。

所有数据与处理都留在本机：设置、文档、Mock 项目、流缓存与审计记录位于 `~/.json_buddy/`；应用不发起非本地网络请求。

项目使用 Tauri 2 + Rust 构建，界面以 `design/prototype.html` 为唯一源文件。桌面应用直接加载原型 HTML/CSS，由 `ui/bridge.ts` 接入 CodeMirror、实时数据和 Tauri 命令。

**其他特性**

- **结构化对比**：A/B 两侧独立选择文件，按结构或文本比较，变更列表、同步滚动与忽略键顺序。
- **对话与轨迹**：从流事件还原用户 / 助手 / 工具调用、思考过程与模型切换；轨迹视图提供输入 / 模型 / 工具三轨时间线和可筛选的步骤检查器。
- **安全审计**：目录穿越、删除、上传、外发、Shell 与读取事件按规则分类，可在当前会话中筛选、定位与复制目标。
- **大文件性能**：流文件尾部加载、虚拟列表，以及大 JSON 文档的懒渲染。
- **本地优先**：应用不发起非本地网络请求，Mock 服务只监听 localhost。

## 软件界面

以下截图来自 `design/prototype.html` 的演示数据。

### JSON 编辑与图形

文本 / 分栏 / 图形 / 代码 / 表格 / 树六种视图共享同一份文档；分栏视图同时显示源码与节点图。

![JSON 编辑与图形](docs/images/ui-json-editor.png)

### 结构化对比

A/B 两侧选择文件后开始比较，结构差异按路径列出；支持文本模式、忽略键顺序、同步滚动与变更定位。

![结构化对比](docs/images/ui-compare.png)

### JSONL 监控：对话

打开流文件后自动跟随。对话视图还原用户、助手、思考、工具调用与模型切换，右侧栏显示实时事件、会话统计和审计。

![JSONL 监控对话视图](docs/images/ui-monitor-chat.png)

### 对话轨迹

轨迹视图按轮次与步骤呈现用户、助手和工具事件，提供三轨时间线、区间过滤、滚轮缩放和参数 / 结果 / Schema / 计时检查器。

![对话轨迹](docs/images/ui-trajectory.png)

### 本地 Mock 服务

项目与端点独立管理，响应体可直接编辑；支持 JSON Schema / OpenAPI 导入、数据生成、请求日志以及 HTTP/HTTPS 本地服务。

![本地 Mock 服务](docs/images/ui-mock.png)

### 深色主题

工作台与监控视图在深色主题下保持同样的布局。

| 深色 JSON 编辑 | 深色轨迹 |
| --- | --- |
| ![深色 JSON 编辑](docs/images/ui-json-editor-dark.png) | ![深色轨迹](docs/images/ui-trajectory-dark.png) |

## 编译运行

**环境要求**

- Node.js 20.19+（当前使用 Node 22）
- Rust 1.77.2+
- macOS、Windows 或 Linux 桌面环境

**安装依赖并启动开发版**

```bash
npm install
npm run tauri:dev
```

**调试模式**

启动开发构建并自动打开 Web Inspector：

```bash
npm run tauri:debug
```

调试构建的“开发”菜单包含“开发者工具”；快捷键为 macOS `Cmd+Option+I`、Windows/Linux `Ctrl+Shift+I`。macOS/Linux 使用 WebKit Web Inspector，Windows 使用 WebView2 DevTools。发布构建不包含该菜单项。也可以手动启用自动打开：

```bash
JSON_BUDDY_DEVTOOLS=1 npm run tauri:dev
```

**只构建界面**

```bash
npm run build
```

**构建桌面应用**

```bash
npm run tauri:build
```

`npm run dev` / `npm run build` 会先把 `design/prototype.html` 同步为 `ui/index.html`，再构建桥接脚本。React 参考实现（`src/`）可通过 `npm run dev:react` 和 `npm run build:react` 单独运行，不参与桌面发布。

**测试与检查**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm run check
```

## 软件技术架构

### 总体结构

JSON Buddy 是“原型 UI + TypeScript 桥接 + Rust 后端”的 Tauri 2 应用。Rust 负责文件、流、Mock、审计、代码生成与树计算；前端只负责渲染和交互，不直接访问磁盘或网络。

```text
design/prototype.html            UI 唯一源文件
        │  scripts/sync-ui.mjs
        ▼
ui/index.html  +  ui/bridge.ts   CodeMirror、真实数据与交互
        │  Tauri IPC
        ▼
Rust backend
  documents · streams · mock · audit · codegen · tree
        │
        ▼
~/.json_buddy/                   设置、最近文件、文档、Mock、审计与缓存
```

### 关键模块

| 模块 | 职责 |
| --- | --- |
| `design/prototype.html` | UI 与交互的唯一来源，包含全部视图和轨迹页 |
| `scripts/sync-ui.mjs` | 构建时把原型同步为 `ui/index.html` |
| `ui/bridge.ts` | 原型与 Tauri 后端之间的桥接层；CodeMirror、列表渲染、事件订阅与本地化 |
| `src-tauri/src/documents.rs` | JSON 文档、最近文件、保存与大小限制 |
| `src-tauri/src/streams.rs` | JSONL / zstd 快照、尾部加载、`notify` 跟随、事件归档 |
| `src-tauri/src/conversation.rs` | 把流事件归一化为对话、工具调用与模型切换 |
| `src-tauri/src/audit.rs` | 审计规则、事件记录、筛选与设置 |
| `src-tauri/src/mock.rs` | 本地 Mock 服务、项目 / 端点、Schema 与 OpenAPI 导入、请求日志 |
| `src-tauri/src/codegen.rs` | 类型推断、Schema 合并、命名与 12 种目标语言输出 |
| `src-tauri/src/tree.rs` | 树视图的解析、展开、筛选与可见行计算 |
| `src-tauri/src/network.rs` | 仅限回环地址的端点测试与证书处理 |

更多模块边界与数据流说明见 [`docs/architecture.md`](./docs/architecture.md)。

### 性能设计

- 打开文件时只渲染文本视图；分栏、图形、代码、表格和树在激活时才计算。
- 超过 2 MB 的 JSON 关闭 CodeMirror 语法解析，并在载入前完成视口测量。
- 超过 64 MB 的 JSONL / 16 MB 的 zstd 只读取尾部窗口，行数带 `+` 提示；跟随从尾部偏移继续。
- 流事件使用固定行高虚拟列表，超出 10,000 条 / 50 MB 的事件写入本地缓存，滚动到顶部时按需加载。
- 超长生成代码使用固定行高窗口，只渲染可见行。

### 数据与安全

应用数据默认位于 `~/.json_buddy/`：

```text
~/.json_buddy/
├── settings.json
├── recent.json
├── documents/       # 新建 JSON 文档
├── mock/
│   ├── projects/    # Mock 项目
│   ├── certs/       # 本地 HTTPS 证书
│   └── logs/        # 当前会话请求日志
├── audit/
└── cache/streams/   # 超出内存缓冲的流事件
```

用户主动打开的外部 JSON 文件仍保存在原路径并参与自动保存；新建文档默认写入 `documents/`。首次启动时若检测到旧 `~/.json_studio/` 且新目录不存在，会尝试自动迁移。

安全边界：

- 应用不发起任何非本地网络请求。
- Mock 服务只绑定 `127.0.0.1` / `::1`；路由穿越请求被拒绝并写入审计。
- 端点测试由 Rust 发送，目标严格限制在 localhost，并接受应用自签名证书。
- 文件访问、路径校验、审计与流处理都在 Rust 侧完成。

## 开源协议

本项目采用 **MIT License**，详见 [`LICENSE`](./LICENSE)。

第三方依赖保留各自的开源协议。

## 文档

- [`AGENT.md`](./AGENT.md) — Agent 角色、约束、当前工作与文档索引
- [`design/README.md`](./design/README.md) — 产品设计、交互说明与实现说明
- [`design/prototype.html`](./design/prototype.html) — UI 源文件（含对话轨迹页），构建时同步到应用
- [`docs/architecture.md`](./docs/architecture.md) — 工程架构、模块边界与安全约束
- [`README.md`](./README.md) — English README

## 开发约定

- UI 变更先修改 `design/prototype.html`，再通过 `npm run build` 同步；未获明确要求时不主动修改 UI。
- 功能开发在 `dev` 分支，大模块完成后提交；主要版本合并到 `main`。
- 提交信息只描述新增、修改或修复，不包含版本迭代或发布信息。
- 所有无可见结果的完成操作必须显示本地化 Toast。
- 新增功能应补充自动化测试；提交前至少运行 `cargo test` 与 `npm run build`。
