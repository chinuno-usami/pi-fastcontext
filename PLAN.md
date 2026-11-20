# pi-fastcontext 实现计划

> 本文档交给实现 agent 使用。实现前先通读 pi 扩展文档：
> `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
> 重点章节：Custom Tools、Tool Exposure、Output Truncation、ctx.modelRegistry、State Management、Custom Rendering。
> 参考示例（同目录 `examples/extensions/`）：`custom-compaction.ts`（用其他模型调 `complete`）、`truncated-tool.ts`、`structured-output.ts`、`subagent/`、`model-status.ts`。

## 1. 目标

主模型（SOTA）在定位代码时会反复调用 grep/find/read，这些输出留在主上下文里，后续每一轮都重复计费。本扩展提供一个 `fast_context` 工具：

- 在扩展进程内用**低成本模型**跑一个受限的只读搜索循环（并行工具调用、轮数有上限）。
- 返回给主模型的只有**精确的 `path:start-end` 列表和短片段**，不返回长篇总结。
- 低成本模型从 **pi 自身的模型列表**中选择（`ctx.modelRegistry`），复用 pi 已配置的 provider 和认证。

不做的事（YAGNI）：向量索引、embedding、跨会话缓存、修改文件。这些放到后续版本评估（见第 10 节）。

## 2. 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 子模型调用方式 | 进程内循环，调用 `ctx.modelRegistry.complete(model, { systemPrompt, messages, tools }, { signal, ... })` | 不用像 `subagent` 示例那样起 `pi` 子进程，省掉冷启动和完整系统提示的开销；能精确控制 prompt、工具和预算 |
| 子模型可用工具 | 用 `createGrepToolDefinition` / `createFindToolDefinition` / `createReadToolDefinition` / `createLsToolDefinition`（从 `@earendil-works/pi-coding-agent` 导出）直接调用其 `execute` | 复用内置实现的 rg 调用、截断和路径处理。不走 `ctx.executeTool`，因为 grep/find 默认不在主会话的激活工具里，而且会触发主会话的 `tool_call` 钩子和事件 |
| 结束方式 | 子模型必须调用 `report` 工具提交结构化结果 | 结构可校验。扩展拿到行范围后**自己**读取片段，片段内容不经过子模型转述，避免幻觉 |
| 模型选择 | `/fastcontext-model` 命令从 `ctx.modelRegistry.getAvailable()` 中选，持久化到配置文件；另支持 `--fastcontext-model` 参数 | 满足"从 pi 模型列表选择" |
| 未配置模型时 | 工具返回 `isError: true`，提示用户运行 `/fastcontext-model` | 不静默回退到主模型，否则省钱的目的落空 |
| 用量统计 | 汇总子模型每次调用的 `usage`，作为工具结果的 `usage` 返回 | pi 会把它计入 footer 和 `/session` 统计，便于对比成本 |

## 3. 目录结构

```
pi-fastcontext/
├── package.json          # pi.extensions 指向 ./src/index.ts；host 包放 peerDependencies，不放 dependencies
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts          # 入口：注册工具、命令、flag、事件
│   ├── config.ts         # 读写配置，合并默认值
│   ├── model-select.ts   # 解析 / 选择 / 校验子模型
│   ├── prompt.ts         # 子模型系统提示与 report 工具定义
│   ├── inner-tools.ts    # 子模型可用的只读工具封装（路径限制、单次输出上限）
│   ├── loop.ts           # 搜索循环：轮次、并行执行、预算、取消
│   ├── snippets.ts       # 根据 report 结果读取片段、合并重叠区间、控制总长度
│   ├── format.ts         # 生成返回给主模型的文本
│   └── render.ts         # renderCall / renderResult
└── test/
    ├── loop.test.ts
    ├── snippets.test.ts
    ├── config.test.ts
    └── fixtures/         # 小型示例仓库
