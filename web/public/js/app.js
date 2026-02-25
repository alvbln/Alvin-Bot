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
      sessions: loadSessions, plugins: loadPlugins, tools: loadTools, cron: loadCron,
      files: () => navigateFiles('.'), users: loadUsers, settings: loadSettings,
      platforms: loadPlatforms, personality: loadPersonality, maintenance: loadMaintenance,
      'wa-groups': loadWAGroups };
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

// ── Models / Providers ──────────────────────────────────
async function loadModels() {
  // Load both the quick model list (for chat selector) and the full setup view
  const [modelsRes, setupRes] = await Promise.all([
    fetch(API + '/api/models'),
    fetch(API + '/api/providers/setup'),
  ]);
  const modelsData = await modelsRes.json();
  const setupData = await setupRes.json();

  // Update chat model selector
  const sel = document.getElementById('chat-model');
  if (sel) {
    sel.innerHTML = modelsData.models.map(m =>
      `<option value="${m.key}" ${m.active ? 'selected' : ''}>${m.name}</option>`
    ).join('');
  }

  // Render full provider setup cards
  let html = '<div style="margin-bottom:20px"><h3 style="font-size:1em;margin-bottom:4px">🤖 KI-Modelle & Provider</h3><div class="sub">API Keys einrichten, Modelle aktivieren und Custom Models hinzufügen.</div></div>';

  for (const p of setupData.providers) {
    const statusBadge = p.hasKey
      ? '<span class="badge badge-green">✅ Key gesetzt</span>'
      : (p.free ? '<span class="badge badge-yellow">⚡ Gratis verfügbar</span>' : '<span class="badge badge-red">❌ Kein Key</span>');

    html += `<div class="card setup-card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-size:1.5em">${p.icon}</span>
        <div style="flex:1">
          <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">${p.name}</h3>
          <div class="sub">${p.description}</div>
        </div>
        ${statusBadge}
      </div>`;

    // Setup steps (collapsible)
    html += `<details style="margin-bottom:12px"><summary style="cursor:pointer;color:var(--accent2);font-size:0.82em;font-weight:500">📋 Setup-Anleitung</summary><ol style="margin:8px 0 0 16px;color:var(--fg2);font-size:0.82em;line-height:1.6">`;
    for (const step of p.setupSteps) {
      html += `<li>${step}</li>`;
    }
    if (p.signupUrl) html += `<li><a href="${p.signupUrl}" target="_blank" style="color:var(--accent2)">${p.signupUrl}</a></li>`;
    html += `</ol></details>`;

    // API Key input (if applicable)
    if (p.envKey) {
      html += `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <input type="password" id="key-${p.id}" placeholder="API Key eingeben..." value="${p.keyPreview}" style="flex:1;background:var(--bg3);border:1px solid var(--bg3);border-radius:6px;padding:8px 12px;color:var(--fg);font:inherit;font-size:0.85em;font-family:monospace;outline:none">
        <button class="btn btn-sm" onclick="saveProviderKey('${p.id}')">💾 Speichern</button>
        <button class="btn btn-sm btn-outline" onclick="testProviderKey('${p.id}')">🧪 Testen</button>
      </div>
      <div id="key-result-${p.id}" style="font-size:0.78em;margin-bottom:8px"></div>`;
    }

    // Model list with activate buttons
    html += `<div style="border-top:1px solid var(--bg3);padding-top:8px;margin-top:4px">`;
    for (const m of p.modelsActive) {
      const isActive = m.active;
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:0.85em">
        <span style="width:20px;text-align:center">${isActive ? '✅' : (m.registered ? '⬜' : '⚪')}</span>
        <span style="flex:1;font-family:monospace">${m.name} <span style="color:var(--fg2)">(${m.model})</span></span>
        ${isActive ? '<span class="badge badge-green">Aktiv</span>' : `<button class="btn btn-sm btn-outline" onclick="switchModel('${m.key}')">Aktivieren</button>`}
      </div>`;
    }
    html += `</div></div>`;
  }

  // Custom Models section
  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:1.5em">🔧</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">Custom Models</h3>
        <div class="sub">Eigene OpenAI-kompatible Endpunkte hinzufügen (LM Studio, vLLM, Together AI, etc.)</div>
      </div>
    </div>`;

  if (setupData.customModels.length > 0) {
    for (const cm of setupData.customModels) {
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:0.85em;border-bottom:1px solid var(--bg3)">
        <span style="font-family:monospace;flex:1">${cm.name} <span style="color:var(--fg2)">(${cm.model})</span></span>
        <span class="badge">${cm.baseUrl}</span>
        <button class="btn btn-sm btn-outline" onclick="switchModel('${cm.key}')">Aktivieren</button>
        <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="removeCustomModel('${cm.key}')">✕</button>
      </div>`;
    }
  }

  html += `<button class="btn btn-sm" style="margin-top:12px" onclick="showAddCustomModel()">+ Custom Model hinzufügen</button>
    <div id="custom-model-form" style="display:none;margin-top:12px;padding:12px;background:var(--bg3);border-radius:8px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <input id="cm-key" placeholder="Eindeutiger Key (z.B. my-llama)" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
        <input id="cm-name" placeholder="Anzeigename (z.B. My Llama 3)" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
        <input id="cm-model" placeholder="Model ID (z.B. meta-llama/Llama-3-70b)" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
        <input id="cm-url" placeholder="Base URL (z.B. http://localhost:1234/v1)" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
        <input id="cm-apikey-env" placeholder="API Key Env-Var (optional, z.B. CUSTOM_API_KEY)" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
        <input id="cm-apikey" type="password" placeholder="API Key (optional)" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-sm" onclick="addCustomModel()">💾 Hinzufügen</button>
        <button class="btn btn-sm btn-outline" onclick="document.getElementById('custom-model-form').style.display='none'">Abbrechen</button>
      </div>
    </div>
  </div>`;

  // Fallback chain
  html += `<div class="card">
    <h3 style="font-size:0.85em;text-transform:none;margin-bottom:8px">⛓️ Fallback-Kette</h3>
    <div class="sub" style="margin-bottom:8px">Wenn das primäre Modell fehlschlägt, werden diese Modelle der Reihe nach probiert.</div>
    <div style="font-family:monospace;font-size:0.85em;color:var(--accent2);padding:8px;background:var(--bg3);border-radius:6px">${setupData.activeModel} → ${modelsData.models.filter(m => !m.active).map(m => m.key).slice(0, 3).join(' → ') || '(keine Fallbacks)'}</div>
  </div>`;

  document.getElementById('models-setup').innerHTML = html;
}

async function switchModel(key) {
  await fetch(API + '/api/models/switch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  loadModels(); loadDashboard();
  toast('Model gewechselt');
}

async function saveProviderKey(providerId) {
  const input = document.getElementById('key-' + providerId);
  const apiKey = input.value.trim();
  if (!apiKey || apiKey.includes('...')) { toast('Bitte einen vollständigen Key eingeben', 'error'); return; }
  const res = await fetch(API + '/api/providers/set-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, apiKey }),
  });
  const data = await res.json();
  toast(data.ok ? '🔑 Key gespeichert! Bot-Neustart nötig.' : data.error, data.ok ? 'success' : 'error');
}

async function testProviderKey(providerId) {
  const input = document.getElementById('key-' + providerId);
  const apiKey = input.value.trim();
  if (!apiKey || apiKey.includes('...')) { toast('Bitte einen vollständigen Key eingeben', 'error'); return; }
  const resultDiv = document.getElementById('key-result-' + providerId);
  resultDiv.innerHTML = '<span style="color:var(--fg2)">⏳ Teste...</span>';
  const res = await fetch(API + '/api/providers/test-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, apiKey }),
  });
  const data = await res.json();
  resultDiv.innerHTML = data.ok
    ? `<span style="color:var(--green)">✅ Key funktioniert!</span>`
    : `<span style="color:var(--red)">❌ ${data.error}</span>`;
}

function showAddCustomModel() {
  document.getElementById('custom-model-form').style.display = '';
}

async function addCustomModel() {
  const model = {
    key: document.getElementById('cm-key').value.trim(),
    name: document.getElementById('cm-name').value.trim(),
    model: document.getElementById('cm-model').value.trim(),
    baseUrl: document.getElementById('cm-url').value.trim(),
    apiKeyEnv: document.getElementById('cm-apikey-env').value.trim(),
    apiKey: document.getElementById('cm-apikey').value.trim(),
    type: 'openai-compatible',
    supportsStreaming: true,
  };
  if (!model.key || !model.name || !model.model || !model.baseUrl) {
    toast('Bitte alle Pflichtfelder ausfüllen', 'error');
    return;
  }
  const res = await fetch(API + '/api/providers/add-custom', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(model),
  });
  const data = await res.json();
  if (data.ok) {
    toast('Custom Model hinzugefügt! Neustart nötig.');
    document.getElementById('custom-model-form').style.display = 'none';
    loadModels();
  } else {
    toast(data.error, 'error');
  }
}

async function removeCustomModel(key) {
  if (!confirm(`Custom Model "${key}" entfernen?`)) return;
  await fetch(API + '/api/providers/remove-custom', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  toast('Entfernt');
  loadModels();
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
const PLATFORM_ICONS = { telegram: '✈️', whatsapp: '💬', discord: '🎮', signal: '🔒', webui: '🌐', web: '🌐' };

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'gerade eben';
  if (diff < 3600000) return `vor ${Math.floor(diff/60000)} Min`;
  if (diff < 86400000) return `vor ${Math.floor(diff/3600000)} Std`;
  return new Date(ts).toLocaleDateString('de-DE', { day:'numeric', month:'short', year:'numeric' });
}

async function loadUsers() {
  const res = await fetch(API + '/api/users');
  const data = await res.json();
  const el = document.getElementById('users-list');

  if (data.users.length === 0) {
    el.innerHTML = '<div class="card"><h3>Keine User</h3><div class="sub">Werden automatisch erfasst sobald jemand schreibt.</div></div>';
    return;
  }

  el.innerHTML = data.users.map(u => {
    const platformIcon = PLATFORM_ICONS[u.lastPlatform] || '❓';
    const platformName = u.lastPlatform ? u.lastPlatform.charAt(0).toUpperCase() + u.lastPlatform.slice(1) : 'Unbekannt';
    const lastMsg = u.lastMessage ? `<div class="user-last-msg">"${escapeHtml(u.lastMessage)}"</div>` : '';
    const sessionInfo = u.session ? `
      <div class="user-session-info">
        ${u.session.isProcessing ? '<span class="badge badge-yellow">⏳ Verarbeitet...</span>' : ''}
        ${u.session.hasActiveQuery ? '<span class="badge badge-yellow">🔄 Query aktiv</span>' : ''}
        ${u.session.queuedMessages > 0 ? `<span class="badge badge-blue">📨 ${u.session.queuedMessages} in Queue</span>` : ''}
        <span title="Kosten">💰 $${u.session.totalCost.toFixed(4)}</span>
        <span title="Nachrichten in Session">💬 ${u.session.messageCount}</span>
        <span title="Tool-Aufrufe">🔧 ${u.session.toolUseCount}</span>
        <span title="History-Länge">📜 ${u.session.historyLength}</span>
        <span title="Effort-Level">🧠 ${u.session.effort}</span>
      </div>` : '<div class="user-session-info"><span class="sub">Keine aktive Session</span></div>';

    const killBtn = u.isOwner ? '' : `<button class="btn btn-danger btn-sm" onclick="killUser(${u.userId}, '${escapeHtml(u.name)}')" title="Session & Daten löschen">🗑️</button>`;

    return `<div class="card user-card" style="margin-bottom:12px">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div class="icon" style="font-size:1.6em;min-width:36px;text-align:center">${u.isOwner ? '👑' : '👤'}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <strong>${escapeHtml(u.name)}</strong>
            ${u.username ? `<span class="sub">@${escapeHtml(u.username)}</span>` : ''}
            <span class="badge badge-${u.session ? 'green' : 'gray'}" style="font-size:0.7em">${u.session ? 'Online' : 'Offline'}</span>
            ${killBtn}
          </div>
          <div class="sub" style="margin-top:4px">
            ${platformIcon} ${platformName} · ${u.totalMessages} Nachrichten · Zuletzt aktiv: ${timeAgo(u.lastActive)}
          </div>
          ${lastMsg}
          ${sessionInfo}
        </div>
      </div>
    </div>`;
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function killUser(userId, name) {
  if (!confirm(`User "${name}" wirklich löschen?\n\nDas löscht:\n• Aktive Session (+ laufende Anfrage)\n• Profil-Daten\n• Chat-History\n• Memory-Verzeichnis\n\nDiese Aktion kann nicht rückgängig gemacht werden!`)) return;

  try {
    const res = await fetch(API + `/api/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      const summary = data.deleted.length > 0 ? `Gelöscht: ${data.deleted.join(', ')}` : 'Nichts zu löschen';
      alert(`✅ User gelöscht.\n\n${summary}`);
      loadUsers(); // Refresh
    } else {
      alert(`❌ Fehler: ${data.error || 'Unbekannt'}`);
    }
  } catch (e) {
    alert(`❌ Fehler: ${e.message}`);
  }
}

// ── Platforms ────────────────────────────────────────────
async function loadPlatforms() {
  const res = await fetch(API + '/api/platforms/setup');
  const data = await res.json();

  let html = '<div style="margin-bottom:20px"><h3 style="font-size:1em;margin-bottom:4px">📱 Messaging-Plattformen</h3><div class="sub">Verbinde Mr. Levin mit verschiedenen Messaging-Diensten. Mehrere gleichzeitig möglich.</div></div>';

  for (const p of data.platforms) {
    let statusBadge;
    if (p.configured && p.depsInstalled) {
      statusBadge = `<span class="badge badge-green" id="badge-${p.id}">✅ Bereit</span>`;
    } else if (p.configured && !p.depsInstalled) {
      statusBadge = `<span class="badge badge-yellow" id="badge-${p.id}">📦 Deps fehlen</span>`;
    } else {
      statusBadge = `<span class="badge badge-red" id="badge-${p.id}">Nicht eingerichtet</span>`;
    }
    const depsBadge = '';

    html += `<div class="card setup-card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-size:1.8em">${p.icon}</span>
        <div style="flex:1">
          <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">${p.name}</h3>
          <div class="sub">${p.description}</div>
        </div>
        ${statusBadge} ${depsBadge}
      </div>`;

    // Setup steps
    html += `<details ${p.configured ? '' : 'open'} style="margin-bottom:12px"><summary style="cursor:pointer;color:var(--accent2);font-size:0.82em;font-weight:500">📋 Setup-Anleitung</summary><ol style="margin:8px 0 0 16px;color:var(--fg2);font-size:0.82em;line-height:1.6">`;
    for (const step of p.setupSteps) {
      html += `<li>${step}</li>`;
    }
    if (p.setupUrl) html += `<li><a href="${p.setupUrl}" target="_blank" style="color:var(--accent2)">${p.setupUrl}</a></li>`;
    html += `</ol></details>`;

    // Env var inputs
    html += `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:8px">`;
    for (const v of p.envVars) {
      if (v.type === 'toggle') {
        const checked = p.values[v.key] === 'true' ? 'checked' : '';
        html += `<label style="display:flex;align-items:center;gap:8px;font-size:0.85em;cursor:pointer">
          <input type="checkbox" id="pv-${p.id}-${v.key}" ${checked} style="width:18px;height:18px;accent-color:var(--accent)">
          <span>${v.label}</span>
        </label>`;
      } else {
        html += `<div style="display:flex;gap:8px;align-items:center">
          <label style="font-size:0.78em;color:var(--fg2);min-width:120px">${v.label}</label>
          <input type="${v.secret ? 'password' : 'text'}" id="pv-${p.id}-${v.key}" placeholder="${v.placeholder}" value="${p.values[v.key] || ''}" style="flex:1;background:var(--bg3);border:1px solid var(--bg3);border-radius:6px;padding:8px 12px;color:var(--fg);font:inherit;font-size:0.85em;font-family:monospace;outline:none">
        </div>`;
      }
    }
    html += `</div>`;

    // Action buttons
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-sm" onclick="savePlatform('${p.id}')">💾 Speichern</button>`;
    if (p.npmPackages && !p.depsInstalled) {
      html += `<button class="btn btn-sm btn-outline" onclick="installPlatformDeps('${p.id}')">📦 Dependencies installieren</button>`;
    }
    if (p.configured) {
      html += `<button class="btn btn-sm btn-outline" onclick="testPlatformConnection('${p.id}')">🧪 Verbindung testen</button>`;
      html += `<button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="disablePlatform('${p.id}')">Deaktivieren</button>`;
    }
    html += `<span id="platform-live-${p.id}" style="font-size:0.78em;margin-left:4px"></span>`;
    html += `</div>`;

    // WhatsApp: QR code + connection status area
    if (p.id === 'whatsapp' && p.configured && p.depsInstalled) {
      html += `<div id="wa-qr-area" style="margin-top:12px;padding:12px;background:var(--bg3);border-radius:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span id="wa-status-dot" style="font-size:1.2em">⏳</span>
          <span id="wa-status-text" style="font-size:0.85em;color:var(--fg2)">Status wird geladen...</span>
          <div style="flex:1"></div>
          <button class="btn btn-sm btn-outline" onclick="checkWhatsAppStatus()">🔄 Status prüfen</button>
          <button class="btn btn-sm btn-outline" style="color:var(--red);font-size:0.78em" onclick="disconnectWhatsApp()">🔌 Trennen & Reset</button>
        </div>
        <div id="wa-qr-container" style="display:none;text-align:center;padding:16px;background:#fff;border-radius:8px;margin-top:8px">
          <canvas id="wa-qr-canvas" style="image-rendering:pixelated"></canvas>
          <div style="color:#333;font-size:0.82em;margin-top:8px">📱 Scanne mit WhatsApp → Verknüpfte Geräte → Gerät hinzufügen</div>
        </div>
      </div>`;
    }

    html += `<div id="platform-result-${p.id}" style="font-size:0.78em;margin-top:6px"></div>
    </div>`;
  }

  document.getElementById('platforms-setup').innerHTML = html;
}

async function savePlatform(platformId) {
  const platform = document.querySelectorAll(`[id^="pv-${platformId}-"]`);
  const values = {};
  platform.forEach(el => {
    const key = el.id.replace(`pv-${platformId}-`, '');
    values[key] = el.type === 'checkbox' ? (el.checked ? 'true' : '') : el.value.trim();
  });
  const res = await fetch(API + '/api/platforms/configure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platformId, values }),
  });
  const data = await res.json();
  const resultDiv = document.getElementById('platform-result-' + platformId);
  if (data.ok) {
    toast('✅ Gespeichert! Neustart nötig.');
    resultDiv.innerHTML = '<span style="color:var(--green)">✅ Gespeichert. Bitte Bot neustarten.</span>';
  } else {
    toast(data.error, 'error');
    resultDiv.innerHTML = `<span style="color:var(--red)">❌ ${data.error}</span>`;
  }
}

async function installPlatformDeps(platformId) {
  toast('📦 Installiere Dependencies...');
  const resultDiv = document.getElementById('platform-result-' + platformId);
  resultDiv.innerHTML = '<span style="color:var(--fg2)">⏳ Installiere...</span>';
  const res = await fetch(API + '/api/platforms/install-deps', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platformId }),
  });
  const data = await res.json();
  if (data.ok) {
    toast('✅ Dependencies installiert!');
    resultDiv.innerHTML = '<span style="color:var(--green)">✅ Installiert!</span>';
    loadPlatforms(); // Refresh
  } else {
    toast('Fehler: ' + data.error, 'error');
    resultDiv.innerHTML = `<span style="color:var(--red)">❌ ${data.error}</span>`;
  }
}

