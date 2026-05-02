---
name: API v2 migration plan
description: Migration from REST v1 to GraphQL v2 scheduled for Q3
type: project
---

The backend team is migrating from REST v1 to GraphQL v2.

**Why:** v1 endpoints have become unmaintainable with 200+ custom endpoints.
**How to apply:** All new features should target the `/graphql` endpoint. Legacy REST endpoints are in maintenance mode only.
