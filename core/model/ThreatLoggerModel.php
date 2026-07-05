<?php
// core/model/ThreatLoggerModel.php

class ThreatLoggerModel {
    /**
     * Log a threat and unmask the attacker if possible
     */
    public static function logThreat($ip_address, $attack_type, $payload, $user_agent, $conn, $db_fallback) {
        $user_id = null;
        $official_name = null;
        
        // 1. Unmasking: Check if this IP is associated with any known user
        if (!$db_fallback && $conn) {
            $stmt = $conn->prepare("SELECT id, official_name FROM users WHERE last_login_ip = ? LIMIT 1");
            if ($stmt) {
                $stmt->bind_param("s", $ip_address);
                $stmt->execute();
                $res = $stmt->get_result();
                if ($row = $res->fetch_assoc()) {
                    $user_id = $row['id'];
                    $official_name = $row['official_name'];
                }
                $stmt->close();
            }
        } else {
            // Fallback unmasking
            if (function_exists('read_from_file')) {
                $users = read_from_file('users');
                foreach ($users as $u) {
                    if (isset($u['last_login_ip']) && $u['last_login_ip'] === $ip_address) {
                        $user_id = $u['id'];
                        $official_name = $u['official_name'];
                        break;
                    }
                }
            }
        }

        // 2. Log the threat
        $created_at = date('Y-m-d H:i:s');
        if (!$db_fallback && $conn) {
            // Create table if it doesn't exist
            $conn->query("CREATE TABLE IF NOT EXISTS threats (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ip_address VARCHAR(45) NOT NULL,
                user_id INT NULL,
                official_name VARCHAR(150) NULL,
                attack_type VARCHAR(50) NOT NULL,
                payload TEXT NULL,
                user_agent TEXT NULL,
                created_at DATETIME NOT NULL
            )");

            $stmt = $conn->prepare("INSERT INTO threats (ip_address, user_id, official_name, attack_type, payload, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
            if ($stmt) {
                $stmt->bind_param("sisssss", $ip_address, $user_id, $official_name, $attack_type, $payload, $user_agent, $created_at);
                $stmt->execute();
                $stmt->close();
            }
        } else {
            // Fallback DB Logging
            if (function_exists('read_from_file') && function_exists('write_to_file')) {
                $threats = read_from_file('threats');
                $threats[] = [
                    'id' => count($threats) + 1,
                    'ip_address' => $ip_address,
                    'user_id' => $user_id,
                    'official_name' => $official_name,
                    'attack_type' => $attack_type,
                    'payload' => $payload,
                    'user_agent' => $user_agent,
                    'created_at' => $created_at
                ];
                write_to_file('threats', $threats);
            }
        }
    }
}
?>
