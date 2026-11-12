<?php
// CLI-only provider oracle. Receives synthetic fixtures on stdin, injects only
// Symfony MockHttpClient into the original applications, and never creates DBs.
defined('YII_DEBUG') or define('YII_DEBUG', true);
defined('YII_ENV') or define('YII_ENV', 'prod');
$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$root = $argv[1];
require $root . '/vendor/autoload.php';
require $root . '/vendor/yiisoft/yii2/Yii.php';
Yii::setAlias('@app', $root);
$temporary = [];
$file = function (string $content) use (&$temporary): string {
    $path = tempnam(sys_get_temp_dir(), 'wechat-provider-oracle-');
    file_put_contents($path, $content);
    $temporary[] = $path;
    return $path;
};
$calls = [];
$transport = function () use ($input, &$calls) {
    return new Symfony\Component\HttpClient\MockHttpClient(function ($method, $url, $options) use ($input, &$calls) {
        $calls[] = ['method'=>$method,'path'=>parse_url($url, PHP_URL_PATH)];
        return new Symfony\Component\HttpClient\Response\MockResponse($input['provider']['raw'] ?? '{}', [
            'http_code'=>$input['provider']['status'] ?? 200,
            'response_headers'=>$input['provider']['headers'] ?? ['Content-Type'=>'application/json'],
        ]);
    }, 'https://provider.fixture.invalid/');
};
$configured = $input['configured'] ?? true;
$source = new app\modules\v1\components\Wechat([
    'app_id'=>$configured ? 'wx-provider-fixture' : false,
    'secret'=>$configured ? 'provider-fixture-secret' : false,
    'token'=>null,'aes_key'=>null,
    'mch_id'=>$configured ? '1900000001' : null,
    'private_key'=>$configured ? $file($input['merchant']['privateKey']) : null,
    'certificate'=>$configured ? $file($input['merchant']['certificate']) : null,
    'secret_key'=>$configured ? '0123456789abcdef0123456789abcdef' : null,
    'pub_key_id'=>$configured ? 'PUB_KEY_ID_PROVIDER_PARITY' : null,
    'pub_key_path'=>$configured ? $file($input['platformPublicKey']) : null,
]);
$mini = $source->miniApp();
$mini->setHttpClient($transport());
$mini->setAccessToken(new class implements EasyWeChat\Kernel\Contracts\AccessToken {
    public function getToken(): string { return 'synthetic-local-token'; }
    public function toQuery(): array { return ['access_token'=>$this->getToken()]; }
});
$wrapper = new class($source, $mini, $transport, $input) extends yii\base\Component {
    public function __construct(private $source, private $mini, private $transport, private $input) { parent::__construct(); }
    public function miniApp() { return $this->mini; }
    public function payApp() {
        $app = $this->source->payApp();
        $app->setHttpClient(($this->transport)());
        if (isset($this->input['callback'])) $app->setRequest(new Nyholm\Psr7\ServerRequest(
            'POST','https://provider.fixture.invalid/notify', $this->input['callback']['headers'], $this->input['callback']['raw']
        ));
        return $app;
    }
};
$app = new yii\web\Application([
    'id'=>'provider-oracle','basePath'=>$root,
    'components'=>[
        'request'=>['cookieValidationKey'=>'synthetic-local-cookie','scriptUrl'=>'/index.php','scriptFile'=>__FILE__,'hostInfo'=>'https://provider.fixture.invalid'],
        'user'=>['identityClass'=>app\modules\v2\models\User::class,'enableSession'=>false],
        'wechat'=>$wrapper,
    ],
]);
$app->request->setBodyParams($input['body'] ?? ['code'=>'synthetic-code']);
$app->request->setQueryParams($input['query'] ?? []);
$identity = new class extends app\modules\v2\models\User {
    public function attributes() { return ['id','tel','nickname','avatar','role','openid','unionid']; }
    public function save($runValidation = true, $attributeNames = null) { return true; }
};
$identity->setAttributes(['id'=>1,'tel'=>null,'nickname'=>'Fixture','avatar'=>null,'role'=>'user','openid'=>'fixture-openid','unionid'=>'fixture-union'], false);
$app->user->setIdentity($identity);
$output = null;
try {
    switch ($input['operation']) {
        case 'code-sdk':
            $value = $mini->getUtils()->codeToSession('synthetic-code');
            break;
        case 'login-v2':
            $value = (new app\modules\v2\controllers\SiteController('site', $app))->actionLogin();
            break;
        case 'openid-v1':
            $value = (new app\modules\v1\controllers\WeChatController('we-chat', $app))->actionOpenid();
            break;
        case 'phone':
            $value = (new app\modules\v2\controllers\WechatController('wechat', $app))->actionBindPhone();
            break;
        case 'payment-sdk':
            $value = $wrapper->payApp()->getClient()->get('v3/pay/transactions/out-trade-no/fixture-order')->toArray(false);
            break;
        case 'payment-query-v1':
            $value = (new app\modules\v1\controllers\WechatPayController('wechat-pay', $app))->actionWxpayQueryOrderByOutTradeNo();
            break;
        case 'wechat-info':
            $value = (new app\modules\v1\controllers\WeChatController('we-chat', $app))->actionInfo();
            break;
        case 'payment-info':
            $value = (new app\modules\v1\controllers\WechatPayController('wechat-pay', $app))->actionInfo();
            break;
        case 'qcloud-object-url':
            $controller = new app\modules\v1\controllers\QCloudController('q-cloud', $app);
            $action = new yii\base\InlineAction('object-url', $controller, 'actionObjectUrl');
            $value = $controller->actionObjectUrl(...$controller->bindActionParams($action, $input['query']));
            break;
        case 'callback':
            $class = ($input['version'] ?? 'v1') === 'v2' ? app\modules\v2\controllers\WechatPayController::class : app\modules\v1\controllers\WechatPayController::class;
            $controller = new $class('wechat-pay', $app);
            $raw = ($input['refund'] ?? false) ? $controller->actionRefundNotify() : $controller->actionNotify();
            $value = json_decode($raw, false, 512, JSON_THROW_ON_ERROR);
            break;
        default: throw new RuntimeException('Unknown provider oracle operation');
    }
    $value = (new yii\rest\Serializer())->serialize($value);
    $output = ['status'=>$app->response->statusCode,'body'=>$value];
} catch (Throwable $error) {
    $handler = new class extends yii\web\ErrorHandler {
        public function expose(Throwable $error): array { return $this->convertExceptionToArray($error); }
    };
    $body = $handler->expose($error);
    foreach (['file','line','stack-trace','previous','error-info'] as $key) unset($body[$key]);
    $output = ['status'=>$error instanceof yii\web\HttpException ? $error->statusCode : 500,'body'=>$body];
} finally {
    foreach ($temporary as $path) unlink($path);
    $app->errorHandler->unregister();
}
echo json_encode(['result'=>$output,'transportCalls'=>$calls], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
