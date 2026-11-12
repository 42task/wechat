import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiRouter } from '../src/core/router';
import type { Context, Row, Services } from '../src/core/contracts';
import { registerIntegrations } from '../src/integrations/routes';

const cases = [
  { previous: '01', requested: '1', writes: 0 },
  { previous: '100', requested: '1e2', writes: 0 },
  { previous: '100', requested: ' 100 ', writes: 0 },
  { previous: '9007199254740992', requested: '9007199254740993', writes: 1 },
  { previous: 'Avatar URL', requested: true, writes: 0 },
  { previous: 'Alice', requested: 'Bob', writes: 1 },
  { previous: 'Alice', requested: '0', writes: 0 },
  { previous: 'x'.repeat(256), requested: 'x'.repeat(256), writes: 0 },
];
async function nodeProfile(field: string, fixture: typeof cases[number]) {
  const user: Row = { id: 7, tel: null, nickname: 'Fixture', avatar: null, role: 'user', [field]: fixture.previous };
  let writes = 0;
  const router = new ApiRouter();
  registerIntegrations(router, { db: { update: async (_table: string, _id: unknown, patch: Row) => { writes++; return { ...user, ...patch }; } }, auth: { bearer: async () => user }, integrations: {} } as unknown as Services);
  const response: any = await router.match('POST', '/v2/wechat/profile')!.route.handler({ body: { [field]: fixture.requested } } as unknown as Context);
  return { user: response.data.user, writes };
}
describe('profile source PHP comparison before assignment and validation', () => {
  for (const field of ['nickname', 'avatar']) it.each(cases)(`${field} retains source writes=$writes for $previous -> $requested`, async fixture => {
    const actual = await nodeProfile(field, fixture);
    expect(actual.writes).toBe(fixture.writes);
    expect(actual.user[field]).toBe(fixture.writes ? fixture.requested : fixture.previous);
  });
});

const sourceRoot = resolve(process.env.YII2_SOURCE_ROOT || resolve(__dirname, '../../game'));
describe.skipIf(!existsSync(resolve(sourceRoot, 'api/vendor/yiisoft/yii2/Yii.php')))('offline actual Yii profile action oracle', () => {
  it('agrees on both response fields and zero-write equalities', async () => {
    const code = String.raw`
require $argv[1].'/api/vendor/autoload.php';require $argv[1].'/api/vendor/yiisoft/yii2/Yii.php';Yii::setAlias('@app',$argv[1].'/api');
class ProfileIdentity extends app\modules\v2\models\User {public $writes=0;public function attributes(){return ['id','nickname','avatar','tel','role'];}public function save($runValidation=true,$attributeNames=null){$this->writes++;return true;}}
$app=new yii\web\Application(['id'=>'offline-profile','basePath'=>$argv[1].'/api','components'=>['request'=>['cookieValidationKey'=>'synthetic-cookie','scriptUrl'=>'/index.php','scriptFile'=>__FILE__],'user'=>['identityClass'=>ProfileIdentity::class,'enableSession'=>false]]]);$results=[];
foreach(json_decode(stream_get_contents(STDIN),true) as $fixture){$u=new ProfileIdentity();$u->setAttributes(['id'=>7,'tel'=>null,'nickname'=>'Fixture','avatar'=>null,'role'=>'user',$fixture['field']=>$fixture['previous']],false);$app->user->setIdentity($u);$app->request->setBodyParams([$fixture['field']=>$fixture['requested']]);(new app\modules\v2\controllers\WechatController('wechat',$app))->actionProfile();$results[]=['user'=>$u->toArray(),'writes'=>$u->writes];}echo json_encode($results,JSON_THROW_ON_ERROR);`;
    const fixtures = ['nickname', 'avatar'].flatMap(field => cases.map(fixture => ({ field, ...fixture })));
    const executed = spawnSync('php', ['-r', code, sourceRoot], { input: JSON.stringify(fixtures), encoding: 'utf8', timeout: 10000 });
    expect(executed.status, executed.stderr).toBe(0);
    const source = JSON.parse(executed.stdout);
    for (const [index, fixture] of fixtures.entries()) expect(await nodeProfile(fixture.field, fixture)).toEqual(source[index]);
  });
});
