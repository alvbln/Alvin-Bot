/**
 * Alvin Bot Web UI — Client-side application
 * Professional redesign with Lucide icons, i18n, command palette
 */

const API = '';
let ws = null;
let currentAssistantMsg = null;
let chatMessages = [];
let isTyping = false;
let notifySound = true;
const CHAT_STORAGE_KEY = 'alvinbot_chat_history';

// ── UI Init (icons, i18n, static elements) ──────────────
function initUI() {
  // Sidebar title
  document.getElementById('sidebar-title').innerHTML = `${icon('bot', 20)} <span>${t('app.title')}</span>`;
  document.getElementById('bot-status').innerHTML = `<span class="status-dot offline"></span> ${t('connecting')}`;

  // Nav
  const NAV = [
    { section: 'nav.main', items: [
      { page: 'chat', icon: 'message-square', label: 'nav.chat' },
      { page: 'dashboard', icon: 'layout-dashboard', label: 'nav.dashboard' },
    ]},
    { section: 'nav.ai', items: [
      { page: 'models', icon: 'bot', label: 'nav.models' },
      { page: 'personality', icon: 'palette', label: 'nav.personality' },
    ]},
    { section: 'nav.data', items: [
      { page: 'memory', icon: 'brain', label: 'nav.memory' },
      { page: 'sessions', icon: 'clipboard', label: 'nav.sessions' },
      { page: 'files', icon: 'folder', label: 'nav.files' },
    ]},
    { section: 'nav.system', items: [
      { page: 'cron', icon: 'timer', label: 'nav.cron' },
      { page: 'tools', icon: 'hammer', label: 'nav.tools' },
      { page: 'plugins', icon: 'plug', label: 'nav.plugins' },
      { page: 'platforms', icon: 'smartphone', label: 'nav.platforms' },
      { page: 'users', icon: 'users', label: 'nav.users' },
      { page: 'terminal', icon: 'terminal', label: 'nav.terminal' },
      { page: 'maintenance', icon: 'stethoscope', label: 'nav.maintenance' },
      { page: 'settings', icon: 'settings', label: 'nav.settings' },
    ]},
  ];

  let navHtml = '';
  for (const section of NAV) {
    navHtml += `<div class="nav-section">${t(section.section)}</div>`;
    for (const item of section.items) {
      const active = item.page === 'chat' ? ' active' : '';
      navHtml += `<div class="nav-item${active}" data-page="${item.page}" data-icon="${item.icon}" data-label="${item.label}">${icon(item.icon, 16)} <span>${t(item.label)}</span></div>`;
    }
  }
  document.getElementById('nav-container').innerHTML = navHtml;

  // Sidebar footer
  const langDe = getLang() === 'de' ? 'lang-active' : '';
  const langEn = getLang() === 'en' ? 'lang-active' : '';
  document.getElementById('sidebar-footer').innerHTML = `
    <button onclick="toggleTheme()" title="${t('sidebar.theme')}">${icon('sun', 14)} <span>${t('sidebar.theme')}</span></button>
    <button onclick="resetChat()" title="${t('chat.new.session')}">${icon('refresh-cw', 14)} <span>${t('sidebar.reset')}</span></button>
    <button class="lang-toggle" onclick="toggleLang()" title="${t('sidebar.lang')}">
      ${icon('languages', 14)}
      <span><span class="${langDe}">DE</span> | <span class="${langEn}">EN</span></span>
    </button>
  `;

  // Page title
  document.getElementById('page-title').innerHTML = `${icon('message-square', 18)} ${t('nav.chat')}`;

  // Cmd+K hint
  document.getElementById('cmd-k-hint').textContent = navigator.platform?.includes('Mac') ? '⌘K' : 'Ctrl+K';

  // Chat header
  document.getElementById('chat-header').innerHTML = `
    <label>${t('chat.model')}:</label>
    <select id="chat-model" onchange="switchModel(this.value)"></select>
    <label style="margin-left:8px">${t('chat.effort')}:</label>
    <select id="chat-effort">
      <option value="low">${t('chat.effort.low')}</option>
      <option value="medium">${t('chat.effort.medium')}</option>
      <option value="high" selected>${t('chat.effort.high')}</option>
      <option value="max">${t('chat.effort.max')}</option>
    </select>
    <div style="flex:1"></div>
    <button class="btn btn-sm btn-outline" onclick="exportChat('markdown')" title="⌘⇧E">${icon('download', 14)} ${t('chat.export')}</button>
    <button class="btn btn-sm btn-outline" onclick="exportChat('json')">JSON</button>
  `;

  // Chat welcome
  document.getElementById('chat-welcome').textContent = t('chat.welcome');

  // Chat input area
  document.getElementById('chat-input-area').innerHTML = `
    <label for="file-upload" style="cursor:pointer;padding:4px 8px;opacity:0.6;transition:opacity 0.2s;display:flex;align-items:center" title="${t('chat.file.attach')}">
      ${icon('paperclip', 20)}
    </label>
    <input type="file" id="file-upload" style="display:none" onchange="handleFileSelect(this.files)">
    <textarea id="chat-input" placeholder="${t('chat.placeholder')}" rows="1"></textarea>
    <button class="btn-send" id="send-btn" onclick="sendMessage()">${icon('send', 16)} ${t('chat.send')}</button>
  `;

  // Reply/file close buttons
  document.getElementById('reply-close-btn').innerHTML = icon('x', 16);
  document.getElementById('file-close-btn').innerHTML = icon('x', 16);

  // Drop overlay
  document.getElementById('drop-overlay').innerHTML = `${icon('paperclip', 24)} ${t('chat.file.drop')}`;

  // Memory save button
  document.getElementById('memory-save-btn').innerHTML = `${icon('save', 14)} ${t('save')}`;

  // File buttons
  document.getElementById('file-new-btn').innerHTML = `${icon('file-text', 14)} ${t('files.new')}`;
  document.getElementById('file-up-btn').innerHTML = `${icon('arrow-up', 14)} ${t('files.up')}`;
  document.getElementById('file-save-btn').innerHTML = `${icon('save', 14)} ${t('save')}`;
  document.getElementById('file-delete-btn').innerHTML = `${icon('trash-2', 14)}`;
  document.getElementById('file-close-editor-btn').innerHTML = icon('x', 14);
  document.getElementById('file-breadcrumb').innerHTML = `${icon('folder', 14)} /`;

  // Cron header
  document.getElementById('cron-header').innerHTML = `
    <div style="flex:1">
      <h3 style="font-size:1em;margin-bottom:4px;display:flex;align-items:center;gap:6px">${icon('timer', 18)} ${t('cron.title')}</h3>
      <div class="sub">${t('cron.desc')}</div>
    </div>
    <button class="btn btn-sm" onclick="showCreateCron()">${icon('plus', 14)} ${t('cron.create')}</button>
  `;

  // Cron type selector
  document.getElementById('cron-name').placeholder = t('cron.name.placeholder');
  const cronType = document.getElementById('cron-type');
  cronType.innerHTML = `
    <option value="reminder">${icon('timer', 14)} ${t('cron.type.reminder')}</option>
    <option value="shell">${icon('zap', 14)} ${t('cron.type.shell')}</option>
    <option value="http">${icon('globe', 14)} ${t('cron.type.http')}</option>
    <option value="message">${icon('message-square', 14)} ${t('cron.type.message')}</option>
    <option value="ai-query">${icon('bot', 14)} ${t('cron.type.ai')}</option>
  `;
  document.getElementById('cron-payload').placeholder = t('cron.payload.placeholder');
  document.getElementById('cron-form-buttons').innerHTML = `
    <button class="btn btn-sm" onclick="createCronJob()">${icon('save', 14)} ${t('cron.create')}</button>
    <button class="btn btn-sm btn-outline" onclick="document.getElementById('cron-create-form').style.display='none'">${t('cancel')}</button>
  `;

  // Tools search
  document.getElementById('tools-search').placeholder = `${t('tools.search.placeholder')}`;

  // Terminal
  document.getElementById('terminal-input').placeholder = t('terminal.placeholder');
  document.getElementById('terminal-run-btn').innerHTML = `${icon('play', 14)} ${t('terminal.run')}`;

  // Maintenance loading
  document.getElementById('maint-loading').textContent = t('loading');

  // Command palette
  document.getElementById('cmd-palette-input').placeholder = t('cmd.placeholder');

  // Personality card
  document.getElementById('personality-card').innerHTML = `
    <h3 style="display:flex;align-items:center;gap:8px">${icon('palette', 18)} ${t('personality.title')}</h3>
    <div class="sub" style="margin-bottom:12px">${t('personality.desc')}</div>
    <textarea class="editor" id="soul-editor" style="min-height:300px" placeholder="${t('personality.placeholder')}"></textarea>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn" onclick="saveSoul()">${icon('save', 14)} ${t('personality.save')}</button>
      <button class="btn btn-outline" onclick="loadPersonality()">${icon('refresh-cw', 14)} ${t('personality.reload')}</button>
    </div>
  `;

  // Rebind nav events
  bindNavEvents();
  bindChatEvents();
}

// Called by i18n when language changes
function refreshUI() {
  // Save current page
  const activePage = document.querySelector('.nav-item.active')?.dataset?.page || 'chat';
  initUI();
  // Restore active page
  const navItem = document.querySelector(`.nav-item[data-page="${activePage}"]`);
  if (navItem) navItem.click();
}

// ── Chat Persistence ────────────────────────────────────
function saveChatToStorage() {
  try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatMessages)); } catch { }
}

function restoreChatFromStorage() {
  try {
    const stored = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!stored) return;
    const messages = JSON.parse(stored);
    if (!Array.isArray(messages) || messages.length === 0) return;
    chatMessages = messages;
    for (const msg of messages) {
      addMessage(msg.role, msg.text, msg.time, true);
    }
  } catch { }
}

function clearChatStorage() { localStorage.removeItem(CHAT_STORAGE_KEY); }

// ── Toast Notifications ─────────────────────────────────
function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = type === 'success' ? icon('circle-check', 16) : icon('circle-alert', 16);
  el.innerHTML = `${ic} <span>${escapeHtml(message)}</span>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Navigation ──────────────────────────────────────────
function bindNavEvents() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const page = item.dataset.page;
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const pageEl = document.getElementById('page-' + page);
      if (pageEl) pageEl.classList.add('active');
      document.getElementById('page-title').innerHTML = `${icon(item.dataset.icon, 18)} ${t(item.dataset.label)}`;

      const loaders = { dashboard: loadDashboard, memory: loadMemory, models: loadModels,
        sessions: loadSessions, plugins: loadPlugins, tools: loadTools, cron: loadCron,
        files: () => navigateFiles('.'), users: loadUsers, settings: loadSettings,
        platforms: loadPlatforms, personality: loadPersonality, maintenance: loadMaintenance };
      if (loaders[page]) loaders[page]();
    });
  });
}

// ── WebSocket ───────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    document.getElementById('bot-status').innerHTML = `<span class="status-dot online"></span> ${t('connected')}`;
  };
  ws.onclose = () => {
    document.getElementById('bot-status').innerHTML = `<span class="status-dot offline"></span> ${t('reconnecting')}`;
    setTimeout(connectWS, 3000);
  };
  ws.onmessage = (e) => handleWSMessage(JSON.parse(e.data));
}

let pendingTools = [];
let currentToolGroup = null;

function handleWSMessage(msg) {
  const typing = document.getElementById('typing-indicator');
  switch (msg.type) {
    case 'text':
      typing.classList.remove('visible');
      flushToolGroup();
      if (!currentAssistantMsg) currentAssistantMsg = addMessage('assistant', '');
      currentAssistantMsg.querySelector('.msg-text').innerHTML = renderMarkdown(msg.text || '');
      scrollToBottom();
      break;
    case 'tool':
      typing.classList.add('visible');
      pendingTools.push({ name: msg.name, input: msg.input });
      updateToolIndicator();
      break;
    case 'done':
      flushToolGroup();
      if (currentAssistantMsg && (msg.cost || msg.inputTokens || msg.outputTokens)) {
        const costEl = document.createElement('span');
        costEl.className = 'time';
        const parts = [];
        if (msg.inputTokens || msg.outputTokens) parts.push(`${(msg.inputTokens||0)+(msg.outputTokens||0)} tokens`);
        if (msg.cost) parts.push(`$${msg.cost.toFixed(4)}`);
        costEl.textContent = parts.join(' · ');
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
      addMessage('system', `${msg.error}`);
      currentAssistantMsg = null;
      document.getElementById('send-btn').disabled = false;
      typing.classList.remove('visible');
      break;
    case 'fallback':
      addMessage('system', `${icon('zap', 14)} ${t('chat.fallback')}: ${msg.from} → ${msg.to}`);
      break;
    case 'reset':
      document.getElementById('messages').innerHTML = `<div class="msg system">${t('chat.welcome')}</div><div class="typing-indicator" id="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
      addMessage('system', t('chat.session.reset'));
      chatMessages = [];
      pendingTools = [];
      currentToolGroup = null;
      clearChatStorage();
      break;
  }
}

function updateToolIndicator() {
  const typing = document.getElementById('typing-indicator');
  if (pendingTools.length > 0) {
    typing.classList.add('visible');
    typing.innerHTML = `<span style="font-size:0.75em;color:var(--fg2);display:flex;align-items:center;gap:4px">${icon('wrench', 14)} ${pendingTools[pendingTools.length - 1].name}...</span>`;
  }
}

