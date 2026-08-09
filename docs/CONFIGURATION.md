# dypro 配置说明

本文对应项目根目录的 `.env.example`。本地运行时复制为 `.env`，然后按需要填写。服务端通过 `dotenv` 读取配置，浏览器不会收到这些变量。

如果现在只准备接入火山引擎，可以直接参考并复制 [`config/volcengine.env.example`](../config/volcengine.env.example)。该文件按“豆包大模型流式语音识别（ASR）→ 豆包大模型 → 方舟知识库搜索 → TOS 归档 → 数据库预留”的顺序排列，并在每个参数旁标注获取位置、发送位置和是否必填；它是模板，不包含真实密钥。

## 官方术语与参数映射

语音链路的正式产品名称是**豆包大模型流式语音识别（ASR）**，本项目接入其官方“双向流式模式（优化版本）” WebSocket（SAUC）。项目环境变量只是服务端配置入口，实际发送到火山引擎的名称保持官方定义：

| 配置用途 | 官方名称或字段 | 在本项目中的配置入口 |
| --- | --- | --- |
| 新版鉴权 | 请求头 `X-Api-Key`（App Key） | `X_API_KEY` |
| 兼容旧版鉴权 | 请求头 `X-Api-App-Key`、`X-Api-Access-Key` | `X_API_APP_KEY`、`X_API_ACCESS_KEY` |
| 流式识别资源 | 请求头 `X-Api-Resource-Id` | `X_API_RESOURCE_ID` |
| WebSocket 接入地址 | 豆包大模型流式语音识别官方 SAUC 地址 | `SPEECH_ENDPOINT` |
| 热词词表 | `request.corpus.boosting_table_id` / `boosting_table_name` | `BOOSTING_TABLE_ID` / `BOOSTING_TABLE_NAME` |
| 替换词词表 | `request.corpus.correct_table_id` / `correct_table_name` | `CORRECT_TABLE_ID` / `CORRECT_TABLE_NAME` |
| 识别上下文 | `request.corpus.context`，含 `context_type`、`context_data` | 由商品、纠错词和话术上下文生成 |
| VAD 判停 | `request.end_window_size` | `END_WINDOW_SIZE` |
| 语义合规推理 | 火山方舟 **Responses API** 请求体 `model`、`input`、`text.format` 等 | `ARK_MODEL` 等 `ARK_*` 配置 |

“实时”仅用于描述预警或界面更新速度，不作为语音产品名称；界面和日志统一使用“流式语音识别”。

## 1. 运行模式

| 模式 | 必填配置 | 行为 |
| --- | --- | --- |
| 本地演示 | 无 | 使用本地商品、规则和演示输入；云依赖显示为“待配置” |
| 本地直播 | `X_API_KEY`、`ARK_API_KEY`、`ARK_MODEL` | 蓝牙麦克风经浏览器送入豆包大模型流式语音识别（ASR），方舟负责判定；云故障自动回退本地规则 |
| 本地实时直播 + 停播归档 | 上一行配置 + TOS 三项 | 停止收音后才上传音频和时间线；收音期间只写本地文件 |
| 多人局域网 | `AUTH_TOKEN_SECRET`、`AUTH_USERS_JSON` | 控制台启用登录、直播间授权和规则审核；正式使用必须 HTTPS/WSS |
| SaaS 预留 | `DATABASE_URL`、`REDIS_URL` 等 | 当前仅显示就绪状态，尚未替换本地 JSON adapter，不应误认为已连接数据库 |

本地最小配置可以保持所有云参数为空：

```dotenv
PORT=8787
TIMELINE_DATA_DIR=.data/timeline
PRODUCT_CATALOG_PATH=.data/products/catalog.json
RULE_CATALOG_PATH=.data/rules/catalog.json
SPEECH_CORRECTION_CATALOG_PATH=.data/speech-corrections/catalog.json
```

## 2. 环境变量逐项说明

### 2.1 服务与本地数据

