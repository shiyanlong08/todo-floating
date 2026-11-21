'use strict';
const $ = (id) => document.getElementById(id);
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

let tasks = [];
let rules = [];
let collapsed = false;
let viewY = 0;
let viewM = 0;
let selected = '';
let selectedDates = new Set();
let anchorDate = '';
let multiMode = false;
let yearKeyCache = '';
let calSize = 'auto'; // auto | compact | normal（自适应 / 紧凑 / 标准）
let dayNavIdx = -1;  // 下方任务面板当前高亮的任务下标
let stepIdx = -1;    // 跨日期切换待办时的全局下标

function pad(n) { return n < 10 ? '0' + n : String(n); }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return fmt(new Date()); }
function parseDay(s) {
  const p = String(s || '').split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  return p.length === 3 && !isNaN(d.getTime()) ? d : new Date();
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function timeOf(text) {
  const m = String(text || '').match(/^(\d{1,2}:\d{2})\s+/);
  return m ? { prefix: m[0], value: m[1] } : null;
}
function bodyText(text) {
  const t = timeOf(text);
  return t ? String(text).slice(t.prefix.length) : String(text || '');
}

function tip(el, msg, isErr, ms) {
  if (!el) return;
  el.textContent = msg;
  el.className = 'tip' + (isErr ? ' err' : '');
  clearTimeout(tip._t);
  tip._t = setTimeout(() => { el.textContent = ''; el.className = 'tip'; }, ms || 2800);
}
function showTip(msg, isErr) { tip($('saveTip'), msg, isErr, 2600); }
function ruleTip(msg, isErr) { tip($('ruTip'), msg, isErr, 3000); }
function rmTip(msg, isErr) { tip($('rmTip'), msg, isErr, 3200); }
function xlTip(msg, isErr) { tip($('xlTip'), msg, isErr, 4000); }

function collectYears() {
  const set = new Set();
  const nowY = new Date().getFullYear();
  for (let y = nowY - 8; y <= nowY + 8; y++) set.add(y);
  tasks.forEach((t) => { if (t.due) { const y = Number(String(t.due).slice(0, 4)); if (Number.isFinite(y)) set.add(y); } });
  rules.forEach((r) => { if (r.start) { const y = Number(String(r.start).slice(0, 4)); if (Number.isFinite(y)) set.add(y); } });
  return [...set].sort((a, b) => a - b);
}
function syncYearMonth() {
  const ys = collectYears();
  const k = ys.join(',');
  if (k !== yearKeyCache) {
    yearKeyCache = k;
    $('yearSel').innerHTML = ys.map((y) => `<option value="${y}">${y}</option>`).join('');
  }
  $('yearSel').value = String(viewY);
  if (!$('monthSel').options.length) {
    $('monthSel').innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i}">${i + 1}</option>`).join('');
  }
  $('monthSel').value = String(viewM);
}
function focusDate(key, clearOthers) {
  selected = key;
  anchorDate = key;
  if (clearOthers !== false) selectedDates = new Set([key]);
  else selectedDates.add(key);
  render();
}
function setView(y, m) {
  const last = new Date(y, m + 1, 0).getDate();
  const old = parseDay(selected);
  const day = Math.min(old.getDate() || 1, last);
  viewY = y;
  viewM = m;
  focusDate(`${y}-${pad(m + 1)}-${pad(day)}`, !multiMode);
}
function selectRange(a, b) {
  const d1 = parseDay(a), d2 = parseDay(b);
  const lo = d1 <= d2 ? d1 : d2;
  const hi = d1 <= d2 ? d2 : d1;
  const keys = [];
  for (const d = new Date(lo); d <= hi; d.setDate(d.getDate() + 1)) keys.push(fmt(d));
  selectedDates = new Set(keys);
  selected = b;
  anchorDate = b;
  multiMode = true;
  $('multiBtn').classList.add('on');
  render();
}

