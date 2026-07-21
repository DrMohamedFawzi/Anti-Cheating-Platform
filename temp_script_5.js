
    let activeTab = 'classes';
    let teacherClasses = [];
    let latestDashboardData = null;
    let trustChartInstance = null;
    let timelineChartInstance = null;

    // Switch between dashboard tabs
    function switchTab(tab) {
      activeTab = tab;

      const tabs = ['classes', 'requests', 'exams', 'monitoring', 'decode'];
      tabs.forEach(t => {
        const btn = document.getElementById(`tab-btn-${t}`);
        const content = document.getElementById(`tab-content-${t}`);

        if (t === tab) {
          btn.className = 'tab flex-1 text-xs font-semibold py-3 rounded-xl tab-active-academic';
          content.classList.remove('hidden');
        } else {
          btn.className = 'tab flex-1 text-xs font-semibold py-3 rounded-xl text-slate-400';
          content.classList.add('hidden');
        }
      });

      if (tab === 'classes') loadClasses();
      if (tab === 'requests') loadRequests();
      if (tab === 'exams') loadExams();
      if (tab === 'monitoring') loadMonitoringData();
    }

    function decodeLeak() {
      const text = document.getElementById('leak-text-input').value;
      const resultBox = document.getElementById('decode-result');
      if (!text) {
        alert('يرجى لصق النص أولاً');
        return;
      }

      const studentId = typeof AegisSecurityEngine !== 'undefined' ? AegisSecurityEngine.decodeZeroWidthId(text) : 'محرك الأمان غير متاح';
      resultBox.classList.remove('hidden', 'bg-red-500/10', 'border-red-500/20', 'text-red-400', 'bg-emerald-500/10', 'border-emerald-500/20', 'text-emerald-400');

      if (studentId === 'لا يوجد شفرة مضمنة' || !studentId.trim()) {
        resultBox.classList.add('bg-red-500/10', 'border-red-500/20', 'text-red-400');
        resultBox.innerHTML = '<span class="font-bold">❌ لم يتم العثور على شفرة مضمنة في هذا النص.</span>';
      } else {
        resultBox.classList.add('bg-emerald-500/10', 'border-emerald-500/20', 'text-emerald-400');
        resultBox.innerHTML = '<span class="font-bold">✅ تم العثور على الشفرة!</span><br>رقم الطالب / المعرف هو: <span class="font-black text-lg select-all">' + escapeHtml(studentId) + '</span>';
      }
    }

    // Escape text helpers
    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Create a new Class
    function handleCreateClass(e) {
      e.preventDefault();

      const input = document.getElementById('class-name-input');
      const name = input.value.trim();
      const btn = document.getElementById('create-class-btn');

      if (!name) return;
      btn.disabled = true;
      btn.innerHTML = '<span class="loading loading-spinner loading-xs mr-2"></span> جاري الإنشاء...';

      fetch('api.php?action=create_class', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + user.token
        },
        body: JSON.stringify({ class_name: name, teacher_id: user.id })
      })
        .then(res => res.json())
        .then(data => {
          if (data.status === 'success') {
            input.value = '';
            alert('تم إنشاء الفصل الدراسي بنجاح!');
            loadClasses();
          } else {
            alert('فشل الإنشاء: ' + data.message);
          }
        })
        .catch(() => alert('فشل الاتصال بالخادم.'))
        .finally(() => {
          btn.disabled = false;
          btn.innerHTML = 'إنشاء الفصل الدراسي';
        });
    }

    // Load classes belonging to teacher
    function loadClasses() {
      const grid = document.getElementById('classes-grid');

      fetch('api.php?action=get_classes&teacher_id=' + user.id, {
        headers: { 'Authorization': 'Bearer ' + user.token }
      })
        .then(res => res.json())
        .then(data => {
          if (data.status === 'success') {
            teacherClasses = data.classes || [];
            document.getElementById('stat-classes').textContent = teacherClasses.length;

            if (teacherClasses.length === 0) {
              grid.innerHTML = '<div class="col-span-full text-center py-10 text-slate-500 text-xs">لا يوجد فصول دراسية مضافة بعد. أنشئ فصلاً من النموذج أعلاه.</div>';
            } else {
              grid.innerHTML = teacherClasses.map(c => `
                <div class="card glass-panel rounded-2xl p-5 border border-slate-800 flex flex-col gap-4">
                  <div>
                    <h4 class="text-slate-100 font-bold text-sm leading-snug">${escapeHtml(c.class_name)}</h4>
                    <p class="text-[10px] text-slate-500 mt-1">تاريخ الإنشاء: ${new Date(c.created_at).toLocaleDateString('ar-SA')}</p>
                  </div>
                  <div class="bg-slate-950/60 border border-slate-900 px-3 py-2 rounded-xl flex items-center justify-between">
                    <div>
                      <span class="text-[9px] text-slate-500 block">رمز الفصل للمشاركة:</span>
                      <code class="text-xs font-mono font-bold text-teal-400">${c.class_code}</code>
                    </div>
                    <button onclick="navigator.clipboard.writeText('${c.class_code}'); alert('تم نسخ رمز الفصل الدراسي!')" class="btn btn-ghost btn-xs rounded-lg text-slate-400">نسخ</button>
                  </div>
                </div>
              `).join('');
            }
          }
        });
    }

    // Load student requests
    function loadRequests() {
      const tbody = document.getElementById('requests-tbody');

      fetch('api.php?action=get_enrollments&teacher_id=' + user.id, {
        headers: { 'Authorization': 'Bearer ' + user.token }
      })
        .then(res => res.json())
        .then(data => {
          if (data.status === 'success') {
            const reqs = data.requests || [];
            const pendingReqs = reqs.filter(r => r.status === 'pending');
            document.getElementById('stat-requests').textContent = pendingReqs.length;
            document.getElementById('stat-students').textContent = reqs.filter(r => r.status === 'approved').length;

            if (pendingReqs.length === 0) {
              tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-500">لا توجد طلبات انضمام معلقة حالياً.</td></tr>';
            } else {
              tbody.innerHTML = pendingReqs.map(r => `
                <tr class="border-b border-slate-900/60">
                  <td class="font-semibold text-slate-200">${escapeHtml(r.official_name)}</td>
                  <td class="text-slate-400 font-mono">${escapeHtml(r.username)}</td>
                  <td>${escapeHtml(r.class_name)}</td>
                  <td class="text-center space-x-1">
                    <button onclick="approveRequest(${r.id}, 'approved')" class="btn btn-xs btn-success rounded-lg">قبول</button>
                    <button onclick="approveRequest(${r.id}, 'rejected')" class="btn btn-xs btn-error rounded-lg">رفض</button>
                  </td>
                </tr>
              `).join('');
            }
          }
        });
    }

    // Approve/Reject enrollment request
    function approveRequest(reqId, status) {
      if (!confirm(status === 'approved' ? 'هل أنت متأكد من قبول انضمام الطالب؟' : 'هل أنت متأكد من رفض هذا الطلب؟')) return;

      fetch('api.php?action=approve_enrollment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + user.token
        },
        body: JSON.stringify({ request_id: reqId, status: status })
      })
        .then(res => res.json())
        .then(data => {
          if (data.status === 'success') {
            alert('تم التحديث بنجاح!');
            loadRequests();
          }
        });
    }

    // Load Exams
    function loadExams() {
      const tbody = document.getElementById('exams-tbody');

      fetch('api.php?action=get_teacher_exams&teacher_id=' + user.id, {
        headers: { 'Authorization': 'Bearer ' + user.token }
      })
        .then(res => res.json())
        .then(data => {
          const exams = data.exams || [];
          if (exams.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-500">لا يوجد اختبارات مصممة بعد. اضغط على منشئ الاختبارات بالأعلى.</td></tr>';
          } else {
            tbody.innerHTML = exams.map(e => {
              let c_name = e.class_name || '—';
              if (c_name === '—' && teacherClasses.length > 0) {
                let c_item = teacherClasses.find(c => c.id === e.class_id);
                if (c_item) c_name = c_item.class_name;
              }
              let preservationLabel = parseInt(e.time_preservation_offline) === 1
                ? '<span class="badge badge-success badge-sm text-[10px] rounded-lg">🛡️ تجميد العداد</span>'
                : '<span class="badge badge-ghost badge-sm text-[10px] rounded-lg">❌ استمرار العداد</span>';
              return `
                <tr class="border-b border-slate-900/60">
                  <td class="font-bold text-slate-200">${escapeHtml(e.exam_title)}</td>
                  <td class="font-mono text-teal-400">${e.exam_code}</td>
                  <td>${escapeHtml(c_name)}</td>
                  <td>${preservationLabel}</td>
                </tr>
              `;
            }).join('');
          }
        })
        .catch(() => {
          tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-red-500">حدث خطأ في تحميل الاختبارات.</td></tr>';
        });
    }

    // Load Live proctoring logs (Monitoring Hub)
    function loadMonitoringData() {
      const vTbody = document.getElementById('violations-tbody');
      const sTbody = document.getElementById('sessions-tbody');
      const hTbody = document.getElementById('heartbeats-tbody');

      fetch('api.php?action=get_dashboard_data', {
        headers: { 'Authorization': 'Bearer ' + user.token }
      })
        .then(res => res.json())
        .then(data => {
          if (data.status === 'success') {
            latestDashboardData = data;

            // Compute statistics dynamically
            const sessions = data.sessions || [];
            let totalIntegritySum = 0;
            let activeSessionsCount = sessions.length;
            sessions.forEach(s => {
              totalIntegritySum += (s.integrity_index !== undefined ? parseInt(s.integrity_index) : 100);
            });
            let averageIntegrity = activeSessionsCount > 0 ? Math.round(totalIntegritySum / activeSessionsCount) : 100;

            document.getElementById('integrity-gauge-text').innerText = `${averageIntegrity}%`;
            const offset = 251.2 - (251.2 * averageIntegrity / 100);
            document.getElementById('integrity-gauge-circle').setAttribute('stroke-dashoffset', offset);

            let focusLossCount = 0;
            let illegalCopyCount = 0;
            let visionAlertCount = 0;
            let automationCount = 0;

            const violations = data.violations || [];
            violations.forEach(v => {
              const type = (v.violation_type || '').toLowerCase();
              if (type.includes('focus') || type.includes('blur') || type.includes('tab')) {
                focusLossCount++;
              } else if (type.includes('copy') || type.includes('clipboard') || type.includes('illegal')) {
                illegalCopyCount++;
              } else if (type.includes('vision') || type.includes('eye') || type.includes('face') || type.includes('camera') || type.includes('lock')) {
                visionAlertCount++;
              } else if (type.includes('headless') || type.includes('automation') || type.includes('fingerprint') || type.includes('identity')) {
                automationCount++;
              }
            });

            document.getElementById('count-focus-loss').innerText = focusLossCount;
            document.getElementById('count-illegal-copy').innerText = illegalCopyCount;
            document.getElementById('count-focus-loss').innerText = focusLossCount;
            document.getElementById('count-illegal-copy').innerText = illegalCopyCount;
            document.getElementById('count-vision-alert').innerText = visionAlertCount;
            document.getElementById('count-automation-alert').innerText = automationCount;

            // ── RENDERING CHARTS (Chart.js) ──
            renderTrustScoreChart(sessions);
            renderTimelineChart(violations);

            // 1. Violations (Grouped by student to avoid name repetition)
            if (violations.length === 0) {
              vTbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-slate-500">لا توجد محاولات غش مرصودة.</td></tr>';
            } else {
              const groupedViolations = {};
              violations.forEach(v => {
                const key = `${v.student_id}_${v.exam_code}`;
                if (!groupedViolations[key]) {
                  groupedViolations[key] = {
                    official_name: v.official_name,
                    student_id: v.student_id,
                    violation_type: v.violation_type,
                    details: v.details,
                    severity: v.severity,
                    detected_at: v.detected_at || v.created_at || '—',
                    count: 0
                  };
                }
                groupedViolations[key].count++;
              });

              vTbody.innerHTML = Object.values(groupedViolations).map(v => {
                let badgeClass = v.severity === 'high' ? 'badge-red' : 'badge-amber';
                let severityLabel = v.severity === 'high' ? 'عالية الخطورة' : 'متوسطة';
                return `
                  <tr class="border-b border-slate-900/40">
                    <td class="font-semibold text-slate-200">
                      ${escapeHtml(v.official_name)}
                      <div class="text-[9px] text-slate-500 font-mono">ID: ${escapeHtml(v.student_id)}</div>
                    </td>
                    <td class="font-bold text-red-400">${escapeHtml(v.violation_type)} <span class="text-[10px] text-slate-500 font-normal">(إجمالي: ${v.count})</span></td>
                    <td class="text-slate-400">${escapeHtml(v.details || '')}</td>
                    <td class="text-center"><span class="${badgeClass}">${severityLabel}</span></td>
                    <td class="text-center text-slate-500" style="font-size:10px">${v.detected_at}</td>
                  </tr>
                `;
              }).join('');
            }

            // 2. Active Sessions
            if (sessions.length === 0) {
              sTbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-slate-500">لا توجد جلسات نشطة حالياً.</td></tr>';
            } else {
              sTbody.innerHTML = sessions.map(s => {
                let integrity = s.integrity_index !== undefined ? s.integrity_index : 100;
                let cheatProb = 100 - integrity;
                let integrityColor = integrity >= 80 ? '#10b981' : integrity >= 50 ? '#fbbf24' : '#ef4444';
                let cheatColor = cheatProb < 20 ? '#10b981' : cheatProb < 50 ? '#fbbf24' : '#ef4444';

                let statusBadge = s.status === 'completed'
                  ? '<span class="badge-emerald">مكتمل</span>'
                  : s.status === 'lockout'
                    ? '<span class="badge-red">حظر / طرد</span>'
                    : '<span class="badge-amber">نشط الآن</span>';

                let escapedName = escapeHtml(s.official_name);
                let studentId = s.student_id;
                let examCode = s.exam_code;

                // Find violations for this specific student and exam
                const studentViolations = (data.violations || []).filter(v => v.student_id == studentId && v.exam_code === examCode);
                const vCount = studentViolations.length;

                // Determine "Did he cheat?" status
                let didCheatLabel = vCount > 0
                  ? `<span class="text-red-400 font-bold">⚠️ نعم (${vCount} مخالفة)</span>`
                  : `<span class="text-emerald-400 font-bold">✅ لا (نزيه)</span>`;

                // Find cheating methods used and count each
                let methodsList = [];
                let focusCount = 0, copyCount = 0, devtoolsCount = 0, rightClickCount = 0, fpCount = 0;
                studentViolations.forEach(v => {
                  const type = (v.violation_type || '').toLowerCase();
                  if (type.includes('focus') || type.includes('blur') || type.includes('tab')) focusCount++;
                  else if (type.includes('copy') || type.includes('clipboard')) copyCount++;
                  else if (type.includes('devtools') || type.includes('console') || type.includes('inspect')) devtoolsCount++;
                  else if (type.includes('click') || type.includes('context')) rightClickCount++;
                  else if (type.includes('fingerprint') || type.includes('hardware')) fpCount++;
                });

                if (focusCount > 0) methodsList.push(`تبديل تبويب (${focusCount})`);
                if (copyCount > 0) methodsList.push(`نسخ نصوص (${copyCount})`);
                if (devtoolsCount > 0) methodsList.push(`أدوات مطورين (${devtoolsCount})`);
                if (rightClickCount > 0) methodsList.push(`زر فأرة أيمن (${rightClickCount})`);
                if (fpCount > 0) methodsList.push(`تلاعب بالبصمة (${fpCount})`);

                let methodsLabel = methodsList.length > 0
                  ? `<span class="text-[10px] text-slate-300 font-medium">${methodsList.join(' ، ')}</span>`
                  : '<span class="text-[10px] text-slate-500">—</span>';

                return `
                  <tr class="border-b border-slate-900/40 hover:bg-slate-900/10">
                    <td class="font-semibold text-slate-200">${escapedName}</td>
                    <td class="font-mono text-slate-400">${examCode}</td>
                    <td>${statusBadge}</td>
                    <td>${didCheatLabel}</td>
                    <td class="text-center font-bold" style="color:${cheatColor}">${cheatProb}%</td>
                    <td class="text-center font-bold" style="color:${integrityColor}">${integrity}%</td>
                    <td class="text-right">${methodsLabel}</td>
                    <td class="text-center">
                      <button onclick="openIntegrityReport(${studentId}, '${examCode}', '${escapedName}')" class="btn btn-outline border-teal-500/20 text-teal-400 btn-xs rounded-lg px-2">🔎 تقرير</button>
                    </td>
                  </tr>
                `;
              }).join('');
            }

            // 3. Heartbeats (Only show latest connection state per student)
            const heartbeats = data.heartbeats || [];
            if (heartbeats.length === 0) {
              hTbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-slate-500">لا توجد نبضات مسجلة.</td></tr>';
            } else {
              const latestHeartbeats = {};
              heartbeats.forEach(h => {
                const key = h.student_id;
                if (!latestHeartbeats[key]) {
                  latestHeartbeats[key] = h;
                } else {
                  const currentSec = new Date(h.detected_at).getTime();
                  const savedSec = new Date(latestHeartbeats[key].detected_at).getTime();
                  if (currentSec > savedSec) {
                    latestHeartbeats[key] = h;
                  }
                }
              });

              hTbody.innerHTML = Object.values(latestHeartbeats).map(h => {
                let statusBadge = h.status === 'online'
                  ? '<span class="text-emerald-400">📶 متصل</span>'
                  : '<span class="text-red-400">🚫 منقطع</span>';
                let time = h.detected_at || '—';
                return `
                  <tr class="border-b border-slate-900/40">
                    <td class="font-semibold text-slate-200">${escapeHtml(h.official_name)}</td>
                    <td>${statusBadge}</td>
                    <td class="text-center text-slate-400 font-mono">${h.duration_seconds}ث</td>
                    <td class="text-center text-slate-500" style="font-size:10px">${time}</td>
                  </tr>
                `;
              }).join('');
            }
          }
        });
    }

    // Chart.js renderers
    function renderTrustScoreChart(sessions) {
      const ctx = document.getElementById('trustScoreChart');
      if (!ctx) return;
      
      let high = 0, medium = 0, low = 0;
      sessions.forEach(s => {
        let score = s.integrity_index !== undefined ? parseInt(s.integrity_index) : 100;
        if (score >= 80) high++;
        else if (score >= 50) medium++;
        else low++;
      });

      if (trustChartInstance) {
        trustChartInstance.data.datasets[0].data = [high, medium, low];
        trustChartInstance.update();
      } else {
        trustChartInstance = new Chart(ctx, {
          type: 'doughnut',
          data: {
            labels: ['عالية (80-100%)', 'متوسطة (50-79%)', 'منخفضة (<50%)'],
            datasets: [{
              data: [high, medium, low],
              backgroundColor: ['#10b981', '#fbbf24', '#ef4444'],
              borderWidth: 0,
              hoverOffset: 4
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom', labels: { color: '#94a3b8', font: { family: 'Cairo' } } }
            }
          }
        });
      }
    }

    function renderTimelineChart(violations) {
      const ctx = document.getElementById('timelineChart');
      if (!ctx) return;
      
      // Group violations by hour/minute
      const timelineMap = {};
      violations.forEach(v => {
        const d = new Date(v.detected_at || v.created_at);
        if(isNaN(d.getTime())) return;
        const timeKey = d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
        timelineMap[timeKey] = (timelineMap[timeKey] || 0) + 1;
      });

      const sortedKeys = Object.keys(timelineMap).sort();
      const dataValues = sortedKeys.map(k => timelineMap[k]);

      if (timelineChartInstance) {
        timelineChartInstance.data.labels = sortedKeys;
        timelineChartInstance.data.datasets[0].data = dataValues;
        timelineChartInstance.update();
      } else {
        timelineChartInstance = new Chart(ctx, {
          type: 'line',
          data: {
            labels: sortedKeys,
            datasets: [{
              label: 'المخالفات المرصودة',
              data: dataValues,
              borderColor: '#ef4444',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              borderWidth: 2,
              fill: true,
              tension: 0.3
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148, 163, 184, 0.1)' } },
              y: { ticks: { color: '#94a3b8', stepSize: 1 }, grid: { color: 'rgba(148, 163, 184, 0.1)' }, beginAtZero: true }
            },
            plugins: {
              legend: { labels: { color: '#94a3b8', font: { family: 'Cairo' } } }
            }
          }
        });
      }
    }

    // Open Integrity Report modal for a student
    function openIntegrityReport(studentId, examCode, studentName) {
      if (!latestDashboardData) return;

      document.getElementById('rep-student-name').textContent = studentName;
      document.getElementById('rep-exam-code').textContent = examCode;

      // Find the session
      const session = (latestDashboardData.sessions || []).find(s => s.student_id == studentId && s.exam_code === examCode);
      const integrityIndex = session && session.integrity_index !== undefined ? parseInt(session.integrity_index) : 100;
      const cheatProbability = 100 - integrityIndex;

      // Update basic cards
      document.getElementById('rep-integrity-index').textContent = integrityIndex + '%';
      document.getElementById('rep-integrity-index').style.color = integrityIndex >= 80 ? '#10b981' : integrityIndex >= 50 ? '#fbbf24' : '#ef4444';

      document.getElementById('rep-cheat-prob').textContent = cheatProbability + '%';
      document.getElementById('rep-cheat-prob').style.color = cheatProbability < 20 ? '#10b981' : cheatProbability < 50 ? '#fbbf24' : '#ef4444';

      // Find violations committed by this student
      const allViolations = latestDashboardData.violations || [];
      const studentViolations = allViolations.filter(v => v.student_id == studentId && v.exam_code === examCode);

      document.getElementById('rep-violations-count').textContent = studentViolations.length + ' مخالفة';
      document.getElementById('rep-violations-count').style.color = studentViolations.length === 0 ? '#10b981' : studentViolations.length < 3 ? '#fbbf24' : '#ef4444';

      // Counts for each proctoring check
      let focusLossCount = 0;
      let copyCount = 0;
      let devtoolsCount = 0;
      let rightclickCount = 0;
      let fingerprintCount = 0;

      studentViolations.forEach(v => {
        const type = (v.violation_type || '').toLowerCase();
        if (type.includes('focus') || type.includes('blur') || type.includes('tab')) {
          focusLossCount++;
        } else if (type.includes('copy') || type.includes('clipboard')) {
          copyCount++;
        } else if (type.includes('devtools') || type.includes('console') || type.includes('inspect')) {
          devtoolsCount++;
        } else if (type.includes('click') || type.includes('context')) {
          rightclickCount++;
        } else if (type.includes('fingerprint') || type.includes('hardware')) {
          fingerprintCount++;
        }
      });

      // Update checkpoints indicators
      updateCheckStatus('check-focus-loss', focusLossCount);
      updateCheckStatus('check-copy', copyCount);
      updateCheckStatus('check-devtools', devtoolsCount);
      updateCheckStatus('check-right-click', rightclickCount);
      updateCheckStatus('check-fingerprint', fingerprintCount);

      // Check for typing pattern dynamics
      let typingAnomalyCount = 0;
      let lastStats = null;
      studentViolations.forEach(v => {
        const type = (v.violation_type || '').toLowerCase();
        if (type.includes('typing') || type.includes('keystroke') || type.includes('anomaly')) {
          typingAnomalyCount++;
        }
        if (v.keystroke_stats) {
          try {
            lastStats = typeof v.keystroke_stats === 'string' ? JSON.parse(v.keystroke_stats) : v.keystroke_stats;
          } catch (e) { }
        }
      });

      const typingEl = document.getElementById('check-typing-dynamics');
      if (typingEl) {
        if (typingAnomalyCount > 0) {
          typingEl.textContent = `🔴 انحراف بالنمط (تنبيه: ${typingAnomalyCount} مخالفة)`;
          typingEl.className = "font-bold text-red-400";
        } else if (lastStats && lastStats.avg_dwell_time > 0) {
          typingEl.textContent = `🟢 متناسق (Dwell: ${lastStats.avg_dwell_time}ث، Flight: ${lastStats.avg_flight_time}ث)`;
          typingEl.className = "font-bold text-emerald-400";
        } else {
          typingEl.textContent = "🟢 نمط طبيعي (سلوك بشري)";
          typingEl.className = "font-bold text-emerald-400";
        }
      }

      // Populate timeline of committed violations
      const vList = document.getElementById('rep-violations-list');
      if (studentViolations.length === 0) {
        vList.innerHTML = '<div class="text-center text-[10px] text-slate-500 py-6">سلوك نزيه ومستقر. لم يتم تسجيل أي مخالفات خلال الجلسة. 🟢</div>';
      } else {
        vList.innerHTML = studentViolations.map(v => {
          let badgeClass = v.severity === 'high' ? 'badge-red' : 'badge-amber';
          let severityLabel = v.severity === 'high' ? 'عالية الخطورة' : 'متوسطة';
          let time = v.detected_at || v.created_at || '—';
          return `
            <div class="bg-slate-900/40 border border-slate-900 rounded-xl p-3 text-right text-[10px] space-y-1">
              <div class="flex justify-between items-center">
                <span class="font-bold text-red-400">${escapeHtml(v.violation_type)}</span>
                <span class="text-slate-500 font-mono" style="font-size:8px">${time}</span>
              </div>
              <p class="text-slate-400">${escapeHtml(v.details || '')}</p>
              <div class="text-left mt-1"><span class="badge ${badgeClass} text-[9px] py-0.5">${severityLabel}</span></div>
            </div>
          `;
        }).join('');
      }

      document.getElementById('integrity_report_modal').showModal();
    }

    function updateCheckStatus(elementId, count) {
      const el = document.getElementById(elementId);
      if (!el) return;
      if (count > 0) {
        el.textContent = `🔴 نعم (مخالفة: ${count} مرات)`;
        el.className = "font-bold text-red-400";
      } else {
        el.textContent = "🟢 لا (سلوك نزيه)";
        el.className = "font-bold text-emerald-400";
      }
    }

    // Logout
    function handleLogout() {
      sessionStorage.removeItem('aegis_user');
      alert('تم تسجيل الخروج بنجاح.');
      window.location.href = 'index.html';
    }

    // On Load
    window.addEventListener('load', () => {
      document.getElementById('teacher-nav-name').textContent = user.official_name;
      document.getElementById('teacher-welcome-name').textContent = user.official_name;

      const now = new Date();
      document.getElementById('current-date').textContent = now.toLocaleDateString('ar-SA', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });

      // Load initial tab data
      loadClasses();
      loadRequests(); // updates count counters too
    });
  