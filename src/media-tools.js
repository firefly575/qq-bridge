// 本地媒体生成：画图（百炼 Qwen-Image 云端 / 本地 stable-diffusion.cpp 兜底）与「念歌词带调」。
//
// 画图两条路：
//   provider='qwen'  —— 阿里云百炼 qwen-image-3.0（云端，约 10~30 秒，1328×1328，质量高得多）。
//                       **和语音共用同一把 key**：state/aliyun-key.txt（或环境变量 DASHSCOPE_API_KEY），
//                       语音走 services/audio/tts，画图走 services/aigc/multimodal-generation，同一个账号同一把 key。
//   provider='sdcpp' —— 本地 stable-diffusion.cpp（Q8 SD-Turbo，512×512 约 20 秒，纯 CPU）。
//                       没网/额度用完时可以切回来。
//
// 产物一律落进受控目录（images/、audio/），再交给桥接原有的白名单/限流/审计/发送链路，
// 不新增任何「把本机任意路径发出去」的入口。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeResolution, resolutionInfo } from './draw-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DRAW = {
  enabled: false,
  provider: 'qwen',                     // 'qwen'（百炼）| 'seedream'（火山方舟）| 'sdcpp'（本地 CPU）
  model: 'qwen-image-3.0',              // 百炼图像模型；也可换 qwen-image-3.0-pro / wan2.7-image
  resolution: '1080p',                  // '720p' | '1080p'（QQ 里 /draw res 可改）
  size: '',                             // 显式尺寸优先；留空则按 resolution 换算
  maxPerDay: 10,                        // 每天最多生成几张（费用保护，QQ 里 /draw limit 可改）
  apiKeyFile: 'state/aliyun-key.txt',   // 与语音、翻唱共用同一把百炼 key
  promptExtend: true,                   // 让百炼改写/扩写提示词
  watermark: false,
  // 火山方舟（Seedream）：**另一套 key**，百炼那把用不了。两个可选档位：
  //   seedream      → 5.0 flash（轻量/快速，≈10 秒）
  //   seedream-pro  → 5.0 pro（高端，≈40 秒，中文书法/印章更准）
  seedream: {
    model: 'doubao-seedream-5-0-flash-260915', // 5.0 轻量/快速档（就是「lite」那档）
    apiKeyFile: 'state/ark-key.txt',
    envVar: 'ARK_API_KEY',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    size: '',                                  // 留空按 resolution 换算（1280x720 / 1920x1080）
    outputFormat: 'jpeg'                       // jpeg≈0.5MB / png≈4.5MB（4.5K 级损失更小，QQ 发图 jpeg 够）
  },
  seedreamPro: {
    model: 'doubao-seedream-5-0-pro-260628',
    apiKeyFile: 'state/ark-key-2.txt',
    envVar: 'ARK_API_KEY_PRO',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    size: '',
    outputFormat: 'jpeg'
  },
  // ↓ 本地 sdcpp 兜底参数（provider='sdcpp' 时才用）
  sdCliPath: 'D:\\Apps\\sd-cpp\\sd-cli.exe',
  modelPath: 'D:\\Apps\\sd-cpp\\models\\sd_turbo-q8.gguf',
  width: 512,
  height: 512,
  steps: 2,
  cfgScale: 1,
  timeoutMs: 300000,
  maxPerHour: 20,
  negative: ''
};

// 只在 resolution 也没配的时候兜底（按宽高比挑，免得传不支持的尺寸）
const QWEN_SIZES = [
  { w: 1328, h: 1328 },   // 1:1
  { w: 1664, h: 928 },    // 16:9
  { w: 928, h: 1664 },    // 9:16
  { w: 1472, h: 1140 },   // 4:3
  { w: 1140, h: 1472 }    // 3:4
];
const DASHSCOPE_IMAGE_API = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

// ── 视频生成 ──────────────────────────────────────────────────────────────
//   默认：阿里云百炼 wan3.0-video，480P（854*480），时长 2~30 秒（默认 4 秒）。
//   **一次调用只提交一个任务，失败就是失败，绝不自动重试第二遍**（重试=重复扣费）。
//   seedance（火山方舟）已搁置：seedance.enabled=false，切过去会直接拒绝。
export const DEFAULT_VIDEO = {
  enabled: false,
  provider: 'wan',         // 'wan'（wan3.0-video，默认）| 'wan-prime'（wan3.0-video-prime）
  model: 'wan3.0-video',
  dir: 'videos',
  size: '854*480',         // 480P 16:9
  duration: 4,             // 秒（默认 4）
  durationRange: [2, 30],  // 单值时长可直接调；边界就是接口的 2~30 秒
  // 测试专用：接口最短只能 2 秒（实测 duration ∈ [2,30]），所以生成 2 秒再用 ffmpeg 剪成 0.5 秒发出
  test: { enabled: true, duration: 2, trimTo: 0.5, size: '854*480' },
  ffmpegPath: 'D:\\Apps\\ffmpeg\\bin\\ffmpeg.exe',
  timeoutMs: 900000,       // 整条链路（提交+排队+渲染）上限 15 分钟
  pollMs: 8000,
  maxPerDay: 5,            // 视频比图贵得多，默认一天 5 条
  maxPerHour: 10,
  apiKeyFile: 'state/aliyun-key.txt',  // wan：与语音/画图共用同一把百炼 key
  // 百炼的两个 wan3.0 视频型号（都走同一套接口，只是 model 名不同）
  models: {
    wan: 'wan3.0-video',
    wanPrime: 'wan3.0-video-prime'
  },
  // 火山方舟 Seedance：**已搁置**（模型未开通，用户要求先不启用）
  seedance: {
    enabled: false,
    model: 'doubao-seedance-2-0-mini-260615',
    apiKeyFile: 'state/ark-key.txt',
    envVar: 'ARK_API_KEY',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    ratio: '16:9',
    resolution: '480p',
    duration: 5
  }
};
const DASHSCOPE_VIDEO_API = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis';
const DASHSCOPE_TASK_API = 'https://dashscope.aliyuncs.com/api/v1/tasks';



