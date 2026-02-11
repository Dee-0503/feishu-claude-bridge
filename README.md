# Feishu Claude Bridge

连接 Claude Code 与飞书的桥接服务，支持：

- **任务通知**：Claude 完成任务时发送飞书通知
- **授权交互**：敏感命令执行前通过飞书授权
- **双模式回调**：支持 WebSocket 长连接和 HTTP Webhook 两种模式
- **电话呼叫**：超时未响应时通过阿里云语音通知（开发中）

## 🚀 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

复制 `apps/server/.env.example` 到 `apps/server/.env` 并填写：

```bash
cp apps/server/.env.example apps/server/.env
```

**必需配置**：
- `FEISHU_APP_ID` - 飞书应用 App ID
- `FEISHU_APP_SECRET` - 飞书应用 App Secret
- `FEISHU_VERIFICATION_TOKEN` - 飞书验证 Token
- `FEISHU_TARGET_ID` - 接收通知的用户 open_id 或群 chat_id
- `HOOK_SECRET` - Hook 请求验证密钥

**可选配置**：
- `FEISHU_USE_LONG_CONNECTION` - 是否使用 WebSocket 长连接模式（默认 `false`）

### 3. 选择回调模式

#### 方式 A: WebSocket 长连接模式（推荐用于本地开发）

```bash
# .env 文件中设置
FEISHU_USE_LONG_CONNECTION=true
```

**优势**：
- ✅ 无需公网 IP 或域名
- ✅ 无需 SSL 证书
- ✅ 无需配置飞书回调地址
- ✅ 启动即用，适合本地开发

#### 方式 B: HTTP Webhook 模式（推荐用于生产环境）

```bash
# .env 文件中设置
FEISHU_USE_LONG_CONNECTION=false
```

**优势**：
- ✅ 无状态，易于水平扩展
- ✅ 支持 Serverless 部署
- ✅ 标准 REST API 架构

**额外步骤**：需要在飞书开放平台配置回调地址（详见下文）

### 4. 启动服务

```bash
pnpm dev
```

查看启动日志确认模式：
- WebSocket 模式：`📡 Mode: WebSocket Long Connection`
- HTTP 模式：`🌐 Mode: HTTP Webhook`

### 4. 配置 Claude Code Hooks

将 `hooks/hooks.example.json` 内容添加到你的 Claude Code 配置（`~/.claude/settings.json`）：

```json
{
  "hooks": {
    "Stop": [
      {
        "command": "FEISHU_BRIDGE_URL=http://your-server:3000 node /path/to/hooks/notify.js stop",
        "async": true
      }
    ]
  }
}
```

## 飞书应用配置

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 创建"企业自建应用"
3. 添加"机器人"能力
4. 配置权限：
   - `im:message` - 发送消息
   - `im:message.group_at_msg` - 接收@消息
   - `card.action.trigger` - 卡片按钮回调
5. 获取 App ID、App Secret 和 Verification Token

### HTTP Webhook 模式额外配置

如果使用 HTTP Webhook 模式（`FEISHU_USE_LONG_CONNECTION=false`），需要：

1. **事件订阅** > 请求地址配置
   - 填写: `https://your-domain/api/feishu/webhook`
   - 点击验证（确保服务器已启动）

2. **应用功能** > 机器人 > 卡片请求网址
   - 填写: `https://your-domain/api/feishu/webhook`
   - 保存配置

**注意**：
- 必须使用 HTTPS（飞书不支持 HTTP）
- 本地开发需要使用 ngrok 或 cloudflare tunnel 暴露公网地址

### WebSocket 模式配置

WebSocket 模式（`FEISHU_USE_LONG_CONNECTION=true`）无需配置回调地址，服务器启动后自动连接飞书。

## 📚 文档

- [WebSocket 模式详细说明](apps/server/WEBSOCKET_MODE.md) - 双模式架构设计和使用指南
- [迁移指南](apps/server/MIGRATION_GUIDE.md) - 如何在两种模式之间切换

## API 端点

### Hook 端点

- `POST /api/hook/stop` - 任务完成通知
- `POST /api/hook/pre-tool` - 工具执行前通知
- `POST /api/hook/notification` - 通用通知

### 飞书回调

- `POST /api/feishu/webhook` - 飞书事件回调

## 开发计划

- [x] Phase 1: 基础单向通知
- [ ] Phase 2: 双向通信
- [ ] Phase 3: 授权交互
- [ ] Phase 4: 电话呼叫

## License

MIT
