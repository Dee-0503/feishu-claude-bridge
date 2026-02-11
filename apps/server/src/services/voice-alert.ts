import { feishuClient } from '../feishu/client.js';
import { log } from '../utils/log.js';

interface PendingAlert {
  messageId: string;
  chatId: string;
  adminUserId: string;
  sessionId: string;
  type: 'authorization' | 'task_complete';
  createdAt: Date;
  timerId: NodeJS.Timeout;
}

interface WorkingHoursConfig {
  enabled: boolean;
  timezone: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
}

interface ScheduleAlertConfig {
  chatId: string;
  adminUserId: string;
  sessionId: string;
  type: 'authorization' | 'task_complete';
  delayMinutes: number;
}

/**
 * 电话加急提醒调度器
 *
 * 功能：
 * - 工作时间内，授权消息/任务完成通知超过N分钟未操作，自动发送电话提醒
 * - 用户操作后自动取消提醒
 * - 仅在工作时间内提醒，避免非工作时间打扰
 */
class AlertScheduler {
  private pendingAlerts: Map<string, PendingAlert> = new Map();

  /**
   * 安排延迟提醒
   */
  scheduleAlert(messageId: string, config: ScheduleAlertConfig): void {
    // 检查是否在工作时间
    if (!isWorkingHours()) {
      log('info', 'voice_alert_skip_non_working_hours', { messageId });
      return;
    }

    // 如果已存在相同messageId的提醒，先取消
    this.cancelAlert(messageId);

    log('info', 'voice_alert_scheduled', {
      messageId,
      type: config.type,
      delayMinutes: config.delayMinutes,
      adminUserId: config.adminUserId,
    });

    // 创建延迟定时器
    const timerId = setTimeout(() => {
      this.sendUrgentAlert(messageId).catch(err =>
        log('error', 'voice_alert_send_failed', { error: String(err), messageId })
      );
    }, config.delayMinutes * 60 * 1000);

    // 存储待处理提醒
    this.pendingAlerts.set(messageId, {
      messageId,
      chatId: config.chatId,
      adminUserId: config.adminUserId,
      sessionId: config.sessionId,
      type: config.type,
      createdAt: new Date(),
      timerId,
    });
  }

  /**
   * 取消提醒（用户已操作）
   */
  cancelAlert(messageId: string): void {
    const alert = this.pendingAlerts.get(messageId);
    if (alert) {
      clearTimeout(alert.timerId);
      this.pendingAlerts.delete(messageId);
      log('info', 'voice_alert_cancelled', {
        messageId,
        type: alert.type,
        waitedMinutes: getWaitMinutes(alert.createdAt),
      });
    }
  }

  /**
   * 发送加急通知
   */
  private async sendUrgentAlert(messageId: string): Promise<void> {
    const alert = this.pendingAlerts.get(messageId);
    if (!alert) return;

    try {
      const waitedMinutes = getWaitMinutes(alert.createdAt);
      const message =
        alert.type === 'authorization'
          ? `⚠️ 【Claude Code 授权请求】\n\n授权请求已等待 ${waitedMinutes} 分钟未处理\n项目群：查看飞书群消息\n会话：${alert.sessionId.substring(0, 8)}\n\n请尽快打开飞书查看授权卡片，点击「允许」或「拒绝」`
          : `📋 【Claude Code 任务完成】\n\n任务已完成 ${waitedMinutes} 分钟未回复\n项目群：查看飞书群消息\n会话：${alert.sessionId.substring(0, 8)}\n\n请查看任务结果并回复反馈`;

      log('info', 'voice_alert_sending', {
        messageId,
        type: alert.type,
        adminUserId: alert.adminUserId,
        waitedMinutes,
      });

      const response = await feishuClient.im.message.create({
        params: {
          receive_id_type: 'open_id',
        },
        data: {
          receive_id: alert.adminUserId,
          msg_type: 'text',
          content: JSON.stringify({ text: message }),
          // 关键参数：urgent = true 触发加急提醒（电话铃声 + 弹窗 + 短信）
          // @ts-ignore - SDK类型定义可能未包含此参数
          urgent: {
            is_urgent: true,
            urgent_reason: `${alert.type === 'authorization' ? '授权请求' : '任务完成通知'}超过${waitedMinutes}分钟未响应`,
          },
        },
      });

      if (response.code === 0) {
        log('info', 'voice_alert_sent_success', {
          messageId,
          type: alert.type,
          adminUserId: alert.adminUserId,
          urgentMessageId: response.data?.message_id,
        });
      } else {
        log('error', 'voice_alert_api_error', {
          code: response.code,
          msg: response.msg,
          messageId,
        });
      }
    } catch (error: any) {
      log('error', 'voice_alert_exception', {
        error: String(error),
        errorMessage: error.message,
        messageId,
      });
    } finally {
      // 无论成功失败，都清理已处理的提醒
      this.pendingAlerts.delete(messageId);
    }
  }

  /**
   * 获取待处理提醒数量（用于监控）
   */
  getPendingCount(): number {
    return this.pendingAlerts.size;
  }

  /**
   * 清理所有待处理提醒（服务关闭时）
   */
  clearAll(): void {
    for (const alert of this.pendingAlerts.values()) {
      clearTimeout(alert.timerId);
    }
    this.pendingAlerts.clear();
    log('info', 'voice_alert_cleared_all', {});
  }
}

/**
 * 全局调度器实例
 */
export const alertScheduler = new AlertScheduler();

/**
 * 判断当前是否为工作时间
 */
export function isWorkingHours(config?: WorkingHoursConfig): boolean {
  const defaultConfig: WorkingHoursConfig = {
    enabled: process.env.VOICE_ALERT_WORKING_HOURS_ENABLED !== 'false',
    timezone: process.env.VOICE_ALERT_TIMEZONE || 'Asia/Shanghai',
    weekdays: parseWeekdays(process.env.VOICE_ALERT_WEEKDAYS || '1,2,3,4,5'),
    startHour: parseInt(process.env.VOICE_ALERT_START_HOUR || '9'),
    endHour: parseInt(process.env.VOICE_ALERT_END_HOUR || '18'),
  };

  const settings = config || defaultConfig;

  // 如果禁用工作时间限制，总是返回true
  if (!settings.enabled) return true;

  const now = new Date();
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: settings.timezone }));

  // 检查星期几（0=周日, 1=周一, ..., 6=周六）
  const dayOfWeek = localTime.getDay();
  if (!settings.weekdays.includes(dayOfWeek)) {
    return false;
  }

  // 检查时间段
  const hour = localTime.getHours();
  return hour >= settings.startHour && hour < settings.endHour;
}

/**
 * 解析工作日配置（1,2,3,4,5 → [1,2,3,4,5]）
 */
function parseWeekdays(str: string): number[] {
  return str.split(',').map(s => parseInt(s.trim())).filter(n => n >= 0 && n <= 6);
}

/**
 * 计算等待时间（分钟）
 */
function getWaitMinutes(createdAt: Date): number {
  const now = new Date();
  const diffMs = now.getTime() - createdAt.getTime();
  return Math.floor(diffMs / 60000);
}
