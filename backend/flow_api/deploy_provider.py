"""Deploy's OpenAI-compatible DeepSeek Chat Completions adapter."""

import asyncio

import httpx

from .agents import AgentError, RetryableAgentError, agent_prompt

MODEL = "deepseek-ai/deepseek-v4.1-flash"
DEFAULT_BASE_URL = "https://api.deploy.com/api/v1"
BASE_URLS = frozenset(f"https://{host}.deploy.com/api/v1" for host in (
    "api", "api-sf1", "api-va1", "api-cdn", "api-sf1-cdn", "api-va1-cdn",
))
# Deploy's model documentation rates in nanodollars per token. Estimate cached input at full rate.
RATES = (120, 480)


def validate_base_url(value: str) -> str:
    base_url = value.removesuffix("/")
    if base_url not in BASE_URLS:
        raise ValueError("DEPLOY_BASE_URL must be a documented Deploy HTTPS API base URL.")
    return base_url


def validate_model(value: str) -> str:
    if value != MODEL:
        raise ValueError(f"DEPLOY_MODEL must be {MODEL}, the supported model with configured rates.")
    return value


class DeployProvider:
    mode = "deploy"

    def __init__(self, client: httpx.AsyncClient, model: str = MODEL, timeout: float = 25, retries: int = 1):
        self.client = client
        self.model = validate_model(model)
        self.timeout = timeout
        self.retries = retries

    async def generate(self, step, task, previous, budget, on_retry):
        instructions, prompt, output_limit = agent_prompt(step, task, previous)
        return await self.complete(step.agent_id, f"{instructions}\n\n{prompt}", output_limit, budget, on_retry)

    async def complete(self, agent_id, prompt, output_limit, budget, on_retry):
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_completion_tokens": output_limit,
            "reasoning_effort": "none",
        }
        input_bound = len(prompt.encode("utf-8")) + 1024
        for attempt in range(self.retries + 1):
            reservation = budget.reserve(agent_id, input_bound, output_limit, RATES)
            try:
                return await self.attempt(agent_id, payload, budget, reservation)
            except RetryableAgentError as error:
                if attempt == self.retries:
                    raise
                on_retry(str(error))
                await asyncio.sleep(0.5 * (attempt + 1))

    async def attempt(self, agent_id, payload, budget, reservation):
        try:
            async with asyncio.timeout(self.timeout):
                response = await self.client.post("chat/completions", json=payload)
        except (TimeoutError, httpx.TimeoutException):
            raise RetryableAgentError("Deploy request timed out.") from None
        except httpx.TransportError:
            raise RetryableAgentError("Could not reach Deploy.") from None

        if response.status_code == 429 or response.status_code >= 500:
            raise RetryableAgentError(f"Deploy temporarily rejected the request (HTTP {response.status_code}).")
        if not response.is_success:
            raise AgentError(f"Deploy rejected the request (HTTP {response.status_code}).")

        try:
            result = response.json()
            usage = result["usage"]
            input_tokens, output_tokens = usage["prompt_tokens"], usage["completion_tokens"]
            if not all(type(count) is int and count >= 0 for count in (input_tokens, output_tokens)):
                raise ValueError
            budget.settle(agent_id, reservation, input_tokens, output_tokens, RATES)
            if output_tokens > payload["max_completion_tokens"]:
                raise AgentError("Deploy exceeded the output token limit.")
            choice = result["choices"][0]
            if choice["finish_reason"] != "stop":
                raise AgentError("Deploy did not complete the response.")
            text = choice["message"]["content"]
            if not isinstance(text, str) or not text.strip():
                raise AgentError("Deploy returned no usable text.")
            return text.strip()
        except (ValueError, KeyError, TypeError, IndexError):
            raise AgentError("Deploy returned an invalid response.") from None
