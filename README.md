# 合规台 · 抖音直播实时合规预警

一个面向直播间的本地局域网工具：MacBook 采集蓝牙麦克风，火山引擎实时语音模型转录，豆包大模型判断抖音直播话术风险，主播在 MacBook 或 iPad/外接显示器上即时看到合规替代表达。

## 快速启动

```bash
npm install
cp .env.example .env
npm run dev
```

打开启动日志中显示的 `http://<MacBook局域网IP>:5173` 进入控制台（MacBook 本机也可以用 `http://localhost:5173` 收音）。点击“选择输入设备”选择已连接的蓝牙麦克风，再点击“开始收音”。右上角“主播屏”会自动生成 MacBook 局域网地址的大字提词页面；将该地址在同一 Wi-Fi 下发给 iPad 或外接显示器即可，iPad 不要使用 `localhost` 地址。

没有配置密钥时，控制台仍可用“演示输入”按钮验证完整的预警和提词流程，结果会标注为 `LOCAL GUARDRAIL`。正式接入时，把火山引擎控制台提供的实时语音 App Key、Access Key，以及豆包/Ark 的 API Key 和 Endpoint ID 写入 `.env`，密钥只在 Node 服务端使用，不会下发到浏览器。

## 设备与网络

- 蓝牙麦克风需要先在 macOS “系统设置 → 声音 → 输入”中连接。浏览器控制台首次收音会请求麦克风权限。
- 控制台建议直接在 MacBook 的 `localhost` 打开；iPad 只访问主播屏，不需要麦克风权限。
- iPad 与 MacBook 需要在同一局域网。若系统防火墙拦截，请允许 Node 接收局域网连接。
- 浏览器收音使用 16kHz、单声道 PCM，服务端按火山实时语音 WebSocket 协议发送 gzip 二进制帧。

## 生产构建

```bash
npm run build
npm start
```

`npm run build` 会把前端产物放到 `dist/client`，Node 服务会在有该目录时同时提供静态页面。

## 火山引擎参数

实时语音连接使用 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`，默认资源 ID 为 `volc.bigasr.sauc.duration`。服务端实现了官方协议中的 full client request、audio-only request、gzip 压缩和最终帧标记；如果账号开通的是其他资源 ID，只需修改 `VOLC_SPEECH_RESOURCE_ID`。
