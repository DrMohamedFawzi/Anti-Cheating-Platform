<?php
$conn = new mysqli('localhost', 'root', '', 'aegis_x');
$res = $conn->query("SELECT questions_json FROM exams ORDER BY id DESC LIMIT 1");
$row = $res->fetch_assoc();
echo $row['questions_json'];
?>
