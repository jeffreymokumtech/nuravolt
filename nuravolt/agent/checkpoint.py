"""Durable thread state and long-term memory on Postgres.

Both live in their own schema (`agent` by default) so Prisma never sees
them: `prisma migrate` manages `public`, LangGraph manages `agent`. Setup is
idempotent and runs on every service start.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

log = logging.getLogger("nuravolt.agent.checkpoint")


def _with_search_path(database_url: str, schema: str) -> str:
    # Supabase transaction pooler cannot run the saver's pipelined setup; use
    # the direct URL there. Any pgbouncer query flag is dropped for psycopg3.
    url = database_url.replace("?pgbouncer=true", "").replace("&pgbouncer=true", "")
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}options=-c%20search_path%3D{schema}"


@asynccontextmanager
async def open_persistence(database_url: Optional[str], schema: str = "agent") -> AsyncIterator[tuple[object, object]]:
    """Yield (checkpointer, store). Without a DATABASE_URL both are in-memory,
    which is what the CLI uses for one-off runs and what tests use."""
    if not database_url:
        from langgraph.checkpoint.memory import MemorySaver
        from langgraph.store.memory import InMemoryStore

        yield MemorySaver(), InMemoryStore()
        return

    import psycopg
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from langgraph.store.postgres.aio import AsyncPostgresStore

    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as conn:
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
    url = _with_search_path(database_url, schema)
    async with AsyncPostgresSaver.from_conn_string(url) as saver, AsyncPostgresStore.from_conn_string(url) as store:
        await saver.setup()
        await store.setup()
        log.info("postgres checkpointer + store ready in schema %s", schema)
        yield saver, store