function flushToolGroup() {
  if (pendingTools.length === 0) return;
  const typing = document.getElementById('typing-indicator');
  typing.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';

  const group = document.createElement('div');
  group.className = 'msg tool-group';
  const count = pendingTools.length;
  const names = [...new Set(pendingTools.map(t => t.name))];
  const summary = names.length <= 3 ? names.join(', ') : names.slice(0, 3).join(', ') + ` +${names.length - 3}`;

  group.innerHTML = `
    <div class="tool-group-header" onclick="this.parentElement.classList.toggle('expanded')">
      <span class="tool-group-icon">${icon('wrench', 14)}</span>
      <span class="tool-group-label">${t('chat.tools.used', { count })}</span>
      <span class="tool-group-names">${summary}</span>
      <span class="tool-group-chevron">${icon('chevron-right', 14)}</span>
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
  } catch { }
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
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function timeStr() {
  return new Date().toLocaleTimeString(getLang() === 'de' ? 'de-DE' : 'en-US', { hour: '2-digit', minute: '2-digit' });
}

// ── Reply State ─────────────────────────────────────────
let _replyTo = null;

function setReply(msgIndex, text, role) {
  _replyTo = { msgIndex, text, role };
  const preview = document.getElementById('reply-preview');
  const previewText = document.getElementById('reply-preview-text');
  const sender = role === 'user' ? t('chat.reply.you') : t('chat.reply.bot');
  previewText.textContent = `↩ ${sender}: ${text.substring(0, 120)}${text.length > 120 ? '…' : ''}`;
  preview.style.display = 'flex';
  document.getElementById('chat-input').focus();
}

function clearReply() {
  _replyTo = null;
  document.getElementById('reply-preview').style.display = 'none';
}

// ── File Upload State ───────────────────────────────────
let _pendingFile = null;

function handleFileSelect(files) {
  if (!files || !files.length) return;
  const file = files[0];
  const reader = new FileReader();
  reader.onload = () => {
    _pendingFile = { name: file.name, type: file.type, size: file.size, dataUrl: reader.result };
    const preview = document.getElementById('file-preview');
    const previewText = document.getElementById('file-preview-text');
    const sizeKb = (file.size / 1024).toFixed(1);
    previewText.innerHTML = `${icon('paperclip', 14)} ${file.name} (${sizeKb} KB)`;
    preview.style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

function clearFileUpload() {
  _pendingFile = null;
  document.getElementById('file-preview').style.display = 'none';
  document.getElementById('file-upload').value = '';
}

// ── Drag & Drop ─────────────────────────────────────────
function initDragDrop() {
  const msgs = document.getElementById('messages');
  if (!msgs) return;
  let dragCounter = 0;
  msgs.setAttribute('data-drop-text', `${t('chat.file.drop')}`);
  msgs.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; msgs.classList.add('drag-over'); });
  msgs.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; msgs.classList.remove('drag-over'); } });
  msgs.addEventListener('dragover', (e) => { e.preventDefault(); });
  msgs.addEventListener('drop', (e) => {
    e.preventDefault(); dragCounter = 0; msgs.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) handleFileSelect(e.dataTransfer.files);
  });
}

// ── Chat ────────────────────────────────────────────────
let _msgCounter = 0;

function addMessage(role, text, customTime, skipSave) {
  const msgIdx = _msgCounter++;
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.dataset.msgIndex = msgIdx;

  if (role === 'user' && _replyTo && !skipSave) {
    const quote = document.createElement('div');
    quote.className = 'reply-quote';
    const sender = _replyTo.role === 'user' ? t('chat.reply.you') : t('chat.reply.bot');
    quote.textContent = `${sender}: ${_replyTo.text.substring(0, 100)}`;
    el.appendChild(quote);
  }

  if (role === 'user' && _pendingFile && !skipSave) {
    const badge = document.createElement('div');
    badge.className = 'file-badge';
    badge.innerHTML = `${icon('paperclip', 12)} ${escapeHtml(_pendingFile.name)}`;
    el.appendChild(badge);
  }

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

    const replyBtn = document.createElement('button');
    replyBtn.className = 'msg-reply-btn';
    replyBtn.innerHTML = `${icon('chevron-right', 12)} ${t('chat.reply')}`;
    replyBtn.title = t('chat.reply');
    replyBtn.onclick = () => setReply(msgIdx, text, role);
    el.appendChild(replyBtn);
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
  if ((!text && !_pendingFile) || !ws || ws.readyState !== 1) return;

  const effort = document.getElementById('chat-effort')?.value;
  let fullText = text || '';
  let replyContext = null;
  if (_replyTo) {
    replyContext = { role: _replyTo.role, text: _replyTo.text };
    const replyLabel = _replyTo.role === 'user' ? 'my' : 'your';
    fullText = `[Reply to ${replyLabel} message: "${_replyTo.text.substring(0, 300)}"]\n\n${fullText}`;
  }
  let fileInfo = null;
  if (_pendingFile) {
    fileInfo = { name: _pendingFile.name, type: _pendingFile.type, size: _pendingFile.size };
    const fileRef = `[File attached: ${_pendingFile.name} (${_pendingFile.type}, ${(_pendingFile.size/1024).toFixed(1)} KB)]`;
    fullText = fullText ? `${fileRef}\n\n${fullText}` : fileRef;
  }

  const tm = timeStr();
  addMessage('user', text || `${_pendingFile?.name || 'File'}`, tm);
  chatMessages.push({ role: 'user', text: fullText, time: tm, replyTo: replyContext, file: fileInfo });
  saveChatToStorage();

  const payload = { type: 'chat', text: fullText, effort };
  if (_pendingFile) payload.file = { name: _pendingFile.name, type: _pendingFile.type, dataUrl: _pendingFile.dataUrl };
  ws.send(JSON.stringify(payload));

  input.value = '';
  input.style.height = 'auto';
  clearReply();
  clearFileUpload();
  document.getElementById('send-btn').disabled = true;
  document.getElementById('typing-indicator').classList.add('visible');
  scrollToBottom();
}

function resetChat() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'reset' }));
  chatMessages = [];
  clearChatStorage();
}

function exportChat(format = 'markdown') {
  if (chatMessages.length === 0) { toast(t('chat.no.export'), 'error'); return; }
  fetch(API + '/api/chat/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: chatMessages, format }),
  }).then(res => res.text()).then(text => {
    const ext = format === 'json' ? 'json' : 'md';
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `alvin-bot-chat-${new Date().toISOString().slice(0,10)}.${ext}`;
    a.click();
    toast(t('chat.exported'));
  });
}

function bindChatEvents() {
  const chatInput = document.getElementById('chat-input');
  if (!chatInput) return;

  // Remove existing listeners by replacing element (clean slate)
  const newInput = chatInput.cloneNode(true);
  chatInput.parentNode.replaceChild(newInput, chatInput);

  newInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  newInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 140) + 'px';
  });
}

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'n' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); resetChat(); }
  if (e.key === 'e' && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); exportChat(); }
  if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openCommandPalette(); }
});

// ── Dashboard ───────────────────────────────────────────
async function loadDashboard() {
  const res = await fetch(API + '/api/status');
  const data = await res.json();
  const tok = data.tokens || {};
  const fmtTokens = (n) => n >= 1000000 ? (n/1000000).toFixed(1) + 'M' : n >= 1000 ? (n/1000).toFixed(1) + 'k' : String(n || 0);
  document.getElementById('dashboard-cards').innerHTML = `
    <div class="card"><h3>${icon('bot', 14)} ${t('dashboard.model')}</h3><div class="value">${data.model.name}</div><div class="sub">${data.model.model}</div></div>
    <div class="card"><h3>${icon('clock', 14)} ${t('dashboard.uptime')}</h3><div class="value">${Math.floor(data.bot.uptime/3600)}h ${Math.floor(data.bot.uptime%3600/60)}m</div><div class="sub">v${data.bot.version}</div></div>
    <div class="card"><h3>${icon('zap', 14)} ${t('dashboard.tokens')}</h3><div class="value">${fmtTokens(tok.total)}</div><div class="sub">${fmtTokens(tok.totalInput)} ${t('dashboard.tokens.in')} · ${fmtTokens(tok.totalOutput)} ${t('dashboard.tokens.out')} · $${(tok.totalCost || 0).toFixed(4)}</div></div>
    <div class="card"><h3>${icon('brain', 14)} ${t('dashboard.memory')}</h3><div class="value">${data.memory.dailyLogs} ${t('dashboard.memory.days')}</div><div class="sub">${data.memory.vectors} ${t('dashboard.memory.vectors')} · ${data.memory.todayEntries} ${t('dashboard.memory.today')}</div></div>
    <div class="card"><h3>${icon('plug', 14)} ${t('dashboard.plugins')}</h3><div class="value">${data.plugins}</div><div class="sub">${t('dashboard.plugins.loaded')}</div></div>
    <div class="card"><h3>${icon('wrench', 14)} ${t('dashboard.mcp')}</h3><div class="value">${data.mcp}</div><div class="sub">${t('dashboard.mcp.servers')}</div></div>
    <div class="card"><h3>${icon('users', 14)} ${t('dashboard.users')}</h3><div class="value">${data.users}</div><div class="sub">${t('dashboard.users.profiles')}</div></div>
  `;
  document.getElementById('model-badge').textContent = data.model.name;
}

// ── Models / Providers ──────────────────────────────────
async function loadModels() {
  const [modelsRes, setupRes] = await Promise.all([
    fetch(API + '/api/models'),
    fetch(API + '/api/providers/setup'),
  ]);
  const modelsData = await modelsRes.json();
  const setupData = await setupRes.json();

  const sel = document.getElementById('chat-model');
  if (sel) {
    sel.innerHTML = modelsData.models.map(m =>
      `<option value="${m.key}" ${m.active ? 'selected' : ''}>${m.name}</option>`
    ).join('');
  }

  let html = `<div style="margin-bottom:20px"><h3 style="font-size:1em;margin-bottom:4px;display:flex;align-items:center;gap:8px">${icon('bot', 20)} ${t('models.title')}</h3><div class="sub">${t('models.desc')}</div></div>`;

  for (const p of setupData.providers) {
    const statusBadge = p.hasKey
      ? `<span class="badge badge-green">${icon('circle-check', 12)} ${t('models.key.set')}</span>`
      : (p.free ? `<span class="badge badge-yellow">${icon('zap', 12)} ${t('models.free')}</span>` : `<span class="badge badge-red">${icon('circle-x', 12)} ${t('models.key.none')}</span>`);

    html += `<div class="card setup-card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-size:1.5em">${p.icon}</span>
        <div style="flex:1">
          <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">${p.name}</h3>
          <div class="sub">${p.description}</div>
        </div>
        ${statusBadge}
      </div>`;

    html += `<details style="margin-bottom:12px"><summary style="cursor:pointer;color:var(--accent2);font-size:0.82em;font-weight:500;display:flex;align-items:center;gap:4px">${icon('clipboard', 14)} ${t('models.setup.guide')}</summary><ol style="margin:8px 0 0 16px;color:var(--fg2);font-size:0.82em;line-height:1.6">`;
    for (const step of p.setupSteps) html += `<li>${step}</li>`;
    if (p.signupUrl) html += `<li><a href="${p.signupUrl}" target="_blank" style="color:var(--accent2)">${p.signupUrl}</a></li>`;
    html += `</ol></details>`;

    if (p.envKey) {
      html += `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <input type="password" id="key-${p.id}" placeholder="${t('models.key.placeholder')}" value="${p.keyPreview}" style="flex:1;background:var(--bg3);border:1px solid var(--glass-border);border-radius:6px;padding:8px 12px;color:var(--fg);font:inherit;font-size:0.85em;font-family:monospace;outline:none">
        <button class="btn btn-sm" onclick="saveProviderKey('${p.id}')">${icon('save', 12)} ${t('models.key.save')}</button>
        <button class="btn btn-sm btn-outline" onclick="testProviderKey('${p.id}')">${icon('test-tube', 12)} ${t('models.key.test')}</button>
      </div>
      <div id="key-result-${p.id}" style="font-size:0.78em;margin-bottom:8px"></div>`;
    }

    if (p.hasKey && p.id !== 'claude-sdk' && p.id !== 'ollama') {
      html += `<details id="live-models-${p.id}" style="margin-bottom:8px">
        <summary onclick="loadLiveModels('${p.id}')" style="cursor:pointer;color:var(--accent2);font-size:0.82em;font-weight:500;display:flex;align-items:center;gap:4px">${icon('search', 14)} ${t('models.live.title')}</summary>
        <div id="live-models-list-${p.id}" style="margin-top:8px;max-height:300px;overflow-y:auto;font-size:0.82em">${t('models.live.loading')}</div>
      </details>`;
    }

    html += `<div style="border-top:1px solid var(--glass-border);padding-top:8px;margin-top:4px">`;
    for (const m of p.modelsActive) {
      const isActive = m.active;
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:0.85em">
        <span style="width:20px;text-align:center">${isActive ? icon('circle-check', 14, 'style="color:var(--green)"') : (m.registered ? icon('circle-dot', 14) : icon('circle-dot', 14, 'style="opacity:0.3"'))}</span>
        <span style="flex:1;font-family:monospace">${m.name} <span style="color:var(--fg2)">(${m.model})</span></span>
        ${isActive ? `<span class="badge badge-green">${t('active')}</span>` : `<button class="btn btn-sm btn-outline" onclick="switchModel('${m.key}')">${t('models.activate')}</button>`}
      </div>`;
    }
    html += `</div></div>`;
  }

  // Custom Models section
  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="display:flex">${icon('wrench', 24)}</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">${t('models.custom')}</h3>
        <div class="sub">${t('models.custom.desc')}</div>
      </div>
    </div>`;

  if (setupData.customModels.length > 0) {
    for (const cm of setupData.customModels) {
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:0.85em;border-bottom:1px solid var(--glass-border)">
        <span style="font-family:monospace;flex:1">${cm.name} <span style="color:var(--fg2)">(${cm.model})</span></span>
        <span class="badge">${cm.baseUrl}</span>
        <button class="btn btn-sm btn-outline" onclick="switchModel('${cm.key}')">${t('models.activate')}</button>
        <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="removeCustomModel('${cm.key}')">${icon('x', 12)}</button>
      </div>`;
    }
  }

  html += `<button class="btn btn-sm" style="margin-top:12px" onclick="showAddCustomModel()">${icon('plus', 14)} ${t('models.custom.add')}</button>
    <div id="custom-model-form" style="display:none;margin-top:12px;padding:12px;background:var(--bg3);border-radius:8px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <input id="cm-key" placeholder="${t('models.custom.key')}" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
        <input id="cm-name" placeholder="${t('models.custom.name')}" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
        <input id="cm-model" placeholder="${t('models.custom.model')}" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
        <input id="cm-url" placeholder="${t('models.custom.url')}" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
        <input id="cm-apikey-env" placeholder="${t('models.custom.envkey')}" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
        <input id="cm-apikey" type="password" placeholder="${t('models.custom.apikey')}" style="background:var(--bg);border:1px solid var(--bg4);border-radius:6px;padding:8px;color:var(--fg);font:inherit;font-size:0.82em">
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-sm" onclick="addCustomModel()">${icon('save', 12)} ${t('save')}</button>
        <button class="btn btn-sm btn-outline" onclick="document.getElementById('custom-model-form').style.display='none'">${t('cancel')}</button>
      </div>
    </div>
  </div>`;

  // Fallback chain
  html += `<div class="card">
    <h3 style="font-size:0.85em;text-transform:none;margin-bottom:8px;display:flex;align-items:center;gap:6px">${icon('layers', 16)} ${t('models.fallback')}</h3>
    <div class="sub" style="margin-bottom:12px">${t('models.fallback.desc')}</div>
    <div id="fallback-list" style="font-size:0.85em">${t('loading')}</div>
  </div>`;

  document.getElementById('models-setup').innerHTML = html;
  loadFallbackOrder();
}

