# mioku-plugin-agent

适用于私聊的 Mioku agent 助手插件。与 chat 插件可同时启用

## 特性

- **独立 agent 循环**：基于 AI 服务实例（主模型角色绑定），工具循环、流式输出
- **跨平台**：bash 工具在 macOS/Linux 用 bash（缺失时回退 sh）、Windows 用 cmd.exe；工作区目录自动创建
- **五种权限模式**：
  - `read-only` 只读：不能写文件，bash 每条都要审批
  - `workspace-write` 工作区内写入：写入限制在工作区，bash 每条都要审批
  - `auto` 自动：文件与命令直接执行，但**每条命令先由工作模型审查**，危险操作（删除用户文件、清库、`git push`、sudo 等）转用户审批；执行通知与审批请求都即时推送
  - `full` 完全访问：不审批，命令与写入/编辑汇总成一条转发记录
  - `yolo` 静默：权限最高且**不推送任何中间通知**，用户只收到最终结果
- **个人工作区**：每个「适配器 + 用户」独立工作区，默认 `data/agent/workspace/<适配器>_<用户id>`（openid 平台同样隔离）
- **聊天内审批**：非 full 权限档下 bash 命令需 `.agent approve` 批准（不带 id 时处理该用户最近一次请求）；每条命令都必须带 `purpose`，审批与执行告知都会带上用途
- **操作合并转发**（仅 `full`）：命令、写入、编辑不再逐条推送，而是攒到本轮结束、在最终回复**之前**合并成一条合并转发消息（卡片来源「Agent 执行记录」，外显小字是操作条数与用户请求摘要，总摘要是各类操作计数与失败数；首节点为简介，其余节点按时间顺序记录每条命令/文件改动，含用途、耗时与失败输出）。适配器不支持转发时自动降级为普通文本消息。`read`/`glob`/`grep`/联网/看图等只读操作不记录。`auto` 不合并，仍逐条即时推送
- **工具面**：read / write / edit / glob / grep / bash / view_image / send_file / send_image / web_search (SearXNG) / web_fetch / todo_write
- **附件自动下载**：用户发来的图片/文件/音视频统一按文件自动落到 `download/<今天日期>/`，**保留原始文件名与后缀**（`file_name` → segment 的 `file` → `path` → URL 文件名，缺后缀才用 content-type 补）；user 消息里带 `message_id`、`name` 和 `[file://路径]`，图片额外作为图片内容附加给模型。文件消息只有 `file_id` 时按平台分支解析下载地址，见下
- **消息引用**：模型在回复首行写 `[reply:message_id]` 即可引用（回复）指定聊天消息，标记会被移除并只作用于本轮第一条消息
- **运行中插话**：Agent 正在跑时用户继续发消息，不再排队等下一轮，而是并入**当前请求**的下一次迭代（DSH 式 steering），模型在同一个回复里就能看到并调整；日志里 `steer queued` 表示已入队、`steer merged into running turn` 表示已并入本轮请求
- **看图**：`view_image` 查看本地图片；多模态主模型直接把图片附加进对话，非多模态时交给视觉模型转成描述
- **任务清单**：`todo_write` 整表替换（创建/改状态），沿用 DSH 语义；每次变更都会把最新清单推送给用户
- **人设 / 说话风格 / 情绪共用**：直接读取 chat 插件 `personalization` 的 persona、`replyStyle.baseStyle`（长期稳定语气）与 emotion 定义，写进 system 提示词；chat 未安装时不下发人设与风格
- **情绪处理**：默认使用 chat 配置的默认情绪，只有模型主动写 `[emotion:name]` 才切换（不做自动情绪分析），情绪随会话持久化
- **媒体处理**：多模态主模型直接把图片作为图片内容放进 user 消息；非多模态时用视觉模型转成文字描述
- **运行日志**：每轮固定输出 turn start / turn done（轮次、工具数、耗时）；`debug` 打开后额外输出完整 system prompt、原始回复、推理与工具调用明细
- **缓存友好**：单条 system 提示词按「变化频率」排序（人设/风格/规则/工具 → 环境/情绪/目标/计划），时间只精确到小时且情绪不再自动刷新；user 消息只保留正文、`message_id` 与媒体清单
- **自动上下文压缩**：超过阈值时用工作模型把较早对话压缩为摘要
- **数据收集**：运行记录、工具调用明细落盘 `data/agent/agent.db`；token 用量通过 AI 服务 usage 上报（source=agent）
- **TODO**：skills 加载、MCP 协议、长期记忆/知识库（vector + BM25 + rerank 混合检索，规划为独立 service）

## 触发范围

默认仅 bot 主人私聊可用；可在配置中允许管理员或指定用户。

私聊中以 `.` / `/` / `~` 开头的消息视为命令，agent 直接忽略不处理

## 命令

| 命令                                                               | 说明                                                                   | 权限     |
|------------------------------------------------------------------|----------------------------------------------------------------------|--------|
| `.agent approve` / `.agent deny`                                 | 批准/拒绝最近一次命令执行审批（可带 id 指定某条）                                          | master |
| `.agent new`                                                     | 当前会话转入后台（异步生成标题），开启全新会话                                              | master |
| `.agent resume` / `.agent resume <序号>`                           | 列出后台会话 / 恢复对应会话（上下文、目标、计划随会话恢复）                                      | master |
| `.agent archive` / `.agent archive list` / `.agent archive <序号>` | 归档当前会话并开新会话 / 查看归档 / 归档列表中的会话                                        | master |
| `.agent permission [级别]`                                         | 查看/切换权限模式（read-only / workspace-write / auto / full / yolo），写入配置立即生效 | master |
| `.agent goal [目标]`                                               | 查看/设置/清除会话目标（注入系统提示词）                                                | master |
| `.agent plan [每行一项]`                                             | 查看/设置/清除会话计划；agent 运行中用 todo_write 工具自动维护                            | master |
| `.agent compact`                                                 | 立即把较早上下文压缩为摘要                                                        | master |
| `.agent reset`                                                   | 清空当前会话上下文                                                            | master |
| `.agent stop`                                                    | 停止当前正在运行的会话：中止模型请求、拒绝待审批命令、丢弃排队消息                                    | master |
| `.agent clear` / `.agent clear confirm`                          | 清除该用户全部保存会话（含归档）及其消息/运行记录，需二次确认（60 秒内有效）                             | master |
| `.agent status`                                                  | 会话、权限、模型/情绪、token 速度/用量/上下文占用（读自 AI 服务 usage 记录）、目标/计划与待审批项          | master |

Token 数据来自 AI 服务的 usage 记录（`AIService.getUsageRecords`，按 session_id 查询），输出速度按最近一次请求与全会话平均分别显示，上下文占用按最近一次请求的输入+输出 token 与模型窗口求占比。

## 依赖服务

`ai` / `config` / `screenshot`（Markdown 截图关闭时可不装）。
