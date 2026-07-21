<?php
// core/middleware/SecurityMiddleware.php

require_once __DIR__ . '/../model/ThreatLoggerModel.php';

class SecurityMiddleware {
    
    // Limits
    private static $RATE_LIMIT = 100000; // max 100,000 requests
    private static $RATE_WINDOW = 60; // per 60 seconds
    private static $BAN_DURATION = 86400; // 24 hours ban
    
    // Malicious Keywords for XSS & SQLi
    private static $MALICIOUS_PAYLOADS = [
        'UNION SELECT', 'DROP TABLE', '<script>', 'onerror=', 'javascript:', '1=1', 'SELECT * FROM', 'INFORMATION_SCHEMA', 'DELETE FROM'
    ];
    
    // Honeypot URLs
    private static $HONEYPOTS = [
        '/admin/config.php.bak', '/.env', '/wp-admin', '/phpmyadmin'
    ];

    public static function run($conn, $db_fallback) {
        $ip = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
        $user_agent = $_SERVER['HTTP_USER_AGENT'] ?? 'Unknown';
        $uri = $_SERVER['REQUEST_URI'] ?? '';
        
        // 1. Check if IP is banned
        if (self::isBanned($ip, $conn, $db_fallback)) {
            http_response_code(403);
            echo json_encode(['status' => 'error', 'message' => 'Forbidden: Your IP is banned due to malicious activity.']);
            exit;
        }
        
        // 2. Honeypot Traps
        foreach (self::$HONEYPOTS as $trap) {
            if (strpos($uri, $trap) !== false) {
                self::banIp($ip, 'Honeypot Triggered', "Requested $trap", $user_agent, $conn, $db_fallback);
                http_response_code(403);
                exit;
            }
        }
        
        // 3. Rate Limiting (Anti-DDoS)
        if (self::isRateLimited($ip, $conn, $db_fallback)) {
            self::banIp($ip, 'DDoS / Rate Limit', 'Exceeded 100,000 requests per minute', $user_agent, $conn, $db_fallback);
            http_response_code(429);
            echo json_encode(['status' => 'error', 'message' => '429 Too Many Requests']);
            exit;
        }
        
        // 4. Payload Inspection (SQLi & XSS)
        $headers = function_exists('getallheaders') ? getallheaders() : [];
        if (self::hasMaliciousPayload($_GET) || self::hasMaliciousPayload($_POST) || self::hasMaliciousPayload($headers)) {
            self::banIp($ip, 'Malicious Payload (SQLi/XSS)', 'Detected malicious keywords in request', $user_agent, $conn, $db_fallback);
            http_response_code(403);
            exit;
        }
    }
    
    private static function isBanned($ip, $conn, $db_fallback) {
        if (!$db_fallback && $conn) {
            $stmt = $conn->prepare("SELECT banned_until FROM banned_ips WHERE ip_address = ? AND banned_until > NOW()");
            if ($stmt) {
                $stmt->bind_param("s", $ip);
                $stmt->execute();
                $res = $stmt->get_result();
                return $res->num_rows > 0;
            }
        } else {
            if (function_exists('read_from_file')) {
                $banned = read_from_file('banned_ips');
                foreach ($banned as $b) {
                    if ($b['ip_address'] === $ip && strtotime($b['banned_until']) > time()) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
    
    private static function banIp($ip, $attack_type, $payload, $user_agent, $conn, $db_fallback) {
        // Log Threat
        ThreatLoggerModel::logThreat($ip, $attack_type, $payload, $user_agent, $conn, $db_fallback);
        
        $banned_until = date('Y-m-d H:i:s', time() + self::$BAN_DURATION);
        
        if (!$db_fallback && $conn) {
            $stmt = $conn->prepare("REPLACE INTO banned_ips (ip_address, banned_until) VALUES (?, ?)");
            if ($stmt) {
                $stmt->bind_param("ss", $ip, $banned_until);
                $stmt->execute();
            }
        } else {
            if (function_exists('read_from_file') && function_exists('write_to_file')) {
                $banned = read_from_file('banned_ips');
                $updated = false;
                foreach ($banned as &$b) {
                    if ($b['ip_address'] === $ip) {
                        $b['banned_until'] = $banned_until;
                        $updated = true;
                    }
                }
                if (!$updated) {
                    $banned[] = ['ip_address' => $ip, 'banned_until' => $banned_until];
                }
                write_to_file('banned_ips', $banned);
            }
        }
    }
    
    private static function isRateLimited($ip, $conn, $db_fallback) {
        $now = time();
        $limit_window = $now - self::$RATE_WINDOW;
        
        // 1. Try to use Redis first (if AntigravityRedis is initialized)
        if (class_exists('AntigravityRedis')) {
            try {
                $minute_bucket = floor($now / 60);
                $redis_key = "rate_limit:" . md5($ip) . ":" . $minute_bucket;
                
                $current_count = (int)AntigravityRedis::get($redis_key);
                if ($current_count === 0) {
                    AntigravityRedis::set($redis_key, 1, 65);
                    $current_count = 1;
                } else {
                    $current_count++;
                    AntigravityRedis::set($redis_key, $current_count, 65);
                }
                
                if ($current_count > self::$RATE_LIMIT) {
                    return true;
                }
                return false;
            } catch (Exception $e) {
                // Fail silently and fall back to file
            }
        }
        
        // 2. Fallback: File-based Rate Limiter
        $cache_file = __DIR__ . '/../../logs/rate_limit_' . md5($ip) . '.json';
        if (!file_exists(dirname($cache_file))) {
            @mkdir(dirname($cache_file), 0777, true);
        }
        
        // Garbage Collection: 1% chance to clean up expired files
        if (mt_rand(1, 100) === 1) {
            $log_dir = dirname($cache_file);
            if (is_dir($log_dir)) {
                $files = glob($log_dir . '/rate_limit_*.json');
                if ($files) {
                    foreach ($files as $f) {
                        if (file_exists($f) && filemtime($f) < (time() - 70)) {
                            @unlink($f);
                        }
                    }
                }
            }
        }
        
        $requests = [];
        if (file_exists($cache_file)) {
            $requests = json_decode(file_get_contents($cache_file), true) ?: [];
        }
        
        // Filter old requests
        $requests = array_filter($requests, function($timestamp) use ($limit_window) {
            return $timestamp > $limit_window;
        });
        
        $requests[] = $now;
        @file_put_contents($cache_file, json_encode(array_values($requests)));
        
        return count($requests) > self::$RATE_LIMIT;
    }
    
    private static function hasMaliciousPayload($data) {
        if (!is_array($data)) return false;
        foreach ($data as $key => $value) {
            if (is_array($value)) {
                if (self::hasMaliciousPayload($value)) return true;
            } else {
                $val_upper = strtoupper((string)$value);
                foreach (self::$MALICIOUS_PAYLOADS as $malicious) {
                    if (strpos($val_upper, strtoupper($malicious)) !== false) {
                        return true; // Found malicious keyword
                    }
                }
            }
        }
        return false;
    }
}
?>
