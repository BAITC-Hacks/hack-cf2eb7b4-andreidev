#!/usr/bin/env bash
# Сборка десктоп-приложения: web/dist → сервер PyInstaller'ом → установщик Tauri.
# Запуск из корня репо; пакет организаторов (data/, *.csv, environment.py …) должен лежать в корне.
# Итог: desktop/src-tauri/target/release/bundle/ (dmg на macOS, nsis/msi на Windows).
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-$(command -v python || command -v python3)}  # на маке только python3, на Windows python3 — заглушка Store

npm --prefix web ci
npm --prefix web run build

"$PY" -m pip install -r requirements.txt fastapi uvicorn "fastapi-users[sqlalchemy]" aiosqlite pyinstaller
# ponytail: catboost (~150 МБ) не берём — PRIOR_MODEL=catboost_* в десктопе недоступен, по умолчанию он выключен
"$PY" -m PyInstaller --noconfirm --onedir --name cockpit-server --paths . \
  --distpath desktop/src-tauri/sidecar --workpath desktop/src-tauri/sidecar/.build --specpath desktop/src-tauri/sidecar/.build \
  --add-data "$PWD/data:data" --add-data "$PWD/web/dist:web/dist" \
  --add-data "$PWD/customer_profile.csv:." --add-data "$PWD/tariff_dictionary.csv:." \
  --add-data "$PWD/feature_dictionary.csv:." --add-data "$PWD/submission.csv:." \
  --add-data "$PWD/agent.py:." \
  --collect-submodules uvicorn --hidden-import aiosqlite --hidden-import sqlalchemy.dialects.sqlite.aiosqlite \
  --exclude-module catboost --exclude-module psycopg \
  $([ "${OS:-}" = Windows_NT ] && echo --noconsole) \
  desktop/cockpit_server.py

cd desktop
npx --yes @tauri-apps/cli@^2 build
