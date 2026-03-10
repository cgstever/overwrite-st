"""
proxy.py — Xchange Proxy  v7.0.0
Pure infrastructure: HTTP routing, session DB, chat ID detection, lore loading.
Zero lore logic — all processing delegated to the lore module.
"""

import os, re, json, sqlite3, hashlib, importlib.util, uvicorn
from pathlib import Path
from typing import Any, Dict, Optional

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

DEBUG         = True
PROXY_VERSION = '7.1.0'

REMOTE_BASE   = os.environ.get('REMOTE_BASE',    'http://192.168.1.62:11434/v1').rstrip('/')
LISTEN_HOST   = os.environ.get('LISTEN_HOST',    '0.0.0.0')
LISTEN_PORT   = int(os.environ.get('LISTEN_PORT', '8000'))
ST_CHATS_PATH = os.environ.get('ST_CHATS_PATH',  r'H:\sillytavern\data\cody\chats')

BASE_DIR     = Path(__file__).resolve().parent
DB_PATH      = Path(os.environ.get('XCHANGE_DB',   str(BASE_DIR / 'state.db')))
MAX_INJECT   = int(os.environ.get('MAX_INJECT',    '4000'))
HTTP_TIMEOUT = float(os.environ.get('HTTP_TIMEOUT', '300'))
SCAN_LAST    = int(os.environ.get('SCAN_LAST_MESSAGES', '12'))

# ── Persona → Lore mapping ───────────────────────────────────────────────────
# Add a line here for each persona.
# Format:  'PersonaName': 'lore_filename.py'
PERSONA_LORE_MAP = {
    'Cody':   'x_change_world.py',
    'Master': 'master_world.py',
}
DEFAULT_LORE = 'x_change_world.py'

app = FastAPI(title='Xchange Proxy')
print('[PROXY] Version ' + PROXY_VERSION + ' starting')

# ── Lore cache ───────────────────────────────────────────────────────────────
_lore_cache: Dict[str, Any] = {}

LORE_FILE_RE     = re.compile(r'^LORE-FILE:\s*(\S+)',      re.IGNORECASE | re.MULTILINE)
WORLD_PERSONA_RE = re.compile(r'^PERSONA-NAME:\s*(.+?)\s*$', re.MULTILINE)

def extract_lore_file(text: str) -> Optional[str]:
    m = LORE_FILE_RE.search(text or '')
    return m.group(1).strip() if m else None

def extract_world_persona(text: str) -> Optional[str]:
    m = WORLD_PERSONA_RE.search(text or '')
    return m.group(1).strip() if m else None

def get_lore(lore_filename: str) -> Optional[Dict]:
    """Load a self-contained lore .py module. Reloads automatically if the file changes."""
    lore_file = BASE_DIR / lore_filename
    if not lore_file.exists():
        print('[WARN] Lore file not found: ' + str(lore_file))
        return None
    mtime = lore_file.stat().st_mtime
    cached = _lore_cache.get(lore_filename)
    if cached and cached.get('mtime') == mtime:
        return cached
    try:
        spec = importlib.util.spec_from_file_location('_lore_' + lore_file.stem, lore_file)
        mod  = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        rs   = mod.load()
    except Exception as ex:
        print('[ERROR] Failed to load lore ' + lore_filename + ': ' + str(ex))
        return cached  # return stale cache rather than None if reload fails
    entry = {'rs': rs, 'le': mod, 'mtime': mtime}
    _lore_cache[lore_filename] = entry
    print('[INFO] Lore loaded: ' + lore_filename)
    return entry


# ── System text helpers ──────────────────────────────────────────────────────

def get_first_system(messages):
    for m in messages or []:
        if m.get('role') == 'system':
            return m.get('content') or ''
    return ''


# ── Chat ID detection ────────────────────────────────────────────────────────

