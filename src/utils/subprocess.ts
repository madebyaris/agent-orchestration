import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface DetachedCommandInput {
  command: string;
  args: string[];
  cwd: string;
  logPath: string;
  exitCodePath: string;
  env?: NodeJS.ProcessEnv;
}

export interface DetachedCommandResult {
  pid: number;
  command: string;
}

export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    env: options?.env,
    encoding: 'utf-8',
  });

  return {
    success: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
  };
}

export function commandExists(command: string, cwd: string = process.cwd()): boolean {
  const probe = process.platform === 'win32'
    ? runCommand('where', [command], { cwd })
    : runCommand('which', [command], { cwd });
  return probe.success;
}

export function formatCommand(command: string, args: string[]): string {
  const shellQuote = (value: string) => {
    if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
      return value;
    }

    return `'${value.replace(/'/g, `'\\''`)}'`;
  };

  return [command, ...args].map(shellQuote).join(' ');
}

export function spawnDetachedCommand(input: DetachedCommandInput): DetachedCommandResult {
  fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
  fs.mkdirSync(path.dirname(input.exitCodePath), { recursive: true });

  const encodedPayload = Buffer.from(
    JSON.stringify({
      ...input,
      env: { ...process.env, ...input.env },
    }),
    'utf-8'
  ).toString('base64');

  const wrapper = `
const fs = require('fs');
const { spawn } = require('child_process');
const payload = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const stream = fs.createWriteStream(payload.logPath, { flags: 'a' });
const child = spawn(payload.command, payload.args, {
  cwd: payload.cwd,
  env: payload.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => stream.write(chunk));
child.stderr.on('data', (chunk) => stream.write(chunk));
child.on('error', (error) => {
  stream.write(String(error) + '\\n');
  fs.writeFileSync(payload.exitCodePath, '1', 'utf-8');
  stream.end(() => process.exit(0));
});
child.on('close', (code) => {
  fs.writeFileSync(payload.exitCodePath, String(code ?? 0), 'utf-8');
  stream.end(() => process.exit(0));
});
`;

  const child = spawn(process.execPath, ['-e', wrapper, encodedPayload], {
    cwd: input.cwd,
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  return {
    pid: child.pid ?? -1,
    command: formatCommand(input.command, input.args),
  };
}

export function isProcessRunning(pid: number | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
