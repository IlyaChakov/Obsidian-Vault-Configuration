'use strict';

// Minimal replacement for monkey-around's around() helper
function around(proto, specs) {
  const originals = new Map();
  Object.keys(specs).forEach((name) => {
    const old = proto[name];
    originals.set(name, old);
    const factory = specs[name];
    const replacement = factory(old);
    proto[name] = replacement;
  });
  return function uninstall() {
    originals.forEach((old, name) => {
      proto[name] = old;
    });
  };
}

const obsidian = require('obsidian');
const {
  App,
  Component,
  Modal,
  Plugin,
  Setting,
  requireApiVersion,
  setIcon,
  MarkdownRenderer,
  WorkspaceLeaf,
} = obsidian;

const isFifteenPlus = requireApiVersion && requireApiVersion('0.15.0');

// i18n helper with safe fallback
const translate = (globalThis.i18next && globalThis.i18next.t
  ? globalThis.i18next.t.bind(globalThis.i18next)
  : (s) => s);

// alphabetical|alphabeticalReverse|byModifiedTime|byModifiedTimeReverse|byCreatedTime|byCreatedTimeReverse
const sortOptions = {
  alphabetical: translate('plugins.file-explorer.label-sort-a-to-z'),
  alphabeticalReverse: translate('plugins.file-explorer.label-sort-z-to-a'),
  byModifiedTime: translate('plugins.file-explorer.label-sort-new-to-old'),
  byModifiedTimeReverse: translate('plugins.file-explorer.label-sort-old-to-new'),
  byCreatedTime: translate('plugins.file-explorer.label-sort-created-new-to-old'),
  byCreatedTimeReverse: translate('plugins.file-explorer.label-sort-created-old-to-new'),
};

// Lightweight fallback header when internal SearchHeaderDOM isn't available
class FallbackSearchHeaderDOM {
  constructor(app, el) {
    this.app = app;
    const header = document.createElement('div');
    header.classList.add('nav-header');
    const buttons = document.createElement('div');
    buttons.classList.add('nav-buttons-container');
    header.appendChild(buttons);
    this.navHeaderEl = header;
    this.navButtonsEl = buttons;
  }
  addNavButton(icon, label, onClick, className) {
    const btn = document.createElement('div');
    btn.classList.add('clickable-icon', 'nav-action-button');
    if (className) btn.classList.add(className);
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    try {
      setIcon(btn, icon);
    } catch {}
    btn.addEventListener('click', onClick);
    this.navButtonsEl.appendChild(btn);
    return btn;
  }
  addSortButton(onClick, getCurrent) {
    const btn = this.addNavButton('arrow-up-narrow-wide', 'Порядок сортировки', () => {
      const menu = new obsidian.Menu(this.app);
      const keys = Object.keys(sortOptions);
      const current = getCurrent();
      keys.forEach((key) => {
        menu.addItem((item) => {
          item.setTitle(sortOptions[key]);
          if (typeof item.setChecked === 'function') {
            item.setChecked(key === current);
          } else if (key === current) {
            item.setIcon('check-small');
          }
          item.onClick(() => onClick(key));
        });
      });
      const rect = btn.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    });
    return btn;
  }
}

class ExplainQueryModal extends Modal {
  constructor(app, query, explanation) {
    super(app);
    this.query = query;
    this.explanation = explanation;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const title = contentEl.createEl('h3', { text: 'Query explanation' });
    contentEl.createEl('div', { text: this.query, cls: 'u-muted' });
    const list = contentEl.createEl('div');
    const addSection = (name, items) => {
      if (!items || !items.length) return;
      const section = list.createEl('div', { cls: 'setting-item' });
      section.createEl('div', { text: name, cls: 'setting-item-name' });
      const desc = section.createEl('div', { cls: 'setting-item-description' });
      desc.createEl('ul', {});
      items.forEach((t) => desc.children[0].createEl('li', { text: t }));
    };
    addSection('Exact phrases', this.explanation.phrases);
    addSection('Tags', this.explanation.tags);
    addSection('File filters', this.explanation.files);
    addSection('Path filters', this.explanation.paths);
    addSection('Include terms', this.explanation.must);
    addSection('Exclude terms', this.explanation.not);
  }
}

