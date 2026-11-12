import { get } from './http.mjs';
export function decodeFields(line) {
  const result = [];
  for (const pair of line.trim().split('\x01').filter(Boolean)) {
    const separator = pair.indexOf('=');
    if (separator < 1) throw new Error('行情字段无效');
    result.push([pair.slice(0, separator), pair.slice(separator + 1)]);
  }
  return result;
}
export async function inspect(base, options = {}) {
  const data = await (await get(base, '/snapshot?symbol=' + (options.symbol ?? 'ORE'))).json();
  return { ...data, fields: decodeFields(data.raw) };
}
