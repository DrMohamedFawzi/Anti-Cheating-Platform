(function() {
    'use strict';
    
    const secureSessionKey = Math.random().toString(36).substring(2) + Date.now().toString(36);
    if (typeof AegisX !== 'undefined' && AegisX.registerSessionKey) {
        AegisX.registerSessionKey(secureSessionKey);
    }

// Exam Presenter
const examAuth = AuthGuard.protectExamRoute();
if (!examAuth) {
    throw new Error('Unauthorized');
}
const currentUser = examAuth.user;
const currentExamCode = examAuth.examCode;

// Vladmandic Face-API Models Preloading & Verification
let faceApiLoaded = false;
let faceApiLoadingPromise = null;

function preloadFaceApiModels() {
    if (typeof faceapi === 'undefined') {
        console.warn("face-api library not loaded yet.");
        return Promise.reject("face-api not loaded");
    }
    if (faceApiLoadingPromise) {
        return faceApiLoadingPromise;
    }
    
    console.log("Starting Face-API models pre-loading...");
    const modelUrl = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
    
    faceApiLoadingPromise = Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(modelUrl),
        faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl)
    ]).then(() => {
        faceApiLoaded = true;
        console.log("Face-API models pre-loaded successfully!");
    }).catch(err => {
        console.error("Failed to pre-load Face-API models:", err);
        throw err;
    });
    
    return faceApiLoadingPromise;
}

