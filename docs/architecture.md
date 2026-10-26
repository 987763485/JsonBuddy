# 工程架构

## 总览

JSON Studio 使用 Tauri 2 作为桌面外壳，前端为 React + TypeScript，Rust 侧负责本地文件、流处理、Mock 服务、审计和设置持久化。UI 原型已冻结，产品与交互规则以 [`design/README.md`](../design/README.md) 为准。

```text
┌──────────────────────────────────────────────┐
│ Tauri window                                 │
│  React UI (src/)                             │
│   ├── shell: titlebar / rail / pages         │
│   ├── json workspace + CodeMirror            │
│   ├── settings + i18n + theme                │
│   └── invoke() ──────────────────┐           │
│                                  │           │
│  Rust backend (src-tauri/src/)   ▼           │
│   ├── data.rs       data root + secure I/O   │
│   ├── settings.rs   settings load/save       │
│   ├── documents.rs  document + recent store  │
│   ├── state.rs      shared application state │
│   └── lib.rs        Tauri commands + setup   │
└──────────────────────────────────────────────┘
             │
             ▼
      ~/.json_studio/
```

## 前端结构

| 路径 | 职责 |
| --- | --- |
| `src/App.tsx` | 应用启动、主题/语言应用、页面切换与全局 Toast |
| `src/components/Titlebar.tsx` | 品牌、当前模块、主题切换、帮助入口 |
| `src/components/Rail.tsx` | JSON / 对比 / JSON 流 / Mock / 设置一级导航 |
| `src/components/JsonEditor.tsx` | CodeMirror 6 封装、JSON 高亮、查找面板 |
| `src/components/Toast.tsx` | 成功与错误反馈 |
| `src/pages/JsonToolPage.tsx` | 最近文件与 JSON 文档编辑 |
| `src/pages/SettingsPage.tsx` | 语言、主题、Mock 端口、HTTPS、数据目录、关于 |
| `src/store.ts` | Zustand 应用状态与 Tauri 命令调用 |
| `src/api.ts` | 前端到 Rust 的命令边界 |
| `src/i18n.ts` | 中英文共享文案目录 |
| `src/codegen.ts` | JSON → TypeScript 类型预览 |
| `src/theme.ts` | 浅色 / 深色 / 跟随系统解析 |

## Rust 结构

| 路径 | 职责 |
| --- | --- |
| `src-tauri/src/lib.rs` | Tauri 插件、setup、命令注册 |
| `src-tauri/src/data.rs` | `~/.json_studio` 目录布局、原子级文件权限、JSON 读写 |
| `src-tauri/src/settings.rs` | 设置结构、校验、加载与保存 |
| `src-tauri/src/documents.rs` | 文档读取/保存/新建、最近文件存储、50 MB 限制 |
| `src-tauri/src/state.rs` | 设置与最近文件的共享互斥状态 |

当前命令：

- `bootstrap` — 设置、数据目录、最近文件
- `update_settings`
- `list_recent_documents`
- `create_json_document`
- `open_json_document`
- `save_json_document`
- `remove_recent_json_document`

## 数据与安全边界

- 数据根目录固定为 `~/.json_studio/`；macOS/Linux 目录 `0700`，配置文件 `0600`，Windows 依赖用户目录 ACL。
- 新建 JSON 默认写入 `~/.json_studio/documents/`；用户打开的外部文件在原路径保存。
- 最近文件只记录元数据，删除最近项不会删除磁盘文件。
- 编辑器单文件读取上限 50 MB；超过时返回明确错误。
- 不发起非本地网络请求；Mock 服务后续只绑定 `127.0.0.1` / `::1`。
- Rust 侧负责路径、网络、Mock 与审计策略；UI 只调用命令，不绕过安全边界。

## 模块边界

1. **应用基础**：窗口、数据目录、设置、主题、i18n、Toast（已完成）
2. **JSON 工作区**：最近文件、单文档编辑、校验、保存、基础代码视图（已完成）
3. **JSON 对比**：A/B 文件、结构化与文本差异、忽略键顺序、变更过滤、同步滚动（已完成；独立搜索待补）
4. **JSON 流**：`notify` 文件监听、增量 zstd 解码、10,000 条 / 50 MB 缓冲、虚拟列表、对话视图（待实现）
5. **JSON Mock**：项目库、无状态路由、单 localhost 服务、HTTP/HTTPS、请求日志、导出（待实现）
6. **审计**：Rust 单一策略模块、500 条内存保留、确认状态、审计面板（待实现）
7. **树 / 表格 / 图形视图**：复用解析树与选择检查器（待实现）

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
