"""
cosmos_db.py - Azure Cosmos DB client for Subul IN.

Database: EduTech_AI_Production / AgentLinkedin
Partition key: /id

Document types stored:
  user                       - user accounts and profiles
  usage_log                  - API call logs
  profile_snapshot           - saved LinkedIn profiles
  cache                      - short-lived cached data (auto-deleted by Cosmos TTL)
  networking_goal            - user networking preferences
  connection_interaction     - feedback on suggested connections
  linkedin_profile_cache     - scraped candidate profiles
  message_performance        - sent connection message tracking
  network_outcome            - follow-up value ratings
  ai_score_record            - AI profile scores
  gap_analysis_record        - gap analysis results
  networking_analysis_record - batch network analysis
  chat_record                - chat assistant history
  weekly_stats_record        - weekly activity summaries
  embedding_index            - RAG vectors for user history

All write functions also create an embedding_index entry so the chat
assistant can recall past activity.
"""

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

import embedding_service
from dotenv import load_dotenv

load_dotenv(override=True)

COSMOS_ENDPOINT       = os.getenv("AZURE_COSMOS_ENDPOINT", "")
COSMOS_KEY            = os.getenv("AZURE_COSMOS_KEY", "")
COSMOS_DB_NAME        = os.getenv("AZURE_COSMOS_DATABASE_NAME", "EduTech_AI_Production")
COSMOS_CONTAINER_NAME = os.getenv("AZURE_COSMOS_CONTAINER_NAME", "AgentLinkedin")

# TTL values in seconds used to auto-delete documents after a set period
TTL_30_DAYS  = 30 * 24 * 60 * 60
TTL_90_DAYS  = 90 * 24 * 60 * 60
TTL_180_DAYS = 180 * 24 * 60 * 60
TTL_365_DAYS = 365 * 24 * 60 * 60

_cosmos_client    = None
_container_client = None


def cosmos_configured() -> bool:
    return bool(COSMOS_ENDPOINT and COSMOS_KEY)


async def _get_container():
    global _cosmos_client, _container_client
    if _container_client is not None:
        return _container_client
    if not cosmos_configured():
        raise RuntimeError("Cosmos DB credentials not set in .env")
    from azure.cosmos.aio import CosmosClient
    from azure.cosmos import PartitionKey
    _cosmos_client = CosmosClient(url=COSMOS_ENDPOINT, credential=COSMOS_KEY)
    db = await _cosmos_client.create_database_if_not_exists(id=COSMOS_DB_NAME)
    _container_client = await db.create_container_if_not_exists(
        id=COSMOS_CONTAINER_NAME,
        partition_key=PartitionKey(path="/id"),
    )
    # Set default_ttl=-1 so each document can define its own expiry.
    # Also exclude the embedding vector from indexing - it is a 384-number array
    # that is never queried directly, so indexing it wastes storage and RU.
    try:
        await db.replace_container(
            container=_container_client,
            partition_key=PartitionKey(path="/id"),
            default_ttl=-1,
            indexing_policy={
                "indexingMode": "consistent",
                "automatic": True,
                "includedPaths": [{"path": "/*"}],
                "excludedPaths": [{"path": "/embedding/*"}],
            },
        )
    except Exception:
        pass  # Non-fatal: index/TTL can also be set manually in the Azure Portal
    return _container_client


async def close_cosmos():
    global _cosmos_client, _container_client
    if _cosmos_client:
        await _cosmos_client.close()
        _cosmos_client = _container_client = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_int(val) -> int:
    try:
        return int(val) if val is not None else 0
    except (ValueError, TypeError):
        return 0


# Cache helpers - Cosmos auto-deletes expired cache documents via TTL

async def cache_get(key: str):
    """Return the cached value for key, or None on a miss or expiry."""
    container = await _get_container()
    cache_id = f"cache:{key}"
    try:
        doc = await container.read_item(item=cache_id, partition_key=cache_id)
        return doc.get("data")
    except Exception:
        return None


async def cache_set(key: str, data, ttl_seconds: int = 300):
    """Store data under key; Cosmos will auto-delete it after ttl_seconds."""
    container = await _get_container()
    cache_id = f"cache:{key}"
    await container.upsert_item(body={
        "id":   cache_id,
        "type": "cache",
        "ttl":  ttl_seconds,
        "data": data,
    })


async def cache_delete(key: str):
    """Immediately remove a cache entry (manual invalidation on write)."""
    container = await _get_container()
    cache_id = f"cache:{key}"
    try:
        await container.delete_item(item=cache_id, partition_key=cache_id)
    except Exception:
        pass  # Already expired or never set


# User management

def _user_id(email: str) -> str:
    return f"user:{email.lower().strip()}"


async def get_user_by_email(email: str) -> Optional[dict]:
    container = await _get_container()
    uid = _user_id(email)
    try:
        return await container.read_item(item=uid, partition_key=uid)
    except Exception:
        return None


async def get_user_by_id(user_doc_id: str) -> Optional[dict]:
    """user_doc_id is the full document id e.g. 'user:foo@bar.com'."""
    container = await _get_container()
    try:
        return await container.read_item(item=user_doc_id, partition_key=user_doc_id)
    except Exception:
        return None


async def create_user(email: str, password_hash: str, is_admin: bool = False) -> dict:
    container = await _get_container()
    uid = _user_id(email)
    doc = {
        "id":            uid,
        "type":          "user",
        "email":         email.lower().strip(),
        "password_hash": password_hash,
        "is_admin":      is_admin,
        "is_active":     True,
        "created_at":    _now(),
        "last_seen":     _now(),
    }
    await container.create_item(body=doc)
    return doc


async def upsert_oauth_user(email: str, source: str = "oauth") -> dict:
    """Create or update a user that signed in via OAuth or Subul (no password)."""
    existing = await get_user_by_email(email)
    if existing:
        existing["last_seen"] = _now()
        existing["auth_provider"] = source
        container = await _get_container()
        await container.replace_item(item=existing["id"], body=existing)
        return existing
    user = await create_user(email, password_hash="", is_admin=False)
    user["auth_provider"] = source
    container = await _get_container()
    await container.replace_item(item=user["id"], body=user)
    return user


async def update_user_last_seen(user_doc_id: str):
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
        doc["last_seen"] = _now()
        await container.replace_item(item=user_doc_id, body=doc)
    except Exception:
        pass


async def deactivate_user(user_doc_id: str):
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
        doc["is_active"] = False
        await container.replace_item(item=user_doc_id, body=doc)
    except Exception:
        pass


async def reactivate_user(user_doc_id: str):
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
        doc["is_active"] = True
        await container.replace_item(item=user_doc_id, body=doc)
    except Exception:
        pass


async def count_users() -> int:
    container = await _get_container()
    total = 0
    async for v in container.query_items(
        "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'user'",
    ):
        total = v
    return total


async def list_users(page: int = 1, page_size: int = 20) -> tuple[list, int]:
    container = await _get_container()
    total = await count_users()
    offset = (page - 1) * page_size
    users = []
    async for item in container.query_items(
        f"SELECT * FROM c WHERE c.type = 'user' ORDER BY c._ts DESC OFFSET {offset} LIMIT {page_size}",
    ):
        users.append(item)
    return users, total


async def list_all_users() -> list:
    """Return all user documents (no pagination) for CSV export."""
    container = await _get_container()
    users = []
    async for item in container.query_items(
        "SELECT * FROM c WHERE c.type = 'user' ORDER BY c._ts DESC",
    ):
        users.append(item)
    return users


async def get_user_request_counts() -> dict:
    """Returns {user_email: request_count} for all users. Cached for 2 minutes."""
    cached = await cache_get("user_request_counts")
    if cached is not None:
        return cached
    container = await _get_container()
    counts: dict = {}
    async for item in container.query_items(
        "SELECT c.user_email FROM c WHERE c.type = 'usage_log'",
    ):
        email = item.get("user_email") or ""
        counts[email] = counts.get(email, 0) + 1
    await cache_set("user_request_counts", counts, ttl_seconds=120)
    return counts


# Usage log functions

