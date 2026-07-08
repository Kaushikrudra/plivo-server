# 📞 Edwin Calling Solution (Zoho Plivo Calls)

A professional, enterprise-grade **Multi-Agent Calling Dashboard** built with Node.js, Express, PostgreSQL, and the Plivo Voice/Browser WebRTC SDK. It features real-time outbound call dialing, inbound simultaneous ring orchestration (Sim-Ring), agent/team presence management, call recording playback, and visual analytics.

---

## 🏗️ Project Architecture & Call Flow

The dashboard handles inbound calls by routing them dynamically to all online agents using a Plivo conference bridge. For outbound calls, it uses Plivo's WebRTC browser SDK with secure SIP tokens.

```mermaid
sequenceDiagram
    actor Customer as 📞 Customer
    participant Plivo as 🌐 Plivo Voice API
    participant Server as 🖥️ Express Backend
    database DB as 🗄️ PostgreSQL
    actor Agent as 🧑‍💼 Online Agents

    %% Inbound Call Flow
    note over Customer, Plivo: Inbound Call Flow
    Customer ->> Plivo: Dials Plivo Number
    Plivo ->> Server: POST /incoming-call (Webhook)
    Server ->> DB: Query Active Online Agents
    DB -->> Server: List of Agent Numbers / SIP URIs
    Server ->> Plivo: Respond with Plivo XML <Conference> & Initiate Sim-Ring
    Plivo ->> Agent: Ring all online agents simultaneously
    Agent -->> Plivo: Agent answers call
    Plivo ->> Server: POST /agent-answer (Webhook)
    Server ->> Plivo: XML connects Agent to Conference
    Plivo ->> Plivo: Hang up remaining ringing agents
    Plivo ->> Plivo: Record Call Session

    %% Hangup & Log Flow
    note over Customer, Agent: Call End & Logging Flow
    Agent ->> Plivo: Hangs up call
    Plivo ->> Server: POST /recording (Webhook with Recording URL)
    Server ->> DB: INSERT INTO calls (duration, status, recording_url)
    Server -->> Agent: UI automatically updates logs & analytics
```

---

## ⚡ Core Features

- **Agent WebRTC Workspace**: Modern client portal with agent login, real-time connection status (`Ready`, `Connecting`, `Calling`, `Connected`, `Error`), inline dialer keypad, mute/unmute control, active call timers, and localized mic checking.
- **Admin Dashboard**: Overview metrics (Total Calls, Active Agents, Success Rate, Talk Time), call volume trend charts (using ApexCharts), and agent credential creation/deletion.
- **Inbound Sim-Ring Orchestration**: Connects incoming customer calls to a conference room, ringing all online agents simultaneously (Simultaneous Ringing). The first agent to pick up is connected, and the rest are cancelled.
- **Call Logging & Recording**: Automatically records conversations and logs details (recipient, duration, final SIP hangup status reason, timestamp, audio file) to a PostgreSQL database, with play/pause stream support.
- **OTP Verification**: Secure Administrator registration powered by Plivo SMS notification codes.

---

## 🛠️ Technology Stack

| Layer | Technologies |
|---|---|
| **Frontend** | HTML5, JavaScript (ES6), Tailwind CSS (via CDN), ApexCharts, Plivo WebRTC Browser SDK |
| **Backend** | Node.js, Express.js, CORS, Nodemon |
| **Database** | PostgreSQL (`pg` Driver) |
| **Integrations** | Plivo Voice API (XML / Helper SDK), Plivo SMS API (for OTPs) |

---

## 🗄️ Database Schema

The database consists of three tables automatically initialized on server startup (`initDB()`):

### 1. `agents` Table
Stores agent profiles, SIP tokens, and roles.
```sql
CREATE TABLE agents (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    username VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    number VARCHAR(255) DEFAULT '',
    role VARCHAR(50) DEFAULT 'agent',
    created_at TIMESTAMP DEFAULT NOW()
);
```

