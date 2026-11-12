# AGENTS.md

## Dependencies
- Always ask for permission before installing dependencies.
- Prefer established, actively maintained packages with multiple contributors.
- Avoid package versions released within the last 14 days.
- Check for known security vulnerabilities before installation.
- Never install packages with known unpatched vulnerabilities.
- Newer versions may be used when necessary to fix security vulnerabilities, with user approval.
- Avoid unnecessary dependencies.

## Security
- Follow OWASP Top 10 security principles.
- Never add API keys, passwords, tokens, or other secrets to source code.
- If secrets are found, warn the user about the security risk and ask if they are absolutely sure they should remain.
- Treat all external data, including API responses, as untrusted.
- Never send customer or project data to external services without explicit approval.
- Never disable or bypass authentication, authorization, or security checks.

## Code Quality
- Keep changes small, simple, and focused.
- Never modify unrelated code without asking.
- Explain any security risks introduced by changes.