def find_active_chat_integrity(char_name: str) -> Optional[str]:
    if not ST_CHATS_PATH:
        return None
    base = Path(ST_CHATS_PATH)
    if not base.exists():
        if DEBUG: print('[CHAT_ID] path not found: ' + str(base))
        return None
    # Match on first name only — cards are named by first name (e.g. penny.json → folder 'Penny')
    first_name = char_name.split()[0]
    name_re    = re.compile(r'^' + re.escape(first_name) + r'(?:\b|\d|$)', re.IGNORECASE)
    candidates = []
    try:
        for folder in base.iterdir():
            if folder.is_dir() and name_re.match(folder.name):
                for jl in folder.glob('*.jsonl'):
                    candidates.append(jl)
    except Exception as ex:
        if DEBUG: print('[CHAT_ID] scan error: ' + str(ex))
        return None
    if not candidates:
        return None
    active = max(candidates, key=lambda p: p.stat().st_mtime)
    try:
        with open(active, 'r', encoding='utf-8') as f:
            meta = json.loads(f.readline())
        uid = meta.get('chat_metadata', {}).get('integrity')
        if uid:
            if DEBUG: print('[CHAT_ID] integrity=' + uid + ' file=' + active.name)
            return uid
        # No integrity field — use the filename stem, which is stable per chat
        uid = active.stem
        if DEBUG: print('[CHAT_ID] no integrity, using filename: ' + uid)
        return uid
    except Exception as ex:
        if DEBUG: print('[CHAT_ID] read error: ' + str(ex))
    return None

def extract_chat_id(req_json, char_name=None) -> str:
    for k in ('chat_id', 'chatId', 'conversationId', 'conversation_id'):
        v = req_json.get(k)
        if isinstance(v, str) and v.strip() and '{{' not in v:
            return v.strip()
    if char_name:
        uid = find_active_chat_integrity(char_name)
        if uid:
            return uid
    msgs = req_json.get('messages', [])
    if isinstance(msgs, list):
        seen_user = False
        for m in msgs:
            if m.get('role') == 'user':
                seen_user = True
            elif seen_user and m.get('role') == 'assistant':
                seed = (m.get('content') or '')[:500].strip()
                if seed:
                    if DEBUG: print('[CHAT_ID] fallback hash')
                    return hashlib.sha256(seed.encode('utf-8', errors='ignore')).hexdigest()[:16]
    seed = ''
    if isinstance(msgs, list):
        for m in msgs:
            if m.get('role') == 'system':
                seed = (m.get('content') or '')[:500]
                break
    return hashlib.sha256((seed or json.dumps(req_json, sort_keys=True)[:500])
                          .encode('utf-8', errors='ignore')).hexdigest()[:16]


# ── DB ───────────────────────────────────────────────────────────────────────

def db_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.execute('PRAGMA journal_mode=WAL;')
    conn.execute('PRAGMA synchronous=NORMAL;')
    return conn

