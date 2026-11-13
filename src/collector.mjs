import { get } from './http.mjs';

// 轮询采集器：负责与来源交互，把消息交给引擎，不自己解释序号。
export class Collector {
  constructor({ source, engine, symbols, offset = 0, disconnected = false }) {
    this.source = source;
    this.engine = engine;
    this.symbols = [...symbols];
    this.offset = offset;
    this.disconnected = disconnected;
  }

  async subscribe() {
    for (const symbol of this.symbols) {
      const body = await (await get(this.source, '/snapshot?symbol=' + encodeURIComponent(symbol))).json();
      this.engine.applySnapshot(body);
    }
  }

  // 拉一批增量；来源不可达时把连贯品种转为等待重建，绝不把旧档位当最新。
  async pollStep() {
    let data;
    try {
      if (this.disconnected) await this.resubscribe();
      data = await (await get(this.source, '/messages?offset=' + this.offset)).json();
    } catch (error) {
      this.engine.disconnect(`来源不可达: ${error.message}`);
      this.disconnected = true;
      return { polled: 0, error: error.message };
    }
    for (const message of data.messages) this.engine.ingest(message);
    this.offset = data.next;
    return { polled: data.messages.length, offset: this.offset };
  }

  // 对处于等待重建的订阅品种逐个尝试快照恢复。
  async rebuildOnce() {
    if (this.disconnected) return [];
    const results = [];
    for (const symbol of this.symbols) {
      const state = this.engine.symbols.get(symbol);
      if (!state || state.status !== 'rebuilding') continue;
      results.push(await this._rebuildSymbol(symbol));
    }
    return results;
  }

  async _rebuildSymbol(symbol) {
    for (const path of ['/rebuild?symbol=', '/snapshot?symbol=']) {
      let body;
      try {
        body = await (await get(this.source, path + encodeURIComponent(symbol))).json();
      } catch {
        continue; // 端点不存在或来源异常，尝试下一路径
      }
      if (body?.symbol !== symbol) {
        this.engine.recordEvent({ event: 'snapshot-rejected', symbol, reason: '品种不匹配', got: body?.symbol ?? null });
        continue;
      }
      try {
        const result = this.engine.applySnapshot(body);
        if (result.applied) return { symbol, ...result };
      } catch (error) {
        this.engine.recordEvent({ event: 'snapshot-rejected', symbol, reason: error.message });
      }
    }
    return { symbol, applied: false };
  }

  // 断线恢复：无法区分来源重启与瞬时抖动，一律全量重订阅，序号规则负责去重。
  async resubscribe() {
    this.engine.reset('来源恢复，全量重新订阅');
    this.offset = 0;
    await this.subscribe();
    this.disconnected = false;
  }

  toJSON() {
    return { offset: this.offset, disconnected: this.disconnected, symbols: this.symbols };
  }
}