function isCompact() {
  if (calSize === 'compact') return true;
  if (calSize === 'normal') return false;
  // 自适应：多选多日或面板任务较多时压缩日历，把空间让给任务列表
  const shown = tasks.filter((t) => selectedDates.has(t.due || '')).length;
  return selectedDates.size > 1 || shown > 6;
}
function applyCalSize() {
  const compact = isCompact();
  document.body.classList.toggle('compact', compact);
  const label = { auto: '自适应', compact: '紧凑', normal: '标准' }[calSize];
  $('calSizeBtn').textContent = label;
  $('calSizeBtn').classList.toggle('on', compact);
  $('calSizeBtn').title = `日历大小：${label}（当前${compact ? '紧凑' : '标准'}，点击切换）`;
}
function selectedKeys() { return [...selectedDates].sort(); }

function copyLines() {
  const out = [];
  let count = 0, days = 0;
  for (const key of selectedKeys()) {
    const items = sortTasks(tasks.filter((t) => t.due === key));
    if (!items.length) continue;
    days++;
    const d = parseDay(key);
    out.push(`${key} 星期${WEEK[(d.getDay() + 6) % 7]}`);
    items.forEach((t, i) => {
      const tm = timeOf(t.text);
      const tags = (t.tags || []).filter((g) => g !== '周期').map((g) => '#' + g).join(' ');
      out.push('  ' + [t.done ? '[x]' : '[ ]', tm ? tm.value : '', bodyText(t.text), tags].filter(Boolean).join(' '));
      count++;
    });
  }
  return { text: out.join('\n'), count, days };
}
function copyTsv() {
  const rows = [['日期', '时间', '事项', '状态', '标签'].join('\t')];
  let count = 0;
  for (const key of selectedKeys()) {
    for (const t of sortTasks(tasks.filter((x) => x.due === key))) {
      const tm = timeOf(t.text);
      const tags = (t.tags || []).filter((g) => g !== '周期').join(' ');
      rows.push([key, tm ? tm.value : '', bodyText(t.text).replace(/\t/g, ' '), t.done ? '已完成' : '待办', tags].join('\t'));
      count++;
    }
  }
  return { text: rows.join('\r\n'), count };
}
async function doCopy(payload, okMsg) {
  if (!payload.count) { showTip('这些日期还没有任务可复制', true); return; }
  const r = await window.api.copyText(payload.text).catch(() => ({ ok: false }));
  showTip(r && r.ok ? okMsg : '复制失败，请重试', !(r && r.ok));
}