def ensure_schema(conn):
    conn.execute(
        'CREATE TABLE IF NOT EXISTS sessions('
        'session_key TEXT PRIMARY KEY, world_persona TEXT NOT NULL DEFAULT "",'
        'chat_id TEXT NOT NULL DEFAULT "", char_name TEXT NOT NULL DEFAULT "",'
        'char_sex TEXT NOT NULL DEFAULT "", state_json TEXT NOT NULL DEFAULT "{}")'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS persona_state('
        'persona TEXT PRIMARY KEY, state_json TEXT NOT NULL DEFAULT "{}")'
    )
    conn.commit()

def load_session(session_key, le, rs) -> dict:
    conn = db_conn(); ensure_schema(conn)
    row  = conn.execute('SELECT state_json FROM sessions WHERE session_key=?',
                        (session_key,)).fetchone()
    conn.close()
    if row and row[0]:
        try:
            s = json.loads(row[0])
            if isinstance(s, dict):
                for k, v in le.default_state(rs).items():
                    s.setdefault(k, v)
                return s
        except Exception:
            pass
    return le.default_state(rs)

def save_session(session_key, persona, chat_id, name, sex, state):
    conn = db_conn(); ensure_schema(conn)
    conn.execute(
        'INSERT OR REPLACE INTO sessions'
        '(session_key,world_persona,chat_id,char_name,char_sex,state_json)'
        'VALUES(?,?,?,?,?,?)',
        (session_key, persona, chat_id, name, sex, json.dumps(state))
    )
    conn.commit(); conn.close()

def load_persona(persona: str) -> dict:
    conn = db_conn(); ensure_schema(conn)
    row  = conn.execute(
        'SELECT state_json FROM persona_state WHERE persona=?', (persona,)
    ).fetchone()
    conn.close()
    if row and row[0]:
        try:
            s = json.loads(row[0])
            if isinstance(s, dict): return s
        except Exception:
            pass
    return {'stats': {}, 'relationships': {}, 'effects': []}

def save_persona(persona: str, state: dict):
    conn = db_conn(); ensure_schema(conn)
    conn.execute(
        'INSERT OR REPLACE INTO persona_state(persona, state_json) VALUES(?,?)',
        (persona, json.dumps(state))
    )
    conn.commit(); conn.close()


# ── Passthrough ──────────────────────────────────────────────────────────────

async def passthrough(req_json, label):
    if DEBUG: print('[PASS] ' + label)
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        r = await client.post(REMOTE_BASE + '/chat/completions', json=req_json)
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get('content-type', 'application/json'))


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get('/v1/models')
async def models():
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        r = await client.get(REMOTE_BASE + '/models')
    return JSONResponse(status_code=r.status_code, content=r.json())

@app.post('/v1/chat/completions')
async def chat(request: Request):
    req_json = await request.json()
    messages = req_json.get('messages', [])
    if not isinstance(messages, list):
        return await passthrough(req_json, 'messages not a list')

    system_text = get_first_system(messages)
    persona     = extract_world_persona(system_text)
    if not persona:
        return await passthrough(req_json, 'no PERSONA-NAME')

    lore_filename = extract_lore_file(system_text) or PERSONA_LORE_MAP.get(persona, DEFAULT_LORE)
    lore = get_lore(lore_filename)
    if not lore:
        return await passthrough(req_json, 'lore load failed: ' + lore_filename)

    le = lore['le']
    rs = lore['rs']

    # Identity — needed for chat ID lookup only
    identity = le.extract_identity(system_text, rs)
    if not identity['name'] or not identity['sex']:
        return await passthrough(req_json, 'missing Name/Sex')

    # Session keys
    chat_id     = extract_chat_id(req_json, char_name=identity['name'])
    session_key = persona + '::' + chat_id + '::' + identity['name'].lower().replace(' ', '_')
    persona_key = persona + '::' + chat_id

    # Load state from DB
    state         = load_session(session_key, le, rs)
    persona_state = load_persona(persona_key)

    # All lore processing
    turn = le.process_turn(
        system_text, messages, state, persona_state,
        persona, session_key, SCAN_LAST, DEBUG, rs
    )
    if not turn['ok']:
        return await passthrough(req_json, 'process_turn failed')

    state         = turn['state']
    persona_state = turn['persona_state']

    # Inject and forward
    req_json = le.inject_header(req_json, turn['header'], MAX_INJECT, rs)
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        r = await client.post(REMOTE_BASE + '/chat/completions', json=req_json)

    # Post-response lore processing
    try:
        assistant_text = json.loads(r.content)['choices'][0]['message']['content']
        le.handle_response(assistant_text, state, turn['events'], rs)
    except Exception as ex:
        if DEBUG: print('[WARN] handle_response failed: ' + str(ex))

    # Save and return
    save_session(session_key, persona, chat_id, identity['name'], identity['sex'], state)
    save_persona(persona_key, persona_state)

    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get('content-type', 'application/json'))


if __name__ == '__main__':
    uvicorn.run('proxy:app', host=LISTEN_HOST, port=LISTEN_PORT, log_level='info')