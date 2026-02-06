#!/usr/bin/env node

/**
 * Claude Code Hook Script
 * Sends notifications to Feishu Bridge server
 *
 * Usage: This script is called by Claude Code hooks with stdin input
 */

const http = require('http');
const https = require('https');

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

  // Build request payload
  const payload = {
    ...hookData,
    timestamp: new Date().toISOString(),
  };

  // Determine endpoint
  const endpoints = {
    stop: '/api/hook/stop',
    'pre-tool': '/api/hook/pre-tool',
    notification: '/api/hook/authorization',  // 授权请求专用端点
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
      timeout: 5000,
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
