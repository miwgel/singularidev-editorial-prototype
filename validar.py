"""Comparación temporal local T6. No consulta X ni una API de inferencia."""

from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
from importlib.metadata import version
from itertools import combinations
import json
import os
from pathlib import Path
import platform
import re
from time import perf_counter

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("OMP_NUM_THREADS", "4")

import numpy as np
from bertopic import BERTopic
from bertopic.dimensionality import BaseDimensionalityReduction
from hdbscan import HDBSCAN
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer
from sklearn.metrics import adjusted_rand_score, silhouette_score
from umap import UMAP

from baseline import MODEL, REVISION, prepare

ROOT = Path(__file__).resolve().parent
OUT = ROOT / ".cache" / "validacion-t6"
SEEDS = [42, 43, 44, 45, 46]
VARIANTS = ["kmeans10", "kmeans5", "bertopic"]
PACKAGES = ["numpy", "torch", "transformers", "sentence-transformers", "scikit-learn",
            "umap-learn", "numba", "bertopic", "hdbscan", "pandas", "plotly"]


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    path.chmod(0o600)


def stats(values):
    values = [float(v) for v in values if v is not None]
    return {"n": len(values), "mean": float(np.mean(values)) if values else None,
            "sample_sd": float(np.std(values, ddof=1)) if len(values) > 1 else None,
            "min": min(values) if values else None, "max": max(values) if values else None,
            "median": float(np.median(values)) if values else None}


def metrics(vectors, labels):
    labels = np.asarray(labels)
    assigned = labels >= 0
    counts = Counter(int(v) for v in labels[assigned])
    valid = 1 < len(counts) < int(assigned.sum())
    return {"n": len(labels), "assigned_n": int(assigned.sum()), "noise_n": int((~assigned).sum()),
            "coverage_percent": float(100 * assigned.mean()) if len(labels) else 0.0, "groups": len(counts),
            "singleton_groups": sum(v == 1 for v in counts.values()),
            "sizes": dict(sorted(counts.items())),
            "silhouette_cosine": float(silhouette_score(vectors[assigned], labels[assigned], metric="cosine")) if valid else None,
            "silhouette_reason": None if valid else "Requires at least two groups and fewer groups than assigned texts"}


def stability(label_sets):
    pairs = []
    for i, j in combinations(range(len(label_sets)), 2):
        a, b = np.asarray(label_sets[i]), np.asarray(label_sets[j])
        common = (a >= 0) & (b >= 0)
        interpretable = len(set(a[common])) > 1 and len(set(b[common])) > 1
        pairs.append({"seeds": [SEEDS[i], SEEDS[j]], "common_n": int(common.sum()),
                      "ari_common_assigned": float(adjusted_rand_score(a[common], b[common])) if interpretable else None,
                      "ari_including_noise": float(adjusted_rand_score(a, b)),
                      "including_noise_degenerate": len(set(a)) < 2 or len(set(b)) < 2})
    return {"pairs": pairs, "common_assigned": stats([p["ari_common_assigned"] for p in pairs]),
            "including_noise": stats([p["ari_including_noise"] for p in pairs]),
            "common_n": stats([p["common_n"] for p in pairs])}


def common_comparisons(vectors, label_map):
    result = {}
    for a, b in combinations(VARIANTS, 2):
        records = []
        for i, seed in enumerate(SEEDS):
            la, lb = np.asarray(label_map[a][i]), np.asarray(label_map[b][i])
            common = (la >= 0) & (lb >= 0)
            ma, mb = metrics(vectors[common], la[common]), metrics(vectors[common], lb[common])
            # An empty intersection has undefined silhouette for both alternatives.
            sa, sb = ma.get("silhouette_cosine"), mb.get("silhouette_cosine")
            records.append({"seed": seed, "common_n": int(common.sum()), a: sa, b: sb,
                            "difference_second_minus_first": sb - sa if sa is not None and sb is not None else None})
        result[f"{a}_vs_{b}"] = {"runs": records,
                                  "difference_second_minus_first": stats([r["difference_second_minus_first"] for r in records]),
                                  "common_n": stats([r["common_n"] for r in records])}
    return result


