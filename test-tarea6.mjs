import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';

// One real LLM conversation, isolated from the human experiment. No X requests.
const ROOT = import.meta.dirname;
const STORE = mkdtempSync(join(ROOT, '.cache/pilot-integration-test-'));
process.env.EDITORIAL_STORE = STORE;
process.env.EDITORIAL_TEST_MODE = '1';
process.env.EDITORIAL_VARIANT = 't6';
const core = await import('./editorial.mjs');
const hash = path => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
const readJson = path => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const planPath = '.cache/pilot-t6/plan.json';
const plan = readJson(planPath);
const selection = readJson('.cache/validacion-t6/seleccion.json');
const port = process.env.TAREA6_TEST_PORT || '8767';
const base = `http://127.0.0.1:${port}`;
const report = {
  generatedAt: new Date().toISOString(), kind: 'automated_integration_tests_not_human_evaluation',
  sourceSha256: plan.sourceSha256, planSha256: hash(planPath),
  selectedClustering: selection.selected, selectionSha256: hash('.cache/validacion-t6/seleccion.json'),
  groupsSha256: hash('.cache/validacion-t6/grupos.jsonl'),
  codeSha256: Object.fromEntries(['app.mjs', 'editorial.mjs', 'pilot.mjs', 'ensayo.html', 'index.html',
    '.pi/extensions/editorial.ts', '.pi/extensions/proxy.ts', 'test-tarea6.mjs'].map(path => [path, hash(path)])),
  isolatedStore: relative(ROOT, STORE), cases: [], humanEvaluation: null, xApiCalls: 0,
  cost: null, costStatus: 'unknown_proxy_tariff',
};
async function check(name, fn) {
  const start = performance.now();
  try {
    const details = await fn();
    report.cases.push({ name, passed: true, milliseconds: +(performance.now() - start).toFixed(2), ...details });
  } catch (error) {
    report.cases.push({ name, passed: false, milliseconds: +(performance.now() - start).toFixed(2), error: error.message });
    throw error;
  }
}
const server = spawn(process.execPath, ['app.mjs'], { cwd: ROOT,
  env: { ...process.env, PORT: port, EDITORIAL_STORE: STORE, EDITORIAL_TEST_MODE: '1', EDITORIAL_VARIANT: 't6',
    PI_EDITORIAL_PROVIDER: 'biste', PI_EDITORIAL_MODEL: 'gpt-6.1-sol', PI_EDITORIAL_THINKING: 'high' },
  stdio: ['ignore', 'pipe', 'pipe'] });
let serverStarted = false;
server.stdout.on('data', chunk => { if (chunk.toString().includes(`http://127.0.0.1:${port}`)) serverStarted = true; });
server.stderr.resume();
let token, snapshot, pilot;
const get = async path => { const r = await fetch(base + path); assert.equal(r.status, 200); return r.json(); };
const request = (path, data, withToken = true) => fetch(base + path, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base, ...(withToken ? { 'X-Editorial-Token': token } : {}) },
  body: JSON.stringify(data), signal: AbortSignal.timeout(190000) });
