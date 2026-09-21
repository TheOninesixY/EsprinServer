/* 数据层：条目模型、与桌面版一致的 .md 文件格式，以及浏览器内的持久化。
   本地数据以「一份文件一段文本」的形式保存（notes/{id}.md、todos/{id}.md），
   与同步协议里的路径一一对应，推拉操作因此可以直接取用同一份文本。 */

const META_HEADER = 'EsprinData';
const META_BLOCK_PATTERN = /^<!--[ \t]*EsprinData[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*-->[ \t]*(?=\r?\n|$)/;
const NOTE_DIR = 'notes';
const TODO_DIR = 'todos';
// AI 对话与小本本：与桌面版同名同目录，但**不**参与同步（同步只认 notes/ 与 todos/ 下的 Markdown），
// 它们只存在本浏览器里，免得把一份带密钥痕迹的对话记进服务器的操作日志
const AI_CHAT_DIR = 'ai_chats';
const SCRATCHPAD_FILE = 'scratchpad.json';
const DEFAULT_FOLDER = '默认';
const TITLE_MAX_LENGTH = 60;
const ITEM_KIND_KEY = '__esprinKind';

// 界面与偏好设置（体积小，直接放 localStorage）
const CONFIG_KEY = 'esprin.nemo.config';
const OUTBOX_KEY = 'esprin.nemo.outbox';
// 数据文件：优先 IndexedDB（容量大），不可用时退回 localStorage
const IDB_NAME = 'esprin-nemo';
const IDB_VERSION = 1;
const IDB_STORE = 'files';
const LS_FILES_KEY = 'esprin.nemo.files';

const State = {
    notes: [],
    todos: [],
    folders: [DEFAULT_FOLDER],
    activeNoteId: null,
    openNoteIds: [],
    currentFilter: 'all',
    searchQuery: '',
    sortBy: 'updated-desc',
    viewMode: 'edit',
    theme: 'system',
    // 主题风格（皮肤）：default 为内置的 GitHub 风格，alom 为 Alom 风格
    themeStyle: 'default',
    accentColor: '',
    brandColor: 'brand',
    cornerRadius: 'default',
    sidebarCollapsed: false,
    spellcheck: false,
    trashRetentionDays: 0,
    // 界面布局：modern（现代布局：不排标题栏，标签页移到工作区顶部，默认）
    // / classic（经典布局：标题栏与标签页照旧）
    uiMode: 'modern',
    // 现代布局下是否禁用标签页（只属于现代布局：经典布局的标签页归标题栏所有）
    tabsDisabled: false,
    // 字体设置：空字符串表示跟随 CSS 中的默认字体栈
    fonts: { uiLatin: '', uiCjk: '', docLatin: '', docCjk: '' },
    // AI 助手：接口配置。注意密钥保存在本浏览器（localStorage）里，
    // 与桌面版交给系统密钥链保管不同——共享这台浏览器就等于共享密钥
    ai: {
        enabled: true,
        agentMode: false,
        baseUrl: '',
        model: '',
        apiKey: '',
        scope: 'current',
        maxNotes: 10,
        systemPrompt: ''
    },
    aiPanelOpen: false,
    aiConversations: [],
    aiActiveConversationId: '',
    aiStreaming: false,
    aiAbort: null,
    aiStreamingChatId: '',
    aiPendingAttachments: [],
    // 小本本：页内浮层，关联到某篇笔记后编辑的就是那篇
    scratchpadOpen: false,
    scratchpadMinimized: false,
    scratchpadLinkedId: '',
    // 服务端存储：网页版默认把启动它的 EsprinServer 当存储，地址默认即当前站点。
    // token 只在服务端要求令牌时使用；服务端设过管理密码时走 /admin 的登录会话（Cookie）
    sync: {
        enabled: false,
        url: '',
        token: '',
        device: '',
        autoSync: '5s',
        autoSyncSeconds: 60,
        lastSeq: 0,
        journalId: '',
        lastSyncAt: 0,
        lastSyncSummary: ''
    },
    saveTimer: null,
    previewTimer: null
};

/* ---------------- AI 对话与小本本的本地文件 ----------------
   对话一份一个文件（ai_chats/{id}.json），与桌面版同目录同名，
   但只落在本浏览器的 IndexedDB 里，不进同步队列（见文件开头的说明）。 */

function aiChatPath(chatId) {
    return `${AI_CHAT_DIR}/${chatId}.json`;
}

function parseAiChatText(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.warn('[WARN] [AI] 对话文件解析失败: ' + (error && error.message));
        return null;
    }
}

