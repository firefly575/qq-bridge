# v0.1.12

修一个**逻辑冲突**：v0.1.11 加了管理员本机工具，但预设里「你没有本地工具」这条最高优先级安全规则没改，
AI 严格照它执行 → 管理员让它看目录，它只会回答「看不到」。

## 改了什么

预设安全规则第 1 条改成「原文 + 明确例外」：

```
1. 你没有本地工具：不能执行命令、不能读写文件、不能启动程序、不能查看系统信息。工具不存在就是不存在。
   **唯一的例外**：当且仅当本次会话是管理员（ownerQQ）私聊时，桥接会额外挂上
   qq_admin_exec / qq_admin_fs / qq_admin_download / qq_admin_install 四个工具……
   群聊与非管理员私聊里这些工具不存在，调用会被 403 拒绝——不要尝试、不要提及、不要解释。
```

注意保留了 `你没有本地工具` 原文：`src/preset-prompt.js` 的硬性安全不变量校验要求它必须存在，
改了会让控制台存不进提示词、`npm run test:audit` 失败（v0.1.12 已校验 `presetPromptBlockers` 返回空）。

## 只有管理员能动电脑：三道闸

| 层 | 位置 | 非管理员结果 |
|---|---|---|
| ① 工具注册 | `config.admin.enabled` | 不注册 `qq_admin_*`，AI 根本看不到 |
| ② 路径白名单 | `/api/admin/` 在 agent 允许路径内，但接口内部判身份 | — |
| ③ 身份 + 令牌 | `isOwnerKey(key)` + agent/console token | **403 只有管理员（ownerQQ）私聊可以使用本机操作** |

实测：

```
群会话调用      → 403 只有管理员（ownerQQ）私聊可以使用本机操作
其他私聊调用    → 403 只有管理员（ownerQQ）私聊可以使用本机操作
无令牌          → 403 agent token 无效
管理员 exec     → 200  code=0
```

每次调用写 `state/admin-audit.jsonl`（时间 / key / 操作 / 路径或命令 / 结果码）。

## 升级

```bash
git pull
node scripts/build-agent-preset-patches.mjs
# 重启 DSH（预设文案在启动时装载）→ 再重启桥接
```

验证：QQ 里对机器人私聊「看下 D:\\dsh\\qq-bridge 目录里有什么」→ 应调 `qq_admin_fs` 返回文件列表，而不是「看不到」。
