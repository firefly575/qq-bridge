# 本地部署与使用指南

> 面向第一次拿到这个项目的人：从零到「在 QQ 里跟 AI 聊天、让它画图/出片/唱歌」。
> 全程 Windows。Linux/macOS 只能跑桥接本体，QQ 侧依赖的 SnowLuma 是 Windows 客户端。

---

## 0. 它是什么

```
你的 QQ 帐号
   │  （SnowLuma 通过 OneBot v11 把 QQ 消息转成 HTTP/WS）
   ▼
SnowLuma  ──HTTP:3000 / WS:3001──►  qq-bridge（本项目，Node）
                                      │   控制台 :3100
                                      │   MCP server（qq_* 工具）
                                      ▼
                              DeepSeek Harness（DSH）桌面版
                                      │
                                      ▼
                                DeepSeek 模型
```

桥接做三件事：

1. 把 QQ 消息**按白名单**转发给 DSH，把 DSH 的回复发回 QQ；
2. 给 AI 挂上 `qq_*` 工具（发消息、发表情、发语音、画图、出视频、翻唱…）；
3. 提供一个本地控制台（:3100），管人格、白名单、工具开关、费用额度、API Key。

---

## 1. 前置条件

| 依赖 | 版本/说明 | 必须？ |
|---|---|---|
| Windows | 10/11（SnowLuma 与 QQ NT 都是 Windows 客户端） | ✅ |
| Node.js | **≥ 22.13.0**（`package.json` 的 engines 硬要求） | ✅ |
| QQ NT 客户端 | 建议单独注册一个**机器人小号**，不要用主号 | ✅ |
| [SnowLuma](https://github.com/) | OneBot v11 网关，登录机器人 QQ 并提供 3000/3001 | ✅ |
| DeepSeek Harness | 桌面版 DSH，需开启本地 gateway | ✅ |
| Python | 3.10+（只有翻唱/唱歌/语音这些 `.py` 需要） | 可选 |
| ffmpeg | 语音时长/响度、视频裁剪、翻唱混音 | 可选但强烈建议 |
| demucs（`.venv-demucs`） | 翻唱的人声/伴奏分离，**本仓库不含** | 可选 |

> Node < 22.13 会直接启动失败。用 `node -v` 确认。

---

## 2. 安装（约 3 分钟）

```powershell
# 1) 取代码（或直接解压 zip）
git clone <你的仓库地址> "E:\deepseek 语音助手"
cd "E:\deepseek 语音助手"

# 2) 装依赖（postinstall 会自动给 @snowluma/sdk 打 ESM 补丁，别跳过）
npm install

# 3) 准备配置：从示例复制
copy config.example.json config.json
```

`config.json` 最少要改三处：

```jsonc
{
  "ownerQQ": 你的QQ号,                       // 只有这个号能用 /draw /video 等管理指令
  "allow": {
    "private": [你的QQ号],                    // 允许私聊的号
    "groups":  [你的群号]                     // 允许参与的群（**留空 = 谁都不理**）
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "SnowLuma 里设的 token（没设就留空）"
  },
  "dsh": { "baseUrl": "http://127.0.0.1:xxxx" }   // DSH gateway 地址
}
```

> `consoleToken` **留空**即可，桥接首次启动会自动生成并打印，完整值存在 `state/console-token`。

---

## 3. 填 API Key（三把，按需）

模型已经配好，**只缺钥匙**。三种填法，任选一种：

### 方式 A：控制台（推荐）

启动后打开控制台 → 左侧「生成能力」→「API Key（云端密钥）」→ 粘贴 → 保存。
页面上还能点「测试」免费验证（只请求模型列表接口，不生成内容、不花钱）。

### 方式 B：文件

```powershell
# 百炼 DashScope（画图 qwen、视频 wan、语音/翻唱）
Set-Content state\aliyun-key.txt  "sk-xxxxxxxx"

# 火山方舟 Flash（画图 seedream）
Set-Content state\ark-key.txt     "xxxxxxxx-xxxx-xxxx"

# 火山方舟 Pro（画图 seedream-pro，可选）
Set-Content state\ark-key-2.txt   "xxxxxxxx-xxxx-xxxx"
```

### 方式 C：环境变量（优先级最高）

`DASHSCOPE_API_KEY` / `ARK_API_KEY` / `ARK_API_KEY_PRO`

| Key | 用在哪 |
|---|---|
| 百炼 DashScope | 画图 `qwen`、视频 `wan`/`wan-prime`、语音合成、翻唱 |
| 火山方舟 Flash | 画图 `seedream`（doubao-seedream-5-0-flash） |
| 火山方舟 Pro | 画图 `seedream-pro`（doubao-seedream-5-0-pro） |

**这些模型需要在控制台/火山方舟里开通**，否则会报 `ModelNotOpen`；百炼欠费时连图都会被拦（`Arrearage`）。

---

## 4. 接上 SnowLuma 与 DSH

1. **SnowLuma**：登录机器人 QQ，开启 OneBot v11，HTTP 监听 `127.0.0.1:3000`、WS 监听 `127.0.0.1:3001`（端口和 `config.json` 对上即可）。
2. **DSH**：在桌面版里开启本地 gateway；把 `dsh.baseUrl` 填成它的地址，需要鉴权就填 `dsh.authToken`。
3. **安装 preset + 注册 MCP**（一次性）：

```powershell
node scripts/setup-dsh.mjs
```

它会把 `qq-chat-v2` 预设装进 DSH，并把 `mcp-snowluma-safe` 注册为 MCP server。装完**重启 DSH**，工具列表里应出现 `mcp__snowluma__qq_*`。

---

## 5. 启动

```powershell
npm start
# 或双击 start.bat（带崩溃自动重启）
# 或 restart.bat / watchdog.ps1（看门狗）
```

正常启动会打印：

```
桥接已启动。按 Ctrl+C 退出。
控制台未配置 consoleToken，已自动生成：xxxx…（完整值保存在 state/console-token）
本地控制台已启动：http://127.0.0.1:3100
SnowLuma 已连接：ws://127.0.0.1:3001
DSH 已就绪（模式: reserved2）
```

打开控制台：

```powershell
start "" "http://127.0.0.1:3100/?token=$(Get-Content state\console-token)"
```

（或双击 `打开控制台.cmd`）

---

## 6. 怎么用

### 6.1 控制台（10 个页面）

| 页面 | 干什么 |
|---|---|
| 运行总览 | 连接状态、模式、今日用量 |
| 会话与审批 | QQ ↔ DSH 会话映射、待审批请求 |
| 人格与角色 | 选/改人格卡（`roles/*.md`），保存即生效 |
| DeepSeek娘聊天 | 二代仿真的工具开关、唤醒节奏、发言概率 |
| 生成能力 | **画图/视频的后端、模型、分辨率、时长、每日额度、API Key** |
| 词汇新增 | 手工维护黑话/网络用语（**不再自动从群聊学习**） |
| 令牌与花费 | token 消耗与花费，可下钻到每个群/每轮 |
| 访问与安全 | 白名单、管理员、控制台令牌 |
| 调试与运维 | 测试消息、发提醒、重启/维护 |
| 工具参考 | AI 侧 `qq_*` 工具清单 |

### 6.2 QQ 里（管理员指令，只有 `ownerQQ` 有效）

| 指令 | 作用 |
|---|---|
| `/status` | 查看状态 |
| `/reset` `/new` | 重置会话 |
| `/role 小鲸鱼` / `/role off` | 换人格 / 关掉 |
| `/silent` / `/active` | 只回管理员 / 恢复正常 |
| `/model api` `local` `list` | 模型切换 |
| `/draw` | 看画图后端/型号/分辨率/今日用量 |
| `/draw model qwen\|seedream\|seedream-pro\|sdcpp` | 切换画图后端 |
| `/draw res 720\|1080` | 分辨率 |
| `/draw limit 20` | 每日出图上限 |
| `/video` | 看视频后端/型号/尺寸/时长/今日用量 |
| `/video model wan\|wan-prime` | 切换视频档位 |
| `/video duration 6` | 改时长（**2~30 秒**，默认 4） |
| `/video limit 5` | 每日视频上限 |
| `/video test` | 生成 1 条 0.5 秒测试片 |
| `/cover 15` / `/cover voice v2` | 翻唱时长 / 音色 |
| `/sticker 35` / `/sticker off` | 表情概率 / 开关 |

### 6.3 AI 侧

AI 通过 MCP 工具干活：`qq_get_unread_messages`、`qq_send_message`、`qq_send_voice`、`qq_draw`、`qq_video`、`qq_cover`、`qq_send_sticker`、`qq_slang_query`、`qq_memory_*` 等。
工具**是否对 AI 可见**由控制台「工具开关」决定；关掉后桥接会立刻拒绝调用，但要让它从 AI 的工具清单里彻底消失，需重启 DSH。

---

## 7. 注意事项（重要）

### 7.1 费用

- **视频按秒计费**：4 秒 → 30 秒是 7.5 倍价。默认 4 秒 + 每日 5 条是刹车，别同时放开时长和额度。
- **画图**默认 10 张/天，视频默认 5 条/天，都在控制台「生成能力」里改。
- 命中缓存的重复提示词**不占额度**（同样的提示词+参数会直接复用上次结果）。
- 欠费时百炼会把画图和视频一起拦掉，日志里是 `Arrearage`。

### 7.2 安全

- `state/` 和 `config.json` **已经在 `.gitignore` 里**，不要把里面的东西提交上去。`state/*.txt` 就是你的 API Key。
- `state/console-token` 等于管理员密码，泄露 = 别人能改你的白名单和配置。
- 桥接只监听 `127.0.0.1`；不要把 3100/3000/3001 暴露到公网。
- 白名单**留空时它谁都不理**（`allowAllWhenEmpty: false`），这是故意的安全默认值。

### 7.3 本仓库不含的东西

| 缺什么 | 影响 | 怎么补 |
|---|---|---|
| `state/*` 全部内容 | 首次启动是空状态（正是期望的） | 自动重建 |
| `audio/ref-voice.wav` | **声音克隆没有参考音**，`/cover`、语音复刻不可用 | 自己放一段 8~20 秒干净人声到 `audio/ref-voice.wav` |
| `audio/voices/*` | 语音库里没有现成音频 | 自己往 `audio/` 放音频 |
| `.venv-demucs`（1.1GB） | 翻唱缺少人声/伴奏分离，质量下降或跳过 | `pip install demucs` 到本地 venv，按 `cover.py` 里的路径配 |
| `voice-tool/`（上一级仓库） | `npm run voice-gui` / `voice-cli` 不可用 | 独立安装，或用控制台自带的语音面板 |
| 演示截图 | README 里若有图片链接会失效 | 自己截几张脱敏图 |
| 生成产物（`images/`、`videos/`） | 只是缓存，不影响运行 | 自动创建 |

### 7.4 其它坑

- **Node 版本**必须是 22.13+；npm install 的 `postinstall` 不能跳过（它给 `@snowluma/sdk` 打补丁，跳过会 ESM 报错）。
- **端口冲突**：3100（控制台）、3000/3001（SnowLuma）。改了端口要同步 `config.json`。
- **编码**：全项目 UTF-8（含中文文件名）。Windows 终端建议 `chcp 65001`，`start.bat` 已带。
- **一人一号**：机器人 QQ 建议小号。用它当自己的号会导致「自己给自己发消息」，桥接会按设计忽略（`event.user_id === event.self_id`）。
- **DSH 重启才刷新工具**：控制台关掉工具后，AI 侧要重启 DSH 才看不到。
- **config.json 里的 `agentPreset`** 默认 `qq-chat-v2`（二代仿真）。旧的一代 `qq-chat` 预设已下线，别再改回去。

---

## 8. 排障

| 现象 | 先查什么 |
|---|---|
| QQ 里发消息没反应 | 日志有没有 `忽略未授权会话`（→ 白名单）；SnowLuma 是否 `online:true`；`get_login_info` 返回的是不是**机器人号** |
| 控制台 401 / 打不开 | URL 里带 `?token=`，值取 `state/console-token` |
| 启动就退出 | `node -v` 是否 ≥ 22.13；`npm install` 是否跑过 postinstall |
| 画图报错 | key 对不对（控制台「测试」）、模型是否开通、是否欠费 |
| 视频报错 | `duration` 是否在 2~30；是否超额度；账号是否欠费 |
| AI 不调工具 | 控制台「工具开关」是否关着；DSH 是否重启过 |
| 翻唱没反应 | 有没有 `audio/ref-voice.wav`；ffmpeg 在不在 PATH |
| 想确认没泄漏 | `npm run privacy-scan`（自带扫描器，发布前跑一遍） |

---

## 9. 许可

见 `LICENSE`。第三方依赖各自遵循其许可证；SnowLuma / QQ / DeepSeek Harness 的使用请遵守各自服务条款。
