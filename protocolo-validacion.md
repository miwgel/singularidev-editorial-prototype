# Protocolo de validación de la Tarea 6

Protocolo fijado el 6 de octubre de 2026, antes de ejecutar las alternativas. El lote y las métricas originales de la Tarea 5 ya eran conocidos. La elección de reducir K-means a cinco grupos responde a la fragmentación observada entonces. Esta validación sirve para elegir una configuración; su desempeño no se presenta como una estimación sin sesgo después de seleccionar.

## Datos y prevención de filtraciones

Se reutiliza el lote de X con huella SHA-256 `1939071886d5d9fa6cb41945de9bcc4de4c43386e8ceacc2d317aab1b972e840`. Contiene 100 registros recuperados y 99 textos limpios. Se conserva la partición temporal de la Tarea 5: 59 textos para ajustar, 20 para validar y 20 reservados para una evaluación final. Los textos cubren 28 minutos y 37 segundos. Son una muestra de conveniencia, no una muestra representativa de semanas o fuentes.

Se reutilizan los 79 embeddings Qwen3-Embedding-0.6B de desarrollo. Cada ejecución ajusta UMAP solo con los 59 textos iniciales y transforma los siguientes 20. No se recalculan centroides, densidades, vocabulario ni parámetros con validación. La prueba final se procesa después de guardar la selección basada en validación, sin modificarla por su resultado. No se consulta X ni una API de embeddings.

## Alternativas fijadas

| Variante | Parámetros |
|---|---|
| Referencia | K-means con 10 grupos, k-means++, 10 inicializaciones y 300 iteraciones máximas |
| Ajuste simple | K-means con 5 grupos; el resto coincide con la referencia |
| BERTopic | HDBSCAN con `min_cluster_size=10`, `min_samples=5`, distancia euclídea, selección `eom`, predicción aproximada habilitada; CountVectorizer en inglés y c-TF-IDF para describir los temas |

Las tres alternativas reciben exactamente las mismas coordenadas UMAP dentro de cada semilla. UMAP usa cinco dimensiones, 15 vecinos, distancia coseno, distancia mínima cero y 500 épocas. Se repiten las semillas 42, 43, 44, 45 y 46. La proyección se calcula una vez por semilla y BERTopic recibe esas coordenadas mediante su reductor identidad. Los embeddings originales de 1.024 dimensiones se conservan para evaluar. El modelo Qwen no se entrena ni se modifica.

## Métricas y comparación

- Silueta con distancia coseno sobre los embeddings originales. Se informa como no definida cuando hay menos de dos grupos o tantos grupos como textos evaluados. Para BERTopic se informa tanto el número de textos asignados como los excluidos como ruido.
- Cobertura, número de grupos y grupos de un solo texto. K-means asigna todos los textos por construcción; eso no demuestra pertinencia.
- Comparación de silueta por pares sobre los mismos textos asignados por ambas alternativas. Se informa el tamaño de esa intersección. No se trata una mejor silueta sobre menos textos como una mejora equivalente en cobertura total.
- Estabilidad mediante ARI entre las diez parejas de semillas. Para BERTopic se informa ARI sobre la intersección asignada y, por separado, con ruido como etiqueta. El ARI de intersección no se considera interpretable si cualquiera de las particiones contiene menos de dos grupos.
- Tiempo de ajuste y predicción por alternativa, separado del tiempo UMAP compartido. Se conserva la primera ejecución, que puede incluir compilación. Los tiempos son locales y no una garantía de producción.

Se presentan media, desviación estándar muestral y rango de las cinco semillas, junto con cada resultado individual. Las semillas miden sensibilidad algorítmica sobre el mismo lote. No son cinco muestras independientes y sus rangos no son intervalos de confianza poblacionales. No se calcula una prueba de significación con estas semillas ni se aplica validación cruzada aleatoria que mezcle pasado y futuro. Los veinte textos de validación también pueden compartir autores, noticias o plantillas.

## Regla de selección y prueba final

Una alternativa es candidata si mantiene al menos 80 % de cobertura en cada semilla de validación; produce siluetas válidas en las cinco; mejora la silueta media frente a K-means de diez grupos; y su ARI medio interpretable no cae más de 0,05 respecto de la referencia. La mejora también debe ser positiva en la media de las cinco comparaciones con la referencia sobre textos comunes. Los umbrales son criterios prácticos, no umbrales estadísticos validados.

Entre candidatas se escoge la de mayor silueta media. Si la diferencia es menor de 0,01 se prefiere el ajuste simple por facilidad de despliegue, y después el menor tiempo mediano. Si ninguna cumple se conserva la referencia. La semilla operativa permanece fijada en 42, sin escoger la más favorable. Se registra la elección y su hora antes de procesar los veinte textos reservados.

En la evaluación final se aplican las tres alternativas ya ajustadas a los mismos veinte textos reservados. Se informan métricas y variabilidad sin cambiar la decisión ni reajustar el modelo. Este conjunto queda consumido y no podrá llamarse reservado en una evaluación posterior. La aplicación editorial continúa usando solo los 79 textos de desarrollo, con los grupos de la variante seleccionada.

## Evidencias y límites

El script guarda versiones, parámetros, huellas de entrada, protocolo, código y caché; resultados por semilla; selección anterior a la prueba; y grupos de desarrollo. Los textos y modelos quedan en `.cache/`, excluida de Git. `resultados-tarea6.json` contiene resultados agregados sin publicaciones. El modelo original, sus resultados y su caché no se sobrescriben.

Esta comparación mide estructura semántica y estabilidad, no utilidad editorial ni ahorro de tiempo. El ensayo humano de dos fichas manuales y dos asistidas complementa la evaluación. No se atribuyen efectos comerciales a ninguna de estas pruebas.

Referencias técnicas consultadas el 6 de octubre de 2026: [embeddings de BERTopic](https://maartengr.github.io/BERTopic/getting_started/embeddings/embeddings.html), [agrupamiento de BERTopic](https://maartengr.github.io/BERTopic/getting_started/clustering/clustering.html) y [predicción de nuevos puntos con HDBSCAN](https://hdbscan.readthedocs.io/en/latest/prediction_tutorial.html).
