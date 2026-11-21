'use strict';
const electron = require('electron');
const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, screen, shell, dialog, clipboard } = electron;
const path = require('path');
const fs = require('fs');
const { VaultTasks } = require('./lib/tasks');
const { writeXlsx, readTable, toCsv } = require('./lib/xlsx');

const logf = (msg) => {
  try {
    const f = path.join(app.getPath('userData'), 'app.log');
    fs.appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {}
};
const INBOX = '00-收件箱/速记待办.md';
const SOURCES = [
  { type: 'dir', path: '02-工作/会议纪要' },
  { type: 'file', path: INBOX },
];
const W = 420;
const EXPAND_H = 680;
const COLLAPSE_H = 42;
const MIN_EXPAND_H = 460;
const maxExpandH = () => Math.max(MIN_EXPAND_H, screen.getPrimaryDisplay().workArea.height - 30);

const cfgFile = () => path.join(app.getPath('userData'), 'widget.json');
function loadCfg() { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch (e) { return {}; } }
function saveCfg(c) { try { fs.writeFileSync(cfgFile(), JSON.stringify(c), 'utf8'); } catch (e) {} }
const cfg = Object.assign({ x: null, y: null, pinned: true, collapsed: false, autostart: false, expandH: EXPAND_H }, loadCfg());
function expandHeight() {
  const h = Number(cfg.expandH) || EXPAND_H;
  return Math.min(maxExpandH(), Math.max(MIN_EXPAND_H, h));
}

function resolveVault() {
  if (process.env.TWF_VAULT) return process.env.TWF_VAULT;
  if (cfg.vault && fs.existsSync(cfg.vault)) return cfg.vault;
  const fb = path.join(app.getPath('documents'), '待办悬浮数据');
  try { fs.mkdirSync(path.join(fb, '00-收件箱'), { recursive: true }); } catch (e) {}
  return fb;
}
let VAULT = resolveVault();

// ---- 月历任务的定时/定期规则 ----
const rulesFile = () => path.join(VAULT, '00-收件箱', '月历重复规则.json');
let rules = [];

function loadRules() {
  try {
    const o = JSON.parse(fs.readFileSync(rulesFile(), 'utf8'));
    if (o && Array.isArray(o.rules)) rules = o.rules;
  } catch (e) { rules = []; }
  rules.forEach((r) => { if (!r.generated || typeof r.generated !== 'object') r.generated = {}; });
}

function saveRules() {
  try {
    fs.mkdirSync(path.dirname(rulesFile()), { recursive: true });
    fs.writeFileSync(rulesFile(), JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
  } catch (e) { logf('saveRules error ' + e.message); }
}

// ---- 到期提醒（普通待办与重复任务都走这里）----
const remindCfgFile = () => path.join(VAULT, '00-收件箱', '月历提醒设置.json');
const remindStateFile = () => path.join(app.getPath('userData'), 'reminder-state.json');
let remindCfg = { enabled: true, lead: 0, allDayTime: '09:00' };
let notified = {};

function loadRemindCfg() {
  try {
    const o = JSON.parse(fs.readFileSync(remindCfgFile(), 'utf8'));
    if (o && typeof o === 'object') {
      remindCfg = {
        enabled: o.enabled !== false,
        lead: Number.isFinite(Number(o.lead)) ? Number(o.lead) : 0,
        allDayTime: /^\d{1,2}:\d{2}$/.test(String(o.allDayTime || '')) ? o.allDayTime : '09:00',
      };
    }
  } catch (e) { remindCfg = { enabled: true, lead: 0, allDayTime: '09:00' }; }
}
function saveRemindCfg() {
  try {
    fs.mkdirSync(path.dirname(remindCfgFile()), { recursive: true });
    fs.writeFileSync(remindCfgFile(), JSON.stringify(remindCfg, null, 2), 'utf8');
  } catch (e) { logf('saveRemindCfg error ' + e.message); }
}
function loadNotified() {
  try {
    const o = JSON.parse(fs.readFileSync(remindStateFile(), 'utf8'));
    notified = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) { notified = {}; }
}
function saveNotified() {
  try {
    const keys = Object.keys(notified);
    if (keys.length > 2000) {
      const sorted = keys.sort((a, b) => String(notified[b]).localeCompare(String(notified[a])));
      sorted.slice(1000).forEach((k) => { delete notified[k]; });
    }
    fs.writeFileSync(remindStateFile(), JSON.stringify(notified), 'utf8');
  } catch (e) {}
}
function taskKey(t) {
  return `${t.due || ''}|${String(t.text || '').trim()}|${(t.tags || []).join(',')}`;
}
function taskTime(t) {
  const m = String(t.text || '').match(/^(\d{1,2}:\d{2})\s+/);
  return m ? m[1] : remindCfg.allDayTime;
}
function taskMoment(t) {
  if (!t.due) return null;
  const d = parseDay(t.due);
  if (!d) return null;
  const tm = taskTime(t).split(':').map(Number);
  if (tm.length !== 2 || tm.some((n) => !Number.isFinite(n))) return null;
  d.setHours(tm[0], tm[1], 0, 0);
  return d;
}
function fireReminder(t, dueDate) {
  const time = taskTime(t);
  const plain = String(t.text || '').replace(/^\d{1,2}:\d{2}\s+/, '');
  const body = `${t.due || ''}${time ? ' ' + time : ''} · ${plain.slice(0, 80)}`;
  const title = (t.tags || []).includes('周期') ? '重复事项到期' : '待办到期提醒';
  let shown = false;
  try {
    if (Notification.isSupported()) {
      const p = path.join(__dirname, 'assets', 'tray.png');
      const n = new Notification({ title, body, icon: fs.existsSync(p) ? p : undefined });
      n.on('click', () => { if (win) { win.show(); win.focus(); } });
      n.show();
      shown = true;
    }
  } catch (e) { logf('notification error ' + e.message); }
  if (!shown) {
    try { if (tray && tray.displayBalloon) tray.displayBalloon({ title, content: body.slice(0, 180) }); }
    catch (e) { logf('balloon error ' + e.message); }
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('reminder:fire', { title, body, text: t.text, due: t.due, time });
  }
  logf('REMIND ' + body);
}
function checkReminders(seedPast) {
  if (!store) return;
  const now = new Date();
  let changed = false;
  for (const t of store.tasks) {
    if (t.done || !t.due) continue;
    const due = taskMoment(t);
    if (!due) continue;
    const key = taskKey(t);
    const remindAt = due.getTime() - (Number(remindCfg.lead) || 0) * 60000;
    // 首次启动只登记早于今天到期的任务，避免一次性补弹一堆历史提醒；
    // 今天的到期任务即使时间已过，也要正常提醒一次。
    if (seedPast) {
      const day = parseDay(t.due);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (day < today) { notified[key] = now.toISOString(); changed = true; continue; }
    }
    if (!remindCfg.enabled) continue;
    if (now.getTime() < remindAt) continue;
    if (now.getTime() > due.getTime() + 24 * 3600 * 1000) continue;
    if (notified[key]) continue;
    notified[key] = now.toISOString();
    changed = true;
    fireReminder(t, due);
  }
  if (changed) saveNotified();
}

function fmtDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDay(s) {
  const p = String(s || '').split('-').map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return null;
  const d = new Date(p[0], p[1] - 1, p[2]);
  return isNaN(d.getTime()) ? null : d;
}

function ruleMatches(r, d, start) {
  if (r.type === 'once') return fmtDay(d) === fmtDay(start);
  if (r.type === 'daily') return d >= start;
  if (r.type === 'weekly') {
    const monFirst = (d.getDay() + 6) % 7;
    return d >= start && monFirst === Number(r.weekday);
  }
  if (r.type === 'monthly') {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const target = Math.min(Number(r.monthday) || 1, last);
    return d >= start && d.getDate() === target;
  }
  if (r.type === 'interval') {
    const n = Math.max(1, Number(r.interval) || 1);
    const diff = Math.floor((d - start) / 86400000);
    return d >= start && diff % n === 0;
  }
  return false;
}

function generateRecurrences() {
  if (!store) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end = new Date(today); end.setDate(end.getDate() + 60);
  const items = [];
  let changed = false;
  for (const r of rules) {
    if (!r.enabled) continue;
    const start = parseDay(r.start);
    if (!start) continue;
    const from = start > today ? new Date(start) : new Date(today);
    for (let d = new Date(from); d <= end; d.setDate(d.getDate() + 1)) {
      const key = fmtDay(d);
      if (r.generated[key]) continue;
      if (!ruleMatches(r, d, start)) continue;
      const prefix = r.time ? r.time + ' ' : '';
      items.push({ text: `${prefix}${r.text} #周期`, due: key });
      r.generated[key] = true;
      changed = true;
    }
  }
  if (items.length) { store.addTasks(items); broadcast(); }
  if (changed) saveRules();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
let win = null;
let tray = null;
let isQuitting = false;
let store = null;

function initStore() {
  store = new VaultTasks(VAULT, SOURCES, INBOX);
  store.rescan();
  store.watch(() => broadcast());
  loadRules();
  loadRemindCfg();
  loadNotified();
  generateRecurrences();
  checkReminders(true);
}

function broadcast() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('tasks:updated', { tasks: store.tasks, lastScan: store.lastScan });
}
function rescanAndPush() {
  store.rescan();
  broadcast();
}

function visibleWorkAreas() {
  try {
    const ds = screen.getAllDisplays();
    if (ds.length) return ds.map((d) => d.workArea);
  } catch (e) {}
  return [screen.getPrimaryDisplay().workArea];
}

// 坐标校验：若窗口在任一显示器工作区内的可见面积不足，则回退到主屏右下角
function sanitizePos(x, y, w, h) {
  const needH = Math.min(60, h);
  for (const a of visibleWorkAreas()) {
    const visW = Math.min(x + w, a.x + a.width) - Math.max(x, a.x);
    const visH = Math.min(y + h, a.y + a.height) - Math.max(y, a.y);
    if (visW > 0 && visH >= needH) return { x, y };
  }
  const pa = screen.getPrimaryDisplay().workArea;
  return { x: pa.x + pa.width - w - 18, y: pa.y + pa.height - Math.min(h, pa.height) - 18 };
}

function cornerPos(h) {
  const pa = screen.getPrimaryDisplay().workArea;
  return { x: pa.x + pa.width - W - 18, y: pa.y + pa.height - Math.min(h, pa.height) - 18 };
}

// 兜底：确保窗口在可见区域内并已显示（可反复调用，正常位置时为空操作）
function ensureVisible(reason) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const p = sanitizePos(b.x, b.y, b.width, b.height);
  if (p.x !== b.x || p.y !== b.y) {
    win.setBounds({ x: p.x, y: p.y, width: b.width, height: b.height });
    cfg.x = p.x; cfg.y = p.y; saveCfg(cfg);
    logf('ensureVisible(' + (reason || '-') + ') -> ' + p.x + ',' + p.y);
  }
  if (!win.isVisible()) { win.show(); logf('ensureVisible show'); }
}

function resetWindowPos() {
  if (!win || win.isDestroyed()) return;
  const h = expandHeight();
  const p = cornerPos(h);
  win.setBounds({ x: p.x, y: p.y, width: W, height: h });
  cfg.x = p.x; cfg.y = p.y; cfg.collapsed = false; saveCfg(cfg);
  win.setResizable(true);
  applyHeight(h);
  win.show(); win.focus();
  buildTrayMenu(); sendState();
  logf('reset pos -> ' + p.x + ',' + p.y);
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const h = cfg.collapsed ? COLLAPSE_H : expandHeight();
  let x, y;
  if (cfg.x != null && cfg.y != null) {
    const p = sanitizePos(cfg.x, cfg.y, W, h);
    x = p.x; y = p.y;
    if (x !== cfg.x || y !== cfg.y) {
      cfg.x = x; cfg.y = y; saveCfg(cfg);
      logf('pos out-of-screen fixed ' + x + ',' + y);
    }
  } else {
    x = wa.x + wa.width - W - 18;
    y = wa.y + wa.height - h - 18;
  }

  win = new BrowserWindow({
    x, y, width: W, height: h,
    frame: false, transparent: true, resizable: !cfg.collapsed,
    alwaysOnTop: cfg.pinned, skipTaskbar: true, hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(cfg.pinned, 'floating');
  win.setMenuBarVisibility(false);
  win.setMinimumSize(W, cfg.collapsed ? COLLAPSE_H : MIN_EXPAND_H);
  win.setResizable(!cfg.collapsed);
  win.webContents.on('did-finish-load', () => { logf('did-finish-load'); broadcast(); sendState(); });
  win.webContents.on('did-fail-load', (_e, code, desc) => logf('did-fail-load ' + code + ' ' + desc));
  win.webContents.on('render-process-gone', (_e, d) => {
    logf('renderer-gone ' + (d && d.reason));
    if (!win.isDestroyed() && win.webContents) {
      setTimeout(() => { try { win.webContents.reloadIgnoringCache(); } catch (e) {} }, 900);
    }
  });
  win.webContents.on('console-message', (_e, level, msg) => logf('console[' + level + '] ' + String(msg).slice(0, 200)));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => { win.show(); logf('ready-to-show shown'); });
  // 兜底：透明窗口在部分显卡驱动/远程桌面下不会触发 ready-to-show，超时强制显示
  win._showT = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) { win.show(); logf('fallback show'); }
  }, 2200);
  win.on('moved', () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    cfg.x = b.x; cfg.y = b.y;
    clearTimeout(win._movedT);
    win._movedT = setTimeout(() => saveCfg(cfg), 400);
  });
  win.on('resized', () => {
    if (win.isDestroyed() || cfg.collapsed) return;
    const b = win.getBounds();
    if (b.height < MIN_EXPAND_H) return;
    cfg.expandH = Math.min(maxExpandH(), b.height);
    clearTimeout(win._resizeT);
    win._resizeT = setTimeout(() => saveCfg(cfg), 400);
  });
  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

