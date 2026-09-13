// Five swipes of the same transformation turn: are they actually different?
//
// Cody 2026-09-12: "on the tx block did 5 swipes read the same like it used to or were they
// all unique."
//
// OLD side is free — the 2026-09-12 Cilla chat has four real swipes of a pill turn saved in
// it, generated at the time. NEW side runs five swipes through the engine as it stands now,
// each one a fresh processTurn (so the body re-rolls, as a real swipe does) plus one
// generation. Similarity is pairwise Jaccard over 5-word shingles, which catches reused
// phrasing rather than reused ideas.
//
// Run:  node _swipe_variety_test.mjs
import fs from 'node:fs';

const lore = (await import('./x_change_world.js')).default;
const rs = lore.init(lore.data);
const _log = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = _log; } };

const ROOT = '/mnt/data/sillytavern/data/cody';
const MODEL = 'grok-4.3';
const KEY = (fs.readFileSync('/mnt/books/Claude/api-keys.txt', 'utf8').match(/\bxai-[A-Za-z0-9]{20,}/) || [])[0];

async function ask(messages) {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0.9, max_tokens: 1400 }),
    });
    const j = await res.json();
    if (!res.ok) return { text: '', err: JSON.stringify(j).slice(0, 160), usage: null };
    return { text: (((j.choices || [])[0] || {}).message || {}).content || '', usage: j.usage || null };
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

const prose = (t) => String(t).replace(/<scene_state>[\s\S]*/, '').trim();
const shingles = (t) => {
    const w = prose(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const s = new Set();
    for (let i = 0; i + 4 < w.length; i++) s.add(w.slice(i, i + 5).join(' '));
    return s;
};
function pairwise(texts) {
    const sets = texts.map(shingles);
    const scores = [];
    for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
            const a = sets[i], b = sets[j];
            const inter = [...a].filter(x => b.has(x)).length;
            const uni = new Set([...a, ...b]).size;
            scores.push(uni ? inter / uni : 0);
        }
    }
    return scores;
}
const pct = (n) => (n * 100).toFixed(1) + '%';
const open12 = (t) => prose(t).split(/\s+/).slice(0, 12).join(' ');

// ── OLD: the four real swipes saved in the chat ──────────────────────────────
const CHAT = `${ROOT}/chats/Cilla/Cilla - 2026-09-12@10h35m14s179ms.jsonl`;
const rows = fs.readFileSync(CHAT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const txRow = rows.find(r => Array.isArray(r.swipes) && r.swipes.length > 1);
const oldSwipes = (txRow && txRow.swipes) || [];

console.log(`OLD — ${oldSwipes.length} real swipes saved in the chat (generated at the time)`);
oldSwipes.forEach((s, i) => console.log(`  ${i + 1}. ${open12(s)}…`));
const oldScores = pairwise(oldSwipes);
console.log(`  pairwise phrase overlap: ${oldScores.map(pct).join('  ')}`);
console.log(`  average ${pct(oldScores.reduce((a, b) => a + b, 0) / (oldScores.length || 1))}`);

// ── NEW: five swipes through the engine as it stands ─────────────────────────
// The pill turn, the state on the message before it, and — critically — the user message
// that IS that turn. Grabbing the first user line mentioning a pill picks the OFFER, not
// the swallow, and then no transformation fires at all: the first run came back with five
// variations on "I stare at the pill in your hand" and a 6.6k payload with no directive.
let txIdx = -1;
for (let i = 0; i < rows.length; i++) {
    const v = rows[i].variables; if (!v) continue;
    const slots = Array.isArray(v) ? v : Object.values(v);
    if (slots.some(x => x && x.state && (x.state._pill_descriptor_this_turn || x.state._pre_tx_card_body))) { txIdx = i; break; }
}
const preState = (() => {
    for (let j = txIdx - 1; j >= 0; j--) {
        const pv = rows[j].variables; if (!pv) continue;
        for (const y of (Array.isArray(pv) ? pv : Object.values(pv))) if (y && y.state) return y.state;
    }
    return null;
})();
const userMsg = (txIdx > 0 && rows[txIdx - 1].is_user) ? rows[txIdx - 1].mes : '*I watch Cilla swallow the pill*';
const card = readCard(`${ROOT}/characters/Cilla.png`);
const systemText = [card.description, card.personality, card.scenario ? 'Scenario: ' + card.scenario : ''].filter(Boolean).join('\n');

const newTexts = [], bodies = [];
let inTok = 0, outTok = 0, payloadChars = 0;
const jobs = [];
for (let k = 0; k < 5; k++) {
    const st = JSON.parse(JSON.stringify(preState));
    st._last_user_msg_hash = null; st._frag_seen = [];
    delete st._scene_tracker;
    const r = quiet(() => lore.processTurn({
        systemText, messages: [{ role: 'system', content: systemText }, { role: 'user', content: userMsg }],
        state: st, personaState: {}, config: rs,
        charNameHint: 'Cilla', personaName: 'Cody', personaDescription: '',
        cardPersonality: card.personality || '', cardDescription: card.description || '',
        cardScenario: card.scenario || '', cardTags: card.tags || [],
        cardExtensions: card.extensions || {}, cardExampleDialogue: card.mes_example || '',
        locationOverride: 'luxury private dungeon', scenarioOverride: '',
    }));
    const inj = r.inject || [];
    const after = inj.filter(i => i.position === 'after_last_user').map(i => i.text).join('\n\n');
    const prefill = (inj.find(i => i.position === 'prefill') || {}).text || '*';
    const msgs = [{ role: 'system', content: r.systemPrompt || '' },
                  { role: 'user', content: after ? `${userMsg}\n\n${after}` : userMsg },
                  { role: 'assistant', content: prefill }];
    if (r.priorityDirective) msgs.push({ role: 'system', content: r.priorityDirective });
    if (k === 0) {
        payloadChars = msgs.map(m => m.content).length && msgs.reduce((n, m) => n + m.content.length, 0);
        console.log(`\nPAYLOAD, every message added up: ${payloadChars} chars across ${msgs.length} messages`);
        msgs.forEach((m, i) => console.log(`   [${i}] ${m.role.padEnd(9)} ${String(m.content.length).padStart(6)}`));
    }
    if (k === 0) console.log(`   TX turn fired: ${!!r.priorityDirective}  |  user message: ${JSON.stringify(userMsg.slice(0, 50))}`);
    const b = r.state.resolved_body || {};
    bodies.push(`${b.height || '?'} ${b.weight || '?'} ${b.bust || '?'} ${b.build || '?'}`);
    jobs.push(ask(msgs));
}
const res = await Promise.all(jobs);
for (const x of res) { if (x.usage) { inTok += x.usage.prompt_tokens || 0; outTok += x.usage.completion_tokens || 0; } newTexts.push(x.text); }

console.log(`\nNEW — 5 swipes, each a fresh roll`);
newTexts.forEach((s, i) => console.log(`  ${i + 1}. [${bodies[i]}] ${open12(s)}…`));
const newScores = pairwise(newTexts);
console.log(`  pairwise phrase overlap: ${newScores.map(pct).join('  ')}`);
console.log(`  average ${pct(newScores.reduce((a, b) => a + b, 0) / (newScores.length || 1))}`);
console.log(`\ntokens in ${inTok} out ${outTok} ≈ $${((inTok / 1e6) * 1.25 + (outTok / 1e6) * 2.50).toFixed(3)}`);
fs.writeFileSync('/tmp/_swipes_out.json', JSON.stringify({ old: oldSwipes, new: newTexts, bodies }, null, 2));
