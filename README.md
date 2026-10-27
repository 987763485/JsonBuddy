# JSON Buddy

JSON Buddy 是一个本地优先的 JSON 桌面工作台：编辑与校验 JSON、结构化对比、监控 JSONL / `.jsonl.zstd` 流、运行本地 Mock API，并在使用过程中保持数据不离开本机。

UI 已在 `design/prototype.html` 中锁定；桌面应用直接加载该原型的 HTML/CSS，通过 `ui/bridge.ts` 注入真实编辑能力并调用 Tauri 2 Rust 后端，确保界面与原型一致。

## 当前状态

界面层已切换到锁定原型，并完成以下真实数据桥接：

- Tauri 2 应用直接加载锁定原型的 HTML/CSS/DOM；窗口内容铺满 webview，原生交通灯叠放在原型标题栏上
- 本地数据目录 `~/.json_buddy/` 初始化与旧目录迁移
- 设置桥接：语言、主题、Mock 端口、HTTPS 开关持久化；运行中修改端口或 HTTPS 会自动重启 Mock 服务
- JSON 工具桥接：最近文件、新建、打开、保存、移除；编辑后防抖自动保存，标题栏圆点显示未保存状态
- JSON 对比桥接：两侧文件读取、最近文件菜单与本地文件选择
- JSON 流桥接：JSONL / `.jsonl.zstd` 快照、跟随、暂停、删除与实时事件渲染；源代码固定行高虚拟列表、自动换行回退、脱离时新事件计数与一键跟随、真实事件速率、保留缓冲计数与最后事件时间；超出 10,000 条 / 50 MB 的事件写入本地会话缓存，滚动到顶部时按需加载更早事件
- 流对话视图：Rust 归一化用户/助手消息、思考（可展开）、工具调用、模型切换、会话统计与只读状态
- 审计：Rust 按规则分类目录穿越、删除、上传、外发、Shell 与读取，支持类别设置、按类别复用确认并持久化、严重级别筛选、原始事件定位与动态本地化；应用级事件与 Mock 路由穿越会进入当前审计面板；启用网络类别后，被拒绝的非本地请求也会记录
- 树视图：第六种视图，支持展开/折叠、键盘导航、节点筛选、路径检查器、复制路径与跳转源码
- 表格视图：真实 JSON 分节、列选择、行筛选、单元格检查器、源码定位与本地化空状态；长数组与对象按滚动窗口虚拟渲染，不再截断 500 行
- 图形视图：真实 JSON 节点/边、拖拽、缩放、布局切换与迷你地图
- 代码生成：从当前 JSON 生成 TypeScript、JavaScript、Java、C#、Go、Rust、Swift、Kotlin、Python、PHP、Dart 与 JSON Schema
- 导入导出：CSV / JSON / JSONL 导入写入本地文档目录；CSV、Excel、Mock 与生成代码通过原生保存对话框导出
- JSON 搜索：键/值筛选、结果计数与跳转定位到编辑器；Mock 生成默认 100 条、上限 1,000 条；生成参数随项目保存，生成数据只作为运行期响应并在打开或启动项目时重新生成，不写入项目文件
- JSON Mock 桥接：项目持久化、项目独立启停与路由挂载/卸载（共享本地服务同时绑定 `127.0.0.1` 与 `::1`，支持路径参数、查询参数与穿越拦截）、端点编辑、响应体 CodeMirror 编辑、JSON Schema / OpenAPI（JSON、YAML）导入（远程 `$ref` / `$id` 拒绝、1,000 定义上限、导入来源随接口持久化）、生成/导出（JSON Schema 使用 `$defs`，OpenAPI 默认 YAML，可在保存对话框选择 `.json` 导出 JSON）、真实请求日志、HTTP/HTTPS 本地服务启停、服务运行时长与总请求数；Mock 路由中的 `..` 穿越会返回 403 并写入审计；端点测试请求由 Rust 原生发送，绕过 webview CORS 并接受应用自签名证书，目标严格限制在 localhost
- 状态栏：有效/无效 JSON、光标行号列号、光标 JSON 路径（可复制）、按文档检测的缩进宽度与图形缩放比例随真实状态更新
- 桌面集成：原生 macOS 菜单（新建、打开 JSON/流、保存、设置与编辑命令）随语言重建；拖放 JSON / JSONL / `.jsonl.zstd` 文件到窗口即可打开
- 在原型编辑器与 Mock 响应区域注入 CodeMirror 6，保持原型的排版与语法色
- 复制操作使用 Tauri 剪贴板插件并显示本地化 Toast；内置 Inter 与 JetBrains Mono 字体，不请求网络字体
- 格式化、压缩、校验仍由原型交互驱动，保存写入真实文件
- 成功 / 失败 Toast 使用原型现有组件

React 版本（`src/`）保留为业务与交互参考，不参与 Tauri 界面构建。

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
└── cache/streams/   # 超出内存缓冲的流事件
```

用户主动打开的外部 JSON 文件仍保存在原路径并参与自动保存；新建文档默认写入 `documents/`。首次启动时若检测到旧 `~/.json_studio/` 且新目录不存在，会尝试自动迁移；迁移失败则保留旧目录并创建新目录。

## 文档

- [`AGENT.md`](./AGENT.md) — 角色、约束、当前工作与文档索引
- [`design/README.md`](./design/README.md) — 产品设计、交互说明、实现说明与 v1.0 决策
- [`design/prototype.html`](./design/prototype.html) — 已锁定的 UI 原型，禁止修改
- [`docs/architecture.md`](./docs/architecture.md) — 工程架构、模块边界与安全约束

## 开发约定

- UI 原型文件冻结，所有实现改动只能进入应用代码。
- 功能开发在 `dev` 分支，大模块完成后提交；主要版本合并到 `main`。
- 提交信息只描述新增、修改或修复，不包含版本迭代或发布信息。
- 应用不发起任何非本地网络请求；Mock 服务只绑定 localhost，端点测试请求也由 Rust 校验后仅访问回环地址。
- 所有无可见结果的完成操作必须显示本地化 Toast。
