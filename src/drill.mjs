import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from './service.mjs';

// 订单簿采集演练：断线、快照与增量交叉、品种下架、同价多条目、接收后未发布就停止。
const directory = await mkdtemp(join(tmpdir(), 'book-drill-'));
let fixture = await startFixture();
let service = await startService({ source: fixture.url, directory });

const book = async () => (await fetch(service.url + '/book')).json();
const collect = async () => (await fetch(service.url + '/collect')).json();
const rebuild = async () => (await fetch(service.url + '/rebuild')).json();
const phase = (title, data) => console.log(JSON.stringify({ 阶段: title, ...data }, null, 2));

try {
  // 1. 初始快照直接发布为连贯报价
  let view = await book();
  assert.equal(view.symbols.ORE.state, 'coherent');
  assert.equal(view.symbols.COAL.state, 'coherent');
  phase('初始快照', view.symbols);

  // 2. 同价多条目：ORE 在 100 上有 bid-1/bid-2 两条，可追溯且合计精确
  await collect();
  view = await book();
  const bids = view.symbols.ORE.bids;
  assert.equal(bids.length, 1);
  assert.equal(bids[0].price, '100');
  assert.equal(bids[0].size, '10');
  assert.deepEqual(bids[0].entries, [{ id: 'bid-1', size: '7' }, { id: 'bid-2', size: '3' }]);
  assert.equal(view.symbols.COAL.asks[0].entries.length, 2);
  phase('同价多条目', { ORE买盘: bids, COAL卖盘: view.symbols.COAL.asks });

  // 3. 缺号：重复序号被忽略，13 号缺失使两品种一起失效，档位不再冒充最新报价
  await collect();
  view = await book();
  assert.equal(view.symbols.ORE.state, 'rebuilding');
  assert.equal(view.symbols.ORE.bids.length, 0);
  assert.equal(view.symbols.COAL.state, 'rebuilding');
  assert.ok(view.events.some((e) => e.event === 'duplicate' && e.sequence === 12));
  assert.ok(view.events.some((e) => e.event === 'gap' && e.expected === 13 && e.received === 14));
  phase('缺号失效', view.symbols);

  // 4. 接收后未发布就停止：c1#14 已落盘但订单簿未重建，重启后仍是等待重建
  await service.close();
  service = await startService({ source: fixture.url, directory });
  view = await book();
  assert.equal(view.symbols.ORE.state, 'rebuilding');
  assert.equal(view.symbols.ORE.basis.applied, 12);
  phase('停止后恢复（未发布不丢失）', view.symbols);

  // 5. 快照与增量交叉：重建快照覆盖到 c1#14，缓存的增量被快照覆盖，ORE 恢复连贯
  await rebuild();
  view = await book();
  assert.equal(view.symbols.ORE.state, 'coherent');
  assert.equal(view.symbols.ORE.basis.through, 14);
  assert.deepEqual(view.symbols.ORE.bids[0].entries, [{ id: 'bid-2', size: '3' }]);
  assert.equal(view.symbols.COAL.state, 'rebuilding'); // 来源没有 COAL 的重建快照
  assert.ok(view.symbols.ORE.history.some((h) => h.event === 'recovered' && h.through === 14));
  phase('快照重建', view.symbols);

  // 6. 品种下架 + 旧连接迟到：COAL 在 c2#1 下架；c1#15 迟到被丢弃，bid-2 数量仍是 3
  await collect();
  view = await book();
  assert.equal(view.symbols.COAL.state, 'invalid');
  assert.equal(view.symbols.COAL.stateLabel, '已失效');
  assert.equal(view.symbols.ORE.state, 'coherent');
  assert.equal(view.symbols.ORE.bids[0].size, '3');
  assert.ok(view.events.some((e) => e.event === 'late-discarded' && e.connection === 'c1' && e.sequence === 15));
  phase('下架与旧连接迟到', view.symbols);

  // 7. 断线：来源不可达，连贯报价转入等待重建，页面不再展示旧档位
  await fixture.close();
  const failed = await collect();
  assert.ok(failed.error);
  view = await book();
  assert.equal(view.symbols.ORE.state, 'rebuilding');
  assert.equal(view.symbols.ORE.bids.length, 0);
  assert.equal(view.symbols.COAL.state, 'invalid');
  phase('断线', view.symbols);

  // 8. 来源恢复：同一数据目录、新来源地址，全量重订阅后重新收敛到同一状态
  await service.close();
  fixture = await startFixture();
  service = await startService({ source: fixture.url, directory });
  await collect(); // 重订阅 + 序号 11、12
  await collect(); // 重复 12、缺号 14
  await rebuild(); // ORE 再次经快照恢复
  await collect(); // c2 下架、旧连接迟到
  view = await book();
  assert.equal(view.symbols.ORE.state, 'coherent');
  assert.equal(view.symbols.ORE.basis.through, 14);
  assert.equal(view.symbols.ORE.bids[0].size, '3');
  assert.equal(view.symbols.COAL.state, 'invalid');
  assert.ok(view.symbols.ORE.history.some((h) => h.event === 'invalidated' && h.reason === 'gap' && h.expected === 13));
  assert.ok(view.symbols.ORE.history.some((h) => h.event === 'recovered' && h.through === 14));
  phase('恢复后收敛', view.symbols);
  phase('事件轨迹', view.events);

  console.log('演练通过：断线、快照与增量交叉、品种下架、同价多条目、接收后未发布就停止全部符合预期');
} finally {
  await service?.close().catch(() => {});
  await fixture?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
