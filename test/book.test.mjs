import test from 'node:test';
import assert from 'node:assert/strict';
import { BookEngine } from '../src/book.mjs';

const snap = (symbol, through, entries, connection = 'c1') => ({ symbol, connection, through, entries });
const msg = (sequence, changes, connection = 'c1') => ({ connection, sequence, changes });

test('快照与增量连贯应用，同价多条目聚合可追溯', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, [{ id: 'bid-1', side: 'bid', price: '100', size: '5' }]));
  engine.ingest(msg(11, [{ symbol: 'ORE', action: 'change', id: 'bid-1', size: '7' }]));
  engine.ingest(msg(12, [{ symbol: 'ORE', action: 'add', id: 'bid-2', side: 'bid', price: '100', size: '3' }]));
  const view = engine.view('ORE');
  assert.equal(view.state, 'coherent');
  assert.equal(view.stateLabel, '连贯报价');
  assert.equal(view.bids[0].price, '100');
  assert.equal(view.bids[0].size, '10');
  assert.deepEqual(view.bids[0].entries, [{ id: 'bid-1', size: '7' }, { id: 'bid-2', size: '3' }]);
  assert.equal(view.basis.applied, 12);
});

test('重复序号被忽略并记录', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, []));
  engine.ingest(msg(11, []));
  assert.equal(engine.ingest(msg(11, [])).reason, 'duplicate');
  assert.ok(engine.events.some((e) => e.event === 'duplicate' && e.sequence === 11));
});

test('缺号使该连接全部连贯品种失效，迟到的缺号不重放', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, [{ id: 'bid-1', side: 'bid', price: '100', size: '5' }]));
  engine.applySnapshot(snap('COAL', 10, [{ id: 'ask-1', side: 'ask', price: '80', size: '1' }]));
  engine.ingest(msg(11, [{ symbol: 'ORE', action: 'change', id: 'bid-1', size: '7' }]));
  assert.equal(engine.ingest(msg(13, [{ symbol: 'ORE', action: 'delete', id: 'bid-1' }])).reason, 'gap');
  assert.equal(engine.view('ORE').state, 'rebuilding');
  assert.equal(engine.view('COAL').state, 'rebuilding'); // 未被触及的品种同样失效
  engine.ingest(msg(12, [{ symbol: 'COAL', action: 'delete', id: 'ask-1' }])); // 迟到的缺号
  const coal = engine.view('COAL');
  assert.equal(coal.state, 'rebuilding');
  assert.ok(!coal.history.some((h) => h.event === 'recovered'));
});

test('快照与增量交叉：重建期间缓存的增量在快照后追平', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, [{ id: 'bid-1', side: 'bid', price: '100', size: '5' }]));
  engine.ingest(msg(11, []));
  engine.ingest(msg(13, [{ symbol: 'ORE', action: 'add', id: 'bid-2', side: 'bid', price: '99', size: '2' }]));
  engine.ingest(msg(14, [{ symbol: 'ORE', action: 'change', id: 'bid-1', size: '6' }]));
  const result = engine.applySnapshot(snap('ORE', 12, [{ id: 'bid-1', side: 'bid', price: '100', size: '5' }]));
  assert.equal(result.caughtUp, true);
  const view = engine.view('ORE');
  assert.equal(view.state, 'coherent');
  assert.equal(view.basis.applied, 14);
  assert.deepEqual(view.bids.map((b) => b.price), ['100', '99']);
  assert.equal(view.bids[0].size, '6');
});

test('永久缺口不被排序重放掩盖', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, []));
  engine.ingest(msg(11, []));
  engine.ingest(msg(13, [])); // 缺 12
  engine.ingest(msg(15, [])); // 缺 14
  const result = engine.applySnapshot(snap('ORE', 12, []));
  assert.equal(result.caughtUp, false);
  const view = engine.view('ORE');
  assert.equal(view.state, 'rebuilding');
  assert.equal(view.basis.applied, 13); // 13 已追平，14 是永久缺口
  assert.equal(view.history.at(-1).event, 'rebuild-incomplete');
  assert.equal(view.history.at(-1).missing, 14);
});

test('缓冲超限被淘汰后无法桥接，保持等待重建', () => {
  const engine = new BookEngine({ bufferLimit: 2 });
  engine.applySnapshot(snap('ORE', 10, []));
  engine.ingest(msg(11, []));
  for (const seq of [13, 14, 15, 16]) {
    engine.ingest(msg(seq, [{ symbol: 'ORE', action: 'add', id: 'e' + seq, side: 'bid', price: '1', size: '1' }]));
  }
  assert.ok(engine.events.some((e) => e.event === 'buffer-evicted' && e.sequence === 13));
  const result = engine.applySnapshot(snap('ORE', 12, []));
  assert.equal(result.caughtUp, false);
  assert.equal(engine.view('ORE').state, 'rebuilding'); // 13、14 已被淘汰，无法补齐
});

