import os
import re
import json
import sqlite3
import hashlib
import random
import uvicorn
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

DEBUG = True

REMOTE_BASE    = os.environ.get('REMOTE_BASE',    'http://192.168.1.62:11434/v1').rstrip('/')
LISTEN_HOST    = os.environ.get('LISTEN_HOST',    '0.0.0.0')
LISTEN_PORT    = int(os.environ.get('LISTEN_PORT', '8000'))
ACTIVE_PERSONA = os.environ.get('ACTIVE_PERSONA', 'Cody')

BASE_DIR      = Path(__file__).resolve().parent
RULEBOOK_PATH = Path(os.environ.get('XCHANGE_RULEBOOK', str(BASE_DIR / 'x_change_world_v5.0.7.json')))
DB_PATH       = Path(os.environ.get('XCHANGE_DB',       str(BASE_DIR / 'state.db')))
MAX_INJECT    = int(os.environ.get('MAX_INJECT',   '4000'))
HTTP_TIMEOUT  = float(os.environ.get('HTTP_TIMEOUT', '300'))
SCAN_LAST     = int(os.environ.get('SCAN_LAST_MESSAGES', '12'))

app = FastAPI(title='Xchange Proxy')

PILL_RULES:        Dict[str, Any] = {}
FLAVOR_TRIGGERS:   List[Dict]     = []
PREGNANCY_ODDS:    Dict[str, Any] = {}
EFFECT_MECHANICS:  Dict[str, Any] = {}
DIRECTIVE_RES:     List[Any]      = []

PILL_CONTEXT_RE = None
PILL_NOUN_RE    = None
INTAKE_VERB_RE  = None
CREAMPIE_RE     = None
CUM_SWALLOW_RE  = None
ANTIDOTE_RE     = None

def load_rulebook():
    global PILL_RULES, FLAVOR_TRIGGERS, PREGNANCY_ODDS, EFFECT_MECHANICS, DIRECTIVE_RES
    global PILL_CONTEXT_RE, PILL_NOUN_RE, INTAKE_VERB_RE
    global CREAMPIE_RE, CUM_SWALLOW_RE, ANTIDOTE_RE

    if not RULEBOOK_PATH.exists():
        raise RuntimeError('Lore not found: ' + str(RULEBOOK_PATH))
    with open(RULEBOOK_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)

    PILL_RULES      = data.get('pill_rules',      {})
    PREGNANCY_ODDS  = data.get('pregnancy_odds',  {})
    EFFECT_MECHANICS= data.get('effect_mechanics',{})
    raw_flavors     = data.get('flavor_triggers',  {})
    FLAVOR_TRIGGERS = list(raw_flavors.values()) if isinstance(raw_flavors, dict) else raw_flavors

    DIRECTIVE_RES = []
    for pat in data.get('directive_patterns', []):
        try:
            DIRECTIVE_RES.append(re.compile(pat, re.IGNORECASE))
        except Exception as ex:
            print('[WARN] bad directive pattern: ' + str(pat) + ' ' + str(ex))

    ep      = data.get('event_patterns', {})
    colors  = ep.get('pill_colors',  ['pink','blue','purple','green','red'])
    nouns   = ep.get('pill_nouns',   ['pill','dose','tablet','capsule','xchange','x-change'])
    intakes = ep.get('intake_verbs', ['swallow','swallows','swallowed','take','takes','taking',
                                      'took','dissolve','dissolves','dissolved','pop','pops',
                                      'popped','gulp','gulps','gulped','down','downed'])
    prox    = ep.get('pill_color_noun_proximity', 40)

    cp = '|'.join(re.escape(c) for c in colors)
    np = '|'.join(re.escape(n) for n in nouns)
    ip = '|'.join(re.escape(v) for v in intakes)
    ps = '.{0,' + str(prox) + '}'

    PILL_CONTEXT_RE = re.compile(
        r'\b(' + cp + r')\b' + ps + r'\b(' + np + r')\b'
        r'|\b(' + np + r')\b' + ps + r'\b(' + cp + r')\b',
        re.IGNORECASE)
    PILL_NOUN_RE   = re.compile(r'\b(' + np + r')\b', re.IGNORECASE)
    INTAKE_VERB_RE = re.compile(r'\b(' + ip + r')\b', re.IGNORECASE)

    def build_alt(patterns):
        return re.compile('|'.join('(?:' + p + ')' for p in patterns), re.IGNORECASE)

    CREAMPIE_RE    = build_alt(ep.get('creampie',    [r'finish(?:es|ed)? inside']))
    CUM_SWALLOW_RE = build_alt(ep.get('cum_swallow', [r'swallow(?:s|ed|ing)? (?:it|his cum|the cum)']))
    ANTIDOTE_RE    = build_alt(ep.get('antidote',    [r'\bantidote\b']))

    entry_count = len(data.get('entries', {}))
    print('[INFO] Lore loaded: ' + str(RULEBOOK_PATH.name) +
          ' (' + str(entry_count) + ' entries, ' + str(len(PILL_RULES)) + ' pills, ' +
          str(len(EFFECT_MECHANICS)) + ' effect mechanics)')

