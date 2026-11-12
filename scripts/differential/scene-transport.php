<?php
/** Test-only CA injection; the unmodified Yii fetcher still validates pages and payloads. */
return static function (string $url, int $timeoutMs): array {
    $parts = parse_url($url);
    if (($parts['host'] ?? '') !== '127.0.0.1' || ($parts['port'] ?? 0) !== 19999) {
        throw new RuntimeException('Scene fixture transport only accepts its loopback test service.');
    }
    $handle = curl_init($url);
    $headers = [];
    curl_setopt_array($handle, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT_MS => min(5000, $timeoutMs),
        CURLOPT_TIMEOUT_MS => $timeoutMs,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_CAINFO => dirname(__DIR__, 2) . '/runtime/parity-validation/scene-cert.pem',
        CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$headers): int {
            if (preg_match('/^HTTP\//i', $line)) $headers = [];
            elseif (strpos($line, ':') !== false) { [$name, $value] = explode(':', $line, 2); $headers[strtolower(trim($name))] = trim($value); }
            return strlen($line);
        },
    ]);
    try {
        $body = curl_exec($handle);
        if ($body === false) throw new RuntimeException('Local scene fixture request failed.');
        return ['status' => curl_getinfo($handle, CURLINFO_HTTP_CODE), 'headers' => $headers, 'body' => $body];
    } finally { curl_close($handle); }
};
