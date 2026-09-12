# YouTube Max Quality for Loon

当前阶段：Probe（只读探测版）。

目标：验证 YouTube 官方 iOS/iPadOS 客户端在非 Premium 账号播放时，`player` / `get_watch` 响应中是否仍下发 `1080p Premium` / Enhanced Bitrate 或其他最高画质标记。

## 一键导入

插件 Raw 地址：

https://raw.githubusercontent.com/xlmc/xlmc.github.io/main/loon/youtube-max-quality/YouTube-Max-Quality.plugin

Loon URL Scheme：

loon://import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fxlmc%2Fxlmc.github.io%2Fmain%2Floon%2Fyoutube-max-quality%2FYouTube-Max-Quality.plugin

通用链接：

https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fxlmc%2Fxlmc.github.io%2Fmain%2Floon%2Fyoutube-max-quality%2FYouTube-Max-Quality.plugin

## 使用

1. 安装插件并保持“启用探测”“调试日志”“结果通知”开启。
2. 确认 Loon MitM 证书已安装、信任并启用。
3. 完全关闭 YouTube App 后重新打开。
4. 使用非 Premium 账号播放一个已知支持 1080p 的普通视频。
5. 若响应中识别到 Premium 或高清画质标记，Loon 会发送通知；详细内容见脚本日志中的 `[YT Max Quality Probe]`。

## 当前行为

- 读取 `youtubei.googleapis.com/youtubei/v1/player` 与 `get_watch` 的二进制响应。
- 扫描 `1080p Premium`、`Premium`、`enhanced bitrate`、4320p/2160p/1440p/1080p/720p 等可见标记。
- 不修改请求或响应，不改变 YouTube 播放行为。
- 探测确认后，再升级为“始终选择当前视频可用的最高画质”正式版。

## 注意

如果完全没有触发脚本，可能是 YouTube 使用 QUIC/HTTP3 绕过了当前 MitM 链路；届时再针对 YouTube 增加最小范围的 QUIC 回落规则，不在 Probe v1 中全局禁用 UDP 443。
