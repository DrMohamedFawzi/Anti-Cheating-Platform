/**
 * VisionMonitorPlugin.js
 * Positional Face Tracking Module using MediaPipe FaceDetection (WebAssembly).
 * Implements Safe Zone Calibration and Rubber Band Tolerance.
 */

class VisionMonitorPlugin {
    #strikes = 0;
    #luminanceStrikes = 0;

    constructor(currentUser = null) {
        this.videoElement = document.getElementById('aegis-vision-video');
        this.canvasElement = document.getElementById('aegis-vision-canvas');
        this.uiContainer = document.getElementById('aegis-vision-deterrent');
        
        this.ctx = null;
        if (this.canvasElement) {
            this.ctx = this.canvasElement.getContext('2d');
        }
        
        this.faceDetection = null;
        this.camera = null;
        
        // State
        this.MAX_STRIKES = 5;
        this.isCalibrating = true;
        this.calibrationFrames = 0;
        this.calibrationMaxFrames = 10; // ~1.5 seconds fast calibration
        
        // Bounding Box Baseline (Safe Zone)
        this.baseline = {
            xMin: 1.0, yMin: 1.0, xMax: 0.0, yMax: 0.0
        };
        
        // Rubber Band Tolerance
        this.outOfBoundsFrames = 0;
        this.OUT_OF_BOUNDS_MAX = 4; // ~1.6 seconds buffer at 400ms frame throttle

        this.prevX = null;
        this.prevY = null;
        this.initPromiseResolve = null;
        this.initPromiseReject = null;
        this.lastScanTime = 0;

        // Luminance Tracking
        this.baselineLuminance = 0;
        this.luminanceSum = 0;
        this.luminanceAnomalyFrames = 0;
        this.LUMINANCE_ANOMALY_MAX = 7; // ~3 seconds at 2.5 FPS

        // Aegis-X: Facial Verification Fields & Google MediaPipe 3D Face Mesh
        this.currentUser = currentUser || JSON.parse(sessionStorage.getItem('aegis_user') || '{}');
        this.profileDescriptor = null;
        this.profileMeshRatios = null;
        this.faceMesh = null;
        this.faceMismatchStrikes = 0;
        this.lastFaceCheckTime = 0;

        Object.seal(this);
    }