async function loadFallbackOrder() {
  try {
    const res = await fetch(API + '/api/fallback');
    const data = await res.json();
    const container = document.getElementById('fallback-list');
    if (!container) return;

    const primary = data.order?.primary || data.activeProvider || '(not set)';
    const chain = data.order?.fallbacks || [];
    const healthArr = data.health || [];
    const health = {};
    healthArr.forEach(h => { health[h.key] = h; });

    let html = `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg3);border-radius:6px;margin-bottom:6px">
      ${icon('crown', 16)}
      <span style="flex:1;font-family:monospace;font-weight:600">${primary}</span>
      <span class="badge badge-green">${t('models.fallback.primary')}</span>
      ${health[primary] ? `<span style="font-size:0.78em;color:${health[primary].healthy ? 'var(--green)' : 'var(--red)'}">● ${health[primary].healthy ? t('models.fallback.healthy') : t('models.fallback.unhealthy')}</span>` : ''}
    </div>`;

    if (chain.length === 0) {
      html += `<div style="padding:8px 12px;color:var(--fg2);font-style:italic">${t('models.fallback.none')}</div>`;
    }

    chain.forEach((key, i) => {
      const h = health[key];
      const healthDot = h ? `<span style="font-size:0.78em;color:${h.healthy ? 'var(--green)' : 'var(--red)'}">● ${h.healthy ? t('models.fallback.healthy') : t('models.fallback.unhealthy')}</span>` : '';
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--bg2);border-radius:6px;margin-bottom:4px">
        <span style="color:var(--fg2);min-width:20px;text-align:center">${i + 1}.</span>
        <span style="flex:1;font-family:monospace">${key}</span>
        ${healthDot}
        <button class="btn btn-sm btn-outline" style="padding:2px 8px;font-size:0.8em" onclick="moveFallback('${key}','up')" ${i === 0 ? 'disabled style="opacity:0.3;padding:2px 8px;font-size:0.8em"' : ''}>${icon('arrow-up', 12)}</button>
        <button class="btn btn-sm btn-outline" style="padding:2px 8px;font-size:0.8em" onclick="moveFallback('${key}','down')" ${i === chain.length - 1 ? 'disabled style="opacity:0.3;padding:2px 8px;font-size:0.8em"' : ''}>${icon('arrow-down', 12)}</button>
        <button class="btn btn-sm btn-outline" style="padding:2px 8px;font-size:0.8em;color:var(--red)" onclick="removeFallback('${key}')">${icon('x', 12)}</button>
      </div>`;
    });

    const allProviders = ['claude-sdk','groq','openai','google','nvidia-llama-3.3-70b','nvidia-kimi-k2.5','openrouter'];
    const available = allProviders.filter(p => p !== primary && !chain.includes(p));
    if (available.length > 0) {
      html += `<div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <select id="fallback-add-select" style="flex:1;background:var(--bg3);border:1px solid var(--glass-border);border-radius:6px;padding:6px 10px;color:var(--fg);font:inherit;font-size:0.85em">
          ${available.map(p => `<option value="${p}">${p}</option>`).join('')}
        </select>
        <button class="btn btn-sm" onclick="addFallback()">${icon('plus', 12)} ${t('models.fallback.add')}</button>
      </div>`;
    }

    container.innerHTML = html;
  } catch (err) {
    const container = document.getElementById('fallback-list');
    if (container) container.innerHTML = `<span style="color:var(--red)">${t('error')}: ${err.message}</span>`;
  }
}

async function moveFallback(key, direction) {
  await fetch(API + '/api/fallback/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, direction }),
  });
  loadFallbackOrder();
}

async function removeFallback(key) {
  const res = await fetch(API + '/api/fallback');
  const data = await res.json();
  const primary = data.order?.primary || data.activeProvider;
  const newChain = (data.order?.fallbacks || []).filter(k => k !== key);
  await fetch(API + '/api/fallback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary, fallbacks: newChain }),
  });
  toast(t('models.fallback.removed', { key }));
  loadFallbackOrder();
}

async function addFallback() {
  const sel = document.getElementById('fallback-add-select');
  if (!sel) return;
  const key = sel.value;
  const res = await fetch(API + '/api/fallback');
  const data = await res.json();
  const primary = data.order?.primary || data.activeProvider;
  const newChain = [...(data.order?.fallbacks || []), key];
  await fetch(API + '/api/fallback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary, fallbacks: newChain }),
  });
  toast(t('models.fallback.added', { key }));
  loadFallbackOrder();
}

const _liveModelsCache = {};
async function loadLiveModels(providerId) {
  const container = document.getElementById('live-models-list-' + providerId);
  if (!container) return;
  if (_liveModelsCache[providerId] && Date.now() - _liveModelsCache[providerId].ts < 60000) {
    renderLiveModels(providerId, _liveModelsCache[providerId].models, container);
    return;
  }
  container.innerHTML = `<span style="color:var(--fg2)">${t('models.live.loading')}</span>`;
  try {
    const res = await fetch(API + '/api/providers/live-models?id=' + providerId);
    const data = await res.json();
    if (!data.ok || !data.models?.length) {
      container.innerHTML = `<span style="color:var(--fg2)">${t('models.live.none')}</span>`;
      return;
    }
    _liveModelsCache[providerId] = { models: data.models, ts: Date.now() };
    renderLiveModels(providerId, data.models, container);
  } catch (err) {
    container.innerHTML = `<span style="color:var(--red)">${t('error')}: ${err.message}</span>`;
  }
}

function renderLiveModels(providerId, models, container) {
  const countInfo = models.length > 20 ? ` <span style="color:var(--fg2)">(${t('models.live.count', { count: models.length })})</span>` : '';
  let html = `<div style="margin-bottom:6px;font-weight:500">${t('models.live.available')}${countInfo}:</div>`;
  html += '<div style="display:flex;flex-direction:column;gap:2px">';
  for (const m of models) {
    html += `<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;background:var(--bg2)">
      <span style="flex:1;font-family:monospace;font-size:0.9em" title="${m.name}">${m.id}</span>
      ${m.name !== m.id ? `<span style="color:var(--fg2);font-size:0.85em">${m.name}</span>` : ''}
      <button class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:0.78em" onclick="activateLiveModel('${providerId}','${m.id}','${(m.name||m.id).replace(/'/g,"\\'")}')"> ${t('models.activate')}</button>
    </div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

async function activateLiveModel(providerId, modelId, modelName) {
  const baseUrls = {
    anthropic: 'https://api.anthropic.com/v1/', openai: 'https://api.openai.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai', groq: 'https://api.groq.com/openai/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1', openrouter: 'https://openrouter.ai/api/v1',
  };
  const apiKeyEnvs = {
    anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY',
    groq: 'GROQ_API_KEY', nvidia: 'NVIDIA_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  };
  const key = modelId.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const res = await fetch(API + '/api/providers/add-custom', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name: modelName || modelId, model: modelId, baseUrl: baseUrls[providerId] || '', apiKeyEnv: apiKeyEnvs[providerId] || '', type: 'openai-compatible' }),
  });
  const data = await res.json();
  if (data.ok) {
    await fetch(API + '/api/models/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    toast(`${modelName || modelId} ${t('models.activated')}`);
    loadModels();
  } else {
    toast(data.error || t('models.activate.error'), 'error');
  }
}

async function switchModel(key) {
  await fetch(API + '/api/models/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  loadModels(); loadDashboard();
  toast(t('models.switched'));
}

async function saveProviderKey(providerId) {
  const input = document.getElementById('key-' + providerId);
  const apiKey = input.value.trim();
  if (!apiKey || apiKey.includes('...')) { toast(t('models.key.fill'), 'error'); return; }
  const res = await fetch(API + '/api/providers/set-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, apiKey }),
  });
  const data = await res.json();
  toast(data.ok ? t('models.key.saved') : data.error, data.ok ? 'success' : 'error');
}

async function testProviderKey(providerId) {
  const input = document.getElementById('key-' + providerId);
  const apiKey = input?.value?.trim() || '';
  const useStored = !apiKey || apiKey.includes('...');
  const resultDiv = document.getElementById('key-result-' + providerId);
  resultDiv.innerHTML = `<span style="color:var(--fg2)">${t('models.key.testing')}</span>`;
  const res = await fetch(API + '/api/providers/test-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, apiKey: useStored ? '__USE_STORED__' : apiKey }),
  });
  const data = await res.json();
  resultDiv.innerHTML = data.ok
    ? `<span style="color:var(--green)">${icon('circle-check', 12)} ${t('models.key.works')}</span>`
    : `<span style="color:var(--red)">${icon('circle-x', 12)} ${data.error}</span>`;
}

function showAddCustomModel() { document.getElementById('custom-model-form').style.display = ''; }

async function addCustomModel() {
  const model = {
    key: document.getElementById('cm-key').value.trim(),
    name: document.getElementById('cm-name').value.trim(),
    model: document.getElementById('cm-model').value.trim(),
    baseUrl: document.getElementById('cm-url').value.trim(),
    apiKeyEnv: document.getElementById('cm-apikey-env').value.trim(),
    apiKey: document.getElementById('cm-apikey').value.trim(),
    type: 'openai-compatible', supportsStreaming: true,
  };
  if (!model.key || !model.name || !model.model || !model.baseUrl) {
    toast(t('models.custom.fill'), 'error'); return;
  }
  const res = await fetch(API + '/api/providers/add-custom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(model) });
  const data = await res.json();
  if (data.ok) {
    toast(t('models.custom.added'));
    document.getElementById('custom-model-form').style.display = 'none';
    loadModels();
  } else {
    toast(data.error, 'error');
  }
}

async function removeCustomModel(key) {
  if (!confirm(t('models.custom.remove', { key }))) return;
  await fetch(API + '/api/providers/remove-custom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  toast(t('models.custom.removed'));
  loadModels();
}

// ── Memory ──────────────────────────────────────────────
async function loadMemory() {
  const res = await fetch(API + '/api/memory');
  const data = await res.json();
  const sel = document.getElementById('memory-file');
  sel.innerHTML = `<option value="MEMORY.md">${icon('file-text', 14)} ${t('memory.longterm')}</option>`;
  data.dailyFiles.forEach(f => { sel.innerHTML += `<option value="${f}">${icon('calendar', 14)} ${f}</option>`; });
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
  toast(data.ok ? t('memory.saved') : data.error, data.ok ? 'success' : 'error');
}

// ── Sessions ────────────────────────────────────────────
async function loadSessions() {
  const res = await fetch(API + '/api/sessions');
  const data = await res.json();
  const list = document.getElementById('sessions-list');
  if (data.sessions.length === 0) {
    list.innerHTML = `<div class="card"><h3>${t('sessions.none')}</h3><div class="sub">${t('sessions.none.desc')}</div></div>`;
    return;
  }
  list.innerHTML = data.sessions.map(s => {
    const dur = Math.floor((s.lastActivity - s.startedAt) / 60000);
    return `<div class="list-item"><div class="icon">${icon('message-circle', 18)}</div><div class="info">
      <div class="name">${s.name}${s.username ? ' @'+s.username : ''}</div>
      <div class="desc">${s.messageCount} ${t('sessions.msgs')} · ${s.toolUseCount} ${t('sessions.tools')} · $${s.totalCost.toFixed(4)} · ${dur}min</div>
    </div><span class="badge ${s.isProcessing ? 'badge-yellow' : 'badge-green'}">${s.isProcessing ? t('sessions.active') : t('sessions.idle')}</span></div>`;
  }).join('');
}

// ── Plugins ─────────────────────────────────────────────
async function loadPlugins() {
  const [pluginsRes, mcpRes, skillsRes] = await Promise.all([
    fetch(API + '/api/plugins'),
    fetch(API + '/api/mcp').catch(() => ({ json: () => ({ servers: [], tools: [], config: { servers: {} } }) })),
    fetch(API + '/api/skills').catch(() => ({ json: () => ({ skills: [] }) })),
  ]);
  const pluginsData = await pluginsRes.json();
  const mcpData = await mcpRes.json();
  const skillsData = await skillsRes.json();

  let html = '';

  // ── Plugins Section ──
  html += `<div style="margin-bottom:24px">
    <h3 style="font-size:1em;margin-bottom:8px;display:flex;align-items:center;gap:8px">${icon('plug', 18)} ${t('plugins.none').replace('Keine ','').replace('No ','') || 'Plugins'}</h3>`;
  if (pluginsData.plugins.length === 0) {
    html += `<div class="card"><div class="sub">${t('plugins.none.desc')}</div></div>`;
  } else {
    html += pluginsData.plugins.map(p => `<div class="list-item"><div class="icon">${icon('plug', 18)}</div><div class="info">
      <div class="name">${p.name} <span class="badge">${p.version}</span></div>
      <div class="desc">${p.description}${p.commands.length ? ' · '+p.commands.join(', ') : ''}</div>
    </div></div>`).join('');
  }
  html += '</div>';

  // ── MCP Servers Section ──
  html += `<div style="margin-bottom:24px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="font-size:1em;display:flex;align-items:center;gap:8px;flex:1">${icon('server', 18)} MCP Servers</h3>
      <button class="btn btn-sm" onclick="showAddMCP()">${icon('plus', 14)} ${t('models.fallback.add')}</button>
      <button class="btn btn-sm btn-outline" onclick="discoverMCP()">${icon('search', 14)} Auto-Discover</button>
    </div>`;

  if (mcpData.servers.length === 0) {
    html += `<div class="card"><div class="sub">No MCP servers configured. Add one or use Auto-Discover.</div></div>`;
  } else {
    for (const s of mcpData.servers) {
      const statusBadge = s.connected
        ? `<span class="badge badge-green">${icon('check', 12)} Connected · ${s.tools} tools</span>`
        : `<span class="badge badge-red">${icon('x', 12)} Disconnected</span>`;
      html += `<div class="list-item">
        <div class="icon">${icon('server', 18)}</div>
        <div class="info"><div class="name">${escapeHtml(s.name)}</div></div>
        ${statusBadge}
        <button class="btn btn-sm btn-outline" style="color:var(--red);padding:2px 8px" onclick="removeMCP('${escapeHtml(s.name)}')">${icon('trash-2', 14)}</button>
      </div>`;
    }
  }

  // Add MCP form (hidden by default)
  html += `<div id="mcp-add-form" style="display:none;margin-top:12px;padding:16px;background:var(--bg2);border:1px solid var(--glass-border);border-radius:var(--radius)">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <input id="mcp-name" placeholder="Server name (e.g. filesystem)" class="input">
      <input id="mcp-command" placeholder="Command (e.g. npx)" class="input">
      <input id="mcp-args" placeholder="Args (comma-separated, e.g. -y,@modelcontextprotocol/server-filesystem,/tmp)" class="input" style="grid-column:1/-1">
      <input id="mcp-url" placeholder="Or HTTP URL (for remote servers)" class="input" style="grid-column:1/-1">
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-sm" onclick="addMCP()">${icon('save', 14)} ${t('save')}</button>
      <button class="btn btn-sm btn-outline" onclick="document.getElementById('mcp-add-form').style.display='none'">${t('cancel')}</button>
    </div>
  </div>`;

  // Discovery results area
  html += `<div id="mcp-discover-results" style="margin-top:8px"></div>`;
  html += '</div>';

  // ── Skills Section ──
  html += `<div style="margin-bottom:24px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="font-size:1em;display:flex;align-items:center;gap:8px;flex:1">${icon('sparkles', 18)} Skills</h3>
      <button class="btn btn-sm" onclick="showAddSkill()">${icon('plus', 14)} ${t('cron.create')}</button>
    </div>`;

  if (skillsData.skills.length === 0) {
    html += `<div class="card"><div class="sub">No skills installed. Create one to add specialized knowledge.</div></div>`;
  } else {
    for (const s of skillsData.skills) {
      html += `<div class="list-item">
        <div class="icon">${icon('sparkles', 18)}</div>
        <div class="info">
          <div class="name">${escapeHtml(s.name)} <span class="badge">${s.category}</span></div>
          <div class="desc">${escapeHtml(s.description || '')} · Triggers: ${s.triggers.join(', ')}</div>
        </div>
        <button class="btn btn-sm btn-outline" onclick="editSkill('${escapeHtml(s.id)}')">${icon('edit', 14)}</button>
        <button class="btn btn-sm btn-outline" style="color:var(--red);padding:2px 8px" onclick="deleteSkill('${escapeHtml(s.id)}')">${icon('trash-2', 14)}</button>
      </div>`;
    }
  }

  // Add Skill form (hidden)
  html += `<div id="skill-add-form" style="display:none;margin-top:12px;padding:16px;background:var(--bg2);border:1px solid var(--glass-border);border-radius:var(--radius)">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <input id="skill-id" placeholder="Unique ID (e.g. video-creation)" class="input">
      <input id="skill-name" placeholder="Display name" class="input">
      <input id="skill-desc" placeholder="Short description" class="input">
      <input id="skill-triggers" placeholder="Trigger keywords (comma-separated)" class="input">
      <input id="skill-category" placeholder="Category (e.g. media, code, data)" class="input">
      <select id="skill-priority" class="input"><option value="3">Priority: Normal (3)</option><option value="5">High (5)</option><option value="1">Low (1)</option></select>
    </div>
    <textarea id="skill-content" class="editor" style="min-height:200px" placeholder="Skill content (instructions, workflows, best practices)..."></textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn btn-sm" onclick="createSkill()">${icon('save', 14)} ${t('save')}</button>
      <button class="btn btn-sm btn-outline" onclick="document.getElementById('skill-add-form').style.display='none'">${t('cancel')}</button>
    </div>
  </div>`;
  html += '</div>';

  document.getElementById('plugins-list').innerHTML = html;
}

// ── MCP Management Functions ────────────────────────────

function showAddMCP() { document.getElementById('mcp-add-form').style.display = ''; }

async function addMCP() {
  const name = document.getElementById('mcp-name').value.trim();
  const command = document.getElementById('mcp-command').value.trim();
  const argsStr = document.getElementById('mcp-args').value.trim();
  const url = document.getElementById('mcp-url').value.trim();
  if (!name) { toast('Name required', 'error'); return; }
  const args = argsStr ? argsStr.split(',').map(a => a.trim()) : [];
  const res = await fetch(API + '/api/mcp/add', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, command: command || undefined, args: args.length ? args : undefined, url: url || undefined }),
  });
  const data = await res.json();
  if (data.ok) { toast('MCP server added. Restart needed.'); document.getElementById('mcp-add-form').style.display = 'none'; loadPlugins(); }
  else toast(data.error, 'error');
}

