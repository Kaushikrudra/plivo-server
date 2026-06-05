import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import plivo from 'plivo';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const client = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

// Persistence for Agents and Calls
const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); // FIXED: recursive added

const CALLS_FILE = path.join(DATA_DIR, 'calls.json');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');

const loadData = (file, defaultValue) => {
  if (!fs.existsSync(file)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return defaultValue;
  }
};

const saveData = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

let callHistory = loadData(CALLS_FILE, []);
let agents = loadData(AGENTS_FILE, [
  { name: 'Administrator', username: 'admin', password: 'Admin@1234', role: 'admin' },
  { name: 'Agent 1', username: 'zohoagent170932965467135247620', password: 'Agent@1234', role: 'agent' }
]);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the React build folder or public folder
const distPath = path.join(__dirname, '../dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
} else {
  app.use(express.static(path.join(__dirname, '../public')));
}

// Agent Endpoints
app.get('/agents', (req, res) => {
  const safeAgents = agents.map(({ password, ...rest }) => rest);
  res.json(safeAgents);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const agent = agents.find((a) => a.username === username && a.password === password);
  if (agent) {
    const { password, ...safeAgent } = agent;
    res.json({ success: true, agent: safeAgent });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/agents', (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  const newAgent = { name, username, password, role: 'agent' };
  agents.push(newAgent);
  saveData(AGENTS_FILE, agents);
  res.json(newAgent);
});

app.delete('/agents/:username', (req, res) => {
  const { username } = req.params;
  const initialLength = agents.length;
  agents = agents.filter((agent) => agent.username !== username);
  if (agents.length === initialLength) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  saveData(AGENTS_FILE, agents);
  res.json({ success: true });
});

app.get('/token', (req, res) => {
  const requestedUsername = req.query.username;
  const credentials = agents.find((agent) => agent.username === requestedUsername) || agents[0];
  res.json({
    username: credentials.username,
    password: credentials.password
  });
});

app.post('/answer', (req, res) => {
  let to = req.body.To || req.body.to;
  const agentName = req.body['X-PH-AgentName'] || 'Agent';
  
  let isSip = false;
  if (to) {
    if (to.startsWith('sip:') || to.includes('@') || to.startsWith('zohoagent')) {
      isSip = true;
      if (!to.startsWith('sip:')) {
        if (!to.includes('@')) {
          to = `sip:${to}@phone.plivo.com`;
        } else {
          to = `sip:${to}`;
        }
      }
    } else {
      const hasPlus = to.startsWith('+');
      const digits = to.replace(/\D/g, '');
      if (hasPlus) {
        to = '+' + digits;
      } else if (digits.length === 10) {
        to = '+91' + digits;
      } else {
        to = '+' + digits;
      }
    }
  }

  const dialElement = isSip ? `<User>${to}</User>` : `<Number>${to}</Number>`;
  
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record action="${process.env.RENDER_URL}/recording?agent=${encodeURIComponent(agentName)}" startOnDialAnswer="true" redirect="false" maxLength="3600"/>
  <Dial callerId="${process.env.PLIVO_NUMBER}">
    ${dialElement}
  </Dial>
</Response>`;

  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

// FIXED: Recording callback — handles all Plivo field name formats
app.post('/recording', (req, res) => {
  console.log('Recording callback received:', JSON.stringify(req.body));

  const agentName = req.query.agent
    || req.body.CallerName
    || req.body.caller_name
    || 'Unknown Agent';

  const newCall = {
    id:           req.body.CallUUID          || req.body.call_uuid          || 'call_' + Date.now(),
    agent:        agentName,
    to:           req.body.To                || req.body.to                 || '',
    duration:     req.body.RecordingDuration || req.body.recording_duration || '0',
    recordingUrl: req.body.RecordUrl         || req.body.record_url         || '',
    time:         new Date().toISOString(),
    status:       'completed'
  };

  console.log('Saving call record:', JSON.stringify(newCall));
  callHistory.push(newCall);
  saveData(CALLS_FILE, callHistory);
  res.sendStatus(200);
});

app.get('/calls', (req, res) => {
  const { username, role } = req.query;
  if (role === 'admin' || !username) {
    return res.json(callHistory);
  }
  const agent = agents.find((a) => a.username === username);
  const agentName = agent ? agent.name : username;
  const filteredHistory = callHistory.filter(
    (call) => call.agent && call.agent.toLowerCase() === agentName.toLowerCase()
  );
  res.json(filteredHistory);
});

app.post('/log-call', (req, res) => {
  const { to, agent, status, duration } = req.body;
  const newCall = {
    id: 'local_' + Date.now(),
    agent: agent || 'Unknown Agent',
    to: to || 'Unknown',
    duration: duration || 0,
    time: new Date().toISOString(),
    status: status || 'completed'
  };
  callHistory.push(newCall);
  saveData(CALLS_FILE, callHistory);
  res.json({ success: true, call: newCall });
});

app.post('/hangup-call', async (req, res) => {
  const { uuid } = req.body;
  if (!uuid) {
    return res.status(400).json({ error: 'uuid is required' });
  }
  try {
    await client.calls.hangup(uuid);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/status', (req, res) => {
  res.json({ status: 'running' });
});

// Fallback for React Router
app.use((req, res) => {
  const distIndex = path.join(__dirname, '../dist/index.html');
  if (fs.existsSync(distIndex)) {
    res.sendFile(distIndex);
  } else {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
