/**
 * E2E 测试
 *
 * 真实链路: notify.js (hook脚本) → Express 服务器 → 飞书 webhook 回调 → poll 返回决策
 *
 * 唯一 mock: 飞书 SDK client（不真正发送消息）
 * 所有其他组件（路由、authStore、permissionRules、hook脚本）都是真实的。
 *
 * 验证:
 *  - 完整授权流程（allow / deny）
 *  - 动态标题包含项目/会话信息
 *  - "始终允许" 规则写入后自动放行
 *  - stop / notification 端点的动态标题
 *  - hook 脚本的 stdout/stderr 隔离
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTIFY_SCRIPT = path.resolve(__dirname, '../../../../hooks/notify.js');
const RULES_FILE = path.join(__dirname, '../../data/permission-rules.json');

// ---------- Mocks ----------

// Capture all Feishu card creates and patches
const feishuCreateMock = vi.fn().mockResolvedValue({
  code: 0,
  msg: 'success',
  data: { message_id: 'e2e-msg-id' },
});
const feishuPatchMock = vi.fn().mockResolvedValue({ code: 0, msg: 'success' });

vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    im: {
      message: {
        create: (...args: any[]) => feishuCreateMock(...args),
        patch: (...args: any[]) => feishuPatchMock(...args),
      },
      chat: {
        create: vi.fn().mockResolvedValue({ data: { chat_id: 'e2e-chat-id' } }),
      },
    },
  },
}));

vi.mock('../feishu/group.js', () => ({
  getOrCreateProjectGroup: vi.fn().mockResolvedValue('e2e-chat-id'),
  getNormalizedProjectPath: vi.fn((p: string) => p),
  markChatInvalid: vi.fn(),
}));

vi.mock('../services/command-explain.js', () => ({
  generateCommandExplanation: vi.fn().mockResolvedValue(null),
  buildExplainPrompt: vi.fn(),
}));

// ---------- Helpers ----------

let app: express.Express;
let server: http.Server;
let baseUrl: string;
let serverPort: number;

beforeEach(async () => {
  vi.resetModules();
  feishuCreateMock.mockClear();
  feishuPatchMock.mockClear();

  vi.stubEnv('AUTH_TTL_MS', '60000');
  delete process.env.HOOK_SECRET;
  delete process.env.FEISHU_VERIFICATION_TOKEN;

  try { if (fs.existsSync(RULES_FILE)) fs.unlinkSync(RULES_FILE); } catch { /* ignore */ }

  const { hookRouter } = await import('../routes/hook.js');
  const { feishuRouter } = await import('../routes/feishu.js');

  app = express();
  app.use(express.json());
  app.use('/api/hook', hookRouter);
  app.use('/api/feishu', feishuRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') {
        serverPort = addr.port;
        baseUrl = `http://localhost:${serverPort}`;
      }
      resolve();
    });
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try { if (fs.existsSync(RULES_FILE)) fs.unlinkSync(RULES_FILE); } catch { /* ignore */ }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

/** Run notify.js hook script against the real server */
function runNotify(
  hookType: string,
  stdinData: object,
  extraEnv: Record<string, string> = {},
  timeoutMs = 15000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('node', [NOTIFY_SCRIPT, hookType], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH || '',
        HOOK_SECRET: '',
        FEISHU_BRIDGE_URL: baseUrl,
        AUTH_POLL_INTERVAL_MS: '100',
        AUTH_POLL_TIMEOUT_MS: '10000',
        ...extraEnv,
      },
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on('error', () => {
      resolve({ stdout, stderr, exitCode: 1 });
    });

    child.stdin.write(JSON.stringify(stdinData));
    child.stdin.end();
  });
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  return { status: res.status, body: await res.json() as any };
}

/** Simulate Feishu card button click via webhook */
function clickButton(requestId: string, action: string, sessionId = 'e2e-session-abc1234') {
  return fetchJson(`${baseUrl}/api/feishu/webhook`, {
    method: 'POST',
    body: JSON.stringify({
      header: { event_type: 'card.action.trigger' },
      event: {
        action: {
          value: JSON.stringify({ requestId, action, sessionId }),
        },
      },
    }),
  });
}

