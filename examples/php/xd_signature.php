<?php

declare(strict_types=1);

/**
 * XD-Signature-v1 请求签名参考实现（PHP 8+，仅标准库 openssl / hash）。
 *
 * 规范串固定 11 行（每行以 \n 连接）：
 *   XD-Signature-v1 / {METHOD} / {CANONICAL_PATH} / {CANONICAL_QUERY} /
 *   {TIMESTAMP} / {NONCE} / {APP_ID} / {KEY_ID} / {REQUEST_ID} /
 *   {CONTENT_TYPE} / {SHA256_HEX(rawBody)}
 * 签名算法 RSA-SHA256（openssl_sign 默认 PKCS#1 v1.5 填充），签名值 Base64。
 *
 * 自检：
 *   XD_APP_ID=... XD_KEY_ID=... XD_PRIVATE_KEY_PATH=./private_key.pem \
 *   php xd_signature.php POST '/api/open/v1/payments?b=2&a=1' '{"outTradeNo":"T1"}'
 */

const XD_SIGNATURE_VERSION = 'XD-Signature-v1';

function xd_sha256_hex(string $rawBody): string
{
    return hash('sha256', $rawBody);
}

/** RFC3986 严格编码（rawurlencode 已符合，此处显式声明以免被替换成 urlencode） */
function xd_rfc3986_encode(string $value): string
{
    return rawurlencode($value);
}

/** 路径：解码一次；拒绝路径穿越与别名写法 */
function xd_canonicalize_path(string $rawPath): string
{
    if ($rawPath === '' || $rawPath[0] !== '/' || str_starts_with($rawPath, '//')) {
        throw new InvalidArgumentException('路径必须是以 / 开头的绝对路径');
    }
    if (str_contains($rawPath, '\\') || str_contains($rawPath, '..')) {
        throw new InvalidArgumentException('路径不得包含反斜杠或 ..');
    }
    $decoded = rawurldecode($rawPath);
    if (str_contains($decoded, '\\') || str_contains($decoded, '..') || str_contains($decoded, '//')
        || preg_match('/[\x00-\x1F\x7F]/', $decoded) === 1) {
        throw new InvalidArgumentException('路径解码后含非法片段');
    }
    return $decoded;
}

/**
 * 查询串：逐键值解码一次 → RFC3986 重编码 → **按重编码后的键名**字节序排序
 * （稳定排序保留重复键相对顺序）。
 *
 * 两个易错点，别再改回去：
 *   1. **先编码再排序**，不是先排序再编码。含非 ASCII 或转义字符的键，两种顺序
 *      会得到不同的规范串（例：`%C3%A9=2&a=1` 按编码键排是 `%C3%A9=2&a=1`，
 *      按解码键排会变成 `a=1&%C3%A9=2`）——平台与 Node / Java / Python 示例
 *      都是先编码再排序。
 *   2. 比较用 **`strcmp`（字节序）**，不要用 `<=>`：PHP 8 起 `<=>` 对「两个都是
 *      数字字符串」的键走**数值比较**（`"10" <=> "9"` 得负值），而平台与其余
 *      三语言比的是字典序（`"10" < "9"`）。
 */
function xd_canonicalize_query(string $rawQuery): string
{
    if ($rawQuery === '') {
        return '';
    }
    $pairs = [];
    foreach (explode('&', $rawQuery) as $pair) {
        $eq = strpos($pair, '=');
        $rawKey = $eq === false ? $pair : substr($pair, 0, $eq);
        $rawValue = $eq === false ? '' : substr($pair, $eq + 1);
        $key = rawurldecode(str_replace('+', '%20', $rawKey));
        $value = rawurldecode(str_replace('+', '%20', $rawValue));
        $pairs[] = ['key' => xd_rfc3986_encode($key), 'value' => xd_rfc3986_encode($value)];
    }
    usort($pairs, static fn(array $a, array $b): int => strcmp($a['key'], $b['key'])); // PHP 8 起 usort 稳定
    return implode('&', array_map(
        static fn(array $p): string => $p['key'] . '=' . $p['value'],
        $pairs,
    ));
}

/** Content-Type：小写、去 `;` 参数 */
function xd_canonicalize_content_type(string $rawValue): string
{
    if ($rawValue === '') {
        return '';
    }
    $semicolon = strpos($rawValue, ';');
    $head = $semicolon === false ? $rawValue : substr($rawValue, 0, $semicolon);
    return strtolower(trim($head));
}

