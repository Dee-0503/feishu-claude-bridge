#!/usr/bin/env node

// 测试脚本：验证 .env 配置和环境变量

console.log('🧪 测试 Feishu Claude Bridge 配置\n');

// 1. 测试环境变量
console.log('1️⃣ 环境变量检查:');
console.log(`   HOOK_SECRET: ${process.env.HOOK_SECRET || '❌ 未设置'}`);
console.log(`   FEISHU_BRIDGE_URL: ${process.env.FEISHU_BRIDGE_URL || '❌ 未设置'}`);

// 2. 测试 .env 文件加载
console.log('\n2️⃣ .env 文件检查:');
try {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '../apps/server/.env');

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const hookSecretMatch = envContent.match(/^HOOK_SECRET=(.*)$/m);
    const appIdMatch = envContent.match(/^FEISHU_APP_ID=(.*)$/m);
    const botIdMatch = envContent.match(/^FEISHU_BOT_OPEN_ID=(.*)$/m);
    const apiKeyMatch = envContent.match(/^ANTHROPIC_API_KEY=(.*)$/m);

    console.log(`   ✅ .env 文件存在`);
    console.log(`   HOOK_SECRET: ${hookSecretMatch ? (hookSecretMatch[1] || '❌ 空值') : '❌ 未配置'}`);
    console.log(`   FEISHU_APP_ID: ${appIdMatch ? (appIdMatch[1] ? '✅ 已配置' : '❌ 空值') : '❌ 未配置'}`);
    console.log(`   FEISHU_BOT_OPEN_ID: ${botIdMatch ? (botIdMatch[1] ? '✅ 已配置' : '❌ 空值') : '❌ 未配置'}`);
    console.log(`   ANTHROPIC_API_KEY: ${apiKeyMatch ? (apiKeyMatch[1] ? '✅ 已配置' : '❌ 空值') : '❌ 未配置'}`);
  } else {
    console.log(`   ❌ .env 文件不存在: ${envPath}`);
  }
} catch (error) {
  console.log(`   ❌ 读取失败: ${error.message}`);
}

// 3. 测试 Hook Secret 一致性
console.log('\n3️⃣ Hook Secret 一致性检查:');
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '../apps/server/.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envSecret = envContent.match(/^HOOK_SECRET=(.*)$/m)?.[1] || '';
const processSecret = process.env.HOOK_SECRET || '';

if (envSecret && processSecret) {
  if (envSecret === processSecret) {
    console.log(`   ✅ 一致 (.env 和环境变量都是 "${envSecret}")`);
  } else {
    console.log(`   ⚠️  不一致!`);
    console.log(`      .env 中: "${envSecret}"`);
    console.log(`      环境变量: "${processSecret}"`);
  }
} else {
  console.log(`   ❌ 未完全配置`);
  console.log(`      .env 中: "${envSecret || '空'}"`);
  console.log(`      环境变量: "${processSecret || '空'}"`);
}

// 4. 总结
console.log('\n📊 配置总结:');
const allGood = envSecret && processSecret && envSecret === processSecret;
if (allGood) {
  console.log('   ✅ 所有配置正确，可以启动服务器！');
  console.log('\n🚀 启动命令:');
  console.log('   cd apps/server && npm run dev');
} else {
  console.log('   ⚠️  配置不完整，请检查上述问题');
  console.log('\n💡 修复建议:');
  console.log('   1. 确保 .env 中设置了 HOOK_SECRET');
  console.log('   2. 导出环境变量: export HOOK_SECRET="你的密钥"');
  console.log('   3. 重新运行此测试脚本');
}
