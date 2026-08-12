import json
import shlex
from pathlib import Path, PurePosixPath
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class KrossAgent(BaseInstalledAgent):
    """Run the packaged Kross headless CLI inside a Harbor task container."""

    _REMOTE_PACKAGE = PurePosixPath("/tmp/kross-agent.tgz")
    _REMOTE_RUNTIME = PurePosixPath("/tmp/kross-linux-runtime.tgz")
    _REMOTE_WATCHDOG = PurePosixPath("/tmp/kross-watchdog.sh")
    _OUTPUT_FILENAME = "kross.ndjson"

    def __init__(
        self,
        *args,
        runtime_path: str | None = None,
        package_path: str | None = None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._runtime_path = (
            Path(runtime_path).expanduser().resolve() if runtime_path else None
        )
        self._package_path = (
            Path(package_path).expanduser().resolve() if package_path else None
        )
        self._watchdog_path = Path(__file__).with_name("kross-watchdog.sh")
        if self._runtime_path and not self._runtime_path.is_file():
            raise ValueError(f"Kross runtime does not exist: {self._runtime_path}")
        if self._package_path and not self._package_path.is_file():
            raise ValueError(f"Kross package does not exist: {self._package_path}")
        if not self._runtime_path and not self._package_path:
            raise ValueError("runtime_path or package_path is required")

    @staticmethod
    @override
    def name() -> str:
        return "kross"

    @override
    def get_version_command(self) -> str | None:
        return (
            "[ ! -s ~/.nvm/nvm.sh ] || . ~/.nvm/nvm.sh; "
            'export PATH="$HOME/.kross-agent/bin:$PATH"; '
            '"$HOME/.kross-agent/bin/kross" --version'
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if self._runtime_path:
            await environment.upload_file(
                self._runtime_path, self._REMOTE_RUNTIME.as_posix()
            )
            await environment.upload_file(
                self._watchdog_path, self._REMOTE_WATCHDOG.as_posix()
            )
            await self.exec_as_agent(
                environment,
                command=(
                    'set -euo pipefail; mkdir -p "$HOME/.kross-agent"; '
                    'tar -xzf /tmp/kross-linux-runtime.tgz '
                    '-C "$HOME/.kross-agent"; '
                    'chmod 0755 "$HOME/.kross-agent/bin/node" '
                    '"$HOME/.kross-agent/bin/kross"; '
                    'PATH="$HOME/.kross-agent/bin:$PATH" '
                    '"$HOME/.kross-agent/bin/kross" --version'
                ),
            )
            await self.exec_as_root(
                environment,
                command=f"chmod 0755 {self._REMOTE_WATCHDOG.as_posix()}",
            )
            return

        await self.exec_as_root(
            environment,
            command=(
                "if command -v curl >/dev/null 2>&1 && "
                "command -v git >/dev/null 2>&1 && "
                "command -v rg >/dev/null 2>&1; then :; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "apt-get update && apt-get install -y curl git ripgrep ca-certificates; "
                "elif command -v apk >/dev/null 2>&1; then "
                "apk add --no-cache bash curl git ripgrep ca-certificates; "
                "elif command -v yum >/dev/null 2>&1; then "
                "yum install -y curl git ripgrep ca-certificates; "
                "else echo 'Unsupported package manager' >&2; exit 1; fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await environment.upload_file(
            self._package_path, self._REMOTE_PACKAGE.as_posix()  # type: ignore[arg-type]
        )
        await environment.upload_file(
            self._watchdog_path, self._REMOTE_WATCHDOG.as_posix()
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "if command -v node >/dev/null 2>&1 && "
                "node -e \"const [a,b]=process.versions.node.split('.').map(Number);"
                "process.exit(a>22||(a===22&&b>=19)?0:1)\"; then :; "
                f"else {nvm_node_install_snippet()}; fi; "
                "mkdir -p \"$HOME/.kross-agent\"; "
                "npm install -g --prefix \"$HOME/.kross-agent\" "
                f"{shlex.quote(self._REMOTE_PACKAGE.as_posix())} && "
                '"$HOME/.kross-agent/bin/kross" --version'
            ),
        )
        await self.exec_as_root(
            environment,
            command=f"chmod 0755 {self._REMOTE_WATCHDOG.as_posix()}",
        )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        required = [
            "AGENT_LLM_PROVIDER",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_API_KEY",
        ]
        missing = [name for name in required if not self._has_env(name)]
        if missing:
            raise ValueError(
                "Kross benchmark environment is missing: " + ", ".join(missing)
            )
        optional = [
            "AGENT_THINKING_EFFORT",
            "KROSS_WATCHDOG_POLL_SEC",
            "KROSS_WATCHDOG_STAGNATION_SEC",
            "KROSS_WATCHDOG_MIN_TURNS",
        ]
        agent_env = {
            name: value
            for name in [*required, *optional]
            if (value := self._get_env(name)) is not None
        }

        exit_code = PurePosixPath("/logs/agent/kross.exit-code")
        escaped_instruction = shlex.quote(self.render_instruction(instruction))
        command = (
            f"{shlex.quote(self._REMOTE_WATCHDOG.as_posix())} "
            f"{escaped_instruction}"
        )
        result = await environment.exec(command=command, env=agent_env)
        if result.return_code != 0:
            raise RuntimeError(
                f"Kross benchmark wrapper failed with exit {result.return_code}"
            )
        metadata = {"kross_wrapper_completed": True}
        exit_result = await environment.exec(
            command=f"cat {shlex.quote(exit_code.as_posix())}"
        )
        try:
            metadata["kross_exit_code"] = int((exit_result.stdout or "").strip())
        except ValueError:
            metadata["kross_exit_code"] = None
        watchdog_result = await environment.exec(
            command="cat /logs/agent/kross.watchdog.json 2>/dev/null || true"
        )
        try:
            metadata["kross_watchdog"] = json.loads(watchdog_result.stdout or "{}")
        except json.JSONDecodeError:
            metadata["kross_watchdog"] = None

        metrics_script = r"""
const fs=require('node:fs'),path=require('node:path');
const root=path.join(process.env.HOME,'.kross','traces');
const out={inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,estimatedCostUsd:0,costAvailable:false};
function walk(p){if(!fs.existsSync(p))return;for(const n of fs.readdirSync(p)){const q=path.join(p,n),s=fs.statSync(q);if(s.isDirectory())walk(q);else if(n.endsWith('.jsonl'))for(const line of fs.readFileSync(q,'utf8').split('\n')){if(!line)continue;let e;try{e=JSON.parse(line)}catch{continue}const u=e?.payload?.metrics?.usage;if(!u)continue;for(const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'])if(Number.isFinite(u[k]))out[k]+=u[k];if(Number.isFinite(u.estimatedCostUsd)){out.estimatedCostUsd+=u.estimatedCostUsd;out.costAvailable=true}}}}
walk(root);process.stdout.write(JSON.stringify(out));
"""
        metrics_result = await environment.exec(
            command=(
                ". ~/.nvm/nvm.sh 2>/dev/null || true; node -e "
                + shlex.quote(metrics_script)
            )
        )
        try:
            usage = json.loads(metrics_result.stdout or "{}")
        except json.JSONDecodeError:
            usage = {}
        if isinstance(usage, dict):
            input_tokens = int(usage.get("inputTokens") or 0)
            cache_tokens = int(usage.get("cacheReadTokens") or 0)
            context.n_input_tokens = input_tokens + cache_tokens
            context.n_output_tokens = int(usage.get("outputTokens") or 0)
            context.n_cache_tokens = cache_tokens
            if usage.get("costAvailable"):
                context.cost_usd = float(usage.get("estimatedCostUsd") or 0)
            metadata["kross_usage"] = usage
        context.metadata = metadata

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        metadata = dict(context.metadata or {})
        exit_path = self.logs_dir / "kross.exit-code"
        if exit_path.exists():
            try:
                metadata["kross_exit_code"] = int(exit_path.read_text().strip())
            except ValueError:
                metadata["kross_exit_code"] = None

        completed = None
        output_path = self.logs_dir / self._OUTPUT_FILENAME
        if output_path.exists():
            for line in output_path.read_text(errors="replace").splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "run.completed":
                    completed = event.get("data")
        if isinstance(completed, dict):
            metadata["kross_status"] = completed.get("status")
            metadata["kross_verification_status"] = completed.get(
                "verificationStatus"
            )

        totals = {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "estimatedCostUsd": 0.0,
        }
        saw_cost = False
        for trace_path in (self.logs_dir / "traces").glob("**/*.jsonl"):
            for line in trace_path.read_text(errors="replace").splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                usage = ((event.get("payload") or {}).get("metrics") or {}).get(
                    "usage"
                )
                if not isinstance(usage, dict):
                    continue
                for key in (
                    "inputTokens",
                    "outputTokens",
                    "cacheReadTokens",
                    "cacheWriteTokens",
                ):
                    value = usage.get(key)
                    if isinstance(value, (int, float)):
                        totals[key] += int(value)
                cost = usage.get("estimatedCostUsd")
                if isinstance(cost, (int, float)):
                    totals["estimatedCostUsd"] += float(cost)
                    saw_cost = True

        context.n_input_tokens = totals["inputTokens"] + totals["cacheReadTokens"]
        context.n_output_tokens = totals["outputTokens"]
        context.n_cache_tokens = totals["cacheReadTokens"]
        context.cost_usd = totals["estimatedCostUsd"] if saw_cost else None
        metadata["kross_usage"] = totals
        metadata["kross_cost_available"] = saw_cost
        context.metadata = metadata
