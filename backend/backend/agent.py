"""
agent.py - LangGraph workflow for Subul IN.

This module builds a LangGraph graph that runs the LinkedIn profile analysis
pipeline. It is wired into main.py through the /agent/full-analysis route.

Workflow order:
    extract_profile  ->  compute_ai_score  ->  (smart router)
    low score  ->  deep_diagnostic  ->  generate_recommendations
    has target ->  run_gap_analysis  ->  generate_recommendations
    otherwise  ->  generate_recommendations directly
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Literal, Optional

import httpx
from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict


# Reuse a single HTTP client across all Azure calls instead of creating one per request

_azure_client = httpx.AsyncClient(
    timeout=httpx.Timeout(180.0, connect=15.0),
    limits=httpx.Limits(max_keepalive_connections=10, max_connections=20, keepalive_expiry=30),
    http2=False,
)


# Minimal Azure OpenAI helper used by the agent nodes

AZURE_ENDPOINT    = os.getenv("AZURE_ENDPOINT", "").rstrip("/")
AZURE_API_KEY     = os.getenv("AZURE_API_KEY", "")
AZURE_API_VERSION = os.getenv("AZURE_API_VERSION", "2024-12-01-preview")
DEPLOYMENT        = os.getenv("POST_DEPLOYMENT", "gpt-4o-mini-2024-07-18-postagent")


async def _call_azure(system: str, user: str, temperature: float = 0.4,
                      max_tokens: int = 1200) -> str:
    """Call the Azure OpenAI API and return the raw text, or raise RuntimeError on failure."""
    if not AZURE_ENDPOINT or not AZURE_API_KEY:
        raise RuntimeError("Azure credentials manquants dans .env")

    url = (
        f"{AZURE_ENDPOINT}/openai/deployments/{DEPLOYMENT}"
        f"/chat/completions?api-version={AZURE_API_VERSION}"
    )
    payload = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    resp = await _azure_client.post(
        url,
        headers={"Content-Type": "application/json", "api-key": AZURE_API_KEY},
        json=payload,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Azure error {resp.status_code}: {resp.text[:200]}")
    body = resp.json()
    return body["choices"][0]["message"]["content"].strip()


# Shared state passed between all graph nodes

class AgentState(TypedDict, total=False):
    # Input fields
    user_profile:   dict          # scraped LinkedIn profile of the user
    target_profile: Optional[dict]  # target profile to compare against (can be None)
    goal:           str           # job_search | clients | investors | learning
    user_doc_id:    Optional[str] # Cosmos DB document ID for the user
    ui_lang:        str           # EN | FR

    # Intermediate results built up by each node
    normalized_profile: dict      # cleaned profile from extract_profile
    ai_score_result:    dict      # output of compute_ai_score
    gap_result:         Optional[dict]  # output of run_gap_analysis (None if no target)

    # Final output
    recommendations: dict         # summary with prioritised actions
    errors:          list[str]    # non-fatal errors collected during the run


# Node 1: extract_profile
# Cleans and validates the user profile fields before scoring

def _node_extract_profile(state: AgentState) -> AgentState:
    """Clean and normalize the user profile. No LLM call here, just data processing."""
    profile = state.get("user_profile") or {}
    errors  = list(state.get("errors") or [])

    # Normalize the main profile fields
    normalized = {
        "name":       profile.get("name") or profile.get("fullName") or "",
        "headline":   profile.get("headline") or profile.get("currentRole") or "",
        "about":      (profile.get("about") or "")[:2000],
        "experience": [
            e for e in (profile.get("experience") or [])
            if isinstance(e, dict) and (e.get("title") or e.get("company"))
        ][:10],
        "skills":     [
            str(s) for s in (profile.get("skills") or []) if str(s).strip()
        ][:50],
        "education":  [
            e for e in (profile.get("education") or [])
            if isinstance(e, dict) and (e.get("school") or e.get("degree"))
        ][:5],
        "location":   profile.get("location") or "",
        "industry":   profile.get("industry") or "",
        # Network metrics
        "connections": _safe_int(
            profile.get("connectionsCount") or profile.get("connections_count") or
            profile.get("connections")
        ),
        "followers": _safe_int(
            profile.get("followersCount") or profile.get("followers_count") or
            profile.get("followers")
        ),
        # Content activity
        "last_post_days":  profile.get("last_post_days"),
        "post_count_30d":  profile.get("post_count_30d") or 0,
        # Certifications from Subul enrichment
        "_subul_certs": profile.get("_subul_certs", ""),
    }

    # Warn if the profile has too little content to score reliably
    has_content = bool(normalized["headline"] or normalized["about"] or normalized["experience"])
    if not has_content:
        errors.append("Profil utilisateur trop vide — résultats moins précis.")

    return {**state, "normalized_profile": normalized, "errors": errors}


def _safe_int(val) -> int:
    try:
        return int(val) if val not in (None, "", "?") else 0
    except (ValueError, TypeError):
        return 0


# Node 2: compute_ai_score
# Scores the normalized profile using Azure OpenAI

def _score_system(lang: str = "EN") -> str:
    if lang.upper() == "FR":
        return """Tu es un expert LinkedIn. Analyse ce profil et retourne UNIQUEMENT du JSON valide.