load_rulebook()

WORLD_PERSONA_RE = re.compile(r'^X-WORLD-PERSONA:\s*(.+?)\s*$', re.MULTILINE)
CARD_NAME_RE     = re.compile(r'^Name:\s*(.+?)\s*$',            re.MULTILINE)
CARD_SEX_RE      = re.compile(r'^Sex:\s*(.+?)\s*$',             re.MULTILINE)

def get_first_system(messages):
    for m in messages or []:
        if m.get('role') == 'system':
            return m.get('content') or ''
    return ''

def _rx(pat, text):
    m = pat.search(text or '')
    return m.group(1).strip() if m else None

def extract_world_persona(t): return _rx(WORLD_PERSONA_RE, t)
def extract_card_name(t):     return _rx(CARD_NAME_RE,     t)
def extract_card_sex(t):      return _rx(CARD_SEX_RE,      t)

def extract_chat_id(req_json):
    for k in ('chat_id','chatId','conversationId','conversation_id'):
        v = req_json.get(k)
        if isinstance(v, str) and v.strip() and '{{' not in v:
            return v.strip()
    msgs = req_json.get('messages', [])
    seed = ''
    if isinstance(msgs, list):
        for m in msgs:
            if m.get('role') == 'system':
                seed = (m.get('content') or '')[:500]
                break
        if not seed and msgs:
            seed = (msgs[0].get('content') or '')[:500]
    return hashlib.sha256((seed or json.dumps(req_json, sort_keys=True)[:500])
                          .encode('utf-8', errors='ignore')).hexdigest()[:16]

def pill_rule(state):
    pill = state.get('active_pill')
    return PILL_RULES.get(pill, {}) if pill else {}

def current_sex(state, card_sex):
    rule = pill_rule(state)
    if rule and not rule.get('no_form_change'):
        return rule.get('form_sex', card_sex).lower()
    return (card_sex or 'male').lower()

def current_genitals(state, card_sex):
    rule = pill_rule(state)
    if rule and not rule.get('no_form_change'):
        return rule.get('genitals', 'unknown')
    return 'penis_only' if (card_sex or 'male').lower() == 'male' else 'vagina_only'

def can_get_pregnant(state, card_sex):
    rule = pill_rule(state)
    if rule:
        return bool(rule.get('pregnancy_eligible'))
    return (card_sex or 'male').lower() == 'female'

def find_pill_ingest(messages_recent):
    last_color = None
    pill_seen  = False
    for msg in messages_recent:
        text = (msg.get('content') or '').strip()
        if not text:
            continue
        ctx = PILL_CONTEXT_RE.search(text)
        if ctx:
            groups = ctx.groups()
            color  = next((g for g in groups if g and g.lower() in PILL_RULES), None)
            if color:
                last_color = color.lower()
                pill_seen  = True
                if DEBUG:
                    print('[PILL] color+noun: ' + last_color)
        if PILL_NOUN_RE.search(text):
            pill_seen = True
        if last_color and pill_seen and INTAKE_VERB_RE.search(text):
            if DEBUG:
                print('[PILL] ingest=true: ' + last_color)
            return last_color
    return None