| 参数 | 类型/默认值 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 正整数，默认 `8787` | 否 | Node 服务端口。生产构建的页面、`/api/*` 和 `/ws` 都从此端口提供。 |
| `CLIENT_PORT` | 正整数，默认 `5173` | 否 | 开发模式前端端口。生产构建存在 `dist/client` 时不使用；需与 Vite 前端端口保持一致。 |
| `TIMELINE_DATA_DIR` | 路径，默认 `.data/timeline` | 否 | 保存每场 `timeline.jsonl`、16 kHz ASR PCM、原始采样率 PCM 和音轨元数据。原始音频必须保留时不要放在临时目录。 |
| `PRODUCT_CATALOG_PATH` | 路径，默认 `.data/products/catalog.json` | 否 | 直播间、长期商品库和本场清单的本地 adapter 文件。 |
| `RULE_CATALOG_PATH` | 路径，默认 `.data/rules/catalog.json` | 否 | 规则版本、启停状态、审核状态与审计日志的本地 adapter 文件。 |
| `PHRASE_LIBRARY_PATH` | 路径，默认 `.data/phrases/catalog.json` | 否 | 按直播间账号和主播隔离保存归档话术、参考状态及版本历史。 |
| `RULE_SYNC_QUEUE_PATH` | 路径，默认 `.data/rules/sync-queue.json` | 否 | 规则变更的本地异步同步队列。 |
| `PHRASE_LIBRARY_SYNC_QUEUE_PATH` | 路径，默认 `.data/phrases/sync-queue.json` | 否 | 主播话术变更的本地异步同步队列。 |
| `SPEECH_CORRECTION_CATALOG_PATH` | 路径，默认 `.data/speech-corrections/catalog.json` | 否 | 按直播间保存主播长期语音纠错词库。停播复核产生的错误词、正确词、确认次数、启停状态和最近来源会话都保存在这里。 |
| `TENANT_ID` | 标识，默认 `tenant-default` | 否 | 多租户预留字段。SaaS 接入数据库、对象存储、Redis 和知识库时必须继续透传。 |
| `RULE_REVIEWER_ACTOR_ID` | 账号 ID，默认 `owner` | 否 | 共享规则的审核人。多人模式下必须对应 `role` 为 `reviewer` 的账号。 |
| `RULE_LEARNING_MIN_CONFIDENCE` | 0.8-1，默认 `0.93` | 否 | 仅豆包明确标记为词级规则且达到此置信度时，自动生成待审核候选；句级和上下文语义永不自动发布为硬规则。 |
| `SESSION_IDLE_TTL_MS` | 毫秒，默认 `1800000` | 否 | 最后一个页面断开后保留会话的时间，最小按 60 秒处理。超时后只清理内存会话，已写入的本地时间线不删除。 |
| `DISPLAY_LINK_REGISTRY_PATH` | 路径，默认 `.data/display-links/registry.json` | 否 | 保存临时主播屏短地址及过期时间，使服务重启后未过期的主播屏继续连接原会话。 |
| `ARCHIVE_QUEUE_PATH` | 路径，默认 `.data/archive/queue.json` | 否 | 停播后 TOS 归档队列。失败任务带指数退避，服务重启后可继续。 |

相对路径按启动服务时的项目根目录解析。生产环境建议改为绝对路径，并确保运行账号有读写权限。音频与规则数据属于直播业务数据，建议放在受限磁盘并纳入备份。

### 2.2 多人登录与权限

| 参数 | 类型/默认值 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `AUTH_TOKEN_SECRET` | 字符串，至少 32 字符 | 多人模式必填 | 用 HMAC-SHA256 签发登录凭证。必须与 `AUTH_USERS_JSON` 同时配置，不能使用示例短字符串。 |
| `AUTH_TOKEN_TTL_HOURS` | 正数小时，默认 `12` | 否 | 登录凭证有效期。小于 1 的值按 1 小时处理。 |
| `ALLOW_INSECURE_AUTH` | `true`/`false`，默认 `false` | 否 | 允许明文 HTTP/WS 控制连接的临时开关。生产环境必须为 `false`，由 Caddy/Nginx/火山负载均衡终止 TLS。 |
| `AUTH_USERS_JSON` | JSON 数组，默认空 | 多人模式必填 | 账号、角色、房间和租户授权。留空时只允许 MacBook 本机控制，局域网设备只能访问主播屏。 |

`AUTH_USERS_JSON` 每个账号字段：

```json
[
  {
    "actorId": "owner",
    "displayName": "系统审核人",
    "passwordHash": "scrypt$...",
    "role": "reviewer",
    "roomIds": [],
    "tenantId": "tenant-default"
  },
  {
    "actorId": "operator-01",
    "displayName": "一号场控",
    "passwordHash": "scrypt$...",
    "role": "operator",
    "roomIds": ["room-default"],
    "tenantId": "tenant-default"
  }
]
```

