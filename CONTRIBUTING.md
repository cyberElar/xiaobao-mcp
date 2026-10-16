# 贡献指南

欢迎通过 Issue 报告问题，或通过 Pull Request 提交修改。项目文档使用简体中文，提交消息与 Pull Request 描述使用英文。

## 本地开发

项目需要 Node.js 24 或更高版本。

```bash
npm ci
npm run check
npm test
npm run build
```

自动化测试使用模拟上游和临时状态目录，不需要真实校宝或微软账号。部分测试会监听本机回环地址。需要手动连接上游时，按[部署文档](docs/deployment.md)配置自己的账号，勿使用其他人的登录态。

## 代码结构

| 路径 | 内容 |
| --- | --- |
| `src/app.ts`、`src/auth.ts` | HTTP 服务、MCP 传输与 OAuth |
| `src/schoolis/` | 校宝登录、接口、附件与作业写入 |
| `src/microsoft/` | 微软授权、Graph 查询与写入 |
| `src/grades/` | GPA 与成绩预测 |
| `src/writes/` | 文件输入、写入去重和工具注册 |
| `scripts/` | 初始化与账号绑定命令 |
| `tests/` | 接口、计算、授权和写入测试 |
| `docs/` | 系统、部署和工具文档 |

## 提交修改

1. 创建描述用途的分支，例如 `fix/oauth-consent` 或 `feat/attachment-format`。
2. 修改实现，并按需更新受影响的文档。
3. 为新的行为或具体缺陷补充测试，复用已有样本。
4. 执行上述检查，核对 Git 差异中没有凭据和临时文件。
5. 提交 Pull Request，说明行为变化、验证结果和已知限制。

研究快照、交接记录和一次性调试文件不属于发布内容。测试应使用虚构身份、令牌和业务记录，不应依赖私有目录或真实上游数据。

`package.json` 保留 `private: true`，防止意外发布到 npm；源代码仍采用 MIT 许可证。

## 反馈问题

普通问题请提供运行方式、Node.js 版本、错误码和可复现步骤。提交日志前，应移除账号、学校个人记录、文件签名链接和凭据。

安全漏洞请按[安全策略](SECURITY.md)私下报告，不要创建公开 Issue。