def detect_directive(messages_recent):
    if not DIRECTIVE_RES:
        return False
    last_msg = ''
    for m in reversed(messages_recent):
        if m.get('role') == 'user':
            last_msg = m.get('content') or ''
            break
    return any(r.search(last_msg) for r in DIRECTIVE_RES)

def detect_events(messages_recent, state, card_sex):
    events   = {}
    all_text = '\n'.join((m.get('content') or '') for m in messages_recent)

    if not state.get('active_pill'):
        color = find_pill_ingest(messages_recent)
        if color:
            events['pill_taken'] = color

    pill_ctx = events.get('pill_taken') or state.get('active_pill')
    for ft in FLAVOR_TRIGGERS:
        if ft.get('requires_pill') and not pill_ctx:
            continue
        for kw in ft.get('keywords', []):
            if re.search(r'\b' + re.escape(kw) + r'\b', all_text, re.IGNORECASE):
                events['flavor_' + ft['effect']] = True
                break

    temp_state = dict(state)
    if events.get('pill_taken'):
        temp_state['active_pill'] = events['pill_taken']

    if CREAMPIE_RE.search(all_text):
        if can_get_pregnant(temp_state, card_sex):
            events['creampie_vaginal'] = True
        elif DEBUG:
            print('[EVENT] creampie not eligible (form=' + current_sex(temp_state, card_sex) + ')')

    if CUM_SWALLOW_RE.search(all_text):
        events['cum_swallowed'] = True
    if ANTIDOTE_RE.search(all_text):
        events['antidote_taken'] = True
    if detect_directive(messages_recent):
        events['directive'] = True

    return events

def get_stat_mod(state, stat_name):
    stats = state.get('stats') or {}
    return int(stats.get(stat_name, 0))

def compute_roll_mods(state, roll_list):
    total = 0
    for item in (roll_list or []):
        item = item.strip()
        sign = 1
        if item.startswith('-'):
            sign = -1
            item = item[1:]
        elif item.startswith('+'):
            item = item[1:]
        total += sign * get_stat_mod(state, item)
    return total

def d20_roll():
    return random.randint(1, 20)

def d100_roll():
    return random.randint(1, 100)

def get_effect_dc(state, effect_name):
    mech = EFFECT_MECHANICS.get(effect_name, {})
    dcs  = state.setdefault('effect_dcs', {})
    if effect_name not in dcs:
        dcs[effect_name] = int(mech.get('start_dc', 12))
    return dcs[effect_name]

def set_effect_dc(state, effect_name, dc):
    state.setdefault('effect_dcs', {})[effect_name] = dc

def get_effect_stage(state, effect_name):
    return state.setdefault('effect_stages', {}).get(effect_name, 0)

def set_effect_stage(state, effect_name, stage):
    state.setdefault('effect_stages', {})[effect_name] = stage

def is_effect_locked(state, effect_name):
    return state.setdefault('effect_locks', {}).get(effect_name, False)

def lock_effect(state, effect_name):
    state.setdefault('effect_locks', {})[effect_name] = True

def check_math_lock(state, effect_name):
    mech     = EFFECT_MECHANICS.get(effect_name, {})
    roll_list= mech.get('roll', [])
    max_roll = 20 + compute_roll_mods(state, roll_list)
    current_dc = get_effect_dc(state, effect_name)
    if current_dc > max_roll:
        lock_effect(state, effect_name)
        return True
    return False

