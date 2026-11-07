# 第三方组件：memory-starmap

- 上游：https://github.com/painter-7/memory-starmap
- 用途：把桥接的记忆渲染成三维星图（`src/build.py` 构建 + `web/` 纯前端渲染）
- 本仓库只做了两处适配，未修改算法：
  1. 由 `scripts/build-starmap.mjs` 生成 `sources.json` 与 `memories.jsonl` 后调用 `src/build.py`；
  2. 前端资源由桥接的 `/starmap/<token>/<dir>/` 静态路由提供。
- 依赖：Python 3.9+ 与 numpy（`python -m pip install numpy`）。
- 许可与素材说明见上游 `docs/ATTRIBUTION.md`。
