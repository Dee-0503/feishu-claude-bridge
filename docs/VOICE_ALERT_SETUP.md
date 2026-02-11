# Phase4: 飞书电话加急提醒配置指南

## 功能说明
当检测到高风险命令（rm -rf, git push --force等）时，自动向管理员发送**加急消息**，触发：
- 📞 **电话铃声提醒**
- 📱 **弹窗通知**
- 💬 **短信提醒**（部分企业版支持）

## 前置要求

### 1. 飞书企业版权限
**加急消息功能需要企业版权限**，请确认：
- ✅ 你的飞书账号是企业版（非个人版）
- ✅ 你的应用有「发送消息」权限
- ✅ 你的企业开启了「加急消息」功能

### 2. 飞书开放平台配置

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 创建/选择你的应用
3. 添加权限：
   - `im:message` - 发送消息
   - `im:message:send_as_bot` - 以应用身份发消息
4. 获取凭证：
   - `App ID`
   - `App Secret`

### 3. 获取管理员 open_id

管理员的 `open_id` 用于接收加急通知。获取方式：

**方法1：通过API获取**
```bash
curl -X POST 'https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id' \
  -H 'Authorization: Bearer YOUR_TENANT_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "emails": ["admin@company.com"]
  }'
```

**方法2：通过飞书管理后台**
1. 进入「管理后台」→「通讯录」
2. 找到管理员用户
3. 查看「用户 ID」（即 open_id）

## 环境变量配置

在 `.env` 文件中配置：

```bash
# 飞书应用凭证
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

# Phase4: 启用电话加急提醒
FEISHU_VOICE_ENABLED=true

# Phase2: Bot配置（用于双向通信）
FEISHU_BOT_OPEN_ID=ou_xxxxxxxxxxxx
```

## 项目配置

编辑 `data/project-groups.json`，为每个项目配置管理员：

```json
{
  "/Users/你的用户名/项目路径": {
    "chatId": "oc_xxxxxxxxxxxx",
    "projectName": "my-project",
    "projectPath": "/Users/你的用户名/项目路径",
    "createdAt": "2026-02-11T00:00:00.000Z",
    "adminUserId": "ou_管理员的open_id",
    "enableVoiceAlert": true
  }
}
```

**参数说明**：
- `adminUserId`: 接收加急通知的管理员 open_id（必填）
- `enableVoiceAlert`: 是否启用加急提醒（可选，默认true）

## 使用示例

### 触发场景
当Claude Code执行以下高风险命令时自动触发：

```bash
# ❌ 高风险 - 触发加急通知
rm -rf /important_data
git push origin main --force
DROP DATABASE production
sudo rm /etc/hosts
dd if=/dev/zero of=/dev/sda

# ✅ 安全 - 不触发
ls -la
git status
rm file.txt
```

### 管理员体验
1. **收到加急通知**：
   - 飞书客户端弹窗
   - 手机铃声响起
   - 短信提醒（如支持）

2. **查看详情**：
   - 打开飞书查看加急消息
   - 显示命令详情、项目路径、会话ID

3. **同时收到授权卡片**：
   - 在对应项目群看到授权请求卡片
   - 点击「允许」或「拒绝」

## 测试验证

### 1. 测试加急消息发送
```bash
cd apps/server
npm test -- voice-alert
```

### 2. 手动测试
在测试环境中执行：
```bash
curl -X POST http://localhost:3000/api/hook/pre-tool \
  -H "Content-Type: application/json" \
  -H "X-Hook-Secret: your_secret" \
  -d '{
    "session_id": "test-session",
    "tool": "Bash",
    "tool_input": {"command": "rm -rf /test"},
    "cwd": "/Users/你的用户名/项目路径"
  }'
```

检查：
- ✅ 管理员收到加急通知（铃声）
- ✅ 飞书消息显示命令详情
- ✅ 项目群收到授权卡片

## API参数说明

### 加急消息 API
使用飞书 SDK 发送加急消息：

```typescript
await feishuClient.im.message.create({
  params: {
    receive_id_type: 'open_id',
  },
  data: {
    receive_id: adminUserId,
    msg_type: 'text',
    content: JSON.stringify({ text: '消息内容' }),
    urgent: {
      is_urgent: true,              // 标记为加急
      urgent_reason: '高风险命令需要立即确认'  // 加急原因
    },
  },
});
```

### 权限要求
确保你的飞书应用有以下权限：
- `im:message` - 发送消息
- `im:message:send_as_bot` - 以机器人身份发送

## 常见问题

### Q: 没有收到电话铃声？
A: 检查：
1. 是否企业版飞书（个人版不支持加急消息）
2. `FEISHU_VOICE_ENABLED=true` 是否配置
3. `adminUserId` 是否正确
4. 用户是否开启了飞书通知权限

### Q: 提示权限不足？
A: 需要在飞书开放平台为应用添加「发送消息」权限，并重新获取 `access_token`

### Q: 如何关闭加急提醒？
A: 两种方式：
1. 全局关闭：设置 `FEISHU_VOICE_ENABLED=false`
2. 项目关闭：在 `project-groups.json` 中设置 `"enableVoiceAlert": false`

### Q: 加急消息收费吗？
A: 飞书企业版功能，具体收费请咨询飞书销售

## 技术实现

### 高风险命令检测
`apps/server/src/services/voice-alert.ts`:
- `isHighRiskCommand()` - 8种模式检测
- `sendVoiceAlert()` - 发送加急消息
- 异步非阻塞设计，不影响授权流程

### 集成点
`apps/server/src/routes/hook.ts` - `/pre-tool` 端点：
```typescript
if (command && isHighRiskCommand(command)) {
  const adminUserId = await getAdminUserId(cwd);
  if (adminUserId && process.env.FEISHU_VOICE_ENABLED === 'true') {
    sendVoiceAlert({ userId: adminUserId, command, projectPath, sessionId })
      .catch(err => log('error', 'voice_alert_send_failed', { error: String(err) }));
  }
}
```

## 参考文档
- [飞书开放平台 - 发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [飞书 Node.js SDK](https://github.com/larksuite/node-sdk)
- [飞书企业版功能对比](https://www.feishu.cn/product/pricing)