function applyHeight(targetH) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const dy = b.height - targetH;
  win.setBounds({ x: b.x, y: b.y + dy, width: b.width, height: targetH });
}

function sendState() {
  if (win && !win.isDestroyed()) win.webContents.send('app:state', { collapsed: cfg.collapsed, pinned: cfg.pinned });
}

function setCollapsed(c) {
  cfg.collapsed = !!c;
  saveCfg(cfg);
  if (win && !win.isDestroyed()) {
    win.setResizable(!cfg.collapsed);
    win.setMinimumSize(W, cfg.collapsed ? COLLAPSE_H : MIN_EXPAND_H);
    applyHeight(cfg.collapsed ? COLLAPSE_H : expandHeight());
  }
  sendState();
}
function resizeWindow(delta) {
  if (cfg.collapsed) setCollapsed(false);
  cfg.expandH = Math.min(maxExpandH(), Math.max(MIN_EXPAND_H, expandHeight() + (Number(delta) || 0)));
  saveCfg(cfg);
  applyHeight(cfg.expandH);
  return cfg.expandH;
}
function setPin(p) {
  cfg.pinned = !!p;
  saveCfg(cfg);
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(cfg.pinned, 'floating');
  sendState();
  buildTrayMenu();
}

function trayIcon() {
  const p = path.join(__dirname, 'assets', 'tray.png');
  if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  return nativeImage.createEmpty();
}

