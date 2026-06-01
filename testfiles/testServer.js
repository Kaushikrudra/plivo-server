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

app.get('/status', (req, res) => {
  res.json({ status: 'Plivo CRM Server Running' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Browser SDK token
app.get('/token', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const payload = {
      iss: process.env.PLIVO_AUTH_ID,
      sub: process.env.PLIVO_ENDPOINT_USERNAME,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    };
    const token = jwt.sign(payload, process.env.PLIVO_AUTH_TOKEN);
    res.json({ 
      token, 
      username: process.env.PLIVO_ENDPOINT_USERNAME,
      password: process.env.PLIVO_ENDPOINT_PASSWORD
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// // Answer URL — Browser SDK call ke liye
// app.post('/answer', (req, res) => {
//   console.log('Answer hit:', req.body);
//   const to = req.body.To || req.body.to;
//   const response = new plivo.Response();
//   if (to) {
//     const dial = response.addDial({ callerId: process.env.PLIVO_NUMBER });
//     dial.addNumber(to);
//   } else {
//     response.addSpeak('No destination number found.');
//   }
//   res.set('Content-Type', 'text/xml');
//   res.send(response.toXML());
// });



app.post('/answer', (req, res) => {
  console.log('Answer hit:', req.body);
  const to = req.body.To || req.body.to;
  console.log('Calling to:', to);
  const response = new plivo.Response();
  if (to && to !== 'undefined') {
    response.addRecord({
      action: `${process.env.RENDER_URL}/recording`,
      startOnDialAnswer: true,
      redirect: false
    });
    const dial = response.addDial({ 
      callerId: process.env.PLIVO_NUMBER
    });
    dial.addNumber(to);
  } else {
    response.addSpeak('No destination number found.');
  }
  res.set('Content-Type', 'text/xml');
  res.send(response.toXML());
});


// Recording callback
app.post('/recording', (req, res) => {
  console.log('Recording:', req.body);
  res.sendStatus(200);
});

// Hangup
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




/* 







*/











