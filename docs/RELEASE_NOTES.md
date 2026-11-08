# v0.1.21

两个界面 bug 修复，都出在 v0.1.20 的 UI 插入上。

## 1. 人格与角色的内容出现在每一个分栏

**原因**：v0.1.20 插入「按会话分配人格」卡片时，落点正好在 persona 那段的开标签中间：

```html
<!-- 坏的 -->
<section id="section-persona" <div class="card span-all" data-page="persona" hidden>
```

`<section>` 开标签被劈开后，这个段落**丢掉了 `data-page="persona"`**，于是切换页面时它不会被隐藏 —— 结果「按会话分配人格」在人设页之外的每一页都显示。

**修法**：把卡片提出来独立成块，并把 section 开标签补回来：

```html
<div class="card span-all" data-page="persona" hidden>…按会话分配人格…</div>

<section id="section-persona" data-page="persona" class="card span-all">
```

校验：

```
div: 243/243 ✅   section: 18/18 ✅
各页 data-page 元素: overview 6 / sessions 2 / persona 2 / social-v2 1 / media 1 /
                     slang 1 / reference 1 / starmap 2 / access 4 / operations 3 / usage 1
persona 只有 2 个元素，都带 hidden 或本身是 section ✅
```

## 2. 找不到「敏感词过滤」

**原因**：这一列确实渲染了，但排在能力列**最后**（第 10 列）。表格宽、卡片窄时会横向滚动，第一屏看不到。

**修法**：

- 把「敏感词过滤」挪到 **「会话」右边第一列**，并加了浅黄底色，默认第一屏可见
- 卡片说明里写明位置与语义（勾选=过滤，取消=不过滤；管理员默认不过滤）
- 说明末尾提示「表格较宽时可在区域内左右滚动」

## 版本

- `package.json` / README / README.en.md 版本号 → `0.1.21`

## 升级

```bash
git pull
# 重启桥接；控制台 Ctrl+F5 硬刷新（必须硬刷新，页面文件变了）
```

## 现在控制台的结构

```
运行总览 / 会话与审批 / 人格与角色（+ 按会话分配人格）/ DeepSeek娘聊天 /
生成能力 / 词汇新增 / ✦ 记忆星图 / 令牌与花费 / 访问与安全（+ 用户权限表，含敏感词过滤列）/
调试与运维 / 工具参考
```