def run_effect_roll(state, effect_name, notes):
    if is_effect_locked(state, effect_name):
        notes.append(effect_name + ': LOCKED (auto-fail)')
        return 'locked'

    mech        = EFFECT_MECHANICS.get(effect_name, {})
    roll_list   = mech.get('roll', [])
    mods        = compute_roll_mods(state, roll_list)
    current_dc  = get_effect_dc(state, effect_name)
    max_possible= 20 + mods
    escalation  = int(mech.get('escalation', 2))
    escalate_on = mech.get('escalate_on', 'pass')

    if max_possible < current_dc:
        lock_effect(state, effect_name)
        notes.append(effect_name + ': LOCKED (max=' + str(max_possible) + ' < DC=' + str(current_dc) + ')')
        return 'locked'

    roll   = d20_roll()
    total  = roll + mods
    passed = total >= current_dc

    result_str = ('PASS' if passed else 'FAIL') + ' (roll=' + str(roll) + ' mods=' + str(mods) + ' total=' + str(total) + ' dc=' + str(current_dc) + ')'
    notes.append(effect_name + ': ' + result_str)
    print('[ROLL] ' + effect_name + ' ' + result_str)

    if passed and escalate_on == 'pass':
        new_dc = current_dc + escalation
        set_effect_dc(state, effect_name, new_dc)
        notes.append(effect_name + ' DC: ' + str(current_dc) + '->' + str(new_dc))
        check_math_lock(state, effect_name)

    if not passed and escalate_on == 'fail':
        new_dc = current_dc + escalation
        set_effect_dc(state, effect_name, new_dc)
        notes.append(effect_name + ' DC: ' + str(current_dc) + '->' + str(new_dc))
        check_math_lock(state, effect_name)

    return 'pass' if passed else 'fail'

def advance_stage(state, effect_name, notes, permanent_to_db=False):
    mech      = EFFECT_MECHANICS.get(effect_name, {})
    stages    = mech.get('stages', {})
    current   = get_effect_stage(state, effect_name)
    max_stage = len(stages)
    if current >= max_stage:
        return
    new_stage = current + 1
    set_effect_stage(state, effect_name, new_stage)
    stage_info = stages.get(str(new_stage), {})
    notes.append(effect_name + ' stage->' + str(new_stage) + ': ' + stage_info.get('note', ''))

    # Apply stat penalties from stage
    stats = state.setdefault('stats', {})
    for stat_key in ('wil_penalty', 'int_penalty', 'con_penalty', 'dom_penalty'):
        if stat_key in stage_info:
            base_stat = stat_key.split('_')[0].upper()
            mod_key   = base_stat + '_mod'
            current_mod = int(stats.get(mod_key, 0))
            new_mod     = current_mod + int(stage_info[stat_key])
            stats[mod_key] = new_mod
            notes.append(base_stat + '_mod adjusted to ' + str(new_mod))

    if stage_info.get('permanent') or new_stage >= max_stage:
        lock_effect(state, effect_name)
        notes.append(effect_name + ': permanent lock at stage ' + str(new_stage))
        if permanent_to_db:
            state.setdefault('flags', {})['permanent_' + effect_name + '_stage'] = new_stage

def roll_pregnancy(effects):
    has_breeder = 'breeder' in effects
    has_bull    = 'bull'    in effects
    if has_breeder and has_bull:
        chance = int(PREGNANCY_ODDS.get('breeder_and_bull', 97))
    elif has_bull:
        chance = int(PREGNANCY_ODDS.get('bull', 90))
    elif has_breeder:
        chance = int(PREGNANCY_ODDS.get('breeder', 85))
    else:
        chance = int(PREGNANCY_ODDS.get('normal', 4))
    roll   = d100_roll()
    result = roll <= chance
    print('[PREG] d100=' + str(roll) + ' need<=' + str(chance) + ' => ' + ('YES' if result else 'no'))
    return result

