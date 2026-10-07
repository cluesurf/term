"""A small Qt6 window with two push buttons and a text field, for the Qt side of the find drivers.
Run as `find-linux-qt` inside the session (QT_LINUX_ACCESSIBILITY_ALWAYS_ON is already set there).
"""
import sys

from PyQt6.QtWidgets import QApplication, QLineEdit, QPushButton, QVBoxLayout, QWidget

app = QApplication(sys.argv)
app.setApplicationName("find-linux-qt")
window = QWidget()
window.setWindowTitle("find-linux-qt")
layout = QVBoxLayout(window)
field = QLineEdit()
field.setAccessibleName("name")
layout.addWidget(field)
ok = QPushButton("OK")
ok.clicked.connect(lambda: field.setText("clicked"))
layout.addWidget(ok)
layout.addWidget(QPushButton("Cancel"))
window.show()
sys.exit(app.exec())
