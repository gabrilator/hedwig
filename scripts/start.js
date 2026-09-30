/**
 * `npm start`: the web server and the worker as two processes in one container, so one service runs all of Hedwig.
 * Law 7 holds: the worker is still the only scheduler and the web process never runs jobs; they only share a container.
 * If either process dies the other is stopped and the container exits, so the platform restarts both together.
 */
import { spawn } from 'node:child_process';

const children = new Map();
let stopping = false;
let exitCode = 0;

function shutdown(code, why) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  console.log(`[hedwig] ${why}: stopping`);
  for (const child of children.values()) child.kill('SIGTERM');
  setTimeout(() => process.exit(exitCode), 25_000).unref(); // the worker drains for up to 20 s
}

for (const [name, entry] of [['web', 'build/index.js'], ['worker', 'build-worker/index.js']]) {
  const child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!stopping) shutdown(code ?? 1, `${name} exited (${signal ?? `code ${code}`})`);
    if (children.size === 0) process.exit(exitCode);
  });
}

process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGINT', () => shutdown(0, 'SIGINT'));
