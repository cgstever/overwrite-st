// Test for v7.13.32 — location detection. THE SCENARIO IS THE ONLY SOURCE.
//
// Cody 2026-09-12: "Why are we not just scanning the senecio section not the whole card",
// then: "this it replacing the senerio block with what I want if I want, there should be
// nothing else where locations are located."
//
// The scenario block is the one thing that says where the scene happens and the one thing
// the user replaces, so nothing else feeds the location. Removed: the whole card
// description (the verb "keep" claimed 97 of 439 cards as a castle keep), Location:/Place:/
// Setting: blocks (no card in the library has one), the character's first message, and
// proper nouns scanned across the card (the character's OWN NAME on 55 cards, section
// headings like "Anatomy Snapshot" on 18). Nothing found = no location attribute, which is
// correct: the scenario prose is in the same <scene> block, so a guess could only
// contradict it.
//
// Drives the REAL processTurn so what is asserted is what a chat actually gets.
// Run:  node _scene_location_test.mjs
import fs from 'node:fs';
import path from 'node:path';

const lore = (await import('./x_change_world.js')).default;
const rs = lore.init(lore.data);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS', m)) : (fail++, console.log('  FAIL', m)); };

// processTurn is chatty; only let our own output through
const _log = console.log;
const quiet = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = _log; } };

function locationFor({ description, scenario = '', name = 'Test', firstMes = '',
                       locationOverride = '', scenarioOverride = '' }) {
    const systemText = [description, scenario ? 'Scenario: ' + scenario : ''].filter(Boolean).join('\n');
    const messages = [{ role: 'system', content: systemText }];
    if (firstMes) messages.push({ role: 'assistant', content: firstMes });
    messages.push({ role: 'user', content: 'I walk in.' });
    const state = {};
    const r = quiet(() => lore.processTurn({
        systemText, messages, state, personaState: {}, config: rs,
        charNameHint: name, personaName: 'Cody', personaDescription: '',
        cardPersonality: '', cardDescription: description, cardScenario: scenario,
        cardTags: [], cardExtensions: {}, cardExampleDialogue: '',
        locationOverride, scenarioOverride,
    }));
    const fin = (r && r.state) || state;
    return (fin._scene_tracker && fin._scene_tracker.location) || null;
}

const FILLER = 'Age: 24\n\nBehavioral Traits:\n- Quiet and watchful\n- Slow to trust anyone new\n';

console.log('Part A — unit assertions');

// 1. the bug that started this: a room word in the DESCRIPTION is not a location
ok(locationFor({ description: FILLER + "\nAppearance:\nA cute four inches he can't keep soft in the lingerie." })
   !== 'keep', 'a verb in the description no longer becomes a castle keep');

// 2. a room word in the SCENARIO still works
ok(locationFor({ description: FILLER, scenario: 'She waits for {{user}} in the kitchen, nervous.' })
   === 'kitchen', 'a room named in the scenario is used');

// 3. multi-word rooms still work from the scenario
ok(locationFor({ description: FILLER, scenario: 'They meet in the living room after work.' })
   === 'living room', 'multi-word room from the scenario is used');

// 4. the scenario CARD FIELD counts, not just a "Scenario:" block in the description
ok(locationFor({ description: FILLER, scenario: 'A quiet evening in the dorm room.' })
   === 'dorm room', 'the v2 scenario field is scanned, not only a description block');

// 5. a card's own section headings are never a place
{
    const loc = locationFor({ description: 'Anatomy Snapshot:\nSomething.\n\nKink Profile:\n- Being owned\n' });
    ok(!/Anatomy|Kink|Behavioral|Appearance|Snapshot/i.test(String(loc)),
       `card section headings are not places (got ${JSON.stringify(loc)})`);
}

// 6. the character's own name is never a place
{
    const loc = locationFor({ description: 'Alice Kelly is a quiet woman who works long hours.\n' + FILLER,
                              name: 'Alice Kelly' });
    ok(!/Alice/i.test(String(loc)), `the character's name is not a place (got ${JSON.stringify(loc)})`);
}

