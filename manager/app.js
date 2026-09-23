const API_BASE = '/api';

const $ = (id) => document.getElementById(id);

const LIGHT_QUERY = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme() {
    document.documentElement.classList.toggle('light', LIGHT_QUERY.matches);
}

function initTheme() {
    applyTheme();
    LIGHT_QUERY.addEventListener('change', applyTheme);
}

let toastTimer = 0;

function toast(text, tone = 'ok') {
    const element = $('toast');
    element.textContent = text;
    element.dataset.tone = tone;
    element.hidden = false;
    requestAnimationFrame(() => element.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        element.classList.remove('show');
        setTimeout(() => { element.hidden = true; }, 220);
    }, 2600);
}

function setMessage(id, text, tone = '') {
    const element = $(id);
    element.textContent = text;
    element.dataset.tone = tone;
}

function formatTime(stamp) {
    if (!stamp) return '未使用过';
    const date = new Date(Number(stamp));
    if (Number.isNaN(date.getTime())) return '未使用过';
    return date.toLocaleString('zh-CN', { hour12: false });
}

async function copyText(text, button) {
    const value = String(text || '').trim();
    if (!value) {
        toast('这里还没有内容可复制', 'error');
        return false;
    }

    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(value);
            copied = true;
        } catch (error) {
            copied = false;
        }
    }
    if (!copied) copied = legacyCopy(value);

    if (button) flashCopied(button, copied);
    toast(copied ? '已复制到剪贴板' : '复制失败，请手动选中后复制', copied ? 'ok' : 'error');
    return copied;
}

function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, area.value.length);

    let copied = false;
    try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
    area.remove();
    return copied;
}

function flashCopied(button, copied) {
    if (button.dataset.busy === '1') return;
    button.dataset.busy = '1';
    button.dataset.idleLabel = button.textContent;
    button.textContent = copied ? '已复制 ✓' : '复制失败';
    button.classList.toggle('is-copied', copied);

    setTimeout(() => {
        button.textContent = button.dataset.idleLabel || '复制';
        button.dataset.busy = '';
        button.classList.remove('is-copied');
    }, 1400);
}

function copyElement(id, button) {
    const element = $(id);
    return copyText(element ? element.textContent : '', button);
}

function selectAllOnClick(id) {
    const element = $(id);
    element.addEventListener('click', () => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    });
}

function armConfirm(button, label, action) {
    if (button.dataset.armed === '1') {
        button.dataset.armed = '';
        button.textContent = button.dataset.idle || button.textContent;
        button.classList.remove('danger-solid');
        action();
        return;
    }

    button.dataset.armed = '1';
    button.dataset.idle = button.textContent;
    button.textContent = label;
    button.classList.add('danger-solid');

    setTimeout(() => {
        if (button.dataset.armed !== '1') return;
        button.dataset.armed = '';
        button.textContent = button.dataset.idle;
        button.classList.remove('danger-solid');
    }, 4000);
}

