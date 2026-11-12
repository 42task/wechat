import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { V1Models } from '../src/v1/models';
import type { Database } from '../src/core/database';
import type { Row } from '../src/core/contracts';

// Optional independent source oracle: no database, Redis, HTTP, credentials or
// writes. A standalone Node checkout can run its normal regressions without Yii.
const sourceRoot=resolve(process.env.YII2_SOURCE_ROOT || resolve(__dirname,'../../game'));
const sourceAvailable=existsSync(resolve(sourceRoot,'api/vendor/yiisoft/yii2/Yii.php'));
describe.skipIf(!sourceAvailable)('offline original Yii V1 model oracle',()=>{
  test('complete player validation matches the unchanged source User rules',async()=>{
    const cases=[
      {tel:'\u00a0',points:53,times:1}, {tel:'\f',points:53,times:1}, {tel:'\u2003',points:53,times:1},
      {tel:'\0',points:53,times:1}, {tel:' \t\n\r\0\v',points:53,times:1},
      {tel:'',points:53,times:1}, {tel:'valid',points:53,times:1}, {tel:'valid',points:51.5,times:1},
      ...['1\n','1\r','1\u2028','1\n\n'].map(recharge=>({tel:'valid',points:53,times:1,recharge})),
    ];
    const code=String.raw`
$input=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
require $input['root'].'/api/vendor/autoload.php';
require $input['root'].'/api/vendor/yiisoft/yii2/Yii.php';
Yii::setAlias('@app',$input['root'].'/api');
class OfflineOriginalUser extends app\modules\v1\models\User {
    public function attributes(){return ['id','tel','nickname','openId','avatar','info','recharge','cost','give','points','times','grade','created_at','updated_at'];}
    // Only uniqueness requires SQL. These cases do not exercise uniqueness;
    // every other rule is executed directly from the original User::rules().
    public function rules(){return array_values(array_filter(parent::rules(),static fn($rule)=>$rule[1]!=='unique'));}
}
$result=[];
foreach($input['cases'] as $case){
    $model=new OfflineOriginalUser();
    $model->setAttributes(array_merge(['id'=>2,'recharge'=>100,'cost'=>10,'give'=>0,'grade'=>0],$case),false);
    $result[]=['valid'=>$model->validate(),'errors'=>$model->getErrors()];
}
echo json_encode($result,JSON_THROW_ON_ERROR);
`;
    const executed=spawnSync('php',['-d','display_errors=stderr','-d','error_reporting=8191','-r',code],{input:JSON.stringify({root:sourceRoot,cases}),encoding:'utf8',timeout:10000});
    expect(executed.error).toBeUndefined();expect(executed.status,executed.stderr).toBe(0);
    const expected=JSON.parse(executed.stdout);
    for (const [index,row] of cases.entries()) {
      const previous:Row={id:2,tel:row.tel,recharge:100,cost:10,give:0,points:50,times:0,grade:0};
      const db={one:async(sql:string)=>sql.includes('CURRENT_TIMESTAMP')?{currentTimestamp:'2000-01-01 00:00:00'}:null,
        update:async(_table:string,_id:unknown,data:Row)=>({...previous,...data})} as unknown as Database;
      let actual:any={valid:true,errors:[]};
      try {await new V1Models(db).save('player',{points:row.points,times:row.times,...'recharge' in row ? {recharge:row.recharge} : {}},previous);}
      catch(error:any){actual={valid:false,errors:Object.fromEntries(error.getResponse().map(({field,message}:Row)=>[field,[message]]))};}
      expect(actual,JSON.stringify(row)).toEqual(expected[index]);
    }
  });
  test('loaded gift award expansion matches actual source ActiveRecord extraFields',async()=>{
    const code=String.raw`
$root=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR)['root'];
require $root.'/api/vendor/autoload.php';require $root.'/api/vendor/yiisoft/yii2/Yii.php';Yii::setAlias('@app',$root.'/api');
class OfflineAward extends app\modules\v1\models\Award{public function attributes(){return ['id','shop_id','price','type'];}}
class OfflineGift extends app\modules\v1\models\Gift{public function attributes(){return ['id','award_id','uuid'];}}
class OfflineShop extends app\modules\v1\models\Shop{public function attributes(){return ['id','price','rate'];}}
$award=new OfflineAward();$award->setAttributes(['id'=>5,'shop_id'=>1,'price'=>100,'type'=>'s'],false);
$gift=new OfflineGift();$gift->setAttributes(['id'=>6,'award_id'=>5,'uuid'=>'gift-example'],false);
$direct=$gift->toArray(['id','award.id'],['award']);
$gift->populateRelation('award',$award);
$shop=new OfflineShop();$shop->setAttributes(['id'=>1,'price'=>10,'rate'=>80],false);$shop->populateRelation('gifts',[$gift]);
echo json_encode(['direct'=>$direct,'nested'=>$shop->toArray(['id','gifts.id','gifts.award.id'],['gifts.award']),'full'=>$shop->toArray([],['gifts.award'])],JSON_THROW_ON_ERROR);
`;
    const executed=spawnSync('php',['-d','display_errors=stderr','-d','error_reporting=8191','-r',code],{input:JSON.stringify({root:sourceRoot}),encoding:'utf8',timeout:10000});
    expect(executed.error).toBeUndefined();expect(executed.status,executed.stderr).toBe(0);
    const expected=JSON.parse(executed.stdout);
    const gift={id:6,award_id:5,uuid:'gift-example'},award={id:5,shop_id:1,price:100,type:'s'},shop={id:1,price:10,rate:80};
    const db={query:async(sql:string)=>sql.includes('gift.*')?[gift]:[award]} as unknown as Database;
    const models=new V1Models(db);
    expect(await models.serialize('gift',gift,'award','id,award.id')).toEqual(expected.direct);
    expect(await models.serialize('shop',shop,'gifts.award','id,gifts.id,gifts.award.id')).toEqual(expected.nested);
    expect(await models.serialize('shop',shop,'gifts.award')).toEqual(expected.full);
  });
  test('existing duplicate award pairs fail the original UniqueValidator even when one match is the current row',async()=>{
    const code=String.raw`
$root=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR)['root'];
require $root.'/api/vendor/autoload.php';require $root.'/api/vendor/yiisoft/yii2/Yii.php';Yii::setAlias('@app',$root.'/api');
class DuplicateAwardQuery extends yii\db\ActiveQuery{public function all($db=null){return [['id'=>1],['id'=>2]];}}
class OfflineDuplicateAward extends app\modules\v1\models\Award{
    public function attributes(){return ['id','shop_id','price','type'];}public static function primaryKey(){return ['id'];}
    public static function getDb(){return new yii\db\Connection();}public static function find(){return new DuplicateAwardQuery(static::class);}
}
$model=new OfflineDuplicateAward();$model->setAttributes(['id'=>1,'shop_id'=>1,'type'=>'s','price'=>200],false);$model->setOldAttributes(['id'=>1,'shop_id'=>1,'type'=>'s','price'=>100]);
foreach($model->getActiveValidators() as $validator)if($validator instanceof yii\validators\UniqueValidator)$validator->validateAttributes($model);
echo json_encode($model->getErrors(),JSON_THROW_ON_ERROR);
`;
    const executed=spawnSync('php',['-d','display_errors=stderr','-d','error_reporting=8191','-r',code],{input:JSON.stringify({root:sourceRoot}),encoding:'utf8',timeout:10000});
    expect(executed.error).toBeUndefined();expect(executed.status,executed.stderr).toBe(0);
    const first={id:1,shop_id:1,type:'s',price:100};
    const db={one:async(sql:string)=>sql.includes('FROM award WHERE')?{...first,id:sql.includes('id <> ?')?2:1}:sql.includes('shop')?{id:1}:null,
      update:async(_table:string,_id:unknown,data:Row)=>({...first,...data})} as unknown as Database;
    await expect(new V1Models(db).save('award',{price:200},first)).rejects.toSatisfy((error:any)=>{
      expect(Object.fromEntries(error.getResponse().map(({field,message}:Row)=>[field,[message]]))).toEqual(JSON.parse(executed.stdout));return true;
    });
  });
  test('actual game and system actions fail before financial saves when their shop relation is null',()=>{
    const code=String.raw`
namespace {
 $root=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR)['root'];
 require $root.'/api/vendor/autoload.php';require $root.'/api/vendor/yiisoft/yii2/Yii.php';Yii::setAlias('@app',$root.'/api');
}
namespace app\modules\v1\models {
 class Player {public static $fixture;public $id=2,$cost=0,$points=50,$times=0,$recharge=100,$give=0,$saved=0;public static function findOne($id){return self::$fixture;}public function save(){$this->saved++;return true;}}
 class Device {public static $fixture;public $id=1,$uuid='fixture',$ip='127.0.0.1',$record,$shop=null;public static function findOne($id){return self::$fixture;}public static function find(){return new class {public function where($c){return $this;}public function one(){return Device::$fixture;}};}public function validate(){return true;}public function save(){return true;}}
 class Record {public static $fixture;public $game=['points'=>10],$status='running',$user,$player,$shop=null,$deleted=false;public static function findOne($id){return self::$fixture;}public static function find(){return new class {public function where($c){return $this;}public function with(...$relations){return $this;}public function one(){return null;}};}public function delete(){$this->deleted=true;}}
}
namespace {
 class OfflineMissingShopGame extends app\modules\v1\controllers\GameController{public function init(){}}
 class OfflineMissingShopSystem extends app\modules\v1\controllers\SystemController{public function init(){}}
 $request=new yii\web\Request(['cookieValidationKey'=>'offline']);$request->setQueryParams(['uuid'=>'fixture']);$request->setBodyParams(['points'=>3,'recordId'=>1]);$_SERVER['REMOTE_ADDR']='127.0.0.1';
 Yii::$app=new class($request){public $request,$user,$language='en-US';public function __construct($request){$this->request=$request;$this->user=(object)['identity'=>(object)['manager'=>true]];}public function getI18n(){return new class {public function translate($category,$message,$params=[],$language=null){return $message;}public function format($message,$params=[],$language=null){return $message;}};}};
 $gameController=new OfflineMissingShopGame('game',new yii\base\Module('v1'));$systemController=new OfflineMissingShopSystem('system',new yii\base\Module('v1'));
 set_error_handler(static function($severity,$message){if(!(error_reporting()&$severity))return false;throw new yii\base\ErrorException($message,$severity,$severity);});
 $results=[];
 foreach(['ready','finish','close'] as $action){
  $player=new app\modules\v1\models\Player();$record=new app\modules\v1\models\Record();$record->player=$record->user=$player;$device=new app\modules\v1\models\Device();$device->record=$record;
  app\modules\v1\models\Player::$fixture=$player;app\modules\v1\models\Device::$fixture=$device;app\modules\v1\models\Record::$fixture=$record;
  try{if($action==='ready')$systemController->actionReadyGame(2,1);elseif($action==='finish')$gameController->actionFinish();else $systemController->actionCloseRecord();$error=null;}
  catch(\Throwable $e){$error=['type'=>get_class($e),'message'=>$e->getMessage()];}
  $results[$action]=['error'=>$error,'playerSaves'=>$player->saved,'recordDeleted'=>$record->deleted];
 }
 echo json_encode($results,JSON_THROW_ON_ERROR);
}
`;
    const execution=spawnSync('php',['-d','display_errors=stderr','-d','error_reporting=8191','-r',code],{input:JSON.stringify({root:sourceRoot}),encoding:'utf8',timeout:10000});
    expect(execution.error).toBeUndefined();expect(execution.status,execution.stderr).toBe(0);
    const source=JSON.parse(execution.stdout);
    for(const action of ['ready','finish','close']) expect(source[action]).toEqual({error:{type:'yii\\base\\ErrorException',message:'Attempt to read property "'+(action==='finish'?'operation':'price')+'" on null'},playerSaves:0,recordDeleted:false});
  });
});
