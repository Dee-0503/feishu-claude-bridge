/**
 * 授权请求状态管理
 * 内存存储，服务重启后 pending 请求丢失（hook 脚本轮询超时后自动 deny）
 */

import { randomUUID } from 'crypto';
import type { AuthRequest } from '../types/auth.js';
import { log } from '../utils/log.js';

const AUTH_TTL_MS = parseInt(process.env.AUTH_TTL_MS || '300000', 10); // 5 minutes

class AuthStore {
  private requests = new Map<string, AuthRequest>();

  create(data: Omit<AuthRequest, 'requestId' | 'status' | 'createdAt'>): AuthRequest {
    const requestId = randomUUID();
    const request: AuthRequest = {
      ...data,
      requestId,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.requests.set(requestId, request);
    log('info', 'auth_request_created', {
      requestId,
      tool: data.tool,
      sessionId: data.sessionId,
      command: data.command,
    });
    return request;
  }

  get(requestId: string): AuthRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request) return undefined;

    // Check expiration
    if (request.status === 'pending' && Date.now() - request.createdAt > AUTH_TTL_MS) {
      request.status = 'expired';
      log('warn', 'auth_request_expired', { requestId, tool: request.tool });
    }

    return request;
  }

  resolve(requestId: string, decision: 'allow' | 'deny', reason: string): AuthRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request) return undefined;

    // Only resolve pending requests (idempotent for repeated clicks)
    if (request.status !== 'pending') {
      return request;
    }

    request.status = 'resolved';
    request.decision = decision;
    request.decisionReason = reason;
    request.resolvedAt = Date.now();

    const latencyMs = request.resolvedAt - request.createdAt;
    log('info', 'auth_decision_received', { requestId, decision, reason, latencyMs });

    return request;
  }

  /**
   * Clean up expired requests (call periodically)
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, request] of this.requests) {
      if (now - request.createdAt > AUTH_TTL_MS * 2) {
        this.requests.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }
}

export const authStore = new AuthStore();

// Periodic cleanup every 5 minutes
setInterval(() => authStore.cleanup(), AUTH_TTL_MS);
