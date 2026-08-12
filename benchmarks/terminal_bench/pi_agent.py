import json
import os
import shlex
from pathlib import Path, PurePosixPath
from typing import override

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class PiBaselineAgent(Pi):
    """Pi baseline with a stable user-local install and custom Anthropic endpoint."""

    _REMOTE_WATCHDOG = PurePosixPath("/tmp/pi-watchdog.sh")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._watchdog_path = Path(__file__).with_name("pi-watchdog.sh")

    @staticmethod
    @override
    def name() -> str:
        return "pi-baseline"

    @override
    def get_version_command(self) -> str | None:
        return '"$HOME/.pi-agent/bin/pi" --version'

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "if command -v curl >/dev/null 2>&1; then :; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "apt-get update && apt-get install -y curl ca-certificates; "
                "elif command -v apk >/dev/null 2>&1; then "
                "apk add --no-cache bash curl ca-certificates; "
                "else echo 'Unsupported package manager' >&2; exit 1; fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        version_spec = f"@{self._version}" if self._version else "@latest"
        await environment.upload_file(
            self._watchdog_path, self._REMOTE_WATCHDOG.as_posix()
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "if command -v node >/dev/null 2>&1; then :; "
                f"else {nvm_node_install_snippet()}; fi; "
                'mkdir -p "$HOME/.pi-agent"; '
                'npm install -g --prefix "$HOME/.pi-agent" '
                f"@mariozechner/pi-coding-agent{version_spec} && "
                '"$HOME/.pi-agent/bin/pi" --version'
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
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must use provider/model format")
        provider, model = self.model_name.split("/", 1)
        if provider != "anthropic":
            raise ValueError("Phase 1 Pi baseline currently requires anthropic provider")

        env = {}
        for key in (
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "PI_WATCHDOG_POLL_SEC",
            "PI_WATCHDOG_STAGNATION_SEC",
            "PI_WATCHDOG_MIN_TURNS",
        ):
            value = self._get_env(key) or os.environ.get(key)
            if value:
                env[key] = value
        if not env.get("ANTHROPIC_API_KEY"):
            raise ValueError("Pi baseline is missing ANTHROPIC_API_KEY")
        if not env.get("ANTHROPIC_BASE_URL"):
            raise ValueError("Pi baseline is missing ANTHROPIC_BASE_URL")

        models_config = json.dumps(
            {
                "providers": {
                    "anthropic": {
                        "baseUrl": env["ANTHROPIC_BASE_URL"],
                        "apiKey": "ANTHROPIC_API_KEY",
                        "api": "anthropic-messages",
                        "models": [
                            {
                                "id": model,
                                "name": model,
                                "reasoning": True,
                                "input": ["text"],
                                "contextWindow": 200000,
                                "maxTokens": 32768,
                                "cost": {
                                    "input": 0,
                                    "output": 0,
                                    "cacheRead": 0,
                                    "cacheWrite": 0,
                                },
                            }
                        ],
                    }
                }
            },
            separators=(",", ":"),
        )

        escaped_instruction = shlex.quote(self.render_instruction(instruction))
        thinking = str(self._resolved_flags.get("thinking", "high"))
        await self.exec_as_agent(
            environment,
            command=(
                'mkdir -p /logs/agent/pi/sessions "$HOME/.pi/agent"; '
                f"printf %s {shlex.quote(models_config)} "
                '>"$HOME/.pi/agent/models.json"; '
                f"{shlex.quote(self._REMOTE_WATCHDOG.as_posix())} "
                f"{escaped_instruction} anthropic {shlex.quote(model)} "
                f"{shlex.quote(thinking)}"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        metadata = dict(context.metadata or {})
        watchdog = self.logs_dir / "pi.watchdog.json"
        if watchdog.exists():
            try:
                metadata["pi_watchdog"] = json.loads(watchdog.read_text())
            except json.JSONDecodeError:
                metadata["pi_watchdog"] = None
        context.metadata = metadata