async function api(path, body) {
    const options = { credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
        options.method = 'POST';
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const response = await fetch(API_BASE + path, options);
    let data = {};
    try { data = await response.json(); } catch (error) { data = {}; }
    return { status: response.status, data };
}

const state = {
    passwordSet: false,
    loggedIn: false,
    tokenCount: 0,
};

// 数据与日志一节的常驻说明：登录前、出错时都会回到这句
const JOURNAL_IDLE_HINT = '下载得到的是 journal.log 的当前快照；这台服务器上的全部笔记与待办就在其中。';

function render() {
    $('view-setup').hidden = state.passwordSet;
    $('view-login').hidden = !state.passwordSet || state.loggedIn;
    $('view-panel').hidden = !state.loggedIn;
    $('logout-btn').hidden = !state.loggedIn;

    if (state.loggedIn) {
        $('header-desc').textContent = state.tokenCount > 0
            ? '管理 ' + state.tokenCount + ' 个访问令牌与它们绑定的设备。令牌明文只在创建或重置的那一瞬间出现，服务端只保存摘要。'
            : '给每台设备建一个访问令牌，客户端用它同步笔记与待办。令牌明文只在创建时出现一次，服务端只保存摘要。';
    } else {
        $('journal-summary').textContent = '登录后可以查看与下载日志';
        $('journal-summary').title = '';
        $('journal-download').disabled = true;
        setMessage('journal-status', JOURNAL_IDLE_HINT);
    }
}

async function refresh() {
    const { data } = await api('/status');
    state.passwordSet = !!data.passwordSet;
    state.loggedIn = !!data.loggedIn;
    state.tokenCount = Number(data.tokenCount) || 0;
    render();

    if (state.loggedIn) {
        await loadTokens();
        await loadJournal();
    }
}

function showSecret(id) {
    const box = $(id);
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function tokenRow(record) {
    const row = document.createElement('div');
    row.className = 'settings-row token-row';

    const head = document.createElement('div');
    head.className = 'token-head';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = record.enabled ? '启用中' : '已停用';
    if (!record.enabled) badge.dataset.off = '1';

    const name = document.createElement('span');
    name.className = 'token-name';
    name.textContent = record.name || '未命名设备';

    const actions = document.createElement('span');
    actions.className = 'settings-actions';

    head.append(badge, name, actions);

    const meta = document.createElement('div');
    meta.className = 'token-meta';
    const metaText = document.createElement('span');
    metaText.textContent = '创建于 ' + formatTime(record.createdAt) + ' · 最近使用 ' + formatTime(record.lastUsedAt);
    meta.append(metaText);

    const fields = document.createElement('div');
    fields.className = 'row-controls';

    const nameInput = document.createElement('input');
    nameInput.className = 'settings-input';
    nameInput.type = 'text';
    nameInput.maxLength = 40;
    nameInput.placeholder = '名称，例如：台式机';
    nameInput.value = record.name || '';

    const deviceInput = document.createElement('input');
    deviceInput.className = 'settings-input mono';
    deviceInput.type = 'text';
    deviceInput.maxLength = 40;
    deviceInput.placeholder = '绑定设备 id，留空表示不绑定';
    deviceInput.value = record.device || '';

    fields.append(nameInput, deviceInput);

    const saveButton = document.createElement('button');
    saveButton.className = 'settings-btn';
    saveButton.type = 'button';
    saveButton.textContent = '保存';
    saveButton.disabled = true;
    const syncSaveState = () => {
        saveButton.disabled = nameInput.value === (record.name || '') && deviceInput.value === (record.device || '');
    };
    nameInput.addEventListener('input', syncSaveState);
    deviceInput.addEventListener('input', syncSaveState);
    saveButton.addEventListener('click', async () => {
        const { status, data } = await api('/tokens/update', {
            id: record.id,
            name: nameInput.value,
            device: deviceInput.value,
        });
        if (status === 401) return refresh();
        if (status !== 200) return toast(data.error || '保存失败', 'error');
        toast('已保存');
        await loadTokens();
    });

    const toggleButton = document.createElement('button');
    toggleButton.className = 'settings-btn';
    toggleButton.type = 'button';
    toggleButton.textContent = record.enabled ? '停用' : '启用';
    toggleButton.addEventListener('click', async () => {
        const { status, data } = await api('/tokens/update', { id: record.id, enabled: !record.enabled });
        if (status === 401) return refresh();
        if (status !== 200) return toast(data.error || '操作失败', 'error');
        toast(record.enabled ? '该令牌已停用，继续使用将收到 401' : '该令牌已重新启用');
        await loadTokens();
    });

    const rotateButton = document.createElement('button');
    rotateButton.className = 'settings-btn';
    rotateButton.type = 'button';
    rotateButton.textContent = '重置';
    rotateButton.addEventListener('click', () => {
        armConfirm(rotateButton, '确认重置？', async () => {
            const { status, data } = await api('/tokens/rotate', { id: record.id });
            if (status === 401) return refresh();
            if (status !== 200) return toast(data.error || '重置失败', 'error');
            $('reset-token').textContent = data.token || '';
            toast('令牌已重置，旧令牌立即失效');
            await loadTokens();
            showSecret('reset-secret');
        });
    });

    const deleteButton = document.createElement('button');
    deleteButton.className = 'settings-btn danger';
    deleteButton.type = 'button';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', () => {
        armConfirm(deleteButton, '确认删除', async () => {
            const { status, data } = await api('/tokens/delete', { id: record.id });
            if (status === 401) return refresh();
            if (status !== 200) return toast(data.error || '删除失败', 'error');
            toast('令牌已删除');
            await loadTokens();
        });
    });

    if (record.lastDeviceId) {
        const label = document.createElement('span');
        label.textContent = '· 最近上报设备';

        const device = document.createElement('code');
        device.textContent = record.lastDeviceId;

        const bindButton = document.createElement('button');
        bindButton.className = 'settings-btn';
        bindButton.type = 'button';
        bindButton.textContent = '用这个 id 绑定';
        bindButton.addEventListener('click', () => {
            deviceInput.value = record.lastDeviceId;
            syncSaveState();
            deviceInput.focus();
            toast('已填入设备 id，点「保存」生效');
        });

        meta.append(label, device, bindButton);
    }

    actions.append(saveButton, toggleButton, rotateButton, deleteButton);
    row.append(head, meta, fields);
    return row;
}

