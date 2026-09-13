// A/B using the payload SillyTavern would actually send.
//
// Cody 2026-09-12: "you should be sending a prompt that st would send."
//
// Every earlier harness in this session hand-assembled the messages, which is not what ships.
// This extracts buildScenePage() out of the StatefulLore extension and runs it, then appends
// priorityDirective the same way core.js does, so the NEW side is the real thing. The OLD
// side is the exact messages array recorded in the sidecar, which is also the real thing.
//
// Run:  node _st_faithful_ab.mjs [reps]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/mnt/data/sillytavern/data/cody';
const EXT = '/mnt/books/Claude/statefullore/core.js';
const MODEL = 'grok-4.3';
const REPS = parseInt(process.argv[2] || '3', 10);
const KEY = (fs.readFileSync('/mnt/books/Claude/api-keys.txt', 'utf8').match(/\bxai-[A-Za-z0-9]{20,}/) || [])[0];

const lore = (await import('./x_change_world.js')).default;
const rs = lore.init(lore.data);
const _log = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = _log; } };

// ── the extension's own assembler, lifted verbatim ───────────────────────────
const buildScenePage = (() => {
    const src = fs.readFileSync(EXT, 'utf8');
    const i = src.indexOf('function buildScenePage(pending, messages) {');
    if (i < 0) throw new Error('buildScenePage not found in core.js');
    let d = 0, end = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}' && --d === 0) { end = k + 1; break; }
    }
    return new Function(`${src.slice(i, end)}; return buildScenePage;`)();
})();

async function ask(messages) {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0.9, max_tokens: 1400 }),
    });
    const j = await res.json();
    if (!res.ok) return { text: '', err: JSON.stringify(j).slice(0, 160), usage: null };
    return { text: (((j.choices || [])[0] || {}).message || {}).content || '', usage: j.usage };
}

function readCard(file) {
    const b = fs.readFileSync(file); let i = 8;
    while (i < b.length) {
        const len = b.readUInt32BE(i), t = b.toString('ascii', i + 4, i + 8);
        if (t === 'tEXt') {
            const c = b.slice(i + 8, i + 8 + len), z = c.indexOf(0);
            if (['chara', 'ccv3'].includes(c.toString('ascii', 0, z))) {
                try { const j = JSON.parse(Buffer.from(c.slice(z + 1).toString('ascii'), 'base64').toString('utf8')); return j.data || j; } catch (_) {}
            }
        }
        if (t === 'IEND') break;
        i += 12 + len;
    }
    return null;
}

const NAME = 'Cilla';
const CHAT = `${ROOT}/chats/${NAME}/Cilla - 2026-09-12@10h35m14s179ms.jsonl`;
const rows = fs.readFileSync(CHAT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// the pill turn, the state before it, the user line that is that turn
let txIdx = -1;
for (let i = 0; i < rows.length; i++) {
    const v = rows[i].variables; if (!v) continue;
    const slots = Array.isArray(v) ? v : Object.values(v);
    if (slots.some(x => x && x.state && (x.state._pill_descriptor_this_turn || x.state._pre_tx_card_body))) { txIdx = i; break; }
}
let preState = null;
for (let j = txIdx - 1; j >= 0; j--) {
    const pv = rows[j].variables; if (!pv) continue;
    for (const y of (Array.isArray(pv) ? pv : Object.values(pv))) if (y && y.state) { preState = y.state; break; }
    if (preState) break;
}
const userMsg = rows[txIdx - 1].mes;
const card = readCard(`${ROOT}/characters/${NAME}.png`);
const systemText = [card.description, card.personality, card.scenario ? 'Scenario: ' + card.scenario : ''].filter(Boolean).join('\n');

// what ST hands the extension: its own system message plus the chat so far
// NOTE: stop BEFORE txIdx-1. That row IS the pill message, and it gets appended as the
// current turn below — including it here put the same user line in twice and produced two
// consecutive user messages in the payload.
const stMessages = [{ role: 'system', content: systemText }];
for (let i = 1; i < txIdx - 1; i++) {
    const r = rows[i];
    if (!r || r.mes == null) continue;
    stMessages.push({ role: r.is_user ? 'user' : 'assistant', content: r.mes });
}

// ── the OLD side: exactly what the sidecar recorded ST sending ───────────────
const FILES = `${ROOT}/user/files`;
const cap = fs.readdirSync(FILES).filter(f => f.startsWith(`xcwdbg_${NAME}_`)).map(f => {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(FILES, f), 'utf8'));
        const a = d._debug_dump_assembled || {}; const m = a.messages || [];
        return m.length && m.some(x => /<transformation/.test(x.content)) ? { m, ver: d.engine_version, size: m[0].content.length } : null;
    } catch (_) { return null; }
}).filter(Boolean).sort((a, b) => b.size - a.size)[0];