Format attendu :
{
  "overall_score": <int 0-100>,
  "grade": "<F|D|C|B|A|A+>",
  "summary": "<1 phrase spécifique au profil>",
  "sections": {
    "headline":   {"score": <int>, "tip": "<conseil concis>"},
    "about":      {"score": <int>, "tip": "<conseil concis>"},
    "experience": {"score": <int>, "tip": "<conseil concis>"},
    "skills":     {"score": <int>, "tip": "<conseil concis>"},
    "education":  {"score": <int>, "tip": "<conseil concis>"}
  },
  "top_priority": "<L'amélioration N°1 à faire maintenant>"
}

RÈGLES DE SCORING STRICTES ET DÉTERMINISTES — applique-les à la lettre :
Headline  : vide ou générique (Student/Étudiant) = 5. Court sans rôle clair = 15. Rôle + domaine = 40. Rôle + domaine + valeur = 70. Optimisé avec mots-clés = 90.
About     : VIDE ou "" = 0 (OBLIGATOIRE). < 100 chars = 15. 100-300 chars = 35. 300-600 chars = 60. 600-1200 chars avec mots-clés = 85.
Experience: 0 entrée = 0. 1 entrée sans description = 10. 1 entrée avec description = 30. 2-3 entrées = 55. 4+ avec descriptions = 80.
Skills    : 0 skill = 0 (OBLIGATOIRE). 1-4 = 20. 5-9 = 45. 10-19 = 65. 20+ avec pertinence = 85.
Education : 0 entrée = 0. 1 entrée sans détails = 20. 1 entrée avec détails = 45. 2+ entrées = 65.
Overall   : moyenne pondérée (headline×20% + about×25% + experience×30% + skills×15% + education×10%).
Grade     : 0-29=F, 30-44=D, 45-59=C, 60-74=B, 75-89=A, 90-100=A+.
CRITIQUE : same input → ALWAYS same output. Ne varie JAMAIS pour le même profil."""
    return """You are a LinkedIn expert. Analyse this profile and return ONLY valid JSON.
Expected format:
{
  "overall_score": <int 0-100>,
  "grade": "<F|D|C|B|A|A+>",
  "summary": "<1 profile-specific sentence>",
  "sections": {
    "headline":   {"score": <int>, "tip": "<concise tip>"},
    "about":      {"score": <int>, "tip": "<concise tip>"},
    "experience": {"score": <int>, "tip": "<concise tip>"},
    "skills":     {"score": <int>, "tip": "<concise tip>"},
    "education":  {"score": <int>, "tip": "<concise tip>"}
  },
  "top_priority": "<The #1 improvement to make right now>"
}

