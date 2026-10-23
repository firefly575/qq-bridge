// TTS：把 AI 想说的话合成成语音库文件（audio/ 里的 mp3），再交给原有发送链路。
//
// 为什么要这一步：上游 `qq_send_voice` 只允许发「语音库里已存在的文件」，这是防
// prompt injection 拿本机任意文件外发的硬边界（见 RULES.md）。AI 想「开口说话」
// 就必须先生成文件，于是这里做的事是「合成 → 落到 audio/ → 复用原有校验与发送」，
// 不绕过任何一条安全检查：目标白名单、时长/体积/频率、审计拦截、sendChain 全都照旧。
//
// 引擎：
//   edge  — python -m edge_tts（微软 Edge 神经语音，音质好、音色多；需要网络）
//   sapi  — Windows 自带 SAPI（离线，音色少、机械感强，作为兜底）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const DEFAULT_TTS = {
  enabled: false,
  engine: 'edge',            // edge | sapi
  voice: 'zh-CN-XiaoyiNeural',
  rate: '+0%',               // edge 用百分比；sapi 用 -10..10 的数字
  volume: '+0%',
  maxChars: 160,
  pythonPath: 'python',
  timeoutMs: 60000
};

function run(cmd, args, { timeoutMs = 60000, cwd = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stderr: `spawn 失败：${error?.message ?? error}` });
      return;
    }
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: -2, stderr: '超时' });
    }, timeoutMs);
    child.stderr?.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: `启动失败：${error?.message ?? error}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/** 归一化文本：压掉换行和多余空白，避免 TTS 把换行读成停顿或报错。 */
export function normalizeSpeechText(text) {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function describeTts(tts = {}) {
  const cfg = { ...DEFAULT_TTS, ...(tts ?? {}) };
  return `${cfg.engine}:${cfg.voice}${cfg.enabled ? '' : '（未启用）'}`;
}

/**
 * 合成语音到 <voiceDir>/tts-<hash>.mp3。
 * 同样的文本+音色+参数会命中缓存，不重复合成（也避免重复计费/耗时）。
 */
export async function synthesizeSpeech(text, { dir, tts = {} } = {}) {
  const cfg = { ...DEFAULT_TTS, ...(tts ?? {}) };
  if (!cfg.enabled) throw new Error('TTS 未启用（config.json 的 socialV2.voice.tts.enabled）');

  const clean = normalizeSpeechText(text);
  if (!clean) throw new Error('text 为空');
  const maxChars = Math.max(1, Number(cfg.maxChars) || DEFAULT_TTS.maxChars);
  if (clean.length > maxChars) {
    throw new Error(`text 太长（${clean.length} 字），上限 ${maxChars} 字；请拆成几句分开发`);
  }

  const voiceDir = dir || 'audio';
  fs.mkdirSync(voiceDir, { recursive: true });

  const hash = crypto.createHash('sha1')
    .update(`${cfg.engine}|${cfg.voice}|${cfg.rate}|${cfg.volume}|${clean}`)
    .digest('hex')
    .slice(0, 12);
  const out = path.join(voiceDir, `tts-${hash}.mp3`);

  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    return { path: out, file: path.basename(out), cached: true, bytes: fs.statSync(out).size, text: clean };
  }

  const tmp = `${out}.${process.pid}.part`;
  let result;
  if (cfg.engine === 'sapi') {
    const esc = clean.replace(/'/g, "''");
    const ps = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      `try { $s.SelectVoice('${String(cfg.voice).replace(/'/g, "''")}') } catch {};`,
      `$s.Rate = ${Number(String(cfg.rate).replace(/[^-\d]/g, '')) || 0};`,
      `$s.SetOutputToWaveFile('${tmp.replace(/'/g, "''").replace(/\\/g, '\\\\')}');`,
      `$s.Speak('${esc}');`,
      '$s.Dispose()'
    ].join(' ');
    result = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeoutMs: cfg.timeoutMs });
  } else {
    result = await run(cfg.pythonPath || 'python', [
      '-m', 'edge_tts',
      '-t', clean,
      '-v', String(cfg.voice),
      `--rate=${cfg.rate || '+0%'}`,
      `--volume=${cfg.volume || '+0%'}`,
      '--write-media', tmp
    ], { timeoutMs: cfg.timeoutMs });
  }

  if (result.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    const hint = cfg.engine === 'edge'
      ? '（检查 edge-tts 是否安装：python -m pip install --user edge-tts；以及网络能否访问 speech.platform.bing.com）'
      : '';
    throw new Error(`语音合成失败${hint}：${(result.stderr || '').slice(0, 300) || `退出码 ${result.code}`}`);
  }

  fs.renameSync(tmp, out);
  return { path: out, file: path.basename(out), cached: false, bytes: fs.statSync(out).size, text: clean };
}
