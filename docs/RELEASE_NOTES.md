# v0.1.18

文档同步版：把 v0.1.11 ~ v0.1.17 期间新增的能力全部写进 README，版本号对齐到 `0.1.17`。

## 本版改了什么

**只动文档与版本号，不动运行逻辑。**

- `README.md`
  - 版本号 `0.1.7` → `0.1.17`
  - 控制台页面清单加入「✦ 记忆星图」（十个 → 十一个页面）
  - 新增章节 **记忆星图与用户权限（v0.1.15 起）**：
    - 记忆星图：分栏位置、交互键位、数据来源、产物路径、Python+numpy 依赖
    - 记忆分组：默认各自独立、分组后共享、DSH 上下文仍隔离
    - 用户权限：7 项能力矩阵、批量修改、管理员恒开、AI 无法自我提权
    - 管理员本机操作：4 个工具、三重校验、审计日志
  - 目录结构补 `scripts/build-starmap.mjs`、`vendor/memory-starmap/`、`state/starmap|memory-groups|permissions|admin-audit`
  - 开箱可用性表补「用户权限」「管理员本机操作」；「需要额外准备」补「记忆星图（需 numpy）」
  - Python 依赖说明改为「语音相关 + 记忆星图」
- `README.en.md`
  - 版本号同步为 `0.1.17`（DSH 的 0.1.7 保持不动）
  - 末尾新增英文小节 **Memory StarMap & per-user permissions (since v0.1.15)**
- `package.json`：`version` → `0.1.17`

## 回溯：v0.1.11 ~ v0.1.17 都加了什么

| 版本 | 内容 |
|---|---|
| v0.1.11 | 管理员本机工具（exec/fs/download/install，仅 ownerQQ + 审计）；修 dsh-purge 导致的 DSH 401；视频 2~30 秒 |
| v0.1.12 | 修预设安全规则与管理员工具冲突（保留「你没有本地工具」不变量 + owner 例外） |
| v0.1.13 | 修 cmd 中文乱码（Buffer + GBK 回退）；修 `adminCfg` 作用域回归（唤醒全挂） |
| v0.1.14 | 按用户权限（7 项能力、控制台勾选、批量、服务端强制） |
| v0.1.15 | 记忆星图分栏 + 记忆分组 + 星图权限（vendor memory-starmap） |
| v0.1.16 | 修星图 iframe 加载失败（cache-buster + 看门狗重试 + 请求日志） |
| v0.1.17 | 修星图内嵌失败（`X-Frame-Options: DENY` → `SAMEORIGIN` + `frame-ancestors 'self'`） |

## 升级

```bash
git pull
python -m pip install numpy   # 只有记忆星图需要
# 重启桥接；控制台 Ctrl+F5 硬刷新（页面文件变了）
```