async function loadTokens() {
    const { status, data } = await api('/tokens');
    if (status === 401) {
        state.loggedIn = false;
        render();
        return;
    }

    const list = $('token-list');
    list.textContent = '';
    const records = Array.isArray(data.tokens) ? data.tokens : [];
    records.forEach((record) => list.append(tokenRow(record)));
    $('token-empty').hidden = records.length > 0;
}

function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / 1024 / 1024).toFixed(2) + ' MB';
}

function describeJournal(data) {
    if (!data || !data.exists || !Number(data.ops)) return '';
    // 「可复用 ID」是删除腾出来的 ID：新建条目会优先把它们再用起来
    const recyclable = Number(data.recyclable);
    return Number(data.ops) + ' 条操作 · 存活文件 ' + Number(data.files) + ' · 删除记录 ' + Number(data.deleted)
        + (recyclable ? '（可复用 ID ' + recyclable + '）' : '')
        + ' · 最新序号 ' + Number(data.latestSeq) + ' · ' + formatFileSize(data.size)
        + ' · 最后写入 ' + formatTime(data.updatedAt);
}

async function loadJournal() {
    const summary = $('journal-summary');
    const button = $('journal-download');
    const compactButton = $('journal-compact');
    const { status, data } = await api('/journal');
    if (status === 401) {
        state.loggedIn = false;
        render();
        return;
    }

    if (status !== 200) {
        summary.textContent = '读取日志状态失败：' + ((data && data.error) || 'HTTP ' + status);
        summary.title = '';
        button.disabled = true;
        if (compactButton) compactButton.disabled = true;
        return;
    }

    const text = describeJournal(data);
    if (!text) {
        summary.textContent = '还没有任何操作：客户端同步过一次之后，日志里才会有内容';
        summary.title = '';
        button.disabled = true;
        if (compactButton) compactButton.disabled = true;
        return;
    }

    summary.textContent = text;
    // 日志身份：与客户端「诊断」报告里的同一项对得上，说明两边看的是同一份日志
    summary.title = data.journalId ? '日志身份：' + data.journalId : '';
    button.disabled = false;
    if (compactButton) compactButton.disabled = false;
}

function attachmentFileName(header) {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(header || ''));
    if (!match) return '';
    const value = match[1].trim();
    try {
        return decodeURIComponent(value);
    } catch (error) {
        return value;
    }
}

function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadJournal() {
    const button = $('journal-download');
    if (button.disabled) return;

    let sessionLost = false;
    button.disabled = true;
    button.dataset.idle = button.textContent;
    button.textContent = '准备下载…';
    setMessage('journal-status', '正在从服务端读取日志…');

    try {
        const response = await fetch(API_BASE + '/journal/download', { credentials: 'same-origin' });
        if (!response.ok) {
            let data = {};
            try {
                data = await response.json();
            } catch (error) {
                data = {};
            }
            if (response.status === 401) {
                sessionLost = true;
                state.loggedIn = false;
                render();
                return;
            }
            const message = (data && data.error) || ('下载失败（HTTP ' + response.status + '）');
            setMessage('journal-status', message, 'error');
            toast(message, 'error');
            return;
        }

        const blob = await response.blob();
        const name = attachmentFileName(response.headers.get('Content-Disposition')) || 'journal.log';
        saveBlob(blob, name);
        setMessage('journal-status', '已下载 ' + name + '（' + formatFileSize(blob.size) + '）：在 EsprinNemo 的'
            + '「设置 → 数据与存储 → 文件日志」里可以导入它，或把它摊成一个文件夹。', 'ok');
        toast('日志已下载：' + name);
    } catch (error) {
        setMessage('journal-status', '下载失败，请检查网络后重试', 'error');
        toast('下载失败，请检查网络后重试', 'error');
    } finally {
        button.textContent = button.dataset.idle || '下载日志';
        // 下载期间可能又有新的操作写进日志：顺手刷新一次概览（它也会重新决定按钮是否可用）
        if (!sessionLost) await loadJournal();
    }
}

/* 整理日志：把已彻底删除的条目从日志里真正抹掉（每条只留一行删除标记，序号一律不变）。
   客户端推上一条删除时服务端会自动做这件事，这里是把以前积压下来的旧记录一并清掉。 */
