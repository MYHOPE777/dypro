# 规则库与话术库治理

## 本地事实源

直播运行只读取本机 `.data-v2/app.sqlite`。规则、文档、语义发现、主播话术、审核记录和同步任务都先写入 SQLite；网络或远程服务不可用时不影响收音、转录、词级判断和本地提词。

保存规则或话术不会自动创建远程上传任务。只有人工在控制台选择同步目标后，才会创建资源交付任务。

## 规则层级

规则包按以下层级叠加：

`法律基线 > 平台规则 > 行业规则 > 直播间规则 > 商品规则`

广告法和国家法律红线由系统内置，不能由商家禁用或降级。第一版平台适配器是抖音直播，规则包模型预留拼多多。

规则单元分为 `term`、`sentence` 和 `context`。句级和上下文规则不会转换成关键词，审核通过后以语义指令和上下文要求注入豆包复核。

## 文档导入

运营审核账号可通过 `POST /api/v2/rule-documents` 上传 Markdown、PDF 提取文本或纯文本，也可以传入官方 HTTP/HTTPS URL。系统保存原始内容、来源 URL、发布机构、抓取时间、哈希和版本差异。

URL 抓取有 8 秒超时和 2MB 大小限制。抓取的新版本会进入 `pending_review`，并提取为待审核规则单元。自动发现的内容不会直接激活。

运营后台逐条审核规则单元：`approved` 激活，`deferred` 保留待定，`rejected` / `discarded` 不生效但保留证据。

## 语义发现

本地确定性规则先执行。本地 `safe` 或 `warning` 结果在严格档位下全部发给豆包，远程请求硬超时 2 秒。豆包结果只写入 `compliance_findings` 待处置队列，不自动创建活动规则。

商家确认时，词级结果创建当前直播间的本地词规则；句级和上下文结果创建 `RulePackage` 与 `RuleUnit`，保留原话、命中片段、指令和上下文窗口。公共规则提交和公共库采纳必须由服务运营审核账号完成。

每次重复违规都会产生新的风险事件；规则去重只用于规则版本和证据合并，不用于隐藏主播屏提醒。

## 人工同步

规则和主播私有话术分别支持 `merchant_database` 和 `private_knowledge_base` 目标。每次人工选择目标后，任务幂等键为 `resourceType:resourceId:resourceVersion:target`。资源编辑会将旧任务标记为 `superseded`，同步载荷同时包含结构化字段、原文证据、来源文档版本、审核记录和回滚信息。

话术库只属于商家、主播和直播间，不进入公共话术库。话术支持训练模式（语义意图 + 片段差异）和预测模式（主播私有话术优先、行业参考补充、无参考时豆包生成）。

## 主要接口

|用途|接口|
|---|---|
|规则文档|`GET/POST /api/v2/rule-documents`|
|文档版本|`GET /api/v2/rule-documents/:documentId/versions`|
|文档审核|`POST /api/v2/rule-documents/:documentId/review`|
|规则包与单元|`GET /api/v2/rule-packages`、`POST /api/v2/rule-packages/:packageId/units`|
|规则单元审核|`POST /api/v2/rule-units/:unitId/review`|
|规则同步|`POST /api/v2/rules/:ruleId/sync`、`POST /api/v2/rule-units/:unitId/sync`|
|话术同步|`POST /api/v2/phrases/:phraseId/sync`|
|同步任务|`GET /api/v2/sync-jobs`|

服务运营审核使用 reviewer 权限，商家账号只能管理所属直播间和主播私有资源。
