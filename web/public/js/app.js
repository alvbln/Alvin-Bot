/**
 * Mr. Levin Web UI — Client-side application
 */

const API = '';
let ws = null;
let currentAssistantMsg = null;
let chatMessages = []; // For export
let isTyping = false;
let notifySound = true;
const CHAT_STORAGE_KEY = 'mrlevin_chat_history';

// ── Chat Persistence ────────────────────────────────────
function saveChatToStorage() {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatMessages));
  } catch { /* quota exceeded — ignore */ }
}

function restoreChatFromStorage() {
  try {
    const stored = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!stored) return;
    const messages = JSON.parse(stored);
    if (!Array.isArray(messages) || messages.length === 0) return;
    chatMessages = messages;
    // Rebuild DOM
    for (const msg of messages) {
      addMessage(msg.role, msg.text, msg.time, true /* skipSave */);
    }
  } catch { /* corrupted — ignore */ }
}

function clearChatStorage() {
  localStorage.removeItem(CHAT_STORAGE_KEY);
}

// ── Toast Notifications ─────────────────────────────────
function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Navigation ──────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    const page = item.dataset.page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');
    document.getElementById('page-title').textContent = item.textContent.trim();

    const loaders = { dashboard: loadDashboard, memory: loadMemory, models: loadModels,
      sessions: loadSessions, plugins: loadPlugins, tools: loadTools, files: () => navigateFiles('.'),
      users: loadUsers, settings: loadSettings, platforms: loadPlatforms, personality: loadPersonality };
    if (loaders[page]) loaders[page]();
  });
});

// ── WebSocket ───────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    document.getElementById('bot-status').innerHTML = '<span class="status-dot online"></span> Connected';
  };
  ws.onclose = () => {
    document.getElementById('bot-status').innerHTML = '<span class="status-dot offline"></span> Reconnecting...';
    setTimeout(connectWS, 3000);
  };
  ws.onmessage = (e) => handleWSMessage(JSON.parse(e.data));
}

let pendingTools = []; // Collect tool calls before assistant text
let currentToolGroup = null; // DOM element for grouped tools

function handleWSMessage(msg) {
  const typing = document.getElementById('typing-indicator');

  switch (msg.type) {
    case 'text':
      typing.classList.remove('visible');
      // Flush any pending tools BEFORE the assistant text
      flushToolGroup();
      if (!currentAssistantMsg) {
        currentAssistantMsg = addMessage('assistant', '');
      }
      currentAssistantMsg.querySelector('.msg-text').innerHTML = renderMarkdown(msg.text || '');
      scrollToBottom();
      break;
    case 'tool':
      typing.classList.add('visible');
      // Collect tools — they'll be flushed before the next text
      pendingTools.push({ name: msg.name, input: msg.input });
      // Show live tool indicator
      updateToolIndicator();
      break;
    case 'done':
      flushToolGroup();
      if (msg.cost && currentAssistantMsg) {
        const costEl = document.createElement('span');
        costEl.className = 'time';
        costEl.textContent = `$${msg.cost.toFixed(4)}`;
        currentAssistantMsg.querySelector('.msg-text').appendChild(costEl);
      }
      if (currentAssistantMsg) {
        chatMessages.push({ role: 'assistant', text: currentAssistantMsg.querySelector('.msg-text').textContent, time: timeStr() });
        saveChatToStorage();
      }
      currentAssistantMsg = null;
      document.getElementById('send-btn').disabled = false;
      typing.classList.remove('visible');
      if (notifySound) playNotifySound();
      break;
    case 'error':
      flushToolGroup();
      addMessage('system', `❌ ${msg.error}`);
      currentAssistantMsg = null;
      document.getElementById('send-btn').disabled = false;
      typing.classList.remove('visible');
      break;
    case 'fallback':
      addMessage('system', `⚡ ${msg.from} → ${msg.to}`);
      break;
    case 'reset':
      document.getElementById('messages').innerHTML = '<div class="typing-indicator" id="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';
      addMessage('system', 'Session zurückgesetzt.');
      chatMessages = [];
      pendingTools = [];
      currentToolGroup = null;
      clearChatStorage();
      break;
  }
}

