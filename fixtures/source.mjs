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
    if (url.pathname === '/snapshot') return { body: { symbol: url.searchParams.get('symbol'), connection: 'c1', through: 10, entries: [{ id: 'bid-1', side: 'bid', price: '100', size: '5' }], raw: '35=W\x0134=10\x0155=ORE\x01269=0\x01270=100\x01271=5\x01' } };
    if (url.pathname === '/messages') { const start = Number(url.searchParams.get('offset') ?? 0); return { body: { messages: messages.slice(start, start + 2), next: Math.min(start + 2, messages.length) } }; }
    if (url.pathname === '/rebuild') return { body: { symbol: 'ORE', connection: 'c1', through: 14, entries: [{ id: 'bid-2', side: 'bid', price: '100', size: '3' }] } };
    return { status: 404, body: {} };
  });
}
