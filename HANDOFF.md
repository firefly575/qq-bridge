# qq-bridge 项目交接说明（HANDOFF）

> 给"新开一个对话"用的自包含上下文。读这一份就能接着干，不需要翻历史。
> 最后更新：2026-10-22 09:10

---

## 0. 一句话

把 **DSH（DeepSeek 桌面端）** 接到 **QQ** 上当群友的桥接程序：`<项目目录>`。
它自己处理 QQ 收发、人格、记忆、表情、语音、翻唱、画图，然后调用 DSH 的会话让模型"说话"。

**当前状态：正常运行中**（bridge PID 8928，3100 端口 LISTENING，角色=小鲸鱼，模式=active）。

---

## 1. 30 秒上手（新对话先跑这三条）

```powershell
cd <项目目录>
# 1) 服务活着吗
(cmd /c "netstat -ano") | Select-String ":3100|:3000|:3001|:5099" | Where-Object { $_ -match 'LISTENING' }
# 2) 最近发生了什么
Get-Content state\qq-activity.log -Encoding UTF8 -Tail 25
# 3) 有没有报错
Get-Content state\bridge.log -Encoding UTF8 -Tail 40 | Select-String "error|失败|异常"
```

端口含义：`3100` 桥接控制台 · `3000` OneBot HTTP · `3001` OneBot WS · `5099` SnowLuma WebUI。

---

## 2. 环境

| 项 | 值 |
|---|---|
| 宿主 | Windows，7.15 GB 内存，**无独立显卡**，24 线程 |
| DSH | `0.1.7-rc.1`，装在 `D:\deepseek`，Web GUI `http://127.0.0.1:19387` |
| qq-bridge | 本项目，`<项目目录>`，版本 0.1.7，Node v24.21.0 |
| SnowLuma | `<工具目录>`（QQ 协议端），WebUI `:5099`，OneBot `:3000/:3001` |
| ffmpeg | `<ffmpeg目录>\ffmpeg.exe`（含 rubberband 滤镜） |
| Seed-VC | `<工具目录>`（本地歌声转换，CPU 跑） |
| demucs 环境 | `<项目目录>\.venv-demucs`（含 torch CPU、yt-dlp、demucs） |
| 账号 | 机器人 QQ `<机器人QQ>`（昵称"dsh是什么"），主人/管理员 `<管理员QQ>` |

**开机自启**：HKCU Run 项 `qq-bridge-autostart` → `autostart.ps1`，依次拉起 QQ → Ollama → SnowLuma → bridge → watchdog。

---

## 3. 目录与关键文件

```
<项目目录>\
├─ src\
│  ├─ bridge.js              ★ 主体（641KB，约 1.08 万行）：HTTP 控制台、消息收发、指令、调度
│  ├─ mcp-snowluma-safe.js   MCP 服务：把 QQ 能力暴露成 qq_* 工具给 AI（~35 个）
│  ├─ media-tools.js         语音/翻唱/画图 的调用封装（含缓存 key、参数拼装）
│  ├─ voice-core.js          TTS 与音频工具函数
│  ├─ dsh-client.js          与 DSH 的会话通信
│  ├─ sticker-lib.js         表情库：同步、匹配、备注
│  ├─ slang-learner.js       群聊黑话学习
│  ├─ token-ledger.js        token 记账
│  └─ model-prices.js        模型价格表
├─ cover.py                  ★ 翻唱主脚本：解析音源→demucs→Seed-VC→混音
│  ├─ aliyun_tts.py          ★ 说话：百炼 qwen-audio-3.0-tts-flash + 复刻音色 + 语气
│  ├─ speak_voice.py         Seed-VC 语音换嗓（兜底）
│  ├─ sing_aliyun.py / sing_phrase.py / sing_world.py / cover_tts.py / cover_local.py
│  │                         历史方案（已废弃，用户明确否决，勿再启用）
│  ├─ make-admin-doc.py      生成桌面《QQ机器人-管理员指令.docx》
│  ├─ config.json            ★ 主配置
│  ├─ state\                 ★ 运行状态（见第 6 节）
│  ├─ audio\voices\{v0,v1,v2}.wav   音色参考（v2 = 当前默认）
│  ├─ audio\downloads\       下载的原曲（会累积，可清）
│  ├─ roles\{小鲸鱼,猫娘,傲娇助手}.md  人格文件
│  └─ backups\               改动前备份
```

---

## 4. 已实现的功能（都在跑）

### 4.1 说话（TTS）
- 主链路：**百炼 qwen-audio-3.0-tts-flash + 复刻音色**（voiceId 在 `state/aliyun-voice.json`）
- 自动语气：按文字内容选 7 种语气之一（开心/兴奋/难过/温柔/撒娇/认真/惊讶），线索弱就不加
- 兜底：Seed-VC 换嗓 → edge-tts
- 计费：1 元/万字符（1 汉字=2 字符），已开通付费

### 4.2 翻唱（真换嗓，不是念歌词）
链路：**解析音源 → 截取 → demucs 分离 → Seed-VC 换嗓(8 步) → 与伴奏混音 → 发语音**

- 默认 15 秒，本机 CPU 约 2~3 分钟
- **伴奏音量 2.16**（人声 1.0），用户逐次调出来的定稿值
- 同一首可反复翻唱；并发互斥（同时只跑一个）
- 生成的文件**发完即删**

音源优先级：
```
有链接 → 直接取（抖音/快手=解析接口，B站/YouTube=yt-dlp，
                  QQ音乐=songmid 直接要 vkey，网易云=Meting，汽水=分享页 `_ROUTER_DATA` 自带的 audioWithLyricsOption.url）
无链接（纯歌名）→ QQ 音乐搜索（免费版优先）
                 └ 全是 VIP → 抖音搜索（Bing 视频搜索找抖音视频 → 解析 → ffmpeg 抽音轨）
```

### 4.3 表情
- 别人发表情 → 自动收藏（按 md5 去重，每小时最多 8 个）
- AI 回完话 → 按概率（默认 0.22）挑一个语境匹配的表情补发（中文 2-gram 打分）
- **发送用 `image` + `sub_type=1` + `summary:'[动画表情]'`** ← 这才是表情包，缺了就变图片