async function removeMCP(name) {
  if (!confirm(`Remove MCP server "${name}"?`)) return;
  await fetch(API + '/api/mcp/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  toast('Removed'); loadPlugins();
}

async function discoverMCP() {
  const el = document.getElementById('mcp-discover-results');
  el.innerHTML = `<div class="sub" style="padding:8px">${icon('search', 14)} Scanning system for MCP servers...</div>`;
  const res = await fetch(API + '/api/mcp/discover');
  const data = await res.json();
  if (!data.discovered?.length) { el.innerHTML = `<div class="sub" style="padding:8px">No MCP servers found on this system.</div>`; return; }
  el.innerHTML = `<div style="padding:8px;font-size:0.85em"><strong>Found ${data.discovered.length} MCP server(s):</strong></div>` +
    data.discovered.map(d => `<div class="list-item" style="padding:8px 12px">
      <div class="info"><div class="name">${escapeHtml(d.name)} <span class="badge">${d.source}</span></div>
      <div class="desc">${d.command} ${d.args.join(' ')}</div></div>
      <button class="btn btn-sm" onclick="installDiscoveredMCP('${escapeHtml(d.name)}','${escapeHtml(d.command)}','${escapeHtml(d.args.join(','))}')">${icon('plus', 14)} Add</button>
    </div>`).join('');
}

async function installDiscoveredMCP(name, command, argsStr) {
  const args = argsStr.split(',').filter(Boolean);
  const res = await fetch(API + '/api/mcp/add', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, command, args }),
  });
  const data = await res.json();
  if (data.ok) { toast(`${name} added!`); loadPlugins(); }
  else toast(data.error, 'error');
}

// ── Skills Management Functions ─────────────────────────

function showAddSkill() { document.getElementById('skill-add-form').style.display = ''; }

async function createSkill() {
  const skill = {
    id: document.getElementById('skill-id').value.trim(),
    name: document.getElementById('skill-name').value.trim(),
    description: document.getElementById('skill-desc').value.trim(),
    triggers: document.getElementById('skill-triggers').value.trim(),
    category: document.getElementById('skill-category').value.trim(),
    priority: parseInt(document.getElementById('skill-priority').value) || 3,
    content: document.getElementById('skill-content').value,
  };
  if (!skill.id || !skill.name) { toast('ID and name required', 'error'); return; }
  const res = await fetch(API + '/api/skills/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(skill),
  });
  const data = await res.json();
  if (data.ok) { toast('Skill created!'); document.getElementById('skill-add-form').style.display = 'none'; loadPlugins(); }
  else toast(data.error, 'error');
}

async function editSkill(id) {
  const res = await fetch(API + `/api/skills/detail/${id}`);
  const data = await res.json();
  if (!data.ok) { toast('Skill not found', 'error'); return; }
  const s = data.skill;
  // Populate form
  document.getElementById('skill-id').value = s.id;
  document.getElementById('skill-name').value = s.name;
  document.getElementById('skill-desc').value = s.description || '';
  document.getElementById('skill-triggers').value = s.triggers.join(', ');
  document.getElementById('skill-category').value = s.category || '';
  document.getElementById('skill-priority').value = String(s.priority || 3);
  document.getElementById('skill-content').value = s.content || '';
  document.getElementById('skill-add-form').style.display = '';
}

async function deleteSkill(id) {
  if (!confirm(`Delete skill "${id}"?`)) return;
  const res = await fetch(API + '/api/skills/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const data = await res.json();
  if (data.ok) { toast('Skill deleted'); loadPlugins(); }
  else toast(data.error, 'error');
}

// ── Users ───────────────────────────────────────────────
const PLATFORM_ICONS = { telegram: 'send', whatsapp: 'message-circle', discord: 'signal', signal: 'shield', webui: 'globe', web: 'globe' };

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return t('users.just.now');
  if (diff < 3600000) return t('users.min.ago', { n: Math.floor(diff/60000) });
  if (diff < 86400000) return t('users.hrs.ago', { n: Math.floor(diff/3600000) });
  return new Date(ts).toLocaleDateString(getLang() === 'de' ? 'de-DE' : 'en-US', { day:'numeric', month:'short', year:'numeric' });
}

async function loadUsers() {
  const res = await fetch(API + '/api/users');
  const data = await res.json();
  const el = document.getElementById('users-list');

  if (data.users.length === 0) {
    el.innerHTML = `<div class="card"><h3>${t('users.none')}</h3><div class="sub">${t('users.none.desc')}</div></div>`;
    return;
  }

  el.innerHTML = data.users.map(u => {
    const platformIconName = PLATFORM_ICONS[u.lastPlatform] || 'globe';
    const platformName = u.lastPlatform ? u.lastPlatform.charAt(0).toUpperCase() + u.lastPlatform.slice(1) : t('users.platform.unknown');
    const lastMsg = u.lastMessage ? `<div class="user-last-msg">"${escapeHtml(u.lastMessage)}"</div>` : '';
    const sessionInfo = u.session ? `
      <div class="user-session-info">
        ${u.session.isProcessing ? `<span class="badge badge-yellow">${icon('clock', 10)} ${t('users.processing')}</span>` : ''}
        ${u.session.hasActiveQuery ? `<span class="badge badge-yellow">${icon('refresh-cw', 10)} ${t('users.query.active')}</span>` : ''}
        ${u.session.queuedMessages > 0 ? `<span class="badge badge-blue">${icon('mail', 10)} ${t('users.in.queue', { count: u.session.queuedMessages })}</span>` : ''}
        <span title="${t('users.cost')}">${icon('zap', 10)} $${u.session.totalCost.toFixed(4)}</span>
        <span title="${t('users.msgs')}">${icon('message-square', 10)} ${u.session.messageCount}</span>
        <span title="${t('users.tools')}">${icon('wrench', 10)} ${u.session.toolUseCount}</span>
        <span title="${t('users.history')}">${icon('list', 10)} ${u.session.historyLength}</span>
        <span title="${t('users.effort')}">${icon('brain', 10)} ${u.session.effort}</span>
      </div>` : `<div class="user-session-info"><span class="sub">${t('users.no.session')}</span></div>`;

    const killBtn = u.isOwner ? '' : `<button class="btn btn-danger btn-sm" onclick="killUser(${u.userId}, '${escapeHtml(u.name)}')" title="${t('delete')}">${icon('trash-2', 12)}</button>`;

    return `<div class="card user-card" style="margin-bottom:12px">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div class="icon" style="font-size:1.6em;min-width:36px;text-align:center">${u.isOwner ? icon('crown', 28) : icon('user', 28)}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <strong>${escapeHtml(u.name)}</strong>
            ${u.username ? `<span class="sub">@${escapeHtml(u.username)}</span>` : ''}
            <span class="badge badge-${u.session ? 'green' : 'gray'}" style="font-size:0.7em">${u.session ? t('online') : t('offline')}</span>
            ${killBtn}
          </div>
          <div class="sub" style="margin-top:4px;display:flex;align-items:center;gap:4px">
            ${icon(platformIconName, 12)} ${platformName} · ${t('users.messages.total', { n: u.totalMessages })} · ${t('users.last.active')}: ${timeAgo(u.lastActive)}
          </div>
          ${lastMsg}
          ${sessionInfo}
        </div>
      </div>
    </div>`;
  }).join('');
}

async function killUser(userId, name) {
  if (!confirm(t('users.kill.confirm', { name }))) return;
  try {
    const res = await fetch(API + `/api/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      const summary = data.deleted.length > 0 ? t('users.deleted.summary', { items: data.deleted.join(', ') }) : t('users.nothing');
      alert(`${t('users.deleted')}\n\n${summary}`);
      loadUsers();
    } else {
      alert(`${t('error')}: ${data.error || 'Unknown'}`);
    }
  } catch (e) {
    alert(`${t('error')}: ${e.message}`);
  }
}

// ── Platforms ────────────────────────────────────────────
async function loadPlatforms() {
  const res = await fetch(API + '/api/platforms/setup');
  const data = await res.json();

  let html = `<div style="margin-bottom:20px"><h3 style="font-size:1em;margin-bottom:4px;display:flex;align-items:center;gap:8px">${icon('smartphone', 20)} ${t('platforms.title')}</h3><div class="sub">${t('platforms.desc')}</div></div>`;

  for (const p of data.platforms) {
    let statusBadge;
    if (p.configured && p.depsInstalled) {
      statusBadge = `<span class="badge badge-green" id="badge-${p.id}">${icon('circle-check', 12)} ${t('platforms.ready')}</span>`;
    } else if (p.configured && !p.depsInstalled) {
      statusBadge = `<span class="badge badge-yellow" id="badge-${p.id}">${icon('package', 12)} ${t('platforms.deps.missing')}</span>`;
    } else {
      statusBadge = `<span class="badge badge-red" id="badge-${p.id}">${t('platforms.not.configured')}</span>`;
    }

    html += `<div class="card setup-card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-size:1.8em">${p.icon}</span>
        <div style="flex:1">
          <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">${p.name}</h3>
          <div class="sub">${p.description}</div>
        </div>
        ${statusBadge}
      </div>`;

    html += `<details ${p.configured ? '' : 'open'} style="margin-bottom:12px"><summary style="cursor:pointer;color:var(--accent2);font-size:0.82em;font-weight:500;display:flex;align-items:center;gap:4px">${icon('clipboard', 14)} ${t('platforms.setup.guide')}</summary><ol style="margin:8px 0 0 16px;color:var(--fg2);font-size:0.82em;line-height:1.6">`;
    for (const step of p.setupSteps) html += `<li>${step}</li>`;
    if (p.setupUrl) html += `<li><a href="${p.setupUrl}" target="_blank" style="color:var(--accent2)">${p.setupUrl}</a></li>`;
    html += `</ol></details>`;

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
          <input type="${v.secret ? 'password' : 'text'}" id="pv-${p.id}-${v.key}" placeholder="${v.placeholder}" value="${p.values[v.key] || ''}" style="flex:1;background:var(--bg3);border:1px solid var(--glass-border);border-radius:6px;padding:8px 12px;color:var(--fg);font:inherit;font-size:0.85em;font-family:monospace;outline:none">
        </div>`;
      }
    }
    html += `</div>`;

    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-sm" onclick="savePlatform('${p.id}')">${icon('save', 12)} ${t('platforms.save')}</button>`;
    if (p.npmPackages && !p.depsInstalled) {
      html += `<button class="btn btn-sm btn-outline" onclick="installPlatformDeps('${p.id}')">${icon('package', 12)} ${t('platforms.install.deps')}</button>`;
    }
    if (p.configured) {
      html += `<button class="btn btn-sm btn-outline" onclick="testPlatformConnection('${p.id}')">${icon('test-tube', 12)} ${t('platforms.test')}</button>`;
      html += `<button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="disablePlatform('${p.id}')">${t('platforms.disable')}</button>`;
    }
    html += `<span id="platform-live-${p.id}" style="font-size:0.78em;margin-left:4px"></span>`;
    html += `</div>`;

    if (p.id === 'whatsapp' && p.configured && p.depsInstalled) {
      html += `<div id="wa-qr-area" style="margin-top:12px;padding:12px;background:var(--bg3);border-radius:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span id="wa-status-dot" style="font-size:1.2em">${icon('clock', 16)}</span>
          <span id="wa-status-text" style="font-size:0.85em;color:var(--fg2)">${t('wa.status.loading')}</span>
          <div style="flex:1"></div>
          <button class="btn btn-sm btn-outline" onclick="checkWhatsAppStatus()">${icon('refresh-cw', 12)} ${t('wa.check.status')}</button>
          <button class="btn btn-sm btn-outline" style="color:var(--red);font-size:0.78em" onclick="disconnectWhatsApp()">${icon('plug', 12)} ${t('wa.disconnect')}</button>
        </div>
        <div id="wa-qr-container" style="display:none;text-align:center;padding:16px;background:#fff;border-radius:8px;margin-top:8px">
          <canvas id="wa-qr-canvas" style="image-rendering:pixelated"></canvas>
          <div style="color:#333;font-size:0.82em;margin-top:8px">${t('wa.scan.qr')}</div>
        </div>
      </div>`;
    }

    if (p.id === 'whatsapp' && (p.configured || p.depsInstalled)) {
      html += `<div style="margin-top:16px;border-top:1px solid var(--glass-border);padding-top:12px">
        <details id="wa-groups-details">
          <summary style="cursor:pointer;font-weight:600;font-size:0.9em;display:flex;align-items:center;gap:8px">
            ${icon('message-circle', 16)} ${t('wa.groups')}
            <span style="font-size:0.75em;color:var(--fg2);font-weight:normal" id="wa-groups-badge"></span>
          </summary>
          <div id="wa-groups-content" style="margin-top:12px"><div style="color:var(--fg2);font-size:0.85em">${t('wa.groups.loading')}</div></div>
        </details>
      </div>`;
    }

    html += `<div id="platform-result-${p.id}" style="font-size:0.78em;margin-top:6px"></div></div>`;
  }

  document.getElementById('platforms-setup').innerHTML = html;
  if (document.getElementById('wa-groups-content')) loadWAGroups();

  // Load statuses
  loadPlatformStatuses();
  if (document.getElementById('wa-qr-area')) checkWhatsAppStatus();
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
    if (data.restartNeeded === false) {
      toast(t('platforms.saved'));
      resultDiv.innerHTML = `<span style="color:var(--green)">${icon('circle-check', 12)} ${t('platforms.saved')}</span>`;
    } else {
      toast(t('platforms.saved.restart'));
      resultDiv.innerHTML = `<span style="color:var(--green)">${icon('circle-check', 12)} ${t('platforms.saved.restart')}</span>`;
    }
  } else {
    toast(data.error, 'error');
    resultDiv.innerHTML = `<span style="color:var(--red)">${icon('circle-x', 12)} ${data.error}</span>`;
  }
}

