"""Точка входа сервера для десктоп-сборки (PyInstaller). Tauri передаёт PORT, DATABASE_URL, UPLOAD_DIR, ENV_FILE."""
import multiprocessing
import os

if __name__ == "__main__":
    multiprocessing.freeze_support()  # воркеры ProcessPool лаборатории перезапускают этот же exe
    import uvicorn

    import server

    uvicorn.run(server.app, host="127.0.0.1", port=int(os.environ.get("PORT", 8000)))
