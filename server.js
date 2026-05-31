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

  // Number clean karo — sirf digits
  let cleanNumber = to.replace(/\D/g, '');
  
  // India code add karo if missing
  if (cleanNumber.length === 10) {
    cleanNumber = '91' + cleanNumber;
  } else if (cleanNumber.startsWith('0')) {
    cleanNumber = '91' + cleanNumber.slice(1);
  }

  console.log(`Calling: ${cleanNumber} from ${process.env.PLIVO_NUMBER}`);

  try {
    const response = await client.calls.create(
      process.env.PLIVO_NUMBER,
      cleanNumber,
      `${process.env.RENDER_URL}/answer`
    );
    res.json({ success: true, uuid: response.requestUuid });
  } catch (err) {
    console.error('Call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Plivo answer URL — sirf connected rakho
app.post('/answer', (req, res) => {
  console.log('Answer webhook hit:', req.body);
  const response = new plivo.Response();
  response.addSpeak('Please wait, connecting your call.');
  response.addWait({ length: 60 });
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







