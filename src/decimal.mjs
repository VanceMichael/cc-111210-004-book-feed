// 十进制字符串的精确比较与加法，价格与数量不走浮点。
const PATTERN = /^-?\d+(\.\d+)?$/;

export function isDecimal(text) {
  return typeof text === 'string' && PATTERN.test(text);
}

function split(text) {
  if (!isDecimal(text)) throw new Error(`十进制字符串无效: ${text}`);
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf('.');
  return dot < 0
    ? { negative, integer: body, fraction: '' }
    : { negative, integer: body.slice(0, dot), fraction: body.slice(dot + 1) };
}

export function compareDecimal(a, b) {
  const pa = split(a);
  const pb = split(b);
  if (pa.negative !== pb.negative) return pa.negative ? -1 : 1;
  const intA = pa.integer.replace(/^0+(?=\d)/, '');
  const intB = pb.integer.replace(/^0+(?=\d)/, '');
  let result = 0;
  if (intA.length !== intB.length) result = intA.length < intB.length ? -1 : 1;
  else if (intA !== intB) result = intA < intB ? -1 : 1;
  else {
    const width = Math.max(pa.fraction.length, pb.fraction.length);
    const fa = pa.fraction.padEnd(width, '0');
    const fb = pb.fraction.padEnd(width, '0');
    result = fa === fb ? 0 : fa < fb ? -1 : 1;
  }
  return pa.negative && result !== 0 ? -result : result;
}

export function addDecimal(a, b) {
  const pa = split(a);
  const pb = split(b);
  if (pa.negative || pb.negative) throw new Error('档位合计只支持非负数值');
  const width = Math.max(pa.fraction.length, pb.fraction.length);
  const scale = 10n ** BigInt(width);
  const toUnits = (part) => BigInt(part.integer) * scale + (width ? BigInt(part.fraction.padEnd(width, '0')) : 0n);
  const sum = toUnits(pa) + toUnits(pb);
  const integer = sum / scale;
  const fraction = width ? (sum % scale).toString().padStart(width, '0').replace(/0+$/, '') : '';
  return fraction ? `${integer}.${fraction}` : integer.toString();
}
