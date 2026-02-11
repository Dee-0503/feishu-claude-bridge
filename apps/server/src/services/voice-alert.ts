import { log } from '../utils/log.js';

// 飞书语音通知 API（文档参考：https://open.feishu.cn/document/server-docs/im-v1/message/create）
// 注意：真实的飞书语音通知需要企业版权限，这里提供接口框架

interface VoiceAlertConfig {
  userId: string;
  command: string;
  projectPath: string;
  sessionId: string;
}

/**
 * 发送飞书语音提醒（电话通知）
 * 对于高风险命令，触发电话播报引导用户查看飞书卡片
 */
export async function sendVoiceAlert(config: VoiceAlertConfig): Promise<void> {
  const { userId, command, projectPath, sessionId } = config;

  try {
    // 飞书语音通知需要企业版权限
    // 这里提供接口框架，实际部署时需要配置对应权限

    const alertMessage = `Claude Code检测到高风险操作：${command}。请立即查看飞书消息进行授权确认。`;

    log('info', 'voice_alert_triggered', {
      userId,
      command,
      projectPath,
      sessionId,
    });

    // TODO: 实际调用飞书语音通知API
    // await feishuClient.request({
    //   method: 'POST',
    //   url: '/open-apis/message/v4/send/',
    //   data: {
    //     open_id: userId,
    //     msg_type: 'voice',
    //     content: {
    //       text: alertMessage
    //     }
    //   }
    // });

    log('info', 'voice_alert_sent', { userId, command });
  } catch (error) {
    // 电话失败不应阻断授权流程，仅记录日志
    log('error', 'voice_alert_failed', {
      error: String(error),
      userId,
      command,
    });
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
