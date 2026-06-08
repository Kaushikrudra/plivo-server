import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import plivo from 'plivo';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'fs';

dotenv.config();

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── PostgreSQL Connection ─────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ── Initialize Tables ─────────────────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        number VARCHAR(50) DEFAULT '',
        role VARCHAR(50) DEFAULT 'agent',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id VARCHAR(255) PRIMARY KEY,
        agent VARCHAR(255),
        "to" VARCHAR(50),
        duration INTEGER DEFAULT 0,
        recording_url TEXT DEFAULT '',
        status VARCHAR(50) DEFAULT 'completed',
        time TIMESTAMP DEFAULT NOW()
      );
    `);

    const { rows } = await pool.query('SELECT COUNT(*) FROM agents');
    if (parseInt(rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO agents (name, username, password, role) VALUES
        ('Administrator', 'admin', 'Admin@1234', 'admin'),
        ('Agent 1', 'zohoagent170932965467135247620', 'Agent@1234', 'agent')
        ON CONFLICT (username) DO NOTHING;
      `);
      console.log('✅ Default agents inserted');
    }

    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}

// ── Plivo Client ──────────────────────────────────────────────────────────────
let client = null;
if (process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN) {
  try {
    client = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);
    console.log('✅ Plivo client initialized');
  } catch (err) {
    console.error('❌ Plivo init error:', err.message);
  }
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const distPath = path.join(__dirname, '../dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
} else {
  app.use(express.static(path.join(__dirname, '../public')));
}