STRICT DETERMINISTIC SCORING RULES — apply them exactly:
Headline  : empty or generic (Student) = 5. Short without clear role = 15. Role + field = 40. Role + field + value = 70. Keyword-optimised = 90.
About     : EMPTY or "" = 0 (MANDATORY). < 100 chars = 15. 100-300 chars = 35. 300-600 chars = 60. 600-1200 chars with keywords = 85.
Experience: 0 entries = 0. 1 entry without description = 10. 1 entry with description = 30. 2-3 entries = 55. 4+ with descriptions = 80.
Skills    : 0 skills = 0 (MANDATORY). 1-4 = 20. 5-9 = 45. 10-19 = 65. 20+ with relevance = 85.
Education : 0 entries = 0. 1 entry without details = 20. 1 entry with details = 45. 2+ entries = 65.
Overall   : weighted average (headline×20% + about×25% + experience×30% + skills×15% + education×10%).
Grade     : 0-29=F, 30-44=D, 45-59=C, 60-74=B, 75-89=A, 90-100=A+.
CRITICAL: same input → ALWAYS same output. NEVER vary for the same profile."""

async def _node_compute_ai_score(state: AgentState) -> AgentState:
    """Score the normalized profile and return the result."""
    profile = state.get("normalized_profile") or state.get("user_profile") or {}
    if not isinstance(profile, dict):
        profile = {}
    errors  = list(state.get("errors") or [])

    exp_lines = "\n".join(
        f"  - {e.get('title','')} chez {e.get('company','')} ({e.get('dates','') or e.get('duration','')}) — {(e.get('description') or '')[:200]}"
        for e in (profile.get("experience") or [])[:5]
    ) or "  (aucune)"

    edu_lines = "\n".join(
        f"  - {e.get('degree','')} in {e.get('fieldOfStudy','')} at {e.get('school','')} ({e.get('dates','') or e.get('duration','')})"
        for e in (profile.get("education") or [])[:4]
    ) or "  (aucune)"

    user_prompt = (
        f"Objectif : {state.get('goal','job_search')}\n\n"
        f"NOM : {profile.get('name','')}\n"
        f"HEADLINE : {profile.get('headline','(vide)')}\n"
        f"ABOUT : {(profile.get('about') or profile.get('summary') or '(vide)')[:800]}\n"
        f"ABOUT_LENGTH : {len(profile.get('about') or profile.get('summary') or '')} chars\n"
        f"EXPÉRIENCES :\n{exp_lines}\n"
        f"FORMATION :\n{edu_lines}\n"
        f"COMPÉTENCES ({len(profile.get('skills',[]))}): {', '.join(profile.get('skills',[])[:15]) or '(aucune)'}\n"
        f"CONNEXIONS : {profile.get('connections', 0)} | FOLLOWERS : {profile.get('followers', 0)}\n"
    )

    async def _attempt_score(temperature: float) -> dict:
        """Run one scoring attempt. Raises on failure so the caller can retry."""
        raw = await _call_azure(_score_system(state.get("ui_lang", "EN")), user_prompt,
                                 temperature=temperature, max_tokens=700)
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as je:
            # Azure sometimes returns malformed JSON (e.g. a repeated token loop cut off by max_tokens).
            # Log the raw output and let the caller retry.
            logging.error(
                f"[agent] compute_ai_score JSON parse failed (temp={temperature}): {je}\n"
                f"Raw LLM output was: {raw[:500]}"
            )
            raise
        if not isinstance(parsed, dict):
            raise ValueError(f"LLM returned non-dict: {type(parsed)} = {parsed}")
        return parsed

    try:
        try:
            score_result = await _attempt_score(temperature=0.0)
        except json.JSONDecodeError:
            # Retry with a small temperature change so we don't get the same bad output again.
            errors.append("ai_score warning: first attempt returned malformed JSON, retried")
            score_result = await _attempt_score(temperature=0.3)

        # Normalize section format - the LLM sometimes returns a plain number instead of {score, tip}
        score_result["sections"] = score_result.get("sections") or {}
        if not isinstance(score_result["sections"], dict):
            score_result["sections"] = {}
        for k, v in list(score_result["sections"].items()):
            if not isinstance(v, dict):
                score_result["sections"][k] = {"score": int(v) if isinstance(v, (int, float)) else 0, "tip": ""}
        # Calculate the overall score using fixed weights rather than trusting the LLM's math
        # Weights: headline 20%, about 25%, experience 30%, skills 15%, education 10%
        sections = score_result["sections"]
        weights = {"headline": 0.20, "about": 0.25, "experience": 0.30, "skills": 0.15, "education": 0.10}
        weighted = sum(
            (sections.get(k, {}) if isinstance(sections.get(k), dict) else {}).get("score", 0) * w
            for k, w in weights.items()
        )
        overall = max(0, min(100, round(weighted)))
        score_result["overall_score"] = overall
        # Recalculate the grade from the actual computed score
        score_result["grade"] = (
            "A+" if overall >= 90 else "A"  if overall >= 75 else
            "B"  if overall >= 60 else "C"  if overall >= 45 else
            "D"  if overall >= 30 else "F"
        )
    except Exception as e:
        # Log the full exception so errors are visible in the server logs.
        import traceback
        logging.error(
            f"[agent] compute_ai_score failed after retry: {type(e).__name__}: {e}\n"
            f"{traceback.format_exc()}"
        )
        errors.append(f"ai_score error: {type(e).__name__}: {e}")
        _lang = state.get("ui_lang", "EN").upper()
        score_result = {
            "overall_score": 0,
            "grade": "N/A",
            "summary": "Erreur lors du calcul du score." if _lang == "FR" else "Error computing score.",
            "sections": {},
            "top_priority": "Remplir le profil avant de relancer l'analyse." if _lang == "FR" else "Complete your profile and try again.",
        }

    return {**state, "ai_score_result": score_result, "errors": errors}


# Node 3: run_gap_analysis
# Compares the user profile against the target. Skipped if no target is provided.

def _gap_system(lang: str = "EN") -> str:
    if lang.upper() == "FR":
        return """Tu es un stratège LinkedIn senior. Compare les deux profils et retourne UNIQUEMENT du JSON valide.