const action = async data => { const r = await request('/api/pilot', data); assert.equal(r.status, 200, 'Pilot action failed'); return r.json(); };
try {
  await check('isolated_server_uses_requested_model_and_selected_clustering', async () => {
    for (let n = 0; n < 100; n++) {
      if (server.exitCode !== null) throw Error('The isolated test server exited before startup.');
      if (serverStarted) {
        snapshot = await get('/api/state');
        if (snapshot.error) throw Error(snapshot.error);
        if (snapshot.ready) break;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert(serverStarted && snapshot?.ready, 'The isolated Pi server did not become ready.');
    assert.equal(snapshot.provider, 'biste'); assert.equal(snapshot.model, 'gpt-6.1-sol');
    assert.equal(snapshot.thinking, 'high'); assert.equal(snapshot.clustering, 'kmeans5'); assert.equal(snapshot.testMode, true);
    token = snapshot.csrf;
    report.provider = snapshot.provider; report.model = snapshot.model; report.thinking = snapshot.thinking;
  });
  await check('pilot_initial_state_and_http_token', async () => {
    pilot = await get('/api/pilot');
    assert.equal(pilot.nextTask.id, plan.tasks[0].id); assert.equal(pilot.nextTask.method, 'manual');
    assert.equal(pilot.actor, 'automated_test'); assert.equal(pilot.completedTasks.length, 0);
    assert.equal((await request('/api/pilot', { action: 'start', taskId: plan.tasks[0].id }, false)).status, 403);
  });
  await check('manual_task_blocks_llm_and_limits_corpus', async () => {
    pilot = await action({ action: 'start', taskId: plan.tasks[0].id });
    assert.equal(pilot.activeTask.method, 'manual');
    assert.equal((await request('/api/message', { message: 'No ejecutar: prueba automática de bloqueo.' })).status, 403);
    assert.deepEqual(core.corpus().rows.map(r => r.id).sort(), plan.tasks[0].sources.map(r => r.id).sort());
  });
  await check('synthetic_manual_task_is_incomplete_and_not_human', async () => {
    pilot = await action({ action: 'finish', taskId: plan.tasks[0].id, markdown: '', complete: false });
    assert.equal(pilot.completedTasks[0].complete, false); assert.equal(pilot.completedTasks[0].actor, 'automated_test');
    assert.equal(pilot.completedTasks[0].outcome, 'stopped_incomplete');
    assert.equal(pilot.nextTask.id, plan.tasks[1].id);
  });
  await check('assisted_task_starts_with_empty_editorial_state', async () => {
    pilot = await action({ action: 'start', taskId: plan.tasks[1].id });
    snapshot = await get('/api/state');
    assert.equal(pilot.activeTask.method, 'assisted');
    assert.equal(snapshot.brief, null); assert.equal(snapshot.ranking, null); assert.equal(snapshot.history.length, 0);
    assert.deepEqual(core.corpus().rows.map(r => r.id).sort(), plan.tasks[1].sources.map(r => r.id).sort());
    const outside = plan.tasks[0].sources[0].id;
    assert.throws(() => core.evidence([outside]), /fuera del corpus/);
  });
  await check('real_assisted_conversation_saves_supported_draft', async () => {
    const r = await request('/api/message', { message: 'Prepara y guarda la mini-ficha del ejercicio actual en inglés. Usa solo las fuentes de este paquete y deja la decisión final al operador.' });
    assert.equal(r.status, 200);
    const events = (await r.text()).trim().split('\n').map(JSON.parse);
    const done = events.find(e => e.type === 'done');
    assert(done, 'No final conversation event.'); assert.equal(done.error, null, 'The live LLM call failed.');
    const tools = events.filter(e => e.type === 'tool').map(e => e.name);
    assert(tools.includes('editorial_opportunities')); assert(tools.includes('save_content_brief'));
    const b = done.state.brief, ranking = done.state.ranking;
    assert.equal(b?.status, 'draft'); assert.equal(b.author, 'agent'); assert.equal(ranking.clustering, 'kmeans5');
    assert.equal(done.state.decisions.length, 0);
    const sources = plan.tasks[1].sources;
    assert(ranking.opportunities.every(g => g.evidence.every(e => sources.some(s => s.id === e.id))));
    assert(new Set(b.claims.map(c => c.evidenceId)).size >= 2, 'The brief needs claims attributed to two different sources.');
    for (const claim of b.claims) {
      const source = sources.find(s => s.id === claim.evidenceId);
      assert(source, 'A brief claim references a source outside the active package.');
      assert(source.text.includes(claim.quote), 'A claimed quotation is not literal.');
      assert(b.markdown.includes(claim.evidenceId), 'A claimed source is absent from the brief.');
    }
    snapshot = done.state;
    const words = b.markdown.trim().split(/\s+/u).length;
    return { elapsedSeconds: done.elapsedSeconds, tools, claimsWithLiteralQuotes: b.claims.length,
      briefWords: words, suggestedWordRange: [120, 180], withinSuggestedWordRange: words >= 120 && words <= 180 };
  });
  await check('third_task_resets_editorial_state_and_restricts_new_package', async () => {
    pilot = await action({ action: 'finish', taskId: plan.tasks[1].id, markdown: snapshot.brief.markdown, complete: false });
    assert(pilot.completedTasks.every(t => !t.complete && t.actor === 'automated_test'));
    pilot = await action({ action: 'start', taskId: plan.tasks[2].id });
    snapshot = await get('/api/state');
    assert.equal(pilot.activeTask.id, plan.tasks[2].id); assert.equal(snapshot.history.length, 0);
    assert.equal(snapshot.brief, null); assert.equal(snapshot.ranking, null); assert.equal(snapshot.decisions.length, 0);
    assert.deepEqual(core.corpus().rows.map(r => r.id).sort(), plan.tasks[2].sources.map(r => r.id).sort());
    assert.throws(() => core.evidence([plan.tasks[1].sources[0].id]), /fuera del corpus/);
    const resets = readFileSync(join(STORE, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type === 'pilot_session_reset');
    assert.equal(resets.length, 3); assert.equal(new Set(resets.map(e => e.sessionId)).size, 3);
    assert(resets.every(e => e.sessionId !== e.previousSessionId && e.provider === 'biste' && e.model === 'gpt-6.1-sol' && e.thinking === 'high'));
    assert.equal(snapshot.sessionId, resets.at(-1).sessionId);
    const pointer = JSON.parse(readFileSync(join(STORE, 'pi-session.json'), 'utf8'));
    assert.equal(pointer.sessionId, snapshot.sessionId);
    return { distinctPiSessions: resets.length, initialMessageCounts: resets.map(e => e.messageCount) };
  });
  await check('actual_requests_use_high_and_cost_remains_unknown', async () => {
    const events = readFileSync(join(STORE, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const calls = events.filter(e => e.type === 'llm_request');
    assert(calls.length >= 2); assert(calls.every(e => e.model === 'gpt-6.1-sol' && e.thinking === 'high'));
    const run = events.findLast(e => e.type === 'conversation_run');
    assert.equal(run.test, true); assert.equal(run.stats.cost, null); assert.equal(run.stats.costStatus, 'unknown_proxy_tariff');
    assert.equal(events.filter(e => e.type === 'conversation_run').length, 1);
    return { providerRequests: calls.length, tokens: run.stats.tokens };
  });
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  if (process.env.TAREA6_KEEP_SERVER === '1' && !report.failure) {
    report.testServer = { pid: server.pid, url: base, retainedForVisualReview: true };
  } else {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  report.finishedAt = new Date().toISOString();
  report.total = report.cases.length; report.passed = report.cases.filter(c => c.passed).length;
  report.success = report.passed === report.total && !report.failure;
  writeFileSync(join(ROOT, 'evaluacion-tarea6.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ success: report.success, passed: report.passed, total: report.total,
    failure: report.failure, artifact: 'evaluacion-tarea6.json', isolatedStore: report.isolatedStore, testServer: report.testServer }, null, 2));
}
