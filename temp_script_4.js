
    const user = JSON.parse(sessionStorage.getItem('aegis_user') || 'null');
    if (!user || user.role !== 'teacher') {
      window.location.href = 'login.html';
    }
  