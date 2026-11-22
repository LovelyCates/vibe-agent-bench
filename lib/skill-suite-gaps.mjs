const sceneGaps = {
  'session-bootstrap': {
    missing: 'TestTarget 已有 Superpowers 启动插件。平台还缺首条消息发出前，插件自动装入了哪段说明的记录。',
    platformSteps: [
      '为隔离的新会话记录插件启动时自动载入的 Skill 名称、正文摘要和发生时间。',
      '独立核对 `using-superpowers` 正文在首条消息前载入，并检查项目文件没有改动。',
    ],
  },
  'sync-proposal-specs': {
    missing: '订单变更规格已经存在，主规格目录现在只有占位文件。这条还缺主规格测试样例和预期合并结果。',
    projectSteps: [
      '在测试副本准备一份包含既有条款的订单主规格，保留现有的增量规格。',
      '用独立文件检查核对新增条款、原有条款和保留的变更目录。也可以另建一条，测首次同步是否正确创建主规格。',
    ],
  },
  'archive-proposal': {
    missing: '项目里的变更任务已有完成勾选，但测试还缺可重复的归档前状态。平台的 OpenSpec 命令目前也未开放归档。',
    projectSteps: [
      '从 `add-operations-dashboard` 做一份测试副本，保留任务清单和增量规格，记录它归档前的文件位置。',
    ],
    platformSteps: [
      '仅在隔离工作区为指定变更开放归档命令。',
      '独立比较归档前后的活跃目录、归档目录及主规格，确认应用代码未变化。',
    ],
  },
  'backend-order-endpoint': {
    missing: 'TestTarget 的 Java 项目还缺订单用例数据。当前 Windows 验证器也不能直接运行本机的 Maven 命令入口。',
    projectSteps: [
      '给测试副本准备两三笔固定订单，明确按状态过滤、空结果和非法状态 400 的预期响应。',
      '按现有 Spring Boot 项目结构准备接口验收测试，明确测试数据从哪里加载。',
    ],
    platformSteps: [
      '增加经审核的 Windows Maven 启动方式，在隔离副本执行构建和接口验收并保存退出码。',
    ],
  },
  'integrate-order-endpoint': {
    missing: '订单页现在读本地演示数据。这条联调需要一个可启动的测试接口，以及固定的正常、空列表和失败响应。',
    projectSteps: [
      '准备订单接口或本地测试服务，给三种返回各准备一个固定样例。',
      '添加一条独立验证命令，在测试副本启动服务，核对实际请求、响应和页面显示。',
    ],
  },
  'backend-regression': {
    missing: '后端还没有可供补测的订单查询接口和覆盖率基线。当前 Windows 验证器也需要 Maven 启动支持。',
    projectSteps: [
      '准备现有订单查询接口和固定订单。用 JUnit 覆盖匹配、空结果和非法状态。',
      '用 JaCoCo 记录补测前的覆盖率，确定需要比较的包或类。',
    ],
    platformSteps: [
      '在隔离副本通过经审核的 Maven 入口执行测试，并保存覆盖率报告。',
    ],
  },
  'red-green-test': {
    missing: '这条缺一份能复现搜索空格问题的副本。平台还要能证明同一条回归测试在改实现前失败、改完后通过。',
    projectSteps: [
      '确认一个会失败的搜索输入，准备带这个缺陷的测试副本和固定订单。',
      '为回归检查选定固定测试名称和运行命令。',
    ],
    platformSteps: [
      '记录该测试的两次运行结果和实现写入时间，用相同测试名称核对先失败后通过。',
    ],
  },
  'reproduce-debugging': {
    missing: '现有实现已有筛选后回到第一页的逻辑。这条还缺可复现的错页副本和对复现先于修复的检查。',
    projectSteps: [
      '在测试副本准备能触发错页的实现与数据，把页码、输入动作和错误结果写成一条可重复测试。',
    ],
    platformSteps: [
      '记录首次复现、实现写入、复测结果的顺序，并核对修复前后使用的是同一测试。',
    ],
  },
  'verification-failure': {
    missing: '这条还缺一个预先确认会失败的检查，以及对 Agent 是否如实报告该失败的判定。',
    projectSteps: [
      '在测试副本放入固定的失败用例，为它指定命令、预期退出码和可识别的失败信息。',
    ],
    platformSteps: [
      '允许用例明确把指定失败作为预期，再将独立运行结果与 Agent 最终回复核对。',
    ],
  },
  'review-request': {
    missing: 'TestTarget 已有 `code-reviewer`。平台仍需把供审查的改动、完成的审查子会话和审查结论关联起来。',
    platformSteps: [
      '从一次既有评测选取固定的代码差异，作为可重复的只读审查输入。',
      '核对审查子会话确实完成，并引用指定文件和发现。子会话数量只能用于初步验证。',
    ],
  },
  'run-confirmed-plan': {
    missing: '这条缺一份待执行的已确认计划。平台还缺按步骤核对执行顺序和每一步验收结果的检查。',
    projectSteps: [
      '在测试副本准备包含两到三个小任务的已确认计划，为每一步写明验收命令。',
    ],
    platformSteps: [
      '逐步比较任务编号、操作和验收结果，并检查上一步有阻塞时下一步未启动。',
    ],
  },
  'subagent-task-review': {
    missing: 'TestTarget 有只读审查角色。这条还缺可分派的实现任务与受控实现角色，以及逐任务复核检查。',
    projectSteps: [
      '在测试副本准备两个互不改动相同文件的小任务，写清目标和文件范围。',
    ],
    platformSteps: [
      '为实现子 Agent 提供仅限测试副本的权限，记录任务与子会话的对应关系。',
      '核对每项任务先完成实现，再完成需求符合性与代码质量复核。',
    ],
  },
  'parallel-dispatch': {
    missing: '平台能取得子会话记录。这条还需要分别核对两个调查任务，并检查它们的执行时间确实重叠。',
    platformSteps: [
      '为现有项目安排两个独立的只读调查子会话，记录任务名称和开始、结束时间。',
      '核对两条调查都有结论、时间重叠且未改文件。已有子会话数量检查可先验证两条会话都出现。',
    ],
  },
  'isolated-git-worktree': {
    missing: '当前项目缺少 Git 仓库信息。平台还需要在测试副本内管理并检查额外的工作树。',
    projectSteps: [
      '准备一个只有固定基线提交和测试脚本的临时仓库。',
    ],
    platformSteps: [
      '只对测试副本开放工作树所需的 Git 操作，核对原分支、工作树注册和基线测试结果。',
    ],
  },
  'finish-development': {
    missing: '这条缺有开发分支和已完成改动的测试仓库。平台还要能核对分支、提交及是否提前合入。',
    projectSteps: [
      '准备含基线分支、开发分支和固定提交的临时仓库，附一条确定可通过的验证命令。',
    ],
    platformSteps: [
      '在隔离仓库记录分支与提交状态，核对 Agent 给出交付选项后停下来等待选择。',
    ],
  },
  'diagnose-skill-miss': {
    missing: '已有运行记录可以作为检查材料。平台还缺把脱敏旧记录带入新会话，再对照事实核对诊断的方式。',
    platformSteps: [
      '从已有评测导出脱敏后的 Skill 清单、工具事件和正文证据，作为只读测试材料。',
      '核对诊断所引用的旧事件，并分别验证发现、选用和正文读取三个阶段。',
    ],
  },
  'review-skill-authoring': {
    missing: '这条还缺两版 Skill 和固定的触发样例。平台需要为同组输入保留两版运行证据。',
    projectSteps: [
      '在两个测试副本准备原版与候选版 Skill，配两条应触发和两条不应触发的输入。',
    ],
    platformSteps: [
      '用同一组输入和判定条件分别运行两版，记录版本和每条结果，比较触发和误触发。',
    ],
  },
};

export function suiteGapFor(row) {
  if (!row?.reason) return null;
  const details = Object.hasOwn(sceneGaps, row.key) ? sceneGaps[row.key] : null;
  const missing = details?.missing ?? row.reason;
  const projectSteps = details ? [...(details.projectSteps ?? [])] : [
    '用项目里真实存在的功能、文件或已有测试替换通用示例。',
    '写清需要的测试材料和通过条件，优先复用项目已有的验证命令。',
  ];
  const platformSteps = [...(details?.platformSteps ?? [])];
  const kind = projectSteps.length ? (platformSteps.length ? 'both' : 'project') : 'platform';
  const steps = [...projectSteps, ...platformSteps];
  const aiPrompt = [
    `为「${row.title}」准备可审核的测试用例草稿。${missing}`,
    projectSteps.length && '先找项目里可以复用的内容。需要新增的数据或说明，准备为测试副本使用的材料。',
    platformSteps.length && '说明哪些步骤可用平台现有判定规则验证，哪些仍需要新增平台检查。',
    `补齐步骤：${steps.join(' ')}`,
  ].filter(Boolean).join('\n');
  return { kind, missing, steps, projectSteps, platformSteps, aiPrompt };
}
