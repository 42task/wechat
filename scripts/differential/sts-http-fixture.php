<?php
// Isolated HTTP runner only. Keep the source actions and SDK, replacing only
// their transport with the same declared fixture used by the compiled Node app.
return static function (string $api, array &$config): void {
    require_once __DIR__ . '/sts-transport.php';
    $body = file_get_contents(__DIR__ . '/sts-http-response.json');
    $classes = providerOracleStsControllers($api, static function ($request, $options) use ($body) {
        if ($request->getUri()->getHost() !== 'sts.tencentcloudapi.com') throw new RuntimeException('Unexpected STS fixture target');
        return new GuzzleHttp\Promise\FulfilledPromise(new GuzzleHttp\Psr7\Response(200, ['Content-Type'=>'application/json'], $body));
    });
    foreach ($classes as $version => $class) $config['modules'][$version]['controllerMap']['tencent-cloud'] = $class;
    $config['components']['secret'] = [
        'class'=>app\modules\v1\components\Secret::class,
        'id'=>'synthetic-sts-id','key'=>'synthetic-sts-key',
        'cloud'=>['bucket'=>'configured-1250000000','region'=>'ap-shanghai'],
    ];
};
