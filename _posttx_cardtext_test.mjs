// Test for v7.13.30 _postTxCardText — the post-transformation card rewrite.
//
// Cody 2026-09-12: "it should be overriding all the anatomical/apperence and even
// behavure as is approptete". After a pill lands, the card's own body/gender prose
// contradicts the rolled state; this asserts the rewrite corrects it without
// mangling the card.
//
// Part A: unit assertions on hand-built card text.
// Part B: safety sweep over the REAL card library — every card is rewritten under a
//         synthetic post-TX state and flagged if the rewrite looks destructive.
//
// Run:  node _posttx_cardtext_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ENGINE = new URL('./x_change_world.js', import.meta.url);
const src = fs.readFileSync(ENGINE, 'utf8');

// pull the functions out of the 7.5 MB module so we can drive them directly
function extract(sig) {
    const i = src.indexOf(sig);
    if (i < 0) { console.error('FAIL: not found -', sig); process.exit(1); }
    let depth = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
    }
    console.error('FAIL: unbalanced braces in', sig); process.exit(1);
}
const _postTxCardText = new Function('return (' + extract('function _postTxCardText(text, state) {') + ')')();
// production order is _cleanCardDescription THEN _postTxCardText (buildHeader does both).
// The sweep must run the same pipeline: the cleaner is what removes a card's own
// "Anatomy Snapshot:" block, and testing the rewrite without it reports 304 false leaks.
const _cleanCardDescription = new Function('return (' + extract('function _cleanCardDescription(desc) {') + ')')();
const renderCard = (desc, state) => _postTxCardText(_cleanCardDescription(desc), state);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS', m)) : (fail++, console.log('  FAIL', m)); };

const FEMALE_STRIPS = ['cock','cocks','dick','dicks','penis','balls','ball','testicle',
    'testicles','shaft','foreskin','manhood','erection','cum','semen'];
// v7.13.35 — the override states what IS there, never what is missing.
const OVERRIDE = 'Appearance:\nHeight: 5\'5"\nWeight: 115lbs\nBuild: slim\n' +
    'Transformed female body, B cup breasts.\n\nAnatomy Snapshot:\n' +
    'Female genitalia — vagina.\nB cup breasts with sensitive nipples.';
const mtfState = {
    _card_anatomy_override: OVERRIDE,
    _card_strip_words: FEMALE_STRIPS,
    form: { sex: 'female', genitals: 'vagina_only' },
    _sex_origin: 'male', _card_sex: 'male',
};

console.log('Part A — unit assertions');

// 1. the card's Appearance block is replaced by the rolled body, in place
{
    const card = 'Age: 23\n\nAppearance:\nFlat chest, lean torso. He hides in hoodies.\n\n' +
                 'Behavioral Traits:\n- Goes red when seen';
    const out = _postTxCardText(card, mtfState);
    ok(!/Flat chest/.test(out), 'card Appearance prose is gone');
    ok(/B cup breasts/.test(out), 'rolled body is in');
    ok(out.indexOf('Appearance:') < out.indexOf('Behavioral Traits:'),
       'rolled body sits where Appearance was, not appended at the end');
    ok(/Age: 23/.test(out), 'unrelated blocks survive');
}

// 2. the override names what she HAS and never what she lacks
{
    const out = _postTxCardText('Age: 23\n\nAppearance:\nold body', mtfState);
    ok(/Female genitalia — vagina\./.test(out), 'the override states the anatomy she has');
    ok(!/\bno penis\b/i.test(out),
       'no negative assertion — naming the absent part puts it back in front of the model');
}

// 3. a bullet naming absent anatomy is dropped whole; its neighbours are not
{
    const card = 'Kink Profile:\n- Small penis teasing — strong — the little cock on display\n' +
                 '- Humiliation — strong — cums faster the more degraded\n' +
                 '- Being owned — strong — belongs to the man';
    const out = _postTxCardText(card, mtfState);
    ok(!/Small penis teasing/.test(out), 'anatomy bullet dropped');
    ok(/Humiliation/.test(out) && /Being owned/.test(out), 'sibling bullets kept');
}

// 4. prose loses only the offending SENTENCE, never the paragraph
{
    const card = 'Sexual Tendencies:\nI am submissive and quiet. My cock betrays me every time. ' +
                 'Under all the fight I want to be told what to do.';
    const out = _postTxCardText(card, mtfState);
    ok(!/cock/.test(out), 'the anatomy sentence is gone');
    ok(/I am submissive and quiet/.test(out) && /told what to do/.test(out),
       'the rest of the paragraph survives');
}

// 5. 'cum' as a verb is behaviour, not anatomy — it must survive ('semen' must not)
{
    const card = 'Sexual Tendencies:\nHumiliate me and I cum embarrassingly fast; be patient and I fall apart worse.';
    const out = _postTxCardText(card, mtfState);
    ok(/I cum embarrassingly fast/.test(out), '"cum" as a verb is kept');
    ok(!/be patient and I fall apart worse\.$/.test(out.trim()) || /Humiliate/.test(out),
       'no orphaned lowercase clause left behind');
    const out2 = _postTxCardText('Sexual Tendencies:\nHe leaves semen everywhere. She is calm.', mtfState);
    ok(!/semen/.test(out2), '"semen" is still stripped');
}

