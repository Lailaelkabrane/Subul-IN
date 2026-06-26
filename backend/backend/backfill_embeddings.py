"""
backfill_embeddings.py - One-time script to index existing user history for the RAG feature.

New documents are indexed automatically when saved. This script handles existing
documents that were created before the RAG feature was added.

Run once after deploying:
    python backfill_embeddings.py

Safe to run multiple times - already indexed documents are skipped.
"""

import asyncio
import sys

import cosmos_db
import embedding_service


async def backfill() -> int:
    print("\n═══════════════════════════════════════════════════════")
    print(" RAG Backfill — indexing existing user history")
    print("═══════════════════════════════════════════════════════\n")

    if not cosmos_db.cosmos_configured():
        print("ERROR: Cosmos DB is not configured (check .env).")
        return 1

    print("► Loading embedding model …")
    embedding_service.load()
    if not embedding_service.is_available():
        print("ERROR: embedding model unavailable. Run: pip install sentence-transformers")
        return 1
    print("  Model ready.\n")

    totals = {"indexed": 0, "skipped": 0, "empty": 0, "failed": 0}

    for source_type in cosmos_db.EMBEDDABLE_SOURCE_TYPES:
        print(f"── {source_type} ───────────────────────────────")
        type_counts = {"indexed": 0, "skipped": 0, "empty": 0, "failed": 0}

        async for doc in cosmos_db.iter_documents_by_type(source_type):
            source_id = doc.get("id")
            if not source_id:
                continue

            # Skip documents that are already indexed
            try:
                if await cosmos_db.embedding_exists(source_id):
                    type_counts["skipped"] += 1
                    continue
            except Exception:
                pass

            built = cosmos_db.build_embedding_text(doc)
            if built is None:
                type_counts["empty"] += 1  # document has no useful text to embed
                continue
            text, meta = built

            try:
                emb_id = await cosmos_db.save_embedding(
                    source_id=source_id,
                    user_id=doc.get("user_id", "anonymous"),
                    source_type=source_type,
                    text=text,
                    metadata=meta,
                    ttl=doc.get("ttl"),  # match the source's expiry
                )
                if emb_id:
                    type_counts["indexed"] += 1
                else:
                    type_counts["skipped"] += 1
            except Exception as exc:
                type_counts["failed"] += 1
                print(f"    ! failed {source_id}: {exc}")

        print(f"    indexed={type_counts['indexed']}  skipped={type_counts['skipped']}  "
              f"empty={type_counts['empty']}  failed={type_counts['failed']}\n")
        for k in totals:
            totals[k] += type_counts[k]

    print("═══════════════════════════════════════════════════════")
    print(f" DONE — indexed={totals['indexed']}  skipped={totals['skipped']}  "
          f"empty(no-signal)={totals['empty']}  failed={totals['failed']}")
    print("═══════════════════════════════════════════════════════\n")

    await cosmos_db.close_cosmos()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(backfill()))
