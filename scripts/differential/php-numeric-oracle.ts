import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { phpFloatString, phpInt, phpIntegerValid } from '../../src/core/php';

/** Pure source-function oracle. No database, Redis, credentials or network. */
const project = resolve(__dirname, '../..');
const option = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
  return resolve(value);
};

function main(): void {
  const sourceRoot = option('--source-root', resolve(project, '../game'));
  const output = option('--output', resolve(project, 'runtime/parity-validation/php-numeric-oracle.json'));
  if (!existsSync(resolve(sourceRoot, 'api/vendor/yiisoft/yii2/Yii.php'))) throw new Error('The source Yii checkout and its vendor dependencies are required');
  const boundaries = [56.99999999999999, 28.999999999999993, 43.00000000000001, .00001, .0001, 1e13, 1e14, 1.234567890123456, 9.99999999999995, 9.99999999999995e13];
  const cases = boundaries.map((value, index) => ({ id: `float-boundary-${index + 1}`, value }));
  for (const price of [1, 3, 10, 100, 1999, 2147483647]) for (const rate of [0, 1, 7, 10, 29, 57, 75, 99, 100]) {
    const back = price * (rate / 100);
    for (const [calculation, value] of [['back', back], ['pool-minus-28', back - 28], ['income', price - back]] as const) cases.push({ id: `price-${price}-rate-${rate}-${calculation}`, value });
  }
  const code = String.raw`
$input=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$root=realpath($input['sourceRoot']);
if (!$root || !is_file($root.'/api/vendor/yiisoft/yii2/Yii.php')) { fwrite(STDERR,'Invalid Yii source root.'); exit(2); }
require $root.'/api/vendor/autoload.php';
require $root.'/api/vendor/yiisoft/yii2/Yii.php';
$validator=new yii\validators\NumberValidator(['integerOnly'=>true]);
$column=new yii\db\mysql\ColumnSchema(['type'=>'integer','phpType'=>'integer']);
$results=[];
foreach($input['values'] as $value) {
    $value=(float)$value;
    $results[]=['floatString'=>(string)$value,'integerValid'=>$validator->validate($value),'integerCast'=>$column->dbTypecast($value)];
}
echo json_encode(['phpVersion'=>PHP_VERSION,'yiiVersion'=>Yii::getVersion(),'precision'=>(int)ini_get('precision'),'results'=>$results],JSON_THROW_ON_ERROR);
`;
  const execution = spawnSync('php', ['-d', 'display_errors=stderr', '-d', 'error_reporting=8191', '-r', code], {
    input: JSON.stringify({ sourceRoot, values: cases.map(row => row.value) }), encoding: 'utf8', timeout: 10_000,
  });
  if (execution.status !== 0 || execution.error) throw new Error(`PHP numeric oracle could not execute (${execution.status ?? 'no exit code'})`);
  const source = JSON.parse(execution.stdout);
  const results = cases.map((row, index) => {
    const actual = { floatString: phpFloatString(row.value), integerValid: phpIntegerValid(row.value, 'double'), integerCast: phpInt(row.value) };
    return { ...row, equal: JSON.stringify(source.results[index]) === JSON.stringify(actual), yii: source.results[index], node: actual };
  });
  const matched = results.filter(row => row.equal).length;
  const report = { generatedAt: new Date().toISOString(), kind: 'pure-php-source-function-oracle', phpVersion: source.phpVersion, yiiVersion: source.yiiVersion, phpPrecision: source.precision, nodeVersion: process.version,
    sourceFunctions: ['PHP float string cast', 'yii\\validators\\NumberValidator(integerOnly)', 'yii\\db\\mysql\\ColumnSchema::dbTypecast(integer)'],
    total: results.length, matched, differences: results.length - matched, results };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`PHP numeric source oracle: ${matched}/${results.length} matched; report: ${output}`);
  if (matched !== results.length) process.exitCode = 1;
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'PHP numeric oracle failed'); process.exitCode = 1; }