// 从浏览器存储里读出全部对话，按最后修改时间排好
async function loadAiChatsFromStore() {
    const files = await FileStore.readAll();
    const chats = [];
    Object.keys(files).forEach((path) => {
        if (!path.startsWith(`${AI_CHAT_DIR}/`) || !path.endsWith('.json')) return;
        FileStore.memory.set(path, files[path]);
        const chat = parseAiChatText(files[path]);
        if (!chat || !Array.isArray(chat.messages)) return;
        if (!chat.id) chat.id = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/i, '');
        chats.push(chat);
    });
    State.aiConversations = chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function saveAiChatFile(chat) {
    if (!chat || !chat.id) return false;
    FileStore.write(aiChatPath(chat.id), JSON.stringify(chat, null, 2));
    return true;
}

function deleteAiChatFile(chatId) {
    if (!chatId) return false;
    FileStore.remove(aiChatPath(chatId));
    return true;
}

// 小本本：未关联笔记时内容属于自己，存在数据目录的 scratchpad.json 里
function loadScratchpadFile() {
    const text = FileStore.memory.get(SCRATCHPAD_FILE);
    if (typeof text !== 'string') return { title: '', content: '', linkedId: '' };
    try {
        const parsed = JSON.parse(text);
        return {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            content: typeof parsed.content === 'string' ? parsed.content : '',
            linkedId: typeof parsed.linkedId === 'string' ? parsed.linkedId : ''
        };
    } catch (error) {
        console.warn('[WARN] [Scratchpad] scratchpad.json 解析失败: ' + (error && error.message));
        return { title: '', content: '', linkedId: '' };
    }
}

function saveScratchpadFile(payload) {
    FileStore.write(SCRATCHPAD_FILE, JSON.stringify({
        title: String(payload.title || ''),
        content: String(payload.content || ''),
        linkedId: String(payload.linkedId || ''),
        updatedAt: Date.now()
    }, null, 2));
}

/* ---------------- 文件格式 ----------------
   与桌面版 storage.js 完全一致：头部注释记元数据，空行之后是正文。
   格式一致才能与桌面客户端互推：同内容写出的字节相同，哈希也相同。 */

function formatMetaValue(value) {
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    const text = typeof value === 'string' ? value : '';
    return text ? JSON.stringify(text) : '';
}

function formatMetaLine(key, value) {
    const text = formatMetaValue(value);
    return text ? `    ${key}: ${text}` : `    ${key}:`;
}

function serializeItemFile(item, isTodo) {
    const folder = item.folder && item.folder !== DEFAULT_FOLDER ? item.folder : '';
    const lines = [
        `<!--${META_HEADER}`,
        formatMetaLine('title', item.title || ''),
        formatMetaLine('folder', folder),
        formatMetaLine('tags', Array.isArray(item.tags) ? item.tags : []),
        formatMetaLine('isPinned', !!item.isPinned),
        formatMetaLine('isTrashed', !!item.isTrashed)
    ];
    if (isTodo) lines.push(formatMetaLine('isDone', !!item.isDone));
    lines.push(formatMetaLine('createdAt', Number(item.createdAt) || Date.now()));
    lines.push(formatMetaLine('updatedAt', Number(item.updatedAt) || Date.now()));
    lines.push('-->');

    const header = lines.join('\n');
    const content = String(item.content || '');
    return content ? `${header}\n\n${content}` : `${header}\n`;
}