async function disablePlatform(platformId) {
  if (!confirm(`${platformId} wirklich deaktivieren?`)) return;
  // Clear all env vars for this platform
  const inputs = document.querySelectorAll(`[id^="pv-${platformId}-"]`);
  const values = {};
  inputs.forEach(el => {
    const key = el.id.replace(`pv-${platformId}-`, '');
    values[key] = '';
  });
  await fetch(API + '/api/platforms/configure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platformId, values }),
  });
  toast('Plattform deaktiviert. Neustart nötig.');
  loadPlatforms();
}

// ── Platform Connection Test ────────────────────────────
async function testPlatformConnection(platformId) {
  const el = document.getElementById('platform-live-' + platformId);
  if (el) el.innerHTML = '⏳ Teste...';
  try {
    const res = await fetch(API + '/api/platforms/test-connection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platformId }),
    });
    const data = await res.json();
    if (el) {
      el.innerHTML = data.ok
        ? `<span style="color:var(--green)">✅ ${data.info || 'Verbunden'}</span>`
        : `<span style="color:var(--red)">❌ ${data.error || 'Fehler'}</span>`;
    }
  } catch (err) {
    if (el) el.innerHTML = `<span style="color:var(--red)">❌ ${err.message}</span>`;
  }
}

async function loadPlatformStatuses() {
  try {
    const res = await fetch(API + '/api/platforms/status');
    const statuses = await res.json();
    for (const [id, state] of Object.entries(statuses)) {
      const el = document.getElementById('platform-live-' + id);
      const badge = document.getElementById('badge-' + id);
      const s = state;
      const icons = { connected: '🟢', connecting: '🟡', qr: '📱', error: '🔴', disconnected: '⚫', logged_out: '🔴', not_configured: '', unknown: '' };
      const labels = { connected: 'Verbunden', connecting: 'Verbinde...', qr: 'QR-Code scannen!', error: s.error || 'Fehler', disconnected: 'Nicht verbunden', logged_out: 'Abgemeldet', not_configured: '', unknown: '' };
      const icon = icons[s.status] || '';
      const label = labels[s.status] || s.status;

      // Update live status text
      if (el && icon) {
        let extra = '';
        if (s.botUsername) extra = ` @${s.botUsername}`;
        else if (s.botTag) extra = ` ${s.botTag}`;
        else if (s.guildCount) extra = ` (${s.guildCount} Server)`;
        else if (s.apiVersion) extra = ` v${s.apiVersion}`;
        el.innerHTML = `<span style="color:${s.status === 'connected' ? 'var(--green)' : s.status === 'error' || s.status === 'logged_out' ? 'var(--red)' : 'var(--fg2)'}">${icon} ${label}${extra}</span>`;
      }

      // Update badge to reflect real connection status
      if (badge) {
        if (s.status === 'connected') {
          badge.className = 'badge badge-green';
          badge.textContent = '🟢 Verbunden';
        } else if (s.status === 'qr') {
          badge.className = 'badge badge-yellow';
          badge.textContent = '📱 QR scannen';
        } else if (s.status === 'connecting') {
          badge.className = 'badge badge-yellow';
          badge.textContent = '🟡 Verbinde...';
        } else if (s.status === 'error' || s.status === 'logged_out') {
          badge.className = 'badge badge-red';
          badge.textContent = '🔴 Fehler';
        } else if (s.status === 'disconnected') {
          badge.className = 'badge badge-yellow';
          badge.textContent = '⚫ Getrennt';
        }
      }
    }
  } catch { /* ignore */ }
}

