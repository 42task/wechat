<?php
defined('YII_DEBUG') or define('YII_DEBUG', true);
defined('YII_ENV') or define('YII_ENV', 'prod');
// The pinned SDK uses ReflectionProperty::setAccessible(). PHP 8.5 deprecated
// that no-op; exclude only deprecations, matching the PHP 8.3 service runtime.
error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);
$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$root = $argv[1];
require $root . '/vendor/autoload.php';
require $root . '/vendor/yiisoft/yii2/Yii.php';
require __DIR__ . '/sts-transport.php';
Yii::setAlias('@app', $root);
$calls = [];
$classes = providerOracleStsControllers($root, function ($request, $options) use ($input, &$calls) {
    $headers = [];
    foreach (['Content-Type', 'X-TC-Action', 'X-TC-Version', 'X-TC-Region'] as $name) {
        if ($request->hasHeader($name)) $headers[$name] = $request->getHeaderLine($name);
    }
    $calls[] = ['method'=>$request->getMethod(), 'path'=>$request->getUri()->getPath() ?: '/', 'headers'=>$headers, 'body'=>json_decode((string)$request->getBody(), true, 512, JSON_THROW_ON_ERROR)];
    return new GuzzleHttp\Promise\FulfilledPromise(new GuzzleHttp\Psr7\Response(
        $input['provider']['status'] ?? 200, ['Content-Type'=>'application/json'], json_encode($input['provider']['body'], JSON_THROW_ON_ERROR)
    ));
});
$secret = new class extends yii\base\Component {
    public $id = 'synthetic-sts-id';
    public $key = 'synthetic-sts-key';
    public $cloud = ['bucket'=>'configured-1250000000','region'=>'ap-shanghai'];
};
$app = new yii\web\Application([
    'id'=>'sts-oracle','basePath'=>$root,
    'components'=>[
        'request'=>['cookieValidationKey'=>'synthetic-local-cookie','scriptUrl'=>'/index.php','scriptFile'=>__FILE__],
        'secret'=>$secret,
    ],
]);
$class = $classes[$input['version'] ?? 'v1'];
$controller = new $class('tencent-cloud', $app);
try {
    if (($input['operation'] ?? 'token') === 'store') $value = $controller->actionStore();
    elseif (($input['version'] ?? 'v1') === 'v2') $value = $controller->actionToken();
    else $value = $controller->actionToken(...($input['arguments'] ?? []));
    $value = (new yii\rest\Serializer())->serialize($value);
    $result = ['status'=>$app->response->statusCode, 'body'=>$value];
} catch (Throwable $error) {
    $handler = new class extends yii\web\ErrorHandler {
        public function expose(Throwable $error): array { return $this->convertExceptionToArray($error); }
    };
    $body = $handler->expose($error);
    foreach (['file','line','stack-trace','previous','error-info'] as $key) unset($body[$key]);
    $result = ['status'=>$error instanceof yii\web\HttpException ? $error->statusCode : 500, 'body'=>$body];
} finally { $app->errorHandler->unregister(); }
echo json_encode(['result'=>$result, 'transportCalls'=>$calls], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
