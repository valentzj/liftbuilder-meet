'use strict';

const http     = require('http');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const express  = require('express');
const { Server } = require('socket.io');

const PORT = parseInt(process.env.PORT || 3847);

// ── Server state ─────────────────────────────────────────────────────────────
let _pin              = null;
let _directorToken    = null;
let _meetState        = null;
let _platformsActive  = false;
const _socketPlatforms    = new Map(); // socket.id → pNum
const _connectedPlatforms = new Set();

function getLocalIP() {
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

// ── Express + Socket.IO setup ─────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname)));

// Platform client routes
app.get('/platform/:num',      (_req, res) => res.sendFile(path.join(__dirname, 'platform-client.html')));
app.get('/display/:num',       (_req, res) => res.sendFile(path.join(__dirname, 'platform-display.html')));
app.get('/scoreboard',         (_req, res) => res.sendFile(path.join(__dirname, 'platform-scoreboard.html')));
app.get('/referee/:num/:seat', (_req, res) => res.sendFile(path.join(__dirname, 'referee.html')));

// ── REST API ──────────────────────────────────────────────────────────────────
app.post('/api/start-platforms', (req, res) => {
  const meetState = req.body?.meetState;
  if (!meetState) return res.status(400).json({ error: 'meetState required' });

  _pin           = String(Math.floor(100000 + Math.random() * 900000));
  _directorToken = crypto.randomBytes(24).toString('hex');
  _platformsActive = true;

  _meetState = JSON.parse(JSON.stringify(meetState));
  _meetState.timerEndMs     = null;
  _meetState.timerPausedRem = null;
  if (!_meetState.platformStates) _meetState.platformStates = {};
  for (let i = 1; i <= (_meetState.numPlatforms || 1); i++) {
    if (!_meetState.platformStates[i]) {
      _meetState.platformStates[i] = {
        status: _meetState.status, attemptRound: 1, barWeight: null, checkedIn: [],
        judgeVotes: { 1: null, 2: null, 3: null },
        clockStart: null, clockDuration: null, clockPausedRemaining: null,
        breakEndMs: null, breakPausedRem: null,
      };
    }
  }
  _connectedPlatforms.clear();
  _socketPlatforms.clear();

  const ip = getLocalIP();
  console.log(`Platforms started — PIN: ${_pin}  http://${ip}:${PORT}`);
  res.json({ success: true, ip, port: PORT, pin: _pin, directorToken: _directorToken });
});

app.post('/api/stop-platforms', (_req, res) => {
  _platformsActive = false;
  _meetState = null;
  _pin = null;
  _directorToken = null;
  _connectedPlatforms.clear();
  _socketPlatforms.clear();
  console.log('Platforms stopped.');
  res.json({ success: true });
});

app.get('/api/status', (_req, res) => {
  res.json({ active: _platformsActive, pin: _pin, ip: getLocalIP(), port: PORT });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function _eligibleForLift(e, lift) {
  if (lift === 'snatch') return e.discipline === 'both' || e.discipline === 'olympic'     || e.discipline === 'exhibition';
  if (lift === 'cj')     return true;
  if (lift === 'bench')  return e.discipline === 'both' || e.discipline === 'traditional' || e.discipline === 'exhibition';
  return false;
}

function _getPS(pNum) {
  if (!_meetState) return null;
  const max = _meetState.numPlatforms || 8;
  if (!Number.isInteger(pNum) || pNum < 1 || pNum > max) return null;
  if (!_meetState.platformStates) _meetState.platformStates = {};
  if (!_meetState.platformStates[pNum]) {
    _meetState.platformStates[pNum] = {
      status: _meetState.status, attemptRound: 1, barWeight: null, checkedIn: [],
      judgeVotes: { 1: null, 2: null, 3: null },
      clockStart: null, clockDuration: null, clockPausedRemaining: null,
    };
  }
  return _meetState.platformStates[pNum];
}

function _broadcast() {
  if (!_meetState) return;
  const state = { ..._meetState, _connectedPlatforms: [..._connectedPlatforms] };
  io.emit('state-update', state);
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const auth = socket.handshake.auth;
  if (_directorToken && auth?.directorToken === _directorToken) return next();
  if (_pin && auth?.token === _pin) return next();
  next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
  const isDirector = _directorToken && socket.handshake.auth?.directorToken === _directorToken;

  // ── Director connection ──────────────────────────────────────────────────────
  if (isDirector) {
    socket.join('director');

    // Full state sync from director browser → broadcast to platforms
    socket.on('sync-state', (meetState) => {
      if (!_platformsActive || !_meetState) return;
      _meetState.entries = meetState.entries;
      _meetState.schools = meetState.schools;
      _meetState.name    = meetState.name;
      _meetState.status  = meetState.status;
      _broadcast();
    });

    // Director override commands
    socket.on('director-set-bar-weight', ({ pNum, weight }) => {
      const ps = _getPS(parseInt(pNum));
      if (!ps) return;
      ps.barWeight            = parseInt(weight) || null;
      ps.attemptRound         = 1;
      ps.checkedIn            = [];
      ps.clockStart           = null;
      ps.clockDuration        = null;
      ps.clockPausedRemaining = null;
      ps.judgeVotes           = { 1: null, 2: null, 3: null };
      _broadcast();
    });

    socket.on('director-advance-round', ({ pNum }) => {
      const ps = _getPS(parseInt(pNum));
      if (!ps || ps.attemptRound >= 3) return;
      ps.attemptRound++;
      ps.checkedIn            = [];
      ps.clockStart           = null;
      ps.clockDuration        = null;
      ps.clockPausedRemaining = null;
      _broadcast();
    });

    socket.on('director-advance-phase', ({ pNum }) => {
      if (!_meetState) return;
      const ps   = _getPS(parseInt(pNum));
      if (!ps) return;
      const lift = ps.status;
      const entries = _meetState.entries.filter(e => e.platform === pNum);
      const elig    = entries.filter(e => _eligibleForLift(e, lift));
      if (!elig.every(e => e[lift].every(a => a.result !== null))) return;
      let next;
      if (lift === 'snatch') {
        next = 'cj';
      } else if (lift === 'cj') {
        const hasBench = entries.some(e =>
          e.discipline === 'both' || e.discipline === 'traditional' || e.discipline === 'exhibition');
        next = hasBench ? 'bench' : 'complete';
      } else {
        next = 'complete';
      }
      ps.status               = next;
      ps.attemptRound         = 1;
      ps.barWeight            = null;
      ps.checkedIn            = [];
      ps.clockStart           = null;
      ps.clockDuration        = null;
      ps.clockPausedRemaining = null;
      _broadcast();
    });

    socket.on('director-declare-attempt', ({ entryId, lift, attemptIdx, weight }) => {
      if (!_meetState) return;
      const e = _meetState.entries.find(x => x.id === entryId);
      if (!e || !e[lift]?.[attemptIdx] || e[lift][attemptIdx].result !== null) return;
      e[lift][attemptIdx].declared = parseInt(weight) || 0;
      _broadcast();
    });

    socket.on('director-pause-clock', ({ pNum }) => {
      const ps = _getPS(parseInt(pNum));
      if (!ps || !ps.clockStart || !ps.clockDuration) return;
      ps.clockPausedRemaining = Math.max(0, ps.clockDuration * 1000 - (Date.now() - ps.clockStart));
      ps.clockStart = null;
      _broadcast();
    });

    socket.on('director-resume-clock', ({ pNum }) => {
      const ps = _getPS(parseInt(pNum));
      if (!ps || ps.clockPausedRemaining == null) return;
      ps.clockStart           = Date.now() - (ps.clockDuration * 1000 - ps.clockPausedRemaining);
      ps.clockPausedRemaining = null;
      _broadcast();
    });

    socket.on('director-reset-clock', ({ pNum }) => {
      const ps = _getPS(parseInt(pNum));
      if (!ps) return;
      ps.clockStart           = null;
      ps.clockDuration        = null;
      ps.clockPausedRemaining = null;
      _broadcast();
    });

    return;
  }

  // ── Platform client connection ────────────────────────────────────────────────
  socket.on('join', (rawNum) => {
    if (!_meetState) return;
    const pNum = parseInt(rawNum);
    const max  = _meetState.numPlatforms || 8;
    if (!Number.isInteger(pNum) || pNum < 1 || pNum > max) return;
    _socketPlatforms.set(socket.id, pNum);
    _connectedPlatforms.add(pNum);
    socket.join('p' + pNum);
    _broadcast();
  });

  socket.on('disconnect', () => {
    const pNum = _socketPlatforms.get(socket.id);
    if (pNum !== undefined) {
      _socketPlatforms.delete(socket.id);
      if (![..._socketPlatforms.values()].includes(pNum)) _connectedPlatforms.delete(pNum);
      _broadcast();
    }
  });

  socket.on('set-bar-weight', ({ pNum, weight }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps) return;
    ps.barWeight            = parseInt(weight) || null;
    ps.attemptRound         = 1;
    ps.checkedIn            = [];
    ps.clockStart           = null;
    ps.clockDuration        = null;
    ps.clockPausedRemaining = null;
    ps.breakEndMs           = null;
    ps.breakPausedRem       = null;
    ps.judgeVotes           = { 1: null, 2: null, 3: null };
    _broadcast();
  });

  socket.on('check-in', ({ pNum, entryId, attemptIdx }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps) return;
    const key      = entryId + ':' + attemptIdx;
    const wasEmpty = ps.checkedIn.length === 0;
    if (!ps.checkedIn.includes(key)) ps.checkedIn.push(key);
    if (ps.barWeight) {
      const e    = _meetState.entries.find(x => x.id === entryId);
      const lift = ps.status;
      if (e && e[lift]?.[attemptIdx]?.result === null) e[lift][attemptIdx].declared = ps.barWeight;
    }
    if (wasEmpty) {
      const isFollowingSelf = _meetState.lastLift?.entryId === entryId;
      ps.clockDuration = isFollowingSelf ? 120 : 60;
      ps.clockStart    = Date.now();
      ps.clockPausedRemaining = null;
    }
    _broadcast();
  });

  socket.on('uncheck-in', ({ pNum, entryId, attemptIdx }) => {
    const ps  = _getPS(parseInt(pNum));
    if (!ps) return;
    ps.checkedIn = ps.checkedIn.filter(k => k !== entryId + ':' + attemptIdx);
    if (ps.checkedIn.length === 0) { ps.clockStart = null; ps.clockDuration = null; ps.clockPausedRemaining = null; }
    _broadcast();
  });

  socket.on('record-result', ({ pNum, entryId, lift, attemptIdx, result }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps) return;
    const e  = _meetState.entries.find(x => x.id === entryId);
    if (!e) return;
    const att = e[lift]?.[attemptIdx];
    if (!att || att.result !== null) return;
    ps.checkedIn  = ps.checkedIn.filter(k => k !== entryId + ':' + attemptIdx);
    ps.judgeVotes = { 1: null, 2: null, 3: null };
    att.result    = result;
    const nextIdx = attemptIdx + 1;
    if (nextIdx < 3 && e[lift][nextIdx].result === null)
      e[lift][nextIdx].declared = result === 'good' ? att.declared + 5 : att.declared;
    _meetState.lastLift = {
      entryId: e.id, name: e.name, schoolId: e.schoolId, wc: e.wc,
      lift, declared: att.declared, result, attemptIdx, platform: pNum, publicOptOut: !!e.publicOptOut,
    };
    if (ps.checkedIn.length > 0) {
      const nextId = ps.checkedIn[0].split(':')[0];
      ps.clockDuration        = nextId === entryId ? 120 : 60;
      ps.clockStart           = Date.now();
      ps.clockPausedRemaining = null;
    } else {
      ps.clockStart = null; ps.clockDuration = null; ps.clockPausedRemaining = null;
    }
    _broadcast();
  });

  socket.on('declare-attempt', ({ entryId, lift, attemptIdx, weight }) => {
    const e = _meetState?.entries.find(x => x.id === entryId);
    if (!e || !e[lift]?.[attemptIdx] || e[lift][attemptIdx].result !== null) return;
    e[lift][attemptIdx].declared = parseInt(weight) || 0;
    _broadcast();
  });

  socket.on('pass-attempt', ({ pNum, entryId, lift, weight }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps || !_meetState) return;
    const e   = _meetState.entries.find(x => x.id === entryId);
    if (!e) return;
    const idx = e[lift].findIndex(a => a.result === null);
    if (idx < 0) return;
    if (weight) e[lift][idx].declared = parseInt(weight);
    ps.checkedIn = ps.checkedIn.filter(k => !k.startsWith(entryId + ':'));
    if (ps.checkedIn.length === 0) { ps.clockStart = null; ps.clockDuration = null; ps.clockPausedRemaining = null; }
    _broadcast();
  });

  socket.on('scratch-entry', ({ pNum, entryId, lift }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps || !_meetState) return;
    const e  = _meetState.entries.find(x => x.id === entryId);
    if (!e) return;
    e[lift].forEach(a => { if (a.result === null) a.result = 'miss'; });
    ps.checkedIn = ps.checkedIn.filter(k => !k.startsWith(entryId + ':'));
    if (ps.checkedIn.length === 0) { ps.clockStart = null; ps.clockDuration = null; ps.clockPausedRemaining = null; }
    _broadcast();
  });

  socket.on('advance-attempt-round', ({ pNum }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps || ps.attemptRound >= 3) return;
    ps.attemptRound++;
    ps.checkedIn = []; ps.clockStart = null; ps.clockDuration = null; ps.clockPausedRemaining = null;
    _broadcast();
  });

  socket.on('advance-phase', ({ pNum, breakDuration }) => {
    if (!_meetState) return;
    const ps      = _getPS(parseInt(pNum));
    if (!ps) return;
    const lift    = ps.status;
    const entries = _meetState.entries.filter(e => e.platform === pNum);
    const elig    = entries.filter(e => _eligibleForLift(e, lift));
    if (!elig.every(e => e[lift].every(a => a.result !== null))) return;
    let next;
    if (lift === 'snatch') {
      next = 'cj';
    } else if (lift === 'cj') {
      next = entries.some(e =>
        e.discipline === 'both' || e.discipline === 'traditional' || e.discipline === 'exhibition')
        ? 'bench' : 'complete';
    } else {
      next = 'complete';
    }
    ps.status               = next;
    ps.attemptRound         = 1;
    ps.barWeight            = null;
    ps.checkedIn            = [];
    ps.clockStart           = null;
    ps.clockDuration        = null;
    ps.clockPausedRemaining = null;
    const dur               = Math.max(0, Math.min(Number(breakDuration) || 0, 3600));
    ps.breakEndMs           = dur > 0 ? Date.now() + dur * 1000 : null;
    ps.breakPausedRem       = null;
    _broadcast();
  });

  socket.on('pause-break', ({ pNum }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps || !ps.breakEndMs) return;
    ps.breakPausedRem = Math.max(0, ps.breakEndMs - Date.now());
    ps.breakEndMs     = null;
    _broadcast();
  });

  socket.on('resume-break', ({ pNum }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps || ps.breakPausedRem == null) return;
    ps.breakEndMs     = Date.now() + ps.breakPausedRem;
    ps.breakPausedRem = null;
    _broadcast();
  });

  socket.on('reset-break', ({ pNum }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps) return;
    ps.breakEndMs = null; ps.breakPausedRem = null;
    _broadcast();
  });

  socket.on('pause-clock', ({ pNum }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps || !ps.clockStart || !ps.clockDuration) return;
    ps.clockPausedRemaining = Math.max(0, ps.clockDuration * 1000 - (Date.now() - ps.clockStart));
    ps.clockStart = null;
    _broadcast();
  });

  socket.on('resume-clock', ({ pNum }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps || ps.clockPausedRemaining == null) return;
    ps.clockStart           = Date.now() - (ps.clockDuration * 1000 - ps.clockPausedRemaining);
    ps.clockPausedRemaining = null;
    _broadcast();
  });

  socket.on('reset-clock', ({ pNum }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps) return;
    ps.clockStart = null; ps.clockDuration = null; ps.clockPausedRemaining = null;
    _broadcast();
  });

  socket.on('judge-vote', ({ pNum, seat, result }) => {
    const ps = _getPS(parseInt(pNum));
    if (!ps) return;
    const s = parseInt(seat);
    if (s < 1 || s > 3 || (result !== 'good' && result !== 'no')) return;
    if (!ps.judgeVotes) ps.judgeVotes = { 1: null, 2: null, 3: null };
    ps.judgeVotes[s] = result;
    const votes = Object.values(ps.judgeVotes).filter(v => v !== null);
    const goods = votes.filter(v => v === 'good').length;
    const nos   = votes.filter(v => v === 'no').length;
    if (goods >= 2 || nos >= 2) {
      const autoResult     = goods >= 2 ? 'good' : 'miss';
      const checkedInKey   = ps.checkedIn?.[0];
      if (checkedInKey) {
        const [entryId, aidxStr] = checkedInKey.split(':');
        const attemptIdx = parseInt(aidxStr);
        const lift = ps.status;
        const e    = _meetState.entries.find(x => x.id === entryId);
        if (e) {
          const att = e[lift]?.[attemptIdx];
          if (att && att.result === null) {
            att.result   = autoResult;
            ps.checkedIn = ps.checkedIn.filter(k => k !== checkedInKey);
            if (autoResult === 'good' && attemptIdx + 1 < 3 && e[lift][attemptIdx + 1].result === null)
              e[lift][attemptIdx + 1].declared = att.declared + 5;
            _meetState.lastLift = {
              entryId: e.id, name: e.name, schoolId: e.schoolId, wc: e.wc,
              lift, declared: att.declared, result: autoResult, attemptIdx, platform: pNum,
              publicOptOut: !!e.publicOptOut,
            };
            if (ps.checkedIn.length > 0) {
              const nextId = ps.checkedIn[0].split(':')[0];
              ps.clockDuration        = nextId === entryId ? 120 : 60;
              ps.clockStart           = Date.now();
              ps.clockPausedRemaining = null;
            } else {
              ps.clockStart = null; ps.clockDuration = null; ps.clockPausedRemaining = null;
            }
          }
        }
      }
      ps.judgeVotes = { 1: null, 2: null, 3: null };
    }
    _broadcast();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const ip = getLocalIP();
  console.log(`\nLiftBuilder Meet running at:\n  Local:   http://localhost:${PORT}\n  Network: http://${ip}:${PORT}\n`);
  console.log('To share remotely, run:  npx ngrok http ' + PORT);
  console.log('Then open the ngrok URL on any device.\n');
});