export const DEFAULT_SING = {
  enabled: false,
  voice: 'zh-CN-XiaoyiNeural',
  pythonPath: 'python',
  ffmpegPath: 'D:\\Apps\\ffmpeg\\bin\\ffmpeg.exe',
  timeoutMs: 300000,
  maxChars: 140,
  maxLines: 12,
  // 半音偏移，循环取用；0 2 4 5 7 是五声音阶，听感比较"像在唱"
  melody: [0, 2, 4, 7, 5, 4, 2, 0]
};

function run(cmd, args, { timeoutMs = 300000, cwd = null, env = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env });
    } catch (error) {
      resolve({ code: -1, stderr: `spawn 失败：${error?.message ?? error}` });
      return;
    }
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: -2, stderr: '超时' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { if (stdout.length < 8000) stdout += d.toString(); });
    child.stderr?.on('data', (d) => { if (stderr.length < 8000) stderr += d.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: `启动失败：${error?.message ?? error}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function hashOf(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 优先环境变量，其次共用配置文件（与语音/翻唱同一把百炼 key）。 */
function resolveDrawApiKey(c) {
  const env = String(process.env.DASHSCOPE_API_KEY ?? '').trim();
  if (env) return env;
  const rel = String(c.apiKeyFile || 'state/aliyun-key.txt');
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (fs.existsSync(file)) {
    const k = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (k) return k;
  }
  throw new Error(`缺少百炼 API Key（${rel} 或环境变量 DASHSCOPE_API_KEY）`);
}

/** 尺寸：显式 size > resolution（720P/1080P）> 按 width/height 挑最接近的支持尺寸。 */
function pickQwenSize(c) {
  const raw = String(c.size ?? '').trim();
  if (raw) return raw;
  if (normalizeResolution(c.resolution)) return resolutionInfo(c.resolution).size;
  const target = (Number(c.width) || 1328) / (Number(c.height) || 1328);
  let best = QWEN_SIZES[0];
  let bestDiff = Infinity;
  for (const s of QWEN_SIZES) {
    const diff = Math.abs(s.w / s.h - target);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return `${best.w}*${best.h}`;
}

/** 百炼 Qwen-Image：POST 同步接口 → 拿临时 URL → 下载落盘。 */
async function generateImageQwen(clean, { dir, c }) {
  const apiKey = resolveDrawApiKey(c);
  ensureDir(dir);
  const size = pickQwenSize(c);
  const tag = hashOf(['qwen', String(c.model || ''), clean, size]);
  const out = path.join(dir, `draw-${tag}.png`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) {
    return { path: out, file: path.basename(out), cached: true, ms: 0, provider: 'qwen', size };
  }
  assertCanSpend(c);

  const payload = {
    model: String(c.model || 'qwen-image-3.0'),
    input: { messages: [{ role: 'user', content: [{ text: clean }] }] },
    parameters: {
      size,
      n: 1,
      prompt_extend: c.promptExtend !== false,
      watermark: c.watermark === true
    }
  };
  const timeoutMs = Math.max(30000, Number(c.timeoutMs) || 300000);
  const t0 = Date.now();

  let resp;
  try {
    resp = await fetch(DASHSCOPE_IMAGE_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new Error(`百炼生图请求失败：${error?.message ?? error}`);
  }

  const text = await resp.text();
  if (!resp.ok) {
    // 常见：Model.AccessDenied（该账号没开通这个模型）/ InvalidParameter（尺寸不支持）
    throw new Error(`百炼生图失败 HTTP ${resp.status}：${text.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`百炼返回不是 JSON：${text.slice(0, 200)}`); }

  const content = data?.output?.choices?.[0]?.message?.content;
  const url = (Array.isArray(content) ? content : []).map((x) => x?.image).find(Boolean);
  if (!url) throw new Error(`百炼没返回图片：${text.slice(0, 300)}`);

  const bin = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(120000) })).arrayBuffer());
  if (bin.length < 1000) throw new Error(`图片下载异常（${bin.length} 字节）`);
  fs.writeFileSync(out, bin);

  return { path: out, file: path.basename(out), cached: false, ms: Date.now() - t0, provider: 'qwen', size };
}

/** 本地 stable-diffusion.cpp（纯 CPU，旧的兜底方案）。 */
async function generateImageLocal(clean, { dir, c }) {
  if (!fs.existsSync(c.sdCliPath)) throw new Error(`找不到 sd-cli：${c.sdCliPath}`);
  if (!fs.existsSync(c.modelPath)) throw new Error(`找不到模型：${c.modelPath}`);

  ensureDir(dir);
  const width = Number(c.width) || 512;
  const height = Number(c.height) || 512;
  const steps = Number(c.steps) || 2;
  const tag = hashOf(['sdcpp', clean, width, height, steps, c.cfgScale]);
  const out = path.join(dir, `draw-${tag}.png`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) {
    return { path: out, file: path.basename(out), cached: true, ms: 0, provider: 'sdcpp' };
  }

  const args = [
    '-m', c.modelPath,
    '-p', clean,
    '-o', out,
    '-W', String(width),
    '-H', String(height),
    '--steps', String(steps),
    '--cfg-scale', String(c.cfgScale ?? 1),
    '--sampling-method', 'euler_a'
  ];
  if (c.negative) args.push('-n', String(c.negative));

  const t0 = Date.now();
  const r = await run(c.sdCliPath, args, { timeoutMs: c.timeoutMs, cwd: path.dirname(c.sdCliPath) });
  const ms = Date.now() - t0;
  if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 1000) {
    throw new Error(`画图失败（退出码 ${r.code}）：${(r.stderr || r.stdout || '').slice(-400)}`);
  }
  return { path: out, file: path.basename(out), cached: false, ms, provider: 'sdcpp' };
}

