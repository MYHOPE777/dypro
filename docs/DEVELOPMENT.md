# 开发、发布与回滚手册

本文是 dypro 的固定开发流程。每次功能更新或 Bug 修复都必须留下可验证、可回滚、可追踪的记录。

## 1. 代码结构

| 位置 | 职责 |
| --- | --- |
| `server/index.ts` | 读取配置，启动和优雅关闭服务。 |
| `server/v2/runtime.ts` | 组装直播、复核、规则、主播、存储和后台交付模块。 |
| `server/v2/liveSession.ts` | 单场直播状态机、事件提交和结束排空。 |
| `server/v2/capture.ts` | 麦克风音频、ASR 连接、恢复、暂停和结束。 |
| `server/v2/http.ts` | `/api/v2`、`/ws/v2`、权限、收音租约和连接关闭。 |
| `server/v2/store.ts` | SQLite 事务、追加事件和本地投影。 |
| `src/App.tsx` | 操作台、主播屏、资料管理和历史复核视图。 |
| `src/clients/` | 带类型的 HTTP/WebSocket 客户端。 |

领域术语以根目录 `CONTEXT.md` 为准，直播间商品隔离决策见 `docs/adr/0001-room-owned-product-catalogs.md`，实时风控边界见 `docs/COMPLIANCE_ARCHITECTURE.md` 和 `docs/COMPLIANCE_POLICY.md`。

## 2. 每次修改的固定流程

1. 在修改前确认工作分支和未提交文件，禁止覆盖其他人的改动。
2. 为用户报告的现象增加最小回归用例，先确认测试能够失败。
3. 修改代码，让回归用例通过；非关键后台任务不得阻塞收音、结束或本地保存。
4. 运行完整校验：

```bash
npm test
npm run build
npm run test:e2e
git diff --check
```

5. 更新 `CHANGELOG.md`，至少写明修复内容、验证结果和回滚目标。
6. 先创建本地提交、版本标签和 Git bundle，再推送 GitHub。
7. 重启服务后检查端口只有一个监听进程，并演练本次修改涉及的主流程。

## 3. 版本与发布

版本采用 `major.minor.patch`：

- `patch`：Bug 修复和不破坏数据格式的小改动。
- `minor`：向后兼容的新功能或较大流程调整。
- `major`：外部接口、本地数据或部署方式的不兼容升级。

准备发布时，先将目标版本写入 `CHANGELOG.md`，然后执行：

```bash
npm run release -- patch
```

发布脚本会依次：

1. 运行测试、构建和端到端验收。
2. 更新 `package.json` 与 `package-lock.json`。
3. 创建本地 release 提交和带注释 Git 标签。
4. 在 `.git/backups/` 创建包含全部分支和标签的 Git bundle。
5. 将当前分支和标签推送到 `origin`。

若 GitHub 暂时不可用，使用 `--no-push` 先保存本地版本，恢复后再执行：

```bash
git push origin <当前分支> --follow-tags
```

## 4. 开发记录要求

每个版本的 `CHANGELOG.md` 必须包含：

- 用户看到的变化。
- 根因和修复边界。
- 新增的回归测试。
- 数据格式或配置是否变化。
- 可直接执行的回滚标签。

Git 提交保持单一目的，提交信息使用 `fix:`、`feat:`、`docs:`、`refactor:` 或 `release:` 前缀。禁止将密钥、`.env`、`.data-v2`、音频或运行日志提交到仓库。

服务端关键错误使用结构化单行日志，必须包含 `sessionId`、事件类型和错误信息。实时耗时继续使用 `[realtime-review]`，事件订阅异常使用 `[live-session-listener]`。日志不得包含 API Key、Access Token 或原始鉴权头。

## 5. 本地数据备份

发布前先停止直播和服务，再备份：

```text
.data-v2/app.sqlite
.data-v2/app.sqlite-wal
.data-v2/app.sqlite-shm
.data-v2/audio/
```

SQLite 主文件、WAL 和 SHM 必须作为同一组备份。音频目录按 `tenantId/roomId/sessionId` 保存，不要只复制数据库而遗漏音频。

## 6. 回滚步骤

1. 停止当前服务，确认 `8787` 不再监听。
2. 保存当前 `.data-v2` 的故障现场副本。
3. 切换到目标版本标签，例如 `v0.3.0`。
4. 恢复该版本发布前的 `.data-v2` 备份。
5. 重新安装依赖、构建并启动。
6. 检查健康接口、操作台连接、开播、暂停、继续和结束直播。

```bash
git switch --detach v0.3.0
npm install
npm run build
npm start
```

若本地 Git 仓库损坏，可从 `.git/backups/dypro-v<版本>.bundle` 恢复完整历史。不要尝试让新版本数据库反向兼容旧代码。

## 7. 服务重启检查

正常停止必须使用 `SIGINT` 或 `SIGTERM`，服务会先断开 WebSocket 页面，再关闭 HTTP 和本地资源。启动后检查：

```bash
curl http://localhost:8787/api/v2/health
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

只允许一个 Node 进程监听 `8787`。浏览器断线后会自动重连并补最新场次快照。
