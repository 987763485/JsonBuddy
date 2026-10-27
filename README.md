# JSON Buddy

JSON Buddy 是一个本地优先的 JSON 桌面工作台：编辑与校验 JSON、结构化对比、监控 JSONL / `.jsonl.zstd` 流、运行本地 Mock API，并在使用过程中保持数据不离开本机。

UI 已在 `design/prototype.html` 中锁定；桌面应用直接加载该原型的 HTML/CSS，通过 `ui/bridge.ts` 注入真实编辑能力并调用 Tauri 2 Rust 后端，确保界面与原型一致。

## 当前状态

界面层已切换到锁定原型，并完成以下真实数据桥接：

- Tauri 2 应用直接加载锁定原型的 HTML/CSS/DOM；窗口内容铺满 webview，原生交通灯叠放在原型标题栏上
- 本地数据目录 `~/.json_buddy/` 初始化与旧目录迁移
- 设置桥接：语言、主题、Mock 端口、HTTPS 开关持久化
- JSON 工具桥接：最近文件、新建、打开、保存、移除
- JSON 对比桥接：两侧文件读取、最近文件菜单与本地文件选择
- JSON 流桥接：JSONL / `.jsonl.zstd` 快照、跟随、暂停、删除与实时事件渲染
- 流对话视图：Rust 归一化用户/助手消息、思考、工具调用、模型切换、会话统计与只读状态
- 审计：Rust 按规则分类目录穿越、删除、上传、外发、Shell 与读取，支持类别设置、确认持久化和严重级别筛选
- 树视图：第六种视图，支持展开/折叠、节点筛选、路径检查器、复制路径与跳转源码
- JSON Mock 桥接：项目持久化、端点编辑、响应体 CodeMirror 编辑、生成/导入/导出、真实请求日志、HTTP/HTTPS 本地服务启停
- 在原型编辑器与 Mock 响应区域注入 CodeMirror 6，保持原型的排版与语法色
- 格式化、压缩、校验仍由原型交互驱动，保存写入真实文件
- 成功 / 失败 Toast 使用原型现有组件

表格与图形数据视图仍待接入。React 版本（`src/`）保留为业务与交互参考，不参与 Tauri 界面构建。

## 技术栈

- **桌面**：Tauri 2、Rust
- **界面**：锁定原型 HTML/CSS（运行时由 `scripts/sync-ui.mjs` 同步）
- **桥接**：TypeScript、Vite 8
- **编辑器**：CodeMirror 6（注入原型编辑区域）
- **字体**：原型字体栈，Inter / JetBrains Mono
- **数据**：本地 `~/.json_buddy/`，不上传网络

## 开发

要求：

- Node.js 20.19+（当前使用 Node 22）
- Rust 1.77.2+
- macOS、Windows 或 Linux 桌面环境

```bash
npm install
npm run tauri:dev
```

只构建界面：

```bash
npm run build
```

构建桌面应用：

```bash
npm run tauri:build
```

`npm run dev` / `npm run build` 会先把锁定原型同步为 `ui/index.html`，再构建桥接脚本。React 参考实现可通过 `npm run dev:react` 和 `npm run build:react` 单独运行，不参与桌面发布。

## 数据目录

应用数据默认位于：

```text
~/.json_buddy/
├── settings.json
├── recent.json
├── documents/       # 新建 JSON 文档
├── mock/
│   ├── projects/    # Mock 项目
│   ├── certs/       # HTTPS 本地证书
│   └── logs/        # 当前会话请求日志
├── audit/
└── cache/streams/   # 流缓冲临时文件
```

用户主动打开的外部 JSON 文件仍保存在原路径；新建文档默认写入 `documents/`。首次启动时若检测到旧 `~/.json_studio/` 且新目录不存在，会尝试自动迁移；迁移失败则保留旧目录并创建新目录。

## 文档

- [`AGENT.md`](./AGENT.md) — 角色、约束、当前工作与文档索引
- [`design/README.md`](./design/README.md) — 产品设计、交互说明、实现说明与 v1.0 决策
- [`design/prototype.html`](./design/prototype.html) — 已锁定的 UI 原型，禁止修改
- [`docs/architecture.md`](./docs/architecture.md) — 工程架构、模块边界与安全约束

## 开发约定

- UI 原型文件冻结，所有实现改动只能进入应用代码。
- 功能开发在 `dev` 分支，大模块完成后提交；主要版本合并到 `main`。
- 提交信息只描述新增、修改或修复，不包含版本迭代或发布信息。
- 应用不发起任何非本地网络请求；Mock 服务只绑定 localhost。
- 所有无可见结果的完成操作必须显示本地化 Toast。