async def create_usage_log(
    user_doc_id: Optional[str],
    user_email: Optional[str],
    action: str,
    deployment: str,
    tokens_in: Optional[int],
    tokens_out: Optional[int],
    latency_ms: Optional[int],
    success: bool,
    error_message: Optional[str],
) -> str:
    container = await _get_container()
    log_id = f"log:{uuid.uuid4()}"
    doc = {
        "id":            log_id,
        "type":          "usage_log",
        "user_id":       user_doc_id or "anonymous",
        "user_email":    user_email or "anonymous",
        "action":        action,
        "deployment":    deployment,
        "tokens_in":     tokens_in,
        "tokens_out":    tokens_out,
        "latency_ms":    latency_ms,
        "success":       success,
        "error_message": error_message,
        "created_at":    _now(),
        "ttl":           TTL_90_DAYS,
    }
    await container.create_item(body=doc)
    # Clear the stats cache so the admin dashboard shows fresh data
    await cache_delete("admin_stats")
    await cache_delete("user_request_counts")
    return log_id


async def count_logs() -> int:
    container = await _get_container()
    total = 0
    async for v in container.query_items(
        "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'usage_log'",
    ):
        total = v
    return total


async def list_logs(page: int = 1, page_size: int = 50) -> tuple[list, int]:
    container = await _get_container()
    total = await count_logs()
    offset = (page - 1) * page_size
    logs = []
    async for item in container.query_items(
        f"SELECT * FROM c WHERE c.type = 'usage_log' ORDER BY c._ts DESC OFFSET {offset} LIMIT {page_size}",
    ):
        logs.append(item)
    return logs, total


# Admin statistics

