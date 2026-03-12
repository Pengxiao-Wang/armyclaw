// ═══════════════════════════════════════════════════════════
// ArmyClaw — Unified Launcher
// Starts HQ + War Room in one process, opens browser.
// Usage: tsx src/launcher.ts
// ═══════════════════════════════════════════════════════════

import { spawn, exec, type ChildProcess } from 'child_process';

const CYAN = '\x1b[0;36m';
const GREEN = '\x1b[0;32m';
const RED = '\x1b[0;31m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

const children: ChildProcess[] = [];

function prefixOutput(proc: ChildProcess, tag: string, color: string): void {
  proc.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      process.stdout.write(`${color}[${tag}]${NC} ${line}\n`);
    }
  });
  proc.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      process.stderr.write(`${color}[${tag}]${NC} ${line}\n`);
    }
  });
}

function shutdown(): void {
  console.log(`\n${DIM}Shutting down...${NC}`);
  for (const child of children) {
    child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 1. Start HQ
const hq = spawn('npx', ['tsx', '--env-file=.env', 'src/index.ts'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  cwd: process.cwd(),
});
children.push(hq);
prefixOutput(hq, 'HQ', CYAN);

hq.on('exit', (code) => {
  console.log(`${RED}[HQ] exited with code ${code}${NC}`);
  shutdown();
});

// 2. Start War Room
const warRoom = spawn('npx', ['tsx', 'src/war-room/server.ts'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  cwd: process.cwd(),
  env: { ...process.env },
});
children.push(warRoom);
prefixOutput(warRoom, 'WAR', GREEN);

warRoom.on('exit', (code) => {
  console.log(`${RED}[WAR] exited with code ${code}${NC}`);
});

// 3. Open browser after a short delay (War Room needs time to bind port)
const port = process.env.WAR_ROOM_PORT || '3939';
setTimeout(() => {
  const url = `http://localhost:${port}`;
  console.log(`${GREEN}Opening Sand Table: ${url}${NC}`);
  exec(`open "${url}"`);
}, 2000);