```

`package.json` 关键字段：

```json
{
  "name": "pi-fastcontext",
  "type": "module",
  "pi": { "extensions": ["./src/index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

本地调试：`pi -e ./src/index.ts`。安装：软链到 `~/.pi/agent/extensions/pi-fastcontext/` 或在 settings 的 `extensions` 中加入路径。

## 4. 配置与模型选择

### 4.1 配置文件

- 全局：`join(getAgentDir(), "fastcontext.json")`（`getAgentDir` 从 `@earendil-works/pi-coding-agent` 导入）。
- 项目：`join(ctx.cwd, CONFIG_DIR_NAME, "fastcontext.json")`，**仅当 `ctx.isProjectTrusted()` 为 true 时读取**。项目配置覆盖全局配置。
- 不要硬编码 `.pi`，使用 `CONFIG_DIR_NAME`。

```ts
interface FastContextConfig {
  model?: string;            // "provider/modelId"
  reasoning?: "off" | "minimal" | "low" | "medium" | "high"; // 默认 "low"，模型不支持推理时忽略
  maxTurns: number;          // 默认 4
  maxParallelCalls: number;  // 每轮最多执行的工具调用数，默认 8
  maxResults: number;        // report 最多条目，默认 12
  maxOutputBytes: number;    // 返回主模型的总字节数，默认 12_000
  maxLinesPerSnippet: number;// 默认 40
  innerToolMaxBytes: number; // 子模型单次工具输出上限，默认 16_000
  timeoutMs: number;         // 整个工具调用的超时，默认 90_000
  nudgeBroadSearch: boolean; // 是否在主模型直接用 grep/find 时附加提示，默认 false
}
```

读取时校验类型和范围，非法值回退默认值并 `ctx.ui.notify` 警告一次。

### 4.2 模型解析顺序

1. `--fastcontext-model provider/id` flag（`pi.registerFlag`）。
2. 项目配置 `model`（项目已信任时）。
3. 全局配置 `model`。
4. 都没有：工具返回错误，提示运行 `/fastcontext-model`。

解析出 `provider/id` 后：

- `ctx.modelRegistry.find(provider, id)` 找不到 → 错误：模型不存在。
- `ctx.modelRegistry.hasConfiguredAuth(model)` 为 false → 错误：该 provider 未配置认证。
- 模型不支持工具调用时（如果 `Model` 类型上有对应能力字段，实施时查 `pi-ai` 的 `Model` 定义确认）→ 错误。
- 子模型与 `ctx.model` 相同 → 允许，但在结果的 `details.warnings` 中记录"未节省成本"。

### 4.3 `/fastcontext-model` 命令

```
/fastcontext-model                 # 打开选择器
/fastcontext-model provider/id     # 直接设置
/fastcontext-model --project ...   # 写入项目配置（需项目已信任）
/fastcontext-model clear           # 清除
```

选择器实现：

- 候选列表：若 `ctx.scopedModels` 非空，优先列出这些模型；然后列出 `ctx.modelRegistry.getAvailable()` 中剩余的模型。按 provider 分组显示 `provider/id`，如果 `Model` 上有 `cost` 字段就附上输入/输出单价，方便用户挑便宜的。
- 使用 `ctx.ui.select(title, items)`。`ctx.hasUI` 为 false 时只接受参数形式。
- 写入配置后 `ctx.ui.notify` 确认，并更新 footer 状态（见 4.4）。
- 为参数形式注册自动补全（可选，参考 `github-issue-autocomplete.ts`）。

### 4.4 状态显示

`session_start` 和模型变更后调用 `ctx.ui.setStatus("fastcontext", "fc: provider/id")`；未配置时显示 `fc: (未设置)`。

## 5. `fast_context` 工具

### 5.1 注册

```ts
pi.registerTool({
  name: "fast_context",
  label: "Fast Context",
  description:
    "用低成本模型在当前仓库中定位与问题相关的代码，返回 path:start-end 和短片段。只读。" +
    "适合'X 在哪里实现'、'哪些地方调用了 Y'、'修改 Z 需要看哪些文件'这类问题。",
  promptSnippet: "定位相关代码，返回 path:line 范围和片段（低成本子模型）",
  promptGuidelines: [
    "在不知道代码位置时，先调用 fast_context，不要直接用 grep/find/大范围 read 探索仓库。",
    "fast_context 返回行范围后，只对需要修改或细看的范围调用 read（带 offset/limit）。",
    "已知确切文件和行号时不要调用 fast_context。",
  ],
  parameters: FastContextParams,
  outputSchema: FastContextOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async execute(toolCallId, params, signal, onUpdate, ctx) { ... },
  renderCall, renderResult,
});
```

`promptGuidelines` 中每条都必须写出工具名 `fast_context`（文档要求）。

### 5.2 参数

```ts
const FastContextParams = Type.Object({
  query: Type.String({ description: "要找的内容，用自然语言描述，可附带已知的符号名、文件名、报错信息" }),
  paths: Type.Optional(Type.Array(Type.String(), { description: "限定搜索的子目录或文件，相对 cwd" })),
  maxResults: Type.Optional(Type.Number({ description: "返回条目上限，默认取配置" })),
});
```

- `paths` 中每一项去掉开头的 `@`，`resolve(ctx.cwd, p)` 后必须仍在 `ctx.cwd` 内，否则报错。
- `maxResults` 截到 `[1, config.maxResults]`。

### 5.3 输出

```ts
const FastContextOutput = Type.Object({
  results: Type.Array(Type.Object({
    path: Type.String(),      // 相对 cwd
    startLine: Type.Number(),
    endLine: Type.Number(),
    reason: Type.String(),    // 子模型给出的一句话理由
  })),
  notes: Type.Optional(Type.String()), // 子模型的简短补充，<= 300 字符
  truncated: Type.Boolean(),
});
```

返回给主模型的 `content` 文本格式（由 `format.ts` 生成）：

~~~~
fast_context: 5 results for "where is session compaction triggered"

1. src/core/compaction.ts:120-158  — 自动压缩的触发判断
```ts
<片段，最多 maxLinesPerSnippet 行，带行号>
```
2. ...

notes: <可选>
~~~~

`details` 存放：解析后的模型 id、轮数、每轮工具调用摘要（名称和参数，不含输出）、用量、耗时、警告、截断信息。`details` 的类型在所有返回路径（包括 `onUpdate` 的部分结果和错误）中保持一致。

## 6. 搜索循环（`loop.ts`）

### 6.1 子模型工具

| 工具 | 实现 | 限制 |
|---|---|---|
| `grep` | `createGrepToolDefinition(cwd)` | 输出超过 `innerToolMaxBytes` 用 `truncateHead` 截断并注明 |
| `find` | `createFindToolDefinition(cwd)` | 同上 |
| `ls` | `createLsToolDefinition(cwd)` | 同上 |
| `read` | `createReadToolDefinition(cwd)` | 强制要求 `limit`，缺省时补 `limit: 200`，上限 400 |
| `report` | 本扩展定义 | 调用即结束循环 |

说明：

- 只把上述工具的 `{ name, description, parameters }` 放进 `Context.tools`。`execute` 的确切签名实施时查 `dist/core/tools/*.d.ts`；传入外层的 `signal`，`onUpdate` 传 `undefined`。
- 所有路径参数在执行前解析并检查在 `cwd`（或 `params.paths` 限定的范围）内，越界时返回错误结果给子模型，不抛异常。
- 不提供 bash、write、edit。
- 内部工具调用不经过主会话的 `tool_call` / `tool_result` 钩子，也不进入 transcript。

`report` 工具参数：

```ts
Type.Object({
  results: Type.Array(Type.Object({
    path: Type.String(),
    startLine: Type.Number(),
    endLine: Type.Number(),
    reason: Type.String(),
  })),
  notes: Type.Optional(Type.String()),
})
```

### 6.2 系统提示（`prompt.ts`）

要点（实施时写成英文，短，不超过约 600 token）：

- 你是代码定位器，只负责找到与问题相关的代码位置，不回答问题、不写代码。
- 每轮尽量**并行**发出多个搜索（不同关键词、同义词、符号名、文件名）。
- 最多 N 轮（注入 `maxTurns`）；最后一轮必须调用 `report`。
- `report` 里的行号必须来自实际看到的 grep/read 输出；范围尽量紧（函数或类级别），按相关性排序，最多 M 条（注入 `maxResults`）。
- 找不到时调用 `report` 传空数组，在 `notes` 说明尝试过什么。
- 附上环境信息：cwd、可选的 `paths` 限定、顶层目录列表（执行一次 ls，截断到约 60 项）。顶层列表可以省掉子模型第一轮的探索。

用户消息就是 `params.query`，不把主会话的历史传给子模型。

### 6.3 循环流程

```
messages = [user(query)]
for turn in 1..maxTurns:
  toolsForTurn = turn == maxTurns ? [report] : [grep, find, ls, read, report]
  resp = await ctx.modelRegistry.complete(model,
           { systemPrompt, messages, tools: toolsForTurn },
           { signal: combinedSignal, maxTokens: 4096, reasoning/推理参数, cacheRetention: "short" 或默认, sessionId })
  usage += resp.usage
  if resp.stopReason in ("error","aborted"): 结束，进入错误处理
  messages.push(resp)
  calls = resp.content.filter(type == "toolCall")
  if calls 中有 report: 校验参数 → 结束循环
  if calls 为空: 追加一条 user 消息"请调用 report"，继续（计入轮次）
  只执行前 maxParallelCalls 个，其余返回"超出并行上限，已跳过"的错误结果
  results = await Promise.all(calls.map(runInnerTool))
  messages.push(...results 转为 ToolResultMessage{ role:"toolResult", toolCallId, toolName, content, isError, timestamp })
  onUpdate({ content: [text("turn i: N searches")], details: 当前进度 })
if 没有拿到 report: 从已执行的 grep 输出中提取命中最多的文件作为降级结果，并标记 truncated/warnings
```

细节：

- `combinedSignal`：合并工具的 `signal` 与 `timeoutMs` 超时（`AbortSignal.any([signal, AbortSignal.timeout(ms)])`）。用户按 Esc 时立即停止。
- `sessionId`：每次工具调用用 `uuidv7()` 生成一个，同一次循环内复用，便于 provider 前缀缓存。
- 推理参数：优先用 `streamSimple` 的 provider 中立 `reasoning` 选项（然后 `await stream.result()`），这样不用为每个 API 写不同参数。实施时确认 `ModelsSimpleStreamOptions` 是否支持 `tools` 与 `maxTokens`。
- `report` 参数校验：路径存在且在范围内；`1 <= startLine <= endLine`；超出文件行数的部分截到文件末尾；非法条目丢弃并记入 warnings。校验后全部无效且还有剩余轮次时，可以把错误作为 tool result 发回让子模型重交一次。

## 7. 片段生成（`snippets.ts`）

1. 按文件分组，合并重叠或相距 <= 3 行的区间。
2. 用 `node:fs/promises` 读取文件（二进制文件跳过，判断前 8KB 是否含 `\0`），取对应行并加行号前缀。
3. 单个片段超过 `maxLinesPerSnippet` 时只保留前 `maxLinesPerSnippet` 行，并标注 `… (共 K 行，用 read offset=.. limit=.. 查看)`。行范围仍然报完整范围。
4. 按子模型给的顺序累加字节数，超过 `maxOutputBytes` 后后续条目只保留 `path:start-end — reason`，不带片段，`truncated = true`。
5. 单行超长用 `truncateLine` 截断。

## 8. 渲染（`render.ts`）

- `renderCall`：`fast_context "<query 前 80 字符>"`，有 `paths` 时附上。
- `renderResult`：
  - 部分结果（`options.isPartial`）：`turn 2/4 · 7 searches · <model>`。
  - 折叠态：`N results · T turns · <model> · $cost · 1.8s`，加前 3 条 `path:start-end`。
  - 展开态：全部条目和 reason，再加每轮内部工具调用的简要列表。
- 使用 `@earendil-works/pi-tui` 的 `Text` 和 theme 颜色。参考 `truncated-tool.ts` 和 `subagent/index.ts` 的渲染方式。

## 9. 错误处理

| 情况 | 行为 |
|---|---|
| 未配置模型 / 模型不存在 / 无认证 | 返回 `isError: true`，文本说明原因和修复命令。注意这条文本要让主模型知道可以改用 grep/read 继续工作 |
| 子模型请求失败（`stopReason: "error"`） | 如果已有内部 grep 结果，返回降级结果并带 warnings；否则 `isError: true` 并附 `errorMessage` |
| 用户取消（abort） | 直接抛出或返回“Cancelled”，不再发起新请求 |
| 超时 | 同“请求失败”，并在文本中注明超时 |
| 内部工具报错 | 作为 `isError: true` 的 tool result 发回子模型，不中断循环 |
| `report` 参数非法 | 见 6.3 |

所有返回路径都带上累计的 `usage`，失败的调用也要计费统计。

## 10. 可选：引导主模型使用 fast_context

默认关闭（`nudgeBroadSearch: false`），M3 里验证效果后再决定是否默认开启。

- 监听 `tool_result`：当主模型调用 `grep` / `find`，或 `bash` 命令以 `rg` / `grep -r` / `find` 开头，并且本次 agent run 内还没调用过 `fast_context` 时，在结果 `content` 末尾追加一行提示：`Tip: fast_context can locate code with a cheaper model.`
- 每个 agent run 最多提示一次（`agent_start` 时重置计数）。
- 不阻断、不改写主模型的调用，只追加提示。修改 `content` 时要保留原有 `details`。

## 11. 测试与评测

### 11.1 单元测试（`node --test` 或 vitest，选一个）

- `config.test.ts`：默认值合并、非法值回退、未信任项目不读项目配置。
- `snippets.test.ts`：区间合并、越界行号截断、二进制文件跳过、字节预算生效。
- `loop.test.ts`：用假的 `modelRegistry`（只实现 `complete` / `streamSimple`，按脚本返回预设的 `AssistantMessage`）覆盖：
  - 正常：一轮并行 grep → report。
  - 子模型不调工具 → 被催促 → report。
  - 达到 maxTurns 仍未 report → 降级结果。
  - 并行调用超过上限。
  - 路径越界（`../`、绝对路径、符号链接指向 cwd 外）。
  - abort 和超时。
  - usage 累加。

### 11.2 端到端评测（`eval/`，不进 CI）

目的是回答“到底省了多少钱”。

- 准备 10–20 个真实任务（定位类和小改动类各半），每个任务写明期望命中的文件。
- 用 `pi --mode json -p --no-session` 跑三组：
  1. 不加载本扩展（基线）。
  2. 不加载本扩展，但在 prompt 中要求用 Explore/subagent 定位（对照）。
  3. 加载本扩展。
- 从 JSON 事件中统计：主模型 input/output/cacheRead token、子模型 usage（来自工具结果）、总费用、耗时、期望文件命中率、主模型在 fast_context 之后又调用 grep/find 的次数（衡量“主模型是否信任结果”）。
- 输出一张 Markdown 表格。

## 12. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| M1 | 项目骨架、config、`/fastcontext-model`、状态栏 | `pi -e ./src/index.ts` 可以选择并保存模型，重启后仍生效 |
| M2 | `fast_context` 工具、循环、片段、格式化、错误处理、单元测试 | 在本仓库和一个中型仓库上手动调用能返回正确行范围；测试全部通过；footer 能看到子模型费用 |
| M3 | 渲染、可选的引导（第 10 节）、README | TUI 中折叠/展开显示正常；print/json 模式下不报错 |
| M4 | 评测脚本和报告 | 产出三组对比表格，据此决定默认参数（maxTurns、maxParallelCalls、nudge） |

## 13. 验收标准

- 只读：扩展不写任何文件，配置文件除外。子模型无法访问 cwd（或 `paths`）以外的路径。
- 不在扩展工厂函数里启动后台资源；不需要 `session_shutdown` 清理（如果后续加了缓存则需要）。
- 返回给主模型的文本不超过 `maxOutputBytes`。
- 子模型用量通过 `usage` 计入会话统计。
- Esc 取消能在 1 秒内停止子模型请求。
- TypeScript 无类型错误（`tsc --noEmit`）。

## 14. 实施时需要确认的问题

以下是文档和类型定义里没有完全确认的点，实施 agent 要先查 `dist/**/*.d.ts` 再动手：

1. `create*ToolDefinition(cwd)` 返回对象上 `execute` 的参数顺序，以及是否需要 `ctx`。如果必须传 `ctx`，就把外层工具的 `ctx` 传进去。
2. `ModelsSimpleStreamOptions` / `ModelsApiStreamOptions` 中推理强度和 `maxTokens` 的字段名。
3. `Model` 类型上是否有“支持工具调用”和 `cost` 字段，用于选择器展示和校验。
4. 传给 `complete` 的 `messages` 里是否可以直接放入上一轮返回的 `AssistantMessage`（含 `toolCall`），还是需要去掉 `thinking` 块。先用 Anthropic 和一个 OpenAI 兼容 provider 各跑一次。
5. 子模型一次响应中同时调用 `report` 和其他工具时，是否要求每个 toolCall 都有对应的 toolResult。简单做法：直接结束循环，不再请求模型，所以不存在这个问题。

## 15. 后续版本（本次不做）

- 符号索引（ctags / tree-sitter）作为子模型的额外工具。
- 会话内缓存：相同 query 在同一 git HEAD 下直接返回。
- embedding 召回。
- 允许子模型只读地执行 `git log -S` / `git grep` 等命令。