function explainQueryText(raw) {
  const text = (raw || '').trim();
  const remaining = [];
  const phrases = [];
  const tags = [];
  const files = [];
  const paths = [];
  const excluded = [];
  const tokens = [];

  // Collect phrases in quotes
  let tmp = text;
  tmp = tmp.replace(/"([^"\\]|\\.)*"/g, (m) => {
    phrases.push(m.slice(1, -1));
    return ' ';
  });

  // Collect tags of form #tag
  tmp = tmp.replace(/(^|\s)#([\w\-\/]+)/g, (m, s, t) => {
    tags.push('#' + t);
    return ' ';
  });

  // Collect key:value pairs for tag/file/path
  tmp = tmp.replace(/(^|\s)(tag|file|path):([^\s]+)/gi, (m, s, k, v) => {
    const key = k.toLowerCase();
    if (key === 'tag') tags.push(v);
    else if (key === 'file') files.push(v);
    else if (key === 'path') paths.push(v);
    return ' ';
  });

  // Split remaining by spaces
  tmp
    .split(/\s+/)
    .filter(Boolean)
    .forEach((tok) => {
      if (tok.startsWith('-')) excluded.push(tok.slice(1));
      else tokens.push(tok);
    });

  return {
    phrases,
    tags,
    files,
    paths,
    must: tokens,
    not: excluded,
  };
}

function renderQueryExplanation(container, rawQuery) {
  const exp = explainQueryText(rawQuery);
  while (container.firstChild) container.removeChild(container.firstChild);
  const title = container.createEl('div', { text: 'Совпадает со всеми подстроками:' });
  const list = container.createEl('ul');
  // Paths
  (exp.paths || []).forEach((p) => {
    const li = list.createEl('li', { text: 'Совпадает с путём файла:' });
    const ul = li.createEl('ul');
    ul.createEl('li', { text: `Соответствует тексту: "${p}"` });
  });
  // Files
  (exp.files || []).forEach((f) => {
    const li = list.createEl('li', { text: 'Совпадает с именем файла:' });
    const ul = li.createEl('ul');
    ul.createEl('li', { text: `Соответствует тексту: "${f}"` });
  });
  // Tags
  (exp.tags || []).forEach((t) => {
    list.createEl('li', { text: `Совпадает с тегом: ${t}` });
  });
  // Phrases and tokens to include
  const toInclude = [...(exp.phrases || []), ...(exp.must || [])];
  toInclude.forEach((t) => {
    list.createEl('li', { text: `Соответствует тексту: "${t}"` });
  });
  // Excluded terms
  (exp.not || []).forEach((t) => {
    list.createEl('li', { text: `Исключает текст: "${t}"` });
  });
}