### 4.4 触发器（不用指令）
| 用户发什么 | 行为 |
|---|---|
| 音乐链接/音频文件 + "翻唱" | 自动翻唱 |
| 「翻唱 歌名」 | QQ 音乐 → 抖音兜底，再翻唱 |
| 以上两种可以分两条消息发（10 分钟内有效） | 记住音源等指令 |

### 4.5 其他
模型切换（API/本地 Ollama）、人格切换、群聊黑话学习、轻量记忆、超时/静默/潜水调度、token 记账、画图。

### 4.6 画图（生图）

- 主链路：**阿里云百炼 `qwen-image-3.0`**（`socialV2.draw.provider = "qwen"`）
  - 接口：`POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
  - 入参：`{model, input.messages[0].content[0].text, parameters:{size,n,prompt_extend,watermark}}`
  - 出参：`output.choices[0].message.content[*].image`（临时 URL）→ 下载存 `images/draw-<hash>.png`
  - **分辨率只有两档**：`720p` → 1280×720 / `1080p` → 1920×1080（默认 1080P，16:9）。
    两档都实测被 qwen-image-3.0 原样接受（出图尺寸与请求一致）；实测 720P 约 48 秒、1080P 约 54~81 秒
  - **Key 与语音共用**：`state/aliyun-key.txt`（utf-8-sig 读取），或环境变量 `DASHSCOPE_API_KEY`
  - 同一个 DashScope 账号：语音走 `services/audio/tts`，画图走 `services/aigc/multimodal-generation`
- 备用：`provider = "seedream"` → 火山方舟 Seedream **5.0 Flash**
  - 接口：`POST https://ark.cn-beijing.volces.com/api/v3/images/generations`
  - **要另一套 key**：`state/ark-key.txt`（UTF-8 无 BOM）或环境变量 `ARK_API_KEY`；百炼那把用不了
  - 模型：`doubao-seedream-5-0-flash-260915`（5.0 轻量/快速档，即「lite」那档）
  - 入参关键：`{model, prompt, size:"1920x1080", response_format:"url", watermark:false, output_format:"jpeg"}`
  - **实测**：720P 11 秒 / 162KB，1080P 9~10 秒 / 338KB；`output_format:"png"` 也支持（约 4.5MB）
- 备用：`provider = "seedream-pro"` → 火山方舟 Seedream **5.0 Pro**
  - 模型：`doubao-seedream-5-0-pro-260628`；**用第二把 key** `state/ark-key-2.txt` 或 `ARK_API_KEY_PRO`
  - **实测**：1080P 18~41 秒 / 460~520KB；中文书法、印章、题字明显比 Flash 准
  - 两把 key 能看到的模型集合完全相同（都是 137 个），差别只在档位/额度归属
- **坑**：方舟默认回 **jpeg**（不是 png），落盘时按 magic bytes 决定后缀（`draw-xxx.jpg`），
  否则扩展名与内容不符；两档缓存互不串味（tag 里带 provider + model）
- 兜底：`provider = "sdcpp"` → 本地 stable-diffusion.cpp（Q8 SD-Turbo，512×512，纯 CPU 约 20 秒，不花钱）
- 每日额度：`maxPerDay` 默认 **10 张**，按自然日归零，只有真正花钱生成才计数（缓存命中不占）。
  用完时不发请求，直接返回「今天的生图额度用完了」
- 缓存：同 prompt + 同 model + 同 size → 复用 `images/` 里的图
- 设置与用量：`state/draw-settings.json`（模型/分辨率/上限）、`state/draw-usage.json`（当日张数）
- 逻辑分两层：`src/draw-config.js`（设置 + 额度，可单测）、`src/media-tools.js`（三家 provider 实现）

### 4.7 视频（生视频）

**默认（2026-10-23 用户定的硬规则）：百炼 `wan3.0-video`，480P（`854*480`），4 秒（可调 2~30 秒，最长 30）。**

#### 三条铁律（别改回去）
1. **一次请求只生成一片**：`generateVideo` 里只提交一次；提交失败**直接抛错**，
   不许换尺寸/换参数再提交第二个任务（重试 = 重复扣费）。
   早先有过 `fallbackSizes` 自动回落逻辑，已**删除**。
2. **测试只走 `/video test`**：接口实测 `duration` 必须在 **[2,30]**（传 0.5 直接
   `InvalidParameter: duration must be -1 or in [2,30]`）——所以测试片是
   **生成 2 秒 → 本地 ffmpeg 剪成 0.5 秒再发**（`trimVideo()`，实测剪完 0.567 秒 / 2.8MB）。
   正常生成夹到 **2~30 秒**；`body.test=true` → `cfg.testMode` 走 2 秒路径。
3. **seedance 已搁置**：`socialV2.video.seedance.enabled=false`；
   `provider='seedance'` 时 `generateVideo` 直接抛「已搁置」，**不发任何网络请求**；
   `/video model seedance` 也被拒（不写 settings）。

#### A) 阿里云百炼 `wan3.0-video`（provider = `wan`，**默认**）
  - 提交：`POST /api/v1/services/aigc/video-generation/video-synthesis`，**必须带 `X-DashScope-Async: enable`**
    参数 `{model, input:{prompt}, parameters:{size:"854*480", duration:4}}` → 返回 `output.task_id`
  - 轮询：`GET /api/v1/tasks/<task_id>`，PENDING/RUNNING → **SUCCEEDED** 时给 `output.video_url`
  - 实测（旧 720P 请求）：3~5 秒约 **77~108 秒**出片；`usage.SR=1080`（**请求 720P 它仍按 1080p 出**）
  - **模型名大小写敏感**：`Wan3.0-Video-Prime` → `Model not exist`；正确写法全小写
  - **480P 是否被接受尚未实测**（改完就遇上欠费）。若返回 `InvalidParameter(size)` 就是它不认 854×480，
    需要换 `size`（可用 1280*720），但**不要**恢复自动重试

#### A2) 同接口另一档：`wan3.0-video-prime`（provider = `wan-prime`）
  - 同一套接口/同一把 key，只换 `model`；`/video model wan-prime`（别名 `prime`）

#### B) 火山方舟 seedance（**已搁置，勿启用**）
  - 代码还在（`generateVideoSeedance`），但 `DEFAULT_VIDEO.seedance.enabled=false` 且 dispatcher 直接拒
  - 原因：账号 <火山方舟账号> 未开通 seedance 全系（`404 ModelNotOpen`）；用户要求先搁置

