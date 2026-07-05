const fs = require('fs');

let content = fs.readFileSync('student_exam.html', 'utf-8');

const scriptStart = content.indexOf('<script>');
const scriptEnd = content.indexOf('</script>', scriptStart);

if (scriptStart !== -1 && scriptEnd !== -1) {
    let jsCode = content.substring(scriptStart + 8, scriptEnd);
    
    const prefix = `// Exam Presenter
const examAuth = AuthGuard.protectExamRoute();
if (!examAuth) {
    throw new Error('Unauthorized');
}
const currentUser = examAuth.user;
const currentExamCode = examAuth.examCode;
`;

    jsCode = prefix + jsCode
        .replace(/let currentUser = .*/, '')
        .replace(/let currentExamCode = .*/, '')
        .replace(/if \(!currentUser\) \{/, 'if (false) {');
        
    jsCode = jsCode.replace(/seed: \(typeof AegisSecurityEngine !== 'undefined'\) \? AegisSecurityEngine\.getCurrentSeed\(\) : 1000/g, 
                            "seed: (typeof AegisSecurityEngine !== 'undefined') ? AegisSecurityEngine.getCurrentSeed() : 1000, violationCount: violationCount");
                            
    jsCode = jsCode.replace(/totalQuestionsSolved = parseInt\(state\.totalQuestionsSolved\) \|\| 0;/g, 
                            "totalQuestionsSolved = parseInt(state.totalQuestionsSolved) || 0;\n                            violationCount = parseInt(state.violationCount) || 0;");

    // Enhance penalty for violations inside the code (we will do this by regex or string replace)
    jsCode = jsCode.replace(/let integrityIndex = Math\.max\(0, 100 - \(violationCount \* 15\)\);/g,
                            "let integrityIndex = Math.max(0, 100 - (violationCount * 30)); // Doubled penalty for MVP");

    fs.writeFileSync('features/Exam/presenter/ExamPresenter.js', jsCode, 'utf-8');
    
    const newHtml = content.substring(0, scriptStart) + 
        '<script src="core/security/AuthGuard.js"></script>\n    <script src="features/Exam/presenter/ExamPresenter.js"></script>' + 
        content.substring(scriptEnd + 9);
        
    fs.writeFileSync('student_exam.html', newHtml, 'utf-8');
    console.log('Extraction and replacement successful.');
} else {
    console.log('Script tags not found.');
}
