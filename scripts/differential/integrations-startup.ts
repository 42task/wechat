import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Integrations } from '../../src/integrations/integrations';

// Configuration-only regression probes. The injected fetch never makes network
// requests, and the PHP oracle only constructs the original lazy SDK objects.
const merchantMissing = '/private/tmp/parity-no-such-merchant-material.pem';
const paymentNames = Object.keys(process.env).filter(name => /^WECHAT_(PAY_|MCH_ID$|PRIVATE_KEY$|CERTIFICATE$|SECRET_KEY$|PUB_KEY|PLATFORM_CERTS$)/.test(name));
const saved = Object.fromEntries(paymentNames.map(name => [name, process.env[name]]));
const cases = [
  { id: 'merchant-private-key-missing', env: { WECHAT_PRIVATE_KEY: merchantMissing }, php: { private_key: merchantMissing } },
  { id: 'merchant-certificate-missing', env: { WECHAT_CERTIFICATE: merchantMissing }, php: { certificate: merchantMissing } },
  { id: 'merchant-certificate-invalid-pem', env: { WECHAT_CERTIFICATE: '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----' }, php: { certificate: '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----' } },
  { id: 'modern-platform-key-map-invalid-json', env: { WECHAT_PAY_PLATFORM_KEYS_JSON: '{invalid' }, php: { platform_certificates: '{invalid' }, note: 'Node modern key map and Yii legacy certificate list are analogous malformed payment-only configuration, not identical environment variable names.' },
];

const phpProgram = `
require $argv[1] . '/vendor/autoload.php';
require $argv[1] . '/vendor/yiisoft/yii2/Yii.php';
Yii::setAlias('@app', $argv[1]);
try {
  $config = array_merge(['app_id'=>'parity-wx-app','secret'=>'parity-wx-secret'], json_decode($argv[2], true, 512, JSON_THROW_ON_ERROR));
  $component = new app\\modules\\v1\\components\\Wechat($config);
  $component->miniApp();
  echo json_encode(['constructed'=>true,'unrelatedLoginAvailable'=>true]);
} catch (Throwable $error) {
  echo json_encode(['constructed'=>false,'errorName'=>get_class($error)]);
}
`;

async function main(): Promise<void> {
  const results = [];
  const allNames = [...new Set([...paymentNames, ...cases.flatMap(test => Object.keys(test.env))])];
  try {
    for (const test of cases) {
      for (const name of allNames) delete process.env[name];
      Object.assign(process.env, test.env);
      const php = spawnSync('php', ['-d', 'display_errors=0', '-r', phpProgram, resolve('../game/api'), JSON.stringify(test.php)], { encoding: 'utf8' });
      let yii: any;
      try { yii = JSON.parse(php.stdout); }
      catch { yii = { harnessError: true, exitCode: php.status }; }
      let node: any;
      try {
        const integration = new Integrations({ appId: 'parity-wx-app', appSecret: 'parity-wx-secret', fetch: async () => Response.json({ openid: 'parity-openid' }) });
        const response = await integration.codeSession('synthetic-local-code');
        node = { constructed: true, unrelatedLoginAvailable: response.openid === 'parity-openid' };
      } catch (error) {
        node = { constructed: false, errorName: error instanceof Error ? error.name : 'unknown', ...typeof (error as any)?.code === 'string' ? { code: (error as any).code } : {} };
      }
      const equal = yii.constructed === node.constructed && yii.unrelatedLoginAvailable === node.unrelatedLoginAvailable && !yii.harnessError;
      results.push({ id: test.id, equal, ...test.note ? { note: test.note } : {}, yii, node });
      console.log(`${equal ? 'MATCH' : 'DIFFERENT'} startup.${test.id}`);
    }
  } finally {
    for (const name of allNames) delete process.env[name];
    Object.assign(process.env, saved);
  }
  const report = { generatedAt: new Date().toISOString(), total: results.length, matched: results.filter(row => row.equal).length, differences: results.filter(row => !row.equal).length, results };
  writeFileSync(resolve('runtime/parity-validation/integrations-startup.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ suite: 'integrations-startup', total: report.total, matched: report.matched, differences: report.differences }));
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
