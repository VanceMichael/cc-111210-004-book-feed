import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from './service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'capture-demo-'));
const source = await startFixture();
let service;
try {
  service = await startService({ source: source.url, directory });
  const receiptResponse = await fetch(service.url + '/receive?key=demo');
  const receipt = await receiptResponse.json();
  if (!receiptResponse.ok) process.exitCode = 1;
  // 订单簿采集：增量 → 缺号 → 快照重建 → 下架与旧连接迟到
  await (await fetch(service.url + '/collect')).json();
  await (await fetch(service.url + '/collect')).json();
  await (await fetch(service.url + '/rebuild')).json();
  await (await fetch(service.url + '/collect')).json();
  const book = await (await fetch(service.url + '/book')).json();
  console.log(JSON.stringify({ source: source.url, receipt, book }, null, 2));
} finally {
  await service?.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