def process_events(state, events, card_sex, notes):
    effects = list(state.get('active_effects') or [])

    # -- PILL INGEST ---------------------------------------------------------
    if events.get('pill_taken'):
        color = events['pill_taken']
        rule  = PILL_RULES.get(color, {})
        state['active_pill'] = color
        for eff in rule.get('immediate_effects', []):
            if eff not in effects:
                effects.append(eff)
        if rule.get('no_form_change'):
            form_note = 'effects only'
        else:
            form_note = 'form=' + rule.get('form_sex','?') + ' genitals=' + rule.get('genitals','?')
        notes.append('Pill: ' + color + ' (' + form_note + ') - transforms immediately')

    # -- FLAVOR EFFECTS -------------------------------------------------------
    for ft in FLAVOR_TRIGGERS:
        key = 'flavor_' + ft['effect']
        if events.get(key) and ft['effect'] not in effects:
            effects.append(ft['effect'])
            notes.append('Effect added: ' + ft['effect'])
            # Initialize DC for new effect
            mech = EFFECT_MECHANICS.get(ft['effect'], {})
            state.setdefault('effect_dcs', {})[ft['effect']] = int(mech.get('start_dc', 12))

    state['active_effects'] = effects

    # -- DIRECTIVE ROLLS ------------------------------------------------------
    if events.get('directive'):
        for eff in ('submissive', 'compliant', 'bull'):
            if eff in effects:
                run_effect_roll(state, eff, notes)

    # -- DENIED ORGASM --------------------------------------------------------
    # Breeder resist and denial both trigger on denied orgasm.
    # We approximate: if breeder or denial active and no creampie this turn = denied
    has_breeder = 'breeder' in effects
    has_denial  = 'denial'  in effects
    creampie_this_turn = events.get('creampie_vaginal', False)
    if (has_breeder or has_denial) and not creampie_this_turn:
        if has_breeder:
            result = run_effect_roll(state, 'breeder_resist', notes)
            if result == 'fail':
                notes.append('Breeder: compulsion active - craving creampie')
        if has_denial:
            run_effect_roll(state, 'denial', notes)

    # -- BREEDER ORGASM (creampie relief) -------------------------------------
    if creampie_this_turn and has_breeder:
        # Reset breeder resist DC
        mech = EFFECT_MECHANICS.get('breeder_resist', {})
        set_effect_dc(state, 'breeder_resist', int(mech.get('start_dc', 30)))
        state.setdefault('effect_locks', {})['breeder_resist'] = False
        notes.append('Breeder resist DC reset to 30')
        # Addiction roll - fail = stage advances
        if not is_effect_locked(state, 'breeder_addiction'):
            result = run_effect_roll(state, 'breeder_addiction', notes)
            if result == 'fail':
                advance_stage(state, 'breeder_addiction', notes, permanent_to_db=True)

    # -- BIMBO interval -------------------------------------------------------
    if 'bimbo' in effects:
        mech     = EFFECT_MECHANICS.get('bimbo', {})
        interval = int(mech.get('interval', 50))
        counter  = state.setdefault('bimbo_msg_count', 0) + 1
        state['bimbo_msg_count'] = counter
        if counter % interval == 0 and not is_effect_locked(state, 'bimbo'):
            result = run_effect_roll(state, 'bimbo', notes)
            if result == 'fail':
                advance_stage(state, 'bimbo', notes)

    # -- PSYCHE once per session -----------------------------------------------
    if 'psyche' in effects and not state.get('flags', {}).get('psyche_rolled_this_session'):
        if not is_effect_locked(state, 'psyche'):
            result = run_effect_roll(state, 'psyche', notes)
            if result == 'fail':
                advance_stage(state, 'psyche', notes, permanent_to_db=True)
        state.setdefault('flags', {})['psyche_rolled_this_session'] = True

    # -- ANTIDOTE -------------------------------------------------------------
    if events.get('antidote_taken'):
        flags = state.get('flags') or {}
        rule  = PILL_RULES.get(state.get('active_pill') or '', {})
        if flags.get('pregnancy_confirmed'):
            notes.append('Antidote blocked - pregnancy lock')
        elif not rule.get('antidote_allowed', True):
            notes.append('Antidote blocked - pill rules')
        else:
            state['active_pill']    = None
            state['active_effects'] = []
            state['cure_counter']   = 0
            notes.append('Antidote - cleared')

    # -- CREAMPIE / PREGNANCY -------------------------------------------------
    if creampie_this_turn:
        flags = state.setdefault('flags', {})
        if not flags.get('pregnancy_confirmed'):
            if roll_pregnancy(state.get('active_effects') or []):
                flags['pregnancy_confirmed'] = True
                flags['pregnancy_lock']      = True
                notes.append('Pregnancy confirmed and locked')
            else:
                notes.append('Creampie - no pregnancy')
        else:
            notes.append('Creampie - already pregnant')
        state['cure_counter'] = state.get('cure_counter', 0) + 1

    # -- CUM SWALLOW ----------------------------------------------------------
    if events.get('cum_swallowed'):
        state['cure_counter'] = state.get('cure_counter', 0) + 1
        notes.append('Cum swallowed (' + str(state['cure_counter']) + ')')

    return state