- `actorId`：1-64 位字母、数字、下划线、点或短横线，必须唯一。
- `displayName`：页面展示名称，不能为空。
- `passwordHash`：只接受 `scrypt$盐$摘要`，不接受明文密码。生成命令：`npm run auth:hash -- '你的强密码'`。
- `role`：`reviewer` 可审核、驳回、回滚共享规则；`operator` 只能操作被分配的直播间。
- `roomIds`：直播间 ID 数组，格式为 `room-` 加 4-64 位小写字母、数字或短横线。审核人可访问授权租户内的全部直播间。
- `tenantId`：单租户授权；`tenantIds` 可替代它表示多个租户。不要同时用两个字段表达冲突范围。

### 2.3 豆包大模型流式语音识别（ASR）

| 参数 | 类型/默认值 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `X_API_KEY` | 字符串 | 新版控制台豆包大模型流式语音识别必填 | 豆包语音新版控制台的 App Key，对应 WebSocket 请求头 `X-Api-Key`。不要放入前端。 |
| `X_API_APP_KEY` | 字符串 | 旧版控制台可选 | 旧版控制台的 APP ID，对应官方请求头 `X-Api-App-Key`。仅当 `X_API_KEY` 留空时使用。 |
| `X_API_ACCESS_KEY` | 字符串 | 旧版控制台可选 | 旧版控制台的 Access Token，对应官方请求头 `X-Api-Access-Key`。仅当 `X_API_KEY` 留空时使用；旧版页面里的 Secret Key 不直接发送到 SAUC WebSocket。 |
| `X_API_RESOURCE_ID` | 字符串，默认 `volc.bigasr.sauc.duration` | 否/按账号 | 已开通的豆包大模型流式语音识别资源 ID，对应 `X-Api-Resource-Id`。并发版使用 `volc.bigasr.sauc.concurrent`，小时版使用 `volc.bigasr.sauc.duration`，实际以控制台为准。 |
| `SPEECH_ENDPOINT` | URL，默认 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async` | 否 | 豆包大模型流式语音识别（ASR）的“双向流式模式（优化版本）”WebSocket 地址。除非账号文档要求，否则不要改成 HTTP 地址。 |
| `BOOSTING_TABLE_ID` / `BOOSTING_TABLE_NAME` | 字符串，二选一 | 否 | 官方 `corpus.boosting_table_id` / `boosting_table_name`。每个流式语音识别请求只使用一张热词表，ID 优先。 |
| `CORRECT_TABLE_ID` / `CORRECT_TABLE_NAME` | 字符串，二选一 | 否 | 官方 `corpus.correct_table_id` / `correct_table_name`。每个流式语音识别请求只使用一张替换词表，ID 优先。 |
| `END_WINDOW_SIZE` | 正整数毫秒，默认 `800` | 否 | 官方 `request.end_window_size`，二遍模式的 VAD 强制判停时间，最小 200。 |

服务端握手请求头还会自动生成同一 UUID 的 `X-Api-Connect-Id` 和 `X-Api-Request-Id`，不需要配置。响应中的 `X-Tt-Logid` 会被保留到连接状态/错误信息，用于火山侧排障。连接流程为：

1. 建立 WebSocket；
2. 发送 full client request，声明 `pcm_s16le`、16 kHz、单声道；
3. 发送 audio-only gzip 二进制帧；
4. 收到最终结果后写入时间线并触发合规分析。

火山引擎服务端在约 8 秒未收到下一音频包时会返回 `45000081` 并结束会话。主播停顿期间，服务端会在连续约 400 ms 未收到浏览器音频后，以约 400 ms 间隔发送约 100 ms 的静音 audio-only 帧作为保活；若仍发生等包超时，会自动进行有限次数重连。保活帧不会写入原始音频、16 kHz ASR 音频或时间线。暂停、结束直播或连接关闭时会立即清理保活定时器。

浏览器会同时保留两条音轨：发送给 ASR 的 16 kHz PCM，以及蓝牙设备原始采样率 PCM。服务端先把音频包聚合成约 256 KB 的切片，通过独立队列异步写入 `.data/timeline/<sessionId>/audio.chunks/`；停播后再顺序合并为完整 PCM 并删除临时切片，合并完成后才进入归档队列。音频写入和合并不占用语义合规分析队列。豆包大模型流式语音识别连接尚未 ready 时最多缓冲约 160 KB 音频，超过后会停止收音并提示连接异常。

控制台的直播收音状态为：待开播、直播中、已暂停、已结束。设备测试只在浏览器本机计算音量，不上传也不写入音频文件；开始直播后才建立 ASR 和时间线。暂停会结束当前 ASR 流但保留同一场会话，继续时建立新的 ASR 流并保持直播绝对时间戳和音频采样位置；只有结束直播才进入停播归档队列。结束后可播放 16 kHz 识别音频并按片段时间戳修正文稿。

转录修正可以同时生成当前直播间的长期“错误词 → 正确词”记录。后续识别结果会在合规判断前按启用词条自动修正，正确词还会写入下一条 ASR 连接的官方 `request.corpus.context`；误学词条可在停播复核中停用，历史记录不会删除。

### 2.4 豆包大模型

| 参数 | 类型/默认值 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `ARK_API_KEY` | 字符串 | 实时判定/商品解析必填 | 方舟 API Key，通过 `Authorization: Bearer <key>` 发送。 |
| `ARK_MODEL` | 字符串 | 实时判定/商品解析必填 | 官方 Responses 请求体 `model`，可填写 Model ID 或已开通 Responses API 的 Endpoint ID，例如 `doubao-seed-2-1-pro-260628`。不要填写 API Key 名称；不支持 Responses API 的智能路由接入点会返回 `AccessDenied`。 |
| `ARK_BASE_URL` | URL，默认 `https://ark.cn-beijing.volces.com/api/v3` | 否 | 官方 SDK 的 `base_url`；服务端自动请求 `${ARK_BASE_URL}/responses`。 |
| `ARK_SERVICE_TIER` | `auto` 或 `fast`，默认 `auto` | 否 | 对应火山方舟 Responses API 官方 `service_tier` 参数。`auto` 使用在线推理（常规）；`fast` 使用在线推理（低延迟），需要控制台为当前模型开通低延迟服务。当前官方文档列出的 Fast 支持模型包括 `doubao-seed-2-1-turbo`、`doubao-seed-2-0-pro`、`doubao-seed-2-0-lite`、`doubao-seed-2-0-mini` 系列；实际以控制台为准。启用 `KNOWLEDGE_RESOURCE_ID` 时服务端自动使用 `auto`，因为低延迟 Responses API 不支持 `knowledge_search`。`fast` 超出限流时平台可自动降级到在线推理（常规）。 |
| `ARK_TIMEOUT_MS` | 毫秒，默认 `5000` | 否 | 实时话术判定截止时间。常规在线推理建议 5000；低延迟推理接入点可调低。超时、非 2xx、返回非 JSON 时自动使用本地规则，保证主播不停播。 |
| `ARK_COMPLIANCE_MAX_OUTPUT_TOKENS` | 160-800，默认 `200` | 否 | 合规 JSON 最大输出 token。系统要求豆包只输出结构化字段，减少无关解释可降低响应延迟；200 已覆盖当前短标题、原因和替换话术约束，若业务话术明显更长再调高。 |
| `ARK_LOCAL_FAST_PATH` | `true` 或 `false`，默认 `true` | 否 | 内置规则或已发布直播间规则命中 `warning` 时立即返回本地预警，不等待模型；`blocked` 本来就始终立即返回。设为 `false` 可用于对比模型结果。 |
| `ARK_COMPLIANCE_CACHE_TTL_MS` | 非负毫秒，默认 `30000` | 否 | 相同直播间、商品、规则版本和转录文本的短时结果缓存，减少 ASR 重复片段造成的重复请求；设为 `0` 关闭。缓存只存在当前服务进程内，不写入云端。 |
| `ARK_PRODUCT_PARSE_TIMEOUT_MS` | 毫秒，默认 `10000` | 否 | 商品粘贴识别的独立超时。失败时退回本地字段识别，并要求场控确认。 |
| `ARK_PHRASE_REWRITE_TIMEOUT_MS` | 毫秒，默认 `4000` | 否 | 主播话术库中单条豆包改写的超时；失败时保留原版本，可继续人工编辑。 |

