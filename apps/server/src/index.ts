import 'dotenv/config';
import express from 'express';
import { hookRouter } from './routes/hook.js';
import { feishuRouter } from './routes/feishu.js';
import { initMessageSessionMap } from './services/message-session-map.js';

const app = express();
const PORT = process.env.PORT || 3000;
const USE_LONG_CONNECTION = process.env.FEISHU_USE_LONG_CONNECTION === 'true';

app.use(express.json());

// Initialize services
initMessageSessionMap();

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/hook', hookRouter);
app.use('/api/feishu', feishuRouter);

const server = app.listen(PORT, async () => {
  console.log(`🚀 Feishu Claude Bridge server running on port ${PORT}`);

  if (USE_LONG_CONNECTION) {
    console.log('📡 Mode: WebSocket Long Connection');
    console.log('   ℹ️  No public URL needed - client connects to Feishu');
    try {
      await startWSClient();
      console.log('   ✅ WebSocket client started successfully');
    } catch (error) {
      console.error('   ❌ Failed to start WebSocket client:', error);
      process.exit(1);
    }
  } else {
    console.log('🌐 Mode: HTTP Webhook');
    console.log('   ℹ️  Configure webhook URL in Feishu console:');
    console.log(`   ℹ️  http://your-domain/api/feishu/webhook`);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, shutting down gracefully...');

  if (USE_LONG_CONNECTION) {
    await stopWSClient();
  }

  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT received, shutting down gracefully...');

  if (USE_LONG_CONNECTION) {
    await stopWSClient();
  }

  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
