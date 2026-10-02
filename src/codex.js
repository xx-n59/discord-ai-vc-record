import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, codexEnvironment } from './subprocess.js';

export async function checkCodexLogin(config, runner = runProcess) {
  const status = await runner(config.codexPath, ['login', 'status'], { env: codexEnvironment(), timeoutMs: 15000 });
  if (!/Logged in using ChatGPT/i.test(status.stdout + status.stderr)) {
    throw new Error('codex login でChatGPTにログインしてください。APIキー認証では実行しません。');
  }
}
export function codexArgs(config, outputPath, dir) {
  const disabled = ['shell_tool', 'unified_exec', 'multi_agent', 'apps', 'plugins', 'browser_use', 'computer_use', 'hooks', 'image_generation', 'workspace_dependencies'];
  return ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-c', 'approval_policy="never"', '-c', 'forced_login_method="chatgpt"', '-c', 'web_search="disabled"',
    ...disabled.flatMap(feature => ['--disable', feature]),
    ...(config.codexModel ? ['--model', config.codexModel] : []),
    '--cd', dir, '--color', 'never', '--output-last-message', outputPath, '-'];
}
export async function askCodex(config, prompt, runner = runProcess) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-minutes-'));
  const output = path.join(dir, 'answer.md');
  try {
    await runner(config.codexPath, codexArgs(config, output, dir), {
      input: prompt, env: codexEnvironment(), cwd: dir, timeoutMs: config.codexTimeoutMs,
    });
    const answer = fs.readFileSync(output, 'utf8').trim();
    if (!answer) throw new Error('Codexの議事録が空でした。再実行してください。');
    return answer;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
