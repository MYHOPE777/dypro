# dypro 配置说明

本文对应项目根目录的 `.env.example`。本地运行时复制为 `.env`，然后按需要填写。服务端通过 `dotenv` 读取配置，浏览器不会收到这些变量。

如果现在只准备接入火山引擎，可以直接参考并复制 [`config/volcengine.env.example`](../config/volcengine.env.example)。该文件按“实时语音 → 豆包 → 方舟知识库 → TOS 归档 → 数据库预留”的顺序排列，并在每个参数旁标注获取位置、发送位置和是否必填；它是模板，不包含真实密钥。

## 1. 运行模式

| 模式 | 必填配置 | 行为 |
| --- | --- | --- |
| 本地演示 | 无 | 使用本地商品、规则和演示输入；云依赖显示为“待配置” |
| 本地实时直播 | `VOLC_SPEECH_APP_KEY`、`VOLC_SPEECH_ACCESS_KEY`、`DOUBAO_API_KEY`、`DOUBAO_ENDPOINT_ID` | 蓝牙麦克风经浏览器送入火山实时语音，豆包负责判定；云故障自动回退本地规则 |
| 本地实时直播 + 停播归档 | 上一行配置 + TOS 三项 | 停止收音后才上传音频和时间线；收音期间只写本地文件 |
| 多人局域网 | `AUTH_TOKEN_SECRET`、`AUTH_USERS_JSON` | 控制台启用登录、直播间授权和规则审核；正式使用必须 HTTPS/WSS |
| SaaS 预留 | `DATABASE_URL`、`REDIS_URL` 等 | 当前仅显示就绪状态，尚未替换本地 JSON adapter，不应误认为已连接数据库 |

本地最小配置可以保持所有云参数为空：

```dotenv
PORT=8787
TIMELINE_DATA_DIR=.data/timeline
PRODUCT_CATALOG_PATH=.data/products/catalog.json
RULE_CATALOG_PATH=.data/rules/catalog.json
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
| `TENANT_ID` | 标识，默认 `tenant-default` | 否 | 多租户预留字段。SaaS 接入数据库、对象存储、Redis 和知识库时必须继续透传。 |
| `RULE_REVIEWER_ACTOR_ID` | 账号 ID，默认 `owner` | 否 | 共享规则的审核人。多人模式下必须对应 `role` 为 `reviewer` 的账号。 |
| `SESSION_IDLE_TTL_MS` | 毫秒，默认 `1800000` | 否 | 最后一个页面断开后保留会话的时间，最小按 60 秒处理。超时后只清理内存会话，已写入的本地时间线不删除。 |
| `ARCHIVE_QUEUE_PATH` | 路径，默认 `.data/archive/queue.json` | 否 | 停播后 TOS 归档队列。失败任务带指数退避，服务重启后可继续。 |
| `KNOWLEDGE_SYNC_PATH` | 路径，默认 `.data/knowledge/sync.json` | 否 | 已发布/停用规则同步到方舟知识库的队列。待审核规则不会进入 upsert 队列。 |

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

### 2.3 火山引擎实时语音

| 参数 | 类型/默认值 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `VOLC_SPEECH_APP_KEY` | 字符串 | 实时模式必填 | 火山实时语音应用的 App Key，对应 WebSocket 请求头 `X-Api-App-Key`。 |
| `VOLC_SPEECH_ACCESS_KEY` | 字符串 | 实时模式必填 | 对应请求头 `X-Api-Access-Key`。不要放入前端。 |
| `VOLC_SPEECH_RESOURCE_ID` | 字符串，默认 `volc.bigasr.sauc.duration` | 否/按账号 | 已开通的实时语音资源 ID，对应 `X-Api-Resource-Id`。若控制台给出其他资源 ID，按控制台值替换。 |
| `VOLC_SPEECH_ENDPOINT` | URL，默认 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel` | 否 | 实时语音 WebSocket 地址。除非账号文档要求，否则不要改成 HTTP 地址。 |

服务端握手请求头还会自动生成 `X-Api-Connect-Id`，不需要配置。连接流程为：

1. 建立 WebSocket；
2. 发送 full client request，声明 `pcm_s16le`、16 kHz、单声道；
3. 发送 audio-only gzip 二进制帧；
4. 收到最终结果后写入时间线并触发合规分析。

浏览器会同时保留两条音轨：发送给 ASR 的 16 kHz PCM，以及蓝牙设备原始采样率 PCM。火山连接尚未 ready 时最多缓冲约 160 KB 音频，超过后会停止收音并提示连接异常。

### 2.4 豆包大模型

