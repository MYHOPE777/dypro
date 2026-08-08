# 合规台 · 抖音直播实时合规预警

一个面向直播间的本地局域网工具：MacBook 采集蓝牙麦克风，火山引擎实时语音模型转录，豆包大模型判断抖音直播话术风险，主播在 MacBook 或 iPad/外接显示器上即时看到合规替代表达。

## 快速启动

```bash
npm install
cp .env.example .env
npm run dev
```

所有环境变量、火山实时语音请求头、豆包请求体、方舟知识库网关和停播后 TOS 归档网关参数，见 [配置说明](docs/CONFIGURATION.md)。`.env.example` 默认是本机演示模式，不包含任何真实密钥。

版本发布使用 `npm run release -- patch|minor|major`。命令会自动跑测试、更新版本号、创建 Git 标签、生成本地 bundle 备份并尝试推送 GitHub；断网时本地版本仍然保留。

开发模式只绑定 MacBook 本机，打开 `http://localhost:5173` 进入控制台。点击“选择输入设备”选择已连接的蓝牙麦克风，再点击“开始收音”。需要让 iPad 或外接显示器通过局域网访问时，请按“生产构建”先执行 `npm run build` 和 `npm start`，再使用 `http://<MacBook局域网IP>:8787`；这样局域网设备只能打开只读主播屏，不会通过开发代理绕过控制台限制。

没有配置密钥时，控制台仍可用“演示输入”按钮验证完整的预警和提词流程，结果会标注为 `LOCAL GUARDRAIL`。正式接入时，把火山引擎控制台提供的实时语音 App Key、Access Key，以及豆包/Ark 的 API Key 和 Endpoint ID 写入 `.env`，密钥只在 Node 服务端使用，不会下发到浏览器。

控制台顶部会显示开播检查结果，包括火山实时语音、豆包、多人身份和数据存储状态。这里的“参数已填写”只确认环境变量存在，火山和豆包连接会在实际开始收音或分析首句话时验证；任一参数未配置时会明确标记为演示模式。

当前优先保证 MacBook 本地模式可独立运行：不配置数据库、Redis、TOS 或方舟知识库时，商品、规则、时间线和原始音频仍写入 `.data/`，实时转录和本地规则不会被云端故障阻断。租户字段已经预留，但本地阶段默认使用 `tenant-default`，不会要求额外登录。

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

## 时间线与原始音频

点击“开始收音”时会建立直播时间基准。服务端在 `.data/timeline/<sessionId>/` 下保存：

- `audio.source.json`：原始音频音轨清单；浏览器采样率变化时会自动分轨。
- `audio.source.<track>.pcm`：浏览器采集到的原生采样率 PCM signed 16-bit little-endian、单声道，作为原始音频保留；`track` 从 0 开始。
- `audio.pcm`：发送给火山实时语音的 16kHz PCM signed 16-bit little-endian、单声道副本。
- `timeline.jsonl`：最终转录、转录纠错、商品清单与商品切换、收音启停和合规结果。每条记录同时包含 UTC 绝对时间、`Asia/Shanghai` 时区标识、相对开播毫秒数及 PCM 采样位置。纠错记录同时保留原文、修正文和操作人。

收音期间不会上传音频。停止收音后，会话进入 `.data/archive/queue.json` 归档队列；只有配置 `TOS_ARCHIVE_GATEWAY_URL` 和 `TOS_ARCHIVE_GATEWAY_KEY` 时才会由后台上传。上传失败会保留本地文件并指数退避重试，不影响下一场实时转录。归档网关负责把文件写入火山引擎 TOS，接口约定为：先接收会话 manifest，再返回各音频资产的预签名 `uploadUrls`，服务端随后以流式 PUT 上传 PCM 文件。

如果停止后很快重新开始收音，正在进行的归档上传会被暂停并保留为本地待处理任务，避免归档流量与实时语音链路重叠；再次停止收音后由后台继续上传。

预留给后续复盘工具的只读接口：

- `GET /api/session/:id/timeline`：结构化 JSON 时间线与音频元数据。
- `GET /api/session/:id/timeline.jsonl`：原始 JSONL 事件流。
- `GET /api/session/:id/audio.pcm`：发送给火山实时语音的 16kHz PCM 副本。
- `GET /api/session/:id/audio.wav`：给 16kHz PCM 副本增加 WAV 文件头，采样数据保持不变，便于播放器直接打开。
- `GET /api/session/:id/audio-source.pcm?track=N` 和 `GET /api/session/:id/audio-source.wav?track=N`：第 `N` 条浏览器原生采样率原始音轨及 WAV 封装。收音进行中下载会返回 `409`，结束收音后再下载以保证文件长度和 WAV 头一致。

- `GET /api/readiness`：分别显示实时语音、豆包、业务数据库、TOS 归档、Redis、方舟知识库和规则同步队列状态。

会话在最后一个页面断开后默认保留 30 分钟，时间由 `SESSION_IDLE_TTL_MS` 调整。服务重启或会话重新载入时，系统会从时间线恢复当前商品、最近转录、合规结果、告警和统计，不会因为浏览器刷新丢失直播现场。时间线和音频下载接口需要控制台身份。

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
- 实时转录列表中的铅笔按钮可以修改识别错误。系统会撤销该片段旧告警和统计，以修正文重新执行规则和豆包判断，同时在时间线保留原始文字。
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

实时会话只依赖 `ProductCatalog` 和 `RuleCatalog` interface，不直接依赖 JSON 文件。当前提供本地文件 adapter，尚未连接真实火山数据库。接入火山引擎 PostgreSQL/MySQL 时可在这两个接口增加数据库 adapter，并把商品、直播间、规则版本和审计日志迁移为事务表；实时会话、控制台和判定流程不需要改动。

## 方舟知识库与规则同步

方舟知识库只作为平台规则、内部处罚案例的语义召回增强层，不是业务数据库。精确规则仍先在本地/业务数据库执行，召回证据才会作为上下文交给豆包；知识库超时或异常会快速降级。已发布规则、审核确认版本、回滚和停用会写入 `.data/knowledge/sync.json`，由后台队列重试索引；待审核规则不会进入知识库。

由于方舟知识库不同账号的检索地址和请求协议由控制台配置决定，代码使用显式 `ARK_KB_RETRIEVE_URL`、`ARK_KB_INDEX_URL` 网关适配器，不猜测未公开的固定路径。网关需返回 `items` 或 `data.items`，每项包含 `id`、`content/text`、可选 `title/source/score`。

## 商用 SaaS 预留

对外商用部署时，建议把当前 Node 服务拆成“租户控制面 + 直播边缘采集端”：

- 控制面放在服务区，负责账号、租户、直播间、商品库、规则版本、审核、审计和复盘查询。
- 每个 MacBook 作为一个直播边缘节点，蓝牙麦克风和实时 ASR 音频留在本地；通过短连接/安全 WebSocket 只上送转录和告警，不把原始音频放进实时链路。
- PostgreSQL/MySQL 保存业务事实，Redis 负责会话状态、采集租约和跨进程协调，TOS 保存下播后的原始音频、录屏和导出文件，方舟知识库保存可检索的规则/案例副本。
- `tenantId` 已在房间和认证身份上预留；本地旧数据自动归入 `tenant-default`。SaaS 阶段必须在数据库查询、对象存储 key、Redis key 和知识库 metadata 中同时带租户标识。

本地 MacBook 阶段不需要部署这些云依赖，先验证收音稳定性、实时延迟、误报处理和下播归档，再切换到服务区控制面。
