"""
rag_service.py - Retrieval for the chat assistant.

Before the assistant answers a question, retrieve_context() looks up the
user's past activity (gap analyses, scores, network scans, chat history,
profile snapshots) and injects the most relevant items into the prompt.

How it works:
  1. Embed the user's question.
  2. Load all stored embedding docs for that user.
  3. Compute cosine similarity in Python and filter below the threshold.
  4. Return the top matches sorted by relevance.

This uses the same embedding model as connection_scorer so there is no
extra infrastructure or cost.
"""

from __future__ import annotations

import logging
from typing import Optional

import cosmos_db
import embedding_service

logger = logging.getLogger(__name__)

# Labels shown in the context block sent to the LLM
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
    """Return the most relevant past activity for a given query.

    Returns a list sorted by similarity (highest first). Returns an empty list
    if the model is unavailable, the user has no history, or nothing passes
    the similarity threshold. Never raises - retrieval errors must not break chat.
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
                # Skip vectors with wrong dimensions (e.g. stored before a model change)
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
    """Format retrieved items as a text block to include in the LLM prompt.
    Returns an empty string if there are no items.
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
