import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, TEST_MODE, read, save, audit } from './editorial.mjs';

const FILE = 'pilot-session.json';
const LIMIT = 300;
const PLAN_FILE = process.env.EDITORIAL_PILOT_PLAN || join(ROOT, '.cache/pilot-t6/plan.json');
export const utilityAnchors = {
  1: 'No usaría la ficha.',
  2: 'Tendría que rehacerla casi por completo.',
  3: 'Necesita cambios importantes para poder usarla.',
  4: 'La usaría después de cambios pequeños.',
  5: 'Está lista para preparar el video.'
};

function plan() {
  const raw = readFileSync(PLAN_FILE, 'utf8');
  const value = JSON.parse(raw);
  const tasks = Array.isArray(value) ? value : value.tasks;
  if (!Array.isArray(tasks) || tasks.length !== 4) throw Error('El ensayo necesita cuatro ejercicios preparados.');
  if (tasks.map(t => t.method).join(',') !== 'manual,assisted,assisted,manual') throw Error('La secuencia del ensayo debe ser manual, asistida, asistida, manual.');
  const ids = new Set(), sourceIds = new Set();
  for (const t of tasks) {
    if (typeof t.id !== 'string' || ids.has(t.id) || typeof t.topic !== 'string' || !Array.isArray(t.sources) || t.sources.length !== 4) throw Error('Plan de ejercicios inválido.');
    ids.add(t.id);
    for (const s of t.sources) {
      if (typeof s.id !== 'string' || typeof s.text !== 'string' || !s.text.trim() || sourceIds.has(s.id)) throw Error('Los paquetes deben tener fuentes distintas y texto disponible.');
      sourceIds.add(s.id);
    }
  }
  return { ...(!Array.isArray(value) ? value : {}), tasks, sha256: createHash('sha256').update(raw).digest('hex') };
}

function session(p) {
  const s = read(FILE, { id: randomUUID(), planSha256: p.sha256, createdAt: new Date().toISOString(), activeTask: null, completedTasks: [], ratings: [], actor: TEST_MODE ? 'automated_test' : 'human_local_ui' });
  if (s.planSha256 !== p.sha256) throw Error('El plan cambió después de iniciar el ensayo. Conserva la sesión anterior y usa otro directorio para un ensayo nuevo.');
  return s;
}

function view(p, s) {
  const allFinished = s.completedTasks.length === p.tasks.length;
  const next = !s.activeTask && !allFinished ? p.tasks[s.completedTasks.length] : null;
  return { ...s, now: Date.now(), limitSeconds: LIMIT, anchors: utilityAnchors,
    nextTask: next ? { id: next.id, method: next.method, topic: next.topic, number: s.completedTasks.length + 1 } : null,
    totalTasks: p.tasks.length, ratingStage: allFinished, finished: allFinished && s.ratings.length === p.tasks.length,
    summary: { completedWithinLimit: s.completedTasks.filter(t => t.complete).length,
      incomplete: s.completedTasks.filter(t => !t.complete).length, rated: s.ratings.length,
      warning: 'Ensayo exploratorio de una persona y dos ejercicios por método. La utilidad y el respaldo son valoraciones del operador.' } };
}

export function pilotState() { const p = plan(); return view(p, session(p)); }