#### 公共部分
- 发送：OneBot `video` 段 + `file://<绝对路径>`（实测 20MB 片子 11 秒发完；base64 会撑爆内存）
- 每日额度：`maxPerDay` 默认 **5 条**，`state/video-usage.json` 记当日条数，命中缓存不占额度
- 缓存 tag 含 provider + model（教训：改 tag 成分会让旧缓存全部失效，等于白花钱重生成一次）
- 设置与用量：`state/video-settings.json`（provider/开关/时长/上限，`/video` 写）、`state/video-usage.json`
- **欠费坑（2026-10-23 复现两次）**：百炼按量付费、没有免费额度。余额不足返回
  `400 Arrearage`。**第一次只拦视频，第二次连图片一起拦** —— 余额耗尽是账号级的，
  别以为「只有视频会挂」。桥接统一映射 HTTP 402 + 人话提示。
- **计费教训**：2026-10-23 我为跑通链路连着真生成了 4 条视频（含 1 条因缓存 tag 变更白跑的），
  直接把账号跑欠费。以后**任何验证一律用桩 fetch**，除非用户明确同意花钱。
- **已知接口限制**：`duration` 只接受 `-1` 或 `[2,30]` —— 0.5 秒做不到（`/video test` 是生成 2 秒再本地剪）。

#### 控制台（`/` 页面）里的生成能力面板
- 独立一级菜单 **「生成能力」（`data-view="media"` / `section-media data-page="media"`）**，
  `consolePages.media` 也登记了；进入该页会自动 `loadMediaSettings()`
  - 一开始它是塞在 `social-v2` 页**最底部**的，用户反馈「打开怎么没变化」——因为
    ①浏览器缓存了旧页面（`/` 当时没有任何缓存头），②卡片在整屏设置的下方要滚很久。
    两处都修了：见下面的 no-store，以及改成独立菜单。
- 接口：`GET|POST /api/socialV2/media-settings`（**已加入 `adminOnlyV2Paths`**，agent token 打不进来）
  - GET 返回 draw/video 的生效值 + 当日额度（`used/limit/remaining/exhausted`）
  - POST：`enabled` 写 `config.json` 的 `socialV2.draw|video.enabled`（热更新 `cfg`）；
    `provider/resolution/maxPerDay/duration/size` 写 `draw-settings.json` / `video-settings.json`
    —— **与 `/draw`、`/video` 指令共用同一份设置**，避免两份真相互相覆盖
  - 归一化：时长夹到 2~30、上限夹到 0~200（图）/0~50（视频）、`provider` 白名单（seedance 直接忽略）
- 工具开关区新增 `data-v2-tool="draw"` / `"video"` 两个勾（对应 `socialV2.tools.draw|video`）
- （发布版已移除截图：里面含本机昵称/群名/密钥尾号）
- 验证：接口 27 条断言（含越界夹取、seedance 被拒、页面元素存在）+ 真浏览器里点一次「保存」→ `✅ 已保存`
  且 `state/video-settings.json`、`state/draw-settings.json`、`config.json` 三处都符合预期

#### 打开控制台的命令
```
start "" "http://127.0.0.1:3100/?token=<state/console-token 的内容>"
```
也可以直接双击 `打开控制台.cmd`（同目录）：它从 `state/console-token` **现读**令牌再拼 URL，
所以令牌不会写死在脚本里。控制台令牌泄露等于管理端全权，别贴到群里/截图里。

> 小坑（已修）：`setConsolePage()` 原来写 `history.pushState({}, '', '#page')`，会把 `?token=` 丢掉，
> 用户一刷新就掉回「需要令牌」的 prompt。现在写成 `pathname + search + '#page'`。

> 小坑（已修）：`GET /` 原来不带任何缓存头，改完前端后普通刷新仍是旧页面
> （「我打开怎么没变化」）。现在回 `cache-control: no-store, no-cache, must-revalidate`
> + `pragma: no-cache` + `expires: 0`。

---

## 4.8 人格卡瘦身（2026-10-23，省 token）

- `roles/小鲸鱼.md` 从 **4,995 字符**压到 **1,515 字符**（-70%），
  二代模式每次注入的 `role.hint` 从 **4,994 → 1,514 字符**，约省 **2,300 tokens/次唤醒**。
- 压缩方式：删掉重复章节（"二/三/四"三节都在讲短句）、把黑名单压成一行、
  回复示例由 15 组砍到 6 组，保留全部**行为关键**规则：
  1~10 字、一条一行、不写括号内心戏、被怼顶回去、「蓝色大肥鱼」炸毛、
  引用判断（引用别人=不是叫你）、查资料可多说、偶尔叫「用户」、AI 味黑名单、越权拒绝。
- 注入是**热的**（`roleRawContent()` 用 `角色名:state.mtime:size:role.mtime:size` 做缓存 key，
  文件一改就失效），改完不用重启桥接。
- 验证：`GET /api/socialV2/prompt?key=private:...` 的 `role.hint` 实测 1,514 字符、含关键规则；
  备份在 `backups/roles/小鲸鱼.full-<时间戳>.md`（要回滚直接覆盖回 `roles/小鲸鱼.md`）。
- 注意：`role.maxInjectChars` 仍是 6000，那不是本次压缩的原因——**是卡片本身太长**，
  所以压缩卡片而不是下调上限（下调会直接截断掉后半张卡）。

---

## 4.9 清理与一代仿真下线（2026-10-23）

**一代仿真（`reserved`）整体下线**，DeepSeek娘聊天与全部新扩展（画图/视频/翻唱/语音/表情/黑话/生成能力控制台）不受影响。

