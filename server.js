/**
 * Netiva — Zeabur PostgreSQL backend
 * Replaces Supabase with a simple REST API over plain PostgreSQL.
 *
 * Endpoints:
 *   GET  /api/doc/:id          → read a doc row
 *   POST /api/doc/:id          → upsert a doc row  { data: {...} }
 *   GET  /health               → liveness check
 *
 * Environment variables (set in Zeabur dashboard):
 *   DATABASE_URL  — PostgreSQL connection string
 *                   e.g. postgresql://user:pass@host:5432/netiva
 *   PORT          — defaults to 3000
 */

const express = require('express');
const { Pool }  = require('pg');
const path      = require('path');

const app  = express();
const port = process.env.PORT || 3000;

// ── Database pool ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

// Create table on first connect (idempotent)
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS netiva_store (
      doc_id TEXT PRIMARY KEY,
      data   JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('DB ready — netiva_store table ensured.');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' })); // large limit for base64 images

// CORS — allow any origin (single-file HTML served from same server usually)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Static HTML ───────────────────────────────────────────────────────────────
// Serve index.html from the same folder as this file
app.use(express.static(path.join(__dirname)));

// ── API routes ────────────────────────────────────────────────────────────────

// GET /api/doc/:id  → { exists: bool, data: {...} | null }
app.get('/api/doc/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT data FROM netiva_store WHERE doc_id = $1',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.json({ exists: false, data: null });
    }
    return res.json({ exists: true, data: rows[0].data });
  } catch (err) {
    console.error('GET /api/doc/' + req.params.id, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/doc/:id  body: { data: {...}, merge?: bool }
// merge=true does a shallow JSON merge (like Firestore merge option)
app.post('/api/doc/:id', async (req, res) => {
  const { data, merge } = req.body;
  if (data === undefined) return res.status(400).json({ error: 'Missing data' });

  try {
    if (merge) {
      // Read existing, deep-merge, write back
      const { rows } = await pool.query(
        'SELECT data FROM netiva_store WHERE doc_id = $1',
        [req.params.id]
      );
      const existing = rows.length ? rows[0].data : {};
      const merged   = deepMerge(existing, data);
      await pool.query(
        `INSERT INTO netiva_store (doc_id, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (doc_id) DO UPDATE SET data = $2, updated_at = NOW()`,
        [req.params.id, merged]
      );
      return res.json({ ok: true });
    } else {
      await pool.query(
        `INSERT INTO netiva_store (doc_id, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (doc_id) DO UPDATE SET data = $2, updated_at = NOW()`,
        [req.params.id, data]
      );
      return res.json({ ok: true });
    }
  } catch (err) {
    console.error('POST /api/doc/' + req.params.id, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (_, res) => res.json({ ok: true }));

// ── Deep merge helper (mirrors the one in the frontend) ───────────────────────
function deepMerge(target, source) {
  if (!target || typeof target !== 'object') return source;
  const out = { ...target };
  for (const k of Object.keys(source)) {
    if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
      out[k] = deepMerge(target[k], source[k]);
    } else {
      out[k] = source[k];
    }
  }
  return out;
}

// ── Start ─────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(port, () => console.log(`Netiva server listening on port ${port}`));
  })
  .catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
