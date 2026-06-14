"""
connection_scorer.py — Rule-based connection scoring engine (Phase 1).

Scores a LinkedIn candidate profile from 0-100 based on five factors,
with weights adjusted per the user's networking goal.

Phase 1: Deterministic weighted-sum (no ML needed, zero training data required).
Phase 2: Replace with XGBoost/LightGBM once 500+ interactions are logged.
"""

import os
from typing import Optional

import embedding_service

# ─────────────────────────────────────────────────────────
#  FEATURE FLAG — semantic vs keyword industry matching
#
#  Set USE_SEMANTIC_INDUSTRY=true in your .env to activate.
#  Defaults to False so you can run both scorers in parallel,
#  compare them in logs, and flip only when data confirms it.
# ─────────────────────────────────────────────────────────

USE_SEMANTIC_INDUSTRY: bool = os.getenv("USE_SEMANTIC_INDUSTRY", "false").lower() in ("true", "1", "yes")

# ─────────────────────────────────────────────────────────
#  WEIGHT TABLES  (must sum to 1.0 per goal)
# ─────────────────────────────────────────────────────────

WEIGHTS: dict[str, dict[str, float]] = {
    "job_search": {
        "industry_alignment":  0.20,
        "mutual_connections":  0.20,
        "engagement_rate":     0.15,
        "company_relevance":   0.35,
        "seniority_match":     0.10,
    },
    "clients": {
        "industry_alignment":  0.35,
        "mutual_connections":  0.15,
        "engagement_rate":     0.15,
        "company_relevance":   0.20,
        "seniority_match":     0.15,
    },
    "investors": {
        "industry_alignment":  0.15,
        "mutual_connections":  0.20,
        "engagement_rate":     0.30,
        "company_relevance":   0.20,
        "seniority_match":     0.15,
    },
    "learning": {
        "industry_alignment":  0.20,
        "mutual_connections":  0.15,
        "engagement_rate":     0.40,
        "company_relevance":   0.10,
        "seniority_match":     0.15,
    },
}

# Default weights when goal is unrecognised
WEIGHTS["default"] = {
    "industry_alignment":  0.25,
    "mutual_connections":  0.20,
    "engagement_rate":     0.20,
    "company_relevance":   0.20,
    "seniority_match":     0.15,
}

# ─────────────────────────────────────────────────────────
#  SENIORITY LEVELS  (lower index = more junior)
# ─────────────────────────────────────────────────────────

SENIORITY_ORDER = ["intern", "junior", "mid", "senior", "lead", "manager", "director", "vp", "executive", "founder", "ceo", "cto", "coo", "cfo"]

SENIORITY_KEYWORDS: dict[str, list[str]] = {
    "intern":    ["intern", "trainee", "apprentice", "stagiaire"],
    "junior":    ["junior", "associate", "jr", "graduate", "entry"],
    "mid":       ["engineer", "developer", "analyst", "consultant", "specialist", "designer"],
    "senior":    ["senior", "sr.", "lead", "principal", "staff", "expert"],
    "manager":   ["manager", "head of", "responsable", "chef de"],
    "director":  ["director", "directeur", "vp", "vice president"],
    "executive": ["ceo", "cto", "coo", "cfo", "cso", "president", "founder", "co-founder", "pdg"],
}


def _infer_seniority(title: str) -> str:
    if not title:
        return "mid"
    t = title.lower()
    for level, keywords in SENIORITY_KEYWORDS.items():
        if any(k in t for k in keywords):
            return level
    return "mid"


