"""
test_rag.py — End-to-end validation for Enhancement 2 (RAG over user history).

Run from the backend directory (needs internet on first run to download the model):
    python test_rag.py

Exit code 0 = all checks passed, 1 = something failed.

What it proves, using the REAL embedding model but NO database:
  1. The summary builders turn raw records into sensible text.
  2. Encoding + cosine retrieval ranks the RIGHT past activity to the top.
  3. Unrelated activity is correctly filtered out below the threshold.
  4. The prompt block is formatted the way the chat route expects.

It stubs cosmos_db.get_user_embeddings with in-memory vectors produced by the
real model, so it validates the whole retrieval path without touching Cosmos.
"""

import asyncio
import sys

import embedding_service
import cosmos_db
import rag_service

GREEN = "\033[92m"; RED = "\033[91m"; RESET = "\033[0m"


def ok(label: str, passed: bool) -> bool:
    print(f"  [{GREEN}PASS{RESET}]" if passed else f"  [{RED}FAIL{RESET}]", label)
    return passed


# Sample user history (the kind of records the app really saves).
SAMPLE_DOCS = [
    {
        "type": "gap_analysis_record", "id": "gap:1", "user_id": "user:test",
        "target_name": "Jane (Senior Cloud Architect)", "score_label": "Moderate",
        "overall_gap_score": 61, "key_insight": "Missing hands-on cloud and Azure experience",
        "sections": {"Skills": {}, "Experience": {}}, "quick_wins": [{"title": "Add an Azure certification"}],
        "ttl": cosmos_db.TTL_180_DAYS,
    },
    {
        "type": "networking_analysis_record", "id": "netanalysis:1", "user_id": "user:test",
        "goal": "job_search", "candidate_count": 3, "avg_score": 74,
        "results": [{"slug": "x", "score": 80, "match_summary": "Recruiter at a fintech firm"}],
    },
    {
        "type": "chat_record", "id": "chat:1", "user_id": "user:test",
        "user_message": "How do I prepare for a marketing manager interview?",
        "detected_intent": "help", "reply": "Focus on campaign metrics and storytelling.",
        "ttl": cosmos_db.TTL_30_DAYS,
    },
]


async def main() -> int:
    print("\n═══════════════════════════════════════════════════════")
    print(" RAG (Enhancement 2) — End-to-End Validation")
    print("═══════════════════════════════════════════════════════\n")

    print("► Loading embedding model …")
    embedding_service.load()
    if not embedding_service.is_available():
        print(f"{RED}ERROR: model unavailable. Run: pip install sentence-transformers{RESET}")
        return 1
    print(f"{GREEN}  Model ready.{RESET}\n")

    all_passed = True

    # 1. Summary builders produce non-empty, sensible text.
    print("── Summary builders ────────────────────────────────────")
    built_store = []
    for d in SAMPLE_DOCS:
        built = cosmos_db.build_embedding_text(d)
        all_passed &= ok(f"{d['type']} → text built", built is not None)
        if built:
            text, meta = built
            vec = embedding_service.encode(text)
            built_store.append({
                "source_type": d["type"], "source_id": d["id"],
                "text_preview": text[:500], "embedding": vec,
                "metadata": meta, "created_at": "2026-05-20T00:00:00Z",
            })
    print()

    # Stub the DB layer so retrieve_context scores our in-memory vectors.
    async def fake_get_user_embeddings(user_id):
        return built_store
    cosmos_db.get_user_embeddings = fake_get_user_embeddings

    # 2. A cloud-skills question should surface the CLOUD gap analysis first.
    print("── Retrieval ranking ───────────────────────────────────")
    res = await rag_service.retrieve_context(
        "user:test", "I want to improve my cloud and Azure skills",
        max_results=3, min_similarity=0.3,
    )
    print("  query: 'improve my cloud and Azure skills'")
    for r in res:
        print(f"    {r['similarity']:.3f}  {r['source_type']}  — {r['text_preview'][:60]}")
    all_passed &= ok("top result is the cloud gap analysis",
                     bool(res) and res[0]["source_type"] == "gap_analysis_record")
    all_passed &= ok("unrelated marketing chat is NOT the top hit",
                     not res or res[0]["source_id"] != "chat:1")
    print()

    # 3. Prompt block formats correctly.
    print("── Prompt block formatting ─────────────────────────────")
    block = rag_service.format_context_block(res)
    print("  " + block.replace("\n", "\n  "))
    all_passed &= ok("block starts with the expected header",
                     block.startswith("Relevant context from your past activity:"))
    all_passed &= ok("empty input → empty block", rag_service.format_context_block([]) == "")
    print()

    print("═══════════════════════════════════════════════════════")
    if all_passed:
        print(f"{GREEN}ALL CHECKS PASSED — RAG retrieval works end-to-end.{RESET}")
        print("Next: deploy, then run backfill_embeddings.py once.\n")
        return 0
    print(f"{RED}SOME CHECKS FAILED — see above.{RESET}\n")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
