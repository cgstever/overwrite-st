// A/B the CURRENT engine against what was actually sent in historical chats.
//
// Cody 2026-09-12: "can you run a test on 5 cards and compare to historical chats and tell
// me if the current changes are any better?"
//
// The sidecars under user/files/ hold the REAL prompt ST sent at the time, engine version
// and all. This replays each capture's own processTurn inputs and its own saved state
// through the engine as it stands now, and diffs the two prompts on things that can be
// measured rather than judged: duplicated blocks, dead fragment layers, card text that
// contradicts the character's state, junk locations, empty attributes.
//
// It does NOT judge prose. That needs generation, which costs money.
//
// Run:  node _ab_historical_test.mjs
import fs from 'node:fs';
import path from 'node:path';

const lore = (await import('./x_change_world.js')).default;
const rs = lore.init(lore.data);
const _log = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = _log; } };

const ROOT = '/mnt/data/sillytavern/data/cody';
const FILES = `${ROOT}/user/files`;

function readCard(file) {
    const buf = fs.readFileSync(file);
    let i = 8;
    while (i < buf.length) {
        const len = buf.readUInt32BE(i);
        const type = buf.toString('ascii', i + 4, i + 8);
        if (type === 'tEXt') {
            const chunk = buf.slice(i + 8, i + 8 + len);
            const z = chunk.indexOf(0);
            if (['chara', 'ccv3'].includes(chunk.toString('ascii', 0, z))) {
                try {
                    const j = JSON.parse(Buffer.from(chunk.slice(z + 1).toString('ascii'), 'base64').toString('utf8'));
                    return j.data || j;
                } catch (_) { /* next chunk */ }
            }
        }
        if (type === 'IEND') break;
        i += 12 + len;
    }
    return null;
}

// newest large capture per character
function pickCapture(name) {
    const hits = fs.readdirSync(FILES)
        .filter(f => f.startsWith(`xcwdbg_${name.replace(/[^A-Za-z0-9._-]/g, '_')}_`))
        .map(f => {
            try {
                const d = JSON.parse(fs.readFileSync(path.join(FILES, f), 'utf8'));
                const a = d._debug_dump_assembled || {};
                const m = a.messages || [];
                if (!m.length || !(a.processTurn_inputs || {}).systemText) return null;
                return { file: f, d, a, sys: m[0].content, size: m[0].content.length };
            } catch (_) { return null; }
        })
        .filter(Boolean)
        .sort((x, y) => y.size - x.size);
    return hits[0] || null;
}

// the state saved on the newest AI message of that character's newest chat
function pickState(name) {
    const dir = `${ROOT}/chats/${name}`;
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch (_) { return null; }
    let best = null;
    for (const f of files) {
        const rows = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => {
            try { return JSON.parse(l); } catch (_) { return null; }
        }).filter(Boolean);
        for (const r of rows) {
            const vars = r && r.variables;
            if (!vars) continue;
            const slots = Array.isArray(vars) ? vars : Object.values(vars);
            for (const v of slots) {
                const st = v && v.state;
                if (st && typeof st === 'object' && Object.keys(st).length > 20) best = st;
            }
        }
    }
    return best;
}

const ABSENT_MALE = /\b(cock|dick|penis|balls|testicles?|foreskin|manhood)\b/i;
const ABSENT_FEM = /\b(vagina|pussy|clit|clitoris|vulva|labia|womb)\b/i;

function measure(sysPrompt, directive, state) {
    const full = sysPrompt + '\n' + (directive || '');
    const charBlock = (sysPrompt.match(/<character(?: [^>]*)?>[\s\S]*?<\/character>/) || [''])[0];
    const sceneBlock = (sysPrompt.match(/<scene(?: [^>]*)?>[\s\S]*?<\/scene>/) || [''])[0];
    const txInSys = (sysPrompt.match(/<transformation[ >]/g) || []).length;
    const txInDir = ((directive || '').match(/<transformation[ >]/g) || []).length;
    const layers = {};
    for (const p of ['portrait', 'arousal', 'effect', 'identity']) {
        layers[p] = (sysPrompt.match(new RegExp(p + '_[A-Z]{3}=', 'g')) || []).length;
    }
    // does the card text contradict the body the engine resolved?
    const form = (state && state.form) || {};
    let contradiction = 0;
    const body = charBlock.replace(/Female genitalia[^\n]*\n?|Male genitalia[^\n]*\n?/g, '');
    if (form.genitals === 'vagina_only' && ABSENT_MALE.test(body)) contradiction++;
    if (form.genitals === 'penis_only' && ABSENT_FEM.test(body)) contradiction++;
    const locM = sceneBlock.match(/location="([^"]*)"/);
    return {
        chars: sysPrompt.length + (directive || '').length,
        txDup: (txInSys + txInDir) > 1,
        txTotal: txInSys + txInDir,
        layers,
        layersLive: Object.values(layers).filter(n => n > 0).length,
        contradiction,
        emptyAttrs: (sysPrompt.match(/\s\w+=""/g) || []).length,
        location: locM ? locM[1] : null,
        negatives: (full.match(/\bNo penis\.|\bNo vagina\./g) || []).length,
    };
}

