# Feishu Claude Bridge

连接 Claude Code 与飞书的桥接服务，支持：

- **任务通知**：Claude 完成任务时发送飞书通知
- **授权交互**：敏感命令执行前通过飞书授权（开发中）
- **电话呼叫**：超时未响应时通过阿里云语音通知（开发中）

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

复制 `apps/server/.env.example` 到 `apps/server/.env` 并填写：

```bash
cp apps/server/.env.example apps/server/.env
```

需要配置：
- `FEISHU_APP_ID` - 飞书应用 App ID
- `FEISHU_APP_SECRET` - 飞书应用 App Secret
- `FEISHU_TARGET_ID` - 接收通知的用户 open_id 或群 chat_id
- `HOOK_SECRET` - Hook 请求验证密钥

### 3. 启动服务

```bash
pnpm dev
```

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
5. 获取 App ID 和 App Secret

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
