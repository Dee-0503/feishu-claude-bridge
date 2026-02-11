#!/usr/bin/env node

/**
 * Claude Code Hook Script - Phase 3+
 * Sends notifications to Feishu Bridge server.
 *
 * Hook types:
 *   node notify.js stop               — fire-and-forget task completion
 *   node notify.js pre-tool           — safe-command filter only (no blocking)
 *   node notify.js permission-request — blocking auth flow via Feishu (has permission_suggestions)
 *   node notify.js notification       — fire-and-forget generic notification
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const pathModule = require('path');

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
  /^git\s+(status|log|diff|branch|show|remote|tag|stash|rev-parse|config|add|commit|checkout|switch|merge|rebase|reset|cherry-pick|bisect|blame|shortlog|describe|fetch|rm|restore|clean)\b/,
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

/**
 * Find git repository root by walking up from cwd.
 * This prevents npm workspace sub-directories (e.g. apps/server)
 * from being used as the project path.
 */
function findGitRoot(startDir) {
  if (!startDir) return null;
  let dir = startDir;
  while (true) {
    if (fs.existsSync(pathModule.join(dir, '.git'))) {
      return dir;
    }
    const parent = pathModule.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
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

  // Debug: log project dir resolution
  console.error(`[notify] Hook type: ${process.argv[2]}, hookData.cwd: ${hookData.cwd}, process.cwd(): ${process.cwd()}, CLAUDE_PROJECT_DIR: ${process.env.CLAUDE_PROJECT_DIR || '(unset)'}`);

  const hookType = process.argv[2] || process.env.HOOK_TYPE || 'notification';

  // Filter out noise notifications that don't need to be sent to Feishu
  if (hookType === 'notification') {
    const msg = hookData.message || hookData.body || '';
    const FILTERED_PATTERNS = [
      /waiting for your input/i,
      /waiting for input/i,
    ];
    if (FILTERED_PATTERNS.some(p => p.test(msg))) {
      console.error(`[notify] Filtered notification: ${msg.substring(0, 60)}`);
      process.exit(0);
    }
  }

  const payload = {
    ...hookData,
    project_dir: process.env.CLAUDE_PROJECT_DIR || hookData.cwd,
    timestamp: new Date().toISOString(),
  };

  const endpoints = {
    stop: '/api/hook/stop',
    'pre-tool': '/api/hook/pre-tool',
    'permission-request': '/api/hook/pre-tool', // 复用同一个服务器端点
    notification: '/api/hook/authorization',
  };

  const endpoint = endpoints[hookType] || endpoints.notification;

  // Pre-tool: safe command filter only
  if (hookType === 'pre-tool') {
    handlePreTool(payload);
    return;
  }

  // Permission-request: blocking authorization flow via Feishu
  if (hookType === 'permission-request') {
    await handlePermissionRequest(payload);
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
 * PreToolUse handler:
 * Only filters safe commands (auto-allow). For non-safe commands,
 * exits without output → Claude Code proceeds to PermissionRequest.
 */
function handlePreTool(payload) {
  const tool = payload.tool_name || payload.tool;
  const command = tool === 'Bash' ? payload.tool_input?.command : null;

  if (command && isSafeCommand(command)) {
    console.error(`[notify] Safe command, auto-allowing: ${command.substring(0, 60)}`);
    // Output allow decision to skip permission prompt entirely
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: '安全命令白名单',
      },
    };
    process.stdout.write(JSON.stringify(output));
    return;
  }

  // Non-safe command: no output → Claude Code continues to PermissionRequest hook
  console.error(`[notify] Non-safe command, deferring to PermissionRequest: ${(command || tool || '').substring(0, 60)}`);
}

/**
 * PermissionRequest handler:
 * Fires when Claude Code is about to show a permission prompt to the user.
 * Receives permission_suggestions with the actual options.
 *
 * 1. Extract permission_suggestions → build options for Feishu card buttons
 * 2. POST to server to create auth request with real options
 * 3. Poll for Feishu card button click
 * 4. Output PermissionRequest decision format to stdout
 */
async function handlePermissionRequest(payload) {
  // Log the full permission_suggestions for debugging
  console.error(`[notify] PermissionRequest debug:`, JSON.stringify({
    permission_suggestions: payload.permission_suggestions,
    tool_name: payload.tool_name || payload.tool,
    hook_event_name: payload.hook_event_name,
  }));

  const tool = payload.tool_name || payload.tool;
  const command = tool === 'Bash' ? payload.tool_input?.command : null;

  // Build options from permission_suggestions
  // permission_suggestions is an array like:
  //   [{ type: "toolAlwaysAllow", tool: "Bash" }]
  // We convert to human-readable options for the Feishu card
  const options = buildOptionsFromSuggestions(payload.permission_suggestions);

  // Add options to payload for the server
  payload.options = options;

  try {
    // Create auth request on server (reuse /api/hook/pre-tool endpoint)
    const responseStr = await sendRequest(BRIDGE_URL + '/api/hook/pre-tool', payload);
    const response = JSON.parse(responseStr);

    // Server returned immediate decision (matched permission rule)
    if (response.decision) {
      console.error(`[notify] Immediate decision: ${response.decision} (${response.reason})`);
      outputPermissionDecision(response.decision === 'allow', null, payload.permission_suggestions);
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
    outputPermissionDecision(decision.allow, decision.reason, payload.permission_suggestions, decision.optionText);
  } catch (error) {
    console.error(`[notify] PermissionRequest error: ${error.message}`);
    // No output → Claude Code falls back to manual terminal prompt
    process.exit(0);
  }
}

/**
 * Convert permission_suggestions to human-readable option strings for Feishu card.
 * Always includes 'Yes' and 'No', plus any "always allow" variants from suggestions.
 */
function buildOptionsFromSuggestions(suggestions) {
  const options = ['Yes'];

  if (Array.isArray(suggestions) && suggestions.length > 0) {
    for (const s of suggestions) {
      switch (s.type) {
        case 'toolAlwaysAllow':
          options.push("Yes, don't ask again");
          break;
        case 'pathAlwaysAllow':
          options.push("Yes, don't ask again for this project");
          break;
        default:
          // Unknown suggestion type → generic "always" option
          options.push('Yes, always');
          break;
      }
    }
  }

  options.push('No');
  return options;
}

/**
 * Output the PermissionRequest decision to stdout.
 * Format differs from PreToolUse: uses decision.behavior + updatedPermissions.
 */
function outputPermissionDecision(allow, reason, suggestions, optionText) {
  const decision = {
    behavior: allow ? 'allow' : 'deny',
  };

  if (allow && optionText) {
    const lowerOpt = optionText.toLowerCase();
    const isAlways = lowerOpt.includes('always') || lowerOpt.includes("don't ask again");

    // If user chose "always allow", apply the permission_suggestions as updatedPermissions
    if (isAlways && Array.isArray(suggestions) && suggestions.length > 0) {
      decision.updatedPermissions = suggestions;
    }
  }

  if (!allow && reason) {
    decision.message = reason;
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision,
    },
  };
  process.stdout.write(JSON.stringify(output));
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
          optionText: response.reason || '',
        };
      }

      if (response.status === 'expired') {
        return {
          allow: false,
          reason: '授权请求已过期',
          optionText: '',
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
    optionText: '',
  };
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