def _seniority_distance(user_seniority: str, target_seniority: str, goal: str) -> float:
    """
    Returns a 0.0-1.0 factor: 1.0 = perfect match for goal, 0.0 = bad match.

    - job_search: target should be equal or 1-2 levels above (hiring managers)
    - clients:    target should be senior/executive (decision-makers)
    - investors:  target should be executive/founder
    - learning:   target should be 1-3 levels above user
    """
    try:
        u_idx = SENIORITY_ORDER.index(user_seniority)
    except ValueError:
        u_idx = SENIORITY_ORDER.index("mid")

    try:
        t_idx = SENIORITY_ORDER.index(target_seniority)
    except ValueError:
        t_idx = SENIORITY_ORDER.index("mid")

    diff = t_idx - u_idx  # positive = target is more senior

    if goal == "job_search":
        # Best: target is 1-3 levels above (hiring manager range)
        if 1 <= diff <= 3:
            return 1.0
        elif diff == 0:
            return 0.7
        elif diff == 4:
            return 0.5
        else:
            return 0.2

    elif goal == "clients":
        # Best: target is senior or executive
        if t_idx >= SENIORITY_ORDER.index("manager"):
            return 1.0
        elif t_idx >= SENIORITY_ORDER.index("senior"):
            return 0.7
        else:
            return 0.3

    elif goal == "investors":
        # Best: target is executive/founder
        if t_idx >= SENIORITY_ORDER.index("director"):
            return 1.0
        elif t_idx >= SENIORITY_ORDER.index("senior"):
            return 0.5
        else:
            return 0.2

    elif goal == "learning":
        # Best: target is 1-4 levels above user (mentor range)
        if 1 <= diff <= 4:
            return 1.0
        elif diff == 0:
            return 0.5
        else:
            return 0.2

    # Default: closer seniority = better
    return max(0.0, 1.0 - abs(diff) * 0.2)


# Broad industry clusters — used to infer industry from job title text
_INDUSTRY_CLUSTERS: dict[str, list[str]] = {
    "technology":  ["software", "engineer", "developer", "data", "digital", "ai", "ml",
                    "cloud", "devops", "backend", "frontend", "fullstack", "product", "it ",
                    "cyber", "architect", "infrastructure", "sre", "platform"],
    "finance":     ["finance", "financial", "bank", "investment", "fintech", "accounting",
                    "audit", "tax", "trading", "risk", "actuar"],
    "consulting":  ["consultant", "consulting", "advisory", "strategy", "transformation",
                    "management consultant", "mckinsey", "deloitte", "accenture"],
    "healthcare":  ["health", "medical", "pharma", "biotech", "clinical", "doctor",
                    "nurse", "hospital", "medtech"],
    "sales":       ["sales", "business development", "account executive", "commercial",
                    "bdr", "sdr", "revenue"],
    "marketing":   ["marketing", "brand", "content", "seo", "growth", "social media",
                    "communication", "pr "],
    "hr":          ["hr ", "human resources", "recruiter", "talent", "people ops"],
    "education":   ["teacher", "professor", "education", "training", "coach", "instructor"],
    "legal":       ["lawyer", "attorney", "legal", "counsel", "paralegal", "compliance"],
    "design":      ["designer", "ux", "ui ", "product design", "creative", "graphic"],
}


def _infer_industry_from_title(title: str) -> str:
    """Return a broad industry label inferred from job title, or '' if unknown."""
    if not title:
        return ""
    t = title.lower()
    for industry, keywords in _INDUSTRY_CLUSTERS.items():
        if any(k in t for k in keywords):
            return industry
    return ""


def _industry_score(user_industry: str, target_industry: str,
                    user_skills: list, target_skills: list,
                    target_title: str = "",
                    user_title: str = "") -> float:
    """0.0-1.0: how closely industries/skills align.

    Designed to produce variance even when explicit industry fields are missing —
    the most common case for cards scraped from /mynetwork.
    """
    # Title-based cluster inference for BOTH sides
    target_cluster = (target_industry or "").lower().strip() or _infer_industry_from_title(target_title)
    user_cluster = (user_industry or "").lower().strip() or _infer_industry_from_title(user_title)

    # Skill overlap signal — this gives variance when industry is unknown
    skill_overlap = 0
    if user_skills and target_skills:
        us = {str(s).lower().strip() for s in user_skills if s}
        ts = {str(s).lower().strip() for s in target_skills if s}
        skill_overlap = len(us & ts)

    # Both clusters known
    if user_cluster and target_cluster:
        if user_cluster == target_cluster:
            # Exact cluster match: 0.85-1.0, boosted by skill overlap
            return min(1.0, 0.85 + skill_overlap * 0.03)
        ui_words = set(user_cluster.replace("/", " ").replace(",", " ").split())
        ti_words = set(target_cluster.replace("/", " ").replace(",", " ").split())
        if ui_words & ti_words:
            return 0.65 + min(0.2, skill_overlap * 0.04)  # adjacent clusters
        # Cross-cluster but skill overlap rescues it
        if skill_overlap >= 3:
            return 0.55
        if skill_overlap >= 1:
            return 0.35
        return 0.15  # genuinely unrelated

    # One or both clusters unknown — fall back to skill overlap
    if skill_overlap >= 5:
        return 0.75
    if skill_overlap >= 3:
        return 0.60
    if skill_overlap >= 1:
        return 0.40
    # No skills overlap and no industry signal → variance from title richness
    if target_title:
        # Domain-keyword-rich title gives some signal (>=1 domain keyword)
        if _infer_industry_from_title(target_title):
            return 0.30  # we know roughly what they do, but no match signal
    return 0.15  # no signal at all — don't inflate to 0.4 default


