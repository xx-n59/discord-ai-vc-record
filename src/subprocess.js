import { spawn } from 'node:child_process';
const running = new Set();
export function terminateSubprocesses() { for (const kill of running) kill(); }

// Never invoke a shell: meeting text, names, IDs and config remain data.
export function runProcess(command, args, { input = '', cwd, env = process.env, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* process already exited */ }
    };
    running.add(kill);
    const timer = setTimeout(() => { failure = new Error(`${command} がタイムアウトしました。再実行してください。`); kill(); }, timeoutMs);
    const append = (which, data) => {
      if (which === 'stdout') stdout += data; else stderr += data;
      if (stdout.length + stderr.length > 2 * 1024 * 1024) {
        failure = new Error(`${command} の出力が上限を超えました。`); kill();
      }
    };
    child.stdout.on('data', data => append('stdout', data.toString()));
    child.stderr.on('data', data => append('stderr', data.toString()));
    child.on('error', error => { running.delete(kill); clearTimeout(timer); reject(new Error(`${command} を起動できません。インストールとパスを確認してください。`, { cause: error })); });
    child.on('close', code => {
      running.delete(kill); clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) {
        const error = new Error(`${command} が終了コード ${code} で失敗しました。ログイン状態・利用上限・依存関係を確認してください。`);
        error.diagnostics = stderr.slice(-6000);
        reject(error);
      } else resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => { /* early child exit is handled by close */ });
    child.stdin.end(input);
  });
}
export function codexEnvironment(env = process.env) {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'CODEX_HOME', 'SystemRoot'];
  return Object.fromEntries(allowed.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}
