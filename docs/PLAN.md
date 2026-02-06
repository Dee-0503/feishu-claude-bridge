# 飞书 Claude Code 双向通信系统

## Context

用户希望实现 Claude Code 与飞书的**双向通信**：
1. **Claude → 飞书**：任务完成/需要授权时发送通知
2. **飞书 → Claude**：通过飞书回复来授权操作、发送新指令
3. **语音呼叫**：超时未响应时电话通知

**用户条件**：
- ✅ 企业版飞书管理员权限
- ✅ 有云服务器可部署
- ✅ 技术栈灵活

**结论**：需要开发**独立服务项目** `feishu-claude-bridge`

**项目位置**：`/Users/ceemac/my_product/feishu-claude-bridge`
**代码托管**：推送到 GitHub

## 系统架构

```
┌─────────────────┐     Hooks (HTTP)    ┌─────────────────┐
│  Claude Code    │ ───────────────────▶│  Bridge 服务     │
│  (本地终端)      │                      │  (云服务器)      │
└─────────────────┘                      └────────┬────────┘
        ▲                                         │
        │                                         │ 飞书 API
        │ WebSocket/Polling                       ▼
        │                                ┌─────────────────┐
        │                                │   飞书开放平台    │
        └────────────────────────────────┤   (机器人)       │
              用户飞书回复 → Bridge → Claude    └─────────────────┘
```

### 通信流程

**Claude → 飞书：**
1. Claude Code 执行 Hook 脚本
2. Hook 脚本 POST 到 Bridge 服务
3. Bridge 调用飞书 API 发送消息

**飞书 → Claude：**
1. 用户在飞书回复
2. 飞书回调 Bridge 服务
3. Bridge 通过 WebSocket/长轮询 推送到本地 Claude

## 技术选型

**推荐：TypeScript + Node.js**

理由：
- 飞书官方 SDK 支持良好 (`@larksuiteoapi/node-sdk`)
- 异步处理天然适合消息系统
- 生态丰富，开发效率高

## 实现计划

### Phase 1: 基础单向通知 (MVP)

**目标**：Claude 任务完成后飞书收到通知

1. **创建项目** `feishu-claude-bridge`
   - 初始化 TypeScript + Express
   - 配置飞书 SDK

2. **实现飞书消息发送**
   - 创建飞书应用 + 机器人
   - 实现发送文本消息
   - 实现发送消息卡片（带操作按钮）

3. **配置 Claude Code Hooks**
   - `Stop` 事件发送任务完成通知
   - `PreToolUse` 发送敏感命令预警

**关键文件**：
- `src/feishu/client.ts` - 飞书 API 封装
- `src/routes/webhook.ts` - 接收 Hook 请求
- `hooks/notify.js` - Claude Code hook 脚本

### Phase 2: 双向通信

**目标**：飞书回复能传递到 Claude

1. **飞书事件订阅**
   - 配置消息接收回调 URL
   - 处理事件验证
   - 解析用户消息

2. **本地 Agent**
   - 本地运行轻量进程连接 Bridge
   - WebSocket 或 HTTP 长轮询
   - 接收飞书消息并注入 Claude

3. **Claude 输入注入**
   - 研究 Claude Code CLI 输入方式
   - 可能方案：`echo "command" | claude`
   - 或通过 Hooks 的输入替换

### Phase 3: 授权交互

**目标**：敏感命令可以在飞书授权

1. **Claude Code 授权选项类型**

   Claude Code 的授权提示不是固定的，需要支持多种情况：

   | 场景 | 选项数 | 示例 |
   |------|--------|------|
   | 简单确认 | 2 个 | "允许" / "拒绝" |
   | 权限范围 | 3 个 | "仅本次" / "本会话" / "拒绝" |
   | 多选操作 | 3+ 个 | "允许全部" / "逐个确认" / "拒绝全部" |

   **设计要点**：
   - 消息卡片按钮需要动态生成
   - Hook 脚本需要解析 Claude 的授权提示文本
   - 按钮需要携带选项编号/标识

