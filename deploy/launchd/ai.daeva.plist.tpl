<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.daeva</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_BIN_DIR}}/node</string>
        <string>{{INSTALL_DIR}}/dist/src/cli.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{{INSTALL_DIR}}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOST</key>
        <string>{{HOST}}</string>
        <key>PORT</key>
        <string>{{PORT}}</string>
        <key>DATA_DIR</key>
        <string>{{DATA_DIR}}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>StandardOutPath</key>
    <string>{{LOG_DIR}}/daeva.log</string>
    <key>StandardErrorPath</key>
    <string>{{LOG_DIR}}/daeva.err</string>
</dict>
</plist>
