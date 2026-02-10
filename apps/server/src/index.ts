import 'dotenv/config';
import express from 'express';
import { hookRouter } from './routes/hook.js';
import { feishuRouter } from './routes/feishu.js';
import { initMessageSessionMap } from './services/message-session-map.js';

const app = express();
const PORT = process.env.PORT || 3000;

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

app.listen(PORT, () => {
  console.log(`🚀 Feishu Claude Bridge server running on port ${PORT}`);
});
