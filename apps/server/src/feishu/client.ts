import * as lark from '@larksuiteoapi/node-sdk';

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.warn('⚠️ FEISHU_APP_ID or FEISHU_APP_SECRET not configured');
}

export const feishuClient = new lark.Client({
  appId: appId || '',
  appSecret: appSecret || '',
  disableTokenCache: false,
});
