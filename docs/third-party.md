# 第三方依赖与参考来源

## 项目代码

本仓库发布 Xiaobao MCP 服务的实现、测试、部署文件和文档，采用根目录的 MIT 许可证。

项目不附带校宝网页源码、Giaoculator 扩展安装包、第三方图标或研究快照。项目许可证不授予第三方服务、数据或商标的使用权。本项目与校宝、Microsoft 和 Giaoculator 作者无隶属关系。

## 功能参考

校宝接口字段、登录协议和部分计算行为参考了校宝学生端及 Giaoculator S 1.3.10 的可观察行为。默认 GPA 分档、课程关键词和 Chinese Culture 合成规则见[工具与计算规则](tools.md)。这些规则可配置，不代表适用于所有学校的官方标准。

微软功能通过 Microsoft Graph 接入。服务不内置第三方微软应用 ID，不复用浏览器扩展回调，也不要求扩展常驻。

## 运行时依赖

下表列出直接运行时依赖。版本由 `package-lock.json` 固定，许可证以各依赖安装包附带的文件为准。

| 依赖 | 用途 | 许可证 |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | MCP 协议、传输与 OAuth 路由 | MIT |
| `express` | HTTP 服务 | MIT |
| `express-rate-limit` | 请求速率限制 | MIT |
| `tough-cookie` | 校宝 Cookie 存储与匹配 | BSD-3-Clause |
| `unpdf` | PDF 文字提取 | MIT |
| `zod` | 输入与数据校验 | MIT |

传递依赖和开发依赖保留各自的许可证。`unpdf` 包含 PDF.js 构建，PDF.js 使用 Apache-2.0 许可证。分发依赖或容器镜像时，应保留安装包附带的许可证与声明；项目 Dockerfile 保留依赖目录，并将本项目的 `LICENSE` 放入镜像。
