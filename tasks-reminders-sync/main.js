'use strict';

/**
 * 任务同步提醒事项（tasks-reminders-sync）
 *
 * 数据来源：obsidian-tasks-plugin 缓存（getTasks / getState / apiV1）
 * 同步目标：macOS 提醒事项专用列表（默认「Obsidian」）
 * 同步通道：同目录下的 reminders-helper（Swift/EventKit 编译产物），
 *           支持写提醒的 URL 字段（AppleScript 字典无此属性）
 * 同步语义：完成状态双向同步；任务名称、日期与删除以 Obsidian 为准
 *           （Obsidian 中删除任务 → 删除对应提醒；提醒事项中删除 → 记墓碑不再重建）
 */

const { Plugin, PluginSettingTab, Setting, Notice, TFile } = require('obsidian');

const DEFAULT_SETTINGS = {
  listName: 'Obsidian',
  autoSyncMinutes: 10,
  syncOnLaunch: true,
  // 排除路径：每行一个目录前缀，命中即不同步
  excludePaths:
    '000-Database/04-template\n' +
    '000-Database/06-AI/6A1-提示词\n' +
    '000-Database/06-AI/6A2-Agent\n' +
    '000-Database/06-AI/6A3-Skills',
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function statusType(task) {
  try { return String((task.status && task.status.type) || 'TODO'); } catch (e) { return 'TODO'; }
}
function isOpen(task) {
  const t = statusType(task);
  return t === 'TODO' || t === 'IN_PROGRESS';
}

// 任务唯一键：路径 + 清洗后描述 的 djb2 哈希（不依赖行号，行号会随编辑漂移）
function taskKey(task) {
  const s = String(task.path || '') + '\n' + cleanDesc(task);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'k' + h.toString(36);
}

// 清洗任务描述：去掉 wiki/md 链接语法，压平空白
function cleanDesc(task) {
  let s = String(task.description || '').trim();
  s = s.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 200);
}

// 截止日期：优先 due，其次 scheduled
function dueOf(task) {
  const d = task.dueDate || task.scheduledDate || null;
  if (d && typeof d.format === 'function') {
    try { return d.format('YYYY-MM-DD'); } catch (e) { /* ignore */ }
  }
  return null;
}

