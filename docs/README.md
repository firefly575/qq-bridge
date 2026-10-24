# 文档索引（docs/README.md）

本仓库是 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的下游分支，**只保留对外可用的文档**。
上游作者的内部分析（design/、research/、audits/、legacy/）未随本仓库发布 —— 想追溯设计取舍请看上游仓库。

> 第一次用？直接看 **[guides/DEPLOY.md](guides/DEPLOY.md)**（部署 / 使用 / 注意事项 / 排障一条龙）。
>
> **状态标记**：✅ 仍然有效 · ⚠️ 部分过时 · 🗄️ 已被取代（保留作背景）

---

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 | 状态 |
|---|---|---|
| **[DEPLOY.md](guides/DEPLOY.md)** | 本地部署、填 API Key、接 SnowLuma + DSH、启动、使用、注意事项、排障 | ✅ **新用户从这里开始** |
| [DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 侧安装：agent preset、MCP 注册、模式切换、常见问题 | ✅ |
| [VOICE.md](guides/VOICE.md) | 语音链路：TTS、发语音条、Seed-VC 换嗓、翻唱，以及缺模型时怎么降级/补齐 | ✅ |
| [TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：怎么读、数据从哪来、怎么省 | ✅ |
| [SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 安全基线与加固：状态文件 ACL、令牌、权限边界 | ✅ |
| [PRIVACY.md](guides/PRIVACY.md) | 脱敏规则与 `npm run privacy-scan` 用法 | ✅ |
| [CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台 UI 的静态检查与 Playwright 用例 | ⚠️ 需要本机装 Playwright |

## 根目录的几个关键文件

| 文件 | 作用 |
|---|---|
| [README.md](../README.md) | 项目介绍、来源与改动、开箱可用性、安装、运行 |
| [README.en.md](../README.en.md) | 英文版 README |
| [RULES.md](../RULES.md) | QQ 会话的权限边界与安全承诺（**建议读一遍再给机器人开权限**） |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 目录与脚本命名约定，改代码前先看这个 |
| [LICENSE](../LICENSE) | MIT（含上游版权声明） |
| [config.example.json](../config.example.json) | 配置模板，复制成 `config.json` 使用 |
| [QQ机器人-管理员指令.docx](QQ机器人-管理员指令.docx) | 管理员指令速查表（可打印；用 `python make-admin-doc.py` 重新生成） |

## 想找什么 → 去哪看

| 你想… | 看 |
|---|---|
| 从零把它跑起来 | [guides/DEPLOY.md](guides/DEPLOY.md) |
| 知道哪些功能要自己补模型/音频 | [README「开箱可用性」](../README.md#开箱可用性哪些功能要自己补) |
| 填 API Key / 换模型 / 改时长额度 | [README「开箱可用性」](../README.md#开箱可用性哪些功能要自己补) + 控制台「生成能力」页 |
| 接 DSH、装 preset、挂 MCP | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 用语音 / 翻唱 / 换音色 | [guides/VOICE.md](guides/VOICE.md) |
| 看花多少钱、怎么省 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 加固安全、别把 key 泄了 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md)、[guides/PRIVACY.md](guides/PRIVACY.md) |
| 改代码 / 找文件 | [FOLDER_MAP.md](FOLDER_MAP.md) |
