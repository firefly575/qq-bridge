# v0.1.8

修复「视频生成时长被卡在 3~5 秒」的问题 —— 现在**支持 2~30 秒**，30 秒可以正常生成。

## 修复内容

问题不在生成逻辑（代码里早就是 2~30），而在**给 AI 看的工具说明**：`qq_video` 的描述里写着「时长只允许 3~5 秒」，导致 AI 自己把用户要的 30 秒压回去、甚至直接拒绝。

| 位置 | 改动 |
|---|---|
| `src/mcp-snowluma-safe.js` | `qq_video` 工具说明：`3~5 秒` → **`2~30 秒`**，并明确「用户要 30 就传 30，别自己往下压」 |
| `src/bridge.js` | 时长区间兜底 `[3,5]` → **`[2,30]`**；`durMin`/`durMax` 兜底 3/5 → 2/30 |
| `src/media-tools.js` | 同样兜底 `[3,5]` → **`[2,30]`** |
| `public/console.html` | 工具列表文案 `时长 3~5 秒` → **`时长 2~30 秒`** |
| `make-admin-doc.py` | 指令文档 4 处 3~5 → 2~30；新增 `--out` 参数 |
| `HANDOFF.md` | 6 处 3~5 → 2~30 |
| `docs/QQ机器人-管理员指令.docx` | 用新脚本重新生成 |

## 怎么用

QQ 里直接设：

```
/video duration 30      # 时长设为 30 秒（2~30 都能设，超出的会被夹到边界）
/video                  # 查看当前时长、额度、今日用量
/video limit 5          # 每日条数上限
/video test             # 生成 1 条 0.5 秒测试片（唯一短时长入口）
```

控制台「生成能力 → 视频」里的「时长」输入框同样支持 2~30 秒。

## 费用提醒

视频**按秒计费**，30 秒约为 4 秒的 7.5 倍价。默认时长仍是 4 秒，`maxPerDay: 5` 的每日上限照旧生效；
命中缓存的重复提示词不占额度。

## 安装 / 升级

```bash
git pull
npm install          # 依赖没变，一般可跳过
# 重启桥接（改的是代码）
# 重启 DSH —— 工具说明是 MCP 启动时注册的，不重启 AI 可能还按旧规则理解
```

Python 可选依赖见 `requirements.txt`；语音相关功能说明见 [docs/guides/VOICE.md](docs/guides/VOICE.md)，完整部署见 [docs/guides/DEPLOY.md](docs/guides/DEPLOY.md)。

## 已知缺件（仓库不含，需自行准备）

| 缺什么 | 影响 | 怎么补 |
|---|---|---|
| `audio/ref-voice.wav` | 声音克隆没有参考音（缺时会用 edge-tts 生成通用音色） | 放 8~20 秒干净人声 |
| `.venv-demucs` + `SEEDVC_DIR` | `/cover` 与「用自己的音色说话」不可用（说话会降级为移调） | 装 demucs / 下 seed-vc 权重 |
| `audio/` 音频 | 语音库为空 | 自己放音频 |
| `voice-tool/` | `npm run voice-gui` 不可用 | 用控制台语音面板 |

## 安全

仓库内**不含**任何 API Key、QQ 号、聊天记录、声音样本、生成产物。
`state/` 与 `config.json` 已在 `.gitignore` 中，`npm run privacy-scan` 全绿。