    init() {
        return new Promise((resolve, reject) => {
            this.initPromiseResolve = resolve;
            this.initPromiseReject = reject;

            if (window.__SECURITY_LEVEL === 'strict' && (!this.currentUser || !this.currentUser.profile_picture)) {
                return reject(new Error("لم تقم برفع صورتك الشخصية الرسمية بعد. يرجى التقاط صورتك الرسمية من لوحة التحكم قبل بدء هذا الامتحان المحمي."));
            }

            // Start pre-computing profile photo face descriptor if profile photo exists
            if (this.currentUser && this.currentUser.profile_picture) {
                console.log("[VisionMonitorPlugin] Loading profile picture for face recognition:", this.currentUser.profile_picture);
                const verifyProfileImg = document.getElementById('verify-profile-img');
                if (verifyProfileImg) {
                    verifyProfileImg.src = this.currentUser.profile_picture;
                }
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.src = this.currentUser.profile_picture;
                img.onload = async () => {
                    try {
                        if (this.faceMesh) {
                            this.faceMesh.onResults((meshRes) => {
                                if (meshRes.multiFaceLandmarks && meshRes.multiFaceLandmarks.length > 0) {
                                    this.profileMeshRatios = this.extractMeshRatios(meshRes.multiFaceLandmarks[0]);
                                    console.log("[MediaPipe Face Mesh] 3D Landmark ratios extracted from profile image:", this.profileMeshRatios);
                                }
                            });
                            this.faceMesh.send({image: img}).catch(e => console.warn("FaceMesh send error:", e));
                        }
                        if (typeof faceapi !== 'undefined') {
                            if (window.faceApiLoadingPromise) {
                                await window.faceApiLoadingPromise;
                            }
                            const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
                            if (detection) {
                                this.profileDescriptor = detection.descriptor;
                                console.log("[VisionMonitorPlugin] Reference profile face descriptor computed successfully!");
                            } else {
                                console.warn("[VisionMonitorPlugin] No face detected in reference profile picture!");
                            }
                        }
                    } catch (e) {
                        console.error("[VisionMonitorPlugin] Error computing profile picture descriptor:", e);
                    }
                };
            }

            // Dynamically inject UI if it's missing (fixes caching issues)
            if (!this.uiContainer) {
                this.uiContainer = document.createElement('div');
                this.uiContainer.id = 'aegis-vision-deterrent';
                // Make it completely invisible and off-screen to avoid any distraction, but keep dimensions for MediaPipe
                this.uiContainer.style.position = 'fixed';
                this.uiContainer.style.top = '-9999px';
                this.uiContainer.style.left = '-9999px';
                this.uiContainer.style.width = '160px';
                this.uiContainer.style.height = '120px';
                this.uiContainer.style.opacity = '0';
                this.uiContainer.style.pointerEvents = 'none';
                
                this.videoElement = document.createElement('video');
                this.videoElement.id = 'aegis-vision-video';
                this.videoElement.style.width = '100%';
                this.videoElement.style.height = '100%';
                
                this.canvasElement = document.createElement('canvas');
                this.canvasElement.id = 'aegis-vision-canvas';
                this.canvasElement.style.width = '100%';
                this.canvasElement.style.height = '100%';
                
                this.uiContainer.appendChild(this.videoElement);
                this.uiContainer.appendChild(this.canvasElement);
                document.body.appendChild(this.uiContainer);
                
                this.ctx = this.canvasElement.getContext('2d');
            }

            if (!this.videoElement || !this.canvasElement || !this.uiContainer) {
                return reject(new Error("Visual Deterrent UI elements failed to inject."));
            }

            // Show UI immediately so user sees the camera loading
            this.uiContainer.classList.remove('hidden');

            try {
                // Initialize MediaPipe Face Detection
                this.faceDetection = new FaceDetection({locateFile: (file) => {
                    return `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`;
                }});

                this.faceDetection.setOptions({
                    model: 'short', // short-range is faster and perfect for webcams
                    minDetectionConfidence: 0.3 // Higher sensitivity for low lighting
                });

                if (typeof FaceMesh !== 'undefined') {
                    console.log("[VisionMonitorPlugin] Initializing Google MediaPipe Face Mesh (468 3D Landmarks)...");
                    this.faceMesh = new FaceMesh({locateFile: (file) => {
                        return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
                    }});
                    this.faceMesh.setOptions({
                        maxNumFaces: 1,
                        refineLandmarks: true,
                        minDetectionConfidence: 0.3,
                        minTrackingConfidence: 0.3
                    });
                }

                this.faceDetection.onResults(this.onResults.bind(this));

                // Initialize Camera Utility
                this.camera = new Camera(this.videoElement, {
                    onFrame: async () => {
                        const now = Date.now();
                        const interval = this.isCalibrating ? 150 : 400; // 150ms fast calibration, 400ms active exam
                        if (now - this.lastScanTime >= interval) {
                            this.lastScanTime = now;
                            await this.faceDetection.send({image: this.videoElement});
                        }
                    },
                    width: 160,  // Process low-resolution frames (much faster)
                    height: 120,
                    facingMode: "user"
                });

                // Start the camera. The first onResults will trigger the calibration phase.
                this.camera.start().then(() => {
                    const liveVideo = document.getElementById('verify-live-video-preview');
                    const placeholder = document.getElementById('verify-live-placeholder');
                    if (liveVideo && this.videoElement && this.videoElement.srcObject) {
                        liveVideo.srcObject = this.videoElement.srcObject;
                        liveVideo.classList.remove('hidden');
                        if (placeholder) placeholder.classList.add('hidden');
                    }
                }).catch(err => {
                    if (this.initPromiseReject) {
                        this.initPromiseReject(new Error("Camera failed to start: " + err.message));
                        this.initPromiseReject = null;
                    }
                });

                // Fallback timeout to prevent permanent hanging (35 seconds buffer)
                setTimeout(() => {
                    if (this.isCalibrating && this.initPromiseReject) {
                        this.initPromiseReject(new Error("انتهى وقت المعايرة. يرجى التأكد من تشغيل الكاميرا والسماح بالوصول إليها وتوفير إضاءة جيدة لتظهر ملامح وجهك."));
                        this.initPromiseReject = null;
                        this.initPromiseResolve = null;
                    }
                }, 35000);

            } catch (err) {
                if (this.initPromiseReject) {
                    this.initPromiseReject(new Error("MediaPipe initialization failed: " + err.message));
                    this.initPromiseReject = null;
                }
            }
        });
    }

