/* 设置视图：左侧分类导航与右侧面板。分类与桌面版一致，只去掉了三种浏览器里做不到的：
   系统与托盘（托盘、常驻后台、开机自启）、更新与版本（应用自更新），以及数据存放位置
   （浏览器不允许自选存储目录，本地副本已经存在 IndexedDB 里）。 */

const SETTINGS_CATEGORIES = [
    { id: 'editor', label: '编辑器与文本', icon: 'edit_note' },
    { id: 'appearance', label: '外观与主题色', icon: 'palette' },
    { id: 'fonts', label: '字体', icon: 'text_format' },
    { id: 'ai', label: 'AI 助手', icon: 'smart_toy' },
    { id: 'data', label: '数据与存储', icon: 'folder' },
    { id: 'about', label: '关于', icon: 'info' }
];

const ACCENT_PRESETS = ['', '#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#db61a2', '#39c5cf'];

// 圆角尺度的四档：与 styles/radius.css 的 data-radius 取值一一对应
const RADIUS_STEPS = [
    { value: 'square', label: '纯方' },
    { value: 'slight', label: '微圆角' },
    { value: 'default', label: '默认' },
    { value: 'large', label: '大圆' }
];

// 字体：浏览器不能枚举本机字体，因此自由填写，只提供几个常见值当候选
const FONT_SUGGESTIONS = [
    'system-ui', 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC',
    'Source Han Sans SC', 'HarmonyOS Sans SC', 'JetBrains Mono', 'Consolas', 'Georgia'
];

let activeSettingsCategory = SETTINGS_CATEGORIES[0].id;

function renderSettingsNav() {
    const nav = document.getElementById('settings-nav');
    nav.innerHTML = '';
    SETTINGS_CATEGORIES.forEach((category) => {
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.className = `nav-item settings-nav-item ${category.id === activeSettingsCategory ? 'active' : ''}`;
        entry.innerHTML = `
            <div class="nav-item-left">
                <span class="ms-icon sm">${category.icon}</span>
                <span>${category.label}</span>
            </div>
        `;
        entry.onclick = () => {
            activeSettingsCategory = category.id;
            renderSettingsView();
        };
        nav.appendChild(entry);
    });
}

function renderSettingsView() {
    renderSettingsNav();
    const content = document.getElementById('settings-content');
    const category = SETTINGS_CATEGORIES.find((item) => item.id === activeSettingsCategory) || SETTINGS_CATEGORIES[0];

    if (category.id === 'appearance') content.innerHTML = appearancePanelHTML();
    else if (category.id === 'editor') content.innerHTML = editorPanelHTML();
    else if (category.id === 'fonts') content.innerHTML = fontsPanelHTML();
    else if (category.id === 'ai') content.innerHTML = aiPanelHTML();
    else if (category.id === 'data') content.innerHTML = dataPanelHTML();
    else content.innerHTML = aboutPanelHTML();

    if (category.id === 'appearance') bindAppearancePanel();
    if (category.id === 'editor') bindEditorPanel();
    if (category.id === 'fonts') bindFontsPanel();
    if (category.id === 'ai') bindAiPanel();
    if (category.id === 'data') bindDataPanel();

    // 面板里的原生下拉同样升级成自绘菜单（bindCustomSelect 自带幂等判定）
    initCustomSelects();
    syncUiModeUI();
}

function panelHeader(title, desc, icon) {
    return `
        <div class="settings-header">
            <div class="settings-title">
                <span class="ms-icon md">${icon}</span>
                <span>${title}</span>
            </div>
            <div class="settings-desc">${desc}</div>
        </div>
    `;
}

/* ---------------- 外观与主题色 ---------------- */

function radiusSliderHTML() {
    const index = Math.max(0, RADIUS_STEPS.findIndex((step) => step.value === State.cornerRadius));
    return `
        <div class="settings-slider" id="setting-radius-slider">
            <div class="slider-track">
                <div class="slider-fill"></div>
                <div class="slider-thumb"></div>
                <input type="range" class="slider-range" min="0" max="${RADIUS_STEPS.length - 1}" step="1" value="${index}"
                    aria-label="圆角尺度" title="拖动选择圆角尺度">
            </div>
            <div class="slider-ticks">
                ${RADIUS_STEPS.map((step, i) => `<button type="button" class="slider-tick ${i === index ? 'active' : ''}" data-index="${i}">${step.label}</button>`).join('')}
            </div>
        </div>
    `;
}