实时风险档位由场控在本场会话中切换：

- `严审`：每句本地词级检查 + 每句豆包语义检查，携带同一商品最近约 90 秒上下文。
- `均衡`：每句本地词级检查 + 每句豆包语义检查，携带同一商品最近约 60 秒上下文。
- `优化`：每句本地词级检查；普通安全话术每三句抽样一次豆包，出现隐喻/规避信号时立即送审，携带最近约 45 秒上下文。

切换商品会重建上下文窗口，标记为“其他人”的转录不会进入主播商品语义上下文。模型结果分为 `term`、`sentence`、`context` 三类，只有 `term` 可进入自动规则候选。

合规请求体由服务端生成，结构如下。`store: false` 避免方舟为每句直播话术保存 Responses 上下文，未启用知识库时使用 `thinking: disabled`；`service_tier` 使用 `ARK_SERVICE_TIER` 的官方值。启用 `KNOWLEDGE_RESOURCE_ID` 时按官方知识库工具要求自动切换 `thinking: auto` 和 `service_tier: auto`：

```json
{
  "model": "doubao-seed-2-1-pro-260628",
  "service_tier": "auto",
  "store": false,
  "thinking": {"type": "disabled"},
  "text": {"format": {"type": "json_object"}},
  "max_output_tokens": 200,
  "input": [
    {"role": "system", "content": [{"type": "input_text", "text": "抖音直播合规审核规则..."}]},
    {"role": "user", "content": [{"type": "input_text", "text": "当前商品：...\n主播原话：..."}]}
  ]
}
```

