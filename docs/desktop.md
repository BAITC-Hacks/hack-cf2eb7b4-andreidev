# Десктоп-приложение (macOS и Windows)

Campaign Cockpit собирается в офлайн-приложение на [Tauri v2](https://tauri.app). Docker, Postgres и Python у пользователя не нужны: внутри установщика лежат сервер, собранный фронт, агент и данные кейса.

## Как устроено
```
Campaign Cockpit.app / .exe (Tauri, desktop/src-tauri)
  │ запускает на свободном порту 127.0.0.1
  ▼
cockpit-server (PyInstaller: server.py + agent.py + lab.py + data/ + web/dist)
  │
  ▼
SQLite cockpit.db в каталоге данных приложения
```
- `desktop/src-tauri/src/main.rs` — оболочка. Выбирает свободный порт, запускает `cockpit-server` и показывает заставку (`desktop/splash/`), пока сервер не откроет порт. Затем окно переходит на `http://127.0.0.1:<порт>`. Фронт и API на одном origin, поэтому вход по cookie работает как в браузере. CSV плана сохраняется в «Загрузки». При выходе оболочка гасит сервер вместе с воркерами лаборатории.
- `desktop/cockpit_server.py` — точка входа сервера для PyInstaller: `freeze_support()` для ProcessPool лаборатории и uvicorn.
- Хранилище — тот же `db.py`, но с `DATABASE_URL=sqlite:///…`: JSON-колонки и upsert работают на обоих диалектах. Docker и dev-режим остаются на Postgres.

## Каталог данных
| ОС | Путь |
|---|---|
| macOS | `~/Library/Application Support/ru.beeline.cockpit/` |
| Windows | `%APPDATA%\ru.beeline.cockpit\` |

Что там лежит:
- `cockpit.db` — пользователи, сессии, версии лаборатории, база знаний;
- `uploads/` — загруженные выгрузки;
- `server.log` — лог сервера; смотреть первым, если приложение висит на заставке;
- `.env` — настройки, кладёте сами, формат как в [configuration.md](configuration.md).

Пример `.env` для LLM-эксперта:
```bash
OPENROUTER_API_KEY=...        # или OPENAI_API_KEY=...
AUTH_USERS=boss@corp.ru:пароль:manager   # свои пользователи; действует на пустой базе (удалите cockpit.db)
```
Вход по умолчанию — демо-пользователи из [README](../README.md#вход) (`AUTH_DEMO=1`). Это безопасно, потому что сервер слушает только `127.0.0.1`.

## Ограничения
- **Promote** в лаборатории отключён: `agent.py` внутри приложения только для чтения, API вернёт 400. Оценка версий, ремедиация и gate работают.
- **CatBoost** в сборку не входит, это экономит ~150 МБ. Режимы `PRIOR_MODEL=catboost_*` недоступны, по умолчанию они и так выключены.
- **Подписи нет.** macOS: первый запуск через правый клик → «Открыть», или `xattr -cr "/Applications/Campaign Cockpit.app"`. Windows: SmartScreen → «Подробнее» → «Выполнить в любом случае».
- Сборка под macOS — только Apple Silicon (arm64). Intel добавляется строкой `macos-13` в матрице workflow.
- Размер: `.dmg` ~145 МБ, в распакованном виде ~410 МБ (pandas, numpy, данные кейса).

## Сборка
Нужны Python 3.13, Node 22 и Rust (stable, `rustup`). Пакет организаторов должен лежать в корне репо (шаг 1 быстрого старта в README).

**macOS** — локально:
```bash
bash desktop/build.sh
```
Результат: `desktop/src-tauri/target/release/bundle/dmg/Campaign Cockpit_<версия>_aarch64.dmg` и `bundle/macos/Campaign Cockpit.app`.

**Windows** — та же команда в Git Bash на Windows-машине. Результат: `bundle/nsis/*.exe` (установщик) и `bundle/msi/*.msi`. С мака Windows-сборку сделать нельзя.

**GitHub Actions** (`.github/workflows/desktop.yml`) собирает обе версии: запуск вручную (Actions → desktop → Run workflow) или по тегу `v*`. Установщики появляются в артефактах прогона `campaign-cockpit-macOS` и `campaign-cockpit-Windows`. Пакета организаторов в git нет, поэтому CI берёт его архивом из релиза `participant-pkg` этого репо. Релиз заводится один раз:
```bash
tar czf participant-pkg.tar.gz data customer_profile.csv feature_dictionary.csv tariff_dictionary.csv \
  environment.py mock_environment.py scoring_core.py agent_template.py local_eval.py make_submission.py
gh release create participant-pkg participant-pkg.tar.gz --title "Пакет организаторов (для сборки CI)" --notes ""
```

`desktop/build.sh` делает четыре шага:
1. `npm ci && npm run build` в `web/`;
2. ставит pip-зависимости и PyInstaller;
3. `PyInstaller --onedir` → `desktop/src-tauri/sidecar/cockpit-server/`;
4. `tauri build`: sidecar попадает в ресурсы приложения как `server/`.

Иконки в `desktop/src-tauri/icons/` сгенерированы из `web/public/favicon.svg`. Пересобрать: `cd desktop && npx @tauri-apps/cli@^2 icon ../web/public/favicon.svg` (мобильные иконки после этого удалить).