// ── WhatsApp QR + Status ────────────────────────────────
let waStatusInterval = null;

async function checkWhatsAppStatus() {
  try {
    const res = await fetch(API + '/api/whatsapp/status');
    const state = await res.json();
    const dot = document.getElementById('wa-status-dot');
    const text = document.getElementById('wa-status-text');
    const qrContainer = document.getElementById('wa-qr-container');
    if (!dot || !text) return;

    const statusMap = {
      disconnected: ['⚫', 'Nicht verbunden'],
      connecting: ['🟡', 'Verbinde...'],
      qr: ['📱', 'QR-Code bereit — jetzt scannen!'],
      connected: ['🟢', 'Verbunden' + (state.connectedAt ? ` seit ${new Date(state.connectedAt).toLocaleTimeString('de-DE')}` : '')],
      logged_out: ['🔴', 'Abgemeldet — Auth-Daten löschen und neu verbinden'],
    };
    const [icon, label] = statusMap[state.status] || ['❓', state.status];
    dot.textContent = icon;
    text.textContent = label;

    // Update the top-right badge
    const badge = document.getElementById('badge-whatsapp');
    if (badge) {
      if (state.status === 'connected') {
        badge.className = 'badge badge-green';
        badge.textContent = '🟢 Verbunden';
      } else if (state.status === 'qr') {
        badge.className = 'badge badge-yellow';
        badge.textContent = '📱 QR scannen';
      } else if (state.status === 'connecting') {
        badge.className = 'badge badge-yellow';
        badge.textContent = '🟡 Verbinde...';
      } else if (state.status === 'error') {
        badge.className = 'badge badge-red';
        badge.textContent = '🔴 Fehler';
      }
    }

    // Update inline status next to buttons
    const liveEl = document.getElementById('platform-live-whatsapp');
    if (liveEl) {
      const infoStr = state.info ? ` (${state.info})` : '';
      if (state.status === 'connected') {
        liveEl.innerHTML = `<span style="color:var(--green)">🟢 Verbunden${infoStr}</span>`;
      } else if (state.status === 'qr') {
        liveEl.innerHTML = `<span style="color:var(--fg2)">📱 QR bereit</span>`;
      } else if (state.status === 'connecting') {
        liveEl.innerHTML = `<span style="color:var(--fg2)">🟡 Verbinde...</span>`;
      } else if (state.status === 'error') {
        liveEl.innerHTML = `<span style="color:var(--red)">🔴 ${state.error || 'Fehler'}</span>`;
      }
    }

    if (state.status === 'qr' && state.qrString && qrContainer) {
      qrContainer.style.display = '';
      renderQrCode(state.qrString);
      // Auto-poll while QR or connecting
      if (!waStatusInterval) {
        waStatusInterval = setInterval(checkWhatsAppStatus, 3000);
      }
    } else if (state.status === 'connecting') {
      if (qrContainer) qrContainer.style.display = 'none';
      // Keep polling during connecting phase
      if (!waStatusInterval) {
        waStatusInterval = setInterval(checkWhatsAppStatus, 3000);
      }
    } else {
      if (qrContainer) qrContainer.style.display = 'none';
      if (state.status === 'connected' && waStatusInterval) {
        clearInterval(waStatusInterval);
        waStatusInterval = null;
      }
    }
  } catch (err) {
    const text = document.getElementById('wa-status-text');
    if (text) text.textContent = 'Fehler: ' + err.message;
  }
}

async function disconnectWhatsApp() {
  if (!confirm('WhatsApp-Verbindung trennen und Auth-Daten löschen?\n\nDu musst danach erneut den QR-Code scannen.')) return;
  try {
    const res = await fetch(API + '/api/whatsapp/disconnect', { method: 'POST' });
    const data = await res.json();
    toast(data.ok ? 'Auth-Daten gelöscht. Bitte Bot neustarten.' : data.error, data.ok ? 'success' : 'error');
  } catch (err) { toast('Fehler: ' + err.message, 'error'); }
}