Format attendu :
{
  "overall_gap_score": <int 0-100 — score du profil UTILISATEUR>,
  "score_label": "<Far Behind|Behind|Closing In|On Par|Ahead|Dominating>",
  "verdict": "<2-3 phrases spécifiques aux vrais profils>",
  "key_insight": "<La chose la plus importante à changer — ultra-spécifique>",
  "skill_gaps": ["<skill manquant 1>", "<skill manquant 2>", "<skill manquant 3>"],
  "user_advantages": ["<avantage utilisateur 1>"],
  "quick_wins": [
    {"action": "<action concrète>", "impact": "high|medium|low", "difficulty": "easy|medium|hard"},
    {"action": "<action concrète>", "impact": "high|medium|low", "difficulty": "easy|medium|hard"},
    {"action": "<action concrète>", "impact": "high|medium|low", "difficulty": "easy|medium|hard"}
  ],
  "connection_message": "<Note de connexion ≤290 chars, avec le prénom de la cible>"
}
RÈGLE ABSOLUE : ne jamais inventer de faits absents des données fournies."""
    return """You are a senior LinkedIn strategist. Compare the two profiles and return ONLY valid JSON.
Expected format:
{
  "overall_gap_score": <int 0-100 — USER profile score>,
  "score_label": "<Far Behind|Behind|Closing In|On Par|Ahead|Dominating>",
  "verdict": "<2-3 sentences specific to the actual profiles>",
  "key_insight": "<The single most important thing to change — ultra-specific>",
  "skill_gaps": ["<missing skill 1>", "<missing skill 2>", "<missing skill 3>"],
  "user_advantages": ["<user advantage 1>"],
  "quick_wins": [
    {"action": "<concrete action>", "impact": "high|medium|low", "difficulty": "easy|medium|hard"},
    {"action": "<concrete action>", "impact": "high|medium|low", "difficulty": "easy|medium|hard"},
    {"action": "<concrete action>", "impact": "high|medium|low", "difficulty": "easy|medium|hard"}
  ],
  "connection_message": "<Connection note ≤290 chars, using the target's first name>"
}
ABSOLUTE RULE: never invent facts not present in the provided data."""

async def _node_run_gap_analysis(state: AgentState) -> AgentState:
    """Run the gap analysis if a target profile was provided."""
    target = state.get("target_profile")
    errors = list(state.get("errors") or [])

    if not target:
        # No target provided, skip this node
        return {**state, "gap_result": None}

    user = state.get("normalized_profile") or state.get("user_profile") or {}

    def _fmt(profile: dict, label: str) -> str:
        exp = "\n".join(
            f"  - {e.get('title','')} chez {e.get('company','')}"
            for e in (profile.get("experience") or [])[:4]
        ) or "  (aucune)"
        return (
            f"## {label}\n"
            f"Headline : {profile.get('headline') or profile.get('title','(vide)')}\n"
            f"About : {(profile.get('about') or '(vide)')[:600]}\n"
            f"Expériences :\n{exp}\n"
            f"Skills : {', '.join((profile.get('skills') or [])[:20]) or '(aucune)'}\n"
        )

    user_prompt = (
        f"Objectif : {state.get('goal','job_search')}\n\n"
        + _fmt(user, "UTILISATEUR")
        + "\n"
        + _fmt(target, "CIBLE")
    )

    try:
        raw = await _call_azure(_gap_system(state.get("ui_lang", "EN")), user_prompt, temperature=0.4, max_tokens=900)
        gap_result = json.loads(raw)
        gap_result["overall_gap_score"] = max(0, min(100, int(gap_result.get("overall_gap_score", 50))))
    except Exception as e:
        errors.append(f"gap_analysis error: {e}")
        _lang = state.get("ui_lang", "EN").upper()
        gap_result = {
            "overall_gap_score": 0,
            "score_label": "N/A",
            "verdict": "Analyse indisponible." if _lang == "FR" else "Analysis unavailable.",
            "key_insight": "",
            "skill_gaps": [],
            "user_advantages": [],
            "quick_wins": [],
            "connection_message": "",
        }

    return {**state, "gap_result": gap_result, "errors": errors}


# Node 4: generate_recommendations
# Builds the final action plan based on the score and gap results

def _reco_system(lang: str = "EN") -> str:
    if lang.upper() == "FR":
        return """Tu es un coach LinkedIn senior. À partir des résultats d'analyse fournis, génère un plan d'action priorisé.
