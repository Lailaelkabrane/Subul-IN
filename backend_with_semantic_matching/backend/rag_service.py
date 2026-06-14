"""
rag_service.py — Retrieval-Augmented Generation over a user's own history.

Gives the AI Assistant memory: before answering, the chat route calls
retrieve_context() to pull the most relevant past activity (gap analyses, AI
scores, networking scans, chats, profile snapshots) from the user's own
embedding_index, and injects it into the prompt.

How it works (no separate vector database)
-------------------------------------------
Every embeddable document is mirrored at write time into an `embedding_index`
Cosmos doc holding a 768-dim sentence-embedding vector (see cosmos_db.py).  At
query time we:

    1. embed the user's question with the SAME model,
    2. pull all of that user's embedding docs (typically <300),
    3. compute cosine similarity in Python (brute force, <100ms),
    4. filter below a relevance threshold, sort, return the top matches.

Cosine == dot product here because embedding_service.encode() L2-normalises
every vector, so no per-query normalisation maths is needed.

Reuses Enhancement 1's embedding model — zero extra cost, zero extra infra.
"""

from __future__ import annotations

import logging
from typing import Optional

import cosmos_db
import embedding_service

logger = logging.getLogger(__name__)

# Human-readable labels for each source type, used when formatting the prompt block.
_SOURCE_LABELS = {
    "gap_analysis_record":        "Gap analysis",
    "ai_score_record":            "AI profile score",
    "networking_analysis_record": "Networking scan",
    "chat_record":                "Past chat",
    "profile_snapshot":           "Profile snapshot",
}


async def retrieve_context(
    user_id: str,
    query: str,
    max_results: int = 5,
    min_similarity: float = 0.4,
) -> list[dict]:
    """Return the user's most relevant past activity for *query*.

    Args:
        user_id:        the user whose history to search.
        query:          the current question / message to find context for.
        max_results:    cap on how many items to return (typically 3-5).
        min_similarity: drop matches below this cosine score (typically 0.4 —
                        below this, results are too unrelated to be useful).

    Returns a list (highest similarity first) of dicts:
        {
            "similarity":   float,
            "source_type":  str,
            "source_id":    str,
            "text_preview": str,
            "metadata":     dict,
            "created_at":   str (ISO),
        }
    Returns [] if the model is unavailable, the user has no history, or nothing
    clears the threshold.  Never raises — retrieval failure must not break chat.
    """
    if not query or not query.strip():
        return []
    if not embedding_service.is_available():
        return []

    try:
        import numpy as np

        query_vec = embedding_service.encode(query)  # 768-dim, L2-normalised list
        if not query_vec:
            return []
        q = np.asarray(query_vec, dtype="float32")

        stored = await cosmos_db.get_user_embeddings(user_id)
        if not stored:
            return []

        scored: list[tuple[float, dict]] = []
        for doc in stored:
            vec = doc.get("embedding")
            if not vec:
                continue
            v = np.asarray(vec, dtype="float32")
            if v.shape != q.shape:
                # Dimension mismatch (e.g. an old 384-dim vector after a model
                # change) — skip rather than crash.
                continue
            sim = float(np.dot(q, v))  # both unit-normalised → cosine similarity
            if sim >= min_similarity:
                scored.append((sim, doc))

        scored.sort(key=lambda x: x[0], reverse=True)

        results = []
        for sim, doc in scored[:max_results]:
            results.append({
                "similarity":   round(sim, 3),
                "source_type":  doc.get("source_type", ""),
                "source_id":    doc.get("source_id", ""),
                "text_preview": doc.get("text_preview", ""),
                "metadata":     doc.get("metadata", {}),
                "created_at":   doc.get("created_at", ""),
            })
        return results

    except Exception as exc:
        logger.warning("[rag_service] retrieve_context failed for %s: %s", user_id, exc)
        return []


def format_context_block(items: list[dict]) -> str:
    """Render retrieved items into a prompt-ready block, or "" if none.

    The block is clearly demarcated so the LLM can distinguish the user's past
    activity from the current question.
    """
    if not items:
        return ""

    lines = ["Relevant context from your past activity:"]
    for it in items:
        label = _SOURCE_LABELS.get(it.get("source_type", ""), it.get("source_type", "Activity"))
        date = (it.get("created_at", "") or "")[:10]  # YYYY-MM-DD
        preview = (it.get("text_preview", "") or "").strip()
        date_str = f" ({date})" if date else ""
        lines.append(f"- [{label}{date_str}] {preview}")
    return "\n".join(lines)