模型应返回 JSON（可以包在 Markdown code fence 中，服务端会去除）：

```json
{
  "risk": "safe|warning|blocked",
  "title": "短标题",
  "reason": "具体原因",
  "alternative": "主播可立即照读的合规替代表达",
  "policyRef": "规则类别",
  "confidence": 0.95
}
```

`risk` 不是 `warning` 或 `blocked` 时按 `safe` 处理；本地规则风险等级不会被豆包结果降低。商品解析请求只要求结构化商品 JSON，价格/库存缺失时不得补造。

### 2.5 方舟私域知识库搜索（Responses API）

方舟知识库在本项目中是“召回增强层”，精确规则仍以本地规则库为事实源。通过官方 Responses API `knowledge_search` 工具调用，不使用自定义检索或规则索引网关。

| 参数 | 类型/默认值 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `KNOWLEDGE_RESOURCE_ID` | 字符串 | 使用知识库时必填 | 方舟控制台知识库资源 ID，对应官方 Responses API `tools[].knowledge_resource_id`。仅旗舰版知识库支持该工具。必须和 `ARK_API_KEY`、`ARK_MODEL` 同时配置。 |

启用后，合规请求会携带官方工具参数：

```json
{
  "tools": [{
    "type": "knowledge_search",
    "knowledge_resource_id": "你的知识库资源 ID",
    "limit": 10
  }]
}
```

同时发送官方请求头 `ark-beta-knowledge-search: true`。规则创建、审核、回滚和停用仍以本地/业务数据库为事实源；知识库只用于模型判断时的语义召回。

### 2.6 规则与主播话术异步同步

本地规则库和主播话术库是实时链路的事实源。以下参数同时填写 URL 与 KEY 后，服务端会把版本化变更事件写入本地 outbox，并在后台发送到自建网关：

| 参数 | 说明 |
| --- | --- |
| `RULE_SYNC_URL` / `RULE_SYNC_KEY` | 规则创建、智能发现、证据升级、审核、编辑、回滚和启停事件。 |
| `PHRASE_LIBRARY_SYNC_URL` / `PHRASE_LIBRARY_SYNC_KEY` | 话术归档、新增、改写、选为参考和回滚事件。 |
| `RULE_SYNC_TIMEOUT_MS` / `PHRASE_LIBRARY_SYNC_TIMEOUT_MS` | 单次请求超时，默认 5000 毫秒。 |

网关应按资源 `id + version + action` 幂等处理，再写入火山数据库或知识库。失败任务采用指数退避并在服务重启后继续；云端故障不会阻塞直播。知识库适合保存语义案例和主播参考素材，已发布词级规则仍应保留在本地/业务数据库快路径。

### 2.7 TOS 原始音频归档

TOS 不直接由实时链路调用。停止收音后，服务端先把会话 manifest POST 到归档网关，再使用网关返回的预签名 URL 流式 PUT 音频文件。

| 参数 | 类型/默认值 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `TOS_ARCHIVE_GATEWAY_URL` | HTTP(S) URL | 开启归档必填 | 自建/服务区归档网关 manifest 接口，不是 TOS Bucket 地址。 |
| `TOS_ARCHIVE_GATEWAY_KEY` | 字符串 | 开启归档必填 | 网关 Bearer 鉴权密钥。 |
| `TOS_ARCHIVE_TIMEOUT_MS` | 毫秒，默认 `10000` | 否 | manifest 和每个音频 PUT 的超时。 |
| `ARCHIVE_QUEUE_PATH` | 路径 | 否 | 本地归档队列位置，见 2.1。 |

