const express = require('express');
const plivo = require('plivo');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const client = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

// Health check
app.get('/status', (req, res) => {
  res.json({ status: 'Plivo CRM Server Running' });
});

// Softphone UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Outbound call
app.post('/make-call', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Number required' });
  try {
    const response = await client.calls.create(
      process.env.PLIVO_NUMBER,
      to,
      `${process.env.RENDER_URL}/answer`
    );
    res.json({ success: true, uuid: response.requestUuid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Plivo answer URL
app.post('/answer', (req, res) => {
  const response = new plivo.Response();
  response.addSpeak('Connecting your call, please wait.');
  const dial = response.addDial();
  dial.addNumber(req.body.To);
  res.set('Content-Type', 'text/xml');
  res.send(response.toXML());
});

// Hangup call
app.post('/hangup-call', async (req, res) => {
  const { uuid } = req.body;
  if (!uuid) return res.status(400).json({ error: 'UUID required' });
  try {
    await client.calls.hangup(uuid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));