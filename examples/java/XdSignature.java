import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.KeyFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * XD-Signature-v1 请求签名参考实现（Java 17+，仅 JDK 标准库）。
 *
 * 规范串固定 11 行（每行以 \n 连接）：
 *   XD-Signature-v1 / {METHOD} / {CANONICAL_PATH} / {CANONICAL_QUERY} /
 *   {TIMESTAMP} / {NONCE} / {APP_ID} / {KEY_ID} / {REQUEST_ID} /
 *   {CONTENT_TYPE} / {SHA256_HEX(rawBody)}
 * 签名算法 RSA-SHA256，签名值 Base64。
 *
 * 运行（本地自检，不发网络请求）：
 *   javac XdSignature.java && java XdSignature POST "/api/open/v1/payments?b=2&a=1" '{"outTradeNo":"T1"}'
 *   私钥通过环境变量 XD_PRIVATE_KEY_PATH（PKCS#8 PEM）注入；appId/kid 通过 XD_APP_ID / XD_KEY_ID 注入。
 */
public final class XdSignature {

    private static final String SIGNATURE_VERSION = "XD-Signature-v1";

    private XdSignature() {
    }

    public static String sha256Hex(byte[] rawBody) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hashed = digest.digest(rawBody == null ? new byte[0] : rawBody);
        StringBuilder sb = new StringBuilder(hashed.length * 2);
        for (byte b : hashed) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    /** RFC3986 严格编码：与 java.net.URLEncoder 不同，空格编成 %20 而不是 + */
    public static String rfc3986Encode(String value) {
        StringBuilder out = new StringBuilder();
        for (byte b : value.getBytes(StandardCharsets.UTF_8)) {
            char c = (char) (b & 0xFF);
            boolean unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
                    || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~';
            if (unreserved) {
                out.append(c);
            } else {
                out.append('%').append(String.format("%02X", b & 0xFF));
            }
        }
        return out.toString();
    }

    /** 路径：解码一次；拒绝路径穿越与别名写法 */
    public static String canonicalizePath(String rawPath) {
        if (rawPath == null || rawPath.isEmpty() || rawPath.charAt(0) != '/' || rawPath.startsWith("//")) {
            throw new IllegalArgumentException("路径必须是以 / 开头的绝对路径");
        }
        if (rawPath.contains("\\") || rawPath.contains("..")) {
            throw new IllegalArgumentException("路径不得包含反斜杠或 ..");
        }
        String decoded = URLDecoder.decode(rawPath.replace("+", "%20"), StandardCharsets.UTF_8);
        if (decoded.contains("\\") || decoded.contains("..") || decoded.contains("//")) {
            throw new IllegalArgumentException("路径解码后含非法片段");
        }
        for (int i = 0; i < decoded.length(); i++) {
            char c = decoded.charAt(i);
            if (c < 0x20 || c == 0x7F) {
                throw new IllegalArgumentException("路径含控制字符");
            }
        }
        return decoded;
    }

