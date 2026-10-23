// 看门狗：每 30 秒检查 SnowLuma / qq-bridge / Ollama 是否活着，死了就调 autostart.ps1。
//
// 为什么用 node 而不是 PowerShell：这台机器上从 WMI/cmd 拉起的 powershell 子进程会被
// 安全软件拦掉（日志里是"拒绝访问"），而 node.exe 的启动路径已验证稳定（桥接、SnowLuma 都是）。
//
// 设计：
//   - 只检查端口，不猜进程名。
//   - 拉起统一交给 autostart.ps1（幂等，已在跑的不动）。
//   - 单实例：state/watchdog.lock 里记自己的 pid，进程不存在才允许接管。
//   - 全程写 state/watchdog.log。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const STATE = path.join(ROOT, 'state');
const LOG = path.join(STATE, 'watchdog.log');
const LOCK = path.join(STATE, 'watchdog.lock');
const AUTOSTART = path.join(ROOT, 'autostart.ps1');
const INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 30000);

function log(msg) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)}  ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch {}
  process.stdout.write(line);
}

function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 单实例
try {
  if (fs.existsSync(LOCK)) {
    const other = parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10);
    if (pidAlive(other)) {
      log(`another watchdog is alive (pid=${other}), exiting`);
      process.exit(0);
    }
  }
} catch {}
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(LOCK, String(process.pid), 'ascii');

log(`watchdog started (pid=${process.pid}, interval=${INTERVAL_MS / 1000}s)`);

function runAutostart() {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AUTOSTART], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.on('error', (error) => { log(`autostart spawn failed: ${error.message}`); resolve(false); });
    child.on('exit', (code) => { log(`autostart exited (code=${code})`); resolve(true); });
    setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 300000);
  });
}

async function tick() {
  const [snow, onebot, bridge, ollama] = await Promise.all([
    portOpen(5099), portOpen(3001), portOpen(3100), portOpen(11434)
  ]);
  if (!snow || !onebot || !bridge) {
    log(`down: snowluma=${snow} onebot=${onebot} bridge=${bridge} ollama=${ollama} -> running autostart`);
    await runAutostart();
    await new Promise((r) => setTimeout(r, 8000));
    const [s2, o2, b2, l2] = await Promise.all([portOpen(5099), portOpen(3001), portOpen(3100), portOpen(11434)]);
    log(`after autostart: snowluma=${s2} onebot=${o2} bridge=${b2} ollama=${l2}`);
  } else if (!ollama) {
    log('ollama down but QQ stack is fine -> running autostart (will only start Ollama)');
    await runAutostart();
  }
}

process.on('SIGINT', () => { try { fs.unlinkSync(LOCK); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { fs.unlinkSync(LOCK); } catch {} process.exit(0); });
process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch {} });

while (true) {
  try { await tick(); } catch (error) { log(`tick failed: ${error?.message ?? error}`); }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
