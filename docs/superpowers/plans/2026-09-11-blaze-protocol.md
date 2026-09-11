# Blaze 协议核对与修复计划

目标：按本地官方 1.2.1 客户端核实的协议采集，不以跳过未知 MalformedRequest 掩盖功能缺失。

事实：fw 发送 wager 两个投注字段；Tx 将 Spin、FreeSpin、Cascade、FreeCascade 均以 {} 发送；ox.nextIsIdle 的终态为 WAGER。因此空 Spin 合法。节点 18 单次 Spin 被拒的供应方原因仍未明确。

- [x] 为已核对的 Blaze 增加精确后续请求映射，避免猜别名；其他游戏保持现有协议。
- [x] 回归验证 wager→Spin→免费/级联→WAGER 完整流程、拒绝后不重发，以及不影响 MoreChilli。
- [x] 执行无数据库写入的有界实采验证，并统计已有数据玩法覆盖。
- [x] 独立复审、同步 api.numeric 源码、提交推送。运行进程版本与代码发布分开报告。

节点18根因证据不足时继续保留失败，不宣布已解决所有 MalformedRequest。既有完整数据不删除，不另开采集队列。