async def get_admin_stats() -> dict:
    """Aggregated admin stats. Cached for 5 minutes to avoid full-table scans on every load."""
    cached = await cache_get("admin_stats")
    if cached is not None:
        return cached

    container = await _get_container()

    # Helper to count documents by type, run in parallel
    async def _count_type(doc_type: str) -> int:
        n = 0
        async for v in container.query_items(
            f"SELECT VALUE COUNT(1) FROM c WHERE c.type = '{doc_type}'",
        ):
            n = v or 0
        return n

    # Run user and snapshot counts in parallel
    total_users_task = asyncio.ensure_future(_count_type("user"))
    total_snapshots_task = asyncio.ensure_future(_count_type("profile_snapshot"))

    # Single scan to compute all aggregates at once
    by_action: dict = {}
    by_model: dict = {}
    user_counts: dict = {}
    day_counts: dict = {}
    model_tokens_in: dict = {}
    model_tokens_out: dict = {}
    tokens_in_sum = 0
    tokens_out_sum = 0
    latency_total = 0
    latency_count = 0
    total_logs = 0
    success_count = 0
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

    async for item in container.query_items(
        "SELECT c.action, c.deployment, c.user_email, c.created_at, "
        "c.tokens_in, c.tokens_out, c.latency_ms, c.success FROM c WHERE c.type = 'usage_log'",
    ):
        total_logs += 1

        if item.get("success", True):
            success_count += 1

        action = item.get("action") or "unknown"
        by_action[action] = by_action.get(action, 0) + 1

        model = item.get("deployment") or "unknown"
        by_model[model] = by_model.get(model, 0) + 1

        t_in = _to_int(item.get("tokens_in") or 0)
        t_out = _to_int(item.get("tokens_out") or 0)
        tokens_in_sum += t_in
        tokens_out_sum += t_out
        model_tokens_in[model] = model_tokens_in.get(model, 0) + t_in
        model_tokens_out[model] = model_tokens_out.get(model, 0) + t_out

        lat = item.get("latency_ms")
        if lat is not None:
            try:
                lat_int = int(lat)
                if lat_int > 0:
                    latency_total += lat_int
                    latency_count += 1
            except (TypeError, ValueError):
                pass

        email = item.get("user_email") or "anonymous"
        user_counts[email] = user_counts.get(email, 0) + 1

        created = item.get("created_at") or ""
        if created >= cutoff:
            day = created[:10]
            if day:
                day_counts[day] = day_counts.get(day, 0) + 1

    avg_latency = round(latency_total / latency_count) if latency_count > 0 else 0
    success_rate = round(success_count / total_logs * 100) if total_logs > 0 else 100

    last_7_days = [{"date": k, "count": v} for k, v in sorted(day_counts.items())]
    top_users_list = [
        {"email": e, "count": n}
        for e, n in sorted(user_counts.items(), key=lambda x: -x[1])[:10]
    ]

    # Collect parallel results
    total_users = await total_users_task
    total_snapshots = await total_snapshots_task

    # Estimate cost per model based on Azure OpenAI pricing
    MODEL_COSTS = {
        "gpt-4o":      {"input": 2.50, "output": 10.00},
        "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    }

    def _match_cost(deployment_name: str) -> dict:
        dn = deployment_name.lower()
        if "4o-mini" in dn:
            return MODEL_COSTS["gpt-4o-mini"]
        if "4o" in dn:
            return MODEL_COSTS["gpt-4o"]
        return MODEL_COSTS["gpt-4o-mini"]  # default fallback

    model_costs = {}
    total_cost = 0.0
    for model_name in set(list(model_tokens_in.keys()) + list(model_tokens_out.keys())):
        t_in = model_tokens_in.get(model_name, 0)
        t_out = model_tokens_out.get(model_name, 0)
        rates = _match_cost(model_name)
        cost = (t_in / 1_000_000 * rates["input"]) + (t_out / 1_000_000 * rates["output"])
        model_costs[model_name] = {
            "tokens_in": t_in,
            "tokens_out": t_out,
            "cost_usd": round(cost, 4),
            "rate_input_per_1m": rates["input"],
            "rate_output_per_1m": rates["output"],
        }
        total_cost += cost

    result = {
        "total_users":          total_users,
        "total_requests":       total_logs,
        "total_tokens":         _to_int(tokens_in_sum) + _to_int(tokens_out_sum),
        "tokens_in":            _to_int(tokens_in_sum),
        "tokens_out":           _to_int(tokens_out_sum),
        "avg_latency_ms":       avg_latency,
        "requests_by_action":   by_action,
        "requests_by_model":    by_model,
        "requests_last_7_days": last_7_days,
        "top_users":            top_users_list,
        "cosmos_db":            {"total_snapshots": total_snapshots},
        "model_costs":          model_costs,
        "total_cost_usd":       round(total_cost, 4),
        "success_rate":         success_rate,
    }
    await cache_set("admin_stats", result, ttl_seconds=300)
    return result


# Profile snapshot functions

async def save_profile_snapshot(
    profile_payload: dict,
    user_id: Optional[str],
    user_email: Optional[str] = None,
) -> str:
    container = await _get_container()
    doc_id = str(uuid.uuid4())
    p = profile_payload

    document = {
        "id":   doc_id,
        "type": "profile_snapshot",

        "user_id":    user_id or "anonymous",
        "user_email": user_email or "",
        "captured_at": _now(),
        "source":     p.get("source", "extension"),

        # Core identity
        "profile_url":   p.get("_url") or p.get("profileUrl") or p.get("url", ""),
        "name":          p.get("name", ""),
        "headline":      p.get("headline", ""),
        "location":      p.get("location", ""),
        "about":         p.get("about", ""),
        "profile_image": p.get("profileImage") or p.get("avatar", ""),
        "banner_image":  p.get("bannerImage") or p.get("banner", ""),
        "current_role":  p.get("currentRole") or p.get("title", ""),
        "company":       p.get("company", ""),
        "industry":      p.get("industry", ""),
        "website":       p.get("website", ""),
        "open_to_work":  bool(p.get("openToWork")),
        "hiring":        bool(p.get("hiring")),

        # Metrics
        "connections": _to_int(p.get("connections") or p.get("connectionsCount")),
        "followers":   _to_int(p.get("followers")   or p.get("followersCount")),
        "following":   _to_int(p.get("following")   or p.get("followingCount")),

        # All LinkedIn sections
        "experience":      p.get("experience",      []),
        "education":       p.get("education",       []),
        "skills":          p.get("skills",          []),
        "certifications":  p.get("certifications",  []),
        "projects":        p.get("projects",        []),
        "languages":       p.get("languages",       []),
        "volunteer":       p.get("volunteer",       []),
        "publications":    p.get("publications",    []),
        "honors":          p.get("honors") or p.get("awards", []),
        "recommendations": p.get("recommendations", []),
        "courses":         p.get("courses",         []),
        "organizations":   p.get("organizations",   []),
        "patents":         p.get("patents",         []),
        "test_scores":     p.get("testScores") or p.get("test_scores", []),
        "featured":        p.get("featured",        []),
        "interests":       p.get("interests",       []),
        "causes":          p.get("causes",          []),

        # Posts
        "posts": p.get("posts", []),

        # Full raw scrape — nothing lost
        "raw_payload": p,
    }

    await container.create_item(body=document)
    await _index_source_document(document)  # RAG: mirror into embedding_index (non-fatal)
    return doc_id


async def get_user_snapshots(user_id: str, limit: int = 20) -> list:
    container = await _get_container()
    items = []
    async for item in container.query_items(
        "SELECT c.id, c.captured_at, c.profile_url, c.name, c.headline, "
        "c.location, c.connections, c.followers, c.current_role, c.company, c.source "
        "FROM c WHERE c.user_id = @uid AND c.type = 'profile_snapshot' "
        f"ORDER BY c._ts DESC OFFSET 0 LIMIT {limit}",
        parameters=[{"name": "@uid", "value": user_id}],
    ):
        items.append(item)
    return items


async def get_snapshot_by_id(doc_id: str) -> Optional[dict]:
    container = await _get_container()
    try:
        return await container.read_item(item=doc_id, partition_key=doc_id)
    except Exception:
        return None


async def get_all_snapshots(limit: int = 50, offset: int = 0) -> list:
    container = await _get_container()
    items = []
    async for item in container.query_items(
        "SELECT c.id, c.captured_at, c.user_id, c.user_email, c.profile_url, "
        "c.name, c.headline, c.connections, c.followers, c.source "
        "FROM c WHERE c.type = 'profile_snapshot' "
        f"ORDER BY c._ts DESC OFFSET {offset} LIMIT {limit}",
    ):
        items.append(item)
    return items


# Networking goal / onboarding preferences

async def upsert_networking_goal(user_id: str, goal_data: dict) -> dict:
    """Save or update the user's networking goal profile."""
    container = await _get_container()
    doc_id = f"netgoal:{user_id}"
    doc = {
        "id":                        doc_id,
        "type":                      "networking_goal",
        "user_id":                   user_id,
        "goal":                      goal_data.get("goal", "job_search"),
        "industry":                  goal_data.get("industry", ""),
        "job_title":                 goal_data.get("job_title", ""),
        "seniority":                 goal_data.get("seniority", "mid"),
        "skills":                    goal_data.get("skills", []),
        "location":                  goal_data.get("location", ""),
        "current_network_size":      goal_data.get("current_network_size", 0),
        "current_network_industries": goal_data.get("current_network_industries", []),
        "updated_at":                _now(),
    }
    await container.upsert_item(body=doc)
    return doc


async def get_networking_goal(user_id: str) -> Optional[dict]:
    container = await _get_container()
    doc_id = f"netgoal:{user_id}"
    try:
        return await container.read_item(item=doc_id, partition_key=doc_id)
    except Exception:
        return None


# Connection interaction logs

async def log_interaction(user_id: str, interaction_data: dict) -> str:
    container = await _get_container()
    doc_id = f"interact:{uuid.uuid4()}"
    doc = {
        "id":                  doc_id,
        "type":                "connection_interaction",
        "user_id":             user_id,
        "suggested_profile_id": interaction_data.get("suggested_profile_id", ""),
        "score_given":         interaction_data.get("score_given", 0),
        "score_breakdown":     interaction_data.get("score_breakdown", {}),
        "user_action":         interaction_data.get("user_action", "skipped"),
        "reason_shown":        interaction_data.get("reason_shown", ""),
        "time_to_decision_seconds": interaction_data.get("time_to_decision_seconds"),
        "timestamp":           _now(),
    }
    await container.create_item(body=doc)
    return doc_id


async def count_interactions() -> int:
    container = await _get_container()
    total = 0
    async for v in container.query_items(
        "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'connection_interaction'",
    ):
        total = v
    return total


async def get_networking_stats() -> dict:
    """Aggregate networking stats for admin dashboard. Cached 5 min."""
    cached = await cache_get("networking_stats")
    if cached is not None:
        return cached

    container = await _get_container()

    total_interactions = await count_interactions()

    connected = 0
    skipped = 0
    goal_counts: dict = {}
    score_connect: list = []
    score_skip: list = []

    async for item in container.query_items(
        "SELECT c.user_action, c.score_given FROM c WHERE c.type = 'connection_interaction'",
    ):
        action = item.get("user_action", "skipped")
        if action == "connected":
            connected += 1
            if item.get("score_given"):
                score_connect.append(item["score_given"])
        else:
            skipped += 1
            if item.get("score_given"):
                score_skip.append(item["score_given"])

    async for item in container.query_items(
        "SELECT c.goal FROM c WHERE c.type = 'networking_goal'",
    ):
        g = item.get("goal", "unknown")
        goal_counts[g] = goal_counts.get(g, 0) + 1

    acceptance_rate = round((connected / total_interactions * 100) if total_interactions else 0, 1)
    avg_score_connect = round(sum(score_connect) / len(score_connect), 1) if score_connect else 0
    avg_score_skip = round(sum(score_skip) / len(score_skip), 1) if score_skip else 0

    result = {
        "total_interactions":  total_interactions,
        "total_connected":     connected,
        "total_skipped":       skipped,
        "acceptance_rate":     acceptance_rate,
        "goal_distribution":   goal_counts,
        "avg_score_at_connect": avg_score_connect,
        "avg_score_at_skip":   avg_score_skip,
    }
    await cache_set("networking_stats", result, ttl_seconds=300)
    return result


async def list_interactions(page: int = 1, page_size: int = 50) -> tuple[list, int]:
    container = await _get_container()
    total = await count_interactions()
    offset = (page - 1) * page_size
    items = []
    async for item in container.query_items(
        f"SELECT * FROM c WHERE c.type = 'connection_interaction' "
        f"ORDER BY c._ts DESC OFFSET {offset} LIMIT {page_size}",
    ):
        items.append(item)
    return items, total


# Cached scraped LinkedIn profiles

async def upsert_profile_cache(url_slug: str, profile_data: dict) -> dict:
    container = await _get_container()
    doc_id = f"profile:{url_slug}"
    doc = {
        "id":                    doc_id,
        "type":                  "linkedin_profile_cache",
        "url_slug":              url_slug,
        "name":                  profile_data.get("name", ""),
        "title":                 profile_data.get("title", ""),
        "company":               profile_data.get("company", ""),
        "industry":              profile_data.get("industry", ""),
        "location":              profile_data.get("location", ""),
        "skills":                profile_data.get("skills", []),
        "mutual_connections_count": profile_data.get("mutual_connections_count", 0),
        "post_frequency":        profile_data.get("post_frequency", "unknown"),
        "avg_engagement_rate":   profile_data.get("avg_engagement_rate", 0.0),
        "follower_growth_30d":   profile_data.get("follower_growth_30d", 0),
        "profilePhotoUrl":       profile_data.get("profilePhotoUrl", ""),
        "bannerUrl":             profile_data.get("bannerUrl", ""),
        "open_to_connect":       profile_data.get("open_to_connect", True),
        "source_page":           profile_data.get("source_page", "search"),
        "last_seen_at":          _now(),
        "ttl":                   TTL_30_DAYS,
    }
    await container.upsert_item(body=doc)
    return doc


async def get_profile_cache(url_slug: str) -> Optional[dict]:
    container = await _get_container()
    doc_id = f"profile:{url_slug}"
    try:
        return await container.read_item(item=doc_id, partition_key=doc_id)
    except Exception:
        return None


# Message performance tracking

async def log_message_performance(user_id: str, message_data: dict) -> str:
    container = await _get_container()
    doc_id = f"msg:{uuid.uuid4()}"
    doc = {
        "id":                doc_id,
        "type":              "message_performance",
        "user_id":           user_id,
        "target_profile_id": message_data.get("target_profile_id", ""),
        "message_text":      message_data.get("message_text", ""),
        "variables_used":    message_data.get("variables_used", []),
        "was_accepted":      None,  # updated after 48h outcome check
        "industry_context":  message_data.get("industry_context", ""),
        "seniority_of_target": message_data.get("seniority_of_target", ""),
        "timestamp":         _now(),
    }
    await container.create_item(body=doc)
    return doc_id


async def update_message_outcome(msg_id: str, was_accepted: bool):
    """Called ~48h after send to record whether connection was accepted."""
    container = await _get_container()
    try:
        doc = await container.read_item(item=msg_id, partition_key=msg_id)
        doc["was_accepted"] = was_accepted
        await container.replace_item(item=msg_id, body=doc)
    except Exception:
        pass


# Network growth outcome tracking

async def log_network_outcome(user_id: str, outcome_data: dict) -> str:
    container = await _get_container()
    doc_id = f"outcome:{uuid.uuid4()}"
    doc = {
        "id":                   doc_id,
        "type":                 "network_outcome",
        "user_id":              user_id,
        "connection_profile_id": outcome_data.get("connection_profile_id", ""),
        "user_goal_at_time":    outcome_data.get("user_goal_at_time", ""),
        "outcome_category":     outcome_data.get("outcome_category", "no_interaction"),
        "value_rating":         outcome_data.get("value_rating", 3),
        "days_since_connection": outcome_data.get("days_since_connection", 30),
        "timestamp":            _now(),
    }
    await container.create_item(body=doc)
    return doc_id


# AI output records saved for model training and analysis

async def save_ai_score(user_id: str, score_data: dict, profile_summary: dict) -> str:
    """Persist AI profile score for future model training."""
    container = await _get_container()
    doc_id = f"aiscore:{uuid.uuid4()}"
    doc = {
        "id": doc_id,
        "type": "ai_score_record",
        "user_id": user_id,
        "overall_score": score_data.get("overall_score", 0),
        "grade": score_data.get("grade", ""),
        "profile_type": score_data.get("profile_type", ""),
        "sections": score_data.get("sections", {}),
        "top_3_actions": score_data.get("top_3_actions", []),
        "strengths": score_data.get("strengths", []),
        "profile_summary": {
            "name": profile_summary.get("name", ""),
            "headline": profile_summary.get("headline", ""),
            "skills_count": len(profile_summary.get("skills") or []),
            "experience_count": len(profile_summary.get("experience") or []),
            "has_about": bool(profile_summary.get("about")),
        },
        "goal": score_data.get("_goal", "job_search"),
        "created_at": _now(),
        "ttl": TTL_180_DAYS,
    }
    await container.create_item(body=doc)
    await _index_source_document(doc)  # RAG: mirror into embedding_index (non-fatal)
    return doc_id


async def save_gap_analysis(user_id: str, gap_data: dict, user_name: str, target_name: str, target_slug: str) -> str:
    """Persist gap analysis for training and user history."""
    container = await _get_container()
    doc_id = f"gap:{uuid.uuid4()}"
    doc = {
        "id": doc_id,
        "type": "gap_analysis_record",
        "user_id": user_id,
        "user_name": user_name,
        "target_name": target_name,
        "target_slug": target_slug,
        "overall_gap_score": gap_data.get("overall_gap_score", 0),
        "score_label": gap_data.get("score_label", ""),
        "sections": gap_data.get("sections", {}),
        "quick_wins": gap_data.get("quick_wins", []),
        "key_insight": gap_data.get("key_insight", ""),
        "created_at": _now(),
        "ttl": TTL_180_DAYS,
    }
    await container.create_item(body=doc)
    await _index_source_document(doc)  # RAG: mirror into embedding_index (non-fatal)
    return doc_id


async def save_networking_analysis(user_id: str, goal: str, analyses: list) -> str:
    """Persist batch AI networking analysis results."""
    container = await _get_container()
    doc_id = f"netanalysis:{uuid.uuid4()}"
    doc = {
        "id": doc_id,
        "type": "networking_analysis_record",
        "user_id": user_id,
        "goal": goal,
        "candidate_count": len(analyses),
        "results": [
            {
                "slug": a.get("slug", ""),
                "score": a.get("score", 0),
                "match_summary": a.get("match_summary", ""),
                "strengths": a.get("strengths", []),
            }
            for a in analyses
        ],
        "avg_score": round(sum(a.get("score", 0) for a in analyses) / max(len(analyses), 1), 1),
        "created_at": _now(),
    }
    await container.create_item(body=doc)
    await _index_source_document(doc)  # RAG: mirror into embedding_index (non-fatal)
    return doc_id


async def save_chat_message(user_id: str, message: str, intent: str, reply: str) -> str:
    """Persist chat messages for intent routing improvement."""
    container = await _get_container()
    doc_id = f"chat:{uuid.uuid4()}"
    doc = {
        "id": doc_id,
        "type": "chat_record",
        "user_id": user_id,
        "user_message": message[:500],
        "detected_intent": intent,
        "reply": reply[:500],
        "created_at": _now(),
        "ttl": TTL_30_DAYS,
    }
    await container.create_item(body=doc)
    await _index_source_document(doc)  # RAG: mirror into embedding_index (non-fatal)
    return doc_id


async def save_weekly_stats(user_id: str, stats: dict) -> str:
    """Persist weekly networking stats for trend analysis."""
    container = await _get_container()
    doc_id = f"weekly:{uuid.uuid4()}"
    doc = {
        "id": doc_id,
        "type": "weekly_stats_record",
        "user_id": user_id,
        "sent": stats.get("sent", 0),
        "accepted": stats.get("accepted", 0),
        "scans": stats.get("scans", 0),
        "acceptance_rate": stats.get("rate", 0),
        "created_at": _now(),
        "ttl": TTL_365_DAYS,
    }
    await container.create_item(body=doc)
    return doc_id


# RAG embedding index - stores vectors for user history retrieval

EMB_ID_PREFIX = "emb:"

# Document types that should be embedded for the RAG feature
_EMBEDDABLE_TYPES = {
    "gap_analysis_record",
    "ai_score_record",
    "networking_analysis_record",
    "chat_record",
    "profile_snapshot",
}


def _clip(text: str, limit: int = 500) -> str:
    return (text or "").strip()[:limit]


# Builders that create a short text summary from each document type for embedding

def _summarize_gap_analysis(doc: dict) -> tuple[str, dict]:
    target = doc.get("target_name", "") or "a profile"
    label = doc.get("score_label", "")
    score = doc.get("overall_gap_score", "")
    insight = doc.get("key_insight", "")

    # Include section-level gap details
    sections = doc.get("sections", {}) or {}
    gap_names: list[str] = []
    if isinstance(sections, dict):
        for name, sec in sections.items():
            gap_names.append(str(name))
    elif isinstance(sections, list):
        for sec in sections:
            if isinstance(sec, dict):
                gap_names.append(str(sec.get("name") or sec.get("title") or ""))
    gap_names = [g for g in gap_names if g][:6]

    # Include quick win action titles
    quick_titles: list[str] = []
    for qw in (doc.get("quick_wins") or [])[:6]:
        if isinstance(qw, dict):
            quick_titles.append(str(qw.get("title") or qw.get("action") or qw.get("text") or ""))
        elif qw:
            quick_titles.append(str(qw))
    quick_titles = [q for q in quick_titles if q]

    parts = [f"Gap analysis vs {target}: verdict '{label}' (gap score {score})."]
    if insight:
        parts.append(f"Key insight: {insight}.")
    if gap_names:
        parts.append("Gaps flagged: " + ", ".join(gap_names) + ".")
    if quick_titles:
        parts.append("Quick wins: " + ", ".join(quick_titles) + ".")
    text = " ".join(parts)

    meta = {"target_name": target, "verdict": label, "score": score}
    return text, meta


def _summarize_ai_score(doc: dict) -> tuple[str, dict]:
    score = doc.get("overall_score", "")
    grade = doc.get("grade", "")
    ptype = doc.get("profile_type", "")
    strengths = [str(s) for s in (doc.get("strengths") or [])[:4] if s]
    actions = [str(a) for a in (doc.get("top_3_actions") or [])[:3] if a]

    parts = [f"AI profile score: {score}/100 (grade {grade}{', ' + ptype if ptype else ''})."]
    if strengths:
        parts.append("Strengths: " + ", ".join(strengths) + ".")
    if actions:
        parts.append("Top actions: " + ", ".join(actions) + ".")
    text = " ".join(parts)

    meta = {"overall_score": score, "grade": grade}
    return text, meta


def _summarize_networking_analysis(doc: dict) -> tuple[str, dict]:
    goal = doc.get("goal", "")
    count = doc.get("candidate_count", 0)
    avg = doc.get("avg_score", "")
    summaries: list[str] = []
    for r in (doc.get("results") or [])[:5]:
        if isinstance(r, dict):
            ms = str(r.get("match_summary") or "").strip()
            if ms:
                summaries.append(ms)

    parts = [f"Networking scan for goal '{goal}': {count} candidates analysed, average fit {avg}."]
    if summaries:
        parts.append("Top matches: " + " | ".join(summaries[:3]))
    text = " ".join(parts)

    meta = {"goal": goal, "avg_score": avg, "candidate_count": count}
    return text, meta


def _summarize_chat(doc: dict) -> tuple[str, dict]:
    msg = (doc.get("user_message") or "").strip()
    intent = doc.get("detected_intent", "")
    reply = (doc.get("reply") or "").strip()
    text = f"Chat ({intent}). User asked: {msg}"
    if reply:
        text += f" Assistant replied: {reply}"
    meta = {"intent": intent}
    return _clip(text, 1000), meta


def _summarize_profile_snapshot(doc: dict) -> tuple[str, dict]:
    name = doc.get("name", "")
    headline = (doc.get("headline") or "").strip()
    about = (doc.get("about") or "").strip()
    meta = {"name": name, "headline": _clip(headline, 200)}

    # Skip if there is no useful text to embed
    if not headline and not about:
        return "", meta

    parts = []
    if headline:
        parts.append(f"Headline: {headline}.")
    if about:
        parts.append(f"About: {about}")
    text = (f"Profile snapshot — {name}. " if name else "Profile snapshot. ") + " ".join(parts)
    return text, meta


_SUMMARIZERS = {
    "gap_analysis_record":         _summarize_gap_analysis,
    "ai_score_record":             _summarize_ai_score,
    "networking_analysis_record":  _summarize_networking_analysis,
    "chat_record":                 _summarize_chat,
    "profile_snapshot":            _summarize_profile_snapshot,
}


def build_embedding_text(doc: dict) -> Optional[tuple[str, dict]]:
    """Return (summary_text, metadata) for an embeddable source doc, or None.

    Returns None when the doc type is not embeddable or the summary would be
    empty (e.g. a profile snapshot with no headline or about — nothing to recall).
    Shared by both the live write-path hook and the backfill script so they
    always produce identical embeddings.
    """
    summarizer = _SUMMARIZERS.get(doc.get("type", ""))
    if summarizer is None:
        return None
    text, meta = summarizer(doc)
    if not text or not text.strip() or len(text.strip()) < 12:
        return None
    return text, meta


# Embedding storage and retrieval

async def embedding_exists(source_id: str) -> bool:
    """True if an embedding_index doc already exists for *source_id* (idempotency)."""
    container = await _get_container()
    emb_id = EMB_ID_PREFIX + source_id
    try:
        await container.read_item(item=emb_id, partition_key=emb_id)
        return True
    except Exception:
        return False


async def save_embedding(
    *,
    source_id: str,
    user_id: str,
    source_type: str,
    text: str,
    metadata: Optional[dict] = None,
    skip_if_exists: bool = True,
    ttl: Optional[int] = TTL_180_DAYS,
) -> Optional[str]:
    """Embed *text* and persist it as an embedding_index doc keyed to *source_id*.

    Returns the embedding doc id, or None if the embedding model is unavailable
    or the source was already indexed (when skip_if_exists is True).

    *ttl* controls expiry: pass the SOURCE document's ttl so the embedding dies
    exactly when its source does (e.g. chat embeddings expire at 30 days like the
    chat itself).  Pass None for sources that never expire (profile snapshots,
    networking analyses) so the embedding is kept as long as the source.

    The encode() call is CPU-bound and synchronous, so we run it in a worker
    thread to avoid blocking the FastAPI event loop.
    """
    if not embedding_service.is_available():
        return None

    emb_id = EMB_ID_PREFIX + source_id
    if skip_if_exists and await embedding_exists(source_id):
        return None

    vector = await asyncio.to_thread(embedding_service.encode, text)
    if not vector:
        return None

    container = await _get_container()
    doc = {
        "id":           emb_id,
        "type":         "embedding_index",
        "user_id":      user_id or "anonymous",
        "source_type":  source_type,
        "source_id":    source_id,
        "text_preview": _clip(text, 500),
        "embedding":    vector,             # 384 floats, L2-normalised
        "metadata":     metadata or {},
        "created_at":   _now(),
    }
    if ttl is not None:
        doc["ttl"] = ttl  # match the source's expiry; omit entirely = never expires
    # Upsert so re-indexing replaces the old embedding cleanly
    await container.upsert_item(body=doc)
    return emb_id


async def _index_source_document(doc: dict) -> None:
    """Write-path hook: mirror a freshly-saved source doc into embedding_index.

    Non-fatal by design — a failure here must never break the primary save.
    """
    try:
        if doc.get("type") not in _EMBEDDABLE_TYPES:
            return
        if not embedding_service.is_available():
            return
        built = build_embedding_text(doc)
        if built is None:
            return
        text, meta = built
        await save_embedding(
            source_id=doc["id"],
            user_id=doc.get("user_id", "anonymous"),
            source_type=doc["type"],
            text=text,
            metadata=meta,
            ttl=doc.get("ttl"),  # expire the embedding exactly when its source does
        )
    except Exception as exc:
        logging.getLogger(__name__).warning(
            "[cosmos_db] embedding index failed for %s: %s", doc.get("id"), exc
        )


async def get_user_embeddings(user_id: str) -> list:
    """Return all embedding_index docs for a user (partition-cross query).

    At this scale (<300 docs/user) pulling the full set and scoring in Python
    is correct — see the Enhancement Guide's scale note.
    """
    container = await _get_container()
    results = []
    query = (
        "SELECT c.id, c.source_type, c.source_id, c.text_preview, "
        "c.embedding, c.metadata, c.created_at "
        "FROM c WHERE c.type = 'embedding_index' AND c.user_id = @uid"
    )
    async for item in container.query_items(
        query=query,
        parameters=[{"name": "@uid", "value": user_id}],
    ):
        results.append(item)
    return results


async def delete_user_embeddings(user_id: str) -> int:
    """Delete every embedding_index doc for a user.  Returns the count deleted.

    Called from the account-deletion path: embeddings are derived data and must
    be removed when the source data is (GDPR).
    """
    container = await _get_container()
    ids: list[str] = []
    async for item in container.query_items(
        query="SELECT c.id FROM c WHERE c.type = 'embedding_index' AND c.user_id = @uid",
        parameters=[{"name": "@uid", "value": user_id}],
    ):
        ids.append(item["id"])

    deleted = 0
    for emb_id in ids:
        try:
            await container.delete_item(item=emb_id, partition_key=emb_id)
            deleted += 1
        except Exception:
            pass
    return deleted


async def delete_user_data(user_doc_id: str) -> dict:
    """GDPR account/data deletion: remove the user and ALL their data.

    Deletes (a) every document owned by the user (user_id == user_doc_id) —
    which includes derived embedding_index docs, gap analyses, scores, scans,
    chats, snapshots — and (b) the user account document itself.

    Embeddings are derived data: deleting them here keeps us compliant when the
    source data is erased (see the Enhancement Guide, Step 7).

    Returns counts: {"records": N, "embeddings": M, "user": 0|1}.
    """
    container = await _get_container()

    # Load all documents belonging to this user
    owned_ids: list[str] = []
    embedding_count = 0
    async for item in container.query_items(
        query="SELECT c.id, c.type FROM c WHERE c.user_id = @uid",
        parameters=[{"name": "@uid", "value": user_doc_id}],
    ):
        owned_ids.append(item["id"])
        if item.get("type") == "embedding_index":
            embedding_count += 1

    records = 0
    for doc_id in owned_ids:
        try:
            await container.delete_item(item=doc_id, partition_key=doc_id)
            records += 1
        except Exception:
            pass

    # Delete the user account document last
    user_deleted = 0
    try:
        await container.delete_item(item=user_doc_id, partition_key=user_doc_id)
        user_deleted = 1
    except Exception:
        pass

    return {"records": records, "embeddings": embedding_count, "user": user_deleted}


async def iter_documents_by_type(doc_type: str):
    """Async-iterate every document of *doc_type* (used by the backfill script)."""
    container = await _get_container()
    async for item in container.query_items(
        query="SELECT * FROM c WHERE c.type = @t",
        parameters=[{"name": "@t", "value": doc_type}],
    ):
        yield item


# Types used by backfill_embeddings.py and the live write hooks - must match
EMBEDDABLE_SOURCE_TYPES = sorted(_EMBEDDABLE_TYPES)


async def count_embeddings() -> int:
    """Total number of embedding_index docs across all users (for monitoring)."""
    container = await _get_container()
    total = 0
    async for v in container.query_items(
        "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'embedding_index'",
    ):
        total = v
    return total


async def backfill_all_embeddings() -> dict:
    """Index every existing embeddable document that isn't indexed yet.

    Idempotent — skips anything already present (embedding_exists).  Safe to run
    repeatedly.  Returns counts: indexed / skipped / empty(no-signal) / failed.
    Intended to be invoked once after deploying Enhancement 2, in-process so it
    reuses the already-loaded embedding model.
    """
    totals = {"indexed": 0, "skipped": 0, "empty": 0, "failed": 0}
    if not embedding_service.is_available():
        totals["error"] = "model_unavailable"
        return totals

    for source_type in EMBEDDABLE_SOURCE_TYPES:
        async for doc in iter_documents_by_type(source_type):
            source_id = doc.get("id")
            if not source_id:
                continue
            try:
                if await embedding_exists(source_id):
                    totals["skipped"] += 1
                    continue
            except Exception:
                pass
            built = build_embedding_text(doc)
            if built is None:
                totals["empty"] += 1
                continue
            text, meta = built
            try:
                emb_id = await save_embedding(
                    source_id=source_id,
                    user_id=doc.get("user_id", "anonymous"),
                    source_type=source_type,
                    text=text,
                    metadata=meta,
                    ttl=doc.get("ttl"),
                )
                totals["indexed" if emb_id else "skipped"] += 1
            except Exception:
                totals["failed"] += 1
    return totals


# Subul platform user management (paid external auth provider)

async def list_subul_users(page: int = 1, page_size: int = 20) -> tuple[list, int]:
    """List all users who registered via Subul, paginated."""
    container = await _get_container()
    total = 0
    async for v in container.query_items(
        "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'user' AND c.auth_provider = 'subul'",
    ):
        total = v
    offset = (page - 1) * page_size
    users = []
    async for item in container.query_items(
        f"SELECT * FROM c WHERE c.type = 'user' AND c.auth_provider = 'subul' "
        f"ORDER BY c._ts DESC OFFSET {offset} LIMIT {page_size}",
    ):
        users.append(item)
    return users, total


async def count_subul_users() -> int:
    container = await _get_container()
    total = 0
    async for v in container.query_items(
        "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'user' AND c.auth_provider = 'subul'",
    ):
        total = v
    return total


async def get_subul_stats() -> dict:
    """Aggregated Subul user stats. Cached 5 min."""
    cached = await cache_get("subul_stats")
    if cached is not None:
        return cached

    container = await _get_container()
    total_subul = await count_subul_users()

    # Count active and inactive Subul users
    active = 0
    async for v in container.query_items(
        "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'user' AND c.auth_provider = 'subul' AND c.is_active = true",
    ):
        active = v

    # Count API calls from Subul users
    subul_emails = []
    async for item in container.query_items(
        "SELECT c.email FROM c WHERE c.type = 'user' AND c.auth_provider = 'subul'",
    ):
        subul_emails.append(item.get("email", ""))

    total_requests = 0
    requests_by_action: dict = {}
    for email in subul_emails:
        async for item in container.query_items(
            "SELECT c.action FROM c WHERE c.type = 'usage_log' AND c.user_email = @email",
            parameters=[{"name": "@email", "value": email}],
        ):
            total_requests += 1
            action = item.get("action", "unknown")
            requests_by_action[action] = requests_by_action.get(action, 0) + 1

    result = {
        "total_subul_users":  total_subul,
        "active_subul_users": active,
        "inactive_subul_users": total_subul - active,
        "total_requests":     total_requests,
        "requests_by_action": requests_by_action,
    }
    await cache_set("subul_stats", result, ttl_seconds=300)
    return result


# Per-user data aggregation

async def get_user_full_profile(user_doc_id: str) -> dict:
    """Retrieve the user document with all metadata."""
    user = await get_user_by_id(user_doc_id)
    if not user:
        return {}
    # Remove Cosmos internal fields before returning
    return {
        "id":            user.get("id"),
        "email":         user.get("email"),
        "auth_provider": user.get("auth_provider", "email"),
        "is_admin":      user.get("is_admin", False),
        "is_active":     user.get("is_active", True),
        "created_at":    user.get("created_at", ""),
        "last_seen":     user.get("last_seen", ""),
    }


async def get_user_usage_stats(user_doc_id: str) -> dict:
    """Aggregate usage statistics for a single user."""
    container = await _get_container()

    total = 0
    async for v in container.query_items(
        "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'usage_log' AND c.user_id = @uid",
        parameters=[{"name": "@uid", "value": user_doc_id}],
    ):
        total = v

    tokens_in = 0
    async for v in container.query_items(
        "SELECT VALUE SUM(c.tokens_in) FROM c WHERE c.type = 'usage_log' AND c.user_id = @uid",
        parameters=[{"name": "@uid", "value": user_doc_id}],
    ):
        tokens_in = v or 0

    tokens_out = 0
    async for v in container.query_items(
        "SELECT VALUE SUM(c.tokens_out) FROM c WHERE c.type = 'usage_log' AND c.user_id = @uid",
        parameters=[{"name": "@uid", "value": user_doc_id}],
    ):
        tokens_out = v or 0

    by_action: dict = {}
    recent_logs: list = []
    async for item in container.query_items(
        "SELECT c.action, c.created_at, c.deployment, c.success, c.latency_ms, c.tokens_in, c.tokens_out "
        "FROM c WHERE c.type = 'usage_log' AND c.user_id = @uid ORDER BY c._ts DESC",
        parameters=[{"name": "@uid", "value": user_doc_id}],
    ):
        action = item.get("action", "unknown")
        by_action[action] = by_action.get(action, 0) + 1
        if len(recent_logs) < 20:
            recent_logs.append(item)

    return {
        "total_requests":     total,
        "total_tokens":       _to_int(tokens_in) + _to_int(tokens_out),
        "requests_by_action": by_action,
        "recent_logs":        recent_logs,
    }


async def get_user_networking_stats(user_doc_id: str) -> dict:
    """Networking activity for a single user."""
    container = await _get_container()

    # Load interaction history
    connected = 0
    skipped = 0
    async for item in container.query_items(
        "SELECT c.user_action FROM c WHERE c.type = 'connection_interaction' AND c.user_id = @uid",
        parameters=[{"name": "@uid", "value": user_doc_id}],
    ):
        if item.get("user_action") == "connected":
            connected += 1
        else:
            skipped += 1

    # Messages sent
    messages_sent = 0
    messages_accepted = 0
    async for item in container.query_items(
        "SELECT c.was_accepted FROM c WHERE c.type = 'message_performance' AND c.user_id = @uid",
        parameters=[{"name": "@uid", "value": user_doc_id}],
    ):
        messages_sent += 1
        if item.get("was_accepted") is True:
            messages_accepted += 1

    # Networking goal
    goal = await get_networking_goal(user_doc_id)

    return {
        "connections_made":   connected,
        "connections_skipped": skipped,
        "acceptance_rate":    round((connected / (connected + skipped) * 100) if (connected + skipped) else 0, 1),
        "messages_sent":      messages_sent,
        "messages_accepted":  messages_accepted,
        "networking_goal":    goal.get("goal", "") if goal else "",
        "goal_industry":      goal.get("industry", "") if goal else "",
    }


async def get_user_ai_history(user_doc_id: str, limit: int = 10) -> dict:
    """AI analysis history — scores, gap analyses, chat messages."""
    container = await _get_container()

    ai_scores = []
    async for item in container.query_items(
        f"SELECT c.id, c.overall_score, c.grade, c.profile_type, c.created_at "
        f"FROM c WHERE c.type = 'ai_score_record' AND c.user_id = @uid "
        f"ORDER BY c._ts DESC OFFSET 0 LIMIT {limit}",
        parameters=[{"name": "@uid", "value": user_doc_id}],
    ):
        ai_scores.append(item)

    gap_analyses = []
    async for item in container.query_items(
        f"SELECT c.id, c.target_name, c.target_slug, c.overall_gap_score, c.score_label, c.created_at "
        f"FROM c WHERE c.type = 'gap_analysis_record' AND c.user_id = @uid "
        f"ORDER BY c._ts DESC OFFSET 0 LIMIT {limit}",
        parameters=[{"name": "@uid", "value": user_doc_id}],
    ):
        gap_analyses.append(item)

    chat_count = 0
    async for v in container.query_items(
        "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'chat_record' AND c.user_id = @uid",
        parameters=[{"name": "@uid", "value": user_doc_id}],
    ):
        chat_count = v

    return {
        "ai_scores":    ai_scores,
        "gap_analyses": gap_analyses,
        "chat_count":   chat_count,
    }


async def get_user_complete_data(user_doc_id: str) -> dict:
    """Full consolidated view of a single user's data across all document types.
    Returns data even if the user document itself is missing — builds a minimal
    profile from the user_doc_id and still fetches all activity data."""
    user_profile = await get_user_full_profile(user_doc_id)
    if not user_profile:
        # Build minimal profile from ID so the dashboard still shows activity data
        email = user_doc_id.replace("user:", "") if user_doc_id.startswith("user:") else user_doc_id
        user_profile = {
            "id": user_doc_id,
            "email": email,
            "auth_provider": "unknown",
            "is_admin": False,
            "is_active": True,
            "created_at": "",
            "last_seen": "",
        }

    usage_stats = await get_user_usage_stats(user_doc_id)
    networking = await get_user_networking_stats(user_doc_id)
    ai_history = await get_user_ai_history(user_doc_id)
    snapshots = await get_user_snapshots(user_doc_id, limit=10)

    return {
        "user":       user_profile,
        "usage":      usage_stats,
        "networking": networking,
        "ai_history": ai_history,
        "snapshots":  snapshots,
    }


# ─────────────────────────────────────────────────────────
#  USER LINKEDIN PROFILE  (persistent profile storage)
#
#  Stored directly on the user document under "linkedin_profile".
#  This allows the extension to pre-fill profile data on login
#  without requiring a fresh scrape every time.
# ─────────────────────────────────────────────────────────

async def save_user_linkedin_profile(user_doc_id: str, profile_data: dict) -> dict:
    """
    Save or update the LinkedIn profile data on the user document.
    Called on every scrape or manual edit from the extension.
    """
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
    except Exception:
        return {}

    # Store the full profile so the extension can fully restore it on login.
    # profilePhotoUrl, scrapedAt, _source, _isOwn, url_slug, etc. must all survive.
    doc["linkedin_profile"] = {
        **profile_data,                               # preserve every field the extension sent
        # Ensure these canonical fields are always normalised
        "name":            profile_data.get("name", ""),
        "headline":        profile_data.get("headline", ""),
        "location":        profile_data.get("location", ""),
        "about":           profile_data.get("about", ""),
        "currentRole":     profile_data.get("currentRole", ""),
        "company":         profile_data.get("company", ""),
        "experience":      profile_data.get("experience", []),
        "education":       profile_data.get("education", []),
        "skills":          profile_data.get("skills", []),
        "certifications":  profile_data.get("certifications", []),
        "languages":       profile_data.get("languages", []),
        "volunteer":       profile_data.get("volunteer", []),
        "projects":        profile_data.get("projects", []),
        "profilePhotoUrl": profile_data.get("profilePhotoUrl", ""),
        "scrapedAt":       profile_data.get("scrapedAt", ""),
        "url_slug":        profile_data.get("url_slug", ""),
        "profileUrl":      profile_data.get("_url", ""),
        "savedAt":         _now(),
        "_source":         profile_data.get("_source", "scrape"),
        "_isOwn":          profile_data.get("_isOwn", True),
    }
    doc["last_seen"] = _now()
    await container.replace_item(item=user_doc_id, body=doc)
    return doc["linkedin_profile"]


async def get_user_linkedin_profile(user_doc_id: str) -> Optional[dict]:
    """
    Retrieve the saved LinkedIn profile from the user document.
    Returns None if no profile has been saved yet.
    """
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
        return doc.get("linkedin_profile")
    except Exception:
        return None

# ─────────────────────────────────────────────────────────
#  NOTIFICATION PREFERENCES
# ─────────────────────────────────────────────────────────

async def save_notification_prefs(user_doc_id: str, prefs: dict) -> None:
    """
    Persist the user's email notification preferences inside their user document.
    prefs = {
        "email_enabled": bool,
        "events":        list[str],   # e.g. ["weekly_report", "gap_analysis"]
    }
    """
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
        doc["notification_prefs"] = {
            "email_enabled": prefs.get("email_enabled", True),
            "events":        prefs.get("events", ["weekly_report", "gap_analysis", "ai_score", "networking_analysis", "profile_extracted"]),
            "updated_at":    _now(),
        }
        await container.replace_item(item=user_doc_id, body=doc)
    except Exception:
        pass


async def get_notification_prefs(user_doc_id: str) -> dict:
    """
    Return the user's saved notification prefs, or sensible defaults if none saved yet.
    """
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
        prefs = doc.get("notification_prefs", {})
        return {
            "email_enabled": prefs.get("email_enabled", True),
            "events":        prefs.get("events", ["weekly_report", "gap_analysis", "ai_score", "networking_analysis", "profile_extracted"]),
        }
    except Exception:
        return {"email_enabled": True, "events": ["profile_extracted", "ai_score", "networking_analysis", "gap_analysis", "weekly_report"]}


async def get_users_with_email_notifications_enabled() -> list:
    """
    Return all user documents where notification_prefs.email_enabled == True.
    Used by the weekly batch email job.
    """
    container = await _get_container()
    try:
        query = """
            SELECT c.id, c.email, c.notification_prefs, c.linkedin_profile
            FROM c
            WHERE c.type = 'user'
              AND c.notification_prefs.email_enabled = true
              AND IS_DEFINED(c.email)
        """
        items = container.query_items(query=query, enable_cross_partition_query=True)
        return [item async for item in items]
    except Exception:
        return []


# ─────────────────────────────────────────────────────────
#  SUBUL LEARNING DATA
# ─────────────────────────────────────────────────────────

async def save_subul_data(user_doc_id: str, subul_data: dict) -> None:
    """
    Persist the Subul learning data inside the user document.
    subul_data = {
        "certifications": [...],
        "labs":           [...],
        "learning_paths": [...],
        "badges":         [...],
        "profile":        {...},   # role, tier, cohort
        "synced_at":      "...",
    }
    """
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
        doc["subul_data"] = {
            **subul_data,
            "synced_at": _now(),
        }
        await container.replace_item(item=user_doc_id, body=doc)
    except Exception as e:
        logging.warning(f"[save_subul_data] failed for {user_doc_id}: {e}")


async def get_subul_data(user_doc_id: str) -> dict:
    """Return the stored Subul learning data, or empty dict if none yet."""
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
        return doc.get("subul_data", {})
    except Exception:
        return {}


async def save_subul_token(user_doc_id: str, subul_token: str) -> None:
    """Persist the Subul JWT so the backend can call Subul APIs on behalf of the user."""
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
        doc["subul_access_token"] = subul_token
        doc["subul_token_saved_at"] = _now()
        await container.replace_item(item=user_doc_id, body=doc)
    except Exception as e:
        logging.warning(f"[save_subul_token] failed for {user_doc_id}: {e}")


async def get_subul_token(user_doc_id: str) -> str:
    """Retrieve the stored Subul JWT for a user, or empty string if not saved."""
    container = await _get_container()
    try:
        doc = await container.read_item(item=user_doc_id, partition_key=user_doc_id)
        return doc.get("subul_access_token", "")
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Generic TTL Cache
# ---------------------------------------------------------------------------

import json as _json


async def get_cache(key: str) -> Optional[dict]:
    """Read a cache entry. Returns the stored value or None if missing/expired."""
    container = await _get_container()
    doc_id = f"cache:{key}"
    try:
        doc = await container.read_item(item=doc_id, partition_key=doc_id)
        return doc.get("value")
    except Exception:
        return None


async def set_cache(key: str, value: dict, ttl_seconds: int = 3600) -> None:
    """Write a cache entry with Cosmos DB TTL auto-expiry."""
    container = await _get_container()
    doc_id = f"cache:{key}"
    doc = {
        "id": doc_id,
        "type": "cache",
        "value": value,
        "created_at": _now(),
        "ttl": ttl_seconds,
    }
    await container.upsert_item(body=doc)


# ---------------------------------------------------------------------------
# FAQ Knowledge Base
# ---------------------------------------------------------------------------

import time as _time

_faq_cache: list = []
_faq_cache_ts: float = 0.0
_FAQ_CACHE_TTL = 600  # 10 minutes

_DEFAULT_FAQS = [
    {
        "id": "faq:gap-analysis",
        "type": "faq",
        "keywords": ["gap", "gap analysis", "compare", "vs profile", "job description", "gap tab"],
        "question": "How does gap analysis work?",
        "answer": "Go to any LinkedIn profile OR paste a job description in the Gap tab. Click 'Analyze' — the AI compares your profile against theirs or the JD and returns a gap score (0-100), section breakdown, 5 quick wins, and a 90-day roadmap.",
    },
    {
        "id": "faq:post-generator",
        "type": "faq",
        "keywords": ["post", "generate post", "write post", "linkedin post", "post generator", "post tab"],
        "question": "How does the post generator work?",
        "answer": "Open the Post tab, enter a topic or idea, pick a tone and length, then click Generate. The AI writes a full LinkedIn post based on your profile context. Click Edit to adjust, then Copy to paste it into LinkedIn.",
    },
    {
        "id": "faq:ai-score",
        "type": "faq",
        "keywords": ["score", "ai score", "profile score", "profile strength", "grade my profile"],
        "question": "How do I get my AI profile score?",
        "answer": "Open the Profile tab and click 'AI Score'. The AI analyzes your scraped profile and returns a letter grade (A–F) with a 0-100 score, broken down by headline, about, experience, skills, education, and network.",
    },
    {
        "id": "faq:networking-scan",
        "type": "faq",
        "keywords": ["network scan", "scan", "networking", "connection candidates", "find connections", "people search"],
        "question": "How does network scan work?",
        "answer": "First set your networking goal in the Networking tab (job search, clients, investors, or learning). Then go to a LinkedIn People Search page with filters applied, open the Networking tab, and click Scan. The extension reads the visible profiles and scores each one as a connection candidate.",
    },
    {
        "id": "faq:scrape-profile",
        "type": "faq",
        "keywords": ["scrape", "extract profile", "scan profile", "read profile", "not finding", "my data", "update profile"],
        "question": "How do I get my profile data into the extension?",
        "answer": "Go to your own LinkedIn profile page (linkedin.com/in/your-username), then open the extension and click 'Scan My Profile'. The extension extracts your data from the page. This only works when you are on your own profile.",
    },
    {
        "id": "faq:subul-certificates",
        "type": "faq",
        "keywords": ["subul", "certificate", "certification", "learning", "sync subul", "achievement", "create post certificate"],
        "question": "How do I post about my Subul certificate?",
        "answer": "Open the Learning tab and click 'Sync Subul Data'. Your earned certificates will appear. Click 'Create Post' next to any certificate and the AI writes a celebration post ready to copy and paste into LinkedIn.",
    },
    {
        "id": "faq:chat",
        "type": "faq",
        "keywords": ["chat", "career advice", "ask", "assistant", "how do i", "career chat"],
        "question": "What can the AI chat do?",
        "answer": "The chat assistant can: rewrite your headline or about section, generate a LinkedIn post, answer career questions, suggest follow-up messages for networking, and give profile improvement advice. It uses your scraped profile for personalized answers.",
    },
    {
        "id": "faq:dark-mode",
        "type": "faq",
        "keywords": ["dark mode", "theme", "dark", "light mode", "change theme"],
        "question": "How do I enable dark mode?",
        "answer": "Open Settings (gear icon) and toggle the Dark Mode switch. The setting is saved and persists across sessions.",
    },
    {
        "id": "faq:notifications",
        "type": "faq",
        "keywords": ["notification", "email", "notify", "alert", "weekly report"],
        "question": "How do I set up notifications?",
        "answer": "Open Settings and enter your email address. Toggle the event types you want to receive (gap analysis complete, AI score ready, weekly report). Notifications are sent via email and as browser push notifications.",
    },
    {
        "id": "faq:connection-message",
        "type": "faq",
        "keywords": ["message", "outreach message", "connect message", "write message", "connection request"],
        "question": "How do I generate a connection message?",
        "answer": "After running a network scan in the Networking tab, click on any candidate's card and click 'Generate Message'. The AI writes a personalized outreach message based on their profile and your networking goal.",
    },
    {
        "id": "faq:profile-edit",
        "type": "faq",
        "keywords": ["edit profile", "manual edit", "change my data", "wrong data", "update data", "profile editor"],
        "question": "How do I manually edit my profile data?",
        "answer": "Open Settings and scroll down to find the Profile Editor, or navigate to the Edit Profile page. You can manually correct or add experience, education, skills, and other fields. Click Save to persist the changes.",
    },
    {
        "id": "faq:server-connection",
        "type": "faq",
        "keywords": ["not working", "server", "connection error", "backend", "offline", "api error", "cannot connect"],
        "question": "The extension says it cannot connect to the server",
        "answer": "The extension tries to connect to a local server on ports 8010, 8000, and 8013–8016. If no local server is running, it automatically falls back to the cloud backend. If features still fail, the cloud backend may be down — try again in a few minutes.",
    },
]


async def get_faqs() -> list:
    """Return all FAQ entries. Uses in-memory cache (10-min TTL) to avoid repeated DB reads."""
    global _faq_cache, _faq_cache_ts
    now = _time.time()
    if _faq_cache and (now - _faq_cache_ts) < _FAQ_CACHE_TTL:
        return _faq_cache

    if not cosmos_configured():
        _faq_cache = _DEFAULT_FAQS
        _faq_cache_ts = now
        return _faq_cache

    try:
        container = await _get_container()
        db_faqs = []
        async for item in container.query_items(
            "SELECT c.id, c.keywords, c.question, c.answer FROM c WHERE c.type = 'faq'",
            enable_cross_partition_query=True,
        ):
            db_faqs.append(item)
        # Merge: DB entries override defaults by id, defaults fill gaps
        db_ids = {f["id"] for f in db_faqs}
        merged = db_faqs + [f for f in _DEFAULT_FAQS if f["id"] not in db_ids]
        _faq_cache = merged
        _faq_cache_ts = now
        return merged
    except Exception:
        _faq_cache = _DEFAULT_FAQS
        _faq_cache_ts = now
        return _DEFAULT_FAQS


async def upsert_faq(faq_id: str, keywords: list, question: str, answer: str) -> None:
    """Create or update a FAQ entry in Cosmos DB."""
    container = await _get_container()
    doc = {
        "id": faq_id,
        "type": "faq",
        "keywords": keywords,
        "question": question,
        "answer": answer,
        "updated_at": _now(),
    }
    await container.upsert_item(body=doc)
    # Invalidate cache so next request re-fetches
    global _faq_cache_ts
    _faq_cache_ts = 0.0


async def delete_faq(faq_id: str) -> None:
    """Delete a FAQ entry from Cosmos DB."""
    container = await _get_container()
    await container.delete_item(item=faq_id, partition_key=faq_id)
    global _faq_cache_ts
    _faq_cache_ts = 0.0