function appearancePanelHTML() {
    const swatches = ACCENT_PRESETS.map((color) => {
        const selected = (State.accentColor || '') === color;
        const label = color ? color : '跟随主题';
        return `<button type="button" class="accent-swatch ${color ? '' : 'accent-swatch-default'} ${selected ? 'selected' : ''}"
                    data-accent="${color}" title="${label}"
                    ${color ? `style="--swatch-color: ${color}"` : ''}></button>`;
    }).join('');

    return `
        ${panelHeader('外观与主题色', '明暗主题、主题风格、界面布局、主题色与圆角，改动立即生效并保存在本浏览器', 'palette')}
        <div class="settings-section">
            <div class="settings-section-title">主题</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">明暗模式</span>
                    <span class="settings-row-desc">跟随系统时按操作系统的深浅色偏好自动切换</span>
                </div>
                <select class="settings-select" id="setting-theme">
                    <option value="system">跟随系统</option>
                    <option value="dark">深色</option>
                    <option value="light">浅色</option>
                </select>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">主题风格</span>
                    <span class="settings-row-desc">默认配色，或 Alom 风格（柔和投影、更大圆角与半透明材质）</span>
                </div>
                <select class="settings-select" id="setting-theme-style">
                    <option value="default">默认</option>
                    <option value="alom">Alom 风格</option>
                </select>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">应用名颜色</span>
                    <span class="settings-row-desc">左上角「EsprinNemo」的文字颜色</span>
                </div>
                <select class="settings-select" id="setting-brand-color">
                    <option value="brand">品牌色</option>
                    <option value="mono">跟随明暗（黑白）</option>
                    <option value="accent">跟随主题色</option>
                </select>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">界面布局</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">布局风格</span>
                    <span class="settings-row-desc">现代布局不排标题栏，标签页移到工作区顶部、入口悬浮到右上角；经典布局保留标题栏与标签栏</span>
                </div>
                <select class="settings-select" id="setting-ui-mode">
                    <option value="modern">现代布局</option>
                    <option value="classic">经典布局</option>
                </select>
            </div>
            <div class="settings-row settings-row-modern-only">
                <div class="settings-row-info">
                    <span class="settings-row-label">禁用标签页</span>
                    <span class="settings-row-desc">仅现代布局：收起整条标签栏，内容直达窗口上沿；标签状态不会丢失，关闭开关即恢复</span>
                </div>
                <label class="switch">
                    <input type="checkbox" id="setting-tabs-disabled" ${State.tabsDisabled ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">主题色</div>
            <div class="accent-swatches">${swatches}</div>
            <div class="accent-custom">
                <input type="color" class="accent-color-input" id="setting-accent-picker" value="${State.accentColor || '#58a6ff'}">
                <input type="text" class="accent-hex-input" id="setting-accent-hex" maxlength="7" placeholder="#RRGGBB" value="${escapeHTML(State.accentColor)}">
                <span class="accent-custom-hint">自定义颜色按十六进制填写，留空表示跟随主题</span>
                <button class="settings-btn" type="button" id="setting-accent-reset">跟随主题</button>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">形状</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">圆角尺度</span>
                    <span class="settings-row-desc">影响按钮、卡片、输入框与浮层，并与主题风格叠加</span>
                </div>
                ${radiusSliderHTML()}
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">侧边栏默认收起</span>
                    <span class="settings-row-desc">收起后只保留一条窄条，筛选入口仅显示图标</span>
                </div>
                <label class="switch">
                    <input type="checkbox" id="setting-sidebar-collapsed" ${State.sidebarCollapsed ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
        </div>
    `;
}

/* 自绘滑块：轨道左侧已选部分用主题色填充，档位文字可点选。
   拖动时取消补间保持跟手，松手吸附到最近档位（步长 1 已经是档位）。 */
function setSliderPosition(container, index) {
    const count = RADIUS_STEPS.length;
    const ratio = count > 1 ? index / (count - 1) : 0;
    container.style.setProperty('--slider-pos', String(ratio));
    container.style.setProperty('--slider-fill', `${ratio * 100}%`);
}

function bindRadiusSlider() {
    const container = document.getElementById('setting-radius-slider');
    if (!container) return;
    const range = container.querySelector('.slider-range');
    const ticks = Array.from(container.querySelectorAll('.slider-tick'));

    const applyIndex = (index, persist) => {
        const step = RADIUS_STEPS[Math.max(0, Math.min(RADIUS_STEPS.length - 1, index))];
        ticks.forEach((tick, i) => tick.classList.toggle('active', i === index));
        setSliderPosition(container, index);
        applyCornerRadius(step.value);
        if (persist) saveConfig();
    };

    setSliderPosition(container, Number(range.value));
    range.addEventListener('input', () => {
        container.classList.add('is-dragging');
        applyIndex(Number(range.value), false);
    });
    range.addEventListener('change', () => {
        container.classList.remove('is-dragging');
        applyIndex(Number(range.value), true);
    });
    ticks.forEach((tick, index) => {
        tick.onclick = () => {
            range.value = String(index);
            applyIndex(index, true);
        };
    });
}