def aggregate(runs, labels, split):
    return {name: {"silhouette_cosine": stats([r[name][split]["silhouette_cosine"] for r in runs]),
                   "coverage_percent": stats([r[name][split]["coverage_percent"] for r in runs]),
                   "groups": stats([r[name][split]["groups"] for r in runs]),
                   "singleton_groups": stats([r[name][split]["singleton_groups"] for r in runs]),
                   "fit_predict_seconds_excluding_umap": stats([r[name]["fit_predict_seconds"] for r in runs]),
                   "stability": stability(labels[name])} for name in VARIANTS}


def choose(summary, common):
    reference = summary["kmeans10"]
    checks = {}
    for name in VARIANTS[1:]:
        item = summary[name]
        paired = common[f"kmeans10_vs_{name}"]["difference_second_minus_first"]
        ari = item["stability"]["common_assigned"]
        checks[name] = {
            "coverage_all_seeds_at_least_80": item["coverage_percent"]["min"] >= 80,
            "silhouette_defined_all_seeds": item["silhouette_cosine"]["n"] == 5,
            "mean_silhouette_improves": item["silhouette_cosine"]["mean"] is not None and item["silhouette_cosine"]["mean"] > reference["silhouette_cosine"]["mean"],
            "common_support_improves_all_comparisons_defined": paired["n"] == 5 and paired["mean"] > 0,
            "ari_all_pairs_defined_and_drop_at_most_005": ari["n"] == 10 and ari["mean"] >= reference["stability"]["common_assigned"]["mean"] - 0.05}
    eligible = [name for name, criteria in checks.items() if all(criteria.values())]
    selected = "kmeans10"
    if eligible:
        selected = max(eligible, key=lambda n: summary[n]["silhouette_cosine"]["mean"])
        if "kmeans5" in eligible and summary[selected]["silhouette_cosine"]["mean"] - summary["kmeans5"]["silhouette_cosine"]["mean"] < 0.01:
            selected = "kmeans5"
    return selected, checks


