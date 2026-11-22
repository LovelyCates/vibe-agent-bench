import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const projectApiKeyEnv = 'VIBE_BENCH_OPENAI_API_KEY';

export function projectApiKeyFile() {
  if (process.env.LOCALAPPDATA) {
    return resolve(process.env.LOCALAPPDATA, 'VibeAgentBench', 'openai-api-key');
  }
  if (process.platform === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', 'VibeAgentBench', 'openai-api-key');
  }
}
