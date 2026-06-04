import React, { useState, useEffect, useRef } from 'react';
import { Phone, Users, History, LayoutDashboard, Settings, LogOut, PhoneOff, Mic, MicOff, AlertCircle, Plus, Trash2, UserPlus, Search, RefreshCw } from 'lucide-react';
import axios from 'axios';

// Constants
const SERVER = window.location.origin.includes('localhost:5173') || window.location.origin.includes('127.0.0.1:5173')
  ? 'http://localhost:3000'
  : (window.location.origin.startsWith('file') ? 'http://localhost:3000' : window.location.origin);

declare global {
  interface Window {
    Plivo: any;
  }
}

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loggedInAgent, setLoggedInAgent] = useState<any>(null);
  const [loginForm, setLoginForm] = useState({ agentId: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [availableAgents, setAvailableAgents] = useState<any[]>([]);

  const [activeView, setActiveView] = useState('dashboard');
  const [plivoReady, setPlivoReady] = useState(false);
  const [callStatus, setCallStatus] = useState('Connecting');
  const [isCalling, setIsCalling] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [dialNumber, setDialNumber] = useState('');
  const [timer, setTimer] = useState(0);
  const [history, setHistory] = useState<any[]>([]);

  const plivoBrowserSdk = useRef<any>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const timerInterval = useRef<any>(null);
  const callDurationRef = useRef<number>(0);
  const currentDialNumberRef = useRef<string>('');
  
  const displayHistory = loggedInAgent && loggedInAgent.role === 'admin'
    ? history
    : history.filter(c => c.agent && c.agent.toLowerCase() === loggedInAgent?.name.toLowerCase());

  const totalDuration = displayHistory.reduce((sum, call) => sum + (call.duration || 0), 0);
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };
  const completedCalls = displayHistory.filter(call => call.status === 'completed').length;
  const successRate = displayHistory.length > 0 ? Math.round((completedCalls / displayHistory.length) * 100) : 0;

  // Fetch agents for login and management
  const fetchAgents = async () => {
    try {
      const response = await axios.get(`${SERVER}/agents`);
      setAvailableAgents(response.data);
    } catch (error) {
      console.error('Fetch Agents Error:', error);
    }
  };

  const handleDeleteAgent = async (username: string) => {
    if (!window.confirm(`Are you sure you want to delete agent '${username}'?`)) return;
    try {
      await axios.delete(`${SERVER}/agents/${username}`);
      fetchAgents();
    } catch (err: any) {
      console.error('Delete Agent Error:', err);
      alert(err.response?.data?.error || 'Failed to delete agent');
    }
  };

  useEffect(() => {
    fetchAgents();
    const savedAgent = localStorage.getItem('loggedInAgent');
    if (savedAgent) {
      const agent = JSON.parse(savedAgent);
      setLoggedInAgent(agent);
      setIsLoggedIn(true);
      if (agent.role === 'admin') {
        setActiveView('dashboard');
      } else {
        initPlivo(agent);
      }
    }
  }, []);

  useEffect(() => {
    if (loggedInAgent) {
      fetchHistory();
    }
  }, [loggedInAgent]);

  // Initialize Plivo
  const initPlivo = async (agent: any) => {
    try {
      setCallStatus('Connecting');
      const response = await axios.get(`${SERVER}/token?username=${agent.username}`);
      const credentials = response.data;

      plivoBrowserSdk.current = new window.Plivo({
        debug: 'ALL',
        permOnClick: true,
        enableTracking: true,
        audioConstraints: { echoCancellation: true, noiseSuppression: true },
        remoteAudioElement: remoteAudioRef.current
      });

      plivoBrowserSdk.current.client.on('onLogin', () => {
        setPlivoReady(true);
        setCallStatus('Ready');
      });

      plivoBrowserSdk.current.client.on('onLoginFailed', () => {
        setPlivoReady(false);
        setCallStatus('Error');
      });

      plivoBrowserSdk.current.client.on('onCalling', () => {
        setIsCalling(true);
        setCallStatus('Calling');
      });

      plivoBrowserSdk.current.client.on('onCallAnswered', () => {
        setCallStatus('Connected');
        startTimer();
      });

      plivoBrowserSdk.current.client.on('onCallTerminated', () => {
        const finalDuration = callDurationRef.current;
        const dialedNum = currentDialNumberRef.current;

        setCallStatus('Ready');
        resetCallState();

        if (dialedNum) {
          axios.post(`${SERVER}/log-call`, {
            to: dialedNum,
            agent: agent?.name || 'Unknown Agent',
            duration: finalDuration,
            status: 'completed'
          }).then(() => {
            fetchHistory();
            currentDialNumberRef.current = '';
          }).catch(err => {
            console.error('Log Call Error:', err);
            fetchHistory();
          });
        } else {
          fetchHistory();
        }
      });

      plivoBrowserSdk.current.client.on('onCallFailed', () => {
        const dialedNum = currentDialNumberRef.current;
        setCallStatus('Error');
        resetCallState();

        if (dialedNum) {
          axios.post(`${SERVER}/log-call`, {
            to: dialedNum,
            agent: agent?.name || 'Unknown Agent',
            duration: 0,
            status: 'failed'
          }).then(() => {
            fetchHistory();
            currentDialNumberRef.current = '';
          }).catch(err => {
            console.error('Log Call Error:', err);
            fetchHistory();
          });
        }
      });

      plivoBrowserSdk.current.client.login(credentials.username, credentials.password);
    } catch (error) {
      console.error('Plivo Init Error:', error);
      setCallStatus('Error');
    }
  };

  const startTimer = () => {
    setTimer(0);
    callDurationRef.current = 0;
    timerInterval.current = setInterval(() => {
      setTimer(prev => {
        const next = prev + 1;
        callDurationRef.current = next;
        return next;
      });
    }, 1000);
  };

  const stopTimer = () => {
    if (timerInterval.current) clearInterval(timerInterval.current);
    setTimer(0);
    callDurationRef.current = 0;
  };

  const resetCallState = () => {
    setIsCalling(false);
    setIsMuted(false);
    stopTimer();
  };

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const username = loginForm.agentId.trim();
    const password = loginForm.password.trim();
    try {
      const response = await axios.post(`${SERVER}/login`, { username, password });
      const agent = response.data.agent;
      setLoggedInAgent(agent);
      setIsLoggedIn(true);
      setLoginError('');
      localStorage.setItem('loggedInAgent', JSON.stringify(agent));
      
      if (agent.role === 'admin') {
        setActiveView('dashboard');
      } else {
        initPlivo(agent);
      }
    } catch (error: any) {
      setLoginError(error.response?.data?.error || 'Invalid credentials');
    }
  };

  const handleLogout = () => {
    if (plivoBrowserSdk.current) plivoBrowserSdk.current.client.logout();
    localStorage.removeItem('loggedInAgent');
    setIsLoggedIn(false);
    setLoggedInAgent(null);
    setActiveView('dashboard');
    resetCallState();
  };

  const fetchHistory = async () => {
    let user = loggedInAgent;
    if (!user) {
      const saved = localStorage.getItem('loggedInAgent');
      if (saved) user = JSON.parse(saved);
    }
    if (!user) return;
    try {
      const response = await axios.get(`${SERVER}/calls?username=${encodeURIComponent(user.username)}&role=${encodeURIComponent(user.role)}`);
      setHistory(response.data);
    } catch (error) {
      console.error('Fetch History Error:', error);
    }
  };

  const makeCall = () => {
    if (plivoBrowserSdk.current && dialNumber) {
      currentDialNumberRef.current = dialNumber;
      const extraHeaders = {
        'X-PH-AgentName': loggedInAgent?.name || 'Agent'
      };
      plivoBrowserSdk.current.client.call(dialNumber, extraHeaders);
    }
  };

  const hangupCall = () => {
    if (plivoBrowserSdk.current) {
      plivoBrowserSdk.current.client.hangup();
    }
  };

  const toggleMute = () => {
    if (plivoBrowserSdk.current) {
      if (isMuted) plivoBrowserSdk.current.client.unmute();
      else plivoBrowserSdk.current.client.mute();
      setIsMuted(!isMuted);
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl p-8">
          <div className="flex justify-center mb-6">
            <div className="bg-blue-600 p-3 rounded-xl text-white">
              <Phone size={32} />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-center text-slate-800 mb-8">Agent Login</h2>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Username / Agent ID</label>
              <input 
                type="text"
                required
                className="w-full px-4 py-3 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                value={loginForm.agentId}
                onChange={(e) => setLoginForm({...loginForm, agentId: e.target.value})}
                placeholder="Enter username..."
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input 
                type="password" 
                required
                className="w-full px-4 py-3 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                value={loginForm.password}
                onChange={(e) => setLoginForm({...loginForm, password: e.target.value})}
                placeholder="••••••••"
              />
            </div>
            {loginError && (
              <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 p-3 rounded-lg">
                <AlertCircle size={16} />
                <span>{loginError}</span>
              </div>
            )}
            <button type="submit" className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold shadow-lg shadow-blue-200 transition-all">
              Log In
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900">
      <audio ref={remoteAudioRef} autoPlay />
      
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 text-white flex flex-col shrink-0">
        <div className="p-6 text-xl font-bold border-b border-slate-800 flex items-center gap-2">
          <Phone className="text-blue-400" />
          <span>Zoho-Plivo</span>
        </div>
        
        <nav className="flex-1 p-4 space-y-2">
          <NavItem icon={<LayoutDashboard size={20} />} label="Dashboard" active={activeView === 'dashboard'} onClick={() => setActiveView('dashboard')} />
          {loggedInAgent?.role !== 'admin' && (
            <NavItem icon={<Phone size={20} />} label="Dialer" active={activeView === 'dialer'} onClick={() => setActiveView('dialer')} />
          )}
          <NavItem icon={<History size={20} />} label="Call Logs" active={activeView === 'logs'} onClick={() => setActiveView('logs')} />
          {loggedInAgent?.role === 'admin' && (
            <NavItem icon={<Users size={20} />} label="Agents" active={activeView === 'agents'} onClick={() => setActiveView('agents')} />
          )}
          <NavItem icon={<Settings size={20} />} label="Settings" active={activeView === 'settings'} onClick={() => setActiveView('settings')} />
        </nav>

        <div className="p-4 border-t border-slate-800">
          <button onClick={handleLogout} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors w-full">
            <LogOut size={20} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <header className="h-16 bg-white border-b flex items-center justify-between px-8 shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-gray-700 capitalize">{activeView}</h2>
            <span className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${
              callStatus === 'Ready' || callStatus === 'Connected' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
            }`}>
              <span className={`w-2 h-2 rounded-full ${
                callStatus === 'Ready' || callStatus === 'Connected' ? 'bg-green-500' : 'bg-amber-500 animate-pulse'
              }`}></span>
              {callStatus}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm font-medium">{loggedInAgent.name}</p>
              <p className="text-xs text-gray-500 truncate w-32">{loggedInAgent.username}</p>
            </div>
            <div className="w-10 h-10 bg-blue-500 rounded-full flex items-center justify-center text-white font-bold">
              {loggedInAgent.name[0]}
            </div>
          </div>
        </header>

        {/* View Content */}
        <div className="flex-1 overflow-auto p-8">
          {activeView === 'dashboard' && (
            <div className="space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <StatCard label="Total Calls" value={displayHistory.length.toString()} change={`+${displayHistory.length}`} />
                <StatCard label="Talk Time" value={formatDuration(totalDuration)} change="+0%" />
                <StatCard label="Success Rate" value={`${successRate}%`} change="0%" />
                {loggedInAgent?.role === 'admin' ? (
                  <StatCard label="Agents Online" value={availableAgents.filter((a: any) => a.role !== 'admin').length.toString()} change="+1" />
                ) : (
                  <StatCard label="My Status" value="Active" change="Ready" />
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className={`${loggedInAgent?.role === 'admin' ? 'lg:col-span-3' : 'lg:col-span-2'} bg-white rounded-xl shadow-sm border p-6`}>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold">Recent Activity</h3>
                    <button onClick={() => setActiveView('logs')} className="text-blue-600 text-sm font-medium hover:underline">View All</button>
                  </div>
                  <RecentCallsTable history={displayHistory} />
                </div>
                {loggedInAgent?.role !== 'admin' && (
                  <DialerPanel 
                    dialNumber={dialNumber} 
                    setDialNumber={setDialNumber} 
                    isCalling={isCalling} 
                    isMuted={isMuted} 
                    timer={timer} 
                    formatTimer={formatTimer} 
                    makeCall={makeCall} 
                    hangupCall={hangupCall} 
                    toggleMute={toggleMute} 
                    plivoReady={plivoReady}
                  />
                )}
              </div>
            </div>
          )}

          {activeView === 'dialer' && (
            <div className="max-w-md mx-auto">
              <DialerPanel 
                dialNumber={dialNumber} 
                setDialNumber={setDialNumber} 
                isCalling={isCalling} 
                isMuted={isMuted} 
                timer={timer} 
                formatTimer={formatTimer} 
                makeCall={makeCall} 
                hangupCall={hangupCall} 
                toggleMute={toggleMute} 
                plivoReady={plivoReady}
              />
            </div>
          )}

          {activeView === 'logs' && (
            <div className="bg-white rounded-xl shadow-sm border p-6">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-bold">Call History</h3>
                <button onClick={fetchHistory} className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium transition-colors">
                  <RefreshCw size={16} />
                  Refresh
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-gray-400 text-sm uppercase border-b">
                      <th className="pb-4 font-medium">Customer</th>
                      <th className="pb-4 font-medium">Agent</th>
                      <th className="pb-4 font-medium">Time</th>
                      <th className="pb-4 font-medium">Duration</th>
                      <th className="pb-4 font-medium">Recording</th>
                      <th className="pb-4 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {displayHistory.length > 0 ? displayHistory.slice().reverse().map((call: any, idx: number) => (
                      <tr key={idx} className="hover:bg-gray-50 transition-colors">
                        <td className="py-4 font-medium text-sm">{call.to}</td>
                        <td className="py-4 text-gray-500 text-sm">{call.agent}</td>
                        <td className="py-4 text-gray-500 text-sm">{new Date(call.time).toLocaleString()}</td>
                        <td className="py-4 text-gray-500 text-sm">{call.duration || 0}s</td>
                        <td className="py-4">
                          {call.recordingUrl ? (
                            <audio src={call.recordingUrl} controls className="h-8 w-48" />
                          ) : '-'}
                        </td>
                        <td className="py-4">
                          <span className={`text-[10px] uppercase font-bold px-2 py-1 rounded ${
                            call.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}>
                            {call.status}
                          </span>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={6} className="py-12 text-center text-gray-400 italic">No call logs found</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeView === 'agents' && (
            <AgentsView availableAgents={availableAgents} fetchAgents={fetchAgents} onDeleteAgent={handleDeleteAgent} />
          )}

          {(activeView === 'settings') && (
            <div className="bg-white rounded-xl shadow-sm border p-8 text-center">
              <Settings size={48} className="mx-auto text-gray-300 mb-4" />
              <h3 className="text-lg font-bold mb-2">Settings</h3>
              <p className="text-gray-500">System settings and configurations will appear here.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function NavItem({ icon, label, active = false, onClick }) {
  return (
    <button 
      onClick={onClick}
      className={`flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
      active ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' : 'text-slate-400 hover:bg-slate-800 hover:text-white'
    }`}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function StatCard({ label, value, change }) {
  const isPositive = change.startsWith('+');
  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border">
      <p className="text-sm text-gray-500 font-medium mb-1">{label}</p>
      <div className="flex items-end justify-between">
        <h4 className="text-2xl font-bold">{value}</h4>
        <span className={`text-xs font-bold px-2 py-1 rounded-md ${
          isPositive ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'
        }`}>
          {change}
        </span>
      </div>
    </div>
  );
}

function RecentCallsTable({ history }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="text-gray-400 text-sm uppercase">
            <th className="pb-4 font-medium">Customer</th>
            <th className="pb-4 font-medium">Time</th>
            <th className="pb-4 font-medium">Duration</th>
            <th className="pb-4 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {history.length > 0 ? history.slice(-5).reverse().map((call: any, idx: number) => (
            <tr key={idx} className="hover:bg-gray-50 transition-colors">
              <td className="py-4 font-medium text-sm">{call.to}</td>
              <td className="py-4 text-gray-500 text-sm">{new Date(call.time).toLocaleTimeString()}</td>
              <td className="py-4 text-gray-500 text-sm">{call.duration || 0}s</td>
              <td className="py-4">
                <span className={`text-[10px] uppercase font-bold px-2 py-1 rounded ${
                  call.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }`}>
                  {call.status}
                </span>
              </td>
            </tr>
          )) : (
            <tr>
              <td colSpan={4} className="py-8 text-center text-gray-400">No recent calls</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DialerPanel({ dialNumber, setDialNumber, isCalling, isMuted, timer, formatTimer, makeCall, hangupCall, toggleMute, plivoReady }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border p-6 flex flex-col">
      <h3 className="text-lg font-bold mb-4 text-center">Dial Pad</h3>
      
      {isCalling && (
        <div className="mb-4 text-center animate-bounce text-blue-600 font-bold text-xl">
          {formatTimer(timer)}
        </div>
      )}

      <input 
        type="text"
        className="bg-gray-100 rounded-lg p-4 mb-4 text-center text-2xl font-semibold tracking-widest outline-none focus:ring-2 focus:ring-blue-500"
        value={dialNumber}
        onChange={(e) => setDialNumber(e.target.value)}
        placeholder="Enter Number"
      />

      <div className="grid grid-cols-3 gap-4 mb-6">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, '*', 0, '#'].map((num) => (
          <button 
            key={num} 
            onClick={() => setDialNumber(prev => prev + num)}
            className="h-12 flex items-center justify-center bg-gray-50 hover:bg-gray-200 rounded-lg font-bold transition-colors"
          >
            {num}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {!isCalling ? (
          <button 
            onClick={makeCall}
            disabled={!plivoReady || !dialNumber}
            className="col-span-2 py-4 bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white rounded-xl font-bold shadow-lg shadow-green-100 transition-all flex items-center justify-center gap-2"
          >
            <Phone size={20} fill="currentColor" />
            Start Call
          </button>
        ) : (
          <>
            <button 
              onClick={toggleMute}
              className={`py-4 rounded-xl font-bold transition-all flex items-center justify-center gap-2 ${
                isMuted ? 'bg-amber-500 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
              {isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button 
              onClick={hangupCall}
              className="py-4 bg-red-500 hover:bg-red-600 text-white rounded-xl font-bold shadow-lg shadow-red-100 transition-all flex items-center justify-center gap-2"
            >
              <PhoneOff size={20} />
              Hangup
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AgentsView({ availableAgents, fetchAgents, onDeleteAgent }: { availableAgents: any[], fetchAgents: () => void, onDeleteAgent: (username: string) => void }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newAgent, setNewAgent] = useState({ name: '', username: '', password: '' });
  const [error, setError] = useState('');

  const handleAddAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await axios.post(`${SERVER}/agents`, newAgent);
      setNewAgent({ name: '', username: '', password: '' });
      setShowAddForm(false);
      fetchAgents();
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to add agent');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold">Manage Agents</h3>
        <button 
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold transition-all shadow-lg shadow-blue-200"
        >
          {showAddForm ? 'Cancel' : <><UserPlus size={18} /> Add New Agent</>}
        </button>
      </div>

      {showAddForm && (
        <div className="bg-white rounded-xl shadow-sm border p-6 animate-in fade-in slide-in-from-top-4">
          <h4 className="font-bold mb-4">Create New Agent Account</h4>
          <form onSubmit={handleAddAgent} className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
              <input 
                type="text" 
                required
                className="w-full px-4 py-2 rounded-lg border focus:ring-2 focus:ring-blue-500 outline-none"
                value={newAgent.name}
                onChange={(e) => setNewAgent({...newAgent, name: e.target.value})}
                placeholder="Agent Name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Username / ID</label>
              <input 
                type="text" 
                required
                className="w-full px-4 py-2 rounded-lg border focus:ring-2 focus:ring-blue-500 outline-none"
                value={newAgent.username}
                onChange={(e) => setNewAgent({...newAgent, username: e.target.value})}
                placeholder="zohoagent..."
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input 
                type="password" 
                required
                className="w-full px-4 py-2 rounded-lg border focus:ring-2 focus:ring-blue-500 outline-none"
                value={newAgent.password}
                onChange={(e) => setNewAgent({...newAgent, password: e.target.value})}
                placeholder="••••••••"
              />
            </div>
            <div className="md:col-span-3">
              {error && <p className="text-red-600 text-sm mb-2">{error}</p>}
              <button type="submit" className="px-6 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg font-bold transition-colors">
                Save Agent
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-50 text-gray-500 text-xs uppercase font-bold tracking-wider">
              <th className="p-4">Name</th>
              <th className="p-4">Username / Agent ID</th>
              <th className="p-4">Password</th>
              <th className="p-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {availableAgents.filter((a: any) => a.role !== 'admin').map((agent) => (
              <tr key={agent.username} className="hover:bg-gray-50 transition-colors">
                <td className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold text-xs uppercase">
                      {agent.name[0]}
                    </div>
                    <span className="font-medium">{agent.name}</span>
                  </div>
                </td>
                <td className="p-4 text-sm text-gray-600 font-mono">{agent.username}</td>
                <td className="p-4 text-sm text-gray-400">••••••••</td>
                <td className="p-4 text-right">
                  <button 
                    onClick={() => onDeleteAgent(agent.username)}
                    className="p-2 text-gray-400 hover:text-red-600 transition-colors"
                  >
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default App;
