<?php
// Offline oracle: the original Connection builds/validates each RESP command;
// only sendRawCommand is replaced with an in-memory Redis implementation.
defined('YII_DEBUG') or define('YII_DEBUG', true);
$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
require $input['root'] . '/api/vendor/autoload.php';
require $input['root'] . '/api/vendor/yiisoft/yii2/Yii.php';
Yii::setAlias('@app', $input['root'] . '/api');

class OfflineRedisConnection extends yii\redis\Connection
{
    public $hashes = [];
    public $lists = [];
    public $strings = [];
    public $mutations = [];
    public function open(): void {}
    protected function sendRawCommand($command, $params)
    {
        $op = array_shift($params);
        $params = array_map(static fn ($value) => (string) ($value ?? ''), $params);
        $key = $params[0] ?? '';
        $values = array_slice($params, 1);
        if (in_array($op, ['RPUSH', 'HMSET', 'HDEL', 'SET', 'INCR'], true)) {
            $this->mutations[] = array_merge([$op], $params);
        }
        switch ($op) {
            case 'GET': return $this->strings[$key] ?? null;
            case 'SET': $this->strings[$key] = $values[0]; return true;
            case 'INCR': return $this->strings[$key] = (string) ((int) ($this->strings[$key] ?? 0) + 1);
            case 'RPUSH':
                $this->lists[$key] = array_merge($this->lists[$key] ?? [], $values);
                return (string) count($this->lists[$key]);
            case 'HGETALL':
                $result = [];
                foreach ($this->hashes[$key] ?? [] as $field => $value) { $result[] = $field; $result[] = $value; }
                return $result;
            case 'HMSET':
                for ($i = 0; $i < count($values); $i += 2) { $this->hashes[$key][$values[$i]] = $values[$i + 1]; }
                return true;
            case 'HDEL':
                foreach ($values as $field) { unset($this->hashes[$key][$field]); }
                if (($this->hashes[$key] ?? []) === []) { unset($this->hashes[$key]); }
                return '1';
        }
        throw new RuntimeException('Unexpected offline command ' . $op);
    }
}
class OriginalSerializationReport extends app\modules\v2\models\Report
{
    public static $connection;
    public static function getDb() { return self::$connection; }
    public static function keyPrefix() { return 'report'; }
}

$results = [];
foreach ($input['cases'] as $case) {
    $db = new OfflineRedisConnection();
    OriginalSerializationReport::$connection = $db;
    $model = new OriginalSerializationReport();
    $token = $case['token'];
    $hashKey = 'report:a:' . OriginalSerializationReport::buildKey($token);
    if (!$case['new']) {
        $db->hashes[$hashKey] = $case['previous'];
        $db->lists['report'] = [OriginalSerializationReport::buildKey($token)];
        OriginalSerializationReport::populateRecord($model, $case['previous']);
    } else {
        $model->token = $token;
    }
    // Yii's HTTP JsonParser decodes JSON objects as PHP arrays, not stdClass.
    $changes = json_decode($case['rawChanges'], true, 512, JSON_THROW_ON_ERROR);
    $model->setAttributes($changes, false);
    $error = null;
    try { $model->save(false); }
    catch (Throwable $exception) { $error = ['name' => 'Exception', 'message' => $exception->getMessage(), 'code' => $exception->getCode(), 'type' => get_class($exception)]; }
    $results[] = [
        'error' => $error,
        'hash' => $db->hashes[$hashKey] ?? null,
        'list' => $db->lists['report'] ?? [],
        'counter' => $db->strings['report:s:token'] ?? null,
        'mutations' => $db->mutations,
    ];
}
echo json_encode(['phpVersion' => PHP_VERSION, 'results' => $results], JSON_THROW_ON_ERROR);
