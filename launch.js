// 真正的「脱离启动器」。
//
// 背景：在 Windows 上用 WMI/CreateProcess 不带标志启动的子进程会**继承调用者的 console**，
// 于是调用者那条命令结束时（或 harness 杀进程组时），Ctrl+C 会一路传到这些后台服务，
// 日志里表现就是莫名其妙的 `^C`，服务全灭。
//
// node 的 spawn({detached:true}) 会用 CREATE_NEW_PROCESS_GROUP 起子进程，且不再共享 console，
// 所以这里让 node 来当外婆，服务就能活过父进程的死亡。
//
// 用法：node launch.js <exe> [args...]
//   环境变量：
//     LAUNCH_OUT   stdout 追加到这个文件（空 = 丢弃）
//     LAUNCH_ERR   stderr 追加到这个文件（空 = 丢弃）
//     LAUNCH_CWD   工作目录（默认当前目录）
// 输出：子进程 PID（一行）
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: node launch.js <exe> [args...]');
  process.exit(2);
}

const out = process.env.LAUNCH_OUT || '';
const err = process.env.LAUNCH_ERR || '';
const cwd = process.env.LAUNCH_CWD || process.cwd();

const stdio = [
  'ignore',
  out ? fs.openSync(out, 'a') : 'ignore',
  err ? fs.openSync(err, 'a') : 'ignore'
];

const child = spawn(cmd, args, {
  cwd,
  detached: true,
  windowsHide: true,
  stdio,
  env: process.env
});
child.unref();
process.stdout.write(String(child.pid ?? ''));
process.exit(0);
