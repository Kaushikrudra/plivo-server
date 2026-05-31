const express = require('express');
const plivo = require('plivo');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const client = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

app.get('/', (req, res) => {
  res.json({ status: 'Plivo CRM Server Running' });
});

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

app.post('/answer', (req, res) => {
  const response = new plivo.Response();
  response.addSpeak('Connecting your call, please wait.');
  const dial = response.addDial();
  dial.addNumber(req.body.To);
  res.set('Content-Type', 'text/xml');
  res.send(response.toXML());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));