// ── the NEW side: engine -> the extension's own assembler ────────────────────
function stPayload() {
    const st = JSON.parse(JSON.stringify(preState));
    st._last_user_msg_hash = null; st._frag_seen = [];
    delete st._scene_tracker;
    const tr = quiet(() => lore.processTurn({
        systemText, messages: stMessages.concat([{ role: 'user', content: userMsg }]),
        state: st, personaState: {}, config: rs,
        charNameHint: NAME, personaName: 'Cody', personaDescription: '',
        cardPersonality: card.personality || '', cardDescription: card.description || '',
        cardScenario: card.scenario || '', cardTags: card.tags || [],
        cardExtensions: card.extensions || {}, cardExampleDialogue: card.mes_example || '',
        locationOverride: 'luxury private dungeon', scenarioOverride: '',
    }));
    // pending, built the way core.js builds it
    const pending = {
        header: tr.header || null, brief: tr.brief || null, systemPrompt: tr.systemPrompt || null,
        inject: tr.inject || [], scrubbed_messages: tr.scrubbed_messages || null,
        storySummary: tr.storySummary || null, condensedSummary: tr.condensedSummary || '',
        scrubbedRecentMessages: tr.scrubbedRecentMessages || null,
        recentMessageCount: tr.recentMessageCount || null,
        priorityInjection: tr.priorityInjection || false,
        priorityDirective: tr.priorityDirective || null,
        personaBlock: tr.personaBlock || null,
        messageReplacements: tr.messageReplacements || null,
        cardStripPatterns: tr.cardStripPatterns || [],
    };
    const isPriority = pending.priorityInjection || pending.recentMessageCount === 1;
    let msgs = buildScenePage(pending, stMessages.concat([{ role: 'user', content: userMsg }]));
    if (isPriority && pending.priorityDirective) msgs.push({ role: 'system', content: pending.priorityDirective });
    return msgs;
}

const AX = { height: /\b(taller|shorter|height|shrink|shrunk|stance)\b/i, chest: /\b(chest|breasts?|nipples?|cup|mounds?)\b/i,
    hips: /\b(hips?|thighs?|waist|curves?)\b/i, face: /\b(jaw|cheek|lips?|brow|face)\b/i, hair: /\b(hair|strands?|scalp)\b/i,
    voice: /\b(voice|throat|pitch|octave)\b/i, skin: /\b(skin|pores?|smooth)\b/i,
    genitals: /\b(cock|length|balls|testicles?|opening|folds|slick|clit|empty)\b/i };
const prose = (t) => String(t).replace(/<scene_state>[\s\S]*/, '').trim();
const score = (t) => { const p = prose(t); return { w: p.split(/\s+/).filter(Boolean).length,
    ax: Object.keys(AX).filter(k => AX[k].test(p)).length }; };
const avg = (a) => ({ w: Math.round(a.reduce((s, x) => s + x.w, 0) / a.length),
    ax: (a.reduce((s, x) => s + x.ax, 0) / a.length).toFixed(1) });

const shape = (m) => m.map(x => `${x.role}:${x.content.length}`).join('  ');
const newMsgs = stPayload();
console.log(`OLD — sidecar, engine ${cap.ver}:  ${cap.m.reduce((n, m) => n + m.content.length, 0)} chars`);
console.log(`   ${shape(cap.m)}`);
console.log(`NEW — engine ${lore.version} through the extension's buildScenePage: ${newMsgs.reduce((n, m) => n + m.content.length, 0)} chars`);
console.log(`   ${shape(newMsgs)}`);
console.log(`   TX block appears ${(newMsgs.map(m => m.content).join('').match(/<transformation[ >]/g) || []).length}x`);

if (!KEY) { console.log('\n(no key — structure only)'); process.exit(0); }
// same payload, but the TX block moved back to a trailing system message — the placement
// 7.13.47 moved it AWAY from. Decides whether that move was worth making.
function asTrailingDirective() {
    const m = stPayload();
    const u = m.findLast ? m.findLast(x => x.role === 'user') : [...m].reverse().find(x => x.role === 'user');
    const tx = (u.content.match(/<transformation[\s\S]*$/) || [''])[0];
    if (!tx) return m;
    u.content = u.content.replace(tx, '').trim();
    m.push({ role: 'system', content: tx });
    return m;
}
const jobs = [];
for (let k = 0; k < REPS; k++) {
    jobs.push(ask(cap.m.map(m => ({ role: m.role, content: m.content }))));
    jobs.push(ask(stPayload()));
    jobs.push(ask(asTrailingDirective()));
}
const res = await Promise.all(jobs);
let iT = 0, oT = 0; for (const x of res) if (x.usage) { iT += x.usage.prompt_tokens || 0; oT += x.usage.completion_tokens || 0; }
const olds = res.filter((_, i) => i % 3 === 0).map(x => score(x.text));
const news = res.filter((_, i) => i % 3 === 1).map(x => score(x.text));
const trail = res.filter((_, i) => i % 3 === 2).map(x => score(x.text));
console.log(`\n${REPS} samples a side, ${MODEL}, identical settings`);
console.log('  OLD  7.13.26, block twice        ', JSON.stringify(olds), '-> avg', JSON.stringify(avg(olds)));
console.log('  NEW  7.13.47, block on user msg  ', JSON.stringify(news), '-> avg', JSON.stringify(avg(news)));
console.log('  ALT  same, block trailing system ', JSON.stringify(trail), '-> avg', JSON.stringify(avg(trail)));
console.log(`\n  tokens in ${iT} out ${oT} ≈ $${((iT / 1e6) * 1.25 + (oT / 1e6) * 2.50).toFixed(3)}`);
fs.writeFileSync('/tmp/_st_ab.json', JSON.stringify({ old: res.filter((_, i) => i % 2 === 0).map(x => x.text),
                                                      neu: res.filter((_, i) => i % 2 === 1).map(x => x.text) }, null, 2));
