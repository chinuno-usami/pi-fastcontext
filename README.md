# pi-fastcontext

Pi 扩展：用低成本子模型在进程内跑受限只读搜索循环，向主模型返回精确的 `path:start-end` 列表与短片段，避免主上下文被反复 grep/find/read 撑大。

范围：实现 PLAN.md 的 **M1–M3**（不做 M4 评测与第 15 节后续功能）。

## 安装

本仓库为本地扩展源码。任选其一：

1. **软链到 agent extensions 目录**

   ```bash
   ln -s "$(pwd)" ~/.pi/agent/extensions/pi-fastcontext
   ```

2. **在 settings 的 `extensions` 中加入本仓库路径**（指向含 `package.json` 的目录，或 `./src/index.ts`）。

本地调试（不安装）：

```bash
pi -e ./src/index.ts
```

依赖：宿主需已安装 `@earendil-works/pi-coding-agent` / `pi-ai` / `pi-tui`（本扩展以 peerDependencies 声明）。开发时：

```bash
npm install --cache .pi/npm-cache
npm run check
npm test
```

## 选择子模型：`/fastcontext-model`

子模型必须从 **pi 自身模型列表**（`ctx.modelRegistry.getAvailable()`）中选择，复用已配置的 provider 与认证。

| 方式 | 说明 |
|------|------|
| `/fastcontext-model` | 交互选择 `provider/modelId`（TUI 支持关键字/模糊搜索过滤；无 UI 时仅接受参数形式） |
| `/fastcontext-model provider/id` | 直接设置并写入全局配置 |
| `/fastcontext-model --project …` | 写入项目配置（需项目已信任） |
| `/fastcontext-model clear` | 清除对应范围的 `model` |
| `--fastcontext-model provider/id` | 会话 flag，优先于配置文件 |

解析顺序：`--fastcontext-model` → 受信任项目配置 `model` → 全局配置 `model`。

状态栏：`session_start` / 模型选择变更后显示 `fc: provider/id`，未配置时为 `fc: (未设置)`。

未配置模型时，`fast_context` 返回 `isError: true`，提示运行 `/fastcontext-model`（不静默回退主模型）。

## 配置项与默认值

- 全局：`join(getAgentDir(), "fastcontext.json")`
- 项目：`join(cwd, CONFIG_DIR_NAME, "fastcontext.json")`（仅当项目受信任时读取；项目覆盖全局）
- 非法值回退默认值，并通过 UI notify 警告一次

| 字段 | 默认 | 说明 |
|------|------|------|
| `model` | （无） | `"provider/modelId"` |
| `reasoning` | `"low"` | `"off" \| "minimal" \| "low" \| "medium" \| "high"`；模型不支持推理时忽略 |
| `maxTurns` | `4` | 子模型搜索最大轮数 |
| `maxParallelCalls` | `8` | 每轮最多执行的工具调用数 |
| `maxResults` | `12` | `report` 最多条目 |
| `maxOutputBytes` | `12000` | 返回主模型的总字节预算 |
| `maxLinesPerSnippet` | `40` | 单片段最大行数 |
| `innerToolMaxBytes` | `16000` | 子模型单次工具输出上限 |
| `timeoutMs` | `90000` | 整个 `fast_context` 调用超时 |
| `nudgeBroadSearch` | `false` | 主模型直接用 grep/find 时是否附加引导提示 |

## 实现说明

