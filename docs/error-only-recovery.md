# 功能局 error-only 的恢复规则

More Chilli 通道 12 的实际日志显示，freeSpin 返回仅含 error 的响应；没有 MalformedRequest，也没有足以证明网络故障的错误内容。此前功能请求包装异常时丢失类型，被完整性错误规则判为退出码 78。

现在仅将解析器识别的 AGProviderResponseError(reason=error-only) 转为整局丢弃。免费转、选择、级联等任一后续步骤遇到这种拒绝，禁止在原会话重发或尝试别名，整局不入库；调度器先关闭会话，再按已有重试次数和退避规则创建新会话。重试耗尽仍报告失败，不能无限重试。其他工作线程继续处理完整局。

MalformedRequest、金额不一致、回放不完整仍按原协议/完整性规则处理，不因为错误字符串中含 error 而放行。不输出供应方 error 字段内容，避免泄露敏感信息。

修复同时维护公开执行器和 api.numeric/capture/capture-ag 的源码。运行中的 GitHub job 使用启动时 checkout 的代码，推送不能热更新；正常续批使用新 main。More Chilli 已有有效完整局按原 Campaign 合并，不为补足精确 30 万重开已完成分片。
