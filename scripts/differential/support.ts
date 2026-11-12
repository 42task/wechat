import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import mysql, { type Pool } from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
import { request as httpRequest } from 'node:http';

export interface Target { name: 'yii' | 'node'; base: string; db: Pool; redisDb: number; }
export interface HttpResult { status: number; headers: Record<string, string>; body: any; }
export class Differential {
  config: any;
  targets: Target[];
  results: any[] = [];
  private redisClients = new Map<string, ReturnType<typeof createClient>>();
  constructor() {
    this.config = JSON.parse(readFileSync(resolve('runtime/parity-validation/context.json'), 'utf8'));
    if (!['127.0.0.1', 'localhost'].includes(this.config.mysql.host) || this.config.mysql.port === 3306 || !['127.0.0.1', 'localhost'].includes(this.config.redis.host) || this.config.redis.port === 6379) throw new Error('Differential tests require explicitly isolated localhost data ports');
    for (const name of ['yii','node']) {
      const target = this.config[name], url = new URL(target.base);
      if (!/^parity_[a-z0-9_]+$/.test(target.database) || ![12,13].includes(target.redisDb) || url.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Unsafe differential target');
    }
    this.targets = (['yii', 'node'] as const).map(name => ({ name, base: this.config[name].base, redisDb: this.config[name].redisDb,
      db: mysql.createPool({ ...this.config.mysql, database: this.config[name].database, timezone: '+08:00', dateStrings: true, decimalNumbers: true, multipleStatements: false }) }));
  }
  async sql(t: Target, text: string, values: any[] = []): Promise<any> { return (await t.db.query(text, values))[0]; }
  async redis(t: Target, args: string[]): Promise<any> {
    let client = this.redisClients.get(t.name);
    if (!client) { client = createClient({ socket: { host: this.config.redis.host, port: this.config.redis.port }, database: t.redisDb }); client.on('error', () => {}); await client.connect(); this.redisClients.set(t.name, client); }
    return client.sendCommand(args);
  }
  async reset(t: Target) {
    const connection = await t.db.getConnection();
    try {
      await connection.query('SET FOREIGN_KEY_CHECKS=0');
      const [tables] = await connection.query<any[]>('SHOW TABLES');
      for (const row of tables) {
        const table = String(Object.values(row)[0]);
        if (table === 'migration') continue;
        if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('Unexpected test table');
        await connection.query(`TRUNCATE TABLE \`${table}\``);
      }
    } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); }
    await this.redis(t, ['FLUSHDB']);
  }
  token(domain: 'v1-player' | 'v2-user', id = 1): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({ uid: id, identityDomain: domain, iss: this.config.origin, iat: now, nbf: now, exp: now + 3600 }, readFileSync(this.config.jwtKey), { algorithm: 'HS256' });
  }
  async request(t: Target, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
    const payload = body === undefined || ['GET', 'HEAD'].includes(method) ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const response = await new Promise<{ status: number; headers: Headers; raw: string }>((resolve, reject) => {
      const req = httpRequest(new URL(path, t.base), { method, headers: { Host: 'isolated.example', Origin: this.config.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const normalized = new Headers();
          for(const [name, value] of Object.entries(res.headers)) if(value !== undefined) normalized.set(name, Array.isArray(value) ? value.join(', ') : value);
          resolve({ status: res.statusCode || 0, headers: normalized, raw: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      });
      req.setTimeout(8000, () => req.destroy(new Error('Local differential request timed out')));
      req.on('error', reject);req.end(payload);
    });
    const raw = response.raw;
    let parsed: any = raw || null;
    if (raw && (response.headers.get('content-type') || '').includes('json')) { try { parsed = JSON.parse(raw); } catch { parsed = { invalidJson: true, text: raw.slice(0, 500) }; } }
    else if (raw && (response.headers.get('content-type') || '').includes('text/html')) parsed = { htmlTitle: /<title>(.*?)<\/title>/s.exec(raw)?.[1] ?? null };
    if(response.status>=400 && parsed && typeof parsed==='object' && typeof parsed.name==='string' && typeof parsed.message==='string') {
      // PHP runtime paths and stack frames are deployment diagnostics, not an
      // HTTP business contract. Keep status/name/message/code/type unchanged,
      // except the machine-specific caller suffix embedded in PHP TypeErrors.
      parsed={...parsed};
      for(const field of ['file','line','stack-trace','trace','previous'])delete parsed[field];
      parsed.message=parsed.message.replace(/, called in .* on line \d+$/s,'');
    }
    const names = ['content-type', 'allow', 'www-authenticate', 'cache-control', 'expires', 'pragma', 'access-control-allow-origin', 'access-control-allow-credentials', 'x-pagination-total-count', 'x-pagination-page-count', 'x-pagination-current-page', 'x-pagination-per-page', 'link', 'location'];
    const normalizedHeaders: Record<string,string> = {};
    for (const name of names) {
      const value = response.headers.get(name);
      if (value !== null) normalizedHeaders[name] = value.replaceAll(t.base, 'http://REFERENCE').replace(/(application\/json|text\/html);\s*charset=utf-8/i, '$1; charset=UTF-8').replace(/;\s*rel="([^"]+)"/g, '; rel=$1');
    }
    return { status: response.status, headers: normalizedHeaders, body: parsed };
  }
  async record(id: string, run: (t: Target) => Promise<unknown>, note?: string) {
    const values: Record<string, unknown> = {};
    for (const t of this.targets) { try { values[t.name] = await run(t); } catch (e) { values[t.name] = { harnessError: e instanceof Error ? e.message : String(e) }; } }
    const executed = !Object.values(values).some((value: any) => value?.harnessError);
    this.results.push({ id, executed, equal: executed && isDeepStrictEqual(values.yii, values.node), ...(note ? { note } : {}), ...values });
    console.log(`${this.results.at(-1).equal ? 'MATCH' : 'DIFFERENT'} ${id}`);
  }
  async finish(name: string) {
    const report = { generatedAt: new Date().toISOString(), total: this.results.length, matched: this.results.filter(r => r.equal).length, differences: this.results.filter(r => !r.equal).length, harnessErrors: this.results.filter(r => !r.executed).length, results: this.results };
    writeFileSync(resolve(`runtime/parity-validation/${name}.json`), JSON.stringify(report, (key, value) => {
      if (['accessToken','refreshToken','secret'].includes(key) && typeof value === 'string') return '<redacted>';
      if (typeof value === 'string') return value.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<test-jwt-redacted>').replace(/([?&]secret=)[a-f0-9]{64}/g, '$1<redacted>');
      return typeof value === 'bigint' ? String(value) : value;
    }, 2));
    await this.close();
    return report;
  }
  async close() { await Promise.allSettled([...this.targets.map(t => t.db.end()), ...[...this.redisClients.values()].map(c => c.quit())]); }
}
