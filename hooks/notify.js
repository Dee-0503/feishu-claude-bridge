#!/usr/bin/env node

/**
 * Claude Code Hook Script - Phase 3
 * Sends notifications to Feishu Bridge server.
 * For PreToolUse hooks: blocks and polls for remote authorization decision.
 *
 * Usage: This script is called by Claude Code hooks with stdin input
 *   node notify.js stop          — fire-and-forget task completion
 *   node notify.js pre-tool      — blocking auth flow via Feishu
 *   node notify.js notification  — fire-and-forget generic notification
 */

const http = require('http');
const https = require('https');

// Configuration
const BRIDGE_URL = process.env.FEISHU_BRIDGE_URL || 'http://localhost:3000';
const HOOK_SECRET = process.env.HOOK_SECRET || '';
const POLL_INTERVAL_MS = parseInt(process.env.AUTH_POLL_INTERVAL_MS || '2000', 10);
const POLL_TIMEOUT_MS = parseInt(process.env.AUTH_POLL_TIMEOUT_MS || '120000', 10);

// Safe commands that don't need remote authorization
const SAFE_COMMANDS = [
  // Read-only filesystem
  /^(ls|cat|head|tail|echo|pwd|which|whoami|date|env|printenv|uname|hostname)\b/,
  /^(wc|sort|uniq|tr|cut|tee|xargs|basename|dirname|realpath|readlink)\b/,
  /^(file|stat|du|df|uptime|free|top -l|ps)\b/,
  /^(grep|rg|find|fd|ag|ack)\b/,
  /^test\b/,
  /^\[/,
  // Safe file operations
  /^(mkdir|touch|cp|mv|chmod|chown|ln)\b/,
  // Safe git (read-only + local-only)
  /^git\s+(status|log|diff|branch|show|remote|tag|stash|rev-parse|config|add|commit|checkout|switch|merge|rebase|reset|cherry-pick|bisect|blame|shortlog|describe|fetch)\b/,
  // Dev tools (run, build, test, install — not publish/push)
  /^(node|python|python3|ruby|java|go|rustc|cargo)\b/,
  /^(npm|pnpm|yarn|bun|deno)\s+(install|ci|run|exec|test|build|start|dev|init|create|info|list|ls|outdated|audit|why|pack|link|unlink|--version)\b/,
  /^npx\b/,
  /^(pip|pip3)\s+(install|list|show|freeze|check)\b/,
  // Network (read-only)
  /^(curl|wget|http|fetch)\b/,
  // Common dev utilities
  /^(sed|awk|perl|jq|yq|column|less|more|vim|vi|nano|code|open)\b/,
  /^(tar|zip|unzip|gzip|gunzip|bzip2|xz)\b/,
  /^(diff|patch|md5|shasum|sha256sum|base64|xxd)\b/,
  /^(make|cmake|gcc|g\+\+|clang|ld)\b/,
  /^(tmux|screen|nohup|time|timeout|watch|wait|sleep)\b/,
  // TypeScript / build
  /^(tsc|tsx|ts-node|esbuild|vite|webpack|rollup|vitest|jest|mocha|pytest)\b/,
  // Docker (read-only)
  /^docker\s+(ps|images|logs|inspect|exec|build|run|compose|version|info)\b/,
];

function isSafeCommand(command) {
  if (!command) return false;
  const trimmed = command.trim();
  return SAFE_COMMANDS.some(pattern => pattern.test(trimmed));
}

async function main() {
  // Read stdin
  let inputData = '';
  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(inputData);
  } catch (e) {
    hookData = { message: inputData };
  }

  const hookType = process.argv[2] || process.env.HOOK_TYPE || 'notification';

  const payload = {
    ...hookData,
    project_dir: process.env.CLAUDE_PROJECT_DIR || hookData.cwd,
    timestamp: new Date().toISOString(),
  };

  const endpoints = {
    stop: '/api/hook/stop',
    'pre-tool': '/api/hook/pre-tool',
    notification: '/api/hook/notification',
  };

  const endpoint = endpoints[hookType] || endpoints.notification;

  // Pre-tool: blocking authorization flow
  if (hookType === 'pre-tool') {
    await handlePreTool(payload);
    return;
  }

  // Other hooks: fire-and-forget
  try {
    await sendRequest(BRIDGE_URL + endpoint, payload);
    console.error(`[notify] Notification sent: ${hookType}`);
  } catch (error) {
    console.error(`[notify] Failed to send notification: ${error.message}`);
    // Don't exit with error to avoid blocking Claude Code
  }
}