function bindAppearancePanel() {
    const theme = document.getElementById('setting-theme');
    theme.value = State.theme;
    theme.onchange = () => setTheme(theme.value);

    const style = document.getElementById('setting-theme-style');
    style.value = normalizeThemeStyle(State.themeStyle);
    style.onchange = () => setThemeStyle(style.value);

    const brand = document.getElementById('setting-brand-color');
    brand.value = State.brandColor;
    brand.onchange = () => setBrandColor(brand.value);

    const uiMode = document.getElementById('setting-ui-mode');
    uiMode.value = normalizeUiMode(State.uiMode);
    uiMode.onchange = () => toggleUiMode(uiMode.value);

    const tabsDisabled = document.getElementById('setting-tabs-disabled');
    tabsDisabled.onchange = () => toggleTabsDisabled(tabsDisabled.checked);

    bindRadiusSlider();

    const collapsed = document.getElementById('setting-sidebar-collapsed');
    collapsed.onchange = () => {
        State.sidebarCollapsed = collapsed.checked;
        applySidebarCollapsed(true);
        saveConfig();
    };

    document.querySelectorAll('.accent-swatch').forEach((swatch) => {
        swatch.onclick = () => setAccentColor(swatch.dataset.accent || '');
    });

    const picker = document.getElementById('setting-accent-picker');
    const hex = document.getElementById('setting-accent-hex');
    picker.oninput = () => {
        setAccentColor(picker.value, false);
        hex.value = State.accentColor;
    };
    hex.onchange = () => {
        setAccentColor(hex.value, false);
        if (State.accentColor) picker.value = State.accentColor;
    };
    document.getElementById('setting-accent-reset').onclick = () => setAccentColor('');

    // 同步刷新下拉的自绘触发器
    CUSTOM_SELECTS.forEach((entry) => {
        if ([theme, style, brand, uiMode].includes(entry.select)) refreshCustomSelect(entry);
    });
}

// 不重建面板的前提下同步色板选中态与两个输入框的值
function syncAccentSelection() {
    document.querySelectorAll('.accent-swatch').forEach((swatch) => {
        swatch.classList.toggle('selected', (State.accentColor || '') === (swatch.dataset.accent || ''));
    });
    const hex = document.getElementById('setting-accent-hex');
    if (hex && State.accentColor) hex.value = State.accentColor;
}

/* ---------------- 编辑器 ---------------- */

function editorPanelHTML() {
    return `
        ${panelHeader('编辑器与文本', '编辑与预览的行为设置', 'edit_note')}
        <div class="settings-section">
            <div class="settings-section-title">文本</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">拼写检查</span>
                    <span class="settings-row-desc">打开后浏览器会对正文内容做拼写检查（仅对本次会话生效）</span>
                </div>
                <label class="switch">
                    <input type="checkbox" id="setting-spellcheck" ${State.spellcheck ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">默认视图</span>
                    <span class="settings-row-desc">打开条目时的初始视图，可在编辑区顶栏随时切换</span>
                </div>
                <select class="settings-select" id="setting-view-mode">
                    <option value="edit">编辑</option>
                    <option value="split">分屏</option>
                    <option value="preview">预览</option>
                </select>
            </div>
        </div>
        <div class="settings-section">
            <div class="settings-section-title">废纸篓</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">自动清理</span>
                    <span class="settings-row-desc">依据最后一次编辑时间清理废纸篓内容，0 表示永不自动清理</span>
                </div>
                <select class="settings-select" id="setting-trash-retention">
                    <option value="0">永不清理</option>
                    <option value="10">保留 10 天</option>
                    <option value="30">保留 30 天</option>
                    <option value="60">保留 60 天</option>
                    <option value="365">保留 365 天</option>
                </select>
            </div>
        </div>
    `;
}