export function pilotAction(data) {
  if (!data || typeof data !== 'object') throw Error('Acción inválida.');
  const p = plan(), s = session(p), actor = TEST_MODE ? 'automated_test' : 'human_local_ui';
  if (data.action === 'start') {
    if (s.activeTask) throw Error('Ya hay un ejercicio en curso.');
    const task = p.tasks[s.completedTasks.length];
    if (!task || task.id !== data.taskId) throw Error('Inicia el siguiente ejercicio en el orden previsto.');
    const startedAtMs = Date.now();
    s.activeTask = { ...task, number: s.completedTasks.length + 1, startedAtMs, startedAt: new Date(startedAtMs).toISOString(), limitSeconds: LIMIT };
    audit('pilot_task_start', { actor, pilotId: s.id, taskId: task.id, method: task.method, planSha256: p.sha256, sourceIds: task.sources.map(r => r.id), startedAtMs });
  } else if (data.action === 'finish') {
    if (!s.activeTask || s.activeTask.id !== data.taskId) {
      if (s.completedTasks.some(t => t.id === data.taskId)) return view(p, s);
      throw Error('Ese ejercicio no está activo.');
    }
    if (typeof data.markdown !== 'string' || data.markdown.length > 14000 || typeof data.complete !== 'boolean') throw Error('Envía la ficha y declara si la terminaste.');
    if (data.complete && data.markdown.trim().length < 80) throw Error('La ficha terminada necesita idea, enfoque, esquema y fuentes.');
    const endedAtMs = Date.now(), elapsedSeconds = Math.max(0, (endedAtMs - s.activeTask.startedAtMs) / 1000);
    const timedOut = elapsedSeconds >= LIMIT;
    const result = { ...s.activeTask, endedAt: new Date(endedAtMs).toISOString(), elapsedSeconds: +elapsedSeconds.toFixed(3),
      observedSeconds: +Math.min(elapsedSeconds, LIMIT).toFixed(3), complete: data.complete && !timedOut,
      selfDeclaredComplete: data.complete, censored: timedOut, outcome: timedOut ? 'time_limit_incomplete' : data.complete ? 'completed' : 'stopped_incomplete',
      markdown: data.markdown.trim(), actor, reason: timedOut ? 'Límite de cinco minutos.' : data.complete ? 'El operador declaró terminada la ficha.' : 'El operador terminó sin completar la ficha.' };
    s.completedTasks.push(result); s.activeTask = null;
    if (s.completedTasks.length === p.tasks.length) s.ratingStartedAt = new Date(endedAtMs).toISOString();
    audit('pilot_task_finish', { pilotId: s.id, ...result });
  } else if (data.action === 'rate') {
    if (s.completedTasks.length !== p.tasks.length || !s.completedTasks.some(t => t.id === data.taskId)) throw Error('Valora las fichas después de completar los cuatro ejercicios.');
    if (!Number.isInteger(data.utility) || data.utility < 1 || data.utility > 5 || !['yes', 'partial', 'no'].includes(data.sourceSupport)) throw Error('Selecciona utilidad de 1 a 5 y respaldo en las fuentes.');
    if (typeof data.corrections !== 'string' || !data.corrections.trim() || data.corrections.length > 3000) throw Error('Describe qué corregirías o escribe "sin cambios".');
    const rating = { taskId: data.taskId, utility: data.utility, anchor: utilityAnchors[data.utility], sourceSupport: data.sourceSupport,
      corrections: data.corrections.trim(), at: new Date().toISOString(), actor };
    s.ratings = [...s.ratings.filter(r => r.taskId !== data.taskId), rating];
    if (s.ratings.length === p.tasks.length) s.finishedAt = rating.at;
    audit('pilot_rating', { pilotId: s.id, ...rating });
  } else throw Error('Acción del ensayo desconocida.');
  save(FILE, s);
  return view(p, s);
}

