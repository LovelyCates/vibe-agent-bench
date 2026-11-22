export const skillName = 'task-status-filter';
export const skillPath = '.agents/skills/task-status-filter/SKILL.md';

const sampleEditable = new Set(['backend/tasks-route.mjs', 'frontend/index.html', 'frontend/app.mjs', 'frontend/style.css']);

export function isSampleEditable(path) {
  return sampleEditable.has(path) || /^test\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.mjs$/u.test(path);
}

export const taskPrompt = `你正在一个独立的后台任务列表样例项目里工作。请直接完成代码改动并编写测试。

阅读当前目录的 README.md 并遵循其中的项目契约。给后台任务列表增加状态筛选：默认显示全部，选择待处理、进行中或已完成时通过真实 API 获取对应任务，恢复全部时清除筛选，并显示空结果提示。GET /api/tasks 接受可选的 status（queued、running、completed），非法状态返回 400，响应保持现有结构和顺序。

允许修改 backend/tasks-route.mjs、frontend/index.html、frontend/app.mjs、frontend/style.css，并新增或修改 test/ 下的 *.test.mjs 测试。保持样例数据、任务存储、服务启动、健康接口、项目配置和 README 原样。沿用浏览器的固定 DOM 选择器和数据属性。测试使用 Node 内置 test，启动项目自带后端并通过真实 HTTP 断言状态筛选和非法状态。不要引入新依赖或留下后台进程。

完成改动后运行可执行的测试，简述实现和测试结果。`;
