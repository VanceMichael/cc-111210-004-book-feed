import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptStore, StateStore } from '../src/store.mjs';
import { startService } from '../src/service.mjs';
import { startFixture } from '../fixtures/source.mjs';

test('接收记录支持同内容重复领取并拒绝覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipt-'));
  try {
    const store = new ReceiptStore(directory);
    assert.deepEqual(await store.save('one', { value: 3 }), await store.save('one', { value: 3 }));
    await assert.rejects(store.save('one', { value: 4 }), /冲突/);
    await assert.rejects(store.save('../escape', {}), /无效/);
    const receipt = JSON.parse(await readFile(join(directory, 'one.json'), 'utf8'));
    receipt.value.value = 8;
    await writeFile(join(directory, 'one.json'), JSON.stringify(receipt));
    await assert.rejects(store.read('one'), /校验失败/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('接收进度状态可持久化并识别篡改', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'state-'));
  try {
    const store = new StateStore(directory);
    assert.equal(await store.load(), null);
    await store.save({ offset: 4, engine: { note: '重建中' } });
    assert.deepEqual((await store.load()).engine, { note: '重建中' });
    const path = join(directory, 'book-state.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.state.offset = 99;
    await writeFile(path, JSON.stringify(record));
    await assert.rejects(store.load(), /校验失败/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('服务健康检查和单次查看走真实来源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    assert.equal((await (await fetch(service.url + '/health')).json()).state, 'ready');
    const response = await fetch(service.url + '/inspect');
    assert.equal(response.status, 200, await response.text());
    assert.equal((await fetch(service.url + '/missing')).status, 404);
  } finally { await service.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