/** 额度用完了就别花钱了（缓存命中在上层已经先返回，不会走到这里）。 */
function assertCanSpend(c) {
  if (c.allowSpend === false) {
    const used = Number(c.quotaUsed) || 0;
    const limit = Number(c.maxPerDay) || 0;
    throw new Error(`今天的生图额度用完了（${used}/${limit}），明天再画；管理员可发 /draw limit <数字> 调高上限`);
  }
}

/** provider 名 → config 里的 profile 字段名（火山方舟的两个档位都走同一套实现）。 */
const ARK_PROFILES = {
  seedream: 'seedream',
  'seedream-pro': 'seedreamPro',
  seedreampro: 'seedreamPro',
  pro: 'seedreamPro'
};

function arkConfOf(c, provider) {
  const field = ARK_PROFILES[provider] ?? 'seedream';
  return { ...(DEFAULT_DRAW[field] ?? DEFAULT_DRAW.seedream), ...(c[field] ?? {}) };
}

/** 火山方舟的 key：该档位自己的环境变量，其次它自己的 key 文件。 */
function resolveArkKey(conf) {
  const envName = String(conf.envVar || 'ARK_API_KEY');
  const env = String(process.env[envName] ?? '').trim();
  if (env) return env;
  const rel = String(conf.apiKeyFile || 'state/ark-key.txt');
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (fs.existsSync(file)) {
    const k = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (k) return k;
  }
  throw new Error(
    `这个档位需要火山方舟 API Key：把 key 写进 ${rel}（或设环境变量 ${envName}）。`
    + ' 注意百炼那把 key 用不了——seedream 是字节火山的模型，得在火山方舟控制台开通并创建 key。'
  );
}

