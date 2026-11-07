# Memory StarMap

**把长期记忆档案渲染成一张可漫游的三维星图。**

每条记忆是一颗星，每条真实关系是一根线，每一天是一个日期星。目标不是「好看」，而是**可导航**：几千条压成一句话的记忆，用旋转、缩放、聚焦、逐日回放，把「我什么时候想过什么、这两件事为什么有关」变成手上的动作。

![layout](docs/screenshot.png)

> 纯前端渲染（Canvas 2D + 手工三维投影，无 WebGL、无框架），构建侧 Python 单文件，布局服务可拆可省。

**项目来源**：本仓库是 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 记忆系统的一个视图实现——数据契约、五层记忆分层、插件骨架都按 AstrBot 的形态设计，`examples/astrbot_plugin/` 也是为 AstrBot 插件体系准备的。它与 dsh（另一个编码 agent 工具）无关，不需要、也未使用 dsh。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [技术方案](#技术方案)
- [核心设计](#核心设计)
- [快速开始](#快速开始)
- [接入自己的数据源](#接入自己的数据源)
- [数据契约](#数据契约)
- [布局策略](#布局策略)
- [交互与渲染](#交互与渲染)
- [接入 AstrBot 插件](#接入-astrbot-插件)
- [性能基线](#性能基线)
- [FAQ / 排障](#faq--排障)
- [素材与说明](#素材与说明)

---

## 它解决什么问题

记忆系统做到一定规模后，最常见的困境是**结构化查询赢了、空间感知输了**：你能检索到某条，但感受不到「这段时间我在想什么」。排行榜、时间热力图都只回答一个维度。

星图补的是另一个维度：**拓扑**。相近、相连、同日的记忆在视觉上聚成一团，稀缺词构成的高权重边把跨天的话题拉成一条脊，日期星把线性的时间压成一条可以回放的轨道。

三个具体用途：

| 用途 | 做法 | 观察到的收益 |
| --- | --- | --- |
| 语料体检 | 看孤点比例、日节点密度 | 孤点 > 25% 说明分词或阈值太严，连边质量差 |
| 主题演化 | 逐日回放 + 聚焦日期星 | 一眼看出某个话题连续几天出现后断掉 |
| 对外展示 | 静态产物 + 任意静态托管 | 不需要后端，构建一次即可分享 |

---

## 技术方案

星图只是记忆系统的一个视图。完整方案包含两侧：

- **[docs/architecture.md](docs/architecture.md)** — 记忆分层（常驻层 / 日目录层 / 叙事层 / 原文层 / 结论层）、写入与压缩时机、检索与出处校验、星图管线、验收指标、运维约束。可作为独立技术文档阅读与实施。
- **[docs/memory-layers.md](docs/memory-layers.md)** — 各层到星图节点、边、日期星的映射规则，以及「哪层接、哪层不接」的判断依据。

两份文档只讲记忆分层与星图构建，不含配置层内容与具体部署环境；路径与容量均为参考值。

---

## 核心设计

四条实现原则贯穿整条管线：

1. **连边只来自真实关系，绝不随机连边。**
   随机边能让图「看起来像星云」，但它毁掉了拓扑的可解释性——你无法再从邻域推断语义。当前只有两类关系：稀有词共现、证据链命中。
2. **构建与渲染解耦，产物是纯数据。**
   `build.py` 只吐 `starmap.json`；前端只读这份 JSON，不发任何业务请求。因此产物可以直接丢 CDN、可以 diff、可以进版本库。
3. **布局永不阻塞构建。**
   布局服务不通 → 缓存坐标 → 本机增量力导向，三级降级。任何一步失败都只影响形状，不影响数据完整性。
4. **前端零依赖、零构建。**
   两个文件（`index.html` + `app.js`），改完刷新即生效。没有 bundler、没有 node_modules，一年后拉下来还能跑。

---

## 快速开始

### 1. 零依赖跑通（演示数据）

```bash
git clone https://github.com/painter-7/memory-starmap.git
cd memory-starmap
python3 src/build.py --demo          # 55 节点 / 96 边 / 6 天，0.3 秒
python3 -m http.server 8123 -d web
# 打开 http://127.0.0.1:8123
```

`--demo` 会把 `demo/memories.jsonl` 编进 `web/starmap.json`，并在同目录生成 `starmap.js`（`window.__STARMAP_DATA__ = {...}`）。

演示数据是脱敏示例，与任何真实语料无关；字段名、表结构、阈值都按你自己的系统约定来，接入时只改 `sources.json`。

### 2. 接真实数据

```bash
cp examples/sources.example.json sources.json
vim sources.json        # 改 path / sql
python3 src/build.py --sources sources.json --out web/starmap.json
```

### 3. （可选）起布局服务

点数超过两千后，本机力导向会开始吃时间。拆出服务可以在换数据时复用进程和缓存：

```bash
STARMAP_LAYOUT_PORT=8110 python3 src/layout_server.py
curl -s localhost:8110/health
# {"ok": true, "engine": "numpy", "nodes_max": 20000, "cached": 0}
```

构建器默认就指向 `http://127.0.0.1:8110/layout`，起了服务自动用；没起自动降级。

---

## 接入自己的数据源

三种 loader，`sources.json` 里按 `type` 选：

### `sqlite`

```json
{
  "type": "sqlite",
  "name": "dream",
  "path": "/path/to/memory.db",
  "sql": "select id, day, text, kind, importance, evidence from items where superseded_by is null",
  "columns": ["id", "day", "text", "kind", "weight", "evidence"],
  "kind_default": "fact",
  "weight_default": 0.7
}
```

- 库以 `mode=ro` 只读打开，不会写你的库；
- `columns` 决定 `sql` 返回列的语义，顺序对应；不给则按 `id, day, text, kind, weight, evidence` 猜；
- 日期字段格式随意（`2026-11-01` / `2026/11/01` / `20261101` / unix 秒），`norm_day()` 统一归一，认不出的**整条丢弃**而不是塞进今天。

### `jsonl`

每行一条，字段同 `columns`。适合离线导出、跨系统搬运。

```bash
{"id": 1, "day": "2026-11-01", "kind": "fact", "text": "...", "evidence": "...", "weight": 0.8}
```

### `markdown`

目录约定：`<dir>/YYYY-MM-DD*.md`，一文件一天，按 `#` 级标题切块，每块一条，`kind` 固定为 `doc`。

### 字段语义

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 源内唯一即可，最终 `key = f"{source}:{id}"`，用于跨版本对齐坐标 |
| `day` | 是 | 归一失败即丢弃 |
| `text` | 是 | 清洗后短于 `min_len`（默认 20）丢弃——寒暄和状态字对拓扑没有贡献 |
| `kind` | 否 | 决定配色，未知值归为 `fact` |
| `weight` | 否 | 0~1，影响力导向的弹簧刚度与前端尺寸 |
| `evidence` | 否 | 一句原话。用在关系二（证据链）里做原文命中 |

**清洗规则**（`NOISE` 列表）：定时任务壳 `[CronJob]`、`<system_reminder>`、`<image_caption>`、引用块、URL、压缩备忘标记、`[图:...]`、`[YYYY-MM-DD ...]` 全部剔除。**你自己的语料如果有别的壳，往这个列表加一条正则即可**，别在别处打补丁。

---

## 数据契约

产物 `starmap.json`（详见 [`docs/schema.md`](docs/schema.md)）：

```jsonc
{
  "generated_at": "2026-11-07 23:10:02",
  "build_seconds": 41.3,
  "layout_by": "remote",              // remote | cache | warm | local | empty
  "fingerprint": "aab2754007452228",  // 节点 key 集合的 sha1 前 16 位
  "nodes": [
    {"i": 0, "t": "fact", "day": "2026-11-01",
     "text": "卡片显示（≤400 字）", "full": "详情页（≤2000 字）",
     "ev": "证据原话", "w": 0.7, "p": [12.3, -40.1, 88.0], "key": "dream:42"}
  ],
  "links": [[0, 17, 0.83]],            // a < b，weight 0~1
  "days": [{"day": "2026-11-01", "p": [..], "n": 42}],
  "stats": {"dream": 1319, "cold": 3156, "daybook": 390, "nodes": 4865, "links": 8197, "days": 18}
}
```

约定要点：

- `days[].p` 是**当日所有节点的质心**，不是手写坐标——增删记忆后日期星会自己挪；
- `links` 下标指向 `nodes[].i`，与数组顺序一致，`i` 与下标相同，别指望它在增量构建里稳定；
- `key` 才是稳定标识。布局的增量能力、外部 diff 都靠它。

前端取数走两条路：先试 `fetch('starmap.json')`，被 CORS（iframe 无 same-origin）拦下时退回 `<script src="starmap.js">`。所以 `build.py` 一定同时写两份，别只拷 `.json`。

---

## 布局策略

三级降级，`layout_by` 字段记录这一版实际走了哪一档：

| 档位 | 触发条件 | 算法 | 代价 |
| --- | --- | --- | --- |
| `remote` | 布局服务 200 且点数/格式校验通过 | 服务端力导向 | 一次 RTT + 单次计算 |
| `cache` | 服务不可用，且 ≥70% 节点的 `key` 有旧坐标 | 直接沿用旧坐标 | O(1) |
| `warm` | 旧坐标覆盖 30%~70% | 45 轮力导向（旧点做种子） | 约 1/4 全量 |
| `local` | 旧坐标覆盖 <30% 或 `--demo` | 160 轮力导向 | 千点约 8 秒 |

力导向参数（斥力核 `900/d²`、边长目标 `34`、Y 轴压缩 `0.02`、阻尼 `0.006`、步长上限 `18`）是针对「扁盘状星云」调的：

- **Y 轴额外压缩**：不做的话球体看起来像一团雾，加了之后记忆自然铺成一个可俯视的盘，靠近银道面；
- **斥力核截断 `120`**：超过这个距离的节点对直接跳过计算，是千点能跑进十秒的关键，也是 O(n²) 在实际数据上近似 O(n) 的原因；
- **斥力分块 `160`**：`disp[s:e] += (...)` 按 160 行一批做广播，把峰值内存从 n²×3×8 字节压到 160×n×3×8。

**别把 `iters` 拉高到几百。** 力导向的收敛曲线在 100 轮之后基本躺平，加轮数只是让老点抖来抖去，用户体验反而差。要更好的形状应该换算法（谱嵌入、UMAP），而不是加迭代。

---

## 交互与渲染

无 WebGL，全部手写三维投影。理由：目标设备里有一半是移动端浏览器和受限 iframe，WebGL 上下文丢失后很难优雅恢复。

- **投影**：透视投影 + 四元数相机（yaw/pitch + 距离），`z` 参与尺寸与透明度衰减，远景自然积成雾；
- **绘制顺序**：三层分离——星尘层（`globalCompositeOperation = 'lighter'` 叠加）、星体层、标签层。叠加混合让密集处自然亮成星带，比给每条轨道描线更耐看；
- **命中测试**：屏幕空间最近邻 + 半径阈值，不做 z-buffer（同屏节点上万时也不卡）；
- **焦点**：点击后建邻接表，非邻居节点亮度降至 18%，一级邻居描边，二次点击同一节点取消；
- **逐日回放**：按 `days[]` 顺序聚焦，间隔 1.4 秒，`Space` 暂停；
- **清晰度**：按真实 `devicePixelRatio` 走，只保留总像素闸门（8MP ≈ 32MB 画布）。封顶 DPR 2 是常见错误——三倍屏上先降采样再被浏览器放大，糊在最后一步。

键盘：`Space` 回放暂停 / `Esc` 取消焦点 / `R` 重置视角 / `F` 全屏。

---

## 接入 AstrBot 插件

`examples/astrbot_plugin/` 是一份可直接改的插件骨架（`main.py` + `metadata.yaml`）：

```python
from .builder import build_payload          # 或 subprocess 调 src/build.py

@filter.command("星图")
async def starmap(self, event):
    path = await self._ensure_built()       # 带 mtime 判断，不每次重算
    await event.send(MessageChain([Image(file=await self._screenshot(path))]))
```

要点：

- **构建走后台**：四千点全量构建在 1~3 分钟量级，别塞进消息处理路径；
- **产物进插件目录**：`views/starmap/starmap.json`，前端与 JSON 必须同源，否则 `fetch` 拿不到；
- **页面用 iframe 暴露时给 `allow-scripts allow-same-origin`**，缺后者 `fetch` 会直接失败；
- **重算判据**：`starmap.json` 的 `fingerprint` 变了才通知用户，别每次「重建成功」。

---

## 性能基线

本机（6 核 19G 容器，Python 3.11 + numpy）：

| 阶段 | 4865 节点 / 8197 边 | 备注 |
| --- | --- | --- |
| 载入三源（SQLite + 目录） | 1.0 s | 只读打开，WAL 不影响 |
| 连边（词面 + 证据链） | 1.7 s | 主要耗时在 `df` 统计与滑窗切词 |
| 布局（服务端，80 轮） | 21 s | 增量时 `cache` 档可降到毫秒级 |
| 前端首帧 | 0.4 s | 7 MB JSON 解析 + 5000 点首绘 |
| 交互（拖拽旋转） | 60 fps / 桌面 | 移动端 ~45 fps |

降低体积的两处旋钮：`text_max`（卡片文本）、`full_max`（详情文本）。7 MB 里六成是 `full`。

---

## FAQ / 排障

**Q：星图是全黑的，只有 UI。**
先看控制台。八成是 `starmap.json` 没生成或路径不对——`build.py` 会同时写 JSON 和 JS，只拷了前者而页面在无 same-origin 的 iframe 里就会全黑。

**Q：所有点挤成一个球。**
`links` 为空。常见原因：`df_max` 小于词频（所有词都被当口水词过滤掉了），或 `min_len` 太高把正文都丢了。先 `python3 -c "import json;print(len(json.load(open('web/starmap.json'))['links']))"` 看一眼。

**Q：日期标签全是同一天。**
`norm_day()` 遇到认不出的格式会返回空串，该条直接丢弃——如果只剩一天的数据，说明日期字段根本没被识别。检查 `columns` 与 `sql` 的对齐。

**Q：`layout_by` 一直是 `local`，服务明明起了。**
构建器做了格式校验（点数相等、每点三元组）。服务返回 `{"error": ...}` 会静默降级，看构建器的 stderr 有 `[layout] ...` 提示。

**Q：重建后节点全乱跳。**
`key` 变了。`key = source:id`，改了数据源 `name` 或换了 `id` 生成方式都会导致坐标无法对齐，`cache` 档失效。要换源就把 `name` 保持住。

**Q：页面在手机上特别糊。**
检查是否给 canvas 封了 `devicePixelRatio` 上限。本项目不封顶，只留 8MP 总像素闸门。

---

## 素材与说明

素材来源与演示数据说明见 [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md)。
