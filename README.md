# Prototipo editorial de SingulariDev

Prototipo académico local que convierte publicaciones autorizadas en propuestas de videos en inglés. Combina agrupamiento semántico, conversación mediante Pi y revisión humana. No publica contenido de forma autónoma.

## Alcance de la publicación

Incluye código del prototipo, extensiones propias para Pi, protocolo de validación y métricas de las tareas 5 y 6. Pi es una dependencia externa: no se incluye su runtime, instalación, credenciales ni configuración de usuario.

Esta es una copia pública saneada del repositorio privado. Excluye su historial Git, publicaciones de X, autores, identificadores de publicaciones, fichas completas, conversaciones, opiniones textuales del participante, identificadores de sesiones y dirección del servicio privado de LLM. Se conservan resultados numéricos, limitaciones y huellas para trazabilidad. Los agregados de un solo participante no garantizan anonimato.

Las huellas de código y commits presentes en los resultados identifican las versiones originales evaluadas, no esta copia. Para publicar se retiraron referencias personales, se hizo configurable la URL del proveedor y se trasladaron los identificadores del ensayo a un archivo local excluido. No se repitió inferencia ni se recalcularon métricas al publicar.

## Requisitos y datos

Entorno evaluado: macOS arm64, Node 26.10.0, Pi 1.0.0 y Python 3.12.12. Instala Pi por separado y comprueba `pi --version`. La aplicación Node usa módulos nativos; no necesita `npm install` en esta carpeta. Las dependencias Python están fijadas en `requirements.txt`.

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

Para reproducir la ejecución se necesita acceso autorizado al lote original y sus cachés locales, que no se redistribuyen. No es una demostración con datos incluidos. Una nueva búsqueda produciría otro experimento y podría tener costo. No cambies los resultados históricos para presentarla como réplica exacta.

La aplicación espera los 79 textos de desarrollo en `.cache/baseline/1939071886d5/grupos.jsonl`, la selección en `.cache/validacion-t6/seleccion.json` y los grupos ajustados en `.cache/validacion-t6/grupos.jsonl`. Los veinte textos de prueba no son fuentes de la interfaz. Se usa Qwen3-Embedding-0.6B local, revisión `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`.

## Ejecutar la interfaz

Configura tu propio servicio compatible con Responses. En `.cache/llm.env`, archivo privado con permisos 600, proporciona `BISTE_LLM_API_KEY` y `BISTE_LLM_BASE_URL`. También puedes exportarlas como variables de entorno. La URL debe incluir la base `/v1`. No uses secretos reales en archivos rastreados ni en argumentos que queden en el historial del terminal.

El proveedor registrado se llama `biste` y la configuración evaluada usa `gpt-6.1-sol` con razonamiento `high`. Tu servicio debe ofrecer ese modelo y esa interfaz; no se garantiza compatibilidad con servicios que solo implementen Chat Completions. La tarifa es desconocida y se registra como `null`, no como costo cero.

```sh
EDITORIAL_STORE=.cache/editorial node app.mjs
```

Abre http://127.0.0.1:8765. El asistente propone oportunidades, consulta evidencia y guarda borradores. La aprobación, edición o rechazo corresponde al operador. Ctrl+C detiene el proceso. `PI_BIN`, `PORT`, `PI_EDITORIAL_PROVIDER`, `PI_EDITORIAL_MODEL` y `PI_EDITORIAL_THINKING` permiten configurar el arranque. No hay sustitución automática del modelo si falla.

El servicio escucha solo en la interfaz local y comprueba Host, Origin y un token local para escrituras. No debe exponerse a internet. Los textos enviados al asistente llegan al proveedor configurado. La coincidencia de una cita prueba procedencia, no veracidad.

## Ensayo manual frente al asistido

http://127.0.0.1:8765/ensayo usa un plan privado en `.cache/pilot-t6/plan.json`, o en `EDITORIAL_PILOT_PLAN`. Cada una de cuatro tareas contiene `id`, `method`, `topic` y cuatro `sources` distintas con `id`, `text` y `url`. El orden es `manual`, `assisted`, `assisted`, `manual`.

