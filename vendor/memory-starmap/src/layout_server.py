#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Memory StarMap · 3D 力导向布局服务

构建器把 {nodes, links, seed, iters} POST 过来，这里算完把 {pos: [[x,y,z], ...]} 还回去。
单独拆出来的理由：
  · 构建可能跑在没装 numpy 的机器上，布局放这里，缺依赖只降级不崩；
  · 千点级别的重排要几秒到几十秒，放服务里可以复用进程、加缓存、限并发；
  · 想换算法（力导向 / UMAP / 自研谱嵌入）只动这一处，构建器不用动。

启动：
    STARMAP_LAYOUT_PORT=8110 python3 layout_server.py
    curl -s -X POST localhost:8110/layout -H 'content-type: application/json' \\
         -d '{"nodes":[{"key":"a"},{"key":"b"}],"links":[[0,1,1]],"iters":30}'

可选依赖：numpy。没装也能跑，纯 Python 兜底（点数超过 1500 会很慢，别指望）。
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import numpy as np
except ImportError:                                    # pragma: no cover
    np = None

PORT = int(os.environ.get("STARMAP_LAYOUT_PORT", "8110"))
HOST = os.environ.get("STARMAP_LAYOUT_HOST", "127.0.0.1")
MAX_BODY = 40 * 1024 * 1024
MAX_NODES = 20000
_LOCK = threading.Lock()          # 一次只算一单，避免多请求把 CPU 打满
_CACHE: dict[str, list] = {}
_CACHE_MAX = 8


def _fingerprint(nodes: list, links: list, iters: int) -> str:
    import hashlib
    h = hashlib.sha1()
    for n in nodes:
        h.update(str(n.get("key", "")).encode())
    h.update(str(len(links)).encode())
    h.update(str(iters).encode())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# numpy 实现
# ---------------------------------------------------------------------------
def layout_numpy(nodes: list, links: list, seed: list | None, iters: int) -> list:
    n = len(nodes)
    pos = np.zeros((n, 3), dtype=np.float64)
    if seed and len(seed) == n:
        pos[:] = np.array(seed, dtype=np.float64)
    else:
        rng = np.random.default_rng(20260101)
        pos[:] = rng.normal(0, 60, size=(n, 3))

    if links:
        li = np.array([[int(a), int(b)] for a, b, _ in links], dtype=np.int64)
        lw = np.array([float(w) for _, _, w in links], dtype=np.float64)
    else:
        li = np.zeros((0, 2), dtype=np.int64)
        lw = np.zeros((0,), dtype=np.float64)

    k_rep, cutoff = 900.0, 120.0
    for it in range(max(1, iters)):
        cool = 1.0 - it / max(1, iters)
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
    scale = float(np.abs(pos).max())
    if scale > 0:
        pos = pos / scale * 150.0
    return [[round(float(v), 2) for v in row] for row in pos]


# ---------------------------------------------------------------------------
# 纯 Python 兜底：同一套力学，采样邻居 + 早期截断
# ---------------------------------------------------------------------------
def layout_pure(nodes: list, links: list, seed: list | None, iters: int) -> list:
    n = len(nodes)
    if seed and len(seed) == n:
        pos = [list(map(float, p)) for p in seed]
    else:
        pos = [[math.sin(i * 2.4) * 60, math.cos(i * 1.7) * 30, math.sin(i * 0.9) * 60] for i in range(n)]

    adj = [[] for _ in range(n)]
    for a, b, w in links:
        adj[a].append((b, w))
        adj[b].append((a, w))

    k_rep, cutoff2, sample = 900.0, 120.0 ** 2, 220
    for it in range(max(1, iters)):
        cool = 1.0 - it / max(1, iters)
        disp = [[0.0, 0.0, 0.0] for _ in range(n)]
        for i in range(n):
            xi, yi, zi = pos[i]
            step = max(1, n // sample)
            for j in range(0, n, step):
                if i == j:
                    continue
                dx, dy, dz = xi - pos[j][0], yi - pos[j][1], zi - pos[j][2]
                d2 = dx * dx + dy * dy + dz * dz + 1e-3
                if d2 > cutoff2:
                    continue
                f = k_rep / d2 / math.sqrt(d2)
                disp[i][0] += dx * f
                disp[i][1] += dy * f
                disp[i][2] += dz * f
            for j, w in adj[i]:
                dx, dy, dz = xi - pos[j][0], yi - pos[j][1], zi - pos[j][2]
                dist = math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6
                f = (dist - 34.0) * (0.02 + 0.05 * w) / dist
                disp[i][0] -= dx * f
                disp[i][1] -= dy * f
                disp[i][2] -= dz * f
        for i in range(n):
            for k in range(3):
                pos[i][k] += max(-18.0, min(18.0, disp[i][k])) * cool
                pos[i][k] *= 1.0 - (0.006 if k != 1 else 0.026) * cool
    return [[round(v, 2) for v in p] for p in pos]


def compute(payload: dict) -> dict:
    nodes = payload.get("nodes") or []
    links = payload.get("links") or []
    seed = payload.get("seed")
    iters = int(payload.get("iters") or 80)

    if len(nodes) > MAX_NODES:
        return {"error": f"too many nodes ({len(nodes)} > {MAX_NODES})"}

    fp = _fingerprint(nodes, links, iters)
    if fp in _CACHE:
        return {"pos": _CACHE[fp], "cached": True, "engine": "numpy" if np is not None else "pure"}

    t0 = time.time()
    engine = "numpy" if np is not None else "pure"
    with _LOCK:
        pos = layout_numpy(nodes, links, seed, iters) if np is not None \
            else layout_pure(nodes, links, seed, iters)
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[fp] = pos
    return {"pos": pos, "cached": False, "engine": engine,
            "seconds": round(time.time() - t0, 2)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:                       # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:                           # noqa: N802
        if self.path.split("?")[0] in ("/health", "/"):
            self._send(200, {"ok": True, "engine": "numpy" if np is not None else "pure",
                             "nodes_max": MAX_NODES, "cached": len(_CACHE)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:                          # noqa: N802
        if self.path.split("?")[0] != "/layout":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                self._send(413, {"error": "bad content-length"})
                return
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, OSError) as exc:
            self._send(400, {"error": f"bad json: {exc}"})
            return
        try:
            self._send(200, compute(payload))
        except Exception as exc:                        # noqa: BLE001
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

    def log_message(self, fmt: str, *args) -> None:
        print("[layout] " + fmt % args)


def main() -> None:
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"layout service on http://{HOST}:{PORT}  engine={'numpy' if np is not None else 'pure'}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