// Minimal QR code renderer using Canvas API
// Uses a lightweight QR encoder (no external lib)
function renderQrCode(text) {
  const canvas = document.getElementById('wa-qr-canvas');
  if (!canvas) return;

  // If qrcode.js is loaded, use it; otherwise fall back to API
  if (typeof QRCode !== 'undefined') {
    // External lib available
    const qr = new QRCode(canvas.parentElement, { text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M });
    return;
  }

  // Fallback: load qrcode library dynamically
  if (!window._qrScriptLoaded) {
    window._qrScriptLoaded = true;
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
    script.onload = () => renderQrCodeFromLib(text, canvas);
    document.head.appendChild(script);
  } else if (typeof qrcode !== 'undefined') {
    renderQrCodeFromLib(text, canvas);
  }
}

function renderQrCodeFromLib(text, canvas) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();

    const ctx = canvas.getContext('2d');
    const moduleCount = qr.getModuleCount();
    const cellSize = Math.max(4, Math.floor(256 / moduleCount));
    const size = moduleCount * cellSize;
    canvas.width = size;
    canvas.height = size;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#000000';
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        }
      }
    }
  } catch (err) {
    console.error('QR render error:', err);
  }
}

// Auto-check platform statuses when platforms page loads
const origLoadPlatforms = loadPlatforms;
loadPlatforms = async function() {
  await origLoadPlatforms();
  // Load live connection statuses for all platforms
  loadPlatformStatuses();
  // Check WhatsApp QR status if area exists
  if (document.getElementById('wa-qr-area')) {
    checkWhatsAppStatus();
  }
};

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
  const [envRes, sudoRes] = await Promise.all([
    fetch(API + '/api/env'),
    fetch(API + '/api/sudo/status'),
  ]);
  const envData = await envRes.json();
  const sudoData = await sudoRes.json();

  let html = '';

  // ── Sudo / Admin Rights ──
  const sudoIcon = sudoData.configured ? (sudoData.verified ? '🟢' : '🟡') : '🔴';
  const sudoStatusText = sudoData.configured
    ? (sudoData.verified ? 'Aktiv & verifiziert' : 'Konfiguriert, Verifikation nötig')
    : 'Nicht eingerichtet';

  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:1.5em">🔐</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">Sudo / Admin-Rechte</h3>
        <div class="sub">Erlaube Mr. Levin, Befehle mit Administratorrechten auszuführen</div>
      </div>
      <span style="font-size:1.2em">${sudoIcon}</span>
    </div>
    <div style="font-size:0.85em;margin-bottom:12px">
      <div><strong>Status:</strong> ${sudoStatusText}</div>
      <div><strong>Speicher:</strong> ${sudoData.storageMethod}</div>
      <div><strong>System:</strong> ${sudoData.platform} (${sudoData.user})</div>
      ${sudoData.permissions.accessibility !== null ? `<div><strong>Accessibility:</strong> ${sudoData.permissions.accessibility ? '✅' : '❌ <button class="btn btn-sm btn-outline" onclick="openSysSettings(\'accessibility\')" style="font-size:0.8em;padding:2px 6px">Öffnen</button>'}</div>` : ''}
      ${sudoData.permissions.fullDiskAccess !== null ? `<div><strong>Full Disk Access:</strong> ${sudoData.permissions.fullDiskAccess ? '✅' : '❌ <button class="btn btn-sm btn-outline" onclick="openSysSettings(\'full-disk-access\')" style="font-size:0.8em;padding:2px 6px">Öffnen</button>'}</div>` : ''}
    </div>`;

  if (!sudoData.configured) {
    html += `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <input type="password" id="sudo-password" placeholder="System-Passwort eingeben..." style="flex:1;background:var(--bg3);border:1px solid var(--bg3);border-radius:6px;padding:8px 12px;color:var(--fg);font:inherit;font-size:0.85em;outline:none">
      <button class="btn btn-sm" onclick="setupSudo()">🔐 Einrichten</button>
    </div>
    <div class="sub">Das Passwort wird sicher im ${sudoData.storageMethod} gespeichert — nie im Klartext.</div>`;
  } else {
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm btn-outline" onclick="verifySudo()">🧪 Verifizieren</button>
      <button class="btn btn-sm btn-outline" onclick="testSudoCommand()">⚡ Test-Command</button>
      ${sudoData.platform === 'darwin' ? '<button class="btn btn-sm btn-outline" onclick="showAdminDialog()">🖥️ Admin-Dialog</button>' : ''}
      <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="revokeSudo()">🔴 Widerrufen</button>
    </div>`;
  }
  html += `<div id="sudo-result" style="font-size:0.78em;margin-top:6px"></div></div>`;

  // ── Environment Variables ──
  const envHtml = envData.vars.map(v => `
    <div class="list-item">
      <div class="info">
        <div class="name" style="font-family:monospace;font-size:0.85em">${v.key}</div>
        <div class="desc">${v.value || '(empty)'}</div>
      </div>
      <button class="btn btn-sm btn-outline" onclick="editEnvVar('${v.key}')">Edit</button>
    </div>
  `).join('');

  html += `<div class="card" style="margin-bottom:16px">
    <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0;margin-bottom:8px">⚙️ Environment Variables</h3>
    ${envHtml}
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn btn-sm" onclick="addEnvVar()">+ Variable hinzufügen</button>
    </div>
  </div>`;

  document.getElementById('settings-content').innerHTML = html;
}

// ── Doctor & Backup (used by Maintenance page) ─────────
async function repairIssue(action) {
  const res = await fetch(API + '/api/doctor/repair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const data = await res.json();
  toast(data.ok ? `✅ ${data.message}` : `❌ ${data.message}`, data.ok ? 'success' : 'error');
  loadMaintenance();
}

async function repairAll() {
  if (!confirm('Alle Probleme automatisch reparieren?')) return;
  const res = await fetch(API + '/api/doctor/repair-all', { method: 'POST' });
  const data = await res.json();
  const ok = data.results.filter(r => r.ok).length;
  const fail = data.results.filter(r => !r.ok).length;
  toast(`${ok} repariert${fail > 0 ? `, ${fail} fehlgeschlagen` : ''}`, fail > 0 ? 'error' : 'success');
  loadMaintenance();
}

async function createBackup() {
  const name = prompt('Backup-Name (optional):', '');
  toast('📦 Erstelle Backup...');
  const res = await fetch(API + '/api/backups/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || undefined }),
  });
  const data = await res.json();
  if (data.ok) {
    toast(`✅ Backup "${data.id}" erstellt (${data.files.length} Dateien)`);
    loadMaintenance();
  } else {
    toast('❌ ' + (data.error || 'Fehler'), 'error');
  }
}

function createBackupMaint() { createBackup(); }

async function restoreBackup(id) {
  if (!confirm(`Backup "${id}" wiederherstellen?\n\nAktuelle Config-Dateien werden überschrieben!\nBot-Neustart nötig danach.`)) return;
  const res = await fetch(API + '/api/backups/restore', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const data = await res.json();
  if (data.ok || data.restored?.length > 0) {
    toast(`♻️ ${data.restored.length} Dateien wiederhergestellt! Bot-Neustart nötig.`);
    if (data.errors?.length > 0) toast(`⚠️ ${data.errors.length} Fehler`, 'error');
    loadMaintenance();
  } else {
    toast('❌ ' + (data.errors?.[0] || 'Fehler'), 'error');
  }
}

async function showBackupFiles(id) {
  const area = document.getElementById('backup-files-area');
  if (area.style.display !== 'none' && area.dataset.id === id) {
    area.style.display = 'none';
    return;
  }
  const res = await fetch(API + `/api/backups/${id}/files`);
  const data = await res.json();
  area.dataset.id = id;
  area.style.display = '';
  area.innerHTML = `<div style="font-weight:500;margin-bottom:6px">📋 Dateien in ${id}:</div>` +
    data.files.map(f => `<div style="padding:2px 0;color:var(--fg2)">📄 ${f}</div>`).join('') +
    `<div style="margin-top:8px"><button class="btn btn-sm btn-outline" onclick="document.getElementById('backup-files-area').style.display='none'">Schließen</button></div>`;
}

async function deleteBackup(id) {
  if (!confirm(`Backup "${id}" unwiderruflich löschen?`)) return;
  await fetch(API + '/api/backups/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  toast('Gelöscht');
  loadMaintenance();
}

// ── Sudo ────────────────────────────────────────────────
async function setupSudo() {
  const pw = document.getElementById('sudo-password').value;
  if (!pw) { toast('Bitte Passwort eingeben', 'error'); return; }
  const resultDiv = document.getElementById('sudo-result');
  resultDiv.innerHTML = '<span style="color:var(--fg2)">⏳ Einrichten & verifizieren...</span>';
  const res = await fetch(API + '/api/sudo/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  const data = await res.json();
  if (data.ok && data.verified) {
    toast('✅ Sudo eingerichtet & verifiziert!');
    loadSettings();
  } else {
    resultDiv.innerHTML = `<span style="color:var(--red)">❌ ${data.error || 'Fehler'}</span>`;
    toast(data.error || 'Fehler', 'error');
  }
}

async function verifySudo() {
  const resultDiv = document.getElementById('sudo-result');
  resultDiv.innerHTML = '<span style="color:var(--fg2)">⏳ Verifiziere...</span>';
  const res = await fetch(API + '/api/sudo/verify', { method: 'POST' });
  const data = await res.json();
  resultDiv.innerHTML = data.ok
    ? '<span style="color:var(--green)">✅ Sudo funktioniert!</span>'
    : `<span style="color:var(--red)">❌ ${data.error}</span>`;
}

async function testSudoCommand() {
  const cmd = prompt('Sudo-Befehl zum Testen:', 'whoami');
  if (!cmd) return;
  const resultDiv = document.getElementById('sudo-result');
  resultDiv.innerHTML = '<span style="color:var(--fg2)">⏳ Ausführen...</span>';
  const res = await fetch(API + '/api/sudo/exec', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: cmd }),
  });
  const data = await res.json();
  resultDiv.innerHTML = data.ok
    ? `<span style="color:var(--green)">✅ Output:</span><pre style="margin:4px 0;padding:6px;background:var(--bg3);border-radius:4px;font-size:0.9em;overflow-x:auto">${escapeHtml(data.output.slice(0, 500))}</pre>`
    : `<span style="color:var(--red)">❌ ${data.error}</span>`;
}

