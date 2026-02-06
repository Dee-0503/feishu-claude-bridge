# Phase 1 任务完成通知增强计划

## Context

用户需要在 Claude Code 任务完成时，通过飞书推送包含任务摘要的通知。当前实现只发送简单的完成消息，缺乏上下文信息。

**核心需求**：
1. 任务完成时推送包含摘要的消息卡片
2. 支持多项目并行场景，消息需要清晰标识来源
3. 移除 "waiting for input" 通知（留给 Phase 2 处理）
4. 授权请求显示与 Claude 原生选项对应的按钮

**设计约束**：
- 低开销：避免每次调用 LLM 生成摘要
- 快速响应：不能明显延迟通知
- 多实例友好：项目 × worktree × 会话 三级标识

---

## 实现方案

### 1. 消息管理设计（项目分群）

**方案**：每个项目对应一个独立的飞书群，群内按 worktree/会话 区分消息。

```
群1: [feishu-bridge] 项目群
  ├── main 分支通知
  ├── phase2 worktree 通知
  └── phase3 worktree 通知

群2: [another-project] 项目群
  └── main 分支通知
```

**卡片 Header 格式**（群内已知项目，简化标识）：
```
[分支名] / #会话短码
例如：[phase2] / #a3f2
```

**优势**：
- 符合开发习惯，一个项目一个群
- Phase 2 简化：@ 机器人默认在当前项目启动
- 回复路由清晰：群=项目，只需区分 worktree/会话

**群自动创建机制**：
1. Hook 触发时检查项目路径对应的群是否存在
2. 不存在则调用飞书 API 创建群，群名为项目名
3. 将映射关系持久化存储（文件/数据库）
4. 后续通知直接发送到对应群

**存储结构**（`data/project-groups.json`）：
```json
{
  "/Users/ceemac/my_product/feishu-claude-bridge": {
    "chatId": "oc_xxx",
    "projectName": "feishu-claude-bridge",
    "createdAt": "2026-02-06T10:00:00Z"
  }
}
```

### 2. 任务摘要提取（Haiku 小模型方案）

**设计思想**：借鉴 Claude Code 内部的 "Task Offloading" 模式——用小模型（Haiku）做辅助任务，降低成本的同时保证质量。

**两层生成**：
1. **规则提取**（本地，~100ms）：从 transcript 提取原始数据
2. **Haiku 摘要**（API，~500ms）：生成精炼的一句话任务摘要

**成本估算**：
- 输入：~500 tokens（任务描述 + 完成状态 + 操作统计）
- 输出：~50 tokens（一句话摘要）
- **单次成本**：~$0.0002（约 0.0014 元）
- **每天 100 次**：~$0.02（约 0.14 元）

**Prompt 设计**：
```
根据以下任务信息，生成一句话中文摘要（不超过50字）：

任务描述：{taskDescription}
完成状态：{completionMessage}
操作统计：编辑{edit}文件, 创建{write}文件, 执行{bash}命令
修改文件：{files}
耗时：{duration}秒

要求：简洁、准确、突出关键结果
```

**卡片更新流程**：
1. 先发送基础卡片（规则提取的信息），获取 `message_id`
2. 异步调用 Haiku 生成摘要
3. Haiku 返回后，更新同一张卡片加入摘要
4. 如果 Haiku 调用失败，保持基础卡片不变

**用户体验**：
- 任务完成后立即收到通知（~100ms）
- 卡片自动补全摘要（~500ms 后）
- 群内消息数不变，不刷屏

**实现代码**：
```typescript
// 1. 发送初始卡片
const result = await feishuClient.im.message.create({ ... });
const messageId = result.data.message_id;

// 2. 异步更新（不阻塞响应）
generateTaskSummary(rawData).then(summary => {
  if (summary) {
    updateCardWithSummary(messageId, summary);
  }
}).catch(err => console.error('Haiku summary failed:', err));
```

**与规则提取的分工**：
| 信息 | 来源 | 显示时机 |
|------|------|---------|
| 项目/分支/会话 | 规则提取 | 立即 |
| 操作统计/文件列表/耗时 | 规则提取 | 立即 |
| 任务摘要（一句话） | Haiku 生成 | ~500ms 后更新 |

### 3. 消息卡片结构

```
┌─────────────────────────────────────────────────┐
│  ✅ [phase2] / #a3f2                            │  <- Header: 分支 + 会话短码
├─────────────────────────────────────────────────┤
│  **摘要**: 完成飞书消息卡片构建，支持多项目通知    │  <- Haiku 生成
│                                                 │
│  **操作**: 编辑 3 文件 | 创建 1 文件 | 执行 5 命令  │  <- 规则提取
│                                                 │
│  **文件**: message.ts, hook.ts, notify.js        │  <- 规则提取
│                                                 │
│  **耗时**: 2分35秒                               │  <- 规则提取
└─────────────────────────────────────────────────┘
```

**卡片字段**：
- **Header**：`[分支名] / #会话短码`（群=项目，无需重复）
- **摘要**：Haiku 生成的一句话（核心亮点）
- **操作统计**：规则提取的工具调用统计
- **文件列表**：修改/创建的文件名（最多5个）
- **耗时**：任务持续时间

### 4. 通知范围调整

Phase 1 只发送以下通知：
- ✅ **任务完成通知**：包含摘要的卡片
- ✅ **授权请求通知**：带选项按钮的卡片（原生选项映射）
- ❌ ~~waiting for input~~：移除，Phase 2 处理

