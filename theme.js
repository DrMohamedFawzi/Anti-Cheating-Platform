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
