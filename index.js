const express = require('express');
const app = express();
app.get('/', (_req, res) => res.send('Mastermind Bet — dashboard is live ✅'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.listen(3000, () => console.log('App on :3000'));
