<?php
/**
 * Offline source oracle for the deployed old main, not the newer Yii reference.
 *
 * Usage: echo '{"operation":"payment-order-v2","body":{...}}' |
 *   php scripts/legacy-differential/old-main-oracle.php [snapshot/api] [vendor]
 *
 * The frozen application's original controllers/models execute without edits.
 * Provider responses/signing and SQL reads are replaced with synthetic in-memory
 * fixtures. No application config, credentials, database or network is opened.
 * This intentionally does not establish HTTP middleware, SQL collation, SDK
 * signing, real provider, callback, hardware, or production equivalence.
 */
if (PHP_SAPI !== 'cli') {
    throw new RuntimeException('CLI only');
}
defined('YII_DEBUG') or define('YII_DEBUG', true);
defined('YII_ENV') or define('YII_ENV', 'prod');
error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);
$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$repository = dirname(__DIR__, 2);
$snapshot = realpath($argv[1] ?? $repository . '/runtime/legacy-main-source-20261112/source/api');
$vendor = realpath($argv[2] ?? dirname($repository) . '/game/api/vendor');
if (!$snapshot || !$vendor) {
    throw new RuntimeException('Missing frozen source or local dependency vendor directory');
}
$expectedSources = [
    'controllers/WechatPayController.php' => 'bc02adeb7698944af15b2138cd7b71618f0e54c7d807a71ccd03f5e4a783429d',
    'controllers/SiteController.php' => 'bd74cc53785ccabe35084dfff85d65280cab0a0805644753a1d274dabc90a114',
    'controllers/FileController.php' => '93662ecbe9023e02ff74b6c27498eec62f19ea15d5e68482a09c535055a37cfb',
    'models/User.php' => 'c6be6b0842a838dcb2d35836ae89d5c017e1fa30768a7cbfcbc49ccd4cf8eb8f',
    'models/File.php' => '33004a87d690cbac6f2ace86db0e36926bfd54108955fcd9d7186f1f1b1c03cb',
    'models/FileSearch.php' => '3b29e57cbfc68ec645b639908c6f49d10afb60ad3b7e9936da6bc3b6d969ebc7',
];
foreach ($expectedSources as $relative => $hash) {
    if (hash_file('sha256', $snapshot . '/modules/v2/' . $relative) !== $hash) {
        throw new RuntimeException('Frozen source hash mismatch: ' . $relative);
    }
}
$lock = json_decode(file_get_contents($snapshot . '/composer.lock'), true, 512, JSON_THROW_ON_ERROR);
$installed = json_decode(file_get_contents($vendor . '/composer/installed.json'), true, 512, JSON_THROW_ON_ERROR);
$installedVersions = array_column($installed['packages'] ?? $installed, 'version', 'name');
$dependencyVersions = [];
foreach ($lock['packages'] as $package) {
    if (!in_array($package['name'], ['yiisoft/yii2', 'bizley/jwt', 'lcobucci/jwt'], true)) continue;
    if (($installedVersions[$package['name']] ?? null) !== $package['version']) {
        throw new RuntimeException('Local dependency version differs from frozen lock: ' . $package['name']);
    }
    $dependencyVersions[$package['name']] = $package['version'];
}
$loader = require $vendor . '/autoload.php';
// Never resolve application classes through the mutable checkout's Composer map.
$loader->setPsr4('app\\', [$snapshot]);
$frozenClassMap = [];
foreach ($expectedSources as $relative => $hash) {
    $frozenClassMap['app\\modules\\v2\\' . str_replace('/', '\\', substr($relative, 0, -4))] = $snapshot . '/modules/v2/' . $relative;
}
$loader->addClassMap($frozenClassMap);
require $vendor . '/yiisoft/yii2/Yii.php';
Yii::setAlias('@app', $snapshot);

final class OldMainMemorySchema extends yii\db\mysql\Schema
{
    public function getTableSchema($name, $refresh = false)
    {
        $columns = [
            'file' => ['id', 'unionid', 'key', 'type', 'md5', 'size', 'bucket', 'created_at', 'unlocked', 'title', 'user_id'],
            'user' => ['id', 'tel', 'nickname', 'avatar', 'role', 'openid', 'unionid', 'created_at', 'updated_at'],
        ];
        if (!isset($columns[$name])) {
            throw new RuntimeException('Unsupported fixture schema: ' . $name);
        }
        $table = new yii\db\TableSchema(['name' => $name, 'fullName' => $name, 'primaryKey' => ['id']]);
        foreach ($columns[$name] as $column) {
            $integer = in_array($column, ['id', 'size', 'unlocked', 'user_id'], true);
            $table->columns[$column] = new yii\db\ColumnSchema([
                'name' => $column, 'type' => $integer ? 'integer' : 'string',
                'phpType' => $integer ? 'integer' : 'string', 'allowNull' => true,
            ]);
        }
        return $table;
    }
}