manifest 请求体：

```json
{
  "sessionId": "live-abc123",
  "timeline": {"schemaVersion": 1, "timezone": "Asia/Shanghai", "events": []},
  "assets": [
    {"assetId": "asr", "byteLength": 32000, "sampleRate": 16000},
    {"assetId": "source-0", "byteLength": 96000, "sampleRate": 48000}
  ]
}
```

网关必须返回：

```json
{"uploadUrls":{"asr":"https://signed.example/asr","source-0":"https://signed.example/source-0"}}
```

随后每个 URL 接收一次 `PUT`，请求头为 `Content-Type: application/octet-stream` 和 `Content-Length`。归档网关负责把这些内容写入火山 TOS，并自行处理对象 key、租户隔离和幂等。主播重新开始收音时，在途上传会被取消，任务留在本地等待下一次停止。

### 2.8 数据库与 Redis

`DATABASE_URL` 和 `REDIS_URL` 目前只用于开播检查和 SaaS 架构预留：

- `DATABASE_URL`：未来使用 PostgreSQL/MySQL 保存租户、直播间、商品、规则版本和审计事实。
- `REDIS_URL`：未来保存会话状态、采集租约、跨进程广播和任务协调。

当前代码不会通过这两个 URL 建立连接，也不会把本地 JSON 自动迁移到云数据库。填写它们不会让数据库状态变成“已接入”。

## 3. 推荐配置顺序

1. 先只填写本地路径，运行 `npm run dev` 验证商品、规则、演示输入和主播屏。
2. 填写豆包大模型流式语音识别 `X_API_KEY`，确认 `X_API_RESOURCE_ID` 和蓝牙麦克风权限后测试收音。
3. 填写方舟 `ARK_API_KEY` 和 `ARK_MODEL`，测试实时判定和商品粘贴识别。
4. 如使用私域规则/案例召回，填写方舟知识库资源 ID，首句合规请求会通过 `knowledge_search` 验证。
5. 最后配置 TOS 归档网关，在停止收音后检查 `.data/archive/queue.json` 和网关接收记录。
6. 需要多人使用时，同时配置认证两项并在 HTTPS/WSS 反向代理后开放局域网访问。

## 4. 安全检查

- `.env`、密码哈希、API Key、归档网关密钥不得提交 Git。
- `AUTH_TOKEN_SECRET` 至少 32 个字符；不要使用仓库 README 中的占位值。
- 多人模式禁止 `ALLOW_INSECURE_AUTH=true` 长期运行。
- TOS 预签名 URL 只应短期有效，网关应校验 `sessionId`、租户和资产清单。
- 方舟知识库只存规则/案例副本，不要把原始音频或不必要的个人信息索引进去。

## 5. 配置后的验证

```bash
npm run build
npm test
npm start
curl http://localhost:8787/api/readiness
curl http://localhost:8787/api/health
```

`/api/readiness` 会分别显示豆包大模型流式语音识别、豆包、认证、TOS、方舟知识库搜索、数据库和 Redis 的配置状态；状态为“已配置”只表示环境变量完整，真实可用性仍需通过一次对应业务请求验证。

## 6. 版本发布与本地备份

每次功能更新完成后，在项目根目录运行一次发布命令。命令参数使用 SemVer：

```bash
# 修复/小改动：0.1.0 -> 0.1.1
npm run release -- patch

# 新功能：0.1.1 -> 0.2.0
npm run release -- minor

# 直接指定版本
npm run release -- 1.0.0
```

命令会依次执行：

1. 运行 `npm test` 和 `npm run build`，失败时不会改版本；
2. 同步更新 `package.json` 与 `package-lock.json`；
3. 创建 `release: vX.Y.Z` Git 提交和 `vX.Y.Z` 标签；
4. 在 `.git/backups/dypro-vX.Y.Z.bundle` 生成可迁移的本地 Git bundle；
5. 推送当前分支和标签到 GitHub。

网络不可用时，第 4 步仍会先完成，随后命令提示推送失败并保留本地提交、标签和 bundle。恢复网络后执行提示中的命令即可同步：

```bash
git push origin codex/local-first-foundation --follow-tags
```

如需只做本地版本发布、不连接 GitHub：

```bash
npm run release -- patch --no-push
```

不要手工修改版本号后跳过发布命令，否则容易缺少标签和本地备份。`.git/backups` 在 Git 元数据目录内，不会进入业务代码提交；建议定期把 bundle 复制到独立备份磁盘。