/* ---- 点数字看待办：顶部计数 / 月历格子条数 ---- */
let listScope = '';
let listAll = false;
let listIndex = -1; // 待办速览里当前高亮的条目下标
function openList(scope) {
  listScope = scope || '';
  listAll = false;
  listIndex = -1;
  $('listOvl').hidden = false;
  renderList();
}
function renderList() {
  if ($('listOvl').hidden) return;
  const scopeIsArray = Array.isArray(listScope) && listScope.length > 0;
  let list = tasks.filter((t) => {
    if (!listScope || (Array.isArray(listScope) && !listScope.length)) return true;
    return scopeIsArray ? listScope.includes(t.due) : t.due === listScope;
  });
  if (!listAll) list = list.filter((t) => !t.done);
  list = sortTasks(list);
  const d = parseDay(Array.isArray(listScope) ? listScope[0] : listScope);
  $('listTitle').textContent = scopeIsArray && listScope.length > 1
    ? `已选 ${listScope.length} 天的待办 · ${list.length} 条`
    : (listScope ? `${d.getMonth() + 1}月${d.getDate()}日的待办 · ${list.length} 条` : `待办速览 · ${list.length} 条`);
  $('listFilter').textContent = listAll ? '仅看未完成' : '显示全部';
  if (!list.length) {
    $('listBody').innerHTML = '<div class="rule-empty">没有符合条件的待办</div>';
    $('listPos').textContent = '';
    return;
  }
  if (listIndex < 0 || listIndex >= list.length) listIndex = 0;
  $('listBody').innerHTML = list.map((t) => {
    const key = t.due || '';
    const dd = parseDay(key);
    const dateLabel = key ? `${dd.getMonth() + 1}-${pad(dd.getDate())} 星期${WEEK[(dd.getDay() + 6) % 7]}` : '未定日期';
    const tm = timeOf(t.text);
    const tags = (t.tags || []).filter((g) => g !== '周期').map((g) => '#' + g).join(' ');
    return `<div class="lrow${t.done ? ' done' : ''}" data-id="${esc(t.id)}" data-date="${esc(key)}" title="点击跳到这条待办">
      <span class="lmark">${t.done ? '✓' : '○'}</span>
      <div class="lmain">
        <div class="ltext">${esc((tm ? tm.value + ' ' : '') + bodyText(t.text))}</div>
        <div class="lmeta">${dateLabel}${tags ? ' · ' + esc(tags) : ''}</div>
      </div>
      <button class="btn" data-act="edit">编辑</button>
    </div>`;
  }).join('');
  applyListFocus(false);
}
function listRows() { return [...$('listBody').querySelectorAll('.lrow')]; }
function applyListFocus(scroll) {
  const rows = listRows();
  if (!rows.length) { $('listPos').textContent = ''; return; }
  if (listIndex < 0) listIndex = 0;
  if (listIndex >= rows.length) listIndex = rows.length - 1;
  rows.forEach((r, i) => r.classList.toggle('cur', i === listIndex));
  $('listPos').textContent = `${listIndex + 1} / ${rows.length}`;
  if (scroll) {
    try { rows[listIndex].scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }
}
function navList(step) {
  if ($('listOvl').hidden) return;
  const rows = listRows();
  if (!rows.length) return;
  listIndex = ((listIndex < 0 ? 0 : listIndex) + step + rows.length) % rows.length;
  applyListFocus(true);
}
$('listPrev').addEventListener('click', () => navList(-1));
$('listNext').addEventListener('click', () => navList(1));
document.addEventListener('keydown', (e) => {
  if ($('listOvl').hidden) return;
  if (e.key === 'ArrowUp') { e.preventDefault(); navList(-1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); navList(1); }
  else if (e.key === 'Escape') { $('listOvl').hidden = true; }
});
function jumpToTask(id, key) {
  $('listOvl').hidden = true;
  if (key) selectDate(key, false, true);
  const row = [...$('dayList').querySelectorAll('.row')].find((r) => r.dataset.id === id);
  if (row) {
    try { row.scrollIntoView({ block: 'center' }); } catch (e) {}
    row.classList.add('focus');
    setTimeout(() => row.classList.remove('focus'), 2200);
  }
}
$('openCnt').addEventListener('click', () => openList(''));
$('dayCount').addEventListener('click', () => openList([...selectedDates]));
$('listClose').addEventListener('click', () => { $('listOvl').hidden = true; });
$('listOvl').addEventListener('click', (e) => { if (e.target === $('listOvl')) $('listOvl').hidden = true; });
$('listFilter').addEventListener('click', () => { listAll = !listAll; renderList(); });
$('listBody').addEventListener('click', (e) => {
  const row = e.target.closest('.lrow');
  if (!row) return;
  const task = tasks.find((t) => t.id === row.dataset.id);
  if (!task) return;
  if (e.target.closest('[data-act="edit"]')) {
    $('listOvl').hidden = true;
    openEditor(task);
  } else jumpToTask(task.id, row.dataset.date);
});

function render() {
  applyCalSize();
  renderCalendar();
  renderDay();
  const open = tasks.filter((t) => !t.done).length;
  $('openCnt').textContent = open;
  $('openCnt').classList.toggle('zero', open === 0);
  $('dot').classList.toggle('clear', open === 0);
}

function renderCalendar() {
  syncYearMonth();
  if (!$('weekdays').children.length) {
    WEEK.forEach((w, i) => {
      const s = document.createElement('span');
      s.textContent = w;
      if (i >= 5) s.className = 'wk';
      $('weekdays').appendChild(s);
    });
  }

  const first = new Date(viewY, viewM, 1);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(viewY, viewM + 1, 0).getDate();
  const total = Math.ceil((offset + days) / 7) * 7;
  const now = todayStr();
  let html = '';

  for (let i = 0; i < total; i++) {
    const d = new Date(viewY, viewM, 1 - offset + i);
    const key = fmt(d);
    const list = tasks.filter((t) => t.due === key);
    const cls = ['cell'];
    if (d.getMonth() !== viewM) cls.push('out');
    if (key === now) cls.push('today');
    if (selectedDates.has(key)) cls.push('sel');
    if (key === selected) cls.push('anchor');
    const dots = list.slice(0, 5).map((t) => `<span class="d${t.done ? ' done' : ''}"></span>`).join('');
    const count = list.length > 2 ? `<span class="ccount" data-date="${key}" title="点数字查看这天的 ${list.length} 条待办">${list.length}</span>` : '';
    html += `<div class="${cls.join(' ')}" data-date="${key}" title="${key} · ${list.length} 条"><span class="cnum">${d.getDate()}</span><span class="dots">${dots}</span>${count}</div>`;
  }
  $('cal').innerHTML = html;
}

function sortTasks(arr) {
  return arr.slice().sort((a, b) => {
    const ta = timeOf(a.text), tb = timeOf(b.text);
    const va = ta ? ta.value : '99:99';
    const vb = tb ? tb.value : '99:99';
    if (va !== vb) return va.localeCompare(vb);
    return Number(a.done) - Number(b.done);
  });
}
function rowHtml(t) {
  const tm = timeOf(t.text);
  const tags = (t.tags || []).filter((g) => g !== '周期').map((g) => `<span class="tag">#${esc(g)}</span>`).join('');
  return `<div class="row${t.done ? ' done' : ''}" data-id="${esc(t.id)}">
    <button class="chk" title="完成 / 重开">${t.done ? '<svg viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M6 11.2 2.4 7.6 1 9l5 5L15 4.6 13.6 3.2Z"/></svg>' : ''}</button>
    <div class="rmain">
      <div class="rtext">${esc(bodyText(t.text))}</div>
      <div class="rmeta">${tm ? `<span class="time" title="按此时间提醒">${esc(tm.value)}</span>` : ''}${tags}</div>
    </div>
    <button class="del" title="删除">&#215;</button>
  </div>`;
}
function renderDay() {
  dayNavIdx = -1;
  if (!selectedDates.size) selectedDates = new Set([selected]);
  const keys = [...selectedDates].sort();
  const multiple = keys.length > 1;
  $('clearSel').hidden = !multiple;
  if (multiple) {
    $('dayTitle').textContent = `已选 ${keys.length} 天`;
  } else {
    const d = parseDay(selected);
    $('dayTitle').textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[(d.getDay() + 6) % 7]}`;
  }
  const list = sortTasks(tasks.filter((t) => selectedDates.has(t.due || '')));
  $('dayCount').textContent = `${list.filter((t) => !t.done).length} 待办 · ${list.filter((t) => t.done).length} 完成`;

  if (!list.length) {
    $('dayList').innerHTML = `<div class="dempty">${multiple ? '这些日期还没有任务' : '这一天还没有任务'}<br>在下面输入，回车记下</div>`;
    return;
  }
  if (!multiple) {
    $('dayList').innerHTML = list.map(rowHtml).join('');
    return;
  }
  let html = '';
  for (const key of keys) {
    const d = parseDay(key);
    const items = sortTasks(tasks.filter((t) => t.due === key));
    html += `<div class="grp-date">${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[(d.getDay() + 6) % 7]} · ${items.length} 条</div>`;
    html += items.length ? items.map(rowHtml).join('') : '<div class="grp-empty">无任务</div>';
  }
  $('dayList').innerHTML = html;
}

function selectDate(key, focusInput, forceSingle) {
  stepIdx = -1;
  const d = parseDay(key);
  viewY = d.getFullYear();
  viewM = d.getMonth();
  focusDate(key, forceSingle || !multiMode);
  if (focusInput) { try { $('newInput').focus({ preventScroll: true }); } catch (e) {} }
}

$('cal').addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const key = cell.dataset.date;
  const badge = e.target.closest('.ccount');
  if (badge) { e.stopPropagation(); openList(key); return; }
  // 点日期数字：当天有任务时直接展开速览，没任务时仍按普通选中处理
  if (e.target.closest('.cnum') && !e.shiftKey && !e.ctrlKey && !e.metaKey && tasks.some((t) => t.due === key)) {
    openList(key);
    return;
  }
  if (e.shiftKey && anchorDate) {
    selectRange(anchorDate, key);
    return;
  }
  if (multiMode || e.ctrlKey || e.metaKey) {
    if (selectedDates.has(key) && selectedDates.size > 1) selectedDates.delete(key);
    else selectedDates.add(key);
    selected = key;
    anchorDate = key;
    render();
    return;
  }
  selectDate(key, true);
});
$('multiBtn').addEventListener('click', () => {
  multiMode = !multiMode;
  $('multiBtn').classList.toggle('on', multiMode);
  if (!multiMode && selectedDates.size > 1) {
    selectedDates = new Set([selected]);
    render();
  }
  showTip(multiMode ? '多选模式：点日期逐个选，Shift 连选' : '已回到单选');
});
$('clearSel').addEventListener('click', () => {
  selectedDates = new Set([selected]);
  multiMode = false;
  $('multiBtn').classList.remove('on');
  render();
});
$('calSizeBtn').addEventListener('click', () => {
  calSize = calSize === 'auto' ? 'compact' : calSize === 'compact' ? 'normal' : 'auto';
  applyCalSize();
  showTip('日历：' + ({ auto: '自适应', compact: '紧凑', normal: '标准' }[calSize]));
});
$('copyBtn').addEventListener('click', () => {
  const c = copyLines();
  doCopy(c, `已复制 ${c.count} 条 · ${c.days} 天`);
});
$('growBtn').addEventListener('click', () => window.api.resizeWindow(120).catch(() => {}));
$('shrinkBtn').addEventListener('click', () => window.api.resizeWindow(-120).catch(() => {}));
$('yearSel').addEventListener('change', (e) => setView(Number(e.target.value), viewM));
$('monthSel').addEventListener('change', (e) => setView(viewY, Number(e.target.value)));
function shiftMonth(step) {
  let y = viewY, m = viewM + step;
  if (m < 0) { m = 11; y--; }
  else if (m > 11) { m = 0; y++; }
  setView(y, m);
}
$('prevM').addEventListener('click', () => shiftMonth(-1));
$('nextM').addEventListener('click', () => shiftMonth(1));

// 鼠标放在日历/星期栏上滚轮：向上翻上月、向下翻下月（节流，避免一滚跳很多月）
let wheelLock = 0;
function onCalWheel(e) {
  if (Math.abs(e.deltaY) < 4) return;
  e.preventDefault();
  const now = Date.now();
  if (now - wheelLock < 260) return;
  wheelLock = now;
  shiftMonth(e.deltaY > 0 ? 1 : -1);
}
$('cal').addEventListener('wheel', onCalWheel, { passive: false });
$('weekdays').addEventListener('wheel', onCalWheel, { passive: false });
$('todayBtn').addEventListener('click', () => selectDate(todayStr(), false, true));

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('newInput').value.trim();
  if (!text) return;
  const res = await window.api.addTask(text, selected).catch(() => ({ ok: false }));
  if (res && res.ok) {
    $('newInput').value = '';
    showTip('已保存到 ' + selected.slice(5));
  } else showTip('保存失败，文件可能被占用', true);
});

$('dayList').addEventListener('click', async (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const task = tasks.find((t) => t.id === row.dataset.id);
  if (!task) return;
  if (e.target.closest('.chk')) {
    const res = await window.api.toggleTask(task.id).catch(() => ({ ok: false }));
    if (!res || !res.ok) showTip('勾选失败，请重试', true);
    return;
  }
  if (e.target.closest('.del')) {
    const res = await window.api.removeTask(task.id).catch(() => ({ ok: false }));
    if (res && res.ok) showTip('已删除'); else showTip('删除失败', true);
    return;
  }
  openEditor(task);
});

/* ---- 编辑浮层 ---- */
let editingId = null;
function openEditor(task) {
  editingId = task.id;
  const tm = timeOf(task.text);
  $('edText').value = bodyText(task.text);
  $('edTime').value = tm ? tm.value : '';
  $('edDue').value = task.due || selected;
  $('edTags').value = (task.tags || []).filter((g) => g !== '周期').join(' ');
  $('edTip').textContent = '';
  $('edOvl').hidden = false;
}
function closeEditor() { editingId = null; $('edOvl').hidden = true; }
async function saveEditor() {
  if (!editingId) return;
  const text = $('edText').value.trim();
  if (!text) { $('edTip').textContent = '内容不能为空'; $('edTip').className = 'tip err'; return; }
  const task = tasks.find((t) => t.id === editingId);
  const time = $('edTime').value;
  const due = $('edDue').value || null;
  const tags = $('edTags').value.trim().split(/\s+/).filter(Boolean);
  if (task && (task.tags || []).includes('周期')) tags.push('周期');
  const res = await window.api.updateTask(editingId, {
    text: (time ? time + ' ' : '') + text,
    due,
    tags: [...new Set(tags)],
  }).catch(() => ({ ok: false }));
  if (res && res.ok) { closeEditor(); showTip('已更新'); }
  else { $('edTip').textContent = '保存失败，请重试'; $('edTip').className = 'tip err'; }
}
$('edSave').addEventListener('click', saveEditor);
$('edCancel').addEventListener('click', closeEditor);
$('edOvl').addEventListener('click', (e) => { if (e.target === $('edOvl')) closeEditor(); });
[$('edText'), $('edTags')].forEach((el) => el.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveEditor(); }
  if (e.key === 'Escape') closeEditor();
}));

/* ---- 定时 / 重复规则 ---- */
function syncRuleFields() {
  const type = $('ruType').value;
  $('ruWeekday').style.display = type === 'weekly' ? 'block' : 'none';
  $('ruMonthday').style.display = type === 'monthly' ? 'block' : 'none';
  $('ruInterval').style.display = type === 'interval' ? 'block' : 'none';
}
$('ruType').addEventListener('change', syncRuleFields);
function ruleLabel(r) {
  const map = { once: '指定日', daily: '每天', weekly: '每周', monthly: '每月', interval: '间隔' };
  let extra = '';
  if (r.type === 'weekly') extra = '周' + WEEK[Number(r.weekday) || 0];
  if (r.type === 'monthly') extra = (Number(r.monthday) || 1) + '日';
  if (r.type === 'interval') extra = '每' + (Number(r.interval) || 1) + '天';
  if (r.type === 'once') extra = String(r.start || '').slice(5);
  return `${map[r.type] || r.type} ${extra}${r.time ? ' ' + r.time : ''}`;
}
function renderRules() {
  if (!$('ruleList')) return;
  if (!rules.length) { $('ruleList').innerHTML = '<div class="rule-empty">还没有规则</div>'; return; }
  $('ruleList').innerHTML = rules.map((r) => `<div class="rule-item" data-id="${esc(r.id)}">
    <span>${esc(r.text)}</span><em>${esc(ruleLabel(r))}</em><button class="del" title="删除规则">&#215;</button>
  </div>`).join('');
}
async function refreshRules() {
  const p = await window.api.getRules().catch(() => ({ rules: [] }));
  rules = (p && p.rules) || [];
  renderRules();
  syncYearMonth();
}
$('btnRepeat').addEventListener('click', async () => {
  $('ruleOvl').hidden = false;
  syncRuleFields();
  if (!$('ruStart').value) $('ruStart').value = selected;
  await refreshRules();
});
$('ruClose').addEventListener('click', () => { $('ruleOvl').hidden = true; });
$('ruleOvl').addEventListener('click', (e) => { if (e.target === $('ruleOvl')) $('ruleOvl').hidden = true; });
$('ruSave').addEventListener('click', async () => {
  const text = $('ruText').value.trim();
  if (!text) { ruleTip('请填写任务内容', true); return; }
  const rule = {
    text,
    type: $('ruType').value,
    time: $('ruTime').value || '',
    start: $('ruStart').value || todayStr(),
    weekday: Number($('ruWeekday').value) || 0,
    monthday: Number($('ruMonthday').value) || 1,
    interval: Number($('ruInterval').value) || 1,
    enabled: true,
  };
  const res = await window.api.addRule(rule).catch(() => ({ ok: false }));
  if (res && res.ok) {
    $('ruText').value = '';
    ruleTip('已添加，未来 60 天任务已生成');
    await refreshRules();
  } else ruleTip('添加失败', true);
});
$('ruleList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.del');
  if (!btn) return;
  const item = btn.closest('.rule-item');
  const res = await window.api.removeRule(item.dataset.id).catch(() => ({ ok: false }));
  if (res && res.ok) { ruleTip('规则已删除'); await refreshRules(); }
  else ruleTip('删除失败', true);
});

/* ---- 到期提醒设置 ---- */
$('btnReminder').addEventListener('click', async () => {
  const c = await window.api.getReminder().catch(() => ({}));
  $('rmEnabled').checked = c.enabled !== false;
  $('rmLead').value = String(Number(c.lead) || 0);
  $('rmAllDay').value = c.allDayTime || '09:00';
  $('rmOvl').hidden = false;
  rmTip('');
});
$('rmSave').addEventListener('click', async () => {
  const res = await window.api.setReminder({
    enabled: $('rmEnabled').checked,
    lead: Number($('rmLead').value) || 0,
    allDayTime: $('rmAllDay').value || '09:00',
  }).catch(() => ({ ok: false }));
  if (res && res.ok) rmTip('提醒设置已保存'); else rmTip('保存失败', true);
});
$('rmTest').addEventListener('click', async () => {
  const res = await window.api.testReminder().catch(() => ({ ok: false }));
  rmTip(res && res.ok ? '测试提醒已发出' : '发送失败', !(res && res.ok));
});
$('rmClear').addEventListener('click', async () => {
  const res = await window.api.clearReminders().catch(() => ({ ok: false }));
  rmTip(res && res.ok ? '记录已清空，当前到期事项会重新提醒' : '清空失败', !(res && res.ok));
});
$('rmOvl').addEventListener('click', (e) => { if (e.target === $('rmOvl')) $('rmOvl').hidden = true; });

function showToast(r) {
  if (!r) return;
  $('toastTitle').textContent = r.title || '待办到期提醒';
  $('toastBody').textContent = r.body || '';
  $('toast').hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { $('toast').hidden = true; }, 9000);
}
$('toastClose').addEventListener('click', () => { $('toast').hidden = true; });
window.api.onReminder(showToast);

/* ---- Excel 导入导出 ---- */
function syncXlScope() {
  const mode = $('xlScope').value;
  $('xlRange').hidden = mode !== 'range';
  const notes = {
    all: '导出范围：全部任务',
    sel: `导出范围：当前选中的 ${selectedDates.size} 天`,
    range: '导出范围：指定日期段（含起止当天）',
  };
  $('xlScopeNote').textContent = notes[mode] || notes.all;
}
$('xlScope').addEventListener('change', syncXlScope);
$('btnExcel').addEventListener('click', () => {
  const keys = [...selectedDates].sort();
  $('xlFrom').value = keys[0] || todayStr();
  $('xlTo').value = keys[keys.length - 1] || todayStr();
  syncXlScope();
  $('xlOvl').hidden = false;
  xlTip('');
});
$('xlClose').addEventListener('click', () => { $('xlOvl').hidden = true; });
$('xlOvl').addEventListener('click', (e) => { if (e.target === $('xlOvl')) $('xlOvl').hidden = true; });
$('xlExport').addEventListener('click', async () => {
  const opts = {
    mode: $('xlScope').value,
    dates: [...selectedDates],
    from: $('xlFrom').value,
    to: $('xlTo').value,
  };
  const r = await window.api.exportExcel(undefined, opts).catch(() => ({ ok: false }));
  if (r && r.ok) xlTip(`已导出 ${r.count} 条事项`);
  else if (r && r.canceled) xlTip('已取消');
  else xlTip('导出失败：' + ((r && r.error) || '未知错误'), true);
});
$('xlImport').addEventListener('click', async () => {
  const r = await window.api.importExcel().catch(() => ({ ok: false }));
  if (r && r.ok) xlTip(`导入 ${r.imported} 条，跳过 ${r.skipped} 条重复/空行`);
  else if (r && r.canceled) xlTip('已取消');
  else xlTip('导入失败：' + ((r && r.error) || '未知错误'), true);
});
$('xlCopyTable').addEventListener('click', () => {
  const c = copyTsv();
  doCopy(c, `已复制表格 ${c.count} 行，可直接粘贴到 Excel`);
});
$('xlTemplate').addEventListener('click', async () => {
  const r = await window.api.excelTemplate().catch(() => ({ ok: false }));
  if (r && r.ok) xlTip('模板已下载');
  else if (r && r.canceled) xlTip('已取消');
  else xlTip('下载失败：' + ((r && r.error) || '未知错误'), true);
});

/* ---- 主面板箭头 ---- */
function dayRows() { return [...$('dayList').querySelectorAll('.row')]; }
function navDay(step) {
  const rows = dayRows();
  if (!rows.length) { showTip('当前没有待办可切换', true); return; }
  dayNavIdx = ((dayNavIdx < 0 ? (step > 0 ? -1 : 0) : dayNavIdx) + step + rows.length) % rows.length;
  rows.forEach((r, i) => r.classList.toggle('focus', i === dayNavIdx));
  try { rows[dayNavIdx].scrollIntoView({ block: 'nearest' }); } catch (e) {}
}
$('taskPrev').addEventListener('click', () => navDay(-1));   // ‹ › 当天待办切换
$('taskNext').addEventListener('click', () => navDay(1));

// ↓ ↑ 跨日期切换：按日期+时间遍历全部待办，跳到对应日期并高亮该条
function allSortedTasks() {
  return tasks.slice().sort((a, b) => {
    const da = a.due || '9999', db = b.due || '9999';
    if (da !== db) return da.localeCompare(db);
    const ta = timeOf(a.text), tb = timeOf(b.text);
    const va = ta ? ta.value : '99:99', vb = tb ? tb.value : '99:99';
    return va.localeCompare(vb) || (Number(a.done) - Number(b.done));
  });
}
function stepTask(step) {
  const list = allSortedTasks();
  if (!list.length) { showTip('还没有待办可切换', true); return; }
  if (stepIdx < 0 || stepIdx >= list.length) {
    // 从当前选中日期附近开始：找到第一项日期 >= selected 的待办
    let i = list.findIndex((t) => (t.due || '') >= selected);
    if (i < 0) i = list.length - 1;
    stepIdx = i - (step > 0 ? 1 : 0); // 这样下一步 step 会落到 i
  }
  stepIdx = (stepIdx + step + list.length) % list.length;
  const t = list[stepIdx];
  const key = t.due || selected;
  if (t.due && parseDay(t.due).getMonth() !== viewM) {
    const d = parseDay(t.due);
    viewY = d.getFullYear(); viewM = d.getMonth();
  }
  selected = key; anchorDate = key; selectedDates = new Set([key]); multiMode = false;
  $('multiBtn').classList.remove('on');
  render();
  const row = dayRows().find((r) => r.dataset.id === t.id);
  if (row) {
    dayNavIdx = dayRows().indexOf(row);
    row.classList.add('focus');
    try { row.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    clearTimeout(stepTask._t);
    stepTask._t = setTimeout(() => row.classList.remove('focus'), 2400);
  }
  const d = parseDay(key);
  showTip(`待办 ${stepIdx + 1}/${list.length} · ${d.getMonth() + 1}月${d.getDate()}日 · ${bodyText(t.text).slice(0, 12)}`);
}
$('stepPrev').addEventListener('click', () => stepTask(-1)); // ↑ 上一个待办
$('stepNext').addEventListener('click', () => stepTask(1));  // ↓ 下一个待办

/* ---- 窗口控制 ---- */
$('btnCollapse').addEventListener('click', () => window.api.setCollapsed(!collapsed));
$('btnPin').addEventListener('click', () => {
  const on = !$('btnPin').classList.contains('on');
  $('btnPin').classList.toggle('on', on);
  window.api.setPin(on);
});
$('btnHide').addEventListener('click', () => window.api.hide());

window.api.onTasks((p) => { if (p && Array.isArray(p.tasks)) { tasks = p.tasks; render(); renderList(); } });
window.api.onState((s) => {
  if (!s) return;
  collapsed = !!s.collapsed;
  document.body.classList.toggle('collapsed', collapsed);
  $('btnPin').classList.toggle('on', !!s.pinned);
});

(async () => {
  const now = new Date();
  viewY = now.getFullYear();
  viewM = now.getMonth();
  selected = todayStr();
  selectedDates = new Set([selected]);
  anchorDate = selected;
  const p = await window.api.getTasks().catch(() => ({ tasks: [] }));
  tasks = (p && p.tasks) || [];
  const s = await window.api.getState().catch(() => ({}));
  if (s) {
    collapsed = !!s.collapsed;
    document.body.classList.toggle('collapsed', collapsed);
    $('btnPin').classList.toggle('on', !!s.pinned);
  }
  const open = tasks.filter((t) => !t.done).length;
  $('openCnt').textContent = open;
  $('openCnt').classList.toggle('zero', open === 0);
  $('dot').classList.toggle('clear', open === 0);
  render();
  refreshRules();
})();
