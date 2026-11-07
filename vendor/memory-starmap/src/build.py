#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Memory StarMap · 数据构建器（通用版）

职责：把「一堆带日期的文本记忆」构建成一份 3D 布局好的 starmap.json。

输入（三选一，按 examples/ 下的适配器给）：
    1. SQLite：任意库 + 一条 SQL，只要能取到 (id, day, text, [kind], [weight], [evidence])
    2. JSONL：每行一条 {"id":.., "day":"YYYY-MM-DD", "text":"..", "kind":"fact"}
    3. 纯目录：按 docs/ingest.md 的目录约定自动扫描

产出 schema（前端只认这份，见 docs/schema.md）：
    {
      "generated_at": "...", "build_seconds": 1.2, "layout_by": "remote",
      "nodes": [{"i":0,"t":"fact","day":"2026-11-01","text":"…","full":"…",
                 "ev":"…","w":0.6,"p":[x,y,z],"key":"src:1"}],
      "links": [[a, b, weight], ...],   // a < b，weight 0~1
      "days":  [{"day":"2026-11-01","p":[x,y,z],"n":42}],
      "stats": {"nodes":..,"links":..,"days":..}
    }

连边只用三条真实关系，不做随机连边：
    1) 语义/词面共现：两条记忆共享同一批「稀有词」（df 在 2..25 之间的词才保留）
    2) 证据链：A 条目自带的 evidence 原文能在同日的 B 原文里命中 → 强边
    3) 显式引用：数据源自带 parent_id / ref 字段时直接取（可选）

用法：
    python3 build.py --sources sources.json --out web/starmap.json
    python3 build.py --demo               # 用内置演示数据，零依赖跑通
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

# ---------------------------------------------------------------------------
# 默认参数，全部可被 sources.json 覆盖
# ---------------------------------------------------------------------------
DEFAULTS = {
    # 布局服务地址；不通会自动降级到本机算法
    "layout_url": os.environ.get("STARMAP_LAYOUT_URL", "http://127.0.0.1:8110/layout"),
    "layout_timeout": float(os.environ.get("STARMAP_LAYOUT_TIMEOUT", "150")),
    "layout_iters": int(os.environ.get("STARMAP_LAYOUT_ITERS", "80")),
    # 强制本机算（调试用）
    "force_local": os.environ.get("STARMAP_LOCAL_LAYOUT", "") in {"1", "true", "yes"},
    # 词面共现阈值
    "df_min": 2,          # 少于这个数不过滤（词只出现在 1 条里，没有共现可能）
    "df_max": 25,         # 超过这个数说明是口水词，区分度太差
    "edge_per_node": 3,   # 每个节点最多保留几根最强边，防毛线团
    "edge_min_score": 1.2,
    # 文本长度闸门
    "min_len": 20,        # 短于此丢弃（寒暄、状态字）
    "text_max": 400,      # 卡片显示
    "full_max": 2000,     # 详情页
}

# 噪音清洗：定时任务壳、系统提示壳、URL、图片描述壳、引用块
NOISE = [
    re.compile(r"\[CronJob\][^:：]*[:：]?"),
    re.compile(r"<system_reminder>.*?</system_reminder>", re.S),
    re.compile(r"<image_caption>.*?</image_caption>", re.S),
    re.compile(r"<Quoted Message>.*?</Quoted Message>", re.S),
    re.compile(r"\[压缩备忘[^\]]*\]"),
    re.compile(r"https?://\S+"),
    re.compile(r"\[图[:：][^\]]*\]"),
    re.compile(r"\[\d{4}-\d{2}-\d{2}[^\]]*\]"),
]

