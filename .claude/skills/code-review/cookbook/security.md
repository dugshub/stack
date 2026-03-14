# Security Review Checklist

## Input Validation
- [ ] All user input sanitized before use
- [ ] SQL queries use parameterized statements
- [ ] File paths validated against traversal attacks
- [ ] JSON/XML parsing handles malformed input

## Authentication & Authorization
- [ ] Auth checks on all protected routes
- [ ] Session tokens properly invalidated on logout
- [ ] Password requirements enforced
- [ ] Rate limiting on auth endpoints

## Data Protection
- [ ] Sensitive data encrypted at rest
- [ ] PII not logged or exposed in errors
- [ ] Credentials not hardcoded
- [ ] Environment variables for secrets

## API Security
- [ ] CORS properly configured
- [ ] CSRF protection enabled
- [ ] Rate limiting implemented
- [ ] Input size limits enforced

## Common Vulnerabilities (OWASP Top 10)
- [ ] No SQL injection vectors
- [ ] No XSS vulnerabilities
- [ ] No insecure deserialization
- [ ] No exposed sensitive data in responses
- [ ] No broken access control