function bindEditorPanel() {
    const spellcheck = document.getElementById('setting-spellcheck');
    spellcheck.onchange = () => {
        State.spellcheck = spellcheck.checked;
        document.getElementById('textarea-note-content').spellcheck = State.spellcheck;
        saveConfig();
    };

    const viewMode = document.getElementById('setting-view-mode');
    viewMode.value = State.viewMode;
    viewMode.onchange = () => setViewMode(viewMode.value);

    const retention = document.getElementById('setting-trash-retention');
    retention.value = String(State.trashRetentionDays);
    retention.onchange = () => {
        State.trashRetentionDays = Number(retention.value) || 0;
        saveConfig();
        const removed = purgeExpiredTrashItems();
        if (removed > 0) {
            renderApp();
            showToast(`已清理 ${removed} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
        } else {
            showToast('自动清理设置已保存');
        }
    };

    CUSTOM_SELECTS.forEach((entry) => {
        if ([viewMode, retention].includes(entry.select)) refreshCustomSelect(entry);
    });
}

/* ---------------- 数据与存储 ---------------- */

function dataPanelHTML() {
    const noteCount = State.notes.length;
    const todoCount = State.todos.length;
    const bytes = [...FileStore.memory.entries()]
        .filter(([path]) => path.startsWith('notes/') || path.startsWith('todos/'))
        .reduce((total, [, text]) => total + utf8Bytes(text).length, 0);

    return `
        ${panelHeader('数据与存储', '本地只保留一份副本（缓存）用于离线阅读与加速启动；连接服务端后，内容的权威副本在 EsprinServer 上', 'folder')}
        <div class="settings-section">
            <div class="settings-section-title">服务端连接</div>
            <div class="settings-row is-column">
                <div class="settings-row-info">
                    <span class="settings-row-label">连接状态</span>
                    <span class="settings-hint" id="data-sync-status"></span>
                </div>
                <div class="settings-path" id="data-sync-url"></div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">自动同步</span>
                    <span class="settings-row-desc">到点自动执行「拉取 → 重放 → 推送」；本地改动在编辑停止后仍会立即推送</span>
                </div>
                <div class="row-controls">
                    <select class="settings-select" id="data-sync-auto">
                        <option value="off">关闭</option>
                        <option value="5s">每 5 秒</option>
                        <option value="1m">每 1 分钟</option>
                        <option value="5m">每 5 分钟</option>
                        <option value="startup">每次启动时</option>
                        <option value="custom">自定义</option>
                    </select>
                    <input class="settings-input mono short" id="data-sync-seconds" type="number" min="5"
                        value="${Number(State.sync.autoSyncSeconds) || 60}" title="自定义间隔（秒）">
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">同步操作</span>
                    <span class="settings-row-desc">登录、立即同步或断开连接；未登录时无法读写服务端，断开后需重新登录才能继续使用</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn" type="button" id="data-sync-login">登录 / 填写令牌</button>
                    <button class="settings-btn" type="button" id="data-sync-now">立即同步</button>
                    <button class="settings-btn danger" type="button" id="data-sync-logout">断开连接</button>
                </div>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">当前数据</div>
            <div class="settings-row is-column">
                <div class="settings-row-info">
                    <span class="settings-row-label">本地副本</span>
                    <span class="settings-row-desc">笔记 ${noteCount} 篇 · 待办 ${todoCount} 项 · 约 ${(bytes / 1024).toFixed(1)} KB</span>
                </div>
                <div class="settings-path" id="data-summary">存储方式：${FileStore.mode === 'idb' ? 'IndexedDB' : 'localStorage'}</div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">导出备份</span>
                    <span class="settings-row-desc">导出全部条目（含文件夹、标签、置顶与废纸篓状态）为一份 JSON 文件</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn" type="button" id="data-export-backup">导出 JSON 备份</button>
                    <button class="settings-btn" type="button" id="data-export-markdown">导出全部为 Markdown</button>
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">导入备份</span>
                    <span class="settings-row-desc">读取此前导出的 JSON 备份，与现有条目合并；id 冲突的条目会分配新 id</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn" type="button" id="data-import-backup">选择备份文件</button>
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">清空本地副本</span>
                    <span class="settings-row-desc">删除本浏览器内的副本并清空待推送队列。已连接到服务端时，下次同步会把服务器上的内容重新拉回来</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn danger" type="button" id="data-clear">清空本地副本</button>
                </div>
            </div>
        </div>
    `;
}

function bindDataPanel() {
    document.getElementById('data-export-backup').onclick = () => {
        flushPendingSave();
        const backup = exportBackup();
        downloadText(`esprinnemo-backup-${new Date().toISOString().slice(0, 10)}.json`,
            JSON.stringify(backup, null, 2), 'application/json');
        showToast('备份已导出');
    };

    document.getElementById('data-export-markdown').onclick = () => {
        flushPendingSave();
        const parts = [];
        [...State.notes, ...State.todos].forEach((item) => {
            const heading = `# ${itemDisplayTitle(item)}`;
            const meta = isTodoItem(item)
                ? `> 待办 · 文件夹：${item.folder}${item.isDone ? ' · 已完成' : ''}`
                : `> 笔记 · 文件夹：${item.folder}`;
            parts.push(`${heading}\n\n${meta}\n\n${item.content || ''}\n`);
        });
        downloadText(`esprinnemo-${new Date().toISOString().slice(0, 10)}.md`, parts.join('\n---\n\n'));
        showToast('已导出为 Markdown');
    };

    document.getElementById('data-import-backup').onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            try {
                const parsed = JSON.parse(await file.text());
                const imported = importBackup(parsed);
                if (!imported) {
                    showToast('导入失败：备份里没有可识别的条目');
                    return;
                }
                saveConfig();
                renderApp();
                showToast(`已导入 ${imported} 条`);
            } catch (error) {
                console.error(`[ERROR] [Backup] 备份解析失败 (file=${file.name}, detail=${error && error.message})`);
                showToast('导入失败：备份文件不是有效的 JSON');
            }
        });
        document.body.appendChild(input);
        input.click();
    };

    document.getElementById('data-clear').onclick = async () => {
        const confirmed = await showConfirm('清空本浏览器内的副本？', {
            title: '清空本地副本',
            detail: '本浏览器内的全部笔记与待办都会被删除，此操作无法撤销。'
                + '已连接到服务端时，服务器上的内容不受影响，下次同步会重新拉回来；'
                + '仍然排队的本地改动会一并丢弃。',
            type: 'warning',
            icon: 'delete_forever',
            confirmLabel: '清空',
            danger: true
        });
        if (!confirmed) return;
        await clearAllData();
        renderApp();
        renderSettingsView();
        showToast('本地副本已清空');
    };

    bindDataSyncPanel();
}