def _industry_alignment_score_semantic(user_text: str, target_text: str) -> float:
    """
    Semantic industry alignment using multilingual sentence embeddings.

    Takes the *combined* text for each side (industry + title concatenated)
    and returns a 0.0-1.0 score via a piecewise mapping calibrated for
    paraphrase-multilingual-MiniLM-L12-v2 on professional text.

    Piecewise thresholds (cos-sim → score):
        >= 0.75  →  1.0                 (strong match, same field)
        0.48-0.75 → linear 0.6-1.0     (moderate match, related field / cross-language)
        0.30-0.48 → linear 0.3-0.6     (weak match, distant relation)
        < 0.30   →  scales to 0.0-0.3  (no meaningful match)

    Threshold calibration (MiniLM on B1):
    The spec's 0.55 lower bound was tuned for the larger mpnet model.  On the
    B1-friendly MiniLM model, cross-language pairs (e.g. "Ingénieur Logiciel"
    vs "Software Engineer") score ~0.52, which would wrongly fall in the "weak
    match" band at 0.55.  We therefore use a 0.48 lower bound so those pairs
    still land in the "related field" band.  If you later move to a B2+ plan and
    swap in mpnet (it scores >=0.70 on the same pairs), this 0.48 bound remains
    safe — mpnet pairs simply sit comfortably inside the 0.48-0.75 band.

    Falls back silently to the keyword scorer (_industry_score) if the
    embedding model is unavailable (not installed, load error, etc.).
    """
    raw = embedding_service.similarity(user_text, target_text)

    if raw is None:
        # Model not available — caller should fall back to keyword scorer
        return -1.0

    if raw >= 0.75:
        return 1.0
    elif raw >= 0.48:
        # Linear interpolation: 0.48 → 0.6,  0.75 → 1.0
        return 0.6 + (raw - 0.48) / (0.75 - 0.48) * (1.0 - 0.6)
    elif raw >= 0.30:
        # Linear interpolation: 0.30 → 0.3,  0.48 → 0.6
        return 0.3 + (raw - 0.30) / (0.48 - 0.30) * (0.6 - 0.3)
    else:
        # Below 0.30 — scale linearly from 0 to 0.3
        return (raw / 0.30) * 0.3


def _mutual_score(mutual_count: int) -> float:
    """0.0-1.0: more mutual connections = higher trust signal.
    Rescaled to realistic LinkedIn card display (1-15 typical range).
    50+ is a near-perfect warm intro signal."""
    if mutual_count >= 15:
        return 1.0
    elif mutual_count >= 8:
        return 0.85
    elif mutual_count >= 4:
        return 0.65
    elif mutual_count >= 2:
        return 0.45
    elif mutual_count == 1:
        return 0.25
    else:
        return 0.0


