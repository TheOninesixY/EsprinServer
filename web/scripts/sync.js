/* 同步客户端：把托管网页版的 EsprinServer 直接当存储用。
   协议与桌面版 src/main/sync_server.js 一致：
     - 本地以「文件 → 文本」为最小单位，接口路径即 notes/{id}.md、todos/{id}.md；
     - 每个文件改动生成一条 put / del 操作，同路径的旧操作在入队时被合并；
     - 拉取时按 seq 递增应用远端操作，本地有未推送改动时保留本地。

   鉴权：服务端一律要求凭据，没拿到登录态就无法读写。网页版由本服务端托管，
   默认走同源的 /admin 登录会话（Cookie）；也可以在设置里填访问令牌改用 Bearer 方式。 */

const SYNC_PATH = '/sync';
const HEALTH_PATH = '/health';
const ADMIN_STATUS_PATH = '/admin/api/status';
const ADMIN_LOGIN_PATH = '/admin/api/login';
const ADMIN_LOGOUT_PATH = '/admin/api/logout';
const PAGE_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 15000;
const PUSH_DEBOUNCE_MS = 800;
/* 可复用 ID：条目被删除后 ID 会回到服务端的回收池，新建条目时领一个来用。
   一次多领一两个，连着我新建也能用上；领了没用上的会在服务端超时自动回到池子。 */
const RECYCLE_CLAIM_PATH = `${SYNC_PATH}/ids/claim`;
const RECYCLE_CLAIM_COUNT = 2;
const AUTO_SYNC_PRESETS = { off: 0, '5s': 5, '1m': 60, '5m': 300, startup: 0 };

/* ---------------- SHA-256 ----------------
   同步协议里的 hash 是「文件字节的 sha256」，服务端与桌面端都按这个口径比对。
   crypto.subtle 只在安全上下文（https 或 localhost）可用，局域网 http 下会缺失，
   因此这里自带一份实现，任何访问方式下都能算出一致的摘要。 */

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const SHA256_INIT = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

function rotateRight(value, bits) {
    return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function utf8Bytes(text) {
    if (window.TextEncoder) return new TextEncoder().encode(text);
    const encoded = unescape(encodeURIComponent(text));
    const bytes = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
    return bytes;
}

function sha256Hex(bytes) {
    const length = bytes.length;
    const padded = length + 1 + ((56 - (length + 1) % 64) + 64) % 64 + 8;
    const buffer = new Uint8Array(padded);
    buffer.set(bytes);
    buffer[length] = 0x80;

    const view = new DataView(buffer.buffer);
    view.setUint32(padded - 8, Math.floor(length / 0x20000000) >>> 0, false);
    view.setUint32(padded - 4, (length << 3) >>> 0, false);

    const hash = SHA256_INIT.slice();
    const w = new Uint32Array(64);

    for (let offset = 0; offset < padded; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15];
            const y = w[i - 2];
            const s0 = (rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)) >>> 0;
            const s1 = (rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)) >>> 0;
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let a = hash[0];
        let b = hash[1];
        let c = hash[2];
        let d = hash[3];
        let e = hash[4];
        let f = hash[5];
        let g = hash[6];
        let h = hash[7];

        for (let i = 0; i < 64; i++) {
            const s1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
            const ch = ((e & f) ^ (~e & g)) >>> 0;
            const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
            const s0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
            const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
            const temp2 = (s0 + maj) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }

    return Array.from(hash, (value) => value.toString(16).padStart(8, '0')).join('');
}

function hashText(text) {
    return `sha256:${sha256Hex(utf8Bytes(text))}`;
}

/* ---------------- 同步状态 ---------------- */