function xd_build_signing_string(
    string $method,
    string $canonicalPath,
    string $canonicalQuery,
    string $timestamp,
    string $nonce,
    string $appId,
    string $keyId,
    string $requestId,
    string $contentType,
    string $rawBody,
): string {
    $upperMethod = strtoupper($method);
    if (preg_match('/^[A-Z]+$/', $upperMethod) !== 1) {
        throw new InvalidArgumentException('HTTP 方法非法');
    }
    return implode("\n", [
        XD_SIGNATURE_VERSION,
        $upperMethod,
        $canonicalPath,
        $canonicalQuery,
        $timestamp,
        $nonce,
        $appId,
        $keyId,
        $requestId,
        xd_canonicalize_content_type($contentType),
        xd_sha256_hex($rawBody),
    ]);
}

/**
 * 生成六个签名头。
 *
 * @param string $privateKeyPem PEM 私钥（只在本机内存中使用）
 * @return array{signingString: string, headers: array<string, string>}
 */
function xd_build_signed_headers(
    string $appId,
    string $keyId,
    string $privateKeyPem,
    string $method,
    string $url,
    string $contentType = 'application/json',
    string $body = '',
    ?int $timestamp = null,
    ?string $nonce = null,
    ?string $requestId = null,
): array {
    $index = strpos($url, '?');
    $canonicalPath = xd_canonicalize_path($index === false ? $url : substr($url, 0, $index));
    $canonicalQuery = xd_canonicalize_query($index === false ? '' : substr($url, $index + 1));
    $timestamp ??= time();
    $nonce ??= bin2hex(random_bytes(12));
    $requestId ??= xd_random_uuid();

    $signingString = xd_build_signing_string(
        $method,
        $canonicalPath,
        $canonicalQuery,
        (string) $timestamp,
        $nonce,
        $appId,
        $keyId,
        $requestId,
        $contentType,
        $body,
    );

    $signatureBase64 = '';
    $key = openssl_pkey_get_private($privateKeyPem);
    if ($key === false) {
        throw new RuntimeException('私钥无法解析（应为 PEM 格式）');
    }
    if (openssl_sign($signingString, $signature, $key, OPENSSL_ALGO_SHA256) !== true) {
        throw new RuntimeException('签名失败');
    }
    $signatureBase64 = base64_encode($signature);

    return [
        'signingString' => $signingString,
        'headers' => [
            'Content-Type' => $contentType,
            'X-XD-App-Id' => $appId,
            'X-XD-Timestamp' => (string) $timestamp,
            'X-XD-Nonce' => $nonce,
            'X-XD-Key-Id' => $keyId,
            'X-XD-Request-Id' => $requestId,
            'X-XD-Sign' => $signatureBase64,
        ],
    ];
}

function xd_random_uuid(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === realpath(__FILE__)) {
    $method = $argv[1] ?? 'POST';
    $url = $argv[2] ?? '/api/open/v1/payments';
    $body = $argv[3] ?? '';
    $privateKeyPem = getenv('XD_PRIVATE_KEY_PATH')
        ? file_get_contents(getenv('XD_PRIVATE_KEY_PATH'))
        : getenv('XD_PRIVATE_KEY_PEM');
    if ($privateKeyPem === false || $privateKeyPem === null || $privateKeyPem === '') {
        fwrite(STDERR, "请通过 XD_PRIVATE_KEY_PATH 或 XD_PRIVATE_KEY_PEM 提供私钥（仅本地自检用）\n");
        exit(1);
    }
    $result = xd_build_signed_headers(
        getenv('XD_APP_ID') ?: 'xdop_example000000000',
        getenv('XD_KEY_ID') ?: 'kid_example',
        $privateKeyPem,
        $method,
        $url,
        getenv('XD_CONTENT_TYPE') ?: 'application/json; charset=utf-8',
        $body,
        getenv('XD_TIMESTAMP') !== false ? (int) getenv('XD_TIMESTAMP') : null,
        getenv('XD_NONCE') ?: null,
        getenv('XD_REQUEST_ID') ?: null,
    );
    echo $result['signingString'], "\n---- headers ----\n";
    foreach ($result['headers'] as $name => $value) {
        echo $name, ': ', $value, "\n";
    }
}
