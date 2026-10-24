# v0.1.7

基于 [@Derpyu520](https://github.com/Derpyu520) 的 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 二次开发：把 QQ 接入 DeepSeek Harness（DSH），并补齐语音、翻唱、画图、视频四个生成能力。

## 相比上游新增

- 🎤 **语音**：百炼 TTS 朗读 / 发语音条；Seed-VC 换嗓（说话用你的音色）；语音库与限流
- 🎵 **翻唱**：`/cover`、`qq_cover` —— 下载/裁剪 → 人声分离 → 换音色 → 与伴奏混音
- 🖼️ **画图**：百炼 Qwen-Image 3.0 + 火山方舟 Seedream 5.0（Flash / Pro），可切分辨率与每日额度
- 🎬 **视频**：百炼 wan3.0-video / wan3.0-video-prime，2~30 秒可调、按秒计费、每日额度、缓存命中不计费
- 🎛️ **控制台**：新增「生成能力」页 —— 后端 / 型号 / 分辨率 / 时长 / 额度 / **API Key** 全部可视化，密钥只显示尾号，可一键免费测试
- 📚 **词汇（原「黑话」）**：**取消群内自动学习**，改为只在管理端手动录入；已确认词条仍注入上下文
- 🧹 **精简**：一代仿真（`reserved`）整体下线，只保留二代 `reserved2`；控制台页面改名「DeepSeek娘聊天 / 词汇新增」

## 安装

```bash
git clone https://github.com/firefly575/qq-bridge-pro.git
cd qq-bridge-pro
npm install
cp config.example.json config.json    # Windows: copy
# 填 ownerQQ / allow.private / allow.groups / snowluma / dsh
npm start
```

Python 可选依赖（只有语音相关功能需要）：`pip install -r requirements.txt`

## 文档

- **从零部署**：[docs/guides/DEPLOY.md](https://github.com/firefly575/qq-bridge-pro/blob/main/docs/guides/DEPLOY.md)
- **语音与翻唱**：[docs/guides/VOICE.md](https://github.com/firefly575/qq-bridge-pro/blob/main/docs/guides/VOICE.md)
- **哪些功能要自己补**：README 的「开箱可用性」章节
- **文档索引**：[docs/README.md](https://github.com/firefly575/qq-bridge-pro/blob/main/docs/README.md)

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
