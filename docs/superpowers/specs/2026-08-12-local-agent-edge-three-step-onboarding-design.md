# Local Agent Edge Three-Step Onboarding Design

## Goal and user experience

Provide a copy-paste onboarding layer over the existing Generic CLI Driver and
Local Agent Edge so a non-technical user can connect their local AI command
without understanding CLI parameters or writing code.

## Chosen approach

1. The user runs `npm run edge:setup`.
2. The setup command generates a prompt. The user copies it to their own AI,
   then pastes the AI's one complete configuration command back into setup.
3. The user runs `npm run edge:start`.

Setup validates and saves the configuration; start launches the configured local
agent edge.

## Configuration scope and safety

Configuration is limited to:

- command
- arguments
- working directory
- necessary non-secret environment variables
- optional port

No passwords, tokens, or other secrets are stored.

Errors are limited to missing configuration, unavailable CLI command, and launch
failure. Each error includes the original reason. Startup output must explain
what happened and the next action in language understandable to non-developers.

## Implementation boundaries

Implement only a thin generic setup/launcher entrypoint, a local configuration
format, two npm scripts, tests, and README three-step instructions. Do not add a
UI, driver registry, auto-detection framework, Room/core changes, tunnel or
network layer, adapter framework, plugin system, session manager, or automatic
repair.

## Acceptance and stop condition

Onboarding is accepted when a non-technical user can complete it by copy/paste
without understanding CLI parameters or writing code. Stop once the three-step
flow passes internal tests and one external blind test.