def main():
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    original = json.loads((ROOT / "resultados.json").read_text())
    protocol_hash = digest(ROOT / "protocolo-validacion.md")
    script_hash = digest(Path(__file__))
    if (ROOT / "resultados-tarea6.json").exists():
        previous = json.loads((ROOT / "resultados-tarea6.json").read_text())
        known_hashes = {previous["script_sha256"], previous.get("metadata_revision", {}).get("script_sha256")}
        if script_hash in known_hashes and previous["protocol_sha256"] == protocol_hash:
            print(json.dumps({"cached": True, "selected": previous["selection"]["selected"]}))
            return
        raise RuntimeError("La evaluación ya existe. No se sobrescribe una prueba final consumida.")
    source = ROOT / ".cache" / "x" / original["input_file"]
    assert digest(source) == original["source_sha256"], "Fuente modificada"
    base = ROOT / original["local_evidence_directory"]
    manifest = json.loads((base / "particiones.json").read_text())
    assert {k: len(v) for k, v in manifest.items()} == {"train": 59, "validation": 20, "test": 20}
    ids = manifest["train"] + manifest["validation"]
    lookup = {r["id"]: r for r in (json.loads(line) for line in (base / "grupos.jsonl").read_text().splitlines())}
    development = [lookup[i] for i in ids]
    assert set(lookup) == set(ids), "Solo se permite corpus de desarrollo"
    embedding_files = list(base.glob("embeddings-*.npz"))
    assert len(embedding_files) == 1, "Caché de embeddings ambigua"
    with np.load(embedding_files[0], allow_pickle=False) as cached:
        vectors = cached["vectors"]
    assert vectors.shape == (79, 1024) and np.isfinite(vectors).all()
    start = {"started_at": now(), "source_sha256": original["source_sha256"],
             "protocol_sha256": protocol_hash, "script_sha256": script_hash,
             "development_embeddings_sha256": digest(embedding_files[0]),
             "test_accessed_at_start": False}
    save(OUT / "inicio.json", start)
    texts = [r["text"] for r in development]
    runs, fitted, reducers = [], {}, {}
    labels = {split: {n: [] for n in VARIANTS} for split in ["train", "validation", "test"]}
    for seed in SEEDS:
        started = perf_counter()
        reducer = UMAP(n_components=5, n_neighbors=15, min_dist=0, metric="cosine",
                       n_epochs=500, random_state=seed, transform_seed=seed, n_jobs=1)
        train_xy = reducer.fit_transform(vectors[:59])
        val_xy = reducer.transform(vectors[59:])
        reducers[seed] = reducer
        run = {"seed": seed, "shared_umap_seconds": perf_counter() - started}
        fitted[seed] = {}
        for name in VARIANTS:
            started = perf_counter()
            if name == "bertopic":
                model = BERTopic(embedding_model=None, umap_model=BaseDimensionalityReduction(),
                                 hdbscan_model=HDBSCAN(min_cluster_size=10, min_samples=5, metric="euclidean",
                                                       cluster_selection_method="eom", prediction_data=True, core_dist_n_jobs=1),
                                 vectorizer_model=CountVectorizer(stop_words="english"),
                                 calculate_probabilities=False, verbose=False)
                train_labels, _ = model.fit_transform(texts[:59], embeddings=train_xy)
                val_labels, _ = model.transform(texts[59:], embeddings=val_xy)
            else:
                model = KMeans(n_clusters=10 if name == "kmeans10" else 5, init="k-means++",
                               n_init=10, max_iter=300, random_state=seed)
                train_labels = model.fit_predict(train_xy)
                val_labels = model.predict(val_xy)
            run[name] = {"fit_predict_seconds": perf_counter() - started,
                         "train": metrics(vectors[:59], train_labels), "validation": metrics(vectors[59:], val_labels)}
            fitted[seed][name] = model
            labels["train"][name].append(np.asarray(train_labels))
            labels["validation"][name].append(np.asarray(val_labels))
        runs.append(run)
        print(json.dumps({"seed": seed, "validation": {n: run[n]["validation"] for n in VARIANTS}}), flush=True)
    validation = aggregate(runs, labels["validation"], "validation")
    common = common_comparisons(vectors[59:], labels["validation"])
    selected, checks = choose(validation, common)
    selection = {"selected": selected, "selected_at": now(), "operating_seed": 42,
                 "source_sha256": original["source_sha256"], "protocol_sha256": protocol_hash,
                 "validation_silhouette_mean": validation[selected]["silhouette_cosine"]["mean"],
                 "coverage_percent": validation[selected]["coverage_percent"]["mean"],
                 "checks": checks, "test_seen_before_selection": False, "development_n": 79,
                 "group_file": ".cache/validacion-t6/grupos.jsonl"}
    save(OUT / "seleccion.json", selection)
    frozen_selection_hash = digest(OUT / "seleccion.json")
    save(OUT / "validacion.json", {"runs": runs, "validation": validation, "common_support": common})
    selected_labels = np.concatenate([labels["train"][selected][0], labels["validation"][selected][0]])
    exported = [{**r, "group": int(label), "variant": selected, "seed": 42} for r, label in zip(development, selected_labels)]
    (OUT / "grupos.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in exported))
    (OUT / "grupos.jsonl").chmod(0o600)
    # Descriptores de desarrollo para la UI; solo los 59 textos de ajuste definen su vocabulario.
    tfidf = TfidfVectorizer(stop_words="english", max_features=1500)
    words_matrix = tfidf.fit_transform([re.sub(r"https?://\S+|@\w+", " ", t) for t in texts[:59]])
    words = tfidf.get_feature_names_out()
    descriptors = []
    for group in sorted(set(selected_labels[:59])):
        if group < 0:
            continue
        idx = np.flatnonzero(selected_labels[:59] == group)
        averages = np.asarray(words_matrix[idx].mean(axis=0)).ravel()
        descriptors.append({"group": int(group), "keywords": [str(words[i]) for i in averages.argsort()[::-1][:5] if averages[i] > 0],
                            "train_n": len(idx), "validation_n": int(np.sum(selected_labels[59:] == group))})
    save(OUT / "descriptores.json", descriptors)
    print(json.dumps({"selection_frozen": selection}), flush=True)
    # La prueba reservada solo se prepara y representa después de guardar la selección.
    test_opened_at = now()
    rows, _ = prepare([json.loads(line) for line in source.read_text().splitlines() if line.strip()])
    all_lookup = {r["id"]: r for r in rows}
    test_rows = [all_lookup[i] for i in manifest["test"]]
    import torch
    from sentence_transformers import SentenceTransformer
    torch.set_num_threads(4)
    torch.manual_seed(42)
    started = perf_counter()
    encoder = SentenceTransformer(MODEL, revision=REVISION, device="cpu", local_files_only=True,
                                  trust_remote_code=False, model_kwargs={"torch_dtype": torch.float32})
    test_texts = [r["input_text"] for r in test_rows]
    assert max(len(encoder.tokenizer.encode(t)) for t in test_texts) <= encoder.max_seq_length
    test_vectors = encoder.encode(test_texts, batch_size=4, normalize_embeddings=True, show_progress_bar=False, convert_to_numpy=True)
    test_embedding_seconds = perf_counter() - started
    del encoder
    assert test_vectors.shape == (20, 1024) and np.isfinite(test_vectors).all()
    np.savez_compressed(OUT / "embeddings-prueba.npz", vectors=test_vectors)
    for index, seed in enumerate(SEEDS):
        started = perf_counter()
        test_xy = reducers[seed].transform(test_vectors)
        runs[index]["shared_test_umap_seconds"] = perf_counter() - started
        for name in VARIANTS:
            started = perf_counter()
            model = fitted[seed][name]
            test_labels = model.transform(test_texts, embeddings=test_xy)[0] if name == "bertopic" else model.predict(test_xy)
            runs[index][name]["test_predict_seconds"] = perf_counter() - started
            runs[index][name]["test"] = metrics(test_vectors, test_labels)
            labels["test"][name].append(np.asarray(test_labels))
    assert digest(OUT / "seleccion.json") == frozen_selection_hash, "La selección cambió después de abrir la prueba"
    old_labels = np.asarray([lookup[i]["group"] for i in ids])
    new_labels = np.concatenate([labels["train"]["kmeans10"][0], labels["validation"]["kmeans10"][0]])
    results = {**start, "completed_at": now(), "python": platform.python_version(), "platform": platform.platform(),
               "versions": {p: version(p) for p in PACKAGES}, "model": MODEL, "model_revision": REVISION,
               "seeds": SEEDS, "split_sizes": {k: len(v) for k, v in manifest.items()},
               "sample_span_seconds": original["sample"]["span_seconds"], "runs": runs,
               "train_summary": aggregate(runs, labels["train"], "train"), "validation_summary": validation,
               "validation_common_support": common, "selection": selection, "selection_sha256": frozen_selection_hash,
               "test_opened_at": test_opened_at, "test_evaluated": True, "test_no_longer_reserved": True,
               "test_summary": aggregate(runs, labels["test"], "test"),
               "test_common_support": common_comparisons(test_vectors, labels["test"]),
               "test_embedding_seconds": test_embedding_seconds,
               "baseline_reproduction_ari_seed42_development": float(adjusted_rand_score(old_labels, new_labels)),
               "additional_x_cost_usd": 0, "additional_embedding_api_cost_usd": 0,
               "uncertainty": "Sample SD and ranges over seeds describe algorithm sensitivity, not population confidence intervals; ARI pairs are dependent.",
               "limitations": ["One convenience sample spanning 28m37s", "20 validation and 20 final-test texts", "No manual topic labels", "Coverage does not establish relevance", "No retuning after final test"]}
    save(OUT / "etiquetas.json", {split: {name: [v.tolist() for v in values] for name, values in per_model.items()} for split, per_model in labels.items()})
    save(ROOT / "resultados-tarea6.json", results)
    print(json.dumps({"completed": True, "selected": selected, "validation": {n: validation[n]["silhouette_cosine"] for n in VARIANTS},
                      "test": {n: results["test_summary"][n]["silhouette_cosine"] for n in VARIANTS}}), flush=True)


if __name__ == "__main__":
    main()
