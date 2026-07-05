<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

// Block iOS devices (iPhone, iPad, iPod) due to exam security requirements
$user_agent = $_SERVER['HTTP_USER_AGENT'] ?? '';
if (preg_match('/(iPhone|iPad|iPod)/i', $user_agent)) {
    http_response_code(403);
    echo json_encode([
        'status' => 'error',
        'message' => 'Access denied for iOS devices due to security policy.'
    ]);
    exit;
}

// ─── ANTI-DDOS & RATE LIMITING ──────────────────────────────────────────────
$ip_address = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
$rate_limit_file = __DIR__ . '/db/rate_limit_' . md5($ip_address) . '.json';
$banned_ips_file = __DIR__ . '/db/banned_ips_system.json';

// Check if banned
if (file_exists($banned_ips_file)) {
    $banned = json_decode(file_get_contents($banned_ips_file), true) ?: [];
    if (isset($banned[$ip_address]) && $banned[$ip_address] > time()) {
        http_response_code(429);
        echo json_encode(['status' => 'error', 'message' => 'Too Many Requests - IP Banned for 24 hours.']);
        exit;
    }
}

// Check rate limit
$current_time = time();
$requests = [];
if (file_exists($rate_limit_file)) {
    $requests = json_decode(file_get_contents($rate_limit_file), true) ?: [];
}
// Filter out requests older than 60 seconds
$requests = array_filter($requests, function($timestamp) use ($current_time) {
    return $timestamp > ($current_time - 60);
});
$requests[] = $current_time;

if (count($requests) > 100000) { // 100,000 requests per minute
    // Ban for 24 hours
    $banned = file_exists($banned_ips_file) ? json_decode(file_get_contents($banned_ips_file), true) ?: [] : [];
    $banned[$ip_address] = $current_time + 86400; // 24 hours
    file_put_contents($banned_ips_file, json_encode($banned));
    
    http_response_code(429);
    echo json_encode(['status' => 'error', 'message' => 'Too Many Requests - IP Banned for 24 hours.']);
    exit;
}
file_put_contents($rate_limit_file, json_encode($requests));

// Database configuration
$config_file = __DIR__ . '/config.json';
$config = [];
if (file_exists($config_file)) {
    $config = json_decode(file_get_contents($config_file), true) ?: [];
}

$db_driver = $config['DB_DRIVER'] ?? 'mysql';
$db_host = $config['DB_HOST'] ?? 'localhost';
$db_user = $config['DB_USER'] ?? 'root';
$db_pass = $config['DB_PASS'] ?? '';
$db_name = $config['DB_NAME'] ?? 'aegis_x';

$conn = null;
$db_fallback = false;

// ─── JWT HELPER FUNCTIONS ───────────────────────────────────────────────────
function base64UrlEncode($text) {
    return str_replace(['+', '/', '='], ['-', '_', ''], base64_encode($text));
}

function base64UrlDecode($text) {
    $b64 = str_replace(['-', '_'], ['+', '/'], $text);
    switch (strlen($b64) % 4) {
        case 2: $b64 .= '=='; break;
        case 3: $b64 .= '='; break;
    }
    return base64_decode($b64);
}

function jwt_encode($payload, $secret) {
    $header = json_encode(['alg' => 'HS256', 'typ' => 'JWT']);
    $payload_str = json_encode($payload);
    $header_b64 = base64UrlEncode($header);
    $payload_b64 = base64UrlEncode($payload_str);
    $signature = hash_hmac('sha256', "$header_b64.$payload_b64", $secret, true);
    $signature_b64 = base64UrlEncode($signature);
    return "$header_b64.$payload_b64.$signature_b64";
}

function jwt_decode($token, $secret) {
    $parts = explode('.', $token);
    if (count($parts) !== 3) {
        return null;
    }
    list($header_b64, $payload_b64, $signature_b64) = $parts;
    $signature = base64UrlDecode($signature_b64);
    $expected_signature = hash_hmac('sha256', "$header_b64.$payload_b64", $secret, true);
    if (!hash_equals($signature, $expected_signature)) {
        return null;
    }
    return json_decode(base64UrlDecode($payload_b64), true);
}

// JWT Secret Key
$jwt_secret = 'antigravity_secret_1620240320';

function verify_auth() {
    global $jwt_secret;
    $headers = array_change_key_case(getallheaders(), CASE_LOWER);
    $token = '';
    if (isset($headers['authorization'])) {
        if (preg_match('/bearer\s(\S+)/i', $headers['authorization'], $matches)) {
            $token = $matches[1];
        }
    }
    if (empty($token)) {
        $input = json_decode(file_get_contents('php://input'), true);
        $token = $_GET['token'] ?? $input['token'] ?? '';
    }
    
    if (empty($token)) {
        http_response_code(401);
        echo json_encode(['status' => 'error', 'message' => 'Unauthorized: Token missing']);
        exit;
    }
    
    $payload = jwt_decode($token, $jwt_secret);
    if (!$payload || ($payload['exp'] ?? 0) < time()) {
        http_response_code(401);
        echo json_encode(['status' => 'error', 'message' => 'Unauthorized: Invalid or expired token']);
        exit;
    }
    return $payload;
}

// ─── REDIS CACHE ENGINE ──────────────────────────────────────────────────────
class AntigravityRedis {
    private static $redis = null;
    private static $enabled = null;

    public static function init() {
        global $config;
        if (self::$enabled !== null) return self::$enabled;
        
        if (class_exists('Redis')) {
            try {
                self::$redis = new Redis();
                $host = $config['REDIS_HOST'] ?? '127.0.0.1';
                $port = (int)($config['REDIS_PORT'] ?? 6379);
                if (self::$redis->connect($host, $port, 1.0)) {
                    self::$enabled = true;
                    return true;
                }
            } catch (Exception $e) {
                // Fail silently
            }
        }
        self::$enabled = false;
        return false;
    }

    public static function get($key) {
        if (!self::init()) return null;
        try {
            $val = self::$redis->get($key);
            return $val ? json_decode($val, true) : null;
        } catch (Exception $e) {
            return null;
        }
    }

    public static function set($key, $value, $ttl = 3600) {
        if (!self::init()) return false;
        try {
            return self::$redis->setex($key, $ttl, json_encode($value));
        } catch (Exception $e) {
            return false;
        }
    }

    public static function delete($key) {
        if (!self::init()) return false;
        try {
            return self::$redis->del($key);
        } catch (Exception $e) {
            return false;
        }
    }
}

// ─── RABBITMQ QUEUE ENGINE ───────────────────────────────────────────────────
class AntigravityQueue {
    private static $connection = null;
    private static $channel = null;
    private static $enabled = null;

    public static function init() {
        global $config;
        if (self::$enabled !== null) return self::$enabled;

        if (class_exists('AMQPConnection')) {
            try {
                $cnn = new AMQPConnection();
                $host = $config['RABBITMQ_HOST'] ?? '127.0.0.1';
                $cnn->setHost($host);
                $cnn->setPort(5672);
                $cnn->setLogin('guest');
                $cnn->setPassword('guest');
                if ($cnn->connect()) {
                    self::$connection = $cnn;
                    self::$channel = new AMQPChannel($cnn);
                    self::$enabled = true;
                    return true;
                }
            } catch (Exception $e) {
                // Fail silently
            }
        }
        self::$enabled = false;
        return false;
    }

    public static function enqueue($queue_name, $payload) {
        $data = [
            'queue' => $queue_name,
            'payload' => $payload,
            'timestamp' => date('Y-m-d H:i:s')
        ];

        if (self::init()) {
            try {
                $queue = new AMQPQueue(self::$channel);
                $queue->setName($queue_name);
                $queue->setFlags(AMQP_DURABLE);
                $queue->declareQueue();
                
                $exchange = new AMQPExchange(self::$channel);
                $exchange->setName('');
                $exchange->publish(json_encode($payload), $queue_name);
                return true;
            } catch (Exception $e) {
                // Fallback
            }
        }

        $queue_file = __DIR__ . '/logs/rabbitmq_fallback_queue.json';
        $current = [];
        if (file_exists($queue_file)) {
            $current = json_decode(file_get_contents($queue_file), true) ?: [];
        }
        $current[] = $data;
        file_put_contents($queue_file, json_encode($current, JSON_PRETTY_PRINT));
        return true;
    }
}

// ─── POSTGRESQL DRIVER ADAPTER FOR MYSQL COMPATIBILITY ───────────────────────
function pgsql_translate_sql($sql) {
    $sql = str_ireplace('AUTO_INCREMENT PRIMARY KEY', 'SERIAL PRIMARY KEY', $sql);
    $sql = str_ireplace('TINYINT(1)', 'SMALLINT', $sql);
    $sql = str_ireplace('TINYINT', 'SMALLINT', $sql);
    $sql = str_ireplace('ON UPDATE CURRENT_TIMESTAMP', '', $sql);
    
    if (stripos($sql, 'INSERT INTO exams') !== false && stripos($sql, 'ON DUPLICATE KEY UPDATE') !== false) {
        $sql = preg_replace(
            '/ON DUPLICATE KEY UPDATE.*/i',
            'ON CONFLICT (exam_code) DO UPDATE SET exam_title = EXCLUDED.exam_title, class_id = EXCLUDED.class_id, questions_json = EXCLUDED.questions_json, time_preservation_offline = EXCLUDED.time_preservation_offline',
            $sql
        );
    }
    return $sql;
}