def _engagement_score(post_frequency: str, avg_engagement_rate: float,
                      profile_richness: float = 0.0) -> float:
    """0.0-1.0: active, engaged profiles score higher.

    Key fix: when engagement data is missing (the common case on scraped cards),
    fall back to PROFILE RICHNESS as a proxy signal. A profile with a full headline,
    about, and experience is likely active; a ghost profile almost certainly isn't.
    This stops every candidate collapsing to the same 0.5 neutral value.
    """
    freq = (post_frequency or "unknown").lower()
    freq_map = {
        "daily":   1.0,
        "weekly":  0.8,
        "monthly": 0.55,
        "rarely":  0.2,
    }

    rate = avg_engagement_rate or 0.0

    # Case 1: real engagement data available
    if freq in freq_map or rate > 0.0:
        freq_score = freq_map.get(freq, 0.5)
        if rate >= 3.0: eng_score = 1.0
        elif rate >= 1.0: eng_score = 0.7
        elif rate >= 0.3: eng_score = 0.4
        elif rate > 0: eng_score = 0.25
        else: eng_score = 0.5
        return (freq_score + eng_score) / 2

    # Case 2: unknown — use profile richness as a differentiator.
    # Richness 0.0 → 0.30, 1.0 → 0.65. Keeps ghost profiles below rich ones
    # without unfairly penalising the rich-profile-but-quiet-poster case.
    return 0.30 + 0.35 * max(0.0, min(1.0, profile_richness))


def _company_relevance_score(
    user_goal: str,
    user_industry: str,
    target_company: str,
    target_industry: str,
    target_title: str,
) -> float:
    """0.0-1.0: how relevant the target's company is to the user's goal.

    Engineered to produce variance instead of collapsing to 0.3/0.5 defaults.
    """
    ti = (target_industry or "").lower()
    tc = (target_company or "").lower()
    tt = (target_title or "").lower()

    # Goal-specific keyword matches override generic scoring
    if user_goal == "investors":
        investor_keywords = ["capital", "venture", "vc", "fund", "invest", "angel", "seed", "partner"]
        startup_keywords = ["startup", "ceo", "founder", "cto"]
        if any(k in ti or k in tc or k in tt for k in investor_keywords):
            return 1.0
        if any(k in tt for k in startup_keywords):
            return 0.55
        return 0.15  # not an investor signal — don't inflate

    if user_goal == "clients":
        enterprise_keywords = ["enterprise", "corporation", "group", "holdings", "international"]
        decision_keywords = ["director", "vp", "head of", "chief", "cto", "ceo", "coo", "cfo", "founder", "manager"]
        score = 0.35  # base for any company
        if tc: score += 0.10
        if any(k in tc for k in enterprise_keywords): score += 0.25
        if any(k in tt for k in decision_keywords): score += 0.20
        return min(1.0, score)

    # job_search / learning — uses industry cluster match
    ui = (user_industry or "").lower()
    ti_eff = ti or _infer_industry_from_title(target_title)

    # Without any signal at all
    if not ui and not ti_eff:
        return 0.20 if not tc else 0.30

    if ui and ti_eff:
        if ui == ti_eff or ui in ti_eff or ti_eff in ui:
            return 1.0 if tc else 0.85  # named company boosts over generic cluster
        ui_words = set(ui.replace("/", " ").split())
        ti_words = set(ti_eff.replace("/", " ").split())
        if ui_words & ti_words:
            return 0.65
        return 0.25  # different industries — honest penalty

    # Only one side has industry data
    if ti_eff and not ui:
        return 0.40  # we know target's space but not user's — neutral
    return 0.30


# ─────────────────────────────────────────────────────────
#  MAIN SCORING FUNCTIONS
# ─────────────────────────────────────────────────────────

