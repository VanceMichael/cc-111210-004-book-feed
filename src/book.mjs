import { addDecimal, compareDecimal, isDecimal } from './decimal.mjs';

const ACTIONS = new Set(['add', 'change', 'delete', 'withdraw']);
const SIDES = new Set(['bid', 'ask']);

export const STATE_LABELS = {
  coherent: '连贯报价',
  rebuilding: '等待重建',
  invalid: '已失效',
};

// 订单簿重建引擎：只负责状态机，不做任何网络与文件操作。
// 不变式：
//  - 序号按连接各自连续；同一连接上一旦出现缺号，该连接上所有连贯品种一起失效。
//  - 缺号不靠排序后重放弥补，只能由声明覆盖序号的快照恢复。
//  - 快照到达期间收到的增量缓存在连接缓冲里，快照之后按序号追平，缓冲有上限。
//  - 旧连接纪元的迟到消息直接丢弃，绝不并入新纪元的订单簿。
export class BookEngine {
  constructor({ bufferLimit = 200, historyLimit = 50, eventLimit = 200 } = {}) {
    this.bufferLimit = bufferLimit;
    this.historyLimit = historyLimit;
    this.eventLimit = eventLimit;
    this.symbols = new Map();
    this.connections = new Map();
    this.current = null;
    this.events = [];
    this.clock = 0;
  }

  static fromJSON(data, options = {}) {
    const engine = new BookEngine({
      bufferLimit: options.bufferLimit ?? data.bufferLimit,
      historyLimit: data.historyLimit,
      eventLimit: data.eventLimit,
    });
    for (const [name, state] of Object.entries(data.symbols ?? {})) {
      engine.symbols.set(name, {
        status: state.status,
        basis: state.basis,
        lastApplied: state.lastApplied,
        entries: new Map((state.entries ?? []).map((entry) => [entry.id, entry])),
        history: state.history ?? [],
      });
    }
    for (const [id, conn] of Object.entries(data.connections ?? {})) {
      engine.connections.set(id, { lastSeq: conn.lastSeq, buffer: new Map(conn.buffer ?? []) });
    }
    engine.current = data.current ?? null;
    engine.events = data.events ?? [];
    engine.clock = data.clock ?? 0;
    return engine;
  }

  toJSON() {
    return {
      bufferLimit: this.bufferLimit,
      historyLimit: this.historyLimit,
      eventLimit: this.eventLimit,
      symbols: Object.fromEntries([...this.symbols].map(([name, state]) => [name, {
        status: state.status,
        basis: state.basis,
        lastApplied: state.lastApplied,
        entries: [...state.entries.values()],
        history: state.history,
      }])),
      connections: Object.fromEntries([...this.connections].map(([id, conn]) => [id, {
        lastSeq: conn.lastSeq,
        buffer: [...conn.buffer],
      }])),
      current: this.current,
      events: this.events,
      clock: this.clock,
    };
  }

  _symbolState(symbol) {
    let state = this.symbols.get(symbol);
    if (!state) {
      state = { status: 'rebuilding', basis: null, lastApplied: null, entries: new Map(), history: [] };
      this.symbols.set(symbol, state);
    }
    return state;
  }

  _log(state, entry) {
    state.history.push({ at: ++this.clock, time: new Date().toISOString(), ...entry });
    if (state.history.length > this.historyLimit) state.history.splice(0, state.history.length - this.historyLimit);
  }

  recordEvent(entry) {
    this.events.push({ at: ++this.clock, time: new Date().toISOString(), ...entry });
    if (this.events.length > this.eventLimit) this.events.splice(0, this.events.length - this.eventLimit);
  }

  ingest(message) {
    const { connection, sequence, changes } = message ?? {};
    if (typeof connection !== 'string' || !connection) throw new Error('消息无效: 缺少连接标识');
    if (!Number.isInteger(sequence) || sequence < 1) throw new Error('消息无效: 序号异常');
    if (!Array.isArray(changes)) throw new Error('消息无效: 缺少变动列表');
    for (const change of changes) {
      if (typeof change?.symbol !== 'string' || !change.symbol) throw new Error('消息无效: 变动缺少品种');
      if (!ACTIONS.has(change.action)) throw new Error(`消息无效: 未知动作 ${change?.action}`);
    }

    let conn = this.connections.get(connection);
    if (!conn) {
      // 新连接纪元：首个到达的序号即该纪元的接收起点。
      conn = { lastSeq: sequence, buffer: new Map([[sequence, message]]) };
      this.connections.set(connection, conn);
      const previous = this.current;
      this.current = connection;
      this.recordEvent({ event: 'epoch', connection, previous, sequence });
      this._trimBuffer(conn, connection);
      return this._deliver(conn, message);
    }
    if (connection !== this.current) {
      // 旧连接纪元的迟到消息，一律丢弃。
      this.recordEvent({ event: 'late-discarded', connection, sequence, current: this.current });
      return { applied: false, reason: 'stale-connection' };
    }
    if (sequence <= conn.lastSeq) {
      this.recordEvent({ event: 'duplicate', connection, sequence });
      return { applied: false, reason: 'duplicate' };
    }
    if (sequence > conn.lastSeq + 1) {
      // 缺号：该连接上所有连贯品种失效；消息只入缓冲，等待快照，绝不排序重放。
      const expected = conn.lastSeq + 1;
      for (const state of this.symbols.values()) {
        if (state.status === 'live' && state.basis?.connection === connection) {
          state.status = 'rebuilding';
          this._log(state, { event: 'invalidated', reason: 'gap', connection, expected, received: sequence, lastApplied: state.lastApplied });
        }
      }
      this.recordEvent({ event: 'gap', connection, expected, received: sequence });
      this._touchAcrossConnections(connection, sequence, changes);
      conn.lastSeq = sequence;
      conn.buffer.set(sequence, message);
      this._trimBuffer(conn, connection);
      return { applied: false, reason: 'gap', expected };
    }
    conn.lastSeq = sequence;
    conn.buffer.set(sequence, message);
    this._trimBuffer(conn, connection);
    return this._deliver(conn, message);
  }