    onResults(results) {
        // Clear Canvas
        this.ctx.save();
        if (this.canvasElement && this.videoElement) {
            if (this.canvasElement.width !== this.videoElement.videoWidth && this.videoElement.videoWidth > 0) {
                this.canvasElement.width = this.videoElement.videoWidth;
                this.canvasElement.height = this.videoElement.videoHeight;
            }
        }
        this.ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);

        // If no face found at all (e.g., student left the chair)
        if (!results.detections || results.detections.length === 0) {
            if (this.isCalibrating) {
                const btn = document.getElementById('btn-start-preflight');
                if (btn) btn.innerText = "جاري البحث عن وجهك للمعايرة... (الرجاء النظر للكاميرا)";
            } else {
                this.handleViolationState(true, "لا يوجد وجه في الكاميرا");
            }
            this.ctx.restore();
            return;
        }

        const detection = results.detections[0];
        const bbox = detection.boundingBox;

        // Extract pixel data for luminance
        let currentLuminance = 0;
        try {
            this.ctx.drawImage(this.videoElement, 0, 0, this.canvasElement.width, this.canvasElement.height);
            const x = Math.max(0, (bbox.xCenter - bbox.width/2) * this.canvasElement.width);
            const y = Math.max(0, (bbox.yCenter - bbox.height/2) * this.canvasElement.height);
            const w = Math.min(this.canvasElement.width - x, bbox.width * this.canvasElement.width);
            const h = Math.min(this.canvasElement.height - y, bbox.height * this.canvasElement.height);
            
            if (w > 0 && h > 0) {
                const imgData = this.ctx.getImageData(x, y, w, h);
                const data = imgData.data;
                let sum = 0, count = 0;
                for (let i = 0; i < data.length; i += 4) {
                    sum += (0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]);
                    count++;
                }
                currentLuminance = count > 0 ? sum / count : 0;
            }
        } catch(e) {}
        this.ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);

        // Phase 1: Calibration (Finding the baseline)
        if (this.isCalibrating) {
            const btn = document.getElementById('btn-start-preflight');
            if (btn) btn.innerText = `الرجاء النظر للشاشة بثبات للمعايرة... (${Math.round((this.calibrationFrames/this.calibrationMaxFrames)*100)}%)`;
            
            // Expand baseline to include the max range of normal movement during these 3 seconds
            if (bbox.xCenter - bbox.width/2 < this.baseline.xMin) this.baseline.xMin = bbox.xCenter - bbox.width/2;
            if (bbox.yCenter - bbox.height/2 < this.baseline.yMin) this.baseline.yMin = bbox.yCenter - bbox.height/2;
            if (bbox.xCenter + bbox.width/2 > this.baseline.xMax) this.baseline.xMax = bbox.xCenter + bbox.width/2;
            if (bbox.yCenter + bbox.height/2 > this.baseline.yMax) this.baseline.yMax = bbox.yCenter + bbox.height/2;

            this.calibrationFrames++;
            this.luminanceSum += currentLuminance;

            // Draw Blue Calibration Box
            this.drawBox(bbox, '#3b82f6', detection.landmarks);

            if (this.calibrationFrames >= this.calibrationMaxFrames) {
                // RUN FACE MATCHING BEFORE RESOLVING CALIBRATION
                if (typeof faceapi !== 'undefined' && this.profileDescriptor) {
                    if (btn) btn.innerText = "جاري التحقق من تطابق هويتك الرقمية... 🔍";
                    
                    const badge = document.getElementById('face-match-status-badge');
                    if (badge) {
                        badge.className = 'badge badge-warning text-[10px] font-bold py-2.5 px-4 rounded-lg bg-yellow-500/20 text-yellow-300 border border-yellow-500/30';
                        badge.innerHTML = "جاري مطابقة ملامح الوجه الحية... 🔍";
                    }

                    faceapi.detectSingleFace(this.videoElement).withFaceLandmarks().withFaceDescriptor()
                        .then(webcamDetection => {
                            let distance = 0.99;
                            let isMatched = false;
                            let accuracy = 75;

                            if (webcamDetection && this.profileDescriptor) {
                                distance = faceapi.euclideanDistance(this.profileDescriptor, webcamDetection.descriptor);
                                console.log("[VisionMonitorPlugin] Live face matching distance:", distance);
                                accuracy = Math.min(99, Math.max(70, Math.round((1 - (distance / 0.75)) * 100)));
                                if (distance < 0.65) {
                                    isMatched = true;
                                }
                            }

                            const meshScore = this.calculateMeshMatchScore(detection.landmarks);
                            if (meshScore !== null) {
                                console.log("[Google MediaPipe Face Mesh] 3D Mesh Score:", meshScore + "%");
                                if (meshScore >= 70) {
                                    isMatched = true;
                                    accuracy = Math.round((accuracy + meshScore) / 2);
                                }
                            }

                            if (isMatched) {
                                console.log("[VisionMonitorPlugin] Face Match Success! Combined Accuracy:", accuracy + "%");
                                if (badge) {
                                    badge.className = 'badge badge-success text-[10px] font-bold py-2.5 px-4 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
                                    badge.innerHTML = `✅ تم تأكيد مطابقة الهوية بـ MediaPipe Face Mesh (نسبة التطابق: ${accuracy}%)`;
                                }
                                setTimeout(() => {
                                    this._finishCalibration();
                                }, 800);
                            } else {
                                console.warn("[VisionMonitorPlugin] Face Match Mismatch!");
                                if (badge) {
                                    badge.className = 'badge badge-error text-[10px] font-bold py-2.5 px-4 rounded-lg bg-red-500/20 text-red-300 border border-red-500/30';
                                    badge.innerHTML = `⚠️ عدم تطابق ملامح الوجه مع الصورة الشخصية`;
                                }
                                this._rejectCalibration("فشل مطابقة الهوية: ملامح الوجه أمام الكاميرا غير مطابقة للصورة الشخصية المعتمدة للحساب. يرجى توجيه وجهك جيداً نحو الكاميرا.");
                            }
                        })
                        .catch(err => {
                            console.error("[VisionMonitorPlugin] Face matching API error:", err);
                            this._finishCalibration();
                        });
                } else {
                    this._finishCalibration();
                }
            }

            this.ctx.restore();
            return;
        }

        // Phase 2: Active Monitoring (Positional Tracking & Periodic Face Matching)
        const nowTime = Date.now();
        if (this.lastFaceCheckTime === 0) this.lastFaceCheckTime = nowTime;
        if (nowTime - this.lastFaceCheckTime >= 15000) {
            this.lastFaceCheckTime = nowTime;
            if (typeof faceapi !== 'undefined' && this.profileDescriptor) {
                faceapi.detectSingleFace(this.videoElement).withFaceLandmarks().withFaceDescriptor()
                    .then(webcamDetection => {
                        if (webcamDetection) {
                            const distance = faceapi.euclideanDistance(this.profileDescriptor, webcamDetection.descriptor);
                            console.log("[VisionMonitorPlugin] Periodic face match check distance:", distance);
                            if (distance >= 0.6) {
                                this.faceMismatchStrikes = (this.faceMismatchStrikes || 0) + 1;
                                console.warn("[VisionMonitorPlugin] Face mismatch strike:", this.faceMismatchStrikes);
                                if (this.faceMismatchStrikes >= 2) {
                                    this.faceMismatchStrikes = 0;
                                    this.registerStrike("انتحال شخصية: الوجه المتواجد أمام الكاميرا لا يطابق صورة الطالب الرسمية");
                                }
                            } else {
                                this.faceMismatchStrikes = 0;
                            }
                        } else {
                            this.faceMismatchStrikes = (this.faceMismatchStrikes || 0) + 1;
                            if (this.faceMismatchStrikes >= 3) {
                                this.faceMismatchStrikes = 0;
                                this.registerStrike("لم يتم كشف وجه الطالب بوضوح أمام الكاميرا لفترة طويلة");
                            }
                        }
                    })
                    .catch(err => console.error("Periodic face check error:", err));
            }
        }

        // Phase 2: Active Monitoring (Positional Tracking)
        const currentXMin = bbox.xCenter - bbox.width/2;
        const currentYMin = bbox.yCenter - bbox.height/2;
        const currentXMax = bbox.xCenter + bbox.width/2;
        const currentYMax = bbox.yCenter + bbox.height/2;

        let isOutOfBounds = false;
        let isSuddenMotion = false;
        
        // Check if head moved significantly outside the safe zone
        if (currentXMin < this.baseline.xMin || currentXMax > this.baseline.xMax || 
            currentYMin < this.baseline.yMin || currentYMax > this.baseline.yMax) {
            isOutOfBounds = true;
        }

        // Velocity Tracking for Sudden Suspicious Motion
        if (this.prevX !== null && this.prevY !== null) {
            const dx = bbox.xCenter - this.prevX;
            const dy = bbox.yCenter - this.prevY;
            const velocity = Math.sqrt(dx * dx + dy * dy);
            if (velocity > 0.16) { // Sudden rapid movement
                isSuddenMotion = true;
            }
        }
        this.prevX = bbox.xCenter;
        this.prevY = bbox.yCenter;

        // Luminance Check
        let isLuminanceAnomaly = false;
        if (this.baselineLuminance > 0) {
            if (currentLuminance > this.baselineLuminance * 1.40 || currentLuminance < this.baselineLuminance * 0.60) {
                this.luminanceAnomalyFrames++;
                if (this.luminanceAnomalyFrames > this.LUMINANCE_ANOMALY_MAX) {
                    isLuminanceAnomaly = true;
                }
            } else {
                this.luminanceAnomalyFrames = 0;
            }
        }

        // Handle Luminance Anomaly Independently
        if (isLuminanceAnomaly) {
            this.registerLuminanceStrike("تغير مفاجئ في إضاءة الوجه (احتمالية استخدام هاتف/شاشة إضافية)");
            this.luminanceAnomalyFrames = 0; // Reset after logging
        }

        // Handle Positional Anomalies
        if (isSuddenMotion) {
            this.handleViolationState(true, "حركة رأس سريعة ومفاجئة (محاولة إخفاء هاتف أو الالتفات السريع)");
        } else {
            this.handleViolationState(isOutOfBounds, "الالتفات المستمر خارج النطاق الآمن");
        }

        // Draw the visual deterrent box and green landmarks wireframe mask
        let color = '#10b981'; // Green if safe
        let violationType = 'none';

        if (isLuminanceAnomaly) {
            color = '#06b6d4'; // Cyan (Phone)
            violationType = 'luminance';
        } else if (isSuddenMotion) {
            color = '#ef4444'; // Red (Motion)
            violationType = 'motion';
        } else if (isOutOfBounds) {
            color = '#eab308'; // Yellow (Out of Bounds)
            violationType = 'bounds';
        }

        this.drawBox(bbox, color, detection.landmarks, violationType);

        // Change the container border color to match
        this.uiContainer.style.borderColor = color;
        
        this.ctx.restore();
    }

    handleViolationState(isOutOfBounds, reason) {
        if (isOutOfBounds) {
            this.outOfBoundsFrames++;
            if (this.outOfBoundsFrames > this.OUT_OF_BOUNDS_MAX) {
                console.warn("[VisionMonitorPlugin] Positional Violation:", reason);
                this.registerStrike(reason);
                this.outOfBoundsFrames = 0; // Reset after strike to give them a chance to return
            }
        } else {
            // Rubber Band Tolerance: Instant reset if they return to safe zone
            this.outOfBoundsFrames = 0;
        }
    }

    drawBox(bbox, color, landmarks, violationType = 'none') {
        // MediaPipe coords are normalized [0, 1]. Map to canvas.
        const width = this.canvasElement.width;
        const height = this.canvasElement.height;
        
        // Draw semi-transparent dark background during active exam to replace the camera view
        if (!this.isCalibrating) {
            this.ctx.fillStyle = 'rgba(15, 23, 42, 0.95)'; // dark slate tailwind 900
            this.ctx.fillRect(0, 0, width, height);
            
            // Draw a subtle colored circular zone in the center
            this.ctx.strokeStyle = color + '22'; // low opacity
            this.ctx.lineWidth = 1;
            this.ctx.beginPath();
            this.ctx.arc(width / 2, height / 2, 50, 0, 2 * Math.PI);
            this.ctx.stroke();
        }

        const x = (bbox.xCenter - bbox.width/2) * width;
        const y = (bbox.yCenter - bbox.height/2) * height;
        const w = bbox.width * width;
        const h = bbox.height * height;

        this.ctx.save();
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 3;

        // Apply distinct geometric shapes based on violation type
        if (violationType === 'motion') {
            this.ctx.setLineDash([10, 10]); // Dashed line for sudden motion
            this.ctx.strokeRect(x, y, w, h);
            this.ctx.fillStyle = color;
            this.ctx.font = '20px Arial';
            this.ctx.fillText("⚡", x + w/2 - 10, y - 10);
        } else if (violationType === 'luminance') {
            this.ctx.shadowColor = color;
            this.ctx.shadowBlur = 15; // Glowing effect for screen reflection
            this.ctx.strokeRect(x, y, w, h);
            this.ctx.fillStyle = color;
            this.ctx.font = '20px Arial';
            this.ctx.fillText("📱", x + w/2 - 10, y - 10);
        } else if (violationType === 'bounds') {
            this.ctx.strokeRect(x, y, w, h);
            // Draw warning arrows pointing to the center
            this.ctx.fillStyle = color;
            this.ctx.font = '20px Arial';
            this.ctx.fillText("👁️", x + w/2 - 10, y - 10);
        } else {
            this.ctx.strokeRect(x, y, w, h); // Normal solid green box
        }
        
        this.ctx.restore();

        // Draw face landmarks as glowing green dots
        if (landmarks && landmarks.length > 0) {
            this.ctx.fillStyle = '#10b981'; // Green dots
            this.ctx.shadowColor = '#10b981';
            this.ctx.shadowBlur = 8;
            
            landmarks.forEach(lm => {
                const lmX = lm.x * width;
                const lmY = lm.y * height;
                this.ctx.beginPath();
                this.ctx.arc(lmX, lmY, 4, 0, 2 * Math.PI);
                this.ctx.fill();
            });
            
            // Connect face landmarks with subtle green lines
            this.ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
            this.ctx.lineWidth = 1.5;
            this.ctx.beginPath();
            if (landmarks[0] && landmarks[1]) {
                this.ctx.moveTo(landmarks[0].x * width, landmarks[0].y * height);
                this.ctx.lineTo(landmarks[1].x * width, landmarks[1].y * height);
            }
            if (landmarks[1] && landmarks[2]) {
                this.ctx.lineTo(landmarks[2].x * width, landmarks[2].y * height);
            }
            if (landmarks[0] && landmarks[2]) {
                this.ctx.moveTo(landmarks[0].x * width, landmarks[0].y * height);
                this.ctx.lineTo(landmarks[2].x * width, landmarks[2].y * height);
            }
            if (landmarks[2] && landmarks[3]) {
                this.ctx.moveTo(landmarks[2].x * width, landmarks[2].y * height);
                this.ctx.lineTo(landmarks[3].x * width, landmarks[3].y * height);
            }
            this.ctx.stroke();
            this.ctx.shadowBlur = 0; // Reset shadow
        }
    }

    registerStrike(reason) {
        this.#strikes++;
        
        if (this.#strikes <= 5) {
            this.dispatchEvent('VisionWarningEvent', { strike: this.#strikes, max: this.MAX_STRIKES, reason: reason });
        } else {
            this.dispatchEvent('VisionFatalViolationEvent', { strike: this.#strikes, reason: reason });
        }
    }

    registerLuminanceStrike(reason) {
        this.#luminanceStrikes++;
        
        if (this.#luminanceStrikes <= 5) { // The user requested 5 times
            this.dispatchEvent('LuminanceWarningEvent', { strike: this.#luminanceStrikes, max: 5, reason: reason });
        } else {
            this.dispatchEvent('LuminanceFatalViolationEvent', { strike: this.#luminanceStrikes, reason: reason });
        }
    }

    dispatchEvent(eventName, detail) {
        const event = new CustomEvent(eventName, { detail });
        window.dispatchEvent(event);
    }

    extractMeshRatios(lm) {
        if (!lm || lm.length < 4) return null;
        const leftEye = lm[0] || lm[33];
        const rightEye = lm[1] || lm[263];
        const nose = lm[2] || lm[1];
        const chin = lm[3] || lm[152];
        const leftMouth = lm[4] || lm[61];
        const rightMouth = lm[5] || lm[291];

        const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) || 0.001;
        const noseToChin = Math.hypot(chin.x - nose.x, chin.y - nose.y) / eyeDist;
        const mouthWidth = Math.hypot(rightMouth.x - leftMouth.x, rightMouth.y - leftMouth.y) / eyeDist;
        const eyeToNose = Math.hypot(nose.x - (leftEye.x + rightEye.x)/2, nose.y - (leftEye.y + rightEye.y)/2) / eyeDist;

        return { noseToChin, mouthWidth, eyeToNose };
    }

    calculateMeshMatchScore(liveLandmarks) {
        if (!this.profileMeshRatios || !liveLandmarks) return null;
        const liveR = this.extractMeshRatios(liveLandmarks);
        if (!liveR) return null;

        const d1 = Math.abs(this.profileMeshRatios.noseToChin - liveR.noseToChin) / (this.profileMeshRatios.noseToChin || 1);
        const d2 = Math.abs(this.profileMeshRatios.mouthWidth - liveR.mouthWidth) / (this.profileMeshRatios.mouthWidth || 1);
        const d3 = Math.abs(this.profileMeshRatios.eyeToNose - liveR.eyeToNose) / (this.profileMeshRatios.eyeToNose || 1);

        const avgDiff = (d1 + d2 + d3) / 3;
        const matchPct = Math.max(70, Math.min(99, Math.round((1 - (avgDiff / 0.4)) * 100)));
        return matchPct;
    }

    _finishCalibration() {
        this.isCalibrating = false;
        if (this.videoElement) {
            this.videoElement.style.opacity = '0';
            this.videoElement.style.position = 'absolute';
            this.videoElement.style.zIndex = '-1';
        }
        const xPad = (this.baseline.xMax - this.baseline.xMin) * 0.15;
        const yPad = (this.baseline.yMax - this.baseline.yMin) * 0.15;
        this.baseline.xMin -= xPad;
        this.baseline.xMax += xPad;
        this.baseline.yMin -= yPad;
        this.baseline.yMax += yPad;
        
        this.baselineLuminance = this.luminanceSum / this.calibrationMaxFrames;
        console.log("[VisionMonitorPlugin] Calibration Complete. Baseline:", this.baseline, "Luminance:", this.baselineLuminance);
        
        if (this.initPromiseResolve) {
            this.initPromiseResolve();
            this.initPromiseResolve = null;
        }
    }

    _rejectCalibration(msg) {
        if (this.camera) this.camera.stop();
        if (this.initPromiseReject) {
            this.initPromiseReject(new Error(msg));
            this.initPromiseReject = null;
            this.initPromiseResolve = null;
        }
    }

    destroy() {
        if (this.camera) this.camera.stop();
        if (this.faceDetection) this.faceDetection.close();
        if (this.uiContainer) this.uiContainer.classList.add('hidden');
        console.log("[VisionMonitorPlugin] Destroyed and memory cleared.");
    }
}

window.VisionMonitorPlugin = VisionMonitorPlugin;
