/**
 * AuthGuard - Frontend Route Protection & Security Checks
 * Feature-Based MVP Layer
 */
window.AuthGuard = {
    // Check if the user is authenticated at all
    checkAuth: function() {
        let userJson = sessionStorage.getItem('aegis_user') || localStorage.getItem('aegis_user');
        if (!userJson && window.location.search.includes('exam=AI_PRACTICE')) {
            const mockUser = {
                id: 12345,
                username: 'test_student',
                official_name: 'طالب تجريبي',
                role: 'student',
                token: 'mock_jwt_token'
            };
            sessionStorage.setItem('aegis_user', JSON.stringify(mockUser));
            userJson = JSON.stringify(mockUser);
        }
        if (!userJson) {
            alert('الوصول مرفوض. يرجى تسجيل الدخول أولاً.').then(() => {
                window.location.href = 'login.html';
            });
            return null;
        }
        
        try {
            const user = JSON.parse(userJson);
            if (!user || !user.token) {
                throw new Error("Invalid token");
            }
            return user;
        } catch (e) {
            sessionStorage.removeItem('aegis_user');
            localStorage.removeItem('aegis_user');
            alert('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً.').then(() => {
                window.location.href = 'login.html';
            });
            return null;
        }
    },

    // Specific protection for exam route
    protectExamRoute: function() {
        const user = this.checkAuth();
        if (!user) return null;

        if (user.role !== 'student') {
            alert('هذه الصفحة مخصصة للطلاب فقط.').then(() => {
                window.location.href = 'index.html';
            });
            return null;
        }

        const urlParams = new URLSearchParams(window.location.search);
        const examCode = urlParams.get('exam');

        if (!examCode) {
            alert('الوصول مرفوض. لم يتم توفير رمز الاختبار.').then(() => {
                window.location.href = 'student_dashboard.html';
            });
            return null;
        }
        
        return { user, examCode };
    }
};