  // 缺号消息里仍可能带有下架或跨连接品种的变动，这些事实性动作照常登记。
  _touchAcrossConnections(connection, sequence, changes) {
    for (const change of changes) {
      const state = this._symbolState(change.symbol);
      if (change.action === 'withdraw') {
        state.status = 'withdrawn';
        state.entries.clear();
        this._log(state, { event: 'withdrawn', connection, sequence });
      } else if (state.status === 'live' && state.basis?.connection !== connection) {
        state.status = 'rebuilding';
        this._log(state, { event: 'invalidated', reason: 'epoch', connection, sequence, basisConnection: state.basis?.connection, lastApplied: state.lastApplied });
      } else if (state.status === 'withdrawn') {
        state.status = 'rebuilding';
        this._log(state, { event: 'invalidated', reason: 'revive', connection, sequence, note: '下架品种出现新增量，等待快照重建' });
      }
    }
  }

  _deliver(conn, message) {
    const { connection, sequence, changes } = message;
    for (const change of changes) {
      const state = this._symbolState(change.symbol);
      if (change.action === 'withdraw') {
        state.status = 'withdrawn';
        state.entries.clear();
        this._log(state, { event: 'withdrawn', connection, sequence });
        continue;
      }
      if (state.status === 'withdrawn') {
        state.status = 'rebuilding';
        this._log(state, { event: 'invalidated', reason: 'revive', connection, sequence, note: '下架品种出现新增量，等待快照重建' });
        continue;
      }
      if (state.status !== 'live') continue; // 重建中：内容已在连接缓冲，等待快照
      if (state.basis?.connection !== connection) {
        // 新纪元的增量不能套在旧连接基点上。
        state.status = 'rebuilding';
        this._log(state, { event: 'invalidated', reason: 'epoch', connection, sequence, basisConnection: state.basis?.connection, lastApplied: state.lastApplied });
        continue;
      }
      if (state.lastApplied !== sequence - 1) continue; // 防御：缺号分支已先行失效
      if (!this._applyChange(state, change)) {
        state.status = 'rebuilding';
        this._log(state, { event: 'invalidated', reason: 'invalid-change', connection, sequence, change });
      }
    }
    // 连贯推进：该连接上所有连贯品种（含本条未触及的）前进到本序号。
    for (const state of this.symbols.values()) {
      if (state.status === 'live' && state.basis?.connection === connection && state.lastApplied === sequence - 1) {
        state.lastApplied = sequence;
      }
    }
    return { applied: true };
  }

  _applyChange(state, change) {
    const { action, id } = change;
    if (action === 'add') {
      if (typeof id !== 'string' || !id || !SIDES.has(change.side) || !isDecimal(change.price) || !isDecimal(change.size)) return false;
      if (state.entries.has(id)) this._log(state, { event: 'add-duplicate-id', id });
      state.entries.set(id, { id, side: change.side, price: change.price, size: change.size });
      return true;
    }
    if (action === 'change') {
      if (typeof id !== 'string' || !id) return false;
      const entry = state.entries.get(id);
      if (!entry) {
        this._log(state, { event: 'unknown-entry', id, action });
        return true;
      }
      if (change.price !== undefined) {
        if (!isDecimal(change.price)) return false;
        entry.price = change.price;
      }
      if (change.size !== undefined) {
        if (!isDecimal(change.size)) return false;
        entry.size = change.size;
      }
      return true;
    }
    if (action === 'delete') {
      if (typeof id !== 'string' || !id) return false;
      if (!state.entries.delete(id)) this._log(state, { event: 'unknown-entry', id, action });
      return true;
    }
    return false;
  }