async function installPlatformDeps(platformId) {
  toast(t('platforms.installing'));
  const resultDiv = document.getElementById('platform-result-' + platformId);
  resultDiv.innerHTML = `<span style="color:var(--fg2)">${t('loading')}</span>`;
  const res = await fetch(API + '/api/platforms/install-deps', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platformId }),
  });
  const data = await res.json();
  if (data.ok) {
    toast(t('platforms.installed'));
    resultDiv.innerHTML = `<span style="color:var(--green)">${icon('circle-check', 12)} ${t('platforms.installed')}</span>`;
    loadPlatforms();
  } else {
    toast(t('error') + ': ' + data.error, 'error');
    resultDiv.innerHTML = `<span style="color:var(--red)">${icon('circle-x', 12)} ${data.error}</span>`;
  }
}

async function disablePlatform(platformId) {
  if (!confirm(t('platforms.disable.confirm', { id: platformId }))) return;
  const inputs = document.querySelectorAll(`[id^="pv-${platformId}-"]`);
  const values = {};
  inputs.forEach(el => { const key = el.id.replace(`pv-${platformId}-`, ''); values[key] = ''; });
  await fetch(API + '/api/platforms/configure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platformId, values }),
  });
  toast(t('platforms.disabled'));
  loadPlatforms();
}

async function testPlatformConnection(platformId) {
  const el = document.getElementById('platform-live-' + platformId);
  if (el) el.innerHTML = `${t('platforms.testing')}`;
  try {
    const res = await fetch(API + '/api/platforms/test-connection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platformId }),
    });
    const data = await res.json();
    if (el) {
      el.innerHTML = data.ok
        ? `<span style="color:var(--green)">${icon('circle-check', 12)} ${data.info || t('platforms.connected')}</span>`
        : `<span style="color:var(--red)">${icon('circle-x', 12)} ${data.error || t('error')}</span>`;
    }
  } catch (err) {
    if (el) el.innerHTML = `<span style="color:var(--red)">${icon('circle-x', 12)} ${err.message}</span>`;
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

      if (el && s.status && s.status !== 'not_configured' && s.status !== 'unknown') {
        let extra = '';
        if (s.botUsername) extra = ` @${s.botUsername}`;
        else if (s.botTag) extra = ` ${s.botTag}`;
        else if (s.guildCount) extra = ` (${s.guildCount} Server)`;
        else if (s.apiVersion) extra = ` v${s.apiVersion}`;
        const statusColor = s.status === 'connected' ? 'var(--green)' : (s.status === 'error' || s.status === 'logged_out') ? 'var(--red)' : 'var(--fg2)';
        const statusIcon = s.status === 'connected' ? icon('circle-check', 12) : s.status === 'error' ? icon('circle-x', 12) : icon('clock', 12);
        const statusLabel = t(`platforms.status.${s.status.replace('_', '.')}`) || s.status;
        el.innerHTML = `<span style="color:${statusColor}">${statusIcon} ${statusLabel}${extra}</span>`;
      }

      if (badge) {
        if (s.status === 'connected') {
          badge.className = 'badge badge-green'; badge.innerHTML = `${icon('circle-check', 12)} ${t('platforms.connected')}`;
        } else if (s.status === 'qr') {
          badge.className = 'badge badge-yellow'; badge.innerHTML = `${icon('qr-code', 12)} QR`;
        } else if (s.status === 'connecting') {
          badge.className = 'badge badge-yellow'; badge.innerHTML = `${icon('clock', 12)} ${t('platforms.status.connecting')}`;
        } else if (s.status === 'error' || s.status === 'logged_out') {
          badge.className = 'badge badge-red'; badge.innerHTML = `${icon('circle-x', 12)} ${t('error')}`;
        } else if (s.status === 'disconnected') {
          badge.className = 'badge badge-yellow'; badge.innerHTML = `${icon('circle-dot', 12)} ${t('platforms.status.disconnected')}`;
        }
      }
    }
  } catch { }
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
      disconnected: [icon('circle-dot', 16), t('platforms.status.disconnected')],
      connecting: [icon('clock', 16), t('platforms.status.connecting')],
      qr: [icon('qr-code', 16), t('wa.qr.ready')],
      connected: [icon('circle-check', 16), `${t('platforms.connected')}${state.connectedAt ? ` (${new Date(state.connectedAt).toLocaleTimeString(getLang() === 'de' ? 'de-DE' : 'en-US')})` : ''}`],
      logged_out: [icon('circle-x', 16), t('platforms.status.logged.out')],
    };
    const [statusIc, label] = statusMap[state.status] || [icon('info', 16), state.status];
    dot.innerHTML = statusIc;
    text.textContent = label;

    const badge = document.getElementById('badge-whatsapp');
    if (badge) {
      if (state.status === 'connected') { badge.className = 'badge badge-green'; badge.innerHTML = `${icon('circle-check', 12)} ${t('platforms.connected')}`; }
      else if (state.status === 'qr') { badge.className = 'badge badge-yellow'; badge.innerHTML = `${icon('qr-code', 12)} QR`; }
      else if (state.status === 'connecting') { badge.className = 'badge badge-yellow'; badge.innerHTML = `${icon('clock', 12)} ...`; }
      else if (state.status === 'error') { badge.className = 'badge badge-red'; badge.innerHTML = `${icon('circle-x', 12)} ${t('error')}`; }
    }

    const liveEl = document.getElementById('platform-live-whatsapp');
    if (liveEl) {
      const infoStr = state.info ? ` (${state.info})` : '';
      if (state.status === 'connected') liveEl.innerHTML = `<span style="color:var(--green)">${icon('circle-check', 12)} ${t('platforms.connected')}${infoStr}</span>`;
      else if (state.status === 'qr') liveEl.innerHTML = `<span style="color:var(--fg2)">${icon('qr-code', 12)} ${t('wa.qr.available')}</span>`;
      else if (state.status === 'connecting') liveEl.innerHTML = `<span style="color:var(--fg2)">${icon('clock', 12)} ...</span>`;
      else if (state.status === 'error') liveEl.innerHTML = `<span style="color:var(--red)">${icon('circle-x', 12)} ${state.error || t('error')}</span>`;
    }

    if (state.status === 'qr' && state.qrString && qrContainer) {
      qrContainer.style.display = '';
      renderQrCode(state.qrString);
      if (!waStatusInterval) waStatusInterval = setInterval(checkWhatsAppStatus, 3000);
    } else if (state.status === 'connecting') {
      if (qrContainer) qrContainer.style.display = 'none';
      if (!waStatusInterval) waStatusInterval = setInterval(checkWhatsAppStatus, 3000);
    } else {
      if (qrContainer) qrContainer.style.display = 'none';
      if (state.status === 'connected' && waStatusInterval) { clearInterval(waStatusInterval); waStatusInterval = null; }
    }
  } catch (err) {
    const text = document.getElementById('wa-status-text');
    if (text) text.textContent = t('error') + ': ' + err.message;
  }
}

async function disconnectWhatsApp() {
  if (!confirm(t('wa.disconnect.confirm'))) return;
  try {
    const res = await fetch(API + '/api/whatsapp/disconnect', { method: 'POST' });
    const data = await res.json();
    toast(data.ok ? t('wa.disconnected') : data.error, data.ok ? 'success' : 'error');
  } catch (err) { toast(t('error') + ': ' + err.message, 'error'); }
}

function renderQrCode(text) {
  const canvas = document.getElementById('wa-qr-canvas');
  if (!canvas) return;
  if (typeof QRCode !== 'undefined') { new QRCode(canvas.parentElement, { text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M }); return; }
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
    const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    const ctx = canvas.getContext('2d');
    const moduleCount = qr.getModuleCount();
    const cellSize = Math.max(4, Math.floor(256 / moduleCount));
    const size = moduleCount * cellSize;
    canvas.width = size; canvas.height = size;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
  } catch (err) { console.error('QR render error:', err); }
}

// ── Personality ─────────────────────────────────────────
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
  toast(data.ok ? t('personality.saved') : data.error, data.ok ? 'success' : 'error');
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

  const sudoIcon = sudoData.configured ? (sudoData.verified ? icon('circle-check', 20, 'style="color:var(--green)"') : icon('circle-alert', 20, 'style="color:var(--yellow)"')) : icon('circle-x', 20, 'style="color:var(--red)"');
  const sudoStatusText = sudoData.configured
    ? (sudoData.verified ? t('settings.sudo.active') : t('settings.sudo.configured'))
    : t('settings.sudo.not.set');

  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="display:flex">${icon('lock', 24)}</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">${t('settings.sudo')}</h3>
        <div class="sub">${t('settings.sudo.desc')}</div>
      </div>
      ${sudoIcon}
    </div>
    <div style="font-size:0.85em;margin-bottom:12px">
      <div><strong>${t('settings.sudo.status')}:</strong> ${sudoStatusText}</div>
      <div><strong>${t('settings.sudo.storage')}:</strong> ${sudoData.storageMethod}</div>
      <div><strong>${t('settings.sudo.system')}:</strong> ${sudoData.platform} (${sudoData.user})</div>
      ${sudoData.permissions.accessibility !== null ? `<div><strong>${t('settings.sudo.accessibility')}:</strong> ${sudoData.permissions.accessibility ? icon('circle-check', 14, 'style="color:var(--green)"') : `${icon('circle-x', 14, 'style="color:var(--red)"')} <button class="btn btn-sm btn-outline" onclick="openSysSettings('accessibility')" style="font-size:0.8em;padding:2px 6px">${t('settings.sudo.open')}</button>`}</div>` : ''}
      ${sudoData.permissions.fullDiskAccess !== null ? `<div><strong>${t('settings.sudo.fda')}:</strong> ${sudoData.permissions.fullDiskAccess ? icon('circle-check', 14, 'style="color:var(--green)"') : `${icon('circle-x', 14, 'style="color:var(--red)"')} <button class="btn btn-sm btn-outline" onclick="openSysSettings('full-disk-access')" style="font-size:0.8em;padding:2px 6px">${t('settings.sudo.open')}</button>`}</div>` : ''}
    </div>`;

  if (!sudoData.configured) {
    html += `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <input type="password" id="sudo-password" placeholder="${t('settings.sudo.password')}" style="flex:1;background:var(--bg3);border:1px solid var(--glass-border);border-radius:6px;padding:8px 12px;color:var(--fg);font:inherit;font-size:0.85em;outline:none">
      <button class="btn btn-sm" onclick="setupSudo()">${icon('lock', 12)} ${t('settings.sudo.setup')}</button>
    </div>
    <div class="sub">${t('settings.sudo.stored.secure')}</div>`;
  } else {
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm btn-outline" onclick="verifySudo()">${icon('test-tube', 12)} ${t('settings.sudo.verify')}</button>
      <button class="btn btn-sm btn-outline" onclick="testSudoCommand()">${icon('zap', 12)} ${t('settings.sudo.test')}</button>
      ${sudoData.platform === 'darwin' ? `<button class="btn btn-sm btn-outline" onclick="showAdminDialog()">${icon('monitor', 12)} ${t('settings.sudo.admin.dialog')}</button>` : ''}
      <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="revokeSudo()">${icon('circle-x', 12)} ${t('settings.sudo.revoke')}</button>
    </div>`;
  }
  html += `<div id="sudo-result" style="font-size:0.78em;margin-top:6px"></div></div>`;

  const envHtml = envData.vars.map(v => `
    <div class="list-item">
      <div class="info">
        <div class="name" style="font-family:monospace;font-size:0.85em">${v.key}</div>
        <div class="desc">${v.value || '(empty)'}</div>
      </div>
      <button class="btn btn-sm btn-outline" onclick="editEnvVar('${v.key}')">${t('edit')}</button>
    </div>
  `).join('');

  html += `<div class="card" style="margin-bottom:16px">
    <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0;margin-bottom:8px;display:flex;align-items:center;gap:6px">${icon('settings', 16)} ${t('settings.env')}</h3>
    ${envHtml}
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn btn-sm" onclick="addEnvVar()">${icon('plus', 14)} ${t('settings.env.add')}</button>
    </div>
  </div>`;

  document.getElementById('settings-content').innerHTML = html;
}

