"""Generate Uzbek drafts through the OpenAI Responses API."""

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_MODEL = "gpt-5.4-mini"
FORMAT_INSTRUCTIONS = {
    "post": "Write a short social media post with a hook, a body and a call to action.",
    "video": "Write a 30-second video script with time ranges, narration and visual cues.",
}


class GenerationError(Exception):
    """The provider failed to return a usable draft."""


def generate_draft(brief, format_name, *, api_key, model):
    payload = {
        "model": model,
        "instructions": (
            "Write natural Uzbek in Latin script. Use the topic, audience and tone "
            "from the user's brief. Return only the draft in plain text. "
            "Do not invent facts, statistics or testimonials. "
            + FORMAT_INSTRUCTIONS[format_name]
        ),
        "input": brief,
        "max_output_tokens": 1000,
        "store": False,
    }
    request = Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=25) as response:
            result = json.load(response)
    except HTTPError as exc:
        with exc:
            raise GenerationError(f"OpenAI returned HTTP {exc.code}.") from None
    except (URLError, TimeoutError, ValueError):
        raise GenerationError("OpenAI request or response failed.") from None

    try:
        if result["status"] != "completed":
            raise GenerationError("OpenAI did not complete the response.")
        text = "\n".join(
            part["text"]
            for item in result["output"] if item["type"] == "message"
            for part in item["content"] if part["type"] == "output_text"
        ).strip()
    except (KeyError, TypeError):
        raise GenerationError("OpenAI returned an unexpected response.") from None

    if not text:
        raise GenerationError("OpenAI returned no draft text.")
    return text
