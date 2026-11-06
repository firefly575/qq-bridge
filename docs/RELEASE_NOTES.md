# v0.1.11

四件事：**管理员可以在 QQ 里操作电脑**、修好「DSH 打补丁后桥接连不上（401）」、视频时长 2~30 秒、报错只发管理员。

## 1. 管理员工具（新功能，仅 ownerQQ）

管理员私聊里，AI 现在能直接操作本机（`config.admin.enabled`，默认 **false**，本仓库示例配置里是 false，请按需打开）：

| 工具 | 作用 |
|---|---|
| `qq_admin_exec` | 执行任意命令（装依赖、跑脚本、重启服务、查状态），返回 stdout/stderr |
| `qq_admin_fs` | 读/写/追加/列目录/stat/移动/复制/删除文件与目录 |
| `qq_admin_download` | 从 http(s) 下载文件到本机指定路径 |
| `qq_admin_install` | `npm` / `npm-global` / `pip` / `plugin`（重跑 `setup-dsh.mjs` 装 DSH 插件与预设） |

**三重校验**，缺一不可：

1. `config.admin.enabled === true`
2. 有效令牌（会话 agent token 或控制台令牌）
3. 会话 key 必须**正好等于** `private:<ownerQQ>` —— 群聊、其他人私聊一律 403

**全程审计**：每次调用写 `state/admin-audit.jsonl`（时间、key、操作、命令/路径、结果码），可回溯。

配置：

```jsonc
"admin": {
  "enabled": true,          // 打开才会把工具注册给 AI
  "allowShell": true,       // 关掉则只允许文件操作
  "allowWrite": true,
  "allowInstall": true,
  "workdir": "",            // 相对路径的基准目录，空=仓库根
  "timeoutMs": 120000,      // 单条命令超时
  "maxOutputChars": 8000    // 回给 AI 的输出上限（防止把巨量日志塞进上下文）
}
```

提示词里同步加了规则：只在管理员明确要求时动手、覆盖/删除前先说一句、执行后只回报要点、报错细节只对管理员说。

## 2. 修 DSH 打补丁后「桥接 401 / 连不上事件流」

有人用 **dsh-purge** 给 DSH 打了补丁，把会话 cookie 名改成**忽略端口**：

```js
// DSH 里（被补丁改过）
function cookieName(authority) {
  return COOKIE_PREFIX + sha256(authority.replace(/:[0-9]+$/u, ''))
}
```

桥接仍按 `host:port` 算 → 名字对不上 → 所有请求 401 → 事件流每 3 秒重连一次、QQ 消息全部「入队等待」。

**修法**（`src/dsh-client.js`）：mint 时**同时发两个 cookie 名**（带端口 + 忽略端口），服务端只认它自己算的那个，打不打补丁都能连。

## 3. 视频时长：3~5 秒 → **2~30 秒**

`qq_video` 工具说明与兜底区间统一放开；`/video duration 30` 可用。默认仍是 4 秒、每日 5 条，按秒计费。

## 4. 报错只发给管理员

`sendErrorToKey()` 统一出口 + `security.errorsToOwnerOnly`（默认 true）：管理员私聊收完整错误，其他人**什么都不发**，只写 `state/bridge.log`（`[error]` 前缀）。agent 回合出错现在也会落日志。

## 升级步骤

```bash
git pull
npm install                 # 无新依赖，可跳过
# 重启桥接
# 重启 DSH —— 新工具与新预设提示词在 DSH 启动时注册
node scripts/build-agent-preset-patches.mjs   # 如果你改过预设
```

验证管理员工具是否生效（QQ 里对机器人私聊）：

```
帮我看下 D:\dsh\qq-bridge 目录里有什么
把 state/bridge.log 最后 20 行读出来
npm 装一下 xxx 这个包
```

非管理员（群/其他人）发同样的话，AI 应直接拒绝且**不会**出现任何报错细节。

## 安全提示

`admin.enabled: true` 等于把本机 shell 交给「能冒充 ownerQQ 私聊的人」。请确保：机器人 QQ 只加可信好友、`allow.private` 只放 owner、SSH/远程桌面不要和它同机暴露。
`state/admin-audit.jsonl` 建议定期看一眼。