def score_profile(
    user_profile: dict,
    target_profile: dict,
    goal: Optional[str] = None,
) -> dict:
    """
    Score a single candidate profile against the user's profile.

    Returns:
        {
            "total": int (0-100),
            "breakdown": {
                "industry_alignment": float,
                "mutual_connections": float,
                "engagement_rate":    float,
                "company_relevance":  float,
                "seniority_match":    float,
            }
        }
    """
    goal = (goal or user_profile.get("goal") or "default").lower()
    weights = WEIGHTS.get(goal, WEIGHTS["default"])

    target_title = target_profile.get("title", "") or target_profile.get("currentRole", "")

    # Profile richness (0.0-1.0) — drives the engagement fallback
    richness = 0.0
    if (target_profile.get("about") or "").strip(): richness += 0.3
    exp_list = target_profile.get("experience") or []
    if len(exp_list) >= 1: richness += 0.2
    if len(exp_list) >= 3: richness += 0.1
    skills_list = target_profile.get("skills") or []
    if len(skills_list) >= 5: richness += 0.2
    if len(skills_list) >= 15: richness += 0.1
    if target_title: richness += 0.1
    richness = min(1.0, richness)

    # --- Factor 1: Industry Alignment ---
    #
    # Keyword path (legacy): cluster-keyword dictionary, English-only.
    # Semantic path (new):   multilingual embeddings, activated by USE_SEMANTIC_INDUSTRY=true.
    #
    # During the roll-out week both scores are computed and logged side-by-side
    # in the breakdown so you can compare them against real click behaviour
    # before committing to the semantic path.

    user_industry_text = " ".join(filter(None, [
        user_profile.get("industry", ""),
        user_profile.get("job_title", "") or user_profile.get("headline", ""),
    ])).strip()
    target_industry_text = " ".join(filter(None, [
        target_profile.get("industry", ""),
        target_title,
    ])).strip()

    # Always compute the keyword score (used as fallback and for logging)
    f_industry_keyword = _industry_score(
        user_profile.get("industry", ""),
        target_profile.get("industry", ""),
        user_profile.get("skills", []),
        target_profile.get("skills", []),
        target_title=target_title,
        user_title=user_profile.get("job_title", "") or user_profile.get("headline", ""),
    )

    if USE_SEMANTIC_INDUSTRY:
        f_industry_semantic = _industry_alignment_score_semantic(
            user_industry_text, target_industry_text
        )
        # Fall back to keyword scorer if embedding model is unavailable
        f_industry = f_industry_semantic if f_industry_semantic >= 0 else f_industry_keyword
    else:
        f_industry = f_industry_keyword
        f_industry_semantic = _industry_alignment_score_semantic(
            user_industry_text, target_industry_text
        )  # computed only for logging — not used in score

    # --- Factor 2: Mutual Connections ---
    f_mutual = _mutual_score(
        target_profile.get("mutual_connections_count", 0)
    )

    # --- Factor 3: Engagement Rate ---
    f_engagement = _engagement_score(
        target_profile.get("post_frequency", "unknown"),
        float(target_profile.get("avg_engagement_rate", 0) or 0),
        profile_richness=richness,
    )

    # --- Factor 4: Company Relevance ---
    f_company = _company_relevance_score(
        goal,
        user_profile.get("industry", ""),
        target_profile.get("company", ""),
        target_profile.get("industry", ""),
        target_title,
    )

    # --- Factor 5: Seniority Match ---
    user_seniority = (user_profile.get("seniority") or
                      _infer_seniority(user_profile.get("job_title", "")))
    target_seniority = _infer_seniority(target_title)
    f_seniority = _seniority_distance(user_seniority, target_seniority, goal)

    breakdown = {
        "industry_alignment": round(f_industry, 3),
        # Parallel logging — compare keyword vs semantic during roll-out week.
        # Remove these two debug fields once USE_SEMANTIC_INDUSTRY is stable.
        "_industry_keyword":  round(f_industry_keyword, 3),
        "_industry_semantic": round(f_industry_semantic, 3) if f_industry_semantic >= 0 else None,
        "mutual_connections": round(f_mutual, 3),
        "engagement_rate":    round(f_engagement, 3),
        "company_relevance":  round(f_company, 3),
        "seniority_match":    round(f_seniority, 3),
    }

    raw_score = (
        f_industry  * weights["industry_alignment"] +
        f_mutual    * weights["mutual_connections"] +
        f_engagement * weights["engagement_rate"] +
        f_company   * weights["company_relevance"] +
        f_seniority * weights["seniority_match"]
    )

    total = min(100, max(0, round(raw_score * 100)))

    return {"total": total, "breakdown": breakdown}


def batch_score(
    user_profile: dict,
    candidates: list[dict],
    goal: Optional[str] = None,
    threshold: int = 0,
) -> list[dict]:
    """
    Score a list of candidate profiles and return them sorted by score DESC.
    Candidates below threshold are excluded.

    Each returned item has the original candidate fields plus:
        "_score": { "total": int, "breakdown": {...} }
    """
    results = []
    for candidate in candidates:
        score = score_profile(user_profile, candidate, goal)
        if score["total"] >= threshold:
            results.append({**candidate, "_score": score})

    results.sort(key=lambda x: x["_score"]["total"], reverse=True)
    return results
