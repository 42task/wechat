import { describe, expect, it } from 'vitest';
import { parsePhpJson, PhpJsonError } from '../src/core/php';
import { phpJsonEncode } from '../src/core/json';
import { errorPayload } from '../src/core/errors';

// These messages and depth bounds are from json_decode(..., true, 512,
// JSON_THROW_ON_ERROR), the decoder used by Yii's actual JsonParser.
describe('PHP JSON parser validation boundaries', () => {
  it.each(['{"title":"\\ud800"}', '{"title":"\\udc00"}', '{"\\ud800":"value"}', '"\\ud800A"', '{"title":"\\ud800","title":"valid"}'])('rejects an unpaired surrogate in %s', raw => {
    expect(() => parsePhpJson(raw)).toThrow(new PhpJsonError('Single unpaired UTF-16 surrogate in unicode escape'));
  });
  it('accepts surrogate pairs and literal backslash text', () => {
    expect(parsePhpJson('{"title":"\\ud83d\\ude00"}').title).toBe('😀');
    expect(parsePhpJson('{"title":"\\\\ud800"}').title).toBe('\\ud800');
  });
  it('uses PHP depth 512 rather than the JavaScript decoder limit', () => {
    expect(() => parsePhpJson('['.repeat(511) + '0' + ']'.repeat(511))).not.toThrow();
    for (const depth of [512, 513]) expect(() => parsePhpJson('['.repeat(depth) + '0' + ']'.repeat(depth))).toThrow(new PhpJsonError('Maximum stack depth exceeded'));
    expect(() => parsePhpJson('{"x":' + '['.repeat(511) + '0' + ']'.repeat(511) + ',"x":0}')).toThrow(new PhpJsonError('Maximum stack depth exceeded'));
  });
  it('accepts overflowing JSON numbers at decode time but rejects them at PHP encoding boundaries', () => {
    const parsed = parsePhpJson('{"slogans":[1e400]}');
    expect(parsed.slogans[0]).toBe(Infinity);
    for (const value of [parsed, { nested: { value: NaN } }, -Infinity]) expect(() => phpJsonEncode(value)).toThrow('Inf and NaN cannot be JSON encoded');
    expect(phpJsonEncode({ value: 1, missing: undefined, empty: null })).toBe('{"value":1,"empty":null}');
  });
  it('keeps the actual Yii JSON encoding exception envelope', () => {
    try { phpJsonEncode(Infinity); throw new Error('Expected PHP JSON encoding failure'); }
    catch (error) { expect(errorPayload(error)).toEqual({ status: 500, body: { name: 'Exception', message: 'Inf and NaN cannot be JSON encoded', code: 7, type: 'yii\\base\\InvalidArgumentException' } }); }
  });
});