/** 火山方舟 Seedream：POST /images/generations（OpenAI 风格），返回 data[0].url。 */
async function generateImageArk(clean, { dir, c, conf, provider }) {
  const apiKey = resolveArkKey(conf);
  const model = String(conf.model ?? '').trim();
  if (!model) throw new Error(`没配模型名（config.json → socialV2.draw.${ARK_PROFILES[provider] ?? 'seedream'}.model）`);

  ensureDir(dir);
  const res = resolutionInfo(c.resolution);
  const size = String(conf.size || res.seedreamSize);
  const outputFormat = String(conf.outputFormat || 'jpeg').toLowerCase();
  const tag = hashOf([provider, model, clean, size, outputFormat]);
  // 方舟可能回 jpeg 也可能回 png（看 output_format），两种后缀都查一遍缓存
  for (const ext of ['png', 'jpg']) {
    const p = path.join(dir, `draw-${tag}.${ext}`);
    if (fs.existsSync(p) && fs.statSync(p).size > 1000) {
      return { path: p, file: path.basename(p), cached: true, ms: 0, provider, size, model };
    }
  }
  assertCanSpend(c);

  const baseUrl = String(conf.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const payload = {
    model,
    prompt: clean,
    response_format: 'url',
    size,
    watermark: c.watermark === true,
    output_format: outputFormat
  };
  const timeoutMs = Math.max(30000, Number(c.timeoutMs) || 300000);
  const t0 = Date.now();

  let resp;
  try {
    resp = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new Error(`seedream 请求失败：${error?.message ?? error}`);
  }

  const text = await resp.text();
  if (!resp.ok) {
    // 常见：401 AuthenticationError（key 不对）/ 404 model not found（模型名或未开通）
    throw new Error(`seedream（${model}）失败 HTTP ${resp.status}：${text.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`seedream 返回不是 JSON：${text.slice(0, 200)}`); }

  const first = Array.isArray(data?.data) ? data.data[0] : null;
  const url = String(first?.url ?? '').trim();
  const b64 = String(first?.b64_json ?? '').trim();

  let bin;
  if (url) {
    const r2 = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!r2.ok) throw new Error(`seedream 图片下载失败 HTTP ${r2.status}`);
    bin = Buffer.from(await r2.arrayBuffer());
  } else if (b64) {
    bin = Buffer.from(b64, 'base64');
  } else {
    throw new Error(`seedream 没返回图片：${text.slice(0, 300)}`);
  }
  if (bin.length < 1000) throw new Error(`seedream 图片异常（${bin.length} 字节）`);

  // 方舟回什么格式就按什么格式落盘（默认 jpeg，约 0.5MB；png 约 4.5MB）
  const isPng = bin[0] === 0x89 && bin[1] === 0x50 && bin[2] === 0x4e && bin[3] === 0x47;
  const ext = isPng ? 'png' : 'jpg';
  const out = path.join(dir, `draw-${tag}.${ext}`);
  fs.writeFileSync(out, bin);
  return { path: out, file: path.basename(out), cached: false, ms: Date.now() - t0, provider, size, model, format: ext };
}

/**
 * 生成一张图，返回 { path, file, cached, ms, provider, size, model }。相同提示词+参数命中缓存。
 * provider = 'qwen'（百炼 Qwen-Image，默认）| 'seedream'（火山 5.0 flash）
 *          | 'seedream-pro'（火山 5.0 pro）| 'sdcpp'（本地 CPU）
 * cfg.allowSpend === false 时只允许命中缓存，不允许真的花钱生成（每日额度保护）。
 */
export async function generateImage(prompt, { dir, cfg = {} } = {}) {
  const c = { ...DEFAULT_DRAW, ...(cfg ?? {}) };
  if (!c.enabled) throw new Error('画图未启用（config.json 的 socialV2.draw.enabled）');
  const clean = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('prompt 为空');
  if (clean.length > 400) throw new Error(`prompt 太长（${clean.length} 字），上限 400`);
  const provider = String(c.provider || 'qwen').toLowerCase();
  if (provider === 'sdcpp' || provider === 'local') return generateImageLocal(clean, { dir, c });
  if (ARK_PROFILES[provider]) {
    const conf = arkConfOf(c, provider);
    return generateImageArk(clean, { dir, c, conf, provider: ARK_PROFILES[provider] === 'seedreamPro' ? 'seedream-pro' : 'seedream' });
  }
  return generateImageQwen(clean, { dir, c });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 生成一段视频，返回 { path, file, cached, ms, provider, model, duration }。
 * 时长：正常走 c.duration（2~30 秒，接口限制），测试模式固定 2 秒再本地剪短。
 * provider='wan'（百炼 wan3.0-video-prime）| 'seedance'（火山方舟 seedance 2.0 mini）。
 * 两家都是异步任务：提交 → 轮询 → 下载。相同 prompt+参数命中缓存（视频很贵，缓存很重要）。
 * cfg.allowSpend === false 时不许提交新任务（每日额度保护）。
 */
export async function generateVideo(prompt, { dir, cfg = {} } = {}) {
  const c = { ...DEFAULT_VIDEO, ...(cfg ?? {}) };
  if (!c.enabled) throw new Error('视频生成未启用（config.json 的 socialV2.video.enabled）');
  const clean = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('prompt 为空');
  if (clean.length > 500) throw new Error(`prompt 太长（${clean.length} 字），上限 500`);

  const provider = String(c.provider || 'wan').toLowerCase();
  const seedanceConf = { ...DEFAULT_VIDEO.seedance, ...(c.seedance ?? {}) };
  if (provider === 'seedance' || provider === 'ark') {
    // 已搁置：不要因为用户一句话就悄悄扣火山的钱
    throw new Error('seedance 后端已搁置（模型未开通）。当前只用百炼：/video model wan');
  }
  const wanModels = { ...DEFAULT_VIDEO.models, ...(c.models ?? {}) };
  const model = provider === 'wan-prime'
    ? String(wanModels.wanPrime || 'wan3.0-video-prime')
    : String(wanModels.wan || c.model || 'wan3.0-video');
  ensureDir(dir);

  // 时长：正常 2~30 秒（由配置/控制台决定，最长 30）；测试模式**生成 2 秒**（接口下限）→ 发送前再剪成 0.5 秒
  const isTest = c.testMode === true && c.test?.enabled !== false;
  const [rangeMin, rangeMax] = Array.isArray(c.durationRange) ? c.durationRange : [2, 30];
  const rawDuration = Number(c.duration);
  const duration = isTest
    ? Math.max(2, Math.min(30, Number(c.test?.duration) || 2))
    : Math.max(Number(rangeMin), Math.min(Number(rangeMax), Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 4));
  const size = String((isTest ? c.test?.size : c.size) || '854*480');

  const tag = hashOf(['video', provider, model, clean, size, duration]);
  const out = path.join(dir, `video-${tag}.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 50000) {
    return { path: out, file: path.basename(out), cached: true, ms: 0, provider, model, duration, size, test: isTest };
  }
  if (c.allowSpend === false) {
    const used = Number(c.quotaUsed) || 0;
    const limit = Number(c.maxPerDay) || 0;
    throw new Error(`今天的视频额度用完了（${used}/${limit}），明天再生成；管理员可发 /video limit <数字> 调高上限`);
  }

  // 只此一次：提交一个任务，失败就抛错，绝不换尺寸/换参数再提交第二个
  return generateVideoWan(clean, { dir, c, out, duration, model, size, provider: provider === 'wan-prime' ? 'wan-prime' : 'wan', test: isTest });
}

/** 火山方舟 Seedance：POST /contents/generations/tasks → 轮询同一路径/<id> → content.video_url。 */
async function generateVideoSeedance(clean, { dir, c, conf, out, duration, model }) {
  const envName = String(conf.envVar || 'ARK_API_KEY');
  let apiKey = String(process.env[envName] ?? '').trim();
  if (!apiKey) {
    const rel = String(conf.apiKeyFile || 'state/ark-key.txt');
    const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (fs.existsSync(file)) apiKey = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  }
  if (!apiKey) throw new Error(`seedance 需要火山方舟 API Key：写进 ${conf.apiKeyFile || 'state/ark-key.txt'} 或设环境变量 ${envName}`);

  const baseUrl = String(conf.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const timeoutMs = Math.max(60000, Number(c.timeoutMs) || 900000);
  const pollMs = Math.max(2000, Number(c.pollMs) || 8000);
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;

  const payload = {
    model,
    content: [{ type: 'text', text: clean }],
    ratio: String(conf.ratio || '16:9'),
    duration,
    ...(conf.resolution ? { resolution: String(conf.resolution) } : {}),
    ...(c.watermark === true ? { watermark: true } : {})
  };

  let resp;
  try {
    resp = await fetch(`${baseUrl}/contents/generations/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000)
    });
  } catch (error) {
    throw new Error(`seedance 任务提交失败：${error?.message ?? error}`);
  }
  const submitText = await resp.text();
  if (!resp.ok) {
    // ModelNotOpen = 该账号还没在火山方舟控制台开通这个模型（不是代码问题）
    if (/ModelNotOpen/i.test(submitText)) {
      throw new Error(`seedance 模型未开通：${model}。请到火山方舟控制台「开通管理」里激活该模型后再试。原始响应：${submitText.slice(0, 200)}`);
    }
    throw new Error(`seedance 任务提交失败 HTTP ${resp.status}：${submitText.slice(0, 300)}`);
  }
  let submitJson;
  try { submitJson = JSON.parse(submitText); } catch { throw new Error(`seedance 提交返回不是 JSON：${submitText.slice(0, 200)}`); }
  const taskId = String(submitJson?.id ?? '');
  if (!taskId) throw new Error(`seedance 没拿到任务 id：${submitText.slice(0, 300)}`);

  let videoUrl = '';
  let lastStatus = '';
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let pollResp;
    try {
      pollResp = await fetch(`${baseUrl}/contents/generations/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30000)
      });
    } catch { continue; }
    const pollText = await pollResp.text();
    let pollJson;
    try { pollJson = JSON.parse(pollText); } catch { continue; }
    lastStatus = String(pollJson?.status ?? '');
    if (/succeed/i.test(lastStatus)) { videoUrl = String(pollJson?.content?.video_url ?? pollJson?.video_url ?? ''); break; }
    if (/fail|cancel/i.test(lastStatus)) {
      throw new Error(`seedance 生成失败（${lastStatus}）：${JSON.stringify(pollJson?.error ?? pollJson).slice(0, 300)}`);
    }
  }
  if (!videoUrl) throw new Error(`seedance 生成超时（${Math.round((Date.now() - t0) / 1000)}s，最后状态 ${lastStatus || '未知'}，task ${taskId}）`);

  const binResp = await fetch(videoUrl, { signal: AbortSignal.timeout(180000) });
  if (!binResp.ok) throw new Error(`seedance 视频下载失败 HTTP ${binResp.status}`);
  const bin = Buffer.from(await binResp.arrayBuffer());
  if (bin.length < 50000) throw new Error(`seedance 视频文件异常（${bin.length} 字节）`);
  fs.writeFileSync(out, bin);
  return { path: out, file: path.basename(out), cached: false, ms: Date.now() - t0, provider: 'seedance', model, duration, taskId, bytes: bin.length };
}