Para recuperar la preparación original, proporciona `.cache/pilot-t6/packages.json` con cuatro tuplas `[id, method, topic, [cuatro identificadores autorizados]]` y ejecuta `node pilot.mjs --prepare`. La preparación verifica grupos, diversidad de autores y balance de longitud. No se incluyen los identificadores reales del experimento. No los sustituyas por datos inventados para afirmar que reproducen el ensayo original. Para otro experimento, congela y documenta un plan nuevo antes de observar resultados.

Cada ejercicio tiene cinco minutos y una conversación nueva. El chat está bloqueado en el método manual. El límite se registra como incompleto, nunca como tiempo de finalización. Se guarda localmente duración, ficha, completitud autodeclarada, utilidad de 1 a 5, respaldo percibido y correcciones.

## Evaluación y resultados

`protocolo-validacion.md` fija la comparación: mismos 99 textos, división temporal 59/20/20, Qwen y UMAP compartidos por semilla y cinco semillas. Se comparan K-means 10, K-means 5 y BERTopic con HDBSCAN.

| Media de cinco semillas | K-means 10 | K-means 5 | BERTopic |
|---|---:|---:|---:|
| Silueta de validación | -0,01825 | -0,01654 | No definida |
| Silueta de prueba | -0,01036 | 0,03491 | No definida |
| Cobertura de validación | 100 % | 100 % | 0 % |

K-means 5 se seleccionó antes de abrir la prueba. Su mejora de validación es mínima, con dos semillas favorables y tres desfavorables; la adopción es provisional. BERTopic no cumplió cobertura con esta configuración y muestra. Las semillas describen sensibilidad, no intervalos de confianza poblacionales. Los veinte textos finales ya fueron utilizados.

El ensayo humano tuvo un operador y dos ejercicios por condición:

| Método y ejercicio | Tiempo observado | Estado | Utilidad |
|---|---:|---|---:|
| Manual, permisos | 296,034 s | Completa | 2/5 |
| Asistido, permisos | 170,119 s | Completa | 4/5 |
| Asistido, programación | 130,293 s | Completa | 5/5 |
| Manual, programación | 300 s, límite | Incompleta | 3/5 |

La mediana asistida fue 150,206 segundos. No se imputa el tiempo manual censurado ni se calcula ahorro porcentual. Ambas asistidas incluyeron una revisión de enfoque. La utilidad es autovalorada. Fuentes preparadas, orden fijo, un operador y extensiones distintas limitan la comparación; no demuestran el objetivo del 40 % ni efectos comerciales.

`resultados.json`, `resultados-tarea6.json` y `resultados-ensayo-tarea6.json` conservan las métricas. `evaluacion-prototipo.json` y `evaluacion-tarea6.json` corresponden a pruebas funcionales, no a evaluaciones humanas.

```sh
.venv/bin/python validar.py
node test-editorial.mjs
node test-tarea6.mjs
```

Estos comandos necesitan los datos privados y cachés descritos. La validación protege resultados existentes mediante huellas. `test-editorial.mjs` ejecuta diez regresiones locales sin inferencia. `test-tarea6.mjs` ejecuta ocho controles integrados y una conversación con tu proveedor, que puede generar costo. Ninguno llama a X. Las 10/10 y 8/8 comprobaciones publicadas corresponden al entorno original, no a una ejecución sobre un clon sin datos.

## Bitácora y siguientes pasos

- 29 de septiembre de 2026: recuperación acotada de X, agrupamiento de referencia e interfaz conversacional. Referencias privadas `61f5910`, `c4dda35` y `5c6b2c4`.
- 6 de octubre: comparación de tres alternativas, integración provisional de K-means 5 y ensayo cronometrado, referencia privada `5bb006f`.
- 6 de octubre: registro de cuatro ejercicios y cuatro valoraciones, referencia privada `e42394f`.
- Publicación: snapshot saneado con historial público nuevo. Las referencias anteriores documentan procedencia, pero no son commits disponibles en este repositorio público.

Prioridad inmediata: contrastar la selección con otro corte temporal y revisar duplicados. Después, seis fichas por condición, extensión comparable y dos revisores externos, con metas de ahorro ≥40 %, utilidad ≥4/5 y respaldo factual ≥90 %. Nuevas fuentes y llamadas pagadas requieren presupuesto y permisos. La conservación y el borrado deben alcanzar datos, derivados y sesiones del proveedor.

El repositorio no incluye informe académico nominal ni concede una licencia sobre los datos de X o las dependencias externas.