// 解析 .md：返回 { meta, content }；没有注释的文件整份都算正文
function parseItemFile(raw) {
    const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
    const matched = text.match(META_BLOCK_PATTERN);
    if (!matched) return { meta: null, content: text };

    const meta = {};
    matched[1].split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        const separator = trimmed.indexOf(':');
        if (separator <= 0) return;
        meta[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    });

    let content = text.slice(matched[0].length);
    const gap = content.match(/^(?:\r?\n){1,2}/);
    if (gap) content = content.slice(gap[0].length);
    if (!content.trim()) content = '';
    return { meta, content };
}

function readMetaString(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return '';
    if (text.startsWith('"')) {
        try {
            const parsed = JSON.parse(text);
            return typeof parsed === 'string' ? parsed : '';
        } catch (error) {
            return text;
        }
    }
    return text;
}

function readMetaNumber(raw, fallback) {
    const value = Number(String(raw == null ? '' : raw).trim());
    return Number.isFinite(value) ? Math.round(value) : fallback;
}

function readMetaBoolean(raw, fallback) {
    const text = String(raw == null ? '' : raw).trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes') return true;
    if (text === 'false' || text === '0' || text === 'no') return false;
    return fallback;
}

function readMetaTags(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.filter((tag) => typeof tag === 'string' && tag.trim());
    } catch (error) {
        // 旧格式：以逗号分隔的裸文本
        return text.split(',').map((tag) => tag.trim()).filter(Boolean);
    }
    return [];
}

// 没有标题时用正文首个非空行兜底
function deriveTitle(content) {
    const line = String(content || '').split(/\r?\n/).find((item) => item.trim());
    if (!line) return '';
    const text = line.trim();
    return text.length > TITLE_MAX_LENGTH ? text.slice(0, TITLE_MAX_LENGTH) : text;
}

/* ---------------- 本地文件存储 ---------------- */

