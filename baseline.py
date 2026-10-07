"""Baseline local de la Tarea 5. Entrada JSONL; no consulta X ni una API de IA."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import html
from importlib.metadata import version
from itertools import combinations
import json
import os
from pathlib import Path
import platform
import re
import sys
from time import perf_counter

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

MODEL = "Qwen/Qwen3-Embedding-0.6B"
REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
SEEDS = [42, 43, 44, 45, 46]
PACKAGES = ["numpy", "torch", "transformers", "sentence-transformers", "scikit-learn",
            "umap-learn", "numba", "huggingface-hub"]


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def prepare(raw):
    """Deduplicación global previa a la partición; se conserva el registro más antiguo."""
    valid, removed, seen_ids, seen_text = [], [], set(), set()
    for row in raw:
        try:
            timestamp = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                raise ValueError("Fecha sin zona horaria")
            if not re.fullmatch(r"\d+", str(row["id"])):
                raise ValueError("ID inválido")
            text = " ".join(re.sub(r"<[^>]+>", " ", html.unescape(row["text"])).split())
            if not text or row.get("lang") != "en":
                raise ValueError("Sin texto o idioma distinto de inglés")
            row = {**row, "published_utc": timestamp.astimezone(timezone.utc).isoformat(),
                   "input_text": text[:4000], "truncated": len(text) > 4000}
            valid.append(row)
        except (KeyError, ValueError, TypeError) as error:
            removed.append({"id": row.get("id"), "reason": str(error)})
    kept = []
    for row in sorted(valid, key=lambda r: (r["published_utc"], int(r["id"]))):
        # Enlaces distintos no deben convertir una plantilla idéntica en textos independientes.
        normalized = re.sub(r"https?://\S+", "", row["input_text"]).casefold()
        normalized = " ".join(normalized.split())
        if row["id"] in seen_ids or normalized in seen_text:
            removed.append({"id": row["id"], "reason": "duplicate_id_or_normalized_text"})
            continue
        seen_ids.add(row["id"])
        seen_text.add(normalized)
        kept.append(row)
    return kept, removed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    args = parser.parse_args()
    source = args.input.resolve()
    source_bytes = source.read_bytes()
    digest = hashlib.sha256(source_bytes).hexdigest()
    script_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    root = Path(__file__).resolve().parent
    folder = root / ".cache" / "baseline" / digest[:12]
    folder.mkdir(parents=True, exist_ok=True)
    cached_result = folder / "resultados.json"
    if cached_result.exists():
        prior = json.loads(cached_result.read_text())
        if prior["script_sha256"] == script_hash:
            save_json(root / "resultados.json", prior)
            print(json.dumps({"cached": True, "results": str(cached_result),
                              "metrics": prior["metrics_reference"]}, ensure_ascii=False))
            return

    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer
    from sklearn.cluster import KMeans
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics import adjusted_rand_score, silhouette_score
    from umap import UMAP

    raw = [json.loads(line) for line in source_bytes.decode().splitlines() if line.strip()]
    rows, removed = prepare(raw)
    n = len(rows)
    train_end, valid_end = int(0.6 * n), int(0.8 * n)
    if train_end <= 15 or valid_end - train_end < 3:
        raise ValueError(f"Lote insuficiente: {n} textos limpios. Se necesitan más de 15 en entrenamiento.")
    splits = {"train": rows[:train_end], "validation": rows[train_end:valid_end], "test": rows[valid_end:]}
    manifest = {name: [row["id"] for row in part] for name, part in splits.items()}
    save_json(folder / "particiones.json", manifest)
    save_json(folder / "descartes.json", removed)
    # La prueba queda reservada: solo entrenamiento y validación pasan al modelo.
    development = rows[:valid_end]
    texts = [row["input_text"] for row in development]
    versions = {p: version(p) for p in PACKAGES}
    embedding_key = hashlib.sha256(json.dumps([texts, MODEL, REVISION, versions], sort_keys=True).encode()).hexdigest()[:12]
    embedding_path = folder / f"embeddings-{embedding_key}.npz"
    if embedding_path.exists():
        with np.load(embedding_path, allow_pickle=False) as cache:
            vectors = cache["vectors"]
            embedding_seconds = float(cache["seconds"])
        embedding_cached = True
    else:
        torch.set_num_threads(4)
        torch.manual_seed(42)
        started = perf_counter()
        model = SentenceTransformer(MODEL, revision=REVISION, device="cpu", local_files_only=True,
                                    trust_remote_code=False, model_kwargs={"torch_dtype": torch.float32})
        token_lengths = [len(model.tokenizer.encode(t)) for t in texts]
        if max(token_lengths) > model.max_seq_length:
            raise ValueError("Una entrada supera el límite de tokens; requiere recorte común documentado.")
        vectors = model.encode(texts, batch_size=4, normalize_embeddings=True,
                               show_progress_bar=True, convert_to_numpy=True)
        embedding_seconds = perf_counter() - started
        np.savez_compressed(embedding_path, vectors=vectors, seconds=embedding_seconds)
        embedding_cached = False
        del model
    if vectors.shape != (valid_end, 1024) or not np.isfinite(vectors).all():
        raise ValueError("Embeddings inválidos o de dimensiones inesperadas")

    def metrics(indices, labels):
        counts = Counter(int(x) for x in labels)
        score = None
        if 1 < len(counts) < len(labels):
            score = float(silhouette_score(vectors[indices], labels, metric="cosine"))
        return {"n": len(labels), "groups": len(counts), "coverage_percent": 100.0,
                "silhouette_cosine": score, "singleton_groups": sum(c == 1 for c in counts.values()),
                "sizes": dict(sorted(counts.items()))}

    runs, label_sets = [], {"train": [], "validation": []}
    labels_reference = None
    for seed in SEEDS:
        started = perf_counter()
        reducer = UMAP(n_components=5, n_neighbors=15, min_dist=0, metric="cosine",
                       n_epochs=500, random_state=seed, transform_seed=seed, n_jobs=1)
        train_xy = reducer.fit_transform(vectors[:train_end])
        val_xy = reducer.transform(vectors[train_end:valid_end])
        km = KMeans(n_clusters=10, init="k-means++", n_init=10, max_iter=300, random_state=seed)
        labels_train = km.fit_predict(train_xy)
        labels_val = km.predict(val_xy)
        elapsed = perf_counter() - started
        run = {"seed": seed, "clustering_seconds": elapsed,
               "train": metrics(slice(0, train_end), labels_train),
               "validation": metrics(slice(train_end, valid_end), labels_val)}
        runs.append(run)
        label_sets["train"].append(labels_train)
        label_sets["validation"].append(labels_val)
        if seed == 42:
            labels_reference = np.concatenate([labels_train, labels_val])
    stability = {}
    for name, sets in label_sets.items():
        values = [float(adjusted_rand_score(a, b)) for a, b in combinations(sets, 2)]
        stability[name] = {"mean_ari": float(np.mean(values)), "min_ari": min(values),
                           "max_ari": max(values), "pairs": len(values), "n": len(sets[0])}

    # TF-IDF sirve únicamente para mostrar términos, nunca para sustituir los embeddings.
    vectorizer = TfidfVectorizer(stop_words="english", max_features=1500)
    keyword_text = [re.sub(r"https?://\S+|@\w+", " ", t) for t in texts[:train_end]]
    word_matrix = vectorizer.fit_transform(keyword_text)
    words = vectorizer.get_feature_names_out()
    groups, review = [], []
    for group in range(10):
        indices = np.flatnonzero(labels_reference[:train_end] == group)
        val_indices = np.flatnonzero(labels_reference[train_end:] == group) + train_end
        if not len(indices):
            continue
        averages = np.asarray(word_matrix[indices].mean(axis=0)).ravel()
        keywords = [str(words[i]) for i in averages.argsort()[::-1][:5] if averages[i] > 0]
        center = vectors[indices].mean(axis=0)
        center /= np.linalg.norm(center)
        representative = int(indices[np.argmax(vectors[indices] @ center)])
        record = {"group": group, "train_n": len(indices), "validation_n": len(val_indices),
                  "keywords": keywords, "representative_url": development[representative]["url"]}
        groups.append(record)
        for i in np.concatenate([indices, val_indices]):
            row = development[int(i)]
            review.append({"group": group, "split": "train" if i < train_end else "validation",
                           "id": row["id"], "url": row["url"], "text": row["input_text"],
                           "author_id": row.get("author_id"), "created_at": row["created_at"]})
    (folder / "grupos.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in review))
    counts = Counter(r.get("author_id", "missing") for r in rows)
    first, last = rows[0]["published_utc"], rows[-1]["published_utc"]
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(), "input_file": source.name,
        "source_sha256": digest, "script_sha256": script_hash,
        "model": MODEL, "model_revision": REVISION, "embedding_dimensions": 1024,
        "device": "cpu", "dtype": "float32", "python": platform.python_version(),
        "platform": platform.platform(), "versions": versions,
        "query": sorted({r["query"] for r in raw}),
        "capture_utc": sorted({r["captured_at"] for r in raw}),
        "sample": {"raw": len(raw), "clean": n, "removed": len(removed),
                   "discard_reasons": dict(Counter(r["reason"] for r in removed)),
                   "truncated": sum(r["truncated"] for r in rows), "unique_authors": len(counts),
                   "max_posts_per_author": max(counts.values()), "first_utc": first, "last_utc": last,
                   "span_seconds": (datetime.fromisoformat(last) - datetime.fromisoformat(first)).total_seconds(),
                   "split_sizes": {name: len(part) for name, part in splits.items()}},
        "parameters": {"max_chars": 4000, "seeds": SEEDS, "split": [0.6, 0.2, 0.2],
                       "umap": {"n_components": 5, "n_neighbors": 15, "min_dist": 0, "metric": "cosine", "n_epochs": 500},
                       "kmeans": {"k": 10, "init": "k-means++", "n_init": 10, "max_iter": 300}},
        "embedding_seconds_original": embedding_seconds, "embedding_cached": embedding_cached,
        "runs": runs, "metrics_reference": {"train": runs[0]["train"], "validation": runs[0]["validation"]},
        "stability": stability, "groups": groups,
        "estimated_x_read_cost_usd": len(raw) * 0.005, "embedding_api_cost_usd": 0,
        "human_clarity_score": None, "test_evaluated": False,
        "local_evidence_directory": str(folder.relative_to(root)),
    }
    save_json(cached_result, summary)
    save_json(root / "resultados.json", summary)
    print(json.dumps({"cached": False, "results": str(cached_result),
                      "metrics": summary["metrics_reference"], "stability": stability}, ensure_ascii=False))


if __name__ == "__main__":
    main()
