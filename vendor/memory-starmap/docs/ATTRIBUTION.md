# 素材与第三方说明

## 项目来源

本仓库源自 **AstrBot**（[AstrBotDevs/AstrBot](https://github.com/AstrBotDevs/AstrBot)）的记忆系统实践：数据契约、记忆分层、插件骨架都跟着 AstrBot 的形态走。它跟 dsh 无关，不依赖 dsh，也不包含 dsh 的任何代码或配置。

## 前端

零第三方依赖：`web/index.html`、`web/app.js` 全部手写。没有 bundler，没有 node_modules。

## 背景视频

`web/assets/starmap_bg.webm` / `.mp4`：本项目自制。如需替换，保持同名即可，`index.html` 里只按这两个文件名引用。

## 演示数据

`demo/memories.jsonl`：本项目自造，内容为虚构记忆条目，仅用于跑通链路与演示密度，不含任何真实对话。

## 字体

不内嵌字体，走系统栈：`-apple-system / PingFang SC / Microsoft YaHei / system-ui`。因此不同系统字重略有差异，属预期。

## 参考与致谢

- 力导向布局的斥力分块与截断半径思路，参考 Fruchterman–Reingold 的经典实现与分析文章；
- 「先给节点稳定 key、坐标跨版本沿用」的增量布局做法，来自图布局增量化的通行实践；
- 三维投影与雾化衰减为手写实现，不依赖 three.js。
