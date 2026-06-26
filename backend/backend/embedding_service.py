"""
embedding_service.py - Multilingual sentence embedding service.

Loads the paraphrase-multilingual-MiniLM-L12-v2 model once at startup
and reuses it for all requests. The model runs on an Azure B1 instance
(about 1 GB RAM). We use MiniLM over the larger mpnet model to stay within
B1 memory limits; the trade-off is slightly lower cross-language accuracy,
which is handled by the adjusted threshold in connection_scorer.py.

Public functions:
    load()                        - download or load the model from cache
    encode(text) -> list[float]   - get a 384-dim vector for any text
    similarity(a, b) -> float     - cosine similarity between two texts
    best_match(query, candidates) - find the closest match from a list
"""

from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# Model name. Swap to mpnet-base-v2 on a B2+ plan for better accuracy (needs ~2 GB RAM).
_MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"

# Cache directory for model files. Set ST_CACHE_DIR=/home/.st_cache in Azure App Service
# so the model persists across restarts. Leave unset locally to use the default.
_CACHE_DIR = os.getenv("ST_CACHE_DIR") or None

# Singleton state
_model = None          # SentenceTransformer instance, set by load()
_model_loaded = False  # Prevents loading the model more than once


# Lifecycle

def load() -> None:
    """Load the embedding model into memory. Call this once at startup. Safe to call multiple times."""
    global _model, _model_loaded

    if _model_loaded:
        return

    try:
        # Limit PyTorch threads to 1 since the B1 instance has a single CPU core.
        os.environ.setdefault("OMP_NUM_THREADS", "1")
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

        # Import torch first so its errors are surfaced clearly instead of being
        # hidden behind a "sentence-transformers not installed" message.
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


# Inference functions

def encode(text: str) -> Optional[list]:
    """Convert text to a 384-dim embedding vector as a plain list of floats.
    Returns None if the model is not loaded.
    """
    if not is_available():
        return None
    vec = _model.encode(text, convert_to_numpy=True, normalize_embeddings=True)  # type: ignore[union-attr]
    return vec.tolist()


def similarity(text_a: str, text_b: str) -> Optional[float]:
    """Return cosine similarity between two texts as a float in [0, 1],
    or None if the model is not loaded.
    """
    if not is_available():
        return None
    import numpy as np

    vec_a = _model.encode(text_a, convert_to_numpy=True, normalize_embeddings=True)  # type: ignore[union-attr]
    vec_b = _model.encode(text_b, convert_to_numpy=True, normalize_embeddings=True)  # type: ignore[union-attr]

    cos_sim = float(np.dot(vec_a, vec_b))
    # Clamp to [0, 1] - negative similarity scores are treated as 0
    return max(0.0, min(1.0, cos_sim))


def best_match(query: str, candidates: list[str]) -> Optional[tuple[str, float]]:
    """Find the closest matching text from a list of candidates.
    Returns (best_text, score), or None if the model is not loaded or the list is empty.
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