    /** 查询串：逐键值解码一次 → RFC3986 重编码 → 按键名排序（稳定排序保留重复键相对顺序） */
    public static String canonicalizeQuery(String rawQuery) {
        if (rawQuery == null || rawQuery.isEmpty()) {
            return "";
        }
        List<String[]> pairs = new ArrayList<>();
        for (String pair : rawQuery.split("&")) {
            int eq = pair.indexOf('=');
            String rawKey = eq == -1 ? pair : pair.substring(0, eq);
            String rawValue = eq == -1 ? "" : pair.substring(eq + 1);
            String key = URLDecoder.decode(rawKey.replace("+", "%20"), StandardCharsets.UTF_8);
            String value = URLDecoder.decode(rawValue.replace("+", "%20"), StandardCharsets.UTF_8);
            pairs.add(new String[] { rfc3986Encode(key), rfc3986Encode(value) });
        }
        pairs.sort((a, b) -> a[0].compareTo(b[0])); // TimSort：稳定排序
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < pairs.size(); i++) {
            if (i > 0) {
                sb.append('&');
            }
            sb.append(pairs.get(i)[0]).append('=').append(pairs.get(i)[1]);
        }
        return sb.toString();
    }

    /** Content-Type：小写、去 `;` 参数 */
    public static String canonicalizeContentType(String rawValue) {
        if (rawValue == null || rawValue.isEmpty()) {
            return "";
        }
        int semicolon = rawValue.indexOf(';');
        String head = semicolon == -1 ? rawValue : rawValue.substring(0, semicolon);
        return head.trim().toLowerCase(java.util.Locale.ROOT);
    }

    public static String buildSigningString(String method, String canonicalPath, String canonicalQuery,
            String timestamp, String nonce, String appId, String keyId, String requestId,
            String contentType, byte[] rawBody) throws Exception {
        String upperMethod = method == null ? "" : method.toUpperCase(java.util.Locale.ROOT);
        if (!upperMethod.matches("[A-Z]+")) {
            throw new IllegalArgumentException("HTTP 方法非法");
        }
        return String.join("\n",
                SIGNATURE_VERSION,
                upperMethod,
                canonicalPath,
                canonicalQuery,
                timestamp,
                nonce,
                appId,
                keyId,
                requestId,
                canonicalizeContentType(contentType),
                sha256Hex(rawBody));
    }

    public static String sign(String signingString, PrivateKey privateKey) throws Exception {
        Signature rsa = Signature.getInstance("SHA256withRSA");
        rsa.initSign(privateKey);
        rsa.update(signingString.getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(rsa.sign());
    }

    /** 读取 PKCS#8 PEM 私钥（本地自检用；生产中请接密钥管理服务） */
    public static PrivateKey loadPrivateKey(String pemPath) throws Exception {
        String pem = Files.readString(Paths.get(pemPath), StandardCharsets.UTF_8);
        String base64 = pem.replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replaceAll("\\s", "");
        byte[] der = Base64.getDecoder().decode(base64);
        return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    /** 生成六个签名头（可直接放进 HTTP 客户端） */
    public static Map<String, String> buildSignedHeaders(String appId, String keyId, PrivateKey privateKey,
            String method, String url, String contentType, byte[] body) throws Exception {
        return buildSignedHeaders(appId, keyId, privateKey, method, url, contentType, body,
                String.valueOf(System.currentTimeMillis() / 1000), randomHex(24),
                java.util.UUID.randomUUID().toString());
    }

    /** 同上的确定性重载：timestamp/nonce/requestId 可注入（golden 向量与回归用） */
    public static Map<String, String> buildSignedHeaders(String appId, String keyId, PrivateKey privateKey,
            String method, String url, String contentType, byte[] body,
            String timestamp, String nonce, String requestId) throws Exception {
        int index = url.indexOf('?');
        String canonicalPath = canonicalizePath(index == -1 ? url : url.substring(0, index));
        String canonicalQuery = canonicalizeQuery(index == -1 ? "" : url.substring(index + 1));
        String signingString = buildSigningString(method, canonicalPath, canonicalQuery, timestamp, nonce,
                appId, keyId, requestId, contentType, body);
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", contentType);
        headers.put("X-XD-App-Id", appId);
        headers.put("X-XD-Timestamp", timestamp);
        headers.put("X-XD-Nonce", nonce);
        headers.put("X-XD-Key-Id", keyId);
        headers.put("X-XD-Request-Id", requestId);
        headers.put("X-XD-Sign", sign(signingString, privateKey));
        return headers;
    }

    private static String randomHex(int charLength) {
        java.security.SecureRandom random = new java.security.SecureRandom();
        byte[] bytes = new byte[charLength / 2];
        random.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(charLength);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        String method = args.length > 0 ? args[0] : "POST";
        String url = args.length > 1 ? args[1] : "/api/open/v1/payments";
        String body = args.length > 2 ? args[2] : "";
        String privateKeyPath = System.getenv("XD_PRIVATE_KEY_PATH");
        if (privateKeyPath == null) {
            System.err.println("请通过环境变量 XD_PRIVATE_KEY_PATH 提供 PKCS#8 PEM 私钥（仅本地自检用）");
            System.exit(1);
        }
        String appId = System.getenv().getOrDefault("XD_APP_ID", "xdop_example000000000");
        String keyId = System.getenv().getOrDefault("XD_KEY_ID", "kid_example");
        String contentType = System.getenv().getOrDefault("XD_CONTENT_TYPE", "application/json; charset=utf-8");
        String timestamp = System.getenv().getOrDefault("XD_TIMESTAMP", String.valueOf(System.currentTimeMillis() / 1000));
        String nonce = System.getenv().getOrDefault("XD_NONCE", randomHex(24));
        String requestId = System.getenv().getOrDefault("XD_REQUEST_ID", java.util.UUID.randomUUID().toString());
        Map<String, String> headers = buildSignedHeaders(appId, keyId, loadPrivateKey(privateKeyPath),
                method, url, contentType, body.getBytes(StandardCharsets.UTF_8), timestamp, nonce, requestId);
        // 先打印规范串（golden 向量自检用），再打印六个签名头。
        int index = url.indexOf('?');
        System.out.println(buildSigningString(method, canonicalizePath(index == -1 ? url : url.substring(0, index)),
                canonicalizeQuery(index == -1 ? "" : url.substring(index + 1)), timestamp, nonce, appId, keyId,
                requestId, contentType, body.getBytes(StandardCharsets.UTF_8)));
        System.out.println("---- headers ----");
        headers.forEach((name, value) -> System.out.println(name + ": " + value));
    }
}
