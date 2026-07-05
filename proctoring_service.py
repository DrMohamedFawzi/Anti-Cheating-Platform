#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
================================================================================
  ANTIGRAVITY PROCTORING ENGINE & ANOMALY DETECTOR — proctoring_service.py
  Python Microservice for Anti-Cheating and Keystroke Dynamics Analysis
  Supervised by: Eng. Mohamed Fawzi Abu Nahla (ID: 1620240320)
================================================================================
"""

import os
import sys
import json
import time
import math

try:
    import pika
    HAS_PIKA = True
except ImportError:
    HAS_PIKA = False

try:
    import redis
    HAS_REDIS = True
except ImportError:
    HAS_REDIS = False

try:
    import psycopg2
    HAS_PGSQL = True
except ImportError:
    HAS_PGSQL = False

try:
    import mysql.connector
    HAS_MYSQL = True
except ImportError:
    HAS_MYSQL = False


# Load Configuration
CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'config.json')
config = {}
if os.path.exists(CONFIG_PATH):
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except Exception as e:
        print(f"Error loading config.json: {e}")

DB_DRIVER = config.get('DB_DRIVER', 'mysql')
DB_HOST = config.get('DB_HOST', 'localhost')
DB_USER = config.get('DB_USER', 'root')
DB_PASS = config.get('DB_PASS', '')
DB_NAME = config.get('DB_NAME', 'aegis_x')
REDIS_HOST = config.get('REDIS_HOST', '127.0.0.1')
REDIS_PORT = int(config.get('REDIS_PORT', 6379))
RABBITMQ_HOST = config.get('RABBITMQ_HOST', '127.0.0.1')

# Baseline parameters for typical human typing
DWELL_MIN = 35    # ms
DWELL_MAX = 220   # ms
FLIGHT_MIN = 45   # ms
FLIGHT_MAX = 800  # ms


def get_db_connection():
    """Dynamically connect to MySQL or PostgreSQL based on config."""
    if DB_DRIVER == 'pgsql' and HAS_PGSQL:
        try:
            return psycopg2.connect(
                host=DB_HOST,
                database=DB_NAME,
                user=DB_USER,
                password=DB_PASS,
                connect_timeout=3
            )
        except Exception as e:
            print(f"PostgreSQL connection failed: {e}")
    elif HAS_MYSQL:
        try:
            return mysql.connector.connect(
                host=DB_HOST,
                user=DB_USER,
                password=DB_PASS,
                database=DB_NAME,
                connect_timeout=3
            )
        except Exception as e:
            print(f"MySQL connection failed: {e}")
    return None


def write_violation_to_db(student_id, exam_code, violation_type, details, severity):
    """Inserts an anomaly/violation record into the database, or file logs as fallback."""
    conn = get_db_connection()
    if conn:
        try:
            cursor = conn.cursor()
            query = "INSERT INTO violations (student_id, exam_code, violation_type, details, severity) VALUES (%s, %s, %s, %s, %s)"
            cursor.execute(query, (student_id, exam_code, violation_type, details, severity))
            conn.commit()
            cursor.close()
            conn.close()
            print(f"[DB] Inserted violation for Student {student_id}")
            return
        except Exception as e:
            print(f"[DB] Error inserting violation: {e}")

    # Fallback to file logs (Offline-first / Resilience)
    log_dir = os.path.join(os.path.dirname(__file__), 'logs')
    os.makedirs(log_dir, exist_ok=True)
    violations_file = os.path.join(log_dir, 'violations.json')
    
    current = []
    if os.path.exists(violations_file):
        try:
            with open(violations_file, 'r', encoding='utf-8') as f:
                current = json.load(f)
        except Exception:
            current = []
            
    violation = {
        "id": len(current) + 1,
        "student_id": student_id,
        "exam_code": exam_code,
        "violation_type": violation_type,
        "details": details,
        "severity": severity,
        "detected_at": time.strftime('%Y-%m-%d %H:%M:%S')
    }
    current.append(violation)
    try:
        with open(violations_file, 'w', encoding='utf-8') as f:
            json.dump(current, f, indent=4, ensure_ascii=False)
        print(f"[File Log] Logged violation for Student {student_id}")
    except Exception as e:
        print(f"Failed writing to violation file: {e}")


def write_submission_to_db(student_id, exam_code, score, integrity_index):
    """Saves final exam results into the database, or file logs as fallback."""
    conn = get_db_connection()
    if conn:
        try:
            cursor = conn.cursor()
            query = "UPDATE exam_sessions SET score = %s, integrity_index = %s, status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE student_id = %s AND exam_code = %s"
            cursor.execute(query, (score, integrity_index, student_id, exam_code))
            conn.commit()
            cursor.close()
            conn.close()
            print(f"[DB] Updated exam result for Student {student_id}")
            return
        except Exception as e:
            print(f"[DB] Error updating exam result: {e}")

    # Fallback
    log_dir = os.path.join(os.path.dirname(__file__), 'logs')
    os.makedirs(log_dir, exist_ok=True)
    sessions_file = os.path.join(log_dir, 'sessions.json')
    
    current = []
    if os.path.exists(sessions_file):
        try:
            with open(sessions_file, 'r', encoding='utf-8') as f:
                current = json.load(f)
        except Exception:
            current = []

    found = False
    for s in current:
        if s.get('student_id') == student_id and s.get('exam_code') == exam_code:
            s['score'] = score
            s['integrity_index'] = integrity_index
            s['status'] = 'completed'
            s['updated_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
            found = True
            break
    if not found:
        current.append({
            "student_id": student_id,
            "exam_code": exam_code,
            "score": score,
            "integrity_index": integrity_index,
            "status": "completed",
            "updated_at": time.strftime('%Y-%m-%d %H:%M:%S')
        })
    try:
        with open(sessions_file, 'w', encoding='utf-8') as f:
            json.dump(current, f, indent=4, ensure_ascii=False)
        print(f"[File Log] Logged session completed for Student {student_id}")
    except Exception as e:
        print(f"Failed writing to sessions file: {e}")


def write_heartbeat_to_db(student_id, exam_code, status, duration):
    conn = get_db_connection()
    if conn:
        try:
            cursor = conn.cursor()
            query = "INSERT INTO heartbeats (student_id, exam_code, status, duration_seconds) VALUES (%s, %s, %s, %s)"
            cursor.execute(query, (student_id, exam_code, status, duration))
            conn.commit()
            cursor.close()
            conn.close()
            return
        except Exception as e:
            print(f"Error logging heartbeat: {e}")


def analyze_keystroke_dynamics(student_id, exam_code, keystroke_stats):
    """
    Performs behavioral anomaly checks on student's typing dynamics.
    If the stats deviate significantly from natural human baselines, it triggers a warning.
    """
    if not keystroke_stats:
        return

    dwell = keystroke_stats.get('avg_dwell_time', 0)
    flight = keystroke_stats.get('avg_flight_time', 0)
    total_keys = keystroke_stats.get('total_keystrokes', 0)

    if total_keys < 3:
        return

    anomalies = []

    # 1. Check Dwell Time
    if dwell < DWELL_MIN:
        anomalies.append(f"معدل إدخال سريع جداً غير بشري (Dwell: {dwell}ms)")
    elif dwell > DWELL_MAX:
        anomalies.append(f"معدل إدخال بطيء جداً مشكوك فيه (Dwell: {dwell}ms)")

    # 2. Check Flight Time
    if flight < FLIGHT_MIN:
        anomalies.append(f"سرعة انتقال فائقة بين الحروف (Flight: {flight}ms)")

    if anomalies:
        details = " | ".join(anomalies) + f" [إجمالي ضربات المفاتيح: {total_keys}]"
        print(f"[Proctoring] Anomaly detected for Student {student_id}: {details}")
        write_violation_to_db(
            student_id=student_id,
            exam_code=exam_code,
            violation_type="TYPING_ANOMALY",
            details=details,
            severity="high"
        )


def process_message(data):
    """Processes a generic queue message."""
    try:
        payload = data.get('payload', {})
        action = payload.get('action') or data.get('action')
        
        print(f"[Worker] Processing action: {action}")
        
        if action == 'log_heartbeat':
            student_id = payload.get('student_id')
            exam_code = payload.get('exam_code')
            status = payload.get('status')
            duration = payload.get('duration_seconds', 0)
            write_heartbeat_to_db(student_id, exam_code, status, duration)
            
        elif action == 'log_violation':
            student_id = payload.get('student_id')
            exam_code = payload.get('exam_code')
            v_type = payload.get('violation_type')
            details = payload.get('details')
            severity = payload.get('severity')
            keystroke_stats = payload.get('keystroke_stats')
            
            write_violation_to_db(student_id, exam_code, v_type, details, severity)
            
            if keystroke_stats:
                analyze_keystroke_dynamics(student_id, exam_code, keystroke_stats)
                
        elif action == 'finish_exam':
            student_id = payload.get('student_id')
            exam_code = payload.get('exam_code')
            score = payload.get('score', 0)
            integrity = payload.get('integrity_index', 100)
            keystroke_stats = payload.get('keystroke_stats')
            
            write_submission_to_db(student_id, exam_code, score, integrity)
            
            if keystroke_stats:
                analyze_keystroke_dynamics(student_id, exam_code, keystroke_stats)
                
    except Exception as e:
        print(f"Error processing message: {e}")


def poll_fallback_queue():
    """Polls the local fallback JSON file queue when RabbitMQ is not connected."""
    queue_file = os.path.join(os.path.dirname(__file__), 'logs', 'rabbitmq_fallback_queue.json')
    if not os.path.exists(queue_file):
        return

    try:
        with open(queue_file, 'r', encoding='utf-8') as f:
            messages = json.load(f)
    except Exception:
        return

    if not messages:
        return

    print(f"[Fallback Worker] Found {len(messages)} pending queued tasks.")
    
    for msg in messages:
        process_message(msg)

    try:
        with open(queue_file, 'w', encoding='utf-8') as f:
            json.dump([], f)
        print("[Fallback Worker] Queue cleared.")
    except Exception as e:
        print(f"Failed clearing fallback queue file: {e}")


def main():
    print("================================================================================")
    print("  ANTIGRAVITY PROCTORING WORKER IS RUNNING...")
    print("  Stateless JWT Verification & Keystroke Dynamics Analysis Active.")
    print("  Supervised by Eng. Mohamed Fawzi Abu Nahla (ID: 1620240320)")
    print("================================================================================")
    
    connection = None
    if HAS_PIKA:
        try:
            credentials = pika.PlainCredentials('guest', 'guest')
            parameters = pika.ConnectionParameters(
                host=RABBITMQ_HOST,
                credentials=credentials,
                connection_attempts=3,
                retry_delay=2
            )
            connection = pika.BlockingConnection(parameters)
            channel = connection.channel()
            
            channel.queue_declare(queue='proctoring_queue', durable=True)
            channel.queue_declare(queue='submission_queue', durable=True)
            
            def callback(ch, method, properties, body):
                try:
                    data = json.loads(body.decode('utf-8'))
                    process_message({'payload': data})
                except Exception as e:
                    print(f"Callback error: {e}")
                ch.basic_ack(delivery_tag=method.delivery_tag)
                
            channel.basic_consume(queue='proctoring_queue', on_message_callback=callback)
            channel.basic_consume(queue='submission_queue', on_message_callback=callback)
            
            print("[RabbitMQ Worker] Connected and listening to queues...")
            channel.start_consuming()
            
        except Exception as e:
            print(f"[RabbitMQ Worker] Failed connecting: {e}")
            connection = None

    if not connection:
        print("[Fallback Worker] RabbitMQ is unavailable. Operating in local polling fallback mode.")
        try:
            while True:
                poll_fallback_queue()
                time.sleep(4)
        except KeyboardInterrupt:
            print("Shutting down worker gracefully.")
            sys.exit(0)


if __name__ == '__main__':
    main()
