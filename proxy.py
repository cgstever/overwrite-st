import os
import re
import json
import sqlite3
import hashlib
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

# =============================================================================
# CONFIG (DO NOT MOVE YOUR LORE FILE; IT STAYS NEXT TO proxy.py)
# =============================================================================

DEBUG = True

# RP model endpoint (your main PC that actually roleplays)
REMOTE_BASE = os.environ.get("REMOTE_BASE", "http://192.168.1.62:11434/v1")

# GM/state model endpoint (local Ollama on the 10900X box)
GM_BASE = os.environ.get("GM_BASE", "http://127.0.0.1:11434/v1")
GM_MODEL = os.environ.get("GM_MODEL", "qwen2.5:7b-instruct")

LISTEN_HOST = os.environ.get("LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8000"))

# Only run GM logic when this persona is present
ACTIVE_PERSONA = os.environ.get("ACTIVE_PERSONA", "Cody")

BASE_DIR = Path(__file__).resolve().parent
RULEBOOK_PATH = Path(os.environ.get("XCHANGE_RULEBOOK", str(BASE_DIR / "x_change_world_v5.0.7.json")))
DB_PATH = Path(os.environ.get("XCHANGE_DB", str(BASE_DIR / "state.db")))

SCAN_LAST_MESSAGES = int(os.environ.get("SCAN_LAST_MESSAGES", "12"))
MAX_LORE_HITS = int(os.environ.get("MAX_LORE_HITS", "12"))
MAX_GM_CHARS = int(os.environ.get("MAX_GM_CHARS", "6000"))
HTTP_TIMEOUT = float(os.environ.get("HTTP_TIMEOUT", "300"))

# =============================================================================
# REQUIRED MARKERS / CARD HEADER EXTRACTION (YOU SAID THIS FORMAT IS FIXED)
# =============================================================================

WORLD_PERSONA_RE = re.compile(r"^X-WORLD-PERSONA:\s*(.+?)\s*$", re.MULTILINE)

# Card header lines (all cards start like this)
CARD_NAME_RE = re.compile(r"^Name:\s*(.+?)\s*$", re.MULTILINE)
CARD_SEX_RE = re.compile(r"^Sex:\s*(.+?)\s*$", re.MULTILINE)

# =============================================================================
# APP
# =============================================================================

app = FastAPI(title="Xchange GM Proxy")

# =============================================================================
# LORE LOADING (LOAD ONCE)
# =============================================================================

# We only use lore entries that have keys, so we can keyword-match them.
# The GM model interprets the content; the proxy does NOT hardcode rule behavior.
RULE_ENTRIES: List[Tuple[str, str, List[str]]] = []  # (name, content, keys_lower)

def load_rulebook() -> None:
    global RULE_ENTRIES
    if not RULEBOOK_PATH.exists():
        raise RuntimeError(f"Lore JSON not found: {RULEBOOK_PATH}")

    with open(RULEBOOK_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    entries = data.get("entries", {})
    parsed: List[Tuple[str, str, List[str]]] = []

    if isinstance(entries, dict):
        for e in entries.values():
            if not isinstance(e, dict):
                continue
            name = (e.get("name") or "").strip()
            content = (e.get("content") or "").strip()
            keys = e.get("keys") or []
            if isinstance(keys, str):
                keys = [keys]
            keys_l = [str(k).lower().strip() for k in keys if str(k).strip()]

            # only include keyword-triggerable entries
            if name and content and keys_l:
                parsed.append((name, content, keys_l))

    parsed.sort(key=lambda x: x[0].lower())
    RULE_ENTRIES = parsed

    if DEBUG:
        print(f"[INFO] Loaded lore entries: {len(RULE_ENTRIES)} from {RULEBOOK_PATH}")

load_rulebook()

# =============================================================================
# SQLITE (AUTO-MIGRATION SAFE)
# =============================================================================

def db_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn

def ensure_schema(conn: sqlite3.Connection) -> None:
    # Create table if missing (new install)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_key   TEXT PRIMARY KEY,
            world_persona TEXT NOT NULL DEFAULT '',
            chat_id       TEXT NOT NULL DEFAULT '',
            char_name     TEXT NOT NULL DEFAULT '',
            char_sex      TEXT NOT NULL DEFAULT '',
            state_json    TEXT NOT NULL DEFAULT '{}'
        )
    """)

    # Add columns if you previously had an older schema.
    cur = conn.execute("PRAGMA table_info(sessions)")
    cols = {row[1] for row in cur.fetchall()}

    def add_col(sql: str) -> None:
        conn.execute(sql)

    if "world_persona" not in cols:
        add_col("ALTER TABLE sessions ADD COLUMN world_persona TEXT NOT NULL DEFAULT ''")
    if "chat_id" not in cols:
        add_col("ALTER TABLE sessions ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''")
    if "char_name" not in cols:
        add_col("ALTER TABLE sessions ADD COLUMN char_name TEXT NOT NULL DEFAULT ''")
    if "char_sex" not in cols:
        add_col("ALTER TABLE sessions ADD COLUMN char_sex TEXT NOT NULL DEFAULT ''")
    if "state_json" not in cols:
        add_col("ALTER TABLE sessions ADD COLUMN state_json TEXT NOT NULL DEFAULT '{}'")

    conn.commit()

def default_state() -> Dict[str, Any]:
    return {
        "turn": 0,
        "stats": {},
        "active_effects": [],
        "flags": {},
        "roll_log": []
    }

def load_state(session_key: str, persona: str, chat_id: str, name: str, sex: str) -> Dict[str, Any]:
    conn = db_conn()
    ensure_schema(conn)

    row = conn.execute(
        "SELECT state_json FROM sessions WHERE session_key = ?",
        (session_key,)
    ).fetchone()

    if row and row[0]:
        try:
            state = json.loads(row[0])
            if not isinstance(state, dict):
                state = default_state()
        except Exception:
            state = default_state()
    else:
        state = default_state()
        conn.execute(
            "INSERT OR REPLACE INTO sessions(session_key, world_persona, chat_id, char_name, char_sex, state_json) "
            "VALUES(?,?,?,?,?,?)",
            (session_key, persona, chat_id, name, sex, json.dumps(state))
        )
        conn.commit()

    conn.close()
    return state

def save_state(session_key: str, persona: str, chat_id: str, name: str, sex: str, state: Dict[str, Any]) -> None:
    conn = db_conn()
    ensure_schema(conn)
    conn.execute(
        "INSERT OR REPLACE INTO sessions(session_key, world_persona, chat_id, char_name, char_sex, state_json) "
        "VALUES(?,?,?,?,?,?)",
        (session_key, persona, chat_id, name, sex, json.dumps(state))
    )
    conn.commit()
    conn.close()

# (File continues exactly as provided — no changes made.)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("proxy:app", host=LISTEN_HOST, port=LISTEN_PORT, log_level="info")
