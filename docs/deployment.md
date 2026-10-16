# 部署与账号绑定

服务需要一个校宝账号和稳定的 HTTPS 地址。首版只运行一个实例。

需要 Teams 或 Outlook 时，另外按[微软授权与 Teams](microsoft.md)绑定微软账号。该步骤可从 SSH 发起，再用手机完成授权。

## 初始化

1. 安装 Node.js 24 或更高版本。
2. 在项目目录执行：

   ```bash
   npm ci
   npm run setup
   ```

   初始化命令创建权限为 `0600` 的 `.env`，并生成随机 `OWNER_KEY`。已有配置不会被覆盖。

3. 在服务器终端绑定校宝账号：

   ```bash
   npm run session:login
   ```

   命令读取账号和隐藏输入的密码。需要验证码时，命令会保存临时图片并显示路径。打开图片或通过 SSH 取回图片后，在同一终端输入验证码。

4. 如果需要自动登录，改用：

   ```bash
   npm run session:login -- --remember
   ```

   此选项把原密码保存到 `secrets/schoolis.json`，权限为 `0600`。默认方式只保存会话。两种方式都先核对学生身份与学期数据，再替换会话。验证码仍需用户填写。

5. 验证已绑定会话：

   ```bash
   npm run session:verify
   ```

   成功时，命令返回 `identityVerified=true`、学期数量和 `businessQueryVerified=true`。HTTP 200 本身不表示登录成功。

不要提交、公开或在聊天中发送 `.env`、`secrets/`、`sessions/` 及浏览器 Cookie 文件。服务不需要 OpenAI API Key。

## 导入浏览器会话

独立登录失败时，可导入已登录浏览器的 Cookie。文件可为 Cookie 数组，也可为包含 `cookies` 数组的浏览器存储文件。

1. 把导出文件放到 `sessions/browser-cookies.json`。
2. 执行：

   ```bash
   npm run session:import -- --file sessions/browser-cookies.json
   ```

   导入命令核对身份与学期数据后才替换会话。命令会删除旧的自动登录凭据，避免以后切回旧账号。原始导出文件仍由用户保管。

3. 如果旧会话已经绑定到其他账号，使用本命令显式替换绑定。

绑定命令与服务应使用相同配置、文件路径和系统用户。Docker Compose 的默认绑定目录与终端命令一致。

## 运行

直接运行：

```bash
npm run build
npm start
```

服务默认只监听 `127.0.0.1:8787`。`GET /healthz` 仅报告进程状态，不代表校宝会话有效。校宝会话使用 `npm run session:verify` 单独检查。

使用 Docker Compose 时，先创建私有目录：

```bash
install -d -m 700 sessions secrets
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) docker compose up -d --build
docker compose ps
```

Compose 把容器端口映射到服务器本机。容器使用非 root 用户，只读根文件系统，并把会话与授权状态保存在绑定目录中。健康检查固定访问容器内的 `8787` 端口。

更新代码后，重新构建并启动容器。会话和授权状态保留在绑定目录中。备份时应把 `.env` 与两个私有目录作为同一组保存。

## 配置 HTTPS

1. 准备域名，并让 DNS 指向服务器。
2. 写入公开地址：

   ```bash
   npm run setup -- --public-url https://mcp.example.com
   ```

3. 参考 `deploy/Caddyfile.example` 配置反向代理。
4. 如果反向代理直接连接本服务，在 `.env` 中设置 `TRUST_PROXY_HOPS=1`。
5. 重启服务或容器。

公开地址应为站点根地址，不应包含 `/mcp`。反向代理应保留请求的 Host、Authorization 和 MCP 协议头。不要在代理日志中记录令牌、请求体或完整查询参数。

如果不能直接开放服务器，可使用已有的 HTTPS 隧道。公开地址应保持稳定；地址变化后，旧令牌不再属于新资源地址，需要重新授权。

### 使用 Tailscale Funnel

Funnel 可把本机 HTTP 服务转发到设备的公网 HTTPS 地址。服务器应已登录 Tailscale，所属网络应允许该设备使用 Funnel。执行命令的系统用户需要 Tailscale 管理权限。

1. 在运行 Docker 的服务器上启用转发：

   ```bash
   tailscale funnel --bg --yes http://127.0.0.1:8787
   ```

   首次启用时，命令可能显示浏览器授权链接。使用所属网络的管理员账号打开链接，允许 HTTPS 与 Funnel 后，命令才会完成配置。`--bg` 会让转发配置在后台保持启用。

2. 查看分配的 HTTPS 地址与转发目标：

   ```bash
   tailscale funnel status
   ```

3. 使用输出中的站点根地址更新配置：

   ```bash
   npm run setup -- --public-url https://device.example.ts.net
   ```

   将示例地址替换为实际地址，不要附加 `/mcp`。在 `.env` 中设置 `TRUST_PROXY_HOPS=1`，表示本服务前方只有 Tailscale 这一层代理。

4. 重新创建容器以加载环境变量：

   ```bash
   docker compose up -d --no-build mcp
   ```

5. 使用未加入该 Tailscale 网络的设备，检查 `/healthz` 和两个 OAuth 发现地址。

   `/healthz` 应返回 HTTP 200，未授权的 `/mcp` 请求应返回 HTTP 401。网络内部的 MagicDNS 可能把同一域名解析到 Tailscale 内网 IP，因此本机检查不能证明公网入口可达。`tailscale funnel status` 显示启用后，仍应确认公共 DNS 返回地址记录。

   MCP 连接地址为同一站点的 `/mcp`。访问时不需要安装 Tailscale；服务仍通过 OAuth 核对用户身份。`tailscale serve` 只提供网络内部访问，不能代替这里的 Funnel 公网入口。