class PgSQLResultWrapper {
    private $stmt;
    public $num_rows = 0;
    private $rows = [];
    private $index = 0;

    public function __construct($stmt) {
        $this->stmt = $stmt;
        try {
            $this->rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
            $this->num_rows = count($this->rows);
        } catch (Exception $e) {
            $this->rows = [];
            $this->num_rows = 0;
        }
    }

    public function fetch_assoc() {
        if ($this->index < $this->num_rows) {
            return $this->rows[$this->index++];
        }
        return null;
    }

    public function close() {
        $this->rows = [];
        return true;
    }
}

class PgSQLStmtWrapper {
    private $pdo;
    private $stmt;
    private $params = [];

    public function __construct($pdo, $sql) {
        $this->pdo = $pdo;
        $translated = pgsql_translate_sql($sql);
        $this->stmt = $pdo->prepare($translated);
    }

    public function bind_param($types, &...$args) {
        $this->params = $args;
        return true;
    }

    public function execute() {
        try {
            return $this->stmt->execute($this->params);
        } catch (Exception $e) {
            error_log("PGSQL Execute error: " . $e->getMessage());
            return false;
        }
    }

    public function get_result() {
        return new PgSQLResultWrapper($this->stmt);
    }

    public function close() {
        $this->stmt = null;
        return true;
    }

    public function __get($name) {
        if ($name === 'insert_id') {
            return $this->pdo->lastInsertId();
        }
        return null;
    }
}

class PgSQLConnWrapper {
    private $pdo;
    public $insert_id = 0;
    public $error = '';

    public function __construct($pdo) {
        $this->pdo = $pdo;
    }

    public function query($sql) {
        $translated = pgsql_translate_sql($sql);
        try {
            $stmt = $this->pdo->query($translated);
            if ($stmt) {
                if (stripos(trim($translated), 'select') === 0 || stripos(trim($translated), 'show') === 0) {
                    return new PgSQLResultWrapper($stmt);
                }
                return true;
            }
            return false;
        } catch (Exception $e) {
            $this->error = $e->getMessage();
            error_log("PGSQL Query error: " . $e->getMessage());
            return false;
        }
    }

    public function prepare($sql) {
        try {
            return new PgSQLStmtWrapper($this->pdo, $sql);
        } catch (Exception $e) {
            $this->error = $e->getMessage();
            return false;
        }
    }

    public function select_db($name) {
        return true;
    }

    public function __get($name) {
        if ($name === 'insert_id') {
            return $this->pdo->lastInsertId();
        }
        return null;
    }
}

