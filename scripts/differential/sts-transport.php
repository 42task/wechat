<?php
// Test-only transport injection for the original Tencent controller actions.
// No SDK request, signing, policy, response or exception logic is replaced.
// Call after the original Composer autoloader has been registered.
class ProviderOracleStsClient extends TencentCloud\Sts\V20180813\StsClient
{
    public static $handler;
    public function __construct($credential, $region, $profile = null)
    {
        $profile = $profile ?? new TencentCloud\Common\Profile\ClientProfile();
        // The SDK otherwise constructs a second connection inside getConnect().
        $profile->getHttpProfile()->setKeepAlive(true);
        parent::__construct($credential, $region, $profile);
        $connectionProperty = new ReflectionProperty(TencentCloud\Common\AbstractClient::class, 'httpConn');
        $connection = $connectionProperty->getValue($this);
        $clientProperty = new ReflectionProperty(TencentCloud\Common\Http\HttpConnection::class, 'client');
        $clientProperty->setValue($connection, new GuzzleHttp\Client([
            'base_uri' => 'https://sts.tencentcloudapi.com',
            'handler' => GuzzleHttp\HandlerStack::create(self::$handler),
        ]));
    }
}

function providerOracleStsControllers(string $sourceApi, callable $handler): array
{
    ProviderOracleStsClient::$handler = $handler;
    $classes = [];
    foreach (['v1', 'v2'] as $version) {
        $class = 'app\\modules\\' . $version . '\\controllers\\ProviderOracleTencentCloudController';
        if (!class_exists($class, false)) {
            $source = file_get_contents($sourceApi . '/modules/' . $version . '/controllers/TencentCloudController.php');
            // The source controller constructs the SDK internally. Change only
            // its test class name and transport-injecting SDK constructor name.
            $source = str_replace('class TencentCloudController extends Controller', 'class ProviderOracleTencentCloudController extends Controller', $source, $classCount);
            $source = str_replace('new StsClient(', 'new \\ProviderOracleStsClient(', $source, $clientCount);
            if ($classCount !== 1 || $clientCount !== 1) throw new RuntimeException('Unexpected source Tencent controller construction');
            eval('?>' . $source);
        }
        $classes[$version] = $class;
    }
    return $classes;
}
