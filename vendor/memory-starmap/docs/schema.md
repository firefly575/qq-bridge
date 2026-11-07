# starmap.json 数据契约

版本：`1`（当前前端只认这一版；字段扩容用新增，不做重命名或类型变更）

## 顶层

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `generated_at` | `string` | 是 | 本地时间 `YYYY-MM-DD HH:MM:SS`，仅供展示 |
| `build_seconds` | `number` | 是 | 本次构建耗时（秒，一位小数） |
| `layout_by` | `enum` | 是 | `remote` / `cache` / `warm` / `local` / `empty`，见 README 布局策略 |
| `fingerprint` | `string` | 是 | 全部节点 `key` 排序后 sha1 的前 16 位；内容等价即相同，用于「是否需要通知用户」 |
| `nodes` | `Node[]` | 是 | 星体列表，`i` 与数组下标严格相等 |
| `links` | `[number, number, number][]` | 是 | `[a, b, weight]`，恒有 `a < b`，无自环、无重边 |
| `days` | `Day[]` | 是 | 日期星，按 `day` 升序 |
| `stats` | `object` | 是 | 各数据源计数 + `nodes` / `links` / `days`；可选 `retrieval` |

## Node

```jsonc
{"i": 0, "t": "fact", "day": "2026-11-01",
 "text": "…", "full": "…", "ev": "…", "w": 0.7,
 "p": [12.3, -40.1, 88.0], "key": "dream:42"}
```

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `i` | `number` | 0 基，等于数组下标 |
| `t` | `enum` | `fact` / `lesson` / `preference` / `msg` / `doc`，决定配色 |
| `day` | `string` | `YYYY-MM-DD`，必须出现在某个 `days[].day` 中 |
| `text` | `string` | 卡片显示，≤ `text_max`（默认 400） |
| `full` | `string` | 详情页，≤ `full_max`（默认 2000），比 `text` 长 |
| `ev` | `string` | 证据原话，可为空串；空了不参与证据链连边 |
| `w` | `number` | 0~1 |
| `p` | `[number, number, number]` | 世界坐标，量级 ±150 |
| `key` | `string` | `f"{source}:{id}"`，跨版本稳定标识 |

## Link

`[a, b, weight]`

- `weight` 0~1，由关系强度归一（共现：`log(N/df)` 累积 / 8；证据链固定 1.0）；
- 生成时已按 `edge_per_node` 截断（每点保留最强 N 根）并去重；
- 前端按 `weight` 映射透明度与线宽，`>= 0.9` 视为强调边。

## Day

```jsonc
{"day": "2026-11-01", "p": [-3.2, 11.7, -88.4], "n": 42}
```

`p` 是当日节点质心，由构建器算，不可手写。`n` 为当日节点数。

## stats

```jsonc
{
  "dream": 1319, "cold": 3156, "daybook": 390,   // 各源通过清洗的条数
  "nodes": 4865, "links": 8197, "days": 18,
  "some_source_error": "…",                       // 源读取失败时出现，值为错误串
  "retrieval": {                                  // 可选：检索引擎指标面板
    "vec":  {"cold": {"docs": 2437, "chunks": 3041, "built_at": "11-07 03:50"}},
    "eval": {"at": "11-01 17:26", "r5": 0.647, "kw": 0.889, "nl": 0.375, "neg": 0.125}
  }
}
```

`<source>_error` 出现说明该源被跳过，其余源正常产出——构建器不因单源失败中断。

## 兼容规则

1. 前端对未知字段**忽略**，对缺失的可选字段用 `—` 占位；因此新增字段不需要改前端。
2. 不做字段重命名与类型变更；确需变更时提升顶层 `schema` 字段并同步前端。
3. `i` 与下标相等的约束**不可放松**：`links` 直接当下标用，前端无映射表。
