# 语音与翻唱（VOICE）

> 这份文档只讲**语音相关**的链路和缺什么怎么补。部署整体流程看 [DEPLOY.md](DEPLOY.md)。

桥接里跟「声音」有关的能力有四条，**互相独立**，可以只开其中几条：

| 能力 | 入口 | 依赖 | 缺依赖时 |
|---|---|---|---|
| ① 念文本（TTS） | AI 工具 / 控制台「试发」 | 百炼 Key + ffmpeg | 直接报错（提示缺 key/ffmpeg） |
| ② 发已有音频 | `qq_send_voice` + 语音库 | `audio/` 下有音频文件 | 语音库为空，发不了 |
| ③ 用自己的音色说话 | `socialV2.voice.coverVoice` | Seed-VC（见下） | **自动降级**为「按音高差移调」，不报错 |
| ④ 翻唱一首歌 | `/cover`、`qq_cover` | Seed-VC + 可选 demucs | **直接失败**（没有降级） |

---

## 1. TTS：把文字变成语音

```jsonc
// config.json
"socialV2": {
  "voice": {
    "enabled": true,
    "tts": { "voice": "zh-CN-XiaoyiNeural" },   // 见 VOICES.txt 里的音色名
    "dir": "audio"
  },
  "tools": { "sendVoice": true }                // 让 AI 能主动发语音
}
```

- 合成脚本 `aliyun_tts.py` **只用 Python 标准库**（不需要 pip 装包），但需要百炼 Key（`state/aliyun-key.txt` 或 `DASHSCOPE_API_KEY`）
- 输出 mp3 会过一遍 ffmpeg（响度/时长），**ffmpeg 不在 PATH 会失败**

## 2. 发音频：语音库

把音频丢进 `audio/`（或 `audio/voices/`），文件名就是语音库里的名字：

```
audio/
├── ref-voice.wav        ← 换声/翻唱用的参考音（见第 3 节）
└── voices/
    └── v2.wav           ← 自定义音色，/cover voice v2 会用
```

- 限制：`maxSeconds`（默认 300 秒）、`maxBytes`（默认 20 MB）、`maxPerMinute`/`maxPerHour` 限流
- 控制台「语音面板」可以直接试发、dry-run

## 3. 换声 / 翻唱：Seed-VC

### 3.1 参考音（必须）

```
audio/ref-voice.wav   # 8~20 秒、干净人声、无背景音乐
```

**没有这个文件时**：`cover.py` 会尝试用 `edge-tts` 自动合成一段 10 秒的通用女声作为参考音（需要 `pip install edge-tts`）。
也就是说**你不放参考音也能跑通**，只是音色是通用 TTS 音色，不是「你的声音」。

### 3.2 两条引擎路线

| 引擎 | 需要什么 | 怎么开 |
|---|---|---|
| `local`（**默认**） | ① `.venv-demucs/Scripts/python.exe`（demucs + 依赖装在这里）② 环境变量 `SEEDVC_DIR` 指向 [seed-vc](https://github.com/Plachtaa/seed-vc) 仓库，且 `checkpoints/DiT_seed_v2_*.pth...pth` 存在 | 什么都不用改，配好这两样即可 |
| `hf`（云端） | `gradio_client` + `httpx`；免费 ZeroGPU 有额度，建议配 `HF_TOKEN` | 仅命令行可用：`python cover.py --engine hf ...`（**桥接不传这个参数**） |

> ⚠️ 桥接调用 `cover.py` 时**不传 `--engine`**，所以 QQ 里的 `/cover` 一定走 `local`。
> 没有 `.venv-demucs` + `SEEDVC_DIR` 时，`/cover` 会直接报「翻唱失败」。

### 3.3 demucs（可选，但强烈建议）

人声/伴奏先分离再换声，效果会明显更好；`separate()` 里判断 `.venv-demucs/Scripts/python.exe` 存在才调用，**不存在就跳过**（整曲直接换声，音质差一截）。

```powershell
python -m venv .venv-demucs
.\.venv-demucs\Scripts\pip install demucs yt-dlp
```

### 3.4 翻唱相关配置

```jsonc
"socialV2": {
  "cover": {
    "enabled": false,        // 默认关；开了才能在 QQ 里 /cover
    "pythonPath": "python",  // 用哪个解释器跑 cover.py
    "seconds": 30,           // 默认只处理前 N 秒
    "start": 0,              // 0 = 自动跳过前奏
    "separate": true,        // 是否先 demucs 分离
    "steps": 20,             // 扩散步数，越小越快、质量越低
    "instVol": 2.16,         // 混音时伴奏音量倍数
    "proxy": "",             // 例 http://127.0.0.1:7897（Python 的 TLS 会间歇性被掐）
    "maxPerHour": 10
  },
  "voice": {
    "coverVoice": { "enabled": false, "voice": "v2", "steps": 16 }
  }
}
```

> `voice: "v2"` 对应 `audio/voices/v2.wav`；`/cover voice <名字>` 可以切。

## 4. 依赖清单

```powershell
# 只发语音条（第 1、2 条能力）
pip install numpy                      # TTS 后处理要用
# 换声/翻唱（第 3、4 条）
pip install numpy edge-tts gradio_client httpx
pip install demucs yt-dlp              # 装进 .venv-demucs 更好
# 只有 sing_world.py 需要
pip install pyworld
```

ffmpeg（必需，除非你只发原始音频）：装好后把 `ffmpeg.exe` 放进 PATH，或设 `FFMPEG_PATH`。

## 5. 排障

| 现象 | 原因 / 解决 |
|---|---|
| 发语音报「TTS 未配置」 | 缺百炼 Key，或 `socialV2.voice.tts` 没开 |
| 语音发出去没声音/时长 0 | ffmpeg 不在 PATH；看 `state/bridge.log` 里的 ffmpeg 报错 |
| `/cover` 报「翻唱失败（退出码 1）」 | 缺 `.venv-demucs` 或 `SEEDVC_DIR`；先手动跑 `python cover.py --source x.mp3 --out y.mp3` 看具体错误 |
| 翻唱音色不像 | 参考音 `audio/ref-voice.wav` 太短/有伴奏；换成 8~20 秒干净人声 |
| 翻唱很慢 | `steps` 调小（16）、`seconds` 调小；CPU 跑本来慢 |
| 说话音色变调怪 | 这是 Seed-VC 不可用时的移调降级；配好 Seed-VC 即可 |
| 云端 HF 报 ZeroGPU 额度 | 设 `HF_TOKEN`（免费账号即可），或改用 `local` |

## 6. 合规提醒

声音克隆涉及**他人生物特征**。只对你有权使用的声音做克隆；不要把别人的声音做成语音包对外分发。