### 2. `calls` Table
Logs call history details, duration, recording URLs, and hangup causes.
```sql
CREATE TABLE calls (
    id VARCHAR(255) PRIMARY KEY,
    agent VARCHAR(255),
    "to" VARCHAR(50),
    duration INTEGER DEFAULT 0,
    recording_url TEXT DEFAULT '',
    status VARCHAR(50) DEFAULT 'completed',
    reason TEXT DEFAULT '',
    time TIMESTAMP DEFAULT NOW()
);
```

### 3. `otps` Table
Handles verification codes during admin registration.
```sql
CREATE TABLE otps (
    username VARCHAR(255) PRIMARY KEY,
    otp VARCHAR(10) NOT NULL,
    expires_at TIMESTAMP NOT NULL
);
```

---

## ⚙️ Configuration & Environment Setup

Create a `.env` file in the root directory:

```env
PORT=3000
DATABASE_URL=postgresql://<username>:<password>@<host>:<port>/<dbname>?sslmode=require
PLIVO_AUTH_ID=your_plivo_auth_id
PLIVO_AUTH_TOKEN=your_plivo_auth_token
PLIVO_NUMBER=your_plivo_outbound_caller_id
RENDER_URL=https://your-server.onrender.com # Used for Plivo webhook callbacks
PLIVO_ENDPOINT_USERNAME=fallback_sip_username
PLIVO_ENDPOINT_PASSWORD=fallback_sip_password
```

---

## 🚀 Installation & Running

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Express Backend & Static Frontend
The server runs on port `3000` and automatically mounts the static client from the `public` directory:
```bash
npm run server
```

### 3. (Optional) Run with Vite Hot-Reloading
If you are developing/modifying components under a Vite server structure:
```bash
npm start
```
*Note: Make sure your `src` directory paths are properly aligned if utilizing `vite` commands.*

---

## 🔌 API Endpoints Reference

### 🔐 Authentication & Agents
- **`POST /send-otp`**: Generates a 6-digit OTP code, stores it in `otps`, and sends it via Plivo SMS.
- **`POST /login`**: Validates agent/admin credentials against the database.
- **`GET /agents`**: Fetches details for all registered agents.
- **`POST /agents`**: Registers a new agent profile (Admin only).
- **`DELETE /agents/:username`**: Deletes an agent profile (Admin only).
- **`GET /token`**: Generates a temporary SIP user credential for Plivo WebRTC registration.

### 📞 Call Flow Webhooks
- **`POST /incoming-call`**: Triggered by Plivo when a customer dials the company number. Rings all active agents and sets up a conference bridge.
- **`POST /agent-answer/:customerCallUUID`**: Instructs Plivo to add the answering agent into the conference room.
- **`POST /agent-hangup/:customerCallUUID`**: Handles call teardown, clean up, and initiates hangup of all related SIP channels.
- **`POST /fallback/:customerCallUUID`**: Handles backup behaviors if call setup fails.
- **`POST /voicemail-callback`**: Handles voicemail recordings when no agent is online or available.

### 📝 Logs & Recordings
- **`POST /log-call`**: Logs manually completed calls or WebRTC direct dials.
- **`GET /calls`**: Fetches historical call records with filters for number, agent, and date.
- **`GET /play-recording`**: Streams raw Plivo call recording MP3s.
- **`GET /local-recording/:callId`**: Proxies downloaded local recording files.

---

## 📁 Project Structure

```
├── backup/                 # Server and agent configurations backup
├── check_db.js             # Diagnostic utility to verify Postgres DB status
├── dist/                   # Production build directory
├── public/                 # Static web client directory
│   └── index.html          # Core Single-Page WebRTC Application
├── server/
│   └── server.js           # Core Express web server, DB routines, & Plivo SDK routing
├── .env                    # Environment variables (git-ignored)
├── package.json            # Node project configuration and dependencies
├── tailwind.config.js      # Tailwind style guidelines config
└── tsconfig.json           # TS compiling configurations
```

---

## 🤝 Contributing & Maintenance

1. **Database Testing**: Use `node check_db.js` to ensure the PostgreSQL connection is sound.
2. **Microphone Permissions**: WebRTC requires HTTPS or `localhost` to access browser media devices. For staging servers, make sure SSL is fully configured.
3. **Plivo Callback Configuration**: Point your Plivo Application's XML URL settings to the `/incoming-call` endpoint of your `RENDER_URL`.
