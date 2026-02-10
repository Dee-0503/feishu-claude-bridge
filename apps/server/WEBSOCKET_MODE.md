# 飞书回调双模式架构

## 概述

Phase3 支持两种接收飞书事件回调的方式：

| 模式 | 说明 | 适用场景 | 配置要求 |
|------|------|----------|----------|
| **WebSocket 长连接** | 客户端主动连接飞书服务器 | 本地开发、测试、防火墙后服务器 | 仅需 App ID 和 Secret |
| **HTTP Webhook** | 飞书服务器推送到公网地址 | 生产环境（Serverless、负载均衡） | 需要公网域名和 SSL 证书 |

## 模式切换

通过环境变量 `FEISHU_USE_LONG_CONNECTION` 控制：

```bash
# WebSocket 长连接模式（推荐用于本地开发）
FEISHU_USE_LONG_CONNECTION=true

# HTTP Webhook 模式（推荐用于云部署）
FEISHU_USE_LONG_CONNECTION=false
```

无需修改代码，只需修改 `.env` 文件即可切换。

## WebSocket 长连接模式

### 优势
- ✅ 无需公网 IP 或域名
- ✅ 无需 SSL 证书
- ✅ 防火墙友好（主动连出）
- ✅ 本地开发即插即用
- ✅ 不需要配置飞书开放平台回调地址

### 配置步骤

1. **配置 .env 文件**
   ```bash
   FEISHU_APP_ID=cli_xxx
   FEISHU_APP_SECRET=xxx
   FEISHU_VERIFICATION_TOKEN=xxx
   FEISHU_USE_LONG_CONNECTION=true
   ```

2. **启动服务器**
   ```bash
   npm run dev
   ```

3. **验证启动日志**
   ```
   🚀 Feishu Claude Bridge server running on port 3000
   📡 Mode: WebSocket Long Connection
      ℹ️  No public URL needed - client connects to Feishu
      ✅ WebSocket client started successfully
   ```

### 注意事项
- WebSocket 连接是有状态的，不支持简单的水平扩展
- 如需多实例，需要实现连接池管理
- 网络中断时 SDK 会自动重连
- 适合常驻进程部署（ECS、Docker、PM2）

## HTTP Webhook 模式

### 优势
- ✅ 无状态，易于水平扩展
- ✅ 支持 Serverless 部署（函数计算）
- ✅ 标准 REST API 架构
- ✅ 可用负载均衡器分发请求

### 配置步骤

1. **配置 .env 文件**
   ```bash
   FEISHU_APP_ID=cli_xxx
   FEISHU_APP_SECRET=xxx
   FEISHU_VERIFICATION_TOKEN=xxx
   FEISHU_USE_LONG_CONNECTION=false
   ```

2. **启动服务器**
   ```bash
   npm run dev
   ```

3. **暴露公网地址（本地开发需要）**
   ```bash
   # 使用 cloudflare tunnel
   cloudflared tunnel --url http://localhost:3000

   # 或使用 ngrok
   ngrok http 3000
   ```

4. **配置飞书开放平台**
   - 进入飞书开放平台 > 事件订阅 > 请求地址配置
   - 填写: `https://your-tunnel-url/api/feishu/webhook`
   - 进入开放平台 > 应用功能 > 机器人 > 卡片请求网址
   - 填写: `https://your-tunnel-url/api/feishu/webhook`

### 注意事项
- 本地开发需要隧道工具（cloudflared/ngrok）
- 云部署需要域名和 SSL 证书
- 飞书要求 HTTPS（不支持 HTTP）

## 架构设计

### 共享业务逻辑
两种模式使用相同的事件处理函数（`src/feishu/event-handlers.ts`）：

```
┌─────────────────────────────────────┐
│  Feishu Server                      │
└────────┬─────────────┬──────────────┘
         │             │
    HTTP │        WS   │ (outbound)
  Webhook│  Long Connection
         ↓             ↓
┌────────────────────────────────────┐
│  Phase3 Server                      │
│  ┌──────────────────────────────┐  │
│  │  Event Handlers (Shared)     │  │
│  │  - handleMessage()           │  │
│  │  - handleCardAction()        │  │
│  └──────────────────────────────┘  │
│         ↑              ↑            │
│  ┌──────┴───┐    ┌────┴─────────┐  │
│  │ HTTP     │    │ WebSocket    │  │
│  │ Webhook  │    │ Client       │  │
│  │ Route    │    │ (ws-client)  │  │
│  └──────────┘    └──────────────┘  │
└────────────────────────────────────┘
```

