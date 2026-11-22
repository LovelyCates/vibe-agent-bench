import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

const javaVue = {
  id: 'java-vue-status-filter',
  title: '任务看板状态筛选 · Java + Vue',
  projectDir: fileURLToPath(new URL('../scenarios/java-vue-task-board', import.meta.url)),
  requirement: '在运维任务看板中为列表增加状态筛选。用户可以选择全部状态、待处理、进行中、已完成。列表通过真实 HTTP 请求读取筛选结果，并保留已有关键字搜索和排序。GET /api/tasks 接收可选 status（pending、running、completed），支持与 q 同时使用，非法值或重复 status 返回 400 与 INVALID_STATUS，查无匹配时返回空列表并在页面上显示空态。补充能覆盖新增行为的回归测试。',
  skillProfile: 'superpowers',
};

export const scenarios = [javaVue];

export function findScenario(projectDir) {
  return scenarios.find((scenario) => relative(projectDir, scenario.projectDir) === '');
}

export function labelScenarioCommands(scenario, commands) {
  if (scenario?.id !== javaVue.id) return commands;
  const labels = {
    'test:api': 'Java 服务与 API 契约', 'test:browser': 'Vue 页面与真实浏览器联调',
    lint: 'Java 与 Vue 代码规范', build: '生产构建', 'test:regression': '测试辨别力',
  };
  return commands.map((entry) => ({ ...entry, label: labels[entry.args[1]] ?? entry.label }));
}
