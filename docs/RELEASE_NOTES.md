# v0.1.15

新增**记忆星图**功能栏，以及**记忆分组**（哪些会话共享一份记忆）。

## 1. 记忆星图（控制台独立分栏）

左侧导航「聊天行为 → ✦ 记忆星图」：

- 顶部选**视图**（每个会话一份，或每个记忆分组一份）→ 点「构建 / 重新构建」
- 下方是三维星图：每条记忆一颗星、真实关系一根线、每天一个日期星
- 支持拖拽旋转、滚轮缩放、点星聚焦、`Space` 逐日回放、`R` 复位、`F` 全屏

底层用 [painter-7/memory-starmap](https://github.com/painter-7/memory-starmap)（已 vendored 到 `vendor/memory-starmap/`，未改算法）。

**数据来源**：桥接本地状态，不读 DSH 会话内容 ——
各会话的 `recentMessages`（kind=msg/reply）、`activeTopics`（topic）、`pendingThoughts`（thought）、`memberImpressions`（impression）。

**依赖**：Python 3.9+ 与 numpy（`python -m pip install numpy`）。没装 python 时构建会报错，控制台会显示原因。

## 2. 记忆分组（默认各自独立）

同一页第二张卡：「记忆分组」。

- 勾选若干私聊/群 → 填个名字 → **新建分组**
- 同组会话共享一份记忆空间（`state/memory-groups.json`），星图合并展示
- 删除分组即恢复各自独立

**边界说明**：分组共享的是桥接侧的轻量记忆与星图；DSH 的对话上下文仍按会话隔离（每个 QQ 会话一个 DSH session）。要真正做到「上下文也互通」需要改 session 映射，属于更大改动，本版没做。

## 3. 记忆星图权限（对谁开放）

「访问与安全 → 用户权限」表新增第 7 列 **记忆星图**：

- **默认关闭**（其他人调用返回 403「未被授权使用记忆星图」）
- **管理员（ownerQQ）恒开**
- 勾选保存后立即生效

AI 侧工具：`qq_starmap`（构建 + 返回星数/连线数/天数）。

安全细节：星图画面地址里带控制台令牌，所以**只有管理员**能拿到 URL；其他人只拿到统计数字（`url: null`）。

## 4. 接口

```bash
# 概览（有哪些视图、各自建过没有）
curl -H "x-console-token: $TOKEN" http://127.0.0.1:3100/api/starmap

# 构建某个视图
curl -X POST http://127.0.0.1:3100/api/starmap/build \
  -H "x-console-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"ns":"private:123456"}'

# 记忆分组
curl -H "x-console-token: $TOKEN" http://127.0.0.1:3100/api/memory-groups
curl -X POST http://127.0.0.1:3100/api/memory-groups \
  -H "x-console-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"groups":[{"id":"family","name":"家人","members":["private:111","private:222"]}]}'
```

星图静态资源：`/starmap/<consoleToken>/<dir>/index.html`（路径里带 token，是为了让页面内的相对 `fetch` 也能通过鉴权；令牌不对返回 403）。

## 5. 产物位置

```
state/starmap/<dir>/memories.jsonl   # 导出的记忆（可 diff、可手改）
state/starmap/<dir>/sources.json     # 构建配置
state/starmap/<dir>/starmap.json     # 星图数据（前端直接读）
state/starmap/<dir>/starmap.js       # 同上，给 iframe 场景兜底
```

`state/` 在 `.gitignore` 里，不会被提交。

## 升级

```bash
git pull
python -m pip install numpy        # 若未装
# 重启桥接 → 打开控制台左侧「记忆星图」
```

首次进入页面点「构建 / 重新构建」即可看到自己的星图（没有记忆时会是一张空图，先去 QQ 里聊几句）。
