# v0.1.14

新增**按会话的用户权限**：控制台「访问与安全」页可以对每个私聊/群单独勾选能力，支持批量修改，保存立即生效。

## 权限项

| 能力 | key | 关掉之后 |
|---|---|---|
| 聊天 | `chat` | 消息**直接忽略**，不入未读、不唤醒（连提示都不产生） |
| 图片生成 | `draw` | `qq_draw` 返回 403「未被授权使用图片生成」 |
| 视频生成 | `video` | `qq_video` 返回 403 |
| 翻唱 | `cover` | `qq_cover` 返回 403 |
| 语音回答 | `voice` | `qq_send_voice` 返回 403 |
| 表情包 | `sticker` | `qq_send_sticker` 返回 403 |

管理员（`ownerQQ`）**恒为全开**，表格里那一行是灰的，改不了 —— 避免把自己锁死。

## 控制台怎么用

「访问与安全」→ 最下面新增卡片 **用户权限（按会话勾选 · 可批量）**：

1. 每行一个会话（私聊/群），右边 6 个勾选框；
2. 左列勾选要做批量的行 → 点 **全开 / 全关 / 仅聊天 / 仅生成能力**；
3. 点 **保存权限**，立即生效（写 `state/permissions.json`）。

页面顶部还有「全选行 / 全不选行」，一次性处理所有会话。

## 存放位置与默认值

```json
// state/permissions.json
{
  "defaults": { "chat": true, "draw": true, "video": true, "cover": true, "voice": true, "sticker": true },
  "users": { "private:123456": { "draw": false, "video": false } }
}
```

- **没有单独设置过的会话 = 全开**（默认值就是全开，保持向后兼容）
- 只存「与默认不同」的项，文件保持干净
- 想让所有新会话默认不能生成图，把 `defaults.draw` 改 `false` 即可（也可以在 API 里传 `defaults`）

## API（供脚本/自动化）

```bash
# 读
curl -H "x-console-token: $TOKEN" http://127.0.0.1:3100/api/permissions

# 批量写（只传要改的项）
curl -X POST http://127.0.0.1:3100/api/permissions \
  -H "x-console-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"users":{"private:123456":{"draw":false,"video":false},"group:987654":{"chat":true}}}'

# 恢复某会话到默认
curl -X POST http://127.0.0.1:3100/api/permissions \
  -H "x-console-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"reset":["private:123456"]}'
```

该接口**仅控制台可用**：带 `x-agent-token` 的 AI 调用会被白名单挡住（AI 不能给自己提权）。

## 与「管理员本机工具」的关系

两者独立：

- **用户权限**决定「这个会话能用哪些聊天/生成能力」；
- **管理员工具**（`qq_admin_*`）只认 `private:<ownerQQ>`，其他会话一律 403。

所以把某个好友的 `chat` 打开、生成能力也打开，它依然**动不了电脑**。

## 升级

```bash
git pull
# 重启桥接（后端与页面都改了）
```

升级后打开控制台「访问与安全」，页面底部即可看到新的权限表。