/** 阿里云百炼 wan：POST 提交（带 X-DashScope-Async）→ /api/v1/tasks 轮询 → video_url。 */
async function generateVideoWan(clean, { dir, c, out, duration, model, size, provider = 'wan', test = false }) {
  const apiKey = resolveDrawApiKey(c);   // 与语音/画图共用一把百炼 key
  const timeoutMs = Math.max(60000, Number(c.timeoutMs) || 900000);
  const pollMs = Math.max(2000, Number(c.pollMs) || 8000);
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;

  // 1) 提交任务 —— 只提交一次。失败就是失败，不换尺寸/不换参数重试（重试=重复扣费）。
  let resp;
  try {
    resp = await fetch(DASHSCOPE_VIDEO_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable'
      },
      body: JSON.stringify({ model: String(model), input: { prompt: clean }, parameters: { size, duration } }),
      signal: AbortSignal.timeout(60000)
    });
  } catch (error) {
    throw new Error(`视频任务提交失败：${error?.message ?? error}`);
  }
  const submitText = await resp.text();
  if (!resp.ok) throw new Error(`视频任务提交失败 HTTP ${resp.status}：${submitText.slice(0, 300)}`);
  let submitJson;
  try { submitJson = JSON.parse(submitText); } catch { throw new Error(`提交返回不是 JSON：${submitText.slice(0, 200)}`); }
  const taskId = String(submitJson?.output?.task_id ?? '');
  if (!taskId) throw new Error(`没拿到 task_id：${submitText.slice(0, 300)}`);

  // 2) 轮询
  let videoUrl = '';
  let lastStatus = '';
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let pollResp;
    try {
      pollResp = await fetch(`${DASHSCOPE_TASK_API}/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30000) });
    } catch {
      continue;   // 网络抖动就下一轮
    }
    const pollText = await pollResp.text();
    let pollJson;
    try { pollJson = JSON.parse(pollText); } catch { continue; }
    const o = pollJson?.output ?? {};
    lastStatus = String(o.task_status ?? '');
    if (lastStatus === 'SUCCEEDED') { videoUrl = String(o.video_url ?? ''); break; }
    if (lastStatus === 'FAILED' || lastStatus === 'CANCELED') {
      throw new Error(`视频生成失败（${lastStatus}）：${JSON.stringify(o).slice(0, 300)}`);
    }
  }
  if (!videoUrl) throw new Error(`视频生成超时（${Math.round((Date.now() - t0) / 1000)}s，最后状态 ${lastStatus || '未知'}，task ${taskId}）`);

  // 3) 下载落盘
  const binResp = await fetch(videoUrl, { signal: AbortSignal.timeout(180000) });
  if (!binResp.ok) throw new Error(`视频下载失败 HTTP ${binResp.status}`);
  const bin = Buffer.from(await binResp.arrayBuffer());
  if (bin.length < 50000) throw new Error(`视频文件异常（${bin.length} 字节）`);
  fs.writeFileSync(out, bin);

  return { path: out, file: path.basename(out), cached: false, ms: Date.now() - t0, provider, model, duration, size, test, taskId, bytes: bin.length };
}

/**
 * 把 mp4 剪成前 N 秒（本地 ffmpeg，免费）。
 * 为什么需要：百炼视频接口 duration ∈ [2,30]，做不出 0.5 秒的片子；
 * 所以「0.5 秒测试片」是先生成 2 秒，再用这里剪短。
 */
export async function trimVideo(inputPath, seconds, { cfg = {} } = {}) {
  const c = { ...DEFAULT_VIDEO, ...(cfg ?? {}) };
  const src = String(inputPath ?? '');
  if (!src || !fs.existsSync(src)) throw new Error(`要剪的视频不存在：${src}`);
  const secs = Math.max(0.2, Math.min(30, Number(seconds) || 0.5));
  const out = src.replace(/\.mp4$/i, `-${String(secs).replace('.', 'p')}s.mp4`);
  // 先尝试无重编码（快）；关键帧导致时长不精确时再重编码一次
  const tries = [
    ['-y', '-loglevel', 'error', '-i', src, '-t', String(secs), '-c', 'copy', out],
    ['-y', '-loglevel', 'error', '-i', src, '-t', String(secs), '-an', '-c:v', 'libx264', '-preset', 'veryfast', out]
  ];
  let lastErr = '';
  for (const args of tries) {
    try {
      const r = await run(c.ffmpegPath || 'ffmpeg', args, { timeoutMs: 120000 });
      if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1000) {
        return { path: out, file: path.basename(out), bytes: fs.statSync(out).size };
      }
      lastErr = (r.stderr || '').slice(-200);
    } catch (error) {
      lastErr = String(error?.message ?? error);
    }
  }
  throw new Error(`视频剪辑失败：${lastErr.slice(0, 200)}`);
}

/** 把几句歌词念成"带调"的 mp3：逐句 TTS，再按五声音阶移调，最后拼接。 */
export async function singLyrics(text, { dir, cfg = {} } = {}) {
  const c = { ...DEFAULT_SING, ...(cfg ?? {}) };
  if (!c.enabled) throw new Error('唱歌未启用（config.json 的 socialV2.sing.enabled）');
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('歌词为空');
  if (raw.length > c.maxChars) throw new Error(`歌词太长（${raw.length} 字），上限 ${c.maxChars}`);

  const lines = raw
    .split(/[\n\r，。！？；、,.!?;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, c.maxLines);
  if (!lines.length) throw new Error('歌词里没有可分句的内容');

  ensureDir(dir);
  const tag = hashOf([raw, c.voice, (c.melody || []).join(',')]);
  const out = path.join(dir, `sing-${tag}.mp3`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) {
    return { path: out, file: path.basename(out), cached: true, lines: lines.length, ms: 0 };
  }

  const tmpDir = path.join(dir, `.sing-${tag}`);
  ensureDir(tmpDir);
  const melody = Array.isArray(c.melody) && c.melody.length ? c.melody : DEFAULT_SING.melody;
  const pieces = [];
  const t0 = Date.now();

  try {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const rawMp3 = path.join(tmpDir, `${String(i).padStart(2, '0')}-raw.mp3`);
      const tts = await run(c.pythonPath || 'python', [
        '-m', 'edge_tts', '-t', line, '-v', String(c.voice),
        '--rate=+0%', '--volume=+0%', '--write-media', rawMp3
      ], { timeoutMs: c.timeoutMs });
      if (tts.code !== 0 || !fs.existsSync(rawMp3) || fs.statSync(rawMp3).size < 500) {
        throw new Error(`第 ${i + 1} 句合成失败：${(tts.stderr || '').slice(0, 200)}`);
      }

      const semitone = Number(melody[i % melody.length]) || 0;
      const ratio = Math.pow(2, semitone / 12);
      const shifted = path.join(tmpDir, `${String(i).padStart(2, '0')}-pitch.mp3`);
      // 让"念"更接近"唱"：
      //   asetrate/atempo  移调到旋律音高（保持时长）
      //   vibrato          5.6Hz ±35 音分的颤音（真人唱歌的核心特征）
      //   aecho            一点房间混响，去掉 TTS 的干涩感
      //   loudnorm 前先压一点动态，再统一音量
      const filter = [
        `asetrate=24000*${ratio.toFixed(4)}`,
        'aresample=24000',
        `atempo=${(1 / ratio).toFixed(4)}`,
        'vibrato=f=5.6:d=0.35',
        'aecho=0.6:0.5:60|120:0.25|0.15',
        'acompressor=threshold=-18dB:ratio=3:attack=8:release=120'
      ].join(',');
      const shift = await run(c.ffmpegPath || 'ffmpeg', [
        '-y', '-loglevel', 'error', '-i', rawMp3, '-af', filter,
        '-ac', '1', '-ar', '24000', '-b:a', '64k', shifted
      ], { timeoutMs: 60000 });
      pieces.push(shift.code === 0 && fs.existsSync(shifted) ? shifted : rawMp3);
    }

    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, pieces.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
    const joined = path.join(tmpDir, 'joined.mp3');
    const concat = await run(c.ffmpegPath || 'ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-ac', '1', '-ar', '24000', '-b:a', '64k', joined
    ], { timeoutMs: 120000 });
    if (concat.code !== 0 || !fs.existsSync(joined) || fs.statSync(joined).size < 1000) {
      throw new Error(`拼接失败：${(concat.stderr || '').slice(0, 200)}`);
    }

    // 整体后处理：加一层 +7 半音的弱和声把声音"撑厚"，再统一响度、淡入淡出。
    const harmony = path.join(tmpDir, 'harmony.mp3');
    const hRatio = Math.pow(2, 7 / 12);
    const h = await run(c.ffmpegPath || 'ffmpeg', [
      '-y', '-loglevel', 'error', '-i', joined,
      '-af', `asetrate=24000*${hRatio.toFixed(4)},aresample=24000,atempo=${(1 / hRatio).toFixed(4)},volume=0.28`,
      '-ac', '1', '-ar', '24000', '-b:a', '64k', harmony
    ], { timeoutMs: 60000 });

    const mixArgs = (h.code === 0 && fs.existsSync(harmony))
      ? ['-i', joined, '-i', harmony, '-filter_complex',
         '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.15',
         '-ac', '1', '-ar', '24000', '-b:a', '96k', out]
      : ['-i', joined, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.15', '-ac', '1', '-ar', '24000', '-b:a', '96k', out];
    const mix = await run(c.ffmpegPath || 'ffmpeg', ['-y', '-loglevel', 'error', ...mixArgs], { timeoutMs: 120000 });
    if (mix.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 1000) {
      // 后处理失败就退回拼接结果，别让整条链路白跑
      if (fs.existsSync(joined)) fs.copyFileSync(joined, out);
      else throw new Error(`混音失败：${(mix.stderr || '').slice(0, 200)}`);
    }
    return { path: out, file: path.basename(out), cached: false, lines: lines.length, ms: Date.now() - t0 };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── AI 翻唱（真·换嗓）────────────────────────────────────────────────
// 走 Hugging Face 上 Seed-VC 官方 Space 的免费 GPU，把一首歌的人声换成当前 TTS 音色。
// 本机没有 N 卡，CPU 跑 Seed-VC 要几十分钟；Space 上 10 秒音频约 15 秒出结果。
export const DEFAULT_COVER = {
  enabled: false,
  pythonPath: 'python',
  scriptPath: 'cover.py',
  seconds: 30,        // 只处理前 N 秒（Space 有排队，太长会等很久）
  start: 0,           // 从第几秒开始；0 = 自动跳过前奏
  separate: true,     // 先用 demucs 分离人声/伴奏，再只转人声（效果明显更好）
  steps: 20,          // 扩散步数，越小越快
  instVol: 2.16,      // 混音时伴奏的音量倍数（人声固定 1.0）
  cfgRate: 0.7,
  timeoutMs: 900000,  // 整条链路（下载 + 转换）上限 15 分钟
  proxy: '',          // 例 http://127.0.0.1:7897（本机 Python 的 TLS 会间歇性被掐，走代理更稳）
  maxPerHour: 10
};

/** 把 source（本地文件或 URL）的歌声换成当前音色，返回 { path, file, ms }。 */
export async function singCover(source, { dir, root, cfg = {} } = {}) {
  const c = { ...DEFAULT_COVER, ...(cfg ?? {}) };
  if (c.enabled === false) throw new Error('AI 翻唱未启用（config.socialV2.cover.enabled）');
  const src = String(source ?? '').trim();
  if (!src) throw new Error('source 为空（本地路径或 URL）');
  if (!/^(https?:\/\/|\w:)/i.test(src) && !src.startsWith('/')) throw new Error('source 必须是 http(s) URL 或绝对路径');

  const script = path.isAbsolute(c.scriptPath) ? c.scriptPath : path.join(root || process.cwd(), c.scriptPath);
  if (!fs.existsSync(script)) throw new Error(`找不到 cover.py：${script}`);

  ensureDir(dir);
  const tag = hashOf([src, c.seconds, c.steps, c.voice || '', c.reference || '']);
  const out = path.join(dir, `cover-${tag}.mp3`);
  if (fs.existsSync(out) && fs.statSync(out).size > 20000) {
    return { path: out, file: path.basename(out), cached: true, ms: 0 };
  }

  const args = [script, '--source', src, '--out', out,
    '--seconds', String(c.seconds), '--steps', String(c.steps), '--cfg-rate', String(c.cfgRate)];
  if (c.reference && fs.existsSync(c.reference)) args.push('--reference', c.reference);
  if (Number(c.start) > 0) args.push('--start', String(Number(c.start)));
  if (Number(c.instVol) > 0) args.push('--inst-vol', String(Number(c.instVol)));
  if (c.separate === false) args.push('--no-separate');
  const t0 = Date.now();
  const env = { ...process.env };
  if (c.proxy) env.COVER_PROXY = String(c.proxy);
  const r = await run(c.pythonPath || 'python', args, { timeoutMs: c.timeoutMs, cwd: root || process.cwd(), env });
  const ms = Date.now() - t0;
  if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 20000) {
    throw new Error(`翻唱失败（退出码 ${r.code}）：${(r.stderr || r.stdout || '').slice(-300)}`);
  }
  return { path: out, file: path.basename(out), cached: false, ms };
}
// ── 说话也用翻唱音色 ─────────────────────────────────────────────────
// edge-tts 合成 → Seed-VC 换成 audio/voices/<voice>.wav 的音色 → mp3。
// Seed-VC 不可用时退回「按音高差移调」，至少音区一致（speak_voice.py 里处理）。
export const DEFAULT_SPEAK = {
  enabled: false,
  pythonPath: 'python',
  scriptPath: 'speak_voice.py',
  voice: 'v2',
  steps: 16,
  timeoutMs: 600000,
  proxy: ''
};

export async function speakAsCoverVoice(text, { dir, root, cfg = {} } = {}) {
  const c = { ...DEFAULT_SPEAK, ...(cfg ?? {}) };
  if (c.enabled === false) throw new Error('说话换嗓未启用（config.socialV2.voice.coverVoice）');
  const t = String(text ?? '').trim();
  if (!t) throw new Error('text 为空');
  if (t.length > 200) throw new Error(`text 太长（${t.length}），上限 200`);

  const script = path.isAbsolute(c.scriptPath) ? c.scriptPath : path.join(root || process.cwd(), c.scriptPath);
  if (!fs.existsSync(script)) throw new Error(`找不到 speak_voice.py：${script}`);

  ensureDir(dir);
  const tag = hashOf([t, c.voice, c.steps]);
  const out = path.join(dir, `say-${tag}.mp3`);
  if (fs.existsSync(out) && fs.statSync(out).size > 3000) {
    return { path: out, file: path.basename(out), cached: true, ms: 0 };
  }

  const env = { ...process.env };
  if (c.proxy) env.COVER_PROXY = String(c.proxy);
  const t0 = Date.now();
  const r = await run(c.pythonPath || 'python', [script, '--text', t, '--out', out, '--voice', String(c.voice), '--steps', String(c.steps)], {
    timeoutMs: c.timeoutMs,
    cwd: root || process.cwd(),
    env
  });
  const ms = Date.now() - t0;
  if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 3000) {
    throw new Error(`说话换嗓失败（退出码 ${r.code}）：${(r.stderr || r.stdout || '').slice(-300)}`);
  }
  return { path: out, file: path.basename(out), cached: false, ms };
}
// ── 百炼复刻音色说话（首选链路，1~2 秒）──────────────────────────────
// 用阿里云 qwen-audio-3.0-tts-flash + 复刻 voice_id，支持语气指令。
// 失败时由调用方降级到 Seed-VC 或 edge-tts。
export const DEFAULT_ALIYUN = {
  enabled: false,
  pythonPath: 'python',
  scriptPath: 'aliyun_tts.py',
  tone: '',
  timeoutMs: 120000
};

export async function speakWithAliyun(text, { dir, root, cfg = {}, tone = '' } = {}) {
  const c = { ...DEFAULT_ALIYUN, ...(cfg ?? {}) };
  if (c.enabled === false) throw new Error('百炼语音未启用（config.socialV2.voice.aliyun.enabled）');
  const t = String(text ?? '').trim();
  if (!t) throw new Error('text 为空');
  if (t.length > 200) throw new Error(`text 太长（${t.length}），上限 200`);

  const script = path.isAbsolute(c.scriptPath) ? c.scriptPath : path.join(root || process.cwd(), c.scriptPath);
  if (!fs.existsSync(script)) throw new Error(`找不到 aliyun_tts.py：${script}`);

  ensureDir(dir);
  const useTone = String(tone || c.tone || '');
  const tag = hashOf([t, useTone, 'aliyun']);
  const out = path.join(dir, `bl-${tag}.mp3`);
  if (fs.existsSync(out) && fs.statSync(out).size > 3000) {
    return { path: out, file: path.basename(out), cached: true, ms: 0 };
  }

  const args = [script, '--text', t, '--out', out];
  if (useTone) args.push('--tone', useTone);
  const t0 = Date.now();
  const r = await run(c.pythonPath || 'python', args, { timeoutMs: c.timeoutMs, cwd: root || process.cwd() });
  const ms = Date.now() - t0;
  if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 3000) {
    throw new Error(`百炼合成失败（退出码 ${r.code}）：${(r.stderr || r.stdout || '').slice(-300)}`);
  }
  return { path: out, file: path.basename(out), cached: false, ms };
}
// ── 用复刻音色唱（百炼 + 自建旋律）──────────────────────────────────
export const DEFAULT_SING_ALIYUN = {
  enabled: false,
  pythonPath: 'python',
  scriptPath: 'sing_aliyun.py',
  tune: 'star',
  noteSec: 0.42,
  timeoutMs: 300000
};

export async function singWithAliyun(text, { dir, root, cfg = {}, tune = '' } = {}) {
  const c = { ...DEFAULT_SING_ALIYUN, ...(cfg ?? {}) };
  if (c.enabled === false) throw new Error('百炼唱歌未启用');
  const t = String(text ?? '').trim();
  if (!t) throw new Error('text 为空');
  if (t.length > 40) throw new Error(`歌词太长（${t.length}），上限 40 字`);

  const script = path.isAbsolute(c.scriptPath) ? c.scriptPath : path.join(root || process.cwd(), c.scriptPath);
  if (!fs.existsSync(script)) throw new Error(`找不到 sing_aliyun.py：${script}`);

  ensureDir(dir);
  const useTune = String(tune || c.tune || 'star');
  const tag = hashOf([t, useTune, c.noteSec, 'aliyun-sing']);
  const out = path.join(dir, `sbl-${tag}.mp3`);
  if (fs.existsSync(out) && fs.statSync(out).size > 5000) {
    return { path: out, file: path.basename(out), cached: true, ms: 0 };
  }

  const t0 = Date.now();
  const r = await run(c.pythonPath || 'python',
    [script, '--text', t, '--out', out, '--tune', useTune, '--note-sec', String(c.noteSec)],
    { timeoutMs: c.timeoutMs, cwd: root || process.cwd() });
  const ms = Date.now() - t0;
  if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 5000) {
    throw new Error(`百炼唱歌失败（退出码 ${r.code}）：${(r.stderr || r.stdout || '').slice(-300)}`);
  }
  return { path: out, file: path.basename(out), cached: false, ms };
}