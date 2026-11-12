"""Validate model output before replacing the local storyboard."""

from typing import Annotated
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StringConstraints, ValidationError

from .media import MediaError

SceneText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=600,
                                              pattern=r"^[^\r\n]+$")]


class Scene(BaseModel):
    model_config = ConfigDict(extra="forbid")
    order: StrictInt
    duration: Annotated[int, Field(strict=True, ge=6, le=6)]
    visualPrompt: SceneText
    voiceover: SceneText


class Storyboard(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenes: Annotated[list[Scene], Field(min_length=5, max_length=5)]


def scene_record(index, start, duration, narration, description, prompt):
    return {"id": uuid4().hex, "index": index, "start": start, "duration": duration,
            "narration": narration, "description": description, "prompt": prompt}


def deepseek_scenes(text):
    try:
        scenes = Storyboard.model_validate_json(text).scenes
    except ValidationError:
        raise MediaError("Deploy returned an invalid five-scene storyboard.") from None
    if [scene.order for scene in scenes] != [1, 2, 3, 4, 5]:
        raise MediaError("Deploy returned scenes out of order.")
    return [scene_record(index, index * 6, scene.duration, scene.voiceover, scene.voiceover, scene.visualPrompt)
            for index, scene in enumerate(scenes)]
