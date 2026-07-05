<?php
$url = 'http://localhost/quiz/api.php?action=get_exam&code=EXAM_537QIW';
$opts = ['http' => ['header' => "Authorization: Bearer mock_token"]];
$ctx = stream_context_create($opts);
echo file_get_contents($url, false, $ctx);
?>