const FileStore = {
    mode: 'idb',
    db: null,
    chain: Promise.resolve(),
    memory: new Map(),
    lsTimer: null,

    async open() {
        if (!window.indexedDB) {
            this.mode = 'localStorage';
            this.loadFromLocalStorage();
            return;
        }
        try {
            this.db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(IDB_NAME, IDB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.warn('[WARN] [Storage] IndexedDB 不可用，改用 localStorage: ' + (error && error.message));
            this.mode = 'localStorage';
            this.loadFromLocalStorage();
        }
    },

    loadFromLocalStorage() {
        try {
            const parsed = JSON.parse(localStorage.getItem(LS_FILES_KEY) || '{}');
            Object.keys(parsed).forEach((path) => this.memory.set(path, parsed[path]));
        } catch (error) {
            console.warn('[WARN] [Storage] 本地文件表读取失败: ' + (error && error.message));
        }
    },

    flushLocalStorage() {
        clearTimeout(this.lsTimer);
        this.lsTimer = setTimeout(() => {
            const plain = {};
            this.memory.forEach((text, path) => { plain[path] = text; });
            try {
                localStorage.setItem(LS_FILES_KEY, JSON.stringify(plain));
            } catch (error) {
                console.error('[ERROR] [Storage] localStorage 写入失败: ' + (error && error.message));
                showToast('本地存储写入失败：容量已满，请先清理或导出数据');
            }
        }, 400);
    },

    // 读出全部文件：{ path: text }
    async readAll() {
        if (this.mode === 'localStorage' || !this.db) return Object.fromEntries(this.memory);
        const rows = await new Promise((resolve, reject) => {
            const tx = this.db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const paths = store.getAllKeys();
            const values = store.getAll();
            tx.oncomplete = () => resolve({ paths: paths.result || [], values: values.result || [] });
            tx.onerror = () => reject(tx.error);
        });
        const files = {};
        rows.paths.forEach((path, index) => { files[path] = rows.values[index]; });
        return files;
    },

    write(path, text) {
        this.memory.set(path, text);
        if (this.mode === 'localStorage' || !this.db) {
            this.flushLocalStorage();
            return;
        }
        this.chain = this.chain.then(() => new Promise((resolve) => {
            const tx = this.db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(text, path);
            tx.oncomplete = () => resolve();
            tx.onerror = () => {
                console.error('[ERROR] [Storage] 写入失败: ' + (tx.error && tx.error.message) + ' (path=' + path + ')');
                resolve();
            };
        }));
    },

    remove(path) {
        this.memory.delete(path);
        if (this.mode === 'localStorage' || !this.db) {
            this.flushLocalStorage();
            return;
        }
        this.chain = this.chain.then(() => new Promise((resolve) => {
            const tx = this.db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(path);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        }));
    },

    async clear() {
        this.memory.clear();
        if (this.mode === 'localStorage' || !this.db) {
            localStorage.removeItem(LS_FILES_KEY);
            return;
        }
        await new Promise((resolve) => {
            const tx = this.db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }
};

/* ---------------- 条目助手 ---------------- */

function itemPath(item) {
    return `${isTodoItem(item) ? TODO_DIR : NOTE_DIR}/${item.id}.md`;
}

function markItemKind(item, kind) {
    if (!item || typeof item !== 'object') return item;
    try {
        Object.defineProperty(item, ITEM_KIND_KEY, {
            value: kind,
            writable: true,
            enumerable: false,
            configurable: true
        });
    } catch (error) {
        // 对象被冻结等极端情况下退回线性查找
    }
    return item;
}

function isTodoItem(item) {
    if (!item || typeof item !== 'object') return false;
    const kind = item[ITEM_KIND_KEY];
    if (kind === 'todo') return true;
    if (kind === 'note') return false;
    const isTodo = State.todos.indexOf(item) !== -1;
    markItemKind(item, isTodo ? 'todo' : 'note');
    return isTodo;
}

function itemKindLabel(item) {
    return isTodoItem(item) ? '待办' : '笔记';
}

function itemDisplayTitle(item) {
    return item.title || `未命名${itemKindLabel(item)}`;
}

function isReadOnlyItem(item) {
    return !!(item && item.isTrashed);
}

function getItemById(itemId) {
    if (!itemId) return null;
    return State.todos.find((t) => t.id === itemId) || State.notes.find((n) => n.id === itemId) || null;
}

function generateItemId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(10);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (byte) => chars.charAt(byte % chars.length)).join('');
}

function generateUniqueItemId() {
    let id = generateItemId();
    while (getItemById(id)) id = generateItemId();
    return id;
}

// .md 文件 → 条目对象
function buildItemFromFile(path, text) {
    const isTodo = path.startsWith(`${TODO_DIR}/`);
    const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    const { meta, content } = parseItemFile(text);
    const now = Date.now();
    const item = {
        id,
        title: (meta ? readMetaString(meta.title) : '') || deriveTitle(content),
        content,
        folder: (meta ? readMetaString(meta.folder) : '') || DEFAULT_FOLDER,
        tags: meta ? readMetaTags(meta.tags) : [],
        isPinned: meta ? readMetaBoolean(meta.isPinned, false) : false,
        isTrashed: meta ? readMetaBoolean(meta.isTrashed, false) : false,
        createdAt: meta ? readMetaNumber(meta.createdAt, now) : now,
        updatedAt: meta ? readMetaNumber(meta.updatedAt, now) : now
    };
    if (isTodo) item.isDone = meta ? readMetaBoolean(meta.isDone, false) : false;
    // id 取自文件名；元数据里没有标题时按与桌面版一致的规则回落正文首行
    markItemKind(item, isTodo ? 'todo' : 'note');
    return item;
}

/* ---------------- 载入与保存 ---------------- */

// 启动时把本地文件全部读进内存并解析成条目
async function loadItemsFromStore() {
    const files = await FileStore.readAll();
    FileStore.memory = new Map(Object.entries(files));

    const notes = [];
    const todos = [];
    Object.keys(files).sort().forEach((path) => {
        if (path.startsWith(`${NOTE_DIR}/`) && path.endsWith('.md')) {
            notes.push(buildItemFromFile(path, files[path]));
        } else if (path.startsWith(`${TODO_DIR}/`) && path.endsWith('.md')) {
            todos.push(buildItemFromFile(path, files[path]));
        }
    });

    State.notes = notes;
    State.todos = todos;

    // 文件夹：以条目实际使用到的文件夹并集为准，另外并上配置里保存过的空文件夹
    const used = new Set();
    [...notes, ...todos].forEach((item) => { if (item.folder) used.add(item.folder); });
    const saved = new Set(State.folders);
    State.folders = [...new Set([DEFAULT_FOLDER, ...saved, ...used])];
}

// 保存单个条目：元数据与正文一起写回对应文件，并把改动排进同步队列
function saveItem(item) {
    if (!item) return false;
    const path = itemPath(item);
    const text = serializeItemFile(item, isTodoItem(item));
    const previous = FileStore.memory.get(path);
    if (previous === text) return false;

    FileStore.write(path, text);
    Sync.queueLocalChange('put', path);
    return true;
}

function deleteItemFile(item) {
    if (!item) return false;
    const path = itemPath(item);
    if (!FileStore.memory.has(path)) return false;
    FileStore.remove(path);
    Sync.queueLocalChange('del', path);
    return true;
}

// 远端推送过来的文本落进本地（不再回头排队推给服务端）
function applyRemoteFile(path, text) {
    FileStore.write(path, text);
    const item = buildItemFromFile(path, text);
    const isTodo = isTodoItem(item);
    State[isTodo ? 'todos' : 'notes'] = State[isTodo ? 'todos' : 'notes'].filter((entry) => entry.id !== item.id);
    State[isTodo ? 'todos' : 'notes'].push(item);
    if (!State.folders.includes(item.folder)) State.folders.push(item.folder);
    return item;
}

function removeRemoteFile(path) {
    const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    FileStore.remove(path);
    State.notes = State.notes.filter((item) => item.id !== id);
    State.todos = State.todos.filter((item) => item.id !== id);
    return id;
}

/* ---------------- 配置读写 ---------------- */

function saveConfig() {
    const payload = {
        folders: State.folders,
        theme: State.theme,
        themeStyle: State.themeStyle,
        accentColor: State.accentColor,
        brandColor: State.brandColor,
        cornerRadius: State.cornerRadius,
        sortBy: State.sortBy,
        viewMode: State.viewMode,
        sidebarCollapsed: State.sidebarCollapsed,
        spellcheck: State.spellcheck,
        trashRetentionDays: State.trashRetentionDays,
        uiMode: State.uiMode,
        tabsDisabled: State.tabsDisabled,
        fonts: {
            uiLatin: State.fonts.uiLatin,
            uiCjk: State.fonts.uiCjk,
            docLatin: State.fonts.docLatin,
            docCjk: State.fonts.docCjk
        },
        ai: {
            enabled: State.ai.enabled,
            agentMode: State.ai.agentMode,
            baseUrl: State.ai.baseUrl,
            model: State.ai.model,
            apiKey: State.ai.apiKey,
            scope: State.ai.scope,
            maxNotes: State.ai.maxNotes,
            systemPrompt: State.ai.systemPrompt
        },
        scratchpadLinkedId: State.scratchpadLinkedId,
        sync: {
            enabled: State.sync.enabled,
            url: State.sync.url,
            token: State.sync.token,
            device: State.sync.device,
            autoSync: State.sync.autoSync,
            autoSyncSeconds: State.sync.autoSyncSeconds,
            lastSeq: State.sync.lastSeq,
            journalId: State.sync.journalId,
            lastSyncAt: State.sync.lastSyncAt,
            lastSyncSummary: State.sync.lastSyncSummary
        }
    };
    try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(payload));
    } catch (error) {
        console.error('[ERROR] [Config] 配置写入失败: ' + (error && error.message));
    }
}