## 接入 ChatGPT

1. 确认公开地址能访问 `/healthz`。
2. 确认 `/.well-known/oauth-authorization-server` 返回发现信息。
3. 确认 `/.well-known/oauth-protected-resource/mcp` 的 `resource` 与公开 MCP 地址相同。
4. 在 ChatGPT 中创建个人 MCP 插件，填写 `https://mcp.example.com/mcp`。
5. 选择 OAuth，并将 Client ID 与 Client Secret 留空，使用动态客户端注册。
6. 在本服务授权页核对应用和回调地址，输入 `.env` 中的 `OWNER_KEY`。
7. 打开生成的插件详情页，确认插件已安装。
8. 检查工具列表，确认 39 个工具已加载并启用。
9. 新建 Chat 或 Work 对话，输入 `@` 并选择插件。
10. 调用 `get_profile` 核对身份，再查询学期和一项业务数据。

服务提供 OAuth 2.1 的授权码与 PKCE 流程、资源元数据、动态注册和刷新令牌轮换。ChatGPT 入口是否可见，取决于账号与工作区策略。接入要求以 [OpenAI 插件认证文档](https://developers.openai.com/plugins/build/auth)为准。

拥有者更换 `OWNER_KEY` 后，应重启服务并在 ChatGPT 中重新授权。替换校宝账号后，所有已授权客户端都将读取新账号；只应把本服务授权给本人使用。

使用上传、提交或事件创建工具前，客户端还应取得 `schoolis.write`。工具的 OAuth 提示会要求重新授权。旧只读授权不能通过刷新自动扩权。微软文件上传另需 `Files.ReadWrite`，操作步骤见[作业写入与文件上传](writes.md)。

### OAuth 发现失败

如果 ChatGPT 提示 `Couldn’t discover OAuth settings`，先确认 Server URL 为公开 HTTPS 地址，且路径为 `/mcp`。

在网络外部检查两个 OAuth 发现地址。两个地址应返回 HTTP 200 和 JSON。未授权的 `/mcp` 应返回 HTTP 401，响应头 `WWW-Authenticate` 应包含正确的 `resource_metadata` 地址。

如果本机检查成功，但外部检查失败，检查公共 DNS、TLS 证书和隧道。Funnel 初次启用后，公共 DNS 可能需要最多 10 分钟传播；不同解析器也可能保留此前的空结果。等待缓存过期后重试。超出传播时间仍失败时，继续检查 Funnel 的公共 DNS 与转发状态。

手动填写授权端点不能解决 DNS 或 HTTPS 访问失败。`OWNER_KEY` 只在本服务的授权页面输入，不应填入 Client Secret。

### 对话中没有工具

OAuth 授权成功不表示当前对话已加载插件工具。先在插件详情页选择 Refresh，确认工具列表中包含 `get_profile`、`get_assignment_statistics`、`read_assignment_attachment`、`list_teams_classes` 等 39 个工具，并检查工具开关。确认插件已安装后，新建 Chat 或 Work 对话，输入 `@` 并选择插件。

插件可用于 Chat 和 Work，实际工具权限取决于当前账号、工作区和对话配置。支持范围以 [OpenAI 插件使用文档](https://learn.chatgpt.com/docs/plugins)为准。

如果刷新后工具列表仍为空，记录详情页的连接错误。如果详情页列出了工具，但新对话仍不能调用，检查当前账号、工作区和所选插件是否与创建连接时一致。模型在对话中表示“没有工具”，不能单独证明服务端没有返回工具。

## 配置项

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8787` | 本机监听端口 |
| `PUBLIC_URL` | `http://localhost:8787` | OAuth 与 MCP 的公开站点根地址 |
| `OWNER_KEY` | 初始化时生成 | 拥有者授权密钥，至少 32 个字符 |
| `SCHOOLIS_URL` | `https://tsinglanstudent.schoolis.cn` | 学校站点根地址 |
| `SESSION_FILE` | `sessions/schoolis.json` | 校宝会话与固定身份 |
| `CREDENTIALS_FILE` | `secrets/schoolis.json` | 可选自动登录凭据 |
| `OAUTH_FILE` | `secrets/oauth.json` | OAuth 客户端与令牌状态 |
| `MICROSOFT_FILE` | `secrets/microsoft.json` | 可选微软账号身份、应用配置及令牌 |
| `WRITE_STATE_FILE` | `secrets/writes.json` | 私有写入去重记录和结果元数据 |
| `MICROSOFT_CLIENT_ID` | 未设置 | 首次设备代码登录使用的微软应用 ID |
| `MICROSOFT_TENANT_ID` | 未设置 | 首次设备代码登录使用的学校租户 ID |
| `REQUEST_TIMEOUT_MS` | `15000` | 单次校宝请求超时 |
| `CACHE_TTL_SECONDS` | `60` | 查询缓存与身份检查间隔 |
| `TRUST_PROXY_HOPS` | `0` | 可信反向代理层数 |

`HOST` 与 `PORT` 控制直接运行的服务。Compose 固定容器内端口为 `8787`，并把 `.env` 的 `PORT` 用作本机映射端口。URL 只允许 HTTPS 站点根地址；本机开发可使用 HTTP。