class SearchMarkdownRenderer extends MarkdownRenderer {
  constructor(app, containerEl, match) {
    // @ts-ignore
    super(app, containerEl);
    this.app = app;
    this.match = match;
    this.subpath = '';
    this.indent = '';
    this.filePath = isFifteenPlus ? this.match.parentDom.path : this.match.parent.path;
    this.file = isFifteenPlus ? this.match.parentDom.file : this.match.parent.file;
    this.renderer.previewEl.onNodeInserted(() => {
      this.updateOptions();
      return this.renderer.onResize();
    });
  }
  updateOptions() {
    let readableLineLength = this.app.vault.getConfig('readableLineLength');
    this.renderer.previewEl.toggleClass('is-readable-line-width', readableLineLength);
    let foldHeading = this.app.vault.getConfig('foldHeading');
    this.renderer.previewEl.toggleClass('allow-fold-headings', foldHeading);
    let foldIndent = this.app.vault.getConfig('foldIndent');
    this.renderer.previewEl.toggleClass('allow-fold-lists', foldIndent);
    this.renderer.previewEl.toggleClass('rtl', this.app.vault.getConfig('rightToLeft'));
    if (!foldHeading) this.renderer.unfoldAllHeadings();
    if (!foldIndent) this.renderer.unfoldAllLists();
    this.renderer.previewEl.toggleClass('show-frontmatter', this.app.vault.getConfig('showFrontmatter'));
    let tabSize = this.app.vault.getConfig('tabSize');
    this.renderer.previewEl.style.tabSize = String(tabSize);
    this.renderer.rerender();
  }
  onRenderComplete() {}
  getFile() {
    return this.match.parent.file;
  }
  async edit(content) {
    this.renderer.set(content);
    let cachedContent = await this.app.vault.cachedRead(this.file);
    let matchContent = cachedContent.slice(this.match.start, this.match.end);
    let leadingSpaces = matchContent.match(/^\s+/g)?.first();
    if (leadingSpaces) content = content.replace(/^/gm, leadingSpaces);
    let before = cachedContent.slice(0, this.match.start);
    let after = cachedContent.slice(this.match.end, this.match.parent.content.length);
    var combinedContent = before + content + after;
    this.app.vault.modify(this.file, combinedContent);
  }
}

const DEFAULT_SETTINGS = {
  defaultCollapse: false,
  defaultShowContext: false,
  defaultHideTitle: true,
  defaultHideResults: false,
  defaultRenderMarkdown: false,
  defaultSortOrder: 'alphabetical',
};

class SettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  hide() {}
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('Collapse query results by default')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.defaultCollapse).onChange((value) => {
          this.plugin.settings.defaultCollapse = value;
          this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Show additional query result context by default')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.defaultShowContext).onChange((value) => {
          this.plugin.settings.defaultShowContext = value;
          this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Hide query title by default')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.defaultHideTitle).onChange((value) => {
          this.plugin.settings.defaultHideTitle = value;
          this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Hide query results by default')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.defaultHideResults).onChange((value) => {
          this.plugin.settings.defaultHideResults = value;
          this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Render results as Markdown by default')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.defaultRenderMarkdown).onChange((value) => {
          this.plugin.settings.defaultRenderMarkdown = value;
          this.plugin.saveSettings();
        }),
      );
    
    new Setting(containerEl)
      .setName('Default query result sort order')
      .addDropdown((cb) => {
        cb.addOptions(sortOptions);
        cb.setValue(this.plugin.settings.defaultSortOrder);
        cb.onChange(async (value) => {
          this.plugin.settings.defaultSortOrder = value;
          await this.plugin.saveSettings();
        });
      });
  }
}

const navBars = new WeakMap();
const backlinkDoms = new WeakMap();

class EmbeddedQueryControlPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    const plugin = this;
    this.registerSettingsTab();
    this.register(
      around(this.app.viewRegistry.constructor.prototype, {
        registerView(old) {
          return function (type, viewCreator, ...args) {
            plugin.app.workspace.trigger('view-registered', type, viewCreator);
            return old.call(this, type, viewCreator, ...args);
          };
        },
      }),
    );

    if (!this.app.workspace.layoutReady) {
      const eventRef = this.app.workspace.on('view-registered', (type, viewCreator) => {
        try {
          if (type !== 'search') return;
          this.app.workspace.offref(eventRef);
          // create a leaf before any leaves exist in the workspace
          let leaf;
          try { leaf = new WorkspaceLeaf(plugin.app); } catch {}
          const searchView = viewCreator(leaf);
          if (searchView) plugin.patchNativeSearch(searchView);
          const uninstall = around(Modal.prototype, {
            open(old) {
              return function (...args) {
                plugin.SearchResultsExport = this.constructor;
                return; // don't actually open
              };
            },
          });
          try { searchView.onCopyResultsClick(new MouseEvent(null)); } catch {}
          uninstall();
        } catch (e) {
          console.log(e);
        }
      });
      const eventRef2 = this.app.workspace.on('view-registered', (type, viewCreator) => {
        try {
          if (type !== 'backlink') return;
          this.app.workspace.offref(eventRef2);
          let leaf;
          try { leaf = new WorkspaceLeaf(plugin.app); } catch {}
          const searchView = viewCreator(leaf);
          if (searchView?.backlink?.headerDom) {
            plugin.SearchHeaderDOM = searchView.backlink.headerDom.constructor;
          }
        } catch (e) {
          console.log(e);
        }
      });
    } else {
      this.getSearchExport();
    }

    // Patch Component.addChild to intercept EmbeddedSearch and Backlinks
    this.register(
      around(Component.prototype, {
        addChild(old) {
          return function (child, ...args) {
            try {
              if (!plugin.isSearchPatched && child instanceof Component &&
                  Object.prototype.hasOwnProperty.call(child, 'searchQuery') &&
                  Object.prototype.hasOwnProperty.call(child, 'sourcePath') &&
                  Object.prototype.hasOwnProperty.call(child, 'dom')) {
                plugin.patchSearchView(child);
                plugin.isSearchPatched = true;
              }
              if (child instanceof Component && Object.prototype.hasOwnProperty.call(child, 'backlinkDom')) {
                const backlinks = child;
                const el = backlinks.backlinkDom?.el?.closest?.('.backlink-pane');
                if (el) backlinkDoms.set(el, child);
                if (!plugin.isBacklinksPatched) {
                  plugin.patchBacklinksView(backlinks);
                  plugin.isBacklinksPatched = true;
                }
              }
            } catch (err) {
              console.log(err);
            }
            const result = old.call(this, child, ...args);
            return result;
          };
        },
      }),
    );
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  registerSettingsTab() {
    this.settingsTab = new SettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
  }
  getSearchHeader() {
    // Use custom header to ensure consistent icons/labels
    return FallbackSearchHeaderDOM;
  }
  getSearchExport() {
    const plugin = this;
    let searchView = this.app.workspace.getLeavesOfType('search')?.first()?.view;
    const uninstall = around(Modal.prototype, {
      open(old) {
        return function (...args) {
          plugin.SearchResultsExport = this.constructor;
          return; // don't actually open
        };
      },
    });
    try { searchView?.onCopyResultsClick(new MouseEvent(null)); } catch {}
    uninstall();
  }
  onunload() {}

  patchNativeSearch(searchView) {
    const plugin = this;
    this.register(
      around(searchView.constructor.prototype, {
        onResize(old) {
          return function (...args) {
            const _children = isFifteenPlus ? this.dom.vChildren?._children : this.dom.children;
            if (this.dom.el.clientWidth === 0) {
              _children.forEach((child) => child.setCollapse(true, false));
              this.dom.hidden = true;
            } else if (this.dom.hidden) {
              this.dom.hidden = false;
              setTimeout(() => {
                _children.forEach((child) => child.setCollapse(this.dom.collapseAll, false));
              }, 100);
            }
            return old.call(this, ...args);
          };
        },
        stopSearch(old) {
          return function (...args) {
            const result = old.call(this, ...args);
            if (this.renderComponent) {
              this.renderComponent.unload();
              this.renderComponent = new Component();
            }
            return result;
          };
        },
        addChild(old) {
          return function (...args) {
            try {
              if (!this.patched) {
                if (!this.renderComponent) {
                  this.renderComponent = new Component();
                  this.renderComponent.load();
                }
                this.patched = true;
                this.dom.parent = this;
                plugin.patchSearchResultDOM(this.dom.constructor);
                this.setRenderMarkdown = function (value) {
                  const _children = isFifteenPlus ? this.dom.vChildren?._children : this.dom.children;
                  this.dom.renderMarkdown = value;
                  _children.forEach((child) => child.renderContentMatches());
                  this.dom.infinityScroll.invalidateAll();
                  this.dom.childrenEl.toggleClass('cm-preview-code-block', value);
                  this.dom.childrenEl.toggleClass('is-rendered', value);
                  this.renderMarkdownButtonEl?.toggleClass('is-active', value);
                };
                this.renderMarkdownButtonEl = this.headerDom?.addNavButton('book-open', 'Отображать Markdown', () => {
                  return this.setRenderMarkdown(!this.dom.renderMarkdown);
                });
                const allSettings = { renderMarkdown: plugin.settings.defaultRenderMarkdown };
                if (!this.settings) this.settings = {};
                Object.entries(allSettings).forEach(([setting, defaultValue]) => {
                  if (!Object.prototype.hasOwnProperty.call(this.settings, setting)) {
                    this.settings[setting] = defaultValue;
                  } else if (setting === 'sort' && !Object.prototype.hasOwnProperty.call(sortOptions, this.settings.sort)) {
                    this.settings[setting] = defaultValue;
                  }
                });
                this.setRenderMarkdown(this.settings.renderMarkdown);
              }
            } catch (err) {
              console.log(err);
            }
            const result = old.call(this, ...args);
            return result;
          };
        },
      }),
    );
  }

  patchSearchResultDOM(SearchResult) {
    const plugin = this;
    let uninstall = around(SearchResult.prototype, {
      addResult(old) {
        return function (...args) {
          uninstall();
          const result = old.call(this, ...args);
          let SearchResultItem = result.constructor;
          if (!plugin.isSearchResultItemPatched) plugin.patchSearchResultItem(SearchResultItem);
          return result;
        };
      },
    });
    this.register(uninstall);
    this.register(
      around(SearchResult.prototype, {
        startLoader(old) {
          return function (...args) {
            try {
              // backlinks view?
              let containerEl = this.el.closest('.backlink-pane');
              let backlinksInstance = backlinkDoms.get(containerEl);
              if (containerEl && backlinksInstance) {
                if (!backlinksInstance.patched) {
                  handleBacklinks(this, plugin, containerEl, backlinksInstance);
                }
              }

              // native search view?
              if (!this.parent?.searchParamsContainerEl?.patched && this.el?.parentElement?.getAttribute('data-type') === 'search') {
                this.parent.searchParamsContainerEl.patched = true;
                new Setting(this.parent.searchParamsContainerEl)
                  .setName('Отображать Markdown')
                  .setClass('mod-toggle')
                  .addToggle((toggle) => {
                    toggle.setValue(plugin.settings.defaultRenderMarkdown);
                    toggle.onChange((value) => {
                      this.renderMarkdown = value;
                      const _children = isFifteenPlus ? this.vChildren?._children : this.children;
                      _children.forEach((child) => child.renderContentMatches());
                      this.infinityScroll.invalidateAll();
                      this.childrenEl.toggleClass('cm-preview-code-block', value);
                      this.childrenEl.toggleClass('is-rendered', value);
                    });
                  });
              }

              // embedded search view?
              if (!this.patched && this.el.parentElement?.hasClass('internal-query')) {
                let _SearchHeaderDOM = plugin.SearchHeaderDOM ? plugin.SearchHeaderDOM : plugin.getSearchHeader();
                if (this.el?.closest('.internal-query')) {
                  this.patched = true;
                  let defaultHeaderEl = this.el.parentElement.querySelector('.internal-query-header');
                  this.setExtraContext = function (value) {
                    const _children = isFifteenPlus ? this.vChildren?._children : this.children;
                    this.extraContext = value;
                    this.extraContextButtonEl.toggleClass('is-active', value);
                    _children.forEach((child) => child.setExtraContext(value));
                    this.infinityScroll.invalidateAll();
                  };
                  this.setFilterVisible = function (visible) {
                    this.filterVisible = visible;
                    if (this.showFilterButtonEl) this.showFilterButtonEl.toggleClass('is-active', visible);
                    defaultHeaderEl.toggleClass('is-hidden', !visible);
                  };
                  
                  this.setResultsDisplay = function (value) {
                    this.showResults = value;
                    this.showResultsButtonEl.toggleClass('is-active', value);
                    this.el.toggleClass('is-hidden', value);
                  };
                  this.setRenderMarkdown = function (value) {
                    this.renderMarkdown = value;
                    const _children = isFifteenPlus ? this.vChildren?._children : this.children;
                    _children.forEach((child) => child.renderContentMatches());
                    this.infinityScroll.invalidateAll();
                    this.childrenEl.toggleClass('cm-preview-code-block', value);
                    this.childrenEl.toggleClass('is-rendered', value);
                    this.renderMarkdownButtonEl.toggleClass('is-active', value);
                  };
                  this.setCollapseAll = function (value) {
                    const _children = isFifteenPlus ? this.vChildren?._children : this.children;
                    this.collapseAllButtonEl.toggleClass('is-active', value);
                    this.collapseAll = value;
                    _children.forEach((child) => child.setCollapse(value, false));
                    this.infinityScroll.invalidateAll();
                  };
                  this.setSortOrder = (sortType) => {
                    this.sortOrder = sortType;
                    this.changed();
                    this.infinityScroll.invalidateAll();
                  };
                  this.onCopyResultsClick = (event) => {
                    event.preventDefault();
                    try { new plugin.SearchResultsExport(this.app, this).open(); } catch {}
                  };

                  let headerDom = (this.headerDom = new _SearchHeaderDOM(this.app, this.el.parentElement));
                  defaultHeaderEl.insertAdjacentElement('afterend', headerDom.navHeaderEl);
                  
                  this.collapseAllButtonEl = headerDom.addNavButton('bullet-list', translate('plugins.search.label-collapse-results'), () => {
                    return this.setCollapseAll(!this.collapseAll);
                  });
                  this.extraContextButtonEl = headerDom.addNavButton('expand-vertically', translate('plugins.search.label-more-context'), () => {
                    return this.setExtraContext(!this.extraContext);
                  });
                  headerDom.addSortButton(
                    (sortType) => this.setSortOrder(sortType),
                    () => this.sortOrder,
                  );
                  
                  // Show/Hide search filter (header)
                  this.showFilterButtonEl = headerDom.addNavButton('search', 'Показать фильтр поиска', () => {
                    return this.setFilterVisible(!this.filterVisible);
                  });
                  this.showResultsButtonEl = headerDom.addNavButton('eye-off', 'Скрыть результаты поиска', () => {
                    return this.setResultsDisplay(!this.showResults);
                  });
                  this.renderMarkdownButtonEl = headerDom.addNavButton('book-open', 'Отображать Markdown', () => {
                    return this.setRenderMarkdown(!this.renderMarkdown);
                  });
                  headerDom.addNavButton('copy', 'Скопировать результаты поиска', this.onCopyResultsClick.bind(this));
                  let allSettings = {
                    title: plugin.settings.defaultHideResults,
                    collapsed: plugin.settings.defaultCollapse,
                    context: plugin.settings.defaultShowContext,
                    hideTitle: plugin.settings.defaultHideTitle,
                    hideResults: plugin.settings.defaultHideResults,
                    renderMarkdown: plugin.settings.defaultRenderMarkdown,
                    sort: plugin.settings.defaultSortOrder,
                  };
                  if (!this.settings) this.settings = {};
                  Object.entries(allSettings).forEach(([setting, defaultValue]) => {
                    if (!Object.prototype.hasOwnProperty.call(this.settings, setting)) {
                      this.settings[setting] = defaultValue;
                    } else if (setting === 'sort' && !Object.prototype.hasOwnProperty.call(sortOptions, this.settings.sort)) {
                      this.settings[setting] = defaultValue;
                    }
                  });
                  this.setExtraContext(this.settings.context);
                  this.sortOrder = this.settings.sort;
                  this.setCollapseAll(this.settings.collapsed);
                  // default: filter hidden unless toggled
                  this.setFilterVisible(!this.settings.hideTitle);
                  this.setRenderMarkdown(this.settings.renderMarkdown);
                  this.setResultsDisplay(this.settings.hideResults);
                }
              }
            } catch (err) {
              console.log(err);
            }
            const result = old.call(this, ...args);
            return result;
          };
        },
      }),
    );
  }

  patchSearchResultItem(SearchResultItemClass) {
    this.isSearchResultItemPatched = true;
    const plugin = this;
    let uninstall = around(SearchResultItemClass.prototype, {
      onResultClick(old) {
        return function (event, e, ...args) {
          if (
            event.target instanceof HTMLElement &&
            (event.target.hasClass('internal-link') ||
              event.target.hasClass('task-list-item-checkbox') ||
              event.target.hasClass('admonition-title-content'))
          ) {
            // swallow click
          } else {
            return old.call(this, event, e, ...args);
          }
        };
      },
      renderContentMatches(old) {
        return function (...args) {
          const result = old.call(this, ...args);
          const _children = isFifteenPlus ? this.vChildren?._children : this.children;
          if (!plugin.isSearchResultItemMatchPatched && _children.length) {
            let SearchResultItemMatch = _children.first().constructor;
            plugin.patchSearchResultItemMatch(SearchResultItemMatch);
          }
          return result;
        };
      },
    });
    this.register(uninstall);
  }

  patchSearchResultItemMatch(SearchResultItemMatch) {
    this.isSearchResultItemMatchPatched = true;
    const plugin = this;
    this.register(
      around(SearchResultItemMatch.prototype, {
        render(old) {
          return function (...args) {
            let _parent = isFifteenPlus ? this.parentDom : this.parent;
            let content = _parent.content.substring(this.start, this.end).replace('```query', '\\`\\`\\`query');
            let leadingSpaces = content.match(/^\s+/g)?.first();
            if (leadingSpaces) content = content.replace(new RegExp(`^${leadingSpaces}`, 'gm'), '');
            let parentComponent = _parent.parent.parent;
            if (parentComponent && _parent.parent.renderMarkdown) {
              let component = parentComponent?.renderComponent;
              this.el.empty();
              let renderer = new SearchMarkdownRenderer(plugin.app, this.el, this);
              renderer.onRenderComplete = () => {
                _parent?.parent?.infinityScroll.measure(_parent, this);
              };
              component.addChild(renderer);
              renderer.renderer.set(content);
            } else {
              return old.call(this, ...args);
            }
          };
        },
      }),
    );
  }

  patchSearchView(embeddedSearch) {
    const plugin = this;
    const EmbeddedSearch = embeddedSearch.constructor;
    const SearchResult = embeddedSearch.dom.constructor;
    this.register(
      around(EmbeddedSearch.prototype, {
        onunload(old) {
          return function (...args) {
            if (this.renderComponent) {
              this.renderComponent.unload();
              this.dom = null;
              this.queue = null;
              this.renderComponent = null;
              this._children = null;
              this.containerEl = null;
            }
            const result = old.call(this, ...args);
            return result;
          };
        },
        onload(old) {
          return function (...args) {
            try {
              if (!this.renderComponent) {
                this.renderComponent = new Component();
                this.renderComponent.load();
              }
              this.dom.parent = this;
              let defaultHeaderEl = this.containerEl.parentElement.querySelector('.internal-query-header');
              let matches = this.query.matchAll(/^(?<key>collapsed|context|hideTitle|renderMarkdown|hideResults|sort|title):\s*(?<value>.+?)$/gm);
              let settings = {};
              for (let match of matches) {
                let value = match.groups.value.toLowerCase();
                if (value === 'true' || value === 'false') {
                  match.groups.value = value === 'true';
                }
                settings[match.groups.key] = match.groups.value;
              }
              this.query = this.query
                .replace(/^((collapsed|context|hideTitle|renderMarkdown|hideResults|sort|title):.+?)$/gm, '')
                .trim();
              defaultHeaderEl.setText(settings.title || this.query);
              this.dom.settings = settings;
            } catch {}
            const result = old.call(this, ...args);
            return result;
          };
        },
      }),
    );
    this.patchSearchResultDOM(SearchResult);
  }

  patchBacklinksView(backlinks) {
    const plugin = this;
    const Backlink = backlinks.constructor;
    const BacklinkDOM = backlinks.backlinkDom.constructor;
    this.register(
      around(Backlink.prototype, {
        onunload(old) {
          return function (...args) {
            if (this.renderComponent) {
              this.renderComponent.unload();
              this.dom = null;
              this.queue = null;
              this.renderComponent = null;
              this._children = null;
              this.containerEl = null;
            }
            const result = old.call(this, ...args);
            return result;
          };
        },
        onload(old) {
          return function (...args) {
            try {
              if (!this.renderComponent) {
                this.renderComponent = new Component();
                this.renderComponent.load();
              }
              this.backlinkDom.parent = this;
              this.unlinkedDom.parent = this;
              let settings = {};
              this.dom.settings = settings;
            } catch {}
            const result = old.call(this, ...args);
            return result;
          };
        },
      }),
    );
    this.patchSearchResultDOM(BacklinkDOM);
  }
}

