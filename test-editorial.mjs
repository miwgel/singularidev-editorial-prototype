import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

process.env.EDITORIAL_STORE = mkdtempSync(join(import.meta.dirname, '.cache/editorial-test-'));
process.env.EDITORIAL_TEST_MODE = '1';
// Preserve the Tarea 5 regression fixture; the selected Tarea 6 corpus is checked separately.
process.env.EDITORIAL_VARIANT = 'baseline';
const core = await import('./editorial.mjs');
const cases = [];
function check(name, fn) { const start = performance.now(); fn(); cases.push({ name, passed: true, milliseconds: +(performance.now() - start).toFixed(2) }); }
let ranking, draft;
check('three_ranked_opportunities', () => {
  ranking = core.opportunities({ focus: 'Agentes para emprendedores', terms: ['agent', 'automation', 'coding', 'claude'] });
  assert.equal(ranking.opportunities.length, 3);
  assert.deepEqual(ranking.opportunities.map(g => g.group), [3, 2, 5]);
  assert(ranking.opportunities.every((g, i, all) => !i || all[i-1].score >= g.score));
});
check('ranking_is_deterministic', () => {
  const again = core.opportunities({ focus: ranking.focus, terms: ranking.terms });
  assert.deepEqual(again.opportunities, ranking.opportunities); ranking = again;
});
check('test_partition_remains_excluded', () => {
  const { rows, baseline } = core.corpus();
  const split = JSON.parse(readFileSync(join(core.ROOT, '.cache/baseline', baseline.source_sha256.slice(0, 12), 'particiones.json')));
  assert.equal(rows.length, 79); assert(rows.every(r => r.split !== 'test'));
  const ids = JSON.stringify(split.test); assert(rows.every(r => !ids.includes(r.id)));
});
check('valid_brief_draft_with_literal_sources', () => {
  const g = ranking.opportunities[0], r = g.evidence[0];
  draft = { opportunityVersion: ranking.version, group: g.group, title: 'Test draft, not a human evaluation', markdown: `# Draft for automated testing\n\nThis is an editorial hypothesis for an English-language video. A post describes an agent workflow; its content has not been independently verified. The proposed outline is a suggestion, not an observed result.\n\nSource: ${r.url}`, claims: [{ statement: 'The post discusses agents.', evidenceId: r.id, quote: r.text.slice(0, 50) }] };
  core.saveBrief(draft); assert.equal(core.state().brief.status, 'draft');
});
check('fabricated_quote_and_unknown_id_rejected', () => {
  assert.throws(() => core.saveBrief({ ...draft, claims: [{ ...draft.claims[0], quote: 'A completely fabricated quotation without source support.' }] }));
  assert.throws(() => core.evidence(['not-an-id']));
});
check('missing_reason_and_stale_version_rejected', () => {
  const b = core.state().brief;
  assert.throws(() => core.decide({ version: b.version, action: 'accept', reason: '' }));
  assert.throws(() => core.decide({ version: 'obsolete', action: 'accept', reason: 'A valid reason' }));
});
check('human_controls_accept_edit_reject_and_persist_reason', () => {
  const b = core.state().brief;
  core.decide({ version: b.version, action: 'accept', reason: 'Automated control test, not the operator approval.' });
  const edit = core.decide({ version: b.version, action: 'edit', reason: 'Test a reversible editorial correction.', markdown: b.markdown + '\n\nProposed revision for testing.' });
  assert.notEqual(edit.newVersion, b.version); assert.equal(core.state().brief.claimsNeedReview, true);
  core.decide({ version: edit.newVersion, action: 'reject', reason: 'Reject this synthetic test brief.' });
  assert.deepEqual(core.state().decisions.map(d => d.action), ['accept', 'edit', 'reject']);
  assert(core.state().decisions.every(d => d.actor === 'automated_test'));
});
check('resume_state_from_fresh_process', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import {state} from './editorial.mjs'; console.log(JSON.stringify(state()));"], { cwd: core.ROOT, env: process.env, encoding: 'utf8' });
  assert.equal(result.status, 0); const recovered = JSON.parse(result.stdout);
  assert.equal(recovered.decisions.length, 3); assert.equal(recovered.brief.status, 'rejected');
});
check('focus_change_recomputes_candidates', () => {
  const next = core.opportunities({ focus: 'Permisos y acceso', terms: ['permission', 'sandbox', 'access', 'security'] });
  assert.notEqual(next.version, ranking.version); assert.notDeepEqual(next.opportunities.map(g => g.group), ranking.opportunities.map(g => g.group));
  assert.throws(() => core.saveBrief(draft));
});
check('unsupported_topic_does_not_invent_candidates', () => {
  const missing = core.opportunities({ focus: 'Riego de cacao en Ecuador', terms: ['irrigation', 'cacao', 'ecuador'] });
  assert.equal(missing.opportunities.length, 0); assert.equal(missing.status, 'insufficient_for_three');
});
const report = { generatedAt: new Date().toISOString(), kind: 'automated_functional_tests_not_human_evaluation', codeSha256: core.codeHash(), total: cases.length, passed: cases.filter(c => c.passed).length, cases };
core.save('functional-tests.json', report);
console.log(JSON.stringify({ ...report, artifact: join(core.STORE, 'functional-tests.json') }, null, 2));
if (process.argv.includes('--live')) {
  // Uses the installed Pi account, not X. Test decisions are explicitly marked and isolated.
  const testStore = mkdtempSync(join(core.ROOT, '.cache/editorial-live-test-'));
  const server = spawn(process.execPath, ['app.mjs'], { cwd: core.ROOT, env: { ...process.env, EDITORIAL_STORE: testStore, PORT: '8766' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; server.stderr.on('data', b => stderr += b.toString()); server.stdout.resume();
  const url = 'http://127.0.0.1:8766';
  let snapshot, token;
  const live = [];
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { snapshot = await (await fetch(url + '/api/state')).json(); if (snapshot.error) throw Error(snapshot.error); if (snapshot.ready) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert(snapshot?.ready, 'Pi did not start: ' + stderr); token = snapshot.csrf;
    async function request(path, data, withToken = true) {
      return fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(withToken ? { 'X-Editorial-Token': token } : {}) }, body: JSON.stringify(data) });
    }
    async function converse(name, prompt, verify) {
      const response = await request('/api/message', { message: prompt });
      assert.equal(response.status, 200);
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      const done = events.find(e => e.type === 'done');
      assert(done, 'No completed event'); assert.equal(done.error, null); verify(done);
      live.push({ name, passed: true, elapsedSeconds: done.elapsedSeconds, tools: events.filter(e => e.type === 'tool').map(e => e.name), response: done.text });
      console.log(JSON.stringify({ name, passed: true, elapsedSeconds: done.elapsedSeconds }));
      snapshot = done.state;
    }
    assert.equal((await request('/api/decision', {}, false)).status, 403);
    live.push({ name: 'http_requires_local_token', passed: true });
    await converse('three_opportunities_from_natural_request', 'Necesito tres ideas prácticas de videos en inglés sobre agentes y automatización para emprendedores individuales de SingulariDev. Usa el lote existente, explica la puntuación y cita las fuentes. No prepares todavía la ficha.', d => assert.equal(d.state.ranking?.opportunities.length, 3));
    const selected = snapshot.ranking.opportunities[1].group;
    await converse('english_brief_from_selected_opportunity', `Elijo la oportunidad del grupo ${selected}. Prepara y guarda una ficha en inglés con título, audiencia, problema, estructura, evidencia atribuida y una invitación propuesta a SingulariDev. No la apruebes.`, d => { assert.equal(d.state.brief?.status, 'draft'); assert.equal(d.state.brief.group, selected); assert(d.state.brief.claims.length >= 1); });
    const brief = snapshot.brief;
    for (const action of ['accept', 'edit', 'reject']) {
      const r = await request('/api/decision', { version: snapshot.brief.version, action, reason: `Automated HTTP ${action} test. Not a human editorial rating.`, markdown: brief.markdown + '\n\nEditorial note added by automated test.' });
      assert.equal(r.status, 200); snapshot = (await r.json()).state;
    }
    assert(snapshot.decisions.every(d => d.actor === 'automated_test'));
    live.push({ name: 'http_accept_edit_reject', passed: true, count: snapshot.decisions.length });
    const oldVersion = snapshot.ranking.version;
    await converse('conversational_focus_change', 'Cambia el enfoque: quiero hablar exclusivamente de permisos, acceso y sandbox para agentes. Recalcula las oportunidades disponibles y no fuerces tres si faltan fuentes.', d => { assert.notEqual(d.state.ranking.version, oldVersion); assert(d.state.ranking.terms.some(t => /permission|access|sandbox|security/.test(t))); });
    await converse('insufficient_evidence_without_invention', 'Ahora necesito tendencias de riego de cacao en Ecuador. No uses analogías con agentes ni otra temática. Comprueba si el lote permite sostenerlas y no inventes evidencia.', d => { assert.equal(d.state.ranking.opportunities.length, 0); assert.equal(d.state.ranking.status, 'insufficient_for_three'); assert.equal(d.state.brief.status, 'rejected'); });
    const final = { ...report, liveTests: live, livePassed: live.length, liveArtifactDirectory: testStore, humanEvaluation: null, xApiCalls: 0 };
    core.save('evaluation.json', final);
    console.log(JSON.stringify({ evaluationArtifact: join(core.STORE, 'evaluation.json'), liveTests: live.length, passed: true }));
  } finally { server.kill('SIGTERM'); }
}