function loadConfig() {
    let parsed = null;
    try {
        parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    } catch (error) {
        console.warn('[WARN] [Config] 配置解析失败，按默认值启动: ' + (error && error.message));
    }
    if (!parsed || typeof parsed !== 'object') return;

    if (Array.isArray(parsed.folders) && parsed.folders.length) State.folders = parsed.folders;
    if (typeof parsed.theme === 'string') State.theme = parsed.theme;
    if (typeof parsed.themeStyle === 'string') State.themeStyle = parsed.themeStyle;
    if (typeof parsed.accentColor === 'string') State.accentColor = parsed.accentColor;
    if (typeof parsed.brandColor === 'string') State.brandColor = parsed.brandColor;
    if (typeof parsed.cornerRadius === 'string') State.cornerRadius = parsed.cornerRadius;
    if (typeof parsed.sortBy === 'string') State.sortBy = parsed.sortBy;
    if (typeof parsed.viewMode === 'string') State.viewMode = parsed.viewMode;
    State.sidebarCollapsed = !!parsed.sidebarCollapsed;
    State.spellcheck = !!parsed.spellcheck;
    State.trashRetentionDays = Number(parsed.trashRetentionDays) || 0;
    // 旧配置里可能存着 line / notab / minimal（旧名）与 standard（更早的经典布局名）
    State.uiMode = normalizeUiMode(parsed.uiMode);
    State.tabsDisabled = !!parsed.tabsDisabled;

    const fonts = parsed.fonts && typeof parsed.fonts === 'object' ? parsed.fonts : {};
    ['uiLatin', 'uiCjk', 'docLatin', 'docCjk'].forEach((key) => {
        if (typeof fonts[key] === 'string') State.fonts[key] = fonts[key];
    });

    const ai = parsed.ai && typeof parsed.ai === 'object' ? parsed.ai : {};
    State.ai.enabled = ai.enabled === undefined ? true : !!ai.enabled;
    State.ai.agentMode = !!ai.agentMode;
    State.ai.baseUrl = typeof ai.baseUrl === 'string' ? ai.baseUrl : '';
    State.ai.model = typeof ai.model === 'string' ? ai.model : '';
    State.ai.apiKey = typeof ai.apiKey === 'string' ? ai.apiKey : '';
    State.ai.scope = AI_SCOPE_VALUES.includes(ai.scope) ? ai.scope : 'current';
    State.ai.maxNotes = Math.max(1, Math.min(50, Number(ai.maxNotes) || 10));
    State.ai.systemPrompt = typeof ai.systemPrompt === 'string' ? ai.systemPrompt : '';
    if (typeof parsed.scratchpadLinkedId === 'string') State.scratchpadLinkedId = parsed.scratchpadLinkedId;

    const sync = parsed.sync && typeof parsed.sync === 'object' ? parsed.sync : {};
    State.sync.enabled = !!sync.enabled;
    State.sync.url = typeof sync.url === 'string' ? sync.url : '';
    State.sync.token = typeof sync.token === 'string' ? sync.token : '';
    State.sync.device = typeof sync.device === 'string' ? sync.device : '';
    State.sync.autoSync = typeof sync.autoSync === 'string' ? sync.autoSync : '5s';
    State.sync.autoSyncSeconds = Number(sync.autoSyncSeconds) || 60;
    State.sync.lastSeq = Number(sync.lastSeq) || 0;
    State.sync.journalId = typeof sync.journalId === 'string' ? sync.journalId : '';
    State.sync.lastSyncAt = Number(sync.lastSyncAt) || 0;
    State.sync.lastSyncSummary = typeof sync.lastSyncSummary === 'string' ? sync.lastSyncSummary : '';
}