function handleBacklinks(instance, plugin, containerEl, backlinksInstance) {
  if (backlinksInstance) {
    backlinksInstance.patched = true;
    let defaultHeaderEl = containerEl.querySelector('.internal-query-header') || containerEl.querySelector('.nav-header');
    instance.setRenderMarkdown = function (value) {
      const doms = [backlinksInstance.backlinkDom, backlinksInstance.unlinkedDom];
      doms.forEach((dom) => {
        dom.renderMarkdown = value;
        const _children = isFifteenPlus ? dom.vChildren?._children : dom.children;
        _children.forEach((child) => child.renderContentMatches());
        dom.infinityScroll.invalidateAll();
        dom.childrenEl.toggleClass('cm-preview-code-block', value);
        dom.childrenEl.toggleClass('is-rendered', value);
      });
      this.renderMarkdownButtonEl.toggleClass('is-active', value);
    };
    instance.onCopyResultsClick = (event) => {
      event.preventDefault();
      try { new plugin.SearchResultsExport(instance.app, instance).open(); } catch {}
    };
    instance.renderMarkdownButtonEl = backlinksInstance.headerDom.addNavButton('book-open', 'Отображать Markdown', () => {
      return instance.setRenderMarkdown(!instance.renderMarkdown);
    });
    backlinksInstance.headerDom.addNavButton('copy', 'Скопировать результаты поиска', instance.onCopyResultsClick.bind(instance));
    let allSettings = {
      title: plugin.settings.defaultHideResults,
      collapsed: plugin.settings.defaultCollapse,
      context: plugin.settings.defaultShowContext,
      hideTitle: plugin.settings.defaultHideTitle,
      hideResults: plugin.settings.defaultHideResults,
      renderMarkdown: plugin.settings.defaultRenderMarkdown,
      sort: plugin.settings.defaultSortOrder,
    };
    if (!instance.settings) instance.settings = {};
    Object.entries(allSettings).forEach(([setting, defaultValue]) => {
      if (!Object.prototype.hasOwnProperty.call(instance.settings, setting)) {
        instance.settings[setting] = defaultValue;
      } else if (setting === 'sort' && !Object.prototype.hasOwnProperty.call(sortOptions, instance.settings.sort)) {
        instance.settings[setting] = defaultValue;
      }
    });
    backlinksInstance.setExtraContext(instance.settings.context);
    backlinksInstance.sortOrder = instance.settings.sort;
    backlinksInstance.setCollapseAll(instance.settings.collapsed);
    instance.setRenderMarkdown(instance.settings.renderMarkdown);
  }
}

module.exports = EmbeddedQueryControlPlugin;
module.exports.default = EmbeddedQueryControlPlugin;