Si une section "Progression" est fournie, MENTIONNE OBLIGATOIREMENT l'évolution du score dans executive_summary.
Retourne UNIQUEMENT du JSON valide :
{
  "executive_summary": "<3-4 phrases : où en est le profil, progression depuis la dernière analyse si disponible, ce qui bloque, ce qui est fort>",
  "priority_actions": [
    {
      "rank": 1,
      "action": "<action hyper-spécifique>",
      "why": "<impact concret>",
      "timeframe": "<15 min|1h|1 jour|1 semaine>",
      "expected_score_gain": "<+X points>"
    }
  ],
  "profile_strengths": ["<force 1>", "<force 2>"],
  "30_day_plan": "<Plan d'action en 30 jours en 4-5 étapes>",
  "motivational_insight": "<1 phrase motivante mais honnête>"
}
Génère 3 à 5 priority_actions maximum. Sois précis et actionnable."""
    return """You are a senior LinkedIn coach. From the analysis results provided, generate a prioritised action plan.
If a "Progress" section is provided, ALWAYS mention the score evolution in executive_summary.
Return ONLY valid JSON:
{
  "executive_summary": "<3-4 sentences: where the profile stands, progress since last analysis if available, what is blocking, what is strong>",
  "priority_actions": [
    {
      "rank": 1,
      "action": "<hyper-specific action>",
      "why": "<concrete impact>",
      "timeframe": "<15 min|1h|1 day|1 week>",
      "expected_score_gain": "<+X points>"
    }
  ],
  "profile_strengths": ["<strength 1>", "<strength 2>"],
  "30_day_plan": "<30-day action plan in 4-5 steps>",
  "motivational_insight": "<1 honest but motivating sentence>"
}
Generate 3 to 5 priority_actions maximum. Be precise and actionable."""

async def _node_generate_recommendations(state: AgentState) -> AgentState:
    """Generate the final recommendations from the score and gap analysis."""
    errors = list(state.get("errors") or [])
    score  = state.get("ai_score_result") or {}
    if not isinstance(score, dict): score = {}
    gap    = state.get("gap_result")
    if not isinstance(gap, dict): gap = None

    # Build the context block that gets sent to the LLM
    context = (
        f"## Score profil\n"
        f"Score global : {score.get('overall_score', 0)}/100 ({score.get('grade','?')})\n"
        f"Résumé : {score.get('summary','')}\n"
        f"Priorité N°1 : {score.get('top_priority','')}\n\n"
        f"## Sections\n"
    )
    for section, data in (score.get("sections") or {}).items():
        context += f"  {section}: {data.get('score', 0)}/100 — {data.get('tip','')}\n"

    if gap:
        context += (
            f"\n## Analyse de gap (vs cible)\n"
            f"Score utilisateur : {gap.get('overall_gap_score',0)}/100 ({gap.get('score_label','')})\n"
            f"Verdict : {gap.get('verdict','')}\n"
            f"Key insight : {gap.get('key_insight','')}\n"
            f"Skills manquants : {', '.join(gap.get('skill_gaps',[]))}\n"
        )

    try:
        raw = await _call_azure(_reco_system(state.get("ui_lang", "EN")), context, temperature=0.5, max_tokens=1500)
        import re as _re
        _clean = _re.sub(r"```json|```", "", raw).strip()
        _clean = _clean[_clean.find("{"):]
        recommendations = json.loads(_clean)
    except Exception as e:
        logging.error(f"[agent] recommendations JSON parse failed: {e}\nRaw output was: {raw[:500] if 'raw' in dir() else 'no response'}")
        errors.append(f"recommendations error: {e}")
        _lang = state.get("ui_lang", "EN").upper()
        recommendations = {
            "executive_summary": "Analyse partielle — certains résultats sont indisponibles." if _lang == "FR" else "Partial analysis — some results are unavailable.",
            "priority_actions": [],
            "profile_strengths": [],
            "30_day_plan": "",
            "motivational_insight": "",
        }

    return {**state, "recommendations": recommendations, "errors": errors}


# Node 2b: deep_diagnostic
# Only runs when the profile score is below 35.
# Identifies the main reasons the profile is weak before generating recommendations.

def _diag_system(lang: str = "EN") -> str:
    if lang.upper() == "FR":
        return """Tu es un expert LinkedIn. Ce profil a un score très bas (< 35/100).
