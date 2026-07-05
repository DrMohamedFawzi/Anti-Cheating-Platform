<?php
// core/middleware/EnrollmentMiddleware.php

/**
 * Middleware to protect API routes and verify student course enrollment
 * Layer 2 Protection
 */
function verify_exam_enrollment($user, $exam_code, $conn, $db_fallback) {
    // Teachers and admins bypass this check
    if ($user['role'] !== 'student') {
        return true;
    }
    
    // AI Practice exams bypass this restriction because they are generated locally
    if ($exam_code === 'AI_PRACTICE' || empty($exam_code)) {
        return true;
    }
    
    if (!$db_fallback) {
        $stmt = $conn->prepare("
            SELECT e.id 
            FROM exams e
            JOIN enrollment_requests en ON e.class_id = en.class_id
            WHERE e.exam_code = ? AND en.student_id = ? AND en.status = 'approved'
        ");
        if (!$stmt) {
            error_log("Prepare failed: " . $conn->error);
            return false;
        }
        $stmt->bind_param("si", $exam_code, $user['id']);
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($result->num_rows === 0) {
            http_response_code(403);
            echo json_encode([
                'status' => 'error', 
                'message' => 'Forbidden: You are not enrolled in the class for this exam, or your enrollment is pending.'
            ]);
            exit;
        }
    } else {
        // Fallback DB Logic
        $exams = read_from_file('exams');
        $enrollments = read_from_file('enrollment_requests');
        
        $target_exam = null;
        foreach ($exams as $e) {
            if ($e['exam_code'] === $exam_code) {
                $target_exam = $e;
                break;
            }
        }
        
        if (!$target_exam) {
            http_response_code(404);
            echo json_encode(['status' => 'error', 'message' => 'Exam not found.']);
            exit;
        }
        
        $is_enrolled = false;
        foreach ($enrollments as $en) {
            if ($en['student_id'] == $user['id'] && $en['class_id'] == $target_exam['class_id'] && $en['status'] === 'approved') {
                $is_enrolled = true;
                break;
            }
        }
        
        if (!$is_enrolled) {
            http_response_code(403);
            echo json_encode([
                'status' => 'error', 
                'message' => 'Forbidden: You are not enrolled in the class for this exam.'
            ]);
            exit;
        }
    }
    
    return true;
}
?>
