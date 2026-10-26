# JSON Buddy

JSON Buddy 是一个本地优先的 JSON 桌面工作台：编辑与校验 JSON、结构化对比、监控 JSONL / `.jsonl.zstd` 流、运行本地 Mock API，并在使用过程中保持数据不离开本机。

UI 已在 `design/prototype.html` 中锁定；桌面实现使用 Tauri 2 + React + TypeScript。

## 当前状态

已完成应用工程基础与 JSON 文档工作区：

- Tauri 2 应用外壳、原生窗口、macOS overlay 标题栏
- 本地数据目录 `~/.json_buddy/` 初始化
- 英文 / 简体中文界面与浅色 / 深色 / 跟随系统主题
- 设置：语言、主题、Mock 端口、HTTPS 开关、数据目录
- JSON 最近文件列表、搜索、新建、打开、移除
- CodeMirror 6 JSON 编辑器，格式化、压缩、校验、保存、查找
- TypeScript 类型生成预览
- JSON 树视图、表格视图与分栏视图
- JSON 对比：A/B 文件选择、结构化与文本差异、忽略键顺序、变更过滤、同步滚动
- JSON 流：JSONL / `.jsonl.zstd` / `.jsonl.zst` 最近列表、源码尾部、事件面板、级别与文本过滤、虚拟列表、跟随/暂停
- 成功 / 失败 Toast、未保存状态与退出编辑确认

流对话视图、Mock 服务与审计将在后续模块继续实现。模块状态与提交节奏见 [`AGENT.md`](./AGENT.md)。

## 技术栈

- **桌面**：Tauri 2、Rust
- **前端**：React 19、TypeScript、Vite 8、Zustand
- **编辑器**：CodeMirror 6
- **字体**：Inter、JetBrains Mono（随应用打包）
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

只构建前端：

```bash
npm run build
```

构建桌面应用：

```bash
npm run tauri:build
```

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
