import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, STORE, TEST_MODE, read, save, audit, state, decide, codeHash } from './editorial.mjs';
import { pilotState, pilotAction } from './pilot.mjs';

const port = Number(process.env.PORT || 8765);
const origin = `http://127.0.0.1:${port}`;
const csrf = randomUUID();
const credentialsFile = join(ROOT, '.cache/llm.env');
if (!process.env.BISTE_LLM_API_KEY && existsSync(credentialsFile)) process.loadEnvFile(credentialsFile);
const provider = process.env.PI_EDITORIAL_PROVIDER || (process.env.BISTE_LLM_API_KEY ? 'biste' : 'openai-codex');
const model = process.env.PI_EDITORIAL_MODEL || (provider === 'biste' ? 'gpt-6.1-sol' : 'gpt-5.5');
const thinking = process.env.PI_EDITORIAL_THINKING || (provider === 'biste' ? 'high' : 'low');
const costStatus = provider === 'biste' ? 'unknown_proxy_tariff' : 'catalog_estimate_not_invoice';
if (provider === 'biste' && !process.env.BISTE_LLM_API_KEY) throw Error('Falta BISTE_LLM_API_KEY en el entorno o .cache/llm.env.');
const args = ['--mode', 'rpc', '--provider', provider, '--model', model, '--thinking', thinking,
  '--no-extensions', ...(provider === 'biste' ? ['-e', join(ROOT, '.pi/extensions/proxy.ts')] : []),
  '-e', join(ROOT, '.pi/extensions/editorial.ts'), '--no-builtin-tools',
  '--tools', 'editorial_opportunities,editorial_evidence,editorial_state,save_content_brief',
  '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--offline',
  '--session-dir', STORE, '--session', read('pi-session.json')?.sessionFile || join(STORE, 'session.jsonl')];
