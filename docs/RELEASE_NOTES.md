# v0.1.13

两个 bug 修复，都跟「AI 操作电脑」有关：**中文文件名/内容乱码**、**管理员会话完全不回消息**。

## 1. 中文乱码（cmd 代码页）

**现象**：让机器人读带中文名的目录/文件，返回「锟斤拷」式的乱码。

**原因**：`qq_admin_exec` 走 `cmd.exe`，默认代码页是 **936(GBK)**；Node 拿到字节后按 UTF-8 解码 → 中文全变替换字符。

**修法**（`src/bridge.js` → `runAdminCommand`）：

1. 命令前加 `chcp 65001>nul &`，让 cmd 尽量输出 UTF-8；
2. 仍然**抓原始 Buffer**，用 `TextDecoder('utf-8',{fatal:true})` 严格解码，失败再依次回退 `gbk → gb18030 → big5 → utf-16le`；
3. 子进程环境注入 `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1`，Python 脚本也不会再输出 GBK。

实测：

```
exec dir  → "测试文件-中文名.txt"                     ✅
exec type → "中文内容 abc 123 / 第二行：汉字显示测试"   ✅
fs list   → ["测试文件-中文名.txt"]                   ✅
fs read   → 中文内容完整                              ✅
```

## 2. 管理员会话一句话都不回（回归）

**现象**：v0.1.12 之后，给机器人发消息完全没有回复，日志里：

```
[reserved2] 计划唤醒异常 private:xxxx: adminCfg is not defined
```

**原因**：新增的「管理员会话·本机权限」提示里调用了 `adminCfg()`，但那个函数定义在 **HTTP 请求处理器的内层作用域**，而唤醒提示构建在外层 —— 取不到就抛异常，每轮唤醒直接失败。

**修法**：唤醒提示里不再依赖 `adminCfg()`，直接读 `cfg.admin` 判断 `enabled`。

## 3. 附带：管理员权限仍只对 ownerQQ 生效

```
群会话调用      → 403 只有管理员（ownerQQ）私聊可以使用本机操作
其他私聊调用    → 403 只有管理员（ownerQQ）私聊可以使用本机操作
无令牌          → 403 agent token 无效
管理员 exec     → 200  code=0
```

审计：`state/admin-audit.jsonl`。

## 升级

```bash
git pull
# 重启桥接（改的是代码）
node scripts/build-agent-preset-patches.mjs   # 预设若有改动再跑
# 重启 DSH（MCP 工具与预设提示在启动时注册）
```

**升级后建议重置一次会话**：控制台「会话与审批 → 重置」，或让小号发 `/reset`，
否则旧会话仍带着旧提示词（会出现「工具在但 AI 不用」的假象）。
