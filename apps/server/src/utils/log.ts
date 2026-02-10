/**
 * 结构化日志工具
 */

type LogLevel = 'info' | 'warn' | 'error';

export function log(level: LogLevel, event: string, data?: object): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  }));
}
