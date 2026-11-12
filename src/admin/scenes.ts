import { ApiError } from '../core/errors';
import type { Context, Row } from '../core/contracts';
import { parsePhpJson, phpFloatString, phpNumberType, phpTrim, type PhpNumberType } from '../core/php';

/** FILTER_VALIDATE_INT's scalar cast, whitespace, decimal syntax and PHP64 range. */
export function sceneInteger(value: unknown, type?: PhpNumberType, minimum = 1): bigint | null {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'boolean') text = value ? '1' : '';
  else if (typeof value === 'number') text = (type ?? (Number.isInteger(value) ? 'integer' : 'double')) === 'double' ? phpFloatString(value) : String(value);
  else return null;
  // PHP's filter trim omits NUL and form feed; it differs from both JS trim()
  // and PHP trim(). Leading zeroes are invalid without an octal filter flag.
  text = text.replace(/^[ \t\n\r\v]+|[ \t\n\r\v]+$/g, '');
  if (!/^[+-]?(?:0|[1-9][0-9]*)$/.test(text)) return null;
  const integer = BigInt(text);
  return integer < BigInt(minimum) || integer > 9223372036854775807n ? null : integer;
}
export function sceneBaseUrl(configured = process.env.SCENE_SERVER_BASE_URL || 'https://y1.b0.01xr.com/v1/server'): string {
  const value = configured.trim().replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid SCENE_SERVER_BASE_URL'); }
  const path = url.pathname.replace(/\/+$/, '');
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === 'y1-p' && url.port === '8080') || url.username || url.password || url.search || url.hash || path !== '' && path !== '/v1/server') throw new Error('Invalid SCENE_SERVER_BASE_URL');
  return path === '' ? `${value}/v1/server` : value;
}
function unwrap(input: unknown): Row[] {
  for (let depth = 0; depth <= 5; depth++) {
    if (Array.isArray(input)) return input;
    if (!input || typeof input !== 'object') break;
    const value = input as Row;
    const key = ['data', 'items', 'results'].find(field => value[field] && typeof value[field] === 'object');
    if (!key) break;
    input = value[key];
  }
  throw new Error('Invalid scene list');
}
export class SceneCatalog {
  private cached?: { until: number; games: Row[] };
  private forwarded?: { until: number; payload: unknown };
  constructor(private readonly options: { baseUrl?: string; fetch?: typeof fetch; perPage?: number; maxPages?: number; timeoutMs?: number; now?: () => number } = {}) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  async forwardCheckin(ctx: Context): Promise<unknown> {
    // Yii Cache::get uses false as the miss sentinel, so JSON false never hits.
    if (this.forwarded && this.forwarded.until > this.now() && this.forwarded.payload !== false) return this.forwarded.payload;
    try {
      // Keep normal TLS certificate verification enabled. The old forwarding
      // helper disabled peer verification; that unsafe transport option is not ported.
      const response = await (this.options.fetch ?? fetch)(`${sceneBaseUrl(this.options.baseUrl)}/checkin?expand=verse_id,name`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      ctx.res.status(response.status);
      const text = await response.text();
      try {
        const payload: unknown = parsePhpJson(text);
        // Source caches every decoded JSON response, including upstream errors.
        // Cache hits return that body with the next request's default HTTP 200.
        this.forwarded = { until: this.now() + 30000, payload };
        return payload;
      } catch { ctx.res.type('text/plain'); return text; }
    } catch { throw new ApiError(500, '转发请求失败', undefined, 'HttpException'); }
  }
  async fetchScenes(): Promise<Row[]> {
    const base = sceneBaseUrl(this.options.baseUrl);
    const perPage = this.options.perPage ?? 15, maxPages = this.options.maxPages ?? 100;
    const deadline = this.now() + (this.options.timeoutMs ?? 15000);
    let pages = 1, first: Record<string, number | null> | undefined;
    const items: Row[] = [];
    for (let page = 1; page <= Math.max(1, pages); page++) {
      const remaining = Math.ceil(deadline - this.now());
      if (remaining <= 0) throw new Error('Scene request deadline exceeded');
      const url = new URL(`${base}/checkin`);
      url.search = new URLSearchParams({ expand: 'verse_id,name', page: String(page), pageSize: String(perPage) }).toString();
      const response = await (this.options.fetch ?? fetch)(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(remaining) });
      if (!response.ok || this.now() >= deadline) throw new Error('Scene service unavailable');
      items.push(...unwrap(parsePhpJson(await response.text())));
      const meta: Record<string, number | null> = {};
      for (const suffix of ['page-count', 'total-count', 'per-page']) {
        const header = response.headers.get(`x-pagination-${suffix}`);
        const integer = header === null ? null : sceneInteger(phpTrim(header), undefined, suffix === 'per-page' ? 1 : 0);
        if (header !== null && integer === null) throw new Error('Invalid scene pagination');
        meta[suffix] = integer === null ? null : Number(integer);
      }
      const derived = meta['total-count'] === 0 ? 0 : meta['total-count'] !== null && meta['per-page'] !== null ? Math.ceil(meta['total-count'] / meta['per-page']) : null;
      if (derived !== null) { if (meta['page-count'] !== null && meta['page-count'] !== derived) throw new Error('Inconsistent scene pagination'); meta['page-count'] = derived; }
      if (meta['page-count'] === null && (meta['per-page'] !== null || meta['total-count'] !== null)) throw new Error('Incomplete scene pagination');
      if (!first) { first = meta; pages = meta['page-count'] ?? 1; if (pages > maxPages) throw new Error('Scene page limit exceeded'); }
      else for (const key of Object.keys(meta)) if (first[key] !== null && meta[key] !== null && first[key] !== meta[key]) throw new Error('Scene pagination changed');
    }
    if (first!['total-count'] !== null && items.length !== first!['total-count'] || pages === 0 && items.length || this.now() >= deadline) throw new Error('Incomplete scene catalog');
    return items;
  }
  async getGames(): Promise<Row[]> {
    if (this.cached && this.cached.until > this.now()) return this.cached.games;
    try {
      const rows = await this.fetchScenes();
      const games = new Map<bigint, Row>();
      for (const scene of rows) {
        const integer = sceneInteger(scene?.verse_id, scene && typeof scene === 'object' ? phpNumberType(scene, 'verse_id') : undefined);
        if (integer === null || typeof scene.name !== 'string' || phpTrim(scene.name) === '') continue;
        games.set(integer, { id: Number(integer), name: scene.name, description: typeof scene.description === 'string' ? scene.description : '', category: typeof scene.category === 'string' ? scene.category : '' });
      }
      if (rows.length && !games.size) throw new Error('Scene list has no valid scenes');
      const result = [...games.values()];
      this.cached = { until: this.now() + 30000, games: result };
      return result;
    } catch { throw new ApiError(503, '游戏列表暂时不可用，请稍后重试', undefined, 'HttpException'); }
  }
}