function updateToolIndicator() {
  // Show a live "working..." indicator while tools run
  const typing = document.getElementById('typing-indicator');
  if (pendingTools.length > 0) {
    typing.classList.add('visible');
    typing.innerHTML = `<span style="font-size:0.75em;color:var(--fg2)">🔧 ${pendingTools[pendingTools.length - 1].name}...</span>`;
  }
}

function flushToolGroup() {
  if (pendingTools.length === 0) return;
  // Reset typing indicator to dots
  const typing = document.getElementById('typing-indicator');
  typing.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';

  // Create a grouped, collapsible tool block
  const group = document.createElement('div');
  group.className = 'msg tool-group';
  const count = pendingTools.length;
  const names = [...new Set(pendingTools.map(t => t.name))];
  const summary = names.length <= 3 ? names.join(', ') : names.slice(0, 3).join(', ') + ` +${names.length - 3}`;

  group.innerHTML = `
    <div class="tool-group-header" onclick="this.parentElement.classList.toggle('expanded')">
      <span class="tool-group-icon">🔧</span>
      <span class="tool-group-label">${count} Tool${count > 1 ? 's' : ''} verwendet</span>
      <span class="tool-group-names">${summary}</span>
      <span class="tool-group-chevron">▸</span>
    </div>
    <div class="tool-group-details">
      ${pendingTools.map(t => `<div class="tool-group-item"><span class="tool-item-name">${escapeHtml(t.name)}</span>${t.input ? `<pre class="tool-item-input">${escapeHtml(typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2))}</pre>` : ''}</div>`).join('')}
    </div>
  `;

  const container = document.getElementById('messages');
  container.insertBefore(group, typing);
  pendingTools = [];
  scrollToBottom();
}

// ── Sound ───────────────────────────────────────────────
function playNotifySound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 800; gain.gain.value = 0.1;
    osc.start(); osc.stop(ctx.currentTime + 0.1);
  } catch { /* no audio context */ }
}

// ── Markdown Rendering ──────────────────────────────────
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '• $1')
    .replace(/\n/g, '<br>');
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function timeStr() {
  return new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// ── Chat ────────────────────────────────────────────────
function addMessage(role, text, customTime, skipSave) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  const textEl = document.createElement('span');
  textEl.className = 'msg-text';
  if (role === 'assistant') {
    textEl.innerHTML = renderMarkdown(text);
  } else {
    textEl.textContent = text;
  }
  el.appendChild(textEl);

  if (role !== 'system') {
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = customTime || timeStr();
    el.appendChild(time);
  }

  const container = document.getElementById('messages');
  container.insertBefore(el, document.getElementById('typing-indicator'));
  if (!skipSave) scrollToBottom();
  return el;
}

function scrollToBottom() {
  const msgs = document.getElementById('messages');
  msgs.scrollTop = msgs.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;

  const model = document.getElementById('chat-model')?.value;
  const effort = document.getElementById('chat-effort')?.value;

  const t = timeStr();
  addMessage('user', text, t);
  chatMessages.push({ role: 'user', text, time: t });
  saveChatToStorage();
  ws.send(JSON.stringify({ type: 'chat', text, effort }));
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
  document.getElementById('typing-indicator').classList.add('visible');
  scrollToBottom();
}

function resetChat() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'reset' }));
  }
  chatMessages = [];
  clearChatStorage();
}

