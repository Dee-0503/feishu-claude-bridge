/**
 * 获取机器人所在群列表，找到 chat_id
 */
import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
});

async function main() {
  console.log('🔍 获取机器人所在的群列表...\n');

  try {
    const res = await client.im.chat.list({
      params: {
        page_size: 20,
      },
    });

    if (res.data?.items && res.data.items.length > 0) {
      console.log('找到以下群聊：\n');
      for (const chat of res.data.items) {
        console.log(`群名: ${chat.name}`);
        console.log(`chat_id: ${chat.chat_id}`);
        console.log(`描述: ${chat.description || '无'}`);
        console.log('---');
      }
    } else {
      console.log('❌ 机器人尚未加入任何群聊');
      console.log('\n请先将机器人添加到群聊中：');
      console.log('1. 打开飞书群聊');
      console.log('2. 点击群设置 → 群机器人 → 添加机器人');
      console.log('3. 搜索并添加你创建的应用机器人');
    }
  } catch (error: any) {
    console.error('❌ 获取群列表失败:', error.message);
    if (error.code === 99991663) {
      console.log('\n可能原因：应用未开启机器人能力或未发布');
      console.log('请在飞书开放平台 → 应用能力 → 添加"机器人"能力');
    }
  }
}

main();