/**
 * Pre-tool authorization flow:
 * 1. Check if command is safe (skip auth)
 * 2. POST to /api/hook/pre-tool to create auth request
 * 3. If server returns immediate decision (rule match), output it
 * 4. Otherwise poll /api/hook/auth-poll until resolved or timeout
 * 5. Output hookSpecificOutput JSON to stdout
 */
async function handlePreTool(payload) {
  // Check safe command whitelist
  const tool = payload.tool_name || payload.tool;
  const command = tool === 'Bash' ? payload.tool_input?.command : null;
  if (command && isSafeCommand(command)) {
    console.error(`[notify] Safe command, skipping auth: ${command.substring(0, 60)}`);
    // No stdout output → Claude Code processes normally
    process.exit(0);
  }

  try {
    // Create auth request on server
    const responseStr = await sendRequest(BRIDGE_URL + '/api/hook/pre-tool', payload);
    const response = JSON.parse(responseStr);

    // Server returned immediate decision (matched permission rule)
    if (response.decision) {
      console.error(`[notify] Immediate decision: ${response.decision} (${response.reason})`);
      outputDecision(response.decision === 'allow', response.reason);
      return;
    }

    const { requestId } = response;
    if (!requestId) {
      console.error('[notify] No requestId returned, falling back to manual');
      process.exit(0);
    }

    console.error(`[notify] Auth request created: ${requestId}, waiting for Feishu response...`);

    // Poll for decision
    const decision = await pollForDecision(requestId, POLL_TIMEOUT_MS);
    outputDecision(decision.allow, decision.reason);
  } catch (error) {
    console.error(`[notify] Pre-tool error: ${error.message}`);
    // Don't output hookSpecificOutput → Claude Code falls back to manual confirmation
    process.exit(0);
  }
}

/**
 * Poll the auth-poll endpoint until decision or timeout
 */
async function pollForDecision(requestId, timeoutMs) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const responseStr = await getRequest(
        `${BRIDGE_URL}/api/hook/auth-poll?requestId=${encodeURIComponent(requestId)}`
      );
      const response = JSON.parse(responseStr);

      if (response.status === 'resolved') {
        return {
          allow: response.decision === 'allow',
          reason: response.reason || '飞书远程授权',
        };
      }

      if (response.status === 'expired') {
        return {
          allow: false,
          reason: '授权请求已过期',
        };
      }

      // Still pending, wait and retry
      await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      console.error(`[notify] Poll error: ${error.message}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  // Timeout
  console.error(`[notify] Auth poll timeout after ${timeoutMs}ms`);
  return {
    allow: false,
    reason: '授权超时',
  };
}

/**
 * Output the permission decision to stdout for Claude Code to read
 */
function outputDecision(allow, reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: allow ? 'allow' : 'deny',
      permissionDecisionReason: reason || '飞书远程授权',
    },
  };
  process.stdout.write(JSON.stringify(output));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendRequest(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;

    const postData = JSON.stringify(data);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-Hook-Secret': HOOK_SECRET,
      },
      timeout: 10000,
    };

    const req = client.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

function getRequest(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'X-Hook-Secret': HOOK_SECRET,
      },
      timeout: 10000,
    };

    const req = client.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

main().catch((error) => {
  console.error(`[notify] Fatal error: ${error.message}`);
  // Don't output hookSpecificOutput on fatal error → Claude Code falls back to manual
  process.exit(0);
});