final class OldMainNoIoConnection extends yii\db\Connection
{
    public function open()
    {
        throw new RuntimeException('External database access is forbidden in the old-main oracle');
    }
    public function createCommand($sql = null, $params = [])
    {
        throw new RuntimeException('SQL execution is forbidden in the old-main oracle');
    }
    public function getSchema()
    {
        return new OldMainMemorySchema(['db' => $this]);
    }
}

final class OldMainMemoryQuery extends yii\db\ActiveQuery
{
    public static array $rows = [];
    public static array $calls = [];

    private function matches(array $row, $condition): bool
    {
        if (!$condition) return true;
        if (!is_array($condition)) throw new RuntimeException('Unsupported fixture condition');
        if (isset($condition[0])) {
            $operator = strtolower($condition[0]);
            if ($operator === 'and') {
                foreach (array_slice($condition, 1) as $part) if (!$this->matches($row, $part)) return false;
                return true;
            }
            // Yii's andFilterWhere already removes empty values and generates
            // the LIKE condition. ASCII fixture containment is evaluated here;
            // this is not a claim about the deployed MySQL collation.
            if ($operator === 'like') return stripos((string)($row[$condition[1]] ?? ''), (string)$condition[2]) !== false;
            throw new RuntimeException('Unsupported fixture operator: ' . $operator);
        }
        foreach ($condition as $column => $value) {
            if (($row[$column] ?? null) != $value) return false;
        }
        return true;
    }

    private function selectedRows(string $operation, bool $paginate): array
    {
        $table = ($this->modelClass)::tableName();
        self::$calls[] = ['operation' => $operation, 'table' => $table, 'where' => $this->where,
            'limit' => $this->limit, 'offset' => $this->offset, 'orderBy' => $this->orderBy];
        $rows = array_values(array_filter(self::$rows[$table] ?? [], fn($row) => $this->matches($row, $this->where)));
        if ($this->orderBy) {
            usort($rows, function ($left, $right) {
                foreach ($this->orderBy as $column => $direction) {
                    $result = ($left[$column] ?? null) <=> ($right[$column] ?? null);
                    if ($result !== 0) return $direction === SORT_DESC ? -$result : $result;
                }
                return 0;
            });
        }
        return $paginate ? array_slice($rows, (int)($this->offset ?? 0), $this->limit === null || $this->limit < 0 ? null : (int)$this->limit) : $rows;
    }
    public function all($db = null)
    {
        return $this->populate($this->selectedRows('all', true));
    }
    public function one($db = null)
    {
        return $this->populate(array_slice($this->selectedRows('one', true), 0, 1))[0] ?? null;
    }
    public function count($q = '*', $db = null)
    {
        return count($this->selectedRows('count', false));
    }
    public function exists($db = null)
    {
        return count($this->selectedRows('exists', false)) > 0;
    }
}
Yii::$container->set(yii\db\ActiveQuery::class, OldMainMemoryQuery::class);
$fileColumns = array_fill_keys(['id', 'unionid', 'key', 'type', 'md5', 'size', 'bucket', 'created_at', 'unlocked', 'title', 'user_id'], null);
OldMainMemoryQuery::$rows = ['file' => array_map(fn($row) => array_replace($fileColumns, $row), $input['files'] ?? [])];

