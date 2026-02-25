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
      platforms: loadPlatforms, personality: loadPersonality, maintenance: loadMaintenance };
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
  const res = await fetch(API + '/api/platforms/setup');
  const data = await res.json();

  let html = '<div style="margin-bottom:20px"><h3 style="font-size:1em;margin-bottom:4px">📱 Messaging-Plattformen</h3><div class="sub">Verbinde Mr. Levin mit verschiedenen Messaging-Diensten. Mehrere gleichzeitig möglich.</div></div>';

  for (const p of data.platforms) {
    const statusBadge = p.configured
      ? '<span class="badge badge-green">✅ Konfiguriert</span>'
      : '<span class="badge badge-red">Nicht eingerichtet</span>';
    const depsBadge = !p.depsInstalled
      ? '<span class="badge badge-yellow">📦 Dependencies fehlen</span>'
      : '';

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
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="savePlatform('${p.id}')">💾 Speichern</button>`;
    if (p.npmPackages && !p.depsInstalled) {
      html += `<button class="btn btn-sm btn-outline" onclick="installPlatformDeps('${p.id}')">📦 Dependencies installieren</button>`;
    }
    if (p.configured) {
      html += `<button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="disablePlatform('${p.id}')">Deaktivieren</button>`;
    }
    html += `</div>
      <div id="platform-result-${p.id}" style="font-size:0.78em;margin-top:6px"></div>
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
  } else {
    toast('Datei kann nicht geöffnet werden (binär oder zu groß)', 'error');
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

    return `<div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:1.2em">${statusIcon}</span>
        <span style="font-weight:500;flex:1">${icon} ${escapeHtml(j.name)}${errIcon}</span>
        <span class="badge">${j.schedule}</span>
        ${j.oneShot ? '<span class="badge badge-yellow">Einmalig</span>' : ''}
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
        <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="deleteCronJob('${j.id}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function showCreateCron() {
  document.getElementById('cron-create-form').style.display = '';
}

async function createCronJob() {
  const name = document.getElementById('cron-name').value.trim();
  const type = document.getElementById('cron-type').value;
  const schedule = document.getElementById('cron-schedule').value.trim();
  const payloadText = document.getElementById('cron-payload').value.trim();
  const oneShot = document.getElementById('cron-oneshot').checked;

  if (!name || !schedule) { toast('Name und Schedule sind Pflicht', 'error'); return; }

  const payload = {};
  switch (type) {
    case 'reminder': case 'message': payload.text = payloadText; break;
    case 'shell': payload.command = payloadText; break;
    case 'http': payload.url = payloadText; break;
    case 'ai-query': payload.prompt = payloadText; break;
  }

  const res = await fetch(API + '/api/cron/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, schedule, oneShot, payload, target: { platform: 'web', chatId: 'dashboard' } }),
  });
  const data = await res.json();
  if (data.ok) {
    toast('✅ Job erstellt!');
    document.getElementById('cron-create-form').style.display = 'none';
    document.getElementById('cron-name').value = '';
    document.getElementById('cron-payload').value = '';
    document.getElementById('cron-schedule').value = '';
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

  // ── Bot Controls ──
  html += `<div class="card" style="margin-bottom:16px">
    <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0;margin-bottom:12px">🔧 Bot-Steuerung</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="restartBot()">🔄 Bot neustarten</button>
      <button class="btn btn-sm btn-outline" onclick="reconnectBot()">🔌 Reconnect</button>
    </div>
  </div>`;

  document.getElementById('maintenance-content').innerHTML = html;
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