async function pickVaultDir() {
  const r = await dialog.showOpenDialog({
    title: '选择待办数据文件夹（可直接选 Obsidian 库目录）',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  VAULT = r.filePaths[0];
  cfg.vault = VAULT;
  saveCfg(cfg);
  initStore();
  buildTrayMenu();
  logf('vault -> ' + VAULT + ' tasks=' + store.tasks.length);
  return { ok: true, vault: VAULT };
}

function buildTrayMenu() {
  const login = app.getLoginItemSettings().openAtLogin;
  const menu = Menu.buildFromTemplate([
    { label: cfg.collapsed ? '展开面板' : '收起为窄条', click: () => setCollapsed(!cfg.collapsed) },
    { type: 'separator' },
    { label: '窗口置顶', type: 'checkbox', checked: cfg.pinned, click: (i) => setPin(i.checked) },
    {
      label: '开机自启', type: 'checkbox', checked: login,
      click: (i) => {
        app.setLoginItemSettings({ openAtLogin: i.checked, path: process.execPath, args: [app.getAppPath(), '--disable-gpu', '--no-sandbox'] });
      },
    },
    { type: 'separator' },
    { label: '重置窗口位置', click: () => resetWindowPos() },
    { label: '打开数据文件夹', click: () => shell.openPath(VAULT) },
    { label: '更换数据文件夹…', click: () => pickVaultDir() },
    { label: '立即刷新', click: () => rescanAndPush() },
    { type: 'separator' },
    {
      label: '退出', click: () => { isQuitting = true; app.quit(); },
    },
  ]);
  if (tray) tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('桌面待办悬浮');
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) { win.hide(); } else { win.show(); }
  });
  buildTrayMenu();
}