### 删了什么（都在 `<工作区>` 内）
| 类别 | 内容 | 说明 |
|---|---|---|
| 入口 | `/api/social`、`/api/social/state`、`/api/social/flush` 4 个端点 | 现在返回 404 |
| 入口 | `isSocialEnabled()`、`socialLoopTick()`、`startSocialLoop()` 及其启动调用 | 5 秒心跳不再启动 |
| 入口 | 模式白名单 `reserved` | `MODES` 只剩 chat / closed-agent / reserved2 |
| 入口 | `handleIncoming` 里的 `if (isSocialEnabled())` 分支（76 行） | 一代的观望/活跃/退场状态机 |
| 死代码 | 18 个一代专属函数（enterActive/leaveActive/buildBatchPrompt/scheduleSocialReply/appendSummary/isMustReplyText…） | 逐条 `node --check` 校验后才删 |
| 预设 | `dsh/agent-presets/qq-chat/`（3 个文件）+ 产物 `plugins/qq-agent-presets/presets/qq-chat.patch.yml` | `build-agent-preset-patches.mjs` 的 `PRESETS` 改成只剩 `qq-chat-v2`；`--check` 通过 |
| 配置 | `config.json` 的 `social` 段 | 约 743 字节 |
| 控制台 | 导航项 + `consolePages['social-v1']` + `section-social-v1`（5.2KB）+ 一代模式按钮 + 一代预设下拉项 + `loadSocialForm`/`refreshSocialStatus`/`setSocialPhase` 及其绑定 | 现在 10 个页面，无「一代仿真」字样 |
| 文件 | `audio/downloads/*`（15MB 录音 + 测试歌）、`audio/t2/t3-*.mp3`、`audio/songs/tashanhe.lrc`、`audio/voices/v0.wav`、`audio/voices/v1.wav`、`audio/ref-voice-user.wav`、`audio/ref-voice.backup.wav`、`__pycache__/`（10 个 pyc）、`<工作区>\_demucs_test`（10MB） | 共释放约 **29 MB** |
| 脚本 | 6 个无任何引用的脚本（test-mcp-safe/exec/web-search/host、test-voice-preview、verify-agent-presets-017）+ 已废弃的 `test-preset-prompt.mjs` | 后者的前提（v1 预设）已不存在，从 audit 列表同步移除 |
| 文档 | README / docs/guides/DSH_SETUP.md 里的一代章节 | 标注「已下线」 |

### 保留了什么（故意不删）
- `audio/voices/v2.wav`、`audio/ref-voice.wav`：语音条与翻唱默认参考音，**删了会废功能**
- `.venv-demucs`（1.1 GB）：`cover.py` 的人声/伴奏分离，删了翻唱质量明显下降
- `videos/`（43 MB）、`images/`（17 MB）：生图/生视频缓存，**视频重生成要花钱**
- `backups/`：本次所有删除的备份都在这里（`pruned-*`、`*.before-v1-*`）

### 验证
- `node --check` 三个文件全绿；`test-audit-bridge` 全绿；`test-qq-preset-contract` 7/7
- `test-role-card` 恢复通过（角色卡小节名补回「去 AI 味」）
- 全套 audit **17/27**，与改造前 17/28 相比**没有新增失败**——剩下的都是既有环境红
  （`<工作区>\voice-tool` 不存在、DSH 插件清单漂移）
- 真浏览器里逐个切换 10 个页面：`brokenPages: []`，无 JS 报错
- 冒烟：v2 接口 200、v1 端点 404、音色库 2 条、角色 3 个、视频 wan/854*480/4s、画图 seedream

### 踩到的坑（写下来防复发）
1. **按行号删除会错位**：第一版演练用旧行号在新文本上 splice，结果"删掉"345 个函数、bridge 只剩 199 行。
   必须**每次只删一个、删完重算行号**，并且每步 `node --check`。
2. **删元素必须同时删绑定**：删掉 `section-social-v1` 后，顶部 `document.getElementById('socialSave').addEventListener(...)`
   变成 `null.addEventListener` → 整个主脚本抛错中断 → `consolePages` 停在 TDZ，页面看起来"能开但全是死的"。
   排查手法：列出所有 `getElementById('x')` 而 HTML 里没有 `id="x"` 的引用。
3. **共享管线里的 v1 残渣没动**：`pumpMux()`（DSH 事件泵）里仍有 `isSilentMarker()` + `socialState()` 分支，
   `deliverPrompt`/`appendRecentMessage` 等也被 v2 复用。一代已不可达（模式禁了、循环没启动），
   这些是**死代码但不敢硬删**——要彻底清需专门重构 + 更强的回归网。

---

## 4.9 改名：DeepSeek娘聊天 / 词汇新增，并移除“群内自动学黑话”（2026-10-23）

### 改名（只改展示名，标识符/配置键/接口路径都没动）
| 旧 | 新 | 出现位置 |
|---|---|---|
| 二代仿真 | **DeepSeek娘聊天** | 控制台菜单/页面标题/区块标题/模式按钮/预设下拉、`/api/mode` 文案、MCP 工具描述、README/HANDOFF |
| 黑话词库 | **词汇新增** | 控制台菜单/页面标题、页面说明、工具参考 |
| QQ Bridge | **QQ DeepSeek 聊天** | 控制台侧栏品牌、`<title>`、document.title 后缀、eyebrow、页脚、README 标题 |

> 运行模式标识仍是 `reserved2`（`state/mode.json` / `config.json` / 代码判断都不变），只是叫法变了。
> `package.json` 的包名仍是 `qq-bridge`——脚本、快捷方式、DSH 的 link 路径都依赖它，没改。

### 删除：群聊自动识别 / 学习黑话
| 删除项 | 位置 |
|---|---|
| `feedSlangWindow()`（把群消息塞进学习窗口）及其 2 个调用点 | `src/bridge.js` |
| `maybeQueueSlangExtraction()` + DSH 恢复后的补触发 | `src/bridge.js` |
| `runSlangExtraction` / `runSlangResearch` / `queueSlangTask` / `waitLearnerTurn` / `ensureSlangLearnerSession` / `invalidateSlangLearnerSession` / `allowSlangSubmit` | `src/bridge.js`（死代码清扫） |
| HTTP：`POST /api/slang/extract`、`/api/slang/research`、`/api/slang/config`、`POST /api/socialV2/slang/submit` | `src/bridge.js`（实测 404） |
| MCP 工具 `qq_slang_submit`（AI 主动提交陌生词） | `src/mcp-snowluma-safe.js` |
| 控制台：`立即提取候选` / `研究全部候选` / `批量送 DSH 深度研究` 按钮、`黑话系统参数`整块、工具开关 `qq_slang_submit` | `public/console.html` |
| `config.slang` 里的 `extractMinMessages` / `extractCooldownMs` / `inferenceThresholds` / `learnerPreset` / `workspaceTitle` / `autoResearch` / `enabled` | `config.json` |