async function compactJournal() {
    const button = $('journal-compact');
    if (!button || button.disabled) return;

    button.disabled = true;
    const idle = button.textContent;
    button.textContent = '整理中…';
    setMessage('journal-status', '正在抹掉已彻底删除条目的正文与历史…');

    try {
        const { status, data } = await api('/journal/compact', {});
        if (status === 401) {
            state.loggedIn = false;
            render();
            return;
        }
        if (status !== 200) {
            const message = (data && data.error) || ('整理失败（HTTP ' + status + '）');
            setMessage('journal-status', message, 'error');
            toast(message, 'error');
            return;
        }

        const removed = Number(data.removed) || 0;
        if (removed) {
            const message = '已抹掉 ' + removed + ' 行（涉及 ' + Number(data.paths) + ' 条已彻底删除的条目），'
                + '日志现在 ' + Number(data.kept) + ' 行。';
            setMessage('journal-status', message, 'ok');
            toast('日志已整理：抹掉 ' + removed + ' 行');
        } else {
            setMessage('journal-status', '没有可整理的内容：已彻底删除的条目在日志里只留着一条删除标记。', 'ok');
            toast('日志无需整理');
        }
    } catch (error) {
        setMessage('journal-status', '整理失败，请检查网络后重试', 'error');
        toast('整理失败，请检查网络后重试', 'error');
    } finally {
        button.textContent = idle || '整理日志';
        await loadJournal();
    }
}

async function submitSetup() {
    const password = $('setup-pass').value;
    if (password.length < 8) return setMessage('setup-msg', '密码至少 8 位', 'error');
    if (password !== $('setup-pass2').value) return setMessage('setup-msg', '两次输入不一致', 'error');

    setMessage('setup-msg', '正在设置…');
    const { status, data } = await api('/setup-password', { password });
    if (status !== 200) return setMessage('setup-msg', data.error || '设置失败', 'error');

    $('setup-pass').value = '';
    $('setup-pass2').value = '';
    setMessage('setup-msg', '');
    toast('管理密码已设置');
    await refresh();
}

async function submitLogin() {
    setMessage('login-msg', '正在登录…');
    const { status, data } = await api('/login', { password: $('login-pass').value });
    if (status !== 200) return setMessage('login-msg', data.error || '登录失败', 'error');

    $('login-pass').value = '';
    setMessage('login-msg', '');
    await refresh();
}

async function submitPasswordChange() {
    const next = $('pass-new').value;
    if (next.length < 8) return toast('新密码至少 8 位', 'error');
    if (next !== $('pass-new2').value) return toast('两次输入的新密码不一致', 'error');

    const { status, data } = await api('/password', { oldPassword: $('pass-old').value, newPassword: next });
    if (status === 401) return refresh();
    if (status !== 200) return toast(data.error || '修改失败', 'error');

    $('pass-old').value = '';
    $('pass-new').value = '';
    $('pass-new2').value = '';
    toast('密码已更新，其他登录会话已失效');
}

async function createToken() {
    const { status, data } = await api('/tokens', { name: $('new-name').value, device: $('new-device').value });
    if (status === 401) return refresh();
    if (status !== 200) return toast(data.error || '创建失败', 'error');

    $('new-token').textContent = data.token || '';
    $('reset-secret').hidden = true;
    $('new-name').value = '';
    $('new-device').value = '';
    toast('令牌已创建');
    await loadTokens();
    showSecret('new-secret');
}

function bindEvents() {
    $('setup-btn').addEventListener('click', submitSetup);
    $('login-btn').addEventListener('click', submitLogin);
    $('new-btn').addEventListener('click', createToken);
    $('pass-btn').addEventListener('click', submitPasswordChange);
    $('logout-btn').addEventListener('click', async () => {
        await api('/logout', {});
        await refresh();
        toast('已退出登录');
    });

    $('new-copy').addEventListener('click', (event) => copyElement('new-token', event.currentTarget));
    $('reset-copy').addEventListener('click', (event) => copyElement('reset-token', event.currentTarget));
    selectAllOnClick('new-token');
    selectAllOnClick('reset-token');

    $('journal-refresh').addEventListener('click', async () => {
        await loadJournal();
        toast('日志概览已刷新');
    });
    $('journal-compact').addEventListener('click', () => {
        compactJournal().catch((error) => {
            console.error('整理日志失败:', error);
            setMessage('journal-status', '整理失败，请检查网络后重试', 'error');
        });
    });
    $('journal-download').addEventListener('click', () => {
        downloadJournal().catch((error) => {
            console.error(error);
            setMessage('journal-status', '下载失败，请检查网络后重试', 'error');
        });
    });

    [['setup-pass', 'setup-pass2', submitSetup], ['login-pass', null, submitLogin], ['pass-new', 'pass-new2', submitPasswordChange]]
        .forEach(([first, second, handler]) => {
            [first, second].filter(Boolean).forEach((id) => {
                $(id).addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') handler();
                });
            });
        });
}

initTheme();
bindEvents();
refresh();
