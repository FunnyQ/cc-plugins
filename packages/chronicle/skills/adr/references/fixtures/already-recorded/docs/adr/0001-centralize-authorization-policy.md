# ADR-0001: Centralize Authorization Policy

- Status: Accepted
- Date: 2026-01-01
- Supersedes: 
- Superseded by: 

## Context
Authorization checks had drifted across controllers, jobs, and command handlers, producing inconsistent answers and audit gaps.

## Considered alternatives
We considered keeping checks in each entry point and placing authorization callbacks in models. Both approaches distribute policy across modules and make complete review difficult.

## Decision
Centralize authorization rules in one policy layer used by every application entry point.

## Consequences
Controllers, jobs, and command handlers depend on the policy contract. Simple checks gain an indirection, while rule testing and security audits gain one authoritative location.

## Evidence
Session ID: session-001
Entry ID: dec-recorded-001
Date: 2026-01-15