以下结论来自本仓库锁定的 `@earendil-works/pi-coding-agent@1.5.2` / `@earendil-works/pi-ai@1.5.2` 的 `dist/**/*.d.ts`，并对照 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` 与 `examples/extensions/`（如 `custom-compaction.ts`）。**代码按此实现，不以猜测调用 API。**

### PLAN.md §14 五个问题

1. **`create*ToolDefinition(cwd).execute` 签名与 `ctx`**
   - `ToolDefinition.execute` 为：`(toolCallId, params, signal, onUpdate, ctx) => Promise<AgentToolResult>`，第 5 参 `ctx: ExtensionToolContext` 在类型上必填。
   - 内置实现（如 `read.js`）使用 `ctx?.cwd || cwd`，因此运行时可用最小 `{ cwd }` 或传入外层工具的 `ctx`；`onUpdate` 可传 `undefined`；`signal` 传入外层/合并后的 `AbortSignal`。
   - 子循环**不**走 `ctx.executeTool`（避免主会话钩子与激活工具限制）；自行调用 definition 的 `execute`。

2. **推理强度与 `maxTokens` 字段名**
   - `ModelsSimpleStreamOptions` = `SimpleStreamOptions & ModelsRequestTransforms`。
   - 提供商中立字段：`reasoning?: ThinkingLevel`（`"minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`，**不含** `"off"`）、`maxTokens?: number`、`signal?: AbortSignal`。
   - `tools` 在 `Context` 上（`Context.tools?: Tool[]`），不在 stream options 里。
   - 配置 `reasoning: "off"` 或 `model.reasoning === false` 时：**省略** `reasoning` 字段，不要传字符串 `"off"`。
   - 调用面：扩展侧 `ModelRegistry` 有 `streamSimple` / `complete`，**无** `completeSimple`（`pi-ai` 的 `Models` 才有 `completeSimple`）。本扩展采用 `streamSimple` + `await stream.result()`。

3. **`Model` 是否有“支持工具调用”与 `cost`**
   - 有 `cost: ModelCost` 与 `reasoning: boolean`，可用于选择器展示。
   - **无** `supportsTools`（或同类字段）→ **跳过**工具能力字段校验（相对 PLAN 的偏差，见下）。

4. **能否把上一轮 `AssistantMessage`（含 `toolCall` / thinking）原样放回 `messages`**
   - `Context.messages: Message[]`，`Message` 含完整 `AssistantMessage`（`content` 可为 `text` / `thinking` / `toolCall`）。
   - 采用 **原样 push 回灌**；未对真实 Anthropic / OpenAI 兼容 provider 做联调（单元测试用假 `modelRegistry`，禁止网络）。若后续真实联调发现问题，再在 README 记偏差并收紧（例如剥离 thinking）。

5. **同轮同时调用 `report` 与其他工具时是否要补全 toolResult**
   - 采用 PLAN 建议的简单做法：同轮只要见到 `report` 即**结束循环**，不补其他 toolCall 的 toolResult，也不再请求模型。

### 与 PLAN 的偏差

| 项 | PLAN 倾向 | 本实现 |
|----|-----------|--------|
| D1 工具能力校验 | 按模型能力过滤 | `Model` 无 `supportsTools`，跳过该校验 |
| 子模型 API | §2 写 `complete`；§6.3 推荐 `streamSimple` | 统一 `modelRegistry.streamSimple` + `result()` |
| Context.tools | — | 只传 `name` / `description` / `parameters`；自行 `execute` + 路径狱 |

### 未完成 / 未验证事项

- 真实模型下的搜索质量与成本节省效果（需手动 / 评测；M4 不做）。
- Esc 取消后 **1 秒内停止**（需 TUI 手动验证）。
- 真实 provider 下 AssistantMessage（含 thinking）多轮回灌是否被所有后端接受（见 §14.4）。
- `nudgeBroadSearch` 默认关闭；开启后的主模型引导效果未做真实会话验证（单元测试覆盖 tip 追加与 broad-search 判定）。
- TUI 中折叠/展开显示需用 `pi -e ./src/index.ts` 手动确认；print/json 路径由 render 单测用假 Theme 覆盖不抛错。

## 开发状态

- 已完成：工程骨架、config、`/fastcontext-model` / `--fastcontext-model` / 状态栏（M1）、§14 核实、`inner-tools`、`prompt`、`loop`、`snippets`、`format`、注册 `fast_context`（M2）、`renderCall` / `renderResult` 与 `nudgeBroadSearch` 钩子（M3，默认关闭）。
- 单元测试：`test/fast-context.test.ts` 用假 `modelRegistry` 覆盖工具入口端到端（成功路径、unset/not_found/no_auth、paths 越狱、`maxResults` 裁剪、sameAsMain 警告、abort、onUpdate details 形状）；§11.1 所列 config/snippets/loop 场景已有对应测试（含超时：无 grep → `error`；有 grep → 降级并注明超时）。§13 中 Esc≤1s、真实模型效果等仍需手动验证（见上「未完成 / 未验证事项」）。
- `npm run check` / `npm test` 当前应全绿。
