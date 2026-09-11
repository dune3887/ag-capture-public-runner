# Blaze 协议核对与 MalformedRequest 排查

官方证据：ts-slot-secrets-of-the-phoenix-blaze/1.2.1/main.bundle.js，SHA256 b2eb30322694d4739930b578f09d4d8cf7e07ba5dc982e3f431abfe463ab7024。

官方 fw：wager 请求带 coinSize、numberOfCoins。Tx：Spin、FreeSpin、Cascade、FreeCascade 请求均发送 {}。ox.nextIsIdle：WAGER 表示整局结束。因此空参数 Spin 是正确协议，不能追加投注字段或将 SPIN 提前当作整局结束。

修复：只对该游戏的四种已核实动作使用精确事件和参数，禁用通用大小写别名回退；其他游戏不套用。补充拒绝诊断中的协议类型及最近 8 次成功请求的事件、动作、响应字段名，不记录响应值或凭据。

现场证据（同一 rolling run 34543324687）：
- 节点 18，00:50:13Z，Spin {}，previousAction=SPIN，3081 个成功请求后 MalformedRequest。
- 节点 7，01:00:10.296Z，Cascade {}，previousAction=CASCADE_SPIN，2889 个成功请求后 MalformedRequest。
- 节点 9，01:00:09.902Z，Spin {}，previousAction=SPIN，3416 个成功请求后 MalformedRequest。
- 节点 14 的 Spin 是 error-only，属于另一个已修复的整局丢弃分类。

节点 7 与 9 的不同普通动作几乎同时被拒，提示上游服务/状态异常，但供应方没有足够诊断内容，尚不能证明具体根因。大小写映射修复不能宣称已解决上述单次 Spin/Cascade 拒绝。不盲目重试或保存未结束的功能局。

数据覆盖审计发现大量完整免费转、普通级联及免费级联，不能把单个分片失败解释成整个玩法未采到。最终验收按完整玩法局数和回放链、金额、RTP校验，不以总量约30万替代玩法覆盖。缺失玩法须保留批次后专项补采，不能并发启动第二滚动队列。

发布后既有job仍运行旧checkout，新的正常续批才会加载修复。实采诊断没有复现不能当作节点18根因解决的证据。
