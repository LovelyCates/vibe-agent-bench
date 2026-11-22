# Vibe Coding Agent 评测台

用本机 OpenCode、DeepSeek Harness（DSH）和 Codex CLI 运行代码评测。在同一个 Web 工作区新建和审核项目用例、运行内置评测、查看历史记录。项目用例提供 Java + Vue 运维任务看板和固定版本的 Superpowers、OpenSpec、Java 与 Vue Skill。首次使用可从演示开始。 [平台使用教程](平台使用教程.md) · [Java + Vue 人工复测](人工复测.md) · [MVP 验收表](MVP.md)

## 运行

需要 Node.js 24 和供 Playwright 调用的 Chromium。`npm ci` 会尝试安装项目锁定的 OpenCode 1.19.6 与 DeepSeek Harness 0.2.2-rc.5。DSH 需要 Node.js 24.9 或更高版本。选择 Codex 时需要使用 ChatGPT 账号登录的 Codex CLI。浏览器可使用已安装的 Microsoft Edge 或 Google Chrome。缺少浏览器时运行 `npx playwright install chromium`。 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

```powershell
npm ci
npm exec --offline -- opencode --version
npm exec --offline -- dsh --version
npm start
```

默认模型为 `gpt-6-luna`，推理强度为 `medium`。选择 Codex 时实现轮使用本机 CLI 登录，Windows 上使用 MXC 工作区沙箱。OpenCode、DSH 和只读审阅读取本节的服务配置。可以用 `VIBE_BENCH_CODEX_BIN`、`VIBE_BENCH_OPENCODE_BIN` 或 `VIBE_BENCH_DSH_BIN` 指定相应 CLI。 [本地评测台](http://127.0.0.1:4317)

默认 OpenAI 配置优先使用 `VIBE_BENCH_API_KEY`，也支持 `VIBE_BENCH_OPENAI_API_KEY` 和本机密钥文件。macOS 文件位置为 `~/Library/Application Support/VibeAgentBench/openai-api-key`，Windows 为 `%LOCALAPPDATA%\VibeAgentBench\openai-api-key`。默认 OpenAI 审阅在缺少项目密钥时使用本机 Codex CLI 登录。

在 GitHub Codespaces 开发时，可在仓库的 **Settings → Secrets and variables → Codespaces** 添加同名 Secret。新建或重启 Codespace 后，它会成为开发环境变量。 [GitHub Codespaces Secret 文档](https://docs.github.com/en/codespaces/managing-codespaces-for-your-organization/managing-development-environment-secrets-for-your-repository-or-organization)

第一次打开「工作台」，可以直接「试跑示例（无需密钥）」或「新建用例」。报告先显示结果和原因，展开「查看运行详情」再看时间线、代码差异和截图。「示例与对照」提供固定样例和对照设置，「运行记录」汇总历次结果。 [工作台](http://127.0.0.1:4317/) · [示例与对照](http://127.0.0.1:4317/?view=benchmark) · [运行记录](http://127.0.0.1:4317/?view=history)

试跑示例使用固定参考实现验证代码规范、服务启动、API、页面联调和测试辨别力，无需模型凭据。每轮报告、代码差异、日志与截图保存在 `runs/<运行 ID>/`。实现和 AI 建议各附一份配置，记录模型、推理强度、提供方和认证方式。示例报告的「发起复测」会从同一份初始样例重新开始。

## DeepSeek 与内网模型

在页面顶部打开「模型配置」，选择 DeepSeek 或内网服务，填写 API 基础地址、模型 ID 和密钥。点「测试连接」用当前表单发出一条实际模型请求，再点「保存并启用」。两套配置分别保存，以后可以直接切换，新发起的评测会使用切换后的配置。连接测试验证模型能否回复，Agent 的流式返回和工具调用由实际评测验证。

密钥输入框留空时，同一站点沿用原密钥。网页录入的密钥保存在本机用户配置文件里，服务重启后仍可使用。Windows 下的文件是 `%LOCALAPPDATA%\VibeAgentBench\credentials-vibe-bench-models.json`，位于 Git 仓库之外。界面只显示是否配置了密钥。

需要为部署指定启动默认值时，可用 `.env.example` 创建 `.env`。页面的「恢复启动配置」会重新启用这些默认值，已保存的两套配置也会保留。

| 配置项 | DeepSeek 官方 | 内网兼容服务 |
| --- | --- | --- |
| `VIBE_BENCH_PROVIDER` | `deepseek` | `compatible` |
| `VIBE_BENCH_BASE_URL` | `https://api.deepseek.com`，省略可使用默认值 | 管理员提供的接口根地址，例如 `http://model.intra:8000/v1` |
| `VIBE_BENCH_MODEL` | 例如 `deepseek-flash` | 服务登记的精确模型 ID |
| `VIBE_BENCH_API_KEY` | DeepSeek 密钥，也可用 `DEEPSEEK_API_KEY` | 内网服务的密钥 |
| `VIBE_BENCH_ALLOW_NO_API_KEY` | 留空 | 仅在内网服务允许无认证时设为 `true` |

两种配置均使用 Chat Completions。要在 OpenCode 或 DSH 中跑实现，模型接口需支持流式返回和工具调用。对照组中的 Codex 使用本机 Codex CLI 登录认证。只有 DeepSeek 或内网账号时，可选择 OpenCode 或 DSH 跑单次和自建用例。DSH 在免密模式下会发送固定占位认证头，目标服务需接受它。 [配置样例](.env.example) · [DeepSeek 官方 API](https://api-docs.deepseek.com/)

## 项目用例

1. 打开工作台，点「新建用例」，填写本机项目目录和要发给 Agent 的任务。再选「想检查什么」。官方样例可从可选设置选用。 [用例工作台](http://127.0.0.1:4317)
2. 生成用例后先看摘要里的输入、预期和通过条件。需要调整时展开「编辑用例」，可以修改输入、独立验收命令和 Skill 判定条件，也可以查阅项目文件。目录扫描会识别 Node.js、Go 和 Rust 的常见验证命令。内置样例使用固定的六项业务验收。
3. 点「确认用例」后，再点「运行用例」。需要切换普通项目用例的 Agent 时，在「编辑用例 → 输入与预期」选择。Agent 和验收命令都在所选目录的临时副本中运行，每次启动会保存起始文件的摘要。

「自己写一条」可以选检查 Skill 是否触发、保持文件原样、等确认后才实现、遵循项目规范或普通项目验收。确认前可展开编辑修改输入和通过条件。指定 Skill 的用例会读取项目配置后让你选一个 Skill。平台在确认时记录项目配置和文件摘要，相关内容变化后需要重新确认。

原生用例从隔离副本中执行。只分析用例可以预期没有写入。审批门禁可只观察提案，或在审核时配置提案检查和后续确认，再由评测台在同一个原生会话里发出确认。代码规范报告同时记录 Skill 和文档读取、文件差异和独立命令结果。模型审阅可基于这些证据补充复测建议。

在「新建用例」选择「按项目 Skill 生成多条」，填目录后点「生成多条测试用例」。每条显示消息、预期 Skill 和通过条件。确认后可「运行这条」或「运行待测的 N 条」。再次运行已有记录的条目时，点它的「再跑一次」。暂时不能运行的用例和补齐办法收在清单下方。

已有用例组可以点「补充测试场景」，用一句话说明还想测什么，工作台会用当前配置的模型读取相关 Skill、项目规则和文件清单，生成新的待审核草稿。暂时不能运行的用例点「怎么补」可看项目侧和平台侧各缺什么，点「AI 帮我补」可使用预填的任务生成草稿或记录补齐步骤。可审核的测试数据以小型 JSON、Markdown 或文本文件呈现，运行时复制到隔离副本的 `.vibe-bench-fixtures/`。原生子会话数量可以独立核验，启动自动加载和结果内容等条件需要对应的检查。
4. 报告顶部可定位关键证据、运行流程、验收检查、事件时间线和审阅。时间轴显示五个阶段的起点和耗时，点击阶段可筛选事件。「关键证据」集中展示 Skill 读取、代码差异和独立验收，并可定位实际记录。运行历史与事件序列保存在磁盘。

## 内置评测

「示例与对照 → TestTarget 项目对照」从同一份项目快照发起四轮原生 OpenCode 1.19.6 评测。订单详情页对比完整配置和仅屏蔽 `frontend-implementation`，另外两轮检查未确认时停在提案和外部验收失败时的汇报。启用页面中的 DeepSeek 配置后点击「运行四轮」。四轮沿用同一份启动时模型配置。

平台在临时副本中读取项目配置、Superpowers 插件和 Skill。订单详情页通过提案的独立门禁后，由评测脚本在同一会话发送确认。未确认用例在首轮加入「顺手直接实现」的指令，检查 Agent 是否在收到提案确认前改动源码。审查子 Agent 在评测中以只读方式运行。单轮报告包含审批、原生 Skill 正文、会话及独立验收。若要更换项目根目录，可设置启动环境变量 `VIBE_BENCH_TESTTARGET_DIR`。

内置示例为「后台任务列表增加状态筛选」。在「示例与对照」可直接试跑示例。展开「进阶对照」后，可选择 Agent 和 Skill 跑单次或四组对照。

四组对照让 Codex 和 OpenCode 各运行一次有目标 Skill 和一次无目标 Skill。每组使用独立工作区，收到完全相同且不点名 Skill 的任务提示词。两条 Agent 队列并行，同一 Agent 的两种条件串行且两条队列顺序相反。对照区按实际顺序显示各轮状态和进度，点击组名可在当前工作区打开该轮的运行流程。每次报告记录原始提示词、提示词摘要、起始样例摘要，以及目标 Skill 是否存在。四组各执行一次，结果反映本次观察。对照表显示自动选用、已验证读取和六项业务验收。 [Coder Eval 的 OpenCode 接法](https://github.com/UiPath/coder_eval/blob/main/docs/agents/OPENCODE.md) · [BenchFlow 的 Skill 对照](https://www.benchflow.ai/docs/benchflow/evaluate/skills)

## Java + Vue 场景及主题素材

- 运维任务看板需要 Node.js 24、JDK 17 或更新版本和可用的 Edge 或 Chrome。审核通过后，内置准备命令会在候选副本中装好该场景的锁定依赖，包括 OpenSpec CLI。 [项目说明](scenarios/java-vue-task-board/README.md)
- Skill 包随项目存放。`node scripts/fetch-skill-packs.mjs` 可重新拉取固定上游版本。每次按审核锁定的版本提供项目级 Skill，核对原生清单，再用原生调用返回中的当轮随机标记验证正文读取。 [清单与上游链接](skill-packs/catalog.json)
- 工作台沿用「灵伴研习社」的爱弥斯静态贴纸和主题色。贴纸为个人同人素材，源文件为 `agent-signal/dist/assets/aemeath-workflow.webp`。

## 判定

- Codex 以成功读取目标文件的事件推断选用，OpenCode 以成功的原生 Skill 调用记录选用。两个 Agent 的正文读取都要求目标文件读取或目标 Skill 调用返回仅存在于本轮正文的标记。OpenCode 直接读取文件时也能确认正文读取。报告保留原生事件和文件摘要。无 Skill 组以文件缺席且运行中未观察到目标选用为正常对照。
- 业务验收包括代码规范、后端启动、前端启动、API、页面联调和测试辨别力。代码规范检查由评测台自己的 ESLint 规则和文件变更范围决定。
- API 和页面由评测台独立启动并验证。页面检查使用 Playwright，保留实际请求、响应、任务行和截图。
- 评测台先运行 Agent 提交的测试，再构造缺陷副本，独立确认 `completed` 错误混入待处理任务后重跑同一批测试。健康版本通过且缺陷版本出现对应断言失败，测试辨别力才通过。
- 只读审阅轮次接收当轮检查的状态、摘要与证据 ID。评测台验证建议所引用的 ID，各项判定直接来自评测器。
