import { listen } from './http.mjs';
import { inspect } from './connector.mjs';
import { ReceiptStore, StateStore } from './store.mjs';
import { BookEngine } from './book.mjs';
import { Collector } from './collector.mjs';

export async function startService({ source, directory, port = 0, symbols = ['ORE', 'COAL'], autoCollect = false, intervalMs = 500, bufferLimit } = {}) {
  const store = new ReceiptStore(directory);
  const stateStore = new StateStore(directory);
  const saved = await stateStore.load();
  const engine = saved ? BookEngine.fromJSON(saved.engine, { bufferLimit }) : new BookEngine({ bufferLimit });
  const collector = saved
    ? new Collector({ source, engine, symbols: saved.collector.symbols ?? symbols, offset: saved.collector.offset, disconnected: saved.collector.disconnected })
    : new Collector({ source, engine, symbols });
  const persist = () => stateStore.save({ engine: engine.toJSON(), collector: collector.toJSON() });
  if (!saved) {
    // 首次启动：先取各品种快照，再开始接收增量。
    await collector.subscribe();
    await persist();
  }

  let chain = Promise.resolve();
  const queued = (task) => {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  };

  let timer = null;
  if (autoCollect) {
    timer = setInterval(() => {
      queued(async () => {
        const polled = await collector.pollStep();
        const rebuilt = await collector.rebuildOnce();
        if (polled.polled || polled.error || rebuilt.some((r) => r.applied)) await persist();
      }).catch(() => {});
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  const handle = await listen(async url => {
    if (url.pathname === '/health') return { body: { state: 'ready', collector: collector.toJSON() } };
    if (url.pathname === '/inspect') {
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: result };
    }
    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: await store.save(key, result) };
    }
    if (url.pathname.startsWith('/receipts/')) return { body: await store.read(url.pathname.split('/').pop()) };
    if (url.pathname === '/book') {
      const symbol = url.searchParams.get('symbol');
      if (symbol) return { body: engine.view(symbol) };
      return { body: { symbols: engine.view(), events: engine.events, collector: collector.toJSON() } };
    }
    if (url.pathname === '/collect') {
      return { body: await queued(async () => {
        const result = await collector.pollStep();
        await persist();
        return { ...result, view: engine.view() };
      }) };
    }
    if (url.pathname === '/rebuild') {
      return { body: await queued(async () => {
        const results = await collector.rebuildOnce();
        await persist();
        return { results, view: engine.view() };
      }) };
    }
    return { status: 404, body: { error: '接口不存在' } };
  }, port);

  return {
    url: handle.url,
    engine,
    collector,
    close: async () => {
      if (timer) clearInterval(timer);
      await persist();
      await handle.close();
    },
  };
}
