import { feishuClient } from '../feishu/client.js';
import { log } from '../utils/log.js';

interface VoiceAlertConfig {
  userId: string;
  command: string;
  projectPath: string;
  sessionId: string;
}

/**
 * 发送飞书紧急消息（加急提醒，会触发电话/短信通知）
 *
 * 飞书加急消息特性：
 * - 接收者会收到电话铃声、弹窗、短信等强提醒
 * - 需要企业版权限
 * - 使用 msg_type: 'text' + urgent 参数
 *
 * API文档：https://open.feishu.cn/document/server-docs/im-v1/message/create
 */
export async function sendVoiceAlert(config: VoiceAlertConfig): Promise<void> {
  const { userId, command, projectPath, sessionId } = config;

  if (!userId) {
    log('warn', 'voice_alert_no_userid', { command });
    return;
  }

  try {
    const alertMessage = `【Claude Code 高风险操作警告】\n\n检测到危险命令：${command}\n项目：${projectPath}\n会话：${sessionId.substring(0, 8)}\n\n⚠️ 请立即打开飞书查看授权卡片进行确认`;

    log('info', 'voice_alert_sending', {
      userId,
      command,
      projectPath,
      sessionId,
    });

    // 使用飞书SDK发送加急文本消息
    // urgent: true 会触发电话铃声+弹窗+短信（需企业版权限）
    const response = await feishuClient.im.message.create({
      params: {
        receive_id_type: 'open_id',
      },
      data: {
        receive_id: userId,
        msg_type: 'text',
        content: JSON.stringify({ text: alertMessage }),
        // 关键参数：urgent = true 触发加急提醒（电话铃声）
        // @ts-ignore - SDK类型定义可能未包含此参数
        urgent: {
          is_urgent: true,
          urgent_reason: '高风险命令需要立即确认',
        },
      },
    });

    if (response.code === 0) {
      log('info', 'voice_alert_sent_success', {
        userId,
        command,
        messageId: response.data?.message_id,
      });
    } else {
      log('error', 'voice_alert_api_error', {
        code: response.code,
        msg: response.msg,
        userId,
        command,
      });
    }
  } catch (error: any) {
    // 电话通知失败不应阻断授权流程，仅记录日志
    log('error', 'voice_alert_exception', {
      error: String(error),
      errorMessage: error.message,
      userId,
      command,
    });

    // 不抛出异常，避免影响主流程
  }
}

/**
 * 检测是否为高风险命令
 */
export function isHighRiskCommand(command: string): boolean {
  const trimmed = command.trim();

  // 先检查高风险操作符（重定向到设备等）
  if (/>.*\/dev\/sd/.test(trimmed)) {
    return true; // echo "test" > /dev/sda 也是高风险
  }

  // 排除明显的显示/引用场景（但已经检查过重定向）
  if (/^(echo|cat|printf|print)\s/.test(trimmed) && !/>/.test(trimmed)) {
    return false;
  }

  const highRiskPatterns = [
    /\brm\s+-rf\b/,                    // 递归删除
    /\bgit\s+push\s+.*--force/,        // 强制推送
    /\bDROP\s+(TABLE|DATABASE)\b/i,    // SQL删除
    /\bsudo\s+rm\b/,                   // sudo删除
    /\bmkfs\b/,                        // 格式化磁盘
    /\bdd\s+if=.*of=\/dev/,            // dd直接写磁盘
    /\bshutdown\b|\breboot\b/,         // 系统关机重启
  ];

  return highRiskPatterns.some(pattern => pattern.test(command));
}