/** Extract card title from feishu create mock call */
function getCardTitle(callIndex = 0): string {
  const call = feishuCreateMock.mock.calls[callIndex];
  if (!call) return '';
  const content = JSON.parse(call[0].data.content);
  return content.header?.title?.content || '';
}

/** Extract card title from feishu patch mock call */
function getPatchCardTitle(callIndex = 0): string {
  const call = feishuPatchMock.mock.calls[callIndex];
  if (!call) return '';
  const content = JSON.parse(call[0].data.content);
  return content.header?.title?.content || '';
}

// ---------- Tests ----------

describe('E2E: Hook Script → Server → Feishu Card → Poll', () => {
  it('完整授权流程: hook脚本发起 → 服务器创建卡片 → 飞书按钮点击 → hook脚本收到 allow', async () => {
    const sessionId = 'e2e-session-abc1234';
    const cwd = '/home/user/my-project-worktrees/phase3';

    // Start hook script (will poll in background)
    const hookPromise = runNotify('pre-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      session_id: sessionId,
      options: ['Yes', 'Yes, always', 'No'],
      cwd,
    });

    // Wait for the server to receive the request and create the auth entry
    await new Promise((r) => setTimeout(r, 500));

    // Find the requestId from the auth-poll (the hook script should be polling by now)
    // We get the requestId from the Feishu card create call's button value
    expect(feishuCreateMock).toHaveBeenCalled();

    // Verify dynamic title includes [phase3] and session short code
    const title = getCardTitle();
    expect(title).toContain('[phase3]');
    expect(title).toContain('#e2e-');
    expect(title).toContain('需要授权');

    // Extract requestId from the card button value
    const cardContent = JSON.parse(feishuCreateMock.mock.calls[0][0].data.content);
    const actionElement = cardContent.elements.find((el: any) => el.tag === 'action');
    const buttonValue = JSON.parse(actionElement.actions[0].value);
    const requestId = buttonValue.requestId;
    expect(requestId).toBeDefined();

    // Simulate user clicking "Yes" on the Feishu card
    await clickButton(requestId, 'Yes', sessionId);

    // Wait for hook script to receive the decision via polling
    const result = await hookPromise;

    // Hook script should output allow decision on stdout
    expect(result.stdout).not.toBe('');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');

    // stderr should have logs but no JSON
    expect(result.stderr).toContain('[notify]');
    expect(result.stderr).not.toContain('hookSpecificOutput');

    // Verify resolved card was updated with dynamic title
    expect(feishuPatchMock).toHaveBeenCalled();
    const patchTitle = getPatchCardTitle();
    expect(patchTitle).toContain('[phase3]');
    expect(patchTitle).toContain('#e2e-');
    expect(patchTitle).toContain('已授权');
  });

  it('拒绝流程: hook脚本收到 deny', async () => {
    const sessionId = 'deny-session-xyz9999';
    const cwd = '/workspace/my-app';

    const hookPromise = runNotify('pre-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /important' },
      session_id: sessionId,
      options: ['Yes', 'No'],
      cwd,
    });

    await new Promise((r) => setTimeout(r, 500));

    // Extract requestId
    const cardContent = JSON.parse(feishuCreateMock.mock.calls[0][0].data.content);
    const actionElement = cardContent.elements.find((el: any) => el.tag === 'action');
    const buttonValue = JSON.parse(actionElement.actions[0].value);
    const requestId = buttonValue.requestId;

    // Click "No" (deny)
    await clickButton(requestId, 'No', sessionId);

    const result = await hookPromise;

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');

    // Verify rejected card title
    const patchTitle = getPatchCardTitle();
    expect(patchTitle).toContain('[my-app]');
    expect(patchTitle).toContain('已拒绝');
  });

  it('"始终允许" 规则写入后，第二次请求自动放行', async () => {
    const sessionId = 'always-session-1234567';
    const cwd = '/projects/backend';

    // First request: user clicks "Yes, always"
    const hook1 = runNotify('pre-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'docker push myimage' },
      session_id: sessionId,
      options: ['Yes', 'Yes, always', 'No'],
      cwd,
    });

    await new Promise((r) => setTimeout(r, 500));

    const cardContent = JSON.parse(feishuCreateMock.mock.calls[0][0].data.content);
    const actionElement = cardContent.elements.find((el: any) => el.tag === 'action');
    const buttonValue = JSON.parse(actionElement.actions[0].value);
    const requestId = buttonValue.requestId;

    await clickButton(requestId, 'Yes, always', sessionId);

    const result1 = await hook1;
    const parsed1 = JSON.parse(result1.stdout);
    expect(parsed1.hookSpecificOutput.permissionDecision).toBe('allow');

    // Second request: same command pattern should be auto-allowed (no polling needed)
    const result2 = await runNotify('pre-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'docker push another-image' },
      session_id: 'second-session-7654321',
      options: ['Yes', 'No'],
      cwd,
    });

    // Should get immediate allow (no card created for second request)
    const parsed2 = JSON.parse(result2.stdout);
    expect(parsed2.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed2.hookSpecificOutput.permissionDecisionReason).toContain('规则');
  });
});

