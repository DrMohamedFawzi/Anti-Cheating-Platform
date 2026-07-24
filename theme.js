/**
 * Aegis-X Theme Management Script - theme.js
 * Automatically applies selected theme (defaulting to light mode)
 * and injects the toggle control dynamically in the navbar.
 */

(function () {
  'use strict';

  // 1. Immediate execution to prevent layout flashes
  const savedTheme = localStorage.getItem('aegis_theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);

  // Override native browser alert with custom premium glassmorphism modal
  window.alert = function (message) {
    return new Promise((resolve) => {
      const existing = document.getElementById('aegis-custom-alert');
      if (existing) {
        existing.remove();
      }

      let type = 'info';
      const msg = String(message || '');
      if (/(نجاح|تم|بنجاح|أحسنت)/.test(msg)) {
        type = 'success';
      } else if (/(فشل|خطأ|مرفوض|حظر|حجب|unauthorized|denied)/i.test(msg)) {
        type = 'error';
      } else if (/(تنبيه|تحذير|احذر|مخالفة|انتبه|warning|strike)/i.test(msg)) {
        type = 'warning';
      }

      let iconSvg = '';
      if (type === 'success') {
        iconSvg = `<svg class="aegis-alert-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
      } else if (type === 'error') {
        iconSvg = `<svg class="aegis-alert-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
      } else if (type === 'warning') {
        iconSvg = `<svg class="aegis-alert-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
      } else {
        iconSvg = `<svg class="aegis-alert-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
      }

      const overlay = document.createElement('div');
      overlay.id = 'aegis-custom-alert';
      overlay.className = 'aegis-alert-overlay';
      overlay.innerHTML = `
        <div class="aegis-alert-box ${type}">
          <div class="aegis-alert-icon">
            ${iconSvg}
          </div>
          <div class="aegis-alert-content">
            <p class="aegis-alert-message">${msg.replace(/\n/g, '<br>')}</p>
          </div>
          <div class="aegis-alert-actions">
            <button class="aegis-alert-button" id="aegis-alert-ok-btn">موافق</button>
          </div>
        </div>
      `;

      if (document.body) {
        document.body.appendChild(overlay);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          document.body.appendChild(overlay);
        });
      }

      const btn = document.getElementById('aegis-alert-ok-btn');
      if (btn) {
        btn.focus();
        btn.addEventListener('click', () => {
          overlay.classList.add('aegis-alert-closing');
          setTimeout(() => {
            overlay.remove();
            resolve();
          }, 150);
        });
      } else {
        // Fallback if DOM button is missing
        setTimeout(() => {
          overlay.remove();
          resolve();
        }, 3000);
      }
    });
  };

  // Expose global methods
  window.applyTheme = function (theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('theme-toggle-icon');
    if (icon) {
      icon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
  };

  window.toggleTheme = function () {
    const current = localStorage.getItem('aegis_theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    localStorage.setItem('aegis_theme', next);
    window.applyTheme(next);

    // Call custom redraw handler for Chart.js if registered
    if (window.__aegisCharts && window.__aegisCharts.redraw) {
      window.__aegisCharts.redraw();
    }
  };

  // 2. Auto-inject theme button when DOM is loaded
  document.addEventListener('DOMContentLoaded', function () {
    // Look for common navbar headers
    const navbar = document.querySelector('.aegis-navbar') || 
                   document.querySelector('.navbar-glass') ||
                   document.querySelector('header');

    if (navbar) {
      // Find a flex child to insert inside
      let container = navbar.querySelector('.flex.items-center:last-child') || navbar;
      
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn btn-ghost btn-sm rounded-xl px-3 mx-2';
      toggleBtn.id = 'theme-toggle-btn';
      toggleBtn.onclick = window.toggleTheme;
      toggleBtn.title = 'تغيير المظهر (مضيء / داكن)';

      const current = localStorage.getItem('aegis_theme') || 'light';
      toggleBtn.innerHTML = `<span id="theme-toggle-icon" style="font-size: 15px; line-height: 1;">${current === 'dark' ? '☀️' : '🌙'}</span>`;

      // Insert it
      if (container === navbar) {
        navbar.appendChild(toggleBtn);
      } else {
        container.insertBefore(toggleBtn, container.firstChild);
      }
    }
  });

})();