// 提取任务标签：优先 Tasks 插件解析结果，兜底从清洗后描述中正则提取
function tagsOf(task) {
  let tags = [];
  try {
    if (Array.isArray(task.tags) && task.tags.length) tags = task.tags;
  } catch (e) { /* ignore */ }
  if (!tags.length) {
    tags = cleanDesc(task).match(/#[\p{L}\p{N}_/-]+/gu) || [];
  }
  return [...new Set(tags.map((t) => (t.startsWith('#') ? t : '#' + t)))];
}

// 提醒标题 = 任务描述 + 确保所有 #标签 出现在标题中（提醒事项只把标题里的井号文字转成真正的标签）
function titleOf(task) {
  let title = cleanDesc(task);
  for (const t of tagsOf(task)) {
    if (!title.includes(t)) title += ' ' + t;
  }
  return title.slice(0, 250);
}

// 路径是否命中排除规则（目录前缀匹配）
function isExcludedPath(taskPath, excludeStr) {
  const rules = String(excludeStr || '')
    .split('\n')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return rules.some((r) => taskPath === r || taskPath.startsWith(r + '/'));
}

// ---------------------------------------------------------------------------
// 主插件
// ---------------------------------------------------------------------------

module.exports = class TasksRemindersSyncPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.mappings = {};      // taskKey -> { rid, path, desc, due }
    this.tombstones = [];    // 用户在提醒事项中删除的任务 key，不再重建
    this.lastSyncAt = 0;
    this.syncing = false;
    await this.loadAll();

    this.addRibbonIcon('check-square', '同步任务到提醒事项', () => this.syncNow('manual'));

    this.addCommand({
      id: 'sync-now',
      name: '立即同步到提醒事项',
      callback: () => this.syncNow('manual'),
    });
    this.addCommand({
      id: 'clear-tombstones',
      name: '清除「不再重建」记录（墓碑）',
      callback: async () => {
        this.tombstones = [];
        await this.saveAll();
        new Notice('已清除墓碑记录，下次同步将重新创建所有未完成任务对应的提醒。');
      },
    });

    this.addSettingTab(new SyncSettingTab(this.app, this));

    // 启动后自动同步：等待 Tasks 缓存就绪（最多等 60 秒）
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.syncOnLaunch) return;
      let waited = 0;
      const timer = setInterval(() => {
        const tp = this.tasksPlugin();
        if (tp && tp.getState && tp.getState() === 'Warm') {
          clearInterval(timer);
          this.syncNow('launch');
        } else if ((waited += 2000) >= 60000) {
          clearInterval(timer);
          console.warn('[tasks-reminders-sync] 等待 Tasks 缓存超时，跳过启动同步');
        }
      }, 2000);
    });

    // 定时自动同步
    this.registerInterval(window.setInterval(() => {
      const mins = this.settings.autoSyncMinutes;
      if (mins > 0 && Date.now() - this.lastSyncAt >= mins * 60000) {
        this.syncNow('auto');
      }
    }, 60000));
  }

  tasksPlugin() {
    const plugins = this.app.plugins && this.app.plugins.plugins;
    return plugins ? plugins['obsidian-tasks-plugin'] : null;
  }

  async loadAll() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    this.mappings = data.mappings || {};
    this.tombstones = data.tombstones || [];
  }

  async saveAll() {
    await this.saveData({
      settings: this.settings,
      mappings: this.mappings,
      tombstones: this.tombstones,
    });
  }

  // -------------------------------------------------------------------------
  // EventKit 辅助程序调用
  // -------------------------------------------------------------------------
  helperPaths() {
    const base = this.app.vault.adapter.getBasePath();
    const dir = this.manifest.dir;
    return {
      bin: base + '/' + dir + '/reminders-helper',
      src: base + '/' + dir + '/reminders-helper.swift',
    };
  }

  // 确保辅助程序存在；缺失时尝试用 swiftc 现场编译
  async ensureHelper() {
    const fs = require('fs');
    const { bin, src } = this.helperPaths();
    if (fs.existsSync(bin)) return true;
    if (!fs.existsSync(src)) return false;
    await new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('swiftc', ['-O', src, '-o', bin], { timeout: 180000 }, (err) => {
        if (err) console.error('[tasks-reminders-sync] 编译辅助程序失败', err);
        resolve();
      });
    });
    return fs.existsSync(bin);
  }

  runHelper(payload) {
    return new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      const { bin } = this.helperPaths();
      execFile(bin, [JSON.stringify(payload || {})], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr || err.message || '辅助程序调用失败').trim()));
          return;
        }
        try {
          const res = JSON.parse(String(stdout).trim());
          if (res && res.fatal) {
            if (res.fatal === 'denied') {
              reject(new Error('没有提醒事项访问权限，请在 系统设置 → 隐私与安全性 → 提醒事项 中允许 Obsidian'));
            } else {
              reject(new Error(String(res.fatal)));
            }
          } else {
            resolve(res);
          }
        } catch (e) {
          reject(new Error('解析辅助程序返回失败：' + String(stdout).slice(0, 200)));
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // 回写 Obsidian：把任务行标记为完成（优先走 Tasks 插件的 toggle，保留其格式设置）
  // -------------------------------------------------------------------------
  async completeTaskInFile(task) {
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) return false;
    const lines = (await this.app.vault.read(file)).split('\n');

    let idx = task.taskLocation ? task.taskLocation.lineNumber : -1;
    if (idx < 0 || lines[idx] !== task.originalMarkdown) {
      idx = lines.indexOf(task.originalMarkdown);
    }
    if (idx < 0) {
      const probe = cleanDesc(task).slice(0, 30);
      idx = probe ? lines.findIndex((l) => /- \[[ x/]\]/i.test(l) && l.includes(probe)) : -1;
    }
    if (idx < 0) return false;

    let newLine = null;
    try {
      const api = this.tasksPlugin() && this.tasksPlugin().apiV1;
      if (api && api.executeToggleTaskDoneCommand) {
        const res = api.executeToggleTaskDoneCommand(lines[idx], task.path);
        newLine = typeof res === 'string' ? res : (res && res.text) || null;
      }
    } catch (e) {
      console.error('[tasks-reminders-sync] apiV1 toggle 失败，使用兜底格式', e);
    }
    if (!newLine) {
      const today = window.moment().format('YYYY-MM-DD');
      newLine = lines[idx].replace(/- \[.\]/, '- [x]') + ' ✅ ' + today;
    }
    if (!newLine || newLine === lines[idx]) return false;

    lines[idx] = newLine;
    await this.app.vault.modify(file, lines.join('\n'));
    return true;
  }

  obsidianUri(task) {
    const vault = encodeURIComponent(this.app.vault.getName());
    const file = encodeURIComponent(task.path);
    return `obsidian://open?vault=${vault}&file=${file}`;
  }

  // -------------------------------------------------------------------------
  // 同步主流程
  // -------------------------------------------------------------------------
  async syncNow(reason) {
    if (this.syncing) return;
    this.syncing = true;
    this.lastSyncAt = Date.now();
    const manual = reason === 'manual';
    try {
      await this._sync(manual);
    } catch (e) {
      console.error('[tasks-reminders-sync] 同步失败', e);
      new Notice('任务同步失败：' + e.message, 8000);
    } finally {
      this.syncing = false;
    }
  }

  async _sync(manual) {
    const tp = this.tasksPlugin();
    if (!tp || typeof tp.getTasks !== 'function') {
      throw new Error('未检测到 Tasks 插件（obsidian-tasks-plugin），请先安装并启用');
    }
    // 缓存未就绪时 getTasks 可能返回空数组，绝不能据此完成全部提醒
    if (tp.getState && tp.getState() !== 'Warm') {
      console.log('[tasks-reminders-sync] Tasks 缓存未就绪，跳过本次同步');
      return;
    }
    if (!(await this.ensureHelper())) {
      throw new Error('辅助程序 reminders-helper 缺失且无法编译，请检查插件目录');
    }

    const tasks = tp.getTasks() || [];
    const byKey = new Map();
    for (const t of tasks) {
      // 排除路径中的任务不参与同步；已有映射会因任务“消失”而被完成清理
      if (isExcludedPath(String(t.path || ''), this.settings.excludePaths)) continue;
      const k = taskKey(t);
      if (!byKey.has(k)) byKey.set(k, t);
    }

    const read = await this.runHelper({ action: 'read', listName: this.settings.listName });
    const reminders = new Map((read.reminders || []).map((r) => [r.id, r]));
    const byNotes = new Map();
    for (const r of read.reminders || []) {
      if (r.notes && !byNotes.has(r.notes)) byNotes.set(r.notes, r);
    }

    let created = 0, updated = 0, completed = 0, deleted = 0, pulled = 0, tombstoned = 0;
    const ops = { action: 'apply', listName: this.settings.listName, create: [], update: [], complete: [], delete: [] };
    const tomb = new Set(this.tombstones);

    // 1) 已有映射：对齐两侧状态
    for (const key of Object.keys(this.mappings)) {
      const m = this.mappings[key];
      const task = byKey.get(key);
      let rem = reminders.get(m.rid);
      const taskOpen = task && isOpen(task);

      // 迁移：旧版 AppleScript 提醒的 rid 与 EventKit 标识符不同，
      // 找不到时按备注中的回链匹配，换用新标识符
      if (!rem && task) {
        const alt = byNotes.get(this.obsidianUri(task));
        if (alt) { rem = alt; m.rid = alt.id; }
      }

      if (!rem) {
        // 提醒被用户在提醒事项中删除 → 记录墓碑，不再重建
        delete this.mappings[key];
        if (taskOpen) { tomb.add(key); tombstoned++; }
        continue;
      }

      if (taskOpen) {
        if (rem.completed) {
          // 提醒事项侧完成 → 回写 Obsidian
          if (await this.completeTaskInFile(task)) {
            pulled++;
            delete this.mappings[key];
          }
          continue;
        }
        // 名称 / 日期以 Obsidian 为准；旧提醒缺少 URL 字段时一并补上
        const desc = titleOf(task);
        const due = dueOf(task);
        if (m.desc !== desc || m.due !== due || !rem.url) {
          ops.update.push({ id: m.rid, name: desc, due, url: this.obsidianUri(task) });
          m.desc = desc;
          m.due = due;
          updated++;
        }
        continue;
      }

      // 任务从 Tasks 缓存中消失（行被删除 / 文件删除 / 移入排除路径）
      // → 以 Obsidian 为准，删除对应提醒
      if (!task) {
        ops.delete.push(m.rid);
        deleted++;
        delete this.mappings[key];
        continue;
      }

      // 任务已完成 / 取消 / 变为非任务 → 完成提醒并移除映射
      if (!rem.completed) { ops.complete.push(m.rid); completed++; }
      delete this.mappings[key];
    }

    // 2) 新的未完成任务 → 创建提醒（链接写入 URL 字段，不写备注）
    for (const [key, task] of byKey) {
      if (!isOpen(task) || this.mappings[key] || tomb.has(key)) continue;
      const desc = titleOf(task);
      if (!desc) continue;
      ops.create.push({ key, name: desc, due: dueOf(task), url: this.obsidianUri(task) });
    }

    // 3) 应用到提醒事项
    if (ops.create.length || ops.update.length || ops.complete.length || ops.delete.length || !read.exists) {
      const res = await this.runHelper(ops);
      for (const [key, rid] of Object.entries(res.created || {})) {
        const task = byKey.get(key);
        if (!task) continue;
        this.mappings[key] = { rid, path: task.path, desc: titleOf(task), due: dueOf(task) };
        created++;
      }
      if (res.errors && res.errors.length) {
        console.warn('[tasks-reminders-sync] 部分写入失败', res.errors);
        new Notice('部分提醒写入失败：' + res.errors[0] + (res.errors.length > 1 ? ` 等 ${res.errors.length} 条` : ''), 8000);
      }
    }

    this.tombstones = [...tomb];
    await this.saveAll();

    const total = created + updated + completed + deleted + pulled;
    if (total > 0 || manual) {
      new Notice(
        `同步完成：新建 ${created}，更新 ${updated}，完成 ${completed}，删除 ${deleted}，回写 ${pulled}` +
        (tombstoned ? `，墓碑 ${tombstoned}` : '')
      );
    }
    console.log(
      `[tasks-reminders-sync] sync ok: +${created} ~${updated} ✓${completed} -${deleted} ⇐${pulled} tomb=${tombstoned} mapped=${Object.keys(this.mappings).length}`
    );
  }
};