/* 服务端连接：状态行、地址、自动同步节奏与三个操作按钮。
   登录走既有的连接层（同源管理密码会话，或改用访问令牌），与启动时的行为一致。 */
function bindDataSyncPanel() {
    const status = document.getElementById('data-sync-status');
    if (status) {
        const online = State.sync.enabled && Sync.connection === 'ready';
        const detail = Sync.connectionMessage || Sync.lastError || '';
        status.textContent = online
            ? `已连接：${Sync.outbox.length ? `${Sync.outbox.length} 条改动待推送` : '本地与服务器已同步'}`
                + `${State.sync.lastSyncAt ? `；上次同步 ${formatDateTime(State.sync.lastSyncAt)}` : ''}`
            : (detail ? `未连接：${detail}` : '未连接：请先登录或填写访问令牌');
        status.classList.toggle('is-error', !online && !!detail);
    }

    const url = document.getElementById('data-sync-url');
    if (url) url.textContent = `${Sync.baseUrl()}${SYNC_PATH}`;

    const auto = document.getElementById('data-sync-auto');
    const seconds = document.getElementById('data-sync-seconds');
    auto.value = State.sync.autoSync;
    const syncSecondsDisabled = () => {
        seconds.disabled = State.sync.autoSync !== 'custom';
        seconds.style.opacity = seconds.disabled ? '0.45' : '';
    };
    syncSecondsDisabled();

    auto.onchange = () => {
        State.sync.autoSync = auto.value;
        saveConfig();
        syncSecondsDisabled();
        Sync.applyAutoSyncRuntime();
        showToast('自动同步设置已保存');
    };
    seconds.onchange = () => {
        State.sync.autoSyncSeconds = Math.max(5, Number(seconds.value) || 60);
        seconds.value = String(State.sync.autoSyncSeconds);
        saveConfig();
        Sync.applyAutoSyncRuntime();
    };

    document.getElementById('data-sync-login').onclick = () => showConnectGate();
    document.getElementById('data-sync-now').onclick = async () => {
        if (!State.sync.enabled) {
            showConnectGate('尚未连接服务端，请先登录或填写访问令牌');
            return;
        }
        const result = await Sync.syncNow({ reason: '手动' });
        showToast(result.ok ? `同步完成：${result.summary}` : `同步失败：${result.error}`);
        renderSyncIndicator();
        renderSettingsView();
    };
    document.getElementById('data-sync-logout').onclick = async () => {
        const confirmed = await showConfirm('断开与服务端的连接？', {
            title: '断开连接',
            detail: '断开后需重新登录或填写访问令牌才能继续使用，服务器的内容不受影响；'
                + '已排队的改动会留在队列里，下次登录后再上传。',
            type: 'warning',
            icon: 'cloud_off',
            confirmLabel: '断开',
            danger: true
        });
        if (!confirmed) return;
        await Sync.logout();
        renderSettingsView();
        // 凭据一律必需：断开之后立刻回到连接层，不允许在未登录状态下继续用界面
        showConnectGate('已断开与服务端的连接：请重新登录或填写访问令牌');
    };

    CUSTOM_SELECTS.forEach((entry) => {
        if (entry.select === auto) refreshCustomSelect(entry);
    });
}

/* ---------------- 字体 ----------------
   桌面版从系统字体列表里下拉选择；浏览器出于指纹防护不允许枚举本机字体，
   因此这里改为自由填写（带候选建议与实时预览），填写的名称直接写进 --font-sans / --font-doc。 */

function fontDatalistHTML() {
    return `<datalist id="font-suggestions">${FONT_SUGGESTIONS.map((name) => `<option value="${name}"></option>`).join('')}</datalist>`;
}

function fontRowHTML(key, label, desc) {
    return `
        <div class="settings-row">
            <div class="settings-row-info">
                <span class="settings-row-label">${label}</span>
                <span class="settings-row-desc">${desc}</span>
            </div>
            <input class="settings-input" list="font-suggestions" data-font-key="${key}"
                value="${escapeHTML(State.fonts[key] || '')}" placeholder="留空表示跟随默认" spellcheck="false">
        </div>
    `;
}