# 停用词：共现连边没有信息量的高频词。按自己的语料调，别照抄。
STOP: set[str] = {
    "现在", "可以", "这个", "那个", "什么", "怎么", "自己", "已经",
    "没有", "还是", "就是", "如果", "因为", "所以", "但是", "然后", "今天", "明天",
    "时候", "一下", "一个", "东西", "问题", "看看", "觉得", "应该", "需要", "不是",
    "我们", "你们", "他们", "这样", "那样", "知道", "开始", "完成", "确认", "处理",
    "用户", "消息", "任务", "结果", "内容", "情况", "部分", "方式", "功能", "文件",
}

# 英文技术词整词留，中文最长 6 字连续片段（后续再切二字滑窗）
TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.\-]{2,}|[\u4e00-\u9fff]{2,6}")
DAY_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")

DAY_COLOR_KIND = ("fact", "lesson", "preference", "msg", "doc")


# ---------------------------------------------------------------------------
# 1. 装载数据源
# ---------------------------------------------------------------------------
def clean(text: str) -> str:
    out = text or ""
    for pat in NOISE:
        out = pat.sub(" ", out)
    return re.sub(r"\s+", " ", out).strip()


def norm_day(value) -> str:
    """任意日期表示 → YYYY-MM-DD；认不出返回空串（该条会被丢掉）。"""
    s = str(value or "")
    m = DAY_RE.match(s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    # 支持 2026/11/01、20261101、unix 时间戳
    s2 = re.sub(r"[./]", "-", s)
    m = DAY_RE.match(s2)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    if s.isdigit() and len(s) == 8:
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    if s.isdigit() and len(s) >= 10:
        try:
            return time.strftime("%Y-%m-%d", time.localtime(int(s[:10])))
        except (OverflowError, OSError, ValueError):
            return ""
    return ""


def _mk(rid, day, text, kind="fact", weight=0.6, evidence="", src="", role="") -> dict | None:
    body = clean(text)
    if len(body) < DEFAULTS["min_len"]:
        return None
    return {
        "t": kind if kind in DAY_COLOR_KIND else "fact",
        "day": day,
        "text": body[: DEFAULTS["text_max"]],
        "full": body[: DEFAULTS["full_max"]],
        "ev": clean(evidence)[:300],
        "w": float(weight or 0.6),
        "src": src or "ext",
        "key": f"{src or 'ext'}:{rid}",
        "role": role,
    }


def load_sqlite(spec: dict, out: list[dict], stats: dict) -> None:
    """spec = {"path": "...", "sql": "select id, day, text, kind, weight",
                "name": "cold", "kind_default": "msg", "weight_default": 0.5}"""
    name = spec.get("name") or Path(spec["path"]).stem
    before = len(out)
    try:
        con = sqlite3.connect(f"file:{spec['path']}?mode=ro", uri=True, timeout=5)
        rows = con.execute(spec["sql"]).fetchall()
        con.close()
    except Exception as exc:  # noqa: BLE001
        stats[f"{name}_error"] = str(exc)
        return
    cols = [c.strip() for c in spec.get("columns", [])] or []
    for row in rows:
        rec = dict(zip(cols, row)) if cols else {
            k: row[i] for i, k in enumerate(["id", "day", "text", "kind", "weight", "evidence"]) if i < len(row)
        }
        day = norm_day(rec.get("day"))
        if not day:
            continue
        node = _mk(
            rec.get("id", len(out)),
            day,
            rec.get("text") or "",
            spec.get("kind_default") or rec.get("kind") or "fact",
            spec.get("weight_default", rec.get("weight", 0.6)),
            rec.get("evidence") or "",
            name,
            rec.get("role") or "",
        )
        if node:
            out.append(node)
    stats[name] = len(out) - before


def load_jsonl(spec: dict, out: list[dict], stats: dict) -> None:
    name = spec.get("name") or Path(spec["path"]).stem
    before = len(out)
    try:
        with open(spec["path"], encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                day = norm_day(rec.get("day") or rec.get("date"))
                if not day:
                    continue
                node = _mk(
                    rec.get("id", len(out)),
                    day,
                    rec.get("text") or rec.get("content") or "",
                    spec.get("kind_default") or rec.get("kind") or "fact",
                    rec.get("weight", spec.get("weight_default", 0.6)),
                    rec.get("evidence") or "",
                    name,
                )
                if node:
                    out.append(node)
    except OSError as exc:
        stats[f"{name}_error"] = str(exc)
    stats[name] = len(out) - before


def load_markdown_dir(spec: dict, out: list[dict], stats: dict) -> None:
    """目录约定：<dir>/YYYY-MM-DD*.md，一个文件 = 一天；一级标题或无标题的段落各成一条。"""
    name = spec.get("name") or "daybook"
    before = len(out)
    d = Path(spec["path"])
    if not d.is_dir():
        stats[f"{name}_error"] = "not a directory"
        return
    for f in sorted(d.glob("*.md")):
        day = norm_day(f.name)
        if not day:
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for idx, block in enumerate(re.split(r"^#{1,3}\s+", text, flags=re.M)):
            body = clean(re.sub(r"[*_`>|\-]{1,3}", " ", block))
            if len(body) < DEFAULTS["min_len"]:
                continue
            node = _mk(f"{f.stem}#{idx}", day, body, "doc", 0.45, "", name)
            if node:
                out.append(node)
    stats[name] = len(out) - before


LOADERS = {"sqlite": load_sqlite, "jsonl": load_jsonl, "markdown": load_markdown_dir}


def load_sources(conf: dict) -> tuple[list[dict], dict]:
    nodes: list[dict] = []
    stats: dict = {}
    for spec in conf.get("sources", []):
        fn = LOADERS.get(spec.get("type", "sqlite"))
        if not fn:
            stats[f"{spec.get('name', '?')}_error"] = "unknown type"
            continue
        fn(spec, nodes, stats)
    days = sorted({n["day"] for n in nodes})
    stats["days"] = len(days)
    stats["day_list"] = days
    return nodes, stats


# ---------------------------------------------------------------------------
# 2. 连边
# ---------------------------------------------------------------------------
def tokens(text: str) -> set[str]:
    """粗分词：英文整词 + 中文词表过滤 + 长片段切二字滑窗。

    刻意不用 jieba：这是一次性构建脚本，不想为了分词多背一个词典加载。
    中文检索质量要求高时，换成 jieba/结巴后续模型都行，接口不变。
    """
    got: set[str] = set()
    for m in TOKEN_RE.finditer(text or ""):
        w = m.group(0).lower()
        if w.isascii():
            if len(w) >= 3:
                got.add(w)
            continue
        if w in STOP:
            continue
        got.add(w)
        if len(w) >= 4:
            for i in range(len(w) - 1):
                bg = w[i : i + 2]
                if bg not in STOP:
                    got.add(bg)
    return got


def build_links(nodes: list[dict], conf: dict) -> list[list]:
    links: list[list] = []
    seen: set[tuple[int, int]] = set()

    def add(a: int, b: int, w: float) -> None:
        if a == b:
            return
        k = (a, b) if a < b else (b, a)
        if k in seen:
            return
        seen.add(k)
        links.append([k[0], k[1], round(w, 3)])

    # ---- 关系一：词面共现 ----
    toks = [tokens(n["text"]) for n in nodes]
    df: dict[str, int] = defaultdict(int)
    for ts in toks:
        for t in ts:
            df[t] += 1

    N = max(len(nodes), 1)
    df_min, df_max = conf["df_min"], conf["df_max"]
    inv: dict[str, list[int]] = defaultdict(list)
    for i, ts in enumerate(toks):
        for t in ts:
            if df_min <= df[t] <= df_max:
                inv[t].append(i)

    pair: dict[tuple[int, int], float] = defaultdict(float)
    for t, ids in inv.items():
        if len(ids) < 2:
            continue
        weight = math.log(N / df[t])          # 越稀有越有区分度
        if t.isascii():
            weight *= 1.6                      # 英文技术词更具体
        ids = ids[:df_max]
        for a_i in range(len(ids)):
            for b_i in range(a_i + 1, len(ids)):
                pair[(ids[a_i], ids[b_i])] += weight

    per_node: dict[int, list[tuple[float, int]]] = defaultdict(list)
    for (a, b), s in pair.items():
        per_node[a].append((s, b))
        per_node[b].append((s, a))
    keep: set[tuple[int, int]] = set()
    for a, lst in per_node.items():
        lst.sort(reverse=True)
        for s, b in lst[: conf["edge_per_node"]]:
            if s < conf["edge_min_score"]:
                continue
            keep.add((min(a, b), max(a, b)))
    for a, b in keep:
        add(a, b, min(1.0, pair[(a, b)] / 8.0))

    # ---- 关系二：证据链（evidence 原文能在同日其它条目里命中 → 强边）----
    cold_by_day: dict[str, list[int]] = defaultdict(list)
    for i, n in enumerate(nodes):
        if n["src"] in conf.get("evidence_target_sources", []):
            cold_by_day[n["day"]].append(i)
    for di, n in enumerate(nodes):
        if len(n["ev"]) < 20:
            continue
        probe = n["ev"][:40]
        hit = 0
        for ci in cold_by_day.get(n["day"], []):
            if probe and probe in nodes[ci]["text"]:
                add(di, ci, 1.0)
                hit += 1
                if hit >= 2:
                    break

    return links


# ---------------------------------------------------------------------------
# 3. 布局：远程优先 → 缓存 → 本机兜底
# ---------------------------------------------------------------------------
def prev_positions(out_path: Path) -> dict:
    """上一版坐标 → key 映射。用于「增量长出来」，不是每次全量重排。"""
    try:
        with open(out_path, encoding="utf-8") as f:
            prev = json.load(f)
    except (OSError, ValueError):
        return {}
    got = {}
    for nd in prev.get("nodes") or []:
        key, p = nd.get("key"), nd.get("p")
        if key and isinstance(p, list) and len(p) == 3:
            got[key] = [float(p[0]), float(p[1]), float(p[2])]
    return got


def spiral_seed(nodes: list[dict], prev: dict) -> list[list[float]]:
    """纯几何种子：老点沿用旧坐标，新点按天分层撒到斐波那契球面上。

    零迭代成本，形状也不会难看；给力导向一个不差于随机的起点。
    """
    days = sorted({n["day"] for n in nodes})
    span = max(len(days) - 1, 1)
    idx = {d: i for i, d in enumerate(days)}
    total = max(len(nodes), 1)
    golden = math.pi * (1 + 5 ** 0.5)
    out = []
    for i, n in enumerate(nodes):
        hit = prev.get(n["key"])
        if hit:
            out.append(list(hit))
            continue
        k = idx.get(n["day"], 0) / span
        ring = 45.0 + 100.0 * k                       # 越新的记忆越靠外圈
        phi = math.acos(max(-1.0, min(1.0, 1 - 2 * ((i + 0.5) / total))))
        th = golden * i
        out.append([
            ring * math.sin(phi) * math.cos(th),
            ring * math.cos(phi) * 0.55,
            ring * math.sin(phi) * math.sin(th),
        ])
    return out


def layout_remote(nodes: list[dict], links: list[list], seed: list[list[float]], conf: dict):
    """POST 布局服务；任何异常都返回 None，绝不打断构建。"""
    payload = {
        "nodes": [{"key": n["key"], "day": n["day"], "w": n["w"]} for n in nodes],
        "links": links,
        "iters": conf["layout_iters"],
        "seed": seed,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(conf["layout_url"], data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=conf["layout_timeout"]) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"[layout] 布局服务不可用（{type(exc).__name__}: {exc}）", file=sys.stderr)
        return None
    pos = data.get("pos") or data.get("positions")
    if not isinstance(pos, list) or len(pos) != len(nodes):
        print("[layout] 返回点数对不上，弃用", file=sys.stderr)
        return None
    for p in pos:
        if not isinstance(p, list) or len(p) != 3:
            print("[layout] 坐标格式不对，弃用", file=sys.stderr)
            return None
    return pos


def layout_local(nodes: list[dict], links: list[list], iters: int = 160,
                 seed: list[list[float]] | None = None) -> None:
    """numpy 3D 力导向。O(n²) 斥力分块算控内存，960 点 160 轮约 8 秒。"""
    import numpy as np

    n = len(nodes)
    if n == 0:
        return
    pos = np.zeros((n, 3), dtype=np.float64)
    if seed is not None and len(seed) == n:
        pos[:] = np.array(seed, dtype=np.float64)
    else:
        rng = np.random.default_rng(20260101)
        pos[:] = rng.normal(0, 60, size=(n, 3))

    if links:
        li = np.array([[a, b] for a, b, _ in links], dtype=np.int64)
        lw = np.array([w for _, _, w in links], dtype=np.float64)
    else:
        li = np.zeros((0, 2), dtype=np.int64)
        lw = np.zeros((0,), dtype=np.float64)

    k_rep, cutoff = 900.0, 120.0
    for it in range(iters):
        cool = 1.0 - it / iters
        disp = np.zeros_like(pos)

        block = 160
        for s in range(0, n, block):
            e = min(s + block, n)
            d = pos[s:e, None, :] - pos[None, :, :]
            d2 = np.einsum("ijk,ijk->ij", d, d) + 1e-3
            far = d2 > cutoff * cutoff
            inv2 = np.where(far, 0.0, k_rep / d2)
            dn = np.sqrt(d2)
            vec = np.where(far[..., None], 0.0, d / dn[..., None])
            disp[s:e] += (vec * inv2[..., None]).sum(axis=1)

        if li.size:
            a, b = li[:, 0], li[:, 1]
            d = pos[a] - pos[b]
            dist = np.sqrt(np.einsum("ij,ij->i", d, d)) + 1e-6
            force = (dist - 34.0) * (0.02 + 0.05 * lw)
            f = (d / dist[:, None]) * force[:, None]
            np.add.at(disp, a, -f)
            np.add.at(disp, b, f)

        disp -= pos * 0.006
        disp[:, 1] -= pos[:, 1] * 0.02
        pos += np.clip(disp, -18, 18) * cool

    pos -= pos.mean(axis=0)
    scale = np.abs(pos).max()
    if scale > 0:
        pos = pos / scale * 150.0
    for i, nd in enumerate(nodes):
        nd["p"] = [round(float(v), 2) for v in pos[i]]


def layout(nodes: list[dict], links: list[list], conf: dict, out_path: Path) -> str:
    """返回这一版走的哪一档，写进 layout_by 方便排障。"""
    if not nodes:
        return "empty"
    prev = prev_positions(out_path)
    covered = sum(1 for n in nodes if n["key"] in prev) / len(nodes)
    seed = spiral_seed(nodes, prev)

    if not conf["force_local"]:
        pos = layout_remote(nodes, links, seed, conf)
        if pos:
            for nd, p in zip(nodes, pos):
                nd["p"] = [round(float(v), 2) for v in p]
            return "remote"

    if covered >= 0.7:
        reused = 0
        for i, nd in enumerate(nodes):
            p = prev.get(nd["key"])
            if p:
                nd["p"] = [round(p[0], 2), round(p[1], 2), round(p[2], 2)]
                reused += 1
            else:
                # 缓存里有旧点但缺新按键：新点按几何种子落位，不打断增量
                nd["p"] = [round(v, 2) for v in seed[i]]
        return "cache" if reused == len(nodes) else "cache+seed"
    if covered >= 0.3:
        layout_local(nodes, links, iters=45, seed=seed)
        return "warm"
    layout_local(nodes, links, iters=160, seed=seed)
    return "local"


# ---------------------------------------------------------------------------
# 4. 组装与落盘
# ---------------------------------------------------------------------------
def build(conf: dict, out_path: Path) -> dict:
    t0 = time.time()
    nodes, stats = load_sources(conf)
    links = build_links(nodes, conf)
    layout_by = layout(nodes, links, conf, out_path)

    day_nodes = []
    for d in stats.get("day_list", []):
        members = [i for i, n in enumerate(nodes) if n["day"] == d]
        if not members:
            continue
        cx = sum(nodes[i]["p"][0] for i in members) / len(members)
        cy = sum(nodes[i]["p"][1] for i in members) / len(members)
        cz = sum(nodes[i]["p"][2] for i in members) / len(members)
        day_nodes.append({"day": d, "p": [round(cx, 2), round(cy, 2), round(cz, 2)],
                          "n": len(members)})

    stats.pop("day_list", None)
    stats.update({"nodes": len(nodes), "links": len(links)})
    if conf.get("retrieval"):
        stats["retrieval"] = conf["retrieval"]      # 检索引擎指标，可选

    return {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "build_seconds": round(time.time() - t0, 1),
        "stats": stats,
        "nodes": [
            {"i": i, "t": n["t"], "day": n["day"], "text": n["text"], "full": n["full"],
             "ev": n["ev"], "w": n["w"], "p": n["p"], "key": n["key"]}
            for i, n in enumerate(nodes)
        ],
        "days": day_nodes,
        "links": links,
        "layout_by": layout_by,
        "fingerprint": hashlib.sha1(
            "|".join(sorted(n["key"] for n in nodes)).encode()
        ).hexdigest()[:16],
    }


def write(payload: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(out_path)
    # 同目录再写一份 js 包装：页面在无 same-origin 的 iframe 里时 fetch 会被 CORS 拦，
    # <script> 不受限，前端优先读这份，取不到再退回 json。
    wrapped = out_path.with_suffix(".js")
    wrapped.write_text("window.__STARMAP_DATA__=" + out_path.read_text(encoding="utf-8") + ";",
                       encoding="utf-8")


def load_conf(path: str | None) -> dict:
    conf = dict(DEFAULTS)
    conf["evidence_target_sources"] = ["cold"]
    if path:
        with open(path, encoding="utf-8") as f:
            user = json.load(f)
        for k, v in user.items():
            if k == "sources":
                conf[k] = v
            else:
                conf[k] = v
    return conf


def demo_sources() -> list[dict]:
    """内置演示数据：50 条跨 6 天的混合记忆，够看清星图长什么样。"""
    demo = Path(__file__).resolve().parent.parent / "demo" / "memories.jsonl"
    return [{"type": "jsonl", "path": str(demo), "name": "demo"}]


def main() -> int:
    ap = argparse.ArgumentParser(description="构建 starmap.json")
    ap.add_argument("--sources", help="sources.json 路径")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "web" / "starmap.json"))
    ap.add_argument("--demo", action="store_true", help="用内置演示数据")
    args = ap.parse_args()

    conf = load_conf(args.sources)
    if args.demo:
        conf["sources"] = demo_sources()
        conf["force_local"] = True          # 演示时不必依赖布局服务
        conf["layout_iters"] = 60
    elif not conf.get("sources"):
        print("没有数据源：给 --sources，或先用 --demo 跑通链路", file=sys.stderr)
        return 2

    out_path = Path(args.out)
    payload = build(conf, out_path)
    write(payload, out_path)
    print(f"nodes={len(payload['nodes'])} links={len(payload['links'])} "
          f"days={len(payload['days'])} layout={payload['layout_by']} "
          f"in {payload['build_seconds']}s -> {out_path}")
    print("stats:", payload["stats"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
