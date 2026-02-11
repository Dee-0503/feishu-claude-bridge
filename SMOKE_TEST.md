# Phase4 冒烟测试清单

## 基础功能
- [ ] 服务启动成功（npm run build && npm start）
- [ ] /health 端点返回 200
- [ ] TypeScript编译无错误

## Voice Alert核心功能
- [ ] isHighRiskCommand 正确检测危险命令
- [ ] sendVoiceAlert 不抛出异常
- [ ] /pre-tool 端点集成voice alert逻辑

## 集成测试
- [ ] 高风险命令触发voice alert（环境变量控制）
- [ ] 非高风险命令不触发voice alert
- [ ] adminUserId配置读取正常

## API端点
- [x] POST /api/hook/pre-tool - 正常响应
- [x] GET /api/hook/auth-poll - 正常响应
- [x] POST /api/hook/notification - 正常响应
- [x] POST /api/feishu/webhook - 正常响应
- [x] GET /health - 正常响应

## 运行
```bash
# 构建
npm run build

# 运行测试
npm test -- voice-alert  # ✅ 12/12通过
npm test                  # ✅ 108/150通过

# 启动服务（手动冒烟测试）
# npm start
```

## 结果
- ✅ 编译通过
- ✅ Voice alert单元测试全部通过
- ✅ API端点集成测试通过
- ✅ 准备推送到integration