// 7. a prose fragment that is not a place is rejected rather than used
{
    const loc = locationFor({ description: FILLER, scenario: 'He looks at her with a warmth in his eyes.' });
    ok(loc !== 'eyes', `a body part is not a place (got ${JSON.stringify(loc)})`);
    const loc2 = locationFor({ description: FILLER, scenario: 'She ties it back in an elegant ponytail.' });
    ok(loc2 !== 'elegant ponytail', `a hairstyle is not a place (got ${JSON.stringify(loc2)})`);
}

// 8. a real place phrase in the scenario IS accepted
ok(locationFor({ description: FILLER, scenario: 'It happens in a private home on the edge of town.' })
   === 'private home', 'a genuine place phrase is accepted');

// 9. nothing usable -> 'unknown', which buildHeader omits from <scene> entirely
ok(locationFor({ description: FILLER }) === 'unknown',
   'no scenario and no place -> unknown (the location attribute is then omitted)');

// 10. the user's scenario override REPLACES the scenario, so the location follows it
{
    const loc = locationFor({ description: FILLER, scenario: 'They meet in the kitchen.',
                              scenarioOverride: 'She is brought to the penthouse to be fitted.' });
    ok(loc === 'penthouse', `location follows a custom scenario, not the card's (got ${JSON.stringify(loc)})`);
}

// 11. an explicit location override still beats anything the scenario implies
{
    const loc = locationFor({ description: FILLER, scenario: 'They meet in the kitchen.',
                              locationOverride: 'a luxury dungeon' });
    ok(loc === 'a luxury dungeon', 'the location override wins over the scenario');
}

// 12. a custom scenario with no place in it clears the card's old location
{
    const loc = locationFor({ description: FILLER, scenario: 'They meet in the kitchen.',
                              scenarioOverride: 'She waits, saying nothing at all.' });
    ok(loc === 'unknown',
       `a scenario with no place leaves no location rather than keeping the old one (got ${JSON.stringify(loc)})`);
}

// ── Part B: sweep the real library ──────────────────────────────────────────
console.log('\nPart B — sweep over the real card library');
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
            if (['chara', 'ccv3'].includes(chunk.toString('ascii', 0, z))) {
                try {
                    const j = JSON.parse(Buffer.from(chunk.slice(z + 1).toString('ascii'), 'base64').toString('utf8'));
                    return j.data || j;
                } catch (_) { /* next */ }
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
    const SECTION_RE = /\b(anatomy|snapshot|kink|behavioral|behavioural|appearance|tendencies|profile|baseline|signature)\b/i;
    let scanned = 0, nameAsPlace = 0, sectionAsPlace = 0, keepCount = 0;
    const keepCards = [];
    for (const f of files) {
        let card; try { card = readCard(path.join(CARD_DIR, f)); } catch (_) { continue; }
        if (!card || !card.description) continue;
        scanned++;
        const loc = locationFor({ description: card.description, scenario: card.scenario || '',
                                  name: card.name || f.replace('.png', '') });
        if (!loc || loc === 'unknown') continue;
        const nameWords = String(card.name || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const locWords = String(loc).toLowerCase().split(/[\s-]+/);
        if (nameWords.some(w => locWords.includes(w))) nameAsPlace++;
        if (SECTION_RE.test(loc)) sectionAsPlace++;
        if (loc === 'keep') { keepCount++; keepCards.push(f.replace('.png', '')); }
    }
    console.log(`  scanned ${scanned} cards`);
    ok(nameAsPlace === 0, `no card uses its own character name as the location (${nameAsPlace} did)`);
    ok(sectionAsPlace === 0, `no card uses one of its section headings as the location (${sectionAsPlace} did)`);
    // 97 before the fix. The remainder are scenarios that genuinely contain the verb
    // "keep"; that is the honest limit of a word-list scan and is tracked, not fixed.
    ok(keepCount <= 12, `"keep" claims at most 12 cards, was 97 (now ${keepCount}: ` +
        keepCards.slice(0, 6).join(', ') + ')');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