function fontsPanelHTML() {
    return `
        ${panelHeader('字体', '界面字体与文档字体分开设置，西文与 CJK 分开配置，按字符逐个回退', 'text_format')}
        ${fontDatalistHTML()}
        <div class="settings-section">
            <div class="settings-section-title">界面字体</div>
            ${fontRowHTML('uiLatin', '界面 · 西文', '侧边栏、列表、按钮等界面文字使用的西文字体')}
            ${fontRowHTML('uiCjk', '界面 · 中日韩', '界面文字里中日韩字符使用的字体')}
        </div>
        <div class="settings-section">
            <div class="settings-section-title">文档字体</div>
            ${fontRowHTML('docLatin', '文档 · 西文', '编辑器正文与 Markdown 预览使用的西文字体')}
            ${fontRowHTML('docCjk', '文档 · 中日韩', '正文里中日韩字符使用的字体')}
        </div>
        <div class="settings-section">
            <div class="settings-section-title">预览</div>
            <div class="font-preview" id="font-preview">
                <span class="font-preview-label">文档字体预览</span>
                EsprinNemo 文档字体预览 The quick brown fox jumps over the lazy dog 0123456789
            </div>
            <div class="settings-actions">
                <button class="settings-btn" type="button" id="setting-font-reset">恢复默认字体</button>
            </div>
        </div>
    `;
}

function updateFontPreview() {
    const preview = document.getElementById('font-preview');
    if (!preview) return;
    const families = [quoteFontFamily(State.fonts.docLatin), quoteFontFamily(State.fonts.docCjk)].filter(Boolean);
    preview.style.fontFamily = families.length ? `${families.join(', ')}, sans-serif` : '';
}

function bindFontsPanel() {
    document.querySelectorAll('[data-font-key]').forEach((input) => {
        input.addEventListener('input', () => {
            setFontFamily(input.dataset.fontKey, input.value);
            updateFontPreview();
        });
    });
    document.getElementById('setting-font-reset').onclick = () => {
        ['uiLatin', 'uiCjk', 'docLatin', 'docCjk'].forEach((key) => { State.fonts[key] = ''; });
        applyFonts();
        saveConfig();
        renderSettingsView();
        showToast('已恢复默认字体');
    };
    updateFontPreview();
}

/* ---------------- AI 助手 ----------------
   桌面版把 API Key 交给系统密钥链、请求由主进程代理；网页版只能由页面直连站点，
   密钥保存在本浏览器里，且可能受站点的 CORS 策略限制——面板里把这几点写清楚。 */

const AI_QUICK_SITES = [
    { label: 'DeepSeek', url: 'https://api.deepseek.com' },
    { label: 'Ollama', url: 'http://localhost:11434' }
];

function aiPanelHTML() {
    return `
        ${panelHeader('AI 助手', '填写兼容 OpenAI 协议的站点、密钥与模型即可使用问答面板', 'smart_toy')}
        <div class="settings-section">
            <div class="settings-section-title">启用</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">AI 助手</span>
                    <span class="settings-row-desc">关闭后标题栏入口与对话面板一并隐藏，不再发起任何请求，配置保留</span>
                </div>
                <label class="switch">
                    <input type="checkbox" id="setting-ai-enabled" ${isAiEnabled() ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">接口</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">API 站点</span>
                    <span class="settings-row-desc">兼容 OpenAI 协议的站点地址；带 /v1 或不带都可以</span>
                </div>
                <div class="ai-input-stack">
                    <input class="settings-input mono" id="setting-ai-base-url" value="${escapeHTML(State.ai.baseUrl)}"
                        placeholder="https://api.deepseek.com" spellcheck="false">
                    <div class="ai-quick-fill">
                        <span class="ai-quick-fill-label">快捷填入</span>
                        ${AI_QUICK_SITES.map((site) => `<button class="ai-quick-chip" type="button" data-ai-site="${site.url}">${site.label}</button>`).join('')}
                    </div>
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">API Key</span>
                    <span class="settings-row-desc">保存在本浏览器（localStorage），共享这台浏览器即等于共享密钥；本地站点留空即可</span>
                </div>
                <input class="settings-input mono" id="setting-ai-key" type="password" autocomplete="off"
                    value="${escapeHTML(State.ai.apiKey)}" placeholder="sk-…" spellcheck="false">
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">模型</span>
                    <span class="settings-row-desc">例如 deepseek-chat、qwen2.5、llama3.1</span>
                </div>
                <div class="ai-input-group">
                    <input class="settings-input mono" id="setting-ai-model" list="ai-model-options"
                        value="${escapeHTML(State.ai.model)}" placeholder="模型名称" spellcheck="false">
                    <datalist id="ai-model-options"></datalist>
                    <button class="settings-btn" type="button" id="setting-ai-fetch-models">拉取候选</button>
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">连接测试</span>
                    <span class="settings-row-desc">发送一条最短请求，验证站点 / 密钥 / 模型是否可用</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn" type="button" id="setting-ai-test">测试连接</button>
                </div>
            </div>
            <div class="settings-hint ai-status" id="setting-ai-status">${escapeHTML(aiDescribeConfigState())}</div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">提问行为</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">附带范围</span>
                    <span class="settings-row-desc">提问时默认一并发送的笔记范围，可在面板输入框下方随时改</span>
                </div>
                <select class="settings-select" id="setting-ai-scope">
                    <option value="current">仅当前笔记</option>
                    <option value="all">全部笔记</option>
                    <option value="none">不附带笔记</option>
                </select>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">附带数量上限</span>
                    <span class="settings-row-desc">「全部笔记」时最多附带多少篇（1–50）</span>
                </div>
                <input class="settings-input mono short" id="setting-ai-max-notes" type="number" min="1" max="50"
                    value="${Number(State.ai.maxNotes) || 10}">
            </div>
            <div class="settings-row is-column">
                <div class="settings-row-info">
                    <span class="settings-row-label">系统提示词</span>
                    <span class="settings-row-desc">约束 AI 的身份与回答风格，留空则使用内置提示词</span>
                </div>
                <textarea class="settings-input wide textarea" id="setting-ai-system" rows="4"
                    placeholder="例如：你是我的读书笔记助手，回答尽量简短，必要时引用笔记原文" spellcheck="false">${escapeHTML(State.ai.systemPrompt)}</textarea>
            </div>
        </div>
    `;
}

