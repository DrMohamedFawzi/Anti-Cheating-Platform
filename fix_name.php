<?php
$conn = new mysqli('localhost', 'root', '', 'aegis_x');
if ($conn->connect_error) {
    die("Connection failed: " . $conn->connect_error);
}
$stmt = $conn->prepare("UPDATE users SET official_name = 'محمد فوزي أبو نحلة' WHERE id = 12 OR username = 'student'");
if ($stmt) {
    $stmt->execute();
    echo "Updated rows: " . $stmt->affected_rows;
} else {
    echo "Prepare failed: " . $conn->error;
}
$conn->close();
?>
