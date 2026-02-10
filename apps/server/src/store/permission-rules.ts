/**
 * 权限规则持久化存储
 * 用户选择"始终允许"后，记录规则，后续相同命令模式自动放行
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type { PermissionRule } from '../types/auth.js';
import { log } from '../utils/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const RULES_FILE = path.join(DATA_DIR, 'permission-rules.json');

class PermissionRuleStore {
  private rules: PermissionRule[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(RULES_FILE)) {
        const data = fs.readFileSync(RULES_FILE, 'utf-8');
        this.rules = JSON.parse(data);
        log('info', 'permission_rules_loaded', { count: this.rules.length });
      }
    } catch (error) {
      log('error', 'permission_rules_load_failed', { error: String(error) });
      this.rules = [];
    }
  }

  private save(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(RULES_FILE, JSON.stringify(this.rules, null, 2));
    } catch (error) {
      log('error', 'permission_rules_save_failed', { error: String(error) });
    }
  }

  addRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): PermissionRule {
    const newRule: PermissionRule = {
      ...rule,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.rules.push(newRule);
    this.save();
    log('info', 'permission_rule_added', {
      id: newRule.id,
      tool: newRule.tool,
      commandPattern: newRule.commandPattern,
      scope: newRule.scope,
    });
    return newRule;
  }

  /**
   * Check if a tool/command matches any existing rule
   */
  match(tool: string, command?: string, projectPath?: string): PermissionRule | null {
    for (const rule of this.rules) {
      if (rule.tool !== tool) continue;

      // Project scope check
      if (rule.scope === 'project' && rule.projectPath) {
        if (!projectPath || !projectPath.startsWith(rule.projectPath)) {
          continue;
        }
      }

      // Command pattern check (simple glob: * matches anything)
      if (rule.commandPattern) {
        if (!command) continue;
        if (!matchGlob(rule.commandPattern, command)) continue;
      }

      log('info', 'auth_rule_matched', {
        ruleId: rule.id,
        tool,
        command: command?.substring(0, 100),
      });
      return rule;
    }
    return null;
  }

  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  removeRule(id: string): boolean {
    const index = this.rules.findIndex(r => r.id === id);
    if (index === -1) return false;
    this.rules.splice(index, 1);
    this.save();
    return true;
  }
}

/**
 * Simple glob pattern matching (supports * and **)
 */
function matchGlob(pattern: string, text: string): boolean {
  // Convert glob to regex step by step
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      regexStr += '.*';
      i += 2;
    } else if (char === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (char === '?') {
      regexStr += '.';
      i++;
    } else if ('.+^${}()|[]\\'.includes(char)) {
      regexStr += '\\' + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  try {
    return new RegExp(`^${regexStr}$`).test(text);
  } catch {
    return pattern === text;
  }
}

export const permissionRules = new PermissionRuleStore();
