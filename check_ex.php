<?php
$conn=new mysqli('localhost','root','','aegis_x');
$conn->set_charset('utf8');
$res=$conn->query("SELECT * FROM exams WHERE exam_title LIKE '%أساسيات الحاسوب%'");
if($row=$res->fetch_assoc()) { echo $row['questions_json']; } else { echo 'NOT FOUND'; }
?>
