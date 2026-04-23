import express from 'express';
import cors from 'cors';
import { lookupAddress } from './sweeping.js';
import { buildIcs } from './ics.js';

const app = express();

// Render / Heroku / most PaaS sit behind a proxy that adds X-Forwarded-*
// headers. Trust them so req.protocol reports "https" (not "http"), which
// we need when generating absolute URLs for the .ics endpoint.
app.set('trust proxy', 1);

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
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await lookupAddress(address, { baseUrl });
    res.json(result);
  } catch (err) {
    console.error('[lookup] error:', err);
    res.status(500).json({ error: err.message || 'Lookup failed.' });
  }
});

/**
 * Stream back a fully-formed .ics file for a biweekly sweep schedule.
 * All state is in the query string — no DB, no session. The frontend
 * gets this URL as `gcalUrl` and just wires it to an <a href> so clicking
 * downloads the file, which any OS calendar app can then open.
 *
 * Query params: address, routeNo, boundaries, start, end, dayIndex, weeks
 * (start/end are ISO UTC strings; dayIndex is 0..6).
 */
app.get('/api/calendar.ics', (req, res) => {
  try {
    const q = req.query || {};
    const dayIndexRaw = q.dayIndex == null ? null : Number(q.dayIndex);
    const ics = buildIcs({
      address: String(q.address || ''),
      routeNo: String(q.routeNo || ''),
      boundaries: String(q.boundaries || ''),
      start: String(q.start || ''),
      end: String(q.end || ''),
      dayIndex: Number.isFinite(dayIndexRaw) ? dayIndexRaw : null,
      weeks: q.weeks ? String(q.weeks) : null,
      uidSeed: String(q.routeNo || 'route'),
    });
    const filename = `sweep-${String(q.routeNo || 'route').replace(/[^\w-]/g, '') || 'route'}.ics`;
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(ics);
  } catch (err) {
    console.error('[calendar.ics] error:', err);
    res.status(500).send('Failed to build calendar file.');
  }
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`LA Sweep API listening on http://localhost:${port}`);
});
