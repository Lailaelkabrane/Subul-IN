"""
test_semantic_matching.py — Validates the embedding service and scorer integration.

Run from the backend directory:
    python test_semantic_matching.py

Exit code 0 = all assertions passed.
Exit code 1 = one or more assertions failed.

The five test pairs are chosen to cover the exact failure modes of the
keyword dictionary (synonyms, related fields, cross-language, missing terms).
"""

import sys
import embedding_service
from connection_scorer import _industry_alignment_score_semantic, score_profile

# ── Colours for terminal output ──────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
RESET  = "\033[0m"


def check(label: str, score: float, min_expected: float, max_expected: float = 1.0) -> bool:
    ok = min_expected <= score <= max_expected
    status = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"  [{status}] {label}")
    print(f"         score={score:.3f}  expected=[{min_expected:.2f}, {max_expected:.2f}]")
    return ok


def main() -> int:
    print("\n═══════════════════════════════════════════════════════")
    print(" Semantic Matching — Validation Test Suite")
    print("═══════════════════════════════════════════════════════\n")

    # ── 1. Load model ────────────────────────────────────────────────────────
    print("► Loading embedding model …")
    embedding_service.load()

    if not embedding_service.is_available():
        print(f"{RED}ERROR: Model failed to load.  "
              f"Run: pip install sentence-transformers{RESET}\n")
        return 1

    print(f"{GREEN}  Model ready.{RESET}\n")

    # ── 2. Raw similarity tests ──────────────────────────────────────────────
    print("── Raw cosine similarity tests ─────────────────────────\n")

    pairs = [
        # (label, text_a, text_b, min_expected, max_expected)
        (
            "Synonyms: Software Engineer vs Generative AI Engineer",
            "Software Engineer technology",
            "Generative AI Engineer technology",
            0.60, 1.0,          # mpnet scores ~0.60; MiniLM scored ~0.67 on this pair
        ),
        (
            "Related fields: Cybersecurity Analyst vs Security Operations Specialist",
            "Cybersecurity Analyst security",
            "Security Operations Specialist security",
            0.60, 1.0,
        ),
        (
            "Unrelated: Data Scientist vs Marketing Manager",
            "Data Scientist technology data",
            "Marketing Manager marketing",
            0.00, 0.50,
        ),
        (
            "Cross-language: Ingénieur Logiciel (FR) vs Software Engineer (EN)",
            "Ingénieur Logiciel technologie",
            "Software Engineer technology",
            0.70, 1.0,          # <0.70 means wrong model — see spec
        ),
        (
            "Subtle: Prompt Engineer vs Machine Learning Researcher",
            "Prompt Engineer AI technology",
            "Machine Learning Researcher AI technology",
            0.55, 1.0,
        ),
    ]

    all_passed = True
    for label, a, b, lo, hi in pairs:
        raw = embedding_service.similarity(a, b)
        ok = check(label, raw, lo, hi)
        all_passed = all_passed and ok
    print()

    # ── 3. Piecewise score mapping tests ─────────────────────────────────────
    print("── Piecewise mapping (_industry_alignment_score_semantic) ──\n")

    mapping_cases = [
        ("Strong match → score ≥ 0.6",
         "Software Engineer technology",
         "Generative AI Engineer technology",
         0.60, 1.0),
        ("Cross-language → score ≥ 0.6",
         "Ingénieur Logiciel technologie",
         "Software Engineer technology",
         0.60, 1.0),
        ("Unrelated → score ≤ 0.5",
         "Data Scientist technology",
         "Marketing Manager marketing",
         0.00, 0.50),
    ]

    for label, a, b, lo, hi in mapping_cases:
        score = _industry_alignment_score_semantic(a, b)
        ok = check(label, score, lo, hi)
        all_passed = all_passed and ok
    print()

    # ── 4. End-to-end score_profile integration test ─────────────────────────
    print("── score_profile integration (USE_SEMANTIC_INDUSTRY=True) ──\n")

    import connection_scorer
    original_flag = connection_scorer.USE_SEMANTIC_INDUSTRY
    connection_scorer.USE_SEMANTIC_INDUSTRY = True  # force semantic path for test

    user = {
        "industry": "technology",
        "job_title": "Senior Software Engineer",
        "skills": ["Python", "FastAPI", "Azure"],
        "goal": "clients",
        "seniority": "senior",
    }

    candidate_same = {
        "industry": "",
        "title": "Ingénieur Logiciel Senior",        # French title, same field
        "skills": ["Python", "FastAPI"],
        "company": "TechCorp",
        "mutual_connections_count": 3,
        "post_frequency": "weekly",
        "avg_engagement_rate": 1.5,
    }

    candidate_diff = {
        "industry": "",
        "title": "Marketing Manager",
        "skills": ["Branding", "SEO"],
        "company": "AdAgency",
        "mutual_connections_count": 0,
        "post_frequency": "monthly",
        "avg_engagement_rate": 0.5,
    }

    result_same = score_profile(user, candidate_same, goal="clients")
    result_diff = score_profile(user, candidate_diff, goal="clients")

    print(f"  French SW Engineer score : {result_same['total']}")
    print(f"  Marketing Manager score  : {result_diff['total']}")
    print(f"  Breakdown (FR engineer)  : {result_same['breakdown']}")

    ok_ordering = result_same["total"] > result_diff["total"]
    ok_label = "French SW Engineer scores higher than Marketing Manager"
    status = f"{GREEN}PASS{RESET}" if ok_ordering else f"{RED}FAIL{RESET}"
    print(f"\n  [{status}] {ok_label}")
    all_passed = all_passed and ok_ordering

    connection_scorer.USE_SEMANTIC_INDUSTRY = original_flag  # restore

    # ── 5. Summary ───────────────────────────────────────────────────────────
    print("\n═══════════════════════════════════════════════════════")
    if all_passed:
        print(f"{GREEN}ALL TESTS PASSED — semantic matching is working correctly.{RESET}")
        print("Next step: set USE_SEMANTIC_INDUSTRY=false in .env and deploy.")
        print("After one week of parallel logging, flip to true.\n")
        return 0
    else:
        print(f"{RED}SOME TESTS FAILED — see details above.{RESET}")
        print("If the cross-language test failed, check the model name in embedding_service.py.\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
