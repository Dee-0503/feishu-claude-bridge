# Feishu Claude Bridge - 项目开发规范

## Git提交规范

### Commit Message格式
- feat: 新功能
- fix: Bug修复
- docs: 文档更新
- refactor: 代码重构
- test: 测试相关

### Co-Author标注
所有AI辅助的提交必须包含：
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

### PR创建
gh pr create --title "简短标题" --body "详细描述"

## 代码规范

### TypeScript模块
- 使用ESM模块（module: "NodeNext"）
- Import必须带.js扩展名：import { foo } from './bar.js'

### 飞书UI
- 所有卡片、按钮使用中文
- 使用项目群隔离：getOrCreateProjectGroup(projectPath)

### 测试
- 框架：vitest
- 集成测试需清除env：delete process.env.HOOK_SECRET

## Hooks兼容性
Phase3的hooks/notify.js是完整版本，直接使用。
如有Phase1旧部署，替换hooks脚本到Phase3版本。
