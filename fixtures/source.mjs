import { listen } from '../src/http.mjs';
export const messages = [
 { connection: 'c1', sequence: 11, changes: [{ symbol: 'ORE', action: 'change', id: 'bid-1', size: '7' }, { symbol: 'COAL', action: 'add', id: 'ask-2', side: 'ask', price: '80', size: '2' }] },
 { connection: 'c1', sequence: 12, changes: [{ symbol: 'ORE', action: 'add', id: 'bid-2', side: 'bid', price: '100', size: '3' }] },
 { connection: 'c1', sequence: 12, changes: [{ symbol: 'ORE', action: 'add', id: 'bid-2', side: 'bid', price: '100', size: '3' }] },
 { connection: 'c1', sequence: 14, changes: [{ symbol: 'ORE', action: 'delete', id: 'bid-1' }] },
 { connection: 'c2', sequence: 1, changes: [{ symbol: 'COAL', action: 'withdraw' }] },
 { connection: 'c1', sequence: 15, changes: [{ symbol: 'ORE', action: 'change', id: 'bid-2', size: '9' }] },
];
export async function startFixture() {
  return listen(async url => {
    if (url.pathname === '/snapshot') {
      const symbol = url.searchParams.get('symbol');
      if (!['ORE', 'COAL'].includes(symbol)) return { status: 404, body: { error: '品种不存在' } };
      const entry = symbol === 'ORE' ? { id: 'bid-1', side: 'bid', price: '100', size: '5' } : { id: 'ask-1', side: 'ask', price: '80', size: '1' };
      return { body: { symbol, connection: 'c1', through: 10, entries: [entry], raw: `35=W\x0134=10\x0155=${symbol}\x01269=${entry.side === 'bid' ? 0 : 1}\x01270=${entry.price}\x01271=${entry.size}\x01` } };
    }
    if (url.pathname === '/messages') { const start = Number(url.searchParams.get('offset') ?? 0); return { body: { messages: messages.slice(start, start + 2), next: Math.min(start + 2, messages.length) } }; }
    if (url.pathname === '/rebuild') return { body: { symbol: 'ORE', connection: 'c1', through: 14, entries: [{ id: 'bid-2', side: 'bid', price: '100', size: '3' }] } };
    return { status: 404, body: {} };
  });
}
