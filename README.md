# AG 分布式采集运行器

这个公开仓库只保存不含凭据的 AG 测试数据采集代码。工作流只能手动触发，每次只接受 `ag-games.yml` 中严格匹配的一组 `game_id` 与 `db_name`。

## 运行约束

- 单个游戏的目标是正式 `simulate` 集合恰好 300,000 条，并且每条都有 RTP 标签。
- 工作流先启动 2 个隔离验证 Job，每个验证 Job 保持单线程；验证通过后拆分为 20 个采集 Job，每个采集 Job 在单个 Node.js 进程内运行 3 个采集线程。`max-parallel: 20` 与 GitHub Free 的 Runner 并发上限一致；同一 Job 的 3 个线程共用一个出口 IP。
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

## NEXT_TRAIN 协议修复（2026-09-10）

NEXT_TRAIN 使用官方小写 nexttrain 与空对象参数。已核对 Joyful Panda 1.0.14、Cash Express Legend Buffalo 1.0.6、Choy Sun Doa 1.0.5、Buffalo CELL 0.0.23、Pelican Pete CELL 1.0.5、Timber Wolf CELL 1.0.19 的本地官方前端；此证据不代表所有 AG 游戏协议均已验证。完整资源未纳入仓库。

回归覆盖连续两步至真正终态、仅一次初始 Spin、原 trigger/实际请求/bet/win/feature，以及 MalformedRequest 和 RuntimeError 跨线程停止、CLI 78。功能局失败不得重新 Spin 补数。完整测试 137 项通过，typecheck 通过，npm audit 为 0 漏洞。结构及 RTP 标签校验不能单独证明统计无偏。

## Triple Supreme Pick 修复（2026-09-10）

官方 Heart of the Sea 1.0.7 与 Grand Prosperity 1.0.2：免费四选一发送 pickfreespins，仅带字符串 pickIndex（逻辑1–4映射请求0–3）；Match3发送 Pick，仅带字符串 pickIndex（0–11，排除 Match3Result.revealedSymbols 中已揭示位置）。Match3揭示不计免费选项配额。通过 Session 的限定协议接口返回合法选项，整局执行器只发送精确请求，失败后不切换事件或索引、不新开Spin。非法/重复/耗尽的揭示索引保持完整性致命错误。其他游戏保持原协议路径。

计划与验证：核对两款官方请求及UI索引；先复现12项失败，再修复并测试四选项、多步揭示、跨阶段及新一轮重置、原trigger/实际请求/完整赢分、错误传播及跨线程/CLI78；完整测试、类型检查、公开与依赖审计通过后独立审查、提交推送，再安全预检并续拉原Campaign。官方完整资源和运行态不纳入提交。RTP/结构校验不等于统计无偏证明。

验证结果：权威工具完整测试116/116、公开Runner完整测试163/163，双方typecheck通过；独立审查22项协议回归均通过，无未解决Critical/Important。重复免费选择只预留一次配额；原始trigger、实际请求、完整赢分与CLI78保护保留。

### Match3 普通入口补充

官方普通入口不传历史数组，握手恢复才传 revealedSymbols；正常揭示将 lastRevealedSymbol 对应位置保存于本地 revealedPicks。采集器在当前连续 PICK 阶段合并服务器历史与实际成功请求位置，字段省略也不重复点击；离开 PICK 后重新进入为新板。字段存在但为 null/非数组，或索引非法/重复/耗尽，仍保持致命。回归覆盖全程省略、先有后无、跨板重置、12格耗尽及失败不继续。

本轮完整测试：权威119/119、公开166/166；双方typecheck通过，public-audit通过，npm audit为0漏洞；独立复审25/25通过，无阻塞问题。

## 正式采集并发

正式工作流使用20个节点，每节点8个线程；Canary仍为2个单线程节点。每游戏目标300000条，staging超额容差保持7，与8线程最多7个在途尾部结果相符，最终按既有配额精确合并。控制器每5分钟报告游戏和数据进度，完成验收后顺序推进。

## 缺失终态保护（2026-09-10）

回合执行器原先允许空nextAction结束，入库层随后报invalid terminal action，丢失了请求上下文。现在缺失/空/纯空白动作在回合层明确抛AG integrity: missing nextAction，仅记录事件、前序动作、步骤数、响应字段名和动作类型，不输出响应字段值，不伪造SPIN、不重开局。此修正不证明上游缺失字段的原因已解决；原失败日志没有原始响应，需受控诊断取证，不能盲续拉。

验证：权威完整125/125、公开完整172/172、双方typecheck通过；公开审计通过，依赖0漏洞；独立6/6针对性测试通过，无新增Critical/Important。

仅取证运行可将 workflow_dispatch 的 diagnostic_only 设为 true：节点退出失败后不再启动下一次采集进程，自动合并作业始终跳过；已完成的 staging 数据保留供排查。正常运行默认 false。