2. **待授权状态管理**
   - Redis/内存存储待授权请求
   - **分级超时策略**：
     1. 发送飞书消息通知
     2. 第一次超时（可配置，默认 3 分钟）→ 触发电话呼叫
     3. 电话后等待 5 分钟
     4. 最终超时 → 默认选择"拒绝"
   - 每个请求存储：session_id, 命令详情, 选项列表, 创建时间, 状态（pending/called/expired）

3. **消息卡片交互**
   ```json
   {
     "header": { "title": "⚠️ Claude 需要授权" },
     "elements": [
       { "tag": "div", "text": "命令: git push origin main" },
       { "tag": "action", "actions": [
         { "tag": "button", "text": "允许", "value": "allow" },
         { "tag": "button", "text": "仅本次", "value": "once" },
         { "tag": "button", "text": "拒绝", "value": "deny" }
       ]}
     ]
   }
   ```

4. **授权结果注入**
   - 用户点击按钮 → 飞书回调 → Bridge 服务
   - Bridge 通知本地 Agent → 模拟用户输入选项
   - 或通过 Hook 的 stdout 返回结果（需验证）

### Phase 4: 电话呼叫

**目标**：超时未响应时电话通知，电话后再给 5 分钟响应时间

1. **电话服务：阿里云语音通知**
   - 使用阿里云 Dysmsapi（语音服务）
   - SDK: `@alicloud/dysmsapi20170525`
   - 需要：AccessKey、语音模板审核

2. **分级提醒流程**
   ```
   ┌─────────────┐     3分钟      ┌─────────────┐     5分钟      ┌─────────────┐
   │  飞书消息    │ ─────────────▶│  电话呼叫    │ ─────────────▶│  默认拒绝    │
   │  (立即发送)  │   无响应       │  (唤醒用户)  │   仍无响应     │  (超时处理)  │
   └─────────────┘               └─────────────┘               └─────────────┘
         │                              │                              │
         ▼                              ▼                              ▼
     用户响应 ────────────────────▶ 用户响应 ────────────────────▶ 结束等待
   ```

3. **电话内容**
   - TTS 语音：「您有一个 Claude Code 操作等待授权，请尽快处理」
   - 可选：播放命令摘要

4. **配置项**
   - 第一次超时时间（默认 3 分钟）
   - 电话后等待时间（默认 5 分钟）
   - 电话号码

## 项目结构

```
feishu-claude-bridge/
├── apps/
│   ├── server/              # 云端 Bridge 服务
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── routes/
│   │   │   │   ├── hook.ts      # 接收 Claude Hook
│   │   │   │   └── feishu.ts    # 飞书回调
│   │   │   ├── feishu/
│   │   │   │   ├── client.ts
│   │   │   │   ├── message.ts
│   │   │   │   └── voice.ts
│   │   │   └── state/
│   │   │       └── pending.ts
│   │   └── package.json
│   │
│   └── agent/               # 本地 Agent（接收飞书消息）
│       ├── src/
│       │   ├── index.ts
│       │   ├── bridge.ts    # 连接云端服务
│       │   └── claude.ts    # 注入 Claude 输入
│       └── package.json
│
├── hooks/                   # Claude Code hooks
│   ├── notify.js
│   └── hooks.json
│
├── package.json             # Monorepo 配置
└── README.md
```

## 飞书应用配置指南

