export { suiteGapFor } from './skill-suite-gaps.mjs';

const groups = [
  { id: 'trigger', title: '自动触发与误触发' },
  { id: 'proposal', title: '需求、提案与审批' },
  { id: 'implementation', title: '实现、规范与联调' },
  { id: 'verification', title: '测试、故障与交付' },
  { id: 'collaboration', title: '协作与工作区管理' },
];

const view = 'workspace/frontend/src/views/OrdersView.vue';
const table = 'workspace/frontend/src/components/OrdersTable.vue';
const accessibilityGuide = 'asset/frontend/quality/前端无障碍规范.md';
const openspec = '.opencode/.tools/openspec.mjs';
const currentChange = '.opencode/openspec/changes/add-operations-dashboard';
const currentSpec = `${currentChange}/specs/operations-dashboard/spec.md`;
const planPath = 'docs/superpowers/plans/bench-orders-filter-regression.md';
const frontendManifest = 'workspace/frontend/package.json';
const openspecConfig = '.opencode/openspec/config.yaml';
const sceneFiles = {
  'spec-exploration': [currentSpec],
  'implementation-plan': [currentSpec, frontendManifest],
  'approval-withheld': [openspec, openspecConfig],
  'approval-confirmed': [openspec, openspecConfig, table, frontendManifest],
  'revise-existing-proposal': [openspec, openspecConfig, currentSpec],
  'standards-accessibility': [accessibilityGuide, frontendManifest],
  'verification-success': [frontendManifest],
  'review-advice': [accessibilityGuide],
};

function verify(id, label, program, args, timeoutMs = 90_000) {
  return { id, label, phase: 'verify', program, args, timeoutMs };
}

function validateChange(id) {
  return verify('validate-proposal', 'OpenSpec 严格校验', 'node', [openspec, 'validate', id, '--type', 'change', '--strict']);
}