function exportChat(format = 'markdown') {
  if (chatMessages.length === 0) { toast('Kein Chat zum Exportieren', 'error'); return; }

  fetch(API + '/api/chat/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: chatMessages, format }),
  })
  .then(res => res.text())
  .then(text => {
    const ext = format === 'json' ? 'json' : 'md';
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mr-levin-chat-${new Date().toISOString().slice(0,10)}.${ext}`;
    a.click();
    toast('Chat exportiert!');
  });
}

// Keyboard shortcuts
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById('chat-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
});

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'n' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); resetChat(); }
  if (e.key === 'e' && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); exportChat(); }
});

// ── Dashboard ───────────────────────────────────────────
async function loadDashboard() {
  const res = await fetch(API + '/api/status');
  const data = await res.json();
  document.getElementById('dashboard-cards').innerHTML = `
    <div class="card"><h3>🤖 Model</h3><div class="value">${data.model.name}</div><div class="sub">${data.model.model}</div></div>
    <div class="card"><h3>⏱ Uptime</h3><div class="value">${Math.floor(data.bot.uptime/3600)}h ${Math.floor(data.bot.uptime%3600/60)}m</div><div class="sub">v${data.bot.version}</div></div>
    <div class="card"><h3>🧠 Memory</h3><div class="value">${data.memory.dailyLogs} Tage</div><div class="sub">${data.memory.vectors} Vektoren · ${data.memory.todayEntries} heute</div></div>
    <div class="card"><h3>🔌 Plugins</h3><div class="value">${data.plugins}</div><div class="sub">geladen</div></div>
    <div class="card"><h3>🔧 MCP</h3><div class="value">${data.mcp}</div><div class="sub">Server</div></div>
    <div class="card"><h3>👥 Users</h3><div class="value">${data.users}</div><div class="sub">Profile</div></div>
  `;
  document.getElementById('model-badge').textContent = data.model.name;
}

// ── Models ──────────────────────────────────────────────
async function loadModels() {
  const res = await fetch(API + '/api/models');
  const data = await res.json();
  document.getElementById('models-list').innerHTML = data.models.map(m => `
    <div class="list-item" onclick="switchModel('${m.key}')" style="cursor:pointer">
      <div class="icon">${m.active ? '✅' : '⬜'}</div>
      <div class="info">
        <div class="name">${m.name}</div>
        <div class="desc">${m.model} — ${m.status}</div>
      </div>
      ${m.active ? '<span class="badge badge-green">Active</span>' : ''}
    </div>
  `).join('');

  // Update chat model selector
  const sel = document.getElementById('chat-model');
  if (sel) {
    sel.innerHTML = data.models.map(m =>
      `<option value="${m.key}" ${m.active ? 'selected' : ''}>${m.name}</option>`
    ).join('');
  }
}

async function switchModel(key) {
  await fetch(API + '/api/models/switch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  loadModels(); loadDashboard();
  toast('Model gewechselt');
}

// ── Memory ──────────────────────────────────────────────
async function loadMemory() {
  const res = await fetch(API + '/api/memory');
  const data = await res.json();
  const sel = document.getElementById('memory-file');
  sel.innerHTML = '<option value="MEMORY.md">📝 MEMORY.md (Langzeit)</option>';
  data.dailyFiles.forEach(f => { sel.innerHTML += `<option value="${f}">📅 ${f}</option>`; });
  document.getElementById('memory-editor').value = data.longTermMemory;
}

async function loadMemoryFile() {
  const file = document.getElementById('memory-file').value;
  const url = file === 'MEMORY.md' ? '/api/memory' : '/api/memory/' + file;
  const res = await fetch(API + url);
  const data = await res.json();
  document.getElementById('memory-editor').value = data.content || data.longTermMemory || '';
}

async function saveMemoryFile() {
  const file = document.getElementById('memory-file').value;
  const content = document.getElementById('memory-editor').value;
  const res = await fetch(API + '/api/memory/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, content }),
  });
  const data = await res.json();
  toast(data.ok ? 'Gespeichert!' : data.error, data.ok ? 'success' : 'error');
}

// ── Sessions ────────────────────────────────────────────
async function loadSessions() {
  const res = await fetch(API + '/api/sessions');
  const data = await res.json();
  const list = document.getElementById('sessions-list');
  if (data.sessions.length === 0) {
    list.innerHTML = '<div class="card"><h3>Keine Sessions</h3><div class="sub">Sessions werden erstellt wenn User chatten.</div></div>';
    return;
  }
  list.innerHTML = data.sessions.map(s => {
    const dur = Math.floor((s.lastActivity - s.startedAt) / 60000);
    return `<div class="list-item"><div class="icon">💬</div><div class="info">
      <div class="name">${s.name}${s.username ? ' @'+s.username : ''}</div>
      <div class="desc">${s.messageCount} msgs · ${s.toolUseCount} tools · $${s.totalCost.toFixed(4)} · ${dur}min</div>
    </div><span class="badge ${s.isProcessing ? 'badge-yellow' : 'badge-green'}">${s.isProcessing ? 'Active' : 'Idle'}</span></div>`;
  }).join('');
}

// ── Plugins ─────────────────────────────────────────────
async function loadPlugins() {
  const res = await fetch(API + '/api/plugins');
  const data = await res.json();
  document.getElementById('plugins-list').innerHTML = data.plugins.length === 0
    ? '<div class="card"><h3>Keine Plugins</h3><div class="sub">Plugins in plugins/ ablegen.</div></div>'
    : data.plugins.map(p => `<div class="list-item"><div class="icon">🔌</div><div class="info">
        <div class="name">${p.name} <span class="badge">${p.version}</span></div>
        <div class="desc">${p.description}${p.commands.length ? ' · '+p.commands.join(', ') : ''}</div>
      </div></div>`).join('');
}

// ── Users ───────────────────────────────────────────────
async function loadUsers() {
  const res = await fetch(API + '/api/users');
  const data = await res.json();
  document.getElementById('users-list').innerHTML = data.users.length === 0
    ? '<div class="card"><h3>Keine User</h3><div class="sub">Werden automatisch erfasst.</div></div>'
    : data.users.map(u => `<div class="list-item"><div class="icon">${u.isOwner ? '👑' : '👤'}</div><div class="info">
        <div class="name">${u.name}${u.username ? ' @'+u.username : ''}</div>
        <div class="desc">${u.totalMessages} msgs · Zuletzt: ${new Date(u.lastActive).toLocaleDateString('de-DE')}</div>
      </div></div>`).join('');
}

// ── Platforms ────────────────────────────────────────────
async function loadPlatforms() {
  const res = await fetch(API + '/api/platforms');
  const data = await res.json();
  document.getElementById('platforms-list').innerHTML = data.platforms.map(p => `
    <div class="list-item">
      <div class="icon">${p.icon}</div>
      <div class="info">
        <div class="name">${p.name}</div>
        <div class="desc">Env: ${p.key}</div>
      </div>
      <span class="badge ${p.configured ? 'badge-green' : 'badge-red'}">${p.configured ? 'Active' : 'Not configured'}</span>
    </div>
  `).join('');
}

// ── Personality (SOUL.md) ───────────────────────────────
async function loadPersonality() {
  const res = await fetch(API + '/api/soul');
  const data = await res.json();
  document.getElementById('soul-editor').value = data.content || '';
}

async function saveSoul() {
  const content = document.getElementById('soul-editor').value;
  const res = await fetch(API + '/api/soul/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const data = await res.json();
  toast(data.ok ? 'Persönlichkeit aktualisiert!' : data.error, data.ok ? 'success' : 'error');
}

// ── Settings ────────────────────────────────────────────
async function loadSettings() {
  const res = await fetch(API + '/api/env');
  const data = await res.json();

  const envHtml = data.vars.map(v => `
    <div class="list-item">
      <div class="info">
        <div class="name" style="font-family:monospace;font-size:0.85em">${v.key}</div>
        <div class="desc">${v.value || '(empty)'}</div>
      </div>
      <button class="btn btn-sm btn-outline" onclick="editEnvVar('${v.key}')">Edit</button>
    </div>
  `).join('');

  document.getElementById('settings-content').innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3>Environment Variables</h3>
      ${envHtml}
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn btn-sm" onclick="addEnvVar()">+ Variable hinzufügen</button>
        <button class="btn btn-sm btn-danger" onclick="restartBot()">🔄 Bot neustarten</button>
      </div>
    </div>
  `;
}

function editEnvVar(key) {
  const value = prompt(`Neuer Wert für ${key}:`, '');
  if (value === null) return;
  fetch(API + '/api/env/set', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }).then(r => r.json()).then(d => {
    toast(d.ok ? `${key} gespeichert! Neustart nötig.` : d.error, d.ok ? 'success' : 'error');
    loadSettings();
  });
}

