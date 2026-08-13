# dypro v0.3 配置说明

当前版本是 MacBook 本地模块化单体：一个 Node 进程同时提供页面、`/api/v2` 和 `/ws/v2`，本地 SQLite 是唯一事实源。旧版 `.data` JSON/JSONL 不会自动迁移，也不会在 v0.3 运行时读取。

## 1. 本地运行

```bash
npm install
cp .env.example .env
npm run build
npm start
```

默认地址为 `http://localhost:8787`。健康检查：

```bash
curl http://localhost:8787/api/v2/health
```

## 2. 本地数据

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 页面、HTTP API 和 WebSocket 共用端口。 |
| `V2_DB_PATH` | `.data-v2/app.sqlite` | 直播间、商品、主播、规则、事件、投影、复核、纠错词和交付任务。SQLite 使用 WAL。 |
| `V2_AUDIO_DIR` | `.data-v2/audio` | 音频根目录，结构为 `<tenantId>/<roomId>/<sessionId>/`。 |

每场会保存两条 PCM：

- `source.pcm`：浏览器原采样率、16-bit little-endian、单声道，作为复核主音频。
- `asr-16k.pcm`：发送给豆包大模型流式语音识别的 16 kHz 副本。

复核页面通过鉴权接口读取 WAV 封装，不修改本地 PCM。音频和文案在人工确认前只保存在本机。

切换 v0.3 前应单独备份旧 `.data`。不要把旧目录改名为 `.data-v2`，两种格式不兼容。

## 3. 流式语音识别 2.0

| 参数 | 说明 |
| --- | --- |
| `X_API_KEY` | 新版 App Key，优先使用。 |
| `X_API_APP_KEY` / `X_API_ACCESS_KEY` | 旧版 APP ID + Access Token 兼容鉴权。 |
| `X_API_RESOURCE_ID` | 当前默认 `volc.seedasr.sauc.duration`，即流式语音识别 2.0 小时版。必须以控制台实际开通值为准。 |
| `SPEECH_ENDPOINT` | 默认 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`。 |
| `BOOSTING_TABLE_ID` / `BOOSTING_TABLE_NAME` | 火山自学习平台热词表，二选一。 |
| `CORRECT_TABLE_ID` / `CORRECT_TABLE_NAME` | 火山自学习平台替换词表，二选一。 |
| `END_WINDOW_SIZE` | VAD 判停毫秒数，默认 `800`，最小 `200`。 |

小时版按识别时长计费，适合当前单机直播；并发版按并发能力计费，只有同一账号需要多个识别流并行时再切换。出现 `45000292 quota exceeded for types: concurrency` 时，应先确认资源 ID 与已购买版本一致。

服务端会发送静音保活，自动处理 `45000081` 等可恢复断线。重连和暂停后的识别时间会叠加当前音频基准，不会从 0 重新开始。

历史复核产生的“错误词 -> 正确词”保存在 SQLite。下一次建立 ASR 连接时，启用的正确词会进入 `request.corpus.context`；识别返回后还会执行一次本地确定性替换。

## 4. 豆包合规与主播提词

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `ARK_API_KEY` | 空 | 火山方舟 API Key。 |
| `ARK_MODEL` | 空 | 支持 Responses API 的模型或 Endpoint ID。 |
| `ARK_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | 方舟 API 根地址。 |
| `ARK_SERVICE_TIER` | `auto` | 只有已开通低延迟服务时才使用 `fast`。 |
| `ARK_COMPLIANCE_MAX_OUTPUT_TOKENS` | `200` | 合规结构化输出上限。 |
| `ARK_COACH_MAX_OUTPUT_TOKENS` | `520` | 三段提词输出上限。 |
| `ARK_PRODUCT_PROFILE_TIMEOUT_MS` | `5000` | 商品行业、类目与合规画像识别超时；失败时使用本地兜底。 |
| `KNOWLEDGE_RESOURCE_ID` | 空 | 可选的旗舰版知识库搜索资源 ID。 |

最终转录到达后，本地规则和三段本地提词立即产生。语义合规与豆包教练使用两个独立模型任务并行运行，排队时间也计入 2 秒硬预算；超时保留本地结果，不阻塞收音。

风险等级当前固定为“严格”，所有场次逐句执行本地规则；本地无法确定的 `safe` / `warning` 送豆包复核。旧版 `.env` 中的 `ARK_LOCAL_FAST_PATH` 仅保留兼容，不会关闭不确定结果的语义判断。

## 5. 多人登录

本机单人使用时，`AUTH_TOKEN_SECRET` 和 `AUTH_USERS_JSON` 都留空。此模式只允许 MacBook 本机控制，局域网设备只能使用临时主播屏别名只读查看。

多人模式示例：

```dotenv
AUTH_TOKEN_SECRET=至少32字符的随机密钥
AUTH_TOKEN_TTL_HOURS=12
AUTH_USERS_JSON=[{"actorId":"owner","displayName":"审核人","passwordHash":"scrypt哈希","role":"reviewer","roomIds":[]},{"actorId":"operator-01","displayName":"一号场控","passwordHash":"scrypt哈希","role":"operator","roomIds":["room-default"]}]
RULE_REVIEWER_ACTOR_ID=owner
ALLOW_INSECURE_AUTH=false
```

生成密码哈希：

```bash
npm run auth:hash -- '至少8位的强密码'
```

- `operator` 只能查看和控制分配的直播间。
- `reviewer` 可复核、纠错、备注、人工确认和重试交付。
- 控制台自动把签名令牌放进 HTTP 和 WebSocket 请求；主播屏 URL 不包含令牌。
- 多人模式默认要求 HTTPS/WSS。本地隔离网络临时联调才可设置 `ALLOW_INSECURE_AUTH=true`。

## 6. 规则治理

- 人工创建的直播间规则立即发布，只作用于当前直播间。
- 豆包返回的词级、置信度不低于 `0.95` 的明确风险词可自动成为当前直播间规则，并持续累计证据。
- 句级和上下文级语义发现不会自动变成快规则。
- 未来提升为跨直播间共享规则时必须进入审核、版本和回滚流程；当前 v0.3 不自动做全局推广。

规则与主播话术都写入 SQLite，并创建 durable delivery job。当前直播处理只读取本地已发布规则，不依赖知识库或云数据库。

## 7. 历史复核与交付

场次结束后可修改转录、说话人和备注。任何修改都会递增 `contentRevision`、撤销旧批准并使旧上传任务失效。只有 reviewer 点击“确认并上传”才会为当前版本创建幂等任务，键为 `sessionId:contentRevision`。

v0.3 尚未实现真实云数据库、知识库或对象存储 adapter。交付任务会持久化为 `queued`，不会发送 Mac 本地文件路径，也不会误报 `synced`。接入云端时应实现 `DeliveryGateway`：先上传二进制音频或取得预签名地址，再提交包含远端资产引用的 manifest。

规则和主播话术沿用自动创建 durable job 的策略；场次音频与文案始终需要人工确认。

## 8. 运维与回滚

- 直播中或正在收尾时，后台交付暂停；所有场次暂停或结束后自动恢复。
- 结束阶段最多等待 ASR 排空 2 秒并接收最后一句。
- 事件提交 SQLite 成功后才广播，页面按单调递增 `sequence` 去重并在重连时补快照。
- 回滚 v0.3 时切回 `pre-architecture-rewrite` 标签并恢复旧 `.data` 备份；不要尝试把 `.data-v2` 反向导入旧版。