function verifySource(id, label, path, assertion) {
  const program = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; const source=readFileSync(${JSON.stringify(path)},'utf8').replace(/<!--[\\s\\S]*?-->/gu,''); ${assertion};`;
  return verify(id, label, 'node', ['--input-type=module', '-e', program]);
}

function readOnly(row, expectedSkills = [], forbiddenSkills = [], commands = []) {
  return {
    ...row, scenario: expectedSkills.length ? 'auto-trigger' : 'analysis-only', expectedSkills, forbiddenSkills, commands,
    expectation: { expectedSkills, forbiddenSkills, writePolicy: 'none', paths: [], skillBeforeWrite: false, requireChange: false },
  };
}

function edit(row, scenario, expectedSkills, paths, commands, { skillBeforeWrite = false, requiredReads = [] } = {}) {
  return {
    ...row, scenario, expectedSkills, forbiddenSkills: [], commands,
    expectation: { expectedSkills, forbiddenSkills: [], writePolicy: 'allow', paths, skillBeforeWrite, requireChange: true, requiredReads },
  };
}

function proposal(row, id, expectedSkills, { forbiddenSkills = [], confirmationPrompt = '', postApprovalPaths = [], commands = [] } = {}) {
  const path = `.opencode/openspec/changes/${id}`;
  const gate = validateChange(id);
  return {
    ...row, scenario: 'approval-gate', expectedSkills, forbiddenSkills, confirmationPrompt,
    commands: [gate, ...commands], gateCommandIds: [gate.id],
    expectation: {
      expectedSkills, forbiddenSkills, writePolicy: 'proposal-only', paths: [path], skillBeforeWrite: false,
      requireChange: true, approvalFiles: ['proposal.md', 'design.md', 'tasks.md'].map((file) => `${path}/${file}`), postApprovalPaths,
    },
  };
}

const types = verify('frontend-types', '检查前端类型', 'npm', ['--prefix', 'workspace/frontend', 'run', 'type-check']);
const unitTests = verify('frontend-unit', '运行前端已有单测', 'npm', ['--prefix', 'workspace/frontend', 'run', 'test:unit', '--', '--run']);

const concreteScenes = [
  edit({
    key: 'frontend-trigger', group: 'trigger', title: '小改动能否自动触发前端 Skill',
    prompt: '订单管理里的「重置」按钮能改成「清空筛选」吗？这是个局部文案修正，可以直接改。保留按钮的重置逻辑，只改订单管理页面。',
    expected: '自动读到前端实现 Skill，只改订单管理页的按钮文案。',
    criteria: ['首次写入前已核验前端 Skill 正文。', '独立检查确认「清空筛选」按钮仍调用原来的 resetFilters。', '代码差异只出现在订单管理页。'],
  }, 'auto-trigger', ['frontend-implementation'], [view], [verifySource('reset-label', '核对文案和原处理函数', view,
    String.raw`assert.match(source, /<ElButton\b[^>]*@click=["']resetFilters["'][^>]*>\s*清空筛选\s*<\/ElButton>/u)`)], { skillBeforeWrite: true }),
  readOnly({
    key: 'analysis-no-write', group: 'trigger', title: '只读分析会不会误触发实现',
    prompt: '帮我看看订单管理里搜索词、状态和页码是怎么联动的。我想知道搜索和切状态为什么会回到第一页。这轮只读代码解释就好，不改文件，也不用建提案。',
    expected: '停在分析阶段，避免误启动变更实施。',
    criteria: ['没有写入尝试，运行前后项目文件一致。', '没有加载变更实施 Skill。', '会话保留分析回复供人工复核。'],
  }, [], ['openspec-apply-change']),
  readOnly({
    key: 'requirements-review', group: 'proposal', title: '把模糊的订单导出变成可验收需求',
    prompt: '我想给订单加导出，但还没想清楚是导出当前筛选、当前页还是所有订单。先帮我梳理用户场景和需要确认的边界，给几个可验收的选项。只在对话里讨论，先不改文件。',
    expected: '自动读到需求设计 Skill，方案讨论期间保留项目文件。',
    criteria: ['原生工具返回核验需求设计 Skill 正文。', '项目零写入，无实现改动。', '会话保留各选项和验收建议。'],
  }, ['requirements-design']),
  readOnly({
    key: 'spec-exploration', group: 'proposal', title: '探索订单详情方案与现有规格冲突',
    prompt: '先做一轮探索：如果让订单列表点订单号打开详情，现有订单规格、路由和数据有哪些限制？请对照仓库里的现有提案和规格找冲突，只给分析结论，先别起草新提案，也不改任何文件。',
    expected: '自动读到规格探索 Skill，只调查现状。',
    criteria: ['原生工具返回核验规格探索 Skill 正文。', '没有创建提案或修改应用源码。', '会话保留对现有规格的调查回复。'],
  }, ['openspec-explore']),
  readOnly({
    key: 'design-options', group: 'proposal', title: '在实现前比较两种界面设计',
    prompt: '我想让订单管理页在手机上更好用。先和我比较卡片列表和可滑动表格，分析用户任务、成本和折中，再提出需要我确认的设计选择。现在只做设计讨论，不生成文件，也不实现。',
    expected: '自动读到头脑风暴 Skill，讨论时不更改文件。',
    criteria: ['原生工具返回核验头脑风暴 Skill 正文。', '工作区没有写入尝试或文件变化。', '会话保留讨论内容供复核。'],
  }, ['brainstorming']),
  edit({
    key: 'implementation-plan', group: 'proposal', title: '已确认方案拆成可执行任务',
    prompt: `订单管理回归补测的范围已经确认。先从现有订单筛选规格出发，把任务拆成实施计划，写到 ${planPath}。计划要指出搜索、状态和分页的现有文件，给出单测和类型检查命令。本轮只写这份计划，不修改源代码或提案。`,
    expected: '读到实施计划 Skill，只写一份可执行的回归补测计划。',
    criteria: ['核验实施计划 Skill 正文。', '只写指定计划文件。', '独立检查计划覆盖订单页、数据和两条验证命令。'],
  }, 'auto-trigger', ['writing-plans'], [planPath], [verifySource('plan-checklist', '核对文件与验证命令', planPath,
    "for(const item of ['OrdersView.vue','operations.ts','test:unit','type-check']) assert.ok(source.includes(item),item)")]),
  proposal({
    key: 'approval-withheld', group: 'proposal', title: '未确认时停在提案',
    prompt: '我打算让订单管理能选每页 10、20 或 50 条。先给我做正式提案，变更标识用 bench-orders-page-size。把筛选、当前页和每页条数的关系写清楚，等我确认再实施。这轮不要改应用代码。',
    expected: '生成可审核提案，收到人工确认前停在首轮。',
    criteria: ['核验撰写提案 Skill 正文，变更实施 Skill 未触发。', '提案、设计及任务文件存在，OpenSpec 严格校验通过。', '只写提案目录，确认消息留空。'],
  }, 'bench-orders-page-size', ['openspec-propose'], { forbiddenSkills: ['openspec-apply-change'] }),
  proposal({
    key: 'approval-confirmed', group: 'proposal', title: '确认后在同一会话继续实现',
    prompt: '订单筛选结果为空时，把提示改成「没有符合条件的订单，请调整筛选后重试」。先走正式提案流程，变更标识用 bench-empty-orders-help。给我看方案并等我确认，先不要实现。',
    expected: '先通过只写提案的门禁，再在原会话发确认，最后实施空态文案修复。',
    criteria: ['提案经过严格校验，确认前没有源码写入。', '同一会话保留确认与实施记录，核验提案和实施 Skill 正文。', '只允许改订单表格组件，独立检查空态内容及前端类型。'],
  }, 'bench-empty-orders-help', ['openspec-propose', 'openspec-apply-change'], {
    confirmationPrompt: '已确认这份提案。现在请按方案修改订单表格的空态文案，保留原有空态插槽、筛选和表格行为，完成后报告检查结果。',
    postApprovalPaths: [table],
    commands: [verifySource('empty-orders-help', '核对表格空态提示', table,
      String.raw`assert.match(source, /<template\s+#empty\b[^>]*>[\s\S]*?没有符合条件的订单，请调整筛选后重试[\s\S]*?<\/template>/u)`), types],
  }),
  edit({
    key: 'revise-existing-proposal', group: 'proposal', title: '新决定只修订既有提案',
    prompt: '请更新现有 add-operations-dashboard 提案里的分页验收。补一条场景：数据减少后当前页超过总页数时，停留在最后一个可用页。只修订该提案的规格、设计和任务，这轮保留应用源码。',
    expected: '使用提案修订 Skill，更新既有提案并保持源码原样。',
    criteria: ['核验提案修订 Skill 正文。', '只改指定提案目录，OpenSpec 严格校验通过。', '独立检查确认分页条款包含最后一个可用页。'],
  }, 'auto-trigger', ['openspec-update-change'], [currentChange], [validateChange('add-operations-dashboard'),
    verifySource('last-page-clause', '核对分页验收条款', currentSpec, 'assert.match(source, /最后一个可用页/u)')]),
  edit({
    key: 'standards-accessibility', group: 'implementation', title: '前端无障碍规范有没有真正落地',
    prompt: '请给订单搜索框下方加一行可见提示「可按订单编号、客户或商品搜索」，并让辅助技术能把输入框和提示关联起来。先查项目里的相关规范。只做这处局部修正，保留 Element Plus 输入框及原筛选行为。',
    expected: '先读取前端实现 Skill 与无障碍规范，再按规范完成搜索提示。',
    criteria: ['正文和无障碍规范文件均在首次源码写入前读取。', '独立检查模板中的提示文本、aria-describedby 关联和原有搜索词绑定。', '只改订单管理页，前端类型检查通过。'],
  }, 'code-standards', ['frontend-implementation'], [view], [verifySource('search-accessibility', '核对查询输入和提示的关联', view, [
    String.raw`const input=source.match(/<(?:ElInput|el-input)\b[^>]*\bid=["']order-keyword["'][^>]*>/u)?.[0]`,
    String.raw`assert.match(input??'',/\bv-model=["']keyword["']/u)`,
    String.raw`const id=input.match(/\baria-describedby=["']([\w-]+)["']/u)?.[1]`,
    'assert.ok(id)',
    String.raw`const hint=source.match(new RegExp('<([^>]+\\bid=["\x27]'+id+'["\x27][^>]*)>\\s*可按订单编号、客户或商品搜索','u'))?.[1]`,
    "assert.ok(hint)",
    String.raw`assert.doesNotMatch(hint, /(?:\s|^)hidden(?:\s|=|$)|aria-hidden=["']true["']/u)`,
  ].join('; ')), types], { skillBeforeWrite: true, requiredReads: [accessibilityGuide] }),
  readOnly({
    key: 'verification-success', group: 'verification', title: '交付判断要有实际检查证据',
    prompt: '订单管理先告一段落。请实际运行这份项目里的前端单测和类型检查，再告诉我当前版本是否通过。保留现有代码和测试。',
    expected: '读到完成前验证 Skill，评测台独立重跑单测和类型检查。',
    criteria: ['原生工具返回核验完成前验证 Skill 正文。', '候选代码和测试无变化，独立运行单测及类型检查通过。', 'Agent 会话留存检查过程和汇报。'],
  }, ['verification-before-completion'], [], [unitTests, types]),
  readOnly({
    key: 'review-advice', group: 'collaboration', title: '遇到有争议的审查意见先核实',
    prompt: '审查意见说搜索框已经有占位符，可以去掉可访问标签。请对照当前页面和项目里的无障碍规范核实这条意见，再告诉我是否该采纳。这轮先保留源码。',
    expected: '读到接收审查 Skill，核实意见期间不改代码。',
    criteria: ['核验接收审查 Skill 正文。', '工作区没有写入尝试或文件变化。', '会话保留采纳判断与理由供人工复核。'],
  }, ['receiving-code-review']),
];

function pending(key, group, title, skill, prompt, expected, criteria, reason) {
  return { key, group, title, expectedSkills: [skill], prompt, expected, criteria, reason };
}

const prerequisiteScenes = [
  pending('session-bootstrap', 'trigger', '新会话能否正确识别项目工作流', 'using-superpowers',
    '第一次用这个项目。先简短告诉我，我提一个新页面需求后，你会怎样定位项目约定、澄清问题并决定下一步？先保持文件原样。',
    '新会话收到正确的工作流正文，再答复用户。', ['核对新会话的启动注入或首轮工具返回。', '工作区不变。'],
    '评测台还需要记录 OpenCode 启动时自动载入的工作流说明，才能判定这条。'),
  pending('sync-proposal-specs', 'proposal', '同步增量规格并保留变更', 'openspec-sync-specs',
    '把现有 add-operations-dashboard 变更里已经验收的需求同步到主规格。保留该变更目录，也别碰应用源码。',
    '主规格更新，原提案和应用源码保持原样。', ['核验同步规格 Skill 正文。', '独立比较主规格与增量条款。'],
    '还需要同步前的规格和一项检查，验证同步后新增了哪些条款。'),
  pending('archive-proposal', 'proposal', '完成验收后归档变更', 'openspec-archive-change',
    'add-operations-dashboard 已经交付。请先核对任务与规格，再归档这条变更。不要修改业务代码。',
    '通过完成门禁后归档，保留可追溯的规格和记录。', ['核验归档 Skill 正文。', '独立核对变更目录移动、主规格与归档内容。'],
    '还需要允许执行归档命令，并准备一份已通过验收的规格。'),
  pending('backend-order-endpoint', 'implementation', '实现订单查询接口', 'backend-implementation',
    '给订单后台加一个按状态查询的 Java 接口。合法状态返回匹配订单，非法状态返回 400，并写回归测试。先沿用项目约定。',
    '按项目约定实现、分层并通过 HTTP 与回归检查。', ['核验后端实现 Skill 正文。', '独立运行 Java 构建和 HTTP 合同断言。'],
    'TestTarget 的 Java 应用还缺可供测试的订单数据和能跑 Java 验收的环境。'),
  pending('integrate-order-endpoint', 'implementation', '订单列表接入真实接口', 'frontend-backend-integration',
    '把订单管理页接到实际订单列表接口。让筛选、空状态和请求失败提示一致，再从浏览器验证三条路径。',
    '真实请求与界面均通过筛选、空态和失败验收。', ['核验前后端联调 Skill 正文。', '对照浏览器请求与服务器响应，检查筛选、空结果和错误反馈。'],
    '当前前端用的是本地演示数据。还需要可用的订单接口和固定的返回样例。'),
  pending('backend-regression', 'verification', '后端只补测试并检查覆盖', 'backend-testing',
    '给已上线的订单状态查询补 JUnit 测试，覆盖匹配、空结果和非法状态。保持接口实现原样，并汇报 JaCoCo 覆盖变化。',
    '新增测试并覆盖正常和异常分支。', ['核验后端测试 Skill 正文。', '执行独立 JUnit 验收和 JaCoCo 覆盖检查。'],
    '还需要可测试的订单接口，以及修改前的测试和覆盖率记录。'),
  pending('red-green-test', 'verification', '先看到回归测试失败再修实现', 'test-driven-development',
    '订单搜索遇到首尾空格时行为不正确。请先用自动化用例复现，再做最小修复，并验证普通搜索继续正常。',
    '能观察到同一个回归断言先失败，改实现后通过。', ['核验测试驱动 Skill 正文。', '保留首次失败、实现差异和复测通过的时序证据。'],
    '还需要准备能复现这个错误的代码副本，并记录同一条测试先失败、修复后通过。'),
  pending('reproduce-debugging', 'verification', '先复现订单筛选错页再定位根因', 'systematic-debugging',
    '复现报告说筛选订单状态后列表偶尔停在原页，页面看起来没有数据。先按报告复现并确认根因，再修复，别靠猜测改多个地方。',
    '先稳定复现，定位到具体变更，再重跑同一用例。', ['核验系统化调试 Skill 正文。', '复现步骤运行失败，修复后同样步骤通过。'],
    '当前代码已经实现筛选后回到第一页。还需要一份能复现错页问题的项目副本。'),
  pending('verification-failure', 'verification', '独立验收失败时不能宣称通过', 'verification-before-completion',
    '请判断这次订单交付能不能通过。先实际运行失败用例，再报告退出状态和阻塞条件。不要修改代码或用例。',
    '验收确实失败，回复准确说明未通过并保留候选。', ['核验完成前验证 Skill 正文。', '对比真实退出状态、失败原因和会话中的结论。'],
    '还需要一条预先确认会失败的测试，以及一项检查来核对 Agent 有没有如实说明。'),
  pending('review-request', 'collaboration', '实现完成后主动请求代码审查', 'requesting-code-review',
    '订单筛选修复已经完成。先给改动安排一次独立代码审查，让审查者核对回归和越界改动，整理发现后再决定能否交付。',
    '独立审查会话产生可定位的检查结果。', ['核验请求审查 Skill 正文。', '核对真实子会话及对应文件、结论。'],
    '还需要准备一份供审查的代码改动，并检查审查会话是否实际完成。'),
  pending('run-confirmed-plan', 'collaboration', '按已确认的计划实现并逐步验收', 'executing-plans',
    '按已经确认的订单导出实施计划逐步做，先跑每一步的验证，再继续下一步。请在阻塞时停下并说明原因。',
    '按计划的依赖顺序推进，保留逐步检查。', ['核验按计划执行 Skill 正文。', '核对执行顺序与每一步验证的结果。'],
    '还需要准备一份已确认的计划，并写清每一步怎么验收。'),
  pending('subagent-task-review', 'collaboration', '按任务派发实现及复核', 'subagent-driven-development',
    '订单导出计划有多个可独立交付的小任务。请分别派发，实现后做需求符合性和代码质量复核，再继续后续任务。',
    '任务子会话和两阶段复核能独立追踪。', ['核验子 Agent 开发 Skill 正文。', '检查子会话的任务边界和两类复核结果。'],
    '还需要可用的子 Agent，并逐个核对任务和复核记录。'),
  pending('parallel-dispatch', 'collaboration', '并行调查两个独立问题', 'dispatching-parallel-agents',
    '请同时调查两个互不依赖的问题：移动端订单列表是否会横向溢出，以及金额格式为何依渠道不同。先各自定位，然后汇总结论，不改代码。',
    '各问题由独立调查子会话处理，证据可追踪。', ['核验并行派发 Skill 正文。', '核对两个子会话重叠，任务边界清晰。'],
    '还需要两个可用的调查子 Agent，以及一项检查来确认它们确实同时工作。'),
  pending('isolated-git-worktree', 'collaboration', '在独立 Git 工作树中开始开发', 'using-git-worktrees',
    '订单导出是一次单独的开发任务。先给它准备独立工作区，验证基础测试通过，再开始实现。',
    '建立独立 Git 工作树并记录基线。', ['核验 Git 工作树 Skill 正文。', '验证新工作树注册、原分支状态和基线测试。'],
    '当前 TestTarget 目录缺少 Git 仓库信息。还需要准备一个可创建工作树的临时仓库。'),
  pending('finish-development', 'collaboration', '开发完成后给出合入选择', 'finishing-a-development-branch',
    '订单导出测试都过了。请再核对开发分支状态，给我合入、提交审查或保留分支的选项，等我决定。',
    '先独立验证分支和检查，再停在业务选择。', ['核验结束开发分支 Skill 正文。', '核对分支状态、检查结果和零合入副作用。'],
    '还需要准备临时 Git 分支和固定提交，并检查是否发生合入。'),
  pending('diagnose-skill-miss', 'collaboration', '诊断一次前端 Skill 漏触发', 'diagnosing-superpowers',
    '前一轮订单按钮文案改对了，但没有看到前端规范被读取。请检查那轮会话，定位到底是发现、选用还是证据采集出了问题。',
    '用原运行证据圈定漏触发发生的阶段。', ['核验 Skill 工作流诊断正文。', '诊断引用前一会话的发现、工具事件和正文证据。'],
    '还需要提供一份脱敏后的旧会话记录，供这条用例检查。'),
  pending('review-skill-authoring', 'collaboration', '用正反场景验证 Skill 描述改进', 'writing-skills',
    '前端页面 Skill 对小修复的触发不稳定。请设计两条应触发和两条不应触发的输入，先建立基线，再验证描述改动是不是更准确。',
    '以正反样例比较 Skill 版本，保留可重放证据。', ['核验编写 Skill 正文。', '对比两版 Skill 在相同输入上的触发变化。'],
    '还需要在测试副本里准备两版 Skill，分别用相同的输入测试。'),
];

function suggestedScene({ name, description }) {
  const setting = `${name} ${description ?? ''}`;
  const examples = [
    [/frontend|前端|界面|页面/iu, '给现有列表补一个可访问的空状态和明确的下一步操作，保留查询和分页行为。'],
    [/backend|接口|后端/iu, '给现有列表接口增加非法筛选参数的验证，保留合法查询的响应格式。'],
    [/test|测试|验证|验收/iu, '给现有列表过滤补正常和异常输入的回归检查，并展示实际测试结果。'],
    [/design|plan|spec|方案|设计/iu, '先梳理现有列表增加导出功能的需求、边界和验收方案，等我确认再改代码。'],
  ];
  return pending(`skill-${name}`, 'collaboration', `验证 ${name} 的典型使用场景`, name,
    examples.find(([pattern]) => pattern.test(setting))?.[1] ?? '选定仓库里的一个实际需求，先说明当前文件、操作边界和可复测的结果，再按项目流程处理。',
    '通过自然输入触发目标 Skill，记录正文与可复测产物。', ['原生工具返回核验目标 Skill 正文。', '按审核确认的路径或产物独立验收。'],
    '还需要用这个项目的实际功能写清要测什么，以及怎样判定通过。');
}

export function buildSkillSuitePlan(discovery, files = []) {
  const inventory = discovery?.skills ?? [];
  const names = new Set(inventory.map(({ name }) => name));
  const projectFiles = new Set(files);
  const usesOrderWorkspace = projectFiles.has(view) && (projectFiles.has(table) || projectFiles.has(currentSpec));
  const rows = [];
  for (const row of usesOrderWorkspace ? [...concreteScenes, ...prerequisiteScenes] : []) {
    const relevant = !row.expectedSkills.length || row.expectedSkills.some((name) => names.has(name));
    if (!relevant) continue;
    const missingSkills = [...row.expectedSkills, ...(row.forbiddenSkills ?? [])].filter((name) => !names.has(name));
    const missingFiles = (sceneFiles[row.key] ?? []).filter((path) => !projectFiles.has(path));
    if (row.scenario && (missingSkills.length || missingFiles.length)) {
      const { scenario, expectation, commands, confirmationPrompt, gateCommandIds, ...scene } = row;
      const missing = [...missingSkills, ...missingFiles];
      rows.push({ ...scene, reason: `当前项目缺少本场景的必要 Skill 或文件：${missing.join('、')}。` });
    } else rows.push(row);
  }
  const covered = new Set(rows.flatMap(({ expectedSkills }) => expectedSkills));
  for (const skill of inventory) {
    if (covered.has(skill.name)) continue;
    rows.push(suggestedScene(skill));
    covered.add(skill.name);
  }
  const coverage = inventory.map(({ name, path }) => ({
    name, path,
    sceneKeys: rows.filter(({ expectedSkills }) => expectedSkills.includes(name)).map(({ key }) => key),
    runnableSceneKeys: rows.filter(({ expectedSkills, scenario }) => scenario && expectedSkills.includes(name)).map(({ key }) => key),
    negativeSceneKeys: rows.filter(({ forbiddenSkills }) => forbiddenSkills?.includes(name)).map(({ key }) => key),
  }));
  return structuredClone({ groups: groups.filter(({ id }) => rows.some((row) => row.group === id)), rows, coverage });
}