### 保留（这些是“能用的部分”，别一起删）
- `GET/POST /api/slang`（列表 / **管理员手动新增**）、`/api/slang/clear`、`/batch-delete|confirm|reject`
- 词库文件 `state/slang.json`、已确认词条注入 `qq_get_prompt`（`withSlangContext` → `buildSlangContext`）
- `qq_slang_query`（AI 只读查询已确认词条）
- `src/slang-learner.js`：现在只有测试在用，保留（删了 `test-slang-learn.mjs` 会挂）

> ⚠️ **注入不要再被 `slang.enabled` 卡住**：原来 `withSlangContext` 里有
> `if (cfg.slang?.enabled !== false)`，而这个键原本兼管“自动学习”。移除自动学习后若把
> `enabled` 设成 false，会**连手动录入的词条一起不注入**（我这次踩到了，已改成无条件注入）。
> 现在 `config.slang` 只剩 `{ "injectMax": 8 }`。

> 现存 20 条 `status=candidate` 是历史自动提取的遗留数据（来源列显示“自动提取”）；
> 现在不会再有新增候选，管理员可以在「词汇新增」页用「批量删除候选」或「批量确认」清一轮。

### 验证
- `test-audit-bridge`、`test-token-economy`（36/36）、`test-reply-wait`（10/10）、`test-qq-preset-contract`（7/7）全绿
- 全套 audit **17/27**，与改动前一致（剩余 10 个是既有环境红：`<工作区>\voice-tool` 缺失 + DSH 插件清单漂移）
- 接口实测：`/api/slang/extract|research`、`/api/socialV2/slang/submit` → **404**；`GET /api/slang` → 20 条；手动新增 → 立刻出现在 `/api/socialV2/prompt` 的 `slang.entries` 里
- 浏览器实测：10 个页面逐个切换 `broken: []`，`qq_slang_submit` / `黑话词库` / `二代仿真` 字样均为 0

### 踩坑记录（很重要）
1. **删“绑定块”会连坐**：按行删 `document.getElementById('x').addEventListener(...)` 时，若括号匹配被   箭头函数里的嵌套 `{}` 带偏，会把紧邻的函数/变量声明一起吞掉（这次吞掉了
   `slangActiveTab`、`slangEntriesCache`、`slangSelected`、`slangModalId`、`slangModalMode`、
   `slangStatusLabel`），表现是页面能开但列表“加载失败”（`ReferenceError`）。
   **正确做法**：拿一份“改之前”的完整备份，比对函数清单，只允许“预期内的函数”消失；
   删完立刻在浏览器里 `refreshXxx()` 一次，确认不抛错。
2. 改名要连带替换 `document.title` 的拼接后缀，否则标签页标题还是旧名。

---

## 4.10 控制台新增「API Key + 模型」管理（2026-10-23）

生成能力页（`section-media`）现在能直接改云端密钥和模型，不用再手改 `state/*.txt`。

### 三个密钥槽位（文件 / 环境变量 / 用途）
| 槽位 | 文件 | 环境变量（优先于文件） | 谁在用 |
|---|---|---|---|
| `aliyun` 百炼 DashScope | `state/aliyun-key.txt` | `DASHSCOPE_API_KEY` | 画图 `qwen`、视频 `wan` / `wan-prime`、语音/翻唱 |
| `ark` 火山方舟 Flash | `state/ark-key.txt` | `ARK_API_KEY` | 画图 `seedream` |
| `arkPro` 火山方舟 Pro | `state/ark-key-2.txt` | `ARK_API_KEY_PRO` | 画图 `seedream-pro` |

### 接口
- `GET /api/socialV2/media-settings` 新增：`keys[]`（`configured` / `tail` 尾号 / `fromEnv` / `file` / `envVar` / `usedBy`）、`keySlots[]`、`drawModels[]`、`videoModels[]`，`draw.model` 直接给出当前型号
- `POST /api/socialV2/media-settings` 新增 `keys: { aliyun?: 'sk-...', ark?: '...', arkPro?: '...' }`
  - 传字符串 = 写入（trim + 换行，`mode 0o600`，先写 `.tmp` 再 rename，避免半截文件）
  - 传 `''` 或 `null` = 删除该密钥文件
  - 不传 = 不动；只传 `keys` 时不会覆盖 draw/video 参数
  - `draw.provider` 白名单扩成 `qwen | seedream | seedream-pro | sdcpp`
- 新增 `POST /api/socialV2/media-settings/test-key`（`{ which }`）
  - **只请求模型列表接口，不生成内容、不花钱**：
    `dashscope.aliyuncs.com/compatible-mode/v1/models` / `ark.cn-beijing.volces.com/api/v3/models`
  - 返回 `{ ok, status, ms, count }`；401/403 明确报“鉴权失败”
  - 实测：aliyun 178 个模型 109ms、ark 137 个 252ms、arkPro 137 个 180ms

### UI（`public/console.html`）
- 新分组「API Key（云端密钥）」：三行，各带 **已配置/未配置 + 尾号 + 来源**、密码输入框（留空不改）、**测试**、**清除**
- 密钥**永不回显**，只显示后 4 位；`autocomplete="new-password"` 防浏览器自动填充
- 画图分组新增「型号：」实时显示，切换后端立刻更新（`window.__mediaDrawModels` 缓存清单）

### 验证
- 写入通路：把当前 aliyun key 原样 POST 回去 → `keyResult.tail=gBD4`，文件内容逐字节不变
- 只传 `keys` 的 POST 不会动 draw/video：仍是 `seedream` / `wan 854*480 4s`
- 页面：3 行密钥正常渲染，画图型号 `doubao-seedream-5-0-flash-260915`、视频型号 `wan3.0-video`

> 安全提醒：控制台本身靠 `consoleToken` 保护，且 `media-settings` 在 `adminOnlyV2Paths` 里
> （agent token 打不进来）。密钥文件权限 600，**不要**把 `state/*.txt` 提交进版本库。

### 视频时长：单值，默认 4 秒，控制台可调（2~30 秒）

控制台只暴露**一个「时长」输入框**（后面带「秒」单位），不再有「最短/最长」区间概念；
默认 4 秒，可调范围 = 百炼接口硬边界 **2~30 秒**，超出自动夹取。