### 文件结构
```
src/
├── feishu/
│   ├── event-handlers.ts    # 共享业务逻辑
│   ├── ws-client.ts          # WebSocket 客户端
│   ├── client.ts             # Feishu API 客户端
│   └── message.ts            # 消息发送
├── routes/
│   └── feishu.ts             # HTTP webhook 路由
└── index.ts                  # 服务器入口（条件启动）
```

## 云部署建议

### 阿里云 ECS / Docker（推荐长连接）
```bash
# .env 配置
FEISHU_USE_LONG_CONNECTION=true
NODE_ENV=production

# 使用 PM2 启动单实例
pm2 start npm --name "feishu-bridge" -- start
pm2 save
```

**优势**：无需域名和 SSL 证书，节省成本

### 阿里云函数计算 / AWS Lambda（必须用 HTTP）
```bash
# .env 配置
FEISHU_USE_LONG_CONNECTION=false

# 配置 API 网关触发器
# 路径: /api/feishu/webhook
```

**限制**：Serverless 无状态，无法维持长连接

## 测试验证

### 测试 WebSocket 模式
```bash
# 1. 配置环境变量
echo "FEISHU_USE_LONG_CONNECTION=true" >> .env

# 2. 启动服务器
npm run dev

# 3. 触发测试流程
# - Claude Code 发送 pre-tool hook
# - 飞书收到授权卡片
# - 点击"允许"按钮
# - 验证日志: ws_card_action_received → card_action_received

# 4. 验证卡片更新为"已授权"
```

### 测试 HTTP 模式
```bash
# 1. 配置环境变量
echo "FEISHU_USE_LONG_CONNECTION=false" >> .env

# 2. 启动隧道
cloudflared tunnel --url http://localhost:3000

# 3. 配置飞书开放平台回调地址

# 4. 测试同样的授权流程
# 验证两种模式行为一致
```

## 故障排查

### WebSocket 模式常见问题

**问题**: 启动时提示 "Failed to start WebSocket client"
```
解决方案:
1. 检查 FEISHU_APP_ID 和 FEISHU_APP_SECRET 是否正确
2. 检查网络连接（需要能访问飞书 API）
3. 查看详细日志定位具体错误
```

**问题**: 事件接收不到
```
解决方案:
1. 确认飞书开放平台已开启事件订阅权限
2. 确认机器人已添加到测试群组
3. 检查日志是否有 ws_event_received 或 ws_card_action_received
```

### HTTP 模式常见问题

**问题**: 飞书提示 "请求地址配置失败"
```
解决方案:
1. 确认 URL 是 HTTPS（飞书不支持 HTTP）
2. 确认服务器可公网访问
3. 检查 FEISHU_VERIFICATION_TOKEN 是否配置正确
```

**问题**: 卡片按钮点击无响应
```
解决方案:
1. 检查"卡片请求网址"是否配置为同一个 /api/feishu/webhook
2. 查看服务器日志是否收到回调
3. 验证 token 校验是否通过
```

## 性能与扩展

### WebSocket 模式
- **并发限制**: 单实例单连接
- **扩展方式**: 需要实现连接池 + 消息分发
- **推荐场景**: 中小型应用（< 1000 并发）

### HTTP 模式
- **并发限制**: 取决于服务器和负载均衡
- **扩展方式**: 增加服务器实例 + 负载均衡器
- **推荐场景**: 大型应用（需要高可用和水平扩展）

## 回滚方案

如果 WebSocket 模式出现问题，可以随时切回 HTTP 模式：

```bash
# 1. 修改环境变量
FEISHU_USE_LONG_CONNECTION=false

# 2. 重启服务器
pm2 restart feishu-bridge

# 3. 配置飞书开放平台回调地址（如果尚未配置）
```

## 参考资料

- [飞书开放平台 - 事件订阅](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM)
- [Lark Node SDK 文档](https://github.com/larksuite/node-sdk)
- [WebSocket 长连接说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/overview)