function aiDescribeConfigState() {
    if (!isAiEnabled()) return 'AI 助手当前已关闭。';
    if (!isAiConfigured()) return '尚未填写 API 站点或模型，填写后即可在右侧面板里提问。';
    return `已配置：${State.ai.model}${State.ai.apiKey ? '' : '（未填 API Key，本地站点无需填写）'}`;
}

function setAiStatus(text, tone = '') {
    const status = document.getElementById('setting-ai-status');
    if (!status) return;
    status.textContent = text;
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
}

function scheduleAiConfigSave() {
    saveConfig();
}

// 拉取模型候选：GET {base}/models
async function fetchAiModels() {
    const endpoint = aiBuildEndpoint(State.ai.baseUrl, 'models');
    if (!endpoint) {
        setAiStatus('拉取失败：请先填写 API 站点', 'error');
        return;
    }
    setAiStatus('正在拉取模型候选…');
    try {
        const response = await fetch(endpoint, { headers: aiHeaders() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const list = Array.isArray(payload.data) ? payload.data : [];
        const options = document.getElementById('ai-model-options');
        options.innerHTML = list
            .map((item) => (item && item.id ? `<option value="${escapeHTML(String(item.id))}"></option>` : ''))
            .join('');
        setAiStatus(list.length ? `已拉取 ${list.length} 个模型候选，点模型输入框即可选。` : '站点没有返回模型列表。', list.length ? 'ok' : '');
    } catch (error) {
        const detail = error && error.message ? error.message : '未知错误';
        setAiStatus(`拉取失败：${detail}（站点可能需要允许跨域访问）`, 'error');
    }
}

// 连接测试：发一条最短请求
async function testAiConnection() {
    if (!isAiConfigured()) {
        setAiStatus('测试失败：请先填写 API 站点与模型', 'error');
        return;
    }
    setAiStatus('正在测试连接…');
    try {
        const endpoint = aiBuildEndpoint(State.ai.baseUrl, 'chat/completions');
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: aiHeaders(),
            body: JSON.stringify({
                model: State.ai.model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
                stream: false
            })
        });
        if (!response.ok) {
            let detail = '';
            try {
                const payload = await response.json();
                detail = payload && payload.error ? (payload.error.message || JSON.stringify(payload.error)) : '';
            } catch (error) {
                detail = '';
            }
            throw new Error(detail || `HTTP ${response.status}`);
        }
        setAiStatus(`连接正常：站点与模型 ${State.ai.model} 均可用。`, 'ok');
    } catch (error) {
        const detail = error && error.message ? error.message : '未知错误';
        setAiStatus(`测试失败：${detail}`, 'error');
    }
}