// ── AGENTS ────────────────────────────────────────────────────────────────────
app.get('/agents', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, username, number, role FROM agents ORDER BY created_at'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT id, name, username, number, role FROM agents WHERE username=$1 AND password=$2',
      [username, password]
    );
    if (rows.length > 0) {
      res.json({ success: true, agent: rows[0] });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/agents', async (req, res) => {
  const { name, username, password, number } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO agents (name, username, password, number, role) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, username, password, number || '', 'agent']
    );
    console.log(`👤 New agent created: ${username}`);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).json({ error: 'Agent ID already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

app.put('/agents/:username', async (req, res) => {
  const { username } = req.params;
  const { name, password, number } = req.body;
  try {
    let query, params;
    if (password) {
      query = 'UPDATE agents SET name=$1, password=$2, number=$3 WHERE username=$4 RETURNING *';
      params = [name, password, number || '', username];
    } else {
      query = 'UPDATE agents SET name=$1, number=$2 WHERE username=$3 RETURNING *';
      params = [name, number || '', username];
    }
    const { rows } = await pool.query(query, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Agent not found' });
    console.log(`✅ Agent updated: ${username}`);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/agents/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM agents WHERE username=$1', [username]);
    if (rowCount === 0) return res.status(404).json({ error: 'Agent not found' });
    console.log(`🗑️ Agent deleted: ${username}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TOKEN ─────────────────────────────────────────────────────────────────────
app.get('/token', async (req, res) => {
  const requestedUsername = req.query.username;
  try {
    // Ab SELECT mein 'number' column bhi la rahe hain
    const { rows } = await pool.query(
      'SELECT username, password, number FROM agents WHERE username=$1',
      [requestedUsername]
    );
    let agent = rows[0];
    if (!agent) {
      // Fallback: koi bhi agent (role='agent')
      const { rows: fallback } = await pool.query(
        'SELECT username, password, number FROM agents WHERE role=$1 LIMIT 1',
        ['agent']
      );
      agent = fallback[0];
      if (!agent) return res.json({ username: '', password: '' });
    }
    
    // Extract real SIP username from 'number' column (which stores sip:long@phone.plivo.com)
    let sipUsername = agent.username;  // fallback agar number column me kuch na ho
    if (agent.number && agent.number.includes('sip:')) {
      const match = agent.number.match(/sip:(.+?)@/);
      if (match && match[1]) sipUsername = match[1];
    }
    
    console.log(`🔑 Token requested for: ${requestedUsername}, returning SIP user: ${sipUsername}`);
    res.json({ username: sipUsername, password: agent.password });
  } catch (err) {
    console.error('❌ Token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ANSWER ────────────────────────────────────────────────────────────────────
app.post('/answer', async (req, res) => {
  console.log('📞 Answer:', JSON.stringify(req.body));
  let to = req.body.To || req.body.to;
  let agentName = req.body['X-PH-AgentName'];

  if (!agentName && req.body.From) {
    try {
      const { rows } = await pool.query(
        "SELECT name FROM agents WHERE $1 LIKE '%' || username || '%'",
        [req.body.From]
      );
      if (rows.length > 0) agentName = rows[0].name;
    } catch (e) {}
  }
  if (!agentName) agentName = 'Agent';

  let isSip = false;
  if (to) {
    if (to.startsWith('sip:') || to.includes('@') || to.startsWith('zohoagent') || to.startsWith('edwinagent')) {
      isSip = true;
      if (!to.startsWith('sip:')) {
        to = to.includes('@') ? `sip:${to}` : `sip:${to}@phone.plivo.com`;
      }
    } else {
      const hasPlus = to.startsWith('+');
      const digits = to.replace(/\D/g, '');
      if (hasPlus) to = '+' + digits;
      else if (digits.length === 10) to = '+91' + digits;
      else to = '+' + digits;
    }
  }

  const dialElement = isSip ? `<User>${to}</User>` : `<Number>${to}</Number>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${process.env.PLIVO_NUMBER}" record="true" recordingCallbackUrl="${process.env.RENDER_URL}/recording?agent=${encodeURIComponent(agentName)}" recordingCallbackMethod="POST">
    ${dialElement}
  </Dial>
</Response>`;

  res.set('Content-Type', 'text/xml').send(xml);
});

// ── RECORDING ─────────────────────────────────────────────────────────────────
app.post('/recording', async (req, res) => {
  console.log('⏺️ Recording:', JSON.stringify(req.body));

  let agentName = req.query.agent;
  if (!agentName || agentName === 'Agent') {
    try {
      const { rows } = await pool.query(
        'SELECT name FROM agents WHERE username=$1', [req.body.CallerName]
      );
      if (rows.length > 0) agentName = rows[0].name;
    } catch (e) {}
  }
  if (!agentName) agentName = 'Unknown Agent';

  // Map duration correctly: prefer Duration if RecordingDuration is invalid
  let duration = req.body.RecordingDuration;
  if (duration === '-1' || duration === -1 || !duration) {
    duration = req.body.Duration || 0;
  }

  const callId = req.body.CallUUID || req.body.call_uuid || 'call_' + Date.now();
  
  // Sanitize recording URL: Ensure it's a direct media URL and ends with .mp3
  let recordingUrl = req.body.RecordingUrl || req.body.RecordUrl || req.body.record_url || '';
  if (recordingUrl) {
    // If it's an API URL, convert to media URL (simple replacement usually works for Plivo)
    recordingUrl = recordingUrl.replace('api.plivo.com', 'media.plivo.com');
    // Ensure it has .mp3 extension
    if (!recordingUrl.endsWith('.mp3')) {
      recordingUrl = recordingUrl + '.mp3';
    }
  }

  try {
    await pool.query(
      'INSERT INTO calls (id, agent, "to", duration, recording_url, status, time) VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (id) DO NOTHING',
      [callId, agentName, req.body.To || req.body.to || '', parseInt(duration), recordingUrl, 'completed']
    );
    console.log(`📝 Call saved: ${callId} | URL: ${recordingUrl}`);
  } catch (err) {
    console.error('❌ Save call error:', err.message);
  }
  res.sendStatus(200);
});

// ── CALLS ─────────────────────────────────────────────────────────────────────
app.get('/calls', async (req, res) => {
  const { username, role } = req.query;
  try {
    if (role === 'admin' || !username) {
      const { rows } = await pool.query('SELECT * FROM calls ORDER BY time ASC');
      return res.json(rows.map(r => ({
        id: r.id, agent: r.agent, to: r.to,
        duration: r.duration, recordingUrl: r.recording_url,
        time: r.time, status: r.status
      })));
    }
    const { rows: agentRows } = await pool.query(
      'SELECT name FROM agents WHERE username=$1', [username]
    );
    const agentName = agentRows[0]?.name || username;
    const { rows } = await pool.query(
      'SELECT * FROM calls WHERE LOWER(agent)=LOWER($1) ORDER BY time ASC', [agentName]
    );
    res.json(rows.map(r => ({
      id: r.id, agent: r.agent, to: r.to,
      duration: r.duration, recordingUrl: r.recording_url,
      time: r.time, status: r.status
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/status', (req, res) => res.json({ status: 'running' }));

// ── FALLBACK ──────────────────────────────────────────────────────────────────
app.use((req, res) => {
  const distIndex = path.join(__dirname, '../dist/index.html');
  if (fs.existsSync(distIndex)) {
    res.sendFile(distIndex);
  } else {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await initDB();
});