async function revokeSudo() {
  if (!confirm('Sudo-Zugriff wirklich widerrufen? Gespeichertes Passwort wird gelöscht.')) return;
  await fetch(API + '/api/sudo/revoke', { method: 'POST' });
  toast('🔴 Sudo-Zugriff widerrufen');
  loadSettings();
}

async function showAdminDialog() {
  const reason = prompt('Grund für Admin-Rechte:', 'Mr. Levin benötigt Administrator-Rechte');
  if (!reason) return;
  toast('🖥️ macOS Admin-Dialog wird angezeigt...');
  const res = await fetch(API + '/api/sudo/admin-dialog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  const data = await res.json();
  toast(data.ok ? '✅ Bestätigt!' : '❌ Abgelehnt oder Fehler', data.ok ? 'success' : 'error');
}

async function openSysSettings(pane) {
  await fetch(API + '/api/sudo/open-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pane }),
  });
  toast('Systemeinstellungen geöffnet');
}

async function restartBot() {
  if (!confirm('Bot wirklich neustarten? Laufende Anfragen werden abgebrochen.')) return;
  toast('🔄 Bot wird neugestartet...');
  await fetch(API + '/api/bot/restart', { method: 'POST' });
  setTimeout(() => { toast('Bot sollte gleich wieder verfügbar sein...'); connectWS(); }, 3000);
}

async function reconnectBot() {
  toast('🔌 Reconnecting...');
  if (ws) ws.close();
  setTimeout(connectWS, 500);
}

// ── PM2 Process Control ──
async function pm2Action(action) {
  const labels = { restart: 'neustarten', reload: 'neu laden', stop: 'stoppen', start: 'starten', flush: 'Logs leeren' };
  const dangerous = ['stop'];
  if (dangerous.includes(action) && !confirm(`Bot wirklich ${labels[action]}? ⚠️ Der Bot wird offline gehen!`)) return;
  if (action === 'restart' && !confirm('Bot neustarten? Laufende Anfragen werden abgebrochen.')) return;

  toast(`⏳ PM2 ${action}...`);
  try {
    const res = await fetch(API + '/api/pm2/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (data.ok) {
      toast(`✅ PM2 ${action} erfolgreich`);
      if (action === 'stop') {
        document.getElementById('pm2-status').innerHTML = '<span class="badge badge-red">⏹️ Gestoppt</span>';
      } else {
        setTimeout(refreshPM2Status, 2000);
        if (action === 'restart' || action === 'reload' || action === 'start') {
          setTimeout(connectWS, 3000);
        }
      }
    } else {
      toast(`❌ PM2 ${action} fehlgeschlagen: ${data.error || 'Unbekannt'}`, 5000);
    }
  } catch (e) {
    toast(`❌ Verbindung verloren (Bot gestoppt?)`, 5000);
    document.getElementById('pm2-status').innerHTML = '<span class="badge badge-red">❌ Nicht erreichbar</span>';
  }
}

async function refreshPM2Status() {
  try {
    const res = await fetch(API + '/api/pm2/status');
    const data = await res.json();
    const el = document.getElementById('pm2-status');
    if (!el) return;

    if (data.error) {
      el.innerHTML = `<span class="badge badge-yellow">⚠️ ${data.error}</span>`;
      return;
    }

    const p = data.process;
    const statusColors = { online: 'green', stopping: 'yellow', stopped: 'red', errored: 'red', launching: 'yellow' };
    const statusIcons = { online: '🟢', stopping: '🟡', stopped: '🔴', errored: '❌', launching: '🚀' };
    const color = statusColors[p.status] || 'gray';
    const icon = statusIcons[p.status] || '❓';

    const uptime = p.uptime > 0 ? formatDuration(p.uptime) : '—';
    const mem = p.memory ? (p.memory / 1024 / 1024).toFixed(1) + ' MB' : '—';
    const cpu = p.cpu !== undefined ? p.cpu + '%' : '—';

    el.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
        <span class="badge badge-${color}">${icon} ${p.status}</span>
        <span title="Uptime">⏱️ ${uptime}</span>
        <span title="Memory">💾 ${mem}</span>
        <span title="CPU">🖥️ ${cpu}</span>
        <span title="Restarts">🔄 ${p.restarts}x</span>
        <span title="PID">PID: ${p.pid || '—'}</span>
        <span title="PM2 Name" style="font-family:monospace;color:var(--accent2)">${p.name}</span>
      </div>`;
  } catch (e) {
    const el = document.getElementById('pm2-status');
    if (el) el.innerHTML = '<span class="badge badge-red">❌ Nicht erreichbar</span>';
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  const d = Math.floor(h / 24);
  return d + 'd ' + (h % 24) + 'h';
}

async function loadPM2Logs() {
  const el = document.getElementById('pm2-log-output');
  if (!el) return;
  el.textContent = 'Lade Logs...';
  try {
    const res = await fetch(API + '/api/pm2/logs');
    const data = await res.json();
    if (data.error) {
      el.textContent = '❌ ' + data.error;
    } else {
      el.textContent = data.logs || '(keine Logs)';
      el.scrollTop = el.scrollHeight;
    }
  } catch (e) {
    el.textContent = '❌ Verbindung fehlgeschlagen';
  }
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
  if (data.error) { toast(data.error, 'error'); return; }
  if (data.content !== undefined && data.content !== null) {
    document.getElementById('file-editor-area').style.display = '';
    document.getElementById('file-edit-name').textContent = filePath;
    document.getElementById('file-editor').value = data.content;
    // Show line count
    const lines = data.content.split('\n').length;
    const sizeStr = data.size ? formatSize(data.size) : '';
    document.getElementById('file-edit-meta')?.remove();
    const meta = document.createElement('div');
    meta.id = 'file-edit-meta';
    meta.style.cssText = 'font-size:0.75em;color:var(--fg2);margin-top:4px';
    meta.textContent = `${lines} Zeilen · ${sizeStr}`;
    document.getElementById('file-editor').parentNode.insertBefore(meta, document.getElementById('file-editor'));
  } else if (data.binary) {
    toast(`Binärdatei (${formatSize(data.size)}) — kann nicht im Editor geöffnet werden.`, 'error');
  } else {
    toast('Datei kann nicht geöffnet werden', 'error');
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

async function createNewFile() {
  const name = prompt('Dateiname (z.B. notes.md):');
  if (!name) return;
  const filePath = currentFilePath === '.' ? name : currentFilePath + '/' + name;
  const res = await fetch(API + '/api/files/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content: '' }),
  });
  const data = await res.json();
  if (data.ok) {
    toast('Datei erstellt!', 'success');
    navigateFiles('.'); // Refresh current dir
    openFile(filePath);
  } else {
    toast(data.error || 'Fehler beim Erstellen', 'error');
  }
}

async function deleteFile(filePath) {
  if (!confirm('Datei löschen?\n\n' + filePath)) return;
  const res = await fetch(API + '/api/files/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });
  const data = await res.json();
  if (data.ok) {
    toast('Gelöscht!', 'success');
    document.getElementById('file-editor-area').style.display = 'none';
    navigateFiles('.'); // Refresh
  } else {
    toast(data.error || 'Fehler beim Löschen', 'error');
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1048576).toFixed(1) + ' MB';
}

// ── Cron ────────────────────────────────────────────────
async function loadCron() {
  const res = await fetch(API + '/api/cron');
  const data = await res.json();
  const list = document.getElementById('cron-list');

  if (data.jobs.length === 0) {
    list.innerHTML = '<div class="card"><h3>Keine Jobs</h3><div class="sub">Erstelle einen Job oben oder via Telegram: /cron add 5m reminder Text</div></div>';
    return;
  }

  list.innerHTML = data.jobs.map(j => {
    const statusIcon = j.enabled ? '🟢' : '⏸️';
    const errIcon = j.lastError ? ' <span style="color:var(--red)">⚠️</span>' : '';
    const typeIcons = { reminder: '⏰', shell: '⚡', http: '🌐', message: '💬', 'ai-query': '🤖' };
    const icon = typeIcons[j.type] || '📋';
    const payload = j.payload.text || j.payload.command || j.payload.url || j.payload.prompt || '';
    const schedLabel = j.scheduleReadable || j.schedule;
    const recBadge = j.oneShot
      ? '<span class="badge badge-yellow">⚡ Einmalig</span>'
      : `<span class="badge" style="background:var(--accent);color:#fff">🔄 ${escapeHtml(schedLabel)}</span>`;

    return `<div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:1.2em">${statusIcon}</span>
        <span style="font-weight:500;flex:1">${icon} ${escapeHtml(j.name)}${errIcon}</span>
        ${recBadge}
      </div>
      <div id="cron-edit-${j.id}" style="display:none;margin-bottom:10px;padding:12px;background:var(--bg3);border-radius:8px">
        ${buildScheduleEditor(j.id, j.schedule, j.oneShot)}
      </div>
      <div style="font-size:0.82em;color:var(--fg2);margin-bottom:8px">
        <span>Nächster Lauf: <strong>${j.nextRunFormatted || '—'}</strong></span> · 
        <span>Runs: ${j.runCount}</span> · 
        <span>Zuletzt: ${j.lastRunFormatted || 'nie'}</span>
      </div>
      ${payload ? `<div style="font-size:0.78em;font-family:monospace;color:var(--fg2);padding:6px 8px;background:var(--bg3);border-radius:4px;margin-bottom:8px;word-break:break-all">${escapeHtml(payload.slice(0, 200))}</div>` : ''}
      ${j.lastError ? `<div style="font-size:0.78em;color:var(--red);margin-bottom:8px">❌ ${escapeHtml(j.lastError)}</div>` : ''}
      <div style="display:flex;gap:6px">
        <button class="btn btn-sm btn-outline" onclick="toggleCronJob('${j.id}')">${j.enabled ? '⏸ Pause' : '▶️ Start'}</button>
        <button class="btn btn-sm btn-outline" onclick="runCronJob('${j.id}')">▶ Jetzt</button>
        <button class="btn btn-sm btn-outline" onclick="editCronSchedule('${j.id}')">✏️ Bearbeiten</button>
        <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="deleteCronJob('${j.id}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function showCreateCron() {
  document.getElementById('cron-create-form').style.display = '';
  // Inject schedule builder for create form (use null id → prefix "create-")
  const container = document.getElementById('cron-create-schedule-builder');
  if (container && !container.innerHTML.trim()) {
    container.innerHTML = buildScheduleEditor(null, '0 8 * * *', false);
  }
}

async function createCronJob() {
  const name = document.getElementById('cron-name').value.trim();
  const type = document.getElementById('cron-type').value;
  const payloadText = document.getElementById('cron-payload').value.trim();

  if (!name) { toast('Name ist Pflicht', 'error'); return; }

  const result = fieldsToCron(null); // null id → create prefix
  if (!result) return;

  const payload = {};
  switch (type) {
    case 'reminder': case 'message': payload.text = payloadText; break;
    case 'shell': payload.command = payloadText; break;
    case 'http': payload.url = payloadText; break;
    case 'ai-query': payload.prompt = payloadText; break;
  }

  const res = await fetch(API + '/api/cron/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, schedule: result.schedule, oneShot: result.oneShot, payload, target: { platform: 'telegram', chatId: 'YOUR_USER_ID' } }),
  });
  const data = await res.json();
  if (data.ok) {
    toast('✅ Job erstellt!');
    document.getElementById('cron-create-form').style.display = 'none';
    document.getElementById('cron-name').value = '';
    document.getElementById('cron-payload').value = '';
    document.getElementById('cron-create-schedule-builder').innerHTML = '';
    loadCron();
  } else {
    toast(data.error, 'error');
  }
}