Identifie les blocages fondamentaux et retourne UNIQUEMENT du JSON valide :
{
  "profile_stage": "blank|beginner|incomplete|misleading",
  "root_causes": ["<cause fondamentale 1>", "<cause fondamentale 2>"],
  "critical_missing": ["<élément critique manquant 1>", "<élément critique manquant 2>"],
  "profile_type_guess": "<étudiant|junior|career_changer|senior_inactive>",
  "first_3_actions": [
    {"action": "<action immédiate>", "time": "<15 min|30 min|1h>"},
    {"action": "<action immédiate>", "time": "<15 min|30 min|1h>"},
    {"action": "<action immédiate>", "time": "<15 min|30 min|1h>"}
  ],
  "honest_assessment": "<1-2 phrases franches sur l'état réel du profil>"
}"""
    return """You are a LinkedIn expert. This profile has a very low score (< 35/100).
Identify the fundamental blockers and return ONLY valid JSON:
{
  "profile_stage": "blank|beginner|incomplete|misleading",
  "root_causes": ["<root cause 1>", "<root cause 2>"],
  "critical_missing": ["<critical missing element 1>", "<critical missing element 2>"],
  "profile_type_guess": "<student|junior|career_changer|senior_inactive>",
  "first_3_actions": [
    {"action": "<immediate action>", "time": "<15 min|30 min|1h>"},
    {"action": "<immediate action>", "time": "<15 min|30 min|1h>"},
    {"action": "<immediate action>", "time": "<15 min|30 min|1h>"}
  ],
  "honest_assessment": "<1-2 frank sentences about the real state of the profile>"
}"""

async def _node_deep_diagnostic(state: AgentState) -> AgentState:
    """Run a deeper analysis when the score is very low (under 35). Injects the result into the state so recommendations can use it."""
    profile = state.get("normalized_profile") or state.get("user_profile") or {}
    if not isinstance(profile, dict): profile = {}
    errors  = list(state.get("errors") or [])
    score   = state.get("ai_score_result") or {}
    if not isinstance(score, dict): score = {}

    user_prompt = (
        f"Score actuel : {score.get('overall_score', 0)}/100\n"
        f"Objectif : {state.get('goal', 'job_search')}\n\n"
        f"NOM : {profile.get('name', '')}\n"
        f"HEADLINE : {profile.get('headline', '(vide)')}\n"
        f"ABOUT : {(profile.get('about') or '(vide)')[:600]}\n"
        f"EXPÉRIENCES : {len(profile.get('experience', []))} entrée(s)\n"
        f"COMPÉTENCES : {len(profile.get('skills', []))} skill(s)\n"
        f"ÉDUCATION : {len(profile.get('education', []))} entrée(s)\n"
        f"CONNEXIONS : {profile.get('connections', 0)}\n"
        f"Top issue identifiée : {score.get('top_priority', '')}\n"
    )

    try:
        raw = await _call_azure(_diag_system(state.get("ui_lang", "EN")), user_prompt, temperature=0.3, max_tokens=600)
        diagnostic = json.loads(raw)
    except Exception as e:
        errors.append(f"deep_diagnostic error: {e}")
        diagnostic = {
            "profile_stage": "incomplete",
            "root_causes": ["Profil insuffisamment rempli"],
            "critical_missing": ["Section À propos", "Compétences", "Expériences détaillées"],
            "profile_type_guess": "unknown",
            "first_3_actions": [],
            "honest_assessment": "Le profil nécessite un travail de fond avant toute optimisation.",
        }

    # Attach the diagnostic to the score result so generate_recommendations can reference it
    enriched_score = {**(state.get("ai_score_result") or {}), "deep_diagnostic": diagnostic}
    return {**state, "ai_score_result": enriched_score, "errors": errors}



# Router: decides which node to run after compute_ai_score
# score < 35 -> deep_diagnostic
# target provided -> run_gap_analysis
# otherwise -> generate_recommendations directly

def _smart_router(state: AgentState) -> Literal[
    "deep_diagnostic", "run_gap_analysis", "generate_recommendations"
]:
    """
    Route to the next node based on the profile score and whether a target was provided.

    score < 35              -> deep_diagnostic
    target provided         -> run_gap_analysis
    score >= 35, no target  -> generate_recommendations
    """
    _score_raw = state.get("ai_score_result") or {}
    if not isinstance(_score_raw, dict): _score_raw = {}
    score  = _score_raw.get("overall_score", 50)
    if not isinstance(score, int): score = 50
    target = state.get("target_profile")
    has_target = bool(
        target and isinstance(target, dict) and
        (target.get("headline") or target.get("name") or target.get("experience"))
    )

    # If the score is very low, run deep diagnostic first
    if score < 35:
        logging.info(f"[agent] Router → deep_diagnostic (score={score})")
        return "deep_diagnostic"

    # If a target profile was provided, run gap analysis
    if has_target:
        logging.info(f"[agent] Router → run_gap_analysis (score={score}, target=True)")
        return "run_gap_analysis"

    logging.info(f"[agent] Router → generate_recommendations (score={score})")
    return "generate_recommendations"


# Build the LangGraph state graph

def _build_graph() -> StateGraph:
    """Build and compile the LangGraph graph with all nodes and routing."""
    builder = StateGraph(AgentState)

    # Register nodes
    builder.add_node("extract_profile",          _node_extract_profile)
    builder.add_node("compute_ai_score",          _node_compute_ai_score)
    builder.add_node("deep_diagnostic",           _node_deep_diagnostic)
    builder.add_node("run_gap_analysis",          _node_run_gap_analysis)
    builder.add_node("generate_recommendations",  _node_generate_recommendations)

    # Fixed edges
    builder.add_edge(START,             "extract_profile")
    builder.add_edge("extract_profile", "compute_ai_score")

    # Conditional routing after compute_ai_score
    builder.add_conditional_edges(
        "compute_ai_score",
        _smart_router,
        {
            "deep_diagnostic":          "deep_diagnostic",
            "run_gap_analysis":         "run_gap_analysis",
            "generate_recommendations": "generate_recommendations",
        },
    )

    builder.add_edge("deep_diagnostic",          "generate_recommendations")
    builder.add_edge("run_gap_analysis",         "generate_recommendations")
    builder.add_edge("generate_recommendations", END)

    return builder.compile()


# Compiled graph instance (created once at import time)
_graph = _build_graph()


# Public entry point

async def run_full_analysis(
    user_profile:   dict,
    target_profile: Optional[dict] = None,
    goal:           str = "job_search",
    user_doc_id:    Optional[str] = None,
    ui_lang:        str = "EN",
    previous_score: Optional[dict] = None,   # chargé depuis Cosmos par main.py
) -> dict:
    """
    Run the full analysis workflow and return the results.

    Returns a dict with:
        - ai_score        : profile score from the LLM
        - gap_analysis    : gap vs target (None if no target was provided)
        - deep_diagnostic : detailed diagnosis (None if score >= 35)
        - recommendations : final action plan
        - errors          : non-fatal errors collected during the run
        - workflow_path   : list of nodes that were executed
    """
    initial_state: AgentState = {
        "user_profile":   user_profile,
        "target_profile": target_profile,
        "goal":           goal,
        "user_doc_id":    user_doc_id,
        "ui_lang":        ui_lang,
        "previous_score": previous_score,
        "errors":         [],
    }

    try:
        final_state = await _graph.ainvoke(initial_state)
    except Exception as e:
        import traceback
        logging.error(f"[agent] Graph execution failed: {e}\n{traceback.format_exc()}")
        raise RuntimeError(f"Workflow agentique échoué : {e}") from e

    score_result = final_state.get("ai_score_result", {})
    prev         = initial_state.get("previous_score") or {}  # read from input, not final state
    return {
        "ai_score":         score_result,
        "gap_analysis":     final_state.get("gap_result"),
        "deep_diagnostic":  score_result.get("deep_diagnostic"),
        "recommendations":  final_state.get("recommendations", {}),
        "progress": {
            "previous_score": prev.get("overall_score"),
            "previous_date":  prev.get("date"),
            "current_score":  score_result.get("overall_score", 0),
            "delta":          score_result.get("overall_score", 0) - prev.get("overall_score", 0) if prev.get("overall_score") is not None else None,
        },
        "errors":           final_state.get("errors", []),
        "workflow_path":    _get_workflow_path(final_state),
    }


def _get_workflow_path(state: AgentState) -> list[str]:
    """Return the list of nodes that were actually executed in this run."""
    path = ["extract_profile", "compute_ai_score"]
    _sr = state.get("ai_score_result") or {}
    score = (_sr.get("overall_score", 50) if isinstance(_sr, dict) else 50)
    if score < 35 and state.get("ai_score_result", {}).get("deep_diagnostic"):
        path.append("deep_diagnostic")
    elif state.get("gap_result") is not None:
        path.append("run_gap_analysis")
    path.append("generate_recommendations")
    return path


# Integration snippet for main.py
#
#  from agent import run_full_analysis
#
#  class FullAnalysisRequest(BaseModel):
#      user_profile:   dict
#      target_profile: Optional[dict] = None
#      goal:           Optional[str]  = "job_search"
#      ui_lang:        Optional[str]  = "EN"
#
#  @app.post("/agent/full-analysis")
#  async def agent_full_analysis(
#      data: FullAnalysisRequest,
#      user_doc_id: Optional[str] = Depends(get_current_user_optional),
#  ):
#      if not user_doc_id:
#          raise HTTPException(status_code=401, detail="Authentication required")
#      result = await run_full_analysis(
#          user_profile=data.user_profile,
#          target_profile=data.target_profile,
#          goal=data.goal or "job_search",
#          user_doc_id=user_doc_id,
#          ui_lang=data.ui_lang or "EN",
#      )
#      await _log(user_doc_id, "agent_full_analysis", DEPLOYMENT, 0, 0, 0, True, None)
#      return {"success": True, "data": result}
#
# ─────────────────────────────────────────────────────────────