test('一条消息同时改动多个品种', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, [{ id: 'bid-1', side: 'bid', price: '100', size: '5' }]));
  engine.applySnapshot(snap('COAL', 10, [{ id: 'ask-1', side: 'ask', price: '80', size: '1' }]));
  engine.ingest(msg(11, [
    { symbol: 'ORE', action: 'change', id: 'bid-1', size: '7' },
    { symbol: 'COAL', action: 'add', id: 'ask-2', side: 'ask', price: '80', size: '2' },
  ]));
  assert.equal(engine.view('ORE').bids[0].size, '7');
  assert.equal(engine.view('COAL').asks[0].size, '3');
  assert.equal(engine.view('COAL').basis.applied, 11);
});

test('品种下架进入已失效，下架后增量转为等待重建', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('COAL', 10, [{ id: 'ask-1', side: 'ask', price: '80', size: '1' }]));
  engine.ingest(msg(11, [{ symbol: 'COAL', action: 'withdraw' }]));
  let view = engine.view('COAL');
  assert.equal(view.state, 'invalid');
  assert.equal(view.stateLabel, '已失效');
  assert.equal(view.asks.length, 0);
  engine.ingest(msg(12, [{ symbol: 'COAL', action: 'add', id: 'ask-9', side: 'ask', price: '81', size: '1' }]));
  view = engine.view('COAL');
  assert.equal(view.state, 'rebuilding'); // 复活必须由快照确认
});

test('旧连接迟到的消息被丢弃，新纪元触及旧基点品种触发重建', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, [{ id: 'bid-1', side: 'bid', price: '100', size: '5' }]));
  engine.ingest(msg(11, []));
  engine.ingest(msg(1, [{ symbol: 'COAL', action: 'withdraw' }], 'c2')); // 新纪元
  const late = engine.ingest(msg(12, [{ symbol: 'ORE', action: 'change', id: 'bid-1', size: '9' }], 'c1'));
  assert.equal(late.reason, 'stale-connection');
  assert.equal(engine.view('ORE').bids[0].size, '5'); // 未被迟到消息污染
  assert.ok(engine.events.some((e) => e.event === 'late-discarded' && e.sequence === 12));
  engine.ingest(msg(2, [{ symbol: 'ORE', action: 'change', id: 'bid-1', size: '8' }], 'c2'));
  assert.equal(engine.view('ORE').state, 'rebuilding'); // 跨纪元增量不能套用
});

test('断线使连贯品种转入等待重建，不再展示旧档位', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, [{ id: 'bid-1', side: 'bid', price: '100', size: '5' }]));
  engine.disconnect('测试断线');
  const view = engine.view('ORE');
  assert.equal(view.state, 'rebuilding');
  assert.equal(view.bids.length, 0);
  assert.ok(view.history.some((h) => h.event === 'invalidated' && h.reason === 'disconnect'));
});

test('状态持久化往返后行为一致（接收后未发布就停止）', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, [{ id: 'bid-1', side: 'bid', price: '100', size: '5' }]));
  engine.ingest(msg(11, [{ symbol: 'ORE', action: 'change', id: 'bid-1', size: '7' }]));
  engine.ingest(msg(13, [{ symbol: 'ORE', action: 'delete', id: 'bid-1' }])); // 缺号，等待重建
  const restored = BookEngine.fromJSON(JSON.parse(JSON.stringify(engine.toJSON())));
  assert.equal(restored.view('ORE').state, 'rebuilding');
  const result = restored.applySnapshot(snap('ORE', 13, [{ id: 'bid-2', side: 'bid', price: '100', size: '3' }]));
  assert.equal(result.caughtUp, true);
  assert.equal(restored.view('ORE').state, 'coherent');
  assert.equal(restored.view('ORE').bids[0].size, '3');
});

test('过旧快照被拒绝并记录依据', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, []));
  engine.ingest(msg(11, []));
  engine.ingest(msg(13, [])); // 缺号
  const result = engine.applySnapshot(snap('ORE', 10, [])); // 不覆盖缺口
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'stale');
  const view = engine.view('ORE');
  assert.equal(view.state, 'rebuilding');
  assert.ok(view.history.some((h) => h.event === 'snapshot-rejected' && h.reason === 'stale'));
});

test('历史解释每次失效与恢复依据的序号', () => {
  const engine = new BookEngine();
  engine.applySnapshot(snap('ORE', 10, [{ id: 'bid-1', side: 'bid', price: '100', size: '5' }]));
  engine.ingest(msg(11, []));
  engine.ingest(msg(13, []));
  engine.applySnapshot(snap('ORE', 13, []));
  const history = engine.view('ORE').history;
  assert.deepEqual(history.map((h) => h.event), ['snapshot', 'invalidated', 'recovered']);
  assert.equal(history[1].expected, 12);
  assert.equal(history[1].received, 13);
  assert.equal(history[2].through, 13);
  assert.equal(history[2].appliedTo, 13);
});

test('非法消息与非法快照被拒绝', () => {
  const engine = new BookEngine();
  assert.throws(() => engine.ingest({ connection: 'c1', sequence: 1 }), /消息无效/);
  assert.throws(() => engine.ingest(msg(1, [{ symbol: 'ORE', action: 'explode' }])), /未知动作/);
  assert.throws(() => engine.applySnapshot({ symbol: 'ORE', connection: 'c1', through: -1, entries: [] }), /快照无效/);
  assert.throws(() => engine.applySnapshot(snap('ORE', 1, [{ id: 'x', side: 'mid', price: '1', size: '1' }])), /快照无效/);
});