async function toggleCronJob(id) {
  await fetch(API + '/api/cron/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  loadCron();
}

async function deleteCronJob(id) {
  if (!confirm('Job löschen?')) return;
  await fetch(API + '/api/cron/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  toast('Gelöscht');
  loadCron();
}

// ── Schedule Builder ─────────────────────────────────────

function parseCronToFields(schedule) {
  // Interval strings
  const intMatch = schedule.match(/^(\d+)\s*(m|min|h|hr|d|day|s|sec)s?$/i);
  if (intMatch) {
    const val = intMatch[1];
    const u = intMatch[2].toLowerCase();
    const unit = (u === 'm' || u === 'min') ? 'min' : (u === 'h' || u === 'hr') ? 'h' : (u === 'd' || u === 'day') ? 'd' : 's';
    return { mode: 'interval', interval: val, intervalUnit: unit, hour: '08', minute: '00', weekdays: [], monthday: '1' };
  }
  // Cron expression
  const parts = schedule.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, day, , wd] = parts;
    const weekdays = wd !== '*' ? wd.split(',').flatMap(v => {
      if (v.includes('-')) { const [a,b] = v.split('-').map(Number); const r=[]; for(let i=a;i<=b;i++) r.push(String(i)); return r; }
      return [v];
    }) : [];
    let mode = 'daily';
    if (weekdays.length > 0) mode = 'weekly';
    if (day !== '*') mode = 'monthly';
    return { mode, interval: '5', intervalUnit: 'min', hour: hour === '*' ? '08' : hour.padStart(2,'0'), minute: min === '*' ? '00' : min.padStart(2,'0'), weekdays, monthday: day === '*' ? '1' : day };
  }
  return { mode: 'daily', interval: '5', intervalUnit: 'min', hour: '08', minute: '00', weekdays: [], monthday: '1' };
}

function fieldsToCron(id) {
  const pfx = id ? id + '-' : 'create-';
  const mode = document.querySelector(`input[name="sched-mode-${pfx}"]:checked`)?.value || 'daily';
  const oneShot = document.querySelector(`input[name="sched-recur-${pfx}"]:checked`)?.value === 'true';

  if (mode === 'interval') {
    const val = document.getElementById(`sched-interval-${pfx}`)?.value || '5';
    const unit = document.getElementById(`sched-interval-unit-${pfx}`)?.value || 'min';
    const unitMap = { min: 'm', h: 'h', d: 'd', s: 's' };
    return { schedule: val + (unitMap[unit] || 'm'), oneShot };
  }

  const hour = document.getElementById(`sched-hour-${pfx}`)?.value || '8';
  const minute = document.getElementById(`sched-minute-${pfx}`)?.value || '0';

  if (mode === 'weekly') {
    const checks = document.querySelectorAll(`input[name="sched-wd-${pfx}"]:checked`);
    const days = Array.from(checks).map(c => c.value);
    if (days.length === 0) { toast('Mindestens einen Wochentag wählen', 'error'); return null; }
    return { schedule: `${minute} ${hour} * * ${days.join(',')}`, oneShot };
  }

  if (mode === 'monthly') {
    const day = document.getElementById(`sched-monthday-${pfx}`)?.value || '1';
    return { schedule: `${minute} ${hour} ${day} * *`, oneShot };
  }

  // daily
  return { schedule: `${minute} ${hour} * * *`, oneShot };
}

function buildScheduleEditor(id, schedule, oneShot, hideButtons) {
  const f = parseCronToFields(schedule || '0 8 * * *');
  const pfx = id ? id + '-' : 'create-';
  const wdNames = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  const modeOptions = [
    { val: 'interval', label: '⏱ Intervall', desc: 'z.B. alle 5 Min' },
    { val: 'daily', label: '📅 Täglich', desc: '' },
    { val: 'weekly', label: '📆 Wöchentlich', desc: '' },
    { val: 'monthly', label: '🗓 Monatlich', desc: '' },
  ];

  return `
    <div style="margin-bottom:10px">
      <div style="font-size:0.82em;color:var(--fg2);margin-bottom:6px;font-weight:500">Wiederholung</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        ${modeOptions.map(o => `<label style="display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.82em;background:${f.mode===o.val?'var(--accent)':'var(--bg2)'};color:${f.mode===o.val?'#fff':'var(--fg)'}">
          <input type="radio" name="sched-mode-${pfx}" value="${o.val}" ${f.mode===o.val?'checked':''} onchange="toggleSchedFields('${pfx}')" style="display:none"> ${o.label}
        </label>`).join('')}
      </div>
    </div>

    <div id="sched-interval-row-${pfx}" style="display:${f.mode==='interval'?'flex':'none'};gap:6px;align-items:center;margin-bottom:8px">
      <span style="font-size:0.82em;color:var(--fg2)">Alle</span>
      <input id="sched-interval-${pfx}" type="number" min="1" value="${f.interval}" class="input" style="width:60px;text-align:center">
      <select id="sched-interval-unit-${pfx}" class="input" style="width:auto">
        <option value="s" ${f.intervalUnit==='s'?'selected':''}>Sekunden</option>
        <option value="min" ${f.intervalUnit==='min'?'selected':''}>Minuten</option>
        <option value="h" ${f.intervalUnit==='h'?'selected':''}>Stunden</option>
        <option value="d" ${f.intervalUnit==='d'?'selected':''}>Tage</option>
      </select>
    </div>

    <div id="sched-time-row-${pfx}" style="display:${f.mode!=='interval'?'flex':'none'};gap:6px;align-items:center;margin-bottom:8px">
      <span style="font-size:0.82em;color:var(--fg2)">Um</span>
      <input id="sched-hour-${pfx}" type="number" min="0" max="23" value="${f.hour}" class="input" style="width:50px;text-align:center">
      <span style="font-size:1.1em;font-weight:600">:</span>
      <input id="sched-minute-${pfx}" type="number" min="0" max="59" value="${f.minute}" class="input" style="width:50px;text-align:center">
      <span style="font-size:0.82em;color:var(--fg2)">Uhr</span>
    </div>

    <div id="sched-wd-row-${pfx}" style="display:${f.mode==='weekly'?'flex':'none'};gap:4px;flex-wrap:wrap;margin-bottom:8px">
      ${wdNames.map((d,i) => `<label style="display:flex;align-items:center;gap:2px;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:0.82em;background:${f.weekdays.includes(String(i))?'var(--accent)':'var(--bg2)'};color:${f.weekdays.includes(String(i))?'#fff':'var(--fg)'}">
        <input type="checkbox" name="sched-wd-${pfx}" value="${i}" ${f.weekdays.includes(String(i))?'checked':''} onchange="this.parentElement.style.background=this.checked?'var(--accent)':'var(--bg2)';this.parentElement.style.color=this.checked?'#fff':'var(--fg)'" style="display:none"> ${d}
      </label>`).join('')}
    </div>

    <div id="sched-md-row-${pfx}" style="display:${f.mode==='monthly'?'flex':'none'};gap:6px;align-items:center;margin-bottom:8px">
      <span style="font-size:0.82em;color:var(--fg2)">Am</span>
      <input id="sched-monthday-${pfx}" type="number" min="1" max="31" value="${f.monthday}" class="input" style="width:55px;text-align:center">
      <span style="font-size:0.82em;color:var(--fg2)">. des Monats</span>
    </div>

    <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
      <span style="font-size:0.82em;color:var(--fg2)">Typ:</span>
      <label style="font-size:0.82em;cursor:pointer"><input type="radio" name="sched-recur-${pfx}" value="false" ${!oneShot?'checked':''}> 🔄 Wiederkehrend</label>
      <label style="font-size:0.82em;cursor:pointer"><input type="radio" name="sched-recur-${pfx}" value="true" ${oneShot?'checked':''}> ⚡ Einmalig</label>
    </div>

    ${id ? `<div style="display:flex;gap:6px">
      <button class="btn btn-sm" onclick="saveCronSchedule('${id}')">💾 Speichern</button>
      <button class="btn btn-sm btn-outline" onclick="document.getElementById('cron-edit-${id}').style.display='none'">Abbrechen</button>
    </div>` : ''}`;
}