async function setupSudo() {
  const pw = document.getElementById('sudo-password').value;
  if (!pw) { toast(t('settings.sudo.password'), 'error'); return; }
  const resultDiv = document.getElementById('sudo-result');
  resultDiv.innerHTML = `<span style="color:var(--fg2)">${t('loading')}</span>`;
  const res = await fetch(API + '/api/sudo/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
  const data = await res.json();
  if (data.ok && data.verified) { toast(t('settings.sudo.setup.ok')); loadSettings(); }
  else { resultDiv.innerHTML = `<span style="color:var(--red)">${icon('circle-x', 12)} ${data.error || t('error')}</span>`; toast(data.error || t('error'), 'error'); }
}

async function verifySudo() {
  const resultDiv = document.getElementById('sudo-result');
  resultDiv.innerHTML = `<span style="color:var(--fg2)">${t('settings.sudo.verifying')}</span>`;
  const res = await fetch(API + '/api/sudo/verify', { method: 'POST' });
  const data = await res.json();
  resultDiv.innerHTML = data.ok
    ? `<span style="color:var(--green)">${icon('circle-check', 12)} ${t('settings.sudo.verified')}</span>`
    : `<span style="color:var(--red)">${icon('circle-x', 12)} ${data.error}</span>`;
}

async function testSudoCommand() {
  const cmd = prompt(t('settings.sudo.test.prompt'), 'whoami');
  if (!cmd) return;
  const resultDiv = document.getElementById('sudo-result');
  resultDiv.innerHTML = `<span style="color:var(--fg2)">${t('settings.sudo.executing')}</span>`;
  const res = await fetch(API + '/api/sudo/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }) });
  const data = await res.json();
  resultDiv.innerHTML = data.ok
    ? `<span style="color:var(--green)">${icon('circle-check', 12)} ${t('settings.sudo.output')}:</span><pre style="margin:4px 0;padding:6px;background:var(--bg3);border-radius:4px;font-size:0.9em;overflow-x:auto">${escapeHtml(data.output.slice(0, 500))}</pre>`
    : `<span style="color:var(--red)">${icon('circle-x', 12)} ${data.error}</span>`;
}

async function revokeSudo() {
  if (!confirm(t('settings.sudo.revoke.confirm'))) return;
  await fetch(API + '/api/sudo/revoke', { method: 'POST' });
  toast(t('settings.sudo.revoked'));
  loadSettings();
}

async function showAdminDialog() {
  const reason = prompt(t('settings.sudo.admin.reason'), t('settings.sudo.admin.default.reason'));
  if (!reason) return;
  toast(t('settings.sudo.admin.showing'));
  const res = await fetch(API + '/api/sudo/admin-dialog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
  const data = await res.json();
  toast(data.ok ? t('settings.sudo.admin.confirmed') : t('settings.sudo.admin.denied'), data.ok ? 'success' : 'error');
}

async function openSysSettings(pane) {
  await fetch(API + '/api/sudo/open-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pane }) });
  toast(t('settings.sysopen'));
}

function editEnvVar(key) {
  const value = prompt(t('settings.env.new.prompt', { key }), '');
  if (value === null) return;
  fetch(API + '/api/env/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) })
    .then(r => r.json()).then(d => {
      toast(d.ok ? t('settings.env.saved', { key }) : d.error, d.ok ? 'success' : 'error');
      loadSettings();
    });
}

function addEnvVar() {
  const key = prompt(t('settings.env.name.prompt'));
  if (!key) return;
  const value = prompt(t('settings.env.value.prompt', { key }));
  if (value === null) return;
  fetch(API + '/api/env/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) })
    .then(r => r.json()).then(d => {
      toast(d.ok ? t('settings.env.added', { key }) : d.error, d.ok ? 'success' : 'error');
      loadSettings();
    });
}

// ── Doctor & Backup ─────────────────────────────────────
async function repairIssue(action) {
  const res = await fetch(API + '/api/doctor/repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  const data = await res.json();
  toast(data.ok ? data.message : data.message, data.ok ? 'success' : 'error');
  loadMaintenance();
}

async function repairAll() {
  if (!confirm(t('maint.doctor.fix.all.confirm'))) return;
  const res = await fetch(API + '/api/doctor/repair-all', { method: 'POST' });
  const data = await res.json();
  const ok = data.results.filter(r => r.ok).length;
  const fail = data.results.filter(r => !r.ok).length;
  toast(`${t('maint.doctor.fixed', { ok })}${fail > 0 ? `, ${t('maint.doctor.failed', { fail })}` : ''}`, fail > 0 ? 'error' : 'success');
  loadMaintenance();
}

async function createBackup() {
  const name = prompt(t('maint.backup.name.prompt'), '');
  toast(t('maint.backup.creating'));
  const res = await fetch(API + '/api/backups/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name || undefined }) });
  const data = await res.json();
  if (data.ok) { toast(t('maint.backup.created', { id: data.id, count: data.files.length })); loadMaintenance(); }
  else { toast(data.error || t('error'), 'error'); }
}
function createBackupMaint() { createBackup(); }

async function restoreBackup(id) {
  if (!confirm(t('maint.backup.restore.confirm', { id }))) return;
  const res = await fetch(API + '/api/backups/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  const data = await res.json();
  if (data.ok || data.restored?.length > 0) {
    toast(t('maint.backup.restored', { count: data.restored.length }));
    if (data.errors?.length > 0) toast(`${data.errors.length} ${t('error')}`, 'error');
    loadMaintenance();
  } else {
    toast(data.errors?.[0] || t('error'), 'error');
  }
}

async function showBackupFiles(id) {
  const area = document.getElementById('backup-files-area');
  if (area.style.display !== 'none' && area.dataset.id === id) { area.style.display = 'none'; return; }
  const res = await fetch(API + `/api/backups/${id}/files`);
  const data = await res.json();
  area.dataset.id = id; area.style.display = '';
  area.innerHTML = `<div style="font-weight:500;margin-bottom:6px">${icon('clipboard', 14)} ${t('maint.backup.files.in', { id })}:</div>` +
    data.files.map(f => `<div style="padding:2px 0;color:var(--fg2)">${icon('file-text', 12)} ${f}</div>`).join('') +
    `<div style="margin-top:8px"><button class="btn btn-sm btn-outline" onclick="document.getElementById('backup-files-area').style.display='none'">${t('close')}</button></div>`;
}

async function deleteBackup(id) {
  if (!confirm(t('maint.backup.delete.confirm', { id }))) return;
  await fetch(API + '/api/backups/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  toast(t('maint.backup.deleted'));
  loadMaintenance();
}

// ── PM2 ─────────────────────────────────────────────────
async function pm2Action(action) {
  const dangerous = ['stop'];
  if (dangerous.includes(action) && !confirm(t('maint.pm2.stop.confirm'))) return;
  if (action === 'restart' && !confirm(t('maint.pm2.restart.confirm'))) return;

  toast(`PM2 ${action}...`);
  try {
    const res = await fetch(API + '/api/pm2/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    const data = await res.json();
    if (data.ok) {
      toast(t('maint.pm2.action.ok', { action }));
      if (action === 'stop') {
        document.getElementById('pm2-status').innerHTML = `<span class="badge badge-red">${icon('pause', 12)} ${t('maint.pm2.stop')}</span>`;
      } else {
        setTimeout(refreshPM2Status, 2000);
        if (['restart', 'reload', 'start'].includes(action)) setTimeout(connectWS, 3000);
      }
    } else {
      toast(t('maint.pm2.action.fail', { action }) + ': ' + (data.error || ''), 'error');
    }
  } catch (e) {
    toast(t('maint.pm2.lost'), 'error');
    document.getElementById('pm2-status').innerHTML = `<span class="badge badge-red">${icon('circle-x', 12)} ${t('maint.pm2.unreachable')}</span>`;
  }
}

async function refreshPM2Status() {
  try {
    const res = await fetch(API + '/api/pm2/status');
    const data = await res.json();
    const el = document.getElementById('pm2-status');
    if (!el) return;
    if (data.error) { el.innerHTML = `<span class="badge badge-yellow">${icon('alert-triangle', 12)} ${data.error}</span>`; return; }

    const p = data.process;
    const statusColors = { online: 'green', stopping: 'yellow', stopped: 'red', errored: 'red', launching: 'yellow' };
    const statusIcons = { online: 'circle-check', stopping: 'clock', stopped: 'circle-x', errored: 'circle-x', launching: 'zap' };
    const color = statusColors[p.status] || 'gray';
    const sIcon = statusIcons[p.status] || 'info';
    const uptime = p.uptime > 0 ? formatDuration(p.uptime) : '—';
    const mem = p.memory ? (p.memory / 1024 / 1024).toFixed(1) + ' MB' : '—';
    const cpu = p.cpu !== undefined ? p.cpu + '%' : '—';

    el.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
        <span class="badge badge-${color}">${icon(sIcon, 12)} ${p.status}</span>
        <span title="Uptime">${icon('clock', 12)} ${uptime}</span>
        <span title="Memory">${icon('hard-drive', 12)} ${mem}</span>
        <span title="CPU">${icon('monitor', 12)} ${cpu}</span>
        <span title="Restarts">${icon('refresh-cw', 12)} ${p.restarts}x</span>
        <span title="PID">PID: ${p.pid || '—'}</span>
        <span title="PM2 Name" style="font-family:monospace;color:var(--accent2)">${p.name}</span>
      </div>`;
  } catch (e) {
    const el = document.getElementById('pm2-status');
    if (el) el.innerHTML = `<span class="badge badge-red">${icon('circle-x', 12)} ${t('maint.pm2.unreachable')}</span>`;
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
  el.textContent = t('loading');
  try {
    const res = await fetch(API + '/api/pm2/logs');
    const data = await res.json();
    if (data.error) el.textContent = t('error') + ': ' + data.error;
    else { el.textContent = data.logs || t('no.data'); el.scrollTop = el.scrollHeight; }
  } catch (e) { el.textContent = t('error'); }
}

async function restartBot() {
  if (!confirm(t('maint.bot.restart.confirm'))) return;
  toast(t('maint.bot.restarting'));
  await fetch(API + '/api/bot/restart', { method: 'POST' });
  setTimeout(() => { toast(t('maint.bot.reconnecting')); connectWS(); }, 3000);
}

async function reconnectBot() {
  toast(t('reconnecting'));
  if (ws) ws.close();
  setTimeout(connectWS, 500);
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
  document.getElementById('file-breadcrumb').innerHTML = `${icon('folder', 14)} /${currentFilePath === '.' ? '' : currentFilePath}`;

  if (data.entries) {
    document.getElementById('file-editor-area').style.display = 'none';
    const fileIcons = { ts:'code', js:'code', json:'file-text', md:'file-text', html:'globe', css:'palette', sh:'terminal', py:'code', txt:'file-text', env:'lock' };
    document.getElementById('file-list').innerHTML = data.entries.map(e => {
      const ic = e.type === 'dir' ? 'folder' : (fileIcons[e.name.split('.').pop()?.toLowerCase()] || 'file-text');
      const size = e.type === 'file' ? formatSize(e.size) : '';
      const fpath = (currentFilePath === '.' ? '' : currentFilePath + '/') + e.name;
      return `<div class="file-item" onclick="${e.type==='dir' ? `navigateFiles('${e.name}')` : `openFile('${fpath}')`}">
        <span class="file-icon">${icon(ic, 16)}</span><span class="file-name">${e.name}</span><span class="file-meta">${size}</span></div>`;
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
    const lines = data.content.split('\n').length;
    const sizeStr = data.size ? formatSize(data.size) : '';
    document.getElementById('file-edit-meta')?.remove();
    const meta = document.createElement('div');
    meta.id = 'file-edit-meta';
    meta.style.cssText = 'font-size:0.75em;color:var(--fg2);margin-top:4px';
    meta.textContent = `${t('files.lines', { count: lines })} · ${sizeStr}`;
    document.getElementById('file-editor').parentNode.insertBefore(meta, document.getElementById('file-editor'));
  } else if (data.binary) {
    toast(t('files.binary'), 'error');
  } else {
    toast(t('files.open.error'), 'error');
  }
}

async function saveFile() {
  const path = document.getElementById('file-edit-name').textContent;
  const content = document.getElementById('file-editor').value;
  const res = await fetch(API + '/api/files/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content }) });
  const data = await res.json();
  toast(data.ok ? t('files.saved') : data.error, data.ok ? 'success' : 'error');
}

async function createNewFile() {
  const name = prompt(t('files.name.prompt'));
  if (!name) return;
  const filePath = currentFilePath === '.' ? name : currentFilePath + '/' + name;
  const res = await fetch(API + '/api/files/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath, content: '' }) });
  const data = await res.json();
  if (data.ok) { toast(t('files.created')); navigateFiles('.'); openFile(filePath); }
  else { toast(data.error || t('files.create.error'), 'error'); }
}

async function deleteFile(filePath) {
  if (!confirm(t('files.delete.confirm', { path: filePath }))) return;
  const res = await fetch(API + '/api/files/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }) });
  const data = await res.json();
  if (data.ok) { toast(t('files.deleted')); document.getElementById('file-editor-area').style.display = 'none'; navigateFiles('.'); }
  else { toast(data.error || t('files.delete.error'), 'error'); }
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
    list.innerHTML = `<div class="card"><h3>${t('cron.none')}</h3><div class="sub">${t('cron.none.desc')}</div></div>`;
    return;
  }

  const typeIcons = { reminder: 'timer', shell: 'zap', http: 'globe', message: 'message-square', 'ai-query': 'bot' };

  list.innerHTML = data.jobs.map(j => {
    const statusIcon = j.enabled ? icon('circle-check', 14, 'style="color:var(--green)"') : icon('pause', 14, 'style="color:var(--fg3)"');
    const errIcon = j.lastError ? ` <span style="color:var(--red)">${icon('alert-triangle', 14)}</span>` : '';
    const ic = typeIcons[j.type] || 'clipboard';
    const payload = j.payload.text || j.payload.command || j.payload.url || j.payload.prompt || '';
    const schedLabel = j.scheduleReadable || j.schedule;
    const recBadge = j.oneShot
      ? `<span class="badge badge-yellow">${icon('zap', 10)} ${t('cron.single')}</span>`
      : `<span class="badge" style="background:var(--accent);color:#fff">${icon('refresh-cw', 10)} ${escapeHtml(schedLabel)}</span>`;

    return `<div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        ${statusIcon}
        <span style="font-weight:500;flex:1;display:flex;align-items:center;gap:6px">${icon(ic, 16)} ${escapeHtml(j.name)}${errIcon}</span>
        ${recBadge}
      </div>
      <div id="cron-edit-${j.id}" style="display:none;margin-bottom:10px;padding:12px;background:var(--bg3);border-radius:8px">
        ${buildScheduleEditor(j.id, j.schedule, j.oneShot)}
      </div>
      <div style="font-size:0.82em;color:var(--fg2);margin-bottom:8px">
        <span>${t('cron.next.run')}: <strong>${j.nextRunFormatted || '—'}</strong></span> · 
        <span>${t('cron.runs')}: ${j.runCount}</span> · 
        <span>${t('cron.last.run')}: ${j.lastRunFormatted || t('cron.never')}</span>
      </div>
      ${payload ? `<div style="font-size:0.78em;font-family:monospace;color:var(--fg2);padding:6px 8px;background:var(--bg3);border-radius:4px;margin-bottom:8px;word-break:break-all">${escapeHtml(payload.slice(0, 200))}</div>` : ''}
      ${j.lastError ? `<div style="font-size:0.78em;color:var(--red);margin-bottom:8px">${icon('circle-x', 12)} ${escapeHtml(j.lastError)}</div>` : ''}
      <div style="display:flex;gap:6px">
        <button class="btn btn-sm btn-outline" onclick="toggleCronJob('${j.id}')">${j.enabled ? `${icon('pause', 12)} ${t('cron.pause')}` : `${icon('play', 12)} ${t('cron.start')}`}</button>
        <button class="btn btn-sm btn-outline" onclick="runCronJob('${j.id}')">${icon('play', 12)} ${t('cron.run.now')}</button>
        <button class="btn btn-sm btn-outline" onclick="editCronSchedule('${j.id}')">${icon('edit', 12)} ${t('cron.edit')}</button>
        <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="deleteCronJob('${j.id}')">${icon('trash-2', 12)}</button>
      </div>
    </div>`;
  }).join('');
}

function showCreateCron() {
  document.getElementById('cron-create-form').style.display = '';
  const container = document.getElementById('cron-create-schedule-builder');
  if (container && !container.innerHTML.trim()) {
    container.innerHTML = buildScheduleEditor(null, '0 8 * * *', false);
  }
}

async function createCronJob() {
  const name = document.getElementById('cron-name').value.trim();
  const type = document.getElementById('cron-type').value;
  const payloadText = document.getElementById('cron-payload').value.trim();
  if (!name) { toast(t('cron.name.required'), 'error'); return; }

  const result = fieldsToCron(null);
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
    toast(t('cron.created'));
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
  if (!confirm(t('cron.delete.confirm'))) return;
  await fetch(API + '/api/cron/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  toast(t('cron.deleted'));
  loadCron();
}

// ── Schedule Builder ─────────────────────────────────────

function parseCronToFields(schedule) {
  const intMatch = schedule.match(/^(\d+)\s*(m|min|h|hr|d|day|s|sec)s?$/i);
  if (intMatch) {
    const val = intMatch[1];
    const u = intMatch[2].toLowerCase();
    const unit = (u === 'm' || u === 'min') ? 'min' : (u === 'h' || u === 'hr') ? 'h' : (u === 'd' || u === 'day') ? 'd' : 's';
    return { mode: 'interval', interval: val, intervalUnit: unit, hour: '08', minute: '00', weekdays: [], monthday: '1' };
  }
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
    if (days.length === 0) { toast(t('cron.schedule.weekday.min'), 'error'); return null; }
    return { schedule: `${minute} ${hour} * * ${days.join(',')}`, oneShot };
  }

  if (mode === 'monthly') {
    const day = document.getElementById(`sched-monthday-${pfx}`)?.value || '1';
    return { schedule: `${minute} ${hour} ${day} * *`, oneShot };
  }

  return { schedule: `${minute} ${hour} * * *`, oneShot };
}

function buildScheduleEditor(id, schedule, oneShot, hideButtons) {
  const f = parseCronToFields(schedule || '0 8 * * *');
  const pfx = id ? id + '-' : 'create-';
  const wdNames = t('cron.weekdays').split(',');
  const modeOptions = [
    { val: 'interval', label: `${icon('timer', 14)} ${t('cron.schedule.interval')}` },
    { val: 'daily', label: `${icon('calendar', 14)} ${t('cron.schedule.daily')}` },
    { val: 'weekly', label: `${icon('calendar', 14)} ${t('cron.schedule.weekly')}` },
    { val: 'monthly', label: `${icon('calendar', 14)} ${t('cron.schedule.monthly')}` },
  ];

  return `
    <div style="margin-bottom:10px">
      <div style="font-size:0.82em;color:var(--fg2);margin-bottom:6px;font-weight:500">${t('cron.schedule.repeat')}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        ${modeOptions.map(o => `<label style="display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.82em;background:${f.mode===o.val?'var(--accent)':'var(--bg2)'};color:${f.mode===o.val?'#fff':'var(--fg)'}">
          <input type="radio" name="sched-mode-${pfx}" value="${o.val}" ${f.mode===o.val?'checked':''} onchange="toggleSchedFields('${pfx}')" style="display:none"> ${o.label}
        </label>`).join('')}
      </div>
    </div>

    <div id="sched-interval-row-${pfx}" style="display:${f.mode==='interval'?'flex':'none'};gap:6px;align-items:center;margin-bottom:8px">
      <span style="font-size:0.82em;color:var(--fg2)">${t('cron.schedule.every')}</span>
      <input id="sched-interval-${pfx}" type="number" min="1" value="${f.interval}" class="input" style="width:60px;text-align:center">
      <select id="sched-interval-unit-${pfx}" class="input" style="width:auto">
        <option value="s" ${f.intervalUnit==='s'?'selected':''}>${t('cron.units.seconds')}</option>
        <option value="min" ${f.intervalUnit==='min'?'selected':''}>${t('cron.units.minutes')}</option>
        <option value="h" ${f.intervalUnit==='h'?'selected':''}>${t('cron.units.hours')}</option>
        <option value="d" ${f.intervalUnit==='d'?'selected':''}>${t('cron.units.days')}</option>
      </select>
    </div>

    <div id="sched-time-row-${pfx}" style="display:${f.mode!=='interval'?'flex':'none'};gap:6px;align-items:center;margin-bottom:8px">
      <span style="font-size:0.82em;color:var(--fg2)">${t('cron.schedule.at')}</span>
      <input id="sched-hour-${pfx}" type="number" min="0" max="23" value="${f.hour}" class="input" style="width:50px;text-align:center">
      <span style="font-size:1.1em;font-weight:600">:</span>
      <input id="sched-minute-${pfx}" type="number" min="0" max="59" value="${f.minute}" class="input" style="width:50px;text-align:center">
      <span style="font-size:0.82em;color:var(--fg2)">${t('cron.schedule.oclock')}</span>
    </div>

    <div id="sched-wd-row-${pfx}" style="display:${f.mode==='weekly'?'flex':'none'};gap:4px;flex-wrap:wrap;margin-bottom:8px">
      ${wdNames.map((d,i) => `<label style="display:flex;align-items:center;gap:2px;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:0.82em;background:${f.weekdays.includes(String(i))?'var(--accent)':'var(--bg2)'};color:${f.weekdays.includes(String(i))?'#fff':'var(--fg)'}">
        <input type="checkbox" name="sched-wd-${pfx}" value="${i}" ${f.weekdays.includes(String(i))?'checked':''} onchange="this.parentElement.style.background=this.checked?'var(--accent)':'var(--bg2)';this.parentElement.style.color=this.checked?'#fff':'var(--fg)'" style="display:none"> ${d}
      </label>`).join('')}
    </div>

    <div id="sched-md-row-${pfx}" style="display:${f.mode==='monthly'?'flex':'none'};gap:6px;align-items:center;margin-bottom:8px">
      <span style="font-size:0.82em;color:var(--fg2)">${t('cron.schedule.onday')}</span>
      <input id="sched-monthday-${pfx}" type="number" min="1" max="31" value="${f.monthday}" class="input" style="width:55px;text-align:center">
      <span style="font-size:0.82em;color:var(--fg2)">${t('cron.schedule.ofmonth')}</span>
    </div>

    <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
      <span style="font-size:0.82em;color:var(--fg2)">${t('cron.schedule.type')}:</span>
      <label style="font-size:0.82em;cursor:pointer"><input type="radio" name="sched-recur-${pfx}" value="false" ${!oneShot?'checked':''}> ${icon('refresh-cw', 12)} ${t('cron.recurring')}</label>
      <label style="font-size:0.82em;cursor:pointer"><input type="radio" name="sched-recur-${pfx}" value="true" ${oneShot?'checked':''}> ${icon('zap', 12)} ${t('cron.single')}</label>
    </div>

    ${id ? `<div style="display:flex;gap:6px">
      <button class="btn btn-sm" onclick="saveCronSchedule('${id}')">${icon('save', 12)} ${t('save')}</button>
      <button class="btn btn-sm btn-outline" onclick="document.getElementById('cron-edit-${id}').style.display='none'">${t('cancel')}</button>
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
  if (data.ok) { toast(t('cron.updated')); loadCron(); }
  else toast(data.error || t('error'), 'error');
}

async function runCronJob(id) {
  toast(t('cron.executing'));
  const res = await fetch(API + '/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  const data = await res.json();
  if (data.error) toast(data.error, 'error');
  else toast(t('cron.executed'));
  loadCron();
}

// ── Tools ───────────────────────────────────────────────
let allTools = [];

async function loadTools() {
  const res = await fetch(API + '/api/tools');
  const data = await res.json();
  allTools = data.tools || [];
  document.getElementById('tools-count').textContent = t('tools.count', { count: allTools.length });
  renderTools(allTools);
}

function filterTools() {
  const q = document.getElementById('tools-search').value.toLowerCase();
  const filtered = q ? allTools.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) : allTools;
  document.getElementById('tools-count').textContent = t('tools.count', { count: filtered.length });
  renderTools(filtered);
}

function renderTools(tools) {
  const categories = {};
  tools.forEach(tl => {
    const cat = categorize(tl.name);
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(tl);
  });

  const catIcons = {
    'system': 'monitor', 'email': 'mail', 'automation': 'sparkles',
    'pdf': 'file-text', 'dev': 'code', 'network': 'globe',
    'media': 'image', 'clipboard': 'clipboard', 'files': 'folder', 'other': 'hammer'
  };

  let html = '';
  for (const [cat, catTools] of Object.entries(categories)) {
    const catIcon = catIcons[cat] || 'hammer';
    html += `<div style="margin-bottom:20px"><h3 style="font-size:0.85em;color:var(--fg2);margin-bottom:8px;display:flex;align-items:center;gap:6px">${icon(catIcon, 16)} ${t('tools.cat.' + cat)}</h3>`;
    html += catTools.map(tl => {
      const params = Object.keys(tl.parameters || {});
      const paramBadges = params.map(p => `<span class="badge" style="font-size:0.65em">${p}</span>`).join(' ');
      return `<div class="list-item" style="cursor:pointer" onclick="runTool('${escapeHtml(tl.name)}')">
        <div class="info">
          <div class="name" style="font-family:monospace;font-size:0.85em">${tl.name} ${paramBadges}</div>
          <div class="desc">${tl.description}</div>
        </div>
        <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();runTool('${escapeHtml(tl.name)}')">${icon('play', 12)}</button>
      </div>`;
    }).join('');
    html += '</div>';
  }
  document.getElementById('tools-list').innerHTML = html || `<div class="card"><h3>${t('tools.none')}</h3><div class="sub">${t('tools.none.desc')}</div></div>`;
}

function categorize(name) {
  if (['run_shell','sudo_command','system_info','volume_set','brightness_set','bluetooth_control','wifi_status','say_text','notify','process_list','kill_process'].includes(name)) return 'system';
  if (name.startsWith('email_')) return 'email';
  if (['osascript','osascript_js','cliclick_type','cliclick_click','cliclick_key'].includes(name)) return 'automation';
  if (name.startsWith('pdf_') || name.includes('_to_pdf')) return 'pdf';
  if (['git_status','git_commit','pm2_status','pm2_restart','pm2_logs','ssh_command','docker_ps'].includes(name)) return 'dev';
  if (['web_fetch','network_check','open_url'].includes(name)) return 'network';
  if (['image_convert','image_resize','ffmpeg_convert','whisper_transcribe','screenshot'].includes(name)) return 'media';
  if (['clipboard_get','clipboard_set'].includes(name)) return 'clipboard';
  if (['find_files','disk_usage','open_file','calendar_today','calendar_upcoming'].includes(name)) return 'files';
  return 'other';
}

function runTool(name) {
  const tool = allTools.find(t => t.name === name);
  if (!tool) return;
  const params = Object.entries(tool.parameters || {});
  if (params.length === 0) { executeTool(name, {}); return; }
  const values = {};
  for (const [key, def] of params) {
    const val = prompt(`${key}: ${def.description}`, '');
    if (val === null) return;
    if (val) values[key] = val;
  }
  executeTool(name, values);
}

async function executeTool(name, params) {
  toast(t('tools.running', { name }));
  try {
    const res = await fetch(API + '/api/tools/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, params }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error, 'error'); return; }
    const output = data.output || '(no output)';
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector('[data-page="terminal"]').classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-terminal').classList.add('active');
    document.getElementById('page-title').innerHTML = `${icon('terminal', 18)} ${t('nav.terminal')}`;
    const termOutput = document.getElementById('terminal-output');
    termOutput.innerHTML += `<div class="term-cmd">${icon('wrench', 12)} ${escapeHtml(name)} ${JSON.stringify(params)}</div>`;
    termOutput.innerHTML += `<div>${escapeHtml(output)}</div>`;
    termOutput.scrollTop = termOutput.scrollHeight;
    toast(t('tools.executed'));
  } catch (err) {
    toast(t('error') + ': ' + err.message, 'error');
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
  } catch (err) { output.innerHTML += `<div class="term-err">${t('error')}: ${err.message}</div>`; }
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

  const healthIcon = doctorData.healthy ? icon('circle-check', 24, 'style="color:var(--green)"') : (doctorData.errorCount > 0 ? icon('circle-x', 24, 'style="color:var(--red)"') : icon('circle-alert', 24, 'style="color:var(--yellow)"'));
  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      ${healthIcon}
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0;display:flex;align-items:center;gap:6px">${icon('stethoscope', 18)} ${t('maint.doctor')}</h3>
        <div class="sub">${t('maint.doctor.errors', { errors: doctorData.errorCount, warns: doctorData.warnCount })}</div>
      </div>
      <button class="btn btn-sm btn-outline" onclick="loadMaintenance()">${icon('refresh-cw', 12)} ${t('maint.doctor.check')}</button>
      ${doctorData.errorCount > 0 ? `<button class="btn btn-sm" onclick="repairAll()">${icon('wrench', 12)} ${t('maint.doctor.fix.all')}</button>` : ''}
    </div>`;

  for (const issue of doctorData.issues) {
    const sevIcons = { error: icon('circle-x', 14), warning: icon('alert-triangle', 14), info: icon('info', 14) };
    const colors = { error: 'var(--red)', warning: 'var(--yellow)', info: 'var(--fg2)' };
    html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:0.85em;border-top:1px solid var(--glass-border)">
      <span style="color:${colors[issue.severity]}">${sevIcons[issue.severity]}</span>
      <span style="flex:1"><strong>${issue.category}:</strong> ${issue.message}</span>
      ${issue.fixAction ? `<button class="btn btn-sm btn-outline" onclick="repairIssue('${issue.fixAction}')" title="${issue.fix || ''}">${icon('wrench', 12)} Fix</button>` : ''}
    </div>`;
  }
  html += `</div>`;

  // Backup & Restore
  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="display:flex">${icon('hard-drive', 24)}</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">${t('maint.backup')}</h3>
        <div class="sub">${t('maint.backup.desc')}</div>
      </div>
      <button class="btn btn-sm" onclick="createBackupMaint()">${icon('save', 12)} ${t('maint.backup.create')}</button>
    </div>`;

  if (backupData.backups.length > 0) {
    for (const b of backupData.backups) {
      const date = new Date(b.createdAt).toLocaleString(getLang() === 'de' ? 'de-DE' : 'en-US');
      const size = b.size < 1024 ? b.size + ' B' : (b.size / 1024).toFixed(1) + ' KB';
      html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--glass-border);font-size:0.85em">
        ${icon('package', 16)}
        <div style="flex:1">
          <div style="font-weight:500;font-family:monospace">${b.id}</div>
          <div style="color:var(--fg2);font-size:0.82em">${date} · ${b.fileCount} ${t('maint.backup.files')} · ${size}</div>
        </div>
        <button class="btn btn-sm btn-outline" onclick="showBackupFiles('${b.id}')">${icon('clipboard', 12)} ${t('maint.backup.files')}</button>
        <button class="btn btn-sm btn-outline" onclick="restoreBackup('${b.id}')">${icon('refresh-cw', 12)} ${t('maint.backup.restore')}</button>
        <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="deleteBackup('${b.id}')">${icon('trash-2', 12)}</button>
      </div>`;
    }
  } else {
    html += `<div style="font-size:0.85em;color:var(--fg2);padding:8px 0;border-top:1px solid var(--glass-border)">${t('maint.backup.none')}</div>`;
  }
  html += `<div id="backup-files-area" style="display:none;margin-top:8px;padding:8px;background:var(--bg3);border-radius:6px;font-size:0.82em"></div></div>`;

  // PM2
  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="display:flex">${icon('settings', 24)}</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">${t('maint.pm2')}</h3>
        <div class="sub">${t('maint.pm2.desc')}</div>
      </div>
      <button class="btn btn-sm btn-outline" onclick="refreshPM2Status()">${icon('refresh-cw', 12)} ${t('maint.pm2.status')}</button>
    </div>
    <div id="pm2-status" style="margin-bottom:12px;font-size:0.85em;color:var(--fg2)">${t('maint.pm2.loading')}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="pm2Action('restart')">${icon('refresh-cw', 12)} ${t('maint.pm2.restart')}</button>
      <button class="btn btn-sm btn-outline" onclick="pm2Action('reload')">${icon('refresh-cw', 12)} ${t('maint.pm2.reload')}</button>
      <button class="btn btn-sm btn-danger" onclick="pm2Action('stop')">${icon('pause', 12)} ${t('maint.pm2.stop')}</button>
      <button class="btn btn-sm" style="background:var(--green)" onclick="pm2Action('start')">${icon('play', 12)} ${t('maint.pm2.start')}</button>
      <button class="btn btn-sm btn-outline" onclick="pm2Action('flush')">${icon('trash-2', 12)} ${t('maint.pm2.flush')}</button>
    </div>
    <div id="pm2-logs" style="display:none;margin-top:12px"></div>
  </div>`;

  // Logs
  html += `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="display:flex">${icon('clipboard', 24)}</span>
      <div style="flex:1">
        <h3 style="font-size:0.95em;text-transform:none;letter-spacing:0">${t('maint.logs')}</h3>
        <div class="sub">${t('maint.logs.desc')}</div>
      </div>
      <button class="btn btn-sm btn-outline" onclick="loadPM2Logs()">${icon('refresh-cw', 12)} ${t('maint.logs.refresh')}</button>
    </div>
    <div id="pm2-log-output" style="background:var(--bg);border-radius:6px;padding:10px;font-family:monospace;font-size:0.75em;max-height:300px;overflow-y:auto;white-space:pre-wrap;color:var(--fg2);border:1px solid var(--glass-border)">${t('maint.logs.load')}</div>
  </div>`;

  document.getElementById('maintenance-content').innerHTML = html;
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
  if (!container) return;
  container.innerHTML = `<div style="color:var(--fg2);font-size:0.85em">${t('wa.groups.loading')}</div>`;

  const [groupsRes, rulesRes] = await Promise.all([
    fetch(API + '/api/whatsapp/groups').then(r => r.json()).catch(() => ({ groups: [], error: 'Unreachable' })),
    fetch(API + '/api/whatsapp/group-rules').then(r => r.json()).catch(() => ({ rules: [] })),
  ]);

  _waGroupsCache = groupsRes.groups || [];
  _waRulesCache = rulesRes.rules || [];
  const activeCount = _waRulesCache.filter(r => r.enabled).length;

  const badge = document.getElementById('wa-groups-badge');
  if (badge) badge.textContent = activeCount > 0 ? `(${t('wa.groups.active', { count: activeCount })})` : '';

  if (groupsRes.error && _waGroupsCache.length === 0) {
    container.innerHTML = `<div style="color:var(--fg2);font-size:0.85em;padding:8px 0">${t('wa.not.connected')}</div>`;
    return;
  }

  const rulesMap = {};
  for (const r of _waRulesCache) rulesMap[r.groupId] = r;

  let html = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
    <div style="flex:1;font-size:0.8em;color:var(--fg2)">${t('wa.groups.count', { count: _waGroupsCache.length })} · ${t('wa.groups.active', { count: activeCount })}</div>
    <button class="btn btn-sm btn-outline" style="font-size:0.75em" onclick="loadWAGroups()">${icon('refresh-cw', 12)}</button>
  </div>`;

  const sorted = [..._waGroupsCache].sort((a, b) => {
    const aRule = rulesMap[a.id]; const bRule = rulesMap[b.id];
    if (aRule?.enabled && !bRule?.enabled) return -1;
    if (!aRule?.enabled && bRule?.enabled) return 1;
    if (aRule && !bRule) return -1;
    if (!aRule && bRule) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const g of sorted) {
    const rule = rulesMap[g.id];
    const isEnabled = rule?.enabled;
    const statusIcon = isEnabled ? icon('circle-check', 14, 'style="color:var(--green)"') : icon('circle-dot', 14, 'style="opacity:0.3"');
    const allowedCount = rule?.allowedParticipants?.length || 0;
    const accessLabel = !rule ? t('wa.groups.no.config') :
      isEnabled ? (allowedCount > 0 ? t('wa.groups.allowed', { count: allowedCount }) : t('wa.groups.all.allowed')) :
      t('disabled');
    const approvalLabel = rule?.requireApproval !== false ? t('wa.approval') : t('wa.auto');

    html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--glass-border)">
      ${statusIcon}
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;font-size:0.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(g.name)}</div>
        <div style="font-size:0.72em;color:var(--fg2)">${accessLabel}${isEnabled ? ' · ' + approvalLabel : ''}</div>
      </div>
      <button class="btn btn-sm ${isEnabled ? '' : 'btn-outline'}" style="font-size:0.75em;padding:4px 8px" onclick="toggleWAGroup('${g.id}', '${escapeHtml(g.name)}', ${!isEnabled})">
        ${isEnabled ? icon('pause', 12) : icon('play', 12)}
      </button>
      <button class="btn btn-sm btn-outline" style="font-size:0.75em;padding:4px 8px" onclick="configureWAGroup('${g.id}', '${escapeHtml(g.name)}')">${icon('settings', 12)}</button>
    </div>`;
  }

  container.innerHTML = html;
}

async function toggleWAGroup(groupId, groupName, enable) {
  await fetch(API + '/api/whatsapp/group-rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId, groupName, enabled: enable }),
  });
  toast(enable ? t('wa.groups.enabled', { name: groupName }) : t('wa.groups.disabled', { name: groupName }));
  loadWAGroups();
}

async function configureWAGroup(groupId, groupName) {
  const container = document.getElementById('wa-groups-content');
  if (!container) return;

  const rule = _waRulesCache?.find(r => r.groupId === groupId) || {};
  container.innerHTML = `<div style="color:var(--fg2);font-size:0.85em">${t('loading')}</div>`;
  const res = await fetch(API + `/api/whatsapp/groups/${encodeURIComponent(groupId)}/participants`);
  const { participants } = await res.json();

  const allowed = new Set(rule.allowedParticipants || []);
  const requireMention = rule.requireMention !== false;
  const allowMedia = rule.allowMedia !== false;
  const requireApproval = rule.requireApproval !== false;

  let html = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <button class="btn btn-sm btn-outline" style="font-size:0.75em;padding:3px 8px" onclick="loadWAGroups()">${icon('arrow-left', 12)}</button>
      <span style="font-weight:600;font-size:0.9em">${escapeHtml(groupName)}</span>
      <span style="font-size:0.75em;color:var(--fg2)">${t('wa.groups.participants', { count: participants.length })}</span>
    </div>

    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;padding:10px;background:var(--bg3);border-radius:6px">
      <label style="display:flex;align-items:center;gap:6px;font-size:0.82em;cursor:pointer">
        <input type="checkbox" id="wa-require-mention" ${requireMention ? 'checked' : ''}>
        <span>${t('wa.groups.mention.required')}</span>
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:0.82em;cursor:pointer">
        <input type="checkbox" id="wa-allow-media" ${allowMedia ? 'checked' : ''}>
        <span>${icon('paperclip', 12)} ${t('wa.groups.media')}</span>
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:0.82em;cursor:pointer">
        <input type="checkbox" id="wa-require-approval" ${requireApproval ? 'checked' : ''}>
        <span>${icon('lock', 12)} ${t('wa.groups.approval')}</span>
      </label>
    </div>

    <div style="margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-weight:500;font-size:0.85em">${icon('users', 14)} ${t('wa.groups.allowed.contacts')}</span>
        <span style="flex:1"></span>
        <button class="btn btn-sm btn-outline" style="font-size:0.7em;padding:2px 6px" onclick="waSelectAll(true)">${t('wa.groups.select.all')}</button>
        <button class="btn btn-sm btn-outline" style="font-size:0.7em;padding:2px 6px" onclick="waSelectAll(false)">${t('wa.groups.select.none')}</button>
      </div>
      <div style="font-size:0.72em;color:var(--fg2);margin-bottom:6px">${t('wa.groups.no.selection')}</div>
      <div id="wa-participants" style="max-height:250px;overflow-y:auto">`;

  for (const p of participants) {
    const checked = allowed.has(p.id) || allowed.has(p.number) ? 'checked' : '';
    const adminBadge = p.isAdmin ? ` <span style="background:var(--accent);color:var(--bg);padding:0 4px;border-radius:3px;font-size:0.7em">${t('wa.groups.admin')}</span>` : '';
    html += `<label style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--glass-border);cursor:pointer;font-size:0.82em" class="wa-participant">
        <input type="checkbox" data-pid="${p.id}" data-number="${p.number}" ${checked}>
        <span style="flex:1">${escapeHtml(p.name)}${adminBadge}</span>
        <span style="color:var(--fg2);font-size:0.75em;font-family:monospace">+${p.number}</span>
      </label>`;
  }

  html += `</div></div>
    <div style="display:flex;gap:6px;margin-top:10px">
      <button class="btn btn-sm" onclick="saveWAGroupConfig('${groupId}', '${escapeHtml(groupName)}')">${icon('save', 12)} ${t('save')}</button>
      <button class="btn btn-sm btn-outline" onclick="loadWAGroups()">${t('cancel')}</button>
      ${rule.groupId ? `<button class="btn btn-sm btn-outline" style="color:var(--red);margin-left:auto" onclick="deleteWAGroupRule('${groupId}')">${icon('trash-2', 12)}</button>` : ''}
    </div>`;

  container.innerHTML = html;
}

function waSelectAll(selectAll) {
  document.querySelectorAll('#wa-participants input[type=checkbox]').forEach(cb => cb.checked = selectAll);
}

async function saveWAGroupConfig(groupId, groupName) {
  const requireMention = document.getElementById('wa-require-mention').checked;
  const allowMedia = document.getElementById('wa-allow-media').checked;
  const requireApproval = document.getElementById('wa-require-approval').checked;
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
    body: JSON.stringify({ groupId, groupName, enabled: true, allowedParticipants, participantNames, requireMention, allowMedia, requireApproval }),
  });
  toast(t('wa.groups.configured', { name: groupName }));
  loadWAGroups();
}

async function deleteWAGroupRule(groupId) {
  if (!confirm(t('wa.groups.rule.delete.confirm'))) return;
  await fetch(API + `/api/whatsapp/group-rules/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
  toast(t('wa.groups.rule.deleted'));
  loadWAGroups();
}

// ── Command Palette (Cmd+K) ─────────────────────────────
let _cmdPaletteIdx = 0;
let _cmdPaletteItems = [];

function openCommandPalette() {
  const overlay = document.getElementById('cmd-palette-overlay');
  overlay.style.display = 'flex';
  const input = document.getElementById('cmd-palette-input');
  input.value = '';
  input.focus();
  renderCommandPaletteResults('');
}

function closeCommandPalette() {
  document.getElementById('cmd-palette-overlay').style.display = 'none';
}

function getCommandPaletteItems() {
  const pages = [
    { id: 'chat', icon: 'message-square', label: t('nav.chat'), action: () => navigateTo('chat') },
    { id: 'dashboard', icon: 'layout-dashboard', label: t('nav.dashboard'), action: () => navigateTo('dashboard') },
    { id: 'models', icon: 'bot', label: t('nav.models'), action: () => navigateTo('models') },
    { id: 'personality', icon: 'palette', label: t('nav.personality'), action: () => navigateTo('personality') },
    { id: 'memory', icon: 'brain', label: t('nav.memory'), action: () => navigateTo('memory') },
    { id: 'sessions', icon: 'clipboard', label: t('nav.sessions'), action: () => navigateTo('sessions') },
    { id: 'files', icon: 'folder', label: t('nav.files'), action: () => navigateTo('files') },
    { id: 'cron', icon: 'timer', label: t('nav.cron'), action: () => navigateTo('cron') },
    { id: 'tools', icon: 'hammer', label: t('nav.tools'), action: () => navigateTo('tools') },
    { id: 'plugins', icon: 'plug', label: t('nav.plugins'), action: () => navigateTo('plugins') },
    { id: 'platforms', icon: 'smartphone', label: t('nav.platforms'), action: () => navigateTo('platforms') },
    { id: 'users', icon: 'users', label: t('nav.users'), action: () => navigateTo('users') },
    { id: 'terminal', icon: 'terminal', label: t('nav.terminal'), action: () => navigateTo('terminal') },
    { id: 'maintenance', icon: 'stethoscope', label: t('nav.maintenance'), action: () => navigateTo('maintenance') },
    { id: 'settings', icon: 'settings', label: t('nav.settings'), action: () => navigateTo('settings') },
  ];

  const actions = [
    { id: 'reset', icon: 'refresh-cw', label: t('cmd.action.reset'), kbd: navigator.platform?.includes('Mac') ? '⌘N' : 'Ctrl+N', action: () => resetChat() },
    { id: 'theme', icon: 'sun', label: t('cmd.action.theme'), action: () => toggleTheme() },
    { id: 'export', icon: 'download', label: t('cmd.action.export'), kbd: navigator.platform?.includes('Mac') ? '⌘⇧E' : 'Ctrl+Shift+E', action: () => exportChat() },
    { id: 'lang', icon: 'languages', label: t('cmd.action.lang'), action: () => toggleLang() },
  ];

  return { pages, actions };
}

function renderCommandPaletteResults(query) {
  const { pages, actions } = getCommandPaletteItems();
  const q = query.toLowerCase().trim();

  const filteredPages = q ? pages.filter(p => p.label.toLowerCase().includes(q) || p.id.includes(q)) : pages;
  const filteredActions = q ? actions.filter(a => a.label.toLowerCase().includes(q) || a.id.includes(q)) : actions;

  _cmdPaletteItems = [...filteredPages, ...filteredActions];
  _cmdPaletteIdx = 0;

  const container = document.getElementById('cmd-palette-results');

  if (_cmdPaletteItems.length === 0) {
    container.innerHTML = `<div class="cmd-palette-empty">${t('cmd.no.results')}</div>`;
    return;
  }

  let html = '';
  if (filteredPages.length > 0) {
    html += `<div class="cmd-palette-section">${t('cmd.goto')}</div>`;
    filteredPages.forEach((p, i) => {
      html += `<div class="cmd-palette-item${i === 0 ? ' selected' : ''}" data-idx="${i}" onclick="executeCmdPaletteItem(${i})" onmouseenter="selectCmdPaletteItem(${i})">
        ${icon(p.icon, 16)} <span>${p.label}</span>
      </div>`;
    });
  }
  if (filteredActions.length > 0) {
    html += `<div class="cmd-palette-section">${t('cmd.actions')}</div>`;
    filteredActions.forEach((a, j) => {
      const idx = filteredPages.length + j;
      html += `<div class="cmd-palette-item${idx === 0 && filteredPages.length === 0 ? ' selected' : ''}" data-idx="${idx}" onclick="executeCmdPaletteItem(${idx})" onmouseenter="selectCmdPaletteItem(${idx})">
        ${icon(a.icon, 16)} <span>${a.label}</span>
        ${a.kbd ? `<kbd>${a.kbd}</kbd>` : ''}
      </div>`;
    });
  }

  container.innerHTML = html;
}

function selectCmdPaletteItem(idx) {
  _cmdPaletteIdx = idx;
  document.querySelectorAll('.cmd-palette-item').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });
}

function executeCmdPaletteItem(idx) {
  const item = _cmdPaletteItems[idx];
  if (item) {
    closeCommandPalette();
    item.action();
  }
}

function navigateTo(page) {
  const navItem = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navItem) navItem.click();
}

// Command palette keyboard navigation
document.getElementById('cmd-palette-input').addEventListener('input', (e) => {
  renderCommandPaletteResults(e.target.value);
});

document.getElementById('cmd-palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeCommandPalette(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectCmdPaletteItem(Math.min(_cmdPaletteIdx + 1, _cmdPaletteItems.length - 1));
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectCmdPaletteItem(Math.max(_cmdPaletteIdx - 1, 0));
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    executeCmdPaletteItem(_cmdPaletteIdx);
  }
});

// ── Theme Toggle ────────────────────────────────────────
function toggleTheme() {
  const body = document.documentElement;
  const current = body.getAttribute('data-theme');
  body.setAttribute('data-theme', current === 'light' ? '' : 'light');
  localStorage.setItem('theme', current === 'light' ? 'dark' : 'light');
}
if (localStorage.getItem('theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');

// ── Init ────────────────────────────────────────────────
initUI();
initDragDrop();
restoreChatFromStorage();
if (chatMessages.length > 0) scrollToBottom();
connectWS();
loadDashboard();
loadModels();