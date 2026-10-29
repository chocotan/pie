# pie Web UI

pie 的浏览器界面：多工作区会话管理 + 流式对话 + 工具调用可视化。React 18 + CSS Modules + Vite，本地 Node host 通过 RPC 驱动 `packages/coding-agent`。

`prototype.html` 是已确认的静态设计原型（单文件、可直接打开），不是运行中的应用；正式入口见下方启动方式。

## 启动

```sh
npm run dev -w @pie/web        # 开发：同一进程提供 API + WebSocket + Vite（HMR）
# 或从仓库根目录：
npm run dev:web
```

生产模式（不验证 build 产物时使用）：

```sh
npm run build -w @pie/web      # vite build → apps/web/dist
npm run start -w @pie/web      # 静态服务 dist + API + WebSocket
```

参数：`--port N`（或 `PIE_WEB_PORT`，默认 5277）、`--bind ADDR`（默认 127.0.0.1）、`--agent-cli PATH`（或 `PIE_WEB_AGENT_CLI`，覆盖 agent 入口，用于 faux RPC 测试）。

## 访问令牌与安全

- 每次启动生成随机 token，打印一次：`pie Web UI 已启动: http://127.0.0.1:5277/?token=...`。token 不写入任何文件或日志；页面打开后会把 token 移入 sessionStorage 并从地址栏清除。
- 默认仅绑定 127.0.0.1；`/api` 需要 `Authorization: Bearer`，WebSocket 握手需要 `?token=`（浏览器无法设置 WS 头）；Host 必须是 loopback；带 Origin 的写请求必须同源；JSON body 上限 1MB。

## 多工作区

- 左侧栏列出工作区（默认包含 host 启动目录），每个工作区可展开/收起，下面显示该目录的会话（`SessionManager.list`）。
- 「添加工作区」接受绝对路径，host 校验存在、是目录并 realpath 去重；持久化到 pie 配置目录的专用文件 `pie-web-workspaces.json`（原子写入，不影响其他设置）。
- 每个工作区在首次激活时懒启动一个独立的 agent RPC 子进程，事件缓存（上限 1000 条）与订阅互相隔离；切换工作区不会停止其他工作区正在运行的生成。server 关闭时统一清理。

## RPC 架构

```
浏览器 (React)
  │  HTTP /api/*（Bearer）+ WS /ws（事件推送）
  ▼
host/ (node:http + ws，本进程)
  │  每工作区一个子进程：node <pi-coding-agent>/dist/bundle/cli.js --mode rpc
  ▼
coding agent RPC（JSONL stdin/stdout）
```

- 共享协议类型与边界校验在 `shared/protocol.ts`；host 对来自 agent 进程的数据按 unknown 收窄后白名单转发。
- 会话快照 = `get_state` + `get_messages` + `get_session_stats` + 模型/思考强度列表 + 进行中 run 的缓存事件；事件带 (workspaceId, sessionId)，前端只把匹配当前快照的事件写入状态（事件隔离）。
- 前端流式重建是纯函数（`src/state/convo-reducer.ts`）：text/thinking delta 按 contentIndex 累积，toolcall 参数按 JSON 片段累积，tool_execution_* 驱动工具卡状态。
- 扩展对话框（select/confirm/input/editor）以模态回复，notify 显示为非阻塞通知。
- 断线重连：host 跟踪未答复的扩展 UI 请求与仍在运行的工具事件，新 WS 连接建立后重放；客户端重连后重取已加载工作区的权威快照。事件按 (workspaceId, sessionId) 过滤，旧会话/已停止进程的迟到事件不会写入当前快照。
- 字段归一：host 在边界把 toolCall 块的 toolCallId/toolName/input 拼写统一为 id/name/arguments。

## 轨迹（Trajectory）

- 每个持久化会话条目与进行中的事件各占一行：用户、助手、思考、工具、压缩、模型/思考强度切换、自定义条目。
- 行内显示时间、类型、工具名/请求号与单行预览；点击行打开右侧详情（概述 / 预览 / 原始内容）。
- 工具调用从 assistant 消息的 toolCall 块生成，并按 toolCallId 合并对应的 toolResult，因此结果先落盘也不会出现重复行。
- 进行中的 run 额外显示思考与文字行，并把工具状态标为运行中；`agent_settled` 后自动重新读取权威条目替换这些临时行。
- 支持按关键字搜索与按类型过滤（全部 / 用户 / 助手 / 工具 / 系统），顶部显示事件数、轮次数与工具次数。
- 数据来自 RPC `get_entries`，host 只返回最近 300 条、每条原始 JSON 最多 4000 字符；打开轨迹时才请求，不进入对话快照。

## API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 工作区与各工作区会话列表 |
| POST | `/api/workspaces` | 添加工作区 |
| DELETE | `/api/workspaces/:id` | 移除工作区并停止其 RPC 进程 |
| GET | `/api/workspaces/:id/sessions` | 重新列出会话 |
| GET | `/api/workspaces/:id/snapshot` | 会话快照（消息、状态、模型、统计） |
| GET | `/api/workspaces/:id/trajectory` | 当前会话的轨迹条目 |
| POST | `/api/workspaces/:id/new-session` | 新建会话 |
| POST | `/api/workspaces/:id/select-session` | 切换会话 |
| POST | `/api/workspaces/:id/prompt` | 发送消息 |
| POST | `/api/workspaces/:id/abort` | 中止当前运行 |
| POST | `/api/workspaces/:id/model` | 切换模型 |
| POST | `/api/workspaces/:id/thinking-level` | 切换思考强度 |
| POST | `/api/workspaces/:id/session-name` | 重命名会话 |
| POST | `/api/workspaces/:id/extension-ui` | 回复扩展对话框 |
| WS | `/ws?token=` | 事件、扩展请求、运行时状态推送 |

## 测试

```sh
npm run test -w @pie/web       # vitest：工作区注册表、HTTP/WS 鉴权、事件收窄、前端 reducer
```

端到端（无真实 provider）：`node host/main.ts --dev --agent-cli test/fixtures/faux-agent.mjs` 使用 faux RPC 子进程，可在浏览器完整走通对话/工具卡/扩展对话框/中止流程。faux 支持的 prompt 前缀：`ask`（触发 select 对话框）、`notify`（触发通知）、`slow`（慢速流式，测中止）。

## 当前限制

- 轨迹是事件账本：没有 dsh 的时间线缩略图和按帧虚拟滚动，超长会话只保留最近 300 条。
- 同一工作区内生成中时禁止切换/新建会话（单个 RPC 进程同一时间只有一个活动会话）；跨工作区不受影响。
- 「后台任务」tab 恒为空状态：当前 RPC 事件流没有可可靠识别后台任务的数据来源，不伪造。
- 会话重命名入口：双击当前会话的侧栏标题。
- 扩展的 setStatus/setWidget/setTitle/set_editor_text 请求暂无 UI 表面，host 直接丢弃。
- 生产静态路径支持但本阶段未做 build 产物验证。
