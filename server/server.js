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
        reason TEXT DEFAULT '',
        time TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS reason TEXT DEFAULT ''`).catch(() => {});
    await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_url TEXT DEFAULT ''`).catch(() => {});
    await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS duration INTEGER DEFAULT 0`).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS otps (
        username VARCHAR(255) PRIMARY KEY,
        otp VARCHAR(10) NOT NULL,
        expires_at TIMESTAMP NOT NULL
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

// ── AGENTS & AUTH ─────────────────────────────────────────────────────────────

// Send OTP Endpoint
app.post('/send-otp', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required for OTP' });

  // Generate a 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  // Set expiration to 10 minutes from now
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  try {
    // Store OTP in database (upsert)
    await pool.query(
      `INSERT INTO otps (username, otp, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE SET otp = EXCLUDED.otp, expires_at = EXCLUDED.expires_at`,
      [username, otp, expiresAt]
    );

    if (client) {
      // TODO: CHANGE THIS NUMBER LATER TO THE ACTUAL COMPANY NUMBER
      // Note: number change for otp
      const targetNumber = '+919340284497'; 
      const sourceNumber = process.env.PLIVO_NUMBER || targetNumber; // Fallback to target if sender not set

      await client.messages.create(
        sourceNumber, // src
        targetNumber, // dst
        `Your Edwin Calling Solution Admin Verification Code is: ${otp}. Valid for 10 minutes.` // text
      );
      console.log(`✉️ OTP ${otp} sent via Plivo to ${targetNumber} for user ${username}`);
    } else {
      console.warn(`⚠️ Plivo client not configured. Simulated OTP for ${username} is ${otp}`);
    }

    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('❌ Error sending OTP:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

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
  const { name, username, password, number, role, otp } = req.body;
  
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  // Admin registration requires OTP verification
  if (role === 'admin') {
    if (!otp) {
      return res.status(400).json({ error: 'OTP is required for Admin registration' });
    }

    try {
      const { rows } = await pool.query('SELECT otp, expires_at FROM otps WHERE username = $1', [username]);
      if (rows.length === 0) {
        return res.status(400).json({ error: 'OTP not requested or expired' });
      }

      const storedOtpInfo = rows[0];
      if (new Date() > new Date(storedOtpInfo.expires_at)) {
        await pool.query('DELETE FROM otps WHERE username = $1', [username]);
        return res.status(400).json({ error: 'OTP has expired' });
      }

      if (storedOtpInfo.otp !== otp) {
        return res.status(400).json({ error: 'Invalid OTP' });
      }

      // OTP is valid, clean it up
      await pool.query('DELETE FROM otps WHERE username = $1', [username]);
    } catch (err) {
      return res.status(500).json({ error: 'Error verifying OTP' });
    }
  }

  try {
    const { rows } = await pool.query(
      'INSERT INTO agents (name, username, password, number, role) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, username, password, number || '', role || 'agent']
    );
    console.log(`👤 New agent created: ${username} (${role || 'agent'})`);
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
    const { rows } = await pool.query(
      'SELECT username, password, number FROM agents WHERE username=$1',
      [requestedUsername]
    );
    let agent = rows[0];
    if (!agent) {
      const { rows: fallback } = await pool.query(
        'SELECT username, password, number FROM agents WHERE role=$1 LIMIT 1',
        ['agent']
      );
      agent = fallback[0];
      if (!agent) return res.json({ username: '', password: '' });
    }
    
    let sipUsername = agent.username;
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

// ── HELPER: RESOLVE AGENT NAME FROM SIP OR USERNAME ───────────────────────────
async function resolveAgentName(inputAgent, callId) {
  if (!inputAgent) return 'Agent';
  
  // Extract username from SIP URI if present
  let cleanSipUser = inputAgent.trim();
  if (cleanSipUser.startsWith('sip:')) {
    const match = cleanSipUser.match(/sip:(.+?)@/);
    if (match && match[1]) cleanSipUser = match[1];
    else cleanSipUser = cleanSipUser.replace('sip:', '');
  }
  if (cleanSipUser.includes('@')) {
    cleanSipUser = cleanSipUser.split('@')[0];
  }

  try {
    // 1. Search by name, username, or number
    const { rows } = await pool.query(
      `SELECT name FROM agents 
       WHERE LOWER(name) = LOWER($1)
          OR LOWER(username) = LOWER($2) 
          OR number = $3 
          OR (number <> '' AND number LIKE '%' || $3 || '%')`,
      [inputAgent.trim(), cleanSipUser, inputAgent.trim()]
    );
    if (rows.length > 0) {
      return rows[0].name;
    }
    
    // 2. Check by callId fallback
    if (callId) {
      const { rows: callRows } = await pool.query('SELECT agent FROM calls WHERE id=$1', [callId]);
      if (callRows.length > 0 && callRows[0].agent && callRows[0].agent !== 'Unknown Agent') {
        return callRows[0].agent;
      }
    }
  } catch (e) {
    console.error('Agent lookup error:', e.message);
  }
  
  return inputAgent;
}

// ── ANSWER ────────────────────────────────────────────────────────────────────
app.post('/answer', async (req, res) => {
  console.log('📞 Answer Webhook Received:', JSON.stringify(req.body));
  
  const event = req.body.Event || req.body.event || '';
  const callStatus = req.body.CallStatus || req.body.call_status || '';
  const dialStatus = req.body.DialStatus || req.body.dial_status || '';
  const hangupCause = req.body.HangupCause || req.body.hangup_cause || '';
  const callId = req.body.CallUUID || req.body.call_uuid || req.body.DialALegUUID;

  // --- FIX: ENHANCED AGENT NAME RESOLUTION (CASE-INSENSITIVE + KEY SEARCH) ---
  let inputAgent = req.query.agent || req.body.agent || '';
  if (!inputAgent) {
    const findKey = (obj) => {
      if (!obj) return null;
      for (const key of Object.keys(obj)) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalized.includes('agentname')) {
          return obj[key];
        }
      }
      return null;
    };
    inputAgent = findKey(req.query) || findKey(req.body) || findKey(req.headers) || '';
  }
  if (!inputAgent) {
    inputAgent = req.body.CallerName || req.body.From || '';
  }

  const agentName = await resolveAgentName(inputAgent, callId);
  console.log(`👤 Resolved Agent Name: ${agentName} (from input: ${inputAgent})`);

  // --- REDIAL LOOP PREVENTION ---
  if (event.toLowerCase() !== 'hangup' && event.toLowerCase() !== 'startapp' && event.toLowerCase() !== 'dialhangup') {
    if (
      callStatus.toLowerCase() === 'cancel' ||
      callStatus.toLowerCase() === 'completed' ||
      dialStatus.toLowerCase() === 'busy' ||
      dialStatus.toLowerCase() === 'cancel' ||
      hangupCause === 'ORIGINATOR_CANCEL' ||
      hangupCause === 'USER_BUSY' ||
      (event.toLowerCase() === 'redirect' && (dialStatus.toLowerCase() === 'busy' || dialStatus.toLowerCase() === 'cancel'))
    ) {
      console.log('🛑 Stopping redial. Event:', event, 'Status:', callStatus, dialStatus);
      res.set('Content-Type', 'text/xml');
      return res.send('<Response><Hangup/></Response>');
    }
  }

  // --- HANGUP / SAVE LOGIC ---
  if (event.toLowerCase() === 'hangup' || event.toLowerCase() === 'dialhangup' || callStatus.toLowerCase() === 'completed') {
    let duration = req.body.Duration || req.body.duration || req.body.BillDuration || req.body.DialBillDuration || 0;
    const rawTo = req.body.To 
      || req.body.to 
      || req.body['SIP-H-To']?.replace(/<|>/g, '').split(':')[1]?.split('@')[0]
      || '';
    const to = rawTo.replace(/\D/g, '').slice(-10); // keep last 10 digits

    if (callId) {
      try {
        const mapStatus = (status, cause) => {
          const s = (status || '').toLowerCase();
          if (s === 'completed' || s === 'answered' || s === 'success') return 'completed';
          if (cause === 'USER_BUSY') return 'failed';
          if (cause === 'ORIGINATOR_CANCEL') return 'cancelled';
          if (cause === 'NO_ANSWER') return 'failed';
          return s || 'failed';
        };

        const finalStatus = mapStatus(callStatus || dialStatus, hangupCause);
        console.log(`💾 Saving call to DB: ${callId} | Agent: ${agentName} | Status: ${finalStatus} | Duration: ${duration}s`);

        await pool.query(
          `INSERT INTO calls (id, agent, "to", duration, recording_url, status, reason, time) 
           VALUES ($1, $2, $3, $4, '', $5, $6, NOW()) 
           ON CONFLICT (id) DO UPDATE SET 
             agent = CASE WHEN calls.agent = 'Unknown Agent' OR calls.agent LIKE 'zohoagent%' THEN EXCLUDED.agent ELSE calls.agent END,
             duration = CASE WHEN EXCLUDED.duration > 0 THEN EXCLUDED.duration ELSE calls.duration END, 
             status = EXCLUDED.status,
             reason = EXCLUDED.reason`,
          [callId, agentName, to, parseInt(duration), finalStatus, hangupCause]
        );
        console.log(`✅ ${event} processed for Call: ${callId}`);
      } catch (err) {
        console.error('❌ Error saving data:', err.message);
      }
    }
    return res.status(200).send('OK');
  }

  // Initial Answer Request: return Dial XML
  let to = req.body.To || req.body.to;

  // Determine base URL for callbacks dynamically from request headers.
  // This automatically adapts to whatever domain (e.g. plivo-server-c3tp.onrender.com)
  // or local ngrok tunnel is being used to contact the server.
  let protocol = req.headers['x-forwarded-proto'] || req.protocol;
  let host = req.headers['host'] || req.get('host');
  let baseUrl = `${protocol}://${host}`;
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  console.log('🌐 Base URL being used:', baseUrl);

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
  const recordingCallback = `${baseUrl}/recording?agent=${encodeURIComponent(agentName)}`;
  const actionUrl = `${baseUrl}/answer?agent=${encodeURIComponent(agentName)}`;
  const callbackUrl = `${baseUrl}/answer?agent=${encodeURIComponent(agentName)}`; // For status changes
  
  console.log('🎙️ Recording callback URL:', recordingCallback);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record action="${recordingCallback}" 
          startOnDialAnswer="true" 
          redirect="false" 
          maxLength="14400" />
  <Dial callerId="${process.env.PLIVO_NUMBER}" 
        action="${actionUrl}" 
        callbackUrl="${callbackUrl}"
        callbackMethod="POST"
        answerOnBridge="true" 
        hangupOnStar="false" 
        timeLimit="14400">
    ${dialElement}
  </Dial>
</Response>`;

  console.log(`📡 Sending XML for Agent: ${agentName} | action: ${actionUrl}`);
  res.set('Content-Type', 'text/xml').send(xml);
});

app.get('/recording', (req, res) => {
  res.json({ status: 'Recording endpoint is active' });
});

// ── RECORDING ─────────────────────────────────────────────────────────────────
app.post('/recording', async (req, res) => {
  console.log('🎙️ Recording webhook hit!', req.body.CallUUID, req.body.RecordingUrl);
  console.log('⏺️ Recording Callback Full Data:', JSON.stringify(req.body));

  const callId = req.body.CallUUID || req.body.call_uuid;
  const hangupCause = req.body.HangupCause || req.body.hangup_cause || '';
  
  let inputAgent = req.query.agent || '';
  if (!inputAgent) {
    const findKey = (obj) => {
      if (!obj) return null;
      for (const key of Object.keys(obj)) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalized.includes('agentname')) {
          return obj[key];
        }
      }
      return null;
    };
    inputAgent = findKey(req.query) || findKey(req.body) || findKey(req.headers) || '';
  }
  if (!inputAgent) {
    inputAgent = req.body.From || req.body.CallerName || '';
  }

  const agentName = await resolveAgentName(inputAgent, callId);
  console.log(`👤 Resolved Recording Agent Name: ${agentName} (from input: ${inputAgent})`);

  let duration = req.body.RecordingDuration || req.body.duration || 0;
  if (duration === '-1' || duration === -1) duration = 0;

  const status = req.body.CallStatus || req.body.call_status || 'completed';
  
  let recordingUrl = req.body.RecordingUrl || req.body.RecordUrl || req.body.record_url || '';
  if (recordingUrl) {
    recordingUrl = recordingUrl.replace('api.plivo.com', 'media.plivo.com');
  }

  if (callId) {
    console.log('🎙️ Processing Recording for:', {
      callId: callId,
      url: recordingUrl,
      agent: agentName
    });

    try {
      const result = await pool.query(
        `UPDATE calls SET 
          recording_url = $1,
          duration = CASE WHEN $2 > 0 THEN $2 ELSE duration END
         WHERE id = $3`,
        [recordingUrl, parseInt(duration), callId]
      );

      if (result.rowCount === 0) {
        console.log('⚠️ Call not found for recording, inserting:', callId);
        await pool.query(
          `INSERT INTO calls (id, agent, "to", duration, recording_url, status, reason, time)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (id) DO UPDATE SET recording_url = EXCLUDED.recording_url, agent = CASE WHEN calls.agent = 'Unknown Agent' THEN EXCLUDED.agent ELSE calls.agent END`,
          [callId, agentName, req.body.To || req.body.to || '', parseInt(duration), recordingUrl, status, hangupCause]
        );
      }
      console.log('✅ Recording saved for:', callId);
    } catch (err) {
      console.error('❌ Save recording error:', err.message);
    }
  }
  res.sendStatus(200);
});

// ── LOG CALL ──────────────────────────────────────────────────────────────────
app.post('/log-call', async (req, res) => {
  const { to, agent, status, duration } = req.body;
  const callId = 'local_' + Date.now();
  
  try {
    await pool.query(
      'INSERT INTO calls (id, agent, "to", duration, recording_url, status, time) VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (id) DO NOTHING',
      [callId, agent || 'Unknown Agent', to || '', parseInt(duration) || 0, '', status || 'completed']
    );
    res.json({ success: true, id: callId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CALLS ─────────────────────────────────────────────────────────────────────
app.get('/calls', async (req, res) => {
  const { username, role } = req.query;
  try {
    if (role === 'admin' || !username) {
      const { rows } = await pool.query('SELECT id, agent, "to", duration, recording_url, status, reason, time FROM calls ORDER BY time DESC LIMIT 200');
      return res.json(rows.map(r => ({
        id: r.id, agent: r.agent, to: r.to,
        duration: r.duration, recordingUrl: r.recording_url,
        time: r.time, status: r.status, reason: r.reason
      })));
    }
    const { rows: agentRows } = await pool.query(
      'SELECT name FROM agents WHERE username=$1', [username]
    );
    const agentName = agentRows[0]?.name || username;
    const { rows } = await pool.query(
      'SELECT id, agent, "to", duration, recording_url, status, reason, time FROM calls WHERE LOWER(agent)=LOWER($1) ORDER BY time DESC LIMIT 200', [agentName]
    );
    res.json(rows.map(r => ({
      id: r.id, agent: r.agent, to: r.to,
      duration: r.duration, recordingUrl: r.recording_url,
      time: r.time, status: r.status, reason: r.reason
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/status', (req, res) => res.json({ status: 'running' }));

// ── PLAY RECORDING (Authenticated Proxy) ──────────────────────────────────────
app.get('/play-recording', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  
  try {
    const authId = process.env.PLIVO_AUTH_ID;
    const authToken = process.env.PLIVO_AUTH_TOKEN;
    const credentials = Buffer.from(`${authId}:${authToken}`).toString('base64');
    
    console.log('🎵 Proxying recording:', url);
    
    const response = await fetch(decodeURIComponent(url), {
      headers: { 
        'Authorization': `Basic ${credentials}`,
        'Accept': 'audio/mpeg, audio/*'
      }
    });
    
    if (!response.ok) {
      console.error('❌ Recording fetch failed:', response.status);
      return res.status(response.status).json({ error: 'Recording not accessible' });
    }
    
    // Stream the audio back to browser
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    
    // Node built-in fetch response.body is a ReadableStream
    // We can convert it to a Node Readable if needed, but in recent Express/Node
    // we can use standard web stream pipe if supported or conversion.
    // For Node 18+ global fetch:
    const reader = response.body.getReader();
    
    // Helper to pipe Web Stream to Node Writable
    const push = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        res.write(value);
      }
    };
    
    push();
    console.log('✅ Recording streaming started');
    
  } catch (err) {
    console.error('❌ Recording proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
