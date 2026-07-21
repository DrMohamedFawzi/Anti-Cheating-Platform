// VisionWorker.js - Stateless Background Processing for Face Detection
// Implements "Selective Blindness" + "Auto-Exposure Defenses" (Warm-up & Cooldown)

let config = {
    minThreshold: 10,        // Minimum moving pixels to consider a human is alive
    maxThreshold: 90,        // Strict maximum moving pixels (Calibrated to 90)
    motionSensitivity: 20    // Pixel luminance difference threshold
};

let lastFrameData = null;

// Temporal Defense Variables
let startTime = 0;
const WARMUP_MS = 5000;      // 5 seconds warmup for Auto-Exposure to settle
let cooldownUntil = 0;
const COOLDOWN_MS = 7000;    // 7 seconds cooldown after any violation

self.onmessage = function(e) {
    if (e.data.type === 'SET_CONFIG') {
        config = { ...config, ...e.data.config };
        console.log("[VisionWorker] Config updated:", config);
    } else if (e.data.type === 'PROCESS_FRAME') {
        // Initialize start time on first frame
        if (startTime === 0) startTime = Date.now();
        
        analyzeFrame(e.data.imageData);
    }
};

function analyzeFrame(imageData) {
    const now = Date.now();
    
    // 1. Warm-up Defense: Ignore frames while camera hardware adjusts exposure
    if (now - startTime < WARMUP_MS) {
        return;
    }

    // 2. Cooldown Defense: Ignore frames if we recently fired a violation
    if (now < cooldownUntil) {
        return;
    }

    const data = imageData.data; 
    let totalBrightness = 0;
    let movingPixels = 0;
    let sampledPixels = 0;

    // 3. Threshold Calibration (Logical Downsampling by 20 pixels)
    // 20 pixels * 4 channels (RGBA) = 80 bytes jump
    const DOWNSAMPLE_STEP = 80;

    for (let i = 0; i < data.length; i += DOWNSAMPLE_STEP) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        
        // Fast Luminance approximation
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
        totalBrightness += lum;
        sampledPixels++;

        if (lastFrameData) {
            const diff = Math.abs(lum - lastFrameData[i]);
            if (diff > config.motionSensitivity) {
                movingPixels++;
            }
        }
        
        // Save luminance back into the array for the next frame
        data[i] = lum;
    }

    // Global Camera Cover check (Pitch black detection)
    const avgBrightness = totalBrightness / sampledPixels;
    if (avgBrightness < 10) {
        fireViolation('camera_covered');
        lastFrameData = data;
        return;
    }

    if (lastFrameData) {
        if (movingPixels < config.minThreshold) {
            // No movement: static photo or absent
            fireViolation('static');
        } else if (movingPixels > config.maxThreshold) {
            // Hyper movement: cheating, looking around
            fireViolation('excessive_motion');
        } else {
            // Normal human behavior
            self.postMessage({ type: 'STATUS', state: 'PRESENT' });
        }
    }

    lastFrameData = new Uint8ClampedArray(data);
}

function fireViolation(reason) {
    self.postMessage({ type: 'VIOLATION', reason: reason });
    cooldownUntil = Date.now() + COOLDOWN_MS; // Activate Cooldown
    lastFrameData = null; // Zeroing the memory (Fresh Baseline)
}
