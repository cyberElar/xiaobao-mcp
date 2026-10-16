# Xiaobao MCP

[![CI](https://github.com/cyberElar/xiaobao-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cyberElar/xiaobao-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

面向校宝学生端的个人自托管 Model Context Protocol（MCP）服务。通过 ChatGPT 等 MCP 客户端查询学习数据，绑定微软账号后访问 Teams 教育作业和 Outlook 日历。

服务提供 Streamable HTTP、个人 OAuth 授权和 39 个工具。其中，33 个工具只读，6 个工具可写入。服务每次只绑定一个校宝账号和一个可选微软账号，适合本人使用。

## 功能

| 范围 | 能力 |
| --- | --- |
| 校宝查询 | 作业、考试、课表、成绩、统计、本人升学档案和学校功能状态 |
| 附件与计算 | PDF 文字层及纯文本提取、可配置 GPA、本地成绩预测 |
| 微软查询 | Teams 课程、作业、本人提交和已公布评分，Outlook 主日历 |
| 写入 | 校宝附件上传与提交，Teams 附件上传、提交与撤回，个人 Outlook 事件创建 |

写入需要额外授予 `schoolis.write`。微软写入还需要上游委托权限；Teams 附件上传需要 `Files.ReadWrite`，学校策略可能要求管理员批准。上传与提交是两个独立步骤，具体要求见[作业写入与文件上传](docs/writes.md)。

本项目是非官方工具，与校宝、Microsoft 和 Giaoculator 作者无隶属关系。校宝接口可能随网站更新而变化。默认学校站点和 GPA 规则来自已验证的使用场景，其他学校应配置 `SCHOOLIS_URL` 并核对计算规则。

## 快速开始

准备 Node.js 24 或更高版本、npm 和可用的校宝学生账号。ChatGPT 接入还需要稳定的 HTTPS 地址。

```bash
git clone https://github.com/cyberElar/xiaobao-mcp.git
cd xiaobao-mcp
npm ci
npm run setup
npm run session:login
npm run build
npm start
```

初始化命令创建 `.env` 并生成随机 `OWNER_KEY`。登录命令在终端读取账号和隐藏输入的密码，核对学生身份与学期数据后保存会话，默认不保存原密码。

服务默认监听 `127.0.0.1:8787`，MCP 路径为 `/mcp`，健康检查路径为 `/healthz`。公开部署后，在支持 OAuth 的 MCP 客户端中连接 `https://你的域名/mcp`。

配置自动登录、Docker Compose、反向代理或 Tailscale Funnel 时，阅读[部署与账号绑定](docs/deployment.md)。微软账号可从 SSH 发起设备代码登录，再用手机授权，见[微软授权与 Teams](docs/microsoft.md)。

不要提交 `.env`、`secrets/`、`sessions/` 或浏览器 Cookie，也不要把这些文件发送到聊天中。项目不需要 OpenAI API Key。

## 当前边界

- 所有获授权的 MCP 客户端共享绑定账号；服务不提供多用户隔离。
- 校宝和微软账号分别绑定，服务不自动判断两个账号是否属于同一学生。
- 功能可用性取决于学校配置、账号权限和作业状态，令牌权限不能代替学校授权。
- PDF 提取只读取文字层，不提供扫描图片识别。
- GPA 和成绩预测属于本地计算，不是学校出具的成绩。
- 写入流程通过模拟上游的测试验证，尚未使用真实作业或日历执行端到端写入验证。

## 开发文档

- [系统结构与会话](docs/architecture.md)：授权边界、登录协议、缓存与限制。
- [工具与计算规则](docs/tools.md)：输入要求、数据来源、GPA 和预测假设。
- [部署与账号绑定](docs/deployment.md)：账号绑定、HTTPS、ChatGPT 接入和故障排查。
- [微软授权与 Teams](docs/microsoft.md)：手机设备代码登录、令牌刷新、Teams 和 Outlook 的读取范围。
- [作业写入与文件上传](docs/writes.md)：写入授权、文件输入、提交步骤和失败处理。
- [第三方依赖与参考来源](docs/third-party.md)：依赖许可证和功能参考范围。
- [贡献指南](CONTRIBUTING.md)：开发检查、测试约定和问题反馈。
- [安全策略](SECURITY.md)：敏感信息范围和漏洞报告方式。

本地检查：

```bash
npm run check
npm test
npm run build
```

## 许可证

项目代码采用 [MIT 许可证](LICENSE)。第三方依赖保留各自的许可证。