// ─── INITIALIZE DATABASE CONNECTION ──────────────────────────────────────────
try {
    if ($db_driver === 'pgsql') {
        try {
            $temp_pdo = new PDO("pgsql:host=$db_host;dbname=postgres;user=$db_user;password=$db_pass", null, null, [
                PDO::ATTR_TIMEOUT => 2,
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION
            ]);
            $db_exists = $temp_pdo->query("SELECT 1 FROM pg_database WHERE datname = '$db_name'")->fetch();
            if (!$db_exists) {
                $temp_pdo->query("CREATE DATABASE $db_name");
            }
            $temp_pdo = null;
        } catch (Exception $e) {
        }

        $dsn = "pgsql:host=$db_host;dbname=$db_name;user=$db_user;password=$db_pass";
        $pdo = new PDO($dsn, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_TIMEOUT => 3
        ]);
        $conn = new PgSQLConnWrapper($pdo);
    } else {
        $conn = new mysqli($db_host, $db_user, $db_pass);
        if ($conn->connect_error) {
            throw new Exception("Connection failed: " . $conn->connect_error);
        }
        $conn->query("CREATE DATABASE IF NOT EXISTS $db_name DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
        $conn->select_db($db_name);
    }

    $conn->query("CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        role VARCHAR(20) NOT NULL,
        official_name VARCHAR(150) NOT NULL,
        qr_code_hash VARCHAR(128) UNIQUE NOT NULL,
        institution_id INT DEFAULT NULL,
        is_approved TINYINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    $conn->query("CREATE TABLE IF NOT EXISTS classes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_code VARCHAR(50) UNIQUE NOT NULL,
        class_name VARCHAR(150) NOT NULL,
        teacher_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");
    
    $conn->query("CREATE TABLE IF NOT EXISTS enrollment_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        class_id INT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");
    
    $conn->query("CREATE TABLE IF NOT EXISTS exams (
        id INT AUTO_INCREMENT PRIMARY KEY,
        exam_code VARCHAR(50) UNIQUE NOT NULL,
        exam_title VARCHAR(255) NOT NULL,
        class_id INT DEFAULT NULL,
        questions_json TEXT NOT NULL,
        time_preservation_offline TINYINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");
    
    $conn->query("CREATE TABLE IF NOT EXISTS exam_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        exam_code VARCHAR(50) NOT NULL,
        current_seed VARCHAR(50) NOT NULL,
        score DECIMAL(5,2) DEFAULT 0.00,
        integrity_index INT DEFAULT 100,
        status VARCHAR(20) DEFAULT 'active',
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");
    
    $conn->query("CREATE TABLE IF NOT EXISTS violations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        exam_code VARCHAR(50) NOT NULL,
        violation_type VARCHAR(100) NOT NULL,
        details TEXT,
        severity VARCHAR(20) DEFAULT 'medium',
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    $conn->query("CREATE TABLE IF NOT EXISTS heartbeats (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        exam_code VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL,
        duration_seconds INT DEFAULT 0,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    $conn->query("CREATE TABLE IF NOT EXISTS fingerprints (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        user_agent TEXT,
        screen_resolution VARCHAR(50),
        canvas_hash VARCHAR(128),
        webgl_vendor VARCHAR(255),
        webgl_renderer VARCHAR(255),
        is_headless TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    $conn->query("ALTER TABLE users ADD COLUMN IF NOT EXISTS institution_id INT DEFAULT NULL");
    $conn->query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved TINYINT DEFAULT 1");
    $conn->query("ALTER TABLE users ADD COLUMN IF NOT EXISTS official_name VARCHAR(150) NOT NULL DEFAULT ''");
    $conn->query("ALTER TABLE users ADD COLUMN IF NOT EXISTS qr_code_hash VARCHAR(128) DEFAULT NULL");
    $conn->query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(45) DEFAULT NULL");
    $conn->query("ALTER TABLE exams ADD COLUMN IF NOT EXISTS class_id INT DEFAULT NULL");
    $conn->query("ALTER TABLE exams ADD COLUMN IF NOT EXISTS time_preservation_offline TINYINT DEFAULT 0");

} catch (Exception $e) {
    error_log("Database initialization fallback: " . $e->getMessage());
    $db_fallback = true;
}

// CYBER OVERWATCH: Initialize Security Middleware (WAF, Anti-DDoS, Honeypots)
require_once __DIR__ . '/core/middleware/SecurityMiddleware.php';
SecurityMiddleware::run($conn, $db_fallback);

$action = isset($_GET['action']) ? $_GET['action'] : '';

// Protected actions requiring valid stateless JWT token
$protected_actions = [
    'create_class', 'submit_enrollment', 'create_exam', 'log_heartbeat', 'log_violation',
    'update_seed', 'finish_exam', 'get_classes', 'get_enrollments', 'get_student_dashboard',
    'get_teacher_exams', 'get_dashboard_data', 'get_student_classes', 'get_class_exams',
    'get_student_results', 'get_threats', 'unban_ip', 'get_exam', 'register_fingerprint'
];

if (in_array($action, $protected_actions)) {
    $current_user = verify_auth();
    $user = $current_user; // Alias for backward compatibility
}

// Helper function to save file-based logs
function log_to_file($type, $data) {
    $dir = __DIR__ . '/logs';
    if (!is_dir($dir)) {
        mkdir($dir, 0777, true);
    }
    $file = $dir . '/' . $type . '.json';
    $current = [];
    if (file_exists($file)) {
        $current = json_decode(file_get_contents($file), true) ?: [];
    }
    if (!isset($data['id'])) {
        $data['id'] = count($current) + 1;
    }
    if (!isset($data['detected_at']) && !isset($data['created_at'])) {
        $data['detected_at'] = date('Y-m-d H:i:s');
    }
    $current[] = $data;
    file_put_contents($file, json_encode($current, JSON_PRETTY_PRINT));
    return $data;
}

function read_from_file($type) {
    $file = __DIR__ . '/logs/' . $type . '.json';
    if (file_exists($file)) {
        return json_decode(file_get_contents($file), true) ?: [];
    }
    return [];
}

function update_file_logs($type, $updated_list) {
    $file = __DIR__ . '/logs/' . $type . '.json';
    file_put_contents($file, json_encode($updated_list, JSON_PRETTY_PRINT));
}

$input = json_decode(file_get_contents('php://input'), true);

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    
    // Aliases to align client calling names
    if ($action === 'join_class') { $action = 'submit_enrollment'; }
    if ($action === 'fingerprint') { $action = 'register_fingerprint'; }
    if ($action === 'heartbeat') { $action = 'log_heartbeat'; }
    if ($action === 'exam_ended') { $action = 'finish_exam'; }

    // LOCKOUT HANDLER
    if ($action === 'lockout') {
        $student_id = (int)($input['student_id'] ?? 0);
        $exam_code = $input['exam_code'] ?? 'DEFAULT';
        $reason = $input['reason'] ?? 'max_violations';

        if (!$db_fallback) {
            $stmt = $conn->prepare("UPDATE exam_sessions SET status = 'lockout', integrity_index = 0 WHERE student_id = ? AND exam_code = ?");
            if ($stmt) {
                $stmt->bind_param("is", $student_id, $exam_code);
                $stmt->execute();
                $stmt->close();
            }
            $stmt2 = $conn->prepare("INSERT INTO violations (student_id, exam_code, violation_type, details, severity) VALUES (?, ?, 'LOCKOUT', ?, 'high')");
            if ($stmt2) {
                $stmt2->bind_param("iss", $student_id, $exam_code, $reason);
                $stmt2->execute();
                $stmt2->close();
            }
        } else {
            $sessions = read_from_file('sessions');
            foreach ($sessions as &$s) {
                if ((int)$s['student_id'] === $student_id && $s['exam_code'] === $exam_code) {
                    $s['status'] = 'lockout';
                    $s['integrity_index'] = 0;
                    break;
                }
            }
            update_file_logs('sessions', $sessions);

            log_to_file('violations', [
                'student_id' => $student_id,
                'exam_code' => $exam_code,
                'violation_type' => 'LOCKOUT',
                'details' => $reason,
                'severity' => 'high'
            ]);
        }
        echo json_encode(['status' => 'success', 'message' => 'Student locked out']);
        exit;
    }

    // REGISTER
    if ($action === 'register') {
        $username = $input['username'] ?? '';
        $password = password_hash($input['password'] ?? '', PASSWORD_DEFAULT);
        $email = $input['email'] ?? '';
        $role = $input['role'] ?? 'student';
        $official_name = $input['official_name'] ?? '';
        // institution_id: NULL for institutions themselves and students, required only for teachers
        $institution_id = (!empty($input['institution_id']) && $input['institution_id'] > 0) ? (int)$input['institution_id'] : null;
        // Teachers require admin approval unless explicitly pre-approved (e.g. registered directly by institution admin)
        $is_approved = isset($input['is_approved']) ? (int)$input['is_approved'] : (($role === 'teacher') ? 0 : 1);
        $qr_code_hash = 'qr_' . md5($email . time());

        if (!$db_fallback) {
            // Use separate query path depending on whether institution_id is provided
            if ($institution_id !== null) {
                $stmt = $conn->prepare("INSERT INTO users (username, password, email, role, official_name, qr_code_hash, institution_id, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
                if (!$stmt) {
                    echo json_encode(['status' => 'error', 'message' => 'prepare failed: ' . $conn->error]);
                    exit;
                }
                $stmt->bind_param("ssssssii", $username, $password, $email, $role, $official_name, $qr_code_hash, $institution_id, $is_approved);
            } else {
                $stmt = $conn->prepare("INSERT INTO users (username, password, email, role, official_name, qr_code_hash, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?)");
                if (!$stmt) {
                    echo json_encode(['status' => 'error', 'message' => 'prepare failed: ' . $conn->error]);
                    exit;
                }
                $stmt->bind_param("ssssssi", $username, $password, $email, $role, $official_name, $qr_code_hash, $is_approved);
            }
            
            if ($stmt->execute()) {
                $user_id = $stmt->insert_id;
                $stmt->close();
                
                $payload = [
                    'id' => $user_id,
                    'username' => $username,
                    'role' => $role,
                    'official_name' => $official_name,
                    'exp' => time() + 86400
                ];
                $token = jwt_encode($payload, $jwt_secret);

                echo json_encode([
                    'status' => 'success',
                    'user' => [
                        'id' => $user_id, 
                        'username' => $username, 
                        'role' => $role, 
                        'official_name' => $official_name, 
                        'qr_code' => $qr_code_hash, 
                        'is_approved' => $is_approved,
                        'token' => $token
                    ]
                ]);
            } else {
                $err = $stmt ? $stmt->error : $conn->error;
                echo json_encode(['status' => 'error', 'message' => 'فشل الحفظ: ' . $err]);
            }
        } else {
            $users = read_from_file('users');
            foreach ($users as $u) {
                if ($u['username'] === $username || $u['email'] === $email) {
                    echo json_encode(['status' => 'error', 'message' => 'Username or email already exists']);
                    exit;
                }
            }
            $new_user = [
                'username' => $username,
                'password' => $password,
                'email' => $email,
                'role' => $role,
                'official_name' => $official_name,
                'qr_code_hash' => $qr_code_hash,
                'institution_id' => $institution_id,
                'is_approved' => $is_approved
            ];
            $saved = log_to_file('users', $new_user);
            
            $payload = [
                'id' => $saved['id'],
                'username' => $username,
                'role' => $role,
                'official_name' => $official_name,
                'exp' => time() + 86400
            ];
            $token = jwt_encode($payload, $jwt_secret);

            echo json_encode([
                'status' => 'success',
                'user' => [
                    'id' => $saved['id'], 
                    'username' => $username, 
                    'role' => $role, 
                    'official_name' => $official_name, 
                    'qr_code' => $qr_code_hash, 
                    'is_approved' => $is_approved,
                    'token' => $token
                ]
            ]);
        }
        exit;
    }

    // LOGIN
    if ($action === 'login') {
        $username = $input['username'] ?? '';
        $password = $input['password'] ?? '';

        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT * FROM users WHERE username = ?");
            $stmt->bind_param("s", $username);
            $stmt->execute();
            $res = $stmt->get_result();
            if ($row = $res->fetch_assoc()) {
                if (password_verify($password, $row['password'])) {
                    if ((int)$row['is_approved'] === 0) {
                        echo json_encode(['status' => 'error', 'message' => 'بانتظار موافقة مدير المؤسسة على تفعيل حسابك كمعلم.']);
                        exit;
                    }
                    // Overwatch: Record IP
                    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
                    $up_stmt = $conn->prepare("UPDATE users SET last_login_ip = ? WHERE id = ?");
                    if ($up_stmt) {
                        $up_stmt->bind_param("si", $ip, $row['id']);
                        $up_stmt->execute();
                    }

                    $payload = [
                        'id' => $row['id'],
                        'username' => $row['username'],
                        'role' => $row['role'],
                        'official_name' => $row['official_name'],
                        'exp' => time() + 86400
                    ];
                    $token = jwt_encode($payload, $jwt_secret);
                    echo json_encode([
                        'status' => 'success',
                        'user' => [
                            'id' => $row['id'], 
                            'username' => $row['username'], 
                            'role' => $row['role'], 
                            'official_name' => $row['official_name'], 
                            'qr_code' => $row['qr_code_hash'], 
                            'institution_id' => $row['institution_id'],
                            'token' => $token
                        ]
                    ]);
                    exit;
                }
            }
            echo json_encode(['status' => 'error', 'message' => 'اسم المستخدم أو كلمة المرور غير صحيحة.']);
        } else {
            $users = read_from_file('users');
            foreach ($users as $u) {
                if ($u['username'] === $username && password_verify($password, $u['password'])) {
                    if ((int)$u['is_approved'] === 0) {
                        echo json_encode(['status' => 'error', 'message' => 'بانتظار موافقة مدير المؤسسة على تفعيل حسابك كمعلم.']);
                        exit;
                    }
                    // Overwatch: Record IP
                    $u['last_login_ip'] = $_SERVER['REMOTE_ADDR'] ?? '';
                    write_to_file('users', $users);

                    $payload = [
                        'id' => $u['id'],
                        'username' => $u['username'],
                        'role' => $u['role'],
                        'official_name' => $u['official_name'],
                        'exp' => time() + 86400
                    ];
                    $token = jwt_encode($payload, $jwt_secret);
                    echo json_encode([
                        'status' => 'success',
                        'user' => [
                            'id' => $u['id'], 
                            'username' => $u['username'], 
                            'role' => $u['role'], 
                            'official_name' => $u['official_name'], 
                            'qr_code' => $u['qr_code_hash'], 
                            'institution_id' => $u['institution_id'],
                            'token' => $token
                        ]
                    ]);
                    exit;
                }
            }
            echo json_encode(['status' => 'error', 'message' => 'اسم المستخدم أو كلمة المرور غير صحيحة.']);
        }
        exit;
    }

    // QR LOGIN
    if ($action === 'qr_login') {
        $qr_hash = $input['qr_code_hash'] ?? '';

        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT * FROM users WHERE qr_code_hash = ?");
            $stmt->bind_param("s", $qr_hash);
            $stmt->execute();
            $res = $stmt->get_result();
            if ($row = $res->fetch_assoc()) {
                if ((int)$row['is_approved'] === 0) {
                    echo json_encode(['status' => 'error', 'message' => 'بانتظار موافقة مدير المؤسسة على تفعيل حسابك.']);
                    exit;
                }
                $payload = [
                    'id' => $row['id'],
                    'username' => $row['username'],
                    'role' => $row['role'],
                    'official_name' => $row['official_name'],
                    'exp' => time() + 86400
                ];
                $token = jwt_encode($payload, $jwt_secret);
                echo json_encode([
                    'status' => 'success',
                    'user' => [
                        'id' => $row['id'], 
                        'username' => $row['username'], 
                        'role' => $row['role'], 
                        'official_name' => $row['official_name'], 
                        'qr_code' => $row['qr_code_hash'], 
                        'institution_id' => $row['institution_id'],
                        'token' => $token
                    ]
                ]);
                exit;
            }
            echo json_encode(['status' => 'error', 'message' => 'رمز QR غير صالح.']);
        } else {
            $users = read_from_file('users');
            foreach ($users as $u) {
                if ($u['qr_code_hash'] === $qr_hash) {
                    if ((int)$u['is_approved'] === 0) {
                        echo json_encode(['status' => 'error', 'message' => 'بانتظار موافقة مدير المؤسسة على تفعيل حسابك.']);
                        exit;
                    }
                    $payload = [
                        'id' => $u['id'],
                        'username' => $u['username'],
                        'role' => $u['role'],
                        'official_name' => $u['official_name'],
                        'exp' => time() + 86400
                    ];
                    $token = jwt_encode($payload, $jwt_secret);
                    echo json_encode([
                        'status' => 'success',
                        'user' => [
                            'id' => $u['id'], 
                            'username' => $u['username'], 
                            'role' => $u['role'], 
                            'official_name' => $u['official_name'], 
                            'qr_code' => $u['qr_code_hash'], 
                            'institution_id' => $u['institution_id'],
                            'token' => $token
                        ]
                    ]);
                    exit;
                }
            }
            echo json_encode(['status' => 'error', 'message' => 'رمز QR غير صالح.']);
        }
        exit;
    }

    // APPROVE TEACHER (INSTITUTION ADMIN ACTION)
    if ($action === 'approve_teacher') {
        $teacher_id = (int)($input['teacher_id'] ?? 0);
        $status = (int)($input['status'] ?? 1); // 1 = approved, 0 = rejected/blocked

        if (!$db_fallback) {
            $stmt = $conn->prepare("UPDATE users SET is_approved = ? WHERE id = ? AND role = 'teacher'");
            $stmt->bind_param("ii", $status, $teacher_id);
            $stmt->execute();
            $stmt->close();
        }
        
        $users = read_from_file('users');
        foreach ($users as &$u) {
            if ((int)$u['id'] === $teacher_id && $u['role'] === 'teacher') {
                $u['is_approved'] = $status;
                break;
            }
        }
        update_file_logs('users', $users);

        echo json_encode(['status' => 'success', 'message' => 'Teacher approval updated successfully']);
        exit;
    }

    // CREATE CLASS
    if ($action === 'create_class') {
        $class_name = $input['class_name'] ?? 'Classroom';
        $teacher_id = (int)($input['teacher_id'] ?? 0);
        $class_code = 'CLS_' . substr(md5($class_name . time()), 0, 6);

        if (!$db_fallback) {
            $stmt = $conn->prepare("INSERT INTO classes (class_code, class_name, teacher_id) VALUES (?, ?, ?)");
            $stmt->bind_param("ssi", $class_code, $class_name, $teacher_id);
            $stmt->execute();
            $stmt->close();
        }

        log_to_file('classes', [
            'class_code' => $class_code,
            'class_name' => $class_name,
            'teacher_id' => $teacher_id
        ]);

        echo json_encode(['status' => 'success', 'class_code' => $class_code]);
        exit;
    }

    // SUBMIT ENROLLMENT TO A SPECIFIC CLASS
    if ($action === 'submit_enrollment') {
        $student_id = (int)($input['student_id'] ?? 0);
        $class_code = $input['class_code'] ?? '';
        $class_id = 0;

        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT id FROM classes WHERE class_code = ?");
            $stmt->bind_param("s", $class_code);
            $stmt->execute();
            $res = $stmt->get_result();
            if ($row = $res->fetch_assoc()) {
                $class_id = $row['id'];
            }
            $stmt->close();
        } else {
            $classes = read_from_file('classes');
            foreach ($classes as $c) {
                if ($c['class_code'] === $class_code) {
                    $class_id = $c['id'];
                    break;
                }
            }
        }

        if ($class_id === 0) {
            echo json_encode(['status' => 'error', 'message' => 'رمز الفصل غير صحيح أو غير موجود!']);
            exit;
        }

        // Save request
        if (!$db_fallback) {
            $stmt = $conn->prepare("INSERT INTO enrollment_requests (student_id, class_id, status) VALUES (?, ?, 'pending')");
            $stmt->bind_param("ii", $student_id, $class_id);
            $stmt->execute();
            $stmt->close();
        }

        log_to_file('enrollment_requests', [
            'student_id' => $student_id,
            'class_id' => $class_id,
            'status' => 'pending'
        ]);

        echo json_encode(['status' => 'success', 'message' => 'تم تقديم طلب الانضمام للفصل الدراسي بنجاح!']);
        exit;
    }

    // APPROVE/REJECT ENROLLMENT
    if ($action === 'approve_enrollment') {
        $request_id = (int)($input['request_id'] ?? 0);
        $status = $input['status'] ?? 'approved'; // 'approved', 'rejected'

        if (!$db_fallback) {
            $stmt = $conn->prepare("UPDATE enrollment_requests SET status = ? WHERE id = ?");
            $stmt->bind_param("si", $status, $request_id);
            $stmt->execute();
            $stmt->close();
        }
        
        $reqs = read_from_file('enrollment_requests');
        foreach ($reqs as &$r) {
            if ((int)$r['id'] === $request_id) {
                $r['status'] = $status;
                break;
            }
        }
        update_file_logs('enrollment_requests', $reqs);

        echo json_encode(['status' => 'success', 'message' => 'Student enrollment status updated']);
        exit;
    }

    // CREATE EXAM LINKED TO CLASS
    if ($action === 'create_exam') {
        $exam_code = $input['exam_code'] ?? '';
        $exam_title = $input['exam_title'] ?? 'General Exam';
        $class_id = isset($input['class_id']) ? (int)$input['class_id'] : null;
        $questions_json = json_encode($input['questions'] ?? []);
        $time_preservation = isset($input['time_preservation_offline']) ? (int)$input['time_preservation_offline'] : 0;

        if (empty($exam_code)) {
            $exam_code = 'EXAM_' . substr(md5(time()), 0, 6);
        }

        if (!$db_fallback) {
            $stmt = $conn->prepare("INSERT INTO exams (exam_code, exam_title, class_id, questions_json, time_preservation_offline) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE exam_title = ?, class_id = ?, questions_json = ?, time_preservation_offline = ?");
            $stmt->bind_param("ssisissis", $exam_code, $exam_title, $class_id, $questions_json, $time_preservation, $exam_title, $class_id, $questions_json, $time_preservation);
            $stmt->execute();
            $stmt->close();
        }

        log_to_file('exams', [
            'exam_code' => $exam_code,
            'exam_title' => $exam_title,
            'class_id' => $class_id,
            'questions' => $input['questions'] ?? [],
            'time_preservation_offline' => $time_preservation
        ]);

        // Invalidate Redis cache
        AntigravityRedis::delete("exam:$exam_code");

        echo json_encode(['status' => 'success', 'exam_code' => $exam_code]);
        exit;
    }

    // LOG HEARTBEAT
    if ($action === 'log_heartbeat') {
        $student_id = (int)($input['student_id'] ?? 1);
        $exam_code = $input['exam_code'] ?? 'DEFAULT';
        $status = $input['status'] ?? 'online';
        $duration = (int)($input['duration_seconds'] ?? 0);

        $payload = [
            'action' => 'log_heartbeat',
            'student_id' => $student_id,
            'exam_code' => $exam_code,
            'status' => $status,
            'duration_seconds' => $duration,
            'detected_at' => date('Y-m-d H:i:s')
        ];

        // Push to RabbitMQ proctoring queue
        AntigravityQueue::enqueue('proctoring_queue', $payload);

        log_to_file('heartbeats', $payload);

        echo json_encode(['status' => 'success', 'message' => 'Heartbeat state queued']);
        exit;
    }

    // LOG VIOLATION
    if ($action === 'log_violation') {
        $student_id = (int)($input['student_id'] ?? 1);
        $exam_code = $input['exam_code'] ?? 'DEFAULT';
        $violation_type = $input['violation_type'] ?? 'UNKNOWN';
        $details = $input['details'] ?? '';
        $severity = $input['severity'] ?? 'medium';
        $keystroke_stats = $input['keystroke_stats'] ?? null;

        $payload = [
            'action' => 'log_violation',
            'student_id' => $student_id,
            'exam_code' => $exam_code,
            'violation_type' => $violation_type,
            'details' => $details,
            'severity' => $severity,
            'keystroke_stats' => $keystroke_stats,
            'detected_at' => date('Y-m-d H:i:s')
        ];

        // Push to RabbitMQ proctoring queue
        AntigravityQueue::enqueue('proctoring_queue', $payload);

        if (!$db_fallback && $conn) {
            $stmt = $conn->prepare("INSERT INTO violations (student_id, exam_code, violation_type, details, severity, detected_at) VALUES (?, ?, ?, ?, ?, ?)");
            if ($stmt) {
                $stmt->bind_param("isssss", $student_id, $exam_code, $violation_type, $details, $severity, $payload['detected_at']);
                $stmt->execute();
            }
        } else {
            log_to_file('violations', $payload);
        }

        echo json_encode(['status' => 'success', 'message' => 'Violation logged and queued']);
        exit;
    }

    // UPDATE SEED
    if ($action === 'update_seed') {
        $student_id = (int)($input['student_id'] ?? 1);
        $exam_code = $input['exam_code'] ?? 'DEFAULT';
        $seed = $input['seed'] ?? '1000';

        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT id FROM exam_sessions WHERE student_id = ? AND exam_code = ? AND status = 'active'");
            $stmt->bind_param("is", $student_id, $exam_code);
            $stmt->execute();
            $res = $stmt->get_result();
            if ($res->num_rows > 0) {
                $stmt2 = $conn->prepare("UPDATE exam_sessions SET current_seed = ? WHERE student_id = ? AND exam_code = ? AND status = 'active'");
                $stmt2->bind_param("sis", $seed, $student_id, $exam_code);
                $stmt2->execute();
                $stmt2->close();
            } else {
                $stmt2 = $conn->prepare("INSERT INTO exam_sessions (student_id, exam_code, current_seed, status) VALUES (?, ?, ?, 'active')");
                $stmt2->bind_param("iss", $student_id, $exam_code, $seed);
                $stmt2->execute();
                $stmt2->close();
            }
            $stmt->close();
        }

        log_to_file('sessions', [
            'student_id' => $student_id,
            'exam_code' => $exam_code,
            'seed' => $seed,
            'status' => 'active'
        ]);

        echo json_encode(['status' => 'success', 'message' => 'Active seed updated']);
        exit;
    }

    // FINISH EXAM
    if ($action === 'finish_exam') {
        $student_id = (int)($input['student_id'] ?? 1);
        $exam_code = $input['exam_code'] ?? 'DEFAULT';
        $integrity_index = (int)($input['integrity_index'] ?? 100);
        $keystroke_stats = $input['keystroke_stats'] ?? null;
        $answers = $input['answers'] ?? [];

        // 1. Prevent Multiple Submissions
        if (!$db_fallback) {
            $check_stmt = $conn->prepare("SELECT status FROM exam_sessions WHERE student_id = ? AND exam_code = ?");
            if ($check_stmt) {
                $check_stmt->bind_param("is", $student_id, $exam_code);
                $check_stmt->execute();
                $check_res = $check_stmt->get_result();
                if ($check_row = $check_res->fetch_assoc()) {
                    if ($check_row['status'] === 'completed') {
                        echo json_encode(['status' => 'error', 'message' => 'لقد قمت بتسليم هذا الامتحان مسبقاً!']);
                        exit;
                    }
                }
                $check_stmt->close();
            }
        }

        // 2. Server-Side Grading
        $score = 0.00;
        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT questions_json FROM exams WHERE exam_code = ?");
            if ($stmt) {
                $stmt->bind_param("s", $exam_code);
                $stmt->execute();
                $res = $stmt->get_result();
                if ($row = $res->fetch_assoc()) {
                    $questions = json_decode($row['questions_json'], true);
                    $totalQuestions = is_array($questions) ? count($questions) : 0;
                    $scoreEarned = 0;

                    if ($totalQuestions > 0) {
                        foreach ($questions as $idx => $q) {
                            $ans = $answers[$idx] ?? '';
                            if ($q['type'] === 'mcq') {
                                if ($ans !== '' && (int)$ans === (int)($q['correct_option'] ?? -1)) {
                                    $scoreEarned += 100;
                                }
                            } else {
                                $correctAns = $q['computedAnswer'] ?? '';
                                if ($ans !== '' && ((float)$ans === (float)$correctAns || strpos($ans, (string)$correctAns) !== false)) {
                                    $scoreEarned += 100;
                                }
                            }
                        }
                        $score = round($scoreEarned / $totalQuestions);
                    }
                }
                $stmt->close();
            }
        }

        $payload = [
            'action' => 'finish_exam',
            'student_id' => $student_id,
            'exam_code' => $exam_code,
            'score' => $score,
            'integrity_index' => $integrity_index,
            'keystroke_stats' => $keystroke_stats,
            'completed_at' => date('Y-m-d H:i:s')
        ];

        // Push to RabbitMQ submission queue
        AntigravityQueue::enqueue('submission_queue', $payload);

        // Cache session status in Redis
        $session_cache_key = "session:$student_id:$exam_code";
        $session_data = [
            'student_id' => $student_id,
            'exam_code' => $exam_code,
            'score' => $score,
            'integrity_index' => $integrity_index,
            'status' => 'completed',
            'updated_at' => date('Y-m-d H:i:s')
        ];
        AntigravityRedis::set($session_cache_key, $session_data, 3600);

        // Fallback file logging
        $sessions = read_from_file('sessions');
        $found = false;
        foreach ($sessions as &$s) {
            if ((int)$s['student_id'] === $student_id && $s['exam_code'] === $exam_code) {
                $s['score'] = $score;
                $s['integrity_index'] = $integrity_index;
                $s['status'] = 'completed';
                $s['updated_at'] = date('Y-m-d H:i:s');
                $found = true;
                break;
            }
        }
        if (!$found) {
            $sessions[] = $session_data;
        }
        update_file_logs('sessions', $sessions);

        // Update DB Synchronously to prevent race conditions
        if (!$db_fallback) {
            $stmt = $conn->prepare("UPDATE exam_sessions SET score = ?, integrity_index = ?, status = 'completed' WHERE student_id = ? AND exam_code = ?");
            if ($stmt) {
                $stmt->bind_param("diis", $score, $integrity_index, $student_id, $exam_code);
                $stmt->execute();
                $stmt->close();
            }
        }

        echo json_encode(['status' => 'success', 'message' => 'Exam submission queued successfully', 'final_score' => $score]);
        exit;
    }

    // GENERATE EXAM USING GEMINI API
    if ($action === 'generate_ai_exam') {
        $passage = $input['passage'] ?? '';
        $num_questions = (int)($input['num_questions'] ?? 5);
        if ($num_questions < 1) $num_questions = 5;
        if ($num_questions > 15) $num_questions = 15;

        // Try reading config.json for API key
        $config_file = __DIR__ . '/config.json';
        $api_key = '';
        if (file_exists($config_file)) {
            $config_data = json_decode(file_get_contents($config_file), true);
            $api_key = $config_data['GEMINI_API_KEY'] ?? '';
        }
        
        if (empty($api_key)) {
            $api_key = getenv('GEMINI_API_KEY') ?: '';
        }

        // If API key is not configured, return beautiful mock questions based on the topic description
        if (empty($api_key) || $api_key === 'YOUR_GEMINI_API_KEY_HERE') {
            // Mock Offline AI Simulator
            $mock_exams = [
                'كيمياء' => [
                    'exam_title' => 'اختبار الكيمياء العامة الذكي',
                    'questions' => [
                        ['type' => 'mcq', 'text' => 'ما هو الرمز الكيميائي للماء؟', 'options' => ['CO2', 'O2', 'H2O', 'H2'], 'correct_option' => 2],
                        ['type' => 'mcq', 'text' => 'أي مما يلي يعتبر غازاً نبيلاً؟', 'options' => ['الأكسجين', 'الهيليوم', 'النيتروجين', 'الهيدروجين'], 'correct_option' => 1],
                        ['type' => 'mcq', 'text' => 'ما هو الرقم الهيدروجيني (pH) للمحلول المتعادل؟', 'options' => ['0', '7', '14', '5'], 'correct_option' => 1]
                    ]
                ],
                'تاريخ' => [
                    'exam_title' => 'اختبار التاريخ العام الذكي',
                    'questions' => [
                        ['type' => 'mcq', 'text' => 'متى تأسست جامعة الدول العربية؟', 'options' => ['1945م', '1952م', '1960م', '1939م'], 'correct_option' => 0],
                        ['type' => 'mcq', 'text' => 'من هو القائد المسلم الذي فتح الأندلس؟', 'options' => ['صلاح الدين الأيوبي', 'طارق بن زياد', 'خالد بن الوليد', 'عمرو بن العاص'], 'correct_option' => 1],
                        ['type' => 'mcq', 'text' => 'في أي عام سقطت الدولة العثمانية رسمياً؟', 'options' => ['1924م', '1918م', '1908م', '1930م'], 'correct_option' => 0]
                    ]
                ],
                'علوم' => [
                    'exam_title' => 'اختبار العلوم الطبيعية الذكي',
                    'questions' => [
                        ['type' => 'mcq', 'text' => 'ما هو الكوكب الأقرب إلى الشمس؟', 'options' => ['المريخ', 'عطارد', 'الزهرة', 'المشتري'], 'correct_option' => 1],
                        ['type' => 'mcq', 'text' => 'أي الغازات هو الأكثر وفرة في الغلاف الجوي للأرض؟', 'options' => ['الأكسجين', 'النيتروجين', 'ثاني أكسيد الكربون', 'الأرجون'], 'correct_option' => 1],
                        ['type' => 'mcq', 'text' => 'ما هو العضو المسؤول عن ضخ الدم في جسم الإنسان؟', 'options' => ['الرئتان', 'الكبد', 'القلب', 'المعدة'], 'correct_option' => 2]
                    ]
                ],
                'default' => [
                    'exam_title' => 'اختبار تجريبي ذكي مولد تلقائياً',
                    'questions' => [
                        ['type' => 'mcq', 'text' => 'ما هو هدف نظام Aegis-X Secured LMS؟', 'options' => ['حماية وتأمين الامتحانات ومنع الغش', 'مشاركة الملفات الترفيهية', 'تحرير الصور ومقاطع الفيديو', 'تصفح وسائل التواصل الاجتماعي'], 'correct_option' => 0],
                        ['type' => 'mcq', 'text' => 'أي من لغات البرمجة التالية تعمل كـ Backend في هذا المشروع؟', 'options' => ['Python', 'Ruby', 'PHP', 'Go'], 'correct_option' => 2],
                        ['type' => 'mcq', 'text' => 'ما هو الاسم الرمزي لمحرك الأمان في Aegis-X؟', 'options' => ['AegisSecurityEngine', 'AegisShield', 'SafeBrowser', 'ExamDefender'], 'correct_option' => 0]
                    ]
                ]
            ];

            // Determine topic
            $selected_topic = '';
            foreach (['كيمياء', 'تاريخ', 'علوم'] as $topic) {
                if (mb_stripos($passage, $topic) !== false) {
                    $selected_topic = $topic;
                    break;
                }
            }

            if (!empty($selected_topic)) {
                $mock_res = $mock_exams[$selected_topic];
            } else {
                // Dynamically template based on the user's input topic
                $clean_passage = trim(strip_tags($passage));
                // Extract first sentence or first 4 words as topic title
                $words = preg_split('/\s+/', $clean_passage);
                $topic_title = implode(' ', array_slice($words, 0, 4));
                if (empty($topic_title)) $topic_title = 'المادة الدراسية المحددة';

                $mock_res = [
                    'exam_title' => 'اختبار تجريبي في: ' . $topic_title,
                    'questions' => [
                        [
                            'type' => 'mcq',
                            'text' => 'أي الخيارات التالية يمثل المفهوم الرئيسي المرتبط بـ (' . $topic_title . ')؟',
                            'options' => ['المفهوم الأساسي الصحيح للدرس', 'التعريف الفرعي المضلل', 'مفهوم عام غير دقيق', 'لا توجد إجابة صحيحة'],
                            'correct_option' => 0
                        ],
                        [
                            'type' => 'mcq',
                            'text' => 'ما هي الأهمية التطبيقية الكبرى لمفهوم (' . $topic_title . ') في العلوم الحديثة؟',
                            'options' => ['تطوير البحث العلمي والتطبيقات المباشرة', 'تقليل الإنتاجية العامة للعملية', 'زيادة التعقيد النظري فقط', 'إهمال الجوانب العملية والواقعية'],
                            'correct_option' => 0
                        ],
                        [
                            'type' => 'mcq',
                            'text' => 'أي مما يلي يعتبر من الركائز الأساسية لدراسة وفهم (' . $topic_title . ')؟',
                            'options' => ['الاستدلال السطحي', 'التحليل المنهجي الدقيق والتجربة', 'التخمين العشوائي', 'إلغاء المعايير العلمية المعتمدة'],
                            'correct_option' => 1
                        ]
                    ]
                ];
            }
            // adjust number of questions
            $questions = [];
            for ($i = 0; $i < $num_questions; $i++) {
                $questions[] = $mock_res['questions'][$i % count($mock_res['questions'])];
            }

            echo json_encode([
                'status' => 'success',
                'exam_title' => $mock_res['exam_title'],
                'questions' => $questions,
                'note' => 'تم محاكاة التوليد بنجاح (المظهر غير مهيأ لمفتاح API)'
            ]);
            exit;
        }

        // We have a Gemini API key! Make curl call to Gemini API
        $prompt = "أنت خبير تعليمي وأستاذ متميز. قم بتحليل النص المرفق وتوليد اختبار دراسي متكامل مكون من أسئلة اختيار من متعدد (MCQ) ذات خيارات واضحة وسياق دقيق يناسب الفهم الحقيقي وليس الحفظ التلقائي.\n\n";
        $prompt .= "النص التعليمي:\n" . $passage . "\n\n";
        $prompt .= "متطلبات الاختبار:\n";
        $prompt .= "- عدد الأسئلة المطلوبة: " . $num_questions . " سؤالاً.\n";
        $prompt .= "- صيغة السؤال: اختيار من متعدد (MCQ).\n";
        $prompt .= "- يجب أن تحتوي كل مصفوفة خيارات على 4 خيارات دقيقة ومقنعة باللغة العربية.\n";
        $prompt .= "- يجب تحديد الخيار الصحيح كرقم فهرس (index) يبدأ من 0 إلى 3 (0 لـ أ، 1 لـ ب، 2 لـ ج، 3 لـ د).\n";
        $prompt .= "- قم بتسمية نوع السؤال بـ 'mcq' في حقل 'type'.\n\n";
        $prompt .= "هام جداً: قم بإرجاع النتيجة بصيغة JSON مطابقة تماماً للمخطط المطلب.";

        // Request payload
        $payload = [
            'contents' => [
                [
                    'parts' => [
                        ['text' => $prompt]
                    ]
                ]
            ],
            'generationConfig' => [
                'responseMimeType' => 'application/json',
                'responseSchema' => [
                    'type' => 'OBJECT',
                    'properties' => [
                        'exam_title' => ['type' => 'STRING'],
                        'questions' => [
                            'type' => 'ARRAY',
                            'items' => [
                                'type' => 'OBJECT',
                                'properties' => [
                                    'type' => ['type' => 'STRING'],
                                    'text' => ['type' => 'STRING'],
                                    'options' => [
                                        'type' => 'ARRAY',
                                        'items' => ['type' => 'STRING']
                                    ],
                                    'correct_option' => ['type' => 'INTEGER']
                                ],
                                'required' => ['type', 'text', 'options', 'correct_option']
                            ]
                        ]
                    ],
                    'required' => ['exam_title', 'questions']
                ]
            ]
        ];

        // Curl configuration
        $url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" . $api_key;
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        
        $response = curl_exec($ch);
        $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($http_code === 200) {
            $res_data = json_decode($response, true);
            $raw_json = $res_data['candidates'][0]['content']['parts'][0]['text'] ?? '';
            $exam_object = json_decode($raw_json, true);
            if ($exam_object && isset($exam_object['questions'])) {
                echo json_encode([
                    'status' => 'success',
                    'exam_title' => $exam_object['exam_title'] ?? 'اختبار ذكاء اصطناعي مولد',
                    'questions' => $exam_object['questions']
                ]);
                exit;
            }
        }

        echo json_encode([
            'status' => 'error',
            'message' => 'فشل التخاطب مع بوابة Gemini API أو أن الاستجابة غير متوافقة.',
            'debug_code' => $http_code
        ]);
        exit;
    }

    // REGISTER FINGERPRINT
    if ($action === 'register_fingerprint') {
        $student_id = (int)($input['student_id'] ?? 1);
        $user_agent = $input['user_agent'] ?? '';
        $resolution = $input['resolution'] ?? '';
        $canvas_hash = $input['canvas_hash'] ?? '';
        $webgl_vendor = $input['webgl_vendor'] ?? '';
        $webgl_renderer = $input['webgl_renderer'] ?? '';
        $is_headless = isset($input['is_headless']) ? (int)$input['is_headless'] : 0;

        if (!$db_fallback) {
            $stmt = $conn->prepare("INSERT INTO fingerprints (student_id, user_agent, screen_resolution, canvas_hash, webgl_vendor, webgl_renderer, is_headless) VALUES (?, ?, ?, ?, ?, ?, ?)");
            $stmt->bind_param("isssssi", $student_id, $user_agent, $resolution, $canvas_hash, $webgl_vendor, $webgl_renderer, $is_headless);
            $stmt->execute();
            $stmt->close();
        }
        
        log_to_file('fingerprints', [
            'student_id' => $student_id,
            'user_agent' => $user_agent,
            'resolution' => $resolution,
            'canvas_hash' => $canvas_hash,
            'webgl_vendor' => $webgl_vendor,
            'webgl_renderer' => $webgl_renderer,
            'is_headless' => $is_headless
        ]);

        echo json_encode(['status' => 'success', 'message' => 'Fingerprint saved']);
        exit;
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    
    // GET INSTITUTIONS
    if ($action === 'get_institutions') {
        $institutions = [];
        if (!$db_fallback) {
            $res = $conn->query("SELECT id, official_name FROM users WHERE role = 'institution'");
            while ($row = $res->fetch_assoc()) {
                $institutions[] = $row;
            }
        } else {
            $users = read_from_file('users');
            foreach ($users as $u) {
                if ($u['role'] === 'institution') {
                    $institutions[] = ['id' => $u['id'], 'official_name' => $u['official_name']];
                }
            }
        }
        echo json_encode(['status' => 'success', 'institutions' => $institutions]);
        exit;
    }

    // GET TEACHERS PENDING APPROVAL (FOR INSTITUTION ADMIN)
    if ($action === 'get_teachers_pending') {
        $inst_id = (int)($_GET['institution_id'] ?? 0);
        $teachers = [];

        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT id, username, email, official_name, is_approved FROM users WHERE role = 'teacher' AND institution_id = ?");
            $stmt->bind_param("i", $inst_id);
            $stmt->execute();
            $res = $stmt->get_result();
            while ($row = $res->fetch_assoc()) {
                $teachers[] = $row;
            }
            $stmt->close();
        } else {
            $users = read_from_file('users');
            foreach ($users as $u) {
                if ($u['role'] === 'teacher' && (int)$u['institution_id'] === $inst_id) {
                    $teachers[] = [
                        'id' => $u['id'],
                        'username' => $u['username'],
                        'email' => $u['email'],
                        'official_name' => $u['official_name'],
                        'is_approved' => $u['is_approved']
                    ];
                }
            }
        }

        echo json_encode(['status' => 'success', 'teachers' => $teachers]);
        exit;
    }

    // GET CLASSES BY TEACHER
    if ($action === 'get_classes') {
        $teacher_id = (int)($_GET['teacher_id'] ?? 0);
        $classes = [];

        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT * FROM classes WHERE teacher_id = ?");
            $stmt->bind_param("i", $teacher_id);
            $stmt->execute();
            $res = $stmt->get_result();
            while ($row = $res->fetch_assoc()) {
                $classes[] = $row;
            }
            $stmt->close();
        } else {
            $cls = read_from_file('classes');
            foreach ($cls as $c) {
                if ((int)$c['teacher_id'] === $teacher_id) {
                    $classes[] = $c;
                }
            }
        }

        echo json_encode(['status' => 'success', 'classes' => $classes]);
        exit;
    }

    // GET ENROLLMENTS QUEUE FOR TEACHER'S CLASSES
    if ($action === 'get_enrollments') {
        $teacher_id = (int)($_GET['teacher_id'] ?? 0);
        $requests = [];

        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT r.id, r.status, r.requested_at, u.official_name, u.username, c.class_name 
                                    FROM enrollment_requests r 
                                    JOIN users u ON r.student_id = u.id 
                                    JOIN classes c ON r.class_id = c.id 
                                    WHERE c.teacher_id = ?");
            $stmt->bind_param("i", $teacher_id);
            $stmt->execute();
            $res = $stmt->get_result();
            while ($row = $res->fetch_assoc()) {
                $requests[] = $row;
            }
            $stmt->close();
        } else {
            $reqs = read_from_file('enrollment_requests');
            $users = read_from_file('users');
            $cls = read_from_file('classes');

            foreach ($reqs as $r) {
                // Find class
                $target_class = null;
                foreach ($cls as $c) {
                    if ((int)$c['id'] === (int)$r['class_id'] && (int)$c['teacher_id'] === $teacher_id) {
                        $target_class = $c;
                        break;
                    }
                }

                if ($target_class) {
                    // Find user
                    $student = null;
                    foreach ($users as $u) {
                        if ((int)$u['id'] === (int)$r['student_id']) {
                            $student = $u;
                            break;
                        }
                    }
                    if ($student) {
                        $requests[] = [
                            'id' => $r['id'],
                            'status' => $r['status'],
                            'official_name' => $student['official_name'],
                            'username' => $student['username'],
                            'class_name' => $target_class['class_name']
                        ];
                    }
                }
            }
        }

        echo json_encode(['status' => 'success', 'requests' => $requests]);
        exit;
    }

    // GET STUDENT APPROVED CLASSES & EXAMS
    if ($action === 'get_student_dashboard') {
        $student_id = (int)($_GET['student_id'] ?? 0);
        
        $classes = [];
        $exams = [];

        if (!$db_fallback) {
            // Get student classes (where status is approved)
            $stmt = $conn->prepare("SELECT c.id, c.class_name, c.class_code, u.official_name as teacher_name 
                                    FROM enrollment_requests r 
                                    JOIN classes c ON r.class_id = c.id 
                                    JOIN users u ON c.teacher_id = u.id 
                                    WHERE r.student_id = ? AND r.status = 'approved'");
            $stmt->bind_param("i", $student_id);
            $stmt->execute();
            $res = $stmt->get_result();
            while ($row = $res->fetch_assoc()) {
                $classes[] = $row;
            }
            $stmt->close();

            // Get exams for these approved classes
            if (count($classes) > 0) {
                $class_ids = array_map(function($c) { return $c['id']; }, $classes);
                $ids_placeholder = implode(',', $class_ids);
                $q_res = $conn->query("SELECT exam_code, exam_title, class_id FROM exams WHERE class_id IN ($ids_placeholder)");
                while ($row = $q_res->fetch_assoc()) {
                    $exams[] = $row;
                }
            }
        } else {
            $reqs = read_from_file('enrollment_requests');
            $cls = read_from_file('classes');
            $users = read_from_file('users');
            $ex_list = read_from_file('exams');

            // Filter classes
            $approved_class_ids = [];
            foreach ($reqs as $r) {
                if ((int)$r['student_id'] === $student_id && $r['status'] === 'approved') {
                    $approved_class_ids[] = (int)$r['class_id'];
                }
            }

            foreach ($cls as $c) {
                if (in_array((int)$c['id'], $approved_class_ids)) {
                    // Find teacher name
                    $t_name = 'Teacher';
                    foreach ($users as $u) {
                        if ((int)$u['id'] === (int)$c['teacher_id']) {
                            $t_name = $u['official_name'];
                            break;
                        }
                    }
                    $classes[] = [
                        'id' => $c['id'],
                        'class_name' => $c['class_name'],
                        'class_code' => $c['class_code'],
                        'teacher_name' => $t_name
                    ];
                }
            }

            // Filter exams
            foreach ($ex_list as $ex) {
                if (in_array((int)$ex['class_id'], $approved_class_ids)) {
                    $exams[] = [
                        'exam_code' => $ex['exam_code'],
                        'exam_title' => $ex['exam_title'],
                        'class_id' => $ex['class_id']
                    ];
                }
            }
        }

        echo json_encode([
            'status' => 'success',
            'classes' => $classes,
            'exams' => $exams
        ]);
        exit;
    }

    // GET TEACHER EXAMS
    if ($action === 'get_teacher_exams') {
        $teacher_id = (int)($_GET['teacher_id'] ?? 0);
        $exams = [];
        
        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT e.exam_code, e.exam_title, e.class_id, e.time_preservation_offline, c.class_name 
                                    FROM exams e 
                                    JOIN classes c ON e.class_id = c.id 
                                    WHERE c.teacher_id = ?");
            $stmt->bind_param("i", $teacher_id);
            $stmt->execute();
            $res = $stmt->get_result();
            while ($row = $res->fetch_assoc()) {
                $exams[] = $row;
            }
            $stmt->close();
        } else {
            $cls = read_from_file('classes');
            $ex_list = read_from_file('exams');
            
            // Filter classes owned by teacher
            $teacher_class_ids = [];
            foreach ($cls as $c) {
                if ((int)$c['teacher_id'] === $teacher_id) {
                    $teacher_class_ids[] = (int)$c['id'];
                }
            }
            
            // Filter exams in those classes
            foreach ($ex_list as $e) {
                if (in_array((int)$e['class_id'], $teacher_class_ids)) {
                    $exams[] = [
                        'exam_code' => $e['exam_code'],
                        'exam_title' => $e['exam_title'],
                        'class_id' => (int)$e['class_id'],
                        'time_preservation_offline' => (int)($e['time_preservation_offline'] ?? 0)
                    ];
                }
            }
        }
        
        echo json_encode(['status' => 'success', 'exams' => $exams]);
        exit;
    }

    // GET SYSTEM DATA (TEACHER PORTAL)
    if ($action === 'get_dashboard_data') {
        $violations = [];
        $heartbeats = [];
        $sessions = [];
        
        if (!$db_fallback) {
            $v_res = $conn->query("SELECT v.*, u.official_name FROM violations v JOIN users u ON v.student_id = u.id ORDER BY v.detected_at DESC");
            while ($row = $v_res->fetch_assoc()) { $violations[] = $row; }

            $h_res = $conn->query("SELECT h.*, u.official_name FROM heartbeats h JOIN users u ON h.student_id = u.id ORDER BY h.detected_at DESC");
            while ($row = $h_res->fetch_assoc()) { $heartbeats[] = $row; }

            $s_res = $conn->query("SELECT s.*, u.official_name FROM exam_sessions s JOIN users u ON s.student_id = u.id ORDER BY s.updated_at DESC");
            while ($row = $s_res->fetch_assoc()) { $sessions[] = $row; }
        } else {
            $v_data = read_from_file('violations');
            $h_data = read_from_file('heartbeats');
            $s_data = read_from_file('sessions');
            $users = read_from_file('users');

            $users_map = [];
            foreach ($users as $u) { $users_map[$u['id']] = $u['official_name']; }

            foreach ($v_data as $v) {
                $v['official_name'] = $users_map[$v['student_id']] ?? 'طالب تجريبي';
                $violations[] = $v;
            }
            foreach ($h_data as $h) {
                $h['official_name'] = $users_map[$h['student_id']] ?? 'طالب تجريبي';
                $heartbeats[] = $h;
            }
            foreach ($s_data as $s) {
                $s['official_name'] = $users_map[$s['student_id']] ?? 'طالب تجريبي';
                $sessions[] = $s;
            }
        }

        echo json_encode([
            'status' => 'success',
            'violations' => $violations,
            'heartbeats' => $heartbeats,
            'sessions' => $sessions
        ]);
        exit;
    }

    // GET STUDENT CLASSES
    if ($action === 'get_student_classes') {
        $student_id = (int)($_GET['student_id'] ?? 0);
        $classes = [];

        if (!$db_fallback) {
            $stmt = $conn->prepare("
                SELECT c.id, c.class_name, c.class_code, u.official_name as teacher_name, r.status as enrollment_status
                FROM enrollment_requests r
                JOIN classes c ON r.class_id = c.id
                JOIN users u ON c.teacher_id = u.id
                WHERE r.student_id = ?
            ");
            if ($stmt) {
                $stmt->bind_param("i", $student_id);
                $stmt->execute();
                $res = $stmt->get_result();
                while ($row = $res->fetch_assoc()) {
                    $classes[] = $row;
                }
                $stmt->close();
            }
        } else {
            $reqs = read_from_file('enrollment_requests');
            $cls = read_from_file('classes');
            $users = read_from_file('users');

            foreach ($reqs as $r) {
                if ((int)$r['student_id'] === $student_id) {
                    foreach ($cls as $c) {
                        if ((int)$c['id'] === (int)$r['class_id']) {
                            $t_name = 'معلم الفصل';
                            foreach ($users as $u) {
                                if ((int)$u['id'] === (int)$c['teacher_id']) {
                                    $t_name = $u['official_name'];
                                    break;
                                }
                            }
                            $classes[] = [
                                'id' => $c['id'],
                                'class_name' => $c['class_name'],
                                'class_code' => $c['class_code'],
                                'teacher_name' => $t_name,
                                'enrollment_status' => $r['status']
                            ];
                            break;
                        }
                    }
                }
            }
        }

        echo json_encode(['status' => 'success', 'classes' => $classes]);
        exit;
    }

    // GET CLASS EXAMS
    if ($action === 'get_class_exams') {
        $class_id = (int)($_GET['class_id'] ?? 0);
        $student_id = (int)($_GET['student_id'] ?? 0);
        $exams = [];

        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT exam_code, exam_title, class_id FROM exams WHERE class_id = ?");
            if ($stmt) {
                $stmt->bind_param("i", $class_id);
                $stmt->execute();
                $res = $stmt->get_result();
                while ($row = $res->fetch_assoc()) {
                    $exam_code = $row['exam_code'];
                    $stmt2 = $conn->prepare("SELECT score, status FROM exam_sessions WHERE student_id = ? AND exam_code = ?");
                    $stmt2->bind_param("is", $student_id, $exam_code);
                    $stmt2->execute();
                    $res2 = $stmt2->get_result();
                    $row['session_status'] = 'not_started';
                    $row['score'] = 0;
                    if ($row2 = $res2->fetch_assoc()) {
                        $row['session_status'] = $row2['status'];
                        $row['score'] = (float)$row2['score'];
                    }
                    $stmt2->close();
                    $exams[] = $row;
                }
                $stmt->close();
            }
        } else {
            $exs = read_from_file('exams');
            $sessions = read_from_file('sessions');

            foreach ($exs as $e) {
                if ((int)$e['class_id'] === $class_id) {
                    $status = 'not_started';
                    $score = 0;
                    foreach ($sessions as $s) {
                        if ((int)$s['student_id'] === $student_id && $s['exam_code'] === $e['exam_code']) {
                            $status = $s['status'];
                            $score = (float)($s['score'] ?? 0);
                            break;
                        }
                    }
                    $exams[] = [
                        'exam_code' => $e['exam_code'],
                        'exam_title' => $e['exam_title'],
                        'class_id' => $e['class_id'],
                        'session_status' => $status,
                        'score' => $score
                    ];
                }
            }
        }

        echo json_encode(['status' => 'success', 'exams' => $exams]);
        exit;
    }

    // GET STUDENT RESULTS
    if ($action === 'get_student_results') {
        $student_id = (int)($_GET['student_id'] ?? 0);
        $results = [];

        if (!$db_fallback) {
            $stmt = $conn->prepare("
                SELECT s.*, e.exam_title, c.class_name, s.updated_at as submitted_at
                FROM exam_sessions s
                JOIN exams e ON s.exam_code = e.exam_code
                LEFT JOIN classes c ON e.class_id = c.id
                WHERE s.student_id = ?
            ");
            if ($stmt) {
                $stmt->bind_param("i", $student_id);
                $stmt->execute();
                $res = $stmt->get_result();
                while ($row = $res->fetch_assoc()) {
                    $results[] = $row;
                }
                $stmt->close();
            }
        } else {
            $sessions = read_from_file('sessions');
            $exs = read_from_file('exams');
            $cls = read_from_file('classes');

            foreach ($sessions as $s) {
                if ((int)$s['student_id'] === $student_id) {
                    $exam_title = 'امتحان';
                    $class_name = '—';
                    foreach ($exs as $e) {
                        if ($e['exam_code'] === $s['exam_code']) {
                            $exam_title = $e['exam_title'];
                            foreach ($cls as $c) {
                                if ((int)$c['id'] === (int)$e['class_id']) {
                                    $class_name = $c['class_name'];
                                    break;
                                }
                            }
                            break;
                        }
                    }
                    $results[] = [
                        'exam_code' => $s['exam_code'],
                        'exam_title' => $exam_title,
                        'class_name' => $class_name,
                        'score' => $s['score'] ?? 0,
                        'integrity_index' => $s['integrity_index'] ?? 100,
                        'status' => $s['status'] ?? 'completed',
                        'submitted_at' => $s['updated_at'] ?? $s['detected_at'] ?? date('Y-m-d H:i:s')
                    ];
                }
            }
        }

        echo json_encode(['status' => 'success', 'results' => $results]);
        exit;
    }

    // GET EXAM DETAILS BY CODE
    if ($action === 'get_exam') {
        $exam_code = $_GET['code'] ?? '';
        
        require_once __DIR__ . '/core/middleware/EnrollmentMiddleware.php';
        verify_exam_enrollment($user, $exam_code, $conn, $db_fallback);


        if (!$db_fallback) {
            $stmt = $conn->prepare("SELECT * FROM exams WHERE exam_code = ?");
            if ($stmt) {
                $stmt->bind_param("s", $exam_code);
                $stmt->execute();
                $res = $stmt->get_result();
                if ($row = $res->fetch_assoc()) {
                    $questions = json_decode($row['questions_json'], true);
                    if (is_array($questions)) {
                        foreach ($questions as &$q) {
                            unset($q['correct_option']);
                            unset($q['computedAnswer']);
                        }
                    }
                    $row['questions'] = $questions;
                    unset($row['questions_json']); // No need to send the raw string either
                    echo json_encode(['status' => 'success', 'exam' => $row]);
                } else {
                    echo json_encode(['status' => 'error', 'message' => 'الامتحان غير موجود!']);
                }
                $stmt->close();
            } else {
                echo json_encode(['status' => 'error', 'message' => 'خطأ في الاتصال بقاعدة البيانات']);
            }
        } else {
            $exs = read_from_file('exams');
            $found = null;
            foreach ($exs as $e) {
                if ($e['exam_code'] === $exam_code) {
                    $found = $e;
                    break;
                }
            }
            if ($found) {
                $questions = json_decode($found['questions_json'], true);
                if (is_array($questions)) {
                    foreach ($questions as &$q) {
                        unset($q['correct_option']);
                        unset($q['computedAnswer']);
                    }
                }
                $found['questions'] = $questions;
                unset($found['questions_json']);
                echo json_encode(['status' => 'success', 'exam' => $found]);
            } else {
                echo json_encode(['status' => 'error', 'message' => 'الامتحان غير موجود!']);
            }
        }
        exit;
    }
    
    // OVERWATCH: GET THREATS
    if ($action === 'get_threats') {
        if ($user['role'] === 'student') {
            http_response_code(403);
            echo json_encode(['status' => 'error', 'message' => 'ACCESS DENIED']);
            exit;
        }

        $threats = [];
        $banned_ips = [];

        if (!$db_fallback) {
            $t_res = $conn->query("SELECT * FROM threats ORDER BY created_at DESC LIMIT 100");
            if ($t_res) while ($row = $t_res->fetch_assoc()) $threats[] = $row;

            $b_res = $conn->query("SELECT * FROM banned_ips WHERE banned_until > NOW() ORDER BY banned_until DESC");
            if ($b_res) while ($row = $b_res->fetch_assoc()) $banned_ips[] = $row;
        } else {
            $threats = function_exists('read_from_file') ? read_from_file('threats') : [];
            $all_banned = function_exists('read_from_file') ? read_from_file('banned_ips') : [];
            $banned_ips = array_filter($all_banned, function($b) { return strtotime($b['banned_until']) > time(); });
        }

        echo json_encode(['status' => 'success', 'threats' => $threats, 'banned_ips' => array_values($banned_ips)]);
        exit;
    }

    // OVERWATCH: UNBAN IP
    if ($action === 'unban_ip') {
        if ($user['role'] === 'student') {
            http_response_code(403);
            exit;
        }
        
        $ip = $input['ip_address'] ?? '';
        if (!$db_fallback && $conn) {
            $stmt = $conn->prepare("DELETE FROM banned_ips WHERE ip_address = ?");
            if ($stmt) {
                $stmt->bind_param("s", $ip);
                $stmt->execute();
            }
        } else {
            if (function_exists('read_from_file') && function_exists('write_to_file')) {
                $banned = read_from_file('banned_ips');
                $banned = array_filter($banned, function($b) use ($ip) { return $b['ip_address'] !== $ip; });
                write_to_file('banned_ips', array_values($banned));
            }
        }
        echo json_encode(['status' => 'success']);
        exit;
    }
}

echo json_encode(['status' => 'error', 'message' => 'Invalid API Route']);