  applySnapshot(snapshot) {
    const { symbol, connection, through, entries } = snapshot ?? {};
    if (typeof symbol !== 'string' || !symbol) throw new Error('快照无效: 缺少品种');
    if (typeof connection !== 'string' || !connection) throw new Error('快照无效: 缺少连接标识');
    if (!Number.isInteger(through) || through < 0) throw new Error('快照无效: 覆盖序号异常');
    if (!Array.isArray(entries)) throw new Error('快照无效: 缺少条目列表');
    for (const entry of entries) {
      if (typeof entry?.id !== 'string' || !entry.id || !SIDES.has(entry.side) || !isDecimal(entry.price) || !isDecimal(entry.size)) {
        throw new Error('快照无效: 条目字段异常');
      }
    }
    let conn = this.connections.get(connection);
    if (!conn) {
      conn = { lastSeq: through, buffer: new Map() };
      this.connections.set(connection, conn);
      if (this.current === null) this.current = connection;
    } else if (through > conn.lastSeq) {
      conn.lastSeq = through;
    }
    const state = this._symbolState(symbol);
    if (state.basis?.connection === connection && through <= (state.lastApplied ?? -1)) {
      // 不覆盖缺口的快照没有恢复价值：连贯时冗余，重建时过旧。
      const reason = state.status === 'live' ? 'redundant' : 'stale';
      this._log(state, { event: 'snapshot-rejected', reason, connection, through, lastApplied: state.lastApplied });
      return { applied: false, reason };
    }
    state.entries = new Map(entries.map((entry) => [entry.id, { ...entry }]));
    state.basis = { connection, through };
    state.lastApplied = through;
    const first = state.history.length === 0;
    // 用该连接上缓存的后续增量追平；遇到缺口立即停下，不跳过。
    let applied = 0;
    let cursor = through + 1;
    let broken = null;
    while (conn.buffer.has(cursor)) {
      const buffered = conn.buffer.get(cursor);
      for (const change of buffered.changes) {
        if (change.symbol !== symbol) continue;
        if (change.action === 'withdraw') {
          state.status = 'withdrawn';
          state.entries.clear();
          this._log(state, { event: 'withdrawn', connection, sequence: cursor });
          return { applied: true, caughtUp: false, withdrawn: true };
        }
        if (!this._applyChange(state, change)) broken = change;
      }
      if (broken) break;
      state.lastApplied = cursor;
      applied += 1;
      cursor += 1;
    }
    if (broken) {
      state.status = 'rebuilding';
      this._log(state, { event: 'invalidated', reason: 'invalid-change', connection, sequence: cursor, change: broken });
      return { applied: true, caughtUp: false };
    }
    const caughtUp = state.lastApplied >= conn.lastSeq;
    state.status = caughtUp ? 'live' : 'rebuilding';
    this._log(state, {
      event: first ? 'snapshot' : caughtUp ? 'recovered' : 'rebuild-incomplete',
      connection,
      through,
      appliedTo: state.lastApplied,
      pendingApplied: applied,
      ...(caughtUp ? {} : { missing: cursor }),
    });
    return { applied: true, caughtUp };
  }

  disconnect(reason = '连接中断') {
    for (const state of this.symbols.values()) {
      if (state.status === 'live') {
        state.status = 'rebuilding';
        this._log(state, { event: 'invalidated', reason: 'disconnect', connection: state.basis?.connection, lastApplied: state.lastApplied });
      }
    }
    this.recordEvent({ event: 'disconnect', reason });
  }

  reset(reason) {
    this.recordEvent({ event: 'reset', reason });
    this.symbols.clear();
    this.connections.clear();
    this.current = null;
  }

  _trimBuffer(conn, connection) {
    while (conn.buffer.size > this.bufferLimit) {
      const lowest = Math.min(...conn.buffer.keys());
      conn.buffer.delete(lowest);
      this.recordEvent({ event: 'buffer-evicted', connection, sequence: lowest });
    }
  }

  view(symbol) {
    if (symbol !== undefined && symbol !== null) {
      const state = this.symbols.get(symbol);
      return state
        ? this._viewOne(symbol, state)
        : { symbol, state: 'unknown', stateLabel: '未订阅', publishable: false };
    }
    return Object.fromEntries([...this.symbols].map(([name, state]) => [name, this._viewOne(name, state)]));
  }

  _viewOne(symbol, state) {
    const code = state.status === 'live' ? 'coherent' : state.status === 'rebuilding' ? 'rebuilding' : 'invalid';
    const publishable = state.status === 'live';
    const view = {
      symbol,
      state: code,
      stateLabel: STATE_LABELS[code],
      publishable,
      basis: state.basis ? { ...state.basis, applied: state.lastApplied } : null,
      bids: [],
      asks: [],
      history: state.history,
    };
    if (publishable) {
      // 只有状态确实连贯才给出档位；其余状态只给依据与轨迹。
      view.bids = this._levels(state, 'bid', (a, b) => compareDecimal(b, a));
      view.asks = this._levels(state, 'ask', compareDecimal);
    }
    return view;
  }

  _levels(state, side, comparator) {
    const groups = new Map();
    for (const entry of state.entries.values()) {
      if (entry.side !== side) continue;
      const list = groups.get(entry.price) ?? [];
      list.push({ id: entry.id, size: entry.size });
      groups.set(entry.price, list);
    }
    return [...groups]
      .sort((a, b) => comparator(a[0], b[0]))
      .map(([price, list]) => ({
        price,
        size: list.reduce((total, entry) => addDecimal(total, entry.size), '0'),
        entries: list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }));
  }
}
