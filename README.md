# AG 分布式采集运行器

这个公开仓库只保存不含凭据的 AG 测试数据采集代码。工作流只能手动触发，每次只接受 `ag-games.yml` 中严格匹配的一组 `game_id` 与 `db_name`。

## 运行约束

- 单个游戏的目标是正式 `simulate` 集合恰好 300,000 条，并且每条都有 RTP 标签。
- 工作流先启动 2 个隔离验证 Job，验证通过后拆分为 50 个采集 Job；`max-parallel: 50` 是上限，实际同时运行数量由 GitHub 调度和账户限制决定。
- 每个 Job 只写入带数据库名、campaign ID 和 worker 编号的隔离集合，最后统一校验并合并。
- 工作流只从 GitHub Actions Secret 读取临时连接信息；临时数据库用户只拥有当前游戏数据库的 `readWrite` 权限，不具备管理员权限。
- 公开仓库不响应 `push` 或 `pull_request`，只允许仓库所有者手动 `workflow_dispatch`。

## 失败与续拉

每个采集 Job 会在同一个隔离集合上最多重试三次。任务中断时可使用相同 `resume_campaign_id` 继续；正式集合不会在采集阶段被直接清空或覆盖。正式有效数据已经超过 300,000 条时，流程会停止并要求人工检查，不会自动裁剪。

本地私有控制器负责创建当前游戏的最小权限临时用户、轮换 Secret、触发工作流，以及完成后的精确验收和权限回收。管理员配置和临时凭据不会进入本仓库。

## 本地校验

```bash
npm ci
npm run check
npm test
npm run public-audit
npm audit --omit=dev
```
