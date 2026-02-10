/**
 * Hook 脚本 (notify.js) 测试
 * 测试: stdout/stderr 隔离、安全命令白名单、轮询逻辑、超时、服务不可达
 *
 * 使用 child_process.spawn 运行 notify.js, 验证 stdout/stderr 输出
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import express from 'express';
import http from 'http';

const NOTIFY_SCRIPT = path.resolve(__dirname, '../../../../hooks/notify.js');

/** Run notify.js with given args and stdin, capture stdout/stderr */
function runNotify(
  args: string[],
  stdin: string,
  env: Record<string, string> = {},
  timeoutMs = 10000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('node', [NOTIFY_SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH || '',
        HOOK_SECRET: '',
        ...env,
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

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('Hook Script: Safe Command Whitelist', () => {
  it('should exit silently for safe commands (no stdout output)', async () => {
    const safeCommands = [
      'ls -la',
      'cat file.txt',
      'git status',
      'git log --oneline',
      'git diff HEAD',
      'pwd',
      'echo hello',
      'node --version',
      'grep pattern file',
      'find . -name "*.ts"',
      'mkdir -p /tmp/test',
      'touch /tmp/test.txt',
    ];

    for (const cmd of safeCommands) {
      const result = await runNotify(['pre-tool'], JSON.stringify({
        tool: 'Bash',
        tool_input: { command: cmd },
        session_id: 'test',
        options: ['Yes', 'No'],
      }), {
        FEISHU_BRIDGE_URL: 'http://localhost:99999', // unreachable, shouldn't matter
      });

      expect(result.stdout).toBe('');
      expect(result.exitCode).toBe(0);
    }
  });

  it('should NOT skip auth for dangerous commands', async () => {
    const dangerousCommands = [
      'git push origin main',
      'rm -rf /tmp/important',
      'docker push myimage',
      'npm publish',
    ];

    for (const cmd of dangerousCommands) {
      const result = await runNotify(['pre-tool'], JSON.stringify({
        tool: 'Bash',
        tool_input: { command: cmd },
        session_id: 'test',
        options: ['Yes', 'No'],
      }), {
        FEISHU_BRIDGE_URL: 'http://localhost:99999', // will fail, that's fine
      });

      // Should NOT exit silently - it should try to contact the server and fail
      expect(result.stderr).toContain('[notify]');
    }
  });
});

describe('Hook Script: stdout/stderr isolation', () => {
  it('should only output JSON to stdout, logs to stderr', async () => {
    // Start a minimal mock server that returns an immediate decision
    const mockApp = express();
    mockApp.use(express.json());
    mockApp.post('/api/hook/pre-tool', (_req, res) => {
      res.json({ decision: 'allow', reason: '测试放行' });
    });

    const mockServer = await new Promise<http.Server>((resolve) => {
      const s = mockApp.listen(0, () => resolve(s));
    });
    const addr = mockServer.address();
    const port = typeof addr !== 'string' ? addr!.port : 0;

    try {
      const result = await runNotify(['pre-tool'], JSON.stringify({
        tool: 'Bash',
        tool_input: { command: 'git push' },
        session_id: 'test',
        options: ['Yes', 'No'],
      }), {
        FEISHU_BRIDGE_URL: `http://localhost:${port}`,
      });

      // stdout should be valid JSON with hookSpecificOutput
      expect(result.stdout).not.toBe('');
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput).toBeDefined();
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');

      // stderr should have log messages but no JSON output that could confuse Claude
      expect(result.stderr).toContain('[notify]');
      expect(result.stderr).not.toContain('hookSpecificOutput');
    } finally {
      await new Promise<void>((r) => mockServer.close(() => r()));
    }
  });

  it('should output deny on immediate deny decision', async () => {
    const mockApp = express();
    mockApp.use(express.json());
    mockApp.post('/api/hook/pre-tool', (_req, res) => {
      res.json({ decision: 'deny', reason: '规则拒绝' });
    });

    const mockServer = await new Promise<http.Server>((resolve) => {
      const s = mockApp.listen(0, () => resolve(s));
    });
    const addr = mockServer.address();
    const port = typeof addr !== 'string' ? addr!.port : 0;

    try {
      const result = await runNotify(['pre-tool'], JSON.stringify({
        tool: 'Bash',
        tool_input: { command: 'git push' },
        session_id: 'test',
        options: ['Yes', 'No'],
      }), {
        FEISHU_BRIDGE_URL: `http://localhost:${port}`,
      });

      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      await new Promise<void>((r) => mockServer.close(() => r()));
    }
  });
});

describe('Hook Script: Server unreachable', () => {
  it('should exit cleanly without stdout output when server is down', async () => {
    const result = await runNotify(['pre-tool'], JSON.stringify({
      tool: 'Bash',
      tool_input: { command: 'git push' },
      session_id: 'test',
      options: ['Yes', 'No'],
    }), {
      FEISHU_BRIDGE_URL: 'http://localhost:99999',
    });

    // No hookSpecificOutput → Claude Code falls back to manual
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('[notify]');
  });
});

describe('Hook Script: Polling flow', () => {
  it('should poll and receive resolved decision', async () => {
    let requestCount = 0;
    const mockApp = express();
    mockApp.use(express.json());
    mockApp.post('/api/hook/pre-tool', (_req, res) => {
      res.json({ requestId: 'test-req-123' });
    });
    mockApp.get('/api/hook/auth-poll', (_req, res) => {
      requestCount++;
      if (requestCount >= 2) {
        res.json({ status: 'resolved', decision: 'allow', reason: 'Yes' });
      } else {
        res.json({ status: 'pending' });
      }
    });

    const mockServer = await new Promise<http.Server>((resolve) => {
      const s = mockApp.listen(0, () => resolve(s));
    });
    const addr = mockServer.address();
    const port = typeof addr !== 'string' ? addr!.port : 0;

    try {
      const result = await runNotify(['pre-tool'], JSON.stringify({
        tool: 'Bash',
        tool_input: { command: 'git push' },
        session_id: 'test',
        options: ['Yes', 'No'],
      }), {
        FEISHU_BRIDGE_URL: `http://localhost:${port}`,
        AUTH_POLL_INTERVAL_MS: '100', // Fast poll for testing
        AUTH_POLL_TIMEOUT_MS: '5000',
      });

      expect(requestCount).toBeGreaterThanOrEqual(2);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    } finally {
      await new Promise<void>((r) => mockServer.close(() => r()));
    }
  });

  it('should timeout and deny after AUTH_POLL_TIMEOUT_MS', async () => {
    const mockApp = express();
    mockApp.use(express.json());
    mockApp.post('/api/hook/pre-tool', (_req, res) => {
      res.json({ requestId: 'timeout-req' });
    });
    mockApp.get('/api/hook/auth-poll', (_req, res) => {
      res.json({ status: 'pending' }); // always pending
    });

    const mockServer = await new Promise<http.Server>((resolve) => {
      const s = mockApp.listen(0, () => resolve(s));
    });
    const addr = mockServer.address();
    const port = typeof addr !== 'string' ? addr!.port : 0;

    try {
      const result = await runNotify(['pre-tool'], JSON.stringify({
        tool: 'Bash',
        tool_input: { command: 'git push' },
        session_id: 'test',
        options: ['Yes', 'No'],
      }), {
        FEISHU_BRIDGE_URL: `http://localhost:${port}`,
        AUTH_POLL_INTERVAL_MS: '50',
        AUTH_POLL_TIMEOUT_MS: '300', // 300ms timeout
      }, 5000);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('超时');
    } finally {
      await new Promise<void>((r) => mockServer.close(() => r()));
    }
  });

  it('should handle expired status from poll', async () => {
    const mockApp = express();
    mockApp.use(express.json());
    mockApp.post('/api/hook/pre-tool', (_req, res) => {
      res.json({ requestId: 'expired-req' });
    });
    mockApp.get('/api/hook/auth-poll', (_req, res) => {
      res.json({ status: 'expired' });
    });

    const mockServer = await new Promise<http.Server>((resolve) => {
      const s = mockApp.listen(0, () => resolve(s));
    });
    const addr = mockServer.address();
    const port = typeof addr !== 'string' ? addr!.port : 0;

    try {
      const result = await runNotify(['pre-tool'], JSON.stringify({
        tool: 'Bash',
        tool_input: { command: 'git push' },
        session_id: 'test',
        options: ['Yes', 'No'],
      }), {
        FEISHU_BRIDGE_URL: `http://localhost:${port}`,
        AUTH_POLL_INTERVAL_MS: '50',
      });

      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('过期');
    } finally {
      await new Promise<void>((r) => mockServer.close(() => r()));
    }
  });
});

describe('Hook Script: Stop and Notification (fire-and-forget)', () => {
  it('should send stop notification without blocking', async () => {
    const mockApp = express();
    let received = false;
    mockApp.use(express.json());
    mockApp.post('/api/hook/stop', (_req, res) => {
      received = true;
      res.json({ success: true });
    });

    const mockServer = await new Promise<http.Server>((resolve) => {
      const s = mockApp.listen(0, () => resolve(s));
    });
    const addr = mockServer.address();
    const port = typeof addr !== 'string' ? addr!.port : 0;

    try {
      const result = await runNotify(['stop'], JSON.stringify({
        session_id: 'test',
        message: 'task done',
      }), {
        FEISHU_BRIDGE_URL: `http://localhost:${port}`,
      });

      expect(result.stdout).toBe(''); // no hookSpecificOutput for stop
      expect(received).toBe(true);
    } finally {
      await new Promise<void>((r) => mockServer.close(() => r()));
    }
  });
});
