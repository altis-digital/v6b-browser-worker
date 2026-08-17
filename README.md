# V6B Browser Worker — GitHub R1.1

Source minimal du browser-worker Playwright pour le pilote V6B.

- Playwright package: `1.62.1`
- Docker image: `mcr.microsoft.com/playwright:v1.62.1-noble`
- Chromium uniquement à l'exécution V6B
- aucun secret dans ce dépôt
- ne pas déployer avant ajout de la configuration Compose/seccomp spécifique au VPS

`BROWSER_WORKER_TOKEN` doit rester dans l'environnement Hostinger/n8n, jamais dans GitHub.
