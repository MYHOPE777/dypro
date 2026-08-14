# dypro 直播中控 v0.3

运行在 MacBook 上的本地直播辅助系统。它将流式语音识别、风险预警、三段主播提词、商品自动切换、多人说话标记、历史复核和人工确认交付收敛到一个 Node 进程，同时保证云端超时或不可用时仍可依靠本地规则工作。

## 快速启动

```bash
npm install
cp .env.example .env
npm run build
npm start
```

打开 [http://localhost:8787](http://localhost:8787)。完整配置见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

开发、版本发布、变更记录和回滚流程见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 与 [CHANGELOG.md](CHANGELOG.md)。

开发模式：

```bash
npm run dev
```

## 当前架构

- `server/index.ts` 只负责配置、启动和关闭。
- `server/v2/runtime.ts` 组装本地模块化单体。
- `LiveSession` 只暴露 `dispatch`、`snapshot` 和 `subscribe`。
- `CaptureModule` 管理豆包大模型流式语音识别 2.0、保活、恢复、结束排空和时间基准。
- `RealtimeReviewPipeline` 先运行本地规则和三段本地提词，再并行运行语义合规与豆包教练。
- `SessionReviewModule` 独立处理历史纠错、说话人、备注和人工确认。
- SQLite/WAL 保存事件、投影、规则、话术、纠错词、音频索引和 durable delivery jobs。
- 规则和话术默认只保存本地；只有人工选择商家数据库或私有知识库目标后才创建交付任务，旧任务迁移后也必须重新确认。
- 控制台与主播屏通过 `/ws/v2` 接收带递增 `sequence` 的事件，断线后自动补最新快照。
- 商品目录按直播间隔离；直播中调整商品资料会同步到中控台、主播屏和本场事件历史，不会改写其他直播间或已结束场次。

本地数据：

```text
.data-v2/
  app.sqlite
  audio/<tenantId>/<roomId>/<sessionId>/source.pcm
  audio/<tenantId>/<roomId>/<sessionId>/asr-16k.pcm
```

旧 `.data` 不会迁移或读取。回滚旧版时应切回 `pre-architecture-rewrite` 标签并恢复旧 `.data` 备份。

## 实时能力

- 默认使用豆包大模型流式语音识别 2.0 小时版资源 `volc.seedasr.sauc.duration`。
- 浏览器保留原采样率 PCM，并独立生成 16 kHz ASR 轨。
- `45000081` 等可恢复断线会有限重连；重连和暂停后的 ASR 时间戳保持连续。
- 最终转录会自动识别当前商品并切换商品上下文。
- 本地高置信规则目标 P95 不超过 50 ms。
- 首批三段可用提词目标 P95 不超过 800 ms。
- 语义合规与教练各自使用模型通道，2 秒预算包含排队时间；超时保留本地结果。
- 主播提示屏始终展示三段下一句话术，风险替代表达位于独立区域，实时转录单独显示。

## 复核与持续学习

下播后可在“历史复核”中：

- 播放原始采样率音频的 WAV 封装。
- 修改转录、标记主播或其他人、保存本场备注。
- 从转录修改中沉淀当前直播间的长期语音纠错词。
- 将主播自己的话术归档到该主播私有话术库，并选为下一场参考。
- 人工确认当前 `contentRevision` 后创建交付任务。

任何复核修改都会撤销旧批准。上传过程中发生修改时，旧任务最终只能变成 `superseded`，不能覆盖新版本状态。

v0.3 尚未实现真实云数据库、知识库或 TOS adapter。交付任务会持久化排队，但不会发送 Mac 本地路径或误报同步成功。

## 规则治理

- 人工直播间规则立即在该直播间生效。
- 豆包明确给出的词级、置信度不低于 `0.95` 的风险词，可自动沉淀为当前直播间快规则。
- 句级或长上下文语义发现不自动变成词规则。
- 句级和上下文规则必须先完成商家本地审核，再由服务运营审核采纳后复制到公共规则包；公共规则默认等待商家确认。
- 跨直播间共享规则经过独立运营审核、版本和回滚流程；未采纳内容不会进入公共库。

## 权限

不配置账号时，仅 MacBook 本机可以控制；临时主播屏短地址免登录但只读。配置 `AUTH_USERS_JSON` 与 `AUTH_TOKEN_SECRET` 后，控制台显示登录页并使用签名令牌：

- `operator`：查看和控制已分配直播间。
- `reviewer`：历史复核、纠错、备注、人工确认和重试交付。

多人模式默认要求 HTTPS/WSS。只有隔离局域网临时联调才可设置 `ALLOW_INSECURE_AUTH=true`。

## 验证

```bash
npm test
npx tsc --noEmit
npm run build
npm run test:e2e
```

生产接口：

- `GET /api/v2/health`
- `POST /api/v2/auth/login`
- `/api/v2/rooms/*`
- `GET/PUT/DELETE /api/v2/rooms/:roomId/products/*`
- `/api/v2/sessions/*`
- `GET /api/v2/sessions/:id/audio`
- `WS /ws/v2`

版本发布：

```bash
npm run release -- 0.3.0 --no-push
```
