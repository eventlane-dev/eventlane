# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through
[GitHub private vulnerability reporting](https://github.com/eventlane-dev/eventlane/security/advisories/new)
(the "Report a vulnerability" button on the Security tab).

Include the affected package and version, what you did and what you saw. You will get an answer as soon as possible,
and a fix is released as a new patch version of the affected packages.

## Supported versions

Only the latest released version of each `@eventlane/*` package gets security fixes.

## Scope notes

The dashboard (`@eventlane/board-*`) can read event payloads and, in `'full'` mode, change data. Run it behind your
own authentication and read [Options and security](https://eventlane-dev.github.io/eventlane/dashboard/options).
