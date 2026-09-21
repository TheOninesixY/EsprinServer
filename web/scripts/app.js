/* 启动与全局事件：主题、侧边栏形态、快捷键与各入口的事件绑定 */

let sidebarFadeTimer = null;
let searchDebounce = null;
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)');
// 窄屏（手机与竖屏平板）：导航改成抽屉、列表与工作区各占一屏，见 styles/web.css
const narrowScreenQuery = window.matchMedia('(max-width: 860px)');

/* ---------------- 换肤交叉淡入 ----------------
   与 styles/motion.css 的 html.appearance-fading 配对：先挂类、强制刷一次样式，
   再改配色，浏览器才会把这次变化当成「有过渡的变化」而不是同一次计算里的硬切。 */

let appearanceFadeTimer = null;

function beginAppearanceFade() {
    const root = document.documentElement;
    root.classList.add('appearance-fading');
    // 强制一次样式计算：否则「挂类」与「改配色」会被合并，过渡根本没机会播
    void root.offsetWidth;
    clearTimeout(appearanceFadeTimer);
    appearanceFadeTimer = setTimeout(() => root.classList.remove('appearance-fading'), APPEARANCE_FADE_MS + 60);
}

/* ---------------- 主题 ---------------- */

function resolvedTheme() {
    if (State.theme === 'light' || State.theme === 'dark') return State.theme;
    return systemThemeQuery.matches ? 'light' : 'dark';
}

function applyTheme({ fade = false } = {}) {
    if (fade) beginAppearanceFade();
    const resolved = resolvedTheme();
    document.documentElement.classList.toggle(LIGHT_THEME_CLASS, resolved === 'light');
    const icon = document.getElementById('theme-icon');
    icon.textContent = State.theme === 'system' ? 'computer' : resolved === 'light' ? 'light_mode' : 'dark_mode';
    document.getElementById('btn-theme-toggle').title = State.theme === 'system'
        ? `切换主题（当前跟随系统：${resolved === 'light' ? '浅色' : '深色'}）`
        : `切换主题（当前：${resolved === 'light' ? '浅色' : '深色'}）`;
}

function setTheme(value) {
    const next = THEME_VALUES.includes(value) ? value : 'system';
    if (next === State.theme) return;
    State.theme = next;
    applyTheme({ fade: true });
    saveConfig();
}

// 标题栏按钮：在深色与浅色之间切换；处于「跟随系统」时切到系统当前主题的反面
function toggleTheme() {
    const next = resolvedTheme() === 'light' ? 'dark' : 'light';
    State.theme = next;
    applyTheme({ fade: true });
    saveConfig();
    const select = document.getElementById('setting-theme');
    if (select) select.value = State.theme;
}

/* ---------------- 主题风格（皮肤） ----------------
   default 为内置的 GitHub 风格，alom 为 Alom 风格（styles/alom.css 按 <html data-theme-style> 接手）。 */

function normalizeThemeStyle(value) {
    return THEME_STYLE_VALUES.includes(value) ? value : 'default';
}

function applyThemeStyle({ fade = false } = {}) {
    if (fade) beginAppearanceFade();
    document.documentElement.dataset.themeStyle = normalizeThemeStyle(State.themeStyle);
}

function setThemeStyle(value) {
    const next = normalizeThemeStyle(value);
    if (next === State.themeStyle) return;
    State.themeStyle = next;
    applyThemeStyle({ fade: true });
    saveConfig();
    showToast(next === 'alom' ? '已切换到 Alom 风格' : '已切换到默认风格');
}

/* ---------------- 字体 ----------------
   界面字体与文档字体分别设置，西文与 CJK 分开填写；留空表示跟随默认字体栈。
   浏览器不允许枚举本机字体，因此这里是自由填写（对话框里带实时预览），
   填写的内容直接写进 --font-sans / --font-doc。 */

