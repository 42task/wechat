import type { Row } from './contracts';
import { ApiError } from './errors';

/** Match yii\helpers\Json instead of silently converting INF/NaN to null. */
export function phpJsonEncode(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      const message = 'Inf and NaN cannot be JSON encoded';
      const error = new ApiError(500, message);
      const debug = !['0', 'false', 'off'].includes((process.env.YII_DEBUG ?? 'true').toLowerCase());
      error.responseBody = debug ? { name: 'Exception', message, code: 7, type: 'yii\\base\\InvalidArgumentException' }
        : { name: 'Internal Server Error', message: 'An internal server error occurred.', code: 0, status: 500 };
      throw error;
    }
    return item;
  })!;
}
const decoded = Symbol('decoded JSON columns');
export function markJsonDecoded<T extends Row>(row: T): T { Object.defineProperty(row, decoded, { value: true }); return row; }
export function hasDecodedJson(row: Row): boolean { return (row as any)[decoded] === true; }
// MariaDB exposes JSON columns as LONGTEXT in protocol metadata. These are the
// JSON columns in the frozen migration schema, including the new session table.
const legacy: Record<string, string[]> = { player: ['info'], gift: ['info'], record: ['game'], setup: ['slogans', 'pictures', 'thumbs', 'shots'], node_browser_session: ['data'] };
export function isJsonColumn(table: string, column: string, type?: string | number): boolean { return type === 245 || typeof type === 'string' && type.toLowerCase().startsWith('json') || legacy[table]?.includes(column) === true; }