const Sync = {
    outbox: [],
    running: false,
    scheduled: null,
    timer: null,
    lastError: '',
    // 连接状态：idle / connecting / auth（等待登录）/ ready / error
    connection: 'idle',
    connectionMessage: '',
    serverInfo: null,
    // 从服务端领回来的可复用 ID（删除腾出来的 ID，新建条目优先取用）
    recycledIds: [],
    // 本机刚彻底删掉的条目腾出来的 ID：最优先（服务端那边随后也会把它收进回收池）
    locallyFreedIds: [],
    recycling: false,

    init() {
        this.readOutbox();
        this.applyAutoSyncRuntime();
    },

    /* ---------------- 连接与鉴权 ---------------- */

    /* 探测服务端并确认凭据：先要一份无需授权的服务端信息，再用它判断该走登录还是填令牌；
       最后拿同步接口试一次，能读就说明凭据可用。 */
    async connect({ reason = '启动' } = {}) {
        this.connection = 'connecting';
        this.connectionMessage = '';
        this.renderIndicator('busy');

        const health = await this.apiRequest('GET', HEALTH_PATH, null, 8000);
        if (!health.ok) {
            this.connection = 'error';
            this.connectionMessage = health.error;
            this.renderIndicator('error');
            return { ok: false, error: health.error, needAuth: false };
        }
        this.serverInfo = health.data || {};

        const probe = await this.apiRequest('GET', `${SYNC_PATH}/state`, null, 10000);
        if (probe.ok) return this.startStorage(reason);

        if (probe.status === 401) {
            this.connection = 'auth';
            this.connectionMessage = '需要登录或填写访问令牌后才能读写服务端';
            this.renderIndicator('auth');
            return { ok: false, error: this.connectionMessage, needAuth: true };
        }

        this.connection = 'error';
        this.connectionMessage = probe.error;
        this.renderIndicator('error');
        return { ok: false, error: probe.error, needAuth: false };
    },

    // 凭据可用：把同步打开，首次使用先做一次全量接入
    async startStorage(reason) {
        State.sync.enabled = true;
        saveConfig();
        this.connection = 'ready';
        this.lastError = '';
        this.applyAutoSyncRuntime();

        const first = !State.sync.lastSyncAt;
        let result = first ? await this.importLocal() : await this.syncNow({ reason });
        if (!result.ok) {
            this.connection = 'error';
            this.connectionMessage = result.error;
            this.renderIndicator();
            return result;
        }

        // 还没接入过服务端时建立的条目没进过队列：接入时补一次「服务器从未见过」的扫描
        if (!first) {
            const unknown = await this.pushUnknownLocalFiles();
            if (!unknown.ok) {
                this.connection = 'error';
                this.connectionMessage = unknown.error;
                this.renderIndicator();
                return { ok: false, error: unknown.error };
            }
            if (unknown.queued) {
                const pushed = await this.pushOutbox();
                if (!pushed.ok) {
                    this.connection = 'error';
                    this.connectionMessage = pushed.error;
                    this.renderIndicator();
                    return { ok: false, error: pushed.error };
                }
                result = { ok: true, summary: `上传 ${unknown.queued} 个本地条目` };
            }
        }

        this.connection = 'ready';
        this.connectionMessage = '';
        this.renderIndicator();
        // 连接就绪：先把可复用的 ID 领一批，之后新建条目就能直接用上
        this.refillRecycledIds().catch(() => {});
        return result;
    },

    // 管理密码登录：成功后服务端会下发同源会话 Cookie，后续同步接口直接复用
    async login(password) {
        const result = await this.apiRequest('POST', ADMIN_LOGIN_PATH, { password }, 10000);
        if (!result.ok) return { ok: false, error: result.error };
        // 服务端允许同名会话，登录成功即可先连通，再由调用方发起同步
        return this.connect({ reason: '登录' });
    },

    async logout() {
        await this.apiRequest('POST', ADMIN_LOGOUT_PATH, {}, 8000);
        State.sync.enabled = false;
        State.sync.token = '';
        saveConfig();
        this.connection = 'idle';
        this.connectionMessage = '';
        this.applyAutoSyncRuntime();
        this.renderIndicator();
        return { ok: true };
    },

    // 服务端是否已经设过管理密码（决定连接面板默认展示登录还是令牌）
    authHint() {
        const info = this.serverInfo || {};
        // 没设密码就只能填访问令牌：可能是 --token 启动，也可能是还没去 /admin 建过令牌
        return info.passwordSet ? 'password' : 'token';
    },

    /* ---------------- 待推送队列 ---------------- */

    readOutbox() {
        try {
            const parsed = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
            this.outbox = Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn('[WARN] [Sync] 待推送队列读取失败: ' + (error && error.message));
            this.outbox = [];
        }
    },

    writeOutbox() {
        try {
            localStorage.setItem(OUTBOX_KEY, JSON.stringify(this.outbox));
        } catch (error) {
            console.error('[ERROR] [Sync] 待推送队列写入失败: ' + (error && error.message));
        }
    },

    // 同一路径只保留最后一条：中间过程没有意义，少推几条也让日志更干净
    mergeOp(op) {
        this.outbox = this.outbox.filter((entry) => entry.path !== op.path);
        this.outbox.push(op);
        this.writeOutbox();
    },

    pendingFor(path) {
        return this.outbox.some((entry) => entry.path === path);
    },

    makeOpId() {
        const deviceId = this.deviceId();
        return `${deviceId}-${Date.now().toString(36)}-${this.outbox.length + 1}-${Math.floor(Math.random() * 1e4)}`;
    },

    deviceId() {
        if (!State.sync.device) {
            const bytes = new Uint8Array(3);
            if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
            else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
            State.sync.device = `web-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
            saveConfig();
        }
        return State.sync.device;
    },

    /* 本地文件变动入队（保存、删除都走这里）。断线或凭据失效时同样入队：
       队列存在 localStorage 里，重新登录后会被推上去，期间的改动不会丢；
       同时 pendingFor 会让拉取跳开这些路径，本地改动不会被远端旧内容覆盖。 */
    queueLocalChange(kind, path) {
        const op = kind === 'del'
            ? { opId: this.makeOpId(), op: 'del', path, time: Date.now() }
            : this.buildPutOp(path);
        if (!op) return;
        // 彻底删除：这个 ID 本地立刻就能再用（服务端那边随后把它收进回收池），
        // 下一次新建的条目会直接用它，不必等一次同步往返
        if (kind === 'del') this.releaseRecycledId(path);
        this.mergeOp(op);
        this.schedulePush();
        this.renderIndicator('pending');
    },

    // 本地刚删掉的条目：把它的 ID 放进本地清单（最优先，不必等同步往返）
    releaseRecycledId(path) {
        const match = /^(notes|todos)\/([A-Za-z0-9_-]{1,64})\.md$/.exec(String(path || ''));
        if (!match) return;
        const entry = { id: match[2], kind: match[1], path: String(path) };
        this.locallyFreedIds = [entry].concat(this.locallyFreedIds.filter((item) => item.id !== entry.id));
    },

    // 从一份清单里取一个 ID：优先同类型，没有同类型就取队首；取走即从清单里移除
    takePoolId(list, prefix) {
        if (!list.length) return '';
        const sameKind = list.findIndex((item) => item.kind === prefix);
        const entry = list.splice(sameKind === -1 ? 0 : sameKind, 1)[0];
        return entry ? String(entry.id) : '';
    },

    buildPutOp(path) {
        const text = FileStore.memory.get(path);
        if (typeof text !== 'string') return null;
        return {
            opId: this.makeOpId(),
            op: 'put',
            path,
            time: Date.now(),
            hash: hashText(text),
            encoding: 'utf8',
            data: text
        };
    },

    // 本地改动后延迟推送：连续编辑只触发一次请求
    schedulePush() {
        if (!State.sync.enabled) return;
        clearTimeout(this.scheduled);
        this.scheduled = setTimeout(() => {
            this.scheduled = null;
            this.pushOutbox();
        }, PUSH_DEBOUNCE_MS);
    },

    /* ---------------- 接口调用 ---------------- */

    baseUrl() {
        const raw = String(State.sync.url || '').trim().replace(/\/+$/, '');
        if (raw) return raw;
        // 未填地址时默认指回当前站点：网页版本身由同步服务端托管
        return window.location.origin;
    },

    async apiRequest(method, pathname, body, timeoutMs = REQUEST_TIMEOUT_MS) {
        const base = this.baseUrl();
        if (!base) return { ok: false, error: '尚未填写同步服务器地址' };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const headers = { Accept: 'application/json' };
            if (State.sync.token) headers.Authorization = `Bearer ${State.sync.token}`;
            if (body) headers['Content-Type'] = 'application/json';

            const response = await fetch(base + pathname, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                credentials: 'same-origin',
                signal: controller.signal
            });

            let payload = null;
            try {
                payload = await response.json();
            } catch (error) {
                payload = null;
            }

            if (!response.ok) {
                const detail = payload && payload.error ? String(payload.error) : this.describeHttpError(response.status);
                // 会话过期或凭据被重置：标成待登录，并只在状态跃迁时弹出连接层（避免轮询反复弹）
                if (response.status === 401 && pathname !== ADMIN_LOGIN_PATH) {
                    const wasAuth = this.connection === 'auth';
                    this.connection = 'auth';
                    this.connectionMessage = detail;
                    if (!wasAuth && typeof showConnectGate === 'function') showConnectGate(detail);
                }
                return { ok: false, status: response.status, error: detail };
            }
            return { ok: true, data: payload || {} };
        } catch (error) {
            if (error && error.name === 'AbortError') return { ok: false, error: '请求超时，请确认服务器地址与网络' };
            return { ok: false, error: this.describeNetworkError(error) };
        } finally {
            clearTimeout(timer);
        }
    },

    describeHttpError(status) {
        if (status === 401) return '凭据无效或已过期（请重新登录管理密码，或填写访问令牌）';
        if (status === 403) return '服务端拒绝访问';
        if (status === 404) return '接口不存在，请确认地址指向 EsprinServer 且版本一致';
        if (status >= 500) return '服务端返回错误';
        return `请求失败（HTTP ${status}）`;
    },

    describeNetworkError(error) {
        const message = error && error.message ? String(error.message) : '';
        if (/Failed to fetch|NetworkError|load failed/i.test(message)) {
            return '无法连接到服务器，请确认它已启动、地址与端口正确';
        }
        if (/certificate|SSL|TLS/i.test(message)) return 'TLS 证书校验失败，请检查服务器地址与证书';
        return message ? `请求失败：${message}` : '请求失败：无法连接到服务器';
    },

    /* ---------------- 拉取 ---------------- */

    async ensureJournalIdentity() {
        const health = await this.apiRequest('GET', `${SYNC_PATH}/health`, null, 8000);
        if (!health.ok) return health;

        const journalId = String(health.data.journalId || '');
        if (journalId && State.sync.journalId && journalId !== State.sync.journalId) {
            // 换了一个服务端（或日志被重建）：序号不可比，从头拉
            logSyncState(`服务端日志身份已变化，序号归零（journalId=${journalId}）`);
            State.sync.lastSeq = 0;
        }
        State.sync.journalId = journalId;
        saveConfig();
        return { ok: true, journalId, latestSeq: Number(health.data.latestSeq) || 0 };
    },

    async pullOps({ full = false } = {}) {
        // 全量拉取只把序号归零：日志身份由 ensureJournalIdentity 维护，这里不能清掉
        if (full) State.sync.lastSeq = 0;

        let since = State.sync.lastSeq;
        let applied = 0;
        let scanned = 0;
        let changed = false;

        for (let page = 0; page < 200; page++) {
            const result = await this.apiRequest('GET', `${SYNC_PATH}/ops?since=${since}&limit=${PAGE_LIMIT}`);
            if (!result.ok) return { ok: false, error: result.error };

            const ops = Array.isArray(result.data.ops) ? result.data.ops : [];
            for (const op of ops) {
                scanned += 1;
                const seq = Number(op.seq) || 0;
                if (seq > State.sync.lastSeq) State.sync.lastSeq = seq;
                if (this.applyRemoteOp(op)) {
                    applied += 1;
                    changed = true;
                }
            }

            const hasMore = !!result.data.hasMore;
            if (!hasMore || !ops.length) break;
            since = State.sync.lastSeq;
        }

        // 拉取游标已经越过自推的那些序号：服务端不会再发下来，记着也没用
        const pruned = this.pruneSelfPushed();
        if (changed || pruned) {
            State.sync.lastSeq = Math.max(State.sync.lastSeq, 0);
            saveConfig();
        }
        return { ok: true, applied, scanned, changed };
    },

    /* ---------------- 自推的操作序号 ----------------

       本机推上去、服务端已受理的操作序号。两处用到：重放时跳过它们（本地早就落盘了，
       再应用一遍只会把后来的内容冲掉）；拉取游标越过的就丢掉（服务端不会再发下来）。 */
    isSelfPushed(seq) {
        const value = Math.round(Number(seq) || 0);
        return value > 0 && (State.sync.selfPushed || []).includes(value);
    },

    rememberSelfPushed(seqs) {
        const merged = new Set((State.sync.selfPushed || []).map((value) => Math.round(Number(value))));
        seqs.forEach((seq) => {
            const value = Math.round(Number(seq) || 0);
            if (value > 0) merged.add(value);
        });
        State.sync.selfPushed = [...merged]
            .filter((seq) => seq > (State.sync.lastSeq || 0))
            .sort((a, b) => a - b);
        saveConfig();
    },

    // 拉取游标已经越过的自推序号可以丢掉了
    pruneSelfPushed() {
        const kept = (State.sync.selfPushed || []).filter((seq) => seq > (State.sync.lastSeq || 0));
        if (kept.length === (State.sync.selfPushed || []).length) return false;
        State.sync.selfPushed = kept;
        return true;
    },

    // 应用一条远端操作：只认 notes/ 与 todos/ 下的 Markdown，
    // 本地有未推送改动时保留本地（与桌面版的 keep-local 策略一致）
    applyRemoteOp(op) {
        const path = String(op && op.path ? op.path : '');
        if (!path.startsWith('notes/') && !path.startsWith('todos/')) return false;
        if (!path.endsWith('.md')) return false;
        // 本机自己推上去的操作不必再应用一遍：本地早就落盘了。
        // 彻底删掉一个条目、又用回收的 ID 新建之后，本机很可能还没拉到自己那条删除，
        // 重放它就会把刚新建的条目删掉——这条跳过就是为此。
        if (this.isSelfPushed(op.seq)) return false;
        if (this.pendingFor(path)) return false;

        if (op.op === 'del') {
            if (!FileStore.memory.has(path)) return false;
            removeRemoteFile(path);
            logSyncState(`远端删除已应用 (path=${path})`);
            return true;
        }

        if (op.op !== 'put' || typeof op.data !== 'string') return false;
        if (op.encoding === 'base64') return false;

        const local = FileStore.memory.get(path);
        if (typeof local === 'string' && local === op.data) return false;
        if (typeof local === 'string' && op.hash && hashText(local) === op.hash) return false;

        applyRemoteFile(path, op.data);
        logSyncState(`远端写入已应用 (path=${path})`);
        return true;
    },

    /* ---------------- 推送 ---------------- */

    async pushOutbox() {
        if (!State.sync.enabled) return { ok: true, pushed: 0, remaining: this.outbox.length };
        if (!this.outbox.length) return { ok: true, pushed: 0, remaining: 0 };

        const batch = this.outbox.slice(0, PAGE_LIMIT);
        const result = await this.apiRequest('POST', `${SYNC_PATH}/ops`, {
            device: this.deviceId(),
            ops: batch
        });

        if (!result.ok) {
            this.lastError = result.error;
            this.renderIndicator('error');
            return { ok: false, error: result.error, pushed: 0, remaining: this.outbox.length };
        }

        const accepted = Array.isArray(result.data.accepted) ? result.data.accepted : [];
        // 服务端受理的序号记下来：重放时跳过这些操作（见 applyRemoteOp）
        this.rememberSelfPushed(accepted
            .filter((item) => item && !item.error && Number(item.seq) > 0)
            .map((item) => Number(item.seq)));
        const failedIds = new Set(accepted.filter((item) => item && item.error).map((item) => item.opId));
        const sentIds = new Set(batch.map((item) => item.opId));
        const before = this.outbox.length;
        // 服务端明确报错的条目留在队列里，其余（含重复提交）都算已交付
        this.outbox = this.outbox.filter((item) => !sentIds.has(item.opId) || failedIds.has(item.opId));
        this.writeOutbox();

        const firstError = accepted.find((item) => item && item.error);
        if (firstError) {
            this.lastError = `部分操作被拒绝：${firstError.error}`;
            this.renderIndicator('error');
        }

        // 只有确实推进了队列才继续下一批：被拒绝的条目留在队列里，不能反复重推
        if (this.outbox.length && this.outbox.length < before) return this.pushOutbox();
        if (this.outbox.length) {
            return { ok: false, error: this.lastError || '部分改动未能推送', pushed: before - this.outbox.length, remaining: this.outbox.length };
        }
        // 刚推上去的删除把那个 ID 交回了服务端的回收池：顺手补一批可复用 ID
        if (batch.some((op) => op.op === 'del' && !failedIds.has(op.opId))) this.refillRecycledIds().catch(() => {});
        return { ok: true, pushed: batch.length, remaining: 0 };
    },

    /* ---------------- 可复用 ID ---------------- */

    /* 条目被删除后，它的 ID 会回到服务端的回收池（删除记录仍留着，别处的老副本不会被推回来）。
       新建条目时优先领一个来用：被删掉的那一条腾出来的 ID 会重新落到新建的条目上。
       服务端会把领走的 ID 占住一会儿，所以两台设备同时新建也不会撞到同一个。 */
    async refillRecycledIds(retry = true) {
        if (!State.sync.enabled || this.recycling) return { ok: false };
        this.recycling = true;
        try {
            const claim = () => this.apiRequest('POST', RECYCLE_CLAIM_PATH, {
                device: this.deviceId(),
                count: RECYCLE_CLAIM_COUNT,
                // 只领「本机已经重放过那条删除」的 ID：否则新建好的条目会被自己还没拉到的删除擦掉
                since: State.sync.lastSeq
            }, 8000);

            let result = await claim();
            // 池子里有 ID，但本机还没重放过对应的删除：先同步一次，再领一遍就有了
            if (result.ok && retry && !(result.data.ids || []).length && Number(result.data.pending) > 0) {
                const synced = await this.syncNow({ reason: '回收 ID' });
                if (synced.ok) result = await claim();
            }
            if (!result.ok) return { ok: false, error: result.error };

            const ids = Array.isArray(result.data.ids) ? result.data.ids : [];
            // 服务端可能给出本机还在用着的 ID（本地那一条还没被删掉）：这类丢掉，别拿它去建新条目
            const usable = ids.filter((item) => item && item.id && !FileStore.memory.has(String(item.path)));
            // 领到新的就换上；服务端这次没有可发的，手里那几个先留着（它们在服务端仍然被占着）
            if (usable.length) this.recycledIds = usable;
            return { ok: true, count: this.recycledIds.length };
        } finally {
            this.recycling = false;
        }
    },

    // 取一个回收来的 ID：优先同类型（笔记的给笔记、待办的给待办），没有就退而求其次
    takeRecycledId(kind) {
        const prefix = kind === 'todo' ? TODO_DIR : NOTE_DIR;
        // 本机刚彻底删掉的那几个最优先：本地确信那一条已经删干净了
        const local = this.takePoolId(this.locallyFreedIds, prefix);
        if (local) return local;

        if (!this.recycledIds.length) {
            // 手里没存货：先补一批（这一次新建先按老办法随机生成，不在这里顺带做一次同步）
            this.refillRecycledIds(false).catch(() => {});
            return '';
        }
        const id = this.takePoolId(this.recycledIds, prefix);
        // 池子见底就顺手补一批，下一次新建仍然能拿到回收的 ID
        if (!this.recycledIds.length) this.refillRecycledIds().catch(() => {});
        return id;
    },

    /* ---------------- 组合动作 ---------------- */

    async syncNow({ full = false, reason = '手动' } = {}) {
        if (this.running) return { ok: false, error: '同步正在进行中' };
        if (!State.sync.enabled) return { ok: false, error: '尚未连接到服务端' };

        this.running = true;
        this.lastError = '';
        this.renderIndicator('busy');

        try {
            // 日志身份只在首次同步或显式全量时校验：空闲态每次同步只发一个 ops 请求
            if (full || !State.sync.journalId) {
                const identity = await this.ensureJournalIdentity();
                if (!identity.ok) return this.finishSync(false, identity.error, reason);
            }

            const pulled = await this.pullOps({ full });
            if (!pulled.ok) return this.finishSync(false, pulled.error, reason);

            let pushed = { ok: true, pushed: 0 };
            if (this.outbox.length) {
                pushed = await this.pushOutbox();
                if (!pushed.ok) return this.finishSync(false, pushed.error, reason);
            }

            const summary = `拉取 ${pulled.applied} 条，推送 ${pushed.pushed} 条`;
            State.sync.lastSyncAt = Date.now();
            State.sync.lastSyncSummary = reason === '手动' ? summary : `${reason}同步：${summary}`;
            saveConfig();

            if (pulled.changed) {
                if (typeof refreshAfterRemoteChange === 'function') refreshAfterRemoteChange();
            }
            this.connection = 'ready';
            this.connectionMessage = '';
            this.renderIndicator('idle');
            return this.finishSync(true, '', reason, summary);
        } finally {
            this.running = false;
        }
    },

    finishSync(ok, error, reason, summary = '') {
        if (!ok) {
            this.lastError = error;
            State.sync.lastSyncSummary = error;
            saveConfig();
            this.renderIndicator('error');
            logSyncState(`同步失败 (reason=${reason}, detail=${error})`);
            return { ok: false, error };
        }
        logSyncState(`同步完成 (reason=${reason}, ${summary})`);
        return { ok: true, summary };
    },

    // 首次接入：先把远端日志全部重放（以服务端为准），再把服务端从未见过的本地文件推上去
    async importLocal() {
        if (!State.sync.enabled) return { ok: false, error: '尚未连接到服务端' };
        // 全量接入期间占用同步锁：定时同步不会插进来同时读写
        if (this.running) return { ok: false, error: '同步正在进行中' };
        this.running = true;

        try {
            const identity = await this.ensureJournalIdentity();
            if (!identity.ok) return { ok: false, error: identity.error };

            const pulled = await this.pullOps({ full: true });
            if (!pulled.ok) return { ok: false, error: pulled.error };

            const unknown = await this.pushUnknownLocalFiles();
            if (!unknown.ok) return { ok: false, error: unknown.error };

            const pushed = await this.pushOutbox();
            if (!pushed.ok) return { ok: false, error: pushed.error };

            State.sync.lastSyncAt = Date.now();
            State.sync.lastSyncSummary = `首次接入：拉取 ${pulled.applied} 条，推送 ${unknown.queued} 个本地文件`;
            saveConfig();
            this.connection = 'ready';
            if (pulled.changed && typeof refreshAfterRemoteChange === 'function') refreshAfterRemoteChange();
            this.renderIndicator('idle');
            logSyncState(`首次接入完成 (pulled=${pulled.applied}, pushed=${unknown.queued})`);
            return { ok: true, summary: State.sync.lastSyncSummary };
        } finally {
            this.running = false;
        }
    },

    /* 把服务器「从未见过」的本地条目排进队列。
       /sync/state 里的 files 是现存文件，deleted 是历史上被删过的路径，两者都算见过：
       后者用来避免把本地残留的旧副本当成新内容重新推回去。 */
    async pushUnknownLocalFiles() {
        const stateResult = await this.apiRequest('GET', `${SYNC_PATH}/state`);
        if (!stateResult.ok) return { ok: false, error: stateResult.error };

        const known = new Set([
            ...Object.keys(stateResult.data.files || {}),
            ...Object.keys(stateResult.data.deleted || {})
        ]);

        let queued = 0;
        FileStore.memory.forEach((text, path) => {
            if (!path.startsWith('notes/') && !path.startsWith('todos/')) return;
            if (known.has(path) || this.pendingFor(path)) return;
            const op = this.buildPutOp(path);
            if (!op) return;
            this.mergeOp(op);
            queued += 1;
        });
        return { ok: true, queued };
    },

    /* ---------------- 自动同步 ---------------- */

    applyAutoSyncRuntime() {
        clearInterval(this.timer);
        this.timer = null;
        if (!State.sync.enabled) return;
        if (State.sync.autoSync === 'startup') {
            setTimeout(() => { this.syncNow({ reason: '启动' }); }, 3000);
            return;
        }
        const seconds = State.sync.autoSync === 'custom'
            ? Math.max(5, Number(State.sync.autoSyncSeconds) || 60)
            : AUTO_SYNC_PRESETS[State.sync.autoSync] || 0;
        if (!seconds) return;
        this.timer = setInterval(() => { this.syncNow({ reason: '自动' }); }, seconds * 1000);
    },

    /* ---------------- 状态展示 ---------------- */

    renderIndicator(state) {
        if (typeof renderSyncIndicator === 'function') renderSyncIndicator(state);
    },

    statusText() {
        if (!State.sync.enabled) return '本地';
        if (this.running) return '同步中';
        if (this.lastError) return '同步异常';
        if (this.outbox.length) return `待推送 ${this.outbox.length}`;
        return '已连接';
    }
};

function logSyncState(message) {
    console.log(`[INFO] [Sync] ${message}`);
}
