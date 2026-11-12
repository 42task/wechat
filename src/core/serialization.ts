const xmlClass = Symbol('Yii XML object class');

/** PHP object class names are XML tags, but are absent from JSON responses. */
export function yiiObject<T extends object>(type: string, value: T): T {
  Object.defineProperty(value, xmlClass, { value: type });
  return value;
}

export function xmlResponse(value: unknown): string {
  const escape = (data: unknown) => String(data ?? '').split('\0', 1)[0].replace(/[&<>\r]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#13;' }[char]!));
  // XML 1.0 NameStartChar/NameChar, as accepted by PHP DOMDocument.
  const validName = /^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}][:A-Z_a-z0-9.\-\u00B7\u0300-\u036F\u203F-\u2040\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]*$/u;
  const wrap = (name: string, content: string, scalar = false) => content || scalar ? `<${name}>${content}</${name}>` : `<${name}/>`;
  function content(data: unknown): string {
    if (data === null || typeof data !== 'object') return escape(data);
    const children = Object.entries(data).map(([key, nested]) => {
      // A numeric array key whose value is an object emits the object tag itself.
      if (Array.isArray(data) && nested !== null && typeof nested === 'object' && (nested as any)[xmlClass]) return content(nested);
      const candidate = key.split('\0', 1)[0];
      const name = validName.test(candidate) ? candidate : 'item';
      return wrap(name, content(nested), nested === null || typeof nested !== 'object');
    }).join('');
    return (data as any)[xmlClass] ? wrap((data as any)[xmlClass], children) : children;
  }
  return value === null || value === undefined ? '' : `<?xml version="1.0" encoding="UTF-8"?>\n${wrap('response', content(value), typeof value !== 'object')}\n`;
}