function addEnvVar() {
  const key = prompt('Variable Name (z.B. DISCORD_TOKEN):');
  if (!key) return;
  const value = prompt(`Wert für ${key}:`);
  if (value === null) return;
  fetch(API + '/api/env/set', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }).then(r => r.json()).then(d => {
    toast(d.ok ? `${key} hinzugefügt!` : d.error, d.ok ? 'success' : 'error');
    loadSettings();
  });
}

async function restartBot() {
  if (!confirm('Bot wirklich neustarten?')) return;
  await fetch(API + '/api/restart', { method: 'POST' });
  toast('Bot wird neugestartet...');
}

// ── Files ───────────────────────────────────────────────
let currentFilePath = '.';

async function navigateFiles(dir) {
  if (dir === '..') {
    const parts = currentFilePath.split('/').filter(Boolean);
    parts.pop();
    currentFilePath = parts.join('/') || '.';
  } else if (dir !== '.') {
    currentFilePath = currentFilePath === '.' ? dir : currentFilePath + '/' + dir;
  }

  const res = await fetch(API + '/api/files?path=' + encodeURIComponent(currentFilePath));
  const data = await res.json();
  document.getElementById('file-breadcrumb').textContent = '📁 /' + (currentFilePath === '.' ? '' : currentFilePath);

  if (data.entries) {
    document.getElementById('file-editor-area').style.display = 'none';
    const icons = { ts:'🔷', js:'🟡', json:'📋', md:'📝', html:'🌐', css:'🎨', sh:'⚡', py:'🐍', txt:'📄', env:'🔒' };
    document.getElementById('file-list').innerHTML = data.entries.map(e => {
      const icon = e.type === 'dir' ? '📁' : (icons[e.name.split('.').pop()?.toLowerCase()] || '📄');
      const size = e.type === 'file' ? formatSize(e.size) : '';
      const fpath = (currentFilePath === '.' ? '' : currentFilePath + '/') + e.name;
      return `<div class="file-item" onclick="${e.type==='dir' ? `navigateFiles('${e.name}')` : `openFile('${fpath}')`}">
        <span class="file-icon">${icon}</span><span class="file-name">${e.name}</span><span class="file-meta">${size}</span></div>`;
    }).join('');
  }
}