/* ---------------- 列表过滤与搜索 ---------------- */

const PREVIEW_MAX_LENGTH = 120;

function isPreviewWhitespace(code) {
    return code <= 32
        || code === 0xa0
        || code === 0x1680
        || (code >= 0x2000 && code <= 0x200a)
        || code === 0x2028
        || code === 0x2029
        || code === 0x202f
        || code === 0x205f
        || code === 0x3000
        || code === 0xfeff;
}

function buildPreviewText(raw) {
    const text = String(raw || '');
    const length = text.length;
    let start = 0;
    while (start < length && isPreviewWhitespace(text.charCodeAt(start))) start++;
    if (start >= length) return '暂无内容';

    const lineBreak = text.indexOf('\n', start);
    let end = lineBreak === -1 ? length : lineBreak;
    while (end > start && isPreviewWhitespace(text.charCodeAt(end - 1))) end--;

    const firstLine = text.slice(start, end);
    return firstLine.length > PREVIEW_MAX_LENGTH ? firstLine.slice(0, PREVIEW_MAX_LENGTH) : firstLine;
}

const PREVIEW_TEXT_CACHE = new WeakMap();

function itemPreviewText(item) {
    const raw = typeof item.content === 'string' ? item.content : '';
    const cached = PREVIEW_TEXT_CACHE.get(item);
    if (cached && cached.source === raw) return cached.text;
    const text = buildPreviewText(raw);
    PREVIEW_TEXT_CACHE.set(item, { source: raw, text });
    return text;
}

