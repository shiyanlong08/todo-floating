'use strict';
const fs = require('fs');
const path = require('path');

const TASK_RE = /^(\s*(?:[-*]|\d+\.)\s+)\[([ xX])\](.*)$/;
const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const TAG_RE = /#([\p{L}\p{N}_\-]+)/gu;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {}
}

function withRetry(fn, tries, delay) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return fn(); } catch (e) { lastErr = e; if (i < tries - 1) sleepSync(delay); }
  }
  throw lastErr;
}

function saveFileSafe(abs, content) {
  try {
    withRetry(() => fs.writeFileSync(abs, content, 'utf8'), 4, 250);
    return;
  } catch (err) {}
  const tmp = abs + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, abs);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) {}
    throw err;
  }
}

class VaultTasks {
  constructor(vault, sources, inboxRel) {
    this.vault = vault;
    this.sources = sources;
    this.inboxRel = inboxRel;
    this.tasks = [];
    this.lastScan = null;
    this._watchers = [];
    this._timer = null;
    this._onChange = null;
  }

  resolve(p) { return path.join(this.vault, p); }

  walk(dir, out) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) this.walk(full, out);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  }

  collectFiles() {
    const files = [];
    for (const s of this.sources) {
      const abs = this.resolve(s.path);
      if (s.type === 'dir') this.walk(abs, files);
      else if (fs.existsSync(abs)) files.push(abs);
    }
    return files.filter((f) => !/模板|\.obsidian/.test(path.basename(f)));
  }

  parseLine(line, fileAbs, lineNo) {
    const m = line.match(TASK_RE);
    if (!m) return null;
    const rest = m[3].trim();
    if (!rest) return null;
    const dueM = rest.match(DUE_RE);
    const tags = (rest.match(TAG_RE) || []).map((t) => t.slice(1));
    const done = m[2].toLowerCase() === 'x';
    return {
      id: `${fileAbs}|${lineNo}`,
      file: fileAbs,
      fileShort: path.relative(this.vault, fileAbs).replace(/\\/g, '/'),
      lineNo,
      text: rest.replace(DUE_RE, '').replace(TAG_RE, '').replace(/\s+/g, ' ').trim(),
      due: dueM ? dueM[1] : null,
      dueRaw: dueM ? dueM[0] : null,
      tags,
      done,
    };
  }

  rescan() {
    const tasks = [];
    for (const f of this.collectFiles()) {
      let lines = [];
      try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); } catch (e) { continue; }
      lines.forEach((line, i) => {
        const t = this.parseLine(line, f, i);
        if (t) tasks.push(t);
      });
    }
    this.tasks = tasks;
    this.lastScan = new Date().toISOString();
    return this.tasks;
  }

  locateLine(id) {
    const idx = id.lastIndexOf('|');
    const file = id.slice(0, idx);
    const lineNo = Number(id.slice(idx + 1));
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const target = this.tasks.find((t) => t.id === id);
    const wantText = target ? target.text : null;
    let hit = lineNo;
    if (wantText) {
      const cur = this.parseLine(lines[lineNo] || '', file, lineNo);
      if (!cur || cur.text !== wantText) {
        hit = -1;
        for (let i = Math.max(0, lineNo - 5); i <= Math.min(lines.length - 1, lineNo + 5); i++) {
          const p = this.parseLine(lines[i] || '', file, i);
          if (p && p.text === wantText) { hit = i; break; }
        }
        if (hit < 0) return null;
      }
    } else {
      const cur = this.parseLine(lines[lineNo] || '', file, lineNo);
      if (!cur) return null;
    }
    return { file, hit, lines };
  }

  toggleTask(id) {
    const loc = this.locateLine(id);
    if (!loc) { this.rescan(); return false; }
    const line = loc.lines[loc.hit];
    loc.lines[loc.hit] = line.includes('[ ]') ? line.replace('[ ]', '[x]') : line.replace(/\[x\]/i, '[ ]');
    saveFileSafe(loc.file, loc.lines.join('\n'));
    this.rescan();
    return true;
  }

  setTaskDue(id, due) {
    const loc = this.locateLine(id);
    if (!loc) { this.rescan(); return false; }
    const raw = loc.lines[loc.hit];
    const m = raw.match(TASK_RE);
    if (!m) { this.rescan(); return false; }
    const indentBox = m[1];
    const box = m[2];
    let rest = m[3].replace(DUE_RE, '').replace(/\s+/g, ' ').trim();
    if (due) rest = rest ? `${rest} 📅${due}` : `📅${due}`;
    loc.lines[loc.hit] = `${indentBox}[${box}]${rest ? ' ' + rest : ''}`;
    saveFileSafe(loc.file, loc.lines.join('\n'));
    this.rescan();
    return true;
  }

  updateTask(id, { text, due, tags } = {}) {
    const loc = this.locateLine(id);
    if (!loc) { this.rescan(); return false; }
    const raw = loc.lines[loc.hit];
    const m = raw.match(TASK_RE);
    if (!m) { this.rescan(); return false; }
    const indentBox = m[1];
    const box = m[2];
    // 剥掉旧的截止与归口部门标签（保留其它 #标签，避免误伤）
    let rest = m[3]
      .replace(DUE_RE, '')
      .replace(/#(科技部|理赔部|客户运营部)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const newTags = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean);
    const parts = [];
    if (typeof text === 'string' && text.trim()) parts.push(text.trim());
    for (const tg of newTags) parts.push('#' + tg);
    if (due) parts.push('📅' + due);
    const newRest = parts.join(' ');
    loc.lines[loc.hit] = `${indentBox}[${box}]${newRest ? ' ' + newRest : ''}`;
    saveFileSafe(loc.file, loc.lines.join('\n'));
    this.rescan();
    return true;
  }

  addTask(text, due) {
    return this.addTasks([{ text, due }]);
  }

  addTasks(items) {
    const abs = this.resolve(this.inboxRel);
    let content = '';
    if (fs.existsSync(abs)) {
      content = fs.readFileSync(abs, 'utf8');
      if (content.length && !content.endsWith('\n')) content += '\n';
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      content = '# 速记待办（桌面待办悬浮 · 快捷新增）\n\n> 随手记临时事项；会议纪要待办请写进对应纪要的"任务清单"节。\n\n## 临时任务\n\n';
    }
    const lines = items.filter((it) => it && String(it.text || '').trim()).map((it) => {
      let text = String(it.text).trim();
      const tags = (Array.isArray(it.tags) ? it.tags : [])
        .map((t) => String(t).trim()).filter(Boolean);
      if (tags.length) text += ' ' + tags.map((t) => '#' + t).join(' ');
      const due = it.due ? String(it.due).trim() : '';
      const mark = it.done ? '[x]' : '[ ]';
      return `- ${mark} ${text}${due ? ' 📅' + due : ''}` + '\n';
    }).join('');
    if (lines) saveFileSafe(abs, content + lines);
    this.rescan();
    return true;
  }

  removeTask(id) {
    const loc = this.locateLine(id);
    if (!loc) { this.rescan(); return false; }
    loc.lines.splice(loc.hit, 1);
    saveFileSafe(loc.file, loc.lines.join('\n'));
    this.rescan();
    return true;
  }

  watch(cb) {
    this._onChange = cb;
    for (const w of this._watchers) { try { w.close(); } catch (e) {} }
    this._watchers = [];
    const schedule = () => {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => { this.rescan(); cb && cb(this.tasks); }, 300);
    };
    for (const s of this.sources) {
      const abs = this.resolve(s.path);
      try {
        if (s.type === 'dir') {
          const w = fs.watch(abs, { recursive: true }, schedule);
          this._watchers.push(w);
        } else {
          const w = fs.watch(path.dirname(abs), (ev, fn) => { if (fn === path.basename(abs)) schedule(); });
          this._watchers.push(w);
        }
      } catch (e) {}
    }
  }
}

module.exports = { VaultTasks, todayStr };