def default_state():
    return {
        'turn': 0, 'active_pill': None, 'active_effects': [],
        'flags': {'statgen_done': False}, 'stats': {}, 'roll_log': [],
        'cure_counter': 0, 'effect_dcs': {}, 'effect_stages': {},
        'effect_locks': {}, 'bimbo_msg_count': 0,
    }

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
    conn.commit()

def load_state(session_key):
    conn = db_conn(); ensure_schema(conn)
    row  = conn.execute('SELECT state_json FROM sessions WHERE session_key=?',
                        (session_key,)).fetchone()
    conn.close()
    if row and row[0]:
        try:
            s = json.loads(row[0])
            if isinstance(s, dict):
                for k, v in default_state().items():
                    s.setdefault(k, v)
                return s
        except Exception:
            pass
    return default_state()

def save_state(session_key, persona, chat_id, name, sex, state):
    conn = db_conn(); ensure_schema(conn)
    conn.execute(
        'INSERT OR REPLACE INTO sessions'
        '(session_key,world_persona,chat_id,char_name,char_sex,state_json)'
        'VALUES(?,?,?,?,?,?)',
        (session_key, persona, chat_id, name, sex, json.dumps(state))
    )
    conn.commit(); conn.close()

STATGEN_SIGNALS = [
    ('DOM',+2,['dominant',' dom ','controlling','commanding',' top ','topping']),
    ('DOM',+1,['gentle dominance','nurturing dominance','switch']),
    ('SUB',+2,['submissive','service submission','yielding','obedient']),
    ('SUB',+1,['bratty','feigned reluctance','masochist','switch']),
    ('WIL',+2,['strong-willed','disciplined','determined','stubborn']),
    ('WIL',-1,['anxious','insecure','needy','dependent']),
    ('DES',+2,['praise','denial','edging']),
    ('DES',+2,['masochist','rough forcing']),
    ('DES',+1,['hypersensitive','leaking','clenching','slicking','melts']),
    ('CON',+1,['athletic','stamina','endurance']),
    ('CON',-1,['delicate','overwhelmed','fragile']),
    ('INT',+1,['clever','bookish','strategic','studious']),
]

def run_statgen(system_text):
    stats    = {s: 10 for s in ('INT','WIL','DOM','SUB','CON','DES')}
    combined = system_text.lower()
    for stat, delta, kws in STATGEN_SIGNALS:
        if any(k in combined for k in kws):
            stats[stat] = max(6, min(14, stats[stat] + delta))
    result = dict(stats)
    for k, v in stats.items():
        result[k + '_mod'] = (v - 10) // 2
    print('[STATGEN] ' + str(stats))
    return result

def fmt_stats(stats):
    if not stats:
        return '(none)'
    parts = []
    for s in ('INT','WIL','DOM','SUB','CON','DES'):
        if s in stats:
            mod  = stats.get(s + '_mod', 0)
            sign = '+' if mod >= 0 else ''
            parts.append(s + '=' + str(stats[s]) + '(' + sign + str(mod) + ')')
    return ' '.join(parts)

def fmt_effect_states(state):
    effects = state.get('active_effects') or []
    if not effects:
        return ''
    parts = []
    for eff in effects:
        dc    = state.get('effect_dcs', {}).get(eff)
        stage = state.get('effect_stages', {}).get(eff)
        locked= state.get('effect_locks', {}).get(eff)
        info  = eff
        if locked:
            info += '[LOCKED'
            if stage:
                info += ' stage=' + str(stage)
            info += ']'
        elif dc is not None:
            info += '[DC=' + str(dc)
            if stage:
                info += ' stage=' + str(stage)
            info += ']'
        parts.append(info)
    return ', '.join(parts)

