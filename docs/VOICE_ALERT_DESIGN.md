# Phase4: 飞书电话加急提醒 - 设计文档

## 功能需求

**触发场景**：
1. **授权消息超时未操作**：授权卡片发出后，工作时间内N分钟未点击「允许」或「拒绝」
2. **任务完成未回复**：任务完成通知发出后，工作时间内N分钟未回复消息

**提醒方式**：
- 📞 飞书电话铃声
- 📱 弹窗通知
- 💬 短信提醒（企业版支持）

---

## 核心设计

### 1. 延迟提醒调度器 (Delayed Alert Scheduler)

```typescript
interface PendingAlert {
  messageId: string;        // 飞书消息ID
  chatId: string;           // 项目群ID
  adminUserId: string;      // 接收提醒的管理员
  sessionId: string;        // Claude会话ID
  type: 'authorization' | 'task_complete';  // 提醒类型
  createdAt: Date;          // 消息发出时间
  timerId: NodeJS.Timeout;  // 定时器ID
}

class AlertScheduler {
  private pendingAlerts: Map<string, PendingAlert>;

  // 安排延迟提醒
  scheduleAlert(messageId: string, config: {
    chatId: string;
    adminUserId: string;
    sessionId: string;
    type: 'authorization' | 'task_complete';
    delayMinutes: number;
  }): void {
    // 检查是否在工作时间
    if (!isWorkingHours()) {
      console.log('⏰ 非工作时间，跳过提醒安排');
      return;
    }

    // 创建延迟定时器
    const timerId = setTimeout(() => {
      this.sendUrgentAlert(messageId);
    }, delayMinutes * 60 * 1000);

    // 存储待处理提醒
    this.pendingAlerts.set(messageId, {
      messageId,
      ...config,
      createdAt: new Date(),
      timerId,
    });
  }

  // 取消提醒（用户已操作）
  cancelAlert(messageId: string): void {
    const alert = this.pendingAlerts.get(messageId);
    if (alert) {
      clearTimeout(alert.timerId);
      this.pendingAlerts.delete(messageId);
      console.log('✅ 提醒已取消:', messageId);
    }
  }

  // 发送加急通知
  private async sendUrgentAlert(messageId: string): Promise<void> {
    const alert = this.pendingAlerts.get(messageId);
    if (!alert) return;

    try {
      const message = alert.type === 'authorization'
        ? `⚠️ 授权请求已等待${getWaitMinutes(alert.createdAt)}分钟，请尽快处理`
        : `📋 任务已完成${getWaitMinutes(alert.createdAt)}分钟，请查看结果`;

      await feishuClient.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: alert.adminUserId,
          msg_type: 'text',
          content: JSON.stringify({ text: message }),
          urgent: {
            is_urgent: true,
            urgent_reason: '长时间未响应，需要立即处理',
          },
        },
      });

      console.log('📞 电话提醒已发送:', messageId);
    } catch (error) {
      console.error('❌ 电话提醒失败:', error);
    } finally {
      this.pendingAlerts.delete(messageId);
    }
  }
}
```

### 2. 工作时间判断

```typescript
interface WorkingHours {
  enabled: boolean;
  timezone: string;          // 'Asia/Shanghai'
  weekdays: number[];        // [1, 2, 3, 4, 5] (周一到周五)
  startHour: number;         // 9
  endHour: number;           // 18
}

function isWorkingHours(config?: WorkingHours): boolean {
  const defaultConfig: WorkingHours = {
    enabled: true,
    timezone: 'Asia/Shanghai',
    weekdays: [1, 2, 3, 4, 5],
    startHour: 9,
    endHour: 18,
  };

  const settings = config || defaultConfig;
  if (!settings.enabled) return true;  // 禁用时间限制则总是提醒

  const now = new Date();
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: settings.timezone }));

  // 检查星期几
  const dayOfWeek = localTime.getDay();
  if (!settings.weekdays.includes(dayOfWeek)) {
    return false;
  }

  // 检查时间段
  const hour = localTime.getHours();
  return hour >= settings.startHour && hour < settings.endHour;
}
```

### 3. 集成点

#### 3.1 授权消息发送后安排提醒

**文件**：`apps/server/src/routes/hook.ts`

```typescript
router.post('/authorization', async (req, res) => {
  // ... 发送授权卡片 ...
  const { messageId, chatId } = await sendCardMessage({
    type: 'authorization_required',
    chatId,
    // ...
  });

  // 安排延迟提醒
  const adminUserId = await getAdminUserId(cwd);
  if (adminUserId && process.env.FEISHU_VOICE_ENABLED === 'true') {
    const delayMinutes = parseInt(process.env.VOICE_ALERT_DELAY_MINUTES || '5');
    alertScheduler.scheduleAlert(messageId, {
      chatId,
      adminUserId,
      sessionId: session_id,
      type: 'authorization',
      delayMinutes,
    });
  }

  res.json({ success: true });
});
```