### 1. 创建应用
- 登录 [飞书开放平台](https://open.feishu.cn/)
- 创建"企业自建应用"
- 获取 App ID 和 App Secret

### 2. 添加机器人能力
- 应用能力 → 添加"机器人"
- 配置机器人名称和头像

### 3. 配置权限
消息相关：
- `im:message` - 获取与发送单聊、群聊消息
- `im:message.group_at_msg` - 接收群聊@机器人消息

语音呼叫：
- `vc:call` - 发起音视频通话
- `contact:user.phone:readonly` - 读取用户手机号

### 4. 配置事件订阅
- 请求地址：`https://your-server.com/feishu/webhook`
- 订阅事件：`im.message.receive_v1`

## 验证方式

1. **Phase 1 验证**：
   - 启动 Bridge 服务
   - 配置 Claude Code hooks 指向服务
   - 执行 `claude "hello"`
   - 检查飞书是否收到通知

2. **Phase 2 验证**：
   - 在飞书回复消息
   - 检查 Claude 终端是否显示

3. **Phase 3 验证**：
   - 执行 `claude "git push"`
   - 在飞书看到授权卡片
   - 点击"允许"后 Claude 继续执行

4. **Phase 4 验证**：
   - 触发授权请求后不响应
   - 超时后接到飞书语音

## 下一步

Phase 1 预计工作量：2-3 天
- 创建项目骨架
- 飞书应用配置
- 基础消息发送
- Claude Hook 配置

---

## 方案挑刺（潜在问题与风险）

### 🔴 高风险问题

#### 1. Claude Code 输入注入机制不明确
**问题**：目前计划假设可以通过 `echo "command" | claude` 或类似方式向正在运行的 Claude 会话注入用户输入，但这需要验证。

**风险**：如果 Claude Code CLI 不支持外部输入注入（很可能不支持），整个"飞书→Claude"的通信链路就断了。

**建议**：
- Phase 2 开始前先验证 Claude Code CLI 的输入机制
- 备选方案：使用 MCP Server 而不是直接 CLI 注入
- 或者改用"新开会话"的方式而不是"注入现有会话"

#### 2. 授权交互的时序问题
**问题**：`PreToolUse` Hook 在授权弹窗**之前**执行。当 Hook 发送通知后，用户在飞书点击"允许"时，如何让 Claude 知道并继续？

**风险**：这不是简单的"发送消息"，而是需要**阻塞等待**用户响应。

**建议**：
- Hook 需要用同步模式（不用 `async: true`）
- Hook 脚本内部实现轮询等待授权结果
- 设置合理超时（如 5 分钟）

#### 3. 会话标识问题
**问题**：Claude Code 可能同时运行多个会话，如何区分哪个会话需要授权？

**风险**：用户在飞书点击"允许"，但不知道授权的是哪个会话。

**建议**：
- 每个会话生成唯一 session_id
- 通知消息中包含项目路径/命令详情
- 消息卡片中隐藏 session_id 元数据

### 🟡 中等风险问题

#### 4. 电话服务选型
**问题**：飞书语音呼叫 API 有使用限制和调用频率限制，且用户必须在线。

**更好方案**：使用专业电话服务
- **阿里云语音通知**：国内稳定，0.045元/条
- **Twilio**：国际通用，功能强大
- 优点：真正的电话呼叫，不依赖飞书在线状态

**建议**：
- 优先使用阿里云/Twilio
- 飞书语音作为备选

#### 5. 本地 Agent 稳定性
**问题**：本地 Agent 需要常驻运行才能接收飞书消息。

**风险**：Agent 崩溃/断连时飞书消息丢失。

**建议**：
- 使用 PM2 或 systemd 管理进程
- 实现重连机制
- 云端缓存未送达消息

#### 6. 安全性考虑
**问题**：云端服务暴露 HTTP 接口，可能被恶意调用。

**风险**：
- 伪造 Hook 请求发送垃圾通知
- 伪造飞书回调执行恶意操作

**建议**：
- Hook 请求使用共享密钥验证
- 飞书回调使用官方签名验证
- 敏感操作需要二次确认

### 🟢 低风险但需注意

#### 7. 项目复杂度
**问题**：4 个 Phase 涉及多个技术领域（Node.js 后端、飞书 API、Claude Code Hooks、WebSocket）。

**建议**：
- 严格按 Phase 迭代，每个 Phase 完成后验证
- Phase 1 可以独立使用，不需要等全部完成

#### 8. 飞书 API 变更风险
**问题**：飞书开放平台 API 可能更新。

**建议**：
- 使用官方 SDK 而不是直接调用 HTTP API
- 关注飞书开发者公告

### 建议调整

1. **在 Phase 1 之后增加一个验证步骤**：测试 Claude Code CLI 的输入机制，决定 Phase 2 的技术路线

2. **Phase 3 授权交互可能是最难的部分**：考虑简化为"消息通知 + 人工回到终端操作"，而不是"飞书内完成授权"

3. **考虑 MCP Server 方案**：如果 Claude Code 支持 MCP，可能比 Hook + 本地 Agent 更优雅
