#!/usr/bin/env node
/**
 * 构建记忆星图（memory-starmap）
 *
 * 用法：
 *   node scripts/build-starmap.mjs --ns private:123456
 *   node scripts/build-starmap.mjs --ns group:g1
 *   node scripts/build-starmap.mjs --all
 *
 * 数据来源（桥接本地状态，不碰 DSH 会话）：
 *   - state/social-v2.json 里各会话的 recentMessages → kind=msg（day 取消息时间）
 *   - activeTopics / pendingThoughts / memberImpressions → kind=topic|thought|impression
 * 产物：
 *   state/starmap/<dir>/memories.jsonl + sources.json + starmap.json + starmap.js
 * 前端资源直接从 vendor/memory-starmap/web 提供（桥接静态路由）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const VENDOR = path.join(ROOT, 'vendor', 'memory-starmap');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function memoryGroups() {
  const raw = readJson(path.join(STATE, 'memory-groups.json'), { groups: [] });
  return Array.isArray(raw.groups) ? raw.groups : [];
}

function nsMembers(ns) {
  const m = /^group:(.+)$/.exec(ns);
  if (!m) return [ns];
  const g = memoryGroups().find((x) => String(x.id) === m[1]);
  return g && Array.isArray(g.members) ? [...new Set(g.members.map(String))] : [];
}

function nsDirName(ns) {
  return String(ns).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function dayOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 收集某个 ns 的记忆条目 */
function collectMemories(ns) {
  const social = readJson(path.join(STATE, 'social-v2.json'), { conversations: {} });
  const convs = social.conversations || {};
  const members = nsMembers(ns);
  const items = [];

  for (const key of members) {
    const st = convs[key];
    if (!st) continue;
    for (const msg of st.recentMessages || []) {
      const text = String(msg.text || msg.plain || '').trim();
      if (text.length < 6) continue;
      items.push({
        id: `${key}#${msg.seq ?? msg.messageId ?? items.length}`,
        day: dayOf(msg.time),
        text: text.slice(0, 400),
        kind: msg.isSelf ? 'reply' : 'msg',
        weight: msg.isSelf ? 0.5 : 0.6,
        evidence: `${key} @ ${dayOf(msg.time)}`
      });
    }
    for (const t of st.activeTopics || []) {
      const text = String(t?.content ?? t ?? '').trim();
      if (text) items.push({ id: `${key}#topic#${items.length}`, day: dayOf(t?.at ?? Date.now()), text, kind: 'topic', weight: 0.85, evidence: `话题 @ ${key}` });
    }
    for (const t of st.pendingThoughts || []) {
      const text = String(t?.content ?? t ?? '').trim();
      if (text) items.push({ id: `${key}#thought#${items.length}`, day: dayOf(t?.at ?? Date.now()), text, kind: 'thought', weight: 0.75, evidence: `未说出口 @ ${key}` });
    }
    for (const [name, imp] of Object.entries(st.memberImpressions || {})) {
      const text = String(imp?.content ?? imp ?? '').trim();
      if (text) items.push({ id: `${key}#imp#${name}`, day: dayOf(imp?.at ?? Date.now()), text: `${name}：${text}`, kind: 'impression', weight: 0.7, evidence: `印象 @ ${key}` });
    }
  }
  return items;
}

function buildOne(ns, { iters = 80 } = {}) {
  const dir = path.join(STATE, 'starmap', nsDirName(ns));
  fs.mkdirSync(dir, { recursive: true });
  const items = collectMemories(ns);

  const jsonl = path.join(dir, 'memories.jsonl');
  fs.writeFileSync(jsonl, items.map((it) => JSON.stringify(it)).join('\n') + (items.length ? '\n' : ''), 'utf8');

  const sources = {
    layout_url: 'http://127.0.0.1:8110/layout',
    layout_iters: iters,
    df_max: 25,
    edge_per_node: 3,
    edge_min_score: 1.2,
    sources: [{ type: 'jsonl', name: nsDirName(ns), path: jsonl.replace(/\\/g, '/') }]
  };
  const sourcesPath = path.join(dir, 'sources.json');
  fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 2), 'utf8');

  const outJson = path.join(dir, 'starmap.json');
  let log = '';
  if (items.length === 0) {
    // 没记忆也要给一份合法空图，避免前端白屏
    fs.writeFileSync(outJson, JSON.stringify({ generated_at: new Date().toISOString(), nodes: [], links: [], days: [], stats: { nodes: 0, links: 0 } }), 'utf8');
    fs.writeFileSync(path.join(dir, 'starmap.js'), 'window.__STARMAP_DATA__ = ' + fs.readFileSync(outJson, 'utf8') + ';', 'utf8');
    return { ns, dir: nsDirName(ns), items: 0, nodes: 0, links: 0, days: 0, log: '没有记忆条目，已生成空图' };
  }

  try {
    log = execFileSync('python', [path.join(VENDOR, 'src', 'build.py'), '--sources', sourcesPath, '--out', outJson], {
      cwd: VENDOR, encoding: 'utf8', timeout: 600000
    });
  } catch (error) {
    return { ns, dir: nsDirName(ns), items: items.length, error: String(error?.stderr || error?.message || error).slice(0, 800) };
  }

  const data = readJson(outJson, { nodes: [], links: [], days: [] });
  return {
    ns,
    dir: nsDirName(ns),
    items: items.length,
    nodes: data.nodes?.length ?? 0,
    links: data.links?.length ?? 0,
    days: data.days?.length ?? 0,
    layoutBy: data.layout_by,
    log: String(log).trim().split('\n').slice(-2).join(' | ')
  };
}

// ── CLI ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const all = argv.includes('--all');
const nsArg = arg('--ns');

if (all) {
  const social = readJson(path.join(STATE, 'social-v2.json'), { conversations: {} });
  const keys = Object.keys(social.conversations || {});
  const groups = memoryGroups().map((g) => `group:${g.id}`);
  const targets = [...new Set([...keys, ...groups])];
  const results = targets.map((ns) => buildOne(ns));
  console.log(JSON.stringify({ ok: results.every((r) => !r.error), results }, null, 2));
} else if (nsArg) {
  const result = buildOne(nsArg);
  console.log(JSON.stringify(result, null, 2));
  if (result.error) process.exitCode = 1;
} else {
  console.error('用法：node scripts/build-starmap.mjs --ns <private:123|group:g1> | --all');
  process.exitCode = 2;
}
