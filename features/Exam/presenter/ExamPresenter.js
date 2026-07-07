// Exam Presenter
const examAuth = AuthGuard.protectExamRoute();
if (!examAuth) {
    throw new Error('Unauthorized');
}
const currentUser = examAuth.user;
const currentExamCode = examAuth.examCode;

        
        
        
        let questionsTemplates = [
            {
                type: "math",
                text: "أوجد قيمة المتغير y بناءً على دالة المدخلات الرياضية التالية بفرض أن القيمة المعطاة للمتغير x هي 2:",
                formula: "y = {x_coeff}x² + {x_linear}x + {const_val}"
            }
        ];
        
        let currentQuestionIdx = 0;
        let currentQuestionState = null;
        let violationCount = 0;
        let studentAnswers = [];
        let totalQuestionsSolved = 0;
        let totalDowntimeSeconds = 0;
        let activeSeconds = 0;
        let totalExamTimeLimit = 2700; // 45 minutes
        let offlineTimerInterval = null;
        let isExamFinished = false;
        let audioViolationsCount = 0; // Track audio violations

        // Save exam state locally to prevent data loss on refresh
        function saveExamState() {
            if (isExamFinished) return;
            try {
                const state = {
                    activeSeconds,
                    currentQuestionIdx,
                    studentAnswers,
                    totalQuestionsSolved,
                    audioViolationsCount,
                    seed: (typeof AegisSecurityEngine !== 'undefined') ? AegisSecurityEngine.getCurrentSeed() : 1000, violationCount: violationCount
                };
                localStorage.setItem(`exam_state_${currentExamCode}`, JSON.stringify(state));
                sessionStorage.setItem(`exam_state_${currentExamCode}`, JSON.stringify(state));
            } catch (e) {
                console.error("Could not save exam state", e);
            }
        }

        window.addEventListener('beforeunload', function (e) {
            if (!isExamFinished) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // Redirect if not logged in
        if (false) {
            alert("يرجى تسجيل الدخول أولاً لإثبات الهوية الرقمية.");
            window.location.href = "login.html";
        }

        // Initialize question rendering
        function initQuestion() {
            const template = questionsTemplates[currentQuestionIdx];
            const seed = AegisSecurityEngine.getCurrentSeed();
            currentQuestionState = AegisSecurityEngine.mutateQuestion(template, seed, currentUser ? currentUser.id : null);
            
            // Draw securely on Canvas & handle layout toggle
            const label = currentUser ? `${currentUser.official_name} (${currentUser.id})` : 'GUEST';
            const isMCQ = (currentQuestionState.type === 'mcq');
            
            const mathWrap = document.getElementById('math-answer-wrap');
            const mcqWrap = document.getElementById('mcq-answer-wrap');
            
            if (isMCQ) {
                mathWrap.classList.add('hidden');
                mcqWrap.classList.remove('hidden');
                
                // Clear MCQ selections
                document.getElementById('mcq-selected-val').value = '';
                for (let i = 0; i < 4; i++) {
                    const btn = document.getElementById(`btn-opt-${i}`);
                    if (btn) btn.className = "btn btn-outline border-slate-800 text-slate-300 rounded-xl text-xs py-3";
                }
                
                AegisSecurityEngine.drawOnCanvas('question-canvas', currentQuestionState.text, currentQuestionState.options, label, true);
            } else {
                mathWrap.classList.remove('hidden');
                mcqWrap.classList.add('hidden');
                document.getElementById('answer-input').value = '';
                
                AegisSecurityEngine.drawOnCanvas('question-canvas', currentQuestionState.text, currentQuestionState.formula, label, false);
            }

            // Update button label
            const isLast = (currentQuestionIdx === questionsTemplates.length - 1);
            document.getElementById('submit-btn').innerText = isLast ? "إنهاء الامتحان وتسليم الإجابات" : "السؤال التالي \u2190";

            // Populate background prompt injection
            const hiddenDom = document.getElementById('hidden-dom-content');
            const rawQuestionContent = isMCQ 
                ? currentQuestionState.text + " " + currentQuestionState.options.join(" ") 
                : currentQuestionState.text + " " + currentQuestionState.formula;
            hiddenDom.innerText = AegisSecurityEngine.generatePoisonedText(rawQuestionContent);
            
            // Sync seed
            fetch('api.php?action=update_seed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    student_id: currentUser.id,
                    exam_code: currentExamCode,
                    seed: seed.toString()
                })
            }).catch(e => console.log("Updating seed cached locally."));
        }

        // MCQ Option Selection Helper
        function selectMCQOption(idx) {
            document.getElementById('mcq-selected-val').value = idx;
            for (let i = 0; i < 4; i++) {
                const btn = document.getElementById(`btn-opt-${i}`);
                if (btn) {
                    if (i === idx) {
                        btn.className = "btn bg-teal-500/20 border-teal-500 text-teal-400 rounded-xl text-xs py-3";
                    } else {
                        btn.className = "btn btn-outline border-slate-800 text-slate-300 rounded-xl text-xs py-3";
                    }
                }
            }
        }

        function playAlert() {
            const sound = document.getElementById('alert-sound');
            if (sound) {
                sound.currentTime = 0;
                sound.play().catch(e => console.log('Audio autoplay prevented'));
            }
        }

        // Blurs screen on focus loss
        window.addEventListener('blur', () => {
            document.getElementById('exam-blur-overlay').classList.add('active');
            violationCount++;
            playAlert();
            logViolation("Focus Loss", "Tab blurred, window context switched.", "high");
        });

        function resumeFocus() {
            document.getElementById('exam-blur-overlay').classList.remove('active');
        }

        // Intercept copy attempts
        document.addEventListener('copy', (e) => {
            e.preventDefault();
            violationCount++;
            playAlert();

            const cleanText = currentQuestionState.text + " " + currentQuestionState.formula;
            const poisoned = AegisSecurityEngine.generatePoisonedText(cleanText);
            
            if (e.clipboardData) {
                e.clipboardData.setData('text/plain', poisoned);
            }

            logViolation("Illegal Copy Attempt", "Triggered copy event. Poisoned payload delivered.", "high");
            
            // Mutate question instantly
            const nextSeed = AegisSecurityEngine.getCurrentSeed() + Math.floor(Math.random() * 20) + 1;
            AegisSecurityEngine.setSeed(nextSeed);
            initQuestion();
        });

        document.addEventListener('contextmenu', (e) => e.preventDefault());

        // Block keys (F12, inspect, Ctrl+U, F5, Ctrl+R)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'F12' || 
                (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'C' || e.key === 'c')) || 
                (e.ctrlKey && (e.key === 'U' || e.key === 'u')) ||
                e.key === 'F5' || 
                (e.ctrlKey && (e.key === 'R' || e.key === 'r' || e.key === 'F5'))) {
                e.preventDefault();
                logViolation("Blocked Keyboard Shortcut Attempt", `Blocked key: ${e.key}`, "medium");
            }
        });

        // Log violation details to API
        async function logViolation(type, details, severity) {
            const keystrokes = typeof AegisSecurityEngine !== 'undefined' && AegisSecurityEngine.getKeystrokeStats 
                ? AegisSecurityEngine.getKeystrokeStats() 
                : null;
                
            try {
                await fetch('api.php?action=log_violation', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + currentUser.token
                    },
                    body: JSON.stringify({
                        student_id: currentUser.id,
                        exam_code: currentExamCode,
                        violation_type: type,
                        details: details,
                        severity: severity,
                        keystroke_stats: keystrokes
                    })
                });
            } catch (e) {
                const cached = JSON.parse(localStorage.getItem('cached_violations') || '[]');
                cached.push({ type, details, severity, keystrokes, time: new Date().toISOString() });
                localStorage.setItem('cached_violations', JSON.stringify(cached));
            }
        }

        // ─── INDEXEDDB & AES-256-GCM LOCAL STORAGE ─────────────────────────────────
        const OfflineStore = {
            db: null,
            init: function() {
                return new Promise((resolve, reject) => {
                    const request = indexedDB.open("AntigravityOffline", 1);
                    request.onupgradeneeded = function(e) {
                        const db = e.target.result;
                        if (!db.objectStoreNames.contains("exams")) {
                            db.createObjectStore("exams", { keyPath: "exam_code" });
                        }
                        if (!db.objectStoreNames.contains("answers_queue")) {
                            db.createObjectStore("answers_queue", { autoIncrement: true });
                        }
                    };
                    request.onsuccess = function(e) {
                        OfflineStore.db = e.target.result;
                        resolve(true);
                    };
                    request.onerror = function(e) {
                        reject(e);
                    };
                });
            },
            saveExam: function(examCode, encryptedData) {
                return new Promise((resolve) => {
                    const tx = OfflineStore.db.transaction("exams", "readwrite");
                    const store = tx.objectStore("exams");
                    store.put({ exam_code: examCode, data: encryptedData, saved_at: Date.now() });
                    tx.oncomplete = () => resolve(true);
                });
            },
            getExam: function(examCode) {
                return new Promise((resolve) => {
                    const tx = OfflineStore.db.transaction("exams", "readonly");
                    const store = tx.objectStore("exams");
                    const req = store.get(examCode);
                    req.onsuccess = function() {
                        resolve(req.result ? req.result.data : null);
                    };
                    req.onerror = function() {
                        resolve(null);
                    };
                });
            },
            queueAnswer: function(answerData) {
                return new Promise((resolve) => {
                    const tx = OfflineStore.db.transaction("answers_queue", "readwrite");
                    const store = tx.objectStore("answers_queue");
                    store.add(answerData);
                    tx.oncomplete = () => resolve(true);
                });
            },
            getQueuedAnswers: function() {
                return new Promise((resolve) => {
                    const tx = OfflineStore.db.transaction("answers_queue", "readonly");
                    const store = tx.objectStore("answers_queue");
                    const req = store.getAll();
                    req.onsuccess = () => resolve(req.result || []);
                    req.onerror = () => resolve([]);
                });
            },
            clearQueuedAnswers: function() {
                return new Promise((resolve) => {
                    const tx = OfflineStore.db.transaction("answers_queue", "readwrite");
                    const store = tx.objectStore("answers_queue");
                    store.clear();
                    tx.oncomplete = () => resolve(true);
                });
            }
        };

        const EncryptionEngine = {
            deriveKey: async function(userId, examCode) {
                const encoder = new TextEncoder();
                const baseMaterial = encoder.encode(userId + "_" + examCode);
                const salt = encoder.encode("antigravity_salt_1620240320");
                const keyMaterial = await crypto.subtle.importKey(
                    "raw", baseMaterial, "PBKDF2", false, ["deriveBits", "deriveKey"]
                );
                return crypto.subtle.deriveKey(
                    { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
                    keyMaterial,
                    { name: "AES-GCM", length: 256 },
                    false,
                    ["encrypt", "decrypt"]
                );
            },
            encrypt: async function(plainText, key) {
                const encoder = new TextEncoder();
                const data = encoder.encode(plainText);
                const iv = crypto.getRandomValues(new Uint8Array(12));
                const ciphertext = await crypto.subtle.encrypt(
                    { name: "AES-GCM", iv: iv },
                    key,
                    data
                );
                const combined = new Uint8Array(iv.length + ciphertext.byteLength);
                combined.set(iv, 0);
                combined.set(new Uint8Array(ciphertext), iv.length);
                return btoa(String.fromCharCode.apply(null, combined));
            },
            decrypt: async function(base64Data, key) {
                const binaryStr = atob(base64Data);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                }
                const iv = bytes.slice(0, 12);
                const ciphertext = bytes.slice(12);
                const decrypted = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: iv },
                    key,
                    ciphertext
                );
                return new TextDecoder().decode(decrypted);
            }
        };

        // ─── TELEMETRY & LOGGING ───────────────────────────────────────────────────
        let timePreservationOffline = 0;

        // Timer Countdown logic with Time Preservation Option
        function startTimer() {
            const timerLabel = document.getElementById('countdown-timer');
            const interval = setInterval(() => {
                const isOnline = navigator.onLine;

                // Enforce time preservation setting if offline
                if (!isOnline && timePreservationOffline === 1) {
                    timerLabel.innerText = `${timerLabel.innerText.split(' ')[0]} (موقوف مؤقتاً 📶)`;
                    timerLabel.className = "font-mono text-yellow-500 font-bold text-sm animate-pulse";
                    return;
                }

                timerLabel.className = "font-mono text-purple-400 font-bold text-sm";
                activeSeconds++;
                saveExamState();
                const remaining = totalExamTimeLimit - activeSeconds;
                
                if (remaining <= 0) {
                    clearInterval(interval);
                    alert("انتهى وقت الاختبار المتاح!");
                    submitAnswer(true);
                } else {
                    const mins = Math.floor(remaining / 60);
                    const secs = remaining % 60;
                    timerLabel.innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                }
            }, 1000);
        }

        // Connection heartbeat handler
        function setupHeartbeat() {
            const offlineBanner = document.getElementById('offline-banner');
            
            AegisSecurityEngine.startHeartbeat(currentUser.id, currentExamCode, (status, duration) => {
                if (status === 'offline') {
                    offlineBanner.classList.remove('hidden');
                    if (!offlineTimerInterval) {
                        offlineTimerInterval = setInterval(() => {
                            totalDowntimeSeconds++;
                        }, 1000);
                    }
                } else {
                    offlineBanner.classList.add('hidden');
                    if (offlineTimerInterval) {
                        clearInterval(offlineTimerInterval);
                        offlineTimerInterval = null;
                    }
                    syncOfflineAnswers();
                }
            });
        }

        // Background Sync function
        async function syncOfflineAnswers() {
            if (!navigator.onLine) return;
            try {
                const queued = await OfflineStore.getQueuedAnswers();
                if (queued.length === 0) return;
                
                for (let item of queued) {
                    const res = await fetch('api.php?action=finish_exam', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + currentUser.token
                        },
                        body: JSON.stringify(item)
                    });
                    const data = await res.json();
                    if (data.status !== 'success') {
                        throw new Error("Sync failed");
                    }
                }
                await OfflineStore.clearQueuedAnswers();
                console.log("Synced all offline answers to backend successfully.");
            } catch (e) {
                console.log("Background Sync failed, will retry on next connection heartbeat.", e);
            }
        }

        // Submit answer logic with offline queueing
        async function submitAnswer(forced = false) {
            let ans = '';

            if (currentQuestionState.type === 'mcq') {
                ans = document.getElementById('mcq-selected-val').value;
                if (ans === '' && !forced) {
                    alert("يرجى تحديد أحد الخيارات قبل الإرسال!");
                    return;
                }
            } else {
                ans = document.getElementById('answer-input').value.trim();
                if (!ans && !forced) {
                    alert("الرجاء كتابة الحل في الحقل المخصص!");
                    return;
                }
            }

            studentAnswers.push(ans);
            totalQuestionsSolved++;

            if (currentQuestionIdx < questionsTemplates.length - 1 && !forced) {
                currentQuestionIdx++;
                saveExamState();
                initQuestion();
                return;
            }

            let integrityIndex = Math.max(0, 100 - (violationCount * 30)); // Doubled penalty for MVP

            if (currentExamCode === 'AI_PRACTICE') {
                alert(`أحسنت! تم إنهاء الاختبار التجريبي للمذاكرة.\nمؤشر النزاهة السلوكي (النزاهة): ${integrityIndex}%\nملاحظة: التصحيح يتم فقط في الخادم للاختبارات الحقيقية.`);
                window.location.href = "student_dashboard.html";
                return;
            }

            const keystrokes = typeof AegisSecurityEngine !== 'undefined' && AegisSecurityEngine.getKeystrokeStats 
                ? AegisSecurityEngine.getKeystrokeStats() 
                : null;

            const payload = {
                student_id: currentUser.id,
                exam_code: currentExamCode,
                answers: studentAnswers,
                integrity_index: integrityIndex,
                keystroke_stats: keystrokes
            };

            // Stop local proctoring
            if (typeof AegisX !== 'undefined' && AegisX.stopProtection) {
                AegisX.stopProtection();
            }

            try {
                const response = await fetch('api.php?action=finish_exam', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + currentUser.token
                    },
                    body: JSON.stringify(payload)
                });
                const data = await response.json();
                
                isExamFinished = true;
                localStorage.removeItem(`exam_state_${currentExamCode}`);
                sessionStorage.removeItem(`exam_state_${currentExamCode}`);
                let msgScore = (data.final_score !== undefined) ? `\nالدرجة النهائية: ${data.final_score}%` : '';
                alert(`تم حفظ النتيجة ومزامنتها بنجاح!${msgScore}\nمؤشر النزاهة السلوكي: ${integrityIndex}%`);
                window.location.href = "student_dashboard.html";
            } catch (e) {
                await OfflineStore.queueAnswer(payload);
                isExamFinished = true;
                localStorage.removeItem(`exam_state_${currentExamCode}`);
                sessionStorage.removeItem(`exam_state_${currentExamCode}`);
                alert("تنبيه: تم حفظ إجاباتك محلياً بشكل مشفر بسبب انقطاع الشبكة. سيتم المزامنة والتصحيح تلقائياً عند استعادة الاتصال.");
                window.location.href = "student_dashboard.html";
            }
        }

        // Start Exam Engine after pre-flight
        async function startExamEngine() {
            document.getElementById('pre-flight-check').classList.add('hidden');
            document.getElementById('exam-main-container').classList.remove('hidden');

            document.getElementById('student-name-label').innerText = `الطالب: ${currentUser.official_name} | رمز التعريف: ${currentUser.id}`;
            
            // Initialize system
            document.getElementById('exam-title').innerText = "تحميل بيانات الامتحان...";

            // Load questions
            if (currentExamCode === 'AI_PRACTICE') {
                const practiceQuestions = JSON.parse(sessionStorage.getItem('ai_practice_questions') || '[]');
                const practiceTitle = sessionStorage.getItem('ai_practice_title') || 'اختبار تجريبي مخصص بالذكاء الاصطناعي';
                if (practiceQuestions.length > 0) {
                    document.getElementById('exam-title').innerText = practiceTitle;
                    questionsTemplates = practiceQuestions;
                    const savedState = sessionStorage.getItem(`exam_state_${currentExamCode}`) || localStorage.getItem(`exam_state_${currentExamCode}`);
                    if (savedState) {
                        try {
                            const state = JSON.parse(savedState);
                            if (state.totalQuestionsSolved !== undefined) {
                                activeSeconds = parseInt(state.activeSeconds) || 0;
                                currentQuestionIdx = parseInt(state.currentQuestionIdx) || 0;
                                studentAnswers = state.studentAnswers || [];
                                totalQuestionsSolved = parseInt(state.totalQuestionsSolved) || 0;
                                audioViolationsCount = parseInt(state.audioViolationsCount) || 0;
                            }
                            violationCount = parseInt(state.violationCount) || 0;
                            if (state.seed && typeof AegisSecurityEngine !== 'undefined') AegisSecurityEngine.setSeed(state.seed);
                        } catch (e) {}
                    }
                    initQuestion();
                } else {
                    alert("عذراً، لم يتم العثور على أي أسئلة تجريبية نشطة!");
                    window.location.href = "student_dashboard.html";
                }
            } else {
                let examLoaded = false;
                
                try {
                    const response = await fetch(`api.php?action=get_exam&code=${currentExamCode}`, {
                        headers: { 'Authorization': 'Bearer ' + currentUser.token }
                    });
                    const data = await response.json();
                    
                    if (data.status === 'success' && data.exam && data.exam.questions.length > 0) {
                        document.getElementById('exam-title').innerText = data.exam.exam_title;
                        questionsTemplates = data.exam.questions;
                        timePreservationOffline = parseInt(data.exam.time_preservation_offline || 0);
                        examLoaded = true;
                    } else if (data.status === 'error') {
                        alert("رسالة من الخادم: " + (data.message || "خطأ غير معروف"));
                        window.location.href = "student_dashboard.html";
                        return;
                    }
                } catch (err) {
                    console.error("Could not load exam online:", err);
                }

                if (!examLoaded) {
                    alert("تعذر تحميل بيانات الامتحان. تأكد من الإنترنت الخاص بك، أو قد لا تكون مسجلاً في هذا الامتحان.");
                    window.location.href = "student_dashboard.html";
                    return;
                }

                const savedState = sessionStorage.getItem(`exam_state_${currentExamCode}`) || localStorage.getItem(`exam_state_${currentExamCode}`);
                if (savedState) {
                    try {
                        const state = JSON.parse(savedState);
                        if (state.totalQuestionsSolved !== undefined) {
                            activeSeconds = parseInt(state.activeSeconds) || 0;
                            currentQuestionIdx = parseInt(state.currentQuestionIdx) || 0;
                            studentAnswers = state.studentAnswers || [];
                            totalQuestionsSolved = parseInt(state.totalQuestionsSolved) || 0;
                            audioViolationsCount = parseInt(state.audioViolationsCount) || 0;
                        }
                        violationCount = parseInt(state.violationCount) || 0;
                        if (state.seed && typeof AegisSecurityEngine !== 'undefined') AegisSecurityEngine.setSeed(state.seed);
                    } catch (e) {}
                }

                initQuestion();
            }

            // Start modules
            startTimer();
            setupHeartbeat();

            // Run developer tool blocking traps
            AegisSecurityEngine.initSecurityTraps((type, desc, severity) => {
                violationCount++;
                logViolation(type, desc, severity);
                
                if (type === 'AUDIO_DETECTED') {
                    audioViolationsCount++;
                    saveExamState();
                    if (audioViolationsCount >= 3) {
                        alert('تم اكتشاف صوت غير مسموح به للمرة الثالثة. سيتم إنهاء الامتحان فوراً لحماية النزاهة.');
                        submitAnswer(true); // Force finish exam
                    } else {
                        // Use a custom DOM warning instead of alert() to prevent browser from exiting Fullscreen
                        let warnDiv = document.createElement('div');
                        warnDiv.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-xl shadow-2xl z-50 animate-bounce font-bold text-sm text-center border-2 border-white';
                        warnDiv.innerHTML = `⚠️ تحذير (${audioViolationsCount}/3): تم اكتشاف صوت أو حديث حولك.<br>احذر، بعد التحذير الثالث سيتم إغلاق الامتحان نهائياً!`;
                        document.body.appendChild(warnDiv);
                        
                        // Play alert sound if available
                        let audio = document.getElementById('alert-sound');
                        if (audio) audio.play().catch(e => {});

                        setTimeout(() => {
                            if (warnDiv && warnDiv.parentNode) {
                                warnDiv.parentNode.removeChild(warnDiv);
                            }
                        }, 5000);
                    }
                }
            });

            // Run Anti-Camera Shield
            AegisSecurityEngine.initAntiCameraShield(currentUser.official_name || currentUser.username, currentUser.id);
            
            // Fingerprint upload
            try {
                const fp = AegisSecurityEngine.getFingerprint();
                await fetch('api.php?action=register_fingerprint', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + currentUser.token
                    },
                    body: JSON.stringify(Object.assign({ student_id: currentUser.id }, fp))
                });
            } catch (e) {
                console.log("Fingerprint caching handled.");
            }

            syncOfflineAnswers();
        }

        document.addEventListener('DOMContentLoaded', () => {
            const btn = document.getElementById('btn-start-preflight');
            if (!btn) {
                console.error("زر بدء الفحص غير موجود في الصفحة!");
                return;
            }

            btn.addEventListener('click', async () => {
                console.log("تم النقر على زر بدء الامتحان");
                try {
                    // Request Fullscreen
                    if (document.documentElement.requestFullscreen) {
                        await document.documentElement.requestFullscreen();
                    } else if (document.documentElement.webkitRequestFullscreen) {
                        await document.documentElement.webkitRequestFullscreen();
                    }

                    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                        alert('المتصفح لا يدعم الوصول للميكروفون أو أنك تستخدم اتصالاً غير آمن (HTTP). يرجى التحقق من إعدادات المتصفح.');
                        return;
                    }

                    // Check microphone
                    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
                        console.log("تم الحصول على صلاحية الميكروفون");
                        // Release the test stream
                        stream.getTracks().forEach(track => track.stop());
                        
                        // Add fullscreen change listener
                        document.addEventListener('fullscreenchange', () => {
                            if (!document.fullscreenElement) {
                                alert("تم الخروج من وضع ملء الشاشة. سيتم إنهاء الامتحان فوراً لحماية النزاهة.");
                                if (typeof submitAnswer === 'function') submitAnswer(true);
                            }
                        });

                        // Start engine
                        startExamEngine();
                    }).catch(err => {
                        console.error("خطأ الميكروفون:", err);
                        alert('يجب السماح بالوصول إلى الميكروفون لبدء الامتحان.');
                    });

                } catch (e) {
                    console.error("خطأ ملء الشاشة:", e);
                    alert('حدث خطأ في محاولة الدخول لوضع ملء الشاشة. ' + e.message);
                }
            });
        });