const NAMES = ['Cilla', 'Knox', 'Selene', 'Paul', 'Peach'];
const table = [];

for (const name of NAMES) {
    const cap = pickCapture(name);
    const card = (() => { try { return readCard(`${ROOT}/characters/${name}.png`); } catch (_) { return null; } })();
    const state = pickState(name);
    if (!cap || !card || !state) { console.log(`  ${name}: skipped (cap=${!!cap} card=${!!card} state=${!!state})`); continue; }

    const pin = cap.a.processTurn_inputs;
    const before = measure(cap.sys, (cap.a.pending || {}).priorityDirective, state);

    const st = JSON.parse(JSON.stringify(state));
    st._last_user_msg_hash = null;
    delete st._scene_tracker;           // let the current engine reseed from the scenario
    const lastUser = (cap.a.messages || []).find(m => m.role === 'user');
    const r = quiet(() => lore.processTurn({
        systemText: pin.systemText,
        messages: [{ role: 'system', content: pin.systemText },
                   { role: 'user', content: (lastUser && lastUser.content) || 'I look at her.' }],
        state: st, personaState: {}, config: rs,
        charNameHint: pin.charNameHint || name, personaName: pin.personaName || 'Cody',
        personaDescription: pin.personaDescription || '',
        cardPersonality: card.personality || '', cardDescription: card.description || '',
        cardScenario: card.scenario || '', cardTags: card.tags || [],
        cardExtensions: card.extensions || {}, cardExampleDialogue: card.mes_example || '',
        locationOverride: (cap.a.settings_snapshot || {}).locationOverride || '',
        scenarioOverride: (cap.a.settings_snapshot || {}).scenarioOverride || '',
    }));
    const after = measure(r.systemPrompt || '', r.priorityDirective, r.state);

    table.push({ name, engine: cap.d.engine_version, before, after,
                 genitals: ((state && state.form) || {}).genitals || 'unknown',
                 reply: (cap.a.handle_response || {}).assistantText || '' });
}

console.log('\n' + '='.repeat(96));
console.log('BEFORE = the prompt actually sent, from the capture.  AFTER = same inputs through the engine now.');
console.log('='.repeat(96));
for (const t of table) {
    console.log(`\n${t.name}  (captured on engine ${t.engine})`);
    console.log(`  prompt chars        ${String(t.before.chars).padStart(6)}  ->  ${String(t.after.chars).padStart(6)}`);
    console.log(`  transformation blk  ${String(t.before.txTotal).padStart(6)}  ->  ${String(t.after.txTotal).padStart(6)}   ${t.before.txDup ? '(was duplicated)' : ''}`);
    console.log(`  fragment layers     ${String(t.before.layersLive).padStart(6)}  ->  ${String(t.after.layersLive).padStart(6)}   before ${JSON.stringify(t.before.layers)}`);
    console.log(`                      ${' '.repeat(6)}      ${' '.repeat(6)}   after  ${JSON.stringify(t.after.layers)}`);
    console.log(`  card contradicts    ${String(t.before.contradiction).padStart(6)}  ->  ${String(t.after.contradiction).padStart(6)}`);
    console.log(`  empty attributes    ${String(t.before.emptyAttrs).padStart(6)}  ->  ${String(t.after.emptyAttrs).padStart(6)}`);
    console.log(`  negative assertions ${String(t.before.negatives).padStart(6)}  ->  ${String(t.after.negatives).padStart(6)}`);
    console.log(`  location            ${JSON.stringify(t.before.location)}  ->  ${JSON.stringify(t.after.location)}`);
}

// what the model actually wrote back then, checked against what it had
console.log('\n' + '='.repeat(96));
console.log('HISTORICAL MODEL OUTPUT — did it write anatomy the character did not have?');
console.log('='.repeat(96));
for (const t of table) {
    if (!t.reply) { console.log(`  ${t.name}: no reply captured`); continue; }
    // Only count a word as wrong if the character genuinely does not have that part.
    // Selene is a woman WITH a cock -- grepping both word sets blindly would call that an
    // error when it is the entire point of the card.
    const g = t.genitals || 'unknown';
    let re = null;
    if (g === 'vagina_only') re = new RegExp(ABSENT_MALE.source, 'gi');
    else if (g === 'penis_only' || g === 'penis_only_no_vagina') re = new RegExp(ABSENT_FEM.source, 'gi');
    if (!re) {
        console.log(`  ${t.name.padEnd(8)} reply ${String(t.reply.length).padStart(5)} chars | genitals=${g} -- has both or unknown, nothing off-limits`);
        continue;
    }
    const hits = t.reply.match(re) || [];
    console.log(`  ${t.name.padEnd(8)} reply ${String(t.reply.length).padStart(5)} chars | genitals=${g} | wrote parts she does NOT have: ${hits.length ? hits.join(', ') : 'none'}`);
}
