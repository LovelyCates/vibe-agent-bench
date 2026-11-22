export const projectAgents = Object.freeze({
  opencode: 'OpenCode',
  dsh: 'DeepSeek Harness',
});

export function isProjectAgent(agent) {
  return typeof agent === 'string' && Object.hasOwn(projectAgents, agent);
}