ipcMain.handle('tasks:get', () => ({ tasks: store.tasks, lastScan: store.lastScan, vault: VAULT }));
ipcMain.handle('task:toggle', (e, id) => {
  try { const ok = store.toggleTask(id); broadcast(); return { ok }; }
  catch (err) { logf('toggle error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.handle('task:setDue', (e, id, due) => {
  try { const ok = store.setTaskDue(id, due || null); broadcast(); return { ok }; }
  catch (err) { logf('setDue error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.handle('task:update', (e, id, data) => {
  try {
    const ok = store.updateTask(id, data || {});
    broadcast();
    logf('update ' + ok + ' ' + String((data && data.text) || '').slice(0, 40));
    return { ok };
  }
  catch (err) { logf('updateTask error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.handle('task:add', (e, text, due) => {
  try { const ok = store.addTask(text, due || null); broadcast(); return { ok }; }
  catch (err) { logf('addTask error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.handle('task:remove', (e, id) => {
  try { const ok = store.removeTask(id); broadcast(); return { ok }; }
  catch (err) { logf('removeTask error ' + err.message); return { ok: false, error: err.message }; }
});
// ---- Excel / CSV 导入导出 ----
function pad2(n) { return String(n).padStart(2, '0'); }
function normCell(v) { return String(v == null ? '' : v).replace(/\u00a0/g, ' ').trim(); }
function parseExcelDate(v) {
  let s = normCell(v);
  if (!s) return '';
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
  }
  s = s.replace(/[年月.\/]/g, '-').replace(/日/g, '');
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : '';
}
function parseTimeCell(v) {
  const m = normCell(v).match(/(\d{1,2}):(\d{2})/);
  return m ? `${pad2(m[1])}:${m[2]}` : '';
}
function parseDoneCell(v) {
  const s = normCell(v).toLowerCase();
  return ['已完成', '完成', '是', 'x', 'done', 'true', '1', '√'].includes(s);
}
function findcolumns(rows) {
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const cells = (rows[i] || []).map(normCell);
    const date = cells.findIndex((c) => /日期|截止|date|due/i.test(c));
    const text = cells.findIndex((c) => /内容|事项|任务|待办|text|task|title/i.test(c));
    if (date >= 0 && text >= 0) {
      return {
        head: i, date, text,
        time: cells.findIndex((c) => /时间|time/i.test(c)),
        status: cells.findIndex((c) => /状态|完成|status|done/i.test(c)),
        tags: cells.findIndex((c) => /标签|归口|tags?/i.test(c)),
      };
    }
  }
  return { head: -1, date: 0, time: 1, text: 2, status: 3, tags: 4 };
}
function parseImportedRows(rows) {
  const col = findcolumns(rows || []);
  const out = [];
  for (let i = col.head + 1; i < (rows || []).length; i++) {
    const r = rows[i] || [];
    const raw = normCell(r[col.text]);
    if (!raw) continue;
    const due = parseExcelDate(r[col.date]);
    const time = parseTimeCell(col.time >= 0 ? r[col.time] : '');
    const tags = normCell(col.tags >= 0 ? r[col.tags] : '')
      .split(/[\s,，、;；]+/).filter(Boolean);
    out.push({
      text: time ? `${time} ${raw}` : raw,
      due,
      done: parseDoneCell(col.status >= 0 ? r[col.status] : ''),
      tags,
    });
  }
  return out;
}
function taskRow(t) {
  const tm = String(t.text || '').match(/^(\d{1,2}:\d{2})\s+/);
  const body = tm ? String(t.text).slice(tm[0].length) : String(t.text || '');
  return [t.due || '', tm ? tm[1] : '', body, t.done ? '已完成' : '待办', (t.tags || []).join(' ')];
}
function excelFilters() {
  return [
    { name: 'Excel 工作簿 (*.xlsx)', extensions: ['xlsx'] },
    { name: 'CSV（Excel 可打开）(*.csv)', extensions: ['csv'] },
  ];
}
function tasksForExport(opts) {
  const all = store.tasks;
  if (!opts || !opts.mode || opts.mode === 'all') return all;
  if (opts.mode === 'dates') {
    const set = new Set((opts.dates || []).map(String));
    return all.filter((t) => set.has(t.due || ''));
  }
  if (opts.mode === 'range') {
    const from = String(opts.from || '');
    const to = String(opts.to || '');
    return all.filter((t) => {
      const d = t.due || '';
      if (!d) return false;
      return (!from || d >= from) && (!to || d <= to);
    });
  }
  return all;
}
ipcMain.handle('excel:export', async (e, target, opts) => {
  let file = target;
  if (!file) {
    const r = await dialog.showSaveDialog({
      title: '导出待办到 Excel',
      defaultPath: path.join(app.getPath('documents'), `月历待办-${fmtDay(new Date())}.xlsx`),
      filters: excelFilters(),
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    file = r.filePath;
  }
  if (!path.extname(file)) file += '.xlsx';
  const isCsv = path.extname(file).toLowerCase() === '.csv';
  if (!isCsv) file = file.replace(/\.[^.\\/]+$/, '.xlsx');
  const picked = tasksForExport(opts);
  const rows = [['日期', '时间', '事项', '状态', '标签'], ...picked.map(taskRow)];
  try {
    if (isCsv) fs.writeFileSync(file, toCsv(rows), 'utf8');
    else writeXlsx(file, rows);
    if (!target) shell.showItemInFolder(file);
    return { ok: true, file, count: picked.length };
  } catch (err) { logf('excel export error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.handle('excel:template', async () => {
  const r = await dialog.showSaveDialog({
    title: '下载 Excel 导入模板',
    defaultPath: path.join(app.getPath('documents'), '月历待办-导入模板.xlsx'),
    filters: excelFilters(),
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  let file = r.filePath;
  if (!path.extname(file)) file += '.xlsx';
  const isCsv = path.extname(file).toLowerCase() === '.csv';
  if (!isCsv) file = file.replace(/\.[^.\\/]+$/, '.xlsx');
  const rows = [
    ['日期', '时间', '事项', '状态', '标签'],
    [fmtDay(new Date()), '09:30', '示例：提交周报', '待办', '科技部'],
    [fmtDay(new Date()), '', '示例：整理客户资料', '已完成', '客户运营部'],
  ];
  try {
    if (isCsv) fs.writeFileSync(file, toCsv(rows), 'utf8');
    else writeXlsx(file, rows);
    shell.showItemInFolder(file);
    return { ok: true, file };
  } catch (err) { logf('excel template error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.handle('excel:import', async (e, source) => {
  let file = source;
  if (!file) {
    const r = await dialog.showOpenDialog({
      title: '选择 Excel / CSV 文件', properties: ['openFile'], filters: excelFilters(),
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    file = r.filePaths[0];
  }
  try {
    const rows = readTable(file);
    const items = parseImportedRows(rows);
    const seen = new Set(store.tasks.map((t) => `${t.due || ''}|${String(t.text || '').trim()}`));
    const fresh = items.filter((it) => {
      const k = `${it.due}|${it.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (fresh.length) { store.addTasks(fresh); broadcast(); }
    return { ok: true, total: items.length, imported: fresh.length, skipped: items.length - fresh.length, file };
  } catch (err) {
    logf('excel import error ' + err.message);
    return { ok: false, error: err.message };
  }
});

// ---- 提醒设置 ----
ipcMain.handle('reminder:get', () => ({ ...remindCfg }));
ipcMain.handle('reminder:set', (e, data) => {
  try {
    remindCfg = {
      enabled: data && data.enabled !== false,
      lead: Math.max(0, Number((data && data.lead) || 0)),
      allDayTime: /^\d{1,2}:\d{2}$/.test(String((data && data.allDayTime) || '')) ? data.allDayTime : '09:00',
    };
    saveRemindCfg();
    checkReminders(false);
    return { ok: true, ...remindCfg };
  } catch (err) { logf('reminder set error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.handle('reminder:test', () => {
  const t = { text: '这是一条测试提醒', due: fmtDay(new Date()), tags: [] };
  fireReminder(t, new Date());
  return { ok: true };
});
ipcMain.handle('reminder:clear', () => { notified = {}; saveNotified(); return { ok: true }; });

ipcMain.handle('rules:get', () => ({ rules }));
ipcMain.handle('rule:add', (e, data) => {
  try {
    const r = Object.assign({}, data || {});
    r.id = 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    r.enabled = r.enabled !== false;
    r.generated = {};
    rules.push(r);
    saveRules();
    generateRecurrences();
    return { ok: true, id: r.id };
  } catch (err) { logf('rule:add error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.handle('rule:update', (e, id, data) => {
  try {
    const r = rules.find((x) => x.id === id);
    if (!r) return { ok: false, error: '未找到规则' };
    const keepGenerated = r.generated;
    Object.assign(r, data || {});
    r.id = id;
    r.generated = keepGenerated || {};
    saveRules();
    generateRecurrences();
    return { ok: true };
  } catch (err) { logf('rule:update error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.handle('rule:remove', (e, id) => {
  try { rules = rules.filter((x) => x.id !== id); saveRules(); return { ok: true }; }
  catch (err) { logf('rule:remove error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.on('ui:collapse', (e, c) => setCollapsed(!!c));
ipcMain.on('ui:pin', (e, p) => setPin(!!p));
ipcMain.on('ui:hide', () => { if (win) win.hide(); });
ipcMain.handle('ui:resize', (e, delta) => ({ ok: true, height: resizeWindow(delta) }));
ipcMain.handle('clipboard:write', (e, text) => {
  try {
    const s = String(text || '');
    clipboard.writeText(s);
    logf('COPY chars=' + s.length + ' lines=' + s.split('\n').length + ' text=' + JSON.stringify(s.slice(0, 180)));
    return { ok: true };
  } catch (err) { logf('COPY error ' + err.message); return { ok: false, error: err.message }; }
});
ipcMain.handle('app:openVault', () => shell.openPath(VAULT));
ipcMain.handle('app:pickVault', () => pickVaultDir());
ipcMain.handle('app:state', () => ({ collapsed: cfg.collapsed, pinned: cfg.pinned }));

app.on('second-instance', () => {
  if (win) {
    if (cfg.collapsed) setCollapsed(false);
    ensureVisible('second-instance');
    win.show();
    win.focus();
  }
});
app.on('before-quit', () => { isQuitting = true; saveCfg(cfg); });

app.whenReady().then(() => {
  initStore();
  logf('ready vault=' + VAULT + ' tasks=' + store.tasks.length);
  createWindow();
  createTray();
  // 启动兜底：加载完成 2.6s 后仍未显示/仍在屏外，则拉回并显示
  setTimeout(() => { ensureVisible('startup'); }, 2600);
  setInterval(generateRecurrences, 10 * 60 * 1000);
  setInterval(() => checkReminders(false), 30 * 1000);
  // 外接显示器拔插后，把跑到屏外的窗口拉回来
  const onDisplayChange = () => setTimeout(() => ensureVisible('display-change'), 400);
  screen.on('display-removed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-metrics-changed', onDisplayChange);
});