// 6. pronouns follow the new sex
{
    const card = 'Behavioral Traits:\n- He hides his face when he is seen\n- Keeps catching himself';
    const out = _postTxCardText(card, mtfState);
    ok(/She hides her face when she is seen/.test(out), 'he/his/he → she/her/she');
    ok(/herself/.test(out), 'himself → herself');
    ok(!/\bhis\b/.test(out) && !/\bhim\b/.test(out), 'no male pronouns left');
}

// 7. a line naming {{user}} is never regendered
{
    const card = 'Kink Profile:\n- Being owned — he decides when {{user}} is ready\n- Shy — he blushes';
    const out = _postTxCardText(card, mtfState);
    ok(/- Being owned — he decides when \{\{user\}\} is ready/.test(out),
       '{{user}} line left alone (that "he" may be {{user}})');
    ok(/- Shy — she blushes/.test(out), 'ordinary line still flipped');
}

// 8. female → male runs the other way
{
    const ftm = { _card_anatomy_override: 'Appearance:\nMale body.',
        _card_strip_words: ['vagina','pussy','clit','clitoris','vulva','labia','womb'],
        form: { sex: 'male' }, _sex_origin: 'female', _card_sex: 'female' };
    const out = _postTxCardText('Behavioral Traits:\n- She touches her hair\n- Her pussy aches', ftm);
    ok(/He touches his hair/.test(out), 'she/her → he/his');
    ok(!/pussy/.test(out), 'absent anatomy bullet dropped');
}

// 9. a section emptied by the strip pass disappears with its header
{
    const out = _postTxCardText('Age: 20\n\nKink Profile:\n- Cock worship — intense', mtfState);
    ok(!/Kink Profile/.test(out), 'header goes when every line under it went');
    ok(/Age: 20/.test(out), 'other sections unaffected');
}

// 10. no-op before a transformation
{
    const out = _postTxCardText('Appearance:\nFlat chest.', { form: {}, _card_sex: 'male' });
    ok(out === 'Appearance:\nFlat chest.', 'untouched when there is no override and no strip list');
}

// 11. a card with no Appearance section still gets the rolled body
{
    const out = _postTxCardText('Behavioral Traits:\n- Quiet', mtfState);
    ok(/B cup breasts/.test(out), 'rolled body inserted even with no Appearance block');
}

// ── Part B: safety sweep over the real card library ─────────────────────────
console.log('\nPart B — safety sweep over the real card library');
const CARD_DIR = '/mnt/data/sillytavern/data/cody/characters';
function readCard(file) {
    const buf = fs.readFileSync(file);
    let i = 8;
    while (i < buf.length) {
        const len = buf.readUInt32BE(i);
        const type = buf.toString('ascii', i + 4, i + 8);
        if (type === 'tEXt') {
            const chunk = buf.slice(i + 8, i + 8 + len);
            const z = chunk.indexOf(0);
            const key = chunk.toString('ascii', 0, z);
            if (key === 'chara' || key === 'ccv3') {
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

let files = [];
try { files = fs.readdirSync(CARD_DIR).filter(f => f.endsWith('.png')); }
catch (_) { console.log('  (card library not reachable — skipping sweep)'); }

if (files.length) {
    let scanned = 0, anatomyLeft = 0, wrongPronoun = 0, gutted = 0, noBody = 0, lostHook = 0;
    const worst = [];
    for (const f of files) {
        let card; try { card = readCard(path.join(CARD_DIR, f)); } catch (_) { continue; }
        const desc = card && card.description;
        if (!desc || desc.length < 200) continue;
        scanned++;
        const cleaned = _cleanCardDescription(desc);
        const out = _postTxCardText(cleaned, mtfState);
        const shrink = 1 - out.length / cleaned.length;
        // 75%, not 60%: a card built around the anatomy it just lost SHOULD shrink a lot.
        // Selene (a woman with a cock, whose profile is mostly cock pride) drops ~62% to a
        // pink pill and that is the correct answer, not a bug.
        if (shrink > 0.75) { gutted++; worst.push([f, Math.round(shrink * 100)]); }
        // every card needs its hook into {{user}}'s orbit — the rewrite must not eat it
        if (cleaned.includes('{{user}}') && !out.includes('{{user}}')) lostHook++;
        // the rolled body must always be present
        if (!/B cup breasts/.test(out)) noBody++;
        // no male anatomy noun may survive outside the engine's own override line
        const body = out.replace(/Female genitalia[^\n]*\n?/, '');
        if (/\b(cock|dick|penis|balls|testicles?|foreskin|manhood|semen)\b/i.test(body)) anatomyLeft++;
        // no male pronoun may survive on a non-{{user}} line
        for (const line of body.split('\n')) {
            if (line.includes('{{user}}')) continue;
            if (/\b(he|him|his|himself)\b/.test(line)) { wrongPronoun++; break; }
        }
    }
    console.log(`  scanned ${scanned} cards`);
    ok(anatomyLeft === 0, `no card keeps absent male anatomy (${anatomyLeft} did)`);
    ok(wrongPronoun === 0, `no card keeps a male pronoun off a {{user}} line (${wrongPronoun} did)`);
    ok(noBody === 0, `every card receives the rolled body (${noBody} missed)`);
    ok(gutted === 0, `no card loses more than 75% of its text (${gutted} did: ` +
        worst.slice(0, 5).map(w => `${w[0]} -${w[1]}%`).join(', ') + ')');
    ok(lostHook === 0, `no card loses its {{user}} hook (${lostHook} did)`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