| 层 | 说明 |
|---|---|
| src/media-tools.js | DEFAULT_VIDEO.duration: 4、durationRange: [2, 30] |
| config.json | socialV2.video.durationRange: [2, 30]、duration: 4 |
| ideoCfg() | 读配置区间并夹进 2~30，额外暴露 durationApiMin/Max |
| POST /api/socialV2/media-settings | 只接受 ideo.duration（单值），按 ideoCfg() 区间夹取；**区间相关分支已删** |
| 控制台 | 一行：「尺寸 / 时长（秒） / 每日上限（条） / 今日用量」；「时长」标签与尺寸输入框留 22px+ 间距 |
| QQ 指令 /video duration N | 同一区间夹取，提示语报当前区间 |
| MCP qq_video | duration 接受 2~30，默认 4，超出夹取 |

实测（不花生成费）：默认 4 秒 / 区间 2~30；设 8 → 8；设 99 → 30；设 1 → 2；还原 4。

> 费用提醒：wan3.0-video 按秒计费，4 秒 → 30 秒是 7.5 倍价。默认 4 秒 + maxPerDay: 5 就是刹车。

### 顺手修的控制台布局问题
- `#section-media` 里曾多了一个 `</div>`（把「型号」从文字改成输入框时留下的），导致 API Key 区块被挤出卡片、
  在视口里被裁切；已修正（`div 14/14`、`details 3/3` 平衡）
- 这一页的保存栏由 `position:sticky` 改成 `static`，不再盖住最后一行密钥；卡片底部留 64px

---

## 5. 管理员指令（QQ 里直接发，仅 ownerQQ <管理员QQ>）

| 指令 | 作用 |
|---|---|
| `/reset`（`/new`） | 重置会话 |
| `/status` | 查看状态 |
| `/role <名字>` / `/role off` | 换人格 |
| `/silent`（`/quiet`） | 静默：只回管理员 |
| `/active`（`/speak`） | 退出静默 |
| `/model` `api` `local` `list` `1.5b` | 模型切换 |
| `/cover` `15` `voice` `voice v2` | 翻唱时长/音色 |
| `/sticker` `35` `off` `on` `collect off` | 发表情概率/开关 |
| `/draw` | 查看生图模型/型号/分辨率/今日用量 |
| `/draw model qwen` / `seedream` / `seedream-pro` / `sdcpp` | 切换生图后端（`pro`、`seedreampro` 都认） |
| `/draw res 720` / `1080` | 切换分辨率档位 |
| `/draw limit 20` | 改每日出图上限（0 = 当天不再生成新图） |
| `/video` | 查看视频开关/后端/型号/分辨率/时长/今日用量 |
| `/video model wan` / `wan-prime` | 切换百炼两档（seedance 已搁置，切不过去） |
| `/video duration 30` | 改时长，**2~30 秒**（默认 4） |
| `/video test` | 生成 **1 条 0.5 秒 480P** 测试片（唯一短时长入口） |
| `/video on` / `/video off` | 开关视频生成 |
| `/video limit 5` | 改每日视频条数上限 |

完整说明在桌面：`%USERPROFILE%\Desktop\QQ机器人-管理员指令.docx`（由 `make-admin-doc.py` 生成，改了指令要重跑；
**生成脚本要用自带 python-docx 的解释器**：`%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe make-admin-doc.py`，
系统 `python` 没装 python-docx）。

---

## 6. 关键配置与状态文件

`config.json` 里要留意的字段：

```jsonc
{
  "allow": { "private": [<管理员QQ>, <好友QQ>, <好友QQ>], "groups": [<群号>] },
  "ownerQQ": <管理员QQ>,
  "socialV2": {
    "voice": { "aliyun": { "enabled": true }, "tts": { "voice": "zh-CN-XiaoyiNeural" } },
    "sticker": { "autoSend": { "probability": 0.22 }, "autoCollect": { "maxPerHour": 8 } },
    "wake": {
      "preSleepWaitEnabled": true,
      "preSleepWaitMs": 120000,            // 沉睡前观察窗口 = 2 分钟（2026-10-22 由 5 分钟改）
      "recommendedSleepMinMs": 300000      // 推荐潜水最短时长，和上面的观察窗口无关，别混
    },
    "sing": { "enabled": false },          // 旧的"念歌词带调"已停用，勿开
    "cover": {
      "enabled": true, "seconds": 15, "autoSeconds": 15,
      "steps": 8, "instVol": 2.16, "dedupeMs": 0, "proxy": ""
    }
  }
}
```

`state/` 下重要的：

| 文件 | 内容 |
|---|---|
| `aliyun-key.txt` | 百炼 API Key（**utf-8-sig 读取**，曾有 BOM 坑） |
| `aliyun-voice.json` | 复刻音色（model / voiceId / reference） |
| `cover-settings.json` | `/cover` 改的值 |
| `sticker-settings.json` | `/sticker` 改的值 |
| `stickers.json` | 表情库（含备注/标签/使用次数） |
| `sticker-context.json` | 收藏表情时的语境（供匹配） |
| `model-mode.json` | 当前 API / 本地模型 |
| `current-role.json` | 当前人格 |
| `social-v2.json` | 会话状态（含 agentToken） |
| `console-token` | 控制台令牌 |
| `bridge.log` / `qq-activity.log` | 日志 |

---

## 7. 踩过的坑（重要，别重复犯错）

