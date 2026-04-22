import express from 'express';
import cors from 'cors';
import { lookupAddress } from './sweeping.js';

const app = express();

// CORS: by default allow everything (useful for local dev). In production,
// set ALLOWED_ORIGINS to a comma-separated list of origins, e.g.
// "https://yoursite.framer.website,https://yoursite.com".
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (allowedOrigins.length === 0) return cb(null, true);
      if (!origin) return cb(null, true); // curl, server-to-server
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
  })
);
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/lookup', async (req, res) => {
  const address = (req.body && req.body.address || '').toString().trim();
  if (!address) {
    return res.status(400).json({ error: 'Missing "address" in request body.' });
  }
  try {
    const result = await lookupAddress(address);
    res.json(result);
  } catch (err) {
    console.error('[lookup] error:', err);
    res.status(500).json({ error: err.message || 'Lookup failed.' });
  }
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`LA Sweep API listening on http://localhost:${port}`);
});