$transportCalls = [];
$utilityCalls = [];
$provider = $input['provider'] ?? ['body' => ['prepay_id' => 'synthetic-prepay-id']];
$client = new class($provider, $transportCalls) {
    public function __construct(private array $fixture, private array &$calls) {}
    public function post($path, $options = []) { return $this->request('POST', $path, $options); }
    public function get($path, $options = []) { return $this->request('GET', $path, $options); }
    private function request($method, $path, $options) {
        $this->calls[] = ['method' => $method, 'path' => $path, 'options' => $options];
        if (isset($this->fixture['throw'])) throw new RuntimeException($this->fixture['throw']);
        return new class($this->fixture['body'] ?? []) {
            public function __construct(private array $body) {}
            public function toArray($throw = true) { return $this->body; }
        };
    }
};
$utils = new class($utilityCalls) {
    public function __construct(private array &$calls) {}
    public function buildMiniAppConfig($prepayId, $appId) {
        $this->calls[] = ['operation' => 'buildMiniAppConfig', 'prepayId' => $prepayId, 'appId' => $appId];
        return ['appId' => $appId, 'timeStamp' => '1794441600', 'nonceStr' => 'synthetic-local-nonce',
            'package' => 'prepay_id=' . $prepayId, 'signType' => 'RSA', 'paySign' => 'synthetic-local-signature'];
    }
};
$payment = new class($client, $utils) {
    public function __construct(private $client, private $utils) {}
    public function getConfig() { return ['app_id' => 'wx-synthetic-old-main', 'mch_id' => '1900000001']; }
    public function getClient() { return $this->client; }
    public function getUtils() { return $this->utils; }
};
$wechat = new class($payment) extends yii\base\Component {
    public function __construct(private $payment) { parent::__construct(); }
    public function payApp() { return $this->payment; }
};
$app = new yii\web\Application([
    'id' => 'old-main-local-source-oracle', 'basePath' => $snapshot, 'timeZone' => 'Asia/Shanghai',
    'components' => [
        'request' => ['cookieValidationKey' => 'synthetic-local-cookie', 'scriptUrl' => '/index.php',
            'scriptFile' => __FILE__, 'hostInfo' => 'https://old-main.fixture.invalid'],
        // The pinned files/api/config/web.php uses these URL flags. Loading
        // that config would also load deployment secrets and real services.
        'urlManager' => ['enablePrettyUrl' => true, 'showScriptName' => false],
        'db' => ['class' => OldMainNoIoConnection::class],
        'wechat' => $wechat,
        'jwt' => ['class' => bizley\jwt\Jwt::class, 'signer' => bizley\jwt\Jwt::HS256,
            'signingKey' => 'synthetic-local-old-main-key-32-bytes-minimum'],
    ],
]);
$app->request->setBodyParams($input['body'] ?? []);
$app->request->setQueryParams($input['query'] ?? []);
$executed = [];
$recordSource = function ($object, string $method) use (&$executed, $snapshot) {
    $reflection = new ReflectionMethod($object, $method);
    $path = $reflection->getFileName();
    if (!str_starts_with($path, $snapshot . '/')) throw new RuntimeException('Loaded source is outside frozen archive');
    $executed[] = ['class' => $reflection->getDeclaringClass()->getName(), 'method' => $method,
        'path' => substr($path, strlen($snapshot) + 1), 'line' => $reflection->getStartLine(),
        'sha256' => hash_file('sha256', $path)];
};
try {
    $operations = [
        'payment-order-v2' => 'actionWxpayOrder',
        'payment-refund-v2' => 'actionWxpayRefund',
        'payment-query-v2' => 'actionWxpayQueryOrderByOutTradeNo',
        'payment-query-refund-v2' => 'actionWxpayQueryRefund',
        'payment-query-transaction-v2' => 'actionWxpayQueryOrderByTransactionId',
    ];
    $operation = $input['operation'] ?? '';
    if (isset($operations[$operation])) {
        $controller = new app\modules\v2\controllers\WechatPayController('wechat-pay', $app);
        $method = $operations[$operation];
        $recordSource($controller, $method);
        $value = $controller->$method();
    } elseif ($operation === 'user-token') {
        $user = new app\modules\v2\models\User();
        $user->setAttributes(['id' => $input['userId'] ?? 1], false);
        $now = new DateTimeImmutable($input['now'] ?? '2026-11-12T00:00:00+00:00');
        $expires = $now->modify('+3 hour');
        $recordSource($user, 'generateAccessToken');
        $token = $user->generateAccessToken($now, $expires);
        $value = ['accessToken' => $token, 'claims' => json_decode(base64_decode(strtr(explode('.', $token)[1], '-_', '+/')), true, 512, JSON_THROW_ON_ERROR)];
    } elseif ($operation === 'file-list') {
        $controller = new app\modules\v2\controllers\FileController('files', $app);
        $action = new yii\base\InlineAction('list', $controller, 'actionList');
        $arguments = $controller->bindActionParams($action, $input['query'] ?? []);
        $recordSource($controller, 'actionList');
        $recordSource(app\modules\v2\models\FileSearch::class, 'search');
        $value = $controller->actionList(...$arguments);
    } else {
        throw new InvalidArgumentException('Unknown old-main oracle operation');
    }
    $result = ['status' => $app->response->statusCode, 'body' => (new yii\rest\Serializer())->serialize($value)];
} catch (Throwable $error) {
    $handler = new class extends yii\web\ErrorHandler {
        public function expose(Throwable $error): array { return $this->convertExceptionToArray($error); }
    };
    $body = $handler->expose($error);
    foreach (['file', 'line', 'stack-trace', 'previous', 'error-info'] as $key) unset($body[$key]);
    $result = ['status' => $error instanceof yii\web\HttpException ? $error->statusCode : 500, 'body' => $body];
} finally {
    $app->errorHandler->unregister();
}
echo json_encode([
    'sourceCommit' => 'c4e088adc7ba17bd5bb640ac31178a122906e002',
    'result' => $result, 'transportCalls' => $transportCalls, 'utilityCalls' => $utilityCalls,
    'persistenceCalls' => OldMainMemoryQuery::$calls, 'executedSource' => $executed,
    'runtime' => ['php' => PHP_VERSION, 'dependencies' => $dependencyVersions,
        'composerLockSha256' => hash_file('sha256', $snapshot . '/composer.lock')],
    'isolation' => ['applicationConfigLoaded' => false, 'provider' => 'synthetic in-memory recorder',
        'database' => 'in-memory fixtures; opening or executing SQL throws', 'sdkSigning' => 'synthetic fixture'],
], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . PHP_EOL;