function toggleSchedFields(pfx) {
  const mode = document.querySelector(`input[name="sched-mode-${pfx}"]:checked`)?.value || 'daily';
  document.getElementById('sched-interval-row-' + pfx).style.display = mode === 'interval' ? 'flex' : 'none';
  document.getElementById('sched-time-row-' + pfx).style.display = mode !== 'interval' ? 'flex' : 'none';
  document.getElementById('sched-wd-row-' + pfx).style.display = mode === 'weekly' ? 'flex' : 'none';
  document.getElementById('sched-md-row-' + pfx).style.display = mode === 'monthly' ? 'flex' : 'none';
}

function editCronSchedule(id) {
  const el = document.getElementById('cron-edit-' + id);
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

async function saveCronSchedule(id) {
  const result = fieldsToCron(id);
  if (!result) return;
  const res = await fetch(API + '/api/cron/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, schedule: result.schedule, oneShot: result.oneShot }),
  });
  const data = await res.json();
  if (data.ok) { toast('✅ Timing aktualisiert!'); loadCron(); }
  else toast('❌ ' + (data.error || 'Fehler'), 'error');
}

async function runCronJob(id) {
  toast('Wird ausgeführt...');
  const res = await fetch(API + '/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  const data = await res.json();
  if (data.error) toast('❌ ' + data.error, 'error');
  else toast('✅ Ausgeführt!');
  loadCron();
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

// ── Maintenance ─────────────────────────────────────────
async function loadMaintenance() {
  const [doctorRes, backupRes] = await Promise.all([
    fetch(API + '/api/doctor'),
    fetch(API + '/api/backups'),
  ]);
  const doctorData = await doctorRes.json();
  const backupData = await backupRes.json();

  let html = '';

  // ── Doctor / Health ──
  const healthIcon = doctorData.healthy ? '🟢' : (doctorData.errorCount > 0 ? '🔴' : '🟡');
  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:1.5em">${healthIcon}</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">🩺 System-Doktor</h3>
        <div class="sub">${doctorData.errorCount} Fehler, ${doctorData.warnCount} Warnungen</div>
      </div>
      <button class="btn btn-sm btn-outline" onclick="loadMaintenance()">🔄 Prüfen</button>
      ${doctorData.errorCount > 0 ? `<button class="btn btn-sm" onclick="repairAll()">🔧 Alles reparieren</button>` : ''}
    </div>`;

  for (const issue of doctorData.issues) {
    const icons = { error: '❌', warning: '⚠️', info: 'ℹ️' };
    const colors = { error: 'var(--red)', warning: 'var(--yellow)', info: 'var(--fg2)' };
    html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:0.85em;border-top:1px solid var(--bg3)">
      <span style="color:${colors[issue.severity]}">${icons[issue.severity]}</span>
      <span style="flex:1"><strong>${issue.category}:</strong> ${issue.message}</span>
      ${issue.fixAction ? `<button class="btn btn-sm btn-outline" onclick="repairIssue('${issue.fixAction}')" title="${issue.fix || ''}">🔧 Fix</button>` : ''}
    </div>`;
  }
  html += `</div>`;

  // ── Backup & Restore ──
  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:1.5em">💾</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">Backup & Wiederherstellung</h3>
        <div class="sub">Sichere und stelle Config, Memory, Tools, SOUL.md wieder her</div>
      </div>
      <button class="btn btn-sm" onclick="createBackupMaint()">📦 Backup erstellen</button>
    </div>`;

  if (backupData.backups.length > 0) {
    for (const b of backupData.backups) {
      const date = new Date(b.createdAt).toLocaleString('de-DE');
      const size = b.size < 1024 ? b.size + ' B' : (b.size / 1024).toFixed(1) + ' KB';
      html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--bg3);font-size:0.85em">
        <span>📦</span>
        <div style="flex:1">
          <div style="font-weight:500;font-family:monospace">${b.id}</div>
          <div style="color:var(--fg2);font-size:0.82em">${date} · ${b.fileCount} Dateien · ${size}</div>
        </div>
        <button class="btn btn-sm btn-outline" onclick="showBackupFiles('${b.id}')">📋 Dateien</button>
        <button class="btn btn-sm btn-outline" onclick="restoreBackup('${b.id}')">♻️ Wiederherstellen</button>
        <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="deleteBackup('${b.id}')">🗑</button>
      </div>`;
    }
  } else {
    html += `<div style="font-size:0.85em;color:var(--fg2);padding:8px 0;border-top:1px solid var(--bg3)">Noch keine Backups vorhanden.</div>`;
  }
  html += `<div id="backup-files-area" style="display:none;margin-top:8px;padding:8px;background:var(--bg3);border-radius:6px;font-size:0.82em"></div></div>`;

  // ── PM2 Process Control ──
  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:1.5em">⚙️</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">Prozess-Steuerung (PM2)</h3>
        <div class="sub">Bot-Prozess starten, stoppen und überwachen</div>
      </div>
      <button class="btn btn-sm btn-outline" onclick="refreshPM2Status()">🔄 Status</button>
    </div>
    <div id="pm2-status" style="margin-bottom:12px;font-size:0.85em;color:var(--fg2)">Lade PM2-Status...</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="pm2Action('restart')" title="Neustart (kein Datenverlust)">🔄 Restart</button>
      <button class="btn btn-sm btn-outline" onclick="pm2Action('reload')" title="Zero-Downtime Reload">♻️ Reload</button>
      <button class="btn btn-sm btn-danger" onclick="pm2Action('stop')" title="Bot stoppen">⏹️ Stop</button>
      <button class="btn btn-sm" style="background:var(--green)" onclick="pm2Action('start')" title="Bot starten">▶️ Start</button>
      <button class="btn btn-sm btn-outline" onclick="pm2Action('flush')" title="Logs leeren">🧹 Logs leeren</button>
    </div>
    <div id="pm2-logs" style="display:none;margin-top:12px"></div>
  </div>`;

  // ── Bot Logs ──
  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:1.5em">📋</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">Letzte Logs</h3>
        <div class="sub">Die letzten 30 Zeilen der Bot-Ausgabe</div>
      </div>
      <button class="btn btn-sm btn-outline" onclick="loadPM2Logs()">🔄 Aktualisieren</button>
    </div>
    <div id="pm2-log-output" style="background:var(--bg1);border-radius:6px;padding:10px;font-family:monospace;font-size:0.75em;max-height:300px;overflow-y:auto;white-space:pre-wrap;color:var(--fg2)">Klicke "Aktualisieren" um Logs zu laden.</div>
  </div>`;

  document.getElementById('maintenance-content').innerHTML = html;

  // Auto-load PM2 status + auto-refresh every 10s while on maintenance page
  refreshPM2Status();
  if (window._pm2RefreshInterval) clearInterval(window._pm2RefreshInterval);
  window._pm2RefreshInterval = setInterval(() => {
    if (document.getElementById('pm2-status')) refreshPM2Status();
    else clearInterval(window._pm2RefreshInterval);
  }, 10_000);
}

