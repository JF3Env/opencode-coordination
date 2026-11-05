# opencode-coordination

Roles, work items, messages, progress and history for teams of [OpenCode](https://opencode.ai) and Claude Code agents, on **one append-only ledger**.

A team of agents usually coordinates through prose: role files that the model has to remember, status tables that someone has to type, and messages that nobody can prove were sent. This plugin turns that into data.

- An agent says "I am ready" by calling a tool. The plugin records the event, checks the pull request, tells the right peer, counts the deadline and updates the board.
- **The plugin keeps the history, not the agents.** Every event is written by the plugin with the actor taken from the authenticated session. Nothing is edited, nothing is pruned, and the project's status pages are generated from the ledger.
- A message that cannot be traced to a stored record is not an instruction. `coordination_record <id>` proves where an instruction came from, and an invented one is reported as an incident.

It started as the glue of a team of three roles (product manager, coordinator, engineers) and is configurable per project.

## What it gives you

| | |
|---|---|
| **Communication** | Typed messages with record ids, deadlines the plugin follows (re-sent after one block, escalated after two), delivery into the other session, a bridge to Claude Code sessions. |
| **Work control** | Items with a life cycle (proposed → accepted → ready → assigned → in progress → in review → merged → measured → validated), assignment checks (file overlap, one open item per engineer, holds and freezes), fresh-session assignment, handover and reassignment. |
| **Progress control** | The board (now / next / later per front), measures with their records, bets with prediction and result, stalls detected by the clock, a generated state digest and owner bundle. |
| **History** | One SQLite ledger per repository: append-only (the database refuses UPDATE and DELETE), reproducible (`rebuild` replays every projection from the events), queryable (`history`, `record`, `export`). |
| **Less documentation** | `ACTIVE`, board, roadmap, status and a JSON snapshot are rendered from the ledger; `coordination render --check` fails on a stale or hand-edited page. |

The diagrams in [`docs/uml`](docs/uml/README.md) show every interaction: use cases per actor, components, classes, the item and message life cycles, eleven sequences and five activity flows.

## Install

OpenCode (local checkout):

```sh
git clone https://github.com/JF3Env/opencode-coordination
cd opencode-coordination && npm install
./scripts/install-local.sh        # points ~/.config/opencode/plugins/coordination at this checkout
```

The script refuses while the earlier `agent-mail` plugin is installed: both bind the Claude Code peer `opencode`. Import its history first or afterwards:

```sh
node src/cli/main.ts import-agent-mail        # idempotent; ~/.local/share/opencode/agent-mail by default
```

Add a project profile at `<project>/.opencode/coordination.json` (see [`profiles/iceye-sars-sim.json`](profiles/iceye-sars-sim.json)); without one the plugin runs with three roles, a 60-minute block and no GitHub link.

## Using it

Each session with the agent id `coordinator`, `product-manager` or `engineer` (names are configurable) gets a stable human name, a managed session title and a short role prompt that always shows the item it holds. The tools are `coordination_*`; the full table is generated in [`docs/TOOLS.md`](docs/TOOLS.md).

```
PM          coordination_propose   → a bet: outcome line, prediction, rule that decides it
Coordinator coordination_accept / refine / assign   → checks overlap, holds, one open item each
Engineer    coordination_claim → progress → ready   → the plugin checks the PR is ready and contains main
Coordinator coordination_verdict → merged           → "main moved" goes to everyone
Engineer    coordination_result                     → measure, prediction, met | missed
PM          coordination_validate                   → against an independent reference
```

From a Claude Code session or a script, use the CLI (identity is declared and can never be an OpenCode session's):

```sh
coordination call propose '{"title":"…","moves":"G1.1 reach","predicted":"up","why":"…"}' --as boss --role product-manager
coordination inbox --as boss
coordination board
coordination render --check        # exit 1 when a generated page is stale
```

### Wake an idle product manager

Run `/enable-go-horse` in an OpenCode session to enable GO HORSE for that project.
The mode stays enabled across plugin reloads and ledger rebuilds.
Run `/disable-go-horse` to stop it and close pending wake-up deadlines without deleting their history.

The existing minute clock checks for an OpenCode product manager (PM) session with 15 minutes of idle time.
It sends one tracked question and resumes that session.
The PM must ask the coordinator through `coordination_ask`, with an `item` that names the work to execute.
The coordinator must answer that follow-up before the PM can close the automatic question.
The ledger must also show an action on that same item after the wake-up:

- A coordinator assignment or unblock, followed by an engineer claim, review request or result.
- Or a coordinator review or merge on the item.

The item must remain in an execution, review or completed state when the PM closes the cycle.
Status messages and progress lines do not satisfy this check.
Proposals, assignments without an engineer start, and blocker reports do not satisfy it either.
Work on another item or before the wake-up does not count.
These checks prove recorded workflow activity, not functional correctness or the quality of an agent's work.

The ten questions rotate in this order:

1. Qual fluxo funcional será exercitado agora? Acione o coordenador para iniciar a execução e registrar a evidência.
2. Qual funcionalidade prioritária ainda não funciona? Faça o coordenador atribuir o próximo passo e obter o início do trabalho.
3. Qual falha impede o fluxo principal? Mobilize um engenheiro para reproduzi-la e iniciar a correção autorizada.
4. Qual avanço funcional pode ser produzido agora? Faça a equipe executar o próximo passo e registrar o resultado.
5. Qual entrega precisa de teste funcional ou integração? Faça o coordenador atribuir a execução e cobrar seu início.
6. Qual bloqueio será tratado agora? Acione o responsável e inicie trabalho independente autorizado; não encerre com apenas uma justificativa.
7. Qual entrega pode sair da fila de revisão agora? Faça o coordenador realizar a revisão ou concluir a integração autorizada.
8. Qual engenheiro está sem trabalho útil? Faça o coordenador atribuir uma tarefa executável e obter a confirmação de início.
9. Como iniciar a próxima entrega em paralelo agora? Faça o coordenador dividir o escopo e acionar os engenheiros disponíveis.
10. Qual resultado funcional verificável será produzido a seguir? Mobilize o responsável agora e registre o início da execução.

A pending question prevents another independent question, but it does not stop the timer.
After another 15 idle minutes, the plugin wakes the PM again and sends an action notice to the coordinator.
The notice refers to the same open cycle. Retries share the ledger clock and do not accumulate each minute.
Failed delivery retries the pending record on the next clock tick.
Busy sessions receive no wake-up. New activity resets the idle window.
The clock can send a question up to one minute after the idle threshold.
The mode creates no agents and changes no models or permissions.
It does not bypass holds, parked fronts, file overlap checks or owner approvals.
Without useful authorized work, the PM must define a useful next item or seek the required approval.
A blocker report does not close the cycle; the timer continues until an action satisfies the check or the owner disables the mode.
The mode never authorizes invented work or removal of a safety hold just to satisfy its activity check.
The OpenCode server must stay active; this timer cannot restart a stopped process or wake a CLI identity.

## Profile

`.opencode/coordination.json` (all fields optional): role aliases, `cli` (the names a CLI or Claude Code identity may declare per role), `blockMinutes`, `fronts`, `github.repo` / `baseBranch` (default `main`) / `syncMinutes` / `agentLine`, extra prompt `rules`, `render` paths (and `auto`), `limits`, `freezeExempt`. Unknown keys are an error.

## Status and limits

Version 0.1.0. 48 tools, 61 tests (one reads a local agent-mail store and is skipped unless `AGENT_MAIL_STORE` is set). Read this before relying on it:

- **Not yet run inside a live OpenCode.** The host adapter is tested against a fake host built from the published `@opencode/plugin` types, and the ledger is tested on Node's `node:sqlite` and on Bun's `bun:sqlite`. The first live run is yours; please open an issue with what you see.
- **Role filtering happens when a tool runs,** from the session's agent id, and the prompt lists only your role's tools. Tools are not hidden from other roles' tool lists.
- **The role is bound to the agent you pick in OpenCode.** It comes from the session's agent id on the first turn and stays: switching the agent inside the session does not change it (the attempt is recorded), and a subagent never holds a role, whatever agent it runs. So the model each role uses is the one you configured for that agent.
- **CLI identity is declared, not proven.** A name holds only the role the profile's `cli` block grants it, is refused for any name that belongs to an OpenCode session, and cannot change role later. This is a guard against mistakes, not a security boundary: see [Who can hold a role](#who-can-hold-a-role).
- **No archive of a very large ledger yet.** Nothing is ever pruned; archiving a closed database file is planned.
- **GitHub is polled** through the `gh` CLI every `syncMinutes`; a failure is recorded and changes nothing.
- Generated pages are written only by `coordination render` unless `render.auto` is set, so your working tree is not touched behind your back.
- Do not run it next to `agent-mail`.

## Who can hold a role

The hard guarantee covers OpenCode sessions only. There the role comes from the agent id the host authenticates, is bound to the session on its first turn, and the model is the one you configured for that agent. Nothing a model writes can change it.

A CLI or Claude Code identity is different. `coordination call --as <name>` holds the role the profile's `cli` block grants that name, but the name is typed, not proven. Any session with a shell under the same user account can run the CLI with any listed name, and that includes an OpenCode engineer with the bash tool. A token file would not help: every session reads the same files.

So, if the coordinator or the product manager works from Claude Code through the CLI, close the gap on the OpenCode side by denying the CLI to the agents that must not hold those roles. In `opencode.json` (or `.opencode/opencode.json` in the project):

```json
{
  "agent": {
    "engineer": {
      "permission": {
        "bash": {
          "coordination *": "deny",
          "*cli/main.ts*": "deny",
          "*cli/main.js*": "deny",
          "*": "allow"
        }
      }
    }
  }
}
```

The same rules go in the front matter of an agent file (`.opencode/agent/engineer.md`) under `permission: bash:`. The three patterns cover the installed `coordination` binary and the CLI run from a checkout with `node` or `bun`. The engineer keeps every `coordination_*` tool, which the plugin role-checks; only the shell path around them is closed.

The other way round is simpler: run the coordinator inside OpenCode as its own agent, pointed at the model you want. It then has a host-authenticated identity and needs no CLI at all.

## Develop

```sh
npm install
npm test                 # node:test, TypeScript run directly by Node ≥ 24
npm run typecheck
npm run build            # dist/ for the CLI under plain node
bun scripts/bun-smoke.ts # the ledger on bun:sqlite
node scripts/gen-docs.ts # regenerate docs/TOOLS.md (a test fails when it is stale)
```

See [`docs/DESIGN.md`](docs/DESIGN.md) for the design and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