1. **固定工作目录导致缓存串味**：`cover.py` 曾用固定 `audio/_cover_work`，第二个歌命中了第一首的分离结果，导致"发错音频"。现在每次 `tempfile.mkdtemp`，且验证包络相关性再发。
2. **表情发成图片**：缺 `sub_type=1`。现在带 `sub_type:1 + summary:'[动画表情]'`。
3. **文件消息识别失败**：QQ 的 `file` 字段是不带扩展名的 id，真名在 `name`。必须两个字段分别判断扩展名。
4. **网易云外链返回 HTML**：`song/media/outer/url` 对无版权曲子返回 1 亿字节级的网页，看起来"下载成功"实际 0 秒。现在用 ffprobe 校验时长，优先 Meting。
5. **Bing 网页搜索抓不到抖音**：必须用 `cn.bing.com/videos/search`（一次能出上百条链接）。
6. **B站搜索 API 412 反爬**：先访问一次 bilibili.com 拿 buvid cookie 再调。
7. **正则捕获组**：`COVER_INTENT_RE` 自带捕获组，拼新正则要包成非捕获，否则拿到的是意图词不是歌名。
8. **路径重复拼接**：`audioDirAbs()` 已返回绝对路径，不要再 `path.join(ROOT, dir)`。
9. **PowerShell 坑**：内联双引号里的中文/反引号容易炸；`\n` 在单引号替换里会变成字面量。改 JS/Python 优先用 edit 工具或写脚本文件。
10. **torchaudio.save 需要 TorchCodec**：Seed-VC 里改用 `soundfile.write`。
11. **BigVGAN 与新版 huggingface_hub 不兼容**：给 `_from_pretrained` 补 `proxies/resume_download` 默认值。
12. **pip 装包 TLS 失败**：用 `--index-url https://mirrors.aliyun.com/pypi/simple/`。
13. **Windows 文件锁**：桌面 docx 被 Word/WPS 打开时 `PermissionError`，先关闭再覆盖。
14. **上传音频翻不了唱**（2026-10-22 修）：两条路各有坑——
    - AI 调 `qq_cover` 时它拿不到本地路径，原来 `singCover` 只认 `http(s)` / 绝对路径，
      直接把音频文件名（甚至空值）判为非法 → 模型回「还是不行，得给我绝对路径」，用户以为功能坏了。
      现在 `/api/socialV2/cover` 的 `source` 允许留空 / `last`：桥接会从 `pendingMusic`
      取出「刚收到的那段音频」自己下载再唱；实在没有才回 400 并提示「把音频发到聊天里再说翻唱」。
    - 自动触发那条路本来就好（文件段 → 记住音源 → 「翻唱」→ 开唱），但要求意图词命中，
      所以「只发文件不打字」不会唱，这是设计如此（避免误唱别人的语音）。
15. **审计脚手架的假绿**：`scripts/audit-bridge-harness.mjs` 早先没注入 `media-tools` / `tts.js`，
    导致 `coverCfg()` / `DEFAULT_TTS` 在 VM 里是 ReferenceError —— 翻唱与语音相关断言会
    以「看起来通过」或莫名报错的形式失真。已补 `...mediaTools, ...drawConfig, ...ttsLib`，
    并把 fake fetch 补上 `arrayBuffer()`，现在 `test-audit-bridge` 全绿（整套 17/28）。

---

## 8. 已验证 / 待验证

已验证 ✅
- 说话（百炼复刻音色 + 自动语气）、语气三档强度对比
- 翻唱：本地文件 / 抖音链接 / QQ音乐链接 / 纯歌名 / 汽水音乐链接
- 音源优先级：QQ 音乐免费版直取；QQ VIP → 抖音兜底（告白气球实测 187 秒）
- **汽水音乐链接直取原曲**：分享页 `_ROUTER_DATA` → `audioWithLyricsOption.url`（aac 音频直链），
  实测 `qishui.douyin.com/s/iXtdwffE/` 直接拿到「Take me hand - 半枝桃」262 秒 / 4.2MB，
  不再靠标题去别处猜（之前会拿到同名拼接混音）
- 表情：自动收藏、`sub_type=1` 发送、语境匹配
- 发完即删、启动清理、并发互斥、重复翻唱
- `/cover`、`/sticker` 指令写入与读取
- **画图接百炼 qwen-image-3.0**：同一把 key 同时跑 TTS 与生图（实测 key 能看到 178 个模型，
  含 `qwen-image-3.0` / `qwen-image-3.0-pro` / `wan2.7-image`）。中文招牌文字准确；
  `/api/socialV2/draw` 端到端出图并真发到 QQ（messageId 已回读）
- **分辨率 720P/1080P**：实测 1280×720（500KB，48 秒）与 1920×1080（3.6MB，54~81 秒），出图尺寸与请求一致
- **每日额度 10 张**：实测用满后新提示词被拒（不发请求）、缓存命中仍可发；跨天自动归零
- **`/draw` 子指令**：把桥接里那段实现原样抽出来配桩跑断言，全过（17 条 + 新增 pro 后 14 条）
  （res 720/1080、非法值被拒、limit 3/abc/500 夹紧、model qwen/seedream/seedream-pro/sdcpp、
  别名 pro/seedreampro、缺 key 提示、用量显示）
- 桌面《QQ机器人-管理员指令.docx》已重新生成（7 张表 / 71 段，含 `/draw model seedream-pro`）
- **seedream 5.0 两档都真实出图了**：
  - Flash（`state/ark-key.txt`）：720P 11 秒 / 1080P 9~10 秒
  - Pro（`state/ark-key-2.txt`）：1080P 18~41 秒，中文书法/印章明显更准
  - 两档都走 `/api/socialV2/draw` 端到端发到 QQ（`provider` 分别为 seedream / seedream-pro，
    messageId 已回读，额度从 4 记到 6/10）
  - 方舟默认回 jpeg，落盘按 magic bytes 定后缀，已验证扩展名与字节一致
- **修掉既有 bug**：发送接口里引用了收消息作用域的 `plainContent`（3 处），
  导致「消息已发出但工具返回 ReferenceError」，AI 以为没发出去又重试 → 群里重复消息。
  改成用刚发出去的内容作表情语境；实测发送接口恢复 `ok:true`
- **上传音频翻唱**（详见 §7 第 14 条）：
  - 自动触发：文件段 + 「翻唱」同一条 / 分两条，都在脚手架里复现并跑通（8 条断言）
  - `qq_cover` 留空 source：`/api/socialV2/cover` 实测返回 400 + 可操作提示；
    给真实绝对路径实测 HTTP 200、生成 124 秒、`verified:true`、发完即删
  - 真实管线（`singCover` → `cover.py`）用 `chaoxi.mp3` 跑通：6 秒/4 步，148 秒出 97KB 成品
- **视频生成接百炼 wan3.0-video-prime**（充值后复验通过）：
  - 模块层：真实生成 1 条（5 秒 / 20MB / 108 秒），同 prompt 再要 → 缓存 1ms，额度拦截生效
  - 桥接层：`/api/socialV2/video` 真实生成 3 秒片子（106 秒 / 已发 QQ / messageId 回读 / 额度 1→2 / 今日 2/5）
  - 错误码：额度用完 → **429**；账号欠费 → **402** + 人话提示（都实测）
