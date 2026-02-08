#!/usr/bin/env node

/**
 * Claude Code Hook Script
 * Sends notifications to Feishu Bridge server
 *
 * Usage: This script is called by Claude Code hooks with stdin input
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration from environment or defaults
const BRIDGE_URL = process.env.FEISHU_BRIDGE_URL || 'http://localhost:3000';
const HOOK_SECRET = process.env.HOOK_SECRET || '';

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

  // Determine hook type from command line args or environment
  const hookType = process.argv[2] || process.env.HOOK_TYPE || 'notification';

  // If stop hook and has transcript_path, extract summary
  if (hookType === 'stop' && hookData.transcript_path) {
    try {
      const summary = extractSummary(hookData.transcript_path, hookData);
      hookData.summary = summary;
      console.error(`📊 Extracted summary: ${summary.taskDescription.substring(0, 50)}...`);
    } catch (error) {
      console.error(`⚠️ Failed to extract summary: ${error.message}`);
    }
  }

  // Build request payload
  const payload = {
    ...hookData,
    timestamp: new Date().toISOString(),
  };

  // Determine endpoint
  const endpoints = {
    stop: '/api/hook/stop',
    'pre-tool': '/api/hook/pre-tool',
    notification: '/api/hook/authorization',
  };

  const endpoint = endpoints[hookType] || endpoints.notification;

  try {
    await sendRequest(BRIDGE_URL + endpoint, payload);
    console.error(`✅ Notification sent: ${hookType}`);
  } catch (error) {
    console.error(`❌ Failed to send notification: ${error.message}`);
    // Don't exit with error to avoid blocking Claude Code
  }
}

/**
 * Extract summary from transcript file
 * Uses head/tail for optimization on large files
 */
function extractSummary(transcriptPath, hookData) {
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  const cwd = hookData.cwd || process.cwd();

  // Get project info
  const projectPath = cwd;
  const projectName = extractProjectName(projectPath);
  const gitBranch = getGitBranch(cwd);
  const sessionId = hookData.session_id || 'unknown';
  const sessionShortId = sessionId.substring(0, 4);

  // Read file - optimize for large files by reading head and tail
  let lines;
  const stats = fs.statSync(transcriptPath);

  if (stats.size > 500 * 1024) {
    // Large file: use head and tail
    console.error(`📦 Large transcript (${(stats.size / 1024).toFixed(0)}KB), using head/tail`);
    const head = safeExec(`head -20 "${transcriptPath}"`);
    const tail = safeExec(`tail -100 "${transcriptPath}"`);
    lines = (head + '\n' + tail).split('\n').filter(Boolean);
  } else {
    // Small file: read entirely
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    lines = content.split('\n').filter(Boolean);
  }

  // Parse JSONL lines
  const parsed = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  // Extract first user message (task description)
  const firstUser = parsed.find(l => l.type === 'user');
  const taskDescription = extractTextContent(firstUser?.message?.content) || '';

  // Extract last assistant text (completion message)
  const assistantMessages = parsed.filter(l =>
    l.type === 'assistant' &&
    hasTextContent(l.message?.content)
  );
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const completionMessage = extractTextContent(lastAssistant?.message?.content) || '';

  // Count tool usage
  const toolStats = { bash: 0, edit: 0, write: 0, read: 0, glob: 0, grep: 0, task: 0 };
  const filesModified = new Set();
  const filesCreated = new Set();

  parsed.filter(l => l.type === 'assistant').forEach(line => {
    const content = line.message?.content;
    if (!Array.isArray(content)) return;

    content.forEach(c => {
      if (c.type === 'tool_use') {
        const name = (c.name || '').toLowerCase();
        if (toolStats.hasOwnProperty(name)) {
          toolStats[name]++;
        }

        // Extract file paths
        if (c.name === 'Edit' && c.input?.file_path) {
          filesModified.add(c.input.file_path);
        }
        if (c.name === 'Write' && c.input?.file_path) {
          filesCreated.add(c.input.file_path);
        }
      }
    });
  });

  // Calculate duration
  const firstTimestamp = parsed[0]?.timestamp;
  const lastTimestamp = parsed[parsed.length - 1]?.timestamp;
  let duration = 0;
  if (firstTimestamp && lastTimestamp) {
    duration = Math.round((new Date(lastTimestamp) - new Date(firstTimestamp)) / 1000);
  }

  return {
    projectPath,
    projectName,
    gitBranch,
    sessionId,
    sessionShortId,
    taskDescription: taskDescription.substring(0, 500),
    completionMessage: completionMessage.substring(0, 1000),
    toolStats,
    filesModified: Array.from(filesModified).slice(0, 20),
    filesCreated: Array.from(filesCreated).slice(0, 20),
    duration,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Extract project name from path (handles worktrees)
 */
function extractProjectName(projectPath) {
  // Handle worktree paths
  if (projectPath.includes('-worktrees/')) {
    const match = projectPath.match(/\/([^/]+)-worktrees\//);
    if (match) {
      return match[1];
    }
  }
  return path.basename(projectPath);
}

/**
 * Get current git branch
 */
function getGitBranch(cwd) {
  try {
    const branch = safeExec(`git -C "${cwd}" branch --show-current`);
    return branch.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Extract text content from message content array
 */
function extractTextContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textItem = content.find(c => c.type === 'text');
    return textItem?.text || '';
  }
  return '';
}

/**
 * Check if content has text
 */
function hasTextContent(content) {
  if (!content) return false;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    return content.some(c => c.type === 'text' && c.text);
  }
  return false;
}

/**
 * Safe exec that returns empty string on error
 */
function safeExec(command) {
  try {
    return execSync(command, { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return '';
  }
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
      timeout: 10000, // Increased timeout for summary processing
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

main().catch(console.error);