// ── WhatsApp Groups Management ──────────────────────────

let _waGroupsCache = null;
let _waRulesCache = null;

async function loadWAGroups() {
  const container = document.getElementById('wa-groups-content');
  container.innerHTML = '<div style="color:var(--fg2)">Lade WhatsApp-Gruppen...</div>';

  const [groupsRes, rulesRes] = await Promise.all([
    fetch(API + '/api/whatsapp/groups').then(r => r.json()).catch(() => ({ groups: [], error: 'Nicht erreichbar' })),
    fetch(API + '/api/whatsapp/group-rules').then(r => r.json()).catch(() => ({ rules: [] })),
  ]);

  _waGroupsCache = groupsRes.groups || [];
  _waRulesCache = rulesRes.rules || [];

  if (groupsRes.error && _waGroupsCache.length === 0) {
    container.innerHTML = `
      <div class="card">
        <div style="text-align:center;padding:20px;color:var(--fg2)">
          <div style="font-size:2em;margin-bottom:8px">💬</div>
          <div><b>WhatsApp nicht verbunden</b></div>
          <div style="font-size:0.85em;margin-top:4px">Verbinde WhatsApp unter 📱 Platforms, um Gruppen zu verwalten.</div>
        </div>
      </div>`;
    return;
  }

  // Build rules lookup
  const rulesMap = {};
  for (const r of _waRulesCache) rulesMap[r.groupId] = r;

  let html = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <div style="flex:1">
        <div style="font-size:0.85em;color:var(--fg2)">
          ${_waGroupsCache.length} Gruppen gefunden · ${_waRulesCache.filter(r => r.enabled).length} aktiv
        </div>
      </div>
      <button class="btn btn-sm btn-outline" onclick="loadWAGroups()">🔄 Aktualisieren</button>
    </div>`;

  // Configured groups first, then unconfigured
  const sorted = [..._waGroupsCache].sort((a, b) => {
    const aRule = rulesMap[a.id];
    const bRule = rulesMap[b.id];
    if (aRule?.enabled && !bRule?.enabled) return -1;
    if (!aRule?.enabled && bRule?.enabled) return 1;
    if (aRule && !bRule) return -1;
    if (!aRule && bRule) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const g of sorted) {
    const rule = rulesMap[g.id];
    const isEnabled = rule?.enabled;
    const statusIcon = isEnabled ? '🟢' : '⚪';
    const allowedCount = rule?.allowedParticipants?.length || 0;
    const accessLabel = !rule ? 'Nicht konfiguriert' :
      isEnabled ? (allowedCount > 0 ? `${allowedCount} erlaubte Kontakte` : 'Alle Teilnehmer erlaubt') :
      'Deaktiviert';
    const mentionLabel = rule?.requireMention ? '@ Erwähnung nötig' : 'Alle Nachrichten';
    const mediaLabel = rule?.allowMedia !== false ? '📎 Medien an' : '📎 Medien aus';

    html += `
      <div class="card" style="margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:1.2em">${statusIcon}</span>
          <div style="flex:1">
            <div style="font-weight:600;font-size:0.9em">${escapeHtml(g.name)}</div>
            <div style="font-size:0.78em;color:var(--fg2)">${accessLabel}${isEnabled ? ' · ' + mentionLabel + ' · ' + mediaLabel : ''}</div>
          </div>
          <button class="btn btn-sm ${isEnabled ? '' : 'btn-outline'}" onclick="toggleWAGroup('${g.id}', '${escapeHtml(g.name)}', ${!isEnabled})">
            ${isEnabled ? '⏸ Deaktivieren' : '▶️ Aktivieren'}
          </button>
          <button class="btn btn-sm btn-outline" onclick="configureWAGroup('${g.id}', '${escapeHtml(g.name)}')">⚙️</button>
        </div>
      </div>`;
  }

  container.innerHTML = html;
}

async function toggleWAGroup(groupId, groupName, enable) {
  await fetch(API + '/api/whatsapp/group-rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId, groupName, enabled: enable }),
  });
  toast(enable ? `${groupName} aktiviert` : `${groupName} deaktiviert`, 'success');
  loadWAGroups();
}

async function configureWAGroup(groupId, groupName) {
  const container = document.getElementById('wa-groups-content');

  // Find existing rule
  const rule = _waRulesCache?.find(r => r.groupId === groupId) || {};

  // Fetch participants
  container.innerHTML = `<div style="color:var(--fg2)">Lade Teilnehmer von "${groupName}"...</div>`;
  const res = await fetch(API + `/api/whatsapp/groups/${encodeURIComponent(groupId)}/participants`);
  const { participants } = await res.json();

  const allowed = new Set(rule.allowedParticipants || []);
  const requireMention = rule.requireMention !== false;
  const allowMedia = rule.allowMedia !== false;

  let html = `
    <div style="margin-bottom:16px">
      <button class="btn btn-sm btn-outline" onclick="loadWAGroups()">← Zurück</button>
      <span style="margin-left:12px;font-weight:600;font-size:1em">${escapeHtml(groupName)}</span>
      <span style="margin-left:8px;font-size:0.8em;color:var(--fg2)">${participants.length} Teilnehmer</span>
    </div>

    <div class="card" style="margin-bottom:12px">
      <h3 style="font-size:0.9em;margin-bottom:10px">⚙️ Gruppeneinstellungen</h3>
      <div style="display:flex;flex-direction:column;gap:10px">
        <label style="display:flex;align-items:center;gap:8px;font-size:0.85em;cursor:pointer">
          <input type="checkbox" id="wa-require-mention" ${requireMention ? 'checked' : ''}>
          <span>@ Erwähnung erforderlich <span style="color:var(--fg2)">(Bot reagiert nur auf @Mr.Levin)</span></span>
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:0.85em;cursor:pointer">
          <input type="checkbox" id="wa-allow-media" ${allowMedia ? 'checked' : ''}>
          <span>📎 Medien verarbeiten <span style="color:var(--fg2)">(Bilder, Dokumente, Audio)</span></span>
        </label>
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <h3 style="font-size:0.9em;flex:1">👥 Erlaubte Kontakte</h3>
        <button class="btn btn-sm btn-outline" onclick="waSelectAll(true)">Alle auswählen</button>
        <button class="btn btn-sm btn-outline" onclick="waSelectAll(false)">Keine</button>
      </div>
      <div style="font-size:0.78em;color:var(--fg2);margin-bottom:10px">
        Wenn keine Kontakte ausgewählt sind, dürfen <b>alle</b> Teilnehmer Mr. Levin ansprechen.
      </div>
      <div id="wa-participants" style="max-height:400px;overflow-y:auto">`;

  for (const p of participants) {
    const checked = allowed.has(p.id) || allowed.has(p.number) ? 'checked' : '';
    const adminBadge = p.isAdmin ? ' <span style="background:var(--accent);color:var(--bg);padding:1px 6px;border-radius:4px;font-size:0.75em">Admin</span>' : '';
    html += `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--bg3);cursor:pointer;font-size:0.85em" class="wa-participant">
        <input type="checkbox" data-pid="${p.id}" data-number="${p.number}" ${checked}>
        <span style="flex:1">${escapeHtml(p.name)}${adminBadge}</span>
        <span style="color:var(--fg2);font-size:0.82em;font-family:monospace">+${p.number}</span>
      </label>`;
  }

  html += `</div></div>

    <div style="display:flex;gap:8px">
      <button class="btn" onclick="saveWAGroupConfig('${groupId}', '${escapeHtml(groupName)}')">💾 Speichern & Aktivieren</button>
      <button class="btn btn-outline" onclick="loadWAGroups()">Abbrechen</button>
      ${rule.groupId ? `<button class="btn btn-outline" style="color:var(--red);margin-left:auto" onclick="deleteWAGroupRule('${groupId}')">🗑 Regel löschen</button>` : ''}
    </div>`;

  container.innerHTML = html;
}

function waSelectAll(selectAll) {
  document.querySelectorAll('#wa-participants input[type=checkbox]').forEach(cb => cb.checked = selectAll);
}

async function saveWAGroupConfig(groupId, groupName) {
  const requireMention = document.getElementById('wa-require-mention').checked;
  const allowMedia = document.getElementById('wa-allow-media').checked;

  const allowedParticipants = [];
  const participantNames = {};
  document.querySelectorAll('#wa-participants input[type=checkbox]:checked').forEach(cb => {
    const pid = cb.dataset.pid;
    allowedParticipants.push(pid);
    const label = cb.closest('label');
    const name = label?.querySelector('span')?.textContent?.trim() || pid;
    participantNames[pid] = name;
  });

  await fetch(API + '/api/whatsapp/group-rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupId, groupName, enabled: true,
      allowedParticipants, participantNames,
      requireMention, allowMedia,
    }),
  });

  toast(`${groupName} konfiguriert und aktiviert!`, 'success');
  loadWAGroups();
}

async function deleteWAGroupRule(groupId) {
  if (!confirm('Regel für diese Gruppe löschen?')) return;
  await fetch(API + `/api/whatsapp/group-rules/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
  toast('Regel gelöscht', 'success');
  loadWAGroups();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

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