const child = spawn(process.env.PI_BIN || 'pi', args, { cwd: ROOT, env: { ...process.env, PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
let pending = new Map(), buffer = '', active = null, failure = null, ready = false, changingExercise = false, sessionId = null;
let history = read('chat.json', []);
function command(type, data = {}) {
  if (failure) return Promise.reject(Error(failure));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Pi no respondió a ${type}.`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n');
  });
}
function send(record) { if (active && !active.res.destroyed) active.res.write(JSON.stringify(record) + '\n'); }
async function finish(error) {
  if (!active || active.finishing) return;
  const run = active; run.finishing = true; clearTimeout(run.timer);
  let stats = null;
  try {
    if (!failure) {
      stats = await command('get_session_stats');
      // Pi requires numeric catalog prices. The proxy tariff is unknown, so its
      // placeholder arithmetic must never become an observed zero-dollar cost.
      if (provider === 'biste') stats.cost = null;
      stats.costStatus = costStatus;
    }
  } catch {}
  const elapsedSeconds = +(performance.now() - run.started).toFixed(0) / 1000;
  const text = run.messages.join('\n\n') || run.partial || 'No hubo una respuesta de texto.';
  history.push({ role: 'assistant', text, at: new Date().toISOString(), error: error || null });
  save('chat.json', history);
  audit('conversation_run', { prompt: run.prompt, response: text, elapsedSeconds, toolCalls: run.tools, provider, model, thinking, costStatus, outcome: error ? 'error' : 'completed', error: error || null, stats, codeSha256: codeHash() });
  send({ type: 'done', text, error: error || null, elapsedSeconds, state: state() });
  run.res.end(); active = null;
}
function broken(message) {
  failure = message; ready = false;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error(message)); }
  pending.clear(); void finish(message);
}
child.on('error', () => broken('No se pudo iniciar Pi. Comprueba PI_BIN y la instalación.'));
child.on('exit', code => broken(`Pi terminó (${code}). Reinicia el servidor para recuperar la sesión.`));
child.stdin.on('error', () => broken('Se cerró la conexión con Pi.'));
child.stderr.on('data', data => { /* Diagnostics remain local; never expose credentials in the UI. */ process.stderr.write(data); });
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
    if (!line) continue;
    let event; try { event = JSON.parse(line); } catch { broken('Pi devolvió un registro inválido.'); continue; }
    if (event.type === 'response') {
      const item = pending.get(event.id);
      if (item) { clearTimeout(item.timer); pending.delete(event.id); event.success ? item.resolve(event.data) : item.reject(Error(event.error)); }
    }
    if (!active) continue;
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      active.partial += event.assistantMessageEvent.delta;
      send({ type: 'delta', text: event.assistantMessageEvent.delta });
    }
    if (event.type === 'tool_execution_start') { active.tools.push(event.toolName); send({ type: 'tool', name: event.toolName }); }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const text = (event.message.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
      if (text) active.messages.push(text);
      active.partial = '';
      if (event.message.errorMessage) active.error = event.message.errorMessage;
    }
    if (event.type === 'agent_settled') void finish(active.error || (event.outcome && event.outcome !== 'completed' ? `Ejecución ${event.outcome}` : null));
  }
});
const startup = (async () => {
  try {
    const selected = await command('get_state');
    if (selected.model?.provider !== provider || selected.model?.id !== model || selected.thinkingLevel !== thinking) {
      throw Error('Pi no seleccionó el proveedor, modelo y nivel de razonamiento solicitados. Revisa la configuración de la sesión.');
    }
    sessionId = selected.sessionId;
    await command('set_auto_retry', { enabled: false }); ready = true;
  }
  catch (error) { broken(error.message); }
})();
function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Error('Usa JSON.');
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 32000) throw Error('Petición demasiado grande.'); }
  return JSON.parse(text);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
  if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, { error: 'Usa la dirección local 127.0.0.1.' });
  if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Origen no permitido.' });
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(readFileSync(join(ROOT, 'index.html')));
    }
    if (req.method === 'GET' && ['/ensayo', '/ensayo.html'].includes(req.url)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(readFileSync(join(ROOT, 'ensayo.html')));
    }
    if (req.method === 'GET' && req.url === '/api/pilot') return json(res, 200, pilotState());
    if (req.method === 'GET' && req.url === '/api/state') return json(res, 200, { ...state(), history, csrf, ready, busy: !!active, error: failure, provider, model, thinking, costStatus, sessionId });
    if (req.method !== 'POST' || req.headers['x-editorial-token'] !== csrf) return json(res, 403, { error: 'Petición no autorizada. Recarga la página.' });
    const data = await body(req);
    if (req.url === '/api/pilot') {
      if (active || changingExercise) return json(res, 409, { error: 'Espera a que termine la respuesta antes de cambiar de ejercicio.' });
      if (data.action !== 'start') return json(res, 200, pilotAction(data));
      const pilot = pilotState();
      if (pilot.activeTask || pilot.nextTask?.id !== data.taskId) return json(res, 400, { error: 'Inicia el siguiente ejercicio disponible.' });
      changingExercise = true;
      try {
        await startup;
        if (!ready) return json(res, 503, { error: failure || 'Pi no está disponible.' });
        if (history.length) save(`chat-before-${data.taskId}-${Date.now()}.json`, history);
        const previousSessionId = sessionId;
        const fresh = await command('new_session');
        if (fresh.cancelled) throw Error('Pi canceló el cambio de ejercicio. No se inició el cronómetro.');
        const actual = await command('get_state');
        if (actual.model?.provider !== provider || actual.model?.id !== model || actual.thinkingLevel !== thinking || actual.sessionId === previousSessionId) throw Error('No se pudo aislar la sesión con el modelo y razonamiento acordados.');
        sessionId = actual.sessionId;
        save('pi-session.json', { sessionFile: actual.sessionFile, sessionId });
        audit('pilot_session_reset', { taskId: data.taskId, previousSessionId, sessionId, sessionFile: actual.sessionFile, provider, model, thinking, messageCount: actual.messageCount });
        await command('set_auto_retry', { enabled: false });
        history = []; save('chat.json', history); save('brief.json', null); save('opportunities.json', null); save('decisions.json', []);
        return json(res, 200, pilotAction(data));
      } finally { changingExercise = false; }
    }
    if (req.url === '/api/message') {
      await startup;
      if (!ready) return json(res, 503, { error: failure || 'Pi no está disponible.' });
      if (active || changingExercise) return json(res, 409, { error: 'Ya hay una respuesta o cambio de ejercicio en curso.' });
      const pilot = read('pilot-session.json');
      if (pilot && (!pilot.activeTask || pilot.activeTask.method !== 'assisted')) return json(res, 403, { error: 'El asistente solo está disponible durante los ejercicios asistidos.' });
      if (pilot?.activeTask && Date.now() - pilot.activeTask.startedAtMs >= 300000) return json(res, 403, { error: 'El tiempo del ejercicio terminó. Guarda lo que alcanzaste a elaborar.' });
      if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 5000) return json(res, 400, { error: 'Escribe entre 1 y 5.000 caracteres.' });
      // Only plain conversation is exposed. RPC slash commands are not accepted from the browser.
      if (data.message.trimStart().startsWith('/')) return json(res, 400, { error: 'Usa una petición editorial, no un comando de Pi.' });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      active = { res, prompt: data.message, started: performance.now(), partial: '', messages: [], tools: [], finishing: false };
      active.timer = setTimeout(() => { if (active) active.error = 'Límite de 180 segundos alcanzado.'; void command('abort').catch(() => {}).finally(() => finish('Límite de 180 segundos alcanzado.')); }, 180000);
      history.push({ role: 'user', text: data.message, at: new Date().toISOString() }); save('chat.json', history);
      command('prompt', { message: data.message }).then(result => { if (result?.disposition === 'handled') void finish(); }).catch(error => finish(error.message));
      return;
    }
    if (req.url === '/api/abort') { if (active) active.error = 'Detenido por el operador.'; await command('abort'); return json(res, 200, { stopped: true }); }
    if (req.url === '/api/decision') {
      if (active) return json(res, 409, { error: 'Espera a que termine la respuesta antes de decidir.' });
      const decision = decide(data); return json(res, 200, { decision, state: state() });
    }
    return json(res, 404, { error: 'Ruta no disponible.' });
  } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); else res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`SingulariDev: ${origin}${TEST_MODE ? ' [prueba automatizada]' : ''}`));
function shutdown() { child.stdin.end(); server.close(); setTimeout(() => { child.kill('SIGTERM'); process.exit(0); }, 1500).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
