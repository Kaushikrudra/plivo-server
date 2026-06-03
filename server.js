const path = require('path');
const express = require('express');
const plivo = require('plivo');
const cors = require('cors');
require('dotenv').config();

const app = express();
const client = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);
const callHistory = [];

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const endpointCredentials = [
  {
    username: process.env.PLIVO_ENDPOINT_USERNAME,
    password: process.env.PLIVO_ENDPOINT_PASSWORD
  }
];

app.get('/token', (req, res) => {
  const requestedUsername = req.query.username;
  const credentials = requestedUsername
    ? endpointCredentials.find((endpoint) => endpoint.username === requestedUsername) || endpointCredentials[0]
    : endpointCredentials[0];

  res.json(credentials);
});

// app.post('/answer', (req, res) => {
//   const to = req.body.To || req.body.to;
//   const xml = `<?xml version="1.0" encoding="UTF-8"?>
// <Response>
//   <Record action="${process.env.RENDER_URL}/recording" startOnDialAnswer="true" redirect="false" maxLength="3600"/>
//   <Dial callerId="${process.env.PLIVO_NUMBER}">
//     <Number>${to || ''}</Number>
//   </Dial>
// </Response>`;

//   res.type('text/xml').send(xml);
// });

// app.post('/recording', (req, res) => {
//   console.log('Recording callback:', req.body);
//   res.sendStatus(200);
// });




app.post('/answer', (req, res) => {
  let to = req.body.To || req.body.to;
  
  // Auto-add India country code if missing
  if (to && !to.startsWith('+')) {
    to = '+91' + to;
  }
  
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record action="${process.env.RENDER_URL}/recording" startOnDialAnswer="true" redirect="false" maxLength="3600"/>
  <Dial callerId="${process.env.PLIVO_NUMBER}">
    <Number>${to}</Number>
  </Dial>
</Response>`;

  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

app.post('/recording', (req, res) => {
  console.log('Recording callback:', req.body);
  callHistory.push({
    id: req.body.CallUUID,
    agent: req.body.CallerName,
    to: req.body.To,
    duration: req.body.RecordingDuration,
    recordingUrl: req.body.RecordUrl,
    time: new Date().toISOString(),
    status: 'completed'
  });
  res.sendStatus(200);
});

app.get('/calls', (req, res) => {
  res.json(callHistory);
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
