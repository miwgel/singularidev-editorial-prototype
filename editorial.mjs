import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

// Shared by the narrow Pi tools and the human-facing local server. No network access.
export const ROOT = resolve(import.meta.dirname);
export const STORE = resolve(process.env.EDITORIAL_STORE || join(ROOT, '.cache/editorial'));
export const TEST_MODE = process.env.EDITORIAL_TEST_MODE === '1';
mkdirSync(STORE, { recursive: true, mode: 0o700 });
export const read = (name, fallback = null) => existsSync(join(STORE, name)) ? JSON.parse(readFileSync(join(STORE, name), 'utf8')) : fallback;
export function save(name, value) {
  const target = join(STORE, name), temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, target);
  return value;
}
export function audit(type, data) {
  const event = { at: new Date().toISOString(), type, test: TEST_MODE, ...data };
  appendFileSync(join(STORE, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
  return event;
}
export function corpus() {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'resultados.json'), 'utf8'));
  const selectedPath = join(ROOT, '.cache/validacion-t6/seleccion.json');
  const selected = process.env.EDITORIAL_VARIANT !== 'baseline' && existsSync(selectedPath) ? JSON.parse(readFileSync(selectedPath, 'utf8')) : null;
  if (selected && selected.source_sha256 !== baseline.source_sha256) throw Error('La selección no corresponde al lote de referencia.');
  const original = readFileSync(join(ROOT, '.cache/baseline', baseline.source_sha256.slice(0, 12), 'grupos.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  let rows = selected ? readFileSync(join(ROOT, '.cache/validacion-t6/grupos.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : original;
  if (rows.some(r => !['train', 'validation'].includes(r.split))) throw Error('El corpus editorial no admite la partición de prueba.');
  if (rows.length !== original.length || new Set(rows.map(r => r.id)).size !== original.length || rows.some(r => !original.some(o => o.id === r.id && o.text === r.text))) throw Error('El corpus ajustado debe conservar los mismos textos de desarrollo.');
  const pilot = read('pilot-session.json');
  if (pilot?.activeTask) {
    const allowed = new Set(pilot.activeTask.sources.map(s => s.id));
    rows = rows.filter(r => allowed.has(r.id));
  }
  return { baseline, rows, selected };
}
const normalize = value => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
const noise = /on.chain|\bcrypto\b|\btoken(?:ized)?\b|\btrading\b|\bdefi\b|\bzcash\b|\byield\b|\bblockchain\b|\bsolana\b|\bransomware\b|ama_protocol/i;
const contains = (text, term) => normalize(text).includes(normalize(term));
export const WARNINGS = [
  'Muestra de conveniencia de 28 min 37 s. Son señales editoriales, no tendencias demostradas ni crecimiento medido.',
  'Los posts son afirmaciones de terceros sin verificación externa. Una cita válida no demuestra que una afirmación sea verdadera.',
  'La separación de temas en validación sigue siendo débil. Revisar cada fuente antes de usarla.',
  'Puntuación provisional: 60% afinidad léxica, 25% diversidad de autores y 15% recencia dentro del lote. No mide conversión, novedad ni factibilidad.'
];
export function opportunities({ focus, terms }) {
  if (typeof focus !== 'string' || !focus.trim() || focus.length > 500 || !Array.isArray(terms) || !terms.length || terms.length > 8 || terms.some(t => typeof t !== 'string' || t.trim().length < 3 || t.length > 60)) throw Error('Indica un enfoque y entre 1 y 8 términos específicos en inglés.');
  terms = [...new Set(terms.map(t => normalize(t.trim())))];
  const { baseline, rows, selected } = corpus();
  const eligible = rows.filter(r => r.group >= 0 && !noise.test(r.text));
  const times = rows.map(r => Date.parse(r.created_at)), first = Math.min(...times), span = Math.max(...times) - first || 1;
  const groups = [...new Set(eligible.map(r => r.group))].map(group => {
    const all = eligible.filter(r => r.group === group);
    const matching = all.filter(r => terms.some(t => contains(r.text, t)));
    const authors = new Set(matching.map(r => r.author_id)).size;
    const affinity = matching.length / all.length;
    const diversity = Math.min(authors / 5, 1);
    const recency = matching.length ? matching.reduce((s, r) => s + (Date.parse(r.created_at) - first) / span, 0) / matching.length : 0;
    return { group, score: +(100 * (.6 * affinity + .25 * diversity + .15 * recency)).toFixed(2),
      components: { affinity: +affinity.toFixed(4), diversity: +diversity.toFixed(4), recency: +recency.toFixed(4) },
      matchingPosts: matching.length, eligiblePosts: all.length, authors,
      evidence: matching.map(({ author_id, ...r }) => r) };
  }).filter(g => g.matchingPosts >= 2 && g.authors >= 2).sort((a, b) => b.score - a.score || a.group - b.group);
  const result = { version: randomUUID(), generatedAt: new Date().toISOString(), focus, terms, sourceSha256: baseline.source_sha256,
    clustering: selected?.selected || 'kmeans10', rulesVersion: 'lexical-1', weights: { affinity: .6, diversity: .25, recency: .15 }, excludedPosts: rows.length - eligible.length,
    availableGroups: groups.length, opportunities: groups.slice(0, 3), warnings: WARNINGS,
    status: groups.length >= 3 ? 'three_candidates' : 'insufficient_for_three' };
  save('opportunities.json', result);
  audit('focus_and_ranking', { version: result.version, focus, terms, groups: result.opportunities.map(g => ({ group: g.group, score: g.score })) });
  return result;
}
export function evidence(ids) {
  const { rows } = corpus();
  if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => !rows.some(r => r.id === id))) throw Error('Identificador fuera del corpus de desarrollo.');
  return rows.filter(r => ids.includes(r.id)).map(({ author_id, ...r }) => r);
}
export function saveBrief({ opportunityVersion, group, title, markdown, claims }) {
  const ranking = read('opportunities.json');
  const selected = ranking?.opportunities.find(g => g.group === group);
  if (!selected || ranking.version !== opportunityVersion) throw Error('La oportunidad no pertenece al enfoque vigente. Vuelve a consultar el ranking.');
  if (typeof title !== 'string' || !title.trim() || title.length > 180 || typeof markdown !== 'string' || markdown.length < 200 || markdown.length > 14000) throw Error('Ficha vacía o longitud inválida.');
  if (!Array.isArray(claims) || !claims.length || claims.length > 8) throw Error('Incluye entre una y ocho afirmaciones con evidencia.');
  const linked = claims.map(c => {
    const source = selected.evidence.find(r => r.id === c.evidenceId);
    if (!source || typeof c.statement !== 'string' || !c.statement.trim() || typeof c.quote !== 'string' || c.quote.length < 15 || !source.text.includes(c.quote)) throw Error('La cita debe ser un fragmento literal de una fuente de la oportunidad elegida.');
    if (!markdown.includes(c.evidenceId)) throw Error('Incluye el identificador o enlace de cada fuente en el cuerpo de la ficha.');
    return { ...c, url: source.url, verification: 'literal_quote_only_not_truth' };
  });
  const brief = { version: randomUUID(), createdAt: new Date().toISOString(), opportunityVersion, group, title, markdown,
    claims: linked, focus: ranking.focus, status: 'draft', author: 'agent', sourceSha256: ranking.sourceSha256 };
  save('brief.json', brief);
  audit('brief_draft', { brief });
  return { version: brief.version, status: brief.status, linkedClaims: linked.length, message: 'Borrador guardado. Solo los controles de la interfaz registran decisiones humanas.' };
}
export function decide({ version, action, reason, markdown }) {
  const brief = read('brief.json');
  if (!brief || version !== brief.version) throw Error('La ficha cambió. Recarga y revisa su versión actual.');
  if (!['accept', 'edit', 'reject'].includes(action) || typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 1500) throw Error('Selecciona una acción e indica un motivo de al menos cinco caracteres.');
  if (action === 'edit' && (typeof markdown !== 'string' || markdown.trim().length < 200 || markdown.length > 14000)) throw Error('La ficha editada requiere entre 200 y 14.000 caracteres.');
  const decision = { id: randomUUID(), briefVersion: version, action, reason: reason.trim(), actor: TEST_MODE ? 'automated_test' : 'human_local_ui', at: new Date().toISOString() };
  if (action === 'edit') {
    const edited = { ...brief, version: randomUUID(), parentVersion: version, markdown, status: 'draft_after_human_edit', author: decision.actor, claimsNeedReview: true };
    save('brief.json', edited);
    audit('brief_edited', { brief: edited });
    decision.newVersion = edited.version;
  } else save('brief.json', { ...brief, status: action === 'accept' ? 'accepted' : 'rejected' });
  save('decisions.json', [...read('decisions.json', []), decision]);
  audit('decision', decision);
  return decision;
}
export function state() {
  const { selected } = corpus();
  return { ranking: read('opportunities.json'), brief: read('brief.json'), decisions: read('decisions.json', []), warnings: WARNINGS, testMode: TEST_MODE, clustering: selected?.selected || 'kmeans10' };
}
export function codeHash() { return createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'); }
