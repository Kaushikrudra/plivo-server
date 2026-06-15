from pathlib import Path

code = r"""import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import plivo from 'plivo';
import cors from 'cors';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { Readable } from 'stream';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── In-Memory Active Call State Map ───────────────────────────────────────────
const activeCalls = new Map();

// ── MySQL Connection ──────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ── Structured Logger Helper ─────────────────────────────────────────────────
function logEvent(event, callUUID, metadata = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event,
    callUUID,
    ...metadata
  };
  console.log(`[StructuredLog] ${JSON.stringify(logEntry)}`);
}

// ── Initialize Tables ─────────────────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        number VARCHAR(50) DEFAULT '',
        role VARCHAR(50) DEFAULT 'agent',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id VARCHAR(255) PRIMARY KEY,
        agent VARCHAR(255),
        to_number VARCHAR(50),
        duration INT DEFAULT 0,
        recording_url TEXT,
        status VARCHAR(50) DEFAULT 'completed',
        reason TEXT,
        time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS otps (
        username VARCHAR(255) PRIMARY KEY,
        otp VARCHAR(10) NOT NULL,
        expires_at TIMESTAMP NOT NULL
      )
    `);

    const [rows] = await pool.query('SELECT COUNT(*) AS count FROM agents');

    if (Number(rows[0].count) === 0) {
      await pool.query(`
        INSERT IGNORE INTO agents (name, username, password, role) VALUES
        ('Administrator', 'admin', 'Admin@1234', 'admin'),
        ('Agent 1', 'zohoagent170932965467135247620', 'Agent@1234', 'agent')
      `);
      console.log('✅ Default agents inserted');
    }

    console.log('✅ MySQL Database initialized successfully');
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

// ── HEALTH & STATUS ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', time: new Date() }));

app.get('/db-test', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT NOW() AS time');
    res.json({ success: true, db: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/status', (req, res) => {
  const activeList = [];
  const now = new Date();

  for (const [customerCallUUID, callData] of activeCalls.entries()) {
    const durationSeconds = Math.floor((now - callData.callStartTime) / 1000);
    activeList.push({
      customerCallUUID,
      customerNumber: callData.customerNumber,
      conferenceRoom: callData.conferenceRoom,
      agentsCalled: callData.agentsCalled.map(a => ({
        agentName: a.agentName,
        callUUID: a.callUUID,
        status: a.status
      })),
      answeredBy: callData.answeredBy,
      callStartTime: callData.callStartTime.toISOString(),
      durationSeconds
    });
  }

  res.json({ status: 'running', activeCalls: activeList });
});

app.use(express.static(path.join(__dirname, '../public')));

// ── AGENTS & AUTH ─────────────────────────────────────────────────────────────
app.post('/send-otp', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required for OTP' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  try {
    await pool.query(
      `INSERT INTO otps (username, otp, expires_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE otp = VALUES(otp), expires_at = VALUES(expires_at)`,
      [username, otp, expiresAt]
    );

    if (client) {
      const targetNumber = process.env.OTP_TARGET_NUMBER || '+919340284497';
      const sourceNumber = process.env.PLIVO_NUMBER || targetNumber;

      await client.messages.create(
        sourceNumber,
        targetNumber,
        `Your Edwin Calling Solution Admin Verification Code is: ${otp}. Valid for 10 minutes.`
      );
      console.log(`✉️ OTP sent via Plivo to ${targetNumber} for user ${username}`);
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
    const [rows] = await pool.query(
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
    const [rows] = await pool.query(
      'SELECT id, name, username, number, role FROM agents WHERE username = ? AND password = ?',
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

  if (role === 'admin') {
    if (!otp) return res.status(400).json({ error: 'OTP is required for Admin registration' });

    try {
      const [rows] = await pool.query(
        'SELECT otp, expires_at FROM otps WHERE username = ?',
        [username]
      );

      if (rows.length === 0) {
        return res.status(400).json({ error: 'OTP not requested or expired' });
      }

      const storedOtpInfo = rows[0];

      if (new Date() > new Date(storedOtpInfo.expires_at)) {
        await pool.query('DELETE FROM otps WHERE username = ?', [username]);
        return res.status(400).json({ error: 'OTP has expired' });
      }

      if (storedOtpInfo.otp !== otp) {
        return res.status(400).json({ error: 'Invalid OTP' });
      }

      await pool.query('DELETE FROM otps WHERE username = ?', [username]);
    } catch (err) {
      return res.status(500).json({ error: 'Error verifying OTP' });
    }
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO agents (name, username, password, number, role) VALUES (?, ?, ?, ?, ?)',
      [name, username, password, number || '', role || 'agent']
    );

    const [rows] = await pool.query(
      'SELECT id, name, username, number, role FROM agents WHERE id = ?',
      [result.insertId]
    );

    console.log(`👤 New agent created: ${username} (${role || 'agent'})`);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
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
    let result;

    if (password) {
      [result] = await pool.query(
        'UPDATE agents SET name = ?, password = ?, number = ? WHERE username = ?',
        [name, password, number || '', username]
      );
    } else {
      [result] = await pool.query(
        'UPDATE agents SET name = ?, number = ? WHERE username = ?',
        [name, number || '', username]
      );
    }

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Agent not found' });

    const [rows] = await pool.query(
      'SELECT id, name, username, number, role FROM agents WHERE username = ?',
      [username]
    );

    console.log(`✅ Agent updated: ${username}`);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/agents/:username', async (req, res) => {
  const { username } = req.params;

  try {
    const [result] = await pool.query('DELETE FROM agents WHERE username = ?', [username]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Agent not found' });

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
    const [rows] = await pool.query(
      'SELECT username, password, number FROM agents WHERE username = ?',
      [requestedUsername]
    );

    let agent = rows[0];

    if (!agent) {
      const [fallback] = await pool.query(
        'SELECT username, password, number FROM agents WHERE role = ? LIMIT 1',
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
    const [nameOrUserRows] = await pool.query(
      `SELECT name FROM agents
       WHERE LOWER(name) = LOWER(?)
          OR LOWER(username) = LOWER(?)`,
      [inputAgent.trim(), cleanSipUser]
    );

    if (nameOrUserRows.length > 0) {
      return nameOrUserRows[0].name;
    }

    const [numberRows] = await pool.query(
      `SELECT name FROM agents
       WHERE number = ?
          OR (number <> '' AND number LIKE CONCAT('%', ?, '%'))`,
      [inputAgent.trim(), inputAgent.trim()]
    );

    if (numberRows.length > 0) {
      return numberRows[0].name;
    }

    if (callId) {
      const [callRows] = await pool.query('SELECT agent FROM calls WHERE id = ?', [callId]);

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

  const direction = req.body.Direction || req.body.direction || '';
  let to = req.body.To || req.body.to || '';
  const from = req.body.From || req.body.from || '';
  const cleanTo = to.replace(/\D/g, '');
  const cleanPlivoNum = (process.env.PLIVO_NUMBER || '').replace(/\D/g, '');

  const isSipCaller =
    from.toLowerCase().startsWith('sip:') ||
    from.toLowerCase().startsWith('zohoagent') ||
    from.toLowerCase().startsWith('edwinagent');

  const isIncoming =
    !isSipCaller &&
    (direction.toLowerCase() === 'inbound' || (cleanTo === cleanPlivoNum && cleanPlivoNum !== ''));

  if (isIncoming && !dialStatus && event.toLowerCase() !== 'hangup') {
    let protocol = req.headers['x-forwarded-proto'] || req.protocol;
    let host = req.headers['host'] || req.get('host');
    let baseUrl = `${protocol}://${host}`;
    if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

    console.log('🔄 Inbound call detected on /answer. Redirecting to /incoming-call...');
    res.set('Content-Type', 'text/xml');

    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${baseUrl}/incoming-call</Redirect>
</Response>`);
  }

  let inputAgent = req.query.agent || req.body.agent || '';

  if (!inputAgent) {
    const findKey = (obj) => {
      if (!obj) return null;
      for (const key of Object.keys(obj)) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalized.includes('agentname')) return obj[key];
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

  if (dialStatus) {
    console.log('🛑 Dial leg ended. DialStatus:', dialStatus, 'HangupCause:', hangupCause);
    res.set('Content-Type', 'text/xml');
    return res.send('<Response><Hangup/></Response>');
  }

  if (event.toLowerCase() !== 'hangup' && event.toLowerCase() !== 'startapp' && event.toLowerCase() !== 'dialhangup') {
    if (
      callStatus.toLowerCase() === 'cancel' ||
      callStatus.toLowerCase() === 'completed' ||
      dialStatus.toLowerCase() === 'busy' ||
      dialStatus.toLowerCase() === 'cancel' ||
      hangupCause === 'ORIGINATOR_CANCEL' ||
      hangupCause === 'USER_BUSY' ||
      (event.toLowerCase() === 'redirect' &&
        (dialStatus.toLowerCase() === 'busy' || dialStatus.toLowerCase() === 'cancel'))
    ) {
      console.log('🛑 Stopping redial. Event:', event, 'Status:', callStatus, dialStatus);
      res.set('Content-Type', 'text/xml');
      return res.send('<Response><Hangup/></Response>');
    }
  }

  if (event.toLowerCase() === 'hangup' || event.toLowerCase() === 'dialhangup' || callStatus.toLowerCase() === 'completed') {
    let duration = req.body.Duration || req.body.duration || req.body.BillDuration || req.body.DialBillDuration || 0;

    const rawTo =
      req.body.To ||
      req.body.to ||
      req.body['SIP-H-To']?.replace(/<|>/g, '').split(':')[1]?.split('@')[0] ||
      '';

    const cleanNumber = rawTo.replace(/\D/g, '').slice(-10);

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
          `INSERT INTO calls (id, agent, to_number, duration, recording_url, status, reason, time)
           VALUES (?, ?, ?, ?, '', ?, ?, NOW())
           ON DUPLICATE KEY UPDATE
             agent = IF(calls.agent = 'Unknown Agent' OR calls.agent LIKE 'zohoagent%', VALUES(agent), calls.agent),
             duration = IF(VALUES(duration) > 0, VALUES(duration), calls.duration),
             status = VALUES(status),
             reason = VALUES(reason)`,
          [callId, agentName, cleanNumber, parseInt(duration) || 0, finalStatus, hangupCause]
        );

        console.log(`✅ ${event} processed for Call: ${callId}`);
      } catch (err) {
        console.error('❌ Error saving data:', err.message);
      }
    }

    return res.status(200).send('OK');
  }

  to = req.body.To || req.body.to || '';

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
  const callbackUrl = `${baseUrl}/answer?agent=${encodeURIComponent(agentName)}`;

  console.log('🎙️ Recording callback URL:', recordingCallback);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${process.env.PLIVO_NUMBER}"
        action="${actionUrl}"
        callbackUrl="${callbackUrl}"
        callbackMethod="POST"
        answerOnBridge="true"
        hangupOnStar="false"
        timeLimit="14400"
        record="true"
        recordFileFormat="mp3"
        recordingCallbackUrl="${recordingCallback}"
        recordingCallbackMethod="POST">
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
        if (normalized.includes('agentname')) return obj[key];
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
      callId,
      url: recordingUrl,
      agent: agentName
    });

    try {
      const [result] = await pool.query(
        `UPDATE calls SET
          recording_url = ?,
          duration = IF(? > 0, ?, duration)
         WHERE id = ?`,
        [recordingUrl, parseInt(duration) || 0, parseInt(duration) || 0, callId]
      );

      if (result.affectedRows === 0) {
        console.log('⚠️ Call not found for recording, inserting:', callId);

        await pool.query(
          `INSERT INTO calls (id, agent, to_number, duration, recording_url, status, reason, time)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE
             recording_url = VALUES(recording_url),
             agent = IF(calls.agent = 'Unknown Agent', VALUES(agent), calls.agent)`,
          [
            callId,
            agentName,
            req.body.To || req.body.to || '',
            parseInt(duration) || 0,
            recordingUrl,
            status,
            hangupCause
          ]
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
      `INSERT IGNORE INTO calls (id, agent, to_number, duration, recording_url, status, time)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
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
      const [rows] = await pool.query(
        'SELECT id, agent, to_number, duration, recording_url, status, reason, time FROM calls ORDER BY time DESC LIMIT 200'
      );

      return res.json(rows.map(r => ({
        id: r.id,
        agent: r.agent,
        to: r.to_number,
        duration: r.duration,
        recordingUrl: r.recording_url,
        time: r.time,
        status: r.status,
        reason: r.reason
      })));
    }

    const [agentRows] = await pool.query(
      'SELECT name FROM agents WHERE username = ?',
      [username]
    );

    const agentName = agentRows[0]?.name || username;

    const [rows] = await pool.query(
      'SELECT id, agent, to_number, duration, recording_url, status, reason, time FROM calls WHERE LOWER(agent) = LOWER(?) ORDER BY time DESC LIMIT 200',
      [agentName]
    );

    res.json(rows.map(r => ({
      id: r.id,
      agent: r.agent,
      to: r.to_number,
      duration: r.duration,
      recordingUrl: r.recording_url,
      time: r.time,
      status: r.status,
      reason: r.reason
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PLAY RECORDING ────────────────────────────────────────────────────────────
app.get('/play-recording', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  try {
    if (!process.env.PLIVO_AUTH_ID || !process.env.PLIVO_AUTH_TOKEN) {
      return res.status(500).json({ error: 'Plivo credentials are missing in environment variables' });
    }

    const authId = process.env.PLIVO_AUTH_ID;
    const authToken = process.env.PLIVO_AUTH_TOKEN;
    const credentials = Buffer.from(`${authId}:${authToken}`).toString('base64');
    const authHeader = `Basic ${credentials}`;

    const decodedUrl = decodeURIComponent(url);
    console.log('🎵 Proxying recording:', decodedUrl);

    let response = await fetch(decodedUrl, {
      headers: {
        Authorization: authHeader,
        Accept: 'audio/mpeg, audio/*'
      }
    });

    if (response.status === 403) {
      console.log('⚠️ Got 403, attempting to fetch fresh recording URL from Plivo API...');

      let uuid = '';

      try {
        const parts = decodedUrl.split('/Recording/');
        if (parts.length > 1) {
          uuid = parts[1].replace('.mp3', '').split('?')[0];
        }
      } catch (err) {
        console.error('Failed to extract UUID:', err.message);
      }

      if (uuid) {
        const plivoApiUrl = `https://api.plivo.com/v1/Account/${authId}/Recording/${uuid}/`;
        console.log(`🌐 Fetching fresh recording details from: ${plivoApiUrl}`);

        const apiResponse = await fetch(plivoApiUrl, {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json'
          }
        });

        if (apiResponse.status === 404) {
          console.error(`❌ Recording metadata returned 404: ${uuid}`);
          return res.status(404).json({ error: 'Recording no longer available', status: 404 });
        }

        if (apiResponse.ok) {
          const apiData = await apiResponse.json();
          let freshUrl = apiData.recording_url;

          if (freshUrl) {
            freshUrl = freshUrl.replace('api.plivo.com', 'media.plivo.com');
            console.log(`✅ Got fresh recording URL: ${freshUrl}`);

            response = await fetch(freshUrl, {
              headers: {
                Authorization: authHeader,
                Accept: 'audio/mpeg, audio/*'
              }
            });
          }
        } else {
          console.error(`❌ Plivo API fetch failed with status: ${apiResponse.status}`);
        }
      }
    }

    if (!response.ok) {
      console.error('❌ Recording fetch failed:', response.status);
      return res.status(response.status).json({ error: 'Recording not accessible' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    const audioStream = Readable.fromWeb(response.body);

    audioStream.on('error', (err) => {
      console.warn('⚠️ Audio streaming interrupted or closed:', err.message);
    });

    audioStream.pipe(res);
    console.log('✅ Recording streaming started');
  } catch (err) {
    console.error('❌ Recording proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── BROADCAST / HUNT GROUP SIMULTANEOUS DIALING ───────────────────────────────
async function handleNoAgents(customerCallUUID, baseUrl) {
  const callData = activeCalls.get(customerCallUUID);
  if (!callData || callData.isAnswered) return;

  callData.isAnswered = true;

  if (callData.timeoutId) clearTimeout(callData.timeoutId);

  for (const agentCall of callData.agentsCalled) {
    if (agentCall.status === 'ringing') {
      try {
        logEvent('agent_call_cancel', customerCallUUID, {
          agentName: agentCall.agentName,
          agentCallUUID: agentCall.callUUID
        });

        if (client) await client.calls.hangup(agentCall.callUUID);

        agentCall.status = 'cancelled';
      } catch (err) {
        console.error(`Failed to cancel agent call ${agentCall.callUUID}:`, err.message);
      }
    }
  }

  if (client) {
    try {
      logEvent('customer_redirect_fallback', customerCallUUID, {
        reason: 'No agents answered within 30s'
      });

      await client.calls.transfer(customerCallUUID, {
        aleg_url: `${baseUrl}/fallback/${customerCallUUID}`,
        aleg_method: 'POST'
      });
    } catch (err) {
      console.error(`Failed to redirect customer call ${customerCallUUID}:`, err.message);
    }
  }
}

// 1. Incoming Call Webhook
app.post('/incoming-call', async (req, res) => {
  const customerCallUUID = req.body.CallUUID;
  const customerNumber = req.body.From || req.body.CallerName || 'Unknown';
  const conferenceRoom = `conf_${customerCallUUID}`;

  logEvent('incoming_call', customerCallUUID, { customerNumber, conferenceRoom });

  let agentRows = [];

  try {
    const [rows] = await pool.query(
      "SELECT name, number FROM agents WHERE role = 'agent' AND number <> ''"
    );
    agentRows = rows;
  } catch (err) {
    console.error('❌ Failed to fetch agents for broadcast:', err.message);
  }

  let protocol = req.headers['x-forwarded-proto'] || req.protocol;
  let host = req.headers['host'] || req.get('host');
  let baseUrl = `${protocol}://${host}`;
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  const callData = {
    customerNumber,
    conferenceRoom,
    agentsCalled: [],
    answeredBy: null,
    callStartTime: new Date(),
    isAnswered: false,
    timeoutId: null
  };

  activeCalls.set(customerCallUUID, callData);

  callData.timeoutId = setTimeout(async () => {
    await handleNoAgents(customerCallUUID, baseUrl);
  }, 30000);

  if (client) {
    for (const agent of agentRows) {
      try {
        logEvent('agent_dial_start', customerCallUUID, {
          agentName: agent.name,
          number: agent.number
        });

        const agentCall = await client.calls.create(
          process.env.PLIVO_NUMBER,
          agent.number,
          `${baseUrl}/agent-answer/${customerCallUUID}?agentName=${encodeURIComponent(agent.name)}`,
          {
            answerMethod: 'POST',
            ringTimeout: 30
          }
        );

        const callUuid = agentCall.requestUuid || agentCall.callUuid;

        callData.agentsCalled.push({
          agentName: agent.name,
          callUUID: callUuid,
          status: 'ringing'
        });

        logEvent('agent_dial_success', customerCallUUID, {
          agentName: agent.name,
          agentCallUUID: callUuid
        });
      } catch (err) {
        console.error(`⚠️ Failed to dial agent ${agent.name} (${agent.number}):`, err.message);
        logEvent('agent_dial_failed', customerCallUUID, {
          agentName: agent.name,
          error: err.message
        });
      }
    }
  } else {
    console.warn('⚠️ Plivo client not configured; simulated hunt group.');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Please wait while we connect you to an agent.</Speak>
  <Conference redirect="false">${conferenceRoom}</Conference>
</Response>`;

  res.set('Content-Type', 'text/xml').send(xml);
});

// 2. Agent Answer Webhook
app.post('/agent-answer/:customerCallUUID', async (req, res) => {
  const customerCallUUID = req.params.customerCallUUID;
  const agentName = req.query.agentName || 'Agent';
  const agentCallUUID = req.body.CallUUID;

  const callData = activeCalls.get(customerCallUUID);

  if (!callData) {
    logEvent('agent_answer_rejected', customerCallUUID, {
      agentName,
      reason: 'Call structure not found'
    });

    res.set('Content-Type', 'text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  if (callData.isAnswered) {
    logEvent('agent_answer_race_lost', customerCallUUID, {
      agentName,
      reason: 'Call already answered by another agent'
    });

    res.set('Content-Type', 'text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  callData.isAnswered = true;
  callData.answeredBy = agentName;

  if (callData.timeoutId) clearTimeout(callData.timeoutId);

  logEvent('agent_answer_race_won', customerCallUUID, { agentName, agentCallUUID });

  for (const agentCall of callData.agentsCalled) {
    if (agentCall.agentName === agentName) {
      agentCall.status = 'answered';
    } else if (agentCall.status === 'ringing') {
      try {
        logEvent('agent_call_cancel', customerCallUUID, {
          agentName: agentCall.agentName,
          agentCallUUID: agentCall.callUUID
        });

        if (client) await client.calls.hangup(agentCall.callUUID);

        agentCall.status = 'cancelled';
      } catch (err) {
        console.error(`Failed to hangup agent call ${agentCall.callUUID}:`, err.message);
      }
    }
  }

  try {
    await pool.query(
      `INSERT INTO calls (id, agent, to_number, duration, recording_url, status, reason, time)
       VALUES (?, ?, ?, 0, '', 'completed', 'Connected', NOW())
       ON DUPLICATE KEY UPDATE
         agent = VALUES(agent),
         status = VALUES(status),
         reason = VALUES(reason)`,
      [customerCallUUID, agentName, callData.customerNumber]
    );
  } catch (err) {
    console.error('❌ Failed to log call answer to database:', err.message);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Conference redirect="true" action="/agent-hangup/${customerCallUUID}?agentName=${encodeURIComponent(agentName)}">${callData.conferenceRoom}</Conference>
</Response>`;

  res.set('Content-Type', 'text/xml').send(xml);
});

// 3. Fallback Route
app.post('/fallback/:customerCallUUID', (req, res) => {
  const customerCallUUID = req.params.customerCallUUID;
  logEvent('fallback_screen', customerCallUUID, { message: 'Playing voicemail announcement' });

  let protocol = req.headers['x-forwarded-proto'] || req.protocol;
  let host = req.headers['host'] || req.get('host');
  let baseUrl = `${protocol}://${host}`;
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>All our agents are currently busy. Please leave your message after the tone.</Speak>
  <Record action="${baseUrl}/voicemail-callback?customerCallUUID=${encodeURIComponent(customerCallUUID)}" maxLength="120" playBeep="true" />
</Response>`;

  res.set('Content-Type', 'text/xml').send(xml);
});

// 4. Voicemail Callback
app.post('/voicemail-callback', async (req, res) => {
  const customerCallUUID = req.query.customerCallUUID;
  const recordingUrl = req.body.RecordUrl || req.body.RecordingUrl || '';
  const duration = req.body.RecordingDuration || 0;

  logEvent('voicemail_received', customerCallUUID, { recordingUrl, duration });

  try {
    const callData = activeCalls.get(customerCallUUID);
    const customerNumber = callData ? callData.customerNumber : 'Unknown';

    await pool.query(
      `INSERT INTO calls (id, agent, to_number, duration, recording_url, status, reason, time)
       VALUES (?, 'Voicemail', ?, ?, ?, 'voicemail', 'Voicemail Left', NOW())
       ON DUPLICATE KEY UPDATE
         recording_url = VALUES(recording_url),
         status = 'voicemail'`,
      [customerCallUUID, customerNumber, parseInt(duration) || 0, recordingUrl]
    );
  } catch (err) {
    console.error('❌ Failed to save voicemail to database:', err.message);
  }

  activeCalls.delete(customerCallUUID);
  res.sendStatus(200);
});

// 5. Agent Hangup Webhook
app.post('/agent-hangup/:customerCallUUID', (req, res) => {
  const customerCallUUID = req.params.customerCallUUID;
  const agentName = req.query.agentName || 'Agent';

  logEvent('agent_hangup', customerCallUUID, { agentName });

  activeCalls.delete(customerCallUUID);

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
});

// ── FALLBACK ──────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await initDB();
});
"""

path = Path("/mnt/data/server.mysql.js")
path.write_text(code, encoding="utf-8")
print(f"Created {path}")
