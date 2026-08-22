'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  HOST MEET  —  Phase 1 + Phase 2: Setup, Weigh-In & Live Competition
// ═══════════════════════════════════════════════════════════════════════════

const HM = (() => {

  // ── Constants ──────────────────────────────────────────────────────────────
  const GIRLS_WC = ['101','110','119','129','139','154','169','183','199','UNL'];
  const BOYS_WC  = ['119','129','139','154','169','183','199','219','238','HWT'];

  const STATUS_LABEL = {
    setup:      'Setup',
    'weigh-in': 'Weigh-In',
    snatch:     'Snatch',
    cj:         'Clean & Jerk',
    bench:      'Bench',
    complete:   'Complete',
  };

  // ── Module state ───────────────────────────────────────────────────────────
  let _meets              = [];
  let _activeMeetId       = null;
  let _view               = 'list';   // list | setup | weighin | competition | results | stats
  let _rosterCache        = [];
  let _scoreTab           = 'olympic'; // olympic | traditional | team
  let _activeFlight       = 'A';      // 'A' | 'B'
  let _barWeight          = null;     // current weight loaded on the bar
  let _checkedIn          = new Set(); // 'entryId:attemptIdx' — athletes checked in for current bar/round
  let _attemptRound       = 1;        // 1 | 2 | 3 — manually controlled by director
  let _timerEndMs         = null;
  let _timerPausedRem     = null;
  let _timerInterval      = null;
  let _compFontLarge      = false;
  let _lastLift           = null;  // last recorded result, shown on display while waiting
  let _platformActive       = false; // true when platform server is running
  let _platformInfo         = null;  // { ip, port, token }
  let _platformSyncLock     = false; // prevents circular sync loops
  let _connectedPlatforms   = [];    // pNums currently connected, from server broadcasts
  let _directorSocket       = null;  // socket.io connection to the server (director role)
  let _clockStart           = null;  // ms timestamp when clock started (single-platform mode)
  let _clockDuration        = null;  // 60 or 120 seconds
  let _clockPausedRemaining = null;  // ms remaining when paused, null if running or no clock
  let _clockTickInterval    = null;  // setInterval handle for clock ticking

  // ── Persistence ────────────────────────────────────────────────────────────
  const STORE_KEY         = 'liftbuilder_hosted_meets';
  const DISPLAY_STATE_KEY = 'liftbuilder_display_state';

  function _save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(_meets)); } catch(e) {}
    _saveDisplayState();
    if (_platformActive && !_platformSyncLock) {
      const m = _meet();
      if (m) _directorSocket?.emit('sync-state', m);
    }
  }
  function _saveDisplayState() {
    try {
      localStorage.setItem(DISPLAY_STATE_KEY, JSON.stringify({
        checkedIn:     [..._checkedIn],
        activeFlight:  _activeFlight,
        barWeight:     _barWeight,
        attemptRound:  _attemptRound,
        lastLift:      _lastLift,
        clockStart:           _clockStart,
        clockDuration:        _clockDuration,
        clockPausedRemaining: _clockPausedRemaining,
        timerEndMs:           _timerEndMs,
        timerPausedRem:       _timerPausedRem,
      }));
    } catch(e) {}
  }
  function _load() { try { const r = localStorage.getItem(STORE_KEY); if (r) _meets = JSON.parse(r); } catch(e) { _meets = []; } }

  // ── Core helpers ───────────────────────────────────────────────────────────
  function _meet() { return _meets.find(m => m.id === _activeMeetId) || null; }
  function _uid(p) { return p + '_' + Date.now() + '_' + Math.floor(Math.random() * 9999); }
  function _wcs(gender) { return gender === 'Girls' ? GIRLS_WC : BOYS_WC; }

  function _blankEntry(name, schoolId, wc, discipline, athleteId, defaults, publicOptOut) {
    return {
      id: _uid('ent'), athleteId: athleteId || null,
      name, schoolId, wc, discipline,
      publicOptOut: !!publicOptOut,
      flight: 'A', platform: null,
      weighIn: null,
      snatchOpen: defaults?.snatch || 0,
      cjOpen:     defaults?.cj     || 0,
      benchOpen:  defaults?.bench  || 0,
      snatch: [{declared:0,result:null},{declared:0,result:null},{declared:0,result:null}],
      cj:     [{declared:0,result:null},{declared:0,result:null},{declared:0,result:null}],
      bench:  [{declared:0,result:null},{declared:0,result:null},{declared:0,result:null}],
    };
  }

  function _openAttempt(max) {
    if (!max) return 0;
    return Math.round(max * 0.9 / 5) * 5;
  }

  // ── Competition helpers ────────────────────────────────────────────────────
  function _eligibleForLift(e, lift) {
    if (lift === 'snatch') return e.discipline === 'both' || e.discipline === 'olympic' || e.discipline === 'exhibition';
    if (lift === 'cj')     return true;
    if (lift === 'bench')  return e.discipline === 'both' || e.discipline === 'traditional' || e.discipline === 'exhibition';
    return false;
  }

  function _curIdx(e, lift) { return e[lift].findIndex(a => a.result === null); }

  function _flightOrder(m, lift) {
    return m.entries
      .filter(e => _eligibleForLift(e, lift) && _curIdx(e, lift) >= 0 && (!m.useFlights || (e.flight||'A') === _activeFlight))
      .sort((a, b) => {
        const ai = _curIdx(a, lift), bi = _curIdx(b, lift);
        const aw = a[lift][ai].declared || 9999, bw = b[lift][bi].declared || 9999;
        return aw !== bw ? aw - bw : ai !== bi ? ai - bi : (a.weighIn || 999) - (b.weighIn || 999);
      });
  }

  function _minDeclared(m, lift) {
    const vals = m.entries
      .filter(e => _eligibleForLift(e, lift))
      .map(e => { const idx = _curIdx(e, lift); return idx >= 0 ? e[lift][idx].declared : 0; })
      .filter(w => w > 0);
    return vals.length ? Math.min(...vals) : null;
  }

  function _phaseComplete(m, lift) {
    return m.entries.filter(e => _eligibleForLift(e, lift)).every(e => e[lift].every(a => a.result !== null));
  }

  function _bestMade(attempts) {
    const w = attempts.filter(a => a.result === 'good').map(a => a.declared);
    return w.length ? Math.max(...w) : 0;
  }

  function _teamPoints(numTeams) {
    if (numTeams >= 5) return [7, 5, 4, 3, 2, 1];
    if (numTeams === 4) return [6, 4, 3, 2, 1];
    if (numTeams === 3) return [5, 3, 2, 1];
    return [5, 3, 1]; // 2 or fewer teams
  }

  function _olympicTotal(e) {
    const s = _bestMade(e.snatch), c = _bestMade(e.cj);
    return (s > 0 && c > 0) ? s + c : 0;
  }

  function _traditionalTotal(e) {
    const c = _bestMade(e.cj), b = _bestMade(e.bench);
    return (c > 0 && b > 0) ? c + b : 0;
  }

  // Tiebreak: higher total wins; if equal, lower body weight wins (lighter athlete places higher).
  function _rankCmp(a, b) {
    if (b.tot !== a.tot) return b.tot - a.tot;
    const wA = parseFloat(a.e.weighIn) || parseFloat(a.e.wc) || 999;
    const wB = parseFloat(b.e.weighIn) || parseFloat(b.e.wc) || 999;
    return wA - wB;
  }

  function _dots(attempts, curIdx) {
    return attempts.map((a, i) => {
      let col, sym;
      if      (a.result === 'good') { col = '#5EC08A'; sym = '✓'; }
      else if (a.result === 'miss') { col = '#E07070'; sym = '✗'; }
      else if (i === curIdx)        { col = 'var(--gold)'; sym = '●'; }
      else                          { col = '#444'; sym = '○'; }
      return `<span style="color:${col};font-size:13px;margin-right:1px;">${sym}</span>`;
    }).join('');
  }

  function _fmtTimer() {
    const rem = _timerEndMs ? (_timerPausedRem !== null ? _timerPausedRem : Math.max(0, _timerEndMs - Date.now()))
              : (_timerPausedRem !== null ? _timerPausedRem : null);
    if (rem === null) return '—';
    return Math.floor(rem / 60000) + ':' + String(Math.floor((rem % 60000) / 1000)).padStart(2, '0');
  }

  function _fmtClock(start, duration) {
    if (!start || !duration) return '';
    const rem = Math.max(0, duration * 1000 - (Date.now() - start));
    return Math.floor(rem / 60000) + ':' + String(Math.floor((rem % 60000) / 1000)).padStart(2,'0');
  }
  function _fmtClockMs(ms) {
    const rem = Math.max(0, ms);
    return Math.floor(rem / 60000) + ':' + String(Math.floor((rem % 60000) / 1000)).padStart(2,'0');
  }

  function _tickClock() {
    document.querySelectorAll('[data-clock-start],[data-clock-paused]').forEach(el => {
      if (el.dataset.clockPaused !== undefined && el.dataset.clockPaused !== '') {
        const rem = parseInt(el.dataset.clockPaused);
        if (isNaN(rem)) return;
        const mins = Math.floor(rem / 60000);
        const secs = Math.floor((rem % 60000) / 1000);
        el.textContent = mins + ':' + String(secs).padStart(2,'0');
        el.style.color = rem <= 10000 ? '#E07070' : rem <= 30000 ? '#E0A040' : '#5EC08A';
        el.style.opacity = '0.6';
        return;
      }
      el.style.opacity = '1';
      const start    = parseInt(el.dataset.clockStart);
      const duration = parseInt(el.dataset.clockDuration);
      if (!start || !duration) { el.textContent = ''; return; }
      const rem  = Math.max(0, duration * 1000 - (Date.now() - start));
      const mins = Math.floor(rem / 60000);
      const secs = Math.floor((rem % 60000) / 1000);
      el.textContent = mins + ':' + String(secs).padStart(2,'0');
      el.style.color = rem <= 10000 ? '#E07070' : rem <= 30000 ? '#E0A040' : '#5EC08A';
    });
  }

  function _startClockTick() {
    if (_clockTickInterval) clearInterval(_clockTickInterval);
    _clockTickInterval = setInterval(_tickClock, 200);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PUBLIC: buildHTML
  // ══════════════════════════════════════════════════════════════════════════
  function buildHTML() {
    _load();
    if (_view === 'setup')       return _buildSetupHTML();
    if (_view === 'weighin')     return _buildWeighInHTML();
    if (_view === 'competition') return _buildCompetitionHTML();
    if (_view === 'results')     return _buildResultsHTML();
    if (_view === 'stats')       return _buildStatsHTML();
    return _buildListHTML();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  LIST VIEW
  // ══════════════════════════════════════════════════════════════════════════
  function _buildListHTML() {
    const cards = _meets.length
      ? _meets.slice().reverse().map(m => {
          const sc = m.status === 'complete' ? '#5EC08A' : m.status === 'setup' ? '#888' : '#C9A84C';
          const weighed = m.entries.filter(e => e.weighIn !== null).length;
          return `
            <div class="chart-card" style="margin-bottom:1rem;cursor:pointer;transition:border-color .15s;"
              onmouseenter="this.style.borderColor='var(--gold-a40)'" onmouseleave="this.style.borderColor=''"
              onclick="HM.openMeet('${m.id}')">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
                <div style="flex:1;min-width:0;">
                  <div style="font-family:'Barlow Condensed',sans-serif;font-size:21px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.name)}</div>
                  <div style="font-size:12px;color:var(--muted);margin-top:3px;">
                    ${m.gender} &nbsp;·&nbsp; ${m.date||'No date'} ${m.location ? '&nbsp;·&nbsp; '+esc(m.location) : ''}
                  </div>
                  <div style="font-size:12px;color:var(--muted);margin-top:4px;">
                    ${m.schools.length} school${m.schools.length!==1?'s':''} &nbsp;·&nbsp; ${m.entries.length} athlete${m.entries.length!==1?'s':''}
                    ${m.status==='weigh-in'?` &nbsp;·&nbsp; ${weighed}/${m.entries.length} weighed in`:''}
                  </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
                  <span style="font-size:11px;padding:3px 10px;border-radius:3px;background:${sc}22;color:${sc};font-family:'Barlow Condensed',sans-serif;font-weight:600;letter-spacing:.5px;">${(STATUS_LABEL[m.status]||m.status).toUpperCase()}</span>
                  <button onclick="event.stopPropagation();HM.deleteMeet('${m.id}')"
                    style="background:rgba(192,57,43,0.15);border:1px solid rgba(192,57,43,0.35);border-radius:4px;cursor:pointer;color:#E07070;font-size:12px;padding:4px 9px;font-family:'Barlow Condensed',sans-serif;font-weight:600;">🗑</button>
                </div>
              </div>
            </div>`;
        }).join('')
      : `<div class="empty-msg" style="padding:4rem;">No hosted meets yet.<br>Create one to get started.</div>`;

    return `<div style="max-width:800px;">${cards}</div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SETUP VIEW
  // ══════════════════════════════════════════════════════════════════════════
  function _buildSetupHTML() {
    const m = _meet();
    if (!m) { _view = 'list'; return _buildListHTML(); }

    const TEAM_COLORS = [
      '#E85252','#E8A052','#FFD700','#5EC08A','#3A86D4','#A87FD4','#F5F5F5',
    ];
    const schoolRows = m.schools.map(s => {
      const col = s.color || '#C9A84C';
      const isPreset = TEAM_COLORS.includes(col);
      const swatches = TEAM_COLORS.map(c =>
        `<button onclick="HM.setSchoolColor('${s.id}','${c}')" title="${c}"
          style="width:22px;height:22px;border-radius:50%;background:${c};border:2px solid ${col===c?'#fff':'transparent'};
          outline:${col===c?'2px solid '+c:'none'};outline-offset:1px;cursor:pointer;padding:0;flex-shrink:0;"></button>`
      ).join('');
      return `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:9px 12px;background:var(--dark2);border-radius:5px;margin-bottom:6px;border:1px solid ${col}40;">
        <div style="width:4px;align-self:stretch;border-radius:2px;background:${col};flex-shrink:0;margin-top:2px;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:500;margin-bottom:7px;display:flex;align-items:center;gap:8px;">
            ${esc(s.name)}
            ${s.isHome ? `<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:var(--gold-a15);color:var(--gold);font-family:'Barlow Condensed',sans-serif;font-weight:600;letter-spacing:.5px;">HOME</span>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            ${swatches}
            <label title="Custom color" style="position:relative;width:22px;height:22px;flex-shrink:0;cursor:pointer;">
              <div style="width:22px;height:22px;border-radius:50%;background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);
                border:2px solid ${!isPreset?'#fff':'transparent'};outline:${!isPreset?'2px solid '+col:'none'};outline-offset:1px;"></div>
              <input type="color" value="${col}" onchange="HM.setSchoolColor('${s.id}',this.value)"
                style="position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;border:none;padding:0;">
            </label>
          </div>
        </div>
        <button onclick="HM.removeSchool('${s.id}')"
          style="background:none;border:none;cursor:pointer;color:#555;font-size:14px;padding:2px 5px;flex-shrink:0;"
          onmouseenter="this.style.color='#E07070'" onmouseleave="this.style.color='#555'">✕</button>
      </div>`;
    }).join('');

    const entryRows = [...m.entries].sort((a, b) => {
      const wcA = parseFloat(a.wc) || 9999;
      const wcB = parseFloat(b.wc) || 9999;
      if (wcA !== wcB) return wcA - wcB;
      const schA = (m.schools.find(s => s.id === a.schoolId)?.name || '').toLowerCase();
      const schB = (m.schools.find(s => s.id === b.schoolId)?.name || '').toLowerCase();
      return schA < schB ? -1 : schA > schB ? 1 : 0;
    }).map(e => {
      const school = m.schools.find(s => s.id === e.schoolId);
      const ef = e.flight || 'A';
      return `<tr style="border-bottom:1px solid var(--dark3);">
        <td style="padding:8px 10px;font-weight:500;"><span style="border-bottom:2px solid ${school?.color||'#555'};padding-bottom:1px;">${esc(e.name)}</span></td>
        <td style="padding:8px 10px;font-size:13px;color:${school?.color||'var(--muted)'};">${esc(school?.name||'—')}</td>
        <td style="padding:8px 10px;text-align:center;font-family:'Barlow Condensed',sans-serif;font-weight:600;">${e.wc}</td>
        <td style="padding:8px 10px;text-align:center;font-size:12px;color:var(--muted);">${{both:'Both',traditional:'Traditional',olympic:'Olympic',exhibition:'Exhibition'}[e.discipline]||e.discipline}</td>
        ${m.useFlights ? `
        <td style="padding:8px 10px;text-align:center;">
          <div style="display:inline-flex;border-radius:4px;overflow:hidden;border:1px solid var(--dark3);">
            <button onclick="HM.setEntryFlight('${e.id}','A')"
              style="padding:2px 9px;border:none;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:12px;background:${ef==='A'?'var(--gold)':'var(--dark3)'};color:${ef==='A'?'#000':'var(--muted)'};">A</button>
            <button onclick="HM.setEntryFlight('${e.id}','B')"
              style="padding:2px 9px;border:none;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:12px;background:${ef==='B'?'var(--gold)':'var(--dark3)'};color:${ef==='B'?'#000':'var(--muted)'};">B</button>
          </div>
        </td>` : ''}
        ${m.numPlatforms ? `
        <td style="padding:8px 10px;text-align:center;">
          <select onchange="HM.setPlatformForEntry('${e.id}',this.value)"
            style="background:var(--dark2);color:var(--white);border:1px solid var(--dark3);border-radius:4px;padding:3px 6px;font-size:12px;font-family:'Barlow Condensed',sans-serif;font-weight:600;">
            <option value="">—</option>
            ${Array.from({length:m.numPlatforms},(_,i)=>i+1).map(n=>`<option value="${n}" ${e.platform===n?'selected':''}>P${n}</option>`).join('')}
          </select>
        </td>` : ''}
        <td style="padding:8px 10px;text-align:right;white-space:nowrap;">
          <button onclick="HM.openEditEntryModal('${e.id}')"
            style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;padding:2px 6px;"
            onmouseenter="this.style.color='var(--white)'" onmouseleave="this.style.color='var(--muted)'">✏</button>
          <button onclick="HM.removeEntry('${e.id}')"
            style="background:none;border:none;cursor:pointer;color:#555;font-size:12px;padding:2px 5px;"
            onmouseenter="this.style.color='#E07070'" onmouseleave="this.style.color='#555'">✕</button>
        </td>
      </tr>`;
    }).join('');

    const hasHome    = m.schools.some(s => s.isHome);
    const canProceed = m.name.trim() && m.schools.length >= 2 && m.entries.length > 0;

    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-bottom:1.5rem;max-width:1000px;">
        <div class="chart-card">
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:1rem;">Meet Info</div>
          <div class="form-field">
            <label>Meet Name</label>
            <input type="text" id="hm-name" value="${esc(m.name)}" placeholder="e.g. District 4A Invitational" oninput="HM.autoSaveSetup()">
          </div>
          <div class="fg2">
            <div class="form-field"><label>Date</label><input type="date" id="hm-date" value="${m.date}" oninput="HM.autoSaveSetup()"></div>
            <div class="form-field"><label>Gender</label>
              <select id="hm-gender" onchange="HM.autoSaveSetup();renderMain()">
                <option value="Boys"  ${m.gender==='Boys' ?'selected':''}>Boys</option>
                <option value="Girls" ${m.gender==='Girls'?'selected':''}>Girls</option>
              </select>
            </div>
          </div>
          <div class="form-field">
            <label>Location / Venue</label>
            <input type="text" id="hm-location" value="${esc(m.location)}" placeholder="e.g. Seminole H.S. Weight Room" oninput="HM.autoSaveSetup()">
          </div>
          <div class="form-field">
            <label>Platforms</label>
            <select id="hm-num-platforms" onchange="HM.autoSaveSetup()">
              <option value="0" ${!m.numPlatforms?'selected':''}>Single Platform</option>
              ${[2,3,4,5,6,7,8,9,10].map(n=>`<option value="${n}" ${m.numPlatforms===n?'selected':''}>${n} Platforms</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="chart-card">
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:1rem;">Schools (${m.schools.length})</div>
          ${schoolRows || `<div style="font-size:13px;color:var(--muted);margin-bottom:.75rem;font-style:italic;">No schools added yet.</div>`}
          <div style="display:flex;gap:8px;margin-top:.75rem;flex-wrap:wrap;">
            <button onclick="HM.openAddSchoolModal(true)" class="btn btn-gold" style="font-size:12px;padding:5px 12px;" ${hasHome?'disabled':''}>+ Home School</button>
            <button onclick="HM.openAddSchoolModal(false)" class="btn btn-outline" style="font-size:12px;padding:5px 12px;">+ Visiting School</button>
          </div>
          ${m.schools.length < 2 ? `<div style="font-size:11px;color:#C9A84C;margin-top:8px;">⚠ At least 2 schools required.</div>` : ''}
        </div>
      </div>

      <div class="chart-card" style="max-width:1000px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:8px;">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <div style="font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--muted);">Entries (${m.entries.length})</div>
            <button onclick="HM.toggleFlights()"
              style="font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-weight:600;border:1px solid ${m.useFlights?'var(--gold)':'var(--dark3)'};background:${m.useFlights?'var(--gold-a15)':'var(--dark3)'};color:${m.useFlights?'var(--gold)':'var(--muted)'};">
              ${m.useFlights ? '✓ Two Flights (A/B)' : 'Two Flights (A/B)'}
            </button>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${hasHome ? `<button onclick="HM.openImportRosterModal()" class="btn btn-outline" style="font-size:12px;padding:5px 12px;">⬆ Import from Roster</button>` : ''}
            <button onclick="HM.openImportCSVModal()" class="btn btn-outline" style="font-size:12px;padding:5px 12px;" ${m.schools.length?'':'disabled'}>⬆ Import CSV</button>
            <button onclick="HM.openAddEntryModal()" class="btn btn-gold" style="font-size:12px;padding:5px 12px;" ${m.schools.length?'':'disabled'}>+ Add Athlete</button>
          </div>
        </div>
        ${m.entries.length ? `
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="border-bottom:2px solid var(--dark3);">
              <th style="text-align:left;padding:6px 10px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Athlete</th>
              <th style="text-align:left;padding:6px 10px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">School</th>
              <th style="text-align:center;padding:6px 10px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Wt Class</th>
              <th style="text-align:center;padding:6px 10px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Discipline</th>
              ${m.useFlights ? `<th style="text-align:center;padding:6px 10px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Flight</th>` : ''}
              ${m.numPlatforms ? `<th style="text-align:center;padding:6px 10px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Platform</th>` : ''}
              <th></th>
            </tr></thead>
            <tbody>${entryRows}</tbody>
          </table>` : `
          <div class="empty-msg" style="padding:2rem;">
            No athletes entered yet. ${m.schools.length ? 'Use "Import from Roster" or "+ Add Athlete".' : 'Add schools above first.'}
          </div>`}
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  WEIGH-IN VIEW
  // ══════════════════════════════════════════════════════════════════════════
  function _buildWeighInHTML() {
    const m = _meet();
    if (!m) { _view = 'list'; return _buildListHTML(); }
    const wcs = _wcs(m.gender);

    const byWC = {};
    wcs.forEach(wc => { if (m.entries.some(e => e.wc === wc)) byWC[wc] = []; });
    m.entries.forEach(e => { if (!byWC[e.wc]) byWC[e.wc] = []; byWC[e.wc].push(e); });

    const wcSections = Object.entries(byWC).map(([wc, entries]) => {
      const allWeighed = entries.every(e => e.weighIn !== null);
      const rows = entries.map(e => {
        const school     = m.schools.find(s => s.id === e.schoolId);
        const weighed    = e.weighIn !== null;
        const needSnatch = e.discipline === 'both' || e.discipline === 'olympic' || e.discipline === 'exhibition';
        const needBench  = e.discipline === 'both' || e.discipline === 'traditional' || e.discipline === 'exhibition';
        return `<tr style="border-bottom:1px solid var(--dark3);">
          <td style="padding:9px 12px;">
            <div style="font-weight:500;font-size:14px;"><span style="border-bottom:2px solid ${school?.color||'#555'};padding-bottom:1px;">${esc(e.name)}</span>${m.useFlights?` <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:var(--gold-a15);color:var(--gold);font-family:'Barlow Condensed',sans-serif;font-weight:700;">FLT ${e.flight||'A'}</span>`:''}</div>
            <div style="font-size:11px;color:var(--muted);"><span style="color:${school?.color||'var(--muted)'};">${esc(school?.name||'')}</span> · ${{both:'Both',traditional:'Traditional',olympic:'Olympic',exhibition:'Exhibition'}[e.discipline]||e.discipline}</div>
          </td>
          <td style="padding:9px 12px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="number" id="wi-${e.id}" value="${e.weighIn !== null ? e.weighIn : ''}"
                min="50" max="500" step="0.1" placeholder="—"
                style="width:75px;background:var(--dark);color:var(--white);border:1px solid ${weighed?'var(--gold-a50)':'var(--dark3)'};border-radius:4px;padding:5px 7px;font-size:14px;font-family:'Barlow Condensed',sans-serif;"
                oninput="HM.saveWeighIn('${e.id}')">
              <span style="font-size:11px;color:var(--muted);">lbs</span>
              <span id="hm-wi-check-${e.id}" style="color:${weighed?'#5EC08A':'#555'};font-size:${weighed?'15':'12'}px;">${weighed?'✓':'—'}</span>
            </div>
          </td>
          <td style="padding:9px 12px;">
            <div style="display:flex;flex-direction:column;gap:5px;">
              ${needSnatch ? `
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="font-size:11px;color:var(--muted);width:44px;">Snatch</span>
                  <input type="number" id="snopen-${e.id}" value="${e.snatchOpen||''}" min="0" step="5" placeholder="0"
                    style="width:64px;background:var(--dark);color:var(--white);border:1px solid var(--dark3);border-radius:3px;padding:3px 6px;font-size:13px;"
                    oninput="HM.saveOpen('${e.id}','snatch')">
                  <span style="font-size:11px;color:var(--muted);">lbs</span>
                </div>` : ''}
              <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-size:11px;color:var(--muted);width:44px;">C&amp;J</span>
                <input type="number" id="cjopen-${e.id}" value="${e.cjOpen||''}" min="0" step="5" placeholder="0"
                  style="width:64px;background:var(--dark);color:var(--white);border:1px solid var(--dark3);border-radius:3px;padding:3px 6px;font-size:13px;"
                  oninput="HM.saveOpen('${e.id}','cj')">
                <span style="font-size:11px;color:var(--muted);">lbs</span>
              </div>
              ${needBench ? `
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="font-size:11px;color:var(--muted);width:44px;">Bench</span>
                  <input type="number" id="benchopen-${e.id}" value="${e.benchOpen||''}" min="0" step="5" placeholder="0"
                    style="width:64px;background:var(--dark);color:var(--white);border:1px solid var(--dark3);border-radius:3px;padding:3px 6px;font-size:13px;"
                    oninput="HM.saveOpen('${e.id}','bench')">
                  <span style="font-size:11px;color:var(--muted);">lbs</span>
                </div>` : ''}
            </div>
          </td>
        </tr>`;
      }).join('');
      return `
        <div class="chart-card" style="margin-bottom:1rem;max-width:900px;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:.75rem;">
            <span style="font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;">${wc} lbs</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:3px;font-family:'Barlow Condensed',sans-serif;font-weight:600;
              background:${allWeighed?'#5EC08A22':'rgba(200,168,76,0.15)'};color:${allWeighed?'#5EC08A':'#C9A84C'};">
              ${allWeighed ? 'ALL WEIGHED IN' : `${entries.filter(e=>e.weighIn!==null).length}/${entries.length} WEIGHED IN`}
            </span>
          </div>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="border-bottom:2px solid var(--dark3);">
              <th style="text-align:left;padding:5px 12px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Athlete</th>
              <th style="text-align:left;padding:5px 12px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Weigh-In</th>
              <th style="text-align:left;padding:5px 12px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Opening Attempts</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');

    const totalWeighed = m.entries.filter(e => e.weighIn !== null).length;
    const allDone      = totalWeighed === m.entries.length && m.entries.length > 0;

    return `
      <div style="font-size:13px;color:var(--muted);margin-bottom:1.25rem;padding:10px 14px;background:var(--dark2);border:1px solid var(--dark3);border-left:3px solid var(--gold);border-radius:4px;max-width:900px;">
        Record each athlete's actual weigh-in weight and opening attempts. C&J is required for all athletes regardless of discipline.
      </div>
      ${wcSections || '<div class="empty-msg">No entries found.</div>'}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  COMPETITION VIEW
  // ══════════════════════════════════════════════════════════════════════════
  function _buildCompetitionHTML() {
    const m = _meet();
    if (!m) { _view = 'list'; return _buildListHTML(); }
    const lift      = m.status;
    const liftLabel = STATUS_LABEL[lift] || lift;
    const flight    = _flightOrder(m, lift);

    // Split into checked-in (active queue) and waiting (must check in first)
    const checkedIn = flight.filter(e => _checkedIn.has(e.id + ':' + _curIdx(e, lift)));
    // Waiting: sorted so lifters on the current round who are not blocked float to top
    const waiting = flight
      .filter(e => !_checkedIn.has(e.id + ':' + _curIdx(e, lift)))
      .sort((a, b) => {
        const idxA = _curIdx(a, lift); const idxB = _curIdx(b, lift);
        const canA = (_barWeight && idxA === _attemptRound - 1 && !_checkInBlocked(a, lift)) ? 0 : 1;
        const canB = (_barWeight && idxB === _attemptRound - 1 && !_checkInBlocked(b, lift)) ? 0 : 1;
        return canA - canB;
      });
    const current   = checkedIn[0] || null;
    const onDeck    = checkedIn.slice(1);
    const fL        = _compFontLarge; // font-large shorthand

    // Next bar weight suggestion — always +5 lbs
    const nextBarWeight = _barWeight ? _barWeight + 5 : null;

    const roundOrd     = ['1st','2nd','3rd'];
    const nextRoundOrd = roundOrd[_attemptRound]; // e.g. '2nd' when currently on 1st

    // Bar control
    const barControlHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--dark2);border-radius:6px;margin-bottom:.75rem;border:1px solid var(--dark3);flex-wrap:wrap;">
        <span style="font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:1.5px;color:var(--gold);">BAR WEIGHT</span>
        <input type="number" id="hm-bar-input" value="${_barWeight||''}" min="45" step="5" placeholder="—"
          style="width:80px;background:var(--dark);color:var(--white);border:1px solid var(--gold-a50);border-radius:4px;padding:5px 8px;font-size:18px;font-family:'Barlow Condensed',sans-serif;font-weight:700;text-align:right;"
          onkeydown="if(event.key==='Enter') HM.setBarWeight(this.value)">
        <span style="font-size:13px;color:var(--muted);">lbs</span>
        <button onclick="HM.setBarWeight(document.getElementById('hm-bar-input').value)" class="btn btn-gold" style="font-size:12px;padding:4px 14px;">Load</button>
        <div style="width:1px;background:var(--dark3);height:20px;margin:0 4px;"></div>
        <span style="font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700;color:var(--white);padding:3px 12px;background:var(--dark3);border-radius:4px;">
          ${roundOrd[_attemptRound-1]} Attempt
        </span>
        ${_attemptRound < 3 ? `
        <button onclick="HM.advanceAttemptRound()" class="btn btn-outline" style="font-size:12px;padding:4px 14px;">
          → ${nextRoundOrd} Attempt
        </button>` : ''}
        ${checkedIn.length === 0 && nextBarWeight ? `
        <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
          <span style="font-size:12px;color:var(--muted);">Next weight:</span>
          <button onclick="HM.setBarWeight(${nextBarWeight})" class="btn btn-outline" style="font-size:13px;padding:5px 16px;font-family:'Barlow Condensed',sans-serif;font-weight:700;">
            Load ${nextBarWeight} lbs →
          </button>
        </div>` : ''}
      </div>`;

    // NOW LIFTING card
    let nowHTML = '';
    if (current) {
      const idx     = _curIdx(current, lift);
      const att     = current[lift][idx];
      const school  = m.schools.find(s => s.id === current.schoolId);
      const ordinal = ['1st','2nd','3rd'][idx] || (idx+1)+'th';
      const nowColor = school?.color || 'var(--gold)';
      nowHTML = `
        <div style="background:var(--dark2);border:2px solid var(--gold);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1rem;border-left:5px solid ${nowColor};">
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:1.5px;color:var(--gold);margin-bottom:.5rem;">NOW LIFTING</div>
          <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
            <div>
              <div style="font-size:22px;font-weight:700;font-family:'Barlow Condensed',sans-serif;display:flex;align-items:center;gap:8px;"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${nowColor};flex-shrink:0;"></span>${esc(current.name)}</div>
              <div style="font-size:13px;color:var(--muted);margin-top:2px;"><span style="color:${nowColor};">${esc(school?.name||'?')}</span> &nbsp;·&nbsp; ${current.wc} lbs &nbsp;·&nbsp; ${ordinal} attempt</div>
              <div style="font-size:30px;font-weight:700;font-family:'Barlow Condensed',sans-serif;margin-top:.4rem;color:var(--gold);">${att.declared} <span style="font-size:16px;color:var(--muted);">lbs</span></div>
              ${(_clockStart || _clockPausedRemaining !== null) ? `<div style="display:flex;align-items:center;gap:10px;margin-top:.25rem;flex-wrap:wrap;">
                <div ${_clockPausedRemaining !== null
                  ? `data-clock-paused="${_clockPausedRemaining}"`
                  : `data-clock-start="${_clockStart}" data-clock-duration="${_clockDuration}"`}
                  style="font-family:'Barlow Condensed',sans-serif;font-size:40px;font-weight:700;color:#5EC08A;letter-spacing:1px;">
                  ${_clockPausedRemaining !== null ? _fmtClockMs(_clockPausedRemaining) : _fmtClock(_clockStart, _clockDuration)}
                </div>
                ${_clockPausedRemaining !== null
                  ? `<button onclick="HM.resumeClock()" style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;padding:4px 12px;border:2px solid #5EC08A;color:#5EC08A;background:none;border-radius:5px;cursor:pointer;">▶ Resume</button>`
                  : `<button onclick="HM.pauseClock()" style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;padding:4px 12px;border:2px solid #E0A040;color:#E0A040;background:none;border-radius:5px;cursor:pointer;">⏸ Pause</button>`}
                <button onclick="HM.resetClock()" style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;padding:4px 10px;border:2px solid #E07070;color:#E07070;background:none;border-radius:5px;cursor:pointer;">✕</button>
              </div>` : ''}
            </div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
              <button onclick="HM.recordResult('${current.id}','${lift}',${idx},'good')"
                style="background:#1e3d2a;border:2px solid #5EC08A;color:#5EC08A;border-radius:6px;padding:14px 26px;font-size:16px;font-weight:700;font-family:'Barlow Condensed',sans-serif;cursor:pointer;"
                onmouseenter="this.style.background='#2a5a3a'" onmouseleave="this.style.background='#1e3d2a'">
                ✓ GOOD LIFT
              </button>
              <button onclick="HM.recordResult('${current.id}','${lift}',${idx},'miss')"
                style="background:#3d1e1e;border:2px solid #E07070;color:#E07070;border-radius:6px;padding:14px 26px;font-size:16px;font-weight:700;font-family:'Barlow Condensed',sans-serif;cursor:pointer;"
                onmouseenter="this.style.background='#5a2a2a'" onmouseleave="this.style.background='#3d1e1e'">
                ✗ NO LIFT
              </button>
            </div>
          </div>
        </div>`;
    } else if (_phaseComplete(m, lift)) {
      nowHTML = `
        <div style="background:var(--dark2);border:2px solid var(--gold-a30);border-radius:8px;padding:1.5rem;margin-bottom:1rem;text-align:center;">
          <div style="font-size:15px;color:var(--muted);margin-bottom:.75rem;">${liftLabel} phase complete — all athletes have finished.</div>
          <button onclick="HM.advancePhase()" class="btn btn-gold" style="font-size:14px;">
            ${lift === 'bench' ? 'Complete Meet ✓' : 'Advance to Next Phase →'}
          </button>
        </div>`;
    } else {
      nowHTML = `
        <div style="background:var(--dark2);border:1px solid var(--dark3);border-radius:8px;padding:1rem 1.5rem;margin-bottom:1rem;text-align:center;color:var(--muted);font-size:14px;">
          ${_barWeight ? `No athletes checked in at <strong style="color:var(--white);">${_barWeight} lbs</strong>.` : 'Set bar weight above to begin.'}
          ${nextBarWeight && checkedIn.length === 0 ? ` Next weight: <strong style="color:var(--white);">${nextBarWeight} lbs</strong>` : ''}
        </div>`;
    }

    // ON DECK table (athletes at bar weight, waiting their turn)
    let queueHTML = '';
    if (onDeck.length) {
      const qRows = onDeck.map((e, qi) => {
        const idx  = _curIdx(e, lift);
        const att  = e[lift][idx];
        const school = m.schools.find(s => s.id === e.schoolId);
        const ord  = ['1st','2nd','3rd'][idx] || (idx+1)+'th';
        const odColor = school?.color || '#555';
        return `<tr style="border-bottom:1px solid var(--dark3);">
          <td style="padding:${fL?'11px':'8px'} 10px;font-size:12px;color:var(--muted);text-align:center;">${qi+2}</td>
          <td style="padding:${fL?'11px':'8px'} 10px;">
            <div style="font-weight:600;font-size:${fL?'18px':'14px'};"><span style="border-bottom:2px solid ${odColor};padding-bottom:1px;">${esc(e.name)}</span></div>
            <div style="font-size:${fL?'14px':'11px'};color:var(--muted);"><span style="color:${odColor};">${esc(school?.name||'')}</span> · ${e.wc} · ${ord}</div>
          </td>
          <td style="padding:${fL?'11px':'8px'} 10px;">${_dots(e[lift], idx)}</td>
          <td style="padding:${fL?'11px':'8px'} 10px;text-align:right;white-space:nowrap;">
            <span style="font-family:'Barlow Condensed',sans-serif;font-size:${fL?'20px':'16px'};font-weight:700;">${att.declared || '—'}</span>
            <span style="font-size:${fL?'14px':'11px'};color:var(--muted);">lbs</span>
          </td>
          <td style="padding:8px 6px;text-align:center;white-space:nowrap;">
            <button onclick="HM.passAttempt('${e.id}','${lift}')"
              style="background:none;border:1px solid #C9A84C;border-radius:3px;cursor:pointer;color:#C9A84C;font-size:10px;padding:2px 7px;font-family:'Barlow Condensed',sans-serif;font-weight:600;margin-right:4px;"
              onmouseenter="this.style.background='rgba(201,168,76,0.15)'" onmouseleave="this.style.background='none'">PASS</button>
            <button onclick="HM.scratchEntry('${e.id}','${lift}')"
              style="background:none;border:none;cursor:pointer;color:#555;font-size:10px;padding:2px 4px;font-family:'Barlow Condensed',sans-serif;font-weight:600;"
              onmouseenter="this.style.color='#E07070'" onmouseleave="this.style.color='#555'">SCRATCH</button>
          </td>
        </tr>`;
      }).join('');
      queueHTML = `
        <div class="chart-card" style="padding:0;overflow:hidden;margin-bottom:.75rem;">
          <div style="padding:8px 12px;border-bottom:1px solid var(--dark3);font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:600;letter-spacing:1px;color:var(--muted);">ON DECK</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="border-bottom:1px solid var(--dark3);">
              <th style="padding:4px 10px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);text-align:center;">Place</th>
              <th style="text-align:left;padding:4px 10px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);">Athlete</th>
              <th style="text-align:left;padding:4px 10px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);">Atts</th>
              <th style="text-align:right;padding:4px 10px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);">Declared</th>
              <th></th>
            </tr></thead>
            <tbody>${qRows}</tbody>
          </table>
        </div>`;
    }

    // WAITING section (athletes at higher declared weights)
    let waitingHTML = '';
    if (waiting.length) {
      // Track where the first "not yet ready to check in" lifter starts
      let passedDivider = false;
      const wRows = waiting.map(e => {
        const idx  = _curIdx(e, lift);
        const att  = e[lift][idx];
        const school = m.schools.find(s => s.id === e.schoolId);
        const ord  = ['1st','2nd','3rd'][idx] || (idx+1)+'th';
        const canCheckIn = _barWeight && idx === _attemptRound - 1 && !_checkInBlocked(e, lift);
        let divider = '';
        if (!canCheckIn && !passedDivider && waiting.some(x => {
          const xi = _curIdx(x, lift);
          return _barWeight && xi === _attemptRound - 1 && !_checkInBlocked(x, lift);
        })) {
          passedDivider = true;
          divider = `<tr><td colspan="5" style="padding:0;border-top:1px dashed var(--dark3);"></td></tr>`;
        }
        const opacity = canCheckIn ? '1' : '0.55';
        const wtColor = school?.color || '#555';
        return divider + `<tr style="border-bottom:1px solid var(--dark3);opacity:${opacity};">
          <td style="padding:${fL?'10px':'7px'} 10px;font-size:${fL?'17px':'13px'};font-weight:${canCheckIn?'600':'500'};"><span style="border-bottom:2px solid ${wtColor};padding-bottom:1px;">${esc(e.name)}</span></td>
          <td style="padding:${fL?'10px':'7px'} 10px;font-size:${fL?'14px':'11px'};color:var(--muted);"><span style="color:${wtColor};">${esc(school?.name||'')}</span> · ${e.wc} · ${ord}</td>
          <td style="padding:${fL?'10px':'7px'} 10px;">${_dots(e[lift], idx)}</td>
          <td style="padding:${fL?'10px':'7px'} 10px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-size:${fL?'18px':'14px'};font-weight:700;">
            ${att.declared || '—'} <span style="font-size:${fL?'13px':'11px'};color:var(--muted);font-weight:400;">lbs</span>
          </td>
          <td style="padding:7px 6px;text-align:center;white-space:nowrap;">${(() => {
            const blocked    = _barWeight ? _checkInBlocked(e, lift) : null;
            const rightRound = _barWeight && idx === _attemptRound - 1;
            if (blocked) {
              const done = e[lift].filter(a => a.result !== null);
              const highest = done.length ? Math.max(...done.map(a => a.declared)) : 0;
              const label = _barWeight < highest ? `LIFTED ${highest}` : 'MADE THIS WT';
              return `<span style="font-size:10px;color:var(--muted);font-family:'Barlow Condensed',sans-serif;margin-right:4px;">${label}</span>`;
            }
            if (rightRound)  return `<button onclick="HM.checkIn('${e.id}','${lift}')"
              style="background:none;border:1px solid #5EC08A;border-radius:3px;cursor:pointer;color:#5EC08A;font-size:10px;padding:2px 7px;font-family:'Barlow Condensed',sans-serif;font-weight:600;margin-right:4px;"
              onmouseenter="this.style.background='rgba(94,192,138,0.15)'" onmouseleave="this.style.background='none'">CHECK IN</button>`;
            if (_barWeight)  return `<button onclick="HM.overrideCheckIn('${e.id}','${lift}')"
              style="background:none;border:1px solid #888;border-radius:3px;cursor:pointer;color:#888;font-size:10px;padding:2px 7px;font-family:'Barlow Condensed',sans-serif;font-weight:600;margin-right:4px;"
              onmouseenter="this.style.borderColor='#C9A84C';this.style.color='#C9A84C'" onmouseleave="this.style.borderColor='#888';this.style.color='#888'">OVERRIDE</button>`;
            return '';
          })()}
            <button onclick="HM.scratchEntry('${e.id}','${lift}')"
              style="background:none;border:none;cursor:pointer;color:#555;font-size:10px;padding:2px 4px;font-family:'Barlow Condensed',sans-serif;font-weight:600;"
              onmouseenter="this.style.color='#E07070'" onmouseleave="this.style.color='#555'">SCRATCH</button>
          </td>
        </tr>`;
      }).join('');
      waitingHTML = `
        <div class="chart-card" style="padding:0;overflow:hidden;margin-bottom:.75rem;">
          <div style="padding:8px 12px;border-bottom:1px solid var(--dark3);font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:600;letter-spacing:1px;color:var(--muted);">WAITING</div>
          <table style="width:100%;border-collapse:collapse;"><tbody>${wRows}</tbody></table>
        </div>`;
    }

    // COMPLETED section
    const done = m.entries.filter(e => _eligibleForLift(e, lift) && _curIdx(e, lift) < 0);
    let doneHTML = '';
    if (done.length) {
      const dRows = done.map(e => {
        const best   = _bestMade(e[lift]);
        const school = m.schools.find(s => s.id === e.schoolId);
        const doneColor = school?.color || '#555';
        return `<tr style="border-bottom:1px solid var(--dark3);">
          <td style="padding:${fL?'10px':'7px'} 10px;font-size:${fL?'17px':'14px'};font-weight:500;"><span style="border-bottom:2px solid ${doneColor};padding-bottom:1px;">${esc(e.name)}</span></td>
          <td style="padding:${fL?'10px':'7px'} 10px;font-size:${fL?'14px':'12px'};color:var(--muted);"><span style="color:${doneColor};">${esc(school?.name||'')}</span> · ${e.wc}</td>
          <td style="padding:${fL?'10px':'7px'} 10px;">${_dots(e[lift], -1)}</td>
          <td style="padding:${fL?'10px':'7px'} 10px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:${fL?'18px':'15px'};color:${best?'var(--gold)':'#E07070'};">${best ? best+' lbs' : 'Bomb'}</td>
        </tr>`;
      }).join('');
      doneHTML = `
        <div class="chart-card" style="padding:0;overflow:hidden;">
          <div style="padding:8px 12px;border-bottom:1px solid var(--dark3);font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:600;letter-spacing:1px;color:var(--muted);">COMPLETED — ${liftLabel.toUpperCase()}</div>
          <table style="width:100%;border-collapse:collapse;"><tbody>${dRows}</tbody></table>
        </div>`;
    }

    // Timer
    const timerRunning = _timerEndMs !== null && _timerPausedRem === null;
    const hasTimer     = _timerEndMs !== null || _timerPausedRem !== null;
    const timerColor   = !hasTimer ? 'var(--muted)' : 'var(--white)';
    const timerHTML = `
      <div style="display:flex;align-items:center;gap:7px;">
        <span id="hm-timer-display" style="font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:700;min-width:48px;color:${timerColor};">${_fmtTimer()}</span>
        <button onclick="HM.startTimer(300)"  class="btn btn-outline" style="font-size:11px;padding:3px 8px;">5 min</button>
        <button onclick="HM.startTimer(600)" class="btn btn-outline" style="font-size:11px;padding:3px 8px;">10 min</button>
        ${hasTimer ? `
          <button onclick="HM.pauseResumeTimer()" class="btn btn-outline" style="font-size:11px;padding:3px 8px;">${timerRunning?'Pause':'Resume'}</button>
          <button onclick="HM.resetTimer()" class="btn btn-outline" style="font-size:11px;padding:3px 8px;color:#E07070;border-color:#E07070;">Stop</button>` : ''}
      </div>`;

    const phaseComplete = _phaseComplete(m, lift);

    return `
      <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="display:none" onload="HM._onCompMounted()">
      ${_platformActive && _platformInfo ? (() => {
        const base = `http://${_platformInfo.ip}:${_platformInfo.port}`;
        const tok  = _platformInfo.token ? `?pin=${_platformInfo.token}` : '';
        const allComplete = Array.from({length: m.numPlatforms}, (_, i) => i + 1)
          .every(n => (m.platformStates?.[n]?.status || m.status) === 'complete');

        const cards = Array.from({length: m.numPlatforms}, (_, i) => {
          const pNum      = i + 1;
          const ps        = m.platformStates?.[pNum] || {};
          const pStatus   = ps.status || m.status;
          const pLift     = STATUS_LABEL[pStatus] || pStatus;
          const ar        = ps.attemptRound || 1;
          const bw        = ps.barWeight    || null;
          const pEntries  = m.entries.filter(e => e.platform === pNum);
          const ciSet     = new Set(ps.checkedIn || []);
          const isConn    = _connectedPlatforms.includes(pNum);
          const isDone    = pStatus === 'complete';
          const elig      = pEntries.filter(e => _eligibleForLift(e, pStatus));
          const remaining = elig.filter(e => _curIdx(e, pStatus) >= 0).length;
          const doneCount = elig.filter(e => _curIdx(e, pStatus) < 0).length;
          const roundLabel    = ['1st','2nd','3rd'][ar-1] || ar+'th';
          const nextRoundLbl  = ['2nd','3rd'][ar-1];

          // Find current lifter (first checked-in entry)
          let nowName = '', nowWeight = '', nowMeta = '';
          for (const e of pEntries) {
            const idx = _curIdx(e, pStatus);
            if (idx >= 0 && ciSet.has(e.id + ':' + idx)) {
              const sch  = m.schools.find(s => s.id === e.schoolId);
              const att  = e[pStatus][idx];
              const ord  = ['1st','2nd','3rd'][idx] || (idx+1)+'th';
              nowName   = e.name;
              nowWeight = att.declared ? att.declared + ' lbs' : '—';
              nowMeta   = `${esc(sch?.name||'')} · ${e.wc} lbs · ${ord}`;
              break;
            }
          }

          const connDot   = isConn
            ? `<span style="font-size:11px;font-weight:700;color:#5EC08A;padding:2px 8px;background:rgba(94,192,138,.12);border-radius:3px;">● LIVE</span>`
            : `<span style="font-size:11px;font-weight:700;color:#666;padding:2px 8px;background:rgba(100,100,100,.12);border-radius:3px;">○ OFFLINE</span>`;

          const phaseComplete = elig.length > 0 && elig.every(e => e[pStatus].every(a => a.result !== null));

          return `
            <div style="background:var(--dark2);border:1px solid ${isDone?'#5EC08A':isConn?'var(--dark3)':'#333'};border-radius:10px;padding:0;overflow:hidden;">
              <div style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--dark3);">
                <span style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;letter-spacing:1px;color:var(--gold);">PLATFORM ${pNum}</span>
                <div style="display:flex;align-items:center;gap:8px;">
                  ${connDot}
                  <button onclick="window.open('${base}/platform/${pNum}${tok}')"
                    style="font-size:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:var(--gold);background:none;cursor:pointer;padding:2px 7px;border:1px solid var(--gold-a50);border-radius:3px 0 0 3px;">Open ↗</button>
                  <button onclick="HM.copyLink('${base}/platform/${pNum}${tok}')" title="Copy platform link"
                    style="font-size:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:var(--gold);background:none;cursor:pointer;padding:2px 5px;border:1px solid var(--gold-a50);border-left:none;border-radius:0 3px 3px 0;margin-right:4px;">📋</button>
                  <button onclick="window.open('${base}/display/${pNum}${tok}')"
                    style="font-size:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:#5EC08A;background:none;cursor:pointer;padding:2px 7px;border:1px solid rgba(94,192,138,.4);border-radius:3px 0 0 3px;">📺 Display</button>
                  <button onclick="HM.copyLink('${base}/display/${pNum}${tok}')" title="Copy display link"
                    style="font-size:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:#5EC08A;background:none;cursor:pointer;padding:2px 5px;border:1px solid rgba(94,192,138,.4);border-left:none;border-radius:0 3px 3px 0;margin-right:4px;">📋</button>
                  <button onclick="window.open('${base}/referee/${pNum}/1${tok}')"
                    style="font-size:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:#A07FD4;background:none;cursor:pointer;padding:2px 7px;border:1px solid rgba(160,127,212,.4);border-radius:3px 0 0 3px;">⚖ J1</button>
                  <button onclick="HM.copyLink('${base}/referee/${pNum}/1${tok}')" title="Copy Judge 1 link"
                    style="font-size:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:#A07FD4;background:none;cursor:pointer;padding:2px 5px;border:1px solid rgba(160,127,212,.4);border-left:none;border-radius:0 3px 3px 0;">📋</button>
                  <button onclick="window.open('${base}/referee/${pNum}/2${tok}')"
                    style="font-size:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:#A07FD4;background:none;cursor:pointer;padding:2px 7px;border:1px solid rgba(160,127,212,.4);border-radius:3px 0 0 3px;">⚖ J2</button>
                  <button onclick="HM.copyLink('${base}/referee/${pNum}/2${tok}')" title="Copy Judge 2 link"
                    style="font-size:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:#A07FD4;background:none;cursor:pointer;padding:2px 5px;border:1px solid rgba(160,127,212,.4);border-left:none;border-radius:0 3px 3px 0;">📋</button>
                  <button onclick="window.open('${base}/referee/${pNum}/3${tok}')"
                    style="font-size:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:#A07FD4;background:none;cursor:pointer;padding:2px 7px;border:1px solid rgba(160,127,212,.4);border-radius:3px 0 0 3px;">⚖ J3</button>
                  <button onclick="HM.copyLink('${base}/referee/${pNum}/3${tok}')" title="Copy Judge 3 link"
                    style="font-size:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:#A07FD4;background:none;cursor:pointer;padding:2px 5px;border:1px solid rgba(160,127,212,.4);border-left:none;border-radius:0 3px 3px 0;">📋</button>
                </div>
              </div>

              <div style="padding:10px 14px;border-bottom:1px solid var(--dark3);">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <span style="font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;">${isDone?'✓ COMPLETE':pLift}</span>
                  ${!isDone?`<span style="font-size:11px;color:var(--muted);">${roundLabel} Attempt</span>`:``}
                  ${!isDone&&bw?`<span style="font-size:11px;font-weight:700;padding:1px 7px;background:rgba(94,192,138,.1);color:#5EC08A;border-radius:3px;">BAR: ${bw} lbs</span>`:''}
                </div>
              </div>

              <div style="padding:10px 14px;min-height:64px;border-bottom:1px solid var(--dark3);">
                ${nowName ? `
                  <div style="font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--gold);margin-bottom:4px;">NOW LIFTING</div>
                  <div style="font-size:16px;font-weight:700;">${esc(nowName)}</div>
                  <div style="font-size:11px;color:var(--muted);">${nowMeta}</div>
                  <div style="display:flex;align-items:center;gap:10px;margin-top:2px;flex-wrap:wrap;">
                    <div style="font-size:19px;font-weight:700;color:var(--gold);font-family:'Barlow Condensed',sans-serif;">${nowWeight}</div>
                    ${(ps.clockStart || ps.clockPausedRemaining != null) ? `
                    <div ${ps.clockPausedRemaining != null
                      ? `data-clock-paused="${ps.clockPausedRemaining}"`
                      : `data-clock-start="${ps.clockStart}" data-clock-duration="${ps.clockDuration}"`}
                      style="font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:700;color:#5EC08A;letter-spacing:.5px;">
                      ${ps.clockPausedRemaining != null ? _fmtClockMs(ps.clockPausedRemaining) : _fmtClock(ps.clockStart, ps.clockDuration)}
                    </div>
                    ${ps.clockPausedRemaining != null
                      ? `<button onclick="HM.directorResumeClock(${pNum})" style="font-size:9px;font-family:'Barlow Condensed',sans-serif;font-weight:700;padding:2px 7px;border:1px solid #5EC08A;color:#5EC08A;background:none;border-radius:3px;cursor:pointer;">▶</button>`
                      : `<button onclick="HM.directorPauseClock(${pNum})" style="font-size:9px;font-family:'Barlow Condensed',sans-serif;font-weight:700;padding:2px 7px;border:1px solid #E0A040;color:#E0A040;background:none;border-radius:3px;cursor:pointer;">⏸</button>`}
                    <button onclick="HM.directorResetClock(${pNum})" style="font-size:9px;font-family:'Barlow Condensed',sans-serif;font-weight:700;padding:2px 7px;border:1px solid #E07070;color:#E07070;background:none;border-radius:3px;cursor:pointer;">✕</button>
                    ` : ''}
                  </div>
                ` : isDone ? `
                  <div style="font-size:13px;color:#5EC08A;font-weight:600;padding:8px 0;">All lifters finished 🏆</div>
                ` : `
                  <div style="font-size:12px;color:var(--muted);padding:8px 0;">${bw?`Bar at ${bw} lbs — waiting for check-in`:'Waiting for bar weight'}</div>
                `}
              </div>

              ${(() => {
                const waitingElig = pEntries
                  .filter(e => _eligibleForLift(e, pStatus) && _curIdx(e, pStatus) >= 0 && !ciSet.has(e.id + ':' + _curIdx(e, pStatus)))
                  .slice(0, 4);
                if (!waitingElig.length || isDone) return '';
                return `<div style="padding:6px 14px;border-bottom:1px solid var(--dark3);">
                  <div style="font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--muted);margin-bottom:4px;">WAITING</div>
                  ${waitingElig.map(e => {
                    const idx = _curIdx(e, pStatus);
                    const att = e[pStatus][idx];
                    return `<div style="display:flex;align-items:center;gap:6px;padding:2px 0;">
                      <span style="flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.name)}</span>
                      <span style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;color:var(--gold);flex-shrink:0;">${att.declared||'—'} lbs</span>
                      <button onclick="HM.directorDeclareAttempt(${pNum},'${e.id}','${pStatus}',${idx},${att.declared||0})"
                        style="font-size:9px;font-family:'Barlow Condensed',sans-serif;font-weight:700;color:var(--muted);background:none;border:1px solid #444;border-radius:3px;cursor:pointer;padding:1px 6px;flex-shrink:0;">DECLARE</button>
                    </div>`;
                  }).join('')}
                </div>`;
              })()}

              ${(() => {
                const jv = ps.judgeVotes || {};
                const anyVote = jv[1] || jv[2] || jv[3];
                if (!anyVote) return '';
                function lightStyle(v) {
                  if (v === 'good') return 'background:#1e5c35;border-color:#5EC08A;color:#5EC08A;';
                  if (v === 'no')   return 'background:#5c1e1e;border-color:#E07070;color:#E07070;';
                  return 'background:#222;border-color:#444;color:#555;';
                }
                return `<div style="padding:6px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--dark3);">
                  <span style="font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--muted);">JUDGES</span>
                  ${[1,2,3].map(n => `<div style="width:28px;height:28px;border-radius:50%;border:2px solid #444;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;${lightStyle(jv[n])}">${n}</div>`).join('')}
                </div>`;
              })()}

              <div style="padding:8px 14px;display:flex;align-items:center;gap:12px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--dark3);">
                <span>${pEntries.length} lifters</span>
                <span>·</span>
                <span style="color:${remaining?'var(--white)':'#5EC08A'};font-weight:${remaining?'400':'600'};">${remaining} remaining</span>
                <span>·</span>
                <span>${doneCount} done</span>
              </div>

              ${!isDone ? `
              <div style="padding:8px 14px;display:flex;gap:6px;flex-wrap:wrap;">
                <button onclick="HM.directorSetBarWeight(${pNum})" class="btn btn-outline" style="font-size:11px;padding:3px 9px;">Set Bar</button>
                ${ar < 3 && nextRoundLbl ? `<button onclick="HM.directorAdvanceRound(${pNum})" class="btn btn-outline" style="font-size:11px;padding:3px 9px;">→ ${nextRoundLbl} Att</button>` : ''}
                ${phaseComplete ? `<button onclick="HM.directorAdvancePhase(${pNum})" class="btn btn-gold" style="font-size:11px;padding:3px 9px;">Next Phase →</button>` : ''}
              </div>` : ''}
            </div>`;
        }).join('');

        const cols = m.numPlatforms <= 3 ? m.numPlatforms : m.numPlatforms <= 6 ? 3 : 4;

        return `
          <div style="display:grid;grid-template-columns:3fr 2fr;gap:1.25rem;align-items:start;">
            <div>
              <div style="background:rgba(201,168,76,.08);border:1px solid rgba(201,168,76,.3);border-radius:10px;padding:14px 18px;margin-bottom:.85rem;display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
                <div>
                  <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--muted);margin-bottom:3px;">CONNECT AT</div>
                  <div style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;color:var(--white);">${base}</div>
                </div>
                <div style="width:1px;height:36px;background:rgba(201,168,76,.25);flex-shrink:0;"></div>
                <div>
                  <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--muted);margin-bottom:2px;">PIN</div>
                  <div style="font-family:'Barlow Condensed',sans-serif;font-size:38px;font-weight:900;letter-spacing:8px;color:var(--gold);line-height:1;">${_platformInfo.token}</div>
                </div>
                <div style="width:1px;height:36px;background:rgba(201,168,76,.25);flex-shrink:0;"></div>
                <div style="font-size:11px;color:var(--muted);line-height:1.6;">
                  <div><span style="color:var(--white);font-weight:600;">Platform:</span> /platform/<em>N</em>?pin=${_platformInfo.token}</div>
                  <div><span style="color:var(--white);font-weight:600;">Judge:</span> /referee/<em>N</em>/<em>1-3</em>?pin=${_platformInfo.token}</div>
                  <div><span style="color:var(--white);font-weight:600;">Display:</span> /display/<em>N</em>?pin=${_platformInfo.token}</div>
                </div>
                <div style="margin-left:auto;display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
                  <span style="font-size:11px;color:${_connectedPlatforms.length>0?'#5EC08A':'var(--muted)'};">${_connectedPlatforms.length} of ${m.numPlatforms} connected</span>
                  <a href="#" onclick="event.preventDefault();window.open('${base}/scoreboard${tok}')" style="font-size:11px;color:var(--gold);text-decoration:none;border:1px solid var(--gold-a50);border-radius:3px;padding:2px 10px;font-family:'Barlow Condensed',sans-serif;font-weight:700;">📊 Scoreboard ↗</a>
                </div>
              </div>
              ${allComplete ? `
                <div style="background:rgba(94,192,138,.1);border:2px solid #5EC08A;border-radius:8px;padding:14px 18px;margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
                  <span style="font-size:15px;font-weight:700;color:#5EC08A;">🏆 All platforms complete</span>
                  <button onclick="HM.advancePhase()" class="btn btn-gold" style="font-size:13px;">Complete Meet ✓</button>
                </div>` : ''}
              <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:.75rem;">${cards}</div>
            </div>
            <div style="position:sticky;top:80px;">${_buildScoreboard(m)}</div>
          </div>`;
      })() : `
      ${m.useFlights ? `
      <div style="display:flex;gap:0;margin-bottom:1rem;border-radius:6px;overflow:hidden;border:1px solid var(--dark3);width:fit-content;">
        ${['A','B'].map(f => `
          <button onclick="HM._setFlight('${f}')"
            style="padding:8px 28px;border:none;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;letter-spacing:.5px;
              background:${_activeFlight===f?'var(--gold)':'var(--dark3)'};color:${_activeFlight===f?'#000':'var(--muted)'};transition:all .15s;">
            Flight ${f} ${_activeFlight===f?'●':''}
          </button>`).join('')}
      </div>` : ''}
      <div style="display:grid;grid-template-columns:3fr 2fr;gap:1.25rem;align-items:start;">
        <div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:.75rem;">${liftLabel} — Bar Control</div>
          ${barControlHTML}
          ${nowHTML}
          ${queueHTML}
          ${waitingHTML}
          ${doneHTML}
        </div>
        <div style="position:sticky;top:80px;">${_buildScoreboard(m)}</div>
      </div>`}
      `;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SCOREBOARD
  // ══════════════════════════════════════════════════════════════════════════
  function _buildScoreboard(m) {
    const wcs  = _wcs(m.gender);
    const N    = m.schools.length;
    const pts  = _teamPoints(N);

    const thS  = 'padding:3px 7px;font-family:\'Barlow Condensed\',sans-serif;font-size:9px;color:var(--muted);text-align:center;';
    const thSR = thS + 'text-align:right;';

    const tabBtn = (key, label) =>
      `<button onclick="HM._setScoreTab('${key}')"
        style="flex:1;padding:6px 4px;border:none;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:600;letter-spacing:.5px;
        background:${_scoreTab===key?'var(--gold-a15)':'var(--dark3)'};
        color:${_scoreTab===key?'var(--gold)':'var(--muted)'};
        border-bottom:2px solid ${_scoreTab===key?'var(--gold)':'transparent'};">${label}</button>`;

    // ── helpers shared by both individual tabs ────────────────────────────────
    function wcSection(wc, headerRow, bodyRows) {
      return `
        <div style="margin-bottom:.75rem;">
          <div style="padding:4px 7px;background:var(--dark3);font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;">${wc} LBS</div>
          <table style="width:100%;border-collapse:collapse;"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>
        </div>`;
    }

    function teamTable(title, rows) {
      return `
        <div style="margin-bottom:1.25rem;">
          <div style="padding:5px 7px;background:rgba(201,168,76,.12);border-bottom:1px solid var(--gold-a15);font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:700;letter-spacing:1px;color:var(--gold);">${title}</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr>
              <th style="${thS}">Place</th>
              <th style="${thS}text-align:left;">School</th>
              <th style="${thSR}">PTS</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    let content = '';

    // ── Olympic individual tab ────────────────────────────────────────────────
    if (_scoreTab === 'olympic') {
      const elig = m.entries.filter(e => e.discipline === 'both' || e.discipline === 'olympic');
      content = !elig.length
        ? `<div class="empty-msg" style="padding:1.5rem;font-size:13px;">No Olympic-division athletes.</div>`
        : wcs.filter(wc => elig.some(e => e.wc === wc)).map(wc => {
            const group = elig.filter(e => e.wc === wc)
              .map(e => ({ e, sn: _bestMade(e.snatch), cj: _bestMade(e.cj), tot: _olympicTotal(e) }))
              .sort(_rankCmp);
            let pIdx = -1;
            const rows = group.map(r => {
              if (r.tot > 0) pIdx++;
              const placeNum    = r.tot > 0 ? pIdx + 1 : null;
              const earnedPts   = placeNum && pIdx < pts.length ? pts[pIdx] : null;
              const medal       = placeNum === 1 ? '🥇' : placeNum === 2 ? '🥈' : placeNum === 3 ? '🥉' : null;
              const placeDisplay = medal || placeNum || '—';
              const sch = m.schools.find(s => s.id === r.e.schoolId);
              const schColor = sch?.color || '#555';
              return `<tr style="border-bottom:1px solid var(--dark3);">
                <td style="padding:5px 7px;font-size:${medal?'15px':'13px'};font-weight:700;">${placeDisplay}</td>
                <td style="padding:5px 7px;font-size:13px;"><span style="border-bottom:2px solid ${schColor};padding-bottom:1px;">${esc(r.e.name)}</span></td>
                <td style="padding:5px 7px;font-size:11px;color:var(--muted);">${esc(sch?.name||'')}</td>
                <td style="padding:5px 7px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-size:12px;">${r.sn||'—'}</td>
                <td style="padding:5px 7px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-size:12px;">${r.cj||'—'}</td>
                <td style="padding:5px 7px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-weight:700;color:${r.tot?'var(--gold)':'#E07070'};">${r.tot||'0'}</td>
                <td style="padding:5px 7px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-size:11px;color:${earnedPts?'#5EC08A':'var(--muted)'};">${earnedPts!=null?'+'+earnedPts:'—'}</td>
              </tr>`;
            }).join('');
            const hdr = `<tr><th style="${thS}">Place</th><th style="${thS}text-align:left;">Athlete</th><th style="${thS}text-align:left;">School</th><th style="${thSR}">SN</th><th style="${thSR}">CJ</th><th style="${thSR}">TOT</th><th style="${thSR}">PTS</th></tr>`;
            return wcSection(wc, hdr, rows);
          }).join('');

    // ── Traditional individual tab ────────────────────────────────────────────
    } else if (_scoreTab === 'traditional') {
      const elig = m.entries.filter(e => e.discipline === 'both' || e.discipline === 'traditional');
      content = !elig.length
        ? `<div class="empty-msg" style="padding:1.5rem;font-size:13px;">No Traditional-division athletes.</div>`
        : wcs.filter(wc => elig.some(e => e.wc === wc)).map(wc => {
            const group = elig.filter(e => e.wc === wc)
              .map(e => ({ e, cj: _bestMade(e.cj), bn: _bestMade(e.bench), tot: _traditionalTotal(e) }))
              .sort(_rankCmp);
            let pIdx = -1;
            const rows = group.map(r => {
              if (r.tot > 0) pIdx++;
              const placeNum    = r.tot > 0 ? pIdx + 1 : null;
              const earnedPts   = placeNum && pIdx < pts.length ? pts[pIdx] : null;
              const medal       = placeNum === 1 ? '🥇' : placeNum === 2 ? '🥈' : placeNum === 3 ? '🥉' : null;
              const placeDisplay = medal || placeNum || '—';
              const sch = m.schools.find(s => s.id === r.e.schoolId);
              const schColor = sch?.color || '#555';
              return `<tr style="border-bottom:1px solid var(--dark3);">
                <td style="padding:5px 7px;font-size:${medal?'15px':'13px'};font-weight:700;">${placeDisplay}</td>
                <td style="padding:5px 7px;font-size:13px;"><span style="border-bottom:2px solid ${schColor};padding-bottom:1px;">${esc(r.e.name)}</span></td>
                <td style="padding:5px 7px;font-size:11px;color:var(--muted);">${esc(sch?.name||'')}</td>
                <td style="padding:5px 7px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-size:12px;">${r.cj||'—'}</td>
                <td style="padding:5px 7px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-size:12px;">${r.bn||'—'}</td>
                <td style="padding:5px 7px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-weight:700;color:${r.tot?'var(--gold)':'#E07070'};">${r.tot||'0'}</td>
                <td style="padding:5px 7px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-size:11px;color:${earnedPts?'#5EC08A':'var(--muted)'};">${earnedPts!=null?'+'+earnedPts:'—'}</td>
              </tr>`;
            }).join('');
            const hdr = `<tr><th style="${thS}">Place</th><th style="${thS}text-align:left;">Athlete</th><th style="${thS}text-align:left;">School</th><th style="${thSR}">C&amp;J</th><th style="${thSR}">Bench</th><th style="${thSR}">TOT</th><th style="${thSR}">PTS</th></tr>`;
            return wcSection(wc, hdr, rows);
          }).join('');

    // ── Team tab ──────────────────────────────────────────────────────────────
    } else {
      const scores = {};
      m.schools.forEach(s => { scores[s.id] = { id: s.id, name: s.name, olympic: 0, traditional: 0 }; });

      const oElig = m.entries.filter(e => e.discipline === 'both' || e.discipline === 'olympic');
      wcs.filter(wc => oElig.some(e => e.wc === wc)).forEach(wc => {
        const grp = oElig.filter(e => e.wc === wc)
          .map(e => ({ e, tot: _olympicTotal(e) }))
          .sort(_rankCmp);
        let p = 0;
        grp.forEach(r => {
          if (r.tot > 0 && scores[r.e.schoolId] && p < pts.length) {
            scores[r.e.schoolId].olympic += pts[p++];
          }
        });
      });

      const tElig = m.entries.filter(e => e.discipline === 'both' || e.discipline === 'traditional');
      wcs.filter(wc => tElig.some(e => e.wc === wc)).forEach(wc => {
        const grp = tElig.filter(e => e.wc === wc)
          .map(e => ({ e, tot: _traditionalTotal(e) }))
          .sort(_rankCmp);
        let p = 0;
        grp.forEach(r => {
          if (r.tot > 0 && scores[r.e.schoolId] && p < pts.length) {
            scores[r.e.schoolId].traditional += pts[p++];
          }
        });
      });

      const allSchools = Object.values(scores);

      const oSorted = [...allSchools].sort((a,b) => b.olympic - a.olympic);
      const oRows = oSorted.map((s, i) => `
        <tr style="border-bottom:1px solid var(--dark3);">
          <td style="padding:6px 8px;font-family:'Barlow Condensed',sans-serif;font-weight:700;color:${i===0&&s.olympic>0?'var(--gold)':'var(--muted)'};">${i+1}</td>
          <td style="padding:6px 8px;font-size:13px;font-weight:600;">${esc(s.name)}</td>
          <td style="padding:6px 8px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:15px;color:${s.olympic>0?(i===0?'var(--gold)':'var(--white)'):'var(--muted)'};">${s.olympic}</td>
        </tr>`).join('');

      const tSorted = [...allSchools].sort((a,b) => b.traditional - a.traditional);
      const tRows = tSorted.map((s, i) => `
        <tr style="border-bottom:1px solid var(--dark3);">
          <td style="padding:6px 8px;font-family:'Barlow Condensed',sans-serif;font-weight:700;color:${i===0&&s.traditional>0?'var(--gold)':'var(--muted)'};">${i+1}</td>
          <td style="padding:6px 8px;font-size:13px;font-weight:600;">${esc(s.name)}</td>
          <td style="padding:6px 8px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:15px;color:${s.traditional>0?(i===0?'var(--gold)':'var(--white)'):'var(--muted)'};">${s.traditional}</td>
        </tr>`).join('');

      const combined = allSchools.map(s => ({ ...s, total: s.olympic + s.traditional })).sort((a,b) => b.total - a.total);
      const cRows = combined.map((s, i) => `
        <tr style="border-bottom:1px solid var(--dark3);">
          <td style="padding:6px 8px;font-family:'Barlow Condensed',sans-serif;font-weight:700;color:${i===0&&s.total>0?'var(--gold)':'var(--muted)'};">${i+1}</td>
          <td style="padding:6px 8px;font-size:13px;font-weight:600;">${esc(s.name)}</td>
          <td style="padding:6px 8px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-size:12px;color:var(--muted);">${s.olympic} + ${s.traditional}</td>
          <td style="padding:6px 8px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:${s.total>0?(i===0?'var(--gold)':'var(--white)'):'var(--muted)'};">${s.total}</td>
        </tr>`).join('');
      const combinedTable = `
        <div style="margin-bottom:1.25rem;">
          <div style="padding:5px 7px;background:rgba(201,168,76,.12);border-bottom:1px solid var(--gold-a15);font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:700;letter-spacing:1px;color:var(--gold);">COMBINED TOTAL</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr>
              <th style="${thS}">Place</th>
              <th style="${thS}text-align:left;">School</th>
              <th style="${thSR}">OLY + TRAD</th>
              <th style="${thSR}">TOTAL</th>
            </tr></thead>
            <tbody>${cRows}</tbody>
          </table>
        </div>`;

      content = teamTable('OLYMPIC TEAM SCORES', oRows) + teamTable('TRADITIONAL TEAM SCORES', tRows) + combinedTable;
    }

    return `
      <div class="chart-card" style="padding:0;overflow:hidden;">
        <div style="padding:8px 12px;border-bottom:1px solid var(--dark3);font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:600;letter-spacing:1px;color:var(--muted);">LIVE SCOREBOARD</div>
        <div style="display:flex;border-bottom:1px solid var(--dark3);">
          ${tabBtn('olympic','Olympic')}${tabBtn('traditional','Traditional')}${tabBtn('team','Team')}
        </div>
        <div style="padding:.75rem;max-height:60vh;overflow-y:auto;">${content}</div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  RESULTS VIEW
  // ══════════════════════════════════════════════════════════════════════════
  function _buildResultsHTML() {
    const m = _meet();
    if (!m) { _view = 'list'; return _buildListHTML(); }
    const wcs = _wcs(m.gender);
    const discMap = { both:'Both', traditional:'Traditional', olympic:'Olympic', exhibition:'Exhibition' };

    const wcSections = wcs.filter(wc => m.entries.some(e => e.wc === wc)).map(wc => {
      const entries = m.entries.filter(e => e.wc === wc);
      const rows = entries.map(e => {
        const school   = m.schools.find(s => s.id === e.schoolId);
        const hasSnatch = e.discipline === 'both' || e.discipline === 'olympic' || e.discipline === 'exhibition';
        const hasBench  = e.discipline === 'both' || e.discipline === 'traditional' || e.discipline === 'exhibition';
        const oTot = hasSnatch ? _olympicTotal(e) : null;
        const tTot = hasBench  ? _traditionalTotal(e) : null;
        const resColor = school?.color || '#555';
        return `<tr style="border-bottom:1px solid var(--dark3);">
          <td style="padding:8px 10px;font-weight:500;cursor:pointer;" onclick="HM.openEditResultModal('${e.id}')" title="Click to edit results"><span style="border-bottom:2px solid ${resColor};padding-bottom:1px;">${esc(e.name)}</span> <span style="font-size:10px;color:var(--muted);font-family:'Barlow Condensed',sans-serif;">✏</span></td>
          <td style="padding:8px 10px;font-size:12px;color:${school?.color||'var(--muted)'};">${esc(school?.name||'')}</td>
          <td style="padding:8px 10px;font-size:11px;text-align:center;color:var(--muted);">${discMap[e.discipline]||e.discipline}</td>
          ${hasSnatch
            ? `<td style="padding:8px 6px;text-align:center;">${_dots(e.snatch,-1)}</td>
               <td style="padding:8px 6px;text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:13px;">${_bestMade(e.snatch)||'—'}</td>`
            : `<td colspan="2" style="padding:8px 6px;"></td>`}
          <td style="padding:8px 6px;text-align:center;">${_dots(e.cj,-1)}</td>
          <td style="padding:8px 6px;text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:13px;">${_bestMade(e.cj)||'—'}</td>
          ${hasBench
            ? `<td style="padding:8px 6px;text-align:center;">${_dots(e.bench,-1)}</td>
               <td style="padding:8px 6px;text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:13px;">${_bestMade(e.bench)||'—'}</td>`
            : `<td colspan="2" style="padding:8px 6px;"></td>`}
          <td style="padding:8px 10px;text-align:right;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;white-space:nowrap;">
            ${oTot !== null ? `<div style="color:${oTot?'var(--gold)':'#E07070'};">O: ${oTot||'0'}</div>` : ''}
            ${tTot !== null ? `<div style="color:${tTot?'var(--gold)':'#E07070'};">T: ${tTot||'0'}</div>` : ''}
          </td>
        </tr>`;
      }).join('');
      return `
        <div class="chart-card" style="margin-bottom:1rem;padding:0;overflow:hidden;">
          <div style="padding:8px 12px;background:var(--dark3);font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;">${wc} LBS</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="border-bottom:1px solid var(--dark3);">
              <th style="text-align:left;padding:6px 10px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);">Athlete</th>
              <th style="text-align:left;padding:6px 10px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);">School</th>
              <th style="text-align:center;padding:6px 6px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);">Disc</th>
              <th style="text-align:center;padding:6px 6px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);" colspan="2">Snatch</th>
              <th style="text-align:center;padding:6px 6px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);" colspan="2">C&amp;J</th>
              <th style="text-align:center;padding:6px 6px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);" colspan="2">Bench</th>
              <th style="text-align:right;padding:6px 10px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);">Total</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');

    return `
      <div style="display:grid;grid-template-columns:3fr 2fr;gap:1.25rem;align-items:start;">
        <div>${wcSections}</div>
        <div style="position:sticky;top:80px;">${_buildScoreboard(m)}</div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SETUP ACTIONS
  // ══════════════════════════════════════════════════════════════════════════
  function newMeet() {
    const id = _uid('hm');
    _meets.push({ id, name:'', date:'', location:'', gender:'Boys', status:'setup', useFlights:false, numPlatforms:0, platformStates:{}, schools:[], entries:[] });
    _activeMeetId = id;
    _save();
    _view = 'setup';
    renderMain();
  }

  function autoSaveSetup() {
    const m = _meet(); if (!m) return;
    const n = document.getElementById('hm-name');
    const d = document.getElementById('hm-date');
    const l = document.getElementById('hm-location');
    const g = document.getElementById('hm-gender');
    const p = document.getElementById('hm-num-platforms');
    if (n) m.name         = n.value.trim();
    if (d) m.date         = d.value;
    if (l) m.location     = l.value.trim();
    if (g) m.gender       = g.value;
    if (p) m.numPlatforms = parseInt(p.value) || 0;
    _save();
  }

  function saveSetupAndProceed() {
    const m = _meet(); if (!m) return;
    autoSaveSetup();
    if (!m.name.trim())       { alert('Enter a meet name.');              return; }
    if (m.schools.length < 2) { alert('Add at least 2 schools.');         return; }
    if (!m.entries.length)    { alert('Add at least one athlete entry.'); return; }
    m.status = 'weigh-in';
    _save();
    _view = 'weighin';
    renderMain();
  }

  function openAddSchoolModal(isHome) {
    const m = _meet(); if (!m) return;
    autoSaveSetup();
    if (isHome && m.schools.some(s => s.isHome)) { alert('A home school is already added.'); return; }
    const defaultName = isHome && typeof team === 'function' ? (team()?.name || '') : '';
    document.getElementById('modal-body').innerHTML = `
      <h3>${isHome ? 'Add Home School' : 'Add Visiting School'}</h3>
      <div class="form-field">
        <label>School Name</label>
        <input type="text" id="hm-school-name" value="${esc(defaultName)}" placeholder="School name" style="font-size:15px;">
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-gold" onclick="HM.saveSchool(${isHome})">Add School</button>
      </div>`;
    document.getElementById('overlay').style.display = 'flex';
    setTimeout(() => { const el = document.getElementById('hm-school-name'); if(el){el.focus();el.select();} }, 50);
  }

  function saveSchool(isHome) {
    const name = document.getElementById('hm-school-name')?.value.trim();
    if (!name) { alert('Enter a school name.'); return; }
    const m = _meet(); if (!m) return;
    const defaultColors = ['#E85252','#3A86D4','#5EC08A','#FFD700','#A87FD4','#E8A052','#F5F5F5'];
    const color = defaultColors[m.schools.length % defaultColors.length];
    m.schools.push({ id: _uid('sch'), name, isHome: !!isHome, color });
    _save(); closeModal(); renderMain();
  }

  function setSchoolColor(schoolId, color) {
    const m = _meet(); if (!m) return;
    const s = m.schools.find(x => x.id === schoolId); if (!s) return;
    s.color = color;
    _save(); renderMain();
  }

  function removeSchool(schoolId) {
    const m = _meet(); if (!m) return;
    const s = m.schools.find(x => x.id === schoolId);
    if (!confirm(`Remove "${s?.name}"? All athletes from this school will also be removed.`)) return;
    m.schools = m.schools.filter(x => x.id !== schoolId);
    m.entries = m.entries.filter(e => e.schoolId !== schoolId);
    _save(); renderMain();
  }

  function openAddEntryModal() {
    const m = _meet(); if (!m) return;
    autoSaveSetup();
    const wcs      = _wcs(m.gender);
    const schoolOpts = m.schools.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    document.getElementById('modal-body').innerHTML = `
      <h3>Add Athlete Entry</h3>
      <div class="fg2">
        <div class="form-field"><label>Athlete Name</label><input type="text" id="hm-ent-name" placeholder="Full name"></div>
        <div class="form-field"><label>School</label><select id="hm-ent-school">${schoolOpts}</select></div>
      </div>
      <div class="fg2">
        <div class="form-field">
          <label>Weight Class</label>
          <select id="hm-ent-wc">${wcs.map(w => `<option value="${w}">${w} lbs</option>`).join('')}</select>
        </div>
        <div class="form-field">
          <label>Discipline</label>
          <select id="hm-ent-disc">
            <option value="both">Both (Olympic + Traditional)</option>
            <option value="traditional">Traditional only (C&amp;J + Bench)</option>
            <option value="olympic">Olympic only (Snatch + C&amp;J)</option>
            <option value="exhibition">Exhibition</option>
          </select>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-gold" onclick="HM.saveEntry()">Add Athlete</button>
      </div>`;
    document.getElementById('overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('hm-ent-name')?.focus(), 50);
  }

  function saveEntry() {
    const m = _meet(); if (!m) return;
    const name       = document.getElementById('hm-ent-name')?.value.trim();
    const schoolId   = document.getElementById('hm-ent-school')?.value;
    const wc         = document.getElementById('hm-ent-wc')?.value;
    const discipline = document.getElementById('hm-ent-disc')?.value || 'both';
    if (!name)     { alert('Enter athlete name.'); return; }
    if (!schoolId) { alert('Select a school.');    return; }
    const existing = m.entries.filter(e => e.schoolId === schoolId && e.wc === wc && e.discipline !== 'exhibition');
    if (discipline !== 'exhibition' && existing.length >= 2) {
      const sn = m.schools.find(s => s.id === schoolId)?.name || 'this school';
      alert(`Max 2 competitive lifters per weight class per school. ${sn} already has 2 entries in the ${wc} lb class.`); return;
    }
    m.entries.push(_blankEntry(name, schoolId, wc, discipline, null, null));
    _save(); closeModal(); renderMain();
  }

  function removeEntry(entryId) {
    const m = _meet(); if (!m) return;
    m.entries = m.entries.filter(e => e.id !== entryId);
    _save(); renderMain();
  }

  function openEditEntryModal(entryId) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const wcs = _wcs(m.gender);
    const schoolOpts = m.schools.map(s => `<option value="${s.id}" ${s.id===e.schoolId?'selected':''}>${esc(s.name)}</option>`).join('');
    const wcOpts = wcs.map(w => `<option value="${w}" ${w===e.wc?'selected':''}>${w} lbs</option>`).join('');
    document.getElementById('modal-body').innerHTML = `
      <h3>Edit Athlete</h3>
      <div class="fg2">
        <div class="form-field"><label>Athlete Name</label><input type="text" id="hm-edit-name" value="${esc(e.name)}" placeholder="Full name"></div>
        <div class="form-field"><label>School</label><select id="hm-edit-school">${schoolOpts}</select></div>
      </div>
      <div class="fg2">
        <div class="form-field">
          <label>Weight Class</label>
          <select id="hm-edit-wc">${wcOpts}</select>
        </div>
        <div class="form-field">
          <label>Discipline</label>
          <select id="hm-edit-disc">
            <option value="both"        ${e.discipline==='both'        ?'selected':''}>Both (Olympic + Traditional)</option>
            <option value="traditional" ${e.discipline==='traditional' ?'selected':''}>Traditional only (C&amp;J + Bench)</option>
            <option value="olympic"     ${e.discipline==='olympic'     ?'selected':''}>Olympic only (Snatch + C&amp;J)</option>
            <option value="exhibition"  ${e.discipline==='exhibition'  ?'selected':''}>Exhibition</option>
          </select>
        </div>
      </div>
      <div class="form-field" style="margin-bottom:.5rem;">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="hm-edit-opt" ${e.publicOptOut?'checked':''} style="accent-color:var(--gold);">
          <span>Public opt-out (hide name on displays)</span>
        </label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-gold" onclick="HM.saveEditEntry('${entryId}')">Save</button>
      </div>`;
    document.getElementById('overlay').style.display = 'flex';
    setTimeout(() => { const el = document.getElementById('hm-edit-name'); if(el){el.focus();el.select();} }, 50);
  }

  function saveEditEntry(entryId) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const name       = document.getElementById('hm-edit-name')?.value.trim();
    const schoolId   = document.getElementById('hm-edit-school')?.value;
    const wc         = document.getElementById('hm-edit-wc')?.value;
    const discipline = document.getElementById('hm-edit-disc')?.value || 'both';
    const publicOptOut = !!document.getElementById('hm-edit-opt')?.checked;
    if (!name) { alert('Enter athlete name.'); return; }
    e.name        = name;
    e.schoolId    = schoolId;
    e.wc          = wc;
    e.discipline  = discipline;
    e.publicOptOut = publicOptOut;
    _save(); closeModal(); renderMain();
  }

  function openImportRosterModal() {
    const m = _meet(); if (!m) return;
    autoSaveSetup();
    const homeSchool = m.schools.find(s => s.isHome);
    if (!homeSchool) { alert('No home school set.'); return; }
    const all = (typeof state !== 'undefined' ? (state.roster?.athletes || []) : []);
    _rosterCache = all.filter(a => !m.gender || a.gender === m.gender);
    if (!_rosterCache.length) { alert(`No ${m.gender} athletes in your roster.`); return; }
    const wcs  = _wcs(m.gender);
    const rows = _rosterCache.map((a, idx) => {
      const already  = m.entries.some(e => e.athleteId === a.id);
      const athleteWc = String(a.wc || '').trim();
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:5px;background:var(--dark2);margin-bottom:5px;border:1px solid var(--dark3);opacity:${already?'0.4':'1'};">
          <label style="display:flex;align-items:center;gap:8px;flex:1;cursor:${already?'default':'pointer'};">
            <input type="checkbox" value="${idx}" ${already?'disabled checked':''} style="accent-color:var(--gold);width:14px;height:14px;flex-shrink:0;">
            <span style="font-weight:600;color:var(--white);font-size:14px;">${esc(a.name)}</span>
            ${a.wc ? `<span style="color:var(--muted);font-size:12px;">${esc(a.wc)} lbs</span>` : ''}
          </label>
          <select id="hm-import-wc-${idx}" ${already?'disabled':''}
            style="background:var(--dark);color:var(--white);border:1px solid var(--dark3);border-radius:3px;padding:3px 7px;font-size:12px;">
            ${wcs.map(w => `<option value="${w}" ${athleteWc === w ? 'selected' : ''}>${w}</option>`).join('')}
          </select>
          <select id="hm-import-disc-${idx}" ${already?'disabled':''}
            style="background:var(--dark);color:var(--white);border:1px solid var(--dark3);border-radius:3px;padding:3px 7px;font-size:12px;">
            <option value="both">Both</option>
            <option value="traditional">Traditional</option>
            <option value="olympic">Olympic</option>
            <option value="exhibition">Exhibition</option>
          </select>
        </div>`;
    }).join('');
    document.getElementById('modal-body').innerHTML = `
      <h3>Import from Roster</h3>
      <p style="font-size:13px;color:var(--muted);margin-bottom:1rem;">
        Select athletes to enter. Opening attempts will be pre-filled at 90% of roster maxes.
      </p>
      <div id="hm-roster-list" style="max-height:380px;overflow-y:auto;">${rows}</div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-gold" onclick="HM.confirmImportRoster()">Import Selected</button>
      </div>`;
    document.getElementById('overlay').style.display = 'flex';
  }

  function confirmImportRoster() {
    const m = _meet(); if (!m) return;
    const homeSchool = m.schools.find(s => s.isHome); if (!homeSchool) return;
    const checked = [...document.querySelectorAll('#hm-roster-list input[type=checkbox]:checked:not(:disabled)')];
    if (!checked.length) { alert('Select at least one athlete.'); return; }
    let added = 0, skipped = 0;
    checked.forEach(cb => {
      const idx  = parseInt(cb.value);
      const a    = _rosterCache[idx]; if (!a) return;
      const wc   = document.getElementById(`hm-import-wc-${idx}`)?.value   || a.wc   || BOYS_WC[0];
      const disc = document.getElementById(`hm-import-disc-${idx}`)?.value || 'both';
      if (disc !== 'exhibition' && m.entries.filter(e => e.schoolId === homeSchool.id && e.wc === wc && e.discipline !== 'exhibition').length >= 2) { skipped++; return; }
      m.entries.push(_blankEntry(a.name, homeSchool.id, wc, disc, a.id, {
        snatch: _openAttempt(a.snatch), cj: _openAttempt(a.cj), bench: _openAttempt(a.bench),
      }, a.publicOptOut));
      added++;
    });
    _save(); closeModal(); renderMain();
    if (skipped > 0) showToast(`${added} imported, ${skipped} skipped (weight class full)`);
  }

  function openImportCSVModal() {
    const m = _meet(); if (!m) return;
    autoSaveSetup();
    if (!m.schools.length) { alert('Add schools first.'); return; }
    const schoolOpts = m.schools.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    document.getElementById('modal-body').innerHTML = `
      <h3>Import Athletes from CSV</h3>
      <div class="form-field">
        <label>School</label>
        <select id="hm-csv-school">${schoolOpts}</select>
      </div>
      <div class="form-field">
        <label>Paste athlete data — one per line</label>
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">
          Format: <strong>Name, Weight Class, Discipline</strong><br>
          Discipline: both · olympic · traditional · exhibition (default: both)<br>
          Example: Jane Doe, 154, olympic
        </div>
        <textarea id="hm-csv-data" rows="10"
          style="width:100%;background:var(--dark);color:var(--white);border:1px solid var(--dark3);border-radius:4px;padding:8px;font-size:13px;font-family:monospace;resize:vertical;"
          placeholder="John Smith, 154, both&#10;Jane Doe, 119, olympic&#10;Bob Jones, 129"></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-gold" onclick="HM.confirmImportCSV()">Import</button>
      </div>`;
    document.getElementById('overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('hm-csv-data')?.focus(), 50);
  }

  function confirmImportCSV() {
    const m = _meet(); if (!m) return;
    const schoolId = document.getElementById('hm-csv-school')?.value; if (!schoolId) return;
    const raw = (document.getElementById('hm-csv-data')?.value || '').trim();
    if (!raw) { alert('Paste athlete data first.'); return; }
    const wcs = _wcs(m.gender);

    function normDisc(s) {
      const v = (s||'').trim().toLowerCase();
      if (v==='olympic'||v==='oly'||v==='o') return 'olympic';
      if (v==='traditional'||v==='trad'||v==='t') return 'traditional';
      if (v==='exhibition'||v==='exh'||v==='ex'||v==='e') return 'exhibition';
      return 'both';
    }
    function normWC(s) {
      const v = (s||'').trim().toUpperCase();
      if (wcs.includes(v)) return v;
      const n = parseInt(v);
      if (n) { const match = wcs.find(w => parseInt(w) === n); if (match) return match; }
      return wcs[0];
    }

    const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !/^name[,\t]/i.test(l));
    let added = 0, skipped = 0;
    lines.forEach(line => {
      const parts = line.split(',').map(p => p.trim());
      const name = parts[0]; if (!name) return;
      const wc   = normWC(parts[1]);
      const disc = normDisc(parts[2]);
      if (disc !== 'exhibition' && m.entries.filter(e => e.schoolId === schoolId && e.wc === wc && e.discipline !== 'exhibition').length >= 2) { skipped++; return; }
      m.entries.push(_blankEntry(name, schoolId, wc, disc, null, null));
      added++;
    });
    _save(); closeModal(); renderMain();
    showToast(skipped > 0 ? `${added} imported, ${skipped} skipped (weight class full)` : `${added} athlete${added!==1?'s':''} imported`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  WEIGH-IN ACTIONS
  // ══════════════════════════════════════════════════════════════════════════
  function saveWeighIn(entryId) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const val = parseFloat(document.getElementById('wi-' + entryId)?.value);
    e.weighIn = isNaN(val) || val <= 0 ? null : val;
    const input = document.getElementById('wi-' + entryId);
    if (input) input.style.borderColor = e.weighIn !== null ? 'var(--gold-a50)' : 'var(--dark3)';
    const check = document.getElementById('hm-wi-check-' + entryId);
    if (check) {
      check.textContent = e.weighIn !== null ? '✓' : '—';
      check.style.color    = e.weighIn !== null ? '#5EC08A' : '#555';
      check.style.fontSize = e.weighIn !== null ? '15px'   : '12px';
    }
    _save();
    const weighed = m.entries.filter(x => x.weighIn !== null).length;
    const allDone = weighed === m.entries.length && m.entries.length > 0;
    const counter = document.getElementById('hm-wi-counter');
    if (counter) counter.textContent = weighed + ' / ' + m.entries.length + ' weighed in';
    const btn = document.getElementById('hm-wi-proceed-btn');
    if (btn) { btn.disabled = !allDone; btn.title = allDone ? 'Start the competition' : 'All athletes must be weighed in first'; }
  }

  function saveOpen(entryId, lift) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const key = lift === 'snatch' ? 'snopen-' : lift === 'cj' ? 'cjopen-' : 'benchopen-';
    const val = parseInt(document.getElementById(key + entryId)?.value) || 0;
    if (lift === 'snatch') e.snatchOpen = val;
    else if (lift === 'cj') e.cjOpen    = val;
    else                    e.benchOpen  = val;
    _save();
  }

  function proceedToCompetition() {
    const m = _meet(); if (!m) return;
    if (m.entries.some(e => e.weighIn === null)) {
      alert('All athletes must be weighed in before starting competition.'); return;
    }
    if (m.status === 'weigh-in') {
      m.entries.forEach(e => {
        const snEl = document.getElementById('snopen-' + e.id);
        const cjEl = document.getElementById('cjopen-' + e.id);
        const bnEl = document.getElementById('benchopen-' + e.id);
        if (snEl && snEl.value) e.snatchOpen = parseInt(snEl.value) || e.snatchOpen || 0;
        if (cjEl && cjEl.value) e.cjOpen     = parseInt(cjEl.value) || e.cjOpen     || 0;
        if (bnEl && bnEl.value) e.benchOpen  = parseInt(bnEl.value) || e.benchOpen  || 0;
      });
      m.entries.forEach(e => {
        if (e.snatchOpen > 0) e.snatch[0].declared = e.snatchOpen;
        if (e.cjOpen     > 0) e.cj[0].declared     = e.cjOpen;
        if (e.benchOpen  > 0) e.bench[0].declared   = e.benchOpen;
      });
      m.status = 'snatch';
      _save();
      _barWeight            = _minDeclared(m, 'snatch');
      _checkedIn.clear();
      _attemptRound         = 1;
      _clockStart           = null;
      _clockDuration        = null;
      _clockPausedRemaining = null;
    } else if (_barWeight === null) {
      _barWeight = _minDeclared(m, m.status);
    }
    _view = 'competition';
    renderMain();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  COMPETITION ACTIONS
  // ══════════════════════════════════════════════════════════════════════════
  function recordResult(entryId, lift, attemptIdx, result) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const att = e[lift][attemptIdx]; if (!att) return;
    _lastLift = { entryId: e.id, name: e.name, schoolId: e.schoolId, wc: e.wc, lift, declared: att.declared, result, attemptIdx, platform: e.platform ?? null, publicOptOut: !!e.publicOptOut };
    att.result = result;
    // Remove this lifter's stale key and restart clock for next on-deck lifter
    _checkedIn.delete(entryId + ':' + attemptIdx);
    const remaining = [..._checkedIn];
    if (remaining.length > 0) {
      const nextEntryId     = remaining[0].split(':')[0];
      _clockDuration        = nextEntryId === entryId ? 120 : 60;
      _clockStart           = Date.now();
      _clockPausedRemaining = null;
    } else {
      _clockStart           = null;
      _clockDuration        = null;
      _clockPausedRemaining = null;
    }
    _save();
    const nextIdx = attemptIdx + 1;
    if (nextIdx < 3) {
      const minW = result === 'good' ? att.declared + 5 : att.declared;
      const suggested = result === 'good' ? att.declared + 5 : att.declared;
      e[lift][nextIdx].declared = suggested;
      _save();
      openDeclareModal(entryId, lift, nextIdx, minW, suggested);
    } else {
      renderMain();
    }
  }

  function openDeclareModal(entryId, lift, nextIdx, minW, suggested) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const school  = m.schools.find(s => s.id === e.schoolId);
    const ordinal = ['', '2nd', '3rd'][nextIdx] || (nextIdx+1)+'th';
    document.getElementById('modal-body').innerHTML = `
      <h3>Declare ${ordinal} Attempt — ${STATUS_LABEL[lift]||lift}</h3>
      <div style="font-size:13px;color:var(--muted);margin-bottom:1rem;">${esc(e.name)} · ${esc(school?.name||'')} · ${e.wc} lbs</div>
      <div class="form-field">
        <label>Weight (lbs) — minimum ${minW} lbs</label>
        <input type="number" id="hm-declare-wt" value="${suggested||minW}" min="${minW}" step="5"
          style="font-size:22px;font-family:'Barlow Condensed',sans-serif;font-weight:700;">
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="HM.scratchEntry('${entryId}','${lift}');closeModal()">Scratch</button>
        <button class="btn btn-gold" onclick="HM.confirmDeclare('${entryId}','${lift}',${nextIdx},${minW})">Confirm →</button>
      </div>`;
    document.getElementById('overlay').style.display = 'flex';
    setTimeout(() => { const el = document.getElementById('hm-declare-wt'); if(el){el.focus();el.select();} }, 50);
  }

  function confirmDeclare(entryId, lift, nextIdx, minW) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const val = parseInt(document.getElementById('hm-declare-wt')?.value) || 0;
    if (val < minW) { alert(`Weight must be at least ${minW} lbs (5 lb minimum progression).`); return; }
    e[lift][nextIdx].declared = val;
    _save();
    closeModal();
    renderMain();
  }

  function _checkInBlocked(e, lift) {
    const done = e[lift].filter(a => a.result !== null);
    const highest = done.length ? Math.max(...done.map(a => a.declared)) : 0;
    if (_barWeight < highest)
      return `${e.name} has already attempted ${highest} lbs and cannot go back to a lower weight.`;
    if (e[lift].some(a => a.declared === _barWeight && a.result === 'good'))
      return `${e.name} already made a good lift at ${_barWeight} lbs and must declare a higher weight.`;
    return null;
  }

  function _startClockForEntry(entryId) {
    if (_checkedIn.size === 0) {
      _clockDuration        = _lastLift?.entryId === entryId ? 120 : 60;
      _clockStart           = Date.now();
      _clockPausedRemaining = null;
    }
  }

  function checkIn(entryId, lift) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const idx = _curIdx(e, lift); if (idx < 0 || !_barWeight) return;
    const blocked = _checkInBlocked(e, lift);
    if (blocked) { alert(blocked); return; }
    e[lift][idx].declared = _barWeight;
    _startClockForEntry(entryId);
    _checkedIn.add(e.id + ':' + idx);
    _save();
    renderMain();
  }

  function overrideCheckIn(entryId, lift) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const idx = _curIdx(e, lift); if (idx < 0 || !_barWeight) return;
    const blocked = _checkInBlocked(e, lift);
    if (blocked) { alert(blocked); return; }
    const ordinal = ['1st','2nd','3rd'][idx] || (idx+1)+'th';
    const ok = confirm(`OVERRIDE — Missed Attempt Call\n\n${e.name} missed their attempt call.\nAllow their ${ordinal} attempt at ${_barWeight} lbs anyway?`);
    if (!ok) return;
    e[lift][idx].declared = _barWeight;
    _startClockForEntry(entryId);
    _checkedIn.add(e.id + ':' + idx);
    _save();
    renderMain();
  }

  function advanceAttemptRound() {
    if (_attemptRound < 3) {
      _attemptRound++;
      _checkedIn.clear();
      _clockStart           = null;
      _clockDuration        = null;
      _clockPausedRemaining = null;
      _saveDisplayState();
    }
    renderMain();
  }

  function setBarWeight(w) {
    const val = parseInt(w) || 0;
    if (val > 0) {
      _barWeight            = val;
      _checkedIn.clear();
      _attemptRound         = 1;
      _clockStart           = null;
      _clockDuration        = null;
      _clockPausedRemaining = null;
      _saveDisplayState();
    }
    renderMain();
  }

  function passAttempt(entryId, lift) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const idx = _curIdx(e, lift); if (idx < 0) return;
    const minW    = (_barWeight || e[lift][idx].declared) + 5;
    const ordinal = ['1st','2nd','3rd'][idx] || (idx+1)+'th';
    const school  = m.schools.find(s => s.id === e.schoolId);
    document.getElementById('modal-body').innerHTML = `
      <h3>Pass — ${STATUS_LABEL[lift]||lift}</h3>
      <div style="font-size:13px;color:var(--muted);margin-bottom:1rem;">${esc(e.name)} · ${esc(school?.name||'')} · ${e.wc} lbs · ${ordinal} attempt</div>
      <div class="form-field">
        <label>New declared weight (minimum ${minW} lbs)</label>
        <input type="number" id="hm-pass-wt" value="${minW}" min="${minW}" step="5"
          style="font-size:22px;font-family:'Barlow Condensed',sans-serif;font-weight:700;">
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-gold" onclick="HM.confirmPass('${entryId}','${lift}',${idx},${minW})">Confirm Pass →</button>
      </div>`;
    document.getElementById('overlay').style.display = 'flex';
    setTimeout(() => { const el = document.getElementById('hm-pass-wt'); if(el){el.focus();el.select();} }, 50);
  }

  function confirmPass(entryId, lift, idx, minW) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const val = parseInt(document.getElementById('hm-pass-wt')?.value) || 0;
    if (val < minW) { alert(`Weight must be at least ${minW} lbs.`); return; }
    e[lift][idx].declared = val;
    _checkedIn.delete(e.id + ':' + idx);
    if (_checkedIn.size === 0) { _clockStart = null; _clockDuration = null; _clockPausedRemaining = null; }
    _save();
    closeModal();
    renderMain();
  }

  function scratchEntry(entryId, lift) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    e[lift].forEach(a => { if (a.result === null) a.result = 'miss'; });
    // Remove all of this lifter's keys from checked-in set
    for (let i = 0; i < 3; i++) _checkedIn.delete(e.id + ':' + i);
    if (_checkedIn.size === 0) { _clockStart = null; _clockDuration = null; _clockPausedRemaining = null; }
    _save();
    renderMain();
  }

  function updateDeclared(entryId, lift, attemptIdx, rawValue) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const val  = parseInt(rawValue) || 0;
    const minW = attemptIdx > 0 ? (e[lift][attemptIdx-1].declared || 0) + 5 : 1;
    if (val < minW) return;
    e[lift][attemptIdx].declared = val;
    _save();
  }

  function advancePhase() {
    const m = _meet(); if (!m) return;
    const lift = m.status;
    if (!_phaseComplete(m, lift)) { alert('All athletes must complete their attempts first.'); return; }

    let next;
    if (lift === 'snatch') { next = 'cj'; }
    else if (lift === 'cj') {
      const hasBench = m.entries.some(e => e.discipline === 'both' || e.discipline === 'traditional' || e.discipline === 'exhibition');
      next = hasBench ? 'bench' : 'complete';
    } else { next = 'complete'; }

    const label = next === 'complete' ? 'complete this meet' : `advance to ${STATUS_LABEL[next]}`;
    if (!confirm(`Ready to ${label}? You cannot go back.`)) return;

    m.status = next;
    _save();
    _checkedIn.clear();
    _attemptRound         = 1;
    _lastLift             = null;
    _clockStart           = null;
    _clockDuration        = null;
    _clockPausedRemaining = null;
    if (next === 'complete') {
      _barWeight = null;
      _view = 'results';
    } else {
      _barWeight = _minDeclared(m, next);
    }
    renderMain();
  }

  // ── Timer ──────────────────────────────────────────────────────────────────
  function _syncTimer() {
    _saveDisplayState();
    // timer state is local-only in the web version
  }

  function startTimer(secs) {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    _timerEndMs     = Date.now() + secs * 1000;
    _timerPausedRem = null;
    _timerInterval  = setInterval(_tickTimer, 250);
    _tickTimer();
    _syncTimer();
  }

  function pauseResumeTimer() {
    if (_timerEndMs && _timerPausedRem === null) {
      _timerPausedRem = Math.max(0, _timerEndMs - Date.now());
      _timerEndMs     = null;
      if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    } else if (_timerPausedRem !== null) {
      _timerEndMs     = Date.now() + _timerPausedRem;
      _timerPausedRem = null;
      _timerInterval  = setInterval(_tickTimer, 250);
    }
    _tickTimer();
    const btn = document.querySelector('[onclick="HM.pauseResumeTimer()"]');
    if (btn) btn.textContent = (_timerEndMs !== null) ? 'Pause' : 'Resume';
    _syncTimer();
  }

  function resetTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    _timerEndMs     = null;
    _timerPausedRem = null;
    _syncTimer();
    renderMain();
  }

  // ── Athlete clock controls (single-platform) ──────────────────────────────
  function pauseClock() {
    if (!_clockStart || !_clockDuration) return;
    _clockPausedRemaining = Math.max(0, _clockDuration * 1000 - (Date.now() - _clockStart));
    _clockStart = null;
    _saveDisplayState();
    renderMain();
  }

  function resumeClock() {
    if (_clockPausedRemaining == null) return;
    _clockStart           = Date.now() - (_clockDuration * 1000 - _clockPausedRemaining);
    _clockPausedRemaining = null;
    _saveDisplayState();
    renderMain();
  }

  function resetClock() {
    _clockStart           = null;
    _clockDuration        = null;
    _clockPausedRemaining = null;
    _saveDisplayState();
    renderMain();
  }

  // ── Athlete clock controls (multi-platform, director) ─────────────────────
  async function directorPauseClock(pNum) {
    _directorSocket?.emit('director-pause-clock', { pNum });
  }

  async function directorResumeClock(pNum) {
    _directorSocket?.emit('director-resume-clock', { pNum });
  }

  async function directorResetClock(pNum) {
    _directorSocket?.emit('director-reset-clock', { pNum });
  }

  function _onCompMounted() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (_timerEndMs) _timerInterval = setInterval(_tickTimer, 250);
    _startClockTick();
  }

  function _tickTimer() {
    const el = document.getElementById('hm-timer-display');
    if (!el) { if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; } return; }
    if (!_timerEndMs) return;
    const rem  = Math.max(0, _timerEndMs - Date.now());
    const mins = Math.floor(rem / 60000);
    const secs = Math.floor((rem % 60000) / 1000);
    el.textContent = mins + ':' + String(secs).padStart(2, '0');
    el.style.color = rem < 10000 ? '#E07070' : rem < 30000 ? '#C9A84C' : 'var(--white)';
    if (rem === 0) { clearInterval(_timerInterval); _timerInterval = null; _timerEndMs = null; _syncTimer(); }
  }

  function _setScoreTab(tab) { _scoreTab = tab; renderMain(); }
  function _toggleCompFont() { _compFontLarge = !_compFontLarge; renderMain(); }

  // ── Sync PRs to roster ─────────────────────────────────────────────────────
  function syncPRsToRoster() {
    const m = _meet(); if (!m) return;
    if (typeof state === 'undefined') { alert('Cannot access roster.'); return; }
    let updated = 0;
    const meetDate = m.date || new Date().toISOString().slice(0,10);
    const meetName = m.name || 'Meet';
    m.entries.forEach(e => {
      if (!e.athleteId) return;
      const a = (state.roster?.athletes || []).find(x => x.id === e.athleteId);
      if (!a) return;
      if (!a.prHistory) a.prHistory = { snatch: [], cj: [], bench: [] };
      const lifts = [['snatch', e.snatch], ['cj', e.cj], ['bench', e.bench]];
      lifts.forEach(([key, attempts]) => {
        const best = _bestMade(attempts);
        if (!best) return;
        if (best > (a[key] || 0)) {
          a[key] = best;
          a.prHistory[key].push({ value: best, date: meetDate, meet: meetName });
          updated++;
        }
      });
    });
    if (typeof saveState === 'function') saveState();
    showToast(updated ? `${updated} PR${updated!==1?'s':''} synced to roster.` : 'No new PRs to sync.');
  }

  // ── Edit result entry ──────────────────────────────────────────────────────
  function openEditResultModal(entryId) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const school = m.schools.find(s => s.id === e.schoolId);
    const hasSnatch = e.discipline === 'both' || e.discipline === 'olympic'  || e.discipline === 'exhibition';
    const hasBench  = e.discipline === 'both' || e.discipline === 'traditional' || e.discipline === 'exhibition';
    const discMap   = { both:'Both', traditional:'Traditional', olympic:'Olympic', exhibition:'Exhibition' };
    const LIFTS     = [
      ...(hasSnatch ? [{ key:'snatch', label:'Snatch' }] : []),
      { key:'cj', label:'Clean & Jerk' },
      ...(hasBench  ? [{ key:'bench',  label:'Bench'  }] : []),
    ];
    const btnBase = 'font-family:\'Barlow Condensed\',sans-serif;font-size:11px;font-weight:700;padding:3px 9px;border-radius:3px;cursor:pointer;border:1px solid;';
    function resultBtns(liftKey, idx, cur) {
      const good = cur === 'good';
      const no   = cur === 'no';
      return `<div style="display:flex;gap:4px;">
        <button onclick="HM._setAttemptResult('${entryId}','${liftKey}',${idx},'good')" style="${btnBase}background:${good?'#1e4a2a':'var(--dark2)'};border-color:${good?'#5EC08A':'var(--dark3)'};color:${good?'#5EC08A':'var(--muted)'};">✓</button>
        <button onclick="HM._setAttemptResult('${entryId}','${liftKey}',${idx},'no')" style="${btnBase}background:${no?'#4a1e1e':'var(--dark2)'};border-color:${no?'#E07070':'var(--dark3)'};color:${no?'#E07070':'var(--muted)'};">✗</button>
        <button onclick="HM._setAttemptResult('${entryId}','${liftKey}',${idx},null)" style="${btnBase}background:${cur===null?'var(--dark3)':'var(--dark2)'};border-color:var(--dark3);color:${cur===null?'var(--white)':'var(--muted)'};">—</button>
      </div>`;
    }
    const liftSections = LIFTS.map(({ key, label }) => {
      const rows = e[key].map((att, idx) => `
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--dark3);">
          <span style="font-family:'Barlow Condensed',sans-serif;font-size:11px;color:var(--muted);width:28px;">${['1st','2nd','3rd'][idx]}</span>
          <input id="er-${key}-${idx}-w" type="number" value="${att.declared||''}" min="0" step="1" placeholder="—"
            style="width:80px;background:var(--dark);color:var(--white);border:1px solid var(--dark3);border-radius:4px;padding:4px 8px;font-size:13px;font-family:'Barlow Condensed',sans-serif;text-align:center;">
          <span style="font-size:11px;color:var(--muted);">lbs</span>
          ${resultBtns(key, idx, att.result)}
        </div>`).join('');
      return `<div style="margin-bottom:1rem;">
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:6px;">${label}</div>
        ${rows}
      </div>`;
    }).join('');
    document.getElementById('modal-body').innerHTML = `
      <h3>Edit Results — ${esc(e.name)}</h3>
      <p style="font-size:12px;color:var(--muted);margin:0 0 1rem;">${esc(school?.name||'')} · ${e.wc} lbs · ${discMap[e.discipline]||e.discipline}</p>
      ${liftSections}
      <div class="modal-actions" style="justify-content:space-between;">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-gold" onclick="HM.saveEditResult('${entryId}')">Save Changes</button>
      </div>`;
    document.getElementById('overlay').style.display = 'flex';
  }

  function _setAttemptResult(entryId, liftKey, idx, result) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    e[liftKey][idx].result = result;
    _save();
    // Re-render just the result buttons in the open modal
    openEditResultModal(entryId);
  }

  function saveEditResult(entryId) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    const hasSnatch = e.discipline === 'both' || e.discipline === 'olympic'  || e.discipline === 'exhibition';
    const hasBench  = e.discipline === 'both' || e.discipline === 'traditional' || e.discipline === 'exhibition';
    const LIFTS     = [
      ...(hasSnatch ? ['snatch'] : []),
      'cj',
      ...(hasBench  ? ['bench'] : []),
    ];
    LIFTS.forEach(key => {
      e[key].forEach((att, idx) => {
        const w = parseFloat(document.getElementById(`er-${key}-${idx}-w`)?.value) || 0;
        att.declared = w || att.declared;
      });
    });
    _save();
    closeModal();
    renderMain();
  }

  // ── Export CSV ─────────────────────────────────────────────────────────────
  function exportResultsCSV() {
    const m = _meet(); if (!m) return;
    const wcs  = _wcs(m.gender);
    const N    = m.schools.length;
    const pts  = _teamPoints(N);

    function isOlyElig(e) { return e.discipline==='both'||e.discipline==='olympic'; }
    function isTrdElig(e) { return e.discipline==='both'||e.discipline==='traditional'; }
    function wcPtsMap(wc, eligFn, totFn) {
      const elig   = m.entries.filter(e => e.wc===wc && eligFn(e));
      const sorted = [...elig].map(e=>({e,tot:totFn(e)})).sort(_rankCmp);
      const map = {}; let p=0;
      sorted.forEach(r=>{ if(r.tot>0&&p<pts.length) map[r.e.id]=pts[p++]; });
      return map;
    }
    function attVal(a) {
      if (!a || a.result===null) return '';
      return a.result==='miss' ? 'X' : String(a.declared);
    }

    const rows = [
      ['Meet', m.name||''], ['Date', m.date||''], ['Location', m.location||''], ['Gender', m.gender||''], [],
      ['Weight Class','Athlete','Team','Weigh-in',
       'Snatch 1','Snatch 2','Snatch 3','Best Snatch',
       'C&J 1','C&J 2','C&J 3','Best C&J',
       'Bench 1','Bench 2','Bench 3','Best Bench',
       'Oly Total','Oly Pts','Trd Total','Trd Pts'],
    ];

    const teamOly = {}, teamTrd = {};
    m.schools.forEach(s => { teamOly[s.id]=0; teamTrd[s.id]=0; });

    wcs.filter(wc => m.entries.some(e=>e.wc===wc)).forEach(wc => {
      const entries = m.entries.filter(e=>e.wc===wc);
      const oMap = wcPtsMap(wc, isOlyElig, _olympicTotal);
      const tMap = wcPtsMap(wc, isTrdElig, _traditionalTotal);
      entries.forEach(e => {
        teamOly[e.schoolId] = (teamOly[e.schoolId]||0) + (oMap[e.id]||0);
        teamTrd[e.schoolId] = (teamTrd[e.schoolId]||0) + (tMap[e.id]||0);
      });
      const sorted = [...entries].sort((a,b) => {
        const sa = m.schools.findIndex(s=>s.id===a.schoolId);
        const sb = m.schools.findIndex(s=>s.id===b.schoolId);
        return sa-sb || a.name.localeCompare(b.name);
      });
      sorted.forEach(e => {
        const sch    = m.schools.find(s=>s.id===e.schoolId);
        const oTotal = _olympicTotal(e);
        const tTotal = _traditionalTotal(e);
        rows.push([
          e.wc,
          e.name + (e.discipline==='exhibition'?' (EX)':''),
          sch?.name||'',
          e.weighIn||'',
          attVal(e.snatch[0]), attVal(e.snatch[1]), attVal(e.snatch[2]), _bestMade(e.snatch)||'',
          attVal(e.cj[0]),    attVal(e.cj[1]),    attVal(e.cj[2]),    _bestMade(e.cj)||'',
          attVal(e.bench[0]), attVal(e.bench[1]), attVal(e.bench[2]), _bestMade(e.bench)||'',
          oTotal||'', oMap[e.id]||'', tTotal||'', tMap[e.id]||'',
        ]);
      });
      rows.push([]);
    });

    rows.push(['Team Scores']);
    rows.push(['School','Olympic Pts','Traditional Pts','Total']);
    m.schools.map(s=>({name:s.name,oly:teamOly[s.id]||0,trd:teamTrd[s.id]||0}))
      .sort((a,b)=>(b.oly+b.trd)-(a.oly+a.trd))
      .forEach(s => rows.push([s.name, s.oly, s.trd, s.oly+s.trd]));

    const csv  = rows.map(r => r.map(c => { const s=String(c??''); return /[,"\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }).join(',')).join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href=url; a.download=(m.name||'meet').replace(/[^a-z0-9]/gi,'_')+'_results.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  function exportResultsPDF() {
    const m = _meet(); if (!m) return;
    const wcs = _wcs(m.gender);
    const N   = m.schools.length;
    const pts = _teamPoints(N);

    // ── Helpers ────────────────────────────────────────────────────────────
    function isOlyElig(e) { return e.discipline==='both'||e.discipline==='olympic'; }
    function isTrdElig(e) { return e.discipline==='both'||e.discipline==='traditional'; }

    function wcPtsMap(wc, eligFn, totFn) {
      const elig   = m.entries.filter(e => e.wc===wc && eligFn(e));
      const sorted = [...elig].map(e=>({e,tot:totFn(e)})).sort(_rankCmp);
      const map={}; let p=0;
      sorted.forEach(r=>{ if(r.tot>0&&p<pts.length) map[r.e.id]=pts[p++]; });
      return map;
    }

    function hexToRgba(hex, alpha) {
      if (!hex||hex.length<7) return `rgba(180,180,180,${alpha})`;
      const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
      return `rgba(${r},${g},${b},${alpha})`;
    }

    function bestIdx(atts) {
      let b=-1, bw=-1;
      atts.forEach((a,i)=>{ if(a.result==='good'&&a.declared>bw){b=i;bw=a.declared;} });
      return b;
    }

    function attCells(atts) {
      const bi = bestIdx(atts);
      const cells = atts.map((a,i) => {
        if (a.result===null) return '<td class="ac"></td>';
        if (a.result==='miss') return `<td class="ac miss">X</td>`;
        return i===bi ? `<td class="ac best">${a.declared}</td>` : `<td class="ac">${a.declared}</td>`;
      }).join('');
      const best = _bestMade(atts);
      return cells + (best ? `<td class="ac best">${best}</td>` : `<td class="ac muted">—</td>`);
    }

    // ── Compute totals and accumulate team scores ──────────────────────────
    const teamOly = {}, teamTrd = {};
    m.schools.forEach(s=>{ teamOly[s.id]=0; teamTrd[s.id]=0; });

    const wcData = wcs.filter(wc=>m.entries.some(e=>e.wc===wc)).map(wc => {
      const entries = m.entries.filter(e=>e.wc===wc);
      const oMap = wcPtsMap(wc, isOlyElig, _olympicTotal);
      const tMap = wcPtsMap(wc, isTrdElig, _traditionalTotal);
      entries.forEach(e=>{
        teamOly[e.schoolId]=(teamOly[e.schoolId]||0)+(oMap[e.id]||0);
        teamTrd[e.schoolId]=(teamTrd[e.schoolId]||0)+(tMap[e.id]||0);
      });
      return { wc, entries, oMap, tMap };
    });

    // ── Weight class sections ──────────────────────────────────────────────
    const wcSections = wcData.map(({wc, entries, oMap, tMap}) => {
      const sorted = [...entries].sort((a,b)=>{
        const sa=m.schools.findIndex(s=>s.id===a.schoolId);
        const sb=m.schools.findIndex(s=>s.id===b.schoolId);
        return sa-sb||a.name.localeCompare(b.name);
      });

      const rows = sorted.map(e => {
        const sch    = m.schools.find(s=>s.id===e.schoolId);
        const bg     = hexToRgba(sch?.color||'#888', 0.13);
        const oTotal = _olympicTotal(e);
        const tTotal = _traditionalTotal(e);
        const oPts   = oMap[e.id]||'';
        const tPts   = tMap[e.id]||'';
        const isEx   = e.discipline==='exhibition';
        return `<tr style="background:${bg};">
          <td>${esc(e.name)}${isEx?' <span class="ex">(EX)</span>':''}</td>
          <td class="ac">${esc(sch?.name||'')}</td>
          <td class="ac">${e.weighIn||e.wc}</td>
          ${attCells(e.snatch)}
          ${attCells(e.cj)}
          ${attCells(e.bench)}
          <td class="ac tot">${oTotal||'—'}</td><td class="ac pts">${oPts||'—'}</td>
          <td class="ac tot">${tTotal||'—'}</td><td class="ac pts">${tPts||'—'}</td>
        </tr>`;
      }).join('');

      return `<div class="wc-block">
        <div class="wc-title">${wc} Weight Class</div>
        <table>
          <thead>
            <tr class="hdr1">
              <th rowspan="2">Athlete</th><th rowspan="2" class="ac">Team</th><th rowspan="2" class="ac">Weight</th>
              <th colspan="4" class="ac">Snatch</th>
              <th colspan="4" class="ac">Clean &amp; Jerk</th>
              <th colspan="4" class="ac">Bench</th>
              <th colspan="2" class="ac">Oly Total/Points</th>
              <th colspan="2" class="ac">Trd Total/Points</th>
            </tr>
            <tr class="hdr2">
              <th class="ac">1st</th><th class="ac">2nd</th><th class="ac">3rd</th><th class="ac">Best</th>
              <th class="ac">1st</th><th class="ac">2nd</th><th class="ac">3rd</th><th class="ac">Best</th>
              <th class="ac">1st</th><th class="ac">2nd</th><th class="ac">3rd</th><th class="ac">Best</th>
              <th class="ac">Total</th><th class="ac">Pts</th>
              <th class="ac">Total</th><th class="ac">Pts</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }).join('');

    // ── Team score summary ─────────────────────────────────────────────────
    const teamRows = m.schools
      .map(s=>({name:s.name, oly:teamOly[s.id]||0, trd:teamTrd[s.id]||0}))
      .sort((a,b)=>(b.oly+b.trd)-(a.oly+a.trd))
      .map(s=>`<tr><td>${esc(s.name)}</td><td class="ac pts">${s.oly}</td><td class="ac pts">${s.trd}</td><td class="ac tot">${s.oly+s.trd}</td></tr>`)
      .join('');

    const teamSummary = `<div class="wc-block">
      <div class="wc-title">Team Scores</div>
      <table style="width:auto;">
        <thead><tr class="hdr1"><th>School</th><th class="ac">Olympic</th><th class="ac">Traditional</th><th class="ac">Total</th></tr></thead>
        <tbody>${teamRows}</tbody>
      </table>
    </div>`;

    // ── CSS ────────────────────────────────────────────────────────────────
    const css = `
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;font-size:9pt;color:#000;padding:16px;}
      h1{font-size:18pt;font-weight:700;text-align:center;margin-bottom:3px;}
      .meta{font-size:9pt;color:#555;text-align:center;margin-bottom:18px;}
      .wc-block{margin-bottom:22px;}
      .wc-title{font-size:11pt;font-weight:700;text-align:center;background:#e0e0e0;border:1px solid #bbb;padding:4px 8px;margin-bottom:0;}
      table{width:100%;border-collapse:collapse;font-size:8pt;}
      th{background:#ebebeb;padding:3px 4px;font-weight:700;border:1px solid #bbb;white-space:nowrap;}
      td{padding:3px 4px;border:1px solid #ddd;white-space:nowrap;}
      .ac{text-align:center;}
      .miss{color:#c00;font-weight:700;}
      .best{color:#1a7a1a;font-weight:700;}
      .muted{color:#aaa;}
      .tot{font-weight:700;}
      .pts{color:#1a7a1a;font-weight:700;}
      .ex{font-size:7pt;color:#888;}
      .hdr1 th{background:#d8d8d8;}
      .hdr2 th{background:#ebebeb;font-size:7pt;}
      @media print{.wc-block{page-break-inside:avoid}body{padding:8px}}`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>${esc(m.name||'Meet')} — Results</title>
      <style>${css}</style></head>
      <body>
        <h1>${esc(m.name||'Meet Results')}</h1>
        <div class="meta">${[m.gender,m.date,m.location].filter(Boolean).map(v=>esc(v)).join(' &nbsp;|&nbsp; ')}</div>
        ${wcSections}
        ${teamSummary}
      </body></html>`;

    if (window.liftbuilderApp?.exportPDF) {
      window.liftbuilderApp.exportPDF(html)
        .then(r => showToast(r?.success ? 'PDF saved.' : r?.error ? 'PDF failed: ' + r.error : 'PDF export cancelled.'))
        .catch(e => showToast('PDF export failed: ' + (e?.message || e || 'unknown error')));
    } else {
      const win = window.open('', '_blank', 'width=1200,height=800');
      if (!win) { showToast('Allow pop-ups to export PDF.'); return; }
      win.document.write(html); win.document.close(); win.focus();
      setTimeout(() => win.print(), 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PHASE 3: FLIGHTS, STATS, PRINT, DISPLAY
  // ══════════════════════════════════════════════════════════════════════════

  function toggleFlights() {
    const m = _meet(); if (!m) return;
    m.useFlights = !m.useFlights;
    _save(); renderMain();
  }

  function setEntryFlight(entryId, flight) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    e.flight = flight;
    _save(); renderMain();
  }

  function setPlatformForEntry(entryId, val) {
    const m = _meet(); if (!m) return;
    const e = m.entries.find(x => x.id === entryId); if (!e) return;
    e.platform = val === '' ? null : parseInt(val);
    _save();
  }

  // ── Platform server ─────────────────────────────────────────────────────────
  async function startPlatforms() {
    const m = _meet(); if (!m) return;
    autoSaveSetup();
    // Initialise platformStates for each platform
    if (!m.platformStates) m.platformStates = {};
    for (let i = 1; i <= m.numPlatforms; i++) {
      if (!m.platformStates[i]) {
        m.platformStates[i] = { status: m.status, attemptRound: 1, barWeight: null, checkedIn: [] };
      }
    }
    _save();
    let result;
    try {
      const resp = await fetch('/api/start-platforms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetState: m }),
      });
      result = await resp.json();
    } catch(e) {
      showToast('Server error: ' + (e?.message || e)); return;
    }
    if (!result.success) { showToast('Server failed: ' + (result.error||'unknown')); return; }

    _platformActive = true;
    _platformInfo   = { ip: result.ip, port: result.port, token: result.pin || '' };

    // Connect director socket
    _directorSocket = io({ auth: { directorToken: result.directorToken } });
    _directorSocket.on('state-update', _applyPlatformSync);
    _directorSocket.on('connect_error', (err) => showToast('Director socket error: ' + err.message));

    renderMain();
    showToast(`Platforms live at ${result.ip}:${result.port}`);
  }

  function copyLink(url) {
    navigator.clipboard.writeText(url).then(() => showToast('Link copied!')).catch(() => showToast('Copy failed — check browser permissions'));
  }

  async function stopPlatforms() {
    if (!confirm('Stop all platforms? Connected clients will be disconnected.')) return;
    _directorSocket?.disconnect();
    _directorSocket = null;
    try { await fetch('/api/stop-platforms', { method: 'POST' }); } catch(e) {}
    _platformActive       = false;
    _platformInfo         = null;
    _connectedPlatforms   = [];
    renderMain();
  }

  function directorSetBarWeight(pNum) {
    const w = parseInt(prompt(`Platform ${pNum} — Set bar weight (lbs):`));
    if (!w || w < 45) return;
    _directorSocket?.emit('director-set-bar-weight', { pNum, weight: w });
  }

  function directorAdvanceRound(pNum) {
    if (!confirm(`Platform ${pNum} — Advance to next attempt round?`)) return;
    _directorSocket?.emit('director-advance-round', { pNum });
  }

  function directorAdvancePhase(pNum) {
    if (!confirm(`Platform ${pNum} — Advance to next phase? Cannot be undone.`)) return;
    _directorSocket?.emit('director-advance-phase', { pNum });
  }

  function directorDeclareAttempt(pNum, entryId, lift, attemptIdx, currentWeight) {
    const raw = prompt(`Platform ${pNum} — New declared weight for attempt (current: ${currentWeight} lbs):`);
    const w   = parseInt(raw);
    if (!w || w < 45) return;
    _directorSocket?.emit('director-declare-attempt', { entryId, lift, attemptIdx, weight: w });
  }

  function _applyPlatformSync(newMeetState) {
    _platformSyncLock = true;
    _connectedPlatforms = newMeetState._connectedPlatforms || [];
    // Strip runtime-only fields before persisting
    const { _connectedPlatforms: _cp, ...cleanState } = newMeetState;
    // Keep lastLift in sync so the live display window gets the correct result
    if ('lastLift' in cleanState) _lastLift = cleanState.lastLift;
    const idx = _meets.findIndex(m => m.id === cleanState.id);
    if (idx >= 0) {
      _meets[idx] = cleanState;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(_meets)); } catch(e) {}
      _saveDisplayState();
      if (_activeMeetId === cleanState.id) renderMain();
    }
    _platformSyncLock = false;
  }

  function _setFlight(f) {
    _activeFlight = f;
    _saveDisplayState();
    renderMain();
  }

  // ── Stats view ─────────────────────────────────────────────────────────────
  function showStats() { _view = 'stats'; renderMain(); }

  function _buildStatsHTML() {
    const completed = _meets.filter(m => m.status === 'complete');

    const map = {}; // key -> { name, entries: [{meet, e}] }
    completed.forEach(m => {
      m.entries.forEach(e => {
        const key = e.athleteId || ('name:' + e.name);
        if (!map[key]) map[key] = { name: e.name, rows: [] };
        map[key].rows.push({ meetName: m.name, date: m.date, gender: m.gender, wc: e.wc, disc: e.discipline,
          sn: _bestMade(e.snatch), cj: _bestMade(e.cj), bn: _bestMade(e.bench),
          oTot: _olympicTotal(e), tTot: _traditionalTotal(e) });
      });
    });

    const athletes = Object.values(map).map(a => {
      const pr = { sn:0, cj:0, bn:0, oTot:0, tTot:0 };
      a.rows.forEach(r => {
        if (r.sn   > pr.sn)   pr.sn   = r.sn;
        if (r.cj   > pr.cj)   pr.cj   = r.cj;
        if (r.bn   > pr.bn)   pr.bn   = r.bn;
        if (r.oTot > pr.oTot) pr.oTot = r.oTot;
        if (r.tTot > pr.tTot) pr.tTot = r.tTot;
      });
      return { name: a.name, meets: a.rows.length, pr, history: a.rows.sort((x,y) => (y.date||'').localeCompare(x.date||'')) };
    }).sort((a, b) => a.name.localeCompare(b.name));

    if (!athletes.length) {
      return `<div class="empty-msg" style="padding:4rem;">No completed meets yet. Stats will appear after you complete a meet.</div>`;
    }

    const rows = athletes.map(a => `
      <tr style="border-bottom:1px solid var(--dark3);">
        <td style="padding:9px 12px;font-weight:600;font-size:14px;">${esc(a.name)}</td>
        <td style="padding:9px 12px;text-align:center;color:var(--muted);font-size:13px;">${a.meets}</td>
        <td style="padding:9px 12px;text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:14px;">${a.pr.sn||'—'}</td>
        <td style="padding:9px 12px;text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:14px;">${a.pr.cj||'—'}</td>
        <td style="padding:9px 12px;text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:14px;">${a.pr.bn||'—'}</td>
        <td style="padding:9px 12px;text-align:center;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:15px;color:${a.pr.oTot?'var(--gold)':'var(--muted)'};">${a.pr.oTot||'—'}</td>
        <td style="padding:9px 12px;text-align:center;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:15px;color:${a.pr.tTot?'var(--gold)':'var(--muted)'};">${a.pr.tTot||'—'}</td>
      </tr>
      <tr style="border-bottom:2px solid var(--dark3);">
        <td colspan="7" style="padding:0 12px 8px 28px;">
          <div style="font-size:11px;color:var(--muted);">
            ${a.history.map(r => `${r.date||'?'} &nbsp;·&nbsp; ${esc(r.meetName)} &nbsp;·&nbsp; ${r.wc} lbs &nbsp;·&nbsp;
              ${r.disc==='both'||r.disc==='olympic' ? `O: ${r.oTot||'bomb'}` : ''}
              ${r.disc==='both' ? ' &nbsp;' : ''}
              ${r.disc==='both'||r.disc==='traditional' ? `T: ${r.tTot||'bomb'}` : ''}`).join('<br>')}
          </div>
        </td>
      </tr>`).join('');

    return `
      <div class="chart-card" style="max-width:1000px;padding:0;overflow:hidden;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="border-bottom:2px solid var(--dark3);">
            <th style="text-align:left;padding:8px 12px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Athlete</th>
            <th style="text-align:center;padding:8px 12px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Meets</th>
            <th style="text-align:center;padding:8px 12px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Snatch PR</th>
            <th style="text-align:center;padding:8px 12px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">C&amp;J PR</th>
            <th style="text-align:center;padding:8px 12px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Bench PR</th>
            <th style="text-align:center;padding:8px 12px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Olympic PR</th>
            <th style="text-align:center;padding:8px 12px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--muted);">Traditional PR</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ── Print scoreboard ────────────────────────────────────────────────────────
  function printScoreboard() {
    const m = _meet(); if (!m) return;
    const wcs = _wcs(m.gender);
    const discMap = { both:'Both', traditional:'Traditional', olympic:'Olympic', exhibition:'Exhibition' };

    const numTeams = m.schools.length;
    const scores = {};
    m.schools.forEach(s => { scores[s.id] = { name: s.name, olympic: 0, traditional: 0 }; });

    const pPts = _teamPoints(numTeams);
    const oElig = m.entries.filter(e => e.discipline === 'both' || e.discipline === 'olympic');
    wcs.filter(wc => oElig.some(e => e.wc === wc)).forEach(wc => {
      const grp = oElig.filter(e => e.wc === wc).map(e => ({ e, tot: _olympicTotal(e) })).sort(_rankCmp);
      let p = 0; grp.forEach(r => { if (r.tot > 0 && scores[r.e.schoolId] && p < pPts.length) { scores[r.e.schoolId].olympic += pPts[p++]; } });
    });
    const tElig = m.entries.filter(e => e.discipline === 'both' || e.discipline === 'traditional');
    wcs.filter(wc => tElig.some(e => e.wc === wc)).forEach(wc => {
      const grp = tElig.filter(e => e.wc === wc).map(e => ({ e, tot: _traditionalTotal(e) })).sort(_rankCmp);
      let p = 0; grp.forEach(r => { if (r.tot > 0 && scores[r.e.schoolId] && p < pPts.length) { scores[r.e.schoolId].traditional += pPts[p++]; } });
    });
    const teamRows = Object.values(scores).map(s => ({ ...s, total: s.olympic + s.traditional })).sort((a,b) => b.total - a.total)
      .map((s, i) => `<tr><td>${i+1}</td><td>${s.name}</td><td>${s.olympic}</td><td>${s.traditional}</td><td><strong>${s.total}</strong></td></tr>`).join('');

    const wcSections = wcs.filter(wc => m.entries.some(e => e.wc === wc)).map(wc => {
      const entries = m.entries.filter(e => e.wc === wc);
      const eRows = entries.map(e => {
        const school = m.schools.find(s => s.id === e.schoolId);
        const att = lift => e[lift].map(a => a.result === 'good' ? `<span style="color:green">+${a.declared}</span>` : a.result === 'miss' ? `<span style="color:red">-${a.declared}</span>` : '—').join(' / ');
        return `<tr>
          <td>${e.name}</td><td>${school?.name||''}</td><td>${discMap[e.discipline]||e.discipline}</td>
          ${e.discipline==='both'||e.discipline==='olympic' ? `<td>${att('snatch')}</td><td>${_bestMade(e.snatch)||'—'}</td>` : '<td colspan="2"></td>'}
          <td>${att('cj')}</td><td>${_bestMade(e.cj)||'—'}</td>
          ${e.discipline==='both'||e.discipline==='traditional' ? `<td>${att('bench')}</td><td>${_bestMade(e.bench)||'—'}</td>` : '<td colspan="2"></td>'}
          <td>${_olympicTotal(e)||''}</td><td>${_traditionalTotal(e)||''}</td>
        </tr>`;
      }).join('');
      return `<h3>${wc} lbs</h3><table><thead><tr><th>Athlete</th><th>School</th><th>Disc</th><th colspan="2">Snatch</th><th colspan="2">C&J</th><th colspan="2">Bench</th><th>O-Tot</th><th>T-Tot</th></tr></thead><tbody>${eRows}</tbody></table>`;
    }).join('');

    const css = `body{font-family:Arial,sans-serif;font-size:11pt;color:#000}h1,h2,h3{margin:.5rem 0}table{width:100%;border-collapse:collapse;margin-bottom:1.5rem}th,td{border:1px solid #ccc;padding:3px 7px;text-align:left}th{background:#f0f0f0;font-size:10pt}@media print{button{display:none}}`;
    const win = window.open('', 'LiftBuilderPrint', 'width=1000,height=750');
    if (!win) { showToast('Allow pop-ups to print.'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>${m.name} — Results</title><style>${css}</style></head><body>
      <h1>${m.name}</h1>
      <p>${m.gender} &nbsp;|&nbsp; ${m.date||'—'} &nbsp;|&nbsp; ${m.location||''}</p>
      <button onclick="window.print()" style="margin-bottom:1rem;padding:6px 16px;font-size:12pt;cursor:pointer;">🖨 Print</button>
      <h2>Team Scores</h2>
      <table><thead><tr><th style="text-align:center;">Place</th><th>School</th><th>Olympic</th><th>Traditional</th><th>Total</th></tr></thead><tbody>${teamRows}</tbody></table>
      <h2>Individual Results</h2>${wcSections}
    </body></html>`);
    win.document.close();
    win.focus();
  }

  function exportCompSheetPDF() {
    const m = _meet(); if (!m) return;
    const wcs = _wcs(m.gender);

    function hexToRgba(hex, alpha) {
      if (!hex || hex.length < 7) return `rgba(200,200,200,${alpha})`;
      const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
      return `rgba(${r},${g},${b},${alpha})`;
    }

    const wcSections = wcs.filter(wc => m.entries.some(e => e.wc === wc)).map(wc => {
      const entries = m.entries.filter(e => e.wc === wc);
      const sorted  = [...entries].sort((a,b) => {
        const sa = m.schools.findIndex(s => s.id === a.schoolId);
        const sb = m.schools.findIndex(s => s.id === b.schoolId);
        return sa - sb || a.name.localeCompare(b.name);
      });

      const rows = sorted.map(e => {
        const sch  = m.schools.find(s => s.id === e.schoolId);
        const bg   = hexToRgba(sch?.color || '#888', 0.12);
        const isEx = e.discipline === 'exhibition';
        const sn1  = e.snatch[0]?.declared || '';
        const cj1  = e.cj[0]?.declared    || '';
        const bn1  = e.bench[0]?.declared  || '';
        const w    = (td, val) => val ? `<td class="ac pre">${val}</td>` : `<td class="ac w"></td>`;
        return `<tr style="background:${bg};">
          <td>${esc(e.name)}${isEx?' <span class="ex">(EX)</span>':''}</td>
          <td class="ac">${esc(sch?.name||'')}</td>
          <td class="ac">${e.weighIn||''}</td>
          ${w(null,sn1)}<td class="ac w"></td><td class="ac w"></td><td class="ac w"></td>
          ${w(null,cj1)}<td class="ac w"></td><td class="ac w"></td><td class="ac w"></td>
          ${w(null,bn1)}<td class="ac w"></td><td class="ac w"></td><td class="ac w"></td>
          <td class="ac w"></td><td class="ac w"></td>
          <td class="ac w"></td><td class="ac w"></td>
        </tr>`;
      }).join('');

      return `<div class="wc-block">
        <div class="wc-title">${wc} Weight Class</div>
        <table>
          <thead>
            <tr class="hdr1">
              <th rowspan="2">Athlete</th><th rowspan="2" class="ac">Team</th><th rowspan="2" class="ac">Weight</th>
              <th colspan="4" class="ac">Snatch</th>
              <th colspan="4" class="ac">Clean &amp; Jerk</th>
              <th colspan="4" class="ac">Bench</th>
              <th colspan="2" class="ac">Oly Total/Points</th>
              <th colspan="2" class="ac">Trd Total/Points</th>
            </tr>
            <tr class="hdr2">
              <th class="ac">1st</th><th class="ac">2nd</th><th class="ac">3rd</th><th class="ac">Best</th>
              <th class="ac">1st</th><th class="ac">2nd</th><th class="ac">3rd</th><th class="ac">Best</th>
              <th class="ac">1st</th><th class="ac">2nd</th><th class="ac">3rd</th><th class="ac">Best</th>
              <th class="ac">Total</th><th class="ac">Pts</th>
              <th class="ac">Total</th><th class="ac">Pts</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }).join('');

    const schoolKey = m.schools.map(s =>
      `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;">
        <span style="display:inline-block;width:12px;height:12px;background:${hexToRgba(s.color||'#888',0.4)};border:1px solid ${s.color||'#888'};border-radius:2px;"></span>
        ${esc(s.name)}
      </span>`).join('');

    const css = `
      @page{size:Letter landscape;margin:.45in}
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;font-size:9pt;color:#000;padding:10px}
      h1{font-size:15pt;font-weight:700;text-align:center;margin-bottom:2px}
      .meta{font-size:8.5pt;color:#555;text-align:center;margin-bottom:6px}
      .key{font-size:8pt;text-align:center;margin-bottom:12px}
      .wc-block{margin-bottom:16px}
      .wc-title{font-size:10.5pt;font-weight:700;text-align:center;background:#e0e0e0;border:1px solid #bbb;padding:3px 8px}
      table{width:100%;border-collapse:collapse;font-size:8pt}
      th{background:#ebebeb;padding:2px 3px;font-weight:700;border:1px solid #bbb;white-space:nowrap}
      td{padding:0 3px;border:1px solid #bbb;height:20px;white-space:nowrap}
      .ac{text-align:center}
      .pre{font-weight:700;text-align:center;color:#1a4a8a}
      .w{background:#fafafa}
      .ex{font-size:7pt;color:#888}
      .hdr1 th{background:#d0d0d0}
      .hdr2 th{background:#ebebeb;font-size:7pt}
      @media print{.wc-block{page-break-inside:avoid}}`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>${esc(m.name||'Meet')} — Competition Sheets</title>
      <style>${css}</style></head>
      <body>
        <h1>${esc(m.name||'Meet')} — Competition Sheets</h1>
        <div class="meta">${[m.gender,m.date,m.location].filter(Boolean).map(v=>esc(v)).join(' &nbsp;|&nbsp; ')}</div>
        <div class="key">${schoolKey}</div>
        ${wcSections}
      </body></html>`;

    if (window.liftbuilderApp?.exportPDF) {
      window.liftbuilderApp.exportPDF(html)
        .then(r => showToast(r?.success ? 'Comp sheets saved.' : r?.error ? 'PDF failed: '+r.error : 'Cancelled.'))
        .catch(e => showToast('PDF failed: '+(e?.message||e||'unknown')));
    } else {
      const win = window.open('', '_blank', 'width=1200,height=800');
      if (!win) { showToast('Allow pop-ups to print.'); return; }
      win.document.write(html); win.document.close(); win.focus();
      setTimeout(() => win.print(), 500);
    }
  }

  // ── Display window ──────────────────────────────────────────────────────────
  function openDisplayWindow() {
    const m = _meet(); if (!m) return;
    try { localStorage.setItem('liftbuilder_display_meet_id', m.id); } catch(e) {}
    const tok = _platformInfo?.token ? `?pin=${_platformInfo.token}` : '';
    window.open(`/display/1${tok}`, '_blank');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  NAVIGATION
  // ══════════════════════════════════════════════════════════════════════════
  function openMeet(id) {
    _activeMeetId         = id;
    _barWeight            = null;
    _checkedIn.clear();
    _attemptRound         = 1;
    _lastLift             = null;
    _clockStart           = null;
    _clockDuration        = null;
    _clockPausedRemaining = null;
    const m = _meet(); if (!m) return;
    if      (m.status === 'setup')     _view = 'setup';
    else if (m.status === 'weigh-in')  _view = 'weighin';
    else if (m.status === 'complete')  _view = 'results';
    else                               _view = 'competition';
    renderMain();
  }

  function backToList()    { autoSaveSetup(); _view = 'list';    renderMain(); }
  function backToSetup()   { _view = 'setup';   renderMain(); }
  function backToWeighIn() {
    _clockStart           = null;
    _clockDuration        = null;
    _clockPausedRemaining = null;
    _view = 'weighin';
    renderMain();
  }

  function deleteMeet(id) {
    if (!confirm('Delete this meet and all its data? This cannot be undone.')) return;
    _meets = _meets.filter(m => m.id !== id);
    if (_activeMeetId === id) { _activeMeetId = null; _view = 'list'; }
    _save(); renderMain();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SCHEDULE INTEGRATION
  // ══════════════════════════════════════════════════════════════════════════
  function createFromSchedule(scheduleMeet, gender, numPlatforms) {
    const divMap = { OLY:'olympic', Traditional:'traditional', Both:'both', Exhibition:'exhibition', '':'both' };
    const teamName = (typeof state !== 'undefined' && state.teams?.[state.activeTeamId]?.name) || 'Home Team';
    const homeSchool = { id: _uid('sch'), name: teamName, isHome: true };

    const id = _uid('meet');
    const newMeet = {
      id,
      name:         scheduleMeet.name || '',
      date:         scheduleMeet.date || '',
      location:     scheduleMeet.location || '',
      gender,
      status:       'setup',
      useFlights:   false,
      numPlatforms: numPlatforms || 0,
      platformStates: {},
      schools:      [homeSchool],
      entries:      [],
      _scheduleId:  scheduleMeet.id,
    };

    const rosterAthletes = (typeof state !== 'undefined') ? (state.roster?.athletes || []) : [];
    (scheduleMeet.entries || []).forEach((entry, i) => {
      const ath = rosterAthletes.find(a => (a.id || a.name) === entry.athleteId);
      if (!ath) return;
      const disc     = divMap[entry.division || ''] || 'both';
      const wc       = ath.wc || '';
      const platform = numPlatforms > 0 ? ((i % numPlatforms) + 1) : null;
      const e = _blankEntry(ath.name, homeSchool.id, wc, disc, ath.id, {
        snatch: _openAttempt(ath.snatch),
        cj:     _openAttempt(ath.cj),
        bench:  _openAttempt(ath.bench),
      }, !!ath.publicOptOut);
      if (platform !== null) e.platform = platform;
      newMeet.entries.push(e);
    });

    _meets.push(newMeet);
    _activeMeetId = id;
    _view = 'setup';
    _save();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUB-HEADER
  // ══════════════════════════════════════════════════════════════════════════
  function buildSubHeaderHTML() {
    const btn  = (label, onclick, extra='') => `<button onclick="${onclick}" style="background:none;border:none;cursor:pointer;color:var(--muted);font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:600;padding:3px 8px;${extra}">${label}</button>`;
    const back = (label, onclick) => `<button onclick="${onclick}" style="background:none;border:none;cursor:pointer;color:var(--muted);font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:600;padding:3px 8px;" onmouseenter="this.style.color='var(--white)'" onmouseleave="this.style.color='var(--muted)'">${label}</button>`;
    const sep  = `<div style="width:1px;height:20px;background:var(--dark3);flex-shrink:0;margin:0 4px;"></div>`;
    const title = (t) => `<span style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;color:var(--white);">${t}</span>`;
    const spacer = `<div style="flex:1;"></div>`;

    if (_view === 'list') {
      const count    = _meets.length;
      const complete = _meets.filter(m => m.status === 'complete').length;
      const parts    = [];
      if (count)    parts.push(`${count} meet${count!==1?'s':''}`);
      if (complete) parts.push(`${complete} complete`);
      return title('Host Meet') +
        (parts.length ? sep + `<span style="font-family:'Barlow Condensed',sans-serif;font-size:12px;color:var(--muted);">${parts.join(' · ')}</span>` : '') +
        spacer + btn('📊 Stats', 'HM.showStats()') +
        `<button onclick="HM.newMeet()" class="btn btn-gold" style="font-size:12px;padding:5px 14px;">+ New Meet</button>`;
    }

    const m = _meet();
    if (!m) return title('Host Meet');

    if (_view === 'setup') {
      const canProceed = m.name.trim() && m.schools.length >= 2 && m.entries.length > 0;
      return back('← Host Meet', 'HM.backToList()') + sep + title('Meet Setup') + spacer +
        `<button onclick="HM.saveSetupAndProceed()" class="btn btn-gold" style="font-size:12px;padding:5px 14px;" ${canProceed?'':'disabled'} title="${canProceed?'Proceed to weigh-in':'Requires: meet name, 2+ schools, 1+ athlete'}">Proceed to Weigh-In →</button>`;
    }

    if (_view === 'weighin') {
      const totalWeighed = m.entries.filter(e => e.weighIn !== null).length;
      const allDone      = totalWeighed === m.entries.length && m.entries.length > 0;
      return back('← Setup', 'HM.backToSetup()') + sep + title(esc(m.name)) +
        sep + `<span id="hm-wi-counter" style="font-size:12px;color:var(--muted);">${totalWeighed} / ${m.entries.length} weighed in</span>` + spacer +
        `<button onclick="HM.exportCompSheetPDF()" class="btn btn-outline" style="font-size:12px;padding:5px 10px;">🖨 Comp Sheets</button>` +
        `<button id="hm-wi-proceed-btn" onclick="HM.proceedToCompetition()" class="btn btn-gold" style="font-size:12px;padding:5px 14px;" ${allDone?'':'disabled'}>Begin Competition →</button>`;
    }

    if (_view === 'competition') {
      const lift        = m.status;
      const liftLabel   = STATUS_LABEL[lift] || lift;
      const timerRunning = _timerEndMs !== null && _timerPausedRem === null;
      const hasTimer     = _timerEndMs !== null || _timerPausedRem !== null;
      const timerColor   = !hasTimer ? 'var(--muted)' : 'var(--white)';
      const phaseComplete = _phaseComplete(m, lift);
      const timerHTML = `<div style="display:flex;align-items:center;gap:5px;">
        <span id="hm-timer-display" style="font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;min-width:46px;color:${timerColor};">${_fmtTimer()}</span>
        <button onclick="HM.startTimer(300)" class="btn btn-outline" style="font-size:10px;padding:2px 6px;">5m</button>
        <button onclick="HM.startTimer(600)" class="btn btn-outline" style="font-size:10px;padding:2px 6px;">10m</button>
        ${hasTimer ? `<button onclick="HM.pauseResumeTimer()" class="btn btn-outline" style="font-size:10px;padding:2px 6px;">${timerRunning?'⏸':'▶'}</button>
          <button onclick="HM.resetTimer()" class="btn btn-outline" style="font-size:10px;padding:2px 6px;color:#E07070;border-color:#E07070;">✕</button>` : ''}
      </div>`;
      return back('← Weigh-In', 'HM.backToWeighIn()') + sep +
        title(esc(m.name)) +
        `<span style="font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;padding:2px 8px;border-radius:3px;background:var(--gold-a15);color:var(--gold);margin-left:6px;">${liftLabel.toUpperCase()}</span>` +
        spacer + timerHTML + sep +
        `<button onclick="HM._toggleCompFont()" class="btn btn-outline" style="font-size:11px;padding:3px 9px;font-family:'Barlow Condensed',sans-serif;font-weight:700;" title="Toggle font size">${_compFontLarge?'A−':'A+'}</button>` +
        `<button onclick="HM.openDisplayWindow()" class="btn btn-outline" style="font-size:11px;padding:3px 9px;">📺 Display</button>` +
        (m.numPlatforms ? sep + (_platformActive
          ? `<button onclick="HM.stopPlatforms()" class="btn btn-outline" style="font-size:11px;padding:3px 9px;border-color:#5EC08A;color:#5EC08A;">📡 Stop</button>`
          : `<button onclick="HM.startPlatforms()" class="btn btn-gold" style="font-size:11px;padding:3px 9px;">📡 Platforms</button>`) : '') +
        sep + `<button onclick="HM.advancePhase()" class="btn btn-gold" style="font-size:12px;padding:5px 14px;" ${phaseComplete?'':'disabled'}>
          ${lift==='bench'?'Complete Meet ✓':'Next Phase →'}</button>`;
    }

    if (_view === 'results') {
      return back('← Host Meet', 'HM.backToList()') + sep + title(esc(m.name) + ' — Results') + spacer +
        `<button onclick="HM.printScoreboard()" class="btn btn-outline" style="font-size:12px;padding:5px 10px;">🖨 Print</button>` +
        `<button onclick="HM.openDisplayWindow()" class="btn btn-outline" style="font-size:12px;padding:5px 10px;">📺 Display</button>` +
        `<button onclick="HM.syncPRsToRoster()" class="btn btn-outline" style="font-size:12px;padding:5px 10px;">↑ Sync PRs</button>` +
        `<button onclick="HM.exportResultsCSV()" class="btn btn-outline" style="font-size:12px;padding:5px 10px;">⬇ CSV</button>` +
        `<button onclick="HM.exportResultsPDF()" class="btn btn-outline" style="font-size:12px;padding:5px 10px;">⬇ PDF</button>`;
    }

    if (_view === 'stats') {
      const completed = _meets.filter(m => m.status === 'complete');
      return back('← Host Meet', 'HM.backToList()') + sep + title('Athlete Stats') +
        (completed.length ? sep + `<span style="font-size:12px;color:var(--muted);">${completed.length} completed meet${completed.length!==1?'s':''}</span>` : '');
    }

    return title('Host Meet');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════
  return {
    buildHTML, buildSubHeaderHTML,
    // Schedule integration
    createFromSchedule,
    // List
    newMeet, openMeet, deleteMeet,
    // Setup
    autoSaveSetup, saveSetupAndProceed,
    openAddSchoolModal, saveSchool, removeSchool, setSchoolColor,
    openAddEntryModal, saveEntry, removeEntry,
    openEditEntryModal, saveEditEntry,
    openImportRosterModal, confirmImportRoster,
    openImportCSVModal, confirmImportCSV,
    backToList, backToSetup, backToWeighIn,
    // Weigh-in
    saveWeighIn, saveOpen, proceedToCompetition,
    // Competition
    recordResult, openDeclareModal, confirmDeclare,
    checkIn, overrideCheckIn, advanceAttemptRound, setBarWeight, passAttempt, confirmPass,
    scratchEntry, advancePhase,
    // Timer
    startTimer, pauseResumeTimer, resetTimer, _onCompMounted, _tickTimer,
    // Scoreboard
    _setScoreTab, _toggleCompFont,
    // Results
    syncPRsToRoster, exportResultsCSV, exportResultsPDF, exportCompSheetPDF,
    openEditResultModal, saveEditResult, _setAttemptResult,
    // Phase 3
    toggleFlights, setEntryFlight, _setFlight,
    setPlatformForEntry,
    startPlatforms, stopPlatforms, copyLink,
    directorSetBarWeight, directorAdvanceRound, directorAdvancePhase, directorDeclareAttempt,
    pauseClock, resumeClock, resetClock,
    directorPauseClock, directorResumeClock, directorResetClock,
    showStats,
    printScoreboard, openDisplayWindow,
  };
})();
