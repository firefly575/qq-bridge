# v0.1.10

**紧急修复 v0.1.9 的预设文件被写坏导致「QQ 完全不回消息」的问题。**

## 出了什么事

v0.1.9 往 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 里加规则时，插入位置错了 —— 规则被写进了 YAML 的**根级**（变成裸列表项），文件结构从「插件对象数组」变成「字符串数组」：

```yaml
# 坏的
- 禁止把用户的消息整段复制进参数...
- 需要长描述时自己压成一句话...
- id: persona        # ← 原本的第一个插件项，缩进被破坏
```

DSH 重启后重新扫描预设目录，`qq-chat-v2` 解析失败 → 从可用清单消失 → 桥接按安全策略**拒绝回退到默认 preset**（那会把本地工具暴露给 QQ 群），于是所有 QQ 消息都投递失败：

```
⚠️ preset "qq-chat-v2" 不在 DSH 可用清单（standard, ptc, minimal, cordis, preset-plus）中
⛔ 群聊/仿真会话缺少 preset "qq-chat-v2"，拒绝回退到 DSH 默认 preset
```

## 修法

规则改到 **`prefix:` 块标量内部**（缩进 6 空格），不改动 YAML 结构；`plugins/.../qq-chat-v2.patch.yml` 由 `scripts/build-agent-preset-patches.mjs` 重新生成（它是产物，不能手改）。

新增的两条规则：

- **【报错口径（硬规则）】** 工具/接口报错（失败原因、错误码、路径、额度、供应商原文）只对管理员说明；对其他用户只说一句「这条没成，等下再试」，不复述报错、不贴 JSON。
- **【工具参数硬规则】** 禁止把用户消息整段复制进参数（含 `【】`、换行、双引号、反斜杠）；长 prompt 自己压成一句话 ≤200 字；剧本只取「人物 + 动作 + 镜头 + 光线」。

校验（本次发布包含）：

```
dsh/agent-presets/qq-chat-v2/agent.cordis.yml     → 数组(6) ✅
plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml → 数组(1) ✅
两条规则都能在解析后的 prefix / patch 里找到 ✅
```

## 升级（v0.1.9 用户必做）

```bash
git pull
node scripts/build-agent-preset-patches.mjs   # 重新生成 patch
node scripts/setup-dsh.mjs                    # 装回 DSH
# 然后重启 DSH（预设是启动时扫描的）
# 重启桥接
```

验证：桥接日志里不应再出现 `preset "qq-chat-v2" 不在 DSH 可用清单`；QQ 发任意消息应正常回复。

## v0.1.9 里其余修复（仍然有效）

- **视频时长 2~30 秒**：`qq_video` 工具说明与兜底区间都放开了，`/video duration 30` 可用
- **DSH 重启后会话卡死**：`resetStaleTurnMarkers()` + 30 分钟硬兜底，清掉僵尸回合标记并补发积压唤醒
- **报错只发管理员**：`sendErrorToKey()`，`security.errorsToOwnerOnly`（默认 `true`），普通用户收不到报错，只在 `state/bridge.log` 留 `[error]` 记录

## 安全

仓库内不含任何 API Key、QQ 号、聊天记录、声音样本。`state/` 与 `config.json` 在 `.gitignore` 中，`npm run privacy-scan` 全绿。