if (window.__SECURITY_LEVEL === 'strict') {
    setTimeout(() => {
        preloadFaceApiModels().catch(err => console.error("Error preloading face-api models:", err));
    }, 100);
}

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
        let totalExamTimeLimit = window.__PRELOADED_EXAM_DATA && window.__PRELOADED_EXAM_DATA.exam && window.__PRELOADED_EXAM_DATA.exam.duration_minutes 
                                    ? parseInt(window.__PRELOADED_EXAM_DATA.exam.duration_minutes) * 60 
                                    : 2700; // 45 minutes default
        let offlineTimerInterval = null;
        let isExamFinished = false;
        let audioViolationsCount = 0; // Track audio violations
        let flaggedQuestions = new Set();

        // Save exam state locally to prevent data loss on refresh
        function saveExamState() {
            if (isExamFinished) return;
            updateIntegrityUI();
            try {
                const state = {
                    activeSeconds,
                    currentQuestionIdx,
                    studentAnswers,
                    totalQuestionsSolved,
                    audioViolationsCount,
                    seed: (typeof AegisSecurityEngine !== 'undefined') ? AegisSecurityEngine.getCurrentSeed() : 1000,
                    violationCount: violationCount,
                    flaggedQuestions: Array.from(flaggedQuestions)
                };
                const storageKey = `exam_state_${currentExamCode}_${currentUser.id}`;
                localStorage.setItem(storageKey, JSON.stringify(state));
                sessionStorage.setItem(storageKey, JSON.stringify(state));
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
            
            // Toggle previous button visibility
            const prevBtn = document.getElementById('prev-btn');
            if (prevBtn) {
                if (currentQuestionIdx > 0) {
                    prevBtn.classList.remove('hidden');
                } else {
                    prevBtn.classList.add('hidden');
                }
            }

            if (isMCQ) {
                mathWrap.classList.add('hidden');
                mcqWrap.classList.remove('hidden');
                
                // Clear and restore MCQ selections
                document.getElementById('mcq-selected-val').value = '';
                for (let i = 0; i < 4; i++) {
                    const btn = document.getElementById(`btn-opt-${i}`);
                    if (btn) btn.className = "btn btn-outline border-slate-800 text-slate-300 rounded-xl text-xs py-3";
                }

                // Restore previous answer if any
                const prevAns = studentAnswers[currentQuestionIdx];
                if (prevAns !== undefined && prevAns !== '') {
                    selectMCQOption(parseInt(prevAns));
                }
                
                AegisSecurityEngine.drawOnCanvas('question-canvas', currentQuestionState.text, currentQuestionState.options, label, true);
            } else {
                mathWrap.classList.remove('hidden');
                mcqWrap.classList.add('hidden');
                
                // Restore previous answer if any
                const prevAns = studentAnswers[currentQuestionIdx];
                document.getElementById('answer-input').value = prevAns !== undefined ? prevAns : '';
                
                AegisSecurityEngine.drawOnCanvas('question-canvas', currentQuestionState.text, currentQuestionState.formula, label, false);
            }

            // Update button label
            const isLast = (currentQuestionIdx === questionsTemplates.length - 1);
            document.getElementById('submit-btn').innerText = isLast ? "تسليم الامتحان النهائي" : "التالي \u2190";

            // Update navigation grid
            updateNavigationGrid();
            updateBookmarkUI();

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

        function updateIntegrityUI() {
            const integrityIndex = Math.max(0, 100 - (violationCount * 30));
            const percentLabel = document.getElementById('integrity-percent');
            const statusDot = document.getElementById('proctoring-status-dot');
            if (percentLabel) {
                percentLabel.innerText = `${integrityIndex}%`;
                if (integrityIndex >= 80) {
                    percentLabel.className = "text-xs font-bold text-emerald-400";
                    if (statusDot) statusDot.className = "w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse mt-3";
                } else if (integrityIndex >= 50) {
                    percentLabel.className = "text-xs font-bold text-yellow-400";
                    if (statusDot) statusDot.className = "w-2.5 h-2.5 rounded-full bg-yellow-500 animate-pulse mt-3";
                } else {
                    percentLabel.className = "text-xs font-bold text-red-500";
                    if (statusDot) statusDot.className = "w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse mt-3";
                }
            }
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

        // Lock screen on tab switch or page hidden (for mobile and desktop)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && !isExamFinished) {
                document.getElementById('exam-blur-overlay').classList.add('active');
                violationCount++;
                playAlert();
                logViolation("Visibility Hidden", "Student switched tabs or minimized the browser app.", "high");
            }
        });

        // Prevent browser back button navigation
        history.pushState(null, null, window.location.href);
        window.addEventListener('popstate', function () {
            history.pushState(null, null, window.location.href);
            alert("غير مسموح بالرجوع للخلف أثناء تأدية الامتحان!");
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
            updateIntegrityUI();
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
                    submitAnswerFlow(true);
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

        function updateNavigationGrid() {
            const container = document.getElementById('nav-buttons-container');
            if (!container) return;
            
            container.innerHTML = '';
            questionsTemplates.forEach((q, idx) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                
                const isCurrent = (idx === currentQuestionIdx);
                const hasAnswer = (studentAnswers[idx] !== undefined && studentAnswers[idx] !== '');
                const isFlagged = flaggedQuestions.has(idx);
                
                let btnClass = "btn btn-xs rounded-lg font-bold px-3 py-1 ";
                if (isCurrent) {
                    btnClass += "btn-primary border-2 border-white text-white";
                } else if (hasAnswer && isFlagged) {
                    btnClass += "bg-emerald-500/20 border-warning text-emerald-400";
                } else if (hasAnswer) {
                    btnClass += "bg-emerald-500/20 border-emerald-500/40 text-emerald-400";
                } else if (isFlagged) {
                    btnClass += "bg-warning/20 border-warning text-warning";
                } else {
                    btnClass += "btn-outline border-slate-850 text-slate-400";
                }
                
                btn.className = btnClass;
                btn.innerText = `س ${idx + 1}${isFlagged ? ' 🚩' : ''}`;
                btn.onclick = () => jumpToQuestion(idx);
                container.appendChild(btn);
            });
        }

        function saveCurrentAnswer(forced = false) {
            let ans = '';
            if (currentQuestionState.type === 'mcq') {
                ans = document.getElementById('mcq-selected-val').value;
                if (ans === '' && !forced) {
                    return false;
                }
            } else {
                ans = document.getElementById('answer-input').value.trim();
                if (!ans && !forced) {
                    return false;
                }
            }
            studentAnswers[currentQuestionIdx] = ans;
            
            // Count total questions solved
            let solved = 0;
            for (let i = 0; i < questionsTemplates.length; i++) {
                if (studentAnswers[i] !== undefined && studentAnswers[i] !== '') {
                    solved++;
                }
            }
            totalQuestionsSolved = solved;
            saveExamState();
            return true;
        }

        function prevQuestion() {
            saveCurrentAnswer(true);
            if (currentQuestionIdx > 0) {
                currentQuestionIdx--;
                saveExamState();
                initQuestion();
            }
        }

        function nextQuestionOrSubmit() {
            saveCurrentAnswer(true);
            
            if (currentQuestionIdx < questionsTemplates.length - 1) {
                currentQuestionIdx++;
                saveExamState();
                initQuestion();
            } else {
                submitAnswerFlow();
            }
        }

        function jumpToQuestion(idx) {
            saveCurrentAnswer(true);
            currentQuestionIdx = idx;
            saveExamState();
            initQuestion();
        }

        function toggleBookmark() {
            saveCurrentAnswer(true);
            if (flaggedQuestions.has(currentQuestionIdx)) {
                flaggedQuestions.delete(currentQuestionIdx);
            } else {
                flaggedQuestions.add(currentQuestionIdx);
            }
            saveExamState();
            updateBookmarkUI();
            updateNavigationGrid();
        }

        function updateBookmarkUI() {
            const bookmarkBtn = document.getElementById('bookmark-btn');
            const bookmarkIcon = document.getElementById('bookmark-icon');
            const bookmarkText = document.getElementById('bookmark-text');
            if (!bookmarkBtn) return;

            const isFlagged = flaggedQuestions.has(currentQuestionIdx);
            if (isFlagged) {
                bookmarkBtn.className = "btn bg-warning/20 border-warning text-warning hover:bg-warning hover:text-slate-950 rounded-xl text-xs px-4 flex items-center gap-1";
                if (bookmarkIcon) bookmarkIcon.innerText = "🚩";
                if (bookmarkText) bookmarkText.innerText = "إلغاء العلامة";
            } else {
                bookmarkBtn.className = "btn btn-outline border-slate-700 text-slate-400 hover:bg-slate-800 rounded-xl text-xs px-4 flex items-center gap-1";
                if (bookmarkIcon) bookmarkIcon.innerText = "🔖";
                if (bookmarkText) bookmarkText.innerText = "وضع علامة";
            }
        }

        // Expose to window for inline onclick handlers
        window.prevQuestion = prevQuestion;
        window.nextQuestionOrSubmit = nextQuestionOrSubmit;
        window.jumpToQuestion = jumpToQuestion;
        window.toggleBookmark = toggleBookmark;
        window.updateBookmarkUI = updateBookmarkUI;
        window.selectMCQOption = selectMCQOption;

        async function submitAnswerFlow(forced = false) {
            if (!forced) {
                if (flaggedQuestions.size > 0) {
                    const confirmFlags = confirm(`تنبيه: لديك ${flaggedQuestions.size} أسئلة مميزة بعلامة لم تقم بمراجعتها بعد. هل أنت متأكد من رغبتك في التسليم النهائي؟`);
                    if (!confirmFlags) return;
                }

                let unsolvedCount = 0;
                for (let i = 0; i < questionsTemplates.length; i++) {
                    if (studentAnswers[i] === undefined || studentAnswers[i] === '') {
                        unsolvedCount++;
                    }
                }
                if (unsolvedCount > 0) {
                    const confirmSubmit = confirm(`تنبيه: لديك ${unsolvedCount} سؤال غير مجاب عليه! هل أنت متأكد من تسليم الامتحان النهائي؟`);
                    if (!confirmSubmit) return;
                } else {
                    const confirmSubmit = confirm("هل أنت متأكد من تسليم إجابات الامتحان وإنهاء المحاولة؟");
                    if (!confirmSubmit) return;
                }
            }

            let integrityIndex = Math.max(0, 100 - (violationCount * 30));

            if (currentExamCode === 'AI_PRACTICE' || (window.__PRELOADED_EXAM_DATA && window.__PRELOADED_EXAM_DATA.exam && window.__PRELOADED_EXAM_DATA.exam.exam_mode === 'mock_student')) {
                let correctCount = 0;
                for (let i = 0; i < questionsTemplates.length; i++) {
                    const q = questionsTemplates[i];
                    if (q.type === 'mcq' && q.correct_option !== undefined) {
                        if (studentAnswers[i] == q.correct_option) correctCount++;
                    }
                }
                const totalQuestions = questionsTemplates.length > 0 ? questionsTemplates.length : 1;
                const score = Math.round((correctCount / totalQuestions) * 100);
                
                alert(`أحسنت! تم إنهاء الاختبار التجريبي للمذاكرة.\nالنتيجة الذاتية: ${score}%\nمؤشر النزاهة السلوكي (النزاهة): ${integrityIndex}%\nملاحظة: التصحيح يتم فقط في الخادم للاختبارات الحقيقية (Official).`);
                isExamFinished = true;
                window.location.href = "student_dashboard.html";
                return;
            }

            const keystrokes = typeof AegisSecurityEngine !== 'undefined' && AegisSecurityEngine.getKeystrokeStats 
                ? AegisSecurityEngine.getKeystrokeStats() 
                : null;

            // Ensure no undefined values are sent
            const answersPayload = [];
            for (let i = 0; i < questionsTemplates.length; i++) {
                answersPayload[i] = studentAnswers[i] !== undefined ? studentAnswers[i] : '';
            }

            const payload = {
                student_id: currentUser.id,
                exam_code: currentExamCode,
                answers: answersPayload,
                integrity_index: integrityIndex,
                keystroke_stats: keystrokes
            };

            if (typeof AegisX !== 'undefined' && AegisX.stopProtection) {
                AegisX.stopProtection(secureSessionKey);
            }
            if (typeof window.visionPlugin !== 'undefined' && window.visionPlugin.destroy) {
                window.visionPlugin.destroy();
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
                const storageKey = `exam_state_${currentExamCode}_${currentUser.id}`;
                localStorage.removeItem(storageKey);
                sessionStorage.removeItem(storageKey);
                let msgScore = (data.final_score !== undefined) ? `\nالدرجة النهائية: ${data.final_score}%` : '';
                alert(`تم حفظ النتيجة ومزامنتها بنجاح!${msgScore}\nمؤشر النزاهة السلوكي: ${integrityIndex}%`).then(() => {
                    window.location.href = "student_dashboard.html";
                });
            } catch (e) {
                await OfflineStore.queueAnswer(payload);
                isExamFinished = true;
                const storageKey = `exam_state_${currentExamCode}_${currentUser.id}`;
                localStorage.removeItem(storageKey);
                sessionStorage.removeItem(storageKey);
                alert("تنبيه: تم حفظ إجاباتك محلياً بشكل مشفر بسبب انقطاع الشبكة. سيتم المزامنة والتصحيح تلقائياً عند استعادة الاتصال.").then(() => {
                    window.location.href = "student_dashboard.html";
                });
            }
        }

        async function startExamEngine() {
            document.getElementById('pre-flight-check').classList.add('hidden');
            document.getElementById('exam-main-container').classList.remove('hidden');

            // Enforce fullscreen during active exam
            if (window.__SECURITY_LEVEL === 'strict' || window.__SECURITY_LEVEL === 'moderate') {
                document.addEventListener('fullscreenchange', () => {
                    if (!document.fullscreenElement && !isExamFinished) {
                        alert("تم الخروج من وضع ملء الشاشة. سيتم إنهاء الامتحان فوراً لحماية النزاهة.").then(() => {
                            if (typeof submitAnswerFlow === 'function') submitAnswerFlow(true);
                        });
                    }
                });
            }

            document.getElementById('student-name-label').innerText = `الطالب: ${currentUser.official_name} | رمز التعريف: ${currentUser.id}`;
            
            // Initialize system
            document.getElementById('exam-title').innerText = "تحميل بيانات الامتحان...";

            // Load questions
            if (currentExamCode === 'AI_PRACTICE') {
                let practiceQuestions = JSON.parse(sessionStorage.getItem('ai_practice_questions') || '[]');
                let practiceTitle = sessionStorage.getItem('ai_practice_title') || 'اختبار تجريبي مخصص بالذكاء الاصطناعي';
                if (practiceQuestions.length === 0) {
                    practiceQuestions = [
                        {
                            type: 'mcq',
                            text: 'السؤال الأول: ما هي عاصمة فرنسا؟',
                            options: ['باريس', 'لندن', 'برلين', 'روما'],
                            correct_option: 0
                        },
                        {
                            type: 'math',
                            text: 'السؤال الثاني: حل المعادلة التالية:',
                            formula: 'x + 5 = 10'
                        },
                        {
                            type: 'mcq',
                            text: 'السؤال الثالث: أي مما يلي كوكب غازي عملاق؟',
                            options: ['الأرض', 'المريخ', 'المشتري', 'عطارد'],
                            correct_option: 2
                        }
                    ];
                    sessionStorage.setItem('ai_practice_questions', JSON.stringify(practiceQuestions));
                    sessionStorage.setItem('ai_practice_title', practiceTitle);
                }
                if (practiceQuestions.length > 0) {
                    document.getElementById('exam-title').innerText = practiceTitle;
                    questionsTemplates = practiceQuestions;
                    const storageKey = `exam_state_${currentExamCode}_${currentUser.id}`;
                    const savedState = sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
                    if (savedState) {
                        try {
                            const state = JSON.parse(savedState);
                            if (state.totalQuestionsSolved !== undefined) {
                                activeSeconds = parseInt(state.activeSeconds) || 0;
                                currentQuestionIdx = parseInt(state.currentQuestionIdx) || 0;
                                studentAnswers = state.studentAnswers || [];
                                totalQuestionsSolved = parseInt(state.totalQuestionsSolved) || 0;
                                audioViolationsCount = parseInt(state.audioViolationsCount) || 0;
                                flaggedQuestions = new Set(state.flaggedQuestions || []);
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
                    const data = window.__PRELOADED_EXAM_DATA || await (await fetch(`api.php?action=get_exam&code=${currentExamCode}`, {
                        headers: { 'Authorization': 'Bearer ' + currentUser.token }
                    })).json();
                    
                    if (data.status === 'success' && data.exam && data.exam.questions.length > 0) {
                        document.getElementById('exam-title').innerText = data.exam.exam_title;
                        questionsTemplates = data.exam.questions;
                        timePreservationOffline = parseInt(data.exam.time_preservation_offline || 0);
                        if (data.exam.duration_minutes) {
                            totalExamTimeLimit = parseInt(data.exam.duration_minutes) * 60;
                        }
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

                const storageKey = `exam_state_${currentExamCode}_${currentUser.id}`;
                const savedState = sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
                if (savedState) {
                    try {
                        const state = JSON.parse(savedState);
                        if (state.totalQuestionsSolved !== undefined) {
                            activeSeconds = parseInt(state.activeSeconds) || 0;
                            currentQuestionIdx = parseInt(state.currentQuestionIdx) || 0;
                            studentAnswers = state.studentAnswers || [];
                            totalQuestionsSolved = parseInt(state.totalQuestionsSolved) || 0;
                            audioViolationsCount = parseInt(state.audioViolationsCount) || 0;
                            flaggedQuestions = new Set(state.flaggedQuestions || []);
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
                    
                    // Update strikes indicator in bottom bar if it exists
                    const strikesText = document.getElementById('aegis-audio-strikes-text');
                    if (strikesText) {
                        strikesText.innerText = `الإنذارات: ${audioViolationsCount} / 5`;
                    }

                    if (audioViolationsCount >= 5) {
                        alert('تم اكتشاف صوت غير مسموح به للمرة الخامسة. سيتم إنهاء الامتحان فوراً لحماية النزاهة.').then(() => {
                            if (typeof submitAnswerFlow === 'function') submitAnswerFlow(true);
                        });
                    } else {
                        // Use a custom DOM warning instead of alert() to prevent browser from exiting Fullscreen
                        let warnDiv = document.createElement('div');
                        warnDiv.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-xl shadow-2xl z-50 animate-bounce font-bold text-sm text-center border-2 border-white';
                        warnDiv.innerHTML = `⚠️ تحذير (${audioViolationsCount}/5): تم اكتشاف صوت أو حديث حولك.<br>احذر، بعد التحذير الخامس سيتم إغلاق الامتحان نهائياً!`;
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

            // Run Anti-Camera Shield (Moire + Spotlight)
            if (typeof AegisSecurityEngine !== 'undefined' && typeof AegisSecurityEngine.initAntiCameraShield === 'function') {
                AegisSecurityEngine.initAntiCameraShield(currentUser.official_name || currentUser.username, currentUser.id);
            }

            // Isolated Vision Monitoring Module (Initialized during preflight)
            // Listeners are setup here
            if (typeof window.visionPlugin !== 'undefined') {

                window.addEventListener('VisionWarningEvent', (e) => {
                    violationCount++;
                    const reasonDesc = e.detail.reason || "الالتفات المستمر";
                    logViolation("Vision Warning", `حصل الطالب على إنذار بصري (${e.detail.strike}/${e.detail.max}) بسبب: ${reasonDesc}`, "medium");
                    let warnDiv = document.createElement('div');
                    warnDiv.className = 'fixed top-20 left-1/2 transform -translate-x-1/2 bg-yellow-600 text-white px-6 py-3 rounded-xl shadow-2xl z-[9999] font-bold text-sm text-center border-2 border-white';
                    warnDiv.innerHTML = `⚠️ تنبيه بصري (${e.detail.strike}/${e.detail.max}): ${reasonDesc}! يرجى الالتزام!`;
                    document.body.appendChild(warnDiv);
                    setTimeout(() => { if (warnDiv.parentNode) warnDiv.parentNode.removeChild(warnDiv); }, 3000);
                });

                window.addEventListener('VisionTemporaryLockEvent', (e) => {
                    violationCount++;
                    const reasonDesc = e.detail.reason || "تكرار المخالفة البصرية";
                    logViolation("Vision Lockout", `تم قفل شاشة الامتحان مؤقتاً بسبب: ${reasonDesc} (الإنذار الثالث).`, "high");
                    let lockOverlay = document.createElement('div');
                    lockOverlay.className = 'fixed inset-0 bg-red-900/95 z-[10000] flex flex-col items-center justify-center text-white';
                    lockOverlay.innerHTML = `
                        <h1 class="text-4xl font-bold mb-4">تم إيقاف الامتحان مؤقتاً</h1>
                        <p class="text-xl">تم رصد مخالفة بصرية متكررة (الإنذار ${e.detail.strike}). يرجى إبعاد أي أجهزة وتثبيت نظرك على الشاشة.</p>
                        <p class="mt-8 text-2xl font-mono bg-black/50 px-6 py-3 rounded-xl" id="vision-lock-timer">30</p>
                    `;
                    document.body.appendChild(lockOverlay);
                    
                    let timeLeft = 30;
                    let lockInterval = setInterval(() => {
                        timeLeft--;
                        let timerEl = document.getElementById('vision-lock-timer');
                        if (timerEl) timerEl.innerText = timeLeft;
                        if (timeLeft <= 0) {
                            clearInterval(lockInterval);
                            if (lockOverlay.parentNode) lockOverlay.parentNode.removeChild(lockOverlay);
                        }
                    }, 1000);
                });

                window.addEventListener('VisionFatalViolationEvent', (e) => {
                    violationCount++;
                    const reasonDesc = e.detail.reason || "الحد الأقصى للمخالفات البصرية";
                    logViolation("Vision Fatal Violation", `إنهاء الامتحان قسرياً لتخطي الحد الأقصى بسبب: ${reasonDesc}.`, "high");
                    alert('تم اكتشاف مخالفة بصرية قاتلة (الحد الأقصى). سيتم إنهاء الامتحان فوراً.').then(() => {
                        if (typeof submitAnswerFlow === 'function') submitAnswerFlow(true);
                    });
                });

                // --- NEW LUMINANCE (PHONE REFLECTION) SEPARATE EVENTS ---
                window.addEventListener('LuminanceWarningEvent', (e) => {
                    violationCount++;
                    const reasonDesc = e.detail.reason || "تغير مفاجئ في إضاءة الوجه";
                    logViolation("Luminance Violation", `إنذار استخدام شاشة إضافية (${e.detail.strike}/${e.detail.max}): ${reasonDesc}`, "high");
                    let warnDiv = document.createElement('div');
                    warnDiv.className = 'fixed top-36 left-1/2 transform -translate-x-1/2 bg-cyan-700 text-white px-6 py-3 rounded-xl shadow-2xl z-[9999] font-bold text-sm text-center border-2 border-cyan-300 animate-pulse';
                    warnDiv.innerHTML = `📱 تحذير إضاءة (${e.detail.strike}/${e.detail.max}): تم رصد انعكاس شاشة هاتف على وجهك! يرجى إبعاده فوراً.`;
                    document.body.appendChild(warnDiv);
                    
                    // Flash the screen slightly blue
                    let flashOverlay = document.createElement('div');
                    flashOverlay.className = 'fixed inset-0 bg-cyan-500/20 z-[9998] pointer-events-none transition-opacity duration-1000';
                    document.body.appendChild(flashOverlay);

                    setTimeout(() => { 
                        if (warnDiv.parentNode) warnDiv.parentNode.removeChild(warnDiv); 
                        if (flashOverlay.parentNode) flashOverlay.parentNode.removeChild(flashOverlay);
                    }, 4000);
                });

                window.addEventListener('LuminanceFatalViolationEvent', (e) => {
                    violationCount++;
                    const reasonDesc = e.detail.reason || "الحد الأقصى لمخالفات الشاشات الإضافية";
                    logViolation("Luminance Fatal Violation", `إنهاء الامتحان قسرياً لاستخدام هاتف: ${reasonDesc}.`, "high");
                    alert('📱 تم التأكد من استخدام شاشة خارجية/هاتف بشكل متكرر. سيتم إنهاء الامتحان فوراً.').then(() => {
                        if (typeof submitAnswerFlow === 'function') submitAnswerFlow(true);
                    });
                });
            }
            
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

        function attachPreflightListener() {
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

                    if (window.__SECURITY_LEVEL !== 'off') {
                        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                            alert('عذراً، المتصفح يحجب الكاميرا والمايكروفون لأنك تستخدم اتصالاً غير آمن (HTTP) أو متصفح قديم. للوصول للاختبار، يرجى استخدام (localhost) أو تفعيل شهادة SSL (HTTPS).');
                            const btn = document.getElementById('btn-start-preflight');
                            if (btn) btn.innerText = "فشل بدء الامتحان: صلاحيات مفقودة";
                            return;
                        }

                        // Request both Audio and Video together to trigger a unified prompt
                        const constraints = window.__SECURITY_LEVEL === 'strict' 
                            ? { audio: true, video: true } 
                            : { audio: true };

                        navigator.mediaDevices.getUserMedia(constraints).then(stream => {
                            console.log("تم الحصول على صلاحيات الأجهزة بنجاح");
                            // Release the test stream
                            stream.getTracks().forEach(track => track.stop());
                            
                            startSecurityEngine();
                        }).catch(err => {
                            console.error("خطأ الأذونات:", err);
                            alert('يجب السماح بالوصول إلى الكاميرا والمايكروفون لبدء الامتحان المحمي. الرجاء التحقق من إعدادات المتصفح وإعادة المحاولة.\n\nالخطأ: ' + err.message);
                            const btn = document.getElementById('btn-start-preflight');
                            if (btn) {
                                btn.innerText = "صلاحيات مفقودة - انقر لإعادة المحاولة";
                                btn.disabled = false;
                            }
                        });
                    } else {
                        startSecurityEngine(); // Skip checks
                    }

                    function startSecurityEngine() {
                        try {

                            // Start engine
                            const btn = document.getElementById('btn-start-preflight');
                            if (btn) {
                                btn.innerText = "جاري تحميل درع الحماية المكانية (الذكاء الاصطناعي)...";
                                btn.disabled = true;
                                btn.classList.add('loading');
                            }

                            if (typeof VisionMonitorPlugin !== 'undefined') {
                                window.visionPlugin = new VisionMonitorPlugin(currentUser);
                                window.visionPlugin.init().then(() => {
                                    startExamEngine();
                                }).catch(e => {
                                    console.error("Vision Init Error:", e);
                                    alert("فشل تحميل الذكاء الاصطناعي: " + (e.message || ''));
                                    if (btn) {
                                        btn.innerText = "فشل التحميل - انقر لإعادة المحاولة";
                                        btn.disabled = false;
                                        btn.classList.remove('loading');
                                    }
                                });
                            } else {
                                startExamEngine();
                            }
                        } catch (internalErr) {
                            console.error("Internal Preflight Error:", internalErr);
                            alert("حدث خطأ داخلي أثناء تحميل الامتحان: " + internalErr.message);
                        }
                    }

                } catch (e) {
                    console.error("خطأ ملء الشاشة:", e);
                    alert('حدث خطأ في محاولة الدخول لوضع ملء الشاشة. ' + e.message);
                }
            });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', attachPreflightListener);
        } else {
            attachPreflightListener();
        }
})();