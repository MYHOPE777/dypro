# dypro · 抖音直播合规预警

一个面向直播间的本地局域网工具：MacBook 采集蓝牙麦克风，通过豆包大模型流式语音识别（ASR）转录，再由火山方舟 Responses API 调用豆包大模型判断抖音直播话术风险，主播在 MacBook 或 iPad/外接显示器上即时看到合规替代表达。

本项目使用的火山引擎官方名称与协议字段如下：

| 本项目中的能力 | 火山引擎官方名称/字段 |
| --- | --- |
| 语音转写 | **豆包大模型流式语音识别（ASR）**，官方“双向流式模式（优化版本）” WebSocket 接口 |
| 流式识别鉴权 | `X-Api-Key`（新版 App Key）；旧版为 `X-Api-App-Key` + `X-Api-Access-Key` |
| 识别资源 | `X-Api-Resource-Id`；豆包流式语音识别模型 1.0 使用 `volc.bigasr.sauc.*`，模型 2.0 使用 `volc.seedasr.sauc.*` |
| 热词 | `request.corpus.boosting_table_id` 或 `request.corpus.boosting_table_name` |
| 替换词 | `request.corpus.correct_table_id` 或 `request.corpus.correct_table_name` |
| 上下文 | `request.corpus.context`，其中使用官方 `context_type` / `context_data` |
| 语义合规判断 | **火山方舟 Responses API**，请求体使用官方 `model`、`input`、`text.format`、`max_output_tokens` 等字段 |
| 知识库检索 | 火山方舟 Responses API 官方 `knowledge_search` 工具及 `knowledge_resource_id` |

“实时”在本文仅描述预警和界面更新速度；语音能力统一称为“豆包大模型流式语音识别（ASR）”或简写“流式语音识别”。

## 快速启动

```bash
npm install
cp .env.example .env
npm run dev
```

所有环境变量、豆包大模型流式语音识别请求头、火山方舟 Responses API 请求体、火山方舟知识库搜索和停播后 TOS 归档网关参数，见 [配置说明](docs/CONFIGURATION.md)。如果现在只接火山引擎，可直接参考 [`config/volcengine.env.example`](config/volcengine.env.example)。`.env.example` 和该模板都不包含真实密钥。

版本发布使用 `npm run release -- patch|minor|major`。命令会自动跑测试、更新版本号、创建 Git 标签、生成本地 bundle 备份并尝试推送 GitHub；断网时本地版本仍然保留。

开发模式只绑定 MacBook 本机，打开 `http://localhost:5173` 进入控制台。选择蓝牙麦克风后先用“检测并测试麦克风”观察本机音量，再点击“开始直播收音”。直播中可以暂停和继续，只有“结束直播”才封存本场并进入复核。需要让 iPad 或外接显示器通过局域网访问时，请按“生产构建”先执行 `npm run build` 和 `npm start`，再使用 `http://<MacBook局域网IP>:8787`；这样局域网设备只能打开只读主播屏，不会通过开发代理绕过控制台限制。

没有配置密钥时，控制台仍可用“演示输入”按钮验证完整的预警和提词流程，结果会标注为 `LOCAL GUARDRAIL`。正式接入时，把豆包语音新版控制台提供的 App Key 写入 `X_API_KEY`，把火山方舟 API Key 和 Model ID 分别写入 `ARK_API_KEY`、`ARK_MODEL`；密钥只在 Node 服务端使用，不会下发到浏览器。

直播话术响应采用三层保护：内置/直播间高置信 `warning` 和 `blocked` 规则立即预警；相同话术在 30 秒内复用已完成的火山方舟结果；其余语义判断并发调用火山方舟 Responses API。若控制台已为支持的模型开通“在线推理（低延迟）”，可将 `ARK_SERVICE_TIER` 设为官方值 `fast`，否则保持 `auto`；Fast 未开通时服务端会按官方降级语义回退到 `auto`。当前 `doubao-seed-2-1-pro-260628` 不在官方列出的 Fast 支持系列中，不能仅修改参数强行启用。

控制台顶部会显示开播检查结果，包括豆包大模型流式语音识别、火山方舟 Responses API（豆包大模型）、多人身份和数据存储状态。这里的“参数已填写”只确认环境变量存在，流式语音识别和火山方舟连接会在实际开始收音或分析首句话时验证；任一参数未配置时会明确标记为演示模式。

