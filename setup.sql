CREATE DATABASE IF NOT EXISTS aegis_x DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE aegis_x;

-- Table for users (Students, Teachers, Institutions)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    role VARCHAR(20) NOT NULL, -- 'student', 'teacher', 'institution'
    official_name VARCHAR(150) NOT NULL,
    qr_code_hash VARCHAR(128) UNIQUE NOT NULL,
    institution_id INT DEFAULT NULL, -- Links teachers/students to an Institution
    is_approved TINYINT DEFAULT 1, -- Teachers default to 0 (pending institution approval)
    profile_picture VARCHAR(255) DEFAULT NULL,
    last_login_ip VARCHAR(45) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table for classes/subjects managed by teachers
CREATE TABLE IF NOT EXISTS classes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    class_code VARCHAR(50) UNIQUE NOT NULL,
    class_name VARCHAR(150) NOT NULL,
    teacher_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Table for class enrollment requests (Gatekeeper)
CREATE TABLE IF NOT EXISTS enrollment_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    class_id INT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);

-- Table for storing teacher-created exams
CREATE TABLE IF NOT EXISTS exams (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_code VARCHAR(50) UNIQUE NOT NULL,
    exam_title VARCHAR(255) NOT NULL,
    class_id INT DEFAULT NULL,
    questions_json TEXT NOT NULL,
    time_preservation_offline TINYINT DEFAULT 0,
    duration_minutes INT DEFAULT 60,
    question_count INT DEFAULT NULL,
    security_level VARCHAR(20) DEFAULT 'strict', -- 'strict', 'moderate', 'off'
    exam_mode VARCHAR(20) DEFAULT 'official', -- 'official', 'mock_teacher', 'mock_student'
    created_by INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL
);

-- Table for tracking active exam sessions
CREATE TABLE IF NOT EXISTS exam_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    exam_code VARCHAR(50) NOT NULL,
    current_seed VARCHAR(50) NOT NULL,
    score DECIMAL(5,2) DEFAULT 0.00,
    integrity_index INT DEFAULT 100,
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'completed'
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (exam_code) REFERENCES exams(exam_code) ON DELETE CASCADE
);

-- Table for tracking cheating attempts and violations
CREATE TABLE IF NOT EXISTS violations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    exam_code VARCHAR(50) NOT NULL,
    violation_type VARCHAR(100) NOT NULL,
    details TEXT,
    severity VARCHAR(20) DEFAULT 'medium',
    detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Table for connection heartbeats and internet logs
CREATE TABLE IF NOT EXISTS heartbeats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    exam_code VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL, -- 'offline', 'online'
    duration_seconds INT DEFAULT 0,
    detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Table for tracking student authorized devices (Aegis-X)
CREATE TABLE IF NOT EXISTS user_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    device_id VARCHAR(255) NOT NULL,
    device_label VARCHAR(255) DEFAULT 'جهاز غير معروف',
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'revoked'
    last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_student_device (student_id, device_id)
);

-- Table for storing student browser fingerprints
CREATE TABLE IF NOT EXISTS fingerprints (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    user_agent TEXT,
    screen_resolution VARCHAR(50),
    canvas_hash VARCHAR(128),
    webgl_vendor VARCHAR(255),
    webgl_renderer VARCHAR(255),
    is_headless TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Table for banned IPs (Rate limiter & WAF)
CREATE TABLE IF NOT EXISTS banned_ips (
    ip_address VARCHAR(45) PRIMARY KEY,
    banned_until DATETIME NOT NULL
);

-- Table for security threats and logs
CREATE TABLE IF NOT EXISTS threats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ip_address VARCHAR(45) NOT NULL,
    user_id INT NULL,
    official_name VARCHAR(150) NULL,
    attack_type VARCHAR(50) NOT NULL,
    payload TEXT NULL,
    user_agent TEXT NULL,
    created_at DATETIME NOT NULL
);