function applyFonts() {
    const root = document.documentElement;
    const uiFamilies = [quoteFontFamily(State.fonts.uiLatin), quoteFontFamily(State.fonts.uiCjk)].filter(Boolean);
    const docFamilies = [quoteFontFamily(State.fonts.docLatin), quoteFontFamily(State.fonts.docCjk)].filter(Boolean);

    if (uiFamilies.length) root.style.setProperty('--font-sans', `${uiFamilies.join(', ')}, sans-serif`);
    else root.style.removeProperty('--font-sans');

    if (docFamilies.length) {
        const cjkFallback = quoteFontFamily(State.fonts.uiCjk);
        root.style.setProperty('--font-doc', `${docFamilies.join(', ')}${cjkFallback ? `, ${cjkFallback}` : ''}, sans-serif`);
    } else {
        root.style.removeProperty('--font-doc');
    }
}

function setFontFamily(key, value) {
    if (!(key in State.fonts)) return;
    State.fonts[key] = String(value || '').trim();
    applyFonts();
    saveConfig();
}

/* ---------------- 主题色 ---------------- */

function normalizeHex(value) {
    const text = String(value || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(text)) return '';
    return text.toUpperCase();
}

// 强调色底面上的文字色：按相对亮度取黑或白，浅色主题色上不会出现白字看不清
function accentForeground(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const channel = (value) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
    const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

function applyAccentColor() {
    const root = document.documentElement;
    const color = normalizeHex(State.accentColor);
    if (!color) {
        root.style.removeProperty('--accent');
        root.style.removeProperty('--accent-bg');
        root.style.removeProperty('--accent-fg');
        return;
    }
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-bg', `rgba(${r}, ${g}, ${b}, 0.15)`);
    root.style.setProperty('--accent-fg', accentForeground(color));
}

function setAccentColor(value, rerender = true) {
    const raw = String(value || '').trim();
    if (!raw) {
        State.accentColor = '';
    } else {
        const normalized = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`);
        if (!normalized) {
            showToast('主题色设置失败：请填写 #RRGGBB 格式的十六进制颜色');
            return;
        }
        State.accentColor = normalized;
    }
    applyAccentColor();
    saveConfig();
    // 取色器拖动过程中不重建面板：一是跟手，二是避免输入框失去焦点
    if (rerender && activeSettingsCategory === 'appearance') renderSettingsView();
    else if (typeof syncAccentSelection === 'function') syncAccentSelection();
}

/* ---------------- 形状与品牌色 ---------------- */

// 圆角尺度：只切 <html data-radius>，最终生效的圆角由 styles/radius.css 按档位换算
function applyCornerRadius(value) {
    State.cornerRadius = CORNER_RADIUS_VALUES.includes(value) ? value : 'default';
    document.documentElement.dataset.radius = State.cornerRadius;
}

function setBrandColor(value) {
    State.brandColor = BRAND_COLOR_VALUES.includes(value) ? value : 'brand';
    document.documentElement.dataset.brandColor = State.brandColor;
    saveConfig();
}

/* ---------------- 侧边栏收起 / 展开 ---------------- */

function isNarrowScreen() {
    return narrowScreenQuery.matches;
}

function applySidebarCollapsed(animate = false) {
    const html = document.documentElement;
    const sidebar = document.getElementById('app-sidebar');
    const icon = document.getElementById('sidebar-toggle-icon');
    const toggle = document.getElementById('btn-toggle-sidebar');
    // 窄屏下侧边栏是一条抽屉（见 styles/web.css），不再参与「收起 / 展开」这一对形态
    const collapsed = !!State.sidebarCollapsed && !isNarrowScreen();

    const finish = () => {
        html.classList.toggle('sidebar-collapsed', collapsed);
        sidebar.classList.remove('text-fading', 'icons-fading');
        icon.textContent = collapsed ? 'keyboard_double_arrow_right' : 'keyboard_double_arrow_left';
        toggle.title = collapsed ? '展开侧边栏' : '收起侧边栏';
    };

    if (!animate) {
        finish();
        return;
    }

    // 收起：文字与底栏图标先渐隐，再收窄；展开：先撑开宽度，文字后显
    clearTimeout(sidebarFadeTimer);
    if (collapsed) {
        sidebar.classList.add('text-fading', 'icons-fading');
        sidebarFadeTimer = setTimeout(finish, 160);
        return;
    }
    html.classList.remove('sidebar-collapsed');
    icon.textContent = 'keyboard_double_arrow_left';
    toggle.title = '收起侧边栏';
    sidebar.classList.add('text-fading');
    sidebarFadeTimer = setTimeout(() => sidebar.classList.remove('text-fading'), 220);
}

function toggleSidebarCollapsed() {
    State.sidebarCollapsed = !State.sidebarCollapsed;
    applySidebarCollapsed(true);
    saveConfig();
}

/* ---------------- 窄屏：导航抽屉 ----------------
   窄屏下侧边栏整条挪到屏幕之外（见 styles/web.css），由笔记列表表头的菜单键拉开。
   这里只切 <html> 上的 mobile-nav-open 类名，外加两处「点完就该收起」的时机：
   点抽屉之外的任何地方，以及转屏／改窗口宽度换到另一档。 */

function applyMobileNav(open) {
    document.documentElement.classList.toggle('mobile-nav-open', !!open && isNarrowScreen());
}

function closeMobileNav() {
    applyMobileNav(false);
}

function toggleMobileNav() {
    applyMobileNav(!document.documentElement.classList.contains('mobile-nav-open'));
}

function bindMobileNav() {
    const menu = document.getElementById('btn-mobile-nav');
    if (menu) menu.onclick = toggleMobileNav;

    document.addEventListener('click', (event) => {
        if (!document.documentElement.classList.contains('mobile-nav-open')) return;
        // 「新建」自己负责展开菜单：这一下先不收起抽屉，等从菜单里选完再收
        if (event.target.closest('#btn-mobile-nav') || event.target.closest('#btn-new-note')) return;
        closeMobileNav();
    });

    narrowScreenQuery.addEventListener('change', () => {
        closeMobileNav();
        applySidebarCollapsed(false);
    });
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
    // 标题栏
    document.getElementById('app-brand').onclick = () => {
        flushPendingSave();
        State.openNoteIds = [];
        State.activeNoteId = null;
        renderApp();
    };
    document.getElementById('btn-theme-toggle').onclick = toggleTheme;
    document.getElementById('btn-fullscreen').onclick = toggleFullscreen;
    // AI 助手与小本本：现代布局下这两枚按钮悬浮在右上角，经典布局下在标题栏里，行为一致
    document.getElementById('btn-ai-assistant').onclick = toggleAiPanel;
    document.getElementById('btn-scratchpad').onclick = toggleScratchpad;
    // 现代布局的「返回」（标签栏最左端）
    document.getElementById('btn-tabs-back').onclick = backToNoteList;
    bindSettingsBack();
    document.getElementById('btn-sync-status').onclick = async () => {
        // 未连接到服务端时弹连接层；已连接则立即同步一次
        if (!State.sync.enabled) {
            showConnectGate();
            return;
        }
        const result = await Sync.syncNow({ reason: '手动' });
        showToast(result.ok ? `同步完成：${result.summary}` : `同步失败：${result.error}`);
        renderSyncIndicator();
    };

    // 侧边栏
    document.querySelectorAll('.nav-section-main .nav-item').forEach((item) => {
        item.onclick = () => {
            flushPendingSave();
            State.currentFilter = item.getAttribute('data-filter');
            renderApp();
        };
    });
    // 两处「新建」入口共用同一套菜单：同一个按钮再点一次收起
    const toggleNewItemMenuAt = (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        toggleNewItemMenu(box.left, box.bottom + 4);
    };
    document.getElementById('btn-new-note').onclick = toggleNewItemMenuAt;
    document.getElementById('btn-empty-new').onclick = toggleNewItemMenuAt;
    // 窄屏的表头新建入口与上面两处共用同一套菜单
    const mobileNew = document.getElementById('btn-mobile-new');
    if (mobileNew) mobileNew.onclick = toggleNewItemMenuAt;
    document.getElementById('btn-add-folder').onclick = addFolder;
    document.getElementById('btn-empty-trash').onclick = clearTrash;
    document.getElementById('btn-open-settings').onclick = openSettingsTab;
    document.getElementById('btn-toggle-sidebar').onclick = toggleSidebarCollapsed;
    bindMobileNav();

    // 中栏
    const searchInput = document.getElementById('input-search');
    searchInput.addEventListener('input', () => {
        State.searchQuery = searchInput.value;
        document.getElementById('btn-search-clear').classList.toggle('hidden', !State.searchQuery);
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(renderListPanel, 120);
    });
    document.getElementById('btn-search-clear').onclick = () => {
        State.searchQuery = '';
        searchInput.value = '';
        document.getElementById('btn-search-clear').classList.add('hidden');
        renderListPanel();
        searchInput.focus();
    };
    document.getElementById('select-sort').onchange = (event) => {
        State.sortBy = event.target.value;
        saveConfig();
        renderListPanel();
    };

    // 编辑器
    document.getElementById('input-note-title').addEventListener('input', autoSaveActiveItem);
    document.getElementById('textarea-note-content').addEventListener('input', () => {
        autoSaveActiveItem();
        scheduleRenderMarkdown();
    });
    document.getElementById('editor-folder-select').addEventListener('change', (event) => setItemFolder(event.target.value));
    document.getElementById('btn-add-tag').onclick = addTag;
    document.getElementById('btn-mode-edit').onclick = () => setViewMode('edit');
    document.getElementById('btn-mode-split').onclick = () => setViewMode('split');
    document.getElementById('btn-mode-preview').onclick = () => setViewMode('preview');
    document.getElementById('btn-todo-done').onclick = () => {
        const item = getActiveItem();
        if (item) toggleTodoDone(item.id);
    };
    document.querySelectorAll('.fmt-btn').forEach((button) => {
        button.onclick = () => formatMarkdown(button.getAttribute('data-fmt'));
    });

    // 浮层关闭：点击空白、滚动、窗口尺寸变化、Esc
    document.addEventListener('click', (event) => {
        // 「新建」按钮自己负责展开 / 收起菜单，这里要跳过它们，
        // 否则菜单刚被展开就会随这次点击冒泡到 document 时立刻收起
        if (event.target.closest('#btn-new-note') || event.target.closest('#btn-empty-new') || event.target.closest('#btn-mobile-new')) return;
        if (!event.target.closest('#context-menu')) hideContextMenu();
    });
    document.addEventListener('contextmenu', (event) => {
        if (!event.target.closest('.note-card, .tab-item')) hideContextMenu();
    });
    window.addEventListener('resize', hideContextMenu);
    window.addEventListener('scroll', hideContextMenu, true);

    const mask = document.getElementById('dialog-mask');
    mask.addEventListener('click', (event) => {
        if (event.target === mask) closeDialog(null);
    });
    document.getElementById('dialog-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            closeDialog({ id: 'confirm', value: event.target.value });
        }
    });

    document.addEventListener('keydown', handleGlobalKeydown);
    // 标签栏两端的渐隐要跟着滚动一起更新（横滚时才知道哪一侧还有被截断的标签）
    ['titlebar-tabs', 'workspace-tabs'].forEach((id) => {
        const container = document.getElementById(id);
        container.addEventListener('scroll', () => updateTabsFade(container), { passive: true });
    });
    systemThemeQuery.addEventListener('change', () => {
        if (State.theme === 'system') applyTheme();
    });
    window.addEventListener('beforeunload', () => {
        flushPendingSave();
    });
}

function handleGlobalKeydown(event) {
    if (event.key === 'Escape') {
        if (dialogResolve) {
            closeDialog(null);
            return;
        }
        // 连接层是模态的：没有凭据就不能进入界面，按 Esc 也不关闭
        if (!document.getElementById('gate-mask').classList.contains('hidden')) return;
        // 窄屏的导航抽屉：这一层在最上面，先收它
        if (document.documentElement.classList.contains('mobile-nav-open')) {
            closeMobileNav();
            return;
        }
        if (!document.getElementById('context-menu').classList.contains('hidden')) {
            hideContextMenu();
            return;
        }
        // 对话记录抽屉 / 小本本的选笔记面板：先收掉这一层，再谈退回列表
        if (!document.getElementById('ai-drawer').classList.contains('hidden')) {
            closeAiDrawer();
            return;
        }
        if (!document.getElementById('scratchpad-picker').classList.contains('hidden')) {
            closeScratchpadPicker();
            return;
        }
        // 回到笔记列表：标签页保留，只退出当前条目
        backToNoteList();
        return;
    }

    // 弹窗与输入框里不接管快捷键
    const target = event.target;
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (dialogResolve) return;

    // 焦点在小本本里时，Ctrl + S / Ctrl + O 归小本本（保存 / 选择笔记）
    const scratchpad = document.getElementById('scratchpad-panel');
    if (State.scratchpadOpen && target && scratchpad.contains(target) && handleScratchpadKeydown(event)) return;

    const ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl) return;

    if (event.key.toLowerCase() === 'n' && !event.shiftKey) {
        event.preventDefault();
        createNewNote();
        return;
    }
    if (event.key.toLowerCase() === 'n' && event.shiftKey) {
        event.preventDefault();
        createNewTodo();
        return;
    }
    if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        document.getElementById('input-search').focus();
        return;
    }
    if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        flushPendingSave();
        showToast('已保存');
        return;
    }
    if (event.key.toLowerCase() === 'w' && !inField) {
        event.preventDefault();
        if (State.activeNoteId) {
            closeTab(State.activeNoteId);
            renderApp();
        }
        return;
    }
    if (event.key === 'Tab') {
        event.preventDefault();
        const ids = State.openNoteIds;
        if (ids.length < 2) return;
        const current = ids.indexOf(State.activeNoteId);
        const step = event.shiftKey ? -1 : 1;
        const next = current === -1 ? (step > 0 ? 0 : ids.length - 1) : (current + step + ids.length) % ids.length;
        flushPendingSave();
        State.activeNoteId = ids[next];
        renderApp();
    }
}

function toggleFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen();
        return;
    }
    // iOS Safari 至今没有全屏 API：先探一下，别把一次点击变成未捕获的异常
    if (typeof document.documentElement.requestFullscreen !== 'function') {
        showToast('当前浏览器不支持全屏，可用「添加到主屏幕」后从桌面图标启动');
        return;
    }
    document.documentElement.requestFullscreen().catch((error) => {
        console.warn('[WARN] [Fullscreen] 进入全屏失败: ' + (error && error.message));
        showToast('全屏失败：浏览器拒绝了该请求');
    });
}

/* ---------------- 启动 ---------------- */

/* ---------------- 连接服务端 ----------------
   网页版的存储就是托管它的 EsprinServer：启动时自动探测，需要凭据时弹一层入口。 */

let gateMode = 'password';
let gateBusy = false;

function setGateMessage(text, tone = '') {
    const msg = document.getElementById('gate-msg');
    msg.textContent = text || '';
    if (tone) msg.dataset.tone = tone;
    else delete msg.dataset.tone;
}

function setGateMode(mode) {
    gateMode = mode === 'token' ? 'token' : 'password';
    const byPassword = gateMode === 'password';
    document.getElementById('gate-password-field').classList.toggle('hidden', !byPassword);
    document.getElementById('gate-token-field').classList.toggle('hidden', byPassword);
    document.getElementById('gate-mode-toggle').textContent = byPassword ? '改用访问令牌' : '改用管理密码';
    document.getElementById('gate-desc').textContent = byPassword
        ? '笔记保存在托管本页的 EsprinServer 上。输入服务端的管理密码即可登录，会话在 12 小时后过期。'
        : '笔记保存在托管本页的 EsprinServer 上。填写访问令牌后即可读写。';
    document.getElementById('gate-hint').textContent = byPassword
        ? '管理密码在服务端管理后台 /admin 设置；也可以在那里创建访问令牌，改用令牌登录。'
        : gateTokenHint();
    const field = byPassword ? document.getElementById('gate-password') : document.getElementById('gate-token');
    if (!document.getElementById('gate-mask').classList.contains('hidden')) setTimeout(() => field.focus(), 20);
}

// 服务端既没设密码也没建过令牌时，只能先从 /admin 建一份凭据（或填写 --token 启动时用的值）
function gateTokenHint() {
    const info = Sync.serverInfo;
    if (!info) return '访问令牌在服务端管理后台 /admin 创建，形如 esn_…；若服务端以 --token 启动，则填写该参数的值。';
    const configured = !!info.passwordSet || Number(info.tokenCount) > 0;
    return configured
        ? '访问令牌在服务端管理后台 /admin 创建，形如 esn_…；若服务端以 --token 启动，则填写该参数的值。'
        : '服务端尚未设置管理密码，也没有任何访问令牌：请先打开 /admin 设置密码或创建令牌；若服务端以 --token 启动，则填写该参数的值。';
}

function showConnectGate(message = '') {
    document.getElementById('gate-mask').classList.remove('hidden');
    setGateMode(Sync.authHint());
    setGateMessage(message, message ? 'error' : '');
}

function hideConnectGate() {
    document.getElementById('gate-mask').classList.add('hidden');
    setGateMessage('');
}

async function submitConnectGate() {
    if (gateBusy) return;
    const password = document.getElementById('gate-password').value;
    const token = document.getElementById('gate-token').value.trim();
    if (gateMode === 'password' && !password) {
        setGateMessage('登录失败：请填写管理密码', 'error');
        return;
    }
    if (gateMode === 'token' && !token) {
        setGateMessage('连接失败：请填写访问令牌', 'error');
        return;
    }

    gateBusy = true;
    const submit = document.getElementById('gate-submit');
    submit.disabled = true;
    submit.textContent = '连接中…';
    setGateMessage('正在连接服务端…');

    let result = null;
    try {
        if (gateMode === 'token') {
            State.sync.token = token;
            saveConfig();
            result = await Sync.connect({ reason: '令牌' });
        } else {
            result = await Sync.login(password);
        }
    } finally {
        gateBusy = false;
        submit.disabled = false;
        submit.textContent = '连接';
    }

    if (result && result.ok) {
        document.getElementById('gate-password').value = '';
        hideConnectGate();
        renderApp();
        showToast(result.summary ? `已连接到服务端：${result.summary}` : '已连接到服务端');
        return;
    }

    const message = (result && result.error) || '连接失败：服务端未接受当前凭据';
    setGateMessage(gateMode === 'password' ? `登录失败：${message}` : `连接失败：${message}`, 'error');
}

function bindConnectGate() {
    document.getElementById('gate-submit').onclick = submitConnectGate;
    document.getElementById('gate-mode-toggle').onclick = () => setGateMode(gateMode === 'password' ? 'token' : 'password');
    ['gate-password', 'gate-token'].forEach((id) => {
        document.getElementById(id).addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                submitConnectGate();
            }
        });
    });
}

// 启动时自动连接：连不上或需要凭据时一律停在连接层，拿到凭据前不进入笔记界面
async function autoConnect(message = '') {
    const result = await Sync.connect({ reason: '启动' });
    if (result.ok) {
        renderApp();
        return;
    }
    if (!result.needAuth) {
        console.warn(`[WARN] [App] 连接服务端失败，已停在连接层 (detail=${result.error})`);
    }
    showConnectGate(message || result.error || '');
    renderSyncIndicator();
}

async function boot() {
    loadConfig();
    await FileStore.open();
    await loadItemsFromStore();
    await loadAiChatsFromStore();

    applyTheme();
    applyThemeStyle();
    applyAccentColor();
    applyFonts();
    document.documentElement.dataset.radius = State.cornerRadius;
    document.documentElement.dataset.brandColor = State.brandColor;
    applySidebarCollapsed(false);

    initCustomSelects();
    initUiMode();
    initAiPanel();
    initScratchpad();
    bindEvents();
    bindConnectGate();

    const sortSelect = document.getElementById('select-sort');
    sortSelect.value = State.sortBy;

    const purged = purgeExpiredTrashItems();
    Sync.init();
    renderApp();

    if (purged > 0) showToast(`已自动清理 ${purged} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
    console.log(`[INFO] [App] 网页版已就绪 (cache=${FileStore.mode}, notes=${State.notes.length}, todos=${State.todos.length})`);

    // 首屏先用手上的本地副本渲染，随后接上托管本页的服务端
    await autoConnect();
}

window.addEventListener('DOMContentLoaded', () => {
    boot().catch((error) => {
        console.error('[ERROR] [App] 启动失败: ' + (error && error.message));
        showToast('启动失败：本地存储不可用，请检查浏览器隐私设置');
    });
});