// ---------------------------------------------------------------------------
// 设置页
// ---------------------------------------------------------------------------

class SyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: '任务同步提醒事项' });

    new Setting(this.containerEl)
      .setName('提醒事项列表名称')
      .setDesc('任务将同步到该列表；不存在时自动创建。')
      .addText((t) =>
        t.setValue(this.plugin.settings.listName).onChange(async (v) => {
          this.plugin.settings.listName = v.trim() || 'Obsidian';
          await this.plugin.saveAll();
        })
      );

    new Setting(this.containerEl)
      .setName('排除路径')
      .setDesc('每行一个目录前缀，命中路径的任务不同步；已同步的会在下次同步时被删除清理。')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.excludePaths).onChange(async (v) => {
          this.plugin.settings.excludePaths = v;
          await this.plugin.saveAll();
        });
        t.inputEl.rows = 5;
        t.inputEl.cols = 40;
      });

    new Setting(this.containerEl)
      .setName('自动同步间隔（分钟）')
      .setDesc('0 表示关闭定时自动同步。')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.autoSyncMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.autoSyncMinutes = Number.isFinite(n) && n >= 0 ? n : 10;
          await this.plugin.saveAll();
        })
      );

    new Setting(this.containerEl)
      .setName('启动时自动同步')
      .setDesc('Obsidian 启动且 Tasks 缓存就绪后自动执行一次同步。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnLaunch).onChange(async (v) => {
          this.plugin.settings.syncOnLaunch = v;
          await this.plugin.saveAll();
        })
      );

    new Setting(this.containerEl)
      .setName('立即同步')
      .setDesc('依赖 Tasks 插件；首次运行会弹出「Obsidian 想访问你的提醒事项」授权，请允许。')
      .addButton((b) =>
        b.setButtonText('同步').setCta().onClick(() => this.plugin.syncNow('manual'))
      );

    new Setting(this.containerEl)
      .setName('清除「不再重建」记录')
      .setDesc('在提醒事项中删除的提醒默认不会重建；清除后下次同步会重新创建。')
      .addButton((b) =>
        b.setButtonText('清除').onClick(async () => {
          this.plugin.tombstones = [];
          await this.plugin.saveAll();
          new Notice('已清除墓碑记录。');
          this.display();
        })
      );

    const n = Object.keys(this.plugin.mappings).length;
    this.containerEl.createEl('p', {
      text: `当前映射 ${n} 条，墓碑 ${this.plugin.tombstones.length} 条。同步语义：完成状态双向同步；名称、日期与删除以 Obsidian 为准；回链写入提醒的 URL 字段。`,
      cls: 'setting-item-description',
    });
  }
}
