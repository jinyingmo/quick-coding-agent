---
name: Testing preferences
description: Integration tests must hit real database, not mocks
type: feedback
---

Integration tests must hit a real database, not mocks.

**Why:** We got burned last quarter when mocked tests passed but the prod migration failed due to a subtle schema difference that mocks didn't catch.

**How to apply:** For any integration test touching the database layer, use `testcontainers` to spin up a real PostgreSQL instance. Unit tests for pure business logic can still use mocks.

**Update:** Based on recent conversation, run the integration test suite and check the migration on a staging copy before merging.