const SEARCH_TEXT_CACHE = new WeakMap();

function itemSearchText(item) {
    const title = typeof item.title === 'string' ? item.title : '';
    const content = typeof item.content === 'string' ? item.content : '';
    const cached = SEARCH_TEXT_CACHE.get(item);
    if (cached && cached.title === title && cached.content === content) return cached.text;
    const text = `${title}\n${content}`.toLowerCase();
    SEARCH_TEXT_CACHE.set(item, { title, content, text });
    return text;
}

// 当前筛选下的条目：笔记 / 待办各自一个入口，其余视图两类混排，置顶优先
function getFilteredItems() {
    const filter = State.currentFilter;
    const isTrashView = filter === 'trash';
    const isPinnedView = filter === 'pinned';
    const onlyNotes = filter === 'all';
    const onlyTodos = filter === 'todos';
    const folderFilter = filter.startsWith('folder:') ? filter.slice(7) : null;
    const tagFilter = filter.startsWith('tag:') ? filter.slice(4) : null;
    const query = State.searchQuery.trim().toLowerCase();
    const sortBy = State.sortBy;

    const list = [];
    const consider = (item, isTodo) => {
        if (onlyNotes && isTodo) return;
        if (onlyTodos && !isTodo) return;

        if (item.isTrashed) {
            if (!isTrashView) return;
        } else {
            if (isTrashView) return;
            if (isPinnedView && !item.isPinned) return;
            if (folderFilter !== null && item.folder !== folderFilter) return;
            if (tagFilter !== null && (!Array.isArray(item.tags) || !item.tags.includes(tagFilter))) return;
        }

        if (query && !itemSearchText(item).includes(query)) return;
        list.push(item);
    };
    State.notes.forEach((item) => consider(item, false));
    State.todos.forEach((item) => consider(item, true));

    return list.sort((a, b) => {
        if (!isTrashView) {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
        }
        if (sortBy === 'updated-desc') return b.updatedAt - a.updatedAt;
        if (sortBy === 'created-desc') return b.createdAt - a.createdAt;
        if (sortBy === 'title-asc') return itemDisplayTitle(a).localeCompare(itemDisplayTitle(b), 'zh-CN');
        return 0;
    });
}

