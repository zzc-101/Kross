# 扩展 Kross
以下内容不是稳定扩展 API：Runtime 内部类、Worker 本地 JSONL/SQLite、组件 CSS、容器标签、内部 WebSocket 字段和未公开的源码深路径。需要新能力时优先增加窄的控制面接口、版本化 Skill 字段或受管工具契约。
Kross 面向 SaaS 平台的扩展边界只有两类：平台版本化 Skill，以及经过 Tool Gateway 的受管外部工具。Worker Core 不是面向普通用户的插件目录，也不承诺旧客户端兼容。

## 版本化 Skill

Skill 用于封装稳定工作流程、领域说明和配套资源。管理员上传 ZIP，平台生成不可变版本并安装到组织。普通成员从工作台启动 Skill；会话和子任务使用同一版本。

最小包结构：

```text
my-skill.zip
└── SKILL.md
```

`SKILL.md` 示例：

```markdown
---
name: customer-feedback-summary
description: 汇总客户反馈并生成行动项
---

1. 读取用户提供的反馈文件。
2. 按主题聚类并标注证据。
3. 在工作区生成 summary.md。
```

Skill 不能改变文件边界、审批策略或模型凭证。脚本和二进制不会因为被打包进 Skill 而自动获得执行能力。

## 受管外部工具

外部工具用于访问 CRM、邮件、日历、知识库等平台服务。要求：

1. 输入使用明确 schema，拒绝未知字段。
2. read、write、network 风险与真实副作用一致。
3. 密钥只从受管凭证读取，不进入参数、Trace 或结果。
4. 网络或外部副作用进入简化确认流程。
5. 支持 `AbortSignal`、超时、幂等和可判定错误。
6. 返回面向任务的摘要与结构化数据，不向普通用户暴露 transport 细节。

平台可以在 Worker 启动时下发受管 MCP/Connector 配置，但普通 Agent API 和工作台不提供 stdio 命令、URL 或认证编辑器。连接失败不能阻止基础文件工作能力启动。

## 模型 Provider

优先使用现有 Provider 的 `*_BASE_URL` 接入协议兼容服务。新增 Provider 必须同时实现流式文本、思考内容、工具调用、usage、取消、错误分类和凭证映射，并更新管理端与测试。

## Cloud 客户端

自定义 Web 或移动端应以 Java DTO 和 [Cloud Protocol](cloud-protocol.md) 为事实源：

- 上行 HTTP，下行 SSE；
- 最终消息快照覆盖直播增量，但不能让陈旧 processing 快照擦除更丰富的本地流；
- 保留外部工具确认、组织身份和会话归档语义；
- 客户端不直接连接 Worker。

## 不稳定内部接口

以下内容不是稳定扩展 API：Runtime 内部类、Worker 本地 JSONL/SQLite、组件 CSS、容器标签、内部 WebSocket 字段和未公开的源码深路径。需要新能力时优先增加窄的控制面接口、版本化 Skill 字段或受管工具契约。