async function openFile(filePath) {
  const res = await fetch(API + '/api/files?path=' + encodeURIComponent(filePath));
  const data = await res.json();
  if (data.content !== undefined) {
    document.getElementById('file-editor-area').style.display = '';
    document.getElementById('file-edit-name').textContent = filePath;
    document.getElementById('file-editor').value = data.content;
  }
}

async function saveFile() {
  const path = document.getElementById('file-edit-name').textContent;
  const content = document.getElementById('file-editor').value;
  const res = await fetch(API + '/api/files/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  const data = await res.json();
  toast(data.ok ? 'Gespeichert!' : data.error, data.ok ? 'success' : 'error');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1048576).toFixed(1) + ' MB';
}

// ── Tools ───────────────────────────────────────────────
let allTools = [];

async function loadTools() {
  const res = await fetch(API + '/api/tools');
  const data = await res.json();
  allTools = data.tools || [];
  document.getElementById('tools-count').textContent = allTools.length + ' Tools';
  renderTools(allTools);
}

function filterTools() {
  const q = document.getElementById('tools-search').value.toLowerCase();
  const filtered = q ? allTools.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) : allTools;
  document.getElementById('tools-count').textContent = filtered.length + ' Tools';
  renderTools(filtered);
}

function renderTools(tools) {
  const categories = {};
  tools.forEach(t => {
    const cat = categorize(t.name);
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(t);
  });

  const icons = { '🖥️ System': '🖥️', '📧 Email': '📧', '🖱️ Automation': '🖱️', '📄 PDF': '📄', '🔧 Dev Tools': '🔧', '🌐 Network': '🌐', '🎨 Media': '🎨', '📋 Clipboard': '📋', '📁 Files': '📁', '🔨 Other': '🔨' };

  let html = '';
  for (const [cat, catTools] of Object.entries(categories)) {
    html += `<div style="margin-bottom:20px"><h3 style="font-size:0.85em;color:var(--fg2);margin-bottom:8px">${cat}</h3>`;
    html += catTools.map(t => {
      const params = Object.keys(t.parameters || {});
      const paramBadges = params.map(p => `<span class="badge" style="font-size:0.65em">${p}</span>`).join(' ');
      return `<div class="list-item" style="cursor:pointer" onclick="runTool('${escapeHtml(t.name)}')">
        <div class="info">
          <div class="name" style="font-family:monospace;font-size:0.85em">${t.name} ${paramBadges}</div>
          <div class="desc">${t.description}</div>
        </div>
        <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();runTool('${escapeHtml(t.name)}')">▶️ Run</button>
      </div>`;
    }).join('');
    html += '</div>';
  }
  document.getElementById('tools-list').innerHTML = html || '<div class="card"><h3>Keine Tools</h3><div class="sub">Tools in docs/tools.json konfigurieren.</div></div>';
}

