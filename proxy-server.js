const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = 3001;

// CORS設定
app.use(cors({
  origin: 'http://localhost:5173', // Viteの開発サーバー
  credentials: true
}));

app.use(express.json());

// Slack通知のプロキシエンドポイント
app.post('/api/slack-notify', async (req, res) => {
  try {
    const { message } = req.body;
    
    // Slack Webhook URLに送信
    const response = await fetch('https://hooks.slack.com/services/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', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message)
    });
    
    if (response.ok) {
      console.log('✅ Slack通知を送信しました');
      res.json({ success: true });
    } else {
      console.error('❌ Slack通知の送信に失敗:', response.status);
      res.status(500).json({ error: 'Slack通知の送信に失敗しました' });
    }
  } catch (error) {
    console.error('❌ プロキシサーバーエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 プロキシサーバーが起動しました: http://localhost:${PORT}`);
});