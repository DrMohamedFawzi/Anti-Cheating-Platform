// features/Cyber_Overwatch/presenter/OverwatchPresenter.js

const OverwatchPresenter = {
    init: function() {
        // Authenticate (Secret route requires admin logic, but for MVP we just check auth)
        const user = AuthGuard.checkAuth();
        if (!user || user.role === 'student') {
            alert('SECURITY CLEARANCE REQUIRED. ACCESS DENIED.').then(() => {
                window.location.href = '../../index.html';
            });
            return;
        }

        this.token = user.token;
        this.loadThreats();
        // Auto-refresh every 10 seconds
        setInterval(() => this.loadThreats(), 10000);
    },

    loadThreats: function() {
        fetch('../../api.php?action=get_threats', {
            headers: { 'Authorization': 'Bearer ' + this.token }
        })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                this.renderThreats(data.threats || []);
                this.renderBannedIPs(data.banned_ips || []);
            }
        })
        .catch(e => console.error("Error loading threats:", e));
    },

    renderThreats: function(threats) {
        document.getElementById('stat-total-attacks').textContent = threats.length;
        
        const tbody = document.getElementById('threats-tbody');
        if (threats.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center py-10 text-slate-600">No threats detected yet.</td></tr>';
            return;
        }

        let vectors = {};

        tbody.innerHTML = threats.map(t => {
            // Count vectors
            vectors[t.attack_type] = (vectors[t.attack_type] || 0) + 1;

            const unmaskedIdentity = t.user_id 
                ? `<span class="text-emerald-400 font-bold">${this.escapeHtml(t.official_name)}</span> <br><span class="text-[9px] text-slate-500">Internal Threat (ID: ${t.user_id})</span>`
                : `<span class="text-slate-500">UNKNOWN (External Attacker)</span>`;

            return `
            <tr class="border-b border-red-900/20 hover:bg-red-950/20">
                <td class="py-3">${unmaskedIdentity}</td>
                <td class="text-red-400 font-bold">${this.escapeHtml(t.ip_address)}</td>
                <td class="text-orange-400">${this.escapeHtml(t.attack_type)}</td>
                <td class="text-slate-400 text-[10px] break-all max-w-xs">${this.escapeHtml(t.payload)}</td>
                <td class="text-slate-500 text-[10px]">${t.created_at}</td>
            </tr>
            `;
        }).join('');

        // Render Vectors
        const vecList = document.getElementById('attack-vectors-list');
        vecList.innerHTML = Object.keys(vectors).map(v => 
            `<li class="flex justify-between items-center">
                <span>${this.escapeHtml(v)}</span>
                <span class="bg-red-900/50 text-red-400 px-2 py-0.5 rounded text-[10px]">${vectors[v]}</span>
            </li>`
        ).join('');
    },

    renderBannedIPs: function(banned) {
        const list = document.getElementById('banned-ips-list');
        if (banned.length === 0) {
            list.innerHTML = '<li>No banned IPs.</li>';
            return;
        }

        list.innerHTML = banned.map(b => `
            <li class="flex justify-between items-center py-2 border-b border-slate-800">
                <div>
                    <span class="text-red-400 block">${this.escapeHtml(b.ip_address)}</span>
                    <span class="text-[9px] text-slate-500">Until: ${b.banned_until}</span>
                </div>
                <button onclick="OverwatchPresenter.unbanIp('${this.escapeHtml(b.ip_address)}')" class="btn btn-xs bg-emerald-900/50 text-emerald-400 border-emerald-500 hover:bg-emerald-500 hover:text-white rounded">UNBAN</button>
            </li>
        `).join('');
    },

    unbanIp: function(ip) {
        if (!confirm(`Are you sure you want to unban IP: ${ip}?`)) return;

        fetch('../../api.php?action=unban_ip', {
            method: 'POST',
            headers: { 
                'Authorization': 'Bearer ' + this.token,
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ ip_address: ip })
        })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                alert('IP Unbanned successfully.');
                this.loadThreats();
            } else {
                alert('Failed to unban: ' + data.message);
            }
        });
    },

    exportReport: function() {
        alert("Exporting PDF Evidence Report... (Simulated for MVP)");
        window.print(); // Quick hack for MVP
    },

    escapeHtml: function(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
};

window.addEventListener('load', () => {
    OverwatchPresenter.init();
});
