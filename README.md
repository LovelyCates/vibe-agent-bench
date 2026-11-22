# Vibe Coding Agent 评测台

用本机 Codex CLI 和 OpenCode 1.19.6 运行代码评测。单用例台提供 Java + Vue 运维任务看板和固定版本的 Superpowers、OpenSpec、Java 与 Vue Skill。原内置样例验收项见 [MVP 验收表](MVP.md)。现场操作见 [人工复测教程](人工复测.md)。

## 运行

需要 Node.js 24、使用 ChatGPT 账号登录的 Codex CLI，以及供 Playwright 调用的 Chromium。`npm ci` 会安装项目锁定的 OpenCode 1.19.6。也可以使用已安装的 Microsoft Edge 或 Google Chrome。在没有可用浏览器的环境里运行 `npx playwright install chromium`。

```powershell
npm ci
codex login status
npm exec --offline -- opencode --version
npm start
```

代码实现和只读审阅均使用 `gpt-6-luna`，推理强度为 `medium`。Codex 实现轮使用本机 CLI 登录，Windows 上使用 MXC 工作区沙箱。OpenCode 通过官方 OpenAI 接口认证。可以在启动评测台前用 `VIBE_BENCH_CODEX_BIN` 或 `VIBE_BENCH_OPENCODE_BIN` 指定可执行文件路径。[本地评测台](http://127.0.0.1:4317) · [Windows 沙箱文档](https://learn.chatgpt.com/docs/windows/windows-sandbox)

OpenCode 和审阅轮优先读取启动环境中的 `VIBE_BENCH_OPENAI_API_KEY`。也可以将密钥保存到本机文件，macOS 使用 `~/Library/Application Support/VibeAgentBench/openai-api-key`，Windows 使用 `%LOCALAPPDATA%\VibeAgentBench\openai-api-key`。缺少项目密钥时，审阅轮使用本机 Codex CLI 登录。API 请求失败会显示在对应结果中。

在 GitHub Codespaces 开发时，可在仓库的 **Settings → Secrets and variables → Codespaces** 添加同名 Secret。新建或重启 Codespace 后，它会成为开发环境变量。 [GitHub Codespaces Secret 文档](https://docs.github.com/en/codespaces/managing-codespaces-for-your-organization/managing-development-environment-secrets-for-your-repository-or-organization)

「运行演示」使用固定参考实现验证代码规范、服务启动、API、页面联调和测试辨别力，无需模型凭据。每轮运行的报告、代码差异、日志与截图保存在 `runs/<运行 ID>/`。实现和审阅各附一份配置，记录请求的模型、推理强度、提供方和认证方式。API 审阅另附响应状态及返回的模型信息。点击证据可预览，点击「发起复测」会从同一份初始样例重新开始。

## 单用例工作台

1. 打开 [本地评测台](http://127.0.0.1:4317)，填写 OpenCode 要处理的本机项目目录绝对路径和实际需求。默认项目是后台任务样例。
2. 生成用例后可检查项目文件、编辑任务提示词、设置独立验收命令，再审核通过。目录扫描会识别 Node.js、Go 和 Rust 的常见验证命令；其他项目可以填写已有命令。内置样例使用固定的六项业务验收。
3. 启动评测执行当前审核版本。OpenCode 在所选目录的临时副本中修改代码，验收命令从这个副本运行。启动前请检查命令及所选项目中的脚本。每次启动按当时的目录内容建立项目快照。
4. 运行流程用同一时间轴显示五个阶段的起点和耗时，并实时更新最新事件及检查进度。OpenCode 实现轮的执行上限为 10 分钟。点击阶段可筛选时间线，也可搜索事件正文、详情和证据文件名。「规范与产出」把规范读取、编辑事件、代码差异和独立验收放在一起，并可定位实际记录。运行历史与事件序列保存在磁盘。 [Skill 对照](http://127.0.0.1:4317/benchmark)

## 四组对照

两个 Agent 各运行一次有目标 Skill 和一次无目标 Skill。每组使用独立工作区，收到完全相同且不点名 Skill 的任务提示词。两条 Agent 队列并行，同一 Agent 的两种条件串行且两条队列顺序相反。对照页按实际执行顺序显示各轮状态和进度，点击组名可打开该轮的运行流程。每次报告记录原始提示词、提示词摘要、起始样例摘要，以及目标 Skill 是否存在。四组各执行一次，结果反映本次观察。对照表显示自动选用、已验证读取和六项业务验收。[Coder Eval 的 OpenCode 接法](https://github.com/UiPath/coder_eval/blob/main/docs/agents/OPENCODE.md) · [BenchFlow 的 Skill 对照](https://www.benchflow.ai/docs/benchflow/evaluate/skills)

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