| 参数 | 类型/默认值 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `DOUBAO_API_KEY` | 字符串 | 实时判定/商品解析必填 | 方舟 API Key，通过 `Authorization: Bearer <key>` 发送。 |
| `DOUBAO_ENDPOINT_ID` | 字符串 | 实时判定/商品解析必填 | 方舟推理接入点 ID，作为请求体 `model`。不是模型展示名称，也不是知识库 ID。 |
| `DOUBAO_BASE_URL` | URL，默认 `https://ark.cn-beijing.volces.com/api/v3/chat/completions` | 否 | 方舟兼容 Chat Completions 地址。只有使用自建代理时才修改。 |
| `DOUBAO_TIMEOUT_MS` | 毫秒，默认 `2500` | 否 | 实时话术判定截止时间。超时、非 2xx、返回非 JSON 时自动使用本地规则，保证主播不停播。 |
| `DOUBAO_PRODUCT_PARSE_TIMEOUT_MS` | 毫秒，默认 `10000` | 否 | 商品粘贴识别的独立超时。失败时退回本地字段识别，并要求场控确认。 |

实时合规请求体由服务端生成，结构如下：

```json
{
  "model": "ep-xxxxxxxx",
  "temperature": 0.1,
  "max_tokens": 500,
  "messages": [
    {"role": "system", "content": "抖音直播合规审核规则..."},
    {"role": "user", "content": "当前商品：...\n主播原话：...\n方舟知识库召回证据：..."}
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

### 2.5 方舟知识库

方舟知识库在本项目中是“召回增强层”，精确规则仍以本地规则库为事实源。代码使用显式网关，避免依赖控制台未公开的内部 URL。

| 参数 | 类型/默认值 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `ARK_KB_RETRIEVE_URL` | HTTP(S) URL | 召回时必填 | 接收检索 POST 请求。必须和 `ARK_KB_API_KEY` 同时配置。 |
| `ARK_KB_INDEX_URL` | HTTP(S) URL | 规则同步时必填 | 接收已发布、停用、回滚规则的索引 POST 请求，可暂时留空。 |
| `ARK_KB_API_KEY` | 字符串 | 使用知识库必填 | 网关 Bearer 鉴权密钥。 |
| `ARK_KB_COLLECTION_ID` | 字符串，可空 | 否 | 方舟知识库集合/知识空间 ID，作为 `collection_id` 发送。 |
| `ARK_KB_TIMEOUT_MS` | 毫秒，默认 `1500` | 否 | 检索和索引请求超时；检索异常会快速降级，规则同步则进入重试队列。 |

检索网关收到的请求：

```json
{
  "collection_id": "kb-live-rules",
  "query": "主播原话",
  "top_k": 5,
  "filters": {"room_id": "room-default", "product_id": "serum"}
}
```

返回可以是 `items`、`data`，或 `data.items`。每项至少提供 `content` 或 `text`；可选字段为 `id`、`title`、`source`、`score`、`metadata`。

索引网关收到的请求：

```json
{
  "collection_id": "kb-live-rules",
  "operation": "upsert|remove",
  "document": {
    "id": "rule-xxxx",
    "room_id": "room-default",
    "scope": "room|shared",
    "version": 2,
    "enabled": true,
    "name": "内部处罚词",
    "pattern": "保证",
    "risk": "blocked",
    "reason": "具体违规原因",
    "alternative": "合规替代表达",
    "policy_ref": "内部收集规则",
    "room": {"id": "room-default", "name": "默认直播间", "accountName": "douyin-account"}
  }
}
```

网关返回 HTTP 2xx 即视为成功。规则同步任务会记录版本和 `updatedAt`，停用后重新启用会再次生成 upsert 任务。

### 2.6 TOS 原始音频归档

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

### 2.7 数据库与 Redis

`DATABASE_URL` 和 `REDIS_URL` 目前只用于开播检查和 SaaS 架构预留：

- `DATABASE_URL`：未来使用 PostgreSQL/MySQL 保存租户、直播间、商品、规则版本和审计事实。
- `REDIS_URL`：未来保存会话状态、采集租约、跨进程广播和任务协调。

当前代码不会通过这两个 URL 建立连接，也不会把本地 JSON 自动迁移到云数据库。填写它们不会让数据库状态变成“已接入”。

## 3. 推荐配置顺序

1. 先只填写本地路径，运行 `npm run dev` 验证商品、规则、演示输入和主播屏。
2. 填写火山实时语音四项中的 App Key、Access Key，确认蓝牙麦克风权限后测试收音。
3. 填写豆包 API Key 和 Endpoint ID，测试实时判定和商品粘贴识别。
4. 配置方舟知识库检索网关，先验证召回；索引网关可随后接入。
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

`/api/readiness` 会分别显示实时语音、豆包、认证、TOS、方舟知识库、数据库和 Redis 的配置状态；状态为“已配置”只表示环境变量完整，真实可用性仍需通过一次对应业务请求验证。

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
