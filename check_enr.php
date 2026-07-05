<?php
$conn=new mysqli('localhost','root','','aegis_x');
$res=$conn->query("SELECT * FROM enrollments");
$rows=[];
while($row=$res->fetch_assoc()) $rows[]=$row;
echo json_encode($rows);
?>
