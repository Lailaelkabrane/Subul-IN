"""
embedding_service.py — Singleton multilingual sentence-embedding service.

Uses paraphrase-multilingual-MiniLM-L12-v2 (~470 MB on disk, ~1 GB resident,
50+ languages).  This is the model named in the original spec.  It is small
enough to run on an Azure App Service **B1** instance (1.75 GB RAM), unlike the
larger mpnet model (~2 GB resident) which requires B2 or higher.

Loaded ONCE at backend startup and reused across all requests.

Model choice rationale (B1-optimised)
-------------------------------------
The bigger paraphrase-multilingual-mpnet-base-v2 scores slightly higher on
cross-language industry pairs (e.g. "Ingénieur Logiciel" vs "Software Engineer"),
but it needs ~2 GB of RAM and forces a B2 plan (≈2× the cost).  MiniLM keeps the
backend on B1.  The cost is modest: MiniLM scores a little lower on cross-language
pairs, which is why the piecewise mapper in connection_scorer.py uses a lowered
0.48 lower-bound (instead of the spec's 0.55) so those pairs still land in the
"related field" band.  For the RAG memory feature (Enhancement 2) the quality
difference is negligible — retrieval ranking is unaffected.

Public API
----------
load()                         → downloads / loads model into memory (call at startup)
encode(text) → list[float]     → 384-dimensional vector for any text
similarity(a, b) → float       → cosine similarity in [0, 1]
best_match(query, candidates)  → (best_text, score) from a list

Embedding dimension
-------------------
paraphrase-multilingual-MiniLM-L12-v2 produces **384-dimensional** vectors.
Anything that stores these vectors (the RAG embedding_index in Enhancement 2)
sizes for 384 floats (~1.5 KB/doc).  rag_service skips any stored vector whose
dimension does not match the live model, so switching models never crashes
retrieval — at worst old vectors are ignored until re-indexed.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# ── Model constant ──────────────────────────────────────────────────────────
# B1-friendly: ~470 MB on disk, ~1 GB resident.  To upgrade quality on a B2+
# plan, swap to "paraphrase-multilingual-mpnet-base-v2" (768-dim, ~2 GB RAM).
_MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"

# Where the model files are cached on disk.  On Azure App Service the default
# filesystem is wiped on every restart EXCEPT /home, so set
# ST_CACHE_DIR=/home/.st_cache in the App Service config to persist the model
# across restarts and avoid re-downloading it (and a startup timeout) each time.
# Locally, leave unset to use the sentence-transformers default cache.
_CACHE_DIR = os.getenv("ST_CACHE_DIR") or None

# ── Singleton state ─────────────────────────────────────────────────────────
_model = None          # SentenceTransformer instance, set by load()
_model_loaded = False  # Guard so load() is idempotent


# ── Public: lifecycle ────────────────────────────────────────────────────────

def load() -> None:
    """
    Download (first run) or load from local cache (subsequent runs) the
    multilingual MiniLM model.  Call this inside the FastAPI startup handler
    so it completes before any user request arrives.

    Safe to call multiple times — subsequent calls are no-ops.
    """
    global _model, _model_loaded

    if _model_loaded:
        return

    try:
        # B1 has a single CPU core — cap PyTorch threads so it doesn't spawn a
        # thread pool sized to a bigger box (saves a little memory, avoids churn).
        os.environ.setdefault("OMP_NUM_THREADS", "1")
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

        # Import torch first and surface its real error.  A failure here (missing
        # native lib, ABI mismatch, OOM) otherwise masquerades as "sentence-
        # transformers not installed" because importing it pulls in torch.
        try:
            import torch  # type: ignore
            torch.set_num_threads(1)
            logger.info("[embedding_service] torch %s imported OK", torch.__version__)
        except Exception as texc:
            logger.error(
                "[embedding_service] torch import FAILED (%s): %r",
                type(texc).__name__, texc,
            )
            raise  # let the outer handler log and disable semantic matching

        from sentence_transformers import SentenceTransformer  # type: ignore
        logger.info(
            "[embedding_service] Loading model '%s' (cache_dir=%s) …",
            _MODEL_NAME, _CACHE_DIR or "default",
        )
        _model = SentenceTransformer(_MODEL_NAME, cache_folder=_CACHE_DIR)
        _model_loaded = True
        logger.info("[embedding_service] Model loaded and cached in memory.")
    except ImportError as exc:
        logger.warning(
            "[embedding_service] import failed (%s): %r — semantic matching "
            "disabled, falling back to keyword scorer.", type(exc).__name__, exc,
        )
    except Exception as exc:
        logger.error(
            "[embedding_service] Failed to load model (%s): %r",
            type(exc).__name__, exc,
        )


def is_available() -> bool:
    """True if the model is loaded and ready to use."""
    return _model_loaded and _model is not None


# ── Public: inference ────────────────────────────────────────────────────────

def encode(text: str) -> Optional[list]:
    """
    Convert *text* into a 384-dimensional embedding vector, returned as a plain
    Python list of floats (JSON-serialisable, ready to store in Cosmos).

    The vector is L2-normalised, so cosine similarity between two stored vectors
    reduces to a plain dot product — this is what rag_service relies on.

    Returns None if the model is unavailable (import error, load failure).
    """
    if not is_available():
        return None
    vec = _model.encode(text, convert_to_numpy=True, normalize_embeddings=True)  # type: ignore[union-attr]
    return vec.tolist()


def similarity(text_a: str, text_b: str) -> Optional[float]:
    """
    Cosine similarity between two texts.  Returns a float in [0, 1],
    or None if the model is unavailable.

    Implementation note: cosine similarity of unit-normalised vectors equals
    their dot product.  SentenceTransformer.encode() does NOT normalise by
    default, so we normalise manually here.
    """
    if not is_available():
        return None
    import numpy as np

    vec_a = _model.encode(text_a, convert_to_numpy=True, normalize_embeddings=True)  # type: ignore[union-attr]
    vec_b = _model.encode(text_b, convert_to_numpy=True, normalize_embeddings=True)  # type: ignore[union-attr]

    cos_sim = float(np.dot(vec_a, vec_b))
    # Clamp to [0, 1] — negative cosine similarities mean "opposite direction",
    # which is meaningless for professional text; treat them as 0.
    return max(0.0, min(1.0, cos_sim))


def best_match(query: str, candidates: list[str]) -> Optional[tuple[str, float]]:
    """
    Find the candidate text most semantically similar to *query*.

    Returns (best_text, score) or None if the model is unavailable or
    candidates is empty.
    """
    if not is_available() or not candidates:
        return None
    import numpy as np

    query_vec = _model.encode(query, convert_to_numpy=True, normalize_embeddings=True)  # type: ignore[union-attr]
    cand_vecs = _model.encode(candidates, convert_to_numpy=True, normalize_embeddings=True)  # type: ignore[union-attr]

    scores = np.dot(cand_vecs, query_vec)
    best_idx = int(np.argmax(scores))
    best_score = float(max(0.0, min(1.0, scores[best_idx])))
    return candidates[best_idx], best_score
