[Unit]
Description=Daeva GPU Pod Orchestrator
After=default.target

[Service]
Type=simple
WorkingDirectory={{INSTALL_DIR}}
Environment=PATH={{NODE_BIN_DIR}}:/usr/local/bin:/usr/bin:/bin
Environment=HOST={{HOST}}
Environment=PORT={{PORT}}
Environment=DATA_DIR={{DATA_DIR}}
ExecStart={{NODE_BIN_DIR}}/node {{INSTALL_DIR}}/dist/src/cli.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