export function preparePilotPlan() {
  if (existsSync(PLAN_FILE)) return { created: false, message: 'El plan ya existe y se conserva sin cambios.', tasks: plan().tasks.map(t => ({ id: t.id, method: t.method, ...t.sourceStats })) };
  const corpusPath = join(ROOT, '.cache/baseline/1939071886d5/grupos.jsonl');
  const raw = readFileSync(corpusPath, 'utf8');
  const rows = raw.trim().split('\n').map(JSON.parse);
  if (rows.some(r => !['train', 'validation'].includes(r.split))) throw Error('La preparación solo admite textos de entrenamiento y validación.');
  const groupRaw = readFileSync(join(ROOT, '.cache/validacion-t6/grupos.jsonl'), 'utf8');
  const grouped = groupRaw.trim().split('\n').map(JSON.parse);
  if (grouped.some(r => !['train', 'validation'].includes(r.split) || r.variant !== 'kmeans5')) throw Error('El balance requiere los grupos K-means 5 de desarrollo.');
  const permissions = 'Permisos y revisión humana para agentes de un emprendedor';
  const coding = 'Uso práctico de agentes de programación para un emprendedor';
  // The publication IDs used in the private study are not redistributed.
  // Supply the same tuple structure with your authorized sources; no automatic acquisition.
  const packages = JSON.parse(readFileSync(join(ROOT, '.cache/pilot-t6/packages.json'), 'utf8'));
  const chosen = new Set();
  const tasks = packages.map(([id, method, topic, ids]) => {
    const sources = ids.map(sourceId => {
      const source = rows.find(r => r.id === sourceId);
      if (!source || chosen.has(sourceId)) throw Error('Una fuente falta en el corpus de desarrollo o está repetida.');
      chosen.add(sourceId);
      return { id: source.id, text: source.text, url: source.url || 'https://x.com/i/web/status/' + source.id, split: source.split,
        words: source.text.trim().split(/\s+/u).length, characters: [...source.text].length };
    });
    return { id, method, topic, sources, sourceStats: { publications: sources.length, words: sources.reduce((n,s) => n+s.words,0), characters: sources.reduce((n,s) => n+s.characters,0) } };
  });
  const noise = /on.chain|\bcrypto\b|\btoken(?:ized)?\b|\btrading\b|\bdefi\b|\bzcash\b|\byield\b|\bblockchain\b|\bsolana\b|\bransomware\b|ama_protocol/i;
  const optimization = [0,2].map(start => {
    const pool = tasks.slice(start,start+2).flatMap(t => t.sources).sort((a,b) => a.id.localeCompare(b.id)).map(s => {
      const g = grouped.find(r => r.id === s.id);
      if (!g || g.text !== s.text || !g.author_id) throw Error('Falta información verificable de grupo o autor.');
      return { ...s, group: g.group, author_id: g.author_id };
    });
    const eligible = p => p.some(r => !noise.test(r.text) && p.some(s => s.id !== r.id && s.group === r.group && s.author_id !== r.author_id && !noise.test(s.text)));
    const stats = p => [p.reduce((n,r) => n+r.words,0),p.reduce((n,r) => n+r.characters,0)];
    const choices = []; let examined = 0;
    for (let mask=0;mask<256;mask++) {
      const first=pool.filter((_,i) => mask & (1<<i)),second=pool.filter((_,i) => !(mask & (1<<i)));
      if(first.length!==4)continue; examined++;
      if(!eligible(first)||!eligible(second))continue;
      const a=stats(first),b=stats(second),ids=first.map(r=>r.id);
      choices.push({ ids, words:[a[0],b[0]], characters:[a[1],b[1]], dw:Math.abs(a[0]-b[0]), dc:Math.abs(a[1]-b[1]), key:ids.join(',') });
    }
    choices.sort((a,b) => a.dw-b.dw || a.dc-b.dc || (a.key<b.key?-1:a.key>b.key?1:0));
    const best=choices[0];
    if(!best || best.ids.join(',')!==tasks[start].sources.map(s=>s.id).sort().join(','))throw Error('La selección fija no coincide con el óptimo de balance.');
    return { topic: tasks[start].topic, combinationsExamined:examined, feasible:choices.length, words:best.words, characters:best.characters,
      differenceWords:best.dw, relativeDifferencePercent:+(100*best.dw/((best.words[0]+best.words[1])/2)).toFixed(3),
      bothPackagesHaveTwoEligibleAuthorsInOneGroup:true };
  });
  const prepared = { schemaVersion: 1, preparedAt: new Date().toISOString(),
    sourceSha256: '1939071886d5d9fa6cb41945de9bcc4de4c43386e8ceacc2d317aab1b972e840',
    developmentCorpusSha256: createHash('sha256').update(raw).digest('hex'),
    groupingCorpusSha256: createHash('sha256').update(groupRaw).digest('hex'),
    selection: 'Selección por conveniencia de dos bloques de ocho fuentes. Reparto determinista de cuatro fuentes por paquete para minimizar la diferencia de palabras antes del ensayo humano. El contenido y la dificultad no son exactamente equivalentes.',
    preparationAdjustment: { reason: 'Reducir la diferencia de lectura antes de observar tiempos o valoraciones del operador.',
      previousPlans: ['plan-preparacion-inicial.json','plan-preparacion-balanceo.json'],
      algorithm: 'Enumerar las 70 combinaciones de cuatro entre ocho por tema; exigir dos fuentes elegibles de autores distintos en un mismo grupo K-means 5 por paquete; minimizar diferencia absoluta de palabras, después de caracteres y después lista lexicográfica de identificadores.', optimization },
    order: 'manual, assisted, assisted, manual', sourceWordCountMethod: 'Separación por espacios en blanco; caracteres contados como puntos de código Unicode.',
    briefWordsSuggested: [120,180], taskLimitSeconds: LIMIT,
    limitations: ['Una persona, dos ejercicios por método.', 'El operador pudo haber visto publicaciones de este lote en la Tarea 5.', 'Las diferencias entre paquetes y el aprendizaje durante la sesión pueden afectar los tiempos.'], tasks };
  mkdirSync(dirname(PLAN_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(PLAN_FILE, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  plan();
  return { created: true, preparedAt: prepared.preparedAt, developmentCorpusSha256: prepared.developmentCorpusSha256,
    tasks: tasks.map(t => ({ id: t.id, method: t.method, ...t.sourceStats })) };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename && process.argv.includes('--prepare')) {
  console.log(JSON.stringify(preparePilotPlan(), null, 2));
}
