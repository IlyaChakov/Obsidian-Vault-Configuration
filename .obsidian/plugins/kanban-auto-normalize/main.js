// Kanban Auto Normalize — плагин без сборки
// Авто-замена маркеров задач по колонкам при любом изменении файла доски.

module.exports = class KanbanAutoNormalize extends require('obsidian').Plugin {
  onload() {
    this.addCommand({
      id: 'normalize-kanban-markers-now',
      name: 'Normalize Kanban markers (now)',
      callback: () => this.normalizeActiveKanban()
    });

    const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
    this._debounced = debounce(() => this.normalizeActiveKanban(), 500);

    this.registerEvent(this.app.vault.on('modify', (file) => {
      const active = this.app.workspace.getActiveFile();
      if (active && file.path === active.path) this._debounced();
    }));
  }

  async normalizeActiveKanban() {
    const { app } = this;
    const file = app.workspace.getActiveFile();
    if (!file) return;

    const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
    if (!('kanban-plugin' in fm)) return;

    // === Соответствия колонок → символ в [ ] ===
    // В работе → [>], Заблокировано → [.], Отклонено → [~], Завершено → [?]
    const map = new Map([
      ['В работе', '>'],
      ['Заблокировано', '.'],
      ['Отклонено', '~'],
      ['Завершено', '?'],     // ← новое правило: поверх [x] от Kanban ставим [?]
      // при желании добавьте синонимы:
      // ['Done', '?'], ['Готово', '?'],
    ]);

    // Эти колонки принудительно держим пустыми [ ]
    const blankCols = new Set(['Заявки', 'План']);

    // Регэкспы
    const headingRe   = /^(#{1,6})\s+(.+?)\s*$/;
    const taskWithBox = /^(\s*[-*]\s*\[)[^\]]*(\]\s*)/;
    const taskNoBox   = /^(\s*[-*]\s+)(?!\[[^\]]*\])(.+)$/;
    const fenceStart  = /^```/;

    let text = await app.vault.read(file);
    const lines = text.split('\n');

    let currentColumn = null, inFence = false, changed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (fenceStart.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;

      const h = line.match(headingRe);
      if (h) { currentColumn = h[2].trim(); continue; }
      if (!currentColumn) continue;

      // 1) «Заявки» / «План» → [ ]
      if (blankCols.has(currentColumn)) {
        if (taskWithBox.test(line)) {
          if (!line.includes('[ ]')) { lines[i] = line.replace(taskWithBox, '$1 $2'); changed = true; }
        } else if (taskNoBox.test(line)) {
          lines[i] = line.replace(taskNoBox, '$1[ ] $2'); changed = true;
        }
        continue;
      }

      // 2) Остальные колонки по карте (в т.ч. «Завершено» → [?])
      if (map.has(currentColumn) && taskWithBox.test(line)) {
        const sym = map.get(currentColumn); // '>' / '.' / '~' / '?'
        if (!line.includes(`[${sym}]`)) {
          lines[i] = line.replace(taskWithBox, `$1${sym}$2`);
          changed = true;
        }
      }
    }

    const out = lines.join('\n');
    if (changed && out !== text) await app.vault.modify(file, out);
  }
};