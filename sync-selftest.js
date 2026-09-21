#!/usr/bin/env node
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function findSyncModule() {
  const candidates = [
    path.join(__dirname, '..', 'src', 'main', 'sync_server.js'),
    path.join(__dirname, '..', 'main', 'sync_server.js')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 src/main/sync_server.js，请在项目根目录运行本脚本');
}

const sync = require(findSyncModule());

let failed = 0;
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

console.log('路径与哈希：');
check('越界与空路径被拒绝', () => {
  assert.strictEqual(sync.normalizeRelative('../evil.md'), '');
  assert.strictEqual(sync.normalizeRelative('/abs.md'), '');
  assert.strictEqual(sync.normalizeRelative('notes/../x.md'), '');
  assert.strictEqual(sync.normalizeRelative(''), '');
});
check('反斜杠归一成正斜杠', () => {
  assert.strictEqual(sync.normalizeRelative('notes\\sub\\a.md'), 'notes/sub/a.md');
});
check('哈希基于字节', () => {
  assert.strictEqual(sync.hashBytes(Buffer.from('abc')), sync.hashBytes(Buffer.from('abc')));
  assert.notStrictEqual(sync.hashBytes(Buffer.from('abc')), sync.hashBytes(Buffer.from('abd')));
});

console.log('重放决策：');
check('远端删除 + 本地没有该文件 → 什么都不做（不会凭空写回）', () => {
  assert.strictEqual(sync.decideApply({ op: 'del', path: 'notes/a.md' }, { localExists: false }), 'skip');
});
check('远端删除 + 本地还有该文件 → 删掉它', () => {
  assert.strictEqual(sync.decideApply({ op: 'del', path: 'notes/a.md' }, { localExists: true }), 'apply');
});
check('远端写入 + 内容一致 → 跳过写盘', () => {
  assert.strictEqual(sync.decideApply({ op: 'put', hash: 'h1' }, { localExists: true, localHash: 'h1' }), 'skip');
});
check('远端写入 + 内容不同 → 写入', () => {
  assert.strictEqual(sync.decideApply({ op: 'put', hash: 'h1' }, { localExists: true, localHash: 'h2' }), 'apply');
});
check('本地有更晚的未推送改动 → 保留本地', () => {
  assert.strictEqual(
    sync.decideApply({ op: 'put', hash: 'h1', time: 100 }, { localNewerPending: true, localExists: true, localHash: 'h2' }),
    'keep-local'
  );
});

console.log('待推送队列：');
check('同一路径的连续改动合并成一条', () => {
  let list = [];
  list = sync.mergeOutboxOp(list, { opId: '1', path: 'notes/a.md', op: 'put', time: 1 });
  list = sync.mergeOutboxOp(list, { opId: '2', path: 'notes/a.md', op: 'put', time: 2 });
  list = sync.mergeOutboxOp(list, { opId: '3', path: 'notes/a.md', op: 'del', time: 3 });
  list = sync.mergeOutboxOp(list, { opId: '4', path: 'notes/b.md', op: 'put', time: 4 });
  assert.deepStrictEqual(list.map((op) => op.opId), ['3', '4']);
});

function createServer() {
  const log = [];
  const files = new Map();
  const deleted = new Set();
  return {
    log,
    files,
    deleted,
    push(device, ops) {
      return ops.map((op) => {
        const seq = log.length + 1;
        const entry = { ...op, seq, device };
        log.push(entry);
        if (op.op === 'del') {
          files.delete(op.path);
          deleted.add(op.path);
        } else {
          files.set(op.path, op.hash);
          deleted.delete(op.path);
        }
        return { opId: op.opId, seq };
      });
    },
    since(seq) {
      return log.filter((op) => op.seq > seq);
    }
  };
}

function createDevice(name) {
  return { name, lastSeq: 0, outbox: [], disk: new Map() };
}

function localPut(dev, filePath, content, time) {
  dev.disk.set(filePath, sync.hashBytes(Buffer.from(content)));
  dev.outbox = sync.mergeOutboxOp(dev.outbox, {
    opId: `${dev.name}-${time}`,
    op: 'put',
    path: filePath,
    time,
    hash: sync.hashBytes(Buffer.from(content)),
    data: content,
    encoding: 'utf8'
  });
}

function localDel(dev, filePath, time) {
  dev.disk.delete(filePath);
  dev.outbox = sync.mergeOutboxOp(dev.outbox, {
    opId: `${dev.name}-${time}`,
    op: 'del',
    path: filePath,
    time
  });
}

function syncOnce(dev, server) {
  for (const op of server.since(dev.lastSeq)) {
    const pending = dev.outbox.find((item) => item.path === op.path) || null;
    const decision = sync.decideApply(op, {
      localNewerPending: !!pending && (pending.time || 0) > (op.time || 0),
      localExists: dev.disk.has(op.path),
      localHash: dev.disk.get(op.path) || '',
      opHash: op.hash || ''
    });

    if (decision === 'apply') {
      if (op.op === 'del') dev.disk.delete(op.path);
      else dev.disk.set(op.path, op.hash);
      dev.outbox = dev.outbox.filter((item) => item.path !== op.path);
    }
    dev.lastSeq = Math.max(dev.lastSeq, op.seq);
  }

  if (dev.outbox.length) {
    server.push(dev.name, dev.outbox);
    dev.outbox = [];
  }
}

console.log('两台设备走一遍完整链路：');

check('A 新建笔记 → B 同步后拿到', () => {
  const server = createServer();
  const a = createDevice('dev-a');
  const b = createDevice('dev-b');

  localPut(a, 'notes/a.md', '第一篇', 1000);
  syncOnce(a, server);
  syncOnce(b, server);
  assert.strictEqual(b.disk.get('notes/a.md'), sync.hashBytes(Buffer.from('第一篇')));
});

check('A 删除笔记 → B 同步后本地被删，且不会产生补写操作', () => {
  const server = createServer();
  const a = createDevice('dev-a');
  const b = createDevice('dev-b');

  localPut(a, 'notes/a.md', '第一篇', 1000);
  syncOnce(a, server);
  syncOnce(b, server);

  localDel(a, 'notes/a.md', 2000);
  syncOnce(a, server);
  syncOnce(b, server);

  assert.ok(!b.disk.has('notes/a.md'), 'B 本地应当已删除');
  assert.deepStrictEqual(b.outbox, [], 'B 不应产生任何“把它补回来”的操作');
  assert.ok(server.deleted.has('notes/a.md'), '服务端应保留删除记录');
});

check('B 再同步一次也不会把笔记复活', () => {
  const server = createServer();
  const a = createDevice('dev-a');
  const b = createDevice('dev-b');

  localPut(a, 'notes/a.md', '第一篇', 1000);
  syncOnce(a, server);
  syncOnce(b, server);
  localDel(a, 'notes/a.md', 2000);
  syncOnce(a, server);
  syncOnce(b, server);

  syncOnce(b, server);
  syncOnce(b, server);
  assert.ok(!b.disk.has('notes/a.md'));
  assert.deepStrictEqual(b.outbox, []);
  assert.strictEqual(b.lastSeq, server.log.length);
});

check('B 在删除之后又改了那篇笔记（更晚）→ 保留 B 的版本并推上去', () => {
  const server = createServer();
  const a = createDevice('dev-a');
  const b = createDevice('dev-b');

  localPut(a, 'notes/a.md', '第一篇', 1000);
  syncOnce(a, server);
  syncOnce(b, server);

  localDel(a, 'notes/a.md', 2000);
  syncOnce(a, server);

  localPut(b, 'notes/a.md', 'B 的新内容', 3000);
  syncOnce(b, server);

  assert.strictEqual(b.disk.get('notes/a.md'), sync.hashBytes(Buffer.from('B 的新内容')));
  assert.ok(server.files.has('notes/a.md'), 'B 的版本应当被推上去');

  syncOnce(a, server);
  assert.strictEqual(a.disk.get('notes/a.md'), sync.hashBytes(Buffer.from('B 的新内容')));
});

check('远端更新的内容会覆盖本地没有再改过的文件', () => {
  const server = createServer();
  const a = createDevice('dev-a');
  const b = createDevice('dev-b');

  localPut(a, 'notes/a.md', '第一版', 1000);
  syncOnce(a, server);
  syncOnce(b, server);

  localPut(a, 'notes/a.md', '第二版', 2000);
  syncOnce(a, server);
  syncOnce(b, server);

  assert.strictEqual(b.disk.get('notes/a.md'), sync.hashBytes(Buffer.from('第二版')));
});

console.log();
if (failed) {
  console.log(`自测失败 ${failed} 项，通过 ${passed} 项`);
  process.exit(1);
}
console.log(`自测全部通过（${passed} 项）`);