当前优先保证 MacBook 本地模式可独立运行：不配置数据库、Redis、TOS 或火山方舟知识库时，商品、规则、时间线和原始音频仍写入 `.data/`，流式语音识别和本地规则不会被云端故障阻断。租户字段已经预留，但本地阶段默认使用 `tenant-default`，不会要求额外登录。

## 设备与网络

- 蓝牙麦克风需要先在 macOS “系统设置 → 声音 → 输入”中连接。浏览器控制台首次收音会请求麦克风权限。
- 控制台建议直接在 MacBook 的 `localhost` 打开；iPad 只访问主播屏，不需要麦克风权限。
- iPad 与 MacBook 需要在同一局域网。若系统防火墙拦截，请允许 Node 接收局域网连接。
- 浏览器收音使用 16kHz、单声道 PCM，服务端按豆包大模型流式语音识别“双向流式模式（优化版本）”WebSocket 二进制协议发送 gzip 二进制帧。

## 生产构建

```bash
npm run build
npm start
```

`npm run build` 会把前端产物放到 `dist/client`，Node 服务会在有该目录时同时提供静态页面。

## 火山引擎参数

豆包大模型流式语音识别（ASR）连接使用官方“双向流式模式（优化版本）”接口 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`。豆包流式语音识别模型 1.0 的小时版和并发版资源 ID 分别为 `volc.bigasr.sauc.duration`、`volc.bigasr.sauc.concurrent`；模型 2.0 分别为 `volc.seedasr.sauc.duration`、`volc.seedasr.sauc.concurrent`。`X-Api-Resource-Id` 必须以豆包语音控制台实际开通的资源为准。服务端优先使用新版 `X-Api-Key` 鉴权，也兼容旧版 `X-Api-App-Key` + `X-Api-Access-Key`；旧版页面的 Secret Key 不直接发送到 WebSocket。服务端还实现官方协议中的 full client request、无序号 audio only request、gzip 压缩、`request.corpus` 热词/替换词/上下文和最后一包标记；如果账号开通的是其他资源 ID，只需修改 `X_API_RESOURCE_ID`。火山引擎服务端约 8 秒未收到下一音频包会返回 `45000081`，主播停顿时服务端会在约 400 ms 空闲后以约 400 ms 间隔发送 100 ms 静音 audio only request 作为保活帧；若仍发生等包超时，会自动进行有限次数重连。保活帧仅发给豆包大模型流式语音识别，不会保存到任何录音或时间线资产。

## 时间线与原始音频

点击“开始直播收音”时会建立直播时间基准。服务端在 `.data/timeline/<sessionId>/` 下保存：

- `audio.chunks/`：收音期间临时保存的约 256 KB PCM 切片；ASR 音轨和每个原始采样率音轨分别按顺序编号。
- `audio.source.json`：原始音频音轨清单；浏览器采样率变化时会自动分轨。
- `audio.source.<track>.pcm`：浏览器采集到的原生采样率 PCM signed 16-bit little-endian、单声道，作为原始音频保留；`track` 从 0 开始。
- `audio.pcm`：发送给豆包大模型流式语音识别的 16kHz PCM signed 16-bit little-endian、单声道副本。
- `timeline.jsonl`：最终转录、转录纠错、商品清单与商品切换、收音启停和合规结果。每条记录同时包含 UTC 绝对时间、`Asia/Shanghai` 时区标识、相对开播毫秒数及 PCM 采样位置。纠错记录同时保留原文、修正文和操作人。

收音期间不会上传音频。音频包先在内存中聚合为约 256 KB 的切片，再通过独立写入队列保存到本地，不阻塞 ASR 或语义合规判定。暂停只停止当前 ASR 流并保留本场会话；点击“结束直播”后，服务端按编号合并切片为完整 PCM、删除临时切片，再把会话加入 `.data/archive/queue.json` 归档队列。只有配置 `TOS_ARCHIVE_GATEWAY_URL` 和 `TOS_ARCHIVE_GATEWAY_KEY` 时才会由后台上传。上传失败会保留本地文件并指数退避重试，不影响下一场流式语音识别。归档网关负责把文件写入火山引擎 TOS，接口约定为：先接收会话 manifest，再返回各音频资产的预签名 `uploadUrls`，服务端随后以流式 PUT 上传 PCM 文件。

结束后可以在控制台播放本场 16 kHz 识别音频，按时间戳跳到对应转录并修正整句。修正时提取的“错误词 → 正确词”会写入 `.data/speech-corrections/catalog.json`，按直播间长期保存；下一场会自动修正文稿并把正确词加入 ASR 上下文。误学词条可以停用，记录与确认次数仍然保留。

预留给后续复盘工具的只读接口：

- `GET /api/session/:id/timeline`：结构化 JSON 时间线与音频元数据。
- `GET /api/session/:id/timeline.jsonl`：原始 JSONL 事件流。
- `GET /api/session/:id/audio.pcm`：发送给豆包大模型流式语音识别的 16kHz PCM 副本。
- `GET /api/session/:id/audio.wav`：给 16kHz PCM 副本增加 WAV 文件头，采样数据保持不变，便于播放器直接打开。
- `GET /api/session/:id/audio-source.pcm?track=N` 和 `GET /api/session/:id/audio-source.wav?track=N`：第 `N` 条浏览器原生采样率原始音轨及 WAV 封装。收音进行中下载会返回 `409`，结束收音后再下载以保证文件长度和 WAV 头一致。

- `GET /api/readiness`：分别显示豆包大模型流式语音识别、火山方舟 Responses API（豆包大模型）、业务数据库、TOS 归档、Redis 和火山方舟知识库搜索状态。

会话在最后一个页面断开后默认保留 30 分钟，时间由 `SESSION_IDLE_TTL_MS` 调整。服务重启或会话重新载入时，系统会从时间线恢复当前商品、最近转录、合规结果、告警和统计，不会因为浏览器刷新丢失直播现场。主播屏临时短地址会保存到 `DISPLAY_LINK_REGISTRY_PATH`，服务重启后未过期的主播屏可继续连接原会话。时间线和音频下载接口需要控制台身份。

## 多直播间商品库

商品按直播间隔离保存，每个抖音账号可创建一个长期直播间资料空间。长期商品库与单场直播清单分开：商品录入一次后可以在下次直播直接勾选，本场清单只影响当前 `sessionId`。

- 控制台“管理商品库与本场清单”可以创建或切换直播间。
- 粘贴商品标题、详情、价格、库存、SKU 和卖点后，优先调用豆包整理为结构化商品；没有配置豆包或接口异常时使用本地字段识别，并要求场控保存前确认。
- 商品数据当前由 `ProductCatalog` interface 管理，本地 adapter 写入 `.data/products/catalog.json`。
- `GET /api/rooms`、`POST /api/rooms`：直播间列表与创建。
- `GET /api/rooms/:roomId/products`、`POST /api/rooms/:roomId/products`：对应直播间商品库。
- `POST /api/products/parse`：粘贴商品信息结构化。
- `PUT /api/session/:id/lineup`：保存本场商品清单。

## 协作规则与纠错

- 当前直播间规则保存后立即生效，只影响该直播间。
- 共享规则由非审核人提交后进入“待审核”，只有 `RULE_REVIEWER_ACTOR_ID` 指定的系统审核人可以发布；发布后对所有直播间生效。
- 规则编辑会生成新版本，控制台可回滚上一版。创建、审核、驳回、编辑和回滚都会写入 `.data/rules/catalog.json` 的审计日志。
- 流式语音识别列表和停播复核中的铅笔按钮都可以修改识别错误。系统会撤销该片段旧告警和统计，以修正文重新执行规则和豆包判断，同时在时间线保留原始文字；选择长期学习后还会更新当前直播间纠错词库。
- `GET /api/rooms/:roomId/speech-corrections`：直播间长期语音纠错词库。
- `PATCH /api/session/:id/transcripts/:segmentId`：修正任意时间戳转录，并可沉淀错误词和正确词。
- `GET /api/rooms/:roomId/rules`、`POST /api/rooms/:roomId/rules`：规则列表与新增。
- `PATCH /api/rules/:ruleId`：保存规则新版本。
- `POST /api/rules/:ruleId/approve|reject|rollback`：审核、驳回与回滚。
- `GET /api/rooms/:roomId/rules/audits`：规则审计日志。

## 多人登录与权限

多人模式使用服务端签名登录凭证，操作日志中的账号来自凭证而不是浏览器提交值，局域网调用者不能通过修改 `actorId` 冒充审核人。主播屏保持只读且不需要登录。

当前权限模型把 `operator` 定义为场控，只能管理 `roomIds` 明确分配或由自己创建的直播间；`reviewer` 可访问全部直播间，并额外拥有共享规则的审核、驳回和回滚权限。房间列表、商品、规则、会话时间线和原始音频下载都会执行同一套房间授权。

```dotenv
AUTH_TOKEN_SECRET=请生成至少32字符的随机密钥
AUTH_TOKEN_TTL_HOURS=12
AUTH_USERS_JSON=[{"actorId":"owner","displayName":"系统审核人","passwordHash":"粘贴生成的scrypt哈希","role":"reviewer","roomIds":[]},{"actorId":"operator-01","displayName":"一号场控","passwordHash":"粘贴生成的scrypt哈希","role":"operator","roomIds":["room-default"]}]
RULE_REVIEWER_ACTOR_ID=owner
```

分别为每个账号生成密码哈希，再粘贴到 `passwordHash`：

```bash
npm run auth:hash -- '至少8位的强密码'
```

系统只接受 `passwordHash`，不会在账号配置中保存明文密码。命令参数可能进入终端历史，生成后请清理对应历史记录，或让部署环境的密钥管理工具注入完整的 `AUTH_USERS_JSON`。

`AUTH_USERS_JSON` 与 `AUTH_TOKEN_SECRET` 必须同时配置，审核人账号必须使用 `reviewer` 角色。未配置时系统进入本机控制模式：MacBook 上的 `localhost` 控制台仍可使用，局域网设备只能访问只读主播屏，不能修改商品、规则或会话。

多人模式登录密码和签名凭证会经过网络传输。正式部署必须使用 HTTPS/WSS（例如由 Caddy、Nginx 或火山引擎负载均衡终止 TLS），不要在不可信 Wi-Fi 或公网直接暴露当前 HTTP 端口；`.env` 也必须限制为运行账号可读。

服务端在多人模式下默认拒绝明文 HTTP/WS 控制连接。TLS 可直接终止在服务前的本机反向代理，代理需要传递 `X-Forwarded-Proto: https`。只有隔离环境临时联调时才可设置 `ALLOW_INSECURE_AUTH=true`，正式直播必须保持为 `false`。

所有商品库、规则库、时间线和音频接口在多人模式下都要求 `Authorization: Bearer <token>`；控制台会自动携带，不会把 token 放进主播屏 URL。

## 数据库 adapter

直播会话只依赖 `ProductCatalog` 和 `RuleCatalog` interface，不直接依赖 JSON 文件。当前提供本地文件 adapter，尚未连接真实火山数据库。接入火山引擎 PostgreSQL/MySQL 时可在这两个接口增加数据库 adapter，并把商品、直播间、规则版本和审计日志迁移为事务表；直播会话、控制台和判定流程不需要改动。

## 火山方舟知识库搜索

火山方舟知识库只作为平台规则、内部处罚案例的语义召回增强层，不是业务数据库。精确规则仍先在本地/业务数据库执行，配置 `KNOWLEDGE_RESOURCE_ID` 后，合规请求通过火山方舟 Responses API 官方 `knowledge_search` 工具将召回交给豆包大模型；知识库超时或异常会快速降级。规则的创建、审核、回滚和停用不依赖未公开的知识库写入接口，先以本地/业务数据库为事实源。

请求会发送 `ark-beta-knowledge-search: true`，并使用官方 `tools[].knowledge_resource_id` 与 `limit` 字段。火山方舟知识库仅支持旗舰版知识库搜索，具体资源 ID 从火山方舟控制台获取。

## 商用 SaaS 预留

对外商用部署时，建议把当前 Node 服务拆成“租户控制面 + 直播边缘采集端”：

- 控制面放在服务区，负责账号、租户、直播间、商品库、规则版本、审核、审计和复盘查询。
- 每个 MacBook 作为一个直播边缘节点，蓝牙麦克风和豆包大模型流式语音识别（ASR）音频留在本地；通过短连接/安全 WebSocket 只上送转录和告警，不把原始音频放进直播处理链路。
- PostgreSQL/MySQL 保存业务事实，Redis 负责会话状态、采集租约和跨进程协调，TOS 保存下播后的原始音频、录屏和导出文件，火山方舟知识库保存可检索的规则/案例副本。
- `tenantId` 已在房间和认证身份上预留；本地旧数据自动归入 `tenant-default`。SaaS 阶段必须在数据库查询、对象存储 key、Redis key 和知识库 metadata 中同时带租户标识。

本地 MacBook 阶段不需要部署这些云依赖，先验证收音稳定性、端到端延迟、误报处理和下播归档，再切换到服务区控制面。