def build_header(name, card_sex, state, notes):
    eff_sex  = current_sex(state, card_sex)
    genitals = current_genitals(state, card_sex)
    pill     = state.get('active_pill') or 'none'
    preg     = 'YES - locked' if (state.get('flags') or {}).get('pregnancy_confirmed') else 'no'
    eff_str  = fmt_effect_states(state) or 'none'

    lines = [
        'X-WORLD STATE (authoritative - apply immediately this turn)',
        'Character: ' + name + ' | Base: ' + card_sex + ' | Form: ' + eff_sex +
            ' | Genitals: ' + genitals + ' | Turn: ' + str(state.get('turn',0)),
        'Pill: ' + pill + ' | Effects: ' + eff_str,
        'Pregnant: ' + preg,
        'Stats: ' + fmt_stats(state.get('stats')),
    ]
    if notes:
        lines.append('Events: ' + '; '.join(notes))
    return '\n'.join(lines)

def inject_system(req_json, block):
    messages = req_json.get('messages', [])
    if not isinstance(messages, list) or not block.strip():
        return req_json
    out = []; injected = False
    for m in messages:
        out.append(m)
        if not injected and m.get('role') == 'system':
            out.append({'role': 'system', 'content': block[:MAX_INJECT]})
            injected = True
    if not injected:
        out.insert(0, {'role': 'system', 'content': block[:MAX_INJECT]})
    req_json['messages'] = out
    return req_json

def debug_print(sk, name, card_sex, state, events):
    if not DEBUG:
        return
    print('=' * 65)
    print('[PROXY] ' + sk + ' t=' + str(state.get('turn')))
    print('  char    : ' + name + ' card=' + card_sex + ' form=' + current_sex(state, card_sex))
    print('  pill    : ' + str(state.get('active_pill')))
    print('  effects : ' + fmt_effect_states(state))
    print('  flags   : ' + str(state.get('flags')))
    print('  dcs     : ' + str(state.get('effect_dcs')))
    print('  stages  : ' + str(state.get('effect_stages')))
    print('  events  : ' + str(events))
    print('=' * 65)

async def passthrough(req_json, label):
    if DEBUG:
        print('[PASS] ' + label)
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        r = await client.post(REMOTE_BASE + '/chat/completions', json=req_json)
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get('content-type', 'application/json'))

@app.get('/v1/models')
async def models():
    async with httpx.AsyncClient(timeout=60) as client:
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
        return await passthrough(req_json, 'no X-WORLD-PERSONA')
    if persona.strip() != ACTIVE_PERSONA:
        return await passthrough(req_json, 'persona mismatch')

    name = extract_card_name(system_text)
    sex  = extract_card_sex(system_text)
    if not name or not sex:
        return await passthrough(req_json, 'missing Name/Sex')

    chat_id     = extract_chat_id(req_json)
    session_key = persona + '::' + chat_id
    state       = load_state(session_key)
    state['turn'] = int(state.get('turn', 0)) + 1

    flags = state.setdefault('flags', {})
    if not flags.get('statgen_done'):
        state['stats']        = run_statgen(system_text)
        flags['statgen_done'] = True
        print('[STATGEN] Done for ' + name)

    recent = [m for m in messages[-SCAN_LAST:]
              if isinstance(m, dict) and m.get('role') != 'system']

    notes  = []
    events = detect_events(recent, state, sex)
    state  = process_events(state, events, sex, notes)

    debug_print(session_key, name, sex, state, events)

    header = build_header(name, sex, state, notes)
    if DEBUG:
        print('[INJECT]\n' + header + '\n')

    req_json = inject_system(req_json, header)

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        r = await client.post(REMOTE_BASE + '/chat/completions', json=req_json)

    save_state(session_key, persona, chat_id, name, sex, state)

    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get('content-type', 'application/json'))

if __name__ == '__main__':
    uvicorn.run('proxy:app', host=LISTEN_HOST, port=LISTEN_PORT, log_level='info')