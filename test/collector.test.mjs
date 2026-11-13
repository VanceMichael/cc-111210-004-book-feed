import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BookEngine } from '../src/book.mjs';
import { Collector } from '../src/collector.mjs';
import { startService } from '../src/service.mjs';
import { startFixture } from '../fixtures/source.mjs';

test('采集器走完整演练源：重复、缺号、重建、下架、旧连接迟到', async () => {
  const fixture = await startFixture();
  try {
    const engine = new BookEngine();
    const collector = new Collector({ source: fixture.url, engine, symbols: ['ORE', 'COAL'] });
    await collector.subscribe();
    await collector.pollStep(); // 序号 11、12
    assert.equal(engine.view('ORE').bids[0].size, '10'); // 同价两条目
    await collector.pollStep(); // 重复 12、缺号 14
    assert.equal(engine.view('ORE').state, 'rebuilding');
    await collector.rebuildOnce(); // ORE 快照覆盖到 14
    assert.equal(engine.view('ORE').state, 'coherent');
    assert.equal(engine.view('ORE').basis.through, 14);
    assert.equal(engine.view('COAL').state, 'rebuilding'); // 来源没有 COAL 的重建快照
    await collector.pollStep(); // c2 下架 COAL；c1#15 迟到
    assert.equal(engine.view('COAL').state, 'invalid');
    assert.equal(engine.view('ORE').bids[0].size, '3'); // 迟到消息的 9 被丢弃
    assert.ok(engine.events.some((e) => e.event === 'late-discarded' && e.sequence === 15));
    await collector.pollStep(); // 无新消息
    assert.equal(engine.view('ORE').state, 'coherent');
  } finally {
    await fixture.close();
  }
});

test('断线后重连全量重订阅并收敛', async () => {
  let fixture = await startFixture();
  const engine = new BookEngine();
  const collector = new Collector({ source: fixture.url, engine, symbols: ['ORE', 'COAL'] });
  try {
    await collector.subscribe();
    await collector.pollStep();
    await fixture.close();
    const failed = await collector.pollStep();
    assert.ok(failed.error);
    assert.equal(engine.view('ORE').state, 'rebuilding'); // 断线后不再展示旧档位
    fixture = await startFixture();
    collector.source = fixture.url;
    await collector.pollStep(); // 重订阅 + 序号 11、12
    await collector.pollStep(); // 重复、缺号
    await collector.rebuildOnce();
    await collector.pollStep(); // 下架、旧连接迟到
    assert.equal(engine.view('ORE').state, 'coherent');
    assert.equal(engine.view('ORE').bids[0].size, '3');
    assert.equal(engine.view('COAL').state, 'invalid');
  } finally {
    await fixture.close();
  }
});

test('服务端点区分连贯报价、等待重建与已失效，停止后状态可恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'book-service-'));
  const fixture = await startFixture();
  let service = await startService({ source: fixture.url, directory });
  try {
    await (await fetch(service.url + '/collect')).json(); // 序号 11、12
    await (await fetch(service.url + '/collect')).json(); // 重复、缺号
    let view = await (await fetch(service.url + '/book')).json();
    assert.equal(view.symbols.ORE.state, 'rebuilding');
    assert.equal(view.symbols.ORE.stateLabel, '等待重建');
    await service.close(); // 接收后未发布就停止
    service = await startService({ source: fixture.url, directory });
    view = await (await fetch(service.url + '/book')).json();
    assert.equal(view.symbols.ORE.state, 'rebuilding'); // 状态从磁盘恢复
    assert.equal(view.symbols.ORE.basis.applied, 12);
    await (await fetch(service.url + '/rebuild')).json();
    await (await fetch(service.url + '/collect')).json();
    view = await (await fetch(service.url + '/book')).json();
    assert.equal(view.symbols.ORE.state, 'coherent');
    assert.equal(view.symbols.ORE.stateLabel, '连贯报价');
    assert.equal(view.symbols.COAL.state, 'invalid');
    assert.equal(view.symbols.COAL.stateLabel, '已失效');
    const ore = await (await fetch(service.url + '/book?symbol=ORE')).json();
    assert.equal(ore.bids[0].entries[0].id, 'bid-2');
    assert.equal(ore.bids[0].size, '3');
  } finally {
    await service.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