### 5. 授权选项按钮映射

Claude 原生选项 → 飞书按钮（解析并映射）：

| 原生选项 | 按钮文本 | 按钮类型 |
|---------|---------|---------|
| Yes | 允许 | primary |
| Yes, always | 始终允许 | primary |
| Yes, don't ask again for this project | 本项目始终允许 | default |
| No | 拒绝 | danger |

**解析逻辑**：
- 从 Notification hook 的 payload 中提取 `options` 数组
- 根据英文关键词匹配，映射为对应中文
- Fallback：无法识别的选项保持原文显示

### 6. 容错与降级策略

| 场景 | 处理方式 |
|------|---------|
| transcript 文件不存在 | 发送简化通知（仅标题，无摘要） |
| transcript 解析失败 | 发送简化通知，记录错误日志 |
| 分支名获取失败 | Fallback 执行 `git branch --show-current` |
| 授权选项无法解析 | 保持原文显示 |

**原则**：尽量发送通知，不因解析错误而完全静默

---

## 关键文件修改

### 1. `hooks/notify.js`
- 读取 `transcript_path` 并提取摘要
- 提取项目路径、分支名
- 优化：只读取 transcript 首尾部分

### 2. `apps/server/src/routes/hook.ts`
- `/api/hook/stop`：处理 summary 数据
- 调用群管理服务获取/创建对应群
- 移除或禁用 "waiting for input" 相关逻辑

### 3. `apps/server/src/feishu/message.ts`
- 扩展 `SendMessageOptions` 接口，添加 summary 相关字段
- `buildCard()` 支持丰富的摘要卡片
- Header 显示简化标识（分支 + 会话短码）
- `sendCardMessage()` 接受动态 chat_id

### 4. 新增 `apps/server/src/feishu/group.ts`
```typescript
// 群管理服务
export async function getOrCreateProjectGroup(projectPath: string): Promise<string>;
export async function createGroup(projectName: string): Promise<string>;
export function loadGroupMappings(): Record<string, GroupInfo>;
export function saveGroupMapping(projectPath: string, info: GroupInfo): void;
```

### 5. 新增 `apps/server/src/types/summary.ts`
```typescript
interface TaskSummary {
  projectPath: string;
  projectName: string;
  gitBranch: string;
  sessionShortId: string;
  taskDescription: string;
  completionMessage: string;
  toolStats: { edit: number; write: number; bash: number; read: number };
  filesModified: string[];
  filesCreated: string[];
  duration: number;
}

interface GroupInfo {
  chatId: string;
  projectName: string;
  createdAt: string;
}
```

### 6. 新增 `apps/server/data/project-groups.json`
- 持久化项目路径 → 群 ID 映射

### 7. 新增 `apps/server/src/services/summary.ts`
```typescript
// Haiku 摘要服务
import Anthropic from '@anthropic-ai/sdk';

export async function generateTaskSummary(rawSummary: RawSummary): Promise<string> {
  // 调用 Haiku 生成一句话摘要
  // 失败时返回空字符串，降级为规则提取
}
```

### 8. `apps/server/package.json`
- 添加依赖：`@anthropic-ai/sdk`

### 9. `apps/server/.env.example`
- 添加：`ANTHROPIC_API_KEY=sk-ant-...`

---

## 验证方案

1. **启动服务**
   ```bash
   cd apps/server && pnpm dev
   ```

2. **触发任务完成**
   - 在配置了 Hook 的项目中运行 Claude Code
   - 执行一个简单任务后让 Claude 停止

3. **检查飞书消息**
   - 确认收到包含摘要的卡片
   - 确认三级标签显示正确（项目/分支/会话）
   - 确认操作统计和文件列表正确

4. **多实例测试**
   - 在不同 worktree 同时运行 Claude Code
   - 确认消息能通过标签区分来源

---

## 后续考虑（非本次范围）

- 可选 LLM 摘要增强（Haiku，~$0.0002/次）
- 消息过滤/搜索功能

---

## Phase 2 设计预留：消息回复路由

项目分群模式下，回复路由更加简化：

| 用户行为 | 含义 | 处理方式 |
|---------|------|---------|
| **@ 机器人发新消息** | 在当前项目启动新任务 | 群已绑定项目，自动确定工作区 |
| **回复某条通知卡片** | 针对该卡片对应的会话实例 | 从回复消息提取 session_id |
| **直接在群内发消息（无回复）** | 补充当前 worktree 的上下文 | 视为对最近活跃会话的输入 |

**项目分群的好处**：
- 群 = 项目，@ 机器人时自动知道工作区（项目根目录）
- 只需从消息元数据提取 worktree（分支名）和 session_id
- 用户在哪个群就操作哪个项目，符合直觉

**Phase 1 需要预留**：
- 消息卡片需携带 `session_id` 和 `gitBranch` 元数据
- 群创建时记录项目根路径，供 Phase 2 启动实例时使用

**Phase 2 实现要点**：
- 飞书 webhook 收到消息时，从群 ID 反查项目路径
- 如果是回复，提取 `parent_id` 找到原始卡片的 session_id
- 将用户消息路由到正确的 Claude 实例

**补充：主动回复视为 worktree 上下文补充**
- 用户在群内直接发消息（非回复特定卡片）时：
  1. 视为对当前 worktree 的补充信息/需求
  2. 系统记录最近活跃的 session_id（按 worktree/分支）
  3. 将消息路由到该分支最近的活跃会话
  4. 如果没有活跃会话，可选择启动新实例或提示用户
