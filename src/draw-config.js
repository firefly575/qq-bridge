// 画图的运行期设置 + 每日额度（都能在 QQ 里用 /draw 改，改完立即生效，不用重启）。
//
// 三层取值优先级：QQ 指令写的 state/draw-settings.json  >  config.json 的 socialV2.draw  >  这里的兜底默认。
// 单独成模块是为了能脱离桥接进程做单元测试（桥接里的逻辑都在 main() 闭包里，测不到）。
import fs from 'node:fs';
import path from 'node:path';

/** 分辨率档位：qwen-image 用 `*` 连接，火山方舟 seedream 用 `x` 连接。 */
export const RESOLUTIONS = {
  '720p': { key: '720p', label: '720P', size: '1280*720', seedreamSize: '1280x720', width: 1280, height: 720 },
  '1080p': { key: '1080p', label: '1080P', size: '1920*1080', seedreamSize: '1920x1080', width: 1920, height: 1080 }
};
export const DEFAULT_RESOLUTION = '1080p';

export const DEFAULT_SETTINGS = { resolution: '', provider: '', maxPerDay: null };

/** 认各种写法：720 / 720P / 720p / 1080 / 1080P / fhd。认不出来返回空串。 */
export function normalizeResolution(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return '';
  if (['720', '720p', '标清', '高清'].includes(s)) return '720p';
  if (['1080', '1080p', '1080p高清', '全高清', 'fhd'].includes(s)) return '1080p';
  return '';
}

export function resolutionInfo(input) {
  const key = normalizeResolution(input) || DEFAULT_RESOLUTION;
  return RESOLUTIONS[key];
}

export function readSettings(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(file, patch) {
  const next = { ...readSettings(file), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/** 本地时区的 YYYY-MM-DD（额度按自然日归零）。 */
export function dayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function readUsage(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { date: String(raw?.date ?? ''), count: Math.max(0, Number(raw?.count) || 0) };
  } catch {
    return { date: '', count: 0 };
  }
}

/** 当前额度状态。跨天自动按 0 算（不写盘，写盘发生在真正生成时）。 */
export function quotaState({ usageFile, limit, now = Date.now() }) {
  const today = dayKey(now);
  const usage = readUsage(usageFile);
  const used = usage.date === today ? usage.count : 0;
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
  const remaining = safeLimit > 0 ? Math.max(0, safeLimit - used) : Infinity;
  return { date: today, used, limit: safeLimit, remaining, exhausted: safeLimit > 0 && used >= safeLimit };
}

/** 记账：真正花钱生成成功后调用一次（缓存命中不调用）。 */
export function noteGeneration(usageFile, now = Date.now()) {
  const today = dayKey(now);
  const usage = readUsage(usageFile);
  const count = (usage.date === today ? usage.count : 0) + 1;
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  const tmp = `${usageFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ date: today, count }, null, 2), 'utf8');
  fs.renameSync(tmp, usageFile);
  return { date: today, count };
}