function getAllTags() {
    const tags = new Set();
    [...State.notes, ...State.todos].filter((item) => !item.isTrashed).forEach((item) => {
        if (Array.isArray(item.tags)) item.tags.forEach((tag) => { if (tag) tags.add(tag); });
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function panelCategoryTitle(filter) {
    if (filter === 'all') return '全部笔记';
    if (filter === 'todos') return '全部待办';
    if (filter === 'pinned') return '已置顶';
    if (filter === 'trash') return '废纸篓';
    if (filter.startsWith('folder:')) return filter.replace('folder:', '');
    if (filter.startsWith('tag:')) return `#${filter.replace('tag:', '')}`;
    return '全部笔记';
}

function searchPlaceholderText(filter) {
    if (filter === 'all') return '搜索笔记... (Ctrl+K)';
    if (filter === 'todos') return '搜索待办... (Ctrl+K)';
    return '搜索笔记与待办... (Ctrl+K)';
}

/* ---------------- 数据备份 ---------------- */

// 导出备份：条目数组，导入时按同一套规则恢复
function exportBackup() {
    return {
        version: 1,
        exportedAt: Date.now(),
        folders: State.folders,
        items: [...State.notes, ...State.todos].map((item) => ({
            id: item.id,
            kind: isTodoItem(item) ? 'todo' : 'note',
            title: item.title,
            content: item.content,
            folder: item.folder,
            tags: item.tags,
            isPinned: !!item.isPinned,
            isTrashed: !!item.isTrashed,
            isDone: !!item.isDone,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt
        }))
    };
}

// 导入备份：id 重复、时间戳非法、字段类型不对的条目在此一并规范化
function importBackup(raw, { replace = false } = {}) {
    const list = raw && Array.isArray(raw.items) ? raw.items : [];
    if (!list.length) return 0;

    if (replace) {
        State.notes = [];
        State.todos = [];
        FileStore.memory.forEach((text, path) => {
            if (path.startsWith(`${NOTE_DIR}/`) || path.startsWith(`${TODO_DIR}/`)) FileStore.remove(path);
        });
    }

    const used = new Set([...State.notes, ...State.todos].map((item) => item.id));
    let imported = 0;
    list.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const isTodo = entry.kind === 'todo';
        let id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || used.has(id)) id = generateUniqueItemId();
        used.add(id);

        const now = Date.now();
        const createdAt = Number(entry.createdAt);
        const updatedAt = Number(entry.updatedAt);
        const item = {
            id,
            title: typeof entry.title === 'string' ? entry.title : '',
            content: typeof entry.content === 'string' ? entry.content : '',
            folder: typeof entry.folder === 'string' && entry.folder.trim() ? entry.folder.trim() : DEFAULT_FOLDER,
            tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string' && tag.trim()) : [],
            isPinned: !!entry.isPinned,
            isTrashed: !!entry.isTrashed,
            createdAt: Number.isFinite(createdAt) ? Math.round(createdAt) : now,
            updatedAt: Number.isFinite(updatedAt) ? Math.round(updatedAt) : now
        };
        if (isTodo) item.isDone = !!entry.isDone;
        markItemKind(item, isTodo ? 'todo' : 'note');
        State[isTodo ? 'todos' : 'notes'].push(item);
        if (!State.folders.includes(item.folder)) State.folders.push(item.folder);
        saveItem(item);
        imported += 1;
    });
    return imported;
}

async function clearAllData() {
    await FileStore.clear();
    State.notes = [];
    State.todos = [];
    State.folders = [DEFAULT_FOLDER];
    State.openNoteIds = [];
    State.activeNoteId = null;
    // 副本与队列一起丢掉，并把同步位置归零：下次同步会从服务器重新拉回全部内容
    Sync.outbox = [];
    Sync.writeOutbox();
    State.sync.lastSeq = 0;
    State.sync.lastSyncAt = 0;
    State.sync.lastSyncSummary = '';
    saveConfig();
}