describe('E2E: Stop 端点动态标题', () => {
  it('stop hook 发送的卡片应包含项目/会话信息', async () => {
    const result = await runNotify('stop', {
      session_id: 'stop-session-abcdefg',
      cwd: '/home/user/worktrees/feature-auth',
      message: '所有文件已修改完成',
    });

    // fire-and-forget, no stdout
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);

    // Wait for server to process
    await new Promise((r) => setTimeout(r, 300));

    // Verify card was sent with dynamic title
    expect(feishuCreateMock).toHaveBeenCalled();
    const title = getCardTitle();
    expect(title).toContain('[feature-auth]');
    expect(title).toContain('#stop');
    expect(title).toContain('任务完成');
  });
});

describe('E2E: Notification 端点动态标题', () => {
  it('notification hook 发送的卡片应包含项目/会话信息', async () => {
    const result = await runNotify('notification', {
      session_id: 'notify-session-1234567',
      cwd: '/Users/dev/project-worktrees/phase3',
      message: '编译完成，共修改 5 个文件',
    });

    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);

    await new Promise((r) => setTimeout(r, 300));

    expect(feishuCreateMock).toHaveBeenCalled();
    const title = getCardTitle();
    expect(title).toContain('[phase3]');
    expect(title).toContain('#noti');
    expect(title).toContain('通知');
  });
});

describe('E2E: 非 Bash 工具授权', () => {
  it('Edit 工具授权流程应正常工作', async () => {
    const sessionId = 'edit-session-abcdef0';
    const cwd = '/workspace/frontend';

    const hookPromise = runNotify('pre-tool', {
      tool_name: 'Edit',
      tool_input: { file_path: '/etc/hosts', old_string: 'localhost', new_string: '0.0.0.0' },
      session_id: sessionId,
      options: ['Yes', 'No'],
      cwd,
    });

    await new Promise((r) => setTimeout(r, 500));

    expect(feishuCreateMock).toHaveBeenCalled();
    const title = getCardTitle();
    expect(title).toContain('[frontend]');
    expect(title).toContain('需要授权');

    // Extract requestId and approve
    const cardContent = JSON.parse(feishuCreateMock.mock.calls[0][0].data.content);
    const actionElement = cardContent.elements.find((el: any) => el.tag === 'action');
    const buttonValue = JSON.parse(actionElement.actions[0].value);

    await clickButton(buttonValue.requestId, 'Yes', sessionId);

    const result = await hookPromise;
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('E2E: 安全命令白名单（不经过服务器）', () => {
  it('安全命令应直接通过，不创建飞书卡片', async () => {
    const result = await runNotify('pre-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      session_id: 'safe-session',
      options: ['Yes', 'No'],
      cwd: '/workspace/project',
    });

    // Should exit silently
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);

    // No Feishu card should have been created
    expect(feishuCreateMock).not.toHaveBeenCalled();
  });
});
