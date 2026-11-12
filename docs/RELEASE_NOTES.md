# v0.1.22

修一个**会导致回复丢失**的 bug：事件流每次处理回复都抛异常中断。

## 症状

桥接日志里反复出现：

```
事件流中断: isSocialEnabled is not defined
连接 DSH 事件流…        ← 立刻重连，但这一轮的处理已经丢了
```

因为异常发生在 agent 回复处理路径上，该轮回复可能没发出去，且事件流每次都要重连。

## 原因

`src/bridge.js` 里有一处调用 `isSocialEnabled()`（判断「真人化社交模式」是否开启，决定回复是否走时间线多段发送），但**这个函数在文件里从来没定义过** —— 只要走到那条分支就是 `ReferenceError`。

## 修法

补上定义（与 `config.json` 里 `social.enabled` 的默认语义一致）：

```js
function isSocialEnabled() {
  return cfg.social?.enabled !== false;
}
```

## 顺带说明：一次「设备下线期间的消息没回复」

排查时确认了这条链路：**SnowLuma 掉线期间收到的消息不会补发**——桥接侧根本没收到事件，`state/social-v2.json` 里也没有任何未读记录，所以既没有"漏回"，也没有可以补回的原文。

处理办法（已对 `private:3964835308` 执行过）：用控制台的「后台提醒」接口
（`POST /api/console/notify-ai`）告诉 AI「你刚才掉线了，对方发的东西没收到」，让它自己用
`qq_send_message` 回一句。实际发出：

```
刚才我这边断了一下 你发的没收到
再说一遍呗
```

这个接口适合任何"消息在离线期丢失、想让 AI 主动说一句"的场景。

## 升级

```bash
git pull
# 重启桥接
```

## 验证

重启后日志里不应再出现 `isSocialEnabled is not defined`；`state/bridge.log` 里「连接 DSH 事件流…」也不该每 3 秒刷一次。
