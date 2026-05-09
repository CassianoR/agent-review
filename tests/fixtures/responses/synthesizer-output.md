# Code Review Report

This diff introduces two SQL injection vulnerabilities in the authentication layer and one hardcoded API key — all critical findings that must be resolved before merging. One medium-severity documentation gap was also identified.

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 2 |
| 🟠 High | 0 |
| 🟡 Medium | 1 |
| 🟢 Low | 0 |
| ℹ️ Info | 0 |
| **Total** | **3** |

## Agent Results

| Agent | Status | Findings | Error |
|-------|--------|----------|-------|
| security | ✅ success | 2 | — |
| style | ✅ success | 1 | — |

## Findings

### 🔴 Critical

#### [injection] `src/auth/login.ts:42`

User input is directly interpolated into the SQL query without parameterization, enabling SQL injection.

> **Suggestion:** Use parameterized queries: db.query('SELECT * FROM users WHERE email = $1', [email])

---

#### [secrets] `src/config/secrets.ts:7`

Hardcoded API key committed to source code, exposed to anyone with repository access.

> **Suggestion:** Remove the hardcoded key and load from environment variable: process.env.API_KEY

---

### 🟡 Medium

#### [type-safety] `src/utils/parse.ts:15`

Function parameter typed as `any`, losing type safety.

> **Suggestion:** Use `unknown` with a type guard instead of `any`.

---

<!-- TOKEN_USAGE_PLACEHOLDER -->

<!-- FINDINGS_JSON
[
  {
    "severity": "critical",
    "file": "src/auth/login.ts",
    "line": 42,
    "category": "injection",
    "description": "User input is directly interpolated into the SQL query without parameterization, enabling SQL injection.",
    "suggestion": "Use parameterized queries: db.query('SELECT * FROM users WHERE email = $1', [email])"
  },
  {
    "severity": "critical",
    "file": "src/config/secrets.ts",
    "line": 7,
    "category": "secrets",
    "description": "Hardcoded API key committed to source code.",
    "suggestion": "Remove the hardcoded key and load from environment variable: process.env.API_KEY"
  },
  {
    "severity": "medium",
    "file": "src/utils/parse.ts",
    "line": 15,
    "category": "type-safety",
    "description": "Function parameter typed as `any`, losing type safety.",
    "suggestion": "Use `unknown` with a type guard instead of `any`."
  }
]
-->
