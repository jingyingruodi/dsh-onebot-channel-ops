# dsh-onebot-channel-ops

> 偏运维向的 QQ / OneBot 11 接入插件，基于 [danshuyue/dsh-onebot-channel](https://github.com/danshuyue/dsh-onebot-channel) 的上游提交 `a53692f`（2026-11-02，上游 v0.20.3 发布前的基础；该提交自身 package 版本仍是 0.15.2）。
> 公开仓保留 `a53692f` 及之前的上游历史；本地私有 fork 的提交不在公开历史中。**不是上游 0.24.4 的版本线。**
> 面向私域、长期值守的 QQ 群/私聊接入：写者/读者权限分层、入站消息准入审查、定时接收模式。

## 上游基线（a53692f）

上游 README 在这之后已经改了很多版，单看当前上游文档会误以为本 fork 只是它的旧版。因此本仓库同时保留一份**上游 a53692f 的 README 快照**：

→ [docs/upstream-a53692f.md](docs/upstream-a53692f.md)

a53692f 时期的主要能力（快照里有完整说明）：

- QQ 私聊 / 群聊经 OneBot 11 接入 DSH；
- 入站 WebSocket 事件推送，HTTP 轮询兜底；
- 路由表：QQ 号 / 群 → DSH 会话；
- `qq_send`、`qq_emoji_search`、`qq_msg_history`、`qq_collect_face`、`qq_face_preview`、`qq_qzone_post`、`qq_wait`、`qq_pass`、`qq_close`、`qq_remember` 等工具；
- 沉默权（等 / 划走 / 收摊）、@ 人、引用回复、分条发送；
- 消息历史图片、收藏表情、QQ 空间说说；
- 关系记忆、主动搭话、上线补历史；
- OneBot 协议端配置与安全边界。

上游 a53692f 时还没有：

- readers（只读观察者）/ writer 权限分层；
- `wake / ambient / backlog / muted / off` 接收模式；
- 入站消息准入审查、隔离区、owner 白名单；
- 定时接收模式；
- 设置页「读者 / 定时 / 审查隔离」这些运维向界面。

这些是本 fork 在 a53692f 之后增加的部分。

## 本 fork 当前能力

- QQ 私聊 / 群聊经 OneBot 11 接入 DeepSeek Harness；
- 一个 peer 一个 writer，多个 reader 只读观察；
- 接收模式 `wake / ambient / backlog / muted / off`；
- 外部消息准入审查：逐条审查、失败 hold、隔离区、owner 白名单、图片审查；
- 定时接收模式：周几 + `HH:MM`，支持 set / restore、记录变更前状态、停机补恢复；
- 设置页「QQ 桥接」：绑定、读者、定时、审查隔离、节奏与高级配置；
- `qq_send`、`qq_read`、`qq_schedule`、折叠转发、表情、戳一戳等工具。
- 当前群消息引用其他消息时，会读取引用预览；找不到时明确提示“可能是 QQ 未登录/OneBot 断线期间的消息”。

## 前置条件

需要先跑一个 OneBot 11 协议端（SnowLuma / LLOneBot / NapCat 等），把插件的 `onebotHttp` / `token` 指过去。插件不读 QQ 密码。

- NapCat 通常需要 `onebotHttpMode: "path"`；用 SnowLuma 风格时才用 `body`。用错会「探活成功、发送成功，但 QQ 没消息」。
- 不要在这个 profile 里点 WebUI 的插件升级/重装：包名与 npm 同名，pnpm 全量解析可能把本地 fork 换回 npm 旧版。

## 安装

本包**不使用 npm 同名版本**。请从本地源码或 tarball 安装到 DSH profile：

```bash
npm pack
dsh plugin --profile web add ./dsh-onebot-channel-0.21.20.tgz
```

DSH 要求：

```text
package.json name = 安装目录名 = cordis.patch.yml name = dsh-onebot-channel
```

不要改包名；仓库名和版本线用 `dsh-onebot-channel-ops` / `v0.21.x` 区分。

## 配置

配置默认在 `~/.dsh/qq-bridge.config.json`，不在插件目录里。设置页可改大部分选项；敏感 token 不回显。

## 本地主动发消息接口

默认监听 `127.0.0.1:39273`，用于 DSH 之外的本机程序发消息。接口强制：

- `Content-Type: application/json`；
- `Origin` 只能是本机端口（浏览器跨站请求 403）；
- body 上限 64 KB；
- 可选 `sendApiToken`，设置后必须带 `X-DSH-Send-Token`。

```bash
curl -X POST http://127.0.0.1:39273/send \
  -H "Content-Type: application/json" \
  -d '{"text":"内容","user_id":"对方QQ号"}'
```

## 安全边界

插件运行在 DSH 进程内，拥有 DSH 能触及的权限；它不是进程级沙箱。入站审查是“消息准入”层，不替代宿主沙箱。

## License

MIT。保留上游原始版权声明；见 [LICENSE](LICENSE)。

## 公开历史

本仓库历史包含：

- 上游 `a53692f` 及之前的公开提交；
- 本 fork 的脱敏快照提交（含 README 修正）。

不包含私有 fork 的开发历史、私有文档、真实 QQ/群号、服务器地址或测试记录。快照中的上游历史文档仍按上游当时的公开内容保留。