function categorize(name) {
  if (['run_shell','sudo_command','system_info','volume_set','brightness_set','bluetooth_control','wifi_status','say_text','notify','process_list','kill_process'].includes(name)) return '🖥️ System';
  if (name.startsWith('email_')) return '📧 Email';
  if (['osascript','osascript_js','cliclick_type','cliclick_click','cliclick_key'].includes(name)) return '🖱️ Automation';
  if (name.startsWith('pdf_') || name.includes('_to_pdf')) return '📄 PDF';
  if (['git_status','git_commit','pm2_status','pm2_restart','pm2_logs','ssh_command','docker_ps'].includes(name)) return '🔧 Dev Tools';
  if (['web_fetch','network_check','open_url'].includes(name)) return '🌐 Network';
  if (['image_convert','image_resize','ffmpeg_convert','whisper_transcribe','screenshot'].includes(name)) return '🎨 Media';
  if (['clipboard_get','clipboard_set'].includes(name)) return '📋 Clipboard';
  if (['find_files','disk_usage','open_file','calendar_today','calendar_upcoming'].includes(name)) return '📁 Files';
  return '🔨 Other';
}

function runTool(name) {
  const tool = allTools.find(t => t.name === name);
  if (!tool) return;
  const params = Object.entries(tool.parameters || {});

  if (params.length === 0) {
    // No params — run directly
    executeTool(name, {});
    return;
  }

  // Prompt for params
  const values = {};
  for (const [key, def] of params) {
    const val = prompt(`${key}: ${def.description}`, '');
    if (val === null) return; // Cancelled
    if (val) values[key] = val;
  }
  executeTool(name, values);
}

async function executeTool(name, params) {
  toast(`Running ${name}...`);
  try {
    const res = await fetch(API + '/api/tools/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, params }),
    });
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
    } else {
      // Show result in a dialog or terminal
      const output = data.output || '(no output)';
      // Switch to terminal and show output
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      document.querySelector('[data-page="terminal"]').classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-terminal').classList.add('active');
      document.getElementById('page-title').textContent = '💻 Terminal';
      const termOutput = document.getElementById('terminal-output');
      termOutput.innerHTML += `<div class="term-cmd">🛠️ ${escapeHtml(name)} ${JSON.stringify(params)}</div>`;
      termOutput.innerHTML += `<div>${escapeHtml(output)}</div>`;
      termOutput.scrollTop = termOutput.scrollHeight;
      toast('Tool ausgeführt!');
    }
  } catch (err) {
    toast('Fehler: ' + err.message, 'error');
  }
}

// ── Terminal ────────────────────────────────────────────
const termHist = []; let termIdx = -1;
async function runCommand() {
  const input = document.getElementById('terminal-input');
  const output = document.getElementById('terminal-output');
  const cmd = input.value.trim();
  if (!cmd) return;
  termHist.unshift(cmd); termIdx = -1; input.value = '';
  output.innerHTML += `<div class="term-cmd">$ ${escapeHtml(cmd)}</div>`;
  try {
    const res = await fetch(API + '/api/terminal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    });
    const data = await res.json();
    if (data.output) output.innerHTML += `<div class="${data.exitCode ? 'term-err' : ''}">${escapeHtml(data.output)}</div>`;
  } catch (err) { output.innerHTML += `<div class="term-err">Error: ${err.message}</div>`; }
  output.scrollTop = output.scrollHeight;
}

document.getElementById('terminal-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runCommand(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (termIdx < termHist.length-1) e.target.value = termHist[++termIdx]; }
  if (e.key === 'ArrowDown') { e.preventDefault(); termIdx > 0 ? e.target.value = termHist[--termIdx] : (termIdx=-1, e.target.value=''); }
});

// ── Theme Toggle ────────────────────────────────────────
function toggleTheme() {
  const body = document.documentElement;
  const current = body.getAttribute('data-theme');
  body.setAttribute('data-theme', current === 'light' ? '' : 'light');
  localStorage.setItem('theme', current === 'light' ? 'dark' : 'light');
}
// Restore theme
if (localStorage.getItem('theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');

// ── Init ────────────────────────────────────────────────
restoreChatFromStorage();
if (chatMessages.length > 0) scrollToBottom();
connectWS();
loadDashboard();
loadModels(); // Populate chat model selector