- **视频改为「一次一片 / 480P / 2~30 秒」**（2026-10-23 用户要求，全部用桩验证，没花钱）：
  - 桩 fetch 跑 **13 条断言**：只提交 1 个任务；请求 10s→夹到 5s、1s→抬到 3s；
    测试模式固定 0.5s 且只一条；**被 API 拒绝后没有第二次提交**；`provider=seedance` 不发任何请求
  - `/video` 那段抽出来配桩跑 **12 条断言**：显示「一次只出一片/2~30 秒」、seedance 切换被拒且不写 settings、
    duration 9→5 / 1→3 / 4 正常、`/video test` 只调一次生成且带 `testMode`
  - 已删除 `fallbackSizes` 自动回落（那条会在被拒时提交第二个任务）

待验证 ⚠️
- **480P（854×480）是否被百炼接受没实测**：改完就遇上账号欠费。
  若报 `InvalidParameter(size)` 就说明它不认这个尺寸 —— 届时改 `size`（1280*720 肯定可用），
  但**不要**恢复自动重试，否则又变成一次请求两片。
- seedance **已按用户要求搁置**（账号未开通，`404 ModelNotOpen`）；代码保留但 dispatcher 直接拒绝。
- 快手链接（接口存在，没真实样本）
- **小红书 / 微博**（部分只验证到标题识别）
- 「纯歌名」时 QQ 音乐按「免费优先」排序，可能选到同名翻唱/拼接混音而不是原唱
  （实测：`Take me hand` → 慕川MIX 混音；`告白气球` → 二珂 翻唱版，原唱周杰伦是 VIP）。
  要改成「同名优先、全 VIP 才转抖音」需调 `cover.py` 的 `_qq_search` 排序，改动未做，等确认。
- seedream 只剩 `-5-0-260128` 没试，且它在模型列表里状态是 `Retiring`，别用
- `npm run test:audit` 本机 **16/28**，剩下 12 个红都是环境失配，不是回归：
  `<工作区>\voice-tool` 不存在（voice/encoding/console-static 等 7 个）、DSH 插件安装与工具清单漂移
  （audit-setup / setup-guards / preset-local-tools 3 个）、audit-bridge 的 `DEFAULT_TTS` 桩、
  preset-prompt 的 CRLF 合成 fixture。已用「换回旧版 bridge.js 也照样红」确认与近期改动无关。
- 长时间运行稳定性（内存是否泄漏）

---

## 9. 下一步可做

1. 快手/小红书真实链接实测，不行就补解析（汽水音乐已完成 ✅）。
2. `_qq_search` 排序：现在「免费优先」，纯歌名时可能选到同名翻唱/混音。改成「同名优先」后，
   若同名版本全是 VIP，会自然落到既有的抖音兜底——正好符合「全 VIP 才转抖音」的规则。等用户确认再动。
3. **seedream 落地**：拿到火山方舟 key → 写 `state/ark-key.txt` → 确认模型名 → `/draw model seedream`
   实测出图；不通就看 Ark 返回的错误（401=key 错，404=模型名/未开通）。
4. 翻唱提速：Seed-VC 步数、分块推理、或接云端 GPU。
5. `qq_cover` 暴露给 AI 时的参数校验（秒数上限、音色白名单）。
6. 表情匹配算法升级（现在是 2-gram 交集，可以加 embedding）。
7. 日志轮转与磁盘占用治理（`token-usage.jsonl` 已 157KB）。

---

## 10. 运维手册

```powershell
# 重启桥接（改完 bridge.js 必做）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'bridge\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# 等 ~30 秒，watchdog 会自动拉起；或手动：
Start-Process -FilePath "<工具目录>\node.exe" -ArgumentList "index.mjs" -WorkingDirectory "<工具目录>" -WindowStyle Hidden
node src\bridge.js

# 语法自检
node --check src\bridge.js
python -m py_compile cover.py aliyun_tts.py

# 改动前备份
Copy-Item config.json "backups\config.$(Get-Date -Format yyyyMMdd-HHmmss).json"

# 手动翻唱（不走 QQ）
python cover.py --source "歌名或链接或文件路径" --out audio\x.mp3 --seconds 15 --steps 8
```

**注意**：改 `cover.py` / `aliyun_tts.py` 不需要重启（每次现起 python 进程）；改 `src/*.js` 或 `config.json` 必须重启。

---

## 11. 用户的偏好（务必遵守）

- 说中文，给**具体证据**（日志、路径、JSON、实测数字），不要"应该/大概"。
- **改东西前先备份**；改完要验证，不能只说"已修好"。
- **不限制 CPU**（明确要求过），跑满就跑满。
- **生成的音频发完就删**，不要累积。
- 不要"念歌词"式唱歌；要真换嗓翻唱。
- 有链接就按链接取，只有没链接才搜索；搜索优先 QQ 音乐，全 VIP 才抖音。
- 提醒：我自己**听不到音频**，只能靠指标（时长、电平、F0、包络相关）判断，必要时如实说明。
- 桌面那三份文档（说明书/管理员指令/角色卡）随改动同步更新。

---

## 12. 2026-10-24 修复（30 秒视频 / 会话卡死 / 报错只给管理员）

| 问题 | 根因 | 修法 |
|---|---|---|
| 视频时长卡在 3~5 秒 | `qq_video` 工具说明写着「只允许 3~5 秒」，AI 照它拒绝 | 说明与兜底区间统一改成 **2~30 秒**（`src/mcp-snowluma-safe.js`、`src/bridge.js`、`src/media-tools.js`、控制台文案） |
| DSH 重启后 QQ 永久不回 | DSH 重启会杀掉在途回合，`turn/end` 不再到达 → `v2TurnStartAt`/`collectors` 成了僵尸 → 会话永久「繁忙」，消息只进内存队列 | ① DSH 断开/重连时 `resetStaleTurnMarkers()` 清僵尸并补发积压唤醒；② `isConversationBusyV2()` 加 30 分钟硬兜底 |
| 报错直接甩给群友 | 各处的 `sendToQQ(key, '⚠️ ...失败...')` 不看身份 | 新增 `sendErrorToKey()`：管理员全量、普通用户默认不发；开关 `security.errorsToOwnerOnly`（默认 true）。同时把 agent 回合错误写进 `state/bridge.log` |
| 整轮失败 `tool input is invalid JSON` | 模型把用户整段剧本（含【】、引号、换行）复制进工具参数 | 预设与人格卡加「工具参数硬规则」：压缩成一句话 ≤200 字，禁止整段复制、禁止换行/双引号 |

改完必须：**重启桥接**（代码）；**重启 DSH**（preset 与 MCP 工具说明在启动时注册）。