function bindAiPanel() {
    const enabled = document.getElementById('setting-ai-enabled');
    enabled.onchange = () => {
        State.ai.enabled = enabled.checked;
        scheduleAiConfigSave();
        applyAiEnabledState();
        showToast(enabled.checked ? 'AI 助手已开启' : 'AI 助手已关闭');
    };

    const baseUrl = document.getElementById('setting-ai-base-url');
    baseUrl.onchange = () => {
        State.ai.baseUrl = baseUrl.value.trim();
        scheduleAiConfigSave();
        updateAiModelChip();
        setAiStatus(aiDescribeConfigState());
    };
    document.querySelectorAll('[data-ai-site]').forEach((chip) => {
        chip.onclick = () => {
            baseUrl.value = chip.dataset.aiSite;
            State.ai.baseUrl = baseUrl.value;
            scheduleAiConfigSave();
            updateAiModelChip();
            setAiStatus(aiDescribeConfigState());
        };
    });

    const key = document.getElementById('setting-ai-key');
    key.onchange = () => {
        State.ai.apiKey = key.value.trim();
        scheduleAiConfigSave();
        setAiStatus(aiDescribeConfigState());
    };

    const model = document.getElementById('setting-ai-model');
    model.onchange = () => {
        State.ai.model = model.value.trim();
        scheduleAiConfigSave();
        updateAiModelChip();
        setAiStatus(aiDescribeConfigState());
    };

    document.getElementById('setting-ai-fetch-models').onclick = fetchAiModels;
    document.getElementById('setting-ai-test').onclick = testAiConnection;

    const scope = document.getElementById('setting-ai-scope');
    scope.value = State.ai.scope || 'current';
    scope.onchange = () => {
        State.ai.scope = AI_SCOPE_VALUES.includes(scope.value) ? scope.value : 'current';
        scheduleAiConfigSave();
        const panelSelect = document.getElementById('ai-scope-select');
        if (panelSelect) panelSelect.value = State.ai.scope;
        updateAiContextHint();
    };

    const maxNotes = document.getElementById('setting-ai-max-notes');
    maxNotes.onchange = () => {
        State.ai.maxNotes = Math.max(1, Math.min(50, Number(maxNotes.value) || 10));
        maxNotes.value = String(State.ai.maxNotes);
        scheduleAiConfigSave();
        updateAiContextHint();
    };

    const system = document.getElementById('setting-ai-system');
    system.onchange = () => {
        State.ai.systemPrompt = system.value;
        scheduleAiConfigSave();
    };

    CUSTOM_SELECTS.forEach((entry) => {
        if (entry.select === scope) refreshCustomSelect(entry);
    });
}

/* ---------------- 关于 ---------------- */

function aboutPanelHTML() {
    const shortcuts = [
        ['新建笔记', 'Ctrl + N'],
        ['新建待办', 'Ctrl + Shift + N'],
        ['搜索', 'Ctrl + K'],
        ['保存当前条目', 'Ctrl + S'],
        ['关闭当前标签页', 'Ctrl + W'],
        ['切换标签页', 'Ctrl + Tab'],
        ['回到笔记列表', 'Esc'],
        ['小本本：保存（未关联时新建为笔记）', 'Ctrl + S'],
        ['小本本：选择笔记', 'Ctrl + O']
    ];
    return `
        ${panelHeader('关于', 'EsprinNemo 网页版，由 EsprinServer 托管', 'info')}
        <div class="settings-section">
            <div class="settings-section-title">版本</div>
            <div class="settings-row is-column">
                <div class="settings-row-info">
                    <span class="settings-row-label">EsprinNemo Web</span>
                    <span class="settings-row-desc">界面与桌面版 EsprinNemo 共用同一套设计令牌与 Markdown 渲染规则，
                        数据格式（notes/{id}.md 的内嵌元数据注释）也完全一致，因此两端可以互推互认</span>
                </div>
                <div class="settings-path">服务端：${escapeHTML(Sync.baseUrl())}${escapeHTML(SYNC_PATH)}</div>
            </div>
        </div>
        <div class="settings-section">
            <div class="settings-section-title">快捷键</div>
            <div class="shortcut-list">
                ${shortcuts.map(([label, keys]) => `
                    <div class="shortcut-row">
                        <span>${label}</span>
                        <span class="shortcut-keys">${keys}</span>
                    </div>
                `).join('')}
            </div>
        </div>
        <div class="settings-section">
            <div class="settings-section-title">说明</div>
            <div class="settings-hint">
                网页版把托管它的 EsprinServer 直接当存储：本地只保留一份用于离线阅读的副本，
                读写最终都落在服务端的操作日志上；桌面客户端拉取同一份日志即可看到这些改动。
                首次登录需要服务端的管理密码（在 /admin 设置），也可以改用访问令牌。
            </div>
            <div class="settings-hint">
                与桌面版的两处差异：AI 助手的 API Key 只能存在本浏览器里（桌面版交给系统密钥链），
                请求也由页面直连站点，可能受站点的跨域策略限制；小本本是页内浮层而非始终置顶的独立窗口。
                界面尺寸（缩放比例）、托盘与驻留后台、开机自启、应用自更新、数据存放位置属于桌面端能力，
                浏览器里分别由浏览器缩放与系统本身接管。
            </div>
        </div>
    `;
}