#### 3.2 任务完成通知后安排提醒

**文件**：`apps/server/src/routes/hook.ts`

```typescript
router.post('/stop', async (req, res) => {
  // ... 发送任务完成卡片 ...
  const { messageId, chatId } = await sendCardMessage({
    type: 'task_complete',
    chatId,
    // ...
  });

  // 安排延迟提醒
  const adminUserId = await getAdminUserId(cwd);
  if (adminUserId && process.env.FEISHU_VOICE_ENABLED === 'true') {
    const delayMinutes = parseInt(process.env.VOICE_ALERT_DELAY_MINUTES || '10');
    alertScheduler.scheduleAlert(messageId, {
      chatId,
      adminUserId,
      sessionId: session_id,
      type: 'task_complete',
      delayMinutes,
    });
  }

  res.json({ success: true });
});
```

#### 3.3 用户操作后取消提醒

**文件**：`apps/server/src/routes/feishu.ts`

```typescript
async function handleCardAction(event: FeishuCardActionEvent): Promise<void> {
  const { action } = event;
  const value = JSON.parse(action.value);

  // 用户点击了授权按钮，取消提醒
  if (value.action === 'allow' || value.action === 'deny') {
    const parentMessageId = event.context?.open_message_id;
    if (parentMessageId) {
      alertScheduler.cancelAlert(parentMessageId);
    }
  }
}

async function handleMessage(event: FeishuMessageEvent): Promise<void> {
  // 用户回复了任务完成通知，取消提醒
  if (event.message.parent_id) {
    alertScheduler.cancelAlert(event.message.parent_id);
  }

  // ... 原有逻辑 ...
}
```

---

## 配置项

### 环境变量

```bash
# 启用电话加急提醒
FEISHU_VOICE_ENABLED=true

# 延迟时间（分钟）
VOICE_ALERT_DELAY_MINUTES=5

# 工作时间配置
VOICE_ALERT_WORKING_HOURS_ENABLED=true
VOICE_ALERT_TIMEZONE=Asia/Shanghai
VOICE_ALERT_WEEKDAYS=1,2,3,4,5
VOICE_ALERT_START_HOUR=9
VOICE_ALERT_END_HOUR=18
```

### 项目配置

`data/project-groups.json`:

```json
{
  "/Users/user/my-project": {
    "chatId": "oc_xxx",
    "adminUserId": "ou_xxx",
    "enableVoiceAlert": true,
    "voiceAlertDelayMinutes": 5
  }
}
```

---

## 实现优先级

### P0 - 核心功能
- [x] AlertScheduler 基础框架
- [x] 工作时间判断逻辑
- [x] 授权消息延迟提醒
- [x] 任务完成延迟提醒
- [x] 用户操作后取消机制

### P1 - 增强功能
- [ ] 持久化待处理提醒（服务重启后恢复）
- [ ] 提醒升级策略（5分钟 → 10分钟 → 15分钟）
- [ ] 管理员静音时段配置
- [ ] 提醒统计和日志

### P2 - 优化
- [ ] 批量提醒合并（同一用户多条消息合并）
- [ ] 自适应延迟（根据历史响应时间调整）
- [ ] 飞书「请勿打扰」状态检测

---

## 测试计划

### 单元测试
- `isWorkingHours()` - 各种时区和时间段
- `AlertScheduler.scheduleAlert()` - 定时器创建
- `AlertScheduler.cancelAlert()` - 定时器取消

### 集成测试
- 授权消息 → 5分钟未操作 → 收到电话
- 授权消息 → 2分钟点击允许 → 未收到电话
- 任务完成 → 10分钟未回复 → 收到电话
- 任务完成 → 5分钟回复消息 → 未收到电话

### 冒烟测试
- 非工作时间发送消息 → 不安排提醒
- 工作时间发送消息 → 安排提醒
- 服务重启 → 待处理提醒丢失（P1解决）

---

## 与原设计的对比

| 维度 | 原设计（高风险命令） | 新设计（超时提醒） |
|------|---------------------|-------------------|
| 触发条件 | 命令匹配正则 | 时间延迟 |
| 触发时机 | 命令执行前 | 消息发出N分钟后 |
| 取消机制 | 无 | 用户操作后取消 |
| 工作时间 | 无限制 | 仅工作时间 |
| 复杂度 | 低 | 中 |

**结论**：新设计更符合实际需求，避免频繁打扰，仅在真正需要时提醒。
